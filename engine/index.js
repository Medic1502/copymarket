require('dotenv').config();
const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../db');

const ALGORITHM = 'aes-256-gcm';
const CLOB_BASE = 'https://clob.polymarket.com';
const POLL_INTERVAL_MS = 15000;

// Polymarket CTF Exchange on Polygon Mainnet
const CTF_EXCHANGE = process.env.CTF_EXCHANGE_ADDRESS || '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

const DOMAIN = {
  name: 'CTFExchange',
  version: '1',
  chainId: 137,
  verifyingContract: CTF_EXCHANGE,
};

const ORDER_TYPES = {
  Order: [
    { name: 'salt',          type: 'uint256' },
    { name: 'maker',         type: 'address' },
    { name: 'signer',        type: 'address' },
    { name: 'taker',         type: 'address' },
    { name: 'tokenId',       type: 'uint256' },
    { name: 'makerAmount',   type: 'uint256' },
    { name: 'takerAmount',   type: 'uint256' },
    { name: 'expiration',    type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
    { name: 'feeRateBps',    type: 'uint256' },
    { name: 'side',          type: 'uint8'   },
    { name: 'signatureType', type: 'uint8'   },
  ],
};

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
  if (items.length > 0) {
    const sample = items[0];
    logger.info('Activity API sample', { wallet: walletAddress.slice(0,10), count: items.length, keys: Object.keys(sample).join(','), ts: sample.timestamp || sample.createdAt || sample.created_at });
  } else {
    logger.warn('Activity API returned empty', { wallet: walletAddress.slice(0,10) });
  }
  return items.map(a => ({
    conditionId: a.conditionId || a.condition_id || a.market,
    outcome:     a.outcome     || 'Yes',
    size:        parseFloat(a.usdcSize || a.usdc_size || a.cashSize || a.amount || 0),
    tokenId:     a.asset       || a.asset_id || a.tokenId || null,
    side:        (a.side || a.type || '').toUpperCase(),
    timestamp:   (() => { const t = parseInt(a.timestamp || a.createdAt || a.created_at || 0); return t < 1e11 ? t * 1000 : t; })(),
  })).filter(a => a.conditionId && (a.side === 'BUY' || a.side === 'SELL'));
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

const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged)
const USDC_ADDRESS   = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';   // native USDC
// Both exchange contracts need approval (standard + neg-risk markets)
const CTF_EXCHANGES = [
  process.env.CTF_EXCHANGE_ADDRESS       || '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  process.env.CTF_NEG_RISK_ADDRESS       || '0xC5d563A36AE78145C45a50134d48A1215220f80a',
];

async function getWalletBalance(walletAddress) {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const abi = ['function balanceOf(address) view returns (uint256)'];
  const [rawE, rawN] = await Promise.all([
    new ethers.Contract(USDC_E_ADDRESS, abi, provider).balanceOf(walletAddress),
    new ethers.Contract(USDC_ADDRESS,   abi, provider).balanceOf(walletAddress),
  ]);
  return parseFloat(ethers.formatUnits(rawE + rawN, 6));
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

// ── POLYMARKET L2 AUTH ────────────────────────────────────────────────────────
// Flow: L1 signature → create API key → HMAC-sign each request with that key
const apiKeyCache = {}; // walletAddress -> { apiKey, secret, passphrase }

async function l1Headers(wallet, nonce) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const n = nonce.toString();
  const signature = await wallet.signMessage(timestamp + n);
  return {
    'Content-Type':   'application/json',
    'POLY_ADDRESS':   wallet.address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE':     n,
  };
}

