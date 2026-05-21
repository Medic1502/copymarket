'use strict';
// Autonomous crypto "Up or Down" market trader
// Watches the same trader wallets the user is already copying via copy_configs.
// When those traders place "Up or Down" trades at >= minPrice, auto-trade
// applies its own filters (time-in-window, book depth, spread) and places a FOK order.
// Completely isolated DB tables — zero coupling to copy trading logic.

const { ethers } = require('ethers');
const db = require('../db');

const CLOB_BASE  = 'https://clob.polymarket.com';
const DATA_BASE  = 'https://data-api.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CHAIN_ID   = 137;
const POLL_MS    = 20_000;   // check every 20s (slightly faster than copy engine)
const REDEEM_MS  = 60_000;

const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const CTF_ADDR               = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PUSD_ADDRESS           = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF_COLLATERAL_ADAPTER = '0xAdA100Db00Ca00073811820692005400218FcE1f';
const NEG_RISK_ADAPTER       = '0xadA2005600Dec949baf300f4C6120000bDB6eAab';

// ── per-user session state ────────────────────────────────────────────────
// userId → { pollTimer, redeemTimer, entered: Set<conditionId_outcomeIdx> }
const sessions = {};

// ── activity cursors ──────────────────────────────────────────────────────
// userId → { walletAddr → lastTimestamp }
const activityCursors = {};

// ── helpers ───────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, { timeout: 10_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function log(tag, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), tag: `AT:${tag}`, msg, ...extra }));
}

// ── ACTIVITY: same source as copy engine, works reliably ─────────────────
async function getRecentActivity(walletAddr) {
  const data  = await apiFetch(`${DATA_BASE}/activity?user=${walletAddr}&limit=20`);
  const items = Array.isArray(data) ? data : (data.data || data.activity || []);
  return items.map(a => {
    const usdcSize = parseFloat(a.usdcSize || a.usdc_size || a.cashSize || a.amount || 0);
    const shares   = parseFloat(a.size || a.shares || 0);
    const price    = parseFloat(a.price || a.outcome_price || (shares > 0 ? usdcSize / shares : 0));
    const ts       = parseInt(a.timestamp || a.createdAt || a.created_at || 0);
    return {
      conditionId:  a.conditionId || a.condition_id || a.market,
      outcome:      a.outcome     || 'Yes',
      outcomeIndex: a.outcomeIndex ?? a.outcome_index ?? null,
      usdcSize,
      shares,
      price,
      tokenId:     a.asset || a.asset_id || a.tokenId || null,
      side:        (a.side || a.type || '').toUpperCase(),
      timestamp:   ts < 1e11 ? ts * 1000 : ts,
      marketName:  a.title || a.market_name || a.question || null,
    };
  }).filter(a => a.conditionId && a.side === 'BUY');
}

// ── MARKET INFO via CLOB (by conditionId — always works) ──────────────────
const _mktInfoCache = {}; // conditionId → { data, ts }
const MKT_TTL = 2 * 60_000;

async function getMarketInfo(conditionId) {
  const c = _mktInfoCache[conditionId];
  if (c && Date.now() - c.ts < MKT_TTL) return c.data;
  try {
    const data = await apiFetch(`${CLOB_BASE}/markets/${conditionId}`);
    _mktInfoCache[conditionId] = { data, ts: Date.now() };
    return data;
  } catch {
    return null;
  }
}

// ── CURRENT BEST ASK from CLOB book ──────────────────────────────────────
async function getLiveBook(tokenId) {
  try {
    return await apiFetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
  } catch { return null; }
}

// ── FILTER: is this an "Up or Down" crypto market? ───────────────────────
function isUpOrDownMarket(activity, assets) {
  const name = (activity.marketName || activity.conditionId || '').toLowerCase();
  if (!name.includes('up or down')) return false;
  if (!assets?.length) return true;
  return assets.some(a => name.includes(a.toLowerCase()) ||
    name.includes({ BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana',
                    XRP: 'xrp', BNB: 'bnb', DOGE: 'dogecoin', HYPE: 'hyperliquid' }[a] || a.toLowerCase())
  );
}

