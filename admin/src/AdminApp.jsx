import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ADMIN_PAGES,
  PAGE_COPY,
  adminCanAccessPage,
  adminCanAccessSection,
  adminPage,
  adminSectionForPage,
  firstAdminPage,
  visibleAdminSections
} from './adminNavigation.js';
import {
  ApiPerformancePage,
  CostOverviewPage,
  FailuresPage,
  GenerationPipelinePage,
  MobileReportPage,
  ProviderCostPage,
  ServiceHealthPage,
  SystemOverviewPage
} from './AdminManagementPages.jsx';
import { AdminRolesPage } from './AdminRolesPage.jsx';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const STORE_BASE = (import.meta.env.VITE_STORE_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const ADMIN_SESSION_KEY = 'fitlook_admin_session';
const ADMIN_THEME_KEY = 'lookmefy_admin_theme';
const ADMIN_RECENT_SEARCHES_KEY = 'lookmefy_admin_recent_searches';
const ADMIN_SESSION_EXPIRED_EVENT = 'lookmefy:admin-session-expired';
const EMPTY_STORAGE_USAGE = {
  bytes: { all: 0, profile: 0, tryon: 0, video: 0, closet: 0, product: 0 },
  bunnyBytes: { all: 0, profile: 0, tryon: 0, video: 0, closet: 0, product: 0 },
  bunnyCounts: { all: 0, profile: 0, tryon: 0, video: 0, closet: 0, product: 0 },
  unknownSize: { all: 0, profile: 0, tryon: 0, video: 0, closet: 0, product: 0 }
};
const EMPTY_STORAGE_COUNTS = { all: 0, profile: 0, tryon: 0, video: 0, closet: 0, product: 0 };

function storedAdminSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY) || 'null');
    if (!session?.token || !session.admin?.id || !Array.isArray(session.admin.sectionAccess)) return null;
    return session;
  } catch {
    return null;
  }
}

function readableError(value, fallback = 'Request failed') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return readableError(value.message, fallback);
  if (typeof value === 'object') {
    const nested = value.message || value.detail || value.error || value.errors;
    if (nested && nested !== value) return readableError(nested, fallback);
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return fallback;
    }
  }
  return String(value);
}

function rateLimitMessage(data, fallback) {
  const base = readableError(data, fallback);
  const seconds = Number(data?.retryAfterSeconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return base;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${base} Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  const session = storedAdminSession();
  const authHeaders = session?.token ? { Authorization: `Bearer ${session.token}` } : {};
  const res = await fetch(`${API_BASE}/api${path}`, { ...options, headers: { ...headers, ...authHeaders, ...options.headers } });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && session?.token) {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
  }
  if (!res.ok) throw new Error(res.status === 429 ? rateLimitMessage(data, `Request failed (${res.status})`) : readableError(data, `Request failed (${res.status})`));
  return data;
}

function mediaUrl(value) {
  if (!value) return '/assets/hero2.png';
  if (/^(?:https?:|data:)/i.test(value)) return value;
  return API_BASE ? `${API_BASE}${value}` : value;
}

function productPublicUrl(productOrId) {
  const id = typeof productOrId === 'string' ? productOrId : productOrId?.id;
  return `${STORE_BASE}/product/${encodeURIComponent(id || '')}`;
}

function cleanDisplayText(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (/\b(?:bust|waist|hip|sleeve|shoulder|inseam|cuff|length|heel to toe|thigh circumference)\s*\(in\)/i.test(text)) return fallback;
  if (text.length > 58) return fallback;
  return text;
}

function displayBrand(product) {
  const brand = cleanDisplayText(product?.brand, '');
  if (!brand) return 'Marketplace brand';
  if (brand.toLowerCase() === 'amazon') return 'Amazon';
  return brand;
}

function displayCategory(product) {
  return cleanDisplayText(product?.category, 'Products');
}

function garmentPlacementLabel(value) {
  if (value === 'accessory') return 'Accessory';
  if (value === 'full-body') return 'Full body';
  return value === 'bottom' ? 'Bottom' : 'Top';
}

function inferGarmentPlacement(product = {}) {
  const text = [
    product.name,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(accessor(?:y|ies)|bags?|handbags?|purses?|wallets?|belts?|scarves?|jewelry|jewellery|necklaces?|rings?|earrings?|bracelets?|watches?|sunglasses?|eyewear|hats?|caps?)\b/.test(text)) return 'accessory';
  if (/\b(outfits?|sets?|co-?ords?|coordinated|tracksuits?|suits?|jumpsuits?|rompers?|playsuits?|dress(?:es)?|gowns?|sarees?|saris?|lehenga(?:s)?|kurta\s?sets?)\b/.test(text)) return 'full-body';
  return /\b(pants?|trousers?|jeans?|denim|shorts?|skirts?|leggings?|joggers?|palazzos?|bottoms?|lower)\b/.test(text) ? 'bottom' : 'top';
}

function formatMoney(value, currency = 'USD') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Price unavailable';
  const normalizedCurrency = String(currency || 'USD').toUpperCase();
  const locale = normalizedCurrency === 'INR' ? 'en-IN' : 'en-US';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: normalizedCurrency }).format(amount);
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  }
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return new Intl.NumberFormat('en-US').format(number);
}

function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
}

function formatWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return number % 1 === 0 ? formatCompactNumber(number) : formatCompactNumber(number.toFixed(1));
}

function formatEventType(value) {
  return String(value || 'signal').replace(/_/g, ' ');
}

