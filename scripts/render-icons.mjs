#!/usr/bin/env node
/**
 * Renders the toolbar icons from their SVG masters (assets/icon/*.svg) into public/icon/.
 * The 16 and 32 px sizes have their own hand-fitted masters (whole-pixel bars for the 1x
 * and 2x toolbar); 48, 96 and 128 come from the 128 master.
 *
 *   node scripts/render-icons.mjs                 # write public/icon/*.png
 *   node scripts/render-icons.mjs --sheet out.png # also write a check sheet (needs ImageMagick):
 *                                                 # 16/32 idle, recording, "!" and needs-you
 *                                                 # badges on light and dark toolbars
 *
 * Needs rsvg-convert (librsvg).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const masters = join(root, 'assets/icon');
const out = join(root, 'public/icon');

/** [output file, master, size] */
const TARGETS = [
  ['16.png', 'icon-16.svg', 16],
  ['32.png', 'icon-32.svg', 32],
  ['48.png', 'icon-128.svg', 48],
  ['96.png', 'icon-128.svg', 96],
  ['128.png', 'icon-128.svg', 128],
  ['rec-16.png', 'rec-16.svg', 16],
  ['rec-32.png', 'rec-32.svg', 32],
];

function render(master, size, file) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), join(masters, master), '-o', file]);
}

mkdirSync(out, { recursive: true });
for (const [file, master, size] of TARGETS) {
  render(master, size, join(out, file));
  console.log(`public/icon/${file}  ← ${master} @ ${size}px`);
}

const sheetArg = process.argv.indexOf('--sheet');
if (sheetArg > 0) {
  const sheet = resolve(process.argv[sheetArg + 1] ?? 'icon-check.png');
  writeSheet(sheet);
  console.log(`check sheet → ${sheet}`);
}

/**
 * Chrome's toolbars: light #FFFFFF / #F1F3F4 and dark #35363A / #202124. Each strip shows
 * a neighbouring extension, idle, recording, recording + "!" badge (#F9AB00 / #1F1F1F)
 * and idle + a needs-you count, at 1x (16) and 2x (32). The strip is then magnified 3×
 * with nearest-neighbour so single pixels can be judged.
 */
function writeSheet(file) {
  const work = mkdtempSync(join(tmpdir(), 'manet-icons-'));
  try {
    const png = (name, master, size) => {
      const path = join(work, `${name}.png`);
      render(master, size, path);
      return path;
    };
    const i16 = png('i16', 'icon-16.svg', 16);
    const r16 = png('r16', 'rec-16.svg', 16);
    const i32 = png('i32', 'icon-32.svg', 32);
    const r32 = png('r32', 'rec-32.svg', 32);
    const i48 = png('i48', 'icon-128.svg', 48);
    const i128 = png('i128', 'icon-128.svg', 128);
    const r128 = png('r128', 'rec-128.svg', 128);

    // A Chrome-like badge: rounded amber rect over the icon's bottom-right corner.
    const badge = (scale, x, y, text) => {
      const w = (text.length > 1 ? 13 : 10) * scale;
      const hgt = 10 * scale;
      return [
        '-fill', '#F9AB00', '-draw', `roundrectangle ${x},${y} ${x + w},${y + hgt} ${3 * scale},${3 * scale}`,
        '-fill', '#1F1F1F', '-font', 'DejaVu-Sans-Bold', '-pointsize', String(8 * scale),
        '-annotate', `+${x + (text.length > 1 ? 2.5 : 3) * scale}+${y + 8 * scale}`, text,
      ];
    };

    const strips = [];
    for (const bg of ['#FFFFFF', '#F1F3F4', '#35363A', '#202124']) {
      const fg = bg === '#FFFFFF' || bg === '#F1F3F4' ? '#5F6368' : '#C4C7C5';
      const strip = join(work, `strip-${bg.slice(1)}.png`);
      execFileSync('magick', [
        '-size', '300x48', `xc:${bg}`,
        // a neighbouring extension (generic grey glyph) at 1x and 2x
        '-fill', fg, '-draw', 'circle 16,24 16,17',
        '-draw', 'roundrectangle 162,10 186,34 5,5',
        i16, '-geometry', '+36+16', '-composite',
        r16, '-geometry', '+60+16', '-composite',
        r16, '-geometry', '+84+16', '-composite',
        ...badge(1, 92, 26, '!'),
        i16, '-geometry', '+118+16', '-composite',
        ...badge(1, 126, 26, '1'),
        i32, '-geometry', '+196+8', '-composite',
        r32, '-geometry', '+236+8', '-composite',
        ...badge(2, 250, 26, '!'),
        strip,
      ]);
      strips.push(strip);
    }
    const toolbars = join(work, 'toolbars.png');
    execFileSync('magick', [...strips, '-append', '-filter', 'point', '-resize', '300%', toolbars]);
    const large = join(work, 'large.png');
    execFileSync('magick', [
      '-size', '900x160', 'xc:#FFFFFF',
      i48, '-geometry', '+24+56', '-composite',
      i128, '-geometry', '+96+16', '-composite',
      r128, '-geometry', '+248+16', '-composite',
      '(', '-size', '460x160', 'xc:#202124', i48, '-geometry', '+24+56', '-composite',
      i128, '-geometry', '+96+16', '-composite', r128, '-geometry', '+248+16', '-composite', ')',
      '-geometry', '+440+0', '-composite',
      large,
    ]);
    execFileSync('magick', [toolbars, large, '-append', '+repage', file]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
