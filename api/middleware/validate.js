function validate(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      const val = req.body[field];

      if (rules.required && (val === undefined || val === null || val === '')) {
        errors.push(`${field} is required.`);
        continue;
      }
      if (val === undefined) continue;

      if (rules.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        errors.push(`${field} must be a valid email address.`);
      }
      if (rules.minLength && val.length < rules.minLength) {
        errors.push(`${field} must be at least ${rules.minLength} characters.`);
      }
      if (rules.type === 'wallet' && !/^0x[0-9a-fA-F]{40}$/.test(val)) {
        errors.push(`${field} must be a valid Polygon wallet address.`);
      }
      if (rules.min !== undefined && val < rules.min) {
        errors.push(`${field} must be at least ${rules.min}.`);
      }
      if (rules.max !== undefined && val > rules.max) {
        errors.push(`${field} must be at most ${rules.max}.`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }
    next();
  };
}

module.exports = { validate };