import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    server: { deps: { external: ['firebase-admin', 'firebase-admin/app', 'firebase-admin/firestore'] } },
  },
});
