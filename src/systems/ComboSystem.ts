import Phaser from 'phaser';
import { COMBO_DRAIN_MS, COMBO_THRESHOLDS, COMBO_MULTIPLIERS } from '../utils/constants';

export class ComboSystem {
  private scene: Phaser.Scene;
  killCount: number = 0;
  private drainTimer: number = 0;
  private _tier: number = 0;

  get tier(): number { return this._tier; }
  get multiplier(): number { return COMBO_MULTIPLIERS[this._tier]; }

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  onKill() {
    this.killCount++;
    this.drainTimer = 0;
    const prevTier = this._tier;
    this._tier = this.calcTier();
    if (this._tier !== prevTier) {
      this.scene.events.emit('combo_tier_changed', this._tier, this.multiplier);
    }
    this.scene.events.emit('combo_updated', this.killCount, this.multiplier);
  }

  onLeak() {
    // Combo breaks on enemy leak
    this.killCount = 0;
    this._tier = 0;
    this.drainTimer = 0;
    this.scene.events.emit('combo_updated', 0, 1);
  }

  update(delta: number) {
    if (this.killCount === 0) return;
    this.drainTimer += delta;
    if (this.drainTimer >= COMBO_DRAIN_MS) {
      this.killCount = Math.max(0, this.killCount - 1);
      this.drainTimer = 0;
      const newTier = this.calcTier();
      if (newTier !== this._tier) {
        this._tier = newTier;
        this.scene.events.emit('combo_tier_changed', this._tier, this.multiplier);
      }
      this.scene.events.emit('combo_updated', this.killCount, this.multiplier);
    }
  }

  private calcTier(): number {
    for (let i = COMBO_THRESHOLDS.length - 1; i >= 0; i--) {
      if (this.killCount >= COMBO_THRESHOLDS[i]) return i;
    }
    return 0;
  }
}
