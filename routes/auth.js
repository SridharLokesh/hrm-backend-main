const express = require('express');
const { body } = require('express-validator');
const { 
  login, 
  logout, 
  forceLogout, 
  getMe, 
  changePassword, 
  getActiveSessions ,
  changeEmployeePassword,
  resetEmployeePassword
} = require('../controllers/authController');
const { protect, authorize } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], login);

router.post('/logout', protect, requireTenant, logout);
router.post('/logout/:userId', protect, authorize('admin'), forceLogout);
router.get('/me', protect, getMe);
router.put('/change-password', protect, requireTenant, changePassword);
router.get('/active-sessions', protect, authorize('admin'), getActiveSessions);
router.put('/change-employee-password/:userId', 
  protect,
  authorize('admin'),
  [
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long')
  ],
  changeEmployeePassword
);

router.post('/reset-employee-password/:userId',
  protect,
  authorize('admin'),
  resetEmployeePassword
);

module.exports = router;