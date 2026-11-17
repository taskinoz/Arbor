// Graft from a pull request: check someone's PR out into its own worktree
// for review, without touching the worktree you're in.

use serde::Serialize;
use std::path::Path;

use crate::{augmented_path, files, run_blocking, run_git_cmd};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    number: u64,
    title: String,
    author: String,
    head: String,
    base: String,
    state: String,
    is_draft: bool,
    // From a fork rather than a branch in this repo.
    from_fork: bool,
    url: String,
}

fn gh(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("gh")
        .args(args)
        .current_dir(cwd)
        .env("PATH", augmented_path())
        .output()
        .map_err(|_| "The GitHub CLI (gh) isn't installed or isn't on your PATH.".to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// `pr` is anything `gh pr view` accepts: a number, a URL, or a branch name.
#[tauri::command]
pub async fn get_pr(repo_path: String, pr: String) -> Result<PrSummary, String> {
    run_blocking(move || {
        let json = gh(&repo_path, &[
            "pr", "view", pr.trim(),
            "--json", "number,title,author,headRefName,baseRefName,state,isDraft,isCrossRepository,url",
        ])?;
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        let text = |key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string();
        Ok(PrSummary {
            number: v.get("number").and_then(|x| x.as_u64()).unwrap_or(0),
            title: text("title"),
            author: v.pointer("/author/login").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            head: text("headRefName"),
            base: text("baseRefName"),
            state: text("state"),
            is_draft: v.get("isDraft").and_then(|x| x.as_bool()).unwrap_or(false),
            from_fork: v.get("isCrossRepository").and_then(|x| x.as_bool()).unwrap_or(false),
            url: text("url"),
        })
    })
    .await
}

// Creates a worktree at `path` with the PR checked out, and returns the local
// branch gh made for it. The worktree starts detached and `gh pr checkout`
// runs inside it, so gh's handling of forks and tracking applies. If the
// checkout fails, the half-made worktree is removed again.
#[tauri::command]
pub async fn create_pr_worktree(
    repo_path: String,
    path: String,
    pr: String,
    exclude_dir: Option<String>,
) -> Result<String, String> {
    run_blocking(move || {
        if Path::new(&path).exists() {
            return Err(format!("{path} already exists"));
        }
        run_git_cmd(&repo_path, &["worktree", "add", "--detach", &path])?;
        let checkout = gh(&path, &["pr", "checkout", pr.trim()])
            .and_then(|_| run_git_cmd(&path, &["symbolic-ref", "--short", "HEAD"]));
        match checkout {
            Ok(branch) => {
                if let Some(dir) = exclude_dir.filter(|d| !d.trim().is_empty()) {
                    let _ = files::add_git_excludes(&repo_path, &[format!("/{}/", dir.trim_matches('/'))]);
                }
                Ok(branch)
            }
            Err(err) => {
                let _ = run_git_cmd(&repo_path, &["worktree", "remove", "--force", &path]);
                Err(if err.contains("already used by worktree") || err.contains("already checked out") {
                    format!("That PR's branch is already checked out in another worktree.\n\n{err}")
                } else {
                    err
                })
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_checkout_leaves_no_worktree_behind() {
        let dir = std::env::temp_dir().join(format!("arbor-pr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.join("repo");
        for args in [vec!["init", "-q", repo.to_str().unwrap()], vec!["-C", repo.to_str().unwrap(), "commit", "-q", "--allow-empty", "-m", "init"]] {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(&args)
                .status()
                .unwrap()
                .success();
            assert!(ok);
        }
        let wt = dir.join("pr-1");
        let repo_s = repo.to_str().unwrap().to_string();

        // No GitHub remote here, so gh can't check anything out (or gh is missing).
        let result = tauri::async_runtime::block_on(create_pr_worktree(repo_s.clone(), wt.to_str().unwrap().into(), "1".into(), None));
        assert!(result.is_err());
        assert!(!wt.exists(), "folder removed");
        let listing = run_git_cmd(&repo_s, &["worktree", "list", "--porcelain"]).unwrap();
        assert_eq!(listing.matches("worktree ").count(), 1, "only the main worktree is registered: {listing}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

