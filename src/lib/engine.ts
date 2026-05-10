import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AudioDevicesInfo, PluginDescriptor, MeterFrame, Preset } from "./types";

export async function engineRequest<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  return await invoke<T>("engine_request", { cmd, args });
}

// ---------- device ----------
export const listDevices = () => engineRequest<AudioDevicesInfo>("listAudioDevices");

export const setDevice = (input: string, output: string, sampleRate: number, bufferSize: number, numInputChannels: number) =>
  engineRequest<{ sampleRate: number; bufferSize: number; numActiveInputs: number; numActiveOutputs: number }>(
    "setAudioDevice",
    { input, output, sampleRate, bufferSize, numInputChannels }
  );

// ---------- tracks ----------
export const addTrack = (id: string, name: string, inputCh: number, outL: number, outR: number) =>
  engineRequest("addTrack", { id, name, inputCh, outL, outR });

export const removeTrack    = (id: string) => engineRequest("removeTrack",   { id });
export const setTrackInput  = (id: string, inputCh: number) => engineRequest("setTrackInput",  { id, inputCh });
export const setTrackOutput = (id: string, outL: number, outR: number) => engineRequest("setTrackOutput", { id, outL, outR });
export const setTrackBus    = (id: string, busId: string)   => engineRequest("setTrackBus",    { id, busId });
export const setTrackGain   = (id: string, gainDb: number)  => engineRequest("setTrackGain",   { id, gainDb });
export const setTrackPan    = (id: string, pan: number)     => engineRequest("setTrackPan",    { id, pan });
export const setTrackMute   = (id: string, mute: boolean)   => engineRequest("setTrackMute",   { id, mute });
export const setTrackMonitor= (id: string, monitor: boolean) => engineRequest("setTrackMonitor",{ id, monitor });
export const setTrackSolo   = (id: string, solo: boolean)    => engineRequest("setTrackSolo",   { id, solo });

// ---------- buses ----------
export const addBus       = (id: string, name: string, outL: number, outR: number) =>
  engineRequest("addBus", { id, name, outL, outR });
export const removeBus    = (id: string) => engineRequest("removeBus", { id });
export const setBusOutput = (id: string, outL: number, outR: number) => engineRequest("setBusOutput", { id, outL, outR });
export const setBusGain   = (id: string, gainDb: number) => engineRequest("setBusGain", { id, gainDb });
export const setBusPan    = (id: string, pan: number)    => engineRequest("setBusPan",  { id, pan });
export const setBusMute   = (id: string, mute: boolean)  => engineRequest("setBusMute", { id, mute });

export const loadPluginOnBus    = (id: string, slot: number, pluginId: string, state?: string) =>
  engineRequest("loadPluginOnBus", { id, slot, pluginId, state: state ?? "" });
export const removePluginOnBus  = (id: string, slot: number) => engineRequest("removePluginOnBus", { id, slot });
export const setBusPluginBypassed = (id: string, slot: number, bypassed: boolean) =>
  engineRequest("setBusPluginBypassed", { id, slot, bypassed });
export const reorderPluginOnBus   = (id: string, fromSlot: number, toSlot: number) =>
  engineRequest("reorderPluginOnBus", { id, fromSlot, toSlot });
export const showBusPluginUi    = (id: string, slot: number) => engineRequest<boolean>("showBusPluginEditor", { id, slot });
export const hideBusPluginUi    = (id: string, slot: number) => engineRequest("hideBusPluginEditor", { id, slot });
export const getBusPluginState  = (id: string, slot: number) => engineRequest<string>("getBusPluginState", { id, slot });

// ---------- plugins ----------
export const scanPlugins   = () => engineRequest<{ count: number; plugins: PluginDescriptor[] }>("scanPlugins");
export const listPlugins   = () => engineRequest<PluginDescriptor[]>("listPlugins");
export const loadPlugin    = (id: string, slot: number, pluginId: string, state?: string) =>
  engineRequest("loadPlugin", { id, slot, pluginId, state: state ?? "" });
export const getPluginState = (id: string, slot: number) => engineRequest<string>("getPluginState", { id, slot });
export const removePlugin  = (id: string, slot: number)                   => engineRequest("removePlugin",  { id, slot });
export const setPluginBypassed = (id: string, slot: number, bypassed: boolean) =>
  engineRequest("setPluginBypassed", { id, slot, bypassed });
export const reorderPlugin     = (id: string, fromSlot: number, toSlot: number) =>
  engineRequest("reorderPlugin", { id, fromSlot, toSlot });
export const showPluginUi  = (id: string, slot: number)                   => engineRequest<boolean>("showPluginEditor", { id, slot });
export const hidePluginUi  = (id: string, slot: number)                   => engineRequest("hidePluginEditor", { id, slot });

// ---------- events ----------
export const onMeters = (cb: (m: MeterFrame) => void): Promise<UnlistenFn> =>
  listen<MeterFrame>("engine:meters", e => cb(e.payload));

export const onReady = (cb: () => void): Promise<UnlistenFn> =>
  listen("engine:ready", () => cb());

export const onLog = (cb: (line: string) => void): Promise<UnlistenFn> =>
  listen<{ line: string }>("engine-stderr", e => cb(e.payload.line));

export interface ScanProgress { current: number; total: number; name: string }
export const onScanProgress = (cb: (p: ScanProgress) => void): Promise<UnlistenFn> =>
  listen<ScanProgress>("engine:scanProgress", e => cb(e.payload));

// Fires when the Tauri shell detects the audio engine subprocess has died
// (e.g. a plugin segfaulted during instantiation). The frontend's crash
// handler kicks off the restart-and-replay flow.
export const onEngineCrashed = (cb: (info: { cmd?: string }) => void): Promise<UnlistenFn> =>
  listen<{ cmd?: string }>("engine:crashed", (e) => cb(e.payload ?? {}));

// Sentinel returned by engine_request when the IPC pipe is broken.
export const ENGINE_CRASHED_ERROR = "engine_crashed";
export const isEngineCrashedError = (e: unknown) =>
  typeof e === "string" ? e.includes(ENGINE_CRASHED_ERROR) : (e instanceof Error && e.message.includes(ENGINE_CRASHED_ERROR));

export const restartEngine = () => invoke<void>("restart_engine");

// ---------- presets ----------
export const listPresets   = () => invoke<string[]>("list_presets");
export const savePresetFs  = (name: string, data: Preset) => invoke("save_preset", { name, data });
export const loadPresetFs  = (name: string) => invoke<Preset>("load_preset", { name });
export const deletePresetFs = (name: string) => invoke("delete_preset", { name });

// ---------- user preferences ----------
export interface UserPrefs {
  input?: string;
  output?: string;
  sampleRate?: number;
  bufferSize?: number;
}
export const loadPrefs = () => invoke<UserPrefs | null>("load_prefs");
export const savePrefs = (data: UserPrefs) => invoke("save_prefs", { data });
