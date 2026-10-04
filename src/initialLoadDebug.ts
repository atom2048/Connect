/**
 * Slow-start observation helper. It is intentionally opt-in and DEV-only so
 * no artificial wait is present in a production build or normal development.
 * The wait surrounds real work; it never changes or advances progress.
 */
const debugValue = (() => {
  if (!import.meta.env.DEV || typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('debugInitialLoad') || '';
})();

export const initialLoadDebugEnabled = debugValue === '1' || debugValue === 'true' || debugValue === 'slow';
export const initialLoadSlowDebugEnabled = debugValue === 'slow';

export function waitForInitialLoadDebugStep(): Promise<void> {
  if (!initialLoadSlowDebugEnabled) return Promise.resolve();
  return new Promise(resolve => window.setTimeout(resolve, 180));
}
