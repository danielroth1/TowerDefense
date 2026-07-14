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
import { createPRNG } from '../utils/helpers';
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, COLORS,
  MAX_BARRICADES, BARRICADE_COST, TOTAL_WAVES,
  UI_TOP_HEIGHT, UI_BOTTOM_HEIGHT,
  DEBUG_STARTING_GOLD,
  CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM,
} from '../utils/constants';
import type { TowerType } from '../data/towers';
import { TOWER_DEFS, TOWER_TYPES_ORDERED } from '../data/towers';
import { ABILITY_DEFS, type AbilityType } from '../data/abilities';

/** Map alias texture keys to their base terrain keys for Wang tile lookup. */
const ALIAS_TO_TERRAIN: Record<string, string> = {
  'tile_buildable': 'tile_grass',
  'tile_ground': 'tile_water',
};

export class GameScene extends Phaser.Scene {
  // Map
  private mapData!: MapData;
  private tileSprites: Phaser.GameObjects.Image[][] = [];
  private waterSprites: Phaser.GameObjects.Image[][] = [];

  /**
   * Alpha-mask overlay sprites for edge grass cells.
   * These sit on top of a Wang tile to hide grass in the water area.
   * Null for cells that don't need an overlay.
   */
  private overlaySprites: (Phaser.GameObjects.Image | null)[][] = [];

  /** Keys of AI-loaded tile textures that support crop-based variation. */
  private aiTileKeys: Set<string> = new Set();

  /** Terrain keys that have a pre-generated Wang tile set (16 tiles). */
  private wangTerrainKeys: Set<string> = new Set();

  /**
   * Random Wang corner colors (0 or 1) for each grid intersection point.
   * Generated once at map creation. Adjacent cells share vertices, so
   * Wang tile edges always match seamlessly while the tile pattern is
   * randomly varied across the map.
   */
  private wangCorners: number[][] = [];

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

  // Pause
  private isPaused: boolean = false;

  // Floating ability buttons
  private abilityFloating: Map<AbilityType, {
    bg: Phaser.GameObjects.Graphics;
    icon: Phaser.GameObjects.Graphics;
    cdOvl: Phaser.GameObjects.Graphics;
    cdTxt: Phaser.GameObjects.Text;
    cost: Phaser.GameObjects.Text;
    hit: Phaser.GameObjects.Rectangle;
  }> = new Map();

  // Minimap
  private minimapBg!: Phaser.GameObjects.Graphics;
  private minimapMapImg!: Phaser.GameObjects.Image;
  private minimapViewport!: Phaser.GameObjects.Graphics;
  private minimapHitArea!: Phaser.GameObjects.Rectangle;
  private minimapX = 0;
  private readonly minimapY = UI_TOP_HEIGHT + 6;
  private readonly minimapW = 200;
  private readonly minimapH = 103;

  constructor() { super('GameScene'); }

  init(data: { seed: number; seedStr?: string; debug?: boolean }) {
    this.mapData = generateMap(data.seed ?? 12345);
    this._debug = data.debug ?? false;
  }
  private _debug: boolean = false;

