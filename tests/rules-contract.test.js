import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ACTIVE_NOTIFICATION_TYPES, LEGACY_NOTIFICATION_TYPES } from '../functions/lib/notification-domain.js';

describe('server-only search and retirement rules contract', () => {
  it('contains explicit server-only search index protection and DM phase-A write denial', async () => {
    const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
    expect(rules).toContain('match /postSearchIndex/{postId}');
    expect(rules).toContain('allow read, write: if false;');
    expect(rules).toContain('function hasSafePostText()');
    expect(rules).toContain('function preservesLegacyLongPostText()');
    expect(rules).toContain('function isCommentContentUpdate()');
    expect(rules).toContain("affectedKeys().hasOnly(['text', 'mentions', 'editedAt'])");
    expect(rules).toContain("request.resource.data.text.size() <= 500");
    expect(rules).toContain('allow update: if isCommentContentUpdate() || isCommentLikeMetricUpdate();');
    expect(rules).toContain('function isActiveNotificationType(type)');
    expect(rules).toContain("'story_reaction'");
    expect(rules).toContain('match /conversations/{convId}');
    expect(rules).toContain('allow create, update: if false;');
    expect(rules).toContain('allow delete: if false;');
    expect(rules).toContain('match /conversations/{convId}/messages/{msgId}');
    expect(rules).toContain('allow create, update: if false;');
    expect(rules).toContain('allow delete: if false;');
    expect(rules).not.toContain('match /{document=**}');

    for (const type of ACTIVE_NOTIFICATION_TYPES) {
      expect(rules).toContain(`'${type}'`);
    }
    for (const type of LEGACY_NOTIFICATION_TYPES) {
      expect(rules).not.toMatch(new RegExp(`isActiveNotificationType\\(type\\)[\\s\\S]{0,120}'${type}'`));
    }
  });

  it('does not leave a recursive storage fallback that can bypass DM write denial', async () => {
    const rules = await readFile(new URL('../storage.rules', import.meta.url), 'utf8');
    expect(rules).toContain('match /dm/{userId}/{allPaths=**}');
    expect(rules).toContain('allow write: if false;');
    expect(rules).not.toContain('match /{allPaths=**}');
  });
});
