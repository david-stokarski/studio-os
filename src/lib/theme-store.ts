"use client";

import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  DEFAULT_THEME,
  isThemeId,
  THEME_STORAGE_KEY,
  type ThemeId,
} from "./themes";

interface ThemeState {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
}

// Read the user's saved choice synchronously on store creation so the React
// tree's first render already matches what the bootstrap script painted on
// <html>. Falls back gracefully on SSR / no-window.
function readInitialTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // localStorage can throw in private modes or when disabled — ignore.
  }
  return DEFAULT_THEME;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readInitialTheme(),
  setTheme: (t) => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", t);
    }
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(THEME_STORAGE_KEY, t); } catch {}
    }
    set({ theme: t });
  },
}));

// Hydration-safe theme accessor.
//
// The static-export build inlines DEFAULT_THEME into the prerendered HTML
// because there's no localStorage at build time. On the client the store's
// initial value comes from localStorage, which can differ. Components that
// branch on the active theme (e.g. Knob, Fader) must therefore render the
// SSR-default first, then re-render with the real theme after hydration —
// otherwise React reports a hydration mismatch and we get a flash of broken
// markup.
export function useActiveTheme(): ThemeId {
  const theme = useThemeStore((s) => s.theme);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated ? theme : DEFAULT_THEME;
}
