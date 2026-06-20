require('node:dns').setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const SuperAdminSchema = require('../models/SuperAdmin');
const TenantSchema = require('../models/Tenant');
const CompanySchemaMain = require('../models/Company'); // for main DB

// Tenant schemas (imported as schemas)
const CompanySchemaTenant = require('../models/Company');
const UserSchema = require('../models/User');
const EmployeeSchema = require('../models/Employee');
const AttendanceSchema = require('../models/Attendance');
const LeaveSchema = require('../models/Leave');
const PayrollSchema = require('../models/Payroll');
const PermissionSchema = require('../models/Permission');
const ProjectSchema = require('../models/Project');
const TaskSchema = require('../models/Task');
const NotificationSchema = require('../models/Notification');

// Parse args
const args = process.argv.slice(2);
const CLEAR_EXISTING = args.includes('--clear');

async function seedAll() {
  console.log('🚀 Starting HRMS Full Database Seeding...');
  console.log(`Clear mode: ${CLEAR_EXISTING ? 'YES (⚠️ DELETES ALL DATA)' : 'NO (idempotent skip)'}\n`);

  try {
    // 1. Connect main DB (superadmin)
    await db.connectMainDB();
    const mainModels = db.getSuperAdminModels();
    console.log('✅ Main DB connected');

    // 1a. Seed SuperAdmin (if not exists)
    let superAdmin = await mainModels.SuperAdmin.findOne({ email: 'superadmin@hrm.com' });
    if (!superAdmin) {
      const salt = await bcrypt.genSalt(10);
      const hashedPw = await bcrypt.hash('SuperPass123', salt);
      superAdmin = new mainModels.SuperAdmin({
        name: 'System Super Admin',
        email: 'superadmin@hrm.com',
        password: hashedPw,
        role: 'super-admin',
        permissions: [
          { module: 'tenants', canRead: true, canWrite: true, canDelete: true },
          { module: 'users', canRead: true, canWrite: true, canDelete: true }
        ]
      });
      await superAdmin.save();
      console.log('✅ SuperAdmin created');
    } else {
      console.log('ℹ️ SuperAdmin already exists');
    }

    // 2. Create 2 sample tenants
    const tenantsData = [
      {
        name: 'Appu',
        subdomain: 'appu',
        companyName: 'Focus Engineering Solutions',
        contactEmail: 'contact@sampleco.com',
        phone: '+1-555-0101',
        address: { street: '123 Main St', city: 'Sampleville', state: 'CA', country: 'USA', zipCode: '90210' },
        industry: 'Technology',
        size: '11-50',
        settings: { timezone: 'America/Los_Angeles', currency: 'USD' },
        subscription: { plan: 'premium', status: 'active', maxEmployees: 50 }
      }
    ];

    const tenants = [];
    for (const tData of tenantsData) {
      let tenant = await mainModels.Tenant.findOne({ subdomain: tData.subdomain });
      if (!tenant) {
        tenant = new mainModels.Tenant({ ...tData, createdBy: superAdmin._id });
        await tenant.save();
        console.log(`✅ Tenant created: ${tData.subdomain}`);
      } else {
        console.log(`ℹ️ Tenant exists: ${tData.subdomain}`);
      }
      tenants.push(tenant);
    }

    // 3. Seed each tenant DB
    for (const tenant of tenants) {
      console.log(`\n🏢 Seeding Tenant: ${tenant.companyName} (${tenant.subdomain})`);
      
      // Ensure tenant DB exists (MongoDB Atlas requires initial document)
      const createDatabaseName = require('../config/db').createDatabaseName;
      const dbName = createDatabaseName(tenant.companyName);
      console.log(`📦 Ensuring tenant DB exists: ${dbName}`);
      try {
        await mainDBConnection.db.admin().runCommand({ create: dbName });
        console.log(`✅ Created tenant DB: ${dbName}`);
      } catch (createErr) {
        if (createErr.codeName !== 'NamespaceExists') {
          console.warn(`⚠️ Could not create DB ${dbName}:`, createErr.message);
        }
      }
      
      // Connect tenant DB
      const tenantConn = await db.connectTenantDB(tenant._id, tenant.companyName);
      const models = await db.getTenantModels(tenantConn);
      
      if (CLEAR_EXISTING) {
        const collections = ['users', 'employees', 'company', 'attendance', 'leaves', 'payrolls', 'permissions', 'projects', 'tasks', 'notifications'];
        for (const coll of collections) {
          await tenantConn.collection(coll).deleteMany({});
        }
        console.log('🧹 Cleared existing data');
      }

      // 3.1 Company (tenant-specific)
      let company = await models.Company.findOne();
      if (!company) {
        company = new models.Company({
          name: tenant.companyName,
          logo: 'https://via.placeholder.com/150x50/007bff/ffffff?text=LOGO',
          address: tenant.address,
          contact: { email: tenant.contactEmail, phone: tenant.phone },
          settings: tenant.settings
        });
        await company.save();
        console.log('✅ Company seeded');
      }

      // 3.2 Employees (5)
      const employeesData = [
        { name: 'John Manager', email: `manager@${tenant.subdomain}.com`, department: 'Management', position: 'HR Manager', salary: 85000, gender: 'male', phone: '+1-555-1001' },
        { name: 'Jane Doe', email: `jane@${tenant.subdomain}.com`, department: 'Engineering', position: 'Senior Developer', salary: 75000, gender: 'female', phone: '+1-555-1002' },
        { name: 'Bob Smith', email: `bob@${tenant.subdomain}.com`, department: 'Engineering', position: 'Developer', salary: 65000, gender: 'male', phone: '+1-555-1003' },
        { name: 'Alice Johnson', email: `alice@${tenant.subdomain}.com`, department: 'HR', position: 'HR Assistant', salary: 45000, gender: 'female', phone: '+1-555-1004' },
        { name: 'Charlie Brown', email: `charlie@${tenant.subdomain}.com`, department: 'Sales', position: 'Sales Executive', salary: 55000, gender: 'male', phone: '+1-555-1005' }
      ];
      const employees = [];
      for (const eData of employeesData.map((ed, i) => ({...ed, workMode: ['wfo','hybrid','wfh'][i%3], employmentType: 'full-time' }))) {
        const existing = await models.Employee.findOne({ email: eData.email });
        if (!existing) {
          const emp = new models.Employee({
            ...eData,
            address: { street: '123 Sample St', city: 'Sampleville', state: 'CA', country: 'USA', zipCode: '90210' },
            emergencyContact: { name: 'Emergency Contact', relationship: 'Spouse', phone: '+1-555-9000' },
            bankDetails: { accountNumber: `123456789${eData.email.slice(-1)}`, bankName: 'Sample Bank', branch: 'Main', ifscCode: 'SAMPLE0001' },
            documents: [{ name: 'ID Proof', documentType: 'Aadhar', url: 'https://example.com/doc1.pdf' }]
          });
          await emp.save();
          employees.push(emp);
          console.log(`  ✅ Employee: ${eData.name}`);
        }
      }

      // 3.3 Users (linked to employees)
      const pwSalt = await bcrypt.genSalt(10);
      const pwHash = await bcrypt.hash('password123', pwSalt); // Common pw
      for (let i = 0; i < employees.length; i++) {
        const existingUser = await models.User.findOne({ email: employees[i].email });
        if (!existingUser) {
          const user = new models.User({
            email: employees[i].email,
            password: pwHash,
            role: ['admin','manager','employee','employee','employee'][i],
            employee: employees[i]._id,
            tenant: tenant._id,
            mobileAllowed: true
          });
          await user.save();
          console.log(`  ✅ User: ${employees[i].email} (${user.role})`);
        }
      }
      const users = await models.User.find({ tenant: tenant._id });

      // 3.4 Permissions (5)
      const permsData = [
        { permissionType: 'half-day', startTime: new Date('2024-01-15T09:00:00'), endTime: new Date('2024-01-15T13:00:00'), reason: 'Medical appointment', employee: employees[1]._id },
        { permissionType: 'late-arrival', startTime: new Date('2024-01-16T10:30:00'), endTime: new Date('2024-01-16T11:00:00'), reason: 'Traffic delay', employee: employees[2]._id },
        { permissionType: 'short-leave', startTime: new Date('2024-01-17T14:00:00'), endTime: new Date('2024-01-17T15:00:00'), reason: 'Bank work', employee: employees[3]._id },
        { permissionType: 'early-departure', startTime: new Date('2024-01-18T16:00:00'), endTime: new Date('2024-01-18T17:00:00'), reason: 'Family event', employee: employees[4]._id },
        { permissionType: 'break-extension', startTime: new Date('2024-01-19T12:30:00'), endTime: new Date('2024-01-19T13:30:00'), reason: 'Extended lunch', employee: employees[0]._id, status: 'approved' }
      ];
      for (const pData of permsData) {
        const existing = await models.Permission.findOne({ employee: pData.employee, date: pData.startTime.toDateString() });
        if (!existing) {
          const perm = new models.Permission(pData);
          await perm.save();
        }
      }
      console.log('  ✅ Permissions seeded');

      // 3.5 Projects (2)
      const projectsData = [
        { name: 'Website Redesign', description: 'Complete redesign of company website', assignedEmployees: [employees[1]._id, employees[2]._id], startDate: new Date('2024-01-01'), endDate: new Date('2024-03-01'), createdBy: users[1]._id },
        { name: 'Mobile App v2.0', description: 'Develop new features for mobile app', assignedEmployees: [employees[2]._id, employees[4]._id], startDate: new Date('2024-02-01'), endDate: new Date('2024-05-01'), createdBy: users[0]._id }
      ];
      const projects = [];
      for (const prData of projectsData) {
        const existing = await models.Project.findOne({ name: prData.name });
        if (!existing) {
          const proj = new models.Project({ ...prData, tenant: tenant._id });
          await proj.save();
          projects.push(proj);
        }
      }
      console.log('  ✅ Projects seeded');

      // 3.6 Tasks (10)
      const tasksData = [
        { title: 'Design homepage', project: projects[0]._id, assignedTo: employees[1]._id, priority: 'high', deadline: new Date('2024-01-20'), estimatedHours: 20, createdBy: users[1]._id, tenant: tenant._id, progress: 80, updates: [{ progress: 80, note: 'Design completed', userId: users[1]._id }] },
        { title: 'API integration', project: projects[0]._id, assignedTo: employees[2]._id, priority: 'medium', deadline: new Date('2024-01-25'), estimatedHours: 15, createdBy: users[0]._id, tenant: tenant._id },
        { title: 'App UI mockups', project: projects[1]._id, assignedTo: employees[2]._id, priority: 'low', deadline: new Date('2024-02-15'), estimatedHours: 10, actualHours: 8, progress: 100, status: 'done', createdBy: users[0]._id, tenant: tenant._id },
        { title: 'Backend setup', project: projects[1]._id, assignedTo: employees[4]._id, priority: 'high', deadline: new Date('2024-02-10'), estimatedHours: 25, createdBy: users[0]._id, tenant: tenant._id },
        { title: 'Testing phase 1', project: projects[0]._id, assignedTo: employees[3]._id, priority: 'medium', deadline: new Date('2024-02-05'), estimatedHours: 12, progress: 50, updates: [{ progress: 50, note: 'Unit tests passing', userId: users[3]._id }], createdBy: users[1]._id, tenant: tenant._id },
        { title: 'Deployment script', project: projects[1]._id, assignedTo: employees[1]._id, priority: 'high', deadline: new Date('2024-02-20'), estimatedHours: 8, createdBy: users[1]._id, tenant: tenant._id },
        { title: 'Content migration', project: projects[0]._id, assignedTo: employees[4]._id, priority: 'low', deadline: new Date('2024-01-30'), estimatedHours: 5, progress: 30, createdBy: users[0]._id, tenant: tenant._id },
        { title: 'Performance optimization', project: projects[1]._id, assignedTo: employees[2]._id, priority: 'medium', deadline: new Date('2024-03-01'), estimatedHours: 18, createdBy: users[0]._id, tenant: tenant._id },
        { title: 'User documentation', project: projects[0]._id, assignedTo: employees[3]._id, priority: 'low', deadline: new Date('2024-02-28'), estimatedHours: 6, createdBy: users[1]._id, tenant: tenant._id },
        { title: 'Final review', project: projects[1]._id, assignedTo: employees[0]._id, priority: 'high', deadline: new Date('2024-04-01'), estimatedHours: 4, status: 'review', progress: 90, createdBy: users[0]._id, tenant: tenant._id }
      ];
      for (const taskData of tasksData) {
        const existing = await models.Task.findOne({ title: taskData.title });
        if (!existing) {
          const task = new models.Task(taskData);
          await task.save();
        }
      }
      console.log('  ✅ Tasks seeded');

      // 3.7 Attendance (20 records covering geo, permissions, statuses)
      const baseDate = new Date('2024-01-20');
      for (let i = 0; i < 20; i++) {
        const emp = employees[i % 5];
      const attDate = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000);
        const startOfDay = new Date(attDate.getFullYear(), attDate.getMonth(), attDate.getDate());
        const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
        const existing = await models.Attendance.findOne({ employee: emp._id, date: { $gte: startOfDay, $lt: endOfDay } });
        if (!existing) {
          const att = new models.Attendance({
            employee: emp._id,
            date: attDate,
            checkIn: new Date(attDate.getTime() + (9*60+30)*60000), // 9:30 AM
            checkInLat: 37.7749 + (Math.random()-0.5)*0.01,
            checkInLng: -122.4194 + (Math.random()-0.5)*0.01,
            checkInAccuracy: 10 + Math.random()*20,
            checkInPlace: 'Office HQ',
            checkOut: new Date(attDate.getTime() + (18*60)*60000), // 6 PM
            checkOutLat: 37.7749 + (Math.random()-0.5)*0.01,
            checkOutLng: -122.4194 + (Math.random()-0.5)*0.01,
            checkOutPlace: 'Office HQ',
            permissions: i % 3 === 0 ? [{ permission: (await models.Permission.findOne({employee: emp._id}))?._id, type: 'short-leave', duration: 1 }] : [],
            status: i % 4 === 0 ? 'half-day' : 'present'
          });
          await att.save();
        }
      }
      console.log('  ✅ Attendance seeded (20 records)');

      // 3.8 Leaves (5)
      const leavesData = [
        { employee: employees[1]._id, leaveType: 'sick', startDate: new Date('2024-01-22'), endDate: new Date('2024-01-23'), reason: 'Flu', status: 'approved', approvedBy: employees[0]._id },
        { employee: employees[2]._id, leaveType: 'casual', startDate: new Date('2024-01-25'), endDate: new Date('2024-01-25'), reason: 'Personal work', status: 'pending' },
        { employee: employees[3]._id, leaveType: 'annual', startDate: new Date('2024-02-01'), endDate: new Date('2024-02-05'), reason: 'Vacation', status: 'approved', approvedBy: employees[0]._id },
        { employee: employees[4]._id, leaveType: 'comp-off', startDate: new Date('2024-01-28'), endDate: new Date('2024-01-28'), reason: 'Worked weekend', status: 'rejected' },
        { employee: employees[0]._id, leaveType: 'maternity', startDate: new Date('2024-03-01'), endDate: new Date('2024-03-15'), reason: 'Maternity leave', status: 'approved', approvedBy: employees[1]._id }
      ];
      for (const lData of leavesData) {
        const existing = await models.Leave.findOne({ employee: lData.employee, startDate: lData.startDate });
        if (!existing) {
          const leave = new models.Leave(lData);
          await leave.save();
        }
      }
      console.log('  ✅ Leaves seeded');

      // 3.9 Payroll (5 for Jan 2024)
      const payrollsData = [
        { employee: employees[0]._id, month: 1, year: 2024, basicSalary: 85000/12, allowances: 2000, deductions: 1500, workingDays: 22, presentDays: 20, leaveDays: 2, netSalary: (85000/12 + 2000 - 1500), status: 'paid' },
        { employee: employees[1]._id, month: 1, year: 2024, basicSalary: 75000/12, allowances: 1500, deductions: 1000, workingDays: 22, presentDays: 21, leaveDays: 1, netSalary: (75000/12 + 1500 - 1000) },
        { employee: employees[2]._id, month: 1, year: 2024, basicSalary: 65000/12, allowances: 1000, deductions: 800, workingDays: 22, presentDays: 19, leaveDays: 3, netSalary: (65000/12 + 1000 - 800) },
        { employee: employees[3]._id, month: 1, year: 2024, basicSalary: 45000/12, allowances: 500, deductions: 300, workingDays: 22, presentDays: 22, leaveDays: 0, netSalary: (45000/12 + 500 - 300) },
        { employee: employees[4]._id, month: 1, year: 2024, basicSalary: 55000/12, allowances: 800, deductions: 500, workingDays: 22, presentDays: 20, leaveDays: 2, netSalary: (55000/12 + 800 - 500) }
      ];
      for (const pData of payrollsData) {
        const existing = await models.Payroll.findOne({ employee: pData.employee, month: pData.month, year: pData.year });
        if (!existing) {
          const payroll = new models.Payroll(pData);
          await payroll.save();
        }
      }
      console.log('  ✅ Payroll seeded');

      // 3.10 Notifications (10)
      const notifData = [
        { user: users[0]._id, employee: employees[0]._id, title: 'Welcome!', message: 'Welcome to HRMS SampleCo', type: 'general', tenant: tenant._id },
        { user: users[1]._id, employee: employees[1]._id, title: 'Task assigned', message: 'Homepage design assigned', type: 'task-assigned', relatedEntity: 'task', entityId: 'TASK2024001', tenant: tenant._id },
        { user: users[2]._id, employee: employees[2]._id, title: 'Project deadline approaching', message: 'Mobile App v2.0 due soon', type: 'deadline-reminder', relatedEntity: 'project', entityId: projects[1]._id, tenant: tenant._id },
        { user: users[3]._id, employee: employees[3]._id, title: 'Leave approved', message: 'Your annual leave approved', type: 'general', tenant: tenant._id },
        { user: users[4]._id, employee: employees[4]._id, title: 'Payroll processed', message: 'January payroll available', type: 'general', tenant: tenant._id },
        { user: users[0]._id, employee: employees[0]._id, title: 'New employee joined', message: 'Charlie Brown joined Sales', type: 'general', tenant: tenant._id },
        { user: users[1]._id, employee: employees[1]._id, title: 'Task progress update', message: 'API integration 50% complete', type: 'task-updated', relatedEntity: 'task', entityId: 'TASK2024002', tenant: tenant._id },
        { user: users[2]._id, employee: employees[2]._id, title: 'Permission approved', message: 'Your short leave approved', type: 'general', tenant: tenant._id },
        { user: users[3]._id, employee: employees[3]._id, title: 'Attendance reminder', message: 'Mark your attendance daily', type: 'general', tenant: tenant._id },
        { user: users[4]._id, employee: employees[4]._id, title: 'Project assigned', message: 'Website Redesign assigned to you', type: 'project-assigned', relatedEntity: 'project', entityId: projects[0]._id, tenant: tenant._id }
      ];
      for (const nData of notifData) {
        const existing = await models.Notification.findOne({ user: nData.user, title: nData.title });
        if (!existing) {
          const notif = new models.Notification(nData);
          await notif.save();
        }
      }
      console.log('  ✅ Notifications seeded');

      console.log(`✅ Tenant ${tenant.companyName} fully seeded!`);
    }

    console.log('\n🎉 SEEDING COMPLETE! Summary:');
    console.log('- SuperAdmin: 1');
    console.log('- Tenants: 2');
    console.log('- Per tenant: Company(1), Employees/Users(5), Permissions(5), Projects(2), Tasks(10), Attendance(20), Leaves(5), Payroll(5), Notifications(10)');
    console.log('\n📱 Login creds:');
    console.log('SuperAdmin: superadmin@hrm.com / SuperPass123');
    console.log('Tenant users: {email} / password123 (e.g., manager@sampleco.com)');
    console.log('\n💡 Run with --clear to reset data.');

  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
    process.exit(1);
  } finally {
    // Graceful close (non-blocking)
    mongoose.connection.close(false).catch(() => {});
  }
}

// Run if direct execution
if (require.main === module) {
  seedAll().catch(console.error);
}

module.exports = { seedAll };

