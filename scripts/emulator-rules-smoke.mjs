import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteApp as deleteClientApp, initializeApp as initializeClientApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore as getClientFirestore,
  collection,
  query,
  setDoc,
  updateDoc,
  Timestamp as ClientTimestamp,
} from 'firebase/firestore';
import {
  connectStorageEmulator,
  getBytes,
  getStorage as getClientStorage,
  listAll,
  ref,
  uploadBytes,
} from 'firebase/storage';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, Timestamp as AdminTimestamp } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'demo-connect';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const progressPath = join(tmpdir(), 'connect-rules-smoke-progress.log');

try {
  writeFileSync(progressPath, '', 'utf8');
} catch {
  // Console checkpoints remain available when the temp directory is read-only.
}

function checkpoint(label) {
  const line = `${new Date().toISOString()} ${label}\n`;
  try { appendFileSync(progressPath, line, 'utf8'); } catch { /* best effort diagnostics */ }
  console.log(`CHECKPOINT ${label}`);
}

function splitHost(value) {
  const [host, portText] = value.split(':');
  return { host, port: Number(portText) };
}

function isDenied(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return code === 'permission-denied'
    || code === 'storage/unauthorized'
    || message.includes('permission_denied')
    || message.includes('permission denied')
    || message.includes('missing or insufficient permissions')
    || message.includes('unauthorized');
}

function createReporter() {
  const results = [];
  async function allowed(label, operation) {
    try {
      await operation();
      results.push({ status: 'PASS', label });
    } catch (error) {
      results.push({ status: 'FAIL', label, detail: String(error?.code || error?.message || error) });
    }
  }
  async function denied(label, operation) {
    try {
      await operation();
      results.push({ status: 'FAIL', label, detail: 'operation unexpectedly succeeded' });
    } catch (error) {
      results.push(isDenied(error)
        ? { status: 'PASS', label }
        : { status: 'FAIL', label, detail: `unexpected error: ${String(error?.code || error?.message || error)}` });
    }
  }
  return { results, allowed, denied };
}

