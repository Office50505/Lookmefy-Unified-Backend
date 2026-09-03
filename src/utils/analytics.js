const SENSITIVE_KEYS = new Set([
  'address',
  'bodyPhoto',
  'email',
  'generatedImageUrl',
  'imageUrl',
  'phone',
  'photo',
  'token',
  'url'
]);

function safePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return {};
  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (SENSITIVE_KEYS.has(key)) return acc;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      acc[key] = safePayload(value);
    } else if (typeof value !== 'function') {
      acc[key] = value;
    }
    return acc;
  }, {});
}

export function trackClientEvent(name, payload = {}) {
  const eventName = String(name || '').trim();
  if (!eventName || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('fitlook:analytics', {
    detail: {
      name: eventName,
      payload: safePayload(payload),
      ts: Date.now()
    }
  }));
}

export function bindRuntimeErrorTracking() {
  if (typeof window === 'undefined' || window.__fitlookRuntimeErrorsBound) return;
  window.__fitlookRuntimeErrorsBound = true;

  window.addEventListener('error', (event) => {
    trackClientEvent('frontend_error', {
      message: event.message,
      source: event.filename,
      line: event.lineno
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    trackClientEvent('frontend_unhandled_rejection', {
      message: event.reason?.message || String(event.reason || 'Unhandled rejection')
    });
  });
}
