import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../tmp/ask-ai-synthetic-vision.png', import.meta.url));
const label = Buffer.from(`
  <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="640" height="360" rx="28" fill="#17324d"/>
    <circle cx="120" cy="180" r="70" fill="#55d6be"/>
    <text x="225" y="165" fill="#ffffff" font-family="Arial, sans-serif" font-size="42" font-weight="700">CONNECT</text>
    <text x="225" y="220" fill="#b9dff5" font-family="Arial, sans-serif" font-size="28">SYNTHETIC VISION TEST</text>
  </svg>`);

await sharp({ create: { width: 640, height: 360, channels: 4, background: '#17324d' } })
  .composite([{ input: label }])
  .png()
  .toFile(output);
