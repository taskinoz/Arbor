// "Open in terminal": the terminals installed on this machine, and how to
// open each one at a given folder.

use serde::Serialize;
use std::process::Command;

use crate::editors::{find_cli, mac_app_dirs};

struct TerminalDef {
    id: &'static str,
    label: &'static str,
    // macOS app bundle name (without .app).
    mac_app: Option<&'static str>,
    // Launcher on PATH (Windows/Linux, or a macOS terminal without a bundle).
    cli: Option<&'static str>,
    // Arguments that open it at `dir`. Empty means it's started with `dir` as
    // its working directory instead, which most terminals honour.
    args: fn(&str) -> Vec<String>,
}

fn none(_: &str) -> Vec<String> {
    vec![]
}

const TERMINALS: &[TerminalDef] = &[
    // macOS: `open -a <app> <dir>` opens these at the folder.
    TerminalDef { id: "terminal", label: "Terminal", mac_app: Some("Terminal"), cli: None, args: none },
    TerminalDef { id: "iterm", label: "iTerm2", mac_app: Some("iTerm"), cli: None, args: none },
    TerminalDef { id: "warp", label: "Warp", mac_app: Some("Warp"), cli: None, args: none },
    // These need their own flag, passed through `open --args` on macOS.
    TerminalDef { id: "ghostty", label: "Ghostty", mac_app: Some("Ghostty"), cli: Some("ghostty"), args: |d| vec![format!("--working-directory={d}")] },
    TerminalDef { id: "wezterm", label: "WezTerm", mac_app: Some("WezTerm"), cli: Some("wezterm"), args: |d| vec!["start".into(), "--cwd".into(), d.into()] },
    TerminalDef { id: "kitty", label: "kitty", mac_app: Some("kitty"), cli: Some("kitty"), args: |d| vec!["--directory".into(), d.into()] },
    TerminalDef { id: "alacritty", label: "Alacritty", mac_app: Some("Alacritty"), cli: Some("alacritty"), args: |d| vec!["--working-directory".into(), d.into()] },
    // Windows
    TerminalDef { id: "windows-terminal", label: "Windows Terminal", mac_app: None, cli: Some("wt"), args: |d| vec!["-d".into(), d.into()] },
    TerminalDef { id: "powershell", label: "PowerShell", mac_app: None, cli: Some("pwsh"), args: none },
    // Linux
    TerminalDef { id: "gnome-terminal", label: "GNOME Terminal", mac_app: None, cli: Some("gnome-terminal"), args: |d| vec![format!("--working-directory={d}")] },
    TerminalDef { id: "konsole", label: "Konsole", mac_app: None, cli: Some("konsole"), args: |d| vec!["--workdir".into(), d.into()] },
    TerminalDef { id: "xfce4-terminal", label: "Xfce Terminal", mac_app: None, cli: Some("xfce4-terminal"), args: |d| vec![format!("--working-directory={d}")] },
    TerminalDef { id: "x-terminal-emulator", label: "Default terminal", mac_app: None, cli: Some("x-terminal-emulator"), args: none },
];

#[derive(Serialize)]
pub struct Terminal {
    id: &'static str,
    label: &'static str,
}

fn has_mac_app(def: &TerminalDef) -> bool {
    cfg!(target_os = "macos")
        && def.mac_app.is_some_and(|app| mac_app_dirs().iter().any(|d| d.join(format!("{app}.app")).exists()))
}

fn is_installed(def: &TerminalDef) -> bool {
    if def.id == "powershell" && cfg!(windows) {
        return true; // Windows PowerShell is always there, even without pwsh.
    }
    has_mac_app(def) || (!cfg!(target_os = "macos") && def.cli.is_some_and(|c| find_cli(c).is_some()))
}

#[tauri::command]
pub async fn detect_terminals() -> Result<Vec<Terminal>, String> {
    crate::run_blocking(|| {
        Ok(TERMINALS
            .iter()
            .filter(|def| is_installed(def))
            .map(|def| Terminal { id: def.id, label: def.label })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn open_in_terminal(terminal_id: String, path: String) -> Result<(), String> {
    crate::run_blocking(move || {
        let def = TERMINALS
            .iter()
            .find(|d| d.id == terminal_id)
            .ok_or_else(|| format!("Unknown terminal '{terminal_id}'"))?;
        let args = (def.args)(&path);

        let mut cmd = if has_mac_app(def) {
            let mut cmd = Command::new("open");
            if args.is_empty() {
                cmd.args(["-a", def.mac_app.unwrap(), &path]);
            } else {
                // -n: a new instance, so the flags apply even if it's already open.
                cmd.args(["-na", def.mac_app.unwrap(), "--args"]).args(&args);
            }
            cmd
        } else if def.id == "powershell" && cfg!(windows) {
            // A new console window; `start` needs cmd.
            let shell = if find_cli("pwsh").is_some() { "pwsh" } else { "powershell" };
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "start", "", shell]);
            cmd
        } else {
            let exe = def
                .cli
                .and_then(find_cli)
                .ok_or_else(|| format!("{} doesn't appear to be installed", def.label))?;
            let mut cmd = Command::new(exe);
            cmd.args(&args);
            cmd
        };
        cmd.current_dir(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open {}: {e}", def.label))
    })
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(target_os = "macos")]
    fn finds_the_built_in_terminal_on_macos() {
        let found = tauri::async_runtime::block_on(super::detect_terminals()).unwrap();
        assert!(found.iter().any(|t| t.id == "terminal"), "Terminal.app lives in /System/Applications/Utilities");
    }
}
