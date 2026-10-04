const NEWS_SECTIONS = [
  {
    category: 'ニュース',
    limit: 10,
    feeds: [
      { url: 'https://www3.nhk.or.jp/rss/news/cat0.xml', source: 'NHKニュース', genre: '主要' },
      { url: 'https://www3.nhk.or.jp/rss/news/cat1.xml', source: 'NHKニュース', genre: '社会' },
      { url: 'https://www3.nhk.or.jp/rss/news/cat5.xml', source: 'NHKニュース', genre: '国際' },
      { url: 'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml', source: 'ITmedia NEWS', genre: 'IT' },
      { url: 'https://gigazine.net/news/rss_2.0/', source: 'GIGAZINE', genre: 'テック' },
      { url: 'https://www.asahi.com/rss/asahi/newsheadlines.rdf', source: '朝日新聞', genre: '主要' },
      { url: 'https://mainichi.jp/rss/etc/mainichi-flash.rss', source: '毎日新聞', genre: '総合' },
      { url: 'https://www.jiji.com/rss/ranking.rdf', source: '時事通信', genre: '時事' },
      { url: 'https://toyokeizai.net/list/feed/rss', source: '東洋経済オンライン', genre: '経済/ビジネス' },
      { url: 'https://news.yahoo.co.jp/rss/topics/top-picks.xml', source: 'Yahoo!ニュース', genre: 'トップ', maxItems: 1 },
      { url: 'https://news.yahoo.co.jp/rss/topics/business.xml', source: 'Yahoo!ニュース', genre: '経済', maxItems: 1 },
    ],
  },
  {
    category: 'エンタメ',
    limit: 10,
    feeds: [
      { url: 'https://natalie.mu/music/feed/news', source: '音楽ナタリー', genre: '音楽' },
      { url: 'https://natalie.mu/comic/feed/news', source: 'コミックナタリー', genre: 'コミック' },
      { url: 'https://natalie.mu/eiga/feed/news', source: '映画ナタリー', genre: '映画' },
      { url: 'https://natalie.mu/owarai/feed/news', source: 'お笑いナタリー', genre: 'お笑い' },
      { url: 'https://realsound.jp/movie/feed', source: 'リアルサウンド映画部', genre: 'ドラマ/映画' },
      { url: 'https://animeanime.jp/rss/index.rdf', source: 'アニメ！アニメ！', genre: 'アニメ' },
      { url: 'https://news.yahoo.co.jp/rss/topics/entertainment.xml', source: 'Yahoo!ニュース', genre: '芸能', maxItems: 2 },
    ],
  },
  {
    category: 'スポーツ',
    limit: 10,
    feeds: [
      { url: 'https://www.nikkansports.com/baseball/professional/atom.xml', source: '日刊スポーツ', genre: '野球' },
      { url: 'https://www.nikkansports.com/sports/atom.xml', source: '日刊スポーツ', genre: 'スポーツ総合' },
      { url: 'https://www.football-zone.net/feed', source: 'FOOTBALL ZONE', genre: 'サッカー' },
      { url: 'https://www.soccer-king.jp/feed', source: 'サッカーキング', genre: '海外サッカー' },
      { url: 'https://basketballking.jp/feed', source: 'バスケットボールキング', genre: 'バスケ' },
      { url: 'https://the-ans.jp/feed/', source: 'THE ANSWER', genre: 'アスリート' },
      { url: 'https://news.yahoo.co.jp/rss/topics/sports.xml', source: 'Yahoo!ニュース', genre: 'スポーツ速報', maxItems: 2 },
    ],
  },
];

const NEWS_CACHE_TTL = 8 * 60 * 1000;
let newsPayloadCache = null;
let newsPayloadCacheAt = 0;
let newsPayloadInflight = null;

