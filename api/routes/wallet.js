const router = require('express').Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });
    // Compute deposit wallet address
    let depositWallet = null;
    try {
      const { deriveDepositWallet } = await import('@polymarket/builder-relayer-client');
      depositWallet = deriveDepositWallet(
        wallet.address,
        '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
        '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB'
      );
    } catch {}
    res.json({ address: wallet.address, depositWallet, createdAt: wallet.created_at });
  } catch (err) { next(err); }
});

router.get('/balance', async (req, res, next) => {
  try {
    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });
    // Check both EOA and deposit wallet balances
    let depositWallet = null;
    try {
      const { deriveDepositWallet } = await import('@polymarket/builder-relayer-client');
      depositWallet = deriveDepositWallet(wallet.address, '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07', '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB');
    } catch {}
    const [eoaBal, depositBal] = await Promise.all([
      db.getUSDCBalance(wallet.address),
      depositWallet ? db.getUSDCBalance(depositWallet) : Promise.resolve(0),
    ]);
    const balance = eoaBal + depositBal;
    res.json({ address: depositWallet || wallet.address, balance, eoaBalance: eoaBal, depositBalance: depositBal, currency: 'USDC' });
  } catch (err) { next(err); }
});

router.post('/export-key', async (req, res, next) => {
  try {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // License users (no password) — JWT is sufficient authentication
    const isLicenseUser = user.email && user.email.endsWith('@jonin.internal');
    if (!isLicenseUser) {
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'Password required.' });
      const valid = await db.verifyPassword(user, password);
      if (!valid) return res.status(401).json({ error: 'Incorrect password.' });
    }

    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });
    const privateKey = db.decryptPrivateKey(wallet.encrypted_private_key);
    const mnemonic   = wallet.encrypted_mnemonic ? db.decryptPrivateKey(wallet.encrypted_mnemonic) : null;
    res.json({ privateKey, mnemonic, address: wallet.address });
  } catch (err) { next(err); }
});

module.exports = router;