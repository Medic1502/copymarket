require('dotenv').config();
const crypto = require('crypto');
const { ethers } = require('ethers');

const ALGORITHM = 'aes-256-gcm';
const CLOB_BASE = 'https://clob.polymarket.com';
const POLL_INTERVAL_MS = 15000;

const activeJobs = {};
const snapshots = {};

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

async function apiFetch(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API fetch failed: ${res.status} ${url}`);
  return res.json();
}

async function getPositions(walletAddress) {
  return apiFetch(`${CLOB_BASE}/positions?user=${walletAddress}`);
}

async function getMarket(conditionId) {
  return apiFetch(`${CLOB_BASE}/markets/${conditionId}`);
}

async function getBestPrice(conditionId, outcome) {
  const book = await apiFetch(`${CLOB_BASE}/book?token_id=${conditionId}_${outcome}`);
  return outcome === 'YES' ? parseFloat(book.asks[0]?.price ?? 0) : parseFloat(book.bids[0]?.price ?? 0);
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
  const raw = ratio * userBudget;
  const size = Math.min(Math.max(raw, 1.00), maxPerTrade);
  return parseFloat(size.toFixed(2));
}

function snapshotKey(pos) {
  return `${pos.conditionId}_${pos.outcome}`;
}

function diffPositions(prev, curr) {
  const opened = [];
  const closed = [];
  for (const pos of curr) {
    const key = snapshotKey(pos);
    const old = prev.get(key);
    if (!old) opened.push({ ...pos, type: 'NEW' });
    else if (pos.size > old.size + 0.01) opened.push({ ...pos, type: 'INCREASED' });
  }
  const currMap = new Map(curr.map(p => [snapshotKey(p), p]));
  for (const [key, pos] of prev) {
    const now = currMap.get(key);
    if (!now) closed.push({ ...pos, type: 'CLOSED' });
    else if (now.size < pos.size - 0.01) closed.push({ ...now, type: 'REDUCED' });
  }
  return { opened, closed };
}

async function startCopyEngine(user, targetWallet) {
  if (activeJobs[user.id]) {
    logger.warn('Engine already running', { userId: user.id });
    return;
  }
  logger.info('Starting copy engine', { userId: user.id, targetWallet });
  try {
    const initial = await getPositions(targetWallet);
    snapshots[targetWallet] = new Map(initial.map(p => [snapshotKey(p), p]));
    logger.info('Snapshot loaded', { userId: user.id, positions: initial.length });
  } catch (err) {
    logger.error('Snapshot failed', { userId: user.id, error: err.message });
  }

  const job = setInterval(async () => {
    let traderBalance = 0;
    try { traderBalance = await getWalletBalance(targetWallet); } catch {}
    try {
      const positions = await getPositions(targetWallet);
      const prev = snapshots[targetWallet] ?? new Map();
      const { opened, closed } = diffPositions(prev, positions);
      snapshots[targetWallet] = new Map(positions.map(p => [snapshotKey(p), p]));
      for (const signal of opened) {
        try {
          const size = scaleTrade({ traderBetSize: signal.size, traderTotalBalance: traderBalance, userBudget: user.budget, maxPerTrade: user.maxPerTrade });
          if (!size) continue;
          logger.trade('Would copy trade', { userId: user.id, conditionId: signal.conditionId, outcome: signal.outcome, size });
        } catch (err) { logger.error('Copy failed', { userId: user.id, error: err.message }); }
      }
      for (const signal of closed) {
        logger.trade('Would close position', { userId: user.id, conditionId: signal.conditionId });
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
    logger.info('Engine stopped', { userId });
  }
}

module.exports = { startCopyEngine, stopCopyEngine };