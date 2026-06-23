import Phaser from 'phaser';
import { TOWER_DEFS, TOWER_TYPES_ORDERED, type TowerType } from '../data/towers';
import { COLORS } from '../utils/constants';
import type { EconomyManager } from '../systems/EconomyManager';
import type { Tower } from '../entities/Tower';

// ─── Layout constants ─────────────────────────────────────────────────────
const BAR_H    = 100;

// Tower/Upgrade section (left side)
const TBW = 86, TBH = 80, TGAP = 6, TLEFT = 8;

const WAVE_H  = 60;

// Derived layout constants (independent of browser size)
const DIV1_X   = TLEFT + 6 * (TBW + TGAP) - TGAP; // right edge of tower section
const towerCX  = (i: number) => TLEFT + i * (TBW + TGAP) + TBW / 2;

// ─── BottomBar ─────────────────────────────────────────────────────────────
export class BottomBar {
  private scene:      Phaser.Scene;
  private economy:    EconomyManager;

  // Background
  private bg: Phaser.GameObjects.Graphics;

  // BUILD mode elements
  private buildBgs:     Phaser.GameObjects.Graphics[] = [];
  private buildIcons:   Phaser.GameObjects.Image[]    = [];
  private buildNames:   Phaser.GameObjects.Text[]     = [];
  private buildCosts:   Phaser.GameObjects.Text[]     = [];
  private buildHits:    Phaser.GameObjects.Rectangle[] = [];
  private hotkeyLabels: Phaser.GameObjects.Text[]     = [];

  // UPGRADE mode elements (hidden by default)
  private upgRoot:    Phaser.GameObjects.Container;
  private upgBtnList: UBtn[] = [];
  private currentUpgradeTower: Tower | null = null;

  // Wave button
  private waveBg:    Phaser.GameObjects.Graphics;
  private waveLabel: Phaser.GameObjects.Text;
  private waveHit:   Phaser.GameObjects.Rectangle;

  // Stored layout state for resize
  private _SW: number;
  private _SH: number;
  private _BAR_Y: number;
  private _TOWER_CY: number;
  private _WAVE_CX: number;
  private _WAVE_W: number;

  // ── Callbacks ─────────────────────────────────────────────────────────────
  onPlaceTower: ((type: TowerType) => void) | null = null;
  onUpgrade:    (() => void) | null = null;
  onEvolve:     ((branch: 0 | 1) => void) | null = null;
  onSell:       (() => void) | null = null;
  onSendWave:   (() => void) | null = null;

