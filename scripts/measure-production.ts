import { writeFile } from 'node:fs/promises';

type Sample = { ttfbMs: number; totalMs: number; bytes: number; status: number };
const baseUrl = (process.env.CONNECT_BASE_URL || '').replace(/\/$/, '');
if (!baseUrl) throw new Error('CONNECT_BASE_URL is required');
const authHeaders: Record<string, string> = {};
const samples = async (path: string, count = 8): Promise<Sample[]> => {
  const values: Sample[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = performance.now();
    const response = await fetch(`${baseUrl}${path}`, { cache: 'no-store', headers: authHeaders });
    const ttfbMs = performance.now() - start;
    const buffer = await response.arrayBuffer();
    values.push({ ttfbMs: Number(ttfbMs.toFixed(1)), totalMs: Number((performance.now() - start).toFixed(1)), bytes: buffer.byteLength, status: response.status });
  }
  return values;
};
const summarize = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0; return { p50: Number(at(.5).toFixed(1)), p95: Number(at(.95).toFixed(1)), min: Number((sorted[0] || 0).toFixed(1)), max: Number((sorted.at(-1) || 0).toFixed(1)) }; };
const html = await samples('/');
const health = await samples('/api/health');
const feed = await samples('/api/feed?mode=recommended');
const search = await samples('/api/search?query=connect&tab=all');
const assets = [...new Set((await (await fetch(`${baseUrl}/`, { headers: authHeaders })).text()).matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^" ]*)?)"/g))].map((match) => match[1]).filter((value) => value.startsWith('/'));
const assetBytes: Record<string, number> = {};
for (const asset of assets) { const response = await fetch(`${baseUrl}${asset}`, { headers: authHeaders }); assetBytes[asset] = (await response.arrayBuffer()).byteLength; }
const result = { capturedAt: new Date().toISOString(), baseUrl, html: { ttfb: summarize(html.map((item) => item.ttfbMs)), total: summarize(html.map((item) => item.totalMs)), bytes: html[0]?.bytes || 0 }, api: { health: { ttfb: summarize(health.map((item) => item.ttfbMs)), total: summarize(health.map((item) => item.totalMs)), statuses: health.map((item) => item.status) }, feed: { ttfb: summarize(feed.map((item) => item.ttfbMs)), total: summarize(feed.map((item) => item.totalMs)), bytes: feed[0]?.bytes || 0 }, search: { ttfb: summarize(search.map((item) => item.ttfbMs)), total: summarize(search.map((item) => item.totalMs)), bytes: search[0]?.bytes || 0 } }, assets: assetBytes, javascriptBytes: Object.entries(assetBytes).filter(([name]) => name.endsWith('.js')).reduce((sum, [, bytes]) => sum + bytes, 0), cssBytes: Object.entries(assetBytes).filter(([name]) => name.endsWith('.css')).reduce((sum, [, bytes]) => sum + bytes, 0), note: 'LCP/INP/CLS/image transfer are collected by the /?metrics=1 browser panel.' };
const outputPath = process.env.PERFORMANCE_OUTPUT_PATH || `docs/performance-after-${new Date().toISOString().slice(0, 10)}.json`;
await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ outputPath, result }));
