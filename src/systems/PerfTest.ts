import Phaser from 'phaser';
import type { MapData } from './MapGenerator';
import type { SynergySystem } from './SynergySystem';
import type { TowerType } from '../data/towers';
import { TOWER_TYPES_ORDERED } from '../data/towers';
import { ENEMY_DEFS, scaleEnemyStats } from '../data/enemies';
import type { EnemyType } from '../data/enemies';
import { Enemy } from '../entities/Enemy';
import { createPRNG } from '../utils/helpers';
import type { PerfSettings } from '../data/PerfSettings';
import { DEFAULT_PERF_SETTINGS } from '../data/PerfSettings';
import type { EconomyBuildingType } from '../data/economy';
import { ECO_BUILDING_DEFS } from '../data/economy';

/**
 * Performance test: fills buildable tiles with towers, eco buildings,
 * and spawns enemies according to configurable settings from the menu.
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
  /** Callback to place an economy building — provided by GameScene. */
  private placeEco: (type: EconomyBuildingType, col: number, row: number) => void;
  private settings: PerfSettings;

  constructor(
    scene: Phaser.Scene,
    mapData: MapData,
    decorationBlockedCells: Set<string>,
    synergySystem: SynergySystem,
    enemyGroup: Phaser.Physics.Arcade.Group,
    flyerGroup: Phaser.Physics.Arcade.Group,
    uiCam: Phaser.Cameras.Scene2D.Camera | undefined,
    placeTower: (type: TowerType, col: number, row: number) => void,
    placeEco: (type: EconomyBuildingType, col: number, row: number) => void,
    settings?: PerfSettings | null,
  ) {
    this.scene = scene;
    this.mapData = mapData;
    this.decorationBlockedCells = decorationBlockedCells;
    this.synergySystem = synergySystem;
    this.enemyGroup = enemyGroup;
    this.flyerGroup = flyerGroup;
    this.uiCam = uiCam;
    this.placeTower = placeTower;
    this.placeEco = placeEco;
    this.settings = settings ?? DEFAULT_PERF_SETTINGS;
  }

  run(): void {
    const rng = createPRNG(this.mapData.seed + 0xDEAD);
    const enemyTypes: EnemyType[] = ['grunt', 'runner', 'tank', 'flyer', 'healer', 'swarmling'];

    // Collect buildable cells first so percentage calculations work
    const buildableCells = this.collectBuildableCells();

    if (this.settings.spawnTowers) {
      this.placeRandomTowers(rng, buildableCells);
    }
    if (this.settings.placeEcoBuildings) {
      this.placeRandomEcoBuildings(rng, buildableCells);
    }
    if (this.settings.spawnEnemies) {
      this.spawnEnemies(rng, enemyTypes);
    }
    this.showIndicator();
  }

  // ─── Buildable cell collection ─────────────────────────────────────────

  private collectBuildableCells(): { r: number; c: number }[] {
    const rows = this.mapData.grid.length;
    const cols = this.mapData.grid[0]?.length ?? 0;
    const cells: { r: number; c: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tile = this.mapData.grid[r][c];
        if (tile.type !== 'buildable') continue;
        if (this.decorationBlockedCells.has(`${r},${c}`)) continue;
        cells.push({ r, c });
      }
    }
    return cells;
  }

  // ─── Towers ────────────────────────────────────────────────────────────

  private placeRandomTowers(rng: () => number, buildableCells: { r: number; c: number }[]): void {
    const targetCount = Math.floor(buildableCells.length * this.settings.towerPercentage / 100);
    // Shuffle then take targetCount
    const shuffled = [...buildableCells].sort(() => rng() - 0.5);
    const selected = shuffled.slice(0, targetCount);

    for (const { r, c } of selected) {
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

  // ─── Eco Buildings ─────────────────────────────────────────────────────

  private placeRandomEcoBuildings(rng: () => number, buildableCells: { r: number; c: number }[]): void {
    const rows = this.mapData.grid.length;
    const cols = this.mapData.grid[0]?.length ?? 0;
    const targetCount = Math.floor(buildableCells.length * this.settings.ecoBuildingPercentage / 100);

    const shuffled = [...buildableCells].sort(() => rng() - 0.5);
    let placed = 0;

    for (const { r, c } of shuffled) {
      if (placed >= targetCount) break;
      const tile = this.mapData.grid[r][c];
      if (tile.type !== 'buildable') continue;

      // Only consider building types that make sense for this cell's
      // surroundings (farm anywhere, road buildings near roads, water
      // buildings only on the shoreline).
      const eligible = this.eligibleEcoTypes(r, c);
      if (eligible.length === 0) continue;

      const type = eligible[Math.floor(rng() * eligible.length)];
      const def = ECO_BUILDING_DEFS[type];

      // Bounds check for multi-cell buildings
      if (r + def.height > rows || c + def.width > cols) continue;

      // For non-straddle buildings, every footprint cell must be buildable
      if (!def.placement.straddlesWater) {
        let allBuildable = true;
        for (let dr = 0; dr < def.height && allBuildable; dr++) {
          for (let dc = 0; dc < def.width && allBuildable; dc++) {
            if (this.mapData.grid[r + dr][c + dc].type !== 'buildable') allBuildable = false;
          }
        }
        if (!allBuildable) continue;
      }

      this.placeEco(type, c, r);
      placed++;
    }
  }

  /**
   * Eco building types that are valid for the cell at (r, c):
   *  - farm: always (no special placement requirement)
   *  - mill / bakery / warehouse: require a road (path) neighbour
   *  - fishery / harbor: straddle water, so they require a water (ground) neighbour
   */
  private eligibleEcoTypes(r: number, c: number): EconomyBuildingType[] {
    const grid = this.mapData.grid;
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;

    let hasWaterNeighbor = false;
    let hasRoadNeighbor = false;
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const t = grid[nr][nc].type;
      if (t === 'ground') hasWaterNeighbor = true;
      else if (t === 'path') hasRoadNeighbor = true;
    }

    const eligible: EconomyBuildingType[] = ['farm'];
    if (hasRoadNeighbor) eligible.push('mill', 'bakery', 'warehouse');
    if (hasWaterNeighbor) eligible.push('fishery', 'harbor');
    return eligible;
  }

  // ─── Enemies ───────────────────────────────────────────────────────────

  private spawnEnemies(rng: () => number, enemyTypes: EnemyType[]): void {
    const { spawnPoint, waypoints } = this.mapData;
    const delayMs = this.settings.enemySpawnRate;
    const amount = this.settings.enemyAmount;

    for (let i = 0; i < amount; i++) {
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
    const parts: string[] = ['PERF TEST'];
    if (this.settings.spawnTowers) {
      parts.push(`${this.settings.towerPercentage}% towers`);
    }
    if (this.settings.placeEcoBuildings) {
      parts.push(`${this.settings.ecoBuildingPercentage}% eco`);
    }
    if (this.settings.spawnEnemies) {
      parts.push(`${this.settings.enemyAmount} enemies`);
    }
    const label = this.scene.add.text(8, 4, parts.join(' — '), {
      fontSize: '14px', fontFamily: 'monospace', color: '#ff8844',
    }).setScrollFactor(0).setDepth(100);
    if (this.uiCam) this.uiCam.ignore(label);
  }
}
