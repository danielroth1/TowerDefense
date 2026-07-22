#!/usr/bin/env node
/**
 * Cohen et al. (2003) Wang Tile Generator — Diamond-Sample Quilting (v5)
 *
 * Faithful implementation of Section 3.2 of:
 *   "Wang Tiles for Image and Texture Generation"
 *   Cohen, Shade, Hiller, Deussen; SIGGRAPH 2003
 *
 * ── Core Algorithm ───────────────────────────────────────────────────────
 *
 *  Section 3.2 describes assembling each tile from four "diamond-shaped"
 *  sample patches — one per edge colour.  With 2 horizontal colours (H0, H1)
 *  and 2 vertical colours (V0, V1), four samples suffice for all 16 tiles.
 *
 *  The key observations from the paper:
 *    1. Every tile whose N-edge has colour k uses H[k] as its north content,
 *       placed so that H[k][px, 0] fills the tile's top row.
 *    2. The S-edge sample H[k] is placed "upside-down": H[k][px, T-1-py]
 *       so that H[k][px, 0] also fills the tile's bottom row.
 *    3. W-edge sample V[k] is placed normally (V[k][0, py] fills left col).
 *       E-edge sample V[k] is mirrored: V[k][T-1-px, py] so V[k][0, py]
 *       fills the right column too.
 *
 *  This is the "lower diagonal part for top, upper diagonal part for bottom"
 *  from Figure 4 of the paper.  Using opposite halves for N vs S (and W vs E)
 *  guarantees that all tiles sharing an edge colour carry identical pixel
 *  content at that edge → perfect seamlessness.
 *
 *  Four internal seams (TL-corner→centre, TR→centre, BL→centre, BR→centre)
 *  are found by the Efros & Freeman (2001) DP quilting algorithm: a path
 *  from the tile corner to the tile centre that minimises the squared-colour-
 *  difference between the two meeting samples.  A thin soft-blend zone
 *  straddles each seam.
 *
 *  Sample positions are optimised by coordinate-descent: for each of the four
 *  samples, OPT_TRIES random positions within a dedicated source zone are
 *  tried; the best (lowest total seam error) is kept.
 *
 * ── Seamlessness guarantee ───────────────────────────────────────────────
 *
 *  At every tile boundary the content is determined solely by the H or V
 *  sample for that edge colour:
 *    Top row    (py=0)  : H[c_N][px, 0]         — identical for all tiles with same c_N
 *    Bottom row (py=T-1): H[c_S][px, 0]          — same (row 0) via vertical flip
 *    Left col   (px=0)  : V[c_W][0, py]          — identical for all tiles with same c_W
 *    Right col  (px=T-1): V[c_E][0, py]          — same (col 0) via horizontal flip
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *
 *   node tools/wang-tiles/generate-cohen5.mjs <inputPath> <outputDir> [tileSize]
 *
 *   Example:
 *     node tools/wang-tiles/generate-cohen5.mjs \
 *       public/assets/tiles/tile_grass.png \
 *       public/assets/tiles/ 192
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// ── Tunables ─────────────────────────────────────────────────────────────
const OPT_ROUNDS   = 4;   // coordinate-descent rounds for sample optimisation
const OPT_TRIES    = 32;  // random candidate positions per sample per round
const SEAM_FEATHER = 4;   // soft-blend half-width at seam cuts (pixels)

// ── Helpers ───────────────────────────────────────────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Simple xorshift32 PRNG. */
function makePrng(seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Deterministic seed from a string. */
function strSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// ── Source pixel access ───────────────────────────────────────────────────

/** Squared RGB difference between two source pixels (coords clamped). */
function pixDiff2(buf, srcW, srcH, x1, y1, x2, y2) {
  const xi1 = clamp(x1, 0, srcW - 1), yi1 = clamp(y1, 0, srcH - 1);
  const xi2 = clamp(x2, 0, srcW - 1), yi2 = clamp(y2, 0, srcH - 1);
  const i1 = (yi1 * srcW + xi1) * 4;
  const i2 = (yi2 * srcW + xi2) * 4;
  const dr = buf[i1]     - buf[i2];
  const dg = buf[i1 + 1] - buf[i2 + 1];
  const db = buf[i1 + 2] - buf[i2 + 2];
  return dr * dr + dg * dg + db * db;
}

/** Get one channel of source pixel (clamped). */
function srcCh(buf, srcW, srcH, x, y, c) {
  return buf[(clamp(y, 0, srcH - 1) * srcW + clamp(x, 0, srcW - 1)) * 4 + c];
}

// ── Sample content accessors ──────────────────────────────────────────────
//
// A "sample" is identified by its top-left source offset (sx, sy).
// Four orientations guarantee edge seamlessness:
//
//   N (north/top):    src[sx+px,     sy+py]        standard
//   S (south/bottom): src[sx+px,     sy+T-1-py]    vertical flip
//   W (west/left):    src[sx+px,     sy+py]        standard
//   E (east/right):   src[sx+T-1-px, sy+py]        horizontal flip
//
// Result: at any tile edge, only one sample and one fixed row/column is
// accessed — the same for every tile sharing that edge colour.

function getNch(buf, srcW, srcH, sx, sy, px, py, c) {
  return srcCh(buf, srcW, srcH, sx + px, sy + py, c);
}
function getSch(buf, srcW, srcH, sx, sy, px, py, T, c) {
  return srcCh(buf, srcW, srcH, sx + px, sy + T - 1 - py, c);
}
function getWch(buf, srcW, srcH, sx, sy, px, py, c) {
  return srcCh(buf, srcW, srcH, sx + px, sy + py, c);
}
function getEch(buf, srcW, srcH, sx, sy, px, py, T, c) {
  return srcCh(buf, srcW, srcH, sx + T - 1 - px, sy + py, c);
}

// ── Diagonal seam DP ──────────────────────────────────────────────────────
//
// Finds the minimum-cost path from (primary=0, secondary=0) to
// (primary=n-1, secondary=n-1) in an n×n grid.
//
// At each primary step, secondary may change by ±1.  "Reachability bounds"
// on secondary ensure the path can always reach (n-1, n-1).
//
// costFn(p, s) → cost at grid position (p, s).
//
// Returns Int16Array[n]: seam[p] = secondary value at primary p.
//   secondary < seam[p]  → sampleA territory
//   secondary ≥ seam[p]  → sampleB territory
//
function computeDiagSeam(n, costFn) {
  const dp    = new Float64Array(n).fill(Infinity);
  const trace = new Int16Array(n * n);

  dp[0] = costFn(0, 0);   // force start at secondary = 0

  for (let p = 1; p < n; p++) {
    const sMin = Math.max(0, 2 * p - (n - 1));
    const sMax = Math.min(n - 1, p);
    const newDp = new Float64Array(n).fill(Infinity);

    for (let s = sMin; s <= sMax; s++) {
      let best = Infinity, bestPrev = s;
      for (let ds = -1; ds <= 1; ds++) {
        const prev = s + ds;
        if (prev >= 0 && prev < n && dp[prev] < best) {
          best = dp[prev];
          bestPrev = prev;
        }
      }
      if (best < Infinity) {
        newDp[s] = costFn(p, s) + best;
        trace[p * n + s] = bestPrev;
      }
    }

    for (let s = 0; s < n; s++) dp[s] = newDp[s];
  }

  // Traceback: path must end at secondary = n-1
  const seam = new Int16Array(n);
  let s = n - 1;
  for (let p = n - 1; p >= 0; p--) {
    seam[p] = s;
    if (p > 0) s = trace[p * n + s];
  }
  return seam;
}

/** Sum of costFn along the seam path (= total colour-mismatch at the cut). */
function seamPathCost(n, costFn, seam) {
  let total = 0;
  for (let p = 0; p < n; p++) total += costFn(p, seam[p]);
  return total;
}

// ── Sample set evaluation ─────────────────────────────────────────────────
//
// offsets = [[sx,sy] × 4]:  [0]=H0, [1]=H1, [2]=V0, [3]=V1
//
// Edge colour convention: c_N = tl^tr, c_E = tr^br, c_S = br^bl, c_W = bl^tl
//   H[c_N] = offsets[c_N],  V[c_E] = offsets[2+c_E],  etc.
//
// Total seam error across all 16 tiles × 4 seams, computed via the 16 unique
// (sampleA, sampleB) seam pairs (each weighted ×4 since 4 tiles share it).
//
function evalSampleSet(buf, srcW, srcH, T, offsets) {
  const n = T >> 1;
  let total = 0;

  for (let cN = 0; cN < 2; cN++) {
    const [sNx, sNy] = offsets[cN];
    for (let cW = 0; cW < 2; cW++) {
      const [sWx, sWy] = offsets[2 + cW];
      // TL seam: H[cN](standard) vs V[cW](standard), column-parameterised
      const costTL = (col, row) =>
        pixDiff2(buf, srcW, srcH, sNx + col, sNy + row, sWx + col, sWy + row);
      total += seamPathCost(n, costTL, computeDiagSeam(n, costTL)) * 4;
    }
    for (let cE = 0; cE < 2; cE++) {
      const [sEx, sEy] = offsets[2 + cE];
      // TR seam: H[cN] vs V[cE](h-flipped); primary = colFromRight = T-1-px
      const costTR = (cfr, row) =>
        pixDiff2(buf, srcW, srcH, sNx + T - 1 - cfr, sNy + row, sEx + cfr, sEy + row);
      total += seamPathCost(n, costTR, computeDiagSeam(n, costTR)) * 4;
    }
  }

  for (let cW = 0; cW < 2; cW++) {
    const [sWx, sWy] = offsets[2 + cW];
    for (let cS = 0; cS < 2; cS++) {
      const [sSx, sSy] = offsets[cS];
      // BL seam: V[cW] vs H[cS](v-flipped); primary = rowFromBottom = T-1-py
      const costBL = (rfb, col) =>
        pixDiff2(buf, srcW, srcH, sWx + col, sWy + T - 1 - rfb, sSx + col, sSy + rfb);
      total += seamPathCost(n, costBL, computeDiagSeam(n, costBL)) * 4;
    }
  }

  for (let cS = 0; cS < 2; cS++) {
    const [sSx, sSy] = offsets[cS];
    for (let cE = 0; cE < 2; cE++) {
      const [sEx, sEy] = offsets[2 + cE];
      // BR seam: H[cS](v-flipped) vs V[cE](h-flipped)
      // primary=rowFromBottom, secondary=colFromRight
      const costBR = (rfb, cfr) =>
        pixDiff2(buf, srcW, srcH,
          sSx + T - 1 - cfr, sSy + rfb,
          sEx + cfr, sEy + T - 1 - rfb);
      total += seamPathCost(n, costBR, computeDiagSeam(n, costBR)) * 4;
    }
  }

  return total;
}

// ── Sample optimisation ───────────────────────────────────────────────────
//
// Coordinate-descent: for each of the 4 samples, try OPT_TRIES random
// positions within a dedicated source zone per round; keep the best.
//
// Zones ensure visual variety across samples:
//   H0 → top source region    H1 → bottom
//   V0 → left source region   V1 → right
//
function optimiseSamples(buf, srcW, srcH, T, rng) {
  const maxX = srcW - T;
  const maxY = srcH - T;

  if (maxX < 0 || maxY < 0) {
    console.warn('  Source smaller than tileSize — using origin for all samples.');
    return [[0, 0], [0, 0], [0, 0], [0, 0]];
  }

  const midX = Math.floor(maxX / 2);
  const midY = Math.floor(maxY / 2);

  const zones = [
    [0, maxX, 0,    midY],   // H0: top half
    [0, maxX, midY, maxY],   // H1: bottom half
    [0,    midX, 0, maxY],   // V0: left half
    [midX, maxX, 0, maxY],   // V1: right half
  ];

  // Start at zone centres
  const offsets = zones.map(([xLo, xHi, yLo, yHi]) => [
    Math.floor((xLo + xHi) / 2),
    Math.floor((yLo + yHi) / 2),
  ]);

  let bestCost = evalSampleSet(buf, srcW, srcH, T, offsets);
  console.log(`  Initial seam cost: ${bestCost.toFixed(0)}`);

  for (let round = 0; round < OPT_ROUNDS; round++) {
    for (let si = 0; si < 4; si++) {
      const [xLo, xHi, yLo, yHi] = zones[si];
      for (let t = 0; t < OPT_TRIES; t++) {
        const sx = xLo + Math.floor(rng() * (xHi - xLo + 1));
        const sy = yLo + Math.floor(rng() * (yHi - yLo + 1));
        const cand = offsets.map(o => [...o]);
        cand[si] = [clamp(sx, 0, maxX), clamp(sy, 0, maxY)];
        const cost = evalSampleSet(buf, srcW, srcH, T, cand);
        if (cost < bestCost) {
          bestCost = cost;
          offsets[si] = cand[si];
        }
      }
    }
    console.log(`  Round ${round + 1} seam cost: ${bestCost.toFixed(0)}`);
  }

  return offsets;
}

// ── Tile assembly ─────────────────────────────────────────────────────────
//
// Assembles one T×T tile from 4 samples and 4 precomputed seam paths.
//
// Quadrant layout (using halfT = T/2):
//
//   TL [px<halfT, py<halfT]:  seamTL[px]    separates N (py<seam) from W (py≥seam)
//   TR [px≥halfT, py<halfT]:  seamTR[T-1-px] separates N (py<seam) from E (py≥seam)
//   BL [px<halfT, py≥halfT]:  seamBL[T-1-py] separates W (px<seam) from S (px≥seam)
//   BR [px≥halfT, py≥halfT]:  seamBR[T-1-py] separates S (T-1-px≥seam) from E (T-1-px<seam)
//
// SEAM_FEATHER pixels either side of each seam are softly blended to hide
// any residual colour mismatch at the cut.
//
function assembleTile(buf, srcW, srcH, T,
                      sNx, sNy, sEx, sEy, sSx, sSy, sWx, sWy,
                      seamTL, seamTR, seamBL, seamBR) {
  const halfT  = T >> 1;
  const F      = SEAM_FEATHER;
  const outBuf = Buffer.alloc(T * T * 4);

  for (let py = 0; py < T; py++) {
    for (let px = 0; px < T; px++) {
      let r = 0, g = 0, b = 0;

      // ── Tile boundary rows/columns: force pure content ────────────────
      // The seamlessness proof requires the four edges to sample exactly
      // the same source pixels for all tiles sharing that edge colour.
      // Any feather blending at boundary pixels would mix in a neighbouring
      // sample and break the match.  Edges take absolute priority.
      if (py === 0) {
        // Top edge: pure N — H[c_N][px, 0]
        r = getNch(buf, srcW, srcH, sNx, sNy, px, py, 0);
        g = getNch(buf, srcW, srcH, sNx, sNy, px, py, 1);
        b = getNch(buf, srcW, srcH, sNx, sNy, px, py, 2);
        const o0 = (py * T + px) * 4;
        outBuf[o0] = r; outBuf[o0+1] = g; outBuf[o0+2] = b; outBuf[o0+3] = 255;
        continue;
      }
      if (py === T - 1) {
        // Bottom edge: pure S — H[c_S][px, 0] via vertical flip
        r = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 0);
        g = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 1);
        b = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 2);
        const oTm1 = (py * T + px) * 4;
        outBuf[oTm1] = r; outBuf[oTm1+1] = g; outBuf[oTm1+2] = b; outBuf[oTm1+3] = 255;
        continue;
      }
      if (px === 0) {
        // Left edge: pure W — V[c_W][0, py]
        r = getWch(buf, srcW, srcH, sWx, sWy, px, py, 0);
        g = getWch(buf, srcW, srcH, sWx, sWy, px, py, 1);
        b = getWch(buf, srcW, srcH, sWx, sWy, px, py, 2);
        const o0l = (py * T + px) * 4;
        outBuf[o0l] = r; outBuf[o0l+1] = g; outBuf[o0l+2] = b; outBuf[o0l+3] = 255;
        continue;
      }
      if (px === T - 1) {
        // Right edge: pure E — V[c_E][0, py] via horizontal flip
        r = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 0);
        g = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 1);
        b = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 2);
        const o0r = (py * T + px) * 4;
        outBuf[o0r] = r; outBuf[o0r+1] = g; outBuf[o0r+2] = b; outBuf[o0r+3] = 255;
        continue;
      }

      if (py < halfT) {
        if (px < halfT) {
          // ── TL: N above seam, W below ──────────────────────────────
          const sy = seamTL[px];
          const d  = py - sy;
          if (d < -F) {
            r = getNch(buf, srcW, srcH, sNx, sNy, px, py, 0);
            g = getNch(buf, srcW, srcH, sNx, sNy, px, py, 1);
            b = getNch(buf, srcW, srcH, sNx, sNy, px, py, 2);
          } else if (d > F) {
            r = getWch(buf, srcW, srcH, sWx, sWy, px, py, 0);
            g = getWch(buf, srcW, srcH, sWx, sWy, px, py, 1);
            b = getWch(buf, srcW, srcH, sWx, sWy, px, py, 2);
          } else {
            const t = (d + F) / (2 * F + 1);   // 0 → N, 1 → W
            for (let c = 0; c < 3; c++) {
              const v = Math.round(
                getNch(buf, srcW, srcH, sNx, sNy, px, py, c) * (1 - t) +
                getWch(buf, srcW, srcH, sWx, sWy, px, py, c) * t);
              if (c === 0) r = v; else if (c === 1) g = v; else b = v;
            }
          }

        } else {
          // ── TR: N above seam, E below ──────────────────────────────
          const cfr = T - 1 - px;       // column-from-right index
          const sy  = seamTR[cfr];
          const d   = py - sy;
          if (d < -F) {
            r = getNch(buf, srcW, srcH, sNx, sNy, px, py, 0);
            g = getNch(buf, srcW, srcH, sNx, sNy, px, py, 1);
            b = getNch(buf, srcW, srcH, sNx, sNy, px, py, 2);
          } else if (d > F) {
            r = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 0);
            g = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 1);
            b = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 2);
          } else {
            const t = (d + F) / (2 * F + 1);
            for (let c = 0; c < 3; c++) {
              const v = Math.round(
                getNch(buf, srcW, srcH, sNx, sNy, px, py, c) * (1 - t) +
                getEch(buf, srcW, srcH, sEx, sEy, px, py, T, c) * t);
              if (c === 0) r = v; else if (c === 1) g = v; else b = v;
            }
          }
        }

      } else {
        if (px < halfT) {
          // ── BL: W left of seam, S right of seam ───────────────────
          const rfb = T - 1 - py;       // row-from-bottom index
          const sx  = seamBL[rfb];
          const d   = px - sx;          // negative → W side, positive → S side
          if (d < -F) {
            r = getWch(buf, srcW, srcH, sWx, sWy, px, py, 0);
            g = getWch(buf, srcW, srcH, sWx, sWy, px, py, 1);
            b = getWch(buf, srcW, srcH, sWx, sWy, px, py, 2);
          } else if (d > F) {
            r = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 0);
            g = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 1);
            b = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 2);
          } else {
            const t = (d + F) / (2 * F + 1);   // 0 → W, 1 → S
            for (let c = 0; c < 3; c++) {
              const v = Math.round(
                getWch(buf, srcW, srcH, sWx, sWy, px, py, c) * (1 - t) +
                getSch(buf, srcW, srcH, sSx, sSy, px, py, T, c) * t);
              if (c === 0) r = v; else if (c === 1) g = v; else b = v;
            }
          }

        } else {
          // ── BR: S where cfr≥seam, E where cfr<seam ────────────────
          const rfb = T - 1 - py;
          const cfr = T - 1 - px;       // column-from-right index
          const sc  = seamBR[rfb];
          const d   = cfr - sc;         // positive → S side (cfr≥seam), negative → E
          if (d > F) {
            r = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 0);
            g = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 1);
            b = getSch(buf, srcW, srcH, sSx, sSy, px, py, T, 2);
          } else if (d < -F) {
            r = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 0);
            g = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 1);
            b = getEch(buf, srcW, srcH, sEx, sEy, px, py, T, 2);
          } else {
            // d close to 0: blend S (d>0) and E (d<0)
            const t = (F - d) / (2 * F + 1);   // 0 → S (d≥0), 1 → E (d≤0)
            for (let c = 0; c < 3; c++) {
              const v = Math.round(
                getSch(buf, srcW, srcH, sSx, sSy, px, py, T, c) * (1 - t) +
                getEch(buf, srcW, srcH, sEx, sEy, px, py, T, c) * t);
              if (c === 0) r = v; else if (c === 1) g = v; else b = v;
            }
          }
        }
      }

      const o = (py * T + px) * 4;
      outBuf[o] = r; outBuf[o + 1] = g; outBuf[o + 2] = b; outBuf[o + 3] = 255;
    }
  }

  return outBuf;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate-cohen5.mjs <inputPath> <outputDir> [tileSize]');
    process.exit(1);
  }

  const inputPath = args[0];
  const outputDir = args[1];
  const T         = parseInt(args[2], 10) || 192;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }
  if (T % 2 !== 0) {
    console.error('tileSize must be even.');
    process.exit(1);
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wangDir  = path.join(outputDir, `${baseName}_wang`);
  ensureDir(wangDir);

  // ── Load source ────────────────────────────────────────────────────────
  const meta = await sharp(inputPath).metadata();
  const srcW = meta.width, srcH = meta.height;
  if (!srcW || !srcH) { console.error('Cannot read image metadata.'); process.exit(1); }

  const { data: buf } = await sharp(inputPath)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  console.log(`\nCohen et al. (2003) Diamond-Sample Quilting — v5`);
  console.log(`  Source:    ${inputPath}  (${srcW}×${srcH})`);
  console.log(`  Tile size: ${T}px  (halfT=${T >> 1})`);
  console.log(`  Feather:   ${SEAM_FEATHER}px soft-blend at seams`);
  console.log(`  Output:    ${wangDir}/`);
  console.log(`\nOptimising sample positions (${OPT_ROUNDS} rounds × ${OPT_TRIES} tries each)...`);

  const rng     = makePrng(strSeed(baseName));
  const offsets = optimiseSamples(buf, srcW, srcH, T, rng);

  console.log('\nSample offsets:');
  ['H0 (N-edge colour 0)', 'H1 (N-edge colour 1)',
   'V0 (W-edge colour 0)', 'V1 (W-edge colour 1)'].forEach((name, i) =>
    console.log(`  ${name}: source (${offsets[i][0]}, ${offsets[i][1]})`));

  // ── Precompute the 16 unique diagonal seams ────────────────────────────
  //
  // 4 seam types × 4 (colourA, colourB) combos = 16 unique seams.
  // seamsTL[cN][cW], seamsTR[cN][cE], seamsBL[cW][cS], seamsBR[cS][cE]
  //
  console.log('\nComputing 16 seam paths...');
  const n = T >> 1;

  const seamsTL = [[null, null], [null, null]];
  const seamsTR = [[null, null], [null, null]];
  const seamsBL = [[null, null], [null, null]];
  const seamsBR = [[null, null], [null, null]];

  for (let cN = 0; cN < 2; cN++) {
    const [sNx, sNy] = offsets[cN];
    for (let cW = 0; cW < 2; cW++) {
      const [sWx, sWy] = offsets[2 + cW];
      seamsTL[cN][cW] = computeDiagSeam(n,
        (col, row) => pixDiff2(buf, srcW, srcH, sNx + col, sNy + row, sWx + col, sWy + row));
    }
    for (let cE = 0; cE < 2; cE++) {
      const [sEx, sEy] = offsets[2 + cE];
      seamsTR[cN][cE] = computeDiagSeam(n,
        (cfr, row) => pixDiff2(buf, srcW, srcH,
          sNx + T - 1 - cfr, sNy + row, sEx + cfr, sEy + row));
    }
  }
  for (let cW = 0; cW < 2; cW++) {
    const [sWx, sWy] = offsets[2 + cW];
    for (let cS = 0; cS < 2; cS++) {
      const [sSx, sSy] = offsets[cS];
      seamsBL[cW][cS] = computeDiagSeam(n,
        (rfb, col) => pixDiff2(buf, srcW, srcH,
          sWx + col, sWy + T - 1 - rfb, sSx + col, sSy + rfb));
    }
  }
  for (let cS = 0; cS < 2; cS++) {
    const [sSx, sSy] = offsets[cS];
    for (let cE = 0; cE < 2; cE++) {
      const [sEx, sEy] = offsets[2 + cE];
      seamsBR[cS][cE] = computeDiagSeam(n,
        (rfb, cfr) => pixDiff2(buf, srcW, srcH,
          sSx + T - 1 - cfr, sSy + rfb,
          sEx + cfr, sEy + T - 1 - rfb));
    }
  }
  console.log('  Done ✓');

  // ── Generate 16 tiles ──────────────────────────────────────────────────
  console.log('\nAssembling tiles...');

  for (let tIdx = 0; tIdx < 16; tIdx++) {
    const tl = (tIdx >> 3) & 1;
    const tr = (tIdx >> 2) & 1;
    const br = (tIdx >> 1) & 1;
    const bl =  tIdx       & 1;

    // XOR edge colours
    const cN = tl ^ tr;
    const cE = tr ^ br;
    const cS = br ^ bl;
    const cW = bl ^ tl;

    const [sNx, sNy] = offsets[cN];
    const [sEx, sEy] = offsets[2 + cE];
    const [sSx, sSy] = offsets[cS];
    const [sWx, sWy] = offsets[2 + cW];

    const pixels = assembleTile(
      buf, srcW, srcH, T,
      sNx, sNy, sEx, sEy, sSx, sSy, sWx, sWy,
      seamsTL[cN][cW], seamsTR[cN][cE],
      seamsBL[cW][cS], seamsBR[cS][cE]);

    const outPath = path.join(wangDir, `wang_${tIdx}.png`);
    await sharp(pixels, { raw: { width: T, height: T, channels: 4 } })
      .png().toFile(outPath);

    console.log(`  wang_${tIdx}.png  corners=(${tl}${tr}${br}${bl})  edges cN=${cN} cE=${cE} cS=${cS} cW=${cW}`);
  }

  console.log(`\n✓  16 tiles written to ${wangDir}/\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
