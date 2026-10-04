const HASHTAG_BODY = '[A-Za-z0-9_\u3040-\u30ff\u3400-\u9fff]+';
// Do not treat URL fragments, markdown headings, or an inline ASCII word as
// hashtags. The grammar intentionally remains conservative and emoji-free to
// preserve the existing post metadata contract.
const HASHTAG_PATTERN = new RegExp(`(^|[^A-Za-z0-9_/:?&=%#])[#＃](${HASHTAG_BODY})`, 'gu');
const SINGLE_HASHTAG_PATTERN = new RegExp(`^[#＃](${HASHTAG_BODY})$`, 'u');

export const SEARCH_SCHEMA_VERSION = 1;
export const SEARCH_NORMALIZER_VERSION = 1;
export const MAX_SEARCH_TERMS = 8;
export const MAX_SEARCH_TOKEN_COUNT = 10_000;

export function codePointLength(value) {
  return Array.from(String(value || '')).length;
}

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

export function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeHashtagKey(value) {
  return normalizeSearchText(String(value || '').replace(/^[#＃]/u, ''));
}

export function extractHashtagKeys(value) {
  const normalized = normalizeSearchText(value);
  const tags = new Set();
  for (const match of normalized.matchAll(HASHTAG_PATTERN)) {
    const key = normalizeHashtagKey(match[2]);
    if (key) tags.add(key);
  }
  return [...tags].sort();
}

export function parseSingleHashtagQuery(value) {
  const normalized = normalizeSearchText(value);
  const match = normalized.match(SINGLE_HASHTAG_PATTERN);
  if (!match) return null;
  const key = normalizeHashtagKey(match[1]);
  return key ? { key, query: `#${key}` } : null;
}

export function splitSearchTerms(value) {
  return normalizeSearchText(value).split(' ').map(term => term.trim()).filter(Boolean);
}

export function generateSearchTokens(value) {
  const normalized = normalizeSearchText(value);
  const tokens = new Set();
  for (const term of splitSearchTerms(normalized)) {
    const codePoints = Array.from(term);
    if (codePoints.length >= 2) {
      for (let index = 0; index <= codePoints.length - 2; index += 1) {
        tokens.add(`t2:${codePoints.slice(index, index + 2).join('')}`);
      }
    }
    if (codePoints.length >= 3) {
      for (let index = 0; index <= codePoints.length - 3; index += 1) {
        tokens.add(`t3:${codePoints.slice(index, index + 3).join('')}`);
      }
    }
  }
  extractHashtagKeys(normalized).forEach(tag => tokens.add(`h:${tag}`));
  const result = [...tokens].sort();
  if (result.length > MAX_SEARCH_TOKEN_COUNT) {
    const error = new Error('search_token_limit_exceeded');
    error.code = 'SEARCH_TOKEN_LIMIT_EXCEEDED';
    throw error;
  }
  return result;
}

export function chooseSearchAnchor(value) {
  const hashtag = parseSingleHashtagQuery(value);
  if (hashtag) return { mode: 'hashtag', anchor: `h:${hashtag.key}`, terms: [hashtag.key], hashtagKey: hashtag.key };
  const terms = [...new Set(splitSearchTerms(value))];
  const eligible = terms.filter(term => codePointLength(term) >= 2);
  if (!eligible.length) return null;
  let selected = eligible[0];
  for (const term of eligible.slice(1)) {
    if (codePointLength(term) > codePointLength(selected)) selected = term;
  }
  const points = Array.from(selected);
  const anchor = points.length === 2 ? `t2:${points.slice(0, 2).join('')}` : `t3:${points.slice(0, 3).join('')}`;
  return { mode: 'text', anchor, terms, hashtagKey: null };
}
