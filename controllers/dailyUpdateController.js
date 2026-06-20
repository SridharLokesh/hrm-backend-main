// controllers/dailyUpdateController.js
const mongoose = require('mongoose');
const moment = require('moment');

// ─── Helpers ────────────────────────────────────────────────────────────────

const getEmployeeIdFromRequest = (req) =>
  req.user?.employee?._id || req.user?.employee;

/**
 * Resolve DailyUpdate model from tenant-scoped req.models
 */
const getModels = (req) => {
  const { DailyUpdate, Attendance, Employee } = req.models;
  if (!DailyUpdate) throw new Error('DailyUpdate model not found in tenant context');
  return { DailyUpdate, Attendance, Employee };
};

/**
 * Build a UTC date range for a calendar day in the server's local time zone.
 * Uses moment so it respects the day boundary correctly.
 */
const dayRange = (dateInput) => {
  const m = moment(dateInput).startOf('day');
  return {
    start: m.toDate(),
    end: moment(dateInput).endOf('day').toDate()
  };
};

// ─── User Routes ─────────────────────────────────────────────────────────────

/**
 * @desc  Get today's daily update (or draft) for the authenticated user.
 *        Also returns whether a submitted update exists so the frontend can
 *        gate the checkout button.
 * @route GET /api/daily-updates/today
 * @access Private
 */
