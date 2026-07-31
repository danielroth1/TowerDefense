import Phaser from 'phaser';
import {
  STARTING_GOLD, STARTING_LIVES,
} from '../utils/constants';

export class EconomyManager {
  private scene: Phaser.Scene;
  gold: number;
  lives: number;
  totalEarned: number = 0;
  totalSpent: number = 0;

  /** Income earned from economy buildings (farms, markets, etc.). */
  incomeFromEconomy: number = 0;
  /** Income earned from killing monsters. */
  incomeFromKills: number = 0;

  constructor(scene: Phaser.Scene, startingGold?: number) {
    this.scene = scene;
    this.gold  = startingGold ?? STARTING_GOLD;
    this.lives = STARTING_LIVES;
  }

  earn(amount: number) {
    this.gold += amount;
    this.totalEarned += amount;
    this.scene.events.emit('gold_changed', this.gold);
  }

  /** Earn gold from economy buildings. */
  earnFromEconomy(amount: number) {
    this.incomeFromEconomy += amount;
    this.earn(amount);
  }

  /** Earn gold from killing monsters. */
  earnFromKills(amount: number) {
    this.incomeFromKills += amount;
    this.earn(amount);
  }

  spend(amount: number): boolean {
    if (this.gold < amount) return false;
    this.gold -= amount;
    this.totalSpent += amount;
    this.scene.events.emit('gold_changed', this.gold);
    return true;
  }

  canAfford(amount: number): boolean {
    return this.gold >= amount;
  }

  loseLife(n = 1) {
    this.lives = Math.max(0, this.lives - n);
    this.scene.events.emit('lives_changed', this.lives);
    if (this.lives <= 0) this.scene.events.emit('game_over');
  }

  /** No-op: passive time-based income removed. */
  update(_delta: number) {}
}
