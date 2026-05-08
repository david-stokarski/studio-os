mod engine;

use engine::EngineHandle;
use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager, State};

pub struct AppState {
    pub engine: Arc<EngineHandle>,
}

#[tauri::command]
async fn engine_request(
    state: State<'_, AppState>,
    cmd: String,
    args: Option<Value>,
) -> Result<Value, String> {
    state
        .engine
        .request(&cmd, args.unwrap_or(Value::Null))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_presets() -> Result<Vec<String>, String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let mut out = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn save_preset(name: String, data: Value) -> Result<(), String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe = sanitize(&name);
    let path = dir.join(format!("{}.json", safe));
    let pretty = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_preset(name: String) -> Result<Value, String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    let safe = sanitize(&name);
    let path = dir.join(format!("{}.json", safe));
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(v)
}

#[tauri::command]
fn delete_preset(name: String) -> Result<(), String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    let safe = sanitize(&name);
    let path = dir.join(format!("{}.json", safe));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn preset_dir() -> std::io::Result<std::path::PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir"))?;
    Ok(base.join("AudioInterface").join("presets"))
}

fn prefs_path() -> std::io::Result<std::path::PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir"))?;
    Ok(base.join("AudioInterface").join("preferences.json"))
}

#[tauri::command]
fn load_prefs() -> Result<Value, String> {
    let path = prefs_path().map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(Value::Null);
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_prefs(data: Value) -> Result<(), String> {
    let path = prefs_path().map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let engine = Arc::new(EngineHandle::spawn(handle.clone())?);
            app.manage(AppState { engine });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_request,
            list_presets,
            save_preset,
            load_preset,
            delete_preset,
            load_prefs,
            save_prefs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
