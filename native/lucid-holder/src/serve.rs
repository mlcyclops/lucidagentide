// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

//! The holder proper: start the agent, keep its stdout in the spool, serve one client at a time on the endpoint,
//! and end when told to, when the agent exited and its client has seen that, or when no client came back in time.

use crate::platform;
use crate::proto::{self, CLOSE_STDIN, ERR, EXIT, KILL, ORPHAN, OUT, STDIN, TRIM};
use crate::spool::Spool;
use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions, Stream};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use parking_lot::Mutex;
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Recent stderr kept for a client that attaches later (the engine quotes the last line of a failure).
const ERR_TAIL: usize = 64 * 1024;
/// Frames queued for a client before it counts as gone (it reattaches from its offset).
const CLIENT_QUEUE: usize = 4096;
/// How long a full queue may stall the agent's output before the client is dropped.
const CLIENT_STALL: Duration = Duration::from_secs(30);
const HANDSHAKE_MAX: usize = 4096;

pub struct Config {
    pub dir: PathBuf,
    pub id: String,
    pub cwd: Option<PathBuf>,
    pub orphan: Duration,
    pub program: OsString,
    pub args: Vec<OsString>,
    pub token: String,
}

struct Shared {
    spool: Spool,
    err_tail: Vec<u8>,
    exited: Option<i32>,
    /// The attached client: its generation and the queue its writer thread drains.
    client: Option<(u64, SyncSender<Vec<u8>>)>,
    next_gen: u64,
    /// Since when no client has been attached.
    detached_since: Option<Instant>,
    orphan: Duration,
    /// The client generation that was sent the exit frame.
    exit_seen_by: Option<u64>,
}

struct Holder {
    cfg: Config,
    endpoint: String,
    child_pid: u32,
    shared: Mutex<Shared>,
    stdin: Mutex<Option<ChildStdin>>,
}

pub fn ready_path(dir: &Path, id: &str) -> PathBuf { dir.join(format!("{id}.json")) }
pub fn error_path(dir: &Path, id: &str) -> PathBuf { dir.join(format!("{id}.err")) }
fn spool_path(dir: &Path, id: &str) -> PathBuf { dir.join(format!("{id}.spool")) }

