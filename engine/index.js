require('dotenv').config();
const crypto = require('crypto');
// Polyfill Web Crypto for @polymarket/clob-client (required in Node 18)
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
const { ethers } = require('ethers');
const db = require('../db');

let _clobLib = null;
async function getClobLib() {
  if (!_clobLib) _clobLib = await import('@polymarket/clob-client');
  return _clobLib;
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

// ── POLYMARKET CLOB CLIENT ───────────────────────────────────────────────────
const clobClients = {}; // walletAddress -> ClobClient (initialized with creds)

async function getClobClient(wallet) {
  if (clobClients[wallet.address]) return clobClients[wallet.address];
  const { ClobClient } = await getClobLib();
  // @polymarket/clob-client checks for ethers v5 _signTypedData — add shim for ethers v6
  if (!wallet._signTypedData) {
    wallet._signTypedData = (domain, types, value) => wallet.signTypedData(domain, types, value);
  }
  const client = new ClobClient(CLOB_BASE, CHAIN_ID, wallet);
  try {
    const creds = await client.createOrDeriveApiKey();
    client.creds = creds;
    clobClients[wallet.address] = client;
    logger.info('ClobClient ready', { wallet: wallet.address.slice(0, 10) });
  } catch (err) {
    throw new Error(`ClobClient init failed: ${err.message}`);
  }
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

  const sharesSize = isBuy ? amount / price : amount;

  const order = await client.createOrder(
    { tokenID: tokenId, price, side: isBuy ? Side.BUY : Side.SELL, size: sharesSize },
    { tickSize, negRisk }
  );

  const result = await client.postOrder(order, OrderType.GTC);
  if (result.errorMsg) throw new Error(`CLOB rejected: ${result.errorMsg}`);
  return result;
}

// Process one signal for one user - completely isolated per user
async function processSignalForUser(user, wallet, signal, side) {
  try {
    if (side === 'BUY') {
      // Use tokenId from activity feed directly (most accurate)
      const tokenId = signal.tokenId || await getTokenId(signal.conditionId, signal.outcome);
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

      logger.trade('Placing BUY', { userId: user.id, conditionId: signal.conditionId.slice(0,10), price, usdc: usdcToSpend });
      const result = await placeOrder(wallet, tokenId, 'BUY', price, usdcToSpend);
      logger.trade('BUY result', { userId: user.id, status: result.status, orderId: result.orderID });

      logger.trade('BUY placed', { userId: user.id, orderId: result.orderID });
      const key = snapshotKey(signal);
      const prev = userBought[user.id]?.get(key) || { usdc: 0, shares: 0 };
      const newShares = usdcToSpend / price;
      userBought[user.id].set(key, { usdc: prev.usdc + usdcToSpend, shares: prev.shares + newShares });
      await db.upsertBotPosition(user.id, user.configId, signal.conditionId, signal.outcome, usdcToSpend, newShares).catch(() => {});
      await db.saveTrade(user.id, { conditionId: signal.conditionId, marketName: signal.conditionId, outcome: signal.outcome, side: 'BUY', size: usdcToSpend, price, orderId: result.orderID || null, filledSize: null, status: result.status || 'OPEN', skipReason: null, pnl: null, configId: user.configId });

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
