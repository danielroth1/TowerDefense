import Phaser from 'phaser';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';
import { createPRNG } from '../utils/helpers';
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
  const tile = grid[row][col];
  const pi = tile.pathIndex;
  if (pi < 0) return 0; // Not a path cell
  let mask = 0;
  if (row > 0            && isPathConnected(grid[row - 1][col], pi)) mask |= B_N;
  if (row < GRID_ROWS - 1 && isPathConnected(grid[row + 1][col], pi)) mask |= B_S;
  if (col > 0            && isPathConnected(grid[row][col - 1], pi)) mask |= B_W;
  if (col < GRID_COLS - 1 && isPathConnected(grid[row][col + 1], pi)) mask |= B_E;
  return mask;
}

/**
 * Two path cells should only be visually connected if they are consecutive
 * along the path. Without this check, path cells that are cardinally adjacent
 * but not consecutive (e.g. when the path loops back near itself) would
 * incorrectly show a blob connection.
 */
function isPathConnected(t: GridTile, fromIndex: number): boolean {
  return (t.type === 'path' || t.type === 'spawn' || t.type === 'goal')
    && Math.abs(t.pathIndex - fromIndex) === 1;
}

/** Texture key for a given blob mask. */
export function blobTileKey(mask: number): string {
  return `tile_blob_${mask}`;
}

// ─── Texture generation ────────────────────────────────────────────────────
/** Internal generation resolution scale. Higher = sharper source sampling. */
const GEN_SCALE = 4;
const TS = TILE_SIZE * GEN_SCALE;   // 192
const C  = TS / 2;                  // 96 (centre)
const HW = 14 * GEN_SCALE;          // 56 (road half-width)

// ─── Noise generation ─────────────────────────────────────────────────

const NOISE_SIZE = 64;
let _blobNoiseCache: Float32Array | null = null;

function getBlobNoise(): Float32Array {
  if (_blobNoiseCache) return _blobNoiseCache;
  const rng = createPRNG(0xE3D2C1B0); // distinct seed from terrain transition noise
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
        const ix = Math.floor(gx) % freq, iy = Math.floor(gy) % freq;
        const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const v00 = grid[iy * freq + ix];
        const v10 = grid[iy * freq + (ix + 1) % freq];
        const v01 = grid[((iy + 1) % freq) * freq + ix];
        const v11 = grid[((iy + 1) % freq) * freq + (ix + 1) % freq];
        out[y * NOISE_SIZE + x] += amp * (
          v00 * (1 - sx) * (1 - sy) + v10 * sx * (1 - sy) +
          v01 * (1 - sx) * sy       + v11 * sx * sy
        );
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= maxAmp;
  _blobNoiseCache = out;
  return out;
}

// ─── SDF helpers ─────────────────────────────────────────────────

