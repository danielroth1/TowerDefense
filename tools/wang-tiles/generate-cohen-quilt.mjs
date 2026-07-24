#!/usr/bin/env node
/**
 * generate-cohen7.mjs — Corner Wang Tiles via Diamond-Cut Image Quilting
 *
 * Implements Cohen et al.'s algorithm for generating a 16-tile Corner Wang
 * Tile set from a single seamless source texture.
 *
 * Algorithm:
 *   1. CORNER CONFIGURATION — 16 binary corner permutations (2⁴ = 16).
 *   2. DIAMOND SAMPLING   — Overlapping sub-patches sampled from source
 *      quadrants, assigned by corner colour (0=identity, 1=diagonal swap).
 *   3. GRAPH-CUT QUILTING — DP minimum-error boundary seams (Efros &
 *      Freeman 2001) cut through 2-patch overlap bands.  The 4-patch centre
 *      zone uses a diagonal (X-shaped) partition so transition edges follow
 *      natural 45° diamond boundaries.
 *   4. TILE ASSEMBLY      — Composite the quilted patches into 16 square
 *      output tiles written as wang_0.png … wang_15.png.
 *
 * Source-colour mapping:
 *   Colour 0 → quadrant as-is.
 *   Colour 1 → diagonally opposite quadrant.
 *   Guarantees visual distinctness while preserving seamlessness.
 *
 * Usage:
 *   node tools/wang-tiles/generate-cohen7.mjs <input> <outputDir> [tileSize]
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Squared RGB distance between two pixels in raw RGBA buffers. */
function sqDist(bufA, iA, bufB, iB) {
  const dr = bufA[iA] - bufB[iB];
  const dg = bufA[iA + 1] - bufB[iB + 1];
  const db = bufA[iA + 2] - bufB[iB + 2];
  return dr * dr + dg * dg + db * db;
}

/**
 * DP minimum-error seam — vertical (top→bottom).
 *
 * Returns `path[h] = x` where each step moves -1, 0, or +1 in x.
 * Pixels with x ≤ path[y] belong to bufA; x > path[y] to bufB.
 */
function graphCutV(bufA, bufB, w, h) {
  // --- error surface ---
  const err = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      err[y * w + x] = sqDist(bufA, (y * w + x) * 4, bufB, (y * w + x) * 4);

  // --- DP forward ---
  const cost = new Float32Array(w * h);
  const prev = new Int32Array(w * h);
  for (let x = 0; x < w; x++) cost[x] = err[x];

  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let best = Infinity, bestP = x;
      for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx;
        if (px < 0 || px >= w) continue;
        const c = cost[(y - 1) * w + px] + err[idx];
        if (c < best) { best = c; bestP = px; }
      }
      cost[idx] = best;
      prev[idx] = bestP;
    }
  }

  // --- minimum on last row ---
  let minX = 0;
  for (let x = 1; x < w; x++)
    if (cost[(h - 1) * w + x] < cost[(h - 1) * w + minX]) minX = x;

  // --- backtrack ---
  const path = new Int32Array(h);
  let cx = minX;
  for (let y = h - 1; y >= 0; y--) { path[y] = cx; cx = prev[y * w + cx]; }
  return path;
}

/**
 * DP minimum-error seam — horizontal (left→right).
 *
 * Returns `path[w] = y` where each step moves -1, 0, or +1 in y.
 * Pixels with y ≤ path[x] belong to bufA; y > path[x] to bufB.
 */
function graphCutH(bufA, bufB, w, h) {
  const err = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      err[y * w + x] = sqDist(bufA, (y * w + x) * 4, bufB, (y * w + x) * 4);

  const cost = new Float32Array(w * h);
  const prev = new Int32Array(w * h);
  for (let y = 0; y < h; y++) cost[y * w] = err[y * w];

  for (let x = 1; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const idx = y * w + x;
      let best = Infinity, bestP = y;
      for (let dy = -1; dy <= 1; dy++) {
        const py = y + dy;
        if (py < 0 || py >= h) continue;
        const c = cost[py * w + (x - 1)] + err[idx];
        if (c < best) { best = c; bestP = py; }
      }
      cost[idx] = best;
      prev[idx] = bestP;
    }
  }

  let minY = 0;
  for (let y = 1; y < h; y++)
    if (cost[y * w + (w - 1)] < cost[minY * w + (w - 1)]) minY = y;

  const path = new Int32Array(w);
  let cy = minY;
  for (let x = w - 1; x >= 0; x--) { path[x] = cy; cy = prev[cy * w + x]; }
  return path;
}

