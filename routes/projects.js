const express = require('express');
const {
  createProject,
  getProjects,
  getProject,
  updateProject,
  deleteProject,
  getProjectProgress
} = require('../controllers/projectController');
const { protect, authorize } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.use(protect);
router.use(requireTenant);

router.route('/')
  .post(authorize('admin'), createProject)
  .get(getProjects);

router.route('/:id')
  .get(getProject)
  .put(authorize('admin'), updateProject)
  .delete(authorize('admin'), deleteProject);

router.route('/:id/progress')
  .get(getProjectProgress);

module.exports = router;