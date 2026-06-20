const mongoose = require('mongoose');

// Cache for tenant database connections
// Each entry is: tenantId => { conn: mongoose.Connection, lastUsed: number }
const tenantConnections = new Map();
let mainDBConnection = null;
const ShiftSchema = require('../models/Shift');
const DepartmentSettingSchema = require('../models/DepartmentSetting');
const CounterSchema = require('../models/Counter');
const DailyUpdateSchema = require('../models/DailyUpdate'); // add this


// Global connection pool & cache settings (tune via env)
const MAX_TOTAL_CONNECTIONS = parseInt(process.env.TENANT_DB_MAX_CONNECTIONS || '100', 10);
const MAX_POOL_SIZE_PER_DB = parseInt(process.env.MONGODB_MAX_POOL_SIZE || '10', 10);
const SERVER_SELECTION_TIMEOUT = parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT || '30000', 10);
const CONNECTION_TIMEOUT = parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS || '30000', 10);
const TENANT_IDLE_MS = parseInt(process.env.TENANT_DB_IDLE_MS || String(10 * 60 * 1000), 10); // 10 minutes

// Track total connections to prevent exceeding limits
let totalConnections = 0;

const connectMainDB = async () => {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 2000; // 2s

  if (!process.env.MONGODB_URI) {
    const msg = 'MONGODB_URI is not set in environment. Please set it in your .env or deployment settings.';
    console.error('❌', msg);
    throw new Error(msg);
  }

  // Build main DB URI by replacing the placeholder DB name if present
  const mainDBUri = process.env.MONGODB_URI.includes('/hrm-saas-main')
    ? process.env.MONGODB_URI.replace('/hrm-saas-main', '/hrm_superadmin')
    : process.env.MONGODB_URI;

  // Masked URI for logging (hide user/pass)
  const maskedUri = mainDBUri.replace(/:\/\/(.*)@/, '://<credentials>@');

  const connectionOptions = {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT,
    connectTimeoutMS: CONNECTION_TIMEOUT,
    socketTimeoutMS: 45000,
    maxPoolSize: MAX_POOL_SIZE_PER_DB,
    minPoolSize: 1,
    maxIdleTimeMS: TENANT_IDLE_MS,
    // useUnifiedTopology is default in modern mongoose, but ensure compatibility
    useUnifiedTopology: true,
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`🔗 Connecting to Super Admin Database (attempt ${attempt}/${MAX_ATTEMPTS}) - ${maskedUri}`);

      // createConnection is synchronous for return; wait for 'open' or 'error'
      const conn = mongoose.createConnection(mainDBUri, connectionOptions);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Main DB connection open timed out'));
        }, SERVER_SELECTION_TIMEOUT + 5000);

        conn.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        conn.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // Final verification ping
      await conn.db.admin().ping();

      mainDBConnection = conn;
      totalConnections++;
      console.log('✅ Super Admin database connected: hrm_superadmin');
      return mainDBConnection;
    } catch (error) {
      console.error(`❌ Super Admin DB connect attempt ${attempt} failed:`, error.message);
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // After final attempt, give helpful guidance
      const guidance = `Could not connect to MongoDB after ${MAX_ATTEMPTS} attempts. ` +
        'Check network/DNS, MongoDB URI, Atlas IP access list, and that your credentials are correct.';

      console.error('❌ Super Admin database connection error:', error.message);
      console.error('ℹ️ Guidance:', guidance);
      throw new Error(`${error.message} - ${guidance}`);
    }
  }
};