fn random_hex() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for salt in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(salt);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Queue a frame for the attached client. A client whose queue stays full for CLIENT_STALL, or whose writer has
/// gone, is dropped; it comes back from the offset it last handled.
fn push(sh: &mut Shared, frame: Vec<u8>) {
    let Some((_, tx)) = sh.client.as_ref() else { return };
    let mut frame = frame;
    let started = Instant::now();
    loop {
        match tx.try_send(frame) {
            Ok(()) => return,
            Err(TrySendError::Full(f)) if started.elapsed() < CLIENT_STALL => {
                frame = f;
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => {
                sh.client = None;
                sh.detached_since = Some(Instant::now());
                return;
            }
        }
    }
}

/// End the agent's tree, remove every file this holder made, and exit.
fn shutdown(h: &Holder) -> ! {
    platform::end_tree(h.child_pid, &|| h.shared.lock().exited.is_some());
    let _ = fs::remove_file(ready_path(&h.cfg.dir, &h.cfg.id));
    let _ = fs::remove_file(spool_path(&h.cfg.dir, &h.cfg.id));
    if !cfg!(windows) {
        let _ = fs::remove_file(&h.endpoint);
    }
    std::process::exit(0);
}

fn write_ready(dir: &Path, id: &str, value: &Value) -> std::io::Result<()> {
    let tmp = dir.join(format!("{id}.json.tmp"));
    fs::write(&tmp, serde_json::to_vec(value)?)?;
    fs::rename(&tmp, ready_path(dir, id))
}

pub fn serve(cfg: Config) -> Result<(), String> {
    platform::own_tree().map_err(|e| format!("the agent's process tree cannot be owned: {e}"))?;
    let endpoint = platform::endpoint_for(&cfg.dir, &cfg.id, &random_hex()).map_err(|e| format!("endpoint: {e}"))?;
    if !cfg!(windows) {
        let _ = fs::remove_file(&endpoint); // a socket file left by a holder that died
    }
    let name = endpoint.as_str().to_fs_name::<GenericFilePath>().map_err(|e| format!("endpoint {endpoint}: {e}"))?;
    let listener = ListenerOptions::new().name(name).create_sync().map_err(|e| format!("endpoint {endpoint}: {e}"))?;
    let spool = Spool::create(&spool_path(&cfg.dir, &cfg.id)).map_err(|e| format!("spool: {e}"))?;

    let mut cmd = Command::new(&cfg.program);
    cmd.args(&cfg.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).env_remove("LUCID_HOLDER_TOKEN");
    if let Some(cwd) = &cfg.cwd {
        cmd.current_dir(cwd);
    }
    platform::prepare_child(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("the agent did not start: {e}"))?;
    let child_pid = child.id();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdin = child.stdin.take();

    let h = Arc::new(Holder {
        endpoint: endpoint.clone(),
        child_pid,
        stdin: Mutex::new(stdin),
        shared: Mutex::new(Shared {
            spool,
            err_tail: Vec::new(),
            exited: None,
            client: None,
            next_gen: 1,
            detached_since: Some(Instant::now()),
            orphan: cfg.orphan,
            exit_seen_by: None,
        }),
        cfg,
    });

    let out_thread = {
        let h = h.clone();
        thread::spawn(move || pump_stdout(&h, stdout))
    };
    {
        let h = h.clone();
        thread::spawn(move || pump_stderr(&h, stderr));
    }
    {
        let h = h.clone();
        thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
            let _ = out_thread.join(); // every stdout byte reaches the spool before the exit is told
            let mut sh = h.shared.lock();
            sh.exited = Some(code);
            if let Some((gen, _)) = sh.client {
                sh.exit_seen_by = Some(gen);
            }
            push(&mut sh, proto::encode(EXIT, &code.to_le_bytes()));
        });
    }
    {
        let h = h.clone();
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(stream) = conn else { continue };
                let h = h.clone();
                thread::spawn(move || attach(&h, stream));
            }
        });
    }

    write_ready(
        &h.cfg.dir,
        &h.cfg.id,
        &json!({ "v": 1, "id": h.cfg.id, "pid": std::process::id(), "childPid": child_pid, "endpoint": endpoint }),
    )
    .map_err(|e| format!("ready file: {e}"))?;

    loop {
        thread::sleep(Duration::from_millis(500));
        let gone_too_long = {
            let sh = h.shared.lock();
            sh.client.is_none() && sh.detached_since.map(|t| t.elapsed() >= sh.orphan).unwrap_or(false)
        };
        if gone_too_long {
            shutdown(&h);
        }
    }
}

fn pump_stdout(h: &Holder, mut out: impl Read) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match out.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let mut sh = h.shared.lock();
        // The spool is the record a returning client replays, so a write it refuses (disk full) cannot be
        // skipped: a gap would hand the client a broken JSON-RPC stream. The agent ends instead, visibly.
        if let Err(e) = sh.spool.append(&buf[..n]) {
            let why = format!("\nlucid-holder: the spool refused a write ({e}); the agent was ended\n");
            push(&mut sh, proto::encode(ERR, why.as_bytes()));
            drop(sh);
            thread::sleep(Duration::from_millis(200)); // let the writer deliver the reason
            shutdown(h);
        }
        push(&mut sh, proto::encode(OUT, &buf[..n]));
    }
}

fn pump_stderr(h: &Holder, mut err: impl Read) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match err.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let mut sh = h.shared.lock();
        sh.err_tail.extend_from_slice(&buf[..n]);
        if sh.err_tail.len() > ERR_TAIL {
            let cut = sh.err_tail.len() - ERR_TAIL;
            sh.err_tail.drain(..cut);
        }
        push(&mut sh, proto::encode(ERR, &buf[..n]));
    }
}

fn read_line(r: &mut impl Read) -> Option<String> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while line.len() < HANDSHAKE_MAX {
        match r.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => return String::from_utf8(line).ok(),
            Ok(1) => line.push(byte[0]),
            _ => return None,
        }
    }
    None
}

fn reply(send: &mut impl Write, value: Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(&value)?;
    line.push(b'\n');
    send.write_all(&line)?;
    send.flush()
}

