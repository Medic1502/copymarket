'use strict';
// Autonomous 5-min/15-min crypto "Up or Down" market trader
// Completely isolated from the copy trading engine — separate DB tables, separate loops

const { ethers } = require('ethers');
const db   = require('../db');
const { query } = require('../db/client');

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE  = 'https://clob.polymarket.com';
const CHAIN_ID   = 137;
const POLL_MS    = 30_000;          // check markets every 30s
const REDEEM_MS  = 60_000;         // check resolutions every 60s

const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const CTF_ADDR               = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PUSD_ADDRESS           = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF_COLLATERAL_ADAPTER = '0xAdA100Db00Ca00073811820692005400218FcE1f';
const NEG_RISK_ADAPTER       = '0xadA2005600Dec949baf300f4C6120000bDB6eAab';

// ── per-user session state ─────────────────────────────────────────────────
// userId → { pollTimer, redeemTimer, entered: Set<conditionId_outcome> }
const sessions = {};

// ── shared market discovery cache (across all users) ──────────────────────
let _mktCache = [];
let _mktCacheTs = 0;
const MKT_TTL = 60_000;

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

// ── MARKET DISCOVERY ──────────────────────────────────────────────────────
async function fetchActiveMarkets() {
  if (Date.now() - _mktCacheTs < MKT_TTL && _mktCache.length) return _mktCache;

  const found = [];
  const seen  = new Set();

  // Strategy 1: Gamma API active markets, page 1 (no cursor)
  for (const url of [
    `${GAMMA_BASE}/markets?active=true&closed=false&limit=200`,
    `${GAMMA_BASE}/markets?active=true&closed=false&limit=200&offset=200`,
  ]) {
    try {
      const data = await apiFetch(url);
      const arr  = Array.isArray(data) ? data : (data.markets || data.data || []);
      arr.forEach(m => {
        if (!seen.has(m.conditionId) && m.question?.toLowerCase().includes('up or down')) {
          seen.add(m.conditionId);
          found.push(m);
        }
      });
    } catch (e) {
      log('discovery', 'Gamma page failed', { url, err: e.message.slice(0, 80) });
    }
  }

  // Strategy 2: CLOB market search (catches what Gamma misses)
  try {
    const data = await apiFetch(`${CLOB_BASE}/markets?limit=200`);
    const arr  = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    arr.forEach(m => {
      if (!seen.has(m.condition_id) && m.question?.toLowerCase().includes('up or down') && m.active && !m.closed) {
        seen.add(m.condition_id);
        // normalise to Gamma shape
        found.push({
          conditionId:    m.condition_id,
          question:       m.question,
          startDate:      m.game_start_time,
          endDate:        m.end_date_iso,
          clobTokenIds:   m.tokens?.map(t => t.token_id),
          outcomePrices:  m.tokens?.map(t => String(t.price)),
          volume:         null,
          negRisk:        false,
        });
      }
    });
  } catch (e) {
    log('discovery', 'CLOB search failed', { err: e.message.slice(0, 80) });
  }

  log('discovery', `Found ${found.length} active Up or Down markets`);
  _mktCache   = found;
  _mktCacheTs = Date.now();
  return found;
}

// ── FILTER: time window ────────────────────────────────────────────────────
function passesTimeFilter(market, durationFilter) {
  const start = market.startDate || market.game_start_time;
  const end   = market.endDate   || market.end_date_iso;
  if (!start || !end) return true; // no date info → don't block

  const startMs   = new Date(start).getTime();
  const endMs     = new Date(end).getTime();
  const nowMs     = Date.now();
  const totalMs   = endMs - startMs;
  const elapsedMs = nowMs - startMs;
  const remainMs  = endMs - nowMs;

  if (totalMs <= 0 || remainMs <= 0) return false; // already closed
  if (remainMs < 20_000)             return false; // < 20s left → too late

  const pctElapsed = elapsedMs / totalMs;
  if (pctElapsed < 0.40)            return false; // entered too early

  // duration filter
  const durationMin = Math.round(totalMs / 60_000);
  if (durationFilter === '5'  && durationMin > 6)  return false;
  if (durationFilter === '15' && durationMin < 10) return false;

  return true;
}

