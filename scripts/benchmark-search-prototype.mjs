import crypto from 'node:crypto';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { chooseSearchAnchor, normalizeSearchText, splitSearchTerms, SEARCH_NORMALIZER_VERSION, SEARCH_SCHEMA_VERSION } from '../functions/lib/search-normalizer.js';
import { FULL_SCAN_LIMIT, PREVIEW_SCAN_LIMIT } from '../api/_search-config.js';
import gates from './search-preflight-gates.json' with { type: 'json' };

const args = new Map(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=') || 'true'];
}));
const collectionName = args.get('collection') || 'postSearchIndexPrototype';
const trials = Number(args.get('trials') || gates.preflightB.minimumSamplesPerQueryClass);
if (!Number.isInteger(trials) || trials < 1) throw new Error('--trials must be a positive integer');

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

function queryHash(query, mode) {
  return crypto.createHash('sha256').update(`${SEARCH_SCHEMA_VERSION}:${SEARCH_NORMALIZER_VERSION}:${mode}:${query}`, 'utf8').digest('hex').slice(0, 12);
}

function percentile(values, p) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

async function runTrial(db, queryText, limit = 5) {
  const normalized = normalizeSearchText(queryText);
  const selected = chooseSearchAnchor(normalized);
  if (!selected) return { skipped: true };
  const terms = [...new Set(splitSearchTerms(normalized))];
  const scanLimit = limit <= 5 ? PREVIEW_SCAN_LIMIT : FULL_SCAN_LIMIT;
  const started = performance.now();
  const snapshot = await db.collection(collectionName)
    .where('schemaVersion', '==', SEARCH_SCHEMA_VERSION)
    .where('normalizerVersion', '==', SEARCH_NORMALIZER_VERSION)
    .where('searchTokens', 'array-contains', selected.anchor)
    .orderBy('createdAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(scanLimit + 1)
    .get();
  const candidates = snapshot.docs.slice(0, scanLimit);
  let scanned = 0;
  const matchingCandidates = [];
  for (const candidate of candidates) {
    scanned += 1;
    const data = candidate.data() || {};
    const matches = selected.mode === 'hashtag'
      ? Array.isArray(data.searchTokens) && data.searchTokens.includes(selected.anchor)
      : terms.every(term => String(data.normalizedText || '').includes(term));
    if (matches) matchingCandidates.push(candidate);
    if (matchingCandidates.length >= limit) break;
  }
  return {
    skipped: false,
    latencyMs: performance.now() - started,
    candidateReads: snapshot.size,
    scanned,
    returned: matchingCandidates.length,
    scanLimitReached: matchingCandidates.length < limit && scanned >= scanLimit,
    hasMore: snapshot.size > scanLimit || scanned < candidates.length,
    queryHash: queryHash(normalized, selected.mode),
  };
}

async function main() {
  const db = initializeAdmin();
  const queryClasses = [
    ['common-2-code-point', 'です'],
    ['common-3-code-point', '生成AI'],
    ['rare', 'zzzz-prototype'],
    ['japanese', '東京電機'],
    ['multi-term', '東京 AI'],
    ['hashtag', '#AI'],
  ];
  const report = [];
  for (const [name, query] of queryClasses) {
    for (const budget of [{ name: 'preview', limit: 5 }, { name: 'full', limit: 20 }]) {
      const samples = [];
      for (let index = 0; index < trials; index += 1) samples.push(await runTrial(db, query, budget.limit));
      const usable = samples.filter(sample => !sample.skipped);
      const latencies = usable.map(sample => sample.latencyMs).sort((a, b) => a - b);
      const candidates = usable.map(sample => sample.candidateReads);
      const ratios = usable.filter(sample => sample.returned > 0).map(sample => sample.scanned / sample.returned);
      report.push({
        queryClass: name,
        budget: budget.name,
        limit: budget.limit,
        queryHash: usable[0]?.queryHash || null,
        samples: usable.length,
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        p99LatencyMs: usable.length >= 100 ? percentile(latencies, 0.99) : 'NOT ENOUGH SAMPLES',
        maxCandidateReads: Math.max(0, ...candidates),
        scanToReturnP95: percentile(ratios.sort((a, b) => a - b), 0.95),
        scanLimitReachedRate: usable.length ? usable.filter(sample => sample.scanLimitReached).length / usable.length : 0,
        emptyPageWithMoreRate: usable.length ? usable.filter(sample => sample.returned === 0 && sample.hasMore).length / usable.length : 0,
        falseNegatives: 'NOT MEASURED: provide golden post IDs in a separate verification run',
      });
    }
  }
  console.log(JSON.stringify({ mode: 'prototype-benchmark', collection: collectionName, trialsPerClass: trials, warmCold: 'NOT SEPARATED', gates, report }, null, 2));
}

main().catch(error => { console.error(error?.message || error); process.exitCode = 1; });
