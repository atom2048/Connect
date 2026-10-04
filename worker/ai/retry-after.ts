export function retryAfterSeconds(value: string | null, stamp = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(60, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(60, Math.ceil((date - stamp) / 1_000));
}
