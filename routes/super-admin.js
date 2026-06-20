const express = require('express');
const { body } = require('express-validator');
const {
  login,
  getMe,
  createTenant,
  getTenants,
  getTenant,
  updateTenant,
  deleteTenant,
  changePassword,
  getPublicTenants,
  createAdmin,
  getTenantStats,
  getTenantAdmins,
  updateAdminAttendancePermission
} = require('../controllers/superAdminController');
const {
  getAnalyticsOverview,
  getTenantsGrowth,
  getTopCompanies,
  getDailyActiveUsers,
  getAttendanceRates,
  getDashboardAnalytics
} = require('../controllers/analyticsController');
const { superAdminAuth } = require('../middleware/auth');
const { param } = require('express-validator');

const router = express.Router();

// Temporary public ping for analytics route registration debugging
// NOTE: remove this before production - it's only for verifying route availability
router.get('/analytics/ping', (req, res) => {
  return res.json({ ok: true, timestamp: new Date().toISOString(), route: '/api/super-admin/analytics/ping' });
});

router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], login);

router.get('/tenants/public', getPublicTenants);
router.get('/me', superAdminAuth, getMe);
router.post('/tenants', superAdminAuth, createTenant);
router.get('/tenants', superAdminAuth, getTenants);
router.get('/tenants/:id', superAdminAuth, getTenant);
router.put('/tenants/:id', superAdminAuth, updateTenant);
router.delete('/tenants/:id', superAdminAuth, deleteTenant);
router.put('/change-password', superAdminAuth, changePassword);

router.post('/tenants/:tenantId/admins', [
  superAdminAuth,
  param('tenantId').isLength({ min: 24, max: 100 }).withMessage('tenantId param seems invalid')
], createAdmin);
router.get('/tenants/:tenantId/admins', superAdminAuth, getTenantAdmins);
router.put('/tenants/:tenantId/admins/:adminId/attendance-time-permission', superAdminAuth, updateAdminAttendancePermission);
router.get('/stats/tenants', superAdminAuth, getTenantStats);

// NEW ANALYTICS ROUTES
router.get('/analytics/overview', superAdminAuth, getAnalyticsOverview);
router.get('/analytics/tenants-growth', superAdminAuth, getTenantsGrowth);
router.get('/analytics/top-companies', superAdminAuth, getTopCompanies);
router.get('/analytics/daily-active-users', superAdminAuth, getDailyActiveUsers);
router.get('/analytics/attendance-rates', superAdminAuth, getAttendanceRates);
router.get('/analytics/dashboard', superAdminAuth, getDashboardAnalytics);


module.exports = router;
