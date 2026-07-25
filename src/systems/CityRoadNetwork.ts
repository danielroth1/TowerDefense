import { type GridTile } from './MapGenerator';
import { type DecorationPlacement } from './CityDecorator';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';
import { createPRNG } from '../utils/helpers';

/*
 * ─── Decorative City Road Network ──────────────────────────────────────
 *
 * Generates purely-decorative cobblestone roads connecting city buildings.
 * Uses a Steiner-tree algorithm:
 *
 *   1. Cluster nearby buildings (Union-Find, distance threshold)
 *   2. Compute a junction point per cluster (geometric median on walkable grid)
 *   3. A* pathfind each building → its junction
 *   4. Connect isolated clusters to the nearest connected cluster
 *   5. Identify emergent intersections (where roads from different paths converge)
 *   6. Smooth all paths with Chaikin subdivision + noise
 *
 * Roads avoid water and building cells but can cross enemy paths.
 */

// ─── Public types ───────────────────────────────────────────────────────────

export interface Vec2 { x: number; y: number; }

/** A smoothed road segment (spine polyline between two nodes). */
export interface CityRoad {
  points: Vec2[];
}

/** A junction or intersection node. */
export interface JunctionNode {
  /** Pixel position (world coordinates). */
  x: number;
  y: number;
  /** Number of road segments meeting here (for rendering circle size). */
  degree: number;
}

