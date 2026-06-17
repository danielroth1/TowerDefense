import Phaser from 'phaser';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';

/*
 * ─── Terrain Auto-Tiling: Corner-Based Bitmasking ──────────────────────────
 *
 * Each terrain layer (Water → Sand → Grass) is rendered as a separate pass.
 * Higher-layer tiles use a 4-bit corner bitmask (0–15) to select one of 16
 * transition textures that alpha-blend into the layer beneath.
 *
 * Corner bit weights:
 *   Top-Left   (TL) = 1
 *   Top-Right  (TR) = 2
 *   Bottom-Right (BR) = 4
 *   Bottom-Left (BL) = 8
 *
 * A corner is 1 iff the tile itself AND both cardinal neighbours adjacent to
 * that corner belong to the target terrain.
 *
 * Texture mapping (4×4 spritesheet layout):
 *   Row = floor(mask / 4), Col = mask % 4
 */

// ─── Terrain layer definitions ────────────────────────────────────────────

export interface TerrainLayerDef {
  id: string;       // unique identifier (e.g. 'water', 'sand', 'grass')
  label: string;    // human-readable name
  depth: number;    // rendering depth offset from base
  tileType: string; // the GridTile.type that this layer represents
}

export const TERRAIN_LAYERS: TerrainLayerDef[] = [
  { id: 'water', label: 'Water', depth: 0, tileType: 'ground' },
  { id: 'sand',  label: 'Sand',  depth: 1, tileType: '' },       // reserved for future use
  { id: 'grass', label: 'Grass', depth: 2, tileType: 'buildable' },
];

/** Get the highest terrain layer for a given tile type (or null if none). */
export function tileTypeToLayerId(tileType: string): string | null {
  // Walk layers in reverse so we get the highest matching layer
  for (let i = TERRAIN_LAYERS.length - 1; i >= 0; i--) {
    if (TERRAIN_LAYERS[i].tileType === tileType) return TERRAIN_LAYERS[i].id;
  }
  return null;
}

/** Get terrain layer depth by id */
export function getLayerDepth(layerId: string): number {
  const layer = TERRAIN_LAYERS.find(l => l.id === layerId);
  return layer ? layer.depth : 0;
}

// ─── Corner bit constants ─────────────────────────────────────────────────

const TL = 0x1;
const TR = 0x2;
const BR = 0x4;
const BL = 0x8;

/**
 * Compute the 4-bit corner mask (0–15) for a tile at (row, col).
 *
 * A corner is True (1) iff:
 *   - The tile itself at (row, col) matches the target terrain
 *   - Both cardinal neighbours adjacent to that corner also match
 *
 * Out-of-bounds cells are treated as NOT matching (returning 0 for
 * boundary corners, which naturally creates edge transitions).
 *
 * @param isTerrain - predicate returning true if cell (r,c) is target terrain
 * @param row       - tile row
 * @param col       - tile column
 * @returns integer 0–15
 */
export function computeCornerMask(
  isTerrain: (r: number, c: number) => boolean,
  row: number,
  col: number,
): number {
  // Tile itself must be target terrain
  if (!isTerrain(row, col)) return 0;

  let mask = 0;

  // TL: check N, W, and NW diagonal
  if (row > 0 && col > 0
      && isTerrain(row - 1, col) && isTerrain(row, col - 1)
      && isTerrain(row - 1, col - 1)) {
    mask |= TL;
  }

  // TR: check N, E, and NE diagonal
  if (row > 0 && col < GRID_COLS - 1
      && isTerrain(row - 1, col) && isTerrain(row, col + 1)
      && isTerrain(row - 1, col + 1)) {
    mask |= TR;
  }

  // BR: check S, E, and SE diagonal
  if (row < GRID_ROWS - 1 && col < GRID_COLS - 1
      && isTerrain(row + 1, col) && isTerrain(row, col + 1)
      && isTerrain(row + 1, col + 1)) {
    mask |= BR;
  }

  // BL: check S, W, and SW diagonal
  if (row < GRID_ROWS - 1 && col > 0
      && isTerrain(row + 1, col) && isTerrain(row, col - 1)
      && isTerrain(row + 1, col - 1)) {
    mask |= BL;
  }

  return mask;
}

/** Texture key for a transition tile. */
export function transitionTileKey(terrainId: string, mask: number): string {
  return `tile_trans_${terrainId}_${mask}`;
}

/** Returns the spritesheet grid position for a mask (UV / tile-coord mapping). */
export function cornerMaskToGrid(mask: number): { row: number; col: number } {
  return { row: Math.floor(mask / 4), col: mask % 4 };
}

/** Count set bits in a 4-bit number. */
// popcount4 intentionally omitted — not needed in final implementation

