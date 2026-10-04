import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Vercel deployment boundary', () => {
  it('serves the established Connect client and proxies only Ask AI to standalone Cloudflare', async () => {
    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    const ignore = await readFile(new URL('../.vercelignore', import.meta.url), 'utf8');
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const legacyConfig = await readFile(new URL('../vite.config.legacy.ts', import.meta.url), 'utf8');
    const productionConfig = await readFile(new URL('../vite.config.vercel-connect.ts', import.meta.url), 'utf8');

    expect(config.buildCommand).toBe('npm run build:vercel');
    expect(config.outputDirectory).toBe('dist');
    expect(config.rewrites).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '/api/ai/:path*', destination: expect.stringContaining('connect-social-standalone.quest-live.workers.dev/api/ai/:path*') }),
      expect.objectContaining({ source: '/api/posts/:postId/ask-ai', destination: expect.stringContaining('connect-social-standalone.quest-live.workers.dev/api/posts/:postId/ask-ai') }),
    ]));
    expect(JSON.stringify(config)).not.toContain('chatgpt.site');
    expect(productionConfig).toContain("root: 'legacy'");
    expect(productionConfig).toContain("outDir: '../dist'");
    expect(packageJson.scripts['build:vercel-legacy']).toContain('vite.config.legacy.ts');
    expect(legacyConfig).toContain("root: 'legacy'");
    expect(legacyConfig).toContain("outDir: '../dist-legacy'");
    expect(JSON.stringify(config)).not.toContain('/api/spaces');
    expect(ignore).not.toContain('api/spaces/**');
  });
});
