import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, fallbackPosts, formatTime, initials, type AskAiResponse, type Bootstrap, type Post, type Profile, type ReactionMutationResponse, type Viewer } from './api';
import { rumSnapshot, startRum } from './rum';
import { resolveAvatarURL } from '../avatar.ts';

type Route = { name: 'home' | 'explore' | 'friends' | 'profile' | 'post' | 'notifications' | 'settings' | 'login'; id?: string };
type ToastState = { message: string; tone?: 'error' | 'success' } | null;
type PostLikeChange = (postId: string, liked: boolean, likeCount: number) => void;
type AiAvailability = { uiEnabled: boolean; visible: boolean; generationEnabled: boolean; adminOnly: boolean };
type IconName = 'home' | 'search' | 'users' | 'bell' | 'settings' | 'plus' | 'heart' | 'message-circle' | 'bookmark' | 'more-horizontal' | 'x' | 'arrow-left' | 'arrow-right';

const navItems: Array<{ name: Route['name']; label: string; icon: IconName; auth?: boolean }> = [
  { name: 'home', label: 'ホーム', icon: 'home' },
  { name: 'explore', label: '探す', icon: 'search' },
  { name: 'friends', label: '友達', icon: 'users', auth: true },
  { name: 'notifications', label: '通知', icon: 'bell', auth: true },
];

const buildAiAvailability: AiAvailability = {
  uiEnabled: import.meta.env.VITE_AI_UI_ENABLED !== 'false',
  visible: import.meta.env.VITE_AI_UI_ENABLED !== 'false',
  generationEnabled: import.meta.env.VITE_AI_GENERATION_ENABLED === 'true',
  adminOnly: import.meta.env.VITE_AI_ADMIN_ONLY === 'true',
};
const AiAvailabilityContext = createContext<AiAvailability>(buildAiAvailability);

function routeFromHash(): Route {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'profile' && parts[1]) return { name: 'profile', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'post' && parts[1]) return { name: 'post', id: decodeURIComponent(parts[1]) };
  if (['explore', 'friends', 'notifications', 'settings', 'login'].includes(parts[0])) return { name: parts[0] as Route['name'] };
  return { name: 'home' };
}

function navigate(route: Route) {
  const path = route.id ? `${route.name}/${encodeURIComponent(route.id)}` : route.name;
  window.location.hash = `#/${path}`;
}

function Button({ children, variant = 'ghost', className = '', ...props }: { children: ReactNode; variant?: 'primary' | 'ghost' | 'soft' | 'danger'; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`button button-${variant} ${className}`}>{children}</button>;
}

function Icon({ name, size = 20, className = '', filled = false }: { name: IconName; size?: number; className?: string; filled?: boolean }) {
  const props = {
    'aria-hidden': true,
    className: ('icon icon-' + name + ' ' + className).trim(),
    fill: filled ? 'currentColor' : 'none',
    focusable: false,
    height: size,
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8,
    viewBox: '0 0 24 24',
    width: size,
  };
  switch (name) {
    case 'home':
      return <svg {...props}><path d="m3 10.75 9-7.25 9 7.25v8.5a1.75 1.75 0 0 1-1.75 1.75H4.75A1.75 1.75 0 0 1 3 19.25z" /><path d="M9.5 21v-6h5v6" /></svg>;
    case 'search':
      return <svg {...props}><circle cx="10.75" cy="10.75" r="6.25" /><path d="m15.5 15.5 4.25 4.25" /></svg>;
    case 'users':
      return <svg {...props}><path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20" /><circle cx="9.5" cy="7.5" r="3.25" /><path d="M16.5 4.75a3.25 3.25 0 0 1 0 6.25" /><path d="M21 20v-1.35a4 4 0 0 0-3-3.87" /></svg>;
    case 'bell':
      return <svg {...props}><path d="M18 9.5a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>;
    case 'settings':
      return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56v.08h-3v-.08A1.7 1.7 0 0 0 10.66 18.7a1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15.04a1.7 1.7 0 0 0-1.56-1.04h-.08v-3h.08A1.7 1.7 0 0 0 7 9.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06L8.72 5.9l.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.7 4.74v-.08h3v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.56 1.04h.08v3h-.08A1.7 1.7 0 0 0 19.4 15z" /></svg>;
    case 'plus':
      return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>;
    case 'heart':
      return <svg {...props}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" /></svg>;
    case 'message-circle':
      return <svg {...props}><path d="M21 11.4a8.35 8.35 0 0 1-8.5 8.1 9.2 9.2 0 0 1-3.83-.83L3 20.5l1.75-5.1A7.9 7.9 0 0 1 4 11.4a8.35 8.35 0 0 1 8.5-8.1A8.35 8.35 0 0 1 21 11.4z" /><path d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01" /></svg>;
    case 'bookmark':
      return <svg {...props}><path d="M6.25 3.75h11.5a1 1 0 0 1 1 1v16l-6.75-4.25-6.75 4.25v-16a1 1 0 0 1 1-1z" /></svg>;
    case 'more-horizontal':
      return <svg {...props}><circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none" /></svg>;
    case 'x':
      return <svg {...props}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case 'arrow-left':
      return <svg {...props}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>;
    case 'arrow-right':
      return <svg {...props}><path d="M5 12h14M12 5l7 7-7 7" /></svg>;
    default:
      return null;
  }
}

function Avatar({ profile, size = 'md' }: { profile: Pick<Profile, 'displayName' | 'avatarUrl' | 'avatarColor'>; size?: 'sm' | 'md' | 'lg' }) {
  const source = resolveAvatarURL(profile);
  const [failedSource, setFailedSource] = useState('');
  if (source && failedSource !== source) {
    return <img className={`avatar avatar-${size}`} src={source} alt={`${profile.displayName}のプロフィール画像`} loading="lazy" decoding="async" onError={() => setFailedSource(source)} />;
  }
  return <span className={`avatar avatar-${size}`} style={{ background: profile.avatarColor || 'var(--brand)' }} aria-hidden="true">{initials(profile)}</span>;
}

