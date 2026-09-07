import fs from 'node:fs/promises';
import path from 'node:path';

function slug(value = '') {
  return String(value || 'migration')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'migration';
}

const name = slug(process.argv.slice(2).join(' '));
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const file = path.join('migrations', `${stamp}_${name}.js`);
const template = `export const description = '${name.replace(/'/g, '')}';\n\nexport async function up({ mongoose }) {\n  // Add migration work here. Keep it idempotent.\n}\n`;

await fs.mkdir('migrations', { recursive: true });
await fs.writeFile(file, template, { flag: 'wx' });
console.log(file);