const STATIC_NEWS_FALLBACK = NEWS_SECTIONS.flatMap(section => (
  Array.from({ length: Math.min(section.limit, 4) }, (_, index) => ({
    id: `fallback-${section.category}-${index}`,
    title: `${section.category}を更新中`,
    url: 'https://news.google.com/topstories?hl=ja&gl=JP&ceid=JP:ja',
    source: 'Connect News',
    category: section.category,
    genre: section.feeds[index % section.feeds.length]?.genre || section.category,
    publishedAt: new Date().toUTCString(),
    summary: '最新記事を取得中です。表示できる記事から順に自動で更新されます。',
    image: '',
    heat: Math.max(80, 600 - index * 40),
    articles: [],
    provisional: true,
  }))
));

function staticNewsPayload(reason = '') {
  return {
    updatedAt: new Date().toISOString(),
    fallback: true,
    reason,
    items: STATIC_NEWS_FALLBACK,
  };
}

function stripCdata(value = '') {
  return String(value).replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decodeHtml(value = '') {
  return stripCdata(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(value = '') {
  return decodeHtml(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactText(value = '', max = 104) {
  const clean = stripTags(value)
    .replace(/関連記事.*$/u, '')
    .replace(/続きを読む.*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.length > max ? clean.slice(0, max) + '...' : clean;
}

function pick(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  return decodeHtml(block.match(re)?.[1] || '');
}

function pickAttr(block, tag, attr) {
  const re = new RegExp('<' + tag + '[^>]+(?:' + attr + ')=["\\\']([^"\\\']+)["\\\'][^>]*>', 'i');
  return decodeHtml(block.match(re)?.[1] || '');
}

function pickAtomLink(block) {
  const alternate = block.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["'][^>]*>/i)?.[1];
  const anyHref = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1];
  return decodeHtml(alternate || anyHref || '');
}

function absoluteUrl(value = '', base = '') {
  try { return new URL(decodeHtml(value), base).href; } catch (_) { return decodeHtml(value || ''); }
}

function hostOf(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

function isBadNewsImage(url = '') {
  const value = String(url).toLowerCase();
  return !value
    || value.includes('news.google.com')
    || value.includes('gstatic.com')
    || value.includes('googleusercontent.com')
    || value.includes('google.com/images')
    || value.includes('/google_news')
    || value.includes('logo')
    || value.includes('favicon')
    || value.includes('ogp_default')
    || value.includes('/images/ogp')
    || value.includes('sprite')
    || value.includes('avatar')
    || value.includes('unsplash.com')
    || value.includes('picsum.photos')
    || value.startsWith('data:');
}

function normalizeTopicText(value = '') {
  return stripTags(value)
    .replace(/Yahoo!ニュース|ニュース|速報|写真|動画|記事全文|全文|国内|国際|エンタメ|スポーツ|日刊スポーツ|ナタリー/g, '')
    .replace(/[【】「」『』（）()\[\]〈〉《》・、。,.!！?？:：\-ー〜~\s]/g, '')
    .toLowerCase();
}

function topicNgrams(value = '', size = 3) {
  const text = normalizeTopicText(value);
  const grams = new Set();
  for (let i = 0; i <= text.length - size; i += 1) grams.add(text.slice(i, i + size));
  return grams;
}

function isSameTopic(a = '', b = '') {
  const at = normalizeTopicText(a);
  const bt = normalizeTopicText(b);
  if (!at || !bt) return false;
  if (at.includes(bt) || bt.includes(at)) return true;
  const a3 = topicNgrams(a, 3);
  const b3 = topicNgrams(b, 3);
  let overlap3 = 0;
  for (const gram of b3) if (a3.has(gram)) overlap3 += 1;
  const ratio3 = overlap3 / Math.max(1, Math.min(a3.size, b3.size));
  if (overlap3 >= 3 && ratio3 >= 0.18) return true;
  const a2 = topicNgrams(a, 2);
  const b2 = topicNgrams(b, 2);
  let overlap2 = 0;
  for (const gram of b2) if (a2.has(gram)) overlap2 += 1;
  const ratio2 = overlap2 / Math.max(1, Math.min(a2.size, b2.size));
  return overlap2 >= 6 && ratio2 >= 0.27;
}

function extractMeta(html = '', baseUrl = '') {
  const title = stripTags([
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ].map(re => html.match(re)?.[1]).find(Boolean) || '');
  const description = stripTags([
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
  ].map(re => html.match(re)?.[1]).find(Boolean) || '');
  const imageCandidates = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ].map(re => html.match(re)?.[1]).filter(Boolean).map(url => absoluteUrl(url, baseUrl));

  const jsonLd = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of jsonLd) {
    try {
      const parsed = JSON.parse(stripCdata(script[1]));
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const image = Array.isArray(entry.image) ? entry.image[0] : entry.image?.url || entry.image;
        if (image) imageCandidates.push(absoluteUrl(image, baseUrl));
      }
    } catch (_) {}
  }

  const imgMatches = [...html.matchAll(/<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi)];
  for (const match of imgMatches) {
    const tag = match[0].toLowerCase();
    const src = absoluteUrl(match[1], baseUrl);
    if (tag.includes('logo') || tag.includes('icon') || tag.includes('avatar') || tag.includes('sprite')) continue;
    if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(src)) imageCandidates.push(src);
  }

  return { title, description, image: imageCandidates.find(url => !isBadNewsImage(url)) || '' };
}

async function fetchText(url, signal) {
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ConnectNewsBot/2.0; +https://sns-app-ashen.vercel.app)',
      'Accept': 'text/html,application/xhtml+xml,application/xml,text/xml,application/rss+xml,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(String(res.status) + ' ' + url);
  const bytes = await res.arrayBuffer();
  const contentType = res.headers.get('content-type') || '';
  let charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim().toLowerCase() || '';
  let text = '';
  try {
    text = new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch (_) {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  if (!charset) {
    const declared = text.slice(0, 600).match(/charset=["']?([^"'\s/>]+)/i)?.[1]?.trim().toLowerCase();
    if (declared && declared !== 'utf-8') {
      try { text = new TextDecoder(declared).decode(bytes); } catch (_) {}
    }
  }
  return { text, url: res.url || url };
}

function parseFeedItems(xml = '', feed) {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(match => match[2]);
  return blocks.slice(0, feed.maxItems || 8).map((block, index) => {
    const atomLink = pickAtomLink(block);
    const link = pick(block, 'link') || atomLink || pick(block, 'guid');
    const enclosureImage = pickAttr(block, 'enclosure', 'url') || pickAttr(block, 'media:content', 'url') || pickAttr(block, 'media:thumbnail', 'url');
    const title = stripTags(pick(block, 'title'));
    const description = stripTags(pick(block, 'description') || pick(block, 'summary') || pick(block, 'content:encoded'));
    const publishedAt = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated') || '';
    return {
      id: 'news-' + feed.category + '-' + feed.genre + '-' + index + '-' + Buffer.from(title || link).toString('base64').slice(0, 12),
      title,
      url: absoluteUrl(link, feed.url),
      source: feed.source,
      category: feed.category,
      genre: feed.genre,
      publishedAt,
      summary: compactText(description, 110),
      imageHint: enclosureImage && !isBadNewsImage(enclosureImage) ? absoluteUrl(enclosureImage, feed.url) : '',
      heat: Math.max(80, 1600 - index * 83),
    };
  }).filter(item => item.title && item.url && !item.url.includes('news.google.com'));
}

async function fetchFeed(feed, signal) {
  try {
    const { text } = await fetchText(feed.url, signal);
    return parseFeedItems(text, feed);
  } catch (error) {
    console.warn('feed failed', feed.url, error.message);
    return [];
  }
}

async function enrichCandidate(item, signal) {
  try {
    const page = await fetchText(item.url, signal);
    const meta = extractMeta(page.text, page.url);
    const title = compactText(meta.title, 90) || item.title;
    const image = item.imageHint && !isBadNewsImage(item.imageHint) ? item.imageHint : meta.image;
    if (!image || isBadNewsImage(image)) return null;
    const summary = compactText(meta.description, 115) || item.summary || title + 'に関する最新記事です。';
    return { ...item, url: page.url || item.url, title, summary, image, articles: [{ title, url: page.url || item.url, image, source: item.source }] };
  } catch (_) {
    if (!item.imageHint) return null;
    return { ...item, image: item.imageHint, articles: [{ title: item.title, url: item.url, image: item.imageHint, source: item.source }] };
  }
}

function pickDiverseItems(candidates, limit) {
  const selected = [];
  const sourceCounts = new Map();
  const genreCounts = new Map();
  const hosts = new Set();
  const passes = [
    { maxSource: 2, maxGenre: 2, uniqueHost: true },
    { maxSource: 3, maxGenre: 3, uniqueHost: false },
    { maxSource: 4, maxGenre: 4, uniqueHost: false },
  ];
  for (const pass of passes) {
    for (const item of candidates) {
      if (selected.length >= limit) break;
      if (selected.some(existing => existing.url === item.url || existing.image === item.image)) continue;
      if (selected.some(existing => isSameTopic(existing.title, item.title))) continue;
      const host = hostOf(item.url);
      const sourceCount = sourceCounts.get(item.source) || 0;
      const genreCount = genreCounts.get(item.genre) || 0;
      if (sourceCount >= pass.maxSource || genreCount >= pass.maxGenre) continue;
      if (pass.uniqueHost && hosts.has(host)) continue;
      selected.push(item);
      sourceCounts.set(item.source, sourceCount + 1);
      genreCounts.set(item.genre, genreCount + 1);
      if (host) hosts.add(host);
    }
  }
  return selected.slice(0, limit);
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildSection(section, signal) {
  const feeds = section.feeds.map(feed => ({ ...feed, category: section.category }));
  const feedResults = await Promise.all(feeds.map(feed => fetchFeed(feed, signal)));
  const byRoundRobin = [];
  const maxRows = Math.max(...feedResults.map(items => items.length), 0);
  for (let row = 0; row < maxRows; row += 1) {
    for (const items of feedResults) if (items[row]) byRoundRobin.push(items[row]);
  }
  const urlSeen = new Set();
  const candidates = byRoundRobin.filter(item => item.url && !urlSeen.has(item.url) && urlSeen.add(item.url)).slice(0, 32);
  const enriched = (await mapLimit(candidates, 6, item => enrichCandidate(item, signal))).filter(Boolean);
  const fallback = candidates.map(item => ({
    ...item,
    summary: item.summary || compactText(item.title, 100),
    image: item.imageHint || '',
    articles: [{ title: item.title, url: item.url, image: item.imageHint || '', source: item.source }],
  }));
  const enrichedUrls = new Set(enriched.map(item => item.url));
  const merged = [...enriched, ...fallback.filter(item => !enrichedUrls.has(item.url))];
  const selected = pickDiverseItems(merged, section.limit);
  const safeSelected = selected.length ? selected : STATIC_NEWS_FALLBACK.filter(item => item.category === section.category);
  return safeSelected.map((item, index) => ({ ...item, heat: Math.max(80, 1800 - index * 91) }));
}

async function buildNewsPayload(signal) {
  const sections = await Promise.all(NEWS_SECTIONS.map(section => buildSection(section, signal)));
  return { updatedAt: new Date().toISOString(), items: sections.flat() };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=480, stale-while-revalidate=1800');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const now = Date.now();
  const forceRefresh = req.query?.refresh === '1';
  if (!forceRefresh && newsPayloadCache && now - newsPayloadCacheAt < NEWS_CACHE_TTL) {
    return res.status(200).json({ ...newsPayloadCache, cached: true });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4300);
  try {
    if (!forceRefresh && newsPayloadInflight) {
      const payload = await newsPayloadInflight;
      return res.status(200).json({ ...payload, cached: true });
    }
    newsPayloadInflight = buildNewsPayload(controller.signal);
    const payload = await newsPayloadInflight;
    newsPayloadCache = payload;
    newsPayloadCacheAt = Date.now();
    res.status(200).json(payload);
  } catch (error) {
    if (newsPayloadCache) {
      return res.status(200).json({ ...newsPayloadCache, cached: true, stale: true });
    }
    res.status(200).json(staticNewsPayload(error.message));
  } finally {
    clearTimeout(timer);
    newsPayloadInflight = null;
  }
}
