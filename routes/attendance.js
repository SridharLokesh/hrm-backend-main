//attendance routes
const express = require('express');
const {
  checkIn,
  checkOut,
  getMyAttendance,
  getAllAttendance,
  getAttendanceSummary,
  getAttendanceWithPermissions,
  getAttendanceStatus,
  getTodayShiftsStatus,
  updateAttendanceTime,
  deleteAttendanceEntry,
  createAdminAttendanceEntry
} = require('../controllers/attendanceController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.post('/checkin', checkIn);
router.post('/checkout', checkOut);
router.get('/status', getAttendanceStatus);
router.get('/my-attendance', getMyAttendance);
router.get('/today-shifts', getTodayShiftsStatus);
router.post('/admin-create', authorize('admin'), createAdminAttendanceEntry);
router.get('/', authorize('admin'), getAllAttendance);
router.put('/:id/time', authorize('admin'), updateAttendanceTime);
router.delete('/:id', authorize('admin'), deleteAttendanceEntry);
router.get('/summary', authorize('admin'), getAttendanceSummary);
router.get('/with-permissions', getAttendanceWithPermissions);

module.exports = router;
