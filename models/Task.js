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
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
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

module.exports = taskSchema;