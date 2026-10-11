use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

struct EditorDef {
    id: &'static str,
    label: &'static str,
    // macOS app bundle names (without .app), any of which counts as installed.
    mac_apps: &'static [&'static str],
    // Command-line launchers to look for on PATH.
    cli: &'static [&'static str],
}

const EDITORS: &[EditorDef] = &[
    EditorDef { id: "vscode", label: "VS Code", mac_apps: &["Visual Studio Code"], cli: &["code"] },
    EditorDef { id: "vscode-insiders", label: "VS Code Insiders", mac_apps: &["Visual Studio Code - Insiders"], cli: &["code-insiders"] },
    EditorDef { id: "vscodium", label: "VSCodium", mac_apps: &["VSCodium"], cli: &["codium"] },
    EditorDef { id: "cursor", label: "Cursor", mac_apps: &["Cursor"], cli: &["cursor"] },
    EditorDef { id: "windsurf", label: "Windsurf", mac_apps: &["Windsurf"], cli: &["windsurf"] },
    EditorDef { id: "zed", label: "Zed", mac_apps: &["Zed", "Zed Preview"], cli: &["zed"] },
    EditorDef { id: "sublime", label: "Sublime Text", mac_apps: &["Sublime Text"], cli: &["subl"] },
    EditorDef { id: "visual-studio", label: "Visual Studio", mac_apps: &[], cli: &[] },
    EditorDef { id: "webstorm", label: "WebStorm", mac_apps: &["WebStorm"], cli: &["webstorm"] },
    EditorDef { id: "idea", label: "IntelliJ IDEA", mac_apps: &["IntelliJ IDEA", "IntelliJ IDEA CE"], cli: &["idea"] },
    EditorDef { id: "pycharm", label: "PyCharm", mac_apps: &["PyCharm", "PyCharm CE"], cli: &["pycharm"] },
    EditorDef { id: "rustrover", label: "RustRover", mac_apps: &["RustRover"], cli: &["rustrover"] },
    EditorDef { id: "android-studio", label: "Android Studio", mac_apps: &["Android Studio"], cli: &["studio"] },
    EditorDef { id: "xcode", label: "Xcode", mac_apps: &["Xcode"], cli: &[] },
    EditorDef { id: "nova", label: "Nova", mac_apps: &["Nova"], cli: &[] },
];

#[derive(Serialize)]
pub struct Editor {
    id: &'static str,
    label: &'static str,
}

fn mac_app_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications"), PathBuf::from("/System/Applications")];
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(Path::new(&home).join("Applications"));
    }
    dirs
}

fn find_mac_app(def: &EditorDef) -> Option<&'static str> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let dirs = mac_app_dirs();
    def.mac_apps
        .iter()
        .copied()
        .find(|app| dirs.iter().any(|d| d.join(format!("{app}.app")).exists()))
}

fn find_cli(name: &str) -> Option<PathBuf> {
    let path = crate::augmented_path();
    let exts: &[&str] = if cfg!(windows) { &["", ".exe", ".cmd", ".bat"] } else { &[""] };
    std::env::split_paths(&path)
        .flat_map(|dir| exts.iter().map(move |ext| dir.join(format!("{name}{ext}"))))
        .find(|candidate| candidate.is_file())
}

// Visual Studio has no CLI on PATH; ask vswhere (installed alongside it).
fn find_visual_studio() -> Option<PathBuf> {
    let program_files = std::env::var("ProgramFiles(x86)").ok()?;
    let vswhere = Path::new(&program_files).join("Microsoft Visual Studio/Installer/vswhere.exe");
    let out = Command::new(vswhere)
        .args(["-latest", "-property", "productPath"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    path.is_file().then_some(path)
}

fn is_installed(def: &EditorDef) -> bool {
    if def.id == "visual-studio" {
        return find_visual_studio().is_some();
    }
    find_mac_app(def).is_some() || def.cli.iter().any(|c| find_cli(c).is_some())
}

#[tauri::command]
pub async fn detect_editors() -> Result<Vec<Editor>, String> {
    crate::run_blocking(|| {
        Ok(EDITORS
            .iter()
            .filter(|def| is_installed(def))
            .map(|def| Editor { id: def.id, label: def.label })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn open_in_editor(editor_id: String, path: String) -> Result<(), String> {
    crate::run_blocking(move || {
        let def = EDITORS
            .iter()
            .find(|d| d.id == editor_id)
            .ok_or_else(|| format!("Unknown editor '{editor_id}'"))?;

        // On macOS the app bundle works without the editor's shell command installed.
        if let Some(app) = find_mac_app(def) {
            let out = Command::new("open")
                .args(["-a", app, &path])
                .output()
                .map_err(|e| format!("Failed to launch {}: {e}", def.label))?;
            return if out.status.success() {
                Ok(())
            } else {
                Err(format!("{} error: {}", def.label, String::from_utf8_lossy(&out.stderr).trim()))
            };
        }

        let exe = if def.id == "visual-studio" {
            find_visual_studio()
        } else {
            def.cli.iter().find_map(|c| find_cli(c))
        }
        .ok_or_else(|| format!("{} doesn't appear to be installed", def.label))?;

        Command::new(exe)
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to launch {}: {e}", def.label))
    })
    .await
}
