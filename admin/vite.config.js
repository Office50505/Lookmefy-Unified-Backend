import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const adminRoot = fileURLToPath(new URL('.', import.meta.url));
const sharedPublic = fileURLToPath(new URL('../public', import.meta.url));

export default defineConfig({
  root: adminRoot,
  plugins: [react()],
  publicDir: sharedPublic,
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:5050',
      '/uploads': 'http://localhost:5050'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
