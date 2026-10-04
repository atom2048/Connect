import { auth } from './firebase.ts';

const AI_WORKER_BASE = 'https://connect-social-standalone.quest-live.workers.dev';

type AiStatus = {
  visible: boolean;
  generationEnabled: boolean;
  authenticated: boolean;
  isAdmin?: boolean;
  textReady?: boolean;
  visionReady?: boolean;
};

type AiPreferences = {
  acceptedPolicyVersion: string | null;
  preferenceVersion: number;
  textAnalysis: 'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT';
  mediaAnalysis: 'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT';
};

type AskAiResponse = {
  answer: string;
  insufficientContext: boolean;
  insufficientReason?: 'MEDIA_NOT_AVAILABLE' | 'MEDIA_ANALYSIS_NOT_ALLOWED' | 'UNSUPPORTED_MEDIA';
  degraded: boolean;
  degradedReason?: 'vision_unavailable' | 'capacity' | 'unsupported_media';
  feedbackToken?: string;
  coverage: {
    modalityRequested: 'text' | 'vision';
    modalityUsed: 'text' | 'vision';
    imagesTotal: number;
    imagesAnalyzed: number;
    videosTotal: number;
    videosAnalyzed: 0;
    unsupportedImages: number;
    contextTruncated: boolean;
  };
};

const ERROR_MESSAGES: Record<string, string> = {
  AI_PREPARING: 'AI機能は現在準備中です。',
  AI_PUBLIC_ROLLOUT_NOT_READY: '現在Ask AIは限定公開中です。公開設定の安全確認が完了するまでお待ちください。',
  AI_NOT_IN_ROLLOUT: 'このアカウントは現在Ask AIの利用対象外です。',
  AUTH_REQUIRED: 'ログイン状態を確認できませんでした。再度ログインしてください。',
  AI_DISABLED_BY_AUTHOR: 'この投稿ではAI分析が許可されていません。',
  MEDIA_ANALYSIS_NOT_ALLOWED: 'この投稿では画像のAI分析が許可されていません。',
  MEDIA_NOT_AVAILABLE: '画像を利用できないため、この質問には回答できません。',
  UNSUPPORTED_MEDIA: 'この投稿のメディア形式には対応していません。',
  USER_RATE_LIMIT: '操作が続いています。しばらくしてからお試しください。',
  USER_GENERATION_LIMIT: '本日のAsk AI利用上限に達しました。',
  USER_UPSTREAM_BURN_LIMIT: '本日のAI処理上限に達しました。',
  OPENROUTER_RATE_LIMIT: 'AIが混雑しています。しばらくしてからお試しください。',
  AI_PROVIDER_CONFIGURATION_MISSING: 'AIの安全な接続設定が未完了です。',
  OPENROUTER_UNAUTHORIZED: 'AI接続の認証設定を確認中です。',
  OPENROUTER_PAYMENT_REQUIRED: '料金の安全確認を完了できないため、Ask AIは利用できません。',
  OPENROUTER_FORBIDDEN: 'AI接続の利用許可を確認中です。',
  OPENROUTER_TIMEOUT: 'AIの応答がタイムアウトしました。時間をおいて再試行してください。',
  OPENROUTER_SERVER_ERROR: 'AIサービスが一時的に応答しませんでした。時間をおいて再試行してください。',
  OPENROUTER_TRANSPORT_FAILURE: 'AIサービスへ接続できませんでした。接続を確認して再試行してください。',
  OPENROUTER_INVALID_RESPONSE: 'AIサービスが不正な応答を返しました。時間をおいて再試行してください。',
  AI_COORDINATOR_INVALID_RESPONSE: 'AI処理の応答を確認できませんでした。時間をおいて再試行してください。',
  AI_COORDINATOR_TIMEOUT: 'AIの応答が時間内に返りませんでした。時間をおいて再試行してください。',
  AI_INPUT_TOO_LARGE: '投稿と画像の情報量が大きすぎるため、回答を作成できませんでした。本文のみで再試行してください。',
  MODEL_OUTPUT_MALFORMED: 'AIモデルが有効な回答形式を返しませんでした。時間をおいて再試行してください。',
  AI_ROUTER_METADATA_MISSING: 'AI経路の検証情報を取得できませんでした。時間をおいて再試行してください。',
  CAPABILITY_MISMATCH: 'この画像形式に対応できるAI経路が混雑しています。本文のみで再試行してください。',
  PROVIDER_TRANSIENT: 'AIサービスが一時的に不安定です。時間をおいて再試行してください。',
  MODEL_TIMEOUT: 'AIモデルの応答がタイムアウトしました。時間をおいて再試行してください。',
  AI_CONTROL_PLANE_UNAVAILABLE: 'AIの実行制御を確認できませんでした。時間をおいて再試行してください。',
  AI_CAPACITY_UNAVAILABLE: 'AIが混雑しています。しばらくしてからお試しください。',
  AI_PROVIDER_UNAVAILABLE: 'AIが応答しませんでした。時間をおいて再試行してください。',
  AI_POLICY_OR_CAPABILITY_UNAVAILABLE: 'AIモデルの安全確認を更新中です。時間をおいて再試行してください。',
  AI_BILLING_POLICY_VIOLATION: '料金の安全確認を完了できないため、Ask AIは利用できません。',
  AI_RISK_SCAN_UNAVAILABLE: '安全確認を完了できないため、Ask AIは利用できません。',
  AI_COORDINATOR_UNAVAILABLE: 'AI処理の準備中です。しばらくしてからお試しください。',
  AI_DATABASE_UNAVAILABLE: 'AI設定を確認できないため、現在は利用できません。',
  UNSUPPORTED_MEDIA_TYPE: 'Ask AIへの送信形式に対応していません。',
  INVALID_QUESTION: '質問を入力し、文字数を確認してください。',
  REQUEST_TOO_LARGE: '質問が長すぎるため送信できません。',
  IDEMPOTENCY_CONFLICT: '同じ質問の送信状態を確認できませんでした。もう一度お試しください。',
  ORIGIN_NOT_ALLOWED: 'この画面からAsk AIを利用できません。ページを再読み込みしてください。',
  NETWORK_ERROR: 'ネットワークに接続できません。接続を確認してください。',
  POST_NOT_FOUND_OR_INACCESSIBLE: '投稿が見つからないか、閲覧できません。',
  PROFILE_NOT_FOUND_OR_INACCESSIBLE: 'プロフィールが見つからないか、閲覧できません。',
  INVALID_AI_CONSENT: 'AI分析の設定を確認して再試行してください。',
  SENSITIVE_DATA_BLOCKED: '安全のため、この内容は外部AIへ送信できません。',
};

