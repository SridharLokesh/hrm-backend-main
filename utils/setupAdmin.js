const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const User = require('../models/User');
require('dotenv').config();

const createAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    
    // Check if admin already exists
    const adminExists = await User.findOne({ email: 'admin@hrm.com' });
    
    if (!adminExists) {
      // Create admin employee record
      const adminEmployee = await Employee.create({
        name: 'System Administrator',
        email: 'admin@hrm.com',
        department: 'Administration',
        position: 'System Administrator',
        salary: 0,
        employmentType: 'full-time'
      });

      // Create admin user account
      await User.create({
        email: 'admin@hrm.com',
        password: 'admin123',
        role: 'admin',
        employee: adminEmployee._id
      });

      console.log('Admin user created successfully');
      console.log('Email: admin@hrm.com');
      console.log('Password: admin123');
    } else {
      console.log('Admin user already exists');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin:', error);
    process.exit(1);
  }
};

createAdmin();