import type { Attachment, AttachmentKind } from './types/domain.ts';

export const COMMENT_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;

const IMAGE_EXTENSIONS = ['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp'];
const VIDEO_EXTENSIONS = ['3gp', 'avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm'];
const AUDIO_EXTENSIONS = ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba'];

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'video/3gpp': '3gp',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
};

const EXTENSION_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXTENSION).map(([mimeType, extension]) => [extension, mimeType]),
);
EXTENSION_TO_MIME.jpeg = 'image/jpeg';
EXTENSION_TO_MIME.m4v = 'video/x-m4v';
EXTENSION_TO_MIME.oga = 'audio/ogg';
const detectedAttachmentMimeTypes = new WeakMap<object, string>();

function fileExtension(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 && dotIndex < name.length - 1 ? name.slice(dotIndex + 1).toLowerCase() : '';
}

export function getAttachmentExtension(file: File): string {
  return fileExtension(file.name);
}

/** Prefer the browser MIME type, then infer a missing generic MIME type from a known suffix. */
export function resolveAttachmentMimeType(file: { name?: string; type?: string }): string {
  const detected = detectedAttachmentMimeTypes.get(file as object);
  if (detected) return detected;
  const declaredType = (file.type || '').split(';', 1)[0].trim().toLowerCase();
  if (declaredType && declaredType !== 'application/octet-stream') return declaredType;
  return EXTENSION_TO_MIME[fileExtension(file.name || '')] || declaredType || 'application/octet-stream';
}

/** Infer common media types from bytes when a file picker supplies no useful MIME or suffix. */
export async function sniffAttachmentMimeType(file: File): Promise<string> {
  const knownType = resolveAttachmentMimeType(file);
  if (knownType !== 'application/octet-stream') return knownType;

  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.slice(start, end));
  let detected = '';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) detected = 'image/jpeg';
  else if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) detected = 'image/png';
  else if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) detected = 'image/gif';
  else if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') detected = 'image/webp';
  else if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).trim();
    if (brand === 'avif' || brand === 'avis') detected = 'image/avif';
    else if (brand === 'qt') detected = 'video/quicktime';
    else if (brand.startsWith('M4V')) detected = 'video/x-m4v';
    else detected = 'video/mp4';
  }

  if (detected) detectedAttachmentMimeTypes.set(file, detected);
  return detected || knownType;
}

/** Build a Worker-safe R2 key without copying arbitrary characters from the selected filename. */
export function createPostMediaStoragePath(
  ownerId: string,
  file: Pick<File, 'name' | 'type'>,
  purpose: 'image' | 'video' | 'attachment',
): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(ownerId)) throw new Error('invalid_media_owner_id');
  const mimeType = resolveAttachmentMimeType(file);
  const suffix = MIME_TO_EXTENSION[mimeType]
    || (/^[A-Za-z0-9]{1,10}$/.test(fileExtension(file.name)) ? fileExtension(file.name) : 'bin');
  const nonce = globalThis.crypto?.randomUUID?.()
    || Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  return 'posts/' + ownerId + '/' + purpose + '_' + nonce + '.' + suffix;
}

