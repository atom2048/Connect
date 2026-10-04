import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeElement = {
  children: unknown[];
  attributes: Record<string, string>;
  replaceChildren: (...children: unknown[]) => void;
  setAttribute: (name: string, value: string) => void;
  append: (...children: unknown[]) => void;
};

function installRouterEnvironment(initialHash: string) {
  const listeners = new Map<string, Array<() => void>>();
  const location = { hash: initialHash };
  const page: FakeElement = {
    children: [],
    attributes: {},
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
  };
  const fakeDocument = {
    getElementById(id: string) { return id === 'page-content' ? page : null; },
    createElement() {
      return {
        className: '',
        attributes: {} as Record<string, string>,
        textContent: '',
        setAttribute(name: string, value: string) { this.attributes[name] = value; },
      };
    },
  };
  const fakeWindow = {
    location,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
  };
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', fakeDocument);
  return {
    page,
    navigate(hash: string) {
      location.hash = hash;
      for (const listener of listeners.get('hashchange') || []) listener();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('router route lifecycle', () => {
  it('disposes a route cleanup returned after that route has been replaced', async () => {
    const { page, navigate } = installRouterEnvironment('#/slow');
    vi.resetModules();
    const router = await import('../src/router');
    let finishSlowRoute!: (cleanup: () => void) => void;
    const slowCleanup = vi.fn();

    router.registerRoute('/slow', () => {
      page.append('slow route content');
      return new Promise(resolve => { finishSlowRoute = resolve; });
    });
    router.registerRoute('/next', () => {
      expect(page.children).not.toContain('slow route content');
      page.append('next route content');
    });

    const initialRoute = router.initRouter();
    navigate('#/next');
    await Promise.resolve();
    await Promise.resolve();
    finishSlowRoute(slowCleanup);
    await initialRoute;

    expect(slowCleanup).toHaveBeenCalledOnce();
    expect(page.children).toContain('next route content');
  });
});