// ── FILTER: time in window (>40% elapsed, >20s remaining) ─────────────────
function passesTimeFilter(market) {
  const start = market.game_start_time || market.startDate;
  const end   = market.end_date_iso    || market.endDate;
  if (!start || !end) return true; // unknown dates → don't block

  const startMs    = new Date(start).getTime();
  const endMs      = new Date(end).getTime();
  const nowMs      = Date.now();
  const totalMs    = endMs - startMs;
  const elapsedMs  = nowMs - startMs;
  const remainMs   = endMs - nowMs;

  if (totalMs <= 0 || remainMs <= 0) return false;
  if (remainMs < 20_000)             return false;
  if (elapsedMs / totalMs < 0.40)    return false;
  return true;
}

// ── FILTER: book depth + spread ───────────────────────────────────────────
function passesBookFilter(book, minPrice) {
  if (!book) return false;
  const bestAsk  = parseFloat(book.asks?.[0]?.price ?? 0);
  const bestBid  = parseFloat(book.bids?.[0]?.price ?? 0);
  const askDepth = (book.asks || []).reduce((s, o) => s + parseFloat(o.size || 0), 0);
  if (bestAsk < minPrice)                             return false; // price no longer at threshold
  if (askDepth < 30)                                  return false; // thin ask side
  if (bestBid > 0 && bestAsk > 0 && bestAsk - bestBid > 0.05) return false; // wide spread
  return true;
}

// ── CLOB CLIENT (isolated, no shared state with copy engine) ──────────────
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
    signTypedData: (domain, types, value) => viemClient.signTypedData({ account, domain, types, primaryType: Object.keys(types)[0], message: value }),
    signMessage:   (msg) => viemClient.signMessage({ account, message: typeof msg === 'string' ? msg : { raw: msg } }),
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
  if (result.errorMsg) throw new Error(`CLOB rejected: ${result.errorMsg}`);
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
      Call:  [{ name:'target',type:'address' }, { name:'value',type:'uint256' }, { name:'data',type:'bytes' }],
      Batch: [{ name:'wallet',type:'address' }, { name:'nonce',type:'uint256' }, { name:'deadline',type:'uint256' }, { name:'calls',type:'Call[]' }],
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

        const clobTokenIds  = mkt.tokens?.map(t => t.token_id) || [];
        const ourIdx        = pos.outcome_index ?? clobTokenIds.indexOf(pos.token_id);

        // CTF balance guard — catch any phantom positions
        if (clobTokenIds.length > ourIdx && ourIdx >= 0) {
          const ctf    = new ethers.Contract(CTF_ADDR, ['function balanceOf(address,uint256) view returns (uint256)'], provider);
          const ctfBal = await ctf.balanceOf(depositAddr, BigInt(clobTokenIds[ourIdx])).catch(() => 0n);
          if (ctfBal === 0n) {
            log('redeem', 'No CTF tokens — FOK never filled, cleaning up', { conditionId: pos.condition_id.slice(0,10) });
            await db.resolveAutoTradePosition(userId, pos.condition_id, pos.outcome, 'LOST', 0);
            continue;
          }
        }

        const isWinner = ourIdx >= 0 && mkt.tokens?.[ourIdx]?.winner === true;
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

