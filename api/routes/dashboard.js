const router = require('express').Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');
const { placeOrder } = require('../../engine');

router.use(requireAuth);

router.get('/stats', async (req, res, next) => {
  try {
    const [stats, wallet, config] = await Promise.all([
      db.getDashboardStats(req.userId),
      db.getWalletByUserId(req.userId),
      db.getCopyConfig(req.userId),
    ]);

    let balance = null;
    try {
      balance = await db.getUSDCBalance(wallet.address);
    } catch {}

    res.json({ ...stats, balance, isActive: config?.is_active ?? false });
  } catch (err) { next(err); }
});

router.get('/trades', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const trades = await db.getRecentTrades(req.userId, limit);
    res.json({ trades });
  } catch (err) { next(err); }
});

router.get('/positions', async (req, res, next) => {
  try {
    const positions = await db.getBotPositionsWithNames(req.userId);
    res.json({ positions });
  } catch (err) { next(err); }
});

router.get('/positions/prices', async (req, res, next) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const positions = await db.getBotPositions(req.userId);
    const open = positions.filter(p => p.token_id && parseFloat(p.shares) > 0);

    // Group by conditionId — one CLOB market fetch per unique market
    const byCondition = {};
    for (const p of open) {
      if (!byCondition[p.condition_id]) byCondition[p.condition_id] = [];
      byCondition[p.condition_id].push(p);
    }

    const prices = {};
    await Promise.all(Object.entries(byCondition).map(async ([conditionId, posList]) => {
      try {
        const r = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, { timeout: 5000 });
        const market = await r.json();
        const tokens = market.tokens || [];
        for (const pos of posList) {
          // Match by token_id first, then by outcome_index as fallback
          const token = tokens.find(t => t.token_id === pos.token_id)
            ?? (pos.outcome_index != null ? tokens[pos.outcome_index] : null);
          if (token?.price != null) {
            prices[pos.token_id] = parseFloat(token.price);
          }
        }
      } catch {}
    }));

    res.json({ prices });
  } catch (err) { next(err); }
});

router.post('/positions/:conditionId/:outcome/sell', async (req, res, next) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const { conditionId, outcome } = req.params;

    // Get position from DB
    const positions = await db.getBotPositions(req.userId);
    const pos = positions.find(p => p.condition_id === conditionId && p.outcome === outcome);
    if (!pos) return res.status(404).json({ error: 'Position not found.' });

    const shares = parseFloat(pos.shares);
    if (shares <= 0) return res.status(400).json({ error: 'No shares to sell.' });

    // Get wallet + decrypt private key
    const walletRow = await db.getWalletByUserId(req.userId);
    if (!walletRow) return res.status(400).json({ error: 'No wallet found.' });
    const privateKey = db.decryptPrivateKey(walletRow.encrypted_private_key);
    const wallet = { address: walletRow.address, privateKey };

    // Resolve token_id — use saved one or look up from CLOB market
    let tokenId = pos.token_id;
    if (!tokenId) {
      const r = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, { timeout: 8000 });
      const market = await r.json();
      const tokens = market.tokens || [];
      // Match by outcome_index if saved, otherwise try first token
      const t = pos.outcome_index != null ? tokens[pos.outcome_index] : tokens[0];
      tokenId = t?.token_id || null;
    }
    if (!tokenId) return res.status(400).json({ error: 'Cannot resolve token ID for this position.' });

    // Get current market price from CLOB
    const mr = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, { timeout: 8000 });
    const market = await mr.json();
    const token = (market.tokens || []).find(t => t.token_id === tokenId);
    const price = token ? parseFloat(token.price) : null;

    if (!price || price < 0.02) {
      return res.status(400).json({ error: `Market price too low to sell (${price ? Math.round(price*100) + '¢' : 'unavailable'}). Try on Polymarket.com.` });
    }

    // Place SELL order
    const result = await placeOrder(wallet, tokenId, 'SELL', price, shares);

    // Update DB
    const usdcReceived = parseFloat((shares * price).toFixed(4));
    const pnl = parseFloat((usdcReceived - parseFloat(pos.usdc_spent)).toFixed(4));
    const marketName = market.question || market.title || conditionId;
    const marketSlug = market.market_slug || null;

    await db.resolveBotPosition(req.userId, conditionId, outcome, 'WON', pnl).catch(() => {});
    await db.resolveTradeOutcome(req.userId, conditionId, 'WON', pnl).catch(() => {});
    await db.saveTrade(req.userId, {
      conditionId, marketName, marketSlug, outcome,
      side: 'REDEEM', size: usdcReceived, price,
      orderId: result.orderID || null, filledSize: shares,
      status: 'REDEEMED', skipReason: null, pnl,
      configId: null,
    }).catch(() => {});

    res.json({ ok: true, orderId: result.orderID, price, shares, usdcReceived, pnl });
  } catch (err) { next(err); }
});

