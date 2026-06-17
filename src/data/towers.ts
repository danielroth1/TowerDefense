import { COLORS } from '../utils/constants';

export type TowerType =
  | 'arrow'
  | 'cannon'
  | 'ice'
  | 'lightning'
  | 'poison'
  | 'boomerang';

export type EvolutionType =
  // Arrow evolutions
  | 'crossbow'      // faster, multi-shot
  | 'sniper'        // extreme range/damage, slow fire
  // Cannon evolutions
  | 'railgun'       // piercing shot
  | 'mortar'        // large AoE splash
  // Ice evolutions
  | 'blizzard'      // constant slow field
  | 'permafrost'    // shatters frozen enemies
  // Lightning evolutions
  | 'tesla'         // chain jumps x5
  | 'overload'      // AoE pulse on kill
  // Poison evolutions
  | 'plague'        // spreads to nearby enemies
  | 'acid'          // reduces armor permanently
  // Boomerang evolutions
  | 'hurricane'     // multiple spinning boomerangs
  | 'ricochet';     // bounces between enemies

export interface UpgradeTier {
  cost: number;
  damage: number;
  range: number;
  fireRate: number;       // ms between shots
  projectileSpeed: number;
  label: string;
  effectDuration?: number;
  effectValue?: number;
}

export interface EvolutionDef {
  type: EvolutionType;
  label: string;
  description: string;
  cost: number;
  color: number;
  stats: Partial<UpgradeTier>;
  special: string;
}

export interface TowerDef {
  type: TowerType;
  label: string;
  description: string;
  baseCost: number;
  color: number;
  baseStats: UpgradeTier;
  upgrades: [UpgradeTier, UpgradeTier]; // levels 2 and 3
  evolutions: [EvolutionDef, EvolutionDef];
  targetsFlying: boolean;
  drawShape: 'triangle' | 'circle' | 'diamond' | 'square' | 'star' | 'hex';
  effectType: string | null; // 'slow' | 'stun' | 'poison' | 'chain' | null
  effectValue: number;       // effect magnitude (0-1 slow fraction, etc.)
  effectDuration: number;    // ms
  splashRadius: number;      // 0 = no splash
}

