const { getSuperAdminModels } = require('../config/db');

const escapeRegex = (value) => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const getTenantId = (req) => req.tenant?._id || req.user?.tenant;

const requireTenantId = (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) {
    res.status(400).json({
      success: false,
      message: 'Tenant context required'
    });
    return null;
  }
  return tenantId;
};

const handleLocationError = (res, error, fallbackMessage) => {
  if (error?.code === 11000) {
    return res.status(400).json({
      success: false,
      message: 'Location with this name already exists'
    });
  }

  console.error(`[locationController] ${fallbackMessage}:`, error);
  return res.status(500).json({
    success: false,
    message: error.message || fallbackMessage
  });
};

// Get all active locations for the current tenant.
exports.getAllLocations = async (req, res) => {
  try {
    const { Location } = getSuperAdminModels();
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

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

// Get a single active location for the current tenant.
exports.getLocation = async (req, res) => {
  try {
    const { Location } = getSuperAdminModels();
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

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

    res.status(200).json({
      success: true,
      data: location
    });
  } catch (error) {
    handleLocationError(res, error, 'Error fetching location');
  }
};

// Create a new location for the current tenant.
exports.createLocation = async (req, res) => {
  try {
    const { Location } = getSuperAdminModels();
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const { name, address, latitude, longitude, radius, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Location name is required'
      });
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
      address: typeof address === 'string' ? address.trim() : '',
      latitude: latitude !== undefined ? latitude : null,
      longitude: longitude !== undefined ? longitude : null,
      radius: radius !== undefined ? radius : 100,
      description: typeof description === 'string' ? description.trim() : '',
      createdBy: req.user._id,
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

// Update a location for the current tenant.
exports.updateLocation = async (req, res) => {
  try {
    const { Location } = getSuperAdminModels();
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const { name, address, latitude, longitude, radius, description, isActive } = req.body;

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
    location.address = typeof address === 'string' ? address.trim() : location.address;
    location.latitude = latitude !== undefined ? latitude : location.latitude;
    location.longitude = longitude !== undefined ? longitude : location.longitude;
    location.radius = radius !== undefined ? radius : location.radius;
    location.description = typeof description === 'string' ? description.trim() : location.description;
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

// Soft-delete a location for the current tenant.
exports.deleteLocation = async (req, res) => {
  try {
    const { Location } = getSuperAdminModels();
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

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
