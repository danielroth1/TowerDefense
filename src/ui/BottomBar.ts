import Phaser from 'phaser';
import { ABILITY_DEFS, type AbilityType } from '../data/abilities';
import { TOWER_DEFS, TOWER_TYPES_ORDERED, type TowerType } from '../data/towers';
import { COLORS, GAME_WIDTH, GAME_HEIGHT } from '../utils/constants';
import type { EconomyManager } from '../systems/EconomyManager';
import type { AbilitySystem } from '../systems/AbilitySystem';
import type { Tower } from '../entities/Tower';

// ─── Layout constants ─────────────────────────────────────────────────────
const BAR_H    = 100;
const BAR_Y    = GAME_HEIGHT - BAR_H;   // 620 for 720-tall canvas

// Tower/Upgrade section (left side)
const TBW = 86, TBH = 80, TGAP = 6, TLEFT = 8;
// Centers: TLEFT + TBW/2, TLEFT + TBW + TGAP + TBW/2, ...
function towerCX(i: number) { return TLEFT + i * (TBW + TGAP) + TBW / 2; }
const TOWER_CY = BAR_Y + BAR_H / 2;
// Right edge of tower section: TLEFT + 6*(TBW+TGAP) - TGAP = 8 + 552 - 6 = 554
const DIV1_X = 562;

// Ability section
const ABW = 64, ABH = 80, ABGAP = 8, ABLEFT = DIV1_X + 8;
function abilityCX(i: number) { return ABLEFT + i * (ABW + ABGAP) + ABW / 2; }
const ABILITY_CY = BAR_Y + BAR_H / 2;
// Right edge of ability section: ABLEFT + 4*(ABW+ABGAP) - ABGAP = 570 + 288 - 8 = 850
const DIV2_X = 858;

// Wave button
const WAVE_CX = (DIV2_X + GAME_WIDTH) / 2;  // ~1005
const WAVE_W  = GAME_WIDTH - DIV2_X - 16;   // ~278
const WAVE_H  = 60;

// ─── BottomBar ─────────────────────────────────────────────────────────────
export class BottomBar {
  private scene:      Phaser.Scene;
  private economy:    EconomyManager;
  private abilitySys: AbilitySystem;

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

  // Ability buttons
  private abilityObjs: Map<AbilityType, ABtn> = new Map();

  // Wave button
  private waveBg:    Phaser.GameObjects.Graphics;
  private waveLabel: Phaser.GameObjects.Text;

  // ── Callbacks ─────────────────────────────────────────────────────────────
  onPlaceTower: ((type: TowerType) => void) | null = null;
  onUpgrade:    (() => void) | null = null;
  onEvolve:     ((branch: 0 | 1) => void) | null = null;
  onSell:       (() => void) | null = null;
  onSendWave:   (() => void) | null = null;

