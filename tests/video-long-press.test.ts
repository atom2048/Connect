import { describe, expect, it } from 'vitest';
import {
  activateVideoLongPress,
  beginVideoLongPress,
  cancelVideoLongPressIfMoved,
  createVideoLongPressState,
  finishVideoLongPress,
  shouldSuppressVideoClick,
} from '../src/videoLongPress';

describe('video long-press state machine', () => {
  it('resumes a video that was playing and consumes the synthetic click', () => {
    const state = createVideoLongPressState();
    beginVideoLongPress(state, 7, 10, 20, true);
    expect(activateVideoLongPress(state)).toBe(true);
    expect(finishVideoLongPress(state, 7, 1000)).toEqual({ consumed: true, shouldResume: true });
    expect(shouldSuppressVideoClick(state, 1500)).toBe(true);
    expect(shouldSuppressVideoClick(state, 1700)).toBe(false);
  });

  it('does not start playback when the video was paused before the hold', () => {
    const state = createVideoLongPressState();
    beginVideoLongPress(state, 3, 0, 0, false);
    activateVideoLongPress(state);
    expect(finishVideoLongPress(state, 3, 100)).toEqual({ consumed: true, shouldResume: false });
  });

  it('treats scrolling movement and a different pointer as non-hold gestures', () => {
    const state = createVideoLongPressState();
    beginVideoLongPress(state, 2, 0, 0, true);
    expect(cancelVideoLongPressIfMoved(state, 2, 20, 0)).toBe(true);
    expect(activateVideoLongPress(state)).toBe(false);
    expect(finishVideoLongPress(state, 9, 100)).toEqual({ consumed: false, shouldResume: false });
  });
});
