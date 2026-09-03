const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|password|passcode|secret|api[_-]?key|media[_-]?token|access[_-]?token|refresh[_-]?token|token|otp|code)/i;

function requestPath(req = {}) {
  const directPath = String(req.path || '').trim();
  if (directPath) return directPath;
  const raw = String(req.originalUrl || req.url || '/');
  const queryIndex = raw.indexOf('?');
  return queryIndex >= 0 ? raw.slice(0, queryIndex) || '/' : raw || '/';
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEY_PATTERN.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return value;
  }
}

function redactSensitiveText(value, maxLength = 4_000) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url))
    .replace(
      /\b([a-z0-9_-]*(?:authorization|cookie|password|passcode|secret|api[_-]?key|media[_-]?token|access[_-]?token|refresh[_-]?token|token|otp|code))\s*[:=]\s*(?:Bearer\s+)?[^\s,;&]+/gi,
      '$1=[redacted]'
    )
    .slice(0, maxLength);
}

export { redactSensitiveText, requestPath };
