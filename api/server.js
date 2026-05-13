require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getAllActiveConfigs } = require('../db');
const { startCopyEngine } = require('../engine');

const express = require("express");
const app = express();

app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

app.use('/auth',      authLimiter, require('./routes/auth'));
app.use('/wallet',    require('./routes/wallet'));
app.use('/copy',      require('./routes/copy'));
app.use('/dashboard', require('./routes/dashboard'));

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.use(require('./middleware/errors'));

async function restoreActiveEngines() {
  try {
    const configs = await getAllActiveConfigs();
    console.log(`Restoring ${configs.length} active engine(s)...`);
    for (const cfg of configs) {
      await startCopyEngine({
        id:                  cfg.user_id,
        budget:              parseFloat(cfg.budget),
        maxPerTrade:         parseFloat(cfg.max_per_trade),
        dailyLossLimit:      parseFloat(cfg.daily_loss_limit),
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
app.listen(PORT, async () => {
  console.log(`CopyMarket API running on port ${PORT}`);
  await restoreActiveEngines();
});

module.exports = app;