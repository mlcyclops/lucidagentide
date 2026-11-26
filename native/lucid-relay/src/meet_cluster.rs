// MR-1 phase 1 section 2 (docs/multi-relay/contract-mr1-phase1.md): one org cluster of two Meeting Hub relays, one
// active and one warm standby. relay.json `cluster` names this node, its peer and the witness; `cluster-state.json`
// in the state folder holds the role and epoch once the node has started (the file wins over relay.json after the
// first start). The active lists its replica set (2.2) under a generation that grows at every save and serves it to
// the pinned peer certificate only (2.3); the standby pulls it into its own state folder and refuses people (2.4).
// The witness (meet_witness.rs, 2.5) decides who may be active: the active renews a blob lease and fences itself
// when it cannot; a standby with `auto_promote` takes over once the active is silent and the lease is free. A role
// change writes `cluster-state.json` and exits 0 so systemd starts the relay again in its new role; until then the
// process neither serves nor pulls.
//
//   lucid-relay meet cluster status|promote [--force] --yes|demote --yes|handover --yes --config <relay.json>
//
// The commands work on the state folder: with the relay stopped (no `cluster.lock` holder) they change the files
// themselves; with it running they leave `cluster-command.json` for the running relay, which answers in
// `cluster-command-result.json` (`status` reads `cluster-status.json`, written by the running relay every 10 s).

use crate::meet::{kv, log_error, log_info, log_warn, Settings};
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_witness::{AzureWitness, Witness};
use parking_lot::{Condvar, Mutex, MutexGuard};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

pub const STATE_FILE: &str = "cluster-state.json";
pub const REPLICA_FILE: &str = "cluster-replica.json";
pub const STATUS_FILE: &str = "cluster-status.json";
pub const COMMAND_FILE: &str = "cluster-command.json";
pub const RESULT_FILE: &str = "cluster-command-result.json";
pub const LOCK_FILE: &str = "cluster.lock";
/// 2.2: the replica set, the top-level files and every file of these folders. Nothing else is copied.
pub const TOP_FILES: [&str; 5] = ["state.json", "meet-seats.json", "push.secret", "guest.secret", "relays.json"];
pub const SET_DIRS: [&str; 2] = ["files", "emoji"];
const RELAYS_FILE: &str = "relays.json";
/// 2.3: the longest replica long-poll; a quiet relay answers this often.
pub const WAIT_MAX: u64 = 25;
pub const STANDBY_WORDS: &str = "This relay is a standby. Use the active relay.";
pub const FENCED_WORDS: &str = "This relay is fenced off. Use the active relay.";
/// What the standby takes from its peer: the replica answer and the health answer in bytes, the files a replica
/// answer may list, and the largest file (the relay keeps files of at most 4 GiB, `file_max_mb`).
const MANIFEST_MAX: usize = 16 << 20;
const HEALTH_MAX: usize = 8 << 10;
const ENTRIES_MAX: usize = 100_000;
const FILE_MAX: u64 = 5 << 30;
/// A replicated relay directory is at most 64 KiB serialized (1.2); the file may carry a newline.
const RELAYS_MAX: u64 = 64 * 1024 + 16;
const HEAD_MAX: usize = 16 << 10;
/// A file changed this recently may change again keeping its size and time: Linux stamps files from a clock that
/// moves in ticks (milliseconds apart), some file systems in whole seconds. Its hash is never cached.
const RACY: Duration = Duration::from_secs(3);
const ASIDE_PREFIX: &str = "state.before-epoch-";
const ASIDE_KEEP_S: u64 = 30 * 86_400;
/// 2.5: the active renews the lease (and every node checks the witness and its peer) this often.
const TICK_EVERY: f64 = 10.0;
const HANDOVER_WAIT: Duration = Duration::from_secs(60);
/// The standby counts as copying while its last replica request is at most this old.
const HEARD_FRESH: i64 = 60;
const PEER_TIMEOUT: f64 = 5.0;
const STATUS_FRESH: i64 = 30;

// ── relay.json `cluster` (2.1) ───────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Active,
    Standby,
    Fenced,
}

impl Role {
    pub fn word(self) -> &'static str {
        match self {
            Role::Active => "active",
            Role::Standby => "standby",
            Role::Fenced => "fenced",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "active" => Some(Role::Active),
            "standby" => Some(Role::Standby),
            "fenced" => Some(Role::Fenced),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PeerSettings {
    pub node: String,
    pub url: String,
    /// The TLS name and port of `url`.
    pub host: String,
    pub port: u16,
    /// The connect target when it is not `host` ("" = `host`).
    pub address: String,
    /// base64url (no padding) SHA-256 of the peer's relay-client certificate SPKI.
    pub spki_sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClusterSettings {
    pub id: String,
    pub node: String,
    /// Read only at the first start; `cluster-state.json` decides afterwards.
    pub role: Role,
    pub peer: PeerSettings,
    pub client_cert: String,
    pub client_key: String,
    /// "" = no witness: no node changes role by itself.
    pub witness_file: String,
    pub lease_s: u64,
    pub promote_after_s: u64,
    pub auto_promote: bool,
}

const KEYS: [&str; 10] = ["id", "node", "role", "peer", "client_cert", "client_key", "witness_file", "lease_s", "promote_after_s", "auto_promote"];
const PEER_KEYS: [&str; 4] = ["node", "url", "address", "spki_sha256"];

/// A cluster, node or region id: `^[a-z0-9][a-z0-9-]{0,31}$`.
pub fn word_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 32 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn dns_ok(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
        && h.rsplit('.').next().is_some_and(|tld| tld.bytes().any(|c| c.is_ascii_lowercase()))
}

/// `https://<lower-case DNS name>[:port][/]`: its host and port (443 by default).
pub fn parse_url(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("https://")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.contains(['/', '?', '#', '@']) {
        return None;
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok().filter(|p| *p > 0)?),
        None => (rest, 443),
    };
    dns_ok(host).then(|| (host.to_string(), port))
}

fn unknown(o: &Obj, allowed: &[&str], prefix: &str) -> Result<(), String> {
    let mut extra: Vec<String> = o.keys().filter(|k| !allowed.contains(&k.as_str())).map(|k| format!("{prefix}{k}")).collect();
    extra.sort();
    if extra.is_empty() {
        Ok(())
    } else {
        Err(format!("unknown relay settings: {}", extra.join(", ")))
    }
}

fn text(o: &Obj, k: &str, name: &str) -> Result<String, String> {
    match o.get(k) {
        None => Ok(String::new()),
        Some(Value::String(t)) => Ok(t.trim().to_string()),
        Some(_) => Err(format!("relay settings: {name} must be text")),
    }
}

fn whole(o: &Obj, k: &str, default: u64, lo: u64, hi: u64) -> Result<u64, String> {
    match o.get(k) {
        None => Ok(default),
        Some(v) => v.as_u64().filter(|n| (lo..=hi).contains(n)).ok_or_else(|| format!("relay settings: cluster.{k} must be a whole number of seconds from {lo} to {hi}")),
    }
}

/// relay.json `cluster`: exactly its keys (unknown ones refuse the start), each checked.
pub fn parse(v: &Value) -> Result<ClusterSettings, String> {
    let o = v.as_object().ok_or("relay settings: cluster must be an object")?;
    unknown(o, &KEYS, "cluster.")?;
    let id = text(o, "id", "cluster.id")?;
    let node = text(o, "node", "cluster.node")?;
    for (k, w) in [("id", &id), ("node", &node)] {
        if !word_ok(w) {
            return Err(format!("relay settings: cluster.{k} must be 1 to 32 lower-case letters, digits and hyphens"));
        }
    }
    let role = match o.get("role") {
        Some(Value::String(r)) if r == "active" => Role::Active,
        Some(Value::String(r)) if r == "standby" => Role::Standby,
        _ => return Err("relay settings: cluster.role must be active or standby".into()),
    };
    let p = o.get("peer").and_then(Value::as_object).ok_or("relay settings: cluster.peer must be {node, url, address, spki_sha256}")?;
    unknown(p, &PEER_KEYS, "cluster.peer.")?;
    let peer_node = text(p, "node", "cluster.peer.node")?;
    if !word_ok(&peer_node) || peer_node == node {
        return Err("relay settings: cluster.peer.node must be the other node's id".into());
    }
    let url = text(p, "url", "cluster.peer.url")?;
    let (host, port) = parse_url(&url).ok_or("relay settings: cluster.peer.url must be https://<host name>[:port]")?;
    let address = text(p, "address", "cluster.peer.address")?;
    if address.chars().any(char::is_whitespace) {
        return Err("relay settings: cluster.peer.address must be a host name or address".into());
    }
    let spki = text(p, "spki_sha256", "cluster.peer.spki_sha256")?.trim_end_matches('=').to_string();
    if crate::codec::unb64u(&spki).map(|b| b.len()) != Some(32) {
        return Err("relay settings: cluster.peer.spki_sha256 must be the base64url SHA-256 of the peer's client certificate key".into());
    }
    let client_cert = text(o, "client_cert", "cluster.client_cert")?;
    let client_key = text(o, "client_key", "cluster.client_key")?;
    if client_cert.is_empty() || client_key.is_empty() {
        return Err("relay settings: cluster.client_cert and cluster.client_key are required".into());
    }
    let witness_file = text(o, "witness_file", "cluster.witness_file")?;
    // the active must fence itself before its 60 s lease can pass to the standby
    let lease_s = whole(o, "lease_s", 30, 10, 50)?;
    let promote_after_s = whole(o, "promote_after_s", 90, 30, 3600)?;
    let auto_promote = match o.get("auto_promote") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("relay settings: cluster.auto_promote must be true or false".into()),
    };
    Ok(ClusterSettings { id, node, role, peer: PeerSettings { node: peer_node, url, host, port, address, spki_sha256: spki }, client_cert, client_key, witness_file, lease_s, promote_after_s, auto_promote })
}

// ── cluster-state.json ───────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeState {
    pub role: Role,
    pub epoch: u64,
    pub since: i64,
}

pub fn read_state(dir: &Path) -> Result<Option<NodeState>, String> {
    let path = dir.join(STATE_FILE);
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let v: Value = serde_json::from_slice(&data).map_err(|e| format!("{}: {e}", path.display()))?;
    let role = v.get("role").and_then(Value::as_str).and_then(Role::parse);
    match (role, v.get("epoch").and_then(Value::as_u64)) {
        (Some(role), Some(epoch)) => Ok(Some(NodeState { role, epoch, since: v.get("since").and_then(Value::as_i64).unwrap_or(0) })),
        _ => Err(format!("{} must be {{role, epoch, since}}", path.display())),
    }
}

pub fn write_state(dir: &Path, st: &NodeState) -> Result<(), String> {
    let v = json!({"role": st.role.word(), "epoch": st.epoch, "since": st.since});
    write_synced(&dir.join(STATE_FILE), pj::dumps(&v).as_bytes()).map_err(|e| format!("cannot write {STATE_FILE}: {e}"))
}

/// The node's state: the file when there is one, else the configured role at epoch 1 (written now).
pub fn open_state(dir: &Path, cfg: &ClusterSettings) -> Result<NodeState, String> {
    if let Some(st) = read_state(dir)? {
        return Ok(st);
    }
    let st = NodeState { role: cfg.role, epoch: 1, since: pj::now() as i64 };
    write_state(dir, &st)?;
    Ok(st)
}

/// A file of the state folder written whole: a temporary file beside it (created, never followed), fsync, rename,
/// folder fsync; owner-only.
pub fn write_synced(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a file path"));
    };
    crate::store::make_dir(parent)?;
    let dir = tree::Dir::open(parent, None, false)?;
    let tmp = format!(".{name}.tmp");
    let mut f = dir.create_temp(&tmp)?;
    let written = f.write_all(data).and_then(|()| f.sync_all()).and_then(|()| dir.rename(&tmp, &dir, name));
    if written.is_err() {
        let _ = dir.unlink(&tmp);
    }
    written?;
    dir.sync();
    Ok(())
}

// ── the replica tree, never through a link ───────────────────────────────────────────────────────────────────

/// One folder of the state tree. Its links are never followed: a set folder that is a link is no folder, every file
/// is opened, created, renamed and removed relative to the folder's own handle (Linux), so a link swapped in for a
/// name is refused or replaced, never written through.
mod tree {
    use std::fs::File;
    use std::io;
    use std::path::{Path, PathBuf};

