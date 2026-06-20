const mongoose = require('mongoose');
const DefaultEmployee = require('../models/Employee');
const DefaultProject = require('../models/Project');
const DefaultTask = require('../models/Task');
const DefaultNotification = require('../models/Notification');
const DefaultUser = require('../models/User');
// Resolve models in a tenant-aware way: prefer req.models, else reuse existing mongoose models
const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

const getModels = (req) => ({
  Employee: resolveModel(req, 'Employee', DefaultEmployee),
  Project: resolveModel(req, 'Project', DefaultProject),
  Task: resolveModel(req, 'Task', DefaultTask),
  Notification: resolveModel(req, 'Notification', DefaultNotification),
  User: resolveModel(req, 'User', DefaultUser),
});

// @desc    Create a new project
// @route   POST /api/projects
// @access  Private/Admin
exports.createProject = async (req, res) => {
  try {
    const { Project, Notification } = getModels(req);
    const { name, description, startDate, endDate, assignedEmployees } = req.body;

    const project = await Project.create({
      name,
      description,
      startDate,
      endDate,
      assignedEmployees,
      tenant: req.tenant._id,
      createdBy: req.user._id
    });

    // Create notifications for assigned employees (use their User account as recipient)
    if (assignedEmployees && assignedEmployees.length > 0) {
      const { User } = getModels(req);
      const notificationPromises = assignedEmployees.map(async (employeeId) => {
        try {
          const assignedUser = await User.findOne({
            employee: employeeId,
            tenant: req.tenant._id,
            isActive: true
          });

          if (!assignedUser) return null;

          return Notification.create({
            user: assignedUser._id,
            employee: employeeId,
            title: 'New Project Assignment',
            message: `You have been assigned to project: ${name}`,
            type: 'project-assigned',
            relatedEntity: 'project',
            entityId: project._id,
            tenant: req.tenant._id
          });
        } catch (err) {
          console.error('Failed to create project assignment notification for employee', employeeId, err.message || err);
          return null;
        }
      });

      // run notifications but don't block the main flow if they fail
      try {
        await Promise.all(notificationPromises);
      } catch (err) {
        // ignore notification errors
        console.warn('One or more project assignment notifications failed', err && err.message ? err.message : err);
      }
    }

    const populatedProject = await Project.findById(project._id)
      .populate('assignedEmployees', 'name email position department isActive')
      .populate('createdBy', 'name email');

    res.status(201).json({
      success: true,
      data: populatedProject
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get all projects for tenant
// @route   GET /api/projects
// @access  Private
exports.getProjects = async (req, res) => {
  try {
    const { Project, Employee } = getModels(req);
    const { status } = req.query;
    let filter = { tenant: req.tenant._id, isActive: true };

    if (status) {
      filter.status = status;
    }

    // If user is employee, only show assigned projects
    if (req.user.role === 'employee') {
      // Prefer employee populated on req.user (set by auth middleware). Fallback to lookup by user id.
      let employee = req.user.employee && req.user.employee._id ? req.user.employee : null;
      if (!employee) {
        employee = await Employee.findOne({ user: req.user._id });
      }
      if (employee) {
        filter.assignedEmployees = employee._id;
      } else {
        // No employee record found for this user - return empty result immediately
        return res.status(200).json({ success: true, data: [] });
      }
    }

    const projects = await Project.find(filter)
      .populate('assignedEmployees', 'name email position department isActive')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: projects
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get single project
// @route   GET /api/projects/:id
// @access  Private
exports.getProject = async (req, res) => {
  try {
    const { Project, Employee } = getModels(req);

    const project = await Project.findOne({
      _id: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    })
      .populate('assignedEmployees', 'name email position department user isActive')
      .populate('createdBy', 'name email');

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check if employee is assigned to project
    if (req.user.role === 'employee') {
      try {
        // Prefer employee populated on req.user (set by auth middleware). Fallback to lookup by user id.
        let employee = req.user.employee && req.user.employee._id ? req.user.employee : null;
        if (!employee) {
          // Employee model doesn't include tenant field (tenant DB separation), so don't filter by tenant here
          employee = await Employee.findOne({ user: req.user._id });
        }

        if (!employee) {
          return res.status(403).json({
            success: false,
            message: 'Access denied - Employee record not found'
          });
        }

        // Check if employee is assigned to this project. assignedEmployees may be populated objects.
        const isAssigned = project.assignedEmployees.some((assignedEmp) => {
          const assignedId = assignedEmp._id ? String(assignedEmp._id) : String(assignedEmp);
          const empId = employee._id ? String(employee._id) : String(employee);
          return assignedId === empId;
        });

        if (!isAssigned) {
          return res.status(403).json({
            success: false,
            message: 'Access denied - You are not assigned to this project'
          });
        }
      } catch (employeeError) {
        console.error('Error checking employee assignment:', employeeError);
        return res.status(403).json({
          success: false,
          message: 'Access denied - Error verifying assignment'
        });
      }
    }

    res.status(200).json({
      success: true,
      data: project
    });
  } catch (error) {
    console.error('Error in getProject:', error);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Update project
// @route   PUT /api/projects/:id
// @access  Private/Admin
exports.updateProject = async (req, res) => {
  try {
    const { Project } = getModels(req);

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        tenant: req.tenant._id,
        isActive: true
      },
      req.body,
      { new: true, runValidators: true }
    )
      .populate('assignedEmployees', 'name email position department isActive')
      .populate('createdBy', 'name email');

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.status(200).json({
      success: true,
      data: project
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Delete project (soft delete)
// @route   DELETE /api/projects/:id
// @access  Private/Admin
exports.deleteProject = async (req, res) => {
  try {
    const { Project, Task } = getModels(req);

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        tenant: req.tenant._id
      },
      { isActive: false },
      { new: true }
    );

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Also deactivate all tasks under this project
    await Task.updateMany(
      { project: req.params.id, tenant: req.tenant._id },
      { isActive: false }
    );

    res.status(200).json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get project progress
// @route   GET /api/projects/:id/progress
// @access  Private
exports.getProjectProgress = async (req, res) => {
  try {
    const { Task, Project } = getModels(req);

    const tasks = await Task.find({
      project: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    });

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(task => task.status === 'done').length;
    const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // Update project progress
    await Project.findByIdAndUpdate(req.params.id, { progress });

    res.status(200).json({
      success: true,
      data: {
        progress,
        totalTasks,
        completedTasks,
        pendingTasks: totalTasks - completedTasks
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

