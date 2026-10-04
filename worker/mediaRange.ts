export type MediaByteRange = { offset: number; length?: number } | { suffix: number };

export type ResolvedMediaByteRange = {
  start: number;
  end: number;
  length: number;
};

/** Parse the single byte range requested by browsers for media playback. */
export function parseMediaByteRange(value: string | null): MediaByteRange | null {
  if (!value) return null;
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : null;
  }

  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  if (!match[2]) return { offset };

  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

export function resolveMediaByteRange(range: MediaByteRange, size: number): ResolvedMediaByteRange | null {
  if (!Number.isSafeInteger(size) || size < 0) return null;
  const start = 'suffix' in range ? Math.max(0, size - range.suffix) : range.offset;
  const requestedLength = 'suffix' in range ? Math.min(range.suffix, size) : range.length ?? (size - start);
  if (requestedLength <= 0 || start >= size) return null;
  const end = Math.min(size - 1, start + requestedLength - 1);
  if (end < start) return null;
  return { start, end, length: end - start + 1 };
}
