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
 * The quadrants meet at the centre cross.  A configurable alpha-feathered blend
 * zone (default 16 px each side, 32 px total) cross-fades adjacent quadrants at
 * the centre seams.  Output pixels are computed as the alpha-weighted average of
 * all covering quadrants, producing fully-opaque tiles with no compositing-order
 * bias or transparency artifacts.
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

  // ── Blend width for center-cross feathering ──────────────────────────
  const BLEND = 16; // half-width of the blend zone (total = 32 px cross-fade)

  // Extra source pixels needed to extend quadrants past the centre
  const extraSrc = Math.ceil(BLEND * (srcW / tileSize));
  const largeSize = quadSize + BLEND;

  // ── Helper: extract a raw RGBA quadrant at the larger size ────────────
  const extractRaw = (left, top, w, h) =>
    image.clone()
      .extract({ left, top, width: Math.min(w, srcW - left), height: Math.min(h, srcH - top) })
      .resize(largeSize, largeSize, { kernel: 'lanczos3' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

  // ── Helper: apply alpha feather mask to a raw RGBA buffer ─────────────
  // Fades over 2×BLEND pixels so adjacent quadrants cross-fade in the same
  // region.  Returns a cloned { data, info } with modified alpha channel.
  function applyFeather(rawResult, opts) {
    const { data, info } = rawResult;
    const { width, height } = info;
    const fadeLen = BLEND * 2; // total fade distance on each edge
    const buf = Buffer.alloc(data.length);
    data.copy(buf);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let a = 1.0;
        if (opts.fadeRight)  { const d = width  - 1 - x; if (d < fadeLen) a *= Math.max(0, d / fadeLen); }
        if (opts.fadeLeft)   { if (x < fadeLen)            a *= Math.max(0, x / fadeLen); }
        if (opts.fadeBottom) { const d = height - 1 - y; if (d < fadeLen) a *= Math.max(0, d / fadeLen); }
        if (opts.fadeTop)    { if (y < fadeLen)            a *= Math.max(0, y / fadeLen); }
        buf[(y * width + x) * 4 + 3] = Math.round(Math.max(0, a) * 255);
      }
    }
    return { data: buf, info };
  }

  // ── Step 1: Extract 4 large quadrants (extending past centre) ─────────
  const Q_LARGE_TL = await extractRaw(0, 0, halfW + extraSrc, halfH + extraSrc);
  const Q_LARGE_TR = await extractRaw(halfW - extraSrc, 0, halfW + extraSrc, halfH + extraSrc);
  const Q_LARGE_BL = await extractRaw(0, halfH - extraSrc, halfW + extraSrc, halfH + extraSrc);
  const Q_LARGE_BR = await extractRaw(halfW - extraSrc, halfH - extraSrc, halfW + extraSrc, halfH + extraSrc);

  // ── Step 2: Pre-compute 8 feathered variants ──────────────────────────
  // Each base quadrant appears in two Wang-colour positions with different
  // feather directions.
  const feathered = {
    TL_0: applyFeather(Q_LARGE_TL, { fadeRight: true, fadeBottom: true }),
    TL_1: applyFeather(Q_LARGE_BR, { fadeRight: true, fadeBottom: true }),
    TR_0: applyFeather(Q_LARGE_TR, { fadeLeft: true,  fadeBottom: true }),
    TR_1: applyFeather(Q_LARGE_BL, { fadeLeft: true,  fadeBottom: true }),
    BL_0: applyFeather(Q_LARGE_BL, { fadeRight: true, fadeTop: true }),
    BL_1: applyFeather(Q_LARGE_TR, { fadeRight: true, fadeTop: true }),
    BR_0: applyFeather(Q_LARGE_BR, { fadeLeft: true,  fadeTop: true }),
    BR_1: applyFeather(Q_LARGE_TL, { fadeLeft: true,  fadeTop: true }),
  };

  console.log(`Generating 16 Wang tiles (${tileSize}×${tileSize}, ${BLEND}px centre-cross blend) from ${srcW}×${srcH} source → ${wangDir}/`);

  // ── Step 3: Generate all 16 corner-colour permutations ────────────────
  // Pixel-level weighted averaging — each output pixel is the
  // alpha-weighted mean of all quadrants that cover it.  This avoids the
  // transparency / compositing-order bias that pure alpha-over would
  // introduce.
  const overlap = quadSize - BLEND; // left/top of right/bottom quadrants

  let count = 0;
  for (let tl = 0; tl <= 1; tl++) {
    for (let tr = 0; tr <= 1; tr++) {
      for (let br = 0; br <= 1; br++) {
        for (let bl = 0; bl <= 1; bl++) {
          const tileIndex = tl * 8 + tr * 4 + br * 2 + bl;
          const fileName = `wang_${tileIndex}.png`;
          const outputPath = path.join(wangDir, fileName);

          const quads = [
            { buf: feathered[`TL_${tl}`], ox: 0,      oy: 0 },
            { buf: feathered[`TR_${tr}`], ox: overlap, oy: 0 },
            { buf: feathered[`BL_${bl}`], ox: 0,      oy: overlap },
            { buf: feathered[`BR_${br}`], ox: overlap, oy: overlap },
          ];

          const outRaw = Buffer.alloc(tileSize * tileSize * 4);

          for (let y = 0; y < tileSize; y++) {
            for (let x = 0; x < tileSize; x++) {
              let r = 0, g = 0, b = 0, wTotal = 0;

              for (const { buf, ox, oy } of quads) {
                const lx = x - ox;
                const ly = y - oy;
                if (lx < 0 || ly < 0 || lx >= largeSize || ly >= largeSize) continue;

                const qi = (ly * largeSize + lx) * 4;
                const w = buf.data[qi + 3] / 255; // alpha as weight
                if (w > 0) {
                  r += buf.data[qi]     * w;
                  g += buf.data[qi + 1] * w;
                  b += buf.data[qi + 2] * w;
                  wTotal += w;
                }
              }

              const oi = (y * tileSize + x) * 4;
              if (wTotal > 0) {
                outRaw[oi]     = Math.round(r / wTotal);
                outRaw[oi + 1] = Math.round(g / wTotal);
                outRaw[oi + 2] = Math.round(b / wTotal);
                outRaw[oi + 3] = 255;
              }
              // else stays transparent black (shouldn't happen — every pixel
              // is covered by at least one quadrant)
            }
          }

          await sharp(outRaw, {
            raw: { width: tileSize, height: tileSize, channels: 4 },
          })
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
