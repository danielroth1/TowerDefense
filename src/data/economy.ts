// ─── Economy Building Types ─────────────────────────────────────────────────

export type EconomyBuildingType =
  | 'farm'
  | 'mill'
  | 'bakery'
  | 'fishery'
  | 'harbor'
  | 'warehouse'
  | 'market'
  | 'lighthouse';

export type EconomyResource = 'wheat' | 'flour' | 'bread' | 'fish' | 'goods';

// ─── Upgrade Tier ────────────────────────────────────────────────────────────

export interface EconomyUpgradeTier {
  cost: number;
  cycleTime: number;        // ms between production cycles
  label: string;
  /** Multiplier applied to the base gold value of produced goods. */
  valueMultiplier?: number;
}

// ─── Building Definition ─────────────────────────────────────────────────────

export interface EconomyBuildingDef {
  type: EconomyBuildingType;
  label: string;
  description: string;
  baseCost: number;
  color: number;
  /** Grid dimensions (1×1 or 2×1 for harbor). */
  width: number;
  height: number;
  /** Texture key prefix. AI textures at `eco_{type}.png`, procedural fallback generated. */
  textureKey: string;
  /** Resource this building produces (if any). */
  produces: EconomyResource | null;
  /** Resource this building consumes (if any). Producer → Consumer chain. */
  consumes: EconomyResource | null;
  /** Base cycle time in ms between production ticks. */
  baseCycleTime: number;
  /** Gold value per unit produced (before chain bonus). */
  goldPerUnit: number;
  /** Upgrades: [level 2, level 3]. */
  upgrades: [EconomyUpgradeTier, EconomyUpgradeTier];
  /** Placement rules. */
  placement: {
    /** Must be on this tile type. */
    tileType: 'buildable';
    /** Must be adjacent to water (fishery, harbor, lighthouse). */
    requireWaterAdjacent: boolean;
    /** Must NOT be adjacent to water (farm). */
    forbidWaterAdjacent: boolean;
    /** Must be adjacent to a road (mill, bakery, warehouse). */
    requireRoadAdjacent: boolean;
    /** Straddles grass + water (harbor only). */
    straddlesWater: boolean;
  };
  /** Special behavior flags. */
  isEndpoint: boolean;       // Consumes goods and converts to gold (bakery, harbor)
  isStorage: boolean;        // Buffers goods (warehouse)
  isStretchGoal: boolean;    // Not in initial implementation
}

// ─── Building Definitions ────────────────────────────────────────────────────

