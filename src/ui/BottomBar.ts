import Phaser from 'phaser';
import { TOWER_DEFS, TOWER_TYPES_ORDERED, type TowerType } from '../data/towers';
import { COLORS } from '../utils/constants';
import type { EconomyManager } from '../systems/EconomyManager';
import type { Tower } from '../entities/Tower';

// ─── Layout constants ─────────────────────────────────────────────────────
const BAR_H    = 120;

// Tower/Upgrade section (left side)
const TBW = 86, TBH = 88, TGAP = 6, TLEFT = 8;

const WAVE_H  = 64;

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
    this.setBuildInputEnabled(true);
    this.upgRoot.setVisible(false);
    this.clearUpgHits();
    this.refreshBuildAffordability();
  }

  showUpgradeMode(tower: Tower) {
    this.currentUpgradeTower = tower;
    this.setBuildVisible(false);
    this.setBuildInputEnabled(false);
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

  /** Disable/enable input on build hit rects so they don't steal clicks in upgrade mode. */
  private setBuildInputEnabled(enabled: boolean) {
    this.buildHits.forEach(h => h.input!.enabled = enabled);
  }

  private rebuildUpgradeSection(tower: Tower) {
    // Clear previous
    this.upgRoot.removeAll(true);
    this.upgBtnList = [];

    const def  = tower.def;
    const CY   = this._TOWER_CY;
    const cx0  = towerCX(0);

    // ═══════════════════════════════════════════════════════════════════════
    // Position 0 — Info panel: current tower state (not clickable)
    // ═══════════════════════════════════════════════════════════════════════
    const infoBg = this.scene.add.graphics();
    const curImgKey = tower.evolved && tower.evolutionType
      ? `tower_${tower.evolutionType}`
      : `tower_${tower.towerType}_${Math.min(tower.level - 1, 2)}`;
    this.drawTowerBtn(infoBg, cx0, CY, TBW, TBH, def.color, false, false, true);
    this.upgRoot.add(infoBg);

    // Current tower image
    const icon = this.scene.add.image(cx0, CY - 16, curImgKey).setDisplaySize(36, 36);
    this.upgRoot.add(icon);

    // Name + level
    const name = def.label.split(' ')[0];
    const title = this.scene.add.text(cx0, CY + 16, `${name}\nLv${tower.level}${tower.evolved ? '★' : ''}`, {
      fontSize: '10px', fontFamily: 'monospace', color: '#eef0f4', align: 'center', lineSpacing: 1,
    }).setOrigin(0.5);
    this.upgRoot.add(title);

    // Current stats
    const curStats = this.scene.add.text(cx0, CY + 34, `⚔${Math.round(tower.damage)} 🎯${Math.round(tower.range)}`, {
      fontSize: '9px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
    }).setOrigin(0.5);
    this.upgRoot.add(curStats);

    if (tower.activeSynergyTags.length) {
      const syn = this.scene.add.text(cx0, CY + 44, `✦${tower.activeSynergyTags.slice(0, 2).join(',')}`, {
        fontSize: '8px', fontFamily: 'monospace', color: '#ffeeaa', align: 'center',
      }).setOrigin(0.5);
      this.upgRoot.add(syn);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Positions 1+ — Action buttons with upgrade preview
    // ═══════════════════════════════════════════════════════════════════════
    interface UpgAction {
      label: string; color: number; cb: () => void; enabled: boolean;
      hotkey?: string; cost: number;
      previewImgKey?: string;       // texture key for preview image
      previewStats?: string;        // e.g. "⚔20 🎯200"
      statsDiff?: string;           // e.g. "⚔12→20"
    }

    const actions: UpgAction[] = [];

    // --- Upgrade button ---
    if (tower.canUpgrade()) {
      const cost = tower.upgradeCost();
      const tier = tower.def.upgrades[tower.level - 1];
      const nextLevel = tower.level + 1;
      const nextImgKey = `tower_${tower.towerType}_${Math.min(nextLevel - 1, 2)}`;
      // Build stat diff string
      const diffParts: string[] = [];
      if (tier.damage !== tower.damage) diffParts.push(`⚔${Math.round(tower.damage)}→${tier.damage}`);
      if (tier.range  !== tower.range)  diffParts.push(`🎯${Math.round(tower.range)}→${tier.range}`);
      actions.push({
        label: `⬆ ${tier.label}`,
        hotkey: 'U', cost,
        color: this.economy.canAfford(cost) ? 0x1e5a3a : 0x333333,
        enabled: this.economy.canAfford(cost),
        previewImgKey: nextImgKey,
        previewStats: `⚔${tier.damage} 🎯${tier.range}`,
        statsDiff: diffParts.join(' '),
        cb: () => { this.onUpgrade?.(); this.showUpgradeMode(tower); },
      });
    }

    // --- Evolve buttons ---
    if (tower.canEvolve()) {
      const evoKeys = ['U', 'I'];
      for (let b = 0; b < 2; b++) {
        const evo = def.evolutions[b];
        const can = this.economy.canAfford(evo.cost);
        const evoImgKey = `tower_${evo.type}`;
        // Compute stat preview
        const evoDmg  = evo.stats.damage  ?? tower.damage;
        const evoRng  = evo.stats.range   ?? tower.range;
        const diffParts: string[] = [];
        if (evo.stats.damage) diffParts.push(`⚔${Math.round(tower.damage)}→${evoDmg}`);
        if (evo.stats.range)  diffParts.push(`🎯${Math.round(tower.range)}→${evoRng}`);
        actions.push({
          label: `★ ${evo.label}`,
          hotkey: evoKeys[b], cost: evo.cost,
          color: can ? 0x3a2a00 : 0x333333,
          enabled: can,
          previewImgKey: evoImgKey,
          previewStats: `⚔${evoDmg} 🎯${evoRng}`,
          statsDiff: diffParts.join(' '),
          cb: () => { this.onEvolve?.(b as 0 | 1); this.showUpgradeMode(tower); },
        });
      }
    }

    // --- Sell button ---
    const sellVal = tower.sellValue();
    actions.push({
      label: '💰 Sell', cost: sellVal,
      color: 0x4a1a1a,
      enabled: true,
      previewStats: `+${sellVal}g`,
      cb: () => this.onSell?.(),
    });

    // Render action buttons
    actions.forEach((act, i) => {
      const cx = towerCX(i + 1);
      const can = act.enabled;
      const w = TBW, h = TBH;

      // Background
      const bg4 = this.scene.add.graphics();
      this.upgRoot.add(bg4);
      this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, false, can);

      // Preview image
      if (act.previewImgKey) {
        const pvImg = this.scene.add.image(cx, CY - 18, act.previewImgKey)
          .setDisplaySize(26, 26).setAlpha(can ? 1 : 0.4);
        this.upgRoot.add(pvImg);
      }

      // Label
      const txt = this.scene.add.text(cx, CY + 6, act.label, {
        fontSize: '10px', fontFamily: 'monospace', color: can ? '#eef0f4' : '#445566',
        align: 'center',
      }).setOrigin(0.5);
      this.upgRoot.add(txt);

      // Stats preview or diff
      if (act.statsDiff) {
        const diff = this.scene.add.text(cx, CY + 18, act.statsDiff, {
          fontSize: '8px', fontFamily: 'monospace', color: can ? '#88cc88' : '#334433',
          align: 'center',
        }).setOrigin(0.5);
        this.upgRoot.add(diff);
      } else if (act.previewStats) {
        const pvs = this.scene.add.text(cx, CY + 18, act.previewStats, {
          fontSize: '8px', fontFamily: 'monospace', color: can ? '#8899aa' : '#334455',
          align: 'center',
        }).setOrigin(0.5);
        this.upgRoot.add(pvs);
      }

      // Cost + hotkey line
      const costStr = act.label.startsWith('💰') ? '' : `${act.cost}g`;
      const hkStr = act.hotkey ? `[${act.hotkey}]` : '';
      const bottomLine = [costStr, hkStr].filter(Boolean).join(' ');
      if (bottomLine) {
        const bl = this.scene.add.text(cx, CY + 30, bottomLine, {
          fontSize: '9px', fontFamily: 'monospace',
          color: can ? '#ffd700' : '#554433',
          align: 'center',
        }).setOrigin(0.5);
        this.upgRoot.add(bl);
      }

      // Hit rect for enabled buttons
      if (can) {
        const hit = this.scene.add.rectangle(cx, CY, w - 8, h - 8, 0, 0)
          .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(50);
        this.scene.cameras.main.ignore(hit);
        hit.on('pointerover', () => this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, true, can));
        hit.on('pointerout',  () => this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, false, can));
        hit.on('pointerup',   () => act.cb());
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
    w: number, h: number, color: number, hover: boolean, affordable: boolean = true) {
    g.clear();
    const fill = !affordable ? 0x1a1a1a : hover ? COLORS.BTN_HOVER : COLORS.BTN_NORMAL;
    g.fillStyle(fill, 1);
    g.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 5);
    g.lineStyle(1, affordable ? color : 0x333333, 0.5);
    g.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, 5);
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


