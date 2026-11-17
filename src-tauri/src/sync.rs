// Repo-wide sync, and bringing one worktree up to date with its base branch.
//
// Worktrees share their repo's remote-tracking refs, so a single fetch
// updates what every worktree sees. Pulling is then a local fast-forward per
// clean worktree - no network round trip per worktree.

use serde::Serialize;

use crate::{run_blocking, run_git_cmd, status};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub path: String,
    pub branch: Option<String>,
    // pulled, up_to_date, skipped or failed
    pub outcome: &'static str,
    pub message: String,
}

fn worktree_branches(repo_path: &str) -> Result<Vec<(String, Option<String>)>, String> {
    let listing = run_git_cmd(repo_path, &["worktree", "list", "--porcelain"])?;
    let mut out = Vec::new();
    for block in listing.split("\n\n") {
        let path = block.lines().find_map(|l| l.strip_prefix("worktree "));
        let branch = block.lines().find_map(|l| l.strip_prefix("branch refs/heads/"));
        if let Some(path) = path {
            out.push((path.to_string(), branch.map(String::from)));
        }
    }
    Ok(out)
}

fn fast_forward(path: &str, branch: Option<&str>, upstream: Option<&status::BranchRef>) -> SyncResult {
    let result = |outcome, message: &str| SyncResult {
        path: path.to_string(),
        branch: branch.map(String::from),
        outcome,
        message: message.to_string(),
    };
    let Some(b) = upstream.filter(|b| b.upstream_remote.is_some()) else {
        return result("skipped", "Not on the remote yet");
    };
    if b.behind == 0 {
        return result("up_to_date", "Up to date");
    }
    match run_git_cmd(path, &["status", "--porcelain"]) {
        Ok(s) if !s.is_empty() => return result("skipped", "Has uncommitted changes"),
        Err(e) => return result("failed", &e),
        _ => {}
    }
    if b.ahead > 0 {
        return result("skipped", "Has local commits too; pull it yourself to merge or rebase");
    }
    match run_git_cmd(path, &["merge", "--ff-only", "--quiet", "@{upstream}"]) {
        Ok(_) => result("pulled", &format!("Pulled {} commit{}", b.behind, if b.behind == 1 { "" } else { "s" })),
        Err(e) => result("failed", &e),
    }
}

