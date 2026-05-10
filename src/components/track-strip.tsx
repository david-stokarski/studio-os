"use client";

import { useCallback, useRef, useState } from "react";
import { Fader } from "@/components/ui/fader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Knob } from "@/components/ui/knob";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { LevelMeter } from "@/components/level-meter";
import { useAppStore } from "@/lib/store";
import * as engine from "@/lib/engine";
import { FADER_MIN_DB, linearToDb } from "@/lib/utils";
import { VolumeX, Plus, X, Trash2, Power, GripVertical, LogIn, LogOut } from "lucide-react";
import type { Track } from "@/lib/types";
import { MAX_PLUGINS_PER_TRACK, MASTER_BUS_ID } from "@/lib/types";

interface Props {
  track: Track;
  onPickPlugin: (trackId: string, slot: number) => void;
  onReorder: (sourceId: string, targetId: string, position: "before" | "after") => void;
}

const STRIP_METER_HEIGHT = 120;
const DB_LABEL_HEIGHT    = 12; // px above each meter for the peak readout
const PLUGIN_DRAG_THRESHOLD = 4; // px movement before a press becomes a drag

function panText(pan: number) {
  // Letter labels are reserved for the three "anchor" positions: C (centered),
  // L (full left), R (full right). Anywhere in between we just show the number;
  // the knob's arc already conveys the direction visually.
  const n = Math.round(pan * 100);
  if (n === 0) return "C";
  if (n === 100) return "R";
  if (n === -100) return "L";
  return Math.abs(n).toString();
}

// Linear peak (0..1) → compact dB readout shown above each meter.
function peakDbText(linear: number): string {
  if (linear <= 0) return "−∞";
  const db = linearToDb(linear);
  if (db <= -60) return "−∞";
  const r = Math.round(db);
  if (r === 0) return "0";
  return r > 0 ? `+${r}` : `${r}`.replace("-", "−");
}

