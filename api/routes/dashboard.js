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