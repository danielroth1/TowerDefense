import { type GridTile } from './MapGenerator';
import { type DecorationPlacement } from './CityDecorator';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';
import { createPRNG } from '../utils/helpers';
import { buildWalkabilityGrid, findCartPath } from './CartPathfinder';

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
 *
 * Incremental updates: when buildings are added, unchanged road segments
 * preserve their existing noise so the network doesn't visually shift.
 */

// ─── Public types ───────────────────────────────────────────────────────────

interface Vec2 { x: number; y: number; }

/** A smoothed road segment (spine polyline between two nodes). */
interface CityRoad {
  points: Vec2[];
}

/** A junction or intersection node. */
interface JunctionNode {
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

/**
 * Persistent state for incremental road network updates.
 * Stored in GameScene and passed to generateCityRoadsIncremental()
 * so that unchanged road segments retain their existing noise.
 */
export interface RoadNetworkState {
  roads: CityRoad[];
  /** Per-cell boolean: 1 = road present, 0 = no road. */
  roadGrid: Uint8Array;
  /** Cell signatures for each road (sorted "r,c" keys joined by "|").
   *  Used to match old→new segments by A* path identity. */
  signatures: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Pixel distance threshold for clustering buildings (squared). */
const CLUSTER_DIST_SQ = (3.5 * TILE_SIZE) ** 2;  // ~3.5 tiles

/** Half-width of a decorative road in pixels. */
const ROAD_HALF_WIDTH = 2;

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

// ─── A* pathfinding delegated to CartPathfinder ────────────────────────────
// findCartPath() from CartPathfinder is used for all A* calls.

// ─── Road grid helper ───────────────────────────────────────────────────────

/**
 * Rasterize road polylines onto a per-cell boolean grid.
 * A cell is marked as "road" if any road point falls within
 * ROAD_HALF_WIDTH * 2 pixels of its center.
 */
function buildRoadGrid(roads: CityRoad[]): Uint8Array {
  const grid = new Uint8Array(GRID_ROWS * GRID_COLS);
  const halfTile = TILE_SIZE / 2;
  const radius = ROAD_HALF_WIDTH * 3; // generous coverage for rendered width

  for (const road of roads) {
    for (const pt of road.points) {
      const cr = Math.round((pt.y - halfTile) / TILE_SIZE);
      const cc = Math.round((pt.x - halfTile) / TILE_SIZE);
      // Mark the cell and its neighbors (road can span boundaries)
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = cr + dr, c = cc + dc;
          if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
            const cx = c * TILE_SIZE + halfTile;
            const cy = r * TILE_SIZE + halfTile;
            const dx = pt.x - cx, dy = pt.y - cy;
            if (dx * dx + dy * dy < radius * radius) {
              grid[r * GRID_COLS + c] = 1;
            }
          }
        }
      }
    }
  }
  return grid;
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

// ─── Cell signature helper ──────────────────────────────────────────────────

/** Build a stable string key from the set of grid cells a path covers.
 *  Used to compare road segments for identity (same A* path → same key). */
function segmentCellSignature(path: Vec2[]): string {
  const cells = new Set<string>();
  const halfTile = TILE_SIZE / 2;
  for (const pt of path) {
    const cr = Math.round((pt.y - halfTile) / TILE_SIZE);
    const cc = Math.round((pt.x - halfTile) / TILE_SIZE);
    cells.add(`${cr},${cc}`);
  }
  return [...cells].sort().join('|');
}

// ─── Core algorithm (no noise/smoothing) ────────────────────────────────────

interface RawSegment {
  path: Vec2[];
  buildingIdx: number;
  junctionIdx: number;
  /** Stable cell-set key for matching old→new segments. */
  signature: string;
}

interface RawNetwork {
  segments: RawSegment[];
  mergedIntersections: Vec2[];
}

/**
 * Compute the full road network topology: cluster, A* pathfind,
 * detect intersections. Returns raw (un-smoothed, un-noised) segments.
 */
