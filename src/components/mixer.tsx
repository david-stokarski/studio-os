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
import { MASTER_BUS_ID } from "@/lib/types";

function uid(prefix = "t") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function Mixer() {
  const {
    ready, setReady, tracks, addTrack, setMeters, setBusMeters, setDeviceInfo,
    setPlugins, scan, setScan, numActiveInputs, presetLoading,
    buses, addBus, moveTrack,
  } = useAppStore();
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const initialized = useRef(false);
  const scanStarted = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const unlistens: Array<() => void> = [];

    (async () => {
      const unReady = await engine.onReady(async () => {
        setReady(true);
        await pullDeviceInfo();
        await applySavedPrefs();
        await ensureMasterBus();
        await loadOrScanPlugins();
      });
      unlistens.push(unReady);

      const unMeters = await engine.onMeters((m) => {
        setMeters(m.tracks);
        if (m.buses) setBusMeters(m.buses);
      });
      unlistens.push(unMeters);

      const unLog = await engine.onLog((line) => console.log("[engine]", line));
      unlistens.push(unLog);

      const unScan = await engine.onScanProgress((p) => {
        setScan({ active: p.current < p.total, current: p.current, total: p.total, name: p.name });
      });
      unlistens.push(unScan);

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
      <header className="flex items-center gap-3">
        <PresetManager />
        <Button size="sm" onClick={onAddTrack} disabled={!ready || numActiveInputs === 0}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add Track
        </Button>
        <Button size="sm" variant="outline" onClick={onAddBus} disabled={!ready}>
          <GitMerge className="mr-1 h-3.5 w-3.5" /> Add Bus
        </Button>
        {scan.active && (
          <div className="flex flex-1 min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">
              Scanning {scan.total > 0 ? `${scan.current} / ${scan.total}` : "…"}
            </span>
            <span className="flex-1 min-w-0 truncate font-mono">{scan.name}</span>
            <div className="h-1.5 w-24 overflow-hidden rounded bg-secondary">
              <div
                className="h-full bg-primary transition-[width] duration-100"
                style={{ width: `${scan.total > 0 ? (scan.current / scan.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
        <div className={`ml-auto text-xs whitespace-nowrap ${ready ? "text-emerald-500" : "text-amber-500"}`}>
          {ready ? "● Ready" : "○ Booting…"}
        </div>
        <SettingsDialog
          scanActive={scan.active}
          scanCurrent={scan.current}
          scanTotal={scan.total}
          scanName={scan.name}
          onRescan={rescanPlugins}
        />
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
