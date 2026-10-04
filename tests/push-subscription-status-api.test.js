import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ collection: vi.fn(), auth: vi.fn() }));
vi.mock('../api/_firebase-admin.js', () => ({ adminDb: { collection: mocks.collection } }));
vi.mock('../api/_auth.js', () => ({ setApiHeaders: vi.fn(), verifyFirebaseUser: mocks.auth }));

import handler, { subscriptionId } from '../api/push-subscriptions.js';

const userId = 'user-b';
const endpoint = 'https://push.example.test/current-browser-token';
let records;
let endpointSnapshot;
let subscriptionQuery;
let subscriptionCollection;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function request(method, { query = {}, body } = {}) {
  const res = response();
  await handler({ method, query, body, headers: {} }, res);
  return res;
}

beforeEach(() => {
  records = [
    { userId, active: true, subscriptionEnabled: true },
    { userId, active: false, subscriptionEnabled: false },
  ];
  endpointSnapshot = { exists: true, data: () => records[0] };
  subscriptionQuery = {
    where: vi.fn().mockReturnThis(),
    get: vi.fn(async () => ({ docs: records.map(record => ({ data: () => record })) })),
  };
  subscriptionCollection = {
    where: vi.fn(() => subscriptionQuery),
    doc: vi.fn(() => ({ get: vi.fn(async () => endpointSnapshot) })),
  };
  mocks.collection.mockReset().mockReturnValue(subscriptionCollection);
  mocks.auth.mockReset().mockResolvedValue({ sub: userId });
});

describe('push subscription status API', () => {
  it('keeps GET endpoint status compatible for already-open clients', async () => {
    const result = await request('GET', { query: { endpoint } });

    expect(result.statusCode).toBe(200);
    expect(subscriptionCollection.doc).toHaveBeenCalledWith(subscriptionId(endpoint));
    expect(result.body).toEqual({ count: 1, registered: true, subscriptionStatus: 'active' });
  });

  it('returns only the account count when no current-browser endpoint is supplied', async () => {
    const result = await request('GET');

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ count: 1 });
    expect(subscriptionCollection.doc).not.toHaveBeenCalled();
  });

  it('does not infer current-browser registration from another active device', async () => {
    endpointSnapshot = { exists: false };

    const result = await request('GET', { query: { endpoint } });

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ count: 1, registered: false, subscriptionStatus: 'missing' });
  });

  it('uses the same explicit status schema for current POST clients', async () => {
    endpointSnapshot = { exists: false };

    const result = await request('POST', { body: { action: 'status', endpoint } });

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ count: 1, registered: false, subscriptionStatus: 'missing' });
  });

  it('rejects invalid endpoint compatibility requests', async () => {
    const result = await request('GET', { query: { endpoint: 'http://insecure.example.test/token' } });

    expect(result.statusCode).toBe(400);
  });
});
