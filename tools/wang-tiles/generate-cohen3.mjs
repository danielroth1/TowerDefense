#!/usr/bin/env node
/**
 * Cohen et al. (2003) Wang Tile Generator — DP Cut Paths + Canonical Edges
 *
 * Faithful implementation of the algorithm from:
 *   "Wang Tiles for Image and Texture Generation"
 *   (Cohen, Shade, Hiller, Deussen; SIGGRAPH 2003)
 *
 * The Cohen paper describes two key ideas:
 *
 *   1. **Optimal cut paths via dynamic programming** — Four minimum-cost cut
 *      paths (H₀, H₁ horizontal; V₀, V₁ vertical) are computed through the
 *      source texture.  Each cut minimizes the visual discontinuity across
 *      itself, with a smoothness regularisation term.  The DP runs in O(W·H)
 *      per cut using the standard two-pass L1-distance optimisation.
 *
 *   2. **Coordinate-mapping tile assembly** — Each of the 16 Wang tiles is
 *      produced by mapping the quadrilateral region bounded by its four
 *      assigned cut paths to a square output tile.
 *
 * CRITICAL ADDITION — Canonical edge forcing:
 *   The basic DP-cut-path approach does NOT guarantee pixel-identical edges
 *   between tiles sharing an edge colour, because the coordinate mapping
 *   along the boundary depends on the OTHER cuts (e.g. the top-edge mapping
 *   depends on left/right cuts via the coupled system).
 *
 *   To fix this, we pre-extract "canonical edges" for each of the 16
 *   (edge, colourPair) combinations by sampling the source uniformly along
 *   the cut path.  These canonical edges are forced onto the outermost
 *   EDGE_PX rows/cols of every tile.  A BLEND_PX-wide cosine-weighted
 *   transition zone between the canonical edge and the coordinate-mapped
 *   interior ensures a seamless join.
 *
 * Edge colour mapping:
 *   edgeColour(a, b) = a XOR b
 *
 *   Tile (tl, tr, br, bl) uses:
 *     top    → H_{tl ⊕ tr}       right → V_{tr ⊕ br}
 *     bottom → H_{bl ⊕ br}       left  → V_{tl ⊕ bl}
 *
 * Usage:
 *   node tools/wang-tiles/generate-cohen3.mjs <inputPath> <outputDir> [tileSize]
 *
 * Example:
 *   node tools/wang-tiles/generate-cohen3.mjs public/assets/tiles/tile_grass.png public/assets/tiles/ 192
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// ── Tunables ────────────────────────────────────────────────────────────
const SMOOTHNESS   = 1.5;   // λ — DP smoothness penalty (higher = straighter cuts)
const MARGIN       = 8;     // minimum px from source edge for cut paths
const ITERATIONS   = 16;    // coordinate-mapping refinement iterations
const MIN_REGION_FRAC = 0.15; // minimum fraction of source size for degenerate
                              // regions (both edges use same cut)

const EDGE_PX = 2;   // width of canonical edge strip (guarantees pixel-identical
                      // edges for all tiles sharing an edge colour)
const BLEND_PX = 8;  // width of cosine-weighted blend zone between canonical
                      // edge and coordinate-mapped interior

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

function srcIdx(w, x, y) {
  const cx = clamp(x, 0, w - 1);
  const cy = clamp(y, 0, w - 1);
  return ((cy & 0xffff) * w + (cx & 0xffff)) * 4;
}

/** Squared RGB colour difference between two pixels in the raw buffer. */
function colorDiffSq(buf, w, x1, y1, x2, y2) {
  const i1 = srcIdx(w, x1, y1);
  const i2 = srcIdx(w, x2, y2);
  const dr = buf[i1]     - buf[i2];
  const dg = buf[i1 + 1] - buf[i2 + 1];
  const db = buf[i1 + 2] - buf[i2 + 2];
  return dr * dr + dg * dg + db * db;
}

