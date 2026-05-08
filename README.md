# Audio Interface

A real-time multi-channel audio mixer and Audio Unit (AU) plugin host for macOS. Lets you select an input device, monitor each input channel, apply one AU effect per channel, control gain/pan/mute/monitor per channel, and save/recall presets.

**Architecture (Option A): Tauri (Rust shell) + Next.js + shadcn UI + JUCE C++ audio engine sidecar.**
The audio engine runs as a separate native process. The UI talks to it over stdin/stdout (newline-delimited JSON) for control only — **audio never crosses the process boundary**, so there is no IPC overhead in the audio path. Latency is determined entirely by the buffer size you choose (e.g. 64 samples @ 48 kHz = ~1.3 ms).

```
┌────────────────────────────────┐        stdin/stdout (JSON-RPC)       ┌──────────────────────────────────────┐
│ Next.js + shadcn UI (WebView)  │  ◄──────────────────────────────►  │ JUCE C++ engine (CoreAudio + AU host) │
│        │                       │       (control only — never audio)   │   real-time audio thread              │
│        ▼                       │                                       │   AU plugin GUI windows (native)      │
│ Tauri Rust shell (process mgr) │                                       │                                       │
└────────────────────────────────┘                                       └──────────────────────────────────────┘
```

---

## Prerequisites (one-time setup)

1. **Xcode Command Line Tools** — already installed if `xcode-select -p` prints a path.
2. **CMake ≥ 3.22** — `brew install cmake`
3. **Node ≥ 18** + npm — already present.
4. **Rust** (you don't have this yet):
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source "$HOME/.cargo/env"
   ```

> Note: AU hosting requires the `AudioUnit` and `AudioToolbox` frameworks. These ship with the Command Line Tools and macOS itself; you do **not** need full Xcode.

---

## Build & run (development)

The project has three components built in two steps.

### Step 1 — build the JUCE audio engine

```sh
cd engine
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
```

This downloads JUCE 8 via CMake's `FetchContent` (first build is ~5 min; subsequent builds are fast). The output binary is `engine/build/AudioEngine_artefacts/Release/AudioEngine.app/Contents/MacOS/AudioEngine` (or similar path in `engine/build/bin/`). The Rust shell auto-locates it.

### Step 2 — install JS deps and run

```sh
cd ..   # back to project root
npm install
npm run dev
```

This starts Next.js on `http://localhost:3000` and opens a Tauri window pointing at it. The Rust shell spawns the JUCE engine binary as a sidecar.

The first time you run it, macOS will prompt for **microphone permission** for the Tauri app — accept it. AU plugins will be scanned the first time you open the plugin picker.

---

## Build a standalone `.app` (production)

```sh
# 1. build the engine in Release.
cd engine && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release -j && cd ..

# 2. copy the engine binary into Tauri's resource folder so it gets bundled.
mkdir -p src-tauri/binaries
cp engine/build/AudioEngine_artefacts/Release/AudioEngine.app/Contents/MacOS/AudioEngine src-tauri/binaries/audio_engine

# 3. build the bundle.
npm run build
```

The signed `.app` and `.dmg` will be in `src-tauri/target/release/bundle/`.

> **Code signing / notarization:** for personal use on your own Mac, an unsigned build is fine — you may need to right-click → Open the first time. For distribution, set up an Apple Developer ID and configure `bundle.macOS.signingIdentity` in `tauri.conf.json`.

> **App icons:** Tauri requires icon files at `src-tauri/icons/`. For development you can comment out the `icon` array in `tauri.conf.json`, or generate icons with `npm run tauri icon path/to/source.png`.

---

## Features in this v1

- Multi-channel input device selection (Apollo, Scarlett, Babyface, MOTU, etc.)
- Per-channel: gain (-60 to +12 dB with smoothed ramps), pan (equal-power), mute, monitor on/off
- Real-time peak meters (input + post-fader output) at ~30 Hz
- One AU effect plugin slot per input channel
- Native AU plugin GUI windows (open by clicking the plugin name on the strip)
- AU plugin scan + cached list
- Save / load / delete JSON presets at `~/Library/Application Support/AudioInterface/presets/`
- Buffer sizes from 32 to 1024 samples, sample rates 44.1 / 48 / 88.2 / 96 kHz

---

## Latency notes

- Total monitoring latency = device input latency + buffer size + AU plugin latency + device output latency.
- At 48 kHz, buffer 64: round-trip is typically ~3–5 ms on a USB/TB interface.
- The audio engine processes everything on the CoreAudio real-time thread; there is no JS / Rust / IPC in the audio path.
- Gain and pan are smoothed sample-by-sample to avoid zipper noise.

---

## Project layout

```
audio-interface/
├── engine/                    JUCE C++ audio engine (sidecar process)
│   ├── CMakeLists.txt
│   └── src/
│       ├── main.cpp           process entry
│       ├── AudioEngine.*      CoreAudio device + per-channel routing
│       ├── ChannelStrip.*     real-time gain / pan / plugin slot / meters
│       ├── PluginHost.*       AU scan + instantiate
│       └── IpcServer.*        stdin/stdout JSON protocol + meter timer
├── src-tauri/                 Tauri Rust shell
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs            entry
│       ├── lib.rs             commands + preset file I/O
│       └── engine.rs          spawn + bridge JUCE sidecar
└── src/                       Next.js + shadcn UI
    ├── app/                   layout, page, globals.css
    ├── lib/                   types, store, engine wrappers
    └── components/            mixer, channel-strip, device-selector,
                               plugin-picker, preset-manager, level-meter, ui/
```

---

## What's NOT in v1 (intentionally out of scope)

- Recording, playback, file export
- Multiple plugin slots per channel (single slot only)
- Plugin parameter automation
- VST3 (AU only — re-enable in `engine/CMakeLists.txt` by setting `JUCE_PLUGINHOST_VST3=1`, and accept the JUCE/Steinberg VST3 SDK license)
- Multiple output buses (single stereo bus to outputs 1/2 of the selected output device)
- Aux sends, EQ on the channel itself (use plugins for those)
- Sidechaining

---

## Troubleshooting

- **"audio_engine binary not found"** — you didn't build the engine yet, or it's in an unexpected path. Build with the Step 1 commands above. The Rust shell searches several common paths under `engine/build/`.
- **No input devices listed** — macOS hasn't granted microphone permission. Open System Settings → Privacy & Security → Microphone, enable for the Tauri app.
- **Plugin scan finds nothing** — your AUs may be sandboxed or use a non-standard component type. Try `auval -a` in Terminal to list all valid AUs on the system.
- **Crackling / dropouts** — buffer size is too small for the plugin you loaded. Increase to 256 or 512.
- **Plugin window doesn't open** — some plugins require a specific bus arrangement; this v1 hard-codes mono-in / stereo-out, which most effects accept. Look for errors in the dev console (View → Toggle Developer Tools).

---

## What you'll likely hit on the first build

This is a non-trivial native build. Expect to iterate on:

- JUCE 8 API drift on AudioIODeviceCallback signatures (handled, but check if JUCE has bumped to 8.1+).
- Rust ↔ Tauri v2 plugin permission strings — may need to tweak `src-tauri/capabilities/default.json`.
- AU scan returning duplicates or skipping certain validators — JUCE's `KnownPluginList` is mostly fine but occasionally needs a deadMansPedalFile.
- Any AU that crashes during instantiation will take down the engine process; the Rust shell will report it as a stderr line. Restart the app.
