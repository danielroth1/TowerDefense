import Phaser from 'phaser';
import { generateMap, type MapData, type GridTile } from '../systems/MapGenerator';
import { computeBlobMask, blobTileKey } from '../systems/BlobTileset';
import { computeTerrainBlobMask } from '../systems/TerrainTransition';
import { Tower } from '../entities/Tower';
import { Enemy } from '../entities/Enemy';
import { Projectile, type ProjectileConfig } from '../entities/Projectile';
import { Hero } from '../entities/Hero';
import { Barricade } from '../entities/Barricade';
import { EconomyManager } from '../systems/EconomyManager';
import { EconomySimulation } from '../systems/EconomySimulation';
import { TransportSystem } from '../systems/TransportSystem';
import { EconomyBuilding } from '../entities/EconomyBuilding';
import type { EconomyBuildingType } from '../data/economy';
import { ECO_BUILDING_DEFS, ECO_BUILDING_TYPES, escalatedCost } from '../data/economy';
import { WaveManager } from '../systems/WaveManager';
import { AbilitySystem } from '../systems/AbilitySystem';
import { SynergySystem } from '../systems/SynergySystem';
import { WeatherSystem } from '../systems/WeatherSystem';
import { ComboSystem } from '../systems/ComboSystem';
import { HUD } from '../ui/HUD';
import { BottomBar } from '../ui/BottomBar';
import { SoundSystem } from '../systems/SoundSystem';
import { generateCityDecorations, type DecorationPlacement } from '../systems/CityDecorator';
import { drawCityRoads, generateCityRoadsIncremental, type RoadNetworkState } from '../systems/CityRoadNetwork';
import { PerfTest } from '../systems/PerfTest';
import { EnemyGrid } from '../systems/EnemyGrid';
import { HPBarPool } from '../systems/HPBarPool';
import { createPRNG } from '../utils/helpers';
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, COLORS,
  MAX_BARRICADES, BARRICADE_COST, TOTAL_WAVES,
  UI_TOP_HEIGHT,
  DEBUG_STARTING_GOLD,
  CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM,
} from '../utils/constants';
import type { TowerType } from '../data/towers';
import { TOWER_DEFS, TOWER_TYPES_ORDERED } from '../data/towers';
import { ABILITY_DEFS, type AbilityType } from '../data/abilities';
import { HOTKEYS } from '../data/hotkeys';

