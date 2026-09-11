import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tailwind v4 compiles the shadcn/ui component set plus the design tokens in
// src/globals.css. The `@/*` alias maps onto /src for the components'
// internal imports.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Single-bundle console app; the vendor chunk is expected to be large.
    chunkSizeWarningLimit: 1600,
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname.replace(/\/$/, '') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