/** Bilinear sample from raw source buffer into output buffer at offset. */
function sampleSource(buf, srcW, sx, sy, out, outOff) {
  const cx = clamp(sx, 0, srcW - 1);
  const cy = clamp(sy, 0, srcW - 1);

  const fx = cx - Math.floor(cx);
  const fy = cy - Math.floor(cy);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, srcW - 1);
  const y1 = Math.min(y0 + 1, srcW - 1);

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

// ── O(W·H) DP for optimal cut paths ─────────────────────────────────────
//
// Computes a minimum-cost path from one side of the image to the other.
// For a horizontal cut (left→right), the path is a function y = H[x].
// The cost at (x, y) is the squared colour difference between the pixel
// "above" the cut (x, y) and the pixel "below" (x, y+1), plus a smoothness
// penalty λ·|y − y_prev|.
//
// Uses the standard two-pass L1-distance-transform optimisation for O(W·H):
//   above[y] = min_{y'≤y} { dp[x-1][y'] − λ·y' } + λ·y
//   below[y] = min_{y'≥y} { dp[x-1][y'] + λ·y' } − λ·y
//   dp[x][y] = cost[x][y] + min(above[y], below[y])

function computeHorizontalCut(buf, srcW, srcH, searchYLo, searchYHi) {
  const W = srcW;
  const yLo = Math.max(MARGIN, searchYLo);
  const yHi = Math.min(srcH - MARGIN - 1, searchYHi); // -1: need pixel below
  const nY  = yHi - yLo;
  const λ   = SMOOTHNESS;

  if (nY <= 0) {
    const forcedY = clamp(Math.floor((searchYLo + searchYHi) / 2), MARGIN, srcH - MARGIN - 1);
    const path = new Int16Array(W);
    path.fill(forcedY);
    return { path, totalCost: 0 };
  }

  const dp   = new Float64Array(W * nY);
  const prev = new Int16Array(W * nY);

  // Column 0: base cost only
  for (let r = 0; r < nY; r++) {
    dp[r] = colorDiffSq(buf, W, 0, yLo + r, 0, yLo + r + 1);
    prev[r] = r;
  }

  const above     = new Float64Array(nY);
  const abovePrev = new Int16Array(nY);
  const below     = new Float64Array(nY);
  const belowPrev = new Int16Array(nY);
  const dpPrev    = new Float64Array(nY);

  for (let x = 1; x < W; x++) {
    const off     = x * nY;
    const prevOff = (x - 1) * nY;

    for (let r = 0; r < nY; r++) {
      dpPrev[r] = dp[prevOff + r];
    }

    // Forward pass: accumulate min from above (y' ≤ y)
    let running = Infinity, bestPr = 0;
    for (let r = 0; r < nY; r++) {
      const cand = dpPrev[r] - λ * r;
      if (cand < running) { running = cand; bestPr = r; }
      above[r]     = running + λ * r;
      abovePrev[r] = bestPr;
    }

    // Backward pass: accumulate min from below (y' ≥ y)
    running = Infinity; bestPr = nY - 1;
    for (let r = nY - 1; r >= 0; r--) {
      const cand = dpPrev[r] + λ * r;
      if (cand < running) { running = cand; bestPr = r; }
      below[r]     = running - λ * r;
      belowPrev[r] = bestPr;
    }

    for (let r = 0; r < nY; r++) {
      const y = yLo + r;
      const base = colorDiffSq(buf, W, x, y, x, y + 1);

      if (above[r] <= below[r]) {
        dp[off + r]   = base + above[r];
        prev[off + r] = abovePrev[r];
      } else {
        dp[off + r]   = base + below[r];
        prev[off + r] = belowPrev[r];
      }
    }
  }

  // Trace back from best ending row
  let bestEnd = 0, bestVal = Infinity;
  const lastOff = (W - 1) * nY;
  for (let r = 0; r < nY; r++) {
    if (dp[lastOff + r] < bestVal) { bestVal = dp[lastOff + r]; bestEnd = r; }
  }

  const path = new Int16Array(W);
  let curR = bestEnd;
  for (let x = W - 1; x >= 0; x--) {
    path[x] = yLo + curR;
    if (x > 0) curR = prev[x * nY + curR];
  }

  return { path, totalCost: bestVal };
}

