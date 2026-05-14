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
// FIX 2: track { usdc, shares } instead of just a number
const userBought = {}; // { userId: Map<key, { usdc, shares }> }

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

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// Both exchange contracts need approval (standard + neg-risk markets)
const CTF_EXCHANGES = [
  process.env.CTF_EXCHANGE_ADDRESS       || '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  process.env.CTF_NEG_RISK_ADDRESS       || '0xC5d563A36AE78145C45a50134d48A1215220f80a',
];

async function getWalletBalance(walletAddress) {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const abi = ['function balanceOf(address) view returns (uint256)'];
  const contract = new ethers.Contract(USDC_ADDRESS, abi, provider);
  const raw = await contract.balanceOf(walletAddress);
  return parseFloat(ethers.formatUnits(raw, 6));
}

// Approve CTF Exchange contracts to spend USDC - called once when engine starts
async function ensureApprovals(wallet) {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const walletWithProvider = wallet.connect(provider);
  const abi = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ];
  const usdc = new ethers.Contract(USDC_ADDRESS, abi, walletWithProvider);
  const threshold = ethers.parseUnits('1000', 6); // re-approve if below $1000

  for (const exchange of CTF_EXCHANGES) {
    try {
      const allowance = await usdc.allowance(wallet.address, exchange);
      if (allowance < threshold) {
        logger.info('Approving USDC for exchange', { exchange, wallet: wallet.address });
        const tx = await usdc.approve(exchange, ethers.MaxUint256);
        await tx.wait();
        logger.info('USDC approved', { exchange, txHash: tx.hash });
      } else {
        logger.info('USDC already approved', { exchange });
      }
    } catch (err) {
      logger.warn('Approval failed (may lack MATIC for gas)', { exchange, error: err.message });
    }
  }
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

  // Load persisted positions from DB so sells survive server restarts
  if (!userBought[user.id]) {
    userBought[user.id] = new Map();
    try {
      const saved = await db.getBotPositions(user.id);
      for (const p of saved) {
        const key = `${p.condition_id}_${p.outcome}`;
        userBought[user.id].set(key, { usdc: parseFloat(p.usdc_spent), shares: parseFloat(p.shares) });
      }
      logger.info('Loaded persisted positions', { userId: user.id, count: saved.length });
    } catch (err) {
      logger.warn('Could not load persisted positions', { userId: user.id, error: err.message });
    }
  }

  try {
    const initial = await getPositions(targetWallet);
    // FIX 1: use composite key to avoid collision when two users copy the same trader
    snapshots[`${user.id}_${targetWallet}`] = new Map(initial.map(p => [snapshotKey(p), p]));
    logger.info('Snapshot loaded', { userId: user.id, positions: initial.length });
  } catch (err) {
    logger.error('Snapshot failed', { userId: user.id, error: err.message });
  }

  const privateKey = decryptPrivateKey(user.encryptedPrivateKey);
  const wallet     = new ethers.Wallet(privateKey);

  // One-time USDC approval for both CTF Exchange contracts
  await ensureApprovals(wallet);

  // FIX 3: polling lock to prevent concurrent poll executions for the same user
  const pollingLock = { active: false };

  const job = setInterval(async () => {
    // FIX 3: skip this tick if previous one is still running
    if (pollingLock.active) return;
    pollingLock.active = true;

    try {
      const positions = await getPositions(targetWallet);
      // FIX 1: use composite key for snapshot lookup and update
      const snapshotId = `${user.id}_${targetWallet}`;
      const prev = snapshots[snapshotId] ?? new Map();
      const { opened, closed } = diffPositions(prev, positions);
      snapshots[snapshotId] = new Map(positions.map(p => [snapshotKey(p), p]));

      // BUY - follow opened/increased positions
      for (const signal of opened) {
        try {
          // Check min/max trader bet
          if (signal.size < user.minTraderBet || signal.size > user.maxTraderBet) {
            logger.info('Skipping - trader bet out of range', { size: signal.size, min: user.minTraderBet, max: user.maxTraderBet });
            continue;
          }

          // Follow mode check (skip INCREASED if initial_only)
          if (user.followMode === 'initial_only' && signal.type === 'INCREASED') {
            logger.info('Skipping INCREASED - initial_only mode', { userId: user.id });
            continue;
          }

          const tokenId = signal.tokenId || await getTokenId(signal.conditionId, signal.outcome);
          if (!tokenId) {
            logger.warn('Skipping - token ID not found', { userId: user.id, conditionId: signal.conditionId });
            continue;
          }

          // FIX 5: fetch market info for category check AND capture market name
          let marketName = signal.conditionId;
          if (user.categories && user.categories.length > 0) {
            const market = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`).catch(() => null);
            if (market) marketName = market.question || market.title || market.market_slug || signal.conditionId;
            const cat = market?.category || market?.market_type || '';
            if (!user.categories.some(c => cat.toLowerCase().includes(c.toLowerCase()))) {
              logger.info('Skipping - category not followed', { category: cat });
              continue;
            }
          } else {
            // Still try to get market name even if not filtering by category
            const market = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`).catch(() => null);
            if (market) marketName = market.question || market.title || market.market_slug || signal.conditionId;
          }

          const price = await getBestPrice(tokenId, 0);
          if (!price || price <= 0 || price >= 1) {
            logger.warn('Skipping - invalid price', { userId: user.id, conditionId: signal.conditionId, price });
            continue;
          }

          // Share price check
          if (price < user.minSharePrice || price > user.maxSharePrice) {
            logger.info('Skipping - share price out of range', { price, min: user.minSharePrice, max: user.maxSharePrice });
            continue;
          }

          const size = calcTradeSize(user, signal);

          // FIX 4: check USDC balance before placing BUY order
          const userBalance = await getWalletBalance(user.walletAddress);
          if (userBalance < size) {
            logger.warn('Skipping BUY - insufficient USDC balance', { userId: user.id, balance: userBalance, needed: size });
            continue;
          }

          logger.trade('Placing BUY', { userId: user.id, conditionId: signal.conditionId, outcome: signal.outcome, size, price });

          const result = await placeOrder(wallet, tokenId, 0, price, size);

          logger.trade('BUY placed', { userId: user.id, orderId: result.orderID, status: result.status });

          // FIX 2: remember USDC spent and estimated shares received
          const key = snapshotKey(signal);
          const prev2 = userBought[user.id].get(key) || { usdc: 0, shares: 0 };
          const newShares = size / price;
          const newPos = { usdc: prev2.usdc + size, shares: prev2.shares + newShares };
          userBought[user.id].set(key, newPos);
          await db.upsertBotPosition(user.id, user.configId, signal.conditionId, signal.outcome, size, newShares).catch(() => {});

          await db.saveTrade(user.id, {
            conditionId: signal.conditionId,
            // FIX 5: use resolved market name
            marketName,
            outcome:     signal.outcome,
            side:        'BUY',
            size,
            price,
            orderId:     result.orderID || null,
            filledSize:  null,
            status:      result.status || 'PENDING',
            skipReason:  null,
            pnl:         null,
            configId:    user.configId,
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
            configId:    user.configId,
          });
        }
      }

      // SELL - follow closed/reduced positions
      for (const signal of closed) {
        try {
          const key = snapshotKey(signal);
          // FIX 2: use { usdc, shares } tracking
          const pos = userBought[user.id]?.get(key);
          if (!pos || pos.shares <= 0) continue; // we never bought this position, skip

          const tokenId = signal.tokenId || await getTokenId(signal.conditionId, signal.outcome);
          if (!tokenId) continue;

          const price = await getBestPrice(tokenId, 1);
          if (!price || price <= 0) continue;

          // FIX 5: resolve market name for SELL trade record
          let marketName = signal.conditionId;
          const sellMarket = await apiFetch(`${CLOB_BASE}/markets/${signal.conditionId}`).catch(() => null);
          if (sellMarket) marketName = sellMarket.question || sellMarket.title || sellMarket.market_slug || signal.conditionId;

          // FIX 2: sell by actual share count
          const sharesToSell = signal.type === 'CLOSED' ? pos.shares : pos.shares * 0.5;
          const expectedUsdc = sharesToSell * price;

          logger.trade('Placing SELL', { userId: user.id, conditionId: signal.conditionId, outcome: signal.outcome, sharesToSell, price });

          // FIX 2: pass isShares=true so placeOrder uses share-based amounts
          const result = await placeOrder(wallet, tokenId, 1, price, sharesToSell, true);

          logger.trade('SELL placed', { userId: user.id, orderId: result.orderID, status: result.status });

          if (signal.type === 'CLOSED') {
            userBought[user.id].delete(key);
            await db.deleteBotPosition(user.id, signal.conditionId, signal.outcome).catch(() => {});
          } else {
            const remaining = { usdc: pos.usdc * 0.5, shares: pos.shares - sharesToSell };
            userBought[user.id].set(key, remaining);
            await db.upsertBotPosition(user.id, user.configId, signal.conditionId, signal.outcome, -sharesToSell * price, -sharesToSell).catch(() => {});
          }

          await db.saveTrade(user.id, {
            conditionId: signal.conditionId,
            // FIX 5: use resolved market name for SELL
            marketName,
            outcome:     signal.outcome,
            side:        'SELL',
            size:        expectedUsdc,
            price,
            orderId:     result.orderID || null,
            filledSize:  null,
            status:      result.status || 'PENDING',
            skipReason:  null,
            pnl:         null,
            configId:    user.configId,
          });
        } catch (err) {
          logger.error('SELL failed', { userId: user.id, conditionId: signal.conditionId, error: err.message });
        }
      }
    } catch (err) {
      logger.error('Poll failed', { userId: user.id, error: err.message });
    } finally {
      // FIX 3: always release the lock, even on error
      pollingLock.active = false;
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
