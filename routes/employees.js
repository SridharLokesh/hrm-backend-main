// routes/employees.js
//
// FIX: this file previously defined its own inline handlers instead of
// using controllers/employeeController.js. Those inline handlers filtered
// on `status: 'active'` (a field that doesn't exist on the Employee schema
// — the real field is `isActive`, used everywhere else in the codebase),
// so every query silently returned zero results. The `/for-assignment`
// stub also scoped non-admins by `teamLead` (direct reports only) instead
// of department, and never populated `user` for role badges.
//
// employeeController.js already has the correct, working implementations
// (department-scoped for-assignment, role population, proper create/update
// with User-account sync, mobile-allow, etc.) — this file just needs to
// route to them.

const express = require('express');
const router = express.Router();

const { protect, authorize } = require('../middleware/auth');
const employeeController = require('../controllers/employeeController');

// All employee routes require an authenticated user.
router.use(protect);

// ─────────────────────────────────────────────────────────────────────
// IMPORTANT: literal-path routes (/roles, /for-assignment, /my-team,
// /profile/me, /debug-counts) must be registered BEFORE the '/:id'
// param route, or Express will try to match e.g. "roles" as an :id.
// ─────────────────────────────────────────────────────────────────────

// GET /api/employees/roles — any authenticated user
router.get('/roles', employeeController.getRoles);

// GET /api/employees/for-assignment — admin (all active), manager/team-lead
// (own department only, scoping handled inside the controller)
router.get(
  '/for-assignment',
  authorize('admin', 'manager', 'team-lead'),
  employeeController.getEmployeesForAssignment
);

// GET /api/employees/my-team — manager/team-lead's direct reports
router.get(
  '/my-team',
  authorize('manager', 'team-lead'),
  employeeController.getMyTeam
);

// GET /api/employees/profile/me — current logged-in employee's own profile
router.get('/profile/me', employeeController.getMyProfile);
router.put('/profile/me', employeeController.updateMyProfile);

// GET /api/employees/debug-counts — admin only, diagnostics
router.get('/debug-counts', authorize('admin'), employeeController.getEmployeesDebug);

// ─────────────────────────────────────────────────────────────────────
// GET /api/employees — admin only, full roster
// ─────────────────────────────────────────────────────────────────────
router.get('/', authorize('admin'), employeeController.getEmployees);

// ─────────────────────────────────────────────────────────────────────
// POST /api/employees — admin only, creates Employee + linked User
// ─────────────────────────────────────────────────────────────────────
router.post('/', authorize('admin'), employeeController.createEmployee);

// ─────────────────────────────────────────────────────────────────────
// GET /api/employees/:id — admin can view anyone; others only themselves
// (enforced inside the controller)
// ─────────────────────────────────────────────────────────────────────
router.get('/:id', employeeController.getEmployee);

// ─────────────────────────────────────────────────────────────────────
// PUT /api/employees/:id — admin only (role changes gated inside too)
// ─────────────────────────────────────────────────────────────────────
router.put('/:id', authorize('admin'), employeeController.updateEmployee);

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/employees/:id — admin only, soft delete
// ─────────────────────────────────────────────────────────────────────
router.delete('/:id', authorize('admin'), employeeController.deleteEmployee);

// ─────────────────────────────────────────────────────────────────────
// PUT /api/employees/:id/mobile-allow — admin only
// ─────────────────────────────────────────────────────────────────────
router.put('/:id/mobile-allow', authorize('admin'), employeeController.setMobileAccess);

module.exports = router;