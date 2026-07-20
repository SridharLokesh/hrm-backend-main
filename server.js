require('node:dns').setServers(['8.8.8.8', '1.1.1.1']);
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { connectMainDB, checkDatabaseHealth } = require('./config/db');
const { detectTenant } = require('./middleware/tenant');

// Start server only after main DB is connected so models are registered on the correct connection
const startServer = async () => {
  try {
    await connectMainDB();
  } catch (err) {
    console.error('Failed to connect to main DB on startup:', err);
    process.exit(1);
  }

  const app = express();

  app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      express.json()(req, res, next);
    } else {
      next();
    }
  });

  // Middleware
  // CORS configuration for multi-tenant
  app.use(cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        'https://kb-hrs-software.vercel.app',
        'https://hrm.focusengineeringapp.com',
        'https://hrm-superadmin.focusengineeringapp.com',
        'https://hrm-superadmin.vercel.app',
        'https://hrm-tenant.pages.dev',
        'https://hrm-super-admin.pages.dev',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
        
      ];
      
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      // Check if origin matches any allowed pattern
      if (allowedOrigins.some(allowed => origin === allowed || origin.endsWith('.hrm-saas.vercel.app'))) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }));

  app.use(express.json());

  // Development request logger to aid debugging
  if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
      console.log(`➡️  ${req.method} ${req.originalUrl} | Host: ${req.get('host')} | Origin: ${req.get('origin') || 'N/A'} | Tenant header: ${req.headers['x-tenant'] || req.headers['x-tenant-id'] || 'N/A'}`);
      next();
    });
  }

  // Tenant detection middleware for all routes
  app.use(detectTenant);

  // Mobile gate: enforce tenant-app mobile access policy (blocks API use from mobile UA unless allowed)
  const mobileGate = require('./middleware/mobileGate');
  app.use(mobileGate);

  // Public routes (no tenant required)
  app.use('/api/super-admin', require('./routes/super-admin'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/employees', require('./routes/employees'));
  app.use('/api/attendance', require('./routes/attendance'));
  app.use('/api/leaves', require('./routes/leaves'));
  app.use('/api/payroll', require('./routes/payroll'));
  app.use('/api/dashboard', require('./routes/dashboard'));
  app.use('/api/company', require('./routes/company'));
  app.use('/api/permissions', require('./routes/permissions'));

  app.use('/api/projects', require('./routes/projects'));

  // NOTE: routes/taskProgress.js is intentionally NOT mounted here anymore.
  // It defined /progress, /:taskId/progress (GET+POST), and
  // /my-updates/today — the exact same paths as routes/tasks.js — but its
  // controller (taskProgressController.js) has no ownership/assignment
  // scoping at all (only checks tenant + isActive). Because Express
  // matches routes in mount order, having this mounted before
  // routes/tasks.js meant EVERY request to those paths was silently
  // handled by the unscoped version, and the properly-scoped versions in
  // taskController.js (admin: everything, manager/team-lead: only
  // projects they own, employee: only tasks assigned to them, via
  // authorizeTaskAction / listProgressAdmin) never ran — regardless of
  // role. routes/tasks.js below covers all of the same paths correctly
  // scoped, so this duplicate router is simply removed rather than
  // reordered. The file itself is left in the codebase in case anything
  // else still imports its controller directly, but it is no longer
  // wired into the app's routing.
  app.use('/api/tasks', require('./routes/tasks'));

  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/team', require('./routes/team'));
  app.use('/api/department-settings', require('./routes/departmentSettings'));

  //for daily updates
  app.use('/api/daily-updates', require('./routes/dailyUpdates'));

  // shift routes
  app.use('/api/shifts', require('./routes/shiftRoutes'));

  // location routes (tenant scoped)
  app.use('/api/locations', require('./routes/locations'));

  // tenant-admin location routes (tenant scoped)
  app.use('/api/tenant-admin/locations', require('./routes/tenant-admin-locations'));

  // super-admin locations routes (tenant scoped via ?tenantId=...)
  app.use('/api/super-admin/locations', require('./routes/super-admin-locations'));



  





  

  // Error handling middleware
  app.use((err, req, res, next) => {
    // In development include the error message/stack to aid debugging
    console.error('Unhandled error middleware caught:', err && err.stack ? err.stack : err);
    const payload = { message: 'Something went wrong!' };
    if (process.env.NODE_ENV === 'development') {
      payload.error = err && err.message ? err.message : String(err);
      payload.stack = err && err.stack ? err.stack : undefined;
    }
    res.status(500).json(payload);
  });

  // 404 handler
  app.use('', (req, res) => {
    res.status(404).json({ message: 'Route not found' });
  });

  const jwt = require('jsonwebtoken');
  const http = require('http');
  const { Server } = require('socket.io');

  const PORT = process.env.PORT || 5000;

  const server = http.createServer(app);


  const io = new Server(server, {
    cors: {
      origin: true,
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return next(new Error('No token'));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      socket.join(`user_${decoded.id}`);
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Connected: user ${socket.user.id}`);
    socket.emit('connected', { type: 'connected' });
    socket.on('disconnect', () => console.log(`🔌 Disconnected: user ${socket.user.id}`));
  });

  global.io = io;

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Socket.io ready for notifications`);
    console.log(`Multi-tenant HRM SaaS ready`);
  });
};

startServer();

// Global handlers for unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason && reason.stack ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err && err.stack ? err.stack : err);
  // optional: process.exit(1) if you want to crash on uncaught exceptions
});