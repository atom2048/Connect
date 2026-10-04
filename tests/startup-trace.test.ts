import { describe, expect, it } from 'vitest';
import { StartupTraceSession } from '../src/startupTrace';

describe('startup trace', () => {
  it('records safe phase, timing, endpoint, retry, and error classification fields', () => {
    let now = 100;
    const trace = new StartupTraceSession({ enabled: true, now: () => now });
    const finish = trace.begin('feed-request', { endpointCategory: 'firestore-feed' });
    now = 275;
    const event = finish('error', { httpStatus: 503, retryCount: 1, errorType: 'server', delayMs: 180 });

    expect(event).toMatchObject({
      sessionId: trace.id,
      phase: 'feed-request',
      elapsedMs: 175,
      durationMs: 175,
      result: 'error',
      endpointCategory: 'firestore-feed',
      httpStatus: 503,
      retryCount: 1,
      delayMs: 180,
      errorType: 'server',
    });
  });
});
