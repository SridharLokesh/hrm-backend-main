const mongoose = require('mongoose');

const departmentSettingSchema = new mongoose.Schema({
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  departmentName: {
    type: String,
    required: true,
    trim: true
  },
  shiftRequired: {
    type: Boolean,
    default: false  // false = can checkin anytime, true = must have shift
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

departmentSettingSchema.index({ tenant: 1, departmentName: 1 }, { unique: true });

module.exports = departmentSettingSchema;