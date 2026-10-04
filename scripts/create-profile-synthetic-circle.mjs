import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const output = resolve(process.argv[2] || 'tmp/connect-profile-synthetic-green-circle.png');
try {
  await access(output);
  throw new Error(`Refusing to overwrite existing image: ${output}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const svg = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <rect width="1024" height="1024" fill="#ffffff" />
    <circle cx="512" cy="512" r="300" fill="#22c55e" />
  </svg>
`);

await sharp(svg).png().toFile(output);
process.stdout.write(`${output}\n`);
