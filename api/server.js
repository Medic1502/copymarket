require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { getAllActiveConfigs } = require('../db');
const { migrate, query } = require('../db/client');
const { startCopyEngine } = require('../engine');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Too many requests. Please try again later.' },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

app.use('/auth', authLimiter, require('./routes/auth'));
app.use('/wallet', require('./routes/wallet'));
app.use('/copy', require('./routes/copy'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/api/license', require('./routes/license'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.get('/test-db', async (req, res) => {
  const { query } = require('../db/client');
  const dbUrl = process.env.DATABASE_URL || '';
  let urlInfo = {};
  try { const u = new URL(dbUrl); urlInfo = { host: u.host, db: u.pathname, user: u.username }; } catch {}
  try {
    const r = await query('SELECT current_database() AS db, version() AS ver');
    res.json({ ok: true, row: r.rows[0], urlInfo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: err.code, urlInfo });
  }
});

app.use(express.static(path.join(__dirname, '../FrontEnd')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../FrontEnd/index.html'));
});

app.use(require('./middleware/errors'));

async function fixMissingMarketNames() {
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await query(
      `SELECT DISTINCT condition_id FROM bot_positions
       WHERE (market_name IS NULL OR market_name = condition_id) AND shares > 0`
    );
    if (!res.rows.length) return;
    console.log(`Fetching market names for ${res.rows.length} position(s)...`);
    await Promise.all(res.rows.map(async ({ condition_id }) => {
      try {
        const r = await fetch(`https://clob.polymarket.com/markets/${condition_id}`, { timeout: 8000 });
        const m = await r.json();
        const name = m.question || m.title;
        const slug = m.market_slug || null;
        if (name && name !== condition_id) {
          await query(
            `UPDATE bot_positions SET market_name=$1, market_slug=$2
             WHERE condition_id=$3 AND (market_name IS NULL OR market_name = condition_id)`,
            [name, slug, condition_id]
          );
          console.log(`  Fixed: ${condition_id.slice(0, 10)}... → ${name.slice(0, 50)}`);
        }
      } catch {}
    }));
  } catch (err) {
    console.error('fixMissingMarketNames error:', err.message);
  }
}

async function restoreActiveEngines() {
  try {
    const configs = await getAllActiveConfigs();

    console.log(`Restoring ${configs.length} active engine(s)...`);

    for (const cfg of configs) {
      await startCopyEngine({
        id:                  cfg.user_id,
        configId:            cfg.id,
        copyMode:            cfg.copy_mode || 'percentage',
        copyPercentage:      parseFloat(cfg.copy_percentage)||10,
        fixedAmount:         parseFloat(cfg.fixed_amount)||10,
        minTraderBet:        parseFloat(cfg.min_trader_bet)||5,
        maxTraderBet:        parseFloat(cfg.max_trader_bet)||100000,
        categories:          cfg.categories || [],
        followMode:          cfg.follow_mode || 'all',
        minSharePrice:       parseFloat(cfg.min_share_price)||0.02,
        maxSharePrice:       parseFloat(cfg.max_share_price)||0.98,
        maxPositionSize:     cfg.max_position_size != null ? parseFloat(cfg.max_position_size) : null,
        encryptedPrivateKey: cfg.encrypted_private_key,
        walletAddress:       cfg.wallet_address,
      }, cfg.target_wallet);
    }

    console.log('All engines restored.');
  } catch (err) {
    console.error('Failed to restore engines:', err.message);
  }
}

const PORT = process.env.PORT || 3001;

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`CopyMarket API running on port ${PORT}`);
  await migrate();
  await fixMissingMarketNames();
  await restoreActiveEngines();
});

module.exports = app;