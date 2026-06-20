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