// models/DailyUpdate.js
const mongoose = require('mongoose');

const dailyUpdateRowSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    default: 'Task'
  },
  content: {
    type: String,
    trim: true,
    default: ''
  }
}, { _id: true });

const dailyUpdateSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  attendance: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Attendance',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  rows: {
    type: [dailyUpdateRowSchema],
    default: () => [
      { title: 'Task', content: '' },
      { title: 'Status', content: '' },
      { title: 'Remarks', content: '' }
    ]
  },
  isSubmitted: {
    type: Boolean,
    default: false
  },
  submittedAt: {
    type: Date,
    default: null
  },
  // After 24 hrs from submittedAt, the record becomes read-only for the user
  editDeadline: {
    type: Date,
    default: null
  },
  // Admin audit trail for edits / deletes
  adminEdits: [{
    editedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    editedByName: String,
    action: {
      type: String,
      enum: ['edit', 'delete']
    },
    editedAt: {
      type: Date,
      default: Date.now
    },
    previousRows: [dailyUpdateRowSchema]
  }]
}, {
  timestamps: true
});

// One update record per employee per date per attendance session
dailyUpdateSchema.index({ employee: 1, date: 1, attendance: 1 }, { unique: true });
dailyUpdateSchema.index({ employee: 1, date: -1 });

// Virtual: is user still allowed to edit?
dailyUpdateSchema.virtual('isUserEditable').get(function () {
  if (!this.isSubmitted) return true; // draft, always editable
  if (!this.editDeadline) return false;
  return new Date() < this.editDeadline;
});

dailyUpdateSchema.set('toObject', { virtuals: true });
dailyUpdateSchema.set('toJSON', { virtuals: true });

module.exports = dailyUpdateSchema;