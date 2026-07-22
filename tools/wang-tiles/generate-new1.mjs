#!/usr/bin/env node
/**
 * generate-new1.mjs — Offset-Crop Wang Tiles with Cross-Tile Edge Blending
 *
 * Generates a 16-tile Corner Wang Tile set from a single seamless source
 * texture.  Each tile is a different 4×4-grid crop of the source.
 *
 * Edge blending uses a two-pass approach:
 *
 *   Pass 1: Extract every tile's raw edge pixels from the source crops.
 *
 *   Pass 2: For each tile, blend each edge toward the AVERAGE of the
 *           opposing tiles' corresponding edge.  E.g. a tile with top
 *           edge colours (TL=1, TR=1) blends its top edge toward the
 *           average bottom edge of all tiles with (BL=1, BR=1) — the
 *           tiles that could sit above it in a valid Wang tiling.
 *
 * This ensures all tiles sharing an edge-colour combination converge
 * to the same blended edge content — hiding crop seams without any
 * warping, single-colour fills, or texture stretching.
 *
 * =========================================================================
 * USAGE
 * =========================================================================
 *
 *   node tools/wang-tiles/generate-new1.mjs <input> <outputDir> [tileSize]
 *
 * Env vars:
 *   BLEND_WIDTH   px from edge to blend (default: 4)
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2];
const outputDir = process.argv[3];
const tileSize  = parseInt(process.argv[4], 10) || 192;

if (!inputPath || !outputDir) {
  console.error('Usage: node generate-new1.mjs <input> <outputDir> [tileSize] [--blend=N]');
  process.exit(1);
}

// --blend=N CLI flag overrides BLEND_WIDTH env var
const blendArg = process.argv.find(a => a.startsWith('--blend='));
const BLEND_WIDTH = blendArg
  ? parseInt(blendArg.split('=')[1], 10)
  : (parseInt(process.env.BLEND_WIDTH, 10) || 4);

// ── Smoothstep ────────────────────────────────────────────────────────────

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const srcBase = path.basename(inputPath, path.extname(inputPath));
  const wangDir = path.join(outputDir, `${srcBase}_wang`);
  fs.mkdirSync(wangDir, { recursive: true });

  console.log('='.repeat(60));
  console.log('generate-new1 — Cross-Tile Edge Blending');
  console.log('='.repeat(60));
  console.log(`  Source:       ${inputPath}`);
  console.log(`  Output:       ${wangDir}/`);
  console.log(`  Tile size:    ${tileSize}×${tileSize}`);
  console.log(`  Blend width:  ${BLEND_WIDTH} px`);
  console.log('='.repeat(60));

  const srcImage = sharp(inputPath);
  const metadata = await srcImage.metadata();
  const srcW = metadata.width;
  const srcH = metadata.height;
  console.log(`  Source dims:  ${srcW}×${srcH} (${metadata.format})`);

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

  // ── PASS 1: Extract raw edge pixels for every tile ──────────────────────
  // Each edge is stored as tileSize RGB triplets.

  /** Sample source at pixel coords (with wrapping). Returns {r,g,b}. */
  const samp = (sx, sy) => {
    let x = Math.floor(sx) % srcW, y = Math.floor(sy) % srcH;
    if (x < 0) x += srcW; if (y < 0) y += srcH;
    const i = (y * srcW + x) * 4;
    return { r: fullSrc[i], g: fullSrc[i + 1], b: fullSrc[i + 2] };
  };

  // edgePixels[tileIndex] = { top: [{r,g,b}*tileSize], bottom, left, right }
  const edgePixels = [];

  for (const t of tiles) {
    const top    = [], bottom = [], left = [], right = [];
    for (let p = 0; p < tileSize; p++) {
      top.push(   samp(t.ox + p * scaleX, t.oy));
      bottom.push(samp(t.ox + p * scaleX, t.oy + lastPx * scaleY));
      left.push(  samp(t.ox,              t.oy + p * scaleY));
      right.push( samp(t.ox + lastPx * scaleX, t.oy + p * scaleY));
    }
    edgePixels.push({ top, bottom, left, right });
  }

  console.log('  Pass 1: extracted edge pixels for all 16 tiles');

  // ── Helper: average an array of {r,g,b} objects ─────────────────────────
  const avgColors = (arr) => {
    let sr = 0, sg = 0, sb = 0;
    for (const c of arr) { sr += c.r; sg += c.g; sb += c.b; }
    const n = arr.length || 1;
    return { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) };
  };

  // ── PASS 2: Build reference strips & generate each tile ─────────────────
  //
  // For an edge with colours (a,b) at positions [TL,TR] or [BL,BR] etc.,
  // find all tiles whose OPPOSING edge has the same colours, then average
  // their edge pixels (per-pixel along the edge).

  const outputBuf = Buffer.alloc(tileSize * tileSize * 4);

  for (const t of tiles) {
    const { index, c, ox, oy } = t;
    const [tl, tr, br, bl] = c;

    // ── Build reference strips from opposing tiles ──
    // topEdge ref ← average bottom edge of tiles with (BL=tl, BR=tr)
    const refTop    = [];
    const refBottom = [];
    const refLeft   = [];
    const refRight  = [];

    // Find opposing tiles and average their edge pixels
    const oppBottom = tiles.filter(o => o.c[3] === tl && o.c[2] === tr); // BL=tl, BR=tr
    const oppTop    = tiles.filter(o => o.c[0] === bl && o.c[1] === br); // TL=bl, TR=br
    const oppRight  = tiles.filter(o => o.c[0] === tl && o.c[3] === bl); // TL=tl, BL=bl
    const oppLeft   = tiles.filter(o => o.c[1] === tr && o.c[2] === br); // TR=tr, BR=br

    for (let p = 0; p < tileSize; p++) {
      refTop.push(   avgColors(oppBottom.map(o => edgePixels[o.index].bottom[p])));
      refBottom.push(avgColors(oppTop.map(   o => edgePixels[o.index].top[p])));
      refLeft.push(  avgColors(oppRight.map( o => edgePixels[o.index].right[p])));
      refRight.push( avgColors(oppLeft.map(  o => edgePixels[o.index].left[p])));
    }

    // ── Generate the tile ──
    for (let py = 0; py < tileSize; py++) {
      for (let px = 0; px < tileSize; px++) {
        // Base: offset crop
        let sx = Math.floor(ox + px * scaleX) % srcW;
        let sy = Math.floor(oy + py * scaleY) % srcH;
        if (sx < 0) sx += srcW; if (sy < 0) sy += srcH;
        const si = (sy * srcW + sx) * 4;
        let r = fullSrc[si], g = fullSrc[si + 1], b = fullSrc[si + 2];

        // Edge blend: fade toward opposing-tile reference
        const dt = py, db = lastPx - py, dl = px, dr = lastPx - px;
        const dMin = Math.min(dt, db, dl, dr);

        if (dMin < BLEND_WIDTH) {
          let refR = 0, refG = 0, refB = 0, totalW = 0;

          if (dt < BLEND_WIDTH) {
            const w = 1 - smoothstep(0, BLEND_WIDTH, dt);
            refR += refTop[px].r * w; refG += refTop[px].g * w; refB += refTop[px].b * w; totalW += w;
          }
          if (db < BLEND_WIDTH) {
            const w = 1 - smoothstep(0, BLEND_WIDTH, db);
            refR += refBottom[px].r * w; refG += refBottom[px].g * w; refB += refBottom[px].b * w; totalW += w;
          }
          if (dl < BLEND_WIDTH) {
            const w = 1 - smoothstep(0, BLEND_WIDTH, dl);
            refR += refLeft[py].r * w; refG += refLeft[py].g * w; refB += refLeft[py].b * w; totalW += w;
          }
          if (dr < BLEND_WIDTH) {
            const w = 1 - smoothstep(0, BLEND_WIDTH, dr);
            refR += refRight[py].r * w; refG += refRight[py].g * w; refB += refRight[py].b * w; totalW += w;
          }

          if (totalW > 0) {
            refR /= totalW; refG /= totalW; refB /= totalW;
            const blend = Math.min(1, totalW);
            r = Math.round(r * (1 - blend) + refR * blend);
            g = Math.round(g * (1 - blend) + refG * blend);
            b = Math.round(b * (1 - blend) + refB * blend);
          }
        }

        const di = (py * tileSize + px) * 4;
        outputBuf[di] = r; outputBuf[di + 1] = g; outputBuf[di + 2] = b; outputBuf[di + 3] = 255;
      }
    }

    const outPath = path.join(wangDir, `wang_${index}.png`);
    await sharp(outputBuf, { raw: { width: tileSize, height: tileSize, channels: 4 } })
      .png({ compressionLevel: 6 }).toFile(outPath);

    const names = ['TL', 'TR', 'BR', 'BL'];
    const on = c.map((v, i) => v ? names[i] : null).filter(Boolean);
    console.log(`  Tile ${String(index).padStart(2)}  [${c.join('')}]  ${c.reduce((a,b)=>a+b,0)}/4  ${on.join('+') || 'empty'}`);
  }

  console.log('='.repeat(60));
  console.log(`Done — 16 Wang tiles written to ${wangDir}/`);
  console.log('='.repeat(60));
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
