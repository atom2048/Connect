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
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : 'BrowserCheckError';
  const message = error instanceof Error ? error.message : String(error || '');
  const networkError = message.match(/\bnet::([A-Z0-9_]+)/);
  if (networkError) return `${name}:${networkError[1]}`;
  if (/\btimeout\b/i.test(message)) return `${name}:timeout`;

  const knownReasons = [
    'production profile avatar did not load',
    'production profile cover background is missing',
    'no existing profile post image loaded in production',
    'profile avatar failed after reload',
    'production video did not play',
    'production video did not play after reload',
    'profile cover did not return HTTP 200',
    'existing post image did not return HTTP 200',
    'existing video did not return HTTP 206 Range responses',
  ];
  const reason = knownReasons.find(candidate => message.includes(candidate));
  return reason ? `${name}:${reason}` : `${name}:browser_check_failed`;
}