  create() {
    // Read AI tile keys + Wang tile availability from BootScene
    const keys: string[] | undefined = this.game.registry.get('aiTiles');
    this.aiTileKeys = new Set(keys ?? []);
    const wangKeys: string[] | undefined = this.game.registry.get('wangTerrainKeys');
    this.wangTerrainKeys = new Set(wangKeys ?? []);

    // Generate random Wang corner colors for varied seamless tiling.
    // Each vertex gets a random 0/1 — adjacent cells share vertices,
    // so edges always match while the tile pattern looks random.
    this.generateWangCorners(this.mapData.seed);

    this.setupPhysics();
    this.buildMap();
    this.createGroups();
    this.createHero();
    this.createSystems();
    this.createUI();
    this.setupCamera();
    this.setupInput();
    this.registerEvents();
    this.initResizeHandler();

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
    this.overlaySprites = [];

    for (let r = 0; r < GRID_ROWS; r++) {
      this.tileSprites[r] = [];
      this.waterSprites[r] = [];
      this.overlaySprites[r] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const tile = grid[r][c];
        const px = c * TILE_SIZE + TILE_SIZE / 2;
        const py = r * TILE_SIZE + TILE_SIZE / 2;

        // Layer 1: Water base under every cell — use the seamless base
        // texture directly (not Wang/crop variants). The source is seamless,
        // so it tiles perfectly at TILE_SIZE with 1:1 pixel mapping.
        const waterImg = this.add.image(px, py, 'tile_ground').setDepth(0).setDisplaySize(TILE_SIZE, TILE_SIZE);
        this.waterSprites[r][c] = waterImg;

        // Layer 2: Topmost tile (and optional alpha-mask overlay)
        const { key, depth, overlayKey, overlayDepth } = this.resolveTile(tile);
        // Apply Wang/crop variation to ALL layers including grass interior
        // and water so the map doesn't show identical repeating tiles.
        const displayKey = this.aiTileKeys.has(key)
          ? this.pickVariationKey(key, r, c)
          : key;
        const img = this.add.image(px, py, displayKey).setDepth(depth).setDisplaySize(TILE_SIZE, TILE_SIZE);
        this.tileSprites[r][c] = img;

        // Layer 3: Alpha-mask overlay (only for edge grass cells)
        if (overlayKey && this.textures.exists(overlayKey)) {
          const overlay = this.add.image(px, py, overlayKey)
            .setDepth(overlayDepth ?? depth + 0.01)
            .setDisplaySize(TILE_SIZE, TILE_SIZE);
          this.overlaySprites[r][c] = overlay;
        } else {
          this.overlaySprites[r][c] = null;
        }
      }
    }

