require('dotenv').config();
const bcrypt = require('bcrypt');
const { ethers } = require('ethers');
const { query } = require('./client');
const crypto = require('crypto');

const SALT_ROUNDS = 12;
const ALGORITHM = 'aes-256-gcm';

function encryptPrivateKey(privateKey) {
  const key = process.env.WALLET_ENCRYPTION_KEY;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptPrivateKey(encryptedStr) {
  const key = process.env.WALLET_ENCRYPTION_KEY;
  const [ivHex, authTagHex, encryptedHex] = encryptedStr.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

// USERS
async function createUser(email, password) {
  const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) throw new Error('EMAIL_TAKEN');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const res = await query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
    [email.toLowerCase(), passwordHash]
  );
  return res.rows[0];
}

async function getUserByEmail(email) {
  const res = await query('SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [email.toLowerCase()]);
  return res.rows[0] ?? null;
}

async function getUserById(id) {
  const res = await query('SELECT id, email, password_hash, created_at, is_active FROM users WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password_hash);
}

// WALLETS
async function createWalletForUser(userId) {
  const wallet = ethers.Wallet.createRandom();
  const encryptedKey      = encryptPrivateKey(wallet.privateKey);
  const encryptedMnemonic = wallet.mnemonic?.phrase ? encryptPrivateKey(wallet.mnemonic.phrase) : null;
  const res = await query(
    'INSERT INTO wallets (user_id, address, encrypted_private_key, encrypted_mnemonic) VALUES ($1, $2, $3, $4) RETURNING id, address, created_at',
    [userId, wallet.address, encryptedKey, encryptedMnemonic]
  );
  return res.rows[0];
}

async function getWalletByUserId(userId) {
  const res = await query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  return res.rows[0] ?? null;
}

async function getUSDCBalance(eoaAddress) {
  const USDC_E  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const USDC    = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
  const PUSD    = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // Polymarket v2 collateral
  const FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
  const IMPL    = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const abi = ['function balanceOf(address) view returns (uint256)'];

  let depositAddress = eoaAddress;
  try {
    const { deriveDepositWallet } = await import('@polymarket/builder-relayer-client');
    depositAddress = deriveDepositWallet(eoaAddress, FACTORY, IMPL);
  } catch {}

  const addresses = [eoaAddress, depositAddress];
  let total = 0n;
  for (const addr of addresses) {
    const bals = await Promise.all(
      [PUSD, USDC, USDC_E].map(t => new ethers.Contract(t, abi, provider).balanceOf(addr).catch(() => 0n))
    );
    total += bals.reduce((a, b) => a + b, 0n);
  }
  return parseFloat(ethers.formatUnits(total, 6));
}

// COPY CONFIGS
async function saveCopyConfig(userId, { targetWallet, nickname, notes, copyMode, copyPercentage, fixedAmount, minTraderBet, maxTraderBet, categories, followMode, minSharePrice, maxSharePrice, maxPositionSize }) {
  const res = await query(
    `INSERT INTO copy_configs (user_id, target_wallet, nickname, notes, copy_mode, copy_percentage, fixed_amount, min_trader_bet, max_trader_bet, categories, follow_mode, min_share_price, max_share_price, max_position_size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [userId, targetWallet, nickname||null, notes||null, copyMode||'percentage', copyPercentage||10, fixedAmount||10, minTraderBet??5, maxTraderBet??100000, categories||[], followMode||'all', minSharePrice??null, maxSharePrice??null, maxPositionSize??null]
  );
  return res.rows[0];
}

async function getCopyConfig(userId) {
  const res = await query('SELECT * FROM copy_configs WHERE user_id = $1', [userId]);
  return res.rows ?? [];
}

async function setConfigActive(configId, userId, isActive, pausedReason = null) {
  await query(
    'UPDATE copy_configs SET is_active = $3, paused_reason = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2',
    [configId, userId, isActive, pausedReason]
  );
}

async function getAllActiveConfigs() {
  const res = await query(`
    SELECT cc.*, w.address AS wallet_address, w.encrypted_private_key
    FROM copy_configs cc
    JOIN wallets w ON w.user_id = cc.user_id
    WHERE cc.is_active = TRUE
  `);
  return res.rows;
}

// TRADES
async function saveTrade(userId, trade) {
  const { conditionId, marketName, marketSlug, outcome, side, size, price, orderId, filledSize, status, skipReason, pnl, configId } = trade;
  const res = await query(
    `INSERT INTO trades (user_id, config_id, condition_id, market_name, market_slug, outcome, side, size, price, order_id, filled_size, status, skip_reason, pnl)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [userId, configId||null, conditionId, marketName, marketSlug||null, outcome, side, size, price, orderId, filledSize, status, skipReason, pnl]
  );
  if (pnl != null) await upsertDailyPnl(userId, pnl);
  return res.rows[0];
}

async function getTraderStats(configId) {
  const posRes = await query(
    `SELECT
       COUNT(*)                                                        AS total_trades,
       COALESCE(SUM(usdc_spent), 0)                                   AS total_invested,
       COALESCE(SUM(resolved_pnl), 0)                                 AS total_pnl,
       COUNT(*) FILTER (WHERE resolved_outcome='WON')                 AS wins,
       COUNT(*) FILTER (WHERE resolved_outcome='LOST')                AS losses,
       MAX(updated_at)                                                 AS last_trade_at
     FROM bot_positions WHERE config_id=$1 AND (shares > 0 OR resolved_outcome IS NOT NULL)`,
    [configId]
  );
  const row    = posRes.rows[0];
  const wins   = parseInt(row.wins)   || 0;
  const losses = parseInt(row.losses) || 0;
  return {
    totalTrades:   parseInt(row.total_trades)    || 0,
    totalPnl:      parseFloat(row.total_pnl)     || 0,
    totalInvested: parseFloat(row.total_invested) || 0,
    wins,
    losses,
    winRate:     wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : null,
    lastTradeAt: row.last_trade_at || null,
  };
}

async function upsertDailyPnl(userId, pnlDelta) {
  await query(
    `INSERT INTO daily_pnl (user_id, date, pnl, trades) VALUES ($1, CURRENT_DATE, $2, 1)
     ON CONFLICT (user_id, date) DO UPDATE SET pnl = daily_pnl.pnl + EXCLUDED.pnl, trades = daily_pnl.trades + 1`,
    [userId, pnlDelta]
  );
}

async function resolveTradeOutcome(userId, conditionId, status, pnl) {
  await query(
    `UPDATE trades SET status=$3, pnl=$4
     WHERE user_id=$1 AND condition_id=$2 AND side='BUY' AND status NOT IN ('FAILED','SKIPPED')`,
    [userId, conditionId, status, pnl]
  );
}

async function getRecentTrades(userId, limit = 20) {
  const res = await query(
    `SELECT * FROM trades WHERE user_id = $1 AND side != 'REDEEM' ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

async function getDashboardStats(userId) {
  const [resolvedRes, openRes] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(resolved_pnl), 0)                                                AS total_pnl,
         COALESCE(SUM(resolved_pnl) FILTER (WHERE updated_at::date = CURRENT_DATE), 0) AS today_pnl,
         COUNT(*) FILTER (WHERE resolved_outcome='WON')                                AS wins,
         COUNT(*) FILTER (WHERE resolved_outcome='LOST')                               AS losses,
         COUNT(*) FILTER (WHERE resolved_outcome IS NOT NULL)                          AS resolved_count
       FROM bot_positions WHERE user_id=$1 AND resolved_outcome IS NOT NULL`,
      [userId]
    ),
    query(
      `SELECT
         COALESCE(SUM(usdc_spent), 0) AS open_invested,
         json_agg(json_build_object('token_id', token_id, 'shares', shares)) AS positions
       FROM bot_positions WHERE user_id=$1 AND shares > 0`,
      [userId]
    ),
  ]);
  const row    = resolvedRes.rows[0];
  const wins   = parseInt(row.wins)   || 0;
  const losses = parseInt(row.losses) || 0;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
  return {
    totalPnl:      parseFloat(row.total_pnl)          || 0,
    todayPnl:      parseFloat(row.today_pnl)          || 0,
    resolvedCount: parseInt(row.resolved_count)       || 0,
    openInvested:  parseFloat(openRes.rows[0].open_invested) || 0,
    openPositions: openRes.rows[0].positions || [],
    winRate,
  };
}

