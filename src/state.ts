import type { AppState } from './types/domain';

type StateKey = keyof AppState;
type StateListener<K extends StateKey> = (value: AppState[K], oldValue: AppState[K]) => void;
type ListenerMap = { [K in StateKey]?: Array<StateListener<K>> };

function storedManualTheme(): AppState['theme'] | null {
  try {
    const stored = localStorage.getItem('connect-theme') || localStorage.getItem('theme');
    return stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    return null;
  }
}

function systemTheme(): AppState['theme'] {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const initialTheme = storedManualTheme() || systemTheme();

const state: AppState = {
  user: null,
  userProfile: null,
  currentPage: 'feed',
  theme: initialTheme,
  unreadNotifications: 0,
  loading: false,
};

const listeners: ListenerMap = {};

export function setState<K extends StateKey>(key: K, value: AppState[K]): void {
  const oldValue = state[key];
  state[key] = value;
  const keyListeners = listeners[key] as Array<StateListener<K>> | undefined;
  keyListeners?.forEach(cb => cb(value, oldValue));
}

export function getState<K extends StateKey>(key: K): AppState[K] {
  return state[key];
}

export function onStateChange<K extends StateKey>(key: K, callback: StateListener<K>): () => void {
  const keyListeners = (listeners[key] ??= []) as Array<StateListener<K>>;
  keyListeners.push(callback);
  return () => {
    const current = (listeners[key] ?? []) as Array<StateListener<K>>;
    listeners[key] = current.filter(cb => cb !== callback) as ListenerMap[K];
  };
}

export function toggleTheme(): void {
  const newTheme: AppState['theme'] = state.theme === 'light' ? 'dark' : 'light';
  setState('theme', newTheme);
  localStorage.setItem('connect-theme', newTheme);
  localStorage.removeItem('theme');
  applyTheme(newTheme);
}

export function applyTheme(theme: AppState['theme'] = state.theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

applyTheme(state.theme);

const systemThemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)');
if (systemThemeMedia) {
  const updateSystemTheme = () => {
    if (storedManualTheme()) return;
    const next = systemTheme();
    if (state.theme !== next) {
      setState('theme', next);
      applyTheme(next);
    }
  };
  if (systemThemeMedia.addEventListener) systemThemeMedia.addEventListener('change', updateSystemTheme);
  else systemThemeMedia.addListener?.(updateSystemTheme);
}
