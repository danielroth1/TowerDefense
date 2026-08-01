import { test, expect } from '@playwright/test';
import {
  TOUCH_INIT_SCRIPT, startGame, gameState,
  findVisibleBuildable, findVisibleBuildButton,
} from './helpers';

test.beforeEach(async ({ page }) => {
  // Must run before any navigation so isTouch() reports a touch device.
  await page.addInitScript(TOUCH_INIT_SCRIPT);
});

// ─── Layout ───────────────────────────────────────────────────────────────

test('starts the game with touch layout applied', async ({ page }) => {
  await startGame(page, { seed: 'mobile-layout' });
  const s = await gameState(page);

  expect(s).not.toBeNull();
  expect(s.barH).toBeLessThan(200);          // slim touch bar (desktop ~200)
  expect(s.zoom).toBeGreaterThan(0.5);       // adaptive initial zoom, not 1.75
  expect(s.zoom).toBeLessThan(1.3);
  expect(s.zoomIn).not.toBeNull();           // touch zoom controls present
  expect(s.zoomOut).not.toBeNull();
  expect(s.hotkeyVisible).toBe(false);       // keyboard hints suppressed
  expect(s.waveLabel).not.toContain('[');
  expect(s.pauseBtnText).toBe('⏸ PAUSE');    // no [P] hint
});

test('hides the timer badge on very narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await startGame(page, { seed: 'narrow' });
  const s = await gameState(page);

  expect(s.timerVisible).toBe(false);
  expect(s.livesVisible).toBe(true);
  expect(s.goldVisible).toBe(true);
});

test('zoom buttons sit above the wave button without overlap', async ({ page }) => {
  await startGame(page, { seed: 'zoompos' });
  const s = await gameState(page);

  // zoom-out button centre is comfortably above the wave button centre
  expect(s.zoomOut.y).toBeLessThan(s.waveCY - 10);
  // zoom buttons hug the right edge
  expect(Math.abs(s.zoomOut.x - (s.scaleW - 32))).toBeLessThan(4);
});

// ─── Interactions ─────────────────────────────────────────────────────────

test('zoom in / zoom out buttons change the camera zoom', async ({ page }) => {
  await startGame(page, { seed: 'zoom' });
  let s = await gameState(page);
  const z0 = s.zoom;

  await page.mouse.click(s.zoomIn.x, s.zoomIn.y);
  await page.waitForTimeout(400);
  s = await gameState(page);
  expect(s.zoom).toBeCloseTo(Math.min(z0 + 0.5, 4), 3);

  await page.mouse.click(s.zoomOut.x, s.zoomOut.y);
  await page.waitForTimeout(400);
  s = await gameState(page);
  expect(s.zoom).toBeCloseTo(z0, 3);
});

test('places a tower by tapping a build button then a buildable tile', async ({ page }) => {
  await startGame(page, { seed: 'build' });
  const gold0 = (await gameState(page)).gold;

  const btn = await findVisibleBuildButton(page);
  expect(btn).not.toBeNull();
  await page.mouse.click(btn!.x, btn!.y);
  await page.waitForTimeout(400);
  expect((await gameState(page)).placingTower).not.toBeNull();

  const tile = await findVisibleBuildable(page);
  expect(tile).not.toBeNull();
  await page.mouse.click(tile!.x, tile!.y);
  await page.waitForTimeout(500);

  const s = await gameState(page);
  expect(s.towerCount).toBeGreaterThan(0);
  expect(s.gold).toBeLessThan(gold0);
  expect(s.placingTower).toBeNull(); // single-tap placement consumed
});

test('selects and casts an ability', async ({ page }) => {
  await startGame(page, { seed: 'ability' });
  let s = await gameState(page);
  const gold0 = s.gold;

  // Ensure a clean ability state, then tap the first ability button
  await page.evaluate(() => {
    const g = (window as any).__game;
    const gs = g.scene.getScenes().find((x: any) => x.scene.key === 'GameScene');
    gs.abilitySystem.pendingCast = null;
  });
  await page.mouse.click(s.abilityPos0.x, s.abilityPos0.y);
  await page.waitForTimeout(300);
  expect((await gameState(page)).pendingCast).toBe('freeze');

  // Tap a map tile to cast
  const tile = await findVisibleBuildable(page);
  expect(tile).not.toBeNull();
  await page.mouse.click(tile!.x, tile!.y);
  await page.waitForTimeout(500);

  s = await gameState(page);
  expect(s.pendingCast).toBeNull();
  expect(s.gold).toBeLessThan(gold0); // ability cost spent

  const cd = await page.evaluate(() => {
    const g = (window as any).__game;
    const gs = g.scene.getScenes().find((x: any) => x.scene.key === 'GameScene');
    return gs.abilitySystem.getCooldown('freeze').remaining;
  });
  expect(cd).toBeGreaterThan(0);
});

test('drag-scrolls the bottom bar without placing anything', async ({ page }) => {
  await startGame(page, { seed: 'drag' });
  let s = await gameState(page);

  expect(s.arrows).toBeGreaterThan(0); // content overflows → scrollable
  const offset0 = s.scrollOffset;
  const towers0 = s.towerCount;

  const y = Math.round(s.scaleH - s.barH + s.barH / 2);
  await page.mouse.move(300, y);
  await page.mouse.down();
  await page.mouse.move(100, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  s = await gameState(page);
  expect(s.scrollOffset).not.toBe(offset0);
  expect(s.towerCount).toBe(towers0);
});

test('settings modal opens and closes', async ({ page }) => {
  await startGame(page, { seed: 'settings' });
  const s = await gameState(page);

  const isOpen = () => page.evaluate(() =>
    (window as any).__game.scene.getScenes().find((x: any) => x.scene.key === 'GameScene').hud.isSettingsOpen);

  await page.mouse.click(s.settingsHit.x, s.settingsHit.y);
  await page.waitForTimeout(400);
  expect(await isOpen()).toBe(true);

  // Tap the backdrop (corner, outside the centred panel)
  await page.mouse.click(8, 8);
  await page.waitForTimeout(400);
  expect(await isOpen()).toBe(false);
});

test('auto-pauses when the page is hidden', async ({ page }) => {
  await startGame(page, { seed: 'pause' });
  expect((await gameState(page)).isPaused).toBe(false);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);

  expect((await gameState(page)).isPaused).toBe(true);
});