// BOT POSITIONS (persisted so sells survive server restarts)
async function upsertBotPosition(userId, configId, conditionId, outcome, usdcDelta, sharesDelta, outcomeIndex, tokenId, marketName, marketSlug) {
  await query(
    `INSERT INTO bot_positions (user_id, config_id, condition_id, outcome, usdc_spent, shares, outcome_index, token_id, market_name, market_slug)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, condition_id, outcome)
     DO UPDATE SET
       usdc_spent    = bot_positions.usdc_spent + EXCLUDED.usdc_spent,
       shares        = bot_positions.shares     + EXCLUDED.shares,
       outcome_index = COALESCE(EXCLUDED.outcome_index, bot_positions.outcome_index),
       token_id      = COALESCE(EXCLUDED.token_id,      bot_positions.token_id),
       market_name   = COALESCE(EXCLUDED.market_name,   bot_positions.market_name),
       market_slug   = COALESCE(EXCLUDED.market_slug,   bot_positions.market_slug),
       updated_at    = NOW()`,
    [userId, configId, conditionId, outcome, usdcDelta, sharesDelta, outcomeIndex ?? null, tokenId ?? null, marketName ?? null, marketSlug ?? null]
  );
}

async function deleteBotPosition(userId, conditionId, outcome) {
  await query(
    'DELETE FROM bot_positions WHERE user_id=$1 AND condition_id=$2 AND outcome=$3',
    [userId, conditionId, outcome]
  );
}

