import Phaser from 'phaser';
import { TOWER_DEFS, TOWER_TYPES_ORDERED, type TowerType } from '../data/towers';
import { COLORS } from '../utils/constants';
import type { EconomyManager } from '../systems/EconomyManager';
import type { Tower } from '../entities/Tower';
import { drawElevatedButton } from '../utils/ButtonStyles';

const TLEFT = 0; // 12;  // left margin for tower button area

export class BottomBar {
  private scene:   Phaser.Scene;
  private economy: EconomyManager;

  // Background
  private bg: Phaser.GameObjects.Graphics;

  // BUILD mode elements (all 6 created, hidden when scrolled)
  private buildBgs:     Phaser.GameObjects.Graphics[] = [];
  private buildIcons:   Phaser.GameObjects.Image[]    = [];
  private buildNames:   Phaser.GameObjects.Text[]     = [];
  private buildCosts:   Phaser.GameObjects.Text[]     = [];
  private buildHits:    Phaser.GameObjects.Rectangle[] = [];
  private hotkeyLabels: Phaser.GameObjects.Text[]     = [];

  // Scroll arrows (only shown when not all 6 fit)
  private scrollPrevBg:  Phaser.GameObjects.Graphics;
  private scrollPrevHit: Phaser.GameObjects.Rectangle;
  private scrollNextBg:  Phaser.GameObjects.Graphics;
  private scrollNextHit: Phaser.GameObjects.Rectangle;

  // UPGRADE mode
  private upgRoot:    Phaser.GameObjects.Container;
  private upgBtnList: UBtn[] = [];
  private currentUpgradeTower: Tower | null = null;

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

  // Callbacks
  onPlaceTower: ((type: TowerType) => void) | null = null;
  onUpgrade:    (() => void) | null = null;
  onEvolve:     ((branch: 0 | 1) => void) | null = null;
  onSell:       (() => void) | null = null;
  onSendWave:   (() => void) | null = null;
  onToggleEconomy: (() => void) | null = null;

  // Economy mode toggle button
  private ecoBtnBg:  Phaser.GameObjects.Graphics;
  private ecoBtnTxt: Phaser.GameObjects.Text;
  private ecoBtnHit: Phaser.GameObjects.Rectangle;
  private _ecoMode: boolean = false;

