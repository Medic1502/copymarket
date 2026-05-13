const router = require('express').Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { startCopyEngine, stopCopyEngine } = require('../../engine');

router.use(requireAuth);

router.post('/config',
  validate({
    targetWallet:   { required: true, type: 'wallet' },
    budget:         { required: true, min: 10, max: 100000 },
    maxPerTrade:    { required: true, min: 1,  max: 10000  },
    dailyLossLimit: { required: true, min: 1,  max: 100000 },
  }),
  async (req, res, next) => {
    try {
      const { targetWallet, budget, maxPerTrade, dailyLossLimit } = req.body;
      const config = await db.saveCopyConfig(req.userId, {
        targetWallet, budget, maxPerTrade, dailyLossLimit,
      });
      res.json({ config, message: 'Settings saved.' });
    } catch (err) { next(err); }
  }
);

router.post('/start', async (req, res, next) => {
  try {
    const configs = await db.getCopyConfig(req.userId);
    if (!configs.length) throw new Error('NO_CONFIG');
    const config = configs[configs.length - 1];
    const wallet = await db.getWalletByUserId(req.userId);

    await startCopyEngine({
      id:                  req.userId,
      budget:              parseFloat(config.budget),
      maxPerTrade:         parseFloat(config.max_per_trade),
      dailyLossLimit:      parseFloat(config.daily_loss_limit),
      encryptedPrivateKey: wallet.encrypted_private_key,
   walletAddress:       wallet.address,
    }, config.target_wallet);
    await db.setActive(config.id, true);
    res.json({ status: 'active', message: 'Copy trading started.' });
  } catch (err) { next(err); }
});

router.post('/stop', async (req, res, next) => {
  try {
    stopCopyEngine(req.userId);
    await db.setActive(req.body.id || req.userId, false, req.body.reason ?? null);
    res.json({ status: 'paused', message: 'Copy trading paused.' });
  } catch (err) { next(err); }
});

router.delete('/config/:id', async (req, res, next) => {
  try {
    stopCopyEngine(req.userId);
    await db.deleteCopyConfig(req.params.id, req.userId);
    res.json({ message: 'Trader removed.' });
  } catch (err) { next(err); }
});

router.get('/status', async (req, res, next) => {
  try {
    const configs = await db.getCopyConfig(req.userId);
    if (!configs.length) return res.json({ configured: false });
    res.json({
      configured: true,
      traders: configs.map(c => ({
        id:             c.id,
        isActive:       c.is_active,
        pausedReason:   c.paused_reason,
        targetWallet:   c.target_wallet,
        budget:         parseFloat(c.budget),
        maxPerTrade:    parseFloat(c.max_per_trade),
        dailyLossLimit: parseFloat(c.daily_loss_limit),
        updatedAt:      c.updated_at,
      })),
      isActive: configs.some(c => c.is_active),
    });
  } catch (err) { next(err); }
});

module.exports = router;