import '../../src/style.css';
import { createPostMediaStoragePath } from '../../src/attachments.ts';
import { createAvatarHTML, renderPostCard } from '../../src/components.ts';
import { uploadPostMediaFile, uploadProfileImageWithToken } from '../../src/mediaUpload.ts';
import { resolvePostMediaURLFromProjection } from '../../src/postMediaLookup.ts';
import { bindLazyVideoLoader } from '../../src/lazyVideo.ts';
import { renderProfileCoverHTML } from '../../src/avatar.ts';

type FixtureProfile = {
  uid: string;
  displayName: string;
  username: string;
  photoURL?: string;
  coverURL?: string;
  avatarColor?: string;
};

type FixturePost = {
  id: string;
  userId: string;
  text: string;
  visibility: string;
  attachments: Array<{ id: string; kind: 'image'; url: string; name: string; size: number; mimeType: string; storagePath: string }>;
  videoURL?: string;
  media: Array<{ kind: 'image' | 'video'; url: string; mimeType: string; storagePath: string }>;
};

declare global {
  interface Window {
    mediaRegressionReady?: boolean;
    uploadAndSaveMediaRegression?: () => Promise<void>;
  }
}

const viewerId = 'e2e-media-user';
const fixtureToken = 'e2e-media-token';

async function uploadPostFile(file: File, path: string): Promise<string> {
  return uploadPostMediaFile(file, path, fixtureToken);
}

async function resolveVideoURL(postId: string, sourceURL: string): Promise<string> {
  return resolvePostMediaURLFromProjection(postId, sourceURL, 'video', 0, async () => {
    const response = await fetch('/api/posts/' + encodeURIComponent(postId), { cache: 'no-store' });
    if (response.status === 404) return { status: 404, media: null };
    if (!response.ok) throw new Error('post_media_lookup_failed_' + response.status);
    const payload = await response.json() as { post?: { media?: unknown } };
    return { status: response.status, media: payload.post?.media ?? null };
  });
}

function renderState(profile: FixtureProfile | null, posts: FixturePost[]): void {
  const profileContainer = document.querySelector<HTMLElement>('#profile');
  const postsContainer = document.querySelector<HTMLElement>('#posts');
  if (!profileContainer || !postsContainer) throw new Error('media_fixture_container_missing');
  profileContainer.innerHTML = profile
    ? renderProfileCoverHTML(profile.coverURL, profile.avatarColor) +
      '<div class="profile-avatar-wrapper">' +
      createAvatarHTML(profile, 104, { imageClassName: 'profile-avatar-img', fallbackClassName: 'profile-avatar-fallback' }) +
      '</div>'
    : '';
  postsContainer.innerHTML = posts.map((post) => renderPostCard(post, profile)).join('');
}

async function readFixtureState(): Promise<{ profile: FixtureProfile | null; posts: FixturePost[] }> {
  const response = await fetch('/api/test/bootstrap', { cache: 'no-store' });
  if (!response.ok) throw new Error('media_fixture_bootstrap_failed_' + response.status);
  return response.json() as Promise<{ profile: FixtureProfile | null; posts: FixturePost[] }>;
}

async function canvasImage(name: string, color: string): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('media_fixture_canvas_unavailable');
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#fff';
  context.fillRect(14, 12, 28, 28);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('media_fixture_image_encode_failed')), 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}

async function videoClip(): Promise<File> {
  if (!('MediaRecorder' in window) || !HTMLCanvasElement.prototype.captureStream) throw new Error('media_fixture_recorder_unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('media_fixture_canvas_unavailable');
  const stream = canvas.captureStream(12);
  const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(value => MediaRecorder.isTypeSupported(value));
  if (!mimeType) throw new Error('media_fixture_webm_encoder_unavailable');
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: BlobPart[] = [];
  recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
    recorder.addEventListener('error', () => reject(new Error('media_fixture_video_encode_failed')), { once: true });
  });
  recorder.start();
  let frame = 0;
  const draw = (): void => {
    context.fillStyle = frame++ % 2 ? '#14967f' : '#6244c5';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.fillRect((frame * 9) % 120, 24, 32, 32);
  };
  draw();
  const timer = window.setInterval(draw, 80);
  await new Promise(resolve => window.setTimeout(resolve, 900));
  window.clearInterval(timer);
  recorder.stop();
  await stopped;
  stream.getTracks().forEach(track => track.stop());
  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
  if (blob.size < 100) throw new Error('media_fixture_video_too_small');
  return new File([blob], 'regression-clip.webm', { type: blob.type });
}

