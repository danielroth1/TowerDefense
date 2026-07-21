#!/usr/bin/env node
/**
 * Cohen et al. (2003) Wang Tile Generator — Search-Based Edge/Interior Filling
 *
 * Instead of splitting the source into fixed quadrants and swapping them
 * diagonally (the simple algorithm in generate.mjs), this searches the source
 * for optimal edge strips and interior patches.
 *
 * Algorithm:
 *   Phase 1 — Edge strip search: For each of 16 (edge, colourPair) combos,
 *             search the source for the lowest-variance 1px-wide strip.
 *   Phase 2 — Corner consistency: For each corner position and colour,
 *             average the endpoint pixels of all strips meeting there.
 *   Phase 3 — Band extraction: Sample BLEND-px-wide bands inward from each
 *             edge strip (used for feathering).
 *   Phase 4 — Interior search: For each of 16 corner permutations, search
 *             the source for the (tileSize-2*BLEND-2)² interior patch whose
 *             border best matches the 4 edge bands.
 *   Phase 5 — Assembly: Composite strips + bands + interior with centre-cross
 *             alpha feathered blending.
 *
 * Usage:
 *   node tools/wang-tiles/generate-cohen.mjs <inputPath> <outputDir> [tileSize]
 *
 * Example:
 *   node tools/wang-tiles/generate-cohen.mjs public/assets/tiles/tile_grass.png public/assets/tiles/ 192
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// ── Tunables ────────────────────────────────────────────────────────────
const BLEND  = 6;   // feather / transition zone width in pixels
const STRIDE = 4;   // interior search stride (1 = exhaustive, 4 = 16× faster)

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── RGBA helpers ────────────────────────────────────────────────────────
function srcIdx(w, x, y) {
  return ((y & 0xffff) * w + (x & 0xffff)) * 4;
}

function mean(buf, n) {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    r += buf[o];     g += buf[o + 1]; b += buf[o + 2];
  }
  return [r / n, g / n, b / n];
}

function variance(buf, n) {
  const [rm, gm, bm] = mean(buf, n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = buf[o] - rm, dg = buf[o + 1] - gm, db = buf[o + 2] - bm;
    v += dr * dr + dg * dg + db * db;
  }
  return v / n;
}

// ── Pair index helpers ──────────────────────────────────────────────────
// pair index = firstColour * 2 + secondColour
function pairIdx(a, b) { return a * 2 + b; }

// Edge → which corner colours define the pair:
//   top(0):    (tl, tr) → pair = tl*2 + tr
//   right(1):  (tr, br) → pair = tr*2 + br
//   bottom(2): (br, bl) → pair = br*2 + bl
//   left(3):   (bl, tl) → pair = bl*2 + tl

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate-cohen.mjs <inputPath> <outputDir> [tileSize]');
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

  console.log(`\nCohen Wang Tile Generator`);
  console.log(`  Source:     ${inputPath} (${srcW}×${srcH})`);
  console.log(`  Tile size:  ${tileSize}px`);
  console.log(`  Blend:      ${BLEND}px`);
  console.log(`  Output:     ${wangDir}/\n`);

  const { data: S } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Edge strip geometry per edge:
  //   0=top:   1px tall, tileSize wide,  wraps in X (y = offset)
  //   1=right:  tileSize tall, 1px wide,  wraps in Y (x = offset)
  //   2=bottom: 1px tall, tileSize wide,  wraps in X (y = offset)
  //   3=left:   tileSize tall, 1px wide,  wraps in Y (x = offset)
  const EDGE_NAMES = ['top', 'right', 'bottom', 'left'];
  const stripW = [tileSize, 1, tileSize, 1];
  const stripH = [1, tileSize, 1, tileSize];
  const searchLen = [srcH, srcW, srcH, srcW]; // how many offsets to search
  const isHoriz   = [true, false, true, false];

  // ─────────────────────────────────────────────────────────────────────
  // PHASE 1 — Edge strip search (stratified by colour pair)
  // ─────────────────────────────────────────────────────────────────────
  // KEY FIX: Each colour-pair variant searches a DIFFERENT region of the
  // source.  This guarantees the 4 strips per edge come from different
  // source offsets, producing visually distinct tiles.
  //
  // If all 4 variants search the same range and pick the minimum-variance
  // strip, they converge to the same offset (especially for uniform
  // textures like grass), making all 16 tiles look identical.
  //
  // The source is divided into 4 equal bands per edge.  Pair 0 searches
  // band 0, pair 1 searches band 1, etc.  After selection, Phase 2
  // enforces corner consistency by averaging endpoints, which naturally
  // makes the strips compatible at shared corners.

  console.log('Phase 1: Edge strip search (stratified)...');

  // edgeStrips[e][p] = Float64Array(tileSize * 4)
  const edgeStrips = Array.from({ length: 4 }, () => Array(4));
  const edgeOffsets = Array.from({ length: 4 }, () => Array(4));

  for (let e = 0; e < 4; e++) {
    const h = isHoriz[e];
    const maxOff = searchLen[e];
    const len = tileSize;

    // Divide the search range into 4 equal bands, one per colour pair
    const bandSize = Math.floor(maxOff / 4);

    for (let p = 0; p < 4; p++) {
      const bandStart = p * bandSize;
      const bandEnd   = p === 3 ? maxOff : (p + 1) * bandSize;

      let bestScore = Infinity;
      let bestOff = 0;
      let bestBuf = null;

      for (let off = bandStart; off < bandEnd; off++) {
        const buf = new Float64Array(len * 4);
        for (let i = 0; i < len; i++) {
          const sx = h ? i : off;
          const sy = h ? off : i;
          const si = srcIdx(srcW, sx, sy);
          const di = i * 4;
          buf[di]     = S[si];
          buf[di + 1] = S[si + 1];
          buf[di + 2] = S[si + 2];
          buf[di + 3] = 255;
        }
        const score = variance(buf, len);
        if (score < bestScore) {
          bestScore = score;
          bestOff   = off;
          bestBuf   = buf;
        }
      }

      edgeStrips[e][p]  = bestBuf;
      edgeOffsets[e][p] = bestOff;
      const c1 = (p >> 1) & 1, c2 = p & 1;
      console.log(`  ${EDGE_NAMES[e]} (${c1}${c2}): offset=${bestOff} (band ${bandStart}..${bandEnd-1}), score=${bestScore.toFixed(1)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // PHASE 2 — Corner consistency
  // ─────────────────────────────────────────────────────────────────────
  // For each corner position (TL,TR,BR,BL) and colour (0,1), find all
  // (edge, pair, stripIdx) tuples meeting there and average their pixels.
  //
  // Corner → meeting strips:
  //   TL:  topEdge[tl=c, tr=0..1].strip[0],  leftEdge[bl=0..1, tl=c].strip[0]
  //   TR:  topEdge[tl=0..1, tr=c].strip[-1], rightEdge[tr=c, br=0..1].strip[0]
  //   BR:  bottomEdge[br=c, bl=0..1].strip[-1], rightEdge[tr=0..1, br=c].strip[-1]
  //   BL:  bottomEdge[br=0..1, bl=c].strip[0], leftEdge[bl=c, tl=0..1].strip[-1]

  console.log('\nPhase 2: Corner consistency...');

  const CORNER_NAMES = ['TL', 'TR', 'BR', 'BL'];

  // cornerRefs[corner][colour] = [{ edge, pair, stripIdx }, ...]
  const cornerRefs = [
    // TL
    [
      [{ e: 0, p0: 0, p1: 1, si: 0 }, { e: 3, p0: 0, p1: 2, si: 0 }],  // colour 0
      [{ e: 0, p0: 2, p1: 3, si: 0 }, { e: 3, p0: 1, p1: 3, si: 0 }],  // colour 1
    ],
    // TR
    [
      [{ e: 0, p0: 0, p1: 2, si: -1 }, { e: 1, p0: 0, p1: 1, si: 0 }],  // colour 0
      [{ e: 0, p0: 1, p1: 3, si: -1 }, { e: 1, p0: 2, p1: 3, si: 0 }],  // colour 1
    ],
    // BR
    [
      [{ e: 2, p0: 0, p1: 1, si: -1 }, { e: 1, p0: 0, p1: 2, si: -1 }],  // colour 0
      [{ e: 2, p0: 2, p1: 3, si: -1 }, { e: 1, p0: 1, p1: 3, si: -1 }],  // colour 1
    ],
    // BL
    [
      [{ e: 2, p0: 0, p1: 2, si: 0 }, { e: 3, p0: 0, p1: 1, si: -1 }],  // colour 0
      [{ e: 2, p0: 1, p1: 3, si: 0 }, { e: 3, p0: 2, p1: 3, si: -1 }],  // colour 1
    ],
  ];

  for (let cn = 0; cn < 4; cn++) {
    for (let colour = 0; colour <= 1; colour++) {
      const refs = cornerRefs[cn][colour];
      // Collect all pairs and their strip indices
      const entries = [];
      for (const r of refs) {
        // r.e has pairs r.p0 and r.p1 that both meet at this corner with this colour
        entries.push({ edge: r.e, pair: r.p0, stripIdx: r.si });
        entries.push({ edge: r.e, pair: r.p1, stripIdx: r.si });
      }

      // Read pixel values
      let rSum = 0, gSum = 0, bSum = 0;
      for (const ent of entries) {
        const strip = edgeStrips[ent.edge][ent.pair];
        const pxIdx = ent.stripIdx === 0 ? 0 : tileSize - 1;
        const o = pxIdx * 4;
        rSum += strip[o]; gSum += strip[o + 1]; bSum += strip[o + 2];
      }
      const n = entries.length;
      const r = Math.round(rSum / n);
      const g = Math.round(gSum / n);
      const b = Math.round(bSum / n);

      // Propagate back
      for (const ent of entries) {
        const strip = edgeStrips[ent.edge][ent.pair];
        const pxIdx = ent.stripIdx === 0 ? 0 : tileSize - 1;
        const o = pxIdx * 4;
        strip[o] = r; strip[o + 1] = g; strip[o + 2] = b; strip[o + 3] = 255;
      }
    }
  }

  console.log('  Corner pixels averaged and propagated ✓');

  // ─────────────────────────────────────────────────────────────────────
  // PHASE 3 — Edge band extraction
  // ─────────────────────────────────────────────────────────────────────
  // Each edge gets a BLEND-px-wide band sampled inward from the edge strip.
  //
  // Band storage: for a horizontal edge (top/bottom), storage is
  //   band[bandRow * tileSize + pixelCol]
  // For a vertical edge (left/right), storage is
  //   band[pixelRow * BLEND + bandCol]

  console.log('\nPhase 3: Edge band extraction...');

  // edgeBands[e][p] = Float64Array(tileSize * BLEND * 4)
  const edgeBands = Array.from({ length: 4 }, () => Array(4));

  for (let e = 0; e < 4; e++) {
    const h = isHoriz[e];
    for (let p = 0; p < 4; p++) {
      const off = edgeOffsets[e][p];
      const buf = new Float64Array(tileSize * BLEND * 4);

      for (let i = 0; i < tileSize; i++) {
        for (let b = 0; b < BLEND; b++) {
          // Band extends INWARD from the edge strip
          //   top(e=0):    strip row = off, band rows = off+1 .. off+BLEND
          //   right(e=1):  strip col = off, band cols = off-1 .. off-BLEND
          //   bottom(e=2): strip row = off, band rows = off-1 .. off-BLEND
          //   left(e=3):   strip col = off, band cols = off+1 .. off+BLEND
          let sx, sy;
          if (e === 0)      { sx = i; sy = off + 1 + b; }           // top, downward
          else if (e === 1) { sx = off - 1 - b; sy = i; }           // right, leftward
          else if (e === 2) { sx = i; sy = off - 1 - b; }           // bottom, upward
          else              { sx = off + 1 + b; sy = i; }           // left, rightward

          const si = srcIdx(srcW, sx, sy);
          const di = h ? (b * tileSize + i) * 4 : (i * BLEND + b) * 4;
          buf[di]     = S[si];
          buf[di + 1] = S[si + 1];
          buf[di + 2] = S[si + 2];
          buf[di + 3] = 255;
        }
      }
      edgeBands[e][p] = buf;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // PHASE 4 — Interior search
  // ─────────────────────────────────────────────────────────────────────
  // For each of the 16 corner permutations, search the source for a
  // (tileSize - 2*BLEND - 2)² interior patch whose border best matches
  // the innermost row/col of the 4 edge bands.

  console.log('\nPhase 4: Interior search...');

  const innerSize = tileSize - 2 * BLEND - 2; // interior excludes strip(1) + band(BLEND) on each side
  const CORNER_CONFIGS = [];
  for (let tl = 0; tl <= 1; tl++)
    for (let tr = 0; tr <= 1; tr++)
      for (let br = 0; br <= 1; br++)
        for (let bl = 0; bl <= 1; bl++)
          CORNER_CONFIGS.push({ tl, tr, br, bl });

  const tileData = []; // { tl, tr, br, bl, interior: Float64Array, ix, iy, mse }

  for (const cfg of CORNER_CONFIGS) {
    const { tl, tr, br, bl } = cfg;
    const tileIdx = tl * 8 + tr * 4 + br * 2 + bl;

    // The 4 bands for this tile
    const topB   = edgeBands[0][pairIdx(tl, tr)];
    const rightB = edgeBands[1][pairIdx(tr, br)];
    const bottomB= edgeBands[2][pairIdx(br, bl)];
    const leftB  = edgeBands[3][pairIdx(bl, tl)];

    let bestMSE = Infinity;
    let bestIx = 0, bestIy = 0;

    // Search source for best interior position with STRIDE for performance.
    // The MSE landscape is smooth (nearby positions have similar error), so
    // striding by STRIDE pixels does not miss the global minimum by much.
    for (let iy = 0; iy < srcH; iy += STRIDE) {
      for (let ix = 0; ix < srcW; ix += STRIDE) {
        let mse = 0;
        let count = 0;

        // Compare interior border with band inner edge (band row/col BLEND-1)

        // Top border: interior row 0 vs band[BLEND-1][col]
        for (let i = 0; i < innerSize; i++) {
          const si = srcIdx(srcW, ix + i, iy);
          const bo = ((BLEND - 1) * tileSize + i) * 4;
          const dr = S[si] - topB[bo], dg = S[si + 1] - topB[bo + 1], db = S[si + 2] - topB[bo + 2];
          mse += dr * dr + dg * dg + db * db;
          count++;
        }

        // Bottom border: interior row innerSize-1 vs band[BLEND-1][col]
        for (let i = 0; i < innerSize; i++) {
          const si = srcIdx(srcW, ix + i, iy + innerSize - 1);
          const bo = ((BLEND - 1) * tileSize + i) * 4;
          const dr = S[si] - bottomB[bo], dg = S[si + 1] - bottomB[bo + 1], db = S[si + 2] - bottomB[bo + 2];
          mse += dr * dr + dg * dg + db * db;
          count++;
        }

        // Left border: interior col 0 vs band[BLEND-1][row] — but for vertical bands,
        // the storage is [row * BLEND + bandCol], so band inner edge = row * BLEND + (BLEND-1)
        for (let i = 0; i < innerSize; i++) {
          const si = srcIdx(srcW, ix, iy + i);
          const bo = (i * BLEND + (BLEND - 1)) * 4;
          const dr = S[si] - leftB[bo], dg = S[si + 1] - leftB[bo + 1], db = S[si + 2] - leftB[bo + 2];
          mse += dr * dr + dg * dg + db * db;
          count++;
        }

        // Right border: interior col innerSize-1 vs band[BLEND-1][row]
        for (let i = 0; i < innerSize; i++) {
          const si = srcIdx(srcW, ix + innerSize - 1, iy + i);
          const bo = (i * BLEND + (BLEND - 1)) * 4;
          const dr = S[si] - rightB[bo], dg = S[si + 1] - rightB[bo + 1], db = S[si + 2] - rightB[bo + 2];
          mse += dr * dr + dg * dg + db * db;
          count++;
        }

        if (count > 0) mse /= count;
        if (mse < bestMSE) {
          bestMSE = mse;
          bestIx  = ix;
          bestIy  = iy;
        }
      }
    }

    // Extract interior pixels
    const interior = new Float64Array(innerSize * innerSize * 4);
    for (let y = 0; y < innerSize; y++) {
      for (let x = 0; x < innerSize; x++) {
        const si = srcIdx(srcW, bestIx + x, bestIy + y);
        const di = (y * innerSize + x) * 4;
        interior[di]     = S[si];
        interior[di + 1] = S[si + 1];
        interior[di + 2] = S[si + 2];
        interior[di + 3] = 255;
      }
    }

    tileData.push({ tl, tr, br, bl, interior, ix: bestIx, iy: bestIy, mse: bestMSE });
    console.log(`  Tile ${tileIdx} (${tl}${tr}${br}${bl}): interior at (${bestIx},${bestIy}), MSE=${bestMSE.toFixed(2)}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // PHASE 5 — Assembly
  // ─────────────────────────────────────────────────────────────────────
  // Tile pixel layout:
  //
  //   Rows 0 … 0:                    top edge strip (1 px)
  //   Rows 1 … BLEND:                top edge band (BLEND px)
  //   Rows BLEND+1 … BLEND+innerSize: interior (innerSize px)
  //   Rows BLEND+innerSize+1 … tileSize-2: bottom edge band (BLEND px)
  //   Row tileSize-1:                bottom edge strip (1 px)
  //
  // Same for columns with left/right.

  console.log('\nPhase 5: Assembling tiles...');

  const innerTop    = BLEND + 1;               // first interior pixel row/col
  const bandBottom  = tileSize - BLEND - 1;    // first bottom band pixel row/col (its strip-adjacent edge)
  const stripBottom = tileSize - 1;            // bottom edge strip row/col

  let generated = 0;
  for (const tile of tileData) {
    const tileIdx = tile.tl * 8 + tile.tr * 4 + tile.br * 2 + tile.bl;
    const outBuf = Buffer.alloc(tileSize * tileSize * 4);

    // Helper: set output pixel
    function setPx(x, y, buf, idx) {
      const o = (y * tileSize + x) * 4;
      outBuf[o]     = buf[idx];
      outBuf[o + 1] = buf[idx + 1];
      outBuf[o + 2] = buf[idx + 2];
      outBuf[o + 3] = buf[idx + 3];
    }

    // ── 5a. Place edge strips (1px border) ───────────────────────────
    const topS   = edgeStrips[0][pairIdx(tile.tl, tile.tr)];
    const rightS = edgeStrips[1][pairIdx(tile.tr, tile.br)];
    const bottomS= edgeStrips[2][pairIdx(tile.br, tile.bl)];
    const leftS  = edgeStrips[3][pairIdx(tile.bl, tile.tl)];

    for (let i = 0; i < tileSize; i++) {
      const to = i * 4;
      setPx(i, 0, topS, to);
      setPx(i, stripBottom, bottomS, to);
      setPx(0, i, leftS, to);
      setPx(stripBottom, i, rightS, to);
    }

    // ── 5b. Place edge bands ─────────────────────────────────────────
    const topB   = edgeBands[0][pairIdx(tile.tl, tile.tr)];
    const rightB = edgeBands[1][pairIdx(tile.tr, tile.br)];
    const bottomB= edgeBands[2][pairIdx(tile.br, tile.bl)];
    const leftB  = edgeBands[3][pairIdx(tile.bl, tile.tl)];

    // Top band: rows 1..BLEND
    for (let b = 0; b < BLEND; b++) {
      const row = 1 + b;
      for (let i = 0; i < tileSize; i++) {
        const bo = (b * tileSize + i) * 4;
        setPx(i, row, topB, bo);
      }
    }

    // Bottom band: rows tileSize-1-BLEND .. tileSize-2
    // Storage b=0 is strip-adjacent (sampled at off-1), b=BLEND-1 is interior-adjacent.
    // Place so b=0 → tileSize-2 (strip-adjacent), b=BLEND-1 → tileSize-1-BLEND (interior-adjacent).
    for (let b = 0; b < BLEND; b++) {
      const row = tileSize - 2 - b;
      for (let i = 0; i < tileSize; i++) {
        const bo = (b * tileSize + i) * 4;
        setPx(i, row, bottomB, bo);
      }
    }

    // Left band: cols 1..BLEND
    for (let b = 0; b < BLEND; b++) {
      const col = 1 + b;
      for (let i = 0; i < tileSize; i++) {
        const bo = (i * BLEND + b) * 4;
        setPx(col, i, leftB, bo);
      }
    }

    // Right band: cols tileSize-1-BLEND .. tileSize-2
    // Storage b=0 is strip-adjacent (col tileSize-2), b=BLEND-1 is interior-adjacent (col tileSize-1-BLEND).
    for (let b = 0; b < BLEND; b++) {
      const col = tileSize - 2 - b;
      for (let i = 0; i < tileSize; i++) {
        const bo = (i * BLEND + b) * 4;
        setPx(col, i, rightB, bo);
      }
    }

    // ── 5c. Place interior ───────────────────────────────────────────
    for (let y = 0; y < innerSize; y++) {
      for (let x = 0; x < innerSize; x++) {
        const di = (y * innerSize + x) * 4;
        const px = tile.interior[di];
        const py = tile.interior[di + 1];
        const pz = tile.interior[di + 2];
        const pw = tile.interior[di + 3];
        const o = ((innerTop + y) * tileSize + (innerTop + x)) * 4;
        outBuf[o]     = px;
        outBuf[o + 1] = py;
        outBuf[o + 2] = pz;
        outBuf[o + 3] = pw;
      }
    }

    // ── 5d. Feather band → interior transition ───────────────────────
    // Blend FEATHER pixels at the band-interior boundary to hide any
    // residual mismatch from the search not finding a perfect match.
    //
    // For each feather step f (0 = band edge, FEATHER-1 = interior edge),
    // alpha = f/(FEATHER-1) transitions from full-band to full-interior.
    const FEATHER = Math.min(2, BLEND);
    if (FEATHER > 0) {
      for (let f = 0; f < FEATHER; f++) {
        const alpha = FEATHER > 1 ? f / (FEATHER - 1) : 0.5;

        // Top: band row innerTop-1-f blends with interior row innerTop+f
        for (let i = innerTop; i < innerTop + innerSize; i++) {
          const bandRow = innerTop - 1 - f;
          const intRow  = innerTop + f;
          if (bandRow >= 1 && intRow < innerTop + innerSize) {
            for (let c = 0; c < 3; c++) {
              const bo = (bandRow * tileSize + i) * 4 + c;
              const io = (intRow  * tileSize + i) * 4 + c;
              outBuf[bo] = Math.round(outBuf[bo] * (1 - alpha) + outBuf[io] * alpha);
            }
          }
        }

        // Bottom: band row bandBottom+f blends with interior row bandBottom-1-f
        for (let i = innerTop; i < innerTop + innerSize; i++) {
          const bandRow = tileSize - 2 - f;
          const intRow  = tileSize - 2 - BLEND - f;
          if (bandRow <= tileSize - 2 && intRow >= innerTop) {
            for (let c = 0; c < 3; c++) {
              const bo = (bandRow * tileSize + i) * 4 + c;
              const io = (intRow  * tileSize + i) * 4 + c;
              outBuf[bo] = Math.round(outBuf[bo] * (1 - alpha) + outBuf[io] * alpha);
            }
          }
        }

        // Left: band col innerTop-1-f blends with interior col innerTop+f
        for (let i = innerTop; i < innerTop + innerSize; i++) {
          const bandCol = innerTop - 1 - f;
          const intCol  = innerTop + f;
          if (bandCol >= 1 && intCol < innerTop + innerSize) {
            for (let c = 0; c < 3; c++) {
              const bo = (i * tileSize + bandCol) * 4 + c;
              const io = (i * tileSize + intCol)  * 4 + c;
              outBuf[bo] = Math.round(outBuf[bo] * (1 - alpha) + outBuf[io] * alpha);
            }
          }
        }

        // Right: band col tileSize-2-f blends with interior col tileSize-2-BLEND-f
        for (let i = innerTop; i < innerTop + innerSize; i++) {
          const bandCol = tileSize - 2 - f;
          const intCol  = tileSize - 2 - BLEND - f;
          if (bandCol >= 1 && intCol >= innerTop) {
            for (let c = 0; c < 3; c++) {
              const bo = (i * tileSize + bandCol) * 4 + c;
              const io = (i * tileSize + intCol)  * 4 + c;
              outBuf[bo] = Math.round(outBuf[bo] * (1 - alpha) + outBuf[io] * alpha);
            }
          }
        }
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
  }

  console.log(`\n✓ Done — ${generated} Cohen-style Wang tiles written to ${wangDir}/\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
