const DefaultUser = require('../models/User');
// Helper to resolve tenant-aware User model
const getUserModel = (req) => (req && req.models && req.models.User) ? req.models.User : DefaultUser;
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const generateToken = require('../utils/generateToken');
const { validationResult } = require('express-validator');
const mongoose = require('mongoose');

// User login with tenant context
exports.login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Use tenant-specific models if available, otherwise fall back to default User model
    const UserModel = (req.models && req.models.User) ? req.models.User : DefaultUser;

    // Check if user exists and is active
    const user = await UserModel.findOne({ email, isActive: true })
      .populate({
        path: 'employee',
        select: 'name email department position salary employeeId isActive'
      });

    if (!user || !user.employee || !user.employee.isActive) {
      return res.status(401).json({ message: 'Invalid credentials or account inactive' });
    }

    // Check password
    const isPasswordMatch = await user.matchPassword(password);
    if (!isPasswordMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate token
    const token = generateToken(user._id, user.role);

    // Update last login and create session
    user.lastLogin = new Date();
    user.createLoginSession(token);
    await user.save();

    res.json({
      _id: user._id,
      employee: user.employee,
      role: user.role,
      mobileAllowed: user.mobileAllowed || false,
      canEditAttendanceTime: Boolean(user.canEditAttendanceTime),
      tenant: user.tenant,
      token: token,
      loginTime: user.lastLogin
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};


// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
exports.logout = async (req, res) => {
  try {
  const UserModel = getUserModel(req);
  const user = await UserModel.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Invalidate session
    user.invalidateSession();
    await user.save();

    // Auto check-out for attendance
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const attendance = await Attendance.findOne({
        employee: user.employee,
        date: {
          $gte: today,
          $lte: new Date(today.getTime() + 24 * 60 * 60 * 1000)
        },
        checkOut: { $exists: false }
      });

      if (attendance) {
        attendance.checkOut = new Date();
        await attendance.save();
      }
    } catch (attendanceError) {
      console.log('Auto check-out failed:', attendanceError.message);
      // Continue with logout even if auto check-out fails
    }

    res.json({ 
      message: 'Logout successful',
      logoutTime: user.lastLogout
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Force logout user (Admin only)
// @route   POST /api/auth/logout/:userId
// @access  Private/Admin
exports.forceLogout = async (req, res) => {
  try {
    const UserModel = getUserModel(req);
    const userToLogout = await UserModel.findById(req.params.userId)
      .populate('employee', 'name email');

    if (!userToLogout) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Invalidate session
    userToLogout.invalidateSession();
    await userToLogout.save();

    res.json({ 
      message: `User ${userToLogout.employee.name} has been logged out successfully`,
      logoutTime: userToLogout.lastLogout,
      forcedBy: req.user.employee.name
    });
  } catch (error) {
    console.error('Force logout error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
  try {
    const UserModel = getUserModel(req);
    const user = await UserModel.findById(req.user._id)
      .populate({
        path: 'employee',
        select: '-__v'
      });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      _id: user._id,
      employee: user.employee,
      role: user.role,
      mobileAllowed: user.mobileAllowed || false,
      canEditAttendanceTime: Boolean(user.canEditAttendanceTime),
      lastLogin: user.lastLogin,
      lastLogout: user.lastLogout,
      isSessionValid: user.isSessionValid(req.headers.authorization?.split(' ')[1])
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Change password
// @route   PUT /api/auth/change-password
// @access  Private
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

  const UserModel = getUserModel(req);
  const user = await UserModel.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check current password
    const isCurrentPasswordMatch = await user.matchPassword(currentPassword);
    if (!isCurrentPasswordMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Update password and invalidate all sessions
    user.password = newPassword;
    user.invalidateSession(); // Logout from current session after password change
    await user.save();

    res.json({ 
      message: 'Password updated successfully. Please login again.',
      logoutTime: user.lastLogout
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get active sessions (Admin only)
// @route   GET /api/auth/active-sessions
// @access  Private/Admin
exports.getActiveSessions = async (req, res) => {
  try {
    const UserModel = getUserModel(req);
    const activeUsers = await UserModel.find({
      'loginSession.isValid': true,
      'loginSession.expires': { $gt: new Date() }
    })
    .populate('employee', 'name email department position')
    .select('email role lastLogin loginSession');

    const activeSessions = activeUsers.map(user => ({
      _id: user._id,
      employee: user.employee,
      role: user.role,
      lastLogin: user.lastLogin,
      sessionExpires: user.loginSession.expires,
      isActive: true
    }));

    res.json({
      totalActiveSessions: activeSessions.length,
      activeSessions: activeSessions
    });
  } catch (error) {
    console.error('Get active sessions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Change employee password (Admin only)
// @route   PUT /api/auth/change-employee-password/:userId
// @access  Private/Admin
exports.changeEmployeePassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    const { userId } = req.params;

    console.log('Changing password for ID:', userId);

    // Validate password
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ 
        message: 'Password must be at least 6 characters long' 
      });
    }

  const UserModel = getUserModel(req);
  let user;

    // Check if the ID is a valid ObjectId
      if (mongoose.Types.ObjectId.isValid(userId)) {
      // Try to find user by ID first
      user = await UserModel.findById(userId).populate('employee', 'name email');
      
      // If user not found by ID, try to find by employee ID
      if (!user) {
        user = await UserModel.findOne({ employee: userId }).populate('employee', 'name email');
      }
    } else {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.isActive) {
      return res.status(400).json({ message: 'Cannot change password for inactive user' });
    }

    // Update password and invalidate sessions
    user.password = newPassword;
    user.invalidateSession(); // Force logout from all sessions
    user.passwordChangedAt = Date.now();
    await user.save();

    console.log(`Password changed for user: ${user.employee.name}`);

    res.json({ 
      message: `Password updated successfully for ${user.employee.name}`,
      employee: {
        name: user.employee.name,
        email: user.employee.email
      },
      changedBy: req.user.employee.name,
      changedAt: new Date()
    });
  } catch (error) {
    console.error('Change employee password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Reset employee password (Admin only - without current password)
// @route   POST /api/auth/reset-employee-password/:userId
// @access  Private/Admin
exports.resetEmployeePassword = async (req, res) => {
  try {
    const { userId } = req.params;

    console.log('Resetting password for ID:', userId);

  const UserModel = getUserModel(req);
  let user;

    // Check if the ID is a valid ObjectId
    if (mongoose.Types.ObjectId.isValid(userId)) {
      // Try to find user by ID first
      user = await UserModel.findById(userId).populate('employee', 'name email');
      
      // If user not found by ID, try to find by employee ID
      if (!user) {
        user = await UserModel.findOne({ employee: userId }).populate('employee', 'name email');
      }
    } else {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.isActive) {
      return res.status(400).json({ message: 'Cannot reset password for inactive user' });
    }

    // Generate a random password
    const randomPassword = Math.random().toString(36).slice(-8) + 'A1!';
    
    console.log(`Generated new password for ${user.employee.name}: ${randomPassword}`);

    // Update password and invalidate sessions
    user.password = randomPassword;
    user.invalidateSession(); // Force logout from all sessions
    user.passwordChangedAt = Date.now();
    await user.save();

    res.json({ 
      message: `Password reset successfully for ${user.employee.name}`,
      employee: {
        name: user.employee.name,
        email: user.employee.email
      },
      newPassword: randomPassword, // Send back for admin to communicate to employee
      changedBy: req.user.employee.name,
      changedAt: new Date()
    });
  } catch (error) {
    console.error('Reset employee password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
