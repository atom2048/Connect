import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

describe('social interaction UX contract', () => {
  it('keeps repost and sharing as explicit menus rather than immediate actions', async () => {
    const [components, home] = await Promise.all([
      source('../src/components.ts'),
      source('../src/pageModules/home.ts'),
    ]);

    expect(components).toContain('data-action="repost-menu"');
    expect(components).toContain('data-action="share-menu"');
    expect(components).not.toContain('data-action="copy-post-link"');
    expect(components).not.toContain('data-action="share-post"');
    expect(home).toContain("action: reposted ? 'undo-repost' : 'repost'");
    expect(home).toContain("t('リポストを取り消す')");
    expect(home).toContain("{ action: 'quote'");
    expect(home).toContain("{ action: 'share'");
    expect(home).toContain("{ action: 'copy'");
    expect(home).toContain('openPostActionMenu(anchorBtn');
  });

  it('supports per-image ALT editing and image drag-and-drop without removing file selection', async () => {
    const home = await source('../src/pageModules/home.ts');

    expect(home).toContain('id="edit-post-image-alts"');
    expect(home).toContain('class="form-input edit-post-image-alt-input"');
    expect(home).toContain('imageAlts: nextImageAlts');
    expect(home).toContain('bindImageDropTarget(textarea)');
    expect(home).toContain("target.addEventListener('drop'");
    expect(home).toContain('attachDroppedImages(files)');
    expect(home).toContain("fileInput.addEventListener('change'");
  });

  it('only renders comment editing for its owner and routes saves through the guarded update function', async () => {
    const [components, home, rules] = await Promise.all([
      source('../src/components.ts'),
      source('../src/pageModules/home.ts'),
      source('../firestore.rules'),
    ]);

    expect(components).toContain('const canManage = !!currentUser && currentUser.uid === comment.userId;');
    expect(components).toContain('data-action="edit-comment"');
    expect(home).toContain('export function setupCommentEditButtons');
    expect(home).toContain('comment.dataset.commentUserId !== currentUser.uid');
    expect(home).toContain('updateComment(commentId, currentUser.uid, { text: nextText })');
    expect(rules).toContain("function isCommentContentUpdate()");
    expect(rules).toContain("allow update: if isCommentContentUpdate() || isCommentLikeMetricUpdate();");
  });

  it('keeps settings reachable from the Legacy header and React sidebar', async () => {
    const [legacyShell, reactShell] = await Promise.all([
      source('../src/main.ts'),
      source('../src/react/App.tsx'),
    ]);

    expect(legacyShell).toContain('class="header-icon-btn header-settings-btn"');
    expect(legacyShell).toContain('id="nav-notif-badge"');
    expect(legacyShell).not.toContain('id="notification-wrapper"');
    expect(legacyShell).not.toContain('id="notification-bell"');
    expect(reactShell).toContain('aria-label="メインナビゲーション"');
    expect(reactShell).toContain("route.name === 'settings' ? 'is-active' : ''");
    expect(reactShell).toContain('<span>設定</span>');
    expect(reactShell).toContain('aria-label="通知" title="通知" onClick={() => navigate({ name: \'notifications\' })}');
  });

  it('keeps home, explore, friends, and notifications in the React navigation', async () => {
    const reactShell = await source('../src/react/App.tsx');
    expect(reactShell).toContain("{ name: 'home', label: 'ホーム'");
    expect(reactShell).toContain("{ name: 'explore', label: '探す'");
    expect(reactShell).toContain("{ name: 'friends', label: '友達'");
    expect(reactShell).toContain("{ name: 'notifications', label: '通知'");
    expect(reactShell).not.toContain("{ name: 'profile', label: 'プロフィール'");
    expect(reactShell).toContain('aria-label="アカウントメニュー"');
    expect(reactShell).toContain("navigate({ name: 'profile', id: viewer.id })");
  });
});
