import Phaser from 'phaser';
import { COLORS, COMBO_MULTIPLIERS, UI_TOP_HEIGHT, UI_BOTTOM_HEIGHT } from '../utils/constants';
import type { WeatherState } from '../systems/WeatherSystem';
import { SoundSystem } from '../systems/SoundSystem';

const WEATHER_ICONS: Record<WeatherState, string> = {
  sunny: '☀', rain: '🌧', wind: '💨', eclipse: '🌑',
};
const WEATHER_LABELS: Record<WeatherState, string> = {
  sunny: 'SUNNY', rain: 'RAIN', wind: 'WIND', eclipse: 'ECLIPSE',
};

export class HUD {
  private scene: Phaser.Scene;
  private sound: SoundSystem;
  /** Root bar graphics – used for inverse zoom scaling */
  private bar: Phaser.GameObjects.Graphics;

  private goldText:    Phaser.GameObjects.Text;
  private livesText:   Phaser.GameObjects.Text;
  private waveText:    Phaser.GameObjects.Text;
  private comboText:   Phaser.GameObjects.Text;
  private weatherText: Phaser.GameObjects.Text;
  private weatherTimer:Phaser.GameObjects.Text;
  private bossBg:      Phaser.GameObjects.Graphics;
  private bossBarContainer: Phaser.GameObjects.Container;
  private bossBarFg:   Phaser.GameObjects.Graphics;
  private bossLabel:   Phaser.GameObjects.Text;
  private countdownText: Phaser.GameObjects.Text;
  private heroText:    Phaser.GameObjects.Text;
  private fpsText:     Phaser.GameObjects.Text;
  private sfxBtn:      Phaser.GameObjects.Text;
  private bgmBtn:      Phaser.GameObjects.Text;
  private pauseBtn:    Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.sound = SoundSystem.instance;
    const W = scene.scale.width, H = scene.scale.height;
    const DEPTH = 50;

