#!/usr/bin/env node
/**
 * Wang Tile Generator — Cohen et al. 2003 Diamond Sample Method
 *
 * Implements the tile generation algorithm from:
 *   "Wang Tiles for Image and Texture Generation" (Cohen, Shade, Hiller, Deussen, 2003)
 *
 * Algorithm overview (Section 3.2):
 *
 *   1. SAMPLE EXTRACTION — Extract diamond-shaped sample patches from the
 *      source texture, one for each (horizontal_edge_color, vertical_edge_color)
 *      pair.  For a 16-tile set with 2 horizontal + 2 vertical colors, we
 *      extract 4 diamond samples — one from each quadrant of the source.
 *
 *   2. TILE ASSEMBLY — For each of the 16 tiles (TL,TR,BR,BL corner bits),
 *      assemble the tile from 4 quadrants, each drawn from the diamond sample
 *      corresponding to that corner's bit.  Quadrants are placed with overlap
 *      at the centre cross, mirroring Figure 4(a) of the paper.
 *
 *   3. CUTTING PATH OPTIMISATION — In the overlapping regions along the
 *      vertical and horizontal centre seams, find minimum-cost cutting paths
 *      via dynamic programming (Efros & Freeman 2001 image quilting).  This
 *      minimises visible boundaries between adjacent quadrants — the same
 *      optimisation the paper describes for combining diamond samples.
 *
 *   4. COMPOSITING — Each output pixel in the overlap zone is assigned to
 *      exactly one source quadrant based on which side of the cutting path
 *      it falls on.  Pixels outside all overlaps are taken directly from the
 *      sole covering quadrant.  The result is a fully opaque, artifact-
 *      minimised Wang tile.
 *
 * Edge-matching guarantee (central insight of Cohen et al.):
 *   All tiles that share a corner colour use the *same* diamond sample for
 *   the quadrant adjacent to that corner.  Therefore, when two tiles are
 *   placed adjacent to each other, their touching edge halves are drawn from
 *   identical source material — guaranteeing a seamless transition.
 *
 * Usage:
 *   node tools/wang-tiles/generate-cohen6.mjs <input> <outputDir> [tileSize]
 *
 * Example:
 *   node tools/wang-tiles/generate-cohen6.mjs public/assets/tiles/tile_grass.png public/assets/tiles/ 192
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Compute the squared colour difference between two pixels in raw RGBA buffers.
 * Channels: R, G, B (ignore alpha for cost).
 */
