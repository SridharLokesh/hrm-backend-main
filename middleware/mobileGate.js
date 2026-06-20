const jwt = require('jsonwebtoken');
const DefaultUser = require('../models/User');

// Simple mobile UA check
const isMobileUA = (ua = '') => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);

// Tenant app identification: trusted hosts and path prefixes for tenant-app.
const TENANT_APP_HOSTS = [
  'hrm.focusengineeringapp.com',
  'localhost:5173',
  'localhost:5174',
  'localhost:5175'
];

// Some deployments serve the tenant-app under a path (e.g. /focusengineering)
const TENANT_APP_PATH_PREFIXES = [
  '/focusengineering',
  '/balaji'
];

module.exports = async function mobileGate(req, res, next) {
  try {
    const origin = req.get('origin') || '';
    const hostHeader = req.get('host') || '';
    let requestPath = req.originalUrl || req.url || '';

    // If request doesn't appear to be for the tenant-app (by origin, host, or path), skip enforcement.
    const matchesHost = TENANT_APP_HOSTS.some(h => origin.includes(h) || hostHeader.includes(h));
    let matchesPath = TENANT_APP_PATH_PREFIXES.some(p => requestPath.startsWith(p));

    // If request path starts with a tenant-app prefix and then /api, strip the prefix
    // so Express routes mounted at /api/* will match requests sent to /<prefix>/api/*
    for (const p of TENANT_APP_PATH_PREFIXES) {
      if (requestPath.startsWith(p + '/api')) {
        const stripped = requestPath.replace(p, '');
        // mutate the request url so downstream routing matches
        req.url = stripped;
        req.originalUrl = stripped;
        requestPath = stripped;
        matchesPath = true;
        break;
      }
    }

    if (!matchesHost && !matchesPath) return next();

    // Skip super-admin APIs
    if (req.originalUrl && req.originalUrl.startsWith('/api/super-admin')) return next();

    // If not a mobile UA, do nothing
    const ua = req.headers['user-agent'] || '';
    if (!isMobileUA(ua)) return next();

    // If no auth token present, allow request to proceed (login/public flows should continue)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

    const token = authHeader.split(' ')[1];
    if (!token) return next();

    // Decode token to get user id; then load user from tenant-aware models if available
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      // If token invalid, let auth middleware handle it later — don't block here
      return next();
    }

    // Resolve user model from req.models (tenant-aware) or default
    let UserModel;
        try {
            UserModel = (req.models && req.models.User) ? req.models.User : DefaultUser;
            if (!UserModel.findById) {
              console.warn('UserModel.findById not available, skipping mobile gate check');
              return next();
      
          }
      } catch (e) {
            console.warn('Error resolving UserModel:', e.message);
            return next();
      
        }
        const user = await UserModel.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'User not found' });

    // Admins always allowed; otherwise require explicit mobileAllowed flag
    if (user.role === 'admin' || user.mobileAllowed === true) {
      return next();
    }

    // Block access for mobile
    return res.status(403).json({ message: 'Mobile access is not allowed for your account. Please use desktop or contact your administrator.' });
  } catch (err) {
    console.error('mobileGate error:', err);
    // Fail-open: do not prevent requests if mobileGate fails unexpectedly
    return next();
  }
};
