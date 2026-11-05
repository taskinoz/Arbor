use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// Process ids of running commands, keyed by the run id the UI chose, so a
// run can be stopped.
#[derive(Default)]
pub struct Running(Mutex<HashMap<String, u32>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    run_id: String,
    stderr: bool,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    run_id: String,
    // None when the process was killed by a signal (e.g. stopped from the UI).
    code: Option<i32>,
    error: Option<String>,
}

fn shell_args(shell: &str, command: &str) -> Vec<String> {
    let name = Path::new(shell).file_name().and_then(|n| n.to_str()).unwrap_or("");
    // A GUI app inherits a bare PATH. Interactive login shells read the user's
    // rc files, which is where nvm, asdf and friends put node/npm on PATH.
    if matches!(name, "zsh" | "bash" | "fish") {
        vec!["-l".into(), "-i".into(), "-c".into(), command.into()]
    } else {
        vec!["-c".into(), command.into()]
    }
}

fn shell_command(command: &str) -> Command {
    if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", command]);
        return cmd;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = Command::new(&shell);
    cmd.args(shell_args(&shell, command));
    cmd
}

// Forwards a reader to `emit` in chunks (not lines, so progress output that
// only uses \r still shows up), without splitting a multi-byte character
// across two chunks.
fn pump(mut reader: impl Read, mut emit: impl FnMut(String)) {
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => pending.extend_from_slice(&buf[..n]),
        }
        match std::str::from_utf8(&pending) {
            Ok(text) => {
                emit(text.to_string());
                pending.clear();
            }
            Err(e) if e.error_len().is_none() => {
                // Incomplete character at the end: hold it back for the next read.
                let valid = e.valid_up_to();
                if valid > 0 {
                    emit(String::from_utf8_lossy(&pending[..valid]).into_owned());
                    pending.drain(..valid);
                }
            }
            Err(_) => {
                emit(String::from_utf8_lossy(&pending).into_owned());
                pending.clear();
            }
        }
    }
    if !pending.is_empty() {
        emit(String::from_utf8_lossy(&pending).into_owned());
    }
}

