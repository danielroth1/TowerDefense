import Phaser from 'phaser';
import { BootScene }     from './scenes/BootScene';
import { MenuScene }     from './scenes/MenuScene';
import { GameScene }     from './scenes/GameScene';
import { GameOverScene } from './scenes/GameOverScene';
import {
  GAME_WIDTH, GAME_HEIGHT,
  UI_TOP_HEIGHT, UI_BOTTOM_HEIGHT,
} from './utils/constants';

// ── Text factory: auto-inject devicePixelRatio for crisp text on Retina ────
// (Text renders on its own internal canvas — this resolution hint is
//  independent of the main game canvas resolution.)
(() => {
  const origText = (Phaser.GameObjects.GameObjectFactory.prototype as any).text;
  (Phaser.GameObjects.GameObjectFactory.prototype as any).text = function (
    this: Phaser.GameObjects.GameObjectFactory,
    x: number, y: number, text: string, style?: Record<string, any>,
  ) {
    const dpr = window.devicePixelRatio || 1;
    style = Object.assign({}, style || {});
    if (!style.resolution) style.resolution = dpr;
    return origText.call(this, x, y, text, style);
  };
})();

// ── Game config ──────────────────────────────────────────────────────────────
const GAME_TOTAL_HEIGHT = GAME_HEIGHT + UI_TOP_HEIGHT + UI_BOTTOM_HEIGHT;

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_TOTAL_HEIGHT,
  backgroundColor: '#0a0a0f',
  parent: document.body,
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },
      debug: false,
    },
  },
  scene: [BootScene, MenuScene, GameScene, GameOverScene],
  render: {
    antialias: true,
    pixelArt: false,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
};

const game = new Phaser.Game(config);

// Expose for debugging/testing
(window as any).__game = game;