function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="skeleton-card" aria-label="読み込み中" aria-busy="true">{Array.from({ length: lines }, (_, index) => <span key={index} className={`skeleton-line skeleton-line-${index}`} />)}</div>;
}

function SearchField({ value, onChange, onSubmit, placeholder = '投稿やユーザーを探す', autoFocus = false }: { value: string; onChange: (value: string) => void; onSubmit?: () => void; placeholder?: string; autoFocus?: boolean }) {
  return <form className="search-field-wrap" role="search" onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}>
    <span className="search-icon"><Icon name="search" size={19} /></span>
    <input type="search" inputMode="search" enterKeyHint="search" value={value} onChange={(event) => onChange(event.target.value)} className="search-field" placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus} />
    {value && <button type="button" className="search-clear" onClick={() => onChange('')} aria-label="検索をクリア"><Icon name="x" size={17} /></button>}
  </form>;
}

function Tabs({ items, value, onChange, label }: { items: Array<{ key: string; label: string }>; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="tabs" role="tablist" aria-label={label}>{items.map((item) => <button key={item.key} type="button" role="tab" aria-selected={item.key === value} className={`tab ${item.key === value ? 'is-active' : ''}`} onClick={() => onChange(item.key)}>{item.label}</button>)}</div>;
}

function Menu({ onReport }: { onReport: () => void }) {
  return <details className="menu"><summary className="icon-button" aria-label="その他の操作" title="その他の操作"><Icon name="more-horizontal" size={20} /></summary><div className="menu-popover" role="menu"><button type="button" onClick={onReport}>投稿を報告</button><button type="button" onClick={() => {}}>リンクをコピー</button></div></details>;
}

function withCurrentProfile(post: Post, profile: Profile): Post {
  return post.authorId === profile.id
    ? { ...post, author: { ...post.author, ...profile, id: profile.id, isUnavailable: false } }
    : post;
}

function PostCard({ post, viewer, onToast, onNavigate, onLikeChange }: { post: Post; viewer: Viewer | null; onToast: (toast: ToastState) => void; onNavigate: (route: Route) => void; onLikeChange?: PostLikeChange }) {
  const aiAvailability = useContext(AiAvailabilityContext);
  const [liked, setLiked] = useState(Boolean(post.liked));
  const [likeCount, setLikeCount] = useState(post.counts.likes);
  const [likeSyncing, setLikeSyncing] = useState(false);
  const [bookmarked, setBookmarked] = useState(Boolean(post.bookmarked));
  const [askOpen, setAskOpen] = useState(false);
  const likeBusyRef = useRef(false);
  const likedRef = useRef(Boolean(post.liked));
  const likeCountRef = useRef(post.counts.likes);
  useEffect(() => {
    if (likeBusyRef.current) return;
    const serverLiked = Boolean(post.liked);
    const serverLikeCount = Math.max(0, Number(post.counts.likes) || 0);
    likedRef.current = serverLiked;
    likeCountRef.current = serverLikeCount;
    setLiked(serverLiked);
    setLikeCount(serverLikeCount);
  }, [post.id, post.liked, post.counts.likes]);
  const toggle = async (kind: 'like' | 'bookmark') => {
    if (!viewer) { onToast({ message: '操作するにはログインしてください', tone: 'error' }); return; }
    if (kind === 'like') {
      if (likeBusyRef.current) return;
      const beforeLiked = likedRef.current;
      const beforeLikeCount = likeCountRef.current;
      const nextLiked = !beforeLiked;
      const optimisticCount = Math.max(0, beforeLikeCount + (nextLiked ? 1 : -1));
      likeBusyRef.current = true;
      likedRef.current = nextLiked;
      likeCountRef.current = optimisticCount;
      setLiked(nextLiked);
      setLikeCount(optimisticCount);
      setLikeSyncing(true);
      try {
        const result = await api<ReactionMutationResponse>(`/api/posts/${encodeURIComponent(post.id)}/like`, {
          method: 'POST',
          body: JSON.stringify({ active: nextLiked }),
        });
        const confirmedLiked = typeof result.liked === 'boolean' ? result.liked : result.active;
        const confirmedCount = Number.isFinite(result.counts?.likes) ? Math.max(0, result.counts.likes) : optimisticCount;
        likedRef.current = confirmedLiked;
        likeCountRef.current = confirmedCount;
        setLiked(confirmedLiked);
        setLikeCount(confirmedCount);
        onLikeChange?.(post.id, confirmedLiked, confirmedCount);
      } catch {
        likedRef.current = beforeLiked;
        likeCountRef.current = beforeLikeCount;
        setLiked(beforeLiked);
        setLikeCount(beforeLikeCount);
        onToast({ message: 'いいねを保存できませんでした。通信を確認してください', tone: 'error' });
      } finally {
        likeBusyRef.current = false;
        setLikeSyncing(false);
      }
      return;
    }
    const nextBookmarked = !bookmarked;
    setBookmarked(nextBookmarked);
    try { await api<ReactionMutationResponse>(`/api/posts/${encodeURIComponent(post.id)}/bookmark`, { method: 'POST', body: JSON.stringify({ active: nextBookmarked }) }); }
    catch { setBookmarked(!nextBookmarked); onToast({ message: '保存できませんでした。通信を確認してください', tone: 'error' }); }
  };
  const authorAvailable = !post.author.isUnavailable;
  const authorAvatar = <Avatar profile={post.author} />;
  return <><article className="post-card" aria-labelledby={`post-${post.id}`}>
    <div className="post-card-header">
      {authorAvailable ? <button type="button" className="avatar-link" aria-label={post.author.displayName + 'のプロフィールを開く'} onClick={() => onNavigate({ name: 'profile', id: post.authorId })}>{authorAvatar}</button> : <span className="avatar-link avatar-link-unavailable" aria-label="削除されたユーザー">{authorAvatar}</span>}
      <div className="post-author">{authorAvailable ? <button type="button" className="post-author-name" onClick={() => onNavigate({ name: 'profile', id: post.authorId })}>{post.author.displayName}</button> : <span className="post-author-name">{post.author.displayName}</span>}<span className="post-author-meta">@{post.author.username} · {formatTime(post.createdAt)}</span></div>
      <Menu onReport={() => onToast({ message: '報告を受け付けました', tone: 'success' })} />
    </div>
    <button type="button" className="post-body post-body-button" id={`post-${post.id}`} onClick={() => onNavigate({ name: 'post', id: post.id })}>{post.body}</button>
    {post.media?.[0]?.url && <div className="post-media"><img src={post.media[0].url} alt={post.media[0].alt || '投稿画像'} loading="lazy" decoding="async" /></div>}
    <div className="post-actions" aria-label="投稿の操作">
      <button type="button" className={`post-action post-action-like ${liked ? 'is-active' : ''} ${likeSyncing ? 'is-syncing' : ''}`} onClick={() => void toggle('like')} aria-label={`${liked ? 'いいね済み' : 'いいね'}${likeSyncing ? '、同期中' : ''}、${likeCount}件`} aria-pressed={liked} aria-busy={likeSyncing} disabled={likeSyncing} title={liked ? 'いいね済み' : 'いいね'}>
        <span className="like-icon-wrap" aria-hidden="true"><Icon className="like-heart-icon" name="heart" size={18} filled={liked} />{liked && <span className="like-state-check">✓</span>}</span>
        <span>{likeCount}</span>
        <span className="like-sync-indicator" aria-hidden="true" />
      </button>
      <button type="button" className="post-action" onClick={() => onNavigate({ name: 'post', id: post.id })} aria-label={post.counts.comments ? 'コメント ' + post.counts.comments + '件' : 'コメントを開く'}><Icon name="message-circle" size={18} /><span>{post.counts.comments || 'コメント'}</span></button>
      <button type="button" className={`post-action ${bookmarked ? 'is-saved' : ''}`} onClick={() => void toggle('bookmark')} aria-label={bookmarked ? '保存を解除' : '投稿を保存'} aria-pressed={bookmarked}><Icon name="bookmark" size={18} filled={bookmarked} /><span>保存</span></button>
      {aiAvailability.visible && <button type="button" className="post-action ask-ai-action" onClick={() => viewer ? setAskOpen(true) : onToast({ message: 'Ask AIを使うにはログインしてください', tone: 'error' })}><span className="ask-ai-spark" aria-hidden="true">✦</span><span>Ask AI</span></button>}
    </div>
  </article>{askOpen && <AskAiDialog post={post} generationEnabled={aiAvailability.generationEnabled} onClose={() => setAskOpen(false)} onToast={onToast} />}</>;
}

function AskAiDialog({ post, generationEnabled, onClose, onToast }: { post: Post; generationEnabled: boolean; onClose: () => void; onToast: (toast: ToastState) => void }) {
  const [question, setQuestion] = useState('この投稿を説明して');
  const [mediaMode, setMediaMode] = useState<'auto' | 'include' | 'exclude'>('auto');
  const [answer, setAnswer] = useState<AskAiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const hasImages = Boolean(post.media?.some((item) => (item.type || '').startsWith('image/') || item.url));
  const submit = async () => {
    if (!generationEnabled) { onToast({ message: 'AI機能は現在準備中です', tone: 'error' }); return; }
    if (!question.trim()) return;
    controller.current?.abort();
    controller.current = new AbortController();
    setLoading(true); setAnswer(null);
    try {
      const result = await api<AskAiResponse>(`/api/posts/${encodeURIComponent(post.id)}/ask-ai`, { method: 'POST', signal: controller.current.signal, headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ question: question.trim(), mediaMode: hasImages ? mediaMode : 'exclude' }) });
      setAnswer(result);
    } catch (cause) {
      if (controller.current?.signal.aborted) return;
      const code = cause instanceof Error ? cause.message : '';
      const messages: Record<string, string> = { AI_DISABLED_BY_AUTHOR: 'この投稿ではAsk AIが許可されていません。', MEDIA_ANALYSIS_NOT_ALLOWED: 'この投稿では画像AI分析を利用できません。', USER_RATE_LIMIT: '少し時間をおいて再試行してください。', USER_GENERATION_LIMIT: '本日のAsk AI利用上限に達しました。', USER_UPSTREAM_BURN_LIMIT: '本日のAI処理上限に達しました。', AI_CAPACITY_UNAVAILABLE: 'AIが混雑しています。しばらくしてから再試行してください。', OPENROUTER_RATE_LIMIT: 'AIが混雑しています。約1分後に再試行してください。' };
      onToast({ message: messages[code] || 'Ask AIを利用できませんでした', tone: 'error' });
    } finally { setLoading(false); }
  };
  const close = () => { controller.current?.abort(); onClose(); };
  const feedback = async (rating: -1 | 1) => { if (!answer?.feedbackToken) return; try { await api('/api/ai/feedback', { method: 'POST', body: JSON.stringify({ feedbackToken: answer.feedbackToken, rating }) }); onToast({ message: 'フィードバックを送信しました', tone: 'success' }); } catch { onToast({ message: 'フィードバックを送信できませんでした', tone: 'error' }); } };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="dialog-shell ask-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="ask-ai-title"><div className="dialog-header"><div><p className="eyebrow">Connect Ask AI</p><h2 id="ask-ai-title">この投稿について質問</h2></div><button type="button" className="icon-button" onClick={close} aria-label="閉じる"><Icon name="x" size={20} /></button></div>{!generationEnabled && <div className="ask-ai-progress" role="status">AI機能は現在準備中です。画面のみ確認できます。</div>}{hasImages && <fieldset className="ask-ai-media-mode"><legend>分析する内容</legend>{([['auto', '自動'], ['include', '画像も含める'], ['exclude', '本文のみ']] as const).map(([value, label]) => <label key={value}><input type="radio" name="mediaMode" value={value} checked={mediaMode === value} onChange={() => setMediaMode(value)} />{label}</label>)}</fieldset>}<textarea value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} placeholder="この投稿の要点は？" disabled={loading || !generationEnabled} />{loading && <div className="ask-ai-progress" role="status">投稿を確認し、回答を作成しています…</div>}{answer && <div className="ask-ai-answer" aria-live="polite">{answer.insufficientContext && !answer.answer ? <p>この質問に答えるために必要な情報をAIが利用できません。</p> : <p>{answer.answer}</p>}{answer.degraded && <small>画像の一部を利用せず、投稿本文を中心に分析しています。</small>}{answer.coverage.videosTotal > 0 && <small>この回答では動画内容は解析していません。</small>}{answer.coverage.contextTruncated && <small>一部の関連返信のみを参考にしています。</small>}{answer.feedbackToken && <div className="ask-ai-feedback" aria-label="回答へのフィードバック"><button type="button" onClick={() => void feedback(1)}>👍</button><button type="button" onClick={() => void feedback(-1)}>👎</button></div>}</div>}<div className="dialog-footer"><Button variant="ghost" onClick={loading ? () => { controller.current?.abort(); setLoading(false); } : close}>{loading ? 'キャンセル' : '閉じる'}</Button><Button variant="primary" disabled={!generationEnabled || loading || !question.trim()} onClick={() => void submit()}>{loading ? '分析中…' : generationEnabled ? '質問する' : '準備中'}</Button></div></section></div>;
}

