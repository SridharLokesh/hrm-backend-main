const { connectMainDB, getSuperAdminModels } = require('../config/db');
require('dotenv').config();

const createSuperAdmin = async () => {
  try {
    // Connect to super admin database
    await connectMainDB();
    const { SuperAdmin } = getSuperAdminModels();
    
    // Check if super admin already exists
    const superAdminExists = await SuperAdmin.findOne({ email: 'superadmin@hrm.com' });
    
    if (!superAdminExists) {
      await SuperAdmin.create({
        name: 'System Super Admin',
        email: 'superadmin@hrm.com',
        password: 'superadmin123',
        role: 'super-admin'
      });
      console.log('✅ Super admin created successfully in hrm_superadmin database');
      console.log('📧 Email: superadmin@hrm.com');
      console.log('🔑 Password: superadmin123');
      console.log('🏢 Database: hrm_superadmin');
    } else {
      console.log('ℹ️  Super admin already exists in hrm_superadmin database');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating super admin:', error);
    process.exit(1);
  }
};

createSuperAdmin();