import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Standalone preview server for the presentational UI (not part of the build).
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  server: { port: 5199 },
});
