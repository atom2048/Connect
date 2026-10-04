export type StartupErrorKind = 'abort' | 'timeout' | 'network' | 'rate_limit' | 'server' | 'auth' | 'http' | 'application';

export type StartupErrorInfo = {
  kind: StartupErrorKind;
  httpStatus?: number;
  code?: string;
  retryAfterMs?: number;
};

export type RetryNotice = {
  error: unknown;
  info: StartupErrorInfo;
  attempt: number;
  retryCount: number;
  delayMs: number;
};

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown, info: StartupErrorInfo, attempt: number) => boolean;
  onRetry?: (notice: RetryNotice) => void;
};

const inFlightRequests = new Map<string, Promise<unknown>>();

type ErrorLike = {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  retryAfterMs?: unknown;
  retryAfter?: unknown;
};

function errorLike(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? error as ErrorLike : {};
}

function numericStatus(error: ErrorLike): number | undefined {
  const value = Number(error.status ?? error.statusCode);
  return Number.isFinite(value) && value >= 100 && value <= 599 ? value : undefined;
}

function numericRetryAfter(error: ErrorLike): number | undefined {
  const value = Number(error.retryAfterMs ?? error.retryAfter);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function abortError(): Error {
  const error = new Error('Startup request was aborted');
  error.name = 'AbortError';
  return error;
}

export function classifyStartupError(error: unknown): StartupErrorInfo {
  const candidate = errorLike(error);
  const code = String(candidate.code ?? candidate.name ?? '').toLowerCase();
  const message = String(candidate.message ?? error ?? '').toLowerCase();
  const httpStatus = numericStatus(candidate);
  const retryAfterMs = numericRetryAfter(candidate);

  if (code.includes('abort') || message.includes('aborted') || message.includes('cancelled')) {
    return { kind: 'abort', ...(httpStatus === undefined ? {} : { httpStatus }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }), code };
  }
  if (code.includes('timeout') || message.includes('timeout') || code.includes('deadline-exceeded')) {
    return { kind: 'timeout', ...(httpStatus === undefined ? {} : { httpStatus }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }), code };
  }
  if (httpStatus === 401 || httpStatus === 403 || code.includes('permission-denied') || code.includes('unauthenticated') || code.includes('auth/invalid')) {
    return { kind: 'auth', httpStatus, code };
  }
  if (httpStatus === 429 || code.includes('resource-exhausted') || code.includes('rate-limit') || code.includes('too-many')) {
    return { kind: 'rate_limit', ...(httpStatus === undefined ? {} : { httpStatus }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }), code };
  }
  if ((httpStatus !== undefined && httpStatus >= 500) || code.includes('unavailable') || code.includes('internal')) {
    return { kind: 'server', ...(httpStatus === undefined ? {} : { httpStatus }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }), code };
  }
  if (httpStatus === 408 || httpStatus === 425 || code.includes('network') || code.includes('failed to fetch') || code.includes('offline') || code.includes('connection')) {
    return { kind: 'network', ...(httpStatus === undefined ? {} : { httpStatus }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }), code };
  }
  if (httpStatus !== undefined && httpStatus >= 400) return { kind: 'http', httpStatus, code };
  return { kind: 'application', ...(httpStatus === undefined ? {} : { httpStatus }), code };
}

export function isRetryableStartupError(error: unknown, info = classifyStartupError(error)): boolean {
  return info.kind === 'network' || info.kind === 'timeout' || info.kind === 'rate_limit' || info.kind === 'server';
}

async function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export async function retryWithBackoff<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 180));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? 1200));
  const random = options.random || Math.random;
  const sleep = options.sleep || defaultSleep;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    assertNotAborted(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      const info = classifyStartupError(error);
      const retryCount = attempt + 1;
      const shouldRetry = options.shouldRetry
        ? options.shouldRetry(error, info, attempt)
        : isRetryableStartupError(error, info);
      if (!shouldRetry || retryCount >= maxAttempts) throw error;

      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      const jitter = exponential * 0.25 * ((Math.max(0, Math.min(1, random())) * 2) - 1);
      const delayMs = Math.max(0, Math.round(info.retryAfterMs ?? exponential + jitter));
      options.onRetry?.({ error, info, attempt, retryCount, delayMs });
      await sleep(delayMs, options.signal);
    }
  }
  throw new Error('Startup retry loop exhausted');
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  const safeTimeout = Math.max(1, Math.floor(timeoutMs));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    const timer = setTimeout(() => {
      const error = new Error(`Startup request timed out after ${safeTimeout}ms`);
      error.name = 'TimeoutError';
      (error as ErrorLike).code = 'timeout';
      finish(() => reject(error));
    }, safeTimeout);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

/**
 * Shares one idempotent request while it is in flight. The entry is removed
 * on either outcome, so a later navigation or retry always gets a fresh read.
 */
export function singleFlight<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) return existing as Promise<T>;
  const request = Promise.resolve().then(operation);
  inFlightRequests.set(key, request);
  void request.finally(() => {
    if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
  }).catch(() => { /* The caller owns the original request result. */ });
  return request;
}
