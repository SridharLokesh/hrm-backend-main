const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  projectId: {
    type: String,
    unique: true,
    sparse: true
  },
  name: {
    type: String,
    required: [true, 'Please add a project name'],
    trim: true
  },
  description: {
    type: String,
    required: [true, 'Please add a project description'],
    trim: true
  },
  startDate: {
    type: Date
  },
  endDate: {
    type: Date
  },
  assignedEmployees: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
  }],
  status: {
    type: String,
    enum: ['active', 'completed', 'on-hold'],
    default: 'active'
  },
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  progress: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Generate project ID before saving
projectSchema.pre('save', async function(next) {
  if (this.isNew && !this.projectId) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments();
    this.projectId = `PROJ${year}${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

module.exports = projectSchema;
// Export schema for tenant-aware registration
// (other modules will register this schema on the appropriate connection)
// Keep backward compatible access via mongoose.model when needed by server startup code
// but prefer requiring the schema and letting config/db register it per-connection.
// Note: Some files expect a schema export; returning schema ensures consistent behavior.

// Backwards-compatible export: also attach `.schema` to the exported object when run in
// environments that `require` this file and expect a model. However to avoid double-model
// registration we export the schema itself.