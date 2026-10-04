declare module 'firebase/app' {
  export interface FirebaseOptions {
    apiKey?: string;
    authDomain?: string;
    projectId?: string;
    storageBucket?: string;
    messagingSenderId?: string;
    appId?: string;
  }
  export interface FirebaseApp {
    name: string;
    options: FirebaseOptions;
  }
  export function initializeApp(options: FirebaseOptions): FirebaseApp;
}

declare module 'firebase/auth' {
  import type { FirebaseApp } from 'firebase/app';

  export interface User {
    uid: string;
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
    getIdToken(forceRefresh?: boolean): Promise<string>;
    getIdTokenResult(forceRefresh?: boolean): Promise<{ claims: Record<string, unknown> }>;
  }

  export interface Auth {
    languageCode: string | null;
    currentUser: User | null;
  }

  export interface UserCredential {
    user: User;
  }

  export interface AuthProvider {
    providerId: string;
  }

  export class GoogleAuthProvider implements AuthProvider {
    providerId: string;
  }
  export class GithubAuthProvider implements AuthProvider {
    providerId: string;
  }
  export class FacebookAuthProvider implements AuthProvider {
    providerId: string;
  }
  export class OAuthProvider implements AuthProvider {
    providerId: string;
    constructor(providerId: string);
  }

  export function getAuth(app?: FirebaseApp): Auth;
  export function createUserWithEmailAndPassword(auth: Auth, email: string, password: string): Promise<UserCredential>;
  export function signInWithEmailAndPassword(auth: Auth, email: string, password: string): Promise<UserCredential>;
  export function signInWithPopup(auth: Auth, provider: AuthProvider): Promise<UserCredential>;
  export function signOut(auth: Auth): Promise<void>;
  export function onAuthStateChanged(auth: Auth, callback: (user: User | null) => void | Promise<void>): () => void;
  export function sendPasswordResetEmail(auth: Auth, email: string): Promise<void>;
  export function confirmPasswordReset(auth: Auth, code: string, newPassword: string): Promise<void>;
  export function verifyPasswordResetCode(auth: Auth, code: string): Promise<string>;
}

declare module 'firebase/firestore' {
  import type { FirebaseApp } from 'firebase/app';

  export interface FirestoreTimestampLike { toDate?: () => Date; seconds?: number }
  export interface FirestorePollOption { text?: string; votes?: string[] | number }
  export interface FirestorePoll {
    question?: string;
    options?: FirestorePollOption[] | Record<string, FirestorePollOption>;
    totalVotes?: number;
    expiresAt?: FirestoreTimestampLike | string | number | null;
    createdAt?: FirestoreTimestampLike | FieldValue | string | number | null;
  }
  export interface FirestoreData {
    [key: string]: unknown;
    id?: string;
    uid?: string;
    userId?: string;
    authorId?: string;
    viewerId?: string;
    ownerId?: string;
    fromUserId?: string;
    toUserId?: string;
    senderId?: string;
    postId?: string;
    commentId?: string;
    storyId?: string;
    conversationId?: string;
    displayName?: string;
    username?: string;
    email?: string;
    photoURL?: string;
    coverURL?: string;
    avatarColor?: string;
    bio?: string;
    text?: string;
    label?: string;
    icon?: string;
    tone?: string;
    type?: string;
    status?: string;
    visibility?: string;
    imageURL?: string;
    imageURLs?: string[];
    imageAlts?: string[];
    videoURL?: string;
    mediaUrl?: string;
    mediaType?: string;
    thumbnailUrl?: string;
    audioUrl?: string;
    audioTitle?: string;
    audioPresetId?: string;
    muteVideo?: boolean;
    overlayText?: string;
    background?: string;
    hashtags?: string[];
    participants?: string[];
    readBy?: string[];
    likesCount?: number;
    commentsCount?: number;
    repostsCount?: number;
    friendsCount?: number;
    viewCount?: number;
    reactionCount?: number;
    totalVotes?: number;
    poll?: FirestorePoll | null;
    quotedPostId?: string;
    quotedPost?: FirestoreData | null;
    quotePostId?: string;
    createdAt?: FirestoreTimestampLike | FieldValue | string | number | null;
    updatedAt?: FirestoreTimestampLike | FieldValue | string | number | null;
    editedAt?: FirestoreTimestampLike | FieldValue | string | number | null;
    deletedAt?: FirestoreTimestampLike | FieldValue | string | number | null;
    expiresAt?: FirestoreTimestampLike | FieldValue | string | number | null;
    scheduledAt?: FirestoreTimestampLike | FieldValue | string | number | null;
    viewedAt?: FirestoreTimestampLike | FieldValue | string | number | null;
    lastMessageAt?: FirestoreTimestampLike | FieldValue | string | number | null;
  }

