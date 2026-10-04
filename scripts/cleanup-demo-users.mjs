import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const EXECUTE = process.argv.includes('--execute');

const TARGETS = [
  { displayName: 'Guest', username: 'guest', email: 'guest@demo.com' },
  { displayName: 'Alex', username: 'alex', email: 'alex@demo.com' },
  { displayName: 'Mika', username: 'mika', email: 'mika@demo.com' },
  { displayName: 'Haru', username: 'haru', email: 'haru@demo.com' },
  { displayName: 'Yui', username: 'yui', email: 'yui@demo.com' },
  { displayName: 'Ren', username: 'ren', email: 'ren@demo.com' },
  { displayName: 'Sora', username: 'sora', email: 'sora@demo.com' },
  { displayName: 'Kai', username: 'kai', email: 'kai@demo.com' },
  { displayName: 'Lina', username: 'lina', email: 'lina@demo.com' },
  { displayName: 'Taro', username: 'taro', email: 'taro@demo.com' },
  { displayName: 'Sakura', username: 'sakura', email: 'sakura@demo.com' },
  // Keep lowercase @hikakin. Only the exact uppercase demo account is removable.
  { displayName: 'HIKAKIN', username: 'HIKAKIN', email: 'hikakin@demo.com', exactUsername: true },
];

const KEEP_USERNAMES = new Set(['hikakin', 'zuck', 'samay', 'emma']);

function initializeAdmin() {
  if (getApps().length) return;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    });
    return;
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      [
        'Firebase Admin credential is required.',
        'Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service account JSON path,',
        'or set FIREBASE_SERVICE_ACCOUNT_JSON to the full service account JSON string.',
        'This script refuses to use normal app credentials because it deletes production users.',
      ].join(' '),
    );
  }

  initializeApp({ credential: applicationDefault() });
}

async function getCount(query) {
  const snap = await query.count().get();
  return snap.data().count || 0;
}

async function findFirestoreUsers(db, target) {
  const found = new Map();
  const addDocs = (snap) => snap.docs.forEach((doc) => found.set(doc.id, { uid: doc.id, ...doc.data() }));

  addDocs(await db.collection('users').where('email', '==', target.email).get());
  addDocs(await db.collection('users').where('username', '==', target.username).get());
  addDocs(await db.collection('users').where('displayName', '==', target.displayName).get());

  return [...found.values()].filter((user) => {
    const username = String(user.username || '');
    const email = String(user.email || '');
    const name = String(user.displayName || '');

    if (target.exactUsername && username !== target.username) return false;
    if (!target.exactUsername && username.toLowerCase() !== target.username.toLowerCase() && email !== target.email && name !== target.displayName) return false;
    if (KEEP_USERNAMES.has(username) || username === 'hikakin') return false;

    return email === target.email || username === target.username || name === target.displayName;
  });
}

async function findAuthUser(auth, target) {
  try {
    return await auth.getUserByEmail(target.email);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  }
}

async function countAuthoredContent(db, uid) {
  const [posts, stories] = await Promise.all([
    getCount(db.collection('posts').where('userId', '==', uid)),
    getCount(db.collection('stories').where('authorId', '==', uid)),
  ]);
  return { posts, stories, total: posts + stories };
}

async function deleteQuery(db, query, label, summary) {
  const snap = await query.get();
  if (snap.empty) return;

  summary.deletedRelated[label] = (summary.deletedRelated[label] || 0) + snap.size;
  if (!EXECUTE) return;

  let batch = db.batch();
  let ops = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    ops += 1;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
}

