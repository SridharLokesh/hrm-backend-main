const express = require('express');
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  deleteNotification,   // ← add this export to notificationController
} = require('../controllers/notificationController');
const { protect }       = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getNotifications);

router.route('/read-all')
  .put(markAllAsRead);

router.route('/unread-count')
  .get(getUnreadCount);

router.route('/:id/read')
  .put(markAsRead);

// ← NEW: delete a single notification
router.route('/:id')
  .delete(deleteNotification);

module.exports = router;