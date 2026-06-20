const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    index: true,
    required: false
  },
  name: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
    maxlength: [100, 'Company name cannot exceed 100 characters']
  },
  logo: {
    type: String, // Store as base64 or URL
    default: null
  },
  address: {
    street: String,
    city: String,
    state: String,
    country: String,
    zipCode: String
  },
  contact: {
    email: String,
    phone: String,
    website: String
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
    }
  }
}, {
  timestamps: true
});

// Ensure only one company document exists
companySchema.statics.getCompany = async function() {
  let company = await this.findOne();
  if (!company) {
    company = await this.create({
      name: 'HRM Software',
      settings: {
        timezone: 'UTC',
        dateFormat: 'MM/DD/YYYY',
        currency: 'USD'
      }
    });
  }
  return company;
};

// Export the schema (the connection-specific model is registered by config/db)
module.exports = companySchema;