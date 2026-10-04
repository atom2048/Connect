import { describe, expect, it } from 'vitest';
import { getPostContentKind } from '../src/contentKinds';

describe('post content classification', () => {
  it('labels sponsored metadata as advertising', () => {
    expect(getPostContentKind({ contentType: 'user', isSponsored: true })).toBe('advertisement');
    expect(getPostContentKind({ contentType: 'PR' })).toBe('advertisement');
  });

  it('keeps news and system media in their own explicit categories', () => {
    expect(getPostContentKind({ contentType: 'news' })).toBe('news');
    expect(getPostContentKind({ contentKind: 'system-screen' })).toBe('system');
  });

  it('keeps untagged legacy posts separate from explicitly classified user content', () => {
    expect(getPostContentKind({})).toBe('unclassified');
    expect(getPostContentKind({ contentType: 'unknown' })).toBe('unclassified');
    expect(getPostContentKind({ contentType: 'user' })).toBe('user');
  });
});
