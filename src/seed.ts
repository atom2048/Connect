import {
  doc, getDoc, setDoc, collection, addDoc, getDocs,
  query, where, orderBy, limit, serverTimestamp, increment,
  writeBatch,
} from 'firebase/firestore';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { db, auth } from './firebase.ts';
import { generateAvatarColor } from './utils.ts';
import type { TimestampLike } from './types/domain.ts';

declare global {
  interface Window {
    __SEEDING_IN_PROGRESS?: boolean;
  }
}

interface FirebaseAuthError {
  code?: string;
}

interface DemoUserSeed {
  name: string;
  email: string;
  password: string;
  color?: string;
  bio?: string;
}

interface DemoPostSeed {
  userIdx: number;
  text: string;
  mood?: string;
  location?: string;
}

interface DemoCommentSeed {
  postIdx: number;
  userIdx: number;
  text: string;
}

interface DemoLikeSeed {
  postIdx: number;
  userIdx: number;
}

interface DemoAdSeed {
  advertiser: string;
  title: string;
  body: string;
  imageURL: string;
  ctaText: string;
  ctaLink: string;
}

type DemoFriendshipSeed = readonly [number, number];

interface CreatedDemoUser extends DemoUserSeed {
  uid: string;
}

interface CreateUserProfileInput {
  uid: string;
  displayName: string;
  username: string;
  email: string;
  photoURL: string;
  coverURL: string;
  avatarColor: string;
  bio: string;
  friendsCount: number;
  createdAt: TimestampLike | unknown;
}

interface CreatePostInput {
  userId: string;
  text: string;
  imageURL: string;
  mood: string;
  location: string;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  createdAt: Date;
}

