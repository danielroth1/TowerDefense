import Phaser from 'phaser';
import { WEATHER_CHANGE_INTERVAL, GAME_WIDTH, GAME_HEIGHT } from '../utils/constants';

export type WeatherState = 'sunny' | 'rain' | 'wind' | 'eclipse';

export interface WeatherModifiers {
  fireDamageMult: number;
  poisonTickMult: number;
  flyerSpeedMult: number;
  groundSpeedMult: number;
  towerRangeMult: number;
  goldEarnMult: number;
}

const WEATHER_MODS: Record<WeatherState, WeatherModifiers> = {
  sunny:  { fireDamageMult: 1,    poisonTickMult: 1,    flyerSpeedMult: 1,    groundSpeedMult: 1,    towerRangeMult: 1,    goldEarnMult: 1   },
  rain:   { fireDamageMult: 0.7,  poisonTickMult: 1.4,  flyerSpeedMult: 0.85, groundSpeedMult: 1,    towerRangeMult: 1,    goldEarnMult: 1   },
  wind:   { fireDamageMult: 1,    poisonTickMult: 1,    flyerSpeedMult: 1.35, groundSpeedMult: 0.9,  towerRangeMult: 0.9,  goldEarnMult: 1   },
  eclipse:{ fireDamageMult: 1.1,  poisonTickMult: 1,    flyerSpeedMult: 1,    groundSpeedMult: 1,    towerRangeMult: 0.75, goldEarnMult: 1.4 },
};

const WEATHER_SEQUENCE: WeatherState[] = ['sunny', 'rain', 'wind', 'eclipse'];

