const mongoose = require('mongoose');

// Manual project-progress entries — mirrors taskUpdateSchema's shape
// (date/progress/note/userId) so a team lead/manager can log a
// project-level update with a short trail of who changed it and why,
// separate from any individual task.
const projectProgressUpdateSchema = new mongoose.Schema({
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
  // NEW: which department this project belongs to. Used for the admin
  // "All Projects" department filter. Value should match one of the
  // department-settings entries (same source Employee.department uses).
  department: {
    type: String,
    required: [true, 'Please add a department'],
    trim: true
  },
  startDate: {
    type: Date
  },
  endDate: {
    type: Date
  },
  // NEW: the single team lead (or manager) responsible for creating/editing
  // tasks under this project. Required — every project must have exactly
  // one owner who can manage its tasks. Must reference an Employee whose
  // linked User has role 'team-lead' or 'manager' (enforced in controller,
  // not schema, since role lives on User not Employee).
  teamLead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: [true, 'Please assign a team lead to this project']
  },
  // Kept for backward compatibility with existing frontend (ProjectDetails.jsx
  // renders Manager and Team Lead as separate cards). Optional — admin may
  // leave this blank if the team lead is the sole owner.
  manager: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    default: null
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
  // Single source of truth for the progress bar shown on project cards /
  // details pages. Written from TWO places, either of which can win at
  // any given moment (last write wins, by design):
  //   1. Automatically — taskController.js's updateProjectProgress()
  //      recalculates this from completed/total tasks every time any
  //      task on the project is created, updated, or its status changes.
  //   2. Manually — projectController.js's setProjectProgress() lets the
  //      owning team lead/manager (or admin) directly set this value via
  //      the "Add Project Progress" quick action, logging an entry to
  //      progressUpdates below.
  progress: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  // History of manual progress entries (see setProjectProgress in
  // projectController.js). Does NOT include the automatic task-based
  // recalculations — only explicit manual updates are logged here.
  progressUpdates: {
    type: [projectProgressUpdateSchema],
    default: []
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

projectSchema.index({ teamLead: 1 });
projectSchema.index({ department: 1 });
projectSchema.index({ tenant: 1, isActive: 1 });

module.exports = projectSchema;