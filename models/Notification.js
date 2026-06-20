const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
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
    enum: ['task-assigned', 'task-updated', 'project-assigned', 'deadline-reminder', 'leave_request', 'permission_request', 'permission_status', 'permission_approved', 'general'],
    default: 'general'
  },
  relatedEntity: {
    type: String,
    enum: ['project', 'task', 'permission', 'leave']
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

module.exports = notificationSchema;