const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: [true, 'Tenant is required']
    },
    name: {
      type: String,
      required: [true, 'Location name is required'],
      trim: true
    },
    address: {
      type: String,
      trim: true
    },
    latitude: {
      type: Number
    },
    longitude: {
      type: Number
    },
    radius: {
      type: Number,
      default: 100,
      description: 'Geofence radius in meters for location validation'
    },
    description: {
      type: String,
      trim: true
    },
    isActive: {
      type: Boolean,
      default: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  {
    timestamps: true
  }
);

// Compound index for tenant and location name uniqueness
locationSchema.index({ tenant: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Location', locationSchema);
