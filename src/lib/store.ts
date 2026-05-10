import { create } from "zustand";
import type { Track, Bus, PluginDescriptor } from "./types";
import { MAX_PLUGINS_PER_TRACK, MAX_PLUGINS_PER_BUS } from "./types";

export interface TrackMeter { id: string; in: number; outL: number; outR: number; monitoring: boolean }
export interface BusMeter   { id: string; inL: number; inR: number; outL: number; outR: number }

export interface HistorySnapshot {
  tracks: Track[];
  buses: Bus[];
}

const HISTORY_LIMIT = 50;

// Deep-clone the slot of a snapshot so future mutations to track.plugins
// don't bleed into the captured history entry.
function cloneSnapshot(tracks: Track[], buses: Bus[]): HistorySnapshot {
  return {
    tracks: tracks.map((t) => ({ ...t, plugins: t.plugins.map((p) => (p ? { ...p } : null)) })),
    buses:  buses.map((b)  => ({ ...b, plugins: b.plugins.map((p) => (p ? { ...p } : null)) })),
  };
}

function snapshotsEqual(a: HistorySnapshot, b: HistorySnapshot): boolean {
  // JSON compare is fine here — the snapshot is small + already plain data.
  return JSON.stringify(a) === JSON.stringify(b);
}

interface AppState {
  ready: boolean;
  setReady: (b: boolean) => void;

  inputs: string[];
  outputs: string[];
  currentInput: string;
  currentOutput: string;
  sampleRate: number;
  bufferSize: number;
  numActiveInputs: number;
  numActiveOutputs: number;

  setDeviceInfo: (i: Partial<Pick<AppState,
    "inputs" | "outputs" | "currentInput" | "currentOutput" | "sampleRate" | "bufferSize" | "numActiveInputs" | "numActiveOutputs">>) => void;

  tracks: Track[];
  setTracks: (t: Track[]) => void;
  addTrack: (t: Track) => void;
  removeTrack: (id: string) => void;
  patchTrack: (id: string, patch: Partial<Track>) => void;
  // Reorder source track to be immediately before/after target. Audio is
  // unaffected (the engine processes tracks independently); this is purely UI.
  moveTrack: (sourceId: string, targetId: string, position: "before" | "after") => void;

  buses: Bus[];
  setBuses: (b: Bus[]) => void;
  addBus: (b: Bus) => void;
  removeBus: (id: string) => void;
  patchBus: (id: string, patch: Partial<Bus>) => void;

  meters: Record<string, TrackMeter>;
  setMeters: (m: TrackMeter[]) => void;

  busMeters: Record<string, BusMeter>;
  setBusMeters: (m: BusMeter[]) => void;

  // Track-reorder drag state. Pointer-events-driven: when the user presses on
  // a track strip's grip handle, we capture the pointer, set sourceId, then
  // update targetId/side as the pointer moves over other strips. On release
  // we use these to perform the reorder. Stored globally so every strip can
  // see the active drop target without prop-drilling.
  dragState: { sourceId: string | null; targetId: string | null; side: "before" | "after" };
  setDragState: (s: AppState["dragState"]) => void;

  plugins: PluginDescriptor[];
  setPlugins: (p: PluginDescriptor[]) => void;

  scan: { active: boolean; current: number; total: number; name: string };
  setScan: (s: AppState["scan"]) => void;

  presetLoading: { active: boolean; name: string; current: number; total: number };
  setPresetLoading: (s: AppState["presetLoading"]) => void;

  // True when the in-memory mixer state has unsaved differences from the
  // currently-loaded preset (or has any state when no preset is selected).
  // Mutations below auto-set this — except during a preset load, when the
  // store is intentionally being mutated to match the preset on disk.
  presetDirty: boolean;
  setPresetDirty: (b: boolean) => void;

