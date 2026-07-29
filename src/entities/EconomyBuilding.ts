import Phaser from 'phaser';
import type { EconomyBuildingType, EconomyBuildingDef, EconomyUpgradeTier } from '../data/economy';
import { ECO_BUILDING_DEFS, WAREHOUSE_CAPACITY } from '../data/economy';
import { TILE_SIZE, SELL_REFUND_RATIO } from '../utils/constants';

export class EconomyBuilding extends Phaser.GameObjects.Container {
  readonly buildingType: EconomyBuildingType;
  level: number = 1;
  totalSpent: number = 0;

  /**
   * Semantic rotation in degrees (0, 90, 180, 270).
   * For straddle buildings: 0 = land-left/water-right, 180 = water-left/land-right,
   * 90 = land-top/water-bottom, 270 = water-top/land-bottom.
   */
  rotationDeg: number = 0;

  // Grid position (top-left cell)
  readonly gridRow: number;
  readonly gridCol: number;

  // Production state
  cycleTimer: number = 0;
  /** Current inventory count (goods waiting for transport). */
  inventory: number = 0;
  /** Max inventory before production stalls. */
  maxInventory: number = 3;
  /** Input stock — consumed resource waiting to be processed (e.g. wheat in a mill). */
  inputStock: number = 0;
  /** Goods in transit to this building's inputStock (reserved by outgoing cart). */
  reservedInput: number = 0;
  /** Goods in transit to this building's inventory (reserved by outgoing cart, warehouses only). */
  reservedInventory: number = 0;

  // Visual
  private sprite: Phaser.GameObjects.Image | null = null;
  private selected: boolean = false;
  private rangeCircle: Phaser.GameObjects.Graphics | null = null;

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
    rotationDeg: number = 0,
  ) {
    const cx = (gridCol + ECO_BUILDING_DEFS[type].width / 2) * TILE_SIZE;
    const cy = (gridRow + ECO_BUILDING_DEFS[type].height / 2) * TILE_SIZE;
    super(scene, cx, cy);

    this.buildingType = type;
    this.gridRow = gridRow;
    this.gridCol = gridCol;
    this.rotationDeg = rotationDeg;
    this.totalSpent = this.def.baseCost;
    if (this.def.isStorage) this.maxInventory = WAREHOUSE_CAPACITY;

    scene.add.existing(this);
    this.setDepth(0.3); // Above terrain, below towers
    this.redraw();
  }

  // ─── Visual ─────────────────────────────────────────────────────────────

  redraw() {
    this.removeAll(true);

    // Use upgrade variant texture if available (eco_{type}_1, eco_{type}_2)
    let texKey = this.def.textureKey;
    if (this.level > 1) {
      const variantKey = `${this.def.textureKey}_${this.level - 1}`;
      if (this.scene.textures.exists(variantKey)) {
        texKey = variantKey;
      }
    }

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

    // Inventory indicator — colored dots below building
    if ((this.inventory > 0 || this.inputStock > 0) && (this.def.produces || this.def.isStorage || this.def.isEndpoint)) {
      const dotColors: Record<string, number> = {
        wheat: 0xd4a843, flour: 0xeee8d5, bread: 0xc89a5c, fish: 0x6699cc,
      };
      const color = dotColors[this.def.produces ?? 'wheat'] ?? 0xffffff;
      const inputColor = dotColors[this.def.consumes ?? 'wheat'] ?? 0x888888;

      if (this.def.isStorage) {
        // Warehouse: show fill level bar on the right side
        const barW = 4, barH = displayH * 0.7;
        const barX = displayW / 2 + 3, barY = -barH / 2;
        const fillPct = this.inventory / this.maxInventory;

        // Background
        const barBg = this.scene.add.graphics();
        barBg.fillStyle(0x333333, 0.6);
        barBg.fillRect(barX, barY, barW, barH);
        this.add(barBg);

        // Fill
        const barFill = this.scene.add.graphics();
        barFill.fillStyle(color, 0.9);
        barFill.fillRect(barX, barY + barH * (1 - fillPct), barW, barH * fillPct);
        this.add(barFill);

        // Border
        const barBorder = this.scene.add.graphics();
        barBorder.lineStyle(1, 0xffffff, 0.3);
        barBorder.strokeRect(barX, barY, barW, barH);
        this.add(barBorder);
      } else {
        // Output inventory dots (produced goods, below building)
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
        // Input stock dots (consumed goods waiting, above building)
        if (this.inputStock > 0 && this.def.consumes) {
          for (let i = 0; i < this.inputStock; i++) {
            const dot = this.scene.add.graphics();
            dot.fillStyle(inputColor, 0.7);
            dot.fillCircle(
              -((this.inputStock - 1) * 5) / 2 + i * 5,
              -displayH / 2 - 4,
              1.5,
            );
            this.add(dot);
          }
        }
      }
    }

    // Apply semantic rotation (for straddle buildings like fishery/harbor).
    this.setRotation(Phaser.Math.DegToRad(this.rotationDeg));
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
    if (tier.extraCapacity) this.maxInventory += tier.extraCapacity;
    this.redraw();
    return tier;
  }

  sellValue(): number {
    return Math.floor(this.totalSpent * SELL_REFUND_RATIO);
  }

  // ─── Selection ──────────────────────────────────────────────────────────

  showRange(show: boolean) {
    this.rangeCircle?.destroy();
    this.rangeCircle = null;
    if (!show) {
      this.selected = false;
      return;
    }
    this.selected = true;
    // Show a highlight ring around the building footprint
    const displayW = this.def.width * TILE_SIZE;
    const displayH = this.def.height * TILE_SIZE;
    this.rangeCircle = this.scene.add.graphics().setDepth(1);
    this.rangeCircle.lineStyle(2, 0x44ff88, 0.5);
    this.rangeCircle.strokeRect(-displayW / 2 - 2, -displayH / 2 - 2, displayW + 4, displayH + 4);
    this.add(this.rangeCircle);
  }

  getRangeCircle(): Phaser.GameObjects.Graphics | null {
    return this.rangeCircle;
  }

  isSelected(): boolean {
    return this.selected;
  }
}