export class WeatherSystem {
  private scene: Phaser.Scene;
  current: WeatherState = 'sunny';
  mods: WeatherModifiers = { ...WEATHER_MODS.sunny };
  countdown: number;
  private overlay: Phaser.GameObjects.Graphics;
  private particles: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private stateIndex: number = 0;
  // Announcement banner
  private banner: Phaser.GameObjects.Container | null = null;
  /** UI group for dual-camera setup – weather FX render on UI camera */
  private uiGroup: Phaser.GameObjects.Group | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene   = scene;
    this.countdown = WEATHER_CHANGE_INTERVAL;
    // Screen-fixed overlay (scrollFactor 0 = stays put when camera scrolls)
    this.overlay = scene.add.graphics()
      .setDepth(20)
      .setScrollFactor(0)
      .setAlpha(0);
  }

  /** Register this system's visual objects with the UI group so the main
   *  camera ignores them (dual-camera setup). */
  setUIGroup(group: Phaser.GameObjects.Group) {
    this.uiGroup = group;
    group.add(this.overlay);
    if (this.particles) group.add(this.particles);
    if (this.banner)    group.add(this.banner);
  }

  update(delta: number) {
    this.countdown -= delta;
    if (this.countdown <= 0) {
      this.countdown = WEATHER_CHANGE_INTERVAL;
      this.advance();
    }
  }

  private advance() {
    this.stateIndex = (this.stateIndex + 1) % WEATHER_SEQUENCE.length;
    this.transition(WEATHER_SEQUENCE[this.stateIndex]);
  }

  private transition(next: WeatherState) {
    const prev = this.current;
    this.current = next;
    this.mods = { ...WEATHER_MODS[next] };
    this.scene.events.emit('weather_changed', next, prev);
    this.updateVisuals(next);
    this.showBanner(next);
  }

  private updateVisuals(state: WeatherState) {
    // Clean up previous particles
    this.particles?.destroy();
    this.particles = null;
    this.overlay.clear();
    this.overlay.setAlpha(1);

    const W = GAME_WIDTH;
    const H = GAME_HEIGHT;

    // Helper to add to UI group if set
    const reg = (obj: Phaser.GameObjects.GameObject) => {
      if (this.uiGroup) this.uiGroup.add(obj);
    };

    switch (state) {
      case 'rain': {
        // Blue tint overlay across full screen
        this.overlay.fillStyle(0x1133aa, 0.12);
        this.overlay.fillRect(0, 0, W, H);
        // Horizontal streaks for rain feel
        this.overlay.lineStyle(1, 0x5599ff, 0.06);
        for (let y = 0; y < H; y += 18) {
          this.overlay.lineBetween(0, y, W, y);
        }
        // Rain particles – screen fixed
        this.particles = this.scene.add.particles(0, -10, 'particle_ice', {
          x: { min: 0, max: W },
          y: { min: -10, max: -5 },
          speedX: { min: 15, max: 40 },
          speedY: { min: 280, max: 420 },
          lifespan: { min: 800, max: 1400 },
          scale: { start: 0.35, end: 0.05 },
          alpha: { start: 0.7, end: 0 },
          quantity: 3,
          frequency: 15,
        }).setScrollFactor(0).setDepth(22);
        reg(this.particles);
        break;
      }

      case 'wind': {
        this.overlay.fillStyle(0x88aabb, 0.06);
        this.overlay.fillRect(0, 0, W, H);
        // Diagonal sweep lines
        this.overlay.lineStyle(1, 0xaabbcc, 0.08);
        for (let x = -H; x < W + H; x += 40) {
          this.overlay.lineBetween(x, 0, x + H, H);
        }
        // Wind streak particles
        this.particles = this.scene.add.particles(-20, 0, 'particle_smoke', {
          x: { min: -30, max: -10 },
          y: { min: 0, max: H },
          speedX: { min: 220, max: 380 },
          speedY: { min: -30, max: 30 },
          lifespan: { min: 600, max: 1200 },
          scale: { start: 0.25, end: 0.04 },
          alpha: { start: 0.35, end: 0 },
          quantity: 1,
          frequency: 40,
        }).setScrollFactor(0).setDepth(22);
        reg(this.particles);
        break;
      }

      case 'eclipse': {
        // Dark purple vignette
        this.overlay.fillStyle(0x220033, 0.22);
        this.overlay.fillRect(0, 0, W, H);
        // Vignette edge darkening
        this.overlay.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0.3, 0.3, 0, 0);
        this.overlay.fillRect(0, 0, W / 3, H);
        this.overlay.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0, 0, 0.3, 0.3);
        this.overlay.fillRect(W * 2 / 3, 0, W / 3, H);
        // Purple particle dust
        this.particles = this.scene.add.particles(W / 2, H / 2, 'particle_star', {
          x: { min: -W / 2, max: W / 2 },
          y: { min: -H / 2, max: H / 2 },
          speedX: { min: -20, max: 20 },
          speedY: { min: -20, max: 20 },
          lifespan: { min: 2000, max: 4000 },
          scale: { start: 0.4, end: 0 },
          alpha: { start: 0.5, end: 0 },
          tint: 0xaa44ff,
          quantity: 1,
          frequency: 200,
        }).setScrollFactor(0).setDepth(21);
        reg(this.particles);
        break;
      }

      case 'sunny':
      default:
        this.overlay.setAlpha(0);
        break;
    }
  }

  private showBanner(state: WeatherState) {
    this.banner?.destroy();
    const labels: Record<WeatherState, string> = {
      sunny: '☀  SUNNY  — Normal conditions',
      rain:  '🌧  RAIN  — Fire –30% | Poison +40%',
      wind:  '💨  WIND  — Flyers +35% speed | Range –10%',
      eclipse: '🌑  ECLIPSE  — Range –25% | Gold ×1.4',
    };
    const colors: Record<WeatherState, number> = {
      sunny: 0xffffaa, rain: 0x88aaff, wind: 0xaabbcc, eclipse: 0xaa88ff,
    };
    const W = GAME_WIDTH;
    const bg  = this.scene.add.graphics();
    bg.fillStyle(0x000000, 0.7);
    bg.fillRoundedRect(-200, -18, 400, 36, 6);
    bg.lineStyle(2, colors[state], 0.8);
    bg.strokeRoundedRect(-200, -18, 400, 36, 6);
    const txt = this.scene.add.text(0, 0, labels[state], {
      fontSize: '14px', fontFamily: 'monospace',
      color: `#${colors[state].toString(16).padStart(6, '0')}`,
      align: 'center',
    }).setOrigin(0.5);
    this.banner = this.scene.add.container(W / 2, 58, [bg, txt])
      .setDepth(55)
      .setScrollFactor(0)
      .setAlpha(0);
    if (this.uiGroup) this.uiGroup.add(this.banner);
    this.scene.tweens.add({
      targets: this.banner, alpha: 1, duration: 400,
      onComplete: () => {
        this.scene.time.delayedCall(3000, () => {
          if (this.banner?.active) {
            this.scene.tweens.add({ targets: this.banner, alpha: 0, duration: 500,
              onComplete: () => { this.banner?.destroy(); this.banner = null; } });
          }
        });
      },
    });
  }

  destroy() {
    this.particles?.destroy();
    this.overlay.destroy();
    this.banner?.destroy();
  }
}