function isFirebaseAuthError(error: unknown): error is FirebaseAuthError {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export const DEMO_USERS: DemoUserSeed[] = [
  { name: 'Zuck', email: 'zuck@demo.com', password: 'demo123456', color: '#1877F2', bio: 'Building the future of social connection. Founder of Meta.' },
  { name: 'Samay', email: 'samay@demo.com', password: 'demo123456', color: '#8B5CF6', bio: 'Stand-up comedian. Making people laugh, one joke at a time.' },
  { name: 'Emma', email: 'emma@demo.com', password: 'demo123456', color: '#14B8A6', bio: 'Writer & storyteller. Words are my superpower.' },
];

const DEMO_POSTS: DemoPostSeed[] = [
  { userIdx: 0, text: 'Just launched a new feature! Excited to see how everyone likes it. The team has been working really hard on this one. 🚀', mood: '嬉しい', location: 'Meta HQ' },
  { userIdx: 0, text: 'Great meeting with the team today. We discussed some really innovative ideas for connecting people around the world. The future is bright!', location: 'Conference Room' },
  { userIdx: 1, text: 'Did a show in Tokyo tonight! The crowd was absolutely amazing. Nothing beats the energy of a live audience! 🎤', mood: '最高', location: 'Tokyo' },
  { userIdx: 1, text: 'New material alert! Been working on this set for weeks and I think it\'s finally ready. Can\'t wait to test it out at the next show.', mood: 'ワクワク' },
  { userIdx: 2, text: 'Published my latest article about the future of AI in creative writing. Check it out and let me know your thoughts! ✍️', mood: '達成', location: 'Cafe' },
  { userIdx: 2, text: 'Writer\'s block is real, but I\'ve found that a long walk and good music always helps. Back to the keyboard!', mood: '思索', location: 'River Side' },
];

const DEMO_COMMENTS: DemoCommentSeed[] = [
  { postIdx: 0, userIdx: 1, text: 'This sounds exciting. Looking forward to seeing it grow!' },
  { postIdx: 1, userIdx: 2, text: 'Connecting people through stories is such a strong direction.' },
  { postIdx: 2, userIdx: 2, text: 'Your shows are always amazing! 🙌' },
  { postIdx: 2, userIdx: 1, text: 'Thanks! The energy was incredible tonight!' },
  { postIdx: 4, userIdx: 0, text: 'Great topic. AI and creativity are moving fast.' },
  { postIdx: 5, userIdx: 1, text: 'A walk and good music fixes more than people think.' },
];

const DEMO_LIKES: DemoLikeSeed[] = [
  { postIdx: 0, userIdx: 1 }, { postIdx: 0, userIdx: 2 },
  { postIdx: 1, userIdx: 1 }, { postIdx: 1, userIdx: 2 },
  { postIdx: 2, userIdx: 0 }, { postIdx: 2, userIdx: 2 },
  { postIdx: 3, userIdx: 0 }, { postIdx: 3, userIdx: 2 },
  { postIdx: 4, userIdx: 0 }, { postIdx: 4, userIdx: 1 },
  { postIdx: 5, userIdx: 0 }, { postIdx: 5, userIdx: 1 },
];

const DEMO_ADS: DemoAdSeed[] = [
  {
    advertiser: 'TechStart',
    title: 'クラウドエンジニア募集中',
    body: '最新技術で社会を変えるエンジニアを募集しています。リモート可、業界最高水準の待遇。あなたのスキルを最大限活かせる環境です。',
    imageURL: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=400&h=200&fit=crop',
    ctaText: '詳細を見る',
    ctaLink: 'https://example.com/careers',
  },
  {
    advertiser: 'CodeCamp',
    title: 'プログラミング無料体験実施中',
    body: '2週間の無料トライアルでプログラミングを始めよう！初心者歓迎、オンライン完結。メンターがあなたの学習をサポートします。',
    imageURL: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400&h=200&fit=crop',
    ctaText: '無料登録',
    ctaLink: 'https://example.com/codecamp',
  },
  {
    advertiser: 'GreenEats',
    title: 'サステナブル食品サブスク',
    body: '環境に優しい食材を毎週お届け。初月50% OFFクーポンプレゼント！健康的でエコな食生活を始めませんか？',
    imageURL: 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=400&h=200&fit=crop',
    ctaText: '詳細を見る',
    ctaLink: 'https://example.com/greeneats',
  },
  {
    advertiser: 'FitLife',
    title: 'オンラインフィットネス始めよう',
    body: '自宅で本格トレーニング。初月無料キャンペーン実施中！プロのトレーナーがあなたを目標達成まで導きます。',
    imageURL: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=400&h=200&fit=crop',
    ctaText: '無料で始める',
    ctaLink: 'https://example.com/fitlife',
  },
];

const FRIENDSHIPS: DemoFriendshipSeed[] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

/**
 * シードが既に実行されたかチェック
 */
export async function isSeedDone(): Promise<boolean> {
  try {
    const seedRef = doc(db, '_seed', 'done');
    const snap = await getDoc(seedRef);
    return snap.exists();
  } catch (e) {
    return false;
  }
}

/**
 * デモデータを生成
 */
export async function seedDemoData(): Promise<void> {
  const alreadySeeded = await isSeedDone();
  if (alreadySeeded) {
    throw new Error('データは既に作成済みです');
  }

  // Auth state changes during user creation break the app.
  // Set a global flag so the auth listener ignores changes during seeding.
  window.__SEEDING_IN_PROGRESS = true;

  const createdUsers: Array<CreatedDemoUser | undefined> = [];

  // 1. ユーザープロフィール作成（既存AuthユーザーをFirestoreに探索）
  for (const [idx, userData] of DEMO_USERS.entries()) {
    try {
      let uid: string | undefined;
      // Try to find existing user by email in Auth (sign-in attempt)
      try {
        const cred = await signInWithEmailAndPassword(auth, userData.email, userData.password);
        uid = cred.user.uid;
        // Sign back out so auth state doesn't bounce around
        await signOut(auth);
      } catch (signInError) {
        // User may not exist yet → try to create
        if (isFirebaseAuthError(signInError) && signInError.code === 'auth/user-not-found') {
          try {
            const cred = await createUserWithEmailAndPassword(auth, userData.email, userData.password);
            uid = cred.user.uid;
            await signOut(auth);
          } catch (createError) {
            if (isFirebaseAuthError(createError) && createError.code === 'auth/email-already-in-use') {
              const usersRef = collection(db, 'users');
              const q = query(usersRef, where('email', '==', userData.email), limit(1));
              const snap = await getDocs(q);
              if (!snap.empty) {
                const existingUserDoc = snap.docs[0];
                if (existingUserDoc) {
                  uid = existingUserDoc.id;
                  createdUsers[idx] = { uid, ...userData };
                }
              }
            }
            if (!uid) throw createError;
          }
        } else {
          throw signInError;
        }
      }

      if (!uid) continue;

      const color = userData.color || generateAvatarColor(userData.name);
      const profileInput: CreateUserProfileInput = {
        uid,
        displayName: userData.name,
        username: userData.name.toLowerCase(),
        email: userData.email,
        photoURL: '',
        coverURL: '',
        avatarColor: color,
        bio: userData.bio || '',
        friendsCount: 0,
        createdAt: serverTimestamp(),
      };
      await setDoc(doc(db, 'users', uid), profileInput);
      createdUsers[idx] = { uid, ...userData };
    } catch (e) {
      console.error(`Failed to create user ${userData.name}:`, e);
    }
  }

  if (createdUsers.length === 0) {
    window.__SEEDING_IN_PROGRESS = false;
    throw new Error('ユーザー作成に失敗しました');
  }

  const batch = writeBatch(db);

  // 2. 投稿作成
  const postIds: string[] = [];
  const postCreationTimes: Date[] = [];
  const now = Date.now();
  for (const [idx, postData] of DEMO_POSTS.entries()) {
    const userIdx = postData.userIdx;
    if (!createdUsers[userIdx]) continue;
    const postRef = doc(collection(db, 'posts'));
    const createdAt = new Date(now - (DEMO_POSTS.length - idx) * 3600000); // 1時間ごとにさかのぼる
    const createdUser = createdUsers[userIdx];
    if (!createdUser) continue;
    const postInput: CreatePostInput = {
      userId: createdUser.uid,
      text: postData.text,
      imageURL: '',
      mood: postData.mood || '',
      location: postData.location || '',
      likesCount: DEMO_LIKES.filter(l => l.postIdx === idx).length,
      commentsCount: DEMO_COMMENTS.filter(c => c.postIdx === idx).length,
      sharesCount: Math.floor(Math.random() * 10),
      createdAt,
    };
    batch.set(postRef, postInput);
    postIds.push(postRef.id);
    postCreationTimes.push(createdAt);
  }

  // 3. 広告作成
  for (const adData of DEMO_ADS) {
    const adRef = doc(collection(db, 'ads'));
    batch.set(adRef, {
      ...adData,
      createdAt: new Date(),
    });
  }

  await batch.commit();
  console.log('Posts and ads created');

  // 4. コメント作成（個別に追加）
  for (const [idx, commentData] of DEMO_COMMENTS.entries()) {
    try {
      const postIdx = commentData.postIdx;
      const userIdx = commentData.userIdx;
      if (!createdUsers[userIdx] || !postIds[postIdx]) continue;
      await addDoc(collection(db, 'comments'), {
        postId: postIds[postIdx],
        userId: createdUsers[userIdx].uid,
        text: commentData.text,
        parentId: null,
        createdAt: new Date((postCreationTimes[postIdx]?.getTime() ?? now) + (idx + 1) * 60000),
      });
    } catch (e) {
      console.error('Comment creation error:', e);
    }
  }

  // 5. いいね作成
  for (const likeData of DEMO_LIKES) {
    try {
      const postIdx = likeData.postIdx;
      const userIdx = likeData.userIdx;
      if (!createdUsers[userIdx] || !postIds[postIdx]) continue;
      const likeId = `${postIds[postIdx]}_${createdUsers[userIdx].uid}`;
      await setDoc(doc(db, 'likes', likeId), {
        postId: postIds[postIdx],
        userId: createdUsers[userIdx].uid,
        createdAt: new Date(),
      });
    } catch (e) {
      console.error('Like creation error:', e);
    }
  }

  // 6. 友情関係作成
  for (const [u1, u2] of FRIENDSHIPS) {
    try {
      if (!createdUsers[u1] || !createdUsers[u2]) continue;
      const friendshipId = [createdUsers[u1].uid, createdUsers[u2].uid].sort().join('_');
      await setDoc(doc(db, 'friendships', friendshipId), {
        userId: createdUsers[u1].uid,
        friendId: createdUsers[u2].uid,
        status: 'accepted',
        requester: createdUsers[u1].uid,
        createdAt: new Date(),
      });
      // 友達数を更新
      const ref1 = doc(db, 'users', createdUsers[u1].uid);
      const ref2 = doc(db, 'users', createdUsers[u2].uid);
      await setDoc(ref1, { friendsCount: increment(1) }, { merge: true });
      await setDoc(ref2, { friendsCount: increment(1) }, { merge: true });
    } catch (e) {
      console.error('Friendship creation error:', e);
    }
  }

  // 7. シード完了フラグ
  await setDoc(doc(db, '_seed', 'done'), {
    done: true,
    createdAt: new Date(),
  });

  // Zuck としてログイン（シード後、誰かがログイン状態である必要がある）
  window.__SEEDING_IN_PROGRESS = false;
  try {
    await signInWithEmailAndPassword(auth, DEMO_USERS[0].email, DEMO_USERS[0].password);
  } catch (e) {
    // ログインできなくても続行
  }
  console.log('Seed completed successfully!');
}
