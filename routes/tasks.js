const express = require('express');
const {
  createTask,
  getTasks,
  getTasksForBoard,
  getTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  addProgressUpdate,
  getTaskProgress,
  getTodayUpdates,
  listProgressAdmin
} = require('../controllers/taskController');
const { protect, authorize } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.use(protect);
router.use(requireTenant);

router.route('/')
  .post(authorize('admin', 'manager', 'team-lead'), createTask) // ownership of the target project enforced in controller
  .get(getTasks); // scoping handled inside controller

router.route('/board')
  .get(getTasksForBoard);

// Aggregate progress-report listing (Task Progress page's report table).
// Admin sees every project; manager/team-lead now also get this route,
// scoped server-side to only the projects they own (see
// taskController.js `listProgressAdmin`) — this is their "everyone on my
// team" progress view. Employees are intentionally excluded here; they
// only ever see progress on their own assigned tasks via the
// per-task /:id/progress endpoint below.
// Must be defined before '/:id' routes.
router.get('/progress', authorize('admin', 'manager', 'team-lead'), listProgressAdmin);

// Current user's own progress updates logged today.
router.get('/my-updates/today', getTodayUpdates);

router.route('/:id')
  .get(getTask)
  .put(authorize('admin', 'manager', 'team-lead'), updateTask) // ownership enforced in controller
  .delete(authorize('admin', 'manager', 'team-lead'), deleteTask); // ownership enforced in controller

router.route('/:id/status')
  .put(updateTaskStatus); // admin, owning manager/team-lead, or assigned employee — enforced in controller

router.route('/:id/progress')
  .post(addProgressUpdate) // assigned employee, admin, or owning manager/team-lead — enforced in controller
  .get(getTaskProgress);

module.exports = router;