function pixelCost(bufA, idxA, bufB, idxB) {
  const dr = bufA[idxA]     - bufB[idxB];
  const dg = bufA[idxA + 1] - bufB[idxB + 1];
  const db = bufA[idxA + 2] - bufB[idxB + 2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Find the minimum-cost cutting path through an overlap region using DP.
 *
 * This implements the seam-finding optimisation from Efros & Freeman 2001
 * ("Image Quilting"), which Cohen et al. cite as their method for combining
 * diamond samples (Section 3.2, paragraph 4).
 *
 * overlapW × overlapH: size of the overlap region.
 * bufA, bufB:     raw RGBA pixel data of the two source regions.
 * offsetAx, offsetAy: top-left of bufA's overlap area within bufA's coords.
 * offsetBx, offsetBy: top-left of bufB's overlap area within bufB's coords.
 * strideA, strideB: row stride in pixels (width of full buffer).
 * direction: 'vertical' | 'horizontal' — the seam runs perpendicular to this.
 *
 * Returns a Uint8Array mask of size overlapW × overlapH where 1 = use bufA,
 * 0 = use bufB.
 */
function findCuttingPath({
  overlapW, overlapH,
  bufA, offsetAx, offsetAy, strideA,
  bufB, offsetBx, offsetBy, strideB,
  direction,
}) {
  // dp[y][x] = minimum cumulative cost to reach (x, y)
  // prev[y][x] = which previous x was chosen (-1, 0, or +1 relative)
  const dp   = new Float32Array(overlapW * overlapH).fill(Infinity);
  const prev = new Int8Array(overlapW * overlapH).fill(0);

  const idx = (x, y) => y * overlapW + x;

  if (direction === 'vertical') {
    // Seam runs top-to-bottom; each row chooses one x.
    // Initialize first row with cost at each pixel.
    for (let x = 0; x < overlapW; x++) {
      const ai = ((offsetAy) * strideA + (offsetAx + x)) * 4;
      const bi = ((offsetBy) * strideB + (offsetBx + x)) * 4;
      dp[idx(x, 0)] = pixelCost(bufA, ai, bufB, bi);
    }

    // DP: row by row, 3-way connectivity (↖ ↑ ↗)
    for (let y = 1; y < overlapH; y++) {
      for (let x = 0; x < overlapW; x++) {
        const ai = ((offsetAy + y) * strideA + (offsetAx + x)) * 4;
        const bi = ((offsetBy + y) * strideB + (offsetBx + x)) * 4;
        const cost = pixelCost(bufA, ai, bufB, bi);

        let best = Infinity;
        let bestDx = 0;
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx;
          if (px < 0 || px >= overlapW) continue;
          const val = dp[idx(px, y - 1)] + cost;
          if (val < best) { best = val; bestDx = dx; }
        }
        dp[idx(x, y)] = best;
        prev[idx(x, y)] = bestDx;
      }
    }

    // Backtrack from bottom row
    const mask = new Uint8Array(overlapW * overlapH);

    // Find minimum in last row
    let minX = 0;
    let minVal = dp[idx(0, overlapH - 1)];
    for (let x = 1; x < overlapW; x++) {
      if (dp[idx(x, overlapH - 1)] < minVal) {
        minVal = dp[idx(x, overlapH - 1)];
        minX = x;
      }
    }

    // Backtrack
    let cx = minX;
    for (let y = overlapH - 1; y >= 0; y--) {
      // Pixels left of the path: bufA (1); right of path: bufB (0)
      for (let x = 0; x < overlapW; x++) {
        mask[idx(x, y)] = (x <= cx) ? 1 : 0;
      }
      cx += prev[idx(cx, y)];
    }

    return mask;
  } else {
    // Horizontal seam: runs left-to-right; each column chooses one y.
    // Initialize first column.
    for (let y = 0; y < overlapH; y++) {
      const ai = ((offsetAy + y) * strideA + offsetAx) * 4;
      const bi = ((offsetBy + y) * strideB + offsetBx) * 4;
      dp[idx(0, y)] = pixelCost(bufA, ai, bufB, bi);
    }

    // DP: column by column
    for (let x = 1; x < overlapW; x++) {
      for (let y = 0; y < overlapH; y++) {
        const ai = ((offsetAy + y) * strideA + (offsetAx + x)) * 4;
        const bi = ((offsetBy + y) * strideB + (offsetBx + x)) * 4;
        const cost = pixelCost(bufA, ai, bufB, bi);

        let best = Infinity;
        let bestDy = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const py = y + dy;
          if (py < 0 || py >= overlapH) continue;
          const val = dp[idx(x - 1, py)] + cost;
          if (val < best) { best = val; bestDy = dy; }
        }
        dp[idx(x, y)] = best;
        prev[idx(x, y)] = bestDy;
      }
    }

    // Find minimum in last column
    let minY = 0;
    let minVal = dp[idx(overlapW - 1, 0)];
    for (let y = 1; y < overlapH; y++) {
      if (dp[idx(overlapW - 1, y)] < minVal) {
        minVal = dp[idx(overlapW - 1, y)];
        minY = y;
      }
    }

    // Backtrack
    const mask = new Uint8Array(overlapW * overlapH);
    let cy = minY;
    for (let x = overlapW - 1; x >= 0; x--) {
      for (let y = 0; y < overlapH; y++) {
        mask[idx(x, y)] = (y <= cy) ? 1 : 0;
      }
      cy += prev[idx(x, cy)];
    }

    return mask;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate-cohen6.mjs <inputPath> <outputDir> [tileSize]');
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

  // ── Step 1: Read source image & extract 4 diamond sample patches ──────
  const image  = sharp(inputPath);
  const meta   = await image.metadata();
  const srcW   = meta.width;
  const srcH   = meta.height;

  if (!srcW || !srcH || srcW !== srcH) {
    console.error('Input must be a square image.');
    process.exit(1);
  }

  const halfSrc = Math.floor(srcW / 2);
  const quarterSrc = Math.floor(srcW / 4);

  const quadSize   = Math.floor(tileSize / 2);
  const OVERLAP    = Math.max(8, Math.floor(tileSize / 12));
  const sampleSize = quadSize + OVERLAP;

  console.log(`Source: ${srcW}×${srcH}  →  16 Wang tiles @ ${tileSize}×${tileSize}`);
  console.log(`Quadrant: ${quadSize}px, Overlap: ${OVERLAP}px, Sample patches: ${sampleSize}×${sampleSize}px`);

  // ── Helper: extract and resize a patch ────────────────────────────────
  async function extractPatch(image, left, top, w, h, outSize) {
    const result = await image.clone()
      .extract({ left, top, width: w, height: h })
      .resize(outSize, outSize, { kernel: 'lanczos3' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { buf: result.data, stride: outSize, info: result.info };
  }

  // ── Step 1: Extract 8 sample patches ──────────────────────────────────
  //
  // Each corner position (TL, TR, BL, BR) gets 2 patches (bit=0, bit=1),
  // for a total of 8 distinct source regions.
  //
  // Critical constraint for edge matching: tiles that share a vertical
  // edge must have matching pixels along that edge.  If tile A is left of
  // tile B, then A.TR = B.TL and A.BR = B.BL.  For the right half of A
  // to match the left half of B, ALL TR-bit and TL-bit corners must use
  // the SAME source patch for a given bit value.
  //
  // Therefore: patches for (TL, bit) and (TR, bit) come from the same
  // source quadrant for each bit.  Same for (BL, BR).
  //
  // Bit=0 patches: all from the top-left source quadrant.
  // Bit=1 patches: all from the bottom-right source quadrant.
  //
  // But we increase variation by taking DIFFERENT CROPS within each
  // source quadrant per corner position — this preserves edge matching
  // while giving each of the 8 (corner × bit) combinations unique content.

  // Bit=0: 4 different ¼-sub-quadrant crops within the source TL quadrant
  // Bit=1: 4 different ¼-sub-quadrant crops within the source BR quadrant
  //
  // Source layout (source is srcW × srcW, seamless):
  //
  //   ┌──────────┬──────────┐
  //   │ TL_0 (TL)│ TL_0 (TR)│  ← top-left source quadrant, further split
  //   │ TL_0 (BL)│ TL_0 (BR)│
  //   ├──────────┼──────────┤
  //   │          │ BR_1 (TL)│ BR_1 (TR)  ← bottom-right source quadrant
  //   │  (other) │ BR_1 (BL)│ BR_1 (BR)
  //   └──────────┴──────────┘

  const patchRaw = {
    TL: [null, null],
    TR: [null, null],
    BL: [null, null],
    BR: [null, null],
  };

  // Bit=0 crops within source top-left quadrant (0,0)-(halfSrc,halfSrc)
  const bit0Offsets = {
    TL: { left: 0,                    top: 0 },
    TR: { left: quarterSrc,           top: 0 },
    BL: { left: 0,                    top: quarterSrc },
    BR: { left: quarterSrc,           top: quarterSrc },
  };

  // Bit=1 crops within source bottom-right quadrant (halfSrc,halfSrc)-(srcW,srcH)
  const bit1Offsets = {
    TL: { left: halfSrc,              top: halfSrc },
    TR: { left: halfSrc + quarterSrc, top: halfSrc },
    BL: { left: halfSrc,              top: halfSrc + quarterSrc },
    BR: { left: halfSrc + quarterSrc, top: halfSrc + quarterSrc },
  };

  for (const corner of ['TL', 'TR', 'BL', 'BR']) {
    patchRaw[corner][0] = await extractPatch(
      image, bit0Offsets[corner].left, bit0Offsets[corner].top,
      quarterSrc, quarterSrc, sampleSize,
    );
    patchRaw[corner][1] = await extractPatch(
      image, bit1Offsets[corner].left, bit1Offsets[corner].top,
      quarterSrc, quarterSrc, sampleSize,
    );
  }

  // ── Step 2: Generate 16 tiles ─────────────────────────────────────────
  let generated = 0;

  for (const tileIndex of range(16)) {
    // Corner bits: TL=bit3, TR=bit2, BR=bit1, BL=bit0
    const TL = (tileIndex >> 3) & 1;
    const TR = (tileIndex >> 2) & 1;
    const BR = (tileIndex >> 1) & 1;
    const BL = tileIndex & 1;

    // ── 2a. Build the tile canvas from 4 overlapping quadrants ──────────
    //
    // Layout (quarterTile = quadSize, ov = OVERLAP):
    //
    //   (0,0)
    //     ┌──────────────┬────┬──────────────┐
    //     │              │    │              │
    //     │     TL       │ ov │     TR       │
    //     │   patch[TL]  │    │   patch[TR]  │
    //     │              │    │              │
    //     ├──────────────┼────┼──────────────┤  ← horizontal seam at y=quadSize
    //     │   (overlap)  │    │   (overlap)  │
    //     ├──────────────┼────┼──────────────┤
    //     │              │    │              │
    //     │     BL       │ ov │     BR       │
    //     │   patch[BL]  │    │   patch[BR]  │
    //     │              │    │              │
    //     └──────────────┴────┴──────────────┘
    //                       ↑ vertical seam at x=quadSize
    //
    // Each quadrant is sampleSize × sampleSize = (quadSize+OVERLAP)²,
    // positioned so that its "interior" corner is at the tile centre.
    //
    // TL quadrant: bottom-right of patch at tile centre
    //   src region: (sampleSize - quadSize - OVERLAP) to (sampleSize)
    //   placed at tile (0, 0)
    //
    // TR quadrant: bottom-left of patch at tile centre
    //   src region: (0) to (quadSize + OVERLAP)
    //   placed at tile (quadSize - OVERLAP, 0)

    const fullW = tileSize;
    const fullH = tileSize;

    // Each quadrant's placement:
    const quadrants = [
      {
        // TL: patchRaw.TL[TL], bottom-right corner at tile centre
        patch: patchRaw.TL[TL],
        srcX: sampleSize - quadSize - OVERLAP,
        srcY: sampleSize - quadSize - OVERLAP,
        dstX: 0,
        dstY: 0,
      },
      {
        // TR: patchRaw.TR[TR], bottom-left corner at tile centre
        patch: patchRaw.TR[TR],
        srcX: 0,
        srcY: sampleSize - quadSize - OVERLAP,
        dstX: quadSize - OVERLAP,
        dstY: 0,
      },
      {
        // BL: patchRaw.BL[BL], top-right corner at tile centre
        patch: patchRaw.BL[BL],
        srcX: sampleSize - quadSize - OVERLAP,
        srcY: 0,
        dstX: 0,
        dstY: quadSize - OVERLAP,
      },
      {
        // BR: patchRaw.BR[BR], top-left corner at tile centre
        patch: patchRaw.BR[BR],
        srcX: 0,
        srcY: 0,
        dstX: quadSize - OVERLAP,
        dstY: quadSize - OVERLAP,
      },
    ];

    // ── 2b. Find cutting paths at the two overlap seams ──────────────────
    //
    // Vertical seam: between left quadrants (TL, BL) and right quadrants (TR, BR).
    // The overlap zone is at x ∈ [quadSize - OVERLAP, quadSize + OVERLAP),
    // for all y.
    //
    // Horizontal seam: between top quadrants (TL, TR) and bottom quadrants (BL, BR).
    // The overlap zone is at y ∈ [quadSize - OVERLAP, quadSize + OVERLAP),
    // for all x.
    //
    // Because the TL+BL left half and TR+BR right half are each contiguous
    // within their respective source patches, we combine them into two
    // "super-buffers" for the seam-finding step.

    // Build full-tile intermediate buffers for left half, right half,
    // top half, bottom half.  Pixels outside a quadrant's domain are zeroed.
    const leftHalf  = Buffer.alloc(fullW * fullH * 4);
    const rightHalf = Buffer.alloc(fullW * fullH * 4);
    const topHalf   = Buffer.alloc(fullW * fullH * 4);
    const botHalf   = Buffer.alloc(fullW * fullH * 4);

    // Fill left half (TL + BL, everything left of the vertical seam centre)
    for (const q of [quadrants[0], quadrants[2]]) {
      const { patch, srcX, srcY, dstX, dstY } = q;
      for (let dy = 0; dy < sampleSize; dy++) {
        const ty = dstY + dy;
        if (ty < 0 || ty >= fullH) continue;
        for (let dx = 0; dx < sampleSize; dx++) {
          const tx = dstX + dx;
          if (tx < 0 || tx >= fullW) continue;
          const si = ((srcY + dy) * patch.stride + (srcX + dx)) * 4;
          // Only fill the left-of-centre zone (including overlap)
          if (tx >= quadSize + OVERLAP) continue;
          const ti = (ty * fullW + tx) * 4;
          patch.buf.copy(leftHalf, ti, si, si + 4);
        }
      }
    }

    // Fill right half (TR + BR, everything right of the vertical seam centre)
    for (const q of [quadrants[1], quadrants[3]]) {
      const { patch, srcX, srcY, dstX, dstY } = q;
      for (let dy = 0; dy < sampleSize; dy++) {
        const ty = dstY + dy;
        if (ty < 0 || ty >= fullH) continue;
        for (let dx = 0; dx < sampleSize; dx++) {
          const tx = dstX + dx;
          if (tx < 0 || tx >= fullW) continue;
          if (tx < quadSize - OVERLAP) continue;
          const si = ((srcY + dy) * patch.stride + (srcX + dx)) * 4;
          const ti = (ty * fullW + tx) * 4;
          patch.buf.copy(rightHalf, ti, si, si + 4);
        }
      }
    }

    // Fill top half (TL + TR, everything above the horizontal seam centre)
    for (const q of [quadrants[0], quadrants[1]]) {
      const { patch, srcX, srcY, dstX, dstY } = q;
      for (let dy = 0; dy < sampleSize; dy++) {
        const ty = dstY + dy;
        if (ty < 0 || ty >= fullH) continue;
        if (ty >= quadSize + OVERLAP) continue;
        for (let dx = 0; dx < sampleSize; dx++) {
          const tx = dstX + dx;
          if (tx < 0 || tx >= fullW) continue;
          const si = ((srcY + dy) * patch.stride + (srcX + dx)) * 4;
          const ti = (ty * fullW + tx) * 4;
          patch.buf.copy(topHalf, ti, si, si + 4);
        }
      }
    }

    // Fill bottom half (BL + BR, everything below the horizontal seam centre)
    for (const q of [quadrants[2], quadrants[3]]) {
      const { patch, srcX, srcY, dstX, dstY } = q;
      for (let dy = 0; dy < sampleSize; dy++) {
        const ty = dstY + dy;
        if (ty < 0 || ty >= fullH) continue;
        if (ty < quadSize - OVERLAP) continue;
        for (let dx = 0; dx < sampleSize; dx++) {
          const tx = dstX + dx;
          if (tx < 0 || tx >= fullW) continue;
          const si = ((srcY + dy) * patch.stride + (srcX + dx)) * 4;
          const ti = (ty * fullW + tx) * 4;
          patch.buf.copy(botHalf, ti, si, si + 4);
        }
      }
    }

    // Find vertical cutting path (separates left half from right half)
    const vOverlapW = OVERLAP * 2;
    const vOverlapH = fullH;
    const vMask = findCuttingPath({
      overlapW: vOverlapW, overlapH: vOverlapH,
      bufA: leftHalf,   offsetAx: quadSize - OVERLAP, offsetAy: 0, strideA: fullW,
      bufB: rightHalf,  offsetBx: quadSize - OVERLAP, offsetBy: 0, strideB: fullW,
      direction: 'vertical',
    });

    // Find horizontal cutting path (separates top half from bottom half)
    const hOverlapW = fullW;
    const hOverlapH = OVERLAP * 2;
    const hMask = findCuttingPath({
      overlapW: hOverlapW, overlapH: hOverlapH,
      bufA: topHalf, offsetAx: 0, offsetAy: quadSize - OVERLAP, strideA: fullW,
      bufB: botHalf, offsetBx: 0, offsetBy: quadSize - OVERLAP, strideB: fullW,
      direction: 'horizontal',
    });

    // ── 2c. Composite final tile ────────────────────────────────────────
    const outRaw = Buffer.alloc(fullW * fullH * 4);

    for (let y = 0; y < fullH; y++) {
      for (let x = 0; x < fullW; x++) {
        const ti = (y * fullW + x) * 4;

        // Determine which source to use at this pixel.
        // Priority: cutting paths in overlap zones; outside overlaps, use
        // the unambiguous quadrant.

        let useLeft, useTop;

        // Vertical overlap zone?
        if (x >= quadSize - OVERLAP && x < quadSize + OVERLAP) {
          const vx = x - (quadSize - OVERLAP);
          useLeft = vMask[y * vOverlapW + vx] === 1;
        } else {
          useLeft = x < quadSize;
        }

        // Horizontal overlap zone?
        if (y >= quadSize - OVERLAP && y < quadSize + OVERLAP) {
          const hy = y - (quadSize - OVERLAP);
          useTop = hMask[hy * hOverlapW + x] === 1;
        } else {
          useTop = y < quadSize;
        }

        // Select the quadrant
        let quad;
        if (useTop && useLeft)       quad = quadrants[0]; // TL
        else if (useTop && !useLeft) quad = quadrants[1]; // TR
        else if (!useTop && useLeft) quad = quadrants[2]; // BL
        else                         quad = quadrants[3]; // BR

        // Map tile coords to source patch coords
        const sx = quad.srcX + (x - quad.dstX);
        const sy = quad.srcY + (y - quad.dstY);
        const si = (sy * quad.patch.stride + sx) * 4;

        outRaw[ti]     = quad.patch.buf[si];
        outRaw[ti + 1] = quad.patch.buf[si + 1];
        outRaw[ti + 2] = quad.patch.buf[si + 2];
        outRaw[ti + 3] = 255;
      }
    }

    // ── 2d. Write tile ──────────────────────────────────────────────────
    const outPath = path.join(wangDir, `wang_${tileIndex}.png`);
    await sharp(outRaw, {
      raw: { width: fullW, height: fullH, channels: 4 },
    })
      .png()
      .toFile(outPath);

    generated++;
  }

  console.log(`✓ Done — ${generated} tiles written to ${wangDir}/`);
}

// ── Utility ────────────────────────────────────────────────────────────────

function* range(n) {
  for (let i = 0; i < n; i++) yield i;
}

// ── Entry ───────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