    fn not_plain(path: &Path) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, format!("{} is a link or not a plain folder", path.display()))
    }

    #[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
    mod sys {
        use std::ffi::{c_char, c_int, c_uint};
        pub const O_RDONLY: c_int = 0;
        pub const O_WRONLY: c_int = 0o1;
        pub const O_CREAT: c_int = 0o100;
        pub const O_EXCL: c_int = 0o200;
        pub const O_NONBLOCK: c_int = 0o4000;
        pub const O_CLOEXEC: c_int = 0o2000000;
        #[cfg(target_arch = "x86_64")]
        pub const O_DIRECTORY: c_int = 0o200000;
        #[cfg(target_arch = "x86_64")]
        pub const O_NOFOLLOW: c_int = 0o400000;
        #[cfg(target_arch = "aarch64")]
        pub const O_DIRECTORY: c_int = 0o40000;
        #[cfg(target_arch = "aarch64")]
        pub const O_NOFOLLOW: c_int = 0o100000;
        pub const AT_FDCWD: c_int = -100;
        extern "C" {
            pub fn openat(dirfd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
            pub fn renameat(olddirfd: c_int, oldpath: *const c_char, newdirfd: c_int, newpath: *const c_char) -> c_int;
            pub fn unlinkat(dirfd: c_int, path: *const c_char, flags: c_int) -> c_int;
            pub fn mkdirat(dirfd: c_int, path: *const c_char, mode: c_uint) -> c_int;
        }
    }

    #[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
    pub struct Dir {
        path: PathBuf,
        fd: File,
    }

    #[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
    impl Dir {
        fn name(name: &str) -> io::Result<std::ffi::CString> {
            if name.is_empty() || name.contains('/') {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file name"));
            }
            std::ffi::CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "not a file name"))
        }

        fn fd(&self) -> std::ffi::c_int {
            use std::os::unix::io::AsRawFd;
            self.fd.as_raw_fd()
        }

        /// `base` itself (as configured), or its folder `sub`, which must not be a link (created when `create`).
        pub fn open(base: &Path, sub: Option<&str>, create: bool) -> io::Result<Dir> {
            use std::os::unix::ffi::OsStrExt;
            use std::os::unix::io::FromRawFd;
            let cbase = std::ffi::CString::new(base.as_os_str().as_bytes()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "not a folder"))?;
            // SAFETY: a NUL-terminated path the call only reads; the descriptor it returns is owned by the File below.
            let bfd = unsafe { sys::openat(sys::AT_FDCWD, cbase.as_ptr(), sys::O_RDONLY | sys::O_DIRECTORY | sys::O_CLOEXEC) };
            if bfd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `bfd` is a descriptor this function just opened and nothing else owns.
            let based = Dir { path: base.to_path_buf(), fd: unsafe { File::from_raw_fd(bfd) } };
            let Some(sub) = sub else { return Ok(based) };
            let csub = Dir::name(sub)?;
            let flags = sys::O_RDONLY | sys::O_DIRECTORY | sys::O_NOFOLLOW | sys::O_CLOEXEC;
            // SAFETY: the folder's descriptor is open; the name is NUL-terminated and only read.
            let mut fd = unsafe { sys::openat(based.fd(), csub.as_ptr(), flags) };
            if fd < 0 {
                let err = io::Error::last_os_error();
                if !(create && err.kind() == io::ErrorKind::NotFound) {
                    return Err(if err.raw_os_error() == Some(40) || err.raw_os_error() == Some(20) { not_plain(&base.join(sub)) } else { err });
                }
                // SAFETY: as above; mkdirat creates the folder relative to the open descriptor.
                if unsafe { sys::mkdirat(based.fd(), csub.as_ptr(), 0o700) } < 0 {
                    let err = io::Error::last_os_error();
                    if err.kind() != io::ErrorKind::AlreadyExists {
                        return Err(err);
                    }
                }
                // SAFETY: as above.
                fd = unsafe { sys::openat(based.fd(), csub.as_ptr(), flags) };
                if fd < 0 {
                    return Err(not_plain(&base.join(sub)));
                }
            }
            // SAFETY: `fd` was just opened here and is owned by nothing else.
            Ok(Dir { path: base.join(sub), fd: unsafe { File::from_raw_fd(fd) } })
        }

        /// A regular file of this folder, opened without following a link (and without blocking on a pipe).
        pub fn open_file(&self, name: &str) -> io::Result<File> {
            use std::os::unix::io::FromRawFd;
            let c = Dir::name(name)?;
            // SAFETY: the folder's descriptor is open; the name is NUL-terminated and only read.
            let fd = unsafe { sys::openat(self.fd(), c.as_ptr(), sys::O_RDONLY | sys::O_NOFOLLOW | sys::O_NONBLOCK | sys::O_CLOEXEC) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `fd` was just opened here and is owned by nothing else.
            let f = unsafe { File::from_raw_fd(fd) };
            if !f.metadata()?.is_file() {
                return Err(not_plain(&self.path.join(name)));
            }
            Ok(f)
        }

        /// A new owner-only file of this folder (whatever had the name is removed first, a link included).
        pub fn create_temp(&self, name: &str) -> io::Result<File> {
            use std::os::unix::io::FromRawFd;
            let c = Dir::name(name)?;
            // SAFETY: the folder's descriptor is open; the name is NUL-terminated and only read.
            unsafe { sys::unlinkat(self.fd(), c.as_ptr(), 0) };
            let flags = sys::O_WRONLY | sys::O_CREAT | sys::O_EXCL | sys::O_NOFOLLOW | sys::O_CLOEXEC;
            // SAFETY: as above; the mode is the variadic third argument of openat with O_CREAT.
            let fd = unsafe { sys::openat(self.fd(), c.as_ptr(), flags, 0o600 as std::ffi::c_uint) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `fd` was just created here and is owned by nothing else.
            Ok(unsafe { File::from_raw_fd(fd) })
        }

        pub fn rename(&self, from: &str, to_dir: &Dir, to: &str) -> io::Result<()> {
            let (a, b) = (Dir::name(from)?, Dir::name(to)?);
            // SAFETY: both descriptors are open; both names are NUL-terminated and only read.
            if unsafe { sys::renameat(self.fd(), a.as_ptr(), to_dir.fd(), b.as_ptr()) } < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// Remove a name of this folder (a link is removed itself, never its target).
        pub fn unlink(&self, name: &str) -> io::Result<()> {
            let c = Dir::name(name)?;
            // SAFETY: the folder's descriptor is open; the name is NUL-terminated and only read.
            if unsafe { sys::unlinkat(self.fd(), c.as_ptr(), 0) } < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn sync(&self) {
            let _ = self.fd.sync_all();
        }

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    /// Elsewhere (tests on Windows, other Unix): the same rules by path, each name looked at without following it.
    #[cfg(not(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
    pub struct Dir {
        path: PathBuf,
    }

    #[cfg(not(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
    impl Dir {
        fn at(&self, name: &str) -> io::Result<PathBuf> {
            if name.is_empty() || name.contains(['/', '\\']) {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file name"));
            }
            Ok(self.path.join(name))
        }

        pub fn open(base: &Path, sub: Option<&str>, create: bool) -> io::Result<Dir> {
            let Some(sub) = sub else {
                return if std::fs::metadata(base)?.is_dir() { Ok(Dir { path: base.to_path_buf() }) } else { Err(not_plain(base)) };
            };
            let path = Dir { path: base.to_path_buf() }.at(sub)?;
            match std::fs::symlink_metadata(&path) {
                Ok(m) if m.file_type().is_dir() => Ok(Dir { path }),
                Ok(_) => Err(not_plain(&path)),
                Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                    crate::store::make_dir(&path)?;
                    Ok(Dir { path })
                }
                Err(e) => Err(e),
            }
        }

        pub fn open_file(&self, name: &str) -> io::Result<File> {
            let path = self.at(name)?;
            if !std::fs::symlink_metadata(&path)?.file_type().is_file() {
                return Err(not_plain(&path));
            }
            File::open(path)
        }

        pub fn create_temp(&self, name: &str) -> io::Result<File> {
            let path = self.at(name)?;
            let _ = std::fs::remove_file(&path);
            std::fs::OpenOptions::new().write(true).create_new(true).open(path)
        }

        pub fn rename(&self, from: &str, to_dir: &Dir, to: &str) -> io::Result<()> {
            std::fs::rename(self.at(from)?, to_dir.at(to)?)
        }

        pub fn unlink(&self, name: &str) -> io::Result<()> {
            std::fs::remove_file(self.at(name)?)
        }

        pub fn sync(&self) {}

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Dir {
        /// The names in this folder.
        pub fn names(&self) -> Vec<String> {
            std::fs::read_dir(self.path()).map(|rd| rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).collect()).unwrap_or_default()
        }

        /// A name's own metadata (a link is a link, never its target).
        pub fn meta(&self, name: &str) -> io::Result<std::fs::Metadata> {
            std::fs::symlink_metadata(self.path().join(name))
        }
    }
}

// ── the replica set (2.2) ────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Entry {
    path: String,
    size: u64,
}

/// A file name the relay writes under `files/` or `emoji/` (never a temporary or partial one).
fn name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && !name.starts_with('.') && !name.ends_with(".tmp") && !name.ends_with(".part") && name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// A relative `/`-separated path inside the replica set.
pub fn in_set(path: &str) -> bool {
    TOP_FILES.contains(&path) || path.split_once('/').is_some_and(|(d, n)| SET_DIRS.contains(&d) && name_ok(n))
}

/// A set path as its folder (None: the state folder) and file name.
fn split(path: &str) -> (Option<&str>, &str) {
    match path.split_once('/') {
        Some((d, n)) => (Some(d), n),
        None => (None, path),
    }
}

fn mtime_of(m: &std::fs::Metadata) -> i128 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128)
}

/// What the replica set holds now (sizes and times only), by path. Links are no part of it, and neither is a set
/// folder that is a link.
fn listing(dir: &Path) -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(base) = tree::Dir::open(dir, None, false) else { return out };
    let mut add = |d: &tree::Dir, prefix: &str, name: &str| {
        if let Some(m) = d.meta(name).ok().filter(|m| m.file_type().is_file()) {
            out.push(Entry { path: format!("{prefix}{name}"), size: m.len() });
        }
    };
    for name in TOP_FILES {
        add(&base, "", name);
    }
    for sub in SET_DIRS {
        let Ok(d) = tree::Dir::open(dir, Some(sub), false) else { continue };
        for name in d.names().iter().filter(|n| name_ok(n)) {
            add(&d, &format!("{sub}/"), name);
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// A set file opened without following links, with its metadata.
fn open_entry(dir: &Path, path: &str) -> Option<(std::fs::File, std::fs::Metadata)> {
    let (sub, name) = split(path);
    let f = tree::Dir::open(dir, sub, false).ok()?.open_file(name).ok()?;
    let m = f.metadata().ok()?;
    Some((f, m))
}

fn hash_reader(r: &mut impl Read) -> std::io::Result<String> {
    let mut ctx = aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(crate::codec::hex(ctx.finish().as_ref()))
}

fn sha_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Where a pulled file goes while it arrives: at most its declared size, hashed as it is written.
struct Sink {
    file: std::fs::File,
    ctx: aws_lc_rs::digest::Context,
    n: u64,
    limit: u64,
}

impl Sink {
    fn new(file: std::fs::File, limit: u64) -> Sink {
        Sink { file, ctx: aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256), n: 0, limit }
    }

    fn finish(self) -> (std::fs::File, u64, String) {
        (self.file, self.n, crate::codec::hex(self.ctx.finish().as_ref()))
    }
}

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.n + buf.len() as u64 > self.limit {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "longer than its declared size"));
        }
        let k = self.file.write(buf)?;
        self.ctx.update(&buf[..k]);
        self.n += k as u64;
        Ok(k)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

/// The DER of every self-signed certificate in `client_ca`: the org roots a relay directory is checked against.
pub fn org_roots(client_ca: &str) -> Vec<Vec<u8>> {
    crate::meet_x509::pem_blocks(&crate::meet_tls::read_bytes(Path::new(client_ca)), "CERTIFICATE")
        .into_iter()
        .map(|(_, der)| der)
        .filter(|der| crate::meet_x509::Cert::from_der(der).is_some_and(|c| c.subject == c.issuer && c.signed.verified_by(&c.spki)))
        .collect()
}

// ── the peer and the witness, behind traits so tests use fakes ───────────────────────────────────────────────

/// The active node, as the standby reaches it.
pub trait Peer: Send + Sync {
    fn replica(&self, have: u64, wait: u64) -> Result<Value, String>;
    /// One file at that hash, written into `out` (which refuses more than `size` bytes); false when it changed since
    /// it was listed (409).
    fn file(&self, path: &str, sha256: &str, size: u64, out: &mut dyn Write) -> Result<bool, String>;
    fn health(&self) -> Result<Value, String>;
    /// Whether this node can ask the peer at all (its client certificate loads); Err says why not.
    fn ready(&self) -> Result<(), String> {
        Ok(())
    }
}

/// The peer over mutual TLS: this node's relay-client certificate, the org root (`client_ca`) as the only trust
/// anchor, the name in `peer.url` checked, `peer.address` as the connect target when set. The pair is loaded when
/// first needed and again when its files change, so a missing pair never stops an active node (which asks nothing of
/// its peer) and a standby picks up a pair placed later.
pub struct HttpsPeer {
    client_ca: String,
    cert: String,
    key: String,
    /// The loaded config and the modification times of the files it was loaded from.
    cfg: Mutex<Option<(Arc<rustls::ClientConfig>, [Option<std::time::SystemTime>; 3])>>,
    host: String,
    port: u16,
    address: String,
}

/// One line of an answer's head, within what is left of HEAD_MAX.
fn head_line(r: &mut impl BufRead, left: &mut usize) -> Result<String, String> {
    let mut line = String::new();
    let n = r.take(*left as u64).read_line(&mut line).map_err(|e| e.to_string())?;
    *left -= n;
    if !line.ends_with('\n') {
        return Err("the answer's head is cut short or too long".into());
    }
    Ok(line.trim_end().to_string())
}

impl HttpsPeer {
    pub fn new(s: &Settings, c: &ClusterSettings) -> HttpsPeer {
        let address = if c.peer.address.is_empty() { c.peer.host.clone() } else { c.peer.address.clone() };
        HttpsPeer { client_ca: s.client_ca.clone(), cert: c.client_cert.clone(), key: c.client_key.clone(), cfg: Mutex::new(None), host: c.peer.host.clone(), port: c.peer.port, address }
    }

    fn config(&self) -> Result<Arc<rustls::ClientConfig>, String> {
        let stamp = [&self.client_ca, &self.cert, &self.key].map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
        let mut held = self.cfg.lock();
        if let Some((cfg, _)) = held.as_ref().filter(|(_, at)| *at == stamp) {
            return Ok(cfg.clone());
        }
        let unloadable = |e: String| format!("the cluster client certificate does not load: {e}");
        crate::meet_witness::read_private(Path::new(&self.key)).map_err(unloadable)?;
        let cfg = crate::meet_tls::client_config(Some(&self.client_ca), Some((&self.cert, &self.key))).map_err(unloadable)?;
        *held = Some((cfg.clone(), stamp));
        Ok(cfg)
    }

    fn get(&self, target: &str, timeout: f64, cap: usize) -> Result<(u16, Vec<u8>), String> {
        let cfg = self.config()?;
        crate::meet_tls::https_request_via(&cfg, &self.address, &self.host, self.port, timeout, "GET", target, &[], None, &|_| Ok(()), cap)
            .map(|r| (r.status, r.body))
            .map_err(|e| format!("the peer {} did not answer ({})", self.host, e.unwrap_or_else(|w| w)))
    }

    fn json(&self, target: &str, timeout: f64, cap: usize) -> Result<Value, String> {
        let (status, body) = self.get(target, timeout, cap)?;
        let v: Value = serde_json::from_slice(&body).map_err(|_| format!("the peer {} answered HTTP {status} without JSON", self.host))?;
        if status != 200 {
            return Err(format!("the peer {} answered HTTP {status}: {}", self.host, v.get("error").and_then(Value::as_str).unwrap_or("")));
        }
        Ok(v)
    }

    /// One GET whose 200 body (exactly `size` bytes by its Content-Length) is copied into `out` as it arrives; the
    /// status otherwise.
    fn stream(&self, target: &str, size: u64, out: &mut dyn Write) -> Result<u16, String> {
        use std::net::{TcpStream, ToSocketAddrs};
        let cfg = self.config()?;
        let fail = |w: String| format!("the peer {} did not answer ({w})", self.host);
        let addrs: Vec<_> = (self.address.as_str(), self.port).to_socket_addrs().map_err(|e| fail(e.to_string()))?.collect();
        let mut last = "no address".to_string();
        let mut tcp = None;
        for a in addrs {
            match TcpStream::connect_timeout(&a, Duration::from_secs_f64(PEER_TIMEOUT)) {
                Ok(s) => {
                    tcp = Some(s);
                    break;
                }
                Err(e) => last = e.to_string(),
            }
        }
        let tcp = tcp.ok_or_else(|| fail(last))?;
        let idle = Some(Duration::from_secs(60));
        let _ = tcp.set_read_timeout(idle);
        let _ = tcp.set_write_timeout(idle);
        let name = rustls::pki_types::ServerName::try_from(self.host.clone()).map_err(|_| fail("not a server name".into()))?;
        let conn = rustls::ClientConnection::new(cfg, name).map_err(|e| fail(e.to_string()))?;
        let mut tls = rustls::StreamOwned::new(conn, tcp);
        let request = format!("GET {target} HTTP/1.1\r\nHost: {}:{}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n", self.host, self.port);
        tls.write_all(request.as_bytes()).and_then(|()| tls.flush()).map_err(|e| fail(e.to_string()))?;
        let mut r = BufReader::new(tls);
        let mut left = HEAD_MAX;
        let status_line = head_line(&mut r, &mut left).map_err(fail)?;
        let status: u16 = status_line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| fail("no status".into()))?;
        let (mut length, mut chunked) = (None, false);
        loop {
            let h = head_line(&mut r, &mut left).map_err(fail)?;
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                match k.trim().to_ascii_lowercase().as_str() {
                    "content-length" => length = v.trim().parse::<u64>().ok(),
                    "transfer-encoding" => chunked = true,
                    _ => {}
                }
            }
        }
        if status != 200 {
            return Ok(status);
        }
        if chunked || length != Some(size) {
            return Err(fail(format!("the answer is not the {size} bytes listed")));
        }
        let got = std::io::copy(&mut r.take(size), out).map_err(|e| fail(e.to_string()))?;
        if got != size {
            return Err(fail("the answer was cut short".into()));
        }
        Ok(200)
    }
}

impl Peer for HttpsPeer {
    fn replica(&self, have: u64, wait: u64) -> Result<Value, String> {
        self.json(&format!("/v1/cluster/replica?have={have}&wait={wait}"), wait as f64 + 20.0, MANIFEST_MAX)
    }

    fn file(&self, path: &str, sha256: &str, size: u64, out: &mut dyn Write) -> Result<bool, String> {
        match self.stream(&format!("/v1/cluster/file?path={path}&sha256={sha256}"), size, out)? {
            200 => Ok(true),
            409 => Ok(false),
            status => Err(format!("the peer {} answered HTTP {status} for {path}", self.host)),
        }
    }

    fn health(&self) -> Result<Value, String> {
        self.json("/healthz", PEER_TIMEOUT, HEALTH_MAX)
    }

    fn ready(&self) -> Result<(), String> {
        self.config().map(|_| ())
    }
}