async function cleanupRelatedData(db, uid, summary) {
  const simpleUserFields = [
    ['comments', 'userId'],
    ['likes', 'userId'],
    ['reposts', 'userId'],
    ['storyViews', 'viewerId'],
    ['storyReactions', 'senderId'],
    ['notifications', 'userId'],
    ['notifications', 'fromUserId'],
  ];

  for (const [collection, field] of simpleUserFields) {
    await deleteQuery(db, db.collection(collection).where(field, '==', uid).limit(500), `${collection}.${field}`, summary);
  }

  await deleteQuery(db, db.collection('friendships').where('userId', '==', uid).limit(500), 'friendships.userId', summary);
  await deleteQuery(db, db.collection('friendships').where('friendId', '==', uid).limit(500), 'friendships.friendId', summary);

  const conversationSnap = await db.collection('conversations').where('participants', 'array-contains', uid).limit(500).get();
  summary.deletedRelated.conversationsWithUser = conversationSnap.size;
  if (EXECUTE) {
    for (const conv of conversationSnap.docs) {
      const data = conv.data();
      const participants = Array.isArray(data.participants) ? data.participants.filter((id) => id !== uid) : [];
      await conv.ref.update({
        participants,
        formerParticipants: FieldValue.arrayUnion(uid),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }
}

async function maybeDeleteUser(db, auth, target) {
  const authUser = await findAuthUser(auth, target);
  const firestoreUsers = await findFirestoreUsers(db, target);
  if (authUser && !firestoreUsers.some((user) => user.uid === authUser.uid)) {
    firestoreUsers.push({
      uid: authUser.uid,
      email: authUser.email,
      username: target.username,
      displayName: authUser.displayName || target.displayName,
      authOnly: true,
    });
  }

  const summaries = [];
  for (const user of firestoreUsers) {
    const username = String(user.username || '');
    const summary = {
      target: target.username,
      uid: user.uid,
      email: user.email || target.email,
      username,
      displayName: user.displayName || '',
      deleted: false,
      skipped: '',
      deletedRelated: {},
    };

    if (KEEP_USERNAMES.has(username) || username === 'hikakin') {
      summary.skipped = 'protected username';
      summaries.push(summary);
      continue;
    }

    const authored = await countAuthoredContent(db, user.uid);
    summary.authored = authored;
    if (authored.total > 0) {
      summary.skipped = `authored content exists: posts=${authored.posts}, stories=${authored.stories}`;
      summaries.push(summary);
      continue;
    }

    await cleanupRelatedData(db, user.uid, summary);

    if (EXECUTE) {
      await db.collection('users').doc(user.uid).delete().catch((error) => {
        if (error.code !== 5) throw error;
      });
      await auth.deleteUser(user.uid).catch((error) => {
        if (error.code !== 'auth/user-not-found') throw error;
      });
    }

    summary.deleted = true;
    summaries.push(summary);
  }

  if (!summaries.length) {
    summaries.push({
      target: target.username,
      email: target.email,
      deleted: false,
      skipped: 'not found',
      deletedRelated: {},
    });
  }

  return summaries;
}

try {
  initializeAdmin();
  const db = getFirestore();
  const auth = getAuth();

  console.log(EXECUTE ? 'EXECUTE mode: deleting safe zero-post demo users.' : 'DRY RUN mode: no data will be deleted. Add -- --execute to delete.');

  const allSummaries = [];
  for (const target of TARGETS) {
    const summaries = await maybeDeleteUser(db, auth, target);
    allSummaries.push(...summaries);
  }

  console.table(allSummaries.map((item) => ({
    target: item.target,
    username: item.username || '',
    email: item.email || '',
    uid: item.uid || '',
    posts: item.authored?.posts ?? '',
    stories: item.authored?.stories ?? '',
    deleted: item.deleted,
    skipped: item.skipped,
  })));

  const protectedSkipped = allSummaries.filter((item) => item.skipped && item.skipped !== 'not found');
  if (protectedSkipped.length) {
    console.log('\nSkipped for safety:');
    for (const item of protectedSkipped) {
      console.log(`- ${item.username || item.target} (${item.uid}): ${item.skipped}`);
    }
  }

  if (!EXECUTE) {
    console.log('\nDry run complete. If the table is correct, run: npm run admin:cleanup-demo-users -- --execute');
  }
} catch (error) {
  console.error('\nCleanup failed safely.');
  console.error(error.message || error);
  process.exitCode = 1;
}
