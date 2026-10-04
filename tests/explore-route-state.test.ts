import { describe, expect, it } from 'vitest';
import { buildExploreRouteHash, parseExploreRouteState } from '../src/exploreRouteState';

describe('Explore selected tab and content route state', () => {
  it('uses one news selection for both the filter and the news panel', () => {
    expect(parseExploreRouteState('#/explore?tab=news')).toEqual({ query: '', tab: 'news', authorId: '' });
  });

  it('keeps All selected when showing the combined discovery view without a query', () => {
    const state = parseExploreRouteState('#/explore?tab=all');
    expect(state).toEqual({ query: '', tab: 'all', authorId: '' });
  });

  it('defaults to All for searches and Trends for an invalid empty-search tab', () => {
    expect(parseExploreRouteState('#/explore?query=JCOM')).toEqual({ query: 'JCOM', tab: 'all', authorId: '' });
    expect(parseExploreRouteState('#/explore?tab=users')).toEqual({ query: '', tab: 'users', authorId: '' });
    expect(parseExploreRouteState('#/explore?tab=unknown')).toEqual({ query: '', tab: 'trending', authorId: '' });
    expect(parseExploreRouteState('#/explore')).toEqual({ query: '', tab: 'trending', authorId: '' });
  });

  it('serializes one selected tab and trims search text', () => {
    expect(buildExploreRouteHash(' JCOM ', 'all')).toBe('#/explore?query=JCOM&tab=all');
  });
});
