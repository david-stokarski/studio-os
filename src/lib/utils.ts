import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function dbToLinear(db: number) {
  return Math.pow(10, db / 20);
}

export function linearToDb(lin: number) {
  if (lin <= 0) return -Infinity;
  return 20 * Math.log10(lin);
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// --- Fader curve (logarithmic-ish) ---------------------------------------
// Vertical level fader uses a normalized position [0..1] and maps to dB via a
// piecewise curve:
//   pos 0..UNITY_POS  : MIN_DB → 0 dB, power curve with exponent < 1 so the
//                       slider has plenty of travel near 0 dB (less sensitive
//                       there) and quickly heads toward silence at the bottom.
//   pos UNITY_POS..1  : 0 → MAX_DB, linear.
// At pos=0 the fader is fully attenuated (-60 dB → silent in the engine).
export const FADER_MIN_DB    = -60;
export const FADER_MAX_DB    = 12;
export const FADER_UNITY_POS = 0.72;
const FADER_BELOW_UNITY_EXP  = 0.4; // < 1 → flat near unity, steep near silence

export function faderToDb(pos: number): number {
  if (pos <= 0) return FADER_MIN_DB;
  if (pos >= 1) return FADER_MAX_DB;
  if (pos >= FADER_UNITY_POS) {
    return ((pos - FADER_UNITY_POS) / (1 - FADER_UNITY_POS)) * FADER_MAX_DB;
  }
  const t = pos / FADER_UNITY_POS;
  return FADER_MIN_DB * (1 - Math.pow(t, FADER_BELOW_UNITY_EXP));
}

export function dbToFader(db: number): number {
  if (!isFinite(db) || db <= FADER_MIN_DB) return 0;
  if (db >= FADER_MAX_DB) return 1;
  if (db >= 0) {
    return FADER_UNITY_POS + (db / FADER_MAX_DB) * (1 - FADER_UNITY_POS);
  }
  // Invert dB = MIN_DB * (1 - t^p) → t = (1 - db/MIN_DB)^(1/p)
  const t = Math.pow(1 - db / FADER_MIN_DB, 1 / FADER_BELOW_UNITY_EXP);
  return t * FADER_UNITY_POS;
}
