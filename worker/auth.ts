import { betterAuth } from 'better-auth';
import type { Auth } from 'better-auth';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env, Viewer } from './types';
import { viewerFromSession } from './lib';

const FIREBASE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

async function viewerFromFirebaseBearer(env: Env, request: Request): Promise<Viewer | null> {
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  const authorization = request.headers.get('authorization') || '';
  if (!projectId || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      name: typeof payload.name === 'string' ? payload.name : (typeof payload.email === 'string' ? payload.email.split('@')[0] : 'Connect user'),
      email: typeof payload.email === 'string' ? payload.email : '',
      image: typeof payload.picture === 'string' ? payload.picture : null,
      role: payload.role === 'admin' ? 'admin' : 'user',
    };
  } catch {
    return null;
  }
}

export function createAuth(env: Env, request: Request): Auth<any> {
  const origin = new URL(request.url).origin;
  const configuredOrigins = (env.CONNECT_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  const publicOrigin = env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).origin : origin;
  return betterAuth({
    database: env.DB as D1Database,
    user: { fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' } },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24, fields: { userId: 'user_id', expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at', ipAddress: 'ip_address', userAgent: 'user_agent' } },
    account: { fields: { accountId: 'account_id', providerId: 'provider_id', userId: 'user_id', accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token', accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
    verification: { fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
    secret: env.BETTER_AUTH_SECRET as string,
    baseURL: publicOrigin,
    basePath: '/api/auth',
    trustedOrigins: [...new Set([origin, publicOrigin, ...configuredOrigins])],
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    advanced: { useSecureCookies: new URL(publicOrigin).protocol === 'https:' },
  });
}

export async function getViewer(env: Env, request: Request): Promise<{
  auth: Auth<any> | null;
  viewer: Viewer | null;
  source: 'firebase_bearer' | 'better_auth_session' | 'none';
}> {
  const firebaseViewer = await viewerFromFirebaseBearer(env, request);
  if (firebaseViewer) return { auth: env.BETTER_AUTH_SECRET ? createAuth(env, request) : null, viewer: firebaseViewer, source: 'firebase_bearer' };
  if (!env.BETTER_AUTH_SECRET) return { auth: null, viewer: null, source: 'none' };
  const auth = createAuth(env, request);
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const viewer = viewerFromSession(session);
    return { auth, viewer, source: viewer ? 'better_auth_session' : 'none' };
  } catch { return { auth, viewer: null, source: 'none' }; }
}

/**
 * Ask AI may be enabled for public traffic, but the rest of the Worker still
 * needs a bounded, non-identifying quota key for requests without a session.
 * Cloudflare supplies the client address at the edge; hash it before it is
 * used anywhere else so neither the raw address nor a client-supplied ID is
 * persisted or logged.
 */
function clientAddress(request: Request): string {
  const cloudflareAddress = request.headers.get('cf-connecting-ip')?.trim();
  if (cloudflareAddress) return cloudflareAddress;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const real = request.headers.get('x-real-ip')?.trim();
  return real || 'unknown';
}

async function hashedClientAddress(env: Env, request: Request): Promise<string> {
  const secret = env.AI_ROLLOUT_HASH_SECRET || env.AI_CONSENT_FINGERPRINT_SECRET || 'connect-anonymous-rate-v1';
  const input = new TextEncoder().encode(`${secret}:${clientAddress(request)}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export async function getRequestRateLimitKey(env: Env, request: Request): Promise<string> {
  return `ip:${await hashedClientAddress(env, request)}`;
}

export async function getViewerOrAnonymous(env: Env, request: Request): Promise<{
  auth: Auth<any> | null;
  viewer: Viewer;
  anonymous: boolean;
  rateLimitKey: string;
}> {
  const identity = await getViewer(env, request);
  const rateLimitKey = await getRequestRateLimitKey(env, request);
  if (identity.viewer) return { ...identity, viewer: identity.viewer, anonymous: false, rateLimitKey };
  const hash = rateLimitKey.slice('ip:'.length);
  return {
    auth: identity.auth,
    viewer: { id: `anon:${hash}`, name: 'Anonymous', email: '', image: null },
    anonymous: true,
    rateLimitKey,
  };
}
