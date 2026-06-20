const express = require('express');
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  streamNotifications,
} = require('../controllers/notificationController');
const { protect } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');
// sseAuth removed

const router = express.Router();

router.use(protect);

router.route('/')
 .get(getNotifications);

router.route('/read-all')
  .put(markAllAsRead);

router.route('/unread-count')
  .get(getUnreadCount);

// /stream route removed

router.route('/:id/read')
  .put(markAsRead);

module.exports = router;
