import { defineConfig } from 'vite';

// Vite 8's SPA fallback returns index.html (200) for unmatched routes,
// including non-existent /assets/* files. Phaser's image loader treats
// a 200 as success and tries to decode the HTML as PNG, which fails and
// hangs the loader. This middleware returns 404 for missing static assets.
export default defineConfig({
  appType: 'spa',
  server: {
    fs: {
      allow: ['.'],
    },
    // Allow external connections for debugging
    host: true,
  },
  build: {
    sourcemap: true,
  },
});