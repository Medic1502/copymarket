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
const REDEEM_INTERVAL_MS = 60 * 1000;
const CHAIN_ID = 137;

const CTF_COLLATERAL_ADAPTER          = '0xAdA100Db00Ca00073811820692005400218FcE1f';
const NEG_RISK_CTF_COLLATERAL_ADAPTER = '0xadA2005600Dec949baf300f4C6120000bDB6eAab';

// Shared polling: one Polymarket API call per unique target wallet regardless of how many users copy it
// sharedPolls[targetWallet] = { interval, users: Map<userId, userConfig>, lock: bool }
const sharedPolls = {};
const activeEngines   = {}; // configId -> targetWallet
const userBought      = {}; // userId -> Map<key, { usdc, shares }>
const approvedWallets = new Set(); // walletAddress -> approved
const lastActivityTs  = {}; // targetWallet -> unix timestamp of last processed activity
const redeemIntervals = {}; // userId -> intervalId
const configToUserId  = {}; // configId -> userId
const userConfigCount = {}; // userId -> number of active configs

// TTL caches — shared across all users, prevents excessive API calls at scale
const _tokenBidCache = {}; // tokenId -> { bid, ts }
const _marketCache   = {}; // conditionId -> { data, ts }
const _balanceCache  = {}; // walletAddress -> { balance, ts }
const _payoutCache   = {}; // conditionId -> { resolved: bool, winnerIdx: 0|1|null, ts }
const TOKEN_BID_TTL  = 20 * 1000;       // 20s — one fresh fetch per poll cycle
const MARKET_TTL     = 4 * 60 * 1000;  // 4min — safe for closed-market detection
const BALANCE_TTL    = 30 * 1000;      // 30s — fresh enough for trade decisions
const PAYOUT_TTL     = 2 * 60 * 1000;  // 2min for unresolved; resolved entries cached forever

async function getCachedTokenBid(tokenId) {
  const c = _tokenBidCache[tokenId];
  if (c && Date.now() - c.ts < TOKEN_BID_TTL) return c.bid;
  const bid = await getBestPrice(tokenId, 1).catch(() => 0);
  _tokenBidCache[tokenId] = { bid, ts: Date.now() };
  return bid;
}

// Category detection using CLOB market_slug (reliable) + tags + question as fallback.
// Slug format: "mlb-hou-chc-2026-05-22", "nba-bos-nyk-spread-2026-05-22", etc.
function marketMatchesCategories(market, categories) {
  if (!categories || categories.length === 0) return true;
  const slug = (market.market_slug || market.slug || '').toLowerCase();
  const tags = (Array.isArray(market.tags) ? market.tags.join(' ') : (market.tags || '')).toLowerCase();
  const q    = (market.question || '').toLowerCase();

  const matchId = c => {
    switch (c) {
      case 'nba':    return slug.startsWith('nba') || slug.startsWith('wnba') || tags.includes('nba') || tags.includes('basketball') || q.includes('nba') || q.includes('wnba');
      case 'nfl':    return slug.startsWith('nfl') || tags.includes('nfl') || tags.includes('american football') || q.includes('nfl') || q.includes('super bowl');
      case 'mlb':    return slug.startsWith('mlb') || tags.includes('mlb') || tags.includes('baseball') || q.includes('mlb') || q.includes('baseball');
      case 'nhl':    return slug.startsWith('nhl') || tags.includes('nhl') || tags.includes('hockey') || q.includes('nhl') || q.includes('hockey');
      case 'soccer': return slug.startsWith('soccer') || slug.startsWith('epl') || slug.startsWith('mls') || slug.startsWith('ucl') || tags.includes('soccer') || tags.includes('premier league') || tags.includes('champions league') || tags.includes('eredivisie') || q.includes('premier league') || q.includes('champions league') || q.includes('la liga') || q.includes('bundesliga') || q.includes('eredivisie') || q.includes('serie a') || q.includes('mls');
      case 'tennis': return slug.startsWith('tennis') || tags.includes('tennis') || tags.includes('atp') || tags.includes('wta') || q.includes('tennis') || q.includes('wimbledon');
      case 'golf':   return slug.startsWith('golf') || slug.startsWith('pga') || tags.includes('golf') || tags.includes('pga') || q.includes('golf') || q.includes('pga');
      case 'mma':    return slug.startsWith('ufc') || slug.startsWith('mma') || tags.includes('ufc') || tags.includes('mma') || q.includes('ufc') || q.includes('mma');
      case 'boxing': return slug.startsWith('boxing') || tags.includes('boxing') || q.includes('boxing');
      case 'us-politics':   return tags.includes('politics') || tags.includes('election') || tags.includes('trump') || tags.includes('us politics') || q.includes('president') || q.includes('congress') || q.includes('senate');
      case 'international': return tags.includes('geopolit') || tags.includes('ukraine') || tags.includes('international') || q.includes('ukraine') || q.includes('nato');
      case 'crypto':        return slug.startsWith('crypto') || slug.startsWith('bitcoin') || slug.startsWith('eth') || tags.includes('crypto') || tags.includes('bitcoin') || tags.includes('ethereum');
      case 'business':      return tags.includes('business') || tags.includes('finance') || tags.includes('earnings') || tags.includes('economy');
      case 'entertainment': return tags.includes('pop culture') || tags.includes('entertainment') || tags.includes('music') || tags.includes('awards');
      default: return false;
    }
  };
  const whitelist = categories.filter(c => !c.startsWith('!'));
  const blacklist = categories.filter(c => c.startsWith('!')).map(c => c.slice(1));
  if (blacklist.length > 0 && blacklist.some(matchId)) return false;
  if (whitelist.length > 0) return whitelist.some(matchId);
  return true;
}

