# AI Asset Workflow — Creating New AI-Generated Visuals & Wiring Them Into the Game

Use this guide when the user asks to create **new AI-generated images** for the
game and incorporate them into the game logic. This covers two broad scenarios:

1. **New non-terrain sprites** — ability icons, building decorations, city
   assets, houses, trees, rocks, item pickups, or any entity sprite that is
   **not a repeating terrain tile**.
2. **New terrain tile types** — a new ground surface like mud, lava, snow, etc.
   that needs the full corner-bitmask transition + Wang tile treatment.

The user will describe *what* they want visually ("a glowing blue frost icon
for the Blizzard ability", "medieval stone houses for the background", "lava
terrain that hurts units"). Your job is to translate that into:

- A **prompt + generation config** for the AI tile generator tool
- Loading code in `BootScene.ts`
- A procedural fallback (always!)
- Game-logic wiring so the asset actually appears in the game

---

## Quick Decision: Which Category?

```
User wants a new visual asset...
│
├── Is it a repeating ground surface (terrain)?
│   └── YES → Category B: Terrain Tiles (full pipeline)
│
└── Is it a single entity / icon / decoration?
    └── YES → Category A: Non-Terrain Sprites (simpler pipeline)
```

---

## Category A: Non-Terrain Sprites

This covers: ability icons, tower sprites, hero sprites, enemy sprites,
projectile textures, particle textures, building decorations (houses, walls,
trees, rocks), HUD elements, item pickups, and any one-off image.

### Step 1 — Pick the Texture Key

Choose a unique, descriptive texture key following the existing naming
conventions:

| Asset type              | Key pattern                        | Example                        |
|-------------------------|------------------------------------|--------------------------------|
| Tower (base levels)     | `tower_{type}_{level}`             | `tower_arrow_0`                |
| Tower (evolution)       | `tower_{evoType}`                  | `tower_arrow_storm`            |
| Ability icon            | `ability_{type}`                   | `ability_freeze`               |
| Hero (idle frame 0)     | `hero_idle_0` (part of spritesheet)| —                              |
| Enemy (type)            | `enemy_{type}`                     | `enemy_grunt`                  |
| Projectile              | `proj_{type}`                      | `proj_arrow`                   |
| Particle                | `particle_{type}`                  | `particle_ice`                 |
| Decoration / building   | `deco_{name}`                      | `deco_house_01`, `deco_tree`   |
| UI element              | `ui_{name}`                        | `ui_ability_panel`             |

> **Rule**: The texture key must match the filename (minus `.png`). If the key
> is `ability_freeze`, the file must be `ability_freeze.png`.

### Step 2 — Generate the Image with the AI Tile Generator

The tile generator runs at `http://localhost:3456` (start with `npm run tiles`).

**Option A — Tell the user to use the UI (preferred for one-off images)**

Give the user these exact instructions:

> 1. Run `npm run tiles` and open http://localhost:3456
> 2. Enter the prompt: `"<your crafted prompt>"`
> 3. Set the filename to: `<texture key>` (without `.png`)
> 4. Choose model: `fal-ai/fast-sdxl` (cheapest) or `fal-ai/flux/schnell` (higher quality)
> 5. Set size to `512×512` (for icons/sprites) or `1024×1024` (for terrain/decorations)
> 6. Click **Generate**
> 7. After generation, the image is saved to `public/assets/tiles/<texture key>.png`

**Option B — Generate a server-side preset (for batch generation)**

The tile generator server has preset buttons defined in `index.html`.
You can add a new preset by editing the `PRESETS` array in `index.html`.
Example addition:

```javascript
{ id: 'ability_freeze', label: '❄️ Freeze', prompt: 'top-down game icon, glowing blue snowflake crystal on dark transparent background, stylized fantasy art, sharp details, 512x512', w: 512, h: 512 },
```

**Crafting the prompt** — always include these keywords for consistency:
- `top-down game asset` or `isometric game sprite`
- `stylized fantasy art` (matches the game's visual style)
- `sharp details, clean edges`
- For icons/sprites: `on dark transparent background`
- For decorations: `pixel art style` or `vector art style`
- Size context: e.g. `512x512 game sprite`

### Step 3 — Preload in `BootScene.preload()`

Add a `this.load.image()` call in the `preload()` method of
`src/scenes/BootScene.ts`. Group it with similar assets:

```typescript
// ── Ability icons (AI-generated, optional — procedural fallback in create())
this.load.image('ability_freeze', 'assets/tiles/ability_freeze.png');
this.load.image('ability_meteor', 'assets/tiles/ability_meteor.png');
// ... etc
```

> **Important**: The `load.on('filecomplete', ...)` handler in `preload()`
> automatically adds loaded keys to `this.aiLoadedTiles`. You don't need to
> do anything special — just call `this.load.image()`.

### Step 4 — Add Procedural Fallback in `create()`

**Every AI asset MUST have a procedural fallback.** The game must work even if
the AI image file doesn't exist on disk.

Find or create the appropriate generator method in `BootScene` and add a
texture-exists check. Follow the existing pattern:

```typescript
// In the appropriate create() method or generator:
if (!this.textures.exists('ability_freeze')) {
  this.generateAbilityFreezeIcon();
}
```

Then add the generator method. Use `this.add.graphics()` + `generateTexture()`.

**Template for a simple icon generator:**

```typescript
private generateAbilityFreezeIcon() {
  const g = this.add.graphics();
  const S = 48; // icon size
  // Background circle
  g.fillStyle(0x0a1a3a, 1);
  g.fillCircle(S / 2, S / 2, S / 2 - 2);
  // Border
  g.lineStyle(2, 0x99ddff, 0.8);
  g.strokeCircle(S / 2, S / 2, S / 2 - 2);
  // Icon shape (snowflake)
  g.fillStyle(0x99ddff, 1);
  // ... draw the shape ...
  g.generateTexture('ability_freeze', S, S);
  g.destroy();
}
```

**Template for a decoration/building generator:**

```typescript
private generateHouse01() {
  const g = this.add.graphics();
  const W = 64, H = 64;
  // Wall
  g.fillStyle(0x8B7355, 1);
  g.fillRect(8, 20, W - 16, H - 28);
  // Roof (triangle)
  g.fillStyle(0x6B3A2A, 1);
  g.fillTriangle(W/2, 4, 4, 22, W - 4, 22);
  // Door
  g.fillStyle(0x4A2A1A, 1);
  g.fillRect(W/2 - 6, H - 20, 12, 20);
  // Window
  g.fillStyle(0x88CCFF, 0.7);
  g.fillRect(W/2 + 10, 28, 10, 10);
  g.generateTexture('deco_house_01', W, H);
  g.destroy();
}
```

### Step 5 — Wire Into Game Logic

This is the most varied step. Where you place the asset depends on what it is.

**Ability icons** — used in `src/ui/BottomBar.ts` (ability buttons) and/or
`src/ui/HUD.ts`. The ability system is defined in `src/data/abilities.ts` and
managed by `src/systems/AbilitySystem.ts`. If you're adding a *new ability*:

1. Add the `AbilityDef` to `src/data/abilities.ts`
2. Add a keyboard shortcut in `AbilitySystem.ts` constructor
3. Add a `cast{Ability}()` method in `AbilitySystem.ts`
4. Add the button in `BottomBar.ts` using the AI texture

**Decorations / buildings** — rendered in `GameScene.create()` or
`GameScene.buildMap()`. Add them to the map as `Phaser.GameObjects.Image`
sprites positioned at world coordinates. Set appropriate depth so they render
behind towers but above terrain (depth 0.3–0.5 works well).

```typescript
// Example: placing a decoration in buildMap()
for (let i = 0; i < 5; i++) {
  const hx = Phaser.Math.Between(100, GAME_WIDTH - 100);
  const hy = Phaser.Math.Between(100, GAME_HEIGHT - 100);
  const house = this.add.image(hx, hy, 'deco_house_01').setDepth(0.3);
  house.setScale(0.8 + Math.random() * 0.4);
}
```

**Tower sprites** — if replacing procedural tower textures with AI ones,
the texture key pattern is already `tower_{type}_{level}` and
`tower_{evoType}`. The loading code already exists in `preload()`. You just
need to generate the PNG files. The `generateTowerTextures()` method already
checks `this.aiLoadedTiles.has(key)` and skips procedural generation if an
AI texture exists.

**Enemy sprites** — enemy textures are spritesheets (4 frames in a row, each
32×32). If providing AI enemy sprites, generate a 128×32 image with 4
frames side-by-side, name it `enemy_{type}.png`, and update
`BootScene.generateEnemySheets()` to check for AI textures.

---

## Category B: New Terrain Tile Types

Adding a brand-new terrain type (e.g., `mud`, `lava`, `snow`) requires the
full 10-step pipeline. This is more involved because terrain tiles need:

- Corner-bitmasked transition tiles (16 of them) for blending into neighbors
- Wang tile sets for seamless tiling
- Palette extraction for color-matched transitions
- MapGenerator integration for cell placement

The existing `copilot-instructions.md` covers this in the section
**"Adding New Tile Types"** (10 steps). Follow that exactly, with one
addition: when generating the base tile image, use the AI tile generator
with a 1024×1024 size for maximum crop variation.

---

## Category C: Replacing Existing Procedural Assets with AI

The game already has a pattern for this: procedural generators check
`this.aiLoadedTiles.has(key)` and skip generation if an AI texture exists.

To add AI support for an asset that currently only has procedural generation:

1. **Generate the AI image** using the tile generator (Step 2 above)
2. **Add `this.load.image()`** in `BootScene.preload()` with the correct key
3. **Add the existence check** in the procedural generator:
   ```typescript
   if (this.aiLoadedTiles.has('my_texture_key')) return;
   ```
4. **Verify** the file is in `public/assets/tiles/`

That's it — the existing `filecomplete` handler in `preload()` already adds
the key to `aiLoadedTiles`.

### Example: Adding AI Support for Ability Icons

Currently, ability icons are always drawn procedurally in the UI. To let AI
replace them:

```typescript
// In BootScene.preload():
this.load.image('ability_freeze', 'assets/tiles/ability_freeze.png');
this.load.image('ability_meteor', 'assets/tiles/ability_meteor.png');
// ...

// In BootScene.create() or generateUITextures():
if (!this.textures.exists('ability_freeze')) {
  this.generateAbilityFreezeIcon();
}
```

Or, for assets generated in a loop (like towers), make sure the loop already
checks `aiLoadedTiles` — tower generation already does this.

---

## Tile Generator Quick Reference

| Property       | Value                                  |
|----------------|----------------------------------------|
| URL            | `http://localhost:3456`                |
| Start command  | `npm run tiles`                        |
| Requires       | `FAL_AI_KEY` environment variable      |
| Output dir     | `public/assets/tiles/`                 |
| Default model  | `fal-ai/fast-sdxl` (cheapest, fast)    |
| Alt models     | `fal-ai/flux/schnell`, `fal-ai/flux/dev`, `fal-ai/stable-diffusion-v3.5` |
| Default size   | 512×512 (sprites), 1024×1024 (terrain) |
| Output format  | Always `.png`                          |

### Server API (for programmatic generation)

```bash
curl -X POST http://localhost:3456/api/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "fal-ai/fast-sdxl",
    "prompt": "top-down game icon, glowing blue snowflake crystal...",
    "tileName": "ability_freeze",
    "width": 512,
    "height": 512
  }'
```

The API also supports:
- `GET /api/tiles` — list all generated tiles
- `DELETE /api/tiles/{name}` — delete a tile
- `POST /api/remove-bg` — remove background from an existing tile
- `GET /api/models` — list available fal.ai models
- `GET /api/test` — health check

---

## Prompt Crafting Guidelines

When writing prompts for the AI image generator, follow these rules to get
consistent results:

1. **Start with style keywords**: `top-down game asset`, `isometric`, `2D game sprite`
2. **Describe the subject clearly**: what it is, what it looks like, key features
3. **Specify colors**: `glowing blue`, `dark stone`, `fiery red and orange`
4. **Add quality keywords**: `sharp details`, `clean edges`, `stylized`, `high quality`
5. **Mention background**: `on dark transparent background` or `isolated on black`
6. **Avoid photorealism**: the game is stylized, not realistic. Use `stylized fantasy art`, `vector art style`, or `pixel art style`
7. **Keep it concise**: 2–4 sentences max. Overly long prompts confuse the model.

### Example Prompts

| Asset                  | Prompt                                                                                     |
|------------------------|--------------------------------------------------------------------------------------------|
| Blizzard ability icon  | `top-down game icon, glowing blue snowflake crystal radiating frost, on dark transparent background, stylized fantasy art, sharp details` |
| Meteor ability icon    | `top-down game icon, flaming orange meteor descending with fire trail, on dark transparent background, stylized fantasy art, sharp details` |
| Medieval stone house   | `isometric game sprite, medieval stone cottage with red tile roof and chimney, stylized vector art, sharp edges, isolated on dark background` |
| Pine tree decoration   | `top-down game asset, dark green pine tree viewed from above, circular canopy, stylized, clean edges, on dark background` |
| Lava terrain tile      | `seamless top-down terrain tile, cracked volcanic rock with glowing orange lava veins, dark grey and black with bright orange highlights, tileable texture, stylized fantasy art` |
| Snow terrain tile      | `seamless top-down terrain tile, pristine white snow with subtle blue shadows and ice crystals, tileable texture, stylized fantasy art, clean` |

---

## Common Pitfalls

1. **Forgetting the procedural fallback** — the game MUST work without AI
   images. Always add a `generate*()` method.

2. **Mismatched texture key and filename** — the key in `this.load.image(key, path)`
   must match the filename (without `.png`). `ability_freeze` loads
   `ability_freeze.png`.

3. **Not restarting the dev server** — Vite HMR does not detect new files in
   `public/assets/tiles/`. After generating new images, the user MUST reload
   the browser (Cmd+R / F5). No server restart needed.

4. **Generating transition tiles with AI** — `tile_trans_grass_0.png` through
   `tile_trans_grass_15.png` should NEVER be AI-generated. They are always
   procedural. The game's procedural transition generator runs in `create()`
   regardless.

5. **Wrong image size** — for terrain tiles, generate at 1024×1024 to
   support crop-based anti-repetition. For sprites and icons, 512×512 or
   smaller is fine.

6. **Forgetting to set the correct depth** — decorations should render at
   depth 0.3–0.5 (between terrain and towers). Sprites on the game map
   should use appropriate depth so they layer correctly.

7. **Not telling the user to run `npm run tiles`** — the tile generator is a
   separate process. Always remind the user to start it before generating.
