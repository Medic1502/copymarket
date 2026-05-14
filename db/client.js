require('dotenv').config();
const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL || '';

// Railway internal connections don't use SSL; external proxy does
const ssl = dbUrl.includes('.railway.internal') ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: dbUrl,
  ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err.message);
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function run(sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    // Skip if already exists or permission denied - don't crash
    if (!err.message.includes('already exists') && err.code !== '42P07' && err.code !== '42710') {
      console.warn('Migration warning:', err.message);
    }
  }
}

async function migrate() {
  console.log('Running database migration...');
  try {
    await run(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await run(`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        is_active     BOOLEAN DEFAULT TRUE
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS wallets (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id               UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        address               TEXT UNIQUE NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS copy_configs (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_wallet    TEXT NOT NULL,
        budget           NUMERIC(12,2) NOT NULL DEFAULT 100,
        max_per_trade    NUMERIC(12,2) NOT NULL DEFAULT 20,
        daily_loss_limit NUMERIC(12,2) NOT NULL DEFAULT 30,
        is_active        BOOLEAN DEFAULT FALSE,
        paused_reason    TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS trades (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        condition_id TEXT NOT NULL,
        market_name  TEXT,
        outcome      TEXT NOT NULL,
        side         TEXT NOT NULL,
        size         NUMERIC(12,2) NOT NULL,
        price        NUMERIC(8,4) NOT NULL,
        order_id     TEXT,
        filled_size  NUMERIC(12,2),
        status       TEXT DEFAULT 'FILLED',
        skip_reason  TEXT,
        pnl          NUMERIC(12,2),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS daily_pnl (
        id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date    DATE NOT NULL,
        pnl     NUMERIC(12,2) DEFAULT 0,
        trades  INT DEFAULT 0,
        UNIQUE (user_id, date)
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_trades_created  ON trades(created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_daily_pnl_user  ON daily_pnl(user_id, date DESC)`);
    console.log('Database migration complete.');
  } catch (err) {
    // Log but never crash the server over migration
    console.error('Migration failed (server will continue):', err.message);
  }
}

module.exports = { pool, query, migrate };
