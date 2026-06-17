import Phaser from 'phaser';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';
import type { GridTile } from './MapGenerator';

/*
 * ─── Blob Tileset for Path Rendering ───────────────────────────────────────
 *
 * Each path tile gets a 4-bit mask based on which cardinal neighbours are
 * also path tiles:
 *
 *   Bit 0 (1) = North     Bit 1 (2) = East
 *   Bit 2 (4) = South     Bit 3 (8) = West
 *
 * 16 textures (tile_blob_0 … tile_blob_15) are generated procedurally.
 * Each tile blends cobblestone road ↔ lush grass depending on the mask.
 *
 * Road shape is built from rectangular arms + rounded caps per connected
 * edge, with a centre circle to blend multiple arms smoothly.
 */

// ─── Bitmask constants ─────────────────────────────────────────────────────
const B_N = 0x1, B_E = 0x2, B_S = 0x4, B_W = 0x8;

/** Return the blob bitmask for a grid cell (0-15). */
export function computeBlobMask(grid: GridTile[][], row: number, col: number): number {
  let mask = 0;
  if (row > 0            && isPath(grid[row - 1][col])) mask |= B_N;
  if (row < GRID_ROWS - 1 && isPath(grid[row + 1][col])) mask |= B_S;
  if (col > 0            && isPath(grid[row][col - 1])) mask |= B_W;
  if (col < GRID_COLS - 1 && isPath(grid[row][col + 1])) mask |= B_E;
  return mask;
}

function isPath(t: GridTile): boolean {
  return t.type === 'path' || t.type === 'spawn' || t.type === 'goal';
}

/** Texture key for a given blob mask. */
export function blobTileKey(mask: number): string {
  return `tile_blob_${mask}`;
}

// ─── Texture generation ────────────────────────────────────────────────────
const TS = TILE_SIZE;            // tile size in px (48)
const C = TS / 2;                // centre
const HW = 14;                  // road half-width (road = 28 px wide)

// Cobblestone colour palette
const STONE_BASE   = 0x7a6e58;
const STONE_LIGHT  = 0x9a8e70;
const STONE_DARK   = 0x5a4e30;
const STONE_DARKER = 0x4a3e20;

// Grass colour palette (matching tile_buildable)
const GRASS_LIGHT  = 0x3a8a22;
const GRASS_HL     = 0x5aaa33;

/**
 * Generate all 16 blob tile textures and register them on the scene.
 */
export function generateBlobTextures(scene: Phaser.Scene): void {
  const g = scene.add.graphics();

  for (let mask = 0; mask < 16; mask++) {
    g.clear();
    drawTile(g, mask);
    g.generateTexture(blobTileKey(mask), TS, TS);
  }

  g.destroy();
}

// ─── Per-tile drawing ──────────────────────────────────────────────────────
function drawTile(g: Phaser.GameObjects.Graphics, mask: number): void {
  // 1. Grass base (matches tile_buildable style)
  drawGrassBase(g);

  // 2. Road shape – smooth cobblestone with grass transition
  drawRoadShape(g, mask);

  // 3. Cobblestone details on the road area
  drawCobbleDetails(g, mask);

  // 4. Subtle border for crisp tiling
  g.lineStyle(1, 0x0a0a0a, 0.10);
  g.strokeRect(0, 0, TS, TS);
}

// ─── Grass base ────────────────────────────────────────────────────────────
function drawGrassBase(g: Phaser.GameObjects.Graphics): void {
  // Vertical gradient (subtle, tileable)
  for (let y = 0; y < TS; y++) {
    const t = y / TS;
    const osc = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 - Math.PI / 2);
    const r = Math.floor((0.14 + 0.04 * osc) * 255);
    const gr = Math.floor((0.34 + 0.10 * osc) * 255);
    const b = Math.floor((0.10 + 0.03 * osc) * 255);
    g.fillStyle(Phaser.Display.Color.GetColor(r, gr, b), 1);
    g.fillRect(0, y, TS, 1);
  }

  // Grass blade clusters (positioned deterministically)
  for (let i = 0; i < 16; i++) {
    const gx = (i * 17 + 5) % TS;
    const gy = (i * 13 + 7) % TS;
    const shade = (i % 3) === 0 ? 0.5 : 0.35;
    g.fillStyle(GRASS_LIGHT, shade);
    g.fillRect(gx, gy, 2, 5 + (i % 4));
  }

  // Lighter grass highlights
  for (let i = 0; i < 10; i++) {
    const gx = (i * 23 + 3) % TS;
    const gy = (i * 19 + 11) % TS;
    g.fillStyle(GRASS_HL, 0.25);
    g.fillRect(gx, gy, 1, 3);
  }

  // Tiny flowers
  const flowerPositions = [
    [0.15, 0.12], [0.55, 0.08], [0.35, 0.42],
    [0.85, 0.28], [0.10, 0.62], [0.65, 0.72],
    [0.45, 0.88], [0.88, 0.55], [0.72, 0.92],
  ];
  for (const [fx, fy] of flowerPositions) {
    const col = Math.random() > 0.5 ? 0xffdd44 : 0xff9933;
    g.fillStyle(col, 0.40);
    g.fillCircle(fx * TS, fy * TS, 1.2);
  }
}

