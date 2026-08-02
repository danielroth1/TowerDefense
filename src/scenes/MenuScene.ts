import Phaser from 'phaser';
import { COLORS } from '../utils/constants';
import { hashSeed } from '../utils/helpers';
import { SoundSystem } from '../systems/SoundSystem';
import {
  type PerfSettings,
  DEFAULT_PERF_SETTINGS,
  FIELD_SIZE_PRESETS,
  SPAWN_RATE_PRESETS,
  ENEMY_AMOUNT_PRESETS,
} from '../data/PerfSettings';

export class MenuScene extends Phaser.Scene {
  private seedInput: HTMLInputElement | null = null;
  private debugInput: HTMLInputElement | null = null;

  /** Persisted perf test settings (last values saved when the panel closes). */
  private currentPerfSettings: PerfSettings = { ...DEFAULT_PERF_SETTINGS };

  // Perf settings panel — HTML elements (created while panel is open)
  private perfPanelOpen = false;
  private perfPanelBg: Phaser.GameObjects.Graphics | null = null;
  private perfPanelRefs: Phaser.GameObjects.GameObject[] = [];
  private perfEnemyCheck: HTMLInputElement | null = null;
  private perfEnemyRate: HTMLSelectElement | null = null;
  private perfEnemyAmount: HTMLSelectElement | null = null;
  private perfTowerCheck: HTMLInputElement | null = null;
  private perfTowerPct: HTMLSelectElement | null = null;
  private perfEcoCheck: HTMLInputElement | null = null;
  private perfEcoPct: HTMLSelectElement | null = null;
  private perfFieldSize: HTMLSelectElement | null = null;
  /** All perf-related HTML elements for batch cleanup & reposition. */
  private perfElements: HTMLElement[] = [];

  constructor() { super('MenuScene'); }

  /**
   * Convert game-internal coordinates to screen-relative CSS pixel
   * coordinates, accounting for FIT scaling and canvas centering.
   */
  private internalToScreen(gameX: number, gameY: number): { x: number; y: number } {
    const canvas = this.sys.game.canvas;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / this.scale.width;
    const scaleY = rect.height / this.scale.height;
    return {
      x: rect.left + gameX * scaleX,
      y: rect.top + gameY * scaleY,
    };
  }

  /** Reposition HTML inputs using current canvas bounds. */
  private repositionInputs() {
    const W = this.scale.width;
    const H = this.scale.height;

    if (this.seedInput) {
      const seedPos = this.internalToScreen(W / 2 - 100, H * 0.48 - 24);
      this.seedInput.style.left = `${seedPos.x}px`;
      this.seedInput.style.top = `${seedPos.y}px`;
    }

    if (this.debugInput) {
      const debugPos = this.internalToScreen(W / 2 - 20, H * 0.53 - 17);
      this.debugInput.style.left = `${debugPos.x}px`;
      this.debugInput.style.top = `${debugPos.y}px`;
    }

    // Reposition perf settings elements (only exist while panel is open)
    if (this.perfPanelOpen) this.repositionPerfPanel(W, H);
  }

