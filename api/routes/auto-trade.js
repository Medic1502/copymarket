const router = require('express').Router();
const db     = require('../../db');
const { requireAuth }         = require('../middleware/auth');
const { startAutoTrade, stopAutoTrade, isRunning } = require('../../engine/auto-trade');

router.use(requireAuth);

// GET /auto-trade/status
router.get('/status', async (req, res, next) => {
  try {
    const [config, stats, trades] = await Promise.all([
      db.getAutoTradeConfig(req.userId),
      db.getAutoTradeStats(req.userId),
      db.getAutoTradeRecentTrades(req.userId, 30),
    ]);
    res.json({
      running: isRunning(req.userId),
      config: config ? {
        amount:   parseFloat(config.amount),
        minPrice: parseFloat(config.min_price),
        duration: config.duration,
        assets:   config.assets,
      } : null,
      stats: stats ? {
        trades:      parseInt(stats.total)        || 0,
        wins:        parseInt(stats.wins)         || 0,
        losses:      parseInt(stats.losses)       || 0,
        totalPnl:    parseFloat(stats.total_pnl)  || 0,
        todayTrades: parseInt(stats.today_trades) || 0,
        pnl:         parseFloat(stats.today_pnl)  || 0,
        open:        parseInt(stats.open)         || 0,
      } : null,
      trades,
    });
  } catch (e) { next(e); }
});

// POST /auto-trade/config
router.post('/config', async (req, res, next) => {
  try {
    const { amount, minPrice, duration, assets } = req.body;
    if (!amount || amount < 1)          return res.status(400).json({ error: 'Amount must be >= $1' });
    if (!minPrice || minPrice < 0.9)    return res.status(400).json({ error: 'Min price must be >= 0.90' });
    if (!['5','15','both'].includes(duration)) return res.status(400).json({ error: 'Invalid duration' });
    if (!Array.isArray(assets) || !assets.length) return res.status(400).json({ error: 'Select at least one asset' });

    await db.saveAutoTradeConfig(req.userId, { amount, minPrice, duration, assets });

    // If session is running, update its config live
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /auto-trade/start
router.post('/start', async (req, res, next) => {
  try {
    if (isRunning(req.userId)) return res.json({ ok: true, running: true });
    await startAutoTrade(req.userId);
    res.json({ ok: true, running: true });
  } catch (e) { next(e); }
});

// POST /auto-trade/stop
router.post('/stop', async (req, res, next) => {
  try {
    await stopAutoTrade(req.userId);
    res.json({ ok: true, running: false });
  } catch (e) { next(e); }
});

module.exports = router;
