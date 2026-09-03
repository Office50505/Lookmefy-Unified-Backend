const ADMIN_ROLES = Object.freeze({
  MASTER: 'master',
  DEVELOPER: 'developer'
});

const ADMIN_SECTIONS = Object.freeze({
  USER_OPERATIONS: 'user-operations',
  SYSTEM_MANAGEMENT: 'system-management',
  COST_MANAGEMENT: 'cost-management'
});

const ADMIN_PERMISSIONS = Object.freeze({
  MANAGE_ROLES: 'roles.manage'
});

const ALL_ADMIN_SECTIONS = Object.freeze(Object.values(ADMIN_SECTIONS));

function normalizeAdminEmail(value = '') {
  return String(value).trim().toLowerCase();
}

function normalizeAdminRole(value = '') {
  return String(value).trim().toLowerCase() === ADMIN_ROLES.MASTER
    ? ADMIN_ROLES.MASTER
    : ADMIN_ROLES.DEVELOPER;
}

function normalizeAdminSections(values = []) {
  const requested = Array.isArray(values) ? values : [];
  return ALL_ADMIN_SECTIONS.filter((section) => requested.includes(section));
}

function adminSectionsFor(admin = {}) {
  if (admin.status === 'pending') return [];
  if (normalizeAdminRole(admin.role) === ADMIN_ROLES.MASTER) return [...ALL_ADMIN_SECTIONS];
  return normalizeAdminSections(admin.sectionAccess);
}

function adminHasSection(admin, section) {
  return adminSectionsFor(admin).includes(section);
}

function adminHasPermission(admin, permission) {
  if (admin?.status === 'pending') return false;
  if (permission === ADMIN_PERMISSIONS.MANAGE_ROLES) {
    return normalizeAdminRole(admin?.role) === ADMIN_ROLES.MASTER;
  }
  return false;
}

function removesActiveMaster(current = {}, next = {}) {
  return normalizeAdminRole(current.role) === ADMIN_ROLES.MASTER
    && (current.status || 'active') === 'active'
    && (normalizeAdminRole(next.role) !== ADMIN_ROLES.MASTER || next.status !== 'active');
}

function adminToClient(admin = {}) {
  const id = admin._id?.toString?.() || String(admin.id || '');
  const status = admin.status || 'pending';
  const role = status === 'pending' ? ADMIN_ROLES.DEVELOPER : normalizeAdminRole(admin.role);
  const normalizedAdmin = { role, status, sectionAccess: admin.sectionAccess };
  return {
    id,
    name: String(admin.name || '').trim(),
    email: normalizeAdminEmail(admin.email),
    role,
    sectionAccess: adminSectionsFor(normalizedAdmin),
    canManageRoles: adminHasPermission(normalizedAdmin, ADMIN_PERMISSIONS.MANAGE_ROLES),
    status,
    lastLoginAt: admin.lastLoginAt || null,
    createdAt: admin.createdAt || null,
    updatedAt: admin.updatedAt || null
  };
}

export {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  ADMIN_SECTIONS,
  ALL_ADMIN_SECTIONS,
  adminHasPermission,
  adminHasSection,
  adminSectionsFor,
  adminToClient,
  normalizeAdminEmail,
  normalizeAdminRole,
  normalizeAdminSections,
  removesActiveMaster
};
