import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

describe('like interaction UI contract', () => {
  it('keeps the legacy like state visible and busy state separate from its selected state', async () => {
    const [components, home, styles] = await Promise.all([
      source('../src/components.ts'),
      source('../src/pageModules/home.ts'),
      source('../src/style.css'),
    ]);

    expect(components).toContain('aria-pressed="${liked ? \'true\' : \'false\'}" aria-busy="false"');
    expect(components).toContain('class="like-sync-indicator"');
    expect(home).toContain("btn.classList.toggle('is-syncing', syncing)");
    expect(home).toContain("btn.setAttribute('aria-busy', syncing ? 'true' : 'false')");
    expect(styles).toContain('.post-action-btn[data-action="like"].liked');
    expect(styles).toContain('.post-action-btn[data-action="like"]:disabled');
    expect(styles).toContain('opacity: 1;');
  });

  it('applies the optimistic state before saving and cannot roll it back when notification work fails', async () => {
    const home = await source('../src/pageModules/home.ts');
    const start = home.indexOf("container.querySelectorAll<AppDomElement>('[data-action=\"like\"]')");
    const end = home.indexOf("container.querySelectorAll<AppDomElement>('[data-action=\"load-video\"]')", start);
    const handler = home.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(handler.indexOf('applyPostLikeState(postId, nextLiked, optimisticCount, true)'))
      .toBeLessThan(handler.indexOf('await toggleLike(postId, currentUser.uid, nextLiked)'));
    expect(handler).toContain('applyPostLikeState(postId, finalLiked, canonicalCount)');
    expect(handler).toContain('void (async () => {');
    expect(handler).toContain("console.error('Like notification failed:', error)");
  });

  it('sends a desired reaction state and keeps the canonical result in the app post cache', async () => {
    const reactShell = await source('../src/react/App.tsx');
    const styles = await source('../src/react/styles.css');

    expect(reactShell).toContain('body: JSON.stringify({ active: nextLiked })');
    expect(reactShell).toContain('aria-busy={likeSyncing} disabled={likeSyncing}');
    expect(reactShell).toContain('onLikeChange?.(post.id, confirmedLiked, confirmedCount)');
    expect(reactShell).toContain('const updatePostLike = useCallback<PostLikeChange>');
    expect(styles).toContain('.post-action-like.is-active');
    expect(styles).toContain('.post-action-like.is-syncing .like-sync-indicator');
    expect(styles).toContain('.post-action-like:disabled');
  });
});
