const express = require('express');
const {
  createProject,
  getProjects,
  getProject,
  updateProject,
  deleteProject,
  getProjectProgress,
  setProjectProgress,
  getProjectDepartments
} = require('../controllers/projectController');
const { protect, authorize } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.use(protect);
router.use(requireTenant);

// NOTE: placed before '/:id' so 'departments' is never mistaken for an id.
router.get('/departments', authorize('admin'), getProjectDepartments);

// Projects are created and edited by admin only. Managers/team-leads own
// a project (they can view it, create/assign/edit tasks under it — see
// routes/tasks.js) but do not edit the project record itself.
router.route('/')
  .post(authorize('admin'), createProject)
  .get(getProjects); // scoping (admin/team-lead/manager/employee) handled inside controller

router.route('/:id')
  .get(getProject)
  .put(authorize('admin'), updateProject)
  .delete(authorize('admin'), deleteProject);

router.route('/:id/progress')
  .get(getProjectProgress)
  // Manual project-level progress update — admin or the project's owning
  // manager/team-lead (ownership re-validated inside the controller,
  // same pattern as task routes). Separate from task progress
  // (routes/tasks.js's /:id/progress), which requires a task, location,
  // and parts count for Auditing Parts work.
  .put(authorize('admin', 'manager', 'team-lead'), setProjectProgress);

module.exports = router;