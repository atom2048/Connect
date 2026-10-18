import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseURL = (process.env.MEDIA_PRODUCTION_BASE_URL || 'https://sns-app-ashen.vercel.app').replace(/\/$/, '');
const profileId = process.env.MEDIA_PRODUCTION_PROFILE_ID || 'WGnVUjprzOZz3sHoATD16qrjV8D2';
const videoPostId = process.env.MEDIA_PRODUCTION_VIDEO_POST_ID || 'H2wlnmbFr8XGMXSq2Rma';
const outputDir = 'test-results/production-media-browser';
const mediaResponses = [];
const apiResponses = [];
const failedRequests = [];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === baseURL && url.pathname.startsWith('/api/')) {
      apiResponses.push({ status: response.status(), method: response.request().method(), path: url.pathname });
    }
    if (url.origin === baseURL && (url.pathname.startsWith('/media/') || url.pathname.startsWith('/api/posts/') || url.pathname.startsWith('/api/profiles/'))) {
      mediaResponses.push({ status: response.status(), method: response.request().method(), path: url.pathname });
    }
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (url.origin === baseURL) failedRequests.push({ method: request.method(), path: url.pathname, error: request.failure()?.errorText || 'request_failed' });
  });
  await mkdir(outputDir, { recursive: true });

  const profileURL = `${baseURL}/#/profile/${encodeURIComponent(profileId)}`;
  await page.goto(profileURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('.profile-avatar-img').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => {
    const avatar = document.querySelector('.profile-avatar-img');
    return avatar instanceof HTMLImageElement && avatar.complete && avatar.naturalWidth > 0;
  }, null, { timeout: 30000 });
  const profileProof = await page.evaluate(() => {
    const avatar = document.querySelector('.profile-avatar-img');
    const cover = document.querySelector('.profile-cover');
    const backgroundImage = cover ? getComputedStyle(cover).backgroundImage : '';
    const coverURL = backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || '';
    return {
      avatarPath: avatar ? new URL(avatar.currentSrc).pathname : '',
      avatarWidth: avatar instanceof HTMLImageElement ? avatar.naturalWidth : 0,
      coverPath: coverURL ? new URL(coverURL, location.href).pathname : '',
      coverBackgroundLoaded: Boolean(coverURL),
    };
  });
  assert.ok(profileProof.avatarWidth > 0, 'production profile avatar did not load');
  assert.ok(profileProof.coverBackgroundLoaded, 'production profile cover background is missing');
  // Profile hero media loads before the profile feed request. Wait for the
  // real existing posts before looking for lazy-loaded post images.
  await page.locator('#profile-content .post-card').first().waitFor({ state: 'visible', timeout: 30000 });
  await page.screenshot({ path: `${outputDir}/profile-top.png` });

  // Trigger native lazy image loading while staying on the same read-only profile.
  const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < documentHeight; y += 750) {
    await page.evaluate(scrollY => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(180);
    const found = await page.locator('img[src*="/media/posts/"]').evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0));
    if (found) break;
  }
  const postImage = page.locator('img[src*="/media/posts/"]:visible');
  const loadedPostImage = await postImage.evaluateAll(images => {
    const image = images.find(item => item.complete && item.naturalWidth > 0);
    if (!image) return null;
    image.scrollIntoView({ block: 'center' });
    return { path: new URL(image.currentSrc).pathname, width: image.naturalWidth };
  });
  assert.ok(loadedPostImage?.width > 0, 'no existing profile post image loaded in production');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outputDir}/existing-post-image.png` });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('.profile-avatar-img').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => {
    const avatar = document.querySelector('.profile-avatar-img');
    return avatar instanceof HTMLImageElement && avatar.complete && avatar.naturalWidth > 0;
  }, null, { timeout: 30000 });
  await page.locator('#profile-content .post-card').first().waitFor({ state: 'visible', timeout: 30000 });
  const profileAfterReload = await page.locator('.profile-avatar-img').evaluate(image => ({ width: image.naturalWidth, path: new URL(image.currentSrc).pathname }));
  assert.ok(profileAfterReload.width > 0, 'profile avatar failed after reload');

  const postURL = `${baseURL}/#/post/${encodeURIComponent(videoPostId)}`;
  async function playProductionVideo(navigate = true) {
    if (navigate) await page.goto(postURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const playButton = page.locator('button[data-action="load-video"]');
    await playButton.first().waitFor({ state: 'visible', timeout: 30000 });
    await playButton.first().click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video instanceof HTMLVideoElement && video.readyState >= 2 && video.currentTime > 0 && !video.paused;
    }, null, { timeout: 20000 });
    return page.locator('video').first().evaluate(video => ({
      path: new URL(video.currentSrc).pathname,
      readyState: video.readyState,
      paused: video.paused,
      currentTime: video.currentTime,
    }));
  }
  const videoBeforeReload = await playProductionVideo();
  assert.ok(videoBeforeReload.readyState >= 2 && !videoBeforeReload.paused && videoBeforeReload.currentTime > 0, 'production video did not play');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  const videoAfterReload = await playProductionVideo(false);
  assert.ok(videoAfterReload.readyState >= 2 && !videoAfterReload.paused && videoAfterReload.currentTime > 0, 'production video did not play after reload');
  await page.screenshot({ path: `${outputDir}/existing-video-playing.png` });

  const coverResponse = mediaResponses.find(item => item.path === profileProof.coverPath && item.status === 200);
  const postImageResponse = mediaResponses.find(item => item.path === loadedPostImage.path && item.status === 200);
  const videoRangeResponses = mediaResponses.filter(item => item.path === videoAfterReload.path && item.status === 206);
  assert.ok(coverResponse, 'profile cover did not return HTTP 200');
  assert.ok(postImageResponse, 'existing post image did not return HTTP 200');
  assert.ok(videoRangeResponses.length > 0, 'existing video did not return HTTP 206 Range responses');

  const proof = {
    event: 'production_media_browser_passed',
    baseURL,
    profile: { ...profileProof, reloadAvatarWidth: profileAfterReload.width },
    existingPostImage: loadedPostImage,
    existingVideo: { path: videoAfterReload.path, readyState: videoAfterReload.readyState, paused: videoAfterReload.paused, currentTime: videoAfterReload.currentTime, rangeResponses: videoRangeResponses.length },
    expectedPrivateMedia: mediaResponses.filter(item => item.status === 404 && item.path.startsWith('/media/posts/')).map(item => item.path),
    screenshots: ['profile-top.png', 'existing-post-image.png', 'existing-video-playing.png'],
  };
  await writeFile(`${outputDir}/proof.json`, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
} catch (error) {
  console.error(JSON.stringify({
    event: 'production_media_browser_failed',
    baseURL,
    reason: error instanceof Error ? error.message : String(error),
    apiResponses: apiResponses.slice(-30),
    mediaResponses: mediaResponses.slice(-30),
    failedRequests,
  }));
  throw error;
} finally {
  await browser.close();
}
