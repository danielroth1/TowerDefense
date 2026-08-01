// ─── Device / touch detection + safe-area helpers ──────────────────────────
// Central place for mobile-UI decisions used across HUD, BottomBar and GameScene.

/** True when the primary input is a coarse (touch) pointer, e.g. phones/tablets. */
export function isTouch(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
  } catch (_e) { /* ignore */ }
  return navigator.maxTouchPoints > 0;
}

/** True on iOS (iPhone/iPad) — used to hide fullscreen, adjust gestures, etc. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
}

interface SafeAreaInsets { top: number; right: number; bottom: number; left: number; }

const ZERO: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let cached: SafeAreaInsets | null = null;

/**
 * Read CSS `env(safe-area-inset-*)` (notch / home indicator) in pixels.
 * Requires `viewport-fit=cover` in the viewport meta tag. Cached per session.
 */
export function getSafeAreaInsets(): SafeAreaInsets {
  if (cached) return cached;
  if (typeof document === 'undefined' || !document.body) return ZERO;

  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.top = '0';
  probe.style.left = '0';
  probe.style.width = '0';
  probe.style.height = '0';
  probe.style.pointerEvents = 'none';
  probe.style.visibility = 'hidden';
  probe.style.padding =
    'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const cs = window.getComputedStyle(probe);
  const parse = (v: string) => Math.max(0, parseFloat(v) || 0);
  cached = {
    top:    parse(cs.paddingTop),
    right:  parse(cs.paddingRight),
    bottom: parse(cs.paddingBottom),
    left:   parse(cs.paddingLeft),
  };
  document.body.removeChild(probe);
  return cached;
}
