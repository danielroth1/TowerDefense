#!/usr/bin/env node
/**
 * Generate Wang tile sets for all terrain textures in public/assets/tiles/.
 *
 * Skips tower textures, transition tiles, blob tiles, and existing Wang tiles.
 * Only processes base terrain textures: tile_water, tile_grass, tile_sand,
 * tile_path, tile_spawn, tile_goal.
 *
 * Usage:
 *   node tools/wang-tiles/generate-all.mjs [tileSize]            # default algorithm, force (overwrite existing)
 *   node tools/wang-tiles/generate-all.mjs --new1 [tileSize]     # bilinear corner-weighted blending
 *   node tools/wang-tiles/generate-all.mjs --new2 [tileSize]     # frequency-separated edge blending
 *   node tools/wang-tiles/generate-all.mjs --cohen [tileSize]    # Cohen et al. search
 *   node tools/wang-tiles/generate-all.mjs --cohen2 [tileSize]   # Cohen DP cut paths
 *   node tools/wang-tiles/generate-all.mjs --cohen3 [tileSize]   # Cohen O(W·H) DP (best)
 *   node tools/wang-tiles/generate-all.mjs --cohen4 [tileSize]   # Cohen proper decoupled mapping
 *   node tools/wang-tiles/generate-all.mjs --cohen5 [tileSize]   # Cohen sample-diamond quilting for 16 corner-bit tiles
 *   node tools/wang-tiles/generate-all.mjs --cohen6 [tileSize]   # Cohen diamond sample + seam cutting (DP quilting)
 *   node tools/wang-tiles/generate-all.mjs --no-force [tileSize] # skip if Wang tiles already exist
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const TILES_DIR = 'public/assets/tiles';

// Parse args: --cohen/--cohen2/--cohen3/--cohen4/--cohen5/--cohen6 flag can be anywhere, tileSize is first numeric arg
const args = process.argv.slice(2);
const useNew1   = args.includes('--new1');
const useNew2   = args.includes('--new2');
const useCohen  = args.includes('--cohen');
const useCohen2 = args.includes('--cohen2');
const useCohen3 = args.includes('--cohen3');
const useCohen4 = args.includes('--cohen4');
const useCohen5 = args.includes('--cohen5');
const useCohen6 = args.includes('--cohen6');
const useCohen7 = args.includes('--cohen7');
const force     = !args.includes('--no-force');  // default: true (overwrite existing)
const tileSize  = parseInt(args.find(a => /^\d+$/.test(a)), 10) || 192;

const SCRIPT = useNew1
  ? 'tools/wang-tiles/generate-new1.mjs'
  : useNew2
  ? 'tools/wang-tiles/generate-new2.mjs'
  : useCohen7
  ? 'tools/wang-tiles/generate-cohen7.mjs'
  : useCohen6
  ? 'tools/wang-tiles/generate-cohen6.mjs'
  : useCohen5
  ? 'tools/wang-tiles/generate-cohen5.mjs'
  : useCohen4
  ? 'tools/wang-tiles/generate-cohen4.mjs'
  : useCohen3
    ? 'tools/wang-tiles/generate-cohen3.mjs'
    : useCohen2
      ? 'tools/wang-tiles/generate-cohen2.mjs'
      : useCohen
        ? 'tools/wang-tiles/generate-cohen.mjs'
        : 'tools/wang-tiles/generate.mjs';

const algoName = useNew1 ? 'bilinear corner-weighted blending' : useNew2 ? 'frequency-separated edge blending' : useCohen7 ? 'Cohen et al. diamond-cut quilting (graph-cut DP on overlap bands + diagonal centre)' : useCohen6 ? 'Cohen et al. diamond sample + seam cutting (DP quilting)' : useCohen5 ? 'Cohen et al. sample-diamond quilting (16 corner-bit adaptation)' : useCohen4 ? 'Cohen et al. v4 proper decoupled mapping' : useCohen3 ? 'Cohen et al. O(W·H) DP' : useCohen2 ? 'Cohen et al. DP cut paths' : useCohen ? 'Cohen et al. search' : 'diagonal swap';
console.log(`Using ${algoName} algorithm (${SCRIPT})`);
console.log(`Mode: ${force ? '--force (overwrite existing)' : '--no-force (skip existing)'}`);

// Which base textures to generate Wang tiles for
const TERRAIN_KEYS = [
  'tile_water',
  'tile_grass',
  'tile_sand',
  'tile_path',
  'tile_spawn',
  'tile_goal',
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
