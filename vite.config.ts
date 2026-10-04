import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sites } from '@openai/sites-vite-plugin';

export default defineConfig(async () => {
  const { cloudflare } = await import('@cloudflare/vite-plugin');
  return {
    plugins: [
      react(),
      sites(),
      cloudflare({
        config: {
          main: './worker/index.ts',
        },
      }),
    ],
    server: {
      host: '0.0.0.0',
      watch: process.env.CODEX_SANDBOX === 'seatbelt' ? { useFsEvents: false, usePolling: true } : undefined,
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      cssCodeSplit: true,
      // Vite's Lightning CSS minifier currently fails to load on the hosted
      // Windows build runtime. Keep production CSS minified with esbuild.
      cssMinify: 'esbuild' as const,
    },
  };
});
