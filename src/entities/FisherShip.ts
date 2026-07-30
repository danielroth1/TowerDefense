import Phaser from 'phaser';
import type { EconomyBuilding } from './EconomyBuilding';
import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';

/**
 * Ship states for the fishing cycle.
 */
export const ShipState = {
  IDLE: 'idle',           // Docked at the fishery
  MOVING_OUT: 'moving_out', // Sailing to a water fishing spot
  FISHING: 'fishing',     // Waiting at the fishing spot
  RETURNING: 'returning', // Sailing back to the fishery
} as const;
export type ShipState = typeof ShipState[keyof typeof ShipState];

/**
 * A small ship entity that lives at a fishery.
 * Cycles: IDLE → MOVING_OUT → FISHING → RETURNING → IDLE
 * When it returns, the parent fishery gains +1 fish inventory.
 */
export class FisherShip extends Phaser.GameObjects.Container {
  readonly fishery: EconomyBuilding;
  state: ShipState = ShipState.IDLE;

  // Timers
  private fishingTimer: number = 0;
  private fishingDuration: number = 5000; // ms to fish (reduced by upgrades)

  // Movement
  private targetX: number = 0;
  private targetY: number = 0;
  private speed: number = 40; // pixels per second

  // Visual
  private sprite: Phaser.GameObjects.Image | null = null;

  // Map reference for water checking
  private grid: { type: string }[][] = [];

  /** 0-based index of this ship at its fishery (so each ship picks a different spot). */
  private shipIndex: number;

  constructor(scene: Phaser.Scene, fishery: EconomyBuilding, grid: { type: string }[][], shipIndex: number = 0) {
    // Spawn at the water-side of the fishery based on rotation.
    // placeEconomyBuilding sets: 0=water right, 90=water above, 180=water left, 270=water below.
    let spawnCol = fishery.gridCol;
    let spawnRow = fishery.gridRow;
    switch (fishery.rotationDeg) {
      case 0:   spawnCol = fishery.gridCol + 1; break; // water right
      case 180: spawnCol = fishery.gridCol - 1; break; // water left
      case 90:  spawnRow = fishery.gridRow - 1; break; // water above
      case 270: spawnRow = fishery.gridRow + 1; break; // water below
    }
    const cx = (spawnCol + 0.5) * TILE_SIZE;
    const cy = (spawnRow + 0.5) * TILE_SIZE;
    super(scene, cx, cy);

    this.fishery = fishery;
    this.grid = grid;
    this.shipIndex = shipIndex;

    scene.add.existing(this);
    this.setDepth(0.22); // Above water, below terrain overlays
    this.redraw();
  }

  // ─── Visual ─────────────────────────────────────────────────────────────

  redraw() {
    this.removeAll(true);
    const texKey = 'eco_fisher_ship';
    if (this.scene.textures.exists(texKey)) {
      this.sprite = this.scene.add.image(0, 0, texKey);
      this.sprite.setDisplaySize(TILE_SIZE * 0.6, TILE_SIZE * 0.4);
      this.add(this.sprite);
    } else {
      // Procedural fallback — small boat shape
      const g = this.scene.add.graphics();
      // Hull
      g.fillStyle(0x8B6914, 1);
      g.fillRoundedRect(-10, -4, 20, 8, 3);
      // Cabin
      g.fillStyle(0xC4A882, 1);
      g.fillRect(-4, -7, 8, 5);
      // Mast
      g.lineStyle(1, 0x666666, 1);
      g.lineBetween(0, -7, 0, -14);
      // Sail
      g.fillStyle(0xEEEEEE, 0.8);
      g.fillTriangle(1, -13, 1, -6, 8, -9);
      this.add(g);
    }
  }

  // ─── Fishing cycle ──────────────────────────────────────────────────────

  /** Set the fishing duration (lower = faster, from upgrades). */
  setFishingDuration(ms: number) {
    this.fishingDuration = ms;
  }

  /** Start a fishing trip if idle. Returns true if trip started. */
  startTrip(): boolean {
    if (this.state !== ShipState.IDLE) return false;

    // Find a water cell to fish at
    const spot = this.findFishingSpot();
    if (!spot) return false;

    this.targetX = (spot.col + 0.5) * TILE_SIZE;
    this.targetY = (spot.row + 0.5) * TILE_SIZE;
    this.state = ShipState.MOVING_OUT;
    return true;
  }

