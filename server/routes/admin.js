import express from 'express';
import mongoose from 'mongoose';
import AdminUser from '../models/AdminUser.js';
import { getStorefrontSetting } from '../models/StorefrontSetting.js';
import SystemIncident from '../models/SystemIncident.js';
import { recordAdminAudit } from '../utils/adminAudit.js';
import { requireAdmin, requireAdminPermission, requireAdminSection, signAdminSession } from '../utils/adminAccess.js';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  ADMIN_SECTIONS,
  ALL_ADMIN_SECTIONS,
  adminToClient,
  normalizeAdminSections,
  removesActiveMaster
} from '../utils/adminPermissions.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';
import {
  costOverview,
  generationReport,
  incidentReport,
  incidentToClient,
  mobileReport,
  providerCostDetail,
  systemSummary
} from '../services/adminManagement.js';

const router = express.Router();
const adminManagementLimiter = createRateLimiter({
  name: 'admin:management',
  windowMs: 5 * 60 * 1000,
  max: 120,
  keyGenerator: rateLimitKeys.userOrIp,
  message: 'Admin monitoring requests are temporarily limited. Please try again shortly.'
});

router.use(requireAdmin, adminManagementLimiter);

const requireSystemAdmin = requireAdminSection(ADMIN_SECTIONS.SYSTEM_MANAGEMENT);
const requireCostAdmin = requireAdminSection(ADMIN_SECTIONS.COST_MANAGEMENT);
const requireRoleManager = requireAdminPermission(ADMIN_PERMISSIONS.MANAGE_ROLES);

router.use('/system', requireSystemAdmin);
router.use('/costs', requireCostAdmin);
router.use('/roles', requireRoleManager);

function validAdminRole(value) {
  return Object.values(ADMIN_ROLES).includes(value);
}

function roleUpdatePayload(body = {}, current = {}) {
  const role = body.role === undefined ? current.role : String(body.role).trim().toLowerCase();
  if (!validAdminRole(role)) throw new Error('Admin role must be master or developer');
  const status = body.status === undefined ? current.status : String(body.status).trim().toLowerCase();
  if (!['pending', 'active', 'disabled'].includes(status)) throw new Error('Admin status must be pending, active, or disabled');
  if (status === 'pending') {
    return { role: ADMIN_ROLES.DEVELOPER, status, sectionAccess: [] };
  }
  const requestedSections = body.sectionAccess === undefined ? current.sectionAccess : body.sectionAccess;
  const sectionAccess = role === ADMIN_ROLES.MASTER ? [...ALL_ADMIN_SECTIONS] : normalizeAdminSections(requestedSections);
  if (status === 'active' && role === ADMIN_ROLES.DEVELOPER && sectionAccess.length === 0) {
    throw new Error('Select at least one section before approving this developer');
  }
  return { role, status, sectionAccess };
}

async function protectLastMaster(admin, next) {
  if (!removesActiveMaster(admin, next)) return;
  const activeMasters = await AdminUser.countDocuments({ role: ADMIN_ROLES.MASTER, status: 'active' });
  if (activeMasters <= 1) throw new Error('The last active master cannot be demoted or disabled');
}

