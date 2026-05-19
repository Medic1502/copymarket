const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../../db/client');
const db = require('../../db');

const router = express.Router();

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// POST /api/license/validate  — called by Electron app on every startup
router.post('/validate', async (req, res) => {
  try {
    const { key, hwid } = req.body;
    if (!key || !hwid) return res.status(400).json({ valid: false, message: 'Key and hardware ID are required.' });

    const result = await query('SELECT * FROM license_keys WHERE key = $1', [key]);
    const license = result.rows[0];

    if (!license) return res.json({ valid: false, message: 'Invalid license key. Check your key and try again.' });
    if (!license.active) return res.json({ valid: false, message: 'This license has been deactivated. Contact support on Discord.' });
    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return res.json({ valid: false, message: 'Your license has expired. Renew your subscription on Discord.' });
    }

    // First activation — bind HWID and create user account
    if (!license.hwid) {
      const user = await db.createLicenseUser(license.discord_user_id, license.discord_username);
      const existingWallet = await db.getWalletByUserId(user.id);
      if (!existingWallet) await db.createWalletForUser(user.id);
      await query(
        'UPDATE license_keys SET hwid = $1, activated_at = NOW(), user_id = $2 WHERE key = $3',
        [hwid, user.id, key]
      );
      const token = signToken(user.id);
      const newWallet = await db.getWalletByUserId(user.id);
      return res.json({ valid: true, activated: true, token, walletAddress: newWallet?.address, discordUsername: license.discord_username });
    }

    if (license.hwid !== hwid) {
      return res.json({
        valid: false,
        message: 'This license is already activated on another machine. Contact support on Discord to transfer it.'
      });
    }

    // Returning user — ensure user_id and wallet exist (migration for old activations)
    let userId = license.user_id;
    if (!userId) {
      const user = await db.createLicenseUser(license.discord_user_id, license.discord_username);
      const existingWallet = await db.getWalletByUserId(user.id);
      if (!existingWallet) await db.createWalletForUser(user.id);
      await query('UPDATE license_keys SET user_id = $1 WHERE key = $2', [user.id, key]);
      userId = user.id;
    }

    // Always ensure wallet exists (handles any intermediate broken state)
    let wallet = await db.getWalletByUserId(userId);
    if (!wallet) wallet = await db.createWalletForUser(userId);

    const token = signToken(userId);
    res.json({ valid: true, token, walletAddress: wallet?.address, discordUsername: license.discord_username, expiresAt: license.expires_at });
  } catch (err) {
    console.error('License validate error:', err);
    res.status(500).json({ valid: false, message: 'Server error. Try again in a moment.' });
  }
});

