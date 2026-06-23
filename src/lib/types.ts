export interface AudioDevicesInfo {
  inputs: string[];
  outputs: string[];
  currentInput: string;
  currentOutput: string;
  sampleRate: number;
  bufferSize: number;
  numActiveInputs: number;
  numActiveOutputs: number;
  inputLatencySamples: number;
  outputLatencySamples: number;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  manufacturer: string;
  category: string;
  format: string;
  isInstrument: boolean;
}

export interface PluginSlot {
  id: string;
  name: string;
  bypassed?: boolean;
  state?: string; // base64 plugin state, populated when saving presets
}

// Engine has fixed-size slot arrays so we still have a hard ceiling, but the
// UI no longer surfaces a cap to the user — these are large enough that
// running out is effectively impossible in practice.
export const MAX_PLUGINS_PER_TRACK = 32;
export const MAX_PLUGINS_PER_BUS = 32;

// Stable id for the global master output bus. The engine auto-creates this bus
// at startup; the frontend treats it as a special, undeletable bus pinned to
// the right of the mixer.
export const MASTER_BUS_ID = "master";

// Routing destination for a track or sub-bus.
//   "bus" — route through busId (for tracks) or sum into master (for sub-buses).
//   "out" — write directly to the physical output pair (outL/outR), bypassing
//           any bus / master plugin chain.
// Master is implicitly always "out" regardless of its stored value.
export type RouteDest = "bus" | "out";
// Per-strip channel mode. "mono" = single channel; "stereo" = adjacent pair.
// Track inputs: mono reads inputCh, stereo reads inputCh + inputCh+1.
// Track/bus outputs: mono folds the strip's stereo result and writes to outL only.
export type ChannelMode = "mono" | "stereo";

export interface Track {
  id: string;
  name: string;
  inputCh: number;
  outL: number;
  outR: number;
  gainDb: number;
  pan: number;
  mute: boolean;
  monitor: boolean;
  solo: boolean;
  plugins: (PluginSlot | null)[];
  // Empty string (or undefined) routes to master output. Otherwise the bus id this track feeds.
  busId?: string;
  // Routing destination (default "bus"). When "out", outL/outR are the
  // physical output pair the track writes to directly.
  dest?: RouteDest;
  // Channel modes (defaults: mono in, stereo out).
  inputMode?: ChannelMode;
  outputMode?: ChannelMode;
}

export interface Bus {
  id: string;
  name: string;
  outL: number;
  outR: number;
  gainDb: number;
  pan: number;
  mute: boolean;
  plugins: (PluginSlot | null)[];
  // Routing destination (default "bus" for sub-buses, "out" for master).
  dest?: RouteDest;
  // Output mode (default "stereo"). When "mono" the bus folds L+R into outL.
  outputMode?: ChannelMode;
}

export interface MeterFrame {
  tracks: { id: string; in: number; outL: number; outR: number; monitoring: boolean }[];
  buses?: { id: string; inL: number; inR: number; outL: number; outR: number }[];
  // True round-trip latency in samples (device ADC + plugin chain + DAC) for
  // the worst-case route across tracks. Updates live as plugins change.
  roundTripLatencySamples?: number;
  sampleRate?: number;
}

export interface Preset {
  name: string;
  device: {
    input: string;
    output: string;
    sampleRate: number;
    bufferSize: number;
  };
  tracks: Track[];
  buses?: Bus[];
}
