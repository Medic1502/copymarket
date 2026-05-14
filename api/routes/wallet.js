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

router.post('/export-key', async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required.' });
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const valid = await db.verifyPassword(user, password);
    if (!valid) return res.status(401).json({ error: 'Incorrect password.' });
    const wallet = await db.getWalletByUserId(req.userId);
    const privateKey = db.decryptPrivateKey(wallet.encrypted_private_key);
    const mnemonic   = wallet.encrypted_mnemonic ? db.decryptPrivateKey(wallet.encrypted_mnemonic) : null;
    res.json({ privateKey, mnemonic, address: wallet.address });
  } catch (err) { next(err); }
});

module.exports = router;