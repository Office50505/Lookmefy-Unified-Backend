function isProductionEnv(env = process.env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function isLocalHostname(hostname = '') {
  const value = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost'
    || value === '127.0.0.1'
    || value === '0.0.0.0'
    || value === '::1'
    || value.endsWith('.localhost');
}

function validateConfiguredHttpsUrl(value, { name = 'URL', env = process.env, requireHttpsInProduction = true, allowLocalInProduction = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${name} is missing`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is malformed`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} must use HTTP or HTTPS`);
  if (isProductionEnv(env) && requireHttpsInProduction && url.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS in production`);
  }
  if (isProductionEnv(env) && !allowLocalInProduction && isLocalHostname(url.hostname)) {
    throw new Error(`${name} cannot point to localhost in production`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain URL credentials`);
  return url;
}

export { isLocalHostname, isProductionEnv, validateConfiguredHttpsUrl };