export const ECO_BUILDING_DEFS: Record<EconomyBuildingType, EconomyBuildingDef> = {
  farm: {
    type: 'farm',
    label: 'Farm',
    description: 'Grows wheat. Place on grass away from water.',
    baseCost: 100,
    color: 0xd4a843,
    width: 1, height: 1,
    textureKey: 'eco_farm',
    produces: 'wheat',
    consumes: null,
    baseCycleTime: 12000,
    goldPerUnit: 5,
    upgrades: [
      { cost: 80,  cycleTime: 8000,  label: 'Irrigated', valueMultiplier: 1.0 },
      { cost: 120, cycleTime: 5000,  label: 'Fertile',   valueMultiplier: 1.0 },
    ],
    placement: {
      tileType: 'buildable',
      requireWaterAdjacent: false,
      forbidWaterAdjacent: true,
      requireRoadAdjacent: false,
      straddlesWater: false,
    },
    isEndpoint: false,
    isStorage: false,
    isStretchGoal: false,
  },

  mill: {
    type: 'mill',
    label: 'Mill',
    description: 'Grinds wheat into flour. Needs a road connection.',
    baseCost: 130,
    color: 0xc0b090,
    width: 1, height: 1,
    textureKey: 'eco_mill',
    produces: 'flour',
    consumes: 'wheat',
    baseCycleTime: 10000,
    goldPerUnit: 0, // Value comes from chain
    upgrades: [
      { cost: 100, cycleTime: 6000,  label: 'Windmill',         valueMultiplier: 1.0 },
      { cost: 150, cycleTime: 4000,  label: 'Industrial Mill',  valueMultiplier: 1.0 },
    ],
    placement: {
      tileType: 'buildable',
      requireWaterAdjacent: false,
      forbidWaterAdjacent: false,
      requireRoadAdjacent: true,
      straddlesWater: false,
    },
    isEndpoint: false,
    isStorage: false,
    isStretchGoal: false,
  },

  bakery: {
    type: 'bakery',
    label: 'Bakery',
    description: 'Bakes flour into bread. Needs a road connection.',
    baseCost: 160,
    color: 0xe8a850,
    width: 1, height: 1,
    textureKey: 'eco_bakery',
    produces: 'bread',
    consumes: 'flour',
    baseCycleTime: 10000,
    goldPerUnit: 0, // Bread goes to warehouse → market for gold
    upgrades: [
      { cost: 120, cycleTime: 7000,  label: 'Artisan Oven',  valueMultiplier: 1.0 },
      { cost: 180, cycleTime: 5000,  label: 'Brick Oven',    valueMultiplier: 1.0 },
    ],
    placement: {
      tileType: 'buildable',
      requireWaterAdjacent: false,
      forbidWaterAdjacent: false,
      requireRoadAdjacent: true,
      straddlesWater: false,
    },
    isEndpoint: false, // Market is the endpoint now
    isStorage: false,
    isStretchGoal: false,
  },

  fishery: {
    type: 'fishery',
    label: 'Fishery',
    description: 'Catches fish. Must be adjacent to water.',
    baseCost: 80,
    color: 0x5588bb,
    width: 1, height: 1,
    textureKey: 'eco_fishery',
    produces: 'fish',
    consumes: null,
    baseCycleTime: 10000,
    goldPerUnit: 0, // Value comes from harbor
    upgrades: [
      { cost: 60,  cycleTime: 7000,  label: 'Nets',    valueMultiplier: 1.0 },
      { cost: 100, cycleTime: 5000,  label: 'Trawler', valueMultiplier: 1.0 },
    ],
    placement: {
      tileType: 'buildable',
      requireWaterAdjacent: true,
      forbidWaterAdjacent: false,
      requireRoadAdjacent: false,
      straddlesWater: false,
    },
    isEndpoint: false,
    isStorage: false,
    isStretchGoal: false,
  },

  harbor: {
    type: 'harbor',
    label: 'Harbor',
    description: 'Processes fish into trade goods. Straddles water and grass.',
    baseCost: 200,
    color: 0x8b7355,
    width: 2, height: 1,
    textureKey: 'eco_harbor',
    produces: 'goods',
    consumes: 'fish',
    baseCycleTime: 8000, // Processes fish into goods
    goldPerUnit: 0, // Value comes from market via warehouse
    upgrades: [
      { cost: 150, cycleTime: 5500, label: 'Trade Dock',     valueMultiplier: 1.0 },
      { cost: 250, cycleTime: 4000, label: 'Grand Harbor',   valueMultiplier: 1.0 },
    ],
    placement: {
      tileType: 'buildable',
      requireWaterAdjacent: true,
      forbidWaterAdjacent: false,
      requireRoadAdjacent: false,
      straddlesWater: true,
    },
    isEndpoint: false,
    isStorage: false,
    isStretchGoal: false,
  },

  warehouse: {
    type: 'warehouse',
    label: 'Warehouse',
    description: 'Stores goods for bulk delivery bonus. Needs a road connection.',
    baseCost: 70,
    color: 0x887766,
    width: 1, height: 1,
    textureKey: 'eco_warehouse',
    produces: null,
    consumes: null,
    baseCycleTime: 0,
    goldPerUnit: 0,
    upgrades: [
      { cost: 50,  cycleTime: 0, label: 'Stockpile',  valueMultiplier: 1.5 },
      { cost: 80,  cycleTime: 0, label: 'Depot',      valueMultiplier: 2.0 },
    ],
    placement: {
      tileType: 'buildable',
      requireWaterAdjacent: false,
      forbidWaterAdjacent: false,
      requireRoadAdjacent: true,
      straddlesWater: false,
    },
    isEndpoint: false,
    isStorage: true,
    isStretchGoal: false,
  },

  market: {
    type: 'market',
    label: 'Market',
    description: 'Slowly sells warehouse goods for gold. Needs a road connection.',
    baseCost: 180,
    color: 0xe8c864,
    width: 1, height: 1,
    textureKey: 'eco_market',
    produces: null,
    consumes: null,
    baseCycleTime: 3000,  // Converts 1 unit every 3s
    goldPerUnit: 18,
    upgrades: [
      { cost: 130, cycleTime: 2200, label: 'Trade Post',  valueMultiplier: 1.0 },
      { cost: 200, cycleTime: 1500, label: 'Grand Bazaar', valueMultiplier: 1.25 },
    ],
    placement: {
      tileType: 'buildable',
      requireWaterAdjacent: false,
      forbidWaterAdjacent: false,
      requireRoadAdjacent: true,
      straddlesWater: false,
    },
    isEndpoint: true,
    isStorage: false,
    isStretchGoal: false,
  },

  lighthouse: {
    type: 'lighthouse',
    label: 'Lighthouse',
    description: 'Extends vision and boosts trade ship frequency. Must be on shoreline.',
    baseCost: 250,
    color: 0xffeedd,
    width: 1, height: 1,
    textureKey: 'eco_lighthouse',
    produces: null,
    consumes: null,
    baseCycleTime: 0,
    goldPerUnit: 0,
    upgrades: [
      { cost: 200, cycleTime: 0, label: 'Beacon',   valueMultiplier: 1.0 },
      { cost: 300, cycleTime: 0, label: 'Great Light', valueMultiplier: 1.0 },
    ],
    placement: {
      tileType: 'buildable',
      requireWaterAdjacent: true,
      forbidWaterAdjacent: false,
      requireRoadAdjacent: false,
      straddlesWater: false,
    },
    isEndpoint: false,
    isStorage: false,
    isStretchGoal: true,
  },
};

// ─── Helper: ordered list for UI panels ──────────────────────────────────────

/** Buildings available for placement (excludes stretch goals and markets which are decoration-only). */
export const ECO_BUILDING_TYPES: EconomyBuildingType[] = [
  'farm', 'fishery', 'mill', 'bakery', 'harbor', 'warehouse',
];

// ─── Escalating cost ─────────────────────────────────────────────────────────

/** Factor by which cost increases per additional building of the same type. */
export const ECO_COST_ESCALATION = 1.25;

/** Calculate the cost of the nth building of a given type (1-based). */
export function escalatedCost(def: EconomyBuildingDef, count: number): number {
  return Math.floor(def.baseCost * Math.pow(ECO_COST_ESCALATION, count));
}

// ─── Chain bonus ─────────────────────────────────────────────────────────────

/** Multiplier applied when a good passes through a complete chain. */
export const CHAIN_BONUS_MULTIPLIER = 1.25;

// ─── Warehouse ───────────────────────────────────────────────────────────────

export const WAREHOUSE_CAPACITY = 5;
export const WAREHOUSE_BULK_BONUS = 1.5;  // 50% bonus when full
