const router = require('express').Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');

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