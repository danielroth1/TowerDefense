# Performance Improvement Plan — 1,000 Enemies

**Date:** 2026-07-26
**Target:** Maintain 60fps with 1,000+ concurrent enemies

---

## Summary of Changes

| # | Improvement | Impact | Complexity |
|---|-------------|--------|------------|
| 1 | HP Bar pooling (2 shared Graphics) | **High** | Low |
| 2 | Flyer targeting via spatial grid | **Medium** | Low |
| 3 | Cache `getChildren()` in update loop | **Low** | Low |

---

## 1. HP Bar Pooling

### Problem
Each enemy owns 2 `Phaser.GameObjects.Graphics` objects (`hpBarBg`, `hpBarFg`).
Every frame, each enemy calls `clear()` + `fillRect()` on both — **2,000 draw calls** per
frame for 1,000 enemies.

### Solution
Replace 2,000 per-enemy Graphics objects with **2 shared scene-level Graphics objects**
(one for backgrounds, one for foregrounds). All HP bars are drawn in a single pass
each frame via `HPBarPool.render()`.

```
Before: 1000 enemies × 2 Graphics = 2000 Graphics objects
After:  2 shared Graphics objects (bg + fg)
```

- Only draw HP bars for damaged enemies (`hp < maxHp`)
- Single `clear()` per shared Graphics per frame
- Removes `getHpBars()` from Enemy — simplifies camera ignore patching
- Eliminates per-enemy Graphics creation/destruction in `die()`/`destroy()`

### Files changed
- **NEW** `src/systems/HPBarPool.ts` — Pooled renderer
- `src/entities/Enemy.ts` — Remove `hpBarBg`, `hpBarFg`, `updateHPBar()`, `getHpBars()`
- `src/scenes/GameScene.ts` — Use `HPBarPool.render()` in `update()`, remove HP bar
  camera ignoring from group patching

---

## 2. Flyer Targeting via Spatial Grid

### Problem
`tower_find_target` uses `enemyGrid.query()` for ground enemies but does a
**full linear scan** of `flyerGroup` for towers with `targetsFlying`:

```typescript
// O(flyers) redundant scan — grid already contains flyers
this.flyerGroup.getChildren().forEach(e => {
  const d = Phaser.Math.Distance.Between(tower.x, tower.y, enemy.x, enemy.y);
  if (d <= range) cb(enemy);
});
```

### Solution
Since the spatial grid rebuild in `update()` already inserts both ground and
flying enemies into the same grid, the flyer linear scan is completely redundant.

- Remove the `flyerGroup.forEach()` block
- Use `enemy.def.isFlying` (already on `EnemyDef`) to filter grid results:
  - Towers with `targetsFlying`: accept both ground + flyers
  - Towers without: skip enemies where `enemy.def.isFlying`

### Files changed
- `src/scenes/GameScene.ts` — Update `tower_find_target` event handler

---

## 3. Cache `getChildren()` Calls

### Problem
`update()` calls `enemyGroup.getChildren()` and `flyerGroup.getChildren()`
multiple times across subsystems (grid rebuild, healer processing, boss scan).
While `getChildren()` returns the internal array without allocation, the
repeated calls are unnecessary.

### Solution
Call `getChildren()` once per group at the top of `update()` and pass the
cached arrays to subsystems.

### Files changed
- `src/scenes/GameScene.ts` — Cache arrays in `update()`
- `src/scenes/GameScene.ts` — Update `processHealerAura()` to accept pre-fetched arrays
- `src/scenes/GameScene.ts` — Update `updateBossBar()` to accept pre-fetched arrays

---

## Not Addressed (Future Work)

These items were identified but deferred for later investigation:

| Item | Reason |
|------|--------|
| Incremental grid updates | Current rebuild is O(N) and cheap per-operation; gain is marginal |
| Arcade physics broadphase | Would require switching to spatial-grid-based collision; high risk |
| Enemy `preUpdate()` micro-optimizations | Already allocation-free; gains from removing stuck/bounds checks are small |
| Dark Reader extension pollution | Profile captures should disable extensions for clean data |
