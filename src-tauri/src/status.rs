// Branch and remote status, split into a fast local pass and one batched
// network pass.
//
// Loading used to ask the remote about each branch separately (one
// `git ls-remote` per worktree, ~2.7s each) and ran a `gh` lookup before the
// tree could draw. Now `local_branches` + `commits` answer everything that
// can be known from local refs in two git calls, and `get_remote_info` makes
// one `ls-remote` per remote plus two `gh pr list` calls, all in parallel,
// which the UI runs in the background after the tree is already on screen.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

use crate::{augmented_path, run_blocking, run_git_cmd};

#[derive(Default, Debug, PartialEq)]
pub struct BranchRef {
    // Remote of the branch's upstream, but only when the upstream is a branch
    // of the same name. A branch created from `origin/develop` tracks develop
    // by git's default; that isn't a remote branch of its own.
    pub upstream_remote: Option<String>,
    // `git fetch --prune` saw the upstream deleted.
    pub gone: bool,
    // Relative to the local copy of the upstream, i.e. as of the last fetch.
    pub ahead: u32,
    pub behind: u32,
}

// Parses `%(upstream:track)`, e.g. "[ahead 1, behind 4]" or "[gone]".
fn parse_track(track: &str) -> (bool, u32, u32) {
    let count = |word: &str| {
        track
            .split(word)
            .nth(1)
            .and_then(|rest| rest.trim_start().split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    };
    (track.contains("gone"), count("ahead"), count("behind"))
}

// Upstream info for every local branch in one `for-each-ref`.
pub fn local_branches(repo_path: &str) -> HashMap<String, BranchRef> {
    let format = "--format=%(refname)%00%(upstream:remoteref)%00%(upstream:remotename)%00%(upstream:track)";
    let Ok(output) = run_git_cmd(repo_path, &["for-each-ref", format, "refs/heads"]) else {
        return HashMap::new();
    };
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{0}');
            let refname = parts.next()?;
            let remote_ref = parts.next().unwrap_or("");
            let remote = parts.next().unwrap_or("");
            let track = parts.next().unwrap_or("");
            let name = refname.strip_prefix("refs/heads/")?.to_string();
            let own = remote_ref == refname && !remote.is_empty() && remote != ".";
            let (gone, ahead, behind) = parse_track(track);
            let info = if own {
                BranchRef { upstream_remote: Some(remote.to_string()), gone, ahead, behind }
            } else {
                BranchRef::default()
            };
            Some((name, info))
        })
        .collect()
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct CommitInfo {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub time_ms: u64,
}

// Last commit for each HEAD in one `git log` (works for detached HEADs too).
pub fn commits(repo_path: &str, shas: &[String]) -> HashMap<String, CommitInfo> {
    let shas: Vec<&str> = shas.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
    if shas.is_empty() {
        return HashMap::new();
    }
    let mut args = vec!["log", "--no-walk=unsorted", "--format=%H%x00%at%x00%an%x00%s"];
    args.extend(shas);
    let Ok(output) = run_git_cmd(repo_path, &args) else {
        return HashMap::new();
    };
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\u{0}');
            let sha = parts.next()?.to_string();
            let time_ms = parts.next()?.parse::<u64>().ok()? * 1000;
            let author = parts.next()?.to_string();
            let subject = parts.next().unwrap_or("").to_string();
            Some((sha.clone(), CommitInfo { sha, subject, author, time_ms }))
        })
        .collect()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    // OPEN, MERGED or CLOSED.
    pub state: String,
    pub is_draft: bool,
    pub url: String,
    // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or None.
    pub review: Option<String>,
    // passing, failing or pending; None when there are no checks (or it
    // isn't open, since checks are only fetched for open PRs).
    pub checks: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    // Branch names that exist right now on each remote that answered.
    // A remote that couldn't be reached (offline) is simply absent.
    pub remote_heads: HashMap<String, Vec<String>>,
    // Latest same-repo PR per head branch; None when `gh` isn't available.
    pub prs: Option<HashMap<String, PrInfo>>,
}

fn gh_json(repo_path: &str, args: &[&str]) -> Option<Vec<serde_json::Value>> {
    let out = std::process::Command::new("gh")
        .args(args)
        .current_dir(repo_path)
        .env("PATH", augmented_path())
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    serde_json::from_slice(&out.stdout).ok()
}

// Collapses a PR's `statusCheckRollup` into one word.
fn summarize_checks(rollup: &serde_json::Value) -> Option<String> {
    let items = rollup.as_array().filter(|a| !a.is_empty())?;
    let field = |item: &serde_json::Value, key: &str| item.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut pending = false;
    for item in items {
        // Check runs have status + conclusion; commit statuses have state.
        let state = field(item, "state");
        let conclusion = field(item, "conclusion");
        let status = field(item, "status");
        let verdict = if !state.is_empty() { state } else { conclusion };
        if ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].contains(&verdict.as_str()) {
            return Some("failing".into());
        }
        if verdict == "PENDING" || verdict == "EXPECTED" || (!status.is_empty() && status != "COMPLETED") {
            pending = true;
        }
    }
    Some(if pending { "pending" } else { "passing" }.into())
}

