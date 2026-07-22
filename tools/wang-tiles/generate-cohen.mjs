#!/usr/bin/env node
/**
 * Cohen et al. (2003) Wang Tile Generator — Correct Implementation
 *
 * Key insight: there are only 4 HORIZONTAL canonical strips (H[00..11])
 * and 4 VERTICAL canonical strips (V[00..11]).  A tile's top edge and another
 * tile's bottom edge share the SAME H strip whenever their meeting corners
 * match.  The previous implementation used 16 directional strips (separate
 * top/right/bottom/left), which meant tiles with matching color pairs still had
 * different edge pixels — never truly seamless.
 *
 * Algorithm:
 *   Phase 1 — Strip search: find 4 H-strips (rows) and 4 V-strips (columns)
 *             from the source, stratified so all 4 are distinct.  Score: variance.
 *   Phase 2 — Corner consistency: average endpoints of all strips sharing a
 *             corner color; write the canonical corner pixel back.
 *   Phase 3 — Patch search: for each of 16 tiles, find the tileSize×tileSize
 *             source patch whose 4 edges best match the canonical strips (MSE).
 *   Phase 4 — Assembly: copy the patch; for pixels within BLEND px of any tile
 *             edge, smoothstep-blend toward the canonical strip pixel.
 *             "Nearest edge wins" ensures stable corner handling.
 *
 * Seamlessness guarantee:
 *   Matching-edge tiles use the SAME canonical strip.  The outermost pixel is
 *   always exactly that strip's pixel — no arithmetic applied at d=0.
 *
 * Usage:
 *   node tools/wang-tiles/generate-cohen.mjs <inputPath> <outputDir> [tileSize]
 *
 * Example:
 *   node tools/wang-tiles/generate-cohen.mjs public/assets/tiles/tile_grass.png public/assets/tiles/ 192
 */

import sharp from 'sharp';
import fs    from 'node:fs';
import path  from 'node:path';

// ── Tunables ─────────────────────────────────────────────────────────────────
const BLEND  = 20;   // blend-zone width in pixels (capped to tileSize/4 for small tiles)
const STRIDE = 4;    // patch-search stride — higher = faster


// ── Utilities ─────────────────────────────────────────────────────────────────
function ensureDir (dir) { fs.mkdirSync(dir, { recursive: true }); }

/** pair index: (a,b) → 0..3 where a,b ∈ {0,1} */
function pairIdx (a, b) { return (a << 1) | b; }

function clamp (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Smooth Hermite interpolation t∈[0,1] → [0,1] */
function smoothstep (t) { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); }

