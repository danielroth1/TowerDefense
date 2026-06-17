import Phaser from 'phaser';
import type { EnemyDef } from '../data/enemies';
import { COLORS, TILE_SIZE, GRID_COLS, GRID_ROWS } from '../utils/constants';

export class Enemy extends Phaser.Physics.Arcade.Sprite {
  def: EnemyDef;
  maxHp: number;
  hp: number;
  speed: number;
  armor: number;
  reward: number;

  // Path following
  waypoints: { x: number; y: number }[];
  waypointIndex: number = 1;
  pathProgress: number = 0;   // 0-1 progress along path (for targeting priority)

  // Status effects
  slowFactor: number = 1;     // multiplied into speed (1 = normal)
  slowExpiry: number = 0;
  stunExpiry: number = 0;
  poisonStacks: PoisonStack[] = [];
  armorReduction: number = 0; // permanent from acid
  isPhased: boolean = false;  // Phantom boss phase

  private hpBarBg: Phaser.GameObjects.Graphics;
  private hpBarFg: Phaser.GameObjects.Graphics;

  // Boss state
  bossSpawnTimer: number = 0;
  phaseTimer: number = 0;

  // Hero attack
  heroAttackTimer: number = 0;

  // Stuck detection
  private stuckTimer: number = 0;
  private lastX: number = 0;
  private lastY: number = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, def: EnemyDef, waypoints: { x: number; y: number }[]) {
    super(scene, x, y, `enemy_${def.type}_sheet`, 0);
    this.def      = def;
    this.maxHp    = def.baseHp;
    this.hp       = def.baseHp;
    this.speed    = def.speed;
    this.armor    = def.armor;
    this.reward   = def.reward;
    this.waypoints = waypoints;

    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setCircle(def.radius, 16 - def.radius, 16 - def.radius);
    this.setDepth(2);

    // Start walk animation
    this.play(`enemy_${def.type}_walk`);

    // HP bars (world-space graphics, updated each frame)
    this.hpBarBg = scene.add.graphics().setDepth(5);
    this.hpBarFg = scene.add.graphics().setDepth(6);
  }

  takeDamage(amount: number, ignoreArmor = false): number {
    if (this.isPhased) return 0;
    const eff = this.armor - this.armorReduction;
    const dmg = ignoreArmor ? amount : Math.max(1, amount - Math.max(0, eff));
    this.hp -= dmg;
    return dmg;
  }

  applySlow(factor: number, duration: number, now: number) {
    this.slowFactor = Math.min(this.slowFactor, factor);
    this.slowExpiry = Math.max(this.slowExpiry, now + duration);
  }

  applyStun(duration: number, now: number) {
    this.stunExpiry = Math.max(this.stunExpiry, now + duration);
  }

  applyPoison(dps: number, duration: number, now: number) {
    this.poisonStacks.push({ dps, expiry: now + duration });
  }

  reduceArmor(fraction: number) {
    this.armorReduction = Math.min(this.armor, this.armorReduction + this.armor * fraction);
  }

  preUpdate(time: number, delta: number) {
    super.preUpdate(time, delta);

    // Status effect expiry
    if (time >= this.slowExpiry) this.slowFactor = 1;
    const stunned = time < this.stunExpiry;

    // Poison DoT
    if (this.poisonStacks.length > 0) {
      this.poisonStacks = this.poisonStacks.filter(s => s.expiry > time);
      const totalDps = this.poisonStacks.reduce((sum, s) => sum + s.dps, 0);
      if (totalDps > 0) {
        this.hp -= totalDps * (delta / 1000);
        // Green tint hint
        this.setTint(Phaser.Display.Color.GetColor(0x88, 0xff, 0x44));
      }
    } else {
      this.clearTint();
    }

    // Apply slow/freeze tint
    if (this.slowFactor < 0.5) {
      this.setTint(0x99ddff);
      this.anims.timeScale = this.slowFactor * 2;
    } else {
      this.clearTint();
      this.anims.timeScale = 1;
    }

    // Hero attack timer
    if (this.def.heroAttackRange) {
      this.heroAttackTimer = Math.max(0, this.heroAttackTimer - delta);
      if (this.heroAttackTimer <= 0 && !this.isPhased) {
        this.scene.events.emit('enemy_hero_range_check', this);
      }
    }

    // Die immediately if HP reached 0 or below (safety net)
    if (this.active && this.hp <= 0) {
      this.die();
      return;
    }

    if (!stunned && this.active) {
      this.followPath(delta);
    } else if (stunned) {
      this.setVelocity(0, 0);
    }

    // Stuck detection: if barely moving for 2s, teleport to next waypoint
    if (!stunned && this.active) {
      const dx = this.x - this.lastX, dy = this.y - this.lastY;
      if (dx * dx + dy * dy < 1) {
        this.stuckTimer += delta;
        if (this.stuckTimer > 2000 && this.waypointIndex < this.waypoints.length) {
          const wp = this.waypoints[this.waypointIndex];
          this.setPosition(wp.x, wp.y);
          this.waypointIndex = Math.min(this.waypointIndex + 1, this.waypoints.length - 1);
          this.stuckTimer = 0;
        }
      } else {
        this.stuckTimer = 0;
      }
      this.lastX = this.x;
      this.lastY = this.y;
    }

    // Bounds clamping – if pushed off map, teleport to previous waypoint
    const mapW = GRID_COLS * TILE_SIZE;
    const mapH = GRID_ROWS * TILE_SIZE;
    if (this.x < 4 || this.x > mapW - 4 || this.y < 4 || this.y > mapH - 4) {
      const wi = Math.max(0, this.waypointIndex - 1);
      const wp = this.waypoints[wi];
      this.setPosition(wp.x, wp.y);
    }

    this.updateHPBar();
  }

  private followPath(_delta: number) {
    if (this.waypointIndex >= this.waypoints.length) {
      // Reached goal
      this.scene.events.emit('enemy_reached_goal', this);
      this.die(false);
      return;
    }

    const target = this.waypoints[this.waypointIndex];
    const effectiveSpeed = this.speed * this.slowFactor * (TILE_SIZE / 48);
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 4) {
      this.waypointIndex++;
      this.pathProgress = this.waypointIndex / this.waypoints.length;
    } else {
      const nx = dx / dist;
      const ny = dy / dist;
      this.setVelocity(nx * effectiveSpeed, ny * effectiveSpeed);
      this.setRotation(Math.atan2(ny, nx));
    }
  }

  /** Returns HP bar graphics for dual-camera UI ignoring. */
  getHpBars(): Phaser.GameObjects.Graphics[] {
    return [this.hpBarBg, this.hpBarFg];
  }

  private updateHPBar() {
    const bw = 28;
    const bh = 4;
    const bx = this.x - bw / 2;
    const by = this.y - this.def.radius - 10;
    const frac = Math.max(0, this.hp / this.maxHp);
    const col = frac > 0.6 ? COLORS.HP_HIGH : frac > 0.3 ? COLORS.HP_MED : COLORS.HP_LOW;

    this.hpBarBg.clear();
    this.hpBarBg.fillStyle(0x000000, 0.7);
    this.hpBarBg.fillRect(bx, by, bw, bh);

    this.hpBarFg.clear();
    this.hpBarFg.fillStyle(col, 1);
    this.hpBarFg.fillRect(bx, by, bw * frac, bh);
  }

  die(awardGold = true) {
    if (!this.active) return;
    // MUST set inactive BEFORE emitting event so countActive() is correct
    this.setActive(false).setVisible(false);
    this.body?.stop();
    this.hpBarBg.destroy();
    this.hpBarFg.destroy();
    if (awardGold) {
      this.scene.events.emit('enemy_died', this);
    }
    // Death animation (targets self which is now invisible)
    this.scene.tweens.add({
      targets: this,
      scaleX: 0, scaleY: 0, alpha: 0,
      duration: 180,
      onComplete: () => this.destroy(),
    });
  }

  destroy(fromScene?: boolean) {
    this.hpBarBg?.destroy();
    this.hpBarFg?.destroy();
    super.destroy(fromScene);
  }
}

interface PoisonStack { dps: number; expiry: number; }