function Composer({ viewer, profile, onCreated, onToast }: { viewer: Viewer | null; profile: Profile | null; onCreated: (post: Post) => void; onToast: (toast: ToastState) => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);
  const submit = async () => {
    if (!viewer) { onToast({ message: '投稿するにはログインしてください', tone: 'error' }); return; }
    if (!body.trim()) return;
    setSending(true);
    try { const response = await api<{ post: Post }>('/api/posts', { method: 'POST', body: JSON.stringify({ body: body.trim() }) }); onCreated(response.post); setBody(''); setOpen(false); onToast({ message: '投稿しました', tone: 'success' }); }
    catch { onToast({ message: '投稿できませんでした', tone: 'error' }); }
    finally { setSending(false); }
  };
  return <>
    <section className="composer-card"><div className="composer-row">{viewer ? <Avatar profile={profile || { displayName: viewer.name, avatarUrl: viewer.image, avatarColor: 'var(--brand)' }} size="sm" /> : <span className="avatar avatar-sm avatar-placeholder">C</span>}<button type="button" className="composer-placeholder" onClick={() => setOpen(true)}>いまどうしてる？</button></div><div className="composer-footer"><span className="muted-small">短くても、あなたの言葉で。</span><Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" size={17} />新規ポスト</Button></div></section>
    {open && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="dialog-shell" role="dialog" aria-modal="true" aria-labelledby="compose-title"><div className="dialog-header"><h2 id="compose-title">新規ポスト</h2><button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="閉じる"><Icon name="x" size={20} /></button></div><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="いまどうしてる？" maxLength={5000} autoFocus /><div className="dialog-footer"><span className="muted-small">{body.length}/5000</span><Button variant="primary" disabled={sending || !body.trim()} onClick={() => void submit()}>{sending ? '投稿中…' : '投稿する'}</Button></div></section></div>}
  </>;
}