function computeRoadNetwork(
  grid: GridTile[][],
  placements: DecorationPlacement[],
  blockedCells: Set<string>,
): RawNetwork {
  if (placements.length < 2) return { segments: [], mergedIntersections: [] };

  const walkable = buildWalkabilityGrid(grid);

  // ── Compute building center nodes ─────────────────────────────────
  interface BuildingNode {
    cx: number; cy: number;
    row: number; col: number;
    placementIdx: number;
  }

  const buildings: BuildingNode[] = placements.map((p, i) => {
    const cx = (p.col + p.w / 2) * TILE_SIZE;
    const cy = (p.row + p.h / 2) * TILE_SIZE;
    const perimeter = findWalkablePerimeter(grid, p, blockedCells);
    return { cx, cy, row: perimeter.r, col: perimeter.c, placementIdx: i };
  });

  // ── Cluster buildings (Union-Find) ────────────────────────────────
  const uf = new UnionFind(buildings.length);
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

  const clusterMap = new Map<number, number[]>();
  for (let i = 0; i < buildings.length; i++) {
    const root = uf.find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(i);
  }

  // ── Compute junction per cluster ──────────────────────────────────
  interface JunctionInfo {
    cx: number; cy: number;
    gridR: number; gridC: number;
    buildingIndices: number[];
    connected: boolean;
  }

  const junctions: JunctionInfo[] = [];

  for (const [_root, memberIndices] of clusterMap) {
    if (memberIndices.length === 1) {
      const b = buildings[memberIndices[0]];
      junctions.push({
        cx: b.cx, cy: b.cy,
        gridR: b.row, gridC: b.col,
        buildingIndices: memberIndices,
        connected: false,
      });
      continue;
    }

    let sumX = 0, sumY = 0;
    for (const bi of memberIndices) { sumX += buildings[bi].cx; sumY += buildings[bi].cy; }
    const centroidR = Math.round(sumY / memberIndices.length / TILE_SIZE);
    const centroidC = Math.round(sumX / memberIndices.length / TILE_SIZE);

    const searchRadius = 8;
    let bestR = centroidR, bestC = centroidC;
    let bestCost = Infinity;

    for (let dr = -searchRadius; dr <= searchRadius; dr++) {
      for (let dc = -searchRadius; dc <= searchRadius; dc++) {
        const cr = centroidR + dr, cc = centroidC + dc;
        if (cr < 0 || cr >= GRID_ROWS || cc < 0 || cc >= GRID_COLS) continue;
        if (walkable[cr * GRID_COLS + cc] === 0) continue;
        if (blockedCells.has(`${cr},${cc}`)) continue;

        const px = cc * TILE_SIZE + TILE_SIZE / 2;
        const py = cr * TILE_SIZE + TILE_SIZE / 2;
        let totalDist = 0;
        for (const bi of memberIndices) {
          const dx = px - buildings[bi].cx;
          const dy = py - buildings[bi].cy;
          totalDist += Math.sqrt(dx * dx + dy * dy);
        }
        if (totalDist < bestCost) { bestCost = totalDist; bestR = cr; bestC = cc; }
      }
    }

    junctions.push({
      cx: bestC * TILE_SIZE + TILE_SIZE / 2,
      cy: bestR * TILE_SIZE + TILE_SIZE / 2,
      gridR: bestR, gridC: bestC,
      buildingIndices: memberIndices,
      connected: true,
    });
  }

  // ── Connect isolated clusters ─────────────────────────────────────
  junctions.sort((a, b) => (b.connected ? 1 : 0) - (a.connected ? 1 : 0));
  for (let i = 0; i < junctions.length; i++) {
    if (junctions[i].connected) continue;
    let nearestIdx = -1, nearestDist = Infinity;
    for (let j = 0; j < junctions.length; j++) {
      if (!junctions[j].connected) continue;
      const dx = junctions[i].cx - junctions[j].cx;
      const dy = junctions[i].cy - junctions[j].cy;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) { nearestDist = d; nearestIdx = j; }
    }
    if (nearestIdx !== -1) junctions[i].connected = true;
  }

  // ── A* pathfind roads ─────────────────────────────────────────────
  const allSegments: RawSegment[] = [];

  for (let ji = 0; ji < junctions.length; ji++) {
    const junc = junctions[ji];
    for (const bi of junc.buildingIndices) {
      const b = buildings[bi];
      const path = findCartPath(walkable, blockedCells, b.row, b.col, junc.gridR, junc.gridC);
      if (path && path.length > 0) {
        path.unshift({ x: b.cx, y: b.cy });
        allSegments.push({
          path,
          buildingIdx: bi,
          junctionIdx: ji,
          signature: segmentCellSignature(path),
        });
      }
    }
  }

  for (let ji = 0; ji < junctions.length; ji++) {
    const junc = junctions[ji];
    if (junc.buildingIndices.length > 1) continue;

    let nearestIdx = -1, nearestDist = Infinity;
    for (let jj = 0; jj < junctions.length; jj++) {
      if (jj === ji || !junctions[jj].connected) continue;
      const dx = junc.cx - junctions[jj].cx;
      const dy = junc.cy - junctions[jj].cy;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) { nearestDist = d; nearestIdx = jj; }
    }
    if (nearestIdx === -1) continue;

    const target = junctions[nearestIdx];
    const path = findCartPath(walkable, blockedCells, junc.gridR, junc.gridC, target.gridR, target.gridC);
    if (path && path.length > 0) {
      allSegments.push({
        path,
        buildingIdx: -1,
        junctionIdx: ji,
        signature: segmentCellSignature(path),
      });
    }
  }

  // ── Detect emergent intersections ─────────────────────────────────
  const cellUsage = new Map<string, number[]>();
  for (let si = 0; si < allSegments.length; si++) {
    const seen = new Set<string>();
    for (const pt of allSegments[si].path) {
      const cr = Math.round((pt.y - TILE_SIZE / 2) / TILE_SIZE);
      const cc = Math.round((pt.x - TILE_SIZE / 2) / TILE_SIZE);
      const key = `${cr},${cc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!cellUsage.has(key)) cellUsage.set(key, []);
      cellUsage.get(key)!.push(si);
    }
  }

  const intersectionPoints: Vec2[] = [];
  for (const [key, segIndices] of cellUsage) {
    if (new Set(segIndices).size >= 2) {
      const [r, c] = key.split(',').map(Number);
      intersectionPoints.push({ x: c * TILE_SIZE + TILE_SIZE / 2, y: r * TILE_SIZE + TILE_SIZE / 2 });
    }
  }

  const mergedIntersections = mergeNearbyPoints(intersectionPoints, TILE_SIZE);

  return { segments: allSegments, mergedIntersections };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Incremental road network update.
 *
 * Computes the full new network, then matches old→new segments by A* path
 * identity (cell-set signature). Unchanged segments keep their existing
 * noise — only new or changed segments get fresh noise.
 *
 * Returns the rendered result and updated state for the next call.
 */
export function generateCityRoadsIncremental(
  grid: GridTile[][],
  placements: DecorationPlacement[],
  blockedCells: Set<string>,
  seed: number,
  prevState: RoadNetworkState | null,
): { result: CityRoadResult; state: RoadNetworkState } {
  if (placements.length < 2) {
    const empty: RoadNetworkState = { roads: [], roadGrid: new Uint8Array(GRID_ROWS * GRID_COLS), signatures: [] };
    return { result: { roads: [], junctions: [] }, state: empty };
  }

  const rng = createPRNG(seed + 0xC0DE);
  const { segments, mergedIntersections } = computeRoadNetwork(grid, placements, blockedCells);

  // ── First time (no previous state) → generate all from scratch ────
  if (!prevState || prevState.roads.length === 0) {
    const roads: CityRoad[] = [];
    const signatures: string[] = [];
    for (const seg of segments) {
      let points = [...seg.path];
      points = insertIntersectionWaypoints(points, mergedIntersections);
      points = smoothPath(points, SMOOTH_ITERATIONS);
      addNoise(points, rng, NOISE_AMP);
      roads.push({ points });
      signatures.push(seg.signature);
    }
    const roadGrid = buildRoadGrid(roads);
    return { result: { roads, junctions: [] }, state: { roads, roadGrid, signatures } };
  }

  // ── Match old→new by cell-set signature ──────────────────────────
  // Build a lookup: new signature → new segment index
  const newSigToIdx = new Map<string, number>();
  for (let i = 0; i < segments.length; i++) {
    newSigToIdx.set(segments[i].signature, i);
  }

  // Track which old roads are preserved and which new segments are covered
  const preservedOldRoads: CityRoad[] = [];
  const preservedSignatures: string[] = [];
  const coveredNewSigs = new Set<string>();

  for (let oi = 0; oi < prevState.roads.length; oi++) {
    const oldSig = prevState.signatures[oi];
    if (oldSig && newSigToIdx.has(oldSig)) {
      // Same A* path → preserve old road (keep its noise)
      preservedOldRoads.push(prevState.roads[oi]);
      preservedSignatures.push(oldSig);
      coveredNewSigs.add(oldSig);
    }
    // else: old segment no longer needed → drop it
  }

  // ── Generate new segments for uncovered signatures ────────────────
  const newRoads: CityRoad[] = [...preservedOldRoads];
  const newSignatures: string[] = [...preservedSignatures];

  for (let si = 0; si < segments.length; si++) {
    if (coveredNewSigs.has(segments[si].signature)) continue;

    // New or changed segment → generate with fresh noise
    let points = [...segments[si].path];
    points = insertIntersectionWaypoints(points, mergedIntersections);

    // Blend endpoints: if this new segment connects to a preserved road,
    // snap its first/last point to the nearest preserved road endpoint.
    points = blendEndpoints(points, preservedOldRoads);

    points = smoothPath(points, SMOOTH_ITERATIONS);
    addNoise(points, rng, NOISE_AMP);
    newRoads.push({ points });
    newSignatures.push(segments[si].signature);
  }

  const roadGrid = buildRoadGrid(newRoads);
  return {
    result: { roads: newRoads, junctions: [] },
    state: { roads: newRoads, roadGrid, signatures: newSignatures },
  };
}

/** Snap a new segment's endpoints to nearby preserved road endpoints
 *  so that Chaikin smoothing and noise blend seamlessly at joins. */
function blendEndpoints(newPoints: Vec2[], preservedRoads: CityRoad[]): Vec2[] {
  if (preservedRoads.length === 0 || newPoints.length < 2) return newPoints;

  const result = [...newPoints];
  const BLEND_RADIUS = TILE_SIZE * 1.5;
  const blendSq = BLEND_RADIUS * BLEND_RADIUS;

  // Find the closest preserved endpoint to newPoints[0]
  let bestFirst: Vec2 | null = null;
  let bestFirstDist = blendSq;
  for (const road of preservedRoads) {
    if (road.points.length === 0) continue;
    const ep = road.points[0];
    const dx = result[0].x - ep.x, dy = result[0].y - ep.y;
    if (dx * dx + dy * dy < bestFirstDist) {
      bestFirstDist = dx * dx + dy * dy;
      bestFirst = ep;
    }
  }
  if (bestFirst) result[0] = { ...bestFirst };

  // Find the closest preserved endpoint to newPoints[last]
  let bestLast: Vec2 | null = null;
  let bestLastDist = blendSq;
  for (const road of preservedRoads) {
    if (road.points.length === 0) continue;
    const ep = road.points[road.points.length - 1];
    const dx = result[result.length - 1].x - ep.x;
    const dy = result[result.length - 1].y - ep.y;
    if (dx * dx + dy * dy < bestLastDist) {
      bestLastDist = dx * dx + dy * dy;
      bestLast = ep;
    }
  }
  if (bestLast) result[result.length - 1] = { ...bestLast };

  return result;
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

  /**
   * Build left/right edge points for a road at a given half-width multiplier.
   * Returns { leftEdge, rightEdge, poly }.
   */
  function buildRoadPoly(points: Vec2[], widthMul: number) {
    const leftEdge: Vec2[] = [];
    const rightEdge: Vec2[] = [];

    for (let i = 0; i < points.length; i++) {
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
      const nx = -ty / len;
      const ny = tx / len;

      const wobble = 1 + (rng() - 0.5) * 0.2;
      const hw = ROAD_HALF_WIDTH * wobble * widthMul;

      leftEdge.push({ x: points[i].x + nx * hw, y: points[i].y + ny * hw });
      rightEdge.push({ x: points[i].x - nx * hw, y: points[i].y - ny * hw });
    }

    const poly: Vec2[] = [...leftEdge, ...rightEdge.reverse()];
    return { leftEdge, rightEdge, poly };
  }

  // ── Draw road polygons ──────────────────────────────────────────────
  for (const road of result.roads) {
    const { points } = road;
    if (points.length < 2) continue;

    // ── Soft blur edge (wider, low opacity) ─────────────────────────
    const blurPoly = buildRoadPoly(points, 2.2);
    g.fillStyle(ROAD_BASE, 0.10);
    g.beginPath();
    g.moveTo(blurPoly.poly[0].x, blurPoly.poly[0].y);
    for (let i = 1; i < blurPoly.poly.length; i++) {
      g.lineTo(blurPoly.poly[i].x, blurPoly.poly[i].y);
    }
    g.closePath();
    g.fillPath();

    // ── Mid blur edge (medium width, medium opacity) ────────────────
    const midPoly = buildRoadPoly(points, 1.5);
    g.fillStyle(ROAD_BASE, 0.20);
    g.beginPath();
    g.moveTo(midPoly.poly[0].x, midPoly.poly[0].y);
    for (let i = 1; i < midPoly.poly.length; i++) {
      g.lineTo(midPoly.poly[i].x, midPoly.poly[i].y);
    }
    g.closePath();
    g.fillPath();

    // ── Main road body — fully opaque ───────────────────────────────
    const mainPoly = buildRoadPoly(points, 1.0);
    g.fillStyle(ROAD_BASE, 1);
    g.beginPath();
    g.moveTo(mainPoly.poly[0].x, mainPoly.poly[0].y);
    for (let i = 1; i < mainPoly.poly.length; i++) {
      g.lineTo(mainPoly.poly[i].x, mainPoly.poly[i].y);
    }
    g.closePath();
    g.fillPath();

    // ── Subtle edge shadow stroke ───────────────────────────────────
    g.lineStyle(0.5, ROAD_DARK, 0.3);
    g.beginPath();
    g.moveTo(mainPoly.leftEdge[0].x, mainPoly.leftEdge[0].y);
    for (let i = 1; i < mainPoly.leftEdge.length; i++) {
      g.lineTo(mainPoly.leftEdge[i].x, mainPoly.leftEdge[i].y);
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
