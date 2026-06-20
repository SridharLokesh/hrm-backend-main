const mongoose = require('mongoose');

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

const leaveSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  leaveType: {
    type: String,
    enum: ['sick', 'casual', 'annual', 'maternity', 'paternity', 'comp-off', 'other'],
    required: true
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
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
  totalDays: {
    type: Number
  }
}, {
  timestamps: true
});

// Calculate total days before saving
leaveSchema.pre('save', function(next) {
  const diffTime = Math.abs(this.endDate - this.startDate);
  this.totalDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
  next();
});

// Update status based on approvals (called after save)
leaveSchema.methods.updateStatusFromApprovals = function() {
  const leadApproval = this.approvals.find(a => a.approverType === 'lead' && a.status === 'approved');
  const adminApproval = this.approvals.find(a => a.approverType === 'admin' && a.status === 'approved');
  
  if (leadApproval && adminApproval) {
    this.status = 'approved';
  } else if (this.approvals.some(a => a.status === 'rejected')) {
    this.status = 'rejected';
  } else {
    this.status = 'pending';
  }
};

module.exports = leaveSchema;
