import AdminAuditLog from '../models/AdminAuditLog.js';
import { emitStructuredLog } from './logging.js';

function adminActor(req) {
  return req.admin?.email || 'unknown-admin';
}

async function recordAdminAudit(req, entry = {}) {
  try {
    await AdminAuditLog.create({
      actorAdmin: req.admin?._id || req.admin?.id || undefined,
      actorEmail: adminActor(req),
      actorRole: req.admin?.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      label: entry.label,
      detail: entry.detail
    });
  } catch (error) {
    emitStructuredLog({ level: 'warn', event: 'admin_audit_failed', message: error?.message || error });
  }
}

export { adminActor, recordAdminAudit };
