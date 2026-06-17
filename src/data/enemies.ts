import { COLORS } from '../utils/constants';

export type EnemyType =
  | 'grunt'
  | 'runner'
  | 'tank'
  | 'flyer'
  | 'healer'
  | 'swarmling';

export type BossType =
  | 'juggernaut'
  | 'phantom'
  | 'overlord'
  | 'splitter';

export interface EnemyDef {
  type: EnemyType | BossType;
  label: string;
  baseHp: number;
  speed: number;
  reward: number;
  armor: number;
  radius: number;
  color: number;
  drawShape: 'circle' | 'square' | 'diamond' | 'tri' | 'star';
  isFlying: boolean;
  isBoss: boolean;
  special: string | null;
  specialValue: number;
  heroAttackRange?: number;   // px – if set, enemy will attack nearby hero
  heroAttackDamage?: number;
  heroAttackRate?: number;    // ms between attacks
}

export const ENEMY_DEFS: Record<EnemyType, EnemyDef> = {
  grunt: {
    type: 'grunt', label: 'Grunt',
    baseHp: 80, speed: 75, reward: 2, armor: 0, radius: 12,
    color: COLORS.ENEMY_GRUNT, drawShape: 'circle',
    isFlying: false, isBoss: false, special: null, specialValue: 0,
    heroAttackRange: 44, heroAttackDamage: 8, heroAttackRate: 2000,
  },
  runner: {
    type: 'runner', label: 'Runner',
    baseHp: 40, speed: 140, reward: 1, armor: 0, radius: 9,
    color: COLORS.ENEMY_RUNNER, drawShape: 'tri',
    isFlying: false, isBoss: false, special: null, specialValue: 0,
  },
  tank: {
    type: 'tank', label: 'Tank',
    baseHp: 400, speed: 40, reward: 5, armor: 15, radius: 18,
    color: COLORS.ENEMY_TANK, drawShape: 'square',
    isFlying: false, isBoss: false, special: null, specialValue: 0,
    heroAttackRange: 55, heroAttackDamage: 22, heroAttackRate: 2500,
  },
  flyer: {
    type: 'flyer', label: 'Flyer',
    baseHp: 60, speed: 100, reward: 3, armor: 0, radius: 10,
    color: COLORS.ENEMY_FLYER, drawShape: 'diamond',
    isFlying: true, isBoss: false, special: null, specialValue: 0,
  },
  healer: {
    type: 'healer', label: 'Healer',
    baseHp: 120, speed: 55, reward: 4, armor: 5, radius: 13,
    color: COLORS.ENEMY_HEALER, drawShape: 'star',
    isFlying: false, isBoss: false,
    special: 'heal_aura', specialValue: 8,
    heroAttackRange: 46, heroAttackDamage: 5, heroAttackRate: 3000,
  },
  swarmling: {
    type: 'swarmling', label: 'Swarmling',
    baseHp: 22, speed: 115, reward: 1, armor: 0, radius: 7,
    color: COLORS.ENEMY_SWARM, drawShape: 'circle',
    isFlying: false, isBoss: false, special: null, specialValue: 0,
  },
};

export const BOSS_DEFS: Record<BossType, EnemyDef> = {
  juggernaut: {
    type: 'juggernaut', label: 'Juggernaut',
    baseHp: 2000, speed: 35, reward: 40, armor: 30, radius: 28,
    color: 0xcc2200, drawShape: 'circle',
    isFlying: false, isBoss: true,
    special: 'spawn_grunts', specialValue: 3,
    heroAttackRange: 80, heroAttackDamage: 35, heroAttackRate: 1500,
  },
  phantom: {
    type: 'phantom', label: 'Phantom',
    baseHp: 1200, speed: 85, reward: 35, armor: 0, radius: 20,
    color: 0x8844cc, drawShape: 'diamond',
    isFlying: false, isBoss: true,
    special: 'phase', specialValue: 3000,
    heroAttackRange: 70, heroAttackDamage: 20, heroAttackRate: 2200,
  },
  overlord: {
    type: 'overlord', label: 'Overlord',
    baseHp: 1600, speed: 50, reward: 38, armor: 20, radius: 24,
    color: 0xff6600, drawShape: 'star',
    isFlying: false, isBoss: true,
    special: 'buff_aura', specialValue: 1.5,
    heroAttackRange: 75, heroAttackDamage: 28, heroAttackRate: 2000,
  },
  splitter: {
    type: 'splitter', label: 'Splitter',
    baseHp: 900,  speed: 60, reward: 32, armor: 10, radius: 22,
    color: 0xee2255, drawShape: 'square',
    isFlying: false, isBoss: true,
    special: 'split', specialValue: 4,
  },
};

/** Scale enemy stats per wave — HP scales hard, counts stay low */
export function scaleEnemyStats(def: EnemyDef, wave: number): EnemyDef {
  const f = 1 + (wave - 1) * 0.25;  // much steeper HP scaling
  return {
    ...def,
    baseHp: Math.round(def.baseHp * f),
    reward: Math.round(def.reward * (1 + (wave - 1) * 0.04)),
  };
}
