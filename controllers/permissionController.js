const DefaultPermission   = require('../models/Permission');
const DefaultAttendance   = require('../models/Attendance');
const DefaultEmployee     = require('../models/Employee');
const DefaultNotification = require('../models/Notification');
const DefaultUser         = require('../models/User');
const { sendNotificationToApprovers } = require('../utils/sendNotificationToAdmins');
const { emitToUserClients } = require('./notificationController');
const mongoose = require('mongoose');
const moment   = require('moment');

// ─── Model resolver ───────────────────────────────────────────────────────────
const resolveModel = (req, name, defaultSchema) => {
  if (req?.models?.[name]) return req.models[name];
  const schema = defaultSchema?.schema ?? defaultSchema;
  if (mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

// ─── Notification helper ──────────────────────────────────────────────────────
/**
 * Sends ONE approved/rejected notification to the employee.
 * Guards against duplicate: checks if a notification already exists for this
 * permission entity before creating another one.
 */
async function notifyEmployeePermissionDecision(req, permission, status, approverType = 'admin') {
  try {
    const Notification = resolveModel(req, 'Notification', DefaultNotification);
    const User         = resolveModel(req, 'User',         DefaultUser);

    // ── GUARD: only send ONE notification per permission decision ─────────────
    const alreadySent = await Notification.findOne({
      tenant:        req.tenant._id,
      relatedEntity: 'permission',
      entityId:      permission._id,
      type:          { $in: ['permission_approved', 'permission_rejected'] }
    }).lean();

    if (alreadySent) {
      console.log(`[Permission] Notification already sent for permission ${permission._id} — skipping.`);
      return;
    }

    const approverName = req.user?.employee?.name || req.user?.name || (approverType === 'lead' ? 'Lead' : 'Admin');
    const permType     = permission.permissionType || 'permission';
    const capitalType  = permType.charAt(0).toUpperCase() + permType.slice(1);
    const dateLabel    = moment(permission.date).format('MMM D, YYYY');
    const timeRange    = `${moment(permission.startTime).format('h:mm A')} – ${moment(permission.endTime).format('h:mm A')}`;
    const role         = approverType === 'lead' ? 'lead' : 'admin';

    const isApproved = status === 'approved';
    const title   = isApproved ? 'Permission approved'  : 'Permission rejected';
    const type    = isApproved ? 'permission_approved'  : 'permission_rejected';
    const message = isApproved
      ? `Your ${capitalType} permission on ${dateLabel} (${timeRange}) has been approved by ${role} (${approverName}).`
      : `Your ${capitalType} permission on ${dateLabel} (${timeRange}) has been rejected by ${role} (${approverName}).`;

    const employeeId = permission.employee?._id || permission.employee;
    const user = await User.findOne({
      employee: employeeId,
      tenant:   req.tenant._id,
      isActive: true
    }).lean();

    if (!user) {
      console.warn('[Permission] No active user found for employee:', employeeId);
      return;
    }

    const notification = await Notification.create({
      user:          user._id,
      employee:      employeeId,
      tenant:        req.tenant._id,
      type,
      title,
      message,
      relatedEntity: 'permission',
      entityId:      permission._id,
      meta: {
        permissionType: permType,
        date:           permission.date,
        startTime:      permission.startTime,
        endTime:        permission.endTime,
        approverName,
        approverType,
        status
      },
      isRead: false
    });

    emitToUserClients(user._id.toString(), notification);
  } catch (err) {
    console.error('[Permission] Employee notification failed:', err.message);
  }
}

// ─── @desc  Apply for permission ─────────────────────────────────────────────
// ─── @route POST /api/permissions
// ─── @access Private
exports.applyForPermission = async (req, res) => {
  try {
    const { permissionType, date, startTime, endTime, reason } = req.body;

    if (!permissionType || !date || !startTime || !endTime || !reason) {
      return res.status(400).json({
        message: 'All fields are required: permissionType, date, startTime, endTime, reason'
      });
    }

    const permissionDate = moment(date).startOf('day');
    const today          = moment().startOf('day');

    if (permissionDate.isBefore(today)) {
      return res.status(400).json({ message: 'Cannot apply for permission for past dates' });
    }

    const parseTimeWithAMPM = (timeStr, dateStr) => {
      let time = timeStr.trim().toUpperCase();
      let [timePart, modifier] = time.split(' ');
      let [hours, minutes] = timePart.split(':');
      hours   = parseInt(hours);
      minutes = parseInt(minutes || '0');

      if (modifier === 'PM' && hours < 12) hours += 12;
      if (modifier === 'AM' && hours === 12) hours = 0;

      const timeString = `${dateStr}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00+05:30`;
      return moment(timeString).toDate();
    };

    const startDateTime = parseTimeWithAMPM(startTime, date);
    const endDateTime   = parseTimeWithAMPM(endTime,   date);

    if (!moment(startDateTime).isValid() || !moment(endDateTime).isValid()) {
      return res.status(400).json({ message: 'Invalid date or time format' });
    }

    if (moment(endDateTime).isSameOrBefore(moment(startDateTime))) {
      return res.status(400).json({ message: 'End time must be after start time' });
    }

    const duration = moment(endDateTime).diff(moment(startDateTime), 'hours', true);

    if (duration <= 0) {
      return res.status(400).json({ message: 'Duration must be positive. End time should be after start time.' });
    }

    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);

    const existingPermission = await PermissionModel.findOne({
      employee: req.user.employee._id,
      date:     permissionDate.toDate(),
      status:   { $in: ['pending', 'approved'] }
    });

    if (existingPermission) {
      return res.status(400).json({ message: 'Already have a permission request for this date' });
    }

    const permission = await PermissionModel.create({
      employee:       req.user.employee._id,
      permissionType,
      date:           permissionDate.toDate(),
      startTime:      startDateTime,
      endTime:        endDateTime,
      duration:       parseFloat(duration.toFixed(2)),
      reason
    });

    await permission.populate('employee', 'name email department position');

    // Notify admins + leads about new request
    try {
      await sendNotificationToApprovers(req, permission, 'permission_request',
        'New Permission Request',
        `${permission.employee.name} requested ${permission.permissionType} permission on ${moment(permission.date).format('MMM D')} (${moment(permission.startTime).format('LT')} - ${moment(permission.endTime).format('LT')})`
      );
    } catch (err) {
      console.error('Approver notification failed:', err);
    }

    res.status(201).json(permission);
  } catch (error) {
    console.error('Apply for permission error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Get my permissions ────────────────────────────────────────────────
// ─── @route GET /api/permissions/my-permissions
// ─── @access Private
exports.getMyPermissions = async (req, res) => {
  try {
    const { month, year, status } = req.query;
    const filter = { employee: req.user.employee._id };

    if (month && year) {
      filter.date = {
        $gte: moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate(),
        $lte: moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate()
      };
    }

    if (status) filter.status = status;

    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);

    const permissions = await PermissionModel.find(filter)
      .populate({ path: 'approvals.approver', select: 'name', model: 'Employee' })
      .sort({ date: -1 });

    res.json(permissions);
  } catch (error) {
    console.error('Get my permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Get all permissions (Admin) ──────────────────────────────────────
// ─── @route GET /api/permissions
// ─── @access Private/Admin
// Filters: ?status=pending|approved|rejected&month=MM&year=YYYY&employeeId=xxx
exports.getAllPermissions = async (req, res) => {
  try {
    const { status, month, year, employeeId } = req.query;
    const filter = {};

    if (status) filter.status = status;

    if (month && year) {
      filter.date = {
        $gte: moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate(),
        $lte: moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate()
      };
    }

    if (employeeId) filter.employee = employeeId;

    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);

    const permissions = await PermissionModel.find(filter)
      .populate('employee', 'name email department position')
      .populate({ path: 'approvals.approver', select: 'name', model: 'Employee' })
      .sort({ createdAt: -1 });

    res.json(permissions);
  } catch (error) {
    console.error('Get all permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Update permission status — Admin ──────────────────────────────────
// ─── @route PUT /api/permissions/:id/status
// ─── @access Private/Admin
exports.updatePermissionStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);
    const permission      = await PermissionModel.findById(req.params.id)
      .populate('employee', 'name email department position');

    if (!permission) return res.status(404).json({ message: 'Permission not found' });

    // ── FIRST ACTION WINS ─────────────────────────────────────────────────────
    if (permission.status !== 'pending') {
      return res.status(400).json({
        message: `Permission already ${permission.status}. First action wins — no further changes allowed.`
      });
    }

    permission.approvals = permission.approvals || [];
    permission.approvals.push({ approver: req.user.employee._id, status, approverType: 'admin' });

    // First action wins — set final status immediately
    permission.status = status;
    await permission.save();

    await permission.populate('approvals.approver', 'name position');

    // Notify employee — guard inside helper prevents duplicates
    await notifyEmployeePermissionDecision(req, permission, status, 'admin');

    res.json(permission);
  } catch (error) {
    console.error('Update admin permission status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Get permission statistics ────────────────────────────────────────
// ─── @route GET /api/permissions/stats
// ─── @access Private
exports.getPermissionStats = async (req, res) => {
  try {
    const currentYear     = moment().year();
    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);

    const stats = await PermissionModel.aggregate([
      {
        $match: {
          employee: req.user.employee._id,
          date: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`)
          }
        }
      },
      { $group: { _id: '$status', count: { $sum: 1 }, totalHours: { $sum: '$duration' } } }
    ]);

    const monthlyStats = await PermissionModel.aggregate([
      {
        $match: {
          employee: req.user.employee._id,
          date: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`)
          }
        }
      },
      {
        $group: {
          _id:   { month: { $month: '$date' }, status: '$status' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.month': 1 } }
    ]);

    res.json({ yearlyStats: stats, monthlyStats });
  } catch (error) {
    console.error('Get permission stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Lead: get ALL permissions (all statuses) ─────────────────────────
// ─── @route GET /api/permissions/lead/pending
// ─── @access Private/Lead
exports.getAllPendingPermissionsForLead = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const PermissionModel        = resolveModel(req, 'Permission', DefaultPermission);

    const permissions = await PermissionModel.find({ status })
      .populate('employee', 'name email department position')
      .populate({ path: 'approvals.approver', select: 'name position', model: 'Employee' })
      .sort({ createdAt: -1 });

    res.json(permissions);
  } catch (error) {
    console.error('Get all pending permissions for lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Lead: update status for ANY permission ───────────────────────────
// ─── @route PUT /api/permissions/:id/lead-status
// ─── @access Private/Lead
exports.updateLeadPermissionStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);
    const permission      = await PermissionModel.findById(req.params.id).populate('employee');

    if (!permission) return res.status(404).json({ message: 'Permission not found' });

    // ── FIRST ACTION WINS ─────────────────────────────────────────────────────
    if (permission.status !== 'pending') {
      return res.status(400).json({
        message: `Permission already ${permission.status}. First action wins — no further changes allowed.`
      });
    }

    // Prevent same lead from acting twice
    const existingLeadApproval = permission.approvals.find(
      a => a.approverType === 'lead' && a.approver.toString() === req.user.employee._id.toString()
    );
    if (existingLeadApproval) {
      return res.status(400).json({ message: 'You have already acted on this permission' });
    }

    permission.approvals = permission.approvals || [];
    permission.approvals.push({ approver: req.user.employee._id, status, approverType: 'lead' });

    // First action wins — set final status immediately
    permission.status = status;
    await permission.save();

    await permission.populate('approvals.approver', 'name position');
    await permission.populate('employee', 'name email department');

    // Notify employee — guard inside helper prevents duplicates
    await notifyEmployeePermissionDecision(req, permission, status, 'lead');

    res.json(permission);
  } catch (error) {
    console.error('Update lead permission status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── @desc  Fix stale permission records ─────────────────────────────────────
// ─── @route POST /api/permissions/fix-stale
// ─── @access Private/Admin
exports.fixStalePermissions = async (req, res) => {
  try {
    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);
    const stale           = await PermissionModel.find({ status: 'pending', 'approvals.0': { $exists: true } });

    let fixed = 0;
    for (const perm of stale) {
      const hasRejection = perm.approvals.some(a => a.status === 'rejected');
      const anyApproval  = perm.approvals.some(a => a.status === 'approved');
      if (hasRejection)     { perm.status = 'rejected'; await perm.save(); fixed++; }
      else if (anyApproval) { perm.status = 'approved'; await perm.save(); fixed++; }
    }

    res.json({ message: `Fixed ${fixed} of ${stale.length} stale permission records.` });
  } catch (error) {
    console.error('Fix stale permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};