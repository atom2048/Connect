import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const { syncFirebaseProfileContext } = await import('../worker/index');

function profileEnv(writes: unknown[][]): Env {
  return {
    FIREBASE_PROJECT_ID: 'synthetic-project',
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('SELECT 1 AS blocked FROM blocks')) return null;
                if (sql.includes('SELECT text_analysis,media_analysis FROM ai_author_preferences')) {
                  return { text_analysis: 'PUBLIC_ONLY', media_analysis: 'PUBLIC_ONLY' };
                }
                if (sql.includes('SELECT display_name,username,bio,avatar_color')) {
                  return { display_name: 'Old synthetic name', username: 'old-synthetic', bio: 'stale private bio', avatar_color: '#123456', created_at: 1, updated_at: 1 };
                }
                return null;
              },
              async run() {
                writes.push(values);
                return { success: true };
              },
              async all() { return { results: [] }; },
            };
          },
        };
      },
    } as unknown as Env['DB'],
  } as unknown as Env;
}

const input = { viewerId: 'synthetic-viewer', profileId: 'synthetic-profile', contextPostIds: [], requestId: 'synthetic-correlation-id' };

afterEach(() => vi.restoreAllMocks());

describe('Firestore profile source verification', () => {
  it('clears stale D1 bio when the verified source omits it', async () => {
    const writes: unknown[][] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      name: 'projects/synthetic-project/databases/(default)/documents/users/synthetic-profile',
      createTime: '2026-09-01T00:00:00Z',
      updateTime: '2026-09-23T00:00:00.123456789Z',
      fields: { displayName: { stringValue: 'Current synthetic name' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await syncFirebaseProfileContext(new Request('https://worker.example.invalid'), profileEnv(writes), input);

    expect(result).toMatchObject({ profileSynced: true, profileVerified: true, profileDenied: false, sourceUnavailable: false });
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe('Current synthetic name');
    expect(writes[0][3]).toBe('');
  });

  it.each([
    { status: 403, profileDenied: true, sourceUnavailable: false },
    { status: 404, profileDenied: true, sourceUnavailable: false },
    { status: 503, profileDenied: false, sourceUnavailable: true },
  ])('does not validate or fall back to D1 when Firestore returns $status', async ({ status, profileDenied, sourceUnavailable }) => {
    const writes: unknown[][] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));

    const result = await syncFirebaseProfileContext(new Request('https://worker.example.invalid'), profileEnv(writes), input);

    expect(result).toMatchObject({ profileSynced: false, profileVerified: false, profileDenied, sourceUnavailable });
    expect(writes).toHaveLength(0);
  });

  it('fails closed when the profile source request times out or rejects', async () => {
    const writes: unknown[][] = [];
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('synthetic network failure'));

    const result = await syncFirebaseProfileContext(new Request('https://worker.example.invalid'), profileEnv(writes), input);

    expect(result).toMatchObject({ profileVerified: false, sourceUnavailable: true });
    expect(writes).toHaveLength(0);
  });
});
