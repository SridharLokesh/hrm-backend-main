const mongoose = require('mongoose');
const DefaultEmployee = require('../models/Employee');
const DefaultTask = require('../models/Task');
const DefaultProject = require('../models/Project');
const DefaultNotification = require('../models/Notification');
const DefaultUser = require('../models/User');

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
  User: resolveModel(req, 'User', DefaultUser),
});

const PROJECT_OWNER_ROLES = ['manager', 'team-lead'];

// Work type that requires a mandatory work location (city + pincode) and
// a parts count — enforced both at task creation/edit time (targetPartsCount
// + workLocation) and at daily progress-update time (partsCount +
// reportedLocation). Mirrors AUDITING_WORK_TYPE in the frontend's
// utils/constants.js — keep these in sync.
const AUDITING_WORK_TYPE = 'auditing-parts';

const isAuditingParts = (workType) => workType === AUDITING_WORK_TYPE;

// Validates that an Auditing Parts task/update carries a work location
// (city + pincode) and a parts count. Returns an error message string, or
// null if the requirements are satisfied (or don't apply).
function missingAuditingFields({ workType, workLocation, partsCount }) {
  if (!isAuditingParts(workType)) return null;
  const city = workLocation && workLocation.city ? String(workLocation.city).trim() : '';
  const pincode = workLocation && workLocation.pincode ? String(workLocation.pincode).trim() : '';
  const hasCount = partsCount !== undefined && partsCount !== null && String(partsCount).trim() !== '' && !Number.isNaN(Number(partsCount));
  if (!city || !pincode || !hasCount) {
    return 'Auditing Parts tasks require a work location (city & pincode) and a parts count.';
  }
  return null;
}

const resolveActingEmployee = async (req, Employee) => {
  if (req.user.employee && req.user.employee._id) return req.user.employee;
  return Employee.findOne({ user: req.user._id });
};

// Returns true if the given employeeId is the teamLead or manager on the project
const isOwnerOfProject = (project, employeeId) => {
  if (!project) return false;
  const empId = String(employeeId);
  const teamLeadId = project.teamLead?._id ? String(project.teamLead._id) : String(project.teamLead || '');
  const managerId = project.manager?._id ? String(project.manager._id) : String(project.manager || '');
  return empId === teamLeadId || empId === managerId;
};

// Returns the list of project _ids (as strings) owned by this employee — used
// to build $in filters for list/board endpoints.
const getOwnedProjectIds = async (Project, tenantId, employeeId) => {
  const projects = await Project.find({
    tenant: tenantId,
    isActive: true,
    $or: [{ teamLead: employeeId }, { manager: employeeId }]
  }).select('_id');
  return projects.map(p => p._id);
};

// Validates that every id in `assignedTo` (which may be a single id, or an
// array of ids — the frontend now lets a manager/team-lead pick multiple
// people at once) belongs to the acting manager/team-lead's own
// department. This replaces the old "same direct team" (teamLead field)
// check, which was both the wrong rule (department-scoped assignment is
// what the UI actually offers via getEmployeesForAssignment) and broken
// for arrays (a strict-equality Mongo query against an array of ids never
// matches a single ObjectId field, so it rejected valid same-department
// picks too).
//
// Returns an error message string, or null if every assignee checks out.
async function validateAssigneesInOwnDepartment(Employee, actingEmployee, assignedTo) {
  if (!assignedTo) return null;
  const ids = Array.isArray(assignedTo) ? assignedTo : [assignedTo];
  if (ids.length === 0) return null;

  const myDept = String(actingEmployee.department || '').toLowerCase().trim();

  const assignees = await Employee.find({ _id: { $in: ids }, isActive: true });
  if (assignees.length !== ids.length) {
    return 'One or more selected assignees could not be found.';
  }

  const outsideDept = assignees.some(
    a => String(a.department || '').toLowerCase().trim() !== myDept
  );
  if (outsideDept) {
    return 'You can only assign tasks to members of your own department.';
  }

  return null;
}

