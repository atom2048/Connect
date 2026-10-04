import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('DM/story-reply/hashtag retirement contract', () => {
  it('does not expose DM page exports and keeps old bookmarks on an explicit retirement page', async () => {
    const [pages, main, db, components, style, converters, domain] = await Promise.all([
      source('src/pages.ts'),
      source('src/main.ts'),
      source('src/db.ts'),
      source('src/components.ts'),
      source('src/style.css'),
      source('src/types/converters.ts'),
      source('src/types/domain.ts'),
    ]);
    expect(pages).not.toContain('renderDmListPage');
    expect(pages).not.toContain('renderDmChatPage');
    expect(pages).not.toContain('renderDmNewPage');
    expect(main).toContain("registerRoute('/dm', renderRetiredDmRoute)");
    expect(main).toContain("registerRoute('/dm/:id', renderRetiredDmRoute)");
    expect(main).toContain('DM機能は提供終了しました');
    expect(main).not.toContain('redirectLegacyDmRoute');
    expect(db).not.toContain('createConversation');
    expect(db).not.toContain('subscribeConversations');
    expect(db).not.toContain('sendMessage');
    expect(db).not.toContain('throwDmFeatureDisabled');
    expect(components).toContain("case 'dm':");
    expect(components).toContain('return \'\';');
    expect(main).toContain('header-login-btn');
    expect(style).not.toMatch(/(?:^|[.#\s,])dm-(?:thread|message|chat|conversation)(?:[-_\s.:,{#]|$)/im);
    expect(converters).not.toContain('toDMThread');
    expect(converters).not.toContain('toDMMessage');
    expect(domain).not.toContain('interface DMThread');
    expect(domain).not.toContain('interface DMMessage');
  });

  it('keeps authenticated header actions after Firebase restores the session', async () => {
    const [main, style] = await Promise.all([source('src/main.ts'), source('src/style.css')]);
    expect(main).toContain('id="account-controls"');
    expect(main).toContain('function syncAccountControls(authenticated: boolean)');
    expect(main).toContain('syncAccountControls(authenticated);');
    expect(main).toContain("href=\"#/settings\"");
    expect(main).toContain('id="nav-notif-badge"');
    expect(main).not.toContain('id="notification-wrapper"');
    expect(main).not.toContain('id="notification-bell"');
    expect(main).not.toContain("href=\"#/spaces\"");
    expect(style).toContain('#account-controls');
    expect(main).not.toContain("registerRoute('/spaces'");
    expect(main).not.toContain("registerRoute('/spaces/:id'");
  });

  it('removes story reply input styling while retaining independent reactions', async () => {
    const [home, style] = await Promise.all([source('src/pageModules/home.ts'), source('src/style.css')]);
    expect(home).not.toContain('story-reply-bar');
    expect(home).not.toContain('story-reply-input');
    expect(home).toContain('story-reaction-bar');
    expect(style).not.toContain('story-reply-input-row');
  });

  it('routes hashtag links into post search and stops aggregate writes', async () => {
    const [components, db, main] = await Promise.all([
      source('src/components.ts'),
      source('src/db.ts'),
      source('src/main.ts'),
    ]);
    expect(components).toContain('tab=posts');
    expect(components).toContain('encodeURIComponent(`#${tag}`)');
    expect(db).not.toContain('updateHashtagAggregate');
    expect(db).not.toContain('getTrendingHashtags');
    expect(main).toContain("registerRoute('/explore/:tag'");
  });
});
