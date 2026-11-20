// Builds the macOS app icon (apps/desktop/build/icon.icns, picked up by electron-builder) from the committed
// drawings in this folder, the source of truth (#310, F1 Living Orb by paris):
//   dock-1024.svg        the full drawing (an 824 px tile centred in 1024, Apple grid): 128 px and up
//   dock-small-1024.svg  the same tile with the simple mark: 16 and 32 px (and their @2x), where detail is mush
//   mark.svg             the still mark: favicon (packages/ui/public/favicon.svg is a copy), login, sidebar
// Usage (macOS: needs iconutil): node apps/desktop/icon/build-icon.mjs. Commit the regenerated icon.icns.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const here = import.meta.dirname;
const out = resolve(here, '../build/icon.icns');
const full = readFileSync(join(here, 'dock-1024.svg'));
const small = readFileSync(join(here, 'dock-small-1024.svg'));

/** iconset entries: [file name, pixels, drawing]. The small drawing covers 16 and 32 pt, at 1× and 2×. */
const ENTRIES = [
  ['icon_16x16.png', 16, 'small'],
  ['icon_16x16@2x.png', 32, 'small'],
  ['icon_32x32.png', 32, 'small'],
  ['icon_32x32@2x.png', 64, 'small'],
  ['icon_128x128.png', 128, 'full'],
  ['icon_128x128@2x.png', 256, 'full'],
  ['icon_256x256.png', 256, 'full'],
  ['icon_256x256@2x.png', 512, 'full'],
  ['icon_512x512.png', 512, 'full'],
  ['icon_512x512@2x.png', 1024, 'full'],
];

const dir = mkdtempSync(join(tmpdir(), 'atlas-icon-'));
const set = join(dir, 'icon.iconset');
mkdirSync(set);
for (const [name, px, which] of ENTRIES) {
  // render at 1024 (the drawing's own size), then scale down: the blur filters keep their look at every size
  const big = await sharp(which === 'full' ? full : small, { density: 72 }).resize(1024, 1024).png().toBuffer();
  await sharp(big).resize(px, px, { kernel: 'lanczos3' }).png().toFile(join(set, name));
}
mkdirSync(resolve(here, '../build'), { recursive: true });
execFileSync('iconutil', ['-c', 'icns', set, '-o', out], { stdio: 'inherit' });
copyFileSync(join(set, 'icon_512x512@2x.png'), join(dir, 'preview.png'));
console.log(`wrote ${out} (preview: ${join(dir, 'preview.png')})`);
if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true });