  /** Reposition perf panel + its HTML inputs to the current canvas bounds. */
  private repositionPerfPanel(W: number, H: number) {
    const panelW = 420;
    const panelH = 330;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    if (this.perfPanelBg) {
      this.perfPanelBg.clear();
      this.perfPanelBg.fillStyle(0x0d1117, 0.98);
      this.perfPanelBg.fillRoundedRect(panelX, panelY, panelW, panelH, 10);
      this.perfPanelBg.lineStyle(2, 0x4488bb, 0.7);
      this.perfPanelBg.strokeRoundedRect(panelX, panelY, panelW, panelH, 10);
    }

    const perfLeft = panelX + 40;
    const perfStartFrac = panelY + 70;

    if (this.perfEnemyCheck) this.positionEl(this.perfEnemyCheck, perfLeft + 200, perfStartFrac, 14, 14);
    if (this.perfEnemyRate) this.positionEl(this.perfEnemyRate, perfLeft + 230, perfStartFrac - 3, 65, 20);
    if (this.perfEnemyAmount) this.positionEl(this.perfEnemyAmount, perfLeft + 305, perfStartFrac - 3, 65, 20);

    if (this.perfTowerCheck) this.positionEl(this.perfTowerCheck, perfLeft + 200, perfStartFrac + 34, 14, 14);
    if (this.perfTowerPct) this.positionEl(this.perfTowerPct, perfLeft + 230, perfStartFrac + 31, 65, 20);

    if (this.perfEcoCheck) this.positionEl(this.perfEcoCheck, perfLeft + 200, perfStartFrac + 68, 14, 14);
    if (this.perfEcoPct) this.positionEl(this.perfEcoPct, perfLeft + 230, perfStartFrac + 65, 65, 20);

    if (this.perfFieldSize) this.positionEl(this.perfFieldSize, perfLeft + 200, perfStartFrac + 102, 135, 20);
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;

    // Dark gradient background
    const bg = this.add.graphics();
    bg.fillGradientStyle(COLORS.BG, COLORS.BG, 0x0d1a2d, 0x0d1a2d, 1);
    bg.fillRect(0, 0, W, H);

    // Animated grid lines
    for (let x = 0; x < W; x += 48) {
      bg.lineStyle(1, 0x1a2a3a, 0.4);
      bg.lineBetween(x, 0, x, H);
    }
    for (let y = 0; y < H; y += 48) {
      bg.lineStyle(1, 0x1a2a3a, 0.4);
      bg.lineBetween(0, y, W, y);
    }

    // Title
    this.add.text(W / 2, H * 0.18, 'VECTOR', {
      fontSize: '72px',
      fontFamily: 'monospace',
      color: '#eef0f4',
      stroke: '#4488bb',
      strokeThickness: 6,
    }).setOrigin(0.5);

    this.add.text(W / 2, H * 0.30, 'TOWER DEFENSE', {
      fontSize: '36px',
      fontFamily: 'monospace',
      color: '#ffd700',
      stroke: '#aa8800',
      strokeThickness: 3,
    }).setOrigin(0.5);

    // Seed label
    this.add.text(W / 2 - 160, H * 0.48, 'SEED:', {
      fontSize: '18px', fontFamily: 'monospace', color: '#8899aa',
    }).setOrigin(0, 0.5);

    this.seedInput = document.createElement('input');
    this.seedInput.type = 'text';
    this.seedInput.placeholder = 'random';
    this.seedInput.maxLength = 20;
    Object.assign(this.seedInput.style, {
      position: 'fixed',
      width: '130px',
      height: '22px',
      background: '#0d1117',
      border: '1px solid #2a3a4a',
      color: '#eef0f4',
      fontFamily: 'monospace',
      fontSize: '13px',
      padding: '1px 6px',
      outline: 'none',
      borderRadius: '4px',
    });
    document.body.appendChild(this.seedInput);

    // Debug mode checkbox
    this.add.text(W / 2 - 160, H * 0.53, 'DEBUG ($10k):', {
      fontSize: '18px', fontFamily: 'monospace', color: '#8899aa',
    }).setOrigin(0, 0.5);

    this.debugInput = document.createElement('input');
    this.debugInput.type = 'checkbox';
    Object.assign(this.debugInput.style, {
      position: 'fixed',
      width: '14px',
      height: '14px',
      accentColor: '#ffd700',
      cursor: 'pointer',
    });
    document.body.appendChild(this.debugInput);

    // Position HTML inputs relative to the scaled canvas
    this.repositionInputs();

    // Re-position on window resize (Phaser Scale.FIT re-sizes the canvas)
    this.scale.on('resize', () => this.repositionInputs(), this);

    // Play button
    const playBtn = this.makeButton(W / 2, H * 0.60, 200, 50, 'PLAY', 0x1e3a5f, 0x2a5080);
    playBtn.on('pointerup', () => this.startGame());

    // Perf Test button
    const perfBtn = this.makeButton(W / 2, H * 0.66, 200, 40, 'PERF TEST', 0x5f1e1e, 0x802a2a);
    perfBtn.on('pointerup', () => this.startGamePerfTest());

    // Perf Settings button (opens the settings panel)
    const perfSettingsBtn = this.makeButton(W / 2, H * 0.72, 200, 40, 'PERF SETTINGS', 0x1a2a3a, 0x2a4a5a);
    perfSettingsBtn.on('pointerup', () => this.showPerfSettings());

    // How to play button
    const helpBtn = this.makeButton(W / 2, H * 0.78, 200, 50, 'HOW TO PLAY', 0x1a2a1a, 0x2a4a2a);
    helpBtn.on('pointerup', () => this.showHelp());

    // Version
    this.add.text(W - 10, H - 10, 'v1.0', {
      fontSize: '12px', fontFamily: 'monospace', color: '#334455',
    }).setOrigin(1, 1);

    // Position HTML inputs relative to the scaled canvas
    this.repositionInputs();
    this.scale.on('resize', () => this.repositionInputs(), this);

    // Decorative corner towers
    this.drawCornerDecor();

    // Pulse title animation
    const title = this.children.list.find(
      c => c instanceof Phaser.GameObjects.Text && (c as Phaser.GameObjects.Text).text === 'VECTOR'
    ) as Phaser.GameObjects.Text | undefined;
    if (title) {
      this.tweens.add({
        targets: title,
        scaleX: 1.04, scaleY: 1.04,
        duration: 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  private makeButton(x: number, y: number, w: number, h: number, label: string, colorNorm: number, colorHover: number) {
    const container = this.add.container(x, y);
    const bg = this.add.graphics();
    const text = this.add.text(0, 0, label, {
      fontSize: '20px', fontFamily: 'monospace', color: '#eef0f4',
    }).setOrigin(0.5);

    const draw = (color: number) => {
      bg.clear();
      bg.fillStyle(color, 1);
      bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8);
      bg.lineStyle(2, 0x4488bb, 0.7);
      bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 8);
    };
    draw(colorNorm);
    container.add([bg, text]);

    const hitArea = this.add.rectangle(x, y, w, h, 0, 0)
      .setInteractive({ useHandCursor: true });

    // When the hit area is destroyed (e.g. closing a panel), also remove
    // the container + its children so they don't leak in the scene.
    hitArea.on('destroy', () => {
      if (container && container.active) container.destroy();
    });

    hitArea.on('pointerover',  () => draw(colorHover));
    hitArea.on('pointerout',   () => draw(colorNorm));
    hitArea.on('pointerdown',  () => { bg.clear(); bg.fillStyle(COLORS.BTN_PRESS, 1); bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8); });
    hitArea.on('pointerup',    () => draw(colorHover));
    return hitArea;
  }

  private startGame() {
    const raw = this.seedInput?.value.trim() || String(Math.floor(Math.random() * 999999));
    const seed = hashSeed(raw || String(Date.now()));
    const debug = this.debugInput?.checked ?? false;
    // Unlock WebAudio inside this user gesture (PLAY tap) — creating the
    // AudioContext outside a gesture is blocked/suspended on mobile.
    SoundSystem.instance.init({ musicEnabled: !debug });
    this.cleanupInput();
    this.scene.start('GameScene', { seed, seedStr: raw, debug });
  }

  private startGamePerfTest() {
    const raw = this.seedInput?.value.trim() || String(Math.floor(Math.random() * 999999));
    const seed = hashSeed(raw || String(Date.now()));
    const perfSettings = this.currentPerfSettings;
    // Perf test runs in debug mode — no BGM.
    SoundSystem.instance.init({ musicEnabled: false });
    this.cleanupInput();
    this.scene.start('GameScene', { seed, seedStr: raw, perfTest: true, perfSettings });
  }

  // ─── Perf Settings Panel ──────────────────────────────────────────────

  /** Open the perf settings modal panel. */
  private showPerfSettings() {
    if (this.perfPanelOpen) return;
    this.perfPanelOpen = true;

    const W = this.scale.width;
    const H = this.scale.height;
    const panelW = 420;
    const panelH = 330;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    // Full-screen dimming overlay (blocks clicks to the menu behind)
    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0.6);
    overlay.fillRect(0, 0, W, H);
    overlay.setInteractive(new Phaser.Geom.Rectangle(0, 0, W, H), Phaser.Geom.Rectangle.Contains);
    overlay.setDepth(200);
    this.perfPanelRefs.push(overlay);

    // Panel background
    const panelBg = this.add.graphics();
    panelBg.setDepth(201);
    this.perfPanelBg = panelBg;
    this.perfPanelRefs.push(panelBg);

    // Panel title
    const title = this.add.text(W / 2, panelY + 30, 'PERF TEST SETTINGS', {
      fontSize: '20px', fontFamily: 'monospace', color: '#ffd700',
      stroke: '#aa8800', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(202);
    this.perfPanelRefs.push(title);

    const perfLeft = panelX + 40;
    const row1Y = panelY + 70;
    const row2Y = row1Y + 34;
    const row3Y = row1Y + 68;
    const row4Y = row1Y + 102;

    // --- Spawn Enemies ---
    this.addPanelText(perfLeft, row1Y, 'Spawn enemies:');
    this.perfEnemyCheck = this.createCheckbox();
    this.perfEnemyCheck.checked = this.currentPerfSettings.spawnEnemies;
    this.perfEnemyCheck.addEventListener('change', () => this.updatePerfEnemyVisibility());

    this.perfEnemyRate = this.createSelect(
      SPAWN_RATE_PRESETS.map(p => ({ text: p.label, value: String(p.value) })),
      String(this.currentPerfSettings.enemySpawnRate),
    );
    this.perfEnemyAmount = this.createSelect(
      ENEMY_AMOUNT_PRESETS.map(p => ({ text: p.label, value: String(p.value) })),
      String(this.currentPerfSettings.enemyAmount),
    );

    // --- Spawn Towers ---
    this.addPanelText(perfLeft, row2Y, 'Spawn towers:');
    this.perfTowerCheck = this.createCheckbox();
    this.perfTowerCheck.checked = this.currentPerfSettings.spawnTowers;
    this.perfTowerCheck.addEventListener('change', () => this.updatePerfTowerVisibility());

    this.perfTowerPct = this.createSelect(
      ['5', '10', '20', '30', '50', '75', '100'].map(v => ({ text: `${v}%`, value: v })),
      String(this.currentPerfSettings.towerPercentage),
    );

    // --- Place Eco Buildings ---
    this.addPanelText(perfLeft, row3Y, 'Eco buildings:');
    this.perfEcoCheck = this.createCheckbox();
    this.perfEcoCheck.checked = this.currentPerfSettings.placeEcoBuildings;
    this.perfEcoCheck.addEventListener('change', () => this.updatePerfEcoVisibility());

    this.perfEcoPct = this.createSelect(
      ['5', '10', '20', '30', '50', '75', '100'].map(v => ({ text: `${v}%`, value: v })),
      String(this.currentPerfSettings.ecoBuildingPercentage),
    );

    // --- Field Size ---
    this.addPanelText(perfLeft, row4Y, 'Field size:');
    this.perfFieldSize = this.createSelect(
      FIELD_SIZE_PRESETS.map(p => ({ text: p.label, value: `${p.cols}x${p.rows}` })),
      `${this.currentPerfSettings.fieldCols}x${this.currentPerfSettings.fieldRows}`,
    );

    // DONE button
    const doneBtn = this.makeButton(W / 2, panelY + panelH - 40, 160, 40, 'DONE', 0x1e3a5f, 0x2a5080);
    doneBtn.setDepth(203);
    doneBtn.on('pointerup', () => this.closePerfSettings());
    this.perfPanelRefs.push(doneBtn);

    // Initial visibility
    this.updatePerfEnemyVisibility();
    this.updatePerfTowerVisibility();
    this.updatePerfEcoVisibility();

    this.repositionPerfPanel(W, H);
  }

  /** Add a label text inside the perf panel (auto depth + ref tracking). */
  private addPanelText(x: number, y: number, text: string) {
    const t = this.add.text(x, y, text, {
      fontSize: '14px', fontFamily: 'monospace', color: '#8899aa',
    }).setOrigin(0, 0.5).setDepth(202);
    this.perfPanelRefs.push(t);
  }

  /** Close the perf settings panel, saving the current values. */
  private closePerfSettings() {
    if (!this.perfPanelOpen) return;
    this.currentPerfSettings = this.readPerfSettings();

    // Remove HTML inputs
    for (const el of this.perfElements) {
      if (el.parentNode) document.body.removeChild(el);
    }
    this.perfElements = [];
    this.perfEnemyCheck = this.perfEnemyRate = this.perfEnemyAmount = null;
    this.perfTowerCheck = this.perfTowerPct = null;
    this.perfEcoCheck = this.perfEcoPct = null;
    this.perfFieldSize = null;

    // Remove panel game objects
    for (const obj of this.perfPanelRefs) {
      if (obj && obj.active) obj.destroy();
    }
    this.perfPanelRefs = [];
    this.perfPanelBg = null;
    this.perfPanelOpen = false;
  }

  // ─── Perf Settings Helpers ────────────────────────────────────────────

  /** Create a styled checkbox element and append to body. */
  private createCheckbox(): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'checkbox';
    Object.assign(el.style, {
      position: 'fixed',
      width: '14px',
      height: '14px',
      accentColor: '#ffd700',
      cursor: 'pointer',
    });
    document.body.appendChild(el);
    this.perfElements.push(el);
    return el;
  }

  /** Create a styled <select> dropdown and append to body. */
  private createSelect(
    options: { text: string; value: string }[],
    defaultValue: string,
  ): HTMLSelectElement {
    const el = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.textContent = o.text;
      opt.value = o.value;
      if (o.value === defaultValue) opt.selected = true;
      el.appendChild(opt);
    }
    Object.assign(el.style, {
      position: 'fixed',
      background: '#0d1117',
      border: '1px solid #2a3a4a',
      color: '#eef0f4',
      fontFamily: 'monospace',
      fontSize: '11px',
      padding: '0 2px',
      outline: 'none',
      borderRadius: '3px',
      cursor: 'pointer',
    });
    document.body.appendChild(el);
    this.perfElements.push(el);
    return el;
  }