export function TrackStripView({ track, onPickPlugin, onReorder }: Props) {
  const { patchTrack, removeTrack, meters, numActiveInputs, buses } = useAppStore();
  // Track-strip drag state lives in the store so all strips can render the
  // current drop indicator without prop-drilling.
  const dragState    = useAppStore((s) => s.dragState);
  const setDragState = useAppStore((s) => s.setDragState);
  const meter = meters[track.id] ?? { in: 0, outL: 0, outR: 0, monitoring: false };

  const setName = useCallback(
    (v: string) => patchTrack(track.id, { name: v }),
    [track.id, patchTrack]
  );
  const setGain = useCallback(
    (db: number) => { patchTrack(track.id, { gainDb: db }); engine.setTrackGain(track.id, db); },
    [track.id, patchTrack]
  );
  const setPan = useCallback(
    (p: number) => { patchTrack(track.id, { pan: p }); engine.setTrackPan(track.id, p); },
    [track.id, patchTrack]
  );
  const toggleMute = useCallback(() => {
    const next = !track.mute;
    patchTrack(track.id, { mute: next });
    engine.setTrackMute(track.id, next);
  }, [track.id, track.mute, patchTrack]);
  const toggleSolo = useCallback(() => {
    const next = !track.solo;
    patchTrack(track.id, { solo: next });
    engine.setTrackSolo(track.id, next);
  }, [track.id, track.solo, patchTrack]);

  const changeInput = useCallback((v: string) => {
    const ch = Number(v);
    patchTrack(track.id, { inputCh: ch });
    engine.setTrackInput(track.id, ch);
  }, [track.id, patchTrack]);
  const changeBus = useCallback((v: string) => {
    const next = v === "__master__" ? "" : v;
    patchTrack(track.id, { busId: next });
    engine.setTrackBus(track.id, next);
  }, [track.id, patchTrack]);
  const onRemove = useCallback(async () => {
    if (!confirm(`Delete track "${track.name}"?`)) return;
    try { await engine.removeTrack(track.id); } catch (e) { console.warn(e); }
    removeTrack(track.id);
  }, [track.id, track.name, removeTrack]);

  const removePluginAt = useCallback(async (slot: number) => {
    await engine.removePlugin(track.id, slot);
    const next = [...track.plugins];
    next[slot] = null;
    patchTrack(track.id, { plugins: next });
  }, [track.id, track.plugins, patchTrack]);

  const togglePluginBypass = useCallback(async (slot: number) => {
    const cur = track.plugins[slot];
    if (!cur) return;
    const next = !cur.bypassed;
    const nextPlugins = [...track.plugins];
    nextPlugins[slot] = { ...cur, bypassed: next };
    patchTrack(track.id, { plugins: nextPlugins });
    try { await engine.setPluginBypassed(track.id, slot, next); }
    catch (e) { console.warn("setPluginBypassed failed:", e); }
  }, [track.id, track.plugins, patchTrack]);

  const showSlotUi = useCallback(async (slot: number) => {
    if (track.plugins[slot]) {
      try { await engine.showPluginUi(track.id, slot); }
      catch (e) { console.warn("showPluginUi failed:", e); }
    }
  }, [track.id, track.plugins]);

  const addNext = () => {
    const slot = track.plugins.findIndex((p) => p === null);
    if (slot === -1) return;
    onPickPlugin(track.id, slot);
  };

  const onNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>("[data-track-name]")
      );
      const idx = inputs.indexOf(e.currentTarget);
      const next = e.shiftKey ? inputs[idx - 1] : inputs[idx + 1];
      if (next) { next.focus(); next.select(); }
    }
  };

  const inputOptions = Array.from({ length: Math.max(numActiveInputs, 1) }, (_, i) => i);
  const subBuses = buses.filter((b) => b.id !== MASTER_BUS_ID);

  // --- track reorder (grip handle, store-backed drag state) ---
  const stripRef = useRef<HTMLDivElement>(null);
  const dragActiveRef = useRef(false);

  const updateDropTarget = (clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY);
    const stripEl = el?.closest('[data-track-strip="true"]') as HTMLElement | null;
    const targetId = stripEl?.dataset.trackId ?? null;
    if (!stripEl || !targetId) {
      const cur = useAppStore.getState().dragState;
      if (cur.targetId !== null) setDragState({ ...cur, targetId: null });
      return;
    }
    const rect = stripEl.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    const side: "before" | "after" = clientX < mid ? "before" : "after";
    setDragState({ sourceId: track.id, targetId, side });
  };

  const onGripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragActiveRef.current = true;
    setDragState({ sourceId: track.id, targetId: null, side: "before" });
  };
  const onGripPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return;
    updateDropTarget(e.clientX, e.clientY);
  };
  const finishGripDrag = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!dragActiveRef.current) return;
    dragActiveRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    const drag = useAppStore.getState().dragState;
    setDragState({ sourceId: null, targetId: null, side: "before" });
    if (commit && drag.sourceId && drag.targetId && drag.sourceId !== drag.targetId) {
      onReorder(drag.sourceId, drag.targetId, drag.side);
    }
  };

  const isDragSource = dragState.sourceId === track.id;
  const isDropTarget = dragState.targetId === track.id;
  const showBefore   = isDropTarget && dragState.side === "before";
  const showAfter    = isDropTarget && dragState.side === "after";

  // --- plugin reorder (press-and-drag with click-to-open fallback) ---
  // Each pill is both clickable (open editor) and draggable (reorder).
  // pointerdown captures the pointer + records start position; pointermove
  // promotes to a drag once movement crosses PLUGIN_DRAG_THRESHOLD.
  // pointerup either commits the reorder (if drag crossed threshold) or fires
  // the editor (if it was a click).
  const pluginDragRef = useRef<null | {
    pointerId: number;
    fromSlot: number;
    startX: number;
    startY: number;
    active: boolean;
  }>(null);
  const [pluginDrag, setPluginDrag] = useState<null | {
    fromSlot: number;
    toSlot: number | null;
    side: "before" | "after";
  }>(null);
  // Keep latest drag visual in a ref so the pointer-up handler can read it
  // synchronously without depending on closure capture.
  const pluginDragVisualRef = useRef<typeof pluginDrag>(null);
  pluginDragVisualRef.current = pluginDrag;

  const onPillPointerDown = (slot: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Don't engage if the press started on one of the pill's inner buttons.
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pluginDragRef.current = {
      pointerId: e.pointerId,
      fromSlot: slot,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
  };
  const onPillPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = pluginDragRef.current;
    if (!drag) return;
    if (!drag.active) {
      const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (dist < PLUGIN_DRAG_THRESHOLD) return;
      drag.active = true;
      setPluginDrag({ fromSlot: drag.fromSlot, toSlot: null, side: "after" });
    }
    // Find a plugin pill belonging to *this* track under the cursor.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pillEl = el?.closest('[data-plugin-pill="true"]') as HTMLElement | null;
    if (!pillEl || pillEl.dataset.trackId !== track.id) {
      setPluginDrag({ fromSlot: drag.fromSlot, toSlot: null, side: "after" });
      return;
    }
    const targetSlot = Number(pillEl.dataset.pluginSlot);
    if (Number.isNaN(targetSlot)) return;
    const rect = pillEl.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const side: "before" | "after" = e.clientY < mid ? "before" : "after";
    setPluginDrag({ fromSlot: drag.fromSlot, toSlot: targetSlot, side });
  };
  const finishPillDrag = async (
    e: React.PointerEvent<HTMLDivElement>,
    slot: number,
    commit: boolean,
  ) => {
    const drag = pluginDragRef.current;
    pluginDragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (!drag) return;

    if (drag.active && commit) {
      const visual = pluginDragVisualRef.current;
      if (visual && visual.toSlot != null) {
        // Translate target + side into a destination slot index using
        // Array.splice semantics on the underlying plugins array.
        let dest = visual.side === "before" ? visual.toSlot : visual.toSlot + 1;
        if (drag.fromSlot < dest) dest -= 1;
        if (dest !== drag.fromSlot) {
          const arr = [...track.plugins];
          const [moved] = arr.splice(drag.fromSlot, 1);
          arr.splice(dest, 0, moved);
          while (arr.length < MAX_PLUGINS_PER_TRACK) arr.push(null);
          patchTrack(track.id, { plugins: arr });
          try { await engine.reorderPlugin(track.id, drag.fromSlot, dest); }
          catch (err) { console.warn("reorderPlugin failed:", err); }
        }
      }
    } else if (!drag.active) {
      // A click — open the plugin editor.
      void showSlotUi(slot);
    }
    setPluginDrag(null);
  };

  return (
    <div
      ref={stripRef}
      data-track-strip="true"
      data-track-id={track.id}
      className={`relative flex h-full w-32 shrink-0 flex-col items-stretch gap-1.5 rounded-md border bg-card p-1.5 transition-opacity ${
        isDragSource ? "opacity-50" : ""
      }`}
    >
      {showBefore && (
        <div className="pointer-events-none absolute -left-1 top-0 bottom-0 w-0.5 rounded bg-primary" />
      )}
      {showAfter && (
        <div className="pointer-events-none absolute -right-1 top-0 bottom-0 w-0.5 rounded bg-primary" />
      )}

      {/* Header: drag handle + name + delete */}
      <div className="flex items-center gap-0.5">
        <div
          role="button"
          tabIndex={-1}
          aria-label="Drag to reorder"
          className="flex h-6 w-3 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={(e) => finishGripDrag(e, true)}
          onPointerCancel={(e) => finishGripDrag(e, false)}
          title="Drag to reorder"
        >
          <GripVertical className="pointer-events-none h-3.5 w-3.5" />
        </div>
        <Input
          data-track-name
          value={track.name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onNameKeyDown}
          onFocus={(e) => e.currentTarget.select()}
          className="h-6 min-w-0 flex-1 rounded-none border-0 bg-transparent px-1 text-xs font-semibold shadow-none focus-visible:ring-0"
        />
        <Button size="icon" variant="ghost" className="h-5 w-5" onClick={onRemove} title="Delete track">
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {/* Routing dropdowns — no labels */}
      {/* Input channel — LogIn icon hints at "audio enters here". */}
      <div className="flex items-center gap-1">
        <LogIn className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        <Select value={String(track.inputCh)} onValueChange={changeInput}>
          <SelectTrigger
            className="h-6 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-[11px] shadow-none focus:ring-0 focus:ring-offset-0 [&>svg]:hidden"
            title="Input channel"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {inputOptions.map((i) => (
              <SelectItem key={i} value={String(i)}>{`Ch ${i + 1}`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* Routing target — LogOut icon hints at "audio leaves through here". */}
      <div className="flex items-center gap-1">
        <LogOut className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        <Select
          value={!track.busId || track.busId === MASTER_BUS_ID ? "__master__" : track.busId}
          onValueChange={changeBus}
        >
          <SelectTrigger
            className="h-6 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-[11px] shadow-none focus:ring-0 focus:ring-offset-0 [&>svg]:hidden"
            title="Route to"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__master__">Master</SelectItem>
            {subBuses.map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Plugin chain */}
      <div className="flex flex-1 min-h-[80px] flex-col gap-1">
        <div className="flex-1 min-h-0 overflow-y-auto rounded border border-border/50 bg-background/30 p-1">
          <div className="flex flex-col gap-0.5">
            {track.plugins.map((p, slot) => {
              if (!p) return null;
              const isDragSrc = pluginDrag?.fromSlot === slot;
              const isDropTgt = pluginDrag?.toSlot === slot;
              return (
                <div
                  key={slot}
                  data-plugin-pill="true"
                  data-track-id={track.id}
                  data-plugin-slot={slot}
                  onPointerDown={onPillPointerDown(slot)}
                  onPointerMove={onPillPointerMove}
                  onPointerUp={(e) => finishPillDrag(e, slot, true)}
                  onPointerCancel={(e) => finishPillDrag(e, slot, false)}
                  className={`group relative flex select-none items-center gap-0.5 rounded px-1 py-0.5 text-[11px] cursor-grab active:cursor-grabbing ${
                    p.bypassed ? "bg-secondary/40 text-muted-foreground" : "bg-secondary"
                  } ${isDragSrc ? "opacity-50" : "hover:bg-secondary/70"}`}
                >
                  {isDropTgt && pluginDrag?.side === "before" && (
                    <div className="pointer-events-none absolute left-0 right-0 -top-px h-0.5 rounded bg-primary" />
                  )}
                  {isDropTgt && pluginDrag?.side === "after" && (
                    <div className="pointer-events-none absolute left-0 right-0 -bottom-px h-0.5 rounded bg-primary" />
                  )}
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); void togglePluginBypass(slot); }}
                    className={`flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded ${
                      p.bypassed
                        ? "text-muted-foreground hover:text-foreground"
                        : "text-emerald-500 hover:text-emerald-400"
                    }`}
                    title={p.bypassed ? "Enable plugin" : "Bypass plugin"}
                  >
                    <Power className="pointer-events-none h-3 w-3" />
                  </button>
                  <span
                    className={`min-w-0 flex-1 truncate ${p.bypassed ? "line-through" : ""}`}
                    title={`${p.name} — click to open editor, drag to reorder`}
                  >
                    {p.name}
                  </span>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); void removePluginAt(slot); }}
                    className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-50 hover:text-foreground group-hover:opacity-100"
                    title="Remove plugin"
                  >
                    <X className="pointer-events-none h-3 w-3" />
                  </button>
                </div>
              );
            })}
            {/* Faded ghost-pill at the end — clicking opens the picker. */}
            <button
              type="button"
              onClick={addNext}
              className="flex items-center justify-center rounded bg-secondary/30 py-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              title="Add plugin"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Meters with peak-dB labels above | Pan + Fader column matched in height.
          Each column has a fixed width so the dB label width (which varies as
          numbers change — "0", "−12", "−∞", "+3") can't shift the meters. */}
      <div className="flex justify-center gap-1.5">
        <div className="flex flex-col items-center" style={{ width: 22 }}>
          <div
            className="flex w-full items-end justify-center overflow-hidden text-[8px] tabular-nums leading-none text-muted-foreground"
            style={{ height: DB_LABEL_HEIGHT }}
          >
            {peakDbText(meter.in)}
          </div>
          <LevelMeter value={meter.in} width={5} height={STRIP_METER_HEIGHT} />
        </div>
        <div className="flex flex-col items-center" style={{ width: 22 }}>
          <div
            className="flex w-full items-end justify-center overflow-hidden text-[8px] tabular-nums leading-none text-muted-foreground"
            style={{ height: DB_LABEL_HEIGHT }}
          >
            {peakDbText(Math.max(meter.outL, meter.outR))}
          </div>
          <div className="flex gap-px">
            <LevelMeter value={meter.outL} width={5} height={STRIP_METER_HEIGHT} />
            <LevelMeter value={meter.outR} width={5} height={STRIP_METER_HEIGHT} />
          </div>
        </div>
        <div
          className="flex flex-col items-center gap-1"
          style={{ height: STRIP_METER_HEIGHT + DB_LABEL_HEIGHT, width: 28 }}
        >
          <Knob
            value={track.pan}
            min={-1}
            max={1}
            defaultValue={0}
            onChange={setPan}
            size={28}
            label={panText(track.pan)}
          />
          <div className="flex-1 w-full"><Fader valueDb={track.gainDb} onChange={setGain} resetTo={0} /></div>
        </div>
      </div>
      <div className="text-center text-[10px] tabular-nums text-muted-foreground">
        {track.gainDb <= FADER_MIN_DB ? "−∞" : `${track.gainDb.toFixed(1)} dB`}
      </div>

      {/* Mute / Solo */}
      <div className="flex items-center justify-center gap-1">
        <Button
          size="icon"
          variant={track.mute ? "destructive" : "outline"}
          className="h-6 w-6 text-[10px] font-bold"
          onClick={toggleMute}
          title={track.mute ? "Unmute" : "Mute"}
        >
          {track.mute ? <VolumeX className="h-3 w-3" /> : "M"}
        </Button>
        <Button
          size="icon"
          variant={track.solo ? "default" : "outline"}
          className={`h-6 w-6 text-[10px] font-bold ${track.solo ? "bg-amber-500 text-amber-950 hover:bg-amber-500/90" : ""}`}
          onClick={toggleSolo}
          title={track.solo ? "Unsolo" : "Solo"}
        >
          S
        </Button>
      </div>
    </div>
  );
}
