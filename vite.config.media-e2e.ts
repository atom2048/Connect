import { defineConfig } from 'vite';

export default defineConfig({
  root: process.cwd(),
  publicDir: false,
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
});
