#!/usr/bin/env node
/**
 * Wang Tile Generator — Corner-Based Quadrant Compositing
 *
 * Generates 16 Wang tiles from a single square seamless input texture.
 *
 * Method:
 *   1. Divide the source into 4 quadrants (Color-0 set).
 *   2. Derive the Color-1 set by taking diagonally opposite quadrants
 *      (TL₁=BR₀, TR₁=BL₀, BL₁=TR₀, BR₁=TL₀).
 *   3. For each of the 2⁴=16 corner-colour permutations (TL,TR,BR,BL ∈ {0,1}),
 *      assemble a 2×2 grid of the appropriate quadrant variants.
 *
 * Edge-matching guarantee:
 *   Adjacent tiles share two vertex colours, so their touching edges use the
 *   same quadrant content.  Two tiles with the same (TL,TR) corner pair, for
 *   example, have identical top-edge pixels — guaranteeing seamless transitions
 *   between tiles of the same terrain.
 *
 * The quadrants meet at the centre cross.  At the generation resolution (192×192)
 * there is a 1-pixel seam at this boundary, but when the tile is displayed
 * in-game at 48×48 (4× GPU bilinear downscale) the seam is smoothed invisibly.
 * No pixel blending is applied — avoiding the color artifacts that arise when
 * blending unrelated texture regions.
 *
 * Usage:
 *   node tools/wang-tiles/generate.mjs <input> <outputDir> [tileSize]
 *
 * Example:
 *   node tools/wang-tiles/generate.mjs public/assets/tiles/tile_grass.png public/assets/tiles/ 192
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
  const tileSize   = parseInt(args[2], 10) || 192;
  const quadSize   = Math.floor(tileSize / 2);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wangDir = path.join(outputDir, `${baseName}_wang`);
  ensureDir(wangDir);

  const image = sharp(inputPath);
  const meta  = await image.metadata();
  const srcW = meta.width;
  const srcH = meta.height;

  if (!srcW || !srcH || srcW !== srcH) {
    console.error('Input must be a square image.');
    process.exit(1);
  }

  const halfW = Math.floor(srcW / 2);
  const halfH = Math.floor(srcH / 2);

  // ── Step 1: Extract 4 quadrants (Color-0 set) ─────────────────────────
  const extractQ = (left, top) =>
    image.clone()
      .extract({ left, top, width: halfW, height: halfH })
      .resize(quadSize, quadSize, { kernel: 'lanczos3' })
      .png()
      .toBuffer();

  const Q_TL_0 = await extractQ(0, 0);
  const Q_TR_0 = await extractQ(halfW, 0);
  const Q_BL_0 = await extractQ(0, halfH);
  const Q_BR_0 = await extractQ(halfW, halfH);

  // ── Step 2: Color-1 set = diagonally opposite quadrants ───────────────
  const qmap = {
    TL_0: Q_TL_0, TL_1: Q_BR_0,
    TR_0: Q_TR_0, TR_1: Q_BL_0,
    BL_0: Q_BL_0, BL_1: Q_TR_0,
    BR_0: Q_BR_0, BR_1: Q_TL_0,
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
              width: tileSize, height: tileSize,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
          })
            .composite([
              { input: qmap[`TL_${tl}`], top: 0,        left: 0 },
              { input: qmap[`TR_${tr}`], top: 0,        left: quadSize },
              { input: qmap[`BL_${bl}`], top: quadSize, left: 0 },
              { input: qmap[`BR_${br}`], top: quadSize, left: quadSize },
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
