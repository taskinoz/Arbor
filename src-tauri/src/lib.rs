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
    remote_status: String,
}

// Classifies a branch's relationship to its remote-tracking ref.
//
// `%(upstream:track)`'s `[gone]` marker only gets set by an explicit
// `git fetch --prune` (or equivalent) *after* the remote branch was
// deleted - until that happens, the local tracking ref just sits there
// stale, looking exactly like a still-tracked branch. Since this app never
// runs a prune itself, that stale-cache-only check was reporting plenty of
// long-since-merged-and-deleted branches as "has_remote". So once we know a
// branch has (or had) an upstream at all, we ask the remote directly via
// `git ls-remote` whether that ref still exists there right now - falling
// back to the stale local cache only if the live check itself fails (e.g.
// offline), since stale-but-present is still better than nothing.
fn get_remote_status(repo_path: &str, branch: &str) -> String {
    let refname = format!("refs/heads/{}", branch);
    let output = run_git_cmd(
        repo_path,
        &[
            "for-each-ref",
            "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:track)",
            &refname,
        ],
    );

    let (upstream, remote_name, track) = match output {
        Ok(line) => {
            let mut parts = line.splitn(3, '\u{0}');
            (
                parts.next().unwrap_or("").trim().to_string(),
                parts.next().unwrap_or("").trim().to_string(),
                parts.next().unwrap_or("").trim().to_string(),
            )
        }
        Err(_) => return "no_remote".to_string(),
    };

    if upstream.is_empty() {
        return "no_remote".to_string();
    }

    if !remote_name.is_empty() {
        if let Ok(ls_output) = run_git_cmd(repo_path, &["ls-remote", "--heads", &remote_name, branch]) {
            return if ls_output.trim().is_empty() {
                "remote_gone".to_string()
            } else {
                "has_remote".to_string()
            };
        }
    }

    if track.contains("gone") {
        "remote_gone".to_string()
    } else {
        "has_remote".to_string()
    }
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

// A GUI-launched macOS app (a bundled .app, as opposed to a shell) inherits
// launchd's minimal PATH, not the user's interactive shell PATH - so
// Homebrew-installed tools like `gh` (typically /opt/homebrew/bin or
// /usr/local/bin) silently fail to spawn even though they work fine from a
// terminal. Every subprocess we spawn appends these common install
// locations to whatever PATH we did inherit, so lookups by bare name (git,
// gh, code) keep working regardless of how the app was launched.
fn augmented_path() -> String {
    let extra = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    match std::env::var("PATH") {
        Ok(existing) if !existing.is_empty() => format!("{}:{}", existing, extra),
        _ => extra.to_string(),
    }
}

fn run_git_cmd(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", augmented_path())
        .output()
        .map_err(|e| format!("Failed to execute git command: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// Tauri only moves a command's work off the main/UI thread when the command
// is `async` - a plain `fn` command runs inline on the same thread that
// drives the window, so any git subprocess it shells out to (which can take
// a noticeable moment, especially fetch/pull/clone over the network, or
// `worktree add` copying files) freezes the whole app and beachballs.
// Every command below is `async` and routes its actual (blocking, synchronous)
// work through this helper so it runs on a dedicated blocking-friendly thread
// instead.
async fn run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {}", e))?
}

#[tauri::command]
async fn get_repos(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let config = load_config(&app_handle)?;
        Ok(config.repos)
    })
    .await
}

#[tauri::command]
async fn add_repo(app_handle: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    run_blocking(move || {
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
    })
    .await
}

#[tauri::command]
async fn remove_repo(app_handle: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let mut config = load_config(&app_handle)?;
        config.repos.retain(|r| r != &path);
        save_config(&app_handle, &config)?;
        Ok(config.repos)
    })
    .await
}

