import Phaser from 'phaser';
import {
  STARTING_GOLD, STARTING_LIVES,
  PASSIVE_INCOME_INTERVAL, PASSIVE_INCOME_AMOUNT,
} from '../utils/constants';

export class EconomyManager {
  private scene: Phaser.Scene;
  gold: number;
  lives: number;
  totalEarned: number = 0;
  totalSpent: number = 0;
  private passiveTimer: number = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.gold  = STARTING_GOLD;
    this.lives = STARTING_LIVES;
  }

  earn(amount: number) {
    this.gold += amount;
    this.totalEarned += amount;
    this.scene.events.emit('gold_changed', this.gold);
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

  update(delta: number) {
    this.passiveTimer += delta;
    if (this.passiveTimer >= PASSIVE_INCOME_INTERVAL) {
      this.passiveTimer -= PASSIVE_INCOME_INTERVAL;
      this.earn(PASSIVE_INCOME_AMOUNT);
    }
  }
}
