import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const EXECUTE = process.argv.includes('--execute');
const LIMIT_ARG = process.argv.find(arg => arg.startsWith('--limit='));
const BATCH_ARG = process.argv.find(arg => arg.startsWith('--batch-size='));
const LIMIT = LIMIT_ARG ? Math.max(1, Number(LIMIT_ARG.split('=')[1]) || 0) : 0;
const BATCH_SIZE = Math.min(Math.max(BATCH_ARG ? Number(BATCH_ARG.split('=')[1]) || 400 : 400, 1), 450);

function initializeAdmin() {
  if (getApps().length) return;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    return;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error([
      'Firebase Admin credential is required.',
      'Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service account JSON path,',
      'or set FIREBASE_SERVICE_ACCOUNT_JSON to the full service account JSON string.',
      'This script defaults to dry-run and only writes with --execute.',
    ].join(' '));
  }
  initializeApp({ credential: applicationDefault() });
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function buildUserSearchFields(profile) {
  const usernameLower = stringValue(profile.username).toLowerCase();
  const displayNameLower = stringValue(profile.displayName).toLowerCase();
  const emailName = stringValue(profile.email).split('@')[0]?.toLowerCase() || '';
  const keywords = new Set();
  [usernameLower, displayNameLower, emailName].forEach((value) => {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (!compact) return;
    compact.split(' ').forEach((part) => {
      const token = part.trim();
      for (let i = 2; i <= Math.min(token.length, 20); i += 1) keywords.add(token.slice(0, i));
    });
    for (let i = 2; i <= Math.min(compact.length, 20); i += 1) keywords.add(compact.slice(0, i));
  });
  return { usernameLower, displayNameLower, searchKeywords: Array.from(keywords).slice(0, 60) };
}

function hasSearchFields(data) {
  return typeof data.usernameLower === 'string'
    && typeof data.displayNameLower === 'string'
    && Array.isArray(data.searchKeywords);
}

async function main() {
  initializeAdmin();
  const db = getFirestore();
  let query = db.collection('users').orderBy('__name__');
  if (LIMIT) query = query.limit(LIMIT);
  const snap = await query.get();
  let scanned = 0;
  let skipped = 0;
  let planned = 0;
  let committed = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const doc of snap.docs) {
    scanned += 1;
    const data = doc.data() || {};
    if (hasSearchFields(data)) {
      skipped += 1;
      continue;
    }
    const fields = buildUserSearchFields(data);
    planned += 1;
    if (!EXECUTE) continue;
    batch.update(doc.ref, { ...fields, searchFieldsBackfilledAt: FieldValue.serverTimestamp() });
    batchCount += 1;
    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      committed += batchCount;
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (EXECUTE && batchCount > 0) {
    await batch.commit();
    committed += batchCount;
  }

  console.log(JSON.stringify({ dryRun: !EXECUTE, scanned, skippedExisting: skipped, plannedUpdates: planned, committedUpdates: committed, batchSize: BATCH_SIZE, limitedTo: LIMIT || null }, null, 2));
  if (!EXECUTE) console.log('Dry-run only. Re-run with --execute to write search fields.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
