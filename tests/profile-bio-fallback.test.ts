import { describe, expect, it } from 'vitest';
import { normalizeProfileBio } from '../src/utils';

describe('legacy profile bio fallback', () => {
  it('treats a stored profile link label as an unset bio', () => {
    expect(normalizeProfileBio('プロフィールを見る')).toBe('');
  });

  it('keeps user-written bio text and trims surrounding whitespace', () => {
    expect(normalizeProfileBio('  アニメと漫画が好きです  ')).toBe('アニメと漫画が好きです');
  });

  it('treats absent or non-text values as unset', () => {
    expect(normalizeProfileBio(null)).toBe('');
    expect(normalizeProfileBio(undefined)).toBe('');
    expect(normalizeProfileBio({})).toBe('');
  });
});
