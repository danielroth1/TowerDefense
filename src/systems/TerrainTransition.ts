import Phaser from 'phaser';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';
import { createPRNG } from '../utils/helpers';

/*
 * ─── Terrain Auto-Tiling: Blob-Based Transition ──────────────────────────
 *
 * Each terrain cell uses a 4-bit cardinal-neighbor mask (0–15) to select
 * one of 16 transition textures. The terrain blob shape is defined by
 * rectangular arms + circular end caps, but the visible edge is derived
 * from a signed distance field (SDF) perturbed by multi-octave value noise.
 *
 * This removes all visible banding (the old stepped-alpha approach) and
 * gives an organic, coastline-like edge between grass and water.
 *
 * Bit weights (cardinal neighbors):
 *   North (N) = 1     East (E) = 2
 *   South (S) = 4     West (W) = 8
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
  const noise = getTransitionNoise();

  for (let mask = 0; mask < 16; mask++) {
    const key = transitionTileKey(terrainId, mask);
    if (scene.textures.exists(key)) continue;

    const ct = scene.textures.createCanvas(key, TS, TS);
    if (!ct) continue;
    const ctx = ct.getContext();

    // Per-mask noise offset gives each transition variant a unique edge shape
    const noiseOffX = (mask * 17 + 3) % NOISE_SIZE;
    const noiseOffY = (mask * 11 + 7) % NOISE_SIZE;
    if (sourceTextureKey && scene.textures.exists(sourceTextureKey)) {
      // ── AI-source path: bake source texture through SDF+noise mask ──
      const srcTex = scene.textures.get(sourceTextureKey);
      const srcImg = srcTex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
      drawTransitionSDF(ctx, mask, srcImg, noise, halfWidth, noiseOffX, noiseOffY);
    } else {
      // ── Procedural path: compute gradient colour per pixel ──
      drawTransitionSDFProc(ctx, mask, terrainId, noise, halfWidth, noiseOffX, noiseOffY);
    }

    ct.refresh();
  }
}

// ─── Blob shape helpers ──────────────────────────────────────────────────

/** Build the arm rectangles for a given blob mask and half-width. */
function blobArms(mask: number, hw: number): { x: number; y: number; w: number; h: number }[] {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  if (mask & B_N) rects.push({ x: C - hw, y: 0,      w: hw * 2, h: C });
  if (mask & B_S) rects.push({ x: C - hw, y: C,      w: hw * 2, h: C });
  if (mask & B_W) rects.push({ x: 0,      y: C - hw, w: C,      h: hw * 2 });
  if (mask & B_E) rects.push({ x: C,      y: C - hw, w: C,      h: hw * 2 });

  const popcount = blobPopcount(mask);
  if (popcount === 1) {
    const shortLen = C - hw * 0.6;
    if (mask & B_N) rects[0] = { x: C - hw, y: 0,      w: hw * 2,  h: shortLen };
    if (mask & B_S) rects[0] = { x: C - hw, y: C,      w: hw * 2,  h: shortLen };
    if (mask & B_W) rects[0] = { x: 0,      y: C - hw, w: shortLen, h: hw * 2 };
    if (mask & B_E) rects[0] = { x: C,      y: C - hw, w: shortLen, h: hw * 2 };
  }
  return rects;
}

function blobPopcount(mask: number): number {
  return (mask & B_N ? 1 : 0) + (mask & B_S ? 1 : 0) +
         (mask & B_W ? 1 : 0) + (mask & B_E ? 1 : 0);
}

// ─── Multi-octave value noise ─────────────────────────────────────────────

const NOISE_SIZE = 64;
let _noiseCache: Float32Array | null = null;

