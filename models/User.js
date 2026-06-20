const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Please add an email'],
    unique: true,
    lowercase: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please add a valid email'
    ]
  },
  password: {
    type: String,
    required: [true, 'Please add a password'],
    minlength: 6
  },
role: {
    type: String,
    enum: ['employee', 'admin', 'manager', 'team-lead'],
    default: 'employee'
  },
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Allow admin to enable mobile access for this user when needed
  mobileAllowed: {
    type: Boolean,
    // Default: allowed by default per requested behaviour
    default: true
  },
  canEditAttendanceTime: {
    type: Boolean,
    default: false
  },
  lastLogin: {
    type: Date
  },
  lastLogout: {
    type: Date
  },
  loginSession: {
    token: String,
    expires: Date,
    isValid: {
      type: Boolean,
      default: true
    }
  },
  passwordChangedAt: Date,
  passwordResetToken: String,
  passwordResetExpires: Date
}, {
  timestamps: true
});

// Encrypt password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    next();
  }
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Update passwordChangedAt when password is modified
userSchema.pre('save', function(next) {
  if (!this.isModified('password') || this.isNew) {
    return next();
  }
  this.passwordChangedAt = Date.now() - 1000;
  next();
});

// Match password
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Check if password was changed after JWT was issued
userSchema.methods.changedPasswordAfter = function(JWTTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(
      this.passwordChangedAt.getTime() / 1000,
      10
    );
    return JWTTimestamp < changedTimestamp;
  }
  return false;
};

// Create password reset token
userSchema.methods.createPasswordResetToken = function() {
  const crypto = require('crypto');
  const resetToken = crypto.randomBytes(32).toString('hex');
  
  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
    
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  
  return resetToken;
};

// Create login session
userSchema.methods.createLoginSession = function(token) {
  const jwt = require('jsonwebtoken');
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  
  this.loginSession = {
    token: token,
    expires: new Date(decoded.exp * 1000), // Convert to milliseconds
    isValid: true
  };
};

// Invalidate login session (logout)
userSchema.methods.invalidateSession = function() {
  this.loginSession.isValid = false;
  this.lastLogout = new Date();
};

// Check if session is valid
userSchema.methods.isSessionValid = function(token) {
  if (!this.loginSession || !this.loginSession.isValid) {
    return false;
  }
  
  if (this.loginSession.token !== token) {
    return false;
  }
  
  if (this.loginSession.expires < new Date()) {
    return false;
  }
  
  return true;
};

module.exports = userSchema;
