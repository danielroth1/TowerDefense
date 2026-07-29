import rawConfig from './hotkeys.json';

export interface HotkeyConfig {
  tower: Record<string, string>;
  economy: Record<string, string>;
  actions: Record<string, string>;
}

export const HOTKEYS: HotkeyConfig = rawConfig as HotkeyConfig;

/** Build an ordered hotkey label array matching BUILD_ITEMS order in BottomBar. */
export function buildHotkeyLabels(
  towerTypes: readonly string[],
  ecoTypes: readonly string[],
): string[] {
  const labels: string[] = [];
  for (const t of towerTypes) {
    labels.push(HOTKEYS.tower[t] ?? '');
  }
  for (const e of ecoTypes) {
    labels.push(HOTKEYS.economy[e] ?? '');
  }
  return labels;
}

/** Build tower hotkey bindings array matching TOWER_TYPES_ORDERED. */
export function towerHotkeyBindings(towerTypes: readonly string[]): string[] {
  return towerTypes.map(t => HOTKEYS.tower[t] ?? '').filter(Boolean);
}

/** Build economy hotkey bindings array matching ECO_BUILDING_TYPES. */
export function economyHotkeyBindings(ecoTypes: readonly string[]): string[] {
  return ecoTypes.map(e => HOTKEYS.economy[e] ?? '').filter(Boolean);
}
