// Theme registry. Each theme is a coherent visual identity — colors, radius,
// and typography combine to evoke a specific kind of audio tool. We expose the
// theme via a `data-theme` attribute on <html>; globals.css contains the
// matching CSS-variable overrides under `[data-theme="..."]`. Tailwind's
// `dark:` variants are unused — we drive everything through these vars so a
// "light" theme isn't tied to the `dark` class machinery.

export type ThemeId =
  | "dark-minimal"
  | "light-minimal"
  | "industrial"
  | "console";

export type ThemeMode = "dark" | "light";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  mode: ThemeMode;
  description: string;
  // 4-color swatch shown in the picker tile: [bg, surface, accent, text].
  // Values are CSS color strings; we keep them inline (rather than reading
  // from the theme's vars at render time) so the picker renders identically
  // regardless of which theme is active.
  swatch: [string, string, string, string];
}

export const THEMES: ThemeMeta[] = [
  {
    id: "dark-minimal",
    label: "Dark Minimal",
    mode: "dark",
    description:
      "Quiet, low-contrast, modern. The default — gets out of your way and lets the audio do the work.",
    swatch: ["#0a0a0c", "#17171a", "#fafafa", "#a1a1aa"],
  },
  {
    id: "light-minimal",
    label: "Light Minimal",
    mode: "light",
    description:
      "The same minimal philosophy, but bright. Clean white surfaces, hairline borders, restrained typography.",
    swatch: ["#ffffff", "#f4f4f5", "#18181b", "#71717a"],
  },
  {
    id: "industrial",
    label: "Industrial",
    mode: "dark",
    description:
      "Heavy and mechanical. Sharp corners, prominent borders, amber LED accent — the feel of a 19-inch rack.",
    swatch: ["#111210", "#1d1f1c", "#ff9d2a", "#c9c7bf"],
  },
  {
    id: "console",
    label: "Console",
    mode: "dark",
    description:
      "A vintage Neve-style mixing console. Marinair grey panels, cream marshmallow knobs with red indicator lines, real screws.",
    swatch: ["#1a1d1f", "#566164", "#b71d22", "#ecdfb1"],
  },
];

export const DEFAULT_THEME: ThemeId = "dark-minimal";

const ALL_IDS = new Set(THEMES.map((t) => t.id));

export function isThemeId(s: string | null | undefined): s is ThemeId {
  return !!s && ALL_IDS.has(s as ThemeId);
}

export function getThemeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export const THEME_STORAGE_KEY = "studio.theme";

// Inline script that runs before React hydrates so we can paint with the
// user's saved theme on first frame instead of flashing the default. Kept as
// a string so it can be embedded via `dangerouslySetInnerHTML` in layout.tsx.
export const THEME_BOOTSTRAP_SCRIPT = `
(function () {
  try {
    var t = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var allowed = ${JSON.stringify([...ALL_IDS])};
    if (!t || allowed.indexOf(t) === -1) t = ${JSON.stringify(DEFAULT_THEME)};
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", ${JSON.stringify(DEFAULT_THEME)});
  }
})();
`.trim();
