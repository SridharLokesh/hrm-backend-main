const express = require('express');
const router = express.Router();
const {
  // CRUD
  createShift,
  getShifts,
  getShift,
  updateShift,
  deleteShift,
  // Assignments
  assignToDepartments,
  assignToRoles,
  assignToEmployees,
  removeDepartments,
  removeRoles,
  removeEmployees,
  // Queries
  getEmployeeShift,
  getMyShift,
  getMyShiftsToday,
  getShiftEmployees,
  getDepartments,
  getRoles,
  getShiftSummary
} = require('../controllers/shiftController');
const { protect, adminOnly } = require('../middleware/auth');

// All shift routes require authentication
router.use(protect);

// Public (authenticated) routes
router.get('/my-shift', getMyShift);
router.get('/today', getMyShiftsToday);  // New multi-shift endpoint
router.get('/departments', getDepartments);
router.get('/roles', getRoles);
router.get('/summary', adminOnly, getShiftSummary);

// Employee shift query (admin only)
router.get('/employee/:employeeId', adminOnly, getEmployeeShift);

// Shift CRUD (admin only)
router.route('/')
  .get(adminOnly, getShifts)
  .post(adminOnly, createShift);

router.route('/:id')
  .get(adminOnly, getShift)
  .put(adminOnly, updateShift)
  .delete(adminOnly, deleteShift);

// Assignment routes (admin only)
router.post('/:id/assign/departments', adminOnly, assignToDepartments);
router.post('/:id/assign/roles', adminOnly, assignToRoles);
router.post('/:id/assign/employees', adminOnly, assignToEmployees);

// Removal routes (admin only)
router.delete('/:id/assign/departments', adminOnly, removeDepartments);
router.delete('/:id/assign/roles', adminOnly, removeRoles);
router.delete('/:id/assign/employees', adminOnly, removeEmployees);

// Get employees by shift
router.get('/:id/employees', adminOnly, getShiftEmployees);

module.exports = router;