  /** Position an HTML element at screen coordinates. */
  private positionEl(el: HTMLElement, gameX: number, gameY: number, w: number, h: number) {
    const pos = this.internalToScreen(gameX, gameY);
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  }

  private updatePerfEnemyVisibility() {
    const show = this.perfEnemyCheck?.checked ?? false;
    if (this.perfEnemyRate) this.perfEnemyRate.style.display = show ? '' : 'none';
    if (this.perfEnemyAmount) this.perfEnemyAmount.style.display = show ? '' : 'none';
  }

  private updatePerfTowerVisibility() {
    const show = this.perfTowerCheck?.checked ?? false;
    if (this.perfTowerPct) this.perfTowerPct.style.display = show ? '' : 'none';
  }

  private updatePerfEcoVisibility() {
    const show = this.perfEcoCheck?.checked ?? false;
    if (this.perfEcoPct) this.perfEcoPct.style.display = show ? '' : 'none';
  }

  /** Read current perf settings from HTML inputs (falls back to stored values). */
  private readPerfSettings(): PerfSettings {
    const stored = this.currentPerfSettings;
    const fieldVal = this.perfFieldSize?.value ?? `${stored.fieldCols}x${stored.fieldRows}`;
    const [cols, rows] = fieldVal.split('x').map(Number);
    return {
      spawnEnemies: this.perfEnemyCheck?.checked ?? stored.spawnEnemies,
      enemySpawnRate: Number(this.perfEnemyRate?.value) || stored.enemySpawnRate,
      enemyAmount: Number(this.perfEnemyAmount?.value) || stored.enemyAmount,
      spawnTowers: this.perfTowerCheck?.checked ?? stored.spawnTowers,
      towerPercentage: Number(this.perfTowerPct?.value) || stored.towerPercentage,
      placeEcoBuildings: this.perfEcoCheck?.checked ?? stored.placeEcoBuildings,
      ecoBuildingPercentage: Number(this.perfEcoPct?.value) || stored.ecoBuildingPercentage,
      fieldCols: isNaN(cols) ? stored.fieldCols : cols,
      fieldRows: isNaN(rows) ? stored.fieldRows : rows,
    };
  }

