/**
 * Theme: one store for the whole app. `light | dark | system`, persisted per browser and applied
 * to <html data-theme> at start-up — not only while the sidebar layout is mounted, so the flow
 * editor, the login page and the public form follow the user's choice too. `system` follows the
 * OS setting live. Toasts read the same store.
 */
import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
const KEY = 'fms-theme';

function read(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let mode: ThemeMode = read();
const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
media?.addEventListener('change', () => listeners.forEach((l) => l()));

export function applyTheme() {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
}

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable: still applies for this tab */
  }
  applyTheme();
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const snapshot = () => `${mode}|${media?.matches ? 'dark' : 'light'}`;

export function useTheme() {
  const [m, system] = useSyncExternalStore(subscribe, snapshot, snapshot).split('|') as [ThemeMode, 'dark' | 'light'];
  const isDark = m === 'system' ? system === 'dark' : m === 'dark';
  return { mode: m, isDark, setMode: setThemeMode, toggle: () => setThemeMode(isDark ? 'light' : 'dark') };
}
