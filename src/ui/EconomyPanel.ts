import Phaser from 'phaser';
import type { EconomyBuildingType } from '../data/economy';
import { ECO_BUILDING_DEFS, ECO_BUILDING_TYPES, escalatedCost } from '../data/economy';
import { COLORS } from '../utils/constants';
import type { EconomyManager } from '../systems/EconomyManager';
import type { EconomySimulation } from '../systems/EconomySimulation';

const PANEL_W = 220;
const PANEL_H = 400;
/** Position to the right of the floating ability buttons (x=12, w=62). */
const PANEL_X = 84;
const PANEL_Y = 8;

export class EconomyPanel {
  private scene: Phaser.Scene;
  private economy: EconomyManager;
  private sim: EconomySimulation;
  private container: Phaser.GameObjects.Container;
  private visible: boolean = false;
  /** Hit rectangles kept as direct scene children (not inside the container)
   *  so their interactive areas track absolute screen coordinates correctly. */
  private hitRects: Phaser.GameObjects.Rectangle[] = [];
  callback: ((type: EconomyBuildingType) => void) | null = null;

  constructor(scene: Phaser.Scene, economy: EconomyManager, sim: EconomySimulation) {
    this.scene   = scene;
    this.economy = economy;
    this.sim     = sim;
    this.container = scene.add.container(PANEL_X, PANEL_Y).setDepth(40).setScrollFactor(0);
    this.build();
    this.hide();

    scene.events.on('gold_changed', () => {
      if (this.visible) this.build();
    });
  }

  private build() {
    this.container.removeAll(true);

    // Destroy old hit rectangles (direct scene children, not in container)
    for (const r of this.hitRects) r.destroy();
    this.hitRects = [];

    const bg = this.scene.add.graphics();
    bg.fillStyle(COLORS.PANEL_BG, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, COLORS.PANEL_BORDER, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    const title = this.scene.add.text(PANEL_W / 2, 10, 'BUILD ECONOMY', {
      fontSize: '13px', fontFamily: 'monospace', color: '#eef0f4', align: 'center',
    }).setOrigin(0.5, 0);
    this.container.add(title);

    ECO_BUILDING_TYPES.forEach((type, i) => {
      const def   = ECO_BUILDING_DEFS[type];
      const count = this.sim.countOfType(type);
      const cost  = escalatedCost(def, count);
      const row   = Math.floor(i / 2);
      const col   = i % 2;
      const bx    = 10 + col * 102;
      const by    = 32 + row * 88;
      const BTN_W = 96, BTN_H = 80;

      const btnBg  = this.scene.add.graphics();
      const icon   = this.scene.add.image(bx + BTN_W / 2, by + 24, def.textureKey).setDisplaySize(30, 30);
      const lbl    = this.scene.add.text(bx + BTN_W / 2, by + 50, def.label, {
        fontSize: '11px', fontFamily: 'monospace', color: '#eef0f4', align: 'center',
      }).setOrigin(0.5, 0);
      const costTxt = this.scene.add.text(bx + BTN_W / 2, by + 64, `${cost}g`, {
        fontSize: '10px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
      }).setOrigin(0.5, 0);

      const affordable = this.economy.canAfford(cost);
      const draw = (hover: boolean) => {
        btnBg.clear();
        const col = hover ? COLORS.BTN_HOVER : COLORS.BTN_NORMAL;
        btnBg.fillStyle(affordable ? col : 0x1a1a1a, 1);
        btnBg.fillRoundedRect(bx, by, BTN_W, BTN_H, 6);
        btnBg.lineStyle(1, affordable ? def.color : 0x333333, 0.7);
        btnBg.strokeRoundedRect(bx, by, BTN_W, BTN_H, 6);
      };

      draw(false);
      this.container.add([btnBg, icon, lbl, costTxt]);

      // Show count badge if player already owns some
      if (count > 0) {
        const badge = this.scene.add.text(bx + BTN_W - 6, by + 4, `${count}`, {
          fontSize: '9px', fontFamily: 'monospace', color: '#44ff88',
        }).setOrigin(1, 0);
        this.container.add(badge);
      }

      const hit = this.scene.add.rectangle(
        this.container.x + bx + BTN_W / 2,
        this.container.y + by + BTN_H / 2,
        BTN_W, BTN_H, 0, 0,
      ).setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(41);

      hit.on('pointerover', () => draw(true));
      hit.on('pointerout',  () => draw(false));
      hit.on('pointerup',   () => {
        if (!affordable) return;
        this.callback?.(type);
        this.hide();
      });
      // Keep hit rect as a direct scene child so its interactive area
      // uses absolute screen coordinates — avoids container-local
      // coordinate misalignment.
      this.hitRects.push(hit);
    });
  }

  show() {
    this.build();  // refresh costs/counts
    this.container.setVisible(true);
    this.visible = true;
  }

  hide() {
    this.container.setVisible(false);
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Expose the container so GameScene can ignore it on the main camera. */
  getContainer(): Phaser.GameObjects.Container {
    return this.container;
  }
}
