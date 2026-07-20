const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const moment = require('moment');
const reverseGeocode = require('../utils/reverseGeocode');
const Shift = require('../models/Shift');
const mongoose = require('mongoose');
const { emitToUserClients } = require('./notificationController');

const getEmployeeIdFromRequest = (req) => req.user?.employee?._id || req.user?.employee;

const openAttendanceFilter = (employeeId) => ({
  employee: employeeId,
  checkIn: { $exists: true, $ne: null },
  $or: [
    { checkOut: { $exists: false } },
    { checkOut: null }
  ]
});

const hasRecordedCheckout = (record) => record?.checkOut !== undefined && record?.checkOut !== null && record?.checkOut !== '';
const MAX_ACTIVE_SESSION_HOURS = 24;

const calculateWorkingHours = (attendance) => {
  if (!attendance?.checkIn || !attendance?.checkOut) return 0;
  const checkIn = new Date(attendance.checkIn);
  const checkOut = new Date(attendance.checkOut);
  const diffMs = checkOut.getTime() - checkIn.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Number((diffMs / (1000 * 60 * 60)).toFixed(2));
};

const calculateElapsedHours = (checkInValue, endValue = new Date()) => {
  if (!checkInValue) return 0;
  const checkIn = new Date(checkInValue);
  const end = new Date(endValue);
  const diffMs = end.getTime() - checkIn.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Number((diffMs / (1000 * 60 * 60)).toFixed(2));
};

const DUPLICATE_ATTENDANCE_MESSAGE = 'Attendance already exists for this employee, date, and shift.';

const isDuplicateAttendanceKeyError = (error) => (
  error?.code === 11000
  && (
    error?.keyPattern?.employee
    || error?.keyPattern?.date
    || error?.keyPattern?.shift
    || error?.errmsg?.includes('employee_1_date_1_shift_1')
  )
);

const isActiveAttendanceSession = (record) => (
  Boolean(record?.checkIn)
  && !hasRecordedCheckout(record)
  && calculateElapsedHours(record.checkIn) <= MAX_ACTIVE_SESSION_HOURS
);

const normalizeAttendanceSession = (attendanceRecord) => {
  if (!attendanceRecord) return null;
  const attendance = typeof attendanceRecord.toObject === 'function'
    ? attendanceRecord.toObject()
    : attendanceRecord;

  const selectedShift = attendance.shift && typeof attendance.shift === 'object'
    ? {
        _id: attendance.shift._id,
        name: attendance.shift.displayName || attendance.shift.name || attendance.shiftName,
        displayName: attendance.shift.displayName,
        startTime: attendance.shift.startTime,
        endTime: attendance.shift.endTime,
        isNightShift: attendance.shift.isNightShift || false
      }
    : null;

  const workingHours = hasRecordedCheckout(attendance)
    ? calculateWorkingHours(attendance)
    : calculateElapsedHours(attendance.checkIn);

  return {
    ...attendance,
    workingHours,
    selectedShift,
    selectedLocation: attendance.checkInLocation || null,
    activeAttendanceId: attendance._id,
    checkInTime: attendance.checkIn
  };
};

const buildActiveAttendanceStatus = async (Attendance, Shift, employeeId) => {
  const activeAttendanceRecord = await Attendance.findOne(openAttendanceFilter(employeeId))
    .populate('shift', 'name displayName startTime endTime isNightShift')
    .sort({ checkIn: -1, createdAt: -1 });
  const activeAttendance = activeAttendanceRecord && calculateElapsedHours(activeAttendanceRecord.checkIn) <= MAX_ACTIVE_SESSION_HOURS
    ? activeAttendanceRecord
    : null;

  const now = moment();
  const todayStart = moment(now).startOf('day');
  const todayEnd = moment(now).endOf('day');
  const completedAttendances = await Attendance.find({
    employee: employeeId,
    checkIn: { $exists: true, $ne: null },
    checkOut: { $exists: true, $ne: null },
    $or: [
      { date: { $gte: todayStart.toDate(), $lte: todayEnd.toDate() } },
      { checkIn: { $gte: todayStart.toDate(), $lte: todayEnd.toDate() } },
      { checkOut: { $gte: todayStart.toDate(), $lte: todayEnd.toDate() } }
    ]
  })
    .populate('shift', 'name displayName startTime endTime isNightShift')
    .sort({ checkOut: -1, checkIn: -1, createdAt: -1 });

  const attendanceRecordsToPopulate = [
    ...(activeAttendance ? [activeAttendance] : []),
    ...completedAttendances
  ];
  const populatedRecords = await populateLocations(attendanceRecordsToPopulate);
  const populatedActiveAttendance = activeAttendance ? populatedRecords[0] : null;
  const populatedCompletedAttendances = activeAttendance ? populatedRecords.slice(1) : populatedRecords;

  const activeSession = normalizeAttendanceSession(populatedActiveAttendance);
  const todayCompletedSessions = populatedCompletedAttendances.map(normalizeAttendanceSession);
  const latestCompletedSession = todayCompletedSessions[0] || null;
  const overallTodayWorkedHours = Number(
    todayCompletedSessions.reduce((sum, session) => sum + Number(session?.workingHours || 0), 0).toFixed(2)
  );

  return {
    isCheckedIn: Boolean(activeSession),
    activeSession,
    latestCompletedSession,
    todayCompletedSessions,
    overallTodayWorkedHours,
    activeAttendanceId: activeSession?._id || null,
    checkInTime: activeSession?.checkIn || null,
    checkIn: activeSession?.checkIn || null,
    checkOut: activeSession?.checkOut || null,
    selectedShift: activeSession?.selectedShift || null,
    selectedLocation: activeSession?.selectedLocation || null,
    status: activeSession ? 'working' : (latestCompletedSession ? 'completed' : 'pending'),
    attendance: activeSession || latestCompletedSession || null
  };
};

