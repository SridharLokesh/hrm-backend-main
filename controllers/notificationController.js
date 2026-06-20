const mongoose = require('mongoose');
const DefaultNotification = require('../models/Notification');



const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

// Emit new notification to all connected clients for specific user
exports.emitToUserClients = (userId, notification) => {
  const userClients = clients.get(userId);
  if (userClients) {
    userClients.forEach((res) => {
      if (!res.writableEnded) {
        const payload = `event: newNotification\ndata: ${JSON.stringify(notification)}\n\n`;
        res.write(payload);
      }
    });
    console.log(`📢 Pushed new notification to ${userClients.size} clients for user ${userId}`);
  }
};


const getModels = (req) => ({
  Notification: resolveModel(req, 'Notification', DefaultNotification),
});

// @desc    Get user notifications
// @route   GET /api/notifications
// @access  Private
exports.getNotifications = async (req, res) => {
  console.log('🔍 getNotifications - user:', req.user?._id, 'tenant:', req.tenant?._id);
  // Dev fallback for no tenant
  if (!req.user || !req.tenant) {
    console.log('No user/tenant - return empty');
    return res.status(200).json({ success: true, data: [] });
  }
  try {
    const { Notification } = getModels(req);
    console.log('Notification model:', Notification.modelName);

    const notifications = await Notification.find({
      user: req.user._id,
      tenant: req.tenant._id
    })
      .populate('employee', 'name')
      .sort({ createdAt: -1 });
    console.log('Found notifications:', notifications.length);

    res.status(200).json({
      success: true,
      data: notifications
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
exports.markAsRead = async (req, res) => {
  try {
    const { Notification } = getModels(req);

    const notification = await Notification.findOneAndUpdate(
      {
        _id: req.params.id,
        user: req.user._id,
        tenant: req.tenant._id
      },
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.status(200).json({
      success: true,
      data: notification
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
// @access  Private
exports.markAllAsRead = async (req, res) => {
  try {
    const { Notification } = getModels(req);

    await Notification.updateMany(
      {
        user: req.user._id,
        tenant: req.tenant._id,
        isRead: false
      },
      { isRead: true }
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get unread notification count
// @route   GET /api/notifications/unread-count
// @access  Private
// @desc    SSE stream for real-time notifications
// @route   GET /api/notifications/stream
exports.streamNotifications = async (req, res) => {

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const userId = req.user.id; // or req.user._id

  // ✅ ADD CLIENT
  if (!clients.has(userId)) {
    clients.set(userId, new Set());
  }
  clients.get(userId).add(res);

  const sendEvent = (data, event = 'message') => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(payload);
  };

  // ✅ Send initial event immediately
  sendEvent({ type: 'connected' });

  // ✅ Safe DB call
  try {
    const { Notification } = getModels(req);

    const unreadCount = await Notification.countDocuments({
      user: req.user._id,
      tenant: req.tenant?._id,
      isRead: false
    });

    sendEvent({ type: 'unreadCount', count: unreadCount });
  } catch (err) {
    sendEvent({ type: 'error', message: 'Failed to fetch count' });
  }

  // ✅ Heartbeat
  const heartbeat = setInterval(() => {
    sendEvent({ type: 'heartbeat', time: new Date().toISOString() });
  }, 30000);

  console.log('SSE connection opened for user:', userId);

  // ✅ THIS IS WHERE YOUR CODE GOES
  req.on('close', () => {
    clearInterval(heartbeat);

    const userClients = clients.get(userId);
    if (userClients) {
      userClients.delete(res);

      if (userClients.size === 0) {
        clients.delete(userId);
      }
    }

    res.end();
    console.log('SSE connection closed for user:', userId);
  });
};

// Original
exports.getUnreadCount = async (req, res) => {
  console.log('🔍 getUnreadCount - user:', req.user?._id, 'role:', req.user?.role, 'tenant:', req.tenant?._id, 'user.tenant:', req.user?.tenant?.toString());
  // Dev fallback
  if (!req.user || !req.tenant) {
    console.log('Fallback: no user/tenant');
    console.log('🔄 Fallback unread count: 0 (missing user/tenant)');
    return res.status(200).json({ success: true, data: { count: 0 } });
  }
  try {
    const { Notification } = getModels(req);
    console.log('📊 Using Notification model:', Notification.modelName, 'collection:', Notification.collection?.name, 'db:', Notification.db.name);

    const query = {
      user: req.user._id,
      tenant: req.tenant._id,
      isRead: false
    };
    console.log('Query:', query);
    
    const count = await Notification.countDocuments(query);
    console.log('Unread count result:', count);

    res.status(200).json({
      success: true,
      data: { count }
    });
  } catch (error) {
    console.error('❌ getUnreadCount error:', error.message, error.stack);
    res.status(400).json({
      success: false,
      message: `Failed to load unread count: ${error.message}`
    });
  }
};
