import { resolveAttachmentMimeType } from './attachments.ts';

export type UploadableMediaFile = Blob & { type?: string; name?: string };
export type MediaProgressHandler = (percent: number, progress: { bytesTransferred: number; totalBytes: number }) => void;

const R2_MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const R2_MULTIPART_CHUNK_BYTES = 8 * 1024 * 1024;
const R2_MULTIPART_PARALLEL_PARTS = 3;

export function mediaEndpoint(path: string): string {
  return '/media/' + path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function xhrMediaRequest<T>(options: {
  method: 'PUT' | 'POST' | 'DELETE';
  url: string;
  token: string;
  body: XMLHttpRequestBodyInit | null;
  contentType?: string;
  onProgress?: (loaded: number, total: number) => void;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method, options.url);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader('Authorization', 'Bearer ' + options.token);
    if (options.contentType) xhr.setRequestHeader('Content-Type', options.contentType);
    if (options.onProgress) xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
    xhr.onerror = () => reject(new Error('media_upload_network_error'));
    xhr.ontimeout = () => reject(new Error('media_upload_timed_out'));
    xhr.onload = () => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(xhr.responseText) as Record<string, unknown>; } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload as T);
      else {
        const code = typeof payload.error === 'string' ? payload.error : 'media_upload_failed_' + xhr.status;
        console.warn(JSON.stringify({ event: 'media_upload_request_failed', method: options.method, status: xhr.status, code }));
        reject(new Error(code));
      }
    };
    xhr.send(options.body);
  });
}

function uploadedMediaURL(payload: { key?: unknown; url?: unknown }, path: string): string {
  if (payload.key !== path || typeof payload.url !== 'string') throw new Error('media_upload_response_invalid');
  const expectedPath = mediaEndpoint(path);
  const url = new URL(payload.url, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== expectedPath) throw new Error('media_upload_response_invalid');
  return url.pathname + url.search;
}

/** Upload a profile avatar or cover through the authenticated R2 media route. */
export async function uploadProfileImageWithToken(file: File, uid: string, kind: 'avatar' | 'cover', token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(uid)) throw new Error('invalid_media_owner_id');
  if (file.size <= 0 || file.size > 15 * 1024 * 1024) throw new Error('画像は15MB以下のファイルを選んでください');
  const extensions: Record<string, string> = { 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const extension = extensions[file.type.toLowerCase()];
  if (!extension) throw new Error('JPEG、PNG、WebP、AVIF形式の画像を選んでください');
  const key = 'profiles/' + uid + '/' + kind + '_' + Date.now() + '_' + crypto.randomUUID() + '.' + extension;
  const response = await fetch(mediaEndpoint(key), {
    method: 'PUT',
    cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': file.type },
    body: file,
  });
  const payload = await response.json().catch((): null => null) as { key?: unknown; url?: unknown; error?: unknown } | null;
  if (!response.ok || payload?.key !== key || typeof payload?.url !== 'string') {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'profile_image_upload_failed_' + response.status);
  }
  const expectedPath = mediaEndpoint(key);
  const url = new URL(payload.url, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== expectedPath || !url.pathname.startsWith('/media/profiles/' + uid + '/')) {
    throw new Error('profile_image_upload_response_invalid');
  }
  return url.pathname + url.search;
}

/** Upload post attachments through the authenticated R2 media route. */
export async function uploadPostMediaFile(
  file: UploadableMediaFile,
  path: string,
  token: string,
  onProgress: MediaProgressHandler | null = null,
): Promise<string> {
  if (/^(?:dm|messages|chat)\//i.test(path)) throw new Error('DM attachments are no longer supported');
  if (!/^posts\/[A-Za-z0-9_-]{1,160}\//.test(path)) throw new Error('invalid_media_key');
  const endpoint = mediaEndpoint(path);
  const contentType = resolveAttachmentMimeType(file);
  const reportProgress = (loaded: number, total: number): void => {
    if (onProgress) onProgress(total ? Math.min(100, loaded / total * 100) : 0, { bytesTransferred: loaded, totalBytes: total || file.size });
  };

  if (file.size <= R2_MULTIPART_THRESHOLD) {
    const result = await xhrMediaRequest<{ key?: unknown; url?: unknown }>({
      method: 'PUT', url: endpoint, token, body: file, contentType,
      onProgress: onProgress ? reportProgress : undefined,
    });
    reportProgress(file.size, file.size);
    return uploadedMediaURL(result, path);
  }

  const initiated = await xhrMediaRequest<{ uploadId?: unknown }>({
    method: 'POST', url: endpoint, token,
    body: JSON.stringify({ action: 'initiate', contentType, size: file.size }),
    contentType: 'application/json',
  });
  if (typeof initiated.uploadId !== 'string' || !initiated.uploadId) throw new Error('media_upload_response_invalid');
  const uploadId = initiated.uploadId;
  const partCount = Math.ceil(file.size / R2_MULTIPART_CHUNK_BYTES);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const loadedByPart = new Array<number>(partCount).fill(0);
  const reportTotalProgress = (): void => {
    if (onProgress) reportProgress(loadedByPart.reduce((total, loaded) => total + loaded, 0), file.size);
  };

  try {
    for (let batchStart = 0; batchStart < partCount; batchStart += R2_MULTIPART_PARALLEL_PARTS) {
      const batch = Array.from({ length: Math.min(R2_MULTIPART_PARALLEL_PARTS, partCount - batchStart) }, (_, offset) => batchStart + offset);
      const uploaded = await Promise.all(batch.map(async (partIndex) => {
        const start = partIndex * R2_MULTIPART_CHUNK_BYTES;
        const end = Math.min(file.size, start + R2_MULTIPART_CHUNK_BYTES);
        const partNumber = partIndex + 1;
        const query = new URLSearchParams({ uploadId, partNumber: String(partNumber) });
        const result = await xhrMediaRequest<{ partNumber?: unknown; etag?: unknown }>({
          method: 'PUT', url: endpoint + '?' + query.toString(), token,
          body: file.slice(start, end), contentType: 'application/octet-stream',
          onProgress: onProgress ? (loaded) => { loadedByPart[partIndex] = loaded; reportTotalProgress(); } : undefined,
        });
        if (result.partNumber !== partNumber || typeof result.etag !== 'string' || !result.etag) throw new Error('media_upload_response_invalid');
        loadedByPart[partIndex] = end - start;
        reportTotalProgress();
        return { partNumber, etag: result.etag };
      }));
      parts.push(...uploaded);
    }
    parts.sort((left, right) => left.partNumber - right.partNumber);
    const completed = await xhrMediaRequest<{ key?: unknown; url?: unknown }>({
      method: 'POST', url: endpoint, token,
      body: JSON.stringify({ action: 'complete', uploadId, size: file.size, parts }),
      contentType: 'application/json',
    });
    reportProgress(file.size, file.size);
    return uploadedMediaURL(completed, path);
  } catch (cause) {
    const abortQuery = new URLSearchParams({ uploadId });
    void xhrMediaRequest({ method: 'DELETE', url: endpoint + '?' + abortQuery.toString(), token, body: null }).catch(() => {});
    throw cause;
  }
}
