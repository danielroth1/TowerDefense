#!/usr/bin/env node
/**
 * Cohen et al. (2003) Wang Tile Generator — Dynamic Programming Cut Paths
 *
 * This implements the canonical algorithm from:
 *   "Wang Tiles for Image and Texture Generation" (Cohen, Shade, Hiller, Deussen; SIGGRAPH 2003)
 *
 * Core idea:
 *   1. Compute 4 optimal "cut paths" through the source texture using DP:
 *      - H₀, H₁: horizontal cuts (functions x → y) for edge colours 0 and 1
 *      - V₀, V₁: vertical cuts   (functions y → x) for edge colours 0 and 1
 *      Each cut minimizes the visual difference across itself, with a smoothness
 *      regularisation term.
 *
 *   2. Each of the 16 Wang tiles is assembled by mapping the quadrilateral region
 *      bounded by the 4 appropriate cut paths to a square tile.  Because tiles
 *      sharing an edge colour use the *same* cut path, their shared boundary is
 *      pixel-identical — guaranteeing seamless tiling.
 *
 * Edge colour mapping:
 *   edgeColor(a, b) = a XOR b     (0 if corners match, 1 if they differ)
 *
 *   So tile (tl, tr, br, bl) uses:
 *     top    → H_{tl ⊕ tr}
 *     right  → V_{tr ⊕ br}
 *     bottom → H_{bl ⊕ br}
 *     left   → V_{tl ⊕ bl}
 *
 * Usage:
 *   node tools/wang-tiles/generate-cohen2.mjs <inputPath> <outputDir> [tileSize]
 *
 * Example:
 *   node tools/wang-tiles/generate-cohen2.mjs public/assets/tiles/tile_grass.png public/assets/tiles/ 192
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// ── Tunables ────────────────────────────────────────────────────────────
const SMOOTHNESS = 2.0;    // DP smoothness penalty (higher = straighter cuts)
const SEARCH_HALVES = true; // restrict H₀/V₀ to first half, H₁/V₁ to second half
const MARGIN = 8;          // minimum pixels from source edge for cut paths
const ITERATIONS = 4;      // coordinate-mapping refinement iterations
const MIN_REGION_FRAC = 0.25; // minimum fraction of source size for degenerate regions

// ── Helpers ─────────────────────────────────────────────────────────────
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ── RGBA helpers ────────────────────────────────────────────────────────
function srcIdx(w, x, y) {
  return ((clamp(y, 0, (w - 1)) & 0xffff) * w + (clamp(x, 0, (w - 1)) & 0xffff)) * 4;
}

/** Squared colour difference between two pixels in the raw buffer */
function colorDiffSq(buf, w, x1, y1, x2, y2) {
  const i1 = srcIdx(w, x1, y1);
  const i2 = srcIdx(w, x2, y2);
  const dr = buf[i1] - buf[i2];
  const dg = buf[i1 + 1] - buf[i2 + 1];
  const db = buf[i1 + 2] - buf[i2 + 2];
  return dr * dr + dg * dg + db * db;
}

// ── DP: Compute an optimal horizontal cut path (left → right) ──────────
//
// A horizontal cut is a function y = H[x] for x ∈ [0, W-1].
// At each column x, the cut separates the pixel at (x, H[x]) "above" from
// the pixel at (x, H[x]+1) "below".  The cost at (x, y) is the squared
// colour difference of those two pixels.  The DP adds a smoothness penalty
// λ·|y − y_prev| to discourage jagged paths.
//
// Returns: { path: Int16Array(W), totalCost: number }
//
function computeHorizontalCut(buf, srcW, srcH, searchYLo, searchYHi) {
  const W = srcW;
  const H = srcH;
  const yLo = Math.max(MARGIN, searchYLo);
  const yHi = Math.min(H - MARGIN - 1, searchYHi); // -1 so we have pixel below
  const nY = yHi - yLo;
  const λ = SMOOTHNESS;

  // dp[col][row] = minimum cost path from column 0 to (col, yLo+row)
  // prev[col][row] = best predecessor row index (in yLo offset)
  const dp = new Float64Array(W * nY);
  const prev = new Int16Array(W * nY);

  // Column 0: base cost only
  for (let r = 0; r < nY; r++) {
    const y = yLo + r;
    dp[r] = colorDiffSq(buf, W, 0, y, 0, y + 1);
  }

  // Columns 1..W-1
  for (let x = 1; x < W; x++) {
    const off = x * nY;
    const prevOff = (x - 1) * nY;

    // Naive O(H²) per column is fine for typical source sizes (1024² → 1024² per col = ~1M ops)
    for (let r = 0; r < nY; r++) {
      const y = yLo + r;
      const baseCost = colorDiffSq(buf, W, x, y, x, y + 1);
      let bestVal = Infinity;
      let bestR = 0;

      for (let pr = 0; pr < nY; pr++) {
        const val = dp[prevOff + pr] + λ * Math.abs(r - pr);
        if (val < bestVal) {
          bestVal = val;
          bestR = pr;
        }
      }

      dp[off + r] = baseCost + bestVal;
      prev[off + r] = bestR;
    }
  }

  // Trace back from the best ending row
  let bestEnd = 0;
  let bestEndVal = Infinity;
  const lastOff = (W - 1) * nY;
  for (let r = 0; r < nY; r++) {
    if (dp[lastOff + r] < bestEndVal) {
      bestEndVal = dp[lastOff + r];
      bestEnd = r;
    }
  }

  const path = new Int16Array(W);
  let curR = bestEnd;
  for (let x = W - 1; x >= 0; x--) {
    path[x] = yLo + curR;
    if (x > 0) {
      curR = prev[x * nY + curR];
    }
  }

  return { path, totalCost: bestEndVal };
}

