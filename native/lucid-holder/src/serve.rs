// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

//! The holder proper: start the agent, keep its stdout in the spool, serve one client at a time on the endpoint,
//! and end when told to, when the agent exited and its client has seen that, or when no client came back in time.

use crate::platform;
use crate::proto::{self, CLOSE_STDIN, ERR, EXIT, KILL, ORPHAN, OUT, STDIN, TRIM};
use crate::spool::Spool;
use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions, Stream};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Recent stderr kept for a client that attaches later (the engine quotes the last line of a failure).
const ERR_TAIL: usize = 64 * 1024;
/// The most bytes queued for a client before it counts as gone. It is then cut off (both halves of its connection,
/// so it sees the close) and comes back from the offset it last handled; the spool has every byte. This bounds what
/// one slow client costs the holder in memory.
const CLIENT_QUEUE_BYTES: usize = 8 * 1024 * 1024;
const HANDSHAKE_MAX: usize = 4096;
/// How long a connection may take to finish the handshake; one that stalls is closed (LH-04).
const HANDSHAKE_TIME: Duration = Duration::from_secs(5);
/// LH-08: the most agent output the spool keeps at once. A turn that writes more loses its oldest output (only a
/// client that comes back from before the cut misses it, and it is told so); the disk use stays bounded.
const SPOOL_CAP: u64 = 128 * 1024 * 1024;

pub struct Config {
    pub dir: PathBuf,
    pub id: String,
    pub cwd: Option<PathBuf>,
    pub orphan: Duration,
    pub program: OsString,
    pub args: Vec<OsString>,
    pub token: String,
}

/// One client connection. `cut` is declared first, so it is dropped (its watchdog stopped) before the stream closes.
struct Conn {
    cut: platform::Cutter,
    stream: Stream,
}

/// The attached client: its generation, the queue its writer thread drains, the bytes in that queue, its connection.
struct Client {
    gen: u64,
    tx: Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    conn: Arc<Conn>,
}