// Connect to a specific tenant database with connection limit management
const connectTenantDB = async (tenantId, companyName) => {
  try {
    // If we have an existing wrapper, return its raw connection after health-check
    if (tenantConnections.has(tenantId)) {
      const wrapper = tenantConnections.get(tenantId);
      const existingConnection = wrapper && wrapper.conn ? wrapper.conn : wrapper;
      try {
        if (!existingConnection || !existingConnection.db || !existingConnection.db.admin) {
          throw new Error('Existing tenant connection object invalid');
        }
        await existingConnection.db.admin().ping();
        tenantConnections.set(tenantId, { conn: existingConnection, lastUsed: Date.now() });
        console.log(`✅ Reusing existing connection for: ${companyName}`);
        return existingConnection;
      } catch (pingError) {
        console.log(`🔄 Existing connection stale or invalid, recreating for: ${companyName}`);
        try { if (existingConnection && existingConnection.close) await existingConnection.close(); } catch (e) { /* ignore */ }
        tenantConnections.delete(tenantId);
        totalConnections = Math.max(0, totalConnections - 1);
      }
    }

    // Try to evict idle LRU connections before creating a new one
    await evictLeastRecentlyUsedIfNeeded();
    if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
      throw new Error(`Maximum connection limit reached (${MAX_TOTAL_CONNECTIONS}). Cannot create new tenant database.`);
    }

    // Create database name from company name
    const dbName = createDatabaseName(companyName);
    console.log(`🔗 Creating/Connecting to tenant database: ${dbName}`);

    // Build the database URI (preserve credentials/params from configured MONGODB_URI)
    const baseURI = process.env.MONGODB_URI.split('/').slice(0, -1).join('/');
    const tenantURI = `${baseURI}/${dbName}`;

    const connectionOptions = {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT,
      socketTimeoutMS: 30000,
      maxPoolSize: MAX_POOL_SIZE_PER_DB,
      minPoolSize: 1,
      maxIdleTimeMS: TENANT_IDLE_MS,
    };

    console.log(`Connecting to tenant DB (${tenantId}) - Total connections: ${totalConnections + 1}`);

    const tenantConnection = mongoose.createConnection(tenantURI, connectionOptions);

    // Wait for underlying driver to open if necessary
    if (!tenantConnection || !tenantConnection.db) {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Tenant connection open timed out'));
          }
        }, SERVER_SELECTION_TIMEOUT || 30000);

        tenantConnection.once('open', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });

        tenantConnection.once('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      });
    }

    if (!tenantConnection || !tenantConnection.db) {
      try { await tenantConnection.close(); } catch (e) { /* ignore */ }
      throw new Error('Failed to create tenant connection object');
    }

    // Verify connection
    try {
      await tenantConnection.db.admin().ping();
    } catch (pingErr) {
      try { await tenantConnection.close(); } catch (e) { /* ignore */ }
      throw pingErr;
    }

    // store wrapper with lastUsed timestamp
    tenantConnections.set(tenantId, { conn: tenantConnection, lastUsed: Date.now() });
    totalConnections++;

    console.log(`✅ Tenant database connected: ${dbName} - Total connections: ${totalConnections}`);

    // ✅ FIX: Initialize tenant database BLOCKING — models must be registered
    // before any request (e.g. createEmployee) uses the connection.
    // Previously this was non-blocking (.catch only), which caused the Counter
    // model to be missing when the pre-save hook ran, leading to E11000 duplicate
    // key errors on employeeId.
    try {
      await initializeTenantDatabase(tenantConnection);
    } catch (err) {
      console.error('⚠️ Tenant database initialization failed:', err.message);
      // Non-fatal: connection still usable, but log clearly
    }

    return tenantConnection;
  } catch (error) {
    console.error(`❌ Tenant database connection error for ${companyName}:`, error.message);
    if (tenantConnections.has(tenantId)) {
      tenantConnections.delete(tenantId);
      totalConnections = Math.max(0, totalConnections - 1);
    }
    throw error;
  }
};

