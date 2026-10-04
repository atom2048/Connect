export type BottomNavigationRect = Pick<DOMRectReadOnly, 'height' | 'bottom'>;

/** Reserve the measured fixed navigation height, viewport inset, and a tap-safe gap. */
export function calculateBottomNavigationContentInset(
  rect: BottomNavigationRect | null,
  viewportHeight: number,
  gap = 24,
): number {
  if (!rect) return 0;
  const height = Math.max(0, rect.height);
  const bottomOffset = Math.max(0, viewportHeight - rect.bottom);
  return Math.ceil(height + bottomOffset + Math.max(0, gap));
}
