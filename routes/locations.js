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

// All routes require authentication
router.use(protect);

// Get all locations - accessible by employees to see dropdown
router.get('/', getAllLocations);

// Get single location
router.get('/:id', getLocation);

// Create, update, delete - admin only
router.post('/', authorize('admin'), createLocation);
router.put('/:id', authorize('admin'), updateLocation);
router.delete('/:id', authorize('admin'), deleteLocation);

module.exports = router;
