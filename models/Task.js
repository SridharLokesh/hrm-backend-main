const mongoose = require('mongoose');

const taskUpdateSchema = new mongoose.Schema({
  date: {
    type: Date,
    default: Date.now
  },
  progress: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  note: {
    type: String,
    required: true,
    trim: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // NEW: matches TaskProgress.jsx's ProgressTimeline rendering of
  // update.reportedLocation.city / .pincode and update.partsCount — these
  // were already being read on the frontend but never existed on the schema.
  reportedLocation: {
    city: { type: String, trim: true },
    pincode: { type: String, trim: true }
  },
  partsCount: {
    type: Number,
    min: 0
  }
}, {
  timestamps: true
});

const taskSchema = new mongoose.Schema({
  taskId: {
    type: String,
    unique: true,
    sparse: true
  },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  title: {
    type: String,
    required: [true, 'Please add a task title'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  // CHANGED: was a single ObjectId — now an array so a task can be
  // assigned to more than one person at once (TaskForm.jsx's checkbox
  // picker sends assignedTo as an array). The `validate` below keeps the
  // "must pick someone" requirement that `required: true` used to give
  // on the old single-value field (required:true on an array only checks
  // that the array itself exists, not that it's non-empty).
  assignedTo: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
    required: [true, 'Please assign this task to at least one person'],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length > 0,
      message: 'Please assign this task to at least one person'
    }
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['todo', 'in-progress', 'review', 'done'],
    default: 'todo'
  },
  deadline: {
    type: Date,
    required: [true, 'Please add a deadline']
  },
  estimatedHours: {
    type: Number,
    min: 0
  },
  actualHours: {
    type: Number,
    min: 0,
    default: 0
  },
  // NEW: matches WORK_TYPES in TaskForm.jsx / WORK_TYPE_LABELS in
  // ProjectDetails.jsx. Previously sent by the frontend but silently
  // stripped since it wasn't declared here.
  workType: {
    type: String,
    enum: ['auditing-parts', 'counting-parts', 'inspection', 'delivery', 'other'],
    default: 'other'
  },
  targetPartsCount: {
    type: Number,
    min: 0
  },
  // NEW: where the employee is expected to go work from — rendered in
  // ProjectDetails.jsx TaskItem and TaskProgress.jsx task header.
  workLocation: {
    city: { type: String, trim: true },
    pincode: { type: String, trim: true }
  },
  // Overall progress percentage (0-100)
  progress: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  // Progress updates history
  updates: {
    type: [taskUpdateSchema],
    default: []
  },
  // Last progress update timestamp
  lastUpdated: {
    type: Date
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
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Generate task ID before saving
taskSchema.pre('save', async function(next) {
  if (this.isNew && !this.taskId) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments();
    this.taskId = `TASK${year}${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

taskSchema.index({ project: 1, status: 1 });
// Still valid on an array field — Mongo automatically builds this as a
// multikey index, so lookups like `Task.find({ assignedTo: employeeId })`
// keep working exactly as before (they match if employeeId is anywhere
// in the array).
taskSchema.index({ assignedTo: 1 });
taskSchema.index({ tenant: 1, isActive: 1 });

module.exports = taskSchema;