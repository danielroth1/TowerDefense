import Phaser from 'phaser';
import type { TowerType, EvolutionType, TowerDef, UpgradeTier } from '../data/towers';
import { TOWER_DEFS } from '../data/towers';
import { COLORS, TILE_SIZE, SELL_REFUND_RATIO, MAX_TOWER_LEVEL } from '../utils/constants';
import type { Enemy } from './Enemy';
import type { SynergyEffect } from '../data/synergies';

export class Tower extends Phaser.GameObjects.Container {
  readonly towerType: TowerType;
  level: number = 1;
  evolved: boolean = false;
  evolutionType: EvolutionType | null = null;
  totalSpent: number = 0;

  // Live stats (modified by upgrades + synergies)
  damage: number;
  range: number;
  fireRate: number;
  projectileSpeed: number;
  effectType: string | null;
  effectValue: number;
  effectDuration: number;
  splashRadius: number;

  // Synergy state (set by SynergySystem)
  synergyEffects: SynergyEffect[] = [];
  activeSynergyTags: string[] = [];

  // Targeting
  private target: Enemy | null = null;
  private fireTimer: number = 0;
  private rangeCircle: Phaser.GameObjects.Graphics | null = null;

  // Aura (blizzard evolution)
  isAura: boolean = false;

  get def(): TowerDef { return TOWER_DEFS[this.towerType]; }

  constructor(scene: Phaser.Scene, col: number, row: number, type: TowerType) {
    const cx = col * TILE_SIZE + TILE_SIZE / 2;
    const cy = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, cx, cy);
    this.towerType = type;

    const base = this.def.baseStats;
    this.damage         = base.damage;
    this.range          = base.range;
    this.fireRate       = base.fireRate;
    this.projectileSpeed= base.projectileSpeed;
    this.effectType     = this.def.effectType;
    this.effectValue    = this.def.effectValue;
    this.effectDuration = this.def.effectDuration;
    this.splashRadius   = this.def.splashRadius;
    this.totalSpent     = this.def.baseCost;

    scene.add.existing(this);
    this.setDepth(2);
    this.redraw();
  }

  // ─── Visual ─────────────────────────────────────────────────────────────
  redraw() {
    this.removeAll(true);
    const levelKey = Math.min(this.level - 1, 3);
    const sprite = this.scene.add.image(0, 0, `tower_${this.towerType}_${levelKey}`);
    this.add(sprite);
  }

  showRange(show: boolean) {
    this.rangeCircle?.destroy();
    this.rangeCircle = null;
    if (!show) return;
    this.rangeCircle = this.scene.add.graphics().setDepth(1);
    this.rangeCircle.lineStyle(3, COLORS.TOWER_RANGE, 0.4);
    this.rangeCircle.strokeCircle(this.x, this.y, this.range);
  }

  /** The range circle graphics object, if currently shown. Used by the
   *  dual-camera system to ignore it on the UI camera. */
  getRangeCircle(): Phaser.GameObjects.Graphics | null {
    return this.rangeCircle;
  }

  // ─── Upgrade / Evolution ─────────────────────────────────────────────────
  canUpgrade(): boolean {
    return this.level < MAX_TOWER_LEVEL && !this.evolved;
  }

  upgradeCost(): number {
    if (!this.canUpgrade()) return Infinity;
    return this.def.upgrades[this.level - 1].cost;
  }

  upgrade() {
    if (!this.canUpgrade()) return;
    this.totalSpent += this.upgradeCost();
    this.level++;
    const tier: UpgradeTier = this.level === 2 ? this.def.upgrades[0] : this.def.upgrades[1];
    this.damage          = tier.damage;
    this.range           = tier.range;
    this.fireRate        = tier.fireRate;
    this.projectileSpeed = tier.projectileSpeed;
    this.redraw();
    this.applySynergies();
    // Bounce animation
    this.scene.tweens.add({ targets: this, scaleX: 1.25, scaleY: 1.25, duration: 120, yoyo: true, ease: 'Back.easeOut' });
  }

  canEvolve(): boolean {
    return this.level >= MAX_TOWER_LEVEL && !this.evolved;
  }

  evolve(branch: 0 | 1) {
    if (!this.canEvolve()) return;
    const evo = this.def.evolutions[branch];
    this.totalSpent += evo.cost;
    this.evolved = true;
    this.evolutionType = evo.type;

    if (evo.stats.damage)          this.damage          = evo.stats.damage;
    if (evo.stats.range)           this.range           = evo.stats.range;
    if (evo.stats.fireRate)        this.fireRate        = evo.stats.fireRate;
    if (evo.stats.projectileSpeed) this.projectileSpeed = evo.stats.projectileSpeed;

    if (evo.special === 'aura_slow') this.isAura = true;
    this.applySynergies();
    this.redraw();
    this.scene.tweens.add({ targets: this, scaleX: 1.4, scaleY: 1.4, duration: 200, yoyo: true });
  }

  sellValue(): number {
    return Math.floor(this.totalSpent * SELL_REFUND_RATIO);
  }

  // ─── Synergy ─────────────────────────────────────────────────────────────
  applySynergies() {
    // Reset to base stats first, then reapply
    const base = this.level >= 2 ? this.def.upgrades[Math.min(this.level - 2, 1)] : this.def.baseStats;
    this.damage          = base.damage;
    this.range           = base.range;
    this.fireRate        = base.fireRate;
    this.projectileSpeed = base.projectileSpeed;
    this.activeSynergyTags = [];

    for (const eff of this.synergyEffects) {
      if (eff.damageMultiplier) this.damage    = Math.round(this.damage * eff.damageMultiplier);
      if (eff.rangeBonus)       this.range    += eff.rangeBonus;
      if (eff.fireRateBonus)    this.fireRate  = Math.max(200, this.fireRate - eff.fireRateBonus);
      if (eff.specialTag)       this.activeSynergyTags.push(eff.specialTag);
    }
  }

  // ─── Combat ──────────────────────────────────────────────────────────────
  preUpdate(_time: number, delta: number) {
    this.fireTimer += delta;

    // Aura mode: handled by GameScene loop
    if (this.isAura) return;

    // Clear dead target
    if (this.target && !this.target.active) this.target = null;

    // Find target if none
    if (!this.target) this.target = this.findTarget();
    if (!this.target) return;

    // Check still in range
    const d = Phaser.Math.Distance.Between(this.x, this.y, this.target.x, this.target.y);
    if (d > this.range) { this.target = null; return; }

    // Rotate toward target (+90° offset because sprites face upward, not right)
    this.setRotation(Phaser.Math.Angle.Between(this.x, this.y, this.target.x, this.target.y) + Math.PI / 2);

    if (this.fireTimer >= this.fireRate) {
      this.fireTimer = 0;
      this.scene.events.emit('tower_shoot', this, this.target);
    }
  }

  findTarget(): Enemy | null {
    // GameScene handles the actual enemy group lookup via event
    let best: Enemy | null = null;
    let bestProgress = -1;
    this.scene.events.emit('tower_find_target', this, (enemy: Enemy) => {
      // Callback-style; GameScene calls this for each candidate
      const d = Phaser.Math.Distance.Between(this.x, this.y, enemy.x, enemy.y);
      if (d <= this.range && enemy.pathProgress > bestProgress) {
        best = enemy;
        bestProgress = enemy.pathProgress;
      }
    });
    return best;
  }
}
