import Phaser from 'phaser';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';

/*
 * ─── Terrain Auto-Tiling: Blob-Based Transition ──────────────────────────
 *
 * Each terrain cell uses a 4-bit cardinal-neighbor mask (0–15) to select
 * one of 16 transition textures. The terrain is drawn as a rounded blob
 * with rectangular arms + circular end caps, matching the path blob system.
 *
 * Bit weights (cardinal neighbors):
 *   North (N) = 1     East (E) = 2
 *   South (S) = 4     West (W) = 8
 *
 * Smooth grass-to-water blending is achieved via expanding alpha bands
 * (outer → inner), identical in approach to BlobTileset.
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

// ─── Blob bit constants (cardinal neighbors) ──────────────────────────────

const B_N = 0x1, B_E = 0x2, B_S = 0x4, B_W = 0x8;

/**
 * Compute the 4-bit blob mask (0–15) for a terrain cell at (row, col).
 *
 * Each bit is set when the corresponding cardinal neighbour is NOT water
 * (i.e. type !== 'ground'). Path / spawn / goal cells count as solid so the
 * terrain blob extends right up to the path without a visual gap.
 */
export function computeTerrainBlobMask(
  grid: { type: string }[][],
  row: number,
  col: number,
): number {
  let mask = 0;
  if (row > 0                && grid[row - 1][col].type !== 'ground') mask |= B_N;
  if (row < GRID_ROWS - 1    && grid[row + 1][col].type !== 'ground') mask |= B_S;
  if (col > 0                && grid[row][col - 1].type !== 'ground') mask |= B_W;
  if (col < GRID_COLS - 1    && grid[row][col + 1].type !== 'ground') mask |= B_E;
  return mask;
}

/** Texture key for a transition tile. */
export function transitionTileKey(terrainId: string, mask: number): string {
  return `tile_trans_${terrainId}_${mask}`;
}

// ─── Texture generation ───────────────────────────────────────────────────

const TS = TILE_SIZE;   // 48
const C  = TS / 2;       // 24 (centre)

/**
 * Generate all 16 transition tile textures for a given terrain type and
 * register them in Phaser's texture manager.
 *
 * Call this during BootScene.create() after the base tiles are ready.
 *
 * @param scene             — Phaser scene
 * @param terrainId         — terrain identifier ('grass', 'sand', 'water')
 * @param sourceTextureKey  — (optional) if set, bake this texture into the
 *                            blob shape (e.g. AI tile_grass).
 * @param halfWidth         — blob half-width in px (default 20).
 *                            Higher values make the terrain reach closer to
 *                            the tile edge.  Must be ≤ C (24) for arm rects
 *                            to stay within the tile.
 */
export function generateTransitionTextures(
  scene: Phaser.Scene,
  terrainId: string,
  sourceTextureKey?: string,
  halfWidth: number = 24,
): void {
  for (let mask = 0; mask < 16; mask++) {
    const key = transitionTileKey(terrainId, mask);
    if (scene.textures.exists(key)) continue;

    if (sourceTextureKey && scene.textures.exists(sourceTextureKey)) {
      // ── AI-source: draw blob-shaped grass with smooth transition bands ──
      const srcTex = scene.textures.get(sourceTextureKey);
      const srcImg = srcTex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;

      const ct = scene.textures.createCanvas(key, TS, TS);
      if (!ct) continue;
      const ctx = ct.getContext();

      drawTransitionBlobSource(ctx, mask, srcImg, halfWidth);
      ct.refresh();
    } else {
      // ── Procedural: draw gradient-filled blob ──
      const g = scene.add.graphics();
      drawTransitionBlobProc(g, mask, terrainId, halfWidth);
      g.generateTexture(key, TS, TS);
      g.destroy();
    }
  }
}

// ─── Blob shape helpers ──────────────────────────────────────────────────

/** Build the arm rectangles for a given blob mask and half-width. */
function blobArms(mask: number, hw: number): { x: number; y: number; w: number; h: number }[] {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  if (mask & B_N) rects.push({ x: C - hw, y: 0,     w: hw * 2, h: C });
  if (mask & B_S) rects.push({ x: C - hw, y: C,     w: hw * 2, h: C });
  if (mask & B_W) rects.push({ x: 0,      y: C - hw, w: C,      h: hw * 2 });
  if (mask & B_E) rects.push({ x: C,      y: C - hw, w: C,      h: hw * 2 });

  const popcount = (mask & B_N ? 1 : 0) + (mask & B_S ? 1 : 0) +
                   (mask & B_W ? 1 : 0) + (mask & B_E ? 1 : 0);

  if (popcount === 1) {
    const shortLen = C - hw * 0.6;
    if (mask & B_N) rects[0] = { x: C - hw, y: 0, w: hw * 2, h: shortLen };
    if (mask & B_S) rects[0] = { x: C - hw, y: C, w: hw * 2, h: shortLen };
    if (mask & B_W) rects[0] = { x: 0, y: C - hw, w: shortLen, h: hw * 2 };
    if (mask & B_E) rects[0] = { x: C, y: C - hw, w: shortLen, h: hw * 2 };
  }
  return rects;
}

function blobPopcount(mask: number): number {
  return (mask & B_N ? 1 : 0) + (mask & B_S ? 1 : 0) +
         (mask & B_W ? 1 : 0) + (mask & B_E ? 1 : 0);
}

// ─── Canvas drawing (AI-source) ──────────────────────────────────────────

/**
 * Draw a blob-shaped terrain transition onto a canvas context using an
 * AI source texture. Expanding alpha bands create a smooth grass→water edge.
 */
