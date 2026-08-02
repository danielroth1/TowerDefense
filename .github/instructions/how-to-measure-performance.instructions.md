# How to Measure Performance — Vector Tower Defense

Use this guide when the user asks to **measure / profile the game**, **find
performance bottlenecks**, **run a perf test**, or **verify an optimization**.
It covers the built-in perf-test mode, capturing traces with Chrome DevTools
MCP (or manually), and analyzing the traces with the project's analyzer script.

---

## 1. The Built-In Perf Test Mode

The game ships with a stress-test mode started from the menu:

| Control | What it does |
|---------|--------------|
| **PERF TEST** | Starts `GameScene` with `perfTest: true`. `PerfTest.ts` fills buildable tiles with random towers + eco buildings and spawns enemies according to the saved settings. |
| **PERF SETTINGS** | Opens a panel to configure enemies / towers / eco / field size before running. |

> **⚠️ Default perf settings spawn NO enemies** (`spawnEnemies: false` in
> `src/data/PerfSettings.ts`). A realistic load test must enable enemies in
> PERF SETTINGS (e.g. 500 enemies @ 4ms spawn, 20% towers, 20% eco).

Config knobs (see `src/data/PerfSettings.ts`):

- `spawnEnemies`, `enemySpawnRate` (ms between spawns), `enemyAmount`
- `spawnTowers`, `towerPercentage` (% of buildable cells)
- `placeEcoBuildings`, `ecoBuildingPercentage`
- `fieldCols` / `fieldRows` (map size; presets 20×13, 30×19, 40×25)

Enemies spawn at `enemySpawnRate` intervals, so at 4ms a batch of 500 is fully
spawned in ~2s and then traverses the map (~30–60s). **Start the trace during
the peak population window**, not after the wave dies out.

---

## 2. Capturing a Trace

### Method A — Chrome DevTools MCP (recommended for AI agents)

The Chrome DevTools MCP browser is a **separate instance** from the VS Code
browser/Playwright tools — a click in one tab does NOT affect the other. The
MCP exposes no click tool, so drive the perf test by injecting an **init
script** during navigation that auto-starts it.

1. Make sure the dev server is running: `npm run dev` (port 5173).
2. **Start the trace first**, then reload with the init script, so the capture
   includes boot + peak gameplay:

   ```
   performance_start_trace  { reload: false, autoStop: false,
                              filePath: "docs/perf/<name>.json" }
   navigate_page            { type: "url", url: "http://localhost:5173/?perf=auto",
                              initScript: <see below> }
   ```
3. Wait ~30–40s (enemies spawn in ~2s and traverse the map).
4. Stop the trace: `performance_stop_trace`.
5. Analyze: `node scripts/analyze-perf-trace.mjs docs/perf/<name>.json`

Init script (polls for the menu, applies a heavy config, starts the test):

```js
(function () {
  function tryStart() {
    try {
      var game = window.__game;
      if (!game) return false;
      var menu = game.scene.getScene('MenuScene');
      if (!menu || !menu.scene.isActive()) return false;
      if (typeof menu.startGamePerfTest !== 'function') return false;
      menu.currentPerfSettings = {
        spawnEnemies: true, enemySpawnRate: 4, enemyAmount: 500,
        spawnTowers: true, towerPercentage: 20,
        placeEcoBuildings: true, ecoBuildingPercentage: 20,
        fieldCols: 30, fieldRows: 19
      };
      menu.startGamePerfTest();
      document.title = 'PERF-STARTED';   // visible via list_pages
      return true;
    } catch (e) { return false; }
  }
  var iv = setInterval(function () { if (tryStart()) clearInterval(iv); }, 100);
  setTimeout(function () { clearInterval(iv); }, 20000);
})();
```

Verify it started by checking `list_pages` → the page title shows `PERF-STARTED`.

### Method B — Manual (human, browser DevTools)

1. `npm run dev`, open http://localhost:5173 in Chrome.
2. Enable enemies in **PERF SETTINGS**, then click **PERF TEST**.
3. Open DevTools → **Performance** panel → **Record** (or use the Firefox
   Profiler). Record 10–30s during peak load.
4. Save the profile for later analysis if needed.

---

## 3. Analyzing a Trace

```
node scripts/analyze-perf-trace.mjs <trace.json> [topN]
```

The script (`scripts/analyze-perf-trace.mjs`) reports four sections:

| Section | What it tells you |
|---------|-------------------|
| **FRAME RATE** | Effective FPS, avg / p50 / p95 / p99 frame intervals, and % of frames that miss 16.7ms / 33.4ms budgets (hitches). |
| **MAIN-THREAD vs GPU** | Total `RunTask` (main-thread) time, GPU time, average/slowest task. `RunTasks > 33ms` = dropped frames. |
| **TOP JS FUNCTIONS** | Total duration of `FunctionCall` timeline events — a coarse per-function view. |
| **V8 CPU PROFILE SAMPLES** | True sampling-based per-function cost. **Inclusive** = self + callees; **Self** = pure cost. This is the most reliable hotspot list. |