  constructor(scene: Phaser.Scene, economy: EconomyManager, abilitySys: AbilitySystem) {
    this.scene      = scene;
    this.economy    = economy;
    this.abilitySys = abilitySys;

    const D = 40; // base depth

    // ── Background bar ──────────────────────────────────────────────────────
    this.bg = scene.add.graphics().setScrollFactor(0).setDepth(D);
    this.bg.fillStyle(COLORS.PANEL_BG, 0.97);
    this.bg.fillRect(0, BAR_Y, GAME_WIDTH, BAR_H);
    this.bg.lineStyle(2, COLORS.PANEL_BORDER, 1);
    this.bg.lineBetween(0, BAR_Y, GAME_WIDTH, BAR_Y);
    // Dividers
    this.bg.lineStyle(1, COLORS.PANEL_BORDER, 0.6);
    this.bg.lineBetween(DIV1_X, BAR_Y + 6, DIV1_X, BAR_Y + BAR_H - 6);
    this.bg.lineBetween(DIV2_X, BAR_Y + 6, DIV2_X, BAR_Y + BAR_H - 6);

    // ── Build section ──────────────────────────────────────────────────────
    TOWER_TYPES_ORDERED.forEach((type, i) => {
      const def = TOWER_DEFS[type];
      const cx  = towerCX(i);
      const cy  = TOWER_CY;

      const bg2 = scene.add.graphics().setScrollFactor(0).setDepth(D + 1);
      const canAfford = economy.canAfford(def.baseCost);
      this.drawTowerBtn(bg2, cx, cy, TBW, TBH, def.color, false, false, canAfford);
      this.buildBgs.push(bg2);

      const icon = scene.add.image(cx, cy - 12, `tower_${type}_0`)
        .setScale(0.65).setScrollFactor(0).setDepth(D + 2);
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
          this.drawTowerBtn(b, towerCX(j), TOWER_CY, TBW, TBH, TOWER_DEFS[t].color, false, j === i, this.economy.canAfford(TOWER_DEFS[t].baseCost));
        });
      });
      this.buildHits.push(hit);
    });

    // ── Upgrade section (container, hidden by default) ─────────────────────
    this.upgRoot = scene.add.container(0, 0).setScrollFactor(0).setDepth(D + 1).setVisible(false);

    // ── Ability section ────────────────────────────────────────────────────
    ABILITY_DEFS.forEach((def, i) => {
      const cx = abilityCX(i);
      const cy = ABILITY_CY;

      const bg3   = scene.add.graphics().setScrollFactor(0).setDepth(D + 1);
      const icon  = scene.add.graphics().setScrollFactor(0).setDepth(D + 2);
      const lbl   = scene.add.text(cx, cy + 18, def.label.split(' ').slice(0, 1).join(' '), {
        fontSize: '9px', fontFamily: 'monospace', color: '#ccddee', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
      const cdOvl = scene.add.graphics().setScrollFactor(0).setDepth(D + 3);
      const cdTxt = scene.add.text(cx, cy, '', {
        fontSize: '16px', fontFamily: 'monospace', color: '#ffffff', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 4);
      const keyTxt = scene.add.text(cx - ABW / 2 + 4, cy - ABH / 2 + 4, def.hotkey, {
        fontSize: '11px', fontFamily: 'monospace', color: '#ffd700',
      }).setScrollFactor(0).setDepth(D + 4);
      const cost2 = scene.add.text(cx, cy + 30, `${def.cost}g`, {
        fontSize: '10px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);

      this.drawAbilityBtn(bg3, icon, cx, cy, def.color, false, false, def.type);

      const hit = scene.add.rectangle(cx, cy, ABW - 4, ABH - 4, 0, 0)
        .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 5);
      hit.on('pointerover',  () => this.drawAbilityBtn(bg3, icon, cx, cy, def.color, true, false, def.type));
      hit.on('pointerout',   () => {
        const sel = abilitySys.pendingCast === def.type;
        this.drawAbilityBtn(bg3, icon, cx, cy, def.color, false, sel, def.type);
      });
      hit.on('pointerup',    () => abilitySys.selectAbility(def.type));

      this.abilityObjs.set(def.type, { bg: bg3, icon, cdOvl, cdTxt, lbl, keyTxt, cost: cost2 });
    });

    scene.events.on('ability_selected', (type: AbilityType | null) => {
      for (const [t, obj] of this.abilityObjs) {
        const def = ABILITY_DEFS.find(d => d.type === t)!;
        this.drawAbilityBtn(obj.bg, obj.icon, abilityCX(ABILITY_DEFS.indexOf(def)),
          ABILITY_CY, def.color, false, t === type, def.type);
      }
    });

    // ── Wave button ─────────────────────────────────────────────────────────
    this.waveBg  = scene.add.graphics().setScrollFactor(0).setDepth(D + 1);
    this.waveLabel = scene.add.text(WAVE_CX, ABILITY_CY - 10, '▶▶ SEND\nNEXT WAVE', {
      fontSize: '13px', fontFamily: 'monospace', color: '#44ff88', align: 'center', lineSpacing: 2,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 2);
    this.drawWaveBtn(false);

    const waveHit = scene.add.rectangle(WAVE_CX, ABILITY_CY, WAVE_W - 8, WAVE_H, 0, 0)
      .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 3);
    waveHit.on('pointerover', () => this.drawWaveBtn(true));
    waveHit.on('pointerout',  () => this.drawWaveBtn(false));
    waveHit.on('pointerup',   () => this.onSendWave?.());

    // Listen for gold changes to refresh affordability on build & upgrade buttons
    scene.events.on('gold_changed', () => {
      this.refreshBuildAffordability();
      if (this.upgRoot.visible && this.currentUpgradeTower) {
        this.showUpgradeMode(this.currentUpgradeTower);
      }
    });
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
      ...this.upgBtnList.flatMap(b => [b.bg, b.txt, b.hit]),
    ];
    for (const abtn of this.abilityObjs.values()) {
      objects.push(abtn.bg, abtn.icon, abtn.cdOvl, abtn.cdTxt, abtn.lbl, abtn.keyTxt, abtn.cost);
    }
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
      this.drawTowerBtn(this.buildBgs[i], towerCX(i), TOWER_CY, TBW, TBH, def.color, false, false, can);
    });
  }

  update() {
    // Update ability cooldowns
    for (const [type, obj] of this.abilityObjs) {
      const cd  = this.abilitySys.getCooldown(type);
      const def = ABILITY_DEFS.find(d => d.type === type)!;
      const i   = ABILITY_DEFS.indexOf(def);
      const cx  = abilityCX(i);
      obj.cdOvl.clear();
      if (cd.remaining > 0) {
        const frac = cd.remaining / cd.total;
        obj.cdOvl.fillStyle(0x000000, 0.65 * frac);
        obj.cdOvl.fillRoundedRect(cx - ABW / 2 + 2, ABILITY_CY - ABH / 2 + 2, ABW - 4, (ABH - 4) * frac, 4);
        obj.cdTxt.setText(`${Math.ceil(cd.remaining / 1000)}s`);
      } else {
        obj.cdTxt.setText('');
      }
    }
    // Refresh affordability periodically
    this.refreshBuildAffordability();
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  private setBuildVisible(vis: boolean) {
    [...this.buildBgs, ...this.buildIcons, ...this.buildNames, ...this.buildCosts, ...this.buildHits]
      .forEach(o => o.setVisible(vis));
  }

  private rebuildUpgradeSection(tower: Tower) {
    // Clear previous
    this.upgRoot.removeAll(true);
    this.upgBtnList = [];

    const def  = tower.def;
    const CY   = ABILITY_CY;

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
    const actions: Array<{ label: string; color: number; cb: () => void; enabled: boolean }> = [];

    if (tower.canUpgrade()) {
      const cost = tower.upgradeCost();
      const tier = tower.def.upgrades[tower.level - 1];
      actions.push({
        label: `⬆ Upgrade\n${tier.label}  ${cost}g`,
        color: this.economy.canAfford(cost) ? 0x1e5a3a : 0x333333,
        enabled: this.economy.canAfford(cost),
        cb: () => { this.onUpgrade?.(); this.showUpgradeMode(tower); },
      });
    }

    if (tower.canEvolve()) {
      for (let b = 0; b < 2; b++) {
        const evo = def.evolutions[b];
        const can = this.economy.canAfford(evo.cost);
        actions.push({
          label: `★ ${evo.label}\n${evo.cost}g`,
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

  private drawAbilityBtn(bg: Phaser.GameObjects.Graphics, icon: Phaser.GameObjects.Graphics,
    cx: number, cy: number, color: number, hover: boolean, selected: boolean, type: AbilityType) {
    bg.clear();
    const fill = selected ? 0x2a4a6a : hover ? COLORS.BTN_HOVER : COLORS.BTN_NORMAL;
    bg.fillStyle(fill, 1);
    bg.fillRoundedRect(cx - ABW / 2, cy - ABH / 2, ABW, ABH, 5);
    bg.lineStyle(selected ? 3 : 1, color, selected ? 1 : 0.5);
    bg.strokeRoundedRect(cx - ABW / 2, cy - ABH / 2, ABW, ABH, 5);

    // Draw icon
    icon.clear();
    this.drawAbilityIcon(icon, cx, cy - 10, color, type);
  }

  private drawAbilityIcon(g: Phaser.GameObjects.Graphics, cx: number, cy: number, color: number, type: AbilityType) {
    g.fillStyle(color, 0.9);
    g.lineStyle(1.5, 0xffffff, 0.4);
    const r = 12;
    switch (type) {
      case 'freeze': {
        // Snowflake
        for (let a = 0; a < 6; a++) {
          const angle = (a * Math.PI) / 3;
          g.lineBetween(cx, cy, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
          // Side tines
          const mx = cx + Math.cos(angle) * r * 0.6;
          const my = cy + Math.sin(angle) * r * 0.6;
          g.lineBetween(mx, my, mx + Math.cos(angle + 1) * r * 0.3, my + Math.sin(angle + 1) * r * 0.3);
        }
        g.fillCircle(cx, cy, 3);
        break;
      }
      case 'meteor': {
        // Fireball with tail
        const ax = Math.PI * 0.75;
        g.fillTriangle(
          cx + Math.cos(ax) * r * 1.4, cy + Math.sin(ax) * r * 1.4,
          cx + Math.cos(ax + 2.4) * r * 0.5, cy + Math.sin(ax + 2.4) * r * 0.5,
          cx + Math.cos(ax - 2.4) * r * 0.5, cy + Math.sin(ax - 2.4) * r * 0.5,
        );
        g.fillStyle(0xffcc44, 0.9);
        g.fillCircle(cx, cy, r * 0.55);
        g.fillStyle(0xffffff, 0.5);
        g.fillCircle(cx - 3, cy - 3, r * 0.2);
        break;
      }
      case 'lightning_storm': {
        // Jagged lightning bolt
        const pts = [
          { x: cx + 4, y: cy - r }, { x: cx - 2, y: cy - 3 },
          { x: cx + 3, y: cy - 3 }, { x: cx - 5, y: cy + r },
          { x: cx + 1, y: cy + 2 }, { x: cx - 3, y: cy + 2 },
        ];
        g.fillPoints(pts, true);
        g.fillStyle(0xffffff, 0.4);
        g.fillTriangle(cx + 4, cy - r, cx - 2, cy - 3, cx + 1, cy - 4);
        break;
      }
      case 'heal_aura': {
        // Hourglass / temporal rift
        g.strokeCircle(cx, cy, r);
        g.lineStyle(2, color, 0.7);
        g.lineBetween(cx - r * 0.7, cy - r * 0.7, cx + r * 0.7, cy + r * 0.7);
        g.lineBetween(cx + r * 0.7, cy - r * 0.7, cx - r * 0.7, cy + r * 0.7);
        // Inner glow
        g.fillStyle(color, 0.3);
        g.fillCircle(cx, cy, r * 0.5);
        // Clock hands
        g.lineStyle(2, 0xffffff, 0.8);
        g.lineBetween(cx, cy, cx + r * 0.5, cy - r * 0.3);
        g.lineBetween(cx, cy, cx, cy + r * 0.6);
        break;
      }
    }
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
    this.waveBg.fillRoundedRect(WAVE_CX - WAVE_W / 2, ABILITY_CY - WAVE_H / 2, WAVE_W, WAVE_H, 8);
    this.waveBg.lineStyle(2, 0x44ff88, 0.7);
    this.waveBg.strokeRoundedRect(WAVE_CX - WAVE_W / 2, ABILITY_CY - WAVE_H / 2, WAVE_W, WAVE_H, 8);
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

interface ABtn {
  bg:    Phaser.GameObjects.Graphics;
  icon:  Phaser.GameObjects.Graphics;
  cdOvl: Phaser.GameObjects.Graphics;
  cdTxt: Phaser.GameObjects.Text;
  lbl:   Phaser.GameObjects.Text;
  keyTxt: Phaser.GameObjects.Text;
  cost:  Phaser.GameObjects.Text;
}
