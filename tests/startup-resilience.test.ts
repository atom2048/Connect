import { describe, expect, it } from 'vitest';
import { classifyStartupError, isRetryableStartupError, retryWithBackoff, singleFlight, withTimeout } from '../src/startupResilience';

describe('startup resilience', () => {
  it('retries a transient first failure and succeeds without user interaction', async () => {
    let calls = 0;
    const delays: number[] = [];
    const value = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('temporary outage'), { code: 'unavailable' });
        return 'feed-ready';
      },
      { random: () => 0.5, sleep: async delay => { delays.push(delay); } },
    );

    expect(value).toBe('feed-ready');
    expect(calls).toBe(2);
    expect(delays).toEqual([180]);
  });

  it('does not retry authentication or permanent client errors', async () => {
    expect(isRetryableStartupError({ status: 401 })).toBe(false);
    expect(isRetryableStartupError({ status: 403 })).toBe(false);
    expect(isRetryableStartupError({ status: 422 })).toBe(false);
    await expect(retryWithBackoff(async () => { throw Object.assign(new Error('denied'), { status: 403 }); }, { sleep: async () => { throw new Error('should not sleep'); } })).rejects.toMatchObject({ status: 403 });
  });

  it('honors Retry-After metadata for a rate limit', async () => {
    const info = classifyStartupError({ status: 429, retryAfterMs: 750 });
    expect(info).toMatchObject({ kind: 'rate_limit', httpStatus: 429, retryAfterMs: 750 });
    const delays: number[] = [];
    await retryWithBackoff(
      async () => { throw Object.assign(new Error('busy'), { status: 429, retryAfterMs: 750 }); },
      { maxAttempts: 2, sleep: async delay => { delays.push(delay); } },
    ).catch(() => undefined);
    expect(delays).toEqual([750]);
  });

  it('stops a pending retry when navigation aborts the session', async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = retryWithBackoff(
      async () => {
        calls += 1;
        throw Object.assign(new Error('offline'), { code: 'network-request-failed' });
      },
      {
        signal: controller.signal,
        sleep: async (_delay, signal) => {
          controller.abort();
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      },
    );
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('classifies a timeout wrapper without exposing request contents', async () => {
    await expect(withTimeout(new Promise(() => undefined), 1)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(classifyStartupError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toMatchObject({ kind: 'timeout' });
  });

  it('shares a concurrent idempotent request instead of issuing a duplicate', async () => {
    let calls = 0;
    let resolveRequest!: (value: string) => void;
    const pending = new Promise<string>(resolve => { resolveRequest = resolve; });
    const first = singleFlight('startup-resilience-test', async () => {
      calls += 1;
      return pending;
    });
    const second = singleFlight('startup-resilience-test', async () => {
      calls += 1;
      return 'duplicate';
    });
    resolveRequest('shared');
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
    expect(calls).toBe(1);
  });
});
