import { describe, expect, it } from 'vitest';
import { getFirebaseErrorMessage } from '../src/utils';

describe('Firebase login errors', () => {
  it('gives a recovery-oriented message for the current invalid-credential code', () => {
    expect(getFirebaseErrorMessage({ code: 'auth/invalid-credential' }))
      .toContain('パスワードを忘れた場合は、再設定してください');
  });

  it('keeps the equivalent invalid-login-credentials code actionable', () => {
    expect(getFirebaseErrorMessage({ code: 'auth/invalid-login-credentials' }))
      .toContain('メールアドレスまたはパスワードが正しくありません');
  });
});
