const mongoose = require('mongoose');
const DefaultTask = require('../models/Task');
const DefaultUser = require('../models/User');
const DefaultEmployee = require('../models/Employee');

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

const getModels = (req) => ({
  Task: resolveModel(req, 'Task', DefaultTask),
  User: resolveModel(req, 'User', DefaultUser),
  Employee: resolveModel(req, 'Employee', DefaultEmployee),
});

// @desc    List progress updates across tasks (admin-friendly)
// @route   GET /api/tasks/progress
// @access  Private
exports.listProgress = async (req, res) => {
  try {
    const { Task, User, Employee } = getModels(req);

    const tenantId = req.tenant._id;
    const {
      project,
      user,
      from,
      to,
      status,
      minProgress,
      maxProgress,
      page = 1,
      limit = 25,
      sort = '-date'
    } = req.query;

    const match = { tenant: tenantId, isActive: true };
    if (project) {
      try {
        match.project = mongoose.Types.ObjectId(project);
      } catch (projErr) {
        // Ignoring invalid project id filter. Previously logged:
        // console.warn('listProgress: invalid project id filter, ignoring project filter:', project);
      }
    }

    console.debug('listProgress params:', { project, employee: req.query.employee, user, from, to, minProgress, maxProgress, page, limit, sort });
    console.debug('listProgress initial match:', match);
    try {
      console.debug('listProgress project param (raw):', project, 'resolved match.project:', match.project ? String(match.project) : null);
    } catch (e) {
      console.debug('listProgress project debug failed:', e && e.message ? e.message : e);
    }

    const pipeline = [
      { $match: match },
      { $unwind: '$updates' },
      { $replaceRoot: { newRoot: { $mergeObjects: [ '$updates', { taskId: '$_id', taskTitle: '$title', project: '$project' } ] } } }
    ];

    const and = [];
    // Support filtering by employee (preferred) or user id/username
    if (req.query.employee) {
      const employeeParam = req.query.employee;
      let matchedEmployeeIds = [];
      try {
        matchedEmployeeIds = [ mongoose.Types.ObjectId(employeeParam) ];
      } catch (e) {
        // not an ObjectId - treat as name search
        try {
          // Try tenant-scoped employee name search first, but fall back to tenant-agnostic search
          let emps = await Employee.find({ tenant: tenantId, name: { $regex: employeeParam, $options: 'i' } }, { _id: 1 }).lean();
          if ((!emps || emps.length === 0)) {
            // fallback: some employee records may not have tenant field; try without tenant constraint
            emps = await Employee.find({ name: { $regex: employeeParam, $options: 'i' } }, { _id: 1 }).lean();
          }
          if (emps && emps.length) matchedEmployeeIds = emps.map(e => e._id);
        } catch (innerErr) {
          console.error('employee lookup error:', innerErr && innerErr.message ? innerErr.message : innerErr);
          return res.status(500).json({ success: false, message: 'Server Error' });
        }
      }

      if (!matchedEmployeeIds.length) {
        return res.json({ success: true, total: 0, page: parseInt(page), limit: parseInt(limit), data: [] });
      }

      // find users linked to those employees
      let usersForEmps = [];
      try {
        usersForEmps = await User.find({ employee: { $in: matchedEmployeeIds } }, { _id: 1 }).lean();
      } catch (uErr) {
        console.error('user lookup by employee error:', uErr && uErr.message ? uErr.message : uErr);
        return res.status(500).json({ success: false, message: 'Server Error' });
      }

      const matchedUserIds = usersForEmps.map(u => u._id);
      if (matchedUserIds.length) and.push({ userId: { $in: matchedUserIds } });
      else return res.json({ success: true, total: 0, page: parseInt(page), limit: parseInt(limit), data: [] });
    } else if (user) {
      // Support filtering by user id OR username (partial, case-insensitive)
      // try ObjectId first
      let matchedUserIds = [];
      try {
        matchedUserIds = [ mongoose.Types.ObjectId(user) ];
      } catch (e) {
        // not an ObjectId - treat as username search
        const usersFound = await User.find({ tenant: tenantId, name: { $regex: user, $options: 'i' } }, { _id: 1 }).lean();
        if (usersFound && usersFound.length) {
          matchedUserIds = usersFound.map(u => u._id);
        } else {
          // no users match the username - return empty result
          return res.json({ success: true, total: 0, page: parseInt(page), limit: parseInt(limit), data: [] });
        }
      }

      if (matchedUserIds.length) {
        and.push({ userId: { $in: matchedUserIds } });
      }
    }
    if (from) {
      const f = new Date(from); f.setHours(0,0,0,0); and.push({ date: { $gte: f } });
    }
    if (to) {
      const t = new Date(to); t.setHours(23,59,59,999); and.push({ date: { $lte: t } });
    }
    if (minProgress) and.push({ progress: { $gte: parseInt(minProgress) } });
    if (maxProgress) and.push({ progress: { $lte: parseInt(maxProgress) } });
    if (and.length) pipeline.push({ $match: { $and: and } });

    // count total
    const countPipeline = pipeline.concat([{ $count: 'total' }]);
    const countRes = await Task.aggregate(countPipeline);
    const total = countRes[0]?.total || 0;

    // sorting
    const sortObj = {};
    const dir = sort.startsWith('-') ? -1 : 1;
    const key = sort.replace(/^-/, '');
    sortObj[key] = dir;

    pipeline.push({ $sort: sortObj });
    pipeline.push({ $skip: (parseInt(page) - 1) * parseInt(limit) });
    pipeline.push({ $limit: parseInt(limit) });

    // populate userId and project
    pipeline.push({
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'user'
      }
    });
    pipeline.push({ $unwind: { path: '$user', preserveNullAndEmptyArrays: true } });
    // lookup employee record linked to the user: prefer User.employee, fallback to matching employee.email == user.email
    pipeline.push({
      $lookup: {
        from: 'employees',
        let: { empId: '$user.employee', userEmail: '$user.email' },
        pipeline: [
          { $match: { $expr: { $or: [ { $eq: ['$_id', '$$empId'] }, { $eq: ['$email', '$$userEmail'] } ] } } },
          { $project: { name: 1, email: 1 } }
        ],
        as: 'employee'
      }
    });
    pipeline.push({ $unwind: { path: '$employee', preserveNullAndEmptyArrays: true } });
    pipeline.push({
      $lookup: {
        from: 'projects',
        localField: 'project',
        foreignField: '_id',
        as: 'projectDoc'
      }
    });
    pipeline.push({ $unwind: { path: '$projectDoc', preserveNullAndEmptyArrays: true } });

    let rows;
    try {
      rows = await Task.aggregate(pipeline);
      // debug: log a sample aggregated row to help diagnose missing employee names
      if (rows && rows.length) console.debug('listProgress sample row:', rows[0]);
        try {
          const distinctProjects = Array.from(new Set(rows.map(r => String((r.projectDoc && r.projectDoc._id) || r.project || ''))));
          console.debug('listProgress returned project ids:', distinctProjects);
          const projNames = rows.map(r => (r.projectDoc && r.projectDoc.name) || null).filter(Boolean);
          console.debug('listProgress returned project names sample:', projNames.slice(0,5));
        } catch (e) {
          console.debug('listProgress post-rows debug failed:', e && e.message ? e.message : e);
        }
    } catch (aggErr) {
      try {
        const summary = pipeline.map((s, i) => ({ idx: i, op: Object.keys(s)[0] }));
        console.error('Task.aggregate failed. pipeline summary:', summary);
      } catch (summErr) {
        console.error('Task.aggregate failed and pipeline summary could not be built');
      }
      console.error('Task.aggregate error:', aggErr && aggErr.stack ? aggErr.stack : aggErr);
      throw aggErr; // let outer catch return 500
    }

    // map to friendly shape
    const data = rows.map(r => ({
      _id: r._id,
      updateId: r._id,
      taskId: r.taskId,
      taskTitle: r.taskTitle,
      project: r.projectDoc ? { _id: r.projectDoc._id, name: r.projectDoc.name } : (r.project || null),
      progress: r.progress,
      note: r.note,
      date: r.date,
      user: r.user ? { _id: r.user._id, name: r.user.name, email: r.user.email } : null,
      employee: r.employee ? { name: r.employee.name } : null
    }));

    // include debug info when requested by client
    if (req.query && (req.query._debug === '1' || req.query._debug === 'true')) {
      const returnedProjectIds = Array.from(new Set(rows.map(r => String((r.projectDoc && r.projectDoc._id) || r.project || ''))));
      const returnedProjectNames = Array.from(new Set(rows.map(r => (r.projectDoc && r.projectDoc.name) || null))).filter(Boolean);
      const debugInfo = {
        matchedProject: match.project ? String(match.project) : null,
        returnedProjectIds,
        returnedProjectNames
      };
      return res.json({ success: true, total, page: parseInt(page), limit: parseInt(limit), data, debug: debugInfo });
    }

    return res.json({ success: true, total, page: parseInt(page), limit: parseInt(limit), data });
  } catch (err) {
    console.error('listProgress error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// @desc    Add progress update to task
// @route   POST /api/tasks/:taskId/progress
// @access  Private
exports.addProgressUpdate = async (req, res) => {
  try {
    const { Task } = getModels(req);
    const { progress, note } = req.body;

    // Basic validation
    if (progress === undefined || progress === null || isNaN(parseInt(progress))) {
      return res.status(400).json({ success: false, message: 'Progress must be a number between 0 and 100' });
    }
    if (!note || String(note).trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Note is required' });
    }

    const task = await Task.findOne({
      _id: req.params.taskId,
      tenant: req.tenant._id,
      isActive: true
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    // Only allow one update per user per task per day — update existing today's entry if present
    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);
    const tomorrow = new Date(todayStart);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existingIndex = task.updates.findIndex(u => {
      try {
        const d = new Date(u.date);
        return String(u.userId) === String(req.user._id) && d >= todayStart && d < tomorrow;
      } catch (e) {
        return false;
      }
    });

    if (existingIndex >= 0) {
      // Update today's existing update
      task.updates[existingIndex].progress = parseInt(progress);
      task.updates[existingIndex].note = String(note).trim();
      task.updates[existingIndex].date = new Date();
    } else {
      // Create new progress update
      const progressUpdate = {
        progress: parseInt(progress),
        note: note.trim(),
        userId: req.user._id,
        date: new Date()
      };
      task.updates.push(progressUpdate);
    }

    // Update overall progress and lastUpdated
    task.progress = parseInt(progress);
    task.lastUpdated = new Date();

    // If progress is 100, mark as done
    if (task.progress === 100) {
      task.status = 'done';
    }

    await task.save();

    const populatedTask = await Task.findById(task._id).populate('assignedTo', 'name email').lean();
    return res.json({ success: true, task: populatedTask });
  } catch (error) {
    console.error('addProgressUpdate error:', error);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// @desc    Get task progress updates
// @route   GET /api/tasks/:taskId/progress
// @access  Private
exports.getTaskProgress = async (req, res) => {
  try {
    const { Task } = getModels(req);

    const task = await Task.findOne({
      _id: req.params.taskId,
      tenant: req.tenant._id,
      isActive: true
    })
      .populate('project', 'name')
      .populate('assignedTo', 'name email')
      .populate('updates.userId', 'name email')
      .lean();

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    return res.json({ success: true, data: task.updates || [] });
  } catch (err) {
    console.error('getTaskProgress error:', err);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};
// @desc    Get today's updates by logged-in user
// @route   GET /api/tasks/my-updates/today
// @access  Private
exports.getTodayUpdates = async (req, res) => {
  console.log('🔎 getTodayUpdates called - tenant:', req.tenant?._id, 'user:', req.user?._id);
  try {
    const { Task } = getModels(req);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const tasks = await Task.find({
      tenant: req.tenant._id,
      isActive: true,
      'updates.userId': req.user._id,
      'updates.date': {
        $gte: today,
        $lt: tomorrow
      }
    })
      .populate('project', 'name')
      .populate('assignedTo', 'name')
      .populate('updates.userId', 'name email');

    // Extract today's updates
    const todayUpdates = [];
    tasks.forEach(task => {
      task.updates.forEach(update => {
        if (update.userId._id.toString() === req.user._id.toString() && 
            update.date >= today && update.date < tomorrow) {
          todayUpdates.push({
            _id: update._id,
            taskId: task._id,
            taskTitle: task.title,
            projectName: task.project?.name,
            progress: update.progress,
            note: update.note,
            date: update.date,
            task: {
              _id: task._id,
              title: task.title,
              project: task.project
            }
          });
        }
      });
    });

    // Sort by date descending
    todayUpdates.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(200).json({
      success: true,
      data: todayUpdates
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};