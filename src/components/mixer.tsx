"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore, defaultTrack, defaultBus } from "@/lib/store";
import * as engine from "@/lib/engine";
import { TrackStripView } from "@/components/track-strip";
import { BusStripView } from "@/components/bus-strip";
import { TrackStripSkeleton } from "@/components/track-strip-skeleton";
import { PluginPicker, type PickerTarget } from "@/components/plugin-picker";
import { PresetManager } from "@/components/preset-manager";
import { SettingsDialog } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { Plus, GitMerge } from "lucide-react";
import { MASTER_BUS_ID, MAX_PLUGINS_PER_BUS } from "@/lib/types";
import type { HistorySnapshot } from "@/lib/store";

function uid(prefix = "t") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function Mixer() {
  const {
    ready, setReady, tracks, addTrack, setMeters, setBusMeters, setDeviceInfo,
    setPlugins, scan, setScan, numActiveInputs, presetLoading,
    buses, addBus, moveTrack, setRoundTripLatencySamples,
  } = useAppStore();
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const recovering = useAppStore((s) => s.recovering);
  const sampleRate = useAppStore((s) => s.sampleRate);
  const bufferSize = useAppStore((s) => s.bufferSize);
  const inputLatencySamples = useAppStore((s) => s.inputLatencySamples);
  const outputLatencySamples = useAppStore((s) => s.outputLatencySamples);
  const roundTripLatencySamples = useAppStore((s) => s.roundTripLatencySamples);
  // The engine publishes the true round-trip sample count on every meter tick:
  // device input + worst-case plugin chain + device output. Falls back to a
  // buffer-period estimate only if the driver reports no device latency at all
  // (rare; happens with some bridge drivers).
  const latencyMs = sampleRate > 0
    ? (roundTripLatencySamples > 0
        ? roundTripLatencySamples / sampleRate * 1000
        : (2 * bufferSize / sampleRate) * 1000)
    : 0;
  const latencyMeasured = roundTripLatencySamples > 0;
  const pluginLatencySamples = Math.max(
    0,
    roundTripLatencySamples - inputLatencySamples - outputLatencySamples,
  );
  const initialized = useRef(false);
  const scanStarted = useRef(false);
  // Lets the crash handler `await` the next engine:ready event so it can
  // sequence the replay after the new child finishes booting.
  const readyResolverRef = useRef<null | (() => void)>(null);
  const recoveringRef = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const unlistens: Array<() => void> = [];

    (async () => {
      const unReady = await engine.onReady(async () => {
        setReady(true);
        // During crash recovery the replay path drives device + state itself,
        // so skip the boot-time bring-up to avoid races / double-application.
        if (recoveringRef.current) {
          // Wake any awaiter (the crash handler) so it can start the replay.
          const r = readyResolverRef.current;
          readyResolverRef.current = null;
          if (r) r();
          return;
        }
        await pullDeviceInfo();
        await applySavedPrefs();
        await ensureMasterBus();
        await loadOrScanPlugins();
      });
      unlistens.push(unReady);

      const unMeters = await engine.onMeters((m) => {
        setMeters(m.tracks);
        if (m.buses) setBusMeters(m.buses);
        if (typeof m.roundTripLatencySamples === "number") {
          setRoundTripLatencySamples(m.roundTripLatencySamples);
        }
        // Sample rate can drift via setDevice from elsewhere — keep it fresh.
        if (typeof m.sampleRate === "number" && m.sampleRate > 0) {
          setDeviceInfo({ sampleRate: m.sampleRate });
        }
      });
      unlistens.push(unMeters);

      const unLog = await engine.onLog((line) => console.log("[engine]", line));
      unlistens.push(unLog);

      const unScan = await engine.onScanProgress((p) => {
        setScan({ active: p.current < p.total, current: p.current, total: p.total, name: p.name });
      });
      unlistens.push(unScan);

      const unCrashed = await engine.onEngineCrashed(() => {
        void handleEngineCrash();
      });
      unlistens.push(unCrashed);

      try {
        await pullDeviceInfo();
        setReady(true);
        await applySavedPrefs();
        await ensureMasterBus();
        await loadOrScanPlugins();
      } catch (e) {
        console.warn("device info pull failed (engine still booting?):", e);
      }
    })();

    return () => { for (const u of unlistens) u(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- undo/redo: auto-snapshot subscriber ----------------
  // Watch tracks + buses and push a debounced snapshot into the history stack.
  // Continuous edits (slider/knob drags) coalesce into a single commit because
  // each tick resets the timer. Snapshots are skipped while loading a preset,
  // recovering from a crash, or applying an undo/redo to avoid feedback loops.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let prevTracks = useAppStore.getState().tracks;
    let prevBuses = useAppStore.getState().buses;

    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.tracks === prevTracks && state.buses === prevBuses) return;
      prevTracks = state.tracks;
      prevBuses = state.buses;
      if (state.applyingHistory || state.presetLoading.active || state.recovering) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        useAppStore.getState().commitHistory();
      }, 400);
    });

    // Seed the history with the initial state so the very first user action
    // has something to undo back to.
    useAppStore.getState().commitHistory();

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const loadOrScanPlugins = async () => {
    if (scanStarted.current) return;
    scanStarted.current = true;
    try {
      const cached = await engine.listPlugins();
      if (cached && cached.length > 0) {
        setPlugins(cached);
        setScan({ active: false, current: cached.length, total: cached.length, name: "" });
        return;
      }
    } catch (e) {
      console.warn("listPlugins failed, falling back to scan:", e);
    }
    setScan({ active: true, current: 0, total: 0, name: "" });
    try {
      const r = await engine.scanPlugins();
      setPlugins(r.plugins);
      setScan({ active: false, current: r.count, total: r.count, name: "" });
    } catch (e) {
      console.error("scan failed:", e);
      setScan({ active: false, current: 0, total: 0, name: "" });
    }
  };

  const rescanPlugins = async () => {
    scanStarted.current = true;
    setPlugins([]);
    setScan({ active: true, current: 0, total: 0, name: "" });
    try {
      const r = await engine.scanPlugins();
      setPlugins(r.plugins);
      setScan({ active: false, current: r.count, total: r.count, name: "" });
    } catch (e) {
      console.error("rescan failed:", e);
      setScan({ active: false, current: 0, total: 0, name: "" });
    }
  };

  const pullDeviceInfo = async () => {
    const info = await engine.listDevices();
    setDeviceInfo({
      inputs: info.inputs,
      outputs: info.outputs,
      currentInput: info.currentInput,
      currentOutput: info.currentOutput,
      sampleRate: info.sampleRate || 48000,
      bufferSize: info.bufferSize || 128,
      numActiveInputs: info.numActiveInputs,
      numActiveOutputs: info.numActiveOutputs,
      inputLatencySamples: info.inputLatencySamples ?? 0,
      outputLatencySamples: info.outputLatencySamples ?? 0,
    });
  };

  // On boot, apply the user's saved device prefs (if any). Picks the saved input
  // if it's still present in the system; otherwise falls back to whatever the
  // engine started with.
  const applySavedPrefs = async () => {
    try {
      const prefs = await engine.loadPrefs();
      if (!prefs || !prefs.input) return;
      const info = await engine.listDevices();
      const inputOk = info.inputs.includes(prefs.input);
      if (!inputOk) return;
      const output = prefs.output && info.outputs.includes(prefs.output) ? prefs.output : info.currentOutput || prefs.input;
      const r = await engine.setDevice(
        prefs.input, output,
        prefs.sampleRate || info.sampleRate || 48000,
        prefs.bufferSize || info.bufferSize || 128,
        32,
      );
      setDeviceInfo({
        currentInput: prefs.input, currentOutput: output,
        sampleRate: r.sampleRate, bufferSize: r.bufferSize,
        numActiveInputs: r.numActiveInputs, numActiveOutputs: r.numActiveOutputs,
        inputLatencySamples: r.inputLatencySamples ?? 0,
        outputLatencySamples: r.outputLatencySamples ?? 0,
      });
    } catch (e) {
      console.warn("applySavedPrefs failed:", e);
    }
  };

  // The engine auto-creates a master bus on startup. Mirror it in the store so
  // the UI can render it. addBus("master") is idempotent on the engine side, so
  // re-running this on every reconnect is safe.
  const ensureMasterBus = async () => {
    const existing = useAppStore.getState().buses.find((b) => b.id === MASTER_BUS_ID);
    if (existing) return;
    try { await engine.addBus(MASTER_BUS_ID, "Master", 0, 1); }
    catch (e) { console.warn("ensureMasterBus: engine addBus failed:", e); }
    addBus(defaultBus(MASTER_BUS_ID, "Master"));
    // The store mutation above flips presetDirty to true. Adding the implicit
    // master bus on boot isn't a user-initiated change, so reset the flag.
    useAppStore.getState().setPresetDirty(false);
    // Re-anchor undo history at the post-boot state so the user can't undo
    // back through "no master existed yet".
    useAppStore.getState().resetHistory();
  };

  // ---------------- crash recovery ----------------
  // When the engine subprocess dies (e.g. an AU plugin segfaults during
  // instantiation), Tauri emits `engine:crashed`. We:
  //   1. Identify the offending plugin via `lastPluginAttempt`, blacklist it,
  //      and remove it from the in-memory state so the replay won't re-add it.
  //   2. Tell Tauri to spawn a fresh engine subprocess.
  //   3. Wait for the new engine's ready event.
  //   4. Replay our in-memory state (device, buses, tracks, plugins) onto the
  //      fresh engine, skipping anything in the blacklist.
  // The user sees a single notification at the end summarizing what happened
  // instead of a generic "broken pipe" failure dialog.
  const handleEngineCrash = async () => {
    if (recoveringRef.current) return; // already recovering
    recoveringRef.current = true;
    const s = useAppStore.getState();
    s.setRecovering(true);
    setReady(false);

    const attempt = s.lastPluginAttempt;
    s.setLastPluginAttempt(null);

    let crashedName = "";
    if (attempt) {
      crashedName = attempt.pluginName;
      s.blacklistPlugin(attempt.pluginId);
      // Strip the plugin from the strip's slot so the replay won't reload it
      // and the UI doesn't show a phantom pill.
      if (attempt.kind === "track") {
        const t = useAppStore.getState().tracks.find((tt) => tt.id === attempt.targetId);
        if (t) {
          const next = [...t.plugins];
          if (next[attempt.slot]?.id === attempt.pluginId) next[attempt.slot] = null;
          s.patchTrack(attempt.targetId, { plugins: next });
        }
      } else {
        const b = useAppStore.getState().buses.find((bb) => bb.id === attempt.targetId);
        if (b) {
          const next = [...b.plugins];
          if (next[attempt.slot]?.id === attempt.pluginId) next[attempt.slot] = null;
          s.patchBus(attempt.targetId, { plugins: next });
        }
      }
    }

    // Set up a promise that resolves when the next ready event lands.
    const readyPromise = new Promise<void>((resolve) => {
      readyResolverRef.current = resolve;
    });

    try {
      await engine.restartEngine();
    } catch (e) {
      console.error("restartEngine failed:", e);
      s.setRecovering(false);
      recoveringRef.current = false;
      readyResolverRef.current = null;
      alert(`Audio engine crashed and the restart failed: ${e}\n\nPlease restart the app.`);
      return;
    }

    // Bound the wait — if the engine doesn't come up within 15s something's
    // very wrong and we'd rather surface an error than hang forever.
    await Promise.race([
      readyPromise,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("ready timeout")), 15_000)),
    ]).catch((err) => console.warn("engine:ready wait during recovery:", err));
    readyResolverRef.current = null;

    try {
      await replayEngineState();
    } catch (e) {
      console.error("replay failed:", e);
    }

    setReady(true);
    s.setRecovering(false);
    recoveringRef.current = false;

    if (crashedName) {
      alert(`The plugin "${crashedName}" caused the audio engine to crash. It has been disabled and the engine has been restored.`);
    } else {
      alert("The audio engine crashed and has been restarted.");
    }
  };

  // ---------------- undo / redo ----------------
  // Apply a snapshot by diffing it against the live store state and only
  // mutating what differs. No engine wipe, no preset-load UI — the user just
  // sees the most recent change reverse itself. Plugin instances are
  // preserved when their slot + id are unchanged, so undoing a fader move
  // doesn't reload any plugins.
  const diffPluginSlots = async (
    targetId: string,
    cur: Array<{ id: string; name: string; bypassed?: boolean; state?: string } | null>,
    tgt: Array<{ id: string; name: string; bypassed?: boolean; state?: string } | null>,
    api: {
      remove: (slot: number) => Promise<unknown>;
      load:   (slot: number, pluginId: string, state?: string) => Promise<unknown>;
      bypass: (slot: number, b: boolean) => Promise<unknown>;
    },
  ) => {
    const len = Math.max(cur.length, tgt.length);
    for (let i = 0; i < len; i++) {
      const a = cur[i] ?? null;
      const b = tgt[i] ?? null;
      if (!a && !b) continue;
      try {
        if (a && !b) {
          await api.remove(i);
        } else if (!a && b) {
          await api.load(i, b.id, b.state);
          if (b.bypassed) await api.bypass(i, true);
        } else if (a && b) {
          if (a.id !== b.id) {
            await api.remove(i);
            await api.load(i, b.id, b.state);
            if (b.bypassed) await api.bypass(i, true);
          } else if (!!a.bypassed !== !!b.bypassed) {
            await api.bypass(i, !!b.bypassed);
          }
        }
      } catch (err) {
        console.warn(`undo plugin slot ${i} on ${targetId} failed:`, err);
      }
    }
  };

  const applyHistorySnapshot = async (snap: HistorySnapshot) => {
    const s = useAppStore.getState();
    s.setApplyingHistory(true);
    try {
      // ---- buses ----
      const curBuses = s.buses;
      const tgtBusIds = new Set(snap.buses.map((b) => b.id));
      // Remove sub-buses that aren't in the target. Master is never removed.
      for (const cb of curBuses) {
        if (cb.id === MASTER_BUS_ID) continue;
        if (!tgtBusIds.has(cb.id)) {
          try { await engine.removeBus(cb.id); } catch (err) { console.warn(err); }
        }
      }
      const curBusMap = new Map(curBuses.map((b) => [b.id, b]));
      for (const tb of snap.buses) {
        const cb = curBusMap.get(tb.id);
        if (!cb) {
          // Add new bus.
          try {
            await engine.addBus(tb.id, tb.name, tb.outL, tb.outR);
            await engine.setBusGain(tb.id, tb.gainDb);
            await engine.setBusPan(tb.id, tb.pan);
            await engine.setBusMute(tb.id, tb.mute);
            if (tb.dest && tb.dest !== "bus") await engine.setBusDest(tb.id, tb.dest);
            if (tb.outputMode && tb.outputMode !== "stereo") await engine.setBusOutputMode(tb.id, tb.outputMode);
            for (let i = 0; i < tb.plugins.length; i++) {
              const sl = tb.plugins[i];
              if (!sl) continue;
              await engine.loadPluginOnBus(tb.id, i, sl.id, sl.state);
              if (sl.bypassed) await engine.setBusPluginBypassed(tb.id, i, true);
            }
          } catch (err) { console.warn(`undo addBus ${tb.name} failed:`, err); }
          continue;
        }
        // Update existing bus's params if they differ.
        try {
          if (cb.gainDb !== tb.gainDb) await engine.setBusGain(tb.id, tb.gainDb);
          if (cb.pan !== tb.pan)       await engine.setBusPan(tb.id, tb.pan);
          if (cb.mute !== tb.mute)     await engine.setBusMute(tb.id, tb.mute);
          if (cb.outL !== tb.outL || cb.outR !== tb.outR) {
            await engine.setBusOutput(tb.id, tb.outL, tb.outR);
          }
          if ((cb.dest ?? "bus") !== (tb.dest ?? "bus")) {
            await engine.setBusDest(tb.id, tb.dest ?? "bus");
          }
          if ((cb.outputMode ?? "stereo") !== (tb.outputMode ?? "stereo")) {
            await engine.setBusOutputMode(tb.id, tb.outputMode ?? "stereo");
          }
          await diffPluginSlots(tb.id, cb.plugins, tb.plugins, {
            remove: (slot) => engine.removePluginOnBus(tb.id, slot),
            load:   (slot, pid, state) => engine.loadPluginOnBus(tb.id, slot, pid, state),
            bypass: (slot, byp) => engine.setBusPluginBypassed(tb.id, slot, byp),
          });
        } catch (err) { console.warn(`undo update bus ${tb.name} failed:`, err); }
      }

      // ---- tracks ----
      const curTracks = s.tracks;
      const tgtTrackIds = new Set(snap.tracks.map((t) => t.id));
      for (const ct of curTracks) {
        if (!tgtTrackIds.has(ct.id)) {
          try { await engine.removeTrack(ct.id); } catch (err) { console.warn(err); }
        }
      }
      const curTrackMap = new Map(curTracks.map((t) => [t.id, t]));
      for (const tt of snap.tracks) {
        const ct = curTrackMap.get(tt.id);
        if (!ct) {
          try {
            await engine.addTrack(tt.id, tt.name, tt.inputCh, tt.outL, tt.outR);
            if (tt.busId) await engine.setTrackBus(tt.id, tt.busId);
            if (tt.dest && tt.dest !== "bus") await engine.setTrackDest(tt.id, tt.dest);
            if (tt.inputMode  && tt.inputMode  !== "mono")   await engine.setTrackInputMode(tt.id,  tt.inputMode);
            if (tt.outputMode && tt.outputMode !== "stereo") await engine.setTrackOutputMode(tt.id, tt.outputMode);
            await engine.setTrackGain(tt.id, tt.gainDb);
            await engine.setTrackPan(tt.id, tt.pan);
            await engine.setTrackMute(tt.id, tt.mute);
            await engine.setTrackMonitor(tt.id, true);
            if (tt.solo) await engine.setTrackSolo(tt.id, true);
            for (let i = 0; i < tt.plugins.length; i++) {
              const sl = tt.plugins[i];
              if (!sl) continue;
              await engine.loadPlugin(tt.id, i, sl.id, sl.state);
              if (sl.bypassed) await engine.setPluginBypassed(tt.id, i, true);
            }
          } catch (err) { console.warn(`undo addTrack ${tt.name} failed:`, err); }
          continue;
        }
        try {
          if (ct.gainDb !== tt.gainDb)             await engine.setTrackGain(tt.id, tt.gainDb);
          if (ct.pan !== tt.pan)                   await engine.setTrackPan(tt.id, tt.pan);
          if (ct.mute !== tt.mute)                 await engine.setTrackMute(tt.id, tt.mute);
          if (ct.solo !== tt.solo)                 await engine.setTrackSolo(tt.id, tt.solo);
          if (ct.inputCh !== tt.inputCh)           await engine.setTrackInput(tt.id, tt.inputCh);
          if ((ct.busId || "") !== (tt.busId || "")) await engine.setTrackBus(tt.id, tt.busId || "");
          if (ct.outL !== tt.outL || ct.outR !== tt.outR) await engine.setTrackOutput(tt.id, tt.outL, tt.outR);
          if ((ct.dest ?? "bus") !== (tt.dest ?? "bus")) await engine.setTrackDest(tt.id, tt.dest ?? "bus");
          if ((ct.inputMode  ?? "mono")   !== (tt.inputMode  ?? "mono"))   await engine.setTrackInputMode(tt.id,  tt.inputMode  ?? "mono");
          if ((ct.outputMode ?? "stereo") !== (tt.outputMode ?? "stereo")) await engine.setTrackOutputMode(tt.id, tt.outputMode ?? "stereo");
          await diffPluginSlots(tt.id, ct.plugins, tt.plugins, {
            remove: (slot) => engine.removePlugin(tt.id, slot),
            load:   (slot, pid, state) => engine.loadPlugin(tt.id, slot, pid, state),
            bypass: (slot, byp) => engine.setPluginBypassed(tt.id, slot, byp),
          });
        } catch (err) { console.warn(`undo update track ${tt.name} failed:`, err); }
      }

      // Commit the snapshot to the store. Using setTracks/setBuses (the bulk
      // setters) keeps the dirty-mutation flag quiet — they don't auto-mark.
      s.setBuses(snap.buses);
      s.setTracks(snap.tracks);
    } finally {
      s.setApplyingHistory(false);
    }
  };

  const handleUndo = () => {
    const snap = useAppStore.getState().undoHistory();
    if (snap) void applyHistorySnapshot(snap);
  };
  const handleRedo = () => {
    const snap = useAppStore.getState().redoHistory();
    if (snap) void applyHistorySnapshot(snap);
  };

  // ---------------- new preset ----------------
  // Reuse the engine-restart machinery instead of tearing the engine down
  // in-process. Iterating removeTrack / removePluginOnBus / removeBus across
  // a workspace that may contain a misbehaving plugin (whose destructor
  // segfaults) was the failure mode that crashed the UI; spawning a fresh
  // child process side-steps it entirely.
  const handleNewPreset = async () => {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    const s = useAppStore.getState();
    s.setRecovering(true);
    setReady(false);
    s.setLastPluginAttempt(null);

    const readyPromise = new Promise<void>((resolve) => {
      readyResolverRef.current = resolve;
    });

    try {
      await engine.restartEngine();
    } catch (err) {
      console.error("restart for new preset failed:", err);
      s.setRecovering(false);
      recoveringRef.current = false;
      readyResolverRef.current = null;
      alert(`Failed to start a new preset: ${err}`);
      return;
    }

    await Promise.race([
      readyPromise,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("ready timeout")), 15_000)),
    ]).catch((err) => console.warn("new preset ready wait:", err));
    readyResolverRef.current = null;

    // The new engine boots with master only and no device. Mirror that in
    // the store and re-apply the user's device so audio keeps flowing.
    s.setApplyingHistory(true);
    try {
      s.setTracks([]);
      s.setBuses([defaultBus(MASTER_BUS_ID, "Master")]);
      if (s.currentInput) {
        try {
          const r = await engine.setDevice(
            s.currentInput, s.currentOutput || s.currentInput,
            s.sampleRate, s.bufferSize, 0,
          );
          s.setDeviceInfo({
            currentInput: s.currentInput, currentOutput: s.currentOutput || s.currentInput,
            sampleRate: r.sampleRate, bufferSize: r.bufferSize,
            numActiveInputs: r.numActiveInputs, numActiveOutputs: r.numActiveOutputs,
            inputLatencySamples: r.inputLatencySamples ?? 0,
            outputLatencySamples: r.outputLatencySamples ?? 0,
          });
        } catch (err) { console.warn("new preset setDevice failed:", err); }
      }
      s.setPresetDirty(false);
      s.resetHistory();
    } finally {
      s.setApplyingHistory(false);
    }

    setReady(true);
    s.setRecovering(false);
    recoveringRef.current = false;
  };

  // Push the current in-memory mixer state back onto the (freshly spawned)
  // engine. We mark this as a preset load so the store's dirty-tracking
  // mutations stay quiet during the replay.
  const replayEngineState = async () => {
    const s = useAppStore.getState();
    const blacklist = new Set(s.blacklistedPlugins);
    s.setPresetLoading({ active: true, name: "(restoring)", current: 0, total: 1 });
    try {
      // Device first — ensures sample rate / buffer size are restored before
      // anything tries to use them.
      if (s.currentInput) {
        try {
          const r = await engine.setDevice(
            s.currentInput, s.currentOutput || s.currentInput,
            s.sampleRate, s.bufferSize, 0,
          );
          s.setDeviceInfo({
            currentInput: s.currentInput, currentOutput: s.currentOutput || s.currentInput,
            sampleRate: r.sampleRate, bufferSize: r.bufferSize,
            numActiveInputs: r.numActiveInputs, numActiveOutputs: r.numActiveOutputs,
            inputLatencySamples: r.inputLatencySamples ?? 0,
            outputLatencySamples: r.outputLatencySamples ?? 0,
          });
        } catch (e) { console.warn("replay setDevice failed:", e); }
      }

      // Buses (master is implicitly created by the engine; addBus is idempotent for it).
      for (const b of s.buses) {
        try {
          await engine.addBus(b.id, b.name, b.outL, b.outR);
          await engine.setBusGain(b.id, b.gainDb);
          await engine.setBusPan(b.id, b.pan);
          await engine.setBusMute(b.id, b.mute);
          // Always restore the output pair — sub-buses may now use it for direct routing.
          await engine.setBusOutput(b.id, b.outL, b.outR);
          if (b.id !== MASTER_BUS_ID && b.dest && b.dest !== "bus") {
            await engine.setBusDest(b.id, b.dest);
          }
          if (b.outputMode && b.outputMode !== "stereo") {
            await engine.setBusOutputMode(b.id, b.outputMode);
          }
          for (let slotIdx = 0; slotIdx < b.plugins.length; slotIdx++) {
            const slot = b.plugins[slotIdx];
            if (!slot) continue;
            if (blacklist.has(slot.id)) {
              const next = [...b.plugins]; next[slotIdx] = null;
              s.patchBus(b.id, { plugins: next });
              continue;
            }
            try {
              await engine.loadPluginOnBus(b.id, slotIdx, slot.id, slot.state);
              if (slot.bypassed) await engine.setBusPluginBypassed(b.id, slotIdx, true);
            } catch (e) { console.warn(`replay bus plugin failed:`, e); }
          }
        } catch (e) { console.warn(`replay bus ${b.name} failed:`, e); }
      }

      // Tracks.
      for (const t of s.tracks) {
        try {
          await engine.addTrack(t.id, t.name, t.inputCh, t.outL, t.outR);
          if (t.busId) await engine.setTrackBus(t.id, t.busId);
          if (t.dest && t.dest !== "bus") await engine.setTrackDest(t.id, t.dest);
          if (t.inputMode  && t.inputMode  !== "mono")   await engine.setTrackInputMode(t.id,  t.inputMode);
          if (t.outputMode && t.outputMode !== "stereo") await engine.setTrackOutputMode(t.id, t.outputMode);
          await engine.setTrackGain(t.id, t.gainDb);
          await engine.setTrackPan(t.id, t.pan);
          await engine.setTrackMute(t.id, t.mute);
          await engine.setTrackMonitor(t.id, true);
          if (t.solo) await engine.setTrackSolo(t.id, true);
          for (let slotIdx = 0; slotIdx < t.plugins.length; slotIdx++) {
            const slot = t.plugins[slotIdx];
            if (!slot) continue;
            if (blacklist.has(slot.id)) {
              const next = [...t.plugins]; next[slotIdx] = null;
              s.patchTrack(t.id, { plugins: next });
              continue;
            }
            try {
              await engine.loadPlugin(t.id, slotIdx, slot.id, slot.state);
              if (slot.bypassed) await engine.setPluginBypassed(t.id, slotIdx, true);
            } catch (e) { console.warn(`replay track plugin failed:`, e); }
          }
        } catch (e) { console.warn(`replay track ${t.name} failed:`, e); }
      }
    } finally {
      s.setPresetLoading({ active: false, name: "", current: 0, total: 0 });
    }
  };

  const onAddTrack = async () => {
    const id = uid("t");
    const inputCh = Math.min(0, Math.max(0, numActiveInputs - 1));
    const t = defaultTrack(id, `Track ${tracks.length + 1}`, inputCh);
    try {
      await engine.addTrack(t.id, t.name, t.inputCh, t.outL, t.outR);
      // Monitoring is implicitly always-on (the toggle was removed from the UI);
      // tell the engine explicitly so the audio thread starts streaming this track.
      await engine.setTrackMonitor(t.id, true);
      addTrack(t);
    } catch (e) {
      alert(`Failed to add track: ${e}`);
    }
  };

  const onAddBus = async () => {
    const id = uid("bus");
    const b = defaultBus(id, `Bus ${buses.length + 1}`);
    try {
      await engine.addBus(b.id, b.name, b.outL, b.outR);
      addBus(b);
    } catch (e) {
      alert(`Failed to add bus: ${e}`);
    }
  };

  return (
    <div className="flex h-screen flex-col gap-3 p-3">
      {/* 3-column header. Grid keeps the preset manager visually centered
          regardless of how wide the left/right clusters are; the gutters use
          min-w-0 so a long scan filename (rendered on the right cluster) can
          truncate instead of pushing the center off-axis. items-end keeps
          all three clusters flat along the bottom — the preset manager's
          two rows extend upward instead of pushing siblings down. */}
      <header className="grid grid-cols-3 items-end gap-3">
        {/* Left: structural add buttons */}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onAddTrack} disabled={!ready || numActiveInputs === 0}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add Track
          </Button>
          <Button size="sm" variant="outline" onClick={onAddBus} disabled={!ready}>
            <GitMerge className="mr-1 h-3.5 w-3.5" /> Add Bus
          </Button>
        </div>

        {/* Center: preset management */}
        <div className="flex justify-center">
          <PresetManager onUndo={handleUndo} onRedo={handleRedo} onNew={handleNewPreset} />
        </div>

        {/* Right: scan / recovery / status / settings */}
        <div className="flex min-w-0 items-center justify-end gap-2">
          {scan.active && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="whitespace-nowrap">
                Scanning {scan.total > 0 ? `${scan.current} / ${scan.total}` : "…"}
              </span>
              <span className="min-w-0 truncate font-mono">{scan.name}</span>
              <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded bg-secondary">
                <div
                  className="h-full bg-primary transition-[width] duration-100"
                  style={{ width: `${scan.total > 0 ? (scan.current / scan.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
          {recovering && (
            <div className="flex shrink-0 items-center gap-2 rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-500">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              Restoring engine…
            </div>
          )}
          <div className={`shrink-0 whitespace-nowrap text-xs ${recovering ? "text-amber-500" : ready ? "text-emerald-500" : "text-amber-500"}`}>
            {recovering ? "○ Recovering…" : ready ? "● Ready" : "○ Booting…"}
          </div>
          <div
            className="shrink-0 whitespace-nowrap rounded border border-border bg-secondary/40 px-2 py-1 font-mono text-xs text-muted-foreground"
            title={
              latencyMeasured
                ? `Round-trip: ${inputLatencySamples} in + ${pluginLatencySamples} plugins + ${outputLatencySamples} out samples @ ${sampleRate} Hz`
                : `Estimate (device didn't report latency): 2 × ${bufferSize} samples / ${sampleRate} Hz`
            }
          >
            {ready ? `${latencyMs.toFixed(1)} ms${latencyMeasured ? "" : "*"}` : "— ms"}
          </div>
          <SettingsDialog
            scanActive={scan.active}
            scanCurrent={scan.current}
            scanTotal={scan.total}
            scanName={scan.name}
            onRescan={rescanPlugins}
          />
        </div>
      </header>

      {presetLoading.active ? (
        // Outer flex column owns the full height; the skeleton row inside
        // takes flex-1 so each TrackStripSkeleton (which is h-full) extends
        // all the way to the bottom of the window.
        <div className="relative flex flex-1 min-h-0 flex-col gap-2 overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span>Loading preset “{presetLoading.name}”…</span>
            {presetLoading.total > 0 && (
              <div className="h-1.5 w-32 overflow-hidden rounded bg-secondary">
                <div
                  className="h-full bg-primary transition-[width] duration-150"
                  style={{ width: `${(presetLoading.current / presetLoading.total) * 100}%` }}
                />
              </div>
            )}
          </div>
          <div className="flex flex-1 min-h-0 gap-2 overflow-x-auto">
            {Array.from({ length: Math.max(presetLoading.total - 1, 1) }).map((_, i) => (
              <TrackStripSkeleton key={i} />
            ))}
          </div>
        </div>
      ) : (() => {
        // Master is pinned to the right and never scrolls. Tracks + sub-buses
        // share a horizontally-scrollable area so the user can scroll past
        // the visible viewport without losing sight of the master fader.
        const masterBus = buses.find((b) => b.id === MASTER_BUS_ID);
        const subBuses  = buses.filter((b) => b.id !== MASTER_BUS_ID);
        const isEmpty = tracks.length === 0 && subBuses.length === 0;

        return (
          <div className="relative flex flex-1 min-h-0 gap-2">
            <div className="relative flex-1 min-w-0 overflow-x-auto">
              {isEmpty ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {numActiveInputs === 0
                    ? "Select an input device, then add tracks."
                    : "Click + Add Track to create your first track."}
                </div>
              ) : (
                <div className="flex h-full gap-2">
                  {tracks.map((t) => (
                    <TrackStripView
                      key={t.id}
                      track={t}
                      onReorder={moveTrack}
                      onPickPlugin={(trackId, slot) => setPickerTarget({ kind: "track", trackId, slot })}
                    />
                  ))}
                  {subBuses.length > 0 && tracks.length > 0 && (
                    <div className="my-2 w-px shrink-0 bg-border" aria-hidden />
                  )}
                  {subBuses.map((b) => (
                    <BusStripView
                      key={b.id}
                      bus={b}
                      onPickPlugin={(busId, slot) => setPickerTarget({ kind: "bus", busId, slot })}
                    />
                  ))}
                </div>
              )}
            </div>
            {masterBus && (
              <div className="flex shrink-0 items-stretch border-l-2 border-red-500/30 pl-2">
                <BusStripView
                  bus={masterBus}
                  isMaster
                  onPickPlugin={(busId, slot) => setPickerTarget({ kind: "bus", busId, slot })}
                />
              </div>
            )}
          </div>
        );
      })()}

      <PluginPicker
        open={pickerTarget !== null}
        target={pickerTarget}
        onClose={() => setPickerTarget(null)}
      />
    </div>
  );
}