  export interface Firestore { readonly app?: FirebaseApp }
  export interface DocumentReference<T extends FirestoreData = FirestoreData> { readonly id: string }
  export interface CollectionReference<T extends FirestoreData = FirestoreData> { readonly id: string }
  export interface Query<T extends FirestoreData = FirestoreData> {}
  export interface QueryConstraint {}
  export interface FieldValue { readonly __fieldValueBrand?: unique symbol }
  export interface SetOptions { merge?: boolean }
  export interface DocumentSnapshot<T extends FirestoreData = FirestoreData> {
    readonly id: string;
    readonly ref: DocumentReference<T>;
    exists(): boolean;
    data(): T;
  }
  export interface QueryDocumentSnapshot<T extends FirestoreData = FirestoreData> extends DocumentSnapshot<T> {
    data(): T;
  }
  export interface QuerySnapshot<T extends FirestoreData = FirestoreData> {
    readonly empty: boolean;
    readonly size: number;
    readonly docs: QueryDocumentSnapshot<T>[];
    forEach(callback: (doc: QueryDocumentSnapshot<T>) => void): void;
  }
  export interface WriteBatch {
    set<T extends FirestoreData>(ref: DocumentReference<T>, data: object, options?: SetOptions): WriteBatch;
    update<T extends FirestoreData>(ref: DocumentReference<T>, data: object): WriteBatch;
    delete<T extends FirestoreData>(ref: DocumentReference<T>): WriteBatch;
    commit(): Promise<void>;
  }
  export interface Transaction {
    get<T extends FirestoreData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
    set<T extends FirestoreData>(reference: DocumentReference<T>, data: object, options?: SetOptions): Transaction;
    update<T extends FirestoreData>(reference: DocumentReference<T>, data: object): Transaction;
    delete<T extends FirestoreData>(reference: DocumentReference<T>): Transaction;
  }
  export interface AggregateQuerySnapshot {
    data(): { count: number };
  }
  export class Timestamp {
    static now(): Timestamp;
    static fromDate(date: Date): Timestamp;
    toDate(): Date;
    readonly seconds: number;
  }

  export function getFirestore(app?: FirebaseApp): Firestore;
  export function doc(firestore: Firestore, path: string, pathSegment?: string, ...pathSegments: string[]): DocumentReference;
  export function doc<T extends FirestoreData>(reference: CollectionReference<T>): DocumentReference<T>;
  export function collection(firestore: Firestore, path: string, ...pathSegments: string[]): CollectionReference;
  export function getDoc<T extends FirestoreData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
  export function getDocFromServer<T extends FirestoreData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
  export function setDoc<T extends FirestoreData>(reference: DocumentReference<T>, data: object, options?: SetOptions): Promise<void>;
  export function updateDoc<T extends FirestoreData>(reference: DocumentReference<T>, data: object): Promise<void>;
  export function deleteDoc<T extends FirestoreData>(reference: DocumentReference<T>): Promise<void>;
  export function addDoc<T extends FirestoreData>(reference: CollectionReference<T>, data: object): Promise<DocumentReference<T>>;
  export function getDocs<T extends FirestoreData>(query: Query<T> | CollectionReference<T>): Promise<QuerySnapshot<T>>;
  export function query<T extends FirestoreData>(query: Query<T> | CollectionReference<T>, ...queryConstraints: QueryConstraint[]): Query<T>;
  export function where(fieldPath: string, opStr: string, value: unknown): QueryConstraint;
  export function documentId(): string;
  export function orderBy(fieldPath: string, directionStr?: 'asc' | 'desc'): QueryConstraint;
  export function limit(limit: number): QueryConstraint;
  export function startAfter(...fieldValues: unknown[]): QueryConstraint;
  export function serverTimestamp(): FieldValue;
  export function increment(n: number): FieldValue;
  export function arrayUnion(...elements: unknown[]): FieldValue;
  export function arrayRemove(...elements: unknown[]): FieldValue;
  export function writeBatch(firestore: Firestore): WriteBatch;
  export function onSnapshot<T extends FirestoreData>(reference: DocumentReference<T>, onNext: (snapshot: DocumentSnapshot<T>) => void, onError?: (error: unknown) => void): () => void;
  export function onSnapshot<T extends FirestoreData>(reference: Query<T> | CollectionReference<T>, onNext: (snapshot: QuerySnapshot<T>) => void, onError?: (error: unknown) => void): () => void;
  export function getCountFromServer<T extends FirestoreData>(query: Query<T> | CollectionReference<T>): Promise<AggregateQuerySnapshot>;
  export function runTransaction<T>(firestore: Firestore, updateFunction: (transaction: Transaction) => Promise<T>): Promise<T>;
}

declare module 'firebase/storage' {
  import type { FirebaseApp } from 'firebase/app';
  export interface FirebaseStorage { readonly app?: FirebaseApp }
  export interface StorageReference { readonly fullPath: string }
  export interface UploadMetadata { contentType?: string }
  export interface UploadResult { ref: StorageReference }
  export interface UploadTaskSnapshot extends UploadResult { bytesTransferred: number; totalBytes: number }
  export interface UploadTask {
    readonly snapshot: UploadTaskSnapshot;
    on(event: 'state_changed', next?: (snapshot: UploadTaskSnapshot) => void, error?: (error: unknown) => void, complete?: () => void): void;
  }
  export function getStorage(app?: FirebaseApp): FirebaseStorage;
  export function ref(storage: FirebaseStorage, path: string): StorageReference;
  export function uploadBytes(reference: StorageReference, data: Blob | Uint8Array | ArrayBuffer, metadata?: UploadMetadata): Promise<UploadResult>;
  export function uploadBytesResumable(reference: StorageReference, data: Blob | Uint8Array | ArrayBuffer, metadata?: UploadMetadata): UploadTask;
  export function getDownloadURL(reference: StorageReference): Promise<string>;
  export function deleteObject(reference: StorageReference): Promise<void>;
}

declare module 'firebase/app-check' {
  import type { FirebaseApp } from 'firebase/app';
  export class ReCaptchaEnterpriseProvider {
    constructor(siteKey: string);
  }
  export function initializeAppCheck(app: FirebaseApp, options: {
    provider: ReCaptchaEnterpriseProvider;
    isTokenAutoRefreshEnabled?: boolean;
  }): unknown;
}

