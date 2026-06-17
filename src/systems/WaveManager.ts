import Phaser from 'phaser';
import { Enemy } from '../entities/Enemy';
import { ENEMY_DEFS, BOSS_DEFS, scaleEnemyStats } from '../data/enemies';
import type { EnemyDef, EnemyType, BossType } from '../data/enemies';
import { getWaveDef } from '../data/waves';
import { TOTAL_WAVES } from '../utils/constants';

export class WaveManager {
  private scene: Phaser.Scene;
  private enemyGroup: Phaser.Physics.Arcade.Group;
  private flyerGroup: Phaser.Physics.Arcade.Group;
  private waypoints: { x: number; y: number }[];
  private spawnPoint: { x: number; y: number };

  currentWave: number = 0;
  totalEnemiesInWave: number = 0;
  enemiesKilled: number = 0;
  waveInProgress: boolean = false;
  betweenWaveInterval: number = 5000;
  countdown: number = 0;

  constructor(
    scene: Phaser.Scene,
    enemyGroup: Phaser.Physics.Arcade.Group,
    flyerGroup: Phaser.Physics.Arcade.Group,
    waypoints: { x: number; y: number }[],
    spawnPoint: { x: number; y: number },
  ) {
    this.scene = scene; this.enemyGroup = enemyGroup;
    this.flyerGroup = flyerGroup; this.waypoints = waypoints;
    this.spawnPoint = spawnPoint;
  }

  startNextWave(_early = false) {
    if (this.currentWave >= TOTAL_WAVES) {
      this.scene.events.emit('all_waves_cleared'); return;
    }
    this.currentWave++; this.waveInProgress = true;
    this.enemiesKilled = 0; this.countdown = 0;
    const wd = getWaveDef(this.currentWave);
    this.scene.events.emit('wave_started', this.currentWave, wd.isBoss);
    let total = 0;
    for (const g of wd.groups) { total += g.count; this.scheduleGroup(g); }
    this.totalEnemiesInWave = total;
  }

  private scheduleGroup(g: { type: EnemyType | BossType; count: number; interval: number; delay: number }) {
    for (let i = 0; i < g.count; i++)
      this.scene.time.delayedCall(g.delay + i * g.interval, () => this.spawnEnemy(g.type));
  }

  private spawnEnemy(type: EnemyType | BossType) {
    const raw: EnemyDef | undefined = (ENEMY_DEFS as any)[type] ?? (BOSS_DEFS as any)[type];
    if (!raw) return;
    const def = scaleEnemyStats(raw, this.currentWave);
    const e = new Enemy(this.scene, this.spawnPoint.x, this.spawnPoint.y, def, this.waypoints);
    (def.isFlying ? this.flyerGroup : this.enemyGroup).add(e);
  }

  onEnemyDied() { this.enemiesKilled++; this.checkWaveComplete(); }
  onEnemyReachedGoal() { this.enemiesKilled++; this.checkWaveComplete(); }

  private checkWaveComplete() {
    if (!this.waveInProgress) return;
    if (this.enemiesKilled >= this.totalEnemiesInWave) {
      this.waveInProgress = false; this.countdown = this.betweenWaveInterval;
      this.scene.events.emit('wave_complete', this.currentWave);
    }
  }

  update(delta: number) {
    if (!this.waveInProgress && this.countdown > 0) {
      this.countdown -= delta;
      if (this.countdown <= 0) { this.countdown = 0; this.startNextWave(); }
    }
  }

  sendEarlyWave() { this.startNextWave(true); }
}
