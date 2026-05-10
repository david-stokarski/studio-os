"use client";

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