function assertNoFailures(results) {
  const failures = results.filter(result => result.status === 'FAIL');
  for (const result of results) {
    console.log(`${result.status} ${result.label}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  if (failures.length) {
    throw new Error(`${failures.length} emulator smoke test(s) failed`);
  }
}

async function main() {
  const { host: firestoreEmulatorHost, port: firestorePort } = splitHost(firestoreHost);
  const { host: authEmulatorHost, port: authPort } = splitHost(authHost);
  const { host: storageEmulatorHost, port: storagePort } = splitHost(storageHost);

  // Admin SDK bypassing Rules is intentional: it seeds canonical/server-only
  // documents so that client-side Rules access can be tested against them.
  process.env.STORAGE_EMULATOR_HOST = `http://${storageHost}`;
  const adminApp = initializeAdminApp({
    projectId,
    storageBucket: `${projectId}.appspot.com`,
  }, `rules-smoke-admin-${Date.now()}`);
  const adminDb = getAdminFirestore(adminApp);
  const adminBucket = getAdminStorage(adminApp).bucket();

  const clientApp = initializeClientApp({
    apiKey: 'demo-api-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: `${projectId}.appspot.com`,
    appId: 'demo-app-id',
  }, `rules-smoke-client-${Date.now()}`);
  const auth = getAuth(clientApp);
  connectAuthEmulator(auth, `http://${authEmulatorHost}:${authPort}`, { disableWarnings: true });
  const clientDb = getClientFirestore(clientApp);
  connectFirestoreEmulator(clientDb, firestoreEmulatorHost, firestorePort);
  const clientStorage = getClientStorage(clientApp);
  connectStorageEmulator(clientStorage, storageEmulatorHost, storagePort);
  const otherClientApp = initializeClientApp({
    apiKey: 'demo-api-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: `${projectId}.appspot.com`,
    appId: 'demo-app-id-other',
  }, `rules-smoke-other-client-${Date.now()}`);
  const otherAuth = getAuth(otherClientApp);
  connectAuthEmulator(otherAuth, `http://${authEmulatorHost}:${authPort}`, { disableWarnings: true });
  const otherClientDb = getClientFirestore(otherClientApp);
  connectFirestoreEmulator(otherClientDb, firestoreEmulatorHost, firestorePort);
  checkpoint('before-auth');
  const signedIn = await signInAnonymously(auth);
  await signInAnonymously(otherAuth);
  checkpoint('after-auth');
  const uid = signedIn.user.uid;
  const now = ClientTimestamp.now();
  const postId = `rules-smoke-post-${uid}`;
  const commentId = `rules-smoke-comment-${uid}`;
  const conversationId = `rules-smoke-conversation-${uid}`;
  const dmObjectPath = `dm/${uid}/legacy-attachment.txt`;
  const postObjectPath = `posts/${uid}/rules-smoke.png`;
  const profileObjectPath = `profiles/${uid}/rules-smoke.png`;
  const commentObjectPath = `comments/${uid}/rules-smoke.png`;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  checkpoint('clients-ready');

  await adminDb.collection('conversations').doc(conversationId).set({
    participantIds: [uid],
    createdAt: AdminTimestamp.now(),
  });
  await adminDb.collection('conversations').doc(conversationId).collection('messages').doc('legacy-message').set({
    senderId: uid,
    text: 'legacy message fixture',
    createdAt: AdminTimestamp.now(),
  });
  await adminDb.collection('hashtags').doc('ai').set({ tag: 'ai', count: 1 });
  checkpoint('firestore-seeds-ready');
  checkpoint('before-storage-seed');
  await adminBucket.file(dmObjectPath).save(Buffer.from('legacy attachment'), {
    resumable: false,
    metadata: { contentType: 'text/plain' },
  });
  checkpoint('storage-seed-ready');

  const reporter = createReporter();
  const { allowed, denied, results } = reporter;

  await allowed('profile create', () => setDoc(doc(clientDb, 'users', uid), {
    uid,
    username: `rules_${uid.slice(0, 8)}`,
    displayName: 'Rules smoke user',
  }));
  await allowed('profile update', () => updateDoc(doc(clientDb, 'users', uid), { displayName: 'Rules smoke user updated' }));
  checkpoint('profile-rules-ready');

  await allowed('post create', () => setDoc(doc(clientDb, 'posts', postId), {
    userId: uid,
    text: 'rules smoke post',
    visibility: 'public',
    createdAt: now,
    updatedAt: now,
    hashtags: ['ai'],
  }));
  await allowed('post edit', () => updateDoc(doc(clientDb, 'posts', postId), { text: 'rules smoke post edited' }));

  // This mirrors the current legacy-client post path: post writes are
  // independent of the retired hashtag aggregate writer.
  await denied('client hashtag aggregate create denied', () => setDoc(doc(clientDb, 'hashtags', `client-${uid}`), { tag: 'client', count: 1 }));
  await denied('client hashtag aggregate update denied', () => updateDoc(doc(clientDb, 'hashtags', 'ai'), { count: 2 }));
  await denied('client hashtag aggregate delete denied', () => deleteDoc(doc(clientDb, 'hashtags', 'ai')));

  await allowed('comment create', () => setDoc(doc(clientDb, 'comments', commentId), {
    userId: uid,
    postId,
    text: 'rules smoke comment',
    createdAt: now,
    likesCount: 0,
  }));
  await allowed('comment owner content update', () => updateDoc(doc(clientDb, 'comments', commentId), {
    text: 'rules smoke comment edited',
    mentions: [],
    editedAt: ClientTimestamp.now(),
  }));
  await denied('comment non-owner content update denied', () => updateDoc(doc(otherClientDb, 'comments', commentId), {
    text: 'forged comment edit',
  }));
  await allowed('comment likes-count update', () => updateDoc(doc(clientDb, 'comments', commentId), { likesCount: 1 }));
  await allowed('comment delete', () => deleteDoc(doc(clientDb, 'comments', commentId)));
  checkpoint('post-comment-rules-ready');

  await allowed('Phase A conversation read', () => getDoc(doc(clientDb, 'conversations', conversationId)));
  await allowed('Phase A message read', () => getDoc(doc(clientDb, 'conversations', conversationId, 'messages', 'legacy-message')));
  await denied('Phase A conversation create denied', () => setDoc(doc(clientDb, 'conversations', `new-${uid}`), { participantIds: [uid] }));
  await denied('Phase A message create denied', () => setDoc(doc(clientDb, 'conversations', conversationId, 'messages', 'new-message'), { senderId: uid, text: 'blocked' }));
  await denied('Phase A message update denied', () => updateDoc(doc(clientDb, 'conversations', conversationId, 'messages', 'legacy-message'), { readBy: [uid] }));
  await denied('Phase A message delete denied', () => deleteDoc(doc(clientDb, 'conversations', conversationId, 'messages', 'legacy-message')));
  await denied('Phase A typing write denied', () => setDoc(doc(clientDb, 'conversations', conversationId, 'typing', uid), { active: true }));
  await denied('Phase A call signaling write denied', () => setDoc(doc(clientDb, 'conversations', conversationId, 'calls', 'call-1'), { from: uid }));
  checkpoint('dm-rules-ready');

  const searchIndexRef = adminDb.collection('postSearchIndex').doc(postId);
  await searchIndexRef.set({
    postId,
    authorId: uid,
    createdAt: AdminTimestamp.now(),
    sourceVersion: 'fixture-source-version',
    normalizedText: 'rules smoke post edited',
    searchTokens: ['t2:sm', 't3:smo'],
    schemaVersion: 1,
    normalizerVersion: 1,
    indexedAt: AdminTimestamp.now(),
  });
  await allowed('Admin seed of server-only postSearchIndex', () => searchIndexRef.get());
  await denied('postSearchIndex client get denied', () => getDoc(doc(clientDb, 'postSearchIndex', postId)));
  await denied('postSearchIndex client list/query denied', () => getDocs(query(collection(clientDb, 'postSearchIndex'))));
  await denied('postSearchIndex client create denied', () => setDoc(doc(clientDb, 'postSearchIndex', `client-${uid}`), { postId: 'client' }));
  await denied('postSearchIndex client update denied', () => updateDoc(doc(clientDb, 'postSearchIndex', postId), { normalizedText: 'tampered' }));
  await denied('postSearchIndex client delete denied', () => deleteDoc(doc(clientDb, 'postSearchIndex', postId)));
  checkpoint('search-index-rules-ready');

  await allowed('Phase A DM attachment read', async () => {
    const bytes = await getBytes(ref(clientStorage, dmObjectPath));
    if (Buffer.from(bytes).toString('utf8') !== 'legacy attachment') throw new Error('unexpected DM fixture bytes');
  });
  await allowed('Phase A DM attachment list', async () => {
    const listing = await listAll(ref(clientStorage, `dm/${uid}`));
    if (!listing.items.some(item => item.fullPath === dmObjectPath)) throw new Error('DM fixture not listed');
  });
  await denied('Phase A DM attachment create denied', () => uploadBytes(ref(clientStorage, `dm/${uid}/new.txt`), new TextEncoder().encode('blocked'), { contentType: 'text/plain' }));
  await denied('Phase A DM attachment update denied', () => uploadBytes(ref(clientStorage, dmObjectPath), new TextEncoder().encode('blocked'), { contentType: 'text/plain' }));
  checkpoint('dm-storage-rules-ready');

  await allowed('post attachment write', () => uploadBytes(ref(clientStorage, postObjectPath), png, { contentType: 'image/png' }));
  await allowed('profile attachment write', () => uploadBytes(ref(clientStorage, profileObjectPath), png, { contentType: 'image/png' }));
  await allowed('comment attachment write', () => uploadBytes(ref(clientStorage, commentObjectPath), png, { contentType: 'image/png' }));
  checkpoint('ordinary-storage-rules-ready');

  checkpoint('before-final-post-delete');
  // Confirm that the post lifecycle still succeeds after the aggregate deny.
  await allowed('legacy-client-equivalent post delete after aggregate deny', () => deleteDoc(doc(clientDb, 'posts', postId)));
  checkpoint('after-final-post-delete');

  // The emulator process is ephemeral and is torn down by `emulators:exec`,
  // so cleanup is intentionally not awaited here. This avoids making a
  // successful Rules result depend on Storage emulator cleanup behavior.

  assertNoFailures(results);
  await deleteClientApp(clientApp);
  await deleteClientApp(otherClientApp);
  await deleteAdminApp(adminApp);
  console.log(`PASS Emulator Rules smoke completed for project ${projectId}`);
}

main().catch(error => {
  console.error(`FAIL Emulator Rules smoke: ${String(error?.stack || error)}`);
  process.exitCode = 1;
});
