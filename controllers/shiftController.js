const mongoose = require('mongoose');
const moment = require('moment');
const DefaultShift = require('../models/Shift');
const DefaultEmployee = require('../models/Employee');
const DefaultAttendance = require('../models/Attendance');

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

const getModels = (req) => ({
  Shift: resolveModel(req, 'Shift', DefaultShift),
  Employee: resolveModel(req, 'Employee', DefaultEmployee),
  Attendance: resolveModel(req, 'Attendance', DefaultAttendance),
});

// ==================== SHIFT CRUD OPERATIONS ====================

// @desc    Create new shift
// @route   POST /api/shifts
// @access  Private/Admin
exports.createShift = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const {
      name,
      displayName,
      startTime,
      endTime,
      gracePeriod,
      lateMarkingAfter,
      halfDayMarkingAfter,
      assignedDepartments,
      assignedRoles,
      assignedEmployees,
      isNightShift
    } = req.body;

    // Validate required fields
    if (!name || !displayName || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, displayName, startTime, endTime'
      });
    }

    // Check tenant exists
    if (!req.tenant || !req.tenant._id) {
      return res.status(400).json({
        success: false,
        message: 'Tenant not found. Please login again.'
      });
    }

    // Create the shift
    const shift = await Shift.create({
      name: name.trim().toLowerCase(),
      displayName: displayName.trim(),
      startTime,
      endTime,
      gracePeriod: gracePeriod || 15,
      lateMarkingAfter: lateMarkingAfter || 15,
      halfDayMarkingAfter: halfDayMarkingAfter || 120,
      assignedDepartments: assignedDepartments || [],
      assignedRoles: assignedRoles || [],
      assignedEmployees: assignedEmployees || [],
      isNightShift: isNightShift || false,
      tenant: req.tenant._id,
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      data: shift,
      message: 'Shift created successfully'
    });
  } catch (error) {
    console.error('Create shift error:', error);

    // Handle duplicate key error (if any unique index exists)
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A shift with these details already exists. Please check your shift timings.'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error: ' + error.message
    });
  }
};
// @desc    Get all shifts with statistics
// @route   GET /api/shifts
// @access  Private/Admin
exports.getShifts = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    const { isActive, includeStats } = req.query;

    let filter = { tenant: req.tenant._id };
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    let shifts = await Shift.find(filter).sort({ createdAt: -1 });

    // Include employee count statistics if requested
    if (includeStats === 'true') {
      shifts = await Promise.all(shifts.map(async (shift) => {
        const shiftObj = shift.toObject();

        // Count employees by department assignment
        const deptEmployees = shift.assignedDepartments.length > 0
          ? await Employee.countDocuments({
            department: { $in: shift.assignedDepartments },
            isActive: true,
            tenant: req.tenant._id
          })
          : 0;

        // Count employees by role assignment
        const roleEmployees = shift.assignedRoles.length > 0
          ? await Employee.countDocuments({
            position: { $in: shift.assignedRoles },
            isActive: true,
            tenant: req.tenant._id
          })
          : 0;

        // Direct assigned employees count
        const directEmployees = shift.assignedEmployees.length;

        shiftObj.stats = {
          byDepartment: deptEmployees,
          byRole: roleEmployees,
          directAssigned: directEmployees,
          totalCovered: deptEmployees + roleEmployees + directEmployees
        };

        return shiftObj;
      }));
    }

    res.json({
      success: true,
      data: shifts,
      total: shifts.length
    });
  } catch (error) {
    console.error('Get shifts error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get single shift
// @route   GET /api/shifts/:id
// @access  Private/Admin
exports.getShift = async (req, res) => {
  try {
    const { Shift } = getModels(req);

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    res.json({
      success: true,
      data: shift
    });
  } catch (error) {
    console.error('Get shift error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update shift
// @route   PUT /api/shifts/:id
// @access  Private/Admin
// @desc    Update shift
// @route   PUT /api/shifts/:id
// @access  Private/Admin
exports.updateShift = async (req, res) => {
  try {
    const { Shift, Attendance } = getModels(req);  // ✅ Add Attendance model
    const { startTime, endTime, displayName } = req.body;

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // ✅ Check if timing is being changed
    const isTimingChanged = (startTime && startTime !== shift.startTime) ||
      (endTime && endTime !== shift.endTime);

    // Update the shift
    const updatedShift = await Shift.findOneAndUpdate(
      {
        _id: req.params.id,
        tenant: req.tenant._id
      },
      req.body,
      { new: true, runValidators: true }
    );

    // ✅ If timing changed, delete ALL attendance records for this shift
    // This prevents old attendance from showing "Completed" for new timing
    if (isTimingChanged) {
      const deletedCount = await Attendance.deleteMany({
        shift: shift._id
      });
      console.log(`🗑️ Deleted ${deletedCount.deletedCount} attendance records for shift ${shift.displayName} due to timing change`);
    }

    res.json({
      success: true,
      data: updatedShift,
      message: isTimingChanged ?
        'Shift updated successfully. All attendance records for this shift have been reset due to timing change.' :
        'Shift updated successfully'
    });
  } catch (error) {
    console.error('Update shift error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete shift (hard delete)
// @route   DELETE /api/shifts/:id
// @access  Private/Admin
exports.deleteShift = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);

    // First, unassign this shift from any employees who are directly assigned to it
    await Employee.updateMany(
      {
        assignedShift: req.params.id,
        tenant: req.tenant._id
      },
      {
        $unset: {
          assignedShift: 1,
          shiftSource: 1,
          shiftAssignedAt: 1,
          shiftAssignedBy: 1
        }
      }
    );

    // Completely delete the shift
    const shift = await Shift.findOneAndDelete({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    res.json({
      success: true,
      data: shift,
      message: 'Shift deleted permanently'
    });
  } catch (error) {
    console.error('Delete shift error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ==================== SHIFT ASSIGNMENT OPERATIONS ====================

// @desc    Assign shift to departments
// @route   POST /api/shifts/:id/assign/departments
// @access  Private/Admin
exports.assignToDepartments = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const { departments } = req.body;

    if (!departments || !departments.length) {
      return res.status(400).json({
        success: false,
        message: 'Departments array is required'
      });
    }

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Add new departments without duplicates
    const newDepartments = departments.filter(dept => !shift.assignedDepartments.includes(dept));
    shift.assignedDepartments.push(...newDepartments);
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Shift assigned to ${newDepartments.length} departments`,
      newDepartments: newDepartments
    });
  } catch (error) {
    console.error('Assign to departments error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Assign shift to roles
// @route   POST /api/shifts/:id/assign/roles
// @access  Private/Admin
exports.assignToRoles = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const { roles } = req.body;

    if (!roles || !roles.length) {
      return res.status(400).json({
        success: false,
        message: 'Roles array is required'
      });
    }

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Add new roles without duplicates
    const newRoles = roles.filter(role => !shift.assignedRoles.includes(role));
    shift.assignedRoles.push(...newRoles);
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Shift assigned to ${newRoles.length} roles`,
      newRoles: newRoles
    });
  } catch (error) {
    console.error('Assign to roles error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Assign shift to specific employees
// @route   POST /api/shifts/:id/assign/employees
// @access  Private/Admin
exports.assignToEmployees = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    const { employeeIds } = req.body;

    if (!employeeIds || !employeeIds.length) {
      return res.status(400).json({
        success: false,
        message: 'Employee IDs array is required'
      });
    }

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Update employees with direct shift assignment
    const result = await Employee.updateMany(
      {
        _id: { $in: employeeIds },
        tenant: req.tenant._id
      },
      {
        assignedShift: shift._id,
        shiftSource: 'admin',
        shiftAssignedAt: new Date(),
        shiftAssignedBy: req.user._id
      }
    );

    // Also add to shift's assignedEmployees array (avoid duplicates)
    const existingAssignments = shift.assignedEmployees.map(id => id.toString());
    const newAssignments = employeeIds.filter(id => !existingAssignments.includes(id));
    shift.assignedEmployees.push(...newAssignments);
    await shift.save();

    res.json({
      success: true,
      data: {
        shift,
        modifiedCount: result.modifiedCount,
        newAssignments: newAssignments.length
      },
      message: `Shift assigned to ${result.modifiedCount} employees`
    });
  } catch (error) {
    console.error('Assign to employees error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Remove departments from shift
// @route   DELETE /api/shifts/:id/assign/departments
// @access  Private/Admin
exports.removeDepartments = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const { departments } = req.body;

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    shift.assignedDepartments = shift.assignedDepartments.filter(
      dept => !departments.includes(dept)
    );
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Removed ${departments.length} departments from shift`
    });
  } catch (error) {
    console.error('Remove departments error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Remove roles from shift
// @route   DELETE /api/shifts/:id/assign/roles
// @access  Private/Admin
exports.removeRoles = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const { roles } = req.body;

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    shift.assignedRoles = shift.assignedRoles.filter(
      role => !roles.includes(role)
    );
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Removed ${roles.length} roles from shift`
    });
  } catch (error) {
    console.error('Remove roles error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Remove employees from shift
// @route   DELETE /api/shifts/:id/assign/employees
// @access  Private/Admin
exports.removeEmployees = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    const { employeeIds } = req.body;

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Remove direct assignment from employees
    await Employee.updateMany(
      {
        _id: { $in: employeeIds },
        tenant: req.tenant._id
      },
      {
        assignedShift: null,
        shiftSource: null,
        shiftAssignedAt: null
      }
    );

    // Remove from shift's assignedEmployees array
    shift.assignedEmployees = shift.assignedEmployees.filter(
      id => !employeeIds.includes(id.toString())
    );
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Removed ${employeeIds.length} employees from shift`
    });
  } catch (error) {
    console.error('Remove employees error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ==================== QUERY OPERATIONS ====================

// @desc    Get employee's effective shift (priority resolution)
// @route   GET /api/shifts/employee/:employeeId
// @access  Private/Admin
exports.getEmployeeShift = async (req, res) => {
  try {
    const { Employee } = getModels(req);

    const employee = await Employee.findById(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    const result = await employee.getEffectiveShift(getModels(req));

    res.json({
      success: true,
      data: {
        employee: {
          _id: employee._id,
          name: employee.name,
          department: employee.department,
          position: employee.position
        },
        shift: result.shift,
        source: result.source,
        priority: result.priority
      }
    });
  } catch (error) {
    console.error('Get employee shift error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get my current shift (for logged-in employee)
// @route   GET /api/shifts/my-shift
// @access  Private
exports.getMyShift = async (req, res) => {
  try {
    const { Employee } = getModels(req);

    const employee = await Employee.findById(req.user.employee._id);
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    const result = await employee.getEffectiveShift(getModels(req));
    const now = new Date();

    let shiftStatus = null;
    let canCheckIn = true;
    let canCheckOut = true;

    if (result.shift) {
      shiftStatus = {
        checkIn: { canCheckIn: true, message: 'No shift time restrictions' },
        checkOut: { canCheckOut: true, message: 'No shift time restrictions' }
      };
    }

    res.json({
      success: true,
      data: {
        shift: result.shift,
        source: result.source,
        priority: result.priority,
        currentTime: now,
        canCheckIn,
        canCheckOut,
        shiftStatus
      }
    });
  } catch (error) {
    console.error('Get my shift error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get my shifts for today (for multi-shift support)
// @route   GET /api/shifts/today
// @access  Private
exports.getMyShiftsToday = async (req, res) => {
  try {
    const { Employee, Shift, Attendance } = getModels(req);

    if (!req.user?.employee?._id) {
      return res.status(400).json({
        success: false,
        message: 'Employee not found in auth context'
      });
    }

    if (!req.tenant?._id) {
      return res.status(400).json({
        success: false,
        message: 'Tenant not found. Please login again.'
      });
    }

    // Helpful context for debugging 500s
    const ctx = {
      employeeId: req.user.employee._id?.toString?.() || String(req.user.employee._id),
      tenantId: req.tenant._id?.toString?.() || String(req.tenant._id),
      route: '/api/shifts/today'
    };

    console.log('getMyShiftsToday: start', ctx);

    let employee;
    try {
      employee = await Employee.findById(req.user.employee._id);
    } catch (err) {
      console.error('getMyShiftsToday: Employee.findById failed', { ...ctx, error: err?.message, stack: err?.stack });
      throw err;
    }

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    const today = moment().startOf('day').toDate();
    const todayEnd = moment().endOf('day').toDate();
    const yesterday = moment(today).subtract(1, 'day').toDate();

    let todayAttendances;
    try {
      if (!Attendance) {
        throw new Error('Attendance model not loaded');
      }
      todayAttendances = await Attendance.find({
        employee: req.user.employee._id,
        $or: [
          {
            date: {
              $gte: yesterday,
              $lte: todayEnd
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
      }).select('shift date checkIn checkOut workingHours').lean();
    } catch (err) {
      console.error('getMyShiftsToday: Attendance.find failed', {
        ...ctx,
        error: err?.message,
        stack: err?.stack
      });
      throw err;
    }

    const hasRecordedCheckout = (record) => record?.checkOut !== undefined && record?.checkOut !== null && record?.checkOut !== '';
    const calculateElapsedHours = (checkInValue, endValue = new Date()) => {
      if (!checkInValue) return 0;
      const checkIn = new Date(checkInValue);
      const end = new Date(endValue);
      const diffMs = end.getTime() - checkIn.getTime();
      if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
      return Number((diffMs / (1000 * 60 * 60)).toFixed(2));
    };
    const isActiveAttendanceSession = (record) => (
      Boolean(record?.checkIn)
      && !hasRecordedCheckout(record)
      && calculateElapsedHours(record.checkIn) <= 24
    );
    const activeAttendance = (todayAttendances || [])
      .filter(isActiveAttendanceSession)
      .sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn))[0] || null;

    let applicableShifts;
    try {
      // ✅ Only show shifts created by tenant-admins for THIS tenant.
      // (Tenant scoping is enforced via tenant:req.tenant._id)
      applicableShifts = await Shift.find({
        tenant: req.tenant._id,
        isActive: true
      }).sort({ startTime: 1 });
    } catch (err) {
      console.error('getMyShiftsToday: Shift.find failed', { ...ctx, error: err?.message, stack: err?.stack });
      throw err;
    }

    const todayShifts = (applicableShifts || []).map((shift) => {
      const shiftIdStr = shift?._id?.toString?.() || String(shift?._id);
      const attendance = activeAttendance?.shift?.toString() === shiftIdStr ? activeAttendance : null;
      const status = attendance ? 'checked_in' : 'pending';

      return {
        ...shift.toObject(),
        status,
        checkIn: attendance?.checkIn || null,
        checkOut: attendance?.checkOut || null,
        workingHours: attendance?.workingHours || 0,
        canCheckIn: !activeAttendance && status === 'pending',
        canCheckOut: status === 'checked_in',
        checkInWindow: { canCheckIn: !activeAttendance, message: 'No shift time restrictions' },
      };
    });

    console.log('getMyShiftsToday: success', {
      ...ctx,
      todayShiftsCount: todayShifts.length,
      completedTodayCount: (todayAttendances || []).filter(hasRecordedCheckout).length
    });

    res.json({
      success: true,
      data: {
        todayShifts,
        completedToday: (todayAttendances || []).filter(hasRecordedCheckout).length,
        totalApplicable: applicableShifts.length,
        nextShift: todayShifts.find(s => s.status === 'pending' && s.canCheckIn) || null
      }
    });
  } catch (error) {
    console.error('Get my shifts today error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};




// @desc    Get employees by shift
// @route   GET /api/shifts/:id/employees
// @access  Private/Admin
exports.getShiftEmployees = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    // Get employees from different assignment types
    const deptEmployees = shift.assignedDepartments.length > 0
      ? await Employee.find({
        department: { $in: shift.assignedDepartments },
        isActive: true,
        tenant: req.tenant._id
      }).select('name email department position assignedShift')
      : [];

    const roleEmployees = shift.assignedRoles.length > 0
      ? await Employee.find({
        position: { $in: shift.assignedRoles },
        isActive: true,
        tenant: req.tenant._id
      }).select('name email department position assignedShift')
      : [];

    const directEmployees = shift.assignedEmployees.length > 0
      ? await Employee.find({
        _id: { $in: shift.assignedEmployees },
        isActive: true
      }).select('name email department position assignedShift')
      : [];

    // Combine and deduplicate
    const allEmployees = [...deptEmployees, ...roleEmployees, ...directEmployees];
    const uniqueEmployees = Array.from(new Map(allEmployees.map(emp => [emp._id.toString(), emp])).values());

    res.json({
      success: true,
      data: {
        shift,
        employees: uniqueEmployees,
        counts: {
          fromDepartments: deptEmployees.length,
          fromRoles: roleEmployees.length,
          directAssigned: directEmployees.length,
          totalUnique: uniqueEmployees.length
        }
      }
    });
  } catch (error) {
    console.error('Get shift employees error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get all available departments (for dropdown)
// @route   GET /api/shifts/departments
// @access  Private/Admin
exports.getDepartments = async (req, res) => {
  try {
    const { Employee } = getModels(req);

    const departments = await Employee.distinct('department', {
      tenant: req.tenant._id,
      isActive: true
    });

    res.json({
      success: true,
      data: departments.filter(d => d && d.trim())
    });
  } catch (error) {
    console.error('Get departments error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get all available roles (for dropdown)
// @route   GET /api/shifts/roles
// @access  Private/Admin
exports.getRoles = async (req, res) => {
  try {
    const { Employee } = getModels(req);

    const roles = await Employee.distinct('position', {
      tenant: req.tenant._id,
      isActive: true
    });

    res.json({
      success: true,
      data: roles.filter(r => r && r.trim())
    });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get shift assignment summary for dashboard
// @route   GET /api/shifts/summary
// @access  Private/Admin
exports.getShiftSummary = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);

    const totalEmployees = await Employee.countDocuments({
      tenant: req.tenant._id,
      isActive: true
    });

    const shifts = await Shift.find({
      tenant: req.tenant._id,
      isActive: true
    });

    let coveredEmployees = 0;
    const shiftDetails = await Promise.all(shifts.map(async (shift) => {
      // Count unique employees covered by this shift
      const deptEmployees = shift.assignedDepartments.length > 0
        ? await Employee.countDocuments({
          department: { $in: shift.assignedDepartments },
          isActive: true,
          tenant: req.tenant._id
        })
        : 0;

      const roleEmployees = shift.assignedRoles.length > 0
        ? await Employee.countDocuments({
          position: { $in: shift.assignedRoles },
          isActive: true,
          tenant: req.tenant._id
        })
        : 0;

      const directCount = shift.assignedEmployees.length;

      // Simple sum (may have overlaps, but that's fine for summary)
      const shiftTotal = deptEmployees + roleEmployees + directCount;
      coveredEmployees += shiftTotal;

      return {
        _id: shift._id,
        name: shift.name,
        displayName: shift.displayName,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isNightShift: shift.isNightShift,
        assignedDepartmentsCount: shift.assignedDepartments.length,
        assignedRolesCount: shift.assignedRoles.length,
        assignedEmployeesCount: shift.assignedEmployees.length,
        estimatedCoverage: shiftTotal
      };
    }));

    res.json({
      success: true,
      data: {
        totalEmployees,
        totalShifts: shifts.length,
        coveredEmployees: Math.min(coveredEmployees, totalEmployees),
        uncoveredEmployees: Math.max(0, totalEmployees - coveredEmployees),
        shifts: shiftDetails
      }
    });
  } catch (error) {
    console.error('Get shift summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
