// routes/dailyUpdates.js
const express = require('express');
const {
  getTodayUpdate,
  saveDailyUpdate,
  getMyUpdates,
  checkoutGate,
  adminGetAllUpdates,
  adminGetUpdateById,
  adminEditUpdate,
  adminDeleteUpdate,
  adminExportUpdates,
  adminGetEmployeesWithUpdates
} = require('../controllers/dailyUpdateController');

const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(protect);

// ─── User Routes ─────────────────────────────────────────────────────────────

// GET  /api/daily-updates/today          → today's update (or null)
router.get('/today', getTodayUpdate);

// GET  /api/daily-updates/checkout-gate  → can user check out?
router.get('/checkout-gate', checkoutGate);

// GET  /api/daily-updates/my?month=YYYY-MM  → user's own history
router.get('/my', getMyUpdates);

// POST /api/daily-updates               → create/update today's entry
router.post('/', saveDailyUpdate);

// ─── Admin Routes ─────────────────────────────────────────────────────────────

// GET  /api/daily-updates/admin/employees  → employees who have updates (for dropdown)
router.get('/admin/employees', authorize('admin'), adminGetEmployeesWithUpdates);

// GET  /api/daily-updates/admin/export?month=YYYY-MM&employeeId=  → flat JSON for Excel
router.get('/admin/export', authorize('admin'), adminExportUpdates);

// GET  /api/daily-updates/admin?month=YYYY-MM&employeeId=&page=&limit=
router.get('/admin', authorize('admin'), adminGetAllUpdates);

// GET  /api/daily-updates/admin/:id
router.get('/admin/:id', authorize('admin'), adminGetUpdateById);

// PUT  /api/daily-updates/admin/:id
router.put('/admin/:id', authorize('admin'), adminEditUpdate);

// DELETE /api/daily-updates/admin/:id
router.delete('/admin/:id', authorize('admin'), adminDeleteUpdate);

module.exports = router;