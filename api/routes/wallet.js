const router = require('express').Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');
const { ethers } = require('ethers');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });
    // Compute proxy wallet address (created via polymarket.com ToS)
    let proxyWallet = null;
    try {
      const { deriveProxyWallet } = await import('@polymarket/builder-relayer-client');
      proxyWallet = deriveProxyWallet(wallet.address, '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052');
    } catch {}
    res.json({ address: wallet.address, depositWallet: proxyWallet, proxyWallet, createdAt: wallet.created_at });
  } catch (err) { next(err); }
});

router.get('/balance', async (req, res, next) => {
  try {
    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });
    // Check both EOA and deposit wallet balances
    let depositWallet = null;
    try {
      const { deriveProxyWallet } = await import('@polymarket/builder-relayer-client');
      depositWallet = deriveProxyWallet(wallet.address, '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052');
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

router.post('/withdraw', async (req, res, next) => {
  try {
    const { toAddress, amount } = req.body;
    if (!toAddress || !/^0x[0-9a-fA-F]{40}$/.test(toAddress)) return res.status(400).json({ error: 'Invalid address.' });
    if (!amount || isNaN(amount) || parseFloat(amount) < 1) return res.status(400).json({ error: 'Minimum withdrawal is $1.' });

    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });

    const privateKey = db.decryptPrivateKey(wallet.encrypted_private_key);
    const provider   = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const signer     = new ethers.Wallet(privateKey, provider);

    // Try native USDC first, then USDC.e
    const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    const USDC_E      = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const abi = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

    const amountUnits = ethers.parseUnits(parseFloat(amount).toFixed(6), 6);

    for (const tokenAddr of [USDC_NATIVE, USDC_E]) {
      const usdc = new ethers.Contract(tokenAddr, abi, signer);
      const bal  = await usdc.balanceOf(signer.address);
      if (bal >= amountUnits) {
        const tx = await usdc.transfer(toAddress, amountUnits);
        await tx.wait();
        return res.json({ success: true, txHash: tx.hash, token: tokenAddr });
      }
    }
    return res.status(400).json({ error: 'Insufficient USDC balance.' });
  } catch (err) { next(err); }
});

module.exports = router;