import Phaser from 'phaser';

/**
 * Compact hover tooltip panel (desktop only).
 * Renders a small panel near the cursor with a title + info lines,
 * clamped to the viewport and flipped when near the right/bottom edges.
 * Add it to a UI group so it renders on the UI camera only.
 */
export class Tooltip {
  private scene: Phaser.Scene;
  private bg: Phaser.GameObjects.Graphics;
  private title: Phaser.GameObjects.Text;
  private body: Phaser.GameObjects.Text;
  private _visible = false;

  constructor(scene: Phaser.Scene, depth = 80) {
    this.scene = scene;
    this.bg = scene.add.graphics().setScrollFactor(0).setDepth(depth).setVisible(false);
    this.title = scene.add.text(0, 0, '', {
      fontSize: '13px', fontFamily: 'monospace', color: '#ffd700',
    }).setScrollFactor(0).setDepth(depth + 1).setOrigin(0, 0).setVisible(false);
    this.body = scene.add.text(0, 0, '', {
      fontSize: '11px', fontFamily: 'monospace', color: '#ccddee', align: 'left',
      lineSpacing: 3, wordWrap: { width: 220 },
    }).setScrollFactor(0).setDepth(depth + 1).setOrigin(0, 0).setVisible(false);
  }

  /** Show the tooltip at (x, y) with a title and compact info lines. */
  show(x: number, y: number, title: string, lines: string[]) {
    this.title.setText(title);
    this.body.setText(lines.join('\n'));

    const pad = 8;
    const w = Math.max(this.title.width, this.body.width) + pad * 2;
    const h = pad + 20 + this.body.height + pad;
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;

    // Prefer placing to the right/below the cursor; flip near edges
    let px = x + 14;
    let py = y + 14;
    if (px + w > W - 4) px = x - w - 14;
    if (py + h > H - 4) py = H - h - 4;
    px = Math.max(4, Math.min(px, W - w - 4));
    py = Math.max(4, Math.min(py, H - h - 4));

    this.bg.clear();
    this.bg.fillStyle(0x0d1117, 0.96);
    this.bg.fillRoundedRect(px, py, w, h, 6);
    this.bg.lineStyle(1, 0x2a3a4a, 0.9);
    this.bg.strokeRoundedRect(px, py, w, h, 6);
    this.title.setPosition(px + pad, py + pad);
    this.body.setPosition(px + pad, py + pad + 20);

    this.bg.setVisible(true);
    this.title.setVisible(true);
    this.body.setVisible(true);
    this._visible = true;
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this.bg.setVisible(false);
    this.title.setVisible(false);
    this.body.setVisible(false);
  }

  get isVisible(): boolean { return this._visible; }

  /** Add all objects to a UI group so they render on the UI camera only. */
  register(group: Phaser.GameObjects.Group) {
    group.add(this.bg);
    group.add(this.title);
    group.add(this.body);
  }
}
