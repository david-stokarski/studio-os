use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

pub struct EngineHandle {
    stdin: Mutex<ChildStdin>,
    pending: PendingMap,
    _child: Mutex<Child>,
}

impl EngineHandle {
    pub fn spawn(app: AppHandle) -> Result<Self, String> {
        let bin = locate_engine_binary(&app)?;
        let mut child = Command::new(&bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn audio_engine ({}): {}", bin.display(), e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        // stdout reader: parse JSON lines, dispatch to pending or emit events.
        {
            let pending = pending.clone();
            let app = app.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(line) else {
                        let _ = app.emit("engine-log", json!({ "level": "warn", "msg": format!("non-JSON: {}", line) }));
                        continue;
                    };
                    if let Some(event) = v.get("event").and_then(|s| s.as_str()) {
                        // Forward as Tauri event with the same name.
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
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let _ = app.emit("engine-stderr", json!({ "line": line }));
                }
            });
        }

        Ok(Self {
            stdin: Mutex::new(stdin),
            pending,
            _child: Mutex::new(child),
        })
    }

    pub async fn request(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let id = Uuid::new_v4().to_string();
        let payload = json!({ "id": id, "cmd": cmd, "args": args });
        let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        {
            let mut stdin = self.stdin.lock().map_err(|_| "stdin poisoned")?;
            let write_res = stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush());
            if let Err(e) = write_res {
                self.pending.lock().unwrap().remove(&id);
                if e.kind() == std::io::ErrorKind::BrokenPipe {
                    return Err("Audio engine crashed (broken pipe). Please restart the app.".into());
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
    // Bundled: Tauri places resources at <app>/Contents/Resources/.
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

    // Dev: search project tree.
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

// keep clippy happy if unused.
#[allow(dead_code)]
static _LAZY: Lazy<()> = Lazy::new(|| ());
