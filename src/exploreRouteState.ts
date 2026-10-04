export type ExploreTab = 'all' | 'news' | 'users' | 'posts' | 'trending';
export type ExploreRouteState = { query: string; tab: ExploreTab; authorId: string };

const EXPLORE_TABS: readonly ExploreTab[] = ['all', 'news', 'users', 'posts', 'trending'];

export function parseExploreRouteState(hash: string): ExploreRouteState {
  const queryIndex = hash.indexOf('?');
  const params = queryIndex >= 0 ? new URLSearchParams(hash.slice(queryIndex + 1)) : new URLSearchParams();
  const query = params.get('query') || '';
  const rawTab = params.get('tab');
  const tab = EXPLORE_TABS.includes(rawTab as ExploreTab)
    ? rawTab as ExploreTab
    : (query ? 'all' : 'trending');
  return { query, tab, authorId: params.get('authorId')?.trim() || '' };
}

export function buildExploreRouteHash(query: string, tab: ExploreTab, authorId = ''): string {
  const params = new URLSearchParams();
  if (authorId) {
    // Keep the display-only author prefix and its single insertion space intact.
    params.set('query', query);
    params.set('authorId', authorId);
  } else if (query.trim()) {
    params.set('query', query.trim());
  }
  params.set('tab', tab);
  return `#/explore?${params.toString()}`;
}

export function authorPostQuery(displayQuery: string, authorId: string): string {
  if (!authorId) return displayQuery;
  return displayQuery.replace(/^@[^\s]+\s*/, '');
}
