const express = require('express');
const {
  getAllLocations,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation
} = require('../controllers/locationController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Tenant-scoped locations for tenant admins
// All routes require authentication and tenant context (set by detectTenant middleware)
router.use(protect);

// Read endpoints available to tenant admins (employees can still use /api/locations)
router.get('/', authorize('admin'), getAllLocations);
router.get('/:id', authorize('admin'), getLocation);

// Create, update, delete - admin only
router.post('/', authorize('admin'), createLocation);
router.put('/:id', authorize('admin'), updateLocation);
router.delete('/:id', authorize('admin'), deleteLocation);

module.exports = router;