/** Linear interpolation a→b by t */
function lerp (a, b, t) { return a + (b - a) * t; }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main () {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate-cohen.mjs <inputPath> <outputDir> [tileSize]');
    process.exit(1);
  }

  const inputPath = args[0];
  const outputDir = args[1];
  const tileSize  = parseInt(args[2], 10) || 192;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wangDir  = path.join(outputDir, `${baseName}_wang`);
  ensureDir(wangDir);

  // ── Load source ────────────────────────────────────────────────────────────
  const image  = sharp(inputPath);
  const meta   = await image.metadata();
  const srcW   = meta.width;
  const srcH   = meta.height;

  if (!srcW || !srcH) { console.error('Cannot read image dimensions.'); process.exit(1); }
  if (srcW < tileSize || srcH < tileSize) {
    console.error(`Source (${srcW}x${srcH}) is smaller than tile size (${tileSize}).`);
    process.exit(1);
  }

  const { data: S } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const blend = Math.min(BLEND, Math.floor(tileSize / 4));   // cap for small tiles

  console.log(`\nCohen Wang Tile Generator (correct unified strips)`);
  console.log(`  Source:     ${inputPath}  (${srcW}x${srcH})`);
  console.log(`  Tile size:  ${tileSize}px`);
  console.log(`  Blend zone: ${blend}px`);
  console.log(`  Stride:     ${STRIDE}px`);
  console.log(`  Output:     ${wangDir}/\n`);

  // ── PHASE 1 — Horizontal strip search ─────────────────────────────────────
  //
  // hStrip[p] = canonical row of tileSize RGBA pixels, used as:
  //   - top  edge of any tile whose (TL,TR) corner pair == p
  //   - bottom edge of any tile whose (BL,BR) corner pair == p
  //
  // Four strips, each from a different horizontal band of the source.
  // Columns 0..tileSize-1 are used (source is seamless so x=0 is equivalent
  // to any other starting column).

  console.log('Phase 1: Horizontal strip search (stratified by row band)...');

  const hStrips = Array.from({ length: 4 }, () => new Float32Array(tileSize * 4));
  const hBand   = Math.floor(srcH / 4);

  for (let p = 0; p < 4; p++) {
    const bandStart = p * hBand;
    const bandEnd   = p === 3 ? srcH : bandStart + hBand;

    let bestVar = Infinity;
    let bestRow = bandStart;

    for (let row = bandStart; row < bandEnd; row++) {
      let sr = 0, sg = 0, sb = 0;
      for (let x = 0; x < tileSize; x++) {
        const i = (row * srcW + x) * 4;
        sr += S[i]; sg += S[i + 1]; sb += S[i + 2];
      }
      const mr = sr / tileSize, mg = sg / tileSize, mb = sb / tileSize;
      let v = 0;
      for (let x = 0; x < tileSize; x++) {
        const i = (row * srcW + x) * 4;
        const dr = S[i] - mr, dg = S[i + 1] - mg, db = S[i + 2] - mb;
        v += dr * dr + dg * dg + db * db;
      }
      v /= tileSize;
      if (v < bestVar) { bestVar = v; bestRow = row; }
    }

    for (let x = 0; x < tileSize; x++) {
      const si = (bestRow * srcW + x) * 4;
      const di = x * 4;
      hStrips[p][di]     = S[si];
      hStrips[p][di + 1] = S[si + 1];
      hStrips[p][di + 2] = S[si + 2];
      hStrips[p][di + 3] = 255;
    }
    console.log(`  H[${p}] (${p >> 1}${p & 1}): row ${bestRow}  band ${bandStart}..${bandEnd - 1}  var=${bestVar.toFixed(1)}`);
  }

  // ── PHASE 1b — Vertical strip search ──────────────────────────────────────
  //
  // vStrip[p] = canonical column of tileSize RGBA pixels, used as:
  //   - left  edge of any tile whose (TL,BL) corner pair == p
  //   - right edge of any tile whose (TR,BR) corner pair == p

  console.log('\nPhase 1b: Vertical strip search (stratified by column band)...');

  const vStrips = Array.from({ length: 4 }, () => new Float32Array(tileSize * 4));
  const vBand   = Math.floor(srcW / 4);

  for (let p = 0; p < 4; p++) {
    const bandStart = p * vBand;
    const bandEnd   = p === 3 ? srcW : bandStart + vBand;

    let bestVar = Infinity;
    let bestCol = bandStart;

    for (let col = bandStart; col < bandEnd; col++) {
      let sr = 0, sg = 0, sb = 0;
      for (let y = 0; y < tileSize; y++) {
        const i = (y * srcW + col) * 4;
        sr += S[i]; sg += S[i + 1]; sb += S[i + 2];
      }
      const mr = sr / tileSize, mg = sg / tileSize, mb = sb / tileSize;
      let v = 0;
      for (let y = 0; y < tileSize; y++) {
        const i = (y * srcW + col) * 4;
        const dr = S[i] - mr, dg = S[i + 1] - mg, db = S[i + 2] - mb;
        v += dr * dr + dg * dg + db * db;
      }
      v /= tileSize;
      if (v < bestVar) { bestVar = v; bestCol = col; }
    }

    for (let y = 0; y < tileSize; y++) {
      const si = (y * srcW + bestCol) * 4;
      const di = y * 4;
      vStrips[p][di]     = S[si];
      vStrips[p][di + 1] = S[si + 1];
      vStrips[p][di + 2] = S[si + 2];
      vStrips[p][di + 3] = 255;
    }
    console.log(`  V[${p}] (${p >> 1}${p & 1}): col ${bestCol}  band ${bandStart}..${bandEnd - 1}  var=${bestVar.toFixed(1)}`);
  }

  // ── PHASE 2 — Corner consistency ──────────────────────────────────────────
  //
  // For each corner color c in {0,1}: collect the current pixel value of every
  // strip endpoint that represents "corner color c":
  //   hStrip[p][0]         (x=0)         if (p >> 1) == c
  //   hStrip[p][tileSize-1](x=tileSize-1)if (p & 1)  == c
  //   vStrip[p][0]         (y=0)         if (p >> 1) == c
  //   vStrip[p][tileSize-1](y=tileSize-1)if (p & 1)  == c
  //
  // Average all those pixels -> canonical corner pixel.
  // Write back to every endpoint so H[p][0] == V[q][0] whenever both encode
  // the same corner color.

  console.log('\nPhase 2: Corner consistency...');

  for (let c = 0; c < 2; c++) {
    let sr = 0, sg = 0, sb = 0, n = 0;

    for (let p = 0; p < 4; p++) {
      const c1 = p >> 1, c2 = p & 1;
      const last = (tileSize - 1) * 4;

      if (c1 === c) {
        sr += hStrips[p][0]; sg += hStrips[p][1]; sb += hStrips[p][2]; n++;
        sr += vStrips[p][0]; sg += vStrips[p][1]; sb += vStrips[p][2]; n++;
      }
      if (c2 === c) {
        sr += hStrips[p][last]; sg += hStrips[p][last + 1]; sb += hStrips[p][last + 2]; n++;
        sr += vStrips[p][last]; sg += vStrips[p][last + 1]; sb += vStrips[p][last + 2]; n++;
      }
    }

    const r = sr / n, g = sg / n, b = sb / n;

    for (let p = 0; p < 4; p++) {
      const c1 = p >> 1, c2 = p & 1;
      const last = (tileSize - 1) * 4;

      if (c1 === c) {
        hStrips[p][0] = r; hStrips[p][1] = g; hStrips[p][2] = b;
        vStrips[p][0] = r; vStrips[p][1] = g; vStrips[p][2] = b;
      }
      if (c2 === c) {
        hStrips[p][last]     = r; hStrips[p][last + 1] = g; hStrips[p][last + 2] = b;
        vStrips[p][last]     = r; vStrips[p][last + 1] = g; vStrips[p][last + 2] = b;
      }
    }

    console.log(`  Corner color ${c}: canonical=(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})  n=${n}`);
  }

  // ── PHASE 3 — Patch search (stratified) ───────────────────────────────────
  //
  // For each tile (tl,tr,br,bl), search for the tileSize*tileSize source patch
  // whose 4 edges best match the 4 canonical strips (minimum MSE).
  //
  // Stratification: the 16 tiles are mapped to a 4×4 grid of source regions.
  // Each tile searches only in its assigned grid cell.  This guarantees all 16
  // tiles use different interior crops, providing visual variety even when all
  // edge strips have similar colors (e.g., a uniform grass texture).
  //
  // The search within each cell still uses STRIDE for speed.

  console.log('\nPhase 3: Patch search (stratified 4x4 grid, MSE against canonical strips)...');

  const CONFIGS = [];
  for (let tl = 0; tl <= 1; tl++)
    for (let tr = 0; tr <= 1; tr++)
      for (let br = 0; br <= 1; br++)
        for (let bl = 0; bl <= 1; bl++)
          CONFIGS.push({ tl, tr, br, bl });

  const patches = [];   // { sx, sy, mse }

  // Usable search range (patch must fit within source)
  const maxSx = srcW - tileSize;
  const maxSy = srcH - tileSize;

  // 4×4 grid cells over the usable search space
  const cellW = Math.max(1, Math.floor(maxSx / 4));
  const cellH = Math.max(1, Math.floor(maxSy / 4));

  for (let ci = 0; ci < CONFIGS.length; ci++) {
    const { tl, tr, br, bl } = CONFIGS[ci];

    const H_top = hStrips[pairIdx(tl, tr)];
    const H_bot = hStrips[pairIdx(bl, br)];
    const V_lft = vStrips[pairIdx(tl, bl)];
    const V_rgt = vStrips[pairIdx(tr, br)];

    // Assign this tile to grid cell (gridCol, gridRow) based on its index
    const gridCol = ci % 4;
    const gridRow = Math.floor(ci / 4);
    const sxStart = gridCol * cellW;
    const syStart = gridRow * cellH;
    const sxEnd   = Math.min(maxSx, sxStart + cellW);
    const syEnd   = Math.min(maxSy, syStart + cellH);

    let bestMSE = Infinity, bestSx = sxStart, bestSy = syStart;

    for (let sy = syStart; sy <= syEnd; sy += STRIDE) {
      for (let sx = sxStart; sx <= sxEnd; sx += STRIDE) {
        let mse = 0, cnt = 0;

        // Top row
        for (let x = 0; x < tileSize; x += STRIDE) {
          const si = (sy * srcW + sx + x) * 4;
          const dx = S[si] - H_top[x * 4], dy = S[si + 1] - H_top[x * 4 + 1], dz = S[si + 2] - H_top[x * 4 + 2];
          mse += dx * dx + dy * dy + dz * dz; cnt++;
        }

        // Bottom row
        for (let x = 0; x < tileSize; x += STRIDE) {
          const si = ((sy + tileSize - 1) * srcW + sx + x) * 4;
          const dx = S[si] - H_bot[x * 4], dy = S[si + 1] - H_bot[x * 4 + 1], dz = S[si + 2] - H_bot[x * 4 + 2];
          mse += dx * dx + dy * dy + dz * dz; cnt++;
        }

        // Left column
        for (let y = 0; y < tileSize; y += STRIDE) {
          const si = ((sy + y) * srcW + sx) * 4;
          const dx = S[si] - V_lft[y * 4], dy = S[si + 1] - V_lft[y * 4 + 1], dz = S[si + 2] - V_lft[y * 4 + 2];
          mse += dx * dx + dy * dy + dz * dz; cnt++;
        }

        // Right column
        for (let y = 0; y < tileSize; y += STRIDE) {
          const si = ((sy + y) * srcW + sx + tileSize - 1) * 4;
          const dx = S[si] - V_rgt[y * 4], dy = S[si + 1] - V_rgt[y * 4 + 1], dz = S[si + 2] - V_rgt[y * 4 + 2];
          mse += dx * dx + dy * dy + dz * dz; cnt++;
        }

        const score = mse / cnt;
        if (score < bestMSE) { bestMSE = score; bestSx = sx; bestSy = sy; }
      }
    }

    patches.push({ sx: bestSx, sy: bestSy, mse: bestMSE });
    const idx = tl * 8 + tr * 4 + br * 2 + bl;
    console.log(`  Tile ${idx} (${tl}${tr}${br}${bl}): cell (${gridCol},${gridRow}) patch (${bestSx},${bestSy})  MSE=${bestMSE.toFixed(1)}`);
  }

  // ── PHASE 4 — Assembly ─────────────────────────────────────────────────────
  //
  // For each tile:
  //   1. Copy the best-matching source patch verbatim.
  //   2. For every pixel within `blend` px of any tile edge, smoothstep-blend
  //      toward the canonical strip pixel for the nearest edge.
  //      d=0 (tile boundary)  -> 100% canonical strip  -> guaranteed seamless
  //      d=blend (blend end)  -> 100% source patch     -> no modification
  //
  // "Nearest edge wins" for corner-blend regions: when two edges are equidistant
  // the priority is top > bottom > left > right.  Phase 2 made all strip endpoints
  // at the same corner color identical, so any choice yields the same pixel value.

  console.log('\nPhase 4: Assembling tiles...');

  let generated = 0;

  for (let ci = 0; ci < CONFIGS.length; ci++) {
    const { tl, tr, br, bl } = CONFIGS[ci];
    const { sx, sy }         = patches[ci];
    const tileIdx = tl * 8 + tr * 4 + br * 2 + bl;

    const H_top = hStrips[pairIdx(tl, tr)];
    const H_bot = hStrips[pairIdx(bl, br)];
    const V_lft = vStrips[pairIdx(tl, bl)];
    const V_rgt = vStrips[pairIdx(tr, br)];

    const outBuf = Buffer.allocUnsafe(tileSize * tileSize * 4);

    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        // Source patch pixel
        const si = ((sy + y) * srcW + (sx + x)) * 4;
        let r = S[si], g = S[si + 1], b = S[si + 2];

        // Distances to each tile edge
        const dTop = y;
        const dBot = tileSize - 1 - y;
        const dLft = x;
        const dRgt = tileSize - 1 - x;

        // Minimum distance to any edge
        const d = dTop < dBot
          ? (dTop < dLft ? (dTop < dRgt ? dTop : dRgt) : (dLft < dRgt ? dLft : dRgt))
          : (dBot < dLft ? (dBot < dRgt ? dBot : dRgt) : (dLft < dRgt ? dLft : dRgt));

        if (d < blend) {
          // Nearest-edge wins: determines the canonical strip pixel to blend toward
          let cr, cg, cb;
          if (dTop <= dBot && dTop <= dLft && dTop <= dRgt) {
            cr = H_top[x * 4]; cg = H_top[x * 4 + 1]; cb = H_top[x * 4 + 2];
          } else if (dBot <= dLft && dBot <= dRgt) {
            cr = H_bot[x * 4]; cg = H_bot[x * 4 + 1]; cb = H_bot[x * 4 + 2];
          } else if (dLft <= dRgt) {
            cr = V_lft[y * 4]; cg = V_lft[y * 4 + 1]; cb = V_lft[y * 4 + 2];
          } else {
            cr = V_rgt[y * 4]; cg = V_rgt[y * 4 + 1]; cb = V_rgt[y * 4 + 2];
          }

          // alpha=0 -> canonical strip pixel, alpha=1 -> source patch pixel
          const alpha = smoothstep(d / blend);
          r = Math.round(lerp(cr, r, alpha));
          g = Math.round(lerp(cg, g, alpha));
          b = Math.round(lerp(cb, b, alpha));
        }

        const oi = (y * tileSize + x) * 4;
        outBuf[oi]     = clamp(r, 0, 255);
        outBuf[oi + 1] = clamp(g, 0, 255);
        outBuf[oi + 2] = clamp(b, 0, 255);
        outBuf[oi + 3] = 255;
      }
    }

    const outputPath = path.join(wangDir, `wang_${tileIdx}.png`);
    await sharp(outBuf, { raw: { width: tileSize, height: tileSize, channels: 4 } })
      .png()
      .toFile(outputPath);

    generated++;
  }

  console.log(`\nDone -- ${generated} tiles written to ${wangDir}/\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
