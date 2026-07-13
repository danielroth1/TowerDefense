#!/usr/bin/env node
/**
 * Wang Tile Generator — Corner-Based / Sub-Tile Quadrant Method
 *
 * Generates 16 seamless Wang tiles from a single square seamless input texture.
 *
 * Method:
 *   1. Divide the source into 4 quadrants (Color-0 set).
 *   2. Derive the Color-1 set by taking diagonally opposite quadrants
 *      (TL1=BR0, TR1=BL0, BL1=TR0, BR1=TL0).  Because the source is
 *      seamless, this produces a valid alternative "color" for every corner.
 *   3. For each of the 2⁴=16 corner-colour permutations (TL,TR,BR,BL ∈ {0,1}),
 *      assemble a 2×2 grid of the appropriate quadrant variants and resize to
 *      the target tile size.
 *
 * Usage:
 *   node tools/wang-tiles/generate.mjs <input> <outputDir> [tileSize]
 *
 * Example:
 *   node tools/wang-tiles/generate.mjs public/assets/tiles/tile_grass.png public/assets/tiles/ 48
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate.mjs <inputPath> <outputDir> [tileSize]');
    process.exit(1);
  }

  const inputPath  = args[0];
  const outputDir  = args[1];
  const tileSize   = parseInt(args[2], 10) || 48;
  const quadSize   = Math.floor(tileSize / 2);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));

  // Output into a subfolder named {baseName}_wang/
  const wangDir = path.join(outputDir, `${baseName}_wang`);
  ensureDir(wangDir);

  const image    = sharp(inputPath);
  const meta     = await image.metadata();

  const srcW = meta.width;
  const srcH = meta.height;

  if (!srcW || !srcH || srcW !== srcH) {
    console.error('Input must be a square image.');
    process.exit(1);
  }

  const halfW = Math.floor(srcW / 2);
  const halfH = Math.floor(srcH / 2);

  // ── Step 1: Extract 4 quadrants (Color-0 set) ─────────────────────────
  const extractQuadrant = (left, top) =>
    image
      .clone()
      .extract({ left, top, width: halfW, height: halfH })
      .resize(quadSize, quadSize, { kernel: 'lanczos3' })
      .png()
      .toBuffer();

  const Q_TL_0 = await extractQuadrant(0, 0);
  const Q_TR_0 = await extractQuadrant(halfW, 0);
  const Q_BL_0 = await extractQuadrant(0, halfH);
  const Q_BR_0 = await extractQuadrant(halfW, halfH);

  // ── Step 2: Color-1 set = diagonally opposite quadrants ───────────────
  const Q_TL_1 = Q_BR_0;
  const Q_TR_1 = Q_BL_0;
  const Q_BL_1 = Q_TR_0;
  const Q_BR_1 = Q_TL_0;

  const quadrantMap = {
    TL_0: Q_TL_0, TL_1: Q_TL_1,
    TR_0: Q_TR_0, TR_1: Q_TR_1,
    BL_0: Q_BL_0, BL_1: Q_BL_1,
    BR_0: Q_BR_0, BR_1: Q_BR_1,
  };

  console.log(`Generating 16 Wang tiles (${tileSize}×${tileSize}) from ${srcW}×${srcH} source → ${wangDir}/`);

  // ── Step 3: Generate all 16 corner-colour permutations ────────────────
  let count = 0;
  for (let tl = 0; tl <= 1; tl++) {
    for (let tr = 0; tr <= 1; tr++) {
      for (let br = 0; br <= 1; br++) {
        for (let bl = 0; bl <= 1; bl++) {
          const tileIndex = tl * 8 + tr * 4 + br * 2 + bl;

          const fileName = `wang_${tileIndex}.png`;

          const outputPath = path.join(wangDir, fileName);

          await sharp({
            create: {
              width: tileSize,
              height: tileSize,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
          })
            .composite([
              { input: quadrantMap[`TL_${tl}`], top: 0,        left: 0 },
              { input: quadrantMap[`TR_${tr}`], top: 0,        left: quadSize },
              { input: quadrantMap[`BL_${bl}`], top: quadSize, left: 0 },
              { input: quadrantMap[`BR_${br}`], top: quadSize, left: quadSize },
            ])
            .png()
            .toFile(outputPath);

          count++;
        }
      }
    }
  }

  console.log(`✓ Done — ${count} tiles written to ${wangDir}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