/// One connection: the handshake (token, offset), the replay from that offset, then this client is THE client
/// (a newer attach replaces it) and its frames are read until it leaves.
fn attach(h: &Holder, stream: Stream) {
    // The handshake gets 5 seconds; the session itself may sit idle for hours. `&Stream` reads and writes, so
    // one Arc serves this reader and the writer thread (dropping either does not shut the connection).
    let _ = stream.set_recv_timeout(Some(Duration::from_secs(5)));
    let stream = Arc::new(stream);
    let mut recv = &*stream;
    let mut send = &*stream;
    let Some(line) = read_line(&mut recv) else { return };
    let hello: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    let token = hello.get("token").and_then(Value::as_str).unwrap_or("");
    if !proto::same_secret(token.as_bytes(), h.cfg.token.as_bytes()) {
        let _ = reply(&mut send, json!({ "v": 1, "ok": false, "error": "refused" }));
        return;
    }
    let Some(from) = hello.get("from").and_then(Value::as_u64) else {
        let _ = reply(&mut send, json!({ "v": 1, "ok": false, "error": "from is required" }));
        return;
    };

    let gen = {
        let mut sh = h.shared.lock();
        if from < sh.spool.base() || from > sh.spool.end() {
            let msg = format!("offset {from} is not kept (kept {} to {})", sh.spool.base(), sh.spool.end());
            let _ = reply(&mut send, json!({ "v": 1, "ok": false, "error": msg, "base": sh.spool.base(), "end": sh.spool.end() }));
            return;
        }
        let hello_ok = json!({
            "v": 1, "ok": true, "base": sh.spool.base(), "end": sh.spool.end(),
            "pid": std::process::id(), "childPid": h.child_pid, "exited": sh.exited,
        });
        // The replay is written here, under the lock, so no live frame can land between it and the stream.
        let replayed = reply(&mut send, hello_ok)
            .and_then(|_| sh.spool.read_from(from, |chunk| proto::write_frame(&mut send, OUT, chunk)))
            .and_then(|_| if sh.err_tail.is_empty() { Ok(()) } else { proto::write_frame(&mut send, ERR, &sh.err_tail) })
            .and_then(|_| match sh.exited { Some(code) => proto::write_frame(&mut send, EXIT, &code.to_le_bytes()), None => Ok(()) });
        if replayed.is_err() {
            return;
        }
        let gen = sh.next_gen;
        sh.next_gen += 1;
        if sh.exited.is_some() {
            sh.exit_seen_by = Some(gen);
        }
        let (tx, rx) = sync_channel::<Vec<u8>>(CLIENT_QUEUE);
        let out = stream.clone();
        thread::spawn(move || {
            let mut send = &*out;
            for frame in rx {
                if send.write_all(&frame).and_then(|_| send.flush()).is_err() {
                    return;
                }
            }
        });
        sh.client = Some((gen, tx)); // a previous client's queue closes, and with it its writer
        sh.detached_since = None;
        gen
    };
    let _ = stream.set_recv_timeout(None);

    loop {
        let frame = match proto::read_frame(&mut recv) {
            Ok(Some(f)) => f,
            _ => break,
        };
        let current = h.shared.lock().client.as_ref().map(|c| c.0) == Some(gen);
        if !current {
            return; // replaced by a newer attach: this connection no longer speaks for the engine
        }
        match frame {
            (STDIN, bytes) => {
                if let Some(stdin) = h.stdin.lock().as_mut() {
                    let _ = stdin.write_all(&bytes).and_then(|_| stdin.flush());
                }
            }
            (CLOSE_STDIN, _) => {
                h.stdin.lock().take();
            }
            (TRIM, p) => {
                if let Some(to) = proto::u64_of(&p) {
                    let _ = h.shared.lock().spool.trim(to);
                }
            }
            (ORPHAN, p) => {
                if let Some(ms) = proto::u64_of(&p) {
                    h.shared.lock().orphan = Duration::from_millis(ms);
                }
            }
            (KILL, _) => shutdown(h),
            _ => break, // an unknown frame: a client speaking another protocol
        }
    }

    let done = {
        let mut sh = h.shared.lock();
        if sh.client.as_ref().map(|c| c.0) == Some(gen) {
            sh.client = None;
            sh.detached_since = Some(Instant::now());
        }
        sh.exited.is_some() && sh.exit_seen_by == Some(gen)
    };
    if done {
        shutdown(h); // the agent is gone and its client has seen why
    }
}