async function saveFixtureProfile(profile: FixtureProfile): Promise<void> {
  const response = await fetch('/api/test/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!response.ok) throw new Error('media_fixture_profile_save_failed_' + response.status);
}

async function saveFixturePost(post: FixturePost): Promise<void> {
  const response = await fetch('/api/test/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(post),
  });
  if (!response.ok) throw new Error('media_fixture_post_save_failed_' + response.status);
}

window.uploadAndSaveMediaRegression = async () => {
  const olderImage = await canvasImage('older-post.png', '#a93e51');
  const olderPath = createPostMediaStoragePath(viewerId, olderImage, 'image');
  const olderURL = await uploadPostFile(olderImage, olderPath);
  const olderPost: FixturePost = {
    id: 'existing-media-post',
    userId: viewerId,
    text: 'Persisted image post',
    visibility: 'public',
    attachments: [{ id: 'existing-image', kind: 'image', url: olderURL, name: olderImage.name, size: olderImage.size, mimeType: olderImage.type, storagePath: olderPath }],
    media: [{ kind: 'image', url: olderURL, mimeType: olderImage.type, storagePath: olderPath }],
  };
  await saveFixturePost(olderPost);

  const avatarFile = await canvasImage('avatar.png', '#2676bf');
  const coverFile = await canvasImage('cover.png', '#d3892d');
  const [photoURL, coverURL] = await Promise.all([
    uploadProfileImageWithToken(avatarFile, viewerId, 'avatar', fixtureToken),
    uploadProfileImageWithToken(coverFile, viewerId, 'cover', fixtureToken),
  ]);
  const profile: FixtureProfile = { uid: viewerId, displayName: 'Media Regression', username: 'media-regression', photoURL, coverURL, avatarColor: '#2676bf' };
  await saveFixtureProfile(profile);

  const imageFile = await canvasImage('new-post-image.png', '#137a57');
  const videoFile = await videoClip();
  const imagePath = createPostMediaStoragePath(viewerId, imageFile, 'image');
  const videoPath = createPostMediaStoragePath(viewerId, videoFile, 'video');
  const [imageURL, videoURL] = await Promise.all([
    uploadPostFile(imageFile, imagePath),
    uploadPostFile(videoFile, videoPath),
  ]);
  const newPost: FixturePost = {
    id: 'new-media-post',
    userId: viewerId,
    text: 'New image and video post',
    visibility: 'public',
    attachments: [{ id: 'new-image', kind: 'image', url: imageURL, name: imageFile.name, size: imageFile.size, mimeType: imageFile.type, storagePath: imagePath }],
    videoURL,
    media: [
      { kind: 'image', url: imageURL, mimeType: imageFile.type, storagePath: imagePath },
      { kind: 'video', url: videoURL, mimeType: videoFile.type, storagePath: videoPath },
    ],
  };
  await saveFixturePost(newPost);
  const state = await readFixtureState();
  renderState(state.profile, state.posts);
};

bindLazyVideoLoader(document, {
  resolveURL: resolveVideoURL,
  onVideoError: error => console.error('[Connect media regression] video request failed', error),
  onSourceError: error => console.error('[Connect media regression] video source resolution failed', error),
  onPlaybackError: error => console.error('[Connect media regression] video playback failed', error),
});

void readFixtureState().then((state) => {
  renderState(state.profile, state.posts);
  window.mediaRegressionReady = true;
}).catch((error) => {
  console.error('[Connect media regression] fixture load failed', error);
  window.mediaRegressionReady = false;
});