// ── FILTER: CLOB book depth + spread ──────────────────────────────────────
async function passesBookFilter(tokenId) {
  try {
    const book = await apiFetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
    const bestAsk  = parseFloat(book.asks?.[0]?.price ?? 0);
    const bestBid  = parseFloat(book.bids?.[0]?.price ?? 0);
    const askDepth = (book.asks || []).reduce((s, o) => s + parseFloat(o.size || 0), 0);

    if (askDepth < 40)                      return false; // not enough sell liquidity
    if (bestBid > 0 && bestAsk > 0 && (bestAsk - bestBid) > 0.04) return false; // spread > 4¢
    return true;
  } catch {
    return false;
  }
}

// ── FILTER: volume ────────────────────────────────────────────────────────
function passesVolumeFilter(market) {
  const vol = parseFloat(market.volume ?? market.volumeNum ?? 0);
  return vol >= 200 || vol === 0; // 0 = unknown → don't block
}

// ── FILTER: asset ─────────────────────────────────────────────────────────
function passesAssetFilter(market, assets) {
  if (!assets?.length) return true;
  const q = (market.question || '').toUpperCase();
  return assets.some(a => q.includes(a.toUpperCase()));
}

// ── CLOB CLIENT (isolated copy, no shared state with copy engine) ──────────
const _clobClients = {}; // walletAddr → client