async function getCachedMarket(conditionId) {
  const c = _marketCache[conditionId];
  if (c && Date.now() - c.ts < MARKET_TTL) return c.data;
  const arr = await apiFetch(`https://gamma-api.polymarket.com/markets?conditionIds=${conditionId}`).catch(() => null);
  const data = (Array.isArray(arr) && arr.length > 0) ? arr[0] : null;
  if (data) _marketCache[conditionId] = { data, ts: Date.now() };
  return data;
}

// On-chain resolution check via CTF payoutDenominator — authoritative, bypasses Gamma lag
const CTF_ABI_PAYOUT = [
  'function payoutDenominator(bytes32) view returns (uint256)',
  'function payoutNumerators(bytes32, uint256) view returns (uint256)',
];
const CTF_ADDR = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

async function getOnChainResolution(conditionId, provider) {
  const cached = _payoutCache[conditionId];
  if (cached) {
    if (cached.resolved) return cached;                       // permanent once resolved
    if (Date.now() - cached.ts < PAYOUT_TTL) return cached;  // unresolved: 2min TTL
  }
  try {
    const ctf   = new ethers.Contract(CTF_ADDR, CTF_ABI_PAYOUT, provider);
    const denom = await ctf.payoutDenominator(conditionId);
    if (denom === 0n) {
      _payoutCache[conditionId] = { resolved: false, winnerIdx: null, ts: Date.now() };
      return _payoutCache[conditionId];
    }
    // Resolved — determine winner (binary market: index 0 or 1)
    const [num0, num1] = await Promise.all([
      ctf.payoutNumerators(conditionId, 0),
      ctf.payoutNumerators(conditionId, 1),
    ]);
    const winnerIdx = num0 > 0n ? 0 : (num1 > 0n ? 1 : null);
    _payoutCache[conditionId] = { resolved: true, winnerIdx, ts: Date.now() };
    return _payoutCache[conditionId];
  } catch (e) {
    logger.warn('getOnChainResolution failed', { conditionId: conditionId?.slice(0, 10), error: e.message });
    return { resolved: false, winnerIdx: null, ts: Date.now() };
  }
}

async function getWalletBalanceCached(eoaAddress) {
  const c = _balanceCache[eoaAddress];
  if (c && Date.now() - c.ts < BALANCE_TTL) return c.balance;
  const balance = await getWalletBalance(eoaAddress);
  _balanceCache[eoaAddress] = { balance, ts: Date.now() };
  return balance;
}

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

