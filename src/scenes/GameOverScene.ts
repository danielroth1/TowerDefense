import Phaser from 'phaser';
import { COLORS, GAME_WIDTH, GAME_HEIGHT } from '../utils/constants';

export class GameOverScene extends Phaser.Scene {
  constructor() { super('GameOverScene'); }

  init(data: { wave: number; kills: number; gold: number; won: boolean }) {
    this.registry.set('stats', data);
  }

  create() {
    const { wave, kills, gold, won } = this.registry.get('stats');
    const W = GAME_WIDTH;
    const H = GAME_HEIGHT;

    // Background
    const bg = this.add.graphics();
    bg.fillGradientStyle(COLORS.BG, COLORS.BG, 0x0d1a2d, 0x0d1a2d, 1);
    bg.fillRect(0, 0, W, H);

    // Result title
    const titleText = won ? 'VICTORY!' : 'GAME OVER';
    const titleColor = won ? '#ffd700' : '#ff4444';
    this.add.text(W / 2, H * 0.2, titleText, {
      fontSize: '64px', fontFamily: 'monospace',
      color: titleColor, stroke: '#000000', strokeThickness: 6,
    }).setOrigin(0.5);

    // Stats
    const lines = [
      `Waves Survived:  ${wave} / 50`,
      `Enemies Killed:  ${kills}`,
      `Gold Earned:     ${gold}`,
    ];
    lines.forEach((line, i) => {
      this.add.text(W / 2, H * 0.42 + i * 36, line, {
        fontSize: '24px', fontFamily: 'monospace', color: '#eef0f4',
      }).setOrigin(0.5);
    });

    // Play again
    const btn = this.add.text(W / 2, H * 0.72, '[ PLAY AGAIN ]', {
      fontSize: '28px', fontFamily: 'monospace', color: '#ffd700',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setColor('#ffffff'));
    btn.on('pointerout',  () => btn.setColor('#ffd700'));
    btn.on('pointerup',   () => this.scene.start('MenuScene'));

    // Menu
    const menuBtn = this.add.text(W / 2, H * 0.82, '[ MAIN MENU ]', {
      fontSize: '20px', fontFamily: 'monospace', color: '#8899aa',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    menuBtn.on('pointerover', () => menuBtn.setColor('#eef0f4'));
    menuBtn.on('pointerout',  () => menuBtn.setColor('#8899aa'));
    menuBtn.on('pointerup',   () => this.scene.start('MenuScene'));

    // Pulse title
    this.tweens.add({
      targets: this.children.list[1],
      scaleX: 1.05, scaleY: 1.05,
      duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }
}
