"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import * as engine from "@/lib/engine";

export type PickerTarget =
  | { kind: "track"; trackId: string; slot: number }
  | { kind: "bus"; busId: string; slot: number };

interface Props {
  open: boolean;
  target: PickerTarget | null;
  onClose: () => void;
}

export function PluginPicker({ open, target, onClose }: Props) {
  const {
    plugins, setPlugins, tracks, buses, patchTrack, patchBus,
    blacklistedPlugins, setLastPluginAttempt,
  } = useAppStore();
  const [filter, setFilter] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (open) setFilter("");
  }, [open]);

  const rescan = async () => {
    setScanning(true);
    try {
      const { plugins: list } = await engine.scanPlugins();
      setPlugins(list);
    } catch (e) {
      alert(`Plugin scan failed: ${e}`);
    } finally {
      setScanning(false);
    }
  };

  const filtered = useMemo(() => {
    const f = filter.toLowerCase();
    const blacklist = new Set(blacklistedPlugins);
    return plugins
      .filter((p) => !p.isInstrument)
      .filter((p) => !blacklist.has(p.id))
      .filter((p) =>
        !f ||
        p.name.toLowerCase().includes(f) ||
        p.manufacturer.toLowerCase().includes(f) ||
        p.category.toLowerCase().includes(f)
      );
  }, [plugins, filter, blacklistedPlugins]);

  const targetLabel = (() => {
    if (!target) return "";
    if (target.kind === "track") {
      const t = tracks.find((tt) => tt.id === target.trackId);
      return t ? ` for ${t.name}, slot ${target.slot + 1}` : "";
    }
    const b = buses.find((bb) => bb.id === target.busId);
    return b ? ` for bus ${b.name}, slot ${target.slot + 1}` : "";
  })();

  const pick = async (id: string, name: string) => {
    if (!target) return;
    setBusy(id);
    // Record what we're attempting so the global crash handler can identify
    // the offending plugin if the engine dies during instantiation.
    setLastPluginAttempt({
      kind: target.kind,
      targetId: target.kind === "track" ? target.trackId : target.busId,
      slot: target.slot,
      pluginId: id,
      pluginName: name,
    });
    try {
      if (target.kind === "track") {
        await engine.loadPlugin(target.trackId, target.slot, id);
        const t = tracks.find((tt) => tt.id === target.trackId);
        if (t) {
          const next = [...t.plugins];
          next[target.slot] = { id, name };
          patchTrack(target.trackId, { plugins: next });
        }
      } else {
        await engine.loadPluginOnBus(target.busId, target.slot, id);
        const b = buses.find((bb) => bb.id === target.busId);
        if (b) {
          const next = [...b.plugins];
          next[target.slot] = { id, name };
          patchBus(target.busId, { plugins: next });
        }
      }
      setLastPluginAttempt(null);
      onClose();
    } catch (e) {
      // Engine crashes are handled by the global crash recovery flow which
      // surfaces its own UI; suppress this picker's generic alert for them.
      if (engine.isEngineCrashedError(e)) {
        onClose();
      } else {
        setLastPluginAttempt(null);
        alert(`Failed to load plugin: ${e}`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Choose AU plugin{targetLabel}
          </DialogTitle>
          <DialogDescription>Effects only. Instruments are hidden.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Button size="sm" variant="outline" onClick={rescan} disabled={scanning}>
            {scanning ? "Scanning…" : "Rescan"}
          </Button>
        </div>
        <div className="max-h-[60vh] overflow-auto rounded border">
          {filtered.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">
              {scanning ? "Scanning AU components…" : "No plugins found. Try Rescan."}
            </div>
          )}
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => pick(p.id, p.name)}
              disabled={busy === p.id}
              className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">
                  {p.manufacturer} · {p.category || "Effect"}
                </div>
              </div>
              {busy === p.id && <span className="text-xs">Loading…</span>}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
