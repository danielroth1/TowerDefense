import { TILE_SIZE } from './constants';

/**
 * Deterministically selects a unique 48×48 crop region from a source texture
 * for each grid cell.  This gives every tile a different view of the AI
 * texture, eliminating visible repetition while rendering at 1:1 pixels
 * (no GPU scaling → no aliasing, no blur).
 *
 * Usage:
 *   const { cropX, cropY } = pickCrop(row, col, mapSeed, texWidth, texHeight);
 *   sprite.setCrop(cropX, cropY, TILE_SIZE, TILE_SIZE);
 *   sprite.setDisplaySize(TILE_SIZE, TILE_SIZE);
 */

const CROP_W = TILE_SIZE;
const CROP_H = TILE_SIZE;

/** Simple 32-bit hash for deterministic pseudo-random crop positions. */
function hash3(a: number, b: number, c: number): number {
  // Knuth-style multiplicative hash with mixing
  let h = ((a * 0x9E3779B9) ^ (b * 0x85EBCA77) ^ (c * 0xC2B2AE35)) >>> 0;
  h = ((h ^ (h >>> 16)) * 0x85EBCA6B) >>> 0;
  h = ((h ^ (h >>> 13)) * 0xC2B2AE35) >>> 0;
  return h ^ (h >>> 16);
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pick a crop rectangle for the tile at (row, col).
 *
 * @param row      Grid row index
 * @param col      Grid column index
 * @param seed     Map seed for reproducibility
 * @param texW     Source texture width in pixels
 * @param texH     Source texture height in pixels
 * @returns        Crop rectangle in source-pixel coordinates
 */
export function pickCrop(
  row: number,
  col: number,
  seed: number,
  texW: number,
  texH: number,
): CropRect {
  const maxX = texW - CROP_W;
  const maxY = texH - CROP_H;

  // If the texture is already at or below tile size, use the whole thing
  if (maxX <= 0 || maxY <= 0) {
    return { x: 0, y: 0, w: CROP_W, h: CROP_H };
  }

  // Hash row/col/seed to get a deterministic offset.
  // We xor the high bits into the low bits so small changes in row/col
  // produce large changes in the crop position (adjacent tiles differ).
  const h = hash3(row, col, seed);
  const x = h % (maxX + 1);
  const y = ((h * 0x9E3779B9 + 0x85EBCA77) >>> 0) % (maxY + 1);

  return { x, y, w: CROP_W, h: CROP_H };
}

/**
 * Check whether a texture is large enough to support crop-based variation
 * (must be bigger than TILE_SIZE in at least one dimension).
 */
export function supportsCropVariation(texW: number, texH: number): boolean {
  return texW > CROP_W || texH > CROP_H;
}