// ── MAIN POLL LOOP ────────────────────────────────────────────────────────
async function pollMarkets(userId, wallet, config) {
  try {
    // Get the target wallets from the user's copy configs (those traders trade these markets)
    const copyConfigs   = await db.getCopyConfig(userId);
    const targetWallets = copyConfigs.filter(c => c.is_active).map(c => c.target_wallet);

    if (!targetWallets.length) {
      log('poll', 'No active copy configs to watch — add a trader first', { userId });
      return;
    }

    const sess = sessions[userId];
    if (!activityCursors[userId]) activityCursors[userId] = {};

    for (const targetWallet of targetWallets) {
      try {
        const activities = await getRecentActivity(targetWallet);
        const lastTs     = activityCursors[userId][targetWallet] || 0;

        // Only fresh signals (newer than last seen)
        const fresh = activities.filter(a => a.timestamp > lastTs);
        if (!fresh.length) continue;

        activityCursors[userId][targetWallet] = Math.max(...fresh.map(a => a.timestamp));

        for (const activity of fresh) {
          const conditionId = activity.conditionId;
          if (!conditionId) continue;

          // Must be "Up or Down" market matching asset filter
          if (!isUpOrDownMarket(activity, config.assets)) continue;

          // Signal price must be >= minPrice (trader bought at 97¢+)
          if (activity.price < config.minPrice) continue;

          // Find the token ID for this outcome
          let tokenId = activity.tokenId;
          let outcomeIdx = activity.outcomeIndex;

          // Get full market info from CLOB (always works by conditionId)
          const mkt = await getMarketInfo(conditionId);
          if (!mkt) { log('poll', 'No market info', { conditionId: conditionId.slice(0,10) }); continue; }

          // If market is already closed, skip
          if (mkt.closed) continue;

          // Resolve tokenId and outcomeIdx if missing
          if (!tokenId && mkt.tokens?.length) {
            const tok = mkt.tokens.find(t => t.outcome?.toLowerCase() === activity.outcome?.toLowerCase());
            if (tok) { tokenId = tok.token_id; outcomeIdx = mkt.tokens.indexOf(tok); }
            else     { tokenId = mkt.tokens[0]?.token_id; outcomeIdx = 0; }
          }
          if (!tokenId) continue;

          // Dedup
          const entryKey = `${conditionId}_${outcomeIdx}`;
          if (sess?.entered?.has(entryKey)) continue;

          // Time filter — must be >40% into window
          if (!passesTimeFilter(mkt)) {
            log('filter', 'Time filter failed', { conditionId: conditionId.slice(0,10), market: mkt.question?.slice(0,40) });
            continue;
          }

          // Book filter — check LIVE price is still at threshold + depth + spread
          const book = await getLiveBook(tokenId);
          if (!passesBookFilter(book, config.minPrice)) {
            log('filter', 'Book filter failed', { conditionId: conditionId.slice(0,10) });
            continue;
          }

          // Balance check
          const walletData = await db.getWalletByUserId(userId);
          const balance    = await db.getUSDCBalance(walletData.address).catch(() => 0);
          if (balance < config.amount) {
            log('skip', 'Insufficient balance', { userId, balance, needed: config.amount });
            continue;
          }

          // All filters passed — place FOK order
          const livePrice = parseFloat(book.asks?.[0]?.price ?? activity.price);
          log('trade', 'Placing FOK', {
            userId, market: mkt.question?.slice(0,45),
            price: livePrice, amount: config.amount,
          });

          try {
            const { result, sharesSize, roundedPrice } = await placeFOKOrder(wallet, tokenId, livePrice, config.amount);

            if (!result.orderID || result.status === 'CANCELLED') {
              log('trade', 'FOK not matched — no liquidity at this price', { conditionId: conditionId.slice(0,10) });
              continue;
            }

            const outcomeLabel = mkt.tokens?.[outcomeIdx]?.outcome || activity.outcome || 'Yes';
            await db.upsertAutoTradePosition(userId, {
              conditionId,
              outcome:      outcomeLabel,
              marketName:   mkt.question,
              tokenId,
              outcomeIndex: outcomeIdx,
              price:        roundedPrice,
              shares:       sharesSize,
              usdcSpent:    config.amount,
            });

            sess?.entered?.add(entryKey);
            log('trade', 'FOK filled ✓', {
              userId, conditionId: conditionId.slice(0,10),
              shares: sharesSize, price: roundedPrice,
            });
          } catch (e) {
            log('trade', 'FOK error', { conditionId: conditionId.slice(0,10), err: e.message.slice(0,120) });
          }
        }
      } catch (e) {
        log('poll', 'wallet poll error', { wallet: targetWallet.slice(0,10), err: e.message.slice(0,80) });
      }
    }
  } catch (e) {
    log('poll', 'pollMarkets error', { err: e.message.slice(0,120) });
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
    entered:     new Set(),
    pollTimer:   setInterval(() => pollMarkets(userId, wallet, config).catch(
                   e => log('poll', 'interval error', { err: e.message.slice(0,80) })), POLL_MS),
    redeemTimer: setInterval(() => checkResolutions(userId, wallet).catch(
                   e => log('redeem', 'interval error', { err: e.message.slice(0,80) })), REDEEM_MS),
  };

  await db.setAutoTradeRunning(userId, true);
  log('session', 'started', { userId });

  // Run immediately on start
  pollMarkets(userId, wallet, config).catch(() => {});
}

async function stopAutoTrade(userId) {
  const sess = sessions[userId];
  if (sess) {
    clearInterval(sess.pollTimer);
    clearInterval(sess.redeemTimer);
    delete sessions[userId];
  }
  delete activityCursors[userId];
  // Clear this user's CLOB client so next start gets a fresh one
  const walletData = await db.getWalletByUserId(userId).catch(() => null);
  if (walletData) delete _clobClients[walletData.address];

  await db.setAutoTradeRunning(userId, false);
  log('session', 'stopped', { userId });
}

function isRunning(userId) {
  return !!sessions[userId];
}

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
