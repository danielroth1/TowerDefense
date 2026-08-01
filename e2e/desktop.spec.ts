import { test, expect } from '@playwright/test';
import {
  startGame, gameState, collectErrors, filterBenign,
  findVisibleBuildable, findVisibleBuildButton,
} from './helpers';

test('desktop smoke: game starts cleanly with desktop UI', async ({ page }) => {
  const errors = collectErrors(page);
  await startGame(page, { seed: 'desktop-smoke' });
  const s = await gameState(page);

  expect(s).not.toBeNull();
  expect(filterBenign(errors)).toEqual([]);

  // Desktop conventions: hotkey hints shown, fullscreen badge visible
  expect(s.hotkeyVisible).toBe(true);
  expect(s.fullscreenVisible).toBe(true);
  expect(s.waveLabel).toContain('[');
  expect(s.pauseBtnText).toContain('[P]');
  expect(s.zoom).toBeGreaterThan(1.4); // classic ~1.75 initial zoom
});

test('desktop: tower placement works', async ({ page }) => {
  await startGame(page, { seed: 'desktop-build' });

  const btn = await findVisibleBuildButton(page);
  expect(btn).not.toBeNull();
  await page.mouse.click(btn!.x, btn!.y);
  await page.waitForTimeout(300);
  expect((await gameState(page)).placingTower).not.toBeNull();

  const tile = await findVisibleBuildable(page);
  expect(tile).not.toBeNull();
  await page.mouse.click(tile!.x, tile!.y);
  await page.waitForTimeout(500);

  expect((await gameState(page)).towerCount).toBeGreaterThan(0);
});

test('desktop: zoom buttons are not created', async ({ page }) => {
  await startGame(page, { seed: 'desktop-nobuttons' });
  const s = await gameState(page);

  expect(s.zoomIn).toBeNull();
  expect(s.zoomOut).toBeNull();
});
