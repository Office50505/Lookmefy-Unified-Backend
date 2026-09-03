import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const output = path.join(root, 'public/assets/download-app-showcase.png');

const screens = [
  ['Explore', 'public/assets/download-screen-explore-device.png'],
  ['AI Try-On', 'public/assets/download-screen-tryon-device.png'],
  ['Wardrobe', 'public/assets/download-screen-wardrobe-device.png'],
  ['AI Stylist', 'public/assets/download-screen-stylist-device.png'],
  ['Profile', 'public/assets/download-screen-profile-device.png']
];

const canvas = { width: 2560, height: 1120 };
const phone = { width: 360, height: 796, radius: 64 };
const gap = 70;
const rowWidth = screens.length * phone.width + (screens.length - 1) * gap;
const startX = Math.round((canvas.width - rowWidth) / 2);
const phoneY = 92;
const labelY = phoneY + phone.height + 84;

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function svgBase() {
  const shadows = screens.map((_, index) => {
    const x = startX + index * (phone.width + gap);
    const cx = x + phone.width / 2;
    return `<ellipse cx="${cx}" cy="${phoneY + phone.height - 10}" rx="128" ry="22" fill="rgba(28,21,17,.13)"/>`;
  }).join('');

  const labels = screens.map(([label], index) => {
    const x = startX + index * (phone.width + gap) + phone.width / 2;
    return `<text x="${x}" y="${labelY}" text-anchor="middle" font-family="Manrope, Avenir, Helvetica Neue, Arial, sans-serif" font-size="34" font-weight="800" fill="#15110f">${xmlEscape(label)}</text>`;
  }).join('');

  return `
    <svg width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="softWash" cx="50%" cy="44%" r="74%">
          <stop offset="0%" stop-color="#fffdfb"/>
          <stop offset="68%" stop-color="#fbf7f4"/>
          <stop offset="100%" stop-color="#f7efeb"/>
        </radialGradient>
        <filter id="softShadow" x="-35%" y="-35%" width="170%" height="170%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="18"/>
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#softWash)"/>
      <g filter="url(#softShadow)">${shadows}</g>
      ${labels}
    </svg>`;
}

function phoneMask() {
  return Buffer.from(`
    <svg width="${phone.width}" height="${phone.height}" viewBox="0 0 ${phone.width} ${phone.height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${phone.width}" height="${phone.height}" rx="${phone.radius}" ry="${phone.radius}" fill="#fff"/>
    </svg>`);
}

function hardwareOverlay() {
  const groups = screens.map((_, index) => {
    const x = startX + index * (phone.width + gap);
    const y = phoneY;
    const islandW = 108;
    const islandH = 34;
    const islandX = x + (phone.width - islandW) / 2;
    return `
      <g>
        <rect x="${x + 2}" y="${y + 2}" width="${phone.width - 4}" height="${phone.height - 4}" rx="${phone.radius - 2}" ry="${phone.radius - 2}" fill="none" stroke="#111" stroke-width="12"/>
        <rect x="${x + 9}" y="${y + 9}" width="${phone.width - 18}" height="${phone.height - 18}" rx="${phone.radius - 10}" ry="${phone.radius - 10}" fill="none" stroke="rgba(255,255,255,.38)" stroke-width="2"/>
        <rect x="${islandX}" y="${y + 26}" width="${islandW}" height="${islandH}" rx="18" ry="18" fill="#050505"/>
        <circle cx="${islandX + islandW - 21}" cy="${y + 43}" r="9" fill="#060606"/>
        <circle cx="${islandX + islandW - 19}" cy="${y + 41}" r="3.2" fill="#172d62" opacity=".88"/>
      </g>`;
  }).join('');

  return Buffer.from(`
    <svg width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" xmlns="http://www.w3.org/2000/svg">
      ${groups}
    </svg>`);
}

async function normalizedPhone(inputPath) {
  const input = path.join(root, inputPath);
  const mask = phoneMask();
  const resized = await sharp(input)
    .resize(phone.width, phone.height, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();

  return sharp(resized)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function main() {
  const composites = [];
  for (const [index, [, source]] of screens.entries()) {
    const input = await normalizedPhone(source);
    composites.push({
      input,
      left: startX + index * (phone.width + gap),
      top: phoneY
    });
  }

  composites.push({ input: hardwareOverlay(), left: 0, top: 0 });

  await sharp(Buffer.from(svgBase()))
    .composite(composites)
    .png({ quality: 96, compressionLevel: 8 })
    .toFile(output);

  const metadata = await sharp(output).metadata();
  await fs.stat(output);
  console.log(`${path.relative(root, output)} ${metadata.width}x${metadata.height}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
