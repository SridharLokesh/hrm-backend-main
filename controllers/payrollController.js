const mongoose = require('mongoose');
const DefaultPayroll = require('../models/Payroll');
const DefaultEmployee = require('../models/Employee');
const DefaultAttendance = require('../models/Attendance');
const DefaultLeave = require('../models/Leave');
const moment = require('moment');

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

const getModels = (req) => ({
  Payroll: resolveModel(req, 'Payroll', DefaultPayroll),
  Employee: resolveModel(req, 'Employee', DefaultEmployee),
  Attendance: resolveModel(req, 'Attendance', DefaultAttendance),
  Leave: resolveModel(req, 'Leave', DefaultLeave),
});

// @desc    Get payroll by ID
// @route   GET /api/payroll/:id
// @access  Private
exports.getPayrollById = async (req, res) => {
  try {
    const { Payroll } = getModels(req);
    const payroll = await Payroll.findById(req.params.id)
      .populate('employee', 'name email department position');

    if (!payroll) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    // Check if user has access to this payroll
    if (req.user.role !== 'admin' && payroll.employee._id.toString() !== req.user.employee._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(payroll);
  } catch (error) {
    console.error('Get payroll by ID error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Generate payroll for employee
// @route   POST /api/payroll/generate
// @access  Private/Admin
exports.generatePayroll = async (req, res) => {
  try {
    const { Payroll, Employee, Attendance, Leave } = getModels(req);
    const { employeeId, month, year } = req.body;

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Check if payroll already exists
    const existingPayroll = await Payroll.findOne({
      employee: employeeId,
      month,
      year
    });

    if (existingPayroll) {
      return res.status(400).json({ message: 'Payroll already generated for this month' });
    }

    // Calculate attendance
    const startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
    const endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();

    const attendanceRecords = await Attendance.find({
      employee: employeeId,
      date: { $gte: startDate, $lte: endDate }
    });

    const presentDays = attendanceRecords.filter(record => 
      record.status === 'present'
    ).length;

    const halfDays = attendanceRecords.filter(record => 
      record.status === 'half-day'
    ).length;

    // Calculate approved leaves
    const approvedLeaves = await Leave.find({
      employee: employeeId,
      status: 'approved',
      startDate: { $lte: endDate },
      endDate: { $gte: startDate }
    });

    let leaveDays = 0;
    approvedLeaves.forEach(leave => {
      const overlapStart = moment.max(moment(leave.startDate), moment(startDate));
      const overlapEnd = moment.min(moment(leave.endDate), moment(endDate));
      const days = overlapEnd.diff(overlapStart, 'days') + 1;
      leaveDays += days;
    });

    const workingDays = moment(endDate).diff(moment(startDate), 'days') + 1;
    const effectivePresentDays = presentDays + (halfDays * 0.5);
    
    // Calculate salary
    const dailySalary = employee.salary / workingDays;
    const netSalary = (dailySalary * effectivePresentDays) - req.body.deductions + (req.body.allowances || 0);

    const payroll = await Payroll.create({
      employee: employeeId,
      month,
      year,
      basicSalary: employee.salary,
      allowances: req.body.allowances || 0,
      deductions: req.body.deductions || 0,
      workingDays,
      presentDays: effectivePresentDays,
      leaveDays,
      netSalary: Math.round(netSalary)
    });

    await payroll.populate('employee', 'name email department position');

    res.status(201).json(payroll);
  } catch (error) {
    console.error('Generate payroll error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get my payroll
// @route   GET /api/payroll/my-payroll
// @access  Private
exports.getMyPayroll = async (req, res) => {
  try {
    const { Payroll } = getModels(req);
    const payroll = await Payroll.find({ employee: req.user.employee._id })
      .populate('employee', 'name email department position')
      .sort({ year: -1, month: -1 });

    res.json(payroll);
  } catch (error) {
    console.error('Get my payroll error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get all payroll
// @route   GET /api/payroll
// @access  Private/Admin
exports.getAllPayroll = async (req, res) => {
  try {
    const { Payroll } = getModels(req);
    const { month, year } = req.query;
    let filter = {};

    if (month && year) {
      filter.month = parseInt(month);
      filter.year = parseInt(year);
    }

    const payroll = await Payroll.find(filter)
      .populate('employee', 'name email department position')
      .sort({ year: -1, month: -1 });

    res.json(payroll);
  } catch (error) {
    console.error('Get all payroll error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update payroll status
// @route   PUT /api/payroll/:id/status
// @access  Private/Admin
exports.updatePayrollStatus = async (req, res) => {
  try {
    const { Payroll } = getModels(req);
    const { status, paymentDate } = req.body;

    const payroll = await Payroll.findById(req.params.id);

    if (!payroll) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    payroll.status = status;
    if (paymentDate) {
      payroll.paymentDate = paymentDate;
    }

    await payroll.save();
    await payroll.populate('employee', 'name email department position');

    res.json(payroll);
  } catch (error) {
    console.error('Update payroll status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get payroll summary
// @route   GET /api/payroll/summary
// @access  Private/Admin
exports.getPayrollSummary = async (req, res) => {
  try {
    const { Payroll } = getModels(req);
    const { month, year } = req.query;
    const currentMonth = month || moment().month() + 1;
    const currentYear = year || moment().year();

    const summary = await Payroll.aggregate([
      {
        $match: {
          month: parseInt(currentMonth),
          year: parseInt(currentYear)
        }
      },
      {
        $group: {
          _id: null,
          totalEmployees: { $sum: 1 },
          totalSalary: { $sum: '$netSalary' },
          averageSalary: { $avg: '$netSalary' }
        }
      }
    ]);

    const departmentSummary = await Payroll.aggregate([
      {
        $match: {
          month: parseInt(currentMonth),
          year: parseInt(currentYear)
        }
      },
      {
        $lookup: {
          from: 'employees',
          localField: 'employee',
          foreignField: '_id',
          as: 'employee'
        }
      },
      {
        $unwind: '$employee'
      },
      {
        $group: {
          _id: '$employee.department',
          totalEmployees: { $sum: 1 },
          totalSalary: { $sum: '$netSalary' },
          averageSalary: { $avg: '$netSalary' }
        }
      }
    ]);

    res.json({
      overall: summary[0] || { totalEmployees: 0, totalSalary: 0, averageSalary: 0 },
      byDepartment: departmentSummary
    });
  } catch (error) {
    console.error('Get payroll summary error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};