require('dotenv').config();
const crypto = require('crypto');
// Polyfill Web Crypto for @polymarket/clob-client (required in Node 18)
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
const { ethers } = require('ethers');
const db = require('../db');

let _clobLib = null;
async function getClobLib() {
  if (!_clobLib) _clobLib = await import('@polymarket/clob-client-v2');
  return _clobLib;
}

async function makeViemSigner(privateKey) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { createWalletClient, http } = await import('viem');
  const { polygon } = await import('viem/chains');
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);
  return createWalletClient({ account, chain: polygon, transport: http() });
}

const ALGORITHM = 'aes-256-gcm';
const CLOB_BASE = 'https://clob.polymarket.com';
const POLL_INTERVAL_MS = 15000;
const CHAIN_ID = 137;

// Shared polling: one Polymarket API call per unique target wallet regardless of how many users copy it
// sharedPolls[targetWallet] = { interval, users: Map<userId, userConfig>, lock: bool }
const sharedPolls = {};
const activeEngines   = {}; // configId -> targetWallet
const userBought      = {}; // userId -> Map<key, { usdc, shares }>
const approvedWallets = new Set(); // walletAddress -> approved
const lastActivityTs  = {}; // targetWallet -> unix timestamp of last processed activity

const logger = {
  info:  (msg, data = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...data, ts: new Date().toISOString() })),
  warn:  (msg, data = {}) => console.log(JSON.stringify({ level: 'WARN',  msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data = {}) => console.log(JSON.stringify({ level: 'ERROR', msg, ...data, ts: new Date().toISOString() })),
  trade: (msg, data = {}) => console.log(JSON.stringify({ level: 'TRADE', msg, ...data, ts: new Date().toISOString() })),
};

function decryptPrivateKey(encryptedStr) {
  const key = process.env.WALLET_ENCRYPTION_KEY;
  const [ivHex, authTagHex, encryptedHex] = encryptedStr.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

async function apiFetch(url, opts = {}) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Returns recent trade activity sorted newest-first
async function getRecentActivity(walletAddress) {
  const data = await apiFetch(`https://data-api.polymarket.com/activity?user=${walletAddress}&limit=20`);
  const items = Array.isArray(data) ? data : (data.data || data.activity || []);
  return items.map(a => {
    const usdcSize = parseFloat(a.usdcSize || a.usdc_size || a.cashSize || a.amount || 0);
    const shares   = parseFloat(a.size || a.shares || 0);
    // Derive price from usdcSize/shares if not directly available
    const price    = parseFloat(a.price || a.outcome_price || (shares > 0 ? usdcSize / shares : 0));
    const ts = parseInt(a.timestamp || a.createdAt || a.created_at || 0);
    return {
      conditionId: a.conditionId || a.condition_id || a.market,
      outcome:     a.outcome     || 'Yes',
      usdcSize,
      shares,
      price,
      tokenId:     a.asset       || a.asset_id || a.tokenId || null,
      side:        (a.side || a.type || '').toUpperCase(),
      timestamp:   ts < 1e11 ? ts * 1000 : ts,
    };
  }).filter(a => a.conditionId && (a.side === 'BUY' || a.side === 'SELL'));
}

// Fetches token ID for a specific outcome from the market endpoint
async function getTokenId(conditionId, outcome) {
  try {
    const market = await apiFetch(`${CLOB_BASE}/markets/${conditionId}`);
    const tokens = market.tokens || [];
    const token  = tokens.find(t =>
      t.outcome?.toLowerCase() === outcome?.toLowerCase() ||
      (outcome?.toLowerCase() === 'yes' && t.outcome_index === 0) ||
      (outcome?.toLowerCase() === 'no'  && t.outcome_index === 1)
    );
    return token?.token_id || null;
  } catch {
    return null;
  }
}

// side: 0 = BUY (look at asks), 1 = SELL (look at bids)
async function getBestPrice(tokenId, side) {
  const book = await apiFetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
  return side === 0
    ? parseFloat(book.asks?.[0]?.price ?? 0)
    : parseFloat(book.bids?.[0]?.price ?? 0);
}

const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (legacy)
const USDC_ADDRESS   = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';   // native USDC
const PUSD_ADDRESS   = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';   // pUSD — Polymarket v2 collateral
// V2 exchange contracts (use pUSD as collateral)
const CTF_EXCHANGES = [
  '0xE111180000d2663C0091e4f400237545B87B996B',  // exchangeV2
  '0xe2222d279d744050d28e00520010520000310F59',   // negRiskExchangeV2
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',  // exchange (legacy)
  '0xC5d563A36AE78145C45a50134d48A1215220f80a',   // negRiskExchange (legacy)
];

const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const DEPOSIT_WALLET_IMPL    = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';

const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

const _depositWalletCache = {};
const _proxyWalletCache   = {};

async function getDepositWalletAddressCached(eoaAddress) {
  if (_depositWalletCache[eoaAddress]) return _depositWalletCache[eoaAddress];
  const { deriveDepositWallet } = await import('@polymarket/builder-relayer-client');
  _depositWalletCache[eoaAddress] = deriveDepositWallet(eoaAddress, DEPOSIT_WALLET_FACTORY, DEPOSIT_WALLET_IMPL);
  return _depositWalletCache[eoaAddress];
}

async function getProxyWalletAddress(eoaAddress) {
  if (_proxyWalletCache[eoaAddress]) return _proxyWalletCache[eoaAddress];
  const { deriveProxyWallet } = await import('@polymarket/builder-relayer-client');
  _proxyWalletCache[eoaAddress] = deriveProxyWallet(eoaAddress, PROXY_FACTORY);
  return _proxyWalletCache[eoaAddress];
}

async function getWalletBalance(eoaAddress) {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const abi = ['function balanceOf(address) view returns (uint256)'];
  const depositAddr = await getDepositWalletAddressCached(eoaAddress);
  const addresses = [eoaAddress, depositAddr];
  let total = 0n;
  for (const addr of addresses) {
    const bals = await Promise.all(
      [PUSD_ADDRESS, USDC_ADDRESS, USDC_E_ADDRESS].map(t =>
        new ethers.Contract(t, abi, provider).balanceOf(addr).catch(() => 0n)
      )
    );
    total += bals.reduce((a, b) => a + b, 0n);
  }
  return parseFloat(ethers.formatUnits(total, 6));
}

// Approve CTF Exchange contracts to spend USDC - called once when engine starts
async function ensureApprovals(wallet) {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const walletWithProvider = wallet.connect(provider);
  const abi = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ];
  const threshold = ethers.parseUnits('1000', 6);

  let allApproved = true;
  for (const tokenAddr of [USDC_ADDRESS, USDC_E_ADDRESS]) {
    const usdc = new ethers.Contract(tokenAddr, abi, walletWithProvider);
    for (const exchange of CTF_EXCHANGES) {
      try {
        const allowance = await usdc.allowance(wallet.address, exchange);
        if (allowance < threshold) {
          logger.info('Approving USDC for exchange', { token: tokenAddr, exchange, wallet: wallet.address });
          const tx = await usdc.approve(exchange, ethers.MaxUint256);
          await tx.wait();
          logger.info('USDC approved', { token: tokenAddr, exchange, txHash: tx.hash });
        } else {
          logger.info('USDC already approved', { token: tokenAddr, exchange });
        }
      } catch (err) {
        allApproved = false;
        logger.warn('Approval failed (may lack MATIC for gas)', { token: tokenAddr, exchange, error: err.message });
      }
    }
  }
  if (allApproved) approvedWallets.add(wallet.address);
}

function calcTradeSize(user, signal) {
  if (user.copyMode === 'fixed') {
    return user.fixedAmount;
  }
  // percentage of trader's bet
  const size = parseFloat((signal.size * (user.copyPercentage / 100)).toFixed(2));
  return Math.max(size, 1.0);
}

function snapshotKey(pos) {
  return `${pos.conditionId}_${pos.outcome}`;
}

function diffPositions(prev, curr) {
  const opened = [];
  const closed  = [];
  for (const pos of curr) {
    const key = snapshotKey(pos);
    const old = prev.get(key);
    if (!old)                          opened.push({ ...pos, type: 'NEW' });
    else if (pos.size > old.size + 0.01) opened.push({ ...pos, type: 'INCREASED' });
  }
  const currMap = new Map(curr.map(p => [snapshotKey(p), p]));
  for (const [key, pos] of prev) {
    const now = currMap.get(key);
    if (!now)                             closed.push({ ...pos, type: 'CLOSED'  });
    else if (now.size < pos.size - 0.01)  closed.push({ ...now, type: 'REDUCED' });
  }
  return { opened, closed };
}

// ── POLYMARKET CLOB CLIENT ───────────────────────────────────────────────────
const clobClients = {}; // walletAddress -> ClobClient (initialized with creds)

async function ensureDepositWalletReady(wallet) {
  const depositAddr = await getDepositWalletAddressCached(wallet.address);
  const provider    = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const signer      = new ethers.Wallet(wallet.privateKey, provider);
  const usdcAbi     = [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
    'function approve(address,uint256) returns (bool)',
    'function allowance(address,address) view returns (uint256)',
  ];

  // 1. Deploy deposit wallet if not deployed
  const code = await provider.getCode(depositAddr);
  if (!code || code === '0x') {
    logger.info('Deploying deposit wallet...', { depositAddr: depositAddr.slice(0,10) });
    try {
      const iface = new ethers.Interface(['function create(address owner)']);
      const tx = await signer.sendTransaction({ to: DEPOSIT_WALLET_FACTORY, data: iface.encodeFunctionData('create', [wallet.address]) });
      await tx.wait();
      logger.info('Deposit wallet deployed', { txHash: tx.hash });
    } catch (err) {
      logger.warn('Deploy via create() failed, trying fallback', { error: err.message.slice(0,80) });
      try {
        const tx = await signer.sendTransaction({ to: DEPOSIT_WALLET_FACTORY });
        await tx.wait();
        logger.info('Deposit wallet deployed (fallback)', { txHash: tx.hash });
      } catch (e2) {
        logger.warn('Deposit wallet deploy failed', { error: e2.message.slice(0,80) });
      }
    }
  }

  // 2. Set USDC approvals from deposit wallet via EIP-712 batch (ethers.js signing)
  try {
    const depositContract = new ethers.Contract(depositAddr, ['function nonce() view returns (uint256)'], provider);
    const nonce    = await depositContract.nonce();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const approveIface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
    const calls = CTF_EXCHANGES.flatMap(exchange =>
      [PUSD_ADDRESS, USDC_ADDRESS, USDC_E_ADDRESS].map(token => ({
        target: token, value: 0n,
        data: approveIface.encodeFunctionData('approve', [exchange, ethers.MaxUint256]),
      }))
    );
    const domain = { name: 'DepositWallet', version: '1', chainId: CHAIN_ID, verifyingContract: depositAddr };
    const types  = {
      Call:  [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
      Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
    };
    const message  = { wallet: depositAddr, nonce: Number(nonce), deadline, calls };
    const sig      = await signer.signTypedData(domain, types, message);

    const callsEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address','uint256','uint256','tuple(address target,uint256 value,bytes data)[]','bytes'],
      [depositAddr, Number(nonce), deadline, calls.map(c => [c.target, c.value, c.data]), sig]
    );
    // Try factory selectors
    for (const sel of ['0x30d8f990','0xf59c8ac6','0x70558d06','0x8fc0307e']) {
      try {
        const tx = await signer.sendTransaction({ to: DEPOSIT_WALLET_FACTORY, data: sel + callsEncoded.slice(2) });
        await tx.wait();
        logger.info('USDC approved via factory', { selector: sel, txHash: tx.hash });
        break;
      } catch (e) {
        logger.warn('Factory batch attempt', { selector: sel, error: e.message.slice(0,80) });
      }
    }
    // Try calling deposit wallet directly (execute from owner = EOA)
    const directAbi = [
      'function execute(address to, uint256 value, bytes data)',
      'function exec(address to, uint256 value, bytes data)',
      'function call(address to, uint256 value, bytes data)',
    ];
    for (const fn of directAbi) {
      const iface2 = new ethers.Interface([fn]);
      const fnName = fn.split('(')[0].split(' ')[1];
      for (const call of calls) {
        try {
          const tx = await signer.sendTransaction({
            to:   depositAddr,
            data: iface2.encodeFunctionData(fnName, [call.target, 0, call.data]),
          });
          await tx.wait();
          logger.info('Direct execute success', { fn: fnName });
        } catch (e) {
          logger.warn('Direct execute attempt', { fn: fnName, error: e.message.slice(0,60) });
        }
      }
    }
  } catch (err) {
    logger.warn('Deposit wallet approval failed', { error: err.message.slice(0,100) });
  }

  // 3. Move all stablecoins (pUSD, USDC, USDC.e) from EOA to deposit wallet
  for (const tokenAddr of [PUSD_ADDRESS, USDC_ADDRESS, USDC_E_ADDRESS]) {
    try {
      const usdc = new ethers.Contract(tokenAddr, usdcAbi, signer);
      const bal  = await usdc.balanceOf(wallet.address);
      if (bal > 0n) {
        logger.info('Moving USDC to deposit wallet', { amount: ethers.formatUnits(bal, 6), token: tokenAddr.slice(0,10) });
        const tx = await usdc.transfer(depositAddr, bal);
        await tx.wait();
        logger.info('USDC moved to deposit wallet', { txHash: tx.hash });
      }
    } catch (err) {
      logger.warn('USDC transfer failed', { token: tokenAddr.slice(0,10), error: err.message.slice(0,80) });
    }
  }

  return depositAddr;
}

async function getClobClient(wallet) {
  if (clobClients[wallet.address]) return clobClients[wallet.address];
  const { ClobClient } = await getClobLib();

  const viemSigner = await makeViemSigner(wallet.privateKey);

  // Deploy deposit wallet + move USDC there automatically
  const depositAddr = await ensureDepositWalletReady(wallet);

  // Derive API key first, create only if missing
  const clientL1 = new ClobClient({ host: CLOB_BASE, chain: CHAIN_ID, signer: viemSigner });
  let creds;
  try {
    creds = await clientL1.deriveApiKey();
    logger.info('API key derived', { wallet: wallet.address.slice(0, 10) });
  } catch {
    creds = await clientL1.createApiKey();
    logger.info('API key created', { wallet: wallet.address.slice(0, 10) });
  }

  // POLY_1271 with deposit wallet
  const client = new ClobClient({
    host:          CLOB_BASE,
    chain:         CHAIN_ID,
    signer:        viemSigner,
    creds,
    signatureType: 3,
    funderAddress: depositAddr,
  });

  // Update balance allowance for the deposit wallet
  try {
    await client.updateBalanceAllowance();
    logger.info('Balance allowance set', { depositAddr: depositAddr.slice(0,10) });
  } catch (err) {
    logger.warn('updateBalanceAllowance failed', { error: err.message.slice(0,80) });
  }

  clobClients[wallet.address] = client;
  logger.info('ClobClient ready (POLY_1271)', { wallet: wallet.address.slice(0,10), depositAddr: depositAddr.slice(0,10) });
  return client;
}

// side: 'BUY' | 'SELL'
// amount: USDC to spend (BUY), shares to sell (SELL)
async function placeOrder(wallet, tokenId, side, price, amount) {
  const { Side, OrderType } = await getClobLib();
  const client = await getClobClient(wallet);
  const isBuy = side === 'BUY';
  const size = isBuy ? amount / price : amount;

  let tickSize = '0.01';
  try { tickSize = await client.getTickSize(tokenId); } catch {}

  let negRisk = false;
  try { negRisk = await client.getNegRisk(tokenId); } catch {}

  // Round price to tick size decimal places
  const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
  const roundedPrice = parseFloat(price.toFixed(decimals));
  const MIN_SHARES = 5;
  let sharesSize = isBuy ? amount / roundedPrice : amount;
  if (sharesSize < MIN_SHARES) throw new Error(`Min 5 shares required, have ${sharesSize.toFixed(2)} at price ${roundedPrice}. Increase per-trade amount.`);
  sharesSize = parseFloat(sharesSize.toFixed(4));

  const order = await client.createOrder(
    { tokenID: tokenId, price: roundedPrice, side: isBuy ? Side.BUY : Side.SELL, size: sharesSize },
    { tickSize, negRisk }
  );

  const result = await client.postOrder(order, OrderType.GTC);
  if (result.errorMsg) throw new Error(`CLOB rejected: ${result.errorMsg}`);
  if (result.status && result.status >= 400) throw new Error(`CLOB error ${result.status}: ${JSON.stringify(result)}`);
  return result;
}

// Process one signal for one user - completely isolated per user
async function processSignalForUser(user, wallet, signal, side) {
  try {
    if (side === 'BUY') {
      // Use tokenId from activity feed directly (most accurate)
      const tokenId = signal.tokenId || await getTokenId(signal.conditionId, signal.outcome);
      logger.info('Token debug', { signalTokenId: signal.tokenId, resolved: tokenId, outcome: signal.outcome, conditionId: signal.conditionId?.slice(0,10) });
      if (!tokenId) {
        logger.warn('Skip: token not found', { conditionId: signal.conditionId, outcome: signal.outcome });
        return;
      }

      // Use trader's price — copy exact same price they paid
      const price = signal.price > 0 ? signal.price : await getBestPrice(tokenId, 0);
      if (!price || price <= 0) {
        logger.warn('Skip: no price', { tokenId, signalPrice: signal.price });
        return;
      }

      const usdcToSpend = user.fixedAmount;
      const balance = await getWalletBalance(user.walletAddress);
      if (balance < usdcToSpend) {
        logger.warn('Skip: low balance', { userId: user.id, balance, needed: usdcToSpend });
        return;
      }

      // Fetch market name for display
      const market = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`).catch(() => null);
      const marketName = market?.question || market?.title || market?.market_slug || signal.conditionId;

      logger.trade('Placing BUY', { userId: user.id, market: marketName.slice(0,40), price, usdc: usdcToSpend });
      const result = await placeOrder(wallet, tokenId, 'BUY', price, usdcToSpend);
      logger.trade('BUY placed', { userId: user.id, orderId: result.orderID, status: result.status });
      const key = snapshotKey(signal);
      const prev = userBought[user.id]?.get(key) || { usdc: 0, shares: 0 };
      const newShares = usdcToSpend / price;
      userBought[user.id].set(key, { usdc: prev.usdc + usdcToSpend, shares: prev.shares + newShares });
      await db.upsertBotPosition(user.id, user.configId, signal.conditionId, signal.outcome, usdcToSpend, newShares).catch(() => {});
      await db.saveTrade(user.id, { conditionId: signal.conditionId, marketName, outcome: signal.outcome, side: 'BUY', size: usdcToSpend, price, orderId: result.orderID || null, filledSize: null, status: result.status || 'OPEN', skipReason: null, pnl: null, configId: user.configId });

    } else { // SELL
      const key = snapshotKey(signal);
      const pos = userBought[user.id]?.get(key);
      if (!pos || pos.shares <= 0) return;

      const tokenId = signal.tokenId || await getTokenId(signal.conditionId, signal.outcome);
      if (!tokenId) return;

      const price = await getBestPrice(tokenId, 1);
      if (!price || price <= 0) return;

      const market = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`).catch(() => null);
      const marketName = market?.question || market?.title || market?.market_slug || signal.conditionId;

      const sharesToSell = signal.type === 'CLOSED' ? pos.shares : pos.shares * 0.5;
      const expectedUsdc = sharesToSell * price;

      logger.trade('Placing SELL', { userId: user.id, conditionId: signal.conditionId, sharesToSell, price });
      const result = await placeOrder(wallet, tokenId, 'SELL', price, sharesToSell);
      logger.trade('SELL placed', { userId: user.id, orderId: result.orderID });

      if (signal.type === 'CLOSED') {
        userBought[user.id].delete(key);
        await db.deleteBotPosition(user.id, signal.conditionId, signal.outcome).catch(() => {});
      } else {
        userBought[user.id].set(key, { usdc: pos.usdc * 0.5, shares: pos.shares - sharesToSell });
        await db.upsertBotPosition(user.id, user.configId, signal.conditionId, signal.outcome, -sharesToSell * price, -sharesToSell).catch(() => {});
      }
      await db.saveTrade(user.id, { conditionId: signal.conditionId, marketName, outcome: signal.outcome, side: 'SELL', size: expectedUsdc, price, orderId: result.orderID || null, filledSize: null, status: result.status || 'PENDING', skipReason: null, pnl: null, configId: user.configId });
    }
  } catch (err) {
    logger.error(`${side} failed`, { userId: user.id, conditionId: signal.conditionId, error: err.message });
    if (side === 'BUY') {
      await db.saveTrade(user.id, { conditionId: signal.conditionId, marketName: signal.conditionId, outcome: signal.outcome, side: 'BUY', size: 0, price: 0, orderId: null, filledSize: null, status: 'FAILED', skipReason: err.message.slice(0, 200), pnl: null, configId: user.configId }).catch(() => {});
    }
  }
}