router.get('/roles', async (req, res, next) => {
  try {
    const admins = await AdminUser.find({}).sort({ role: 1, status: 1, name: 1 }).lean();
    res.json({
      admins: admins.map((admin) => ({
        ...adminToClient(admin),
        isCurrent: String(admin._id) === String(req.admin._id)
      })),
      availableSections: [...ALL_ADMIN_SECTIONS]
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/roles/:id', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid admin id' });
    if (String(req.params.id) === String(req.admin._id)) return res.status(400).json({ message: 'Use another master account to change your own role or status' });
    const admin = await AdminUser.findById(req.params.id);
    if (!admin) return res.status(404).json({ message: 'Admin account not found' });
    let access;
    try {
      access = roleUpdatePayload(req.body, admin);
      await protectLastMaster(admin, access);
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
    const before = { role: admin.role, status: admin.status, sectionAccess: [...admin.sectionAccess] };
    admin.role = access.role;
    admin.status = access.status;
    admin.sectionAccess = access.sectionAccess;
    admin.updatedBy = req.admin._id;
    admin.credentialVersion = Number(admin.credentialVersion || 1) + 1;
    await admin.save();
    await recordAdminAudit(req, {
      action: 'admin_access_updated',
      entityType: 'admin_user',
      entityId: String(admin._id),
      label: admin.email,
      detail: { before, after: access }
    });
    res.json({ admin: adminToClient(admin) });
  } catch (error) {
    next(error);
  }
});

router.post('/roles/:id/revoke-sessions', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid admin id' });
    const admin = await AdminUser.findById(req.params.id);
    if (!admin) return res.status(404).json({ message: 'Admin account not found' });
    admin.credentialVersion = Number(admin.credentialVersion || 1) + 1;
    admin.updatedBy = req.admin._id;
    await admin.save();
    await recordAdminAudit(req, {
      action: 'admin_sessions_revoked',
      entityType: 'admin_user',
      entityId: String(admin._id),
      label: admin.email,
      detail: { sessionsRevoked: true }
    });
    const isCurrent = String(admin._id) === String(req.admin._id);
    const token = isCurrent ? await signAdminSession(admin) : '';
    res.json({ admin: adminToClient(admin), ...(token ? { token } : {}) });
  } catch (error) {
    next(error);
  }
});

router.get('/storefront-settings', requireSystemAdmin, async (_req, res, next) => {
  try {
    const setting = await getStorefrontSetting();
    res.json({ setting: setting.toClient() });
  } catch (error) {
    next(error);
  }
});

router.patch('/storefront-settings/demo-mode', requireSystemAdmin, async (req, res, next) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const setting = await getStorefrontSetting();
    const before = Boolean(setting.demoEcommerceMode);
    setting.demoEcommerceMode = enabled;
    setting.updatedBy = req.admin._id;
    await setting.save();
    await recordAdminAudit(req, {
      action: 'demo_ecommerce_mode_changed',
      entityType: 'storefront_setting',
      label: 'Demo ecommerce mode',
      detail: { before, after: enabled }
    });
    res.json({ setting: setting.toClient() });
  } catch (error) {
    next(error);
  }
});

router.get('/system/summary', async (_req, res, next) => {
  try {
    res.json(await systemSummary());
  } catch (error) {
    next(error);
  }
});

router.get('/system/incidents', async (req, res, next) => {
  try {
    res.json(await incidentReport({
      status: req.query.status,
      service: req.query.service,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

router.patch('/system/incidents/:id', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid incident id' });
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['open', 'acknowledged', 'resolved'].includes(status)) return res.status(400).json({ message: 'Invalid incident status' });
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const now = new Date();
    const set = { status, note };
    if (status === 'acknowledged') set.acknowledgedAt = now;
    if (status === 'resolved') set.resolvedAt = now;
    if (status === 'open') {
      set.acknowledgedAt = null;
      set.resolvedAt = null;
    }
    const incident = await SystemIncident.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!incident) return res.status(404).json({ message: 'Incident not found' });
    await recordAdminAudit(req, {
      action: `incident_${status}`,
      entityType: 'system_incident',
      entityId: String(incident._id),
      label: incident.title,
      detail: { service: incident.service, note }
    });
    res.json({ incident: incidentToClient(incident) });
  } catch (error) {
    next(error);
  }
});

router.get('/system/generations', async (req, res, next) => {
  try {
    res.json(await generationReport(req.query.days));
  } catch (error) {
    next(error);
  }
});

router.get('/system/mobile/:platform', async (req, res, next) => {
  try {
    if (!['ios', 'android'].includes(req.params.platform)) return res.status(404).json({ message: 'Unknown mobile platform' });
    res.json(await mobileReport(req.params.platform, req.query.days));
  } catch (error) {
    next(error);
  }
});

router.get('/costs/summary', async (_req, res, next) => {
  try {
    res.json(await costOverview());
  } catch (error) {
    next(error);
  }
});

router.get('/costs/:provider', async (req, res, next) => {
  try {
    res.json(await providerCostDetail(req.params.provider));
  } catch (error) {
    next(error);
  }
});

export default router;