export const TOWER_DEFS: Record<TowerType, TowerDef> = {
  arrow: {
    type: 'arrow',
    label: 'Arrow Tower',
    description: 'Fast-firing tower with single-target shots.',
    baseCost: 60,
    color: COLORS.TOWER_ARROW,
    drawShape: 'triangle',
    targetsFlying: true,
    effectType: null, effectValue: 0, effectDuration: 0, splashRadius: 0,
    baseStats: { cost: 60, damage: 12, range: 180, fireRate: 800, projectileSpeed: 380, label: 'Mk I' },
    upgrades: [
      { cost: 80,  damage: 20, range: 200, fireRate: 700, projectileSpeed: 420, label: 'Mk II' },
      { cost: 120, damage: 32, range: 220, fireRate: 600, projectileSpeed: 460, label: 'Mk III' },
    ],
    evolutions: [
      { type: 'crossbow', label: 'Crossbow', description: 'Fires 3 arrows in a spread every shot.', cost: 250, color: 0xaaccff,
        stats: { damage: 18, fireRate: 400 }, special: 'triple_shot' },
      { type: 'sniper',   label: 'Sniper',   description: 'Extreme range, ignores armor on hit.', cost: 250, color: 0x3355ff,
        stats: { damage: 90, range: 400, fireRate: 1800 }, special: 'armor_pierce' },
    ],
  },

  cannon: {
    type: 'cannon',
    label: 'Cannon Tower',
    description: 'Heavy explosive shots with area damage.',
    baseCost: 100,
    color: COLORS.TOWER_CANNON,
    drawShape: 'circle',
    targetsFlying: false,
    effectType: null, effectValue: 0, effectDuration: 0,
    splashRadius: 50,
    baseStats: { cost: 100, damage: 45, range: 160, fireRate: 1800, projectileSpeed: 280, label: 'Mk I' },
    upgrades: [
      { cost: 130, damage: 70,  range: 175, fireRate: 1600, projectileSpeed: 300, label: 'Mk II' },
      { cost: 180, damage: 110, range: 190, fireRate: 1400, projectileSpeed: 320, label: 'Mk III' },
    ],
    evolutions: [
      { type: 'railgun', label: 'Railgun', description: 'Pierces through all enemies in a line.', cost: 300, color: 0xff9955,
        stats: { damage: 200, range: 360, fireRate: 2500 }, special: 'pierce' },
      { type: 'mortar',  label: 'Mortar',  description: 'Lobs shells with huge splash radius.', cost: 300, color: 0xff3300,
        stats: { damage: 80, range: 250, fireRate: 2200, projectileSpeed: 180 }, special: 'big_splash' },
    ],
  },

  ice: {
    type: 'ice',
    label: 'Ice Tower',
    description: 'Slows enemies that it hits.',
    baseCost: 80,
    color: COLORS.TOWER_ICE,
    drawShape: 'diamond',
    targetsFlying: true,
    effectType: 'slow', effectValue: 0.5, effectDuration: 2000,
    splashRadius: 0,
    baseStats: { cost: 80, damage: 8, range: 165, fireRate: 1100, projectileSpeed: 300, label: 'Mk I' },
    upgrades: [
      { cost: 100, damage: 12, range: 185, fireRate: 1000, projectileSpeed: 310, label: 'Mk II' },
      { cost: 150, damage: 18, range: 205, fireRate: 900,  projectileSpeed: 320, label: 'Mk III' },
    ],
    evolutions: [
      { type: 'blizzard',   label: 'Blizzard',   description: 'Emits a constant slow field around itself.', cost: 280, color: 0x99eeff,
        stats: { range: 160 }, special: 'aura_slow' },
      { type: 'permafrost', label: 'Permafrost', description: 'Shatters fully-frozen enemies for 3× damage.', cost: 280, color: 0x2299cc,
        stats: { damage: 25, effectDuration: 3000 } as Partial<UpgradeTier>, special: 'shatter' },
    ],
  },

  lightning: {
    type: 'lightning',
    label: 'Lightning Tower',
    description: 'Chains to nearby enemies after initial hit.',
    baseCost: 120,
    color: COLORS.TOWER_LIGHTNING,
    drawShape: 'star',
    targetsFlying: true,
    effectType: 'stun', effectValue: 0, effectDuration: 400,
    splashRadius: 0,
    baseStats: { cost: 120, damage: 30, range: 170, fireRate: 1400, projectileSpeed: 600, label: 'Mk I' },
    upgrades: [
      { cost: 160, damage: 48,  range: 190, fireRate: 1300, projectileSpeed: 650, label: 'Mk II' },
      { cost: 220, damage: 72,  range: 210, fireRate: 1100, projectileSpeed: 700, label: 'Mk III' },
    ],
    evolutions: [
      { type: 'tesla',    label: 'Tesla',    description: 'Chains to 5 targets; each jump does 80% of prev.', cost: 320, color: 0xffff88,
        stats: { damage: 90 }, special: 'chain_x5' },
      { type: 'overload', label: 'Overload', description: 'Enemy deaths release AoE pulse.', cost: 320, color: 0xff8800,
        stats: { damage: 60, fireRate: 900 }, special: 'death_pulse' },
    ],
  },

  poison: {
    type: 'poison',
    label: 'Poison Tower',
    description: 'Applies damage-over-time poison stacks.',
    baseCost: 90,
    color: COLORS.TOWER_POISON,
    drawShape: 'hex',
    targetsFlying: false,
    effectType: 'poison', effectValue: 8, effectDuration: 4000,
    splashRadius: 0,
    baseStats: { cost: 90, damage: 5, range: 175, fireRate: 1200, projectileSpeed: 260, label: 'Mk I' },
    upgrades: [
      { cost: 110, damage: 8,  range: 195, fireRate: 1100, projectileSpeed: 270, label: 'Mk II' },
      { cost: 160, damage: 12, range: 215, fireRate: 1000, projectileSpeed: 280, label: 'Mk III' },
    ],
    evolutions: [
      { type: 'plague', label: 'Plague', description: 'Poison spreads to nearby enemies on death.', cost: 290, color: 0x99ff44,
        stats: { effectValue: 12, effectDuration: 6000 } as Partial<UpgradeTier>, special: 'spread_poison' },
      { type: 'acid',   label: 'Acid',   description: 'Permanently reduces enemy armor by 20%.', cost: 290, color: 0xccff00,
        stats: { damage: 20, effectDuration: 0 }, special: 'armor_reduce' },
    ],
  },

  boomerang: {
    type: 'boomerang',
    label: 'Boomerang Tower',
    description: 'Throws a bouncing projectile that returns.',
    baseCost: 110,
    color: COLORS.TOWER_BOOMERANG,
    drawShape: 'square',
    targetsFlying: true,
    effectType: null, effectValue: 0, effectDuration: 0,
    splashRadius: 0,
    baseStats: { cost: 110, damage: 28, range: 190, fireRate: 1600, projectileSpeed: 320, label: 'Mk I' },
    upgrades: [
      { cost: 140, damage: 44,  range: 210, fireRate: 1400, projectileSpeed: 340, label: 'Mk II' },
      { cost: 200, damage: 68,  range: 230, fireRate: 1200, projectileSpeed: 360, label: 'Mk III' },
    ],
    evolutions: [
      { type: 'hurricane', label: 'Hurricane', description: 'Constantly spins 4 boomerangs around the tower.', cost: 310, color: 0xff99dd,
        stats: { damage: 40, fireRate: 500 }, special: 'orbit' },
      { type: 'ricochet',  label: 'Ricochet',  description: 'Bounces between up to 8 enemies.', cost: 310, color: 0xff44aa,
        stats: { damage: 55 }, special: 'bounce_x8' },
    ],
  },
};

export const TOWER_TYPES_ORDERED: TowerType[] = [
  'arrow', 'cannon', 'ice', 'lightning', 'poison', 'boomerang',
];
