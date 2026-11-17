use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

mod commands;
mod status;
mod sync;
mod pr;
mod terminals;
mod editors;
mod files;

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
    // From local refs only; the UI refines it with `get_remote_info`.
    remote_status: String,
    // When the worktree folder was created (ms since the epoch), for the
    // date filters. None if the filesystem doesn't record it.
    created_ms: Option<u64>,
    // Remote of the branch's own upstream (see status::BranchRef).
    upstream_remote: Option<String>,
    // Commits ahead of / behind the upstream, as of the last fetch.
    ahead: u32,
    behind: u32,
    last_commit: Option<status::CommitInfo>,
    // A merge or rebase stopped part-way (e.g. on conflicts).
    operation: Option<String>,
    // `git worktree lock`ed, with its reason ("" if none given).
    locked: Option<String>,
    // The folder is gone (deleted outside git); `git worktree prune` clears it.
    missing: bool,
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

// How many worktrees to run `git status` in at once.
const ENRICH_CONCURRENCY: usize = 12;

fn get_worktrees_blocking(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    let output = run_git_cmd(&repo_path, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = Vec::new();
    let mut current_wt: Option<WorktreeInfo> = None;

    // First pass: just parse `worktree list --porcelain` - fast, local, no
    // subprocesses beyond the one call above.
    for line in output.lines() {
        if line.starts_with("worktree ") {
            if let Some(wt) = current_wt.take() {
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
                created_ms: None,
                upstream_remote: None,
                ahead: 0,
                behind: 0,
                last_commit: None,
                operation: None,
                locked: None,
                missing: false,
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
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(ref mut wt) = current_wt {
                wt.locked = Some(line["locked".len()..].trim().to_string());
            }
        } else if line == "prunable" || line.starts_with("prunable ") {
            if let Some(ref mut wt) = current_wt {
                wt.missing = true;
            }
        }
    }
    if let Some(wt) = current_wt {
        worktrees.push(wt);
    }

    if !worktrees.is_empty() {
        worktrees[0].is_main = true;
    }

    // Everything below is local: no network, so the tree can draw at once.
    // Upstreams and last commits for every branch come from one git call
    // each; only `git status` has to run per worktree.
    let branches = status::local_branches(&repo_path);
    let heads: Vec<String> = worktrees.iter().map(|wt| wt.head.clone()).collect();
    let commits = status::commits(&repo_path, &heads);

    for chunk in worktrees.chunks_mut(ENRICH_CONCURRENCY) {
        std::thread::scope(|scope| {
            for wt in chunk.iter_mut().filter(|wt| !wt.missing) {
                scope.spawn(move || {
                    wt.is_clean = run_git_cmd(&wt.path, &["status", "--porcelain"])
                        .map(|out| out.is_empty())
                        .unwrap_or(false);
                    wt.operation = sync::operation_in_progress(&wt.path).map(String::from);
                    wt.created_ms = fs::metadata(&wt.path)
                        .and_then(|m| m.created())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64);
                });
            }
        });
    }

    for wt in worktrees.iter_mut() {
        wt.last_commit = commits.get(&wt.head).cloned();
        let Some(b) = wt.branch.as_ref().and_then(|name| branches.get(name)) else {
            continue;
        };
        wt.upstream_remote = b.upstream_remote.clone();
        wt.ahead = b.ahead;
        wt.behind = b.behind;
        // Provisional: "gone" is only known after a prune, and a deleted
        // remote branch can still look present locally. The remote pass fixes both.
        wt.remote_status = match (&b.upstream_remote, b.gone) {
            (None, _) => "no_remote",
            (Some(_), true) => "remote_gone",
            (Some(_), false) => "has_remote",
        }
        .to_string();
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
    // Folder inside the repo (e.g. ".worktree") to hide from `git status`.
    exclude_dir: Option<String>,
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
            // Without this, a branch started from `origin/develop` would track
            // develop. It gets its own upstream on first push instead.
            args.push("--no-track");
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
        if let Some(dir) = exclude_dir.filter(|d| !d.trim().is_empty()) {
            // Cosmetic: the worktree already exists, so don't fail the graft over it.
            let _ = files::add_git_excludes(&repo_path, &[format!("/{}/", dir.trim_matches('/'))]);
        }
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

// Deletes a local branch. Without `force` git refuses unless the branch is
// fully merged, so unmerged work survives a bulk removal. `force` is for
// squash-merged PR branches, which git can't recognise as merged - but even
// then a branch with commits its upstream doesn't have is kept, so work done
// after the merge and never pushed isn't thrown away.
#[tauri::command]
async fn delete_branch(repo_path: String, branch: String, force: bool) -> Result<(), String> {
    run_blocking(move || {
        if force {
            let range = format!("{branch}@{{upstream}}..{branch}");
            let unpushed = run_git_cmd(&repo_path, &["rev-list", "--count", &range])
                .map_err(|_| "branch has no upstream to compare against".to_string())?;
            if unpushed != "0" {
                return Err(format!("branch has {unpushed} unpushed commit(s)"));
            }
        }
        run_git_cmd(&repo_path, &["branch", if force { "-D" } else { "-d" }, &branch])?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn delete_remote_branch(repo_path: String, remote: String, branch: String) -> Result<(), String> {
    run_blocking(move || run_git_cmd(&repo_path, &["push", &remote, "--delete", &branch]).map(|_| ())).await
}

// git refuses to remove (or prune) a locked worktree without a double --force,
// which Arbor never passes, so a lock guards it against bulk remove.
#[tauri::command]
async fn set_worktree_locked(repo_path: String, worktree_path: String, locked: bool) -> Result<(), String> {
    run_blocking(move || {
        let args: &[&str] = if locked {
            &["worktree", "lock", "--reason", "Locked in Arbor", &worktree_path]
        } else {
            &["worktree", "unlock", &worktree_path]
        };
        run_git_cmd(&repo_path, args).map(|_| ())
    })
    .await
}

// Forgets worktrees whose folders were deleted outside git.
#[tauri::command]
async fn prune_worktrees(repo_path: String) -> Result<(), String> {
    run_blocking(move || run_git_cmd(&repo_path, &["worktree", "prune"]).map(|_| ())).await
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

// The repo's default branch name as GitHub sees it (via `gh`), falling back
// to the remote HEAD git cached at clone time. None if neither is available.
#[tauri::command]
async fn get_default_branch(repo_path: String) -> Result<Option<String>, String> {
    run_blocking(move || {
        let from_gh = std::process::Command::new("gh")
            .args(["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])
            .current_dir(&repo_path)
            .env("PATH", augmented_path())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|name| !name.is_empty());

        Ok(from_gh.or_else(|| {
            run_git_cmd(&repo_path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
                .ok()
                .map(|r| r.strip_prefix("origin/").unwrap_or(&r).to_string())
                .filter(|name| !name.is_empty())
        }))
    })
    .await
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct SyncStatus {
    ahead: usize,
    behind: usize,
    has_upstream: bool,
}

// Whether the worktree's checked-out branch tracks a remote branch of the same
// name. A branch that tracks the branch it was created from (e.g. develop)
// doesn't: pulling would merge develop in and `git push` refuses outright.
fn has_own_upstream(path: &str) -> bool {
    let Ok(branch) = run_git_cmd(path, &["symbolic-ref", "--quiet", "HEAD"]) else {
        return false; // detached HEAD
    };
    run_git_cmd(path, &["for-each-ref", "--format=%(upstream:remoteref)", &branch])
        .map(|remote_ref| remote_ref == branch)
        .unwrap_or(false)
}

#[tauri::command]
async fn get_sync_status(path: String) -> Result<SyncStatus, String> {
    run_blocking(move || {
        if !has_own_upstream(&path) {
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
    run_blocking(move || {
        if !has_own_upstream(&path) {
            return Err("This branch isn't on the remote yet, so there's nothing to pull. Push it first.".to_string());
        }
        run_git_cmd(&path, &["pull"])
    })
    .await
}

#[tauri::command]
async fn git_push(path: String) -> Result<String, String> {
    run_blocking(move || {
        if has_own_upstream(&path) {
            return run_git_cmd(&path, &["push"]);
        }
        // First push (or a branch tracking the branch it was created from):
        // publish it under its own name and make that its upstream.
        let branch = run_git_cmd(&path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .map_err(|_| "Can't push a detached HEAD".to_string())?;
        let remote = run_git_cmd(&path, &["config", &format!("branch.{branch}.remote")])
            .ok()
            .filter(|r| !r.is_empty() && r != ".")
            .unwrap_or_else(|| "origin".to_string());
        run_git_cmd(&path, &["push", "-u", &remote, "HEAD"])
    })
    .await
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

// Opens a folder in the OS file manager (Finder / Explorer / xdg-open).
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

// Swaps the running app's icon for the themed one the frontend renders.
// macOS: the dock icon (must be set on the main thread). Elsewhere: the
// window/taskbar icon. Neither touches the bundled icon on disk.
#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, png: Vec<u8>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            use objc2::{AllocAnyThread, MainThreadMarker};
            use objc2_app_kit::{NSApplication, NSImage};
            use objc2_foundation::NSData;
            let Some(mtm) = MainThreadMarker::new() else { return };
            let data = NSData::with_bytes(&png);
            if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
                unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let image = tauri::image::Image::from_bytes(&png).map_err(|e| e.to_string())?;
        for window in app.webview_windows().values() {
            window.set_icon(image.clone()).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::Running::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_repos,
            add_repo,
            remove_repo,
            get_worktrees,
            create_worktree,
            delete_worktree,
            delete_branch,
            delete_remote_branch,
            set_worktree_locked,
            prune_worktrees,
            editors::detect_editors,
            editors::open_in_editor,
            files::apply_worktree_files,
            commands::run_command,
            commands::stop_command,
            get_git_branches,
            get_default_branch,
            get_sync_status,
            git_fetch,
            git_pull,
            git_push,
            get_home_dir,
            set_app_icon,
            status::get_remote_info,
            terminals::detect_terminals,
            sync::sync_all,
            pr::get_pr,
            pr::create_pr_worktree,
            sync::update_from_base,
            sync::abort_update,
            terminals::open_in_terminal,
            status::get_dir_size,
            open_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                commands::stop_all(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_locked_and_missing_worktrees_and_lock_blocks_removal() {
        let dir = std::env::temp_dir().join(format!("arbor-tidy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let repo = dir.join("repo");
        let r = repo.to_str().unwrap().to_string();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-C", &r])
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        fs::create_dir_all(&repo).unwrap();
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        let (keep, gone) = (dir.join("keep"), dir.join("gone"));
        git(&["worktree", "add", "-q", "-b", "keep", keep.to_str().unwrap()]);
        git(&["worktree", "add", "-q", "-b", "gone", gone.to_str().unwrap()]);
        fs::remove_dir_all(&gone).unwrap();
        tauri::async_runtime::block_on(set_worktree_locked(r.clone(), keep.to_str().unwrap().into(), true)).unwrap();

        let wts = get_worktrees_blocking(r.clone()).unwrap();
        let find = |b: &str| wts.iter().find(|w| w.branch.as_deref() == Some(b)).unwrap();
        assert_eq!(find("keep").locked.as_deref(), Some("Locked in Arbor"));
        assert!(!find("keep").missing);
        assert!(find("gone").missing);
        assert!(find("gone").locked.is_none());

        assert!(tauri::async_runtime::block_on(delete_worktree(r.clone(), keep.to_str().unwrap().into(), true)).is_err(), "locked survives remove");
        tauri::async_runtime::block_on(prune_worktrees(r.clone())).unwrap();
        let wts = get_worktrees_blocking(r.clone()).unwrap();
        assert_eq!(wts.len(), 2, "missing one pruned, locked one kept");
        tauri::async_runtime::block_on(set_worktree_locked(r.clone(), keep.to_str().unwrap().into(), false)).unwrap();
        assert!(get_worktrees_blocking(r).unwrap()[1].locked.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn force_delete_keeps_branches_with_unpushed_commits() {
        let dir = std::env::temp_dir().join(format!("arbor-branch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = |cwd: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&dir, &["init", "-q", "--bare", "origin.git"]);
        git(&dir, &["clone", "-q", "origin.git", "repo"]);
        let repo = dir.join("repo");
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        for b in ["pushed", "ahead"] {
            git(&repo, &["checkout", "-q", "-b", b]);
            git(&repo, &["commit", "-q", "--allow-empty", "-m", b]);
            git(&repo, &["push", "-q", "-u", "origin", b]);
        }
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "after merge, never pushed"]);
        git(&repo, &["checkout", "-q", "-"]);
        git(&repo, &["checkout", "-q", "--detach"]);

        let repo_s = repo.to_str().unwrap().to_string();
        let delete = |b: &str| tauri::async_runtime::block_on(delete_branch(repo_s.clone(), b.to_string(), true));
        assert_eq!(delete("pushed"), Ok(()));
        assert_eq!(delete("ahead"), Err("branch has 1 unpushed commit(s)".to_string()));
        assert!(run_git_cmd(&repo_s, &["rev-parse", "--verify", "refs/heads/ahead"]).is_ok(), "kept");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn branch_tracking_its_base_has_no_upstream_until_pushed() {
        let dir = std::env::temp_dir().join(format!("arbor-upstream-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = |cwd: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&dir, &["init", "-q", "--bare", "origin.git"]);
        git(&dir, &["clone", "-q", "origin.git", "repo"]);
        let repo = dir.join("repo");
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git(&repo, &["push", "-q", "-u", "origin", "HEAD:develop"]);
        git(&repo, &["fetch", "-q"]);
        // How the eye-view branches were made: git's default makes them track develop.
        let wt = dir.join("wt");
        git(&repo, &["worktree", "add", "-q", "-b", "fix/thing", wt.to_str().unwrap(), "origin/develop"]);
        let (repo_s, wt_s) = (repo.to_str().unwrap(), wt.to_str().unwrap().to_string());

        assert_eq!(status::local_branches(repo_s)["fix/thing"].upstream_remote, None, "not its own upstream");
        assert!(!has_own_upstream(&wt_s));
        let sync = tauri::async_runtime::block_on(get_sync_status(wt_s.clone())).unwrap();
        assert!(!sync.has_upstream, "no ahead/behind against develop");
        assert!(tauri::async_runtime::block_on(git_pull(wt_s.clone())).is_err(), "won't merge develop in");

        // Push publishes it under its own name and fixes the upstream.
        tauri::async_runtime::block_on(git_push(wt_s.clone())).unwrap();
        assert!(has_own_upstream(&wt_s));
        assert_eq!(status::local_branches(repo_s)["fix/thing"].upstream_remote.as_deref(), Some("origin"));

        // New worktrees from Arbor don't pick up the base as upstream at all.
        let wt2 = dir.join("wt2").to_str().unwrap().to_string();
        tauri::async_runtime::block_on(create_worktree(
            repo_s.to_string(), wt2.clone(), "feat/new".into(), true, Some("origin/develop".into()), None,
        ))
        .unwrap();
        assert_eq!(run_git_cmd(repo_s, &["for-each-ref", "--format=%(upstream)", "refs/heads/feat/new"]), Ok(String::new()));
        let _ = fs::remove_dir_all(&dir);
    }
}

