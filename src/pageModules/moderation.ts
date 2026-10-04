import { auth } from '../firebase.ts';
import { escapeHtml } from '../utils.ts';

type ApiPayload = Record<string, unknown>;
type ModerationPost = {
  id: string;
  authorId: string;
  authorName: string;
  username: string;
  body: string;
  createdAt: string | number | null;
  reportCount: number;
  deletedAt: string | number | null;
  deleteReason: string | null;
  bodyTruncated?: boolean;
};
type ListResponse = { posts: ModerationPost[]; nextCursor: string | null; scanLimitReached?: boolean };

const reasonLabels: Record<string, string> = {
  spam: 'スパム',
  harassment: '嫌がらせ',
  illegal: '違法コンテンツ',
  other: 'その他',
};

async function apiRequest(path: string, init: RequestInit = {}): Promise<ApiPayload> {
  const user = auth.currentUser;
  if (!user) throw new Error('ログインが必要です');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, cache: 'no-store' });
  const payload = await response.json().catch((): ApiPayload => ({}));
  if (!response.ok) {
    const error = new Error(typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload;
}

function dateText(value: string | number | null): string {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString('ja-JP') : '日時不明';
}

function postRow(post: ModerationPost): string {
  const idValue = escapeHtml(post.id);
  const deleted = Boolean(post.deletedAt);
  return `<article class="moderation-post-card" data-post-id="${idValue}">
    <div class="moderation-post-meta">
      <strong>${escapeHtml(post.authorName || post.authorId)}</strong>
      <span>@${escapeHtml(post.username || post.authorId)}</span>
      <time>${escapeHtml(dateText(post.createdAt))}</time>
      <span class="moderation-report-count">通報 ${post.reportCount} 件</span>
      ${deleted ? `<span class="moderation-deleted-badge">削除済み · ${escapeHtml(reasonLabels[post.deleteReason || ''] || post.deleteReason || '')}</span>` : ''}
    </div>
    <p class="moderation-post-id">投稿ID: <code>${idValue}</code></p>
    <div class="moderation-post-body">${escapeHtml(post.body || (deleted ? '本文は非表示です。スナップショットから復旧できます。' : '（本文なし）'))}${post.bodyTruncated ? '<small>本文の先頭5000文字を表示しています。</small>' : ''}</div>
    <div class="moderation-post-controls">
      ${deleted
        ? `<button type="button" class="btn btn-secondary btn-sm" data-action="restore-post">投稿を復旧</button>`
        : `<label>削除理由<select class="form-input moderation-reason"><option value="">選択してください</option><option value="spam">スパム</option><option value="harassment">嫌がらせ</option><option value="illegal">違法コンテンツ</option><option value="other">その他</option></select></label>
           <button type="button" class="btn btn-danger btn-sm" data-action="delete-post">論理削除</button>`}
    </div>
  </article>`;
}

function queryFromForm(form: HTMLFormElement): URLSearchParams {
  const data = new FormData(form);
  const query = new URLSearchParams({ limit: '20' });
  for (const key of ['postId', 'author', 'body', 'minReports', 'from', 'to']) {
    const value = String(data.get(key) || '').trim();
    if (value) query.set(key, value);
  }
  if (data.get('includeDeleted') === 'on') query.set('includeDeleted', 'true');
  return query;
}

export async function renderAdminModerationPage(): Promise<void> {
  const container = document.getElementById('page-content');
  if (!container) return;
  container.innerHTML = `<section class="moderation-admin-page" id="moderation-admin-root">
    <header class="moderation-admin-header"><div><p class="eyebrow">ADMIN</p><h1>投稿モデレーション</h1><p>削除は論理削除として記録され、復旧用スナップショットと監査履歴を保持します。</p></div>
      <button type="button" class="btn btn-secondary" data-action="show-audit">監査・異議申し立て</button></header>
    <form class="moderation-filter-form" id="moderation-filter-form">
      <label>投稿ID<input class="form-input" name="postId" type="search" placeholder="投稿IDの一部…"></label>
      <label>投稿者<input class="form-input" name="author" type="search" placeholder="ユーザー名またはID…"></label>
      <label>本文<input class="form-input" name="body" type="search" placeholder="本文を検索…"></label>
      <label>通報件数<input class="form-input" name="minReports" type="number" min="0" value="0"></label>
      <label>投稿日時（開始）<input class="form-input" name="from" type="date"></label>
      <label>投稿日時（終了）<input class="form-input" name="to" type="date"></label>
      <label class="moderation-include-deleted"><input type="checkbox" name="includeDeleted">削除済みも表示</label>
      <button type="submit" class="btn btn-primary">検索</button>
    </form>
    <p class="moderation-status" data-moderation-status role="status" aria-live="polite">一覧を確認しています…</p>
    <div class="moderation-results" data-moderation-results></div>
    <div class="moderation-pagination"><button type="button" class="btn btn-secondary" data-action="more" hidden>さらに読み込む</button></div>
    <section class="moderation-audit-section" data-audit-section hidden></section>
  </section>`;

  const root = container.querySelector<HTMLElement>('#moderation-admin-root');
  const form = root?.querySelector<HTMLFormElement>('#moderation-filter-form');
  const status = root?.querySelector<HTMLElement>('[data-moderation-status]');
  const results = root?.querySelector<HTMLElement>('[data-moderation-results]');
  const moreButton = root?.querySelector<HTMLButtonElement>('[data-action="more"]');
  if (!root || !form || !status || !results || !moreButton) return;
  let nextCursor: string | null = null;
  let currentPosts: ModerationPost[] = [];

  const loadPosts = async (append = false): Promise<void> => {
    if (!append) {
      currentPosts = [];
      results.innerHTML = '';
      nextCursor = null;
    }
    status.textContent = '投稿を読み込んでいます…';
    moreButton.hidden = true;
    const query = queryFromForm(form);
    if (append && nextCursor) query.set('cursor', nextCursor);
    try {
      const payload = await apiRequest(`/api/admin/moderation/posts?${query.toString()}`) as ListResponse;
      const page = Array.isArray(payload.posts) ? payload.posts : [];
      currentPosts = append ? [...currentPosts, ...page] : page;
      results.innerHTML = currentPosts.length ? currentPosts.map(postRow).join('') : '<div class="moderation-empty">条件に合う投稿はありません。</div>';
      nextCursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
      moreButton.hidden = !nextCursor;
      status.textContent = payload.scanLimitReached ? '検索範囲が大きいため一部を表示しています。続けて読み込めます。' : `${currentPosts.length} 件を表示中 · 通報件数の多い投稿から表示`;
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      status.textContent = failure.status === 403
        ? '管理者権限がありません。Firebaseのrole=adminカスタムクレームを確認してください。'
        : failure.status === 401
          ? '認証が必要です。ログインし直してください。'
          : '一覧を取得できませんでした。データベース移行状態と接続を確認してください。';
      results.innerHTML = '';
    }
  };

  const loadAudit = async (): Promise<void> => {
    const auditSection = root.querySelector<HTMLElement>('[data-audit-section]');
    if (!auditSection) return;
    auditSection.hidden = false;
    auditSection.innerHTML = '<p role="status">監査履歴と異議申し立てを読み込んでいます…</p>';
    try {
      const [auditPayload, appealPayload] = await Promise.all([
        apiRequest('/api/admin/moderation/audit'),
        apiRequest('/api/admin/moderation/appeals'),
      ]);
      const entries = Array.isArray(auditPayload.entries) ? auditPayload.entries as Array<Record<string, unknown>> : [];
      const appeals = Array.isArray(appealPayload.appeals) ? appealPayload.appeals as Array<Record<string, unknown>> : [];
      auditSection.innerHTML = `<div class="moderation-audit-head"><h2>監査履歴</h2><button type="button" class="btn btn-secondary btn-sm" data-action="hide-audit">閉じる</button></div>
        ${entries.length ? entries.map((entry) => `<article class="moderation-audit-row"><strong>${escapeHtml(String(entry.action || '')) === 'delete' ? '論理削除' : '復旧'}</strong><code>${escapeHtml(String(entry.post_id || ''))}</code><span>管理者: ${escapeHtml(String(entry.admin_id || ''))}</span><span>理由: ${escapeHtml(reasonLabels[String(entry.reason_code || '')] || String(entry.reason_code || '—'))}</span><span>${escapeHtml(dateText(Number(entry.created_at || 0)))}</span><span>通知: ${escapeHtml(String(entry.notification_status || ''))}</span>${entry.action === 'delete' && entry.notification_status === 'failed' ? `<button type="button" class="btn btn-secondary btn-sm" data-action="retry-notification" data-audit-id="${escapeHtml(String(entry.id || ''))}">通知を再送</button>` : ''}</article>`).join('') : '<p class="moderation-empty">監査履歴はありません。</p>'}
        <h2>異議申し立て</h2>
        ${appeals.length ? appeals.map((appeal) => `<article class="moderation-appeal-row"><strong>${escapeHtml(String(appeal.status || 'pending'))}</strong><code>${escapeHtml(String(appeal.post_id || ''))}</code><span>ユーザー: ${escapeHtml(String(appeal.user_id || ''))}</span><p>${escapeHtml(String(appeal.message || ''))}</p><div><select class="form-input" data-appeal-status><option value="reviewing" ${appeal.status === 'reviewing' ? 'selected' : ''}>確認中</option><option value="resolved" ${appeal.status === 'resolved' ? 'selected' : ''}>対応済み</option><option value="rejected" ${appeal.status === 'rejected' ? 'selected' : ''}>却下</option></select><button type="button" class="btn btn-secondary btn-sm" data-action="save-appeal-status" data-appeal-id="${escapeHtml(String(appeal.id || ''))}">状態を保存</button></div></article>`).join('') : '<p class="moderation-empty">異議申し立てはありません。</p>'}`;
    } catch {
      auditSection.innerHTML = '<p role="alert">監査データを読み込めませんでした。</p>';
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); void loadPosts(false); });
  root.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'more') { if (nextCursor) await loadPosts(true); return; }
    if (action === 'show-audit') { await loadAudit(); return; }
    if (action === 'hide-audit') { root.querySelector<HTMLElement>('[data-audit-section]')?.setAttribute('hidden', ''); return; }
    if (action === 'retry-notification') {
      const actionId = button.dataset.auditId;
      if (!actionId) return;
      button.disabled = true;
      try {
        await apiRequest(`/api/admin/moderation/audit/${encodeURIComponent(actionId)}/retry-notification`, { method: 'POST', body: JSON.stringify({}) });
        status.textContent = '対象ユーザーへの通知を再送しました。';
      } catch {
        status.textContent = '通知を再送できませんでした。監査記録を確認してください。';
      }
      await loadAudit();
      return;
    }
    if (action === 'delete-post' || action === 'restore-post') {
      const card = button.closest<HTMLElement>('.moderation-post-card');
      const postId = card?.dataset.postId;
      if (!postId) return;
      let path = '';
      let init: RequestInit;
      if (action === 'delete-post') {
        const reason = card?.querySelector<HTMLSelectElement>('.moderation-reason')?.value || '';
        if (!reason) { status.textContent = '削除理由を選択してください。'; return; }
        if (!window.confirm(`${reasonLabels[reason] || reason}として投稿を論理削除します。続行しますか？`)) return;
        path = `/api/admin/posts/${encodeURIComponent(postId)}`;
        init = { method: 'DELETE', body: JSON.stringify({ reason }) };
      } else {
        if (!window.confirm('保存したスナップショットから投稿を復旧しますか？')) return;
        path = `/api/admin/moderation/posts/${encodeURIComponent(postId)}/restore`;
        init = { method: 'POST', body: JSON.stringify({}) };
      }
      button.disabled = true;
      try {
        const payload = await apiRequest(path, init);
        if (action === 'delete-post' && payload.notificationSent === false) status.textContent = '投稿を削除しましたが、通知の送信に失敗しました。監査記録で状態を確認してください。';
        else status.textContent = action === 'delete-post' ? '投稿を論理削除し、監査記録に保存しました。' : '投稿を復旧し、監査記録に保存しました。';
        await loadPosts(false);
      } catch {
        status.textContent = '操作を完了できませんでした。投稿状態と監査履歴を確認してください。';
        button.disabled = false;
      }
      return;
    }
    if (action === 'save-appeal-status') {
      const appealId = button.dataset.appealId;
      const row = button.closest('.moderation-appeal-row');
      const nextStatus = row?.querySelector<HTMLSelectElement>('[data-appeal-status]')?.value || '';
      if (!appealId) return;
      button.disabled = true;
      try {
        await apiRequest(`/api/admin/moderation/appeals/${encodeURIComponent(appealId)}`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) });
        status.textContent = '異議申し立ての状態を保存しました。';
        await loadAudit();
      } catch {
        status.textContent = '異議申し立ての状態を保存できませんでした。';
        button.disabled = false;
      }
    }
  });
  await loadPosts(false);
}

