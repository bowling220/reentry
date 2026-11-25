import { defineConfig } from 'vite';

export default defineConfig({
  // Keep repository-relative URLs for GitHub Pages hosting.
  base: './',
  server: {
    port: 5173,
    open: false,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat', 'quickjs-emscripten'],
  },
  build: {
    target: 'esnext',
  },
});