/** Unique background fill per ability (themed visuals, Phase 6). */
const ABILITY_FILL: Record<AbilityType, number> = {
  freeze:          0x0a1a3a,
  meteor:          0x2a0800,
  lightning_storm: 0x160a28,
  heal_aura:       0x0a1a0a,
};
const ABILITY_BORDER: Record<AbilityType, number> = {
  freeze:          0x99ddff,
  meteor:          0xff5500,
  lightning_storm: 0xaa44ff,
  heal_aura:       0x44ff88,
};

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
  private economySim!: EconomySimulation;
  private transportSys!: TransportSystem;
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
  private cityRoadGraphics: Phaser.GameObjects.Graphics | null = null;

  // Cart pathfinding debug overlay (toggled with V in debug mode)
  private cartDebugGraphics: Phaser.GameObjects.Graphics | null = null;
  private cartDebugText: Phaser.GameObjects.Text | null = null;

  /** Persistent road network state for incremental updates.
   *  Stored so that unchanged road segments retain their noise. */
  private roadNetworkState: RoadNetworkState | null = null;

  // Cells occupied by city decorations — blocks tower placement
  private decorationBlockedCells: Set<string> = new Set();

  /** Stored decorative placements for road regeneration (avoid re-running
   *  CityDecorator on a mutated grid after economy building placement). */
  private decoPlacements: DecorationPlacement[] = [];

  // Interaction state
  private placingTower: TowerType | null = null;
  private placingBarricade: boolean = false;
  private placingEconomy: EconomyBuildingType | null = null;
  private economyBuildings: EconomyBuilding[] = [];
  private hoverOverlay!: Phaser.GameObjects.Image;
  private selectedTower: Tower | null = null;
  private selectedEcoBuilding: EconomyBuilding | null = null;

  // Touch gesture state
  private pinchActive: boolean = false;
  private dragActive: boolean = false;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private dragMoved: boolean = false;
  private pinchStartDist: number = 0;
  private pinchStartZoom: number = 1;
  private lastPinchMidX: number = 0;
  private lastPinchMidY: number = 0;

  // Stats
  private totalKills: number = 0;
  private barricadeCount: number = 0;

  // Spatial grid for efficient enemy lookups
  private enemyGrid!: EnemyGrid;
  /** Pooled HP bar renderer — 2 shared Graphics for all enemies. */
  private hpBarPool!: HPBarPool;
  /** Cached boss enemy reference (avoids full scan each frame). */
  private currentBoss: Enemy | null = null;

  // Reusable VFX graphics object pool
  private vfxPool: Phaser.GameObjects.Graphics[] = [];
  private vfxPoolIndex: number = 0;
  private readonly VFX_POOL_SIZE = 16;

  // Pause
  private isPaused: boolean = false;

  // Win condition — set when all waves have been dispatched, checked each frame
  // while enemies remain alive; the victory screen only appears once every enemy
  // sprite is destroyed.
  private allWavesCompleted: boolean = false;

  // Current bottom bar height (updated on resize)
  private _barH: number = 200;

  // Ability button sizing (updated on resize)
  private _abilityBtnSize = 62;
  private _abilityGap     = 8;
  private readonly _abilityStartX = 12;
  private readonly _abilityStartY = 8;

  // Floating ability buttons
  private abilityFloating: Map<AbilityType, {
    bg: Phaser.GameObjects.Graphics;
    icon: Phaser.GameObjects.Image;
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
  private readonly minimapY = 56;
  private minimapW = 200;   // display width — updated per resize (15% of screen)
  private minimapH = 103;   // display height — updated per resize

  constructor() { super('GameScene'); }

  init(data: { seed: number; seedStr?: string; debug?: boolean; perfTest?: boolean }) {
    this.mapData = generateMap(data.seed ?? 12345);
    this._debug = data.debug ?? false;
    this._perfTest = data.perfTest ?? false;
  }
  private _debug: boolean = false;
  private _perfTest: boolean = false;

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

    // Create economy systems early — markets from city decorations need them
    this.economy    = new EconomyManager(this, this._debug ? DEBUG_STARTING_GOLD : undefined);
    this.economySim = new EconomySimulation(this.economy, this);
    this.economySim.setGrid(this.mapData.grid);
    this.transportSys = new TransportSystem(this, this.economySim);
    this.economySim.setTransportSystem(this.transportSys);
    this.transportSys.setGrid(this.mapData.grid);

    this.placeCityDecorations();
    this.createGroups();
    this.createHero();
    this.createSystems();
    // Spatial grid for enemy lookups — rebuilt each frame in update()
    this.enemyGrid = new EnemyGrid();
    this.createUI();
    this.setupCamera();
    // Pooled HP bar renderer (replaces 2 Graphics per enemy with 2 shared)
    this.hpBarPool = new HPBarPool(this);
    // VFX graphics pool (after setupCamera so uiCam is available)
    this.vfxPool = [];
    this.vfxPoolIndex = 0;
    for (let i = 0; i < this.VFX_POOL_SIZE; i++) {
      const g = this.add.graphics().setVisible(false);
      if (this.uiCam) this.uiCam.ignore(g);
      this.vfxPool.push(g);
    }
    // Ignore HP bar pool graphics on UI camera
    if (this.uiCam) {
      for (const g of this.hpBarPool.getGraphics()) this.uiCam.ignore(g);
    }
    this.setupInput();
    this.registerEvents();
    this.initResizeHandler();

    // Sound init on first interaction — disable BGM by default in debug mode
    this.sfx.init({ musicEnabled: false });

    // Perf test: fill every buildable tile with a random tower + spawn 200 enemies
    if (this._perfTest) {
      new PerfTest(
        this, this.mapData, this.decorationBlockedCells,
        this.synergySystem, this.enemyGroup, this.flyerGroup,
        this.uiCam, (type, col, row) => this.placeTower(type, col, row),
      ).run();
      this.hud.enablePerfStats();
    }

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
    if (tile.type === 'spawn' || tile.type === 'goal') {
      // Render a grass Wang tile underneath + spawn/goal design as overlay.
      // Same two-layer pattern as paths: the Wang tile provides terrain
      // underneath, and the spawn/goal PNG (with RGBA transparency) sits
      // on top, letting the grass show through transparent areas.
      const grassKey = this.pickVariationKey('tile_buildable', tile.row, tile.col);
      const designKey = tile.type === 'spawn' ? 'tile_spawn' : 'tile_goal';
      return { key: grassKey, depth: 0.1, overlayKey: designKey, overlayDepth: 0.15 };
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
        return { key: pathGrassWang, depth: 0.13, overlayKey, overlayDepth: 0.2 };
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
    // Ground / water — use vertex-based Wang tiles via pickVariationKey
    // so the Wang tile set is properly resolved (matching interior grass).
    const waterWangIdx = this.computeWangIndex(tile.row, tile.col);
    const waterKey = this.aiTileKeys.has('tile_water')
      ? this.pickVariationKey('tile_water', tile.row, tile.col, waterWangIdx)
      : 'tile_ground';
    return { key: waterKey, depth: 0 };
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

  /** Place city building decorations and mark cells as non-buildable. */
  private placeCityDecorations(): void {
    const result = generateCityDecorations(this.mapData.grid, this.mapData.seed);

    // Store placements for later road regeneration (avoids re-running
    // CityDecorator on a grid mutated by economy building placement).
    this.decoPlacements = result.placements;

    for (const p of result.placements) {
      const px = (p.col + p.w / 2) * TILE_SIZE;
      const py = (p.row + p.h / 2) * TILE_SIZE;

      const rng = createPRNG(this.mapData.seed + p.row * GRID_COLS + p.col);
      const sizeVar = 0.95 + rng() * 0.10;
      const displayW = p.w * TILE_SIZE * sizeVar;
      const displayH = p.h * TILE_SIZE * sizeVar;
      const rotation = (rng() - 0.5) * 0.06;

      if (p.isEcoMarket) {
        // Create an invisible economy building for the simulation
        // (the sprite above handles visuals). Markets are not player-buildable
        // — they only exist as pre-placed decorations.
        const market = new EconomyBuilding(this, p.col, p.row, 'market');
        market.setAlpha(0); // Hidden — the decorative sprite is the visual
        this.economyBuildings.push(market);
        this.economySim.addBuilding(market);
        if (this.uiCam) this.uiCam.ignore(market);
      }

      const sprite = this.add.image(px, py, p.textureKey)
        .setDepth(p.depth)
        .setDisplaySize(displayW, displayH)
        .setRotation(rotation);

      this.wallDecorations.push(sprite);
    }

    // Track decoration cells so tower placement is blocked without
    // changing the tile type (keeps grass rendering underneath).
    this.decorationBlockedCells = result.blockedCells;

    // Set transport system buildings now that markets are created
    this.transportSys.setBuildings(this.economyBuildings);

    // Generate decorative roads between buildings
    if (result.placements.length >= 2) {
      const { result: roadResult, state } = generateCityRoadsIncremental(
        this.mapData.grid,
        result.placements,
        result.blockedCells,
        this.mapData.seed,
        null, // no previous state — first generation
      );
      this.roadNetworkState = state;
      if (roadResult.roads.length > 0) {
        const roadG = this.add.graphics().setDepth(0.14);
        const roadRng = createPRNG(this.mapData.seed + 0xC0DE);
        drawCityRoads(roadG, roadResult, roadRng);
        this.cityRoadGraphics = roadG;
        // Wire road grid to transport system for cart pathfinding
        this.transportSys.setRoadGrid(state.roadGrid);
      }
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
    // economy, economySim, transportSys are created before placeCityDecorations
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

    this.hud = new HUD(this, this._debug, this.weatherSystem);
    this.bottomBar = new BottomBar(this, this.economy, this.economySim);
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
      this.placingEconomy = null;
    };

    this.bottomBar.onPlaceEconomy = (type) => {
      this.placingEconomy = type;
      this.placingTower = null;
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

    this.bottomBar.onSellEco = () => {
      if (!this.selectedEcoBuilding) return;
      const b = this.selectedEcoBuilding;
      this.economy.earn(b.sellValue());
      // Restore occupied tiles to their original types
      const def = b.def;

      if (def.placement.straddlesWater) {
        // Land cell is always at (gridRow, gridCol) — restore it to buildable.
        this.mapData.grid[b.gridRow][b.gridCol].type = 'buildable';
        this.refreshTileSprite(b.gridRow, b.gridCol);
      } else {
        for (let dr = 0; dr < def.height; dr++) {
          for (let dc = 0; dc < def.width; dc++) {
            this.mapData.grid[b.gridRow + dr][b.gridCol + dc].type = 'buildable';
            this.refreshTileSprite(b.gridRow + dr, b.gridCol + dc);
          }
        }
      }
      // Remove from tracking arrays
      const idx = this.economyBuildings.indexOf(b);
      if (idx >= 0) this.economyBuildings.splice(idx, 1);
      this.economySim.removeBuilding(b);
      this.transportSys.setBuildings(this.economyBuildings);
      this.selectedEcoBuilding = null;
      this.regenerateAllRoads();
      this.bottomBar.showBuildMode();
    };

    this.bottomBar.onUpgradeEco = () => {
      if (!this.selectedEcoBuilding) return;
      const cost = this.selectedEcoBuilding.upgradeCost();
      if (!this.economy.spend(cost)) return;
      const type = this.selectedEcoBuilding.buildingType;
      this.sfx.play('tower_place');
      this.selectedEcoBuilding.upgrade();

      // Fishery upgrade: spawn additional ship
      if (type === 'fishery') {
        this.economySim.onFisheryUpgraded(this.selectedEcoBuilding);
        // Ignore new ships on UI camera
        const ships = this.economySim.getAllFisherShips(this.selectedEcoBuilding);
        for (const ship of ships) {
          if (this.uiCam) this.uiCam.ignore(ship);
        }
      }

      // Market upgrade: update decorative sprite texture
      if (type === 'market') {
        this.updateMarketDecoSprite(this.selectedEcoBuilding);
      }

      this.bottomBar.showEconomyMode(this.selectedEcoBuilding);
    };

    this.bottomBar.onSendWave = () => this.waveManager.sendEarlyWave();

    this.createMinimap();
  }

  private setupCamera() {
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;

    // ── Main camera: renders the game world in the viewport between UI bars ──
    this.cameras.main.setBounds(0, 0, W, H);
    this.cameras.main.setZoom(1.75);
    this.cameras.main.setViewport(0, 0, this.scale.width, this.scale.height - this.bottomBar.barHeight);
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

    // Decorative city roads (static graphics)
    if (this.cityRoadGraphics) this.uiCam.ignore(this.cityRoadGraphics);

    // Economy buildings
    for (const b of this.economyBuildings) {
      this.uiCam.ignore(b);
    }

    // Cart sprites & money text are world-space; transport system ignores
    // each one on the UI camera as it's dynamically created
    if (this.transportSys) this.transportSys.setUICam(this.uiCam);
  }

  private setupInput() {
    const DRAG_THRESHOLD = 8; // px — must move this far before it counts as a drag

    // ── Touch gesture detection ──────────────────────────────────────────
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      // Count active pointers
      const active = this.input.manager.pointers.filter(pt => pt.isDown).length;

      if (active >= 2) {
        // Pinch start: cancel any in-progress drag and begin pinch
        this.dragActive = false;
        this.dragMoved = false;
        this.pinchActive = true;
        const p0 = this.input.manager.pointers[0];
        const p1 = this.input.manager.pointers[1];
        this.pinchStartDist = Phaser.Math.Distance.Between(p0.x, p0.y, p1.x, p1.y);
        this.pinchStartZoom = this.cameras.main.zoom;
        this.lastPinchMidX = (p0.x + p1.x) / 2;
        this.lastPinchMidY = (p0.y + p1.y) / 2;
      } else if (active === 1) {
        // Potential drag start — only in game area (not bottom bar, not settings)
        if (p.y >= this.scale.height - this._barH) return;
        if (this.hud.isSettingsOpen) return;
        // Don't start drag on minimap (it has its own pointer handlers)
        const mmRight  = this.minimapX + this.minimapW;
        const mmBottom = this.minimapY + this.minimapH;
        if (p.x >= this.minimapX && p.x <= mmRight && p.y >= this.minimapY && p.y <= mmBottom) return;
        // Don't start drag on ability buttons
        if (this.isClickOnAbilityButton(p)) return;

        this.dragActive = true;
        this.dragMoved = false;
        this.dragStartX = p.x;
        this.dragStartY = p.y;
      }
    });

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

    // Camera drag (middle mouse) + touch drag + pinch zoom
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const cam = this.cameras.main;

      // ── Pinch zoom (2+ pointers) ────────────────────────────────────
      if (this.pinchActive) {
        const activePtrs = this.input.manager.pointers.filter(pt => pt.isDown);
        if (activePtrs.length >= 2) {
          const p0 = activePtrs[0];
          const p1 = activePtrs[1];
          const newDist = Phaser.Math.Distance.Between(p0.x, p0.y, p1.x, p1.y);
          if (this.pinchStartDist > 0) {
            const newZoom = Phaser.Math.Clamp(
              this.pinchStartZoom * (newDist / this.pinchStartDist),
              CAMERA_MIN_ZOOM,
              CAMERA_MAX_ZOOM,
            );
            if (newZoom !== cam.zoom) {
              const oldZoom = cam.zoom;
              // Zoom toward the midpoint between the two pointers
              const midX = (p0.x + p1.x) / 2;
              const midY = (p0.y + p1.y) / 2;
              const toCenterX = midX - cam.width / 2;
              const toCenterY = midY - cam.height / 2;
              const scaleDiff = (1 / oldZoom) - (1 / newZoom);
              cam.scrollX += toCenterX * scaleDiff;
              cam.scrollY += toCenterY * scaleDiff;
              cam.setZoom(newZoom);
            }
            // Also pan if the midpoint moved (Google Maps style)
            const midDX = (p0.x + p1.x) / 2 - this.lastPinchMidX;
            const midDY = (p0.y + p1.y) / 2 - this.lastPinchMidY;
            cam.scrollX -= midDX / cam.zoom;
            cam.scrollY -= midDY / cam.zoom;
            this.lastPinchMidX = (p0.x + p1.x) / 2;
            this.lastPinchMidY = (p0.y + p1.y) / 2;
          }
        }
        this.updateHoverTile(p);
        return;
      }

      // ── Middle-mouse drag (desktop) ──────────────────────────────────
      if (p.middleButtonDown()) {
        cam.scrollX -= p.velocity.x / cam.zoom;
        cam.scrollY -= p.velocity.y / cam.zoom;
      }

      // ── One-finger touch drag ────────────────────────────────────────
      // Only apply drag when exactly 1 pointer is down (not during pinch)
      if (this.dragActive && !this.pinchActive && p.isDown &&
          this.input.manager.pointers.filter(pt => pt.isDown).length < 2) {
        const dx = p.x - this.dragStartX;
        const dy = p.y - this.dragStartY;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
          this.dragMoved = true;
        }
        if (this.dragMoved) {
          // Delta-based panning: finger stays attached to the same world point
          // (Google Maps style — 1:1 screen-to-world tracking)
          cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
          cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
        }
      }

      this.updateHoverTile(p);
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onPointerUp(p));

    // ── Clean up touch gesture state on any pointer release ─────────────
    this.input.on('pointerup', () => {
      const active = this.input.manager.pointers.filter(pt => pt.isDown).length;
      if (active < 2) {
        // Only reset pinch if fewer than 2 pointers remain down
        this.pinchActive = false;
      }
      if (active === 0) {
        this.dragActive = false;
        // dragMoved is consumed in onPointerUp, so don't reset here
      }
    });

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
    // Cart pathfinding debug overlay (debug mode only)
    if (this._debug) {
      kb.on('keydown-V', () => {
        this.transportSys.cartDebugEnabled = !this.transportSys.cartDebugEnabled;
        this.hud.setCartDebugLabel(this.transportSys.cartDebugEnabled);
        if (!this.transportSys.cartDebugEnabled) {
          this.cartDebugGraphics?.clear();
          if (this.cartDebugText) this.cartDebugText.setVisible(false);
        }
      });
    }
    // Tower hotkeys — configured in src/data/hotkeys.json
    TOWER_TYPES_ORDERED.forEach((towerType) => {
      const hk = HOTKEYS.tower[towerType];
      if (!hk) return;
      kb.on('keydown-' + hk, () => {
        this.placingTower = towerType;
        this.placingBarricade = false;
        this.placingEconomy = null;
      });
    });

    // Economy building hotkeys — configured in src/data/hotkeys.json
    ECO_BUILDING_TYPES.forEach((ecoType) => {
      const hk = HOTKEYS.economy[ecoType];
      if (!hk) return;
      kb.on('keydown-' + hk, () => {
        this.placingEconomy = ecoType;
        this.placingTower = null;
        this.placingBarricade = false;
      });
    });
    // Upgrade / evolve selected tower — configured in src/data/hotkeys.json
    const upgKey = HOTKEYS.actions.upgradeEvolve0;
    if (upgKey) {
      kb.on('keydown-' + upgKey, () => {
        if (this.selectedEcoBuilding) {
          this.bottomBar.onUpgradeEco?.();
        } else if (this.selectedTower?.canEvolve()) {
          this.bottomBar.onEvolve?.(0);
        } else if (this.selectedTower) {
          this.bottomBar.onUpgrade?.();
        }
      });
    }
    const evo1Key = HOTKEYS.actions.evolve1;
    if (evo1Key) {
      kb.on('keydown-' + evo1Key, () => {
        if (this.selectedTower?.canEvolve()) {
          this.bottomBar.onEvolve?.(1);
        }
      });
    }
    // Sell selected tower or economy building
    const sellKey = HOTKEYS.actions.sell;
    if (sellKey) {
      kb.on('keydown-' + sellKey, () => {
        if (this.selectedEcoBuilding) {
          this.bottomBar.onSellEco?.();
        } else if (this.selectedTower) {
          this.bottomBar.onSell?.();
        }
      });
    }
  }

  private registerEvents() {
    // Economy from abilities
    this.events.on('check_can_afford', (cost: number, cb: (v: boolean) => void) => cb(this.economy.canAfford(cost)));
    this.events.on('ability_spend',    (cost: number) => this.economy.spend(cost));

    // Tower targeting (uses spatial grid for both ground and flying enemies)
    this.events.on('tower_find_target', (tower: Tower, cb: (e: Enemy) => void) => {
      const range = tower.range;
      const targetsFlying = tower.def.targetsFlying;
      this.enemyGrid.query(tower.x, tower.y, range, e => {
        // Skip flyers if this tower doesn't target them
        if (!targetsFlying && e.def.isFlying) return;
        cb(e);
      });
    });

    this.events.on('tower_shoot', (tower: Tower, target: Enemy) => {
      this.sfx.play(('shoot_' + tower.towerType) as any);
      this.fireProjectile(tower, target);
    });

    this.events.on('projectile_hit', (proj: Projectile, target: Enemy) => this.handleHit(proj, target));

    this.events.on('enemy_died', (enemy: Enemy) => {
      // Clear boss cache if the boss died
      if (this.currentBoss === enemy) this.currentBoss = null;
      this.sfx.play(enemy.def.isBoss ? 'boss_die' : 'enemy_die');
      const goldMult = this.comboSystem.multiplier * this.weatherSystem.mods.goldEarnMult;
      this.economy.earnFromKills(Math.round(enemy.reward * goldMult));
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

    // Hero attack (uses spatial grid)
    this.events.on('hero_find_target', (hx: number, hy: number, range: number) => {
      let best: Enemy | null = null;
      let bestProgress = -1;
      this.enemyGrid.query(hx, hy, range, enemy => {
        if (!enemy.active || enemy.hp <= 0 || enemy.isPhased) return;
        if (enemy.pathProgress > bestProgress) {
          best = enemy;
          bestProgress = enemy.pathProgress;
        }
      });
      if (best !== null) {
        const target: Enemy = best;
        this.hero.playAttack();
        target.takeDamage(this.hero.attackDamage);
        // Sword slash FX (pooled graphics)
        const g = this.vfxGraphics().setDepth(10);
        g.lineStyle(3, 0xffdd44, 1);
        g.lineBetween(this.hero.x, this.hero.y, target.x, target.y);
        g.fillStyle(0xffffaa, 0.6);
        g.fillCircle(target.x, target.y, 12);
        this.tweens.add({ targets: g, alpha: 0, duration: 180, onComplete: () => {
          g.clear();
          g.setVisible(false);
        } });
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
      // Mark that all waves are done — don't transition yet; wait until every
      // enemy sprite is actually dead so the player sees a clean victory.
      this.allWavesCompleted = true;
    });

    this.events.on('toggle_pause', () => this.togglePause());

    // Cart pathfinding debug toggle (from HUD settings or V hotkey)
    this.events.on('toggle_cart_debug', () => {
      this.transportSys.cartDebugEnabled = !this.transportSys.cartDebugEnabled;
      this.hud.setCartDebugLabel(this.transportSys.cartDebugEnabled);
      if (!this.transportSys.cartDebugEnabled) {
        this.cartDebugGraphics?.clear();
        if (this.cartDebugText) this.cartDebugText.setVisible(false);
      }
    });
  }

  // ─── Input handlers ──────────────────────────────────────────────────────
  private onPointerUp(p: Phaser.Input.Pointer) {
    // If this was a touch drag (not a tap), consume and reset
    if (this.dragMoved) {
      this.dragMoved = false;
      this.dragActive = false;
      return;
    }

    if (p.rightButtonReleased()) {
      this.cancelPlacing();
      this.deselectTower();
      return;
    }
    if (!p.leftButtonReleased()) return;

    // Block clicks when settings modal is open
    if (this.hud.isSettingsOpen) return;

    // Block clicks on the floating wave button (above the bar)
    if (this.bottomBar.isInWaveArea(p.x, p.y)) return;

    const wx = p.worldX;
    const wy = p.worldY;

    // Ignore clicks in the bottom UI bar area
    if (p.y >= this.scale.height - this._barH) return;

    // ── HERO SELECTION: highest priority ──────────────────────────────────
    if (!this.placingTower && !this.placingBarricade && !this.placingEconomy) {
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

    if (!this.placingTower && !this.placingBarricade && !this.placingEconomy) {
      // Ability cast — skip if click was on a floating ability button (they
      // have their own pointerup handler that toggles pendingCast)
      if (this.abilitySystem.pendingCast && !this.isClickOnAbilityButton(p)) {
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

      // Economy building click → upgrade/sell panel
      const clickedEco = this.getEconomyBuildingAt(col, row);
      if (clickedEco) {
        this.selectEcoBuilding(clickedEco);
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
      if (this.decorationBlockedCells.has(`${row},${col}`)) return;
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

    // Placing economy building
    if (this.placingEconomy) {
      if (!this.canPlaceEconomy(this.placingEconomy, col, row)) return;
      const def = ECO_BUILDING_DEFS[this.placingEconomy];
      const count = this.economySim.countOfType(this.placingEconomy);
      const cost = escalatedCost(def, count);
      if (!this.economy.spend(cost)) return;
      this.placeEconomyBuilding(this.placingEconomy, col, row);
      if (!this.input.keyboard?.addKey('SHIFT').isDown) {
        this.placingEconomy = null;
      }
      return;
    }
  }

  private updateHoverTile(p: Phaser.Input.Pointer) {
    // Only hover over the game viewport area (above bottom bar)
    if (p.y >= this.scale.height - this._barH) {
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
      !this.decorationBlockedCells.has(`${row},${col}`) &&
      !this.synergySystem.getTowerAt(col, row);

    // Economy building placement validation
    const canPlaceEco = this.placingEconomy &&
      this.canPlaceEconomy(this.placingEconomy, col, row);

    if (canPlace || canPlaceEco) {
      this.hoverOverlay.setPosition(col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2).setAlpha(0.7);
    } else {
      this.hoverOverlay.setAlpha(0);
    }
  }

  private cancelPlacing() {
    this.placingTower = null;
    this.placingBarricade = false;
    this.placingEconomy = null;
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
    this.selectedEcoBuilding?.showRange(false);
    this.selectedEcoBuilding = null;
    this.heroSelected = false;
    this.hero.setSelected(false);
    this.bottomBar.showBuildMode();
  }

  // ─── Tower management ────────────────────────────────────────────────────
  public placeTower(type: TowerType, col: number, row: number) {
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

  private getEconomyBuildingAt(col: number, row: number): EconomyBuilding | null {
    return this.economyBuildings.find(b => {
      const def = ECO_BUILDING_DEFS[b.buildingType];
      return col >= b.gridCol && col < b.gridCol + def.width
          && row >= b.gridRow && row < b.gridRow + def.height;
    }) ?? null;
  }

  private selectEcoBuilding(building: EconomyBuilding) {
    this.deselectTower();
    this.selectedEcoBuilding?.showRange(false);
    this.selectedEcoBuilding = building;
    building.showRange(true);
    const rc = building.getRangeCircle();
    if (rc && this.uiCam) this.uiCam.ignore(rc);
    this.heroSelected = false;
    this.hero.setSelected(false);
    this.bottomBar.showEconomyMode(building);
  }

  /** Update the decorative sprite for a market when it upgrades. */
  private updateMarketDecoSprite(building: EconomyBuilding): void {
    if (building.buildingType !== 'market') return;
    const px = (building.gridCol + building.def.width / 2) * TILE_SIZE;
    const py = (building.gridRow + building.def.height / 2) * TILE_SIZE;
    // Find and update the decorative sprite at this position
    for (const spr of this.wallDecorations) {
      if (Math.abs(spr.x - px) < 2 && Math.abs(spr.y - py) < 2) {
        const variantKey = `${building.def.textureKey}_${building.level - 1}`;
        if (this.textures.exists(variantKey)) {
          spr.setTexture(variantKey);
        }
        break;
      }
    }
  }

  private towerCol(tower: Tower): number {
    return Math.round((tower.x - TILE_SIZE / 2) / TILE_SIZE);
  }

  private towerRow(tower: Tower): number {
    return Math.round((tower.y - TILE_SIZE / 2) / TILE_SIZE);
  }

  // ─── Economy building management ─────────────────────────────────────────

  private canPlaceEconomy(type: EconomyBuildingType, col: number, row: number): boolean {
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return false;
    const tile = this.mapData.grid[row][col];

    const def = ECO_BUILDING_DEFS[type];

    // Harbor / fishery: straddles water — must click on land, water auto-detected
    if (def.placement.straddlesWater) {
      // Must click on a land (buildable) tile
      if (tile.type !== 'buildable') return false;
      if (this.decorationBlockedCells.has(`${row},${col}`)) return false;
      if (this.synergySystem.getTowerAt(col, row)) return false;
      if (this.economyBuildings.some(b => b.gridCol === col && b.gridRow === row)) return false;

      // Check all 4 cardinal directions for a water tile
      const dirs: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dr, dc] of dirs) {
        const nr = row + dr, nc = col + dc;
        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
        if (this.mapData.grid[nr][nc].type !== 'ground') continue;
        // Found water — check if both cells are unblocked
        if (!this.isStraddleBlocked(col, row, nc, nr)) return true;
      }
      return false;
    }

    // All other buildings require a buildable tile
    if (tile.type !== 'buildable') return false;
    if (this.decorationBlockedCells.has(`${row},${col}`)) return false;
    if (this.synergySystem.getTowerAt(col, row)) return false;
    if (this.economyBuildings.some(b => b.gridCol === col && b.gridRow === row)) return false;

    // Water adjacency checks
    if (def.placement.requireWaterAdjacent) {
      if (!this.hasWaterNeighbor(row, col)) return false;
    }
    if (def.placement.forbidWaterAdjacent) {
      if (this.hasWaterNeighbor(row, col)) return false;
    }

    // Road adjacency (simplified: check if any neighboring cell has a road
    // — either a path tile or an existing economy building connected to roads)
    if (def.placement.requireRoadAdjacent) {
      if (!this.hasRoadNeighbor(row, col)) return false;
    }

    return true;
  }

  /** Check if two cells for a straddle building are blocked by existing structures. */
  private isStraddleBlocked(col1: number, row1: number, col2: number, row2: number): boolean {
    if (this.decorationBlockedCells.has(`${row1},${col1}`)) return true;
    if (this.decorationBlockedCells.has(`${row2},${col2}`)) return true;
    if (this.synergySystem.getTowerAt(col1, row1)) return true;
    if (this.synergySystem.getTowerAt(col2, row2)) return true;
    if (this.economyBuildings.some(b =>
      (b.gridCol === col1 && b.gridRow === row1) ||
      (b.gridCol === col2 && b.gridRow === row2))) return true;
    return false;
  }

  private hasWaterNeighbor(row: number, col: number): boolean {
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dr, dc] of dirs) {
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
      if (this.mapData.grid[nr][nc].type === 'ground') return true;
    }
    return false;
  }

  private hasRoadNeighbor(row: number, col: number): boolean {
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dr, dc] of dirs) {
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
      // Check for path tiles (roads used by enemies) and decorative road graphics
      if (this.mapData.grid[nr][nc].type === 'path') return true;
    }
    // Also consider it connected if there's at least one other economy building
    // placed (the road network will be regenerated to connect them)
    if (this.economyBuildings.length > 0) return true;
    return false;
  }

  private placeEconomyBuilding(type: EconomyBuildingType, col: number, row: number) {
    this.sfx.play('tower_place');
    const building = new EconomyBuilding(this, col, row, type);
    this.economyBuildings.push(building);

    const def = ECO_BUILDING_DEFS[type];

    // Detect straddle orientation BEFORE creating ships (FisherShip constructor
    // reads fishery.rotationDeg for spawn position, fishing spot, and return target).
    if (def.placement.straddlesWater) {
      const dirs: Array<[number, number, number]> = [
        [1, 0, 270],  // water bottom → rotation 270 (water top, land bottom)
        [-1, 0, 90],  // water top → rotation 90 (land top, water bottom)
        [0, -1, 0],   // water left → rotation 0 (water left, land right)
        [0, 1, 180],  // water right → rotation 180 (land left, water right)
      ];

      for (const [dr, dc, rot] of dirs) {
        const nr = row + dr, nc = col + dc;
        if (nr >= 0 && nr < GRID_ROWS && nc >= 0 && nc < GRID_COLS
            && this.mapData.grid[nr][nc].type === 'ground') {
          building.rotationDeg = rot;
          break;
        }
      }
    }

    this.economySim.addBuilding(building);
    this.transportSys.setBuildings(this.economyBuildings);

    // Ignore on UI camera so it doesn't render twice (once on map, once on UI overlay)
    if (this.uiCam) this.uiCam.ignore(building);

    // Ignore all fisher ships on UI camera
    const ships = this.economySim.getAllFisherShips(building);
    for (const ship of ships) {
      if (this.uiCam) this.uiCam.ignore(ship);
    }

    if (def.placement.straddlesWater) {

      // Mark land tile as path (occupied)
      this.mapData.grid[row][col].type = 'path';
      this.refreshTileSprite(row, col);

      // Reposition container to the correct center for each orientation.
      // The constructor assumes (col, col+1) is the occupied span, but for
      // 180/90/270 the building extends in a different direction.
      switch (building.rotationDeg) {
        case 0: // water left, Land right: center of (col, col+1) — default ✓
          building.setPosition(col * TILE_SIZE, (row + 0.5) * TILE_SIZE);
          break;
        case 180: // Water right, land left: center of (col-1, col)
          building.setPosition((col + 1.0) * TILE_SIZE, (row + 0.5) * TILE_SIZE);
          break;
        case 90: // Water top, land below: center of two vertical cells at column
          building.setPosition((col + 0.5) * TILE_SIZE, row * TILE_SIZE);
          break;
        case 270: // Water bottom, land top: center of two vertical cells
          building.setPosition((col + 0.5) * TILE_SIZE, (row + 1.0) * TILE_SIZE);
          break;
      }

      building.redraw();
    } else {
      // Mark all cells as occupied
      for (let dr = 0; dr < def.height; dr++) {
        for (let dc = 0; dc < def.width; dc++) {
          this.mapData.grid[row + dr][col + dc].type = 'path'; // unbuildable
          this.refreshTileSprite(row + dr, col + dc);
        }
      }
    }

    // Placement animation
    building.setScale(0.4);
    this.tweens.add({ targets: building, scaleX: 1, scaleY: 1, duration: 200, ease: 'Back.easeOut' });

    // Regenerate decorative roads to include the new economy building.
    this.regenerateAllRoads();
  }

  /** Incrementally update decorative roads when an economy building is
   *  added or removed. Only changed road segments get new noise —
   *  unchanged segments are preserved from the previous state. */
  private regenerateAllRoads(): void {
    // Collect economy building positions as DecorationPlacement-compatible objects
    const ecoPlacements: DecorationPlacement[] =
      this.economyBuildings.map(b => ({
        row: b.gridRow, col: b.gridCol,
        w: b.def.width, h: b.def.height,
        textureKey: b.def.textureKey,
        depth: 0.3,
      }));

    // Merge stored decorative placements with economy placements
    const allPlacements: DecorationPlacement[] = [
      ...this.decoPlacements,
      ...ecoPlacements,
    ];

    const allBlocked = new Set(this.decorationBlockedCells);

    if (allPlacements.length >= 2) {
      const { result: roadResult, state } = generateCityRoadsIncremental(
        this.mapData.grid,
        allPlacements,
        allBlocked,
        this.mapData.seed,
        this.roadNetworkState,
      );
      this.roadNetworkState = state;
      if (roadResult.roads.length > 0) {
        // Destroy old road graphics and redraw
        if (this.cityRoadGraphics) {
          this.cityRoadGraphics.destroy();
          this.cityRoadGraphics = null;
        }
        const roadG = this.add.graphics().setDepth(0.14);
        const roadRng = createPRNG(this.mapData.seed + 0xC0DE);
        drawCityRoads(roadG, roadResult, roadRng);
        this.cityRoadGraphics = roadG;
        if (this.uiCam) this.uiCam.ignore(roadG);
        // Wire updated road grid to transport system
        this.transportSys.setRoadGrid(state.roadGrid);
      }
    }
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
      // Fire 4 projectiles in a spread around the tower (uses spatial grid)
      for (let a = 0; a < 4; a++) {
        const t = this.enemyGrid.findNearest(tower.x, tower.y, tower.range);
        if (t) {
          const ecfg = { ...cfg, target: t, pierce: false, bounceLeft: 0 };
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
    // For spread shots, find enemy near offset (uses spatial grid)
    return this.enemyGrid.find(base.x, base.y, 60, e => e !== base && e.active);
  }

  private handleHit(proj: Projectile, target: Enemy) {
    if (!target.active) return;
    const cfg = proj.cfg;
    const now = this.time.now;

    // Sniper ignores armor
    const ignoreArmor = cfg.specialTags.includes('armor_pierce');
    target.takeDamage(cfg.damage, ignoreArmor);

    // Splash (uses spatial grid)
    if (cfg.splashRadius > 0) {
      const splashDmg = Math.round(cfg.damage * (cfg.bigSplash ? 0.6 : 0.4));
      this.enemyGrid.query(proj.x, proj.y, cfg.splashRadius, e => {
        if (e === target || !e.active) return;
        e.takeDamage(splashDmg);
        if (e.hp <= 0) e.die();
      });
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

    // Plague spread: when target dies, poison nearby enemies (uses spatial grid)
    if (cfg.specialTags.includes('spread_poison')) {
      const poisonDps = cfg.effectValue || 10;
      this.enemyGrid.query(target.x, target.y, 80, e => {
        if (e === target || !e.active) return;
        e.applyPoison(poisonDps, 4000, now);
      });
    }

    // Overload death pulse: when an enemy dies from this, explode AoE (uses spatial grid)
    if (cfg.specialTags.includes('death_pulse')) {
      this.spawnExplosion(target.x, target.y, 90, 0xffff44);
      const pulseDmg = Math.round(cfg.damage * 0.35);
      this.enemyGrid.query(target.x, target.y, 90, e => {
        if (e === target || !e.active) return;
        e.takeDamage(pulseDmg);
        if (e.hp <= 0) e.die();
      });
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
    // Use spatial grid to find nearest enemy within range
    const next = this.enemyGrid.find(from.x, from.y, 120, e => e !== from && e.active);
    if (!next) return;

    // Draw arc using pooled graphics
    const g = this.vfxGraphics().setDepth(8);
    g.clear();
    g.lineStyle(2, 0xffff00, 0.9);
    g.lineBetween(from.x, from.y, next.x, next.y);
    this.tweens.add({ targets: g, alpha: 0, duration: 300, onComplete: () => {
      g.clear();
      g.setVisible(false);
    } });

    next.takeDamage(Math.round(damage));
    next.applyStun(300, now);
    if (next.hp <= 0) next.die();
    this.chainLightning(next, damage * 0.8, bouncesLeft - 1, now);
  }

  private spawnExplosion(x: number, y: number, r: number, color: number) {
    const g = this.vfxGraphics().setDepth(7);
    g.fillStyle(color, 0.5);
    g.fillCircle(x, y, r * 0.6);
    this.tweens.add({ targets: g, alpha: 0, scaleX: 1.5, scaleY: 1.5, duration: 300, onComplete: () => {
      g.clear();
      g.setVisible(false);
    } });

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

  // ─── Cart Pathfinding Debug ──────────────────────────────────────────────

  /**
   * Renders the A* debug overlay when cartDebugEnabled is on.
   * Shows per-cell cost weights as a colour heatmap plus the chosen path.
   *
   * Colour key:
   *   ■ Bright green  — road cell (cost 0.1)
   *   ■ Yellow        — enemy path cell (cost 0.5)
   *   ■ Orange        — grass / buildable (cost 1.0)
   *   ■ Dark blue     — water / blocked (unwalkable)
   *   ■ Cyan outline  — cell on the computed A* path
   *   ■ White dot     — start / end cell
   *   ■ Dim           — cell not visited by A*
   */
  private renderCartDebug(): void {
    const enabled = this.transportSys.cartDebugEnabled;

    if (!enabled) {
      if (this.cartDebugGraphics) this.cartDebugGraphics.clear();
      if (this.cartDebugText) this.cartDebugText.setVisible(false);
      return;
    }

    const data = this.transportSys.cartDebugData;

    // Lazy-init graphics
    if (!this.cartDebugGraphics) {
      this.cartDebugGraphics = this.add.graphics().setDepth(10);
      if (this.uiCam) this.uiCam.ignore(this.cartDebugGraphics);
    }
    if (!this.cartDebugText) {
      this.cartDebugText = this.add.text(0, 0, '', {
        fontSize: '11px', fontFamily: 'monospace', color: '#ffffff',
        stroke: '#000000', strokeThickness: 2,
      }).setDepth(11).setScrollFactor(0);
    }
    this.cartDebugText.setVisible(true);

    const g = this.cartDebugGraphics;
    g.clear();

    if (!data) {
      this.cartDebugText.setText('🛒 A* Debug [V] — waiting for next cart delivery…');
      return;
    }

    const TS = TILE_SIZE;

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const idx = r * GRID_COLS + c;
        const cost = data.costGrid[idx];
        const cell = data.walkableGrid[idx];

        let fillColor: number;
        let fillAlpha = 0.45;

        if (cost === 0) {
          // Not visited by A* — dim
          fillColor = 0x334466;
          fillAlpha = 0.10;
        } else if (data.roadGrid[idx] === 1) {
          // Road cell (cost 0.1) → bright green
          fillColor = 0x22cc44;
        } else if (cell === 2) {
          // Enemy path cell (cost 0.5) → yellow
          fillColor = 0xcccc22;
        } else if (cell === 1) {
          // Grass / buildable (cost 1.0) → orange
          fillColor = 0xcc7722;
        } else {
          // Blocked (water) → dark blue
          fillColor = 0x2244aa;
        }

        const x = c * TS, y = r * TS;
        g.fillStyle(fillColor, fillAlpha);
        g.fillRect(x + 1, y + 1, TS - 2, TS - 2);

        if (data.pathCells.has(`${r},${c}`)) {
          g.lineStyle(2, 0x00ffff, 0.9);
          g.strokeRect(x + 2, y + 2, TS - 4, TS - 4);
        }

        const isStart = (r === data.sr && c === data.sc);
        const isEnd   = (r === data.er && c === data.ec);
        if (isStart || isEnd) {
          g.fillStyle(isStart ? 0xffffff : 0xff4444, 0.9);
          g.fillCircle(x + TS / 2, y + TS / 2, 5);
        }
      }
    }

    // Path polyline
    if (data.pathCells.size > 0) {
      g.lineStyle(2, 0x00ffff, 0.8);
      const pathPts: {x: number, y: number}[] = [];
      const visited = new Set<string>();
      let cr = data.er, cc = data.ec;
      while (!(cr === data.sr && cc === data.sc)) {
        const key = `${cr},${cc}`;
        if (visited.has(key)) break;
        visited.add(key);
        pathPts.push({ x: cc * TS + TS / 2, y: cr * TS + TS / 2 });
        let bestR = -1, bestC = -1, bestCost = Infinity;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nr = cr + dr, nc = cc + dc;
          if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
          const nk = `${nr},${nc}`;
          if (!data.pathCells.has(nk) || visited.has(nk)) continue;
          const nc2 = data.costGrid[nr * GRID_COLS + nc];
          if (nc2 > 0 && nc2 < bestCost) { bestCost = nc2; bestR = nr; bestC = nc; }
        }
        if (bestR < 0) break;
        cr = bestR; cc = bestC;
      }
      pathPts.push({ x: data.sc * TS + TS / 2, y: data.sr * TS + TS / 2 });
      pathPts.reverse();

      if (pathPts.length > 1) {
        g.lineStyle(2, 0x00ffff, 0.9);
        g.beginPath();
        g.moveTo(pathPts[0].x, pathPts[0].y);
        for (let i = 1; i < pathPts.length; i++) {
          g.lineTo(pathPts[i].x, pathPts[i].y);
        }
        g.strokePath();
      }
    }

    // Legend
    this.cartDebugText.setText([
      '🛒 A* Debug  [V]',
      '■ Green=road  ■ Yel=path  ■ Org=grass  ■ Blue=water',
      '■ Cyan=route  ○ White=start  ○ Red=end',
      data.hadRoadGrid ? '✓ Road grid active' : '✗ NO road grid',
    ].join('\n'));
  }

  // ─── Minimap ─────────────────────────────────────────────────────────────
  private initResizeHandler() {
    const applyLayout = (W: number, H: number) => {
      // Compute bottom bar first — barH is derived from tower button size
      this.bottomBar.resize(W, H);
      this._barH = this.bottomBar.barHeight;

      // Camera viewport
      this.cameras.main.setViewport(0, 0, W, H - this._barH);

      // UI camera
      this.uiCam.setSize(W, H);

      // Minimap reposition
      this.repositionMinimap(W);

      // HUD with actual barH
      this.hud.resize(W, H, this._barH);

      // Ability buttons
      this.relayoutAbilities(H, this._barH);
    };

    this.scale.on('resize', (size: Phaser.Structs.Size) => {
      applyLayout(size.width, size.height);
    });

    // Apply initial layout directly (don't emit through scale — would confuse WebGLRenderer)
    applyLayout(this.scale.width, this.scale.height);
  }

  /** Reposition all minimap graphics when screen width changes. */
  private repositionMinimap(W: number) {
    if (!this.minimapBg) return;
    // Responsive size: 15% of screen width, aspect ratio maintained
    const newW = Math.max(80, Math.round(W * 0.15));
    const newH = Math.round(newW * GRID_ROWS / GRID_COLS);
    this.minimapW = newW;
    this.minimapH = newH;

    const MM_X  = W - newW - 4;
    const MM_Y  = this.minimapY;
    const MM_PAD = 2;

    this.minimapX = MM_X;

    this.minimapBg.clear();
    this.minimapBg.fillStyle(0x0a1a2a, 0.35);
    this.minimapBg.fillRect(MM_X - MM_PAD, MM_Y - MM_PAD, newW + MM_PAD * 2, newH + MM_PAD * 2);
    this.minimapBg.lineStyle(1, 0x5a8aaa, 0.6);
    this.minimapBg.strokeRect(MM_X - MM_PAD, MM_Y - MM_PAD, newW + MM_PAD * 2, newH + MM_PAD * 2);

    this.minimapMapImg.setPosition(MM_X, MM_Y).setDisplaySize(newW, newH);
    this.minimapHitArea.setPosition(MM_X + newW / 2, MM_Y + newH / 2).setSize(newW, newH);
  }

  /**
   * Recompute ability button sizes proportional to viewport height
   * and redraw/reposition all ability button graphics.
   */
  private relayoutAbilities(H: number, barH: number) {
    if (this.abilityFloating.size === 0) return;  // not yet created
    const vpH = H - barH;
    const btns = Math.max(46, Math.min(70, Math.round(vpH * 0.108)));
    const gap  = Math.max(5, Math.round(btns * 0.13));
    this._abilityBtnSize = btns;
    this._abilityGap     = gap;

    const startX = this._abilityStartX;
    const startY = this._abilityStartY;

    ABILITY_DEFS.forEach((def, i) => {
      const btn = this.abilityFloating.get(def.type);
      if (!btn) return;
      const cx = startX + btns / 2;
      const cy = startY + i * (btns + gap) + btns / 2;
      const fillColor   = ABILITY_FILL[def.type]  ?? 0x1a2a3a;
      const borderColor = ABILITY_BORDER[def.type] ?? def.color;

      btn.hit.setPosition(cx, cy).setSize(btns, btns);
      btn.cdTxt.setPosition(cx, cy)
        .setStyle({ fontSize: Math.max(14, Math.round(btns * 0.3)) + 'px' });
      btn.cost.setPosition(cx, cy + btns / 2 + 5)
        .setStyle({ fontSize: Math.max(9, Math.round(btns * 0.195)) + 'px' });

      // Redraw button background + icon
      btn.bg.clear();
      btn.bg.fillStyle(fillColor, 0.92);
      btn.bg.fillRoundedRect(cx - btns / 2, cy - btns / 2, btns, btns, 6);
      btn.bg.lineStyle(1, borderColor, 0.55);
      btn.bg.strokeRoundedRect(cx - btns / 2, cy - btns / 2, btns, btns, 6);

      const iconSize = Math.round(btns * 0.72);
      btn.icon.setPosition(cx, cy).setDisplaySize(iconSize, iconSize);
    });
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
    const D = 60;

    ABILITY_DEFS.forEach((def, i) => {
      // Initial positions — will be corrected by relayoutAbilities() immediately after
      const cx = this._abilityStartX + this._abilityBtnSize / 2;
      const cy = this._abilityStartY + i * (this._abilityBtnSize + this._abilityGap) + this._abilityBtnSize / 2;

      const bg    = this.add.graphics().setScrollFactor(0).setDepth(D);
      const icon  = this.add.image(cx, cy, `ability_${def.type}`)
        .setScrollFactor(0).setDepth(D + 1);
      const cdOvl = this.add.graphics().setScrollFactor(0).setDepth(D + 2);
      const cdTxt = this.add.text(cx, cy, '', {
        fontSize: '20px', fontFamily: 'monospace', color: '#ffffff', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 3);
      const cost = this.add.text(cx, cy + this._abilityBtnSize / 2 + 5, `${def.cost}g`, {
        fontSize: '12px', fontFamily: 'monospace', color: '#ffd700', align: 'center',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(D + 1);

      // Hover/click handlers read from instance fields so resize doesn't break them
      const drawBtn = (_hover: boolean, selected: boolean) => {
        const btns = this._abilityBtnSize;
        const gap  = this._abilityGap;
        const bcx  = this._abilityStartX + btns / 2;
        const bcy  = this._abilityStartY + i * (btns + gap) + btns / 2;
        const fill = ABILITY_FILL[def.type] ?? 0x1a2a3a;
        const bdr  = ABILITY_BORDER[def.type] ?? def.color;
        const useFill = selected ? 0x2a4a6a : fill;
        bg.clear();
        bg.fillStyle(useFill, 0.92);
        bg.fillRoundedRect(bcx - btns / 2, bcy - btns / 2, btns, btns, 6);
        bg.lineStyle(selected ? 2 : 1, bdr, selected ? 1.0 : 0.55);
        bg.strokeRoundedRect(bcx - btns / 2, bcy - btns / 2, btns, btns, 6);
        const iconSz = Math.round(btns * 0.72);
        icon.setPosition(bcx, bcy).setDisplaySize(iconSz, iconSz);
      };

      drawBtn(false, false);

      const hit = this.add.rectangle(cx, cy, this._abilityBtnSize, this._abilityBtnSize, 0, 0)
        .setScrollFactor(0).setInteractive({ useHandCursor: true }).setDepth(D + 4);
      hit.on('pointerover', () => drawBtn(true,  this.abilitySystem.pendingCast === def.type));
      hit.on('pointerout',  () => drawBtn(false, this.abilitySystem.pendingCast === def.type));
      hit.on('pointerup',   () => this.abilitySystem.selectAbility(def.type));

      this.abilityFloating.set(def.type, { bg, icon, cdOvl, cdTxt, cost, hit });
    });

    this.events.on('ability_selected', (type: AbilityType | null) => {
      ABILITY_DEFS.forEach((def, i) => {
        const btn = this.abilityFloating.get(def.type);
        if (!btn) return;
        const btns = this._abilityBtnSize;
        const gap  = this._abilityGap;
        const bcx  = this._abilityStartX + btns / 2;
        const bcy  = this._abilityStartY + i * (btns + gap) + btns / 2;
        const isSelected  = def.type === type;
        const fillColor   = ABILITY_FILL[def.type]  ?? 0x1a2a3a;
        const borderColor = ABILITY_BORDER[def.type] ?? def.color;

        btn.bg.clear();
        btn.bg.fillStyle(isSelected ? 0x2a4a6a : fillColor, 0.92);
        btn.bg.fillRoundedRect(bcx - btns / 2, bcy - btns / 2, btns, btns, 6);
        btn.bg.lineStyle(isSelected ? 2 : 1, borderColor, isSelected ? 1.0 : 0.55);
        btn.bg.strokeRoundedRect(bcx - btns / 2, bcy - btns / 2, btns, btns, 6);
        const iSz = Math.round(btns * 0.72);
        btn.icon.setPosition(bcx, bcy).setDisplaySize(iSz, iSz);
      });
    });
  }

  /** Check whether a pointer event landed on a floating ability button. */
  private isClickOnAbilityButton(p: Phaser.Input.Pointer): boolean {
    const btns  = this._abilityBtnSize;
    const gap   = this._abilityGap;
    const startX = this._abilityStartX;
    const startY = this._abilityStartY;
    if (p.x < startX || p.x > startX + btns) return false;
    for (let i = 0; i < ABILITY_DEFS.length; i++) {
      const top = startY + i * (btns + gap);
      if (p.y >= top && p.y <= top + btns) return true;
    }
    return false;
  }

  // ─── Floating Ability Update ───────────────────────────────────────────

  private updateFloatingAbilities() {
    const btns  = this._abilityBtnSize;
    const gap   = this._abilityGap;
    const startX = this._abilityStartX;
    const startY = this._abilityStartY;

    ABILITY_DEFS.forEach((def, i) => {
      const btn = this.abilityFloating.get(def.type);
      if (!btn) return;
      const cx = startX + btns / 2;
      const cy = startY + i * (btns + gap) + btns / 2;

      const cd = this.abilitySystem.getCooldown(def.type);
      btn.cdOvl.clear();
      if (cd.remaining > 0) {
        const frac = cd.remaining / cd.total;
        btn.cdOvl.fillStyle(0x000000, 0.65 * frac);
        btn.cdOvl.fillRoundedRect(cx - btns / 2 + 2, cy - btns / 2 + 2, btns - 4, (btns - 4) * frac, 4);
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
    const vpH  = this.scale.height - this._barH;

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
    // Center camera on clicked world position — centerOn accounts for zoom internally
    cam.centerOn(worldX, worldY);
  }

  // ─── Aura towers ────────────────────────────────────────────────────────
  private processAuraTowers() {
    const now = this.time.now;
    this.towerGroup.getChildren().forEach(obj => {
      const t = obj as Tower;
      if (!t.isAura) return;
      this.enemyGrid.query(t.x, t.y, t.range, e => {
        e.applySlow(0.4, 500, now);
      });
    });
  }

  // ─── Boss tracking ───────────────────────────────────────────────────────
  private updateBossBar(allGround: Enemy[], allFliers: Enemy[]) {
    // Refresh cached boss if it became inactive
    if (this.currentBoss && (!this.currentBoss.active || this.currentBoss.hp <= 0)) {
      this.currentBoss = null;
    }
    // Scan for a new boss only when we don't have one cached
    if (!this.currentBoss) {
      for (let i = 0; i < allGround.length; i++) {
        const e = allGround[i];
        if (e.active && e.def.isBoss) { this.currentBoss = e; break; }
      }
      if (!this.currentBoss) {
        for (let i = 0; i < allFliers.length; i++) {
          const e = allFliers[i];
          if (e.active && e.def.isBoss) { this.currentBoss = e; break; }
        }
      }
    }
    if (this.currentBoss) {
      this.events.emit('boss_hp_update', this.currentBoss.hp, this.currentBoss.maxHp, this.currentBoss.def.label);
    }
  }

  // ─── Healer aura ────────────────────────────────────────────────────────
  private processHealerAura(delta: number, allGround: Enemy[], allFliers: Enemy[]) {
    // Check ground healers
    for (let i = 0; i < allGround.length; i++) {
      const healer = allGround[i];
      if (!healer.active || healer.def.special !== 'heal_aura') continue;
      this.enemyGrid.query(healer.x, healer.y, 100, e => {
        if (e === healer || !e.active) return;
        e.hp = Math.min(e.maxHp, e.hp + healer.def.specialValue * (delta / 1000));
      });
    }
    // Check flying healers
    for (let i = 0; i < allFliers.length; i++) {
      const healer = allFliers[i];
      if (!healer.active || healer.def.special !== 'heal_aura') continue;
      this.enemyGrid.query(healer.x, healer.y, 100, e => {
        if (e === healer || !e.active) return;
        e.hp = Math.min(e.maxHp, e.hp + healer.def.specialValue * (delta / 1000));
      });
    }
  }

  // ─── Wrappers for transient VFX — uses object pool ─────────────────────
  private vfxGraphics(): Phaser.GameObjects.Graphics {
    // Cycle through the pool
    const g = this.vfxPool[this.vfxPoolIndex];
    this.vfxPoolIndex = (this.vfxPoolIndex + 1) % this.VFX_POOL_SIZE;
    g.clear();
    g.setAlpha(1).setScale(1).setVisible(true);
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
    this.economySim.update(delta);
    this.transportSys.update(delta);
    this.renderCartDebug();
    this.waveManager.update(delta);
    this.abilitySystem.update(delta);
    this.weatherSystem.update(delta);
    this.comboSystem.update(delta);

    // Cache enemy arrays once per frame (avoids repeated getChildren() calls)
    const allGround = this.enemyGroup.getChildren() as Enemy[];
    const allFliers = this.flyerGroup.getChildren() as Enemy[];

    // Rebuild spatial grid once per frame
    this.enemyGrid.clear();
    for (let i = 0; i < allGround.length; i++) {
      const e = allGround[i];
      if (e.active) this.enemyGrid.insert(e);
    }
    for (let i = 0; i < allFliers.length; i++) {
      const e = allFliers[i];
      if (e.active) this.enemyGrid.insert(e);
    }

    // Update towers
    this.towerGroup.getChildren().forEach(t => (t as Tower).preUpdate(time, delta));
    this.processAuraTowers();
    this.processHealerAura(delta, allGround, allFliers);
    this.updateBossBar(allGround, allFliers);
    this.bottomBar.update();
    this.bottomBar.setWaveInfo(
      this.waveManager.currentWave,
      TOTAL_WAVES,
      this.waveManager.countdown,
    );
    this.updateFloatingAbilities();

    // Render all HP bars in a single pass (pooled — 2 Graphics objects total)
    this.hpBarPool.render(allGround, allFliers);

    // Update HUD
    // Win condition: all waves dispatched AND no enemy sprites remain alive.
    if (this.allWavesCompleted) {
      const alive =
        this.enemyGroup.countActive() + this.flyerGroup.countActive();
      if (alive === 0) {
        this.allWavesCompleted = false; // prevent re-trigger
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
      }
    }

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

    this.hud.updateGeneralStats(
      this.economy.incomeFromEconomy,
      this.economy.incomeFromKills,
    );

    this.updateMinimap();
  }
}
