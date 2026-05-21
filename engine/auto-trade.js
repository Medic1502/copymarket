'use strict';
// Autonomous crypto "Up or Down" market trader
// Completely isolated from copy trading — own DB tables, own poll loop, own CLOB clients.
// Market discovery: scans platform-wide recent trades via data-api.polymarket.com/trades
// to find currently active "Up or Down" markets (Gamma/CLOB search endpoints don't expose them).

const { ethers } = require('ethers');
const db = require('../db');

const CLOB_BASE = 'https://clob.polymarket.com';
const DATA_BASE = 'https://data-api.polymarket.com';
const CHAIN_ID  = 137;
const POLL_MS   = 30_000;
const REDEEM_MS = 60_000;

const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const CTF_ADDR               = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PUSD_ADDRESS           = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF_COLLATERAL_ADAPTER = '0xAdA100Db00Ca00073811820692005400218FcE1f';
const NEG_RISK_ADAPTER       = '0xadA2005600Dec949baf300f4C6120000bDB6eAab';

// ── session state ────────────────────────────────────────────────────────
// One global poll loop shared across ALL active users.
// Market discovery + market info + book filter run ONCE per cycle.
// Only order placement is per-user (each user has their own wallet).
const sessions = {}; // userId → { wallet, config, entered: Set, redeemTimer }
let _globalPollTimer = null;

// ── helpers ───────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, { timeout: 10_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function log(tag, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), tag: `AT:${tag}`, msg, ...extra }));
}

// ── MARKET DISCOVERY via platform-wide trades ─────────────────────────────
// data-api.polymarket.com/trades returns recent trades across ALL markets,
// with market title and conditionId — this is how we find active Up/Down markets.
let _mktCache   = [];
let _mktCacheTs = 0;
const MKT_TTL   = 30_000; // 30s cache

async function fetchActiveUpOrDownMarkets() {
  if (Date.now() - _mktCacheTs < MKT_TTL && _mktCache.length) return _mktCache;

  const seen   = new Set();
  const result = [];

  try {
    const data  = await apiFetch(`${DATA_BASE}/trades?limit=100`);
    const trades = Array.isArray(data) ? data : (data.data || data.trades || []);

    for (const t of trades) {
      const title       = t.title || t.market || t.marketName || t.question || '';
      const conditionId = t.conditionId || t.condition_id || t.market_id || null;

      if (!conditionId || !title.toLowerCase().includes('up or down')) continue;
      if (seen.has(conditionId)) continue;
      seen.add(conditionId);

      result.push({ conditionId, title });
    }
  } catch (e) {
    log('discovery', 'trades fetch failed', { err: e.message.slice(0, 80) });
  }

  log('discovery', `Found ${result.length} active Up or Down markets`);
  _mktCache   = result;
  _mktCacheTs = Date.now();
  return result;
}

// ── MARKET INFO via CLOB (always works by conditionId) ───────────────────
const _mktInfoCache = {}; // conditionId → { data, ts }
const INFO_TTL      = 2 * 60_000;

async function getMarketInfo(conditionId) {
  const c = _mktInfoCache[conditionId];
  if (c && Date.now() - c.ts < INFO_TTL) return c.data;
  try {
    const data = await apiFetch(`${CLOB_BASE}/markets/${conditionId}`);
    _mktInfoCache[conditionId] = { data, ts: Date.now() };
    return data;
  } catch {
    return null;
  }
}

// ── FILTER: asset name ────────────────────────────────────────────────────
function passesAssetFilter(title, assets) {
  if (!assets?.length) return true;
  const t = title.toUpperCase();
  return assets.some(a => {
    const aliases = { BTC: ['BITCOIN','BTC'], ETH: ['ETHEREUM','ETH'], XRP: ['XRP'],
                      SOL: ['SOLANA','SOL'], BNB: ['BNB'], DOGE: ['DOGECOIN','DOGE'],
                      HYPE: ['HYPERLIQUID','HYPE'] };
    return (aliases[a] || [a]).some(alias => t.includes(alias));
  });
}