function Feed({ posts, viewer, viewerProfile, nextCursor, loading, onLoadMore, onCreated, onToast, onNavigate, mode, onModeChange, onLikeChange }: { posts: Post[]; viewer: Viewer | null; viewerProfile: Profile | null; nextCursor: string | null; loading: boolean; onLoadMore: () => void; onCreated: (post: Post) => void; onToast: (toast: ToastState) => void; onNavigate: (route: Route) => void; mode: string; onModeChange: (mode: string) => void; onLikeChange: PostLikeChange }) {
  return <>
    <Composer viewer={viewer} profile={viewerProfile} onCreated={onCreated} onToast={onToast} />
    <Tabs items={[{ key: 'recommended', label: 'おすすめ' }, { key: 'friends', label: '友達' }]} value={mode} onChange={onModeChange} label="フィード切り替え" />
    <section className="feed" aria-label="投稿一覧">
      {loading && !posts.length && <><Skeleton /><Skeleton /></>}
      {!loading && !posts.length && <div className="empty-state"><Icon className="empty-icon" name="search" size={30} /><h2>まだ投稿がありません</h2><p>検索したり、友達を見つけたりして会話を始めましょう。</p></div>}
      {posts.map((post) => <PostCard key={post.id} post={post} viewer={viewer} onToast={onToast} onNavigate={onNavigate} onLikeChange={onLikeChange} />)}
      {nextCursor && <Button variant="soft" className="load-more" onClick={onLoadMore} disabled={loading}>{loading ? '読み込み中…' : 'さらに読み込む'}</Button>}
    </section>
  </>;
}

function SearchPage({ onNavigate, onToast }: { onNavigate: (route: Route) => void; onToast: (toast: ToastState) => void }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [tab, setTab] = useState('all');
  const [posts, setPosts] = useState<Post[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (nextQuery = query, nextTab = tab) => { setSubmitted(nextQuery); if (!nextQuery.trim()) { setPosts([]); setProfiles([]); return; } setLoading(true); try { const result = await api<{ posts: Post[]; profiles: Profile[] }>(`/api/search?query=${encodeURIComponent(nextQuery.trim())}&tab=${encodeURIComponent(nextTab)}`); setPosts(result.posts || []); setProfiles(result.profiles || []); } catch { onToast({ message: '検索に失敗しました', tone: 'error' }); } finally { setLoading(false); } }, [onToast, query, tab]);
  useEffect((): (() => void) | undefined => {
    if (!query.trim()) return undefined;
    const timer = window.setTimeout((): void => { void load(query, tab); }, 300);
    return (): void => { window.clearTimeout(timer); };
  }, [query, tab]);
  return <div className="page-stack"><div className="section-heading"><div><p className="eyebrow">見つける</p><h1>探す</h1></div></div><SearchField value={query} onChange={setQuery} onSubmit={() => void load()} autoFocus /><Tabs items={[{ key: 'all', label: 'すべて' }, { key: 'posts', label: '投稿' }, { key: 'users', label: 'ユーザー' }]} value={tab} onChange={setTab} label="検索結果の種類" />{loading && <><Skeleton /><Skeleton /></>}{submitted && !loading && <><p className="result-caption">「{submitted}」の検索結果</p>{profiles.length > 0 && tab !== 'posts' && <section className="result-list" aria-label="ユーザー検索結果">{profiles.map((profile) => <button type="button" className="profile-result" key={profile.id} onClick={() => onNavigate({ name: 'profile', id: profile.id })}><Avatar profile={profile} size="sm" /><span><strong>{profile.displayName}</strong><small>@{profile.username}</small></span><Icon className="result-arrow" name="arrow-right" size={18} /></button>)}</section>}{posts.length > 0 && <section className="feed" aria-label="検索結果の投稿">{posts.map((post) => <PostCard key={post.id} post={post} viewer={null} onToast={onToast} onNavigate={onNavigate} />)}</section>}{!profiles.length && !posts.length && <div className="empty-state"><Icon className="empty-icon" name="search" size={30} /><h2>見つかりませんでした</h2><p>別のキーワードで試してみてください。</p></div>}</>}{!submitted && <div className="search-guide"><Icon className="guide-icon" name="search" size={30} /><h2>投稿と人を探す</h2><p>気になる言葉を入力すると、公開されている過去の投稿も表示されます。</p></div>}</div>;
}

