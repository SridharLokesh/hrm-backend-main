require('node:dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const { connectMainDB, getSuperAdminModels, connectTenantDB, getTenantModels } = require('../config/db');

async function test() {
  try {
    await connectMainDB();
    const superAdminModels = getSuperAdminModels();
    console.log('Superadmin models loaded.');
    
    // Find a tenant to test
    const tenant = await superAdminModels.Tenant.findOne();
    if (!tenant) {
      console.log('No tenant found. Seeding first?');
      return;
    }
    console.log(`Testing with tenant: ${tenant.companyName}`);
    
    const tenantConn = await connectTenantDB(tenant._id.toString(), tenant.companyName);
    const tenantModels = await getTenantModels(tenantConn);
    console.log('Tenant models loaded.');
    
    // Query attendance and populate checkInLocation
    const att = await tenantModels.Attendance.find().populate('checkInLocation');
    console.log('Successfully queried attendance, length:', att.length);
    if (att.length > 0) {
      console.log('Sample checkInLocation:', att[0].checkInLocation);
    }
  } catch (err) {
    console.error('Error during test:', err);
  } finally {
    if (mongoose.connection) {
      await mongoose.connection.close();
    }
    process.exit(0);
  }
}

test();
