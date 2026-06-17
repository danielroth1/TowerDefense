import Phaser from 'phaser';
import { COLORS, HERO_RESPAWN_TIME } from '../utils/constants';

export class Hero extends Phaser.Physics.Arcade.Sprite {
  hp: number = 150;
  maxHp: number = 150;
  level: number = 1;
  xp: number = 0;
  xpToNext: number = 100;
  attackRange: number = 90;
  attackDamage: number = 25;
  attackTimer: number = 0;
  attackRate: number = 1000;
  isDowned: boolean = false;
  respawnTimer: number = 0;
  isSelected: boolean = false;

  private hpBarBg: Phaser.GameObjects.Graphics;
  private hpBarFg: Phaser.GameObjects.Graphics;
  private targetMarker: Phaser.GameObjects.Graphics;
  private selectionRing: Phaser.GameObjects.Graphics;
  private attackFlash: Phaser.GameObjects.Graphics;

  // Destination tracking for stopping
  private destX: number = -1;
  private destY: number = -1;
  private moving: boolean = false;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'hero_sheet', 0);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setCircle(14, 6, 6);
    this.setDepth(4);
    this.setMaxVelocity(180);
    // No drag - we manage velocity manually in preUpdate
    this.play('hero_idle');

    this.hpBarBg     = scene.add.graphics().setDepth(7);
    this.hpBarFg     = scene.add.graphics().setDepth(8);
    this.targetMarker= scene.add.graphics().setDepth(1);
    this.selectionRing = scene.add.graphics().setDepth(3);
    this.attackFlash   = scene.add.graphics().setDepth(9);
  }

  setSelected(val: boolean) {
    this.isSelected = val;
    if (!val) this.selectionRing.clear();
  }

  moveTo(wx: number, wy: number) {
    if (this.isDowned) return;
    this.destX = wx;
    this.destY = wy;
    this.moving = true;

    this.targetMarker.clear();
    this.targetMarker.lineStyle(2, 0xffdd44, 0.9);
    this.targetMarker.strokeCircle(wx, wy, 10);
    this.targetMarker.lineStyle(1, 0xffdd44, 0.5);
    this.targetMarker.strokeCircle(wx, wy, 16);
    this.scene.tweens.add({
      targets: { t: 0 }, t: 1, duration: 500,
      onComplete: () => this.targetMarker.clear(),
    });

    const angle = Phaser.Math.Angle.Between(this.x, this.y, wx, wy);
    const speed = 170;
    this.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    this.play('hero_walk', true);
  }

  takeDamage(amount: number) {
    this.hp -= amount;
    this.scene.tweens.add({ targets: this, alpha: 0.3, duration: 80, yoyo: true });
    if (this.hp <= 0) this.down();
  }

  gainXP(amount: number) {
    this.xp += amount;
    if (this.xp >= this.xpToNext) this.levelUp();
  }

  private levelUp() {
    this.xp -= this.xpToNext;
    this.level++;
    this.xpToNext = Math.round(this.xpToNext * 1.6);
    this.maxHp    = Math.round(this.maxHp * 1.2);
    this.hp       = this.maxHp;
    this.attackDamage = Math.round(this.attackDamage * 1.15);
    this.attackRange  = Math.min(150, this.attackRange + 5);
    this.scene.events.emit('hero_levelup', this.level);
    this.scene.tweens.add({ targets: this, scaleX: 1.5, scaleY: 1.5, duration: 250, yoyo: true });
  }

  private down() {
    this.isDowned = true;
    this.respawnTimer = HERO_RESPAWN_TIME;
    this.setAlpha(0.35);
    this.setVelocity(0, 0);
    this.moving = false;
    this.setSelected(false);
    this.scene.events.emit('hero_downed');
  }

  preUpdate(time: number, delta: number) {
    super.preUpdate(time, delta);

    if (this.isDowned) {
      this.respawnTimer -= delta;
      if (this.respawnTimer <= 0) {
        this.isDowned = false;
        this.hp = Math.round(this.maxHp * 0.5);
        this.setAlpha(1);
        this.setPosition(this.x, this.y);
        this.scene.events.emit('hero_respawned');
      }
      this.updateHPBar();
      return;
    }

    // Continuously push toward destination (no drag needed)
    if (this.moving && this.destX >= 0) {
      const d = Phaser.Math.Distance.Between(this.x, this.y, this.destX, this.destY);
      if (d < 10) {
        this.setVelocity(0, 0);
        this.moving = false;
        this.destX = -1;
        this.targetMarker.clear();
        this.play('hero_idle', true);
      } else {
        // Re-apply velocity each frame so drag/collisions don't stop the hero
        const angle = Phaser.Math.Angle.Between(this.x, this.y, this.destX, this.destY);
        this.setVelocity(Math.cos(angle) * 170, Math.sin(angle) * 170);
      }
    } else if (!this.moving) {
      this.setVelocity(0, 0);
      if (this.anims.currentAnim?.key === 'hero_walk') this.play('hero_idle', true);
    }

    // Auto-attack nearest enemy
    this.attackTimer += delta;
    if (this.attackTimer >= this.attackRate) {
      this.scene.events.emit('hero_find_target', this.x, this.y, this.attackRange);
    }

    // Update selection ring (world-space, follows hero)
    this.selectionRing.clear();
    if (this.isSelected) {
      const pulse = 0.7 + 0.3 * Math.sin(time * 0.004);
      this.selectionRing.lineStyle(3, 0xffdd44, pulse);
      this.selectionRing.strokeCircle(this.x, this.y, 22);
    }

    // Decay attack flash
    this.attackFlash.clear();

    this.updateHPBar();
  }

  playAttack() {
    this.attackTimer = 0;
    this.play('hero_attack', true);
    this.once('animationcomplete-hero_attack', () => {
      if (!this.moving) this.play('hero_idle', true);
      else this.play('hero_walk', true);
    });
  }

  private updateHPBar() {
    const bw = 34;
    const bh = 5;
    const bx = this.x - bw / 2;
    const by = this.y - 28;
    const frac = Math.max(0, this.hp / this.maxHp);
    const col = frac > 0.6 ? COLORS.HP_HIGH : frac > 0.3 ? COLORS.HP_MED : COLORS.HP_LOW;

    this.hpBarBg.clear();
    this.hpBarBg.fillStyle(0x000000, 0.75);
    this.hpBarBg.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    this.hpBarBg.fillStyle(0x222222, 1);
    this.hpBarBg.fillRect(bx, by, bw, bh);

    this.hpBarFg.clear();
    this.hpBarFg.fillStyle(col, 1);
    this.hpBarFg.fillRect(bx, by, bw * frac, bh);
  }

  destroy(fromScene?: boolean) {
    this.hpBarBg?.destroy();
    this.hpBarFg?.destroy();
    this.targetMarker?.destroy();
    this.selectionRing?.destroy();
    this.attackFlash?.destroy();
    super.destroy(fromScene);
  }
}

