use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub source: String,
    // Path inside the worktree the file should appear at, e.g. "app/.claude/CLAUDE.md".
    pub target: String,
    // "symlink" or "copy"
    pub mode: String,
}

#[derive(Serialize, Debug)]
pub struct FileResult {
    pub name: String,
    // "linked", "copied" or "skipped"
    pub status: String,
    pub message: Option<String>,
}

#[cfg(unix)]
fn symlink(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, dest)
}

#[cfg(windows)]
fn symlink(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, dest)
}

fn expand_tilde(p: &str) -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok();
    match home {
        Some(h) if p == "~" => PathBuf::from(h),
        Some(h) if p.starts_with("~/") => Path::new(&h).join(&p[2..]),
        _ => PathBuf::from(p),
    }
}

// Targets are joined onto the worktree path, so anything absolute or
// containing `..` could write outside it.
fn safe_target(target: &str) -> Result<PathBuf, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("target path is empty".to_string());
    }
    let path = Path::new(target);
    if path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("target must be a relative path inside the worktree".to_string());
    }
    Ok(path.to_path_buf())
}

fn apply_one(worktree: &Path, entry: &FileEntry) -> Result<&'static str, String> {
    let rel = safe_target(&entry.target)?;
    let source = fs::canonicalize(expand_tilde(entry.source.trim()))
        .map_err(|e| format!("source not found: {e}"))?;
    let dest = worktree.join(&rel);

    let tracked = crate::run_git_cmd(
        &worktree.to_string_lossy(),
        &["ls-files", "--error-unmatch", "--", &rel.to_string_lossy()],
    )
    .is_ok();
    if tracked {
        return Err("already tracked by git, not overwriting".to_string());
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }

    // Always remove whatever is there first. Copying onto an existing symlink
    // would write through it and clobber the symlink's target - i.e. the real
    // source file, when re-applying in copy mode after an earlier symlink run.
    match fs::symlink_metadata(&dest) {
        Ok(meta) if meta.is_dir() => return Err("target is a folder".to_string()),
        Ok(_) => fs::remove_file(&dest).map_err(|e| format!("cannot replace existing file: {e}"))?,
        Err(_) => {}
    }

    if entry.mode == "copy" {
        fs::copy(&source, &dest).map(|_| "copied").map_err(|e| format!("copy failed: {e}"))
    } else {
        symlink(&source, &dest).map(|_| "linked").map_err(|e| {
            let hint = if cfg!(windows) { " (Windows needs Developer Mode to create symlinks)" } else { "" };
            format!("symlink failed: {e}{hint}")
        })
    }
}

