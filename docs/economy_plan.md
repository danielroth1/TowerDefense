# Economy Simulation — Implementation Plan

## Overview

Add a player-driven economy layer to the tower defense game. Players place
production buildings that form supply chains, generating passive gold income.
Goods are visibly transported along the existing decorative road network.
All new building visuals are generated via the AI tile generator tool.

---

## Design Principles

- **No micro-management** — Player only places and upgrades buildings.
  Production and transport are fully automatic.
- **Buildings are not destructible** — Once placed, economy buildings are
  permanent (unlike towers, enemies don't target them).
- **Existing decorative houses stay** — They remain as purely-visual obstacles
  the player must build around, adding placement tension.
- **Harbors become player-buildable** — Currently decorative, harbors are
  promoted to functional economy buildings.
- **Visible feedback** — Carts move on roads, warehouses fill up, particles
  (chimney smoke, fishing ripples) make the economy feel alive.

---

## Production Chains

### Chain A: Agriculture (Farm → Mill → Bakery)

```
┌──────────┐   wheat    ┌──────────┐   flour    ┌──────────┐   bread    ╔══════════╗
│   FARM   │ ────────▶  │   MILL   │ ────────▶  │  BAKERY  │ ────────▶  ║   GOLD   ║
│  (new)   │  (cart)    │  (new)   │  (cart)    │  (new)   │  (cart)   ║ (passive)║
└──────────┘            └──────────┘            └──────────┘            ╚══════════╝
```

| Building | Produces | Consumes | Cycle Time | Upgrade |
|----------|----------|----------|------------|---------|
| Farm     | Wheat    | —        | 12s        | L2: 8s, L3: 5s |
| Mill     | Flour    | Wheat    | 10s        | L2: Windmill (6s), L3: Industrial Mill (4s) |
| Bakery   | Bread → Gold | Flour | 10s        | L2: 7s, L3: 5s |

**Gold value per bread:** 15g (scales with chain completeness — see Chain Bonus below)

### Chain B: Fishing (Fishery → Harbor)

```
┌──────────┐   fish     ┌──────────┐    ╔══════════╗
│ FISHERY  │ ────────▶  │  HARBOR  │ ─▶ ║   GOLD   ║
│  (new)   │  (cart)    │(promoted)│    ║ (passive)║
└──────────┘            └──────────┘    ╚══════════╝
```

| Building | Produces | Cycle Time | Upgrade |
|----------|----------|------------|---------|
| Fishery  | Fish     | 10s        | L2: 7s, L3: 5s |
| Harbor   | Fish → Gold | —       | L2: +50% value, L3: Attracts trade ships |

**Gold value per fish:** 10g at Harbor

### Chain Bonus

A complete chain (all buildings connected by road) gives a **25% gold bonus**
per delivery. Incomplete chains still work — a lone Farm generates 5g/wheat
directly, but routing through Mill → Bakery multiplies value.

### Warehouse (optional building)

```
┌───────────┐
│ WAREHOUSE │  — Stores up to 5 goods. Fills visually.
│   (new)   │    When full, delivers all at once with 50% bonus.
└───────────┘    Placed between production and endpoint.
```

Warehouses are optional. They act as a buffer and multiplier but add latency
(must fill before payout).

---

## Building Placement Rules

| Building  | Terrain Required       | Size | Base Cost |
|-----------|------------------------|------|-----------|
| Farm      | Grass, NOT adjacent to water | 1×1 | 100g |
| Mill      | Grass, adjacent to road     | 1×1 | 130g |
| Bakery    | Grass, adjacent to road     | 1×1 | 160g |
| Fishery   | Grass, adjacent to water    | 1×1 | 80g |
| Harbor    | Straddles grass + water     | 2×1 | 200g |
| Warehouse | Grass, adjacent to road     | 1×1 | 70g |
| Lighthouse| Grass, adjacent to water    | 1×1 | 250g |

- Buildings **cannot** be placed on path tiles or spawn/goal
- Buildings **cannot** overlap existing decorative houses (blockedCells from CityDecorator)
- Buildings **cannot** overlap towers, barricades, or other economy buildings
- All economy buildings are 1×1 except Harbor (2×1 straddling grass+water)

### Escalating Costs

There is **no hard cap** on the number of economy buildings. Instead, each
additional building of the same type costs **+25% more** than the previous:

| Farm # | Cost |
|--------|------|
| 1st    | 100g |
| 2nd    | 125g |
| 3rd    | 156g |
| 4th    | 195g |
| 5th    | 244g |

This naturally discourages spam and encourages diversifying across farm,
fishery, and chain buildings. Different building types have independent
cost escalators (building a Fishery doesn't increase Farm costs).

---

## Transport System

### How it works

1. On each production cycle, a **cart sprite** spawns at the producer building
2. The cart follows the **existing road network** (from `CityRoadNetwork.ts`)
   to the consumer building
3. Road network is extended dynamically when new player buildings are placed
   (re-run the Steiner-tree algorithm with updated building positions)
4. Cart speed: ~80 px/s. A cart despawns on arrival and triggers the consumer's
   production cycle or gold payout

### Cart visuals

- Small 16×16 sprite (AI-generated or procedural)
- Tinted by cargo type: wheat = gold, flour = white, bread = brown, fish = blue
- Simple tween along road polyline (no physics needed)

---

## Visual Feedback

### Animated workers
- **Farm**: Simple figure with hoe, idle sway animation (2-3 frame spritesheet)
- **Fishery**: Figure with fishing rod, occasional cast animation. Rod tip
  bobs when fish is "on the line"
- **Mill**: Sails rotate (tweened rotation on the windmill texture)
- **Bakery**: Chimney smoke particles (reuse existing particle system)
- **Harbor**: Occasional dock worker, net-hauling animation

### AI-Generated Textures
All new building textures are generated via the AI tile generator
(`tools/tile-generator/`). Each building type needs a prompt crafted for
top-down/isometric view at 256×256 or 512×512:

| Texture Key          | Description for AI Prompt |
|----------------------|--------------------------|
| `eco_farm`           | Top-down medieval farm, crops, fence, 2×2 tiles |
| `eco_mill`           | Top-down windmill, stone base, wooden sails |
| `eco_bakery`         | Top-down bakery, chimney, cobblestone |
| `eco_fishery`        | Top-down fishing hut, dock, nets |
| `eco_harbor`         | Top-down wooden pier, posts, water reflection (already have `deco_city_harbor` — reuse) |
| `eco_warehouse`      | Top-down warehouse, loading bay, barrels |
| `eco_lighthouse`     | Top-down lighthouse, beacon glow |
| `eco_cart`           | Tiny cart or wagon, 32×16 |
| `eco_boat_trade`     | Small trading ship, top-down, sails |

### Warehouse fill levels
- Warehouse texture is generated at its "empty" state
- Fill level shown via a colored rectangle mask that grows upward from the
  bottom of the sprite (0–100% based on stored goods / capacity)
- Each stored good type has a distinct color band

---

## Lighthouse (Stretch Goal)

- Placed on shoreline grass cells
- Extends vision range (lifts fog of war? Or reveals stealth enemies if
  that mechanic is added later)
- At upgrade level 2: **+25% trade ship frequency** at all harbors
- Beam effect: rotating cone of light (semi-transparent triangle sprite
  with rotation tween)

---

## Trade Ships (Stretch Goal)

- Periodically (every 60–90s), a **trade ship** appears at a harbor
- The ship is an AI-generated sprite that sails in from off-screen water
- Ship arrival = **burst of gold** (50–100g, scaled by harbor level)
- Ship despawns after delivering (sails away off-screen)
- Harbor level 2: ships arrive 30% faster
- Lighthouse increases ship frequency further

---

## Implementation Phases

### Phase 1: Data & Textures
1. Create `src/data/economy.ts` — building definitions (cost, size, production
   chain, cycle time, upgrade tiers)
2. Generate AI textures for all economy buildings using the tile generator
3. Save textures to `public/assets/tiles/eco_*.png`
4. Add preload entries in `BootScene.preload()` for all `eco_*` textures
5. Add procedural fallback generators in `BootScene` (colored rectangles with
   simple shapes — temporary until AI textures are generated)

### Phase 2: Core Economy System
1. Create `src/systems/EconomySimulation.ts`
   - Manages placed economy buildings (analogous to how towers are managed)
   - Ticks production cycles using delta time
   - Tracks inventory (wheat waiting at farm, flour at mill, etc.)
   - Emits events: `eco_produced`, `eco_delivered`, `eco_gold`
2. Create `src/entities/EconomyBuilding.ts` (or add economy data to a generic
   building entity)
3. Integrate with `EconomyManager.ts` — gold from economy routes through
   the existing `earn()` method

### Phase 3: Building Placement UI
1. Create `src/ui/EconomyPanel.ts` — similar to the tower build panel but for
   economy buildings. Shows available buildings, costs, and a toggle button in
   the bottom bar
2. Add a tab/toggle in the HUD to switch between Tower build mode and
   Economy build mode
3. Placement logic in `GameScene`:
   - Click building in panel → enter placement mode
   - Valid cells highlighted green, invalid red (already checked against
     path, water, existing buildings, decorative houses)
   - Click to place → deduct gold → spawn EconomyBuilding
   - Re-run road network generation to connect new building

### Phase 4: Transport & Animation
1. Extend `CityRoadNetwork.ts`:
   - Add `extendRoadNetwork()` function that re-runs the full Steiner-tree
     with updated building positions (player-placed buildings + existing decos)
   - Road network is regenerated on every building placement/removal
   - Start with this approach; optimize to incremental only if profiling
     shows it's a bottleneck (unlikely given small building counts)
2. Create `src/systems/TransportSystem.ts`:
   - Spawns cart sprites on production
   - Tweens carts along road polylines
   - On arrival: triggers consumer production or gold payout
   - Manages cart pool (object pooling for performance)
3. Worker animations:
   - Add simple sprite animations (2-4 frame loops) for farm worker,
     fisher, dock worker
   - Mill sail rotation via Phaser tween
   - Bakery smoke via existing particle system

### Phase 5: Warehouse & Chain Bonus
1. Warehouse building: stores goods, displays fill level
2. Chain bonus logic: detect complete chains (all buildings in a production
   path connected by road) → multiply gold output

### Phase 6: Lighthouse & Trade Ships (Stretch)
1. Lighthouse placement and vision mechanic
2. Trade ship spawning, pathing, and gold burst
3. Harbor upgrade → trade ship frequency bonus
4. Lighthouse → trade ship frequency bonus

---

## File Change Summary

| Action | File |
|--------|------|
| **NEW** | `src/data/economy.ts` |
| **NEW** | `src/systems/EconomySimulation.ts` |
| **NEW** | `src/systems/TransportSystem.ts` |
| **NEW** | `src/entities/EconomyBuilding.ts` |
| **NEW** | `src/ui/EconomyPanel.ts` |
| MODIFY | `src/systems/EconomyManager.ts` — add economy income tracking |
| MODIFY | `src/systems/CityRoadNetwork.ts` — add dynamic road extension |
| MODIFY | `src/systems/CityDecorator.ts` — export `blockedCells` for placement validation; remove harbor from decorative groups (harbors become player-buildable only; leave shoreline gap empty — no replacement decor needed) |
| MODIFY | `src/scenes/GameScene.ts` — placement mode, economy building rendering, cart rendering |
| MODIFY | `src/scenes/BootScene.ts` — preload eco textures, procedural fallbacks |
| MODIFY | `src/ui/HUD.ts` / `src/ui/BottomBar.ts` — economy mode toggle |
| MODIFY | `src/utils/constants.ts` — economy constants |
| **NEW** | `public/assets/tiles/eco_farm.png` (AI-generated) |
| **NEW** | `public/assets/tiles/eco_mill.png` (AI-generated) |
| **NEW** | `public/assets/tiles/eco_bakery.png` (AI-generated) |
| **NEW** | `public/assets/tiles/eco_fishery.png` (AI-generated) |
| **NEW** | `public/assets/tiles/eco_warehouse.png` (AI-generated) |
| **NEW** | `public/assets/tiles/eco_lighthouse.png` (AI-generated) |
| **NEW** | `public/assets/tiles/eco_cart.png` (AI-generated) |
| **NEW** | `public/assets/tiles/eco_boat_trade.png` (AI-generated) |
| **NEW** | `docs/economy_plan.md` (this file) |

---

## Resolved Design Decisions

1. **Farm size: 1×1** — All economy buildings are 1×1 except Harbor (2×1).
   Keeps placement simple and avoids hogging the 30×19 grid.

2. **No building cap** — Instead, escalating costs make spam economically
   unviable. Each additional building of the same type costs +25% more
   (e.g., 2nd Farm = 125g, 3rd = 156g, 4th = 195g, …). The player
   naturally diversifies or faces diminishing returns.

3. **Full Steiner-tree re-run on placement** — Start with the simple approach.
   Profiling will tell us if it's slow; with typical building counts (<20)
   it should be negligible. Optimize incrementally only if needed.

4. **Harbor shoreline gap: leave empty** — Removing decorative harbors from
   CityDecorator will leave some shoreline cells bare. This is fine — those
   cells become available for player-placed Fishery/Harbor/Lighthouse.

5. **Carts run during waves** — Transport continues during combat. The visual
   activity makes the city feel alive, and the player has no interaction
   with carts anyway (no click-to-collect).
