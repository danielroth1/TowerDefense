import Phaser from 'phaser';
import { COLORS } from '../utils/constants';
import { hashSeed } from '../utils/helpers';

export class MenuScene extends Phaser.Scene {
  private seedInput: HTMLInputElement | null = null;
  private debugInput: HTMLInputElement | null = null;

  constructor() { super('MenuScene'); }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;

    // Dark gradient background
    const bg = this.add.graphics();
    bg.fillGradientStyle(COLORS.BG, COLORS.BG, 0x0d1a2d, 0x0d1a2d, 1);
    bg.fillRect(0, 0, W, H);

    // Animated grid lines
    for (let x = 0; x < W; x += 48) {
      bg.lineStyle(1, 0x1a2a3a, 0.4);
      bg.lineBetween(x, 0, x, H);
    }
    for (let y = 0; y < H; y += 48) {
      bg.lineStyle(1, 0x1a2a3a, 0.4);
      bg.lineBetween(0, y, W, y);
    }

    // Title
    this.add.text(W / 2, H * 0.18, 'VECTOR', {
      fontSize: '72px',
      fontFamily: 'monospace',
      color: '#eef0f4',
      stroke: '#4488bb',
      strokeThickness: 6,
    }).setOrigin(0.5);

    this.add.text(W / 2, H * 0.30, 'TOWER DEFENSE', {
      fontSize: '36px',
      fontFamily: 'monospace',
      color: '#ffd700',
      stroke: '#aa8800',
      strokeThickness: 3,
    }).setOrigin(0.5);

    // Seed label + HTML input – positioned close together
    this.add.text(W / 2 - 160, H * 0.48, 'SEED:', {
      fontSize: '18px', fontFamily: 'monospace', color: '#8899aa',
    }).setOrigin(0, 0.5);

    this.seedInput = document.createElement('input');
    this.seedInput.type = 'text';
    this.seedInput.placeholder = 'random';
    this.seedInput.maxLength = 20;
    Object.assign(this.seedInput.style, {
      position: 'absolute',
      left: `${W / 2 - 100}px`,
      top: `${H * 0.48 - 14}px`,
      width: '180px',
      height: '28px',
      background: '#0d1117',
      border: '1px solid #2a3a4a',
      color: '#eef0f4',
      fontFamily: 'monospace',
      fontSize: '16px',
      padding: '2px 8px',
      outline: 'none',
      borderRadius: '4px',
    });
    document.body.appendChild(this.seedInput);

    // Debug mode checkbox
    this.add.text(W / 2 - 160, H * 0.53, 'DEBUG ($10k):', {
      fontSize: '18px', fontFamily: 'monospace', color: '#8899aa',
    }).setOrigin(0, 0.5);

    this.debugInput = document.createElement('input');
    this.debugInput.type = 'checkbox';
    Object.assign(this.debugInput.style, {
      position: 'absolute',
      left: `${W / 2 - 20}px`,
      top: `${H * 0.53 - 10}px`,
      width: '20px',
      height: '20px',
      accentColor: '#ffd700',
      cursor: 'pointer',
    });
    document.body.appendChild(this.debugInput);

    // Play button
    const playBtn = this.makeButton(W / 2, H * 0.60, 200, 50, 'PLAY', 0x1e3a5f, 0x2a5080);
    playBtn.on('pointerup', () => this.startGame());

    // How to play button
    const helpBtn = this.makeButton(W / 2, H * 0.72, 200, 50, 'HOW TO PLAY', 0x1a2a1a, 0x2a4a2a);
    helpBtn.on('pointerup', () => this.showHelp());

    // Version
    this.add.text(W - 10, H - 10, 'v1.0', {
      fontSize: '12px', fontFamily: 'monospace', color: '#334455',
    }).setOrigin(1, 1);

    // Decorative corner towers
    this.drawCornerDecor();