function ProfileEditor({ profile, onClose, onSaved, onToast }: { profile: Profile; onClose: () => void; onSaved: (profile: Profile) => void; onToast: (toast: ToastState) => void }) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [username, setUsername] = useState(profile.username);
  const [bio, setBio] = useState(profile.bio || '');
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl || '');
  const [avatarColor, setAvatarColor] = useState(profile.avatarColor || '#4f46e5');
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!displayName.trim() || !username.trim()) return;
    setSaving(true);
    try {
      const result = await api<{ profile: Profile }>(`/api/profiles/${encodeURIComponent(profile.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayName: displayName.trim(), username: username.trim(), bio: bio.trim(), avatarUrl: avatarUrl.trim() || null, avatarColor }),
      });
      onSaved(result.profile);
      onClose();
      onToast({ message: 'プロフィールを更新しました。過去の投稿にも反映されています。', tone: 'success' });
    } catch (error) {
      onToast({ message: error instanceof Error && error.message === 'username_taken' ? 'そのユーザー名はすでに使われています' : 'プロフィールを更新できませんでした', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };
  const preview = { displayName: displayName.trim() || 'Connect user', avatarUrl: avatarUrl.trim() || null, avatarColor };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="dialog-shell profile-editor" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title" aria-describedby="profile-editor-hint" onSubmit={submit} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
      <div className="dialog-header"><div><h2 id="profile-editor-title">プロフィールを編集</h2><p id="profile-editor-hint" className="dialog-hint">保存すると、過去の投稿・検索結果にも現在の情報が表示されます。</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="閉じる"><Icon name="x" size={20} /></button></div>
      <div className="profile-editor-preview"><Avatar profile={preview} size="lg" /><p>投稿カードのプレビュー</p></div>
      <label className="profile-editor-label">表示名<input className="form-control" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} autoComplete="name" autoFocus required /></label>
      <label className="profile-editor-label">ユーザー名<input className="form-control" value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} pattern="[A-Za-z0-9_.-]+" autoComplete="username" required /></label>
      <label className="profile-editor-label">プロフィール画像のURL<input className="form-control" type="url" inputMode="url" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} placeholder="https://…" maxLength={2048} /></label>
      <label className="profile-editor-label profile-editor-color">アイコンの色<input type="color" value={avatarColor} onChange={(event) => setAvatarColor(event.target.value)} aria-label="アイコンの色" /><span>{avatarColor}</span></label>
      <label className="profile-editor-label">自己紹介<textarea className="form-control" value={bio} onChange={(event) => setBio(event.target.value)} maxLength={500} /></label>
      <div className="dialog-footer"><Button type="button" variant="ghost" onClick={onClose}>キャンセル</Button><Button type="submit" variant="primary" disabled={saving || !displayName.trim() || !username.trim()}>{saving ? '保存中…' : '保存する'}</Button></div>
    </form>
  </div>;
}

function ProfilePage({ profileId, viewer, onNavigate, onToast, onProfileUpdated, onLikeChange }: { profileId?: string; viewer: Viewer | null; onNavigate: (route: Route) => void; onToast: (toast: ToastState) => void; onProfileUpdated: (profile: Profile) => void; onLikeChange: PostLikeChange }) {
  const target = profileId || viewer?.id;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const load = useCallback(async (term = query) => {
    if (!target) return;
    setLoading(true);
    try {
      if (term.trim()) {
        const [profileResult, searchResult] = await Promise.all([
          api<{ profile: Profile }>(`/api/profiles/${encodeURIComponent(target)}`),
          api<{ posts: Post[] }>(`/api/search?tab=posts&authorId=${encodeURIComponent(target)}&query=${encodeURIComponent(term.trim())}`),
        ]);
        setProfile(profileResult.profile);
        setPosts(searchResult.posts || []);
      } else {
        const result = await api<{ profile: Profile; posts: Post[] }>(`/api/profiles/${encodeURIComponent(target)}`);
        setProfile(result.profile);
        setPosts(result.posts || []);
      }
    } catch {
      onToast({ message: 'プロフィールを読み込めませんでした', tone: 'error' });
    } finally {
      setLoading(false);
    }
  }, [onToast, query, target]);
  useEffect(() => { setQuery(''); setEditing(false); void load(''); }, [target]);
  useEffect((): (() => void) | undefined => {
    const timer = window.setTimeout((): void => { void load(query); }, query.trim() ? 300 : 0);
    return (): void => { window.clearTimeout(timer); };
  }, [query]);
  if (!target) return <div className="empty-state"><h2>ログインが必要です</h2><Button variant="primary" onClick={() => onNavigate({ name: 'login' })}>ログイン</Button></div>;
  const saved = (nextProfile: Profile) => {
    setProfile(nextProfile);
    setPosts((current) => current.map((post) => withCurrentProfile(post, nextProfile)));
    onProfileUpdated(nextProfile);
  };
  const updatePostLike: PostLikeChange = (postId, liked, likeCount) => {
    setPosts((current) => current.map((post) => post.id === postId ? { ...post, liked, counts: { ...post.counts, likes: likeCount } } : post));
    onLikeChange(postId, liked, likeCount);
  };
  return <div className="page-stack">{loading && !profile ? <><Skeleton lines={2} /><Skeleton /></> : profile && <><section className="profile-hero"><div className="profile-hero-top"><Avatar profile={profile} size="lg" /><div><h1>{profile.displayName}</h1><p>@{profile.username}</p></div>{viewer?.id === profile.id && <Button variant="soft" onClick={() => setEditing(true)}>プロフィールを編集</Button>}</div>{profile.bio && <p className="profile-bio">{profile.bio}</p>}</section><section className="profile-post-search" aria-label={`${profile.displayName}の過去の投稿を検索`}><p className="eyebrow">このユーザーの過去のポスト</p><h2>投稿を検索</h2><SearchField value={query} onChange={setQuery} onSubmit={() => void load()} placeholder={`${profile.displayName}の投稿を検索`} /><p className="result-caption">{query ? `「${query}」に一致する ${profile.displayName} の投稿` : '最近の投稿'}</p></section>{posts.length ? <section className="feed">{posts.map((post) => <PostCard key={post.id} post={post} viewer={viewer} onToast={onToast} onNavigate={onNavigate} onLikeChange={updatePostLike} />)}</section> : <div className="empty-state"><h2>{query ? '一致する投稿はありません' : '投稿はまだありません'}</h2><p>{query ? '別のキーワードで試してみてください。' : '新しい投稿がここに表示されます。'}</p></div>}{editing && <ProfileEditor profile={profile} onClose={() => setEditing(false)} onSaved={saved} onToast={onToast} />}</>}</div>;
}

function PostDetail({ postId, viewer, onNavigate, onToast, onLikeChange }: { postId?: string; viewer: Viewer | null; onNavigate: (route: Route) => void; onToast: (toast: ToastState) => void; onLikeChange: PostLikeChange }) {
  const [post, setPost] = useState<Post | null>(null);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => { if (!postId) return; void api<{ post: Post }>(`/api/posts/${encodeURIComponent(postId)}`).then((result) => setPost(result.post)).catch(() => onToast({ message: '投稿を読み込めませんでした', tone: 'error' })).finally(() => setLoading(false)); }, [onToast, postId]);
  const updatePostLike: PostLikeChange = (changedPostId, liked, likeCount) => {
    setPost((current) => current?.id === changedPostId ? { ...current, liked, counts: { ...current.counts, likes: likeCount } } : current);
    onLikeChange(changedPostId, liked, likeCount);
  };
  const submit = async () => { if (!viewer) { onToast({ message: 'コメントするにはログインしてください', tone: 'error' }); return; } if (!comment.trim() || !postId) return; try { await api(`/api/posts/${encodeURIComponent(postId)}/comments`, { method: 'POST', body: JSON.stringify({ body: comment.trim() }) }); setComment(''); onToast({ message: 'コメントしました', tone: 'success' }); } catch { onToast({ message: 'コメントできませんでした', tone: 'error' }); } };
  if (loading) return <Skeleton />;
  if (!post) return <div className="empty-state"><h2>投稿が見つかりません</h2><Button variant="soft" onClick={() => onNavigate({ name: 'home' })}>ホームへ戻る</Button></div>;
  return <div className="page-stack"><button type="button" className="back-link" onClick={() => window.history.back()}><Icon name="arrow-left" size={18} />戻る</button><PostCard post={post} viewer={viewer} onToast={onToast} onNavigate={onNavigate} onLikeChange={updatePostLike} /><section className="comment-box"><h2>コメント</h2><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="ひとこと残す" maxLength={2000} /><div className="comment-footer"><span className="muted-small">会話は穏やかに。</span><Button variant="primary" onClick={() => void submit()} disabled={!comment.trim()}>コメントする</Button></div></section></div>;
}

function LoginPage({ onLogin, onToast }: { onLogin: (viewer: Viewer) => void; onToast: (toast: ToastState) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async () => { setSending(true); try { const endpoint = mode === 'login' ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email'; const payload = mode === 'login' ? { email, password } : { email, password, name: name || email.split('@')[0] }; const result = await api<{ user: Viewer }>(endpoint, { method: 'POST', body: JSON.stringify(payload) }); onLogin(result.user); } catch { onToast({ message: mode === 'login' ? 'ログインできませんでした' : 'アカウントを作成できませんでした', tone: 'error' }); } finally { setSending(false); } };
  return <div className="auth-panel"><div className="auth-mark">C</div><p className="eyebrow">Connectへようこそ</p><h1>{mode === 'login' ? 'おかえりなさい' : '新しくつながる'}</h1><p className="auth-copy">読みやすいタイムラインで、あなたのペースの会話を。</p>{mode === 'signup' && <label>表示名<input value={name} onChange={(event) => setName(event.target.value)} placeholder="表示名" autoComplete="name" /></label>}<label>メールアドレス<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="you@example.com" autoComplete="email" /></label><label>パスワード<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="8文字以上" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label><Button variant="primary" className="auth-submit" disabled={sending || !email || password.length < 8} onClick={() => void submit()}>{sending ? '処理中…' : mode === 'login' ? 'ログイン' : 'アカウントを作成'}</Button><button type="button" className="text-button" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'はじめて利用する' : 'アカウントをお持ちの方'}</button></div>;
}

function AiSettings({ viewer, onNavigate, onToast }: { viewer: Viewer | null; onNavigate: (route: Route) => void; onToast: (toast: ToastState) => void }) {
  const [textAnalysis, setTextAnalysis] = useState<'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT'>('DISABLED');
  const [mediaAnalysis, setMediaAnalysis] = useState<'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT'>('DISABLED');
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!viewer) return; void api<{ currentPolicyVersion: string; preferences: { acceptedPolicyVersion: string | null; textAnalysis: typeof textAnalysis; mediaAnalysis: typeof mediaAnalysis } }>('/api/ai/preferences').then((result) => { setTextAnalysis(result.preferences.textAnalysis); setMediaAnalysis(result.preferences.mediaAnalysis); setAccepted(result.preferences.acceptedPolicyVersion === result.currentPolicyVersion); }).catch(() => onToast({ message: 'AI設定を読み込めませんでした', tone: 'error' })); }, [viewer]);
  if (!viewer) return <div className="empty-state"><h2>ログインが必要です</h2><Button variant="primary" onClick={() => onNavigate({ name: 'login' })}>ログイン</Button></div>;
  const save = async () => { if (!accepted) { onToast({ message: 'AI処理ポリシーへの同意が必要です', tone: 'error' }); return; } setSaving(true); try { await api('/api/ai/preferences', { method: 'PUT', body: JSON.stringify({ textAnalysis, mediaAnalysis, acceptCurrentPolicy: true }) }); onToast({ message: 'AI分析の設定を保存しました', tone: 'success' }); } catch { onToast({ message: 'AI設定を保存できませんでした', tone: 'error' }); } finally { setSaving(false); } };
  return <div className="page-stack"><div className="section-heading"><div><p className="eyebrow">プライバシー</p><h1>AIによる投稿分析</h1></div></div><section className="settings-card"><p>あなたの投稿をAsk AIで分析できる範囲を、本文と画像で別々に設定します。外部AI providerへ送信される場合があります。</p><label>本文の分析<select className="form-control" value={textAnalysis} onChange={(event) => setTextAnalysis(event.target.value as typeof textAnalysis)}><option value="DISABLED">許可しない</option><option value="PUBLIC_ONLY">公開投稿のみ</option><option value="AUTHORIZED_CONTEXT">閲覧を許可した投稿</option></select></label><label>画像の分析<select className="form-control" value={mediaAnalysis} onChange={(event) => setMediaAnalysis(event.target.value as typeof mediaAnalysis)}><option value="DISABLED">許可しない</option><option value="PUBLIC_ONLY">公開投稿のみ</option><option value="AUTHORIZED_CONTEXT">閲覧を許可した投稿</option></select></label><label className="settings-consent"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />現在のAI処理ポリシーを確認し、この設定に同意します</label><p className="muted-small">画像への同意は、画像に写る第三者の同意を意味しません。個人情報や秘密情報を含む画像ではAI分析を許可しないでください。</p><Button variant="primary" disabled={saving || !accepted} onClick={() => void save()}>{saving ? '保存中…' : '設定を保存'}</Button></section></div>;
}

function App() {
  const [route, setRoute] = useState<Route>(() => routeFromHash());
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerProfile, setViewerProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [feedMode, setFeedMode] = useState('recommended');
  const [loading, setLoading] = useState(true);
  const [database, setDatabase] = useState(true);
  const [toast, setToast] = useState<ToastState>(null);
  const [rum, setRum] = useState(rumSnapshot());
  const [aiAvailability, setAiAvailability] = useState<AiAvailability>(buildAiAvailability);
  useEffect(() => { const clean = startRum(); const timer = window.setInterval(() => setRum(rumSnapshot()), 2000); return () => { clean?.(); window.clearInterval(timer); }; }, []);
  useEffect((): (() => void) => { const timer = window.setTimeout((): void => { const snapshot = rumSnapshot(); void api('/api/rum', { method: 'POST', body: JSON.stringify({ route: window.location.hash || '#/feed', ...snapshot }) }).catch((): void => { /* RUM is best effort. */ }); }, 5000); return (): void => { window.clearTimeout(timer); }; }, []);
  useEffect(() => { const update = () => setRoute(routeFromHash()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  useEffect(() => { const timer = toast ? window.setTimeout(() => setToast(null), 3200) : undefined; return () => { if (timer) window.clearTimeout(timer); }; }, [toast]);
  const loadFeed = useCallback(async (cursor: string | null = null, replace = true, mode = feedMode) => { setLoading(true); try { const result = await api<{ posts: Post[]; nextCursor: string | null; database?: boolean }>(`/api/feed?mode=${mode}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); setDatabase(result.database !== false); setPosts((old) => replace ? (result.posts || []) : [...old, ...(result.posts || [])]); setNextCursor(result.nextCursor); } catch { setDatabase(false); setPosts((old) => old.length ? old : fallbackPosts); setNextCursor(null); } finally { setLoading(false); } }, [feedMode]);
  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<Bootstrap>('/api/bootstrap');
      setViewer(result.viewer);
      setViewerProfile(result.profile);
      setDatabase(result.database !== false);
      setPosts(result.feed?.length ? result.feed : result.database === false ? fallbackPosts : []);
      setNextCursor(result.nextCursor);
    } catch {
      setViewerProfile(null);
      setPosts(fallbackPosts);
      setDatabase(false);
    } finally {
      setLoading(false);
    }
  }, []);
  const updatePostLike = useCallback<PostLikeChange>((postId, liked, likeCount) => {
    setPosts((current) => current.map((post) => post.id === postId
      ? { ...post, liked, counts: { ...post.counts, likes: likeCount } }
      : post));
  }, []);
  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);
  useEffect(() => {
    void api<AiAvailability>('/api/ai/status')
      .then(setAiAvailability)
      .catch(() => setAiAvailability(buildAiAvailability));
  }, [viewer?.id]);
  useEffect(() => { if (route.name === 'home' && viewer !== undefined) void loadFeed(null, true, feedMode); }, [feedMode]);
  const addCreated = (post: Post) => setPosts((old) => [post, ...old]);
  const onProfileUpdated = (profile: Profile) => {
    setViewerProfile(profile);
    setPosts((current) => current.map((post) => withCurrentProfile(post, profile)));
  };
  const login = (nextViewer: Viewer) => { setViewer(nextViewer); void loadBootstrap(); navigate({ name: 'home' }); setToast({ message: 'ログインしました', tone: 'success' }); };
  const logout = async () => { try { await api('/api/auth/sign-out', { method: 'POST' }); } finally { setViewer(null); setViewerProfile(null); navigate({ name: 'home' }); setToast({ message: 'ログアウトしました', tone: 'success' }); } };
  const title = route.name === 'home' ? 'ホーム' : route.name === 'explore' ? '探す' : route.name === 'profile' ? 'プロフィール' : route.name === 'post' ? '投稿' : route.name === 'friends' ? '友達' : route.name === 'notifications' ? '通知' : route.name === 'settings' ? '設定' : 'ログイン';
  const content = route.name === 'home' ? <><div className="section-heading"><div><p className="eyebrow">あなたのタイムライン</p><h1>ホーム</h1></div><Button variant="primary" className="desktop-compose" onClick={() => document.querySelector<HTMLButtonElement>('.composer-placeholder')?.click()}><Icon name="plus" size={17} />新規ポスト</Button></div><Feed posts={posts} viewer={viewer} viewerProfile={viewerProfile} nextCursor={nextCursor} loading={loading} onLoadMore={() => void loadFeed(nextCursor, false)} onCreated={addCreated} onToast={setToast} onNavigate={navigate} mode={feedMode} onModeChange={setFeedMode} onLikeChange={updatePostLike} /></> : route.name === 'explore' ? <SearchPage onNavigate={navigate} onToast={setToast} /> : route.name === 'profile' ? <ProfilePage profileId={route.id} viewer={viewer} onNavigate={navigate} onToast={setToast} onProfileUpdated={onProfileUpdated} onLikeChange={updatePostLike} /> : route.name === 'post' ? <PostDetail postId={route.id} viewer={viewer} onNavigate={navigate} onToast={setToast} onLikeChange={updatePostLike} /> : route.name === 'settings' ? <AiSettings viewer={viewer} onNavigate={navigate} onToast={setToast} /> : route.name === 'login' ? <LoginPage onLogin={login} onToast={setToast} /> : <div className="empty-state"><Icon className="empty-icon" name={route.name === 'notifications' ? 'bell' : 'users'} size={30} /><h2>{title}</h2><p>ここは軽い操作をまとめる場所です。必要な情報だけを表示します。</p>{route.name === 'friends' && !viewer && <Button variant="primary" onClick={() => navigate({ name: 'login' })}>ログイン</Button>}</div>;
  if (route.name === 'login') return <AiAvailabilityContext.Provider value={aiAvailability}><main className="auth-layout"><LoginPage onLogin={login} onToast={setToast} />{toast && <Toast toast={toast} />}</main></AiAvailabilityContext.Provider>;
  return <AiAvailabilityContext.Provider value={aiAvailability}><><div className="app-shell"><a className="skip-link" href="#main-content">本文へ移動</a><header className="topbar"><a className="brand" href="#/feed" aria-label="Connect ホーム"><span className="brand-mark">C</span><span className="brand-name">Connect</span></a><div className="topbar-actions"><button type="button" className="icon-button" aria-label="通知" title="通知" onClick={() => navigate({ name: 'notifications' })}><Icon name="bell" size={20} /></button>{viewer ? <details className="account-menu"><summary className="avatar-button" aria-label="アカウントメニュー"><Avatar profile={viewerProfile || { displayName: viewer.name, avatarUrl: viewer.image, avatarColor: 'var(--brand)' }} size="sm" /></summary><div className="menu-popover account-popover"><button type="button" onClick={() => navigate({ name: 'profile', id: viewer.id })}>プロフィール</button><button type="button" onClick={() => void logout()}>ログアウト</button></div></details> : <Button variant="soft" onClick={() => navigate({ name: 'login' })}>ログイン</Button>}</div></header><div className="app-layout"><aside className="sidebar" aria-label="メインナビゲーション"><nav className="sidebar-nav">{navItems.map((item) => <button type="button" key={item.name} className={`nav-button ${route.name === item.name ? 'is-active' : ''}`} onClick={() => navigate({ name: item.name })}><span className="nav-icon"><Icon name={item.icon} size={20} /></span><span>{item.label}</span></button>)}<button type="button" className={`nav-button ${route.name === 'settings' ? 'is-active' : ''}`} onClick={() => navigate({ name: 'settings' })}><span className="nav-icon"><Icon name="settings" size={20} /></span><span>設定</span></button></nav><Button variant="primary" className="compose-button" onClick={() => document.querySelector<HTMLButtonElement>('.composer-placeholder')?.click()}><Icon name="plus" size={18} /><span>新規ポスト</span></Button></aside><main id="main-content" className="main-column" tabIndex={-1}>{content}</main><aside className="context-column" aria-label="サイド情報"><section className="context-card"><p className="eyebrow">今日のConnect</p><h2>気になる話題から、ゆっくり。</h2><p>本文と投稿者を中心に、必要な操作だけを近くに置いています。</p></section><section className="context-card subtle"><p className="eyebrow">操作のヒント</p><p>検索は全体にもプロフィール内にも使えます。軽い操作はその場で完了します。</p></section></aside></div>{toast && <Toast toast={toast} />}{new URLSearchParams(window.location.search).has('metrics') && <div className="metrics-panel" aria-label="実測メトリクス">LCP {rum.lcp ?? '—'}ms · INP {rum.inp ?? '—'}ms · CLS {rum.cls} · TTFB {rum.ttfb ?? '—'}ms · JS {rum.jsBytes}B · IMG {rum.imageBytes}B · {database ? 'D1' : 'preview'}</div>}</div><nav className="bottom-nav" aria-label="モバイルナビゲーション">{navItems.slice(0, 4).map((item) => <button type="button" key={item.name} className={`bottom-nav-button ${route.name === item.name ? 'is-active' : ''}`} onClick={() => navigate({ name: item.name })}><Icon name={item.icon} size={20} /><small>{item.label}</small></button>)}</nav></></AiAvailabilityContext.Provider>;
}

function Toast({ toast }: { toast: ToastState }) { return toast ? <div className={`toast toast-${toast.tone || 'success'}`} role="status">{toast.message}</div> : null; }

export { App };
