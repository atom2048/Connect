// This module intentionally re-exports the browser-safe search contract from
// functions/lib. The server-only projection builder/hash implementation is not
// imported by the browser bundle.
export {
  SEARCH_SCHEMA_VERSION,
  SEARCH_NORMALIZER_VERSION,
  MAX_SEARCH_TERMS,
  MAX_SEARCH_TOKEN_COUNT,
  codePointLength,
  utf8ByteLength,
  normalizeSearchText,
  normalizeHashtagKey,
  extractHashtagKeys,
  parseSingleHashtagQuery,
  splitSearchTerms,
  generateSearchTokens,
  chooseSearchAnchor,
} from '../functions/lib/search-normalizer.js';