const AI_STATUS_CACHE_TTL_MS = 30_000;
const UNAVAILABLE_AI_STATUS: AiStatus = {
  visible: false,
  generationEnabled: false,
  authenticated: false,
  isAdmin: false,
  textReady: false,
  visionReady: false,
};

let statusCache: { uid: string; expiresAt: number; value: AiStatus } | null = null;
let statusRequest: { uid: string; value: Promise<AiStatus> } | null = null;

async function authorizedFetch(path: string, init: RequestInit = {}, forceRefresh = false): Promise<Response> {
  const user = auth.currentUser;
  const headers = new Headers(init.headers);
  if (user) headers.set('Authorization', `Bearer ${await user.getIdToken(forceRefresh)}`);
  let response: Response;
  try {
    // Prefer the explicit production Worker origin so Ask AI never falls back
    // to a Vercel legacy handler. The same-origin path is only a transport
    // fallback; Vercel rewrites it to this same Worker and preserves headers.
    response = await fetch(`${AI_WORKER_BASE}${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store' });
  } catch (directError) {
    try {
      response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      throw directError;
    }
  }
  if (response.status === 401 && user && !forceRefresh) return authorizedFetch(path, init, true);
  return response;
}

export function clearAiStatusCache(): void {
  statusCache = null;
}

function parseAiStatus(payload: unknown): AiStatus | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.visible !== 'boolean'
    || typeof value.generationEnabled !== 'boolean'
    || typeof value.authenticated !== 'boolean'
    || typeof value.isAdmin !== 'boolean') return null;
  return {
    visible: value.visible,
    generationEnabled: value.generationEnabled,
    authenticated: value.authenticated,
    isAdmin: value.isAdmin,
    textReady: value.textReady === true,
    visionReady: value.visionReady === true,
  };
}

/**
 * The Worker owns the eligibility decision. A non-OK or malformed response is
 * deliberately not cached: Firebase can finish restoring/refreshing its ID
 * token a moment after the initial feed render.
 */
export async function getAiStatus(forceRefresh = false): Promise<AiStatus> {
  const uid = auth.currentUser?.uid || '';
  if (!forceRefresh && statusCache?.uid === uid && statusCache.expiresAt > Date.now()) return statusCache.value;
  if (!forceRefresh && statusRequest?.uid === uid) return statusRequest.value;
  const request = authorizedFetch('/api/ai/status', {}, forceRefresh)
    .then(async (response): Promise<AiStatus> => {
      if (!response.ok) {
        throw new Error(`AI status request failed (${response.status})`);
      }
      const status = parseAiStatus(await response.json());
      if (!status) throw new Error('AI status response was invalid');
      // Do not poison a signed-in session with a transient unauthenticated
      // response. The bounded refresh below will request a fresh ID token.
      if (status.authenticated || !auth.currentUser) {
        statusCache = { uid, expiresAt: Date.now() + AI_STATUS_CACHE_TTL_MS, value: status };
      }
      return status;
    })
    .catch((): AiStatus => {
      return UNAVAILABLE_AI_STATUS;
    });
  statusRequest = { uid, value: request };
  try {
    return await request;
  } finally {
    if (statusRequest?.value === request) statusRequest = null;
  }
}

function apiErrorMessage(payload: Record<string, unknown>, status: number): string {
  const code = typeof payload.code === 'string' ? payload.code : (typeof payload.error === 'string' ? payload.error : '');
  return ERROR_MESSAGES[code] || (status === 429 ? '利用上限に達しました。しばらくしてからお試しください。' : 'Ask AIを利用できませんでした。');
}

type AskAiRequestError = Error & { code?: string; status?: number };

function requestError(payload: Record<string, unknown>, status: number): AskAiRequestError {
  const code = typeof payload.code === 'string' ? payload.code : (typeof payload.error === 'string' ? payload.error : `HTTP_${status}`);
  const failure = new Error(apiErrorMessage(payload, status)) as AskAiRequestError;
  failure.code = code;
  failure.status = status;
  return failure;
}

function newIdempotencyKey(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `ask-ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function sendFeedback(token: string, rating: -1 | 1, buttons: NodeListOf<HTMLButtonElement>): Promise<void> {
  const response = await authorizedFetch('/api/ai/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedbackToken: token, rating }),
  });
  if (!response.ok) return;
  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.toggle('is-selected', Number(button.dataset.rating) === rating);
  });
}