// ponytail: latest 200 PRs (any state) and 100 open ones; page if a repo outgrows that.
fn pull_requests(repo_path: &str) -> Option<HashMap<String, PrInfo>> {
    let (all, open) = std::thread::scope(|s| {
        let all = s.spawn(|| {
            gh_json(repo_path, &[
                "pr", "list", "--state", "all", "--limit", "200",
                "--json", "number,headRefName,state,isDraft,url,reviewDecision,isCrossRepository",
            ])
        });
        let open = s.spawn(|| {
            gh_json(repo_path, &["pr", "list", "--state", "open", "--limit", "100", "--json", "number,statusCheckRollup"])
        });
        (all.join().ok().flatten(), open.join().ok().flatten())
    });
    let all = all?;
    let checks: HashMap<u64, Option<String>> = open
        .unwrap_or_default()
        .iter()
        .filter_map(|pr| Some((pr.get("number")?.as_u64()?, summarize_checks(pr.get("statusCheckRollup")?))))
        .collect();

    let mut prs = HashMap::new();
    // gh lists newest first, so the first PR seen for a branch is its latest.
    for pr in &all {
        // A fork's PR from its own `main` isn't about our `main`.
        if pr.get("isCrossRepository").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let (Some(head), Some(number)) = (pr.get("headRefName").and_then(|v| v.as_str()), pr.get("number").and_then(|v| v.as_u64())) else {
            continue;
        };
        if prs.contains_key(head) {
            continue;
        }
        let text = |key: &str| pr.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let review = Some(text("reviewDecision")).filter(|r| !r.is_empty());
        prs.insert(head.to_string(), PrInfo {
            number,
            state: text("state"),
            is_draft: pr.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
            url: text("url"),
            review,
            checks: checks.get(&number).cloned().flatten(),
        });
    }
    Some(prs)
}

fn remote_heads(repo_path: &str, remote: &str) -> Option<Vec<String>> {
    let output = run_git_cmd(repo_path, &["ls-remote", "--heads", remote]).ok()?;
    Some(
        output
            .lines()
            .filter_map(|line| line.split('\t').nth(1)?.strip_prefix("refs/heads/").map(String::from))
            .collect(),
    )
}

#[tauri::command]
pub async fn get_remote_info(repo_path: String) -> Result<RemoteInfo, String> {
    run_blocking(move || {
        // Only remotes some branch actually tracks; usually just origin.
        let remotes: HashSet<String> = local_branches(&repo_path).into_values().filter_map(|b| b.upstream_remote).collect();
        let repo = repo_path.as_str();
        Ok(std::thread::scope(|s| {
            let prs = s.spawn(move || pull_requests(repo));
            let heads: Vec<_> = remotes
                .iter()
                .map(|remote| (remote.clone(), s.spawn(move || remote_heads(repo, remote))))
                .collect();
            RemoteInfo {
                remote_heads: heads
                    .into_iter()
                    .filter_map(|(remote, h)| Some((remote, h.join().ok()??)))
                    .collect(),
                prs: prs.join().ok().flatten(),
            }
        }))
    })
    .await
}

// Total size of a folder on disk, without following symlinks (so a symlinked
// node_modules or .env isn't counted twice).
#[tauri::command]
pub async fn get_dir_size(path: String) -> Result<u64, String> {
    fn walk(dir: &std::path::Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
        entries
            .flatten()
            .map(|entry| match entry.file_type() {
                Ok(t) if t.is_dir() => walk(&entry.path()),
                Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
                _ => 0,
            })
            .sum()
    }
    run_blocking(move || Ok(walk(std::path::Path::new(&path)))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_track() {
        assert_eq!(parse_track("[ahead 1, behind 4]"), (false, 1, 4));
        assert_eq!(parse_track("[behind 12]"), (false, 0, 12));
        assert_eq!(parse_track("[gone]"), (true, 0, 0));
        assert_eq!(parse_track(""), (false, 0, 0));
    }

    #[test]
    fn summarizes_checks() {
        let done = |c: &str| json!({"status": "COMPLETED", "conclusion": c});
        assert_eq!(summarize_checks(&json!([])), None);
        assert_eq!(summarize_checks(&json!([done("SUCCESS"), done("SKIPPED")])), Some("passing".into()));
        assert_eq!(summarize_checks(&json!([done("SUCCESS"), {"status": "IN_PROGRESS", "conclusion": ""}])), Some("pending".into()));
        assert_eq!(summarize_checks(&json!([{"status": "QUEUED"}, done("FAILURE")])), Some("failing".into()));
        assert_eq!(summarize_checks(&json!([{"state": "PENDING"}])), Some("pending".into()));
        assert_eq!(summarize_checks(&json!([{"state": "ERROR"}])), Some("failing".into()));
    }

    #[test]
    fn local_branches_and_commits_from_a_real_repo() {
        let dir = std::env::temp_dir().join(format!("arbor-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(["-c", "user.name=Ada", "-c", "user.email=a@a"])
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&dir, &["init", "-q", "--bare", "origin.git"]);
        git(&dir, &["clone", "-q", "origin.git", "repo"]);
        let repo = dir.join("repo");
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git(&repo, &["push", "-q", "-u", "origin", "HEAD:develop"]);
        git(&repo, &["checkout", "-q", "-b", "feat", "--track", "origin/develop"]);
        git(&repo, &["checkout", "-q", "-b", "own"]);
        git(&repo, &["push", "-q", "-u", "origin", "own"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "unpushed: fix the thing"]);
        let r = repo.to_str().unwrap();

        let branches = local_branches(r);
        assert_eq!(branches["own"], BranchRef { upstream_remote: Some("origin".into()), gone: false, ahead: 1, behind: 0 });
        assert_eq!(branches["feat"], BranchRef::default(), "tracking develop isn't an upstream of its own");

        let head = run_git_cmd(r, &["rev-parse", "HEAD"]).unwrap();
        let c = &commits(r, &[head.clone()])[&head];
        assert_eq!((c.subject.as_str(), c.author.as_str()), ("unpushed: fix the thing", "Ada"));
        assert!(c.time_ms > 1_600_000_000_000);

        assert_eq!(remote_heads(r, "origin").map(|mut h| { h.sort(); h }), Some(vec!["develop".to_string(), "own".to_string()]));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