fn get_worktrees_blocking(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    let output = run_git_cmd(&repo_path, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = Vec::new();
    let mut current_wt: Option<WorktreeInfo> = None;

    for line in output.lines() {
        if line.starts_with("worktree ") {
            if let Some(mut wt) = current_wt.take() {
                wt.is_clean = run_git_cmd(&wt.path, &["status", "--porcelain"])
                    .map(|out| out.is_empty())
                    .unwrap_or(false);
                if let Some(ref branch) = wt.branch {
                    wt.remote_status = get_remote_status(&wt.path, branch);
                }
                worktrees.push(wt);
            }
            let path = line["worktree ".len()..].trim().to_string();
            current_wt = Some(WorktreeInfo {
                path,
                head: String::new(),
                branch: None,
                is_main: false,
                is_clean: true,
                remote_status: "no_remote".to_string(),
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
        if let Some(ref branch) = wt.branch {
            wt.remote_status = get_remote_status(&wt.path, branch);
        }
        worktrees.push(wt);
    }

    if !worktrees.is_empty() {
        worktrees[0].is_main = true;
    }

    Ok(worktrees)
}

#[tauri::command]
async fn get_worktrees(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    run_blocking(move || get_worktrees_blocking(repo_path)).await
}

#[tauri::command]
async fn create_worktree(
    repo_path: String,
    path: String,
    branch: String,
    new_branch: bool,
    base_branch: Option<String>,
) -> Result<(), String> {
    run_blocking(move || {
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
    })
    .await
}

#[tauri::command]
async fn delete_worktree(repo_path: String, worktree_path: String, force: bool) -> Result<(), String> {
    run_blocking(move || {
        let mut args = vec!["worktree", "remove", &worktree_path];
        if force {
            args.push("--force");
        }
        run_git_cmd(&repo_path, &args)?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn open_in_vscode(path: String) -> Result<(), String> {
    run_blocking(move || {
        let output = std::process::Command::new("code")
            .arg(&path)
            .env("PATH", augmented_path())
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
    })
    .await
}

#[tauri::command]
async fn get_git_branches(repo_path: String) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let output = run_git_cmd(&repo_path, &["branch", "--all", "--format=%(refname:short)"])?;
        let branches: Vec<String> = output
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty() && !line.contains("HEAD ->"))
            .collect();
        Ok(branches)
    })
    .await
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct SyncStatus {
    ahead: usize,
    behind: usize,
    has_upstream: bool,
}

#[tauri::command]
async fn get_sync_status(path: String) -> Result<SyncStatus, String> {
    run_blocking(move || {
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
    })
    .await
}

#[tauri::command]
async fn git_fetch(path: String) -> Result<String, String> {
    run_blocking(move || run_git_cmd(&path, &["fetch"])).await
}

#[tauri::command]
async fn git_pull(path: String) -> Result<String, String> {
    run_blocking(move || run_git_cmd(&path, &["pull"])).await
}

#[tauri::command]
async fn git_push(path: String) -> Result<String, String> {
    run_blocking(move || run_git_cmd(&path, &["push"])).await
}

#[tauri::command]
async fn get_home_dir() -> Result<Option<String>, String> {
    run_blocking(|| {
        Ok(std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok())
    })
    .await
}

// Looks up a GitHub pull request for a branch via the `gh` CLI, searching
// across every state (open/closed/merged) so this still finds a PR whose
// branch has since been deleted - `gh` keeps the head branch name on record
// for a PR even after the ref itself is gone. Any failure (gh missing, not
// authenticated, not a GitHub remote, no matching PR) is treated the same
// as "no PR" rather than an error, since this is a best-effort nicety.
#[tauri::command]
async fn get_pr_url(repo_path: String, branch: String) -> Result<Option<String>, String> {
    run_blocking(move || {
        let output = std::process::Command::new("gh")
            .args([
                "pr", "list",
                "--head", &branch,
                "--state", "all",
                "--json", "url",
                "--limit", "1",
            ])
            .current_dir(&repo_path)
            .env("PATH", augmented_path())
            .output();

        let output = match output {
            Ok(out) if out.status.success() => out,
            _ => return Ok(None),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: serde_json::Value = match serde_json::from_str(&stdout) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };

        let url = parsed
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|pr| pr.get("url"))
            .and_then(|u| u.as_str())
            .map(|s| s.to_string());

        Ok(url)
    })
    .await
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
            git_push,
            get_home_dir,
            get_pr_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
