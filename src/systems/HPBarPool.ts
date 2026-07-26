import Phaser from 'phaser';
import { COLORS } from '../utils/constants';
import type { Enemy } from '../entities/Enemy';

/**
 * Pooled HP bar renderer using 2 shared Graphics objects.
 *
 * Instead of each Enemy owning 2 Graphics objects (bg + fg = 2,000 objects
 * for 1k enemies), this draws ALL HP bars in a single pass each frame using
 * just 2 shared Graphics. Only damaged enemies (hp < maxHp) get bars drawn.
 */
export class HPBarPool {
  private bg: Phaser.GameObjects.Graphics;
  private fg: Phaser.GameObjects.Graphics;

  private readonly barWidth = 28;
  private readonly barHeight = 4;

  constructor(scene: Phaser.Scene) {
    this.bg = scene.add.graphics().setDepth(5);
    this.fg = scene.add.graphics().setDepth(6);
  }

  /** Graphics objects that should be ignored by the UI camera. */
  getGraphics(): Phaser.GameObjects.Graphics[] {
    return [this.bg, this.fg];
  }

  /**
   * Draw HP bars for all active enemies that have taken damage.
   * Call once per frame after enemies have moved.
   *
   * Draw order: all backgrounds first (single fillStyle), then all
   * foregrounds. This minimises WebGL state changes: N+1 fillStyle
   * calls instead of 2N.
   */
  render(groupA: Enemy[], groupB?: Enemy[]): void {
    this.bg.clear();
    this.fg.clear();

    const bw = this.barWidth;
    const bh = this.barHeight;

    // ── Pass 1: all backgrounds (same colour — single fillStyle) ──
    this.bg.fillStyle(0x000000, 0.7);
    this._drawBg(groupA, bw, bh);
    if (groupB) this._drawBg(groupB, bw, bh);

    // ── Pass 2: all foregrounds (varying colours) ──
    this._drawFg(groupA, bw, bh);
    if (groupB) this._drawFg(groupB, bw, bh);
  }

  private _drawBg(enemies: Enemy[], bw: number, bh: number): void {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active || e.hp <= 0 || e.hp >= e.maxHp) continue;
      this.bg.fillRect(e.x - bw / 2, e.y - e.def.radius - 10, bw, bh);
    }
  }

  private _drawFg(enemies: Enemy[], bw: number, bh: number): void {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active || e.hp <= 0 || e.hp >= e.maxHp) continue;
      const frac = e.hp / e.maxHp;
      const col = frac > 0.6 ? COLORS.HP_HIGH : frac > 0.3 ? COLORS.HP_MED : COLORS.HP_LOW;
      this.fg.fillStyle(col, 1);
      this.fg.fillRect(e.x - bw / 2, e.y - e.def.radius - 10, bw * frac, bh);
    }
  }

  destroy(): void {
    this.bg.destroy();
    this.fg.destroy();
  }
}
