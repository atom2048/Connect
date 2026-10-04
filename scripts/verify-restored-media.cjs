const fs=require('node:fs');const crypto=require('node:crypto');
(async()=>{
 const ids=process.argv.slice(2);if(!ids.length)throw Error('Supply post IDs');const records=[];
 for(const id of ids){
  const response=await fetch('https://sns-app-ashen.vercel.app/api/posts/'+id,{headers:{'Cache-Control':'no-cache'}});const data=await response.json();const record={id,apiStatus:response.status,media:[]};
  if(!response.ok||!data.post?.media?.length)throw Error('Unresolved post '+id);
  for(const item of data.post.media){for(const field of ['url','previewUrl']){
   if(!item[field])continue;const endpoint='https://sns-app-ashen.vercel.app'+item[field];
   for(const method of ['HEAD','GET','RANGE','SEEK','SUFFIX','UNSATISFIABLE']){
    const range=method==='RANGE'?'bytes=0-63':method==='SEEK'?'bytes=100000-100063':method==='SUFFIX'?'bytes=-64':method==='UNSATISFIABLE'?'bytes=9999999999-':null;
    const r=await fetch(endpoint,{method:method==='HEAD'?'HEAD':'GET',headers:{Origin:'https://sns-app-ashen.vercel.app',...(range?{Range:range}:{})}});const bytes=Buffer.from(await r.arrayBuffer());
    const entry={field,key:item[field].split('?')[0],method,range,status:r.status,contentType:r.headers.get('content-type'),contentRange:r.headers.get('content-range'),acceptRanges:r.headers.get('accept-ranges'),contentLength:r.headers.get('content-length'),cors:r.headers.get('access-control-allow-origin'),cfRay:r.headers.get('cf-ray'),bytes:bytes.length,...(method==='GET'?{sha256:crypto.createHash('sha256').update(bytes).digest('hex')}:{})};
    record.media.push(entry);console.log(JSON.stringify({id,...entry}));
   }
  }}records.push(record);
 }
 fs.writeFileSync('evidence/production-http-verification.json',JSON.stringify(records,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
