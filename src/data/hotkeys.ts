import rawConfig from './hotkeys.json';

export interface HotkeyConfig {
  tower: Record<string, string>;
  economy: Record<string, string>;
  actions: Record<string, string>;
}

export const HOTKEYS: HotkeyConfig = rawConfig as HotkeyConfig;
