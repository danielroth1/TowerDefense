import { GRID_COLS, GRID_ROWS, TILE_SIZE } from '../utils/constants';
import type { GridTile } from './MapGenerator';

/*
 * ─── Cart Pathfinder ─────────────────────────────────────────────────────
 *
 * Shared A* pathfinding utility used by both CityRoadNetwork (for decorative
 * road generation) and TransportSystem (for cart navigation between buildings).
 *
 * Exports:
 *   - buildWalkabilityGrid   — build walkable/blocked grid from MapGenerator tiles
 *   - findCartPath           — A* pathfind between grid cells, returns pixel-center path
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Vec2 { x: number; y: number; }

// ─── Walkability grid ───────────────────────────────────────────────────────

/**
 * Build a walkability grid from MapGenerator grid tiles.
 * 0 = blocked (water, buildings), 1 = walkable (grass, 1.0 cost), 2 = path (0.5 cost)
 */
export function buildWalkabilityGrid(grid: GridTile[][]): Uint8Array {
  const walkable = new Uint8Array(GRID_ROWS * GRID_COLS);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const t = grid[r][c].type;
      if (t === 'path' || t === 'spawn' || t === 'goal') {
        walkable[r * GRID_COLS + c] = 2;
      } else if (t === 'buildable') {
        walkable[r * GRID_COLS + c] = 1;
      }
      // 'ground' (water) stays 0
    }
  }
  return walkable;
}

// ─── A* pathfinding ─────────────────────────────────────────────────────────

interface AStarNode {
  r: number; c: number;
  g: number; f: number;
  parent: AStarNode | null;
}

/**
 * Find a path between two grid cells using A*.
 * Returns a list of pixel-center positions, or null if no path exists.
 *
 * @param walkable  Pre-built walkability grid (0=blocked, 1=walkable, 2=path-prefer)
 * @param blocked   Set of "r,c" strings for cells blocked by building footprints
 * @param sr, sc    Start row/col
 * @param er, ec    End row/col
 */
export function findCartPath(
  walkable: Uint8Array,
  blocked: Set<string>,
  sr: number, sc: number,
  er: number, ec: number,
): Vec2[] | null {
  const COLS = GRID_COLS, ROWS = GRID_ROWS;
  const key = (r: number, c: number) => r * COLS + c;

  // Don't pathfind into blocked destination cells
  if (blocked.has(`${er},${ec}`)) return null;

  const open: AStarNode[] = [];
  const closed = new Set<number>();

  const heuristic = (r: number, c: number) =>
    Math.abs(r - er) + Math.abs(c - ec);

  const start: AStarNode = { r: sr, c: sc, g: 0, f: heuristic(sr, sc), parent: null };
  open.push(start);

  const bestG = new Map<number, number>();
  bestG.set(key(sr, sc), 0);

  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  while (open.length > 0) {
    // Find node with lowest f
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const cur = open.splice(bestIdx, 1)[0];

    if (cur.r === er && cur.c === ec) {
      // Reconstruct path as pixel-center positions
      const path: Vec2[] = [];
      let node: AStarNode | null = cur;
      while (node) {
        path.push({
          x: node.c * TILE_SIZE + TILE_SIZE / 2,
          y: node.r * TILE_SIZE + TILE_SIZE / 2,
        });
        node = node.parent;
      }
      path.reverse();
      return path;
    }

    const ck = key(cur.r, cur.c);
    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const [dr, dc] of dirs) {
      const nr = cur.r + dr, nc = cur.c + dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      const nk = key(nr, nc);
      if (closed.has(nk)) continue;

      const cell = walkable[nk];
      if (cell === 0) continue;

      // Skip cells blocked by buildings (unless it's the destination)
      if (blocked.has(`${nr},${nc}`) && !(nr === er && nc === ec)) continue;

      const moveCost = cell === 2 ? 0.5 : 1.0;
      const ng = cur.g + moveCost;
      const prevG = bestG.get(nk);
      if (prevG !== undefined && ng >= prevG) continue;
      bestG.set(nk, ng);

      const nf = ng + heuristic(nr, nc);
      open.push({ r: nr, c: nc, g: ng, f: nf, parent: cur });
    }
  }

  return null; // No path found
}
