// ─── Grid ───────────────────────────────────────────────────────────────────
export const TILE_SIZE = 48;
export const GRID_COLS = 37;
export const GRID_ROWS = 19;
export const GAME_WIDTH = TILE_SIZE * GRID_COLS;  // 1776
export const GAME_HEIGHT = TILE_SIZE * GRID_ROWS; // 912

// ─── Colors ──────────────────────────────────────────────────────────────────
export const COLORS = {
  // Background / terrain
  BG:             0x0a0a0f,
  GROUND:         0x1a2035,
  PATH:           0x3d3220,
  PATH_EDGE:      0x5a4a2e,
  BUILDABLE:      0x1e2d1e,
  BUILDABLE_HL:   0x253525,
  SPAWN:          0x2d1a1a,
  GOAL:           0x1a2d1a,

  // UI chrome
  PANEL_BG:       0x0d1117,
  PANEL_BORDER:   0x2a3a4a,
  BTN_NORMAL:     0x1e3a5f,
  BTN_HOVER:      0x2a5080,
  BTN_PRESS:      0x0f1e30,
  TEXT_PRIMARY:   0xeef0f4,
  TEXT_SECONDARY: 0x8899aa,
  TEXT_GOLD:      0xffd700,
  TEXT_RED:       0xff4444,
  TEXT_GREEN:     0x44ff88,

  // Towers
  TOWER_ARROW:      0x88aaff,
  TOWER_CANNON:     0xff6633,
  TOWER_ICE:        0x66ddff,
  TOWER_LIGHTNING:  0xffee44,
  TOWER_POISON:     0x66ff66,
  TOWER_BOOMERANG:  0xff88cc,
  TOWER_BASE:       0x334455,
  TOWER_RANGE:      0x171717,

  // Enemies
  ENEMY_GRUNT:    0xdd3333,
  ENEMY_RUNNER:   0xffaa22,
  ENEMY_TANK:     0x888888,
  ENEMY_FLYER:    0xcc88ff,
  ENEMY_HEALER:   0x44ffaa,
  ENEMY_SWARM:    0xff5588,
  ENEMY_BOSS:     0xff2200,

  // Effects
  FX_FREEZE:      0x99ddff,
  FX_METEOR:      0xff6600,
  FX_CHAIN:       0xffff00,
  FX_HEAL:        0x00ff88,
  FX_POISON_CLOUD:0x88ff44,
  FX_EXPLOSION:   0xff4400,

  // Weather
  WEATHER_RAIN:    0x3355aa,
  WEATHER_WIND:    0xaabbcc,
  WEATHER_ECLIPSE: 0x221144,

  // HP bar
  HP_HIGH:  0x00cc44,
  HP_MED:   0xffaa00,
  HP_LOW:   0xff2222,

  // Synergy
  SYNERGY_LINE: 0xffffff,
} as const;

// ─── Economy ─────────────────────────────────────────────────────────────────
export const STARTING_GOLD  = 200;
export const STARTING_LIVES = 20;
export const PASSIVE_INCOME_INTERVAL = 5000; // ms
export const PASSIVE_INCOME_AMOUNT   = 10;

// ─── Waves ───────────────────────────────────────────────────────────────────
export const TOTAL_WAVES   = 50;
export const BOSS_EVERY_N  = 5;
export const EARLY_WAVE_BONUS_PER_SEC = 2;

// ─── Tower ───────────────────────────────────────────────────────────────────
export const SELL_REFUND_RATIO = 0.6;
export const MAX_TOWER_LEVEL   = 3; // then evolve

// ─── Map generation ──────────────────────────────────────────────────────────
export const MIN_PATH_LENGTH = 45;
export const MAX_PATH_LENGTH = 80;
export const BUILDABLE_RADIUS = 2; // tiles around path that are buildable

// ─── Abilities ───────────────────────────────────────────────────────────────
export const ABILITY_SLOT_COUNT = 4;

// ─── Hero ────────────────────────────────────────────────────────────────────
export const HERO_RESPAWN_TIME = 15000; // ms

// ─── Barricade ───────────────────────────────────────────────────────────────
export const MAX_BARRICADES = 6;
export const BARRICADE_HP   = 150;
export const BARRICADE_COST = 30;

// ─── Combo ───────────────────────────────────────────────────────────────────
export const COMBO_DRAIN_MS   = 3000; // drain to zero after this ms of no kills
export const COMBO_THRESHOLDS = [0, 5, 15, 30, 60] as const; // kills for x1,x2,x3,x5,x10
export const COMBO_MULTIPLIERS = [1, 2, 3, 5, 10] as const;

// ─── Weather ────────────────────────────────────────────────────────────────
export const WEATHER_CHANGE_INTERVAL = 75000; // ms between weather shifts

// ─── UI Layout ──────────────────────────────────────────────────────────────
export const UI_TOP_HEIGHT    = 34;  // HUD top bar height
export const UI_BOTTOM_HEIGHT = 100; // BottomBar height

// ─── Camera ─────────────────────────────────────────────────────────────────
export const CAMERA_MIN_ZOOM = 0.5;
export const CAMERA_MAX_ZOOM = 2.0;
