const express = require('express');
const {
  applyForPermission,
  getMyPermissions,
  getAllPermissions,
  updatePermissionStatus,
  getPermissionStats,
  getAllPendingPermissionsForLead,
  updateLeadPermissionStatus
} = require('../controllers/permissionController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.post('/', applyForPermission);
router.get('/my-permissions', getMyPermissions);
router.get('/stats', getPermissionStats);
router.get('/lead-pending', authorize('team-lead'), getAllPendingPermissionsForLead);
router.put('/:id/lead-status', authorize('team-lead'), updateLeadPermissionStatus);
router.get('/', authorize('admin'), getAllPermissions);
router.put('/:id/status', authorize('admin'), updatePermissionStatus);

module.exports = router;
