import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mockApiPlugin } from './vite-mock-plugin';

/**
 * The server-side mock answered every /api/v1 request before the proxy, so in development the
 * real API was never reached (and any password logged in). It is now opt-in: FMS_MOCK_API=1.
 * Without a running API the browser client still falls back to the in-page mock (lib/api.ts).
 */
const serverMock = process.env.FMS_MOCK_API === '1';

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(serverMock ? [mockApiPlugin()] : [])],
  server: {
    port: 5173,
    // Same-origin API in dev so the httpOnly refresh cookie (SameSite=Strict) works.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom', 'react-router'], tanstack: ['@tanstack/react-query', '@tanstack/react-table'] },
      },
    },
  },
});
