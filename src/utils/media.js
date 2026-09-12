// Generated media routes already carry a resource-specific signed token.
// Resolve them against the backend without replacing it with an upload token.
export function resolveProtectedMediaUrl(value = '', { apiBaseUrl = '', mediaToken = '' } = {}) {
  const url = typeof value === 'string' ? value.trim() : '';
  const isUpload = url.startsWith('/uploads/');
  if (!isUpload && !url.startsWith('/api/')) return url;

  const base = String(apiBaseUrl).replace(/\/$/, '').replace(/\/api$/, '');
  if (!isUpload || !mediaToken || /(?:[?&])mediaToken=/.test(url)) return `${base}${url}`;
  const separator = url.includes('?') ? '&' : '?';
  return `${base}${url}${separator}mediaToken=${encodeURIComponent(mediaToken)}`;
}
