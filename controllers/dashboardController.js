const DefaultEmployee = require('../models/Employee');
const DefaultAttendance = require('../models/Attendance');
const DefaultLeave = require('../models/Leave');
const DefaultPayroll = require('../models/Payroll');
const DefaultShift = require('../models/Shift');
const DefaultUser = require('../models/User');
const moment = require('moment');

const mongoose = require('mongoose');

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  // defaultSchema may already be a model or a schema
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

const calculateWorkingHours = (attendance) => {
  if (!attendance?.checkIn || !attendance?.checkOut) return 0;
  const checkIn = new Date(attendance.checkIn);
  const checkOut = new Date(attendance.checkOut);
  const diffMs = checkOut.getTime() - checkIn.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Number((diffMs / (1000 * 60 * 60)).toFixed(2));
};

const hasRecordedCheckout = (record) => record?.checkOut !== undefined && record?.checkOut !== null && record?.checkOut !== '';
const calculateElapsedHours = (checkInValue, endValue = new Date()) => {
  if (!checkInValue) return 0;
  const checkIn = new Date(checkInValue);
  const end = new Date(endValue);
  const diffMs = end.getTime() - checkIn.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Number((diffMs / (1000 * 60 * 60)).toFixed(2));
};
const MAX_ACTIVE_SESSION_HOURS = 24;
const isActiveAttendanceSession = (record) => (
  Boolean(record?.checkIn)
  && !hasRecordedCheckout(record)
  && calculateElapsedHours(record.checkIn) <= MAX_ACTIVE_SESSION_HOURS
);

