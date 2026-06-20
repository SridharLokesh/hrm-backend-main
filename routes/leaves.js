const express = require('express');
const { body } = require('express-validator');
const {
  applyForLeave,
  getMyLeaves,
  getAllLeaves,
  updateLeaveStatus,
  getLeaveStats,
  getTeamPendingLeaves,
  updateTeamLeaveStatus,
  getAllPendingLeavesForLead,
  updateLeadLeaveStatus
} = require('../controllers/leaveController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.post('/', [
  body('leaveType').isIn(['sick', 'casual', 'annual', 'maternity', 'paternity', 'comp-off', 'other']),
  body('startDate').isDate(),
  body('endDate').isDate(),
  body('reason').notEmpty()
], applyForLeave);

router.get('/my-leaves', getMyLeaves);
router.get('/stats', getLeaveStats);
router.get('/', authorize('admin'), getAllLeaves);
router.get('/team-pending', getTeamPendingLeaves);
router.get('/lead-pending', authorize('team-lead'), getAllPendingLeavesForLead);

router.put('/:id/lead-status', authorize('team-lead'), updateLeadLeaveStatus);
router.put('/:id/team-status', authorize(['admin', 'team-lead']), updateTeamLeaveStatus);
router.put('/:id/status', authorize('admin'), updateLeaveStatus);

module.exports = router;
