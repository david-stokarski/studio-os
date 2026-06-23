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
import { VolumeX, Plus, X, Trash2, Power } from "lucide-react";
import type { Bus } from "@/lib/types";
import { MAX_PLUGINS_PER_BUS } from "@/lib/types";

interface Props {
  bus: Bus;
  onPickPlugin: (busId: string, slot: number) => void;
  // The master bus is rendered differently: red accent, undeletable, plain
  // "MASTER" title text instead of an editable name input, and it's the only
  // bus that lets you pick the physical output channels.
  isMaster?: boolean;
}

const STRIP_METER_HEIGHT = 120;
const DB_LABEL_HEIGHT    = 12;
const PLUGIN_DRAG_THRESHOLD = 4;

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

function peakDbText(linear: number): string {
  if (linear <= 0) return "−∞";
  const db = linearToDb(linear);
  if (db <= -60) return "−∞";
  const r = Math.round(db);
  if (r === 0) return "0";
  return r > 0 ? `+${r}` : `${r}`.replace("-", "−");
}

export function BusStripView({ bus, onPickPlugin, isMaster = false }: Props) {
  const { patchBus, removeBus, busMeters, numActiveOutputs, tracks } = useAppStore();
  const meter = busMeters[bus.id] ?? { inL: 0, inR: 0, outL: 0, outR: 0 };

  const setName = useCallback(
    (v: string) => patchBus(bus.id, { name: v }),
    [bus.id, patchBus]
  );
  const setGain = useCallback(
    (db: number) => { patchBus(bus.id, { gainDb: db }); engine.setBusGain(bus.id, db); },
    [bus.id, patchBus]
  );
  const setPan = useCallback(
    (p: number) => { patchBus(bus.id, { pan: p }); engine.setBusPan(bus.id, p); },
    [bus.id, patchBus]
  );
  const toggleMute = useCallback(() => {
    const next = !bus.mute;
    patchBus(bus.id, { mute: next });
    engine.setBusMute(bus.id, next);
  }, [bus.id, bus.mute, patchBus]);

  const changeOutput = useCallback((v: string) => {
    const [l, r] = v.split(",").map(Number);
    patchBus(bus.id, { outL: l, outR: r });
    engine.setBusOutput(bus.id, l, r);
  }, [bus.id, patchBus]);

  // Unified routing dropdown for sub-buses. Values:
  //   "bus:__master__" → sum into master (default)
  //   "out:<L>,<R>"    → direct to physical output pair, bypassing master
  const changeRoute = useCallback((v: string) => {
    if (v.startsWith("out:")) {
      const [l, r] = v.slice(4).split(",").map(Number);
      patchBus(bus.id, { dest: "out", outL: l, outR: r });
      void engine.setBusOutput(bus.id, l, r);
      void engine.setBusDest(bus.id, "out");
      return;
    }
    // The only non-"out" option for a sub-bus is master.
    patchBus(bus.id, { dest: "bus" });
    void engine.setBusDest(bus.id, "bus");
  }, [bus.id, patchBus]);

  const toggleOutputMode = useCallback(() => {
    const next = bus.outputMode === "mono" ? "stereo" : "mono";
    let { outL, outR } = bus;
    if (next === "stereo") {
      if (outL % 2 !== 0) outL = Math.max(0, outL - 1);
      outR = outL + 1;
    } else {
      outR = outL;
    }
    patchBus(bus.id, { outputMode: next, outL, outR });
    void engine.setBusOutputMode(bus.id, next);
    void engine.setBusOutput(bus.id, outL, outR);
  }, [bus, patchBus]);

  const onRemove = useCallback(async () => {
    const routedCount = tracks.filter((t) => t.busId === bus.id).length;
    const msg = routedCount > 0
      ? `Delete bus "${bus.name}"? ${routedCount} track${routedCount === 1 ? "" : "s"} routed to it will return to master.`
      : `Delete bus "${bus.name}"?`;
    if (!confirm(msg)) return;
    try { await engine.removeBus(bus.id); } catch (e) { console.warn(e); }
    removeBus(bus.id);
  }, [bus.id, bus.name, removeBus, tracks]);

  const removePluginAt = useCallback(async (slot: number) => {
    await engine.removePluginOnBus(bus.id, slot);
    const next = [...bus.plugins];
    next[slot] = null;
    patchBus(bus.id, { plugins: next });
  }, [bus.id, bus.plugins, patchBus]);

  const togglePluginBypass = useCallback(async (slot: number) => {
    const cur = bus.plugins[slot];
    if (!cur) return;
    const next = !cur.bypassed;
    const nextPlugins = [...bus.plugins];
    nextPlugins[slot] = { ...cur, bypassed: next };
    patchBus(bus.id, { plugins: nextPlugins });
    try { await engine.setBusPluginBypassed(bus.id, slot, next); }
    catch (e) { console.warn("setBusPluginBypassed failed:", e); }
  }, [bus.id, bus.plugins, patchBus]);

  const showSlotUi = useCallback(async (slot: number) => {
    if (bus.plugins[slot]) {
      try { await engine.showBusPluginUi(bus.id, slot); }
      catch (e) { console.warn("showBusPluginUi failed:", e); }
    }
  }, [bus.id, bus.plugins]);

  const addNext = () => {
    const slot = bus.plugins.findIndex((p) => p === null);
    if (slot === -1) return;
    onPickPlugin(bus.id, slot);
  };

  const monoOut = bus.outputMode === "mono";
  const nOuts = Math.max(numActiveOutputs, 2);
  // Mono → single channels; stereo → adjacent pairs. The same shape is shared
  // by the master output picker and the sub-bus "Out N…" route entries.
  const outOptions: Array<{ l: number; r: number; label: string; value: string }> = [];
  if (monoOut) {
    for (let i = 0; i < nOuts; i++)
      outOptions.push({ l: i, r: i, label: `${i + 1}`, value: `${i},${i}` });
  } else {
    for (let i = 0; i + 1 < nOuts; i += 2)
      outOptions.push({ l: i, r: i + 1, label: `${i + 1}/${i + 2}`, value: `${i},${i + 1}` });
    if (outOptions.length === 0) outOptions.push({ l: 0, r: 1, label: "1/2", value: "0,1" });
  }

  // Master sums every track + every sub-bus. Sub-buses sum only their assigned tracks.
  const routedCount = isMaster
    ? tracks.filter((t) => !t.busId || t.busId === bus.id).length
    : tracks.filter((t) => t.busId === bus.id).length;

  const containerClass = isMaster
    ? "flex h-full w-32 shrink-0 flex-col items-stretch gap-1.5 rounded-md border-2 border-red-500/60 bg-red-500/10 p-1.5"
    : "flex h-full w-32 shrink-0 flex-col items-stretch gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-1.5";
  const subtitleClass = isMaster
    ? "text-[10px] uppercase tracking-wider text-red-500/90 font-semibold"
    : "text-[10px] uppercase tracking-wider text-amber-600/80";

  // --- plugin reorder (same shape as TrackStripView) ---
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
  const pluginDragVisualRef = useRef<typeof pluginDrag>(null);
  pluginDragVisualRef.current = pluginDrag;

  const onPillPointerDown = (slot: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
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
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pillEl = el?.closest('[data-plugin-pill="true"]') as HTMLElement | null;
    if (!pillEl || pillEl.dataset.busId !== bus.id) {
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
        let dest = visual.side === "before" ? visual.toSlot : visual.toSlot + 1;
        if (drag.fromSlot < dest) dest -= 1;
        if (dest !== drag.fromSlot) {
          const arr = [...bus.plugins];
          const [moved] = arr.splice(drag.fromSlot, 1);
          arr.splice(dest, 0, moved);
          while (arr.length < MAX_PLUGINS_PER_BUS) arr.push(null);
          patchBus(bus.id, { plugins: arr });
          try { await engine.reorderPluginOnBus(bus.id, drag.fromSlot, dest); }
          catch (err) { console.warn("reorderPluginOnBus failed:", err); }
        }
      }
    } else if (!drag.active) {
      void showSlotUi(slot);
    }
    setPluginDrag(null);
  };

  return (
    <div data-bus-strip="true" data-bus-master={isMaster ? "true" : undefined} className={containerClass}>
      {isMaster ? (
        <div className="px-1 py-0.5 text-xs font-bold tracking-wider text-red-500/90">
          MAIN OUT
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <Input
              value={bus.name}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              className="h-6 min-w-0 flex-1 rounded-none border-0 bg-transparent px-1 text-xs font-semibold shadow-none focus-visible:ring-0"
            />
            <Button size="icon" variant="ghost" className="h-5 w-5" onClick={onRemove} title="Delete bus">
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          <div className={subtitleClass}>
            {`Bus · ${routedCount} track${routedCount === 1 ? "" : "s"}`}
          </div>
        </>
      )}

      {/* Output routing. Master always picks a physical output (pair or single
          channel in mono); sub-buses can choose master OR a physical target.
          Leading M/S chip toggles mono ↔ stereo. */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={toggleOutputMode}
          className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-[9px] font-bold uppercase text-muted-foreground hover:bg-secondary hover:text-foreground"
          title={`Output: ${monoOut ? "mono" : "stereo"} (click to toggle)`}
        >
          {monoOut ? "M" : "S"}
        </button>
        {isMaster ? (
          <Select value={`${bus.outL},${bus.outR}`} onValueChange={changeOutput}>
            <SelectTrigger
              className="h-6 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-[11px] shadow-none focus:ring-0 focus:ring-offset-0 [&>svg]:hidden"
              title={monoOut ? "Output channel" : "Output pair"}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {outOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Select
            value={bus.dest === "out" ? `out:${bus.outL},${bus.outR}` : "bus:__master__"}
            onValueChange={changeRoute}
          >
            <SelectTrigger
              className="h-6 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-[11px] shadow-none focus:ring-0 focus:ring-offset-0 [&>svg]:hidden"
              title="Route to"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bus:__master__">Master</SelectItem>
              {outOptions.map((o) => (
                <SelectItem key={`out:${o.value}`} value={`out:${o.value}`}>{`Out ${o.label}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Plugin chain */}
      <div className="flex flex-1 min-h-[80px] flex-col gap-1">
        <div className="flex-1 min-h-0 overflow-y-auto rounded border border-border/50 bg-background/30 p-1">
          <div className="flex flex-col gap-0.5">
            {bus.plugins.map((p, slot) => {
              if (!p) return null;
              const isDragSrc = pluginDrag?.fromSlot === slot;
              const isDropTgt = pluginDrag?.toSlot === slot;
              return (
                <div
                  key={slot}
                  data-plugin-pill="true"
                  data-bus-id={bus.id}
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

      {/* Stereo IN meters | Stereo OUT meters | Pan + Fader column. Fixed-width
          columns so the dB labels above can't change the meter spacing. */}
      <div className="flex justify-center gap-1.5">
        <div className="flex flex-col items-center" style={{ width: 22 }}>
          <div
            className="flex w-full items-end justify-center overflow-hidden text-[8px] tabular-nums leading-none text-muted-foreground"
            style={{ height: DB_LABEL_HEIGHT }}
          >
            {peakDbText(Math.max(meter.inL, meter.inR))}
          </div>
          <div className="flex gap-px">
            <LevelMeter value={meter.inL} width={5} height={STRIP_METER_HEIGHT} />
            <LevelMeter value={meter.inR} width={5} height={STRIP_METER_HEIGHT} />
          </div>
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
            value={bus.pan}
            min={-1}
            max={1}
            defaultValue={0}
            onChange={setPan}
            size={28}
            label={panText(bus.pan)}
          />
          <div className="flex-1 w-full"><Fader valueDb={bus.gainDb} onChange={setGain} resetTo={0} /></div>
        </div>
      </div>
      <div className="text-center text-[10px] tabular-nums text-muted-foreground">
        {bus.gainDb <= FADER_MIN_DB ? "−∞" : `${bus.gainDb.toFixed(1)} dB`}
      </div>

      {/* Mute */}
      <div className="flex items-center justify-center gap-1">
        <Button
          size="icon"
          variant={bus.mute ? "destructive" : "outline"}
          className="h-6 w-6 text-[10px] font-bold"
          onClick={toggleMute}
          title={bus.mute ? "Unmute" : "Mute"}
        >
          {bus.mute ? <VolumeX className="h-3 w-3" /> : "M"}
        </Button>
      </div>
    </div>
  );
}
