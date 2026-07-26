# UI Modernization Requirements

> **Approach**: Hybrid — switch to `Phaser.Scale.RESIZE` + keep all UI in Phaser-native
> Graphics with significantly upgraded visual styling.

---

## 1. Scale Mode: FIT → RESIZE

| # | Requirement | Details |
|---|---|---|
| 1.1 | Switch `Phaser.Scale.FIT` → `Phaser.Scale.RESIZE` in `main.ts` | Canvas fills the entire browser window. Game world stays at 1776×912 internal; camera viewport adapts. |
| 1.2 | Remove `autoCenter` (no longer needed in RESIZE) | The canvas IS the window — no letterboxing. |
| 1.3 | Game world camera must handle variable viewport | `cameras.main.setViewport(0, 0, W, H)` where W/H are `this.scale.width/height`. The world bounds remain 1776×912 — if the viewport is larger, the camera sees more of the map (or zooms out to fit). |
| 1.4 | UI elements reposition on resize | Existing `resize()` methods on HUD and BottomBar already do this. Extend to floating badges and ability buttons. |

---

## 2. Top Bar: Remove, Replace with Floating Badges

### 2.1 Remove the solid top bar
- Delete the 75px `#0d1117` background rectangle (`HUD.bar`)
- Delete `UI_TOP_HEIGHT` from constants (or set to 0)
- The game world camera viewport now starts at y=0

### 2.2 Floating status badges (top-right, horizontally aligned)

Each badge is a **pill-shaped rounded rectangle** with:
- Semi-transparent dark background (`#0d1117` at ~85% alpha)
- 1px white border (`#ffffff` at ~30% alpha)
- Subtle drop shadow (offset dark rectangle behind, 2px down, 2px right)
- Emoji icon + value text inside

| Badge | Icon | Content | Color |
|---|---|---|---|
| Health | ♥ | `20` | `#ff4444` (red when ≤5, pulsing tween) |
| Gold | $ | `200` | `#ffd700` |
| Timer | ⏱ | `12:34` | `#8899aa` |
| Settings | ⚙ | (icon only) | `#aabbcc` |

Layout: right-aligned, `[Health] [Gold] [Timer] [Settings]`, 8px gap between, 12px from right edge, 12px from top.

### 2.3 Settings panel
- Clicking the ⚙ badge opens a **modal overlay** (semi-transparent backdrop + centered panel)
- Contains:
  - 🎵 BGM toggle (with on/off state)
  - 🔊 SFX toggle (with on/off state)
  - ⏸ Pause / ▶ Resume button
  - Close button (✕) or click backdrop to dismiss
- Panel is a rounded rect with drop shadow, ~320px wide

### 2.4 Removed elements
- Weather icon + label + countdown → **removed from UI** (visual effects still play on map)
- Combo counter → **moved** into a floating badge at **top-center** (or merged into kill feed)
- Wave counter → **moved** into the "Send Wave" button (see §4)
- Boss HP bar → **keep** centered position, just below floating badges

---

## 3. Elevated Button Style System

All interactive buttons in the game should share a consistent "elevated" look.

### 3.1 Visual properties

| Property | Value |
|---|---|
| Background | Dark fill with subtle vertical gradient (top slightly lighter) |
| Corner radius | 8px |
| Border | 1px, semi-transparent themed color |
| Drop shadow | 2px down, 2px right, `#000000` at ~40% alpha |
| Hover state | Background lightens, scale tween 1.0 → 1.04 over 100ms |
| Press state | Scale tween 1.04 → 0.97 over 50ms (feels like pressing down) |
| Disabled state | Muted colors, reduced alpha, no hover effect |

### 3.2 Implementation approach
- Create a shared `drawElevatedButton()` utility in a new file `src/utils/ButtonStyles.ts`
- Accepts: `Graphics`, `cx`, `cy`, `w`, `h`, `color`, `hover`, `disabled`, `theme`
- Internally draws: shadow rect → gradient fill rect → border rect
- All existing `drawTowerBtn`, `drawUBtn`, `drawWaveBtn`, `drawAbilityFloatingIcon` call this utility

### 3.3 Button themes

| Theme | Use case | Border color | Fill base |
|---|---|---|---|
| `tower` | Tower build buttons | Tower-specific color | `#1e3a5f` |
| `wave` | Send wave button | `#44ff88` | `#0f2a1a` |
| `ability` | Ability cast buttons | Ability-specific color | `#1a2a3a` |
| `upgrade` | Upgrade/evolve/sell buttons | Action color | `#1e3a5f` |
| `badge` | Top-right status badges | `#ffffff` (30%) | `#0d1117` |
| `settings` | Settings panel buttons | `#2a3a4a` | `#1a2a3a` |

---

## 4. "Send Wave" Button Redesign

### 4.1 Content
The wave button shows:
```
WAVE 3 / 50
▶ SEND
[SPACE]
```
- Top line: current wave / total waves, centered
- Middle: icon + label
- Bottom: hotkey hint, smaller

