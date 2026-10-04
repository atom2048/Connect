type Rum = { lcp: number | null; inp: number | null; cls: number; ttfb: number | null; jsBytes: number; imageBytes: number };

const state: Rum = { lcp: null, inp: null, cls: 0, ttfb: null, jsBytes: 0, imageBytes: 0 };
let clsValue = 0;

export function startRum() {
  if (typeof window === 'undefined') return;
  const paint = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const last = entries[entries.length - 1];
    if (last) state.lcp = Math.round(last.startTime);
  });
  try { paint.observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* browser without LCP */ }
  const layout = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) if (!entry.hadRecentInput) clsValue += entry.value || 0;
    state.cls = Number(clsValue.toFixed(3));
  });
  try { layout.observe({ type: 'layout-shift', buffered: true }); } catch { /* browser without CLS */ }
  const interaction = new PerformanceObserver((list) => {
    const entries = list.getEntries() as Array<PerformanceEntry & { duration: number }>;
    state.inp = Math.round(Math.max(state.inp || 0, ...entries.map((entry) => entry.duration)));
  });
  try { interaction.observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit); } catch { /* browser without INP */ }
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav) state.ttfb = Math.round(nav.responseStart);
  const refresh = () => {
    state.jsBytes = performance.getEntriesByType('resource').filter((entry) => entry.name.endsWith('.js')).reduce((sum, entry) => sum + ((entry as PerformanceResourceTiming).transferSize || 0), 0);
    state.imageBytes = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/media/') || /\.(avif|webp|png|jpe?g)(\?|$)/i.test(entry.name)).reduce((sum, entry) => sum + ((entry as PerformanceResourceTiming).transferSize || 0), 0);
  };
  window.setTimeout(refresh, 1500);
  window.addEventListener('load', refresh, { once: true });
  return () => { paint.disconnect(); layout.disconnect(); interaction.disconnect(); };
}

export function rumSnapshot(): Rum { return { ...state }; }
