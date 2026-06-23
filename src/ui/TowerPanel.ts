import Phaser from 'phaser';
import { TOWER_DEFS, TOWER_TYPES_ORDERED, type TowerType } from '../data/towers';
import { COLORS } from '../utils/constants';
import type { EconomyManager } from '../systems/EconomyManager';

const PANEL_W = 220;
const PANEL_H = 320;

export class TowerPanel {
  private scene: Phaser.Scene;
  private economy: EconomyManager;
  private container: Phaser.GameObjects.Container;
  private visible: boolean = false;
  callback: ((type: TowerType) => void) | null = null;

  constructor(scene: Phaser.Scene, economy: EconomyManager) {
    this.scene   = scene;
    this.economy = economy;
    this.container = scene.add.container(8, 46).setDepth(40).setScrollFactor(0);
    this.build();
    this.hide();

    scene.events.on('gold_changed', () => {
      if (this.visible) this.build();
    });
  }

  private build() {
    this.container.removeAll(true);

    const bg = this.scene.add.graphics();
    bg.fillStyle(COLORS.PANEL_BG, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, COLORS.PANEL_BORDER, 1);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    this.scene.add.text(0, 0, '').setScrollFactor(0); // dummy

    const title = this.scene.add.text(PANEL_W / 2, 12, 'BUILD TOWER', {
      fontSize: '14px', fontFamily: 'monospace', color: '#eef0f4', align: 'center',
    }).setOrigin(0.5, 0);
    this.container.add(title);

    TOWER_TYPES_ORDERED.forEach((type, i) => {
      const def   = TOWER_DEFS[type];
      const row   = Math.floor(i / 2);
      const col   = i % 2;
      const bx    = 10 + col * 102;
      const by    = 36 + row * 88;
      const BTN_W = 96, BTN_H = 80;

      const btnBg  = this.scene.add.graphics();
      const icon   = this.scene.add.image(bx + BTN_W / 2, by + 28, `tower_${type}_0`).setDisplaySize(30, 30);
      const lbl    = this.scene.add.text(bx + BTN_W / 2, by + 54, def.label.split(' ')[0], {
        fontSize: '11px', fontFamily: 'monospace', color: '#eef0f4', align: 'center',
      }).setOrigin(0.5, 0);
      const costTxt = this.scene.add.text(bx + BTN_W / 2, by + 66, `${def.baseCost}g`, {
        fontSize: '11px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
      }).setOrigin(0.5, 0);

      const draw = (hover: boolean, affordable: boolean) => {
        btnBg.clear();
        const col = hover ? COLORS.BTN_HOVER : COLORS.BTN_NORMAL;
        btnBg.fillStyle(affordable ? col : 0x1a1a1a, 1);
        btnBg.fillRoundedRect(bx, by, BTN_W, BTN_H, 6);
        btnBg.lineStyle(1, affordable ? def.color : 0x333333, 0.7);
        btnBg.strokeRoundedRect(bx, by, BTN_W, BTN_H, 6);
      };

      draw(false, this.economy.canAfford(def.baseCost));
      this.container.add([btnBg, icon, lbl, costTxt]);

      const hit = this.scene.add.rectangle(
        this.container.x + bx + BTN_W / 2,
        this.container.y + by + BTN_H / 2,
        BTN_W, BTN_H, 0, 0,
      ).setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(41);

      hit.on('pointerover',  () => draw(true,  this.economy.canAfford(def.baseCost)));
      hit.on('pointerout',   () => draw(false, this.economy.canAfford(def.baseCost)));
      hit.on('pointerup',    () => {
        if (!this.economy.canAfford(def.baseCost)) return;
        this.callback?.(type);
        this.hide();
      });
      this.container.add(hit as unknown as Phaser.GameObjects.GameObject);
    });
  }

  show() {
    this.build();  // rebuild to refresh affordability
    this.container.setVisible(true);
    this.visible = true;
  }

  hide() {
    this.container.setVisible(false);
    this.visible = false;
  }

  toggle() { this.visible ? this.hide() : this.show(); }
  isVisible() { return this.visible; }
}