struct Shared {
    spool: Spool,
    err_tail: Vec<u8>,
    exited: Option<i32>,
    client: Option<Client>,
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

/// Queue a frame for the attached client. Never waits while the lock is held: a client whose queue would pass
/// CLIENT_QUEUE_BYTES, or whose writer has gone, is cut off at once (both halves of its connection, so its reader
/// here lets go and the client sees the close); it comes back from the offset it last handled.
fn push(sh: &mut Shared, frame: Vec<u8>) {
    let Some(c) = sh.client.as_ref() else { return };
    let len = frame.len();
    let over = c.queued.fetch_add(len, Ordering::AcqRel) + len > CLIENT_QUEUE_BYTES;
    if over || c.tx.send(frame).is_err() {
        c.conn.cut.cut();
        sh.client = None;
        sh.detached_since = Some(Instant::now());
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

fn write_ready(dir: &Path, id: &str, value: &Value) -> io::Result<()> {
    let tmp = dir.join(format!("{id}.json.tmp"));
    fs::write(&tmp, serde_json::to_vec(value)?)?;
    fs::rename(&tmp, ready_path(dir, id))
}

pub fn serve(cfg: Config) -> Result<(), String> {
    platform::own_tree().map_err(|e| format!("the agent's process tree cannot be owned: {e}"))?;
    let nonce = proto::random_hex(16).map_err(|e| format!("the OS random source: {e}"))?;
    let endpoint = platform::endpoint_for(&cfg.dir, &cfg.id, &nonce).map_err(|e| format!("endpoint: {e}"))?;
    if !cfg!(windows) {
        let _ = fs::remove_file(&endpoint); // a socket file left by a holder that died
    }
    let name = endpoint.as_str().to_fs_name::<GenericFilePath>().map_err(|e| format!("endpoint {endpoint}: {e}"))?;
    let listener = platform::private_endpoint(ListenerOptions::new().name(name))
        .and_then(|o| o.create_sync())
        .map_err(|e| format!("endpoint {endpoint}: {e}"))?;
    let spool = Spool::create(&spool_path(&cfg.dir, &cfg.id), SPOOL_CAP).map_err(|e| format!("spool: {e}"))?;

    let mut cmd = Command::new(&cfg.program);
    cmd.args(&cfg.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
            // LH-07: on POSIX the agent is not reaped here, so its pid (and its process group id) cannot be handed to
            // another process before shutdown's group kill; the holder's exit hands the zombie to init.
            let code = platform::wait_unreaped(&mut child);
            let _ = out_thread.join(); // every stdout byte reaches the spool before the exit is told
            let mut sh = h.shared.lock();
            sh.exited = Some(code);
            let gen = sh.client.as_ref().map(|c| c.gen);
            if gen.is_some() {
                sh.exit_seen_by = gen;
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

/// LH-08: where a replay asked for at `from` starts. A `from` inside what the cap dropped (below `capped`, which is
/// at most `base`) moves up to `base`; anything else stays as asked (and is refused if it is not kept).
fn replay_start(from: u64, base: u64, capped: u64) -> u64 {
    if from < capped { base } else { from }
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

fn reply(send: &mut impl Write, value: Value) -> io::Result<()> {
    let mut line = serde_json::to_vec(&value)?;
    line.push(b'\n');
    send.write_all(&line)?;
    send.flush()
}

fn refuse(send: &mut impl Write, why: &str) -> Option<u64> {
    let _ = reply(send, json!({ "v": proto::HANDSHAKE, "ok": false, "error": why }));
    None
}

/// Handshake v2 (proto.rs): the client's nonce; this holder's proof over it and a nonce of its own (`ours`); the
/// client's proof over that, and the offset to replay from. The token never crosses the endpoint, and nothing of the
/// agent's output goes to a client before it proved it holds the token. Returns the offset, or None once the client
/// was refused (or left).
fn handshake(token: &[u8], ours: &str, recv: &mut impl Read, send: &mut impl Write) -> Option<u64> {
    let hello: Value = serde_json::from_str(&read_line(recv)?).unwrap_or(Value::Null);
    if hello.get("v").and_then(Value::as_u64) != Some(proto::HANDSHAKE) {
        return refuse(send, &format!("this lucid-holder speaks handshake v{}; the client must come from the same build", proto::HANDSHAKE));
    }
    let Some(theirs) = hello.get("nonce").and_then(Value::as_str).filter(|n| proto::is_nonce(n)) else {
        return refuse(send, "a nonce is required");
    };
    reply(send, json!({ "v": proto::HANDSHAKE, "nonce": ours, "proof": proto::proof(token, "holder", theirs) })).ok()?;
    let answer: Value = serde_json::from_str(&read_line(recv)?).unwrap_or(Value::Null);
    let proof = answer.get("proof").and_then(Value::as_str).unwrap_or("");
    if !proto::same_secret(proof.as_bytes(), proto::proof(token, "engine", ours).as_bytes()) {
        return refuse(send, "refused");
    }
    let Some(from) = answer.get("from").and_then(Value::as_u64) else {
        return refuse(send, "from is required");
    };
    Some(from)
}

/// What a new client gets before the live queue: its hello, the cap marker, the kept bytes from its offset, the
/// stderr tail and the exit. The replay file is taken by value and closed before the live stream starts: a client
/// that stays attached must not keep it open, or Windows refuses every later spool cut and trim (a file someone
/// reads cannot be replaced).
fn send_snapshot(send: &mut impl Write, replay: (File, u64), hello: Value, marker: Option<String>, err_tail: &[u8], exited: Option<i32>) -> io::Result<()> {
    let (mut file, mut left) = replay;
    reply(send, hello)?;
    if let Some(marker) = marker {
        proto::write_frame(send, ERR, marker.as_bytes())?;
    }
    let mut buf = vec![0u8; 64 * 1024];
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        proto::write_frame(send, OUT, &buf[..n])?;
        left -= n as u64;
    }
    drop(file);
    if !err_tail.is_empty() {
        proto::write_frame(send, ERR, err_tail)?;
    }
    if let Some(code) = exited {
        proto::write_frame(send, EXIT, &code.to_le_bytes())?;
    }
    Ok(())
}

/// One connection: the handshake (proofs, offset), the replay from that offset, then this client is THE client
/// (a newer attach replaces it) and its frames are read until it leaves.
fn attach(h: &Holder, stream: Stream) {
    // The handshake gets 5 seconds (a receive timeout on Unix, a watchdog on Windows, whose pipes ignore receive
    // timeouts); the session itself may sit idle for hours. `&Stream` reads and writes, so one Arc serves this
    // reader and the writer thread (dropping either does not shut the connection; a cut does).
    let _ = stream.set_recv_timeout(Some(HANDSHAKE_TIME));
    let conn = Arc::new(Conn { cut: platform::Cutter::new(&stream), stream });
    // Declared after the connection, so it is dropped (and its watchdog stopped) before the stream can close.
    let deadline = platform::Deadline::arm(&conn.stream, HANDSHAKE_TIME);
    let mut recv = &conn.stream;
    let mut send = &conn.stream;
    let Ok(ours) = proto::random_hex(16) else {
        refuse(&mut send, "the holder has no random source");
        return;
    };
    let from = handshake(h.cfg.token.as_bytes(), &ours, &mut recv, &mut send);
    if !deadline.disarm() {
        return;
    }
    let Some(from) = from else { return };

    let gen = {
        let mut sh = h.shared.lock();
        // LH-08: bytes the spool cap dropped (not ones a client trimmed) are gone for good; a client that comes back
        // from before the cut gets the replay from the oldest kept byte, a line start, and is told what it missed.
        let asked = from;
        let from = replay_start(from, sh.spool.base(), sh.spool.capped());
        let dropped = from - asked;
        if from < sh.spool.base() || from > sh.spool.end() {
            let msg = format!("offset {from} is not kept (kept {} to {})", sh.spool.base(), sh.spool.end());
            let _ = reply(&mut send, json!({ "v": proto::HANDSHAKE, "ok": false, "error": msg, "base": sh.spool.base(), "end": sh.spool.end() }));
            return;
        }
        let hello_ok = json!({
            "v": proto::HANDSHAKE, "ok": true, "base": sh.spool.base(), "end": sh.spool.end(),
            "pid": std::process::id(), "childPid": h.child_pid, "exited": sh.exited,
            "from": from, "dropped": dropped,
        });
        let marker = (dropped > 0).then(|| {
            format!(
                "\nlucid-holder: this turn's output passed the spool cap of {} MiB; its bytes {asked} to {from} were dropped, and the replay starts at {from}\n",
                sh.spool.cap() / (1024 * 1024)
            )
        });
        // LH-05: only a snapshot is taken under the lock (a reader over the kept bytes up to now, the stderr tail,
        // the exit), and the client is registered in the same step, so every later byte lands in its queue. The
        // writer thread streams the snapshot first, then the queue: nothing is lost or reordered, and a client that
        // stops reading stalls only its own thread, never the agent's output, KILL or the orphan timer.
        let Ok(replay) = sh.spool.reader(from) else {
            let _ = reply(&mut send, json!({ "v": proto::HANDSHAKE, "ok": false, "error": "the spool cannot be read" }));
            return;
        };
        let err_tail = sh.err_tail.clone();
        let exited = sh.exited;
        let gen = sh.next_gen;
        sh.next_gen += 1;
        if exited.is_some() {
            sh.exit_seen_by = Some(gen);
        }
        let (tx, rx) = channel::<Vec<u8>>();
        let queued = Arc::new(AtomicUsize::new(0));
        let drained = queued.clone();
        let out = conn.clone();
        thread::spawn(move || {
            let mut send = &out.stream;
            if send_snapshot(&mut send, replay, hello_ok, marker, &err_tail, exited).is_err() {
                return;
            }
            for frame in rx {
                if send.write_all(&frame).and_then(|_| send.flush()).is_err() {
                    return;
                }
                drained.fetch_sub(frame.len(), Ordering::AcqRel);
            }
        });
        sh.client = Some(Client { gen, tx, queued, conn: conn.clone() }); // a previous client's queue closes, and with it its writer
        sh.detached_since = None;
        gen
    };
    let _ = conn.stream.set_recv_timeout(None);

    loop {
        let frame = match proto::read_frame(&mut recv) {
            Ok(Some(f)) => f,
            _ => break,
        };
        // LH-05: the kill switch works from any connection that passed the handshake, current or not.
        if frame.0 == KILL {
            shutdown(h);
        }
        let current = h.shared.lock().client.as_ref().map(|c| c.gen) == Some(gen);
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
        if sh.client.as_ref().map(|c| c.gen) == Some(gen) {
            sh.client = None;
            sh.detached_since = Some(Instant::now());
        }
        sh.exited.is_some() && sh.exit_seen_by == Some(gen)
    };
    if done {
        shutdown(h); // the agent is gone and its client has seen why
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OURS: &str = "ffeeddccbbaa99887766554433221100";
    const THEIRS: &str = "00112233445566778899aabbccddeeff";

    /// The handshake over in-memory streams: what it returned, and every line it sent.
    fn shake(client: &str) -> (Option<u64>, Vec<Value>) {
        let mut recv = client.as_bytes();
        let mut sent = Vec::new();
        let from = handshake(TOKEN.as_bytes(), OURS, &mut recv, &mut sent);
        let text = String::from_utf8(sent).unwrap();
        assert!(!text.contains(TOKEN), "the token never crosses the endpoint");
        (from, text.lines().map(|l| serde_json::from_str(l).unwrap()).collect())
    }

    #[test]
    fn only_bytes_the_cap_dropped_move_a_replay_forward() {
        assert_eq!(replay_start(10, 40, 40), 40, "inside the capped range: from the oldest kept byte");
        assert_eq!(replay_start(40, 40, 40), 40);
        assert_eq!(replay_start(45, 40, 40), 45, "kept: as asked");
        // A client trim moved base past the cap's cut: an offset it trimmed stays refused, not silently moved.
        assert_eq!(replay_start(50, 60, 40), 50);
        assert_eq!(replay_start(5, 60, 0), 5, "the cap never cut: as asked");
    }

    #[test]
    fn the_holder_proves_itself_first_and_takes_the_offset_only_from_a_client_that_proved_itself() {
        let engine = proto::proof(TOKEN.as_bytes(), "engine", OURS);
        let (from, sent) = shake(&format!("{}\n{}\n", json!({ "v": 2, "nonce": THEIRS }), json!({ "v": 2, "proof": engine, "from": 7 })));
        assert_eq!(from, Some(7));
        assert_eq!(sent.len(), 1, "the hello is sent by the caller, after the handshake");
        assert_eq!(sent[0]["nonce"], OURS);
        assert_eq!(sent[0]["proof"], proto::proof(TOKEN.as_bytes(), "holder", THEIRS));
    }

    #[test]
    fn a_client_that_cannot_prove_the_token_is_refused_after_the_challenge() {
        // A replayed holder proof is not an engine proof.
        let reflected = proto::proof(TOKEN.as_bytes(), "holder", OURS);
        let (from, sent) = shake(&format!("{}\n{}\n", json!({ "v": 2, "nonce": THEIRS }), json!({ "v": 2, "proof": reflected, "from": 0 })));
        assert_eq!(from, None);
        assert_eq!((sent.len(), &sent[1]["ok"], &sent[1]["error"]), (2, &json!(false), &json!("refused")));
    }

    #[test]
    fn a_client_of_another_handshake_or_without_a_nonce_is_refused_at_once() {
        let (from, sent) = shake(&format!("{}\n", json!({ "v": 1, "token": TOKEN, "from": 0 })));
        assert_eq!(from, None);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["ok"], json!(false));
        assert!(sent[0]["error"].as_str().unwrap().contains("handshake v2"));
        let (from, sent) = shake(&format!("{}\n", json!({ "v": 2, "nonce": "short" })));
        assert_eq!((from, &sent[0]["error"]), (None, &json!("a nonce is required")));
    }
}
