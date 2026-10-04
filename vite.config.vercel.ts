import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vercel hosts only the current React client. API and media requests stay
// same-origin in the browser and are reverse-proxied to the Cloudflare Worker
// by vercel.json. The legacy Firebase build remains available through
// `npm run build:vercel-legacy` for rollback only.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    cssMinify: 'esbuild',
  },
});
