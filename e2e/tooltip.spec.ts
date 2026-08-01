import { test, expect } from '@playwright/test';
import { startGame, findVisibleBuildButton } from './helpers';

test('hovering a build button shows a compact info tooltip', async ({ page }) => {
  await startGame(page, { seed: 'tooltip-build' });

  const btn = await findVisibleBuildButton(page);
  expect(btn).not.toBeNull();
  await page.mouse.move(btn!.x, btn!.y);
  await page.waitForTimeout(400);

  const tt = await page.evaluate(() => {
    const gs = (window as any).__game.scene.getScenes().find((s: any) => s.scene.key === 'GameScene');
    const t = gs.tooltip;
    return t.isVisible ? { title: t.title.text, body: t.body.text } : null;
  });
  expect(tt).not.toBeNull();
  expect(tt!.title.length).toBeGreaterThan(0);
  expect(tt!.body).toContain('💰'); // cost line present

  // Moving away hides the tooltip
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => {
    const gs = (window as any).__game.scene.getScenes().find((s: any) => s.scene.key === 'GameScene');
    return gs.tooltip.isVisible;
  });
  expect(hidden).toBe(false);
});

test('hovering an ability button shows its info tooltip', async ({ page }) => {
  await startGame(page, { seed: 'tooltip-ability' });

  const ab = await page.evaluate(() => {
    const gs = (window as any).__game.scene.getScenes().find((s: any) => s.scene.key === 'GameScene');
    const p = gs.abilityPos(0);
    return { x: Math.round(p.cx), y: Math.round(p.cy) };
  });
  await page.mouse.move(ab.x, ab.y);
  await page.waitForTimeout(400);

  const tt = await page.evaluate(() => {
    const gs = (window as any).__game.scene.getScenes().find((s: any) => s.scene.key === 'GameScene');
    const t = gs.tooltip;
    return t.isVisible ? { title: t.title.text, body: t.body.text } : null;
  });
  expect(tt).not.toBeNull();
  expect(tt!.title).toBe('Blizzard');
  expect(tt!.body).toContain('💰');
});
