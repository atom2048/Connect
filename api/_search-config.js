// These values are the frozen Search Preflight B gate for the current index
// design. Changing them after a benchmark requires a new gate commit and a
// complete Preflight B rerun.
export const SEARCH_APPLICATION_DEADLINE_MS = 2500;
// Production fail-closed gate. These are enabled only after the Function,
// indexes, backfill, and integrity checks have passed. Preview can opt in
// explicitly; an unset environment variable never exposes a partial index.
export const SEARCH_API_ENABLED = process.env.SEARCH_API_ENABLED === 'true';
export const SEARCH_INDEX_READY = process.env.SEARCH_INDEX_READY === 'true';
export const PREVIEW_SCAN_LIMIT = 50;
export const FULL_SCAN_LIMIT = 100;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 20;
export const SEARCH_MAX_CODE_POINTS = 128;
export const SEARCH_MAX_UTF8_BYTES = 512;
export const SEARCH_MAX_TERMS = 8;
