// Generate PWA icons from favicon.svg.
// Outputs:
//   public/icons/icon-192.png         — regular 192x192
//   public/icons/icon-512.png         — regular 512x512
//   public/icons/icon-maskable-512.png — 512x512 with safe-zone padding for maskable
//   public/apple-touch-icon.png        — 180x180 for iOS home screen
//
// Run with: node scripts/generate-icons.js
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const svgPath = path.join(root, 'public', 'favicon.svg');
const outDir = path.join(root, 'public', 'icons');

const BG = '#0e0e12'; // matches the app's dark background
const SVG = await readFile(svgPath);

async function plain(size, out) {
  // The favicon is 48x46-ish; we want it centered on a square canvas with the
  // brand background so platforms that don't crop the icon still look right.
  const padding = Math.round(size * 0.16);
  const inner = size - padding * 2;
  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: await sharp(SVG).resize(inner, inner, { fit: 'contain', background: BG }).png().toBuffer() }])
    .png()
    .toFile(out);
}

async function maskable(size, out) {
  // Maskable icons need a safe zone — keep the logo inside the inner 80%.
  const padding = Math.round(size * 0.22);
  const inner = size - padding * 2;
  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: await sharp(SVG).resize(inner, inner, { fit: 'contain', background: BG }).png().toBuffer() }])
    .png()
    .toFile(out);
}

await mkdir(outDir, { recursive: true });

await Promise.all([
  plain(192, path.join(outDir, 'icon-192.png')),
  plain(512, path.join(outDir, 'icon-512.png')),
  maskable(512, path.join(outDir, 'icon-maskable-512.png')),
  plain(180, path.join(root, 'public', 'apple-touch-icon.png')),
]);

console.log('✓ generated PWA icons');
