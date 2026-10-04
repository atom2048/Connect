const fs = require('node:fs');
(async () => {
  const origin = 'https://sns-app-ashen.vercel.app';
  const { post } = await (await fetch(origin + '/api/posts/H2wlnmbFr8XGMXSq2Rma')).json();
  const url = 'https://connect-social-standalone.quest-live.workers.dev' + post.media[0].url;
  const results = [];
  for (const method of ['GET', 'OPTIONS']) {
    const r = await fetch(url, { method, headers: { Origin: origin, ...(method === 'GET' ? { Range: 'bytes=0-63' } : { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Range' }) } });
    results.push({ method, status: r.status, headers: Object.fromEntries(['content-type','content-range','access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-expose-headers'].map(k => [k, r.headers.get(k)])) });
    await r.arrayBuffer();
  }
  fs.writeFileSync('evidence/cors-verification.json', JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
