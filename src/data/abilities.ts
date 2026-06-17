import { COLORS } from '../utils/constants';

export type AbilityType = 'freeze' | 'meteor' | 'lightning_storm' | 'heal_aura';

export interface AbilityDef {
  type: AbilityType;
  label: string;
  description: string;
  cost: number;
  cooldown: number;    // ms
  radius: number;      // effect radius in pixels
  duration: number;    // ms for timed effects
  color: number;
  hotkey: string;
  damage: number;      // 0 for non-damaging
  specialValue: number;
}

export const ABILITY_DEFS: AbilityDef[] = [
  {
    type: 'freeze',
    label: 'Blizzard',
    description: 'Freezes all ground enemies in radius, slowing them 90% for 4s.',
    cost: 50,
    cooldown: 20000,
    radius: 160,
    duration: 4000,
    color: COLORS.FX_FREEZE,
    hotkey: '1',
    damage: 0,
    specialValue: 0.9, // slow fraction
  },
  {
    type: 'meteor',
    label: 'Meteor Strike',
    description: 'Calls a meteor that deals massive AoE damage.',
    cost: 80,
    cooldown: 30000,
    radius: 120,
    duration: 500,
    color: COLORS.FX_METEOR,
    hotkey: '2',
    damage: 400,
    specialValue: 0,
  },
  {
    type: 'lightning_storm',
    label: 'Lightning Storm',
    description: 'Chains lightning through up to 10 enemies in range.',
    cost: 60,
    cooldown: 25000,
    radius: 220,
    duration: 1200,
    color: COLORS.FX_CHAIN,
    hotkey: '3',
    damage: 120,
    specialValue: 10, // max chain targets
  },
  {
    type: 'heal_aura',
    label: 'Temporal Rift',
    description: 'Creates a rift that slows time 70% in radius for 5s.',
    cost: 70,
    cooldown: 35000,
    radius: 180,
    duration: 5000,
    color: 0xaa44ff,
    hotkey: '4',
    damage: 0,
    specialValue: 0.7, // slow fraction (affects all ground enemies in range)
  },
];