export interface CityRoadResult {
  roads: CityRoad[];
  junctions: JunctionNode[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Pixel distance threshold for clustering buildings (squared). */
const CLUSTER_DIST_SQ = (3.5 * TILE_SIZE) ** 2;  // ~3.5 tiles

/** Half-width of a decorative road in pixels. */
const ROAD_HALF_WIDTH = 6;

/** Chaikin subdivision iterations. */
const SMOOTH_ITERATIONS = 2;

/** Per-point noise amplitude (pixels). */
const NOISE_AMP = 3;

// ─── Union-Find ─────────────────────────────────────────────────────────────

class UnionFind {
  parent: number[];
  rank: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
  }
}

// ─── A* on grid ─────────────────────────────────────────────────────────────

interface AStarNode {
  r: number; c: number;
  g: number; f: number;
  parent: AStarNode | null;
}

function aStar(
  walkable: Uint8Array,
  sr: number, sc: number,
  er: number, ec: number,
  blocked: Set<string>,
): Vec2[] | null {
  const COLS = GRID_COLS, ROWS = GRID_ROWS;
  const key = (r: number, c: number) => r * COLS + c;

  // Don't pathfind into blocked cells
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
      // Reconstruct path
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

      // Walkability: 0 = blocked, 1 = walkable (1.0 cost), 2 = path (0.5 cost)
      const cell = walkable[nk];
      if (cell === 0) continue;

      // Skip cells that are blocked by buildings (unless it's the destination)
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

// ─── Smoothing ──────────────────────────────────────────────────────────────

/** Chaikin corner-cutting subdivision (one iteration). */
function chaikinStep(points: Vec2[]): Vec2[] {
  if (points.length < 2) return points;
  const out: Vec2[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
    out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Apply Chaikin smoothing for N iterations. */
function smoothPath(points: Vec2[], iterations: number): Vec2[] {
  let result = points;
  for (let i = 0; i < iterations; i++) {
    result = chaikinStep(result);
  }
  return result;
}

/** Add deterministic noise to intermediate points (not endpoints). */
function addNoise(points: Vec2[], rng: () => number, amp: number): void {
  for (let i = 1; i < points.length - 1; i++) {
    // Noise decreases near endpoints for clean joins
    const t = Math.min(i, points.length - 1 - i) / (points.length - 1);
    const scale = Math.min(t * 4, 1) * amp; // ramp up, then flat
    points[i].x += (rng() - 0.5) * 2 * scale;
    points[i].y += (rng() - 0.5) * 2 * scale;
  }
}

// ─── Main algorithm ─────────────────────────────────────────────────────────

export function generateCityRoads(
  grid: GridTile[][],
  placements: DecorationPlacement[],
  blockedCells: Set<string>,
  seed: number,
): CityRoadResult {
  if (placements.length < 2) return { roads: [], junctions: [] };

  const rng = createPRNG(seed + 0xC0DE);

  // ── 1. Build walkability grid ──────────────────────────────────────────
  // 0 = blocked, 1 = buildable/grass (cost 1.0), 2 = path (cost 0.5)
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

  // ── 2. Compute building center nodes ───────────────────────────────────
  interface BuildingNode {
    cx: number; cy: number;      // pixel center
    row: number; col: number;    // grid cell (nearest walkable perimeter)
    placementIdx: number;
  }

  const buildings: BuildingNode[] = placements.map((p, i) => {
    const cx = (p.col + p.w / 2) * TILE_SIZE;
    const cy = (p.row + p.h / 2) * TILE_SIZE;
    // Find the nearest walkable perimeter cell for A* entry
    const perimeter = findWalkablePerimeter(grid, p, blockedCells);
    return { cx, cy, row: perimeter.r, col: perimeter.c, placementIdx: i };
  });

  // ── 3. Cluster buildings (Union-Find) ──────────────────────────────────
  const uf = new UnionFind(buildings.length);
  // Sort pairs by distance for greedy clustering
  const pairs: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const dx = buildings[i].cx - buildings[j].cx;
      const dy = buildings[i].cy - buildings[j].cy;
      pairs.push({ i, j, d: dx * dx + dy * dy });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  for (const p of pairs) {
    if (p.d > CLUSTER_DIST_SQ) break;
    uf.union(p.i, p.j);
  }

  // Group buildings by cluster root
  const clusterMap = new Map<number, number[]>(); // root → building indices
  for (let i = 0; i < buildings.length; i++) {
    const root = uf.find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(i);
  }

  // ── 4. Compute junction per cluster (geometric median on walkable grid) ─
  interface JunctionInfo {
    cx: number; cy: number;   // pixel position
    gridR: number; gridC: number;  // grid cell
    buildingIndices: number[];
    connected: boolean;       // whether connected to main network
  }

  const junctions: JunctionInfo[] = [];

  for (const [_root, memberIndices] of clusterMap) {
    if (memberIndices.length === 1) {
      // Single building — no junction needed, mark as unconnected
      const b = buildings[memberIndices[0]];
      junctions.push({
        cx: b.cx, cy: b.cy,
        gridR: b.row, gridC: b.col,
        buildingIndices: memberIndices,
        connected: false,
      });
      continue;
    }

    // Compute centroid
    let sumX = 0, sumY = 0;
    for (const bi of memberIndices) {
      sumX += buildings[bi].cx;
      sumY += buildings[bi].cy;
    }
    const centroidR = Math.round(sumY / memberIndices.length / TILE_SIZE);
    const centroidC = Math.round(sumX / memberIndices.length / TILE_SIZE);

    // Search for the walkable cell near the centroid that minimizes
    // total A* distance to all cluster buildings.
    // Use a bounded search radius to keep it fast.
    const searchRadius = 8; // cells
    let bestR = centroidR, bestC = centroidC;
    let bestCost = Infinity;

    for (let dr = -searchRadius; dr <= searchRadius; dr++) {
      for (let dc = -searchRadius; dc <= searchRadius; dc++) {
        const cr = centroidR + dr, cc = centroidC + dc;
        if (cr < 0 || cr >= GRID_ROWS || cc < 0 || cc >= GRID_COLS) continue;
        if (walkable[cr * GRID_COLS + cc] === 0) continue;
        if (blockedCells.has(`${cr},${cc}`)) continue;

        // Sum Euclidean distances to all buildings (fast approximation)
        const px = cc * TILE_SIZE + TILE_SIZE / 2;
        const py = cr * TILE_SIZE + TILE_SIZE / 2;
        let totalDist = 0;
        for (const bi of memberIndices) {
          const dx = px - buildings[bi].cx;
          const dy = py - buildings[bi].cy;
          totalDist += Math.sqrt(dx * dx + dy * dy);
        }
        if (totalDist < bestCost) {
          bestCost = totalDist;
          bestR = cr;
          bestC = cc;
        }
      }
    }

    junctions.push({
      cx: bestC * TILE_SIZE + TILE_SIZE / 2,
      cy: bestR * TILE_SIZE + TILE_SIZE / 2,
      gridR: bestR,
      gridC: bestC,
      buildingIndices: memberIndices,
      connected: true, // multi-building clusters are connected by definition
    });
  }

  // ── 5. Connect isolated clusters to nearest connected cluster ──────────
  // Sort junctions so connected ones come first
  junctions.sort((a, b) => (b.connected ? 1 : 0) - (a.connected ? 1 : 0));

  for (let i = 0; i < junctions.length; i++) {
    if (junctions[i].connected) continue;

    // Find nearest connected junction
    let nearestIdx = -1;
    let nearestDist = Infinity;
    for (let j = 0; j < junctions.length; j++) {
      if (!junctions[j].connected) continue;
      const dx = junctions[i].cx - junctions[j].cx;
      const dy = junctions[i].cy - junctions[j].cy;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = j;
      }
    }

    if (nearestIdx === -1) continue;

    // Mark as connected (the road will be pathfound in the next step)
    junctions[i].connected = true;
  }

  // ── 6. A* pathfind roads ───────────────────────────────────────────────
  // Each building gets a road to its junction.
  // For isolated buildings connected to another junction, pathfind to that junction.
  // We also track which grid cells are used by multiple roads → emergent intersections.

  interface RoadSegment {
    path: Vec2[];
    buildingIdx: number;
    junctionIdx: number;
  }

  const allSegments: RoadSegment[] = [];

  for (let ji = 0; ji < junctions.length; ji++) {
    const junc = junctions[ji];
    for (const bi of junc.buildingIndices) {
      const b = buildings[bi];
      const path = aStar(walkable, b.row, b.col, junc.gridR, junc.gridC, blockedCells);
      if (path && path.length > 0) {
        // Prepend building center so the road visually extends under the building sprite
        path.unshift({ x: b.cx, y: b.cy });
        allSegments.push({ path, buildingIdx: bi, junctionIdx: ji });
      }
    }
  }

  // Connect isolated junctions to nearest connected junction via A*
  for (let ji = 0; ji < junctions.length; ji++) {
    const junc = junctions[ji];
    if (junc.buildingIndices.length > 1) continue; // already multi-building

    // Find nearest connected junction that's not this one
    let nearestIdx = -1;
    let nearestDist = Infinity;
    for (let jj = 0; jj < junctions.length; jj++) {
      if (jj === ji || !junctions[jj].connected) continue;
      const dx = junc.cx - junctions[jj].cx;
      const dy = junc.cy - junctions[jj].cy;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = jj;
      }
    }
    if (nearestIdx === -1) continue;

    const target = junctions[nearestIdx];
    const path = aStar(walkable, junc.gridR, junc.gridC, target.gridR, target.gridC, blockedCells);
    if (path && path.length > 0) {
      // This is a road from isolated junction to the nearest connected junction
      // Add it as a segment — we'll track it for intersection detection
      allSegments.push({ path, buildingIdx: -1, junctionIdx: ji });
    }
  }

  // ── 6b. Deduplicate overlapping road segments ─────────────────────────
  // Adjacent buildings in the same cluster can produce nearly identical paths.
  // Remove segments where >55% of grid cells overlap in the same direction
  // as an already-kept segment.
  const cellKey = (r: number, c: number) => `${r},${c}`;

  // Pre-compute cell sets for each segment
  const segCellSets: Set<string>[] = allSegments.map(seg => {
    const s = new Set<string>();
    for (const pt of seg.path) {
      const cr = Math.round((pt.y - TILE_SIZE / 2) / TILE_SIZE);
      const cc = Math.round((pt.x - TILE_SIZE / 2) / TILE_SIZE);
      s.add(cellKey(cr, cc));
    }
    return s;
  });

  const segDirs: Map<string, { dx: number; dy: number }>[] = allSegments.map(seg => {
    const m = new Map<string, { dx: number; dy: number }>();
    for (let i = 0; i < seg.path.length - 1; i++) {
      const cr = Math.round((seg.path[i].y - TILE_SIZE / 2) / TILE_SIZE);
      const cc = Math.round((seg.path[i].x - TILE_SIZE / 2) / TILE_SIZE);
      const dx = seg.path[i + 1].x - seg.path[i].x;
      const dy = seg.path[i + 1].y - seg.path[i].y;
      m.set(cellKey(cr, cc), { dx, dy });
    }
    return m;
  });

  const kept: boolean[] = new Array(allSegments.length).fill(true);
  for (let i = 0; i < allSegments.length; i++) {
    if (!kept[i]) continue;
    for (let j = i + 1; j < allSegments.length; j++) {
      if (!kept[j]) continue;
      // Count shared cells with same direction
      let shared = 0, sameDir = 0;
      const smaller = segCellSets[i].size <= segCellSets[j].size ? i : j;
      const larger = smaller === i ? j : i;
      for (const ck of segCellSets[smaller]) {
        if (segCellSets[larger].has(ck)) {
          shared++;
          const dA = segDirs[i].get(ck);
          const dB = segDirs[j].get(ck);
          if (dA && dB) {
            const dot = dA.dx * dB.dx + dA.dy * dB.dy;
            if (dot > 0) sameDir++;
          }
        }
      }
      const minLen = Math.min(segCellSets[i].size, segCellSets[j].size);
      if (minLen > 0 && sameDir / minLen > 0.55) {
        kept[j] = false; // drop the later duplicate
      }
    }
  }

  const dedupedSegments = allSegments.filter((_, i) => kept[i]);

  // ── 7. Detect emergent intersections ───────────────────────────────────
  // Where two roads from different segments share a grid cell or pass within
  // 1 tile of each other, mark that as an intersection.
  const cellUsage = new Map<string, number[]>(); // "r,c" → segment indices

  for (let si = 0; si < dedupedSegments.length; si++) {
    const seg = dedupedSegments[si];
    const seen = new Set<string>();
    for (const pt of seg.path) {
      const cr = Math.round((pt.y - TILE_SIZE / 2) / TILE_SIZE);
      const cc = Math.round((pt.x - TILE_SIZE / 2) / TILE_SIZE);
      const key = `${cr},${cc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!cellUsage.has(key)) cellUsage.set(key, []);
      cellUsage.get(key)!.push(si);
    }
  }

  // Find intersection points: cells used by 2+ segments
  const intersectionPoints: Vec2[] = [];
  for (const [_key, segIndices] of cellUsage) {
    const unique = new Set(segIndices);
    if (unique.size >= 2) {
      // Use the cell center as the intersection point
      const [r, c] = _key.split(',').map(Number);
      intersectionPoints.push({
        x: c * TILE_SIZE + TILE_SIZE / 2,
        y: r * TILE_SIZE + TILE_SIZE / 2,
      });
    }
  }

  // Merge nearby intersections (< TILE_SIZE apart)
  const mergedIntersections = mergeNearbyPoints(intersectionPoints, TILE_SIZE);

  // ── 8. Build final road paths ──────────────────────────────────────────
  // For each segment, insert intersection points as waypoints where the
  // road passes through them, then smooth the whole path.

  const roads: CityRoad[] = [];

  for (const seg of dedupedSegments) {
    // Ensure the road starts from the building edge (not center overlap)
    // and ends at the junction
    let points = [...seg.path];

    // Insert intersection waypoints
    points = insertIntersectionWaypoints(points, mergedIntersections);

    // Smooth with Chaikin
    points = smoothPath(points, SMOOTH_ITERATIONS);

    // Add noise (deterministic)
    addNoise(points, rng, NOISE_AMP);

    roads.push({ points });
  }

  // Junctions are not rendered — roads merge naturally at shared points.
  return { roads, junctions: [] };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Find the nearest walkable perimeter cell for a building placement. */
function findWalkablePerimeter(
  grid: GridTile[][],
  p: DecorationPlacement,
  blocked: Set<string>,
): { r: number; c: number } {
  // Check all cells adjacent to the building footprint
  let bestR = p.row, bestC = p.col;
  let bestDist = Infinity;
  const centerR = p.row + p.h / 2;
  const centerC = p.col + p.w / 2;

  for (let dr = -1; dr <= p.h; dr++) {
    for (let dc = -1; dc <= p.w; dc++) {
      // Only check perimeter (dr == -1 || dr == p.h || dc == -1 || dc == p.w)
      if (dr >= 0 && dr < p.h && dc >= 0 && dc < p.w) continue;

      const r = p.row + dr, c = p.col + dc;
      if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) continue;
      if (blocked.has(`${r},${c}`)) continue;

      const t = grid[r][c].type;
      if (t !== 'buildable' && t !== 'path' && t !== 'spawn' && t !== 'goal') continue;

      const d = Math.abs(r - centerR) + Math.abs(c - centerC);
      if (d < bestDist) {
        bestDist = d;
        bestR = r;
        bestC = c;
      }
    }
  }

  // Fallback: use the building's own cell (if somehow no perimeter is walkable)
  return { r: bestR, c: bestC };
}

/** Merge points that are within `threshold` pixels of each other. */
function mergeNearbyPoints(points: Vec2[], threshold: number): Vec2[] {
  const merged: Vec2[] = [];
  const used = new Set<number>();
  const tSq = threshold * threshold;

  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;
    let sumX = points[i].x, sumY = points[i].y;
    let count = 1;
    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue;
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      if (dx * dx + dy * dy < tSq) {
        sumX += points[j].x;
        sumY += points[j].y;
        count++;
        used.add(j);
      }
    }
    merged.push({ x: sumX / count, y: sumY / count });
  }
  return merged;
}

/**
 * Insert intersection points as waypoints in the road path.
 * For each intersection, find the closest point on the path and split
 * the segment there, replacing the nearest path point with the intersection.
 */
function insertIntersectionWaypoints(path: Vec2[], intersections: Vec2[]): Vec2[] {
  if (intersections.length === 0) return path;

  // For each intersection, find the path point it's closest to
  // and insert the intersection at that position
  const insertions: { idx: number; point: Vec2 }[] = [];

  for (const inter of intersections) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < path.length; i++) {
      const dx = path[i].x - inter.x, dy = path[i].y - inter.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    // Only insert if reasonably close (within 2 tiles)
    if (bestDist < (TILE_SIZE * 2) ** 2 && bestIdx > 0 && bestIdx < path.length - 1) {
      insertions.push({ idx: bestIdx, point: inter });
    }
  }

  if (insertions.length === 0) return path;

  // Replace path points at insertion indices with intersection points
  const result = [...path];
  // Sort descending so indices don't shift
  insertions.sort((a, b) => b.idx - a.idx);
  for (const ins of insertions) {
    result[ins.idx] = ins.point;
  }
  return result;
}

// ─── Rendering helper ───────────────────────────────────────────────────────

/**
 * Draw all decorative roads and junctions onto a Phaser Graphics object.
 * Call once after generateCityRoads() — the result is static.
 */
export function drawCityRoads(
  g: Phaser.GameObjects.Graphics,
  result: CityRoadResult,
  rng: () => number,
): void {
  const ROAD_BASE   = 0x7a6e58;  // cobblestone base
  const ROAD_DARK   = 0x5a4e30;  // edge shadow
  const ROAD_LIGHT  = 0x9a8e70;  // highlight stones

  // ── Draw road polygons ──────────────────────────────────────────────
  for (const road of result.roads) {
    const { points } = road;
    if (points.length < 2) continue;

    // Build left/right edge points
    const leftEdge: Vec2[] = [];
    const rightEdge: Vec2[] = [];

    for (let i = 0; i < points.length; i++) {
      // Compute tangent direction
      let tx: number, ty: number;
      if (i === 0) {
        tx = points[1].x - points[0].x;
        ty = points[1].y - points[0].y;
      } else if (i === points.length - 1) {
        tx = points[i].x - points[i - 1].x;
        ty = points[i].y - points[i - 1].y;
      } else {
        tx = points[i + 1].x - points[i - 1].x;
        ty = points[i + 1].y - points[i - 1].y;
      }
      const len = Math.sqrt(tx * tx + ty * ty) || 1;
      // Perpendicular normal
      const nx = -ty / len;
      const ny = tx / len;

      // Slight noise on half-width for organic edges
      const wobble = 1 + (rng() - 0.5) * 0.2;
      const hw = ROAD_HALF_WIDTH * wobble;

      leftEdge.push({ x: points[i].x + nx * hw, y: points[i].y + ny * hw });
      rightEdge.push({ x: points[i].x - nx * hw, y: points[i].y - ny * hw });
    }

    // Build polygon: left edge forward + right edge reversed
    const poly: Vec2[] = [...leftEdge, ...rightEdge.reverse()];

    // Fill road body — fully opaque
    g.fillStyle(ROAD_BASE, 1);
    g.beginPath();
    g.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      g.lineTo(poly[i].x, poly[i].y);
    }
    g.closePath();
    g.fillPath();

    // Dark edge stroke on left side
    g.lineStyle(1.5, ROAD_DARK, 0.6);
    g.beginPath();
    g.moveTo(leftEdge[0].x, leftEdge[0].y);
    for (let i = 1; i < leftEdge.length; i++) {
      g.lineTo(leftEdge[i].x, leftEdge[i].y);
    }
    g.strokePath();

    // Stone grain dots along the road center
    for (let i = 0; i < points.length; i += 3) {
      const pt = points[i];
      const dotCount = 2 + Math.floor(rng() * 2);
      for (let d = 0; d < dotCount; d++) {
        const ox = (rng() - 0.5) * ROAD_HALF_WIDTH * 1.4;
        const oy = (rng() - 0.5) * ROAD_HALF_WIDTH * 1.4;
        const color = rng() > 0.5 ? ROAD_LIGHT : ROAD_DARK;
        g.fillStyle(color, 0.3 + rng() * 0.15);
        g.fillRect(pt.x + ox - 1, pt.y + oy - 1, 2 + rng() * 2, 2 + rng() * 2);
      }
    }
  }
}