async function resolveBotPosition(userId, conditionId, outcome, resolvedOutcome, resolvedPnl) {
  await query(
    `UPDATE bot_positions
     SET resolved_outcome=$4, resolved_pnl=$5, shares=0, updated_at=NOW()
     WHERE user_id=$1 AND condition_id=$2 AND outcome=$3`,
    [userId, conditionId, outcome, resolvedOutcome, resolvedPnl]
  );
}

async function deleteResolvedPosition(userId, conditionId, outcome) {
  await query(
    'DELETE FROM bot_positions WHERE user_id=$1 AND condition_id=$2 AND outcome=$3',
    [userId, conditionId, outcome]
  );
}

async function getBotPositions(userId) {
  const res = await query(
    'SELECT * FROM bot_positions WHERE user_id=$1 AND shares > 0',
    [userId]
  );
  return res.rows;
}

async function getBotPositionsWithNames(userId) {
  const res = await query(
    `SELECT bp.*,
       COALESCE(bp.market_name, t.market_name) AS market_name,
       COALESCE(bp.market_slug, t.market_slug) AS market_slug
     FROM bot_positions bp
     LEFT JOIN LATERAL (
       SELECT market_name, market_slug FROM trades
       WHERE user_id=$1 AND condition_id=bp.condition_id AND market_name IS NOT NULL AND market_name != condition_id
       ORDER BY created_at DESC LIMIT 1
     ) t ON true
     WHERE bp.user_id=$1 AND (bp.shares > 0 OR bp.resolved_outcome IS NOT NULL)`,
    [userId]
  );
  return res.rows;
}

async function clearBotPositions(userId) {
  await query('DELETE FROM bot_positions WHERE user_id=$1', [userId]);
}

async function clearResolvedPositions(userId) {
  await query('DELETE FROM bot_positions WHERE user_id=$1 AND resolved_outcome IS NOT NULL', [userId]);
}

async function resetTraderStats(userId, configId) {
  await Promise.all([
    query('DELETE FROM trades WHERE user_id=$1 AND config_id=$2', [userId, configId]),
    query('DELETE FROM bot_positions WHERE user_id=$1 AND config_id=$2 AND resolved_outcome IS NOT NULL', [userId, configId]),
  ]);
}

