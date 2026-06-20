const express = require('express');
const {
  addProgressUpdate,
  getTaskProgress,
  getTodayUpdates
} = require('../controllers/taskProgressController');
const { listProgress } = require('../controllers/taskProgressController');
const { protect } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

// Debug: confirm router is loaded
console.log('🔧 taskProgress router loaded');

router.use(protect);
router.use(requireTenant);

// Order: keep specific routes first (my-updates) to avoid accidental
// conflicts when mounted alongside other task routes.
router.get('/my-updates/today', getTodayUpdates);
// Admin: list progress updates across tasks (supports filters & pagination)
router.get('/progress', listProgress);
router.post('/:taskId/progress', addProgressUpdate);
router.get('/:taskId/progress', getTaskProgress);

module.exports = router;