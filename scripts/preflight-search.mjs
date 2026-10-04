import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { buildPostSearchIndex } from '../functions/lib/search-index.js';
import fs from 'node:fs/promises';

function initializeAdmin() {
  if (getApps().length) return getFirestore();
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  const credential = rawJson
    ? cert(JSON.parse(rawJson))
    : (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
      ? cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') })
      : applicationDefault());
  initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID });
  return getFirestore();
}

function millis(value) { return value?.toMillis ? value.toMillis() : (typeof value === 'number' ? value : 0); }

async function main() {
  const gates = JSON.parse(await fs.readFile(new URL('./search-preflight-gates.json', import.meta.url), 'utf8'));
  const db = initializeAdmin();
  const totalPostsSnapshot = await db.collection('posts').count().get().catch(() => null);
  const page = await db.collection('posts').orderBy(FieldPath.documentId()).limit(10_000).get();
  const lengths = [];
  const tokenCounts = [];
  const tokenFrequency = new Map();
  const projectionSizes = [];
  const estimatedIndexEntries = [];
  let eligible = 0;
  let malformed = 0;
  for (const snapshot of page.docs) {
    const post = snapshot.data() || {};
    lengths.push(Array.from(typeof post.text === 'string' ? post.text : '').length);
    try {
      const index = buildPostSearchIndex(post, snapshot.id);
      if (!index) continue;
      eligible += 1;
      tokenCounts.push(index.searchTokens.length);
      index.searchTokens.forEach(token => tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1));
      projectionSizes.push(Buffer.byteLength(JSON.stringify({ ...index, createdAt: millis(index.createdAt), indexedAt: millis(index.indexedAt) }), 'utf8'));
      // This is a conservative projection estimate, not a Firestore billing
      // measurement. Emulator/index statistics remain the source of truth.
      estimatedIndexEntries.push((index.searchTokens.length * 2) + 16);
    } catch { malformed += 1; }
  }
  lengths.sort((a, b) => a - b);
  tokenCounts.sort((a, b) => a - b);
  projectionSizes.sort((a, b) => a - b);
  const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 0;
  const commonTokens = [...tokenFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([token, count]) => ({ token, documentFrequency: count }));
  console.log(JSON.stringify({
    mode: 'read-only-preflight-A',
    gateStatus: 'INCOMPLETE_UNTIL_REQUIRED_AUDITS_ARE_MEASURED',
    firestoreEdition: process.env.FIRESTORE_EDITION || 'NOT MEASURED',
    totalPosts: totalPostsSnapshot?.data()?.count ?? 'NOT MEASURED',
    samplePosts: page.size,
    sampleCoverage: totalPostsSnapshot?.data()?.count ? page.size / totalPostsSnapshot.data().count : 'NOT MEASURED',
    eligible,
    malformed,
    bodyLength: { p50: percentile(lengths, 0.5), p95: percentile(lengths, 0.95), max: lengths.at(-1) || 0 },
    tokenCount: { p50: percentile(tokenCounts, 0.5), p95: percentile(tokenCounts, 0.95), max: tokenCounts.at(-1) || 0 },
    indexDocumentBytes: { p50: percentile(projectionSizes, 0.5), p95: percentile(projectionSizes, 0.95), max: projectionSizes.at(-1) || 0 },
    estimatedIndexEntries: { p50: percentile(estimatedIndexEntries, 0.5), p95: percentile(estimatedIndexEntries, 0.95), max: estimatedIndexEntries.at(-1) || 0, methodology: 'tokenCount*2+16 estimate; verify with emulator/index statistics' },
    commonTokens,
    updateRates: 'NOT MEASURED: requires existing audit/telemetry data; do not infer invocation safety from early-return behavior.',
    preflightBGates: gates.preflightB,
  }, null, 2));
}

main().catch(error => { console.error(error?.message || error); process.exitCode = 1; });
