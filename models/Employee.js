const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    index: true,
    required: false
  },
  employeeId: {
    type: String,
    unique: true,
    sparse: true
  },
  name: {
    type: String,
    required: [true, 'Please add a name'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Please add an email'],
    unique: true,
    lowercase: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please add a valid email'
    ]
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  phone: {
    type: String,
    trim: true
  },
  dateOfBirth: {
    type: Date
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other']
  },
  address: {
    street: String,
    city: String,
    state: String,
    country: String,
    zipCode: String
  },
  department: {
    type: String,
    required: [true, 'Please add a department'],
    trim: true
  },
  position: {
    type: String,
    required: [true, 'Please add a position'],
    trim: true
  },
  salary: {
    type: Number,
    required: [true, 'Please add a salary']
  },
  employmentType: {
    type: String,
    enum: ['full-time', 'part-time', 'contract', 'intern'],
    default: 'full-time'
  },
  workMode: {
    type: String,
    enum: ['wfo', 'wfh', 'hybrid'],
    default: 'wfo'
  },
  joiningDate: {
    type: Date,
    default: Date.now
  },
  terminationDate: {
    type: Date
  },
  emergencyContact: {
    name: String,
    relationship: String,
    phone: String
  },
  bankDetails: {
    accountNumber: String,
    bankName: String,
    branch: String,
    ifscCode: String
  },
  documents: [{
    name: String,
    documentType: String,
    url: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  assignedShift: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shift',
    default: null
  },
  shiftSource: {
    type: String,
    enum: ['admin', 'role', 'department', 'default', 'requested', null],
    default: null
  },
  shiftAssignedAt: {
    type: Date,
    default: null
  },
  shiftAssignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
isActive: {
    type: Boolean,
    default: true
  },
  teamLead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
  },
  teamMembers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
  }],
  departmentShiftRequired: {
    type: Boolean,
    default: false
  },
}, {
  timestamps: true
});

// Generate employee ID before saving
employeeSchema.pre('save', async function(next) {
  if (!this.isNew || this.employeeId) return next();

  try {
    const year = new Date().getFullYear();
    const counterId = `employeeId_${year}`;

    // ✅ Atomic: findOneAndUpdate with $inc guarantees no two docs get same seq
    const Counter = this.db.model('Counter');
    const counter = await Counter.findOneAndUpdate(
      { _id: counterId },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    this.employeeId = `EMP${year}${counter.seq.toString().padStart(4, '0')}`;
    next();
  } catch (err) {
    next(err);
  }
});

// Virtual for full address
employeeSchema.virtual('fullAddress').get(function() {
  return `${this.address.street}, ${this.address.city}, ${this.address.state} ${this.address.zipCode}, ${this.address.country}`;
});


employeeSchema.methods.getEffectiveShift = async function(models) {
  const { Shift } = models;
  const result = await Shift.findShiftForEmployee(this, models);
  return result;
};

employeeSchema.methods.canCheckIn = async function(models, currentTime = new Date()) {
  const { Shift } = models;
  const result = await this.getEffectiveShift(models);
  
  if (!result.shift) {
    // No shift assigned - allow check-in with default rules
    return { canCheckIn: true, shift: null, shiftSource: null, message: 'No shift assigned' };
  }
  
  const status = result.shift.getShiftStatus(currentTime, 'checkin');
  return {
    canCheckIn: status.canCheckIn,
    shift: result.shift,
    shiftSource: result.source,
    status: status.status,
    message: status.message,
    isLate: status.isLate || false
  };
};

employeeSchema.methods.canCheckOut = async function(models, currentTime = new Date()) {
  const { Shift } = models;
  const result = await this.getEffectiveShift(models);
  
  if (!result.shift) {
    return { canCheckOut: true, shift: null, shiftSource: null, message: 'No shift assigned' };
  }
  
  const status = result.shift.getShiftStatus(currentTime, 'checkout');
  return {
    canCheckOut: status.canCheckOut,
    shift: result.shift,
    shiftSource: result.source,
    status: status.status,
    message: status.message,
    isEarly: status.isEarly || false
  };
};

// Ensure virtual fields are serialized
employeeSchema.index({ teamLead: 1 });
employeeSchema.index({ 'teamMembers': 1 });

employeeSchema.set('toJSON', { virtuals: true });

module.exports = employeeSchema;
