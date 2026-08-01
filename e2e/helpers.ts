import type { Page } from '@playwright/test';

/**
 * Force Phaser's `isTouch()` (src/utils/Device.ts) to report a touch device:
 * overrides `navigator.maxTouchPoints` and the `(pointer: coarse)` media query.
 */
export const TOUCH_INIT_SCRIPT = `(() => {
  try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }); } catch (e) {}
  const origMM = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    if (String(q).includes('pointer: coarse')) {
      return { matches: true, media: String(q), onchange: null,
        addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){},
        dispatchEvent(){ return false; } };
    }
    return origMM(q);
  };
})();`;

/** Collect uncaught page errors + console errors. Call BEFORE navigating. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
  return errors;
}

/** Filter pre-existing / environment noise from error lists. */
export function filterBenign(errors: string[]): string[] {
  return errors.filter((e) =>
    !/Failed to process file/.test(e) && // missing eco_harbor textures (pre-existing)
    !/content\.js/.test(e) &&            // browser-extension noise
    !/longtask/.test(e));
}

/** Wait until a scene with the given key is active. */
export async function waitForScene(page: Page, key: string): Promise<void> {
  await page.waitForFunction((sceneKey) => {
    const g = (window as any).__game;
    return !!g && g.scene.getScenes(true).some((s: any) => s.scene.key === sceneKey);
  }, key);
}

export interface StartGameOptions { seed?: string; debug?: boolean; }

/**
 * Load the game and start it from the menu. Optionally fixes the map seed and
 * toggles debug mode. Falls back to invoking the PLAY handler directly if the
 * pointer click doesn't land (touch-emulation quirks in some environments).
 */
export async function startGame(page: Page, opts: StartGameOptions = {}): Promise<void> {
  await page.goto('/');
  await waitForScene(page, 'MenuScene');

  if (opts.seed) {
    await page.locator('input[type="text"]').fill(opts.seed);
  }
  if (opts.debug) {
    await page.locator('input[type="checkbox"]').check();
  }

  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.click(size.w / 2, size.h * 0.60);
  await page.waitForTimeout(600);

  const started = await page.evaluate(() =>
    (window as any).__game.scene.getScenes(true).some((s: any) => s.scene.key === 'GameScene'));
  if (!started) {
    await page.evaluate(() => {
      const menu = (window as any).__game.scene.getScenes().find((s: any) => s.scene.key === 'MenuScene');
      const playRect = menu.children.list.find((c: any) =>
        c.input && c.input.hitArea && c.input.hitArea.width === 200 &&
        c.input.hitArea.height === 50 && c.y > 300);
      playRect.emit('pointerup', menu.input.mousePointer, 0, 0, {});
    });
  }

  await waitForScene(page, 'GameScene');
  // Let GameScene finish building (map, camera, UI)
  await page.waitForTimeout(1800);
}

/** Serializable snapshot of the GameScene state used across assertions. */
export async function gameState(page: Page): Promise<any> {
  return page.evaluate(() => {
    const g = (window as any).__game;
    const gs = g.scene.getScenes().find((s: any) => s.scene.key === 'GameScene');
    if (!gs) return null;
    return {
      zoom: gs.cameras.main.zoom,
      barH: gs._barH,
      scaleW: gs.scale.width,
      scaleH: gs.scale.height,
      gold: gs.economy.gold,
      towerCount: gs.towerGroup.getChildren().length,
      placingTower: gs.placingTower,
      pendingCast: gs.abilitySystem.pendingCast,
      isPaused: gs.isPaused,
      timerVisible: gs.hud.timerTxt.visible,
      livesVisible: gs.hud.livesTxt.visible,
      goldVisible: gs.hud.goldTxt.visible,
      fullscreenVisible: gs.hud.fullscreenTxt.visible,
      zoomIn: gs.zoomInHit ? { x: gs.zoomInHit.x, y: gs.zoomInHit.y } : null,
      zoomOut: gs.zoomOutHit ? { x: gs.zoomOutHit.x, y: gs.zoomOutHit.y } : null,
      waveCX: gs.bottomBar._WAVE_CX,
      waveCY: gs.bottomBar._WAVE_CY,
      waveLabel: gs.bottomBar.waveLabel.text,
      hotkeyVisible: gs.bottomBar.hotkeyLabels[0].visible,
      pauseBtnText: gs.hud.modalPauseBtn.text,
      scrollOffset: gs.bottomBar._scrollOffset,
      arrows: gs.bottomBar._ARROW_W,
      abilityRow: gs._abilityRow,
      abilitySize: gs._abilityBtnSize,
      abilityPos0: (() => { const p = gs.abilityPos(0); return { x: Math.round(p.cx), y: Math.round(p.cy) }; })(),
      settingsHit: { x: gs.hud.settingsHit.x, y: gs.hud.settingsHit.y },
      ctxState: gs.sfx.ctx ? gs.sfx.ctx.state : 'no-ctx',
      musicEnabled: gs.sfx.musicEnabled,
    };
  });
}

/** Screen coords of the centre of a map tile (world → screen via camera). */
export async function tileScreen(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ col, row }) => {
    const worldToScreen = (gs: any, wx: number, wy: number) => {
      const m = gs.cameras.main.matrix.matrix;
      return { x: m[0] * wx + m[2] * wy + m[4], y: m[1] * wx + m[3] * wy + m[5] };
    };
    const g = (window as any).__game;
    const gs = g.scene.getScenes().find((s: any) => s.scene.key === 'GameScene');
    const wx = col * 48 + 24, wy = row * 48 + 24;
    return worldToScreen(gs, wx, wy);
  }, { col, row });
}

/** Find a buildable tile currently visible in the viewport, or null. */
export async function findVisibleBuildable(page: Page): Promise<{ col: number; row: number; x: number; y: number } | null> {
  return page.evaluate(() => {
    const worldToScreen = (gs: any, wx: number, wy: number) => {
      const m = gs.cameras.main.matrix.matrix;
      return { x: m[0] * wx + m[2] * wy + m[4], y: m[1] * wx + m[3] * wy + m[5] };
    };
    const g = (window as any).__game;
    const gs = g.scene.getScenes().find((s: any) => s.scene.key === 'GameScene');
    const grid = gs.mapData.grid;
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        if (grid[r][c].type === 'buildable') {
          const p = worldToScreen(gs, c * 48 + 24, r * 48 + 24);
          if (p.x > 70 && p.x < gs.scale.width - 70 && p.y > 70 && p.y < gs.scale.height - gs._barH - 70) {
            return { col: c, row: r, x: Math.round(p.x), y: Math.round(p.y) };
          }
        }
      }
    }
    return null;
  });
}

/** Find the first visible build button in the bottom bar, or null. */
export async function findVisibleBuildButton(page: Page): Promise<{ i: number; x: number; y: number } | null> {
  return page.evaluate(() => {
    const g = (window as any).__game;
    const gs = g.scene.getScenes().find((s: any) => s.scene.key === 'GameScene');
    const hits = gs.bottomBar.buildHits;
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].x > 0 && hits[i].input.enabled) {
        return { i, x: Math.round(hits[i].x), y: Math.round(hits[i].y) };
      }
    }
    return null;
  });
}