function drawTransitionBlobSource(
  ctx: CanvasRenderingContext2D,
  mask: number,
  srcImg: HTMLImageElement | HTMLCanvasElement,
  hw: number,
): void {
  const rects = blobArms(mask, hw);
  const popcount = blobPopcount(mask);

  if (popcount === 0) {
    // Isolated — small rounded blob at centre
    ctx.save();
    ctx.beginPath();
    ctx.arc(C, C, hw * 0.7, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(srcImg, 0, 0, TS, TS);
    ctx.restore();
    drawBorder(ctx);
    return;
  }

  // Transition bands (outer → inner, same pattern as BlobTileset)
  const bands = [
    { alpha: 0.12, expand: 5 },
    { alpha: 0.35, expand: 2 },
    { alpha: 0.70, expand: 0 },
    { alpha: 1.00, expand: 0 },
  ];

  for (const band of bands) {
    const e = band.expand;
    ctx.save();
    ctx.globalAlpha = band.alpha;
    ctx.beginPath();
    clipBlobShape(ctx, mask, rects, popcount, e, hw);
    ctx.drawImage(srcImg, 0, 0, TS, TS);
    ctx.restore();
  }

  drawBorder(ctx);
}

/** Add the blob path (rects + circles) to the canvas context and clip. */
function clipBlobShape(
  ctx: CanvasRenderingContext2D,
  mask: number,
  rects: { x: number; y: number; w: number; h: number }[],
  popcount: number,
  expand: number,
  hw: number,
): void {
  for (const r of rects) {
    ctx.rect(r.x - expand, r.y - expand, r.w + expand * 2, r.h + expand * 2);
  }

  if (popcount >= 2) {
    const circleR = hw + (expand === 5 ? 0 : expand);
    ctx.moveTo(C + circleR, C);
    ctx.arc(C, C, circleR, 0, Math.PI * 2);
  }

  if (popcount === 1) {
    if (mask & B_N)
      ctx.arc(C, rects[0].y + rects[0].h + expand, hw + expand, 0, Math.PI * 2);
    if (mask & B_S)
      ctx.arc(C, rects[0].y - expand, hw + expand, 0, Math.PI * 2);
    if (mask & B_W)
      ctx.arc(rects[0].x + rects[0].w + expand, C, hw + expand, 0, Math.PI * 2);
    if (mask & B_E)
      ctx.arc(rects[0].x - expand, C, hw + expand, 0, Math.PI * 2);
  }

  ctx.clip();
}

function drawBorder(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = 'rgba(10,10,10,0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, TS, TS);
}

// ─── Graphics drawing (procedural) ───────────────────────────────────────

/**
 * Draw a blob-shaped terrain transition using Phaser Graphics (procedural
 * fallback when no AI source texture is available).
 */
function drawTransitionBlobProc(
  g: Phaser.GameObjects.Graphics,
  mask: number,
  terrainId: string,
  hw: number,
): void {
  const rects = blobArms(mask, hw);
  const popcount = blobPopcount(mask);

  if (popcount === 0) {
    // Isolated — small rounded blob at centre
    const col = gradientColor(TS / 2, terrainId);
    g.fillStyle(col, 1);
    g.fillCircle(C, C, hw * 0.7);
    g.lineStyle(1, 0x0a0a0a, 0.08);
    g.strokeRect(0, 0, TS, TS);
    return;
  }

  const bands = [
    { alpha: 0.12, expand: 5 },
    { alpha: 0.35, expand: 2 },
    { alpha: 0.70, expand: 0 },
    { alpha: 1.00, expand: 0 },
  ];

  for (const band of bands) {
    const e = band.expand;
    const col = gradientColor(C, terrainId);
    g.fillStyle(col, band.alpha);

    for (const r of rects) {
      g.fillRect(r.x - e, r.y - e, r.w + e * 2, r.h + e * 2);
    }

    if (popcount >= 2) {
      const circleR = hw + (band.expand === 5 ? 0 : e);
      g.fillCircle(C, C, circleR);
    }

    if (popcount === 1) {
      if (mask & B_N)
        g.fillCircle(C, rects[0].y + rects[0].h + e, hw + e);
      if (mask & B_S)
        g.fillCircle(C, rects[0].y - e, hw + e);
      if (mask & B_W)
        g.fillCircle(rects[0].x + rects[0].w + e, C, hw + e);
      if (mask & B_E)
        g.fillCircle(rects[0].x - e, C, hw + e);
    }
  }

  g.lineStyle(1, 0x0a0a0a, 0.08);
  g.strokeRect(0, 0, TS, TS);
}

/** Single-column gradient colour matching the given terrain at height t (0–1). */
function gradientColor(y: number, terrainId: string): number {
  const t = y / TS;
  if (terrainId === 'grass') {
    const osc = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 - Math.PI / 2);
    const r = Math.floor((0.14 + 0.04 * osc) * 255);
    const gr = Math.floor((0.34 + 0.10 * osc) * 255);
    const b = Math.floor((0.10 + 0.03 * osc) * 255);
    return Phaser.Display.Color.GetColor(r, gr, b);
  }
  if (terrainId === 'sand') {
    const osc = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 - Math.PI / 2);
    const r = Math.floor((0.58 + 0.08 * osc) * 255);
    const gr = Math.floor((0.50 + 0.06 * osc) * 255);
    const b = Math.floor((0.30 + 0.04 * osc) * 255);
    return Phaser.Display.Color.GetColor(r, gr, b);
  }
  // Water
  const r = 0.12 + 0.02 * Math.sin(t * Math.PI);
  const gr2 = 0.22 + 0.06 * Math.sin(t * Math.PI);
  const b2 = 0.48 + 0.07 * Math.sin(t * Math.PI);
  return Phaser.Display.Color.GetColor(
    Math.floor(r * 255), Math.floor(gr2 * 255), Math.floor(b2 * 255));
}
