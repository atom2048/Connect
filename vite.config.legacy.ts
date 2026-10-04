import { defineConfig } from 'vite';

// Vercel continues to serve the Firebase application used by existing accounts.
// The Cloudflare/Better Auth client has its own build entry and must not replace it.
export default defineConfig({
  root: 'legacy',
  publicDir: '../public',
  build: {
    outDir: '../dist-legacy',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    cssMinify: 'esbuild',
  },
});
