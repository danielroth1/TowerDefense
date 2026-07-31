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

/** Debug data produced by a single A* invocation — used to visualise cost
 *  weights and the chosen path so you can see why carts pick certain routes. */
export interface CartDebugData {
  /** Per-cell best-g cost (Float32Array, indexed by r*COLS+c).
   *  0 = never visited by A*. */
  costGrid: Float32Array;
  /** Per-cell walkability: 0=blocked, 1=grass, 2=path (same as walkable input). */
  walkableGrid: Uint8Array;
  /** Per-cell flag: 1 = this cell is on the road network (roadGrid). */
  roadGrid: Uint8Array;
  /** Set of "r,c" strings for cells on the final computed path. */
  pathCells: Set<string>;
  /** Start cell (row, col). */
  sr: number; sc: number;
  /** End cell (row, col). */
  er: number; ec: number;
  /** Whether the road grid was provided to this A* invocation. */
  hadRoadGrid: boolean;
}

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
 * @param roadGrid  Optional per-cell boolean: 1=road. When provided,
 *                  road cells get cost 0.1 (heavily preferred over grass at 1.0).
 * @param outDebug  Optional — if provided, populated with per-cell costs, road
 *                  flags, and path cells for debug visualisation.
 */
export function findCartPath(
  walkable: Uint8Array,
  blocked: Set<string>,
  sr: number, sc: number,
  er: number, ec: number,
  roadGrid?: Uint8Array,
  outDebug?: CartDebugData,
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

  // Track the best goal path found so far.  Because zero-cost edges (road,
  // path tiles) make the Manhattan heuristic non-admissible (it can over-
  // estimate), the first goal popped from the open list is not guaranteed to
  // be optimal.  We continue searching until the open list is exhausted so
  // that zero-cost corridors are fully explored.
  let bestGoalNode: AStarNode | null = null;

  while (open.length > 0) {
    // Find node with lowest f
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const cur = open.splice(bestIdx, 1)[0];

    // Once we have a goal path, stop if the best remaining open node
    // can't possibly beat it (all edge costs are >= 0, so g never
    // decreases along a path, and f = g + h >= g).
    if (bestGoalNode && cur.f >= bestGoalNode.g) break;

    // Skip nodes already expanded — but only if we haven't found a better
    // path to them since they were closed (see re-open logic below).
    const ck = key(cur.r, cur.c);
    if (closed.has(ck)) continue;
    closed.add(ck);

    if (cur.r === er && cur.c === ec) {
      // Save this goal path (keep the best-g one) but continue searching:
      // a zero-cost corridor may still produce a cheaper route.
      if (!bestGoalNode || cur.g < bestGoalNode.g) {
        bestGoalNode = cur;
      }
      continue;
    }

    for (const [dr, dc] of dirs) {
      const nr = cur.r + dr, nc = cur.c + dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      const nk = key(nr, nc);

      const cell = walkable[nk];
      if (cell === 0) continue;

      // Skip cells blocked by buildings (unless it's the destination)
      if (blocked.has(`${nr},${nc}`) && !(nr === er && nc === ec)) continue;

      let moveCost: number;
      if (roadGrid && roadGrid[nk] === 1) {
        moveCost = 0.1; // heavily prefer road cells
      } else {
        moveCost = cell === 2 ? 0.25 : 1.0;
      }
      const ng = cur.g + moveCost;
      const prevG = bestG.get(nk);
      if (prevG !== undefined && ng >= prevG) continue;

      // If this neighbour was previously expanded via a costlier path,
      // remove it from closed so it will be re-expanded with this
      // cheaper g — this is what lets zero-cost road corridors
      // "retroactively" improve paths through cells that grass-based
      // exploration already visited.
      if (closed.has(nk)) {
        closed.delete(nk);
      }

      bestG.set(nk, ng);
      const nf = ng + heuristic(nr, nc) * 0.1;
      open.push({ r: nr, c: nc, g: ng, f: nf, parent: cur });
    }
  }

  // ── Reconstruct best goal path (or null) ──────────────────────────────
  const pathCells = new Set<string>();

  if (bestGoalNode) {
    const path: Vec2[] = [];
    let node: AStarNode | null = bestGoalNode;
    while (node) {
      pathCells.add(`${node.r},${node.c}`);
      path.push({
        x: node.c * TILE_SIZE + TILE_SIZE / 2,
        y: node.r * TILE_SIZE + TILE_SIZE / 2,
      });
      node = node.parent;
    }
    path.reverse();

    if (outDebug) {
      outDebug.sr = sr; outDebug.sc = sc;
      outDebug.er = er; outDebug.ec = ec;
      outDebug.hadRoadGrid = roadGrid != null;
      outDebug.pathCells = pathCells;
      outDebug.walkableGrid.set(walkable);
      if (roadGrid) {
        outDebug.roadGrid.set(roadGrid);
      } else {
        outDebug.roadGrid.fill(0);
      }
      outDebug.costGrid.fill(0);
      for (const [k, g] of bestG) {
        outDebug.costGrid[k] = g;
      }
    }

    return path;
  }

  // Populate debug even when no path found (shows explored area)
  if (outDebug) {
    outDebug.sr = sr; outDebug.sc = sc;
    outDebug.er = er; outDebug.ec = ec;
    outDebug.hadRoadGrid = roadGrid != null;
    outDebug.pathCells = pathCells;
    outDebug.walkableGrid.set(walkable);
    if (roadGrid) {
      outDebug.roadGrid.set(roadGrid);
    } else {
      outDebug.roadGrid.fill(0);
    }
    outDebug.costGrid.fill(0);
    for (const [k, g] of bestG) {
      outDebug.costGrid[k] = g;
    }
  }

  return null; // No path found
}
