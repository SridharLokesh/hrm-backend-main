const express = require('express');
const { getAdminDashboard, getEmployeeDashboard } = require('../controllers/dashboardController');
const { protect, authorize } = require('../middleware/auth');
const { getAnalyticsDashboard } = require('../controllers/analyticsController');
const router = express.Router();

router.use(protect);

router.get('/admin', authorize('admin'), getAdminDashboard);
router.get('/employee', getEmployeeDashboard);
router.get('/analytics', authorize('admin'), getAnalyticsDashboard);
module.exports = router;