// ─── Texture generation ───────────────────────────────────────────────────

const TS = TILE_SIZE;   // 48
const C  = TS / 2;       // 24 (centre)

// ─── Colour palettes ──────────────────────────────────────────────────────

interface TerrainColors {
  base: number;
  light: number;
  dark: number;
}

const GRASS_COLORS: TerrainColors = { base: 0x3a8a22, light: 0x5aaa33, dark: 0x2a6a18 };
const SAND_COLORS:  TerrainColors = { base: 0xc4b078, light: 0xd4c088, dark: 0xa09058 };
const WATER_COLORS: TerrainColors = { base: 0x1e3866, light: 0x3e5a99, dark: 0x0e1e44 };

function colorsFor(terrainId: string): TerrainColors {
  if (terrainId === 'grass') return GRASS_COLORS;
  if (terrainId === 'sand')  return SAND_COLORS;
  if (terrainId === 'water') return WATER_COLORS;
  return { base: 0x888888, light: 0xaaaaaa, dark: 0x666666 };
}

/**
 * Generate all 16 transition tile textures for a given terrain type and
 * register them in Phaser's texture manager.
 *
 * Call this during BootScene.create() after the base tiles are ready.
 */
export function generateTransitionTextures(
  scene: Phaser.Scene,
  terrainId: string,
): void {
  const g = scene.add.graphics();
  const cols = colorsFor(terrainId);

  for (let mask = 0; mask < 16; mask++) {
    g.clear();
    drawTransitionTile(g, mask, terrainId, cols);
    g.generateTexture(transitionTileKey(terrainId, mask), TS, TS);
  }

  g.destroy();
}

// ─── Per-tile drawing ─────────────────────────────────────────────────────

function drawTransitionTile(
  g: Phaser.GameObjects.Graphics,
  mask: number,
  terrainId: string,
  cols: TerrainColors,
): void {
  if (mask === 0) return; // nothing to draw

  const tl = !!(mask & TL);
  const tr = !!(mask & TR);
  const br = !!(mask & BR);
  const bl = !!(mask & BL);

  // ── 1. Build the terrain-coverage polygon ─────────────────────────
  const verts: { x: number; y: number }[] = [];

  if (tl) verts.push({ x: 0, y: 0 });
  if (tl !== tr) verts.push({ x: C, y: 0 });
  if (tr) verts.push({ x: TS, y: 0 });
  if (tr !== br) verts.push({ x: TS, y: C });
  if (br) verts.push({ x: TS, y: TS });
  if (br !== bl) verts.push({ x: C, y: TS });
  if (bl) verts.push({ x: 0, y: TS });
  if (bl !== tl) verts.push({ x: 0, y: C });

  if (verts.length < 3) return;

  // ── 2. For partial masks, the area outside the polygon stays
  //    transparent — the water base layer shows through naturally.
  //    No background fill needed.

  // ── 3. Draw grass inside the polygon ──────────────────────────────
  drawGradientFill(g, verts, terrainId);

  if (terrainId === 'grass') {
    drawGrassDetail(g, verts, cols);
  } else if (terrainId === 'sand') {
    drawSandDetail(g, verts, cols);
  } else if (terrainId === 'water') {
    drawWaterDetail(g, verts, cols);
  }

  // ── 4. Subtle border ─────────────────────────────────────────────
  g.lineStyle(1, 0x0a0a0a, 0.08);
  g.strokeRect(0, 0, TS, TS);
}

/**
 * Draw a gradient fill clipped to the polygon. Different terrains use
 * different colour gradients matching the original BootScene tiles.
 */
function drawGradientFill(
  g: Phaser.GameObjects.Graphics,
  verts: { x: number; y: number }[],
  terrainId: string,
): void {
  // Pre-compute min/max y of the polygon for the row loop
  let minY = TS, maxY = 0;
  for (const v of verts) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(TS, Math.ceil(maxY));

  for (let y = minY; y < maxY; y++) {
    // Compute gradient colour for this row
    const t = y / TS;
    let color: number;

    if (terrainId === 'grass') {
      const osc = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 - Math.PI / 2);
      const r = Math.floor((0.14 + 0.04 * osc) * 255);
      const gr = Math.floor((0.34 + 0.10 * osc) * 255);
      const b = Math.floor((0.10 + 0.03 * osc) * 255);
      color = Phaser.Display.Color.GetColor(r, gr, b);
    } else if (terrainId === 'sand') {
      const osc = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 - Math.PI / 2);
      const r = Math.floor((0.58 + 0.08 * osc) * 255);
      const gr = Math.floor((0.50 + 0.06 * osc) * 255);
      const b = Math.floor((0.30 + 0.04 * osc) * 255);
      color = Phaser.Display.Color.GetColor(r, gr, b);
    } else {
      // Water
      const r = 0.12 + 0.02 * Math.sin(t * Math.PI);
      const gr2 = 0.22 + 0.06 * Math.sin(t * Math.PI);
      const b2 = 0.48 + 0.07 * Math.sin(t * Math.PI);
      color = Phaser.Display.Color.GetColor(
        Math.floor(r * 255), Math.floor(gr2 * 255), Math.floor(b2 * 255));
    }

    // Find x-range inside the polygon for this y row
    let x0 = TS, x1 = 0;
    for (let x = 0; x < TS; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, verts)) {
        if (x < x0) x0 = x;
        x1 = x;
      }
    }

    if (x0 <= x1) {
      g.fillStyle(color, 1);
      g.fillRect(x0, y, x1 - x0 + 1, 1);
    }
  }
}