// @desc    Get admin dashboard stats
// @route   GET /api/dashboard/admin
// @access  Private/Admin
exports.getAdminDashboard = async (req, res) => {
  try {
    const currentMonth = moment().month() + 1;
    const currentYear = moment().year();

  // Resolve models (tenant-scoped if available)
  const EmployeeModel = resolveModel(req, 'Employee', DefaultEmployee);
  const AttendanceModel = resolveModel(req, 'Attendance', DefaultAttendance);
  const LeaveModel = resolveModel(req, 'Leave', DefaultLeave);
  const PayrollModel = resolveModel(req, 'Payroll', DefaultPayroll);
  const UserModel = resolveModel(req, 'User', DefaultUser);

  // Total employees
  const totalEmployees = await EmployeeModel.countDocuments({ isActive: true });
    
    // Today's attendance
    const today = moment().startOf('day');
  const todaysAttendance = await AttendanceModel.find({
      date: {
        $gte: today.toDate(),
        $lte: moment(today).endOf('day').toDate()
      }
    }).populate('employee', 'name department');

    const presentToday = todaysAttendance.filter(a => a.status === 'present').length;
    const checkedInToday = todaysAttendance.length;

    // Active sessions (optional if your User schema has loginSession)
    let activeSessions = 0;
    if (UserModel.schema && UserModel.schema.path('loginSession')) {
      activeSessions = await UserModel.countDocuments({
        'loginSession.isValid': true,
        'loginSession.expires': { $gt: new Date() }
      });
    }

    // Pending leave requests
  const pendingLeaves = await LeaveModel.countDocuments({ status: 'pending' });

    // Monthly payroll summary
  const monthlyPayroll = await PayrollModel.aggregate([
      {
        $match: {
          month: currentMonth,
          year: currentYear
        }
      },
      {
        $group: {
          _id: null,
          totalSalary: { $sum: '$netSalary' },
          paidEmployees: { $sum: 1 }
        }
      }
    ]);

    // Department-wise employee count
  const departmentStats = await EmployeeModel.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$department',
          count: { $sum: 1 }
        }
      }
    ]);

    // Recent leaves
    const recentLeaves = await LeaveModel.find({ status: 'pending' })
      .populate('employee', 'name department')
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      totalEmployees,
      presentToday,
      checkedInToday,
      activeSessions,
      pendingLeaves,
      totalSalary: monthlyPayroll[0]?.totalSalary || 0,
      paidEmployees: monthlyPayroll[0]?.paidEmployees || 0,
      departmentStats,
      recentLeaves
    });
  } catch (error) {
    console.error('Get admin dashboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get employee dashboard stats
// @route   GET /api/dashboard/employee
// @access  Private
exports.getEmployeeDashboard = async (req, res) => {
  try {
    const currentMonth = moment().month() + 1;
    const currentYear = moment().year();
    const employeeId = req.user?.employee?._id || req.user?.employee;
    
    if (!employeeId) {
      console.warn('Dashboard: Employee ID not found for user', req.user?._id);
      return res.status(400).json({ message: 'Employee profile not found' });
    }

    const AttendanceModel = resolveModel(req, 'Attendance', DefaultAttendance);
    const LeaveModel = resolveModel(req, 'Leave', DefaultLeave);
    const PayrollModel = resolveModel(req, 'Payroll', DefaultPayroll);
    const ShiftModel = resolveModel(req, 'Shift', DefaultShift);

    // ✅ Get today's attendance (without shift filter first)
    const today = moment().startOf('day');
    const todayEnd = moment(today).endOf('day');
    const yesterday = moment(today).subtract(1, 'day');
    
    const todayAttendanceRecords = await AttendanceModel.find({
      employee: employeeId,
      $or: [
        {
          date: {
            $gte: yesterday.toDate(),
            $lte: todayEnd.toDate()
          }
        },
        {
          checkIn: { $exists: true },
          $or: [
            { checkOut: { $exists: false } },
            { checkOut: null }
          ]
        }
      ]
    }).sort({ checkIn: -1, createdAt: -1 });

    const activeAttendance = todayAttendanceRecords.find(record =>
      isActiveAttendanceSession(record)
    );
    const currentDayAttendance = todayAttendanceRecords.find(record => (
      moment(record.date || record.checkIn).isBetween(today, todayEnd, undefined, '[]')
    ));
    const todaysAttendance = activeAttendance
      || currentDayAttendance
      || null;

    const attendanceShift = todaysAttendance?.shift
      ? await ShiftModel.findById(todaysAttendance.shift)
      : null;

    // ✅ If no attendance found, return null
    // ✅ Get employee with shift info for today
    const todaysShift = null;

    // ✅ Monthly attendance summary
    const startDate = moment().startOf('month').toDate();
    const endDate = moment().endOf('month').toDate();

    const monthlyAttendance = await AttendanceModel.find({
      employee: employeeId,
      date: { $gte: startDate, $lte: endDate }
    });

    const presentLikeStatuses = ['present', 'present-with-permission'];
    const workedStatuses = [...presentLikeStatuses, 'half-day'];

    const presentDays = monthlyAttendance.filter(a => presentLikeStatuses.includes(a.status)).length;
    const halfDays = monthlyAttendance.filter(a => a.status === 'half-day').length;
    const totalWorkingHours = monthlyAttendance.reduce((sum, a) => sum + calculateWorkingHours(a), 0);
    const workedEntries = monthlyAttendance.filter(a => workedStatuses.includes(a.status) || (a.checkIn && a.checkOut));
    const averageHours = workedEntries.length > 0 ? totalWorkingHours / workedEntries.length : 0;

    // Leave stats
    const employeeObjectId = mongoose.isValidObjectId(employeeId)
      ? new mongoose.Types.ObjectId(employeeId)
      : employeeId;

    const leaveStats = await LeaveModel.aggregate([
      {
        $match: {
          employee: employeeObjectId,
          startDate: { $gte: new Date(`${currentYear}-01-01`) }
        }
      },
      {
        $group: {
          _id: '$status',
          totalDays: { $sum: '$totalDays' }
        }
      }
    ]);

    // Current month payroll
    const currentPayroll = await PayrollModel.findOne({
      employee: employeeId,
      month: currentMonth,
      year: currentYear
    });

    // Upcoming approved leaves
    const upcomingLeaves = await LeaveModel.find({
      employee: employeeId,
      status: 'approved',
      startDate: { $gte: new Date() }
    })
      .sort({ startDate: 1 })
      .limit(3);

    // ✅ Return formatted response
    res.json({
      todaysAttendance: todaysAttendance ? {
        _id: todaysAttendance._id,
        checkIn: todaysAttendance.checkIn,
        checkOut: todaysAttendance.checkOut,
        isActiveShift: isActiveAttendanceSession(todaysAttendance),
        todayAttendanceCount: todayAttendanceRecords.length,
        status: todaysAttendance.status,
        workingHours: calculateWorkingHours(todaysAttendance),
        checkInPlace: todaysAttendance.checkInPlace,
        checkOutPlace: todaysAttendance.checkOutPlace,
        isLateCheckIn: todaysAttendance.isLateCheckIn,
        shiftName: todaysAttendance.shiftName,
        shiftStartTime: attendanceShift?.startTime,
        shiftEndTime: attendanceShift?.endTime
      } : null,
      todaysShift: todaysShift ? {
        _id: todaysShift._id,
        name: todaysShift.displayName,
        startTime: todaysShift.startTime,
        endTime: todaysShift.endTime
      } : null,
      monthlyStats: {
        presentDays,
        halfDays,
        totalWorkingHours: totalWorkingHours.toFixed(2),
        workingDays: moment().date(),
        averageHours: averageHours.toFixed(2)
      },
      leaveStats,
      currentPayroll,
      upcomingLeaves
    });
  } catch (error) {
    console.error('Get employee dashboard error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};
