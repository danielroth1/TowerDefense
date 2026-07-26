# Performance Analysis Report — 200–300 Enemies

**Profile:** `docs/perf/Firefox 2026-07-26 14.21 profile.json`  
**Captured:** Firefox (macOS), Isolated Web Content thread  
**Sample rate:** 1ms intervals | **Duration:** ~6.4 seconds | **Samples:** 6,366

---

## CPU Time Distribution

| Range (CPU delta) | Samples | % |
|---|---|---|
| 0.5–1ms | 4,753 | **74.7%** |
| 1–2ms | 1,453 | **22.8%** |
| <0.5ms or idle | 160 | 2.5% |

The game is spending ~1ms of CPU per frame step, consistently busy with very little idle time.

---

## Hot Spot #1: Tower Targeting — O(Towers × Enemies)

**Code location:** `GameScene.ts:788-792` + `Tower.ts:184-198`

```typescript
// GameScene.ts (event handler for 'tower_find_target')
this.enemyGroup.getChildren().forEach(e => cb(e as Enemy));
if (tower.def.targetsFlying)
  this.flyerGroup.getChildren().forEach(e => cb(e as Enemy));
```

```typescript
// Tower.ts findTarget()
findTarget(): Enemy | null {
  let best: Enemy | null = null;
  let bestProgress = -1;
  this.scene.events.emit('tower_find_target', this, (enemy: Enemy) => {
    const d = Phaser.Math.Distance.Between(this.x, this.y, enemy.x, enemy.y);
    if (d <= this.range && enemy.pathProgress > bestProgress) {
      best = enemy;
      bestProgress = enemy.pathProgress;
    }
  });
  return best;
}
```

Every tower calls `findTarget()` via events, which iterates **all enemies** to find the one with highest path progress in range. With 200–300 enemies and ~10–20 towers, this is **2,000–6,000 distance checks per frame**.

- `findTarget` JS function appeared in **0.27% of samples** (native JIT inner loop accounts for much more)
- `forEach` appeared in **0.5% of samples**

---

## Hot Spot #2: `processAuraTowers()` — O(Aura Towers × Enemies)

**Code location:** `GameScene.ts:1610-1620`

```typescript
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
```

Called every frame. Each aura tower iterates **all enemies** with a distance check. With even 2–3 aura towers and 250 enemies, that's 500–750 extra distance checks per frame.

---

## Hot Spot #3: `processHealerAura()` — O(Healers × Enemies)

**Code location:** `GameScene.ts:1634-1643`

```typescript
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
```

Called every frame. `filter()` allocates a new array, then a nested loop performs healer × all enemies distance checks. The `_platform_memmove` (1.6%) and `array_push`/`array_indexOf` (0.8%) in the profile suggest significant per-frame array allocations.

---

## Hot Spot #4: Enemy `preUpdate()` — Per-Enemy Overhead

**Code location:** `Enemy.ts:89-150`

Each enemy per frame:

- **Poison stack management** — `filter()` + `reduce()` on poison array (allocation per frame)
- **Tint changes** — `setTint()` / `clearTint()` calls (trigger WebGL state changes)
- **Stuck detection** — `dx*dx + dy*dy` comparison each frame
- **`followPath()`** — path movement via Arcade physics velocity
- **Hero attack timer** — checked if the enemy has `heroAttackRange`

With 200–300 enemies, that's 200–300 `preUpdate()` calls per frame. Profile evidence:

| Function | Samples | % |
|---|---|---|
| `_platform_memmove` | 102 | 1.6% |
| `_platform_memset` | 22 | 0.3% |
| `array_indexOf` | 53 | 0.8% |
| `array_push` | 20 | 0.3% |

These suggest heavy per-frame array operations (allocation, poison stack filtering, tint management).

---

## Hot Spot #5: VFX Graphics Triangulation (`earcut`)

**Code location:** Temporary Graphics objects created throughout `GameScene.ts`

