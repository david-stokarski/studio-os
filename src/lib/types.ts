export interface AudioDevicesInfo {
  inputs: string[];
  outputs: string[];
  currentInput: string;
  currentOutput: string;
  sampleRate: number;
  bufferSize: number;
  numActiveInputs: number;
  numActiveOutputs: number;
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
}

export interface MeterFrame {
  tracks: { id: string; in: number; outL: number; outR: number; monitoring: boolean }[];
  buses?: { id: string; inL: number; inR: number; outL: number; outR: number }[];
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
