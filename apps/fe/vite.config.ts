import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const PANEL_PORT = process.env['PANEL_PORT'] ?? '3000';

export default defineConfig({
  plugins: [react()],
  build: {
    // Straight into what the panel serves, so the whole console is one deploy
    // and there is no second thing to host.
    outDir: fileURLToPath(new URL('../panel/public', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: `http://localhost:${PANEL_PORT}`, changeOrigin: true },
      '/ws': { target: `http://localhost:${PANEL_PORT}`, ws: true },
    },
  },
});
