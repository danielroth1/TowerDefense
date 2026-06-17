import Phaser from 'phaser';
import { BARRICADE_HP, COLORS, TILE_SIZE } from '../utils/constants';

export class Barricade extends Phaser.GameObjects.Image {
  hp: number;
  maxHp: number;
  row: number;
  col: number;

  private hpBar: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, col: number, row: number) {
    super(scene, col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2, 'barricade');
    this.row = row;
    this.col = col;
    this.hp    = BARRICADE_HP;
    this.maxHp = BARRICADE_HP;
    scene.add.existing(this);
    this.setDepth(2);
    this.hpBar = scene.add.graphics().setDepth(5);
  }

  takeDamage(amount: number) {
    this.hp -= amount;
    if (this.hp <= 0) {
      this.scene.events.emit('barricade_destroyed', this);
      this.hpBar.destroy();
      this.destroy();
      return;
    }
    this.updateHPBar();
    // Crack tint
    const frac = this.hp / this.maxHp;
    const r = Math.round(0x8b + (0xff - 0x8b) * (1 - frac));
    this.setTint(Phaser.Display.Color.GetColor(r, 0x5e, 0x3c));
  }

  private updateHPBar() {
    const bw = TILE_SIZE - 8;
    const bh = 4;
    const bx = this.x - bw / 2;
    const by = this.y - TILE_SIZE / 2 - 6;
    const frac = Math.max(0, this.hp / this.maxHp);

    this.hpBar.clear();
    this.hpBar.fillStyle(0x000000, 0.7);
    this.hpBar.fillRect(bx, by, bw, bh);
    this.hpBar.fillStyle(COLORS.HP_MED, 1);
    this.hpBar.fillRect(bx, by, bw * frac, bh);
  }

  destroy(fromScene?: boolean) {
    this.hpBar?.destroy();
    super.destroy(fromScene);
  }
}
