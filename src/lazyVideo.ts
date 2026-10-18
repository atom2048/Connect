export type LazyVideoError = {
  postId: string;
  reason: string;
  mediaErrorCode?: number;
  source?: string;
};

export type LazyVideoLoaderOptions = {
  resolveURL: (postId: string, sourceURL: string) => Promise<string>;
  bindVideoLongPress?: (video: HTMLVideoElement) => void;
  onVideoError?: (error: LazyVideoError) => void;
  onSourceError?: (error: LazyVideoError) => void;
  onPlaybackError?: (error: LazyVideoError) => void;
};

/** Bind the app's delegated click handler for lazily loaded post and comment videos. */
export function bindLazyVideoLoader(root: Document, options: LazyVideoLoaderOptions): void {
  const appWindow = window as typeof window & { __connectLazyVideoBound?: boolean };
  if (appWindow.__connectLazyVideoBound) return;
  appWindow.__connectLazyVideoBound = true;
  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-action="load-video"]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.videoLoading === 'true') return;
    const player = button.closest<HTMLElement>('.post-video, .comment-video');
    const video = player?.querySelector<HTMLVideoElement>('video[data-src]');
    const sourceURL = button.dataset.videoSrc || video?.dataset.src || '';
    const postId = button.dataset.postId || player?.dataset.postId || video?.dataset.postId || '';
    if (!video || !sourceURL) return;
    button.dataset.videoLoading = 'true';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    void (async () => {
      const restoreButton = (label = '▶') => {
        if (!button.isConnected) return;
        button.textContent = label;
        button.hidden = false;
        button.disabled = false;
        delete button.dataset.videoLoading;
        button.removeAttribute('aria-busy');
      };
      let source = '';
      try {
        source = video.dataset.resolvedSrc || await options.resolveURL(postId, sourceURL);
        if (!video.isConnected) return;
        const resolvedSrc = new URL(source, window.location.origin).href;
        if (video.src !== resolvedSrc || video.dataset.mediaFailed === 'true') {
          video.dataset.mediaFailed = 'false';
          video.src = source;
          video.load();
        }
        if (video.dataset.videoErrorBound !== 'true') {
          video.dataset.videoErrorBound = 'true';
          video.addEventListener('error', () => {
            video.dataset.mediaFailed = 'true';
            const playerButton = player?.querySelector<HTMLButtonElement>('[data-action="load-video"]');
            if (playerButton) {
              playerButton.hidden = false;
              playerButton.disabled = false;
              playerButton.textContent = '↻';
              delete playerButton.dataset.videoLoading;
              playerButton.removeAttribute('aria-busy');
            }
            delete video.dataset.resolvedSrc;
            let sourcePath = 'unknown';
            try { const url = new URL(video.currentSrc); sourcePath = url.origin + url.pathname; } catch { /* Keep the redacted fallback. */ }
            options.onVideoError?.({ postId: postId || 'unknown', mediaErrorCode: video.error?.code || 0, source: sourcePath, reason: 'video_request_failed' });
          }, { once: true });
        }
        if (player) player.dataset.videoResolvedSrc = source;
        options.bindVideoLongPress?.(video);
        button.hidden = true;
      } catch (error) {
        options.onSourceError?.({ postId: postId || 'unknown', reason: error instanceof Error ? error.message : 'unknown' });
        restoreButton();
        return;
      }
      try {
        await video.play();
      } catch (error) {
        const name = error instanceof DOMException ? error.name : '';
        if (name === 'NotAllowedError' || name === 'AbortError') {
          restoreButton();
        } else if (!video.error) {
          options.onPlaybackError?.({ postId: postId || 'unknown', reason: name || 'unknown' });
          restoreButton('↻');
        }
      } finally {
        if (button.isConnected && !video.error) {
          delete button.dataset.videoLoading;
          button.disabled = false;
          button.removeAttribute('aria-busy');
        }
      }
    })();
  });
}