// Runs `cmd` in `cwd` to completion, streaming output to `on_output`
// (true = stderr). The child leads its own process group so it can be
// stopped together with anything it spawned.
fn execute(
    mut cmd: Command,
    cwd: &str,
    on_started: impl FnOnce(u32),
    on_output: &(dyn Fn(bool, String) + Sync),
) -> Result<Option<i32>, String> {
    cmd.current_dir(cwd)
        .env("PATH", crate::augmented_path())
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start command: {e}"))?;
    on_started(child.id());
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    std::thread::scope(|scope| {
        scope.spawn(|| pump(stdout, |text| on_output(false, text)));
        scope.spawn(|| pump(stderr, |text| on_output(true, text)));
        child.wait().map(|status| status.code()).map_err(|e| format!("Failed waiting for command: {e}"))
    })
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

fn kill_tree(pid: u32) {
    #[cfg(unix)]
    // A negative pid signals the whole process group (SIGTERM = 15).
    unsafe {
        kill(-(pid as i32), 15);
    }
    #[cfg(windows)]
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}

// Only registered worktrees of the repo may be used as a working directory.
fn is_worktree_of(repo_path: &str, worktree_path: &str) -> Result<bool, String> {
    let listing = crate::run_git_cmd(repo_path, &["worktree", "list", "--porcelain"])?;
    Ok(listing
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .any(|path| path.trim() == worktree_path))
}

// Starts `command` in a worktree and returns once it has been launched; output
// and the final exit status arrive as `command-output` / `command-exit` events
// tagged with `run_id`.
#[tauri::command]
pub async fn run_command(
    app: AppHandle,
    repo_path: String,
    worktree_path: String,
    command: String,
    run_id: String,
) -> Result<(), String> {
    crate::run_blocking(move || {
        if command.trim().is_empty() {
            return Err("Command is empty".to_string());
        }
        if !is_worktree_of(&repo_path, &worktree_path)? {
            return Err("Not a worktree of this repository".to_string());
        }

        std::thread::spawn(move || {
            let result = execute(
                shell_command(&command),
                &worktree_path,
                |pid| {
                    app.state::<Running>().0.lock().unwrap().insert(run_id.clone(), pid);
                },
                &|stderr, text| {
                    let _ = app.emit("command-output", OutputEvent { run_id: run_id.clone(), stderr, text });
                },
            );
            app.state::<Running>().0.lock().unwrap().remove(&run_id);
            let (code, error) = match result {
                Ok(code) => (code, None),
                Err(message) => (None, Some(message)),
            };
            let _ = app.emit("command-exit", ExitEvent { run_id, code, error });
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn stop_command(app: AppHandle, run_id: String) {
    let pid = app.state::<Running>().0.lock().unwrap().get(&run_id).copied();
    if let Some(pid) = pid {
        kill_tree(pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    struct Chunked<'a>(&'a [u8], usize);

    impl Read for Chunked<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.0.len().min(self.1).min(buf.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }

    #[test]
    fn pump_keeps_multibyte_characters_whole() {
        let text = "héllo wörld ✓ 日本語";
        let mut chunks = Vec::new();
        // One byte per read splits every multi-byte character.
        pump(Chunked(text.as_bytes(), 1), |c| chunks.push(c));
        assert_eq!(chunks.concat(), text);
        assert!(chunks.iter().all(|c| !c.contains('\u{fffd}')), "{chunks:?}");
    }

    #[test]
    fn interactive_login_shell_only_for_shells_with_rc_files() {
        assert_eq!(shell_args("/bin/zsh", "npm i"), ["-l", "-i", "-c", "npm i"]);
        assert_eq!(shell_args("/usr/local/bin/fish", "x"), ["-l", "-i", "-c", "x"]);
        assert_eq!(shell_args("/bin/sh", "npm i"), ["-c", "npm i"]);
    }

    #[test]
    fn captures_both_streams_and_the_exit_code() {
        let out = Mutex::new(Vec::<(bool, String)>::new());
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo out; echo err 1>&2; pwd; exit 3"]);
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();

        let code = execute(cmd, dir.to_str().unwrap(), |_| {}, &|e, t| out.lock().unwrap().push((e, t))).unwrap();

        let out = out.into_inner().unwrap();
        let joined = |stderr: bool| out.iter().filter(|(e, _)| *e == stderr).map(|(_, t)| t.as_str()).collect::<String>();
        assert_eq!(code, Some(3));
        assert!(joined(false).starts_with("out\n"), "{out:?}");
        assert!(joined(false).contains(dir.to_str().unwrap()), "runs in the given directory: {out:?}");
        assert_eq!(joined(true), "err\n");
    }

    #[test]
    fn stopping_kills_children_the_shell_started() {
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 30 & sleep 30 & wait"]);
            execute(cmd, "/", |pid| tx.send(pid).unwrap(), &|_, _| {})
        });
        let pid = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let started = Instant::now();
        kill_tree(pid);
        let result = handle.join().unwrap();

        assert!(started.elapsed() < Duration::from_secs(5), "should stop promptly");
        assert_eq!(result, Ok(None), "killed by a signal, so no exit code");
    }

    #[test]
    fn only_registered_worktrees_are_accepted() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("arbor-cmd-{}", std::process::id()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |cwd: &Path, args: &[&str]| {
            let ok = Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = dir.join("wt");
        git(&repo, &["worktree", "add", "-q", "-b", "feature", wt.to_str().unwrap()]);

        let repo_s = repo.to_str().unwrap();
        assert_eq!(is_worktree_of(repo_s, wt.to_str().unwrap()), Ok(true));
        assert_eq!(is_worktree_of(repo_s, repo_s), Ok(true));
        assert_eq!(is_worktree_of(repo_s, "/etc"), Ok(false));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