// ── FILTER: time in window ────────────────────────────────────────────────
function passesTimeFilter(mkt) {
  const start = mkt.game_start_time || mkt.startDate;
  const end   = mkt.end_date_iso    || mkt.endDate;
  if (!start || !end) return true;

  const startMs   = new Date(start).getTime();
  const endMs     = new Date(end).getTime();
  const nowMs     = Date.now();
  const totalMs   = endMs - startMs;
  const elapsedMs = nowMs - startMs;
  const remainMs  = endMs - nowMs;

  if (totalMs <= 0 || remainMs <= 0) return false;   // closed
  if (remainMs < 20_000)             return false;   // < 20s left
  if (elapsedMs / totalMs < 0.40)    return false;   // too early
  return true;
}

// ── FILTER: book depth + spread + live price ──────────────────────────────
async function passesBookFilter(tokenId, minPrice) {
  try {
    const book     = await apiFetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
    const bestAsk  = parseFloat(book.asks?.[0]?.price ?? 0);
    const bestBid  = parseFloat(book.bids?.[0]?.price ?? 0);
    const askDepth = (book.asks || []).reduce((s, o) => s + parseFloat(o.size || 0), 0);

    if (bestAsk < minPrice)                                  return { ok: false };
    if (askDepth < 30)                                       return { ok: false };
    if (bestBid > 0 && bestAsk > 0 && bestAsk - bestBid > 0.05) return { ok: false };
    return { ok: true, livePrice: bestAsk };
  } catch {
    return { ok: false };
  }
}

// ── CLOB CLIENT (own instance, no shared state with copy engine) ──────────
const _clobClients = {};

async function getClobClient(wallet) {
  if (_clobClients[wallet.address]) return _clobClients[wallet.address];

  const { ClobClient } = await import('@polymarket/clob-client-v2');
  const { createWalletClient, http } = await import('viem');
  const { polygon } = await import('viem/chains');
  const { privateKeyToAccount } = await import('viem/accounts');

  const pk       = wallet.privateKey.startsWith('0x') ? wallet.privateKey : '0x' + wallet.privateKey;
  const account  = privateKeyToAccount(pk);
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const signer   = new ethers.Wallet(wallet.privateKey, provider);
  const depositAddr = await getDepositWalletAddress(signer);

  const viemClient = createWalletClient({ account, chain: polygon, transport: http(process.env.POLYGON_RPC_URL) });
  const viemSigner = {
    address:       account.address,
    signTypedData: (domain, types, value) =>
      viemClient.signTypedData({ account, domain, types, primaryType: Object.keys(types)[0], message: value }),
    signMessage: (msg) =>
      viemClient.signMessage({ account, message: typeof msg === 'string' ? msg : { raw: msg } }),
  };

  const creds = await new ClobClient({ host: CLOB_BASE, chain: CHAIN_ID, signer: viemSigner, signatureType: 0 })
    .createOrDeriveApiCreds();

  const builderCode = process.env.POLY_BUILDER_CODE || null;
  const client = new ClobClient({
    host: CLOB_BASE, chain: CHAIN_ID, signer: viemSigner, creds,
    signatureType: 3, funderAddress: depositAddr,
    ...(builderCode ? { builderConfig: { builderCode } } : {}),
  });
  try { await client.updateBalanceAllowance(); } catch {}
  _clobClients[wallet.address] = client;
  return client;
}

const _depositCache = {};
async function getDepositWalletAddress(signer) {
  if (_depositCache[signer.address]) return _depositCache[signer.address];
  const factory = new ethers.Contract(
    DEPOSIT_WALLET_FACTORY,
    ['function getDepositAddress(address) view returns (address)'],
    signer.provider
  );
  const addr = await factory.getDepositAddress(signer.address);
  _depositCache[signer.address] = addr;
  return addr;
}