function formatSignalDate(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatCatalogDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function productQaFlags(product, duplicateFlags = []) {
  const flags = [...duplicateFlags];
  if (!product.affiliateLink && !product.sourceUrl) flags.push('Missing source');
  if (!product.tags?.length) flags.push('No tags');
  if (!product.colors?.length) flags.push('No colors');
  if (!product.compareAtPrice) flags.push('No compare price');
  if (!Number(product.ratingCount)) flags.push('No rating count');
  if (/brand unavailable|marketplace brand/i.test(product.brand || '')) flags.push('Generic brand');
  if ((product.category || '').toLowerCase() === 'clothing') flags.push('Broad category');
  return flags;
}

function fieldValue(form, name) {
  return form.elements.namedItem(name)?.value ?? '';
}

function checkedValue(form, name) {
  return Boolean(form.elements.namedItem(name)?.checked);
}

function useProducts(params, enabled = true) {
  const query = useMemo(() => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') search.set(key, value);
    });
    return search.toString();
  }, [params]);
  const [state, setState] = useState({
    products: [],
    total: 0,
    facets: { brands: [], categories: [], categoryCounts: [] },
    availabilityCounts: {},
    loading: true,
    error: '',
    pagination: { page: 1, pages: 1, total: 0, limit: 48 }
  });

  useEffect(() => {
    if (!enabled) {
      setState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, availabilityCounts: {}, loading: false, error: '', pagination: { page: 1, pages: 1, total: 0, limit: 48 } });
      return undefined;
    }
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(`/products/admin/catalog${query ? `?${query}` : ''}`)
      .then((data) => {
        if (alive) {
          setState({
            products: data.products || [],
            total: data.total || 0,
            facets: data.facets || { brands: [], categories: [], categoryCounts: [] },
            availabilityCounts: data.availabilityCounts || {},
            loading: false,
            error: '',
            pagination: data.pagination || { page: 1, pages: 1, total: data.total || 0, limit: data.products?.length || 48 }
          });
        }
      })
      .catch((err) => {
        if (alive) {
          setState({
            products: [],
            total: 0,
            facets: { brands: [], categories: [], categoryCounts: [] },
            availabilityCounts: {},
            loading: false,
            error: err.message,
            pagination: { page: 1, pages: 1, total: 0, limit: 48 }
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [enabled, query]);

  return state;
}

function useRecommendationStats(enabled, refresh, period = { range: '30', from: '', to: '' }) {
  const [state, setState] = useState({ stats: null, loading: false, error: '' });

  useEffect(() => {
    if (!enabled) {
      setState({ stats: null, loading: false, error: '' });
      return;
    }
    let alive = true;
    const query = new URLSearchParams({ range: period.range || '30' });
    if (period.range === 'custom') {
      query.set('from', period.from);
      query.set('to', period.to);
    }
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(`/recommendations/admin/stats?${query.toString()}`)
      .then((data) => {
        if (alive) setState({ stats: data, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ stats: null, loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [enabled, period.from, period.range, period.to, refresh]);

  return state;
}

function useAdminUsers(enabled, refresh, search = '', status = '', minTokens = '', maxTokens = '', page = 1, sort = 'newest') {
  const [state, setState] = useState({ users: [], totals: { users: 0, loaded: 0, tokens: 0 }, pagination: { page: 1, pages: 1, total: 0 }, loading: false, error: '' });

  useEffect(() => {
    if (!enabled) {
      setState({ users: [], totals: { users: 0, loaded: 0, tokens: 0 }, pagination: { page: 1, pages: 1, total: 0 }, loading: false, error: '' });
      return;
    }
    let alive = true;
    const query = new URLSearchParams({ limit: '40', page: String(page), sort });
    if (search.trim()) query.set('q', search.trim());
    if (status) query.set('status', status);
    if (minTokens !== '') query.set('minTokens', minTokens);
    if (maxTokens !== '') query.set('maxTokens', maxTokens);
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(`/auth/admin/users?${query.toString()}`)
      .then((data) => {
        if (alive) setState({ users: data.users || [], totals: data.totals || { users: 0, loaded: 0, tokens: 0 }, pagination: data.pagination || { page: 1, pages: 1, total: 0 }, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ users: [], totals: { users: 0, loaded: 0, tokens: 0 }, pagination: { page: 1, pages: 1, total: 0 }, loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [enabled, maxTokens, minTokens, page, refresh, search, sort, status]);

  return state;
}

function useAdminOperations(enabled, refresh) {
  const [state, setState] = useState({ orders: [], orderTotals: {}, auditLogs: [], loading: false, error: '' });

  useEffect(() => {
    if (!enabled) {
      setState({ orders: [], orderTotals: {}, auditLogs: [], loading: false, error: '' });
      return;
    }
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api('/auth/admin/operations')
      .then((data) => {
        if (alive) setState({ orders: data.orders || [], orderTotals: data.orderTotals || {}, auditLogs: data.auditLogs || [], loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ orders: [], orderTotals: {}, auditLogs: [], loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [enabled, refresh]);

  return state;
}

function useAdminStorage(enabled, type, page, refresh) {
  const [state, setState] = useState({
    items: [],
    counts: EMPTY_STORAGE_COUNTS,
    usage: EMPTY_STORAGE_USAGE,
    total: 0,
    pages: 1,
    provider: '',
    loading: false,
    error: ''
  });

  useEffect(() => {
    if (!enabled) {
      setState({ items: [], counts: EMPTY_STORAGE_COUNTS, usage: EMPTY_STORAGE_USAGE, total: 0, pages: 1, provider: '', loading: false, error: '' });
      return undefined;
    }
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(`/auth/admin/storage?type=${encodeURIComponent(type)}&page=${page}&limit=24`)
      .then((data) => {
        if (alive) setState({
          items: data.items || [],
          counts: data.counts || EMPTY_STORAGE_COUNTS,
          usage: data.usage || EMPTY_STORAGE_USAGE,
          total: data.total || 0,
          pages: data.pages || 1,
          provider: data.provider || '',
          loading: false,
          error: ''
        });
      })
      .catch((err) => {
        if (alive) setState((current) => ({ ...current, items: [], loading: false, error: err.message }));
      });
    return () => {
      alive = false;
    };
  }, [enabled, page, refresh, type]);

  return state;
}

function useAdminResource(enabled, path, refresh) {
  const [state, setState] = useState({ data: null, loading: false, error: '' });

  useEffect(() => {
    if (!enabled || !path) {
      setState({ data: null, loading: false, error: '' });
      return undefined;
    }
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(path)
      .then((data) => {
        if (alive) setState({ data, loading: false, error: '' });
      })
      .catch((error) => {
        if (alive) setState({ data: null, loading: false, error: error.message });
      });
    return () => {
      alive = false;
    };
  }, [enabled, path, refresh]);

  return state;
}

function pageFromHash() {
  const raw = window.location.hash.replace(/^#/, '');
  const value = raw === 'media-library' ? 'storage' : raw;
  if (value === 'add-product') return value;
  return ADMIN_PAGES.some((page) => page.id === value) ? value : 'overview';
}

function AdminApp() {
  const formRef = useRef(null);
  const [adminSession, setAdminSession] = useState(() => storedAdminSession());
  const [activePage, setActivePage] = useState(pageFromHash);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [message, setMessage] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem(ADMIN_THEME_KEY) || 'light');
  const [pendingAction, setPendingAction] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [mediaUser, setMediaUser] = useState(null);
  const [previewImage, setPreviewImage] = useState('');
  const [fetchingDraft, setFetchingDraft] = useState(false);
  const [smartCommand, setSmartCommand] = useState('');
  const [smartImporting, setSmartImporting] = useState(false);
  const [smartImportResult, setSmartImportResult] = useState(null);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [draftStatus, setDraftStatus] = useState({
    tone: 'idle',
    title: 'Ready to fetch',
    detail: 'Paste a product link to prefill the draft, or complete the fields manually.',
    warnings: []
  });
  const [editingProduct, setEditingProduct] = useState(null);
  const [editMessage, setEditMessage] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [userStatus, setUserStatus] = useState('');
  const [userTokenRange, setUserTokenRange] = useState({ min: '', max: '' });
  const [userPage, setUserPage] = useState(1);
  const [userSort, setUserSort] = useState('newest');
  const [inventoryPage, setInventoryPage] = useState(1);
  const [analyticsPeriod, setAnalyticsPeriod] = useState({ range: '30', from: '', to: '' });
  const [userRefresh, setUserRefresh] = useState(0);
  const [operationsRefresh, setOperationsRefresh] = useState(0);
  const [managementRefresh, setManagementRefresh] = useState(0);
  const [tokenDrafts, setTokenDrafts] = useState({});
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [filters, setFilters] = useState({
    q: '',
    category: '',
    brand: '',
    gender: '',
    availability: '',
    status: '',
    sort: 'newest'
  });
  const [refresh, setRefresh] = useState(0);
  const currentAdmin = adminSession?.admin || null;
  const hasUserOperations = adminCanAccessSection(currentAdmin, 'user-operations');
  const hasSystemManagement = adminCanAccessSection(currentAdmin, 'system-management');
  const hasCostManagement = adminCanAccessSection(currentAdmin, 'cost-management');
  const navigationSections = useMemo(() => visibleAdminSections(currentAdmin), [currentAdmin]);
  const searchablePages = useMemo(() => navigationSections.flatMap((section) => section.pages), [navigationSections]);
  const productParams = useMemo(() => ({
    limit: 48,
    page: inventoryPage,
    sort: filters.sort,
    q: filters.q.trim(),
    category: filters.category,
    brand: filters.brand,
    gender: filters.gender,
    availability: filters.availability,
    featured: filters.status === 'featured' ? 'true' : '',
    newArrival: filters.status === 'newArrival' ? 'true' : '',
    refresh
  }), [filters, inventoryPage, refresh]);
  const state = useProducts(productParams, Boolean(adminSession?.token) && hasUserOperations);
  const recommendationStats = useRecommendationStats(Boolean(adminSession?.token) && hasUserOperations, refresh, analyticsPeriod);
  const usersState = useAdminUsers(
    Boolean(adminSession?.token) && hasUserOperations,
    userRefresh,
    userSearch,
    userStatus,
    userTokenRange.min,
    userTokenRange.max,
    userPage,
    userSort
  );
  const operationsState = useAdminOperations(Boolean(adminSession?.token) && hasUserOperations, operationsRefresh);
  const pageMeta = adminPage(activePage);
  const activeSection = adminSectionForPage(activePage);
  const systemSummaryEnabled = ['system-overview', 'service-health', 'api-performance'].includes(activePage);
  const incidentsEnabled = activePage === 'failures';
  const generationsEnabled = ['failures', 'generation-pipeline'].includes(activePage);
  const mobilePlatform = activePage === 'ios-report' ? 'ios' : activePage === 'android-report' ? 'android' : '';
  const costOverviewEnabled = activePage === 'cost-overview';
  const activeCostProvider = pageMeta?.provider || '';
  const systemSummaryState = useAdminResource(Boolean(adminSession?.token) && hasSystemManagement && systemSummaryEnabled, '/admin/system/summary', managementRefresh);
  const incidentsState = useAdminResource(Boolean(adminSession?.token) && hasSystemManagement && incidentsEnabled, '/admin/system/incidents?limit=150', managementRefresh);
  const generationState = useAdminResource(Boolean(adminSession?.token) && hasSystemManagement && generationsEnabled, '/admin/system/generations?days=30', managementRefresh);
  const mobileState = useAdminResource(Boolean(adminSession?.token) && hasSystemManagement && Boolean(mobilePlatform), mobilePlatform ? `/admin/system/mobile/${mobilePlatform}?days=30` : '', managementRefresh);
  const costOverviewState = useAdminResource(Boolean(adminSession?.token) && hasCostManagement && costOverviewEnabled, '/admin/costs/summary', managementRefresh);
  const providerCostState = useAdminResource(Boolean(adminSession?.token) && hasCostManagement && Boolean(activeCostProvider), activeCostProvider ? `/admin/costs/${activeCostProvider}` : '', managementRefresh);
  const storefrontSettingsState = useAdminResource(Boolean(adminSession?.token) && hasSystemManagement && activePage === 'settings', '/admin/storefront-settings', managementRefresh);
  const duplicateWarnings = useMemo(() => {
    const counts = new Map();
    const remember = (type, value) => {
      const key = String(value || '').trim().toLowerCase();
      if (!key) return;
      counts.set(`${type}:${key}`, (counts.get(`${type}:${key}`) || 0) + 1);
    };
    state.products.forEach((product) => {
      remember('affiliate', product.affiliateLink);
      remember('source', product.sourceUrl);
      remember('image', product.imageUrl);
    });
    const warnings = new Map();
    state.products.forEach((product) => {
      const flags = [];
      if (product.affiliateLink && counts.get(`affiliate:${String(product.affiliateLink).trim().toLowerCase()}`) > 1) flags.push('Duplicate link');
      if (product.sourceUrl && counts.get(`source:${String(product.sourceUrl).trim().toLowerCase()}`) > 1) flags.push('Duplicate source');
      if (product.imageUrl && counts.get(`image:${String(product.imageUrl).trim().toLowerCase()}`) > 1) flags.push('Duplicate image');
      if (flags.length) warnings.set(product.id, flags);
    });
    return warnings;
  }, [state.products]);
  const reviewItems = useMemo(() => state.products
    .map((product) => ({ product, flags: productQaFlags(product, duplicateWarnings.get(product.id) || []) }))
    .filter((item) => item.flags.length), [duplicateWarnings, state.products]);
  const selectedProducts = useMemo(() => state.products.filter((product) => selectedIds.has(product.id)), [selectedIds, state.products]);
  const availableProductCount = Number(state.availabilityCounts?.available || 0);
  const categoryDistribution = useMemo(() => {
    if (state.facets.categoryCounts?.length) {
      return state.facets.categoryCounts
        .map((item) => ({ category: item.category || 'uncategorized', count: item.count || 0 }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
    }
    const counts = new Map();
    state.products.forEach((product) => {
      const category = product.category || 'uncategorized';
      counts.set(category, (counts.get(category) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  }, [state.facets.categoryCounts, state.products]);
  const pageCopy = PAGE_COPY[activePage] || PAGE_COPY.overview;
  const adminDisplayName = currentAdmin?.name || currentAdmin?.email || 'Admin';
  const createBusy = fetchingDraft || smartImporting || creatingProduct;

  useEffect(() => {
    const handleHashChange = () => setActivePage(pageFromHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    const handleExpiredSession = () => {
      setAdminSession(null);
      setMessage('Your admin session ended. Sign in again.');
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleExpiredSession);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleExpiredSession);
  }, []);

  useEffect(() => {
    if (!adminSession?.token) return undefined;
    let alive = true;
    api('/auth/admin-session')
      .then((data) => {
        if (!alive || !data.admin) return;
        const refreshed = { token: adminSession.token, admin: data.admin };
        sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(refreshed));
        setAdminSession(refreshed);
      })
      .catch(() => {
        // The API helper clears invalid sessions and emits the expiry event.
      });
    return () => {
      alive = false;
    };
  }, [adminSession?.token]);

  useEffect(() => {
    if (!adminSession?.token || adminCanAccessPage(currentAdmin, activePage)) return;
    const fallbackPage = firstAdminPage(currentAdmin);
    if (!fallbackPage) return;
    setActivePage(fallbackPage);
    window.history.replaceState(null, '', `#${fallbackPage}`);
    setMessage('That page is outside your assigned admin access.');
  }, [activePage, adminSession?.token, currentAdmin]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [productParams]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(ADMIN_THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!message) return undefined;
    const timeout = window.setTimeout(() => setMessage(''), 5500);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const showPage = (page) => {
    if (!adminCanAccessPage(currentAdmin, page)) {
      setMessage('That page is outside your assigned admin access.');
      return;
    }
    setActivePage(page);
    window.history.replaceState(null, '', `#${page}`);
  };

  const refreshCurrentPage = () => {
    setRefresh((value) => value + 1);
    setUserRefresh((value) => value + 1);
    setOperationsRefresh((value) => value + 1);
    setManagementRefresh((value) => value + 1);
  };

  const updateIncidentStatus = async (incidentId, status) => {
    try {
      await api(`/admin/system/incidents/${incidentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      setMessage(`Incident ${status}.`);
      setManagementRefresh((value) => value + 1);
    } catch (error) {
      setMessage(error.message);
    }
  };

  const toggleDemoMode = async (enabled) => {
    setActionBusy(true);
    try {
      await api('/admin/storefront-settings/demo-mode', {
        method: 'PATCH',
        body: JSON.stringify({ enabled })
      });
      setManagementRefresh((value) => value + 1);
      setMessage(enabled ? 'Demo ecommerce mode enabled.' : 'Demo ecommerce mode disabled.');
    } catch (error) {
      setMessage(error.message || 'Could not update demo mode.');
    } finally {
      setActionBusy(false);
    }
  };

  const openProductFromSearch = (product) => {
    setInventoryPage(1);
    setFilters((current) => ({ ...current, q: product.name || '', sort: 'newest' }));
    showPage('inventory');
  };

  const openUserFromSearch = (user) => {
    setUserPage(1);
    setUserSearch(user.email || user.username || user.name || '');
    showPage('users');
  };

  const openCreateProduct = () => {
    showPage('add-product');
    window.setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const completeLogin = (session) => {
    sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
    setAdminSession(session);
    const destination = adminCanAccessPage(session.admin, pageFromHash()) ? pageFromHash() : firstAdminPage(session.admin);
    if (destination) {
      setActivePage(destination);
      window.history.replaceState(null, '', `#${destination}`);
    }
  };

  const refreshAdminSession = (session) => {
    sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
    setAdminSession(session);
  };

  const logout = () => {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    setAdminSession(null);
  };

  const setField = (name, value) => {
    const field = formRef.current?.elements.namedItem(name);
    if (!field || value === undefined) return;
    field.value = Array.isArray(value) ? value.join(', ') : (value ?? '');
  };

  const previewAffiliate = async () => {
    if (fetchingDraft || smartImporting || creatingProduct) return;
    const form = formRef.current;
    const affiliateLink = String(form?.elements.namedItem('affiliateLink')?.value || '').trim();
    const itemType = String(form?.elements.namedItem('fetchItemType')?.value || 'auto');
    if (!affiliateLink) {
      setDraftStatus({
        tone: 'error',
        title: 'Affiliate link required',
        detail: 'Paste a product page URL before fetching details.'
      });
      setMessage('Paste an affiliate link first.');
      return;
    }
    setFetchingDraft(true);
    setPreviewImage('');
    setDraftStatus({
      tone: 'loading',
      title: 'Fetching product details',
      detail: 'Reading the source page, looking for product copy, price, and usable imagery.',
      warnings: []
    });
    setMessage('Fetching product details...');
    try {
      const data = await api('/products/preview-link', {
        method: 'POST',
        body: JSON.stringify({ affiliateLink, itemType })
      });
      const draft = data.draft || {};
      const fieldNames = [
        'affiliateLink',
        'name',
        'brand',
        'category',
        'gender',
        'price',
        'compareAtPrice',
        'currency',
        'rating',
        'ratingCount',
        'description',
        'tags',
        'colors',
        'sizes',
        'sizeNotes',
        'remoteImageUrl',
        'sourceUrl'
      ];
      fieldNames.forEach((name) => setField(name, draft[name]));
      setField('garmentPlacement', draft.garmentPlacement || inferGarmentPlacement(draft));
      if (draft.remoteImageUrl) setPreviewImage(draft.remoteImageUrl);
      const filledCount = fieldNames.filter((name) => {
        const value = draft[name];
        return Array.isArray(value) ? value.length > 0 : Boolean(value);
      }).length;
      setDraftStatus({
        tone: 'success',
        title: 'Draft details fetched',
        detail: `Filled ${filledCount} fields${draft.remoteImageUrl ? ' and found a product image' : ''}. Review the draft before publishing.`,
        warnings: Array.isArray(draft.warnings) ? draft.warnings : []
      });
      setMessage('Draft filled. Review it, adjust anything missing, then save.');
    } catch (err) {
      setDraftStatus({
        tone: 'error',
        title: 'Could not fetch details',
        detail: err.message,
        warnings: []
      });
      setMessage(err.message);
    } finally {
      setFetchingDraft(false);
    }
  };

  const runSmartImport = async () => {
    const command = smartCommand.trim();
    if (!command || smartImporting || creatingProduct || fetchingDraft) {
      if (!command) setMessage('Describe the products you want to fetch.');
      return;
    }
    setSmartImporting(true);
    setSmartImportResult(null);
    setMessage('Finding matching products and creating drafts...');
    try {
      const data = await api('/products/smart-import', {
        method: 'POST',
        body: JSON.stringify({ command })
      });
      const batch = data.batch || null;
      setSmartImportResult(batch);
      setMessage(batch?.created
        ? `Created ${batch.created} draft product${batch.created === 1 ? '' : 's'} for review.`
        : 'No new drafts were created. Review the import report.');
      if (batch?.created) {
        setRefresh((value) => value + 1);
        setOperationsRefresh((value) => value + 1);
      }
    } catch (error) {
      setMessage(error.message);
      setSmartImportResult({ error: error.message, created: 0, products: [], issues: [] });
    } finally {
      setSmartImporting(false);
    }
  };

  const reviewSmartDrafts = () => {
    setInventoryPage(1);
    setFilters((current) => ({ ...current, q: '', availability: 'draft', sort: 'newest' }));
    showPage('inventory');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (fetchingDraft || smartImporting || creatingProduct) return;
    setMessage('Uploading product...');
    setCreatingProduct(true);
    try {
      const form = event.currentTarget;
      const availabilityStatus = fieldValue(form, 'availabilityStatus') || 'available';
      await api('/products', { method: 'POST', body: new FormData(form) });
      form.reset();
      setPreviewImage('');
      setDraftStatus({
        tone: 'success',
        title: availabilityStatus === 'available' ? 'Product published' : 'Product saved',
        detail: availabilityStatus === 'available'
          ? 'The product is live in the catalog. You can fetch another link or create a manual draft.'
          : `The product was saved as ${availabilityStatus.replace(/_/g, ' ')} and is hidden from the storefront.`
      });
      setMessage(availabilityStatus === 'available' ? 'Product uploaded.' : 'Product saved outside the live catalog.');
      setRefresh((value) => value + 1);
      setOperationsRefresh((value) => value + 1);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setCreatingProduct(false);
    }
  };

  const removeProduct = async (id) => {
    if (!window.confirm('Archive this product and hide it from the storefront?')) return;
    setMessage('Archiving product...');
    try {
      await api(`/products/${id}`, { method: 'DELETE' });
      setMessage('Product archived.');
      setRefresh((value) => value + 1);
      setOperationsRefresh((value) => value + 1);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const requestDeleteProduct = (product) => {
    setPendingAction({ type: 'delete-product', product });
  };

  const removeAllProducts = async () => {
    if (!availableProductCount) {
      setMessage('There are no available products to archive.');
      return;
    }
    const confirmed = window.confirm(`Archive all ${availableProductCount} available products? This will hide them from the storefront.`);
    if (!confirmed) return;
    const secondConfirmed = window.confirm('Please confirm again. This removes every listed product from the active catalog.');
    if (!secondConfirmed) return;
    setMessage('Archiving all available products...');
    try {
      const data = await api('/products', { method: 'DELETE' });
      setMessage(`Archived ${data.removed || 0} products.`);
      setRefresh((value) => value + 1);
      setOperationsRefresh((value) => value + 1);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const updateGarmentPlacement = async (id, garmentPlacement) => {
    setMessage('Updating fit area...');
    try {
      await api(`/products/${id}/garment-placement`, {
        method: 'PATCH',
        body: JSON.stringify({ garmentPlacement })
      });
      setMessage('Fit area updated.');
      setRefresh((value) => value + 1);
      setOperationsRefresh((value) => value + 1);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const updateFilter = (name, value) => {
    setInventoryPage(1);
    setFilters((current) => ({ ...current, [name]: value }));
  };

  const clearFilters = () => {
    setInventoryPage(1);
    setFilters({ q: '', category: '', brand: '', gender: '', availability: '', status: '', sort: 'newest' });
  };

  const toggleSelected = (id) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      if (state.products.length && state.products.every((product) => current.has(product.id))) return new Set();
      return new Set(state.products.map((product) => product.id));
    });
  };

  const bulkPatch = async (updates, label) => {
    if (!selectedIds.size) {
      setMessage('Select products first.');
      return;
    }
    setMessage(`${label}...`);
    const results = await Promise.allSettled([...selectedIds].map((id) => api(`/products/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    })));
    const failed = results.filter((result) => result.status === 'rejected');
    setMessage(failed.length ? `${label} finished with ${failed.length} failed updates.` : `${label} complete for ${selectedIds.size} products.`);
    setSelectedIds(new Set());
    setRefresh((value) => value + 1);
    setOperationsRefresh((value) => value + 1);
  };

  const bulkAvailability = async (availabilityStatus, label) => {
    if (!selectedIds.size) {
      setMessage('Select products first.');
      return;
    }
    setMessage(`${label}...`);
    try {
      const data = await api('/products/admin/inventory', {
        method: 'PATCH',
        body: JSON.stringify({ ids: [...selectedIds], availabilityStatus })
      });
      setMessage(`${label} complete for ${data.updated || 0} products.`);
      setSelectedIds(new Set());
      setRefresh((value) => value + 1);
      setOperationsRefresh((value) => value + 1);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const bulkRemove = async () => {
    if (!selectedIds.size) {
      setMessage('Select products first.');
      return;
    }
    if (!window.confirm(`Archive ${selectedIds.size} selected products?`)) return;
    await bulkAvailability('archived', 'Archiving selected products');
  };

  const updateProductAvailability = async (id, availabilityStatus) => {
    setMessage('Updating availability...');
    try {
      await api(`/products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ availabilityStatus })
      });
      setMessage(`Product marked ${availabilityStatus.replace(/_/g, ' ')}.`);
      setRefresh((value) => value + 1);
      setOperationsRefresh((value) => value + 1);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const openEditor = (product) => {
    setEditingProduct(product);
    setEditMessage('');
  };

  const closeEditor = () => {
    setEditingProduct(null);
    setEditMessage('');
  };

  const submitEdit = async (event) => {
    event.preventDefault();
    if (!editingProduct) return;
    const form = event.currentTarget;
    const payload = {
      name: fieldValue(form, 'name'),
      brand: fieldValue(form, 'brand'),
      category: fieldValue(form, 'category'),
      gender: fieldValue(form, 'gender'),
      garmentPlacement: fieldValue(form, 'garmentPlacement'),
      price: fieldValue(form, 'price'),
      compareAtPrice: fieldValue(form, 'compareAtPrice'),
      currency: fieldValue(form, 'currency'),
      rating: fieldValue(form, 'rating'),
      ratingCount: fieldValue(form, 'ratingCount'),
      badge: fieldValue(form, 'badge'),
      tags: fieldValue(form, 'tags'),
      colors: fieldValue(form, 'colors'),
      sizes: fieldValue(form, 'sizes'),
      sizeNotes: fieldValue(form, 'sizeNotes'),
      description: fieldValue(form, 'description'),
      affiliateLink: fieldValue(form, 'affiliateLink'),
      sourceUrl: fieldValue(form, 'sourceUrl'),
      remoteImageUrl: fieldValue(form, 'remoteImageUrl'),
      tryOnModel: fieldValue(form, 'tryOnModel'),
      availabilityStatus: fieldValue(form, 'availabilityStatus'),
      inventoryNotes: fieldValue(form, 'inventoryNotes'),
      isFeatured: checkedValue(form, 'isFeatured'),
      isNewArrival: checkedValue(form, 'isNewArrival')
    };
    setSavingEdit(true);
    setEditMessage('Saving product...');
    try {
      const data = await api(`/products/${editingProduct.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      setEditingProduct(data.product || null);
      setEditMessage('Product saved.');
      setMessage('Product saved.');
      setRefresh((value) => value + 1);
      setOperationsRefresh((value) => value + 1);
    } catch (err) {
      setEditMessage(err.message);
    } finally {
      setSavingEdit(false);
    }
  };

  const rebuildCategories = async () => {
    setMessage('Rebuilding product categories...');
    try {
      const data = await api('/products/recategorize', { method: 'POST' });
      setMessage(`Categories rebuilt. Updated ${data.updated || 0} of ${data.checked || 0} products.`);
      setRefresh((value) => value + 1);
      setOperationsRefresh((value) => value + 1);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const setTokenDraft = (userId, value) => {
    setTokenDrafts((current) => ({ ...current, [userId]: value }));
  };

  const updateUserTokens = (userId, mode) => {
    const rawAmount = tokenDrafts[userId];
    const amount = Number(rawAmount);
    if (rawAmount === '' || rawAmount === undefined || !Number.isSafeInteger(amount) || amount < 0) {
      setMessage('Enter a non-negative whole token amount first.');
      return;
    }
    const user = usersState.users.find((item) => item.id === userId);
    setPendingAction({ type: 'tokens', user, userId, mode, amount });
  };

  const updateUserStatus = (user, status) => {
    setPendingAction({ type: 'user-status', user, status });
  };

  const removeUser = (user) => {
    setPendingAction({ type: 'remove-user', user });
  };

  const confirmPendingAction = async ({ reason = '', confirmation = '' } = {}) => {
    const action = pendingAction;
    if (!action || actionBusy) return;
    setActionBusy(true);
    let completed = false;
    try {
      if (action.type === 'tokens') {
        setMessage(action.mode === 'add' ? 'Adding tokens...' : 'Updating token balance...');
        await api(`/auth/admin/users/${action.userId}/tokens`, {
          method: 'PATCH',
          body: JSON.stringify({ mode: action.mode, amount: action.amount })
        });
        setTokenDrafts((current) => ({ ...current, [action.userId]: '' }));
        setUserRefresh((value) => value + 1);
        setOperationsRefresh((value) => value + 1);
        setMessage(action.mode === 'add' ? `Added ${action.amount} tokens.` : `Set balance to ${action.amount} tokens.`);
      } else if (action.type === 'user-status') {
        setMessage(action.status === 'banned' ? 'Banning user...' : 'Restoring user access...');
        await api(`/auth/admin/users/${action.user.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: action.status, reason: reason.trim() })
        });
        setUserRefresh((value) => value + 1);
        setOperationsRefresh((value) => value + 1);
        setMessage(action.status === 'banned' ? 'User banned.' : 'User access restored.');
      } else if (action.type === 'remove-user') {
        setMessage('Removing user personal data...');
        const data = await api(`/auth/admin/users/${action.user.id}`, {
          method: 'DELETE',
          body: JSON.stringify({ confirmation: 'ANONYMIZE' })
        });
        setUserRefresh((value) => value + 1);
        setOperationsRefresh((value) => value + 1);
        setMessage(data.storageCleanupComplete ? 'User removed. Payment records were preserved.' : 'User removed, with a storage cleanup warning recorded.');
      } else if (action.type === 'delete-product') {
        if (confirmation !== 'DELETE') throw new Error('Type DELETE to permanently remove this product.');
        setMessage('Deleting product and related try-ons...');
        const data = await api(`/products/${action.product.id}/permanent`, {
          method: 'DELETE',
          body: JSON.stringify({ confirmation })
        });
        setEditingProduct((current) => current?.id === action.product.id ? null : current);
        setSelectedIds((current) => {
          const next = new Set(current);
          next.delete(action.product.id);
          return next;
        });
        setRefresh((value) => value + 1);
        setOperationsRefresh((value) => value + 1);
        setMessage(data.storageCleanupComplete ? 'Product permanently deleted.' : 'Product deleted, with a storage cleanup warning recorded.');
      }
      completed = true;
    } catch (err) {
      setMessage(err.message);
    } finally {
      setActionBusy(false);
      if (completed) setPendingAction(null);
    }
  };

  if (!adminSession?.token) {
    return (
      <AdminLogin
        onLogin={completeLogin}
        theme={theme}
        onThemeToggle={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
      />
    );
  }

  return (
    <main className="admin-shell">
      <div className={`admin-frame ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className="admin-sidebar" aria-label="Admin navigation">
          <div className="sidebar-brand-row">
            <div className="sidebar-brand">
              <strong>Lookmefy</strong>
              <span>Admin</span>
            </div>
            <button
              className="sidebar-toggle"
              type="button"
              onClick={() => setSidebarCollapsed((value) => !value)}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!sidebarCollapsed}
            >
              {sidebarCollapsed ? '>' : '<'}
            </button>
          </div>
          {hasUserOperations && <button className="sidebar-create" type="button" onClick={openCreateProduct}>
            <b>+</b>
            <span>Add Product</span>
          </button>}
          <nav className="sidebar-nav" aria-label="Admin pages">
            {navigationSections.map((section) => (
              <section className="sidebar-section" key={section.id} aria-labelledby={`sidebar-${section.id}`}>
                <p className="sidebar-section-label" id={`sidebar-${section.id}`}>{section.label}</p>
                <div className="sidebar-section-pages">
                  {section.pages.map((page) => {
                    const selected = activePage === page.id || (activePage === 'add-product' && page.id === 'inventory');
                    return (
                      <button
                        key={page.id}
                        type="button"
                        className={selected ? 'active' : ''}
                        aria-current={selected ? 'page' : undefined}
                        title={sidebarCollapsed ? page.label : undefined}
                        onClick={() => showPage(page.id)}
                      >
                        <b aria-hidden="true"><SidebarIcon id={page.icon} /></b>
                        <span>{page.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </nav>
          <div className="sidebar-session">
            <span>{adminDisplayName} · {currentAdmin?.role === 'master' ? 'Master' : 'Developer'}</span>
            <button type="button" onClick={logout}>Logout</button>
          </div>
        </aside>
        <section className="admin-workspace">
          <header className="admin-topbar">
            <div className="admin-brand">
              <span>Lookmefy</span>
              <strong>Admin</strong>
            </div>
            <nav className="admin-breadcrumb" aria-label="Breadcrumb">
              <span>Admin</span>
              <b aria-hidden="true">/</b>
              <span>{activeSection.label}</span>
              <b aria-hidden="true">/</b>
              <strong>{pageCopy.title}</strong>
            </nav>
            <GlobalAdminSearch
              value={globalSearch}
              onChange={setGlobalSearch}
              products={state.products}
              users={usersState.users}
              pages={searchablePages}
              onProduct={openProductFromSearch}
              onUser={openUserFromSearch}
              onPage={showPage}
              remoteEnabled={hasUserOperations}
            />
            <div className="admin-profile">
              <span>{adminDisplayName}</span>
              <button className="theme-toggle" type="button" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}>
                <span aria-hidden="true" />
              </button>
              <button type="button" onClick={logout}>Logout</button>
            </div>
          </header>

          <section className="admin-head">
            <div>
              <p className="kicker">{pageCopy.kicker}</p>
              <h1>{pageCopy.title}</h1>
              <p className="lead">{pageCopy.lead}</p>
            </div>
            <div className="hero-actions">
              <button type="button" onClick={refreshCurrentPage}>Refresh Page</button>
              {['inventory', 'add-product'].includes(activePage) && <button type="button" onClick={rebuildCategories}>Rebuild Categories</button>}
              {['overview', 'inventory', 'add-product'].includes(activePage) && <button className="primary-action" type="button" onClick={openCreateProduct}>Add Product</button>}
            </div>
          </section>

          {activePage === 'inventory' && <section className="overview-grid" aria-label="Admin summary">
            <StatBox label="Available" value={formatNumber(state.availabilityCounts?.available || 0)} meta="visible and eligible for try-on" />
            <StatBox label="Out of stock" value={formatNumber(state.availabilityCounts?.out_of_stock || 0)} meta="temporarily hidden" />
            <StatBox label="Review queue" value={formatNumber((state.availabilityCounts?.unavailable || 0) + (state.availabilityCounts?.draft || 0))} meta="unavailable and draft items" />
            <StatBox label="Archived" value={formatNumber(state.availabilityCounts?.archived || 0)} meta="retained outside the storefront" />
          </section>}

          {activePage === 'overview' && (
            <OverviewWorkspace
              products={state.products}
              totalProducts={state.total || 0}
              facets={state.facets}
              reviewItems={reviewItems}
              recommendationStats={recommendationStats.stats}
              usersState={usersState}
              operationsState={operationsState}
              onOpenInventory={() => showPage('inventory')}
              onOpenAnalytics={() => showPage('analytics')}
              onOpenUsers={() => showPage('users')}
              onAddProduct={openCreateProduct}
              onRebuildCategories={rebuildCategories}
              loading={state.loading || usersState.loading || recommendationStats.loading || operationsState.loading}
            />
          )}

          {activePage === 'inventory' && <section className="admin-command-bar" aria-label="Catalog actions">
            <div>
              <strong>{availableProductCount} available of {state.total || 0} catalog products</strong>
              <span>Affiliate availability, merchandising, and catalog review controls.</span>
            </div>
            <div>
              <button type="button" onClick={rebuildCategories}>Rebuild Categories</button>
              <button className="danger-action" type="button" onClick={removeAllProducts} disabled={state.loading || !availableProductCount}>Archive All Available</button>
            </div>
          </section>}

          {(activePage === 'inventory' || activePage === 'add-product') && <section className={`admin-grid ${activePage === 'add-product' ? 'create-grid' : 'inventory-grid'}`}>
            <form className={`admin-card admin-form ${createBusy ? 'is-busy' : ''}`} onSubmit={submit} ref={formRef} aria-busy={createBusy}>
              <div className="card-head">
                <div>
                  <h2>Create Product</h2>
                  <p>Fetch a draft, review the details, and publish to the catalog.</p>
                </div>
                <span>{creatingProduct ? 'Publishing' : smartImporting ? 'Fetching batch' : fetchingDraft ? 'Fetching draft' : 'Draft to publish'}</span>
              </div>
              <section className="form-section smart-import-section">
                <div className="form-section-title"><strong>Smart catalog fetch</strong><span>Draft review required</span></div>
                <div className="smart-import-command">
                  <label className="field">
                    <span>Products to find</span>
                    <input
                      type="text"
                      value={smartCommand}
                      maxLength="180"
                      placeholder="10 black T-shirts for men"
                      disabled={createBusy}
                      onChange={(event) => setSmartCommand(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        runSmartImport();
                      }}
                    />
                  </label>
                  <button type="button" onClick={runSmartImport} disabled={createBusy || !smartCommand.trim()}>
                    {smartImporting && <span className="button-spinner" aria-hidden="true" />}
                    {smartImporting ? 'Fetching batch...' : 'Find and create drafts'}
                  </button>
                </div>
                {smartImportResult && <SmartImportResult batch={smartImportResult} onReview={reviewSmartDrafts} />}
              </section>
              <section className="form-section">
                <div className="form-section-title"><strong>Import</strong><span>Start from an affiliate URL or fill manually.</span></div>
                <fieldset className="segmented-field fetch-type-field" disabled={creatingProduct}>
                  <legend>Fetch as</legend>
                  <label><input type="radio" name="fetchItemType" value="auto" defaultChecked /><span>Auto detect</span></label>
                  <label><input type="radio" name="fetchItemType" value="accessory" /><span>Accessory</span></label>
                </fieldset>
                <div className="affiliate-import">
                  <label className="field">
                    <span>Affiliate link</span>
                    <input name="affiliateLink" type="url" placeholder="https://brand.com/product-page" disabled={creatingProduct} />
                  </label>
                  <button type="button" onClick={previewAffiliate} disabled={createBusy}>
                    {fetchingDraft && <span className="button-spinner" aria-hidden="true" />}
                    {fetchingDraft ? 'Fetching...' : 'Fetch Details'}
                  </button>
                </div>
                <DraftFetchStatus status={draftStatus} />
              </section>
              <input name="remoteImageUrl" type="hidden" />
              <input name="sourceUrl" type="hidden" />
              <input name="currency" type="hidden" defaultValue="USD" />
              {previewImage && (
                <div className="link-preview">
                  <img src={mediaUrl(previewImage)} alt="" />
                  <div><strong>Remote image found</strong><span>This image URL will be linked directly unless you upload another one.</span></div>
                </div>
              )}
              <section className="form-section">
                <div className="form-section-title"><strong>Product Details</strong><span>Shown on product cards and detail pages.</span></div>
                <label className="field"><span>Name</span><input name="name" required placeholder="Linen Blend Shirt" disabled={creatingProduct} /></label>
                <label className="field"><span>Brand</span><input name="brand" required placeholder="Zara" disabled={creatingProduct} /></label>
                <div className="two-col">
                  <label className="field"><span>Category</span><input name="category" required placeholder="shirts" disabled={creatingProduct} /></label>
                  <label className="field"><span>Gender</span><select name="gender" defaultValue="men" disabled={creatingProduct}><option value="men">Men</option><option value="women">Women</option><option value="unisex">Unisex</option></select></label>
                </div>
                <fieldset className="segmented-field placement-field" disabled={creatingProduct}>
                  <legend>Fit area</legend>
                  <label><input type="radio" name="garmentPlacement" value="top" defaultChecked /><span>Top</span></label>
                  <label><input type="radio" name="garmentPlacement" value="bottom" /><span>Bottom</span></label>
                  <label><input type="radio" name="garmentPlacement" value="full-body" /><span>Full body</span></label>
                  <label><input type="radio" name="garmentPlacement" value="accessory" /><span>Accessory</span></label>
                </fieldset>
                <label className="field"><span>Description</span><textarea name="description" rows="4" placeholder="Short product description" disabled={creatingProduct} /></label>
              </section>
              <section className="form-section">
                <div className="form-section-title"><strong>Price and Tags</strong><span>Used for filters, product cards, and sorting.</span></div>
                <div className="two-col">
                  <label className="field"><span>Price</span><input name="price" type="number" step="0.01" min="0" required placeholder="29.99" disabled={creatingProduct} /></label>
                  <label className="field"><span>Compare price</span><input name="compareAtPrice" type="number" step="0.01" min="0" placeholder="49.99" disabled={creatingProduct} /></label>
                </div>
                <div className="two-col">
                  <label className="field"><span>Rating</span><input name="rating" type="number" step="0.1" min="0" max="5" defaultValue="4.5" disabled={creatingProduct} /></label>
                  <label className="field"><span>Rating count</span><input name="ratingCount" type="number" min="0" defaultValue="0" disabled={creatingProduct} /></label>
                </div>
                <label className="field"><span>Badge</span><input name="badge" placeholder="New" disabled={creatingProduct} /></label>
                <label className="field"><span>Tags</span><input name="tags" placeholder="linen, casual, summer" disabled={creatingProduct} /></label>
                <label className="field"><span>Colors</span><input name="colors" placeholder="#d9c8b4, #123323, white" disabled={creatingProduct} /></label>
                <label className="field"><span>Sizes</span><input name="sizes" placeholder="S, M, L, XL" disabled={creatingProduct} /></label>
                <label className="field"><span>Size note</span><input name="sizeNotes" placeholder="Optional fit or sizing note" disabled={creatingProduct} /></label>
              </section>
              <section className="form-section">
                <div className="form-section-title"><strong>Media & Publish</strong><span>Upload an image only if affiliate fetch did not find one.</span></div>
                <label className="upload-box">
                  <input name="image" type="file" accept="image/*" disabled={creatingProduct} />
                  <span><span className="upload-icon">+</span><span className="upload-title">Upload product image</span><span className="upload-help">Optional if the affiliate link found an image.</span></span>
                </label>
                <div className="checks">
                  <label><input name="isFeatured" type="checkbox" disabled={creatingProduct} /> Featured</label>
                  <label><input name="isNewArrival" type="checkbox" defaultChecked disabled={creatingProduct} /> New arrival</label>
                </div>
                <label className="field"><span>Availability</span><select name="availabilityStatus" defaultValue="available" disabled={creatingProduct}><option value="draft">Draft</option><option value="available">Available</option><option value="out_of_stock">Out of stock</option><option value="unavailable">Unavailable</option><option value="archived">Archived</option></select></label>
                <label className="field"><span>Inventory note</span><input name="inventoryNotes" placeholder="Optional source or availability note" disabled={creatingProduct} /></label>
              </section>
              <button className="submit" disabled={createBusy}>
                {creatingProduct && <span className="button-spinner" aria-hidden="true" />}
                {creatingProduct ? 'Publishing...' : fetchingDraft ? 'Finish fetch first' : 'Upload Product'}
              </button>
              {message && <p className="form-message">{message}</p>}
            </form>

            <section className="admin-card catalog-panel">
              <div className="section-head admin-catalog-head">
                <div>
                  <h2>Catalog</h2>
                  <p>{state.total} affiliate products matching the current view.</p>
                </div>
                <div className="catalog-head-actions">
                  <span className="count">{state.products.length} loaded</span>
                  <button type="button" onClick={toggleAllVisible} disabled={!state.products.length}>
                    {state.products.length && state.products.every((product) => selectedIds.has(product.id)) ? 'Clear Selection' : 'Select Visible'}
                  </button>
                </div>
              </div>
              <CatalogFilters filters={filters} facets={state.facets} onChange={updateFilter} onClear={clearFilters} />
              <QaSummary items={reviewItems} onOpen={openEditor} />
              <BulkActionBar
                selectedProducts={selectedProducts}
                onFeature={() => bulkPatch({ isFeatured: true }, 'Marking selected as featured')}
                onUnfeature={() => bulkPatch({ isFeatured: false }, 'Removing featured flag')}
                onNewArrival={() => bulkPatch({ isNewArrival: true }, 'Marking selected as new arrivals')}
                onClearNewArrival={() => bulkPatch({ isNewArrival: false }, 'Clearing new arrival flag')}
                onAvailable={() => bulkAvailability('available', 'Marking selected available')}
                onOutOfStock={() => bulkAvailability('out_of_stock', 'Marking selected out of stock')}
                onUnavailable={() => bulkAvailability('unavailable', 'Marking selected unavailable')}
                onDraft={() => bulkAvailability('draft', 'Moving selected to draft')}
                onRemove={bulkRemove}
              />
              {state.loading && <AdminProductSkeleton />}
              {state.error && <StatusPanel text={state.error} />}
              {!state.loading && !state.error && state.products.length === 0 && <StatusPanel text="No products yet." />}
              {!state.loading && !state.error && state.products.length > 0 && <CatalogTableHeader />}
              <div className="admin-products">
                {state.products.map((product) => (
                  <AdminProductRow
                    key={product.id}
                    product={product}
                    selected={selectedIds.has(product.id)}
                    qaFlags={productQaFlags(product, duplicateWarnings.get(product.id) || [])}
                    onSelect={() => toggleSelected(product.id)}
                    onEdit={() => openEditor(product)}
                    onPlacement={updateGarmentPlacement}
                    onAvailability={updateProductAvailability}
                    onDelete={requestDeleteProduct}
                  />
                ))}
              </div>
              <PaginationControls page={state.pagination?.page || inventoryPage} pages={state.pagination?.pages || 1} total={state.pagination?.total || state.total} loading={state.loading} label="products" onPage={setInventoryPage} />
            </section>
          </section>}

          {activePage === 'analytics' && (
            <RecommendationStatsCard
              state={recommendationStats}
              onRefresh={() => setRefresh((value) => value + 1)}
              period={analyticsPeriod}
              onPeriodChange={setAnalyticsPeriod}
              categoryDistribution={categoryDistribution}
              categoryTotal={state.total || state.products.length}
            />
          )}

          {activePage === 'users' && (
            <UsersTokenPage
              state={usersState}
              search={userSearch}
              status={userStatus}
              minTokens={userTokenRange.min}
              maxTokens={userTokenRange.max}
              page={userPage}
              sort={userSort}
              operationsState={operationsState}
              tokenDrafts={tokenDrafts}
              onSearch={(value) => { setUserPage(1); setUserSearch(value); }}
              onStatus={(value) => { setUserPage(1); setUserStatus(value); }}
              onMinTokens={(value) => { setUserPage(1); setUserTokenRange((current) => ({ ...current, min: value })); }}
              onMaxTokens={(value) => { setUserPage(1); setUserTokenRange((current) => ({ ...current, max: value })); }}
              onPage={setUserPage}
              onSort={(value) => { setUserPage(1); setUserSort(value); }}
              onDraftChange={setTokenDraft}
              onUpdateTokens={updateUserTokens}
              onUpdateStatus={updateUserStatus}
              onRemoveUser={removeUser}
              onOpenUser={setMediaUser}
              onRefresh={() => setUserRefresh((value) => value + 1)}
            />
          )}

          {activePage === 'storage' && <StoragePage refresh={refresh} onOpenUser={setMediaUser} />}

          {activePage === 'orders' && <OrdersPage refresh={operationsRefresh} />}

          {activePage === 'system-overview' && <SystemOverviewPage state={systemSummaryState} onNavigate={showPage} />}
          {activePage === 'service-health' && <ServiceHealthPage state={systemSummaryState} />}
          {activePage === 'failures' && <FailuresPage incidentsState={incidentsState} generationState={generationState} onIncidentStatus={updateIncidentStatus} />}
          {activePage === 'api-performance' && <ApiPerformancePage state={systemSummaryState} />}
          {activePage === 'generation-pipeline' && <GenerationPipelinePage state={generationState} />}
          {activePage === 'ios-report' && <MobileReportPage state={mobileState} platform="ios" />}
          {activePage === 'android-report' && <MobileReportPage state={mobileState} platform="android" />}
          {activePage === 'audit-log' && <div className="management-page"><AuditLogPanel refresh={operationsRefresh} onRefresh={() => setOperationsRefresh((value) => value + 1)} /></div>}

          {activePage === 'roles' && <AdminRolesPage request={api} currentAdmin={currentAdmin} onSessionRefresh={refreshAdminSession} />}

          {activePage === 'cost-overview' && <CostOverviewPage state={costOverviewState} onNavigate={showPage} />}
          {hasCostManagement && activeCostProvider && <ProviderCostPage state={providerCostState} />}

          {activePage === 'settings' && (
            <div className="settings-page">
              <section className="settings-grid">
              <section className="admin-card settings-panel">
                <div className="section-head">
                  <div>
                    <h2>Admin Access</h2>
                    <p>Your personal admin identity and assigned section access.</p>
                  </div>
                </div>
                <div className="settings-summary-card">
                  <span>Current session</span>
                  <strong>{adminDisplayName}</strong>
                  <p>{currentAdmin?.email}</p>
                </div>
                <div className="settings-list">
                  <div><span>Role</span><strong>{currentAdmin?.role === 'master' ? 'Master' : 'Developer'}</strong></div>
                  <div><span>Section access</span><strong>{currentAdmin?.sectionAccess?.length || 0} of 3</strong></div>
                  <div><span>Session duration</span><strong>12 hours</strong></div>
                </div>
              </section>
              <section className="admin-card settings-panel">
                <div className="section-head">
                  <div>
                    <h2>Current Login</h2>
                    <p>Refresh data or sign out from this browser.</p>
                  </div>
                </div>
                <div className="settings-actions">
                  {hasSystemManagement && <button type="button" onClick={() => showPage('system-overview')}>Open System Overview</button>}
                  {hasSystemManagement && <button type="button" onClick={() => showPage('audit-log')}>Open Audit Log</button>}
                  <button className="danger-action" type="button" onClick={logout}>Logout</button>
                </div>
              </section>
              {hasSystemManagement && (
                <section className="admin-card settings-panel">
                  <div className="section-head">
                    <div>
                      <h2>Storefront Mode</h2>
                      <p>Switch product CTAs, checkout, and policies between affiliate and ecommerce demo mode.</p>
                    </div>
                  </div>
                  {storefrontSettingsState.loading && <StatusPanel text="Loading storefront settings..." />}
                  {storefrontSettingsState.error && <StatusPanel text={storefrontSettingsState.error} />}
                  {!storefrontSettingsState.loading && !storefrontSettingsState.error && (
                    <div className="settings-list storefront-settings-list">
                      <div><span>Demo ecommerce</span><strong>{storefrontSettingsState.data?.setting?.demoEcommerceMode ? 'Enabled' : 'Disabled'}</strong></div>
                      <div><span>Last updated</span><strong>{formatCatalogDate(storefrontSettingsState.data?.setting?.updatedAt)}</strong></div>
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => toggleDemoMode(!storefrontSettingsState.data?.setting?.demoEcommerceMode)}
                      >
                        {storefrontSettingsState.data?.setting?.demoEcommerceMode ? 'Disable demo checkout' : 'Enable demo checkout'}
                      </button>
                    </div>
                  )}
                </section>
              )}
              </section>
            </div>
          )}

          {editingProduct && <ProductEditor product={editingProduct} message={editMessage} saving={savingEdit} onClose={closeEditor} onSubmit={submitEdit} />}
          {mediaUser && <UserMediaDrawer key={mediaUser.id} user={mediaUser} onClose={() => setMediaUser(null)} />}
          {pendingAction && <AdminConfirmDialog action={pendingAction} busy={actionBusy} onCancel={() => setPendingAction(null)} onConfirm={confirmPendingAction} />}
        </section>
      </div>
      {message && <AdminToast message={message} onDismiss={() => setMessage('')} />}
    </main>
  );
}

function SidebarIcon({ id }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '2',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    focusable: 'false'
  };
  if (id === 'overview') {
    return (
      <svg {...common}>
        <path d="M4 11l8-7 8 7" />
        <path d="M6 10v9h12v-9" />
        <path d="M10 19v-5h4v5" />
      </svg>
    );
  }
  if (id === 'inventory') {
    return (
      <svg {...common}>
        <path d="M4 7h16" />
        <path d="M6 7l1 12h10l1-12" />
        <path d="M9 11h6" />
        <path d="M9 15h4" />
      </svg>
    );
  }
  if (id === 'analytics') {
    return (
      <svg {...common}>
        <path d="M5 19V9" />
        <path d="M12 19V5" />
        <path d="M19 19v-7" />
        <path d="M3 19h18" />
      </svg>
    );
  }
  if (id === 'users') {
    return (
      <svg {...common}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
        <circle cx="9.5" cy="7" r="4" />
        <path d="M20 8v6" />
        <path d="M17 11h6" />
      </svg>
    );
  }
  if (id === 'storage') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9" r="1.5" />
        <path d="m5 17 4.5-4 3 2.5 2.5-2 4 3.5" />
      </svg>
    );
  }
  if (id === 'orders') {
    return <svg {...common}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>;
  }
  if (id === 'system') {
    return <svg {...common}><path d="M3 12h4l2-6 4 12 2-6h6" /><path d="M4 4h16v16H4z" /></svg>;
  }
  if (id === 'services') {
    return <svg {...common}><rect x="4" y="3" width="16" height="7" rx="2" /><rect x="4" y="14" width="16" height="7" rx="2" /><path d="M8 7h.01M8 18h.01M12 7h5M12 18h5" /></svg>;
  }
  if (id === 'failures') {
    return <svg {...common}><path d="M12 3 2.5 20h19z" /><path d="M12 9v5M12 17h.01" /></svg>;
  }
  if (id === 'api') {
    return <svg {...common}><path d="M4 17a8 8 0 1 1 16 0" /><path d="m12 13 4-4M6 20h12" /></svg>;
  }
  if (id === 'generation') {
    return <svg {...common}><path d="m12 3 1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4z" /><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8zM5 13l.7 1.8L7.5 15l-1.8.7L5 17.5l-.7-1.8L2.5 15l1.8-.7z" /></svg>;
  }
  if (id === 'video') {
    return <svg {...common}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3z" /></svg>;
  }
  if (id === 'ios' || id === 'android') {
    return <svg {...common}><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M10 5h4M11 18h2" /></svg>;
  }
  if (id === 'audit') {
    return <svg {...common}><path d="M9 4h6l1 3h3v14H5V7h3z" /><path d="M9 12h6M9 16h6" /></svg>;
  }
  if (id === 'roles') {
    return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2" /><path d="m16 11 2 2 4-4" /></svg>;
  }
  if (id === 'costs') {
    return <svg {...common}><path d="M4 7h15a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13" /><path d="M16 12h5M17 15h.01" /></svg>;
  }
  if (id === 'database') {
    return <svg {...common}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></svg>;
  }
  if (id === 'otp') {
    return <svg {...common}><path d="M4 4h16v12H8l-4 4z" /><path d="M8 10h.01M12 10h.01M16 10h.01" /></svg>;
  }
  if (id === 'cloud') {
    return <svg {...common}><path d="M17.5 19H6a4 4 0 0 1-.4-8A6.5 6.5 0 0 1 18 9a5 5 0 0 1-.5 10z" /></svg>;
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 7A2 2 0 1 1 7.1 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1z" />
    </svg>
  );
}

function GlobalAdminSearch({ value, onChange, products, users, pages = [], onProduct, onUser, onPage, remoteEnabled = false }) {
  const [focused, setFocused] = useState(false);
  const [remote, setRemote] = useState({ products: [], users: [], loading: false, query: '' });
  const [recentSearches, setRecentSearches] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(ADMIN_RECENT_SEARCHES_KEY) || '[]');
    } catch {
      return [];
    }
  });
  const query = value.trim().toLowerCase();
  useEffect(() => {
    if (!remoteEnabled || query.length < 2) {
      setRemote({ products: [], users: [], loading: false, query: '' });
      return undefined;
    }
    let alive = true;
    const timeout = window.setTimeout(() => {
      setRemote((current) => ({ ...current, loading: true, query }));
      api(`/auth/admin/search?q=${encodeURIComponent(query)}`)
        .then((data) => {
          if (alive) setRemote({ products: data.products || [], users: data.users || [], loading: false, query });
        })
        .catch(() => {
          if (alive) setRemote({ products: [], users: [], loading: false, query });
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [query, remoteEnabled]);
  const localProductResults = query ? products
    .filter((product) => [product.name, product.brand, product.category].some((field) => String(field || '').toLowerCase().includes(query)))
    .slice(0, 4) : [];
  const localUserResults = query ? users
    .filter((user) => [
      user.id,
      user.name,
      user.email,
      user.phone,
      user.username,
      user.genderPreference,
      user.accountStatus,
      user.tokens,
      user.subscription?.planId,
      user.subscription?.status
    ].some((field) => String(field ?? '').toLowerCase().includes(query)))
    .slice(0, 4) : [];
  const productResults = remote.query === query && !remote.loading ? remote.products.slice(0, 4) : localProductResults;
  const userResults = remote.query === query && !remote.loading ? remote.users.slice(0, 4) : localUserResults;
  const pageResults = query ? pages.filter((page) => page.label.toLowerCase().includes(query)).slice(0, 3) : [];
  const hasResults = Boolean(productResults.length || userResults.length || pageResults.length);
  const remember = (label) => {
    const next = [String(label || '').trim(), ...recentSearches.filter((item) => item !== label)].filter(Boolean).slice(0, 4);
    setRecentSearches(next);
    try {
      localStorage.setItem(ADMIN_RECENT_SEARCHES_KEY, JSON.stringify(next));
    } catch {
      // Recent searches are optional when browser storage is unavailable.
    }
  };
  const choose = (handler, item, label) => {
    remember(label);
    handler(item);
    onChange('');
    setFocused(false);
  };

  return (
    <div className="global-search">
      <label>
        <span>Search admin</span>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          placeholder="Search products, users, pages..."
          autoComplete="off"
        />
      </label>
      {focused && (
        <div className="global-search-results">
          {!query && recentSearches.length > 0 && <span className="search-group-label">Recent searches</span>}
          {!query && recentSearches.map((recent) => (
            <button type="button" key={`recent-${recent}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onChange(recent)}>
              <strong>{recent}</strong>
              <span>Search again</span>
            </button>
          ))}
          {!query && <span className="search-group-label">Quick navigation</span>}
          {!query && ADMIN_PAGES.slice(0, 5).map((page) => (
            <button type="button" key={`quick-${page.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(onPage, page.id, page.label)}>
              <strong>{page.label}</strong>
              <span>Open page</span>
            </button>
          ))}
          {productResults.map((product) => (
            <button type="button" key={`product-${product.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(onProduct, product, product.name)}>
              <strong>{product.name}</strong>
              <span>Product - {displayBrand(product)} - {displayCategory(product)}</span>
            </button>
          ))}
          {userResults.map((user) => (
            <button type="button" key={`user-${user.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(onUser, user, user.email)}>
              <strong>{user.name || user.email}</strong>
              <span>User - {user.email}</span>
            </button>
          ))}
          {pageResults.map((page) => (
            <button type="button" key={`page-${page.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(onPage, page.id, page.label)}>
              <strong>{page.label}</strong>
              <span>Open page</span>
            </button>
          ))}
          {remote.loading && <p className="search-empty">Searching all records...</p>}
          {query && !remote.loading && !hasResults && <p className="search-empty">No matching products, users, or pages.</p>}
        </div>
      )}
    </div>
  );
}

function OverviewWorkspace({
  products,
  totalProducts,
  facets,
  reviewItems,
  recommendationStats,
  usersState,
  operationsState,
  onOpenInventory,
  onOpenAnalytics,
  onOpenUsers,
  onAddProduct,
  onRebuildCategories,
  loading
}) {
  const recentProducts = products.slice(0, 5);
  const categories = facets?.categories?.length || facets?.categoryCounts?.length || 0;
  const brands = facets?.brands?.length || 0;
  const totals = recommendationStats?.totals || {};
  const topProduct = recommendationStats?.topProducts?.[0];
  const topCategory = recommendationStats?.topCategories?.[0];
  const topEvent = recommendationStats?.eventCounts?.[0];
  const qaRate = totalProducts ? Math.round(((totalProducts - reviewItems.length) / totalProducts) * 100) : 0;
  const lowTokenUsers = usersState.users.filter((user) => Number(user.tokens || 0) <= 5).slice(0, 5);
  const paymentIssues = operationsState.orders.filter((order) => ['failed', 'pending'].includes(order.status)).slice(0, 5);

  return (
    <section className="overview-crm">
      <section className="admin-card overview-command-card">
        <div>
          <p className="kicker">Today</p>
          <h2>Today at a glance</h2>
          <p>Products, users, tokens, and the work that needs attention.</p>
        </div>
        <div className="overview-command-actions">
          <button type="button" onClick={onAddProduct}><span aria-hidden="true">+</span>Add Product</button>
          <button type="button" onClick={onOpenUsers}><span aria-hidden="true">$</span>Manage Tokens</button>
          <button type="button" onClick={onRebuildCategories}><span aria-hidden="true">!</span>Fix Categories</button>
        </div>
      </section>

      {loading ? <OverviewSkeleton /> : <section className="overview-crm-grid">
        <section className="admin-card crm-card catalog-pipeline-card">
          <div className="section-head">
            <div>
              <h2>Product Status</h2>
              <p>How many products are live and how clean the list is.</p>
            </div>
            <button type="button" onClick={onOpenInventory}>Inventory</button>
          </div>
          <div className="pipeline-score">
            <span>{qaRate}%</span>
            <div>
              <strong>Ready to show</strong>
              <p>{formatNumber(totalProducts)} active products across {formatNumber(categories)} categories and {formatNumber(brands)} brands.</p>
            </div>
          </div>
          <div className="pipeline-breakdown">
            <div><span>Need fixes</span><strong>{formatNumber(reviewItems.length)}</strong></div>
            <div><span>Categories</span><strong>{formatNumber(categories)}</strong></div>
            <div><span>Brands</span><strong>{formatNumber(brands)}</strong></div>
          </div>
        </section>

        <section className="admin-card crm-card attention-card">
          <div className="section-head">
            <div>
              <h2>Action Inbox</h2>
              <p>Product fixes, low token users, and payment issues.</p>
            </div>
            <button type="button" onClick={onOpenInventory}>Resolve</button>
          </div>
          <ActionInbox
            reviewItems={reviewItems}
            lowTokenUsers={lowTokenUsers}
            paymentIssues={paymentIssues}
            onOpenInventory={onOpenInventory}
            onOpenUsers={onOpenUsers}
          />
        </section>

        <StatBox className="overview-bento-stat active-products-stat" label="Active products" value={formatNumber(totalProducts || 0)} meta={`${formatNumber(categories)} categories`} />
        <StatBox className="overview-bento-stat" label="Need fixes" value={formatNumber(reviewItems.length)} meta="products to clean up" />
        <StatBox className="overview-bento-stat" label="Users 30d" value={formatNumber(totals.activeUsers30d || 0)} meta="active this month" />
        <StatBox className="overview-bento-stat" label="Total tokens" value={formatNumber(usersState.totals?.tokens || 0)} meta="available to users" />

        <section className="admin-card crm-card recent-products-card">
          <div className="section-head">
            <div>
              <h2>New Products</h2>
              <p>Latest products added to the admin list.</p>
            </div>
            <button type="button" onClick={onOpenInventory}>Open</button>
          </div>
          <div className="recent-product-list">
            {recentProducts.length === 0 ? <StatusPanel text="No products loaded yet." /> : recentProducts.map((product) => (
              <article key={product.id} className="recent-product-item">
                <ProductThumbnail product={product} decorative />
                <div>
                  <strong>{product.name}</strong>
                  <span>{displayBrand(product)} - {displayCategory(product)}</span>
                </div>
                <b>{formatMoney(product.price || 0, product.currency)}</b>
              </article>
            ))}
          </div>
        </section>

        <section className="admin-card crm-card user-pulse-card">
          <div className="section-head">
            <div>
              <h2>Users and Tokens</h2>
              <p>Customer count, token pool, and recent app activity.</p>
            </div>
            <button type="button" onClick={onOpenUsers}>Users</button>
          </div>
          <div className="user-pulse-grid">
            <div><span>Users</span><strong>{formatNumber(usersState.totals?.users || 0)}</strong></div>
            <div><span>Total tokens</span><strong>{formatNumber(usersState.totals?.tokens || 0)}</strong></div>
            <div><span>Active 30d</span><strong>{formatNumber(totals.activeUsers30d || 0)}</strong></div>
            <div><span>Profiles</span><strong>{formatNumber(totals.preferenceProfiles || 0)}</strong></div>
          </div>
          <div className="signal-summary-strip">
            <div><span>Top action</span><strong>{topEvent ? formatEventType(topEvent.type) : 'No action'}</strong></div>
            <div><span>Top category</span><strong>{topCategory?.label || 'No category'}</strong></div>
            <div><span>Top product</span><strong>{topProduct?.name || 'No product'}</strong></div>
          </div>
          <button className="wide-card-action" type="button" onClick={onOpenAnalytics}>Open Analytics</button>
        </section>
      </section>}
    </section>
  );
}

function ActionInbox({ reviewItems, lowTokenUsers, paymentIssues, onOpenInventory, onOpenUsers }) {
  const [visibleCount, setVisibleCount] = useState(6);
  const items = [
    ...reviewItems.map(({ product, flags }) => ({ id: `product-${product.id}`, kicker: 'Product fix', title: product.name, detail: flags.slice(0, 2).join(', '), onClick: onOpenInventory })),
    ...lowTokenUsers.map((user) => ({ id: `user-${user.id}`, kicker: 'Low tokens', title: user.name || user.email, detail: `${formatNumber(user.tokens || 0)} tokens left`, onClick: onOpenUsers })),
    ...paymentIssues.map((order) => ({ id: `order-${order.id}`, kicker: `${order.status} payment`, title: order.user?.name || order.user?.email || order.merchantOrderId, detail: `${formatMoney(order.amount || 0, order.currency)} - ${formatCatalogDate(order.createdAt)}`, onClick: onOpenUsers }))
  ];
  if (!items.length) return <StatusPanel text="Nothing urgent right now." />;

  return (
    <div>
      <div className="attention-list action-inbox-list">
        {items.slice(0, visibleCount).map((item) => (
          <button type="button" key={item.id} onClick={item.onClick}>
            <span>{item.kicker}</span>
            <strong>{item.title}</strong>
            <em>{item.detail}</em>
          </button>
        ))}
      </div>
      {visibleCount < items.length && (
        <button className="inbox-load-more" type="button" onClick={() => setVisibleCount((value) => value + 6)}>
          Show {Math.min(6, items.length - visibleCount)} more
        </button>
      )}
    </div>
  );
}

const STORAGE_TYPES = [
  { id: 'all', label: 'All media' },
  { id: 'profile', label: 'Profiles' },
  { id: 'tryon', label: 'Try-ons' },
  { id: 'video', label: 'Videos' },
  { id: 'closet', label: 'Closet' },
  { id: 'product', label: 'Products' }
];

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMegabytes(value) {
  return `${(Number(value || 0) / (1024 * 1024)).toFixed(2)} MB`;
}

function formatActiveDuration(value) {
  const totalMinutes = Math.floor(Math.max(0, Number(value || 0)) / 60_000);
  if (totalMinutes < 1) return '<1 min';
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatSessionStatus(value = '') {
  const labels = {
    online: 'Online',
    recent: 'Recently active',
    inactive: 'Inactive',
    logged_out: 'Logged out',
    revoked: 'Revoked',
    expired: 'Expired',
    legacy_activity: 'Legacy activity',
    not_tracked: 'Not tracked'
  };
  return labels[value] || String(value || 'Not tracked').replace(/_/g, ' ');
}

function StoragePage({ refresh, onOpenUser }) {
  const [type, setType] = useState('all');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [reconciliation, setReconciliation] = useState({ data: null, loading: false, error: '', message: '' });
  const [selectedOrphans, setSelectedOrphans] = useState(() => new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const state = useAdminStorage(true, type, page, refresh);
  const needle = query.trim().toLowerCase();
  const visibleItems = needle ? state.items.filter((item) => [
    item.title,
    item.kind,
    item.owner?.name,
    item.owner?.email,
    item.path,
    item.storage
  ].some((value) => String(value || '').toLowerCase().includes(needle))) : state.items;
  const chooseType = (nextType) => {
    setType(nextType);
    setPage(1);
  };
  const reconcile = async () => {
    setReconciliation((current) => ({ ...current, loading: true, error: '', message: '' }));
    try {
      const data = await api('/auth/admin/storage/reconciliation');
      setSelectedOrphans(new Set());
      setReconciliation({ data, loading: false, error: '', message: '' });
    } catch (error) {
      setReconciliation((current) => ({ ...current, loading: false, error: error.message, message: '' }));
    }
  };
  const toggleOrphan = (key) => {
    setSelectedOrphans((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const deleteOrphans = async () => {
    setReconciliation((current) => ({ ...current, loading: true, error: '', message: '' }));
    try {
      const result = await api('/auth/admin/storage/orphans', {
        method: 'DELETE',
        body: JSON.stringify({ keys: [...selectedOrphans], confirmation: deleteConfirmation })
      });
      setDeleteConfirmation('');
      setSelectedOrphans(new Set());
      const data = await api('/auth/admin/storage/reconciliation');
      setReconciliation({ data, loading: false, error: '', message: `${result.deleted.length} orphan file${result.deleted.length === 1 ? '' : 's'} deleted.` });
    } catch (error) {
      setReconciliation((current) => ({ ...current, loading: false, error: error.message, message: '' }));
    }
  };

  return (
    <section className="storage-page">
      <section className="storage-usage-band" aria-label="Bunny media storage usage">
        <div className="storage-usage-total">
          <span>Bunny photo storage</span>
          <strong>{formatMegabytes(state.usage.bunnyBytes.all)}</strong>
          <em>{formatNumber(state.usage.bunnyCounts.all)} database-tracked Bunny files</em>
          {state.usage.unknownSize.all > 0 && <small>{formatNumber(state.usage.unknownSize.all)} legacy files have no size metadata.</small>}
        </div>
        <div className="storage-usage-breakdown">
          <div><span>Profiles</span><strong>{formatMegabytes(state.usage.bunnyBytes.profile)}</strong></div>
          <div><span>Try-ons</span><strong>{formatMegabytes(state.usage.bunnyBytes.tryon)}</strong></div>
          <div><span>Videos</span><strong>{formatMegabytes(state.usage.bunnyBytes.video)}</strong></div>
          <div><span>Closet</span><strong>{formatMegabytes(state.usage.bunnyBytes.closet)}</strong></div>
          <div><span>Products</span><strong>{formatMegabytes(state.usage.bunnyBytes.product)}</strong></div>
        </div>
      </section>
      <section className="overview-grid storage-summary" aria-label="Stored image summary">
        <StatBox label="Profile images" value={formatNumber(state.counts.profile || 0)} meta={`${formatMegabytes(state.usage.bunnyBytes.profile)} on Bunny`} />
        <StatBox label="Try-on images" value={formatNumber(state.counts.tryon || 0)} meta={`${formatMegabytes(state.usage.bunnyBytes.tryon)} on Bunny`} />
        <StatBox label="Generated videos" value={formatNumber(state.counts.video || 0)} meta={`${formatMegabytes(state.usage.bunnyBytes.video)} on Bunny`} />
        <StatBox label="Closet images" value={formatNumber(state.counts.closet || 0)} meta={`${formatMegabytes(state.usage.bunnyBytes.closet)} on Bunny`} />
        <StatBox label="Product images" value={formatNumber(state.counts.product || 0)} meta={`${formatMegabytes(state.usage.bunnyBytes.product)} on Bunny`} />
      </section>

      <section className="storage-reconciliation">
        <div className="section-head">
          <div><h2>Bunny reconciliation</h2><p>Compare the live storage zone against every database media reference.</p></div>
          <button type="button" disabled={reconciliation.loading} onClick={reconcile}>{reconciliation.loading ? 'Scanning...' : 'Scan Bunny'}</button>
        </div>
        {reconciliation.error && <StatusPanel text={reconciliation.error} />}
        {reconciliation.message && <div className="storage-success">{reconciliation.message}</div>}
        {reconciliation.data && !reconciliation.data.configured && <StatusPanel text={reconciliation.data.reason || 'Bunny storage is not configured.'} />}
        {reconciliation.data?.configured && (
          <>
            <div className="storage-reconcile-metrics">
              <div><span>Live files</span><strong>{formatNumber(reconciliation.data.scannedFiles)}</strong><small>{formatBytes(reconciliation.data.scannedBytes)}</small></div>
              <div><span>Referenced</span><strong>{formatNumber(reconciliation.data.referencedFiles)}</strong><small>Unique storage keys</small></div>
              <div><span>Orphans</span><strong>{formatNumber(reconciliation.data.orphanFiles)}</strong><small>{formatBytes(reconciliation.data.orphanBytes)}</small></div>
              <div><span>Missing</span><strong>{formatNumber(reconciliation.data.missingFiles)}</strong><small>Database references</small></div>
            </div>
            {reconciliation.data.truncated && <div className="storage-warning">The scan reached its configured display or inventory limit. Increase the reconciliation limits before deleting files.</div>}
            {reconciliation.data.orphans?.length > 0 && (
              <div className="orphan-manager">
                <div className="orphan-list">
                  {reconciliation.data.orphans.map((file) => (
                    <label key={file.key}>
                      <input type="checkbox" checked={selectedOrphans.has(file.key)} onChange={() => toggleOrphan(file.key)} />
                      <span><strong>{file.key}</strong><small>{formatBytes(file.size)} · {formatCatalogDate(file.createdAt)}</small></span>
                    </label>
                  ))}
                </div>
                <div className="orphan-delete-controls">
                  <span>{selectedOrphans.size} selected</span>
                  <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder="Type DELETE" aria-label="Deletion confirmation" />
                  <button type="button" className="danger" disabled={reconciliation.loading || selectedOrphans.size === 0 || deleteConfirmation !== 'DELETE' || reconciliation.data.truncated} onClick={deleteOrphans}>Delete verified orphans</button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="storage-browser">
        <div className="storage-toolbar">
          <div className="storage-tabs" role="tablist" aria-label="Storage image type">
            {STORAGE_TYPES.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={type === item.id} className={type === item.id ? 'active' : ''} onClick={() => chooseType(item.id)}>
                <span>{item.label}</span>
                <b>{formatNumber(state.counts[item.id] || 0)}</b>
              </button>
            ))}
          </div>
          <label className="field storage-search">
            <span>Search loaded media</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="User, media, or storage key" />
          </label>
        </div>

        <div className="storage-result-head">
          <div><strong>{formatNumber(state.total)} stored files</strong><span>{formatMegabytes(state.usage.bunnyBytes[type] || 0)} on Bunny</span></div>
          <span>Page {page} of {state.pages}</span>
        </div>
        {state.loading && <MediaGridSkeleton />}
        {state.error && <StatusPanel text={state.error} />}
        {!state.loading && !state.error && visibleItems.length === 0 && <StatusPanel text={needle ? 'No loaded media match this search.' : 'No stored media found in this group.'} />}
        {!state.loading && !state.error && visibleItems.length > 0 && <StoredMediaGrid items={visibleItems} onOpenUser={onOpenUser} />}
        <StoragePagination page={page} pages={state.pages} loading={state.loading} onPage={setPage} />
      </section>
    </section>
  );
}

function StoredMediaGrid({ items, onOpenUser }) {
  return (
    <div className="stored-media-grid">
      {items.map((item) => <StoredMediaCard key={item.id} item={item} onOpenUser={onOpenUser} />)}
    </div>
  );
}

function StoredMediaCard({ item, onOpenUser }) {
  const [failed, setFailed] = useState(false);
  return (
    <article className="stored-media-card">
      <a className={`stored-media-preview ${failed ? 'failed' : ''}`} href={mediaUrl(item.url)} target="_blank" rel="noreferrer" aria-label={`Open ${item.title}`}>
        {!failed && item.mediaType === 'video' ? <video src={mediaUrl(item.url)} preload="metadata" muted playsInline onError={() => setFailed(true)} /> : null}
        {!failed && item.mediaType !== 'video' ? <img src={mediaUrl(item.url)} alt={item.title} loading="lazy" onError={() => setFailed(true)} /> : null}
        {failed && <span>Preview unavailable</span>}
      </a>
      <div className="stored-media-copy">
        <span>{item.kind}</span>
        <strong>{item.title}</strong>
        {item.owner
          ? onOpenUser
            ? <button type="button" onClick={() => onOpenUser(item.owner)}>{item.owner.name || item.owner.email}</button>
            : <em>{item.owner.name || item.owner.email}</em>
          : <em>{item.related?.label || 'Lookmefy catalog'}</em>}
      </div>
      <div className="stored-media-meta">
        <span>{item.storage || 'stored'}</span>
        <span>{formatBytes(item.size)}</span>
        <span>{formatCatalogDate(item.createdAt)}</span>
      </div>
      {item.path && <code title={item.path}>{item.path}</code>}
    </article>
  );
}

function MediaGridSkeleton() {
  return <div className="media-grid-skeleton" aria-label="Loading stored images">{Array.from({ length: 8 }).map((_, index) => <span key={index} />)}</div>;
}

function StoragePagination({ page, pages, loading, onPage }) {
  if (pages <= 1) return null;
  return (
    <nav className="storage-pagination" aria-label="Storage pages">
      <button type="button" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>{page} / {pages}</span>
      <button type="button" disabled={loading || page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}

function PaginationControls({ page, pages, total, loading, label, onPage }) {
  if (pages <= 1) return total ? <div className="pagination-summary">{formatNumber(total)} {label}</div> : null;
  return (
    <nav className="storage-pagination" aria-label={`${label} pages`}>
      <button type="button" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>Page {page} of {pages} · {formatNumber(total)} {label}</span>
      <button type="button" disabled={loading || page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}

const USER_DETAIL_TABS = [
  ['overview', 'Overview'],
  ['sessions', 'Sessions'],
  ['activity', 'Activity'],
  ['preferences', 'Preferences'],
  ['media', 'Media']
];

function UserMediaDrawer({ user, onClose }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [activityPage, setActivityPage] = useState(1);
  const [mediaPage, setMediaPage] = useState(1);
  const [insights, setInsights] = useState({ data: null, loading: true, error: '' });
  const [media, setMedia] = useState({ items: [], counts: {}, usage: EMPTY_STORAGE_USAGE, total: 0, pages: 1, loading: false, loaded: false, error: '' });

  useEffect(() => {
    let alive = true;
    setInsights((current) => ({ ...current, loading: true, error: '' }));
    api(`/auth/admin/users/${user.id}/insights?activityPage=${activityPage}&activityLimit=24`)
      .then((data) => {
        if (alive) setInsights({ data, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setInsights((current) => ({ ...current, loading: false, error: err.message }));
      });
    return () => {
      alive = false;
    };
  }, [activityPage, user.id]);

  useEffect(() => {
    if (activeTab !== 'media') return undefined;
    let alive = true;
    setMedia((current) => ({ ...current, loading: true, error: '' }));
    api(`/auth/admin/users/${user.id}/media?page=${mediaPage}&limit=24`)
      .then((data) => {
        if (alive) setMedia({ items: data.items || [], counts: data.counts || {}, usage: data.usage || EMPTY_STORAGE_USAGE, total: data.total || 0, pages: data.pages || 1, loading: false, loaded: true, error: '' });
      })
      .catch((err) => {
        if (alive) setMedia((current) => ({ ...current, items: [], loading: false, loaded: true, error: err.message }));
      });
    return () => {
      alive = false;
    };
  }, [activeTab, mediaPage, user.id]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const data = insights.data;
  const summary = data?.summary || {};
  const displayUser = data?.user || user;
  const activityPagination = data?.activityPagination || { page: 1, pages: 1 };

  return (
    <div className="media-drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="user-media-drawer" role="dialog" aria-modal="true" aria-labelledby="user-media-title">
        <header className="media-drawer-head">
          <div>
            <span>User details</span>
            <h2 id="user-media-title">{displayUser.name || displayUser.email}</h2>
            <p>{[displayUser.email, displayUser.phone].filter(Boolean).join(' - ')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close user details">x</button>
        </header>
        <nav className="user-detail-tabs" aria-label="User detail sections">
          {USER_DETAIL_TABS.map(([id, label]) => (
            <button type="button" className={activeTab === id ? 'active' : ''} aria-current={activeTab === id ? 'page' : undefined} onClick={() => setActiveTab(id)} key={id}>{label}</button>
          ))}
        </nav>
        <div className="media-drawer-body user-detail-body">
          {activeTab !== 'media' && insights.loading && <OverviewSkeleton />}
          {activeTab !== 'media' && insights.error && <StatusPanel text={insights.error} />}

          {activeTab === 'overview' && data && !insights.loading && (
            <div className="user-insights-overview">
              <section className="user-insight-metrics" aria-label="User activity summary">
                <div><span>Last login</span><strong>{summary.lastLoginAt ? formatSignalDate(summary.lastLoginAt) : 'Not tracked'}</strong></div>
                <div><span>Last active</span><strong>{summary.lastActiveAt ? formatSignalDate(summary.lastActiveAt) : 'No activity'}</strong></div>
                <div><span>Active time</span><strong>{formatActiveDuration(summary.totalActiveMs)}</strong></div>
                <div><span>Session state</span><strong className={`session-state ${summary.sessionStatus || 'not_tracked'}`}>{formatSessionStatus(summary.sessionStatus)}</strong></div>
              </section>
              <section className="user-overview-band">
                <div><span>Sessions</span><strong>{formatNumber(summary.sessionCount || 0)}</strong></div>
                <div><span>Recorded actions</span><strong>{formatNumber(summary.activityCount || 0)}</strong></div>
                <div><span>Tracked page views</span><strong>{formatNumber(summary.pageViews || 0)}</strong></div>
                <div><span>Explicit preference</span><strong>{data.preferences?.explicitGender || 'other'}</strong></div>
              </section>
              <section className="user-detail-section">
                <div className="user-detail-section-head"><h3>Most interacted products</h3><span>Views, clicks, saves, try-ons, and shop actions</span></div>
                {data.topProducts?.length ? <div className="user-top-products">{data.topProducts.map((product) => (
                  <article key={product.id}>
                    <ProductThumbnail product={{ ...product, imageUrl: product.imageUrl }} decorative />
                    <div><strong>{product.name}</strong><span>{product.brand || product.category}</span><em>{formatNumber(product.interactions)} interactions - last {formatSignalDate(product.lastAt)}</em></div>
                  </article>
                ))}</div> : <StatusPanel text="No product interactions recorded yet." />}
              </section>
            </div>
          )}

          {activeTab === 'sessions' && data && !insights.loading && (
            <section className="user-detail-section">
              <div className="user-detail-section-head"><h3>Login sessions</h3><span>{formatNumber(summary.sessionCount || 0)} retained sessions</span></div>
              {data.sessions?.length ? <div className="user-session-list">{data.sessions.map((session) => (
                <article key={session.id}>
                  <div><strong>{formatSignalDate(session.loginAt)}</strong><span>{session.authMethod} login</span></div>
                  <div><strong>{formatActiveDuration(session.activeDurationMs)}</strong><span>active time</span></div>
                  <div><strong>{session.logoutAt ? formatSignalDate(session.logoutAt) : formatSignalDate(session.lastSeenAt)}</strong><span>{session.logoutAt ? 'logout' : 'last active'}</span></div>
                  <div><b className={`session-state ${session.status}`}>{formatSessionStatus(session.status)}</b><span>{session.browser} - {session.deviceType}</span></div>
                  <code title={session.lastPath || '/'}>{session.lastPath || '/'}</code>
                </article>
              ))}</div> : <StatusPanel text="Session tracking starts after this feature is deployed." />}
            </section>
          )}

          {activeTab === 'activity' && data && !insights.loading && (
            <section className="user-detail-section">
              <div className="user-detail-section-head"><h3>Activity timeline</h3><span>{formatNumber(activityPagination.total || 0)} recorded actions</span></div>
              {data.activity?.length ? <div className="user-activity-list">{data.activity.map((item) => (
                <article key={item.id}>
                  <span className="activity-mark" aria-hidden="true" />
                  <div>
                    <strong>{item.product?.name || item.query || formatEventType(item.type)}</strong>
                    <span>{formatEventType(item.type)}{item.product?.brand ? ` - ${item.product.brand}` : ''}</span>
                    <em>{[item.source, item.path].filter(Boolean).join(' - ') || 'Lookmefy app'}</em>
                  </div>
                  <time dateTime={item.createdAt}>{formatSignalDate(item.createdAt)}</time>
                </article>
              ))}</div> : <StatusPanel text="No user activity has been recorded." />}
            </section>
          )}

          {activeTab === 'preferences' && data && !insights.loading && (
            <div className="user-preferences-view">
              <section className="user-preference-summary">
                <div><span>Explicit audience</span><strong>{data.preferences?.explicitGender || 'other'}</strong></div>
                <div><span>Learned price</span><strong>{data.preferences?.averagePreferredPrice ? formatMoney(data.preferences.averagePreferredPrice, 'INR') : 'Not learned'}</strong></div>
                <div><span>Last learned</span><strong>{data.preferences?.updatedAt ? formatSignalDate(data.preferences.updatedAt) : 'No profile yet'}</strong></div>
              </section>
              {['categories', 'brands', 'tags', 'genders'].map((bucket) => (
                <section className="preference-group" key={bucket}>
                  <div className="user-detail-section-head"><h3>Top {bucket}</h3><span>Weighted from meaningful actions</span></div>
                  {data.preferences?.[bucket]?.length ? <div className="preference-bars">{data.preferences[bucket].map((item) => (
                    <div key={item.key}><span>{item.label}</span><strong>{formatWeight(item.weight)}</strong><i style={{ width: `${Math.max(5, Math.min(100, item.weight / data.preferences[bucket][0].weight * 100))}%` }} /></div>
                  ))}</div> : <StatusPanel text={`No learned ${bucket} yet.`} />}
                </section>
              ))}
            </div>
          )}

          {activeTab === 'media' && (
            <div className="user-media-view">
              <section className="user-media-summary" aria-label="User image summary">
                <div><span>Profiles</span><strong>{formatNumber(media.counts.profile || 0)}</strong></div>
                <div><span>Try-ons</span><strong>{formatNumber(media.counts.tryon || 0)}</strong></div>
                <div><span>Videos</span><strong>{formatNumber(media.counts.video || 0)}</strong></div>
                <div><span>Closet</span><strong>{formatNumber(media.counts.closet || 0)}</strong></div>
                <div><span>Bunny storage</span><strong>{formatMegabytes(media.usage.bunnyBytes.all)}</strong></div>
              </section>
              {media.loading && <MediaGridSkeleton />}
              {media.error && <StatusPanel text={media.error} />}
              {!media.loading && media.loaded && !media.error && media.items.length === 0 && <StatusPanel text="No stored media were found for this user." />}
              {!media.loading && !media.error && media.items.length > 0 && <StoredMediaGrid items={media.items} />}
            </div>
          )}
        </div>
        {activeTab === 'activity' && <StoragePagination page={activityPage} pages={activityPagination.pages || 1} loading={insights.loading} onPage={setActivityPage} />}
        {activeTab === 'media' && <StoragePagination page={mediaPage} pages={media.pages} loading={media.loading} onPage={setMediaPage} />}
      </aside>
    </div>
  );
}

function UsersTokenPage({ state, search, status, minTokens, maxTokens, page, sort, operationsState, tokenDrafts, onSearch, onStatus, onMinTokens, onMaxTokens, onPage, onSort, onDraftChange, onUpdateTokens, onUpdateStatus, onRemoveUser, onOpenUser, onRefresh }) {
  const lowTokenUsers = state.users.filter((user) => user.accountStatus === 'active' && Number(user.tokens || 0) <= 5).slice(0, 8);

  return (
    <section className="users-page">
      <section className="overview-grid users-summary-grid" aria-label="User summary">
        <StatBox label="Total users" value={formatNumber(state.totals?.users || 0)} meta={`${formatNumber(state.totals?.loaded || 0)} loaded`} />
        <StatBox label="Total tokens" value={formatNumber(state.totals?.tokens || 0)} meta="tokens users can spend" />
        <StatBox label="Active users" value={formatNumber(state.totals?.active || 0)} meta={`${formatNumber(state.totals?.banned || 0)} banned`} />
        <StatBox label="Removed" value={formatNumber(state.totals?.deleted || 0)} meta="personal data removed" />
      </section>

      <section className="users-page-top-grid">
        <LowTokenUsersPanel users={lowTokenUsers} />
        <RecentOrdersPanel operationsState={operationsState} />
      </section>

      <section className="admin-card users-crm-card">
        <div className="section-head users-head">
          <div>
            <h2>User Management</h2>
            <p>Manage access, remove accounts, and maintain token balances.</p>
          </div>
          <button type="button" onClick={onRefresh}>Refresh Users</button>
        </div>
        <div className="users-toolbar">
          <label className="field">
            <span>Search users</span>
            <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Name, email, mobile, ID, or account field" />
          </label>
          <label className="field">
            <span>Account status</span>
            <select value={status} onChange={(event) => onStatus(event.target.value)}>
              <option value="">All accounts</option>
              <option value="active">Active</option>
              <option value="banned">Banned</option>
              <option value="deleted">Removed</option>
            </select>
          </label>
          <div className="field token-filter-field">
            <span>Token balance</span>
            <div className="token-range-filter">
              <input type="number" min="0" step="1" inputMode="numeric" value={minTokens} onChange={(event) => onMinTokens(event.target.value)} placeholder="Min" aria-label="Minimum token balance" />
              <span>to</span>
              <input type="number" min="0" step="1" inputMode="numeric" value={maxTokens} onChange={(event) => onMaxTokens(event.target.value)} placeholder="Max" aria-label="Maximum token balance" />
            </div>
          </div>
          <label className="field">
            <span>Sort users</span>
            <select value={sort} onChange={(event) => onSort(event.target.value)}>
              <option value="newest">Newest joined</option>
              <option value="oldest">Oldest joined</option>
              <option value="name">Name A to Z</option>
              <option value="tokens_desc">Tokens high to low</option>
              <option value="tokens_asc">Tokens low to high</option>
            </select>
          </label>
        </div>
        {state.loading && <UserRowsSkeleton />}
        {state.error && <StatusPanel text={state.error} />}
        {!state.loading && !state.error && state.users.length === 0 && <StatusPanel text="No users found." />}
        {!state.loading && !state.error && state.users.length > 0 && (
          <>
            <div className="users-table-head" aria-hidden="true">
              <span>User</span>
              <span>Plan</span>
              <span>Tokens</span>
              <span>Last Order</span>
              <span>Actions</span>
            </div>
            <div className="users-list">
              {state.users.map((user) => (
                <UserTokenRow
                  key={user.id}
                  user={user}
                  draft={tokenDrafts[user.id] || ''}
                  onDraftChange={(value) => onDraftChange(user.id, value)}
                  onSet={() => onUpdateTokens(user.id, 'set')}
                  onAdd={() => onUpdateTokens(user.id, 'add')}
                  onStatus={(nextStatus) => onUpdateStatus(user, nextStatus)}
                  onRemove={() => onRemoveUser(user)}
                  onOpen={() => onOpenUser(user)}
                />
              ))}
            </div>
            <PaginationControls page={state.pagination?.page || page} pages={state.pagination?.pages || 1} total={state.pagination?.total || 0} loading={state.loading} label="users" onPage={onPage} />
          </>
        )}
      </section>
    </section>
  );
}

function LowTokenUsersPanel({ users }) {
  return (
    <section className="admin-card crm-card low-token-card">
      <div className="section-head">
        <div>
          <h2>Low Token Users</h2>
          <p>Users with 5 or fewer tokens.</p>
        </div>
      </div>
      <div className="compact-user-list">
        {users.length === 0 ? <StatusPanel text="No low-token users in the loaded list." /> : users.map((user) => (
          <div key={user.id}>
            <strong>{user.name || user.email}</strong>
            <span>{user.email}</span>
            <b>{formatNumber(user.tokens || 0)} tokens</b>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecentOrdersPanel({ operationsState, limit = 6 }) {
  const totals = operationsState.orderTotals || {};
  const completed = totals.completed?.count || 0;
  const pending = totals.pending?.count || 0;
  const failed = totals.failed?.count || 0;

  return (
    <section className="admin-card crm-card orders-card">
      <div className="section-head">
        <div>
          <h2>Recent Orders</h2>
          <p>Latest token payments and payment status.</p>
        </div>
      </div>
      <div className="order-summary-strip">
        <div><span>Completed</span><strong>{formatNumber(completed)}</strong></div>
        <div><span>Pending</span><strong>{formatNumber(pending)}</strong></div>
        <div><span>Failed</span><strong>{formatNumber(failed)}</strong></div>
      </div>
      {operationsState.loading && <StatusPanel text="Loading orders..." />}
      {operationsState.error && <StatusPanel text={operationsState.error} />}
      {!operationsState.loading && !operationsState.error && operationsState.orders.length === 0 && <StatusPanel text="No token orders yet." />}
      {!operationsState.loading && !operationsState.error && operationsState.orders.length > 0 && (
        <div className="orders-list">
          {operationsState.orders.slice(0, limit).map((order) => (
            <article key={order.id} className={`order-row ${order.status}`}>
              <div>
                <strong>{order.user?.name || order.user?.email || 'Unknown user'}</strong>
                <span>{order.planName} - {formatNumber(order.tokens || 0)} tokens</span>
              </div>
              <div>
                <b>{formatMoney(order.amount || 0, order.currency)}</b>
                <em>{order.status}</em>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function OrdersPage({ refresh }) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [state, setState] = useState({ orders: [], orderTotals: {}, pagination: { page: 1, pages: 1, total: 0 }, loading: true, error: '' });
  const [productOrders, setProductOrders] = useState({ orders: [], pagination: { total: 0 }, loading: true, error: '' });

  useEffect(() => {
    let alive = true;
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), limit: '30' });
      if (query.trim()) params.set('q', query.trim());
      if (status) params.set('status', status);
      setState((current) => ({ ...current, loading: true, error: '' }));
      api(`/auth/admin/orders?${params.toString()}`)
        .then((data) => {
          if (alive) setState({ orders: data.orders || [], orderTotals: data.orderTotals || {}, pagination: data.pagination || { page: 1, pages: 1, total: 0 }, loading: false, error: '' });
        })
        .catch((error) => {
          if (alive) setState((current) => ({ ...current, loading: false, error: error.message }));
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [page, query, refresh, status]);

  useEffect(() => {
    let alive = true;
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: '50' });
      if (query.trim()) params.set('q', query.trim());
      setProductOrders((current) => ({ ...current, loading: true, error: '' }));
      api(`/orders/admin/list?${params.toString()}`)
        .then((data) => {
          if (alive) setProductOrders({ orders: data.orders || [], pagination: data.pagination || { total: 0 }, loading: false, error: '' });
        })
        .catch((error) => {
          if (alive) setProductOrders((current) => ({ ...current, loading: false, error: error.message }));
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [query, refresh]);

  const updateProductOrderStatus = async (orderId, fulfillmentStatus) => {
    try {
      const data = await api(`/orders/admin/${encodeURIComponent(orderId)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ fulfillmentStatus })
      });
      setProductOrders((current) => ({
        ...current,
        orders: current.orders.map((order) => order.id === orderId ? data.order : order)
      }));
    } catch (error) {
      setProductOrders((current) => ({ ...current, error: error.message || 'Could not update product order.' }));
    }
  };

  return (
    <div className="management-page">
      <section className="admin-card orders-page-panel">
        <div className="section-head"><div><h2>Token orders</h2><p>Search and review the complete payment history.</p></div></div>
        <div className="orders-toolbar">
          <label className="field"><span>Search orders</span><input value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} placeholder="User, email, plan, or order ID" /></label>
          <label className="field"><span>Status</span><select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}><option value="">All statuses</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="failed">Failed</option></select></label>
        </div>
      </section>
      <RecentOrdersPanel operationsState={state} limit={100} />
      <PaginationControls page={state.pagination.page || page} pages={state.pagination.pages || 1} total={state.pagination.total || 0} loading={state.loading} label="orders" onPage={setPage} />
      <ProductOrdersPanel state={productOrders} onStatus={updateProductOrderStatus} />
    </div>
  );
}

function ProductOrdersPanel({ state, onStatus }) {
  const statuses = ['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];
  return (
    <section className="admin-card orders-page-panel product-orders-panel">
      <div className="section-head">
        <div>
          <h2>Product orders</h2>
          <p>Demo ecommerce orders created from the storefront checkout.</p>
        </div>
        <span className="section-count">{formatNumber(state.pagination?.total || state.orders.length)} total</span>
      </div>
      {state.loading && <StatusPanel text="Loading product orders..." />}
      {state.error && <StatusPanel text={state.error} />}
      {!state.loading && !state.error && state.orders.length === 0 && <StatusPanel text="No product orders yet." />}
      {!state.loading && state.orders.length > 0 && (
        <div className="product-orders-list">
          {state.orders.map((order) => (
            <article className="product-order-row" key={order.id}>
              <div className="product-order-main">
                <strong>{order.contact?.fullName || 'Customer'}</strong>
                <span>{order.items?.map((item) => `${item.name} x${item.quantity}`).join(', ')}</span>
                <em>{order.address?.city || 'City pending'}, {order.address?.state || 'State pending'} - {order.address?.pincode || 'PIN'}</em>
              </div>
              <div className="product-order-meta">
                <b>{formatMoney(order.total, order.currency)}</b>
                <span className={`account-status ${order.paymentStatus}`}>{order.paymentStatus}</span>
                <span>{order.paymentMode === 'demo' ? 'demo checkout' : order.providerState || 'payment'}</span>
                <select value={order.fulfillmentStatus || 'new'} onChange={(event) => onStatus(order.id, event.target.value)} aria-label={`Fulfillment status for ${order.id}`}>
                  {statuses.map((status) => <option value={status} key={status}>{status}</option>)}
                </select>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function UserTokenRow({ user, draft, onDraftChange, onSet, onAdd, onStatus, onRemove, onOpen }) {
  const planStatus = user.subscription?.status || 'none';
  const planName = user.subscription?.planId || (planStatus === 'none' ? 'Free' : planStatus);
  const initials = String(user.name || user.email || 'U').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const accountStatus = user.accountStatus || 'active';
  const isDeleted = accountStatus === 'deleted';

  return (
    <article className="user-row">
      <button className="user-identity user-media-trigger" type="button" onClick={onOpen} aria-label={`Open details for ${user.name || user.email}`}>
        <span className="user-avatar" style={userAvatarStyle(user.id || user.email)}>{initials || 'U'}</span>
        <div>
          <strong>{user.name || 'Unnamed user'}</strong>
          <span>{user.email}</span>
          {user.phone && <span>{user.phone}</span>}
          {user.username && <em>@{user.username}</em>}
          <b className={`account-status ${accountStatus}`}>{accountStatus}</b>
        </div>
      </button>
      <div className="user-plan-cell">
        <strong>{planName}</strong>
        <span>{planStatus}</span>
        <em className={`user-presence ${user.sessionStatus || 'not_tracked'}`}>{formatSessionStatus(user.sessionStatus)}</em>
        <small>{user.lastActiveAt ? formatSignalDate(user.lastActiveAt) : `${user.bodyPhotoStatus || 'uploaded'} profile`}</small>
      </div>
      <div className="user-token-cell">
        <strong>{formatNumber(user.tokens || 0)}</strong>
        <span>tokens</span>
      </div>
      <div className="user-order-cell">
        {user.lastOrder ? (
          <>
            <strong>{user.lastOrder.planName}</strong>
            <span>{formatNumber(user.lastOrder.tokens || 0)} tokens - {user.lastOrder.status}</span>
            <em>{formatCatalogDate(user.lastOrder.createdAt)}</em>
          </>
        ) : (
          <>
            <strong>No order yet</strong>
            <span>Joined {formatCatalogDate(user.joinedAt)}</span>
          </>
        )}
      </div>
      <div className="user-admin-actions" onClick={(event) => event.stopPropagation()}>
        <div className="user-token-actions">
          <input type="number" step="1" min="0" value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="Tokens" disabled={isDeleted} />
          <button type="button" onClick={onAdd} disabled={isDeleted}>Add</button>
          <button type="button" onClick={onSet} disabled={isDeleted}>Set</button>
        </div>
        {!isDeleted && (
          <div className="user-account-actions">
            {accountStatus === 'banned'
              ? <button type="button" onClick={() => onStatus('active')}>Unban</button>
              : <button className="ban-action" type="button" onClick={() => onStatus('banned')}>Ban</button>}
            <button className="remove-action" type="button" onClick={onRemove}>Remove</button>
          </div>
        )}
      </div>
    </article>
  );
}

function formatAuditAction(value = '') {
  if (value === 'user_anonymized') return 'User Removed';
  return String(value || 'admin action')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function AuditLogPanel({ refresh, onRefresh }) {
  const [query, setQuery] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [range, setRange] = useState('all');
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ auditLogs: [], facets: { actions: [], actors: [] }, pagination: { page: 1, pages: 1, total: 0 }, loading: true, error: '' });
  const actions = state.facets.actions || [];
  const actors = state.facets.actors || [];

  useEffect(() => {
    let alive = true;
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (query.trim()) params.set('q', query.trim());
      if (action) params.set('action', action);
      if (actor) params.set('actor', actor);
      if (range !== 'all') params.set('from', new Date(Date.now() - Number(range) * 24 * 60 * 60 * 1000).toISOString());
      setState((current) => ({ ...current, loading: true, error: '' }));
      api(`/auth/admin/audit-log?${params.toString()}`)
        .then((data) => {
          if (alive) setState({ auditLogs: data.auditLogs || [], facets: data.facets || { actions: [], actors: [] }, pagination: data.pagination || { page: 1, pages: 1, total: 0 }, loading: false, error: '' });
        })
        .catch((error) => {
          if (alive) setState((current) => ({ ...current, loading: false, error: error.message }));
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [action, actor, page, query, range, refresh]);

  return (
    <section className="admin-card settings-panel audit-panel">
      <div className="section-head">
        <div>
          <h2>Audit Log</h2>
          <p>Recent admin changes for products, tokens, and categories.</p>
        </div>
        <button type="button" onClick={onRefresh}>Refresh Audit Log</button>
      </div>
      <div className="audit-toolbar">
        <label className="field"><span>Search log</span><input value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} placeholder="Action, record, or admin" /></label>
        <label className="field"><span>Action</span><select value={action} onChange={(event) => { setPage(1); setAction(event.target.value); }}><option value="">All actions</option>{actions.map((item) => <option key={item} value={item}>{formatAuditAction(item)}</option>)}</select></label>
        <label className="field"><span>Admin</span><select value={actor} onChange={(event) => { setPage(1); setActor(event.target.value); }}><option value="">All admins</option>{actors.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="field"><span>Date</span><select value={range} onChange={(event) => { setPage(1); setRange(event.target.value); }}><option value="all">All dates</option><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label>
      </div>
      {state.loading && <StatusPanel text="Loading audit log..." />}
      {state.error && <StatusPanel text={state.error} />}
      {!state.loading && !state.error && state.auditLogs.length === 0 && <StatusPanel text="No admin actions match these filters." />}
      {!state.loading && !state.error && state.auditLogs.length > 0 && (
        <div className="audit-list">
          {state.auditLogs.map((log) => (
            <article key={log.id}>
              <div>
                <strong>{formatAuditAction(log.action)}</strong>
                <span>{log.label || log.entityType}</span>
              </div>
              <div>
                <b>{log.actorEmail || 'admin'}</b>
                <em>{formatSignalDate(log.createdAt)}</em>
              </div>
            </article>
          ))}
        </div>
      )}
      <PaginationControls page={state.pagination.page || page} pages={state.pagination.pages || 1} total={state.pagination.total || 0} loading={state.loading} label="audit entries" onPage={setPage} />
    </section>
  );
}

function CatalogTableHeader() {
  return (
    <div className="catalog-table-head" aria-hidden="true">
      <span>Product</span>
      <span>Details</span>
      <span>Merchandising</span>
      <span>Links</span>
      <span>Actions</span>
    </div>
  );
}

function stopProductRowOpen(event) {
  event.stopPropagation();
}

function AdminLogin({ onLogin, theme, onThemeToggle }) {
  const [mode, setMode] = useState('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (mode === 'request' && password !== confirmPassword) {
      setMessage('Passwords do not match.');
      return;
    }
    setLoading(true);
    setMessage(mode === 'request' ? 'Sending access request...' : 'Checking access...');
    try {
      const data = await api(mode === 'request' ? '/auth/admin-request-access' : '/auth/admin-login', {
        method: 'POST',
        body: JSON.stringify(mode === 'request' ? { name, email, password } : { email, password })
      });
      if (mode === 'request') {
        setMessage(data.message);
        setPassword('');
        setConfirmPassword('');
      } else {
        onLogin(data);
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-art">
          <div className="brand-mark">F</div>
          <span>Lookmefy Admin</span>
          <h1>Operate Lookmefy with accountable access.</h1>
          <p>Use your assigned admin identity to open the operational sections available to you.</p>
          <div className="login-metrics" aria-label="Admin capabilities">
            <div><strong>Catalog</strong><span>Upload and edit products</span></div>
            <div><strong>Activity</strong><span>See what users do</span></div>
            <div><strong>Checks</strong><span>Find missing product details</span></div>
          </div>
        </div>
        <form className="login-card" onSubmit={submit}>
          <button
            className="theme-toggle login-theme-toggle"
            type="button"
            onClick={onThemeToggle}
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            <span aria-hidden="true" />
          </button>
          <div className="login-mode-switch" role="tablist" aria-label="Admin authentication">
            <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'active' : ''} onClick={() => { setMode('signin'); setShowPassword(false); setShowConfirmPassword(false); setMessage(''); }}>Sign in</button>
            <button type="button" role="tab" aria-selected={mode === 'request'} className={mode === 'request' ? 'active' : ''} onClick={() => { setMode('request'); setShowPassword(false); setShowConfirmPassword(false); setMessage(''); }}>Request access</button>
          </div>
          <div>
            <p className="kicker">Secure login</p>
            <h2>{mode === 'request' ? 'Request access' : 'Sign in'}</h2>
            <p>{mode === 'request' ? 'Create your password now. Your account will have no permissions until a Master approves it.' : 'Use your admin email and password.'}</p>
          </div>
          {mode === 'request' && <label className="field"><span>Full name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" autoComplete="name" required /></label>}
          <label className="field">
            <span>Admin email</span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@lookmefy.com" autoComplete="email" required />
          </label>
          <label className="field">
            <span>Password</span>
            <div className="password-input">
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'request' ? 'Create your password' : 'Enter your password'} autoComplete={mode === 'request' ? 'new-password' : 'current-password'} required />
              <button type="button" className="password-visibility" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} title={showPassword ? 'Hide password' : 'Show password'}>
                <span className="password-eye" aria-hidden="true" />
              </button>
            </div>
          </label>
          {mode === 'request' && <label className="field"><span>Confirm password</span><div className="password-input"><input type={showConfirmPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat your password" autoComplete="new-password" required /><button type="button" className="password-visibility" onClick={() => setShowConfirmPassword((value) => !value)} aria-label={showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'} aria-pressed={showConfirmPassword} title={showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'}><span className="password-eye" aria-hidden="true" /></button></div></label>}
          <button className="submit" type="submit" disabled={loading}>{loading ? (mode === 'request' ? 'Requesting...' : 'Signing in...') : (mode === 'request' ? 'Request access' : 'Enter Admin')}</button>
          {message && <p className="form-message">{message}</p>}
        </form>
      </section>
    </main>
  );
}

function DraftFetchStatus({ status }) {
  const tone = status?.tone || 'idle';
  const isLoading = tone === 'loading';
  const warnings = Array.isArray(status?.warnings) ? status.warnings : [];

  return (
    <div className={`draft-fetch-status ${tone}`} role={tone === 'error' ? 'alert' : 'status'} aria-live="polite">
      <span className="draft-status-icon" aria-hidden="true">
        {isLoading ? <span className="button-spinner" /> : tone === 'success' ? 'OK' : tone === 'error' ? '!' : 'i'}
      </span>
      <div>
        <strong>{status?.title || 'Ready to fetch'}</strong>
        <span>{status?.detail || 'Paste a product link to prefill the draft.'}</span>
        {isLoading && (
          <div className="fetch-status-steps" aria-hidden="true">
            <em />
            <em />
            <em />
          </div>
        )}
        {warnings.length > 0 && (
          <ul className="draft-warning-list">
            {warnings.slice(0, 5).map((warning, index) => (
              <li key={`${warning.field || 'draft'}-${index}`} className={warning.level === 'info' ? 'info' : ''}>
                <strong>{warning.title || 'Review field'}</strong>
                <span>{warning.detail || 'Check this field before publishing.'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SmartImportResult({ batch, onReview }) {
  if (batch.error) {
    return <div className="smart-import-result error" role="alert"><strong>Smart fetch failed</strong><span>{batch.error}</span></div>;
  }
  const products = Array.isArray(batch.products) ? batch.products : [];
  const issues = Array.isArray(batch.issues) ? batch.issues : [];
  return (
    <div className={`smart-import-result ${batch.created ? 'success' : 'warning'}`} role="status" aria-live="polite">
      <div className="smart-import-result-head">
        <div><strong>{batch.created ? `${batch.created} drafts created` : 'No new drafts created'}</strong><span>{batch.command}</span></div>
        {batch.created > 0 && <button type="button" onClick={onReview}>Review drafts</button>}
      </div>
      <div className="smart-import-counts" aria-label="Smart fetch results">
        <span><b>{batch.requested || 0}</b>Requested</span>
        <span><b>{batch.created || 0}</b>Created</span>
        <span><b>{batch.duplicates || 0}</b>Duplicates</span>
        <span><b>{(batch.rejected || 0) + (batch.failed || 0)}</b>Skipped</span>
      </div>
      {products.length > 0 && <div className="smart-import-products">{products.slice(0, 6).map((product) => <span key={product.id}>{product.name}</span>)}</div>}
      {issues.length > 0 && (
        <details className="smart-import-issues">
          <summary>{issues.length} import note{issues.length === 1 ? '' : 's'}</summary>
          <ul>{issues.slice(0, 8).map((issue, index) => <li key={`${issue.sourceUrl || issue.type}-${index}`}><b>{issue.type || 'skipped'}</b><span>{issue.reason}</span></li>)}</ul>
        </details>
      )}
    </div>
  );
}

function CatalogFilters({ filters, facets, onChange, onClear }) {
  const [expanded, setExpanded] = useState(false);
  const categories = facets?.categories || [];
  const brands = facets?.brands || [];
  const activeCount = ['q', 'category', 'brand', 'gender', 'availability', 'status'].filter((key) => Boolean(filters[key])).length;

  return (
    <section className="catalog-filters" aria-label="Catalog filters">
      <button className="catalog-filter-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span>Filters</span>{activeCount > 0 && <b>{activeCount}</b>}
      </button>
      <div className={`catalog-filter-fields ${expanded ? 'open' : ''}`}>
        <label className="field search-field">
        <span>Search</span>
        <input value={filters.q} onChange={(event) => onChange('q', event.target.value)} placeholder="Search name, tag, brand..." />
        </label>
        <label className="field">
        <span>Category</span>
        <select value={filters.category} onChange={(event) => onChange('category', event.target.value)}>
          <option value="">All categories</option>
          {categories.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
        </label>
        <label className="field">
        <span>Brand</span>
        <select value={filters.brand} onChange={(event) => onChange('brand', event.target.value)}>
          <option value="">All brands</option>
          {brands.map((brand) => <option key={brand} value={brand}>{brand}</option>)}
        </select>
        </label>
        <label className="field">
        <span>Gender</span>
        <select value={filters.gender} onChange={(event) => onChange('gender', event.target.value)}>
          <option value="">All genders</option>
          <option value="men">Men</option>
          <option value="women">Women</option>
          <option value="unisex">Unisex</option>
        </select>
        </label>
        <label className="field">
        <span>Availability</span>
        <select value={filters.availability} onChange={(event) => onChange('availability', event.target.value)}>
          <option value="">All availability</option>
          <option value="available">Available</option>
          <option value="out_of_stock">Out of stock</option>
          <option value="unavailable">Unavailable</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
        </label>
        <label className="field">
        <span>Merchandising</span>
        <select value={filters.status} onChange={(event) => onChange('status', event.target.value)}>
          <option value="">All products</option>
          <option value="featured">Featured</option>
          <option value="newArrival">New arrivals</option>
        </select>
        </label>
        <label className="field">
        <span>Sort</span>
        <select value={filters.sort} onChange={(event) => onChange('sort', event.target.value)}>
          <option value="newest">Newest</option>
          <option value="featured">Featured first</option>
          <option value="price-asc">Price low to high</option>
          <option value="price-desc">Price high to low</option>
        </select>
        </label>
        <button type="button" onClick={onClear}>Reset</button>
      </div>
    </section>
  );
}

function QaSummary({ items, onOpen }) {
  const visible = items.slice(0, 5);
  return (
    <section className={`qa-summary ${items.length ? 'needs-work' : ''}`} aria-label="Product checks summary">
      <div>
        <strong>{items.length ? `${items.length} products need fixes` : 'Product list looks clean'}</strong>
        <span>{items.length ? 'Checks look for missing details, duplicates, and broad categories.' : 'No obvious product issues in the loaded list.'}</span>
      </div>
      {visible.length > 0 && (
        <div className="qa-summary-list">
          {visible.map(({ product, flags }) => (
            <button type="button" key={product.id} onClick={() => onOpen(product)}>
              <span>{product.name}: {flags.slice(0, 2).join(', ')}</span>
              <b>Fix</b>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function BulkActionBar({ selectedProducts, onFeature, onUnfeature, onNewArrival, onClearNewArrival, onAvailable, onOutOfStock, onUnavailable, onDraft, onRemove }) {
  if (!selectedProducts.length) return null;
  return (
    <section className="bulk-action-bar" aria-label="Bulk product actions">
      <strong>{selectedProducts.length} selected</strong>
      <div>
        <button type="button" onClick={onFeature}>Feature</button>
        <button type="button" onClick={onUnfeature}>Unfeature</button>
        <button type="button" onClick={onNewArrival}>New Arrival</button>
        <button type="button" onClick={onClearNewArrival}>Clear New</button>
        <button type="button" onClick={onAvailable}>Available</button>
        <button type="button" onClick={onOutOfStock}>Out of stock</button>
        <button type="button" onClick={onUnavailable}>Unavailable</button>
        <button type="button" onClick={onDraft}>Draft</button>
        <button className="danger-action" type="button" onClick={onRemove}>Archive</button>
      </div>
    </section>
  );
}

function AdminProductRow({ product, selected, qaFlags, onSelect, onEdit, onPlacement, onAvailability, onDelete }) {
  const openProduct = () => onEdit(product);
  const openProductFromKeyboard = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openProduct();
    }
  };

  return (
    <article
      className={`admin-product ${selected ? 'selected' : ''} ${qaFlags.length ? 'needs-review' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Open product details for ${product.name}`}
      onClick={openProduct}
      onKeyDown={openProductFromKeyboard}
    >
      <div className="product-cell product-identity-cell">
        <label className="row-check" aria-label={`Select ${product.name}`} onClick={stopProductRowOpen}>
          <input type="checkbox" checked={selected} onChange={onSelect} />
        </label>
        <ProductThumbnail product={product} />
        <div className="admin-product-title">
          <h3>{product.name}</h3>
          <p>{displayBrand(product)}</p>
        </div>
      </div>
      <div className="product-cell product-detail-cell">
        <strong>{displayCategory(product)}</strong>
        <span>{product.gender || 'unisex'} - {garmentPlacementLabel(product.garmentPlacement)}</span>
        <span>{formatCatalogDate(product.createdAt)}</span>
      </div>
      <div className="product-cell product-merch-cell">
        <strong>{formatMoney(product.price || 0, product.currency)}</strong>
        <span>{Number(product.rating || 0).toFixed(1)} rating - {formatNumber(product.ratingCount || 0)} reviews</span>
        <div className="product-admin-meta">
          <span className={`availability-status ${product.availabilityStatus || 'available'}`}>{String(product.availabilityStatus || 'available').replace(/_/g, ' ')}</span>
          {product.tryOnModel && <span>{product.tryOnModel}</span>}
          {product.isFeatured && <span>Featured</span>}
          {product.isNewArrival && <span>New arrival</span>}
        </div>
      </div>
      <div className="product-cell product-link-cell">
        <div className="admin-row-links">
          {product.affiliateLink && <a className="admin-affiliate" href={product.affiliateLink} target="_blank" rel="noreferrer" onClick={stopProductRowOpen}>Affiliate</a>}
          {product.sourceUrl && <a className="admin-affiliate" href={product.sourceUrl} target="_blank" rel="noreferrer" onClick={stopProductRowOpen}>Source</a>}
          {!product.affiliateLink && !product.sourceUrl && <span>No source</span>}
        </div>
        {qaFlags.length > 0 && (
          <div className="qa-flags">
            {qaFlags.slice(0, 2).map((flag) => <span key={`${product.id}-${flag}`}>{flag}</span>)}
          </div>
        )}
      </div>
      <div className="product-cell admin-product-actions" onClick={stopProductRowOpen}>
        <div className="row-control-cluster">
          <label>
            <span>Availability</span>
            <select
              aria-label={`Availability for ${product.name}`}
              value={product.availabilityStatus || 'available'}
              onChange={(event) => onAvailability(product.id, event.target.value)}
            >
              <option value="draft">Draft</option>
              <option value="available">Available</option>
              <option value="out_of_stock">Out of stock</option>
              <option value="unavailable">Unavailable</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="fit-area-control">
            <span>Fit area</span>
            <select
              aria-label={`Fit area for ${product.name}`}
              value={product.garmentPlacement || 'top'}
              onChange={(event) => onPlacement(product.id, event.target.value)}
            >
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="full-body">Full body</option>
              <option value="accessory">Accessory</option>
            </select>
          </label>
        </div>
        <div className="row-actions">
          {product.availabilityStatus === 'available' && <a className="preview-action" href={productPublicUrl(product)} target="_blank" rel="noreferrer">Preview</a>}
          <button type="button" onClick={openProduct}>Edit</button>
          <button className="delete-action" type="button" onClick={() => onDelete(product)}>Delete</button>
        </div>
      </div>
    </article>
  );
}

function ProductEditor({ product, message, saving, onClose, onSubmit }) {
  const remoteImageValue = /^(?:https?:|data:)/i.test(product.imageUrl || '') ? product.imageUrl : '';

  return (
    <div className="editor-backdrop" role="presentation">
      <aside className="product-editor" aria-label={`Edit ${product.name}`}>
        <div className="editor-head">
          <div>
            <span>Product Details</span>
            <h2>{product.name}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close editor">Close</button>
        </div>
        <form className="editor-form" onSubmit={onSubmit} key={product.id}>
          <div className="editor-preview">
            <img src={mediaUrl(product.imageUrl)} alt="" />
            <div>
              <strong>{displayBrand(product)}</strong>
              <span>{displayCategory(product)} - {formatMoney(product.price || 0, product.currency)}</span>
            </div>
          </div>
          <section className="form-section">
            <div className="form-section-title"><strong>Product Details</strong><span>Shown on the website and used for matching outfits.</span></div>
            <label className="field"><span>Name</span><input name="name" required defaultValue={product.name || ''} /></label>
            <label className="field"><span>Brand</span><input name="brand" required defaultValue={product.brand || ''} /></label>
            <div className="two-col">
              <label className="field"><span>Category</span><input name="category" required defaultValue={product.category || ''} /></label>
              <label className="field"><span>Gender</span><select name="gender" defaultValue={product.gender || 'unisex'}><option value="men">Men</option><option value="women">Women</option><option value="unisex">Unisex</option></select></label>
            </div>
            <fieldset className="segmented-field placement-field">
              <legend>Fit area</legend>
              <label><input type="radio" name="garmentPlacement" value="top" defaultChecked={(product.garmentPlacement || 'top') === 'top'} /><span>Top</span></label>
              <label><input type="radio" name="garmentPlacement" value="bottom" defaultChecked={product.garmentPlacement === 'bottom'} /><span>Bottom</span></label>
              <label><input type="radio" name="garmentPlacement" value="full-body" defaultChecked={product.garmentPlacement === 'full-body'} /><span>Full body</span></label>
              <label><input type="radio" name="garmentPlacement" value="accessory" defaultChecked={product.garmentPlacement === 'accessory'} /><span>Accessory</span></label>
            </fieldset>
            <label className="field"><span>Description</span><textarea name="description" rows="4" defaultValue={product.description || ''} /></label>
          </section>
          <section className="form-section">
            <div className="form-section-title"><strong>Merchandising</strong><span>Used by catalog cards, filters, and personalized ranking.</span></div>
            <label className="field"><span>Availability</span><select name="availabilityStatus" defaultValue={product.availabilityStatus || 'available'}><option value="draft">Draft</option><option value="available">Available</option><option value="out_of_stock">Out of stock</option><option value="unavailable">Unavailable</option><option value="archived">Archived</option></select></label>
            <label className="field"><span>Inventory note</span><input name="inventoryNotes" defaultValue={product.inventoryNotes || ''} placeholder="Optional source or availability note" /></label>
            <div className="two-col">
              <label className="field"><span>Price</span><input name="price" type="number" step="0.01" min="0" required defaultValue={product.price ?? ''} /></label>
              <label className="field"><span>Compare price</span><input name="compareAtPrice" type="number" step="0.01" min="0" defaultValue={product.compareAtPrice ?? ''} /></label>
            </div>
            <div className="two-col">
              <label className="field"><span>Currency</span><input name="currency" defaultValue={product.currency || 'USD'} /></label>
              <label className="field"><span>Badge</span><input name="badge" defaultValue={product.badge || ''} /></label>
            </div>
            <div className="two-col">
              <label className="field"><span>Rating</span><input name="rating" type="number" step="0.1" min="0" max="5" defaultValue={product.rating ?? 4.5} /></label>
              <label className="field"><span>Rating count</span><input name="ratingCount" type="number" min="0" defaultValue={product.ratingCount ?? 0} /></label>
            </div>
            <label className="field"><span>Tags</span><input name="tags" defaultValue={(product.tags || []).join(', ')} /></label>
            <label className="field"><span>Colors</span><input name="colors" defaultValue={(product.colors || []).join(', ')} /></label>
            <label className="field"><span>Sizes</span><input name="sizes" defaultValue={(product.sizes || []).join(', ')} /></label>
            <label className="field"><span>Size note</span><input name="sizeNotes" defaultValue={product.sizeNotes || ''} placeholder="Optional fit or sizing note" /></label>
            <div className="checks">
              <label><input name="isFeatured" type="checkbox" defaultChecked={Boolean(product.isFeatured)} /> Featured</label>
              <label><input name="isNewArrival" type="checkbox" defaultChecked={Boolean(product.isNewArrival)} /> New arrival</label>
            </div>
          </section>
          <section className="form-section">
            <div className="form-section-title"><strong>Links & Try-On</strong><span>Source URLs help duplicate detection and external attribution.</span></div>
            <label className="field"><span>Affiliate link</span><input name="affiliateLink" type="url" defaultValue={product.affiliateLink || ''} /></label>
            <label className="field"><span>Source URL</span><input name="sourceUrl" type="url" defaultValue={product.sourceUrl || ''} /></label>
            <label className="field"><span>Remote image URL</span><input name="remoteImageUrl" type="url" defaultValue={remoteImageValue} /></label>
            <label className="field"><span>Try-on model</span><select name="tryOnModel" defaultValue={product.tryOnModel || 'gpt-image-2'}><option value="gpt-image-2">gpt-image-2</option><option value="wan-v2.6-image-to-image">wan-v2.6-image-to-image</option></select></label>
          </section>
          <div className="editor-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="submit" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button>
          </div>
          {message && <p className="form-message">{message}</p>}
        </form>
      </aside>
    </div>
  );
}

function CategoryDistribution({ items, total }) {
  const palette = ['#123323', '#ead8c2', '#d8c8b6', '#6d675f', '#8b2f2f', '#2f2418'];
  let cursor = 0;
  const segments = items.slice(0, 6).map((item, index) => {
    const percent = total ? (item.count / total) * 100 : 0;
    const start = cursor;
    cursor += percent;
    return `${palette[index % palette.length]} ${start}% ${cursor}%`;
  });
  const pieStyle = { background: segments.length ? `conic-gradient(${segments.join(', ')})` : 'var(--line)' };

  return (
    <div className="category-distribution" aria-label="Category distribution">
      <div className="distribution-head">
        <h3>Category Distribution</h3>
        <span>{total} loaded</span>
      </div>
      <div className="distribution-pie-wrap">
        <div className="distribution-pie" style={pieStyle}><span>{items.length}</span></div>
        <div className="distribution-pie-copy">
          <strong>{items[0]?.category || 'No categories'}</strong>
          <span>{items[0] ? `${items[0].count} products in the leading category` : 'Publish products to build category insights.'}</span>
        </div>
      </div>
      <div className="distribution-list">
        {items.slice(0, 6).map((item, index) => {
          const percent = total ? Math.round((item.count / total) * 100) : 0;
          return (
            <div className="distribution-item" key={item.category}>
              <div><strong><i style={{ background: palette[index % palette.length] }} />{item.category}</strong><span>{item.count} products - {percent}%</span></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function analyticsDateInput(value = new Date()) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function formatPercent(value) {
  const number = Number(value || 0);
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function formatDurationMs(value) {
  const milliseconds = Math.max(0, Number(value || 0));
  if (!milliseconds) return '-';
  const seconds = Math.round(milliseconds / 100) / 10;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${seconds}s`;
}

function analyticsChange(value) {
  const number = Number(value || 0);
  const sign = number > 0 ? '+' : '';
  return `${sign}${number}% vs previous period`;
}

function exportAnalyticsCsv(stats) {
  const rows = [['Section', 'Metric', 'Value', 'Detail']];
  const add = (section, metric, value, detail = '') => rows.push([section, metric, value, detail]);
  Object.entries(stats.totals || {}).forEach(([metric, value]) => add('Overview', metric, value));
  (stats.funnel || []).forEach((item) => add('Funnel', item.label, item.users, `${item.events} events; ${item.conversionRate}% conversion`));
  Object.entries(stats.recommendations || {}).filter(([, value]) => typeof value !== 'object').forEach(([metric, value]) => add('Recommendations', metric, value));
  Object.entries(stats.generation || {}).filter(([, value]) => typeof value !== 'object').forEach(([metric, value]) => add('Generation', metric, value));
  (stats.topProducts || []).forEach((item) => add('Products', item.name, item.events, `${item.views} views; ${item.tryOns} try-ons; ${item.shopClicks} shop clicks`));
  (stats.searches || []).forEach((item) => add('Searches', item.query, item.count, `${item.users} users; ${item.clicks} clicks; ${item.clickRate}% click rate; ${item.zeroResults} zero-result searches`));
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `lookmefy-analytics-${stats.period?.from ? String(stats.period.from).slice(0, 10) : 'export'}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function AnalyticsTrendChart({ items = [] }) {
  const width = 760;
  const height = 220;
  const padding = 28;
  const maxEvents = Math.max(...items.map((item) => Number(item.events || 0)), 1);
  const maxUsers = Math.max(...items.map((item) => Number(item.users || 0)), 1);
  const points = (field, maximum) => items.map((item, index) => {
    const x = items.length <= 1 ? width / 2 : padding + (index * (width - padding * 2) / (items.length - 1));
    const y = height - padding - ((Number(item[field] || 0) / maximum) * (height - padding * 2));
    return `${Math.round(x)},${Math.round(y)}`;
  }).join(' ');
  const labels = items.length ? [items[0], items[Math.floor((items.length - 1) / 2)], items[items.length - 1]] : [];

  return (
    <div className="analytics-trend-chart">
      <div className="analytics-chart-legend"><span className="events">Events</span><span className="users">Active users</span></div>
      {items.length === 0 ? <StatusPanel text="No activity in this period." /> : (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily events and active users">
            {[0, 1, 2, 3].map((line) => <line x1={padding} x2={width - padding} y1={padding + line * ((height - padding * 2) / 3)} y2={padding + line * ((height - padding * 2) / 3)} key={line} />)}
            <polyline className="trend-events" points={points('events', maxEvents)} />
            <polyline className="trend-users" points={points('users', maxUsers)} />
          </svg>
          <div className="analytics-chart-labels">{labels.map((item, index) => <span key={`${item.date}-${index}`}>{formatCatalogDate(item.date)}</span>)}</div>
        </>
      )}
    </div>
  );
}

function AnalyticsFunnel({ items = [] }) {
  const maximum = Math.max(...items.map((item) => Number(item.users || 0)), 1);
  return (
    <div className="analytics-funnel">
      {items.map((item, index) => (
        <div className="funnel-stage" key={item.type}>
          <div><span>{index + 1}</span><strong>{item.label}</strong><b>{formatNumber(item.users)} users</b></div>
          <div className="funnel-track"><span style={{ width: `${Math.max(item.users ? 5 : 0, Math.round((Number(item.users || 0) / maximum) * 100))}%` }} /></div>
          <small>{index ? `${formatPercent(item.conversionRate)} from previous stage` : `${formatNumber(item.events)} recorded impressions`}</small>
        </div>
      ))}
    </div>
  );
}

function AnalyticsProductTable({ items = [] }) {
  const [sort, setSort] = useState('events');
  const sorted = useMemo(() => [...items].sort((left, right) => Number(right[sort] || 0) - Number(left[sort] || 0)), [items, sort]);
  return (
    <>
      <div className="analytics-table-toolbar">
        <span>{formatNumber(items.length)} products with activity</span>
        <label className="field"><span>Sort products</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="events">Total activity</option><option value="views">Views</option><option value="tryOns">Try-ons</option><option value="shopClicks">Shop clicks</option><option value="recommendationCtr">Recommendation CTR</option><option value="engagementRate">Engagement rate</option></select></label>
      </div>
      <div className="analytics-table-scroll">
        <table className="analytics-table">
          <thead><tr><th>Product</th><th>Views</th><th>Rec. CTR</th><th>Wishlist</th><th>Try-ons</th><th>Shop</th><th>Engagement</th></tr></thead>
          <tbody>{sorted.slice(0, 20).map((item) => <tr key={item.id}><td><strong>{item.name}</strong><span>{item.brand || item.category || 'Catalog product'}</span></td><td>{formatNumber(item.views)}</td><td>{item.recommendationImpressions ? formatPercent(item.recommendationCtr) : '-'}</td><td>{formatNumber(item.wishlists)}</td><td>{formatNumber(item.tryOns)}</td><td>{formatNumber(item.shopClicks)}</td><td>{formatPercent(item.engagementRate)}</td></tr>)}</tbody>
        </table>
      </div>
      {!items.length && <StatusPanel text="No product activity in this period." />}
    </>
  );
}

function SearchAnalyticsTable({ items = [] }) {
  return (
    <div className="analytics-table-scroll">
      <table className="analytics-table search-analytics-table">
        <thead><tr><th>Search</th><th>Searches</th><th>Users</th><th>Clicks</th><th>Click rate</th><th>Zero results</th><th>Last searched</th></tr></thead>
        <tbody>{items.slice(0, 15).map((item) => <tr key={item.query}><td><strong>{item.query}</strong></td><td>{formatNumber(item.count)}</td><td>{formatNumber(item.users)}</td><td>{formatNumber(item.clicks)}</td><td>{formatPercent(item.clickRate)}</td><td className={item.zeroResults ? 'analytics-warning-value' : ''}>{formatNumber(item.zeroResults)}</td><td>{formatSignalDate(item.lastAt)}</td></tr>)}</tbody>
      </table>
      {!items.length && <StatusPanel text="No searches recorded in this period." />}
    </div>
  );
}

function RecommendationStatsCard({ state, onRefresh, period, onPeriodChange, categoryDistribution = [], categoryTotal = 0 }) {
  const stats = state.stats;
  const totals = stats?.totals || {};
  const eventCounts = stats?.eventCounts || [];
  const topProducts = stats?.topProducts || [];
  const topCategories = stats?.topCategories || [];
  const topBrands = stats?.topBrands || [];
  const topTags = stats?.topTags || [];
  const topGenders = stats?.topGenders || [];
  const recentEvents = stats?.recentEvents || [];
  const recommendations = stats?.recommendations || {};
  const generation = stats?.generation || {};
  const setRange = (range) => {
    if (range !== 'custom') return onPeriodChange({ range, from: '', to: '' });
    const to = analyticsDateInput();
    const from = analyticsDateInput(new Date(Date.now() - (29 * 24 * 60 * 60 * 1000)));
    onPeriodChange({ range, from, to });
  };

  return (
    <section className="analytics-page">
      <header className="admin-card analytics-command-card">
        <div><span>Measurement window</span><h2>Product and recommendation analytics</h2><p>{stats?.period?.label || 'Choose a reporting period.'}</p></div>
        <div className="analytics-command-actions">
          <label className="field"><span>Date range</span><select value={period.range} onChange={(event) => setRange(event.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom range</option></select></label>
          {period.range === 'custom' && <><label className="field"><span>From</span><input type="date" value={period.from} onChange={(event) => onPeriodChange({ ...period, from: event.target.value })} /></label><label className="field"><span>To</span><input type="date" value={period.to} onChange={(event) => onPeriodChange({ ...period, to: event.target.value })} /></label></>}
          <button type="button" onClick={onRefresh}>Refresh</button>
          <button type="button" onClick={() => stats && exportAnalyticsCsv(stats)} disabled={!stats}>Export CSV</button>
        </div>
      </header>
      {state.loading && <StatusPanel text="Loading user activity..." />}
      {state.error && <StatusPanel text={state.error} />}
      {!state.loading && !state.error && !stats && <StatusPanel text="Sign in to load user activity." />}
      {stats && (
        <>
          <div className="stats-grid">
            <StatBox label="Events" value={formatNumber(totals.events || 0)} meta={analyticsChange(stats.comparison?.events)} />
            <StatBox label="Active users" value={formatNumber(totals.activeUsers || 0)} meta={analyticsChange(stats.comparison?.activeUsers)} />
            <StatBox label="Sessions" value={formatNumber(totals.sessions || 0)} meta={analyticsChange(stats.comparison?.sessions)} />
            <StatBox label="Avg session" value={totals.averageSessionMinutes ? `${totals.averageSessionMinutes} min` : '-'} meta={`${formatNumber(totals.returningUsers || 0)} returning / ${formatPercent(totals.returningRate)} rate`} />
          </div>
          <section className="analytics-secondary-metrics" aria-label="Engagement metrics"><div><span>DAU average</span><strong>{formatNumber(totals.dau)}</strong></div><div><span>WAU</span><strong>{formatNumber(totals.wau)}</strong></div><div><span>MAU</span><strong>{formatNumber(totals.mau)}</strong></div><div><span>Events per user</span><strong>{formatNumber(totals.eventsPerUser)}</strong></div><div><span>New users</span><strong>{formatNumber(totals.newUsers)}</strong></div><div><span>Interacted price</span><strong>{totals.averageInteractedPrice ? formatMoney(totals.averageInteractedPrice, 'INR') : '-'}</strong></div></section>
          <section className="admin-card analytics-section"><div className="section-head"><div><h2>Engagement trend</h2><p>Daily activity and unique users inside the selected period.</p></div></div><AnalyticsTrendChart items={stats.trend || []} /></section>
          <div className="analytics-two-column">
            <section className="admin-card analytics-section"><div className="section-head"><div><h2>Recommendation funnel</h2><p>Unique users progressing from exposure to outbound shopping.</p></div></div><AnalyticsFunnel items={stats.funnel || []} /></section>
            <section className="admin-card analytics-section recommendation-health"><div className="section-head"><div><h2>Recommendation health</h2><p>Measured from algorithm-tagged impressions and actions.</p></div></div><div className="analytics-health-grid"><div><span>Impressions</span><strong>{formatNumber(recommendations.impressions)}</strong></div><div><span>Clicks</span><strong>{formatNumber(recommendations.clicks)}</strong></div><div><span>CTR</span><strong>{formatPercent(recommendations.ctr)}</strong></div><div><span>Catalog coverage</span><strong>{formatPercent(recommendations.coverageRate)}</strong></div><div><span>Category diversity</span><strong>{formatNumber(recommendations.categoryDiversity)}</strong></div><div><span>Brand diversity</span><strong>{formatNumber(recommendations.brandDiversity)}</strong></div><div><span>Cold-start share</span><strong>{formatPercent(recommendations.coldStartRate)}</strong></div><div><span>Attributed try-ons</span><strong>{formatNumber(recommendations.attributedTryOns)}</strong></div><div><span>Attributed shop clicks</span><strong>{formatNumber(recommendations.attributedShopClicks)}</strong></div></div><div className="analytics-two-column compact"><StatsList title="Recommendation sources" items={(recommendations.sources || []).map((item) => ({ label: item.source, value: item.impressions, meta: `${formatPercent(item.ctr)} CTR` }))} valueLabel={formatNumber} /><StatsList title="Algorithm versions" items={(recommendations.algorithmVersions || []).map((item) => ({ label: item.version, value: item.impressions, meta: `${formatPercent(item.ctr)} CTR` }))} valueLabel={formatNumber} /></div></section>
          </div>
          <section className="admin-card analytics-section"><div className="section-head"><div><h2>AI generation health</h2><p>Server-recorded image and video outcomes, including restored credits.</p></div></div><div className="analytics-health-grid generation-health-grid"><div><span>Attempts</span><strong>{formatNumber(generation.attempts)}</strong></div><div><span>Success rate</span><strong>{formatPercent(generation.successRate)}</strong></div><div><span>Failures</span><strong>{formatNumber(generation.failed)}</strong></div><div><span>Rejected</span><strong>{formatNumber(generation.rejected)}</strong></div><div><span>Average time</span><strong>{formatDurationMs(generation.averageDurationMs)}</strong></div><div><span>Credits charged</span><strong>{formatNumber(generation.tokensCharged)}</strong></div><div><span>Credits restored</span><strong>{formatNumber(generation.tokensRefunded)}</strong></div><div><span>Tracked provider cost</span><strong>{formatMoney(generation.providerCostUsd || 0, 'USD')}</strong></div></div><div className="generation-breakdown"><StatsList title="Providers" items={(generation.providers || []).map((item) => ({ label: item.provider, value: item.total, meta: `${formatPercent(item.successRate)} success` }))} valueLabel={formatNumber} /><StatsList title="Generation types" items={(generation.types || []).map((item) => ({ label: formatEventType(item.type), value: item.total, meta: `${formatPercent(item.successRate)} success` }))} valueLabel={formatNumber} /><StatsList title="Failure categories" items={(generation.errors || []).map((item) => ({ label: formatEventType(item.category), value: item.count }))} valueLabel={formatNumber} /></div></section>
          <section className="admin-card analytics-section"><div className="section-head"><div><h2>Product performance</h2><p>Views, recommendation response, try-ons, and outbound shopping by product.</p></div></div><AnalyticsProductTable items={topProducts} /></section>
          <div className="analytics-two-column">
            <section className="admin-card analytics-section"><div className="section-head"><div><h2>Search intelligence</h2><p>Demand signals and searches returning no catalog results.</p></div></div><SearchAnalyticsTable items={stats.searches || []} /></section>
            <section className="admin-card analytics-section"><div className="section-head"><div><h2>Action mix</h2><p>Event volume and unique users by tracked action.</p></div></div><StatsList title="Actions" items={eventCounts.map((item) => ({ label: formatEventType(item.type), value: item.count, meta: `${formatNumber(item.users)} users` }))} valueLabel={formatNumber} /></section>
          </div>
          <section className="admin-card analytics-section"><div className="section-head"><div><h2>Interest signals</h2><p>Weighted product attributes from activity in this reporting period.</p></div></div><div className="stats-columns"><StatsList title="Categories" items={topCategories.map((item) => ({ label: item.label, value: item.weight }))} /><StatsList title="Brands" items={topBrands.map((item) => ({ label: item.label, value: item.weight }))} /><StatsList title="Tags" items={topTags.map((item) => ({ label: item.label, value: item.weight }))} /><StatsList title="Audience" items={topGenders.map((item) => ({ label: item.label, value: item.weight }))} /></div></section>
          <div className="analytics-two-column"><section className="admin-card analytics-section">{categoryDistribution.length > 0 ? <CategoryDistribution items={categoryDistribution} total={categoryTotal} /> : <StatusPanel text="No live catalog category data." />}</section><section className="admin-card analytics-section"><RecentSignalsList items={recentEvents} /></section></div>
        </>
      )}
    </section>
  );
}

function StatBox({ label, value, meta, className = '' }) {
  return <div className={`stat-box ${className}`.trim()}><span>{label}</span><strong>{value}</strong>{meta && <em>{meta}</em>}</div>;
}

function StatsList({ title, items = [], valueLabel = formatWeight }) {
  const visibleItems = items.slice(0, 8);
  const maxValue = Math.max(...visibleItems.map((item) => Number(item.value) || 0), 1);

  return (
    <div className="stats-list">
      <h3>{title}</h3>
      {visibleItems.length === 0 ? <p>No data yet.</p> : visibleItems.map((item) => (
        <div className="stats-row" key={`${title}-${item.label}-${item.value}`}>
          <div className="stats-row-main">
            <div><strong>{item.label}</strong>{item.meta && <span>{item.meta}</span>}</div>
            <b>{valueLabel(item.value)}</b>
          </div>
          <div className="stats-row-bar" aria-hidden="true"><span style={{ width: `${Math.max(6, Math.round(((Number(item.value) || 0) / maxValue) * 100))}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function TopProductsList({ items = [] }) {
  const visibleItems = items.slice(0, 6);
  const maxValue = Math.max(...visibleItems.map((item) => Number(item.weight) || 0), 1);

  return (
    <div className="stats-list top-products-list">
      <h3>Top Products</h3>
      {visibleItems.length === 0 ? <p>No data yet.</p> : visibleItems.map((item, index) => {
        const percent = Math.max(6, Math.round(((Number(item.weight) || 0) / maxValue) * 100));
        return (
          <div className="top-product-card" key={`${item.id || item.name}-${index}`}>
            <span>{index + 1}</span>
            <div>
              <strong>{item.name}</strong>
              <em>{displayBrand(item)} - {displayCategory(item)} - {formatNumber(item.count || 0)} events</em>
              <div className="stats-row-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
            </div>
            <b>{formatWeight(item.weight)}</b>
          </div>
        );
      })}
    </div>
  );
}

function RecentSignalsList({ items = [] }) {
  const visibleItems = items.slice(0, 8);

  return (
    <div className="stats-list recent-signals-list">
      <h3>Recent Actions</h3>
      {visibleItems.length === 0 ? <p>No data yet.</p> : visibleItems.map((item) => (
        <div className="recent-signal" key={item.id || `${item.type}-${item.createdAt}`}>
          <div>
            <strong>{item.product?.name || item.query || formatEventType(item.type)}</strong>
            <span>{formatEventType(item.type)} - {formatSignalDate(item.createdAt)}</span>
          </div>
          <b>{formatWeight(item.weight)}</b>
        </div>
      ))}
    </div>
  );
}

function AdminProductSkeleton() {
  return (
    <div className="admin-products admin-products-skeleton" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, index) => (
        <article className="admin-product" key={index}>
          <span className="admin-skeleton-check" />
          <span className="admin-skeleton-thumb" />
          <div>
            <span className="admin-skeleton-line wide" />
            <span className="admin-skeleton-line medium" />
          </div>
          <span className="admin-skeleton-action" />
        </article>
      ))}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <section className="overview-skeleton" aria-label="Loading overview">
      {Array.from({ length: 8 }).map((_, index) => <span key={index} />)}
    </section>
  );
}

function UserRowsSkeleton() {
  return (
    <div className="user-rows-skeleton" aria-label="Loading users">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index}><span /><span /><span /><span /></div>
      ))}
    </div>
  );
}

function ProductThumbnail({ product, decorative = false }) {
  const [failed, setFailed] = useState(false);
  const label = String(product?.name || 'Product').trim();
  const showFallback = failed || !product?.imageUrl;
  return (
    <span className={`product-thumbnail ${showFallback ? 'fallback' : ''}`}>
      {!showFallback
        ? <img src={mediaUrl(product.imageUrl)} alt={decorative ? '' : label} onError={() => setFailed(true)} />
        : <span aria-hidden="true">{label.slice(0, 2).toUpperCase()}</span>}
    </span>
  );
}

function userAvatarStyle(value) {
  const palette = [
    ['#204c3a', '#ffffff'],
    ['#7a3d32', '#ffffff'],
    ['#365477', '#ffffff'],
    ['#765a22', '#ffffff'],
    ['#5b4774', '#ffffff'],
    ['#2f6665', '#ffffff']
  ];
  const index = [...String(value || 'user')].reduce((total, character) => total + character.charCodeAt(0), 0) % palette.length;
  return { background: palette[index][0], color: palette[index][1] };
}

function AdminToast({ message, onDismiss }) {
  return (
    <div className="admin-toast" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification">x</button>
    </div>
  );
}

function AdminConfirmDialog({ action, busy, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const target = action.user?.name || action.user?.email || action.product?.name || 'this record';
  let title = 'Confirm change';
  let detail = '';
  let confirmLabel = 'Confirm';
  let destructive = false;

  if (action.type === 'tokens') {
    title = action.mode === 'add' ? 'Add tokens?' : 'Set token balance?';
    detail = action.mode === 'add'
      ? `Add ${formatNumber(action.amount)} tokens to ${target}.`
      : `Replace ${target}'s balance with ${formatNumber(action.amount)} tokens.`;
    confirmLabel = action.mode === 'add' ? 'Add Tokens' : 'Set Balance';
  } else if (action.type === 'user-status') {
    const banning = action.status === 'banned';
    title = banning ? 'Ban user?' : 'Restore user access?';
    detail = banning ? `${target}'s current sessions will stop working.` : `${target} will be able to sign in again.`;
    confirmLabel = banning ? 'Ban User' : 'Restore Access';
    destructive = banning;
  } else if (action.type === 'remove-user') {
    title = 'Remove user?';
    detail = `${target}'s personal data, sessions, profile media, and generated try-ons will be removed. Payment records will be preserved for reconciliation.`;
    confirmLabel = 'Remove User';
    destructive = true;
  } else if (action.type === 'delete-product') {
    title = 'Permanently delete product?';
    detail = `${target}, its generated try-ons, and wishlist references will be deleted. This cannot be undone.`;
    confirmLabel = 'Delete Product';
    destructive = true;
  }

  const needsReason = action.type === 'user-status' && action.status === 'banned';
  const needsDeleteText = action.type === 'delete-product';
  const disabled = busy || (needsReason && !reason.trim()) || (needsDeleteText && confirmation !== 'DELETE');

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, onCancel]);

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div>
          <span className={`confirm-symbol ${destructive ? 'destructive' : ''}`} aria-hidden="true">{destructive ? '!' : '?'}</span>
          <div><h2 id="confirm-title">{title}</h2><p>{detail}</p></div>
        </div>
        {needsReason && <label className="field"><span>Reason for ban</span><textarea rows="3" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required for the audit log" autoFocus /></label>}
        {needsDeleteText && <label className="field"><span>Type DELETE to confirm</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" autoFocus /></label>}
        <div className="confirm-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={destructive ? 'destructive' : 'primary'} type="button" onClick={() => onConfirm({ reason, confirmation })} disabled={disabled}>{busy ? 'Working...' : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

function StatusPanel({ text }) {
  return <div className="status-panel">{text}</div>;
}

export default AdminApp;