  constructor(scene: Phaser.Scene, economy: EconomyManager) {
    this.scene      = scene;
    this.economy    = economy;

    // ── Dynamic layout (depends on browser size) ────────────────────────────
    this._SW = scene.scale.width;
    this._SH = scene.scale.height;
    this._BAR_Y    = this._SH - BAR_H;
    this._TOWER_CY = this._BAR_Y + BAR_H / 2;
    this._WAVE_CX = (DIV1_X + this._SW) / 2;
    this._WAVE_W  = this._SW - DIV1_X - 16;

    const D = 40; // base depth

    // ── Background bar ──────────────────────────────────────────────────────
    this.bg = scene.add.graphics().setScrollFactor(0).setDepth(D);
    this.bg.fillStyle(COLORS.PANEL_BG, 0.97);
    this.bg.fillRect(0, this._BAR_Y, this._SW, BAR_H);
    this.bg.lineStyle(2, COLORS.PANEL_BORDER, 1);
    this.bg.lineBetween(0, this._BAR_Y, this._SW, this._BAR_Y);
    // Divider
    this.bg.lineStyle(1, COLORS.PANEL_BORDER, 0.6);
    this.bg.lineBetween(DIV1_X, this._BAR_Y + 6, DIV1_X, this._BAR_Y + BAR_H - 6);

    // ── Build section ──────────────────────────────────────────────────────
    TOWER_TYPES_ORDERED.forEach((type, i) => {
      const def = TOWER_DEFS[type];
      const cx  = towerCX(i);
      const cy  = this._TOWER_CY;

      const bg2 = scene.add.graphics().setScrollFactor(0).setDepth(D + 1);
      const canAfford = economy.canAfford(def.baseCost);
      this.drawTowerBtn(bg2, cx, cy, TBW, TBH, def.color, false, false, canAfford);
      this.buildBgs.push(bg2);

      const icon = scene.add.image(cx, cy - 12, `tower_${type}_0`)
        .setDisplaySize(28, 28).setScrollFactor(0).setDepth(D + 2);
      this.buildIcons.push(icon);

      const lbl = scene.add.text(cx, cy + 14, def.label.split(' ')[0], {
        fontSize: '10px', fontFamily: 'monospace', color: '#ccddee', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.buildNames.push(lbl);

      // Hotkey label
      const hkChars = ['Q','W','E','A','S','D'];
      const hkLbl = scene.add.text(cx, cy + 25, `[${hkChars[i]}]`, {
        fontSize: '9px', fontFamily: 'monospace', color: '#667788', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.hotkeyLabels.push(hkLbl);

      const cost = scene.add.text(cx, cy + 36, `${def.baseCost}g`, {
        fontSize: '11px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.buildCosts.push(cost);

      const hit = scene.add.rectangle(cx, cy, TBW - 4, TBH - 4, 0, 0)
        .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 3);
      hit.on('pointerover',  () => this.drawTowerBtn(bg2, cx, cy, TBW, TBH, def.color, true, false, this.economy.canAfford(def.baseCost)));
      hit.on('pointerout',   () => this.drawTowerBtn(bg2, cx, cy, TBW, TBH, def.color, false, false, this.economy.canAfford(def.baseCost)));
      hit.on('pointerup',    () => {
        if (!economy.canAfford(def.baseCost)) return;
        this.onPlaceTower?.(type);
        // Highlight selected
        this.buildBgs.forEach((b, j) => {
          const t = TOWER_TYPES_ORDERED[j];
          this.drawTowerBtn(b, towerCX(j), this._TOWER_CY, TBW, TBH, TOWER_DEFS[t].color, false, j === i, this.economy.canAfford(TOWER_DEFS[t].baseCost));
        });
      });
      this.buildHits.push(hit);
    });

    // ── Upgrade section (container, hidden by default) ─────────────────────
    this.upgRoot = scene.add.container(0, 0).setScrollFactor(0).setDepth(D + 1).setVisible(false);

    // ── Wave button ─────────────────────────────────────────────────────────
    this.waveBg  = scene.add.graphics().setScrollFactor(0).setDepth(D + 1);
    this.waveLabel = scene.add.text(this._WAVE_CX, this._TOWER_CY - 10, '▶▶ SEND NEXT WAVE\n[SPACE]', {
      fontSize: '12px', fontFamily: 'monospace', color: '#44ff88', align: 'center', lineSpacing: 2,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
    this.drawWaveBtn(false);

    this.waveHit = scene.add.rectangle(this._WAVE_CX, this._TOWER_CY, this._WAVE_W - 8, WAVE_H, 0, 0)
      .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 3);
    this.waveHit.on('pointerover', () => this.drawWaveBtn(true));
    this.waveHit.on('pointerout',  () => this.drawWaveBtn(false));
    this.waveHit.on('pointerup',   () => this.onSendWave?.());

    // Listen for gold changes to refresh affordability on build & upgrade buttons
    scene.events.on('gold_changed', () => {
      this.refreshBuildAffordability();
      if (this.upgRoot.visible && this.currentUpgradeTower) {
        this.showUpgradeMode(this.currentUpgradeTower);
      }
    });
  }

  /** Re-layout all elements for a new browser size. */
  resize(sw: number, sh: number) {
    // Update stored layout
    this._SW = sw;
    this._SH = sh;
    this._BAR_Y    = sh - BAR_H;
    this._TOWER_CY = this._BAR_Y + BAR_H / 2;
    this._WAVE_CX = (DIV1_X + sw) / 2;
    this._WAVE_W  = sw - DIV1_X - 16;

    // ── Redraw background bar ───────────────────────────────────────────────
    this.bg.clear();
    this.bg.fillStyle(COLORS.PANEL_BG, 0.97);
    this.bg.fillRect(0, this._BAR_Y, sw, BAR_H);
    this.bg.lineStyle(2, COLORS.PANEL_BORDER, 1);
    this.bg.lineBetween(0, this._BAR_Y, sw, this._BAR_Y);
    this.bg.lineStyle(1, COLORS.PANEL_BORDER, 0.6);
    this.bg.lineBetween(DIV1_X, this._BAR_Y + 6, DIV1_X, this._BAR_Y + BAR_H - 6);

    // ── Reposition tower buttons ────────────────────────────────────────────
    TOWER_TYPES_ORDERED.forEach((type, i) => {
      const def = TOWER_DEFS[type];
      const cx  = towerCX(i);
      const cy  = this._TOWER_CY;

      this.drawTowerBtn(this.buildBgs[i], cx, cy, TBW, TBH, def.color, false, false, this.economy.canAfford(def.baseCost));
      this.buildIcons[i].setPosition(cx, cy - 12);
      this.buildNames[i].setPosition(cx, cy + 14);
      this.hotkeyLabels[i].setPosition(cx, cy + 25);
      this.buildCosts[i].setPosition(cx, cy + 36);
      this.buildHits[i].setPosition(cx, cy);
    });

    // ── Reposition wave button ──────────────────────────────────────────────
    this.waveLabel.setPosition(this._WAVE_CX, this._TOWER_CY - 10);
    this.waveHit.setPosition(this._WAVE_CX, this._TOWER_CY);
    this.waveHit.setSize(this._WAVE_W - 8, WAVE_H);
    this.drawWaveBtn(false);

    // ── Rebuild upgrade section if visible ────────────────────────────────
    if (this.upgRoot.visible && this.currentUpgradeTower) {
      this.showUpgradeMode(this.currentUpgradeTower);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  getRoot(): Phaser.GameObjects.Graphics { return this.bg; }

  /** Returns ALL game objects this BottomBar creates, for camera ignore lists. */
  getAllObjects(): Phaser.GameObjects.GameObject[] {
    const objects: Phaser.GameObjects.GameObject[] = [
      this.bg,
      this.upgRoot,
      this.waveBg,
      this.waveLabel,
      ...this.buildBgs,
      ...this.buildIcons,
      ...this.buildNames,
      ...this.buildCosts,
      ...this.buildHits,
      ...this.hotkeyLabels,
      this.waveHit,
      ...this.upgBtnList.flatMap(b => [b.bg, b.txt, b.hit]),
    ];
    return objects;
  }

  showBuildMode() {
    this.currentUpgradeTower = null;
    this.setBuildVisible(true);
    this.upgRoot.setVisible(false);
    this.clearUpgHits();
    this.refreshBuildAffordability();
  }

  showUpgradeMode(tower: Tower) {
    this.currentUpgradeTower = tower;
    this.setBuildVisible(false);
    this.clearUpgHits();
    this.rebuildUpgradeSection(tower);
    this.upgRoot.setVisible(true);
  }

  refreshBuildAffordability() {
    TOWER_TYPES_ORDERED.forEach((type, i) => {
      const def = TOWER_DEFS[type];
      const can = this.economy.canAfford(def.baseCost);
      this.buildCosts[i].setColor(can ? '#ffd700' : '#885533');
      this.drawTowerBtn(this.buildBgs[i], towerCX(i), this._TOWER_CY, TBW, TBH, def.color, false, false, can);
    });
  }

  update() {
    // Refresh affordability periodically
    this.refreshBuildAffordability();
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  private setBuildVisible(vis: boolean) {
    [...this.buildBgs, ...this.buildIcons, ...this.buildNames, ...this.buildCosts, ...this.buildHits, ...this.hotkeyLabels]
      .forEach(o => o.setVisible(vis));
  }

  private rebuildUpgradeSection(tower: Tower) {
    // Clear previous
    this.upgRoot.removeAll(true);
    this.upgBtnList = [];

    const def  = tower.def;
    const CY   = this._TOWER_CY;

    // Tower icon
    const icon = this.scene.add.image(towerCX(0), CY - 14, `tower_${tower.towerType}_${Math.min(tower.level - 1, 3)}`)
      .setScale(0.8);
    this.upgRoot.add(icon);

    // Name + level
    const title = this.scene.add.text(towerCX(0), CY + 10, `${def.label}\nLv ${tower.level}${tower.evolved ? '★' : ''}`, {
      fontSize: '11px', fontFamily: 'monospace', color: '#eef0f4', align: 'center', lineSpacing: 1,
    }).setOrigin(0.5);
    this.upgRoot.add(title);

    // Stats
    const stats = this.scene.add.text(towerCX(0), CY + 35, `⚔${Math.round(tower.damage)}  🎯${Math.round(tower.range)}`, {
      fontSize: '10px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
    }).setOrigin(0.5);
    this.upgRoot.add(stats);

    // Synergy tags
    if (tower.activeSynergyTags.length) {
      const syn = this.scene.add.text(towerCX(0), CY + 48, `✦ ${tower.activeSynergyTags.slice(0, 2).join(', ')}`, {
        fontSize: '9px', fontFamily: 'monospace', color: '#ffeeaa', align: 'center',
      }).setOrigin(0.5);
      this.upgRoot.add(syn);
    }

    // Action buttons - placed at tower button positions 1-5
    const actions: Array<{ label: string; color: number; cb: () => void; enabled: boolean; hotkey?: string }> = [];

    if (tower.canUpgrade()) {
      const cost = tower.upgradeCost();
      const tier = tower.def.upgrades[tower.level - 1];
      actions.push({
        label: `⬆ Upgrade\n${tier.label}  ${cost}g`,
        hotkey: 'U',
        color: this.economy.canAfford(cost) ? 0x1e5a3a : 0x333333,
        enabled: this.economy.canAfford(cost),
        cb: () => { this.onUpgrade?.(); this.showUpgradeMode(tower); },
      });
    }

    if (tower.canEvolve()) {
      const evoKeys = ['U', 'I'];
      for (let b = 0; b < 2; b++) {
        const evo = def.evolutions[b];
        const can = this.economy.canAfford(evo.cost);
        actions.push({
          label: `★ ${evo.label}\n${evo.cost}g`,
          hotkey: evoKeys[b],
          color: can ? 0x3a2a00 : 0x333333,
          enabled: can,
          cb: () => { this.onEvolve?.(b as 0 | 1); this.showUpgradeMode(tower); },
        });
      }
    }

    const sellVal = tower.sellValue();
    actions.push({
      label: `Sell\n+${sellVal}g`,
      color: 0x4a1a1a,
      enabled: true,
      cb: () => this.onSell?.(),
    });

    // Draw action buttons at positions 1, 2, 3, 4 in the tower button row
    actions.forEach((act, i) => {
      const cx = towerCX(i + 1);

      const bg4 = this.scene.add.graphics();
      this.upgRoot.add(bg4);
      this.drawUBtn(bg4, cx, CY, TBW - 4, TBH - 4, act.color, false);

      const txt = this.scene.add.text(cx, CY, act.label, {
        fontSize: '10px', fontFamily: 'monospace', color: act.enabled ? '#eef0f4' : '#445566',
        align: 'center', lineSpacing: 2,
      }).setOrigin(0.5);
      this.upgRoot.add(txt);

      // Hotkey label (same style as build tower hotkeys)
      if (act.hotkey) {
        const hk = this.scene.add.text(cx, CY + 25, `[${act.hotkey}]`, {
          fontSize: '9px', fontFamily: 'monospace', color: '#667788', align: 'center',
        }).setOrigin(0.5);
        this.upgRoot.add(hk);
      }

      if (act.enabled) {
        // Hit rects MUST be outside the container and screen-fixed
        const hit = this.scene.add.rectangle(cx, CY, TBW - 8, TBH - 8, 0, 0)
          .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(50);
        hit.on('pointerover',  () => this.drawUBtn(bg4, cx, CY, TBW - 4, TBH - 4, act.color, true));
        hit.on('pointerout',   () => this.drawUBtn(bg4, cx, CY, TBW - 4, TBH - 4, act.color, false));
        hit.on('pointerup',    () => act.cb());
        this.upgBtnList.push({ bg: bg4, txt, hit });
      }
    });
  }

  // ── Drawing helpers ────────────────────────────────────────────────────────
  private drawTowerBtn(g: Phaser.GameObjects.Graphics, cx: number, cy: number,
    w: number, h: number, color: number, hover: boolean, active: boolean, affordable: boolean = true) {
    g.clear();
    const fill = !affordable ? 0x1a1a1a : active ? 0x2a4a2a : hover ? COLORS.BTN_HOVER : COLORS.BTN_NORMAL;
    g.fillStyle(fill, 1);
    g.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 5);
    g.lineStyle(active ? 3 : 1, active ? 0x44ff88 : affordable ? color : 0x333333, active ? 1 : 0.5);
    g.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, 5);
  }

  private drawUBtn(g: Phaser.GameObjects.Graphics, cx: number, cy: number,
    w: number, h: number, color: number, hover: boolean) {
    g.clear();
    g.fillStyle(hover ? Phaser.Display.Color.IntegerToColor(color).lighten(15).color : color, 1);
    g.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 4);
    g.lineStyle(1, 0x556677, 0.8);
    g.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, 4);
  }

  private drawWaveBtn(hover: boolean) {
    this.waveBg.clear();
    this.waveBg.fillStyle(hover ? 0x1a4a2a : 0x0f2a1a, 1);
    this.waveBg.fillRoundedRect(this._WAVE_CX - this._WAVE_W / 2, this._TOWER_CY - WAVE_H / 2, this._WAVE_W, WAVE_H, 8);
    this.waveBg.lineStyle(2, 0x44ff88, 0.7);
    this.waveBg.strokeRoundedRect(this._WAVE_CX - this._WAVE_W / 2, this._TOWER_CY - WAVE_H / 2, this._WAVE_W, WAVE_H, 8);
  }

  // Cleanup upgrade hit rects when switching modes
  private clearUpgHits() {
    for (const btn of this.upgBtnList) {
      btn.hit?.destroy();
    }
    this.upgBtnList = [];
  }

  destroy() {
    this.clearUpgHits();
  }
}

interface UBtn {
  bg:  Phaser.GameObjects.Graphics;
  txt: Phaser.GameObjects.Text;
  hit: Phaser.GameObjects.Rectangle;
}


