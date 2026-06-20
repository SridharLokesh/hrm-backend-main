const mongoose = require('mongoose');
const { getSuperAdminModels } = require('../config/db');

// Helper to read tenantId from query/body.
const resolveTenantId = (req) => {
  return req.query.tenantId || req.body.tenantId;
};

const isValidObjectId = (id) => {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
};


const escapeRegex = (value) => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const handleLocationError = (res, error, fallbackMessage) => {
  if (error?.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: 'Invalid location or tenant id'
    });
  }

  if (error?.code === 11000) {
    return res.status(400).json({
      success: false,
      message: 'Location with this name already exists'
    });
  }

  console.error(`[superAdminLocationController] ${fallbackMessage}:`, error);
  return res.status(500).json({
    success: false,
    message: error.message || fallbackMessage,
  });
};

// Super-admin locations are tenant-scoped (expected behavior: super-admin selects tenant)
exports.getAllLocationsForTenant = async (req, res) => {
  try {
    // Resolve models from mainDBConnection (hrm_superadmin) — NOT the default mongoose connection
    const { Tenant, Location } = getSuperAdminModels();

    const tenantId = resolveTenantId(req);

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId query parameter is required'
      });
    }

    if (!isValidObjectId(tenantId)) {
      return res.status(400).json({ success: false, message: 'Invalid tenantId' });
    }

    // Validate tenant exists
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || !tenant.isActive) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    const locations = await Location.find({
      tenant: tenantId,
      isActive: true
    })
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: locations.length,
      data: locations
    });
  } catch (error) {
    handleLocationError(res, error, 'Error fetching locations');
  }
};

exports.getLocationForTenant = async (req, res) => {
  try {
    const { Tenant, Location } = getSuperAdminModels();
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId query parameter is required'
      });
    }

    if (!isValidObjectId(tenantId)) {
      return res.status(400).json({ success: false, message: 'Invalid tenantId' });
    }

    const location = await Location.findOne({
      _id: req.params.id,
      tenant: tenantId,
      isActive: true
    });

    if (!location) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }

    res.status(200).json({ success: true, data: location });
  } catch (error) {
    handleLocationError(res, error, 'Error fetching location');
  }
};

exports.createLocationForTenant = async (req, res) => {
  try {
    const { Tenant, Location } = getSuperAdminModels();
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId query/body parameter is required'
      });
    }

    if (!isValidObjectId(tenantId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenantId'
      });
    }

    if (process.env.NODE_ENV === 'development') {

      console.log('[superAdminLocationController:createLocationForTenant]', {
        tenantId,
        bodyKeys: req.body ? Object.keys(req.body) : [],
        body: req.body,
      });
    }

    const { name, address, latitude, longitude, radius, description } = req.body;


    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Location name is required'
      });
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant || !tenant.isActive) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    const trimmedName = name.trim();
    const existingLocation = await Location.findOne({
      tenant: tenantId,
      name: { $regex: `^${escapeRegex(trimmedName)}$`, $options: 'i' }
    });

    if (existingLocation) {
      return res.status(400).json({
        success: false,
        message: 'Location with this name already exists'
      });
    }

    const location = await Location.create({
      tenant: tenantId,
      name: trimmedName,
      address: address?.trim() || '',
      latitude: latitude || null,
      longitude: longitude || null,
      radius: radius || 100,
      description: description?.trim() || '',
      isActive: true
    });

    res.status(201).json({
      success: true,
      message: 'Location created successfully',
      data: location
    });
  } catch (error) {
    handleLocationError(res, error, 'Error creating location');
  }
};

exports.updateLocationForTenant = async (req, res) => {
  try {
    const { Tenant, Location } = getSuperAdminModels();
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId query/body parameter is required'
      });
    }

    if (!isValidObjectId(tenantId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenantId'
      });
    }

    const location = await Location.findOne({
      _id: req.params.id,
      tenant: tenantId
    });


    if (!location) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }

    const { name, address, latitude, longitude, radius, description, isActive } = req.body;

    const trimmedName = name?.trim();

    if (trimmedName && trimmedName !== location.name) {
      const existingLocation = await Location.findOne({
        tenant: tenantId,
        _id: { $ne: location._id },
        name: { $regex: `^${escapeRegex(trimmedName)}$`, $options: 'i' }
      });

      if (existingLocation) {
        return res.status(400).json({
          success: false,
          message: 'Location with this name already exists'
        });
      }
    }

    location.name = trimmedName || location.name;
    location.address = address ? address.trim() : location.address;
    location.latitude = latitude !== undefined ? latitude : location.latitude;
    location.longitude = longitude !== undefined ? longitude : location.longitude;
    location.radius = radius !== undefined ? radius : location.radius;
    location.description = description !== undefined ? description.trim() : location.description;
    location.isActive = isActive !== undefined ? isActive : location.isActive;

    await location.save();

    res.status(200).json({
      success: true,
      message: 'Location updated successfully',
      data: location
    });
  } catch (error) {
    handleLocationError(res, error, 'Error updating location');
  }
};

exports.deleteLocationForTenant = async (req, res) => {
  try {
    const { Tenant, Location } = getSuperAdminModels();
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId query parameter is required'
      });
    }

    if (!isValidObjectId(tenantId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenantId'
      });
    }

    const location = await Location.findOne({
      _id: req.params.id,
      tenant: tenantId
    });


    if (!location) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }

    location.isActive = false;
    await location.save();

    res.status(200).json({
      success: true,
      message: 'Location deleted successfully'
    });
  } catch (error) {
    handleLocationError(res, error, 'Error deleting location');
  }
};

