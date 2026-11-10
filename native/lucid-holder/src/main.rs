// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

//! lucid-holder (P-HOLDER.1, ADR-0534): one lane's agent process, owned outside the engine.
//!
//!   lucid-holder run --dir <dir> --id <id> [--cwd <dir>] [--orphan-ms <ms>] -- <program> [args...]
//!
//! `run` starts a detached holder (`serve`, the same binary) that starts the agent with piped stdio, keeps
//! everything the agent writes to stdout in `<dir>/<id>.spool`, and serves one client at a time on a local
//! endpoint (a named pipe on Windows, `<dir>/<id>.sock` elsewhere). `run` prints the holder's ready record
//! (`{"v":1,"id","pid","childPid","endpoint"}`, also kept in `<dir>/<id>.json`) and exits, so the engine that
//! called it is never the holder's parent: a tree kill of the engine does not reach the agent.
//!
//! The attach token comes from LUCID_HOLDER_TOKEN (at least 32 characters); the agent never sees it. A client
//! sends one JSON line `{"v":1,"token","from":<offset>}` and then speaks the frames in proto.rs.
//! `<dir>` must already exist and be private to the account (the engine makes it 0700).

mod platform;
mod proto;
mod serve;
mod spool;

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

/// A holder no client comes back to for this long ends the agent (the engine sets a shorter time per lane).
const DEFAULT_ORPHAN_MS: u64 = 24 * 60 * 60 * 1000;
const READY_WAIT: Duration = Duration::from_secs(20);

struct Args {
    dir: PathBuf,
    id: String,
    cwd: Option<PathBuf>,
    orphan_ms: u64,
    program: OsString,
    args: Vec<OsString>,
}

fn parse(mut it: impl Iterator<Item = OsString>) -> Result<Args, String> {
    let (mut dir, mut id, mut cwd, mut orphan_ms) = (None, None, None, DEFAULT_ORPHAN_MS);
    loop {
        let Some(flag) = it.next() else { return Err("missing `-- <program>`".into()) };
        let flag = flag.to_string_lossy().into_owned();
        if flag == "--" {
            break;
        }
        let value = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--dir" => dir = Some(PathBuf::from(value)),
            "--id" => id = Some(value.to_string_lossy().into_owned()),
            "--cwd" => cwd = Some(PathBuf::from(value)),
            "--orphan-ms" => orphan_ms = value.to_string_lossy().parse().map_err(|_| "--orphan-ms is a number of milliseconds")?,
            other => return Err(format!("unknown option {other}")),
        }
    }
    let program = it.next().ok_or("missing the program after --")?;
    let id = id.ok_or("--id is required")?;
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("--id is 1 to 64 letters, digits or hyphens".into());
    }
    let dir = dir.ok_or("--dir is required")?;
    if !dir.is_dir() {
        return Err(format!("--dir {} is not a folder", dir.display()));
    }
    Ok(Args { dir, id, cwd, orphan_ms, program, args: it.collect() })
}

fn token() -> Result<String, String> {
    let t = std::env::var("LUCID_HOLDER_TOKEN").map_err(|_| "LUCID_HOLDER_TOKEN is not set")?;
    if t.len() < 32 {
        return Err("LUCID_HOLDER_TOKEN is shorter than 32 characters".into());
    }
    Ok(t)
}

/// `run`: start `serve` detached and wait for its ready record.
fn run(raw: Vec<OsString>, a: &Args) -> Result<String, String> {
    token()?;
    let ready = serve::ready_path(&a.dir, &a.id);
    let error = serve::error_path(&a.dir, &a.id);
    if ready.exists() {
        return Err(format!("a holder for {} is already running ({})", a.id, ready.display()));
    }
    let _ = std::fs::remove_file(&error);
    let exe = std::env::current_exe().map_err(|e| format!("cannot find this program: {e}"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("serve").args(raw).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = platform::spawn_detached(&mut cmd).map_err(|e| format!("the holder did not start: {e}"))?;
    let until = Instant::now() + READY_WAIT;
    while Instant::now() < until {
        if let Ok(text) = std::fs::read_to_string(&ready) {
            return Ok(text);
        }
        if let Ok(Some(status)) = child.try_wait() {
            let why = std::fs::read_to_string(&error).unwrap_or_else(|_| format!("the holder exited ({status})"));
            let _ = std::fs::remove_file(&error);
            return Err(why);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("the holder did not become ready in 20 seconds".into())
}

fn main() -> ExitCode {
    let mut it = std::env::args_os().skip(1);
    let mode = it.next().map(|m| m.to_string_lossy().into_owned()).unwrap_or_default();
    if mode == "--version" {
        println!("lucid-holder {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    if mode != "run" && mode != "serve" {
        eprintln!("usage: lucid-holder run --dir <dir> --id <id> [--cwd <dir>] [--orphan-ms <ms>] -- <program> [args...]");
        return ExitCode::from(2);
    }
    let raw: Vec<OsString> = it.collect();
    let a = match parse(raw.clone().into_iter()) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("lucid-holder: {e}");
            return ExitCode::from(2);
        }
    };
    if mode == "run" {
        return match run(raw, &a) {
            Ok(ready) => {
                println!("{ready}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("lucid-holder: {e}");
                ExitCode::FAILURE
            }
        };
    }
    let result = token().and_then(|token| {
        serve::serve(serve::Config {
            dir: a.dir.clone(),
            id: a.id.clone(),
            cwd: a.cwd.clone(),
            orphan: Duration::from_millis(a.orphan_ms),
            program: a.program.clone(),
            args: a.args.clone(),
            token,
        })
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // `run` is waiting for either the ready record or this.
            let _ = std::fs::write(serve::error_path(&a.dir, &a.id), &e);
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(v: &[&str]) -> std::vec::IntoIter<OsString> { v.iter().map(OsString::from).collect::<Vec<_>>().into_iter() }

    #[test]
    fn parses_options_and_keeps_the_program_arguments_verbatim() {
        let dir = std::env::temp_dir();
        let d = dir.to_string_lossy().into_owned();
        let a = parse(os(&["--dir", &d, "--id", "lane-1a2b3c4d", "--orphan-ms", "600000", "--", "omp", "acp", "--flag", "--"])).unwrap();
        assert_eq!((a.id.as_str(), a.orphan_ms, a.program.to_str()), ("lane-1a2b3c4d", 600000, Some("omp")));
        assert_eq!(a.args, vec![OsString::from("acp"), OsString::from("--flag"), OsString::from("--")]);
    }

    #[test]
    fn refuses_ids_that_could_leave_the_folder_and_missing_pieces() {
        let d = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(parse(os(&["--dir", &d, "--id", "../x", "--", "omp"])).is_err());
        assert!(parse(os(&["--dir", &d, "--id", "a b", "--", "omp"])).is_err());
        assert!(parse(os(&["--dir", &d, "--id", "ok"])).is_err());
        assert!(parse(os(&["--dir", &d, "--", "omp"])).is_err());
        assert!(parse(os(&["--dir", "/definitely/not/here", "--id", "ok", "--", "omp"])).is_err());
    }
}
