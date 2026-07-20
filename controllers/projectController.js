const mongoose = require('mongoose');
const DefaultEmployee = require('../models/Employee');
const DefaultProject = require('../models/Project');
const DefaultTask = require('../models/Task');
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
  Project: resolveModel(req, 'Project', DefaultProject),
  Task: resolveModel(req, 'Task', DefaultTask),
  Notification: resolveModel(req, 'Notification', DefaultNotification),
  User: resolveModel(req, 'User', DefaultUser),
});

// Roles that "own" a project (create/edit tasks under it) rather than just
// admin (sees everything) or employee (sees only what they're assigned to).
const PROJECT_OWNER_ROLES = ['manager', 'team-lead'];

// ── Populate helpers ────────────────────────────────────────────────────
// Manager/Team Lead are always populated the same way everywhere a project
// is returned to the frontend.
//
// NOTE: `role` is still selected here for backwards compatibility with any
// other reader of this data, but it should NOT be trusted as the source of
// truth for "is this person a Manager or a Team Lead". Employee.role is a
// legacy/loosely-maintained field. The actual source of truth — the same
// one createProject/updateProject already validate against — is
// User.role, looked up via `User.findOne({ employee: <employeeId> })`.
// `attachOwnerRoles` below overwrites `role`/`roleLabel` on the populated
// manager/teamLead with the correct value from User before the response
// goes out, so the frontend never has to guess.
const OWNER_POPULATE_FIELDS = [
  { path: 'teamLead', select: 'name email position department role' },
  { path: 'manager', select: 'name email position department role' }
];

const ROLE_LABELS = {
  'team-lead': 'Team Lead',
  manager: 'Manager'
};

// Given one populated project doc (or an array of them), look up the real
// User.role for whichever employees are set as manager/teamLead, and stamp
// an accurate `role` + `roleLabel` onto each. Returns plain object(s),
// never mongoose documents, since the response is about to be JSON-ified.
const attachOwnerRoles = async (req, projectOrProjects) => {
  const { User } = getModels(req);
  const isArray = Array.isArray(projectOrProjects);
  const projects = (isArray ? projectOrProjects : [projectOrProjects]).filter(Boolean);

  const toPlain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

  // Collect every distinct employee id referenced as manager/teamLead
  // across all projects so we only hit the DB once.
  const employeeIds = new Set();
  projects.forEach((p) => {
    const teamLeadId = p.teamLead && (p.teamLead._id || p.teamLead);
    const managerId = p.manager && (p.manager._id || p.manager);
    if (teamLeadId) employeeIds.add(String(teamLeadId));
    if (managerId) employeeIds.add(String(managerId));
  });

  let roleByEmployeeId = {};
  if (employeeIds.size > 0) {
    const users = await User.find({
      employee: { $in: Array.from(employeeIds) },
      tenant: req.tenant._id
    }).select('employee role');

    roleByEmployeeId = users.reduce((acc, u) => {
      if (u.employee) acc[String(u.employee)] = u.role;
      return acc;
    }, {});
  }

  const decoratePerson = (personDoc) => {
    const person = toPlain(personDoc);
    if (!person) return person;
    const empId = String(person._id || '');
    const role = roleByEmployeeId[empId] || '';
    return {
      ...person,
      role,
      roleLabel: ROLE_LABELS[role] || ''
    };
  };

  const decorated = projects.map((p) => {
    const proj = toPlain(p);
    return {
      ...proj,
      teamLead: decoratePerson(proj.teamLead),
      manager: decoratePerson(proj.manager)
    };
  });

  if (!isArray) return decorated[0] || null;

  // Preserve original array positions in case any input entries were falsy
  // (shouldn't normally happen since we .filter(Boolean) above, but keeps
  // this safe for callers that assume index-parity).
  return decorated;
};

// Resolve the Employee document for the currently authenticated user.
// Prefers req.user.employee populated by auth middleware, falls back to a
// lookup. Returns null if no employee record exists.
const resolveActingEmployee = async (req, Employee) => {
  if (req.user.employee && req.user.employee._id) return req.user.employee;
  return Employee.findOne({ user: req.user._id });
};

// Returns true if the given employeeId is the teamLead or manager on the
// project. Shared by getProject's access check and setProjectProgress
// below — kept local to this controller (taskController.js has its own
// copy for the same reason: avoiding a cross-controller import for a
// three-line helper).
const isOwnerOfProject = (project, employeeId) => {
  if (!project || !employeeId) return false;
  const empId = String(employeeId);
  const teamLeadId = project.teamLead?._id ? String(project.teamLead._id) : String(project.teamLead || '');
  const managerId = project.manager?._id ? String(project.manager._id) : String(project.manager || '');
  return empId === teamLeadId || empId === managerId;
};

