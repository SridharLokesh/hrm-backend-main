const express = require('express');
const { verifyPincode } = require('../controllers/utilsController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.get('/verify-pincode/:pincode', verifyPincode);

module.exports = router;