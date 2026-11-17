import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const engine = process.env.ATLAS_ENGINE ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  // One React for the app and its libraries: two copies crash at render.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: engine, ws: true } },
  },
});