/** Vertical cut — transposed version of computeHorizontalCut. */
function computeVerticalCut(buf, srcW, srcH, searchXLo, searchXHi) {
  const H = srcH;
  const xLo = Math.max(MARGIN, searchXLo);
  const xHi = Math.min(srcW - MARGIN - 1, searchXHi);
  const nX  = xHi - xLo;
  const λ   = SMOOTHNESS;

  if (nX <= 0) {
    const forcedX = clamp(Math.floor((searchXLo + searchXHi) / 2), MARGIN, srcW - MARGIN - 1);
    const path = new Int16Array(H);
    path.fill(forcedX);
    return { path, totalCost: 0 };
  }

  const dp   = new Float64Array(H * nX);
  const prev = new Int16Array(H * nX);

  for (let c = 0; c < nX; c++) {
    dp[c] = colorDiffSq(buf, srcW, xLo + c, 0, xLo + c + 1, 0);
    prev[c] = c;
  }

  const above     = new Float64Array(nX);
  const abovePrev = new Int16Array(nX);
  const below     = new Float64Array(nX);
  const belowPrev = new Int16Array(nX);
  const dpPrev    = new Float64Array(nX);

  for (let y = 1; y < H; y++) {
    const off     = y * nX;
    const prevOff = (y - 1) * nX;

    for (let c = 0; c < nX; c++) {
      dpPrev[c] = dp[prevOff + c];
    }

    let running = Infinity, bestPc = 0;
    for (let c = 0; c < nX; c++) {
      const cand = dpPrev[c] - λ * c;
      if (cand < running) { running = cand; bestPc = c; }
      above[c]     = running + λ * c;
      abovePrev[c] = bestPc;
    }

    running = Infinity; bestPc = nX - 1;
    for (let c = nX - 1; c >= 0; c--) {
      const cand = dpPrev[c] + λ * c;
      if (cand < running) { running = cand; bestPc = c; }
      below[c]     = running - λ * c;
      belowPrev[c] = bestPc;
    }

    for (let c = 0; c < nX; c++) {
      const x = xLo + c;
      const base = colorDiffSq(buf, srcW, x, y, x + 1, y);

      if (above[c] <= below[c]) {
        dp[off + c]   = base + above[c];
        prev[off + c] = abovePrev[c];
      } else {
        dp[off + c]   = base + below[c];
        prev[off + c] = belowPrev[c];
      }
    }
  }

  let bestEnd = 0, bestVal = Infinity;
  const lastOff = (H - 1) * nX;
  for (let c = 0; c < nX; c++) {
    if (dp[lastOff + c] < bestVal) { bestVal = dp[lastOff + c]; bestEnd = c; }
  }

  const path = new Int16Array(H);
  let curC = bestEnd;
  for (let y = H - 1; y >= 0; y--) {
    path[y] = xLo + curC;
    if (y > 0) curC = prev[y * nX + curC];
  }

  return { path, totalCost: bestVal };
}

// ── Canonical edge extraction ───────────────────────────────────────────
//
// For each (edge, colourPair), extract EDGE_PX rows/cols from the source
// adjacent to the cut path.  These are the canonical edge pixels — every
// tile sharing this edge colour gets these exact pixels on its boundary,
// guaranteeing pixel-identical seams.
//
//   Top edge:    rows [cut[x]+1, cut[x]+EDGE_PX] at column x
//   Bottom edge: rows [cut[x]-EDGE_PX, cut[x]-1] at column x
//   Left edge:   cols [cut[y]+1, cut[y]+EDGE_PX] at row y
//   Right edge:  cols [cut[y]-EDGE_PX, cut[y]-1] at row y
//
// Returns: Array(4) of Array(4) of Float64Array[EDGE_PX * tileSize * 4]

