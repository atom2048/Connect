import { expect, test } from '@playwright/test';

type StoredObject = { body: Buffer; contentType: string };
type FixtureProfile = { uid: string; displayName: string; username: string; photoURL?: string; coverURL?: string; avatarColor?: string };
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

test('profile images, post images, and video upload, survive reload, and render/play in Chromium', async ({ page }) => {
  test.setTimeout(90_000);
  const objects = new Map<string, StoredObject>();
  const posts = new Map<string, FixturePost>();
  let profile: FixtureProfile | null = null;
  const uploadedKeys: string[] = [];
  const failedRequests: string[] = [];
  const mediaResponses: Array<{ path: string; status: number }> = [];

  const imageKey = 'posts/e2e-media-user/existing-image.png';
  objects.set(imageKey, {
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64'),
    contentType: 'image/png',
  });
  posts.set('preexisting-post', {
    id: 'preexisting-post',
    userId: 'e2e-media-user',
    text: 'Preexisting image post',
    visibility: 'public',
    attachments: [{ id: 'preexisting-image', kind: 'image', url: '/media/' + imageKey, name: 'existing-image.png', size: 0, mimeType: 'image/png', storagePath: imageKey }],
    media: [{ kind: 'image', url: '/media/' + imageKey, mimeType: 'image/png', storagePath: imageKey }],
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/test/bootstrap' && request.method() === 'GET') {
      await route.fulfill({ json: { profile, posts: [...posts.values()] } });
      return;
    }
    if (url.pathname === '/api/test/profile' && request.method() === 'PUT') {
      profile = request.postDataJSON() as FixtureProfile;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (url.pathname === '/api/test/posts' && request.method() === 'POST') {
      const post = request.postDataJSON() as FixturePost;
      posts.set(post.id, post);
      await route.fulfill({ status: 201, json: { post } });
      return;
    }
    const postMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
    if (postMatch && request.method() === 'GET') {
      const post = posts.get(decodeURIComponent(postMatch[1]));
      if (!post) {
        await route.fulfill({ status: 404, json: { error: 'post_not_found' } });
        return;
      }
      await route.fulfill({ json: { post: { id: post.id, authorId: post.userId, media: post.media } } });
      return;
    }
    failedRequests.push(request.method() + ' ' + url.pathname + ' → 404');
    await route.fulfill({ status: 404, json: { error: 'test_route_not_found' } });
  });

  await page.route('**/media/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = url.pathname.slice('/media/'.length).split('/').map(decodeURIComponent).join('/');
    if (request.method() === 'PUT') {
      if (request.headers().authorization !== 'Bearer e2e-media-token') {
        await route.fulfill({ status: 401, json: { error: 'unauthorized' } });
        return;
      }
      const stored: StoredObject = { body: (await request.postDataBuffer()) || Buffer.alloc(0), contentType: request.headers()['content-type'] || 'application/octet-stream' };
      objects.set(key, stored);
      uploadedKeys.push(key);
      await route.fulfill({ status: 201, json: { key, url: '/media/' + key.split('/').map(encodeURIComponent).join('/') } });
      return;
    }
    const stored = objects.get(key);
    if (!stored) {
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    const range = request.headers().range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        await route.fulfill({ status: 416, headers: { 'Content-Range': 'bytes */' + stored.body.length }, body: '' });
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(match[2] ? Number(match[2]) : stored.body.length - 1, stored.body.length - 1);
      if (start >= stored.body.length || end < start) {
        await route.fulfill({ status: 416, headers: { 'Content-Range': 'bytes */' + stored.body.length }, body: '' });
        return;
      }
      const body = stored.body.subarray(start, end + 1);
      await route.fulfill({
        status: 206,
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + stored.body.length, 'Content-Length': String(body.length) },
        contentType: stored.contentType,
        body,
      });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'Accept-Ranges': 'bytes' }, contentType: stored.contentType, body: stored.body });
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
      if (response.status() >= 400) failedRequests.push(response.status() + ' ' + url.pathname);
      if (url.pathname.startsWith('/media/')) mediaResponses.push({ path: url.pathname, status: response.status() });
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && /Connect(?: media regression|\])/.test(message.text())) {
      failedRequests.push('console ' + message.text());
    }
  });

  await page.goto('/tests/browser/');
  await expect.poll(() => page.evaluate(() => window.mediaRegressionReady)).toBe(true);
  await page.evaluate(async () => {
    if (!window.uploadAndSaveMediaRegression) throw new Error('media_regression_not_ready');
    await window.uploadAndSaveMediaRegression();
  });

  await expect(page.locator('#posts [data-post-id="existing-media-post"] img[data-post-media-image]')).toHaveJSProperty('naturalWidth', 96);
  await expect(page.locator('#posts [data-post-id="preexisting-post"] img[data-post-media-image]')).toHaveJSProperty('naturalWidth', 1);
  await expect(page.locator('#profile img.profile-avatar-img')).toHaveJSProperty('naturalWidth', 96);
  await expect.poll(() => page.locator('#profile .profile-cover').evaluate(element => getComputedStyle(element).backgroundImage)).toContain('cover_');
  await expect(page.locator('#posts [data-post-id="new-media-post"] img[data-post-media-image]')).toHaveJSProperty('naturalWidth', 96);
  await expect(page.locator('#posts .post-card[data-post-id="preexisting-post"]')).toBeVisible();
  await expect(page.locator('#posts .post-card[data-post-id="new-media-post"]')).toBeVisible();

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.mediaRegressionReady)).toBe(true);
  await expect(page.locator('#profile img.profile-avatar-img')).toHaveJSProperty('naturalWidth', 96);
  await expect(page.locator('#profile .profile-cover')).toBeVisible();
  await expect(page.locator('#posts [data-post-id="existing-media-post"] img[data-post-media-image]')).toHaveJSProperty('naturalWidth', 96);
  await expect(page.locator('#posts [data-post-id="new-media-post"] img[data-post-media-image]')).toHaveJSProperty('naturalWidth', 96);
  await expect(page.locator('#posts [data-post-id="preexisting-post"] img[data-post-media-image]')).toHaveJSProperty('naturalWidth', 1);

  const video = page.locator('#posts [data-post-id="new-media-post"] video[data-src]');
  await page.locator('#posts [data-post-id="new-media-post"] [data-action="load-video"]').click();
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLVideoElement>('#posts [data-post-id="new-media-post"] video[data-src]');
    return element !== null && (element.readyState >= 2 || element.error !== null);
  }, null, { timeout: 20_000 }).catch(() => undefined);
  const videoState = await video.evaluate((element: HTMLVideoElement) => ({
    readyState: element.readyState,
    networkState: element.networkState,
    currentTime: element.currentTime,
    paused: element.paused,
    errorCode: element.error?.code ?? null,
    errorMessage: element.error?.message ?? null,
    source: element.currentSrc ? new URL(element.currentSrc).pathname : '',
  }));
  if (videoState.readyState < 2) {
    throw new Error('video_media_readiness_failed:' + JSON.stringify({ video: videoState, mediaResponses, failedRequests }));
  }
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0), { timeout: 15_000 }).toBe(true);
  expect(mediaResponses.some((entry) => entry.path.includes('cover_') && entry.status === 200)).toBe(true);
  expect(mediaResponses.some((entry) => entry.path.includes('video_') && (entry.status === 206 || entry.status === 200))).toBe(true);

  const uploadedKinds = uploadedKeys.map((key) => key.split('/')[0] + '/' + key.split('/')[2]?.split('_')[0]);
  expect(uploadedKeys.some((key) => key.startsWith('profiles/e2e-media-user/avatar_'))).toBe(true);
  expect(uploadedKeys.some((key) => key.startsWith('profiles/e2e-media-user/cover_'))).toBe(true);
  expect(uploadedKinds).toContain('posts/image');
  expect(uploadedKinds).toContain('posts/video');
  expect(failedRequests).toEqual([]);
  await page.screenshot({ path: 'test-results/media-browser/media-regression.png', fullPage: true });
});
