import Phaser from 'phaser';
import { TOWER_DEFS, TOWER_TYPES_ORDERED, type TowerType } from '../data/towers';
import { COLORS } from '../utils/constants';
import type { EconomyManager } from '../systems/EconomyManager';
import type { Tower } from '../entities/Tower';
import { drawElevatedButton } from '../utils/ButtonStyles';

const TLEFT = 12;  // left margin for tower button area

export class BottomBar {
  private scene:   Phaser.Scene;
  private economy: EconomyManager;

  // Background
  private bg: Phaser.GameObjects.Graphics;

  // BUILD mode elements (all 6 always created, hidden when scrolled away)
  private buildBgs:     Phaser.GameObjects.Graphics[] = [];
  private buildIcons:   Phaser.GameObjects.Image[]    = [];
  private buildNames:   Phaser.GameObjects.Text[]     = [];
  private buildCosts:   Phaser.GameObjects.Text[]     = [];
  private buildHits:    Phaser.GameObjects.Rectangle[] = [];
  private hotkeyLabels: Phaser.GameObjects.Text[]     = [];

  // Scroll arrows (shown when not all 6 buttons fit)
  private scrollPrevBg:  Phaser.GameObjects.Graphics;
  private scrollPrevHit: Phaser.GameObjects.Rectangle;
  private scrollNextBg:  Phaser.GameObjects.Graphics;
  private scrollNextHit: Phaser.GameObjects.Rectangle;

  // UPGRADE mode
  private upgRoot:    Phaser.GameObjects.Container;
  private upgBtnList: UBtn[] = [];
  private currentUpgradeTower: Tower | null = null;

  // Wave button
  private waveBg:     Phaser.GameObjects.Graphics;
  private waveLine1:  Phaser.GameObjects.Text;
  private waveLabel:  Phaser.GameObjects.Text;
  private waveHit:    Phaser.GameObjects.Rectangle;
  private _wavePulse: Phaser.Tweens.Tween | null = null;

  // Dynamic layout — recomputed in resize()
  private _BAR_H    = 180;
  private _BAR_Y    = 0;
  private _TOWER_CY = 0;
  private _TBW      = 110;   // tower button width
  private _TBH      = 100;   // tower button height
  private _TGAP     = 6;     // gap between buttons
  private _WAVE_W   = 140;   // wave button width
  private _WAVE_CX  = 0;
  private _DIVX     = 0;     // x where wave section begins
  private _ARROW_W  = 0;     // scroll arrow width (0 = no scrolling)
  private _visibleTowers = 6;
  private _scrollOffset  = 0;

  // Callbacks
  onPlaceTower: ((type: TowerType) => void) | null = null;
  onUpgrade:    (() => void) | null = null;
  onEvolve:     ((branch: 0 | 1) => void) | null = null;
  onSell:       (() => void) | null = null;
  onSendWave:   (() => void) | null = null;