// Evict least-recently-used idle tenant connections to free up slots
const evictLeastRecentlyUsedIfNeeded = async () => {
  try {
    if (totalConnections < MAX_TOTAL_CONNECTIONS) return;

    // Convert map entries to array and sort by lastUsed ascending (oldest first)
    const entries = Array.from(tenantConnections.entries()).map(([tenantId, wrapper]) => ({ tenantId, wrapper }));
    entries.sort((a, b) => (a.wrapper.lastUsed || 0) - (b.wrapper.lastUsed || 0));

    for (const { tenantId, wrapper } of entries) {
      if (totalConnections < MAX_TOTAL_CONNECTIONS) break;
      const idleTime = Date.now() - (wrapper.lastUsed || 0);
      if (idleTime >= TENANT_IDLE_MS) {
        try {
          console.log(`🧹 Evicting idle tenant connection: ${tenantId} (idle ${Math.round(idleTime/1000)}s)`);
          if (wrapper && wrapper.conn && wrapper.conn.close) await wrapper.conn.close();
        } catch (e) {
          // ignore close errors
        }
        tenantConnections.delete(tenantId);
        totalConnections = Math.max(0, totalConnections - 1);
      }
    }
  } catch (e) {
    console.warn('Eviction error:', e.message);
  }
};

// Create clean database name from company name
const createDatabaseName = (companyName) => {
  if (!companyName) {
    throw new Error('Company name is required to create database');
  }
  
  let dbName = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  
  if (!dbName.startsWith('hrm_')) {
    dbName = `hrm_${dbName}`;
  }
  
  if (dbName.length > 50) {
    dbName = dbName.substring(0, 50);
  }
  
  return dbName;
};

// Initialize tenant database with all required collections
const initializeTenantDatabase = async (tenantConnection) => {
  try {
    if (!tenantConnection || !tenantConnection.db) {
      console.error('❌ initializeTenantDatabase called with invalid tenantConnection');
      return;
    }

    // Import schemas
    const UserSchema = require('../models/User');
    const EmployeeSchema = require('../models/Employee');
    const AttendanceSchema = require('../models/Attendance');
    const LeaveSchema = require('../models/Leave');
    const PayrollSchema = require('../models/Payroll');
    const CompanySchema = require('../models/Company');
    const PermissionSchema = require('../models/Permission');
    const ProjectSchema = require('../models/Project');
    const TaskSchema = require('../models/Task');
    const NotificationSchema = require('../models/Notification');
    const ShiftSchema = require('../models/Shift');
    const DepartmentSettingSchema = require('../models/DepartmentSetting');
    const CounterSchema = require('../models/Counter');

    // Register models with the tenant connection
    const registerModel = (name, schema) => {
      try {
        if (!tenantConnection.models[name]) {
          tenantConnection.model(name, schema);
        }
      } catch (err) {
        console.warn(`⚠️ Failed to register model ${name}:`, err.message);
      }
    };

    registerModel('User', UserSchema);
    registerModel('Employee', EmployeeSchema);
    registerModel('Attendance', AttendanceSchema);
    registerModel('Leave', LeaveSchema);
    registerModel('Payroll', PayrollSchema);
    registerModel('Company', CompanySchema);
    registerModel('Permission', PermissionSchema);
    registerModel('Project', ProjectSchema);
    registerModel('Task', TaskSchema);
    registerModel('Notification', NotificationSchema);
    registerModel('Shift', ShiftSchema);
    registerModel('DepartmentSetting', DepartmentSettingSchema);
    registerModel('Counter', CounterSchema); // ✅ Required for atomic employeeId generation
registerModel('DailyUpdate', DailyUpdateSchema);
    console.log('✅ Tenant database models initialized');
  } catch (error) {
    console.error('❌ Tenant database initialization error:', error.message);
  }
};

// Get current tenant connection (raw mongoose.Connection) based on tenantId
const getTenantConnection = (tenantId) => {
  const wrapper = tenantConnections.get(tenantId);
  if (!wrapper) return undefined;
  return wrapper.conn ? wrapper.conn : wrapper;
};

