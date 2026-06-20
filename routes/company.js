const express = require('express');
const { body } = require('express-validator');
const {
  getCompanyInfo,
  updateCompanyInfo,
  uploadLogo,
  getPublicCompanyInfo
} = require('../controllers/companyController');
const { protect, authorize } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

// Public route for login page
router.get('/public', getPublicCompanyInfo);

// Protected routes (require tenant context)
router.get('/', protect, requireTenant, getCompanyInfo);

router.put('/', 
  protect,
  requireTenant,
  authorize('admin'),
  [
    body('name')
      .optional()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Company name must be between 1 and 100 characters')
  ],
  updateCompanyInfo
);

router.post('/logo',
  protect,
  requireTenant,
  authorize('admin'),
  [
    body('logo')
      .notEmpty()
      .withMessage('Logo data is required')
  ],
  uploadLogo
);

module.exports = router;