  constructor(scene: Phaser.Scene, economy: EconomyManager) {
    this.scene   = scene;
    this.economy = economy;
    const D = 40;

    // ── Background ─────────────────────────────────────────────────────────
    this.bg = scene.add.graphics().setScrollFactor(0).setDepth(D);

    // ── Scroll arrows ──────────────────────────────────────────────────────
    this.scrollPrevBg = scene.add.graphics().setScrollFactor(0).setDepth(D + 1).setVisible(false);
    this.scrollPrevHit = scene.add.rectangle(-999, 0, 28, 80, 0, 0)
      .setScrollFactor(0).setDepth(D + 4).setInteractive({ useHandCursor: true }).setVisible(false)
      .on('pointerup', () => this.scrollTowers(-1));

    this.scrollNextBg = scene.add.graphics().setScrollFactor(0).setDepth(D + 1).setVisible(false);
    this.scrollNextHit = scene.add.rectangle(-999, 0, 28, 80, 0, 0)
      .setScrollFactor(0).setDepth(D + 4).setInteractive({ useHandCursor: true }).setVisible(false)
      .on('pointerup', () => this.scrollTowers(+1));

    // ── Build section ──────────────────────────────────────────────────────
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

      // Hit rect: handlers reference instance fields so resize is transparent
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

    // ── Upgrade section ────────────────────────────────────────────────────
    this.upgRoot = scene.add.container(0, 0).setScrollFactor(0).setDepth(D + 1).setVisible(false);

    // ── Wave button ────────────────────────────────────────────────────────
    this.waveBg    = scene.add.graphics().setScrollFactor(0).setDepth(D + 1);
    this.waveLine1 = scene.add.text(0, 0, 'WAVE 0 / 50', {
      fontSize: '12px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
    this.waveLabel = scene.add.text(0, 0, '▶ SEND\n[SPACE]', {
      fontSize: '17px', fontFamily: 'monospace', color: '#44ff88', align: 'center', lineSpacing: 4,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
    this.waveHit = scene.add.rectangle(0, 0, 140, 80, 0, 0)
      .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 3);
    this.waveHit.on('pointerover', () => this.drawWaveBtn(true));
    this.waveHit.on('pointerout',  () => this.drawWaveBtn(false));
    this.waveHit.on('pointerup',   () => this.onSendWave?.());

    // Gold-change listener
    scene.events.on('gold_changed', () => {
      this.refreshBuildAffordability();
      if (this.upgRoot.visible && this.currentUpgradeTower) {
        this.showUpgradeMode(this.currentUpgradeTower);
      }
    });
  }

  // ─── Layout helpers ───────────────────────────────────────────────────────

  /** Global tower index → screen X based on current scroll offset. */
  private towerScreenX(i: number): number {
    const slot = i - this._scrollOffset;
    return TLEFT + this._ARROW_W + slot * (this._TBW + this._TGAP) + this._TBW / 2;
  }

  /** Slot 0..N → screen X for upgrade section (no scroll, no arrow offset). */
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
    const iconSize = Math.max(36, Math.round(this._TBW * 0.47));
    const nameFSPx = Math.max(10, Math.round(this._TBW * 0.115));
    const hkFSPx   = Math.max(9,  Math.round(this._TBW * 0.095));
    const costFSPx = Math.max(10, Math.round(this._TBW * 0.115));

    TOWER_TYPES_ORDERED.forEach((type, i) => {
      const visible = this.isTowerVisible(i);
      if (!visible) {
        this.buildBgs[i].clear();
        [this.buildIcons[i], this.buildNames[i], this.hotkeyLabels[i], this.buildCosts[i], this.buildHits[i]]
          .forEach(o => (o as any).setPosition(-999, cy));
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

    const arrowH = Math.round(this._BAR_H * 0.52);
    const canPrev = this._scrollOffset > 0;
    const canNext = this._scrollOffset + this._visibleTowers < TOWER_TYPES_ORDERED.length;

    // Prev (left) arrow
    const px = TLEFT;
    this.scrollPrevBg.clear().setVisible(true);
    this.scrollPrevBg.fillStyle(canPrev ? 0x1e3a5f : 0x151520, 0.9);
    this.scrollPrevBg.fillRoundedRect(px, cy - arrowH / 2, aw - 2, arrowH, 4);
    this.scrollPrevBg.lineStyle(1, canPrev ? 0x4488cc : 0x334455, 0.7);
    this.scrollPrevBg.strokeRoundedRect(px, cy - arrowH / 2, aw - 2, arrowH, 4);
    if (canPrev) {
      this.scrollPrevBg.fillStyle(0xeef0f4, 1);
      const mid = cy;
      const tx1 = px + aw * 0.65, tx2 = px + aw * 0.35;
      this.scrollPrevBg.fillTriangle(tx2, mid, tx1, mid - arrowH * 0.28, tx1, mid + arrowH * 0.28);
    }
    this.scrollPrevHit.setVisible(true).setPosition(px + aw / 2, cy).setSize(aw, arrowH);

    // Next (right) arrow
    const nx = this._DIVX - aw;
    this.scrollNextBg.clear().setVisible(true);
    this.scrollNextBg.fillStyle(canNext ? 0x1e3a5f : 0x151520, 0.9);
    this.scrollNextBg.fillRoundedRect(nx + 2, cy - arrowH / 2, aw - 2, arrowH, 4);
    this.scrollNextBg.lineStyle(1, canNext ? 0x4488cc : 0x334455, 0.7);
    this.scrollNextBg.strokeRoundedRect(nx + 2, cy - arrowH / 2, aw - 2, arrowH, 4);
    if (canNext) {
      this.scrollNextBg.fillStyle(0xeef0f4, 1);
      const mid = cy;
      const tx1 = nx + aw * 0.35, tx2 = nx + aw * 0.65;
      this.scrollNextBg.fillTriangle(tx2, mid, tx1, mid - arrowH * 0.28, tx1, mid + arrowH * 0.28);
    }
    this.scrollNextHit.setVisible(true).setPosition(nx + aw / 2, cy).setSize(aw, arrowH);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  getRoot(): Phaser.GameObjects.Graphics { return this.bg; }

  getAllObjects(): Phaser.GameObjects.GameObject[] {
    return [
      this.bg,
      this.upgRoot,
      this.waveBg,   this.waveLine1, this.waveLabel,
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
    this._BAR_H = Math.max(155, Math.round(sh * 0.21));
    this._BAR_Y = sh - this._BAR_H;
    this._TOWER_CY = this._BAR_Y + Math.round(this._BAR_H * 0.5);

    // Wave button always occupies the right portion
    this._WAVE_W  = Math.max(120, Math.round(sw * 0.115));
    this._WAVE_CX = sw - this._WAVE_W / 2;
    this._DIVX    = sw - this._WAVE_W;

    // Compute tower button size to fit all 6 in tower area
    const towerAreaW = this._DIVX - TLEFT;
    const arrowW = 30;
    const tgap = Math.max(4, Math.min(10, Math.round(towerAreaW * 0.009)));

    // Try fitting all 6 without scroll arrows
    const rawTBW = Math.floor((towerAreaW + tgap) / 6 - tgap);
    const tbwFull = Math.max(68, Math.min(148, rawTBW));
    const fits6 = 6 * tbwFull + 5 * tgap <= towerAreaW;

    if (fits6) {
      this._ARROW_W = 0;
      this._visibleTowers = 6;
      this._TBW = tbwFull;
    } else {
      // Need scroll: reserve arrow width on each side
      const innerW = towerAreaW - 2 * arrowW;
      const maxVis = Math.max(3, Math.min(5, Math.floor((innerW + tgap) / (68 + tgap))));
      this._ARROW_W = arrowW;
      this._visibleTowers = maxVis;
      this._TBW = Math.max(68, Math.floor((innerW - (maxVis - 1) * tgap) / maxVis));
    }

    this._TGAP = tgap;
    this._TBH  = Math.max(60, Math.min(Math.round(this._TBW * 0.95), Math.round(this._BAR_H * 0.84)));

    // Clamp scroll
    this._scrollOffset = Math.min(this._scrollOffset, Math.max(0, TOWER_TYPES_ORDERED.length - this._visibleTowers));

    // Wave button font
    const waveFS = Math.max(13, Math.min(18, Math.round(this._WAVE_W * 0.115)));
    this.waveLabel.setStyle({ fontSize: waveFS + 'px' });
    this.waveLine1.setStyle({ fontSize: Math.max(10, waveFS - 4) + 'px' });

    // Background
    this.bg.clear();
    this.bg.fillStyle(COLORS.PANEL_BG, 0.97);
    this.bg.fillRect(0, this._BAR_Y, sw, this._BAR_H);
    this.bg.lineStyle(2, COLORS.PANEL_BORDER, 1);
    this.bg.lineBetween(0, this._BAR_Y, sw, this._BAR_Y);
    this.bg.lineStyle(1, COLORS.PANEL_BORDER, 0.6);
    this.bg.lineBetween(this._DIVX, this._BAR_Y + 6, this._DIVX, this._BAR_Y + this._BAR_H - 6);

    // Tower buttons
    this.repositionBuildButtons();
    this.updateScrollArrows();

    // Wave button
    const waveH = Math.round(this._BAR_H * 0.62);
    this.waveLine1.setPosition(this._WAVE_CX, this._TOWER_CY - Math.round(this._BAR_H * 0.17));
    this.waveLabel.setPosition(this._WAVE_CX, this._TOWER_CY + Math.round(this._BAR_H * 0.03));
    this.waveHit.setPosition(this._WAVE_CX, this._TOWER_CY).setSize(this._WAVE_W - 8, waveH);
    this.drawWaveBtn(false);

    // Upgrade section rebuild if visible
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
    this.buildHits.forEach((h, i) => {
      h.input!.enabled = enabled && this.isTowerVisible(i);
    });
  }

  private rebuildUpgradeSection(tower: Tower) {
    this.upgRoot.removeAll(true);
    this.upgBtnList = [];

    const def = tower.def;
    const CY  = this._TOWER_CY;
    const cx0 = this.upgradeCX(0);

    // Info panel (slot 0)
    const infoBg = this.scene.add.graphics();
    const curImgKey = tower.evolved && tower.evolutionType
      ? `tower_${tower.evolutionType}`
      : `tower_${tower.towerType}_${Math.min(tower.level - 1, 2)}`;
    this.drawTowerBtn(infoBg, cx0, CY, this._TBW, this._TBH, def.color, false, false, true);
    this.upgRoot.add(infoBg);

    const iconSize = Math.round(this._TBW * 0.5);
    const icon = this.scene.add.image(cx0, CY - this._TBH * 0.25, curImgKey).setDisplaySize(iconSize, iconSize);
    this.upgRoot.add(icon);

    const nameFSPx = Math.max(10, Math.round(this._TBW * 0.115));
    const title = this.scene.add.text(cx0, CY + this._TBH * 0.2,
      `${def.label.split(' ')[0]}\nLv${tower.level}${tower.evolved ? '★' : ''}`, {
        fontSize: nameFSPx + 'px', fontFamily: 'monospace', color: '#eef0f4', align: 'center', lineSpacing: 2,
      }).setOrigin(0.5);
    this.upgRoot.add(title);

    const stats = this.scene.add.text(cx0, CY + this._TBH * 0.41,
      `⚔${Math.round(tower.damage)} 🎯${Math.round(tower.range)}`, {
        fontSize: Math.max(9, nameFSPx - 2) + 'px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
      }).setOrigin(0.5);
    this.upgRoot.add(stats);

    if (tower.activeSynergyTags.length) {
      this.upgRoot.add(this.scene.add.text(cx0, CY + this._TBH * 0.55,
        `✦${tower.activeSynergyTags.slice(0, 2).join(',')}`, {
          fontSize: Math.max(9, nameFSPx - 3) + 'px', fontFamily: 'monospace', color: '#ffeeaa', align: 'center',
        }).setOrigin(0.5));
    }

    // Action buttons (slots 1+)
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
        previewStats: `⚔${tier.damage} 🎯${tier.range}`,
        statsDiff: diffParts.join(' '),
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
          previewStats: `⚔${evoDmg} 🎯${evoRng}`,
          statsDiff: diffParts.join(' '),
          cb: () => { this.onEvolve?.(b as 0 | 1); this.showUpgradeMode(tower); },
        });
      });
    }

    const sellVal = tower.sellValue();
    actions.push({ label: '💰 Sell', cost: sellVal, color: 0x4a1a1a, enabled: true, previewStats: `+${sellVal}g`, cb: () => this.onSell?.() });

    actions.forEach((act, i) => {
      const cx  = this.upgradeCX(i + 1);
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

      const subFSPx = Math.max(9, actFSPx - 2) + 'px';
      const subText = act.statsDiff || act.previewStats || '';
      if (subText) {
        this.upgRoot.add(this.scene.add.text(cx, CY + h * 0.26, subText, {
          fontSize: subFSPx, fontFamily: 'monospace',
          color: act.statsDiff ? (can ? '#88cc88' : '#334433') : (can ? '#8899aa' : '#334455'),
          align: 'center',
        }).setOrigin(0.5));
      }

      const costStr = act.label.startsWith('💰') ? '' : `${act.cost}g`;
      const hkStr   = act.hotkey ? `[${act.hotkey}]` : '';
      const line = [costStr, hkStr].filter(Boolean).join(' ');
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
    const waveH = Math.round(this._BAR_H * 0.62);
    drawElevatedButton(this.waveBg, { cx: this._WAVE_CX, cy: this._TOWER_CY, w: this._WAVE_W, h: waveH, theme: 'wave', hover, radius: 8 });
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
