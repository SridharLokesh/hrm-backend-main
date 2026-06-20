const { connectTenantDB, getTenantModels } = require('../config/db');
const { getSuperAdminModels } = require('../config/db');

// Detect tenant from subdomain and connect to appropriate database
exports.detectTenant = async (req, res, next) => {
  try {
    // ✅ 1️⃣ Skip tenant detection for super-admin routes
    if (req.originalUrl.startsWith('/api/super-admin')) {
      return next();
    }

    // Support multiple header names for tenant coming from different frontends
    let tenantId = req.headers['x-tenant-id'] || req.headers['x-tenant'];
    let subdomain = req.headers['x-tenant-subdomain'] || req.headers['x-tenant-subdomain'] || req.headers['x-tenant'];

    // Also support query param `tenant`
    if (!tenantId && req.query && req.query.tenant) {
      tenantId = req.query.tenant;
    }

    // If no headers, try to extract from hostname
    if (!tenantId && !subdomain) {
      let hostname = (req.hostname || (req.get('host') || '').split(':')[0] || '').toLowerCase();
      if (!hostname) return next();

      let BASE_DOMAIN = process.env.BASE_DOMAIN || 'hrm-saas.vercel.app';
      BASE_DOMAIN = String(BASE_DOMAIN).toLowerCase().trim();
      BASE_DOMAIN = BASE_DOMAIN.replace(/^https?:\/\//, '');
      BASE_DOMAIN = BASE_DOMAIN.split('/')[0];
      BASE_DOMAIN = BASE_DOMAIN.split(':')[0];
      BASE_DOMAIN = BASE_DOMAIN.replace(/^www\./, '');

      const parts = hostname.split('.');
      const baseParts = BASE_DOMAIN.split('.');

      if (hostname === 'localhost' || parts.length === 1) return next();
      if (hostname === BASE_DOMAIN) return next();

      if (hostname.endsWith('.' + BASE_DOMAIN) && parts.length > baseParts.length) {
        subdomain = parts[0];
      } else {
        const originHeader = req.headers.origin || req.get('origin') || req.headers['x-forwarded-host'];
        if (originHeader) {
          try {
            let originHost = originHeader;
            if (/^https?:\/\//i.test(originHeader)) {
              originHost = new URL(originHeader).hostname;
            } else if (originHeader.includes('/')) {
              originHost = originHeader.split('/')[0];
            }
            originHost = String(originHost).toLowerCase().split(':')[0];
            const originParts = originHost.split('.');

            if (originHost === BASE_DOMAIN) return next();

            if (originHost.endsWith('.' + BASE_DOMAIN) && originParts.length > baseParts.length) {
              subdomain = originParts[0];
            } else {
              return next();
            }
          } catch (e) {
            return next();
          }
        } else {
          return next();
        }
      }
    }

    const tenantIdentifier = subdomain || tenantId;

    if (tenantIdentifier) {
      const { Tenant } = getSuperAdminModels();

      // Try to find tenant by subdomain or by a provided tenant identifier
      let tenant;
      try {
        tenant = await Tenant.findOne({
          $or: [
            { subdomain: String(tenantIdentifier).toLowerCase() },
            { _id: tenantIdentifier }
          ],
          isActive: true
        });
      } catch (e) {
        // If subdomain value wasn't an ObjectId, fallback to searching by subdomain only
        tenant = await Tenant.findOne({ subdomain: String(tenantIdentifier).toLowerCase(), isActive: true });
      }

      if (tenant) {
        req.tenant = tenant;
        req.tenantId = tenant._id;
        req.tenantSubdomain = tenant.subdomain;

        const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
        req.tenantDB = tenantConnection;
        // getTenantModels is async (verifies connection); await it so req.models holds models, not a Promise
        try {
          req.models = await getTenantModels(tenantConnection);
        } catch (e) {
          console.error('Failed to load tenant models:', e && e.message ? e.message : e);
          return res.status(500).json({ message: 'Failed to initialize tenant models' });
        }

        console.log(`🔗 Connected to tenant database: ${tenant.companyName}`);
      } else {
        // If a subdomain/header was provided but no tenant was found, don't hard-fail here.
        // Clients (install hooks, public pages) may send stale or exploratory headers —
        // allow the request to continue without tenant context and let downstream
        // authentication/authorization decide how to handle it.
        console.warn(`Tenant detection: tenant identifier provided but not found or inactive -> '${tenantIdentifier}'. Continuing without tenant context.`);
        // ensure no tenant properties are set on the request
        req.tenant = undefined;
        req.tenantId = undefined;
        req.tenantSubdomain = undefined;
      }
    }

    next();
  } catch (error) {
    console.error('Tenant detection error:', error);
    res.status(500).json({ message: 'Tenant detection failed' });
  }
};

// Require tenant context
exports.requireTenant = (req, res, next) => {
  if (!req.tenant) {
    return res.status(400).json({
      message: 'Company context required'
    });
  }
  next();
};