// Get models for a specific tenant with connection verification
const getTenantModels = async (tenantConnection) => {
  if (!tenantConnection) {
    throw new Error('Tenant connection is required');
  }

  // Accept either a wrapper ({conn,...}) or a raw connection
  const conn = tenantConnection.conn ? tenantConnection.conn : tenantConnection;

  if (!conn.db || !conn.db.admin) {
    throw new Error('Invalid tenant connection object (no db)');
  }

  // Verify connection is still alive
  try {
    await conn.db.admin().ping();
    // update lastUsed if we have a wrapper entry
    for (const [tid, wrapper] of tenantConnections.entries()) {
      if (wrapper && wrapper.conn === conn) {
        tenantConnections.set(tid, { conn, lastUsed: Date.now() });
        break;
      }
    }
  } catch (error) {
    console.error('❌ Tenant connection is dead or unresponsive:', error.message);
    throw new Error('Tenant database connection lost');
  }

  // Ensure Counter is registered in case getTenantModels is called on a
  // connection that was reused (skipped initializeTenantDatabase path)
  if (!conn.models['Counter']) {
    try {
      conn.model('Counter', require('../models/Counter'));
    } catch (err) {
      console.warn('⚠️ Could not register Counter model in getTenantModels:', err.message);
    }
  }
  if (!conn.models['DailyUpdate']) {
  try {
    conn.model('DailyUpdate', require('../models/DailyUpdate'));
  } catch (err) {
    console.warn('⚠️ Could not register DailyUpdate model in getTenantModels:', err.message);
  }
}

  return {
    User: conn.model('User'),
    Employee: conn.model('Employee'),
    Attendance: conn.model('Attendance'),
    Leave: conn.model('Leave'),
    Payroll: conn.model('Payroll'),
    Company: conn.model('Company'),
    Permission: conn.model('Permission'),
    Project: conn.model('Project'),
    Task: conn.model('Task'),
    Notification: conn.model('Notification'),
    Shift: conn.model('Shift'),
    DepartmentSetting: conn.model('DepartmentSetting'),
    Counter: conn.model('Counter'), // ✅ Exposed for direct use if needed
   DailyUpdate: conn.model('DailyUpdate')
  };
};

// Get models for tenant by ID with auto-reconnection
const getTenantModelsById = async (tenantId) => {
  const wrapper = tenantConnections.get(tenantId);
  if (!wrapper) {
    throw new Error(`No database connection found for tenant: ${tenantId}`);
  }

  const connection = wrapper.conn ? wrapper.conn : wrapper;

  // Verify connection health
  try {
    if (!connection.db || !connection.db.admin) throw new Error('Invalid connection object');
    await connection.db.admin().ping();
    // update lastUsed
    tenantConnections.set(tenantId, { conn: connection, lastUsed: Date.now() });
  } catch (error) {
    console.log(`🔄 Tenant connection ${tenantId} is stale, reconnecting...`);
    // Remove stale connection
    tenantConnections.delete(tenantId);
    totalConnections = Math.max(0, totalConnections - 1);
    throw new Error('Tenant database connection needs refresh');
  }

  return getTenantModels(connection);
};

// Get super admin models
const getSuperAdminModels = () => {
  const SuperAdmin = require('../models/SuperAdmin');
  const Tenant = require('../models/Tenant');
  const Company = require('../models/Company');
  const Location = require('../models/Location');

  if (mainDBConnection) {
    const registerModel = (name, mod) => {
      // Accept either a Model (exports a model) or a Schema (exports schema)
      const schema = mod && mod.schema ? mod.schema : mod;
      try {
        if (!mainDBConnection.models[name]) {
          return mainDBConnection.model(name, schema);
        }
        return mainDBConnection.models[name];
      } catch (err) {
        console.warn(`⚠️ Failed to register super admin model ${name}:`, err.message);
        // Fallback to mongoose default connection: prefer existing model if present
        if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
        return mongoose.model(name, schema);
      }
    };

    return {
      SuperAdmin: registerModel('SuperAdmin', SuperAdmin),
      Tenant: registerModel('Tenant', Tenant),
      Company: registerModel('Company', Company),
      Location: registerModel('Location', Location),
    };
  }

  // Fallback
  return {
    SuperAdmin,
    Tenant,
    Location,
  };
};

