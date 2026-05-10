"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore, defaultBus } from "@/lib/store";
import * as engine from "@/lib/engine";
import type { Preset } from "@/lib/types";
import { MASTER_BUS_ID, MAX_PLUGINS_PER_BUS } from "@/lib/types";
import { Plus, Undo2, Redo2 } from "lucide-react";

// Action queued behind the unsaved-changes confirmation dialog. After the user
// resolves the dialog (Save / Don't Save / Cancel) we either run this and clear
// it, or drop it and stay where we are.
type PendingAction =
  | { type: "load"; name: string }
  | { type: "new" };

interface PresetManagerProps {
  onUndo: () => void;
  onRedo: () => void;
  // "New preset" is implemented in Mixer (it restarts the engine subprocess)
  // so this component just calls the callback and resets its own local state.
  onNew: () => Promise<void>;
}

export function PresetManager({ onUndo, onRedo, onNew }: PresetManagerProps) {
  const {
    tracks, setTracks, buses, setBuses, currentInput, currentOutput, sampleRate, bufferSize,
    setDeviceInfo, setPresetLoading, presetLoading,
    presetDirty, setPresetDirty,
  } = useAppStore();
  // Subscribe to history with selectors so the undo/redo buttons re-render only
  // when their enabled state actually flips.
  const canUndo = useAppStore((s) => s.history.past.length > 1);
  const canRedo = useAppStore((s) => s.history.future.length > 0);
  const isLoading = presetLoading.active;

  const [presets, setPresets] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");

  // Confirmation flow state. `pendingAction` is what we should run after the
  // user resolves the dialog; `runAfterSaveAs` carries the same intent across
  // a Save-As dialog (when the user picks "Save" but there's no current name).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const runAfterSaveAsRef = useRef<PendingAction | null>(null);

  const refresh = async () => setPresets(await engine.listPresets());
  useEffect(() => { void refresh(); }, []);

  const snapshot = async (name: string): Promise<Preset> => {
    const tracksWithState = await Promise.all(tracks.map(async (t) => {
      const plugins = await Promise.all(t.plugins.map(async (slot, i) => {
        if (!slot) return null;
        try {
          const state = await engine.getPluginState(t.id, i);
          return { ...slot, state };
        } catch {
          return slot;
        }
      }));
      return { ...t, plugins };
    }));
    const busesWithState = await Promise.all(buses.map(async (b) => {
      const plugins = await Promise.all(b.plugins.map(async (slot, i) => {
        if (!slot) return null;
        try {
          const state = await engine.getBusPluginState(b.id, i);
          return { ...slot, state };
        } catch {
          return slot;
        }
      }));
      return { ...b, plugins };
    }));
    return {
      name,
      device: { input: currentInput, output: currentOutput, sampleRate, bufferSize },
      tracks: tracksWithState,
      buses: busesWithState,
    };
  };

  const save = async () => {
    if (!current) return;
    const p = await snapshot(current);
    await engine.savePresetFs(p.name, p);
    setPresetDirty(false);
    await refresh();
  };

  const saveAs = async () => {
    const name = saveAsName.trim();
    if (!name) return;
    const p = await snapshot(name);
    await engine.savePresetFs(p.name, p);
    setCurrent(name);
    setPresetDirty(false);
    setSaveAsName("");
    setSaveAsOpen(false);
    await refresh();
    // If a Save-As was chained off the unsaved-changes dialog, run the
    // queued action now (e.g. switch to the preset the user wanted to load).
    const queued = runAfterSaveAsRef.current;
    runAfterSaveAsRef.current = null;
    if (queued) await runPending(queued);
  };

  // Delegates to the parent. The parent (Mixer) restarts the audio engine
  // subprocess to get a guaranteed-clean state, then clears tracks/buses and
  // reapplies the user's device. Once that returns, we just clear our own
  // local "current preset" state — store-side cleanup is already done.
  const newPreset = async () => {
    try {
      await onNew();
    } catch (err) {
      console.error("newPreset failed:", err);
      return;
    }
    setCurrent("");
  };

  const load = async (name: string) => {
    if (!name) return;
    const p = await engine.loadPresetFs(name);
    const presetBuses = p.buses ?? [];
    const restoredBusCount = presetBuses.some((b) => b.id === MASTER_BUS_ID)
      ? presetBuses.length
      : presetBuses.length + 1;
    const totalSteps = p.tracks.length + restoredBusCount + 1;
    setPresetLoading({ active: true, name, current: 0, total: totalSteps });

    try {
      try {
        const r = await engine.setDevice(
          p.device.input, p.device.output || p.device.input,
          p.device.sampleRate, p.device.bufferSize, 32
        );
        setDeviceInfo({
          currentInput: p.device.input, currentOutput: p.device.output || p.device.input,
          sampleRate: r.sampleRate, bufferSize: r.bufferSize,
          numActiveInputs: r.numActiveInputs, numActiveOutputs: r.numActiveOutputs,
        });
      } catch (e) {
        alert(`Could not apply preset device: ${e}`);
        return;
      }
      setPresetLoading({ active: true, name, current: 1, total: totalSteps });

      for (const t of tracks) {
        try { await engine.removeTrack(t.id); } catch {}
      }
      for (const b of buses) {
        if (b.id === MASTER_BUS_ID) {
          for (let s = 0; s < MAX_PLUGINS_PER_BUS; s++) {
            try { await engine.removePluginOnBus(MASTER_BUS_ID, s); } catch {}
          }
          try { await engine.setBusGain(MASTER_BUS_ID, 0); } catch {}
          try { await engine.setBusPan(MASTER_BUS_ID, 0); } catch {}
          try { await engine.setBusMute(MASTER_BUS_ID, false); } catch {}
          continue;
        }
        try { await engine.removeBus(b.id); } catch {}
      }
      setTracks([]);
      setBuses([]);

      const finalBuses = presetBuses.some((b) => b.id === MASTER_BUS_ID)
        ? presetBuses
        : [defaultBus(MASTER_BUS_ID, "Master"), ...presetBuses];

      for (let bi = 0; bi < finalBuses.length; bi++) {
        const b = finalBuses[bi];
        try {
          await engine.addBus(b.id, b.name, b.outL, b.outR);
          await engine.setBusGain(b.id, b.gainDb);
          await engine.setBusPan(b.id, b.pan);
          await engine.setBusMute(b.id, b.mute);
          if (b.id === MASTER_BUS_ID) {
            await engine.setBusOutput(b.id, b.outL, b.outR);
          }
          for (let s = 0; s < b.plugins.length; s++) {
            const slot = b.plugins[s];
            if (slot) {
              try {
                await engine.loadPluginOnBus(b.id, s, slot.id, slot.state);
                if (slot.bypassed) await engine.setBusPluginBypassed(b.id, s, true);
              }
              catch (e) { console.warn(`bus plugin failed on ${b.name} slot ${s}: ${e}`); }
            }
          }
        } catch (e) {
          console.warn(`failed to restore bus ${b.name}:`, e);
        }
        setPresetLoading({ active: true, name, current: 1 + bi + 1, total: totalSteps });
      }

      for (let ti = 0; ti < p.tracks.length; ti++) {
        const t = p.tracks[ti];
        try {
          await engine.addTrack(t.id, t.name, t.inputCh, t.outL, t.outR);
          if (t.busId) await engine.setTrackBus(t.id, t.busId);
          await engine.setTrackGain(t.id, t.gainDb);
          await engine.setTrackPan(t.id, t.pan);
          await engine.setTrackMute(t.id, t.mute);
          await engine.setTrackMonitor(t.id, true);
          if (t.solo) await engine.setTrackSolo(t.id, true);
          for (let s = 0; s < t.plugins.length; s++) {
            const slot = t.plugins[s];
            if (slot) {
              try {
                await engine.loadPlugin(t.id, s, slot.id, slot.state);
                if (slot.bypassed) await engine.setPluginBypassed(t.id, s, true);
              }
              catch (e) { console.warn(`plugin failed on ${t.name} slot ${s}: ${e}`); }
            }
          }
        } catch (e) {
          console.warn(`failed to restore track ${t.name}:`, e);
        }
        setPresetLoading({ active: true, name, current: 1 + restoredBusCount + ti + 1, total: totalSteps });
      }
      setBuses(finalBuses);
      setTracks(p.tracks.map((t) => ({ ...t, monitor: true })));
      setCurrent(name);
    } finally {
      setPresetLoading({ active: false, name: "", current: 0, total: 0 });
      setPresetDirty(false);
      // Anchor undo at the freshly-loaded state.
      useAppStore.getState().resetHistory();
    }
  };

  const remove = async () => {
    if (!current) return;
    if (!confirm(`Delete preset "${current}"?`)) return;
    await engine.deletePresetFs(current);
    setCurrent("");
    setPresetDirty(false);
    await refresh();
  };

  // --- guarded transitions (load / new) ---
  // If the workspace has unsaved changes, queue the desired action and prompt
  // the user. Otherwise run it immediately.
  const tryLoad = (name: string) => {
    if (!name || name === current) return;
    if (presetDirty) {
      setPendingAction({ type: "load", name });
      setConfirmOpen(true);
    } else {
      void load(name);
    }
  };
  const tryNew = () => {
    if (presetDirty) {
      setPendingAction({ type: "new" });
      setConfirmOpen(true);
    } else {
      void newPreset();
    }
  };

  const runPending = async (action: PendingAction | null) => {
    if (!action) return;
    if (action.type === "load") await load(action.name);
    else if (action.type === "new") await newPreset();
  };

  const onConfirmSave = async () => {
    setConfirmOpen(false);
    const action = pendingAction;
    setPendingAction(null);
    if (current) {
      await save();
      await runPending(action);
    } else {
      // No current preset name — open Save As, run pending after that completes.
      runAfterSaveAsRef.current = action;
      setSaveAsOpen(true);
    }
  };
  const onConfirmDiscard = async () => {
    setConfirmOpen(false);
    const action = pendingAction;
    setPendingAction(null);
    await runPending(action);
  };
  const onConfirmCancel = () => {
    setConfirmOpen(false);
    setPendingAction(null);
  };

  // Disabled-state styling for the uppercase text actions on the top row.
  const textBtnBase = "text-[10px] font-semibold uppercase tracking-wider transition-colors";
  const textBtnEnabled = "text-muted-foreground hover:text-foreground";
  const textBtnDisabled = "cursor-not-allowed text-muted-foreground/40";
  const textBtnClass = (enabled: boolean) =>
    `${textBtnBase} ${enabled ? textBtnEnabled : textBtnDisabled}`;

  const canSave   = !!current && !isLoading;
  const canSaveAs = !isLoading;
  const canDelete = !!current && !isLoading;

  return (
    <div className="flex flex-col items-center gap-1.5">
      {/* Top row: undo / redo + uppercase text actions. Iconography on the
          left, text on the right; everything is a thin click target so the
          row feels like a toolbar rather than a wall of buttons. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo || isLoading}
          className={`flex items-center transition-colors ${
            canUndo && !isLoading ? "text-muted-foreground hover:text-foreground" : "cursor-not-allowed text-muted-foreground/40"
          }`}
          title="Undo"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo || isLoading}
          className={`flex items-center transition-colors ${
            canRedo && !isLoading ? "text-muted-foreground hover:text-foreground" : "cursor-not-allowed text-muted-foreground/40"
          }`}
          title="Redo"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        <span className="h-3 w-px bg-border" aria-hidden />
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className={textBtnClass(canSave)}
          title="Save (overwrite current preset)"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => { if (canSaveAs) setSaveAsOpen(true); }}
          disabled={!canSaveAs}
          className={textBtnClass(canSaveAs)}
          title="Save as a new preset"
        >
          Save As
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={!canDelete}
          className={textBtnClass(canDelete)}
          title="Delete current preset"
        >
          Delete
        </button>
      </div>

      {/* Bottom row: + new attached to the preset dropdown as a button group.
          The + has no right border/radius and the dropdown trigger has no
          left border/radius so they read as one element. */}
      <div className="inline-flex">
        <Button
          size="icon" variant="outline"
          className="h-7 w-7 rounded-r-none border-r-0"
          onClick={tryNew} disabled={isLoading}
          title="New preset"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        {/* Keying on `current` forces Radix Select to remount when we clear the
            selection (current → ""). Otherwise switching value from a defined
            string to `undefined` makes Radix flip to uncontrolled mode and
            keep its previously-selected item visually checked, even though
            our controlled state says "nothing selected". */}
        <Select
          key={current || "__no_preset__"}
          value={current || undefined}
          onValueChange={tryLoad}
          disabled={isLoading}
        >
          <SelectTrigger
            className="h-7 w-56 rounded-l-none"
            disabled={isLoading}
          >
            <SelectValue placeholder="Select preset…">
              {current ? (
                <span className={presetDirty ? "italic" : ""}>
                  {current}{presetDirty ? " *" : ""}
                </span>
              ) : presetDirty ? (
                <span className="italic text-muted-foreground">Untitled *</span>
              ) : (
                <span className="text-muted-foreground">No preset</span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {presets.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No presets saved</div>
            ) : presets.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Dialog open={saveAsOpen} onOpenChange={setSaveAsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Save preset as…</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              placeholder="preset name"
              value={saveAsName}
              onChange={(e) => setSaveAsName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveAs(); }}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                runAfterSaveAsRef.current = null;
                setSaveAsOpen(false);
              }}>Cancel</Button>
              <Button size="sm" onClick={saveAs} disabled={!saveAsName.trim()}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unsaved-changes confirmation when switching presets or starting fresh. */}
      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!open) onConfirmCancel(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {current
              ? `You have unsaved changes to "${current}". Save them before continuing?`
              : "You have unsaved changes that aren't part of any preset. Save them as a new preset?"}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onConfirmCancel}>Cancel</Button>
            <Button size="sm" variant="outline" onClick={onConfirmDiscard}>Don&apos;t Save</Button>
            <Button size="sm" onClick={onConfirmSave}>{current ? "Save" : "Save As…"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