function sdCircleBl(px: number, py: number, cx: number, cy: number, r: number): number {
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

function sdRectBl(px: number, py: number, rx: number, ry: number, rw: number, rh: number): number {
  const cx = rx + rw * 0.5, cy = ry + rh * 0.5;
  const dx = Math.abs(px - cx) - rw * 0.5;
  const dy = Math.abs(py - cy) - rh * 0.5;
  return Math.sqrt(Math.max(dx, 0) * Math.max(dx, 0) + Math.max(dy, 0) * Math.max(dy, 0))
    + Math.min(Math.max(dx, dy), 0);
}

function roadBlobArms(mask: number): { x: number; y: number; w: number; h: number }[] {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  if (mask & B_N) rects.push({ x: C - HW, y: 0,      w: HW * 2, h: C });
  if (mask & B_S) rects.push({ x: C - HW, y: C,      w: HW * 2, h: C });
  if (mask & B_W) rects.push({ x: 0,      y: C - HW, w: C,      h: HW * 2 });
  if (mask & B_E) rects.push({ x: C,      y: C - HW, w: C,      h: HW * 2 });
  const popcount = (mask & B_N ? 1 : 0) + (mask & B_S ? 1 : 0) +
                   (mask & B_W ? 1 : 0) + (mask & B_E ? 1 : 0);
  if (popcount === 1) {
    const shortLen = C - HW * 0.6;
    if (mask & B_N) rects[0] = { x: C - HW, y: 0,      w: HW * 2,  h: shortLen };
    if (mask & B_S) rects[0] = { x: C - HW, y: C,      w: HW * 2,  h: shortLen };
    if (mask & B_W) rects[0] = { x: 0,      y: C - HW, w: shortLen, h: HW * 2 };
    if (mask & B_E) rects[0] = { x: C,      y: C - HW, w: shortLen, h: HW * 2 };
  }
  return rects;
}

/** Signed distance to road blob shape. Negative = inside road, positive = grass. */
function roadBlobSDF(px: number, py: number, mask: number): number {
  const popcount = (mask & B_N ? 1 : 0) + (mask & B_S ? 1 : 0) +
                   (mask & B_W ? 1 : 0) + (mask & B_E ? 1 : 0);
  if (popcount === 0) return sdCircleBl(px, py, C, C, HW * 0.7);
  const rects = roadBlobArms(mask);
  let d = Infinity;
  if (popcount >= 2) d = Math.min(d, sdCircleBl(px, py, C, C, HW));
  if (popcount === 1) {
    const r = rects[0];
    if (mask & B_N) d = Math.min(d, sdCircleBl(px, py, C,       r.y + r.h, HW));
    if (mask & B_S) d = Math.min(d, sdCircleBl(px, py, C,       r.y,       HW));
    if (mask & B_W) d = Math.min(d, sdCircleBl(px, py, r.x + r.w, C,       HW));
    if (mask & B_E) d = Math.min(d, sdCircleBl(px, py, r.x,       C,       HW));
  }
  for (const r of rects) d = Math.min(d, sdRectBl(px, py, r.x, r.y, r.w, r.h));
  return d;
}

function smoothstepBl(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ─── Road transition constants ────────────────────────────────────────────────

/** Road edge organic noise amplitude (px). */
const ROAD_NOISE_AMP    = 3 * GEN_SCALE;   // 12
/** Smooth fade half-width (px) on grass-facing road sides. */
const ROAD_FEATHER_WATER = 3 * GEN_SCALE;  // 12
/** Sharp edge half-width (px) on path-connecting sides. */
const ROAD_FEATHER_CONN  = 0.5 * GEN_SCALE; // 2
const ROAD_CONN_ZONE     = ROAD_NOISE_AMP;

/**
 * Noise weight 0→1: 0 near connected-path tile edges (clean tiling seam),
 * 1 on grass-facing sides (full organic noise).
 */
function roadConnectedNoiseWeight(px: number, py: number, mask: number): number {
  let w = 1.0;
  const inArmX = px >= C - HW && px <= C + HW;
  const inArmY = py >= C - HW && py <= C + HW;
  if ((mask & B_N) && inArmX) w = Math.min(w, smoothstepBl(0, ROAD_CONN_ZONE, py));
  if ((mask & B_S) && inArmX) w = Math.min(w, smoothstepBl(0, ROAD_CONN_ZONE, TS - 1 - py));
  if ((mask & B_W) && inArmY) w = Math.min(w, smoothstepBl(0, ROAD_CONN_ZONE, px));
  if ((mask & B_E) && inArmY) w = Math.min(w, smoothstepBl(0, ROAD_CONN_ZONE, TS - 1 - px));
  return w;
}

// ─── Shared pixel-blend inner loop ───────────────────────────────────────────

/**
 * Blend roadData over grassData using the road SDF + noise, writing to od.
 * Output is always fully opaque (road visible in centre, grass at edges).
 */
function blendRoadOverGrass(
  od: Uint8ClampedArray,
  roadData: Uint8ClampedArray,
  grassData: Uint8ClampedArray,
  mask: number,
  noise: Float32Array,
): void {
  for (let py = 0; py < TS; py++) {
    for (let px = 0; px < TS; px++) {
      const sdf = roadBlobSDF(px, py, mask);
      const n   = noise[(py % NOISE_SIZE) * NOISE_SIZE + (px % NOISE_SIZE)] - 0.5;
      const nw  = roadConnectedNoiseWeight(px, py, mask);
      const feather = ROAD_FEATHER_CONN + (ROAD_FEATHER_WATER - ROAD_FEATHER_CONN) * nw;
      const bias    = ROAD_FEATHER_WATER * (1.0 - nw);
      const rA = 1 - smoothstepBl(-feather, feather, sdf - bias + n * ROAD_NOISE_AMP * nw);
      const i = (py * TS + px) * 4;
      od[i]     = Math.round(roadData[i]   * rA + grassData[i]   * (1 - rA));
      od[i + 1] = Math.round(roadData[i+1] * rA + grassData[i+1] * (1 - rA));
      od[i + 2] = Math.round(roadData[i+2] * rA + grassData[i+2] * (1 - rA));
      od[i + 3] = 255;
    }
  }
}

// ─── Public generation functions ─────────────────────────────────────────────

/**
 * Generate all 16 blob tile textures. Background uses the AI grass texture if
 * loaded, falling back to a procedural gradient. Road is a deterministic
 * stone-grid colour. Road→grass edge uses SDF + noise (no stepped bands).
 */
export function generateBlobTextures(scene: Phaser.Scene): void {
  let grassData: Uint8ClampedArray | null = null;
  if (scene.textures.exists('tile_grass')) {
    const gi  = scene.textures.get('tile_grass').getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const tmp = document.createElement('canvas');
    tmp.width = TS; tmp.height = TS;
    tmp.getContext('2d')!.drawImage(gi, 0, 0, TS, TS);
    grassData = tmp.getContext('2d')!.getImageData(0, 0, TS, TS).data;
  }
  const noise = getBlobNoise();

  for (let mask = 0; mask < 16; mask++) {
    const key = blobTileKey(mask);
    if (scene.textures.exists(key)) continue;
    const ct = scene.textures.createCanvas(key, TS, TS);
    if (!ct) continue;
    const ctx = ct.getContext();
    const out = ctx.createImageData(TS, TS);
    blendRoadOverGrass(
      out.data,
      buildStonePixels(),
      grassData ?? buildGradientGrassPixels(),
      mask,
      noise,
    );
    ctx.putImageData(out, 0, 0);
    ct.refresh();
  }
}

/**
 * Generate 16 blob tiles by blending an AI path source texture over the AI grass
 * background. Road→grass edge uses SDF + noise for a smooth, organic transition.
 */
export function generateBlobTexturesFromSource(
  scene: Phaser.Scene,
  sourceKey: string,
  prefix: string,
): void {
  const readPixels = (img: HTMLImageElement | HTMLCanvasElement) => {
    const tmp = document.createElement('canvas');
    tmp.width = TS; tmp.height = TS;
    tmp.getContext('2d')!.drawImage(img, 0, 0, TS, TS);
    return tmp.getContext('2d')!.getImageData(0, 0, TS, TS).data;
  };
  const srcData   = readPixels(scene.textures.get(sourceKey).getSourceImage() as HTMLImageElement | HTMLCanvasElement);
  const grassData = readPixels(scene.textures.get('tile_grass').getSourceImage() as HTMLImageElement | HTMLCanvasElement);
  const noise     = getBlobNoise();

  for (let mask = 0; mask < 16; mask++) {
    const key = `${prefix}_${mask}`;
    if (scene.textures.exists(key)) scene.textures.remove(key);
    const ct = scene.textures.createCanvas(key, TS, TS);
    if (!ct) continue;
    const ctx = ct.getContext();
    const out = ctx.createImageData(TS, TS);
    blendRoadOverGrass(out.data, srcData, grassData, mask, noise);
    ctx.putImageData(out, 0, 0);
    ct.refresh();
  }
}

// ─── Helpers for procedural road pixels ──────────────────────────────────────

function buildGradientGrassPixels(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(TS * TS * 4);
  for (let py = 0; py < TS; py++) {
    const t   = py / TS;
    const osc = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 - Math.PI / 2);
    const r   = Math.floor((0.14 + 0.04 * osc) * 255);
    const g   = Math.floor((0.34 + 0.10 * osc) * 255);
    const b   = Math.floor((0.10 + 0.03 * osc) * 255);
    for (let px = 0; px < TS; px++) {
      const i = (py * TS + px) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return data;
}

/** Flat RGBA array of deterministic cobblestone-grid colours. */
function buildStonePixels(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(TS * TS * 4);
  const cw = TS / 3, ch = TS / 3;
  for (let py = 0; py < TS; py++) {
    const ri  = Math.floor(py / ch);
    const off = (ri % 2 === 1) ? cw * 0.5 : 0;
    for (let px = 0; px < TS; px++) {
      const ci = Math.floor(((px + off) % TS) / cw);
      let r: number, g: number, b: number;
      switch ((ri * 3 + ci) % 3) {
        case 0:  r = 0x9a; g = 0x8e; b = 0x70; break; // light stone
        case 1:  r = 0x7a; g = 0x6e; b = 0x58; break; // base stone
        default: r = 0x5a; g = 0x4e; b = 0x30;         // dark stone
      }
      const i = (py * TS + px) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return data;
}
