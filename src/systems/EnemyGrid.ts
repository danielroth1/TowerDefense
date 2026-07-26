import { Enemy } from '../entities/Enemy';
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from '../utils/constants';

/**
 * Simple spatial hash (uniform grid) for efficient enemy lookups.
 *
 * The map is partitioned into cells. Each enemy registers into whichever
 * cell its position falls in. For range queries (targeting, auras, etc.),
 * only enemies in cells within range are checked — O(1) cell lookup instead
 * of O(N) full scan.
 */
export class EnemyGrid {
  /** Number of cells per row/column of the map grid. */
  private readonly cellCols: number;
  private readonly cellRows: number;
  /** Pixel size of one cell. */
  private readonly cellSize: number;

  /** Buckets: index = row * cellCols + col */
  private buckets: Enemy[][] = [];
  /** Scratch array for query results (reused to avoid allocation). */
  private _result: Enemy[] = [];

  constructor() {
    // One cell per 2 game-grid tiles gives a good balance:
    // enough granularity for ~100px range checks without too many cells.
    this.cellSize = TILE_SIZE * 4; // 236px per cell
    this.cellCols = Math.ceil((GRID_COLS * TILE_SIZE) / this.cellSize);
    this.cellRows = Math.ceil((GRID_ROWS * TILE_SIZE) / this.cellSize);
    const total = this.cellCols * this.cellRows;
    for (let i = 0; i < total; i++) {
      this.buckets.push([]);
    }
  }

  /** Map pixel coords to cell index. */
  private cellIndex(x: number, y: number): number {
    const col = Math.min(this.cellCols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const row = Math.min(this.cellRows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    return row * this.cellCols + col;
  }

  /** Cell ranges that overlap a circle of radius `r` centered at (cx, cy). */
  private *cellRange(cx: number, cy: number, r: number): Generator<number> {
    const minCol = Math.max(0, Math.floor((cx - r) / this.cellSize));
    const maxCol = Math.min(this.cellCols - 1, Math.floor((cx + r) / this.cellSize));
    const minRow = Math.max(0, Math.floor((cy - r) / this.cellSize));
    const maxRow = Math.min(this.cellRows - 1, Math.floor((cy + r) / this.cellSize));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        yield row * this.cellCols + col;
      }
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Remove all enemies from the grid (call before re-inserting). */
  clear(): void {
    for (const bucket of this.buckets) {
      bucket.length = 0;
    }
  }

  /** Insert a single enemy into its correct cell. */
  insert(enemy: Enemy): void {
    const idx = this.cellIndex(enemy.x, enemy.y);
    this.buckets[idx].push(enemy);
  }

  /** Remove a single enemy from the grid. */
  remove(enemy: Enemy): void {
    const idx = this.cellIndex(enemy.x, enemy.y);
    const bucket = this.buckets[idx];
    // Linear scan in a small bucket — average bucket size is tiny.
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (bucket[i] === enemy) {
        bucket.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Return the nearest active enemy within `range` of `(cx, cy)` that
   * has the highest `pathProgress`. Only checks cells within range.
   * Returns null if no enemy found.
   */
  findNearest(cx: number, cy: number, range: number): Enemy | null {
    let best: Enemy | null = null;
    let bestProgress = -1;
    const rangeSq = range * range;

    for (const cellIdx of this.cellRange(cx, cy, range)) {
      const bucket = this.buckets[cellIdx];
      for (const e of bucket) {
        if (!e.active || e.hp <= 0) continue;
        const dx = e.x - cx;
        const dy = e.y - cy;
        if (dx * dx + dy * dy <= rangeSq && e.pathProgress > bestProgress) {
          best = e;
          bestProgress = e.pathProgress;
        }
      }
    }
    return best;
  }

  /**
   * Call `cb` for every active enemy within `range` of `(cx, cy)`.
   * Uses a reusable scratch array to avoid allocation.
   */
  query(cx: number, cy: number, range: number, cb: (e: Enemy) => void): void {
    this._result.length = 0;
    const rangeSq = range * range;

    for (const cellIdx of this.cellRange(cx, cy, range)) {
      const bucket = this.buckets[cellIdx];
      for (const e of bucket) {
        if (!e.active || e.hp <= 0) continue;
        const dx = e.x - cx;
        const dy = e.y - cy;
        if (dx * dx + dy * dy <= rangeSq) {
          cb(e);
        }
      }
    }
  }

  /**
   * Returns an array of all active enemies within `range` of `(cx, cy)`.
   * Creates a new array each call — prefer `query()` when possible.
   */
  queryAll(cx: number, cy: number, range: number): Enemy[] {
    const result: Enemy[] = [];
    this.query(cx, cy, range, e => result.push(e));
    return result;
  }

  /**
   * Find a single active enemy within `range` that satisfies `predicate`.
   */
  find(cx: number, cy: number, range: number, predicate: (e: Enemy) => boolean): Enemy | null {
    const rangeSq = range * range;
    for (const cellIdx of this.cellRange(cx, cy, range)) {
      const bucket = this.buckets[cellIdx];
      for (const e of bucket) {
        if (!e.active || e.hp <= 0) continue;
        const dx = e.x - cx;
        const dy = e.y - cy;
        if (dx * dx + dy * dy <= rangeSq && predicate(e)) {
          return e;
        }
      }
    }
    return null;
  }

  /**
   * Return every active enemy across the entire grid (for fallback iterators
   * that need the full list, like splash damage). This still iterates all
   * enemies but uses the internal buckets.
   */
  getAllActive(): Enemy[] {
    this._result.length = 0;
    for (const bucket of this.buckets) {
      for (const e of bucket) {
        if (e.active && e.hp > 0) {
          this._result.push(e);
        }
      }
    }
    return this._result;
  }
}
