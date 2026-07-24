import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev mode: proxy API + WebSocket through the local node on :3001.
// The node mirrors the server on :3000, so the browser exercises the same
// access path it will use on a LAN while Vite still provides HMR.
// In production the server serves the built files directly.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/files': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