// ─── Terrain detail drawing ───────────────────────────────────────────────

function drawGrassDetail(
  g: Phaser.GameObjects.Graphics,
  verts: { x: number; y: number }[],
  cols: TerrainColors,
): void {
  // Grass blade clusters (matching BootScene tile_buildable density)
  for (let i = 0; i < 16; i++) {
    const gx = (i * 17 + 5) % TS;
    const gy = (i * 13 + 7) % TS;

    // Skip if outside polygon
    if (!pointInPolygon(gx + 1, gy + 2, verts)) continue;

    const shade = (i % 3) === 0 ? 0.5 : 0.35;
    g.fillStyle(cols.base, shade);
    g.fillRect(gx, gy, 2, 5 + (i % 4));
  }

  // Grass highlights
  for (let i = 0; i < 10; i++) {
    const gx = (i * 23 + 3) % TS;
    const gy = (i * 19 + 11) % TS;
    if (!pointInPolygon(gx, gy + 1, verts)) continue;
    g.fillStyle(cols.light, 0.25);
    g.fillRect(gx, gy, 1, 3);
  }

  // Flowers (inside polygon)
  const flowerPositions = [
    [0.15, 0.12], [0.55, 0.08], [0.35, 0.42],
    [0.85, 0.28], [0.10, 0.62], [0.65, 0.72],
    [0.45, 0.88], [0.88, 0.55], [0.72, 0.92],
  ];
  for (const [fx, fy] of flowerPositions) {
    const px = fx * TS, py = fy * TS;
    if (!pointInPolygon(px, py, verts)) continue;
    const col = ((Math.floor(fx * 100) + Math.floor(fy * 100)) % 2 === 0) ? 0xffdd44 : 0xff9933;
    g.fillStyle(col, 0.40);
    g.fillCircle(px, py, 1.2);
  }
}

function drawSandDetail(
  g: Phaser.GameObjects.Graphics,
  verts: { x: number; y: number }[],
  cols: TerrainColors,
): void {
  // Sand grain dots
  for (let i = 0; i < 24; i++) {
    const sx = (i * 19 + 7) % TS;
    const sy = (i * 23 + 3) % TS;
    if (!pointInPolygon(sx, sy, verts)) continue;
    g.fillStyle(cols.light, 0.3);
    g.fillCircle(sx, sy, 1);
  }
  // Darker specks
  for (let i = 0; i < 12; i++) {
    const sx = (i * 13 + 11) % TS;
    const sy = (i * 17 + 5) % TS;
    if (!pointInPolygon(sx, sy, verts)) continue;
    g.fillStyle(cols.dark, 0.2);
    g.fillCircle(sx, sy, 0.8);
  }
}

function drawWaterDetail(
  g: Phaser.GameObjects.Graphics,
  verts: { x: number; y: number }[],
  _cols: TerrainColors,
): void {
  // Sine wave ripples (segment-based clipping via sample points)
  for (let row = 0; row < 3; row++) {
    const baseY = TS * (0.25 + row * 0.22);
    g.lineStyle(1.5, 0x66bbee, 0.35);
    g.beginPath();
    let started = false;
    for (let x = 0; x <= TS; x += 2) {
      const phase = (x / TS) * Math.PI * 2 + row * 1.7;
      const wy = baseY + 2.5 * Math.sin(phase);
      if (pointInPolygon(x, wy, verts)) {
        if (!started) { g.moveTo(x, wy); started = true; }
        else { g.lineTo(x, wy); }
      } else {
        started = false;
      }
    }
    g.strokePath();
  }
}

// ─── Point-in-polygon (ray casting) ───────────────────────────────────────

function pointInPolygon(
  px: number, py: number,
  verts: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y;
    const xj = verts[j].x, yj = verts[j].y;
    if ((yi > py) !== (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