// NEW: an employee can have visibility into a project purely because they
// have a task assigned to them on it — even if an admin never added them to
// project.assignedEmployees. This is now the norm: tasks are assigned
// directly via Task.assignedTo, and assignedEmployees is not kept in sync
// with that. Both getProjects (list) and getProject (single) need to treat
// "has a task on this project" as equivalent to "is assigned to this
// project" for an employee.
const getProjectIdsWithEmployeeTasks = async (Task, tenantId, employeeId) => {
  const ids = await Task.find({
    tenant: tenantId,
    assignedTo: employeeId,
    isActive: true
  }).distinct('project');
  return ids.map((id) => String(id));
};

// @desc    Create a new project
// @route   POST /api/projects
// @access  Private/Admin
exports.createProject = async (req, res) => {
  try {
    const { Project, Notification, Employee, User } = getModels(req);
    const { name, description, department, startDate, endDate, assignedEmployees, teamLead, manager, status } = req.body;

    if (!teamLead) {
      return res.status(400).json({
        success: false,
        message: 'A team lead must be assigned to this project'
      });
    }

    // Validate teamLead exists, belongs to this tenant's employee pool, and
    // is actually a manager/team-lead (not a plain employee or admin).
    const teamLeadEmployee = await Employee.findOne({ _id: teamLead, isActive: true });
    if (!teamLeadEmployee) {
      return res.status(400).json({ success: false, message: 'Selected team lead was not found or is inactive' });
    }
    const teamLeadUser = await User.findOne({ employee: teamLeadEmployee._id, tenant: req.tenant._id, isActive: true });
    if (!teamLeadUser || !PROJECT_OWNER_ROLES.includes(teamLeadUser.role)) {
      return res.status(400).json({ success: false, message: 'Selected employee is not a Manager or Team Lead' });
    }

    // manager field is optional; if provided, sanity-check it too
    if (manager) {
      const managerEmployee = await Employee.findOne({ _id: manager, isActive: true });
      if (!managerEmployee) {
        return res.status(400).json({ success: false, message: 'Selected manager was not found or is inactive' });
      }
    }

    if (!department || !String(department).trim()) {
      return res.status(400).json({ success: false, message: 'Department is required' });
    }

    // NOTE: creation is admin-only (enforced at the route level via
    // authorize('admin')). The block that used to restrict a non-admin
    // creator to only assigning themselves as owner has been removed since
    // it can never be reached now — only admins reach this controller.
    // Left out deliberately rather than kept as dead code.

    const project = await Project.create({
      name,
      description,
      department: String(department).trim(),
      startDate,
      endDate,
      assignedEmployees,
      teamLead,
      manager: manager || null,
      status: status || 'active',
      tenant: req.tenant._id,
      createdBy: req.user._id
    });

    // Create notifications for assigned employees (use their User account as recipient)
    if (assignedEmployees && assignedEmployees.length > 0) {
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

      try {
        await Promise.all(notificationPromises);
      } catch (err) {
        console.warn('One or more project assignment notifications failed', err && err.message ? err.message : err);
      }
    }

    // Notify the team lead they now own this project
    try {
      if (teamLeadUser) {
        await Notification.create({
          user: teamLeadUser._id,
          employee: teamLeadEmployee._id,
          title: 'Project Assigned To You',
          message: `You have been made the team lead for project: ${name}. You can now create and assign tasks.`,
          type: 'project-assigned',
          relatedEntity: 'project',
          entityId: project._id,
          tenant: req.tenant._id
        });
      }
    } catch (err) {
      console.warn('Failed to notify team lead of project assignment', err && err.message ? err.message : err);
    }

    const populatedProject = await Project.findById(project._id)
      .populate('assignedEmployees', 'name email position department isActive')
      .populate(OWNER_POPULATE_FIELDS)
      .populate('createdBy', 'name email');

    const projectWithRoles = await attachOwnerRoles(req, populatedProject);

    res.status(201).json({
      success: true,
      data: projectWithRoles
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get all projects for tenant (scoped by role)
// @route   GET /api/projects
// @access  Private
exports.getProjects = async (req, res) => {
  try {
    const { Project, Employee, Task } = getModels(req);
    const { status, department } = req.query;
    let filter = { tenant: req.tenant._id, isActive: true };

    if (status) {
      filter.status = status;
    }

    // Admin: sees everything, optionally narrowed by department dropdown.
    if (req.user.role === 'admin') {
      if (department) {
        filter.department = department;
      }
    }

    // Manager / Team Lead: only the project(s) they own.
    else if (PROJECT_OWNER_ROLES.includes(req.user.role)) {
      const employee = await resolveActingEmployee(req, Employee);
      if (!employee) {
        return res.status(200).json({ success: true, data: [] });
      }
      filter.$or = [{ teamLead: employee._id }, { manager: employee._id }];
      if (department) {
        filter.department = department;
      }
    }

    // Employee: projects they're explicitly assigned to, OR projects where
    // they have at least one task assigned to them. Task assignment is the
    // normal path now (a task can be created for someone without ever
    // touching project.assignedEmployees), so both must be honored or an
    // employee's own project list silently misses projects they work on.
    else if (req.user.role === 'employee') {
      const employee = await resolveActingEmployee(req, Employee);
      if (employee) {
        const taskProjectIds = await getProjectIdsWithEmployeeTasks(Task, req.tenant._id, employee._id);
        filter.$or = [
          { assignedEmployees: employee._id },
          { _id: { $in: taskProjectIds } }
        ];
      } else {
        return res.status(200).json({ success: true, data: [] });
      }
    }

    const projects = await Project.find(filter)
      .populate('assignedEmployees', 'name email position department isActive')
      .populate(OWNER_POPULATE_FIELDS)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    const projectsWithRoles = await attachOwnerRoles(req, projects);

    res.status(200).json({
      success: true,
      data: projectsWithRoles
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get distinct departments that currently have projects (for admin filter dropdown)
// @route   GET /api/projects/departments
// @access  Private/Admin
exports.getProjectDepartments = async (req, res) => {
  try {
    const { Project } = getModels(req);
    const departments = await Project.distinct('department', {
      tenant: req.tenant._id,
      isActive: true
    });
    res.status(200).json({
      success: true,
      data: departments.filter(Boolean).sort()
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Get single project
// @route   GET /api/projects/:id
// @access  Private
exports.getProject = async (req, res) => {
  try {
    const { Project, Employee, Task } = getModels(req);

    const project = await Project.findOne({
      _id: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    })
      .populate('assignedEmployees', 'name email position department user isActive')
      .populate(OWNER_POPULATE_FIELDS)
      .populate('createdBy', 'name email')
      // Admin-only "Progress Updates" history view in ProjectDetails.jsx
      // needs to show who logged each manual entry, as "name(role)" (or
      // just "Admin" if that account has no name set). Simple single-level
      // populate — same pattern taskController.js already uses successfully
      // for 'updates.userId'. (A nested sub-populate into Employee was
      // tried here and removed — populating a nested field inside an
      // array-of-subdocuments path doesn't reliably work, and silently
      // left userId as an unpopulated ObjectId instead of erroring.)
      .populate('progressUpdates.userId', 'name email role');

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (req.user.role === 'admin') {
      const projectWithRoles = await attachOwnerRoles(req, project);
      return res.status(200).json({ success: true, data: projectWithRoles });
    }

    const employee = await resolveActingEmployee(req, Employee);
    if (!employee) {
      return res.status(403).json({
        success: false,
        message: 'Access denied - Employee record not found'
      });
    }
    const empId = String(employee._id);

    if (PROJECT_OWNER_ROLES.includes(req.user.role)) {
      const teamLeadId = project.teamLead?._id ? String(project.teamLead._id) : String(project.teamLead || '');
      const managerId = project.manager?._id ? String(project.manager._id) : String(project.manager || '');
      if (empId !== teamLeadId && empId !== managerId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied - This project is not assigned to you'
        });
      }
      const projectWithRoles = await attachOwnerRoles(req, project);
      return res.status(200).json({ success: true, data: projectWithRoles });
    }

    // employee role
    const isAssigned = project.assignedEmployees.some((assignedEmp) => {
      const assignedId = assignedEmp._id ? String(assignedEmp._id) : String(assignedEmp);
      return assignedId === empId;
    });

    // NEW: fall back to "do I have a task on this project" when not
    // explicitly listed in assignedEmployees — see
    // getProjectIdsWithEmployeeTasks comment above for why this is needed.
    let hasTaskOnProject = false;
    if (!isAssigned) {
      const taskCount = await Task.countDocuments({
        tenant: req.tenant._id,
        project: project._id,
        assignedTo: employee._id,
        isActive: true
      });
      hasTaskOnProject = taskCount > 0;
    }

    if (!isAssigned && !hasTaskOnProject) {
      return res.status(403).json({
        success: false,
        message: 'Access denied - You are not assigned to this project'
      });
    }

    const projectWithRoles = await attachOwnerRoles(req, project);

    res.status(200).json({
      success: true,
      data: projectWithRoles
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
    const { Project, Employee, User } = getModels(req);
    const updateBody = { ...req.body };

    // Look the project up first — needed so we still 404 correctly before
    // touching anything else.
    const existingProject = await Project.findOne({
      _id: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    });

    if (!existingProject) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // NOTE: this route is admin-only (enforced via authorize('admin') at
    // the route level), so the non-admin ownership-restriction branch that
    // used to live here has been removed as unreachable dead code.

    // If teamLead is being changed, re-validate it the same way createProject does.
    if (updateBody.teamLead) {
      const teamLeadEmployee = await Employee.findOne({ _id: updateBody.teamLead, isActive: true });
      if (!teamLeadEmployee) {
        return res.status(400).json({ success: false, message: 'Selected team lead was not found or is inactive' });
      }
      const teamLeadUser = await User.findOne({ employee: teamLeadEmployee._id, tenant: req.tenant._id, isActive: true });
      if (!teamLeadUser || !PROJECT_OWNER_ROLES.includes(teamLeadUser.role)) {
        return res.status(400).json({ success: false, message: 'Selected employee is not a Manager or Team Lead' });
      }
    }

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        tenant: req.tenant._id,
        isActive: true
      },
      updateBody,
      { new: true, runValidators: true }
    )
      .populate('assignedEmployees', 'name email position department isActive')
      .populate(OWNER_POPULATE_FIELDS)
      .populate('createdBy', 'name email');

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const projectWithRoles = await attachOwnerRoles(req, project);

    res.status(200).json({
      success: true,
      data: projectWithRoles
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

// @desc    Get project progress (recalculates from task completion —
//          "automatic" side of progress tracking)
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

// @desc    Manually set project progress (the "manual" side of progress
//          tracking, alongside the automatic task-based calculation
//          above). Whichever of the two happens most recently wins — this
//          does not disable or replace the automatic recalculation; the
//          next task create/update/status-change will still overwrite
//          `progress` via taskController.js's updateProjectProgress().
//          Deliberately minimal: just a percentage + optional note, no
//          task, no location, no parts count — those belong to task-level
//          progress (AddProgressModal.jsx), not project-level.
// @route   PUT /api/projects/:id/progress
// @access  Private/Admin, or the project's owning Manager/Team Lead
exports.setProjectProgress = async (req, res) => {
  try {
    const { Project, Employee } = getModels(req);
    const { progress, note } = req.body;

    if (progress === undefined || progress === null || progress === '') {
      return res.status(400).json({ success: false, message: 'Progress is required' });
    }
    const progressNum = Number(progress);
    if (Number.isNaN(progressNum) || progressNum < 0 || progressNum > 100) {
      return res.status(400).json({ success: false, message: 'Progress must be a number between 0 and 100' });
    }
    if (!note || !String(note).trim()) {
      return res.status(400).json({ success: false, message: 'A note describing this progress update is required' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      tenant: req.tenant._id,
      isActive: true
    });

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    if (req.user.role !== 'admin') {
      if (!PROJECT_OWNER_ROLES.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const actingEmployee = await resolveActingEmployee(req, Employee);
      if (!actingEmployee || !isOwnerOfProject(project, actingEmployee._id)) {
        return res.status(403).json({ success: false, message: 'Access denied - You do not own this project' });
      }
    }

    project.progress = progressNum;
    project.progressUpdates.push({
      date: new Date(),
      progress: progressNum,
      note: String(note).trim(),
      userId: req.user._id
    });

    await project.save();

    res.status(200).json({
      success: true,
      data: {
        progress: project.progress,
        progressUpdates: project.progressUpdates.slice().sort((a, b) => new Date(b.date) - new Date(a.date))
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Exported for reuse by taskController's authorization checks
exports.PROJECT_OWNER_ROLES = PROJECT_OWNER_ROLES;
exports.resolveActingEmployee = resolveActingEmployee;
exports.attachOwnerRoles = attachOwnerRoles;
exports.getProjectIdsWithEmployeeTasks = getProjectIdsWithEmployeeTasks;