// ── the node ─────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Handover {
    Idle,
    /// People are refused; the writers already admitted finish, then the last writes are saved.
    Draining,
    /// The next replica answer to a standby that has everything carries `handover`.
    Ready,
    Confirmed,
}

struct Repl {
    generation: u64,
    /// The set at the last scan, path and hash: a generation is a change of content (two writes within one clock
    /// tick leave size and time as they were).
    seen: Vec<(String, String)>,
    handover: Handover,
    /// The standby's last replica request: when (unix seconds) and the generation it had.
    heard: Option<(i64, u64)>,
    /// Client writes admitted and still running (a handover waits for them).
    writers: usize,
}

/// What the standby applied last (`cluster-replica.json`): only a complete pull writes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pulled {
    pub epoch: u64,
    pub generation: u64,
    pub at: i64,
}

struct Lease {
    holding: bool,
    last_renew: Option<f64>,
    started: f64,
}

/// What the cluster asks of the running Hub: save now, and wait for a save in progress.
pub struct Hooks {
    pub flush: Box<dyn Fn() + Send + Sync>,
    pub barrier: Box<dyn Fn() + Send + Sync>,
}

/// A step of the witness logic: stay, or exit 0 so systemd starts the relay in its new role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Stay,
    Exit,
}

#[derive(Debug)]
pub enum Answer {
    Json(u16, Obj),
    File(std::fs::File, u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullOutcome {
    Applied { generation: u64, fetched: usize, deleted: usize },
    /// The active handed over and this node has its last generation.
    Handover { epoch: u64 },
}

pub struct Cluster {
    pub cfg: ClusterSettings,
    pub dir: PathBuf,
    lease_id: String,
    node: Mutex<NodeState>,
    /// One role transition or one pull's apply at a time.
    transition: Mutex<()>,
    /// A role transition is under way or decided a restart: the node neither serves nor pulls.
    transit: AtomicBool,
    /// A promotion whose epoch the witness holds but `cluster-state.json` not yet (written again until it is).
    promoted: Mutex<Option<u64>>,
    repl: Mutex<Repl>,
    changed: Condvar,
    hashes: Mutex<HashMap<String, (u64, i128, String)>>,
    pulled: Mutex<Option<Pulled>>,
    /// The standby's last failed pull (cleared by the next one that works), for the status.
    pull_error: Mutex<Option<String>>,
    /// Why the active's `relays.json` was not taken (this node keeps its own), for the status.
    relays_error: Mutex<Option<String>>,
    /// When the peer last answered as active (monotonic seconds) and the highest epoch it named.
    peer_seen: Mutex<(f64, u64)>,
    lease: Mutex<Lease>,
    client_ca: Mutex<String>,
    witness: OnceLock<Arc<dyn Witness>>,
    peer: OnceLock<Arc<dyn Peer>>,
    hooks: OnceLock<Hooks>,
    clock: OnceLock<Box<dyn Fn() -> f64 + Send + Sync>>,
    _lock: Option<crate::server::FleetLock>,
}

/// A client write admitted on the active (2.4): a handover waits until every one is dropped.
pub struct Admitted(Arc<Cluster>);

impl Drop for Admitted {
    fn drop(&mut self) {
        let mut r = self.0.repl.lock();
        r.writers -= 1;
        if r.writers == 0 {
            self.0.changed.notify_all();
        }
    }
}

/// Exit 0 for systemd to start the relay again in its new role (tests only log it).
fn restart(why: &str) {
    log_warn(&format!("cluster.restart why={}", kv(why)));
    #[cfg(not(test))]
    std::process::exit(0);
}

fn read_pulled(dir: &Path) -> Option<Pulled> {
    let v: Value = serde_json::from_slice(&std::fs::read(dir.join(REPLICA_FILE)).ok()?).ok()?;
    Some(Pulled { epoch: v.get("epoch")?.as_u64()?, generation: v.get("generation")?.as_u64()?, at: v.get("at")?.as_i64()? })
}

/// Moved-aside state folders older than 30 days go (2.5).
fn prune_aside(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > ASIDE_KEEP_S);
        if old && e.file_name().to_string_lossy().starts_with(ASIDE_PREFIX) && e.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

impl Cluster {
    /// The node on its state folder: `cluster.lock` held for the process's life, the role from the file (or relay.json
    /// at the first start).
    pub fn open(cfg: &ClusterSettings, dir: &Path) -> Result<Arc<Cluster>, String> {
        let lock = crate::server::file_lock(&dir.join(LOCK_FILE)).map_err(|_| "another relay process runs on this state folder".to_string())?;
        prune_aside(dir);
        Ok(Arc::new(Cluster::new(cfg.clone(), dir, Some(lock))?))
    }

    fn new(cfg: ClusterSettings, dir: &Path, lock: Option<crate::server::FleetLock>) -> Result<Cluster, String> {
        let st = open_state(dir, &cfg)?;
        let lease_id = crate::meet_witness::lease_id(&cfg.id, &cfg.node);
        // generations start at the clock, so a restarted active never repeats one the standby already has
        let repl = Repl { generation: crate::codec::now_ms() as u64, seen: Vec::new(), handover: Handover::Idle, heard: None, writers: 0 };
        let now = pj::mono();
        Ok(Cluster {
            cfg,
            dir: dir.to_path_buf(),
            lease_id,
            node: Mutex::new(st),
            transition: Mutex::new(()),
            transit: AtomicBool::new(false),
            promoted: Mutex::new(None),
            repl: Mutex::new(repl),
            changed: Condvar::new(),
            hashes: Mutex::new(HashMap::new()),
            pulled: Mutex::new(read_pulled(dir)),
            pull_error: Mutex::new(None),
            relays_error: Mutex::new(None),
            peer_seen: Mutex::new((now, 0)),
            lease: Mutex::new(Lease { holding: false, last_renew: None, started: now }),
            client_ca: Mutex::new(String::new()),
            witness: OnceLock::new(),
            peer: OnceLock::new(),
            hooks: OnceLock::new(),
            clock: OnceLock::new(),
            _lock: lock,
        })
    }

    pub fn set_witness(&self, w: Arc<dyn Witness>) {
        let _ = self.witness.set(w);
    }

    pub fn set_peer(&self, p: Arc<dyn Peer>) {
        let _ = self.peer.set(p);
    }

    pub fn set_hooks(&self, h: Hooks) {
        let _ = self.hooks.set(h);
    }

    /// The org root file a replicated relay directory is checked against (relay.json `client_ca`).
    pub fn set_client_ca(&self, path: &str) {
        *self.client_ca.lock() = path.to_string();
    }

    /// The monotonic clock the witness logic reads (tests give the fake witness's); the waits start from it.
    #[cfg(test)]
    pub fn set_clock(&self, clock: Box<dyn Fn() -> f64 + Send + Sync>) {
        let t = clock();
        if self.clock.set(clock).is_ok() {
            self.lease.lock().started = t;
            self.peer_seen.lock().0 = t;
        }
    }

    fn now(&self) -> f64 {
        self.clock.get().map_or_else(pj::mono, |c| c())
    }

    pub fn state(&self) -> NodeState {
        *self.node.lock()
    }

    pub fn role(&self) -> Role {
        self.node.lock().role
    }

    pub fn epoch(&self) -> u64 {
        self.node.lock().epoch
    }

    fn in_transit(&self) -> bool {
        self.transit.load(Ordering::SeqCst)
    }

    /// Serving people: active, no role change under way, not handing over.
    pub fn serving(&self) -> bool {
        self.role() == Role::Active && !self.in_transit() && self.repl.lock().handover == Handover::Idle
    }

    /// The Hub writes `state.json` on every role but standby (the standby's copy comes from the active).
    pub fn saves_allowed(&self) -> bool {
        self.role() != Role::Standby
    }

    /// The code and words of the refusal while this node does not serve people.
    pub fn not_serving(&self) -> (&'static str, &'static str) {
        if self.role() == Role::Fenced {
            ("fenced", FENCED_WORDS)
        } else {
            ("standby", STANDBY_WORDS)
        }
    }

    /// The role in memory and in `cluster-state.json`.
    fn persist(&self, role: Role, epoch: u64) -> Result<(), String> {
        let st = NodeState { role, epoch, since: pj::now() as i64 };
        let mut n = self.node.lock();
        *n = st;
        write_state(&self.dir, &st)
    }

    fn note_peer_active(&self, now: f64, epoch: u64) {
        let mut p = self.peer_seen.lock();
        p.0 = p.0.max(now);
        p.1 = p.1.max(epoch);
    }

    /// `/healthz` (2.4).
    pub fn health(&self) -> Obj {
        let st = self.state();
        obj([("ok", Value::Bool(true)), ("role", Value::from(st.role.word())), ("epoch", Value::from(st.epoch)), ("node", Value::from(self.cfg.node.clone()))])
    }

    /// 2.4: the routes a standby or fenced node still answers.
    pub fn exempt(method: &str, path: &str) -> bool {
        matches!((method, path), ("GET", "/healthz") | ("GET", "/v1/relays") | ("GET", "/v1/crl"))
    }

    fn refused_body(&self) -> Obj {
        let (code, words) = self.not_serving();
        // a fenced node names the peer only once it has seen it active
        let active = match self.role() {
            Role::Fenced if self.now() - self.peer_seen.lock().0 > 3.0 * TICK_EVERY => Value::Null,
            _ => Value::from(self.cfg.peer.node.clone()),
        };
        obj([("ok", Value::Bool(false)), ("code", Value::from(code)), ("error", Value::from(words)), ("active", active)])
    }

    /// 2.4: the 503 a client route gets while this node does not serve people.
    pub fn refusal(&self, method: &str, path: &str) -> Option<(u16, Obj)> {
        if self.serving() || Cluster::exempt(method, path) {
            return None;
        }
        Some((503, self.refused_body()))
    }

    /// 2.4: one client request: Err the 503 while this node does not serve people; a write (POST) is counted until
    /// the returned guard drops, so a handover can wait for it. Checked and counted under one lock with the handover.
    pub fn admit(self: &Arc<Self>, method: &str, path: &str) -> Result<Option<Admitted>, (u16, Obj)> {
        if Cluster::exempt(method, path) {
            return Ok(None);
        }
        let up = self.role() == Role::Active && !self.in_transit();
        let mut r = self.repl.lock();
        if !up || r.handover != Handover::Idle {
            drop(r);
            return Err((503, self.refused_body()));
        }
        if method == "GET" {
            return Ok(None);
        }
        r.writers += 1;
        Ok(Some(Admitted(self.clone())))
    }

    fn peer_allowed(&self, der: Option<&[u8]>) -> bool {
        let Some(cert) = der.and_then(crate::meet_x509::Cert::from_der) else { return false };
        crate::codec::b64u(&crate::codec::sha256(&cert.spki)) == self.cfg.peer.spki_sha256
    }

    // ── the active: generation and the replica routes (2.3) ──

    /// List and hash the set again; a change of content since the last scan is a new generation (and wakes the
    /// long-polls).
    pub fn scan(&self) -> u64 {
        let now: Vec<(String, String)> = listing(&self.dir).into_iter().filter_map(|e| self.hash_entry(&e.path).map(|h| (e.path, h))).collect();
        let mut r = self.repl.lock();
        if now != r.seen {
            r.seen = now;
            r.generation += 1;
            self.changed.notify_all();
        }
        r.generation
    }

    /// After a save of a file of the set (the Hub's save loop, `POST /v1/relays`): only the active lists.
    pub fn note_saved(&self) {
        if self.role() == Role::Active {
            self.scan();
        }
    }

    fn hash_entry(&self, path: &str) -> Option<String> {
        let (mut f, meta) = open_entry(&self.dir, path)?;
        self.hash_of(path, &mut f, &meta)
    }

    /// An open set file's hash, from the cache while its size and time are the hashed ones. The hash of a file
    /// changed within `RACY` of the read is not kept: a later write could leave size and time as they were.
    fn hash_of(&self, path: &str, f: &mut std::fs::File, meta: &std::fs::Metadata) -> Option<String> {
        let key = (meta.len(), mtime_of(meta));
        if let Some((_, _, h)) = self.hashes.lock().get(path).filter(|(s, m, _)| (*s, *m) == key) {
            return Some(h.clone());
        }
        let settled = meta.modified().ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > RACY);
        let h = hash_reader(f).ok()?;
        if settled {
            self.hashes.lock().insert(path.to_string(), (key.0, key.1, h.clone()));
        }
        Some(h)
    }

    /// `GET /v1/cluster/replica`: wait until the generation is not `have` (at most `wait`), then list the set.
    pub fn replica(&self, have: u64, wait: Duration) -> Obj {
        self.scan();
        let deadline = Instant::now() + wait;
        let mut r = self.repl.lock();
        while r.generation == have && r.handover != Handover::Ready {
            if self.changed.wait_until(&mut r, deadline).timed_out() {
                break;
            }
        }
        let generation = r.generation;
        let handover = r.handover == Handover::Ready && have >= generation;
        if handover {
            r.handover = Handover::Confirmed;
        }
        // 2.3: every answered request is the standby's heartbeat
        r.heard = Some((pj::now() as i64, have));
        drop(r);
        if handover {
            self.changed.notify_all();
        }
        let files: Vec<Value> = listing(&self.dir).into_iter().filter_map(|e| Some(json!({"path": e.path, "size": e.size, "sha256": self.hash_entry(&e.path)?}))).collect();
        let mut o = obj([
            ("ok", Value::Bool(true)),
            ("cluster", Value::from(self.cfg.id.clone())),
            ("node", Value::from(self.cfg.node.clone())),
            ("epoch", Value::from(self.epoch())),
            ("generation", Value::from(generation)),
            ("files", Value::Array(files)),
        ]);
        if handover {
            o.insert("handover".into(), Value::Bool(true));
        }
        o
    }

    /// `GET /v1/cluster/file`: the open file at that hash and its length; None when it changed (409).
    fn open_file(&self, path: &str, sha256: &str) -> Option<(std::fs::File, u64)> {
        let (mut f, meta) = open_entry(&self.dir, path)?;
        let h = self.hash_of(path, &mut f, &meta)?;
        f.seek(SeekFrom::Start(0)).ok()?;
        (h == sha256).then_some((f, meta.len()))
    }

    /// MR-1 2.3: the cluster routes and the peer's `/healthz`, for the pinned peer certificate only (anyone else: the
    /// routes do not exist). None: not a cluster route, dispatch goes on.
    pub fn route(&self, method: &str, path: &str, query: &[(String, String)], der: Option<&[u8]>) -> Option<Answer> {
        let cluster_path = path.starts_with("/v1/cluster/");
        if !cluster_path && path != "/healthz" {
            return None;
        }
        let peer = self.peer_allowed(der);
        if !cluster_path {
            // the peer's relay certificate is no person: it is let through for the health check only
            return (peer && method == "GET").then(|| Answer::Json(200, self.health()));
        }
        let not_found = || Some(Answer::Json(404, obj([("error", Value::from("unknown path"))])));
        if !peer || method != "GET" {
            return not_found();
        }
        let q = |k: &str| query.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or("");
        match path {
            "/v1/cluster/replica" => {
                if self.role() != Role::Active || self.in_transit() {
                    return Some(Answer::Json(503, self.refused_body()));
                }
                let have = q("have").parse::<u64>().unwrap_or(0);
                let wait = q("wait").parse::<u64>().unwrap_or(0).min(WAIT_MAX);
                Some(Answer::Json(200, self.replica(have, Duration::from_secs(wait))))
            }
            "/v1/cluster/file" => {
                let p = q("path");
                if !in_set(p) {
                    return not_found();
                }
                Some(match self.open_file(p, q("sha256")) {
                    Some((f, n)) => Answer::File(f, n),
                    None => Answer::Json(409, obj([("error", Value::from("the file changed since it was listed"))])),
                })
            }
            _ => not_found(),
        }
    }

    // ── the standby: pulling (2.3) ──

    /// One pull: ask with the generation this node has, then (under the transition lock, so no role change moves the
    /// tree away meanwhile) copy every file whose hash differs, delete what is gone under `files/` and `emoji/`, and
    /// record `cluster-replica.json`, which only a complete pull writes.
    pub fn pull_once(&self, peer: &dyn Peer, wait: u64) -> Result<PullOutcome, String> {
        const BUSY: &str = "a role change is under way; nothing was copied";
        if self.in_transit() {
            return Err(BUSY.into());
        }
        let had = self.pulled.lock().map(|p| p.generation);
        let a = peer.replica(had.unwrap_or(0), wait)?;
        let bad = |w: &str| format!("the peer's replica answer {w}");
        if a.get("ok") != Some(&Value::Bool(true)) {
            return Err(bad("is not ok"));
        }
        if a.get("cluster").and_then(Value::as_str) != Some(self.cfg.id.as_str()) || a.get("node").and_then(Value::as_str) != Some(self.cfg.peer.node.as_str()) {
            return Err(bad("names another cluster or node"));
        }
        let (Some(epoch), Some(generation), Some(files)) = (a.get("epoch").and_then(Value::as_u64), a.get("generation").and_then(Value::as_u64), a.get("files").and_then(Value::as_array)) else {
            return Err(bad("lacks epoch, generation or files"));
        };
        if files.len() > ENTRIES_MAX {
            return Err(bad(&format!("lists more than {ENTRIES_MAX} files")));
        }
        let mut list = Vec::with_capacity(files.len());
        let mut seen = HashSet::new();
        for f in files {
            let (Some(path), Some(size), Some(sha)) = (f.get("path").and_then(Value::as_str), f.get("size").and_then(Value::as_u64), f.get("sha256").and_then(Value::as_str)) else {
                return Err(bad("has a malformed file"));
            };
            if !in_set(path) || !sha_ok(sha) || !seen.insert(path) {
                return Err(bad("lists a file outside the replica set"));
            }
            if size > FILE_MAX || (path == RELAYS_FILE && size > RELAYS_MAX) {
                return Err(bad(&format!("lists {path} larger than this node takes")));
            }
            list.push((path, size, sha));
        }
        let _held = self.transition.lock();
        let own = self.epoch();
        if self.in_transit() || self.role() != Role::Standby {
            return Err(BUSY.into());
        }
        if epoch < own {
            return Err(format!("the peer is at epoch {epoch}, older than this node's {own}"));
        }
        let mut fetched = 0;
        for (path, size, sha) in &list {
            if self.hash_entry(path).as_deref() == Some(*sha) {
                continue;
            }
            if self.fetch(peer, path, *size, sha)? {
                fetched += 1;
            }
        }
        let mut deleted = 0;
        for e in listing(&self.dir) {
            let (Some(sub), name) = split(&e.path) else { continue };
            if !seen.contains(e.path.as_str()) && tree::Dir::open(&self.dir, Some(sub), false).and_then(|d| d.unlink(name).map(|()| d.sync())).is_ok() {
                self.hashes.lock().remove(&e.path);
                deleted += 1;
            }
        }
        let at = pj::now() as i64;
        let mark = json!({"epoch": epoch, "generation": generation, "at": at});
        write_synced(&self.dir.join(REPLICA_FILE), pj::dumps(&mark).as_bytes()).map_err(|e| format!("cannot write {REPLICA_FILE}: {e}"))?;
        *self.pulled.lock() = Some(Pulled { epoch, generation, at });
        self.note_peer_active(self.now(), epoch);
        if epoch > own {
            self.persist(Role::Standby, epoch)?;
        }
        if a.get("handover") == Some(&Value::Bool(true)) && had == Some(generation) && fetched == 0 && deleted == 0 {
            return Ok(PullOutcome::Handover { epoch });
        }
        Ok(PullOutcome::Applied { generation, fetched, deleted })
    }

    /// One file: streamed into a temporary file of its folder (its declared size at most, hashed as it arrives),
    /// synced, then renamed over the old one. Ok(false): a `relays.json` this node does not take (it keeps its own).
    fn fetch(&self, peer: &dyn Peer, path: &str, size: u64, sha: &str) -> Result<bool, String> {
        let (sub, name) = split(path);
        let dir = tree::Dir::open(&self.dir, sub, true).map_err(|e| format!("cannot write {path}: {e}"))?;
        let tmp = format!(".{name}.pull");
        let mut sink = Sink::new(dir.create_temp(&tmp).map_err(|e| format!("cannot write {path}: {e}"))?, size);
        let got = peer.file(path, sha, size, &mut sink);
        let done = (|| -> Result<bool, String> {
            if !got? {
                return Err(format!("{path} changed on the peer during the copy"));
            }
            let (file, n, hash) = sink.finish();
            if n != size || hash != sha {
                return Err(format!("{path} arrived damaged"));
            }
            file.sync_all().map_err(|e| format!("cannot write {path}: {e}"))?;
            if path == RELAYS_FILE {
                let mut data = Vec::new();
                dir.open_file(&tmp).and_then(|mut f| f.read_to_end(&mut data)).map_err(|e| format!("cannot read {path}: {e}"))?;
                if let Err(why) = self.relays_ok(&data) {
                    log_warn(&format!("cluster.relays-refused why={}", kv(&why)));
                    *self.relays_error.lock() = Some(why);
                    return Ok(false);
                }
            }
            dir.rename(&tmp, &dir, name).map_err(|e| format!("cannot write {path}: {e}"))?;
            dir.sync();
            Ok(true)
        })();
        if !matches!(done, Ok(true)) {
            let _ = dir.unlink(&tmp);
        } else if path == RELAYS_FILE {
            *self.relays_error.lock() = None;
        }
        done
    }

    /// MR-1 1.4 on the standby: a replicated relay directory replaces this node's copy only when it is signed by this
    /// node's own org root, is for this cluster, lists this node and is newer than the copy held. It is judged at its
    /// own issue time: an expired directory is still copied (clients apply the dates, 1.3).
    fn relays_ok(&self, data: &[u8]) -> Result<(), String> {
        let wire: Value = serde_json::from_slice(data).map_err(|_| "the relay directory is not JSON".to_string())?;
        let issued = wire.get("directory").and_then(|d| d.get("issued")).and_then(Value::as_str).and_then(pj::from_iso).ok_or("the relay directory has no issue time")?;
        let held: Option<(String, u64)> = std::fs::read(self.dir.join(RELAYS_FILE)).ok().and_then(|d| serde_json::from_slice::<Value>(&d).ok()).and_then(|w| {
            let d = w.get("directory")?;
            Some((d.get("cluster")?.as_str()?.to_string(), d.get("version")?.as_u64()?))
        });
        for root in org_roots(&self.client_ca.lock()) {
            match crate::meet_relays::verify(&wire, &root, held.as_ref().map(|(c, v)| (c.as_str(), *v)), issued as i64) {
                Ok(d) if d.cluster != self.cfg.id => return Err(format!("the relay directory is for the cluster {}", d.cluster)),
                Ok(d) if !d.nodes.contains(&self.cfg.node) => return Err(format!("the relay directory does not list this node {}", self.cfg.node)),
                Ok(_) => return Ok(()),
                Err("sig") => continue,
                Err(code) => return Err(format!("the relay directory was refused ({code})")),
            }
        }
        Err("the relay directory is not signed by this relay's organization root".into())
    }

    /// The standby's side of a handover: take the lease the old active releases (retrying for 30 s), then the epoch.
    pub fn handover_take(&self, epoch: u64) -> Result<u64, String> {
        self.note_peer_active(self.now(), epoch);
        let w = self.witness.get().cloned();
        if let Some(w) = &w {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !matches!(self.acquire(&**w), Ok(true)) {
                if Instant::now() >= deadline {
                    return Err("the old active did not release the witness lease".into());
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        self.take_over(w.as_deref(), "the active relay handed over")
    }

    // ── roles: the witness (2.5) and the operator ──

    /// Ask for the lease; on success it is held from the moment the request went out.
    fn acquire(&self, w: &dyn Witness) -> Result<bool, String> {
        let sent = self.now();
        let got = w.acquire(&self.lease_id);
        if got == Ok(true) {
            let mut l = self.lease.lock();
            l.holding = true;
            l.last_renew = Some(sent);
        }
        got
    }

    fn release_lease(&self, w: &dyn Witness) {
        let mut l = self.lease.lock();
        if l.holding {
            if let Err(e) = w.release(&self.lease_id) {
                log_warn(&format!("cluster.witness-failed why={}", kv(&e)));
            }
            l.holding = false;
        }
    }

    /// Become active at a new epoch: one above the witness's, this node's and any the peer named. Called with the lease
    /// held when there is a witness. Before the epoch advances a failure releases the lease and changes nothing; after,
    /// the lease is kept (and renewed) while `cluster-state.json` is written again until it holds the promotion. The
    /// live role does not change: the process serves nothing until it restarts as active.
    fn take_over(&self, w: Option<&dyn Witness>, why: &str) -> Result<u64, String> {
        let _held = self.transition.lock();
        if self.in_transit() {
            return Err("a role change is already under way".into());
        }
        self.transit.store(true, Ordering::SeqCst);
        let abort = |e: String| {
            if let Some(w) = w {
                self.release_lease(w);
            }
            self.transit.store(false, Ordering::SeqCst);
            e
        };
        let blob = match w.map(|w| w.read()) {
            None => 0,
            Some(Ok(b)) => b.epoch,
            Some(Err(e)) => return Err(abort(e)),
        };
        let epoch = blob.max(self.epoch()).max(self.peer_seen.lock().1) + 1;
        if let Some(w) = w {
            let sent = self.now();
            if let Err(e) = w.set_epoch(&self.lease_id, epoch) {
                return Err(abort(e));
            }
            let mut l = self.lease.lock();
            l.holding = true;
            l.last_renew = Some(sent);
        }
        *self.promoted.lock() = Some(epoch);
        log_info(&format!("cluster.promoting node={} epoch={epoch} why={}", self.cfg.node, kv(why)));
        self.persist_promotion()
    }

    /// Write the pending promotion into `cluster-state.json` (the role in memory stays as it is).
    fn persist_promotion(&self) -> Result<u64, String> {
        let Some(epoch) = *self.promoted.lock() else { return Err("no promotion is pending".into()) };
        write_state(&self.dir, &NodeState { role: Role::Active, epoch, since: pj::now() as i64 })?;
        log_info(&format!("cluster.promoted node={} epoch={epoch}", self.cfg.node));
        Ok(epoch)
    }

    /// Stop serving and saving, optionally move the replica set aside, and record standby at `epoch`. The caller holds
    /// the transition lock; the node stays in transit (it restarts as standby).
    fn become_standby(&self, _held: &MutexGuard<'_, ()>, epoch: u64, aside: bool) -> Result<(), String> {
        self.transit.store(true, Ordering::SeqCst);
        self.node.lock().role = Role::Standby;
        if let Some(h) = self.hooks.get() {
            (h.barrier)();
        }
        if aside {
            let folder = self.move_aside(epoch)?;
            let _ = std::fs::remove_file(self.dir.join(REPLICA_FILE));
            *self.pulled.lock() = None;
            log_warn(&format!("cluster.moved-aside folder={} epoch={epoch}", kv(&folder.display().to_string())));
        }
        self.persist(Role::Standby, epoch)
    }

    /// 2.5: the replica set into `state.before-epoch-<n>/` (the writes this node took after its last replicated
    /// generation are there only).
    fn move_aside(&self, epoch: u64) -> Result<PathBuf, String> {
        let mut name = format!("{ASIDE_PREFIX}{epoch}");
        let mut i = 2;
        while std::fs::symlink_metadata(self.dir.join(&name)).is_ok() {
            name = format!("{ASIDE_PREFIX}{epoch}-{i}");
            i += 1;
        }
        let failed = |e: std::io::Error| format!("cannot move the replica set aside: {e}");
        let target = tree::Dir::open(&self.dir, Some(&name), true).map_err(failed)?;
        for e in listing(&self.dir) {
            let (sub, file) = split(&e.path);
            let from = tree::Dir::open(&self.dir, sub, false).map_err(failed)?;
            let moved = match sub {
                None => from.rename(file, &target, file),
                Some(s) => tree::Dir::open(target.path(), Some(s), true).and_then(|to| from.rename(file, &to, file)),
            };
            moved.map_err(failed)?;
        }
        self.hashes.lock().clear();
        Ok(target.path().to_path_buf())
    }

    fn step_down(&self, w: &dyn Witness, epoch: u64) -> Step {
        log_warn(&format!("cluster.replaced node={} epoch={epoch} own={}", self.cfg.node, self.epoch()));
        let held = self.transition.lock();
        if let Err(e) = self.become_standby(&held, epoch, true) {
            log_error(&format!("cluster.step-down-failed why={}", kv(&e)));
            return Step::Stay;
        }
        self.release_lease(w);
        Step::Exit
    }

    fn fence(&self, own: u64) {
        let _held = self.transition.lock();
        if self.role() == Role::Active && !self.in_transit() {
            if let Err(e) = self.persist(Role::Fenced, own) {
                log_error(&e);
            }
            log_warn(&format!("cluster.fenced node={} epoch={own} why=\"the witness lease was not renewed for {} s\"", self.cfg.node, self.cfg.lease_s));
        }
    }

    fn unfence(&self, own: u64) {
        let _held = self.transition.lock();
        if self.role() == Role::Fenced && !self.in_transit() && self.epoch() == own {
            if let Err(e) = self.persist(Role::Active, own) {
                log_error(&e);
                return;
            }
            log_info(&format!("cluster.unfenced node={} epoch={own}", self.cfg.node));
        }
    }

    /// 2.5 at start: an active node with a witness serves nobody until it renews its lease and the witness's epoch is
    /// its own (it may have been replaced while it was down).
    pub fn hold_until_renewed(&self) {
        let mut n = self.node.lock();
        if n.role == Role::Active && self.witness.get().is_some() {
            n.role = Role::Fenced;
        }
    }

    /// One witness round (every 10 s; `peer` the peer's `/healthz` when it answered).
    pub fn witness_tick(&self, peer: Option<&Value>) -> Step {
        let peer_active = peer.filter(|h| h.get("role").and_then(Value::as_str) == Some("active"));
        if let Some(h) = peer_active {
            self.note_peer_active(self.now(), h.get("epoch").and_then(Value::as_u64).unwrap_or(0));
        }
        // a promotion the witness holds but the disk not yet: keep the lease, write again, then restart
        if self.promoted.lock().is_some() {
            if let Some(w) = self.witness.get() {
                let sent = self.now();
                if w.renew(&self.lease_id) == Ok(true) {
                    self.lease.lock().last_renew = Some(sent);
                }
            }
            return match self.persist_promotion() {
                Ok(_) => Step::Exit,
                Err(e) => {
                    log_error(&format!("cluster.promote-unsaved why={}", kv(&e)));
                    Step::Stay
                }
            };
        }
        if self.in_transit() {
            return Step::Stay;
        }
        let Some(w) = self.witness.get().cloned() else { return Step::Stay };
        if self.role() == Role::Standby {
            return self.standby_tick(&*w);
        }
        self.holder_tick(&*w, peer_active)
    }

    /// The active (or fenced) node's round. The fence deadline counts from the last renewal that went out and is read
    /// again after every call that may block; past it the node fences itself and does no more than look for a higher
    /// epoch.
    fn holder_tick(&self, w: &dyn Witness, peer_active: Option<&Value>) -> Step {
        let own = self.epoch();
        let lease_s = self.cfg.lease_s as f64;
        let (holding, mut last) = {
            let l = self.lease.lock();
            (l.holding, l.last_renew.unwrap_or(l.started))
        };
        let sent = self.now();
        let got = if holding { w.renew(&self.lease_id) } else { w.acquire(&self.lease_id) };
        let renewed = match got {
            Ok(true) => {
                let mut l = self.lease.lock();
                l.holding = true;
                l.last_renew = Some(sent);
                last = sent;
                true
            }
            Ok(false) => {
                self.lease.lock().holding = false;
                false
            }
            Err(e) => {
                log_warn(&format!("cluster.witness-failed why={}", kv(&e)));
                false
            }
        };
        let lapsed = |c: &Cluster| c.now() - last >= lease_s;
        if lapsed(self) {
            self.fence(own);
        }
        // a higher epoch in the blob or from the peer: this node was replaced while it could not renew
        let blob = w.read();
        let higher = blob.as_ref().ok().map(|b| b.epoch).filter(|e| *e > own).or_else(|| peer_active.and_then(|h| h.get("epoch").and_then(Value::as_u64)).filter(|e| *e > own));
        if let Some(epoch) = higher {
            return self.step_down(w, epoch);
        }
        if !renewed || lapsed(self) {
            if lapsed(self) {
                self.fence(own);
            }
            return Step::Stay;
        }
        let Ok(b) = blob else { return Step::Stay };
        // the witness holds this node's epoch: as found, or written now under the lease just renewed
        let own_epoch = b.epoch == own || (b.epoch < own && w.set_epoch(&self.lease_id, own).inspect_err(|e| log_warn(&format!("cluster.witness-failed why={}", kv(e)))).is_ok());
        if own_epoch && !lapsed(self) && self.role() == Role::Fenced {
            self.unfence(own);
        }
        Step::Stay
    }

    /// 2.5: a standby with `auto_promote` takes over once the active has not answered for `promote_after_s`, it holds a
    /// complete copy (`cluster-replica.json`), and the lease is free (only after the active's lease expired, so the
    /// active fenced itself first).
    fn standby_tick(&self, w: &dyn Witness) -> Step {
        if !self.cfg.auto_promote || self.now() - self.peer_seen.lock().0 < self.cfg.promote_after_s as f64 || self.pulled.lock().is_none() {
            return Step::Stay;
        }
        match self.acquire(w) {
            Ok(true) => match self.take_over(Some(w), "the active relay stopped answering") {
                Ok(_) => Step::Exit,
                Err(e) => {
                    log_error(&format!("cluster.promote-failed why={}", kv(&e)));
                    Step::Stay
                }
            },
            Ok(false) => Step::Stay,
            Err(e) => {
                log_warn(&format!("cluster.witness-failed why={}", kv(&e)));
                Step::Stay
            }
        }
    }

    /// `cluster promote`: standby (or fenced) to active; refused while the peer answers as active, and before this
    /// node holds a complete copy, unless `force`.
    pub fn op_promote(&self, force: bool) -> Result<Obj, String> {
        if self.role() == Role::Active {
            return Err("This relay is already the active relay.".into());
        }
        if !force {
            if self.pulled.lock().is_none() {
                return Err("This relay holds no complete copy of the active relay yet; force the promotion to go on without one.".into());
            }
            // without its client certificate this node cannot tell a silent peer from one it may not ask
            if let Some(Err(e)) = self.peer.get().map(|p| p.ready()) {
                return Err(format!("{e}; the peer cannot be asked whether it is active."));
            }
            if let Some(h) = self.peer.get().and_then(|p| p.health().ok()) {
                if h.get("role").and_then(Value::as_str) == Some("active") {
                    return Err(format!("The peer {} answers as the active relay. Make it standby first, or force the promotion if you are sure it is down.", self.cfg.peer.node));
                }
            }
        }
        let w = self.witness.get().cloned();
        let leased = match &w {
            None => false,
            Some(w) => match self.acquire(&**w) {
                Ok(true) => true,
                Ok(false) => return Err("The witness lease is still held by the active relay; it expires 60 s after its last renewal.".into()),
                Err(e) if force => {
                    log_warn(&format!("cluster.witness-failed why={}", kv(&e)));
                    false
                }
                Err(e) => return Err(format!("The witness cannot be reached ({e}); force the promotion to go on without it.")),
            },
        };
        let epoch = self.take_over(if leased { w.as_deref() } else { None }, if force { "an operator forced the promotion" } else { "an operator promoted it" })?;
        Ok(obj([("ok", Value::Bool(true)), ("role", Value::from("active")), ("epoch", Value::from(epoch)), ("restart", Value::Bool(true))]))
    }

    /// `cluster demote`: active (or fenced) to standby; what it holds is saved first, its lease released.
    pub fn op_demote(&self) -> Result<Obj, String> {
        let held = self.transition.lock();
        if self.role() == Role::Standby || self.in_transit() {
            return Err("This relay is already a standby.".into());
        }
        if let Some(h) = self.hooks.get() {
            (h.flush)();
        }
        let epoch = self.epoch();
        self.become_standby(&held, epoch, false)?;
        if let Some(w) = self.witness.get() {
            self.release_lease(&**w);
        }
        log_info(&format!("cluster.demoted node={} epoch={epoch}", self.cfg.node));
        Ok(obj([("ok", Value::Bool(true)), ("role", Value::from("standby")), ("epoch", Value::from(epoch)), ("restart", Value::Bool(true))]))
    }

    /// `cluster handover` on the active: stop admitting writes, wait for the admitted ones, save, wait until the standby
    /// has the last generation, then let it promote and become standby. Nothing changes when the writers or the standby
    /// do not finish within `wait`.
    pub fn op_handover(&self, wait: Duration) -> Result<Obj, String> {
        let held = self.transition.lock();
        if self.role() != Role::Active || self.in_transit() {
            return Err("Only the active relay can hand over.".into());
        }
        let deadline = Instant::now() + wait;
        {
            let mut r = self.repl.lock();
            if r.handover != Handover::Idle {
                return Err("A handover is already running.".into());
            }
            if !r.heard.is_some_and(|(at, _)| pj::now() as i64 - at <= HEARD_FRESH) {
                return Err(format!("The standby is not copying from this relay (no request in the last {HEARD_FRESH} s); nothing was changed."));
            }
            r.handover = Handover::Draining;
            log_info(&format!("cluster.handover-started node={} writers={}", self.cfg.node, r.writers));
            while r.writers > 0 {
                if self.changed.wait_until(&mut r, deadline).timed_out() {
                    r.handover = Handover::Idle;
                    return Err(format!("Requests still writing after {} s; this relay stays active.", wait.as_secs()));
                }
            }
        }
        if let Some(h) = self.hooks.get() {
            (h.flush)();
        }
        self.scan();
        let mut r = self.repl.lock();
        r.handover = Handover::Ready;
        self.changed.notify_all();
        while r.handover != Handover::Confirmed {
            if self.changed.wait_until(&mut r, deadline).timed_out() {
                break;
            }
        }
        if r.handover != Handover::Confirmed {
            r.handover = Handover::Idle;
            return Err(format!("The standby did not take the last generation within {} s; this relay stays active.", wait.as_secs()));
        }
        let generation = r.generation;
        drop(r);
        let epoch = self.epoch();
        self.become_standby(&held, epoch, false)?;
        if let Some(w) = self.witness.get() {
            self.release_lease(&**w);
        }
        log_info(&format!("cluster.handed-over node={} generation={generation} epoch={epoch}", self.cfg.node));
        Ok(obj([("ok", Value::Bool(true)), ("role", Value::from("standby")), ("epoch", Value::from(epoch)), ("generation", Value::from(generation)), ("restart", Value::Bool(true))]))
    }

    pub fn command(&self, cmd: &str, force: bool) -> Result<Obj, String> {
        match cmd {
            "promote" => self.op_promote(force),
            "demote" => self.op_demote(),
            "handover" => self.op_handover(HANDOVER_WAIT),
            _ => Err(format!("unknown cluster command {}", kv(cmd))),
        }
    }

    /// A command of the console or the CLI: answered, then the relay restarts in its new role.
    pub fn command_and_restart(&self, cmd: &str, force: bool) -> Result<Obj, String> {
        let r = self.command(cmd, force);
        if r.is_ok() {
            let why = format!("cluster {cmd}");
            let _ = std::thread::Builder::new().name("relay-cluster-restart".into()).spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                restart(&why);
            });
        }
        r
    }

    /// The console's `meet/cluster/status` and the fleet report's `cluster` (shared interface).
    pub fn status(&self) -> Value {
        let st = self.state();
        let now = pj::now() as i64;
        let (generation, lag) = match st.role {
            Role::Standby => {
                let p = *self.pulled.lock();
                (p.map(|p| p.generation), p.map(|p| (now - p.at).max(0)))
            }
            _ => {
                let r = self.repl.lock();
                (Some(r.generation), r.heard.map(|(at, _)| (now - at).max(0)))
            }
        };
        json!({
            "ok": true, "cluster": self.cfg.id, "node": self.cfg.node, "role": st.role.word(), "epoch": st.epoch,
            "generation": generation, "lagS": lag, "peer": self.cfg.peer.node, "witness": !self.cfg.witness_file.is_empty(),
            "autoPromote": self.cfg.auto_promote, "directoryVersion": crate::meet_relays::version(&self.dir),
            "directoryExpires": crate::meet_relays::expires(&self.dir), "pullError": self.pull_error.lock().clone(),
            "relaysError": self.relays_error.lock().clone(),
        })
    }

    // ── the running relay ──

    /// A command the CLI left in the state folder: run on its own thread (a handover waits), answer in the result file.
    fn take_command(self: &Arc<Self>) {
        let path = self.dir.join(COMMAND_FILE);
        let Ok(data) = std::fs::read(&path) else { return };
        let _ = std::fs::remove_file(&path);
        let Ok(v) = serde_json::from_slice::<Value>(&data) else { return };
        let c = self.clone();
        let _ = std::thread::Builder::new().name("relay-cluster-command".into()).spawn(move || {
            let id = v.get("id").cloned().unwrap_or(Value::Null);
            let r = c.command_and_restart(v.get("cmd").and_then(Value::as_str).unwrap_or(""), v.get("force").and_then(Value::as_bool).unwrap_or(false));
            let mut out = r.unwrap_or_else(|e| obj([("ok", Value::Bool(false)), ("error", Value::from(e))]));
            out.insert("id".into(), id);
            let _ = write_synced(&c.dir.join(RESULT_FILE), pj::dumps(&Value::Object(out)).as_bytes());
        });
    }

    fn write_status(&self) {
        let mut v = self.status();
        v["at"] = Value::from(pj::now() as i64);
        let _ = write_synced(&self.dir.join(STATUS_FILE), pj::dumps(&v).as_bytes());
    }

    /// Commands every second; the witness and the peer's health every 10 s (the active reaches nothing on its peer).
    fn run(self: Arc<Self>) {
        let mut last = f64::MIN;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            self.take_command();
            let now = self.now();
            if now - last < TICK_EVERY {
                continue;
            }
            last = now;
            let health = if self.role() == Role::Active { None } else { self.peer.get().and_then(|p| p.health().ok()) };
            if self.witness_tick(health.as_ref()) == Step::Exit {
                restart("the witness changed this node's role");
            }
            self.write_status();
        }
    }

    /// The standby asks again at once after applying; after a failure, 5 s later. Nothing is pulled once a role change
    /// is under way.
    fn pull_loop(self: Arc<Self>) {
        loop {
            let Some(peer) = self.peer.get().cloned() else { return };
            if self.role() != Role::Standby || self.in_transit() {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            match self.pull_reported(&*peer, WAIT_MAX) {
                Ok(PullOutcome::Handover { epoch }) => match self.handover_take(epoch) {
                    Ok(_) => restart("the active relay handed over"),
                    Err(e) => log_error(&format!("cluster.promote-failed why={}", kv(&e))),
                },
                Ok(PullOutcome::Applied { generation, fetched, deleted }) => {
                    if fetched + deleted > 0 {
                        log_info(&format!("cluster.pulled generation={generation} copied={fetched} deleted={deleted}"));
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_secs(5)),
            }
        }
    }

    /// One pull whose failure is logged once (until it changes) and shown in the status (`pullError`) until a pull
    /// works again: a client certificate that does not load, an unreachable peer, a refused answer.
    pub fn pull_reported(&self, peer: &dyn Peer, wait: u64) -> Result<PullOutcome, String> {
        let r = peer.ready().and_then(|()| self.pull_once(peer, wait));
        let mut last = self.pull_error.lock();
        match &r {
            Ok(_) => *last = None,
            Err(e) => {
                if last.as_deref() != Some(e.as_str()) {
                    log_warn(&format!("cluster.pull-failed why={}", kv(e)));
                }
                *last = Some(e.clone());
            }
        }
        r
    }
}

/// At start, before the listeners: the peer client, the witness, the Hub's save hooks; an active node with a witness
/// holds off until the witness confirms it (checked once now, it may have been replaced while it was down), then the
/// loops.
pub fn start(c: &Arc<Cluster>, s: &Settings, hub: &Arc<crate::meet_hub::Hub>) -> Result<(), String> {
    c.set_client_ca(&s.client_ca);
    c.set_peer(Arc::new(HttpsPeer::new(s, &c.cfg)));
    if !c.cfg.witness_file.is_empty() {
        c.set_witness(Arc::new(AzureWitness::new(crate::meet_witness::read_url(Path::new(&c.cfg.witness_file))?)));
    }
    let (a, b) = (Arc::downgrade(hub), Arc::downgrade(hub));
    c.set_hooks(Hooks {
        flush: Box::new(move || {
            if let Some(h) = a.upgrade() {
                h.save();
            }
        }),
        barrier: Box::new(move || {
            if let Some(h) = b.upgrade() {
                h.save_barrier();
            }
        }),
    });
    c.hold_until_renewed();
    let st = c.state();
    log_info(&format!(
        "cluster: {} node={} role={} epoch={} peer={} witness={} auto_promote={}",
        c.cfg.id,
        c.cfg.node,
        st.role.word(),
        st.epoch,
        c.cfg.peer.node,
        if c.witness.get().is_some() { "on" } else { "none" },
        c.cfg.auto_promote
    ));
    if st.role != Role::Standby && c.witness.get().is_some() && c.witness_tick(None) == Step::Exit {
        restart("this node was replaced while it was down");
    }
    c.write_status();
    let r = c.clone();
    std::thread::Builder::new().name("relay-cluster".into()).spawn(move || r.run()).map_err(|e| e.to_string())?;
    let p = c.clone();
    std::thread::Builder::new().name("relay-cluster-pull".into()).spawn(move || p.pull_loop()).map_err(|e| e.to_string())?;
    Ok(())
}

// ── `lucid-relay meet cluster ...` ───────────────────────────────────────────────────────────────────────────

const USAGE: &str = "usage: lucid-relay meet cluster status|promote [--force] --yes|demote --yes|handover --yes --config <relay.json>";

pub fn cli(argv: &[String]) -> ! {
    fn fail(code: i32, words: &str) -> ! {
        eprintln!("{words}");
        std::process::exit(code)
    }
    let (config, rest) = crate::meet::split_config(argv);
    let Some(config) = config else { fail(2, USAGE) };
    let cmd = rest.first().cloned().unwrap_or_default();
    if !["status", "promote", "demote", "handover"].contains(&cmd.as_str()) || rest[1..].iter().any(|a| a != "--force" && a != "--yes") || (cmd != "promote" && rest.iter().any(|a| a == "--force")) {
        fail(2, USAGE);
    }
    let (force, yes) = (rest.iter().any(|a| a == "--force"), rest.iter().any(|a| a == "--yes"));
    let s = Settings::load(&config).unwrap_or_else(|e| fail(1, &e));
    let Some(cfg) = s.cluster.clone() else { fail(1, "relay settings: this relay has no cluster") };
    let code = run_cli(&s, &cfg, Path::new(&s.state_dir), &cmd, force, yes, &mut std::io::stdout());
    std::process::exit(code)
}

/// The status of a stopped relay, from its files.
fn offline_status(cfg: &ClusterSettings, dir: &Path) -> Value {
    let st = read_state(dir).ok().flatten();
    let pulled = read_pulled(dir);
    json!({
        "ok": true, "cluster": cfg.id, "node": cfg.node, "role": st.map_or(cfg.role, |s| s.role).word(), "epoch": st.map_or(1, |s| s.epoch),
        "generation": pulled.map(|p| p.generation), "lagS": Value::Null, "peer": cfg.peer.node, "witness": !cfg.witness_file.is_empty(),
        "autoPromote": cfg.auto_promote, "directoryVersion": crate::meet_relays::version(dir), "directoryExpires": crate::meet_relays::expires(dir),
    })
}

fn run_cli(s: &Settings, cfg: &ClusterSettings, dir: &Path, cmd: &str, force: bool, yes: bool, out: &mut dyn Write) -> i32 {
    let lock = crate::server::file_lock(&dir.join(LOCK_FILE));
    let running = lock.is_err();
    let print = |out: &mut dyn Write, v: &Value| {
        let _ = writeln!(out, "{}", pj::dumps_indent(v, 2));
    };
    if cmd == "status" {
        let live = running
            .then(|| std::fs::read(dir.join(STATUS_FILE)).ok().and_then(|d| serde_json::from_slice::<Value>(&d).ok()))
            .flatten()
            .filter(|v| v.get("at").and_then(Value::as_i64).is_some_and(|at| pj::now() as i64 - at <= STATUS_FRESH));
        let mut v = live.unwrap_or_else(|| offline_status(cfg, dir));
        v["running"] = Value::Bool(running);
        print(out, &v);
        return 0;
    }
    if !yes {
        eprintln!("This changes the relay's role: add --yes to {cmd} it.");
        return 2;
    }
    let answer = if running {
        // the running relay takes the command from its state folder and answers beside it
        let id = pj::token_hex(8);
        let _ = std::fs::remove_file(dir.join(RESULT_FILE));
        if let Err(e) = write_synced(&dir.join(COMMAND_FILE), pj::dumps(&json!({"id": id, "cmd": cmd, "force": force})).as_bytes()) {
            eprintln!("cannot write {COMMAND_FILE}: {e}");
            return 1;
        }
        let deadline = Instant::now() + HANDOVER_WAIT + Duration::from_secs(30);
        loop {
            let got = std::fs::read(dir.join(RESULT_FILE)).ok().and_then(|d| serde_json::from_slice::<Value>(&d).ok()).filter(|v| v.get("id").and_then(Value::as_str) == Some(id.as_str()));
            if let Some(v) = got {
                break v;
            }
            if Instant::now() >= deadline {
                let _ = std::fs::remove_file(dir.join(COMMAND_FILE));
                eprintln!("The running relay did not answer the {cmd} command.");
                return 1;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    } else {
        let r = (|| -> Result<Obj, String> {
            if cmd == "handover" {
                return Err("A handover needs the relay running: start it, then hand over again.".into());
            }
            let c = Cluster::new(cfg.clone(), dir, None)?;
            c.set_client_ca(&s.client_ca);
            c.set_peer(Arc::new(HttpsPeer::new(s, cfg)));
            if !cfg.witness_file.is_empty() {
                c.set_witness(Arc::new(AzureWitness::new(crate::meet_witness::read_url(Path::new(&cfg.witness_file))?)));
            }
            c.command(cmd, force)
        })();
        drop(lock);
        match r {
            Ok(mut o) => {
                o.remove("restart");
                Value::Object(o)
            }
            Err(e) => json!({"ok": false, "error": e}),
        }
    };
    print(out, &answer);
    if answer.get("ok") == Some(&Value::Bool(true)) {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meet_tls::testpki::{dir, Ca, Key};
    use crate::meet_witness::BlobView;
    use std::sync::atomic::AtomicU64;

    const ID: &str = "emertins-meet";

    fn pin(der: &[u8]) -> String {
        crate::codec::b64u(&crate::codec::sha256(&crate::meet_x509::Cert::from_der(der).unwrap().spki))
    }

    fn settings(node: &str, peer: &str, role: Role, peer_pin: &str) -> ClusterSettings {
        ClusterSettings {
            id: ID.into(),
            node: node.into(),
            role,
            peer: PeerSettings { node: peer.into(), url: format!("https://{peer}.example.org"), host: format!("{peer}.example.org"), port: 443, address: String::new(), spki_sha256: peer_pin.into() },
            client_cert: "/c.crt".into(),
            client_key: "/c.key".into(),
            witness_file: String::new(),
            lease_s: 30,
            promote_after_s: 90,
            auto_promote: true,
        }
    }

    /// Two nodes: `lab` active and `azure` standby, each pinning the other's relay-client certificate.
    struct Pair {
        lab: Arc<Cluster>,
        azure: Arc<Cluster>,
        azure_der: Vec<u8>,
        other_der: Vec<u8>,
    }

    fn pair() -> Pair {
        let ca = Ca::new("Lucid Meet CA");
        let lab_der = ca.leaf(&[0x51], "Lucid Meet Relay", None, &[crate::meet::RELAY_URI], &Key::new(), true);
        let azure_der = ca.leaf(&[0x52], "Lucid Meet Relay", None, &[crate::meet::RELAY_URI], &Key::new(), true);
        let other_der = ca.leaf(&[0x53], "Ann", Some("ann@x.org"), &["urn:lucid-meet:device:0123456789abcdef"], &Key::new(), true);
        let lab = Cluster::open(&settings("lab", "azure", Role::Active, &pin(&azure_der)), &dir("cluster-lab")).unwrap();
        let azure = Cluster::open(&settings("azure", "lab", Role::Standby, &pin(&lab_der)), &dir("cluster-azure")).unwrap();
        Pair { lab, azure, azure_der, other_der }
    }

    /// The active, reached in process with the standby's certificate.
    struct Local {
        active: Arc<Cluster>,
        der: Vec<u8>,
    }

    fn q(pairs: &[(&str, String)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    impl Peer for Local {
        fn replica(&self, have: u64, wait: u64) -> Result<Value, String> {
            match self.active.route("GET", "/v1/cluster/replica", &q(&[("have", have.to_string()), ("wait", wait.to_string())]), Some(&self.der)) {
                Some(Answer::Json(200, o)) => Ok(Value::Object(o)),
                other => Err(format!("{other:?}")),
            }
        }
        fn file(&self, path: &str, sha256: &str, _size: u64, out: &mut dyn Write) -> Result<bool, String> {
            match self.active.route("GET", "/v1/cluster/file", &q(&[("path", path.into()), ("sha256", sha256.into())]), Some(&self.der)) {
                Some(Answer::File(mut f, n)) => {
                    assert_eq!(std::io::copy(&mut f, out).map_err(|e| e.to_string())?, n);
                    Ok(true)
                }
                Some(Answer::Json(409, _)) => Ok(false),
                other => Err(format!("{other:?}")),
            }
        }
        fn health(&self) -> Result<Value, String> {
            Ok(Value::Object(self.active.health()))
        }
    }

    fn local(p: &Pair) -> Local {
        Local { active: p.lab.clone(), der: p.azure_der.clone() }
    }

    fn put(d: &Path, path: &str, data: &str) {
        let p = d.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, data).unwrap();
    }

    fn read(d: &Path, path: &str) -> Option<String> {
        std::fs::read_to_string(d.join(path)).ok()
    }

    #[test]
    fn settings_are_strict() {
        let pin = crate::codec::b64u(&[7u8; 32]);
        let good = json!({"id": ID, "node": "lab", "role": "active", "peer": {"node": "azure", "url": "https://meet-azure.emertins.com:443", "address": "", "spki_sha256": pin},
            "client_cert": "/etc/lucid-meet/relay-client.crt", "client_key": "/etc/lucid-meet/relay-client.key", "witness_file": "/etc/lucid-meet/cluster-witness.url", "lease_s": 30, "promote_after_s": 90, "auto_promote": true});
        let c = parse(&good).unwrap();
        assert_eq!((c.peer.host.as_str(), c.peer.port, c.role, c.auto_promote), ("meet-azure.emertins.com", 443, Role::Active, true));
        let mut minimal = good.clone();
        for k in ["witness_file", "lease_s", "promote_after_s", "auto_promote"] {
            minimal.as_object_mut().unwrap().remove(k);
        }
        let m = parse(&minimal).unwrap();
        assert_eq!((m.witness_file.as_str(), m.lease_s, m.promote_after_s, m.auto_promote), ("", 30, 90, false));
        let refused = |f: &dyn Fn(&mut Value)| {
            let mut v = good.clone();
            f(&mut v);
            parse(&v).unwrap_err()
        };
        assert_eq!(refused(&|v| v["extra"] = json!(1)), "unknown relay settings: cluster.extra");
        assert_eq!(refused(&|v| v["peer"]["cert"] = json!("x")), "unknown relay settings: cluster.peer.cert");
        assert!(refused(&|v| v["id"] = json!("Emertins")).contains("cluster.id"));
        assert!(refused(&|v| v["role"] = json!("fenced")).contains("cluster.role"));
        assert!(refused(&|v| v["peer"]["node"] = json!("lab")).contains("cluster.peer.node"));
        for url in ["http://meet-azure.emertins.com", "https://10.0.0.1", "https://meet-azure.emertins.com/x", "https://Meet.example.org"] {
            assert!(refused(&|v| v["peer"]["url"] = json!(url)).contains("cluster.peer.url"), "{url}");
        }
        assert!(refused(&|v| v["peer"]["spki_sha256"] = json!("abc")).contains("spki_sha256"));
        assert!(refused(&|v| v["client_key"] = json!("")).contains("client_key"));
        assert!(refused(&|v| v["lease_s"] = json!(60)).contains("lease_s"));
        assert!(refused(&|v| v["promote_after_s"] = json!(1.5)).contains("promote_after_s"));
        assert!(refused(&|v| v["auto_promote"] = json!("yes")).contains("auto_promote"));
        assert_eq!(parse(&json!([])).unwrap_err(), "relay settings: cluster must be an object");
        // a padded pin reads as the same pin
        let mut padded = good.clone();
        padded["peer"]["spki_sha256"] = json!(format!("{pin}="));
        assert_eq!(parse(&padded).unwrap().peer.spki_sha256, pin);
    }

    #[test]
    fn the_first_start_takes_the_role_from_relay_json_then_the_file_wins() {
        let d = dir("cluster-state");
        let cfg = settings("lab", "azure", Role::Standby, &crate::codec::b64u(&[1u8; 32]));
        assert_eq!(open_state(&d, &cfg).unwrap().role, Role::Standby);
        write_state(&d, &NodeState { role: Role::Active, epoch: 4, since: 1 }).unwrap();
        let st = open_state(&d, &cfg).unwrap();
        assert_eq!((st.role, st.epoch), (Role::Active, 4));
        std::fs::write(d.join(STATE_FILE), r#"{"role": "boss", "epoch": 1}"#).unwrap();
        assert!(open_state(&d, &cfg).is_err());
        // one process per state folder
        let d2 = dir("cluster-lock");
        let _held = Cluster::open(&cfg, &d2).unwrap();
        assert!(Cluster::open(&cfg, &d2).is_err());
    }

    #[test]
    fn the_replica_routes_answer_only_the_pinned_peer() {
        let p = pair();
        let get = |path: &str, query: &[(&str, String)], der: Option<&[u8]>| p.lab.route("GET", path, &q(query), der);
        let wait0 = [("wait", "0".to_string())];
        assert!(matches!(get("/v1/cluster/replica", &wait0, Some(&p.azure_der)), Some(Answer::Json(200, _))));
        for der in [Some(p.other_der.as_slice()), None] {
            assert!(matches!(get("/v1/cluster/replica", &wait0, der), Some(Answer::Json(404, ref o)) if o["error"] == "unknown path"));
            assert!(matches!(get("/v1/cluster/file", &[("path", "state.json".into())], der), Some(Answer::Json(404, _))));
            // /healthz goes on to the main dispatch for anyone else
            assert!(get("/healthz", &[], der).is_none());
        }
        assert!(matches!(p.lab.route("POST", "/v1/cluster/replica", &[], Some(&p.azure_der)), Some(Answer::Json(404, _))));
        assert!(matches!(get("/v1/cluster/other", &[], Some(&p.azure_der)), Some(Answer::Json(404, _))));
        assert!(get("/v1/whoami", &[], Some(&p.azure_der)).is_none());
        match get("/healthz", &[], Some(&p.azure_der)) {
            Some(Answer::Json(200, o)) => assert_eq!(Value::Object(o), json!({"ok": true, "role": "active", "epoch": 1, "node": "lab"})),
            other => panic!("{other:?}"),
        }
        for bad in ["../relay.json", "license.lic", "files/../state.json", "files/.hidden", "files/a.part", "fleet.json", "/state.json"] {
            assert!(matches!(get("/v1/cluster/file", &[("path", bad.into()), ("sha256", "0".repeat(64))], Some(&p.azure_der)), Some(Answer::Json(404, _))), "{bad}");
        }
    }

    #[test]
    fn generation_and_file_sync_with_deletes() {
        let p = pair();
        let (a, b) = (&p.lab.dir, &p.azure.dir);
        put(a, "state.json", "{\"v\": 2}");
        put(a, "push.secret", "secret");
        put(a, "files/0123456789abcdef0123456789abcdef", "file one");
        put(a, "files/fedcba9876543210fedcba9876543210", "file two");
        put(a, "files/fedcba9876543210fedcba9876543211.part", "uploading");
        put(a, "emoji/abc", "emoji");
        put(a, "license.lic", "lab license");
        put(b, "meet-time.json", "azure time");
        put(b, "relays.json", "azure directory");
        put(b, "emoji/old", "gone on the active");
        let g0 = p.lab.scan();
        assert!(g0 > 1_700_000_000_000, "generations start at the clock");
        assert_eq!(p.lab.scan(), g0, "nothing changed");
        let peer = local(&p);
        let out = p.azure.pull_once(&peer, 0).unwrap();
        assert_eq!(out, PullOutcome::Applied { generation: g0, fetched: 5, deleted: 1 });
        for f in ["state.json", "push.secret", "files/0123456789abcdef0123456789abcdef", "files/fedcba9876543210fedcba9876543210", "emoji/abc"] {
            assert_eq!(read(b, f), read(a, f), "{f}");
        }
        // per node: never copied, never deleted; no temporary file stays
        assert_eq!(read(b, "license.lic"), None);
        assert_eq!(read(b, "files/fedcba9876543210fedcba9876543211.part"), None);
        assert_eq!(read(b, "meet-time.json").as_deref(), Some("azure time"));
        assert_eq!(read(b, "relays.json").as_deref(), Some("azure directory"));
        assert_eq!(read(b, "emoji/old"), None);
        assert!(std::fs::read_dir(b.join("files")).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with('.')));
        let mark: Value = serde_json::from_str(&read(b, REPLICA_FILE).unwrap()).unwrap();
        assert_eq!((mark["epoch"].as_u64(), mark["generation"].as_u64()), (Some(1), Some(g0)));
        // the same generation again: nothing to copy (and the long-poll answers when the wait ends)
        assert_eq!(p.azure.pull_once(&peer, 0).unwrap(), PullOutcome::Applied { generation: g0, fetched: 0, deleted: 0 });
        // a change and a delete: one generation more
        put(a, "state.json", "{\"v\": 2, \"x\": 1}");
        std::fs::remove_file(a.join("files/0123456789abcdef0123456789abcdef")).unwrap();
        p.lab.note_saved();
        let out = p.azure.pull_once(&peer, 0).unwrap();
        assert_eq!(out, PullOutcome::Applied { generation: g0 + 1, fetched: 1, deleted: 1 });
        assert_eq!(read(b, "state.json"), read(a, "state.json"));
        assert_eq!(read(b, "files/0123456789abcdef0123456789abcdef"), None);
        // a file that changed since it was listed is 409
        let sha = crate::codec::sha256_hex(b"old bytes");
        assert!(matches!(p.lab.route("GET", "/v1/cluster/file", &q(&[("path", "state.json".into()), ("sha256", sha)]), Some(&p.azure_der)), Some(Answer::Json(409, _))));
        // the long-poll wakes at the next save
        let lab = p.lab.clone();
        let waiter = std::thread::spawn(move || lab.replica(g0 + 1, Duration::from_secs(20))["generation"].as_u64());
        std::thread::sleep(Duration::from_millis(200));
        put(a, "meet-seats.json", "{}");
        p.lab.note_saved();
        assert_eq!(waiter.join().unwrap(), Some(g0 + 2));
        // the active records the standby's heartbeat; the status reads it
        let s = p.lab.status();
        assert_eq!((s["role"].as_str(), s["generation"].as_u64(), s["lagS"].as_i64(), s["peer"].as_str()), (Some("active"), Some(g0 + 2), Some(0), Some("azure")));
        let s = p.azure.status();
        assert_eq!((s["role"].as_str(), s["generation"].as_u64(), s["witness"].as_bool()), (Some("standby"), Some(g0 + 1), Some(false)));
    }

    /// MR-1 1.4 on the standby: the active's `relays.json` replaces this node's only when it verifies here.
    #[test]
    fn a_relay_directory_that_does_not_verify_here_is_not_taken() {
        let p = pair();
        put(&p.lab.dir, "relays.json", r#"{"directory": {"issued": "2026-11-26T04:00:00Z", "version": 9}, "sig": "AA=="}"#);
        put(&p.azure.dir, "relays.json", "azure directory");
        let out = p.azure.pull_once(&local(&p), 0).unwrap();
        assert!(matches!(out, PullOutcome::Applied { fetched: 0, .. }));
        assert_eq!(read(&p.azure.dir, "relays.json").as_deref(), Some("azure directory"));
        assert!(p.azure.status()["relaysError"].as_str().is_some_and(|e| e.contains("relay directory")));
        assert!(!p.azure.dir.join(".relays.json.pull").exists());
    }

    #[test]
    fn a_standby_refuses_every_client_route_but_three() {
        let p = pair();
        let want = json!({"ok": false, "code": "standby", "error": STANDBY_WORDS, "active": "lab"});
        for (method, path, _) in crate::meet_license::GATE {
            let exempt = matches!((*method, *path), ("GET", "/healthz") | ("GET", "/v1/relays") | ("GET", "/v1/crl"));
            match p.azure.refusal(method, path) {
                None => assert!(exempt, "{method} {path} was served"),
                Some((status, body)) => {
                    assert!(!exempt, "{method} {path} was refused");
                    assert_eq!((status, Value::Object(body)), (503, want.clone()), "{method} {path}");
                }
            }
            assert!(p.azure.admit(method, path).is_err() != exempt, "{method} {path}");
            assert!(p.lab.refusal(method, path).is_none(), "the active serves {method} {path}");
            assert!(p.lab.admit(method, path).is_ok());
        }
        for (method, path) in [("GET", "/healthz"), ("GET", "/v1/relays"), ("GET", "/v1/crl")] {
            assert!(p.azure.refusal(method, path).is_none());
        }
        assert_eq!(Value::Object(p.azure.health()), json!({"ok": true, "role": "standby", "epoch": 1, "node": "azure"}));
        // fenced: the same shape, code fenced, no active named until the peer was seen active
        p.lab.persist(Role::Fenced, 1).unwrap();
        p.lab.peer_seen.lock().0 = pj::mono() - 100.0;
        let (status, body) = p.lab.refusal("POST", "/v1/hello").unwrap();
        assert_eq!((status, Value::Object(body)), (503, json!({"ok": false, "code": "fenced", "error": FENCED_WORDS, "active": null})));
        assert!(p.lab.saves_allowed() && !p.azure.saves_allowed());
    }

    /// The blob: one lease (holder, expiry on the fake clock) and the epoch metadata. Each call may take time
    /// (`delay`, added to the clock) or fail (`set_epoch_fails`).
    struct Blob {
        clock: Mutex<f64>,
        lease: Mutex<Option<(String, f64)>>,
        epoch: Mutex<u64>,
        delay: Mutex<f64>,
        set_epoch_fails: AtomicBool,
    }

    /// One node's way to the blob; `down` cuts it off.
    struct FakeWitness {
        blob: Arc<Blob>,
        down: AtomicBool,
    }

    impl FakeWitness {
        fn reach(&self) -> Result<f64, String> {
            let mut c = self.blob.clock.lock();
            *c += *self.blob.delay.lock();
            if self.down.load(Ordering::SeqCst) {
                return Err("unreachable".into());
            }
            Ok(*c)
        }
    }

    impl Witness for FakeWitness {
        fn acquire(&self, id: &str) -> Result<bool, String> {
            let now = self.reach()?;
            let mut l = self.blob.lease.lock();
            if l.as_ref().is_some_and(|(h, exp)| *exp > now && h != id) {
                return Ok(false);
            }
            *l = Some((id.to_string(), now + crate::meet_witness::LEASE_S as f64));
            Ok(true)
        }
        fn renew(&self, id: &str) -> Result<bool, String> {
            let now = self.reach()?;
            let mut l = self.blob.lease.lock();
            match l.as_mut() {
                Some((h, exp)) if h == id && *exp > now => {
                    *exp = now + crate::meet_witness::LEASE_S as f64;
                    Ok(true)
                }
                _ => Ok(false),
            }
        }
        fn release(&self, id: &str) -> Result<(), String> {
            self.reach()?;
            let mut l = self.blob.lease.lock();
            if l.as_ref().is_some_and(|(h, _)| h == id) {
                *l = None;
            }
            Ok(())
        }
        fn read(&self) -> Result<BlobView, String> {
            let now = self.reach()?;
            Ok(BlobView { epoch: *self.blob.epoch.lock(), leased: self.blob.lease.lock().as_ref().is_some_and(|(_, exp)| *exp > now) })
        }
        fn set_epoch(&self, id: &str, epoch: u64) -> Result<(), String> {
            let now = self.reach()?;
            if self.blob.set_epoch_fails.load(Ordering::SeqCst) || !self.blob.lease.lock().as_ref().is_some_and(|(h, exp)| h == id && *exp > now) {
                return Err("412".into());
            }
            *self.blob.epoch.lock() = epoch;
            Ok(())
        }
    }

    /// Both nodes on one fake blob, each reading the blob's clock.
    fn witnessed(p: &Pair) -> (Arc<Blob>, Arc<FakeWitness>, Arc<FakeWitness>) {
        let blob = Arc::new(Blob { clock: Mutex::new(1000.0), lease: Mutex::new(None), epoch: Mutex::new(0), delay: Mutex::new(0.0), set_epoch_fails: AtomicBool::new(false) });
        let (wl, wa) = (Arc::new(FakeWitness { blob: blob.clone(), down: AtomicBool::new(false) }), Arc::new(FakeWitness { blob: blob.clone(), down: AtomicBool::new(false) }));
        for (c, w) in [(&p.lab, wl.clone()), (&p.azure, wa.clone())] {
            c.set_witness(w);
            let b = blob.clone();
            c.set_clock(Box::new(move || *b.clock.lock()));
        }
        (blob, wl, wa)
    }

    fn at(blob: &Blob, t: f64) {
        *blob.clock.lock() = t;
    }

    #[test]
    fn fencing_promotion_and_the_old_active_coming_back() {
        let p = pair();
        let (blob, wl, _wa) = witnessed(&p);
        let t0 = 1000.0;
        put(&p.lab.dir, "state.json", "{\"lab\": 1}");
        put(&p.lab.dir, "files/0123456789abcdef0123456789abcdef", "lab file");
        // the standby holds a complete copy before anything else
        p.azure.pull_once(&local(&p), 0).unwrap();
        put(&p.lab.dir, REPLICA_FILE, "{}");
        // the active takes the lease and writes its epoch
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!((p.lab.role(), *blob.epoch.lock()), (Role::Active, 1));
        // cut off from the witness: active until lease_s without a renewal, then fenced (and saved as fenced)
        wl.down.store(true, Ordering::SeqCst);
        at(&blob, t0 + 10.0);
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        at(&blob, t0 + 20.0);
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!(p.lab.role(), Role::Active);
        at(&blob, t0 + 30.0);
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!(p.lab.role(), Role::Fenced);
        assert_eq!(read_state(&p.lab.dir).unwrap().unwrap().role, Role::Fenced);
        assert!(!p.lab.serving() && p.lab.refusal("POST", "/v1/chat").is_some());
        // the standby: not before promote_after_s of silence, and the lease only after it expired (t0 + 60)
        p.azure.peer_seen.lock().0 = t0 - 60.0;
        at(&blob, t0 + 20.0);
        assert_eq!(p.azure.witness_tick(None), Step::Stay, "silent for 80 s only");
        at(&blob, t0 + 40.0);
        assert_eq!(p.azure.witness_tick(None), Step::Stay, "the lease is still the active's");
        assert_eq!(p.azure.role(), Role::Standby);
        // the peer answering as active keeps the standby where it is
        let lab_health = Value::Object(obj([("ok", Value::Bool(true)), ("role", Value::from("active")), ("epoch", Value::from(1))]));
        at(&blob, t0 + 61.0);
        assert_eq!(p.azure.witness_tick(Some(&lab_health)), Step::Stay);
        assert_eq!(p.azure.role(), Role::Standby);
        p.azure.peer_seen.lock().0 = t0 - 60.0;
        at(&blob, t0 + 62.0);
        assert_eq!(p.azure.witness_tick(None), Step::Exit);
        // the promotion is on disk; the process serves nothing until it restarts as active
        let st = read_state(&p.azure.dir).unwrap().unwrap();
        assert_eq!((st.role, st.epoch, *blob.epoch.lock()), (Role::Active, 2, 2));
        assert_eq!(p.azure.role(), Role::Standby);
        assert!(!p.azure.serving() && p.azure.admit("POST", "/v1/chat").is_err());
        assert!(p.azure.pull_once(&local(&p), 0).unwrap_err().contains("role change"));
        // the old active comes back: the blob's epoch is higher, so it moves its set aside and becomes standby
        wl.down.store(false, Ordering::SeqCst);
        at(&blob, t0 + 100.0);
        assert_eq!(p.lab.witness_tick(None), Step::Exit);
        let st = read_state(&p.lab.dir).unwrap().unwrap();
        assert_eq!((st.role, st.epoch), (Role::Standby, 2));
        let aside = p.lab.dir.join("state.before-epoch-2");
        assert_eq!(read(&aside, "state.json").as_deref(), Some("{\"lab\": 1}"));
        assert_eq!(read(&aside, "files/0123456789abcdef0123456789abcdef").as_deref(), Some("lab file"));
        assert_eq!(read(&p.lab.dir, "state.json"), None);
        assert_eq!(read(&p.lab.dir, REPLICA_FILE), None);
        assert!(!p.lab.serving());
        // without a witness nothing changes by itself
        let q = pair();
        q.azure.peer_seen.lock().0 = -1e9;
        assert_eq!(q.azure.witness_tick(None), Step::Stay);
        assert_eq!(q.lab.witness_tick(None), Step::Stay);
        assert_eq!((q.lab.role(), q.azure.role()), (Role::Active, Role::Standby));
    }

    /// Review 1: a restarting active serves nobody until it renews with its own lease id and the blob holds its epoch.
    #[test]
    fn a_restarting_active_waits_for_the_witness() {
        let p = pair();
        let (blob, wl, _) = witnessed(&p);
        p.lab.hold_until_renewed();
        assert_eq!(p.lab.role(), Role::Fenced);
        assert!(!p.lab.serving());
        assert_eq!(read_state(&p.lab.dir).unwrap().unwrap().role, Role::Active, "only in memory");
        // the witness cannot be reached: still fenced
        wl.down.store(true, Ordering::SeqCst);
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!(p.lab.role(), Role::Fenced);
        wl.down.store(false, Ordering::SeqCst);
        // another node holds the lease (409): still fenced
        *blob.lease.lock() = Some(("someone-else".into(), 1000.0 + 50.0));
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!(p.lab.role(), Role::Fenced);
        // the lease is free and the blob epoch becomes its own: active
        *blob.lease.lock() = None;
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!((p.lab.role(), *blob.epoch.lock()), (Role::Active, 1));
        assert!(p.lab.serving());
        // a node whose epoch the blob passed while it was down steps down without serving
        let q = pair();
        let (blob, _, _) = witnessed(&q);
        *blob.epoch.lock() = 3;
        q.lab.hold_until_renewed();
        assert_eq!(q.lab.witness_tick(None), Step::Exit);
        assert_eq!(read_state(&q.lab.dir).unwrap().unwrap(), NodeState { role: Role::Standby, epoch: 3, since: read_state(&q.lab.dir).unwrap().unwrap().since });
    }

    /// Review 2: a renewal that answers after the deadline fences the node; nothing else is done with it.
    #[test]
    fn a_slow_witness_counts_against_the_deadline() {
        let p = pair();
        let (blob, _, _) = witnessed(&p);
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!(p.lab.role(), Role::Active);
        // each call now takes 20 s: the renewal goes out at t+10 and succeeds, but the read ends past the deadline
        *blob.delay.lock() = 20.0;
        at(&blob, 1000.0 + 25.0);
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!(p.lab.role(), Role::Fenced);
    }

    #[test]
    fn a_fenced_node_returns_to_active_when_it_renews_at_its_own_epoch() {
        let p = pair();
        let (blob, wl, _) = witnessed(&p);
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        wl.down.store(true, Ordering::SeqCst);
        at(&blob, 1000.0 + 35.0);
        p.lab.witness_tick(None);
        assert_eq!(p.lab.role(), Role::Fenced);
        wl.down.store(false, Ordering::SeqCst);
        at(&blob, 1000.0 + 40.0);
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert_eq!((p.lab.role(), read_state(&p.lab.dir).unwrap().unwrap().role), (Role::Active, Role::Active));
    }

    /// Reviews 3 and 4: no automatic promotion without a complete copy; a promotion is written to disk only and the
    /// process stays gated.
    #[test]
    fn promotion_needs_a_copy_and_leaves_the_process_gated() {
        let p = pair();
        let (blob, _, _) = witnessed(&p);
        p.azure.peer_seen.lock().0 = 0.0;
        assert_eq!(p.azure.witness_tick(None), Step::Stay, "no cluster-replica.json yet");
        assert!(blob.lease.lock().is_none(), "it did not even ask for the lease");
        assert!(p.azure.op_promote(false).unwrap_err().contains("no complete copy"));
        p.azure.pull_once(&local(&p), 0).unwrap();
        // the active then falls silent
        p.azure.peer_seen.lock().0 = 0.0;
        assert_eq!(p.azure.witness_tick(None), Step::Exit);
        assert_eq!(read_state(&p.azure.dir).unwrap().unwrap().role, Role::Active);
        assert_eq!(p.azure.role(), Role::Standby);
        assert!(p.azure.refusal("POST", "/v1/chat").is_some() && !p.azure.saves_allowed());
        // a forced operator promotion may go on without a copy
        let q = pair();
        assert_eq!(q.azure.op_promote(true).unwrap()["epoch"].as_u64(), Some(2));
        assert!(!q.azure.serving());
    }

    /// Review 11: the lease is released when the promotion fails before the epoch advanced, and kept (renewed) while
    /// the state file is written again after it advanced.
    #[test]
    fn a_failed_promotion_keeps_or_releases_the_lease() {
        let p = pair();
        let (blob, _, _) = witnessed(&p);
        p.azure.pull_once(&local(&p), 0).unwrap();
        p.azure.peer_seen.lock().0 = 0.0;
        blob.set_epoch_fails.store(true, Ordering::SeqCst);
        assert_eq!(p.azure.witness_tick(None), Step::Stay);
        assert!(blob.lease.lock().is_none(), "released before the epoch advanced");
        assert!(!p.azure.in_transit());
        blob.set_epoch_fails.store(false, Ordering::SeqCst);
        // the state file cannot be written (a folder in its place): the epoch advanced, so the lease stays
        std::fs::remove_file(p.azure.dir.join(STATE_FILE)).unwrap();
        std::fs::create_dir(p.azure.dir.join(STATE_FILE)).unwrap();
        assert_eq!(p.azure.witness_tick(None), Step::Stay);
        assert_eq!(*blob.epoch.lock(), 2);
        let holder = blob.lease.lock().clone().unwrap();
        assert_eq!(holder.0, crate::meet_witness::lease_id(ID, "azure"));
        at(&blob, 1000.0 + 50.0);
        assert_eq!(p.azure.witness_tick(None), Step::Stay);
        assert!(blob.lease.lock().as_ref().unwrap().1 > holder.1, "renewed while the write is retried");
        std::fs::remove_dir(p.azure.dir.join(STATE_FILE)).unwrap();
        assert_eq!(p.azure.witness_tick(None), Step::Exit);
        assert_eq!(read_state(&p.azure.dir).unwrap().unwrap().epoch, 2);
    }

    #[test]
    fn operator_promote_and_demote() {
        let p = pair();
        let (_blob, _wl, _wa) = witnessed(&p);
        p.azure.set_peer(Arc::new(local(&p)));
        p.azure.pull_once(&local(&p), 0).unwrap();
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        assert!(p.azure.op_promote(false).unwrap_err().contains("answers as the active relay"));
        assert!(p.azure.op_promote(true).unwrap_err().contains("lease is still held"));
        assert!(p.lab.op_promote(false).unwrap_err().contains("already the active"));
        let d = p.lab.op_demote().unwrap();
        assert_eq!((d["role"].as_str(), p.lab.role()), (Some("standby"), Role::Standby));
        assert!(p.lab.op_demote().is_err());
        let a = p.azure.op_promote(false).unwrap();
        assert_eq!((a["epoch"].as_u64(), read_state(&p.azure.dir).unwrap().unwrap().role), (Some(2), Role::Active));
    }

    #[test]
    fn a_handover_loses_no_generation() {
        let p = pair();
        let (blob, _wl, _wa) = witnessed(&p);
        let a = p.lab.dir.clone();
        put(&a, "state.json", "{\"n\": 1}");
        assert_eq!(p.lab.witness_tick(None), Step::Stay);
        let peer = local(&p);
        // not while the standby is not copying
        assert!(p.lab.op_handover(Duration::from_secs(1)).unwrap_err().contains("not copying"));
        p.azure.pull_once(&peer, 0).unwrap();
        // the last writes before the handover
        put(&a, "state.json", "{\"n\": 2}");
        put(&a, "emoji/new", "new emoji");
        let lab = p.lab.clone();
        let handing = std::thread::spawn(move || lab.op_handover(Duration::from_secs(20)));
        let mut epoch = None;
        for _ in 0..50 {
            if let PullOutcome::Handover { epoch: e } = p.azure.pull_once(&peer, 1).unwrap() {
                epoch = Some(e);
                break;
            }
        }
        let epoch = epoch.expect("the standby saw the handover");
        let done = handing.join().unwrap().unwrap();
        assert_eq!((done["role"].as_str(), p.lab.role()), (Some("standby"), Role::Standby));
        assert_eq!(p.azure.handover_take(epoch).unwrap(), 2);
        assert_eq!((read_state(&p.azure.dir).unwrap().unwrap().epoch, *blob.epoch.lock()), (2, 2));
        // every file of the last generation is on the new active
        assert_eq!(done["generation"].as_u64(), p.azure.pulled.lock().map(|x| x.generation));
        assert_eq!(read(&p.azure.dir, "state.json").as_deref(), Some("{\"n\": 2}"));
        assert_eq!(read(&p.azure.dir, "emoji/new").as_deref(), Some("new emoji"));
        // the old active did not move its state aside
        assert_eq!(read(&a, "state.json").as_deref(), Some("{\"n\": 2}"));
    }

    /// Review 6: a handover waits for the writes admitted before it, and admits none after.
    #[test]
    fn a_handover_drains_admitted_writers() {
        let p = pair();
        let peer = local(&p);
        p.azure.pull_once(&peer, 0).unwrap();
        let writer = p.lab.admit("POST", "/v1/chat").unwrap().expect("a write is counted");
        assert!(p.lab.admit("GET", "/v1/inbox").unwrap().is_none(), "reads are not counted");
        let lab = p.lab.clone();
        let handing = std::thread::spawn(move || lab.op_handover(Duration::from_secs(20)));
        while p.lab.repl.lock().handover == Handover::Idle {
            std::thread::sleep(Duration::from_millis(10));
        }
        // draining: nobody new is admitted, and the standby is not told yet
        assert!(p.lab.admit("POST", "/v1/chat").is_err());
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(p.lab.repl.lock().handover, Handover::Draining);
        // the admitted writer's last write, then it finishes
        put(&p.lab.dir, "state.json", "{\"last\": true}");
        drop(writer);
        let mut handed = false;
        for _ in 0..50 {
            if let PullOutcome::Handover { .. } = p.azure.pull_once(&peer, 1).unwrap() {
                handed = true;
                break;
            }
        }
        assert!(handed);
        handing.join().unwrap().unwrap();
        assert_eq!(read(&p.azure.dir, "state.json").as_deref(), Some("{\"last\": true}"));
        // writers that never finish: the handover gives up and the node stays active
        let q = pair();
        q.azure.pull_once(&local(&q), 0).unwrap();
        let _stuck = q.lab.admit("POST", "/v1/chat").unwrap();
        assert!(q.lab.op_handover(Duration::from_millis(300)).unwrap_err().contains("still writing"));
        assert!(q.lab.serving());
    }

    #[test]
    fn a_handover_the_standby_does_not_follow_changes_nothing() {
        let p = pair();
        p.azure.pull_once(&local(&p), 0).unwrap();
        assert!(p.lab.op_handover(Duration::from_millis(300)).unwrap_err().contains("stays active"));
        assert!(p.lab.serving());
    }

    /// The active, whose file answers wait for a signal (a pull caught in the middle).
    struct Slow {
        inner: Local,
        entered: std::sync::mpsc::Sender<()>,
        go: Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl Peer for Slow {
        fn replica(&self, have: u64, wait: u64) -> Result<Value, String> {
            self.inner.replica(have, wait)
        }
        fn file(&self, path: &str, sha256: &str, size: u64, out: &mut dyn Write) -> Result<bool, String> {
            let _ = self.entered.send(());
            let _ = self.go.lock().recv();
            self.inner.file(path, sha256, size, out)
        }
        fn health(&self) -> Result<Value, String> {
            self.inner.health()
        }
    }

    /// Review 5: a role change waits for a pull's apply, and no pull applies once a role change is under way.
    #[test]
    fn a_role_change_and_a_pull_never_overlap() {
        let p = pair();
        put(&p.lab.dir, "state.json", "{\"n\": 1}");
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let (go, go_rx) = std::sync::mpsc::channel();
        let slow = Slow { inner: local(&p), entered: entered_tx, go: Mutex::new(go_rx) };
        let azure = p.azure.clone();
        let pulling = std::thread::spawn(move || azure.pull_once(&slow, 0));
        entered.recv().unwrap();
        // the pull is inside its apply: a promotion waits for it
        let azure = p.azure.clone();
        let done = Arc::new(AtomicU64::new(0));
        let flag = done.clone();
        let promoting = std::thread::spawn(move || {
            let r = azure.op_promote(true);
            flag.store(1, Ordering::SeqCst);
            r
        });
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(done.load(Ordering::SeqCst), 0, "the promotion waited for the apply");
        assert_eq!(read_state(&p.azure.dir).unwrap().unwrap().role, Role::Standby);
        go.send(()).unwrap();
        assert!(pulling.join().unwrap().is_ok());
        assert!(promoting.join().unwrap().is_ok());
        assert_eq!(read(&p.azure.dir, "state.json").as_deref(), Some("{\"n\": 1}"));
        // from here on nothing is pulled
        assert!(p.azure.pull_once(&local(&p), 0).unwrap_err().contains("role change"));
    }

    /// A peer that lists and sends what the test says.
    struct Crafted {
        manifest: Value,
        body: Vec<u8>,
    }

    impl Peer for Crafted {
        fn replica(&self, _have: u64, _wait: u64) -> Result<Value, String> {
            Ok(self.manifest.clone())
        }
        fn file(&self, _path: &str, _sha256: &str, _size: u64, out: &mut dyn Write) -> Result<bool, String> {
            out.write_all(&self.body).map_err(|e| e.to_string())?;
            Ok(true)
        }
        fn health(&self) -> Result<Value, String> {
            Ok(json!({"ok": true}))
        }
    }

    /// Review 9: the standby takes bounded answers only: entries, declared sizes, and files no longer than declared.
    #[test]
    fn peer_answers_are_bounded() {
        let p = pair();
        let manifest = |files: Value| json!({"ok": true, "cluster": ID, "node": "lab", "epoch": 1, "generation": 7, "files": files});
        let body = b"twelve bytes".to_vec();
        let sha = crate::codec::sha256_hex(&body);
        let pull = |m: Value, b: &[u8]| p.azure.pull_once(&Crafted { manifest: m, body: b.to_vec() }, 0);
        // declared 5 bytes, 12 arrive: refused while it arrives, nothing written
        let e = pull(manifest(json!([{"path": "state.json", "size": 5, "sha256": sha}])), &body).unwrap_err();
        assert!(e.contains("longer than its declared size") || e.contains("damaged"), "{e}");
        assert!(!p.azure.dir.join("state.json").exists() && !p.azure.dir.join(".state.json.pull").exists());
        // declared too large, too many entries, the same path twice
        assert!(pull(manifest(json!([{"path": "files/a", "size": FILE_MAX + 1, "sha256": sha}])), &body).unwrap_err().contains("larger than this node takes"));
        assert!(pull(manifest(json!([{"path": "relays.json", "size": RELAYS_MAX + 1, "sha256": sha}])), &body).unwrap_err().contains("larger"));
        let many: Vec<Value> = (0..=ENTRIES_MAX).map(|i| json!({"path": format!("files/f{i}"), "size": 1, "sha256": sha})).collect();
        assert!(pull(manifest(Value::Array(many)), &body).unwrap_err().contains("more than"));
        let twice = json!([{"path": "state.json", "size": 12, "sha256": sha}, {"path": "state.json", "size": 12, "sha256": sha}]);
        assert!(pull(manifest(twice), &body).is_err());
        // the honest answer is taken
        assert!(pull(manifest(json!([{"path": "state.json", "size": 12, "sha256": sha}])), &body).is_ok());
        assert_eq!(read(&p.azure.dir, "state.json").as_deref(), Some("twelve bytes"));
    }

    /// Review 8: links are no part of the replica tree: not listed, not served, written over never through.
    #[test]
    fn links_in_the_replica_tree_are_never_followed() {
        let p = pair();
        let outside = dir("cluster-outside");
        std::fs::write(outside.join("secret"), "outside").unwrap();
        put(&p.lab.dir, "files/0123456789abcdef0123456789abcdef", "real");
        // Unix always lets the test make links: it never skips there
        #[cfg(unix)]
        let linked = {
            std::os::unix::fs::symlink(outside.join("secret"), p.lab.dir.join("files/evil")).unwrap();
            std::os::unix::fs::symlink(&outside, p.lab.dir.join("emoji")).unwrap();
            true
        };
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(outside.join("secret"), p.lab.dir.join("files/evil")).is_ok() && std::os::windows::fs::symlink_dir(&outside, p.lab.dir.join("emoji")).is_ok();
        if !linked {
            // this host does not let the test make links (Windows without the privilege)
            return;
        }
        let listed: Vec<String> = listing(&p.lab.dir).into_iter().map(|e| e.path).collect();
        assert_eq!(listed, vec!["files/0123456789abcdef0123456789abcdef".to_string()]);
        let sha = crate::codec::sha256_hex(b"outside");
        for path in ["files/evil", "emoji/secret"] {
            assert!(matches!(p.lab.route("GET", "/v1/cluster/file", &q(&[("path", path.into()), ("sha256", sha.clone())]), Some(&p.azure_der)), Some(Answer::Json(409 | 404, _))), "{path}");
        }
        // on the standby a link where a set file goes is replaced, its target untouched
        put(&p.lab.dir, "files/fedcba9876543210fedcba9876543210", "from the active");
        std::fs::create_dir_all(p.azure.dir.join("files")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret"), p.azure.dir.join("files/fedcba9876543210fedcba9876543210")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(outside.join("secret"), p.azure.dir.join("files/fedcba9876543210fedcba9876543210")).unwrap();
        p.azure.pull_once(&local(&p), 0).unwrap();
        assert_eq!(read(&outside, "secret").as_deref(), Some("outside"));
        let m = std::fs::symlink_metadata(p.azure.dir.join("files/fedcba9876543210fedcba9876543210")).unwrap();
        assert!(m.file_type().is_file());
        assert_eq!(read(&p.azure.dir, "files/fedcba9876543210fedcba9876543210").as_deref(), Some("from the active"));
    }

    /// A missing client pair stops nothing: the standby reports it (status `pullError`) and picks the pair up once it
    /// is there; an active node never needs it.
    #[test]
    fn a_missing_client_pair_is_reported_and_retried() {
        let p = pair();
        let d = dir("cluster-pair");
        let mut cfg = p.azure.cfg.clone();
        cfg.client_cert = d.join("relay-client.crt").display().to_string();
        cfg.client_key = d.join("relay-client.key").display().to_string();
        cfg.peer.address = "127.0.0.1".into();
        cfg.peer.port = 9;
        let ca = Ca::new("Lucid Meet CA");
        std::fs::write(d.join("ca.crt"), ca.pem()).unwrap();
        let s = Settings { client_ca: d.join("ca.crt").display().to_string(), ..Settings::default() };
        let peer = HttpsPeer::new(&s, &cfg);
        let e = p.azure.pull_reported(&peer, 0).unwrap_err();
        assert!(e.contains("the cluster client certificate does not load"), "{e}");
        assert_eq!(p.azure.status()["pullError"].as_str(), Some(e.as_str()));
        assert!(p.lab.status()["pullError"].is_null());
        // an unforced promotion cannot ask the peer without the pair
        p.azure.set_peer(Arc::new(HttpsPeer::new(&s, &cfg)));
        p.azure.pull_once(&local(&p), 0).unwrap();
        assert!(p.azure.op_promote(false).unwrap_err().contains("cannot be asked"));
        // the pair arrives: the next pull gets past it (to the peer, which is not listening here)
        let key = Key::new();
        std::fs::write(&cfg.client_cert, crate::meet_x509::der_to_pem(&ca.leaf(&[0x61], "Lucid Meet Relay", None, &[crate::meet::RELAY_URI], &key, true))).unwrap();
        std::fs::write(&cfg.client_key, key.key_pem()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cfg.client_key, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let e = p.azure.pull_reported(&peer, 0).unwrap_err();
        assert!(e.contains("did not answer"), "{e}");
        assert_eq!(p.azure.status()["pullError"].as_str(), Some(e.as_str()));
        // a pull that works clears it
        p.azure.pull_reported(&local(&p), 0).unwrap();
        assert!(p.azure.status()["pullError"].is_null());
    }

    #[test]
    fn the_cli_works_on_a_stopped_relay() {
        let p = pair();
        let s = Settings { state_dir: p.azure.dir.display().to_string(), ..Settings::default() };
        let cfg = p.azure.cfg.clone();
        let dir = p.azure.dir.clone();
        drop(p);
        let mut out = Vec::new();
        assert_eq!(run_cli(&s, &cfg, &dir, "status", false, false, &mut out), 0);
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!((v["role"].as_str(), v["running"].as_bool(), v["node"].as_str()), (Some("standby"), Some(false), Some("azure")));
        assert_eq!(run_cli(&s, &cfg, &dir, "demote", false, false, &mut Vec::new()), 2, "--yes is required");
        assert_eq!(run_cli(&s, &cfg, &dir, "handover", false, true, &mut Vec::new()), 1);
        // no copy and no client certificate here: only a forced promotion goes on
        assert_eq!(run_cli(&s, &cfg, &dir, "promote", false, true, &mut Vec::new()), 1);
        let mut out = Vec::new();
        assert_eq!(run_cli(&s, &cfg, &dir, "promote", true, true, &mut out), 0);
        let st = read_state(&dir).unwrap().unwrap();
        assert_eq!((st.role, st.epoch), (Role::Active, 2));
        assert_eq!(run_cli(&s, &cfg, &dir, "demote", false, true, &mut Vec::new()), 0);
        assert_eq!(read_state(&dir).unwrap().unwrap().role, Role::Standby);
    }
}