async function startCopyEngine(user, targetWallet) {
  if (activeEngines[user.configId]) {
    logger.warn('Engine already running', { configId: user.configId });
    return;
  }

  logger.info('Starting engine', { userId: user.id, configId: user.configId, targetWallet });

  // Load user's persisted positions from DB (isolated per user)
  userBought[user.id] = new Map();
  try {
    const saved = await db.getBotPositions(user.id);
    for (const p of saved) {
      userBought[user.id].set(`${p.condition_id}_${p.outcome}`, {
        usdc: parseFloat(p.usdc_spent), shares: parseFloat(p.shares),
      });
    }
    logger.info('Positions loaded', { userId: user.id, count: saved.length });
  } catch (err) {
    logger.warn('Could not load positions', { userId: user.id, error: err.message });
  }

  // Decrypt key and approve USDC - fully isolated per user wallet
  const privateKey = decryptPrivateKey(user.encryptedPrivateKey);
  const wallet = new ethers.Wallet(privateKey);
  // Skip EOA approvals for POLY_1271 — deposit wallet handles its own approvals via polymarket.com
  ensureApprovals(wallet).catch(e => logger.warn('Approval warning', { error: e.message.slice(0,60) }));

  // Register config in the shared poll for this target wallet
  activeEngines[user.configId] = targetWallet;
  if (!sharedPolls[targetWallet]) {
    // Initialize timestamp cursor to now in ms — only copy trades after this point
    lastActivityTs[targetWallet] = Date.now();
    logger.info('Activity cursor initialized', { targetWallet, fromTs: lastActivityTs[targetWallet] });

    sharedPolls[targetWallet] = {
      users: new Map(),
      lock: false,
      pollCount: 0,
      interval: setInterval(async () => {
        const poll = sharedPolls[targetWallet];
        if (!poll || poll.users.size === 0) return;
        if (poll.lock) return;
        poll.lock = true;
        poll.pollCount = (poll.pollCount || 0) + 1;
        try {
          const activities = await getRecentActivity(targetWallet);
          const lastTs = lastActivityTs[targetWallet] || 0;
          const fresh = activities.filter(a => a.timestamp > lastTs);

          if (poll.pollCount % 20 === 0) {
            logger.info('Poll heartbeat', { targetWallet: targetWallet.slice(0, 10), polls: poll.pollCount, lastTs, freshActivities: fresh.length });
          }

          if (fresh.length === 0) return;

          lastActivityTs[targetWallet] = Math.max(...fresh.map(a => a.timestamp));

          const opened = fresh.filter(a => a.side === 'BUY');
          const closed = fresh.filter(a => a.side === 'SELL');

          logger.info('New activity detected', { targetWallet: targetWallet.slice(0, 10), buys: opened.length, sells: closed.length });

          // Process signals for EACH user independently - fully isolated
          for (const [, { user: u, wallet: w }] of poll.users) {
            if (!approvedWallets.has(w.address)) ensureApprovals(w).catch(() => {});
            for (const signal of opened) {
              await processSignalForUser(u, w, signal, 'BUY');
            }
            for (const signal of closed) {
              await processSignalForUser(u, w, signal, 'SELL');
            }
          }
        } catch (err) {
          logger.error('Shared poll failed', { targetWallet, error: err.message });
        } finally {
          poll.lock = false;
        }
      }, POLL_INTERVAL_MS),
    };
  }

  sharedPolls[targetWallet].users.set(user.configId, { user, wallet });
  logger.info('Config joined shared poll', { userId: user.id, configId: user.configId, targetWallet, totalWatchers: sharedPolls[targetWallet].users.size });
}

function stopCopyEngine(configId) {
  const targetWallet = activeEngines[configId];
  if (!targetWallet) return;

  const poll = sharedPolls[targetWallet];
  if (poll) {
    poll.users.delete(configId);
    if (poll.users.size === 0) {
      clearInterval(poll.interval);
      delete sharedPolls[targetWallet];
      delete lastActivityTs[targetWallet];
      logger.info('Shared poll stopped - no more watchers', { targetWallet });
    } else {
      logger.info('Config left shared poll', { configId, targetWallet, remaining: poll.users.size });
    }
  }

  delete activeEngines[configId];
  logger.info('Engine stopped', { configId });
}

module.exports = { startCopyEngine, stopCopyEngine };
