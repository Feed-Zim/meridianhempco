#!/usr/bin/env node
/**
 * images.mjs — responsive image pipeline for meridianhempco.com
 *
 * For each source in SOURCES, emits AVIF (q~50) + WebP (q~75) + JPG (q~80)
 * at the widths in WIDTHS, stripping metadata. Filenames follow
 *   <slug>-<width>.<ext>
 * so the <picture>/srcset markup in the pages stays stable as more
 * photos are added in Phase 2 (just append entries to SOURCES).
 *
 * Photo *treatment* (saturation/contrast, meridian gradient overlay, grain,
 * dark-mode dimming) is done in CSS — this script only resizes + re-encodes.
 *
 * Requires the global `sharp` CLI (sharp-cli). Run: node scripts/images.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMG_DIR = resolve(__dirname, '../src/assets/img');

const WIDTHS = [480, 768, 1200, 1600, 2000];

// avifQuality/chroma are the defaults; a source may override per its content.
const AVIF_QUALITY = 50;
const WEBP_QUALITY = 75;
const JPG_QUALITY = 80;

// slug = output basename; src = source file in src/assets/img/
// Optional per-source overrides:
//   widths        — cap/limit the rendition widths (default WIDTHS)
//   avifQuality   — override AVIF quality (detail-heavy photos need lower to stay small)
//   chroma        — AVIF chroma subsampling ("4:2:0" halves colour data, smaller files)
const SOURCES = [
  // Hero: green-cropland texture is high-frequency; it displays at <=~700 CSS px
  // in the two-column hero, so cap at 1200 and encode lean to keep the largest
  // AVIF under 200KB while staying crisp behind the overlay + grain + text.
  { slug: 'hero-field', src: 'hero-field-src.jpg', widths: [480, 768, 1200], avifQuality: 42, chroma: '4:2:0' },
  // CTA band: smooth sky/field, full-bleed — full width ladder, default quality.
  { slug: 'cta-horizon', src: 'cta-horizon-src.jpg' },
];

// On Windows the global bin is sharp.cmd; execFileSync needs shell to resolve it.
const isWin = process.platform === 'win32';
function runSharp(args) {
  execFileSync('sharp', args, { stdio: ['ignore', 'ignore', 'inherit'], shell: isWin });
}

if (!existsSync(IMG_DIR)) mkdirSync(IMG_DIR, { recursive: true });

let count = 0;
for (const s of SOURCES) {
  const input = join(IMG_DIR, s.src);
  if (!existsSync(input)) {
    console.warn(`! skip ${s.slug}: source not found (${s.src})`);
    continue;
  }
  const widths = s.widths || WIDTHS;
  const formats = [
    { ext: 'avif', flag: 'avif', quality: s.avifQuality ?? AVIF_QUALITY, chroma: s.chroma },
    { ext: 'webp', flag: 'webp', quality: WEBP_QUALITY },
    { ext: 'jpg', flag: 'jpeg', quality: JPG_QUALITY },
  ];
  for (const w of widths) {
    for (const f of formats) {
      const out = join(IMG_DIR, `${s.slug}-${w}.${f.ext}`);
      const args = ['-i', input, '-o', out, '-f', f.flag, '-q', String(f.quality)];
      if (f.chroma) args.push('--chromaSubsampling', f.chroma);
      args.push('resize', String(w), '--withoutEnlargement');
      runSharp(args);
      count++;
    }
  }
  console.log(`✓ ${s.slug}: ${widths.length}×${formats.length} renditions`);
}
console.log(`Done. ${count} files written to src/assets/img/`);
