import { AI_LIMITS, MEDIA_TRANSFORM_VERSION } from './config';
import type { Env } from '../types';
import type { MaterializedImage, MediaManifestItem, PrivacyClass } from './types';

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};

const profileFor = (mimeType: string, level = 0) => mimeType === 'image/jpeg'
  ? level >= 2
    ? { width: 1280, height: 1280, quality: 64 }
    : level === 1
      ? { width: 1600, height: 1600, quality: 72 }
      : { width: 2048, height: 2048, quality: 82 }
  : level >= 2
    ? { width: 1280, height: 1280, quality: 70 }
    : level === 1
      ? { width: 1920, height: 1920, quality: 84 }
      : { width: 2560, height: 2560, quality: 94 };

async function transform(env: Env, item: MediaManifestItem, level = 0): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!env.MEDIA || !env.IMAGES) throw new Error('IMAGES_TRANSFORM_UNAVAILABLE');
  const object = await env.MEDIA.get(item.objectKey);
  if (!object) throw new Error('MEDIA_OBJECT_NOT_FOUND');
  if (Number(object.size) > AI_LIMITS.originalImageBytes) throw new Error('MEDIA_ORIGINAL_TOO_LARGE');
  const infoObject = await env.MEDIA.get(item.objectKey);
  if (!infoObject) throw new Error('MEDIA_OBJECT_NOT_FOUND');
  const info = await env.IMAGES.info(infoObject.body);
  if (!('width' in info) || !('height' in info) || Number(info.width) > 4096 || Number(info.height) > 4096 || Number(info.width) * Number(info.height) > 16_777_216) throw new Error('UNSUPPORTED_MEDIA');
  if (!['image/avif', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(info.format)) throw new Error('UNSUPPORTED_MEDIA');
  const profile = profileFor(item.mimeType, level);
  const result = await env.IMAGES.input(object.body)
    .transform({ width: profile.width, height: profile.height, fit: 'scale-down' as const })
    .output({ format: 'image/webp', quality: profile.quality, anim: false });
  const response = result.response({ headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: result.contentType() };
}

async function one(env: Env, item: MediaManifestItem, privacyClass: PrivacyClass): Promise<MaterializedImage> {
  const profile = item.mimeType === 'image/jpeg' ? 'jpeg' : 'high-detail';
  const identity = item.sha256 || await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.objectKey)).then((digest) => [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join(''));
  const cacheKey = new Request(`https://connect.invalid/__ai-media/${identity}/${MEDIA_TRANSFORM_VERSION}/${profile}`);
  let result: { bytes: Uint8Array; contentType: string } | null = null;
  if (privacyClass === 'PUBLIC_AI') {
    const transformCache = await caches.open('connect-ai-media-v1');
    const hit = await transformCache.match(cacheKey);
    if (hit) result = { bytes: new Uint8Array(await hit.arrayBuffer()), contentType: hit.headers.get('content-type') || 'image/webp' };
  }
  if (!result) {
    result = await transform(env, item, 0);
    if (result.bytes.byteLength > AI_LIMITS.transformedImageBytes) result = await transform(env, item, 1);
    if (result.bytes.byteLength > AI_LIMITS.transformedImageBytes) result = await transform(env, item, 2);
    if (result.bytes.byteLength > AI_LIMITS.transformedImageBytes) throw new Error('UNSUPPORTED_MEDIA');
    if (privacyClass === 'PUBLIC_AI') {
      const cached = new Response(new Uint8Array(result.bytes).buffer as ArrayBuffer, { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'public, max-age=3600' } });
      const transformCache = await caches.open('connect-ai-media-v1');
      await transformCache.put(cacheKey, cached);
    }
  }
  return { ref: item.ref, belongsTo: item.belongsTo, position: item.position, dataUrl: `data:${result.contentType};base64,${bytesToBase64(result.bytes)}`, binaryBytes: result.bytes.byteLength, animatedTruncated: item.animated };
}

export async function materializeImages(env: Env, selected: MediaManifestItem[], privacyClass: PrivacyClass, requestId?: string): Promise<MaterializedImage[]> {
  // The manifest already caps this list at four images. Materialize those
  // bounded objects concurrently so one slow R2/Images transform does not
  // serially consume the generation deadline. Re-apply the aggregate byte
  // cap after completion, in manifest order, before any image is dispatched.
  const results = await Promise.all(selected.map(async (item, index) => {
    try {
      return { index, image: await one(env, item, privacyClass) } as const;
    } catch (cause) {
      if ((cause as { code?: number }).code === 9422 || (cause instanceof Error && cause.message.includes('9422'))) {
        return { index, fatal: 'IMAGES_FREE_LIMIT_EXHAUSTED' as const };
      }
      if (cause instanceof Error && cause.message === 'UNSUPPORTED_MEDIA') {
        return { index, skipped: 'UNSUPPORTED_MEDIA' as const };
      }
      return { index, error: cause } as const;
    }
  }));
  if (requestId) {
    const skippedReasons = results.filter((result): result is { index: number; skipped: 'UNSUPPORTED_MEDIA' } => 'skipped' in result)
      .reduce<Record<string, number>>((counts, result) => ({ ...counts, [result.skipped]: (counts[result.skipped] || 0) + 1 }), {});
    const errorReasons = results.filter((result): result is { index: number; error: unknown } => 'error' in result)
      .reduce<Record<string, number>>((counts, result) => {
        const raw = result.error instanceof Error ? result.error.message : '';
        const reason = /^[A-Z][A-Z0-9_]{1,63}$/.test(raw) ? raw : 'MEDIA_TRANSFORM_FAILED';
        return { ...counts, [reason]: (counts[reason] || 0) + 1 };
      }, {});
    console.log(JSON.stringify({
      event: 'ai_media_item_outcomes',
      requestId,
      selectedCount: selected.length,
      materializedCount: results.filter((result) => 'image' in result).length,
      skippedReasons,
      errorReasons,
      bodyLogged: false,
      piiLogged: false,
    }));
  }
  const output: MaterializedImage[] = [];
  let total = 0;
  for (const result of results.sort((left, right) => left.index - right.index)) {
    if ('fatal' in result) throw new Error(result.fatal);
    if ('error' in result) throw result.error;
    if ('skipped' in result) continue;
    if (total + result.image.binaryBytes > AI_LIMITS.transformedTotalBytes) continue;
    total += result.image.binaryBytes;
    output.push(result.image);
  }
  return output;
}
