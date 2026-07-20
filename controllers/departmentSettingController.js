const mongoose = require('mongoose');
const DefaultDepartmentSetting = require('../models/DepartmentSetting');

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

// @desc    Get all department shift requirements
// @route   GET /api/department-settings
// @access  Private/Admin
exports.getDepartmentSettings = async (req, res) => {
  try {
    const DepartmentSetting = resolveModel(req, 'DepartmentSetting', DefaultDepartmentSetting);
    
    const settings = await DepartmentSetting.find({ tenant: req.tenant._id });
    
    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    console.error('Get department settings error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Create a new department
// @route   POST /api/department-settings
// @access  Private/Admin
exports.createDepartmentSetting = async (req, res) => {
  try {
    const DepartmentSetting = resolveModel(req, 'DepartmentSetting', DefaultDepartmentSetting);
    const { departmentName, shiftRequired } = req.body;

    const name = String(departmentName || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Department name is required' });
    }

    // Case-insensitive duplicate check (schema's unique index is case-sensitive,
    // so "IT" and "it" would otherwise both pass the index but confuse users)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await DepartmentSetting.findOne({
      tenant: req.tenant._id,
      departmentName: { $regex: `^${escaped}$`, $options: 'i' }
    });

    if (existing) {
      return res.status(409).json({ success: false, message: `Department "${name}" already exists` });
    }

    const setting = await DepartmentSetting.create({
      tenant: req.tenant._id,
      departmentName: name,
      shiftRequired: !!shiftRequired
    });

    res.status(201).json({
      success: true,
      data: setting,
      message: `Department "${name}" created`
    });
  } catch (error) {
    console.error('Create department setting error:', error);
    // Race-condition duplicate caught by the schema's unique index
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Department already exists' });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Update department shift requirement
// @route   PUT /api/department-settings/:departmentName
// @access  Private/Admin
exports.updateDepartmentSetting = async (req, res) => {
  try {
    const DepartmentSetting = resolveModel(req, 'DepartmentSetting', DefaultDepartmentSetting);
    const { departmentName } = req.params;
    const { shiftRequired } = req.body;
    
    let setting = await DepartmentSetting.findOne({
      tenant: req.tenant._id,
      departmentName
    });
    
    if (setting) {
      setting.shiftRequired = shiftRequired;
      setting.updatedAt = new Date();
      await setting.save();
    } else {
      setting = await DepartmentSetting.create({
        tenant: req.tenant._id,
        departmentName,
        shiftRequired
      });
    }
    
    res.json({
      success: true,
      data: setting,
      message: `Department "${departmentName}" shift requirement updated to ${shiftRequired ? 'REQUIRED' : 'NOT REQUIRED'}`
    });
  } catch (error) {
    console.error('Update department setting error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Delete a department — blocked if active employees still use it
// @route   DELETE /api/department-settings/:departmentName
// @access  Private/Admin
exports.deleteDepartmentSetting = async (req, res) => {
  try {
    const DepartmentSetting = resolveModel(req, 'DepartmentSetting', DefaultDepartmentSetting);
    const { departmentName } = req.params;

    const setting = await DepartmentSetting.findOne({
      tenant: req.tenant._id,
      departmentName
    });

    if (!setting) {
      return res.status(404).json({ success: false, message: `Department "${departmentName}" not found` });
    }

    // Guard against orphaning employees still assigned to this department.
    // Employee model is tenant-scoped the same way as DepartmentSetting (req.models).
    const Employee = req.models && req.models.Employee;
    if (Employee) {
      const activeCount = await Employee.countDocuments({
        tenant: req.tenant._id,
        department: departmentName,
        isActive: true
      });

      if (activeCount > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot delete "${departmentName}" — ${activeCount} active employee(s) are assigned to it. Reassign them first.`
        });
      }
    }

    await DepartmentSetting.deleteOne({ _id: setting._id });

    res.json({
      success: true,
      message: `Department "${departmentName}" removed successfully`
    });
  } catch (error) {
    console.error('Delete department setting error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get departments that require shift
// @route   GET /api/department-settings/required
// @access  Private/Admin
exports.getRequiredDepartments = async (req, res) => {
  try {
    const DepartmentSetting = resolveModel(req, 'DepartmentSetting', DefaultDepartmentSetting);
    
    const settings = await DepartmentSetting.find({
      tenant: req.tenant._id,
      shiftRequired: true
    });
    
    res.json({
      success: true,
      data: settings.map(s => s.departmentName)
    });
  } catch (error) {
    console.error('Get required departments error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};