function extractCanonicalEdges(buf, srcW, H_cuts, V_cuts, tileSize) {
  // pair → edgeColour mapping: pair = c1*2 + c2, edgeColour = c1 XOR c2
  function pairToColour(p) { return (p === 0 || p === 3) ? 0 : 1; }

  // Canonical edges are extracted at TILE resolution (tileSize pixels wide/tall).
  // Each tile column ox maps to source column: srcCol = round(ox * (srcW-1) / (tileSize-1))

  const edges = Array.from({ length: 4 }, () => Array(4));

  for (let pair = 0; pair < 4; pair++) {
    const ec = pairToColour(pair);
    const hPath = H_cuts[ec];
    const vPath = V_cuts[ec];

    // ── Top edge ──
    {
      const buf2 = new Float64Array(tileSize * EDGE_PX * 4);
      for (let ox = 0; ox < tileSize; ox++) {
        const sx = Math.round(ox * (srcW - 1) / (tileSize - 1));
        for (let k = 0; k < EDGE_PX; k++) {
          const sy = hPath[sx] + 1 + k;
          const si = srcIdx(srcW, sx, sy);
          const di = (ox * EDGE_PX + k) * 4;
          buf2[di]     = buf[si];
          buf2[di + 1] = buf[si + 1];
          buf2[di + 2] = buf[si + 2];
          buf2[di + 3] = 255;
        }
      }
      edges[0][pair] = buf2;
    }

    // ── Bottom edge ──
    {
      const buf2 = new Float64Array(tileSize * EDGE_PX * 4);
      for (let ox = 0; ox < tileSize; ox++) {
        const sx = Math.round(ox * (srcW - 1) / (tileSize - 1));
        for (let k = 0; k < EDGE_PX; k++) {
          const sy = hPath[sx] - 1 - k;
          const si = srcIdx(srcW, sx, sy);
          const di = (ox * EDGE_PX + k) * 4;
          buf2[di]     = buf[si];
          buf2[di + 1] = buf[si + 1];
          buf2[di + 2] = buf[si + 2];
          buf2[di + 3] = 255;
        }
      }
      edges[2][pair] = buf2;
    }

    // ── Left edge ──
    {
      const buf2 = new Float64Array(tileSize * EDGE_PX * 4);
      for (let oy = 0; oy < tileSize; oy++) {
        const sy = Math.round(oy * (srcW - 1) / (tileSize - 1));
        for (let k = 0; k < EDGE_PX; k++) {
          const sx = vPath[sy] + 1 + k;
          const si = srcIdx(srcW, sx, sy);
          const di = (oy * EDGE_PX + k) * 4;
          buf2[di]     = buf[si];
          buf2[di + 1] = buf[si + 1];
          buf2[di + 2] = buf[si + 2];
          buf2[di + 3] = 255;
        }
      }
      edges[3][pair] = buf2;
    }

    // ── Right edge ──
    {
      const buf2 = new Float64Array(tileSize * EDGE_PX * 4);
      for (let oy = 0; oy < tileSize; oy++) {
        const sy = Math.round(oy * (srcW - 1) / (tileSize - 1));
        for (let k = 0; k < EDGE_PX; k++) {
          const sx = vPath[sy] - 1 - k;
          const si = srcIdx(srcW, sx, sy);
          const di = (oy * EDGE_PX + k) * 4;
          buf2[di]     = buf[si];
          buf2[di + 1] = buf[si + 1];
          buf2[di + 2] = buf[si + 2];
          buf2[di + 3] = 255;
        }
      }
      edges[1][pair] = buf2;
    }
  }

  return edges;
}

