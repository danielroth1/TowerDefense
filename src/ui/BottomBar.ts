import Phaser from 'phaser';
import { TOWER_DEFS, TOWER_TYPES_ORDERED, type TowerType } from '../data/towers';
import { ECO_BUILDING_DEFS, ECO_BUILDING_TYPES, escalatedCost, type EconomyBuildingType } from '../data/economy';
import { COLORS } from '../utils/constants';
import type { EconomyManager } from '../systems/EconomyManager';
import type { EconomySimulation } from '../systems/EconomySimulation';
import type { Tower } from '../entities/Tower';
import type { EconomyBuilding } from '../entities/EconomyBuilding';
import { drawElevatedButton } from '../utils/ButtonStyles';
import { HOTKEYS } from '../data/hotkeys';
import { isTouch, getSafeAreaInsets } from '../utils/Device';
import { Tooltip } from './Tooltip';

const TLEFT = 0; // 12;  // left margin for tower button area

// ─── Unified build items (towers + eco buildings) ─────────────────────────

type BuildItemKind = 'tower' | 'eco';

interface BuildItem {
  kind: BuildItemKind;
  type: TowerType | EconomyBuildingType;
}

const BUILD_ITEMS: BuildItem[] = [
  ...TOWER_TYPES_ORDERED.map(t => ({ kind: 'tower' as const, type: t })),
  ...ECO_BUILDING_TYPES.map(t => ({ kind: 'eco' as const, type: t })),
];

/** Hotkey labels indexed to match BUILD_ITEMS order, sourced from hotkeys.json. */
const HOTKEYS_BUILD_LABELS: string[] = BUILD_ITEMS.map(it =>
  it.kind === 'tower'
    ? (HOTKEYS.tower[it.type as TowerType] ?? '')
    : (HOTKEYS.economy[it.type as EconomyBuildingType] ?? ''),
);

export class BottomBar {
  // ─── Size constants ────────────────────────────────────────────────────
  /** Fraction of screen height the bottom bar occupies (0–1). */
  private static readonly BAR_HEIGHT_PCT = 0.25;
  /** Minimum bar height in pixels (for very small screens). */
  private static readonly MIN_BAR_H = 110;
  /** Maximum bar height in pixels (for very large screens). */
  private static readonly MAX_BAR_H = 260;

  private static readonly MIN_BTN_W = 70;

  private scene:   Phaser.Scene;
  private economy: EconomyManager;
  private ecoSim:  EconomySimulation;

  // Background
  private bg: Phaser.GameObjects.Graphics;

  // BUILD mode elements (all created, hidden when scrolled)
  private buildBgs:     Phaser.GameObjects.Graphics[] = [];
  private buildIcons:   Phaser.GameObjects.Image[]    = [];
  private buildNames:   Phaser.GameObjects.Text[]     = [];
  private buildCosts:   Phaser.GameObjects.Text[]     = [];
  private buildHits:    Phaser.GameObjects.Rectangle[] = [];
  private hotkeyLabels: Phaser.GameObjects.Text[]     = [];

  // Scroll arrows (only shown when not all items fit)
  private scrollPrevBg:  Phaser.GameObjects.Graphics;
  private scrollPrevHit: Phaser.GameObjects.Rectangle;
  private scrollNextBg:  Phaser.GameObjects.Graphics;
  private scrollNextHit: Phaser.GameObjects.Rectangle;

  // UPGRADE mode
  private upgRoot:    Phaser.GameObjects.Container;
  private upgBtnList: UBtn[] = [];
  private currentUpgradeTower: Tower | null = null;
  private currentEcoBuilding: EconomyBuilding | null = null;

  // Wave button (floating, bottom-right corner, above the bar)
  private waveBg:     Phaser.GameObjects.Graphics;
  private waveLine1:  Phaser.GameObjects.Text;
  private waveLabel:  Phaser.GameObjects.Text;
  private waveHit:    Phaser.GameObjects.Rectangle;
  private _wavePulse: Phaser.Tweens.Tween | null = null;

  // Dynamic layout — recomputed in resize()
  private _BAR_H    = 140;
  private _BAR_Y    = 0;
  private _TOWER_CY = 0;
  private _TBW      = 100;
  private _TBH      = 95;
  private _TGAP     = 6;
  private _WAVE_W   = 100;
  private _WAVE_H   = 60;
  private _WAVE_CX  = 0;
  private _WAVE_CY  = 0;   // floating Y (above bar)
  private _ARROW_W  = 0;
  private _visibleTowers = 6;
  private _scrollOffset  = 0;

  // Touch drag-to-scroll state
  private _buildVisible = true;
  private _dragActive  = false;
  private _dragStartX  = 0;
  private _dragOffset0 = 0;
  private _dragMoved   = false;
  private _touch       = isTouch();
  private _safeBottom  = 0;

  // Callbacks
  onPlaceTower: ((type: TowerType) => void) | null = null;
  onPlaceEconomy: ((type: EconomyBuildingType) => void) | null = null;
  onUpgrade:    (() => void) | null = null;
  onEvolve:     ((branch: 0 | 1) => void) | null = null;
  onSell:       (() => void) | null = null;
  onSellEco:    (() => void) | null = null;
  onUpgradeEco: (() => void) | null = null;
  onSendWave:   (() => void) | null = null;

  // Hover tooltip (desktop only)
  private tooltip: Tooltip | null = null;

  setTooltip(t: Tooltip) { this.tooltip = t; }

