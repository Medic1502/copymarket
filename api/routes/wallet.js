const router = require('express').Router();
const db = require('../../db');
const { requireAuth } = require('../middleware/auth');
const { ethers } = require('ethers');

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

router.post('/recover-deposit-wallet', async (req, res, next) => {
  try {
    const { toAddress } = req.body;
    if (!toAddress || !/^0x[0-9a-fA-F]{40}$/.test(toAddress)) return res.status(400).json({ error: 'Invalid address.' });

    const wallet = await db.getWalletByUserId(req.userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found.' });

    const privateKey = db.decryptPrivateKey(wallet.encrypted_private_key);
    const provider   = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const signer     = new ethers.Wallet(privateKey, provider);

    const { deriveDepositWallet } = await import('@polymarket/builder-relayer-client');
    const depositAddr = deriveDepositWallet(wallet.address, '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07', '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB');

    const tokens = [
      '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', // pUSD
      '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',  // native USDC
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',  // USDC.e
    ];
    const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
    const transferIface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);

    // Try to call deposit wallet execute function directly with signed batch
    const depositWalletAbi = ['function nonce() view returns (uint256)'];
    const depositContract  = new ethers.Contract(depositAddr, depositWalletAbi, provider);
    const nonce    = await depositContract.nonce().catch(() => 0n);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    // Step 1: Check if deposit wallet is deployed
    const code = await provider.getCode(depositAddr);
    const isDeployed = code && code !== '0x';
    const deployLog = [];

    if (!isDeployed) {
      // Try many factory function signatures to deploy
      const FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
      const IMPL    = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';
      const { pad, keccak256: viemKeccak, encodeAbiParameters, concat, toHex } = await import('viem');
      const walletId = pad(wallet.address, { dir: 'left', size: 32 });
      const args = encodeAbiParameters([{type:'address'},{type:'bytes32'}], [FACTORY, walletId]);
      const salt = viemKeccak(args);
      const deploySelectors = [
        { fn: 'create(address)', args: [wallet.address] },
        { fn: 'createWallet(address)', args: [wallet.address] },
        { fn: 'deploy(address)', args: [wallet.address] },
        { fn: 'createFor(address)', args: [wallet.address] },
        { fn: 'newWallet(address)', args: [wallet.address] },
        { fn: 'create(bytes32)', rawArgs: walletId },
      ];
      for (const d of deploySelectors) {
        try {
          const iface = new ethers.Interface([`function ${d.fn}`]);
          const fnName = d.fn.split('(')[0];
          const data = d.rawArgs
            ? iface.encodeFunctionData(fnName, [d.rawArgs])
            : iface.encodeFunctionData(fnName, d.args);
          const tx = await signer.sendTransaction({ to: FACTORY, data });
          await tx.wait();
          const newCode = await provider.getCode(depositAddr);
          if (newCode && newCode !== '0x') {
            deployLog.push({ success: true, fn: d.fn });
            break;
          }
          deployLog.push({ fn: d.fn, result: 'reverted or wrong address' });
        } catch (e) {
          deployLog.push({ fn: d.fn, error: e.message.slice(0,60) });
        }
      }
    }

    // Step 2: Try to transfer directly from deposit wallet
    const results = [];
    const newCode = await provider.getCode(depositAddr);
    const walletDeployed = newCode && newCode !== '0x';

    for (const tokenAddr of tokens) {
      const token = new ethers.Contract(tokenAddr, erc20Abi, provider);
      const bal   = await token.balanceOf(depositAddr).catch(() => 0n);
      if (bal === 0n) continue;

      const transferData = transferIface.encodeFunctionData('transfer', [toAddress, bal]);
      const calls = [{ target: tokenAddr, value: 0n, data: transferData }];

      let txHash = null;
      if (walletDeployed) {
        const domain = { name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: depositAddr };
        const types  = {
          Call:  [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
          Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
        };
        const message = { wallet: depositAddr, nonce: Number(nonce), deadline, calls };
        const sig     = await signer.signTypedData(domain, types, message);
        const callsAbi = ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256','uint256','tuple(address,uint256,bytes)[]','bytes'],
          [Number(nonce), deadline, calls.map(c => [c.target, c.value, c.data]), sig]
        );
        for (const sel of ['0xe2ca8866','0xe7274679','0xf59c8ac6','0x30d8f990']) {
          try {
            const tx = await signer.sendTransaction({ to: depositAddr, data: sel + callsAbi.slice(2) });
            await tx.wait(); txHash = tx.hash;
            results.push({ token: tokenAddr, amount: ethers.formatUnits(bal, 6), txHash });
            break;
          } catch {}
        }
      }
      if (!txHash) results.push({ token: tokenAddr, amount: ethers.formatUnits(bal, 6), error: 'Execute failed — wallet not deployed or wrong ABI', deployed: walletDeployed, deployLog });
    }
    res.json({ depositWallet: depositAddr, isDeployed, walletDeployed, deployLog, results });
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