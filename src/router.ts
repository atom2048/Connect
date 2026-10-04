type RouteParams = Record<string, string>;
type RouteCleanup = void | (() => void);
export type RouteContext = { path: string; signal: AbortSignal };
type RouteHandler = (params: RouteParams, context?: RouteContext) => RouteCleanup | Promise<RouteCleanup>;
type InitRouterOptions = {
  throwInitialRouteError?: boolean;
  onRouteStart?: (path: string, context?: RouteContext) => void;
  onRouteResolved?: (path: string, context?: RouteContext) => void;
  onRouteComplete?: (path: string, context?: RouteContext) => void;
  onRouteAbort?: (path: string) => void;
  isActive?: () => boolean;
};

const routes: Record<string, RouteHandler> = {};
let currentCleanup: (() => void) | null = null;
let routeListenerBound = false;
let activeRouteHandler: (() => Promise<void>) | null = null;
let activeRoute: { controller: AbortController; path: string; onRouteAbort?: (path: string) => void } | null = null;
let latestRoutePromise: Promise<void> = Promise.resolve();

export function registerRoute(path: string, handler: RouteHandler): void {
  routes[path] = handler;
}

export function navigateTo(path: string): void {
  window.location.hash = path;
}

function getPath(): string {
  const hash = window.location.hash || '#/feed';
  return (hash.replace(/^#/, '') || '/feed').split('?')[0] || '/feed';
}

function routePatternToRegex(pattern: string): RegExp {
  if (pattern === '*') return /^.*$/;
  const parts = pattern.split('/').map(part => {
    if (part.startsWith(':')) {
      return `(?<${part.slice(1)}>[^/]+)`;
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}$`);
}

function renderRouteError(error: unknown): void {
  const candidate = error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown } | null;
  const code = String(candidate?.code || candidate?.name || '').toLowerCase();
  const status = Number(candidate?.status);
  const errorType = code.includes('auth') || status === 401 || status === 403
    ? 'auth'
    : code.includes('timeout')
      ? 'timeout'
      : status >= 500 || code.includes('unavailable')
        ? 'server'
        : code.includes('network') || code.includes('offline')
          ? 'network'
          : 'application';
  console.error('Route failed', { errorType, httpStatus: Number.isFinite(status) ? status : undefined });
  const page = document.getElementById('page-content');
  if (!page) return;
  const message = errorType === 'network'
    ? 'ネットワークに接続できませんでした。'
    : errorType === 'timeout'
      ? '読み込みがタイムアウトしました。'
      : errorType === 'auth'
        ? '認証状態を確認できませんでした。'
        : 'ページの読み込みに失敗しました。';
  page.setAttribute('aria-busy', 'false');
  page.innerHTML = `<div style="padding:20px;color:red;"><h3>エラー</h3><p>${message}</p></div>`;
}

function disposeRoute(cleanup: (() => void) | null | undefined): void {
  if (!cleanup) return;
  try {
    cleanup();
  } catch {
    // A teardown failure must not prevent the next route from mounting.
  }
}

export function initRouter(options: InitRouterOptions = {}): Promise<void> {
  let startRoute: (throwRouteError: boolean, redirectDepth: number, notifyPreviousAbort: boolean) => Promise<void>;
  const handleRoute = async (throwRouteError = false, redirectDepth = 0, notifyPreviousAbort = false): Promise<void> => {
    const previous = activeRoute;
    const path = getPath();
    if (previous) {
      previous.controller.abort();
      if (notifyPreviousAbort && previous.path !== path) previous.onRouteAbort?.(previous.path);
    }
    const controller = new AbortController();
    const context: RouteContext = { path, signal: controller.signal };
    activeRoute = { controller, path, onRouteAbort: options.onRouteAbort };
    const isCurrentRoute = (): boolean => activeRoute?.controller === controller && !controller.signal.aborted;
    if (options.isActive && !options.isActive()) return;
    options.onRouteStart?.(path, context);

    if (currentCleanup) {
      disposeRoute(currentCleanup);
      currentCleanup = null;
    }
    const page = document.getElementById('page-content');
    if (page) {
      page.replaceChildren();
      page.setAttribute('aria-busy', 'true');
      const loading = document.createElement('div');
      loading.className = 'route-loading';
      loading.setAttribute('role', 'status');
      loading.setAttribute('aria-live', 'polite');
      loading.textContent = '読み込み中…';
      page.append(loading);
    }

    let handler: RouteHandler | null = null;
    let params: RouteParams = {};

    for (const [pattern, routeHandler] of Object.entries(routes)) {
      const regex = routePatternToRegex(pattern);
      const match = path.match(regex);
      if (match) {
        handler = routeHandler;
        const rawParams = match.groups || {};
        params = Object.fromEntries(Object.entries(rawParams).map(([key, value]) => {
          try {
            return [key, decodeURIComponent(value)];
          } catch {
            return [key, value];
          }
        }));
        break;
      }
    }

    if (!handler) {
      if (page && isCurrentRoute()) page.setAttribute('aria-busy', 'false');
      options.onRouteComplete?.(path, context);
      return;
    }

    try {
      options.onRouteResolved?.(path, context);
      const cleanup = await handler(params, context);
      if (!isCurrentRoute() || (options.isActive && !options.isActive())) {
        // A route can finish after navigation or app unmount. Its view has
        // already been detached, so release any listeners/subscriptions it
        // created instead of leaking them into the next route.
        disposeRoute(typeof cleanup === 'function' ? cleanup : null);
        return;
      }
      if (typeof cleanup === 'function') currentCleanup = cleanup;
      page?.setAttribute('aria-busy', 'false');
      const redirectedPath = getPath();
      if (throwRouteError && redirectedPath !== path && redirectDepth < 4) {
        await startRoute(true, redirectDepth + 1, false);
      } else {
        options.onRouteComplete?.(path, context);
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      if (!isCurrentRoute()) return;
      renderRouteError(error);
      if (throwRouteError) throw error;
    }
  };

  startRoute = (throwRouteError, redirectDepth, notifyPreviousAbort): Promise<void> => {
    const promise = handleRoute(throwRouteError, redirectDepth, notifyPreviousAbort);
    latestRoutePromise = promise;
    return promise;
  };
  activeRouteHandler = () => startRoute(false, 0, true);
  if (!routeListenerBound) {
    routeListenerBound = true;
    window.addEventListener('hashchange', () => { void activeRouteHandler?.(); });
  }
  const initialPromise = startRoute(options.throwInitialRouteError === true, 0, false);
  return (async () => {
    let observedPromise = initialPromise;
    while (true) {
      await observedPromise;
      if (options.isActive && !options.isActive()) return;
      if (latestRoutePromise === observedPromise) return;
      observedPromise = latestRoutePromise;
    }
  })();
}
