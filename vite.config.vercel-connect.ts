import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));

// Production Vercel artifact for the established Connect UI. The page entry,
// component tree, Firebase data runtime, and CSS remain the same as the known-
// good production deployment; only additive features such as Ask AI are bundled.
export default defineConfig({
  root: 'legacy',
  publicDir: '../public',
  envDir: '../.vercel',
  resolve: { alias: { '/src': resolve(repositoryRoot, 'src') } },
  server: { fs: { allow: [repositoryRoot] } },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    cssMinify: 'esbuild',
  },
});
