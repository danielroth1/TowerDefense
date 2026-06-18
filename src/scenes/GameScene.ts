import Phaser from 'phaser';
import { generateMap, type MapData, type GridTile } from '../systems/MapGenerator';
import { computeBlobMask, blobTileKey } from '../systems/BlobTileset';
import { computeTerrainBlobMask, transitionTileKey } from '../systems/TerrainTransition';
import { Tower } from '../entities/Tower';
import { Enemy } from '../entities/Enemy';
import { Projectile, type ProjectileConfig } from '../entities/Projectile';
import { Hero } from '../entities/Hero';
import { Barricade } from '../entities/Barricade';
import { EconomyManager } from '../systems/EconomyManager';
import { WaveManager } from '../systems/WaveManager';
import { AbilitySystem } from '../systems/AbilitySystem';
import { SynergySystem } from '../systems/SynergySystem';
import { WeatherSystem } from '../systems/WeatherSystem';
import { ComboSystem } from '../systems/ComboSystem';
import { HUD } from '../ui/HUD';
import { BottomBar } from '../ui/BottomBar';
import { SoundSystem } from '../systems/SoundSystem';
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, COLORS,
  MAX_BARRICADES, BARRICADE_COST, TOTAL_WAVES,
  GAME_WIDTH, GAME_HEIGHT,
  UI_TOP_HEIGHT, UI_BOTTOM_HEIGHT,
} from '../utils/constants';
import type { TowerType } from '../data/towers';
import { TOWER_DEFS, TOWER_TYPES_ORDERED } from '../data/towers';

export class GameScene extends Phaser.Scene {
  // Map
  private mapData!: MapData;
  private tileSprites: Phaser.GameObjects.Image[][] = [];
  private waterSprites: Phaser.GameObjects.Image[][] = [];

  // Groups
  private towerGroup!: Phaser.GameObjects.Group;
  private enemyGroup!: Phaser.Physics.Arcade.Group;
  private flyerGroup!: Phaser.Physics.Arcade.Group;
  private projectileGroup!: Phaser.Physics.Arcade.Group;
  private barricadeGroup!: Phaser.GameObjects.Group;

  // Entities
  private hero!: Hero;
  private heroSelected: boolean = false;

  // Systems
  private economy!: EconomyManager;
  private waveManager!: WaveManager;
  private abilitySystem!: AbilitySystem;
  private synergySystem!: SynergySystem;
  private weatherSystem!: WeatherSystem;
  private comboSystem!: ComboSystem;

  // UI
  private hud!: HUD;
  private bottomBar!: BottomBar;
  private sfx: SoundSystem = SoundSystem.instance;

  // Dual-camera system
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private uiGroup!: Phaser.GameObjects.Group;
  private wallDecorations: Phaser.GameObjects.Image[] = [];

  // Interaction state
  private placingTower: TowerType | null = null;
  private placingBarricade: boolean = false;
  private hoverOverlay!: Phaser.GameObjects.Image;
  private selectedTower: Tower | null = null;

  // Stats
  private totalKills: number = 0;
  private barricadeCount: number = 0;

  constructor() { super('GameScene'); }

  init(data: { seed: number; seedStr?: string }) {
    this.mapData = generateMap(data.seed ?? 12345);
  }

  create() {
    this.setupPhysics();
    this.buildMap();
    this.createGroups();
    this.createHero();
    this.createSystems();
    this.createUI();
    this.setupCamera();
    this.setupInput();
    this.registerEvents();

    // Sound init on first interaction
    this.sfx.init();

    // 4s countdown before first wave
    this.waveManager.countdown = 4000;
  }

  // ─── Setup ───────────────────────────────────────────────────────────────
  private setupPhysics() {
    this.physics.world.setBounds(0, 0, GRID_COLS * TILE_SIZE, GRID_ROWS * TILE_SIZE);
  }

  private buildMap() {
    const { grid } = this.mapData;
    this.tileSprites = [];
    this.waterSprites = [];

    for (let r = 0; r < GRID_ROWS; r++) {
      this.tileSprites[r] = [];
      this.waterSprites[r] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const tile = grid[r][c];
        const px = c * TILE_SIZE + TILE_SIZE / 2;
        const py = r * TILE_SIZE + TILE_SIZE / 2;

        // Layer 1: Water base under every cell
        const waterImg = this.add.image(px, py, 'tile_ground').setDepth(0).setDisplaySize(TILE_SIZE, TILE_SIZE);
        this.waterSprites[r][c] = waterImg;

        // Layer 2: Topmost tile (transition, buildable, path, special, or ground)
        const { key, depth } = this.resolveTile(tile);
        const img = this.add.image(px, py, key).setDepth(depth).setDisplaySize(TILE_SIZE, TILE_SIZE);
        this.tileSprites[r][c] = img;
      }
    }