  /** Find an adjacent water cell to fish at. Prefers cells further from shore. */
  private findFishingSpot(): { col: number; row: number } | null {
    // Determine water-side cell based on fishery rotation
    let baseCol = this.fishery.gridCol;
    let baseRow = this.fishery.gridRow;
    switch (this.fishery.rotationDeg) {
      case 0:   baseCol = this.fishery.gridCol + 1; break; // water right
      case 180: baseCol = this.fishery.gridCol - 1; break; // water left
      case 90:  baseRow = this.fishery.gridRow - 1; break; // water above
      case 270: baseRow = this.fishery.gridRow + 1; break; // water below
    }

    // BFS to find water cells, preferring deeper water (further from land)
    const visited = new Set<string>();
    const queue: { col: number; row: number; dist: number }[] = [];
    const candidates: { col: number; row: number; dist: number }[] = [];

    // Start from adjacent water cells
    const dirs = [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    for (const [dc, dr] of dirs) {
      const nc = baseCol + dc;
      const nr = baseRow + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      if (this.grid[nr][nc].type !== 'ground') continue; // 'ground' = water in the grid
      const key = `${nc},${nr}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ col: nc, row: nr, dist: 1 });
    }

    // BFS to find the best fishing spot (3-5 cells away)
    while (queue.length > 0) {
      const curr = queue.shift()!;
      candidates.push(curr);

      if (curr.dist >= 5) continue; // Max fishing distance

      for (const [dc, dr] of dirs) {
        const nc = curr.col + dc;
        const nr = curr.row + dr;
        if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
        if (this.grid[nr][nc].type !== 'ground') continue;
        const key = `${nc},${nr}`;
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({ col: nc, row: nr, dist: curr.dist + 1 });
      }
    }

    if (candidates.length === 0) return null;

    // Prefer medium-distance spots (2-4 cells away)
    const good = candidates.filter(c => c.dist >= 2 && c.dist <= 4);
    const pool = good.length > 0 ? good : candidates;

    // Pick a different spot per ship using shipIndex to offset into the pool.
    // Deterministic but unique per ship at the same fishery.
    const idx = ((this.fishery.gridCol * 31 + this.fishery.gridRow * 17 + this.shipIndex * 73) >>> 0) % pool.length;
    return { col: pool[idx].col, row: pool[idx].row };
  }

  // ─── Update ─────────────────────────────────────────────────────────────

  /**
   * Update the ship's state machine.
   * @param delta Frame delta in ms.
   * @returns true if the ship just completed a fishing trip (fish ready).
   */
  updateShip(delta: number): boolean {
    switch (this.state) {
      case ShipState.IDLE:
        return false;

      case ShipState.MOVING_OUT: {
        const arrived = this.moveToward(this.targetX, this.targetY, delta);
        // Mirror sprite to face movement direction (like trade carts)
        this.updateMirror(this.targetX, this.targetY);
        if (arrived) {
          this.state = ShipState.FISHING;
          this.fishingTimer = 0;
          // Reset to default orientation while fishing
          this.scaleX = 1;
        }
        return false;
      }

      case ShipState.FISHING:
        this.fishingTimer += delta;
        // Gentle bobbing animation while fishing
        if (this.sprite) {
          this.sprite.y = Math.sin(this.fishingTimer * 0.003) * 2;
        }
        if (this.fishingTimer >= this.fishingDuration) {
          this.state = ShipState.RETURNING;
          // Target is the water-side of the fishery based on rotation
          let retCol = this.fishery.gridCol;
          let retRow = this.fishery.gridRow;
          switch (this.fishery.rotationDeg) {
            case 0:   retCol = this.fishery.gridCol + 1; break; // water right
            case 180: retCol = this.fishery.gridCol - 1; break; // water left
            case 90:  retRow = this.fishery.gridRow - 1; break; // water above
            case 270: retRow = this.fishery.gridRow + 1; break; // water below
          }
          this.targetX = (retCol + 0.5) * TILE_SIZE;
          this.targetY = (retRow + 0.5) * TILE_SIZE;
        }
        return false;

      case ShipState.RETURNING: {
        const arrived = this.moveToward(this.targetX, this.targetY, delta);
        this.updateMirror(this.targetX, this.targetY);
        if (arrived) {
          this.state = ShipState.IDLE;
          this.scaleX = 1; // Reset orientation
          return true; // Fish ready!
        }
        return false;
      }
    }
  }

  private moveToward(tx: number, ty: number, delta: number): boolean {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = (this.speed * delta) / 1000;

    if (dist <= step) {
      this.setPosition(tx, ty);
      return true;
    }

    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
    return false;
  }

  /** Mirror sprite horizontally based on movement direction (like trade carts). */
  private updateMirror(tx: number, _ty: number) {
    const dx = tx - this.x;
    // Only flip when moving predominantly horizontally
    if (Math.abs(dx) > 1) this.scaleX = dx < 0 ? -1 : 1;
  }

  isIdle(): boolean {
    return this.state === ShipState.IDLE;
  }

  getState(): ShipState {
    return this.state;
  }
}