// Appends lines to the repo's local-only info/exclude (shared by every
// worktree), so linked files and the worktree folder don't show as untracked.
pub fn add_git_excludes(repo_path: &str, lines: &[String]) -> Result<(), String> {
    let path = PathBuf::from(crate::run_git_cmd(
        repo_path,
        &["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    )?);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let have: HashSet<&str> = existing.lines().map(str::trim).collect();
    let missing: Vec<&String> = lines.iter().filter(|l| !have.contains(l.as_str())).collect();
    if missing.is_empty() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for line in missing {
        out.push_str(line);
        out.push('\n');
    }
    fs::write(&path, out).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

pub fn apply_files(repo_path: &str, worktree_path: &str, entries: &[FileEntry], exclude: bool) -> Vec<FileResult> {
    let worktree = Path::new(worktree_path);
    let mut results = Vec::new();
    let mut applied_targets = Vec::new();

    for entry in entries {
        let result = match apply_one(worktree, entry) {
            Ok(status) => {
                applied_targets.push(format!("/{}", entry.target.trim().trim_start_matches("./").replace('\\', "/")));
                FileResult { name: entry.name.clone(), status: status.to_string(), message: None }
            }
            Err(message) => FileResult { name: entry.name.clone(), status: "skipped".to_string(), message: Some(message) },
        };
        results.push(result);
    }

    if exclude {
        if let Err(e) = add_git_excludes(repo_path, &applied_targets) {
            results.push(FileResult {
                name: "git exclude".to_string(),
                status: "skipped".to_string(),
                message: Some(format!("couldn't update .git/info/exclude: {e}")),
            });
        }
    }
    results
}

#[tauri::command]
pub async fn apply_worktree_files(
    repo_path: String,
    worktree_path: String,
    entries: Vec<FileEntry>,
    exclude: bool,
) -> Result<Vec<FileResult>, String> {
    crate::run_blocking(move || Ok(apply_files(&repo_path, &worktree_path, &entries, exclude))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arbor-files-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(source: &Path, target: &str, mode: &str) -> FileEntry {
        FileEntry {
            name: "t".to_string(),
            source: source.to_string_lossy().to_string(),
            target: target.to_string(),
            mode: mode.to_string(),
        }
    }

    #[test]
    fn creates_parent_dirs_and_links() {
        let dir = scratch("link");
        let src = dir.join("src.md");
        fs::write(&src, "hello").unwrap();
        let wt = dir.join("wt");
        fs::create_dir_all(&wt).unwrap();

        let r = apply_files("", wt.to_str().unwrap(), &[entry(&src, "app/.claude/CLAUDE.md", "symlink")], false);
        assert_eq!(r[0].status, "linked", "{:?}", r[0].message);
        assert_eq!(fs::read_to_string(wt.join("app/.claude/CLAUDE.md")).unwrap(), "hello");
    }

    // Regression: switching symlink -> copy used to truncate the source file.
    #[test]
    fn copy_over_existing_symlink_keeps_source_intact() {
        let dir = scratch("flip");
        let src = dir.join("src.env");
        fs::write(&src, "SECRET=1").unwrap();
        let wt = dir.join("wt");
        fs::create_dir_all(&wt).unwrap();

        apply_files("", wt.to_str().unwrap(), &[entry(&src, ".env", "symlink")], false);
        let r = apply_files("", wt.to_str().unwrap(), &[entry(&src, ".env", "copy")], false);

        assert_eq!(r[0].status, "copied", "{:?}", r[0].message);
        assert_eq!(fs::read_to_string(&src).unwrap(), "SECRET=1");
        assert!(!fs::symlink_metadata(wt.join(".env")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn rejects_targets_outside_the_worktree() {
        let dir = scratch("escape");
        let src = dir.join("src.md");
        fs::write(&src, "x").unwrap();
        let wt = dir.join("wt");
        fs::create_dir_all(&wt).unwrap();

        for bad in ["../evil", "/etc/evil", "a/../../evil", ""] {
            let r = apply_files("", wt.to_str().unwrap(), &[entry(&src, bad, "copy")], false);
            assert_eq!(r[0].status, "skipped", "target {bad:?} should be rejected");
        }
        assert!(!dir.join("evil").exists());
    }

    #[test]
    fn excludes_are_appended_once_and_hide_files_from_status() {
        let dir = scratch("exclude");
        let repo = dir.to_str().unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&dir).status().unwrap().success());
        fs::write(dir.join(".env"), "x").unwrap();

        let lines = vec!["/.env".to_string(), "/.worktree/".to_string()];
        add_git_excludes(repo, &lines).unwrap();
        add_git_excludes(repo, &lines).unwrap();

        let exclude = fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches("/.env\n").count(), 1, "{exclude}");
        assert_eq!(crate::run_git_cmd(repo, &["status", "--porcelain"]).unwrap(), "");
    }

    #[test]
    fn missing_source_is_skipped() {
        let dir = scratch("missing");
        let wt = dir.join("wt");
        fs::create_dir_all(&wt).unwrap();
        let r = apply_files("", wt.to_str().unwrap(), &[entry(&dir.join("nope"), ".env", "copy")], false);
        assert_eq!(r[0].status, "skipped");
    }
}
