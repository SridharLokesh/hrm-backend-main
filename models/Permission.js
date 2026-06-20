const mongoose = require('mongoose');
const moment = require('moment');

const approvalSchema = new mongoose.Schema({
  approver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  status: {
    type: String,
    enum: ['approved', 'rejected'],
    required: true
  },
  approverType: {
    type: String,
    enum: ['lead', 'admin'],
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const permissionSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  permissionType: {
    type: String,
    enum: ['half-day', 'short-leave', 'late-arrival', 'early-departure', 'break-extension'],
    required: true
  },
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    required: true
  },
  duration: {
    type: Number,
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  approvals: [approvalSchema],
  affectsAttendance: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Calculate duration before saving
permissionSchema.pre('save', function(next) {
  try {
    if (this.startTime && this.endTime) {
      const start = moment(this.startTime);
      const end = moment(this.endTime);
      if (start.isValid() && end.isValid()) {
        const diff = end.diff(start, 'hours', true);
        this.duration = parseFloat(diff.toFixed(2));
      }
    }
  } catch (error) {
    console.error('Error calculating permission duration:', error);
  }
  next();
});

// Update status based on approvals
// Single approval is enough — if anyone (lead or admin) approves, permission is approved.
// Rejection by anyone immediately rejects the permission.
permissionSchema.methods.updateStatusFromApprovals = function() {
  const hasRejection = this.approvals.some(a => a.status === 'rejected');
  const anyApproval = this.approvals.some(a => a.status === 'approved');

  if (hasRejection) {
    this.status = 'rejected';
  } else if (anyApproval) {
    this.status = 'approved';
  } else {
    this.status = 'pending';
  }
};

// Indexes
permissionSchema.index({ employee: 1, date: 1 });
permissionSchema.index({ status: 1 });
permissionSchema.index({ createdAt: -1 });

module.exports = permissionSchema;
