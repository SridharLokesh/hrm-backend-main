const jwt = require('jsonwebtoken');

const generateToken = (id, role = 'employee') => {
  const payload = { 
    id, 
    role
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE,
  });
};

module.exports = generateToken;