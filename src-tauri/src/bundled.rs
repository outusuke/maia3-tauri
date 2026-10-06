use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "android")]
const APK_MODEL_DIR: &str = "assets/models/";

#[cfg(target_os = "android")]
fn apk_path() -> Option<PathBuf> {
    let cmdline = std::fs::read_to_string("/proc/self/cmdline").ok()?;
    let package = cmdline.split(['\0', ':']).next()?;
    let marker = format!("/{package}-");
    // the WebView's own APK is mapped too, so match on our package dir
    std::fs::read_to_string("/proc/self/maps")
        .ok()?
        .lines()
        .filter_map(|l| l.split_whitespace().nth(5))
        .find(|p| p.ends_with(".apk") && p.contains(&marker))
        .map(PathBuf::from)
}

#[cfg(target_os = "android")]
fn model_ids(_app: &AppHandle) -> Vec<String> {
    let Some(file) = apk_path().and_then(|p| std::fs::File::open(p).ok()) else {
        return Vec::new();
    };
    let Ok(mut zip) = zip::ZipArchive::new(file) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index_raw(i) else { continue };
        if let Some(id) = entry.name().strip_prefix(APK_MODEL_DIR).and_then(|n| n.strip_suffix(".onnx")) {
            ids.push(id.to_string());
        }
    }
    ids
}

// ORT can't read from inside the APK, so the model is copied out once and loaded by path
#[cfg(target_os = "android")]
fn model_path(app: &AppHandle, model: &str) -> Result<PathBuf, String> {
    let apk = apk_path().ok_or("couldn't locate the app's APK in /proc/self/maps")?;
    let file = std::fs::File::open(&apk).map_err(|e| format!("could not open {}: {e}", apk.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entry = zip
        .by_name(&format!("{APK_MODEL_DIR}{model}.onnx"))
        .map_err(|_| format!("{model} isn't bundled in this build"))?;

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("bundled-models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{model}.onnx"));
    if path.metadata().map(|m| m.len() == entry.size()).unwrap_or(false) {
        return Ok(path);
    }

    let tmp = path.with_extension("onnx.part");
    let mut out = std::fs::File::create(&tmp).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    drop(out);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

// MAIA3_RESOURCES_DIR is for the Flatpak build, which doesn't go through the Tauri bundler
#[cfg(not(target_os = "android"))]
fn resource_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("MAIA3_RESOURCES_DIR") {
        return Ok(PathBuf::from(dir).join(sub));
    }
    app.path()
        .resolve(format!("resources/{sub}"), tauri::path::BaseDirectory::Resource)
        .map(strip_verbatim_prefix)
        .map_err(|e| format!("couldn't resolve the resource dir: {e}"))
}

// Tauri can return \\?\C:\... on Windows, which LoadLibrary and ORT choke on
#[cfg(not(target_os = "android"))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(not(target_os = "android"))]
fn model_ids(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = resource_dir(app, "models") else {
        return Vec::new();
    };
    let mut ids: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("onnx"))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    ids.sort();
    ids
}

#[cfg(not(target_os = "android"))]
fn model_path(app: &AppHandle, model: &str) -> Result<PathBuf, String> {
    let path = resource_dir(app, "models")?.join(format!("{model}.onnx"));
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("{model} isn't bundled in this build"))
    }
}

// STOCKFISH_PATH is handy for pointing at a system install while developing
#[cfg(not(target_os = "android"))]
pub fn stockfish_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("STOCKFISH_PATH") {
        return Ok(PathBuf::from(path));
    }
    let name = if cfg!(windows) { "stockfish.exe" } else { "stockfish" };
    let path = resource_dir(app, "stockfish")?.join(name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("{name} isn't bundled in this build (run scripts/fetch_assets.py --stockfish)"))
    }
}

#[cfg(not(target_os = "android"))]
fn ort_library(app: &AppHandle) -> Option<PathBuf> {
    let dir = resource_dir(app, "ort").ok()?;
    let is_ort = |name: &str| {
        if cfg!(windows) {
            name == "onnxruntime.dll"
        } else if cfg!(target_os = "macos") {
            name.starts_with("libonnxruntime") && name.ends_with(".dylib")
        } else {
            name.starts_with("libonnxruntime.so")
        }
    };
    let mut hits: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| is_ort(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    hits.sort();
    hits.into_iter().next()
}

pub fn maia_model_source(app: &AppHandle, model: &str) -> Result<maia_core::ModelSource, String> {
    model_path(app, model).map(maia_core::ModelSource::File)
}

#[tauri::command]
pub fn list_models(app: AppHandle) -> Vec<String> {
    model_ids(&app)
}

/// Must run before the first session is created; ort reads ORT_DYLIB_PATH once.
#[cfg(not(target_os = "android"))]
pub fn configure_ort(app: &AppHandle) -> Result<(), String> {
    if std::env::var_os("ORT_DYLIB_PATH").is_none() {
        let lib = ort_library(app).ok_or("the bundled ONNX Runtime library is missing from this build")?;
        // only reached before any session exists, so nothing else is reading the environment
        unsafe { std::env::set_var("ORT_DYLIB_PATH", lib) };
    }
    Ok(())
}

// jniLibs already puts libonnxruntime.so where ort looks for it
#[cfg(target_os = "android")]
pub fn configure_ort(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
