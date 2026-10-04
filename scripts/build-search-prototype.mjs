import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { buildPostSearchIndex } from '../functions/lib/search-index.js';

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const explicitDryRun = args.has('--dry-run');
if (execute && explicitDryRun) throw new Error('--execute and --dry-run cannot be used together');
const limitArg = process.argv.find(value => value.startsWith('--limit='));
const afterArg = process.argv.find(value => value.startsWith('--after='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 1000;
const after = afterArg ? afterArg.slice('--after='.length) : '';
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');

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

async function main() {
  const db = initializeAdmin();
  const actualProject = projectId();
  const expectedProject = process.env.EXPECTED_FIREBASE_PROJECT_ID || actualProject;
  if (!actualProject) throw new Error('Firebase project ID is not available');
  if (execute && actualProject !== expectedProject) throw new Error(`Refusing execute in unexpected Firebase project: ${actualProject}`);
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', projectId: actualProject, databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)', targetCollection: 'postSearchIndexPrototype', limit, after: after || null }));

  let cursor = after || null;
  let scanned = 0;
  let eligible = 0;
  let malformed = 0;
  let written = 0;
  let lastId = after;
  while (scanned < limit) {
    let query = db.collection('posts').orderBy(FieldPath.documentId()).limit(Math.min(100, limit - scanned));
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const snapshot of page.docs) {
      if (scanned >= limit) break;
      scanned += 1;
      cursor = snapshot.id;
      lastId = snapshot.id;
      let index;
      try { index = buildPostSearchIndex(snapshot.data(), snapshot.id, Timestamp.now()); } catch { malformed += 1; continue; }
      if (!index) continue;
      eligible += 1;
      if (execute) {
        await db.doc(`postSearchIndexPrototype/${snapshot.id}`).set({ ...index, prototype: true }, { merge: false });
        written += 1;
      }
    }
    if (page.size < Math.min(100, limit - (scanned - page.size))) break;
  }
  console.log(JSON.stringify({ scanned, eligible, malformed, written, lastId: lastId || null }));
  if (!execute) console.log('Prototype dry-run complete. Use --execute only for a bounded non-production prototype collection.');
}

main().catch(error => { console.error(error?.message || error); process.exitCode = 1; });
