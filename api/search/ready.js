import { setApiHeaders } from '../_auth.js';
import { SEARCH_API_ENABLED, SEARCH_INDEX_READY } from '../_search-config.js';

export default function handler(req, res) {
  setApiHeaders(res, 'GET');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  if (!SEARCH_API_ENABLED || !SEARCH_INDEX_READY) {
    return res.status(503).json({ ready: false, error: 'SEARCH_NOT_READY' });
  }

  return res.status(200).json({ ready: true });
}
