const { validationResult } = require('express-validator');

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

    // Create user account — this is where E11000 on employeeId can bubble up
    const user = await User.create({
      email,
      password: password || 'default123',
      role: role || 'employee',
      employee: employee._id,
      tenant: req.tenant._id
    });

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
exports.getEmployees = async (req, res) => {
  try {
    const Employee = req.models?.Employee;
    const User = req.models?.User;

    // Default: only active employees. Allow overriding with query param `includeInactive=true`.
    const filter = {};
    const includeInactive = req.query?.includeInactive === 'true';
    if (!includeInactive) {
      filter.isActive = true;
    }

    // We'll collect results from tenant DB (req.models) and optionally from main DB
    let tenantEmployees = [];
    let mainEmployees = [];

    // Tenant-scoped query: run if tenant models available
    if (req.models && Employee) {
      // When using tenant-specific connection, the tenant DB already contains only
      // that tenant's documents. Adding a `tenant` field filter here can accidentally
      // exclude valid tenant DB records that don't have a `tenant` field set
      // (legacy or migrated records). So only apply the active/inactive filter.
      const tenantFilter = { ...filter };
      tenantEmployees = await Employee.find(tenantFilter)
        .populate('user', 'role isActive lastLogin mobileAllowed email')
        .populate('teamLead', 'name email position department')
        .populate('teamMembers', 'name email position department')
        .select('-__v');

      // Ensure each tenant employee has a populated `user.mobileAllowed` when possible.
      // Some documents may have an unpopulated user or a populated user missing the
      // `mobileAllowed` field — attempt to fetch the authoritative user record.
      try {
        await Promise.all(tenantEmployees.map(async (emp, i) => {
          try {
            // If user is an ObjectId or missing, try to resolve by employee reference
            const curUser = emp.user;
            if (!curUser) {
              const found = await req.models.User.findOne({ employee: emp._id }).select('role isActive lastLogin mobileAllowed email');
              if (found) tenantEmployees[i].user = found;
              return;
            }

            // If populated but missing mobileAllowed, reload authoritative user
            if (curUser && typeof curUser === 'object' && typeof curUser.mobileAllowed === 'undefined') {
              const reloaded = await req.models.User.findById(curUser._id).select('role isActive lastLogin mobileAllowed email');
              if (reloaded) tenantEmployees[i].user = reloaded;
            }
          } catch (e) {
            // ignore per-item errors
            console.debug('ensure tenant employee user populated failed for', emp._id, e && e.message ? e.message : e);
          }
        }));
      } catch (e) {
        console.debug('tenantEmployees user-populate pass failed', e && e.message ? e.message : e);
      }
    }

    // Only query main DB when explicitly requested via query param `includeLegacy=true`
    const includeLegacy = req.query?.includeLegacy === 'true';
    if (includeLegacy) {
      try {
        const mainConn = require('../config/db').mainDB();
        console.log('getEmployees -> includeLegacy=true, mainConn present:', !!mainConn, 'tenant:', req.tenant?._id || 'none');
        if (mainConn && typeof mainConn.modelNames === 'function') {
          try {
            console.log('getEmployees -> mainConn.models:', mainConn.modelNames());
          } catch (e) {
            console.log('getEmployees -> could not list mainConn.modelNames:', e && e.message ? e.message : e);
          }
        }
        if (mainConn) {
          const MainEmployee = mainConn.models && mainConn.models.Employee
            ? mainConn.models.Employee
            : mainConn.model('Employee', require('../models/Employee'));

          const mainFilter = { ...filter };
          if (req.tenant && req.tenant._id) {
            // include documents that either belong to tenant or missing tenant
            mainFilter.$or = [
              { tenant: req.tenant._id },
              { tenant: { $exists: false } },
              { tenant: null }
            ];
          }

          try {
            const mainCount = await MainEmployee.countDocuments(mainFilter);
            console.log('getEmployees -> mainFilter count:', mainCount);
          } catch (countErr) {
            console.log('getEmployees -> countDocuments failed on main DB:', countErr && countErr.message ? countErr.message : countErr);
          }

          mainEmployees = await MainEmployee.find(mainFilter)
            .populate('user', 'role isActive lastLogin mobileAllowed email')
            .populate('teamLead', 'name email position department')
            .populate('teamMembers', 'name email position department')
            .select('-__v');

          // Try to ensure mainEmployees also have authoritative user.mobileAllowed
          try {
            const MainUser = mainConn.models && mainConn.models.User
              ? mainConn.models.User
              : mainConn.model('User', require('../models/User'));
            await Promise.all(mainEmployees.map(async (emp, i) => {
              try {
                const curUser = emp.user;
                if (!curUser) {
                  const found = await MainUser.findOne({ employee: emp._id }).select('role isActive lastLogin mobileAllowed email');
                  if (found) mainEmployees[i].user = found;
                  return;
                }
                if (curUser && typeof curUser === 'object' && typeof curUser.mobileAllowed === 'undefined') {
                  const reloaded = await MainUser.findById(curUser._id).select('role isActive lastLogin mobileAllowed email');
                  if (reloaded) mainEmployees[i].user = reloaded;
                }
              } catch (e) {
                console.debug('ensure main employee user populated failed for', emp._id, e && e.message ? e.message : e);
              }
            }));
          } catch (e) {
            console.debug('mainEmployees user-populate pass failed', e && e.message ? e.message : e);
          }
        }
      } catch (err) {
        console.error('Error querying main DB for employees:', err && err.message ? err.message : err);
      }
    }

    // If legacy inclusion requested, combine and dedupe; otherwise return tenant results only
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
    res.status(500).json({ message: 'Server error' });
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
      if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can change roles' });
      }
      if (role === 'admin') {
        return res.status(403).json({ message: 'Cannot promote to admin via this endpoint' });
      }

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
      } else if (linkedUser.role !== role) {
        console.log(`Role change: ${linkedUser.email} ${linkedUser.role} -> ${role}`);
        linkedUser.role = role;
        await linkedUser.save();
      }
      // Also update Employee.user ref if missing
      if (!employee.user) {
        employee.user = linkedUser._id;
        await employee.save();
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

    const finalRole = updatedEmployee.user?.role || role || 'employee';
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