  constructor(scene: Phaser.Scene, economy: EconomyManager, ecoSim: EconomySimulation) {
    this.scene   = scene;
    this.economy = economy;
    this.ecoSim  = ecoSim;
    const D = 40;

    // ── Background ──────────────────────────────────────────────────────────
    this.bg = scene.add.graphics().setScrollFactor(0).setDepth(D);

    // ── Scroll arrows ────────────────────────────────────────────────────────
    this.scrollPrevBg = scene.add.graphics().setScrollFactor(0).setDepth(D + 1).setVisible(false);
    this.scrollPrevHit = scene.add.rectangle(-999, 0, 28, 80, 0, 0)
      .setScrollFactor(0).setDepth(D + 4).setInteractive({ useHandCursor: true }).setVisible(false)
      .on('pointerup', () => this.scrollTowers(-this._visibleTowers));

    this.scrollNextBg = scene.add.graphics().setScrollFactor(0).setDepth(D + 1).setVisible(false);
    this.scrollNextHit = scene.add.rectangle(-999, 0, 28, 80, 0, 0)
      .setScrollFactor(0).setDepth(D + 4).setInteractive({ useHandCursor: true }).setVisible(false)
      .on('pointerup', () => this.scrollTowers(+this._visibleTowers));

    // ── Touch drag-to-scroll on the build bar ─────────────────────────────
    scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!this._buildVisible || this._ARROW_W <= 0) return;
      if (p.y < this._BAR_Y || p.y > this._BAR_Y + this._BAR_H) return;
      if (this.isInWaveArea(p.x, p.y)) return;
      this._dragActive = true;
      this._dragStartX = p.x;
      this._dragOffset0 = this._scrollOffset;
      this._dragMoved = false;
    });
    scene.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this._dragActive || !p.isDown) return;
      const dx = p.x - this._dragStartX;
      if (Math.abs(dx) > 12) this._dragMoved = true;
      const max = BUILD_ITEMS.length - this._visibleTowers;
      this._scrollOffset = Phaser.Math.Clamp(
        this._dragOffset0 - Math.round(dx / (this._TBW + this._TGAP)),
        0, max,
      );
      this.repositionBuildButtons();
      this.updateScrollArrows();
    });
    scene.input.on('pointerup', () => { this._dragActive = false; });

    // ── Build section ────────────────────────────────────────────────────────
    BUILD_ITEMS.forEach((item, i) => {
      const isTower = item.kind === 'tower';
      const def = isTower
        ? TOWER_DEFS[item.type as TowerType]
        : ECO_BUILDING_DEFS[item.type as EconomyBuildingType];
      const label = isTower
        ? def.label.split(' ')[0]
        : (def as any).label;
      const color = (def as any).color ?? 0x888888;
      const iconKey = isTower
        ? `tower_${item.type}_0`
        : (def as any).textureKey;
      const cost = isTower
        ? (def as any).baseCost
        : escalatedCost(def as any, this.ecoSim.countOfType(item.type as EconomyBuildingType));

      const bg2 = scene.add.graphics().setScrollFactor(0).setDepth(D + 1);
      this.buildBgs.push(bg2);

      const icon = scene.add.image(-999, 0, iconKey)
        .setDisplaySize(60, 60).setScrollFactor(0).setDepth(D + 2);
      this.buildIcons.push(icon);

      const lbl = scene.add.text(-999, 0, label, {
        fontSize: '13px', fontFamily: 'monospace', color: '#ccddee', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.buildNames.push(lbl);

      const hkChars = HOTKEYS_BUILD_LABELS;
      const hkLbl = scene.add.text(-999, 0, hkChars[i] ? `[${hkChars[i]}]` : '', {
        fontSize: '11px', fontFamily: 'monospace', color: '#667788', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.hotkeyLabels.push(hkLbl);

      const costLabel = isTower ? `${cost}g` : `🏠${cost}g`;
      const costTxt = scene.add.text(-999, 0, costLabel, {
        fontSize: '13px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.buildCosts.push(costTxt);

      const hit = scene.add.rectangle(-999, 0, 100, 80, 0, 0)
        .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 3);
      hit.on('pointerover', (pointer: Phaser.Input.Pointer) => {
        if (!this.isTowerVisible(i)) return;
        this.showItemTooltip(pointer, item);
        const currentCost = isTower
          ? (def as any).baseCost
          : escalatedCost(def as any, this.ecoSim.countOfType(item.type as EconomyBuildingType));
        this.drawTowerBtn(bg2, this.towerScreenX(i), this._TOWER_CY, this._TBW, this._TBH, color, true, false, this.economy.canAfford(currentCost));
      });
      hit.on('pointerout', () => {
        if (!this.isTowerVisible(i)) return;
        this.tooltip?.hide();
        const currentCost = isTower
          ? (def as any).baseCost
          : escalatedCost(def as any, this.ecoSim.countOfType(item.type as EconomyBuildingType));
        this.drawTowerBtn(bg2, this.towerScreenX(i), this._TOWER_CY, this._TBW, this._TBH, color, false, false, this.economy.canAfford(currentCost));
      });
      hit.on('pointerup', () => {
        // A swipe/drag on the bar must not trigger a build tap
        if (this._dragMoved) { this._dragMoved = false; return; }
        const currentCost = isTower
          ? (def as any).baseCost
          : escalatedCost(def as any, this.ecoSim.countOfType(item.type as EconomyBuildingType));
        if (!economy.canAfford(currentCost) || !this.isTowerVisible(i)) return;
        if (isTower) {
          this.onPlaceTower?.(item.type as TowerType);
          this.buildBgs.forEach((b, j) => {
            if (!this.isTowerVisible(j)) return;
            const bi = BUILD_ITEMS[j];
            const bDef = bi.kind === 'tower'
              ? TOWER_DEFS[bi.type as TowerType]
              : ECO_BUILDING_DEFS[bi.type as EconomyBuildingType];
            const bColor = (bDef as any).color ?? 0x888888;
            const bCost = bi.kind === 'tower'
              ? (bDef as any).baseCost
              : escalatedCost(bDef as any, this.ecoSim.countOfType(bi.type as EconomyBuildingType));
            this.drawTowerBtn(b, this.towerScreenX(j), this._TOWER_CY, this._TBW, this._TBH, bColor, false, j === i, this.economy.canAfford(bCost));
          });
        } else {
          this.onPlaceEconomy?.(item.type as EconomyBuildingType);
        }
      });
      this.buildHits.push(hit);
    });

    // ── Upgrade section ──────────────────────────────────────────────────────
    this.upgRoot = scene.add.container(0, 0).setScrollFactor(0).setDepth(D + 1).setVisible(false);

    // ── Wave button (floating, depth higher than bar) ─────────────────────────
    const WD = D + 8;  // above everything in the bar
    this.waveBg    = scene.add.graphics().setScrollFactor(0).setDepth(WD);
    this.waveLine1 = scene.add.text(0, 0, 'WAVE 0 / 50', {
      fontSize: '11px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(WD + 1);
    const waveHk = this._touch ? '' : `[${HOTKEYS.actions.sendWave || 'SPACE'}]`;
    this.waveLabel = scene.add.text(0, 0, `▶ SEND\n${waveHk}`, {
      fontSize: '15px', fontFamily: 'monospace', color: '#44ff88', align: 'center', lineSpacing: 4,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(WD + 1);
    this.waveHit = scene.add.rectangle(0, 0, 100, 60, 0, 0)
      .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(WD + 2);
    this.waveHit.on('pointerover', () => this.drawWaveBtn(true));
    this.waveHit.on('pointerout',  () => this.drawWaveBtn(false));
    this.waveHit.on('pointerup',   () => {
      // A swipe that ends over the wave button must not send the wave
      if (this._dragMoved) { this._dragMoved = false; return; }
      this.onSendWave?.();
    });

    this.drawWaveBtn(false);

    // Gold listener — refresh affordability for all build items
    scene.events.on('gold_changed', () => {
      this.refreshBuildAffordability();
      if (this.upgRoot.visible && this.currentUpgradeTower) {
        this.showUpgradeMode(this.currentUpgradeTower);
      }
      if (this.upgRoot.visible && this.currentEcoBuilding) {
        this.showEconomyMode(this.currentEcoBuilding);
      }
    });
  }

  // ─── Layout helpers ──────────────────────────────────────────────────────

  private towerScreenX(i: number): number {
    const slot = i - this._scrollOffset;
    // Gap between prev arrow and first visible button
    const arrowGap = this._ARROW_W > 0 ? this._TGAP : 0;
    return TLEFT + this._ARROW_W + arrowGap + slot * (this._TBW + this._TGAP) + this._TBW / 2;
  }

  private upgradeCX(slot: number): number {
    return TLEFT + slot * (this._TBW + this._TGAP) + this._TBW / 2;
  }

  private isTowerVisible(i: number): boolean {
    const slot = i - this._scrollOffset;
    return slot >= 0 && slot < this._visibleTowers;
  }

  private scrollTowers(delta: number) {
    const max = BUILD_ITEMS.length - this._visibleTowers;
    this._scrollOffset = Math.max(0, Math.min(max, this._scrollOffset + delta));
    this.repositionBuildButtons();
    this.updateScrollArrows();
  }

  private repositionBuildButtons() {
    const cy = this._TOWER_CY;
    const iconSize  = Math.max(36, Math.round(this._TBW * 0.47));
    const nameFSPx  = Math.max(10, Math.round(this._TBW * 0.115));
    const hkFSPx    = Math.max(9,  Math.round(this._TBW * 0.095));
    const costFSPx  = Math.max(10, Math.round(this._TBW * 0.115));

    BUILD_ITEMS.forEach((item, i) => {
      if (!this.isTowerVisible(i)) {
        this.buildBgs[i].clear();
        [this.buildIcons[i], this.buildNames[i], this.hotkeyLabels[i],
         this.buildCosts[i], this.buildHits[i]].forEach(o => (o as any).setPosition(-999, cy));
        this.buildHits[i].input!.enabled = false;
        return;
      }
      const cx  = this.towerScreenX(i);
      const isTower = item.kind === 'tower';
      const def = isTower
        ? TOWER_DEFS[item.type as TowerType]
        : ECO_BUILDING_DEFS[item.type as EconomyBuildingType];
      const color = (def as any).color ?? 0x888888;
      const cost = isTower
        ? (def as any).baseCost
        : escalatedCost(def as any, this.ecoSim.countOfType(item.type as EconomyBuildingType));
      const can = this.economy.canAfford(cost);
      this.drawTowerBtn(this.buildBgs[i], cx, cy, this._TBW, this._TBH, color, false, false, can);
      this.buildIcons[i].setPosition(cx, cy - this._TBH * 0.15).setDisplaySize(iconSize, iconSize);
      this.buildNames[i].setPosition(cx, cy + this._TBH * 0.17).setStyle({ fontSize: nameFSPx + 'px' });
      this.hotkeyLabels[i].setPosition(cx, cy + this._TBH * 0.31).setStyle({ fontSize: hkFSPx + 'px' })
        .setVisible(!this._touch);
      this.buildCosts[i].setPosition(cx, cy + this._TBH * 0.44).setStyle({ fontSize: costFSPx + 'px' });
      this.buildCosts[i].setColor(can ? '#ffd700' : '#885533');
      this.buildHits[i].setPosition(cx, cy).setSize(this._TBW - 4, this._TBH - 4);
      this.buildHits[i].input!.enabled = true;
    });
  }

  private updateScrollArrows() {
    const cy  = this._TOWER_CY;
    const aw  = this._ARROW_W;
    const show = aw > 0;

    if (!show) {
      this.scrollPrevBg.clear().setVisible(false);
      this.scrollNextBg.clear().setVisible(false);
      this.scrollPrevHit.setVisible(false);
      this.scrollNextHit.setVisible(false);
      return;
    }

    // Arrow height matches tower button height
    const arrowH = this._TBH;
    const canPrev = this._scrollOffset > 0;
    const canNext = this._scrollOffset + this._visibleTowers < BUILD_ITEMS.length;

    // Prev arrow
    const px = TLEFT;
    this.scrollPrevBg.clear().setVisible(true);
    this.scrollPrevBg.fillStyle(canPrev ? 0x1e3a5f : 0x151520, 0.9);
    this.scrollPrevBg.fillRoundedRect(px, cy - arrowH / 2, aw - 2, arrowH, 4);
    this.scrollPrevBg.lineStyle(1, canPrev ? 0x4488cc : 0x334455, 0.7);
    this.scrollPrevBg.strokeRoundedRect(px, cy - arrowH / 2, aw - 2, arrowH, 4);
    if (canPrev) {
      this.scrollPrevBg.fillStyle(0xeef0f4, 1);
      const tx1 = px + aw * 0.65, tx2 = px + aw * 0.35;
      this.scrollPrevBg.fillTriangle(tx2, cy, tx1, cy - arrowH * 0.28, tx1, cy + arrowH * 0.28);
    }
    this.scrollPrevHit.setVisible(true).setPosition(px + aw / 2, cy).setSize(aw, arrowH);

    // Next arrow — gap after the last visible tower button
    const lastSlot = this._visibleTowers - 1;
    const arrowGap = this._ARROW_W > 0 ? this._TGAP : 0;
    const lastTowerRight = TLEFT + this._ARROW_W + arrowGap + lastSlot * (this._TBW + this._TGAP) + this._TBW;
    const nx = lastTowerRight + this._TGAP;
    this.scrollNextBg.clear().setVisible(true);
    this.scrollNextBg.fillStyle(canNext ? 0x1e3a5f : 0x151520, 0.9);
    this.scrollNextBg.fillRoundedRect(nx + 2, cy - arrowH / 2, aw - 2, arrowH, 4);
    this.scrollNextBg.lineStyle(1, canNext ? 0x4488cc : 0x334455, 0.7);
    this.scrollNextBg.strokeRoundedRect(nx + 2, cy - arrowH / 2, aw - 2, arrowH, 4);
    if (canNext) {
      this.scrollNextBg.fillStyle(0xeef0f4, 1);
      const tx1 = nx + aw * 0.35, tx2 = nx + aw * 0.65;
      this.scrollNextBg.fillTriangle(tx2, cy, tx1, cy - arrowH * 0.28, tx1, cy + arrowH * 0.28);
    }
    this.scrollNextHit.setVisible(true).setPosition(nx + aw / 2, cy).setSize(aw, arrowH);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  get barHeight(): number { return this._BAR_H; }

  /** True if (x, y) is within the floating wave button's area. */
  isInWaveArea(x: number, y: number): boolean {
    return x >= this._WAVE_CX - this._WAVE_W / 2 - 4
        && x <= this._WAVE_CX + this._WAVE_W / 2 + 4
        && y >= this._WAVE_CY - this._WAVE_H / 2 - 4
        && y <= this._WAVE_CY + this._WAVE_H / 2 + 4;
  }

  getRoot(): Phaser.GameObjects.Graphics { return this.bg; }

  getAllObjects(): Phaser.GameObjects.GameObject[] {
    return [
      this.bg,
      this.upgRoot,
      this.waveBg, this.waveLine1, this.waveLabel,
      this.scrollPrevBg, this.scrollPrevHit,
      this.scrollNextBg, this.scrollNextHit,
      ...this.buildBgs,
      ...this.buildIcons,
      ...this.buildNames,
      ...this.buildCosts,
      ...this.buildHits,
      ...this.hotkeyLabels,
      this.waveHit,
      ...this.upgBtnList.flatMap(b => [b.bg, b.txt, b.hit]),
    ];
  }

  resize(sw: number, sh: number) {
    const towerAreaW = sw - 2 * TLEFT;
    const arrowW = 30;

    this._safeBottom = getSafeAreaInsets().bottom;

    // ── 0. Start with ideal bar height from screen pct ───────────────────
    // Touch devices get a slimmer bar so the map stays visible in portrait.
    const pct = this._touch ? 0.20 : BottomBar.BAR_HEIGHT_PCT;
    let barH = Math.max(
      BottomBar.MIN_BAR_H,
      Math.min(BottomBar.MAX_BAR_H, Math.round(sh * pct))
    );

    // ── 1. Buttons fill bar edge-to-edge (no vertical margins) ───────────
    // Shrink bar until at least 3 buttons + 2 scroll arrows + gaps fit
    while (barH >= BottomBar.MIN_BAR_H) {
      const tbh = barH;
      const tbw = Math.max(BottomBar.MIN_BTN_W, Math.round(tbh * 0.82));
      const tgap = Math.max(2, Math.min(8, Math.round(tbw * 0.05)));
      // Layout: [prev] [gap] [btn] [gap] [btn] [gap] [btn] [gap] [next]
      if (3 * tbw + 4 * tgap + 2 * arrowW <= towerAreaW) break;
      barH--;
    }

    this._BAR_H = barH;
    this._BAR_Y = sh - this._safeBottom - this._BAR_H;
    this._TOWER_CY = this._BAR_Y + Math.round(this._BAR_H * 0.5);

    // ── 2. Button dimensions (no vertical pad) ───────────────────────────
    this._TBH = this._BAR_H;
    this._TBW = Math.max(BottomBar.MIN_BTN_W, Math.round(this._TBH * 0.82));
    this._TGAP = Math.max(2, Math.min(8, Math.round(this._TBW * 0.05)));

    // ── 3. Fit buttons across the bar width ──────────────────────────────
    const totalItems = BUILD_ITEMS.length;
    const fitsAll = totalItems * this._TBW + (totalItems - 1) * this._TGAP <= towerAreaW;

    if (fitsAll) {
      this._ARROW_W = 0;
      this._visibleTowers = totalItems;
    } else {
      // Reserve room for arrows AND the gaps between arrows and edge buttons
      const innerW = towerAreaW - 2 * arrowW - 2 * this._TGAP;
      this._ARROW_W = arrowW;
      this._visibleTowers = Math.max(3, Math.min(totalItems,
        Math.floor((innerW + this._TGAP) / (this._TBW + this._TGAP))
      ));
    }

    // ── 4. Floating wave button ──────────────────────────────────────────
    const waveW = Math.max(84, Math.round(sw * 0.078));
    const waveH = Math.max(52, Math.round(waveW * 0.6));
    this._WAVE_W = waveW;
    this._WAVE_H = waveH;
    this._WAVE_CX = sw - waveW / 2 - 10;
    this._WAVE_CY = this._BAR_Y - Math.round(waveH * 0.35);

    // Clamp scroll
    this._scrollOffset = Math.min(this._scrollOffset, Math.max(0, BUILD_ITEMS.length - this._visibleTowers));

    // Wave font
    const waveFS = Math.max(12, Math.min(16, Math.round(waveW * 0.135)));
    this.waveLabel.setStyle({ fontSize: waveFS + 'px' });
    this.waveLine1.setStyle({ fontSize: Math.max(9, waveFS - 3) + 'px' });

    // ── Background bar (no divider — full width for towers) ────────────────
    this.bg.clear();
    this.bg.fillStyle(COLORS.PANEL_BG, 0.97);
    this.bg.fillRect(0, this._BAR_Y, sw, this._BAR_H);
    this.bg.lineStyle(2, COLORS.PANEL_BORDER, 1);
    this.bg.lineBetween(0, this._BAR_Y, sw, this._BAR_Y);

    // ── Tower buttons ──────────────────────────────────────────────────────
    this.repositionBuildButtons();
    this.updateScrollArrows();

    // ── Floating wave button ───────────────────────────────────────────────
    this.waveLine1.setPosition(this._WAVE_CX, this._WAVE_CY - Math.round(waveH * 0.22));
    this.waveLabel.setPosition(this._WAVE_CX, this._WAVE_CY + Math.round(waveH * 0.1));
    this.waveHit.setPosition(this._WAVE_CX, this._WAVE_CY).setSize(waveW - 6, waveH - 4);
    this.drawWaveBtn(false);

    // ── Upgrade section ────────────────────────────────────────────────────
    if (this.upgRoot.visible && this.currentUpgradeTower) {
      this.showUpgradeMode(this.currentUpgradeTower);
    }
  }

  setWaveInfo(wave: number, totalWaves: number, countdown: number, waveActive = false) {
    this.waveLine1.setText('WAVE ' + wave + ' / ' + totalWaves);
    if (waveActive) {
      this.waveLabel.setText('IN PROGRESS').setColor('#667788');
      this.waveHit.input!.enabled = false;
      this.stopWavePulse();
    } else if (countdown > 0) {
      const waveHkLabel = this._touch ? '' : `[${HOTKEYS.actions.sendWave || 'SPACE'}]`;
      this.waveLabel.setText(Math.ceil(countdown / 1000) + 's\n' + waveHkLabel).setColor('#aabbcc');
      this.waveHit.input!.enabled = true;
      this.stopWavePulse();
    } else {
      this.waveLabel.setText('▶ SEND\n' + (this._touch ? '' : `[${HOTKEYS.actions.sendWave || 'SPACE'}]`)).setColor('#44ff88');
      this.waveHit.input!.enabled = true;
      this.startWavePulse();
    }
  }

  showBuildMode() {
    this.tooltip?.hide();
    this.currentUpgradeTower = null;
    this.currentEcoBuilding = null;
    this._buildVisible = true;
    this.setBuildVisible(true);
    this.setBuildInputEnabled(true);
    this.upgRoot.setVisible(false);
    this.clearUpgHits();
    this.scrollPrevBg.setVisible(this._ARROW_W > 0);
    this.scrollPrevHit.setVisible(this._ARROW_W > 0);
    this.scrollNextBg.setVisible(this._ARROW_W > 0);
    this.scrollNextHit.setVisible(this._ARROW_W > 0);
    this.updateScrollArrows();
    this.refreshBuildAffordability();
  }

  showUpgradeMode(tower: Tower) {
    this.tooltip?.hide();
    this.currentUpgradeTower = tower;
    this.currentEcoBuilding = null;
    this._buildVisible = false;
    this.setBuildVisible(false);
    this.setBuildInputEnabled(false);
    this.scrollPrevBg.setVisible(false);
    this.scrollPrevHit.setVisible(false);
    this.scrollNextBg.setVisible(false);
    this.scrollNextHit.setVisible(false);
    this.clearUpgHits();
    this.rebuildUpgradeSection(tower);
    this.upgRoot.setVisible(true);
  }

  showEconomyMode(building: EconomyBuilding) {
    this.tooltip?.hide();
    this.currentEcoBuilding = building;
    this.currentUpgradeTower = null;
    this._buildVisible = false;
    this.setBuildVisible(false);
    this.setBuildInputEnabled(false);
    this.scrollPrevBg.setVisible(false);
    this.scrollPrevHit.setVisible(false);
    this.scrollNextBg.setVisible(false);
    this.scrollNextHit.setVisible(false);
    this.clearUpgHits();
    this.rebuildEconomySection(building);
    this.upgRoot.setVisible(true);
  }

  refreshBuildAffordability() {
    BUILD_ITEMS.forEach((item, i) => {
      if (!this.isTowerVisible(i)) return;
      const isTower = item.kind === 'tower';
      const def = isTower
        ? TOWER_DEFS[item.type as TowerType]
        : ECO_BUILDING_DEFS[item.type as EconomyBuildingType];
      const color = (def as any).color ?? 0x888888;
      const cost = isTower
        ? (def as any).baseCost
        : escalatedCost(def as any, this.ecoSim.countOfType(item.type as EconomyBuildingType));
      const can = this.economy.canAfford(cost);
      this.buildCosts[i].setColor(can ? '#ffd700' : '#885533');
      this.drawTowerBtn(this.buildBgs[i], this.towerScreenX(i), this._TOWER_CY, this._TBW, this._TBH, color, false, false, can);
    });
  }

  update() { this.refreshBuildAffordability(); }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private startWavePulse() {
    if (this._wavePulse) return;
    this._wavePulse = this.scene.tweens.add({
      targets: this.waveLabel, scaleX: 1.04, scaleY: 1.04,
      duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  private stopWavePulse() {
    if (!this._wavePulse) return;
    this._wavePulse.stop();
    this.waveLabel.setScale(1);
    this._wavePulse = null;
  }

  private setBuildVisible(vis: boolean) {
    [...this.buildBgs, ...this.buildIcons, ...this.buildNames,
     ...this.buildCosts, ...this.buildHits, ...this.hotkeyLabels]
      .forEach(o => o.setVisible(vis));
  }

  private setBuildInputEnabled(enabled: boolean) {
    this.buildHits.forEach((h, i) => { h.input!.enabled = enabled && this.isTowerVisible(i); });
  }

  private rebuildUpgradeSection(tower: Tower) {
    this.upgRoot.removeAll(true);
    this.upgBtnList = [];

    const def = tower.def;
    const CY  = this._TOWER_CY;
    const cx0 = this.upgradeCX(0);

    const infoBg = this.scene.add.graphics();
    const curImgKey = tower.evolved && tower.evolutionType
      ? `tower_${tower.evolutionType}`
      : `tower_${tower.towerType}_${Math.min(tower.level - 1, 2)}`;
    this.drawTowerBtn(infoBg, cx0, CY, this._TBW, this._TBH, def.color, false, false, true);
    this.upgRoot.add(infoBg);

    const iconSize = Math.round(this._TBW * 0.5);
    this.upgRoot.add(this.scene.add.image(cx0, CY - this._TBH * 0.25, curImgKey).setDisplaySize(iconSize, iconSize));

    const nameFSPx = Math.max(10, Math.round(this._TBW * 0.115));
    this.upgRoot.add(this.scene.add.text(cx0, CY + this._TBH * 0.2,
      `${def.label.split(' ')[0]}\nLv${tower.level}${tower.evolved ? '★' : ''}`, {
        fontSize: nameFSPx + 'px', fontFamily: 'monospace', color: '#eef0f4', align: 'center', lineSpacing: 2,
      }).setOrigin(0.5));

    this.upgRoot.add(this.scene.add.text(cx0, CY + this._TBH * 0.41,
      `⚔${Math.round(tower.damage)} 🎯${Math.round(tower.range)}`, {
        fontSize: Math.max(9, nameFSPx - 2) + 'px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
      }).setOrigin(0.5));

    if (tower.activeSynergyTags.length) {
      this.upgRoot.add(this.scene.add.text(cx0, CY + this._TBH * 0.55,
        `✦${tower.activeSynergyTags.slice(0, 2).join(',')}`, {
          fontSize: Math.max(9, nameFSPx - 3) + 'px', fontFamily: 'monospace', color: '#ffeeaa', align: 'center',
        }).setOrigin(0.5));
    }

    interface UpgAction {
      label: string; color: number; cb: () => void; enabled: boolean;
      hotkey?: string; cost: number; previewImgKey?: string; previewStats?: string; statsDiff?: string;
    }
    const actions: UpgAction[] = [];

    if (tower.canUpgrade()) {
      const cost = tower.upgradeCost();
      const tier = tower.def.upgrades[tower.level - 1];
      const diffParts = [
        tier.damage !== tower.damage ? `⚔${Math.round(tower.damage)}→${tier.damage}` : '',
        tier.range  !== tower.range  ? `🎯${Math.round(tower.range)}→${tier.range}`  : '',
      ].filter(Boolean);
      actions.push({
        label: `⬆ ${tier.label}`, hotkey: HOTKEYS.actions.upgradeEvolve0 || 'U', cost,
        color: this.economy.canAfford(cost) ? 0x1e5a3a : 0x333333,
        enabled: this.economy.canAfford(cost),
        previewImgKey: `tower_${tower.towerType}_${Math.min(tower.level, 2)}`,
        previewStats: `⚔${tier.damage} 🎯${tier.range}`, statsDiff: diffParts.join(' '),
        cb: () => { this.onUpgrade?.(); this.showUpgradeMode(tower); },
      });
    }

    if (tower.canEvolve()) {
      [HOTKEYS.actions.upgradeEvolve0 || 'U', HOTKEYS.actions.evolve1 || 'I'].forEach((hotkey, b) => {
        const evo = def.evolutions[b];
        const can = this.economy.canAfford(evo.cost);
        const evoDmg = evo.stats.damage ?? tower.damage;
        const evoRng = evo.stats.range  ?? tower.range;
        const diffParts = [
          evo.stats.damage ? `⚔${Math.round(tower.damage)}→${evoDmg}` : '',
          evo.stats.range  ? `🎯${Math.round(tower.range)}→${evoRng}`  : '',
        ].filter(Boolean);
        actions.push({
          label: `★ ${evo.label}`, hotkey, cost: evo.cost,
          color: can ? 0x3a2a00 : 0x333333, enabled: can,
          previewImgKey: `tower_${evo.type}`,
          previewStats: `⚔${evoDmg} 🎯${evoRng}`, statsDiff: diffParts.join(' '),
          cb: () => { this.onEvolve?.(b as 0 | 1); this.showUpgradeMode(tower); },
        });
      });
    }

    const sellVal = tower.sellValue();
    const sellHk = HOTKEYS.actions.sell || '';
    actions.push({ label: '💰 Sell', cost: sellVal, color: 0x4a1a1a, enabled: true, hotkey: sellHk,
      previewStats: `+${sellVal}g`, cb: () => this.onSell?.() });

    actions.forEach((act, i) => {
      const cx = this.upgradeCX(i + 1);
      const can = act.enabled;
      const w = this._TBW, h = this._TBH;
      const actFSPx = Math.max(10, Math.round(w * 0.105));

      const bg4 = this.scene.add.graphics();
      this.upgRoot.add(bg4);
      this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, false, can);

      if (act.previewImgKey) {
        const pvSize = Math.round(w * 0.37);
        this.upgRoot.add(this.scene.add.image(cx, CY - h * 0.27, act.previewImgKey)
          .setDisplaySize(pvSize, pvSize).setAlpha(can ? 1 : 0.4));
      }

      const txt = this.scene.add.text(cx, CY + h * 0.08, act.label, {
        fontSize: actFSPx + 'px', fontFamily: 'monospace', color: can ? '#eef0f4' : '#445566', align: 'center',
      }).setOrigin(0.5);
      this.upgRoot.add(txt);

      const subText = act.statsDiff || act.previewStats || '';
      if (subText) {
        this.upgRoot.add(this.scene.add.text(cx, CY + h * 0.26, subText, {
          fontSize: Math.max(9, actFSPx - 2) + 'px', fontFamily: 'monospace',
          color: act.statsDiff ? (can ? '#88cc88' : '#334433') : (can ? '#8899aa' : '#334455'),
          align: 'center',
        }).setOrigin(0.5));
      }

      const line = [
        act.label.startsWith('💰') ? '' : `${act.cost}g`,
        !this._touch && act.hotkey ? `[${act.hotkey}]` : '',
      ].filter(Boolean).join(' ');
      if (line) {
        this.upgRoot.add(this.scene.add.text(cx, CY + h * 0.42, line, {
          fontSize: Math.max(9, actFSPx - 1) + 'px', fontFamily: 'monospace',
          color: can ? '#ffd700' : '#554433', align: 'center',
        }).setOrigin(0.5));
      }

      if (can) {
        const hit = this.scene.add.rectangle(cx, CY, w - 8, h - 8, 0, 0)
          .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(50);
        this.scene.cameras.main.ignore(hit);
        hit.on('pointerover', (pointer: Phaser.Input.Pointer) => {
          this.showActionTooltip(pointer, act);
          this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, true, can);
        });
        hit.on('pointerout',  () => {
          this.tooltip?.hide();
          this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, false, can);
        });
        hit.on('pointerup',   () => act.cb());
        this.upgBtnList.push({ bg: bg4, txt, hit });
      }
    });
  }

  private rebuildEconomySection(building: EconomyBuilding) {
    this.upgRoot.removeAll(true);
    this.upgBtnList = [];

    const def = building.def;
    const CY  = this._TOWER_CY;
    const cx0 = this.upgradeCX(0);

    // ── Info panel (current building) ──────────────────────────────────────
    const infoBg = this.scene.add.graphics();
    this.drawTowerBtn(infoBg, cx0, CY, this._TBW, this._TBH, def.color, false, false, true);
    this.upgRoot.add(infoBg);

    // Use upgrade variant texture if available
    let texKey = def.textureKey;
    if (building.level > 1) {
      const variantKey = `${def.textureKey}_${building.level - 1}`;
      if (this.scene.textures.exists(variantKey)) {
        texKey = variantKey;
      }
    }
    const iconSize = Math.round(this._TBW * 0.5);
    if (this.scene.textures.exists(texKey)) {
      this.upgRoot.add(this.scene.add.image(cx0, CY - this._TBH * 0.25, texKey).setDisplaySize(iconSize, iconSize));
    }

    const nameFSPx = Math.max(10, Math.round(this._TBW * 0.115));
    this.upgRoot.add(this.scene.add.text(cx0, CY + this._TBH * 0.2,
      `${def.label}\nLv${building.level}`, {
        fontSize: nameFSPx + 'px', fontFamily: 'monospace', color: '#eef0f4', align: 'center', lineSpacing: 2,
      }).setOrigin(0.5));

    // Show production stats + stockpile
    const stats: string[] = [];
    if (def.produces) {
      stats.push(`⏱ ${(building.cycleTime / 1000).toFixed(1)}s`);
    }
    if (def.isStorage) {
      stats.push(`📦 ${building.inventory}/${building.maxInventory}`);
    }
    if (def.consumes) {
      const goodNames: Record<string, string> = {
        wheat: '🌾', flour: '🫓', bread: '🍞', fish: '🐟', goods: '📦',
      };
      const icon = goodNames[def.consumes] ?? def.consumes;
      stats.push(`←${icon}:${building.inputStock}`);
    }
    if (def.produces) {
      const goodNames: Record<string, string> = {
        wheat: '🌾', flour: '🫓', bread: '🍞', fish: '🐟', goods: '📦',
      };
      const icon = goodNames[def.produces] ?? def.produces;
      stats.push(`${icon}:${building.inventory}/${building.maxInventory}`);
    }
    if (def.isEndpoint && building.buildingType === 'market') {
      stats.push(`💰 ${building.inventory}`);
    }
    if (stats.length > 0) {
      this.upgRoot.add(this.scene.add.text(cx0, CY + this._TBH * 0.41,
        stats.join(' '), {
          fontSize: Math.max(9, nameFSPx - 2) + 'px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
        }).setOrigin(0.5));
    }

    // ── Production progress bar (right of info panel) ────────────────────
    if (def.produces || def.isEndpoint) {
      const barH = this._TBH * 0.7;
      const barW = 5;
      const barX = cx0 + this._TBW / 2 + 4;
      const barY = CY - barH / 2;
      const pct = building.cycleTime > 0
        ? Math.min(1, building.cycleTimer / building.cycleTime)
        : 0;

      // Background
      const barBg = this.scene.add.graphics();
      barBg.fillStyle(0x222222, 0.8);
      barBg.fillRect(barX, barY, barW, barH);
      barBg.lineStyle(1, 0x444444, 0.5);
      barBg.strokeRect(barX, barY, barW, barH);
      this.upgRoot.add(barBg);

      // Fill (green-to-yellow gradient effect via color lerp)
      const fillColor = pct > 0.7 ? 0x44cc44 : (pct > 0.3 ? 0xcccc44 : 0xcc8844);
      const barFill = this.scene.add.graphics();
      barFill.fillStyle(fillColor, 0.9);
      barFill.fillRect(barX + 1, barY + barH * (1 - pct) + 1, barW - 2, barH * pct - 2);
      this.upgRoot.add(barFill);
    }

    // ── Action buttons ─────────────────────────────────────────────────────
    interface EcoAction {
      label: string; color: number; cb: () => void; enabled: boolean;
      hotkey?: string; cost: number; previewStats?: string; statsDiff?: string;
      previewImgKey?: string;
    }
    const actions: EcoAction[] = [];

    if (building.canUpgrade()) {
      const cost = building.upgradeCost();
      const tier = def.upgrades[building.level - 1];
      const parts: string[] = [];
      if (tier.cycleTime > 0) parts.push(`⏱ ${(tier.cycleTime / 1000).toFixed(1)}s`);
      if (tier.valueMultiplier && tier.valueMultiplier > 1.0) parts.push(`×${tier.valueMultiplier}`);
      if (tier.extraCapacity) parts.push(`+${tier.extraCapacity}📦`);
      // Preview texture: show the next level's upgraded building sprite
      const previewImgKey = `${def.textureKey}_${building.level}`;
      actions.push({
        label: `⬆ ${tier.label}`, hotkey: HOTKEYS.actions.upgradeEvolve0 || 'U', cost,
        color: this.economy.canAfford(cost) ? 0x1e5a3a : 0x333333,
        enabled: this.economy.canAfford(cost),
        previewStats: parts.join(' '),
        previewImgKey,
        cb: () => { this.onUpgradeEco?.(); this.showEconomyMode(building); },
      });
    }

    // Markets cannot be sold
    if (building.buildingType !== 'market') {
      const sellVal = building.sellValue();
      const sellHk = HOTKEYS.actions.sell || '';
      actions.push({ label: '💰 Sell', cost: sellVal, color: 0x4a1a1a, enabled: true, hotkey: sellHk,
        previewStats: `+${sellVal}g`, cb: () => this.onSellEco?.() });
    }

    actions.forEach((act, i) => {
      const cx = this.upgradeCX(i + 1);
      const can = act.enabled;
      const w = this._TBW, h = this._TBH;
      const actFSPx = Math.max(10, Math.round(w * 0.105));

      const bg4 = this.scene.add.graphics();
      this.upgRoot.add(bg4);
      this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, false, can);

      // Preview image for upgrade (like tower upgrade preview)
      if (act.previewImgKey && this.scene.textures.exists(act.previewImgKey)) {
        const pvSize = Math.round(w * 0.37);
        this.upgRoot.add(this.scene.add.image(cx, CY - h * 0.27, act.previewImgKey)
          .setDisplaySize(pvSize, pvSize).setAlpha(can ? 1 : 0.4));
      }

      const txt = this.scene.add.text(cx, CY + h * 0.08, act.label, {
        fontSize: actFSPx + 'px', fontFamily: 'monospace', color: can ? '#eef0f4' : '#445566', align: 'center',
      }).setOrigin(0.5);
      this.upgRoot.add(txt);

      const subText = act.previewStats || '';
      if (subText) {
        this.upgRoot.add(this.scene.add.text(cx, CY + h * 0.26, subText, {
          fontSize: Math.max(9, actFSPx - 2) + 'px', fontFamily: 'monospace',
          color: can ? '#8899aa' : '#334455', align: 'center',
        }).setOrigin(0.5));
      }

      const line = [
        act.label.startsWith('💰') ? '' : `${act.cost}g`,
        !this._touch && act.hotkey ? `[${act.hotkey}]` : '',
      ].filter(Boolean).join(' ');
      if (line) {
        this.upgRoot.add(this.scene.add.text(cx, CY + h * 0.42, line, {
          fontSize: Math.max(9, actFSPx - 1) + 'px', fontFamily: 'monospace',
          color: can ? '#ffd700' : '#554433', align: 'center',
        }).setOrigin(0.5));
      }

      if (can) {
        const hit = this.scene.add.rectangle(cx, CY, w - 8, h - 8, 0, 0)
          .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(50);
        this.scene.cameras.main.ignore(hit);
        hit.on('pointerover', (pointer: Phaser.Input.Pointer) => {
          this.showActionTooltip(pointer, act);
          this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, true, can);
        });
        hit.on('pointerout',  () => {
          this.tooltip?.hide();
          this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, false, can);
        });
        hit.on('pointerup',   () => act.cb());
        this.upgBtnList.push({ bg: bg4, txt, hit });
      }
    });
  }

  // ─── Tooltip helpers (desktop hover info) ───────────────────────────────

  private showItemTooltip(pointer: Phaser.Input.Pointer, item: BuildItem) {
    if (this._touch || !this.tooltip) return;
    if (item.kind === 'tower') {
      const def = TOWER_DEFS[item.type as TowerType];
      const s = def.baseStats;
      const lines = [
        def.description,
        `⚔ ${s.damage}  🎯 ${s.range}px  ⏱ ${(1000 / s.fireRate).toFixed(1)}/s`,
        `💰 ${def.baseCost}g  ${def.targetsFlying ? '✈ targets flyers' : 'ground targets'}`,
      ];
      if (def.effectType) {
        const fx = def.effectType === 'slow'
          ? `❄ slows ${Math.round(def.effectValue * 100)}% for ${(def.effectDuration / 1000).toFixed(1)}s`
          : def.effectType === 'stun'
          ? `⚡ stuns for ${(def.effectDuration / 1000).toFixed(1)}s`
          : def.effectType === 'poison'
          ? `☠ ${def.effectValue} poison/s for ${(def.effectDuration / 1000).toFixed(1)}s`
          : def.effectType === 'chain'
          ? `⚡ chains to ${def.effectValue} targets`
          : def.effectType;
        lines.push(fx);
      }
      if (def.splashRadius > 0) lines.push(`💥 splash ${def.splashRadius}px`);
      this.tooltip.show(pointer.x, pointer.y, def.label, lines);
    } else {
      const def = ECO_BUILDING_DEFS[item.type as EconomyBuildingType];
      const cost = escalatedCost(def, this.ecoSim.countOfType(item.type as EconomyBuildingType));
      const lines: string[] = [def.description, `💰 ${cost}g`];
      if (def.produces && def.baseCycleTime > 0) {
        lines.push(`⏱ cycle ${(def.baseCycleTime / 1000).toFixed(1)}s`);
      }
      if (def.isStorage) lines.push('📦 stores goods for bulk delivery');
      this.tooltip.show(pointer.x, pointer.y, def.label, lines);
    }
  }

  private showActionTooltip(pointer: Phaser.Input.Pointer, act: {
    label: string; cost: number; previewStats?: string; statsDiff?: string; hotkey?: string;
  }) {
    if (this._touch || !this.tooltip) return;
    const lines: string[] = [];
    if (act.statsDiff) lines.push(act.statsDiff);
    if (act.previewStats) lines.push(act.previewStats);
    if (act.cost > 0) lines.push(`💰 ${act.cost}g`);
    if (act.hotkey) lines.push(`[${act.hotkey}]`);
    if (lines.length === 0) return;
    this.tooltip.show(pointer.x, pointer.y, act.label, lines);
  }

  private drawTowerBtn(g: Phaser.GameObjects.Graphics, cx: number, cy: number,
    w: number, h: number, color: number, hover: boolean, active: boolean, affordable = true) {
    drawElevatedButton(g, { cx, cy, w, h, theme: 'tower', color: affordable ? color : 0x333333, hover, active, disabled: !affordable, radius: 6 });
  }

  private drawUBtn(g: Phaser.GameObjects.Graphics, cx: number, cy: number,
    w: number, h: number, color: number, hover: boolean, affordable = true) {
    drawElevatedButton(g, { cx, cy, w, h, theme: 'upgrade', color: affordable ? color : 0x333333, hover, disabled: !affordable, radius: 6 });
  }

  private drawWaveBtn(hover: boolean) {
    drawElevatedButton(this.waveBg, {
      cx: this._WAVE_CX, cy: this._WAVE_CY,
      w: this._WAVE_W, h: this._WAVE_H,
      theme: 'wave', hover, radius: 10,
    });
  }

  private clearUpgHits() {
    for (const btn of this.upgBtnList) btn.hit?.destroy();
    this.upgBtnList = [];
  }

  destroy() { this.clearUpgHits(); }
}

interface UBtn {
  bg:  Phaser.GameObjects.Graphics;
  txt: Phaser.GameObjects.Text;
  hit: Phaser.GameObjects.Rectangle;
}
