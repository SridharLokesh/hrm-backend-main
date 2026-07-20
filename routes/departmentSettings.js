const express = require('express');
const router = express.Router();
const {
  getDepartmentSettings,
  createDepartmentSetting,
  updateDepartmentSetting,
  deleteDepartmentSetting,
  getRequiredDepartments
} = require('../controllers/departmentSettingController');
const { protect, authorize, adminOnly } = require('../middleware/auth');

// All routes require authentication.
router.use(protect);

// FIX: this router previously ran `router.use(adminOnly)` globally, which
// blocked GET /api/department-settings for team-leads/managers. TaskForm.jsx
// calls departmentSettingService.getAll() for EVERY role (it's how the
// department dropdown gets populated, then locked to the lead's own
// department client-side) — not just admin. That 403 was breaking the
// "Create Task" form for anyone who wasn't an admin.
//
// Reads (GET) are now open to admin/manager/team-lead. Writes
// (create/update/delete) remain admin-only, same as before.

router.get('/', authorize('admin', 'manager', 'team-lead'), getDepartmentSettings);
router.get('/required', authorize('admin', 'manager', 'team-lead'), getRequiredDepartments);

// Create/update/delete stay admin-only.
router.post('/', adminOnly, createDepartmentSetting);
router.delete('/:departmentName', adminOnly, deleteDepartmentSetting);
router.put('/:departmentName', adminOnly, updateDepartmentSetting);

module.exports = router;