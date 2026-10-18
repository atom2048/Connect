import { describe, expect, it } from 'vitest';
import {
  safeBrowserFailureReason,
  safeMediaFailureEvidence,
  safeMediaResponseEvidence,
} from '../scripts/media-proof-redaction.mjs';

describe('production media evidence redaction', () => {
  it('classifies media routes without retaining account, post, or object identifiers', () => {
    const paths = [
      '/media/migration/legacy/private-account/private-object?token=secret',
      '/media/posts/private-account/private-post-image.webp',
      '/api/profiles/private-account',
      '/api/posts/private-post',
    ];
    const evidence = paths.map(path => safeMediaResponseEvidence({ status: 200, method: 'GET', path }));

    expect(evidence.map(item => item.route)).toEqual([
      'media:legacy-migration',
      'media:post',
      'api:profile',
      'api:post',
    ]);
    expect(JSON.stringify(evidence)).not.toContain('private-account');
    expect(JSON.stringify(evidence)).not.toContain('private-object');
    expect(JSON.stringify(evidence)).not.toContain('secret');
  });

  it('keeps only a safe browser network error code', () => {
    const evidence = safeMediaFailureEvidence({
      method: 'GET',
      path: '/media/posts/private-account/private-video.mp4?ticket=secret',
      error: 'net::ERR_CONNECTION_RESET https://sns-app.example/media/posts/private-account/private-video.mp4?ticket=secret',
    });

    expect(evidence).toEqual({ route: 'media:post', method: 'GET', errorCode: 'ERR_CONNECTION_RESET' });
    expect(JSON.stringify(evidence)).not.toContain('private-account');
    expect(JSON.stringify(evidence)).not.toContain('secret');
  });

  it('retains a safe network error code while dropping URLs from browser failures', () => {
    const error = new Error('page.goto: net::ERR_CONNECTION_RESET at https://sns-app.example/media/posts/private-account/private-video.mp4');
    const reason = safeBrowserFailureReason(error);

    expect(reason).toBe('Error:ERR_CONNECTION_RESET');
    expect(reason).not.toContain('private-account');
    expect(reason).not.toContain('private-video.mp4');
  });
});