    this.hoverOverlay = this.add.image(0, 0, 'tile_buildable_hover').setAlpha(0).setDepth(1).setDisplaySize(TILE_SIZE, TILE_SIZE);
  }

  /**
   * Return the best available variant texture key for a terrain tile.
   *
   * Priority: Wang tiles (corner-matched) > Wang tiles (random) > crop variants > base texture.
   *
   * @param baseKey      — the texture key (may be an alias like tile_buildable)
   * @param row          — grid row
   * @param col          — grid column
   * @param wangIndex    — (optional) explicit Wang tile index from corner mask.
   *                        When provided, uses this exact tile for seamless
   *                        edge matching. When omitted, picks randomly.
   */
  private pickVariationKey(
    baseKey: string,
    row: number,
    col: number,
    wangIndex?: number,
  ): string {
    // Resolve alias keys to their base terrain key for Wang lookup
    const terrainKey = ALIAS_TO_TERRAIN[baseKey] ?? baseKey;

    // 1. Wang tile sets: 16 seamless variants, 1:1 pixel mapping
    if (this.wangTerrainKeys.has(terrainKey)) {
      const WANG_COUNT = 16;
      const index = wangIndex !== undefined
        ? wangIndex % WANG_COUNT
        : ((row * 31 + col * 17 + this.mapData.seed) >>> 0) % WANG_COUNT;
      return `${terrainKey}_wang_${index}`;
    }

    // 2. Crop variants: 25 sub-textures from a 256×256 downscaled source
    if (this.aiTileKeys.has(baseKey)) {
      const tex = this.textures.get(baseKey);
      const src = tex?.source[0];
      if (src && (src.width > TILE_SIZE || src.height > TILE_SIZE)) {
        const cols = Math.floor(src.width / TILE_SIZE);
        const rows = Math.floor(src.height / TILE_SIZE);
        const index = ((row * 31 + col * 17 + this.mapData.seed) >>> 0) % (rows * cols);
        return `${baseKey}_crop_${index}`;
      }
    }

    // 3. Fallback: use the base texture as-is
    return baseKey;
  }

  /**
   * Generate random Wang corner colors for each grid intersection point.
   * Each vertex gets a random 0 or 1. Adjacent cells share vertices,
   * so tile edges always match seamlessly while the overall pattern
   * is randomly varied across the map.
   */
  private generateWangCorners(seed: number): void {
    const rng = createPRNG(seed + 0x5EED); // distinct seed from map generation
    for (let r = 0; r <= GRID_ROWS; r++) {
      this.wangCorners[r] = [];
      for (let c = 0; c <= GRID_COLS; c++) {
        this.wangCorners[r][c] = Math.floor(rng() * 2);
      }
    }
  }

  /**
   * Compute the Wang tile index from random corner colors at the 4
   * vertices surrounding grid cell (row, col).
   *
   *   TL───TR
   *    │     │
   *   BL───BR
   *
   * Index = tl*8 + tr*4 + br*2 + bl  (matches generate.mjs tileIndex formula)
   */
  private computeWangIndex(row: number, col: number): number {
    const tl = this.wangCorners[row][col];
    const tr = this.wangCorners[row][col + 1];
    const br = this.wangCorners[row + 1][col + 1];
    const bl = this.wangCorners[row + 1][col];
    return tl * 8 + tr * 4 + br * 2 + bl;
  }

  /**
   * Determine the texture key and depth for a tile's topmost layer.
   *
   * For edge grass cells, also returns an alpha-mask overlay that sits on
   * top of the Wang tile to hide grass in the water area.
   */
  private resolveTile(tile: GridTile): { key: string; depth: number; overlayKey?: string; overlayDepth?: number } {
    if (tile.type === 'spawn') {
      const mask = computeTerrainBlobMask(this.mapData.grid, tile.row, tile.col);
      return { key: mask === 15 ? 'tile_spawn' : transitionTileKey('spawn', mask), depth: 0.15 };
    }
    if (tile.type === 'goal') {
      const mask = computeTerrainBlobMask(this.mapData.grid, tile.row, tile.col);
      return { key: mask === 15 ? 'tile_goal' : transitionTileKey('goal', mask), depth: 0.15 };
    }
    if (tile.type === 'path') {
      const mask = computeBlobMask(this.mapData.grid, tile.row, tile.col);

      // Render a grass Wang tile underneath + alpha path overlay on top.
      // The Wang tile provides sharp 48×48 grass detail behind the path.
      const pathGrassWang = this.pickVariationKey('tile_buildable', tile.row, tile.col);
      const overlayKey = this.textures.exists(`tile_path_blob_overlay_${mask}`)
        ? `tile_path_blob_overlay_${mask}`
        : this.textures.exists(`tile_path_overlay_${mask}`)
          ? `tile_path_overlay_${mask}`
          : undefined;
      if (overlayKey) {
        return { key: pathGrassWang, depth: 0.15, overlayKey, overlayDepth: 0.2 };
      }
      // Fallback: no overlay available — use the old opaque path tile
      const blobAITileKey = `tile_path_blob_${mask}`;
      const key = this.textures.exists(blobAITileKey) ? blobAITileKey
        : this.textures.exists('tile_path') ? 'tile_path'
        : blobTileKey(mask);
      return { key, depth: 0.2 };
    }
    if (tile.type === 'buildable') {
      const cardinalMask = computeTerrainBlobMask(this.mapData.grid, tile.row, tile.col);

      // Interior (fully surrounded) or isolated: use Wang tile with
      // random vertex-assigned corner colors. Every adjacent cell shares
      // its vertex colours, so edges always match — but the tile pattern
      // is randomly varied across the map.
      if (cardinalMask === 0 || cardinalMask === 15) {
        const wangIndex = this.computeWangIndex(tile.row, tile.col);
        const displayKey = this.aiTileKeys.has('tile_buildable')
          ? this.pickVariationKey('tile_buildable', tile.row, tile.col, wangIndex)
          : 'tile_buildable';
        return { key: displayKey, depth: 0.1 };
      }

      // Edge cell: render a Wang tile underneath + alpha-mask overlay on top.
      // The Wang tile provides sharp 48×48 1:1 grass detail. The overlay is
      // transparent in the grass-blob area (letting the Wang tile show) and
      // shows the water texture outside (hiding the grass Wang tile in water).
      const edgeWangIndex = this.computeWangIndex(tile.row, tile.col);
      const edgeDisplayKey = this.aiTileKeys.has('tile_buildable')
        ? this.pickVariationKey('tile_buildable', tile.row, tile.col, edgeWangIndex)
        : 'tile_buildable';
      const alphaMaskKey = `tile_trans_alpha_grass_${cardinalMask}`;
      return {
        key: edgeDisplayKey,
        depth: 0.05,
        overlayKey: this.textures.exists(alphaMaskKey) ? alphaMaskKey : undefined,
        overlayDepth: 0.06,
      };
    }
    // Ground / water — use random vertex-based Wang tiles for varied
    // seamless tiling, just like interior grass cells.
    const wangIdx = this.computeWangIndex(tile.row, tile.col);
    return { key: `tile_water_wang_${wangIdx}`, depth: 0 };
  }

  /** Recompute and apply the correct tile texture and depth for a grid cell. */
  private refreshTileSprite(row: number, col: number): void {
    const sprite = this.tileSprites[row]?.[col];
    if (!sprite) return;
    const { key, depth, overlayKey, overlayDepth } = this.resolveTile(this.mapData.grid[row][col]);
    const displayKey = this.aiTileKeys.has(key)
      ? this.pickVariationKey(key, row, col)
      : key;
    sprite.setTexture(displayKey).setDepth(depth);

    // Update or destroy the overlay sprite
    const overlay = this.overlaySprites[row]?.[col];
    if (overlay) {
      if (overlayKey) {
        overlay.setTexture(overlayKey).setDepth(overlayDepth ?? depth + 0.01).setVisible(true);
      } else {
        overlay.setVisible(false);
      }
    } else if (overlayKey && this.textures.exists(overlayKey)) {
      const px = col * TILE_SIZE + TILE_SIZE / 2;
      const py = row * TILE_SIZE + TILE_SIZE / 2;
      const newOverlay = this.add.image(px, py, overlayKey)
        .setDepth(overlayDepth ?? depth + 0.01)
        .setDisplaySize(TILE_SIZE, TILE_SIZE);
      if (!this.overlaySprites[row]) this.overlaySprites[row] = [];
      this.overlaySprites[row][col] = newOverlay;
      if (this.uiCam) this.uiCam.ignore(newOverlay);
    }
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
    this.economy       = new EconomyManager(this, this._debug ? DEBUG_STARTING_GOLD : undefined);
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
    this.bottomBar = new BottomBar(this, this.economy);
    this.createFloatingAbilities();

    // Register all UI objects with the UI group for camera ignoring
    for (const obj of this.hud.getAllObjects()) {
      this.uiGroup.add(obj);
    }
    for (const obj of this.bottomBar.getAllObjects()) {
      this.uiGroup.add(obj);
    }
    for (const abtn of this.abilityFloating.values()) {
      this.uiGroup.add(abtn.bg);
      this.uiGroup.add(abtn.icon);
      this.uiGroup.add(abtn.cdOvl);
      this.uiGroup.add(abtn.cdTxt);
      this.uiGroup.add(abtn.cost);
      this.uiGroup.add(abtn.hit);
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

    this.createMinimap();
  }

  private setupCamera() {
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;

    // ── Main camera: renders the game world in the viewport between UI bars ──
    this.cameras.main.setBounds(0, 0, W, H);
    this.cameras.main.setZoom(0.85);
    this.cameras.main.setViewport(0, UI_TOP_HEIGHT, this.scale.width, this.scale.height - UI_TOP_HEIGHT - UI_BOTTOM_HEIGHT);
    // Main camera ignores UI objects
    this.cameras.main.ignore(this.uiGroup);

    // ── UI camera: renders UI over the full canvas, no scroll/zoom ──────────
    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.uiCam.setScroll(0, 0);
    this.uiCam.setZoom(1);

    // Tell the ability system about the UI camera so its VFX are ignored
    this.abilitySystem.setUICam(this.uiCam);

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

    // Overlay sprites (edge grass alpha masks)
    for (const row of this.overlaySprites) {
      for (const overlay of row) {
        if (overlay) this.uiCam.ignore(overlay);
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
    // Mouse wheel zoom – zoom toward cursor position
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _go: unknown, _dx: number, dy: number) => {
      const cam = this.cameras.main;
      const oldZoom = cam.zoom;
      const newZoom = Phaser.Math.Clamp(oldZoom - dy * 0.001, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
      if (oldZoom === newZoom) return;

      // Cursor position relative to viewport center
      // Derived from Camera.preRender: worldX = scrollX + w/2 + (vpX - w/2) / zoom
      const toCenterX = pointer.x - cam.width / 2;
      const toCenterY = (pointer.y - UI_TOP_HEIGHT) - cam.height / 2;

      const scaleDiff = (1 / oldZoom) - (1 / newZoom);

      cam.scrollX += toCenterX * scaleDiff;
      cam.scrollY += toCenterY * scaleDiff;

      cam.setZoom(newZoom);
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
    kb.on('keydown-SPACE', () => this.waveManager.sendEarlyWave());
    kb.on('keydown-P', () => this.togglePause());
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

    this.events.on('toggle_pause', () => this.togglePause());
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
    if (p.y < UI_TOP_HEIGHT || p.y >= this.scale.height - UI_BOTTOM_HEIGHT) return;

    // ── HERO SELECTION: highest priority ──────────────────────────────────
    if (!this.placingTower && !this.placingBarricade) {
      const heroBounds = this.hero.getBounds();
      // Expand bounds slightly for easier clicking
      const pad = 10;
      if (wx >= heroBounds.left - pad && wx <= heroBounds.right + pad &&
          wy >= heroBounds.top  - pad && wy <= heroBounds.bottom + pad) {
        // Toggle hero selection.  Clicking the hero a second time deselects it.
        this.heroSelected = !this.heroSelected;
        this.hero.setSelected(this.heroSelected);
        // Deselect any tower when selecting the hero
        if (this.heroSelected) {
          this.selectedTower?.showRange(false);
          this.selectedTower = null;
          this.bottomBar.showBuildMode();
        }
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

      // Hero movement (only when selected; hero stays selected after moving)
      if (this.heroSelected) {
        if (tile.type !== 'ground') {
          this.hero.moveTo(wx, wy);
        }
        return;
      }

      // Clicking any empty tile deselects the tower
      this.deselectTower();
      return;
    }

    // Placing tower
    if (this.placingTower) {
      if (tile.type !== 'buildable') return;
      if (this.synergySystem.getTowerAt(col, row)) return;
      const def = TOWER_DEFS[this.placingTower];
      if (!this.economy.spend(def.baseCost)) return;
      this.placeTower(this.placingTower, col, row);
      // Deselect hero when placing a tower
      this.heroSelected = false;
      this.hero.setSelected(false);
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
    if (p.y < UI_TOP_HEIGHT || p.y >= this.scale.height - UI_BOTTOM_HEIGHT) {
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

  // ─── Pause ───────────────────────────────────────────────────────────────
  private togglePause() {
    this.isPaused = !this.isPaused;
    if (this.isPaused) {
      this.physics.pause();
    } else {
      this.physics.resume();
    }
    this.hud.setPaused(this.isPaused);
  }

  // ─── Minimap ─────────────────────────────────────────────────────────────
  private initResizeHandler() {
    const applyLayout = (W: number, H: number) => {
      // Update camera viewport
      this.cameras.main.setViewport(0, UI_TOP_HEIGHT, W, H - UI_TOP_HEIGHT - UI_BOTTOM_HEIGHT);

      // Update UI camera
      this.uiCam.setSize(W, H);

      // Update minimap position (right edge)
      this.minimapX = W - 208;

      // Redraw HUD and bottom bar
      this.hud.resize(W, H);
      this.bottomBar.resize(W, H);
    };

    this.scale.on('resize', (size: Phaser.Structs.Size) => {
      applyLayout(size.width, size.height);
    });

    // Apply initial layout directly (don't emit through scale — would confuse WebGLRenderer)
    applyLayout(this.scale.width, this.scale.height);
  }

  private createMinimap() {
    // Position at top-right (will be updated on resize)
    this.minimapX = this.scale.width - 208;
    const MM_X = this.minimapX;
    const MM_Y = this.minimapY;
    const MM_W = this.minimapW;
    const MM_H = this.minimapH;
    const MM_PAD = 2;

    // Background panel (transparent, brighter)
    this.minimapBg = this.add.graphics().setScrollFactor(0).setDepth(60);
    this.minimapBg.fillStyle(0x0a1a2a, 0.35);
    this.minimapBg.fillRect(MM_X - MM_PAD, MM_Y - MM_PAD, MM_W + MM_PAD * 2, MM_H + MM_PAD * 2);
    this.minimapBg.lineStyle(1, 0x5a8aaa, 0.6);
    this.minimapBg.strokeRect(MM_X - MM_PAD, MM_Y - MM_PAD, MM_W + MM_PAD * 2, MM_H + MM_PAD * 2);
    this.uiGroup.add(this.minimapBg);

    // Pre-render map tiles to a static texture
    const mmG = this.add.graphics();
    const tileW = MM_W / GRID_COLS;
    const tileH = MM_H / GRID_ROWS;
    const TYPE_COLORS: Record<string, number> = {
      ground:    0x142a4a,
      path:      0x6a5a3a,
      buildable: 0x2a5030,
      spawn:     0x8a2e2e,
      goal:      0x2e7a2e,
    };
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tile = this.mapData.grid[r][c];
        mmG.fillStyle(TYPE_COLORS[tile.type] ?? 0x0b1628, 1);
        mmG.fillRect(c * tileW, r * tileH, tileW + 0.5, tileH + 0.5);
      }
    }
    mmG.generateTexture('__minimap_static__', MM_W, MM_H);
    mmG.destroy();

    this.minimapMapImg = this.add.image(MM_X, MM_Y, '__minimap_static__')
      .setOrigin(0, 0).setScrollFactor(0).setDepth(61);
    this.uiGroup.add(this.minimapMapImg);

    // Viewport indicator (redrawn every frame)
    this.minimapViewport = this.add.graphics().setScrollFactor(0).setDepth(62);
    this.uiGroup.add(this.minimapViewport);

    // Invisible hit area for click-to-pan
    this.minimapHitArea = this.add.rectangle(
      MM_X + MM_W / 2, MM_Y + MM_H / 2, MM_W, MM_H, 0, 0,
    ).setScrollFactor(0).setDepth(63).setInteractive({ useHandCursor: true });
    this.minimapHitArea.on('pointerdown', (p: Phaser.Input.Pointer) => this.onMinimapClick(p.x, p.y));
    this.minimapHitArea.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (p.isDown) this.onMinimapClick(p.x, p.y);
    });
    this.uiGroup.add(this.minimapHitArea);
  }

  // ─── Floating Ability Buttons (top-left) ─────────────────────────────
  private createFloatingAbilities() {
    const BTN_SIZE = 44;
    const GAP = 6;
    const startX = 8;
    const startY = UI_TOP_HEIGHT + 8;
    const D = 60;
    const r = 10; // icon radius

    ABILITY_DEFS.forEach((def, i) => {
      const cx = startX + BTN_SIZE / 2;
      const cy = startY + i * (BTN_SIZE + GAP) + BTN_SIZE / 2;

      const bg = this.add.graphics().setScrollFactor(0).setDepth(D);
      const icon = this.add.graphics().setScrollFactor(0).setDepth(D + 1);
      const cdOvl = this.add.graphics().setScrollFactor(0).setDepth(D + 2);
      const cdTxt = this.add.text(cx, cy, '', {
        fontSize: '14px', fontFamily: 'monospace', color: '#ffffff', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 3);
      const cost = this.add.text(cx, cy + BTN_SIZE / 2 + 4, `${def.cost}g`, {
        fontSize: '9px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 1);

      // Draw button background
      const drawBtn = (hover: boolean, selected: boolean) => {
        bg.clear();
        const fill = selected ? 0x2a4a6a : hover ? 0x2a5080 : 0x1a2a3a;
        bg.fillStyle(fill, 0.85);
        bg.fillRoundedRect(cx - BTN_SIZE / 2, cy - BTN_SIZE / 2, BTN_SIZE, BTN_SIZE, 5);
        bg.lineStyle(selected ? 2 : 1, def.color, selected ? 1 : 0.5);
        bg.strokeRoundedRect(cx - BTN_SIZE / 2, cy - BTN_SIZE / 2, BTN_SIZE, BTN_SIZE, 5);

        icon.clear();
        this.drawAbilityFloatingIcon(icon, cx, cy, def.color, def.type, r);
      };

      drawBtn(false, false);

      const hit = this.add.rectangle(cx, cy, BTN_SIZE, BTN_SIZE, 0, 0)
        .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 4);
      hit.on('pointerover', () => drawBtn(true, this.abilitySystem.pendingCast === def.type));
      hit.on('pointerout', () => drawBtn(false, this.abilitySystem.pendingCast === def.type));
      hit.on('pointerup', () => this.abilitySystem.selectAbility(def.type));

      this.abilityFloating.set(def.type, { bg, icon, cdOvl, cdTxt, cost, hit });
    });

    // Listen for selection changes to update border
    this.events.on('ability_selected', (type: AbilityType | null) => {
      ABILITY_DEFS.forEach((def, i) => {
        const btn = this.abilityFloating.get(def.type);
        if (!btn) return;
        const isSelected = def.type === type;
        const cx = startX + BTN_SIZE / 2;
        const cy = startY + i * (BTN_SIZE + GAP) + BTN_SIZE / 2;

        btn.bg.clear();
        btn.bg.fillStyle(isSelected ? 0x2a4a6a : 0x1a2a3a, 0.85);
        btn.bg.fillRoundedRect(cx - BTN_SIZE / 2, cy - BTN_SIZE / 2, BTN_SIZE, BTN_SIZE, 5);
        btn.bg.lineStyle(isSelected ? 2 : 1, def.color, isSelected ? 1 : 0.5);
        btn.bg.strokeRoundedRect(cx - BTN_SIZE / 2, cy - BTN_SIZE / 2, BTN_SIZE, BTN_SIZE, 5);

        btn.icon.clear();
        this.drawAbilityFloatingIcon(btn.icon, cx, cy, def.color, def.type, r);
      });
    });
  }

  /** Draw the icon symbol for a floating ability button (copied from BottomBar). */
  private drawAbilityFloatingIcon(g: Phaser.GameObjects.Graphics, cx: number, cy: number, color: number, type: AbilityType, r: number) {
    g.fillStyle(color, 0.9);
    g.lineStyle(1.5, 0xffffff, 0.4);
    switch (type) {
      case 'freeze': {
        for (let a = 0; a < 6; a++) {
          const angle = (a * Math.PI) / 3;
          g.lineBetween(cx, cy, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
          const mx = cx + Math.cos(angle) * r * 0.6;
          const my = cy + Math.sin(angle) * r * 0.6;
          g.lineBetween(mx, my, mx + Math.cos(angle + 1) * r * 0.3, my + Math.sin(angle + 1) * r * 0.3);
        }
        g.fillCircle(cx, cy, 3);
        break;
      }
      case 'meteor': {
        const ax = Math.PI * 0.75;
        g.fillTriangle(
          cx + Math.cos(ax) * r * 1.4, cy + Math.sin(ax) * r * 1.4,
          cx + Math.cos(ax + 2.4) * r * 0.5, cy + Math.sin(ax + 2.4) * r * 0.5,
          cx + Math.cos(ax - 2.4) * r * 0.5, cy + Math.sin(ax - 2.4) * r * 0.5,
        );
        g.fillStyle(0xffcc44, 0.9);
        g.fillCircle(cx, cy, r * 0.55);
        g.fillStyle(0xffffff, 0.5);
        g.fillCircle(cx - 3, cy - 3, r * 0.2);
        break;
      }
      case 'lightning_storm': {
        const pts = [
          { x: cx + 4, y: cy - r }, { x: cx - 2, y: cy - 3 },
          { x: cx + 3, y: cy - 3 }, { x: cx - 5, y: cy + r },
          { x: cx + 1, y: cy + 2 }, { x: cx - 3, y: cy + 2 },
        ];
        g.fillPoints(pts, true);
        g.fillStyle(0xffffff, 0.4);
        g.fillTriangle(cx + 4, cy - r, cx - 2, cy - 3, cx + 1, cy - 4);
        break;
      }
      case 'heal_aura': {
        g.strokeCircle(cx, cy, r);
        g.lineStyle(2, color, 0.7);
        g.lineBetween(cx - r * 0.7, cy - r * 0.7, cx + r * 0.7, cy + r * 0.7);
        g.lineBetween(cx + r * 0.7, cy - r * 0.7, cx - r * 0.7, cy + r * 0.7);
        g.fillStyle(color, 0.3);
        g.fillCircle(cx, cy, r * 0.5);
        g.lineStyle(2, 0xffffff, 0.8);
        g.lineBetween(cx, cy, cx + r * 0.5, cy - r * 0.3);
        g.lineBetween(cx, cy, cx, cy + r * 0.6);
        break;
      }
    }
  }

  private updateFloatingAbilities() {
    const BTN_SIZE = 44;
    const GAP = 6;
    const startX = 8;
    const startY = UI_TOP_HEIGHT + 8;

    ABILITY_DEFS.forEach((def, i) => {
      const btn = this.abilityFloating.get(def.type);
      if (!btn) return;
      const cx = startX + BTN_SIZE / 2;
      const cy = startY + i * (BTN_SIZE + GAP) + BTN_SIZE / 2;

      const cd = this.abilitySystem.getCooldown(def.type);
      btn.cdOvl.clear();
      if (cd.remaining > 0) {
        const frac = cd.remaining / cd.total;
        btn.cdOvl.fillStyle(0x000000, 0.65 * frac);
        btn.cdOvl.fillRoundedRect(cx - BTN_SIZE / 2 + 2, cy - BTN_SIZE / 2 + 2, BTN_SIZE - 4, (BTN_SIZE - 4) * frac, 4);
        btn.cdTxt.setText(`${Math.ceil(cd.remaining / 1000)}s`);
      } else {
        btn.cdTxt.setText('');
      }
    });
  }

  private updateMinimap() {
    const cam = this.cameras.main;
    const mapW = GRID_COLS * TILE_SIZE;
    const mapH = GRID_ROWS * TILE_SIZE;
    const vpW  = this.scale.width;
    const vpH  = this.scale.height - UI_TOP_HEIGHT - UI_BOTTOM_HEIGHT;

    // Show minimap only when the map doesn't fully fit in the viewport
    const mmFitZoom = Math.min(vpW / mapW, vpH / mapH);
    const show = cam.zoom > mmFitZoom * 1.02;

    this.minimapBg.setVisible(show);
    this.minimapMapImg.setVisible(show);
    this.minimapViewport.setVisible(show);
    this.minimapHitArea.setVisible(show);

    if (!show) return;

    const scaleX = this.minimapW / mapW;
    const scaleY = this.minimapH / mapH;

    // Use cam.worldView for accurate clamped viewport bounds
    const wv = cam.worldView;
    const rx = this.minimapX + wv.left * scaleX;
    const ry = this.minimapY + wv.top  * scaleY;
    const rw = Math.min(wv.width  * scaleX, this.minimapW);
    const rh = Math.min(wv.height * scaleY, this.minimapH);

    this.minimapViewport.clear();
    this.minimapViewport.fillStyle(0xffffff, 0.08);
    this.minimapViewport.fillRect(rx, ry, rw, rh);
    this.minimapViewport.lineStyle(1, 0xffffff, 0.85);
    this.minimapViewport.strokeRect(rx, ry, rw, rh);
  }

  private onMinimapClick(screenX: number, screenY: number) {
    const mmRelX = Phaser.Math.Clamp(screenX - this.minimapX, 0, this.minimapW);
    const mmRelY = Phaser.Math.Clamp(screenY - this.minimapY, 0, this.minimapH);
    const mapW = GRID_COLS * TILE_SIZE;
    const mapH = GRID_ROWS * TILE_SIZE;
    const worldX = (mmRelX / this.minimapW) * mapW;
    const worldY = (mmRelY / this.minimapH) * mapH;
    const cam = this.cameras.main;
    // Center camera on clicked world position using worldView for accurate half-sizes
    cam.scrollX = worldX - cam.worldView.width  / 2;
    cam.scrollY = worldY - cam.worldView.height / 2;
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
    if (this.isPaused) return;

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
    this.updateFloatingAbilities();

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

    this.updateMinimap();
  }
}
