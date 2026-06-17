import type { TowerType } from './towers';

export interface SynergyDef {
  types: [TowerType, TowerType];
  label: string;
  description: string;
  color: number;
  effect: SynergyEffect;
}

export interface SynergyEffect {
  damageMultiplier?: number;      // multiply tower A damage
  rangeBonus?: number;            // flat range bonus to tower A
  fireRateBonus?: number;         // reduce fireRate by this ms (faster)
  specialTag?: string;            // 'shatter' | 'combust' | 'conduct' etc.
}

// Synergy is bidirectional: [A, B] applies to both A→B and B→A
export const SYNERGY_DEFS: SynergyDef[] = [
  {
    types: ['cannon', 'ice'],
    label: 'Shatter',
    description: 'Cannon deals ×2 damage to Ice-slowed enemies.',
    color: 0x99ddff,
    effect: { damageMultiplier: 2.0, specialTag: 'shatter' },
  },
  {
    types: ['lightning', 'ice'],
    label: 'Conduct',
    description: 'Lightning gains +40 range near an Ice tower.',
    color: 0xaaffee,
    effect: { rangeBonus: 40 },
  },
  {
    types: ['poison', 'cannon'],
    label: 'Combustion',
    description: 'Poisoned enemies hit by Cannon explode, dealing 50% bonus splash.',
    color: 0xff8800,
    effect: { damageMultiplier: 1.5, specialTag: 'combust' },
  },
  {
    types: ['arrow', 'lightning'],
    label: 'Static Arrow',
    description: 'Arrow shots briefly stun enemies (200 ms).',
    color: 0xffffaa,
    effect: { specialTag: 'mini_stun' },
  },
  {
    types: ['poison', 'ice'],
    label: 'Cryo-Toxin',
    description: 'Poison DoT ticks 50% faster on slowed enemies.',
    color: 0x88ff88,
    effect: { fireRateBonus: 300, specialTag: 'cryo_toxin' },
  },
  {
    types: ['boomerang', 'arrow'],
    label: 'Volley',
    description: 'Both towers gain +20% fire rate.',
    color: 0xffccee,
    effect: { fireRateBonus: 200 },
  },
  {
    types: ['cannon', 'lightning'],
    label: 'Overcharge',
    description: 'Cannon explosions chain lightning to 2 enemies.',
    color: 0xff9900,
    effect: { specialTag: 'overcharge' },
  },
  {
    types: ['ice', 'boomerang'],
    label: 'Arctic Spin',
    description: 'Boomerang applies Ice slow on hit.',
    color: 0xbbddff,
    effect: { specialTag: 'boomerang_slow' },
  },
];

/** Build lookup: given two tower types returns the synergy (order-insensitive) */
const _synergyMap = new Map<string, SynergyDef>();
for (const s of SYNERGY_DEFS) {
  _synergyMap.set(`${s.types[0]}|${s.types[1]}`, s);
  _synergyMap.set(`${s.types[1]}|${s.types[0]}`, s);
}

export function getSynergy(a: TowerType, b: TowerType): SynergyDef | null {
  return _synergyMap.get(`${a}|${b}`) ?? null;
}
