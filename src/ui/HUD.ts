import Phaser from 'phaser';
import {
  COLORS,
} from '../utils/constants';
import type { WeatherState } from '../systems/WeatherSystem';
import { SoundSystem } from '../systems/SoundSystem';
import { drawPillBadge } from '../utils/ButtonStyles';

// ─── Responsive badge widths are computed per relayout; these are maximums ──
const PAD_T = 12;
const PAD_R = 12;

export class HUD {
  private scene: Phaser.Scene;
  private sound: SoundSystem;

  // Top-right floating badges
  private livesBg:     Phaser.GameObjects.Graphics;
  private livesTxt:    Phaser.GameObjects.Text;
  private goldBg:      Phaser.GameObjects.Graphics;
  private goldTxt:     Phaser.GameObjects.Text;
  private timerBg:     Phaser.GameObjects.Graphics;
  private timerTxt:    Phaser.GameObjects.Text;
  private settingsBg:  Phaser.GameObjects.Graphics;
  private settingsTxt: Phaser.GameObjects.Text;
  private settingsHit: Phaser.GameObjects.Rectangle;

  // Wave countdown (top-centre small text)
  private countdownTxt: Phaser.GameObjects.Text;

  // Boss HP bar
  private bossBg:       Phaser.GameObjects.Graphics;
  private bossBarFg:    Phaser.GameObjects.Graphics;
  private bossLabel:    Phaser.GameObjects.Text;
  private bossContainer:Phaser.GameObjects.Container;

  // Hero status (bottom-left)
  private heroTxt: Phaser.GameObjects.Text;

  // FPS (bottom-right)
  private fpsTxt: Phaser.GameObjects.Text;

  // Settings modal objects
  private _settingsOpen = false;
  private modalBackdrop: Phaser.GameObjects.Rectangle;
  private modalPanel:    Phaser.GameObjects.Graphics;
  private modalBgmBtn:   Phaser.GameObjects.Text;
  private modalSfxBtn:   Phaser.GameObjects.Text;
  private modalPauseBtn: Phaser.GameObjects.Text;
  private modalCloseBtn: Phaser.GameObjects.Text;

  // Lives low-health pulse tween
  private livesPulse: Phaser.Tweens.Tween | null = null;

  // Session timer start
  private startTime: number;

  // Cached layout
  private _W = 0;
  private _sc = 1.0;  // responsive scale factor vs 1366×768 reference

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.sound = SoundSystem.instance;
    this.startTime = scene.time.now;

    const W = scene.scale.width;
    const H = scene.scale.height;
    const D = 50;

    // ── Lives badge ──────────────────────────────────────────────────────────
    this.livesBg  = scene.add.graphics().setScrollFactor(0).setDepth(D);
    this.livesTxt = scene.add.text(0, 0, '♥ 20', {
      fontSize: '17px', fontFamily: 'monospace', color: '#ff4444',
    }).setScrollFactor(0).setDepth(D + 1).setOrigin(0.5);

    // ── Gold badge ───────────────────────────────────────────────────────────
    this.goldBg  = scene.add.graphics().setScrollFactor(0).setDepth(D);
    this.goldTxt = scene.add.text(0, 0, '$ 200', {
      fontSize: '17px', fontFamily: 'monospace', color: '#ffd700',
    }).setScrollFactor(0).setDepth(D + 1).setOrigin(0.5);

    // ── Timer badge ──────────────────────────────────────────────────────────
    this.timerBg  = scene.add.graphics().setScrollFactor(0).setDepth(D);
    this.timerTxt = scene.add.text(0, 0, '⏱ 0:00', {
      fontSize: '17px', fontFamily: 'monospace', color: '#8899aa',
    }).setScrollFactor(0).setDepth(D + 1).setOrigin(0.5);

    // ── Settings badge ───────────────────────────────────────────────────────
    this.settingsBg  = scene.add.graphics().setScrollFactor(0).setDepth(D);
    this.settingsTxt = scene.add.text(0, 0, '⚙', {
      fontSize: '18px', fontFamily: 'monospace', color: '#aabbcc',
    }).setScrollFactor(0).setDepth(D + 1).setOrigin(0.5);

    this.settingsHit = scene.add.rectangle(0, 0, 48, 36, 0, 0)
      .setScrollFactor(0).setDepth(D + 2).setInteractive({ useHandCursor: true })
      .on('pointerup', () => this.toggleSettings())
      .on('pointerover', () => { this.settingsTxt.setColor('#ffffff'); })
      .on('pointerout',  () => { this.settingsTxt.setColor('#aabbcc'); });

    // ── Wave countdown (top-centre) ──────────────────────────────────────────
    this.countdownTxt = scene.add.text(0, 0, '', {
      fontSize: '14px', fontFamily: 'monospace', color: '#8899aa', align: 'center',
    }).setScrollFactor(0).setDepth(D + 1).setOrigin(0.5);

