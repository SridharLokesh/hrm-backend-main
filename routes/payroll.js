const express = require('express');
const {
  generatePayroll,
  getMyPayroll,
  getAllPayroll,
  updatePayrollStatus,
  getPayrollSummary,
  getPayrollById
} = require('../controllers/payrollController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.post('/generate', authorize('admin'), generatePayroll);
router.get('/my-payroll', getMyPayroll);
router.get('/', authorize('admin'), getAllPayroll);
router.get('/:id', getPayrollById);
router.put('/:id/status', authorize('admin'), updatePayrollStatus);
router.get('/summary', authorize('admin'), getPayrollSummary);

module.exports = router;