// ── PLACE FOK ORDER ───────────────────────────────────────────────────────
async function placeFOKOrder(wallet, tokenId, price, amount) {
  const { Side, OrderType } = await import('@polymarket/clob-client-v2');
  const client = await getClobClient(wallet);

  let tickSize = '0.01';
  try { tickSize = await client.getTickSize(tokenId); } catch {}
  let negRisk = false;
  try { negRisk = await client.getNegRisk(tokenId); } catch {}

  const decimals     = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
  const roundedPrice = parseFloat(price.toFixed(decimals));
  const sharesSize   = parseFloat((amount / roundedPrice).toFixed(4));
  if (sharesSize < 5) throw new Error(`Min 5 shares required (${sharesSize.toFixed(2)} at ${roundedPrice})`);

  const builderCode = process.env.POLY_BUILDER_CODE || null;
  const order = await client.createOrder(
    { tokenID: tokenId, price: roundedPrice, side: Side.BUY, size: sharesSize,
      ...(builderCode ? { builderCode } : {}) },
    { tickSize, negRisk }
  );
  const result = await client.postOrder(order, OrderType.FOK);
  if (result.errorMsg) throw new Error(`CLOB: ${result.errorMsg}`);
  return { result, sharesSize, roundedPrice };
}

// ── ON-CHAIN REDEEM ───────────────────────────────────────────────────────
async function redeemOnChain(signer, depositAddr, conditionId, isNegRisk) {
  const adapterAddr = isNegRisk ? NEG_RISK_ADAPTER : CTF_COLLATERAL_ADAPTER;
  const iface = new ethers.Interface([
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ]);
  const callData = iface.encodeFunctionData('redeemPositions',
    [PUSD_ADDRESS, '0x' + '0'.repeat(64), conditionId, [1n, 2n]]);
  const call = { target: adapterAddr, value: 0n, data: callData };
  try {
    const nonce    = await new ethers.Contract(depositAddr, ['function nonce() view returns (uint256)'], signer.provider).nonce();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const domain   = { name: 'DepositWallet', version: '1', chainId: CHAIN_ID, verifyingContract: depositAddr };
    const types    = {
      Call:  [{ name:'target',type:'address'  }, { name:'value',type:'uint256' }, { name:'data',type:'bytes'    }],
      Batch: [{ name:'wallet',type:'address'  }, { name:'nonce',type:'uint256' }, { name:'deadline',type:'uint256' }, { name:'calls',type:'Call[]' }],
    };
    const sig     = await signer.signTypedData(domain, types, { wallet: depositAddr, nonce: Number(nonce), deadline, calls: [call] });
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address','uint256','uint256','tuple(address,uint256,bytes)[]','bytes'],
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
  throw new Error('All redeem methods failed');
}

// ── RESOLUTION CHECK ──────────────────────────────────────────────────────
async function checkResolutions(userId, wallet) {
  try {
    const positions = await db.getAutoTradePositions(userId);
    if (!positions.length) return;

    const provider    = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const signer      = new ethers.Wallet(wallet.privateKey, provider);
    const depositAddr = await getDepositWalletAddress(signer);

    for (const pos of positions) {
      try {
        const mkt = await getMarketInfo(pos.condition_id);
        if (!mkt?.closed) continue;

        const tokens = mkt.tokens || [];
        const ourIdx = pos.outcome_index ?? tokens.findIndex(t => t.token_id === pos.token_id);

        // CTF balance guard — phantom position cleanup
        if (tokens.length > ourIdx && ourIdx >= 0) {
          const ctf    = new ethers.Contract(CTF_ADDR, ['function balanceOf(address,uint256) view returns (uint256)'], provider);
          const ctfBal = await ctf.balanceOf(depositAddr, BigInt(tokens[ourIdx].token_id)).catch(() => 0n);
          if (ctfBal === 0n) {
            log('redeem', 'No CTF tokens — FOK never filled, cleanup', { conditionId: pos.condition_id.slice(0,10) });
            await db.resolveAutoTradePosition(userId, pos.condition_id, pos.outcome, 'LOST', 0);
            continue;
          }
        }

        const isWinner  = ourIdx >= 0 && tokens[ourIdx]?.winner === true;
        const shares    = parseFloat(pos.shares);
        const usdcSpent = parseFloat(pos.usdc_spent);
        const pnl       = isWinner ? parseFloat((shares - usdcSpent).toFixed(4)) : -usdcSpent;

        await db.resolveAutoTradePosition(userId, pos.condition_id, pos.outcome, isWinner ? 'WON' : 'LOST', pnl);
        log('trade', isWinner ? 'WIN' : 'LOSS', { userId, conditionId: pos.condition_id.slice(0,10), pnl });

        if (isWinner) {
          const maticBal = await provider.getBalance(signer.address).catch(() => 0n);
          if (maticBal >= ethers.parseEther('0.001')) {
            redeemOnChain(signer, depositAddr, pos.condition_id, mkt.negRisk)
              .then(h  => log('redeem', 'confirmed', { txHash: h }))
              .catch(e => log('redeem', 'failed',    { err: e.message.slice(0,100) }));
          }
        }
      } catch (e) {
        log('redeem', 'pos error', { err: e.message.slice(0,100) });
      }
    }
  } catch (e) {
    log('redeem', 'checkResolutions error', { err: e.message.slice(0,100) });
  }
}

// ── PLACE ORDER FOR ONE USER (called in parallel fan-out) ─────────────────
async function placeForUser(userId, sess, conditionId, tokenId, tokenIdx, livePrice, mkt, title) {
  try {
    const entryKey = `${conditionId}_${tokenIdx}`;
    if (sess.entered.has(entryKey)) return;
    if (livePrice < sess.config.minPrice) return;

    // Balance check (per-user, not shared)
    const walletData = await db.getWalletByUserId(userId);
    const balance    = await db.getUSDCBalance(walletData.address).catch(() => 0);
    if (balance < sess.config.amount) {
      log('skip', 'Low balance', { userId, balance, needed: sess.config.amount });
      return;
    }

    const { result, sharesSize, roundedPrice } = await placeFOKOrder(sess.wallet, tokenId, livePrice, sess.config.amount);

    if (!result.orderID || result.status === 'CANCELLED') {
      log('trade', 'FOK not matched', { userId, conditionId: conditionId.slice(0,10) });
      return;
    }

    const outcomeLabel = mkt.tokens?.[tokenIdx]?.outcome || (tokenIdx === 0 ? 'Yes' : 'No');
    await db.upsertAutoTradePosition(userId, {
      conditionId,
      outcome:      outcomeLabel,
      marketName:   mkt.question || title,
      tokenId,
      outcomeIndex: tokenIdx,
      price:        roundedPrice,
      shares:       sharesSize,
      usdcSpent:    sess.config.amount,
    });

    sess.entered.add(entryKey);
    log('trade', 'FOK filled ✓', { userId, conditionId: conditionId.slice(0,10), shares: sharesSize, price: roundedPrice });
  } catch (e) {
    log('trade', 'FOK error', { userId, conditionId: conditionId.slice(0,10), err: e.message.slice(0,120) });
  }
}

// ── GLOBAL POLL LOOP — runs ONCE for all active users ──────────────────────
async function globalPoll() {
  const activeUsers = Object.entries(sessions);
  if (!activeUsers.length) return;

  try {
    // ① Discovery — one call for everyone
    const markets = await fetchActiveUpOrDownMarkets();
    log('poll', `Scanning ${markets.length} markets for ${activeUsers.length} user(s)`);

    for (const { conditionId, title } of markets) {
      try {
        // ② Market info — once per market
        const mkt = await getMarketInfo(conditionId);
        if (!mkt || mkt.closed) continue;

        // ③ Time filter — once per market
        if (!passesTimeFilter(mkt)) continue;

        const tokens = mkt.tokens || [];
        if (tokens.length < 2) continue;

        // ④ Find token at minPrice (use lowest configured minPrice to be inclusive)
        const lowestMin = Math.min(...activeUsers.map(([, s]) => s.config.minPrice));
        let targetIdx   = -1;
        let targetToken = null;

        for (let i = 0; i < tokens.length; i++) {
          if (parseFloat(tokens[i].price ?? 0) >= lowestMin) {
            targetIdx   = i;
            targetToken = tokens[i].token_id;
            break;
          }
        }
        if (targetIdx < 0 || !targetToken) continue;

        // ⑤ Book filter — once per token
        const bookResult = await passesBookFilter(targetToken, lowestMin);
        if (!bookResult.ok) continue;

        // ⑥ Fan-out: place orders for all eligible users in parallel
        await Promise.all(activeUsers.map(([userId, sess]) => {
          if (!passesAssetFilter(title, sess.config.assets)) return Promise.resolve();
          return placeForUser(userId, sess, conditionId, targetToken, targetIdx, bookResult.livePrice, mkt, title);
        }));

      } catch (e) {
        log('poll', 'market error', { conditionId: conditionId?.slice(0,10), err: e.message.slice(0,80) });
      }
    }
  } catch (e) {
    log('poll', 'globalPoll error', { err: e.message.slice(0,120) });
  }
}

// ── SESSION MANAGEMENT ────────────────────────────────────────────────────
async function startAutoTrade(userId) {
  if (sessions[userId]) return;

  const config = await db.getAutoTradeConfig(userId);
  if (!config) throw new Error('No auto trade config found');

  const walletData = await db.getWalletByUserId(userId);
  if (!walletData) throw new Error('No wallet found');

  const privateKey = db.decryptPrivateKey(walletData.encrypted_private_key);
  const wallet     = new ethers.Wallet(privateKey);

  sessions[userId] = {
    wallet,
    config: {
      amount:   parseFloat(config.amount),
      minPrice: parseFloat(config.min_price),
      duration: config.duration,
      assets:   config.assets,
    },
    entered:     new Set(),
    redeemTimer: setInterval(() => checkResolutions(userId, wallet).catch(
                   e => log('redeem', 'interval error', { err: e.message.slice(0,80) })), REDEEM_MS),
  };

  await db.setAutoTradeRunning(userId, true);
  log('session', 'started', { userId, totalActive: Object.keys(sessions).length });

  // Start the shared global poll loop if not already running
  if (!_globalPollTimer) {
    _globalPollTimer = setInterval(() => globalPoll().catch(
      e => log('poll', 'global interval error', { err: e.message.slice(0,80) })
    ), POLL_MS);
    log('poll', 'Global poll loop started');
    globalPoll().catch(() => {}); // immediate first run
  }
}

async function stopAutoTrade(userId) {
  const sess = sessions[userId];
  if (sess) {
    clearInterval(sess.redeemTimer);
    delete sessions[userId];
    const walletData = await db.getWalletByUserId(userId).catch(() => null);
    if (walletData?.address) delete _clobClients[walletData.address];
  }

  await db.setAutoTradeRunning(userId, false);
  log('session', 'stopped', { userId, remaining: Object.keys(sessions).length });

  // Stop global poll loop when no more active users
  if (Object.keys(sessions).length === 0 && _globalPollTimer) {
    clearInterval(_globalPollTimer);
    _globalPollTimer = null;
    log('poll', 'Global poll loop stopped — no active users');
  }
}

function isRunning(userId) { return !!sessions[userId]; }

async function restoreAutoTradeSessions() {
  try {
    const running = await db.getRunningAutoTradeUsers();
    for (const { user_id } of running) {
      await startAutoTrade(user_id).catch(e =>
        log('restore', 'failed', { userId: user_id, err: e.message.slice(0,80) })
      );
    }
    if (running.length) log('restore', `Restored ${running.length} auto trade session(s)`);
  } catch (e) {
    log('restore', 'error', { err: e.message.slice(0,80) });
  }
}

module.exports = { startAutoTrade, stopAutoTrade, isRunning, restoreAutoTradeSessions };
