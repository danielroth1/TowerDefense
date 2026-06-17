import Phaser from 'phaser';
import type { Tower } from '../entities/Tower';
import { getSynergy } from '../data/synergies';
import { GRID_COLS, GRID_ROWS } from '../utils/constants';

export class SynergySystem {
  /** Grid of placed towers: [row][col] → Tower | null */
  private towerGrid: (Tower | null)[][];
  private synergyLines: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.towerGrid = Array.from({ length: GRID_ROWS }, () => new Array(GRID_COLS).fill(null));
    this.synergyLines = scene.add.graphics().setDepth(1);
  }

  /** The synergy lines graphics object – must be ignored on the UI camera. */
  getLines(): Phaser.GameObjects.Graphics { return this.synergyLines; }

  /** Call when a tower is placed or upgraded */
  register(tower: Tower, col: number, row: number) {
    this.towerGrid[row][col] = tower;
    this.recalculate();
  }

  /** Call when a tower is sold/removed */
  unregister(col: number, row: number) {
    this.towerGrid[row][col] = null;
    this.recalculate();
  }

  private recalculate() {
    // Clear all synergy effects first
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const t = this.towerGrid[r][c];
        if (t) { t.synergyEffects = []; }
      }
    }

    // Check each tower's 8-neighbors
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tA = this.towerGrid[r][c];
        if (!tA) continue;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
            const tB = this.towerGrid[nr][nc];
            if (!tB) continue;
            const syn = getSynergy(tA.towerType, tB.towerType);
            if (syn) tA.synergyEffects.push(syn.effect);
          }
        }
        tA.applySynergies();
      }
    }

    this.drawLines();
  }

  private drawLines() {
    this.synergyLines.clear();

    const drawn = new Set<string>();
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tA = this.towerGrid[r][c];
        if (!tA) continue;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
            const tB = this.towerGrid[nr][nc];
            if (!tB) continue;
            const key = [r * GRID_COLS + c, nr * GRID_COLS + nc].sort().join(',');
            if (drawn.has(key)) continue;
            drawn.add(key);
            const syn = getSynergy(tA.towerType, tB.towerType);
            if (!syn) continue;
            this.synergyLines.lineStyle(2, syn.color, 0.6);
            this.synergyLines.lineBetween(tA.x, tA.y, tB.x, tB.y);
          }
        }
      }
    }
  }

  getTowerAt(col: number, row: number): Tower | null {
    return this.towerGrid[row]?.[col] ?? null;
  }
}
