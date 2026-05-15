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
      return res.json({ valid: true, activated: true, token, discordUsername: license.discord_username });
    }

    if (license.hwid !== hwid) {
      return res.json({
        valid: false,
        message: 'This license is already activated on another machine. Contact support on Discord to transfer it.'
      });
    }

    // Returning user — ensure user_id is linked (migration for old activations)
    let userId = license.user_id;
    if (!userId) {
      const user = await db.createLicenseUser(license.discord_user_id, license.discord_username);
      await query('UPDATE license_keys SET user_id = $1 WHERE key = $2', [user.id, key]);
      userId = user.id;
    }

    const token = signToken(userId);
    res.json({ valid: true, token, discordUsername: license.discord_username, expiresAt: license.expires_at });
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

    // If user already has a key, return the existing one
    const existing = await query('SELECT key FROM license_keys WHERE discord_user_id = $1', [discordUserId]);
    if (existing.rows.length > 0) {
      return res.json({ key: existing.rows[0].key, existing: true });
    }

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
