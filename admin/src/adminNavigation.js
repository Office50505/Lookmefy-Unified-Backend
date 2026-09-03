const ADMIN_SECTIONS = [
  {
    id: 'user-operations',
    label: 'User Operations',
    pages: [
      { id: 'overview', label: 'Overview', icon: 'overview', kicker: 'Home', lead: 'See products, users, credits, and work that needs attention.' },
      { id: 'inventory', label: 'Inventory', icon: 'inventory', kicker: 'Products', lead: 'Add, edit, and review the products shown on Lookmefy.' },
      { id: 'users', label: 'Users', icon: 'users', kicker: 'Customers', lead: 'Find users, review activity, and manage account access and credits.' },
      { id: 'analytics', label: 'Analytics', icon: 'analytics', kicker: 'Reports', lead: 'Understand user behavior, recommendations, searches, and product performance.' },
      { id: 'storage', label: 'Media Library', icon: 'storage', kicker: 'Media', lead: 'Review profile, try-on, closet, and catalog files saved by Lookmefy.' },
      { id: 'orders', label: 'Orders', icon: 'orders', kicker: 'Payments', lead: 'Review recent credit and product orders with payment outcomes.' }
    ]
  },
  {
    id: 'system-management',
    label: 'System Management',
    pages: [
      { id: 'system-overview', label: 'System Overview', icon: 'system', kicker: 'Operations', lead: 'See service health, incidents, runtime pressure, and generation reliability.' },
      { id: 'service-health', label: 'Service Health', icon: 'services', kicker: 'Services', lead: 'Inspect every core service and configured external dependency.' },
      { id: 'failures', label: 'Failures', icon: 'failures', kicker: 'Incidents', lead: 'Investigate recurring system and AI generation failures.' },
      { id: 'api-performance', label: 'API Performance', icon: 'api', kicker: 'Performance', lead: 'Review request volume, errors, and endpoint latency percentiles.' },
      { id: 'generation-pipeline', label: 'Generation Pipeline', icon: 'generation', kicker: 'AI Operations', lead: 'Track image and video generation success, latency, cost, and restored credits.' },
      { id: 'ios-report', label: 'iOS Report', icon: 'ios', kicker: 'Mobile', lead: 'Review iOS web telemetry and native reporting connection status.' },
      { id: 'android-report', label: 'Android Report', icon: 'android', kicker: 'Mobile', lead: 'Review Android web telemetry and native reporting connection status.' },
      { id: 'audit-log', label: 'Audit Log', icon: 'audit', kicker: 'Governance', lead: 'Review administrative changes and the account responsible for each action.' },
      { id: 'roles', label: 'Roles', icon: 'roles', kicker: 'Access', lead: 'Review admin access requests and manage roles, permissions, and account status.', requiresRoleManagement: true },
      { id: 'settings', label: 'Settings', icon: 'settings', kicker: 'Setup', lead: 'Manage storefront mode, the current admin session, and dashboard preferences.' }
    ]
  },
  {
    id: 'cost-management',
    label: 'Cost Management',
    pages: [
      { id: 'cost-overview', label: 'Cost Overview', icon: 'costs', kicker: 'Costs', lead: 'See month-to-date tracked spend and providers whose billing is not connected.' },
      { id: 'cost-pruna', label: 'Pruna', icon: 'generation', kicker: 'AI Cost', lead: 'Review Pruna usage, model estimates, and billing connection status.', provider: 'pruna' },
      { id: 'cost-fal-pixverse', label: 'FAL / PixVerse', icon: 'video', kicker: 'AI Cost', lead: 'Review PixVerse video usage and provider billing coverage.', provider: 'fal-pixverse' },
      { id: 'cost-fitroom', label: 'FitRoom', icon: 'generation', kicker: 'AI Cost', lead: 'Review FitRoom usage and legacy provider cost coverage.', provider: 'fitroom' },
      { id: 'cost-bunny', label: 'Bunny CDN', icon: 'storage', kicker: 'CDN Cost', lead: 'Review tracked storage, file distribution, and Bunny billing coverage.', provider: 'bunny' },
      { id: 'cost-mongodb', label: 'MongoDB Atlas', icon: 'database', kicker: 'Database Cost', lead: 'Review database size, operational usage, and Atlas billing coverage.', provider: 'mongodb' },
      { id: 'cost-otp', label: 'OTP', icon: 'otp', kicker: 'Messaging Cost', lead: 'Review OTP deliveries, failures, estimated spend, and wallet coverage.', provider: 'otp' },
      { id: 'cost-aws', label: 'AWS', icon: 'cloud', kicker: 'Infrastructure Cost', lead: 'Review infrastructure spend, budget status, and Cost Explorer connection.', provider: 'aws' },
      { id: 'cost-razorpay', label: 'Razorpay Fees', icon: 'orders', kicker: 'Payment Cost', lead: 'Review completed payment volume and settlement fee coverage.', provider: 'razorpay' }
    ]
  }
];

const ADMIN_PAGES = ADMIN_SECTIONS.flatMap((section) => section.pages.map((page) => ({ ...page, sectionId: section.id, sectionLabel: section.label })));
const PAGE_COPY = Object.fromEntries(ADMIN_PAGES.map((page) => [page.id, { kicker: page.kicker, title: page.label, lead: page.lead }]));

PAGE_COPY['add-product'] = {
  kicker: 'Products',
  title: 'Add Product',
  lead: 'Create one new product from a link, review it, and publish it.'
};

function adminPage(id) {
  return ADMIN_PAGES.find((page) => page.id === id) || null;
}

function adminSectionForPage(id) {
  return ADMIN_SECTIONS.find((section) => section.pages.some((page) => page.id === id)) || ADMIN_SECTIONS[0];
}

function adminCanAccessSection(admin, sectionId) {
  if (!admin) return false;
  if (admin.role === 'master') return true;
  return Array.isArray(admin.sectionAccess) && admin.sectionAccess.includes(sectionId);
}

function adminCanAccessPage(admin, pageId) {
  if (pageId === 'add-product') return adminCanAccessSection(admin, 'user-operations');
  const page = adminPage(pageId);
  if (!page) return false;
  if (!adminCanAccessSection(admin, page.sectionId)) return false;
  return !page.requiresRoleManagement || Boolean(admin.canManageRoles);
}

function visibleAdminSections(admin) {
  return ADMIN_SECTIONS.flatMap((section) => {
    if (!adminCanAccessSection(admin, section.id)) return [];
    const pages = section.pages.filter((page) => !page.requiresRoleManagement || admin?.canManageRoles);
    return pages.length ? [{ ...section, pages }] : [];
  });
}

function firstAdminPage(admin) {
  return visibleAdminSections(admin)[0]?.pages[0]?.id || '';
}

export {
  ADMIN_PAGES,
  ADMIN_SECTIONS,
  PAGE_COPY,
  adminCanAccessPage,
  adminCanAccessSection,
  adminPage,
  adminSectionForPage,
  firstAdminPage,
  visibleAdminSections
};