/** Return a cached 64×64 seamlessly-tiling multi-octave value noise (0..1). */
function getTransitionNoise(): Float32Array {
  if (_noiseCache) return _noiseCache;
  const rng = createPRNG(0xF7A3B5C1); // fixed seed — always deterministic
  const out = new Float32Array(NOISE_SIZE * NOISE_SIZE);
  const octaves = [
    { freq: 4,  amp: 1.00 },
    { freq: 8,  amp: 0.50 },
    { freq: 16, amp: 0.25 },
  ];
  let maxAmp = 0;
  for (const oct of octaves) maxAmp += oct.amp;

  for (const { freq, amp } of octaves) {
    const grid = new Float32Array(freq * freq);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();

    for (let y = 0; y < NOISE_SIZE; y++) {
      for (let x = 0; x < NOISE_SIZE; x++) {
        const gx = (x / NOISE_SIZE) * freq;
        const gy = (y / NOISE_SIZE) * freq;
        const ix = Math.floor(gx) % freq;
        const iy = Math.floor(gy) % freq;
        const fx = gx - Math.floor(gx);
        const fy = gy - Math.floor(gy);
        // Smoothstep interpolation (removes bilinear grid artefacts)
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const v00 = grid[iy * freq + ix];
        const v10 = grid[iy * freq + (ix + 1) % freq];
        const v01 = grid[((iy + 1) % freq) * freq + ix];
        const v11 = grid[((iy + 1) % freq) * freq + (ix + 1) % freq];
        out[y * NOISE_SIZE + x] += amp * (
          v00 * (1 - sx) * (1 - sy) +
          v10 * sx * (1 - sy) +
          v01 * (1 - sx) * sy +
          v11 * sx * sy
        );
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= maxAmp;
  _noiseCache = out;
  return out;
}

// ─── SDF helpers ─────────────────────────────────────────────────────────

/** Signed distance to a circle. Negative = inside. */
function sdCircle(px: number, py: number, cx: number, cy: number, r: number): number {
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/** Signed distance to an axis-aligned rectangle. Negative = inside. */
function sdRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number): number {
  const cx = rx + rw * 0.5, cy = ry + rh * 0.5;
  const dx = Math.abs(px - cx) - rw * 0.5;
  const dy = Math.abs(py - cy) - rh * 0.5;
  // Outside: Euclidean to nearest corner; inside: max penetration depth (negative)
  return Math.sqrt(
    Math.max(dx, 0) * Math.max(dx, 0) + Math.max(dy, 0) * Math.max(dy, 0),
  ) + Math.min(Math.max(dx, dy), 0);
}

/**
 * Signed distance to the terrain blob shape for a given mask.
 * Negative = inside the terrain region, positive = outside (water).
 */
function signedDistanceToBlob(px: number, py: number, mask: number, hw: number): number {
  const popcount = blobPopcount(mask);

  if (popcount === 0) {
    return sdCircle(px, py, C, C, hw * 0.7);
  }

  const rects = blobArms(mask, hw);
  let d = Infinity;

  // Centre circle blends multi-arm junctions
  if (popcount >= 2) {
    d = Math.min(d, sdCircle(px, py, C, C, hw));
  }

  // End-cap circle caps the single arm
  if (popcount === 1) {
    const r = rects[0];
    if (mask & B_N) d = Math.min(d, sdCircle(px, py, C,       r.y + r.h, hw));
    if (mask & B_S) d = Math.min(d, sdCircle(px, py, C,       r.y,       hw));
    if (mask & B_W) d = Math.min(d, sdCircle(px, py, r.x + r.w, C,       hw));
    if (mask & B_E) d = Math.min(d, sdCircle(px, py, r.x,       C,       hw));
  }

  for (const r of rects) {
    d = Math.min(d, sdRect(px, py, r.x, r.y, r.w, r.h));
  }

  return d;
}

/** Cubic smooth-step: 0 at edge0, 1 at edge1. */
function smoothstepFn(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ─── SDF + noise drawing ─────────────────────────────────────────────────

/**
 * Noise amplitude in pixels — how far the edge can waver from the geometric
 * blob boundary. Larger values = more organic/jagged coast.
 */
const NOISE_AMP   = 9;
/**
 * Smooth fade half-width (px) on water-facing sides.
 * The visible blend zone is 2× this wide (feather px of grass fades into water).
 */
const FEATHER_WATER = 7;
/**
 * Sharp-edge half-width (px) on grass-connecting sides.
 * Kept small so the arm connection is effectively solid.
 */
const FEATHER_CONN  = 0.5;
/**
 * Zone (px) near a connected tile edge where noise is suppressed to 0.
 * Must be ≥ NOISE_AMP/2 so noise can never create gaps at connections.
 */
const CONN_ZONE = NOISE_AMP;

/**
 * Returns a 0→1 weight that suppresses noise near any tile edge that has a
 * connected grass arm (bit set in mask).  1 = full noise (water-facing side);
 * 0 = no noise (grass-connecting side, clean hard edge).
 */
function connectedEdgeNoiseWeight(px: number, py: number, mask: number): number {
  let w = 1.0;
  if (mask & B_N) w = Math.min(w, smoothstepFn(0, CONN_ZONE, py));
  if (mask & B_S) w = Math.min(w, smoothstepFn(0, CONN_ZONE, TS - 1 - py));
  if (mask & B_W) w = Math.min(w, smoothstepFn(0, CONN_ZONE, px));
  if (mask & B_E) w = Math.min(w, smoothstepFn(0, CONN_ZONE, TS - 1 - px));
  return w;
}

/**
 * Draw a transition tile onto ctx by combining an AI source texture with
 * the blob SDF perturbed by noise.  No banding — fully smooth alpha.
 */
function drawTransitionSDF(
  ctx: CanvasRenderingContext2D,
  mask: number,
  srcImg: HTMLImageElement | HTMLCanvasElement,
  noise: Float32Array,
  hw: number,
  noiseOffX: number = 0,
  noiseOffY: number = 0,
): void {
  // Read source pixels via a temporary canvas (safe for same-origin assets)
  const tmp = document.createElement('canvas');
  tmp.width = TS;
  tmp.height = TS;
  const tmpCtx = tmp.getContext('2d')!;
  tmpCtx.drawImage(srcImg, 0, 0, TS, TS);
  const src = tmpCtx.getImageData(0, 0, TS, TS).data;

  const out = ctx.createImageData(TS, TS);
  const od  = out.data;

  for (let py = 0; py < TS; py++) {
    for (let px = 0; px < TS; px++) {
      const sdf = signedDistanceToBlob(px, py, mask, hw);
      const n   = noise[((py + noiseOffY) % NOISE_SIZE) * NOISE_SIZE + ((px + noiseOffX) % NOISE_SIZE)] - 0.5;
      const nw  = connectedEdgeNoiseWeight(px, py, mask);
      // Water-facing: wide smooth fade + organic noise.
      // Connected side: sharp edge pushed inward so sdf=0 at tile boundary → alpha=1.
      const feather = FEATHER_CONN + (FEATHER_WATER - FEATHER_CONN) * nw;
      const bias    = FEATHER_WATER * (1.0 - nw);
      const d       = sdf - bias + n * NOISE_AMP * nw;
      const alpha   = 1 - smoothstepFn(-feather, feather, d);
      if (alpha <= 0) continue;

      const i = (py * TS + px) * 4;
      od[i]     = src[i];
      od[i + 1] = src[i + 1];
      od[i + 2] = src[i + 2];
      od[i + 3] = Math.round(alpha * 255);
    }
  }

  ctx.putImageData(out, 0, 0);
}

/**
 * Draw a procedural transition tile onto ctx using per-pixel gradient colour
 * and the same SDF+noise alpha as the AI-source path.
 */
function drawTransitionSDFProc(
  ctx: CanvasRenderingContext2D,
  mask: number,
  terrainId: string,
  noise: Float32Array,
  hw: number,
  noiseOffX: number = 0,
  noiseOffY: number = 0,
): void {
  const out = ctx.createImageData(TS, TS);
  const od  = out.data;

  for (let py = 0; py < TS; py++) {
    const col = terrainColorAt(py, terrainId);
    for (let px = 0; px < TS; px++) {
      const sdf = signedDistanceToBlob(px, py, mask, hw);
      const n   = noise[((py + noiseOffY) % NOISE_SIZE) * NOISE_SIZE + ((px + noiseOffX) % NOISE_SIZE)] - 0.5;
      const nw  = connectedEdgeNoiseWeight(px, py, mask);
      const feather = FEATHER_CONN + (FEATHER_WATER - FEATHER_CONN) * nw;
      const bias    = FEATHER_WATER * (1.0 - nw);
      const d       = sdf - bias + n * NOISE_AMP * nw;
      const alpha   = 1 - smoothstepFn(-feather, feather, d);
      if (alpha <= 0) continue;

      const i = (py * TS + px) * 4;
      od[i]     = col.r;
      od[i + 1] = col.g;
      od[i + 2] = col.b;
      od[i + 3] = Math.round(alpha * 255);
    }
  }

  ctx.putImageData(out, 0, 0);
}

/** Per-row gradient colour for procedural terrain (returned as {r,g,b}). */
function terrainColorAt(py: number, terrainId: string): { r: number; g: number; b: number } {
  const t   = py / TS;
  const osc = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 - Math.PI / 2);
  if (terrainId === 'grass') {
    return {
      r: Math.floor((0.14 + 0.04 * osc) * 255),
      g: Math.floor((0.34 + 0.10 * osc) * 255),
      b: Math.floor((0.10 + 0.03 * osc) * 255),
    };
  }
  if (terrainId === 'sand') {
    return {
      r: Math.floor((0.58 + 0.08 * osc) * 255),
      g: Math.floor((0.50 + 0.06 * osc) * 255),
      b: Math.floor((0.30 + 0.04 * osc) * 255),
    };
  }
  // Water fallback
  return {
    r: Math.floor((0.12 + 0.02 * Math.sin(t * Math.PI)) * 255),
    g: Math.floor((0.22 + 0.06 * Math.sin(t * Math.PI)) * 255),
    b: Math.floor((0.48 + 0.07 * Math.sin(t * Math.PI)) * 255),
  };
}
