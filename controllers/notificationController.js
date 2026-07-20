const mongoose            = require('mongoose');
const DefaultNotification = require('../models/Notification');

const resolveModel = (req, name, defaultSchema) => {
  if (req?.models?.[name]) return req.models[name];
  const schema = defaultSchema?.schema ?? defaultSchema;
  if (mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

// ─── SSE client registry ──────────────────────────────────────────────────────
// Maps userId (string) → Set of active response objects
const clients = new Map();

/**
 * Push a notification object to all open SSE tabs for a given user.
 * Called from leaveController, permissionController, attendanceController.
 */
exports.emitToUserClients = (userId, notification) => {
  const userClients = clients.get(userId);
  if (!userClients) return;

  const payload = `event: newNotification\ndata: ${JSON.stringify(notification)}\n\n`;
  userClients.forEach((res) => {
    if (!res.writableEnded) res.write(payload);
  });

  console.log(`📢 Pushed notification to ${userClients.size} tab(s) for user ${userId}`);
};

const getModels = (req) => ({
  Notification: resolveModel(req, 'Notification', DefaultNotification)
});

// ─── @desc  Get all notifications for the logged-in user ─────────────────────
// ─── @route GET /api/notifications
// ─── @access Private
exports.getNotifications = async (req, res) => {
  if (!req.user || !req.tenant) {
    return res.status(200).json({ success: true, data: [] });
  }

  try {
    const { Notification } = getModels(req);

    const notifications = await Notification.find({
      user:   req.user._id,
      tenant: req.tenant._id
    })
      .populate('employee', 'name')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─── @desc  Mark a single notification as read ───────────────────────────────
// ─── @route PUT /api/notifications/:id/read
// ─── @access Private
exports.markAsRead = async (req, res) => {
  try {
    const { Notification } = getModels(req);

    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, tenant: req.tenant._id },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.status(200).json({ success: true, data: notification });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─── @desc  Mark all notifications as read ───────────────────────────────────
// ─── @route PUT /api/notifications/read-all
// ─── @access Private
exports.markAllAsRead = async (req, res) => {
  try {
    const { Notification } = getModels(req);

    await Notification.updateMany(
      { user: req.user._id, tenant: req.tenant._id, isRead: false },
      { isRead: true }
    );

    res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─── @desc  Delete a single notification ─────────────────────────────────────
// ─── @route DELETE /api/notifications/:id
// ─── @access Private
exports.deleteNotification = async (req, res) => {
  try {
    const { Notification } = getModels(req);

    const notification = await Notification.findOneAndDelete({
      _id:    req.params.id,
      user:   req.user._id,
      tenant: req.tenant._id
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.status(200).json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─── @desc  Get unread notification count ────────────────────────────────────
// ─── @route GET /api/notifications/unread-count
// ─── @access Private
exports.getUnreadCount = async (req, res) => {
  if (!req.user || !req.tenant) {
    return res.status(200).json({ success: true, data: { count: 0 } });
  }

  try {
    const { Notification } = getModels(req);

    const count = await Notification.countDocuments({
      user:   req.user._id,
      tenant: req.tenant._id,
      isRead: false
    });

    res.status(200).json({ success: true, data: { count } });
  } catch (error) {
    console.error('getUnreadCount error:', error.message);
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─── @desc  SSE stream for real-time notifications ───────────────────────────
// ─── @route GET /api/notifications/stream
// ─── @access Private
exports.streamNotifications = async (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const userId = req.user.id || req.user._id.toString();

  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);

  const sendEvent = (data, event = 'message') => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: 'connected' });

  // Send current unread count immediately on connect
  try {
    const { Notification } = getModels(req);
    const count = await Notification.countDocuments({
      user:   req.user._id,
      tenant: req.tenant?._id,
      isRead: false
    });
    sendEvent({ type: 'unreadCount', count });
  } catch (err) {
    sendEvent({ type: 'error', message: 'Failed to fetch count' });
  }

  // Heartbeat every 30 s to keep connection alive
  const heartbeat = setInterval(() => {
    sendEvent({ type: 'heartbeat', time: new Date().toISOString() });
  }, 30_000);

  console.log(`SSE connection opened for user: ${userId}`);

  req.on('close', () => {
    clearInterval(heartbeat);
    const userClients = clients.get(userId);
    if (userClients) {
      userClients.delete(res);
      if (userClients.size === 0) clients.delete(userId);
    }
    res.end();
    console.log(`SSE connection closed for user: ${userId}`);
  });
};