exports.getAttendanceStatus = async (req, res) => {
  try {
    const { Attendance, Shift } = req.models;
    const employeeId = getEmployeeIdFromRequest(req);

    if (!employeeId) {
      return res.status(400).json({ message: 'Employee profile not found' });
    }

    const status = await buildActiveAttendanceStatus(Attendance, Shift, employeeId);
    res.json(status);
  } catch (error) {
    console.error('Get attendance status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.checkIn = async (req, res) => {
  try {
    const { Attendance, Employee, Shift } = req.models;
    const employeeId = getEmployeeIdFromRequest(req);

    if (!employeeId) {
      return res.status(400).json({ message: 'Employee profile not found' });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    let targetShift = null;
    if (req.body.shiftId) {
      if (!mongoose.isValidObjectId(req.body.shiftId)) {
        return res.status(400).json({ message: 'Please select a valid shift' });
      }

      targetShift = await Shift.findOne({
        _id: req.body.shiftId,
        tenant: req.tenant._id,
        isActive: true
      });

      if (!targetShift) {
        return res.status(404).json({ message: 'Shift not found' });
      }
    }

    const activeAttendance = await Attendance.findOne(openAttendanceFilter(employeeId))
      .sort({ checkIn: -1, createdAt: -1 });

    if (isActiveAttendanceSession(activeAttendance)) {
      return res.status(400).json({
        message: 'Please check out from your current attendance before checking in again.'
      });
    }

    const attendanceData = {
      employee: employeeId,
      date: new Date(),
      checkIn: new Date(),
      shift: targetShift?._id || null,
      shiftSource: targetShift ? 'requested' : null,
      shiftName: targetShift ? targetShift.displayName : null,
      status: 'present'
    };

    if (req.body.checkInLat !== undefined && req.body.checkInLat !== null) {
      const latitude = Number(req.body.checkInLat);
      const longitude = Number(req.body.checkInLng);
      const accuracy = Number(req.body.checkInAccuracy);

      if (Number.isFinite(latitude)) attendanceData.checkInLat = latitude;
      if (Number.isFinite(longitude)) attendanceData.checkInLng = longitude;
      if (Number.isFinite(accuracy)) attendanceData.checkInAccuracy = accuracy;
    }
    if (req.body.checkInPlace) {
      attendanceData.checkInPlace = String(req.body.checkInPlace);
    }
    if (req.body.checkInLocation) {
      attendanceData.checkInLocation = req.body.checkInLocation;
    }

    const attendance = await Attendance.create(attendanceData);

    res.status(201).json({
      success: true,
      data: attendance,
      shiftInfo: targetShift ? {
        name: targetShift.displayName,
        startTime: targetShift.startTime,
        endTime: targetShift.endTime
      } : null
    });
  } catch (error) {
    console.error('Check in error:', error);
    if (error.name === 'ValidationError' || error.name === 'CastError' || error.code === 11000) {
      return res.status(400).json({
        message: error.code === 11000
          ? 'Attendance could not be recorded because an old unique attendance index is still active.'
          : error.message
      });
    }
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};

exports.checkOut = async (req, res) => {
  try {
    const { Attendance, Employee, Shift, DepartmentSetting } = req.models;
    const employeeId = getEmployeeIdFromRequest(req);

    if (!employeeId) {
      return res.status(400).json({ message: 'Employee profile not found' });
    }

    const employee = await Employee.findById(employeeId);

    const requestedAttendanceId = req.body?.attendanceId || req.body?.activeAttendanceId;
    const attendanceQuery = requestedAttendanceId && mongoose.isValidObjectId(requestedAttendanceId)
      ? { _id: requestedAttendanceId, employee: employeeId }
      : openAttendanceFilter(employeeId);

    const attendance = await Attendance.findOne(attendanceQuery)
      .sort({ checkIn: -1, createdAt: -1 });

    if (!attendance) {
      return res.status(400).json({ message: "No active check-in found. Please check in first." });
    }

    let targetShift = null;
    if (attendance.shift) {
      targetShift = await Shift.findById(attendance.shift);
    }
    
    let shiftResult = { shift: targetShift, source: attendance.shiftSource || 'attendance' };

    if (attendance.checkOut) {
      return res.status(400).json({ message: 'Already checked out for today' });
    }

    let validationResult = { canCheckOut: true, message: 'No shift restrictions' };

    const { checkOutLat, checkOutLng, checkOutAccuracy, checkOutPlace, checkOutLocation } = req.body || {};

    attendance.checkOut = new Date();
    if (checkOutLat !== undefined) attendance.checkOutLat = Number(checkOutLat);
    if (checkOutLng !== undefined) attendance.checkOutLng = Number(checkOutLng);
    if (checkOutAccuracy !== undefined) attendance.checkOutAccuracy = Number(checkOutAccuracy);
    if (checkOutPlace) attendance.checkOutPlace = String(checkOutPlace);
    if (checkOutLocation) attendance.checkOutLocation = checkOutLocation;

    attendance.isEarlyCheckOut = false;
    attendance.checkOutStatus = null;

    await attendance.save();

    const shouldResolveCheckOutPlace = (
      attendance.checkOutLat != null
      && attendance.checkOutLng != null
      && !attendance.checkOutPlace
    );
    const attendanceId = attendance._id;
    const checkOutLatForPlace = attendance.checkOutLat;
    const checkOutLngForPlace = attendance.checkOutLng;
    const AttendanceModel = attendance.constructor;

    res.json({
      ...attendance.toObject(),
      shiftInfo: shiftResult.shift ? {
        name: shiftResult.shift.displayName,
        startTime: shiftResult.shift.startTime,
        endTime: shiftResult.shift.endTime,
        source: shiftResult.source,
        checkOutStatus: validationResult.status
      } : null
    });

    if (shouldResolveCheckOutPlace) {
      setImmediate(async () => {
        try {
          const place = await reverseGeocode(checkOutLatForPlace, checkOutLngForPlace);
          if (place) {
            await AttendanceModel.updateOne(
              { _id: attendanceId, checkOutPlace: { $exists: false } },
              { $set: { checkOutPlace: place } }
            );
          }
        } catch (err) {
          console.warn('Reverse geocode error (check-out):', err && err.message ? err.message : err);
        }
      });
    }
  } catch (error) {
    console.error('Check out error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const populateLocations = async (attendanceRecords, models = {}) => {
  if (!attendanceRecords || attendanceRecords.length === 0) return attendanceRecords;

  try {
    const locationIds = new Set();
    attendanceRecords.forEach(record => {
      if (record.checkInLocation) locationIds.add(record.checkInLocation.toString());
      if (record.checkOutLocation) locationIds.add(record.checkOutLocation.toString());
    });

    if (locationIds.size === 0) return attendanceRecords;

    const ids = Array.from(locationIds);
    const locationModels = [];

    if (models.Location) {
      locationModels.push(models.Location);
    }

    const { getSuperAdminModels } = require('../config/db');
    const { Location: SuperAdminLocation } = getSuperAdminModels();
    if (SuperAdminLocation && SuperAdminLocation !== models.Location) {
      locationModels.push(SuperAdminLocation);
    }

    const locationResults = await Promise.allSettled(
      locationModels.map(Location => Location.find({ _id: { $in: ids } }).select('name address locationName'))
    );
    const locations = locationResults
      .filter(result => result.status === 'fulfilled')
      .flatMap(result => result.value || []);

    const locationMap = locations.reduce((map, loc) => {
      map[loc._id.toString()] = loc;
      return map;
    }, {});

    return attendanceRecords.map(record => {
      const recordObj = typeof record.toObject === 'function' ? record.toObject() : record;
      if (record.checkInLocation) {
        recordObj.checkInLocation = locationMap[record.checkInLocation.toString()] || { _id: record.checkInLocation };
      }
      if (record.checkOutLocation) {
        recordObj.checkOutLocation = locationMap[record.checkOutLocation.toString()] || { _id: record.checkOutLocation };
      }
      return recordObj;
    });
  } catch (error) {
    console.error('Error manually populating locations:', error);
    return attendanceRecords;
  }
};

const resolveLocationName = async (locationId, models = {}) => {
  if (!locationId || !mongoose.isValidObjectId(locationId)) return '';

  try {
    if (models.Location) {
      const tenantLocation = await models.Location.findById(locationId).select('name address locationName');
      if (tenantLocation) {
        return tenantLocation.name || tenantLocation.locationName || tenantLocation.address || '';
      }
    }

    const { getSuperAdminModels } = require('../config/db');
    const { Location } = getSuperAdminModels();
    const location = await Location.findById(locationId).select('name address locationName');
    return location?.name || location?.locationName || location?.address || '';
  } catch (error) {
    return '';
  }
};

const applyAttendanceEditValues = async ({
  attendance,
  req,
  newCheckIn,
  newCheckOut,
  attendanceDate,
  requestedStatus,
  selectedShift,
  locationId,
  reason,
  defaultReason = ''
}) => {
  const newShiftId = selectedShift ? selectedShift._id : null;
  const newShiftName = selectedShift ? (selectedShift.displayName || selectedShift.name) : '';
  const newLocationName = await resolveLocationName(locationId, req.models);
  const oldCheckIn = attendance.checkIn || null;
  const oldCheckOut = attendance.checkOut || null;
  const oldStatus = attendance.status || '';
  const oldShiftName = attendance.shiftName || attendance.shift?.displayName || attendance.shift?.name || '';
  const oldLocationName = await resolveLocationName(attendance.checkInLocation, req.models);
  const oldWorkingHours = Number(attendance.workingHours || 0);
  const workingHours = requestedStatus === 'absent'
    ? 0
    : (newCheckOut ? calculateWorkingHours({ checkIn: newCheckIn, checkOut: newCheckOut }) : 0);

  attendance.checkIn = newCheckIn;
  attendance.checkOut = newCheckOut;
  attendance.date = attendanceDate;
  attendance.workingHours = workingHours;
  attendance.adjustedHours = workingHours;
  attendance.status = requestedStatus;
  attendance.shift = newShiftId;
  attendance.shiftSource = selectedShift ? 'requested' : null;
  attendance.shiftName = selectedShift ? newShiftName : null;
  attendance.checkInLocation = locationId || null;
  attendance.attendanceTimeEditAudit = attendance.attendanceTimeEditAudit || [];
  attendance.attendanceTimeEditAudit.push({
    editedBy: req.user._id,
    editedByName: req.user.employee?.name || '',
    editedByEmail: req.user.email || req.user.employee?.email || '',
    oldCheckIn,
    oldCheckOut,
    newCheckIn,
    newCheckOut,
    oldStatus,
    newStatus: requestedStatus,
    oldShiftName,
    newShiftName,
    oldLocationName,
    newLocationName,
    oldWorkingHours,
    newWorkingHours: workingHours,
    editedAt: new Date(),
    reason: reason ? String(reason).trim() : defaultReason
  });

  return workingHours;
};

exports.getMyAttendance = async (req, res) => {
  try {
    const { Attendance } = req.models;
    const { month, year } = req.query;
    let startDate, endDate;

    if (month && year) {
      startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
    } else {
      startDate = moment().startOf('month').toDate();
      endDate = moment().endOf('month').toDate();
    }

    const attendance = await Attendance.find({
      employee: req.user.employee._id,
      $or: [
        { date: { $gte: startDate, $lte: endDate } },
        {
          checkIn: { $exists: true, $ne: null },
          $or: [
            { checkOut: { $exists: false } },
            { checkOut: null }
          ]
        }
      ]
    })
      .sort({ date: -1 });

    const populatedAttendance = await populateLocations(attendance, req.models);

    res.json(populatedAttendance);
  } catch (error) {
    console.error('Get my attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getAllAttendance = async (req, res) => {
  try {
    const { Attendance, Employee } = req.models;
    const { month, year, employeeId } = req.query;
    let startDate, endDate;

    if (month && year) {
      startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
    } else {
      startDate = moment().startOf('month').toDate();
      endDate = moment().endOf('month').toDate();
    }

    let filter = {
      $or: [
        { date: { $gte: startDate, $lte: endDate } },
        {
          checkIn: { $exists: true, $ne: null },
          $or: [
            { checkOut: { $exists: false } },
            { checkOut: null }
          ]
        }
      ]
    };

    if (employeeId) {
      filter.employee = employeeId;
    }

    const attendance = await Attendance.find(filter)
      .populate('employee', 'name email department position')
      .populate('shift', 'name displayName startTime endTime isNightShift')
      .sort({ date: -1 });

    const populatedAttendance = await populateLocations(attendance, req.models);

    res.json(populatedAttendance);
  } catch (error) {
    console.error('Get all attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.updateAttendanceTime = async (req, res) => {
  try {
    const { Attendance, Employee } = req.models;

    if (req.user.role !== 'admin' || !req.user.canEditAttendanceTime) {
      return res.status(403).json({ message: 'You do not have permission to edit attendance time.' });
    }

    const { checkIn, checkOut, reason, status, dayType, shiftId, locationId } = req.body || {};
    if (!checkIn) {
      return res.status(400).json({ message: 'Check-in time is required.' });
    }

    const newCheckIn = new Date(checkIn);
    if (Number.isNaN(newCheckIn.getTime())) {
      return res.status(400).json({ message: 'Invalid check-in time.' });
    }

    let newCheckOut = null;
    if (checkOut !== undefined && checkOut !== null && String(checkOut).trim() !== '') {
      newCheckOut = new Date(checkOut);
      if (Number.isNaN(newCheckOut.getTime())) {
        return res.status(400).json({ message: 'Invalid checkout time.' });
      }

      if (newCheckOut <= newCheckIn) {
        return res.status(400).json({ message: 'Checkout time must be after check-in time.' });
      }
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid attendance record.' });
    }

    let attendance = await Attendance.findById(req.params.id).populate('employee', 'name email tenant');
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found.' });
    }

    const employee = attendance.employee && attendance.employee._id
      ? attendance.employee
      : await Employee.findById(attendance.employee);

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found for attendance record.' });
    }

    const employeeTenant = employee.tenant ? employee.tenant.toString() : null;
    const requestTenant = req.tenant?._id?.toString();
    if (employeeTenant && requestTenant && employeeTenant !== requestTenant) {
      return res.status(403).json({ message: 'Access denied for this tenant' });
    }

    const requestedStatus = status === 'absent'
      ? 'absent'
      : (dayType === 'half-day' ? 'half-day' : 'present');
    let selectedShift = null;
    if (shiftId) {
      if (!mongoose.isValidObjectId(shiftId)) {
        return res.status(400).json({ message: 'Invalid shift.' });
      }

      selectedShift = await req.models.Shift.findOne({
        _id: shiftId,
        tenant: req.tenant._id,
        isActive: true
      });

      if (!selectedShift) {
        return res.status(404).json({ message: 'Shift not found.' });
      }
    }

    if (locationId && !mongoose.isValidObjectId(locationId)) {
      return res.status(400).json({ message: 'Invalid location.' });
    }
    const newAttendanceDate = moment(newCheckIn).startOf('day').toDate();
    const newShiftId = selectedShift ? selectedShift._id : null;
    const duplicateAttendance = await Attendance.findOne({
      _id: { $ne: attendance._id },
      employee: employee._id || employee,
      date: newAttendanceDate,
      shift: newShiftId
    });

    if (duplicateAttendance) {
      attendance = duplicateAttendance;
    }

    const workingHours = await applyAttendanceEditValues({
      attendance,
      req,
      newCheckIn,
      newCheckOut,
      attendanceDate: newAttendanceDate,
      requestedStatus,
      selectedShift,
      locationId,
      reason
    });

    await attendance.save();

    if (requestedStatus === 'absent' || requestedStatus === 'half-day' || requestedStatus === 'present') {
      attendance.status = requestedStatus;
      attendance.workingHours = workingHours;
      attendance.adjustedHours = workingHours;
      await Attendance.updateOne(
        { _id: attendance._id },
        {
          $set: {
            status: attendance.status,
            workingHours: attendance.workingHours,
            adjustedHours: attendance.adjustedHours
          }
        }
      );
    }

    // If admin marked this record as absent, notify the employee via socket
    if (requestedStatus === 'absent') {
      try {
        const { User: UserModel, Notification: NotificationModel } = req.models;
        if (UserModel && NotificationModel) {
          const empId = employee._id || employee;
          const tenantId = req.tenant._id;
          const employeeUser = await UserModel.findOne({
            employee: empId,
            tenant: tenantId,
            isActive: true
          }).select('_id');

          if (employeeUser) {
            const notification = await NotificationModel.create({
              user:          employeeUser._id,
              employee:      empId,
              tenant:        tenantId,
              type:          'absent',
              title:         'Marked absent by admin',
              message:       `Your attendance for ${moment(newAttendanceDate).format('MMM D, YYYY')} has been marked absent by an admin.`,
              relatedEntity: 'attendance',
              entityId:      attendance._id,
              isRead:        false
            });
            emitToUserClients(employeeUser._id.toString(), notification);
          }
        }
      } catch (notifyErr) {
        console.error('[updateAttendanceTime] Absent notify failed:', notifyErr.message);
      }
    }

    await attendance.populate('employee', 'name email department position');
    await attendance.populate('shift', 'name displayName startTime endTime isNightShift');

    const [populated] = await populateLocations([attendance], req.models);
    res.json(populated || attendance);
  } catch (error) {
    console.error('Update attendance time error:', error);
    if (isDuplicateAttendanceKeyError(error)) {
      return res.status(409).json({ message: DUPLICATE_ATTENDANCE_MESSAGE });
    }
    res.status(500).json({ message: 'Server error' });
  }
};

exports.deleteAttendanceEntry = async (req, res) => {
  try {
    const { Attendance, Employee } = req.models;

    if (req.user.role !== 'admin' || !req.user.canEditAttendanceTime) {
      return res.status(403).json({ message: 'You do not have permission to delete attendance entries.' });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid attendance record.' });
    }

    const attendance = await Attendance.findById(req.params.id).populate('employee', 'tenant');
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found.' });
    }

    const employee = attendance.employee && attendance.employee._id
      ? attendance.employee
      : await Employee.findById(attendance.employee).select('tenant');

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found for attendance record.' });
    }

    const employeeTenant = employee.tenant ? employee.tenant.toString() : null;
    const requestTenant = req.tenant?._id?.toString();
    if (employeeTenant && requestTenant && employeeTenant !== requestTenant) {
      return res.status(403).json({ message: 'Access denied for this tenant' });
    }

    await Attendance.deleteOne({ _id: attendance._id });
    res.json({ message: 'Attendance record deleted successfully.' });
  } catch (error) {
    console.error('Delete attendance entry error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.createAdminAttendanceEntry = async (req, res) => {
  try {
    const { Attendance, Employee } = req.models;

    if (req.user.role !== 'admin' || !req.user.canEditAttendanceTime) {
      return res.status(403).json({ message: 'You do not have permission to create attendance entries.' });
    }

    const { employeeId, checkIn, checkOut, reason, status, dayType, shiftId, locationId } = req.body || {};

    if (!employeeId || !mongoose.isValidObjectId(employeeId)) {
      return res.status(400).json({ message: 'Please select a valid employee.' });
    }

    if (!checkIn) {
      return res.status(400).json({ message: 'Check-in time is required.' });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found.' });
    }

    const employeeTenant = employee.tenant ? employee.tenant.toString() : null;
    const requestTenant = req.tenant?._id?.toString();
    if (employeeTenant && requestTenant && employeeTenant !== requestTenant) {
      return res.status(403).json({ message: 'Access denied for this tenant' });
    }

    const newCheckIn = new Date(checkIn);
    if (Number.isNaN(newCheckIn.getTime())) {
      return res.status(400).json({ message: 'Invalid check-in time.' });
    }

    let newCheckOut = null;
    if (checkOut !== undefined && checkOut !== null && String(checkOut).trim() !== '') {
      newCheckOut = new Date(checkOut);
      if (Number.isNaN(newCheckOut.getTime())) {
        return res.status(400).json({ message: 'Invalid checkout time.' });
      }

      if (newCheckOut <= newCheckIn) {
        return res.status(400).json({ message: 'Checkout time must be after check-in time.' });
      }
    }

    const requestedStatus = status === 'absent'
      ? 'absent'
      : (dayType === 'half-day' ? 'half-day' : 'present');

    let selectedShift = null;
    if (shiftId) {
      if (!mongoose.isValidObjectId(shiftId)) {
        return res.status(400).json({ message: 'Invalid shift.' });
      }

      selectedShift = await req.models.Shift.findOne({
        _id: shiftId,
        tenant: req.tenant._id,
        isActive: true
      });

      if (!selectedShift) {
        return res.status(404).json({ message: 'Shift not found.' });
      }
    }

    if (locationId && !mongoose.isValidObjectId(locationId)) {
      return res.status(400).json({ message: 'Invalid location.' });
    }

    const newLocationName = await resolveLocationName(locationId, req.models);
    const attendanceDate = moment(newCheckIn).startOf('day').toDate();
    const selectedShiftId = selectedShift ? selectedShift._id : null;
    const duplicateAttendance = await Attendance.findOne({
      employee: employeeId,
      date: attendanceDate,
      shift: selectedShiftId
    });

    const workingHours = requestedStatus === 'absent'
      ? 0
      : (newCheckOut ? calculateWorkingHours({ checkIn: newCheckIn, checkOut: newCheckOut }) : 0);

    let savedAttendance;

    if (duplicateAttendance) {
      const updatedWorkingHours = await applyAttendanceEditValues({
        attendance: duplicateAttendance,
        req,
        newCheckIn,
        newCheckOut,
        attendanceDate,
        requestedStatus,
        selectedShift,
        locationId,
        reason,
        defaultReason: 'Updated existing attendance by admin'
      });

      await duplicateAttendance.save();
      await Attendance.updateOne(
        { _id: duplicateAttendance._id },
        {
          $set: {
            status: requestedStatus,
            workingHours: updatedWorkingHours,
            adjustedHours: updatedWorkingHours
          }
        }
      );
      duplicateAttendance.status = requestedStatus;
      duplicateAttendance.workingHours = updatedWorkingHours;
      duplicateAttendance.adjustedHours = updatedWorkingHours;

      savedAttendance = duplicateAttendance;

      await duplicateAttendance.populate('employee', 'name email department position');
      await duplicateAttendance.populate('shift', 'name displayName startTime endTime isNightShift');

      const [populated] = await populateLocations([duplicateAttendance], req.models);

      // Notify if admin-marked absent
      if (requestedStatus === 'absent') {
        try {
          const { User: UserModel, Notification: NotificationModel } = req.models;
          if (UserModel && NotificationModel) {
            const empUser = await UserModel.findOne({
              employee: employeeId,
              tenant: req.tenant._id,
              isActive: true
            }).select('_id');
            if (empUser) {
              const notification = await NotificationModel.create({
                user:          empUser._id,
                employee:      employeeId,
                tenant:        req.tenant._id,
                type:          'absent',
                title:         'Marked absent by admin',
                message:       `Your attendance for ${moment(attendanceDate).format('MMM D, YYYY')} has been marked absent by an admin.`,
                relatedEntity: 'attendance',
                entityId:      duplicateAttendance._id,
                isRead:        false
              });
              emitToUserClients(empUser._id.toString(), notification);
            }
          }
        } catch (notifyErr) {
          console.error('[createAdminAttendanceEntry] Absent notify failed:', notifyErr.message);
        }
      }

      return res.json(populated || duplicateAttendance);
    }

    const attendance = await Attendance.create({
      employee: employeeId,
      date: attendanceDate,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      workingHours,
      adjustedHours: workingHours,
      status: requestedStatus,
      shift: selectedShiftId,
      shiftSource: selectedShift ? 'requested' : null,
      shiftName: selectedShift ? (selectedShift.displayName || selectedShift.name) : null,
      checkInLocation: locationId || null,
      attendanceTimeEditAudit: [{
        editedBy: req.user._id,
        editedByName: req.user.employee?.name || '',
        editedByEmail: req.user.email || req.user.employee?.email || '',
        oldCheckIn: null,
        oldCheckOut: null,
        newCheckIn,
        newCheckOut,
        oldStatus: '',
        newStatus: requestedStatus,
        oldShiftName: '',
        newShiftName: selectedShift ? (selectedShift.displayName || selectedShift.name) : '',
        oldLocationName: '',
        newLocationName,
        oldWorkingHours: 0,
        newWorkingHours: workingHours,
        editedAt: new Date(),
        reason: reason ? String(reason).trim() : 'Created by admin'
      }]
    });

    if (requestedStatus === 'absent' || requestedStatus === 'half-day' || requestedStatus === 'present') {
      await Attendance.updateOne(
        { _id: attendance._id },
        {
          $set: {
            status: requestedStatus,
            workingHours,
            adjustedHours: workingHours
          }
        }
      );
      attendance.status = requestedStatus;
      attendance.workingHours = workingHours;
      attendance.adjustedHours = workingHours;
    }

    // Notify if admin-marked absent
    if (requestedStatus === 'absent') {
      try {
        const { User: UserModel, Notification: NotificationModel } = req.models;
        if (UserModel && NotificationModel) {
          const empUser = await UserModel.findOne({
            employee: employeeId,
            tenant: req.tenant._id,
            isActive: true
          }).select('_id');
          if (empUser) {
            const notification = await NotificationModel.create({
              user:          empUser._id,
              employee:      employeeId,
              tenant:        req.tenant._id,
              type:          'absent',
              title:         'Marked absent by admin',
              message:       `Your attendance for ${moment(attendanceDate).format('MMM D, YYYY')} has been marked absent by an admin.`,
              relatedEntity: 'attendance',
              entityId:      attendance._id,
              isRead:        false
            });
            emitToUserClients(empUser._id.toString(), notification);
          }
        }
      } catch (notifyErr) {
        console.error('[createAdminAttendanceEntry] Absent notify failed:', notifyErr.message);
      }
    }

    await attendance.populate('employee', 'name email department position');
    await attendance.populate('shift', 'name displayName startTime endTime isNightShift');

    const [populated] = await populateLocations([attendance], req.models);
    res.status(201).json(populated || attendance);
  } catch (error) {
    console.error('Create admin attendance entry error:', error);
    if (isDuplicateAttendanceKeyError(error)) {
      return res.status(409).json({ message: DUPLICATE_ATTENDANCE_MESSAGE });
    }
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getAttendanceSummary = async (req, res) => {
  try {
    const { Attendance } = req.models;
    const { month, year } = req.query;
    const startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
    const endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();

    const summary = await Attendance.aggregate([
      {
        $match: {
          date: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$employee',
          totalPresent: {
            $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] }
          },
          totalHalfDay: {
            $sum: { $cond: [{ $eq: ['$status', 'half-day'] }, 1, 0] }
          },
          totalWorkingHours: { $sum: '$workingHours' }
        }
      },
      {
        $lookup: {
          from: 'employees',
          localField: '_id',
          foreignField: '_id',
          as: 'employee'
        }
      },
      {
        $unwind: '$employee'
      },
      {
        $project: {
          'employee.name': 1,
          'employee.email': 1,
          'employee.department': 1,
          totalPresent: 1,
          totalHalfDay: 1,
          totalWorkingHours: 1
        }
      }
    ]);

    res.json(summary);
  } catch (error) {
    console.error('Get attendance summary error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getAttendanceWithPermissions = async (req, res) => {
  try {
    const { month, year } = req.query;
    let startDate, endDate;

    if (month && year) {
      startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
    } else {
      startDate = moment().startOf('month').toDate();
      endDate = moment().endOf('month').toDate();
    }

    const attendance = await Attendance.find({
      employee: req.user.employee._id,
      date: { $gte: startDate, $lte: endDate }
    })
      .populate('permissions.permission')
      .sort({ date: -1 });

    res.json(attendance);
  } catch (error) {
    console.error('Get attendance with permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getEmployeeWithShift = async (req, Employee) => {
  const employee = await Employee.findById(req.user.employee._id);
  return employee;
};

const createAttendanceWithShift = async (req, Attendance, employee, shiftResult, checkInTime, locationData) => {
  const attendanceData = {
    employee: req.user.employee._id,
    date: new Date(),
    checkIn: checkInTime,
    shift: shiftResult.shift ? shiftResult.shift._id : null,
    shiftSource: shiftResult.source,
    shiftName: shiftResult.shift ? shiftResult.shift.displayName : null,
    isLateCheckIn: shiftResult.isLate || false,
    checkInStatus: shiftResult.status || null
  };

  if (locationData) {
    if (locationData.lat !== undefined) attendanceData.checkInLat = Number(locationData.lat);
    if (locationData.lng !== undefined) attendanceData.checkInLng = Number(locationData.lng);
    if (locationData.accuracy !== undefined) attendanceData.checkInAccuracy = Number(locationData.accuracy);
    if (locationData.place) attendanceData.checkInPlace = String(locationData.place);
  }

  return await Attendance.create(attendanceData);
};

exports.getTodayShiftsStatus = async (req, res) => {
  try {
    const { Attendance, Employee, Shift } = req.models;
    const today = moment().startOf('day');
    const yesterday = moment(today).subtract(1, 'day');
    const now = new Date();

    const employee = await Employee.findById(req.user.employee._id);
    
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    
    const todayAttendances = await Attendance.find({
      employee: req.user.employee._id,
      $or: [
        {
          date: {
            $gte: yesterday.toDate(),
            $lte: moment(today).endOf('day').toDate()
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
    });

    let applicableShifts = await Shift.find({
      tenant: req.tenant._id,
      isActive: true
    }).sort({ startTime: 1 });

    const attendanceShiftIds = new Set(
      todayAttendances
        .map(a => a.shift)
        .filter(Boolean)
        .map(s => s.toString())
    );

    if (attendanceShiftIds.size > 0) {
      const shiftsFromAttendance = await Shift.find({
        tenant: req.tenant._id,
        isActive: true,
        _id: { $in: Array.from(attendanceShiftIds) }
      });

      const byId = new Map();
      [...applicableShifts, ...shiftsFromAttendance].forEach(s => byId.set(s._id.toString(), s));
      applicableShifts = Array.from(byId.values()).sort({ startTime: 1 });
    }

    const hasRecordedCheckout = (record) => record?.checkOut !== undefined && record?.checkOut !== null && record?.checkOut !== '';
    const activeAttendance = todayAttendances
      .filter(att => att.checkIn && !hasRecordedCheckout(att))
      .sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn))[0] || null;

    const shiftsWithStatus = applicableShifts.map(shift => {
      const attendance = activeAttendance?.shift?.toString() === shift._id.toString() ? activeAttendance : null;
      const status = attendance ? 'checked_in' : 'pending';
      
      return {
        _id: shift._id,
        name: shift.displayName,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isNightShift: shift.isNightShift || false,
        status: status,
        checkIn: attendance?.checkIn,
        checkOut: attendance?.checkOut,
        canCheckIn: !activeAttendance && status === 'pending',
        canCheckOut: status === 'checked_in',
        checkInWindow: { canCheckIn: !activeAttendance, message: 'No shift time restrictions' },
        workingHours: attendance?.workingHours
      };
    });

    const activeShift = shiftsWithStatus.find(s => s.status === 'checked_in');
    const nextShift = shiftsWithStatus.find(s => s.status === 'pending' && s.canCheckIn);

    res.json({
      success: true,
      data: {
        shifts: shiftsWithStatus,
        activeShift,
        nextShift,
        hasMoreShifts: shiftsWithStatus.some(s => s.status === 'pending'),
        totalShifts: shiftsWithStatus.length,
        completedShifts: shiftsWithStatus.filter(s => s.status === 'completed').length
      }
    });
  } catch (error) {
    console.error('Get today shifts status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// =============================================================================
// ABSENT NOTIFICATION HELPER
// Used by both cron jobs below to create a DB notification and emit via socket.
// =============================================================================
const _notifyAbsent = async ({ tenantId, employeeId, reason, User, Notification }) => {
  try {
    if (!User || !Notification || !tenantId || !employeeId) return;

    const user = await User.findOne({
      employee: employeeId,
      tenant: tenantId,
      isActive: true
    }).select('_id');

    if (!user) return;

    const titles = {
      'no-checkin':          'Absent — no check-in recorded',
      'not-checked-out-24h': 'Absent — session left open',
      'admin-marked':        'Marked absent by admin',
    };
    const messages = {
      'no-checkin':          'You were marked absent today because no check-in was recorded.',
      'not-checked-out-24h': 'Your check-in session was open for over 24 hours and has been closed as absent.',
      'admin-marked':        'Your attendance for today has been marked absent by an admin.',
    };

    const notification = await Notification.create({
      user:          user._id,
      employee:      employeeId,
      tenant:        tenantId,
      type:          'absent',
      title:         titles[reason] || 'Absent',
      message:       messages[reason] || 'You have been marked absent.',
      relatedEntity: 'attendance',
      isRead:        false
    });

    emitToUserClients(user._id.toString(), notification);
  } catch (err) {
    console.error('[AbsentNotify] Failed to notify employee', employeeId, ':', err.message);
  }
};

// =============================================================================
// AUTO-ABSENT CRON JOB
// Runs every day at 23:59 — marks absent for employees with no check-in.
// Skips Sundays entirely (no absent record created on Sundays).
// Uses insertMany with ordered:false so one failure won't block others.
// The autoMarked flag distinguishes cron records from real check-ins.
// No existing logic above is touched by this block.
// =============================================================================
const cron = require('node-cron');

const _isSunday  = (date) => date.getDay() === 0;
const _startOfDay = (date) => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; };

const _markAbsentForDate = async (targetDate = new Date()) => {
  const result = { marked: 0, skipped: 0, errors: 0 };

  if (_isSunday(targetDate)) {
    console.log(`[AutoAbsent] ${targetDate.toDateString()} is Sunday — skipping.`);
    return result;
  }

  const dayStart = _startOfDay(targetDate);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);

  console.log(`[AutoAbsent] Marking absent for: ${dayStart.toDateString()}`);

  try {
    const { getAllTenantModels } = require('../config/db');
    const tenantModelsList = getAllTenantModels();

    for (const { Attendance: TAttendance, Employee: TEmployee, User: TUser, Notification: TNotification, tenantId } of tenantModelsList) {
      try {
        const employees = await TEmployee.find({ isActive: { $ne: false } }).select('_id');
        if (!employees.length) continue;

        const existingRecords = await TAttendance.find({
          $or: [
            { date:    { $gte: dayStart, $lte: dayEnd } },
            { checkIn: { $gte: dayStart, $lte: dayEnd } }
          ]
        }).select('employee');

        const employeesWithRecord = new Set(existingRecords.map(r => r.employee.toString()));

        const absentDocs = [];
        const absentEmployeeIds = [];

        for (const emp of employees) {
          if (employeesWithRecord.has(emp._id.toString())) {
            result.skipped++;
            continue;
          }
          absentDocs.push({
            employee:      emp._id,
            date:          dayStart,
            checkIn:       dayStart,
            checkOut:      dayStart,
            workingHours:  0,
            adjustedHours: 0,
            status:        'absent',
            autoMarked:    true,
            autoMarkedAt:  new Date(),
            absentReason:  'no-checkin'
          });
          absentEmployeeIds.push(emp._id);
        }

        if (!absentDocs.length) {
          console.log('[AutoAbsent] All employees already have records — nothing to do.');
          continue;
        }

        try {
          const insertResult = await TAttendance.insertMany(absentDocs, { ordered: false, rawResult: true });
          result.marked += insertResult.insertedCount ?? absentDocs.length;
        } catch (bulkErr) {
          result.marked += bulkErr?.result?.nInserted ?? 0;
          result.errors += absentDocs.length - (bulkErr?.result?.nInserted ?? 0);
          console.warn(`[AutoAbsent] Partial insert — ${result.marked} marked, ${result.errors} errored:`, bulkErr.message);
        }

        // Notify each newly-absent employee
        for (const empId of absentEmployeeIds) {
          await _notifyAbsent({
            tenantId,
            employeeId: empId,
            reason: 'no-checkin',
            User: TUser,
            Notification: TNotification
          });
        }
      } catch (tenantErr) {
        console.error('[AutoAbsent] Tenant error:', tenantErr.message);
        result.errors++;
      }
    }

    console.log(`[AutoAbsent] Done — marked: ${result.marked}, skipped: ${result.skipped}, errors: ${result.errors}`);
  } catch (err) {
    console.error('[AutoAbsent] Failed:', err.message);
    result.errors++;
  }

  return result;
};

cron.schedule('59 23 * * *', async () => {
  console.log('[AutoAbsent] Cron triggered');
  try {
    await _markAbsentForDate(new Date());
  } catch (err) {
    console.error('[AutoAbsent] Unexpected cron error:', err);
  }
}, { timezone: 'Asia/Kolkata' });

console.log('[AutoAbsent] Cron scheduled — daily at 23:59 Asia/Kolkata');

exports._markAbsentForDate = _markAbsentForDate;
exports._notifyAbsent      = _notifyAbsent;

// =============================================================================
// AUTO-CLOSE 24H CRON JOB
// Runs every hour. If an employee checked in but didn't check out after 24 hours,
// it automatically marks the session as 'absent' with 0 working hours.
// =============================================================================
cron.schedule('0 * * * *', async () => {
  console.log('[AutoClose24h] Checking for sessions open > 24 hours...');
  try {
    const { getAllTenantModels } = require('../config/db');
    const tenantModelsList = getAllTenantModels();
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    for (const { Attendance: TAttendance, User: TUser, Notification: TNotification, tenantId } of tenantModelsList) {
      try {
        const openSessions = await TAttendance.find({
          checkIn: { $exists: true, $ne: null, $lte: twentyFourHoursAgo },
          $or: [
            { checkOut: { $exists: false } },
            { checkOut: null }
          ],
          status: { $ne: 'absent' }
        });

        for (const session of openSessions) {
          session.workingHours  = 0;
          session.adjustedHours = 0;
          session.status        = 'absent';
          session.autoMarked    = true;
          session.autoMarkedAt  = new Date();
          session.absentReason  = 'not-checked-out-24h';

          // IMPORTANT: We intentionally leave checkOut as null.
          // This ensures the frontend tables only show the Check-In time.

          await session.save();

          // Notify the employee their session was auto-closed
          await _notifyAbsent({
            tenantId,
            employeeId: session.employee,
            reason: 'not-checked-out-24h',
            User: TUser,
            Notification: TNotification
          });
        }

        if (openSessions.length > 0) {
          console.log(`[AutoClose24h] Marked ${openSessions.length} sessions as absent (open > 24h) and notified employees.`);
        }
      } catch (tenantErr) {
        console.error('[AutoClose24h] Tenant error:', tenantErr.message);
      }
    }
  } catch (err) {
    console.error('[AutoClose24h] Failed:', err.message);
  }
});

console.log('[AutoClose24h] Cron scheduled — hourly check for >24h open sessions');