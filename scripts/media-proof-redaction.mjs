/** Keep production monitoring evidence useful without recording account or object identifiers. */
export function classifyMediaEvidenceRoute(pathname) {
  const path = String(pathname || '').split(/[?#]/, 1)[0];
  if (/^\/api\/profiles(?:\/|$)/.test(path)) return 'api:profile';
  if (/^\/api\/posts(?:\/|$)/.test(path)) return 'api:post';
  if (path === '/api/health') return 'api:health';
  if (/^\/media\/migration\/legacy(?:\/|$)/.test(path)) return 'media:legacy-migration';
  if (/^\/media\/migration(?:\/|$)/.test(path)) return 'media:migration';
  if (/^\/media\/posts(?:\/|$)/.test(path)) return 'media:post';
  if (/^\/media\/profiles(?:\/|$)/.test(path)) return 'media:profile';
  if (/^\/media(?:\/|$)/.test(path)) return 'media:other';
  return 'other';
}

export function safeMediaResponseEvidence({ status, method, path }) {
  return {
    route: classifyMediaEvidenceRoute(path),
    method: String(method || 'GET').toUpperCase(),
    status: Number.isFinite(status) ? status : 0,
  };
}

export function safeMediaFailureEvidence({ method, path, error }) {
  const match = String(error || '').match(/\bnet::([A-Z0-9_]+)/);
  return {
    route: classifyMediaEvidenceRoute(path),
    method: String(method || 'GET').toUpperCase(),
    errorCode: match?.[1] || 'request_failed',
  };
}

export function safeBrowserFailureReason(error) {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)) return error.name;
  return 'BrowserCheckError';
}

