/**
 * sendEmployeeNotification.js
 *
 * Central helper that:
 *  1. Looks up the User record for a given employee
 *  2. Creates a Notification document
 *  3. Pushes it via SSE to any open browser tabs (emitToUserClients)
 *
 * Only call this for EMPLOYEE-facing notifications.
 * Admin / lead notifications are handled separately via sendNotificationToApprovers.
 */

const mongoose = require('mongoose');

/**
 * @param {object}  req            Express request (carries req.models, req.tenant)
 * @param {object}  options
 * @param {string}  options.employeeId   Mongoose ObjectId (string or object)
 * @param {string}  options.type         Notification type enum value
 * @param {string}  options.title        Short heading shown in the bell
 * @param {string}  options.message      Full sentence describing what happened
 * @param {string}  [options.relatedEntity]  'leave' | 'permission' | 'attendance'
 * @param {*}       [options.entityId]   ObjectId of the related document
 * @param {object}  [options.meta={}]    Extra key/value pairs (leaveType, dates, approverName…)
 */
async function sendEmployeeNotification(req, {
  employeeId,
  type,
  title,
  message,
  relatedEntity,
  entityId,
  meta = {}
}) {
  try {
    // Resolve models — works for both multi-tenant (req.models) and default schemas
    const resolveModel = (name, DefaultModel) => {
      if (req.models && req.models[name]) return req.models[name];
      const schema = DefaultModel?.schema ?? DefaultModel;
      if (mongoose.models[name]) return mongoose.models[name];
      return mongoose.model(name, schema);
    };

    const DefaultNotification = require('../models/Notification');
    const DefaultUser         = require('../models/User');

    const Notification = resolveModel('Notification', DefaultNotification);
    const User         = resolveModel('User',         DefaultUser);

    // Find the User who owns this employee record
    const user = await User.findOne({
      employee: employeeId,
      tenant:   req.tenant._id,
      isActive: true
    }).lean();

    if (!user) {
      console.warn(`[sendEmployeeNotification] No active user found for employee ${employeeId}`);
      return null;
    }

    // Create the notification
    const notification = await Notification.create({
      user:          user._id,
      employee:      employeeId,
      tenant:        req.tenant._id,
      type,
      title,
      message,
      relatedEntity: relatedEntity || undefined,
      entityId:      entityId      || undefined,
      meta,
      isRead:        false
    });

    // Push real-time via SSE (if stream is open)
    try {
      const { emitToUserClients } = require('../controllers/notificationController');
      emitToUserClients(user._id.toString(), notification);
    } catch (_) {
      // SSE emit is best-effort — don't fail the request
    }

    return notification;
  } catch (err) {
    console.error('[sendEmployeeNotification] Error:', err.message);
    return null;
  }
}

module.exports = sendEmployeeNotification;