function renderCoverage(result: AskAiResponse, container: HTMLElement): void {
  const notes: string[] = [];
  if (result.degraded) notes.push('利用可能な情報の一部を使わず、投稿本文を中心に分析しました。');
  if (result.coverage.videosTotal > 0) notes.push('この回答では動画内容は解析していません。');
  if (result.coverage.contextTruncated) notes.push('一部の関連返信のみを参考にしています。');
  if (result.coverage.imagesTotal > result.coverage.imagesAnalyzed && result.coverage.modalityRequested === 'vision') notes.push('一部の画像は解析されていません。');
  container.replaceChildren(...notes.map((note) => {
    const small = document.createElement('small');
    small.textContent = note;
    return small;
  }));
}

type AskAiDialogOptions = {
  endpoint?: string;
  title?: string;
  placeholder?: string;
  includeMediaControls?: boolean;
  profileContextPostIds?: string[];
};

let activeAskAiDialogClose: (() => void) | null = null;

async function openAskAiDialog(postId: string, hasImages: boolean, options: AskAiDialogOptions = {}): Promise<void> {
  activeAskAiDialogClose?.();
  document.getElementById('ask-ai-modal')?.remove();
  const endpoint = options.endpoint || `/api/posts/${encodeURIComponent(postId)}/ask-ai`;
  const includeMediaControls = options.includeMediaControls ?? hasImages;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ask-ai-modal-overlay';
  overlay.id = 'ask-ai-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'ask-ai-modal-title');
  overlay.innerHTML = `
    <div class="modal-container ask-ai-modal-container">
      <div class="modal-header">
        <div><div class="ask-ai-kicker">Connect Ask AI</div><h2 class="modal-title" id="ask-ai-modal-title">${options.title || 'この投稿について質問'}</h2></div>
        <button class="modal-close-btn" type="button" aria-label="閉じる">✕</button>
      </div>
      <div class="modal-body ask-ai-modal-body">
        ${includeMediaControls ? `<fieldset class="ask-ai-media-mode"><legend>分析する内容</legend><label><input type="radio" name="ask-ai-media-mode" value="auto" checked>自動</label><label><input type="radio" name="ask-ai-media-mode" value="include">画像も含める</label><label><input type="radio" name="ask-ai-media-mode" value="exclude">本文のみ</label></fieldset>` : ''}
        <label class="ask-ai-question-label" for="ask-ai-question">質問</label>
        <textarea class="form-input ask-ai-question" id="ask-ai-question" maxlength="2000" rows="4" placeholder="${options.placeholder || 'この投稿の要点は？'}"></textarea>
        <div class="ask-ai-error" role="alert" hidden></div>
        <div class="ask-ai-progress" role="status" hidden>投稿を確認し、回答を作成しています…</div>
        <section class="ask-ai-result" aria-live="polite" hidden>
          <div class="ask-ai-answer"></div>
          <div class="ask-ai-coverage"></div>
          <div class="ask-ai-feedback" hidden><span>この回答は役に立ちましたか？</span><button type="button" data-rating="1" aria-label="役に立った">👍</button><button type="button" data-rating="-1" aria-label="役に立たなかった">👎</button></div>
        </section>
      </div>
      <div class="ask-ai-dialog-footer"><button type="button" class="btn btn-secondary ask-ai-cancel">閉じる</button><button type="button" class="btn btn-primary ask-ai-submit">質問する</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const closeButton = overlay.querySelector<HTMLButtonElement>('.modal-close-btn');
  const cancelButton = overlay.querySelector<HTMLButtonElement>('.ask-ai-cancel');
  const submitButton = overlay.querySelector<HTMLButtonElement>('.ask-ai-submit');
  const question = overlay.querySelector<HTMLTextAreaElement>('#ask-ai-question');
  const progress = overlay.querySelector<HTMLElement>('.ask-ai-progress');
  const error = overlay.querySelector<HTMLElement>('.ask-ai-error');
  const result = overlay.querySelector<HTMLElement>('.ask-ai-result');
  const answer = overlay.querySelector<HTMLElement>('.ask-ai-answer');
  const coverage = overlay.querySelector<HTMLElement>('.ask-ai-coverage');
  const feedback = overlay.querySelector<HTMLElement>('.ask-ai-feedback');
  let controller: AbortController | null = null;
  let loading = false;
  let closed = false;
  const onHashChange = (): void => close();
  const onPageHide = (): void => close();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  };
  const removeLifecycleListeners = (): void => {
    window.removeEventListener('hashchange', onHashChange);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('keydown', onKeyDown);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    controller?.abort();
    removeLifecycleListeners();
    overlay.remove();
    if (activeAskAiDialogClose === close) {
      activeAskAiDialogClose = null;
      document.body.classList.remove('ask-ai-open');
    }
  };
  activeAskAiDialogClose = close;
  document.body.classList.add('ask-ai-open');
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('keydown', onKeyDown);
  closeButton?.addEventListener('click', close);
  cancelButton?.addEventListener('click', () => {
    if (loading) {
      controller?.abort();
      loading = false;
      if (progress) progress.hidden = true;
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = '質問する'; }
      if (cancelButton) cancelButton.textContent = '閉じる';
      return;
    }
    close();
  });
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  submitButton?.addEventListener('click', async () => {
    const value = question?.value.normalize('NFC').replace(/\r\n?/g, '\n').trim() || '';
    if (!value || loading) return;
    loading = true;
    controller = new AbortController();
    submitButton.disabled = true;
    submitButton.textContent = '分析中…';
    if (cancelButton) cancelButton.textContent = 'キャンセル';
    if (progress) progress.hidden = false;
    if (error) error.hidden = true;
    if (result) result.hidden = true;
    try {
      const mediaMode = overlay.querySelector<HTMLInputElement>('input[name="ask-ai-media-mode"]:checked')?.value || 'exclude';
      const requestBody: Record<string, unknown> = { question: value, mediaMode };
      if (options.profileContextPostIds) requestBody.contextPostIds = options.profileContextPostIds.slice(0, 12);
      const response = await authorizedFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newIdempotencyKey() },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const payload = await response.json().catch((): Record<string, unknown> => ({}));
      if (!response.ok) throw requestError(payload, response.status);
      const ai = payload as AskAiResponse;
      const insufficient = ai.insufficientContext && !ai.answer;
      if (insufficient) {
        const reason = ai.insufficientReason || 'MEDIA_NOT_AVAILABLE';
        if (error) {
          error.dataset.code = reason;
          error.textContent = ERROR_MESSAGES[reason] || 'この質問に必要な情報を利用できません。';
          error.hidden = false;
        }
        if (result) result.hidden = true;
      } else {
        if (answer) answer.textContent = ai.answer;
        if (coverage) renderCoverage(ai, coverage);
        if (result) result.hidden = false;
      }
      if (feedback) {
        const token = ai.feedbackToken;
        feedback.hidden = !token;
        if (token) {
          const buttons = feedback.querySelectorAll<HTMLButtonElement>('button[data-rating]');
          buttons.forEach((button) => button.addEventListener('click', () => void sendFeedback(token, Number(button.dataset.rating) as -1 | 1, buttons), { once: true }));
        }
      }
      submitButton.textContent = '再質問';
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      if (error) {
        const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
          ? cause.code
          : cause instanceof TypeError ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR';
        error.dataset.code = code;
        error.textContent = cause instanceof Error ? cause.message : 'Ask AIを利用できませんでした。';
        error.hidden = false;
      }
      submitButton.textContent = '再試行';
    } finally {
      loading = false;
      controller = null;
      if (progress) progress.hidden = true;
      submitButton.disabled = false;
      if (cancelButton) cancelButton.textContent = '閉じる';
    }
  });
  question?.focus();
}

export async function refreshAskAiButtons(container: ParentNode = document): Promise<void> {
  const buttons = container.querySelectorAll<HTMLButtonElement>('[data-action="ask-ai"]');
  if (!buttons.length) return;
  buttons.forEach((button) => {
    // Display is intentionally independent from account role or rollout. The
    // Worker remains the only authority for authentication, ACL, and generation
    // permission after the user submits a question.
    button.hidden = false;
    button.parentElement?.classList.add('has-ask-ai');
    button.setAttribute('aria-hidden', 'false');
    if (button.dataset.askAiBound === 'true') return;
    button.dataset.askAiBound = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const postId = button.dataset.postId;
      if (!postId) return;
      const card = button.closest<HTMLElement>('.post-card');
      const hasImages = Boolean(card?.querySelector('[data-action="open-image"]'));
      void openAskAiDialog(postId, hasImages);
    });
  });
}

export async function openProfileAskAiDialog(profileId: string, contextPostIds: string[] = []): Promise<void> {
  if (!profileId) return;
  await openAskAiDialog(profileId, false, {
    endpoint: `/api/profiles/${encodeURIComponent(profileId)}/ask-ai`,
    title: 'この人について質問',
    placeholder: 'この人は何について投稿していますか？',
    profileContextPostIds: contextPostIds,
    // Profile analysis can include images from recent public posts. The
    // server still decides consent and capability; the control only lets the
    // user express whether a visual question should include those images.
    includeMediaControls: true,
  });
}

export async function aiWorkerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return authorizedFetch(path, init);
}

export type PostAiConsent = {
  postId: string;
  visibility: string;
  enabled: boolean;
  explicit: boolean;
  globalDisabled: boolean;
  acceptedPolicyVersion: string | null;
  consentVersion: number;
};

export async function getPostAiConsent(postId: string): Promise<PostAiConsent> {
  const response = await authorizedFetch(`/api/posts/${encodeURIComponent(postId)}/ai-consent`);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.postId !== 'string' || typeof payload.enabled !== 'boolean') throw requestError(payload, response.status);
  return {
    postId: payload.postId,
    visibility: typeof payload.visibility === 'string' ? payload.visibility : 'public',
    enabled: payload.enabled,
    explicit: payload.explicit === true,
    globalDisabled: payload.globalDisabled === true,
    acceptedPolicyVersion: typeof payload.acceptedPolicyVersion === 'string' ? payload.acceptedPolicyVersion : null,
    consentVersion: typeof payload.consentVersion === 'number' ? payload.consentVersion : 0,
  };
}

export async function setPostAiConsent(postId: string, enabled: boolean): Promise<void> {
  const response = await authorizedFetch(`/api/posts/${encodeURIComponent(postId)}/ai-consent`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, acceptCurrentPolicy: true }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw requestError(payload, response.status);
  }
}

export async function setupAskAiButtons(container: HTMLElement): Promise<void> {
  await refreshAskAiButtons(container);
}

export async function setupAiPreferenceSettings(container: HTMLElement): Promise<void> {
  const section = container.querySelector<HTMLElement>('#settings-ai-analysis');
  if (!section) return;
  const status = await getAiStatus();
  if (!status.visible) return;
  section.hidden = false;
  const state = section.querySelector<HTMLElement>('[data-ai-preference-state]');
  const textSelect = section.querySelector<HTMLSelectElement>('#settings-ai-text');
  const mediaSelect = section.querySelector<HTMLSelectElement>('#settings-ai-media');
  const save = section.querySelector<HTMLButtonElement>('#settings-ai-save');
  const adminTools = section.querySelector<HTMLElement>('[data-ai-admin-tools]');
  const integrityButton = section.querySelector<HTMLButtonElement>('#settings-ai-integrity');
  const predeployButton = section.querySelector<HTMLButtonElement>('#settings-ai-predeploy');
  const adminState = section.querySelector<HTMLElement>('[data-ai-admin-state]');
  if (status.isAdmin && adminTools) adminTools.hidden = false;
  try {
    const response = await authorizedFetch('/api/ai/preferences');
    const payload = await response.json() as { currentPolicyVersion?: string; preferences?: AiPreferences };
    if (!response.ok || !payload.preferences) throw new Error('AI設定を読み込めませんでした。');
    if (textSelect) textSelect.value = payload.preferences.textAnalysis;
    if (mediaSelect) mediaSelect.value = payload.preferences.mediaAnalysis;
    if (state) state.textContent = payload.preferences.acceptedPolicyVersion === payload.currentPolicyVersion ? '現在のAI利用方針に同意済みです。' : '保存時に現在のAI利用方針への同意が必要です。';
  } catch (cause) {
    if (state) state.textContent = cause instanceof Error ? cause.message : 'AI設定を読み込めませんでした。';
  }
  save?.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const response = await authorizedFetch('/api/ai/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ textAnalysis: textSelect?.value, mediaAnalysis: mediaSelect?.value, acceptCurrentPolicy: true }),
      });
      if (!response.ok) throw new Error('AI設定を保存できませんでした。');
      if (state) state.textContent = 'AI分析の設定を保存しました。';
    } catch (cause) {
      if (state) state.textContent = cause instanceof Error ? cause.message : 'AI設定を保存できませんでした。';
    } finally { save.disabled = false; }
  });
  integrityButton?.addEventListener('click', async () => {
    integrityButton.disabled = true;
    if (adminState) adminState.textContent = 'Migration integrityを確認中...';
    try {
      const response = await authorizedFetch('/api/admin/integrity');
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok || payload.pass !== true) throw new Error(`Migration verify failed (${response.status})`);
      if (adminState) adminState.textContent = JSON.stringify(payload);
    } catch (cause) {
      if (adminState) adminState.textContent = cause instanceof Error ? cause.message : 'Migration verify failed';
    } finally { integrityButton.disabled = false; }
  });
  predeployButton?.addEventListener('click', async () => {
    // One manual launch per rendered settings page. The Worker owns the
    // chain-stop policy and does not send a follow-up endpoint request after
    // an upstream 429.
    predeployButton.disabled = true;
    if (adminState) adminState.textContent = 'OpenRouter predeployを1回実行中...';
    try {
      const response = await authorizedFetch('/api/admin/ai/predeploy', { method: 'POST' });
      const payload = await response.json() as Record<string, unknown>;
      if (adminState) adminState.textContent = JSON.stringify({ status: response.status, ...payload });
    } catch (cause) {
      if (adminState) adminState.textContent = cause instanceof Error ? cause.message : 'OpenRouter predeploy failed';
    }
  });
}
