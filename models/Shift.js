const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Shift name is required'],
   // enum: ['morning', 'evening', 'night', 'general', 'custom'],
    trim: true
  },
  displayName: {
    type: String,
    required: [true, 'Display name is required'],
    trim: true
  },
  startTime: {
    type: String,
    required: [true, 'Start time is required'],
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
  },
  endTime: {
    type: String,
    required: [true, 'End time is required'],
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
  },
  gracePeriod: {
    type: Number,
    default: 15,
    min: 0,
    max: 60,
    description: 'Minutes allowed after start time without being marked late'
  },
  lateMarkingAfter: {
    type: Number,
    default: 15,
    min: 0,
    max: 120,
    description: 'Minutes after start time to mark as late'
  },
  halfDayMarkingAfter: {
    type: Number,
    default: 120,
    min: 0,
    max: 240,
    description: 'Minutes after start time to mark as half day'
  },
  
  // ASSIGNMENT CONFIGURATIONS
  assignedDepartments: [{
    type: String,
    trim: true
  }],
  assignedRoles: [{
    type: String,
    trim: true
  }],
  assignedEmployees: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
  }],
  
  // Shift properties
  isNightShift: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Tenant & Audit
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Auto-detect night shift (end time < start time means crosses midnight)
shiftSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  
  // Auto-detect night shift
  const [startHour, startMinute] = this.startTime.split(':').map(Number);
  const [endHour, endMinute] = this.endTime.split(':').map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  this.isNightShift = endMinutes < startMinutes;
  
  next();
});

// Virtual: Get total shift duration in hours
shiftSchema.virtual('durationHours').get(function() {
  const [startHour, startMinute] = this.startTime.split(':').map(Number);
  const [endHour, endMinute] = this.endTime.split(':').map(Number);
  
  let startMinutes = startHour * 60 + startMinute;
  let endMinutes = endHour * 60 + endMinute;
  
  if (this.isNightShift) {
    endMinutes += 24 * 60;
  }
  
  return (endMinutes - startMinutes) / 60;
});

// Method: Check if department is assigned to this shift
shiftSchema.methods.hasDepartment = function(department) {
  return this.assignedDepartments.includes(department);
};

// Method: Check if role is assigned to this shift
shiftSchema.methods.hasRole = function(role) {
  return this.assignedRoles.includes(role);
};

// Method: Check if employee is directly assigned
shiftSchema.methods.hasEmployee = function(employeeId) {
  return this.assignedEmployees.some(id => id.toString() === employeeId.toString());
};

