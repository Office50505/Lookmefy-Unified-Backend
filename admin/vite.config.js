import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const adminRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sharedPublic = fileURLToPath(new URL('../public', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const apiTarget = env.VITE_DEV_PROXY_TARGET || 'http://localhost:5050';

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