exports.getTodayUpdate = async (req, res) => {
  try {
    const { DailyUpdate } = getModels(req);
    const employeeId = getEmployeeIdFromRequest(req);
    if (!employeeId) return res.status(400).json({ message: 'Employee profile not found' });

    const { start, end } = dayRange(new Date());

    const update = await DailyUpdate.findOne({
      employee: employeeId,
      date: { $gte: start, $lte: end }
    });

    return res.json({
      exists: Boolean(update),
      isSubmitted: update?.isSubmitted || false,
      update: update || null
    });
  } catch (error) {
    console.error('getTodayUpdate error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc  Save (create or update) the daily update for today.
 *        - Requires an active attendance (checked-in, not checked-out).
 *        - Once submitted (isSubmitted=true) the record is locked after 24 hrs.
 *        - Partial saves (isSubmitted=false) are always allowed — acts as draft.
 * @route POST /api/daily-updates
 * @access Private
 */
exports.saveDailyUpdate = async (req, res) => {
  try {
    const { DailyUpdate, Attendance } = getModels(req);
    const employeeId = getEmployeeIdFromRequest(req);
    if (!employeeId) return res.status(400).json({ message: 'Employee profile not found' });

    const { rows, isSubmitted, attendanceId } = req.body;

    // Validate rows
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'Rows are required and must be a non-empty array' });
    }

    // Sanitise rows — only allow title + content, title must be non-empty
    const sanitisedRows = rows.map((r, i) => ({
      title: (r.title || `Task ${i + 1}`).toString().trim().slice(0, 200),
      content: (r.content || '').toString().trim().slice(0, 2000)
    }));

    // Resolve attendance record
    let attendance;
    if (attendanceId && mongoose.isValidObjectId(attendanceId)) {
      attendance = await Attendance.findOne({ _id: attendanceId, employee: employeeId });
    } else {
      // Find latest active (no checkout) attendance for today
      const { start, end } = dayRange(new Date());
      attendance = await Attendance.findOne({
        employee: employeeId,
        date: { $gte: start, $lte: end },
        checkIn: { $exists: true, $ne: null }
      }).sort({ checkIn: -1 });
    }

    if (!attendance) {
      return res.status(400).json({ message: 'No active attendance session found for today. Please check in first.' });
    }

    const { start, end } = dayRange(attendance.date || new Date());

    // Upsert the daily update for today
    let update = await DailyUpdate.findOne({
      employee: employeeId,
      date: { $gte: start, $lte: end }
    });

    if (update) {
      // If already submitted and past edit window, user cannot edit
      if (update.isSubmitted && update.editDeadline && new Date() > update.editDeadline) {
        return res.status(403).json({
          message: 'Edit window has expired. Daily update is locked after 24 hours of submission.'
        });
      }

      update.rows = sanitisedRows;

      if (!update.isSubmitted && isSubmitted) {
        // First-time submission
        update.isSubmitted = true;
        update.submittedAt = new Date();
        update.editDeadline = moment().add(24, 'hours').toDate();
        update.attendance = attendance._id;
      }
    } else {
      // Create new
      const submittedAt = isSubmitted ? new Date() : null;
      update = new DailyUpdate({
        employee: employeeId,
        attendance: attendance._id,
        date: moment(attendance.date || new Date()).startOf('day').toDate(),
        rows: sanitisedRows,
        isSubmitted: Boolean(isSubmitted),
        submittedAt,
        editDeadline: isSubmitted ? moment().add(24, 'hours').toDate() : null
      });
    }

    await update.save();

    return res.status(200).json({
      message: update.isSubmitted ? 'Daily update submitted successfully' : 'Draft saved',
      update
    });
  } catch (error) {
    console.error('saveDailyUpdate error:', error);
    if (error.code === 11000) {
      return res.status(409).json({ message: 'A daily update already exists for this session.' });
    }
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc  Get all daily updates for the authenticated user with optional
 *        month filter.  Returns records newest-first.
 * @route GET /api/daily-updates/my?month=YYYY-MM
 * @access Private
 */
exports.getMyUpdates = async (req, res) => {
  try {
    const { DailyUpdate } = getModels(req);
    const employeeId = getEmployeeIdFromRequest(req);
    if (!employeeId) return res.status(400).json({ message: 'Employee profile not found' });

    const filter = { employee: employeeId };

    if (req.query.month) {
      const m = moment(req.query.month, 'YYYY-MM', true);
      if (!m.isValid()) {
        return res.status(400).json({ message: 'Invalid month format. Use YYYY-MM.' });
      }
      filter.date = {
        $gte: m.startOf('month').toDate(),
        $lte: m.endOf('month').toDate()
      };
    }

    const updates = await DailyUpdate.find(filter)
      .sort({ date: -1 })
      .populate('attendance', 'checkIn checkOut workingHours status')
      .lean({ virtuals: true });

    return res.json({ updates });
  } catch (error) {
    console.error('getMyUpdates error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── Admin Routes ─────────────────────────────────────────────────────────────

/**
 * @desc  Admin: get all daily updates with filters.
 *        Supports ?month=YYYY-MM&employeeId=...&page=1&limit=50
 * @route GET /api/daily-updates/admin
 * @access Private (admin)
 */
exports.adminGetAllUpdates = async (req, res) => {
  try {
    const { DailyUpdate, Employee } = getModels(req);

    const filter = {};

    // Filter by employee
    if (req.query.employeeId && mongoose.isValidObjectId(req.query.employeeId)) {
      filter.employee = new mongoose.Types.ObjectId(req.query.employeeId);
    }

    // Filter by month
    if (req.query.month) {
      const m = moment(req.query.month, 'YYYY-MM', true);
      if (!m.isValid()) {
        return res.status(400).json({ message: 'Invalid month format. Use YYYY-MM.' });
      }
      filter.date = {
        $gte: m.startOf('month').toDate(),
        $lte: m.endOf('month').toDate()
      };
    }

    // Pagination
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const skip = (page - 1) * limit;

    const [updates, total] = await Promise.all([
      DailyUpdate.find(filter)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .populate('employee', 'name email department position employeeId')
        .populate('attendance', 'checkIn checkOut workingHours status')
        .lean({ virtuals: true }),
      DailyUpdate.countDocuments(filter)
    ]);

    return res.json({
      updates,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('adminGetAllUpdates error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc  Admin: get single daily update by ID
 * @route GET /api/daily-updates/admin/:id
 * @access Private (admin)
 */
exports.adminGetUpdateById = async (req, res) => {
  try {
    const { DailyUpdate } = getModels(req);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const update = await DailyUpdate.findById(id)
      .populate('employee', 'name email department position employeeId')
      .populate('attendance', 'checkIn checkOut workingHours status')
      .lean({ virtuals: true });

    if (!update) return res.status(404).json({ message: 'Daily update not found' });

    return res.json({ update });
  } catch (error) {
    console.error('adminGetUpdateById error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc  Admin: edit rows in a daily update. Full row replacement.
 *        Logs an audit entry.
 * @route PUT /api/daily-updates/admin/:id
 * @access Private (admin)
 */
exports.adminEditUpdate = async (req, res) => {
  try {
    const { DailyUpdate } = getModels(req);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'Rows are required' });
    }

    const update = await DailyUpdate.findById(id);
    if (!update) return res.status(404).json({ message: 'Daily update not found' });

    // Save audit snapshot
    update.adminEdits.push({
      editedBy: req.user._id,
      editedByName: req.user.employee?.name || req.user.email || 'Admin',
      action: 'edit',
      editedAt: new Date(),
      previousRows: update.rows.map(r => ({ title: r.title, content: r.content }))
    });

    // Apply new rows
    update.rows = rows.map((r, i) => ({
      title: (r.title || `Task ${i + 1}`).toString().trim().slice(0, 200),
      content: (r.content || '').toString().trim().slice(0, 2000)
    }));

    await update.save();

    const result = await DailyUpdate.findById(id)
      .populate('employee', 'name email department position employeeId')
      .populate('attendance', 'checkIn checkOut workingHours status')
      .lean({ virtuals: true });

    return res.json({ message: 'Daily update edited successfully', update: result });
  } catch (error) {
    console.error('adminEditUpdate error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc  Admin: delete a daily update record.
 * @route DELETE /api/daily-updates/admin/:id
 * @access Private (admin)
 */
exports.adminDeleteUpdate = async (req, res) => {
  try {
    const { DailyUpdate } = getModels(req);
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const update = await DailyUpdate.findById(id);
    if (!update) return res.status(404).json({ message: 'Daily update not found' });

    await update.deleteOne();

    return res.json({ message: 'Daily update deleted successfully' });
  } catch (error) {
    console.error('adminDeleteUpdate error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc  Admin: export daily updates as structured JSON ready for Excel
 *        generation on the frontend (or backend if needed).
 *        Supports ?month=YYYY-MM&employeeId=...
 *        Returns flat rows suitable for XLSX libraries.
 * @route GET /api/daily-updates/admin/export
 * @access Private (admin)
 */
exports.adminExportUpdates = async (req, res) => {
  try {
    const { DailyUpdate } = getModels(req);

    const filter = {};

    if (req.query.employeeId && mongoose.isValidObjectId(req.query.employeeId)) {
      filter.employee = new mongoose.Types.ObjectId(req.query.employeeId);
    }

    if (req.query.month) {
      const m = moment(req.query.month, 'YYYY-MM', true);
      if (!m.isValid()) {
        return res.status(400).json({ message: 'Invalid month format. Use YYYY-MM.' });
      }
      filter.date = {
        $gte: m.startOf('month').toDate(),
        $lte: m.endOf('month').toDate()
      };
    }

    const updates = await DailyUpdate.find(filter)
      .sort({ date: -1 })
      .populate('employee', 'name email department position employeeId')
      .populate('attendance', 'checkIn checkOut workingHours status')
      .lean({ virtuals: true });

    // Flatten to Excel-friendly rows
    const exportRows = [];

    updates.forEach((u) => {
      const employeeName = u.employee?.name || 'Unknown';
      const employeeId = u.employee?.employeeId || u.employee?._id || '';
      const department = u.employee?.department || '';
      const dateStr = moment(u.date).format('YYYY-MM-DD');
      const checkIn = u.attendance?.checkIn ? moment(u.attendance.checkIn).format('HH:mm') : '';
      const checkOut = u.attendance?.checkOut ? moment(u.attendance.checkOut).format('HH:mm') : '';
      const workingHours = u.attendance?.workingHours || 0;

      (u.rows || []).forEach((row) => {
        exportRows.push({
          Date: dateStr,
          'Employee ID': employeeId,
          'Employee Name': employeeName,
          Department: department,
          'Check In': checkIn,
          'Check Out': checkOut,
          'Working Hours': workingHours,
          Title: row.title || '',
          Content: row.content || '',
          Submitted: u.isSubmitted ? 'Yes' : 'No',
          'Submitted At': u.submittedAt ? moment(u.submittedAt).format('YYYY-MM-DD HH:mm') : ''
        });
      });
    });

    return res.json({
      exportRows,
      meta: {
        total: updates.length,
        month: req.query.month || 'all',
        employeeId: req.query.employeeId || 'all',
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('adminExportUpdates error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc  Admin: get list of distinct employees who have daily updates
 *        (for the user-select dropdown in admin panel).
 * @route GET /api/daily-updates/admin/employees
 * @access Private (admin)
 */
exports.adminGetEmployeesWithUpdates = async (req, res) => {
  try {
    const { DailyUpdate } = getModels(req);

    const filter = {};
    if (req.query.month) {
      const m = moment(req.query.month, 'YYYY-MM', true);
      if (m.isValid()) {
        filter.date = {
          $gte: m.startOf('month').toDate(),
          $lte: m.endOf('month').toDate()
        };
      }
    }

    const employeeIds = await DailyUpdate.distinct('employee', filter);

    // Populate employee details
    const { Employee } = getModels(req);
    const employees = await Employee.find({ _id: { $in: employeeIds } })
      .select('name email department position employeeId')
      .lean();

    return res.json({ employees });
  } catch (error) {
    console.error('adminGetEmployeesWithUpdates error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * @desc  Check if daily update is submitted — used by checkout gate.
 *        Returns { canCheckOut: true/false, reason: string }
 * @route GET /api/daily-updates/checkout-gate
 * @access Private
 */
exports.checkoutGate = async (req, res) => {
  try {
    const { DailyUpdate } = getModels(req);
    const employeeId = getEmployeeIdFromRequest(req);
    if (!employeeId) return res.status(400).json({ message: 'Employee profile not found' });

    const { start, end } = dayRange(new Date());

    const update = await DailyUpdate.findOne({
      employee: employeeId,
      date: { $gte: start, $lte: end }
    }).select('isSubmitted');

    if (!update || !update.isSubmitted) {
      return res.json({
        canCheckOut: false,
        reason: 'Please submit your daily update before checking out.'
      });
    }

    return res.json({ canCheckOut: true, reason: null });
  } catch (error) {
    console.error('checkoutGate error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};