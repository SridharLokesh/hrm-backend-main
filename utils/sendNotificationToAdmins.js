const mongoose = require('mongoose');
const DefaultNotification = require('../models/Notification');
const DefaultUser = require('../models/User');

// Resolve model tenant-aware (matching pattern in controllers)
const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

const sendNotificationToApprovers = async (req, entity, type, title, message) => {
  try {
    if (!entity || !entity.employee || !entity.employee._id) {
      console.error('❌ sendNotificationToApprovers: invalid entity/employee', { entityId: entity?._id });
      return;
    }
    const NotificationModel = resolveModel(req, 'Notification', DefaultNotification);
    const UserModel = resolveModel(req, 'User', DefaultUser);

    // Find ALL active approvers: admins, HR, ALL team-leads in tenant
    const approvers = await UserModel.find({
      role: { $in: ['admin', 'hr', 'team-lead'] },
      tenant: req.tenant._id,
      isActive: true
    }).populate('employee', 'name');

    console.log(`👥 Found ${approvers.length} approvers (admin/hr/lead) for notifications`);
    
    if (admins.length === 0) {
      console.log('No admins found for notifications');
      return;
    }

    // Create notification for each admin
    const notifications = await Promise.all(
      admins.map(async (admin) => {
        const notificationData = {
          user: admin._id,
          employee: entity.employee._id, // Requester's employee
          title,
          message,
          type,
          tenant: req.tenant._id,
          relatedEntity: type === 'leave_request' ? 'leave' : 'permission',
          entityId: entity._id
        };

        const notification = await NotificationModel.create(notificationData);
        console.log(`📨 Created notification ${notification._id} for admin ${admin._id}, type: ${type}`);
        await notification.populate('employee', 'name');
        
        const { emitToUser } = require('../controllers/notificationController');
        emitToUser(admin._id, notification);
        return notification;
      })
    );

    console.log(`📢 Successfully sent ${notifications.length} approver notifications for ${type}: ${title}`);
  } catch (error) {
    console.error('❌ sendNotificationToApprovers failed:', error.message, { tenant: req.tenant?._id, entityId: entity?._id, type });
    // Don't throw - don't fail main request
  }
};

module.exports = { sendNotificationToApprovers };