// ─── Road shape ────────────────────────────────────────────────────────────
function drawRoadShape(g: Phaser.GameObjects.Graphics, mask: number): void {
  // Collect rectangle and circle regions for the road
  const rects: { x: number; y: number; w: number; h: number }[] = [];

  // Each connected edge draws a rectangle from edge toward centre
  if (mask & B_N) rects.push({ x: C - HW, y: 0,      w: HW * 2, h: C });
  if (mask & B_S) rects.push({ x: C - HW, y: C,      w: HW * 2, h: C });
  if (mask & B_W) rects.push({ x: 0,      y: C - HW, w: C,      h: HW * 2 });
  if (mask & B_E) rects.push({ x: C,      y: C - HW, w: C,      h: HW * 2 });

  // For end caps (single connection), shorten the arm so it rounds off
  const popcount = (mask & B_N ? 1 : 0) + (mask & B_S ? 1 : 0) +
                   (mask & B_W ? 1 : 0) + (mask & B_E ? 1 : 0);

  if (popcount === 1) {
    // End cap – shorten the single arm so it rounds off before centre
    const shortLen = C - HW * 0.6;
    if (mask & B_N) rects[0] = { x: C - HW, y: 0, w: HW * 2, h: shortLen };
    if (mask & B_S) rects[0] = { x: C - HW, y: C, w: HW * 2, h: shortLen };
    if (mask & B_W) rects[0] = { x: 0, y: C - HW, w: shortLen, h: HW * 2 };
    if (mask & B_E) rects[0] = { x: C, y: C - HW, w: shortLen, h: HW * 2 };
  }

  if (popcount === 0) {
    // Isolated – just a small rounded blob at centre
    g.fillStyle(STONE_BASE, 1);
    g.fillCircle(C, C, HW * 0.7);
    g.fillStyle(STONE_LIGHT, 0.3);
    g.fillCircle(C - 2, C - 2, HW * 0.4);
    return;
  }

  // ── Draw transition bands (outer → inner) ──
  const bands = [
    { alpha: 0.12, expand: 5 },
    { alpha: 0.35, expand: 2 },
    { alpha: 0.70, expand: 0 },
    { alpha: 1.00, expand: 0 },
  ];

  for (const band of bands) {
    const expand = band.expand;
    const alpha = band.alpha;

    // Draw each rectangle with expansion
    for (const r of rects) {
      const rx = r.x - expand;
      const ry = r.y - expand;
      const rw = r.w + expand * 2;
      const rh = r.h + expand * 2;
      g.fillStyle(STONE_BASE, alpha);
      g.fillRect(rx, ry, rw, rh);
    }

    // Centre circle to blend arms – largest for innermost band
    if (popcount >= 2) {
      const circleR = HW + (band.expand === bands[0].expand ? 0 : expand);
      g.fillStyle(STONE_BASE, alpha);
      g.fillCircle(C, C, circleR);
    }

    // End-cap rounded ends
    if (popcount === 1) {
      const endCapExpand = expand;
      if (mask & B_N) {
        g.fillStyle(STONE_BASE, alpha);
        g.fillCircle(C, rects[0].y + rects[0].h + endCapExpand, HW + endCapExpand);
      }
      if (mask & B_S) {
        g.fillStyle(STONE_BASE, alpha);
        g.fillCircle(C, rects[0].y - endCapExpand, HW + endCapExpand);
      }
      if (mask & B_W) {
        g.fillStyle(STONE_BASE, alpha);
        g.fillCircle(rects[0].x + rects[0].w + endCapExpand, C, HW + endCapExpand);
      }
      if (mask & B_E) {
        g.fillStyle(STONE_BASE, alpha);
        g.fillCircle(rects[0].x - endCapExpand, C, HW + endCapExpand);
      }
    }
  }
}

// ─── Cobblestone details ─────────────────────────────────────────────────
function drawCobbleDetails(g: Phaser.GameObjects.Graphics, mask: number): void {
  // Helper: is a point roughly within road area?
  function inRoad(px: number, py: number): boolean {
    const dx = Math.abs(px - C);
    const dy = Math.abs(py - C);

    // Check each arm
    if ((mask & B_N) && px >= C - HW && px <= C + HW && py >= 0 && py <= C + HW) return true;
    if ((mask & B_S) && px >= C - HW && px <= C + HW && py >= C - HW && py <= TS) return true;
    if ((mask & B_W) && py >= C - HW && py <= C + HW && px >= 0 && px <= C + HW) return true;
    if ((mask & B_E) && py >= C - HW && py <= C + HW && px >= C - HW && px <= TS) return true;

    // Centre circle
    if (Math.sqrt(dx * dx + dy * dy) <= HW) return true;

    return false;
  }

  // Generate cobblestone positions in a grid-like pattern
  const cols = 3, rows = 3;
  const cw = TS / cols, ch = TS / rows;
  const stoneSize = 9;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const stagger = (r % 2 === 1) ? cw / 2 : 0;
      const sx = c * cw + stagger + (cw - stoneSize) / 2;
      const sy = r * ch + (ch - stoneSize) / 2;

      // Only draw if stone centre is within road area
      if (!inRoad(sx + stoneSize / 2, sy + stoneSize / 2)) continue;

      const idx = r * cols + c;
      const shade = (idx % 3 === 0) ? STONE_LIGHT : (idx % 3 === 1) ? STONE_BASE : STONE_DARK;

      // Main stone
      g.fillStyle(shade, 0.85);
      g.fillRoundedRect(sx, sy, stoneSize, stoneSize, 2);
      g.lineStyle(1, STONE_DARKER, 0.4);
      g.strokeRoundedRect(sx, sy, stoneSize, stoneSize, 2);

      // Highlight (light on top-left)
      g.fillStyle(STONE_LIGHT, 0.15);
      g.fillRoundedRect(sx + 1, sy + 1, stoneSize * 0.7, stoneSize * 0.3, 1);
    }
  }

  // Mortar lines between stones (subtle grid)
  g.lineStyle(1, STONE_DARKER, 0.20);
  for (let r = 0; r <= rows; r++) {
    g.lineBetween(0, r * ch, TS, r * ch);
  }
  for (let c = 0; c <= cols; c++) {
    g.lineBetween(c * cw, 0, c * cw, TS);
  }
}