// @desc    Create a new task
// @route   POST /api/tasks
// @access  Private/Admin, Manager, Team Lead (scoped to own project)
exports.createTask = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task, Notification, User, Project, Employee } = models;

    const { project: projectId, assignedTo } = req.body;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'Project is required' });
    }

    const project = await Project.findOne({ _id: projectId, tenant: req.tenant._id, isActive: true });
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    // Manager / Team Lead may only create tasks under a project they own,
    // and may only assign to employees in their own department.
    if (PROJECT_OWNER_ROLES.includes(req.user.role)) {
      const actingEmployee = await resolveActingEmployee(req, Employee);
      if (!actingEmployee || !isOwnerOfProject(project, actingEmployee._id)) {
        return res.status(403).json({ success: false, message: 'Access denied - You do not own this project' });
      }
      const assigneeError = await validateAssigneesInOwnDepartment(Employee, actingEmployee, assignedTo);
      if (assigneeError) {
        return res.status(403).json({ success: false, message: assigneeError });
      }
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Auditing Parts tasks must carry a work location + a parts count from
    // the moment they're created, so the assignee always has somewhere to
    // report progress against.
    const auditingError = missingAuditingFields({
      workType: req.body.workType,
      workLocation: req.body.workLocation,
      partsCount: req.body.targetPartsCount
    });
    if (auditingError) {
      return res.status(400).json({ success: false, message: auditingError });
    }

    const task = await Task.create({
      ...req.body,
      tenant: req.tenant._id,
      createdBy: req.user._id
    });

    const populatedTask = await Task.findById(task._id)
      .populate('project', 'name')
      .populate('assignedTo', 'name email position department')
      .populate('createdBy', 'name email');

    // Notify every assignee — assignedTo may be a single id or an array,
    // so normalize to an array before looking up their User accounts.
    try {
      const assignedIds = Array.isArray(req.body.assignedTo)
        ? req.body.assignedTo
        : (req.body.assignedTo ? [req.body.assignedTo] : []);

      if (assignedIds.length > 0) {
        const assignedUsers = await User.find({
          employee: { $in: assignedIds },
          tenant: req.tenant._id,
          isActive: true
        });

        if (assignedUsers.length > 0) {
          await Notification.insertMany(assignedUsers.map(u => ({
            user: u._id,
            employee: u.employee,
            title: 'New Task Assigned',
            message: `You have been assigned a new task: "${req.body.title}" in project: ${populatedTask.project?.name || 'Unknown Project'}`,
            type: 'task-assigned',
            relatedEntity: 'task',
            entityId: task._id,
            tenant: req.tenant._id
          })));
        }
      }
    } catch (notificationError) {
      console.error('Failed to create notification:', notificationError);
    }

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

// Builds the base task filter for the current actor's role. Shared by
// getTasks and getTasksForBoard so both stay in sync.
async function buildScopedTaskFilter(req, models, extraFilter = {}) {
  const { Employee, Project } = models;
  const filter = { tenant: req.tenant._id, isActive: true, ...extraFilter };

  if (req.user.role === 'admin') {
    return { filter, denied: false };
  }

  if (PROJECT_OWNER_ROLES.includes(req.user.role)) {
    const employee = await resolveActingEmployee(req, Employee);
    if (!employee) return { filter, denied: true };

    const ownedProjectIds = await getOwnedProjectIds(Project, req.tenant._id, employee._id);

    if (extraFilter.project) {
      // A specific project was requested — only honor it if they own it.
      const requested = String(extraFilter.project);
      const owns = ownedProjectIds.some(id => String(id) === requested);
      if (!owns) return { filter, denied: true };
    } else {
      filter.project = { $in: ownedProjectIds };
    }
    return { filter, denied: false };
  }

  // employee role
  const employee = await resolveActingEmployee(req, Employee);
  if (!employee) return { filter, denied: true };
  filter.assignedTo = employee._id;
  return { filter, denied: false };
}

// @desc    Get all tasks (scoped by role)
// @route   GET /api/tasks
// @access  Private
exports.getTasks = async (req, res) => {
  try {
    const { project, status, assignedTo } = req.query;
    const extraFilter = {};
    if (project) extraFilter.project = project;
    if (status) extraFilter.status = status;
    if (assignedTo) extraFilter.assignedTo = assignedTo;

    const models = getModels(req);
    const { filter, denied } = await buildScopedTaskFilter(req, models, extraFilter);
    if (denied) {
      return res.status(200).json({ success: true, data: [] });
    }

    const tasks = await models.Task.find(filter)
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

// @desc    Get tasks for Kanban board (scoped by role)
// @route   GET /api/tasks/board
// @access  Private
exports.getTasksForBoard = async (req, res) => {
  try {
    const { project } = req.query;
    const extraFilter = {};
    if (project) extraFilter.project = project;

    const models = getModels(req);
    const { filter, denied } = await buildScopedTaskFilter(req, models, extraFilter);

    const emptyBoard = { todo: [], 'in-progress': [], review: [], done: [] };
    if (denied) {
      return res.status(200).json({ success: true, data: emptyBoard });
    }

    const tasks = await models.Task.find(filter)
      .populate('project', 'name')
      .populate('assignedTo', 'name email position department')
      .sort({ priority: -1, createdAt: -1 });

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
    const models = getModels(req);
    const { Task, Employee, Project } = models;

    const task = await Task.findOne({
      _id: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    })
      .populate('project', 'name teamLead manager')
      .populate('assignedTo', 'name email position department')
      .populate('createdBy', 'name email');

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    if (req.user.role === 'admin') {
      return res.status(200).json({ success: true, data: task });
    }

    const employee = await resolveActingEmployee(req, Employee);
    if (!employee) {
      return res.status(403).json({ success: false, message: 'Access denied - Employee record not found' });
    }

    if (PROJECT_OWNER_ROLES.includes(req.user.role)) {
      if (!isOwnerOfProject(task.project, employee._id)) {
        return res.status(403).json({ success: false, message: 'Access denied - You do not own this project' });
      }
      return res.status(200).json({ success: true, data: task });
    }

    const assignedIds = Array.isArray(task.assignedTo)
      ? task.assignedTo.map(a => String(a && a._id ? a._id : a))
      : (task.assignedTo ? [String(task.assignedTo._id || task.assignedTo)] : []);
    if (!assignedIds.includes(String(employee._id))) {
      return res.status(403).json({ success: false, message: 'Access denied - You are not assigned to this task' });
    }

    res.status(200).json({ success: true, data: task });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// Shared authorization check used by updateTaskStatus / updateTask / deleteTask /
// addProgressUpdate. Returns { allowed, employee, task } — fetches the task
// with project owner fields populated so ownership can be checked in-memory.
async function authorizeTaskAction(req, models, taskId, { allowAssignee = false } = {}) {
  const { Task, Employee } = models;
  const task = await Task.findOne({
    _id: taskId,
    tenant: req.tenant._id,
    isActive: true
  }).populate('project', 'teamLead manager').populate('assignedTo', 'name');

  if (!task) return { allowed: false, notFound: true };

  if (req.user.role === 'admin') return { allowed: true, task };

  const employee = await resolveActingEmployee(req, Employee);
  if (!employee) return { allowed: false, task };

  if (PROJECT_OWNER_ROLES.includes(req.user.role)) {
    if (isOwnerOfProject(task.project, employee._id)) {
      return { allowed: true, task, employee };
    }
    return { allowed: false, task, employee };
  }

  if (allowAssignee && req.user.role === 'employee') {
    const assignedIds = Array.isArray(task.assignedTo)
      ? task.assignedTo.map(a => String(a && a._id ? a._id : a))
      : (task.assignedTo ? [String(task.assignedTo._id || task.assignedTo)] : []);
    if (assignedIds.includes(String(employee._id))) {
      return { allowed: true, task, employee };
    }
  }

  return { allowed: false, task, employee };
}

// @desc    Update task status (for drag & drop)
// @route   PUT /api/tasks/:id/status
// @access  Private (admin, owning manager/team-lead, or the assigned employee)
exports.updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const models = getModels(req);
    const { Task, Employee, User, Notification } = models;

    const { allowed, task, notFound } = await authorizeTaskAction(req, models, req.params.id, { allowAssignee: true });

    if (notFound) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    task.status = status;
    await task.save();

    const populatedTask = await Task.findById(task._id)
      .populate('project', 'name')
      .populate('assignedTo', 'name email position department');

    await updateProjectProgress(task.project, models);

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
      // ignore, keep default actorLabel
    }

    try {
      const assignedIds = Array.isArray(task.assignedTo)
        ? task.assignedTo.map(a => String(a && a._id ? a._id : a))
        : (task.assignedTo ? [String(task.assignedTo._id || task.assignedTo)] : []);

      let actorId = null;
      if (req.user.role === 'employee') {
        try {
          let actorEmployee = req.user.employee && req.user.employee._id ? req.user.employee : null;
          if (!actorEmployee) {
            actorEmployee = await Employee.findOne({ user: req.user._id });
          }
          actorId = actorEmployee && actorEmployee._id ? String(actorEmployee._id) : null;
        } catch (innerErr) {
          actorId = null;
        }
      }

      // Don't notify whoever just made the change themselves.
      const idsToNotify = assignedIds.filter(aid => aid !== actorId);

      if (idsToNotify.length > 0) {
        const assignedUsers = await User.find({
          employee: { $in: idsToNotify },
          tenant: req.tenant._id,
          isActive: true
        });

        if (assignedUsers.length > 0) {
          await Notification.insertMany(assignedUsers.map(u => ({
            user: u._id,
            employee: u.employee,
            title: 'Task Status Updated',
            message: `By ${actorLabel}: Task "${task.title}" status changed to ${status}`,
            type: 'task-updated',
            relatedEntity: 'task',
            entityId: task._id,
            tenant: req.tenant._id
          })));
        }
      }
    } catch (notificationError) {
      console.error('Failed to create status notification:', notificationError);
    }

    // Notify admins when a non-admin changes a task status
    try {
      if (req.user.role !== 'admin') {
        let actorEmployee = req.user.employee && req.user.employee._id ? req.user.employee : null;
        if (!actorEmployee) {
          actorEmployee = await Employee.findOne({ user: req.user._id });
        }

        let actorName = actorLabel;
        if (actorEmployee) {
          const actorDoc = await Employee.findById(actorEmployee._id);
          actorName = actorDoc?.name || actorName;
        }

        if (actorEmployee) {
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
// @access  Private/Admin, owning Manager/Team Lead
exports.updateTask = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task, User, Notification, Employee } = models;

    const { allowed, task: oldTask, notFound } = await authorizeTaskAction(req, models, req.params.id);
    if (notFound) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // If reassigning, and actor is manager/team-lead, restrict to their own department.
    if (req.body.assignedTo && PROJECT_OWNER_ROLES.includes(req.user.role)) {
      const actingEmployee = await resolveActingEmployee(req, Employee);
      const assigneeError = await validateAssigneesInOwnDepartment(Employee, actingEmployee, req.body.assignedTo);
      if (assigneeError) {
        return res.status(403).json({ success: false, message: assigneeError });
      }
    }

    // Auditing Parts validation — use whatever the request is actually
    // changing, falling back to the existing task's saved values for
    // anything not included in this particular PUT.
    const effectiveWorkType = req.body.workType !== undefined ? req.body.workType : oldTask.workType;
    const effectiveWorkLocation = req.body.workLocation !== undefined ? req.body.workLocation : oldTask.workLocation;
    const effectivePartsCount = req.body.targetPartsCount !== undefined ? req.body.targetPartsCount : oldTask.targetPartsCount;
    const auditingError = missingAuditingFields({
      workType: effectiveWorkType,
      workLocation: effectiveWorkLocation,
      partsCount: effectivePartsCount
    });
    if (auditingError) {
      return res.status(400).json({ success: false, message: auditingError });
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

    // Notify only the newly-added assignees (ids present in the new list
    // but not already on the task) — assignedTo may be a single id or an
    // array, so normalize both the old and new values before diffing.
    try {
      const oldIds = Array.isArray(oldTask.assignedTo)
        ? oldTask.assignedTo.map(a => String(a && a._id ? a._id : a))
        : (oldTask.assignedTo ? [String(oldTask.assignedTo._id || oldTask.assignedTo)] : []);
      const newIds = Array.isArray(req.body.assignedTo)
        ? req.body.assignedTo.map(id => String(id))
        : (req.body.assignedTo ? [String(req.body.assignedTo)] : []);
      const addedIds = newIds.filter(id => !oldIds.includes(id));

      if (addedIds.length > 0) {
        const assignedUsers = await User.find({
          employee: { $in: addedIds },
          tenant: req.tenant._id,
          isActive: true
        });

        if (assignedUsers.length > 0) {
          await Notification.insertMany(assignedUsers.map(u => ({
            user: u._id,
            employee: u.employee,
            title: 'Task Reassigned',
            message: `Task "${task.title}" has been assigned to you`,
            type: 'task-assigned',
            relatedEntity: 'task',
            entityId: task._id,
            tenant: req.tenant._id
          })));
        }
      }
    } catch (notificationError) {
      console.error('Failed to create reassignment notification:', notificationError);
    }

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
// @access  Private/Admin, owning Manager/Team Lead
exports.deleteTask = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task } = models;

    const { allowed, task: existingTask, notFound } = await authorizeTaskAction(req, models, req.params.id);
    if (notFound) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const hard = String(req.query.hard || '').toLowerCase() === 'true';

    let task;
    if (hard) {
      task = await Task.findOneAndDelete({ _id: req.params.id, tenant: req.tenant._id });
    } else {
      task = await Task.findOneAndUpdate(
        { _id: req.params.id, tenant: req.tenant._id },
        { isActive: false },
        { new: true }
      );
    }

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    await updateProjectProgress(existingTask.project, models);

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

// ─────────────────────────────────────────────────────────────────────────
// PROGRESS TRACKING
// ─────────────────────────────────────────────────────────────────────────

// @desc    Add a progress update to a task
// @route   POST /api/tasks/:id/progress
// @access  Private (admin, owning manager/team-lead, or the assigned employee)
exports.addProgressUpdate = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task, Notification, User, Employee } = models;
    const { progress, note, partsCount, reportedLocation } = req.body;

    if (progress === undefined || progress === null) {
      return res.status(400).json({ success: false, message: 'Progress is required' });
    }
    if (!note || !String(note).trim()) {
      return res.status(400).json({ success: false, message: 'A note describing the work done is required' });
    }

    const { allowed, task, notFound } = await authorizeTaskAction(req, models, req.params.id, { allowAssignee: true });
    if (notFound) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Auditing Parts tasks require a location + parts count on every daily
    // progress update, not just at task creation — whoever is logging
    // progress (assignee, or the owning manager/team-lead on their behalf)
    // must fill these in.
    const auditingError = missingAuditingFields({
      workType: task.workType,
      workLocation: reportedLocation,
      partsCount
    });
    if (auditingError) {
      return res.status(400).json({ success: false, message: auditingError });
    }

    const update = {
      date: new Date(),
      progress: Number(progress),
      note: String(note).trim(),
      userId: req.user._id
    };
    if (partsCount !== undefined && partsCount !== null && partsCount !== '') {
      update.partsCount = Number(partsCount);
    }
    if (reportedLocation && (reportedLocation.city || reportedLocation.pincode)) {
      update.reportedLocation = {
        city: reportedLocation.city || '',
        pincode: reportedLocation.pincode || ''
      };
    }

    task.updates.push(update);
    task.progress = Number(progress);
    task.lastUpdated = new Date();
    await task.save();

    await updateProjectProgress(task.project, models);

    // Notify admins + task owner (manager/team-lead) when an employee logs progress
    try {
      if (req.user.role === 'employee') {
        const project = await models.Project.findById(task.project).select('teamLead manager name');
        const recipients = [];

        const adminUsers = await User.find({ role: 'admin', tenant: req.tenant._id, isActive: true });
        recipients.push(...adminUsers);

        if (project) {
          const ownerEmployeeId = project.teamLead || project.manager;
          if (ownerEmployeeId) {
            const ownerUser = await User.findOne({ employee: ownerEmployeeId, tenant: req.tenant._id, isActive: true });
            if (ownerUser) recipients.push(ownerUser);
          }
        }

        const actorEmployee = req.user.employee?.name
          ? req.user.employee
          : await Employee.findOne({ user: req.user._id });

        const notifications = recipients
          .filter((u, idx, arr) => arr.findIndex(x => String(x._id) === String(u._id)) === idx)
          .map(u => ({
            user: u._id,
            employee: actorEmployee?._id || null,
            title: 'Task Progress Updated',
            message: `${actorEmployee?.name || 'An employee'} logged ${progress}% progress on "${task.title}"`,
            type: 'task-updated',
            relatedEntity: 'task',
            entityId: task._id,
            tenant: req.tenant._id
          }));

        if (notifications.length > 0) {
          await Notification.insertMany(notifications);
        }
      }
    } catch (notifyErr) {
      console.error('Failed to notify about progress update:', notifyErr);
    }

    const populatedTask = await Task.findById(task._id)
      .populate('updates.userId', 'name email role')
      .populate('project', 'name');

    res.status(201).json({
      success: true,
      data: {
        progress: populatedTask.progress,
        updates: populatedTask.updates.slice().sort((a, b) => new Date(b.date) - new Date(a.date))
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Get progress update history for a task
// @route   GET /api/tasks/:id/progress
// @access  Private (admin, owning manager/team-lead, or the assigned employee)
exports.getTaskProgress = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task } = models;

    const { allowed, notFound } = await authorizeTaskAction(req, models, req.params.id, { allowAssignee: true });
    if (notFound) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const task = await Task.findById(req.params.id)
      .populate('updates.userId', 'name email role')
      .select('updates progress title');

    res.status(200).json({
      success: true,
      data: {
        progress: task.progress,
        updates: task.updates.slice().sort((a, b) => new Date(b.date) - new Date(a.date))
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Get the current user's own progress updates logged today
// @route   GET /api/tasks/my-updates/today
// @access  Private
exports.getTodayUpdates = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task, Employee } = models;

    const employee = await resolveActingEmployee(req, Employee);
    if (!employee) {
      return res.status(200).json({ success: true, data: [] });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrow = new Date(todayStart);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Scope task lookup to this employee's own assigned tasks (employees can
    // only log/see progress on their own tasks; admins/leads use the admin listing instead).
    const taskFilter = { tenant: req.tenant._id, isActive: true };
    if (req.user.role === 'employee') {
      taskFilter.assignedTo = employee._id;
    }

    const tasks = await Task.find(taskFilter).select('title project updates').populate('project', 'name');

    const todayUpdates = [];
    tasks.forEach(task => {
      task.updates.forEach(u => {
        if (String(u.userId) === String(req.user._id) && u.date >= todayStart && u.date < tomorrow) {
          todayUpdates.push({
            taskId: task._id,
            taskTitle: task.title,
            project: task.project,
            ...u.toObject()
          });
        }
      });
    });

    res.status(200).json({ success: true, data: todayUpdates });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    List/search progress updates across tasks, with pagination.
//          Admin sees every project in the tenant. Manager/team-lead see
//          this same report scoped to only the projects they own (their
//          "everyone on my team" progress view). Employees never reach
//          this endpoint (blocked at the route level).
// @route   GET /api/tasks/progress
// @access  Private/Admin, Manager, Team Lead (scoped)
exports.listProgressAdmin = async (req, res) => {
  try {
    const models = getModels(req);
    const { Task, Employee, Project } = models;
    const {
      project, employee, from, to, minProgress, maxProgress,
      page = 1, limit = 25, sort = 'date'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 25);
    const emptyResult = { success: true, data: [], total: 0, page: pageNum, limit: limitNum };

    const matchStage = {
      tenant: new mongoose.Types.ObjectId(req.tenant._id),
      isActive: true
    };

    if (req.user.role === 'admin') {
      if (project) matchStage.project = new mongoose.Types.ObjectId(project);
    } else if (PROJECT_OWNER_ROLES.includes(req.user.role)) {
      // Scope manager/team-lead down to only the projects they own —
      // never let them page through another lead's team via this report.
      const actingEmployee = await resolveActingEmployee(req, Employee);
      if (!actingEmployee) {
        return res.status(200).json(emptyResult);
      }
      const ownedProjectIds = await getOwnedProjectIds(Project, req.tenant._id, actingEmployee._id);
      if (project) {
        const owns = ownedProjectIds.some(id => String(id) === String(project));
        if (!owns) {
          return res.status(200).json(emptyResult);
        }
        matchStage.project = new mongoose.Types.ObjectId(project);
      } else {
        if (!ownedProjectIds.length) {
          return res.status(200).json(emptyResult);
        }
        matchStage.project = { $in: ownedProjectIds };
      }
    } else {
      // Defensive fallback — the route itself already blocks employees
      // from reaching this endpoint.
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const pipeline = [
      { $match: matchStage },
      { $unwind: '$updates' }
    ];

    const postMatch = {};
    if (from || to) {
      postMatch['updates.date'] = {};
      if (from) postMatch['updates.date'].$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        postMatch['updates.date'].$lte = toDate;
      }
    }
    if (minProgress !== undefined && minProgress !== '') {
      postMatch['updates.progress'] = { ...(postMatch['updates.progress'] || {}), $gte: Number(minProgress) };
    }
    if (maxProgress !== undefined && maxProgress !== '') {
      postMatch['updates.progress'] = { ...(postMatch['updates.progress'] || {}), $lte: Number(maxProgress) };
    }
    if (Object.keys(postMatch).length > 0) {
      pipeline.push({ $match: postMatch });
    }

    pipeline.push(
      {
        $lookup: {
          from: 'projects',
          localField: 'project',
          foreignField: '_id',
          as: 'projectDoc'
        }
      },
      { $unwind: { path: '$projectDoc', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'updates.userId',
          foreignField: '_id',
          as: 'userDoc'
        }
      },
      { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'employees',
          localField: 'userDoc.employee',
          foreignField: '_id',
          as: 'employeeDoc'
        }
      },
      { $unwind: { path: '$employeeDoc', preserveNullAndEmptyArrays: true } }
    );

    if (employee) {
      const isObjectId = mongoose.Types.ObjectId.isValid(employee);
      pipeline.push({
        $match: isObjectId
          ? { 'employeeDoc._id': new mongoose.Types.ObjectId(employee) }
          : { 'employeeDoc.name': { $regex: employee, $options: 'i' } }
      });
    }

    pipeline.push({
      $project: {
        _id: '$updates._id',
        taskId: '$_id',
        taskTitle: '$title',
        project: { _id: '$projectDoc._id', name: '$projectDoc.name' },
        employee: { _id: '$employeeDoc._id', name: '$employeeDoc.name' },
        user: { _id: '$userDoc._id', email: '$userDoc.email' },
        date: '$updates.date',
        progress: '$updates.progress',
        note: '$updates.note',
        reportedLocation: '$updates.reportedLocation',
        partsCount: '$updates.partsCount'
      }
    });

    const sortField = sort === 'progress' ? { progress: -1 } : { date: -1 };
    pipeline.push({ $sort: sortField });

    pipeline.push({
      $facet: {
        rows: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }],
        totalCount: [{ $count: 'count' }]
      }
    });

    const result = await Task.aggregate(pipeline);
    const rows = result[0]?.rows || [];
    const total = result[0]?.totalCount?.[0]?.count || 0;

    res.status(200).json({
      success: true,
      data: rows,
      total,
      page: pageNum,
      limit: limitNum
    });
  } catch (error) {
    console.error('listProgressAdmin error:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

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