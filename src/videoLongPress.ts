export type VideoLongPressState = {
  phase: 'idle' | 'pending' | 'active';
  pointerId: number | null;
  startX: number;
  startY: number;
  wasPlaying: boolean;
  suppressClickUntil: number;
};

export function createVideoLongPressState(): VideoLongPressState {
  return { phase: 'idle', pointerId: null, startX: 0, startY: 0, wasPlaying: false, suppressClickUntil: 0 };
}

export function beginVideoLongPress(state: VideoLongPressState, pointerId: number, x: number, y: number, wasPlaying: boolean): void {
  state.phase = 'pending';
  state.pointerId = pointerId;
  state.startX = x;
  state.startY = y;
  state.wasPlaying = wasPlaying;
}

export function cancelVideoLongPressIfMoved(state: VideoLongPressState, pointerId: number, x: number, y: number, threshold = 12): boolean {
  if (state.phase !== 'pending' || state.pointerId !== pointerId) return false;
  if (Math.hypot(x - state.startX, y - state.startY) <= threshold) return false;
  state.phase = 'idle';
  state.pointerId = null;
  return true;
}

export function activateVideoLongPress(state: VideoLongPressState): boolean {
  if (state.phase !== 'pending') return false;
  state.phase = 'active';
  return true;
}

export function finishVideoLongPress(state: VideoLongPressState, pointerId: number, now: number): { consumed: boolean; shouldResume: boolean } {
  if (state.pointerId !== pointerId) return { consumed: false, shouldResume: false };
  const consumed = state.phase === 'active';
  const shouldResume = consumed && state.wasPlaying;
  state.phase = 'idle';
  state.pointerId = null;
  state.suppressClickUntil = consumed ? now + 600 : state.suppressClickUntil;
  return { consumed, shouldResume };
}

export function shouldSuppressVideoClick(state: VideoLongPressState, now: number): boolean {
  return now <= state.suppressClickUntil;
}

const boundVideos = new WeakSet<HTMLVideoElement>();

export function bindVideoLongPress(video: HTMLVideoElement, holdDelay = 420): void {
  if (boundVideos.has(video)) return;
  boundVideos.add(video);
  const state = createVideoLongPressState();
  let timer: number | null = null;

  const clearTimer = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  video.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || video.ended) return;
    clearTimer();
    beginVideoLongPress(state, event.pointerId, event.clientX, event.clientY, !video.paused && !video.ended);
    timer = window.setTimeout(() => {
      timer = null;
      if (!activateVideoLongPress(state)) return;
      video.playbackRate = 2;
      video.parentElement?.classList.add('is-long-press-speed');
      try { video.setPointerCapture(event.pointerId); } catch { /* Pointer capture is best-effort. */ }
      if (state.wasPlaying && video.paused && !video.ended) video.play().catch((): void => {});
    }, holdDelay);
  }, { passive: true });

  video.addEventListener('pointermove', event => {
    if (cancelVideoLongPressIfMoved(state, event.pointerId, event.clientX, event.clientY)) clearTimer();
  }, { passive: true });

  const finish = (event: PointerEvent): void => {
    clearTimer();
    const result = finishVideoLongPress(state, event.pointerId, performance.now());
    if (!result.consumed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    video.playbackRate = 1;
    video.parentElement?.classList.remove('is-long-press-speed');
    try { if (video.hasPointerCapture(event.pointerId)) video.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
    const inViewport = video.dataset.connectInViewport !== 'false';
    if (result.shouldResume && inViewport && !video.ended) video.play().catch((): void => {});
  };

  video.addEventListener('pointerup', finish, { passive: false });
  video.addEventListener('pointercancel', finish, { passive: false });
  video.addEventListener('click', event => {
    if (!shouldSuppressVideoClick(state, performance.now())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  video.addEventListener('contextmenu', event => {
    if (state.phase === 'pending' || state.phase === 'active') event.preventDefault();
  });
}
