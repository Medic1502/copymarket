const router = require('express').Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { startCopyEngine, stopCopyEngine } = require('../../engine');

// Simple in-memory cache for trader stats (expensive aggregate queries)
const statsCache = new Map(); // configId -> { data, expiresAt }
async function getCachedStats(configId) {
  const cached = statsCache.get(configId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const data = await db.getTraderStats(configId);
  statsCache.set(configId, { data, expiresAt: Date.now() + 60000 }); // 60s TTL
  return data;
}

router.use(requireAuth);

router.post('/config',
  validate({
    targetWallet: { required: true, type: 'wallet' },
  }),
  async (req, res, next) => {
    try {
      const { targetWallet, nickname, notes, copyMode, copyPercentage, fixedAmount, minTraderBet, maxTraderBet, categories, followMode, minSharePrice, maxSharePrice, maxPositionSize } = req.body;
      const config = await db.saveCopyConfig(req.userId, {
        targetWallet, nickname, notes, copyMode, copyPercentage, fixedAmount, minTraderBet, maxTraderBet, categories, followMode, minSharePrice, maxSharePrice, maxPositionSize
      });
      res.json({ config, message: 'Settings saved.' });
    } catch (err) { next(err); }
  }
);

router.post('/start', async (req, res, next) => {
  try {
    const { id: configId } = req.body;
    const configs = await db.getCopyConfig(req.userId);
    if (!configs.length) throw new Error('NO_CONFIG');
    const config = configId
      ? configs.find(c => c.id === configId)
      : configs[configs.length - 1];
    if (!config) return res.status(404).json({ error: 'Config not found.' });
    const wallet = await db.getWalletByUserId(req.userId);

    await startCopyEngine({
      id:                  req.userId,
      configId:            config.id,
      copyMode:            config.copy_mode || 'percentage',
      copyPercentage:      parseFloat(config.copy_percentage)||10,
      fixedAmount:         parseFloat(config.fixed_amount)||10,
      minTraderBet:        parseFloat(config.min_trader_bet)||5,
      maxTraderBet:        parseFloat(config.max_trader_bet)||100000,
      categories:          config.categories || [],
      followMode:          config.follow_mode || 'all',
      minSharePrice:       parseFloat(config.min_share_price)||0.02,
      maxSharePrice:       parseFloat(config.max_share_price)||0.98,
      maxPositionSize:     config.max_position_size != null ? parseFloat(config.max_position_size) : null,
      encryptedPrivateKey: wallet.encrypted_private_key,
      walletAddress:       wallet.address,
    }, config.target_wallet);
    await db.setConfigActive(config.id, req.userId, true);
    res.json({ status: 'active', message: 'Copy trading started.' });
  } catch (err) { next(err); }
});

router.post('/stop', async (req, res, next) => {
  try {
    const { id: configId } = req.body;
    if (!configId) return res.status(400).json({ error: 'configId required' });
    stopCopyEngine(configId);
    await db.setConfigActive(configId, req.userId, false, req.body.reason ?? null);
    res.json({ status: 'paused', message: 'Copy trading paused.' });
  } catch (err) { next(err); }
});

router.put('/config/:id', async (req, res, next) => {
  try {
    const { nickname, notes, copyMode, copyPercentage, fixedAmount, minTraderBet, maxTraderBet, categories, followMode, minSharePrice, maxSharePrice, maxPositionSize } = req.body;
    const config = await db.updateCopyConfig(req.params.id, req.userId, {
      nickname, notes, copyMode, copyPercentage, fixedAmount, minTraderBet, maxTraderBet, categories, followMode, minSharePrice, maxSharePrice, maxPositionSize
    });
    if (!config) return res.status(404).json({ error: 'Config not found.' });
    // restart engine with new settings if active
    const { startCopyEngine, stopCopyEngine } = require('../../engine');
    if (config.is_active) {
      stopCopyEngine(config.id);
      const wallet = await db.getWalletByUserId(req.userId);
      await startCopyEngine({
        id: req.userId, configId: config.id,
        copyMode: config.copy_mode || 'percentage',
        copyPercentage: parseFloat(config.copy_percentage)||10,
        fixedAmount: parseFloat(config.fixed_amount)||10,
        minTraderBet: parseFloat(config.min_trader_bet)||5,
        maxTraderBet: parseFloat(config.max_trader_bet)||100000,
        categories: config.categories || [],
        followMode: config.follow_mode || 'all',
        minSharePrice: parseFloat(config.min_share_price)||0.02,
        maxSharePrice: parseFloat(config.max_share_price)||0.98,
        maxPositionSize: config.max_position_size != null ? parseFloat(config.max_position_size) : null,
        encryptedPrivateKey: wallet.encrypted_private_key,
        walletAddress: wallet.address,
      }, config.target_wallet);
    }
    res.json({ config, message: 'Settings updated.' });
  } catch (err) { next(err); }
});

router.delete('/config/:id', async (req, res, next) => {
  try {
    stopCopyEngine(req.params.id); // stop by configId
    await db.deleteCopyConfig(req.params.id, req.userId);
    res.json({ message: 'Trader removed.' });
  } catch (err) { next(err); }
});

router.post('/config/:id/reset-stats', async (req, res, next) => {
  try {
    await db.resetTraderStats(req.userId, req.params.id);
    statsCache.delete(req.params.id);
    res.json({ message: 'Stats reset.' });
  } catch (err) { next(err); }
});

router.get('/status', async (req, res, next) => {
  try {
    const configs = await db.getCopyConfig(req.userId);
    if (!configs.length) return res.json({ configured: false });
    const traders = await Promise.all(configs.map(async c => {
      const stats = await getCachedStats(c.id);
      return {
        id:             c.id,
        isActive:       c.is_active,
        pausedReason:   c.paused_reason,
        targetWallet:   c.target_wallet,
        nickname:       c.nickname || null,
        notes:          c.notes || null,
        copyMode:       c.copy_mode || 'percentage',
        copyPercentage: parseFloat(c.copy_percentage)||10,
        fixedAmount:    parseFloat(c.fixed_amount)||10,
        minTraderBet:   parseFloat(c.min_trader_bet)||5,
        maxTraderBet:   parseFloat(c.max_trader_bet)||100000,
        categories:     c.categories || [],
        followMode:      c.follow_mode || 'all',
        minSharePrice:   parseFloat(c.min_share_price)||0.02,
        maxSharePrice:   parseFloat(c.max_share_price)||0.98,
        maxPositionSize: c.max_position_size != null ? parseFloat(c.max_position_size) : null,
        updatedAt:       c.updated_at,
        stats,
      };
    }));
    res.json({ configured: true, traders, isActive: configs.some(c => c.is_active) });
  } catch (err) { next(err); }
});

module.exports = router;