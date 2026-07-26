import Phaser from 'phaser';
import type { EconomyBuildingType, EconomyBuildingDef, EconomyUpgradeTier } from '../data/economy';
import { ECO_BUILDING_DEFS } from '../data/economy';
import { TILE_SIZE } from '../utils/constants';

export class EconomyBuilding extends Phaser.GameObjects.Container {
  readonly buildingType: EconomyBuildingType;
  level: number = 1;
  totalSpent: number = 0;

  // Grid position (top-left cell)
  readonly gridRow: number;
  readonly gridCol: number;

  // Production state
  cycleTimer: number = 0;
  /** Current inventory count (goods waiting for transport). */
  inventory: number = 0;
  /** Max inventory before production stalls. */
  maxInventory: number = 3;

  // Visual
  private sprite: Phaser.GameObjects.Image | null = null;
  private levelLabel: Phaser.GameObjects.Text | null = null;

  get def(): EconomyBuildingDef { return ECO_BUILDING_DEFS[this.buildingType]; }

  get cycleTime(): number {
    if (this.level === 1) return this.def.baseCycleTime;
    return this.def.upgrades[this.level - 2].cycleTime;
  }

  get valueMultiplier(): number {
    if (this.level === 1) return 1.0;
    return this.def.upgrades[this.level - 2].valueMultiplier ?? 1.0;
  }

  /** Pixel center of the building. */
  get pixelX(): number {
    return (this.gridCol + this.def.width / 2) * TILE_SIZE;
  }
  get pixelY(): number {
    return (this.gridRow + this.def.height / 2) * TILE_SIZE;
  }

  constructor(
    scene: Phaser.Scene,
    gridCol: number,
    gridRow: number,
    type: EconomyBuildingType,
  ) {
    const cx = (gridCol + ECO_BUILDING_DEFS[type].width / 2) * TILE_SIZE;
    const cy = (gridRow + ECO_BUILDING_DEFS[type].height / 2) * TILE_SIZE;
    super(scene, cx, cy);

    this.buildingType = type;
    this.gridRow = gridRow;
    this.gridCol = gridCol;
    this.totalSpent = this.def.baseCost;

    scene.add.existing(this);
    this.setDepth(0.3); // Above terrain, below towers
    this.redraw();
  }

  // ─── Visual ─────────────────────────────────────────────────────────────

  redraw() {
    this.removeAll(true);

    const texKey = this.def.textureKey;
    const displayW = this.def.width * TILE_SIZE * 0.9;
    const displayH = this.def.height * TILE_SIZE * 0.9;

    if (this.scene.textures.exists(texKey)) {
      this.sprite = this.scene.add.image(0, 0, texKey);
      this.sprite.setDisplaySize(displayW, displayH);
      this.add(this.sprite);
    } else {
      // Procedural fallback — colored rectangle
      const g = this.scene.add.graphics();
      g.fillStyle(this.def.color, 0.85);
      g.fillRoundedRect(-displayW / 2, -displayH / 2, displayW, displayH, 4);
      g.lineStyle(1, 0xffffff, 0.3);
      g.strokeRoundedRect(-displayW / 2, -displayH / 2, displayW, displayH, 4);
      this.add(g);
    }

    // Level indicator
    if (this.level > 1) {
      this.levelLabel = this.scene.add.text(
        displayW / 2 - 4, -displayH / 2 - 2,
        `${this.level}`,
        { fontSize: '10px', fontFamily: 'monospace', color: '#ffd700' },
      ).setOrigin(1, 1);
      this.add(this.levelLabel);
    }

    // Inventory indicator — colored dots below building
    if (this.inventory > 0 && this.def.produces) {
      const dotColors: Record<string, number> = {
        wheat: 0xd4a843, flour: 0xeee8d5, bread: 0xc89a5c, fish: 0x6699cc,
      };
      const color = dotColors[this.def.produces] ?? 0xffffff;
      for (let i = 0; i < Math.min(this.inventory, this.maxInventory); i++) {
        const dot = this.scene.add.graphics();
        dot.fillStyle(color, 1);
        dot.fillCircle(
          -((this.inventory - 1) * 6) / 2 + i * 6,
          displayH / 2 + 5,
          2,
        );
        this.add(dot);
      }
    }
  }

  // ─── Upgrade ────────────────────────────────────────────────────────────

  canUpgrade(): boolean {
    return this.level < 3;
  }

  upgradeCost(): number {
    if (!this.canUpgrade()) return Infinity;
    return this.def.upgrades[this.level - 1].cost;
  }

  upgrade(): EconomyUpgradeTier {
    const tier = this.def.upgrades[this.level - 1];
    this.totalSpent += tier.cost;
    this.level++;
    this.redraw();
    return tier;
  }
}
