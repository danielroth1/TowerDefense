import Phaser from 'phaser';
import { BootScene }     from './scenes/BootScene';
import { MenuScene }     from './scenes/MenuScene';
import { GameScene }     from './scenes/GameScene';
import { GameOverScene } from './scenes/GameOverScene';

// ── Text factory: auto-inject devicePixelRatio for crisp text on Retina ────
// (Canvas backing store stays at CSS-pixel resolution; the browser handles
//  Retina upscaling. This is the correct approach for Phaser 3.60+.)
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
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
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
    mode: Phaser.Scale.RESIZE,
  },
};

const game = new Phaser.Game(config);

// Expose for debugging/testing
(window as any).__game = game;
