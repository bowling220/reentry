import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs allow the same build to run at / or a GitHub Pages repository path.
  base: './',
  server: {
    port: 5173,
    open: false,
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  build: {
    target: 'esnext',
  },
});
