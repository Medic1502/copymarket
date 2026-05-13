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

module.exports = router;