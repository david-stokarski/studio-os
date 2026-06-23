"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubTrigger,
  DropdownMenuSubContent, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useAppStore, defaultBus } from "@/lib/store";
import * as engine from "@/lib/engine";
import type { Preset } from "@/lib/types";
import { MASTER_BUS_ID, MAX_PLUGINS_PER_BUS } from "@/lib/types";
import { Plus, Undo2, Redo2, Folder, FolderPlus, ChevronDown, Trash2, Pencil, FolderInput } from "lucide-react";

// Action queued behind the unsaved-changes confirmation dialog. After the user
// resolves the dialog (Save / Don't Save / Cancel) we either run this and clear
// it, or drop it and stay where we are.
type PendingAction =
  | { type: "load"; name: string }
  | { type: "new" };

// Show just the leaf name in the trigger to keep it short. The full path lives
// in the dropdown hierarchy and the dialog labels.
function presetDisplayName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  presets: { name: string; path: string }[];
}

// Bundle of right-click actions threaded through the recursive renderer.
// Keeping them on a single object avoids prop-drilling each callback by name.
interface PresetActions {
  pickPreset: (path: string) => void;
  rename: (kind: "preset" | "folder", path: string) => void;
  remove: (kind: "preset" | "folder", path: string) => void;
  move: (kind: "preset" | "folder", path: string, dest: string) => void;
  destinationsFor: (kind: "preset" | "folder", path: string) => string[];
  // Triggered from the "+ New preset" item at the bottom of a folder submenu.
  // Opens Save-As pre-scoped to this folder so the user just types a name.
  newInFolder: (folder: string) => void;
}