async function getOrCreateApiKey(wallet) {
  if (apiKeyCache[wallet.address]) return apiKeyCache[wallet.address];
  const { default: fetch } = await import('node-fetch');

  // Step 1: get current nonce for this wallet
  let nonce = 0;
  try {
    const nonceRes = await fetch(`${CLOB_BASE}/auth/nonce`, {
      headers: await l1Headers(wallet, 0),
    });
    if (nonceRes.ok) {
      const nonceData = await nonceRes.json();
      nonce = nonceData.nonce ?? 0;
      logger.info('Got nonce', { wallet: wallet.address.slice(0, 10), nonce });
    }
  } catch (e) {
    logger.warn('Nonce fetch failed, using 0', { error: e.message });
  }

  // Step 2: create API key with the correct nonce
  const res = await fetch(`${CLOB_BASE}/auth/api-key`, {
    method: 'POST',
    headers: await l1Headers(wallet, nonce),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API key creation failed: ${JSON.stringify(data)}`);
  apiKeyCache[wallet.address] = data;
  logger.info('API key created', { wallet: wallet.address.slice(0, 10), nonce });
  return data;
}

function hmacSign(secret, timestamp, method, path, body = '') {
  const message = `${timestamp}${method}${path}${body}`;
  const key = Buffer.from(secret, 'base64');
  return crypto.createHmac('sha256', key).update(message).digest('base64');
}

async function getAuthHeaders(wallet, method = 'POST', path = '/order', body = '') {
  let creds;
  try {
    creds = await getOrCreateApiKey(wallet);
  } catch (err) {
    logger.warn('API key fetch failed, retrying fresh', { error: err.message });
    delete apiKeyCache[wallet.address];
    creds = await getOrCreateApiKey(wallet);
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = hmacSign(creds.secret, timestamp, method, path, body);
  return {
    'Content-Type':    'application/json',
    'POLY_ADDRESS':    wallet.address,
    'POLY_SIGNATURE':  sig,
    'POLY_TIMESTAMP':  timestamp,
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.passphrase,
  };
}

// FIX 2 + placeOrder update:
// side: 0 = BUY, 1 = SELL
// amount: USDC to spend (BUY), shares to sell (SELL with isShares=true), or USDC value (SELL fallback)
// isShares: when true and side=SELL, amount is treated as number of shares
async function placeOrder(wallet, tokenId, side, price, amount, isShares = false) {
  const { default: fetch } = await import('node-fetch');

  const salt = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const isBuy = side === 0;

  let makerAmount, takerAmount;
  if (isBuy) {
    // amount = USDC to spend
    makerAmount = BigInt(Math.round(amount * 1e6));
    takerAmount = BigInt(Math.round((amount / price) * 1e6));
  } else if (isShares) {
    // amount = shares to sell
    makerAmount = BigInt(Math.round(amount * 1e6));
    takerAmount = BigInt(Math.round(amount * price * 1e6));
  } else {
    // amount = USDC value (fallback)
    makerAmount = BigInt(Math.round((amount / price) * 1e6));
    takerAmount = BigInt(Math.round(amount * 1e6));
  }

  const orderData = {
    salt,
    maker:         wallet.address,
    signer:        wallet.address,
    taker:         '0x0000000000000000000000000000000000000000',
    tokenId:       BigInt(tokenId),
    makerAmount,
    takerAmount,
    expiration:    0n,
    nonce:         0n,
    feeRateBps:    0n,
    side,
    signatureType: 0,
  };

  const signature = await wallet.signTypedData(DOMAIN, ORDER_TYPES, orderData);

  const body = {
    order: {
      salt:          salt.toString(),
      maker:         wallet.address,
      signer:        wallet.address,
      taker:         '0x0000000000000000000000000000000000000000',
      tokenId:       tokenId.toString(),
      makerAmount:   makerAmount.toString(),
      takerAmount:   takerAmount.toString(),
      expiration:    '0',
      nonce:         '0',
      feeRateBps:    '0',
      side,
      signatureType: 0,
    },
    signature,
    owner:     wallet.address,
    orderType: 'GTC',
  };

  const bodyStr = JSON.stringify(body);
  const headers = await getAuthHeaders(wallet, 'POST', '/order', bodyStr);
  const res = await fetch(`${CLOB_BASE}/order`, {
    method:  'POST',
    headers,
    body:    bodyStr,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CLOB rejected: ${res.status} ${text.slice(0, 300)}`);
  }

  return res.json();
}

// Process one signal for one user - completely isolated per user
async function processSignalForUser(user, wallet, signal, side) {
  try {
    if (side === 'BUY') {
      if (signal.size < user.minTraderBet || signal.size > user.maxTraderBet) {
        logger.warn('Skip: bet size out of range', { userId: user.id, size: signal.size, min: user.minTraderBet, max: user.maxTraderBet });
        return;
      }
      if (user.followMode === 'initial_only' && signal.type === 'INCREASED') return;

      const tokenId = signal.tokenId || await getTokenId(signal.conditionId, signal.outcome);
      if (!tokenId) {
        logger.warn('Skip: tokenId not found', { userId: user.id, conditionId: signal.conditionId });
        return;
      }

      // Fetch market info once for name + category
      const market = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`).catch(() => null);
      const marketName = market?.question || market?.title || market?.market_slug || signal.conditionId;

      if (user.categories?.length > 0) {
        const gamma = await apiFetch(`https://gamma-api.polymarket.com/markets?conditionIds=${signal.conditionId}`).catch(() => null);
        const gm = Array.isArray(gamma) ? gamma[0] : null;
        const cat = gm?.category || gm?.tags?.join(' ') || market?.category || market?.market_type || '';
        if (!user.categories.some(c => cat.toLowerCase().includes(c.toLowerCase()))) {
          logger.warn('Skip: category mismatch', { userId: user.id, marketCat: cat, userCats: user.categories });
          return;
        }
      }

      const price = await getBestPrice(tokenId, 0);
      if (!price || price <= 0 || price >= 1) {
        logger.warn('Skip: invalid price', { userId: user.id, price });
        return;
      }
      if (price < user.minSharePrice || price > user.maxSharePrice) {
        logger.warn('Skip: price out of range', { userId: user.id, price, min: user.minSharePrice, max: user.maxSharePrice });
        return;
      }

      const size = calcTradeSize(user, signal);

      const balance = await getWalletBalance(user.walletAddress);
      if (balance < size) {
        logger.warn('Skipping BUY - low balance', { userId: user.id, balance, needed: size });
        return;
      }

      logger.trade('Placing BUY', { userId: user.id, conditionId: signal.conditionId, size, price });
      const result = await placeOrder(wallet, tokenId, 0, price, size);
      logger.trade('BUY placed', { userId: user.id, orderId: result.orderID });

      const key = snapshotKey(signal);
      const prev = userBought[user.id]?.get(key) || { usdc: 0, shares: 0 };
      const newShares = size / price;
      userBought[user.id].set(key, { usdc: prev.usdc + size, shares: prev.shares + newShares });
      await db.upsertBotPosition(user.id, user.configId, signal.conditionId, signal.outcome, size, newShares).catch(() => {});
      await db.saveTrade(user.id, { conditionId: signal.conditionId, marketName, outcome: signal.outcome, side: 'BUY', size, price, orderId: result.orderID || null, filledSize: null, status: result.status || 'PENDING', skipReason: null, pnl: null, configId: user.configId });

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
      const result = await placeOrder(wallet, tokenId, 1, price, sharesToSell, true);
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
  await ensureApprovals(wallet);

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
            if (!approvedWallets.has(w.address)) await ensureApprovals(w);
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