async function apiFetch(url, opts = {}, timeoutMs = 10_000) {
  const { default: fetch } = await import('node-fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns recent trade activity sorted newest-first
async function getRecentActivity(walletAddress) {
  const data = await apiFetch(`https://data-api.polymarket.com/activity?user=${walletAddress}&limit=200`);
  const items = Array.isArray(data) ? data : (data.data || data.activity || []);
  return items.map(a => {
    const usdcSize = parseFloat(a.usdcSize || a.usdc_size || a.cashSize || a.amount || 0);
    const shares   = parseFloat(a.size || a.shares || 0);
    // Derive price from usdcSize/shares if not directly available
    const price    = parseFloat(a.price || a.outcome_price || (shares > 0 ? usdcSize / shares : 0));
    const ts = parseInt(a.timestamp || a.createdAt || a.created_at || 0);
    return {
      conditionId:  a.conditionId || a.condition_id || a.market,
      outcome:      a.outcome     || 'Yes',
      outcomeIndex: a.outcomeIndex ?? a.outcome_index ?? null,
      usdcSize,
      shares,
      price,
      tokenId:      a.asset       || a.asset_id || a.tokenId || null,
      side:         (a.side || a.type || '').toUpperCase(),
      timestamp:    ts < 1e11 ? ts * 1000 : ts,
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
  if (!signal.usdcSize || signal.usdcSize <= 0) return null; // skip if trader size unknown
  const size = parseFloat((signal.usdcSize * (user.copyPercentage / 100)).toFixed(2));
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
    try {
      creds = await clientL1.createApiKey();
      logger.info('API key created', { wallet: wallet.address.slice(0, 10) });
    } catch (createErr) {
      throw new Error(`Failed to get CLOB API key: ${createErr.message}`);
    }
  }

  // POLY_1271 with deposit wallet + builder attribution
  const builderCode = process.env.POLY_BUILDER_CODE || null;
  const client = new ClobClient({
    host:          CLOB_BASE,
    chain:         CHAIN_ID,
    signer:        viemSigner,
    creds,
    signatureType: 3,
    funderAddress: depositAddr,
    ...(builderCode ? { builderConfig: { builderCode } } : {}),
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
// orderType: optional override ('GTC' | 'FOK'). Defaults to GTC.
async function placeOrder(wallet, tokenId, side, price, amount, orderType) {
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

  const builderCode = process.env.POLY_BUILDER_CODE || null;
  const order = await client.createOrder(
    { tokenID: tokenId, price: roundedPrice, side: isBuy ? Side.BUY : Side.SELL, size: sharesSize, ...(builderCode ? { builderCode } : {}) },
    { tickSize, negRisk }
  );

  const chosenType = orderType ?? OrderType.GTC;
  const result = await client.postOrder(order, chosenType);
  if (result.errorMsg) throw new Error(`CLOB rejected: ${result.errorMsg}`);
  if (result.status && result.status >= 400) throw new Error(`CLOB error ${result.status}: ${JSON.stringify(result)}`);
  return result;
}

// Process one signal for one user - completely isolated per user
async function processSignalForUser(user, wallet, signal, side) {
  try {
    if (side === 'BUY') {
      // Skip if already in position AND user wants initial buy only
      const posKey = snapshotKey(signal);
      if (user.followMode === 'initial_only' && userBought[user.id]?.has(posKey)) {
        logger.info('Skip: already in position (initial_only)', { conditionId: signal.conditionId?.slice(0,10) });
        return;
      }

      // Skip if price outside copy range (cents filter)
      if (signal.price > 0) {
        if (user.minSharePrice != null && signal.price < user.minSharePrice) {
          logger.info('Skip: price below min cc', { price: signal.price, min: user.minSharePrice, conditionId: signal.conditionId?.slice(0,10) });
          return;
        }
        if (user.maxSharePrice != null && signal.price > user.maxSharePrice) {
          logger.info('Skip: price above max cc', { price: signal.price, max: user.maxSharePrice, conditionId: signal.conditionId?.slice(0,10) });
          return;
        }
      }

      // Fetch CLOB market data once — used for both category check and tokenId lookup.
      // CLOB has ALL markets (incl. spreads/O/U) and market_slug is always reliable.
      let clobMarket = null;
      try {
        clobMarket = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`);
      } catch {}

      // Category filter — uses CLOB market_slug + tags (reliable for all market types)
      if (user.categories && user.categories.length > 0 && clobMarket) {
        if (!marketMatchesCategories(clobMarket, user.categories)) {
          logger.info('Skip: category not in filter', { slug: clobMarket.market_slug, cats: user.categories, conditionId: signal.conditionId?.slice(0,10) });
          return;
        }
      }

      // TokenId from CLOB data (no extra call needed)
      const tokenId = signal.tokenId || (() => {
        const tokens = clobMarket?.tokens || [];
        const t = tokens.find(tk =>
          tk.outcome?.toLowerCase() === signal.outcome?.toLowerCase() ||
          (signal.outcomeIndex != null && tk.outcome_index === signal.outcomeIndex)
        );
        return t?.token_id || null;
      })() || await getTokenId(signal.conditionId, signal.outcome);

      if (!tokenId) {
        logger.warn('Skip: token not found', { conditionId: signal.conditionId, outcome: signal.outcome });
        return;
      }

      const price = signal.price > 0 ? signal.price : await getBestPrice(tokenId, 0);
      if (!price || price <= 0) {
        logger.warn('Skip: no price', { tokenId, signalPrice: signal.price });
        return;
      }

      // Calculate USDC to spend (fixed amount or % of trader's bet)
      let usdcToSpend = calcTradeSize(user, signal);
      if (!usdcToSpend) {
        logger.warn('Skip: % mode but trader usdcSize unknown', { conditionId: signal.conditionId?.slice(0,10) });
        return;
      }

      // Clamp to maxPositionSize — don't skip, spend only what's left up to the cap
      if (user.maxPositionSize != null) {
        const alreadySpent = userBought[user.id]?.get(posKey)?.usdc ?? 0;
        const remaining = user.maxPositionSize - alreadySpent;
        if (remaining <= 0) {
          logger.info('Skip: max position size reached', { conditionId: signal.conditionId?.slice(0,10), spent: alreadySpent, max: user.maxPositionSize });
          return;
        }
        usdcToSpend = Math.min(usdcToSpend, remaining);
      }

      const balance = await getWalletBalance(user.walletAddress);
      if (balance < usdcToSpend) {
        logger.warn('Skip: low balance', { userId: user.id, balance, needed: usdcToSpend });
        return;
      }

      // Fetch market name and slug for display/links
      const market = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`).catch(() => null);
      const marketName = market?.question || market?.title || market?.market_slug || signal.conditionId;
      const marketSlug = market?.market_slug || null;

      // GTC for normal prices, FOK only for ≥95¢ (prevents phantom positions near expiry)
      const { OrderType: OT } = await getClobLib();
      const chosenOrderType = price >= 0.95 ? OT.FOK : OT.GTC;
      logger.trade('Placing BUY', { userId: user.id, market: marketName.slice(0,40), price, usdc: usdcToSpend, type: chosenOrderType });
      const result = await placeOrder(wallet, tokenId, 'BUY', price, usdcToSpend, chosenOrderType);

      // FOK: if CLOB accepted but didn't fill (no immediate match), treat as skip
      if (chosenOrderType === OT.FOK && (!result.orderID || result.status === 'CANCELLED')) {
        logger.info('FOK order not matched — no sell liquidity at this price, skipping', {
          userId: user.id, price, conditionId: signal.conditionId?.slice(0,10),
        });
        return;
      }

      logger.trade('BUY placed', { userId: user.id, orderId: result.orderID, status: result.status });
      const key = snapshotKey(signal);
      const prev = userBought[user.id]?.get(key) || { usdc: 0, shares: 0 };
      const newShares = usdcToSpend / price;
      userBought[user.id].set(key, { usdc: prev.usdc + usdcToSpend, shares: prev.shares + newShares });
      await db.upsertBotPosition(user.id, user.configId, signal.conditionId, signal.outcome, usdcToSpend, newShares, signal.outcomeIndex, tokenId, marketName, marketSlug).catch(() => {});
      await db.saveTrade(user.id, { conditionId: signal.conditionId, marketName, marketSlug, outcome: signal.outcome, side: 'BUY', size: usdcToSpend, price, orderId: result.orderID || null, filledSize: null, status: result.status || 'OPEN', skipReason: null, pnl: null, configId: user.configId });

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
      const errLower = err.message.toLowerCase();
      const isBalanceErr = errLower.includes('balance') || errLower.includes('allowance') || errLower.includes('insufficient');
      if (!isBalanceErr) {
        const failMkt  = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`).catch(() => null);
        const failName = failMkt?.question || failMkt?.title || failMkt?.market_slug || signal.conditionId;
        await db.saveTrade(user.id, { conditionId: signal.conditionId, marketName: failName, outcome: signal.outcome, side: 'BUY', size: 0, price: 0, orderId: null, filledSize: null, status: 'FAILED', skipReason: err.message.slice(0, 200), pnl: null, configId: user.configId }).catch(() => {});
      }
    }
  }
}

// Redeem a winning CTF position via EIP-712 batch (primary) or direct execute (fallback)
async function redeemPositionOnChain(signer, depositAddr, conditionId, isNegRisk) {
  const adapterAddr = isNegRisk ? NEG_RISK_CTF_COLLATERAL_ADAPTER : CTF_COLLATERAL_ADAPTER;
  const adapterIface = new ethers.Interface([
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ]);
  const redeemData = adapterIface.encodeFunctionData('redeemPositions', [
    PUSD_ADDRESS,
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    conditionId,
    [1n, 2n],
  ]);
  const call = { target: adapterAddr, value: 0n, data: redeemData };

  // Primary: EIP-712 batch via factory — same mechanism used for approvals
  try {
    const depositContract = new ethers.Contract(depositAddr, ['function nonce() view returns (uint256)'], signer.provider);
    const nonce    = await depositContract.nonce();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const domain   = { name: 'DepositWallet', version: '1', chainId: CHAIN_ID, verifyingContract: depositAddr };
    const types    = {
      Call:  [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
      Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
    };
    const message = { wallet: depositAddr, nonce: Number(nonce), deadline, calls: [call] };
    const sig     = await signer.signTypedData(domain, types, message);
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address','uint256','uint256','tuple(address target,uint256 value,bytes data)[]','bytes'],
      [depositAddr, Number(nonce), deadline, [[call.target, call.value, call.data]], sig]
    );
    for (const sel of ['0x30d8f990','0xf59c8ac6','0x70558d06','0x8fc0307e']) {
      try {
        const tx = await signer.sendTransaction({ to: DEPOSIT_WALLET_FACTORY, data: sel + encoded.slice(2) });
        await tx.wait();
        return tx.hash;
      } catch {}
    }
  } catch {}

  // Fallback: direct execute/exec/call on deposit wallet
  for (const fn of ['execute','exec','call']) {
    try {
      const iface = new ethers.Interface([`function ${fn}(address to, uint256 value, bytes data)`]);
      const tx = await signer.sendTransaction({
        to:   depositAddr,
        data: iface.encodeFunctionData(fn, [adapterAddr, 0, redeemData]),
      });
      await tx.wait();
      return tx.hash;
    } catch {}
  }

  throw new Error('All redemption methods failed');
}

async function checkAndRedeemPositions(user, wallet) {
  try {
    const positions = await db.getBotPositions(user.id);
    if (!positions || positions.length === 0) return;

    const provider    = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const signer      = new ethers.Wallet(wallet.privateKey, provider);
    const depositAddr = await getDepositWalletAddressCached(wallet.address);

    for (const pos of positions) {
      try {
        const conditionId = pos.condition_id;

        const market = await getCachedMarket(conditionId);

        // Primary: Gamma closed flag. Fallback: on-chain payoutDenominator (authoritative, bypasses Gamma lag)
        let onChainRes = null;
        if (!market?.closed) {
          onChainRes = await getOnChainResolution(conditionId, provider);
          if (!onChainRes.resolved) continue; // not resolved by either source
          logger.info('Market resolved on-chain but Gamma not updated yet', { conditionId: conditionId.slice(0, 10) });
        }

        const outcomePrices = market ? (
          typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : (market.outcomePrices || [])
        ) : [];
        const clobTokenIds = market ? (
          typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds || [])
        ) : [];

        // Determine which outcome index we hold
        // Priority: saved outcome_index → token_id match → on-chain CTF balance
        let ourIdx = pos.outcome_index;
        if (ourIdx == null && pos.token_id && clobTokenIds.length > 0) {
          const found = clobTokenIds.findIndex(tid => tid === pos.token_id);
          if (found >= 0) ourIdx = found;
        }
        if (ourIdx == null && clobTokenIds.length >= 2) {
          const ctfAbi = ['function balanceOf(address,uint256) view returns (uint256)'];
          const ctf = new ethers.Contract(CTF_ADDR, ctfAbi, provider);
          const [bal0, bal1] = await Promise.all([
            ctf.balanceOf(depositAddr, BigInt(clobTokenIds[0])).catch(() => 0n),
            ctf.balanceOf(depositAddr, BigInt(clobTokenIds[1])).catch(() => 0n),
          ]);
          if (bal0 > 0n) ourIdx = 0;
          else if (bal1 > 0n) ourIdx = 1;
          else {
            // No balance — already redeemed or never filled; clean up
            logger.info('No CTF balance, cleaning up DB position', { conditionId: conditionId.slice(0, 10) });
            // Use on-chain winner if available, otherwise fall back to Gamma prices
            const onChain = onChainRes ?? await getOnChainResolution(conditionId, provider);
            let cleanOutcome = 'LOST';
            if (onChain.resolved && onChain.winnerIdx != null) {
              // We don't know ourIdx (no balance), treat as LOST for cleanup
            } else {
              const winnerIdx = outcomePrices.findIndex(p => parseFloat(p) >= 0.99);
              if (winnerIdx < 0) cleanOutcome = 'LOST';
            }
            await db.resolveBotPosition(user.id, conditionId, pos.outcome, cleanOutcome, -parseFloat(pos.usdc_spent)).catch(() => {});
            continue;
          }
        }
        if (ourIdx == null) {
          logger.warn('Cannot determine outcome_index, skipping', { conditionId: conditionId.slice(0, 10) });
          continue;
        }

        // Guard: verify we actually hold CTF tokens before recording any outcome.
        // Limit orders near market close often go unfilled — order submits to CLOB but is
        // cancelled when the market closes, so no tokens transfer and no USDC leaves the wallet.
        if (clobTokenIds.length > ourIdx) {
          const ctfGuardAbi = ['function balanceOf(address,uint256) view returns (uint256)'];
          const ctfGuard = new ethers.Contract(CTF_ADDR, ctfGuardAbi, provider);
          const ctfBal = await ctfGuard.balanceOf(depositAddr, BigInt(clobTokenIds[ourIdx])).catch(() => 0n);
          if (ctfBal === 0n) {
            logger.info('No CTF tokens — order unfilled (cancelled at market close), removing phantom position', {
              userId: user.id, conditionId: conditionId.slice(0, 10), outcome: pos.outcome,
            });
            // pnl=0 because USDC was never spent (limit order never matched)
            await db.resolveBotPosition(user.id, conditionId, pos.outcome, 'LOST', 0).catch(() => {});
            if (userBought[user.id]) userBought[user.id].delete(`${conditionId}_${pos.outcome}`);
            continue;
          }
        }

        // Winner determination: on-chain payoutNumerators is authoritative (works for 99¢ traders too)
        // Fall back to Gamma outcomePrices only if on-chain check wasn't done
        let isWinner;
        if (onChainRes?.resolved && onChainRes.winnerIdx != null) {
          isWinner = onChainRes.winnerIdx === ourIdx;
        } else if (onChainRes?.resolved && onChainRes.winnerIdx == null) {
          // payoutDenominator was set but no clear winner (shouldn't happen in binary markets)
          isWinner = Array.isArray(outcomePrices) && parseFloat(outcomePrices[ourIdx]) >= 0.99;
        } else {
          // Gamma path: check outcomePrices or fetch fresh on-chain to be safe
          const fresh = await getOnChainResolution(conditionId, provider);
          isWinner = fresh.resolved && fresh.winnerIdx != null
            ? fresh.winnerIdx === ourIdx
            : (Array.isArray(outcomePrices) && parseFloat(outcomePrices[ourIdx]) >= 0.99);
        }
        const shares    = parseFloat(pos.shares);
        const usdcSpent = parseFloat(pos.usdc_spent);
        const pnl       = isWinner ? parseFloat((shares - usdcSpent).toFixed(4)) : -usdcSpent;
        const marketName = market.question || market.title || conditionId;
        const marketSlug = market.slug || market.market_slug || null;

        logger.info('Market closed, settling position', {
          userId: user.id, conditionId: conditionId.slice(0, 10),
          outcome: pos.outcome, outcomeIndex: ourIdx, isWinner, pnl,
        });

        // FIX: update DB immediately — don't block on on-chain result
        await db.resolveBotPosition(user.id, conditionId, pos.outcome, isWinner ? 'WON' : 'LOST', pnl).catch(() => {});
        await db.resolveTradeOutcome(user.id, conditionId, isWinner ? 'WON' : 'LOST', pnl).catch(() => {});
        await db.saveTrade(user.id, {
          conditionId, marketName, marketSlug,
          outcome:    pos.outcome,
          side:       'REDEEM',
          size:       isWinner ? shares : 0,
          price:      isWinner ? 1.0 : 0,
          orderId:    null,
          filledSize: isWinner ? shares : null,
          status:     'REDEEMED',
          skipReason: null,
          pnl,
          configId:   user.configId,
        }).catch(() => {});

        if (userBought[user.id]) {
          userBought[user.id].delete(`${conditionId}_${pos.outcome}`);
        }

        logger.trade('Position settled in DB', {
          userId: user.id, conditionId: conditionId.slice(0, 10),
          outcome: pos.outcome, isWinner, pnl,
        });

        // Attempt on-chain redeem async (non-blocking) — only needed for winning positions
        if (isWinner) {
          ;(async () => {
            const maticBal = await provider.getBalance(signer.address).catch(() => 0n);
            if (maticBal < ethers.parseEther('0.001')) {
              logger.warn('On-chain redeem skipped: insufficient MATIC for gas', {
                userId: user.id, eoaAddress: signer.address, maticBal: ethers.formatEther(maticBal),
              });
              return;
            }
            try {
              const txHash = await redeemPositionOnChain(signer, depositAddr, conditionId, market?.negRisk);
              logger.trade('On-chain redeem confirmed', { userId: user.id, txHash, conditionId: conditionId.slice(0, 10) });
            } catch (e) {
              logger.warn('On-chain redeem failed', { userId: user.id, conditionId: conditionId.slice(0, 10), error: e.message.slice(0, 200) });
            }
          })().catch(e => logger.warn('Async redeem error', { error: e.message.slice(0, 200) }));
        }
      } catch (posErr) {
        logger.warn('Redeem check error for position', {
          userId: user.id, conditionId: pos.condition_id?.slice(0, 10),
          error: posErr.message,
        });
      }
    }
  } catch (err) {
    logger.warn('checkAndRedeemPositions error', { userId: user.id, error: err.message });
  }
}

// Auto-sell positions when bid price hits 99¢ — captures value before formal resolution
async function checkHighPricePositions(user, wallet) {
  try {
    const positions = await db.getBotPositions(user.id);
    if (!positions || positions.length === 0) return;

    for (const pos of positions) {
      const tokenId = pos.token_id;
      if (!tokenId) continue;
      const shares = parseFloat(pos.shares);
      if (shares <= 0) continue;

      try {
        const bid = await getCachedTokenBid(tokenId);
        if (bid < 0.99) continue;

        // Skip if entry price was already high — trader intentionally bought at 99¢
        // (e.g. very high confidence bet). Auto-sell is only for positions that resolved
        // after being bought at a lower price.
        const entryPrice = shares > 0 ? parseFloat(pos.usdc_spent) / shares : 0;
        if (entryPrice >= 0.90) {
          logger.info('Auto-sell skipped: entry price already high (intentional bet)', {
            userId: user.id, entryPrice: entryPrice.toFixed(3), bid, conditionId: pos.condition_id.slice(0, 10),
          });
          continue;
        }

        const posKey = `${pos.condition_id}_${pos.outcome}`;
        logger.trade('Auto-sell: bid hit 99¢', {
          userId: user.id, conditionId: pos.condition_id.slice(0, 10),
          outcome: pos.outcome, bid, shares,
        });

        const result = await placeOrder(wallet, tokenId, 'SELL', bid, shares);
        logger.trade('Auto-sell order placed', { userId: user.id, orderId: result.orderID });

        const usdcReceived = parseFloat((shares * bid).toFixed(4));
        const pnl          = parseFloat((usdcReceived - parseFloat(pos.usdc_spent)).toFixed(4));

        const market     = await getCachedMarket(pos.condition_id);
        const marketName = market?.question || market?.title || pos.condition_id;
        const marketSlug = market?.slug || market?.market_slug || null;

        await db.resolveBotPosition(user.id, pos.condition_id, pos.outcome, 'WON', pnl).catch(() => {});
        await db.resolveTradeOutcome(user.id, pos.condition_id, 'WON', pnl).catch(() => {});
        await db.saveTrade(user.id, {
          conditionId: pos.condition_id, marketName, marketSlug,
          outcome:    pos.outcome,
          side:       'REDEEM',
          size:       usdcReceived,
          price:      bid,
          orderId:    result.orderID || null,
          filledSize: shares,
          status:     'REDEEMED',
          skipReason: null,
          pnl,
          configId:   user.configId,
        }).catch(() => {});

        if (userBought[user.id]) userBought[user.id].delete(posKey);

        logger.trade('Auto-sell complete', { userId: user.id, pnl, usdcReceived });
      } catch (err) {
        logger.warn('Auto-sell failed', {
          userId: user.id, conditionId: pos.condition_id?.slice(0, 10),
          error: err.message.slice(0, 80),
        });
      }
    }
  } catch (err) {
    logger.warn('checkHighPricePositions error', { userId: user.id, error: err.message });
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

  // Decrypt key — deposit wallet handles its own approvals via relay service, EOA approvals not needed
  const privateKey = decryptPrivateKey(user.encryptedPrivateKey);
  const wallet = new ethers.Wallet(privateKey);
  approvedWallets.add(wallet.address); // mark as ready; deposit wallet manages its own allowances

  // Start redemption checker (once per user across all their configs)
  configToUserId[user.configId] = user.id;
  userConfigCount[user.id] = (userConfigCount[user.id] || 0) + 1;
  if (!redeemIntervals[user.id]) {
    redeemIntervals[user.id] = setInterval(() => {
      checkAndRedeemPositions(user, wallet).catch(e =>
        logger.warn('Redeem interval error', { userId: user.id, error: e.message })
      );
    }, REDEEM_INTERVAL_MS);
    logger.info('Redemption checker started', { userId: user.id });
  }

  // Register config in the shared poll for this target wallet
  activeEngines[user.configId] = targetWallet;
  if (!sharedPolls[targetWallet]) {
    lastActivityTs[targetWallet] = Date.now();
    logger.info('Activity cursor initialized', { targetWallet: targetWallet.slice(0,10), fromTs: lastActivityTs[targetWallet] });

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

          // Auto-sell check runs every tick for all users — TTL cache prevents excess API calls
          for (const [, { user: u, wallet: w }] of poll.users) {
            await checkHighPricePositions(u, w).catch(e =>
              logger.warn('High price check error', { userId: u?.id, error: e.message })
            );
          }

          if (fresh.length === 0) return;

          lastActivityTs[targetWallet] = Math.max(...fresh.map(a => a.timestamp));

          const opened = fresh.filter(a => a.side === 'BUY');
          const closed = fresh.filter(a => a.side === 'SELL');

          logger.info('New activity detected', { targetWallet: targetWallet.slice(0, 10), buys: opened.length, sells: closed.length });

          // Deduplicate signals by conditionId+outcome — skip if already copied in this poll
          const seenKeys = new Set();
          const deduped = opened.filter(s => {
            const k = `${s.conditionId}_${s.outcome}`;
            if (seenKeys.has(k)) return false;
            seenKeys.add(k); return true;
          });

          // Process signals for EACH user independently - fully isolated
          for (const [, { user: u, wallet: w }] of poll.users) {
            if (!approvedWallets.has(w.address)) approvedWallets.add(w.address);
            // Cached balance — 30s TTL prevents N calls per poll when no new activity
            const bal = await getWalletBalanceCached(u.walletAddress);
            if (bal < 1) {
              logger.warn('Skip all: insufficient balance', { userId: u.id, balance: bal });
              continue;
            }
            for (const signal of deduped) {
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

  // Stop redemption interval when user has no more active configs
  const userId = configToUserId[configId];
  if (userId) {
    userConfigCount[userId] = (userConfigCount[userId] || 1) - 1;
    if (userConfigCount[userId] <= 0) {
      clearInterval(redeemIntervals[userId]);
      delete redeemIntervals[userId];
      delete userConfigCount[userId];
      logger.info('Redemption checker stopped', { userId });
    }
    delete configToUserId[configId];
  }

  delete activeEngines[configId];
  logger.info('Engine stopped', { configId });
}

module.exports = { startCopyEngine, stopCopyEngine, placeOrder };
