const express = require('express');
const { body } = require('express-validator');
const {
  createEmployee,
  getEmployees,
  getEmployee,
  updateEmployee,
  getEmployeesDebug,
  deleteEmployee,
  getMyProfile,
  updateMyProfile,
  getTeamStructure,
  assignTeamMember,
  removeTeamMember
} = require('../controllers/employeeController');
const { protect, authorize } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.use(protect);
router.use(requireTenant);

// Admin routes
router.post('/', 
  authorize('admin'),
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Please include a valid email'),
    body('department').notEmpty().withMessage('Department is required'),
    body('position').notEmpty().withMessage('Position is required'),
    body('salary').isNumeric().withMessage('Salary must be a number'),
    body('role').isIn(['employee', 'team-lead', 'manager']).withMessage('Role must be one of: employee, team-lead, manager')
  ],
  createEmployee
);

router.get('/', authorize('admin'), getEmployees);
router.get('/debug-counts', authorize('admin'), getEmployeesDebug);



router.delete('/:id', authorize('admin'), deleteEmployee);
router.put('/:id', 
  authorize('admin'),
  [
    body('role').optional().isIn(['employee', 'team-lead', 'manager']).withMessage('Role must be one of: employee, team-lead, manager'),
    body('salary').optional().isNumeric().withMessage('Salary must be a number'),
    body('name').optional().notEmpty().withMessage('Name is required if provided'),
  ],
  updateEmployee
);
// Admin: allow/deny mobile access for a given employee's user account
router.put('/:id/mobile-allow', authorize('admin'), require('./../controllers/employeeController').setMobileAccess);
router.get('/:id', getEmployee);

// Employee self-service routes
router.get('/profile/me', getMyProfile);
router.put('/profile/me', updateMyProfile);

module.exports = router;
