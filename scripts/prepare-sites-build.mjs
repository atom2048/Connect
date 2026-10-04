import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(projectRoot, 'dist');
const client = path.join(dist, 'client');
const worker = path.join(dist, 'connect_social');
const server = path.join(dist, 'server');

for (const entry of await readdir(dist)) {
  if (!['client', 'connect_social', '.openai'].includes(entry)) await rm(path.join(dist, entry), { recursive: true, force: true });
}
await mkdir(server, { recursive: true });
await cp(client, dist, { recursive: true, force: true });
await cp(path.join(worker, 'index.js'), path.join(server, 'index.js'), { force: true });
await cp(path.join(worker, 'assets'), path.join(server, 'assets'), { recursive: true, force: true });
const sitesWranglerPath = path.join(worker, 'wrangler.json');
const sitesWrangler = JSON.parse(await readFile(sitesWranglerPath, 'utf8'));
// Sites deploys dist/ as the Worker project root. Keep the generated config
// aligned with the promoted Worker entrypoint and static files.
sitesWrangler.main = 'server/index.js';
if (sitesWrangler.assets) sitesWrangler.assets.directory = 'client';
await writeFile(path.join(dist, 'wrangler.json'), JSON.stringify(sitesWrangler, null, 2));
await rm(worker, { recursive: true, force: true });

console.log('Prepared Sites build: dist/server/index.js + client assets');
