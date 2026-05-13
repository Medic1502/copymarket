const router = require('express').Router();
const jwt = require('jsonwebtoken');
const db = require('../../db');
const { validate } = require('../middleware/validate');

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register',
  validate({
    email:    { required: true, type: 'email' },
    password: { required: true, minLength: 8 },
  }),
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const user = await db.createUser(email, password);
      const wallet = await db.createWalletForUser(user.id);
      const token = signToken(user.id);
      res.status(201).json({
        token,
        user: { id: user.id, email: user.email },
        wallet: { address: wallet.address },
        message: 'Account created. Deposit USDC to your wallet address to get started.',
      });
    } catch (err) { next(err); }
  }
);

router.post('/login',
  validate({
    email:    { required: true, type: 'email' },
    password: { required: true },
  }),
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const user = await db.getUserByEmail(email);
      if (!user) throw new Error('INVALID_PASSWORD');
      const valid = await db.verifyPassword(user, password);
      if (!valid) throw new Error('INVALID_PASSWORD');
      const token = signToken(user.id);
      const wallet = await db.getWalletByUserId(user.id);
      res.json({
        token,
        user: { id: user.id, email: user.email },
        wallet: { address: wallet?.address },
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;