async function deleteCopyConfig(id, userId) {
  await query('DELETE FROM copy_configs WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function updateDisplayName(userId, displayName) {
  await query('UPDATE users SET display_name=$2 WHERE id=$1', [userId, displayName || null]);
}

async function getLeaderboard(period, currentUserId) {
  const intervals = { daily: '1 day', weekly: '7 days', monthly: '30 days' };
  const periodJoin = intervals[period]
    ? `AND bp.updated_at >= NOW() - INTERVAL '${intervals[period]}'`
    : '';
  const tradesPeriod = intervals[period]
    ? `AND t.created_at >= NOW() - INTERVAL '${intervals[period]}'`
    : '';
  const sql = `
    WITH vol AS (
      SELECT user_id, COALESCE(SUM(size), 0) AS total
      FROM trades
      WHERE side = 'BUY' AND status = 'FILLED' ${tradesPeriod}
      GROUP BY user_id
    )
    SELECT
      u.id                                                                          AS user_id,
      COALESCE(u.display_name, lk.discord_username, split_part(u.email, '@', 1))  AS display_name,
      COALESCE(SUM(bp.resolved_pnl), 0)                                            AS profit,
      COALESCE(v.total, 0)                                                          AS volume,
      COUNT(bp.id)                                                                  AS trades,
      COUNT(bp.id) FILTER (WHERE bp.resolved_outcome = 'WON')                      AS wins,
      COUNT(bp.id) FILTER (WHERE bp.resolved_outcome = 'LOST')                      AS losses
    FROM users u
    JOIN wallets w ON w.user_id = u.id
    JOIN bot_positions bp ON bp.user_id = u.id
      AND bp.resolved_outcome IS NOT NULL ${periodJoin}
    LEFT JOIN license_keys lk ON lk.user_id = u.id
    LEFT JOIN vol v ON v.user_id = u.id
    GROUP BY u.id, u.display_name, lk.discord_username, v.total
    HAVING COUNT(bp.id) > 0
    ORDER BY profit DESC, trades DESC
    LIMIT 50
  `;
  const res = await query(sql);
  const rows = res.rows.map((r, i) => ({
    rank:          i + 1,
    userId:        r.user_id,
    displayName:   r.display_name,
    profit:        parseFloat(r.profit),
    volume:        parseFloat(r.volume),
    trades:        parseInt(r.trades),
    wins:          parseInt(r.wins),
    losses:        parseInt(r.losses),
    winRate:       parseInt(r.trades) > 0 ? Math.round(parseInt(r.wins) / parseInt(r.trades) * 100) : 0,
    isCurrentUser: r.user_id === currentUserId,
  }));

  // If current user not in top 50, fetch their stats separately
  let currentUser = rows.find(r => r.isCurrentUser) || null;
  if (!currentUser && currentUserId) {
    const cu = await query(`
      SELECT
        COALESCE(u.display_name, lk.discord_username, split_part(u.email, '@', 1)) AS display_name,
        COALESCE(SUM(bp.resolved_pnl), 0)   AS profit,
        COALESCE((SELECT SUM(size) FROM trades WHERE user_id=$1 AND side='BUY' AND status='FILLED' ${tradesPeriod}), 0) AS volume,
        COUNT(bp.id)                          AS trades,
        COUNT(bp.id) FILTER (WHERE bp.resolved_outcome='WON') AS wins
      FROM users u
      JOIN wallets w ON w.user_id = u.id
      JOIN bot_positions bp ON bp.user_id = u.id
        AND bp.resolved_outcome IS NOT NULL ${periodJoin}
      LEFT JOIN license_keys lk ON lk.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id, u.display_name, lk.discord_username
    `, [currentUserId]);
    if (cu.rows.length) {
      const r = cu.rows[0];
      currentUser = {
        rank: '—', displayName: r.display_name,
        profit: parseFloat(r.profit), volume: parseFloat(r.volume),
        trades: parseInt(r.trades), wins: parseInt(r.wins),
        winRate: parseInt(r.trades) > 0 ? Math.round(parseInt(r.wins) / parseInt(r.trades) * 100) : 0,
        isCurrentUser: true,
      };
    }
  }
  return { rows, currentUser };
}

async function updateCopyConfig(id, userId, { nickname, notes, copyMode, copyPercentage, fixedAmount, minTraderBet, maxTraderBet, categories, followMode, minSharePrice, maxSharePrice, maxPositionSize }) {
  const res = await query(
    `UPDATE copy_configs SET nickname=$3, notes=$4, copy_mode=$5, copy_percentage=$6, fixed_amount=$7,
     min_trader_bet=$8, max_trader_bet=$9, categories=$10, follow_mode=$11,
     min_share_price=$12, max_share_price=$13, max_position_size=$14, updated_at=NOW()
     WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, userId, nickname||null, notes||null, copyMode||'percentage', copyPercentage||10, fixedAmount||10,
     minTraderBet??5, maxTraderBet??100000, categories||[], followMode||'all', minSharePrice??null, maxSharePrice??null,
     maxPositionSize||null]
  );
  return res.rows[0];
}

async function createLicenseUser(discordUserId, discordUsername) {
  const internalEmail = `discord:${discordUserId}@jonin.internal`;
  const existing = await query('SELECT id FROM users WHERE email = $1', [internalEmail]);
  if (existing.rows.length > 0) return existing.rows[0];
  const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS);
  const res = await query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
    [internalEmail, randomHash]
  );
  return res.rows[0];
}

module.exports = {
  createUser, createLicenseUser, getUserByEmail, getUserById, verifyPassword,
  setConfigActive,
  createWalletForUser, getWalletByUserId, getUSDCBalance,
  saveCopyConfig, updateCopyConfig, getCopyConfig, setConfigActive, getAllActiveConfigs, deleteCopyConfig,
  updateDisplayName, getLeaderboard,
  saveTrade, resolveTradeOutcome, getRecentTrades, getDashboardStats, getTraderStats,
  upsertBotPosition, deleteBotPosition, resolveBotPosition, deleteResolvedPosition, getBotPositions, getBotPositionsWithNames, clearBotPositions, clearResolvedPositions, resetTraderStats,
  encryptPrivateKey, decryptPrivateKey,
};