// Right-click menu shown over a preset or folder. The "Move to" submenu lists
// every folder that isn't a cycle / current parent.
function PresetItemContextMenu({
  kind, path, actions, children,
}: {
  kind: "preset" | "folder";
  path: string;
  actions: PresetActions;
  children: React.ReactNode;
}) {
  const dests = actions.destinationsFor(kind, path);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.rename(kind, path)}>
          <Pencil className="h-3.5 w-3.5 opacity-70" />
          <span>Rename</span>
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderInput className="h-3.5 w-3.5 opacity-70" />
            <span>Move to</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {dests.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No valid destinations</div>
            ) : (
              dests.map((d) => (
                <ContextMenuItem key={d || "__root__"} onSelect={() => actions.move(kind, path, d)}>
                  <Folder className="h-3.5 w-3.5 opacity-70" />
                  <span className="min-w-0 truncate">{d || "(Root)"}</span>
                </ContextMenuItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => actions.remove(kind, path)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span>Delete</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Recursive renderer for a folder + its descendants. Right-clicking either the
// folder header or a child preset opens its own ContextMenu with rename / move
// / delete; left-clicking a preset loads it as before.
function renderFolder(
  node: TreeFolder,
  actions: PresetActions,
): React.ReactElement {
  return (
    <DropdownMenuSub key={node.path}>
      <PresetItemContextMenu kind="folder" path={node.path} actions={actions}>
        <DropdownMenuSubTrigger>
          <Folder className="h-3.5 w-3.5 opacity-70" />
          <span className="min-w-0 truncate">{node.name}</span>
        </DropdownMenuSubTrigger>
      </PresetItemContextMenu>
      <DropdownMenuSubContent>
        {node.folders.length === 0 && node.presets.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Empty folder</div>
        ) : (
          <>
            {node.folders.map((f) => renderFolder(f, actions))}
            {node.presets.map((p) => (
              <PresetItemContextMenu key={p.path} kind="preset" path={p.path} actions={actions}>
                <DropdownMenuItem onSelect={() => actions.pickPreset(p.path)}>
                  <span className="min-w-0 truncate">{p.name}</span>
                </DropdownMenuItem>
              </PresetItemContextMenu>
            ))}
          </>
        )}
        {/* Always-visible affordance to save the current workspace as a new
            preset directly into this folder. Sits at the bottom of the list. */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => actions.newInFolder(node.path)}>
          <Plus className="h-3.5 w-3.5 opacity-70" />
          <span>New preset…</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

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

  // Flat list of forward-slash relative preset paths (e.g. "Artists/Rabea/Lead 1")
  // and folder paths discovered by walking the preset directory.
  const [presets, setPresets] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  // Folder the Save-As dialog will write into. "" = root.
  const [saveAsFolder, setSaveAsFolder] = useState<string>("");

  // New-folder dialog state.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // Parent folder selected when creating a new folder. "" = at root.
  const [newFolderParent, setNewFolderParent] = useState<string>("");

  // Rename dialog state, shared by preset + folder rename.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<null | { kind: "preset" | "folder"; path: string }>(null);
  const [renameValue, setRenameValue] = useState("");

  // Delete confirmation modal, used by both preset and folder delete actions so
  // the experience matches the unsaved-changes prompt instead of a native confirm().
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<null | { kind: "preset" | "folder"; path: string }>(null);

  // Confirmation flow state. `pendingAction` is what we should run after the
  // user resolves the dialog; `runAfterSaveAs` carries the same intent across
  // a Save-As dialog (when the user picks "Save" but there's no current name).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const runAfterSaveAsRef = useRef<PendingAction | null>(null);

  const refresh = async () => {
    const r = await engine.listPresets();
    setPresets(r.presets);
    setFolders(r.folders);
  };
  useEffect(() => { void refresh(); }, []);

  // Build a tree from the flat path lists. Each node holds its child folders
  // (keyed by leaf name) and the presets that live directly inside it.
  interface TreeNode {
    name: string;
    path: string;          // full slash path; "" for root
    folders: TreeNode[];
    presets: { name: string; path: string }[];
  }
  const tree = useMemo<TreeNode>(() => {
    const root: TreeNode = { name: "", path: "", folders: [], presets: [] };
    const folderByPath = new Map<string, TreeNode>([["", root]]);
    const ensureFolder = (path: string): TreeNode => {
      const cached = folderByPath.get(path);
      if (cached) return cached;
      const segs = path.split("/");
      const name = segs[segs.length - 1];
      const parentPath = segs.slice(0, -1).join("/");
      const parent = ensureFolder(parentPath);
      const node: TreeNode = { name, path, folders: [], presets: [] };
      parent.folders.push(node);
      folderByPath.set(path, node);
      return node;
    };
    for (const f of folders) ensureFolder(f);
    for (const p of presets) {
      const segs = p.split("/");
      const name = segs[segs.length - 1];
      const parent = ensureFolder(segs.slice(0, -1).join("/"));
      parent.presets.push({ name, path: p });
    }
    // Stable alpha order at each level.
    const sortRec = (n: TreeNode) => {
      n.folders.sort((a, b) => a.name.localeCompare(b.name));
      n.presets.sort((a, b) => a.name.localeCompare(b.name));
      n.folders.forEach(sortRec);
    };
    sortRec(root);
    return root;
  }, [presets, folders]);

  // All folders flattened to a list, used by the Save-As folder picker.
  const folderOptions = useMemo(() => ["", ...folders.slice().sort()], [folders]);

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
    const fullPath = saveAsFolder ? `${saveAsFolder}/${name}` : name;
    const p = await snapshot(fullPath);
    await engine.savePresetFs(p.name, p);
    setCurrent(fullPath);
    setPresetDirty(false);
    setSaveAsName("");
    setSaveAsFolder("");
    setSaveAsOpen(false);
    await refresh();
    // If a Save-As was chained off the unsaved-changes dialog, run the
    // queued action now (e.g. switch to the preset the user wanted to load).
    const queued = runAfterSaveAsRef.current;
    runAfterSaveAsRef.current = null;
    if (queued) await runPending(queued);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const full = newFolderParent ? `${newFolderParent}/${name}` : name;
    try { await engine.createPresetFolder(full); }
    catch (e) { alert(`Could not create folder: ${e}`); return; }
    setNewFolderName("");
    setNewFolderParent("");
    setNewFolderOpen(false);
    await refresh();
  };

  // Opens the styled delete-confirmation modal. The actual delete runs in
  // performDelete() once the user confirms; this keeps the menu UX consistent
  // with the unsaved-changes prompt (same Dialog primitives, same buttons).
  const askDelete = (kind: "preset" | "folder", path: string) => {
    if (!path) return;
    setDeleteTarget({ kind, path });
    setDeleteConfirmOpen(true);
  };

  const performDelete = async () => {
    const target = deleteTarget;
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
    if (!target) return;
    try {
      if (target.kind === "preset") await engine.deletePresetFs(target.path);
      else                          await engine.deletePresetFolder(target.path);
    } catch (e) {
      alert(`Could not delete ${target.kind}: ${e}`);
      return;
    }
    if (target.kind === "preset" && current === target.path) {
      setCurrent("");
      setPresetDirty(false);
    } else if (target.kind === "folder" && (current === target.path || current.startsWith(`${target.path}/`))) {
      setCurrent("");
    }
    await refresh();
  };

  // Save-as scoped to a folder — triggered by the "+ New preset" item at the
  // bottom of each folder submenu. Pre-fills the folder so the user just types
  // a name and hits Enter.
  const openSaveAsInFolder = (folder: string) => {
    setSaveAsFolder(folder);
    setSaveAsName("");
    setSaveAsOpen(true);
  };

  // ----------- right-click context actions: rename / move / delete -----------

  const openRename = (kind: "preset" | "folder", path: string) => {
    setRenameTarget({ kind, path });
    const slash = path.lastIndexOf("/");
    setRenameValue(slash >= 0 ? path.slice(slash + 1) : path);
    setRenameOpen(true);
  };

  const applyRename = async () => {
    const target = renameTarget;
    const next = renameValue.trim();
    if (!target || !next) return;
    const slash = target.path.lastIndexOf("/");
    const parent = slash >= 0 ? target.path.slice(0, slash) : "";
    const newPath = parent ? `${parent}/${next}` : next;
    if (newPath === target.path) { setRenameOpen(false); return; }
    try {
      if (target.kind === "preset") await engine.movePresetFs(target.path, newPath);
      else                          await engine.movePresetFolderFs(target.path, newPath);
    } catch (e) { alert(`Rename failed: ${e}`); return; }
    // Patch `current` so a load reference survives the rename.
    if (target.kind === "preset" && current === target.path) {
      setCurrent(newPath);
    } else if (target.kind === "folder" && (current === target.path || current.startsWith(`${target.path}/`))) {
      setCurrent(current.replace(target.path, newPath));
    }
    setRenameOpen(false);
    setRenameTarget(null);
    setRenameValue("");
    await refresh();
  };

  const moveTo = async (kind: "preset" | "folder", path: string, destFolder: string) => {
    const slash = path.lastIndexOf("/");
    const leaf = slash >= 0 ? path.slice(slash + 1) : path;
    const newPath = destFolder ? `${destFolder}/${leaf}` : leaf;
    if (newPath === path) return;
    try {
      if (kind === "preset") await engine.movePresetFs(path, newPath);
      else                   await engine.movePresetFolderFs(path, newPath);
    } catch (e) { alert(`Move failed: ${e}`); return; }
    if (kind === "preset" && current === path) {
      setCurrent(newPath);
    } else if (kind === "folder" && (current === path || current.startsWith(`${path}/`))) {
      setCurrent(current.replace(path, newPath));
    }
    await refresh();
  };

  // Folders that are valid move-destinations for a given source. Excludes the
  // source's own current parent (no-op), and — for folders — the source itself
  // plus every descendant (would be a cycle).
  const destinationsFor = (kind: "preset" | "folder", path: string): string[] => {
    const slash = path.lastIndexOf("/");
    const currentParent = slash >= 0 ? path.slice(0, slash) : "";
    const opts = ["", ...folders];
    return opts.filter((f) => {
      if (f === currentParent) return false;
      if (kind === "folder") {
        if (f === path) return false;
        if (f.startsWith(`${path}/`)) return false;
      }
      return true;
    });
  };

  // Bundle of context-menu actions handed to renderFolder / PresetItemContextMenu.
  // Built fresh per render so the closures pick up the latest `current` etc.
  // Declared after every handler it references to avoid temporal-dead-zone hits.
  const actions: PresetActions = {
    pickPreset: (p) => tryLoad(p),
    rename: (kind, p) => openRename(kind, p),
    remove: (kind, p) => askDelete(kind, p),
    newInFolder: (folder) => openSaveAsInFolder(folder),
    move: (kind, p, dest) => { void moveTo(kind, p, dest); },
    destinationsFor: (kind, p) => destinationsFor(kind, p),
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
          p.device.sampleRate, p.device.bufferSize, 0
        );
        setDeviceInfo({
          currentInput: p.device.input, currentOutput: p.device.output || p.device.input,
          sampleRate: r.sampleRate, bufferSize: r.bufferSize,
          numActiveInputs: r.numActiveInputs, numActiveOutputs: r.numActiveOutputs,
          inputLatencySamples: r.inputLatencySamples ?? 0,
          outputLatencySamples: r.outputLatencySamples ?? 0,
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
          // Restore output pair on every bus — sub-buses may use it for direct routing.
          await engine.setBusOutput(b.id, b.outL, b.outR);
          if (b.id !== MASTER_BUS_ID && b.dest && b.dest !== "bus") {
            await engine.setBusDest(b.id, b.dest);
          }
          if (b.outputMode && b.outputMode !== "stereo") {
            await engine.setBusOutputMode(b.id, b.outputMode);
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
          if (t.dest && t.dest !== "bus") await engine.setTrackDest(t.id, t.dest);
          if (t.inputMode  && t.inputMode  !== "mono")   await engine.setTrackInputMode(t.id,  t.inputMode);
          if (t.outputMode && t.outputMode !== "stereo") await engine.setTrackOutputMode(t.id, t.outputMode);
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

  // Top-bar "Delete" button — routes through the same styled confirmation
  // modal that the right-click delete uses.
  const remove = () => {
    if (!current) return;
    askDelete("preset", current);
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
        <button
          type="button"
          onClick={() => { setNewFolderParent(""); setNewFolderName(""); setNewFolderOpen(true); }}
          disabled={isLoading}
          className={textBtnClass(!isLoading)}
          title="Create a new preset folder"
        >
          New Folder
        </button>
      </div>

      {/* Bottom row: + new attached to the preset dropdown as a button group.
          The trigger is a DropdownMenu so folders can fan out into submenus. */}
      <div className="inline-flex">
        <Button
          size="icon" variant="outline"
          className="h-7 w-7 rounded-r-none border-r-0"
          onClick={tryNew} disabled={isLoading}
          title="New preset"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={isLoading}
              // Hand-rolled to match SelectTrigger styling so the visual
              // language stays consistent with the rest of the chrome.
              className="flex h-7 w-56 items-center justify-between rounded-md rounded-l-none border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              title="Browse presets"
            >
              {current ? (
                <span className={`min-w-0 truncate ${presetDirty ? "italic" : ""}`}>
                  {presetDisplayName(current)}{presetDirty ? " *" : ""}
                </span>
              ) : presetDirty ? (
                <span className="italic text-muted-foreground">Untitled *</span>
              ) : (
                <span className="text-muted-foreground">No preset</span>
              )}
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[14rem]">
            <DropdownMenuLabel>Presets</DropdownMenuLabel>
            {tree.folders.length === 0 && tree.presets.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No presets saved</div>
            ) : (
              <>
                {tree.folders.map((f) => renderFolder(f, actions))}
                {tree.presets.map((p) => (
                  <PresetItemContextMenu key={p.path} kind="preset" path={p.path} actions={actions}>
                    <DropdownMenuItem
                      onSelect={() => tryLoad(p.path)}
                      className={current === p.path ? "bg-accent/40" : ""}
                    >
                      <span className="min-w-0 truncate">{p.name}</span>
                    </DropdownMenuItem>
                  </PresetItemContextMenu>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
            <label className="text-xs uppercase tracking-wider text-muted-foreground">Folder</label>
            <Select value={saveAsFolder || "__root__"} onValueChange={(v) => setSaveAsFolder(v === "__root__" ? "" : v)}>
              <SelectTrigger className="h-8">
                <SelectValue>
                  {saveAsFolder ? saveAsFolder : <span className="text-muted-foreground">(Root)</span>}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {folderOptions.map((f) => (
                  <SelectItem key={f || "__root__"} value={f || "__root__"}>
                    {f || "(Root)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New folder</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              placeholder="folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); }}
            />
            <label className="text-xs uppercase tracking-wider text-muted-foreground">Parent</label>
            <Select value={newFolderParent || "__root__"} onValueChange={(v) => setNewFolderParent(v === "__root__" ? "" : v)}>
              <SelectTrigger className="h-8">
                <SelectValue>
                  {newFolderParent ? newFolderParent : <span className="text-muted-foreground">(Root)</span>}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {folderOptions.map((f) => (
                  <SelectItem key={f || "__root__"} value={f || "__root__"}>
                    {f || "(Root)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setNewFolderOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={createFolder} disabled={!newFolderName.trim()}>
                <FolderPlus className="mr-1 h-3.5 w-3.5" /> Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Rename {renameTarget?.kind === "folder" ? "folder" : "preset"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {renameTarget && (
              <p className="text-xs text-muted-foreground">
                Current: <span className="font-mono">{renameTarget.path}</span>
              </p>
            )}
            <Input
              autoFocus
              placeholder="new name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void applyRename(); }}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={applyRename} disabled={!renameValue.trim()}>Rename</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Styled confirmation for preset / folder deletion. Mirrors the
          unsaved-changes prompt so users get one cohesive modal language. */}
      <Dialog open={deleteConfirmOpen} onOpenChange={(open) => {
        if (!open) { setDeleteConfirmOpen(false); setDeleteTarget(null); }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Delete {deleteTarget?.kind === "folder" ? "folder" : "preset"}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {deleteTarget?.kind === "folder" ? (
              <>
                Permanently delete <span className="font-mono">{deleteTarget.path}</span> and every preset inside it? This can&apos;t be undone.
              </>
            ) : deleteTarget ? (
              <>
                Permanently delete preset <span className="font-mono">{deleteTarget.path}</span>? This can&apos;t be undone.
              </>
            ) : null}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => {
              setDeleteConfirmOpen(false); setDeleteTarget(null);
            }}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={performDelete}>Delete</Button>
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