    // ── Boss HP bar ──────────────────────────────────────────────────────────
    this.bossBg    = scene.add.graphics().setScrollFactor(0);
    this.bossBarFg = scene.add.graphics().setScrollFactor(0);
    this.bossLabel = scene.add.text(0, 0, '', {
      fontSize: '14px', fontFamily: 'monospace', color: '#ffaaaa', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0);
    this.bossContainer = scene.add.container(0, 0, [this.bossBg, this.bossBarFg, this.bossLabel])
      .setDepth(D + 3).setScrollFactor(0).setVisible(false);

    // ── Hero status ──────────────────────────────────────────────────────────
    this.heroTxt = scene.add.text(12, 0, 'HERO Lv1 HP ●●●●●', {
      fontSize: '15px', fontFamily: 'monospace', color: '#ffdd44',
    }).setScrollFactor(0).setDepth(D + 1).setOrigin(0, 0.5);

    // ── FPS text ─────────────────────────────────────────────────────────────
    this.fpsTxt = scene.add.text(0, 0, '', {
      fontSize: '13px', fontFamily: 'monospace', color: '#334455',
    }).setScrollFactor(0).setDepth(D + 1).setOrigin(1, 0.5);

    // ── Settings modal ───────────────────────────────────────────────────────
    this.modalBackdrop = scene.add.rectangle(0, 0, W, H, 0x000000, 0.55)
      .setScrollFactor(0).setDepth(70).setOrigin(0, 0).setVisible(false)
      .setInteractive()
      .on('pointerup', () => this.closeSettings());

    this.modalPanel = scene.add.graphics().setScrollFactor(0).setDepth(71).setVisible(false);

    this.modalBgmBtn = scene.add.text(0, 0, '🎵 BGM: ON', {
      fontSize: '20px', fontFamily: 'monospace', color: '#88cc88',
    }).setScrollFactor(0).setDepth(72).setOrigin(0.5).setVisible(false)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', () => {
        const on = this.sound.toggleMusic();
        this.modalBgmBtn.setText(on ? '🎵 BGM: ON' : '🎵 BGM: OFF');
        this.modalBgmBtn.setColor(on ? '#88cc88' : '#cc8888');
      });

    this.modalSfxBtn = scene.add.text(0, 0, '🔊 SFX: ON', {
      fontSize: '20px', fontFamily: 'monospace', color: '#88cc88',
    }).setScrollFactor(0).setDepth(72).setOrigin(0.5).setVisible(false)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', () => {
        const on = this.sound.toggleSFX();
        this.modalSfxBtn.setText(on ? '🔊 SFX: ON' : '🔊 SFX: OFF');
        this.modalSfxBtn.setColor(on ? '#88cc88' : '#cc8888');
      });

    this.modalPauseBtn = scene.add.text(0, 0, '⏸ PAUSE [P]', {
      fontSize: '20px', fontFamily: 'monospace', color: '#aabbcc',
    }).setScrollFactor(0).setDepth(72).setOrigin(0.5).setVisible(false)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', () => scene.events.emit('toggle_pause'));

    this.modalCloseBtn = scene.add.text(0, 0, '✕ CLOSE', {
      fontSize: '18px', fontFamily: 'monospace', color: '#cc4444',
    }).setScrollFactor(0).setDepth(72).setOrigin(0.5).setVisible(false)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', () => this.closeSettings());

    // ── Event subscriptions ──────────────────────────────────────────────────
    scene.events.on('gold_changed',   (g: number)  => this.setGold(g));
    scene.events.on('lives_changed',  (l: number)  => this.setLives(l));
    scene.events.on('wave_started',   () => { /* boss flash handled elsewhere */ });
    scene.events.on('wave_complete',  () => this.bossContainer.setVisible(false));
    scene.events.on('combo_updated',  () => { /* combo display removed */ });
    scene.events.on('weather_changed', (_state: WeatherState) => { /* visual effects still run */ });
    scene.events.on('boss_hp_update', (hp: number, maxHp: number, label: string) =>
      this.setBossHP(hp, maxHp, label));
    scene.events.on('hero_levelup',   () => { /* text updated in update() */ });
    scene.events.on('hero_downed',    () => this.heroTxt.setText('HERO DOWNED'));
    scene.events.on('hero_respawned', () => { /* text restored next update() call */ });

    this.relayout(W, H, 200);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  get isSettingsOpen(): boolean { return this._settingsOpen; }

  getAllObjects(): Phaser.GameObjects.GameObject[] {
    return [
      this.livesBg, this.livesTxt,
      this.goldBg,  this.goldTxt,
      this.timerBg, this.timerTxt,
      this.settingsBg, this.settingsTxt, this.settingsHit,
      this.countdownTxt,
      this.bossContainer,
      this.heroTxt,
      this.fpsTxt,
      this.modalBackdrop,
      this.modalPanel,
      this.modalBgmBtn,
      this.modalSfxBtn,
      this.modalPauseBtn,
      this.modalCloseBtn,
    ];
  }

  resize(W: number, H: number, barH = 200) {
    this.relayout(W, H, barH);
  }

  setPaused(paused: boolean) {
    this.modalPauseBtn.setText(paused ? '▶ RESUME [P]' : '⏸ PAUSE [P]');
    this.modalPauseBtn.setColor(paused ? '#ff8844' : '#aabbcc');
  }

  update(
    gold: number, lives: number,
    _wave: number, _totalWaves: number,
    countdown: number, _weatherCountdown: number,
    heroHp: number, heroMaxHp: number, heroLevel: number,
  ) {
    this.setGold(gold);
    this.setLives(lives);

    // Session timer
    const elapsed = this.scene.time.now - this.startTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    this.timerTxt.setText('⏱ ' + mins + ':' + secs.toString().padStart(2, '0'));

    // Wave countdown beneath combo badge
    this.countdownTxt.setText(
      countdown > 0 ? '▶ ' + Math.ceil(countdown / 1000) + 's  [SPACE]' : '',
    );

    this.updateHeroStatus(heroHp, heroMaxHp, heroLevel);
    this.fpsTxt.setText(Math.round(this.scene.game.loop.actualFps) + ' FPS');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private relayout(W: number, H: number, barH: number) {
    this._W = W;
    // Scale factor relative to a 1366×768 reference window
    this._sc = Math.max(0.5, Math.min(1.0, Math.min(W / 1366, H / 768)));
    const sc = this._sc;

    // Responsive sizes
    const bh       = Math.max(26, Math.round(36 * sc));   // badge height
    const padT     = Math.max(6,  Math.round(PAD_T * sc));
    const padR     = Math.max(6,  Math.round(PAD_R * sc));
    const gap      = Math.max(4,  Math.round(8 * sc));
    const livesW   = Math.max(58, Math.round(82  * sc));
    const goldW    = Math.max(80, Math.round(120 * sc));
    const timerW   = Math.max(72, Math.round(100 * sc));
    const settingsW= Math.max(34, Math.round(48  * sc));
    const fontSz   = Math.max(11, Math.round(17  * sc));
    const smFontSz = Math.max(9,  Math.round(14  * sc));

    // Update text styles
    this.livesTxt.setStyle({ fontSize: fontSz + 'px' });
    this.goldTxt.setStyle({ fontSize: fontSz + 'px' });
    this.timerTxt.setStyle({ fontSize: fontSz + 'px' });
    this.settingsTxt.setStyle({ fontSize: Math.max(12, Math.round(18 * sc)) + 'px' });
    this.countdownTxt.setStyle({ fontSize: smFontSz + 'px' });
    this.heroTxt.setStyle({ fontSize: Math.max(10, Math.round(15 * sc)) + 'px' });
    this.fpsTxt.setStyle({ fontSize: Math.max(9,  Math.round(13 * sc)) + 'px' });

    const CY = padT + bh / 2;

    // Badge centres, right to left
    const right = W - padR;
    const sx = right - settingsW / 2;
    const tx = sx  - settingsW / 2 - gap - timerW / 2;
    const gx = tx  - timerW  / 2 - gap - goldW  / 2;
    const lx = gx  - goldW   / 2 - gap - livesW / 2;

    drawPillBadge(this.livesBg, lx, CY, livesW, bh);
    this.livesTxt.setPosition(lx, CY);

    drawPillBadge(this.goldBg, gx, CY, goldW, bh);
    this.goldTxt.setPosition(gx, CY);

    drawPillBadge(this.timerBg, tx, CY, timerW, bh);
    this.timerTxt.setPosition(tx, CY);

    drawPillBadge(this.settingsBg, sx, CY, settingsW, bh);
    this.settingsTxt.setPosition(sx, CY);
    this.settingsHit.setPosition(sx, CY).setSize(settingsW, bh);

    // Countdown at top-centre
    this.countdownTxt.setPosition(W / 2, padT + bh + 8);

    // Hero / FPS just above bottom bar
    this.heroTxt.setPosition(10, H - barH - 14);
    this.fpsTxt.setPosition(W - 10, H - barH - 14);

    // Boss HP bar below badge row
    const bossY  = padT + bh + 8;
    const bossW  = Math.min(W - 32, Math.round(720 * sc));
    const barH2  = Math.max(14, Math.round(22 * sc));
    this.bossBg.clear();
    this.bossBg.fillStyle(COLORS.PANEL_BG, 0.88);
    this.bossBg.fillRoundedRect(W / 2 - bossW / 2, bossY, bossW, barH2, 4);
    this.bossBg.lineStyle(1, 0xff2200, 0.8);
    this.bossBg.strokeRoundedRect(W / 2 - bossW / 2, bossY, bossW, barH2, 4);
    this.bossLabel.setStyle({ fontSize: Math.max(10, Math.round(14 * sc)) + 'px' });
    this.bossLabel.setPosition(W / 2, bossY + barH2 / 2);
    this.bossBarFg.clear();

    // Settings modal
    this.modalBackdrop.setPosition(0, 0).setSize(W, H);

    const panelW = Math.max(220, Math.round(300 * sc));
    const panelH = Math.max(180, Math.round(240 * sc));
    const px = W / 2 - panelW / 2;
    const py = H / 2 - panelH / 2;
    this.modalPanel.clear();
    this.modalPanel.fillStyle(0x000000, 0.38);
    this.modalPanel.fillRoundedRect(px + 4, py + 4, panelW, panelH, 12);
    this.modalPanel.fillStyle(0x0d1117, 0.97);
    this.modalPanel.fillRoundedRect(px, py, panelW, panelH, 12);
    this.modalPanel.lineStyle(1, 0x2a3a4a, 1);
    this.modalPanel.strokeRoundedRect(px, py, panelW, panelH, 12);
    const modalFS = Math.max(14, Math.round(20 * sc)) + 'px';
    this.modalBgmBtn.setStyle({ fontSize: modalFS }).setPosition(W / 2, py + panelH * 0.21);
    this.modalSfxBtn.setStyle({ fontSize: modalFS }).setPosition(W / 2, py + panelH * 0.40);
    this.modalPauseBtn.setStyle({ fontSize: modalFS }).setPosition(W / 2, py + panelH * 0.62);
    this.modalCloseBtn.setStyle({ fontSize: Math.max(12, Math.round(18 * sc)) + 'px' })
      .setPosition(W / 2, py + panelH * 0.84);
  }

  private setGold(g: number) {
    this.goldTxt.setText('$ ' + Math.floor(g));
  }

  private setLives(l: number) {
    this.livesTxt.setText('♥ ' + l);
    this.livesTxt.setColor(l <= 5 ? '#ff2222' : '#ff4444');
    if (l <= 5 && !this.livesPulse) {
      this.livesPulse = this.scene.tweens.add({
        targets: this.livesTxt, scaleX: 1.15, scaleY: 1.15,
        duration: 500, yoyo: true, repeat: -1,
      });
    } else if (l > 5 && this.livesPulse) {
      this.livesPulse.stop();
      this.livesTxt.setScale(1);
      this.livesPulse = null;
    }
  }

  private setBossHP(hp: number, maxHp: number, label: string) {
    this.bossContainer.setVisible(true);
    const frac  = Math.max(0, hp / maxHp);
    const sc    = this._sc;
    const W     = this._W;
    const bossY = Math.max(6, Math.round(12 * sc)) + Math.max(26, Math.round(36 * sc)) + 8;
    const bossW = Math.min(W - 32, Math.round(720 * sc));
    const barH2 = Math.max(14, Math.round(22 * sc));
    const barColor = frac > 0.6 ? 0x44cc00 : frac > 0.3 ? 0xffaa00 : 0xff2200;
    this.bossBarFg.clear();
    this.bossBarFg.fillStyle(barColor, 1);
    this.bossBarFg.fillRoundedRect(
      W / 2 - bossW / 2 + 2, bossY + 2,
      Math.max(0, (bossW - 4) * frac), Math.max(8, barH2 - 4), 3,
    );
    this.bossLabel.setText(label + '  ' + Math.ceil(hp) + ' / ' + maxHp);
  }

  private updateHeroStatus(hp: number, maxHp: number, level: number) {
    const pips = maxHp > 0 ? Math.round((hp / maxHp) * 5) : 0;
    const bar = '●'.repeat(pips) + '○'.repeat(5 - pips);
    this.heroTxt.setText('HERO Lv' + level + '  HP ' + bar);
  }

  private toggleSettings() {
    this._settingsOpen ? this.closeSettings() : this.openSettings();
  }

  openSettings() {
    this._settingsOpen = true;
    this.modalBackdrop.setVisible(true);
    this.modalPanel.setVisible(true);
    this.modalBgmBtn.setVisible(true);
    this.modalSfxBtn.setVisible(true);
    this.modalPauseBtn.setVisible(true);
    this.modalCloseBtn.setVisible(true);
  }

  closeSettings() {
    this._settingsOpen = false;
    this.modalBackdrop.setVisible(false);
    this.modalPanel.setVisible(false);
    this.modalBgmBtn.setVisible(false);
    this.modalSfxBtn.setVisible(false);
    this.modalPauseBtn.setVisible(false);
    this.modalCloseBtn.setVisible(false);
  }
}
