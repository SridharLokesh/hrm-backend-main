const DefaultPermission = require('../models/Permission');
const DefaultAttendance = require('../models/Attendance');
const DefaultEmployee = require('../models/Employee');
const DefaultNotification = require('../models/Notification');
const { sendNotificationToApprovers } = require('../utils/sendNotificationToAdmins');
const DefaultUser = require('../models/User');
const mongoose = require('mongoose');

const clients = new Map(); 
//  SSE emit
const { emitToUserClients } = require('./notificationController');

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};
const moment = require('moment');

// @desc    Apply for permission
// @route   POST /api/permissions
// @access  Private
exports.applyForPermission = async (req, res) => {
  try {
    const { permissionType, date, startTime, endTime, reason } = req.body;

    console.log('Received permission data:', {
      permissionType,
      date,
      startTime,
      endTime,
      reason,
    });

    // Validate required fields
    if (!permissionType || !date || !startTime || !endTime || !reason) {
      return res.status(400).json({
        message:
          'All fields are required: permissionType, date, startTime, endTime, reason',
      });
    }

    // Validate date is not in past
    const permissionDate = moment(date).startOf('day');
    const today = moment().startOf('day');

    if (permissionDate.isBefore(today)) {
      return res
        .status(400)
        .json({ message: 'Cannot apply for permission for past dates' });
    }

    const parseTimeWithAMPM = (timeStr, dateStr) => {
      let time = timeStr.trim().toUpperCase();
      let [timePart, modifier] = time.split(' ');

      let [hours, minutes] = timePart.split(':');
      hours = parseInt(hours);
      minutes = parseInt(minutes || '0');

      console.log('Parsing time:', {
        timeStr,
        timePart,
        modifier,
        hours,
        minutes,
      });

      // Handle AM/PM
      if (modifier === 'PM' && hours < 12) {
        hours += 12;
      }
      if (modifier === 'AM' && hours === 12) {
        hours = 0;
      }

      // Handle 24-hour format (if no AM/PM provided)
      if (!modifier && hours < 12 && timeStr.includes('04')) {
        // If it's 04:00 without AM/PM, assume PM for early departure
        hours += 12;
      }

      // Create date in IST timezone (UTC+5:30)
      const timeString = `${dateStr}T${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:00+05:30`;
      
      return moment(timeString).toDate(); // This will store as UTC but represent IST time
    };

    const startDateTime = parseTimeWithAMPM(startTime, date);
    const endDateTime = parseTimeWithAMPM(endTime, date);

    console.log('Final parsed times:', {
      startTime: startTime,
      startDateTime: startDateTime.toISOString(),
      startDateTimeLocal: startDateTime.toString(),
      endTime: endTime,
      endDateTime: endDateTime.toISOString(),
      endDateTimeLocal: endDateTime.toString(),
    });

    // Validate that dates are valid
    if (!moment(startDateTime).isValid() || !moment(endDateTime).isValid()) {
      return res.status(400).json({ message: 'Invalid date or time format' });
    }

    // Validate that end time is after start time
    if (moment(endDateTime).isSameOrBefore(moment(startDateTime))) {
      return res
        .status(400)
        .json({ message: 'End time must be after start time' });
    }

    // Calculate duration in hours
    const duration = moment(endDateTime).diff(
      moment(startDateTime),
      'hours',
      true
    );

    console.log('Calculated duration:', duration);

    // Validate duration is positive
    if (duration <= 0) {
      return res.status(400).json({
        message:
          'Duration must be positive. End time should be after start time.',
      });
    }

    // Check for existing permission on same date
    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);
    const existingPermission = await PermissionModel.findOne({
      employee: req.user.employee._id,
      date: permissionDate.toDate(),
      status: { $in: ['pending', 'approved'] },
    });

    if (existingPermission) {
      return res
        .status(400)
        .json({ message: 'Already have a permission request for this date' });
    }

    const permission = await PermissionModel.create({
      employee: req.user.employee._id,
      permissionType,
      date: permissionDate.toDate(),
      startTime: startDateTime,
      endTime: endDateTime,
      duration: parseFloat(duration.toFixed(2)),
      reason,
    });

    await permission.populate('employee', 'name email department position');

// 🔥 NOTIFY ADMINS + LEADS
    try {
      await sendNotificationToApprovers(req, permission, 'permission_request', 
        'New Permission Request',
        `${permission.employee.name} requested ${permission.permissionType} permission on ${moment(permission.date).format('MMM D')} (${moment(permission.startTime).format('LT')} - ${moment(permission.endTime).format('LT')})`
      );
    } catch (err) {
      console.error('❌ Approver notification failed:', err);
    }

    res.status(201).json(permission);

  } catch (error) {
    console.error('Apply for permission error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get my permissions
// @route   GET /api/permissions/my-permissions
// @access  Private
exports.getMyPermissions = async (req, res) => {
  try {
    const { month, year, status } = req.query;
    let filter = { employee: req.user.employee._id };

    if (month && year) {
      // CHANGE: Use local time instead of UTC
      const startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      const endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
      filter.date = { $gte: startDate, $lte: endDate };
    }

    if (status) {
      filter.status = status;
    }

    const PermissionModel2 = resolveModel(req, 'Permission', DefaultPermission);
    const permissions = await PermissionModel2.find(filter)
          .populate({
              path: 'approvals.approver',
              select: 'name',
              model: 'Employee'
      
          })
          .sort({ date: -1 });

    res.json(permissions);
  } catch (error) {
    console.error('Get my permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};


// @desc    Get all permissions (Admin/Manager)
// @route   GET /api/permissions
// @access  Private/Admin
exports.getAllPermissions = async (req, res) => {
  try {
    const { status, month, year, employeeId } = req.query;
    let filter = {};

    if (status) {
      filter.status = status;
    }

    if (month && year) {
      // CHANGE: Use local time instead of UTC
      const startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      const endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
      filter.date = { $gte: startDate, $lte: endDate };
    }

    if (employeeId) {
      filter.employee = employeeId;
    }

    const PermissionModel3 = resolveModel(req, 'Permission', DefaultPermission);
    const permissions = await PermissionModel3.find(filter)
          .populate('employee', 'name email department position')
          .populate({
              path: 'approvals.approver',
              select: 'name',
              model: 'Employee'
      
          })
          .sort({ createdAt: -1 });

    res.json(permissions);
  } catch (error) {
    console.error('Get all permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update permission status
// @route   PUT /api/permissions/:id/status
// @access  Private/Admin
exports.updatePermissionStatus = async (req, res) => { // Admin approval
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const PermissionModel4 = resolveModel(req, 'Permission', DefaultPermission);
    const permission = await PermissionModel4.findById(req.params.id).populate('employee', 'name email department position');

    if (!permission) {
      return res.status(404).json({ message: 'Permission not found' });
    }

    if (permission.status !== 'pending') {
      return res.status(400).json({ message: 'Can only update pending permissions' });
    }

    // Add admin approval
    permission.approvals = permission.approvals || [];
    permission.approvals.push({
      approver: req.user.employee._id,
      status,
      approverType: 'admin'
    });

    // Directly compute status: any approval = approved, any rejection = rejected
    const hasRejection = permission.approvals.some(a => a.status === 'rejected');
    const anyApproval = permission.approvals.some(a => a.status === 'approved');
    if (hasRejection) {
      permission.status = 'rejected';
    } else if (anyApproval) {
      permission.status = 'approved';
    } else {
      permission.status = 'pending';
    }

    await permission.save();

    await permission.populate('approvals.approver', 'name position');

    // Notify employee
    try {
      const Notification = resolveModel(req, 'Notification', DefaultNotification);
      const User = resolveModel(req, 'User', DefaultUser);

      const user = await User.findOne({
        employee: permission.employee._id,
        tenant: req.tenant._id,
        isActive: true
      });

      if (user) {
        const notification = await Notification.create({
          user: user._id,
          tenant: req.tenant._id,
          type: 'permission_status',
          message: `Admin ${status} your permission request (${permission.status})`,
          relatedEntity: 'permission',
          entityId: permission._id,
          employee: permission.employee._id,
          title: 'Permission Update',
          isRead: false
        });

        emitToUserClients(user._id.toString(), notification);
      }
    } catch (err) {
      console.error('Admin employee notification failed:', err);
    }

    // If now approved, notify employee final status
    if (permission.status === 'approved') {
      try {
        const Notification = resolveModel(req, 'Notification', DefaultNotification);
        const User = resolveModel(req, 'User', DefaultUser);

        const user = await User.findOne({
          employee: permission.employee._id,
          tenant: req.tenant._id,
          isActive: true
        });

        if (user) {
          const notification = await Notification.create({
            user: user._id,
            tenant: req.tenant._id,
            type: 'permission_approved',
            message: 'Your permission request has been fully approved!',
            relatedEntity: 'permission',
            entityId: permission._id,
            employee: permission.employee._id,
            title: 'Permission Approved',
            isRead: false
          });

          emitToUserClients(user._id.toString(), notification);
        }
      } catch (err) {
        console.error('Final permission approval notification failed:', err);
      }
    }

    res.json(permission);

  } catch (error) {
    console.error('Update admin permission status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};


// @desc    Get permission statistics
// @route   GET /api/permissions/stats
// @access  Private
exports.getPermissionStats = async (req, res) => {
  try {
    const currentYear = moment().year();

    const PermissionModel5 = resolveModel(req, 'Permission', DefaultPermission);
    const stats = await PermissionModel5.aggregate([
      {
        $match: {
          employee: req.user.employee._id,
          date: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`),
          },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalHours: { $sum: '$duration' },
        },
      },
    ]);

    // Get monthly breakdown

  const monthlyStats = await PermissionModel5.aggregate([
      {
        $match: {
          employee: req.user.employee._id,
          date: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`),
          },
        },
      },
      {
        $group: {
          _id: {
            month: { $month: '$date' },
            status: '$status',
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { '_id.month': 1 },
      },
    ]);

    res.json({
      yearlyStats: stats,
      monthlyStats: monthlyStats,
    });
  } catch (error) {
    console.error('Get permission stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// NEW: Lead gets ALL pending permissions (global)
exports.getAllPendingPermissionsForLead = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);

    const permissions = await PermissionModel.find({ status })
          .populate('employee', 'name email department position')
          .populate({
              path: 'approvals.approver',
              select: 'name position',
              model: 'Employee'
      
          })
          .sort({ createdAt: -1 });

    res.json(permissions);
  } catch (error) {
    console.error('Get all pending permissions for lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// NEW: Lead update status for ANY permission
exports.updateLeadPermissionStatus = async (req, res) => { // Dual approval
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);
    const permission = await PermissionModel.findById(req.params.id).populate('employee');

    if (!permission) {
      return res.status(404).json({ message: 'Permission not found' });
    }

    if (permission.status !== 'pending') {
      return res.status(400).json({ message: 'Can only update pending permissions' });
    }

    // Prevent duplicate lead approval
    const existingLeadApproval = permission.approvals.find(
      a => a.approverType === 'lead' && a.approver.toString() === req.user.employee._id.toString()
    );
    if (existingLeadApproval) {
      return res.status(400).json({ message: 'Already approved by this lead' });
    }

    // Add lead approval
    permission.approvals = permission.approvals || [];
    permission.approvals.push({
      approver: req.user.employee._id,
      status,
      approverType: 'lead'
    });

    // Directly compute status: any approval = approved, any rejection = rejected
    const hasRejectionL = permission.approvals.some(a => a.status === 'rejected');
    const anyApprovalL = permission.approvals.some(a => a.status === 'approved');
    if (hasRejectionL) {
      permission.status = 'rejected';
    } else if (anyApprovalL) {
      permission.status = 'approved';
    } else {
      permission.status = 'pending';
    }

    await permission.save();

    await permission.populate('approvals.approver', 'name position');
    await permission.populate('employee', 'name email department');

    // Employee notification
    try {
      const Notification = resolveModel(req, 'Notification', DefaultNotification);
      const User = resolveModel(req, 'User', DefaultUser);
      const employeeUser = await User.findOne({ employee: permission.employee._id, tenant: req.tenant._id });
      if (employeeUser) {
        await Notification.create({
          user: employeeUser._id,
          employee: permission.employee._id,
          title: 'Permission Update',
          message: `Lead ${status} your permission request (Status: ${permission.status})`,
          type: 'permission_status',
          tenant: req.tenant._id,
          relatedEntity: 'permission',
          entityId: permission._id,
          isRead: false
        });
      }
    } catch (err) {
      console.error('Employee notification failed:', err);
    }

    // Admin notification  
    try {
      const User = resolveModel(req, 'User', DefaultUser);
      const adminUsers = await User.find({ role: 'admin', tenant: req.tenant._id, isActive: true });
      const Notification = resolveModel(req, 'Notification', DefaultNotification);
      for (const adminUser of adminUsers) {
        await Notification.create({
          user: adminUser._id,
          employee: permission.employee._id,
          title: 'Lead Permission Decision',
          message: `Lead ${status} ${permission.employee.name}'s ${permission.permissionType} (${permission.status})`,
          type: 'general',
          tenant: req.tenant._id,
          relatedEntity: 'permission',
          entityId: permission._id,
          isRead: false
        });
      }
    } catch (err) {
      console.error('Admin notification failed:', err);
    }

    // If now approved (both), notify employee final status
    if (permission.status === 'approved') {
      try {
        const Notification = resolveModel(req, 'Notification', DefaultNotification);
        await Notification.create({
          user: permission.employee._id,
          tenant: req.tenant?._id,
          type: 'permission_approved',
          message: 'Your permission request has been fully approved!',
          relatedEntity: 'permission',
          entityId: permission._id,
          employee: permission.employee._id,
          title: 'Permission Approved',
          isRead: false
        });
      } catch (err) {
        console.error('Final permission approval notification failed:', err);
      }
    }

    res.json(permission);
  } catch (error) {
    console.error('Update lead permission status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};


// Helper function (DISABLED - manual checkin required)
// const updateAttendanceWithPermission = async (req, permission) => { ... };

// @desc    Fix stale permission records (status='pending' but has approvals)
// @route   POST /api/permissions/fix-stale
// @access  Private/Admin
exports.fixStalePermissions = async (req, res) => {
  try {
    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);
    // Find all 'pending' records that actually have an approval entry
    const stale = await PermissionModel.find({ status: 'pending', 'approvals.0': { $exists: true } });
    let fixed = 0;
    for (const perm of stale) {
      const hasRejection = perm.approvals.some(a => a.status === 'rejected');
      const anyApproval = perm.approvals.some(a => a.status === 'approved');
      if (hasRejection) { perm.status = 'rejected'; await perm.save(); fixed++; }
      else if (anyApproval) { perm.status = 'approved'; await perm.save(); fixed++; }
    }
    res.json({ message: `Fixed ${fixed} of ${stale.length} stale permission records.` });
  } catch (error) {
    console.error('Fix stale permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
