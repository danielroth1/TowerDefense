import { type GridTile } from './MapGenerator';
import { GRID_COLS, GRID_ROWS } from '../utils/constants';
import { createPRNG } from '../utils/helpers';

/*
 * ─── City Decoration System ──────────────────────────────────────────────
 *
 * Places purely-visual city building decorations on the map. Multi-cell
 * groups (2×2 markets, 2×1 harbors) are placed greedily first, then
 * remaining shoreline cells are filled with individual houses and towers.
 *
 * Decorations block tower placement — occupied cells are marked as
 * non-buildable.
 *
 * Placement frequencies are controlled via CITY_PARAMS.
 */

// ─── Frequency parameters ───────────────────────────────────────────────────

export const CITY_PARAMS = {
  /** Probability a candidate 2×2 grass area becomes a market. */
  marketRarity: 0.12,
  /** Probability a candidate grass+water edge becomes a harbor. */
  harborRarity: 0.35,
  /** Chance to surround a market with houses (0-1). */
  groupChance: 0.4,
  /** Number of houses to place around a market group. */
  groupHouseMin: 2,
  groupHouseMax: 5,
  /** Chance a shoreline cell gets a solo building. */
  soloFillChance: 0.5,
  /** Relative weights for solo building types. */
  soloWeights: {
    house01: 0.45,
    house02: 0.25,
    dense: 0.20,
    tower: 0.10,
  },
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DecorationGroupDef {
  id: string;
  label: string;
  w: number;
  h: number;
  textureKey: string;
  rarity: number;
}

export interface DecorationPlacement {
  row: number;
  col: number;
  w: number;
  h: number;
  textureKey: string;
  depth: number;
}

export interface CityDecorResult {
  placements: DecorationPlacement[];
  /** Set of "row,col" strings for cells occupied by decorations. */
  blockedCells: Set<string>;
}

// ─── Group definitions ──────────────────────────────────────────────────────

const CITY_GROUPS: DecorationGroupDef[] = [
  {
    id: 'market',
    label: 'Market Square',
    w: 2, h: 2,
    textureKey: 'deco_city_market',
    rarity: CITY_PARAMS.marketRarity,
  },
  {
    id: 'harbor',
    label: 'Harbor Pier',
    w: 2, h: 1,
    textureKey: 'deco_city_harbor',
    rarity: CITY_PARAMS.harborRarity,
  },
];

// ─── Depth constants ────────────────────────────────────────────────────────

const DEPTH_BUILDING = 0.25;
const DEPTH_HARBOR = 0.22;

// ─── Helpers ────────────────────────────────────────────────────────────────

function cellIsWater(tile: GridTile): boolean {
  return tile.type === 'ground';
}
function cellIsBuildableOnly(tile: GridTile): boolean {
  return tile.type === 'buildable';
}

/** Check if a cell at (row,col) has at least one water neighbor. */
function hasWaterNeighbor(grid: GridTile[][], row: number, col: number): boolean {
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of dirs) {
    const nr = row + dr, nc = col + dc;
    if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
    if (cellIsWater(grid[nr][nc])) return true;
  }
  return false;
}

/** Return the direction (dr, dc) of an adjacent water cell, or null. */
function adjacentWaterDir(
  grid: GridTile[][], row: number, col: number,
): { dr: number; dc: number } | null {
  const dirs: { dr: number; dc: number }[] = [
    { dr: -1, dc: 0 }, { dr: 1, dc: 0 },
    { dr: 0, dc: -1 }, { dr: 0, dc: 1 },
  ];
  const shuffled = [...dirs].sort(() => Math.random() - 0.5);
  for (const d of shuffled) {
    const nr = row + d.dr, nc = col + d.dc;
    if (nr >= 0 && nr < GRID_ROWS && nc >= 0 && nc < GRID_COLS && cellIsWater(grid[nr][nc])) {
      return d;
    }
  }
  return null;
}

function pickSoloBuilding(rng: () => number): string {
  const w = CITY_PARAMS.soloWeights;
  const total = w.house01 + w.house02 + w.dense + w.tower;
  const roll = rng() * total;
  if (roll < w.house01) return 'deco_city_house_01';
  if (roll < w.house01 + w.house02) return 'deco_city_house_02';
  if (roll < w.house01 + w.house02 + w.dense) return 'deco_city_dense';
  return 'deco_city_tower';
}

// ─── Main generator ─────────────────────────────────────────────────────────

export function generateCityDecorations(
  grid: GridTile[][],
  seed: number,
): CityDecorResult {
  const rng = createPRNG(seed + 0xDEC0);
  const placements: DecorationPlacement[] = [];
  const blockedCells = new Set<string>();

  const used = Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => false)
  );

  function markUsed(row: number, col: number) {
    used[row][col] = true;
    blockedCells.add(`${row},${col}`);
  }

  // ── Phase A: Place multi-cell groups ──────────────────────────────────

  for (const group of CITY_GROUPS) {
    if (group.id === 'harbor') {
      placeHarbors(group, grid, used, rng, placements, markUsed);
    } else if (group.id === 'market') {
      placeMarkets(group, grid, used, rng, placements, markUsed);
    }
  }

  // ── Phase B: Fill shoreline cells with solo buildings ──────────────────

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (used[r][c]) continue;
      if (!cellIsBuildableOnly(grid[r][c])) continue;
      if (!hasWaterNeighbor(grid, r, c)) continue;
      if (rng() > CITY_PARAMS.soloFillChance) continue;

      const key = pickSoloBuilding(rng);
      placements.push({ row: r, col: c, w: 1, h: 1, textureKey: key, depth: DEPTH_BUILDING });
      markUsed(r, c);
    }
  }

  return { placements, blockedCells };
}

