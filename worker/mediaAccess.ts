const encoder = new TextEncoder();
const signingContext = encoder.encode('connect-media-url-signing-key-v1');
const ticketVersion = 'v1';
const maxTicketLifetimeSeconds = 10 * 60;

export type MediaAccessGrant = {
  key: string;
  postId: string;
  viewerId: string | null;
  expiresAt: number;
};

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

async function signingKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const masterKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derivedBytes = await crypto.subtle.sign('HMAC', masterKey, signingContext);
  return crypto.subtle.importKey('raw', derivedBytes, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function createMediaAccessTicket(secret: string, grant: Omit<MediaAccessGrant, 'expiresAt'>, now = Date.now()): Promise<string> {
  if (!secret || (!grant.key.startsWith('migration/') && !grant.key.startsWith('posts/')) || !grant.postId) throw new Error('media_ticket_unavailable');
  const payload: MediaAccessGrant = { ...grant, expiresAt: Math.floor(now / 1000) + maxTicketLifetimeSeconds };
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const signedValue = `${ticketVersion}.${encodedPayload}`;
  const key = await signingKey(secret, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signedValue)));
  return `${signedValue}.${encodeBase64Url(signature)}`;
}

export async function verifyMediaAccessTicket(secret: string, ticket: string, expectedKey: string, now = Date.now()): Promise<MediaAccessGrant | null> {
  if (!secret || (!expectedKey.startsWith('migration/') && !expectedKey.startsWith('posts/'))) return null;
  const match = ticket.match(/^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const [, encodedPayload, encodedSignature] = match;
  try {
    const key = await signingKey(secret, ['verify']);
    const validSignature = await crypto.subtle.verify('HMAC', key, toArrayBuffer(decodeBase64Url(encodedSignature)), encoder.encode(`${ticketVersion}.${encodedPayload}`));
    if (!validSignature) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));
    if (typeof value !== 'object' || value === null) return null;
    const grant = value as Partial<MediaAccessGrant>;
    const nowSeconds = Math.floor(now / 1000);
    if (grant.key !== expectedKey
      || typeof grant.postId !== 'string'
      || !grant.postId
      || !(grant.viewerId === null || typeof grant.viewerId === 'string')
      || typeof grant.expiresAt !== 'number'
      || !Number.isInteger(grant.expiresAt)
      || grant.expiresAt <= nowSeconds
      || grant.expiresAt > nowSeconds + maxTicketLifetimeSeconds) return null;
    return grant as MediaAccessGrant;
  } catch {
    return null;
  }
}
