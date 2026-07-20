const { validationResult } = require('express-validator');

// ✅ single source of truth for valid role values, defined right here
// instead of a separate file. We validate incoming `role` against this
// list explicitly, so a bad value returns a clear 400 error instead of
// throwing a Mongoose ValidationError deep inside User.create/save that
// gets caught by the generic catch block and looks like "the role just
// didn't save".
// ⚠️ Make sure your User.js schema's `role` enum matches this list exactly
// (including the hyphen in 'team-lead') — a mismatch there is the most
// common reason a role silently fails to save.
const ALLOWED_ROLES = ['employee', 'team-lead', 'manager'];
const ROLE_LABELS = {
  employee: 'Employee',
  'team-lead': 'Team Lead',
  manager: 'Manager',
};

// ⚠️ WIRING NOTE: add this 1 route to your existing routes/employees.js,
// using the same auth/tenant middleware you already use for the other
// employee routes:
//
//   router.get('/roles', protect, getRoles);
//
// (Departments are handled separately — see the note near getRoles below
// for the two new routes to add to your existing department-settings
// controller/routes instead of here.)

// @desc    Create new employee (Admin only)
// @route   POST /api/employees
// @access  Private/Admin
exports.createEmployee = async (req, res) => {
  let employee = null; // track for cleanup

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      name, email, password, role, department, position, salary,
      phone, dateOfBirth, gender, address, employmentType, workMode,
      teamLead, teamMembers
    } = req.body;

    // ✅ validate role up front. If the frontend ever sends something
    // outside ALLOWED_ROLES (or if ALLOWED_ROLES and your User schema enum
    // ever drift apart), fail clearly here instead of deep inside User.create.
    if (role && !ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ message: `Invalid role "${role}". Must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }

    const Employee = req.models.Employee;
    const User = req.models.User;

    // Check if employee already exists
    const employeeExists = await Employee.findOne({ email });
    if (employeeExists) {
      return res.status(400).json({ message: 'Employee already exists with this email' });
    }

    // Validate teamLead before creating employee
    if (teamLead) {
      const teamLeadEmp = await Employee.findById(teamLead);
      if (!teamLeadEmp) {
        return res.status(400).json({ message: 'Invalid teamLead ID' });
      }
      // ✅ Can't check against employee._id here (not created yet) — skip self-check
      // Self-check can be done after creation if needed
    }

    // Create employee record
    // NOTE: `role` is deliberately NOT passed here. Employee.role (a legacy
    // duplicate field on the Employee schema, default 'employee') gets
    // explicitly synced further below, right after the linked User is
    // created — that's the single place role is decided from.
    employee = await Employee.create({
      name, email, department, position, salary, phone,
      dateOfBirth, gender, address, employmentType,
      workMode: workMode || 'wfo',
      tenant: req.tenant._id,
      teamLead: teamLead || undefined,
      teamMembers: teamMembers || []
    });

    // Auto-create department setting
    if (department && req.tenant?._id) {
      const DepartmentSetting = req.models.DepartmentSetting;
      try {
        await DepartmentSetting.findOneAndUpdate(
          { tenant: req.tenant._id, departmentName: department },
          { tenant: req.tenant._id, departmentName: department, shiftRequired: false },
          { upsert: true, new: true }
        );
      } catch (err) {
        console.warn('Auto-create department setting warning:', err.message);
      }
    }

    // ✅ role must be explicit — no silent fallback. If this ever fires,
    // it means the request reaching this controller genuinely has no role
    // (frontend didn't send it, or something stripped it in transit), and you
    // need to see that as an error, not have it quietly saved as 'employee'.
    if (!role) {
      if (employee?._id) {
        try { await req.models.Employee.deleteOne({ _id: employee._id }); }
        catch (cleanupErr) { console.error('Failed to rollback employee creation:', cleanupErr); }
      }
      return res.status(400).json({ message: 'Role is required to create an employee (employee, team-lead, or manager).' });
    }

    console.log(`createEmployee -> received role from request: "${role}" (typeof ${typeof role})`);

    // Create user account — this is where E11000 on employeeId can bubble up
    const user = await User.create({
      email,
      password: password || 'default123',
      role,
      employee: employee._id,
      tenant: req.tenant._id
    });

    // ✅ Confirm what actually got persisted, to make future debugging fast.
    console.log(`Created User ${user._id} for employee ${employee._id} with role: "${user.role}"`);

    // ✅ FIX: keep Employee.role in sync with the source of truth (User.role).
    // Employee.role is a duplicate/legacy field defined on the Employee
    // schema (`role: { type: String, enum: [...], default: 'employee' }`).
    // Nothing was ever writing to it, so it stayed stuck at the schema
    // default forever. Several frontend read-paths (EmployeeList's
    // extractRole, EmployeeForm's resolveEmployeeRole/loadEmployee) fall
    // back to `employee.role` whenever `employee.user` fails to populate
    // for any reason — and since that field was always 'employee', the UI
    // would silently show "Employee" even though the correct role was
    // saved fine on the User document. Writing it here (and in
    // updateEmployee below) eliminates that stale fallback trap.
    employee.role = user.role;

    // ✅ link the employee record back to the newly created user.
    // Without this, `Employee.user` stays empty forever, so every later
    // `.populate('user', 'role ...')` (getEmployee/getEmployees) returns
    // nothing and the frontend falls back to the default 'employee' role —
    // even though the correct role (team-lead/manager) was saved on the User.
    employee.user = user._id;
    await employee.save();

    res.status(201).json({
      _id: employee._id,
      employeeId: employee.employeeId,
      name: employee.name,
      email: employee.email,
      role: user.role,
      department: employee.department,
      position: employee.position,
      salary: employee.salary,
      employmentType: employee.employmentType,
      workMode: employee.workMode,
      joiningDate: employee.joiningDate,
      isActive: employee.isActive
    });

  } catch (error) {
    console.error('Create employee error:', error);

    // ✅ If this was a Mongoose validation error (e.g. role enum mismatch on
    // the User schema), surface the real reason instead of a generic 500.
    if (error.name === 'ValidationError') {
      const details = Object.values(error.errors || {}).map(e => e.message);
      console.error('Validation details:', details);
      // fall through to cleanup below, then respond with the real message
      if (employee?._id) {
        try { await req.models.Employee.deleteOne({ _id: employee._id }); }
        catch (cleanupErr) { console.error('Failed to rollback employee creation:', cleanupErr); }
      }
      return res.status(400).json({ message: `Validation failed: ${details.join('; ')}` });
    }

    // ✅ Clean up employee by _id if it was created before the error
    if (employee?._id) {
      try {
        await req.models.Employee.deleteOne({ _id: employee._id });
        console.log('Rolled back employee creation for:', employee._id);
      } catch (cleanupErr) {
        console.error('Failed to rollback employee creation:', cleanupErr);
      }
    }

    // ✅ Return specific message for duplicate key errors
    if (error.name === 'MongoServerError' && error.code === 11000) {
      const duplicatedField = Object.keys(error.keyValue || {})[0] || 'field';
      return res.status(409).json({
        message: `Duplicate value for ${duplicatedField}`,
        field: duplicatedField
      });
    }

    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get all employees
// @route   GET /api/employees
// @access  Private/Admin
//
// FIX: previously ran Employee.find(...).populate('user',...).populate('teamLead',...)
// .populate('teamMembers',...) as ONE chained query. If even a single document
// had a bad/dangling ref on any of those three fields (or if any of the three
// `ref` targets in the Employee schema were misconfigured), Mongoose would
// throw and the ENTIRE endpoint 500'd with zero detail — which is exactly
// what your logs showed (generic "Server error", spammed on every dashboard
// re-render because AdminDashboard calls this in a loop).
//
// Now: the base find and each populate step run independently, each wrapped
// in its own try/catch. A broken populate is logged and skipped rather than
// taking down the whole response — the endpoint always returns what it can,
// and if the *base* query itself fails, you get a real error name/message
// back in dev instead of a black box.
exports.getEmployees = async (req, res) => {
  try {
    const Employee = req.models?.Employee;
    const User = req.models?.User;
    const isDev = process.env.NODE_ENV !== 'production';

    if (!Employee) {
      console.error('getEmployees: req.models.Employee is missing for tenant:', req.tenant?._id || 'none');
      return res.status(500).json({
        message: 'Server error',
        ...(isDev && { error: 'Employee model unavailable for this tenant/request', stage: 'models-missing' })
      });
    }

    const filter = {};
    const includeInactive = req.query?.includeInactive === 'true';
    if (!includeInactive) {
      filter.isActive = true;
    }

    let tenantEmployees = [];

    // 1) Base query, NO populate. If this alone throws, the problem is the
    //    filter/connection/schema itself, not a populate ref — return the
    //    real error immediately instead of masking it as a populate issue.
    try {
      tenantEmployees = await Employee.find(filter).select('-__v');
    } catch (baseErr) {
      console.error('getEmployees: base Employee.find failed:', baseErr);
      console.error('getEmployees: base Employee.find stack:', baseErr?.stack);
      return res.status(500).json({
        message: 'Server error',
        ...(isDev && { error: baseErr?.message, name: baseErr?.name, stage: 'base-find' })
      });
    }

    // 2) Populate `user` — isolated. Logged and skipped if it fails.
    try {
      tenantEmployees = await Employee.populate(tenantEmployees, {
        path: 'user',
        select: 'role isActive lastLogin mobileAllowed email'
      });
    } catch (popErr) {
      console.error('getEmployees: populate("user") failed, continuing without it:', popErr?.message);
    }

    // 3) Populate `teamLead` — isolated. Logged and skipped if it fails.
    try {
      tenantEmployees = await Employee.populate(tenantEmployees, {
        path: 'teamLead',
        select: 'name email position department'
      });
    } catch (popErr) {
      console.error('getEmployees: populate("teamLead") failed, continuing without it:', popErr?.message);
    }

    // 4) Populate `teamMembers` — isolated. Logged and skipped if it fails.
    try {
      tenantEmployees = await Employee.populate(tenantEmployees, {
        path: 'teamMembers',
        select: 'name email position department'
      });
    } catch (popErr) {
      console.error('getEmployees: populate("teamMembers") failed, continuing without it:', popErr?.message);
    }

    // 5) Backfill pass: ensure each employee has an authoritative `user`
    // (role/mobileAllowed), and keep the legacy Employee.role field in sync.
    // Already fully wrapped per-item — kept as a non-fatal best-effort pass.
    try {
      await Promise.all(tenantEmployees.map(async (emp, i) => {
        try {
          const curUser = emp.user;
          if (!curUser) {
            const found = await User.findOne({ employee: emp._id }).select('role isActive lastLogin mobileAllowed email');
            if (found) {
              tenantEmployees[i].user = found;
              if (found.role && emp.role !== found.role) {
                try {
                  await Employee.updateOne({ _id: emp._id }, { $set: { role: found.role } });
                  tenantEmployees[i].role = found.role;
                } catch (syncErr) {
                  console.debug('role backfill failed for', emp._id, syncErr?.message);
                }
              }
            }
            return;
          }

          if (curUser && typeof curUser === 'object' && typeof curUser.mobileAllowed === 'undefined') {
            const reloaded = await User.findById(curUser._id).select('role isActive lastLogin mobileAllowed email');
            if (reloaded) tenantEmployees[i].user = reloaded;
          }

          const effectiveUser = tenantEmployees[i].user;
          if (effectiveUser && effectiveUser.role && emp.role !== effectiveUser.role) {
            try {
              await Employee.updateOne({ _id: emp._id }, { $set: { role: effectiveUser.role } });
              tenantEmployees[i].role = effectiveUser.role;
            } catch (syncErr) {
              console.debug('role backfill failed for', emp._id, syncErr?.message);
            }
          }
        } catch (e) {
          console.debug('ensure tenant employee user populated failed for', emp._id, e?.message || e);
        }
      }));
    } catch (e) {
      console.debug('tenantEmployees user-populate pass failed', e?.message || e);
    }

    // Only query main DB when explicitly requested via query param `includeLegacy=true`
    const includeLegacy = req.query?.includeLegacy === 'true';
    let mainEmployees = [];
    if (includeLegacy) {
      try {
        const mainConn = require('../config/db').mainDB();
        console.log('getEmployees -> includeLegacy=true, mainConn present:', !!mainConn, 'tenant:', req.tenant?._id || 'none');
        if (mainConn) {
          const MainEmployee = mainConn.models && mainConn.models.Employee
            ? mainConn.models.Employee
            : mainConn.model('Employee', require('../models/Employee'));

          const mainFilter = { ...filter };
          if (req.tenant && req.tenant._id) {
            mainFilter.$or = [
              { tenant: req.tenant._id },
              { tenant: { $exists: false } },
              { tenant: null }
            ];
          }

          try {
            mainEmployees = await MainEmployee.find(mainFilter).select('-__v');
          } catch (mainFindErr) {
            console.error('getEmployees: main DB find failed (skipping legacy merge):', mainFindErr?.message);
            mainEmployees = [];
          }

          if (mainEmployees.length > 0) {
            try {
              mainEmployees = await MainEmployee.populate(mainEmployees, {
                path: 'user',
                select: 'role isActive lastLogin mobileAllowed email'
              });
            } catch (popErr) {
              console.error('getEmployees: main DB populate("user") failed, continuing without it:', popErr?.message);
            }
            try {
              mainEmployees = await MainEmployee.populate(mainEmployees, {
                path: 'teamLead',
                select: 'name email position department'
              });
            } catch (popErr) {
              console.error('getEmployees: main DB populate("teamLead") failed, continuing without it:', popErr?.message);
            }
            try {
              mainEmployees = await MainEmployee.populate(mainEmployees, {
                path: 'teamMembers',
                select: 'name email position department'
              });
            } catch (popErr) {
              console.error('getEmployees: main DB populate("teamMembers") failed, continuing without it:', popErr?.message);
            }
          }
        }
      } catch (err) {
        console.error('Error querying main DB for employees:', err?.message || err);
      }
    }

    if (includeLegacy) {
      const combinedMap = new Map();
      const pushToMap = (emp) => {
        if (!emp) return;
        const id = String(emp._id || emp.id || emp.employeeId || JSON.stringify(emp));
        if (!combinedMap.has(id)) combinedMap.set(id, emp);
      };

      tenantEmployees.forEach(pushToMap);
      mainEmployees.forEach(pushToMap);

      const employees = Array.from(combinedMap.values());

      console.log(`getEmployees -> tenant: ${req.tenant?._id || 'none'}, tenantCount: ${tenantEmployees.length}, mainCount: ${mainEmployees.length}, combined: ${employees.length}`);
      return res.json(employees);
    }

    console.log(`getEmployees -> tenant: ${req.tenant?._id || 'none'}, tenantCount: ${tenantEmployees.length}`);
    return res.json(tenantEmployees);
  } catch (error) {
    console.error('Get employees error:', error);
    console.error('Get employees error stack:', error?.stack);

    const isDev = process.env.NODE_ENV !== 'production';
    return res.status(500).json({
      message: 'Server error',
      ...(isDev && {
        error: error?.message,
        name: error?.name
      })
    });
  }
};

// @desc    Get employee by ID
// @route   GET /api/employees/:id
// @access  Private
exports.getEmployee = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    const User = req.models.User;

    let employee;

    if (req.user.role === 'admin') {
      // Admin can view any employee
      employee = await Employee.findById(req.params.id)
        .populate('user', 'role isActive lastLogin mobileAllowed email');
    } else {
      // Employee can only view their own profile
      const User = req.models.User;
      const userEmployee = await User.findById(req.user._id).select('employee');
      if (req.params.id !== userEmployee.employee.toString()) {
        return res.status(403).json({ message: 'Access denied' });
      }
      employee = await Employee.findById(req.params.id)
        .populate('user', 'role isActive lastLogin email');
    }

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // ✅ Opportunistic sync: if the linked User's role is authoritative and
    // differs from the (legacy) Employee.role field, fix it on read so any
    // caller relying on `employee.role` directly never sees a stale value.
    if (employee.user && typeof employee.user === 'object' && employee.user.role
        && employee.role !== employee.user.role) {
      try {
        employee.role = employee.user.role;
        await employee.save();
      } catch (syncErr) {
        console.warn('getEmployee: failed to sync legacy role field:', syncErr.message);
      }
    }

    res.json(employee);
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update employee
// @route   PUT /api/employees/:id
// @access  Private/Admin
exports.updateEmployee = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    const User = req.models.User;

    const employee = await Employee.findById(req.params.id);

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const {
      name, email, department, position, salary, isActive, role,
      phone, dateOfBirth, gender, address, employmentType, workMode,
      joiningDate,
      teamLead,
      teamMembers,
      addTeamMembers,
      removeTeamMembers
    } = req.body;

    // ✅ validate role up front (same reasoning as createEmployee) so a
    // bad value fails with a clear 400 instead of a swallowed/generic error.
    if (role && !ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ message: `Invalid role "${role}". Must be one of: ${ALLOWED_ROLES.join(', ')}` });
    }

    // Update all fields including workMode
    const previousEmail = employee.email;
    employee.name = name || employee.name;
    employee.email = email || employee.email;
    employee.department = department || employee.department;
    employee.position = position || employee.position;
    employee.salary = salary || employee.salary;
    employee.phone = phone || employee.phone;
    employee.dateOfBirth = dateOfBirth || employee.dateOfBirth;
    employee.gender = gender || employee.gender;
    employee.address = address || employee.address;
    employee.employmentType = employmentType || employee.employmentType;
    employee.workMode = workMode || employee.workMode;
    employee.isActive = isActive !== undefined ? isActive : employee.isActive;
    // Allow admin to update joining date at any time
    if (joiningDate) {
      try {
        employee.joiningDate = new Date(joiningDate);
      } catch (err) {
        console.warn('Invalid joiningDate provided, skipping update:', joiningDate);
      }
    }

    // Handle team assignments
    if (teamLead !== undefined) {
      if (teamLead) {
        const tlEmp = await Employee.findById(teamLead);
        if (!tlEmp) {
          return res.status(400).json({ message: 'Invalid teamLead ID' });
        }
        if (tlEmp._id.toString() === employee._id.toString()) {
          return res.status(400).json({ message: 'Employee cannot be their own team lead' });
        }
        employee.teamLead = teamLead;
      } else {
        employee.teamLead = null;
      }
    }

    if (addTeamMembers) {
      if (!Array.isArray(addTeamMembers)) {
        return res.status(400).json({ message: 'addTeamMembers must be array' });
      }
      await Employee.updateMany(
        { _id: { $in: addTeamMembers } },
        { $addToSet: { teamMembers: employee._id } }
      );
      employee.teamMembers = employee.teamMembers || [];
      addTeamMembers.forEach(id => {
        if (!employee.teamMembers.includes(id)) {
          employee.teamMembers.push(id);
        }
      });
    }

    if (removeTeamMembers) {
      if (!Array.isArray(removeTeamMembers)) {
        return res.status(400).json({ message: 'removeTeamMembers must be array' });
      }
      await Employee.updateMany(
        { _id: { $in: removeTeamMembers } },
        { $pull: { teamMembers: employee._id } }
      );
      employee.teamMembers = employee.teamMembers.filter(id => !removeTeamMembers.includes(id));
    }

    // If email is updated (different from previous), also update the user email
    if (email && email !== previousEmail) {
      try {
        await User.findOneAndUpdate(
          { employee: employee._id },
          { email: email }
        );
      } catch (err) {
        console.error('Failed to update linked User email:', err);
        // continue saving employee even if user update fails
      }
    }

    // Handle role update on linked User (admin feature)
    let userCreated = false;
    if (role) {
      console.log(`updateEmployee -> received role from request: "${role}" (typeof ${typeof role})`);
      if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can change roles' });
      }

      try {
        let linkedUser = await User.findOne({ employee: employee._id });
        if (!linkedUser) {
          // Create user if missing (data fix)
          console.log(`Creating missing User for employee ${employee._id}, role: ${role}`);
          linkedUser = new User({
            email: employee.email,
            password: 'tempSecurePass123!', // Temp; admin can reset
            role: role,
            employee: employee._id,
            tenant: req.tenant._id,
            isActive: employee.isActive,
            mobileAllowed: true
          });
          await linkedUser.save();
          userCreated = true;
          console.log(`✅ Created linked User ${linkedUser._id} with role "${linkedUser.role}"`);
        } else if (linkedUser.role !== role) {
          console.log(`Role change: ${linkedUser.email} ${linkedUser.role} -> ${role}`);
          linkedUser.role = role;
          await linkedUser.save();
          console.log(`✅ Saved role "${linkedUser.role}" for User ${linkedUser._id}`);
        } else {
          console.log(`Role unchanged for ${linkedUser.email}: "${linkedUser.role}"`);
        }

        // ✅ FIX: keep the legacy Employee.role field in sync with the
        // authoritative User.role. Employee.role is a duplicate field
        // (`role: { type: String, enum: [...], default: 'employee' }`) on
        // the Employee schema that this controller previously never wrote
        // to on update — so it stayed stuck at 'employee' forever, and any
        // frontend code that fell back to `employee.role` whenever
        // `employee.user` failed to populate would silently show the wrong
        // role even though the correct one was saved on the User document.
        employee.role = linkedUser.role;

        // Also update Employee.user ref if missing
        if (!employee.user) {
          employee.user = linkedUser._id;
        }
        await employee.save();
      } catch (roleErr) {
        // ✅ surface the real reason a role failed to save instead of
        // letting it get swallowed by the outer catch as a generic 500.
        console.error('Failed to save role on linked User:', roleErr);
        const details = roleErr.name === 'ValidationError'
          ? Object.values(roleErr.errors || {}).map(e => e.message).join('; ')
          : roleErr.message;
        return res.status(400).json({ message: `Failed to update role: ${details}` });
      }
    }

    const updatedEmployee = await employee.save();

    // Auto-create department setting if department changed/created
    const newDepartment = req.body.department;
    if (newDepartment && req.tenant && req.tenant._id) {
      const DepartmentSetting = req.models.DepartmentSetting;
      try {
        await DepartmentSetting.findOneAndUpdate(
          { tenant: req.tenant._id, departmentName: newDepartment },
          { tenant: req.tenant._id, departmentName: newDepartment, shiftRequired: false },
          { upsert: true, new: true }
        );
      } catch (err) {
        console.warn('Auto-create department setting warning:', err.message);
      }
    }

    // If a password was provided in the update payload, also update the linked User's password
    const newPassword = req.body.password;
    if (newPassword && String(newPassword).trim().length > 0) {
      try {
        // find user linked to this employee and update password
        const linkedUser = await User.findOne({ employee: employee._id });
        if (linkedUser) {
          // Basic validation
          if (String(newPassword).length < 6) {
            console.warn('Password provided for update is shorter than 6 characters; skipping user password update');
          } else {
            linkedUser.password = newPassword;
            linkedUser.passwordChangedAt = Date.now();
            // invalidate sessions so they must re-login
            if (typeof linkedUser.invalidateSession === 'function') {
              try {
                linkedUser.invalidateSession();
              } catch (sessErr) {
                console.warn('Failed to invalidate sessions for user after password change:', sessErr);
              }
            }
            await linkedUser.save();
            console.log(`Updated password for linked user of employee ${updatedEmployee._id}`);
          }
        } else {
          console.warn('No linked User found for employee when attempting to update password');
        }
      } catch (pwErr) {
        console.error('Error updating linked User password:', pwErr);
        // don't fail employee update because of user password update failure
      }
    }

    // Populate updated user role in response
    await updatedEmployee.populate('user', 'role');

    const finalRole = updatedEmployee.user?.role || updatedEmployee.role || role || 'employee';
    if (userCreated) {
      res.status(201).json({
        ...updatedEmployee.toObject(),
        role: finalRole,
        message: 'Employee updated and User account created'
      });
    } else {
      res.json({
        _id: updatedEmployee._id,
        name: updatedEmployee.name,
        email: updatedEmployee.email,
        department: updatedEmployee.department,
        position: updatedEmployee.position,
        salary: updatedEmployee.salary,
        workMode: updatedEmployee.workMode,
        joiningDate: updatedEmployee.joiningDate,
        isActive: updatedEmployee.isActive,
        role: finalRole
      });
    }
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Delete employee
// @route   DELETE /api/employees/:id
// @access  Private/Admin
exports.deleteEmployee = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    const User = req.models.User;

    console.log('🔧 DELETE request received for employee ID:', req.params.id);
    console.log('🔧 User making request:', req.user._id, req.user.role);

    const employee = await Employee.findById(req.params.id);

    if (!employee) {
      console.log('❌ Employee not found:', req.params.id);
      return res.status(404).json({ message: 'Employee not found' });
    }

    console.log('📝 Found employee to delete:', employee.name, employee.email);

    // Soft delete employee and user
    employee.isActive = false;
    await employee.save();
    console.log('✅ Employee marked as inactive');

    await User.findOneAndUpdate(
      { employee: employee._id },
      { isActive: false }
    );
    console.log('✅ User account marked as inactive');

    res.json({
      message: 'Employee removed successfully',
      employeeId: employee._id,
      employeeName: employee.name
    });

  } catch (error) {
    console.error('❌ Delete employee error:', error);
    res.status(500).json({
      message: 'Server error during deletion',
      error: error.message
    });
  }
};

// @desc    Get employee profile (for current logged-in employee)
// @route   GET /api/employees/profile/me
// @access  Private
exports.getMyProfile = async (req, res) => {
  try {
    const User = req.models.User;
    const Employee = req.models.Employee;

    const user = await User.findById(req.user._id).populate('employee');

    if (!user || !user.employee) {
      return res.status(404).json({ message: 'Employee profile not found' });
    }

    res.json(user.employee);
  } catch (error) {
    console.error('Get my profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update employee profile (for current logged-in employee)
// @route   PUT /api/employees/profile/me
// @access  Private
exports.updateMyProfile = async (req, res) => {
  try {
    const User = req.models.User;
    const Employee = req.models.Employee;

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const employee = await Employee.findById(user.employee);

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Employees can only update certain fields
    const { phone, address, emergencyContact } = req.body;

    employee.phone = phone || employee.phone;
    employee.address = address || employee.address;
    employee.emergencyContact = emergencyContact || employee.emergencyContact;

    const updatedEmployee = await employee.save();

    res.json(updatedEmployee);
  } catch (error) {
    console.error('Update my profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Debug: return tenant/main counts and samples for employees
// @route   GET /api/employees/debug-counts
// @access  Private/Admin
exports.getEmployeesDebug = async (req, res) => {
  try {
    const Employee = req.models?.Employee;
    const result = {
      tenant: req.tenant?._id || null,
      tenantCount: null,
      mainCount: null,
      tenantSample: [],
      mainSample: []
    };

    // Tenant counts/sample
    if (Employee) {
      try {
        result.tenantCount = await Employee.countDocuments({});
        result.tenantSample = await Employee.find({}).limit(10).select('-__v').lean();
      } catch (e) {
        result.tenantCount = `error: ${e.message}`;
      }
    }

    // Main DB counts/sample
    try {
      const mainConn = require('../config/db').mainDB();
      if (mainConn) {
        const MainEmployee = mainConn.models && mainConn.models.Employee
          ? mainConn.models.Employee
          : mainConn.model('Employee', require('../models/Employee'));

        const mainFilter = {};
        // if tenant present, also include docs missing tenant or matching tenant
        if (req.tenant && req.tenant._id) {
          mainFilter.$or = [
            { tenant: req.tenant._id },
            { tenant: { $exists: false } },
            { tenant: null }
          ];
        }

        result.mainCount = await MainEmployee.countDocuments(mainFilter);
        result.mainSample = await MainEmployee.find(mainFilter).limit(10).select('-__v').lean();
      } else {
        result.mainCount = 'no-main-conn';
      }
    } catch (e) {
      result.mainCount = `error: ${e.message}`;
    }

    return res.json(result);
  } catch (error) {
    console.error('Get employees debug error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// task-assignment helpers, used by TaskForm.jsx via
// employeeService.getMyTeam() and employeeService.getEmployeesForAssignment()
// ─────────────────────────────────────────────────────────────────────────

// @desc    Get the current manager/team-lead's own team members
//          (populates the "Assign To" dropdown in TaskForm.jsx)
// @route   GET /api/employees/my-team
// @access  Private/Manager, Team Lead
exports.getMyTeam = async (req, res) => {
  try {
    const Employee = req.models.Employee;

    if (!['manager', 'team-lead'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only managers and team leads have a team' });
    }

    const actingEmployee = req.user.employee && req.user.employee._id
      ? req.user.employee
      : await Employee.findOne({ user: req.user._id });

    if (!actingEmployee) {
      return res.status(404).json({ message: 'Employee record not found for current user' });
    }

    const teamMembers = await Employee.find({
      teamLead: actingEmployee._id,
      isActive: true
    })
      .select('_id name email position department')
      .sort({ name: 1 });

    res.json({ data: teamMembers });
  } catch (error) {
    console.error('Get my team error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get employees eligible for task assignment, scoped by role.
//          Admin gets every active employee (unchanged — TaskForm.jsx's
//          admin branch still uses GET /employees + client-side department
//          filtering, which already works correctly and is untouched).
//          Manager/Team Lead get every active employee in THEIR OWN
//          department (matches how the "Department *" field is locked on
//          the frontend for these roles) — not just their direct reports,
//          which is what this endpoint filtered by before.
// @route   GET /api/employees/for-assignment
// @access  Private/Admin, Manager, Team Lead
exports.getEmployeesForAssignment = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    const filter = { isActive: true };

    if (req.user.role === 'admin') {
      // no extra scoping — admin can assign to anyone
    } else if (['manager', 'team-lead'].includes(req.user.role)) {
      const actingEmployee = req.user.employee && req.user.employee._id
        ? req.user.employee
        : await Employee.findOne({ user: req.user._id });

      if (!actingEmployee || !actingEmployee.department) {
        return res.status(200).json({ data: [] });
      }

      // Case-insensitive EXACT match on department (not a substring match,
      // so e.g. "IT" doesn't also match "Digital Marketing"). Escape regex
      // special characters in case a department name contains them.
      const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.department = new RegExp(`^${escapeRegex(actingEmployee.department.trim())}$`, 'i');
    } else {
      return res.status(403).json({ message: 'Access denied' });
    }

    const employees = await Employee.find(filter)
      // FIX: previously didn't populate `user`, so the frontend's
      // extractEmployeeRole(emp) always fell through to the legacy
      // Employee.role fallback (or 'employee' default) for everyone
      // returned by this endpoint — every person in the Assign To list
      // would show as "Employee" regardless of their real role.
      .populate('user', 'role')
      .select('_id name email position department user')
      .sort({ name: 1 });

    res.json({ data: employees });
  } catch (error) {
    console.error('Get employees for assignment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// NOTE: Departments are NOT handled here — this app already has a
// department-settings controller/routes backing departmentSettingService
// in services/auth.js (GET /department-settings, PUT /department-settings/:name).
// Add these two handlers there instead, alongside the existing ones,
// following the same pattern used by createDepartment/deleteDepartment
// that used to live in this file:
//
//   POST /department-settings          — create (body: { departmentName })
//     - trim + case-insensitive duplicate check on DepartmentSetting
//     - DepartmentSetting.create({ tenant: req.tenant._id, departmentName, shiftRequired: false })
//
//   DELETE /department-settings/:name  — delete
//     - block with 409 if Employee.countDocuments({ tenant, department: name, isActive: true }) > 0
//     - otherwise DepartmentSetting.deleteOne({ tenant: req.tenant._id, departmentName: name })

// @desc    Get the list of assignable roles
// @route   GET /api/employees/roles
// @access  Private
exports.getRoles = async (req, res) => {
  try {
    const roles = ALLOWED_ROLES.map(value => ({ value, label: ROLE_LABELS[value] || value }));
    res.json({ roles });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Set mobile access for an employee's user account (Admin only)
// @route   PUT /api/employees/:id/mobile-allow
// @access  Private/Admin
exports.setMobileAccess = async (req, res) => {
  try {
    const User = req.models.User;
    const employeeId = req.params.id;
    const { mobileAllowed } = req.body;

    if (typeof mobileAllowed === 'undefined') {
      return res.status(400).json({ message: 'mobileAllowed boolean is required in request body' });
    }

    // Try to find associated user by employee reference
    let user = await User.findOne({ employee: employeeId });

    // If not found, maybe the id passed is the user id
    if (!user) {
      if (String(employeeId).length === 24) {
        user = await User.findById(employeeId);
      }
    }

    if (!user) {
      return res.status(404).json({ message: 'User account for this employee not found' });
    }

    user.mobileAllowed = !!mobileAllowed;
    await user.save();

    // Try to return the updated employee record (populated with the user)
    try {
      const Employee = req.models.Employee;
      if (Employee) {
        const employeeDoc = await Employee.findOne({ _id: user.employee }).populate('user', 'role isActive lastLogin mobileAllowed email');
        if (employeeDoc) {
          return res.json(employeeDoc);
        }
      }
    } catch (e) {
      console.warn('setMobileAccess: failed to fetch populated employee after updating user', e && e.message ? e.message : e);
    }

    // Fallback: return a simple confirmation with the authoritative boolean
    return res.json({
      message: `Mobile access ${user.mobileAllowed ? 'enabled' : 'disabled'} for user ${user.email}`,
      mobileAllowed: user.mobileAllowed
    });
  } catch (error) {
    console.error('Set mobile access error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};