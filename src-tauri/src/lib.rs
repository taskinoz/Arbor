use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct AppConfig {
    repos: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct WorktreeInfo {
    path: String,
    head: String,
    branch: Option<String>,
    is_main: bool,
    is_clean: bool,
}

fn get_config_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut config_dir = app_handle.path().app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {}", e))?;
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    config_dir.push("config.json");
    Ok(config_dir)
}

fn load_config(app_handle: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = get_config_path(app_handle)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let mut file = File::open(path).map_err(|e| format!("Failed to open config file: {}", e))?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|e| format!("Failed to read config file: {}", e))?;
    let config: AppConfig = serde_json::from_str(&contents).unwrap_or_default();
    Ok(config)
}

fn save_config(app_handle: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = get_config_path(app_handle)?;
    let contents = serde_json::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {}", e))?;
    let mut file = File::create(path).map_err(|e| format!("Failed to create config file: {}", e))?;
    file.write_all(contents.as_bytes()).map_err(|e| format!("Failed to write config file: {}", e))?;
    Ok(())
}

fn run_git_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to execute git command: {}", e))?;
    
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn get_repos(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let config = load_config(&app_handle)?;
    Ok(config.repos)
}

#[tauri::command]
fn add_repo(app_handle: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    // Verify it is a valid git repository
    let _is_git = run_git_cmd(&path, &["rev-parse", "--show-toplevel"])
        .map_err(|e| format!("Not a valid Git repository: {}", e))?;
    
    // Canonicalize path to avoid duplicates
    let canonical_path = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?
        .to_string_lossy()
        .to_string();

    let mut config = load_config(&app_handle)?;
    if !config.repos.contains(&canonical_path) {
        config.repos.push(canonical_path);
        save_config(&app_handle, &config)?;
    }
    Ok(config.repos)
}

#[tauri::command]
fn remove_repo(app_handle: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let mut config = load_config(&app_handle)?;
    config.repos.retain(|r| r != &path);
    save_config(&app_handle, &config)?;
    Ok(config.repos)
}

#[tauri::command]
fn get_worktrees(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    let output = run_git_cmd(&repo_path, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = Vec::new();
    let mut current_wt: Option<WorktreeInfo> = None;

    for line in output.lines() {
        if line.starts_with("worktree ") {
            if let Some(mut wt) = current_wt.take() {
                wt.is_clean = run_git_cmd(&wt.path, &["status", "--porcelain"])
                    .map(|out| out.is_empty())
                    .unwrap_or(false);
                worktrees.push(wt);
            }
            let path = line["worktree ".len()..].trim().to_string();
            current_wt = Some(WorktreeInfo {
                path,
                head: String::new(),
                branch: None,
                is_main: false,
                is_clean: true,
            });
        } else if line.starts_with("HEAD ") {
            if let Some(ref mut wt) = current_wt {
                wt.head = line["HEAD ".len()..].trim().to_string();
            }
        } else if line.starts_with("branch ") {
            if let Some(ref mut wt) = current_wt {
                let full_branch = line["branch ".len()..].trim();
                let short_branch = if full_branch.starts_with("refs/heads/") {
                    full_branch["refs/heads/".len()..].to_string()
                } else {
                    full_branch.to_string()
                };
                wt.branch = Some(short_branch);
            }
        }
    }
    if let Some(mut wt) = current_wt {
        wt.is_clean = run_git_cmd(&wt.path, &["status", "--porcelain"])
            .map(|out| out.is_empty())
            .unwrap_or(false);
        worktrees.push(wt);
    }

    if !worktrees.is_empty() {
        worktrees[0].is_main = true;
    }

    Ok(worktrees)
}

#[tauri::command]
fn create_worktree(
    repo_path: String,
    path: String,
    branch: String,
    new_branch: bool,
    base_branch: Option<String>,
) -> Result<(), String> {
    let abs_path = if Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else {
        let parent = Path::new(&repo_path).parent().ok_or("Cannot get repo parent directory")?;
        parent.join(&path)
    };

    let path_str = abs_path.to_string_lossy().to_string();

    let mut args = vec!["worktree", "add", &path_str];
    if new_branch {
        args.push("-b");
        args.push(&branch);
        if let Some(ref base) = base_branch {
            if !base.trim().is_empty() {
                args.push(base);
            }
        }
    } else {
        args.push(&branch);
    }

    run_git_cmd(&repo_path, &args)?;
    Ok(())
}

#[tauri::command]
fn delete_worktree(repo_path: String, worktree_path: String, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove", &worktree_path];
    if force {
        args.push("--force");
    }
    run_git_cmd(&repo_path, &args)?;
    Ok(())
}

#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    let output = std::process::Command::new("code")
        .arg(&path)
        .output();
    
    match output {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if err.is_empty() {
                Err("Failed to open in VS Code. Make sure the 'code' command is in your PATH. In VS Code, run 'Shell Command: Install 'code' command in PATH'.".to_string())
            } else {
                Err(format!("VS Code error: {}", err))
            }
        }
        Err(_) => {
            let open_output = std::process::Command::new("open")
                .args(&["-a", "Visual Studio Code", &path])
                .output();
            match open_output {
                Ok(out) if out.status.success() => Ok(()),
                _ => Err("Failed to open in VS Code. Please make sure the 'code' command is installed in PATH, or VS Code is in your Applications folder.".to_string())
            }
        }
    }
}

#[tauri::command]
fn get_git_branches(repo_path: String) -> Result<Vec<String>, String> {
    let output = run_git_cmd(&repo_path, &["branch", "--all", "--format=%(refname:short)"])?;
    let branches: Vec<String> = output
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && !line.contains("HEAD ->"))
        .collect();
    Ok(branches)
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct SyncStatus {
    ahead: usize,
    behind: usize,
    has_upstream: bool,
}

#[tauri::command]
fn get_sync_status(path: String) -> Result<SyncStatus, String> {
    let upstream_check = run_git_cmd(&path, &["rev-parse", "--abbrev-ref", "@{u}"]);
    if upstream_check.is_err() {
        return Ok(SyncStatus {
            ahead: 0,
            behind: 0,
            has_upstream: false,
        });
    }
    
    let ahead = run_git_cmd(&path, &["rev-list", "--count", "@{u}..HEAD"])
        .map(|s| s.parse::<usize>().unwrap_or(0))
        .unwrap_or(0);
    
    let behind = run_git_cmd(&path, &["rev-list", "--count", "HEAD..@{u}"])
        .map(|s| s.parse::<usize>().unwrap_or(0))
        .unwrap_or(0);
        
    Ok(SyncStatus {
        ahead,
        behind,
        has_upstream: true,
    })
}

#[tauri::command]
fn git_fetch(path: String) -> Result<String, String> {
    run_git_cmd(&path, &["fetch"])
}

#[tauri::command]
fn git_pull(path: String) -> Result<String, String> {
    run_git_cmd(&path, &["pull"])
}

#[tauri::command]
fn git_push(path: String) -> Result<String, String> {
    run_git_cmd(&path, &["push"])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_repos,
            add_repo,
            remove_repo,
            get_worktrees,
            create_worktree,
            delete_worktree,
            open_in_vscode,
            get_git_branches,
            get_sync_status,
            git_fetch,
            git_pull,
            git_push
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