    // Pulse title animation
    const title = this.children.list.find(
      c => c instanceof Phaser.GameObjects.Text && (c as Phaser.GameObjects.Text).text === 'VECTOR'
    ) as Phaser.GameObjects.Text | undefined;
    if (title) {
      this.tweens.add({
        targets: title,
        scaleX: 1.04, scaleY: 1.04,
        duration: 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  private makeButton(x: number, y: number, w: number, h: number, label: string, colorNorm: number, colorHover: number) {
    const container = this.add.container(x, y);
    const bg = this.add.graphics();
    const text = this.add.text(0, 0, label, {
      fontSize: '20px', fontFamily: 'monospace', color: '#eef0f4',
    }).setOrigin(0.5);

    const draw = (color: number) => {
      bg.clear();
      bg.fillStyle(color, 1);
      bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8);
      bg.lineStyle(2, 0x4488bb, 0.7);
      bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 8);
    };
    draw(colorNorm);
    container.add([bg, text]);

    const hitArea = this.add.rectangle(x, y, w, h, 0, 0)
      .setInteractive({ useHandCursor: true });

    hitArea.on('pointerover',  () => draw(colorHover));
    hitArea.on('pointerout',   () => draw(colorNorm));
    hitArea.on('pointerdown',  () => { bg.clear(); bg.fillStyle(COLORS.BTN_PRESS, 1); bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8); });
    hitArea.on('pointerup',    () => draw(colorHover));
    return hitArea;
  }

  private startGame() {
    const raw = this.seedInput?.value.trim() || String(Math.floor(Math.random() * 999999));
    const seed = hashSeed(raw || String(Date.now()));
    const debug = this.debugInput?.checked ?? false;
    this.cleanupInput();
    this.scene.start('GameScene', { seed, seedStr: raw, debug });
  }

  private showHelp() {
    const W = this.scale.width;
    const H = this.scale.height;

    // Overlay
    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0.75);
    overlay.fillRect(0, 0, W, H);

    const lines = [
      'HOW TO PLAY',
      '',
      '• Click a buildable tile (green) to place a tower.',
      '• Click a placed tower to upgrade or evolve it.',
      '• Towers with adjacent synergies get bonuses (see glow).',
      '• Survive all 50 waves to win. Every 5th wave = BOSS.',
      '',
      'ABILITIES (click ability bar or press 1-4):',
      '  1  Blizzard – freeze enemies in area',
      '  2  Meteor Strike – massive AoE damage',
      '  3  Lightning Storm – chain damage',
      '  4  Temporal Rift – slow time in area',
      '',
      'HERO: Click anywhere on non-path terrain to move.',
      'BARRICADE: Buy from sidebar to slow enemy paths.',
      '',
      'Weather changes every ~75s – watch the HUD!',
      'Kill combos give gold multipliers (up to ×10).',
      '',
      '               Click to close',
    ];

    const helpText = this.add.text(W / 2, H / 2, lines, {
      fontSize: '15px',
      fontFamily: 'monospace',
      color: '#eef0f4',
      lineSpacing: 6,
      align: 'left',
    }).setOrigin(0.5);

    overlay.setInteractive(new Phaser.Geom.Rectangle(0, 0, W, H), Phaser.Geom.Rectangle.Contains);
    overlay.once('pointerup', () => {
      overlay.destroy();
      helpText.destroy();
    });
  }

  private drawCornerDecor() {
    const W = this.scale.width;
    const H = this.scale.height;
    const g = this.add.graphics();
    const towerColor = COLORS.TOWER_CANNON;
    const baseColor  = COLORS.TOWER_BASE;
    const corners = [[40, 40], [W - 40, 40], [40, H - 40], [W - 40, H - 40]] as const;
    for (const [cx, cy] of corners) {
      g.fillStyle(baseColor, 1);
      g.fillCircle(cx, cy, 20);
      g.fillStyle(towerColor, 1);
      g.fillCircle(cx, cy, 14);
      g.lineStyle(2, 0xffffff, 0.3);
      g.strokeCircle(cx, cy, 14);
    }
  }

  private cleanupInput() {
    if (this.seedInput) {
      document.body.removeChild(this.seedInput);
      this.seedInput = null;
    }
    if (this.debugInput) {
      document.body.removeChild(this.debugInput);
      this.debugInput = null;
    }
  }

  shutdown() {
    this.cleanupInput();
  }
}
