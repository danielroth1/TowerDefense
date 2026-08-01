import { test, expect } from '@playwright/test';
import { startGame, waitForScene, gameState } from './helpers';

test('no AudioContext warning on page load', async ({ page }) => {
  const audioWarnings: string[] = [];
  page.on('console', (msg) => {
    if (/AudioContext|prevented from starting/.test(msg.text())) {
      audioWarnings.push(msg.text());
    }
  });

  await page.goto('/');
  await waitForScene(page, 'MenuScene');
  await page.waitForTimeout(1000);

  // The context must NOT be created eagerly outside a user gesture.
  expect(audioWarnings).toEqual([]);
});

test('AudioContext is created and running after the PLAY gesture', async ({ page }) => {
  await startGame(page, { seed: 'audio' });
  const s = await gameState(page);

  expect(s.ctxState).toBe('running');
  expect(s.musicEnabled).toBe(true);
});

test('debug mode keeps BGM off', async ({ page }) => {
  await startGame(page, { seed: 'audio-debug', debug: true });
  const s = await gameState(page);

  expect(s.ctxState).toBe('running');
  expect(s.musicEnabled).toBe(false);
});
