import Phaser from 'phaser';
import type { Enemy } from './Enemy';

export interface ProjectileConfig {
  sourceX: number;
  sourceY: number;
  target: Enemy;
  damage: number;
  speed: number;
  textureKey: string;
  effectType: string | null;
  effectValue: number;
  effectDuration: number;
  splashRadius: number;
  specialTags: string[];
  // Special firing modes
  pierce?: boolean;
  bounceLeft?: number;    // ricochet/tesla
  bigSplash?: boolean;
}

export class Projectile extends Phaser.Physics.Arcade.Sprite {
  cfg: ProjectileConfig;
  private elapsed: number = 0;
  private maxLifetime: number = 4000;

  constructor(scene: Phaser.Scene, cfg: ProjectileConfig) {
    super(scene, cfg.sourceX, cfg.sourceY, cfg.textureKey);
    this.cfg = cfg;
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(3);
    this.moveTowardTarget();
  }

  private moveTowardTarget() {
    if (!this.cfg.target.active) {
      this.destroy();
      return;
    }
    const angle = Phaser.Math.Angle.Between(this.x, this.y, this.cfg.target.x, this.cfg.target.y);
    this.setRotation(angle);
    this.setVelocity(
      Math.cos(angle) * this.cfg.speed,
      Math.sin(angle) * this.cfg.speed,
    );
  }

  preUpdate(time: number, delta: number) {
    super.preUpdate(time, delta);
    this.elapsed += delta;
    if (this.elapsed > this.maxLifetime) { this.destroy(); return; }

    // Re-home on moving target (homing projectiles)
    if (this.cfg.target.active) {
      this.moveTowardTarget();
    }
  }

  onHit() {
    if (!this.active) return;
    this.scene.events.emit('projectile_hit', this, this.cfg.target);
    if (!this.cfg.pierce) {
      this.setActive(false).setVisible(false);
      this.destroy();
    }
  }
}
