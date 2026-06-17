import type { EnemyType, BossType } from './enemies';
import { BOSS_EVERY_N, TOTAL_WAVES } from '../utils/constants';

export interface SpawnGroup {
  type: EnemyType | BossType;
  count: number;
  interval: number;  // ms between spawns in this group
  delay: number;     // ms before this group starts (from wave start)
}

export interface WaveDef {
  wave: number;
  groups: SpawnGroup[];
  isBoss: boolean;
}

function bossForWave(wave: number): BossType {
  const bosses: BossType[] = ['juggernaut', 'phantom', 'overlord', 'splitter'];
  return bosses[Math.floor((wave / BOSS_EVERY_N - 1)) % bosses.length];
}

function buildWave(wave: number): WaveDef {
  const isBoss = wave % BOSS_EVERY_N === 0;
  const groups: SpawnGroup[] = [];

  if (isBoss) {
    // Boss wave: boss + support enemies
    groups.push({ type: bossForWave(wave), count: 1,  interval: 0,    delay: 0 });
    groups.push({ type: 'grunt',           count: 4,  interval: 800,  delay: 3000 });
    groups.push({ type: 'runner',          count: 4,  interval: 600,  delay: 4000 });
  } else {
    // Scale normal waves — keep counts LOW, HP scaling handles difficulty
    const gruntCount    = Math.min(2 + Math.floor(wave * 0.4),  8);
    const runnerCount   = wave >= 3  ? Math.min(Math.floor(wave * 0.25), 5)  : 0;
    const tankCount     = wave >= 5  ? Math.min(Math.floor(wave * 0.12), 3)  : 0;
    const flyerCount    = wave >= 4  ? Math.min(Math.floor(wave * 0.2),  4)  : 0;
    const healerCount   = wave >= 8  ? Math.min(Math.floor(wave * 0.08), 2)  : 0;
    const swarmCount    = wave >= 2  ? Math.min(Math.floor(wave * 0.6),  8)  : 0;

    if (gruntCount  > 0) groups.push({ type: 'grunt',     count: gruntCount,  interval: 700,  delay: 0    });
    if (swarmCount  > 0) groups.push({ type: 'swarmling', count: swarmCount,  interval: 300,  delay: 2000 });
    if (runnerCount > 0) groups.push({ type: 'runner',    count: runnerCount, interval: 600,  delay: 4000 });
    if (flyerCount  > 0) groups.push({ type: 'flyer',     count: flyerCount,  interval: 900,  delay: 5000 });
    if (tankCount   > 0) groups.push({ type: 'tank',      count: tankCount,   interval: 2000, delay: 6000 });
    if (healerCount > 0) groups.push({ type: 'healer',    count: healerCount, interval: 1500, delay: 8000 });
  }

  return { wave, groups, isBoss };
}

export const WAVE_DEFS: WaveDef[] = Array.from(
  { length: TOTAL_WAVES },
  (_, i) => buildWave(i + 1),
);

export function getWaveDef(wave: number): WaveDef {
  const idx = Math.min(wave - 1, TOTAL_WAVES - 1);
  return WAVE_DEFS[idx];
}
