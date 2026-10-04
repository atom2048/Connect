import { describe, expect, it } from 'vitest';
import { calculateBottomNavigationContentInset } from '../src/bottomNavigation';

describe('fixed bottom navigation content inset', () => {
  it('reserves measured bar height, safe-area offset, and a tap-safe gap', () => {
    expect(calculateBottomNavigationContentInset({ height: 68, bottom: 766 }, 800)).toBe(126);
  });

  it('uses the measured height when the bar reaches the viewport edge', () => {
    expect(calculateBottomNavigationContentInset({ height: 102, bottom: 800 }, 800)).toBe(126);
  });

  it('adds no padding when navigation is absent and clamps invalid negative space', () => {
    expect(calculateBottomNavigationContentInset(null, 800)).toBe(0);
    expect(calculateBottomNavigationContentInset({ height: -4, bottom: 820 }, 800, -1)).toBe(0);
  });
});
