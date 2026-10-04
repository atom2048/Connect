export type StartupTraceResult = 'start' | 'success' | 'error' | 'retry' | 'skipped' | 'cancelled';

export type StartupTraceEvent = {
  sessionId: string;
  phase: string;
  elapsedMs: number;
  result: StartupTraceResult;
  durationMs?: number;
  endpointCategory?: string;
  httpStatus?: number;
  retryCount?: number;
  delayMs?: number;
  errorType?: string;
};

type StartupTraceFields = Omit<Partial<StartupTraceEvent>, 'sessionId' | 'phase' | 'elapsedMs' | 'result'>;

type StartupTraceWindow = Window & {
  __connectStartupTrace?: StartupTraceEvent[];
  __connectStartupTraceSessionId?: string;
};

let sessionCounter = 0;
let activeSession: StartupTraceSession | null = null;

function traceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeEndpointCategory(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return /^[a-z0-9:_-]+$/i.test(value) ? value.slice(0, 80) : 'unknown';
}

function safeErrorType(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return /^[a-z0-9:_-]+$/i.test(value) ? value.slice(0, 80) : 'unknown';
}

function readTraceOptIn(): boolean {
  if (import.meta.env.DEV || String(import.meta.env.VITE_STARTUP_TRACE || '') === '1') return true;
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('startupTrace') === '1' || window.localStorage.getItem('CONNECT_STARTUP_TRACE') === '1';
  } catch {
    return false;
  }
}

export function startupTraceEnabled(): boolean {
  return readTraceOptIn();
}

export class StartupTraceSession {
  readonly id: string;
  readonly startedAt: number;
  readonly enabled: boolean;
  private readonly now: () => number;

  constructor(options: { now?: () => number; enabled?: boolean } = {}) {
    this.id = `startup-${++sessionCounter}`;
    this.startedAt = (options.now || traceNow)();
    this.now = options.now || traceNow;
    this.enabled = options.enabled ?? readTraceOptIn();
  }

  event(phase: string, result: StartupTraceResult, fields: StartupTraceFields = {}): StartupTraceEvent | null {
    if (!this.enabled) return null;
    const elapsedMs = Math.max(0, Math.round(this.now() - this.startedAt));
    const durationMs = finiteNumber(fields.durationMs);
    const httpStatus = finiteNumber(fields.httpStatus);
    const retryCount = finiteNumber(fields.retryCount);
    const delayMs = finiteNumber(fields.delayMs);
    const event: StartupTraceEvent = {
      sessionId: this.id,
      phase: typeof phase === 'string' && phase ? phase.slice(0, 100) : 'unknown',
      elapsedMs,
      result,
      ...(durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(durationMs)) }),
      ...(safeEndpointCategory(fields.endpointCategory) ? { endpointCategory: safeEndpointCategory(fields.endpointCategory) } : {}),
      ...(httpStatus === undefined ? {} : { httpStatus: Math.round(httpStatus) }),
      ...(retryCount === undefined ? {} : { retryCount: Math.max(0, Math.floor(retryCount)) }),
      ...(delayMs === undefined ? {} : { delayMs: Math.max(0, Math.round(delayMs)) }),
      ...(safeErrorType(fields.errorType) ? { errorType: safeErrorType(fields.errorType) } : {}),
    };

    if (typeof window !== 'undefined') {
      const target = window as StartupTraceWindow;
      const trace = target.__connectStartupTrace || (target.__connectStartupTrace = []);
      trace.push(event);
      if (trace.length > 300) trace.splice(0, trace.length - 300);
      target.__connectStartupTraceSessionId = this.id;
    }
    console.debug('[ConnectStartup]', event);
    return event;
  }

  begin(phase: string, fields: StartupTraceFields = {}): (result: StartupTraceResult, endFields?: StartupTraceFields) => StartupTraceEvent | null {
    const startedAt = this.now();
    this.event(phase, 'start', fields);
    return (result: StartupTraceResult, endFields: StartupTraceFields = {}) => this.event(phase, result, {
      ...fields,
      ...endFields,
      durationMs: Math.max(0, this.now() - startedAt),
    });
  }
}

export function startStartupTraceSession(options: { now?: () => number; enabled?: boolean } = {}): StartupTraceSession {
  const session = new StartupTraceSession(options);
  activeSession = session;
  return session;
}

export function getActiveStartupTraceSession(): StartupTraceSession | null {
  return activeSession;
}

export function clearStartupTraceSession(session?: StartupTraceSession): void {
  if (!session || activeSession === session) activeSession = null;
}