// Method: Get shift status based on current time
// Method: Get shift status based on current time
shiftSchema.methods.getShiftStatus = function(currentTime, type = 'checkin') {
  const [startHour, startMinute] = this.startTime.split(':').map(Number);
  const [endHour, endMinute] = this.endTime.split(':').map(Number);
  
  let currentHour = currentTime.getHours();
  let currentMinute = currentTime.getMinutes();
  let currentMinutes = currentHour * 60 + currentMinute;
  
  let startMinutes = startHour * 60 + startMinute;
  let endMinutes = endHour * 60 + endMinute;
  
  // Calculate shift end time (handle overnight)
  let endMinutesAdjusted = endMinutes;
  let startMinutesAdjusted = startMinutes;
  let currentMinutesAdjusted = currentMinutes;
  
  // Handle overnight shifts (end time < start time means crosses midnight)
  const isOvernight = endMinutes < startMinutes;
  
  if (isOvernight) {
    endMinutesAdjusted = endMinutes + (24 * 60);
    // For overnight shifts, adjust current time if it's after midnight but before shift end
    if (currentMinutes < startMinutes && currentMinutes < endMinutes) {
      currentMinutesAdjusted = currentMinutes + (24 * 60);
    }
  }
  
  if (type === 'checkin') {
    // ✅ CRITICAL FIX: Check if shift has already ended (for regular shifts)
    if (!isOvernight && currentMinutes > endMinutes) {
      return { 
        canCheckIn: false, 
        status: 'shift-ended', 
        message: `Shift ended at ${this.endTime}. Cannot check in after shift ends.`,
        isLate: false,
        isHalfDay: false
      };
    }
    
    // For overnight shifts, check if current time is after shift end (next day)
    if (isOvernight && currentMinutesAdjusted > endMinutesAdjusted) {
      return { 
        canCheckIn: false, 
        status: 'shift-ended', 
        message: `Shift ended at ${this.endTime} (next day). Cannot check in after shift ends.`,
        isLate: false,
        isHalfDay: false
      };
    }
    
    // Handle night shift check-in window
    if (this.isNightShift || isOvernight) {
      // Night shift check-in window: 
      // - Evening: From 6 PM (18:00) to midnight (24:00)
      // - Early morning: From midnight (00:00) to shift start + late marking
      const isEvening = currentHour >= 18; // After 6 PM
      const isEarlyMorning = currentHour < startHour; // Before shift start hour (morning)
      
      if (!(isEvening || isEarlyMorning)) {
        // Not in night shift window - too early/late
        return { 
          canCheckIn: false, 
          status: 'out-of-window', 
          message: `Night shift check-in available from 6:00 PM to ${startHour}:${startMinute.toString().padStart(2, '0')} AM`,
          isLate: false,
          isHalfDay: false
        };
      }
    }
    
    const lateAfter = startMinutesAdjusted + this.lateMarkingAfter;
    const halfDayAfter = startMinutesAdjusted + this.halfDayMarkingAfter;
    
    // For night shift, if checking in during early morning hours (after midnight),
    // we need to add 24 hours to startMinutes for proper comparison
    let adjustedCurrentMinutes = currentMinutesAdjusted;
    if (isOvernight && currentHour < startHour && currentHour < 12) {
      adjustedCurrentMinutes = currentMinutesAdjusted;
    }
    
    // ✅ Check if too early (before grace period starts)
    const graceStartMinutes = startMinutesAdjusted - this.gracePeriod;
    if (adjustedCurrentMinutes < graceStartMinutes) {
      const graceStartHour = Math.floor(graceStartMinutes / 60) % 24;
      const graceStartMinute = graceStartMinutes % 60;
      return { 
        canCheckIn: false, 
        status: 'too-early', 
        message: `Too early! Check-in window opens at ${graceStartHour.toString().padStart(2, '0')}:${graceStartMinute.toString().padStart(2, '0')}`,
        isLate: false,
        isHalfDay: false
      };
    }
    
    if (adjustedCurrentMinutes > halfDayAfter) {
      return { 
        canCheckIn: true,        
        status: 'late',      
        message: 'Late check-in - will be marked as half day',
        isLate: true,
        isHalfDay: true
      };
    }
    if (adjustedCurrentMinutes > lateAfter) {
      return { 
        canCheckIn: true, 
        status: 'late', 
        message: 'Late check-in',
        isLate: true,
        isHalfDay: false
      };
    }
    if (adjustedCurrentMinutes >= startMinutesAdjusted) {
      return { 
        canCheckIn: true, 
        status: 'on-time', 
        message: 'On-time check-in',
        isLate: false,
        isHalfDay: false
      };
    }
    if (adjustedCurrentMinutes >= startMinutesAdjusted - this.gracePeriod) {
      return { 
        canCheckIn: true, 
        status: 'early', 
        message: 'Early check-in allowed',
        isLate: false,
        isHalfDay: false
      };
    }
    return { 
      canCheckIn: false, 
      status: 'too-early', 
      message: `Too early! Shift starts at ${this.startTime}`,
      isLate: false,
      isHalfDay: false
    };
    
  } else {
    // Checkout logic
    let adjustedEndMinutes = endMinutesAdjusted;
    let adjustedCurrentMinutes = currentMinutesAdjusted;
    
    // For overnight shift checkout
    if (isOvernight) {
      if (currentHour < endHour && currentHour < startHour) {
        adjustedCurrentMinutes = currentMinutes + (24 * 60);
      }
    }
    
    // ✅ Check if shift hasn't started yet
    if (adjustedCurrentMinutes < startMinutesAdjusted) {
      return { 
        canCheckOut: false, 
        status: 'not-started', 
        message: 'Shift has not started yet. Cannot check out.',
        isEarly: false 
      };
    }
    
    // ✅ Check if already checked out (should be handled by caller)
    
    const earlyCheckoutThreshold = adjustedEndMinutes - 60;
    
    if (adjustedCurrentMinutes < earlyCheckoutThreshold) {
      return { 
        canCheckOut: true, 
        status: 'early', 
        message: 'Early checkout detected',
        isEarly: true 
      };
    }
    if (adjustedCurrentMinutes < adjustedEndMinutes) {
      return { 
        canCheckOut: true, 
        status: 'on-time', 
        message: 'On-time checkout',
        isEarly: false 
      };
    }
    return { 
      canCheckOut: true, 
      status: 'late', 
      message: 'Late checkout',
      isEarly: false 
    };
  }
};

// Helper method to get check-in window start time
shiftSchema.methods.getCheckInWindowStart = function() {
  const [startHour, startMinute] = this.startTime.split(':').map(Number);
  const graceStartMinutes = (startHour * 60 + startMinute) - this.gracePeriod;
  const graceStartHour = Math.floor(graceStartMinutes / 60) % 24;
  const graceStartMinute = graceStartMinutes % 60;
  return `${graceStartHour.toString().padStart(2, '0')}:${graceStartMinute.toString().padStart(2, '0')}`;
};

// Method: Calculate working hours for this shift
shiftSchema.methods.calculateWorkingHours = function(checkInTime, checkOutTime) {
  let start = new Date(checkInTime);
  let end = new Date(checkOutTime);
  
  const [startHour, startMinute] = this.startTime.split(':').map(Number);
  const [endHour, endMinute] = this.endTime.split(':').map(Number);
  
  let startMinutes = startHour * 60 + startMinute;
  let endMinutes = endHour * 60 + endMinute;
  
  // Adjust for night shift
  if (this.isNightShift && end.getHours() < startHour) {
    end.setDate(end.getDate() + 1);
  }
  
  const diffMs = end - start;
  const diffHours = diffMs / (1000 * 60 * 60);
  
  return Math.round(diffHours * 100) / 100;
};

// Static: Find shift for employee (priority: user > role > department)
shiftSchema.statics.findShiftForEmployee = async function(employee, models) {
  const { Employee, Shift } = models;
  
  // Priority 1: Direct user assignment
  if (employee.assignedShift) {
    const shift = await Shift.findOne({ 
      _id: employee.assignedShift, 
      tenant: employee.tenant,
      isActive: true 
    });
    if (shift) {
      return { shift, source: 'user', priority: 3 };
    }
  }
  
  // Priority 2: Role-based assignment
  if (employee.position) {
    const roleShift = await Shift.findOne({
      tenant: employee.tenant,
      isActive: true,
      assignedRoles: employee.position
    });
    if (roleShift) {
      return { shift: roleShift, source: 'role', priority: 2 };
    }
  }
  
  // Priority 3: Department-based assignment
  if (employee.department) {
    const deptShift = await Shift.findOne({
      tenant: employee.tenant,
      isActive: true,
      assignedDepartments: employee.department
    });
    if (deptShift) {
      return { shift: deptShift, source: 'department', priority: 1 };
    }
  }
  
  return { shift: null, source: null, priority: 0 };
};

module.exports = shiftSchema;