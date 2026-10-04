import { describe, expect, it } from 'vitest';
import {
  chooseSearchAnchor,
  extractHashtagKeys,
  generateSearchTokens,
  normalizeSearchText,
  parseSingleHashtagQuery,
} from '../functions/lib/search-normalizer.js';
import {
  buildSearchProjection,
  buildPostSearchIndex,
  didSearchProjectionChange,
  projectionSourceVersion,
} from '../functions/lib/search-index.js';

const publicPost = (overrides = {}) => ({
  userId: 'user-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  text: '生成AIと東京電機大学 #AI',
  hashtags: ['AI'],
  visibility: 'public',
  ...overrides,
});

describe('search projection domain', () => {
  it('normalizes Unicode and whitespace without changing the source text', () => {
    expect(normalizeSearchText('  ＡＩ\u3000東京\n大学  ')).toBe('ai 東京 大学');
  });

  it('extracts deterministic, deduplicated hashtag keys', () => {
    expect(extractHashtagKeys('＃AI #ai #東京。 #bad-tag https://example.test/#fragment ##heading inline#tag')).toEqual(['ai', 'bad', '東京']);
    expect(parseSingleHashtagQuery('＃ＡＩ')).toEqual({ key: 'ai', query: '#ai' });
    expect(parseSingleHashtagQuery('#AI 最新')).toBeNull();
  });

  it('uses a deterministic longest-term anchor and never silently truncates tokens', () => {
    expect(chooseSearchAnchor('東京 AI')).toEqual({ mode: 'text', anchor: 't2:東京', terms: ['東京', 'ai'], hashtagKey: null });
    expect(chooseSearchAnchor('a b')).toBeNull();
    const tokens = generateSearchTokens('ああああ');
    expect(tokens).toEqual([...new Set(tokens)].sort());
    expect(tokens).toContain('t2:ああ');
    expect(tokens).toContain('t3:あああ');
  });

  it('creates a stable source version for the same canonical projection', () => {
    const first = buildPostSearchIndex(publicPost(), 'post-1');
    const reordered = buildPostSearchIndex(publicPost({ hashtags: ['AI'], likeCount: 4 }), 'post-1');
    expect(first.sourceVersion).toBe(reordered.sourceVersion);
    const projection = buildSearchProjection(publicPost(), 'post-1');
    expect(projectionSourceVersion({ ...projection, searchTokens: [...projection.searchTokens].reverse() })).toBe(first.sourceVersion);
    expect(didSearchProjectionChange(publicPost(), publicPost({ likeCount: 10 }), 'post-1')).toBe(false);
    expect(didSearchProjectionChange(publicPost(), publicPost({ text: '別の本文' }), 'post-1')).toBe(true);
  });

  it('does not index non-public or malformed posts', () => {
    expect(buildPostSearchIndex(publicPost({ visibility: 'friends' }), 'post-1')).toBeNull();
    expect(buildPostSearchIndex(publicPost({ text: null }), 'post-1')).toBeNull();
  });
});
