import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('post search API contract', () => {
  it('fails closed until the independent index gates are enabled', async () => {
    const [config, api] = await Promise.all([
      readFile(new URL('../api/_search-config.js', import.meta.url), 'utf8'),
      readFile(new URL('../api/search/posts.js', import.meta.url), 'utf8'),
    ]);
    expect(config).toContain("process.env.SEARCH_API_ENABLED === 'true'");
    expect(config).toContain("process.env.SEARCH_INDEX_READY === 'true'");
    expect(api).toContain("'SEARCH_NOT_READY'");
    expect(api).toContain('SEARCH_APPLICATION_DEADLINE_MS');
    expect(api).toContain('Promise.race');
  });

  it('fixes the production query and pagination invariants in the handler', async () => {
    const api = await readFile(new URL('../api/search/posts.js', import.meta.url), 'utf8');
    expect(api).toContain("where('schemaVersion', '==', SEARCH_SCHEMA_VERSION)");
    expect(api).toContain("where('normalizerVersion', '==', SEARCH_NORMALIZER_VERSION)");
    expect(api).toContain("where('searchTokens', 'array-contains', selected.anchor)");
    expect(api).toContain('limit(scanLimit + 1)');
    expect(api).toContain('documentId: scannedCandidate.id');
    expect(api).toContain('jsonError(res, 504');
    expect(api).toContain("'SEARCH_TIMEOUT'");
    expect(api).toContain('canonicalSnapshots');
    expect(api).not.toContain('body.mode');
    expect(api).not.toContain('body.anchor');
  });

  it('overlays search result author fields from the current user profile', async () => {
    const api = await readFile(new URL('../api/search/posts.js', import.meta.url), 'utf8');
    expect(api).toContain('function authorPresentation(author)');
    expect(api).toContain('Object.assign(result, authorPresentation(author))');
    expect(api).toContain('publicPostDto(postSnapshot, author)');
    expect(api).not.toContain("'authorDisplayName', 'authorUsername', 'authorPhotoURL', 'authorAvatarColor'");
  });
});
