import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const adminRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sharedPublic = fileURLToPath(new URL('../public', import.meta.url));

function normalizeApiBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/$/, '');
}

function isProductionBlockedApiHost(hostname = '') {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '127.0.0.1' || host === '0.0.0.0' || host === '10.0.2.2' || host === '::1') return true;
  if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^(fc|fd|fe80):/i.test(host)) return true;
  return false;
}

function assertProductionApiBaseUrl(value) {
  const normalized = normalizeApiBaseUrl(value);
  if (!normalized) throw new Error('Production build requires VITE_API_BASE_URL.');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('VITE_API_BASE_URL must be an absolute URL for production builds.');
  }
  if (url.protocol !== 'https:') throw new Error('VITE_API_BASE_URL must use HTTPS in production builds.');
  if (isProductionBlockedApiHost(url.hostname)) {
    throw new Error(`VITE_API_BASE_URL cannot point to a local or private development host in production: ${url.hostname}`);
  }
  return normalized;
}

function assertOptionalProductionPublicUrl(value, name) {
  const normalized = normalizeApiBaseUrl(value);
  if (!normalized) return '';
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${name} must be an absolute URL for production builds.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production builds.`);
  if (isProductionBlockedApiHost(url.hostname)) {
    throw new Error(`${name} cannot point to a local or private development host in production: ${url.hostname}`);
  }
  return normalized;
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  const apiTarget = env.VITE_DEV_PROXY_TARGET || 'http://localhost:5050';
  if (mode === 'production') {
    assertProductionApiBaseUrl(env.VITE_API_BASE_URL);
    assertOptionalProductionPublicUrl(env.VITE_STORE_BASE_URL, 'VITE_STORE_BASE_URL');
  }

  return {
    root: adminRoot,
    envDir: repoRoot,
    plugins: [react()],
    publicDir: sharedPublic,
    server: {
      port: 5174,
      proxy: {
        '/api': apiTarget,
        '/uploads': apiTarget
      }
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true
    }
  };
});