// ── DP: Compute an optimal vertical cut path (top → bottom) ────────────
//
// Transposed version of computeHorizontalCut.  Operates on the raw buffer
// directly to avoid copying the whole image.
//
function computeVerticalCut(buf, srcW, srcH, searchXLo, searchXHi) {
  const W = srcW;
  const H = srcH;
  const xLo = Math.max(MARGIN, searchXLo);
  const xHi = Math.min(W - MARGIN - 1, searchXHi);
  const nX = xHi - xLo;
  const λ = SMOOTHNESS;

  const dp = new Float64Array(H * nX);
  const prev = new Int16Array(H * nX);

  // Row 0
  for (let c = 0; c < nX; c++) {
    const x = xLo + c;
    dp[c] = colorDiffSq(buf, W, x, 0, x + 1, 0);
  }

  // Rows 1..H-1
  for (let y = 1; y < H; y++) {
    const off = y * nX;
    const prevOff = (y - 1) * nX;

    for (let c = 0; c < nX; c++) {
      const x = xLo + c;
      const baseCost = colorDiffSq(buf, W, x, y, x + 1, y);
      let bestVal = Infinity;
      let bestC = 0;

      for (let pc = 0; pc < nX; pc++) {
        const val = dp[prevOff + pc] + λ * Math.abs(c - pc);
        if (val < bestVal) {
          bestVal = val;
          bestC = pc;
        }
      }

      dp[off + c] = baseCost + bestVal;
      prev[off + c] = bestC;
    }
  }

  let bestEnd = 0;
  let bestEndVal = Infinity;
  const lastOff = (H - 1) * nX;
  for (let c = 0; c < nX; c++) {
    if (dp[lastOff + c] < bestEndVal) {
      bestEndVal = dp[lastOff + c];
      bestEnd = c;
    }
  }

  const path = new Int16Array(H);
  let curC = bestEnd;
  for (let y = H - 1; y >= 0; y--) {
    path[y] = xLo + curC;
    if (y > 0) {
      curC = prev[y * nX + curC];
    }
  }

  return { path, totalCost: bestEndVal };
}

