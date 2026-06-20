const express = require('express');
const router = express.Router();
const {
  getDepartmentSettings,
  updateDepartmentSetting,
  getRequiredDepartments
} = require('../controllers/departmentSettingController');
const { protect, adminOnly } = require('../middleware/auth');

// All routes require authentication and admin access
router.use(protect);
router.use(adminOnly);

router.get('/', getDepartmentSettings);
router.get('/required', getRequiredDepartments);
router.put('/:departmentName', updateDepartmentSetting);

module.exports = router;