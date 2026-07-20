const LeaveExport = require('../models/Leave');
const { validationResult } = require('express-validator');
const moment = require('moment');
const mongoose = require('mongoose');

const DefaultNotification = require('../models/Notification');
const DefaultUser = require('../models/User');
const { sendNotificationToApprovers } = require('../utils/sendNotificationToAdmins');
const { emitToUserClients } = require('./notificationController');

// ─── Model resolvers ──────────────────────────────────────────────────────────
const resolveLeaveModel = (req) => {
  if (req?.models?.Leave) return req.models.Leave;
  if (LeaveExport && typeof LeaveExport.create === 'function') return LeaveExport;
  const schema = LeaveExport?.schema ?? LeaveExport;
  if (mongoose.models.Leave) return mongoose.models.Leave;
  return mongoose.model('Leave', schema);
};

const resolveModel = (req, name, DefaultModel) => {
  if (req?.models?.[name]) return req.models[name];
  const schema = DefaultModel?.schema ?? DefaultModel;
  if (mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

// ─── Notification helper ──────────────────────────────────────────────────────
/**
 * Sends ONE approved/rejected notification to the employee.
 * Guards against duplicate: checks if a notification already exists for this
 * leave entity before creating another one.
 */
async function notifyEmployeeLeaveDecision(req, leave, status, approverType = 'admin') {
  try {
    const Notification = resolveModel(req, 'Notification', DefaultNotification);
    const User         = resolveModel(req, 'User',         DefaultUser);

    // ── GUARD: only send ONE notification per leave decision ──────────────────
    const alreadySent = await Notification.findOne({
      tenant:        req.tenant._id,
      relatedEntity: 'leave',
      entityId:      leave._id,
      type:          { $in: ['leave_approved', 'leave_rejected'] }
    }).lean();

    if (alreadySent) {
      console.log(`[Leave] Notification already sent for leave ${leave._id} — skipping.`);
      return;
    }

    const approverName = req.user?.employee?.name || req.user?.name || (approverType === 'lead' ? 'Lead' : 'Admin');
    const leaveType    = leave.leaveType || 'leave';
    const capitalType  = leaveType.charAt(0).toUpperCase() + leaveType.slice(1);
    const startLabel   = moment(leave.startDate).format('MMM D');
    const endLabel     = moment(leave.endDate).format('MMM D, YYYY');
    const isSameDay    = moment(leave.startDate).isSame(moment(leave.endDate), 'day');
    const dateRange    = isSameDay ? `${startLabel}, ${moment(leave.startDate).year()}` : `${startLabel} – ${endLabel}`;
    const role         = approverType === 'lead' ? 'lead' : 'admin';

    const isApproved = status === 'approved';
    const title   = isApproved ? 'Leave approved'  : 'Leave rejected';
    const type    = isApproved ? 'leave_approved'  : 'leave_rejected';
    const message = isApproved
      ? `Your ${capitalType} leave (${dateRange}) has been approved by ${role} (${approverName}).`
      : `Your ${capitalType} leave (${dateRange}) has been rejected by ${role} (${approverName}).`;

    const user = await User.findOne({
      employee: leave.employee._id || leave.employee,
      tenant:   req.tenant._id,
      isActive: true
    }).lean();

    if (!user) {
      console.warn('[Leave] No active user found for employee:', leave.employee._id || leave.employee);
      return;
    }

    const notification = await Notification.create({
      user:          user._id,
      employee:      leave.employee._id || leave.employee,
      tenant:        req.tenant._id,
      type,
      title,
      message,
      relatedEntity: 'leave',
      entityId:      leave._id,
      meta: { leaveType, startDate: leave.startDate, endDate: leave.endDate, approverName, approverType, status },
      isRead: false
    });

    emitToUserClients(user._id.toString(), notification);
  } catch (err) {
    console.error('[Leave] Employee notification failed:', err.message);
  }
}

// ─── @desc  Apply for leave ───────────────────────────────────────────────────
// ─── @route POST /api/leaves
// ─── @access Private
exports.applyForLeave = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { leaveType, startDate, endDate, reason } = req.body;
    const Leave = resolveLeaveModel(req);

    if (!req.user || !req.user.employee) {
      return res.status(400).json({ message: 'Authenticated user is not linked to an employee record' });
    }

    if (moment(endDate).isBefore(moment(startDate))) {
      return res.status(400).json({ message: 'End date must be after start date' });
    }

    const leave = await Leave.create({
      employee: req.user.employee._id,
      leaveType,
      startDate,
      endDate,
      reason
    });

    if (leave && typeof leave.populate === 'function') {
      await leave.populate('employee', 'name email department');
    }

    try {
      await sendNotificationToApprovers(req, leave, 'leave_request',
        'New Leave Request',
        `${leave.employee.name} applied for ${leave.leaveType} leave from ${moment(leave.startDate).format('MMM D')} to ${moment(leave.endDate).format('MMM D')}`
      );
    } catch (err) {
      console.error('Approver notification failed:', err);
    }

    res.status(201).json(leave);
  } catch (error) {
    console.error('Apply for leave error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Get my leaves ─────────────────────────────────────────────────────
// ─── @route GET /api/leaves/my-leaves
// ─── @access Private
exports.getMyLeaves = async (req, res) => {
  try {
    const Leave = resolveLeaveModel(req);

    const leaves = await Leave.find({ employee: req.user.employee._id })
      .populate({ path: 'approvals.approver', select: 'name position' })
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error) {
    console.error('Get my leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Get all leaves (Admin) ───────────────────────────────────────────
// ─── @route GET /api/leaves
// ─── @access Private/Admin
// Filters: ?status=pending|approved|rejected
// Results are scoped to this tenant only (req.tenant is already enforced by middleware)
exports.getAllLeaves = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const Leave = resolveLeaveModel(req);

    const leaves = await Leave.find(filter)
      .populate('employee', 'name email department position')
      .populate({ path: 'approvals.approver', select: 'name position' })
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error) {
    console.error('Get all leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Update leave status — Admin ──────────────────────────────────────
// ─── @route PUT /api/leaves/:id/status
// ─── @access Private/Admin
exports.updateLeaveStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const Leave = resolveLeaveModel(req);
    const leave = await Leave.findById(req.params.id).populate('employee');

    if (!leave) return res.status(404).json({ message: 'Leave not found' });

    // ── FIRST ACTION WINS: if already decided, block any further changes ──────
    if (leave.status !== 'pending') {
      return res.status(400).json({
        message: `Leave already ${leave.status}. First action wins — no further changes allowed.`
      });
    }

    leave.approvals = leave.approvals || [];
    leave.approvals.push({ approver: req.user.employee._id, status, approverType: 'admin' });

    // First approval/rejection wins — set status immediately
    leave.status     = status;
    leave.approvedBy = req.user.employee._id;
    leave.approvedAt = new Date();
    await leave.save();

    await leave.populate('approvals.approver', 'name position');
    await leave.populate('employee', 'name email department');

    // Notify employee — guard inside helper prevents duplicates
    await notifyEmployeeLeaveDecision(req, leave, status, 'admin');

    res.json(leave);
  } catch (error) {
    console.error('Update admin leave status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Get leave statistics ─────────────────────────────────────────────
// ─── @route GET /api/leaves/stats
// ─── @access Private
exports.getLeaveStats = async (req, res) => {
  try {
    const currentYear = moment().year();
    const Leave = resolveLeaveModel(req);

    const stats = await Leave.aggregate([
      {
        $match: {
          employee:  req.user.employee._id,
          startDate: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`)
          }
        }
      },
      {
        $group: {
          _id:          '$leaveType',
          totalDays:    { $sum: '$totalDays' },
          approvedDays: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$totalDays', 0] } },
          pendingDays:  { $sum: { $cond: [{ $eq: ['$status', 'pending']  }, '$totalDays', 0] } }
        }
      }
    ]);

    res.json(stats);
  } catch (error) {
    console.error('Get leave stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Lead: get ALL leaves (all statuses, for lead view) ───────────────
// ─── @route GET /api/leaves/lead/pending
// ─── @access Private/Lead
exports.getAllPendingLeavesForLead = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const Leave = resolveLeaveModel(req);

    const leaves = await Leave.find({ status })
      .populate('employee', 'name email department position')
      .populate({ path: 'approvals.approver', select: 'name', model: 'Employee' })
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error) {
    console.error('Get all pending leaves for lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Team lead: get pending leaves for their team ─────────────────────
// ─── @route GET /api/leaves/team/pending
// ─── @access Private/Lead
exports.getTeamPendingLeaves = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const Leave    = resolveLeaveModel(req);
    const Employee = req.models?.Employee || mongoose.model('Employee');

    const teamLeadEmployee = await Employee.findById(req.user.employee._id)
      .populate({ path: 'teamMembers', select: 'name email department position _id', match: { isActive: true } });

    if (!teamLeadEmployee || !teamLeadEmployee.teamMembers?.length) {
      return res.json([]);
    }

    const teamMemberIds = teamLeadEmployee.teamMembers.map(m => m._id);

    const leaves = await Leave.find({ employee: { $in: teamMemberIds }, status })
      .populate('employee', 'name email department position')
      .populate({ path: 'approvals.approver', select: 'name', model: 'Employee' })
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error) {
    console.error('Get team pending leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Team lead: update leave for their team member ────────────────────
// ─── @route PUT /api/leaves/:id/team-status
// ─── @access Private/Lead
exports.updateTeamLeaveStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const Leave    = resolveLeaveModel(req);
    const Employee = req.models?.Employee || mongoose.model('Employee');
    const leave    = await Leave.findById(req.params.id).populate('employee');

    if (!leave) return res.status(404).json({ message: 'Leave not found' });

    // ── FIRST ACTION WINS ─────────────────────────────────────────────────────
    if (leave.status !== 'pending') {
      return res.status(400).json({
        message: `Leave already ${leave.status}. First action wins — no further changes allowed.`
      });
    }

    const teamLeadEmployee = await Employee.findById(req.user.employee._id)
      .populate({ path: 'teamMembers', select: '_id', match: { isActive: true } });

    const teamMemberIds = teamLeadEmployee?.teamMembers?.map(m => m._id.toString()) || [];
    if (!teamMemberIds.includes(leave.employee._id.toString())) {
      return res.status(403).json({ message: 'Not authorized for this leave' });
    }

    // Use the same approvals array pattern for consistency
    leave.approvals = leave.approvals || [];
    leave.approvals.push({ approver: req.user.employee._id, status, approverType: 'lead' });

    leave.status     = status;
    leave.approvedBy = req.user.employee._id;
    leave.approvedAt = new Date();
    await leave.save();

    await leave.populate('employee', 'name email department');
    await leave.populate('approvals.approver', 'name position');

    // Notify employee — guard inside helper prevents duplicates
    await notifyEmployeeLeaveDecision(req, leave, status, 'lead');

    res.json(leave);
  } catch (error) {
    console.error('Update team leave status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Lead: update status for ANY leave ────────────────────────────────
// ─── @route PUT /api/leaves/:id/lead-status
// ─── @access Private/Lead
exports.updateLeadLeaveStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const Leave = resolveLeaveModel(req);
    const leave = await Leave.findById(req.params.id).populate('employee');

    if (!leave) return res.status(404).json({ message: 'Leave not found' });

    // ── FIRST ACTION WINS ─────────────────────────────────────────────────────
    if (leave.status !== 'pending') {
      return res.status(400).json({
        message: `Leave already ${leave.status}. First action wins — no further changes allowed.`
      });
    }

    // Prevent same lead from acting twice
    const existingLeadApproval = leave.approvals.find(
      a => a.approverType === 'lead' && a.approver.toString() === req.user.employee._id.toString()
    );
    if (existingLeadApproval) {
      return res.status(400).json({ message: 'You have already acted on this leave' });
    }

    leave.approvals = leave.approvals || [];
    leave.approvals.push({ approver: req.user.employee._id, status, approverType: 'lead' });

    // First action wins — set final status immediately
    leave.status     = status;
    leave.approvedBy = req.user.employee._id;
    leave.approvedAt = new Date();
    await leave.save();

    await leave.populate('approvals.approver', 'name position');
    await leave.populate('employee', 'name email department');

    // Notify employee — guard inside helper prevents duplicates
    await notifyEmployeeLeaveDecision(req, leave, status, 'lead');

    res.json(leave);
  } catch (error) {
    console.error('Update lead leave status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};