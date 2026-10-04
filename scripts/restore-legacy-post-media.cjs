// Defaults to a read-only plan. Copies exact source objects, never rewrites posts or ACLs.
const fs=require('node:fs');const crypto=require('node:crypto');
const {getGlobalDefaultAccount,getAccessToken}=require('C:/Users/akihi/AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js');
const project='connect-b5e82', bucket=project+'.firebasestorage.app';
const account='bcfe08aa0c948734fe28c1b99e977b43';
function hash(bytes,algorithm='sha256'){return crypto.createHash(algorithm).update(bytes).digest('hex');}
function decode(v){if(v.stringValue!==undefined)return v.stringValue;if(v.integerValue!==undefined)return Number(v.integerValue);if(v.arrayValue)return(v.arrayValue.values||[]).map(decode);if(v.mapValue)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,v])=>[k,decode(v)]));return null;}
(async()=>{
 const apply=process.argv.includes('--apply');const ids=process.argv.slice(2).filter(v=>v!=='--apply');if(!ids.length||ids.some(id=>!/^[-\w]{1,160}$/.test(id)))throw Error('Supply exact post IDs; --apply performs verified object copies');
 const a=getGlobalDefaultAccount();if(!a)throw Error('Firebase login unavailable');const t=await getAccessToken(a.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
 const config=fs.readFileSync('C:/Users/akihi/AppData/Roaming/xdg.config/.wrangler/config/default.toml','utf8');const cfToken=config.match(/oauth_token\s*=\s*"([^"]+)"/)[1];
 const googleHeaders={Authorization:'Bearer '+t.access_token};const cfHeaders={Authorization:'Bearer '+cfToken};const evidence=[];
 for(const id of ids){
  const r=await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/posts/${id}`,{headers:googleHeaders});if(!r.ok)throw Error('Post read '+id+' '+r.status);const raw=await r.json();
  const post=Object.fromEntries(Object.entries(raw.fields||{}).map(([k,v])=>[k,decode(v)]));if(post.deletedAt||post.moderationStatus==='removed')throw Error('Removed post '+id);const owner=post.userId||post.authorId;
  const keys=new Set();
  function collect(v){if(typeof v==='string'){try{const u=new URL(v);const m=u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);if(u.hostname==='firebasestorage.googleapis.com'&&m&&m[1]===bucket){const key=decodeURIComponent(m[2]);if(key.startsWith('posts/'+owner+'/')&&key.split('/').every(s=>s&&s!=='.'&&s!=='..'&&/^[-\w.]+$/.test(s)))keys.add(key);}}catch{}}else if(v&&typeof v==='object')Object.values(v).forEach(collect);}
  collect(post.attachments);collect(post.imageURLs);collect(post.imageURL);collect(post.videoURL);
  for(const key of keys){
   const src=`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`;
   const mr=await fetch(src,{headers:googleHeaders});const meta=await mr.json();if(!mr.ok)throw Error('Source object '+mr.status+' '+key);
   const target=`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/connect-social-media/objects/${encodeURIComponent(key)}`;
   const existing=await fetch(target,{headers:cfHeaders});let existingBytes=null;if(existing.ok)existingBytes=Buffer.from(await existing.arrayBuffer());else if(existing.status!==404)throw Error('R2 read '+existing.status);
   const record={postId:id,key,sourceGeneration:meta.generation,sourceSize:Number(meta.size),mime:meta.contentType,sourceMD5:meta.md5Hash,existingStatus:existing.status,applied:apply};
   if(!apply){evidence.push(record);console.log(JSON.stringify(record));continue;}
   const download=await fetch(src+'?alt=media',{headers:googleHeaders});if(!download.ok)throw Error('Download '+download.status);const bytes=Buffer.from(await download.arrayBuffer());
   if(bytes.length!==Number(meta.size)||crypto.createHash('md5').update(bytes).digest('base64')!==meta.md5Hash)throw Error('Source integrity mismatch '+key);
   record.sha256=hash(bytes);
   if(existingBytes&&!existingBytes.equals(bytes))throw Error('Existing R2 object differs; refusing overwrite '+key);
   if(!existingBytes){const put=await fetch(target,{method:'PUT',headers:{...cfHeaders,'Content-Type':meta.contentType,'Cache-Control':'private, no-store'},body:bytes});if(!put.ok)throw Error('R2 put '+put.status+' '+await put.text());record.uploadStatus=put.status;}
   const check=await fetch(target,{headers:cfHeaders});if(!check.ok)throw Error('Verify read '+check.status);const targetBytes=Buffer.from(await check.arrayBuffer());if(hash(targetBytes)!==record.sha256)throw Error('R2 integrity mismatch');record.verifiedStatus=check.status;record.verifiedSHA256=hash(targetBytes);evidence.push(record);console.log(JSON.stringify(record));
  }
 }
 fs.mkdirSync('evidence',{recursive:true});fs.writeFileSync(`evidence/object-restoration-${apply?'applied':'plan'}.json`,JSON.stringify(evidence,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
