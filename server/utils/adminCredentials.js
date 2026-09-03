const ADMIN_PASSWORD_MAX_BYTES = 72;

function adminPasswordError(value = '') {
  const password = String(value || '');
  if (!password) return 'Password is required';
  if (Buffer.byteLength(password, 'utf8') > ADMIN_PASSWORD_MAX_BYTES) {
    return `Password must be at most ${ADMIN_PASSWORD_MAX_BYTES} bytes`;
  }
  return '';
}

function normalizeAdminName(value = '', email = '') {
  const requested = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (requested) return requested;
  return String(email || '').split('@')[0].split(/[._-]+/).filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ''}${part.slice(1)}`)
    .join(' ') || 'Administrator';
}

export {
  ADMIN_PASSWORD_MAX_BYTES,
  adminPasswordError,
  normalizeAdminName
};