  // Set immediately before issuing a loadPlugin/loadPluginOnBus IPC. If the
  // engine crashes before the call completes we use this to identify which
  // plugin to blame, blacklist it, and skip it on the post-restart replay.
  lastPluginAttempt: null | {
    kind: "track" | "bus";
    targetId: string;
    slot: number;
    pluginId: string;
    pluginName: string;
  };
  setLastPluginAttempt: (a: AppState["lastPluginAttempt"]) => void;

  // Plugins known to crash the engine, populated as we observe failures. The
  // replay path skips these; the picker hides them.
  blacklistedPlugins: string[];
  blacklistPlugin: (pluginId: string) => void;

  // True while the crash-recovery flow is in flight. We dim/disable some UI
  // and surface a message to the user.
  recovering: boolean;
  setRecovering: (b: boolean) => void;

  // Undo/redo history. Each entry is a snapshot of the structural mixer state
  // (tracks + buses with their plugin slots, gains, pans, routes, etc.). We
  // intentionally don't capture per-plugin parameter state — that lives in the
  // plugin editors and isn't undo-able through the mixer. Snapshots are pushed
  // by a debounced subscriber in Mixer; undo/redo apply them via a helper that
  // rebuilds the engine state.
  history: {
    past: HistorySnapshot[];
    future: HistorySnapshot[];
  };
  // True while an undo or redo is in flight, so the auto-snapshot subscriber
  // doesn't immediately re-commit the state we just rewrote.
  applyingHistory: boolean;
  setApplyingHistory: (b: boolean) => void;
  // Push the current tracks/buses onto the past stack and clear the redo stack.
  // No-op while loading a preset, recovering, or applying history.
  commitHistory: () => void;
  // Pop the most recent snapshot off `past` and return the *previous* one to
  // restore (current state goes onto `future`). Returns null when there's
  // nothing further to undo.
  undoHistory: () => HistorySnapshot | null;
  redoHistory: () => HistorySnapshot | null;
  // Reset history to a single starting snapshot (after preset load / new).
  resetHistory: () => void;
}

export const defaultTrack = (id: string, name: string, inputCh: number): Track => ({
  id,
  name,
  inputCh,
  outL: 0,
  outR: 1,
  gainDb: 0,
  pan: 0,
  mute: false,
  // Monitor is always on — the toggle was removed from the UI to keep tracks
  // simple. Without monitoring the audio thread skips the channel entirely.
  monitor: true,
  solo: false,
  plugins: Array.from({ length: MAX_PLUGINS_PER_TRACK }, () => null),
  busId: "",
});