  private showHelp() {
    const W = this.scale.width;
    const H = this.scale.height;

    // Overlay
    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0.75);
    overlay.fillRect(0, 0, W, H);

    const lines = [
      'HOW TO PLAY',
      '',
      '• Click a buildable tile (green) to place a tower.',
      '• Click a placed tower to upgrade or evolve it.',
      '• Towers with adjacent synergies get bonuses (see glow).',
      '• Survive all 50 waves to win. Every 5th wave = BOSS.',
      '',
      'ABILITIES (click ability bar or press 1-4):',
      '  1  Blizzard – freeze enemies in area',
      '  2  Meteor Strike – massive AoE damage',
      '  3  Lightning Storm – chain damage',
      '  4  Temporal Rift – slow time in area',
      '',
      'HERO: Click anywhere on non-path terrain to move.',
      'BARRICADE: Buy from sidebar to slow enemy paths.',
      '',
      'Weather changes every ~75s – watch the HUD!',
      'Kill combos give gold multipliers (up to ×10).',
      '',
      '               Click to close',
    ];

    const helpText = this.add.text(W / 2, H / 2, lines, {
      fontSize: '15px',
      fontFamily: 'monospace',
      color: '#eef0f4',
      lineSpacing: 6,
      align: 'left',
    }).setOrigin(0.5);

