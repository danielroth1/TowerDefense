import Phaser from 'phaser';
import { ABILITY_DEFS, type AbilityType } from '../data/abilities';
import { COLORS, GAME_HEIGHT, GAME_WIDTH } from '../utils/constants';
import type { AbilitySystem } from '../systems/AbilitySystem';

const BAR_Y    = GAME_HEIGHT - 40;
const BTN_W    = 56;
const BTN_H    = 56;
const BTN_GAP  = 8;
const START_X  = GAME_WIDTH / 2 - ((BTN_W + BTN_GAP) * ABILITY_DEFS.length) / 2 + BTN_W / 2;

export class AbilityBar {
  private sys: AbilitySystem;
  private buttons: Map<AbilityType, AbilityButton> = new Map();

  constructor(scene: Phaser.Scene, sys: AbilitySystem) {
    this.sys   = sys;

    ABILITY_DEFS.forEach((def, i) => {
      const x = START_X + i * (BTN_W + BTN_GAP);
      const btn = new AbilityButton(scene, x, BAR_Y, def.type, def.label, def.hotkey, def.color, def.cost);
      this.buttons.set(def.type, btn);
      btn.container.on('click', () => sys.selectAbility(def.type));
    });

    scene.events.on('ability_selected', (type: AbilityType | null) => this.onSelected(type));
  }

  update() {
    for (const [type, btn] of this.buttons) {
      const cd = this.sys.getCooldown(type);
      btn.setCooldown(cd.remaining, cd.total);
      btn.setSelected(this.sys.pendingCast === type);
    }
  }

  private onSelected(type: AbilityType | null) {
    for (const [t, btn] of this.buttons) {
      btn.setSelected(t === type);
    }
  }
}

class AbilityButton {
  container: Phaser.GameObjects.Container;
  private bg:        Phaser.GameObjects.Graphics;
  private cdOverlay: Phaser.GameObjects.Graphics;
  private label:     Phaser.GameObjects.Text;
  private hotkey:    Phaser.GameObjects.Text;
  private costText:  Phaser.GameObjects.Text;
  private cdText:    Phaser.GameObjects.Text;
  private selected:  boolean = false;
  private baseColor: number;

  constructor(
    scene: Phaser.Scene,
    x: number, y: number,
    _type: AbilityType,
    label: string,
    hotkey: string,
    color: number,
    cost: number,
  ) {
    this.baseColor = color;
    this.bg        = scene.add.graphics();
    this.cdOverlay = scene.add.graphics();
    this.label     = scene.add.text(0, -10, label.split(' ')[0], {
      fontSize: '10px', fontFamily: 'monospace', color: '#eef0f4', align: 'center',
    }).setOrigin(0.5);
    this.hotkey    = scene.add.text(-BTN_W / 2 + 5, -BTN_H / 2 + 4, hotkey, {
      fontSize: '11px', fontFamily: 'monospace', color: '#ffd700',
    });
    this.costText  = scene.add.text(0, 10, `${cost}g`, {
      fontSize: '10px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
    }).setOrigin(0.5);
    this.cdText    = scene.add.text(0, 0, '', {
      fontSize: '16px', fontFamily: 'monospace', color: '#ffffff', align: 'center',
    }).setOrigin(0.5).setDepth(1);

    this.container = scene.add.container(x, y, [
      this.bg, this.cdOverlay, this.label, this.hotkey, this.costText, this.cdText,
    ]);
    this.container.setDepth(30).setScrollFactor(0);
    this.drawBg(color, false);

    // Hit rect must also be screen-fixed
    const hit = scene.add.rectangle(x, y, BTN_W, BTN_H, 0, 0)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true })
      .setDepth(31);
    hit.on('pointerup',    () => this.container.emit('click'));
    hit.on('pointerover',  () => this.drawBg(color, true));
    hit.on('pointerout',   () => this.drawBg(color, this.selected));
  }

  private drawBg(color: number, hover: boolean) {
    this.bg.clear();
    this.bg.fillStyle(hover ? COLORS.BTN_HOVER : COLORS.BTN_NORMAL, 1);
    this.bg.fillRoundedRect(-BTN_W / 2, -BTN_H / 2, BTN_W, BTN_H, 6);
    this.bg.lineStyle(2, color, this.selected ? 1 : 0.4);
    this.bg.strokeRoundedRect(-BTN_W / 2, -BTN_H / 2, BTN_W, BTN_H, 6);
  }

  setSelected(sel: boolean) {
    this.selected = sel;
    this.bg.clear();
    const col = sel ? 0x2a5080 : COLORS.BTN_NORMAL;
    this.bg.fillStyle(col, 1);
    this.bg.fillRoundedRect(-BTN_W / 2, -BTN_H / 2, BTN_W, BTN_H, 6);
    this.bg.lineStyle(2, sel ? 0x88ccff : this.baseColor, sel ? 1 : 0.4);
    this.bg.strokeRoundedRect(-BTN_W / 2, -BTN_H / 2, BTN_W, BTN_H, 6);
  }

  setCooldown(remaining: number, total: number) {
    this.cdOverlay.clear();
    if (remaining <= 0) {
      this.cdText.setText('');
      return;
    }
    const frac = remaining / total;
    this.cdOverlay.fillStyle(0x000000, 0.65);
    this.cdOverlay.fillRoundedRect(-BTN_W / 2, -BTN_H / 2, BTN_W, BTN_H * frac, 6);
    this.cdText.setText(`${Math.ceil(remaining / 1000)}s`);
  }
}
