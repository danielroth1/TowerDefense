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
  /** Relative weight for weighted random selection among same-size groups. */
  weight?: number;
}

export interface DecorationPlacement {
  row: number;
  col: number;
  w: number;
  h: number;
  textureKey: string;
  depth: number;
  /** Additional rotation in radians (applied on top of random jitter). */
  rotation?: number;
  /** If true, this placement represents an economy market (not just decorative). */
  isEcoMarket?: boolean;
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
    w: 1, h: 1,
    textureKey: 'eco_market',
    rarity: CITY_PARAMS.marketRarity,
  },
  // ── Solo building groups (1×1) ────────────────────────────────────────
  {
    id: 'house01',
    label: 'Small House',
    w: 1, h: 1,
    textureKey: 'deco_city_house_01',
    rarity: 1.0,
    weight: CITY_PARAMS.soloWeights.house01,
  },
  {
    id: 'house02',
    label: 'Large House',
    w: 1, h: 1,
    textureKey: 'deco_city_house_02',
    rarity: 1.0,
    weight: CITY_PARAMS.soloWeights.house02,
  },
  {
    id: 'dense',
    label: 'Dense Housing',
    w: 2, h: 2,
    textureKey: 'deco_city_dense',
    rarity: 1.0,
    weight: CITY_PARAMS.soloWeights.dense,
  },
  {
    id: 'tower',
    label: 'Watch Tower',
    w: 1, h: 1,
    textureKey: 'deco_city_tower',
    rarity: 1.0,
    weight: CITY_PARAMS.soloWeights.tower,
  },
];

// ─── Depth constants ────────────────────────────────────────────────────────

const DEPTH_BUILDING = 0.25;

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


/** Pick a decoration group using weighted random selection from CITY_GROUPS.
 *  Only groups with a `weight` field are eligible, regardless of their w/h size. */
function pickWeightedGroup(rng: () => number): DecorationGroupDef {
  const solo = CITY_GROUPS.filter(g => g.weight !== undefined);
  const total = solo.reduce((sum, g) => sum + (g.weight ?? 0), 0);
  let roll = rng() * total;
  for (const g of solo) {
    roll -= g.weight ?? 0;
    if (roll <= 0) return g;
  }
  return solo[solo.length - 1];
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
    if (group.id === 'market') {
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

      const group = pickWeightedGroup(rng);
      if (r + group.h > GRID_ROWS || c + group.w > GRID_COLS) continue;

      // All cells in the group's footprint must be buildable and unoccupied
      let canPlace = true;
      for (let dr = 0; dr < group.h && canPlace; dr++) {
        for (let dc = 0; dc < group.w && canPlace; dc++) {
          if (!cellIsBuildableOnly(grid[r + dr][c + dc]) || used[r + dr][c + dc]) {
            canPlace = false;
          }
        }
      }
      if (!canPlace) continue;

      placements.push({ row: r, col: c, w: group.w, h: group.h, textureKey: group.textureKey, depth: DEPTH_BUILDING });
      for (let dr = 0; dr < group.h; dr++) {
        for (let dc = 0; dc < group.w; dc++) {
          markUsed(r + dr, c + dc);
        }
      }
    }
  }

  return { placements, blockedCells };
}

// ─── Market placement (1×1 + optional surrounding houses) ───────────────────

function placeMarkets(
  group: DecorationGroupDef,
  grid: GridTile[][],
  used: boolean[][],
  rng: () => number,
  placements: DecorationPlacement[],
  markUsed: (r: number, c: number) => void,
) {
  const gw = group.w, gh = group.h;
  const candidates: { row: number; col: number }[] = [];

  for (let r = 0; r <= GRID_ROWS - gh; r++) {
    for (let c = 0; c <= GRID_COLS - gw; c++) {
      let valid = true;
      for (let dr = 0; dr < gh && valid; dr++) {
        for (let dc = 0; dc < gw && valid; dc++) {
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

    placements.push({ row, col, w: gw, h: gh, textureKey: group.textureKey, depth: DEPTH_BUILDING, isEcoMarket: true });
    for (let dr = 0; dr < gh; dr++) {
      for (let dc = 0; dc < gw; dc++) {
        markUsed(row + dr, col + dc);
      }
    }

    // ── Optional: surround with houses ────────────────────────────────
    if (rng() < CITY_PARAMS.groupChance) {
      const houseCount = CITY_PARAMS.groupHouseMin +
        Math.floor(rng() * (CITY_PARAMS.groupHouseMax - CITY_PARAMS.groupHouseMin + 1));

      const adjCells: { row: number; col: number }[] = [];
      for (let dr = -1; dr <= gh; dr++) {
        for (let dc = -1; dc <= gw; dc++) {
          if (dr >= 0 && dr < gh && dc >= 0 && dc < gw) continue;
          const ar = row + dr, ac = col + dc;
          if (ar < 0 || ar >= GRID_ROWS || ac < 0 || ac >= GRID_COLS) continue;
          if (!cellIsBuildableOnly(grid[ar][ac]) || used[ar][ac]) continue;
          adjCells.push({ row: ar, col: ac });
        }
      }

      const shuffled = [...adjCells].sort(() => rng() - 0.5);
      const placed = Math.min(houseCount, shuffled.length);
      for (let h = 0; h < placed; h++) {
        const soloGroup = pickWeightedGroup(rng);
        const sr = shuffled[h].row, sc = shuffled[h].col;
        if (sr + soloGroup.h > GRID_ROWS || sc + soloGroup.w > GRID_COLS) continue;

        // All cells in the solo group's footprint must be buildable and unoccupied
        let canPlace = true;
        for (let dr = 0; dr < soloGroup.h && canPlace; dr++) {
          for (let dc = 0; dc < soloGroup.w && canPlace; dc++) {
            const nr = sr + dr, nc = sc + dc;
            if (nr >= GRID_ROWS || nc >= GRID_COLS ||
                !cellIsBuildableOnly(grid[nr][nc]) || used[nr][nc]) {
              canPlace = false;
            }
          }
        }
        if (!canPlace) continue;

        placements.push({
          row: sr, col: sc,
          w: soloGroup.w, h: soloGroup.h, textureKey: soloGroup.textureKey, depth: DEPTH_BUILDING,
        });
        for (let dr = 0; dr < soloGroup.h; dr++) {
          for (let dc = 0; dc < soloGroup.w; dc++) {
            markUsed(sr + dr, sc + dc);
          }
        }
      }
    }
  }
}
