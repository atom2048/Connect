import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Search Ready exposure gate', () => {
  it('keeps the readiness endpoint fail-closed until both independent gates are enabled', async () => {
    const source = await readFile(new URL('../api/search/ready.js', import.meta.url), 'utf8');
    expect(source).toContain('SEARCH_API_ENABLED');
    expect(source).toContain('SEARCH_INDEX_READY');
    expect(source).toContain("res.status(503).json({ ready: false, error: 'SEARCH_NOT_READY' })");
  });

  it('keeps ordinary search controls behind readiness while allowing profile-scoped author search', async () => {
    const [explore, readiness] = await Promise.all([
      readFile(new URL('../src/pageModules/explore.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/searchReadiness.ts', import.meta.url), 'utf8'),
    ]);
    expect(explore).toContain('const searchReady = await isSearchReady();');
    expect(explore).toContain('const canSearch = searchReady || Boolean(state.authorId);');
    expect(explore).toContain('const searchControls = canSearch ?');
    expect(explore).toContain('const explorePanels = canSearch ?');
    expect(readiness).toContain("fetch('/api/search/ready'");
  });
});
