import Phaser from 'phaser';
import { ABILITY_DEFS, type AbilityDef, type AbilityType } from '../data/abilities';
import type { Enemy } from '../entities/Enemy';
import { SoundSystem } from './SoundSystem';

interface CooldownState {
  remaining: number;
  total: number;
}

export class AbilitySystem {
  private scene: Phaser.Scene;
  private cooldowns: Map<AbilityType, CooldownState> = new Map();
  private uiCam: Phaser.Cameras.Scene2D.Camera | null = null;
  pendingCast: AbilityType | null = null;

  setUICam(cam: Phaser.Cameras.Scene2D.Camera) { this.uiCam = cam; }

  private vfxGraphics(): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics();
    if (this.uiCam) this.uiCam.ignore(g);
    return g;
  }

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    for (const def of ABILITY_DEFS) {
      this.cooldowns.set(def.type, { remaining: 0, total: def.cooldown });
    }

    // Keyboard shortcuts
    const keys = scene.input.keyboard;
    if (keys) {
      keys.on('keydown-ONE',   () => this.selectAbility('freeze'));
      keys.on('keydown-TWO',   () => this.selectAbility('meteor'));
      keys.on('keydown-THREE', () => this.selectAbility('lightning_storm'));
      keys.on('keydown-FOUR',  () => this.selectAbility('heal_aura'));
    }
  }

  selectAbility(type: AbilityType) {
    const cd = this.cooldowns.get(type)!;
    const def = this.getDef(type);
    if (!def || cd.remaining > 0) return;
    this.pendingCast = this.pendingCast === type ? null : type;
    this.scene.events.emit('ability_selected', this.pendingCast);
  }

  cast(type: AbilityType, wx: number, wy: number, enemies: Enemy[]) {
    const def = this.getDef(type);
    if (!def) return;
    const cd = this.cooldowns.get(type)!;
    if (cd.remaining > 0) return;

    this.scene.events.emit('ability_spend', def.cost);
    cd.remaining = def.cooldown;
    this.pendingCast = null;
    this.scene.events.emit('ability_selected', null);

    switch (type) {
      case 'freeze':          SoundSystem.instance.play('ability_freeze'); this.castFreeze(def, wx, wy, enemies); break;
      case 'meteor':          SoundSystem.instance.play('ability_meteor'); this.castMeteor(def, wx, wy, enemies); break;
      case 'lightning_storm': SoundSystem.instance.play('ability_lightning'); this.castLightning(def, wx, wy, enemies); break;
      case 'heal_aura':       SoundSystem.instance.play('ability_rift'); this.castRift(def, wx, wy, enemies); break;
    }
  }

  private castFreeze(def: AbilityDef, wx: number, wy: number, enemies: Enemy[]) {
    this.showCircleEffect(wx, wy, def.radius, 0x99ddff, 0.5, 600);
    const now = this.scene.time.now;
    for (const e of enemies) {
      if (!e.def.isFlying && Phaser.Math.Distance.Between(wx, wy, e.x, e.y) <= def.radius) {
        e.applySlow(1 - def.specialValue, def.duration, now);
        e.setTint(0x99ddff);
      }
    }
    this.spawnParticles('particle_ice', wx, wy, 20);
  }

  private castMeteor(def: AbilityDef, wx: number, wy: number, enemies: Enemy[]) {
    // Targeting reticle then impact
    const g = this.vfxGraphics().setDepth(10);
    g.lineStyle(3, 0xff6600, 0.8);
    g.strokeCircle(wx, wy, def.radius);

    this.scene.tweens.add({
      targets: g,
      alpha: 0.2,
      duration: 800,
      yoyo: true,
      repeat: 2,
      onComplete: () => {
        g.destroy();
        // Impact
        this.showCircleEffect(wx, wy, def.radius, 0xff4400, 0.8, 400);
        this.spawnParticles('particle_fire', wx, wy, 40);
        this.spawnParticles('particle_smoke', wx, wy, 20);
        for (const e of enemies) {
          if (!e.active) continue;
          const d = Phaser.Math.Distance.Between(wx, wy, e.x, e.y);
          if (d <= def.radius) {
            const falloff = 1 - d / def.radius * 0.5;
            e.takeDamage(Math.round(def.damage * falloff));
            if (e.hp <= 0) e.die();
          }
        }
        this.scene.cameras.main.shake(300, 0.008);
      },
    });
  }

  private castLightning(def: AbilityDef, wx: number, wy: number, enemies: Enemy[]) {
    const inRange = enemies
      .filter(e => Phaser.Math.Distance.Between(wx, wy, e.x, e.y) <= def.radius)
      .sort((a, b) => b.pathProgress - a.pathProgress)
      .slice(0, def.specialValue);

    const g = this.vfxGraphics().setDepth(10);
    const now = this.scene.time.now;
    let prev: Enemy | null = null;
    for (const e of inRange) {
      if (!e.active) continue;
      e.takeDamage(def.damage);
      e.applyStun(600, now);
      if (e.hp <= 0) { e.die(); prev = null; continue; }
      if (prev) {
        g.lineStyle(3, 0xffff00, 1.0);
        this.drawLightningLine(g, prev.x, prev.y, e.x, e.y);
        // Extra arc flash
        g.lineStyle(1, 0xffffff, 0.5);
        this.drawLightningLine(g, prev.x, prev.y, e.x, e.y);
      }
      // Flash on hit enemy
      g.fillStyle(0xffff44, 0.6);
      g.fillCircle(e.x, e.y, 14);
      prev = e;
    }
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 600, onComplete: () => g.destroy() });
    this.spawnParticles('particle_spark', wx, wy, 25);
  }

  private castRift(def: AbilityDef, wx: number, wy: number, enemies: Enemy[]) {
    this.showCircleEffect(wx, wy, def.radius, 0xaa44ff, 0.3, def.duration);
    const now = this.scene.time.now;
    for (const e of enemies) {
      if (Phaser.Math.Distance.Between(wx, wy, e.x, e.y) <= def.radius) {
        e.applySlow(1 - def.specialValue, def.duration, now);
      }
    }
    // Pulsing ring
    const ring = this.vfxGraphics().setDepth(9);
    ring.lineStyle(2, 0xaa44ff, 0.6);
    ring.strokeCircle(wx, wy, def.radius);
    this.scene.tweens.add({ targets: ring, alpha: 0, duration: def.duration, onComplete: () => ring.destroy() });
    this.spawnParticles('particle_spark', wx, wy, 15);
  }

  private showCircleEffect(cx: number, cy: number, r: number, color: number, alpha: number, duration: number) {
    const g = this.vfxGraphics().setDepth(9);
    g.fillStyle(color, alpha * 0.5);
    g.fillCircle(cx, cy, r);
    g.lineStyle(3, color, alpha);
    g.strokeCircle(cx, cy, r);
    this.scene.tweens.add({ targets: g, alpha: 0, duration, onComplete: () => g.destroy() });
  }

  private drawLightningLine(g: Phaser.GameObjects.Graphics, x1: number, y1: number, x2: number, y2: number) {
    const segs = 6;
    let px = x1, py = y1;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const nx = x1 + (x2 - x1) * t + (Math.random() - 0.5) * 30;
      const ny = y1 + (y2 - y1) * t + (Math.random() - 0.5) * 30;
      g.lineBetween(px, py, nx, ny);
      px = nx; py = ny;
    }
  }

  private spawnParticles(key: string, x: number, y: number, count: number) {
    const em = this.scene.add.particles(x, y, key, {
      speed: { min: 40, max: 180 },
      lifespan: { min: 300, max: 700 },
      scale: { start: 1, end: 0 },
      quantity: count,
      emitting: false,
    });
    em.explode(count);
    this.scene.time.delayedCall(800, () => em.destroy());
  }

  getDef(type: AbilityType): AbilityDef | undefined {
    return ABILITY_DEFS.find(d => d.type === type);
  }

  getCooldown(type: AbilityType): CooldownState {
    return this.cooldowns.get(type)!;
  }

  update(delta: number) {
    for (const cd of this.cooldowns.values()) {
      cd.remaining = Math.max(0, cd.remaining - delta);
    }
  }
}