The MCP trace includes V8 samples inside `ProfileChunk` events under
`args.data.cpuProfile` (nodes + samples, with parallel `timeDeltas`). The
analyzer decodes this automatically; it also falls back to `FunctionCall`
attribution if samples are absent.

---

## 4. What to Look For (bottleneck heuristics)

- **`GraphicsWebGLRenderer` / `batchFillPath` / `earcut` on top** →
  too many per-frame `Phaser.GameObjects.Graphics` polygon redraws. Rounded
  rectangles (`fillRoundedRect`/`strokeRoundedRect` with a radius) are
  especially expensive — Phaser must triangulate them with earcut on every
  redraw. Known per-frame offenders:
  - `BottomBar.refreshBuildAffordability()` — redraws every tower button
    **every frame** even when nothing changed.
  - `updateMinimap()` — clears + redraws the minimap viewport rect **every frame**.
  - `HPBarPool.render()` — redraws all HP bars every frame (cheap rects, but
    still triangulated).
  - VFX via `AbilitySystem.vfxGraphics()` — creates new Graphics per effect.
- **`update` (Phaser) / `GameScene.update` / `emit` on top** → game-logic and
  event-system cost (tower targeting, auras, healer scans). See
  `docs/perf/perf-analysis-report.md` for the historical O(N²) findings.
- **`Enemy.preUpdate` on top** → per-enemy overhead (path following, poison
  stacks, tint changes).
- **Main-thread busy > ~85%** (RunTask time ≈ trace time) → no headroom; the
  next feature or a GC/VFX spike will drop frames.
- A single huge `RunTask` at trace start is usually **`BootScene.create()`**
  (`generateMipmapsForAITiles()` downsamples 1024² AI textures on the CPU) —
  that's a one-time startup stall, not per-frame.

---

## 5. Known Pitfalls

- **MCP browser ≠ Playwright browser.** Clicking in the VS Code shared browser
  does not affect the Chrome DevTools MCP tab. Use the init-script approach.
- **Default perf test has no enemies** — remember to enable them.
- **Start tracing at peak population**, or the profile is mostly idle (you'll
  see a large `(idle)` share and misleading percentages).
- **Boot stall pollutes the trace** — it's one ~1.5s task; ignore it or start
  the trace after `PERF-STARTED`.
- **Browser extensions** (Dark Reader etc.) pollute profiles — use a clean
  profile.
- Traces are scratch files: `docs/perf/*` is **gitignored**. Reports belong in
  `docs/perf/*.md` (see `docs/perf/perf-analysis-report.md` for the format).

---

## 6. Worked Example — 2026-08-02 (500 enemies)

Config: 500 enemies @ 4ms, 20% towers, 20% eco, 30×19, Chrome DevTools MCP.

| Metric | Value |
|--------|-------|
| Frames / span | 4374 frames / 42.9s |
| Effective FPS | 102 (includes ~1.5s boot stall) |
| p50 / p99 frame interval | 8.15ms / 11.09ms |
| Frames > 16.7ms | 0.4% |
| Main-thread busy (RunTask) | 29.5s / 42.9s ≈ **69%** |
| Slowest RunTask | **1509ms** (`BootScene.create` mipmaps) |
| `step` (whole frame) avg | ~6.7ms |

Top V8 profile (inclusive % of 43.3s sampled):

| Function | % | Meaning |
|----------|---|---------|
| `step` (Phaser) | 37.2% | whole game frame |
| `render` | 30.0% | draw pass |
| `GraphicsWebGLRenderer` | 26.3% | all Graphics rendering |
| `batchFillPath` → `earcut` | 18.7% → 16.4% | **polygon-fill triangulation** |
| `earcutLinked` / `isEarHashed` / `sortLinked` / `indexCurve` / `isEar` | 14.9% / 5.9% / 4.7% / 5.4% / 2.0% | earcut internals |
| `batchStrokePath` → `batchLine` | 3.3% → 2.9% | rounded-rect strokes |
| `update` (Phaser) / `GameScene.update` | 5.7% / 3.2% | game logic |
| `emit` | 2.4% | Phaser event system |
| `BootScene.create` | 3.4% | one-time startup (mipmaps 1.8%) |
| `BottomBar.update` / `refreshBuildAffordability` | 1.6% / 1.6% | per-frame button redraw |

**Bottom line:** the render pass — specifically **earcut triangulation of
Graphics polygons (rounded-rect UI + HP bars + minimap, redrawn every
frame)** — dominates. Game logic (update, targeting, enemies) is a distant
second. See `docs/perf/chrome-perf-analysis-report.md` for the full write-up.