/** Animated GIFs must use the source object; a generated WebP preview contains only one frame. */
export function attachmentDisplayURL(attachment: Pick<Attachment, 'kind' | 'url' | 'mimeType' | 'thumbnailUrl' | 'previewUrl'>): string {
  const animatedGif = attachment.kind === 'image'
    && (String(attachment.mimeType || '').split(';', 1)[0].trim().toLowerCase() === 'image/gif'
      || /\.gif(?:$|[?#])/i.test(attachment.url));
  return animatedGif ? attachment.url : (attachment.thumbnailUrl || attachment.previewUrl || attachment.url);
}

export function detectAttachmentKind(file: File): AttachmentKind {
  const type = resolveAttachmentMimeType(file);
  const ext = getAttachmentExtension(file);
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (type.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (type.startsWith('audio/') || AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  return 'file';
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function getAttachmentValidationError(file: File, limit = COMMENT_ATTACHMENT_LIMIT_BYTES): string | null {
  if (file.size <= limit) return null;
  return `ファイルは${formatFileSize(limit)}以下にしてください`;
}

/**
 * Firestore rejects `undefined` anywhere in a document.  Metadata is best
 * effort (for example, a browser may not be able to read an image's
 * dimensions), so optional values must be omitted rather than stored as
 * undefined.
 */
export function sanitizeAttachment(attachment: Partial<Attachment>): Attachment {
  const sanitized = { ...attachment } as Attachment;
  (Object.keys(sanitized) as Array<keyof Attachment>).forEach((key) => {
    if (sanitized[key] === undefined) delete sanitized[key];
  });
  return sanitized;
}

export function sanitizeAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<Attachment> => typeof item === 'object' && item !== null)
    .map(sanitizeAttachment);
}

export function createAttachmentRecord(file: File, url: string, metadata: Partial<Attachment> = {}): Attachment {
  const fallbackId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : fallbackId;
  const record: Attachment = {
    id,
    kind: detectAttachmentKind(file),
    url,
    name: file.name || 'ファイル',
    size: file.size,
    mimeType: resolveAttachmentMimeType(file),
    thumbnailUrl: metadata.thumbnailUrl || '',
    previewUrl: metadata.previewUrl || '',
    previewStoragePath: metadata.previewStoragePath || '',
    storagePath: metadata.storagePath || '',
  };
  if (Number.isFinite(metadata.duration)) record.duration = metadata.duration;
  if (Number.isFinite(metadata.width)) record.width = metadata.width;
  if (Number.isFinite(metadata.height)) record.height = metadata.height;
  return record;
}



export async function readAttachmentMetadata(file: File): Promise<Partial<Attachment>> {
  const kind = detectAttachmentKind(file);
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return {};
  if (kind === 'image' && typeof Image !== 'undefined') {
    const objectUrl = URL.createObjectURL(file);
    return new Promise(resolve => {
      const image = new Image();
      const finish = (metadata: Partial<Attachment>) => {
        URL.revokeObjectURL(objectUrl);
        resolve(metadata);
      };
      image.onload = () => finish({ width: image.naturalWidth || undefined, height: image.naturalHeight || undefined });
      image.onerror = () => finish({});
      image.src = objectUrl;
    });
  }
  if ((kind === 'video' || kind === 'audio') && typeof document !== 'undefined') {
    const objectUrl = URL.createObjectURL(file);
    return new Promise(resolve => {
      const media = document.createElement(kind === 'video' ? 'video' : 'audio') as HTMLMediaElement & { videoWidth?: number; videoHeight?: number };
      const finish = (metadata: Partial<Attachment>) => {
        URL.revokeObjectURL(objectUrl);
        resolve(metadata);
      };
      media.preload = 'metadata';
      media.onloadedmetadata = () => finish({
        duration: Number.isFinite(media.duration) ? media.duration : undefined,
        width: kind === 'video' && media.videoWidth ? media.videoWidth : undefined,
        height: kind === 'video' && media.videoHeight ? media.videoHeight : undefined,
      });
      media.onerror = () => finish({});
      media.src = objectUrl;
    });
  }
  return {};
}
export async function createImagePreviewFile(file: File, maxDimension = 800, quality = 0.76): Promise<File | null> {
  if (detectAttachmentKind(file) !== 'image') return null;
  const ext = getAttachmentExtension(file);
  const mimeType = resolveAttachmentMimeType(file);
  if (mimeType === 'image/gif' || ['gif', 'svg', 'heic', 'heif'].includes(ext)) return null;
  if (!mimeType.startsWith('image/')) return null;
  if (file.size > 20 * 1024 * 1024) return null;
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement | null>(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = objectUrl;
    });
    if (!image || !image.naturalWidth || !image.naturalHeight) return null;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale >= 1 && file.size <= 350 * 1024) return null;
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/webp', quality);
    });
    if (!blob || blob.size <= 0 || blob.size >= file.size) return null;
    const baseName = (file.name || 'image').replace(/\.[^.]+$/, '');
    return new File([blob], `${baseName}_preview.webp`, { type: blob.type || 'image/webp' });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