// Fetches every remote once (pruning branches deleted on the remote), then,
// if `pull`, fast-forwards each clean worktree that's behind and has nothing
// of its own to push. Anything that would need a real merge is left alone
// and reported.
#[tauri::command]
pub async fn sync_all(repo_path: String, pull: bool) -> Result<Vec<SyncResult>, String> {
    run_blocking(move || {
        run_git_cmd(&repo_path, &["fetch", "--all", "--prune", "--quiet"])?;
        if !pull {
            return Ok(vec![]);
        }
        // Ahead/behind from the refs we just fetched.
        let branches = status::local_branches(&repo_path);
        let worktrees = worktree_branches(&repo_path)?;
        let results = std::thread::scope(|s| {
            let handles: Vec<_> = worktrees
                .iter()
                .map(|(path, branch)| {
                    let upstream = branch.as_ref().and_then(|b| branches.get(b));
                    s.spawn(move || match branch {
                        Some(b) => fast_forward(path, Some(b), upstream),
                        None => fast_forward(path, None, None),
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        Ok(results)
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub ok: bool,
    pub message: String,
    // Files with conflicts, when the merge or rebase stopped on them.
    pub conflicts: Vec<String>,
}

// A merge or rebase left half-done in this worktree, if any. One git call
// (to find this worktree's git dir), then plain file checks, since it runs
// for every worktree on load.
pub fn operation_in_progress(path: &str) -> Option<&'static str> {
    let git_dir = run_git_cmd(path, &["rev-parse", "--absolute-git-dir"]).ok()?;
    let dir = std::path::Path::new(&git_dir);
    if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
        Some("rebase")
    } else if dir.join("MERGE_HEAD").exists() {
        Some("merge")
    } else {
        None
    }
}

// Brings a worktree's branch up to date with `base` (e.g. develop) by merging
// it in or rebasing onto it. Uses the remote's copy of base after a fetch
// when there is one, since the local base branch is often stale.
#[tauri::command]
pub async fn update_from_base(path: String, base: String, rebase: bool) -> Result<UpdateOutcome, String> {
    run_blocking(move || {
        if let Some(op) = operation_in_progress(&path) {
            return Err(format!("A {op} is already in progress here. Finish or abort it first."));
        }
        if !run_git_cmd(&path, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
            return Err("Commit or stash your changes first.".to_string());
        }
        let _ = run_git_cmd(&path, &["fetch", "--quiet"]);
        let remote_base = format!("origin/{base}");
        let target = if run_git_cmd(&path, &["rev-parse", "--verify", "--quiet", &remote_base]).is_ok() {
            remote_base
        } else {
            base.clone()
        };

        let result = if rebase {
            run_git_cmd(&path, &["rebase", &target])
        } else {
            run_git_cmd(&path, &["merge", "--no-edit", &target])
        };
        match result {
            Ok(out) => {
                let message = if out.contains("up to date") || out.contains("up-to-date") {
                    format!("Already up to date with {target}")
                } else if rebase {
                    format!("Rebased onto {target}")
                } else {
                    format!("Merged {target}")
                };
                Ok(UpdateOutcome { ok: true, message, conflicts: vec![] })
            }
            Err(err) => {
                let conflicts: Vec<String> = run_git_cmd(&path, &["diff", "--name-only", "--diff-filter=U"])
                    .map(|s| s.lines().map(String::from).collect())
                    .unwrap_or_default();
                if conflicts.is_empty() && operation_in_progress(&path).is_none() {
                    // Failed before changing anything (e.g. unknown branch).
                    return Err(err);
                }
                let verb = if rebase { "Rebase" } else { "Merge" };
                Ok(UpdateOutcome {
                    ok: false,
                    message: format!("{verb} stopped on conflicts with {target}. Resolve them in your editor, or abort."),
                    conflicts,
                })
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn abort_update(path: String) -> Result<(), String> {
    run_blocking(move || match operation_in_progress(&path) {
        Some("rebase") => run_git_cmd(&path, &["rebase", "--abort"]).map(|_| ()),
        Some(_) => run_git_cmd(&path, &["merge", "--abort"]).map(|_| ()),
        None => Ok(()),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn git(cwd: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn commit(cwd: &Path, file: &str, text: &str) {
        std::fs::write(cwd.join(file), text).unwrap();
        git(cwd, &["add", "."]);
        git(cwd, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", text]);
    }

    // origin with develop; a clone; and worktrees on three branches tracking origin.
    fn setup(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("arbor-sync-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "--bare", "-b", "develop", "origin.git"]);
        git(&dir, &["clone", "-q", "origin.git", "repo"]);
        let repo = dir.join("repo");
        git(&repo, &["checkout", "-q", "-b", "develop"]);
        commit(&repo, "a.txt", "base");
        git(&repo, &["push", "-q", "-u", "origin", "develop"]);
        (dir, repo)
    }

    #[test]
    fn sync_all_fast_forwards_only_clean_branches_with_nothing_of_their_own() {
        let (dir, repo) = setup("all");
        for b in ["behind", "dirty", "diverged"] {
            git(&repo, &["branch", b]);
            git(&repo, &["push", "-q", "-u", "origin", b]);
            git(&repo, &["worktree", "add", "-q", dir.join(b).to_str().unwrap(), b]);
        }
        // Someone else pushes to each branch.
        git(&dir, &["clone", "-q", "origin.git", "other"]);
        let other = dir.join("other");
        for b in ["behind", "dirty", "diverged"] {
            git(&other, &["checkout", "-q", b]);
            commit(&other, &format!("{b}.txt"), &format!("remote change on {b}"));
            git(&other, &["push", "-q"]);
        }
        std::fs::write(dir.join("dirty/wip.txt"), "wip").unwrap();
        commit(&dir.join("diverged"), "local.txt", "local work");

        let results = tauri::async_runtime::block_on(sync_all(repo.to_str().unwrap().into(), true)).unwrap();
        let outcome = |b: &str| results.iter().find(|r| r.branch.as_deref() == Some(b)).map(|r| r.outcome).unwrap();
        assert_eq!(outcome("behind"), "pulled");
        assert_eq!(outcome("dirty"), "skipped");
        assert_eq!(outcome("diverged"), "skipped");
        assert_eq!(outcome("develop"), "up_to_date");
        assert!(dir.join("behind/behind.txt").exists(), "fast-forwarded on disk");
        assert!(!dir.join("dirty/dirty.txt").exists(), "dirty worktree untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_from_base_merges_and_reports_then_aborts_conflicts() {
        let (dir, repo) = setup("update");
        let wt = dir.join("feat");
        git(&repo, &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()]);
        commit(&wt, "a.txt", "feature edit");
        // develop moves on, on the remote, touching the same file.
        commit(&repo, "a.txt", "develop edit");
        commit(&repo, "b.txt", "develop extra");
        git(&repo, &["push", "-q"]);
        let wt_s = wt.to_str().unwrap().to_string();
        let run = |rebase| tauri::async_runtime::block_on(update_from_base(wt_s.clone(), "develop".into(), rebase));

        let out = run(false).unwrap();
        assert!(!out.ok);
        assert_eq!(out.conflicts, vec!["a.txt"]);
        assert_eq!(operation_in_progress(&wt_s), Some("merge"));
        assert!(run(true).unwrap_err().contains("already in progress"));

        tauri::async_runtime::block_on(abort_update(wt_s.clone())).unwrap();
        assert_eq!(operation_in_progress(&wt_s), None);
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "feature edit", "abort restored the branch");

        // Without a conflict, a rebase goes through.
        git(&wt, &["reset", "-q", "--hard", "HEAD~1"]);
        commit(&wt, "c.txt", "feature only");
        let out = run(true).unwrap();
        assert!(out.ok, "{}", out.message);
        assert!(wt.join("b.txt").exists(), "has develop's commits");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
