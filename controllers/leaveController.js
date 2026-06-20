const LeaveExport = require('../models/Leave');
const { validationResult } = require('express-validator');
const moment = require('moment');
const mongoose = require('mongoose');

// 🔥 Notification imports
const DefaultNotification = require('../models/Notification');
const { sendNotificationToApprovers } = require('../utils/sendNotificationToAdmins');


// Resolve Leave Model
const resolveLeaveModel = (req) => {
  if (req && req.models && req.models.Leave) return req.models.Leave;
  if (LeaveExport && typeof LeaveExport.create === 'function') return LeaveExport;

  const schema = LeaveExport && LeaveExport.schema ? LeaveExport.schema : LeaveExport;
  if (mongoose.models && mongoose.models.Leave) return mongoose.models.Leave;
  return mongoose.model('Leave', schema);
};

// Resolve Notification Model
const resolveNotificationModel = (req) => {
  if (req && req.models && req.models.Notification) return req.models.Notification;

  const schema = DefaultNotification && DefaultNotification.schema
    ? DefaultNotification.schema
    : DefaultNotification;

  if (mongoose.models && mongoose.models.Notification) return mongoose.models.Notification;
  return mongoose.model('Notification', schema);
};

// @desc Apply for leave
exports.applyForLeave = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { leaveType, startDate, endDate, reason } = req.body;
    const Leave = resolveLeaveModel(req);

    if (!req.user || !req.user.employee) {
      return res.status(400).json({
        message: 'Authenticated user is not linked to an employee record'
      });
    }

    if (moment(endDate).isBefore(moment(startDate))) {
      return res.status(400).json({
        message: 'End date must be after start date'
      });
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

    // 🔥 NOTIFY ADMINS + LEADS
    try {
      await sendNotificationToApprovers(req, leave, 'leave_request',
        'New Leave Request',
        `${leave.employee.name} applied for ${leave.leaveType} leave from ${moment(leave.startDate).format('MMM D')} to ${moment(leave.endDate).format('MMM D')}`
      );
    } catch (err) {
      console.error('❌ Approver notification failed:', err);
    }

    res.status(201).json(leave);

  } catch (error) {
    console.error('Apply for leave error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc Get my leaves
exports.getMyLeaves = async (req, res) => {
  try {
    const Leave = resolveLeaveModel(req);


    const leaves = await Leave.find({
      employee: req.user.employee._id
    })
      .populate({
        path: 'approvals.approver',
        select: 'name position'
      })
      .sort({ createdAt: -1 });


    res.json(leaves);
  } catch (error) {
    console.error('Get my leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc Get all leaves (Admin)
exports.getAllLeaves = async (req, res) => {
  try {
    const { status } = req.query;
    let filter = {};

    if (status) {
      filter.status = status;
    }

    const Leave = resolveLeaveModel(req);


    const leaves = await Leave.find(filter)
      .populate('employee', 'name email department position')
      .populate({
        path: 'approvals.approver',
        select: 'name position'
      })
      .sort({ createdAt: -1 });


    res.json(leaves);
  } catch (error) {
    console.error('Get all leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc Update leave status (Approve/Reject)
exports.updateLeaveStatus = async (req, res) => { // Admin approval
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const Leave = resolveLeaveModel(req);
    const leave = await Leave.findById(req.params.id).populate('employee');

    if (!leave) {
      return res.status(404).json({ message: 'Leave not found' });
    }

    if (leave.status !== 'pending') {
      return res.status(400).json({ message: 'Can only update pending leaves' });
    }

    // Add admin approval
    leave.approvals = leave.approvals || [];
    leave.approvals.push({
      approver: req.user.employee._id,
      status,
      approverType: 'admin'
    });

    leave.updateStatusFromApprovals();

    await leave.save();

    await leave.populate('approvals.approver', 'name position');
    await leave.populate('employee', 'name email department');

    // Notify employee
    try {
      const Notification = resolveNotificationModel(req);
      await Notification.create({
        user: leave.employee._id,
        tenant: req.tenant?._id,
        type: 'leave_status',
        message: `Admin ${status} your leave request (${leave.status})`,
        relatedEntity: 'leave',
        entityId: leave._id,
        isRead: false
      });
    } catch (err) {
      console.error('Admin employee notification failed:', err);
    }

    // If now approved (lead + admin), notify employee
    if (leave.status === 'approved') {
      try {
        const Notification = resolveNotificationModel(req);
        await Notification.create({
          user: leave.employee._id,
          tenant: req.tenant?._id,
          type: 'leave_approved',
          message: 'Your leave request has been fully approved!',
          relatedEntity: 'leave',
          entityId: leave._id,
          isRead: false
        });
      } catch (err) {
        console.error('Final approval notification failed:', err);
      }
    }

    res.json(leave);

  } catch (error) {
    console.error('Update admin leave status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};


// @desc Get leave statistics
exports.getLeaveStats = async (req, res) => {
  try {
    const currentYear = moment().year();
    const Leave = resolveLeaveModel(req);

    const stats = await Leave.aggregate([
      {
        $match: {
          employee: req.user.employee._id,
          startDate: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`)
          }
        }
      },
      {
        $group: {
          _id: '$leaveType',
          totalDays: { $sum: '$totalDays' },
          approvedDays: {
            $sum: {
              $cond: [{ $eq: ['$status', 'approved'] }, '$totalDays', 0]
            }
          },
          pendingDays: {
            $sum: {
              $cond: [{ $eq: ['$status', 'pending'] }, '$totalDays', 0]
            }
          }
        }
      }
    ]);

    res.json(stats);

  } catch (error) {
    console.error('Get leave stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// NEW: Lead gets ALL pending leaves (global, no team filter)
exports.getAllPendingLeavesForLead = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const Leave = resolveLeaveModel(req);

    const leaves = await Leave.find({ status })
      .populate('employee', 'name email department position')
      .populate({
        path: 'approvals.approver',
        select: 'name',
        model: 'Employee'

      })
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error) {
    console.error('Get all pending leaves for lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// NEW: Team-lead get pending leaves for their team (KEEP EXISTING)
exports.getTeamPendingLeaves = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const Leave = resolveLeaveModel(req);
    const Employee = req.models?.Employee || mongoose.model('Employee');

    // Find team members under current team-lead
    const teamLeadEmployee = await Employee.findById(req.user.employee._id)
      .populate({
        path: 'teamMembers',
        select: 'name email department position _id',
        match: { isActive: true }
      });

    if (!teamLeadEmployee || !teamLeadEmployee.teamMembers?.length) {
      return res.json([]); // Empty team OK
    }

    const teamMemberIds = teamLeadEmployee.teamMembers.map(m => m._id);

    const leaves = await Leave.find({
      employee: { $in: teamMemberIds },
      status
    })
      .populate('employee', 'name email department position')
      .populate({
        path: 'approvals.approver',
        select: 'name',
        model: 'Employee'

      })
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error) {
    console.error('Get team pending leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// NEW: Team-lead update status for their team leaves
exports.updateTeamLeaveStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const Leave = resolveLeaveModel(req);
    const Employee = req.models?.Employee || mongoose.model('Employee');

    const leave = await Leave.findById(req.params.id);

    if (!leave) {
      return res.status(404).json({ message: 'Leave not found' });
    }

    // Verify this leave belongs to team-lead's team
    const teamLeadEmployee = await Employee.findById(req.user.employee._id)
      .populate({
        path: 'teamMembers',
        select: '_id',
        match: { isActive: true }
      });

    const teamMemberIds = teamLeadEmployee?.teamMembers?.map(m => m._id) || [];
    if (!teamMemberIds.includes(leave.employee)) {
      return res.status(403).json({ message: 'Not authorized for this leave' });
    }

    leave.status = status;
    leave.approvedBy = req.user.employee._id;
    leave.approvedAt = new Date();

    await leave.save();

    await leave.populate('employee', 'name email department');
    await leave.populate('approvedBy', 'name');

    // Notify employee
    try {
      const Notification = resolveNotificationModel(req);
      await Notification.create({
        user: leave.employee,
        tenant: req.tenant?._id,
        type: 'leave_status',
        message: `Your leave request has been ${status} by team lead`,
        isRead: false
      });
      // TODO: emitToUserClients if SSE available
    } catch (err) {
      console.error('Notification failed:', err);
    }

    res.json(leave);
  } catch (error) {
    console.error('Update team leave status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// NEW: Lead update status for ANY leave (DUAL APPROVAL)
exports.updateLeadLeaveStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const Leave = resolveLeaveModel(req);
    const leave = await Leave.findById(req.params.id).populate('employee');

    if (!leave) {
      return res.status(404).json({ message: 'Leave not found' });
    }

    if (leave.status !== 'pending') {
      return res.status(400).json({ message: 'Can only update pending leaves' });
    }

    // Prevent duplicate lead approval
    const existingLeadApproval = leave.approvals.find(
      a => a.approverType === 'lead' && a.approver.toString() === req.user.employee._id.toString()
    );
    if (existingLeadApproval) {
      return res.status(400).json({ message: 'Already approved by this lead' });
    }

    // Add lead approval
    leave.approvals = leave.approvals || [];
    leave.approvals.push({
      approver: req.user.employee._id,
      status,
      approverType: 'lead'
    });

    leave.updateStatusFromApprovals();

    await leave.save();

    await leave.populate('approvals.approver', 'name position');
    await leave.populate('employee', 'name email department');
    // Notify employee   
    try {
      const Notification = resolveNotificationModel(req);
      await Notification.create({
        user: leave.employee._id,
        tenant: req.tenant?._id,
        type: 'leave_status',
        message: `Lead ${status} your leave request (${leave.status})`,
        relatedEntity: 'leave',
        entityId: leave._id,
        isRead: false
      });
    } catch (err) {
      console.error('Employee notification failed:', err);
    }   // Notify all admins about lead decision   
    try {
      const User = resolveNotificationModel(req);
      const adminUsers = await User.find({
        tenant: req.tenant?._id, role: 'admin',
        isActive: true
      });
      for (const adminUser of adminUsers) {
        await Notification.create({
          user: adminUser._id,
          tenant: req.tenant?._id,
          type: 'lead_leave_decision',
          message: `Lead ${status} ${leave.employee.name}'s leave request (${leave.status})`,
          relatedEntity: 'leave',
          entityId: leave._id,
          isRead: false
        });
      }
    } catch (adminErr) {
      console.error('Admin notification failed:', adminErr);
    }

    // If now approved, notify employee final status
    if (leave.status === 'approved') {
      try {
        const Notification = resolveNotificationModel(req);
        await Notification.create({
          user: leave.employee._id,
          tenant: req.tenant?._id,
          type: 'leave_approved',
          message: 'Your leave request has been fully approved!',
          relatedEntity: 'leave',
          entityId: leave._id,
          isRead: false
        });
      } catch (err) {
        console.error('Final approval notification failed:', err);
      }
    }

    res.json(leave);
  } catch (error) {
    console.error('Update lead leave status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};



