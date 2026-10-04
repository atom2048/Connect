import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(here, '..', 'wrangler.standalone.jsonc');

// JSONC parser limited to comments; it deliberately preserves // inside
// quoted URLs and other string values.
function stripJsonComments(source) {
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === '\n') {
        lineComment = false;
        output += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
    } else if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else {
      output += current;
    }
  }
  return output;
}

const config = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')));
const vars = config.vars ?? {};
const expected = {
  AI_GENERATION_ENABLED: 'true',
  AI_TEXT_READY: 'true',
  AI_VISION_READY: 'true',
  AI_ADMIN_ONLY: 'false',
  AI_ROLLOUT_PERCENT: '100',
  AI_ENVIRONMENT: 'production',
};
const invalid = Object.entries(expected)
  .filter(([name, value]) => String(vars[name] ?? '') !== value)
  .map(([name, value]) => `${name}=${value}`);

if (config.name !== 'connect-social-standalone' || invalid.length > 0) {
  const details = [];
  if (config.name !== 'connect-social-standalone') details.push('name=connect-social-standalone');
  details.push(...invalid);
  console.error(`production AI config invalid: ${details.join(', ')}`);
  process.exit(1);
}

console.log('production AI config: PASS');
