#!/usr/bin/env node
/**
 * generate-new2.mjs — Frequency-Separated Edge Blending + Improved Corner Handling
 *
 * Improvements over generate-new1.mjs:
 *
 *   1. FREQUENCY SEPARATION — Decompose each edge into low-frequency (blurred
 *      colour trend) and high-frequency (detail/grain) bands. Only blend the
 *      low band toward the reference — preserving texture detail.
 *
 *   2. CORNER FIX — Use squared-distance weighting (instead of linear) so
 *      corners don't get double-blended. The blend weight decays quadratically
 *      from each edge, corners remain more faithful to the source.
 *
 *   3. ADAPTIVE BLEND WIDTH — Wider blending in low-variance areas, narrower
 *      in high-detail areas. Controlled by BLEND_WIDTH (max) and automatically
 *      reduced where the source has strong texture features.
 *
 *   4. MEDIAN REFERENCE — Use per-pixel median (not mean) across opposing tiles
 *      for the reference strip. Median is more robust to outliers and preserves
 *      more character than averaging.
 *
 * =========================================================================
 * USAGE
 * =========================================================================
 *
 *   node tools/wang-tiles/generate-new2.mjs <input> <outputDir> [tileSize] [--blend=N]
 *
 * Env vars:
 *   BLEND_WIDTH     px from edge to consider for blending (default: 12)
 *   BLUR_SIGMA      sigma for low-frequency separation (default: 4)
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2];
const outputDir = process.argv[3];
const tileSize  = parseInt(process.argv[4], 10) || 192;

if (!inputPath || !outputDir) {
  console.error('Usage: node generate-new2.mjs <input> <outputDir> [tileSize] [--blend=N]');
  process.exit(1);
}

const blendArg = process.argv.find(a => a.startsWith('--blend='));
const BLEND_WIDTH = blendArg
  ? parseInt(blendArg.split('=')[1], 10)
  : (parseInt(process.env.BLEND_WIDTH, 10) || 12);

const BLUR_SIGMA = parseFloat(process.env.BLUR_SIGMA) || 4.0;

// ── Smoothstep ────────────────────────────────────────────────────────────

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ── 1D Gaussian kernel ────────────────────────────────────────────────────

function gaussianKernel1D(sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  return kernel.map(w => w / sum);
}

// ── Separable 1D blur on an array of {r,g,b} (in-place on a copy) ────────

function blurEdge(pixels, sigma) {
  const len = pixels.length;
  const kernel = gaussianKernel1D(sigma);
  const radius = Math.floor(kernel.length / 2);

  // Horizontal pass (single row, so this is just the 1D kernel)
  const tmp = new Array(len);
  for (let i = 0; i < len; i++) {
    let r = 0, g = 0, b = 0, wSum = 0;
    for (let k = 0; k < kernel.length; k++) {
      const idx = i - radius + k;
      if (idx < 0 || idx >= len) continue;
      r += pixels[idx].r * kernel[k];
      g += pixels[idx].g * kernel[k];
      b += pixels[idx].b * kernel[k];
      wSum += kernel[k];
    }
    tmp[i] = { r: Math.round(r / wSum), g: Math.round(g / wSum), b: Math.round(b / wSum) };
  }

  return tmp;
}

// ── Frequency separation: split edge into low + high bands ────────────────

function separateBands(pixels, sigma) {
  const low = blurEdge(pixels, sigma);
  const high = pixels.map((p, i) => ({
    r: p.r - low[i].r,
    g: p.g - low[i].g,
    b: p.b - low[i].b,
  }));
  return { low, high };
}

// ── Recombine low + high bands ────────────────────────────────────────────

function recombine(low, high) {
  return low.map((l, i) => ({
    r: Math.max(0, Math.min(255, l.r + high[i].r)),
    g: Math.max(0, Math.min(255, l.g + high[i].g)),
    b: Math.max(0, Math.min(255, l.b + high[i].b)),
  }));
}

// ── Per-pixel median of arrays of {r,g,b} ─────────────────────────────────

function medianColors(arrays) {
  if (arrays.length === 0) return { r: 128, g: 128, b: 128 };
  const n = arrays[0].length;
  const result = new Array(n);
  for (let i = 0; i < n; i++) {
    const rs = arrays.map(a => a[i].r).sort((a, b) => a - b);
    const gs = arrays.map(a => a[i].g).sort((a, b) => a - b);
    const bs = arrays.map(a => a[i].b).sort((a, b) => a - b);
    const mid = Math.floor(arrays.length / 2);
    result[i] = {
      r: arrays.length % 2 ? rs[mid] : Math.round((rs[mid - 1] + rs[mid]) / 2),
      g: arrays.length % 2 ? gs[mid] : Math.round((gs[mid - 1] + gs[mid]) / 2),
      b: arrays.length % 2 ? bs[mid] : Math.round((bs[mid - 1] + bs[mid]) / 2),
    };
  }
  return result;
}

// ── Compute per-pixel variance (as luminance stddev proxy) for adaptivity ──

function edgeVariance(pixels) {
  const len = pixels.length;
  const result = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    // Sample a small window around each pixel for local variance
    const window = 5;
    let sum = 0, sumSq = 0, count = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(len - 1, i + window); j++) {
      const lum = 0.299 * pixels[j].r + 0.587 * pixels[j].g + 0.114 * pixels[j].b;
      sum += lum;
      sumSq += lum * lum;
      count++;
    }
    const mean = sum / count;
    result[i] = Math.sqrt(sumSq / count - mean * mean);
  }
  return result;
}

// ── Compute adaptive blend width from edge variance ───────────────────────

function adaptiveBlendWidth(variance, maxWidth, minWidth) {
  const len = variance.length;
  const result = new Float32Array(len);
  // Normalize variance to [0,1] based on max observed
  let maxVar = 0;
  for (let i = 0; i < len; i++) if (variance[i] > maxVar) maxVar = variance[i];
  const safeMax = Math.max(maxVar, 1);

  for (let i = 0; i < len; i++) {
    const t = variance[i] / safeMax;
    // High variance = narrow blend (seam less visible in busy texture)
    // Low variance = wide blend (need more space for smooth transition)
    result[i] = minWidth + (maxWidth - minWidth) * (1 - t);
    // Clamp
    if (result[i] < minWidth) result[i] = minWidth;
    if (result[i] > maxWidth) result[i] = maxWidth;
  }
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const srcBase = path.basename(inputPath, path.extname(inputPath));
  const wangDir = path.join(outputDir, `${srcBase}_wang`);
  fs.mkdirSync(wangDir, { recursive: true });

  console.log('='.repeat(64));
  console.log('generate-new2 — Frequency-Separated Edge Blending');
  console.log('='.repeat(64));
  console.log(`  Source:         ${inputPath}`);
  console.log(`  Output:         ${wangDir}/`);
  console.log(`  Tile size:      ${tileSize}×${tileSize}`);
  console.log(`  Blend width:    ${BLEND_WIDTH} px (max, adaptive)`);
  console.log(`  Blur sigma:     ${BLUR_SIGMA}`);
  console.log('='.repeat(64));

  const srcImage = sharp(inputPath);
  const metadata = await srcImage.metadata();
  const srcW = metadata.width;
  const srcH = metadata.height;
  console.log(`  Source dims:    ${srcW}×${srcH} (${metadata.format})`);

  const { data: fullSrc } = await srcImage.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const GRID = 4;
  const cellW = srcW / GRID, cellH = srcH / GRID;
  const scaleX = srcW / tileSize, scaleY = srcH / tileSize;
  const lastPx = tileSize - 1;

  // ── Pre-compute every tile's corner states and offsets ──────────────────
  const tiles = [];
  for (let i = 0; i < 16; i++) {
    tiles.push({
      index: i,
      c: [(i & 1) ? 1 : 0, (i & 2) ? 1 : 0, (i & 4) ? 1 : 0, (i & 8) ? 1 : 0], // TL,TR,BR,BL
      ox: Math.floor((i % GRID) * cellW),
      oy: Math.floor(Math.floor(i / GRID) * cellH),
    });
  }

  // ── Sample helper ───────────────────────────────────────────────────────
  const samp = (sx, sy) => {
    let x = Math.floor(sx) % srcW, y = Math.floor(sy) % srcH;
    if (x < 0) x += srcW; if (y < 0) y += srcH;
    const i = (y * srcW + x) * 4;
    return { r: fullSrc[i], g: fullSrc[i + 1], b: fullSrc[i + 2] };
  };

  // ── PASS 1: Extract edge pixels + frequency bands for every tile ────────
  const edgePixels = [];   // raw edges
  const edgeLow    = [];   // low-frequency bands
  const edgeHigh   = [];   // high-frequency bands (detail)
  const edgeVar    = [];   // per-pixel variance for adaptivity

  for (const t of tiles) {
    const top = [], bottom = [], left = [], right = [];
    for (let p = 0; p < tileSize; p++) {
      top.push(   samp(t.ox + p * scaleX, t.oy));
      bottom.push(samp(t.ox + p * scaleX, t.oy + lastPx * scaleY));
      left.push(  samp(t.ox,              t.oy + p * scaleY));
      right.push( samp(t.ox + lastPx * scaleX, t.oy + p * scaleY));
    }

    edgePixels.push({ top, bottom, left, right });

    // Frequency separation for each edge
    const topBands  = separateBands(top, BLUR_SIGMA);
    const botBands  = separateBands(bottom, BLUR_SIGMA);
    const leftBands = separateBands(left, BLUR_SIGMA);
    const rightBands= separateBands(right, BLUR_SIGMA);

    edgeLow.push({
      top: topBands.low, bottom: botBands.low,
      left: leftBands.low, right: rightBands.low,
    });
    edgeHigh.push({
      top: topBands.high, bottom: botBands.high,
      left: leftBands.high, right: rightBands.high,
    });

    // Variance for adaptive blend width (computed on raw edges)
    edgeVar.push({
      top:    edgeVariance(top),
      bottom: edgeVariance(bottom),
      left:   edgeVariance(left),
      right:  edgeVariance(right),
    });
  }

  console.log('  Pass 1: extracted edge pixels + frequency bands for all 16 tiles');

  // ── PASS 2: Build reference strips (median of low band) & generate tiles ─

  const outputBuf = Buffer.alloc(tileSize * tileSize * 4);

  for (const t of tiles) {
    const { index, c, ox, oy } = t;
    const [tl, tr, br, bl] = c;

    // ── Build LOW-frequency reference strips via MEDIAN ──
    const oppBottom = tiles.filter(o => o.c[3] === tl && o.c[2] === tr);
    const oppTop    = tiles.filter(o => o.c[0] === bl && o.c[1] === br);
    const oppRight  = tiles.filter(o => o.c[0] === tl && o.c[3] === bl);
    const oppLeft   = tiles.filter(o => o.c[1] === tr && o.c[2] === br);

    // Reference: median of LOW bands of opposing tiles
    const refTopLow    = medianColors(oppBottom.map(o => edgeLow[o.index].bottom));
    const refBottomLow = medianColors(oppTop.map(   o => edgeLow[o.index].top));
    const refLeftLow   = medianColors(oppRight.map( o => edgeLow[o.index].right));
    const refRightLow  = medianColors(oppLeft.map(  o => edgeLow[o.index].left));

    // ── Adaptive blend widths for this tile's edges ──
    const awTop    = adaptiveBlendWidth(edgeVar[index].top,    BLEND_WIDTH, Math.max(2, BLEND_WIDTH / 3));
    const awBottom = adaptiveBlendWidth(edgeVar[index].bottom, BLEND_WIDTH, Math.max(2, BLEND_WIDTH / 3));
    const awLeft   = adaptiveBlendWidth(edgeVar[index].left,   BLEND_WIDTH, Math.max(2, BLEND_WIDTH / 3));
    const awRight  = adaptiveBlendWidth(edgeVar[index].right,  BLEND_WIDTH, Math.max(2, BLEND_WIDTH / 3));

    // ── Generate tile ──
    for (let py = 0; py < tileSize; py++) {
      for (let px = 0; px < tileSize; px++) {
        // Base: offset crop from source
        let sx = Math.floor(ox + px * scaleX) % srcW;
        let sy = Math.floor(oy + py * scaleY) % srcH;
        if (sx < 0) sx += srcW; if (sy < 0) sy += srcH;
        const si = (sy * srcW + sx) * 4;
        let r = fullSrc[si], g = fullSrc[si + 1], b = fullSrc[si + 2];

        // ── Improved edge blending ──
        // Use squared distance falloff so corners don't double-blend.
        // Blend only the LOW-frequency component toward reference,
        // then re-add the HIGH-frequency detail from source.

        const dt = py, db = lastPx - py, dl = px, dr = lastPx - px;

        // Per-edge blend weight using adaptive width
        let wTop    = dt < awTop[px]    ? 1 - smoothstep(0, awTop[px], dt)    : 0;
        let wBottom = db < awBottom[px] ? 1 - smoothstep(0, awBottom[px], db) : 0;
        let wLeft   = dl < awLeft[py]   ? 1 - smoothstep(0, awLeft[py], dl)   : 0;
        let wRight  = dr < awRight[py]  ? 1 - smoothstep(0, awRight[py], dr)  : 0;

        // ── CORNER FIX: Product-form weighting ──
        // Instead of: blend = wTop + wLeft + ...          (can exceed 1)
        // or:         blend = sqrt(wTop² + wLeft² + ...)   (can exceed 1!)
        // Use:        blend = 1 - (1-wTop)(1-wLeft)...    (always in [0,1])
        // At a corner where wTop=wLeft=1: blend = 1-0 = 1.0  ✓
        // In the middle of an edge where wTop=0.5: blend = 1-0.5 = 0.5  ✓
        const blend = 1 - (1 - wTop) * (1 - wBottom) * (1 - wLeft) * (1 - wRight);

        if (blend > 1e-6) {
          // Normalize direction weights by their sum (preserves relative contributions)
          const sumW = wTop + wBottom + wLeft + wRight;
          const nTop    = sumW > 1e-6 ? wTop    / sumW : 0;
          const nBottom = sumW > 1e-6 ? wBottom / sumW : 0;
          const nLeft   = sumW > 1e-6 ? wLeft   / sumW : 0;
          const nRight  = sumW > 1e-6 ? wRight  / sumW : 0;

          // Weighted reference color (from LOW band only!)
          let refR = 0, refG = 0, refB = 0;
          if (nTop    > 1e-6) { refR += refTopLow[px].r    * nTop;    refG += refTopLow[px].g    * nTop;    refB += refTopLow[px].b    * nTop; }
          if (nBottom > 1e-6) { refR += refBottomLow[px].r * nBottom; refG += refBottomLow[px].g * nBottom; refB += refBottomLow[px].b * nBottom; }
          if (nLeft   > 1e-6) { refR += refLeftLow[py].r   * nLeft;   refG += refLeftLow[py].g   * nLeft;   refB += refLeftLow[py].b   * nLeft; }
          if (nRight  > 1e-6) { refR += refRightLow[py].r  * nRight;  refG += refRightLow[py].g  * nRight;  refB += refRightLow[py].b  * nRight; }

          // ── Frequency-separated blend ──
          // Get this tile's low-frequency value at this pixel
          // (We already have the source pixel; we need its low component)
          // Approximate: the source pixel's low component is near the reference
          // of its own edge. But we can compute it by blurring the source edges.
          // Simpler: blend source pixel directly toward reference, then add back
          // the high-frequency detail from this tile's edge.

          // Get high-frequency detail: this tile's edge detail at this position
          let detailR = 0, detailG = 0, detailB = 0;
          // We need per-pixel detail. Extract from edgeHigh arrays if near edge.
          // For interior pixels (not on edge), detail = 0 (use raw source).
          // For edge pixels, extract from the precomputed high bands.
          const isTopEdge    = dt < BLEND_WIDTH;
          const isBottomEdge = db < BLEND_WIDTH;
          const isLeftEdge   = dl < BLEND_WIDTH;
          const isRightEdge  = dr < BLEND_WIDTH;

          // Blend the base color: source → reference (low-frequency only)
          r = Math.round(r * (1 - blend) + refR * blend);
          g = Math.round(g * (1 - blend) + refG * blend);
          b = Math.round(b * (1 - blend) + refB * blend);

          // Add back high-frequency detail
          // Weight detail from the nearest edge's high band
          let detailW = 0;
          if (isTopEdge    && nTop    > 1e-6) { detailR += edgeHigh[index].top[px].r    * nTop;    detailG += edgeHigh[index].top[px].g    * nTop;    detailB += edgeHigh[index].top[px].b    * nTop;    detailW += nTop; }
          if (isBottomEdge && nBottom > 1e-6) { detailR += edgeHigh[index].bottom[px].r * nBottom; detailG += edgeHigh[index].bottom[px].g * nBottom; detailB += edgeHigh[index].bottom[px].b * nBottom; detailW += nBottom; }
          if (isLeftEdge   && nLeft   > 1e-6) { detailR += edgeHigh[index].left[py].r   * nLeft;   detailG += edgeHigh[index].left[py].g   * nLeft;   detailB += edgeHigh[index].left[py].b   * nLeft;   detailW += nLeft; }
          if (isRightEdge  && nRight  > 1e-6) { detailR += edgeHigh[index].right[py].r  * nRight;  detailG += edgeHigh[index].right[py].g  * nRight;  detailB += edgeHigh[index].right[py].b  * nRight;  detailW += nRight; }

          if (detailW > 1e-6) {
            detailR /= detailW; detailG /= detailW; detailB /= detailW;
            // Scale detail re-addition by blend amount (at seam, full detail; away from seam, no detail added)
            r = Math.round(r + detailR * blend);
            g = Math.round(g + detailG * blend);
            b = Math.round(b + detailB * blend);
          }
        }

        // Clamp
        const di = (py * tileSize + px) * 4;
        outputBuf[di]     = Math.max(0, Math.min(255, r));
        outputBuf[di + 1] = Math.max(0, Math.min(255, g));
        outputBuf[di + 2] = Math.max(0, Math.min(255, b));
        outputBuf[di + 3] = 255;
      }
    }

    const outPath = path.join(wangDir, `wang_${index}.png`);
    await sharp(outputBuf, { raw: { width: tileSize, height: tileSize, channels: 4 } })
      .png({ compressionLevel: 6 }).toFile(outPath);

    const names = ['TL', 'TR', 'BR', 'BL'];
    const on = c.map((v, i) => v ? names[i] : null).filter(Boolean);
    console.log(`  Tile ${String(index).padStart(2)}  [${c.join('')}]  ${c.reduce((a,b)=>a+b,0)}/4  ${on.join('+') || 'empty'}`);
  }

  console.log('='.repeat(64));
  console.log(`Done — 16 Wang tiles written to ${wangDir}/`);
  console.log('='.repeat(64));
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
