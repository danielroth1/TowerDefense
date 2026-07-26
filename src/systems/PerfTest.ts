import Phaser from 'phaser';
import type { MapData } from './MapGenerator';
import type { SynergySystem } from './SynergySystem';
import type { TowerType } from '../data/towers';
import { TOWER_TYPES_ORDERED } from '../data/towers';
import { ENEMY_DEFS, scaleEnemyStats } from '../data/enemies';
import type { EnemyType } from '../data/enemies';
import { Enemy } from '../entities/Enemy';
import { GRID_COLS, GRID_ROWS } from '../utils/constants';
import { createPRNG } from '../utils/helpers';

/**
 * Performance test: fills every buildable tile with a random tower
 * at a random upgrade level, then spawns enemies.
 *
 * GameScene delegates to this class and remains unaware of perf-test details.
 */
export class PerfTest {
  private scene: Phaser.Scene;
  private mapData: MapData;
  private decorationBlockedCells: Set<string>;
  private synergySystem: SynergySystem;
  private enemyGroup: Phaser.Physics.Arcade.Group;
  private flyerGroup: Phaser.Physics.Arcade.Group;
  private uiCam: Phaser.Cameras.Scene2D.Camera | undefined;
  /** Callback to place a tower — provided by GameScene. */
  private placeTower: (type: TowerType, col: number, row: number) => void;

  constructor(
    scene: Phaser.Scene,
    mapData: MapData,
    decorationBlockedCells: Set<string>,
    synergySystem: SynergySystem,
    enemyGroup: Phaser.Physics.Arcade.Group,
    flyerGroup: Phaser.Physics.Arcade.Group,
    uiCam: Phaser.Cameras.Scene2D.Camera | undefined,
    placeTower: (type: TowerType, col: number, row: number) => void,
  ) {
    this.scene = scene;
    this.mapData = mapData;
    this.decorationBlockedCells = decorationBlockedCells;
    this.synergySystem = synergySystem;
    this.enemyGroup = enemyGroup;
    this.flyerGroup = flyerGroup;
    this.uiCam = uiCam;
    this.placeTower = placeTower;
  }

  run(): void {
    const rng = createPRNG(this.mapData.seed + 0xDEAD);
    const enemyTypes: EnemyType[] = ['grunt', 'runner', 'tank', 'flyer', 'healer', 'swarmling'];

    this.placeRandomTowers(rng);
    this.spawnEnemies(rng, enemyTypes);
    this.showIndicator();
  }

  // ─── Towers ────────────────────────────────────────────────────────────

  private placeRandomTowers(rng: () => number): void {
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tile = this.mapData.grid[r][c];
        if (tile.type !== 'buildable') continue;
        if (this.decorationBlockedCells.has(`${r},${c}`)) continue;
        if (this.synergySystem.getTowerAt(c, r)) continue;

        const typeIdx = Math.floor(rng() * TOWER_TYPES_ORDERED.length);
        const type = TOWER_TYPES_ORDERED[typeIdx];

        this.placeTower(type, c, r);

        const tower = this.synergySystem.getTowerAt(c, r);
        if (!tower) continue;

        // Random upgrades: 0-2 (level 1-3)
        const upgradeCount = Math.floor(rng() * 3);
        for (let u = 0; u < upgradeCount; u++) {
          if (tower.canUpgrade()) tower.upgrade();
        }

        // ~33% chance of evolution at max level
        if (tower.canEvolve() && rng() < 0.33) {
          const branch = Math.floor(rng() * 2) as 0 | 1;
          tower.evolve(branch);
        }
      }
    }
  }

  // ─── Enemies ───────────────────────────────────────────────────────────

  private spawnEnemies(rng: () => number, enemyTypes: EnemyType[]): void {
    const { spawnPoint, waypoints } = this.mapData;
    const delayMs = 4; // small gap so enemies don't stack

    for (let i = 0; i < 20000; i++) {
      this.scene.time.delayedCall(i * delayMs, () => {
        const typeIdx = Math.floor(rng() * enemyTypes.length);
        const rawDef = ENEMY_DEFS[enemyTypes[typeIdx]];
        const def = scaleEnemyStats(rawDef, 1);
        const e = new Enemy(this.scene, spawnPoint.x, spawnPoint.y, def, waypoints);
        (def.isFlying ? this.flyerGroup : this.enemyGroup).add(e);
      });
    }
  }

  // ─── UI ────────────────────────────────────────────────────────────────

  private showIndicator(): void {
    const label = this.scene.add.text(8, 4, 'PERF TEST — 200 enemies', {
      fontSize: '14px', fontFamily: 'monospace', color: '#ff8844',
    }).setScrollFactor(0).setDepth(100);
    if (this.uiCam) this.uiCam.ignore(label);
  }
}
