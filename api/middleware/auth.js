const jwt = require('jsonwebtoken');
const { query } = require('../../db/client');

// 60s in-memory cache — avoids DB hit on every request while still catching revocations quickly
const _licenseCache = {}; // userId -> { active, ts }
const LICENSE_CACHE_TTL = 60 * 1000;

async function isLicenseActive(userId) {
  const cached = _licenseCache[userId];
  if (cached && Date.now() - cached.ts < LICENSE_CACHE_TTL) return cached.active;
  try {
    const r = await query(
      'SELECT active FROM license_keys WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    const active = r.rows.length === 0 || r.rows[0].active === true;
    _licenseCache[userId] = { active, ts: Date.now() };
    return active;
  } catch {
    return true; // fail open on DB error — don't kick out users due to infra issues
  }
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided.' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }

  const active = await isLicenseActive(req.userId);
  if (!active) {
    return res.status(401).json({
      error: 'Your license has been deactivated. Renew your subscription on Discord.',
      code: 'LICENSE_REVOKED',
    });
  }

  next();
}

module.exports = { requireAuth };