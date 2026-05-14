require('dotenv').config();
const postgres = require('postgres');

const dbUrl = process.env.DATABASE_URL || '';

const sql = postgres(dbUrl, {
  ssl: 'prefer',
  max: 10,
  idle_timeout: 30,
  connect_timeout: 15,
  onnotice: () => {},
});

async function query(text, params = []) {
  const result = await sql.unsafe(text, params);
  return { rows: result };
}

async function run(text) {
  try {
    await sql.unsafe(text);
  } catch (err) {
    if (!err.message?.includes('already exists')) {
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
    await run(`ALTER TABLE copy_configs ADD COLUMN IF NOT EXISTS nickname TEXT`);
    await run(`CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_trades_created  ON trades(created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_daily_pnl_user  ON daily_pnl(user_id, date DESC)`);
    console.log('Database migration complete.');
  } catch (err) {
    console.error('Migration failed (server will continue):', err.message);
  }
}

module.exports = { sql, query, migrate };
