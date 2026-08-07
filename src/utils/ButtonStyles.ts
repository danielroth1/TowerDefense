import Phaser from 'phaser';

type ButtonTheme = 'tower' | 'wave' | 'ability' | 'upgrade' | 'badge' | 'settings';

export interface ElevatedButtonOpts {
  cx: number; cy: number; w: number; h: number;
  theme: ButtonTheme;
  /** Optional border/accent colour override */
  color?: number;
  hover?: boolean;
  active?: boolean;
  disabled?: boolean;
  radius?: number;
}

const THEME_FILL: Record<ButtonTheme, number> = {
  tower:    0x1e3a5f,
  wave:     0x0f2a1a,
  ability:  0x1a2a3a,
  upgrade:  0x1e3a5f,
  badge:    0x0d1117,
  settings: 0x1a2a3a,
};

const THEME_BORDER: Record<ButtonTheme, number> = {
  tower:    0x3a5a8f,
  wave:     0x44ff88,
  ability:  0x3a4a5a,
  upgrade:  0x3a5a8f,
  badge:    0xffffff,
  settings: 0x2a3a4a,
};

/** Draw an elevated button with shadow, gradient, and themed border. */
export function drawElevatedButton(
  g: Phaser.GameObjects.Graphics,
  opts: ElevatedButtonOpts,
): void {
  const {
    cx, cy, w, h, theme,
    color,
    hover = false,
    active = false,
    disabled = false,
    radius = 8,
  } = opts;
  const x = cx - w / 2;
  const y = cy - h / 2;

  g.clear();

  if (disabled) {
    g.fillStyle(0x1a1a1a, 0.7);
    g.fillRoundedRect(x, y, w, h, radius);
    g.lineStyle(1, 0x333333, 0.4);
    g.strokeRoundedRect(x, y, w, h, radius);
    return;
  }

  // Drop shadow
  g.fillStyle(0x000000, 0.35);
  g.fillRoundedRect(x + 2, y + 2, w, h, radius);

  // Base fill
  const base = THEME_FILL[theme];
  const fill = active ? shiftBrightness(base, 0.1)
    : hover ? shiftBrightness(base, 0.15)
    : base;
  g.fillStyle(fill, 1);
  g.fillRoundedRect(x, y, w, h, radius);

  // Subtle top highlight for 3-D feel
  if (!active && theme !== 'badge') {
    g.fillStyle(0xffffff, 0.05);
    g.fillRoundedRect(
      x + 1, y + 1, w - 2, Math.round(h * 0.4),
      { tl: radius, tr: radius, bl: 0, br: 0 },
    );
  }

  // Border
  const bColor = color ?? THEME_BORDER[theme];
  const bAlpha = theme === 'badge' ? 0.3 : active ? 1.0 : 0.7;
  const bWidth = active ? 2 : 1;
  g.lineStyle(bWidth, bColor, bAlpha);
  g.strokeRoundedRect(x, y, w, h, radius);
}

/** Draw a pill-shaped floating badge (semi-transparent dark bg + white border). */
export function drawPillBadge(
  g: Phaser.GameObjects.Graphics,
  cx: number, cy: number,
  w: number, h: number,
): void {
  const r = h / 2;
  g.clear();
  // Shadow
  g.fillStyle(0x000000, 0.4);
  g.fillRoundedRect(cx - w / 2 + 2, cy - h / 2 + 2, w, h, r);
  // Fill
  g.fillStyle(0x0d1117, 0.85);
  g.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, r);
  // Border
  g.lineStyle(1, 0xffffff, 0.3);
  g.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, r);
}

function shiftBrightness(hex: number, amount: number): number {
  const r = Math.min(255, ((hex >> 16) & 0xff) + Math.round(255 * amount));
  const g = Math.min(255, ((hex >> 8) & 0xff) + Math.round(255 * amount));
  const b = Math.min(255, (hex & 0xff) + Math.round(255 * amount));
  return (r << 16) | (g << 8) | b;
}