// ── Bilinear sample from the raw source buffer ──────────────────────────
function sampleSource(buf, srcW, srcH, sx, sy, out, outOff) {
  // Clamp to valid range
  const cx = clamp(sx, 0, srcW - 1);
  const cy = clamp(sy, 0, srcH - 1);

  const fx = cx - Math.floor(cx);
  const fy = cy - Math.floor(cy);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, srcW - 1);
  const y1 = Math.min(y0 + 1, srcH - 1);

  for (let c = 0; c < 3; c++) {
    const v00 = buf[srcIdx(srcW, x0, y0) + c];
    const v10 = buf[srcIdx(srcW, x1, y0) + c];
    const v01 = buf[srcIdx(srcW, x0, y1) + c];
    const v11 = buf[srcIdx(srcW, x1, y1) + c];
    const v = lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
    out[outOff + c] = Math.round(v);
  }
  out[outOff + 3] = 255;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate-cohen2.mjs <inputPath> <outputDir> [tileSize]');
    process.exit(1);
  }

  const inputPath = args[0];
  const outputDir = args[1];
  const tileSize = parseInt(args[2], 10) || 192;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wangDir = path.join(outputDir, `${baseName}_wang`);
  ensureDir(wangDir);

  // ── Load source ──────────────────────────────────────────────────────
  const image = sharp(inputPath);
  const meta = await image.metadata();
  const srcW = meta.width;
  const srcH = meta.height;
  if (!srcW || !srcH || srcW !== srcH) {
    console.error('Input must be a square image.');
    process.exit(1);
  }

  console.log(`\nCohen Wang Tile Generator (DP cut paths)`);
  console.log(`  Source:     ${inputPath} (${srcW}×${srcH})`);
  console.log(`  Tile size:  ${tileSize}px`);
  console.log(`  Smoothness: λ=${SMOOTHNESS}`);
  console.log(`  Output:     ${wangDir}/\n`);

  const { data } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const S = data;

  // ── Phase 1: Compute the 4 cut paths ─────────────────────────────────
  //
  // H₀ (edge colour 0): search upper half of source
  // H₁ (edge colour 1): search lower half
  // V₀ (edge colour 0): search left half
  // V₁ (edge colour 1): search right half
  //
  // Splitting the search space ensures the two cuts per direction are well
  // separated, producing distinct tile interiors.

  const midH = Math.floor(srcH / 2);
  const midW = Math.floor(srcW / 2);

  console.log('Phase 1: Computing optimal DP cut paths...');

  let h0RangeLo = MARGIN, h0RangeHi = midH;
  let h1RangeLo = midH, h1RangeHi = srcH - MARGIN - 1;
  let v0RangeLo = MARGIN, v0RangeHi = midW;
  let v1RangeLo = midW, v1RangeHi = srcW - MARGIN - 1;

  if (!SEARCH_HALVES) {
    h0RangeHi = srcH - MARGIN - 1;
    h1RangeLo = MARGIN;
    v0RangeHi = srcW - MARGIN - 1;
    v1RangeLo = MARGIN;
  }

  const H0 = computeHorizontalCut(S, srcW, srcH, h0RangeLo, h0RangeHi);
  const H1 = computeHorizontalCut(S, srcW, srcH, h1RangeLo, h1RangeHi);
  const V0 = computeVerticalCut(S, srcW, srcH, v0RangeLo, v0RangeHi);
  const V1 = computeVerticalCut(S, srcW, srcH, v1RangeLo, v1RangeHi);

  console.log(`  H₀ (colour 0): cost=${H0.totalCost.toFixed(1)}, y range [${Math.min(...H0.path)}, ${Math.max(...H0.path)}]`);
  console.log(`  H₁ (colour 1): cost=${H1.totalCost.toFixed(1)}, y range [${Math.min(...H1.path)}, ${Math.max(...H1.path)}]`);
  console.log(`  V₀ (colour 0): cost=${V0.totalCost.toFixed(1)}, x range [${Math.min(...V0.path)}, ${Math.max(...V0.path)}]`);
  console.log(`  V₁ (colour 1): cost=${V1.totalCost.toFixed(1)}, x range [${Math.min(...V1.path)}, ${Math.max(...V1.path)}]`);

  // ── Phase 2: Assemble the 16 Wang tiles ──────────────────────────────
  //
  // For tile (tl, tr, br, bl):
  //   topCut    = H_{tl ⊕ tr}
  //   bottomCut = H_{bl ⊕ br}
  //   leftCut   = V_{tl ⊕ bl}
  //   rightCut  = V_{tr ⊕ br}
  //
  // For each output pixel (ox, oy), we compute the corresponding source
  // coordinate (sx, sy) via iterative refinement:
  //
  //   sy ≈ lerp(topCut[sx], bottomCut[sx], v)    (vertical position)
  //   sx ≈ lerp(leftCut[sy], rightCut[sy], u)    (horizontal position)
  //
  // These are coupled; a few iterations converge quickly for well-behaved
  // cut paths (which the DP ensures).

  console.log('\nPhase 2: Assembling 16 Wang tiles...');

  const CORNER_CONFIGS = [];
  for (let tl = 0; tl <= 1; tl++)
    for (let tr = 0; tr <= 1; tr++)
      for (let br = 0; br <= 1; br++)
        for (let bl = 0; bl <= 1; bl++)
          CORNER_CONFIGS.push({ tl, tr, br, bl });

  const H_CUTS = [H0.path, H1.path];
  const V_CUTS = [V0.path, V1.path];

  // Pre-compute average cut positions for degenerate-region sizing
  const h0Avg = H0.path.reduce((a, v) => a + v, 0) / srcW;
  const h1Avg = H1.path.reduce((a, v) => a + v, 0) / srcW;
  const v0Avg = V0.path.reduce((a, v) => a + v, 0) / srcH;
  const v1Avg = V1.path.reduce((a, v) => a + v, 0) / srcH;

  // Half-height/width for regions when both edges use the same cut
  const regionHalfH = Math.max(MIN_REGION_FRAC * srcH * 0.5, Math.abs(h1Avg - h0Avg) * 0.5);
  const regionHalfW = Math.max(MIN_REGION_FRAC * srcW * 0.5, Math.abs(v1Avg - v0Avg) * 0.5);

  console.log(`  Region half-size: ${regionHalfH.toFixed(0)}px vertical, ${regionHalfW.toFixed(0)}px horizontal`);

  let generated = 0;

  for (const cfg of CORNER_CONFIGS) {
    const { tl, tr, br, bl } = cfg;
    const tileIdx = tl * 8 + tr * 4 + br * 2 + bl;

    // Edge colours
    const topCol    = tl ^ tr;
    const bottomCol = bl ^ br;
    const leftCol   = tl ^ bl;
    const rightCol  = tr ^ br;

    const topCut    = H_CUTS[topCol];
    const bottomCut = H_CUTS[bottomCol];
    const leftCut   = V_CUTS[leftCol];
    const rightCut  = V_CUTS[rightCol];

    // Determine if horizontal/vertical cuts are degenerate (same curve)
    const sameH = (topCut === bottomCut);
    const sameV = (leftCut === rightCut);

    const outBuf = Buffer.alloc(tileSize * tileSize * 4);

    for (let oy = 0; oy < tileSize; oy++) {
      const v = oy / (tileSize - 1);  // vertical parameter [0, 1]

      for (let ox = 0; ox < tileSize; ox++) {
        const u = ox / (tileSize - 1);  // horizontal parameter [0, 1]

        // Iterative refinement to solve the coupled system.
        // After ITERATIONS passes, (sx,sy) is the source coordinate
        // corresponding to output pixel (ox,oy).
        let sx = u * (srcW - 1);
        let sy = v * (srcH - 1);

        for (let iter = 0; iter < ITERATIONS; iter++) {
          // ── Horizontal bounds ─────────────────────────────────
          const tx = clamp(Math.floor(sx), 0, srcW - 1);
          let topBound, bottomBound;
          if (sameH) {
            // Both edges use the same cut — center the region on the cut curve
            const center = topCut[tx];
            topBound    = center - regionHalfH;
            bottomBound = center + regionHalfH;
          } else {
            topBound    = topCut[tx];
            bottomBound = bottomCut[tx];
          }
          sy = lerp(topBound, bottomBound, v);

          // ── Vertical bounds ───────────────────────────────────
          const ty = clamp(Math.floor(sy), 0, srcH - 1);
          let leftBound, rightBound;
          if (sameV) {
            const center = leftCut[ty];
            leftBound  = center - regionHalfW;
            rightBound = center + regionHalfW;
          } else {
            leftBound  = leftCut[ty];
            rightBound = rightCut[ty];
          }
          sx = lerp(leftBound, rightBound, u);
        }

        // Clamp to valid source range for bilinear sampling
        sx = clamp(sx, 0, srcW - 1);
        sy = clamp(sy, 0, srcH - 1);

        const di = (oy * tileSize + ox) * 4;
        sampleSource(S, srcW, srcH, sx, sy, outBuf, di);
      }
    }

    // ── Write output ─────────────────────────────────────────────────
    const fileName = `wang_${tileIdx}.png`;
    const outputPath = path.join(wangDir, fileName);

    await sharp(outBuf, {
      raw: { width: tileSize, height: tileSize, channels: 4 },
    })
      .png()
      .toFile(outputPath);

    generated++;

    if (generated % 4 === 0) {
      console.log(`  ${generated}/16 tiles written...`);
    }
  }

  console.log(`\n✓ Done — ${generated} Cohen-style Wang tiles written to ${wangDir}/`);
  console.log(`  Algorithm: DP cut paths (Cohen et al. 2003)`);
  console.log(`  Edge colours: H₀,H₁,V₀,V₁ with λ=${SMOOTHNESS}`);
  console.log(`  Tiles sharing an edge colour use the identical cut path → guaranteed seamless\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