// ─── Harbor placement (straddles grass + water) ─────────────────────────────

function placeHarbors(
  group: DecorationGroupDef,
  grid: GridTile[][],
  used: boolean[][],
  rng: () => number,
  placements: DecorationPlacement[],
  markUsed: (r: number, c: number) => void,
) {
  const candidates: { grassRow: number; grassCol: number; waterRow: number; waterCol: number }[] = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!cellIsBuildableOnly(grid[r][c])) continue;
      if (used[r][c]) continue;

      const dir = adjacentWaterDir(grid, r, c);
      if (!dir) continue;

      const wr = r + dir.dr, wc = c + dir.dc;
      if (!cellIsWater(grid[wr][wc])) continue;
      if (used[wr][wc]) continue;

      candidates.push({ grassRow: r, grassCol: c, waterRow: wr, waterCol: wc });
    }
  }

  const maxPlace = Math.max(1, Math.floor(candidates.length * 0.2));
  for (let i = 0; i < maxPlace; i++) {
    if (candidates.length === 0) break;
    const idx = Math.floor(rng() * candidates.length);
    const cand = candidates.splice(idx, 1)[0];
    if (rng() > group.rarity) continue;

    const row = Math.min(cand.grassRow, cand.waterRow);
    const col = Math.min(cand.grassCol, cand.waterCol);
    const w = cand.grassCol === cand.waterCol ? 1 : 2;
    const h = cand.grassRow === cand.waterRow ? 1 : 2;

    placements.push({ row, col, w, h, textureKey: group.textureKey, depth: DEPTH_HARBOR });
    markUsed(cand.grassRow, cand.grassCol);
    markUsed(cand.waterRow, cand.waterCol);
  }
}

// ─── Market placement (2×2 + optional surrounding houses) ───────────────────

function placeMarkets(
  group: DecorationGroupDef,
  grid: GridTile[][],
  used: boolean[][],
  rng: () => number,
  placements: DecorationPlacement[],
  markUsed: (r: number, c: number) => void,
) {
  const candidates: { row: number; col: number }[] = [];

  for (let r = 0; r <= GRID_ROWS - 2; r++) {
    for (let c = 0; c <= GRID_COLS - 2; c++) {
      let valid = true;
      for (let dr = 0; dr < 2 && valid; dr++) {
        for (let dc = 0; dc < 2 && valid; dc++) {
          if (!cellIsBuildableOnly(grid[r + dr][c + dc]) || used[r + dr][c + dc]) {
            valid = false;
          }
        }
      }
      if (valid) candidates.push({ row: r, col: c });
    }
  }

  const maxPlace = Math.max(1, Math.floor(candidates.length * 0.25));
  for (let i = 0; i < maxPlace; i++) {
    if (candidates.length === 0) break;
    const idx = Math.floor(rng() * candidates.length);
    const { row, col } = candidates.splice(idx, 1)[0];
    if (rng() > group.rarity) continue;

    placements.push({ row, col, w: 2, h: 2, textureKey: group.textureKey, depth: DEPTH_BUILDING });
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        markUsed(row + dr, col + dc);
      }
    }

    // ── Optional: surround market with houses ────────────────────────────
    if (rng() < CITY_PARAMS.groupChance) {
      const houseCount = CITY_PARAMS.groupHouseMin +
        Math.floor(rng() * (CITY_PARAMS.groupHouseMax - CITY_PARAMS.groupHouseMin + 1));

      const adjCells: { row: number; col: number }[] = [];
      for (let dr = -1; dr <= 2; dr++) {
        for (let dc = -1; dc <= 2; dc++) {
          if (dr >= 0 && dr < 2 && dc >= 0 && dc < 2) continue;
          const ar = row + dr, ac = col + dc;
          if (ar < 0 || ar >= GRID_ROWS || ac < 0 || ac >= GRID_COLS) continue;
          if (!cellIsBuildableOnly(grid[ar][ac]) || used[ar][ac]) continue;
          adjCells.push({ row: ar, col: ac });
        }
      }

      const shuffled = [...adjCells].sort(() => rng() - 0.5);
      const placed = Math.min(houseCount, shuffled.length);
      for (let h = 0; h < placed; h++) {
        const key = pickSoloBuilding(rng);
        placements.push({
          row: shuffled[h].row, col: shuffled[h].col,
          w: 1, h: 1, textureKey: key, depth: DEPTH_BUILDING,
        });
        markUsed(shuffled[h].row, shuffled[h].col);
      }
    }
  }
}