    this.bar = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH);
    this.bar.fillStyle(COLORS.PANEL_BG, 0.92);
    this.bar.fillRect(0, 0, W, UI_TOP_HEIGHT);
    this.bar.lineStyle(1, COLORS.PANEL_BORDER, 1);
    this.bar.lineBetween(0, UI_TOP_HEIGHT, W, UI_TOP_HEIGHT);

    this.goldText = scene.add.text(20, 14, '$ 200', {
      fontSize: '38px', fontFamily: 'monospace', color: '#ffd700',
    }).setScrollFactor(0).setDepth(DEPTH + 1);

    this.livesText = scene.add.text(300, 14, '♥ 20', {
      fontSize: '38px', fontFamily: 'monospace', color: '#ff4444',
    }).setScrollFactor(0).setDepth(DEPTH + 1);

    this.waveText = scene.add.text(W / 2, 14, 'WAVE 0 / 50', {
      fontSize: '36px', fontFamily: 'monospace', color: '#eef0f4', align: 'center',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(DEPTH + 1);

    this.sfxBtn = scene.add.text(W - 360, 12, '🔊 SFX', {
      fontSize: '30px', fontFamily: 'monospace', color: '#88cc88',
    }).setScrollFactor(0).setDepth(DEPTH + 2).setInteractive({ useHandCursor: true });
    this.sfxBtn.on('pointerup', () => {
      const on = this.sound.toggleSFX();
      this.sfxBtn.setText(on ? '🔊 SFX' : '🔇 SFX');
      this.sfxBtn.setColor(on ? '#88cc88' : '#cc8888');
    });

    this.bgmBtn = scene.add.text(W - 135, 12, '🎵 BGM', {
      fontSize: '30px', fontFamily: 'monospace', color: '#88cc88',
    }).setScrollFactor(0).setDepth(DEPTH + 2).setInteractive({ useHandCursor: true });
    this.bgmBtn.on('pointerup', () => {
      const on = this.sound.toggleMusic();
      this.bgmBtn.setText(on ? '🎵 BGM' : '❌ BGM');
      this.bgmBtn.setColor(on ? '#88cc88' : '#cc8888');
    });

    this.pauseBtn = scene.add.text(W - 560, 12, '⏸ [P]', {
      fontSize: '30px', fontFamily: 'monospace', color: '#aabbcc',
    }).setScrollFactor(0).setDepth(DEPTH + 2).setInteractive({ useHandCursor: true });
    this.pauseBtn.on('pointerup', () => scene.events.emit('toggle_pause'));

    this.weatherText = scene.add.text(W - 980, 12, '☀ SUNNY', {
      fontSize: '30px', fontFamily: 'monospace', color: '#ffeeaa',
    }).setScrollFactor(0).setDepth(DEPTH + 1);

    this.weatherTimer = scene.add.text(W - 1130, 12, '', {
      fontSize: '26px', fontFamily: 'monospace', color: '#8899aa',
    }).setScrollFactor(0).setDepth(DEPTH + 1);

    this.comboText = scene.add.text(W - 690, 12, '×1', {
      fontSize: '32px', fontFamily: 'monospace', color: '#ffd700',
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(DEPTH + 1);

    this.countdownText = scene.add.text(W / 2, UI_TOP_HEIGHT + 12, '', {
      fontSize: '28px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(DEPTH + 1);

    this.heroText = scene.add.text(26, H - UI_BOTTOM_HEIGHT - 30, 'HERO Lv1  HP ●●●●●', {
      fontSize: '26px', fontFamily: 'monospace', color: '#ffdd44',
    }).setScrollFactor(0).setDepth(DEPTH + 1);

    this.bossBg = scene.add.graphics().setScrollFactor(0);
    this.bossBg.fillStyle(COLORS.PANEL_BG, 0.9);
    this.bossBg.fillRect(W / 2 - 440, UI_TOP_HEIGHT + 8, 880, 36);
    this.bossBg.lineStyle(1, 0xff2200, 0.8);
    this.bossBg.strokeRect(W / 2 - 440, UI_TOP_HEIGHT + 8, 880, 36);
    this.bossBarFg = scene.add.graphics().setScrollFactor(0);
    this.bossLabel = scene.add.text(W / 2, UI_TOP_HEIGHT + 26, '', {
      fontSize: '24px', fontFamily: 'monospace', color: '#ffaaaa', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0);
    this.bossBarContainer = scene.add.container(0, 0, [this.bossBg, this.bossBarFg, this.bossLabel])
      .setDepth(DEPTH + 3).setScrollFactor(0).setVisible(false);

    this.fpsText = scene.add.text(W - 14, H - UI_BOTTOM_HEIGHT - 30, '', {
      fontSize: '24px', fontFamily: 'monospace', color: '#334455',
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(DEPTH + 1);

    scene.events.on('gold_changed',   (g: number)                => this.setGold(g));
    scene.events.on('lives_changed',  (l: number)                => this.setLives(l));
    scene.events.on('wave_started',   (w: number, boss: boolean) => this.onWaveStart(w, boss));
    scene.events.on('wave_complete',  (w: number)                => this.onWaveEnd(w));
    scene.events.on('combo_updated',  (kills: number, mult: number) => this.setCombo(kills, mult));
    scene.events.on('weather_changed',(state: WeatherState)      => this.setWeather(state));
    scene.events.on('boss_hp_update', (hp: number, maxHp: number, label: string) =>
      this.setBossHP(hp, maxHp, label));
    scene.events.on('hero_levelup',   (lv: number)               => this.setHeroLevel(lv));
    scene.events.on('hero_downed',    ()                         => this.heroText.setText('HERO DOWNED'));
    scene.events.on('hero_respawned', ()                         => this.setHeroLevel(1));
  }

  /** Returns ALL game objects this HUD creates, for camera ignore lists. */
  getAllObjects(): Phaser.GameObjects.GameObject[] {
    return [
      this.bar,
      this.goldText,
      this.livesText,
      this.waveText,
      this.sfxBtn,
      this.bgmBtn,
      this.pauseBtn,
      this.weatherText,
      this.weatherTimer,
      this.comboText,
      this.countdownText,
      this.heroText,
      this.bossBarContainer,
      this.fpsText,
    ];
  }

  /** Update pause button appearance when pause state changes. */
  /** Re-layout all elements for a new screen size. */
  resize(W: number, H: number) {
    const DEPTH = 50;

    // Background bar
    this.bar.clear();
    this.bar.fillStyle(COLORS.PANEL_BG, 0.92);
    this.bar.fillRect(0, 0, W, UI_TOP_HEIGHT);
    this.bar.lineStyle(1, COLORS.PANEL_BORDER, 1);
    this.bar.lineBetween(0, UI_TOP_HEIGHT, W, UI_TOP_HEIGHT);

    this.waveText.setPosition(W / 2, 14);
    this.sfxBtn.setPosition(W - 360, 12);
    this.bgmBtn.setPosition(W - 135, 12);
    this.pauseBtn.setPosition(W - 560, 12);
    this.weatherText.setPosition(W - 980, 12);
    this.weatherTimer.setPosition(W - 1130, 12);
    this.comboText.setPosition(W - 690, 12);
    this.countdownText.setPosition(W / 2, UI_TOP_HEIGHT + 12);
    this.heroText.setPosition(26, H - UI_BOTTOM_HEIGHT - 30);
    this.fpsText.setPosition(W - 14, H - UI_BOTTOM_HEIGHT - 30);

    // Boss bar
    this.bossBg.clear();
    this.bossBg.fillStyle(COLORS.PANEL_BG, 0.9);
    this.bossBg.fillRect(W / 2 - 440, UI_TOP_HEIGHT + 8, 880, 36);
    this.bossBg.lineStyle(1, 0xff2200, 0.8);
    this.bossBg.strokeRect(W / 2 - 440, UI_TOP_HEIGHT + 8, 880, 36);
    this.bossLabel.setPosition(W / 2, UI_TOP_HEIGHT + 26);
  }

  setPaused(paused: boolean) {
    this.pauseBtn.setText(paused ? '▶ [P]' : '⏸ [P]');
    this.pauseBtn.setColor(paused ? '#ff8844' : '#aabbcc');
  }

  update(gold: number, lives: number, wave: number, totalWaves: number,
         countdown: number, weatherCountdown: number,
         heroHp: number, heroMaxHp: number, heroLevel: number) {
    this.setGold(gold);
    this.setLives(lives);
    this.waveText.setText('WAVE  ' + wave + ' / ' + totalWaves);
    if (countdown > 0) {
      this.countdownText.setText('Next wave in ' + Math.ceil(countdown / 1000) + 's  [SPACE]');
    } else {
      this.countdownText.setText('');
    }
    this.weatherTimer.setText(Math.ceil(weatherCountdown / 1000) + 's');
    this.updateHeroStatus(heroHp, heroMaxHp, heroLevel);
    this.fpsText.setText(Math.round(this.scene.game.loop.actualFps) + ' FPS');
  }

  private setGold(g: number) { this.goldText.setText('$ ' + Math.floor(g)); }
  private setLives(l: number) {
    this.livesText.setText('♥ ' + l);
    this.livesText.setColor(l <= 5 ? '#ff2222' : '#ff4444');
  }

  private onWaveStart(wave: number, isBoss: boolean) {
    this.waveText.setText('WAVE  ' + wave + ' / 50');
    if (isBoss) {
      this.waveText.setColor('#ff4444');
      this.scene.tweens.add({ targets: this.waveText, scaleX: 1.2, scaleY: 1.2, duration: 200, yoyo: true, repeat: 3 });
    } else {
      this.waveText.setColor('#eef0f4');
    }
  }

  private onWaveEnd(_wave: number) { this.bossBarContainer.setVisible(false); }

  private setCombo(kills: number, mult: number) {
    this.comboText.setText('×' + mult + (kills > 0 ? ' [' + kills + ']' : ''));
    const tier = COMBO_MULTIPLIERS.indexOf(mult as (typeof COMBO_MULTIPLIERS)[number]);
    const colors = ['#ffd700', '#ffaa00', '#ff8800', '#ff4400', '#ff0000'];
    this.comboText.setColor(colors[Math.max(0, tier)] || '#ffd700');
    if (mult > 1) {
      this.scene.tweens.add({ targets: this.comboText, scaleX: 1.15, scaleY: 1.15, duration: 100, yoyo: true });
    }
  }

  private setWeather(state: WeatherState) {
    this.weatherText.setText(WEATHER_ICONS[state] + ' ' + WEATHER_LABELS[state]);
    const col = state === 'eclipse' ? '#aa88ff' : state === 'rain' ? '#88aaff' : state === 'wind' ? '#aabbcc' : '#ffeeaa';
    this.weatherText.setColor(col);
  }

  private setBossHP(hp: number, maxHp: number, label: string) {
    this.bossBarContainer.setVisible(true);
    const frac = Math.max(0, hp / maxHp);
    this.bossBarFg.clear();
    this.bossBarFg.fillStyle(0xff2200, 1);
    this.bossBarFg.fillRect(this.scene.scale.width / 2 - 199, 40, 398 * frac, 14);
    this.bossLabel.setText(label + '  ' + Math.ceil(hp) + ' / ' + maxHp);
  }

  private updateHeroStatus(hp: number, maxHp: number, level: number) {
    const pips = Math.round((hp / maxHp) * 5);
    const bar = '●'.repeat(pips) + '○'.repeat(5 - pips);
    this.heroText.setText('HERO Lv' + level + '  HP ' + bar);
  }

  private setHeroLevel(_level: number) {}
}
