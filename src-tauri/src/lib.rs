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
fn restart_engine(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.restart()
}

// Presets are stored as JSON files under a possibly-nested folder structure.
// The `name` arg is a forward-slash relative path like "Artists/Rabea/Lead 1".
// Each path segment is sanitized; segments resolve to a directory (for folders)
// or a `<segment>.json` file (for the leaf preset). Returned listings use the
// same forward-slash convention.

fn split_segments(name: &str) -> Vec<String> {
    name.split('/')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(sanitize)
        .filter(|s| !s.is_empty())
        .collect()
}

// Resolve a preset path under base_dir → (parent_dir, file_path_with_json_extension).
fn resolve_preset_path(base: &std::path::Path, name: &str) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let segs = split_segments(name);
    if segs.is_empty() { return None; }
    let mut parent = base.to_path_buf();
    for s in &segs[..segs.len() - 1] {
        parent = parent.join(s);
    }
    let file = parent.join(format!("{}.json", segs.last().unwrap()));
    Some((parent, file))
}

fn resolve_folder_path(base: &std::path::Path, path: &str) -> std::path::PathBuf {
    let mut p = base.to_path_buf();
    for s in split_segments(path) {
        p = p.join(s);
    }
    p
}

fn walk_presets(base: &std::path::Path, dir: &std::path::Path, prefix: &str, out: &mut Vec<String>, folders: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        let name = match p.file_name().and_then(|s| s.to_str()) { Some(n) => n.to_string(), None => continue };
        if p.is_dir() {
            let folder_path = if prefix.is_empty() { name.clone() } else { format!("{}/{}", prefix, name) };
            folders.push(folder_path.clone());
            walk_presets(base, &p, &folder_path, out, folders)?;
        } else if p.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                let preset_path = if prefix.is_empty() { stem.to_string() } else { format!("{}/{}", prefix, stem) };
                out.push(preset_path);
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct PresetListing {
    presets: Vec<String>,
    folders: Vec<String>,
}

#[tauri::command]
fn list_presets() -> Result<PresetListing, String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let mut presets = vec![];
    let mut folders = vec![];
    walk_presets(&dir, &dir, "", &mut presets, &mut folders).map_err(|e| e.to_string())?;
    presets.sort();
    folders.sort();
    Ok(PresetListing { presets, folders })
}

#[tauri::command]
fn save_preset(name: String, data: Value) -> Result<(), String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (parent, path) = resolve_preset_path(&dir, &name).ok_or_else(|| "empty preset name".to_string())?;
    if !parent.starts_with(&dir) { return Err("invalid path".into()); }
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_preset(name: String) -> Result<Value, String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    let (_parent, path) = resolve_preset_path(&dir, &name).ok_or_else(|| "empty preset name".to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_preset(name: String) -> Result<(), String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    let (_parent, path) = resolve_preset_path(&dir, &name).ok_or_else(|| "empty preset name".to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn create_preset_folder(path: String) -> Result<(), String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let folder = resolve_folder_path(&dir, &path);
    if !folder.starts_with(&dir) { return Err("invalid path".into()); }
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_preset_folder(path: String) -> Result<(), String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    let folder = resolve_folder_path(&dir, &path);
    // Defensive: never wipe the root preset directory itself.
    if folder == dir || !folder.starts_with(&dir) || split_segments(&path).is_empty() {
        return Err("invalid path".into());
    }
    if folder.exists() {
        std::fs::remove_dir_all(&folder).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn move_preset(from: String, to: String) -> Result<(), String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    let (_, src) = resolve_preset_path(&dir, &from).ok_or_else(|| "empty source".to_string())?;
    let (dst_parent, dst) = resolve_preset_path(&dir, &to).ok_or_else(|| "empty dest".to_string())?;
    if !dst_parent.starts_with(&dir) { return Err("invalid dest".into()); }
    if dst.exists() { return Err("a preset already exists at the destination".into()); }
    std::fs::create_dir_all(&dst_parent).map_err(|e| e.to_string())?;
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn move_preset_folder(from: String, to: String) -> Result<(), String> {
    let dir = preset_dir().map_err(|e| e.to_string())?;
    if split_segments(&from).is_empty() || split_segments(&to).is_empty() {
        return Err("invalid path".into());
    }
    let src = resolve_folder_path(&dir, &from);
    let dst = resolve_folder_path(&dir, &to);
    if !src.starts_with(&dir) || !dst.starts_with(&dir) {
        return Err("invalid path".into());
    }
    if dst.exists() { return Err("a folder already exists at the destination".into()); }
    // Refuse moving a folder into itself or a descendant — that would create a
    // cycle and fs::rename would fail confusingly.
    if dst.starts_with(&src) { return Err("cannot move a folder into itself".into()); }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
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
            restart_engine,
            list_presets,
            save_preset,
            load_preset,
            delete_preset,
            create_preset_folder,
            delete_preset_folder,
            move_preset,
            move_preset_folder,
            load_prefs,
            save_prefs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