  constructor(scene: Phaser.Scene, economy: EconomyManager) {
    this.scene   = scene;
    this.economy = economy;
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

    // ── Build section ────────────────────────────────────────────────────────
    TOWER_TYPES_ORDERED.forEach((type, i) => {
      const def = TOWER_DEFS[type];

      const bg2 = scene.add.graphics().setScrollFactor(0).setDepth(D + 1);
      this.buildBgs.push(bg2);

      const icon = scene.add.image(-999, 0, `tower_${type}_0`)
        .setDisplaySize(60, 60).setScrollFactor(0).setDepth(D + 2);
      this.buildIcons.push(icon);

      const lbl = scene.add.text(-999, 0, def.label.split(' ')[0], {
        fontSize: '13px', fontFamily: 'monospace', color: '#ccddee', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.buildNames.push(lbl);

      const hkChars = ['Q', 'W', 'E', 'A', 'S', 'D'];
      const hkLbl = scene.add.text(-999, 0, `[${hkChars[i]}]`, {
        fontSize: '11px', fontFamily: 'monospace', color: '#667788', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.hotkeyLabels.push(hkLbl);

      const cost = scene.add.text(-999, 0, `${def.baseCost}g`, {
        fontSize: '13px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      this.buildCosts.push(cost);

      const hit = scene.add.rectangle(-999, 0, 100, 80, 0, 0)
        .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 3);
      hit.on('pointerover', () => {
        if (!this.isTowerVisible(i)) return;
        this.drawTowerBtn(bg2, this.towerScreenX(i), this._TOWER_CY, this._TBW, this._TBH, def.color, true, false, this.economy.canAfford(def.baseCost));
      });
      hit.on('pointerout', () => {
        if (!this.isTowerVisible(i)) return;
        this.drawTowerBtn(bg2, this.towerScreenX(i), this._TOWER_CY, this._TBW, this._TBH, def.color, false, false, this.economy.canAfford(def.baseCost));
      });
      hit.on('pointerup', () => {
        if (!economy.canAfford(def.baseCost) || !this.isTowerVisible(i)) return;
        this.onPlaceTower?.(type);
        this.buildBgs.forEach((b, j) => {
          if (!this.isTowerVisible(j)) return;
          const t = TOWER_TYPES_ORDERED[j];
          this.drawTowerBtn(b, this.towerScreenX(j), this._TOWER_CY, this._TBW, this._TBH, TOWER_DEFS[t].color, false, j === i, this.economy.canAfford(TOWER_DEFS[t].baseCost));
        });
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
    this.waveLabel = scene.add.text(0, 0, '▶ SEND\n[SPACE]', {
      fontSize: '15px', fontFamily: 'monospace', color: '#44ff88', align: 'center', lineSpacing: 4,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(WD + 1);
    this.waveHit = scene.add.rectangle(0, 0, 100, 60, 0, 0)
      .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(WD + 2);
    this.waveHit.on('pointerover', () => this.drawWaveBtn(true));
    this.waveHit.on('pointerout',  () => this.drawWaveBtn(false));
    this.waveHit.on('pointerup',   () => this.onSendWave?.());

    this.drawWaveBtn(false);

    // ── Economy mode toggle button ────────────────────────────────────────
    const ED = D + 1;
    this.ecoBtnBg = scene.add.graphics().setScrollFactor(0).setDepth(ED);
    this.ecoBtnTxt = scene.add.text(0, 0, '[V] ECO', {
      fontSize: '12px', fontFamily: 'monospace', color: '#aabbcc', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(ED + 1);
    this.ecoBtnHit = scene.add.rectangle(0, 0, 70, 24, 0, 0)
      .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(ED + 2);
    this.ecoBtnHit.on('pointerover', () => this.drawEcoBtn(true));
    this.ecoBtnHit.on('pointerout',  () => this.drawEcoBtn(false));
    this.ecoBtnHit.on('pointerup',   () => this.onToggleEconomy?.());
    this.drawEcoBtn(false);

    // Gold listener
    scene.events.on('gold_changed', () => {
      this.refreshBuildAffordability();
      if (this.upgRoot.visible && this.currentUpgradeTower) {
        this.showUpgradeMode(this.currentUpgradeTower);
      }
    });
  }

  // ─── Layout helpers ──────────────────────────────────────────────────────

  private towerScreenX(i: number): number {
    const slot = i - this._scrollOffset;
    return TLEFT + this._ARROW_W + slot * (this._TBW + this._TGAP) + this._TBW / 2;
  }

  private upgradeCX(slot: number): number {
    return TLEFT + slot * (this._TBW + this._TGAP) + this._TBW / 2;
  }

  private isTowerVisible(i: number): boolean {
    const slot = i - this._scrollOffset;
    return slot >= 0 && slot < this._visibleTowers;
  }

  private scrollTowers(delta: number) {
    const max = TOWER_TYPES_ORDERED.length - this._visibleTowers;
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

    TOWER_TYPES_ORDERED.forEach((type, i) => {
      if (!this.isTowerVisible(i)) {
        this.buildBgs[i].clear();
        [this.buildIcons[i], this.buildNames[i], this.hotkeyLabels[i],
         this.buildCosts[i], this.buildHits[i]].forEach(o => (o as any).setPosition(-999, cy));
        this.buildHits[i].input!.enabled = false;
        return;
      }
      const cx  = this.towerScreenX(i);
      const def = TOWER_DEFS[type];
      const can = this.economy.canAfford(def.baseCost);
      this.drawTowerBtn(this.buildBgs[i], cx, cy, this._TBW, this._TBH, def.color, false, false, can);
      this.buildIcons[i].setPosition(cx, cy - this._TBH * 0.15).setDisplaySize(iconSize, iconSize);
      this.buildNames[i].setPosition(cx, cy + this._TBH * 0.17).setStyle({ fontSize: nameFSPx + 'px' });
      this.hotkeyLabels[i].setPosition(cx, cy + this._TBH * 0.31).setStyle({ fontSize: hkFSPx + 'px' });
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
    const canNext = this._scrollOffset + this._visibleTowers < TOWER_TYPES_ORDERED.length;

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

    // Next arrow — right after the last visible tower button
    const lastSlot = this._visibleTowers - 1;
    const lastTowerRight = TLEFT + this._ARROW_W + lastSlot * (this._TBW + this._TGAP) + this._TBW;
    const nx = lastTowerRight;
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
      this.ecoBtnBg, this.ecoBtnTxt, this.ecoBtnHit,
    ];
  }

  resize(sw: number, sh: number) {
    // ── 1. Compute tower button size from available width ──────────────────
    // Reserve space for floating wave button on the right
    const waveW = Math.max(84, Math.round(sw * 0.078));
    const waveH = Math.max(52, Math.round(waveW * 0.6));
    this._WAVE_W = waveW;
    this._WAVE_H = waveH;

    // Tower area uses full bar width (wave button floats separately)
    const towerAreaW = sw - 2 * TLEFT;
    const arrowW = 30;
    const tgap = Math.max(4, Math.min(10, Math.round(towerAreaW * 0.009)));

    const rawTBW = Math.floor((towerAreaW + tgap) / 6 - tgap);
    const tbwFull = Math.max(68, Math.min(Math.round(sw * 0.20), rawTBW));
    const fits6   = 6 * tbwFull + 5 * tgap <= towerAreaW;

    if (fits6) {
      this._ARROW_W = 0;
      this._visibleTowers = 6;
      this._TBW = tbwFull;
    } else {
      const innerW = towerAreaW - 2 * arrowW;
      const maxVis = Math.max(3, Math.min(5, Math.floor((innerW + tgap) / (68 + tgap))));
      this._ARROW_W = arrowW;
      this._visibleTowers = maxVis;
      this._TBW = Math.max(68, Math.floor((innerW - (maxVis - 1) * tgap) / maxVis));
    }

    this._TGAP = tgap;
    this._TBH  = Math.max(60, Math.min(Math.round(this._TBW * 0.95), Math.round(sh * 0.20)));
    // Enforce rectangular aspect ratio: width ≤ 90% of height so buttons
    // are never wider than they are tall (avoids stretched look on wide screens)
    const maxRectW = Math.round(this._TBH * 0.9);
    if (this._TBW > maxRectW) {
      this._TBW = maxRectW;
    }

    // ── 2. Bar height derived from tower button height ─────────────────────
    const vertPad = 0; //Math.max(12, Math.round(this._TBH * 0.22));
    this._BAR_H   = this._TBH + 2 * vertPad;
    this._BAR_Y   = sh - this._BAR_H;
    this._TOWER_CY = this._BAR_Y + Math.round(this._BAR_H * 0.5);

    // ── 3. Wave button floats above the bar, bottom-right corner ────────────
    this._WAVE_CX = sw - waveW / 2 - 10;
    // Center: partially above bar (1/3 above), visually floating
    this._WAVE_CY = this._BAR_Y - Math.round(waveH * 0.35);

    // Clamp scroll
    this._scrollOffset = Math.min(this._scrollOffset, Math.max(0, TOWER_TYPES_ORDERED.length - this._visibleTowers));

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

    // ── Economy mode toggle ────────────────────────────────────────────────
    const ecoBtnX = TLEFT + 40;
    const ecoBtnY = this._BAR_Y + 16;
    this.ecoBtnHit.setPosition(ecoBtnX, ecoBtnY);
    this.ecoBtnTxt.setPosition(ecoBtnX, ecoBtnY);
    this.drawEcoBtn(false);

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
      this.waveLabel.setText(Math.ceil(countdown / 1000) + 's\n[SPACE]').setColor('#aabbcc');
      this.waveHit.input!.enabled = true;
      this.stopWavePulse();
    } else {
      this.waveLabel.setText('▶ SEND\n[SPACE]').setColor('#44ff88');
      this.waveHit.input!.enabled = true;
      this.startWavePulse();
    }
  }

  showBuildMode() {
    this.currentUpgradeTower = null;
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
    this.currentUpgradeTower = tower;
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

  refreshBuildAffordability() {
    TOWER_TYPES_ORDERED.forEach((type, i) => {
      if (!this.isTowerVisible(i)) return;
      const def = TOWER_DEFS[type];
      const can = this.economy.canAfford(def.baseCost);
      this.buildCosts[i].setColor(can ? '#ffd700' : '#885533');
      this.drawTowerBtn(this.buildBgs[i], this.towerScreenX(i), this._TOWER_CY, this._TBW, this._TBH, def.color, false, false, can);
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
        label: `⬆ ${tier.label}`, hotkey: 'U', cost,
        color: this.economy.canAfford(cost) ? 0x1e5a3a : 0x333333,
        enabled: this.economy.canAfford(cost),
        previewImgKey: `tower_${tower.towerType}_${Math.min(tower.level, 2)}`,
        previewStats: `⚔${tier.damage} 🎯${tier.range}`, statsDiff: diffParts.join(' '),
        cb: () => { this.onUpgrade?.(); this.showUpgradeMode(tower); },
      });
    }

    if (tower.canEvolve()) {
      ['U', 'I'].forEach((hotkey, b) => {
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
    actions.push({ label: '💰 Sell', cost: sellVal, color: 0x4a1a1a, enabled: true,
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

      const line = [act.label.startsWith('💰') ? '' : `${act.cost}g`, act.hotkey ? `[${act.hotkey}]` : '']
        .filter(Boolean).join(' ');
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
        hit.on('pointerover', () => this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, true, can));
        hit.on('pointerout',  () => this.drawUBtn(bg4, cx, CY, w - 4, h - 4, act.color, false, can));
        hit.on('pointerup',   () => act.cb());
        this.upgBtnList.push({ bg: bg4, txt, hit });
      }
    });
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

  // ─── Economy mode toggle ────────────────────────────────────────────────

  private drawEcoBtn(hover: boolean) {
    const g = this.ecoBtnBg;
    g.clear();
    const active = this._ecoMode || hover;
    g.fillStyle(active ? 0x2a5a2a : 0x1a2a1a, 0.9);
    g.fillRoundedRect(this.ecoBtnHit.x - 35, this.ecoBtnHit.y - 12, 70, 24, 5);
    g.lineStyle(1, this._ecoMode ? 0x44ff88 : 0x334433, 0.7);
    g.strokeRoundedRect(this.ecoBtnHit.x - 35, this.ecoBtnHit.y - 12, 70, 24, 5);
    this.ecoBtnTxt.setColor(this._ecoMode ? '#44ff88' : '#aabbcc');
  }

  setEcoMode(active: boolean) {
    this._ecoMode = active;
    this.drawEcoBtn(false);
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
