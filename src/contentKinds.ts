export type PostContentKind = 'user' | 'news' | 'advertisement' | 'system' | 'unclassified';

export type PostContentMetadata = {
  contentType?: unknown;
  contentKind?: unknown;
  isSponsored?: unknown;
  sponsored?: unknown;
  isAd?: unknown;
};

/** Classify content from its explicit source metadata; never infer ads or OS screens from body text. */
export function getPostContentKind(post: PostContentMetadata): PostContentKind {
  if (post.isSponsored === true || post.sponsored === true || post.isAd === true) return 'advertisement';
  const raw = String(post.contentType || post.contentKind || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return 'unclassified';
  if (['ad', 'ads', 'advertisement', 'sponsored', 'sponsorship', 'pr', 'promotion'].includes(raw)) return 'advertisement';
  if (['news', 'article', 'editorial'].includes(raw)) return 'news';
  if (['system', 'system_screen', 'os', 'os_screen', 'settings_screen'].includes(raw)) return 'system';
  return raw === 'user' ? 'user' : 'unclassified';
}
