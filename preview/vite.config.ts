import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Standalone preview server for the presentational UI (not part of the build).
export default defineConfig({
  root: __dirname,
  resolve: {
    // Mirror .wxt/tsconfig.json's "@/*" → project root (shadcn ui imports).
    alias: { '@': fileURLToPath(new URL('..', import.meta.url)) },
  },
  plugins: [react(), tailwindcss()],
  server: { port: 5199 },
});