    overlay.setInteractive(new Phaser.Geom.Rectangle(0, 0, W, H), Phaser.Geom.Rectangle.Contains);
    overlay.once('pointerup', () => {
      overlay.destroy();
      helpText.destroy();
    });
  }

  private drawCornerDecor() {
    const W = this.scale.width;
    const H = this.scale.height;
    const g = this.add.graphics();
    const towerColor = COLORS.TOWER_CANNON;
    const baseColor  = COLORS.TOWER_BASE;
    const corners = [[40, 40], [W - 40, 40], [40, H - 40], [W - 40, H - 40]] as const;
    for (const [cx, cy] of corners) {
      g.fillStyle(baseColor, 1);
      g.fillCircle(cx, cy, 20);
      g.fillStyle(towerColor, 1);
      g.fillCircle(cx, cy, 14);
      g.lineStyle(2, 0xffffff, 0.3);
      g.strokeCircle(cx, cy, 14);
    }
  }

  private cleanupInput() {
    // Close the perf settings panel if it's open (removes its HTML + game objects)
    if (this.perfPanelOpen) this.closePerfSettings();

    if (this.seedInput) {
      document.body.removeChild(this.seedInput);
      this.seedInput = null;
    }
    if (this.debugInput) {
      document.body.removeChild(this.debugInput);
      this.debugInput = null;
    }
    for (const el of this.perfElements) {
      if (el.parentNode) document.body.removeChild(el);
    }
    this.perfElements = [];
  }

  shutdown() {
    this.cleanupInput();
  }
}
