import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { buildPostSearchIndex, SEARCH_NORMALIZER_VERSION, SEARCH_SCHEMA_VERSION } from '../functions/lib/search-index.js';
import { syncPostSearchIndex } from '../functions/lib/search-sync.js';

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const explicitDryRun = args.has('--dry-run');
if (execute && explicitDryRun) throw new Error('--execute and --dry-run cannot be used together');
const limitArg = process.argv.find(value => value.startsWith('--limit='));
const afterArg = process.argv.find(value => value.startsWith('--after='));
const checkpointArg = process.argv.find(value => value.startsWith('--checkpoint='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Number.POSITIVE_INFINITY;
if (!Number.isFinite(limit) && limit !== Number.POSITIVE_INFINITY) throw new Error('--limit must be a positive integer');
if (Number.isFinite(limit) && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
const after = afterArg
  ? afterArg.slice('--after='.length)
  : (checkpointArg ? checkpointArg.slice('--checkpoint='.length) : '');

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

function projectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '';
}

function countTokens(post) {
  try {
    const index = buildPostSearchIndex(post, 'preflight');
    return index ? index.searchTokens.length : 0;
  } catch {
    return null;
  }
}

async function main() {
  const db = initializeAdmin();
  const actualProject = projectId();
  const expectedProject = process.env.EXPECTED_FIREBASE_PROJECT_ID || actualProject;
  if (!actualProject) throw new Error('Firebase project ID is not available');
  if (execute && actualProject !== expectedProject) {
    throw new Error(`Refusing execute in unexpected Firebase project: ${actualProject}`);
  }
  console.log(JSON.stringify({
    mode: execute ? 'execute' : 'dry-run',
    projectId: actualProject,
    databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
    schemaVersion: SEARCH_SCHEMA_VERSION,
    normalizerVersion: SEARCH_NORMALIZER_VERSION,
    after: after || null,
    limit: Number.isFinite(limit) ? limit : null,
  }));

  let scanned = 0;
  let eligible = 0;
  let ineligible = 0;
  let alreadyCurrent = 0;
  let wouldCreate = 0;
  let wouldUpdate = 0;
  let wouldDelete = 0;
  let malformed = 0;
  let errors = 0;
  let maxTokenCount = 0;
  let lastId = after;
  let cursor = after || null;

  while (scanned < limit) {
    let query = db.collection('posts').orderBy(FieldPath.documentId()).limit(Math.min(100, Math.max(1, Number.isFinite(limit) ? limit - scanned : 100)));
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const snapshot of page.docs) {
      if (scanned >= limit) break;
      scanned += 1;
      lastId = snapshot.id;
      cursor = snapshot.id;
      let projection = null;
      try { projection = buildPostSearchIndex(snapshot.data(), snapshot.id); } catch (error) {
        malformed += 1;
        if (execute) {
          try {
            await syncPostSearchIndex(db, snapshot.id);
          } catch (syncError) {
            errors += 1;
            console.error('backfill_malformed_sync_error', syncError?.code || 'unknown');
          }
        }
        continue;
      }
      const indexSnapshot = await db.doc(`postSearchIndex/${snapshot.id}`).get();
      if (!projection) {
        ineligible += 1;
        if (indexSnapshot.exists) wouldDelete += 1;
        if (execute && indexSnapshot.exists) await syncPostSearchIndex(db, snapshot.id);
        continue;
      }
      eligible += 1;
      maxTokenCount = Math.max(maxTokenCount, projection.searchTokens.length);
      if (!indexSnapshot.exists) wouldCreate += 1;
      else if (indexSnapshot.data()?.sourceVersion === projection.sourceVersion
        && Number(indexSnapshot.data()?.schemaVersion) === SEARCH_SCHEMA_VERSION
        && Number(indexSnapshot.data()?.normalizerVersion) === SEARCH_NORMALIZER_VERSION) alreadyCurrent += 1;
      else wouldUpdate += 1;
      if (execute) {
        try { await syncPostSearchIndex(db, snapshot.id); } catch (error) { errors += 1; console.error('backfill_error', snapshot.id, error?.code || 'unknown'); }
      }
    }
    if (page.size < 100) break;
  }

  console.log(JSON.stringify({ scanned, eligible, ineligible, alreadyCurrent, wouldCreate, wouldUpdate, wouldDelete, malformed, errors, maxTokenCount, lastId: lastId || null }));
  if (!execute) console.log('Dry-run complete. Re-run with --execute only after the report and project guard are verified.');
}

main().catch(error => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
