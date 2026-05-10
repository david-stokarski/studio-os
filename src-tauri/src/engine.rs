use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

/// Each spawned child gets a monotonically-increasing generation number.
/// Reader threads only forward events for the generation they were spawned for,
/// so a stale reader from a dead child can never resurrect itself in pending
/// after a restart.
type Generation = u64;

pub struct EngineHandle {
    inner: Mutex<EngineInner>,
    pending: PendingMap,
    /// Bumped on every (re)spawn. Reader threads carry their own gen and
    /// dispatch only when it matches `current_gen`.
    current_gen: Arc<AtomicU64>,
    app: AppHandle,
}

struct EngineInner {
    stdin: ChildStdin,
    child: Child,
}

impl EngineHandle {
    pub fn spawn(app: AppHandle) -> Result<Self, String> {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let current_gen = Arc::new(AtomicU64::new(0));
        let inner = Self::spawn_child(&app, pending.clone(), current_gen.clone())?;
        Ok(Self { inner: Mutex::new(inner), pending, current_gen, app })
    }

    /// Spawn the engine binary and wire up stdout/stderr readers. The reader
    /// threads exit cleanly when the child's stdout/stderr close, which happens
    /// automatically when the child dies — no explicit teardown required.
    fn spawn_child(
        app: &AppHandle,
        pending: PendingMap,
        current_gen: Arc<AtomicU64>,
    ) -> Result<EngineInner, String> {
        let bin = locate_engine_binary(app)?;
        let mut child = Command::new(&bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn audio_engine ({}): {}", bin.display(), e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        // Bump the generation; existing reader threads (from a prior incarnation)
        // are now considered stale and will be ignored if any of their lines are
        // still in flight.
        let my_gen: Generation = current_gen.fetch_add(1, Ordering::SeqCst) + 1;

        // stdout reader thread.
        {
            let pending = pending.clone();
            let app = app.clone();
            let current_gen = current_gen.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if current_gen.load(Ordering::SeqCst) != my_gen {
                        continue; // stale generation
                    }
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(line) else {
                        let _ = app.emit("engine-log", json!({ "level": "warn", "msg": format!("non-JSON: {}", line) }));
                        continue;
                    };
                    if let Some(event) = v.get("event").and_then(|s| s.as_str()) {
                        let payload = v.get("data").cloned().unwrap_or(Value::Null);
                        let _ = app.emit(&format!("engine:{}", event), payload);
                        continue;
                    }
                    if let Some(id) = v.get("id").and_then(|s| s.as_str()) {
                        if let Some(tx) = pending.lock().unwrap().remove(id) {
                            if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
                                let _ = tx.send(Ok(v.get("result").cloned().unwrap_or(Value::Null)));
                            } else {
                                let err = v.get("error").and_then(|s| s.as_str()).unwrap_or("unknown error").to_string();
                                let _ = tx.send(Err(err));
                            }
                        }
                    }
                }
            });
        }

        // stderr forwarder.
        {
            let app = app.clone();
            let current_gen = current_gen.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if current_gen.load(Ordering::SeqCst) != my_gen {
                        continue;
                    }
                    let _ = app.emit("engine-stderr", json!({ "line": line }));
                }
            });
        }

        Ok(EngineInner { stdin, child })
    }

    /// Kill the current engine, spawn a fresh one, fail any pending requests.
    /// The frontend listens for `engine:ready` from the new engine and replays
    /// state on top.
    pub fn restart(&self) -> Result<(), String> {
        // Spawn the new child first so any failure leaves the old one alive.
        let new_inner = Self::spawn_child(&self.app, self.pending.clone(), self.current_gen.clone())?;

        let mut inner = self.inner.lock().map_err(|_| "engine inner poisoned".to_string())?;
        // Kill the old child (it may already be dead, hence the ignored result).
        let _ = inner.child.kill();
        let _ = inner.child.wait();
        *inner = new_inner;

        // Drop any in-flight requests so callers don't hang. They get an error
        // they can treat as "engine restarted, will retry via replay".
        let mut pending = self.pending.lock().map_err(|_| "pending poisoned".to_string())?;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("engine_restarted".into()));
        }
        Ok(())
    }

    pub async fn request(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let id = Uuid::new_v4().to_string();
        let payload = json!({ "id": id, "cmd": cmd, "args": args });
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        {
            let mut inner = self.inner.lock().map_err(|_| "engine inner poisoned".to_string())?;
            let write_res = inner
                .stdin
                .write_all(line.as_bytes())
                .and_then(|_| inner.stdin.write_all(b"\n"))
                .and_then(|_| inner.stdin.flush());
            if let Err(e) = write_res {
                self.pending.lock().unwrap().remove(&id);
                if e.kind() == std::io::ErrorKind::BrokenPipe {
                    // The engine is dead. Notify the frontend so it can run the
                    // restart-and-replay flow; return a recognizable error so
                    // the immediate caller (e.g. the plugin picker) can swallow
                    // its own user-facing alert.
                    let _ = self.app.emit("engine:crashed", json!({ "cmd": cmd }));
                    return Err("engine_crashed".into());
                }
                return Err(e.to_string());
            }
        }

        // AU plugin scan can legitimately take minutes (some validators are slow).
        let timeout_secs = if cmd == "scanPlugins" { 600 } else { 30 };
        match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("engine response channel closed".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("engine request timed out".into())
            }
        }
    }
}

/// Find the engine binary. In dev: `<workspace>/engine/build/bin/AudioEngine.app/Contents/MacOS/AudioEngine`
/// or the simpler console-app output `<workspace>/engine/build/bin/AudioEngine`.
/// In bundled releases: look beside the .app under Resources/binaries.
fn locate_engine_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(res) = app.path().resource_dir() {
        for c in [
            res.join("binaries/audio_engine"),
            res.join("binaries/AudioEngine.app/Contents/MacOS/AudioEngine"),
            res.join("binaries/AudioEngine"),
        ] {
            if c.exists() {
                return Ok(c);
            }
        }
    }

    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    for root in [cwd.clone(), cwd.join(".."), cwd.join("../..")] {
        for c in [
            root.join("engine/build/bin/AudioEngine.app/Contents/MacOS/AudioEngine"),
            root.join("engine/build/bin/AudioEngine"),
            root.join("engine/build/AudioEngine_artefacts/Debug/AudioEngine.app/Contents/MacOS/AudioEngine"),
            root.join("engine/build/AudioEngine_artefacts/Release/AudioEngine.app/Contents/MacOS/AudioEngine"),
        ] {
            if c.exists() {
                return Ok(c);
            }
        }
    }
    Err("audio_engine binary not found. Build it via: (cd engine && cmake -B build && cmake --build build --config Release)".into())
}

#[allow(dead_code)]
static _LAZY: Lazy<()> = Lazy::new(|| ());
