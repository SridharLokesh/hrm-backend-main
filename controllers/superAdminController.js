const { getSuperAdminModels, getTenantModels, connectTenantDB } = require('../config/db');
const mongoose = require('mongoose');
const generateToken = require('../utils/generateToken');
const { validationResult } = require('express-validator');

// Normalize portal URL: remove any '/hrm' path segments and ensure final path includes subdomain
const normalizePortalUrl = (rawUrl, subdomain) => {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    let parts = u.pathname.split('/').filter(Boolean).filter(p => p.toLowerCase() !== 'hrm');
    if (subdomain && (!parts.length || parts[parts.length - 1] !== subdomain)) {
      parts.push(subdomain);
    }
    u.pathname = '/' + parts.join('/');
    return u.toString().replace(/\/+$/, '');
  } catch (e) {
    // fallback string manipulation
    let s = String(rawUrl).replace(/\/+hrm(\/+)?/gi, '/').replace(/\/+$/,'');
    if (subdomain && !s.endsWith('/' + subdomain)) s = s + '/' + subdomain;
    return s || null;
  }
};

// Helper to get super admin models at runtime (ensures main DB connection is ready)
const getMainModels = () => {
  return getSuperAdminModels();
};

// Super admin login
exports.login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

  const { SuperAdmin } = getMainModels();
  const superAdmin = await SuperAdmin.findOne({ email, isActive: true });
    if (!superAdmin || !(await superAdmin.matchPassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    superAdmin.lastLogin = new Date();
    await superAdmin.save();

    res.json({
      _id: superAdmin._id,
      name: superAdmin.name,
      email: superAdmin.email,
      role: superAdmin.role,
      token: generateToken(superAdmin._id, 'super-admin')
    });
  } catch (error) {
    console.error('Super admin login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get current super admin
exports.getMe = async (req, res) => {
  res.json({
    _id: req.superAdmin._id,
    name: req.superAdmin.name,
    email: req.superAdmin.email,
    role: req.superAdmin.role
  });
};

// Create new tenant - FIXED with better error handling
exports.createTenant = async (req, res) => {
  let tenant;
  
  try {
    let {
      name,
      subdomain,
      companyName,
      description,
      contactEmail,
      phone,
      address,
      industry,
      size,
      settings,
      subscription,
      adminEmail,
      adminPassword
    } = req.body;

    const { Tenant } = getMainModels();

    // Debug log: who is creating and what payload (mask nothing sensitive here)
    console.log('Create tenant attempt by superAdmin:', req.superAdmin ? req.superAdmin._id : 'unknown');
    console.log('Create tenant payload:', { name, subdomain, companyName, contactEmail });

    // Basic server-side validation to provide clear errors back to client
    const missing = [];
    // If name not provided, fall back to companyName
    if (!name && companyName) name = companyName;
    if (!name) missing.push('name');
    if (!subdomain) missing.push('subdomain');
    if (!companyName) missing.push('companyName');
    if (!contactEmail) missing.push('contactEmail');
    // adminEmail & adminPassword are optional; if adminEmail provided require adminPassword
    if (adminEmail && !adminPassword) missing.push('adminPassword');

    if (missing.length) {
      return res.status(400).json({ message: `Missing required fields: ${missing.join(', ')}` });
    }

    // Check if subdomain is unique
    const existingTenant = await Tenant.findOne({ 
      $or: [{ name }, { subdomain }] 
    });
    
    if (existingTenant) {
      return res.status(400).json({ 
        message: 'Tenant with this name or subdomain already exists' 
      });
    }

    // Create tenant record in super admin database FIRST
    // Normalize portal URL to remove any '/hrm' segment and ensure it ends with the subdomain
    const providedPortal = req.body.portalUrl || req.body.portalBase || null;
    const normalizedPortal = providedPortal ? normalizePortalUrl(providedPortal, subdomain.toLowerCase()) : null;

    tenant = await Tenant.create({
      name,
      subdomain: subdomain.toLowerCase(),
      portalUrl: normalizedPortal,
      companyName,
      description,
      contactEmail,
      phone,
      address,
      industry,
      size,
      settings,
      subscription: {
        plan: subscription?.plan || 'free',
        status: 'trial',
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        maxEmployees: subscription?.maxEmployees || 10
      },
      createdBy: req.superAdmin._id
    });

    console.log(`🔄 Creating database for tenant: ${companyName}`);

    // Create separate database for this tenant
    const tenantConnection = await connectTenantDB(tenant._id.toString(), companyName);
    
    // Get models using the new async method
    const models = await getTenantModels(tenantConnection);
      
    // Create default company in tenant database
    await models.Company.create({
      name: companyName,
      contact: {
        email: contactEmail,
        phone: phone
      },
      address: address,
      settings: settings
    });

    console.log(`✅ Default company created for: ${companyName}`);
    
    // Create initial admin user (non-blocking). Prefer explicit adminEmail/adminPassword if provided.
    const adminData = {
      name: `${companyName} Admin`,
      email: adminEmail || contactEmail,
      password: adminPassword || (Math.random().toString(36).slice(-8) + 'A1!')
    };

    createInitialAdmin(tenant, models, adminData).catch(err => {
      console.error('⚠️ Initial admin creation failed (non-critical):', err.message);
    });

    res.status(201).json({
      ...tenant.toJSON(),
      message: 'Tenant created successfully with separate database'
    });

  } catch (error) {
    console.error('❌ Create tenant error:', error && error.stack ? error.stack : error);
    
    // Rollback: delete tenant record if database creation fails
    if (tenant && tenant._id) {
      try {
        const { Tenant } = getMainModels();
        await Tenant.findByIdAndDelete(tenant._id);
        console.log('🔄 Rolled back tenant record due to database creation failure');
      } catch (rollbackError) {
        console.error('❌ Failed to rollback tenant record:', rollbackError.message);
      }
    }
    
    if (error.message.includes('Maximum connection limit')) {
      return res.status(429).json({ 
        message: 'System is at maximum capacity. Please try again later.' 
      });
    }
    
    if (error.message.includes('timed out')) {
      return res.status(504).json({ 
        message: 'Database operation timed out. Please try again.' 
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to create tenant database',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create initial admin for tenant (non-critical)
const createInitialAdmin = async (tenant, models, adminData) => {
  try {
    // Create admin employee in tenant database
    const adminEmployee = await models.Employee.create({
      name: adminData.name,
      email: adminData.email,
      department: 'Administration',
      position: 'Administrator',
      salary: 0,
      employmentType: 'full-time',
      employeeId: `EMP${new Date().getFullYear()}0001`
    });

    // Create admin user in tenant database
    await models.User.create({
      email: adminData.email,
      password: adminData.password,
      role: 'admin',
      employee: adminEmployee._id,
      tenant: tenant._id,
      isActive: true
    });

    console.log(`✅ Initial admin created for tenant: ${tenant.companyName}`);
  } catch (error) {
    console.error('❌ Error creating initial admin:', error.message);
    throw error;
  }
};

// Public list of active tenants for company selector
exports.getPublicTenants = async (req, res) => {
  try {
    const { Tenant } = getMainModels();

    const tenants = await Tenant.find({ isActive: true })
      .select('companyName name subdomain subscription description industry size createdAt')
      .sort({ companyName: 1 });

    const sanitized = tenants.map(tenant => ({
      _id: tenant._id,
      name: tenant.name,
      companyName: tenant.companyName,
      subdomain: tenant.subdomain,
      portalUrl: tenant.portalUrl || null,
      status: tenant.subscription?.status || 'active',
      plan: tenant.subscription?.plan || 'free',
      description: tenant.description || '',
      industry: tenant.industry || '',
      size: tenant.size || '',
      createdAt: tenant.createdAt,
    }));

    res.json(sanitized);
  } catch (error) {
    console.error('Get public tenants error:', error);
    res.status(500).json({ message: 'Failed to load companies' });
  }
};

// Change super admin password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new passwords are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters long' });
    }

    const { SuperAdmin } = getMainModels();
    const superAdmin = await SuperAdmin.findById(req.superAdmin._id);

    if (!superAdmin) {
      return res.status(404).json({ message: 'Super admin not found' });
    }

    const isMatch = await superAdmin.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    superAdmin.password = newPassword;
    await superAdmin.save();

    res.json({ message: 'Password updated successfully. Please log in again.' });
  } catch (error) {
    console.error('Super admin change password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get tenant models helper (updated to use new async method)
// const getTenantModels = async (tenantConnection) => {
//   const { getTenantModels: getModels } = require('../config/db');
//   return await getModels(tenantConnection);
// };

// Create admin for existing tenant
exports.createAdmin = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const { tenantId } = req.params;

    const { Tenant } = getMainModels();
    
    // Basic validation
    if (!name || !email) {
      return res.status(400).json({ message: 'Admin name and email are required' });
    }

    // Find tenant
    let tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      // Try to find by subdomain
      tenant = await Tenant.findOne({ 
        $or: [
          { subdomain: tenantId.toLowerCase() },
          { name: new RegExp(`^${tenantId}$`, 'i') }
        ]
      });
    }

    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

  // Ensure tenant database connection is active and get models
  const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
  const models = await getTenantModels(tenantConnection);

    // Create admin employee and user with defensive error handling
    let adminEmployee;
    let adminUser;
    try {
      adminEmployee = await models.Employee.create({
        name,
        email,
        department: 'Administration',
        position: 'Administrator',
        salary: 0,
        employmentType: 'full-time',
        employeeId: `EMP${new Date().getFullYear()}${Math.floor(Math.random() * 9000) + 1000}`
      });
    } catch (err) {
      console.error('Error creating admin employee:', err);
      return res.status(500).json({ message: 'Failed to create admin employee', error: err.message });
    }

    try {
      adminUser = await models.User.create({
        email,
        password: password || 'admin123',
        role: 'admin',
        employee: adminEmployee._id,
        tenant: tenant._id,
        isActive: true
      });
    } catch (err) {
      console.error('Error creating admin user:', err);
      // attempt cleanup of created employee if user creation fails
      try {
        if (adminEmployee && adminEmployee._id) {
          await models.Employee.findByIdAndDelete(adminEmployee._id);
        }
      } catch (cleanupErr) {
        console.error('Failed to cleanup orphan admin employee:', cleanupErr);
      }

      if (err.code === 11000 || (err.message && err.message.toLowerCase().includes('duplicate'))) {
        return res.status(409).json({ message: 'Admin user with this email already exists' });
      }

      return res.status(500).json({ message: 'Failed to create admin user', error: err.message });
    }

    res.status(201).json({
      _id: adminUser._id,
      email: adminUser.email,
      role: adminUser.role,
      employee: adminEmployee
    });
  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getTenantAdmins = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { tenantId } = req.params;
    const tenant = await Tenant.findById(tenantId);

    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
    const models = await getTenantModels(tenantConnection);
    const admins = await models.User.find({ role: 'admin' })
      .populate('employee', 'name email department position isActive')
      .select('email role employee isActive canEditAttendanceTime createdAt')
      .sort({ createdAt: -1 });

    res.json(admins);
  } catch (error) {
    console.error('Get tenant admins error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.updateAdminAttendancePermission = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { tenantId, adminId } = req.params;
    const tenant = await Tenant.findById(tenantId);

    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
    const models = await getTenantModels(tenantConnection);
    const admin = await models.User.findOne({ _id: adminId, role: 'admin' })
      .populate('employee', 'name email department position isActive');

    if (!admin) {
      return res.status(404).json({ message: 'Tenant admin not found' });
    }

    admin.canEditAttendanceTime = Boolean(req.body.canEditAttendanceTime);
    await admin.save();

    res.json({
      _id: admin._id,
      email: admin.email,
      role: admin.role,
      employee: admin.employee,
      isActive: admin.isActive,
      canEditAttendanceTime: admin.canEditAttendanceTime
    });
  } catch (error) {
    console.error('Update admin attendance permission error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get all tenants
exports.getTenants = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { page = 1, limit = 10, search, status, plan } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.max(1, parseInt(limit, 10) || 10);

    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { companyName: { $regex: search, $options: 'i' } },
        { subdomain: { $regex: search, $options: 'i' } }
      ];
    }

    if (plan) {
      query['subscription.plan'] = plan;
    }

    if (status) {
      if (status === 'active') {
        query.isActive = true;
        query['subscription.status'] = 'active';
      } else if (status === 'trial') {
        query.isActive = true;
        query['subscription.status'] = 'trial';
      } else if (status === 'suspended') {
        query.isActive = false;
      }
    }

    const tenants = await Tenant.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNumber)
      .skip((pageNumber - 1) * limitNumber)
      .populate('createdBy', 'name email');

    const total = await Tenant.countDocuments(query);

    res.json({
      tenants,
      totalPages: Math.ceil(total / limitNumber),
      currentPage: pageNumber,
      total
    });
  } catch (error) {
    console.error('Get tenants error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get single tenant
exports.getTenant = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const param = req.params.id;
    let tenant = null;

    // If param looks like an ObjectId, try findById first, otherwise try subdomain/name
    if (mongoose.Types.ObjectId.isValid(param)) {
      tenant = await Tenant.findById(param).populate('createdBy', 'name email');
    }

    if (!tenant) {
      // Try to find by subdomain or name (case-insensitive)
      tenant = await Tenant.findOne({
        $or: [
          { subdomain: param.toLowerCase() },
          { name: new RegExp(`^${param}$`, 'i') }
        ]
      }).populate('createdBy', 'name email');
    }
    
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    res.json(tenant);
  } catch (error) {
    console.error('Get tenant error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Update tenant
exports.updateTenant = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const {
      name,
      companyName,
      description,
      contactEmail,
      phone,
      address,
      industry,
      size,
      settings,
      subscription,
      isActive
    } = req.body;

  const param = req.params.id;
    let tenant = null;
    if (mongoose.Types.ObjectId.isValid(param)) {
      tenant = await Tenant.findById(param);
    }
    if (!tenant) {
      tenant = await Tenant.findOne({
        $or: [
          { subdomain: param.toLowerCase() },
          { name: new RegExp(`^${param}$`, 'i') }
        ]
      });
    }
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    // Update fields
    Object.assign(tenant, {
      name: name || tenant.name,
      // allow updating portalUrl explicitly (normalize to remove '/hrm' if present)
      portalUrl: req.body.portalUrl !== undefined
        ? (req.body.portalUrl ? normalizePortalUrl(req.body.portalUrl, (req.body.subdomain || tenant.subdomain)) : null)
        : tenant.portalUrl,
      companyName: companyName || tenant.companyName,
      description: description || tenant.description,
      contactEmail: contactEmail || tenant.contactEmail,
      phone: phone || tenant.phone,
      address: address || tenant.address,
      industry: industry || tenant.industry,
      size: size || tenant.size,
      settings: settings || tenant.settings,
      isActive: isActive !== undefined ? isActive : tenant.isActive
    });

    if (subscription) {
      tenant.subscription = { ...tenant.subscription, ...subscription };
    }

    await tenant.save();
    res.json(tenant);
  } catch (error) {
    console.error('Update tenant error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Delete tenant (soft delete)
exports.deleteTenant = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const param = req.params.id;
    let tenant = null;
    if (mongoose.Types.ObjectId.isValid(param)) {
      tenant = await Tenant.findById(param);
    }
    if (!tenant) {
      tenant = await Tenant.findOne({
        $or: [
          { subdomain: param.toLowerCase() },
          { name: new RegExp(`^${param}$`, 'i') }
        ]
      });
    }
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    tenant.isActive = false;
    const subscriptionSnapshot = tenant.subscription
      ? (typeof tenant.subscription.toObject === 'function'
        ? tenant.subscription.toObject()
        : tenant.subscription)
      : {};
    tenant.subscription = {
      ...subscriptionSnapshot,
      status: 'suspended'
    };
    await tenant.save();

    res.json({ message: 'Tenant deactivated successfully' });
  } catch (error) {
    console.error('Delete tenant error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get tenant statistics
exports.getTenantStats = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const totalTenants = await Tenant.countDocuments();
    const activeTenants = await Tenant.countDocuments({ isActive: true });
    const trialTenants = await Tenant.countDocuments({ 'subscription.status': 'trial' });
    const paidTenants = await Tenant.countDocuments({ 
      'subscription.status': 'active',
      'subscription.plan': { $in: ['basic', 'premium', 'enterprise'] }
    });

    // Recent tenants
    const recentTenants = await Tenant.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name companyName subdomain subscription.plan createdAt');

    res.json({
      totalTenants,
      activeTenants,
      trialTenants,
      paidTenants,
      recentTenants
    });
  } catch (error) {
    console.error('Get tenant stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
