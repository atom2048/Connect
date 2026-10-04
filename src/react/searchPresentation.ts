import type { Post, Profile } from './api';

export type SearchTab = 'all' | 'trending' | 'users' | 'posts' | 'news';

export function selectSearchResults(tab: SearchTab, posts: Post[], profiles: Profile[]): { posts: Post[]; profiles: Profile[] } {
  if (tab === 'users') return { posts: [], profiles };
  if (tab === 'posts') return { posts, profiles: [] };
  if (tab === 'news') return { posts: [], profiles: [] };
  if (tab === 'trending') {
    const engagement = (post: Post) => (Number(post.counts.likes) || 0) + (Number(post.counts.comments) || 0) * 2 + (Number(post.counts.shares) || 0) * 3;
    return { posts: [...posts].sort((a, b) => engagement(b) - engagement(a)), profiles: [] };
  }
  return { posts, profiles };
}