// ── Cosine blend weight ─────────────────────────────────────────────────
function blendWeight(t) {
  // t ∈ [0, 1]: 0 = canonical edge side, 1 = interior side
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate-cohen3.mjs <inputPath> <outputDir> [tileSize]');
    process.exit(1);
  }

  const inputPath = args[0];
  const outputDir = args[1];
  const tileSize  = parseInt(args[2], 10) || 192;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wangDir  = path.join(outputDir, `${baseName}_wang`);
  ensureDir(wangDir);

  // ── Load source ──────────────────────────────────────────────────────
  const image = sharp(inputPath);
  const meta  = await image.metadata();
  const srcW  = meta.width;
  const srcH  = meta.height;
  if (!srcW || !srcH || srcW !== srcH) {
    console.error('Input must be a square image.');
    process.exit(1);
  }

  console.log(`\nCohen Wang Tile Generator v3 (DP cuts + canonical edges)`);
  console.log(`  Source:     ${inputPath} (${srcW}×${srcH})`);
  console.log(`  Tile size:  ${tileSize}px`);
  console.log(`  Smoothness: λ=${SMOOTHNESS}`);
  console.log(`  Edge px:    ${EDGE_PX} (pixel-identical guarantee)`);
  console.log(`  Blend px:   ${BLEND_PX} (cosine-weighted transition)`);
  console.log(`  Refinement: ${ITERATIONS} iterations`);
  console.log(`  Output:     ${wangDir}/\n`);

  const { data: S } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // ── Phase 1: Compute the 4 optimal cut paths ─────────────────────────
  const midH = Math.floor(srcH / 2);
  const midW = Math.floor(srcW / 2);

  console.log('Phase 1: Computing optimal DP cut paths (O(W·H) per cut)...');

  const H0 = computeHorizontalCut(S, srcW, srcH, MARGIN, midH);
  const H1 = computeHorizontalCut(S, srcW, srcH, midH, srcH - MARGIN - 1);
  const V0 = computeVerticalCut(S, srcW, srcH, MARGIN, midW);
  const V1 = computeVerticalCut(S, srcW, srcH, midW, srcW - MARGIN - 1);

  const fmtRange = (arr) => `[${Math.min(...arr)}, ${Math.max(...arr)}]`;
  console.log(`  H₀ (colour 0): cost=${H0.totalCost.toFixed(1)}, y ${fmtRange(H0.path)}`);
  console.log(`  H₁ (colour 1): cost=${H1.totalCost.toFixed(1)}, y ${fmtRange(H1.path)}`);
  console.log(`  V₀ (colour 0): cost=${V0.totalCost.toFixed(1)}, x ${fmtRange(V0.path)}`);
  console.log(`  V₁ (colour 1): cost=${V1.totalCost.toFixed(1)}, x ${fmtRange(V1.path)}`);

  const H_CUTS = [H0.path, H1.path];
  const V_CUTS = [V0.path, V1.path];

  // ── Phase 2: Extract canonical edges ─────────────────────────────────
  console.log('\nPhase 2: Extracting canonical edges...');

  const canonEdges = extractCanonicalEdges(S, srcW, H_CUTS, V_CUTS, tileSize);
  console.log('  16 canonical edge strips extracted ✓');

  // Pre-compute degenerate region sizing
  const h0Avg = H0.path.reduce((a, v) => a + v, 0) / srcW;
  const h1Avg = H1.path.reduce((a, v) => a + v, 0) / srcW;
  const v0Avg = V0.path.reduce((a, v) => a + v, 0) / srcH;
  const v1Avg = V1.path.reduce((a, v) => a + v, 0) / srcH;

  const regionHalfH = Math.max(
    MIN_REGION_FRAC * srcH * 0.5,
    Math.abs(h1Avg - h0Avg) * 0.6
  );
  const regionHalfW = Math.max(
    MIN_REGION_FRAC * srcW * 0.5,
    Math.abs(v1Avg - v0Avg) * 0.6
  );

  // ── Phase 3: Assemble the 16 Wang tiles ──────────────────────────────
  console.log('\nPhase 3: Assembling 16 Wang tiles (canonical edges + DP-mapped interior)...');
  console.log(`  Region half-height: ${regionHalfH.toFixed(0)}px, half-width: ${regionHalfW.toFixed(0)}px`);

  const totalEdge = EDGE_PX + BLEND_PX;

  const CORNER_CONFIGS = [];
  for (let tl = 0; tl <= 1; tl++)
    for (let tr = 0; tr <= 1; tr++)
      for (let br = 0; br <= 1; br++)
        for (let bl = 0; bl <= 1; bl++)
          CORNER_CONFIGS.push({ tl, tr, br, bl });

  let generated = 0;

  for (const cfg of CORNER_CONFIGS) {
    const { tl, tr, br, bl } = cfg;
    const tileIdx = tl * 8 + tr * 4 + br * 2 + bl;

    const topCol    = tl ^ tr;
    const bottomCol = bl ^ br;
    const leftCol   = tl ^ bl;
    const rightCol  = tr ^ br;

    const topCut    = H_CUTS[topCol];
    const bottomCut = H_CUTS[bottomCol];
    const leftCut   = V_CUTS[leftCol];
    const rightCut  = V_CUTS[rightCol];

    const sameH = (topCut === bottomCut);
    const sameV = (leftCut === rightCut);

    // Canonical edge pair indices
    const topPair    = tl * 2 + tr;
    const bottomPair = br * 2 + bl;
    const leftPair   = tl * 2 + bl;
    const rightPair  = tr * 2 + br;

    const canonTop    = canonEdges[0][topPair];
    const canonBottom = canonEdges[2][bottomPair];
    const canonLeft   = canonEdges[3][leftPair];
    const canonRight  = canonEdges[1][rightPair];

    const outBuf = Buffer.alloc(tileSize * tileSize * 4);

    for (let oy = 0; oy < tileSize; oy++) {
      const v = oy / (tileSize - 1);

      // Vertical blend factor: 0 = canonical edge, 1 = interior
      let vBlend = 1;
      if (oy < EDGE_PX) {
        vBlend = 0;
      } else if (oy < totalEdge) {
        vBlend = blendWeight((oy - EDGE_PX + 1) / (BLEND_PX + 1));
      }
      if (oy >= tileSize - EDGE_PX) {
        vBlend = 0;
      } else if (oy >= tileSize - totalEdge) {
        const distFromEdge = tileSize - 1 - oy;
        vBlend = blendWeight((distFromEdge - EDGE_PX + 1) / (BLEND_PX + 1));
      }

      for (let ox = 0; ox < tileSize; ox++) {
        const u = ox / (tileSize - 1);

        // Horizontal blend factor
        let uBlend = 1;
        if (ox < EDGE_PX) {
          uBlend = 0;
        } else if (ox < totalEdge) {
          uBlend = blendWeight((ox - EDGE_PX + 1) / (BLEND_PX + 1));
        }
        if (ox >= tileSize - EDGE_PX) {
          uBlend = 0;
        } else if (ox >= tileSize - totalEdge) {
          const distFromEdge = tileSize - 1 - ox;
          uBlend = blendWeight((distFromEdge - EDGE_PX + 1) / (BLEND_PX + 1));
        }

        // Combined blend factor
        const blend = uBlend * vBlend;

        // ── Canonical edge colour ──────────────────────────────────
        // Canonical edges are extracted at tile resolution, so use ox/oy directly.
        let canonR = 0, canonG = 0, canonB = 0, canonCount = 0;

        if (oy < EDGE_PX) {
          const k = oy;
          const ci = (ox * EDGE_PX + k) * 4;
          canonR += canonTop[ci]; canonG += canonTop[ci + 1]; canonB += canonTop[ci + 2];
          canonCount++;
        }
        if (oy >= tileSize - EDGE_PX) {
          const k = tileSize - 1 - oy;
          const ci = (ox * EDGE_PX + k) * 4;
          canonR += canonBottom[ci]; canonG += canonBottom[ci + 1]; canonB += canonBottom[ci + 2];
          canonCount++;
        }
        if (ox < EDGE_PX) {
          const k = ox;
          const ci = (oy * EDGE_PX + k) * 4;
          canonR += canonLeft[ci]; canonG += canonLeft[ci + 1]; canonB += canonLeft[ci + 2];
          canonCount++;
        }
        if (ox >= tileSize - EDGE_PX) {
          const k = tileSize - 1 - ox;
          const ci = (oy * EDGE_PX + k) * 4;
          canonR += canonRight[ci]; canonG += canonRight[ci + 1]; canonB += canonRight[ci + 2];
          canonCount++;
        }

        if (canonCount > 0) {
          canonR /= canonCount;
          canonG /= canonCount;
          canonB /= canonCount;
        }

        // ── Interior source coordinate via iterative refinement ────
        let sx = u * (srcW - 1);
        let sy = v * (srcH - 1);

        for (let iter = 0; iter < ITERATIONS; iter++) {
          const tx = clamp(Math.floor(sx), 0, srcW - 1);
          let topBound, bottomBound;
          if (sameH) {
            const center = topCut[tx];
            topBound    = center - regionHalfH;
            bottomBound = center + regionHalfH;
          } else {
            topBound    = topCut[tx];
            bottomBound = bottomCut[tx];
          }
          sy = lerp(topBound, bottomBound, v);

          const ty = clamp(Math.floor(sy), 0, srcW - 1);
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

        sx = clamp(sx, 0, srcW - 1);
        sy = clamp(sy, 0, srcW - 1);

        // ── Interior colour ────────────────────────────────────────
        let intR = 0, intG = 0, intB = 0;
        {
          const cx = clamp(sx, 0, srcW - 1);
          const cy = clamp(sy, 0, srcW - 1);
          const fx = cx - Math.floor(cx);
          const fy = cy - Math.floor(cy);
          const x0 = Math.floor(cx), y0 = Math.floor(cy);
          const x1 = Math.min(x0 + 1, srcW - 1), y1 = Math.min(y0 + 1, srcW - 1);

          for (let c = 0; c < 3; c++) {
            const v00 = S[srcIdx(srcW, x0, y0) + c];
            const v10 = S[srcIdx(srcW, x1, y0) + c];
            const v01 = S[srcIdx(srcW, x0, y1) + c];
            const v11 = S[srcIdx(srcW, x1, y1) + c];
            const val = lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
            if (c === 0) intR = val;
            else if (c === 1) intG = val;
            else intB = val;
          }
        }

        // ── Blend canonical and interior ───────────────────────────
        const di = (oy * tileSize + ox) * 4;
        if (blend >= 1) {
          outBuf[di]     = Math.round(intR);
          outBuf[di + 1] = Math.round(intG);
          outBuf[di + 2] = Math.round(intB);
        } else if (blend <= 0) {
          outBuf[di]     = Math.round(canonR);
          outBuf[di + 1] = Math.round(canonG);
          outBuf[di + 2] = Math.round(canonB);
        } else {
          outBuf[di]     = Math.round(lerp(canonR, intR, blend));
          outBuf[di + 1] = Math.round(lerp(canonG, intG, blend));
          outBuf[di + 2] = Math.round(lerp(canonB, intB, blend));
        }
        outBuf[di + 3] = 255;
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

  console.log(`\n✓ Done — ${generated} Wang tiles written to ${wangDir}/`);
  console.log(`  Algorithm: DP cut paths + canonical edges (Cohen et al. 2003)`);
  console.log(`  Guarantee: EDGE_PX=${EDGE_PX} pixel-identical borders for shared edge colours`);
  console.log(`  Transition: BLEND_PX=${BLEND_PX} cosine-weighted blend to interior\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
