import { defineConfig } from '@playwright/test';

const launchOptions = process.env.VERCEL === '1'
  ? await (async () => {
    const serverlessChromium = (await import('@sparticuz/chromium')).default;
    return {
      executablePath: await serverlessChromium.executablePath(),
      args: serverlessChromium.args,
    };
  })()
  : undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4178',
    browserName: 'chromium',
    headless: true,
    launchOptions,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: 'test-results/media-browser',
  webServer: {
    command: 'npm run media:e2e:server',
    url: 'http://127.0.0.1:4178/tests/browser/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
