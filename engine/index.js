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

const activeJobs = {};
const snapshots  = {};
// Track sizes we actually bought so we know what to sell
const userBought = {}; // { userId: Map<conditionId_outcome, usdcAmount> }

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

// Returns normalized positions: [{ conditionId, outcome, size, tokenId }]
async function getPositions(walletAddress) {
  const data = await apiFetch(`${CLOB_BASE}/positions?user=${walletAddress}`);
  const items = Array.isArray(data) ? data : (data.positions || data.data || []);
  return items.map(p => ({
    conditionId: p.conditionId || p.condition_id || p.market,
    outcome:     p.outcome     || 'Yes',
    size:        parseFloat(p.size || p.quantity || 0),
    tokenId:     p.asset_id   || p.token_id || p.tokenId || null,
  }));
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

async function getWalletBalance(walletAddress) {
  const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const abi = ['function balanceOf(address) view returns (uint256)'];
  const contract = new ethers.Contract(USDC, abi, provider);
  const raw = await contract.balanceOf(walletAddress);
  return parseFloat(ethers.formatUnits(raw, 6));
}

function scaleTrade({ traderBetSize, traderTotalBalance, userBudget, maxPerTrade }) {
  if (traderTotalBalance <= 0) return null;
  const ratio = traderBetSize / traderTotalBalance;
  const raw   = ratio * userBudget;
  const size  = Math.min(Math.max(raw, 1.00), maxPerTrade);
  return parseFloat(size.toFixed(2));
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

// L1 auth headers that Polymarket CLOB requires for order submission
async function getAuthHeaders(wallet) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await wallet.signMessage(timestamp);
  return {
    'Content-Type':   'application/json',
    'POLY_ADDRESS':   wallet.address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE':     '0',
  };
}

// side: 0 = BUY, 1 = SELL
// usdcAmount: USDC value of trade (for BUY: how much USDC to spend; for SELL: how much USDC value to receive)
async function placeOrder(wallet, tokenId, side, price, usdcAmount) {
  const { default: fetch } = await import('node-fetch');

  const salt = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const isBuy = side === 0;

  // BUY:  makerAmount = USDC to spend,  takerAmount = shares to receive
  // SELL: makerAmount = shares to give, takerAmount = USDC to receive
  const makerAmount = isBuy
    ? BigInt(Math.round(usdcAmount * 1e6))
    : BigInt(Math.round((usdcAmount / price) * 1e6));
  const takerAmount = isBuy
    ? BigInt(Math.round((usdcAmount / price) * 1e6))
    : BigInt(Math.round(usdcAmount * 1e6));

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

  const headers = await getAuthHeaders(wallet);
  const res = await fetch(`${CLOB_BASE}/order`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CLOB rejected: ${res.status} ${text.slice(0, 300)}`);
  }

  return res.json();
}

async function startCopyEngine(user, targetWallet) {
  if (activeJobs[user.id]) {
    logger.warn('Engine already running', { userId: user.id });
    return;
  }

  logger.info('Starting copy engine', { userId: user.id, targetWallet });

  if (!userBought[user.id]) userBought[user.id] = new Map();

  try {
    const initial = await getPositions(targetWallet);
    snapshots[targetWallet] = new Map(initial.map(p => [snapshotKey(p), p]));
    logger.info('Snapshot loaded', { userId: user.id, positions: initial.length });
  } catch (err) {
    logger.error('Snapshot failed', { userId: user.id, error: err.message });
  }

  const privateKey = decryptPrivateKey(user.encryptedPrivateKey);
  const wallet     = new ethers.Wallet(privateKey);

  const job = setInterval(async () => {
    try {
      // Daily loss limit check
      const todayLoss = await db.getTodayLoss(user.id);
      if (todayLoss >= user.dailyLossLimit) {
        logger.warn('Daily loss limit reached, stopping engine', { userId: user.id, todayLoss, limit: user.dailyLossLimit });
        stopCopyEngine(user.id);
        await db.setActive(user.id, false, 'Daily loss limit reached');
        return;
      }

      let traderBalance = 0;
      try { traderBalance = await getWalletBalance(targetWallet); } catch {}

      const positions = await getPositions(targetWallet);
      const prev = snapshots[targetWallet] ?? new Map();
      const { opened, closed } = diffPositions(prev, positions);
      snapshots[targetWallet] = new Map(positions.map(p => [snapshotKey(p), p]));

      // BUY - follow opened/increased positions
      for (const signal of opened) {
        try {
          const size = scaleTrade({
            traderBetSize:    signal.size,
            traderTotalBalance: traderBalance,
            userBudget:       user.budget,
            maxPerTrade:      user.maxPerTrade,
          });
          if (!size) continue;

          const tokenId = signal.tokenId || await getTokenId(signal.conditionId, signal.outcome);
          if (!tokenId) {
            logger.warn('Skipping - token ID not found', { userId: user.id, conditionId: signal.conditionId });
            continue;
          }

          const price = await getBestPrice(tokenId, 0);
          if (!price || price <= 0 || price >= 1) {
            logger.warn('Skipping - invalid price', { userId: user.id, conditionId: signal.conditionId, price });
            continue;
          }

          logger.trade('Placing BUY', { userId: user.id, conditionId: signal.conditionId, outcome: signal.outcome, size, price });

          const result = await placeOrder(wallet, tokenId, 0, price, size);

          logger.trade('BUY placed', { userId: user.id, orderId: result.orderID, status: result.status });

          // Remember how much USDC we spent so we can sell the right amount later
          const key = snapshotKey(signal);
          userBought[user.id].set(key, (userBought[user.id].get(key) || 0) + size);

          await db.saveTrade(user.id, {
            conditionId: signal.conditionId,
            marketName:  signal.conditionId,
            outcome:     signal.outcome,
            side:        'BUY',
            size,
            price,
            orderId:     result.orderID || null,
            filledSize:  null,
            status:      result.status || 'PENDING',
            skipReason:  null,
            pnl:         null,
          });
        } catch (err) {
          logger.error('BUY failed', { userId: user.id, conditionId: signal.conditionId, error: err.message });
          await db.saveTrade(user.id, {
            conditionId: signal.conditionId,
            marketName:  signal.conditionId,
            outcome:     signal.outcome,
            side:        'BUY',
            size:        0,
            price:       0,
            orderId:     null,
            filledSize:  null,
            status:      'FAILED',
            skipReason:  err.message.slice(0, 200),
            pnl:         null,
          });
        }
      }

      // SELL - follow closed/reduced positions
      for (const signal of closed) {
        try {
          const key      = snapshotKey(signal);
          const boughtAt = userBought[user.id]?.get(key);
          if (!boughtAt) continue; // we never bought this position, skip

          const tokenId = signal.tokenId || await getTokenId(signal.conditionId, signal.outcome);
          if (!tokenId) continue;

          const price = await getBestPrice(tokenId, 1);
          if (!price || price <= 0) continue;

          const sellUsdcValue = signal.type === 'CLOSED' ? boughtAt : boughtAt * 0.5;

          logger.trade('Placing SELL', { userId: user.id, conditionId: signal.conditionId, outcome: signal.outcome, sellUsdcValue, price });

          const result = await placeOrder(wallet, tokenId, 1, price, sellUsdcValue);

          logger.trade('SELL placed', { userId: user.id, orderId: result.orderID, status: result.status });

          if (signal.type === 'CLOSED') {
            userBought[user.id].delete(key);
          } else {
            userBought[user.id].set(key, boughtAt - sellUsdcValue);
          }

          await db.saveTrade(user.id, {
            conditionId: signal.conditionId,
            marketName:  signal.conditionId,
            outcome:     signal.outcome,
            side:        'SELL',
            size:        sellUsdcValue,
            price,
            orderId:     result.orderID || null,
            filledSize:  null,
            status:      result.status || 'PENDING',
            skipReason:  null,
            pnl:         null,
          });
        } catch (err) {
          logger.error('SELL failed', { userId: user.id, conditionId: signal.conditionId, error: err.message });
        }
      }
    } catch (err) {
      logger.error('Poll failed', { userId: user.id, error: err.message });
    }
  }, POLL_INTERVAL_MS);

  activeJobs[user.id] = job;
}

function stopCopyEngine(userId) {
  const job = activeJobs[userId];
  if (job) {
    clearInterval(job);
    delete activeJobs[userId];
    delete userBought[userId];
    logger.info('Engine stopped', { userId });
  }
}

module.exports = { startCopyEngine, stopCopyEngine };