export const defaultBus = (id: string, name: string): Bus => ({
  id,
  name,
  outL: 0,
  outR: 1,
  gainDb: 0,
  pan: 0,
  mute: false,
  plugins: Array.from({ length: MAX_PLUGINS_PER_BUS }, () => null),
});

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  setReady: (b) => set({ ready: b }),

  inputs: [],
  outputs: [],
  currentInput: "",
  currentOutput: "",
  sampleRate: 48000,
  bufferSize: 128,
  numActiveInputs: 0,
  numActiveOutputs: 0,

  setDeviceInfo: (i) => set((s) => ({ ...s, ...i })),

  tracks: [],
  setTracks: (t) => set({ tracks: t }),
  addTrack: (t) => set((s) => ({
    tracks: [...s.tracks, t],
    presetDirty: s.presetLoading.active ? s.presetDirty : true,
  })),
  removeTrack: (id) => set((s) => ({
    tracks: s.tracks.filter((t) => t.id !== id),
    presetDirty: s.presetLoading.active ? s.presetDirty : true,
  })),
  patchTrack: (id, patch) => set((s) => ({
    tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    presetDirty: s.presetLoading.active ? s.presetDirty : true,
  })),
  moveTrack: (sourceId, targetId, position) =>
    set((s) => {
      if (sourceId === targetId) return {};
      const arr = [...s.tracks];
      const fromIdx = arr.findIndex((t) => t.id === sourceId);
      if (fromIdx === -1) return {};
      const [moved] = arr.splice(fromIdx, 1);
      let toIdx = arr.findIndex((t) => t.id === targetId);
      if (toIdx === -1) return { tracks: arr };
      if (position === "after") toIdx += 1;
      arr.splice(toIdx, 0, moved);
      return { tracks: arr, presetDirty: s.presetLoading.active ? s.presetDirty : true };
    }),

  buses: [],
  setBuses: (b) => set({ buses: b }),
  addBus: (b) => set((s) => ({
    buses: [...s.buses, b],
    presetDirty: s.presetLoading.active ? s.presetDirty : true,
  })),
  removeBus: (id) =>
    set((s) => ({
      buses: s.buses.filter((b) => b.id !== id),
      // Reset any tracks that fed this bus back to master.
      tracks: s.tracks.map((t) => (t.busId === id ? { ...t, busId: "" } : t)),
      presetDirty: s.presetLoading.active ? s.presetDirty : true,
    })),
  patchBus: (id, patch) => set((s) => ({
    buses: s.buses.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    presetDirty: s.presetLoading.active ? s.presetDirty : true,
  })),

  meters: {},
  setMeters: (m) => set({ meters: Object.fromEntries(m.map((x) => [x.id, x])) }),

  busMeters: {},
  setBusMeters: (m) => set({ busMeters: Object.fromEntries(m.map((x) => [x.id, x])) }),

  dragState: { sourceId: null, targetId: null, side: "before" },
  setDragState: (s) => set({ dragState: s }),

  plugins: [],
  setPlugins: (p) => set({ plugins: p }),

  scan: { active: false, current: 0, total: 0, name: "" },
  setScan: (s) => set({ scan: s }),

  presetLoading: { active: false, name: "", current: 0, total: 0 },
  setPresetLoading: (s) => set({ presetLoading: s }),

  presetDirty: false,
  setPresetDirty: (b) => set({ presetDirty: b }),

  lastPluginAttempt: null,
  setLastPluginAttempt: (a) => set({ lastPluginAttempt: a }),

  blacklistedPlugins: [],
  blacklistPlugin: (pluginId) =>
    set((s) => (s.blacklistedPlugins.includes(pluginId)
      ? {}
      : { blacklistedPlugins: [...s.blacklistedPlugins, pluginId] })),

  recovering: false,
  setRecovering: (b) => set({ recovering: b }),

  history: { past: [], future: [] },
  applyingHistory: false,
  setApplyingHistory: (b) => set({ applyingHistory: b }),
  commitHistory: () =>
    set((s) => {
      if (s.applyingHistory || s.presetLoading.active || s.recovering) return {};
      const snap = cloneSnapshot(s.tracks, s.buses);
      const top = s.history.past[s.history.past.length - 1];
      if (top && snapshotsEqual(top, snap)) return {};
      const past = [...s.history.past, snap];
      // Bound the past so a long editing session doesn't grow without limit.
      while (past.length > HISTORY_LIMIT) past.shift();
      return { history: { past, future: [] } };
    }),
  undoHistory: () => {
    const s = get();
    // Need at least 2 entries — the top is "current state", the one below
    // is what we actually want to restore.
    if (s.history.past.length < 2) return null;
    const past = [...s.history.past];
    const current = past.pop()!;
    const previous = past[past.length - 1];
    set({
      history: { past, future: [current, ...s.history.future] },
      applyingHistory: true,
    });
    return previous;
  },
  redoHistory: () => {
    const s = get();
    if (s.history.future.length === 0) return null;
    const [next, ...future] = s.history.future;
    set({
      history: { past: [...s.history.past, next], future },
      applyingHistory: true,
    });
    return next;
  },
  resetHistory: () =>
    set((s) => ({
      history: { past: [cloneSnapshot(s.tracks, s.buses)], future: [] },
    })),
}));
