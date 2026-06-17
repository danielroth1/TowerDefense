import {
  TILE_SIZE, GRID_COLS, GRID_ROWS,
  MIN_PATH_LENGTH, MAX_PATH_LENGTH, BUILDABLE_RADIUS,
} from '../utils/constants';
import { createPRNG } from '../utils/helpers';

export type TileType = 'ground' | 'path' | 'buildable' | 'spawn' | 'goal';

export interface GridTile {
  row: number;
  col: number;
  type: TileType;
  pathIndex: number;   // -1 if not on path
}

export interface MapData {
  grid: GridTile[][];
  path: { row: number; col: number }[];     // ordered path cells
  waypoints: { x: number; y: number }[];   // pixel centers of path cells
  spawnPoint: { x: number; y: number };
  goalPoint:  { x: number; y: number };
  seed: number;
}

// Cardinal directions
const DIRS = [
  { dr: 0,  dc: 1  },
  { dr: 0,  dc: -1 },
  { dr: 1,  dc: 0  },
  { dr: -1, dc: 0  },
];

function tileCenter(row: number, col: number) {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

function inBounds(row: number, col: number) {
  return row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS;
}

export function generateMap(seed: number): MapData {
  const rng = createPRNG(seed);

  // Spawn on left side, goal on right side at random rows
  const spawnRow = Math.floor(rng() * (GRID_ROWS - 4)) + 2;
  const goalRow  = Math.floor(rng() * (GRID_ROWS - 4)) + 2;
  const spawnCol = 0;
  const goalCol  = GRID_COLS - 1;

  // Try to generate a valid path; retry with different seeds if too short
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = tryGeneratePath(rng, spawnRow, spawnCol, goalRow, goalCol);
    if (result && result.length >= MIN_PATH_LENGTH) {
      return buildMapData(seed, result, spawnRow, spawnCol, goalRow, goalCol);
    }
  }
  // Fallback: straight path with some kinks
  return buildFallbackMap(seed, spawnRow, goalRow);
}

function tryGeneratePath(
  rng: () => number,
  startRow: number, startCol: number,
  endRow: number,   endCol: number,
): { row: number; col: number }[] | null {
  const visited = new Set<string>();
  const path: { row: number; col: number }[] = [];
  let row = startRow, col = startCol;
  const maxSteps = MAX_PATH_LENGTH + 20;

  path.push({ row, col });
  visited.add(`${row},${col}`);

  for (let step = 0; step < maxSteps; step++) {
    // At final column, push straight to goal
    if (col === endCol - 1) {
      const finalSteps = endRow > row ? 1 : endRow < row ? -1 : 0;
      if (finalSteps !== 0) {
        row += finalSteps;
        path.push({ row, col });
        visited.add(`${row},${col}`);
      }
      path.push({ row: endRow, col: endCol });
      return path;
    }

    // Build candidate moves with bias toward the goal
    const candidates = DIRS.map(d => ({
      dr: d.dr, dc: d.dc,
      nr: row + d.dr,
      nc: col + d.dc,
    })).filter(c =>
      inBounds(c.nr, c.nc) &&
      !visited.has(`${c.nr},${c.nc}`) &&
      // Don't backtrack too close to left edge
      !(c.dc === -1 && c.nc < startCol + 1)
    );

    if (candidates.length === 0) return null;

    // Weight: prefer moving right (toward goal), moderate vertical
    const weighted = candidates.flatMap(c => {
      const w = c.dc === 1 ? 4 : c.dc === -1 ? 1 : 2;
      return Array(w).fill(c) as typeof c[];
    });

    const pick = weighted[Math.floor(rng() * weighted.length)];
    row = pick.nr;
    col = pick.nc;
    path.push({ row, col });
    visited.add(`${row},${col}`);

    if (path.length > MAX_PATH_LENGTH) break;
  }
  return null;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function buildFallbackMap(seed: number, spawnRow: number, goalRow: number): MapData {
  const path: { row: number; col: number }[] = [];
  let row = spawnRow;

  // Walk right with zigzags
  for (let col = 0; col < GRID_COLS; col++) {
    path.push({ row, col });
    if (col % 6 === 5 && col < GRID_COLS - 2) {
      const dir = goalRow > row ? 1 : -1;
      for (let d = 0; d < 3; d++) {
        row = clampInt(row + dir, 1, GRID_ROWS - 2);
        path.push({ row, col });
      }
    }
  }
  // Ensure last cell is goal
  if (path[path.length - 1].row !== goalRow) {
    path.push({ row: goalRow, col: GRID_COLS - 1 });
  }
  return buildMapData(seed, path, spawnRow, 0, goalRow, GRID_COLS - 1);
}

function buildMapData(
  seed: number,
  path: { row: number; col: number }[],
  spawnRow: number, spawnCol: number,
  goalRow: number,  goalCol: number,
): MapData {
  // Initialize grid
  const grid: GridTile[][] = Array.from({ length: GRID_ROWS }, (_, r) =>
    Array.from({ length: GRID_COLS }, (_, c) => ({
      row: r, col: c, type: 'ground' as TileType, pathIndex: -1,
    }))
  );

  // Mark path cells
  const pathSet = new Set<string>();
  path.forEach((p, i) => {
    grid[p.row][p.col].type = i === 0 ? 'spawn' : i === path.length - 1 ? 'goal' : 'path';
    grid[p.row][p.col].pathIndex = i;
    pathSet.add(`${p.row},${p.col}`);
  });

  // Mark buildable cells (within BUILDABLE_RADIUS tiles of path, not on path, within grid)
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (grid[r][c].type !== 'ground') continue;
      let nearPath = false;
      for (const p of path) {
        const dist = Math.abs(p.row - r) + Math.abs(p.col - c);
        if (dist <= BUILDABLE_RADIUS) { nearPath = true; break; }
      }
      if (nearPath) grid[r][c].type = 'buildable';
    }
  }

  const waypoints = path.map(p => tileCenter(p.row, p.col));

  return {
    grid,
    path,
    waypoints,
    spawnPoint: tileCenter(spawnRow, spawnCol),
    goalPoint:  tileCenter(goalRow, goalCol),
    seed,
  };
}
