const mongoose = require('mongoose');
const DefaultEmployee = require('../models/Employee');
const DefaultTask = require('../models/Task');
const DefaultProject = require('../models/Project');
const DefaultNotification = require('../models/Notification');
const DefaultUser = require('../models/User'); // Add this import

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

const getModels = (req) => ({
  Employee: resolveModel(req, 'Employee', DefaultEmployee),
  Task: resolveModel(req, 'Task', DefaultTask),
  Project: resolveModel(req, 'Project', DefaultProject),
  Notification: resolveModel(req, 'Notification', DefaultNotification),
  User: resolveModel(req, 'User', DefaultUser), // Add User model
});

// Helper function to get user ID from employee ID
async function getUserForEmployee(employeeId, tenantId, models) {
  const { User, Employee } = models;
  
  // Find the employee first
  const employee = await Employee.findOne({
    _id: employeeId,
    tenant: tenantId
  });
  
  if (!employee) {
    throw new Error('Employee not found');
  }
  
  // Find the user associated with this employee
  const user = await User.findOne({
    employee: employeeId,
    tenant: tenantId,
    isActive: true
  });
  
  if (!user) {
    throw new Error('User not found for employee');
  }
  
  return user._id;
}

// @desc    Create a new task
// @route   POST /api/tasks
// @access  Private/Admin
exports.createTask = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task, Notification, User } = models;

    const task = await Task.create({
      ...req.body,
      tenant: req.tenant._id,
      createdBy: req.user._id
    });

    const populatedTask = await Task.findById(task._id)
      .populate('project', 'name')
      .populate('assignedTo', 'name email position department')
      .populate('createdBy', 'name email');

    // FIXED: Get the correct user ID for the assigned employee
    try {
      const assignedUser = await User.findOne({
        employee: req.body.assignedTo,
        tenant: req.tenant._id,
        isActive: true
      });

      if (assignedUser) {
        await Notification.create({
          user: assignedUser._id, // Use the assigned employee's user ID
          employee: req.body.assignedTo,
          title: 'New Task Assigned',
          message: `You have been assigned a new task: "${req.body.title}" in project: ${populatedTask.project?.name || 'Unknown Project'}`,
          type: 'task-assigned',
          relatedEntity: 'task',
          entityId: task._id,
          tenant: req.tenant._id
        });
      }
    } catch (notificationError) {
      console.error('Failed to create notification:', notificationError);
      // Don't fail the whole request if notification fails
    }

    // Update project progress
    await updateProjectProgress(req.body.project, models);

    res.status(201).json({
      success: true,
      data: populatedTask
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get all tasks
// @route   GET /api/tasks
// @access  Private
exports.getTasks = async (req, res) => {
  try {
    const { project, status, assignedTo } = req.query;
    let filter = { tenant: req.tenant._id, isActive: true };

    if (project) filter.project = project;
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;

    // If user is employee, only show assigned tasks
    if (req.user.role === 'employee') {
      const { Employee } = getModels(req);
      const employee = await Employee.findOne({ user: req.user._id });
      if (employee) {
        filter.assignedTo = employee._id;
      }
    }

    const { Task } = getModels(req);

    const tasks = await Task.find(filter)
      .populate('project', 'name status')
      .populate('assignedTo', 'name email position department')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: tasks
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get tasks for Kanban board
// @route   GET /api/tasks/board
// @access  Private
exports.getTasksForBoard = async (req, res) => {
  try {
    const { project } = req.query;
    let filter = { tenant: req.tenant._id, isActive: true };

    if (project) filter.project = project;

    // If user is employee, only show assigned tasks
    if (req.user.role === 'employee') {
      const { Employee } = getModels(req);
      const employee = await Employee.findOne({ user: req.user._id });
      if (employee) {
        filter.assignedTo = employee._id;
      }
    }

    const { Task } = getModels(req);

    const tasks = await Task.find(filter)
      .populate('project', 'name')
      .populate('assignedTo', 'name email position department')
      .sort({ priority: -1, createdAt: -1 });

    // Group tasks by status for Kanban board
    const boardData = {
      todo: tasks.filter(task => task.status === 'todo'),
      'in-progress': tasks.filter(task => task.status === 'in-progress'),
      review: tasks.filter(task => task.status === 'review'),
      done: tasks.filter(task => task.status === 'done')
    };

    res.status(200).json({
      success: true,
      data: boardData
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get single task
// @route   GET /api/tasks/:id
// @access  Private
exports.getTask = async (req, res) => {
  try {
    const { Task, Employee } = getModels(req);

    const task = await Task.findOne({
      _id: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    })
      .populate('project', 'name')
      .populate('assignedTo', 'name email position department')
      .populate('createdBy', 'name email');

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    // If user is employee, ensure they are assigned to the task
    if (req.user.role === 'employee') {
      try {
        let employee = req.user.employee && req.user.employee._id ? req.user.employee : null;
        if (!employee) {
          employee = await Employee.findOne({ user: req.user._id });
        }
        if (!employee) {
          return res.status(403).json({ success: false, message: 'Access denied - Employee record not found' });
        }

        const assignedId = task.assignedTo && task.assignedTo._id ? String(task.assignedTo._id) : String(task.assignedTo);
        const empId = employee._id ? String(employee._id) : String(employee);
        if (assignedId !== empId) {
          return res.status(403).json({ success: false, message: 'Access denied - You are not assigned to this task' });
        }
      } catch (err) {
        console.error('Error checking task assignment:', err);
        return res.status(403).json({ success: false, message: 'Access denied - Error verifying assignment' });
      }
    }

    res.status(200).json({ success: true, data: task });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Update task status (for drag & drop)
// @route   PUT /api/tasks/:id/status
// @access  Private
exports.updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    
    const models = getModels(req);
    const { Task, Employee, User, Notification } = models;

    const task = await Task.findOne({
      _id: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    }).populate('assignedTo', 'name');

    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    // Check if employee is assigned to this task
    if (req.user.role === 'employee') {
      try {
        // Prefer populated employee on req.user (auth middleware). Fallback to lookup by user id.
        let employee = req.user.employee && req.user.employee._id ? req.user.employee : null;
        if (!employee) {
          employee = await Employee.findOne({ user: req.user._id });
        }

        if (!employee) {
          return res.status(403).json({
            success: false,
            message: 'Access denied'
          });
        }

        // assignedTo may be populated object or an ObjectId; normalize both sides to strings
        const assignedId = task.assignedTo && task.assignedTo._id ? String(task.assignedTo._id) : String(task.assignedTo);
        const empId = employee._id ? String(employee._id) : String(employee);

        if (assignedId !== empId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied'
          });
        }
      } catch (err) {
        console.error('Error verifying employee for status update:', err);
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

  const previousStatus = task.status;
  task.status = status;
    await task.save();

    const populatedTask = await Task.findById(task._id)
      .populate('project', 'name')
      .populate('assignedTo', 'name email position department');

    // Update project progress
    await updateProjectProgress(task.project, models);

    // FIXED: Create notification for the assigned employee about status update
    // Determine actor label (Admin or employee name/email) to include in messages
    let actorLabel = req.user.role === 'admin' ? 'Admin' : 'Employee';
    try {
      let actorEmployeeForLabel = req.user.employee && req.user.employee._id ? req.user.employee : null;
      if (!actorEmployeeForLabel) {
        actorEmployeeForLabel = await Employee.findOne({ user: req.user._id });
      }
      if (actorEmployeeForLabel) {
        const actorDoc = await Employee.findById(actorEmployeeForLabel._id);
        if (actorDoc && actorDoc.name) actorLabel = actorDoc.name;
      } else if (req.user.email) {
        actorLabel = req.user.email;
      }
    } catch (labelErr) {
      // ignore and keep default actorLabel
    }

    try {
      // Decide whether to notify the assigned employee. If the actor is the same assigned employee
      // (i.e. the employee changed their own task status), skip notifying them.
      let shouldNotifyAssigned = true;
      if (req.user.role === 'employee') {
        try {
          let actorEmployee = req.user.employee && req.user.employee._id ? req.user.employee : null;
          if (!actorEmployee) {
            actorEmployee = await Employee.findOne({ user: req.user._id });
          }
          const actorId = actorEmployee && actorEmployee._id ? String(actorEmployee._id) : null;
          const assignedId = task.assignedTo && task.assignedTo._id ? String(task.assignedTo._id) : String(task.assignedTo);
          if (actorId && assignedId && actorId === assignedId) {
            shouldNotifyAssigned = false;
          }
        } catch (innerErr) {
          // If we fail to resolve actor employee, fall back to notifying the assigned user
          console.warn('Failed to resolve actor employee for notification decision:', innerErr);
          shouldNotifyAssigned = true;
        }
      }

      if (shouldNotifyAssigned) {
        const assignedUser = await User.findOne({
          employee: task.assignedTo._id,
          tenant: req.tenant._id,
          isActive: true
        });

        if (assignedUser) {
          await Notification.create({
            user: assignedUser._id, // Use the assigned employee's user ID
            employee: task.assignedTo._id,
            title: 'Task Status Updated',
            message: `By ${actorLabel}: Task "${task.title}" status changed to ${status}`,
            type: 'task-updated',
            relatedEntity: 'task',
            entityId: task._id,
            tenant: req.tenant._id
          });
        }
      }
    } catch (notificationError) {
      console.error('Failed to create status notification:', notificationError);
    }

    // Notify admins when an employee (not admin) changes a task status
    try {
      if (req.user.role === 'employee') {
  // previousStatus captured before update

        // Resolve actor employee (the employee who performed the change)
        let actorEmployee = req.user.employee && req.user.employee._id ? req.user.employee : null;
        if (!actorEmployee) {
          actorEmployee = await Employee.findOne({ user: req.user._id });
        }

  // Fetch actor name for the message
  let actorName = 'Employee';
        if (actorEmployee) {
          const actorDoc = await Employee.findById(actorEmployee._id);
          actorName = actorDoc?.name || actorName;
        }

        // Only proceed if we resolved an actor employee id
        if (!actorEmployee) {
          // nothing to notify
        } else {
          const adminUsers = await User.find({ role: 'admin', tenant: req.tenant._id, isActive: true });
          if (adminUsers && adminUsers.length > 0) {
          const adminNotifications = adminUsers.map(admin => ({
            user: admin._id,
            employee: actorEmployee?._id || actorEmployee || null,
            title: 'Task Status Updated',
            message: `By ${actorName}: Task "${task.title}" status changed to ${status}`,
            type: 'task-updated',
            relatedEntity: 'task',
            entityId: task._id,
            tenant: req.tenant._id
          }));

            // create notifications but don't block main flow if it fails
            await Notification.insertMany(adminNotifications);
          }
        }
      }
    } catch (adminNotifyError) {
      console.error('Failed to notify admins about status change:', adminNotifyError);
    }

    res.status(200).json({
      success: true,
      data: populatedTask
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Update task
// @route   PUT /api/tasks/:id
// @access  Private/Admin
exports.updateTask = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task, User, Notification } = models;

    const oldTask = await Task.findOne({
      _id: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    });

    if (!oldTask) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    const task = await Task.findOneAndUpdate(
      {
        _id: req.params.id,
        tenant: req.tenant._id,
        isActive: true
      },
      req.body,
      { new: true, runValidators: true }
    )
      .populate('project', 'name')
      .populate('assignedTo', 'name email position department')
      .populate('createdBy', 'name email');

    // FIXED: Send notification if task assignment changed
    if (req.body.assignedTo && !oldTask.assignedTo.equals(req.body.assignedTo)) {
      try {
        const assignedUser = await User.findOne({
          employee: req.body.assignedTo,
          tenant: req.tenant._id,
          isActive: true
        });

        if (assignedUser) {
          await Notification.create({
            user: assignedUser._id,
            employee: req.body.assignedTo,
            title: 'Task Reassigned',
            message: `Task "${task.title}" has been assigned to you`,
            type: 'task-assigned',
            relatedEntity: 'task',
            entityId: task._id,
            tenant: req.tenant._id
          });
        }
      } catch (notificationError) {
        console.error('Failed to create reassignment notification:', notificationError);
      }
    }

    // Update project progress
    await updateProjectProgress(task.project, models);

    res.status(200).json({
      success: true,
      data: task
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Delete task
// @route   DELETE /api/tasks/:id
// @access  Private/Admin
exports.deleteTask = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task } = models;

    // Support optional hard delete via query param ?hard=true
    const hard = String(req.query.hard || '').toLowerCase() === 'true';

    let task;
    if (hard) {
      // permanently remove the document
      task = await Task.findOneAndDelete({ _id: req.params.id, tenant: req.tenant._id });
    } else {
      // soft delete
      task = await Task.findOneAndUpdate(
        {
          _id: req.params.id,
          tenant: req.tenant._id
        },
        { isActive: false },
        { new: true }
      );
    }

    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    // Update project progress
    await updateProjectProgress(task.project, models);

    res.status(200).json({
      success: true,
      message: 'Task deleted successfully'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// FIXED: Updated helper function to accept models parameter
async function updateProjectProgress(projectId, models) {
  const { Task, Project } = models;

  const tasks = await Task.find({
    project: projectId,
    isActive: true
  });

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(task => task.status === 'done').length;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  await Project.findByIdAndUpdate(projectId, { progress });
}