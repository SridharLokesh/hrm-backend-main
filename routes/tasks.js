const express = require('express');
const {
  createTask,
  getTasks,
  getTasksForBoard,
  getTask,
  updateTask,
  updateTaskStatus,
  deleteTask
} = require('../controllers/taskController');
const { protect, authorize } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.use(protect);
router.use(requireTenant);

router.route('/')
  .post(authorize('admin'), createTask)
  .get(getTasks);

router.route('/board')
  .get(getTasksForBoard);

router.route('/:id')
  .get(getTask)
  .put(authorize('admin'), updateTask)
  .delete(authorize('admin'), deleteTask);

router.route('/:id/status')
  .put(updateTaskStatus);

module.exports = router;