// Health check for all databases
const checkDatabaseHealth = async () => {
  const health = {
    superAdmin: 'unknown',
    tenants: {},
    totalConnections,
    maxConnections: MAX_TOTAL_CONNECTIONS
  };

  try {
    // Check super admin database
    if (mainDBConnection) {
      try {
        if (!mainDBConnection.db || !mainDBConnection.db.admin) throw new Error('Invalid mainDBConnection');
        await mainDBConnection.db.admin().ping();
        health.superAdmin = 'healthy';
      } catch (error) {
        health.superAdmin = 'unhealthy';
      }
    }

    // Check tenant databases (wrapper -> raw conn)
    for (const [tenantId, wrapper] of tenantConnections.entries()) {
      try {
        const connection = wrapper && wrapper.conn ? wrapper.conn : wrapper;
        if (!connection || !connection.db || !connection.db.admin) throw new Error('Invalid tenant connection');
        await connection.db.admin().ping();
        health.tenants[tenantId] = 'healthy';
      } catch (error) {
        health.tenants[tenantId] = 'unhealthy';
      }
    }

    return health;
  } catch (error) {
    console.error('Database health check error:', error);
    health.superAdmin = 'unhealthy';
    return health;
  }
};

// Clean up connections periodically
const cleanupStaleConnections = async () => {
  console.log('🧹 Checking for stale connections...');
  let cleaned = 0;

  for (const [tenantId, wrapper] of tenantConnections.entries()) {
    const connection = wrapper && wrapper.conn ? wrapper.conn : wrapper;
    try {
      if (!connection || !connection.db || !connection.db.admin) throw new Error('Invalid tenant connection');
      await connection.db.admin().ping();
      // Optionally evict if idle beyond TENANT_IDLE_MS
      const idle = Date.now() - (wrapper.lastUsed || 0);
      if (idle > TENANT_IDLE_MS) {
        console.log(`🧹 Closing idle connection for tenant: ${tenantId} (idle ${Math.round(idle/1000)}s)`);
        try { if (connection.close) await connection.close(); } catch (e) { /* ignore */ }
        tenantConnections.delete(tenantId);
        totalConnections = Math.max(0, totalConnections - 1);
        cleaned++;
      }
    } catch (error) {
      console.log(`🧹 Removing stale/invalid connection for tenant: ${tenantId}`);
      try { if (connection && connection.close) await connection.close(); } catch (e) { /* ignore */ }
      tenantConnections.delete(tenantId);
      totalConnections = Math.max(0, totalConnections - 1);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} stale connections`);
  }
};

// Get default models for fallback (non-tenant requests)
const getDefaultModels = () => {
  const schemas = {
    User: require('../models/User'),
    Employee: require('../models/Employee'),
    Attendance: require('../models/Attendance'),
    Leave: require('../models/Leave'),
    Payroll: require('../models/Payroll'),
    Company: require('../models/Company'),
    Permission: require('../models/Permission'),
    Project: require('../models/Project'),
    Task: require('../models/Task'),
    Notification: require('../models/Notification'),
    Shift: require('../models/Shift'),
    DepartmentSetting: require('../models/DepartmentSetting'),
  };

  const defaultConn = mainDBConnection || mongoose.connection;
  
  const models = {};
  for (const [name, schema] of Object.entries(schemas)) {
    try {
      models[name] = defaultConn.model(name, schema);
    } catch (err) {
      console.warn(`⚠️ Failed to create default model ${name}:`, err.message);
    }
  }
  
  return models;
};

// Run cleanup every 5 minutes
setInterval(cleanupStaleConnections, 5 * 60 * 1000);

module.exports = {
  connectMainDB,
  connectTenantDB,
  getTenantConnection,
  getTenantModels,
  getTenantModelsById,
  getSuperAdminModels,
  getDefaultModels,
  checkDatabaseHealth,
  cleanupStaleConnections,
  mainDB: () => mainDBConnection,
};
