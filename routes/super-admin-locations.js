const express = require('express');
const {
  getAllLocationsForTenant,
  getLocationForTenant,
  createLocationForTenant,
  updateLocationForTenant,
  deleteLocationForTenant
} = require('../controllers/superAdminLocationController');

const { superAdminAuth } = require('../middleware/auth');

const router = express.Router();

// All super-admin location routes
router.use(superAdminAuth);

// Tenant-scoped via ?tenantId=... (client will provide)
router.get('/', getAllLocationsForTenant);
router.get('/:id', getLocationForTenant);
router.post('/', createLocationForTenant);
router.put('/:id', updateLocationForTenant);
router.delete('/:id', deleteLocationForTenant);

module.exports = router;