export async function renderModerationAppealPage(params: Record<string, string>): Promise<void> {
  const container = document.getElementById('page-content');
  if (!container) return;
  const postId = params.postId || '';
  container.innerHTML = `<section class="moderation-appeal-page" id="moderation-appeal-root"><p role="status">削除通知を確認しています…</p></section>`;
  const root = container.querySelector<HTMLElement>('#moderation-appeal-root');
  if (!root) return;
  try {
    const result = await apiRequest(`/api/moderation/appeals/${encodeURIComponent(postId)}`);
    const appealRecord = result.appeal && typeof result.appeal === 'object' ? result.appeal as Record<string, unknown> : null;
    const reasonLabel = reasonLabels[String(result.deleteReason || '')] || 'その他';
    root.innerHTML = `<article class="moderation-appeal-card"><p class="eyebrow">投稿の確認</p><h1>投稿が削除されました</h1><p>コミュニティガイドラインにより投稿を削除しました。削除理由: <strong>${escapeHtml(reasonLabel)}</strong></p>
      <p>内容に納得できない場合は、下のフォームから異議を申し立てられます。審査内容は本人と管理者のみが確認できます。</p>
      ${appealRecord ? `<div class="moderation-appeal-existing" role="status"><strong>異議申し立て済み · ${escapeHtml(String(appealRecord.status || 'pending'))}</strong><p>${escapeHtml(String(appealRecord.message || ''))}</p><small>${escapeHtml(dateText(Number(appealRecord.created_at || 0)))}</small></div>` : `<form id="moderation-appeal-form"><label for="moderation-appeal-message">申し立て内容</label><textarea id="moderation-appeal-message" class="form-input" name="message" rows="6" minlength="10" maxlength="2000" required placeholder="状況や確認してほしい点を入力してください（10〜2000文字）"></textarea><p class="moderation-appeal-status" data-appeal-status role="status" aria-live="polite"></p><button type="submit" class="btn btn-primary">異議を申し立てる</button></form>`}
    </article>`;
    root.querySelector<HTMLFormElement>('#moderation-appeal-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      const status = form.querySelector<HTMLElement>('[data-appeal-status]');
      const message = String(new FormData(form).get('message') || '').trim();
      if (message.length < 10 || message.length > 2_000) { if (status) status.textContent = '10〜2000文字で入力してください。'; return; }
      if (button) { button.disabled = true; button.textContent = '送信中…'; }
      try {
        await apiRequest('/api/moderation/appeals', { method: 'POST', body: JSON.stringify({ postId, message }) });
        root.innerHTML = '<article class="moderation-appeal-card"><h1>異議を受け付けました</h1><p>管理者が確認できるよう保存しました。</p></article>';
      } catch (cause) {
        if (status) status.textContent = cause instanceof Error && cause.message === 'appeal_already_submitted' ? '審査中の申し立てがすでにあります。' : '送信できませんでした。時間をおいて再試行してください。';
        if (button) { button.disabled = false; button.textContent = '異議を申し立てる'; }
      }
    });
  } catch (cause) {
    const failure = cause as Error & { status?: number };
    root.innerHTML = `<article class="moderation-appeal-card"><h1>通知を確認できません</h1><p>${failure.status === 403 ? 'この投稿の異議申し立てを確認できるのは投稿者本人だけです。' : 'ログイン状態または投稿の状態を確認してください。'}</p><a href="#/notifications" data-navigate>通知に戻る</a></article>`;
  }
}
