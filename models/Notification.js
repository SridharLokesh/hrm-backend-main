const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
    // Not required — some notifications (e.g. admin-level) may not link an employee
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: [
      // Leave
      'leave_approved',       // Leave approved by admin/lead
      'leave_rejected',       // Leave rejected by admin/lead

      // Permission
      'permission_approved',  // Permission approved by admin/lead
      'permission_rejected',  // Permission rejected by admin/lead

      // Absent — 3 distinct subtypes
      'absent_no_checkin',    // Auto-marked absent: never checked in (cron at 23:59)
      'absent_no_checkout',   // Auto-marked absent: checked in but no checkout in 24h
      'absent_admin',         // Admin manually set attendance status to absent

      // Legacy / general (kept for backwards compat)
      'task-assigned',
      'task-updated',
      'project-assigned',
      'deadline-reminder',
      'leave_request',
      'permission_request',
      'permission_status',
      'general'
    ],
    default: 'general'
  },
  // Extra metadata stored as a flat object so controllers can pass
  // leave type, date range, approver name, etc. without schema changes.
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  relatedEntity: {
    type: String,
    enum: ['project', 'task', 'permission', 'leave', 'attendance']
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId
  },
  isRead: {
    type: Boolean,
    default: false
  },
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  }
}, {
  timestamps: true
});

// Index for fast unread-count queries per user+tenant
notificationSchema.index({ user: 1, tenant: 1, isRead: 1 });
notificationSchema.index({ user: 1, tenant: 1, createdAt: -1 });

module.exports = notificationSchema;