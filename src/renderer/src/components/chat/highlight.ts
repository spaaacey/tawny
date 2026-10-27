import { useSyncExternalStore } from 'react';
import { colorizeLines } from '../editor/api';

// Syntax-highlighted lines per (path, text), filled in by Monaco's colorizer; subscribers re-render when one lands.
const colored = new Map<string, string[] | null>();
const colorListeners = new Set<() => void>();
let colorVer = 0;
const subscribeColor = (fn: () => void) => {
  colorListeners.add(fn);
  return () => colorListeners.delete(fn);
};
export function coloredLines(text: string, path: string) {
  const key = `${path}\0${text}`;
  if (!colored.has(key)) {
    colored.set(key, null);
    colorizeLines(text, path).then((lines: string[] | null) => {
      colored.set(key, lines);
      if (lines) {
        colorVer++;
        for (const fn of colorListeners) fn();
      }
    });
    if (colored.size > 200) colored.delete(colored.keys().next().value as string);
  }
  return colored.get(key) ?? null;
}

/** Re-renders the caller whenever a colorized result lands. */
export const useColorVersion = () => useSyncExternalStore(subscribeColor, () => colorVer);
