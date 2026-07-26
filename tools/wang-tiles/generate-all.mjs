#!/usr/bin/env node
/**
 * Generate Wang tile sets for all terrain textures in public/assets/tiles/.
 *
 * Skips tower textures, transition tiles, blob tiles, and existing Wang tiles.
 * Only processes base terrain textures: tile_water, tile_grass, tile_sand,
 * tile_path, tile_spawn, tile_goal.
 *
 * Usage:
 *   node tools/wang-tiles/generate-all.mjs [tileSize]              # default: --blend-freq, force (overwrite existing)
 *   node tools/wang-tiles/generate-all.mjs --blend-crop [tileSize]  # bilinear corner-weighted blending
 *   node tools/wang-tiles/generate-all.mjs --blend-freq [tileSize]  # frequency-separated edge blending
 *   node tools/wang-tiles/generate-all.mjs --strips [tileSize]      # Cohen et al. strip search
 *   node tools/wang-tiles/generate-all.mjs --cutpaths [tileSize]    # Cohen DP cut paths
 *   node tools/wang-tiles/generate-all.mjs --canonical [tileSize]   # Cohen O(W·H) DP (best)
 *   node tools/wang-tiles/generate-all.mjs --coons [tileSize]       # Cohen proper decoupled mapping
 *   node tools/wang-tiles/generate-all.mjs --diamond [tileSize]     # Cohen sample-diamond quilting for 16 corner-bit tiles
 *   node tools/wang-tiles/generate-all.mjs --diamondcut [tileSize]  # Cohen diamond sample + seam cutting (DP quilting)
 *   node tools/wang-tiles/generate-all.mjs --quilt [tileSize]       # Cohen diamond-cut image quilting
 *   node tools/wang-tiles/generate-all.mjs --quadrant [tileSize]    # diagonal swap (original default)
 *   node tools/wang-tiles/generate-all.mjs --no-force [tileSize]    # skip if Wang tiles already exist
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const TILES_DIR = 'public/assets/tiles';

// Parse args: --blend-crop/--blend-freq/--strips/--cutpaths/--canonical/--coons/--diamond/--diamondcut/--quilt/--quadrant flags, tileSize is first numeric arg
const args = process.argv.slice(2);
const useBlendCrop  = args.includes('--blend-crop');
const useBlendFreq  = args.includes('--blend-freq');
const useStrips     = args.includes('--strips');
const useCutpaths   = args.includes('--cutpaths');
const useCanonical  = args.includes('--canonical');
const useCoons      = args.includes('--coons');
const useDiamond    = args.includes('--diamond');
const useDiamondcut = args.includes('--diamondcut');
const useQuilt      = args.includes('--quilt');
const useQuadrant   = args.includes('--quadrant');
const force     = !args.includes('--no-force');  // default: true (overwrite existing)
const tileSize  = parseInt(args.find(a => /^\d+$/.test(a)), 10) || 192;

const SCRIPT = useBlendCrop
  ? 'tools/wang-tiles/generate-blend-crop.mjs'
  : useBlendFreq
  ? 'tools/wang-tiles/generate-blend-freq.mjs'
  : useQuilt
  ? 'tools/wang-tiles/generate-cohen-quilt.mjs'
  : useDiamondcut
  ? 'tools/wang-tiles/generate-cohen-diamondcut.mjs'
  : useDiamond
  ? 'tools/wang-tiles/generate-cohen-diamond.mjs'
  : useCoons
  ? 'tools/wang-tiles/generate-cohen-coons.mjs'
  : useCanonical
    ? 'tools/wang-tiles/generate-cohen-canonical.mjs'
    : useCutpaths
      ? 'tools/wang-tiles/generate-cohen-cutpaths.mjs'
      : useStrips
        ? 'tools/wang-tiles/generate-cohen-strips.mjs'
        : useQuadrant
          ? 'tools/wang-tiles/generate-quadrant.mjs'
          : 'tools/wang-tiles/generate-blend-freq.mjs';

const algoName = useBlendCrop ? 'bilinear corner-weighted blending' : useBlendFreq ? 'frequency-separated edge blending' : useQuilt ? 'Cohen et al. diamond-cut quilting (graph-cut DP on overlap bands + diagonal centre)' : useDiamondcut ? 'Cohen et al. diamond sample + seam cutting (DP quilting)' : useDiamond ? 'Cohen et al. sample-diamond quilting (16 corner-bit adaptation)' : useCoons ? 'Cohen et al. v4 proper decoupled mapping' : useCanonical ? 'Cohen et al. O(W·H) DP' : useCutpaths ? 'Cohen et al. DP cut paths' : useStrips ? 'Cohen et al. strip search' : useQuadrant ? 'diagonal swap' : 'frequency-separated edge blending';
console.log(`Using ${algoName} algorithm (${SCRIPT})`);
console.log(`Mode: ${force ? '--force (overwrite existing)' : '--no-force (skip existing)'}`);

// Which base textures to generate Wang tiles for
const TERRAIN_KEYS = [
  'tile_water',
  'tile_grass',
  'tile_sand',
  'tile_path'
];

const files = fs.readdirSync(TILES_DIR);

let generated = 0;
let skipped   = 0;

for (const key of TERRAIN_KEYS) {
  const pngFile = `${key}.png`;
  if (!files.includes(pngFile)) {
    console.log(`  SKIP  ${pngFile} — not found`);
    skipped++;
    continue;
  }

  // Check if a complete Wang tile folder already exists for this key.
  const existingDir = path.join(TILES_DIR, `${key}_wang`);
  const existingWang = fs.existsSync(existingDir)
    && fs.statSync(existingDir).isDirectory()
    && fs.readdirSync(existingDir).filter(f => /^wang_\d+\.png$/i.test(f)).length >= 16;
  if (existingWang && !force) {
    console.log(`  SKIP  ${key} — Wang tiles already exist (use --force to overwrite)`);
    skipped++;
    continue;
  }

  const inputPath = path.join(TILES_DIR, pngFile);
  console.log(`  GEN   ${key} → 16 Wang tiles @ ${tileSize}×${tileSize}`);
  const blendArg = args.find(a => a.startsWith('--blend='));
  const extraArgs = blendArg ? ` ${blendArg}` : '';
  execSync(`node ${SCRIPT} "${inputPath}" "${TILES_DIR}" ${tileSize}${extraArgs}`, {
    stdio: 'inherit',
  });
  generated++;
}

console.log(`\nDone — ${generated} generated, ${skipped} skipped.`);