async function getClobClient(wallet) {
  if (_clobClients[wallet.address]) return _clobClients[wallet.address];

  const { ClobClient } = await import('@polymarket/clob-client-v2');
  const { createWalletClient, http } = await import('viem');
  const { polygon } = await import('viem/chains');
  const { privateKeyToAccount } = await import('viem/accounts');

  const pk      = wallet.privateKey.startsWith('0x') ? wallet.privateKey : '0x' + wallet.privateKey;
  const account = privateKeyToAccount(pk);
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const signer   = new ethers.Wallet(wallet.privateKey, provider);

  const depositAddr = await getDepositWalletAddress(signer);

  const viemClient = createWalletClient({ account, chain: polygon, transport: http(process.env.POLYGON_RPC_URL) });
  const viemSigner = {
    address: account.address,
    signTypedData: async (domain, types, value) => viemClient.signTypedData({ account, domain, types, primaryType: Object.keys(types)[0], message: value }),
    signMessage: async (msg) => viemClient.signMessage({ account, message: typeof msg === 'string' ? msg : { raw: msg } }),
  };

  const creds = await new ClobClient({ host: CLOB_BASE, chain: CHAIN_ID, signer: viemSigner, signatureType: 0 }).createOrDeriveApiCreds();

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

// ── DEPOSIT WALLET ────────────────────────────────────────────────────────
const _depositCache = {};
async function getDepositWalletAddress(signer) {
  if (_depositCache[signer.address]) return _depositCache[signer.address];
  const factoryAbi = ['function getDepositAddress(address owner) view returns (address)'];
  const factory = new ethers.Contract(DEPOSIT_WALLET_FACTORY, factoryAbi, signer.provider);
  const addr = await factory.getDepositAddress(signer.address);
  _depositCache[signer.address] = addr;
  return addr;
}

// ── PLACE FOK ORDER ───────────────────────────────────────────────────────
async function placeFOKOrder(wallet, tokenId, price, amount) {
  const { Side, OrderType } = await import('@polymarket/clob-client-v2');
  const client  = await getClobClient(wallet);

  let tickSize = '0.01';
  try { tickSize = await client.getTickSize(tokenId); } catch {}
  let negRisk = false;
  try { negRisk = await client.getNegRisk(tokenId); } catch {}

  const decimals    = tickSize.includes('.') ? tickSize.split('.')[1].length : 2;
  const roundedPrice = parseFloat(price.toFixed(decimals));
  const sharesSize   = parseFloat((amount / roundedPrice).toFixed(4));
  if (sharesSize < 5) throw new Error(`Too few shares: ${sharesSize.toFixed(2)}`);

  const builderCode = process.env.POLY_BUILDER_CODE || null;
  const order = await client.createOrder(
    { tokenID: tokenId, price: roundedPrice, side: Side.BUY, size: sharesSize, ...(builderCode ? { builderCode } : {}) },
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
  const data = iface.encodeFunctionData('redeemPositions', [
    PUSD_ADDRESS, '0x' + '0'.repeat(64), conditionId, [1n, 2n],
  ]);
  const call = { target: adapterAddr, value: 0n, data };

  try {
    const depositContract = new ethers.Contract(depositAddr, ['function nonce() view returns (uint256)'], signer.provider);
    const nonce    = await depositContract.nonce();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const domain   = { name: 'DepositWallet', version: '1', chainId: CHAIN_ID, verifyingContract: depositAddr };
    const types    = {
      Call:  [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
      Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
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
        const market = await apiFetch(`${GAMMA_BASE}/markets?conditionIds=${pos.condition_id}`)
          .then(d => Array.isArray(d) ? d[0] : null).catch(() => null);

        if (!market?.closed) continue;

        const clobTokenIds  = JSON.parse(market.clobTokenIds || '[]');
        const outcomePrices = JSON.parse(market.outcomePrices || '[]');
        const ourIdx        = pos.outcome_index ?? clobTokenIds.indexOf(pos.token_id);

        // Verify we have CTF tokens (guard against phantom positions)
        if (clobTokenIds.length > ourIdx && ourIdx >= 0) {
          const ctf    = new ethers.Contract(CTF_ADDR, ['function balanceOf(address,uint256) view returns (uint256)'], provider);
          const ctfBal = await ctf.balanceOf(depositAddr, BigInt(clobTokenIds[ourIdx])).catch(() => 0n);
          if (ctfBal === 0n) {
            log('redeem', 'No CTF tokens — FOK never filled, cleaning up', { conditionId: pos.condition_id.slice(0,10) });
            await db.resolveAutoTradePosition(userId, pos.condition_id, pos.outcome, 'LOST', 0);
            continue;
          }
        }

        const isWinner  = ourIdx >= 0 && parseFloat(outcomePrices[ourIdx] ?? 0) >= 0.99;
        const shares    = parseFloat(pos.shares);
        const usdcSpent = parseFloat(pos.usdc_spent);
        const pnl       = isWinner ? parseFloat((shares - usdcSpent).toFixed(4)) : -usdcSpent;

        await db.resolveAutoTradePosition(userId, pos.condition_id, pos.outcome, isWinner ? 'WON' : 'LOST', pnl);
        log('trade', isWinner ? 'WIN' : 'LOSS', { userId, conditionId: pos.condition_id.slice(0,10), pnl });

        if (isWinner) {
          const maticBal = await provider.getBalance(signer.address).catch(() => 0n);
          if (maticBal >= ethers.parseEther('0.001')) {
            redeemOnChain(signer, depositAddr, pos.condition_id, market.negRisk)
              .then(h => log('redeem', 'confirmed', { txHash: h }))
              .catch(e => log('redeem', 'failed', { err: e.message.slice(0,100) }));
          }
        }
      } catch (e) {
        log('redeem', 'position check error', { err: e.message.slice(0,100) });
      }
    }
  } catch (e) {
    log('redeem', 'checkResolutions error', { err: e.message.slice(0,100) });
  }
}

// ── MAIN POLL LOOP ────────────────────────────────────────────────────────
async function pollMarkets(userId, wallet, config) {
  try {
    const markets = await fetchActiveMarkets();

    for (const market of markets) {
      const conditionId = market.conditionId || market.condition_id;
      if (!conditionId) continue;

      // Asset filter
      if (!passesAssetFilter(market, config.assets)) continue;

      // Time filter
      if (!passesTimeFilter(market, config.duration)) continue;

      // Volume filter
      if (!passesVolumeFilter(market)) continue;

      // Price check — find outcome at >= minPrice
      const clobTokenIds  = JSON.parse(market.clobTokenIds || (market.clobTokenIds === undefined ? '[]' : market.clobTokenIds) || '[]');
      const outcomePrices = JSON.parse(market.outcomePrices || '[]');

      let targetIdx   = -1;
      let targetToken = null;
      let targetPrice = 0;

      for (let i = 0; i < outcomePrices.length; i++) {
        const p = parseFloat(outcomePrices[i]);
        if (p >= config.minPrice && p <= 1.0) {
          targetIdx   = i;
          targetToken = clobTokenIds[i];
          targetPrice = p;
          break;
        }
      }
      if (targetIdx < 0 || !targetToken) continue;

      // Dedup — don't enter same market twice
      const entryKey = `${conditionId}_${targetIdx}`;
      const sess = sessions[userId];
      if (sess?.entered?.has(entryKey)) continue;

      // Book depth + spread filter
      if (!await passesBookFilter(targetToken)) {
        log('filter', 'Book filter failed', { conditionId: conditionId.slice(0,10), token: targetToken.slice(0,10) });
        continue;
      }

      // Balance check
      const walletData = await db.getWalletByUserId(userId);
      const balance    = await db.getUSDCBalance(walletData.address).catch(() => 0);
      if (balance < config.amount) {
        log('skip', 'Insufficient balance', { userId, balance, needed: config.amount });
        continue;
      }

      // Place FOK order
      try {
        log('trade', 'Placing FOK', { userId, conditionId: conditionId.slice(0,10), price: targetPrice, amount: config.amount });
        const { result, sharesSize, roundedPrice } = await placeFOKOrder(wallet, targetToken, targetPrice, config.amount);

        if (!result.orderID || result.status === 'CANCELLED') {
          log('trade', 'FOK not matched — no liquidity', { conditionId: conditionId.slice(0,10) });
          continue;
        }

        // Record position
        const outcomes = market.outcomes ? JSON.parse(market.outcomes) : ['Yes', 'No'];
        const outcomeLabel = outcomes[targetIdx] || (targetIdx === 0 ? 'Yes' : 'No');
        await db.upsertAutoTradePosition(userId, {
          conditionId,
          outcome:      outcomeLabel,
          marketName:   market.question,
          tokenId:      targetToken,
          outcomeIndex: targetIdx,
          price:        roundedPrice,
          shares:       sharesSize,
          usdcSpent:    config.amount,
        });

        sess?.entered?.add(entryKey);
        log('trade', 'FOK filled — position recorded', { userId, conditionId: conditionId.slice(0,10), shares: sharesSize });
      } catch (e) {
        log('trade', 'FOK failed', { userId, conditionId: conditionId.slice(0,10), err: e.message.slice(0,120) });
      }
    }
  } catch (e) {
    log('poll', 'pollMarkets error', { err: e.message.slice(0,120) });
  }
}

// ── SESSION MANAGEMENT ────────────────────────────────────────────────────
async function startAutoTrade(userId) {
  if (sessions[userId]) return; // already running

  const config = await db.getAutoTradeConfig(userId);
  if (!config) throw new Error('No auto trade config found');

  const walletData = await db.getWalletByUserId(userId);
  if (!walletData) throw new Error('No wallet');

  const privateKey = db.decryptPrivateKey(walletData.encrypted_private_key);
  const wallet     = new ethers.Wallet(privateKey);

  sessions[userId] = {
    entered:     new Set(),
    pollTimer:   setInterval(() => pollMarkets(userId, wallet, config).catch(e =>
                   log('poll', 'interval error', { err: e.message.slice(0,80) })), POLL_MS),
    redeemTimer: setInterval(() => checkResolutions(userId, wallet).catch(e =>
                   log('redeem', 'interval error', { err: e.message.slice(0,80) })), REDEEM_MS),
  };

  await db.setAutoTradeRunning(userId, true);
  log('session', 'started', { userId });

  // First poll immediately
  pollMarkets(userId, wallet, config).catch(() => {});
}

async function stopAutoTrade(userId) {
  const sess = sessions[userId];
  if (sess) {
    clearInterval(sess.pollTimer);
    clearInterval(sess.redeemTimer);
    delete sessions[userId];
  }
  delete _clobClients[Object.keys(_clobClients).find(() => true)]; // reset client cache
  await db.setAutoTradeRunning(userId, false);
  log('session', 'stopped', { userId });
}

function isRunning(userId) {
  return !!sessions[userId];
}

// Restore sessions on server restart
async function restoreAutoTradeSessions() {
  try {
    const running = await db.getRunningAutoTradeUsers();
    for (const { user_id } of running) {
      await startAutoTrade(user_id).catch(e =>
        log('restore', 'failed to restore session', { userId: user_id, err: e.message.slice(0,80) })
      );
    }
    if (running.length) log('restore', `Restored ${running.length} auto trade session(s)`);
  } catch (e) {
    log('restore', 'restoreAutoTradeSessions error', { err: e.message.slice(0,80) });
  }
}

module.exports = { startAutoTrade, stopAutoTrade, isRunning, restoreAutoTradeSessions };
