import type { User as FirebaseUser } from 'firebase/auth';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  GithubAuthProvider,
  FacebookAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  confirmPasswordReset,
  verifyPasswordResetCode,
} from 'firebase/auth';
import { auth, firebaseConfig } from './firebase';
import { setState } from './state';
import { getFirebaseErrorMessage } from './utils';

type AuthResult = { user: FirebaseUser | null; error: string | null };
type ErrorResult = { error: string | null };
type ResetEmailResult = { error: string | null; fallback: boolean };
type VerifyResetResult = { email: string | null; error: string | null };
type AuthChangeHandler = (user: FirebaseUser | null) => void;
type InitialAuthPromise = Promise<FirebaseUser | null> & { unsubscribe?: () => void };

type ResetRestError = {
  error?: {
    message?: string;
  };
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

function getResetEmailErrorMessage(message: string): string {
  const messages: Record<string, string> = {
    EMAIL_NOT_FOUND: 'このメールアドレスのアカウントが見つかりません',
    INVALID_EMAIL: '有効なメールアドレスを入力してください',
    MISSING_EMAIL: 'メールアドレスを入力してください',
    TOO_MANY_ATTEMPTS_TRY_LATER: '送信回数が多すぎます。しばらく待ってから再試行してください',
    RESET_PASSWORD_EXCEED_LIMIT: '送信回数が上限に達しました。しばらく待ってから再試行してください',
    OPERATION_NOT_ALLOWED: 'メール/パスワード認証が有効になっていません',
  };
  return messages[message] || message || 'パスワード再設定メールの送信に失敗しました';
}

async function sendPasswordResetEmailViaRest(email: string): Promise<unknown> {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${firebaseConfig.apiKey || ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Firebase-Locale': 'ja',
    },
    body: JSON.stringify({
      requestType: 'PASSWORD_RESET',
      email,
    }),
  });

  const data = await response.json().catch((): ResetRestError => ({})) as ResetRestError;
  if (!response.ok) {
    const message = data.error?.message || '';
    throw new Error(getResetEmailErrorMessage(message));
  }
  return data;
}

export async function registerWithEmail(email: string, password: string, _displayName?: string): Promise<AuthResult> {
  try {
    const result = await createUserWithEmailAndPassword(auth, email, password);
    return { user: result.user, error: null };
  } catch (error) {
    return { user: null, error: getFirebaseErrorMessage(error) };
  }
}

export async function loginWithEmail(email: string, password: string): Promise<AuthResult> {
  try {
    const result = await signInWithEmailAndPassword(auth, email, password);
    return { user: result.user, error: null };
  } catch (error) {
    return { user: null, error: getFirebaseErrorMessage(error) };
  }
}

export async function sendResetPasswordEmail(email: string): Promise<ResetEmailResult> {
  try {
    await sendPasswordResetEmailViaRest(email);
    return { error: null, fallback: true };
  } catch (error) {
    try {
      auth.languageCode = 'ja';
      await sendPasswordResetEmail(auth, email);
      return { error: null, fallback: true };
    } catch (fallbackError) {
      return {
        error: getFirebaseErrorMessage(fallbackError) || getErrorMessage(error),
        fallback: false,
      };
    }
  }
}

export async function verifyResetPasswordCode(code: string): Promise<VerifyResetResult> {
  try {
    const email = await verifyPasswordResetCode(auth, code);
    return { email, error: null };
  } catch (error) {
    return { email: null, error: getFirebaseErrorMessage(error) };
  }
}

export async function confirmResetPassword(code: string, newPassword: string): Promise<ErrorResult> {
  try {
    await confirmPasswordReset(auth, code, newPassword);
    return { error: null };
  } catch (error) {
    return { error: getFirebaseErrorMessage(error) };
  }
}

export async function loginWithGoogle(): Promise<AuthResult> {
  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    return { user: result.user, error: null };
  } catch (error) {
    return { user: null, error: getFirebaseErrorMessage(error) };
  }
}

export async function loginWithGitHub(): Promise<AuthResult> {
  try {
    const provider = new GithubAuthProvider();
    const result = await signInWithPopup(auth, provider);
    return { user: result.user, error: null };
  } catch (error) {
    return { user: null, error: getFirebaseErrorMessage(error) };
  }
}

export async function loginWithFacebook(): Promise<AuthResult> {
  try {
    const provider = new FacebookAuthProvider();
    const result = await signInWithPopup(auth, provider);
    return { user: result.user, error: null };
  } catch (error) {
    return { user: null, error: getFirebaseErrorMessage(error) };
  }
}

export async function loginWithApple(): Promise<AuthResult> {
  try {
    const provider = new OAuthProvider('apple.com');
    const result = await signInWithPopup(auth, provider);
    return { user: result.user, error: null };
  } catch (error) {
    return { user: null, error: getFirebaseErrorMessage(error) };
  }
}

export async function loginWithMicrosoft(): Promise<AuthResult> {
  try {
    const provider = new OAuthProvider('microsoft.com');
    const result = await signInWithPopup(auth, provider);
    return { user: result.user, error: null };
  } catch (error) {
    return { user: null, error: getFirebaseErrorMessage(error) };
  }
}

export async function logout(): Promise<ErrorResult> {
  try {
    await import('./pushNotifications.ts')
      .then(({ removeCurrentPushSubscriptionForLogout }) => removeCurrentPushSubscriptionForLogout())
      .catch((): void => {});
    await signOut(auth);
    return { error: null };
  } catch (error) {
    return { error: getFirebaseErrorMessage(error) };
  }
}

export function initAuthListener(onUserChanged?: AuthChangeHandler): InitialAuthPromise {
  let initialResolved = false;
  let resolveInitial: (user: FirebaseUser | null) => void = () => undefined;
  let rejectInitial: (error: unknown) => void = () => undefined;
  const initialAuthReady = new Promise<FirebaseUser | null>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  }) as InitialAuthPromise;

  const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
    try {
      if (firebaseUser) {
        setState('user', firebaseUser);
        onUserChanged?.(firebaseUser);
      } else {
        setState('user', null);
        setState('userProfile', null);
        onUserChanged?.(null);
      }
      if (!initialResolved) {
        initialResolved = true;
        resolveInitial(firebaseUser || null);
      }
    } catch (error) {
      if (!initialResolved) {
        initialResolved = true;
        rejectInitial(error);
      } else {
        console.error('Auth state change handler failed:', error);
      }
    }
  });

  initialAuthReady.unsubscribe = unsubscribe;
  return initialAuthReady;
}
