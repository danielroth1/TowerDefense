#!/usr/bin/env node
/**
 * Generate Wang tile sets for all terrain textures in public/assets/tiles/.
 *
 * Skips tower textures, transition tiles, blob tiles, and existing Wang tiles.
 * Only processes base terrain textures: tile_water, tile_grass, tile_sand,
 * tile_path, tile_spawn, tile_goal.
 *
 * Usage:
 *   node tools/wang-tiles/generate-all.mjs [tileSize]          # default algorithm
 *   node tools/wang-tiles/generate-all.mjs --cohen [tileSize]  # Cohen et al. search
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const TILES_DIR = 'public/assets/tiles';

// Parse args: --cohen flag can be anywhere, tileSize is first numeric arg
const args = process.argv.slice(2);
const useCohen  = args.includes('--cohen');
const tileSize  = parseInt(args.find(a => /^\d+$/.test(a)), 10) || 192;

const SCRIPT = useCohen
  ? 'tools/wang-tiles/generate-cohen.mjs'
  : 'tools/wang-tiles/generate.mjs';

console.log(`Using ${useCohen ? 'Cohen et al.' : 'diagonal swap'} algorithm (${SCRIPT})`);

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

  // Check if Wang tiles already exist for this key
  const existingWang = files.some(f => f.startsWith(`${key}_wang_`));
  if (existingWang) {
    console.log(`  SKIP  ${key} — Wang tiles already exist`);
    skipped++;
    continue;
  }

  const inputPath = path.join(TILES_DIR, pngFile);
  console.log(`  GEN   ${key} → 16 Wang tiles @ ${tileSize}×${tileSize}`);
  execSync(`node ${SCRIPT} "${inputPath}" "${TILES_DIR}" ${tileSize}`, {
    stdio: 'inherit',
  });
  generated++;
}

console.log(`\nDone — ${generated} generated, ${skipped} skipped.`);