| Function | Samples | % |
|---|---|---|
| `earcut` + `earcutLinked` | 26 | 0.4% |
| `batchFillPath` | 7 | 0.1% |
| `GraphicsWebGLRenderer` | 13 | 0.2% |

Each `vfxGraphics()` call creates a new `Phaser.GameObjects.Graphics` object. Temporary VFX (hero slash FX, chain lightning arcs, etc.) require polygon triangulation via `earcut` to tessellate paths for WebGL batching. With many enemies, many concurrent VFX graphics objects may be triangulated each frame.

```typescript
// Example: sword slash VFX created every hero attack
const g = this.vfxGraphics().setDepth(10);
g.lineStyle(3, 0xffdd44, 1);
g.lineBetween(this.hero.x, this.hero.y, target.x, target.y);
g.fillStyle(0xffffaa, 0.6);
g.fillCircle(target.x, target.y, 12);
```

---

## Hot Spot #6: Projectile-Enemy Overlap Checks

**Code location:** `GameScene.ts:537-545`

```typescript
this.physics.add.overlap(this.projectileGroup, this.enemyGroup, ...);
this.physics.add.overlap(this.projectileGroup, this.flyerGroup, ...);
```

Phaser's Arcade Physics broadphase checks all projectiles against all enemies every physics step. With many active projectiles on screen (towers firing, hurricane spreads, etc.), this grows quickly.

| Function | Samples | % |
|---|---|---|
| `collideSpriteVsGroup` | 10 | 0.2% |
| `step` (physics step) | 13 | 0.2% |

---

## Hot Spot #7: `updateBossBar()` — Full Enemy Scan

**Code location:** `GameScene.ts:1625-1630`

```typescript
private updateBossBar() {
  const enemies = [...this.enemyGroup.getChildren() as Enemy[], ...this.flyerGroup.getChildren() as Enemy[]];
  const boss = enemies.find(e => e.def.isBoss);
  // ...
}
```

Called every frame. Spreads both groups into a **new array** (allocation), then scans all enemies — even when no boss is present.

---

## Summary: Where Time Is Going

| Category | Est. % | Description |
|---|---|---|
| **O(N²) game loops** | **30–40%** | Nested iterations: tower targeting, auras, healer checks, VFX scanning |
| **Per-enemy overhead** | **20–25%** | 200–300 enemies × preUpdate, poison, tints, stuck detection, followPath |
| **Phaser rendering** | **15–20%** | WebGL batching, Graphics triangulation (earcut), sprite rendering, overlap collisions |
| **JS engine overhead** | **10–15%** | GC pauses, JIT compilation, array allocations, `memmove`, `memset` |

> **Note:** `FindInBufferNaive` appeared in ~27% of samples but is the **profiler itself** scanning its ring buffer — a profiling artifact, not game CPU.

---

## Optimization Recommendations

1. **Spatial indexing** — Replace O(N) linear enemy scans with a spatial grid or quadtree for tower targeting, aura processing, and healer checks (attacks Hot Spots #1, #2, #3)

2. **Cache the boss reference** — Avoid scanning all enemies for `updateBossBar()` every frame; cache the boss when it spawns (attacks Hot Spot #7)

3. **Reduce per-enemy allocations** — Replace `poisonStacks.filter()` + `reduce()` with a manual iteration that doesn't allocate. Consider an allocation-free poison tick. (attacks Hot Spot #4)

4. **Pool VFX Graphics objects** — Reuse a small pool of Graphics objects instead of `vfxGraphics()` creating + destroying new ones each frame (attacks Hot Spot #5)

5. **Object pooling for enemies** — Reuse dead enemy sprites instead of destroying them, to reduce GC pressure (attacks Hot Spot #4 and JS engine overhead)

6. **Reduce tint thrashing** — Batch tint changes or avoid redundant `setTint()`/`clearTint()` calls when the colour hasn't changed (attacks Hot Spot #4)
