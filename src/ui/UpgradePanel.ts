import Phaser from 'phaser';
import { COLORS, GAME_WIDTH } from '../utils/constants';
import type { Tower } from '../entities/Tower';
import type { EconomyManager } from '../systems/EconomyManager';

const PANEL_W = 210;
const PANEL_H = 240;

export class UpgradePanel {
  private scene: Phaser.Scene;
  private economy: EconomyManager;
  private container: Phaser.GameObjects.Container;
  private tower: Tower | null = null;

  onSell: (() => void) | null = null;
  onUpgrade: (() => void) | null = null;
  onEvolve: ((branch: 0 | 1) => void) | null = null;

  constructor(scene: Phaser.Scene, economy: EconomyManager) {
    this.scene   = scene;
    this.economy = economy;
    this.container = scene.add.container(GAME_WIDTH - PANEL_W - 8, 46).setDepth(40).setScrollFactor(0);
    this.container.setVisible(false);
  }

  show(tower: Tower) {
    this.tower = tower;
    this.rebuild();
    this.container.setVisible(true);
  }

  hide() {
    this.container.setVisible(false);
    this.tower = null;
  }

  isVisible() { return this.container.visible; }

  private rebuild() {
    this.container.removeAll(true);
    const t = this.tower!;
    const def = t.def;

    const bg = this.scene.add.graphics();
    bg.fillStyle(COLORS.PANEL_BG, 0.95);
    bg.fillRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    bg.lineStyle(1, def.color, 0.6);
    bg.strokeRoundedRect(0, 0, PANEL_W, PANEL_H, 8);
    this.container.add(bg);

    // Title
    const title = this.scene.add.text(PANEL_W / 2, 10, `${def.label} Lv${t.level}`, {
      fontSize: '13px', fontFamily: 'monospace', color: '#eef0f4', align: 'center',
    }).setOrigin(0.5, 0);
    this.container.add(title);

    // Stats
    const stats = [
      `DMG:  ${Math.round(t.damage)}`,
      `RNG:  ${Math.round(t.range)}`,
      `RoF:  ${(1000 / t.fireRate).toFixed(1)}/s`,
    ];
    stats.forEach((s, i) => {
      this.container.add(this.scene.add.text(10, 32 + i * 16, s, {
        fontSize: '12px', fontFamily: 'monospace', color: '#aabbcc',
      }));
    });

    // Synergies
    if (t.activeSynergyTags.length > 0) {
      this.container.add(this.scene.add.text(10, 82, `✦ ${t.activeSynergyTags.join(', ')}`, {
        fontSize: '11px', fontFamily: 'monospace', color: '#ffeeaa',
      }));
    }

    let yOffset = 96;

    // Upgrade button
    if (t.canUpgrade()) {
      const cost = t.upgradeCost();
      const affordable = this.economy.canAfford(cost);
      this.addButton(PANEL_W / 2, yOffset, PANEL_W - 20, 30,
        `Upgrade  ${cost}g`, affordable ? def.color : 0x444444, affordable,
        () => { this.onUpgrade?.(); this.rebuild(); });
      yOffset += 38;
    }

    // Evolve buttons
    if (t.canEvolve()) {
      for (let b = 0; b < 2; b++) {
        const evo  = def.evolutions[b];
        const affordable = this.economy.canAfford(evo.cost);
        this.addButton(PANEL_W / 2, yOffset, PANEL_W - 20, 28,
          `${evo.label}  ${evo.cost}g`, affordable ? evo.color : 0x444444, affordable,
          () => { this.onEvolve?.(b as 0 | 1); this.rebuild(); });
        yOffset += 34;
        // Tooltip description
        this.container.add(this.scene.add.text(PANEL_W / 2, yOffset - 10, evo.description, {
          fontSize: '9px', fontFamily: 'monospace', color: '#8899aa',
          align: 'center', wordWrap: { width: PANEL_W - 20 },
        }).setOrigin(0.5, 0));
        yOffset += 12;
      }
    }

    // Sell button
    const sellVal = t.sellValue();
    this.addButton(PANEL_W / 2, PANEL_H - 32, PANEL_W - 20, 26,
      `Sell  +${sellVal}g`, 0x553333, true,
      () => this.onSell?.());
  }

  private addButton(cx: number, cy: number, w: number, h: number, label: string, color: number, enabled: boolean, cb: () => void) {
    const bg = this.scene.add.graphics();
    bg.fillStyle(enabled ? color : 0x1a1a1a, 0.7);
    bg.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 5);
    bg.lineStyle(1, enabled ? color : 0x333333, 1);
    bg.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, 5);
    const txt = this.scene.add.text(cx, cy, label, {
      fontSize: '12px', fontFamily: 'monospace',
      color: enabled ? '#eef0f4' : '#445566', align: 'center',
    }).setOrigin(0.5);
    this.container.add([bg, txt]);

    if (!enabled) return;
    const hit = this.scene.add.rectangle(
      this.container.x + cx, this.container.y + cy, w, h, 0, 0,
    ).setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(41);
    hit.on('pointerup', cb);
    hit.on('pointerover', () => { bg.clear(); bg.fillStyle(Phaser.Display.Color.IntegerToColor(color).lighten(20).color, 0.9); bg.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 5); });
    hit.on('pointerout',  () => { bg.clear(); bg.fillStyle(color, 0.7); bg.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 5); });
    this.container.add(hit as unknown as Phaser.GameObjects.GameObject);
  }
}
