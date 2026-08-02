/** Performance test settings — configured on the menu screen. */
export interface PerfSettings {
  /** Spawn enemies during perf test. */
  spawnEnemies: boolean;
  /** Milliseconds between enemy spawns (lower = faster). */
  enemySpawnRate: number;
  /** Total number of enemies to spawn. */
  enemyAmount: number;

  /** Place random towers on buildable tiles. */
  spawnTowers: boolean;
  /** Percentage (0–100) of buildable tiles to fill with towers. */
  towerPercentage: number;

  /** Place economy buildings during perf test. */
  placeEcoBuildings: boolean;
  /** Percentage (0–100) of buildable tiles to fill with eco buildings. */
  ecoBuildingPercentage: number;

  /** Grid column count (field width in tiles). */
  fieldCols: number;
  /** Grid row count (field height in tiles). */
  fieldRows: number;
}

export const DEFAULT_PERF_SETTINGS: PerfSettings = {
  spawnEnemies: false,
  enemySpawnRate: 50,
  enemyAmount: 200,

  spawnTowers: true,
  towerPercentage: 20,

  placeEcoBuildings: true,
  ecoBuildingPercentage: 20,

  fieldCols: 30,
  fieldRows: 19,
};

/** Available field size presets for the dropdown. */
export const FIELD_SIZE_PRESETS: { label: string; cols: number; rows: number }[] = [
  { label: '20×13 (Small)',  cols: 20, rows: 13 },
  { label: '30×19 (Default)', cols: 30, rows: 19 },
  { label: '40×25 (Large)',  cols: 40, rows: 25 },
];

/** Available spawn rate presets (ms). */
export const SPAWN_RATE_PRESETS: { label: string; value: number }[] = [
  { label: '1ms',  value: 1 },
  { label: '4ms',  value: 4 },
  { label: '10ms', value: 10 },
  { label: '50ms', value: 50 },
  { label: '100ms',value: 100 },
];

/** Available enemy amount presets. */
export const ENEMY_AMOUNT_PRESETS: { label: string; value: number }[] = [
  { label: '50',   value: 50 },
  { label: '200',  value: 200 },
  { label: '500',  value: 500 },
  { label: '2000', value: 2000 },
  { label: '5000', value: 5000 },
];