router.post('/positions/:conditionId/:outcome/resolve', async (req, res, next) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const { conditionId, outcome } = req.params;

    const positions = await db.getBotPositions(req.userId);
    const pos = positions.find(p => p.condition_id === conditionId && p.outcome === outcome);
    if (!pos) return res.status(404).json({ error: 'Position not found.' });

    const shares   = parseFloat(pos.shares);
    const usdcSpent = parseFloat(pos.usdc_spent);
    if (shares <= 0) return res.status(400).json({ error: 'No shares.' });

    // Fetch CLOB market + Gamma in parallel
    const [clobRes, gammaRes] = await Promise.all([
      fetch(`https://clob.polymarket.com/markets/${conditionId}`, { timeout: 8000 }),
      fetch(`https://gamma-api.polymarket.com/markets?conditionIds=${conditionId}`, { timeout: 8000 }),
    ]);
    const clobMarket  = await clobRes.json();
    const gammaArr    = await gammaRes.json();
    const gammaMarket = Array.isArray(gammaArr) && gammaArr.length > 0 ? gammaArr[0] : null;

    const marketName = clobMarket.question || clobMarket.title || conditionId;
    const marketSlug = clobMarket.market_slug || null;
    const isClosed   = gammaMarket?.closed === true;

    // Resolve token_id
    let tokenId = pos.token_id;
    const clobTokens = clobMarket.tokens || [];
    if (!tokenId && pos.outcome_index != null) tokenId = clobTokens[pos.outcome_index]?.token_id || null;

    // Current CLOB price for this token
    const clobToken = tokenId ? clobTokens.find(t => t.token_id === tokenId) : null;
    const livePrice  = clobToken ? parseFloat(clobToken.price) : null;

    if (isClosed) {
      // Market fully resolved — determine WIN/LOSS from outcomePrices
      const outcomePrices = gammaMarket.outcomePrices
        ? (typeof gammaMarket.outcomePrices === 'string' ? JSON.parse(gammaMarket.outcomePrices) : gammaMarket.outcomePrices)
        : null;
      const clobTokenIds = gammaMarket.clobTokenIds
        ? (typeof gammaMarket.clobTokenIds === 'string' ? JSON.parse(gammaMarket.clobTokenIds) : gammaMarket.clobTokenIds)
        : [];

      let ourIdx = pos.outcome_index;
      if (ourIdx == null && pos.token_id) {
        const f = clobTokenIds.findIndex(tid => tid === pos.token_id);
        if (f >= 0) ourIdx = f;
      }

      let isWinner;
      if (ourIdx != null && outcomePrices) {
        isWinner = parseFloat(outcomePrices[ourIdx]) >= 0.99;
      } else {
        isWinner = livePrice != null && livePrice >= 0.99;
      }

      const pnl = isWinner ? parseFloat((shares - usdcSpent).toFixed(4)) : parseFloat((-usdcSpent).toFixed(4));
      await db.resolveBotPosition(req.userId, conditionId, outcome, isWinner ? 'WON' : 'LOST', pnl).catch(() => {});
      await db.resolveTradeOutcome(req.userId, conditionId, isWinner ? 'WON' : 'LOST', pnl).catch(() => {});
      await db.saveTrade(req.userId, {
        conditionId, marketName, marketSlug, outcome,
        side: 'REDEEM', size: isWinner ? shares : 0, price: isWinner ? 1.0 : 0,
        orderId: null, filledSize: isWinner ? shares : null,
        status: 'REDEEMED', skipReason: null, pnl, configId: null,
      }).catch(() => {});

      return res.json({ resolved: true, result: isWinner ? 'WON' : 'LOST', pnl });
    }

    // Market still open but price at extreme — place SELL to capture value
    if (!tokenId) return res.status(400).json({ error: 'Cannot resolve token ID.' });
    if (!livePrice || livePrice < 0.02) return res.status(400).json({ error: 'Price too low to sell on open market.' });

    const walletRow = await db.getWalletByUserId(req.userId);
    const privateKey = db.decryptPrivateKey(walletRow.encrypted_private_key);
    const result = await placeOrder({ address: walletRow.address, privateKey }, tokenId, 'SELL', livePrice, shares);
    const usdcReceived = parseFloat((shares * livePrice).toFixed(4));
    const pnl = parseFloat((usdcReceived - usdcSpent).toFixed(4));

    await db.resolveBotPosition(req.userId, conditionId, outcome, 'WON', pnl).catch(() => {});
    await db.resolveTradeOutcome(req.userId, conditionId, 'WON', pnl).catch(() => {});
    await db.saveTrade(req.userId, {
      conditionId, marketName, marketSlug, outcome,
      side: 'REDEEM', size: usdcReceived, price: livePrice,
      orderId: result.orderID || null, filledSize: shares,
      status: 'REDEEMED', skipReason: null, pnl, configId: null,
    }).catch(() => {});

    return res.json({ resolved: true, result: 'WON', pnl, orderId: result.orderID });
  } catch (err) { next(err); }
});

router.delete('/positions/:conditionId/:outcome', async (req, res, next) => {
  try {
    await db.deleteResolvedPosition(req.userId, req.params.conditionId, req.params.outcome);
    res.json({ message: 'Position deleted.' });
  } catch (err) { next(err); }
});

router.delete('/positions', async (req, res, next) => {
  try {
    await db.clearBotPositions(req.userId);
    res.json({ message: 'Positions cleared.' });
  } catch (err) { next(err); }
});

module.exports = router;