const router = require('express').Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });
    res.json({ address: wallet.address, createdAt: wallet.created_at });
  } catch (err) { next(err); }
});

router.get('/balance', async (req, res, next) => {
  try {
    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });
    const balance = await db.getUSDCBalance(wallet.address);
    res.json({ address: wallet.address, balance, currency: 'USDC' });
  } catch (err) { next(err); }
});

module.exports = router;