    this.hoverOverlay = this.add.image(0, 0, 'tile_buildable_hover').setAlpha(0).setDepth(1).setDisplaySize(TILE_SIZE, TILE_SIZE);
  }

  /** Determine the texture key and depth for a tile's topmost layer. */
  private resolveTile(tile: GridTile): { key: string; depth: number } {
    if (tile.type === 'spawn')     return { key: 'tile_spawn',     depth: 0.15 };
    if (tile.type === 'goal')      return { key: 'tile_goal',      depth: 0.15 };
    if (tile.type === 'path') {
      const mask = computeBlobMask(this.mapData.grid, tile.row, tile.col);
      const blobAITileKey = `tile_path_blob_${mask}`;
      const key = this.textures.exists(blobAITileKey) ? blobAITileKey
        : this.textures.exists('tile_path') ? 'tile_path'
        : blobTileKey(mask);
      return { key, depth: 0.2 };
    }
    if (tile.type === 'buildable') {
      const mask = computeTerrainBlobMask(this.mapData.grid, tile.row, tile.col);
      // Blobs: mask 0 = isolated (no neighbours) → full grass tile.
      // Mask 15 = fully surrounded → solid fill.
      // Masks 1-14 = edge cells → blob transition blends into water.
      if (mask === 0 || mask === 15) return { key: 'tile_buildable', depth: 0.1 };
      return { key: transitionTileKey('grass', mask), depth: 0.05 };
    }
    // Ground / water — only the water base layer is visible
    return { key: 'tile_ground', depth: 0 };
  }

  /** Recompute and apply the correct tile texture and depth for a grid cell. */
  private refreshTileSprite(row: number, col: number): void {
    const sprite = this.tileSprites[row]?.[col];
    if (!sprite) return;
    const { key, depth } = this.resolveTile(this.mapData.grid[row][col]);
    sprite.setTexture(key).setDepth(depth);
  }

  private createGroups() {
    this.towerGroup      = this.add.group();
    this.projectileGroup = this.physics.add.group({ classType: Projectile, runChildUpdate: true });
    this.barricadeGroup  = this.add.group();

    // Ground enemies – collide with each other
    this.enemyGroup = this.physics.add.group({ classType: Enemy, runChildUpdate: true });
    // Flyers – separate group, no ground collision
    this.flyerGroup = this.physics.add.group({ classType: Enemy, runChildUpdate: true });

    // ── Patch group add() methods to auto-ignore new members on the UI camera ──
    // Phaser 3.60 Group.add() does NOT emit any 'added' event, so event-based
    // approaches (group.on('added'), scene.on('addedtogroup')) never fire.
    for (const g of [this.towerGroup, this.enemyGroup, this.flyerGroup,
                     this.projectileGroup, this.barricadeGroup]) {
      const origAdd = g.add.bind(g);
      g.add = (child: any, addToScene?: boolean) => {
        const result = origAdd(child, addToScene);
        if (this.uiCam) {
          this.uiCam.ignore(child);
          if (child instanceof Enemy) {
            for (const bar of child.getHpBars()) this.uiCam.ignore(bar);
          }
          if (child instanceof Barricade) {
            this.uiCam.ignore(child.getHpBar());
          }
        }
        return result;
      };
    }

    // Enemy-enemy collision disabled for smooth pathing
    // Projectile hits enemies
    this.physics.add.overlap(
      this.projectileGroup, this.enemyGroup,
      (proj, _enemy) => (proj as Projectile).onHit(),
      undefined, this,
    );
    this.physics.add.overlap(
      this.projectileGroup, this.flyerGroup,
      (proj, _enemy) => (proj as Projectile).onHit(),
      undefined, this,
    );
  }

  private createHero() {
    const sp = this.mapData.spawnPoint;
    this.hero = new Hero(this, sp.x + TILE_SIZE * 2, sp.y - TILE_SIZE);
    // Hero has no setInteractive – selection is handled in onPointerUp bounds check
  }

  private createSystems() {
    this.economy       = new EconomyManager(this);
    this.waveManager   = new WaveManager(this, this.enemyGroup, this.flyerGroup, this.mapData.waypoints, this.mapData.spawnPoint);
    this.abilitySystem = new AbilitySystem(this);
    this.synergySystem = new SynergySystem(this);
    this.weatherSystem = new WeatherSystem(this);
    this.comboSystem   = new ComboSystem(this);
  }

  private createUI() {
    this.uiGroup = this.add.group();

    // Patch uiGroup.add() so new members are also ignored on the main camera
    // (camera.ignore(group) only ignores members that exist at call time)
    const origUIGroupAdd = this.uiGroup.add.bind(this.uiGroup);
    this.uiGroup.add = (child: any, addToScene?: boolean) => {
      const result = origUIGroupAdd(child, addToScene);
      if (this.cameras?.main) this.cameras.main.ignore(child);
      return result;
    };

    this.hud = new HUD(this);
    this.bottomBar = new BottomBar(this, this.economy, this.abilitySystem);

    // Register all UI objects with the UI group for camera ignoring
    for (const obj of this.hud.getAllObjects()) {
      this.uiGroup.add(obj);
    }
    for (const obj of this.bottomBar.getAllObjects()) {
      this.uiGroup.add(obj);
    }

    // Weather system screen-fixed FX also render on the UI camera
    this.weatherSystem.setUIGroup(this.uiGroup);

    this.bottomBar.onPlaceTower = (type) => {
      this.placingTower = type;
      this.placingBarricade = false;
    };

    this.bottomBar.onUpgrade = () => {
      if (!this.selectedTower) return;
      const cost = this.selectedTower.upgradeCost();
      if (!this.economy.spend(cost)) return;
      this.sfx.play('tower_place');
      this.selectedTower.upgrade();
      this.synergySystem.register(this.selectedTower, this.towerCol(this.selectedTower), this.towerRow(this.selectedTower));
      this.bottomBar.showUpgradeMode(this.selectedTower);
    };

    this.bottomBar.onEvolve = (branch) => {
      if (!this.selectedTower) return;
      const cost = this.selectedTower.def.evolutions[branch].cost;
      if (!this.economy.spend(cost)) return;
      this.sfx.play('tower_place');
      this.selectedTower.evolve(branch);
      this.synergySystem.register(this.selectedTower, this.towerCol(this.selectedTower), this.towerRow(this.selectedTower));
      this.bottomBar.showUpgradeMode(this.selectedTower);
    };

    this.bottomBar.onSell = () => {
      if (!this.selectedTower) return;
      const col = this.towerCol(this.selectedTower);
      const row = this.towerRow(this.selectedTower);
      this.economy.earn(this.selectedTower.sellValue());
      this.synergySystem.unregister(col, row);
      this.selectedTower.showRange(false);
      this.selectedTower.destroy();
      this.selectedTower = null;
      // Restore tile to buildable!
      this.mapData.grid[row][col].type = 'buildable';
      this.refreshTileSprite(row, col);
      this.bottomBar.showBuildMode();
    };

    this.bottomBar.onSendWave = () => this.waveManager.sendEarlyWave();
  }

  private setupCamera() {
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;

    // ── Main camera: renders the game world in the viewport between UI bars ──
    this.cameras.main.setBounds(0, 0, W, H);
    this.cameras.main.setZoom(1);
    this.cameras.main.setViewport(0, UI_TOP_HEIGHT, GAME_WIDTH, GAME_HEIGHT - UI_TOP_HEIGHT - UI_BOTTOM_HEIGHT);
    // Main camera ignores UI objects
    this.cameras.main.ignore(this.uiGroup);

    // ── UI camera: renders UI over the full canvas, no scroll/zoom ──────────
    this.uiCam = this.cameras.add(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.uiCam.setScroll(0, 0);
    this.uiCam.setZoom(1);

    // UI camera ignores known game-world groups and objects
    this.setupUICameraIgnore();
  }

  private setupUICameraIgnore() {
    // Tile sprites (already exist, won't go through patched group add())
    for (const row of this.tileSprites) {
      for (const img of row) {
        if (img) this.uiCam.ignore(img);
      }
    }

    // Water base sprites — also ignore so they don't paint over the game view
    for (const row of this.waterSprites) {
      for (const img of row) {
        if (img) this.uiCam.ignore(img);
      }
    }

    // Wall decorations
    for (const w of this.wallDecorations) {
      this.uiCam.ignore(w);
    }

    // Hero and its standalone graphics (HP bars, selection ring, target, etc.)
    if (this.hero) {
      this.uiCam.ignore(this.hero);
      for (const g of this.hero.getGraphics()) {
        this.uiCam.ignore(g);
      }
    }
    if (this.hoverOverlay) this.uiCam.ignore(this.hoverOverlay);

    // Synergy lines (created directly via scene.add.graphics(), not in a group)
    if (this.synergySystem) this.uiCam.ignore(this.synergySystem.getLines());
  }

  private setupInput() {
    // Mouse wheel zoom – UI is on a separate camera so it stays fixed naturally
    this.input.on('wheel', (_p: unknown, _go: unknown, _dx: number, dy: number) => {
      const cam = this.cameras.main;
      const zoom = Phaser.Math.Clamp(cam.zoom - dy * 0.001, 0.5, 2.0);
      cam.setZoom(zoom);
    });

    // Camera drag (middle mouse)
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (p.middleButtonDown()) {
        this.cameras.main.scrollX -= p.velocity.x / this.cameras.main.zoom;
        this.cameras.main.scrollY -= p.velocity.y / this.cameras.main.zoom;
      }
      this.updateHoverTile(p);
    });

    this.input.on('pointerup',   (p: Phaser.Input.Pointer) => this.onPointerUp(p));

    // Keyboard shortcuts
    const kb = this.input.keyboard!;
    kb.on('keydown-N', () => this.waveManager.sendEarlyWave());
    kb.on('keydown-ESC', () => {
      this.cancelPlacing();
      this.deselectTower();
      this.heroSelected = false; this.hero.setSelected(false);
    });
    kb.on('keydown-B', () => {
      if (this.economy.canAfford(BARRICADE_COST) && this.barricadeCount < MAX_BARRICADES) {
        this.placingBarricade = true; this.placingTower = null;
      }
    });
    // Tower hotkeys: Q,W,E,A,S,D for tower types 0-5
    const towerHotkeys = ['Q','W','E','A','S','D'];
    towerHotkeys.forEach((hk, i) => {
      kb.on('keydown-' + hk, () => {
        if (i < TOWER_TYPES_ORDERED.length) {
          this.placingTower = TOWER_TYPES_ORDERED[i];
          this.placingBarricade = false;
        }
      });
    });
    // Upgrade / evolve selected tower
    kb.on('keydown-U', () => {
      if (this.selectedTower?.canEvolve()) {
        this.bottomBar.onEvolve?.(0);
      } else {
        this.bottomBar.onUpgrade?.();
      }
    });
    kb.on('keydown-I', () => {
      if (this.selectedTower?.canEvolve()) {
        this.bottomBar.onEvolve?.(1);
      }
    });
  }

  private registerEvents() {
    // Economy from abilities
    this.events.on('check_can_afford', (cost: number, cb: (v: boolean) => void) => cb(this.economy.canAfford(cost)));
    this.events.on('ability_spend',    (cost: number) => this.economy.spend(cost));

    // Tower targeting
    this.events.on('tower_find_target', (tower: Tower, cb: (e: Enemy) => void) => {
      this.enemyGroup.getChildren().forEach(e => cb(e as Enemy));
      if (tower.def.targetsFlying) {
        this.flyerGroup.getChildren().forEach(e => cb(e as Enemy));
      }
    });

    this.events.on('tower_shoot', (tower: Tower, target: Enemy) => {
      this.sfx.play(('shoot_' + tower.towerType) as any);
      this.fireProjectile(tower, target);
    });

    this.events.on('projectile_hit', (proj: Projectile, target: Enemy) => this.handleHit(proj, target));

    this.events.on('enemy_died', (enemy: Enemy) => {
      this.sfx.play(enemy.def.isBoss ? 'boss_die' : 'enemy_die');
      const goldMult = this.comboSystem.multiplier * this.weatherSystem.mods.goldEarnMult;
      this.economy.earn(Math.round(enemy.reward * goldMult));
      this.comboSystem.onKill();
      this.totalKills++;
      this.waveManager.onEnemyDied();
      this.hero.gainXP(5);
    });

    this.events.on('enemy_reached_goal', (_enemy: Enemy) => {
      this.sfx.play('enemy_leak');
      this.economy.loseLife(1);
      this.comboSystem.onLeak();
      this.waveManager.onEnemyReachedGoal();
    });

    this.events.on('early_wave_bonus', (bonus: number) => this.economy.earn(bonus));

    // Enemy attacks hero
    this.events.on('enemy_hero_range_check', (enemy: Enemy) => {
      if (!this.hero.active || this.hero.isDowned) return;
      const def = enemy.def;
      if (!def.heroAttackRange || !def.heroAttackDamage || !def.heroAttackRate) return;
      const d = Phaser.Math.Distance.Between(enemy.x, enemy.y, this.hero.x, this.hero.y);
      if (d <= def.heroAttackRange) {
        this.hero.takeDamage(def.heroAttackDamage);
        enemy.heroAttackTimer = def.heroAttackRate;
        if (this.hero.hp <= 0) this.sfx.play('hero_die');
        // Red flash on hero
        this.sfx.play('hero_attack');
      }
    });

    // Hero attack
    this.events.on('hero_find_target', (hx: number, hy: number, range: number) => {
      let best: Enemy | null = null;
      let bestProgress = -1;
      const checkEnemy = (e: Phaser.GameObjects.GameObject) => {
        const enemy = e as Enemy;
        if (!enemy.active || enemy.hp <= 0 || enemy.isPhased) return;
        const d = Phaser.Math.Distance.Between(hx, hy, enemy.x, enemy.y);
        if (d <= range && enemy.pathProgress > bestProgress) {
          best = enemy;
          bestProgress = enemy.pathProgress;
        }
      };
      this.enemyGroup.getChildren().forEach(checkEnemy);
      this.flyerGroup.getChildren().forEach(checkEnemy);
      if (best !== null) {
        const target: Enemy = best;
        this.hero.playAttack();
        target.takeDamage(this.hero.attackDamage);
        // Sword slash FX
        const g = this.vfxGraphics().setDepth(10);
        g.lineStyle(3, 0xffdd44, 1);
        g.lineBetween(this.hero.x, this.hero.y, target.x, target.y);
        g.fillStyle(0xffffaa, 0.6);
        g.fillCircle(target.x, target.y, 12);
        this.tweens.add({ targets: g, alpha: 0, duration: 180, onComplete: () => g.destroy() });
        const em = this.vfxParticles(target.x, target.y, 'particle_spark', {
          speed: { min: 30, max: 80 }, lifespan: 250, scale: { start: 0.7, end: 0 },
          quantity: 6, emitting: false,
        });
        em.explode(6);
        this.time.delayedCall(300, () => em.destroy());
        if (target.hp <= 0) target.die();
      }
    });

    this.events.on('barricade_destroyed', (b: Barricade) => {
      this.mapData.grid[b.row][b.col].type = 'buildable';
      this.barricadeCount--;
      this.refreshTileSprite(b.row, b.col);
    });

    this.events.on('game_over', () => {
      this.sfx.play('game_lose');
      this.time.delayedCall(800, () => {
        this.weatherSystem.destroy();
        this.scene.start('GameOverScene', {
          wave: this.waveManager.currentWave,
          kills: this.totalKills,
          gold: this.economy.totalEarned,
          won: false,
        });
      });
    });

    this.events.on('all_waves_cleared', () => {
      this.sfx.play('game_win');
      this.time.delayedCall(800, () => {
        this.weatherSystem.destroy();
        this.scene.start('GameOverScene', {
          wave: TOTAL_WAVES,
          kills: this.totalKills,
          gold: this.economy.totalEarned,
          won: true,
        });
      });
    });
  }

  // ─── Input handlers ──────────────────────────────────────────────────────
  private onPointerUp(p: Phaser.Input.Pointer) {
    if (p.rightButtonReleased()) {
      this.cancelPlacing();
      this.deselectTower();
      return;
    }
    if (!p.leftButtonReleased()) return;

    const wx = p.worldX;
    const wy = p.worldY;

    // Ignore clicks in the top HUD bar or bottom UI bar area
    if (p.y < UI_TOP_HEIGHT || p.y >= GAME_HEIGHT - UI_BOTTOM_HEIGHT) return;

    // ── HERO SELECTION: highest priority ──────────────────────────────────
    if (!this.placingTower && !this.placingBarricade) {
      const heroBounds = this.hero.getBounds();
      // Expand bounds slightly for easier clicking
      const pad = 10;
      if (wx >= heroBounds.left - pad && wx <= heroBounds.right + pad &&
          wy >= heroBounds.top  - pad && wy <= heroBounds.bottom + pad) {
        this.heroSelected = !this.heroSelected;
        this.hero.setSelected(this.heroSelected);
        // Deselect any tower
        this.selectedTower?.showRange(false);
        this.selectedTower = null;
        this.bottomBar.showBuildMode();
        return;
      }
    }

    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return;
    const tile = this.mapData.grid[row][col];

    if (!this.placingTower && !this.placingBarricade) {
      // Ability cast
      if (this.abilitySystem.pendingCast) {
        const allEnemies = [
          ...this.enemyGroup.getChildren() as Enemy[],
          ...this.flyerGroup.getChildren() as Enemy[],
        ];
        this.abilitySystem.cast(this.abilitySystem.pendingCast, wx, wy, allEnemies);
        return;
      }

      // Tower click → upgrade panel
      const clickedTower = this.getTowerAt(col, row);
      if (clickedTower) {
        this.selectTower(clickedTower);
        return;
      }

      // Hero movement (only when selected, can walk on paths & grass, not on water)
      if (this.heroSelected) {
        if (tile.type !== 'ground') {
          this.hero.moveTo(wx, wy);
        }
      } else if (tile.type !== 'buildable') {
        // Clicking empty non-buildable space with no hero selected = deselect everything
        this.deselectTower();
      }
      return;
    }

    // Placing tower
    if (this.placingTower) {
      if (tile.type !== 'buildable') return;
      if (this.synergySystem.getTowerAt(col, row)) return;
      const def = TOWER_DEFS[this.placingTower];
      if (!this.economy.spend(def.baseCost)) return;
      this.placeTower(this.placingTower, col, row);
      if (!this.input.keyboard?.addKey('SHIFT').isDown) this.placingTower = null;
      return;
    }

    // Placing barricade
    if (this.placingBarricade) {
      if (tile.type !== 'buildable' && tile.type !== 'ground') return;
      if (!this.economy.spend(BARRICADE_COST)) return;
      const b = new Barricade(this, col, row);
      this.barricadeGroup.add(b);
      this.mapData.grid[row][col].type = 'path';

      // Update tile to path blob texture
      this.refreshTileSprite(row, col);

      this.barricadeCount++;
      if (this.barricadeCount >= MAX_BARRICADES) this.placingBarricade = false;
      return;
    }
  }

  private updateHoverTile(p: Phaser.Input.Pointer) {
    // Only hover over the game viewport area (between UI bars)
    if (p.y < UI_TOP_HEIGHT || p.y >= GAME_HEIGHT - UI_BOTTOM_HEIGHT) {
      this.hoverOverlay.setAlpha(0);
      return;
    }
    const col = Math.floor(p.worldX / TILE_SIZE);
    const row = Math.floor(p.worldY / TILE_SIZE);
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
      this.hoverOverlay.setAlpha(0);
      return;
    }
    const tile = this.mapData.grid[row][col];
    const canPlace = (this.placingTower || this.placingBarricade) &&
      (tile.type === 'buildable') &&
      !this.synergySystem.getTowerAt(col, row);

    if (canPlace) {
      this.hoverOverlay.setPosition(col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2).setAlpha(0.7);
    } else {
      this.hoverOverlay.setAlpha(0);
    }
  }

  private cancelPlacing() {
    this.placingTower = null;
    this.placingBarricade = false;
    this.hoverOverlay.setAlpha(0);
  }

  private selectTower(tower: Tower) {
    this.selectedTower?.showRange(false);
    this.selectedTower = tower;
    tower.showRange(true);
    // Ignore the range circle on the UI camera
    const rc = tower.getRangeCircle();
    if (rc && this.uiCam) this.uiCam.ignore(rc);
    this.heroSelected = false;
    this.hero.setSelected(false);
    this.bottomBar.showUpgradeMode(tower);
  }

  private deselectTower() {
    this.selectedTower?.showRange(false);
    this.selectedTower = null;
    this.heroSelected = false;
    this.hero.setSelected(false);
    this.bottomBar.showBuildMode();
  }

  // ─── Tower management ────────────────────────────────────────────────────
  private placeTower(type: TowerType, col: number, row: number) {
    this.sfx.play('tower_place');
    const tower = new Tower(this, col, row, type);
    this.towerGroup.add(tower);
    this.mapData.grid[row][col].type = 'path'; // mark as occupied (unbuildable)
    this.synergySystem.register(tower, col, row);

    // Placement animation
    tower.setScale(0.4);
    this.tweens.add({ targets: tower, scaleX: 1, scaleY: 1, duration: 200, ease: 'Back.easeOut' });

    // Spawn particles
    const em = this.vfxParticles(tower.x, tower.y, 'particle_spark', {
      speed: { min: 30, max: 100 },
      lifespan: 400,
      scale: { start: 0.8, end: 0 },
      quantity: 12,
      emitting: false,
    });
    em.explode(12);
    this.time.delayedCall(500, () => em.destroy());
  }

  private getTowerAt(col: number, row: number): Tower | null {
    return this.synergySystem.getTowerAt(col, row);
  }

  private towerCol(tower: Tower): number {
    return Math.round((tower.x - TILE_SIZE / 2) / TILE_SIZE);
  }

  private towerRow(tower: Tower): number {
    return Math.round((tower.y - TILE_SIZE / 2) / TILE_SIZE);
  }

  // ─── Projectiles ────────────────────────────────────────────────────────
  private fireProjectile(tower: Tower, target: Enemy) {
    const textureKey = `proj_${tower.towerType}`;
    const evo = tower.evolutionType;

    // Evolution overrides for splash / pierce / bounce
    let splash = tower.splashRadius;
    let pierce = tower.activeSynergyTags.includes('pierce');
    let bounceLeft = 0;

    if (evo === 'mortar')     splash = 110;       // big splash
    if (evo === 'railgun')    pierce = true;       // piercing shot
    if (evo === 'ricochet')   bounceLeft = 8;      // bounce x8
    if (evo === 'tesla')      bounceLeft = 5;      // chain x5

    // Build special tags from evolution
    const evoTags: string[] = [...tower.activeSynergyTags];
    if (evo === 'sniper')    evoTags.push('armor_pierce');
    if (evo === 'permafrost') evoTags.push('permafrost_shatter');
    if (evo === 'plague')    evoTags.push('spread_poison');
    if (evo === 'acid')      evoTags.push('armor_reduce');
    if (evo === 'overload')  evoTags.push('death_pulse');

    const cfg: ProjectileConfig = {
      sourceX: tower.x,
      sourceY: tower.y,
      target,
      damage: tower.damage,
      speed: tower.projectileSpeed,
      textureKey,
      effectType: tower.effectType,
      effectValue: tower.effectValue,
      effectDuration: tower.effectDuration,
      splashRadius: splash,
      specialTags: evoTags,
      pierce,
      bounceLeft,
      bigSplash: evo === 'mortar',
    };

    if (evo === 'crossbow') {
      // Triple shot
      for (let i = -1; i <= 1; i++) {
        const t = this.getTargetOffset(target, i * 20);
        if (t) new Projectile(this, { ...cfg, target: t });
        else    new Projectile(this, cfg);
      }
      return;
    }

    if (evo === 'hurricane') {
      // Fire 4 projectiles in a spread around the tower
      for (let a = 0; a < 4; a++) {
        const t = this.enemyGroup.getChildren().find(
          e => Phaser.Math.Distance.Between(tower.x, tower.y, (e as Enemy).x, (e as Enemy).y) <= tower.range
        );
        if (t) {
          const ecfg = { ...cfg, target: t as Enemy, pierce: false, bounceLeft: 0 };
          const p = new Projectile(this, ecfg);
          this.projectileGroup.add(p);
        }
      }
      return;
    }

    const proj = new Projectile(this, cfg);
    this.projectileGroup.add(proj);
  }

  private getTargetOffset(base: Enemy, _offset: number): Enemy | null {
    // For spread shots, find enemy near offset
    const nearEnemy = (this.enemyGroup.getChildren() as Enemy[]).find(
      e => Math.abs(e.x - base.x) < 60 && e !== base
    );
    return nearEnemy ?? null;
  }

  private handleHit(proj: Projectile, target: Enemy) {
    if (!target.active) return;
    const cfg = proj.cfg;
    const now = this.time.now;

    // Sniper ignores armor
    const ignoreArmor = cfg.specialTags.includes('armor_pierce');
    target.takeDamage(cfg.damage, ignoreArmor);

    // Splash
    if (cfg.splashRadius > 0) {
      const all = [...this.enemyGroup.getChildren() as Enemy[], ...this.flyerGroup.getChildren() as Enemy[]];
      for (const e of all) {
        if (e === target || !e.active) continue;
        if (Phaser.Math.Distance.Between(proj.x, proj.y, e.x, e.y) <= cfg.splashRadius) {
          e.takeDamage(Math.round(cfg.damage * (cfg.bigSplash ? 0.6 : 0.4)));
          if (e.hp <= 0) e.die();
        }
      }
      this.spawnExplosion(proj.x, proj.y, Math.min(cfg.splashRadius, 48), COLORS.FX_EXPLOSION);
    }

    // Effects
    if (cfg.effectType === 'slow')  target.applySlow(1 - cfg.effectValue, cfg.effectDuration, now);
    if (cfg.effectType === 'stun')  target.applyStun(cfg.effectDuration, now);
    if (cfg.effectType === 'poison') target.applyPoison(cfg.effectValue * this.weatherSystem.mods.poisonTickMult, cfg.effectDuration, now);

    // Synergy effects
    if (cfg.specialTags.includes('armor_reduce')) target.reduceArmor(0.2);
    if (cfg.specialTags.includes('boomerang_slow')) target.applySlow(0.6, 1500, now);
    if (cfg.specialTags.includes('shatter') && target.slowFactor < 0.7) {
      target.takeDamage(Math.round(cfg.damage * 1.0));
    }

    // Permafrost shatter: 3x damage on slowed enemies
    if (cfg.specialTags.includes('permafrost_shatter') && target.slowFactor < 0.8) {
      target.takeDamage(Math.round(cfg.damage * 2.0));
    }

    // Plague spread: when target dies, poison nearby enemies
    if (cfg.specialTags.includes('spread_poison')) {
      const all = [...this.enemyGroup.getChildren() as Enemy[], ...this.flyerGroup.getChildren() as Enemy[]];
      for (const e of all) {
        if (e === target || !e.active) continue;
        if (Phaser.Math.Distance.Between(target.x, target.y, e.x, e.y) < 80) {
          e.applyPoison(cfg.effectValue || 10, 4000, now);
        }
      }
    }

    // Overload death pulse: when an enemy dies from this, explode AoE
    if (cfg.specialTags.includes('death_pulse')) {
      this.spawnExplosion(target.x, target.y, 90, 0xffff44);
      const nearby = [...this.enemyGroup.getChildren() as Enemy[], ...this.flyerGroup.getChildren() as Enemy[]];
      for (const e of nearby) {
        if (e === target || !e.active) continue;
        if (Phaser.Math.Distance.Between(target.x, target.y, e.x, e.y) <= 90) {
          e.takeDamage(Math.round(cfg.damage * 0.35));
          if (e.hp <= 0) e.die();
        }
      }
    }

    // Chain lightning (tesla)
    if (proj.cfg.bounceLeft !== undefined && proj.cfg.bounceLeft > 0) {
      this.chainLightning(target, cfg.damage * 0.8, proj.cfg.bounceLeft - 1, now);
    }

    // Death check
    if (target.hp <= 0) target.die();
  }

  private chainLightning(from: Enemy, damage: number, bouncesLeft: number, now: number) {
    if (bouncesLeft <= 0) return;
    const all = this.enemyGroup.getChildren() as Enemy[];
    const next = all
      .filter(e => e !== from && e.active && Phaser.Math.Distance.Between(from.x, from.y, e.x, e.y) < 120)
      .sort((a, b) => Phaser.Math.Distance.Between(from.x, from.y, a.x, a.y) -
                       Phaser.Math.Distance.Between(from.x, from.y, b.x, b.y))[0];
    if (!next) return;

    // Draw arc
    const g = this.vfxGraphics().setDepth(8);
    g.lineStyle(2, 0xffff00, 0.9);
    g.lineBetween(from.x, from.y, next.x, next.y);
    this.tweens.add({ targets: g, alpha: 0, duration: 300, onComplete: () => g.destroy() });

    next.takeDamage(Math.round(damage));
    next.applyStun(300, now);
    if (next.hp <= 0) next.die();
    this.chainLightning(next, damage * 0.8, bouncesLeft - 1, now);
  }

  private spawnExplosion(x: number, y: number, r: number, color: number) {
    const g = this.vfxGraphics().setDepth(7);
    g.fillStyle(color, 0.5);
    g.fillCircle(x, y, r * 0.6);
    this.tweens.add({ targets: g, alpha: 0, scaleX: 1.5, scaleY: 1.5, duration: 300, onComplete: () => g.destroy() });

    const em = this.vfxParticles(x, y, 'particle_exp', {
      speed: { min: 60, max: 200 },
      lifespan: { min: 200, max: 500 },
      scale: { start: 0.8, end: 0 },
      quantity: 16,
      emitting: false,
    });
    em.explode(16);
    this.time.delayedCall(600, () => em.destroy());
  }

  // ─── Aura towers ────────────────────────────────────────────────────────
  private processAuraTowers() {
    const now = this.time.now;
    this.towerGroup.getChildren().forEach(obj => {
      const t = obj as Tower;
      if (!t.isAura) return;
      const enemies = this.enemyGroup.getChildren() as Enemy[];
      for (const e of enemies) {
        if (Phaser.Math.Distance.Between(t.x, t.y, e.x, e.y) <= t.range) {
          e.applySlow(0.4, 500, now);
        }
      }
    });
  }

  // ─── Boss tracking ───────────────────────────────────────────────────────
  private updateBossBar() {
    const enemies = [...this.enemyGroup.getChildren() as Enemy[], ...this.flyerGroup.getChildren() as Enemy[]];
    const boss = enemies.find(e => e.def.isBoss);
    if (boss) {
      this.events.emit('boss_hp_update', boss.hp, boss.maxHp, boss.def.label);
    }
  }

  // ─── Healer aura ────────────────────────────────────────────────────────
  private processHealerAura(delta: number) {
    const healers = (this.enemyGroup.getChildren() as Enemy[]).filter(e => e.def.special === 'heal_aura');
    for (const healer of healers) {
      for (const e of this.enemyGroup.getChildren() as Enemy[]) {
        if (e === healer) continue;
        if (Phaser.Math.Distance.Between(healer.x, healer.y, e.x, e.y) < 100) {
          e.hp = Math.min(e.maxHp, e.hp + healer.def.specialValue * (delta / 1000));
        }
      }
    }
  }

  // ─── Wrappers for transient VFX — auto-ignore on UI camera ─────────────
  private vfxGraphics(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    if (this.uiCam) this.uiCam.ignore(g);
    return g;
  }

  private vfxParticles(x: number, y: number, texture: string,
    config?: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig,
  ): Phaser.GameObjects.Particles.ParticleEmitter {
    const p = this.add.particles(x, y, texture, config);
    if (this.uiCam) this.uiCam.ignore(p);
    return p;
  }

  // ─── Update ──────────────────────────────────────────────────────────────
  update(time: number, delta: number) {
    this.economy.update(delta);
    this.waveManager.update(delta);
    this.abilitySystem.update(delta);
    this.weatherSystem.update(delta);
    this.comboSystem.update(delta);

    // Update towers
    this.towerGroup.getChildren().forEach(t => (t as Tower).preUpdate(time, delta));
    this.processAuraTowers();
    this.processHealerAura(delta);
    this.updateBossBar();
    this.bottomBar.update();

    // Update HUD
    this.hud.update(
      this.economy.gold,
      this.economy.lives,
      this.waveManager.currentWave,
      TOTAL_WAVES,
      this.waveManager.countdown,
      this.weatherSystem.countdown,
      this.hero.hp,
      this.hero.maxHp,
      this.hero.level,
    );
  }
}
