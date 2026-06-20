const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Tenant name is required'],
    trim: true,
    unique: true
  },
  subdomain: {
    type: String,
    required: [true, 'Subdomain is required'],
    unique: true,
    lowercase: true,
    match: [/^[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?$/, 'Invalid subdomain format']
  },
  companyName: {
    type: String,
    required: [true, 'Company name is required']
  },
  description: {
    type: String,
    maxlength: 500
  },
  contactEmail: {
    type: String,
    required: [true, 'Contact email is required'],
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please add a valid email'
    ]
  },
  phone: String,
  address: {
    street: String,
    city: String,
    state: String,
    country: String,
    zipCode: String
  },
  industry: String,
  size: {
    type: String,
    enum: ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'],
    default: '1-10'
  },
  // Public portal URL for the tenant (optional). Example: https://hrm.focusengineeringapp.com/company-subdomain
  portalUrl: {
    type: String,
    trim: true,
    default: null
  },
  settings: {
    timezone: {
      type: String,
      default: 'UTC'
    },
    dateFormat: {
      type: String,
      default: 'MM/DD/YYYY'
    },
    currency: {
      type: String,
      default: 'USD'
    },
    language: {
      type: String,
      default: 'en'
    }
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'basic', 'premium', 'enterprise'],
      default: 'free'
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'suspended', 'trial'],
      default: 'trial'
    },
    startDate: {
      type: Date,
      default: Date.now
    },
    endDate: Date,
    maxEmployees: {
      type: Number,
      default: 10
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SuperAdmin',
    required: true
  }
}, {
  timestamps: true
});

// Remove the duplicate index definition - keep only schema-level unique
// The unique: true in the field definition already creates the index

module.exports = mongoose.model('Tenant', tenantSchema);