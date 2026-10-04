import { describe, expect, it } from 'vitest';
import { isBackdropDismiss } from '../src/modalInteractions';

describe('image modal backdrop', () => {
  it('dismisses only a direct backdrop interaction', () => {
    const backdrop = {} as EventTarget;
    const image = {} as EventTarget;
    expect(isBackdropDismiss(backdrop, backdrop)).toBe(true);
    expect(isBackdropDismiss(image, backdrop)).toBe(false);
    expect(isBackdropDismiss(null, backdrop)).toBe(false);
  });
});
