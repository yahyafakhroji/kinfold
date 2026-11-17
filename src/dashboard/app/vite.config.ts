// Builds the dashboard to static files the daemon serves and the release
// build embeds: dist/index.html, dist/login.html and dist/assets/<name>-<hex>.js|css.
// Names are lowercase with a hex hash so they pass the daemon's asset name
// check (src/dashboard/routes.ts). Nothing is inlined: the daemon's CSP allows
// only its own scripts and styles.

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Rollup names chunks after modules (useMutation, es2015); the daemon serves lowercase names only. */
const lower = (name: string): string => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'chunk'

export default defineConfig({
  root: import.meta.dirname,
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    sourcemap: false,
    rollupOptions: {
      input: { index: 'index.html', login: 'login.html' },
      output: {
        hashCharacters: 'hex',
        entryFileNames: (chunk) => `assets/${lower(chunk.name)}-[hash].js`,
        chunkFileNames: (chunk) => `assets/${lower(chunk.name)}-[hash].js`,
        assetFileNames: (asset) => `assets/${lower((asset.names[0] ?? 'asset').replace(/\.[^.]+$/, ''))}-[hash][extname]`,
      },
    },
  },
})
