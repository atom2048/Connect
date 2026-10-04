import { describe, expect, it } from 'vitest';
import { selectSearchResults } from '../src/react/searchPresentation';
import type { Post, Profile } from '../src/react/api';

const post = (id: string, likes: number): Post => ({
  id,
  authorId: 'author',
  author: { id: 'author', displayName: '投稿者', username: 'author' },
  body: id,
  visibility: 'public',
  counts: { likes, comments: 0, shares: 0 },
  createdAt: 0,
});
const profile: Profile = { id: 'profile', displayName: 'ユーザー', username: 'user' };

describe('selectSearchResults', () => {
  it('shows every supported search category only for すべて', () => {
    expect(selectSearchResults('all', [post('post', 1)], [profile])).toEqual({ posts: [post('post', 1)], profiles: [profile] });
  });

  it('keeps each category exclusive and leaves news empty until news data is loaded', () => {
    const posts = [post('post', 1)];
    const profiles = [profile];
    expect(selectSearchResults('users', posts, profiles)).toEqual({ posts: [], profiles });
    expect(selectSearchResults('posts', posts, profiles)).toEqual({ posts, profiles: [] });
    expect(selectSearchResults('news', posts, profiles)).toEqual({ posts: [], profiles: [] });
  });

  it('shows trending posts by engagement without showing unrelated users', () => {
    const posts = [post('quiet', 1), post('popular', 8)];
    expect(selectSearchResults('trending', posts, [profile])).toEqual({ posts: [posts[1], posts[0]], profiles: [] });
  });
});