// POST /api/license/generate  — called by Discord bot only
router.post('/generate', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const secret = process.env.DISCORD_BOT_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const { discordUserId, discordUsername, expiresAt } = req.body;
    if (!discordUserId) return res.status(400).json({ error: 'discordUserId is required' });

    // Return existing ACTIVE key if one exists
    const activeKey = await query(
      'SELECT key FROM license_keys WHERE discord_user_id = $1 AND active = TRUE ORDER BY created_at DESC LIMIT 1',
      [discordUserId]
    );
    if (activeKey.rows.length > 0) {
      return res.json({ key: activeKey.rows[0].key, existing: true });
    }

    // No active key — check if there's an inactive one and reactivate it
    const inactiveKey = await query(
      'SELECT id, key FROM license_keys WHERE discord_user_id = $1 AND active = FALSE ORDER BY created_at DESC LIMIT 1',
      [discordUserId]
    );
    if (inactiveKey.rows.length > 0) {
      await query('UPDATE license_keys SET active = TRUE WHERE id = $1', [inactiveKey.rows[0].id]);
      return res.json({ key: inactiveKey.rows[0].key, existing: true, reactivated: true });
    }

    // No key at all — create new one
    const result = await query(
      'INSERT INTO license_keys (discord_user_id, discord_username, expires_at) VALUES ($1, $2, $3) RETURNING key',
      [discordUserId, discordUsername || null, expiresAt || null]
    );

    res.json({ key: result.rows[0].key, existing: false });
  } catch (err) {
    console.error('License generate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/license/self-reset  — user resets their own HWID (moving to new machine)
router.post('/self-reset', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    const result = await query('SELECT * FROM license_keys WHERE key = $1', [key]);
    const license = result.rows[0];

    if (!license) return res.status(404).json({ error: 'Key not found' });
    if (!license.active) return res.status(403).json({ error: 'Key is deactivated' });

    await query('UPDATE license_keys SET hwid = NULL, activated_at = NULL WHERE key = $1', [key]);
    res.json({ success: true, message: 'Device unlinked. You can now activate on a new machine.' });
  } catch (err) {
    console.error('self-reset error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/license/revoke-by-discord  — called by bot when user loses Premium CT role
router.post('/revoke-by-discord', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const secret = process.env.DISCORD_BOT_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const { discordUserId } = req.body;
    if (!discordUserId) return res.status(400).json({ error: 'discordUserId is required' });

    const r = await query('UPDATE license_keys SET active = FALSE WHERE discord_user_id = $1 RETURNING key', [discordUserId]);
    res.json({ revoked: r.rowCount });
  } catch (err) {
    console.error('revoke-by-discord error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/license/reactivate-by-discord  — called by bot when user gets Premium CT role back
router.post('/reactivate-by-discord', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const secret = process.env.DISCORD_BOT_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const { discordUserId } = req.body;
    if (!discordUserId) return res.status(400).json({ error: 'discordUserId is required' });

    // Reactivate only the most recent key for this user
    await query(
      `UPDATE license_keys SET active = TRUE
       WHERE id = (SELECT id FROM license_keys WHERE discord_user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [discordUserId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('reactivate-by-discord error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/license/user-reset-hwid  — user resets their own device binding (7-day cooldown)
router.post('/user-reset-hwid', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const secret = process.env.DISCORD_BOT_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const { discordUserId } = req.body;
    if (!discordUserId) return res.status(400).json({ error: 'discordUserId is required' });

    const r = await query('SELECT * FROM license_keys WHERE discord_user_id = $1 ORDER BY created_at DESC LIMIT 1', [discordUserId]);
    const license = r.rows[0];
    if (!license) return res.status(404).json({ error: 'No license found.' });
    if (!license.active) return res.status(403).json({ error: 'License is inactive.' });

    // 7-day cooldown check
    if (license.hwid_reset_at) {
      const daysSince = (Date.now() - new Date(license.hwid_reset_at).getTime()) / 86400000;
      if (daysSince < 7) {
        const daysLeft = Math.ceil(7 - daysSince);
        return res.json({ cooldown: true, daysLeft, error: `Cooldown active. Try again in ${daysLeft} day(s).` });
      }
    }

    await query('UPDATE license_keys SET hwid = NULL, activated_at = NULL, hwid_reset_at = NOW() WHERE key = $1', [license.key]);
    res.json({ success: true, key: license.key });
  } catch (err) {
    console.error('user-reset-hwid error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/license/shuffle  — Discord bot generates new key for same user (invalidates old)
router.post('/shuffle', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const secret = process.env.DISCORD_BOT_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const { discordUserId } = req.body;
    if (!discordUserId) return res.status(400).json({ error: 'discordUserId is required' });

    const existing = await query('SELECT * FROM license_keys WHERE discord_user_id = $1', [discordUserId]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'No key found for this user' });

    const old = existing.rows[0];

    // Cooldown: max 1 shuffle per 24h
    if (old.activated_at) {
      const hoursSinceActivation = (Date.now() - new Date(old.activated_at).getTime()) / 3600000;
      if (hoursSinceActivation < 24) {
        const hoursLeft = Math.ceil(24 - hoursSinceActivation);
        return res.json({ error: `Cooldown active. Try again in ${hoursLeft}h.`, cooldown: true });
      }
    }

    // Deactivate old key, create new one preserving user_id
    await query('UPDATE license_keys SET active = FALSE WHERE discord_user_id = $1', [discordUserId]);
    const newKey = await query(
      'INSERT INTO license_keys (discord_user_id, discord_username, user_id) VALUES ($1, $2, $3) RETURNING key',
      [discordUserId, old.discord_username, old.user_id]
    );

    res.json({ key: newKey.rows[0].key });
  } catch (err) {
    console.error('shuffle error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/license/revoke  — admin: deactivate a key
router.post('/revoke', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const secret = process.env.ADMIN_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    await query('UPDATE license_keys SET active = FALSE WHERE key = $1', [key]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/license/reset-hwid  — admin: let user switch to a new machine
router.post('/reset-hwid', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const secret = process.env.ADMIN_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    await query('UPDATE license_keys SET hwid = NULL, activated_at = NULL WHERE key = $1', [key]);
    res.json({ success: true, message: 'HWID reset. User can activate on a new machine.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/license/list  — admin: list all keys
router.get('/list', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const secret = process.env.ADMIN_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const result = await query(
      'SELECT key, discord_user_id, discord_username, hwid IS NOT NULL AS activated, active, expires_at, created_at FROM license_keys ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
