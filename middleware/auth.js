const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// Helper to resolve User model (tenant-aware via req.models when available)
const resolveUserModel = (req) => {
  if (req && req.models && req.models.User) return req.models.User;
  const UserMod = require('../models/User');
  const schema = UserMod && UserMod.schema ? UserMod.schema : UserMod;
  if (mongoose.models && mongoose.models.User) return mongoose.models.User;
  return mongoose.model('User', schema);
};

exports.protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token.startsWith('Bearer ') ? req.query.token.split(' ')[1] : req.query.token;
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Resolve User model (tenant-aware)
    const User = resolveUserModel(req);

    // Find user and populate employee details
    req.user = await User.findById(decoded.id)
      .populate('employee', 'name email department position isActive');
    
    if (!req.user || !req.user.isActive) {
      return res.status(401).json({ message: 'Not authorized, user not found or inactive' });
    }

    // Check if user changed password after the token was issued
    if (req.user.changedPasswordAfter(decoded.iat)) {
      return res.status(401).json({ message: 'User recently changed password! Please log in again.' });
    }

    // Verify tenant context matches user's tenant
    if (req.tenant && !req.user.tenant.equals(req.tenant._id)) {
      return res.status(403).json({ message: 'Access denied for this tenant' });
    }

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `User role ${req.user.role} is not authorized to access this route` 
      });
    }
    next();
  };
};

// @desc    Shorthand for admin only access
exports.adminOnly = exports.authorize('admin');

// Super admin authentication
exports.superAdminAuth = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { getSuperAdminModels } = require('../config/db');
    const { SuperAdmin } = getSuperAdminModels();

    req.superAdmin = await SuperAdmin.findById(decoded.id);
    
    if (!req.superAdmin || !req.superAdmin.isActive) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};