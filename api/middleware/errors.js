function errorHandler(err, req, res, next) {
  console.error('Unhandled error:', err.message);

  const knownErrors = {
    EMAIL_TAKEN:      { status: 409, message: 'An account with this email already exists.' },
    INVALID_PASSWORD: { status: 401, message: 'Incorrect email or password.' },
    USER_NOT_FOUND:   { status: 404, message: 'Account not found.' },
    ENGINE_RUNNING:   { status: 409, message: 'Copy trading is already active.' },
    ENGINE_NOT_FOUND: { status: 404, message: 'No active copy engine found.' },
    NO_CONFIG:        { status: 400, message: 'Please set up your copy config first.' },
    LOW_BALANCE:      { status: 400, message: 'Insufficient USDC balance. Please deposit funds.' },
  };

  const known = knownErrors[err.message];
  if (known) {
    return res.status(known.status).json({ error: known.message });
  }

  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
}

module.exports = errorHandler;