/**
 * Build a soft mask from a seam path.  2 px linear feather avoids hard edges.
 *
 * direction = 'v': seam[y] = x  →  0=left (bufA), 1=right (bufB)
 * direction = 'h': seam[x] = y  →  0=top  (bufA), 1=bottom (bufB)
 */
function seamMask(seam, w, h, dir) {
  const m = new Float32Array(w * h);
  const F = 2;
  if (dir === 'v') {
    for (let y = 0; y < h; y++) {
      const cx = seam[y];
      for (let x = 0; x < w; x++) {
        const d = x - cx;
        m[y * w + x] = d <= -F ? 0 : d >= F ? 1 : (d + F) / (2 * F);
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      const cy = seam[x];
      for (let y = 0; y < h; y++) {
        const d = y - cy;
        m[y * w + x] = d <= -F ? 0 : d >= F ? 1 : (d + F) / (2 * F);
      }
    }
  }
  return m;
}

/** Extract a rectangular sub-region from a raw RGBA patch buffer. */
function sub(bufInfo, px, py, pw, ph) {
  const { data, width: iw } = bufInfo;
  const out = Buffer.alloc(pw * ph * 4);
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      const si = ((py + y) * iw + (px + x)) * 4;
      const di = (y * pw + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate-cohen7.mjs <inputPath> <outputDir> [tileSize]');
    process.exit(1);
  }

  const inputPath = args[0];
  const outputDir = args[1];
  const T = parseInt(args[2], 10) || 192;   // tileSize

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wangDir = path.join(outputDir, `${baseName}_wang`);
  ensureDir(wangDir);

  // --- Source metadata ---
  const image = sharp(inputPath);
  const meta = await image.metadata();
  if (!meta.width || !meta.height) {
    console.error('Could not determine source image dimensions.');
    process.exit(1);
  }
  if (meta.width !== meta.height) {
    console.error('Input must be a square image.');
    process.exit(1);
  }
  const srcW = meta.width;

  console.log(`Source: ${srcW}×${srcW}  →  ${T}×${T} tiles  →  ${wangDir}/`);

  // --- Geometry ---
  const H = Math.floor(T / 2);           // halfTile
  const O = Math.floor(T / 4);           // OVERLAP
  const P = H + O;                       // patchSize
  const Hsrc = Math.floor(srcW / 2);     // half source

  // Bands where exactly 2 patches overlap (excludes the 4-patch centre):
  //
  //   ┌──────────┬────────────┬──────────┐
  //   │  TL only │  top band  │  TR only │  y < H-O
  //   │          │  (TL∩TR)   │          │
  //   ├──────────┼────────────┼──────────┤
  //   │ L band   │  CENTRE    │ R band   │  y ∈ [H-O, H+O)
  //   │ (TL∩BL)  │ (all 4)    │ (TR∩BR)  │
  //   ├──────────┼────────────┼──────────┤
  //   │  BL only │  bot band  │  BR only │  y ≥ H+O
  //   │          │  (BL∩BR)   │          │
  //   └──────────┴────────────┴──────────┘
  //     x<H-O      x∈[H-O,H+O)   x≥H+O

  const bandW_H = 2 * O;          // width  of top/bottom bands
  const bandH_V = H - O;          // height of top/bottom bands
  const bandW_V = H - O;          // width  of left/right bands
  const bandH_H = 2 * O;          // height of left/right bands

  // --- Step 1: Extract 8 colour-variant patches ---
  const extract = (l, t) =>
    image.clone().extract({ left: l, top: t, width: Hsrc, height: Hsrc })
      .resize(P, P, { kernel: 'lanczos3' }).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });

  console.log('  Extracting 8 colour variants from source quadrants…');
  const raw = {
    TL_0: await extract(0, 0),               TR_0: await extract(Hsrc, 0),
    BL_0: await extract(0, Hsrc),            BR_0: await extract(Hsrc, Hsrc),
    TL_1: await extract(Hsrc, Hsrc),          // BR ↦ TL₁
    TR_1: await extract(0, Hsrc),            // BL ↦ TR₁
    BL_1: await extract(Hsrc, 0),            // TR ↦ BL₁
    BR_1: await extract(0, 0),              // TL ↦ BR₁
  };

  // --- Step 2: Generate 16 tiles ---
  let count = 0;

  for (let tl = 0; tl <= 1; tl++) {
  for (let tr = 0; tr <= 1; tr++) {
  for (let br = 0; br <= 1; br++) {
  for (let bl = 0; bl <= 1; bl++) {
    const idx = tl * 8 + tr * 4 + br * 2 + bl;

    const pTL = raw[`TL_${tl}`];
    const pTR = raw[`TR_${tr}`];
    const pBR = raw[`BR_${br}`];
    const pBL = raw[`BL_${bl}`];

    // ── 2a. Top band (TL vs TR) ──────────────────────────────────────
    // Tile coords: x∈[H-O, H+O), y∈[0, H-O)
    const topTL = sub(pTL, H - O, 0, bandW_H, bandH_V);
    const topTR = sub(pTR, 0, 0, bandW_H, bandH_V);
    const topSeam = graphCutV(topTL, topTR, bandW_H, bandH_V);
    const topMask = seamMask(topSeam, bandW_H, bandH_V, 'v');

    // ── 2b. Bottom band (BL vs BR) ───────────────────────────────────
    // Tile coords: x∈[H-O, H+O), y∈[H+O, T)
    const botBL = sub(pBL, H - O, 2 * O, bandW_H, bandH_V);
    const botBR = sub(pBR, 0, 2 * O, bandW_H, bandH_V);
    const botSeam = graphCutV(botBL, botBR, bandW_H, bandH_V);
    const botMask = seamMask(botSeam, bandW_H, bandH_V, 'v');

    // ── 2c. Left band (TL vs BL) ─────────────────────────────────────
    // Tile coords: x∈[0, H-O), y∈[H-O, H+O)
    const leftTL = sub(pTL, 0, H - O, bandW_V, bandH_H);
    const leftBL = sub(pBL, 0, 0, bandW_V, bandH_H);
    const leftSeam = graphCutH(leftTL, leftBL, bandW_V, bandH_H);
    const leftMask = seamMask(leftSeam, bandW_V, bandH_H, 'h');

    // ── 2d. Right band (TR vs BR) ────────────────────────────────────
    // Tile coords: x∈[H+O, T), y∈[H-O, H+O)
    const rightTR = sub(pTR, 2 * O, H - O, bandW_V, bandH_H);
    const rightBR = sub(pBR, 2 * O, 0, bandW_V, bandH_H);
    const rightSeam = graphCutH(rightTR, rightBR, bandW_V, bandH_H);
    const rightMask = seamMask(rightSeam, bandW_V, bandH_H, 'h');

    // ── 2e. Composite ────────────────────────────────────────────────
    const out = Buffer.alloc(T * T * 4);

    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        // Local coords into each patch
        const lxTL = x,              lyTL = y;
        const lxTR = x - (H - O),    lyTR = y;
        const lxBL = x,              lyBL = y - (H - O);
        const lxBR = x - (H - O),    lyBR = y - (H - O);

        const iTL = (lyTL * P + lxTL) * 4;
        const iTR = (lyTR * P + lxTR) * 4;
        const iBL = (lyBL * P + lxBL) * 4;
        const iBR = (lyBR * P + lxBR) * 4;

        let r, g, b;

        // ── Region dispatch ──────────────────────────────────────────

        // Top band
        if (y < H - O && x >= H - O && x < H + O) {
          const bx = x - (H - O), by = y;
          const w = topMask[by * bandW_H + bx];
          if (w < 0.5) { r = pTL.data[iTL]; g = pTL.data[iTL + 1]; b = pTL.data[iTL + 2]; }
          else         { r = pTR.data[iTR]; g = pTR.data[iTR + 1]; b = pTR.data[iTR + 2]; }
        }
        // Bottom band
        else if (y >= H + O && x >= H - O && x < H + O) {
          const bx = x - (H - O), by = y - (H + O);
          const w = botMask[by * bandW_H + bx];
          if (w < 0.5) { r = pBL.data[iBL]; g = pBL.data[iBL + 1]; b = pBL.data[iBL + 2]; }
          else         { r = pBR.data[iBR]; g = pBR.data[iBR + 1]; b = pBR.data[iBR + 2]; }
        }
        // Left band
        else if (x < H - O && y >= H - O && y < H + O) {
          const bx = x, by = y - (H - O);
          const w = leftMask[by * bandW_V + bx];
          if (w < 0.5) { r = pTL.data[iTL]; g = pTL.data[iTL + 1]; b = pTL.data[iTL + 2]; }
          else         { r = pBL.data[iBL]; g = pBL.data[iBL + 1]; b = pBL.data[iBL + 2]; }
        }
        // Right band
        else if (x >= H + O && y >= H - O && y < H + O) {
          const bx = x - (H + O), by = y - (H - O);
          const w = rightMask[by * bandW_V + bx];
          if (w < 0.5) { r = pTR.data[iTR]; g = pTR.data[iTR + 1]; b = pTR.data[iTR + 2]; }
          else         { r = pBR.data[iBR]; g = pBR.data[iBR + 1]; b = pBR.data[iBR + 2]; }
        }
        // Else: corner zones (1 patch) or centre zone (4 patches → X diagonal)
        else {
          // Is this pixel in the centre (all-4) zone?
          const inCentre = x >= H - O && x < H + O && y >= H - O && y < H + O;

          if (!inCentre) {
            // Corner — only 1 patch covers this pixel.
            if (x < H && y < H)           { r = pTL.data[iTL]; g = pTL.data[iTL + 1]; b = pTL.data[iTL + 2]; }
            else if (x >= H && y < H)     { r = pTR.data[iTR]; g = pTR.data[iTR + 1]; b = pTR.data[iTR + 2]; }
            else if (x < H && y >= H)     { r = pBL.data[iBL]; g = pBL.data[iBL + 1]; b = pBL.data[iBL + 2]; }
            else                          { r = pBR.data[iBR]; g = pBR.data[iBR + 1]; b = pBR.data[iBR + 2]; }
          } else {
            // Centre zone — all 4 patches overlap.
            // Partition by the two diagonals (X shape) with soft blending.
            const d1 = x / T - y / T;          // TL→BR diagonal
            const d2 = 1 - x / T - y / T;      // TR→BL diagonal
            const dist1 = Math.abs(d1) * (T / Math.SQRT2);
            const dist2 = Math.abs(d2) * (T / Math.SQRT2);
            const F = 16;  // feather radius in px (wider for smoother centre)

            // Which quadrant does this pixel fall into?
            let q;
            if (d1 >= 0 && d2 >= 0)       q = 'TL';
            else if (d1 >= 0 && d2 < 0)   q = 'TR';
            else if (d1 < 0 && d2 >= 0)   q = 'BL';
            else                          q = 'BR';

            const minDist = Math.min(dist1, dist2);

            if (minDist > F) {
              // Far from any diagonal — use primary quadrant.
              if (q === 'TL')      { r = pTL.data[iTL]; g = pTL.data[iTL + 1]; b = pTL.data[iTL + 2]; }
              else if (q === 'TR') { r = pTR.data[iTR]; g = pTR.data[iTR + 1]; b = pTR.data[iTR + 2]; }
              else if (q === 'BL') { r = pBL.data[iBL]; g = pBL.data[iBL + 1]; b = pBL.data[iBL + 2]; }
              else                 { r = pBR.data[iBR]; g = pBR.data[iBR + 1]; b = pBR.data[iBR + 2]; }
            } else {
              // Near a diagonal — weighted blend of the two patches sharing
              // that diagonal.
              const alpha = minDist / F;

              // dist1 → TL-BR diagonal, dist2 → TR-BL diagonal
              let pA, pB, iA, iB;
              if (dist1 < dist2) {
                // Closer to TL-BR diagonal → blend TL ↔ BR
                pA = pTL; iA = iTL;
                pB = pBR; iB = iBR;
              } else {
                // Closer to TR-BL diagonal → blend TR ↔ BL
                pA = pTR; iA = iTR;
                pB = pBL; iB = iBL;
              }

              const wA = 0.5 + 0.5 * alpha;
              const wB = 1 - wA;

              r = Math.round(pA.data[iA] * wA + pB.data[iB] * wB);
              g = Math.round(pA.data[iA + 1] * wA + pB.data[iB + 1] * wB);
              b = Math.round(pA.data[iA + 2] * wA + pB.data[iB + 2] * wB);
            }
          }
        }

        const oi = (y * T + x) * 4;
        out[oi] = r; out[oi + 1] = g; out[oi + 2] = b; out[oi + 3] = 255;
      }
    }

    await sharp(out, { raw: { width: T, height: T, channels: 4 } })
      .png().toFile(path.join(wangDir, `wang_${idx}.png`));
    count++;
  }}}}

  console.log(`✓ Done — ${count} tiles written to ${wangDir}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