### 4.2 Visual
- Uses the `wave` theme from the elevated button system
- Dark green base with brighter green border
- Pulsing glow effect when a wave is complete and the button is ready
- During countdown, show countdown seconds in place of "▶ SEND"
- During an active wave, button is disabled (greyed out)

### 4.3 Position
- Right side of the bottom bar, same general area as current
- Width adapts to available space

---

## 5. Bottom Bar: Scrolling + Responsive Layout

### 5.1 Horizontal scroll for tower buttons
- When the window width is too narrow for all 6 tower buttons (190px each + gaps), the button row becomes **horizontally scrollable**
- Implementation: wrap tower buttons in a `PhaserScrollableContainer`
  - Clips to a viewport rect
  - Responds to mouse wheel (horizontal scroll)
  - Shows scroll indicators (faded arrows or gradient fade at edges) when content overflows
  - Touch/drag to scroll

### 5.2 Responsive bottom bar height
- `UI_BOTTOM_HEIGHT` becomes a **percentage of window height** (e.g., `Math.max(180, sh * 0.22)`) rather than a fixed 220px
- On very short windows, the bar height reduces to give more map space

### 5.3 Upgrade panel
- When a tower is selected, the tower buttons hide and upgrade/evolve/sell buttons appear
- Same scroll behavior if buttons overflow

---

## 6. Ability Buttons: Unique Designs

Each of the 4 ability buttons gets a **themed visual treatment** beyond just the icon:

| Ability | Theme | Visual |
|---|---|---|
| Freeze ❄ | Ice | Crystal-blue gradient bg, frost border, snowflake particle-like icon |
| Meteor ☄ | Fire | Dark red/orange gradient bg, flickering ember border, comet icon with trail |
| Lightning ⚡ | Storm | Purple/blue gradient bg, electric arc border (jagged), lightning bolt icon |
| Heal 💚 | Nature | Green gradient bg, vine/leaf border, cross/heart icon with pulse |

### 6.1 Cooldown overlay
- When on cooldown, a **radial wipe** (clockwise pie-slice fill) or a vertical-fill dark overlay animates from bottom to top
- Cooldown seconds displayed centered, large font

### 6.2 Position
- Top-left, stacked vertically (4 buttons)
- Starting from y=8 (no more top bar offset)
- If window is too short for all 4, they become a horizontal row at the top (responsive)

---

## 7. Hero Status & Combo

### 7.1 Hero status
- Bottom-left floating pill badge (left of bottom bar area)
- Shows: `HERO Lv3 ♥●●●○○`
- Styled like the top-right badges but left-aligned

### 7.2 Combo counter
- Top-center floating badge
- Shows: `×5 [12]` (multiplier + kill count)
- Animated scale pulse on combo increase
- Color changes with tier (gold → orange → red)

---

## 8. Boss HP Bar

- Keep centered, just below the floating top badges
- Wider, thinner bar (880px → responsive width, 12px height)
- Gradient fill (green → yellow → red based on HP %)
- Boss name label above the bar

---

## 9. Minimap

- Keep at top-right, positioned below the floating badges row
- If window is very narrow, the minimap can be toggled via settings

---

## 10. Implementation Order

| Phase | Tasks | Files |
|---|---|---|
| **Phase 1** | Switch scale mode to RESIZE, update camera/viewport logic | `main.ts`, `GameScene.ts`, `constants.ts` |
| **Phase 2** | Create elevated button utility | `src/utils/ButtonStyles.ts` (new) |
| **Phase 3** | Replace top bar with floating badges + settings panel | `HUD.ts` (major rewrite), `GameScene.ts` |
| **Phase 4** | Redesign "Send Wave" button with wave counter inside | `BottomBar.ts` |
| **Phase 5** | Apply elevated style to all tower/upgrade buttons | `BottomBar.ts` → uses `ButtonStyles` |
| **Phase 6** | Unique ability button designs | `GameScene.ts` → `createFloatingAbilities()` |
| **Phase 7** | Scrollable bottom bar container | New `src/ui/ScrollableContainer.ts`, `BottomBar.ts` |
| **Phase 8** | Responsive positioning (all elements recalc on resize) | All UI files |

---

## 11. Constants Changes

```typescript
// REMOVE
export const UI_TOP_HEIGHT = 75;    // top bar no longer exists

// CHANGE
export const UI_BOTTOM_HEIGHT = 220; // → becomes dynamic: Math.max(180, sh * 0.22)

// ADD
export const BADGE_HEIGHT = 36;      // floating badge pill height
export const BADGE_GAP = 8;          // gap between badges
export const BADGE_PADDING_X = 14;   // horizontal padding inside badge
```

---

## 12. Non-Goals (Out of Scope)

- No DOM/CSS overlay — everything stays in Phaser
- No external UI library (no RexUI, no Svelte/React)
- No changes to the tile rendering pipeline
- No changes to tower/enemy/hero game logic
- No changes to the menu scene or game-over scene (those can be a follow-up)
