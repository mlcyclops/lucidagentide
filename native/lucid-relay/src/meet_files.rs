// Phase C (ADR-0540), wave 3: files kept in conversations (meet_relay._Wave3Files): direct messages, group chats,
// channels and call rooms. Bytes in state_dir/files/<id> (mode 0600; the id is 32 hex, so a path never leaves the
// folder), metadata in ext["files"]. A file lives as long as its message: the message's retention (rooms
// history_hours, DMs mail_days, channels and groups channel_days), its deletion, or the uploader's or an admin's
// /v1/files/delete end it. Parts arrive raw (POST /v1/files/chunk, at most FILES_PART each) and are written outside
// the lock while the upload is busy; a download streams from a file opened under the lock (meet::RawFile). A child
// module of meet_hub: it shares the one lock.

use super::*;
use aws_lc_rs::digest;
use std::fs;
use std::io::{Seek, SeekFrom};

/// One raw part of an upload (POST /v1/files/chunk).
pub const FILES_PART: usize = 1024 * 1024;
/// An unfinished upload with no part for this long is dropped.
const UPLOAD_TTL: f64 = 3600.0;
const NAME_MAX: usize = 200;
/// Unfinished uploads one person may hold at once.
const UPLOADS_MAX: usize = 8;
/// Files one /v1/files/list answers.
const LIST_MAX: usize = 500;
const MB: u64 = 1024 * 1024;
const PUBLIC: [&str; 9] = ["id", "name", "size", "type", "sha256", "from", "from_name", "ts", "scope"];
const GONE: &str = "that file is no longer kept";
const NO_UPLOAD: &str = "that upload is no longer open; send the file again";
const FULL: &str = "the relay is out of space for files";
const CALLER: &str = "a file request needs your session (session or peer)";
const NOT_YOURS: &str = "only the person who shared a file or an admin can delete it";
const BUSY: &str = "another part of this file is still arriving";
const NOT_MINE: &str = "that upload belongs to someone else";

/// FILES_ID_RE: 32 lower-case hex (a file's id, and the only name its bytes ever have).
fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn hex(data: &[u8]) -> String {
    crate::codec::hex(data)
}

/// _files_name: the name a file is shown with: basenamed (either slash), printable, 1 to NAME_MAX characters. Only
/// ever metadata: the bytes are stored under the file's id.
fn file_name(v: Body) -> R<String> {
    let error = || bad(format!("a file name is 1 to {NAME_MAX} characters"));
    let Some(Value::String(name)) = v else { return error() };
    let base = name.replace('\\', "/");
    let base = base.rsplit('/').next().unwrap_or_default();
    let base: String = base.chars().filter(|c| pj::printable(c.encode_utf8(&mut [0u8; 4]))).collect();
    let base = base.trim();
    if base == "." || base == ".." || !(1..=NAME_MAX).contains(&pj::char_len(base)) {
        return error();
    }
    Ok(base.to_string())
}

/// _files_type: a media type (`image/png`); anything else is `application/octet-stream`.
fn file_type(v: Body) -> String {
    let found = pj::str_or(v).split(';').next().unwrap_or_default().trim().to_lowercase();
    let part = |p: &str| {
        let b = p.as_bytes();
        (1..=64).contains(&b.len()) && b[0].is_ascii_alphanumeric() && b[1..].iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"!#$&^_.+-".contains(&c))
    };
    match found.split_once('/') {
        Some((a, b)) if part(a) && part(b) && !found.bytes().any(|c| c.is_ascii_uppercase()) => found,
        _ => "application/octet-stream".into(),
    }
}

/// _files_size: the file's size in bytes.
fn file_size(v: Body) -> R<u64> {
    match pj::as_int(v) {
        Some(n) if n >= 0 => Ok(n as u64),
        _ => bad("size must be the file's size in bytes"),
    }
}

fn bad_number(v: Option<&Value>) -> bool {
    pj::as_num(v).map(|x| x < 0.0).unwrap_or(true)
}

/// _files_stored: a kept file's metadata as state.json holds it, checked at load.
fn stored(fid: &str, meta: &Value) -> bool {
    let Some(meta) = meta.as_object() else { return false };
    let scope = pj::text_of(meta, "scope");
    if !is_id(fid) || meta.get("id").and_then(Value::as_str) != Some(fid) || !["dm", "channel", "room"].contains(&scope.as_str()) {
        return false;
    }
    if !["name", "type", "sha256", "from", "from_name", "message"].iter().all(|k| meta.get(*k).map(Value::is_string).unwrap_or(false)) {
        return false;
    }
    if bad_number(meta.get("size")) || bad_number(meta.get("ts")) {
        return false;
    }
    if scope == "dm" {
        let pair_ok = meta.get("pair").and_then(Value::as_array).map(|p| p.len() == 2 && p.iter().all(Value::is_string)).unwrap_or(false);
        return pair_ok && meta.get("with").map(Value::is_string).unwrap_or(false);
    }
    meta.get(&scope).map(Value::is_string).unwrap_or(false)
}

/// A kept file's size (int(meta["size"])).
fn size_of(meta: &Obj) -> u64 {
    pj::num(meta, "size").max(0.0) as u64
}

/// `" ".join(meta["pair"])`: the key of a DM file's conversation.
fn pair_key(meta: &Obj) -> String {
    meta.get("pair").and_then(Value::as_array).map(|p| p.iter().map(pj::py_str).collect::<Vec<_>>().join(" ")).unwrap_or_default()
}

/// An unfinished upload (its id is the file's id).
struct Upload {
    principal: String,
    name: String,
    size: u64,
    kind: String,
    /// The conversation it goes to: {scope, room} | {scope, with, pair} | {scope, channel}.
    place: Obj,
    peer: String,
    received: u64,
    /// SHA-256 of the bytes so far; out of the upload while a part is written.
    sha: Option<digest::Context>,
    busy: bool,
    expires: f64,
}

/// In memory: the unfinished uploads, the limits (relay.json file_max_mb, files_quota_gb) and the folder of the bytes.
pub struct Files {
    uploads: IndexMap<String, Upload>,
    max: u64,
    quota: u64,
    /// state_dir/files; None: a relay without a state_dir keeps bytes in a temp folder (`tmp`, made on first use).
    dir: Option<PathBuf>,
    tmp: Option<PathBuf>,
    checked: bool,
}

impl Files {
    pub(super) fn new(dir: Option<PathBuf>) -> Files {
        Files { uploads: IndexMap::new(), max: 100 * MB, quota: 20 * 1024 * MB, dir, tmp: None, checked: false }
    }

    /// _files_configure: relay.json `file_max_mb` and `files_quota_gb` (checked when relay.json was read).
    pub(super) fn configure(&mut self, file_max_mb: i64, files_quota_gb: f64) {
        self.max = file_max_mb.max(1) as u64 * MB;
        self.quota = (files_quota_gb * (1024.0 * 1024.0 * 1024.0)) as u64;
    }

    /// _files_folder: made (0700) when missing.
    fn folder(&mut self) -> std::io::Result<PathBuf> {
        let folder = match (&self.dir, &self.tmp) {
            (Some(d), _) => d.clone(),
            (None, Some(t)) => t.clone(),
            (None, None) => {
                let t = std::env::temp_dir().join(format!("lucid-relay-files-{}", pj::token_hex(8)));
                self.tmp = Some(t.clone());
                t
            }
        };
        let mut b = fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(&folder)?;
        Ok(folder)
    }

    /// _files_path: where a file's bytes are: only ever `<folder>/<32 hex>[.part]` (callers pass checked ids).
    fn path(&mut self, fid: &str, part: bool) -> std::io::Result<PathBuf> {
        debug_assert!(is_id(fid));
        Ok(self.folder()?.join(if part { format!("{fid}.part") } else { fid.to_string() }))
    }

    /// _files_unlink: a failed removal (open elsewhere) is retried by the prune, which drops bytes nothing names.
    fn unlink(&mut self, fid: &str, part: bool) {
        if let Ok(p) = self.path(fid, part) {
            let _ = fs::remove_file(p);
        }
    }

    fn drop_upload(&mut self, uid: &str) {
        if self.uploads.shift_remove(uid).is_some() {
            self.unlink(uid, true);
        }
    }

    /// _files_expire: an unfinished upload with no part for UPLOAD_TTL goes (not while a part arrives).
    fn expire(&mut self, now: f64) {
        let old: Vec<(String, String)> = self.uploads.iter().filter(|(_, u)| u.expires <= now && !u.busy).map(|(k, u)| (k.clone(), u.principal.clone())).collect();
        for (uid, principal) in old {
            self.drop_upload(&uid);
            log_info(&format!("files_expired upload={uid} principal={principal}"));
        }
    }

    fn open_upload(&mut self, uid: &str, who: &Identity) -> R<&mut Upload> {
        let up = if is_id(uid) { self.uploads.get_mut(uid) } else { None };
        let Some(up) = up else { return Err(E::NotFound(NO_UPLOAD.into())) };
        if up.principal != who.principal {
            return forbidden(NOT_MINE);
        }
        if up.busy {
            return Err(E::Conflict(BUSY.into()));
        }
        Ok(up)
    }
}

/// One part on its way to the disk (files_chunk_begin to files_chunk_write): the upload is busy meanwhile, so nobody
/// else touches its bytes or its hash.
pub struct FilePart {
    id: String,
    path: PathBuf,
    offset: u64,
    sha: digest::Context,
}

/// A file's message, checked and built before anything is stored (`deliver` sends it).
enum Message {
    Room { room: String, line: Obj },
    Channel { cid: String, msg: Obj, session: String, thread: bool },
    Dm { to: String, msg: Obj, session: Option<String>, thread: bool },
}

impl State {
    /// _files_store: ext["files"]["files"]: file id -> kept file (checked the first time).
    fn files_store(&mut self) -> &mut Obj {
        let sound = matches!(self.ext.get("files"), Some(Value::Object(p)) if p.get("files").map(Value::is_object).unwrap_or(false));
        if !self.files.checked || !sound {
            self.files.checked = true;
            let raw = as_obj(self.ext.get("files")).and_then(|p| as_obj(p.get("files"))).cloned().unwrap_or_default();
            let mut kept = Obj::new();
            for (fid, meta) in raw {
                if stored(&fid, &meta) {
                    kept.insert(fid, meta);
                } else {
                    log_warn(&format!("state file: file {} unreadable; ignored", kv(&fid)));
                }
            }
            self.ext.insert("files".into(), Value::Object(obj([("v", Value::from(1)), ("files", Value::Object(kept))])));
        }
        self.ext.get_mut("files").and_then(Value::as_object_mut).and_then(|p| p.get_mut("files")).and_then(Value::as_object_mut).expect("the files store")
    }

    fn files_meta(&mut self, fid: &str) -> Option<Obj> {
        self.files_store().get(fid).and_then(Value::as_object).cloned()
    }

    /// _files_used: bytes kept plus bytes promised to unfinished uploads.
    fn files_used(&mut self) -> u64 {
        let kept: u64 = self.files_store().values().filter_map(Value::as_object).map(size_of).sum();
        kept + self.files.uploads.values().map(|u| u.size).sum::<u64>()
    }

    /// _files_caller: the caller's live presence session (None) or admitted room seat (its id).
    fn files_caller(&self, who: &Identity, peer: Option<&str>, session: Option<&str>) -> R<Option<String>> {
        if let Some(s) = session {
            self.session(s, who)?;
            return Ok(None);
        }
        if let Some(p) = peer {
            self.owned(p, who)?;
            if self.peers[p].admission_pending {
                return forbidden(ADMISSION_FIRST);
            }
            return Ok(Some(p.to_string()));
        }
        bad(CALLER)
    }

    /// _files_where: the conversation a new file goes to, checked like a message to it.
    fn files_where(&self, who: &Identity, scope: &str, peer: Option<&str>, session: Option<&str>, with_: Option<&str>, channel: Option<&str>) -> R<Obj> {
        Ok(match Hub::conversation(self, who, scope, peer, session, with_, channel, true)? {
            Conv::Room { room, .. } => obj([("scope", Value::from("room")), ("room", Value::from(room))]),
            Conv::Dm(other) => {
                if !self.directory.contains_key(&other) {
                    return Err(E::NotFound("nobody with that address has used this relay yet".into()));
                }
                let mut pair = [who.principal.clone(), other.clone()];
                pair.sort();
                obj([("scope", Value::from("dm")), ("with", Value::from(other)), ("pair", Value::Array(pair.into_iter().map(Value::from).collect()))])
            }
            Conv::Channel(cid) => obj([("scope", Value::from("channel")), ("channel", Value::from(cid))]),
        })
    }

    /// _files_message: the message a kept file belongs to (None when it is no longer kept).
    fn files_message(&mut self, meta: &Obj) -> Option<&mut Obj> {
        let mid = meta.get("message")?.clone();
        let scope = pj::text_of(meta, "scope");
        let list = match scope.as_str() {
            "dm" => self.dms.get_mut(&pair_key(meta))?,
            "channel" => self.channel_msgs.get_mut(&pj::text_of(meta, "channel"))?,
            _ => self.rooms.get_mut(&pj::text_of(meta, "room"))?,
        };
        list.iter_mut().find(|m| (scope != "room" || pj::text_of(m, "kind") == "chat") && m.get("id") == Some(&mid))
    }

    /// _files_alive: true while the file's message is kept, not deleted and still names it, and the conversation's
    /// retention has not passed; otherwise the file goes now.
    fn files_alive(&mut self, fid: &str, meta: &Obj, now: f64) -> bool {
        let keep = match pj::text_of(meta, "scope").as_str() {
            "room" => self.history_s,
            "dm" => self.mail_s,
            _ => self.channel_s,
        };
        let fresh = pj::num(meta, "ts") >= now - keep;
        let named = |msg: &Obj| msg.get("files").and_then(Value::as_array).map(|l| l.iter().any(|f| f.get("id").and_then(Value::as_str) == Some(fid))).unwrap_or(false);
        let alive = fresh && self.files_message(meta).map(|msg| !pj::truthy(msg.get("deleted")) && named(&*msg)).unwrap_or(false);
        if !alive {
            self.files_purge(fid, None);
        }
        alive
    }

    /// _files_live: a kept file (404 when it is not).
    fn files_live(&mut self, fid: &str) -> R<Obj> {
        let meta = if is_id(fid) { self.files_meta(fid) } else { None };
        match meta {
            Some(meta) if self.files_alive(fid, &meta, pj::now()) => Ok(meta),
            _ => Err(E::NotFound(GONE.into())),
        }
    }

    /// _files_member: members only: the two people of a DM, the members of a channel or group, and the people in the
    /// call (now, or while the file was shared). Others hear 404.
    fn files_member(&self, who: &Identity, meta: &Obj) -> R<()> {
        match pj::text_of(meta, "scope").as_str() {
            "dm" => {
                let pair = meta.get("pair").and_then(Value::as_array);
                if !pair.map(|p| p.iter().any(|x| x.as_str() == Some(who.principal.as_str()))).unwrap_or(false) {
                    return Err(E::NotFound(GONE.into()));
                }
            }
            "channel" => {
                self.member_channel(&pj::text_of(meta, "channel"), &who.principal, false)?;
            }
            _ => {
                if !self.files_in_room(who, &pj::text_of(meta, "room"), Some(pj::num(meta, "ts"))) {
                    return Err(E::NotFound(GONE.into()));
                }
            }
        }
        Ok(())
    }

    /// _files_in_room: in `room` now, or (`ts` given) there at that time.
    fn files_in_room(&self, who: &Identity, room: &str, ts: Option<f64>) -> bool {
        if self.peers.values().any(|p| p.room == room && p.who.principal == who.principal && !p.admission_pending) {
            return true;
        }
        let Some(ts) = ts else { return false };
        if !as_obj(self.left.get(&who.principal)).map(|o| o.contains_key(room)).unwrap_or(false) {
            return false;
        }
        Hub::windows(self, room, &who.principal).iter().any(|(a, b)| *a <= ts && ts <= *b)
    }

    /// _files_view: a file as clients see it; a DM's `with` is the other person for `reader`.
    fn files_view(meta: &Obj, reader: &str) -> Obj {
        let mut out: Obj = PUBLIC.iter().map(|k| (k.to_string(), meta.get(*k).cloned().unwrap_or(Value::Null))).collect();
        let scope = pj::text_of(meta, "scope");
        if scope == "dm" {
            let pair: Vec<String> = meta.get("pair").and_then(Value::as_array).into_iter().flatten().map(pj::py_str).collect();
            let other = match pair.iter().position(|p| p == reader) {
                Some(0) => Value::from(pair[1].clone()),
                Some(_) => Value::from(pair[0].clone()),
                None => meta.get("with").cloned().unwrap_or(Value::Null),
            };
            out.insert("with".into(), other);
        } else {
            out.insert(scope.clone(), meta.get(&scope).cloned().unwrap_or(Value::Null));
        }
        out
    }

    /// _files_tell: one event to everyone in the file's conversation (as tell_conversation).
    fn files_tell(&mut self, meta: &Obj, event: &Obj) {
        match pj::text_of(meta, "scope").as_str() {
            "room" => {
                let room = pj::text_of(meta, "room");
                self.broadcast(&room, &with(event, obj([("room", Value::from(room.clone()))])), None);
            }
            "channel" => {
                let cid = pj::text_of(meta, "channel");
                if let Some(ch) = self.channel(&cid) {
                    let members = channels::members_of(Some(ch));
                    let id = ch.get("id").cloned().unwrap_or(Value::Null);
                    self.tell(&members, &with(event, obj([("channel", id)])), None);
                }
            }
            _ => {
                let pair: Vec<String> = meta.get("pair").and_then(Value::as_array).into_iter().flatten().map(pj::py_str).collect();
                let (a, b) = (pair.first().cloned().unwrap_or_default(), pair.get(1).cloned().unwrap_or_default());
                for s in self.sessions.values_mut() {
                    if s.who.principal == a || s.who.principal == b {
                        let other = if s.who.principal == a { &b } else { &a };
                        push(&mut s.seq, &mut s.events, &with(event, obj([("with", Value::from(other.clone()))])));
                    }
                }
            }
        }
    }

    /// _files_purge: forget a file: its bytes, its metadata, and its entry in its message's `files`. With `by` (a
    /// delete) everyone in the conversation hears a `chat_update`.
    fn files_purge(&mut self, fid: &str, by: Option<&Identity>) {
        let meta = self.files_store().shift_remove(fid);
        self.files.unlink(fid, false);
        let Some(Value::Object(meta)) = meta else { return };
        self.dirty = true;
        let Some(msg) = self.files_message(&meta) else { return };
        let Some(Value::Array(files)) = msg.get_mut("files") else { return };
        files.retain(|f| f.get("id").and_then(Value::as_str) != Some(fid));
        let files = files.clone();
        let Some(by) = by.filter(|_| !pj::truthy(msg.get("deleted"))) else { return };
        let mid = msg.get("id").cloned().unwrap_or(Value::Null);
        let event = obj([
            ("type", Value::from("chat_update")),
            ("scope", meta.get("scope").cloned().unwrap_or(Value::Null)),
            ("id", mid.clone()),
            ("text", Value::from(pj::s(msg, "text"))),
            ("files", Value::Array(files)),
            ("by", Value::from(by.principal.clone())),
        ]);
        if pj::text_of(&meta, "scope") == "room" {
            let room = pj::text_of(&meta, "room");
            let mut line: Obj = event.iter().filter(|(k, _)| k.as_str() != "type").map(|(k, v)| (k.clone(), v.clone())).collect();
            line.insert("id".into(), Value::from(pj::token_hex(6)));
            line.insert("kind".into(), Value::from("chat_update"));
            line.insert("target".into(), mid);
            line.insert("room".into(), Value::from(room.clone()));
            line.insert("name".into(), Value::from(by.name.clone()));
            line.insert("ts".into(), f(pj::now()));
            self.room_log(&room, &mut line);
        }
        self.files_tell(&meta, &event);
    }

    /// _files_left: a seat left: its unfinished uploads to the call go (nobody can finish them).
    pub(super) fn files_left(&mut self, peer: &Peer) {
        let mine: Vec<String> = self.files.uploads.iter().filter(|(_, u)| u.peer == peer.peer_id && pj::text_of(&u.place, "scope") == "room").map(|(k, _)| k.clone()).collect();
        for uid in mine {
            self.files.drop_upload(&uid);
        }
    }

    /// _files_prune: retention, deleted or trimmed messages, expired uploads, and bytes on disk that nothing names (a
    /// crash between steps).
    pub(super) fn files_prune(&mut self, now: f64) {
        let kept: Vec<(String, Obj)> = self.files_store().iter().filter_map(|(k, v)| v.as_object().map(|m| (k.clone(), m.clone()))).collect();
        for (fid, meta) in kept {
            self.files_alive(&fid, &meta, now);
        }
        self.files.expire(now);
        if self.files.dir.is_none() && self.files.tmp.is_none() {
            return; // an in-memory relay that never kept a file
        }
        let listed = self.files.folder().and_then(fs::read_dir);
        let names = match listed {
            Ok(n) => n,
            Err(e) => {
                log_warn(&format!("files folder unreadable: {e}"));
                return;
            }
        };
        for entry in names.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (fid, ext) = match name.split_once('.') {
                Some((a, b)) => (a, Some(b)),
                None => (name.as_str(), None),
            };
            if !is_id(fid) || ext.map(|e| e != "part").unwrap_or(false) {
                continue;
            }
            let stale = match ext {
                Some(_) => !self.files.uploads.contains_key(fid),
                None => !self.files_store().contains_key(fid),
            };
            if stale {
                self.files.unlink(fid, ext.is_some());
            }
        }
    }

    /// Check and build the message a finished file becomes (_files_room_message, _files_channel_message,
    /// _files_dm_message); nothing is stored yet. `file` gets its `ts` and its conversation.
    #[allow(clippy::too_many_arguments)]
    fn files_build(&mut self, who: &Identity, place: &Obj, seat: Option<String>, session: Option<String>, file: &mut Obj, text: &str, reply_to: Option<String>, thread: Option<String>) -> R<Message> {
        let now = pj::now();
        match pj::text_of(place, "scope").as_str() {
            "room" => {
                if thread.is_some() {
                    return bad("a file in a call has no thread");
                }
                let room = pj::text_of(place, "room");
                let Some(seat) = seat.filter(|s| self.peers.get(s).map(|p| p.room == room).unwrap_or(false)) else {
                    return forbidden("you are not in the call this file was for");
                };
                let mut line = obj([
                    ("type", Value::from("chat")),
                    ("kind", Value::from("chat")),
                    ("id", Value::from(pj::token_hex(6))),
                    ("from", Value::from(seat)),
                    ("name", Value::from(who.name.clone())),
                    ("principal", Value::from(who.principal.clone())),
                    ("org", self.org(&who.principal)),
                    ("text", Value::from(text)),
                    ("ts", f(now)),
                    ("reactions", Value::Object(Obj::new())),
                ]);
                if let Some(id) = &reply_to {
                    let target = Hub::room_line(self, &room, id)?;
                    let quoted = preview(target, target.get("name"))?;
                    line.insert("reply_to".into(), Value::Object(quoted));
                }
                file.insert("ts".into(), f(now));
                file.insert("room".into(), Value::from(room.clone()));
                line.insert("files".into(), Value::Array(vec![Value::Object(file.clone())]));
                Ok(Message::Room { room, line })
            }
            "channel" => {
                let Some(session) = session else { return bad("a channel message needs your session") };
                let cid = self.member_channel(&pj::text_of(place, "channel"), &who.principal, true)?;
                self.session(&session, who)?;
                let now = now.max(self.last_ts(&cid) + 1e-6);
                let mut msg = obj([
                    ("id", Value::from(pj::token_hex(8))),
                    ("channel", Value::from(cid.clone())),
                    ("from", Value::from(who.principal.clone())),
                    ("from_name", Value::from(who.name.clone())),
                    ("from_org", self.org(&who.principal)),
                    ("text", Value::from(text)),
                    ("ts", f(now)),
                    ("reactions", Value::Object(Obj::new())),
                ]);
                if let Some(id) = &reply_to {
                    let i = self.channel_index(&cid, id)?;
                    let target = &self.channel_msgs[&cid][i];
                    msg.insert("reply_to".into(), Value::Object(preview(target, target.get("from_name"))?));
                }
                if let Some(id) = &thread {
                    let i = self.channel_index(&cid, id)?;
                    msg.insert("thread".into(), Value::from(channels::thread_id(&self.channel_msgs[&cid][i])));
                }
                file.insert("ts".into(), f(now));
                file.insert("channel".into(), Value::from(cid.clone()));
                msg.insert("files".into(), Value::Array(vec![Value::Object(file.clone())]));
                Ok(Message::Channel { cid, msg, session, thread: thread.is_some() })
            }
            _ => {
                if let Some(s) = &session {
                    self.session(s, who)?;
                }
                let to = pj::text_of(place, "with");
                let Some(entry) = self.directory.get(&to) else { return Err(E::NotFound("nobody with that address has used this relay yet".into())) };
                let to_name = entry.as_object().map(|e| pj::s(e, "name")).filter(|n| !n.is_empty()).unwrap_or_else(|| to.clone());
                let mut msg = obj([
                    ("id", Value::from(pj::token_hex(8))),
                    ("from", Value::from(who.principal.clone())),
                    ("from_name", Value::from(who.name.clone())),
                    ("from_org", self.org(&who.principal)),
                    ("to", Value::from(to.clone())),
                    ("to_name", Value::from(to_name)),
                    ("text", Value::from(text)),
                    ("ts", f(now)),
                    ("reactions", Value::Object(Obj::new())),
                ]);
                if let Some(id) = &reply_to {
                    let target = Hub::dm_message(self, &who.principal, &to, id)?;
                    let quoted = preview(target, target.get("from_name"))?;
                    msg.insert("reply_to".into(), Value::Object(quoted));
                }
                if let Some(id) = &thread {
                    let root = channels::thread_id(Hub::dm_message(self, &who.principal, &to, id)?);
                    msg.insert("thread".into(), Value::from(root));
                }
                file.insert("ts".into(), f(now));
                file.insert("with".into(), Value::from(to.clone()));
                msg.insert("files".into(), Value::Array(vec![Value::Object(file.clone())]));
                Ok(Message::Dm { to, msg, session, thread: thread.is_some() })
            }
        }
    }

    /// Keep a built message in its conversation and send it to everyone in it, as any message; the message as sent.
    fn files_deliver(&mut self, who: &Identity, built: Message) -> Obj {
        match built {
            Message::Room { room, mut line } => {
                self.room_log(&room, &mut line);
                self.broadcast(&room, &line, None);
                line
            }
            Message::Channel { cid, msg, session, thread } => {
                let msgs = self.channel_msgs.entry(cid.clone()).or_default();
                msgs.push(msg.clone());
                if thread {
                    channels::recount(msgs, &pj::text_of(&msg, "thread"));
                }
                if msgs.len() > channels::CHANNEL_KEEP {
                    let cut = msgs.len() - channels::CHANNEL_KEEP;
                    msgs.drain(..cut);
                }
                self.channel_mut(&cid).insert("last".into(), msg.get("ts").cloned().unwrap_or(Value::Null));
                let members = channels::members_of(self.channel(&cid));
                self.tell(&members, &obj([("type", Value::from("channel_message")), ("message", Value::Object(msg.clone()))]), Some(session.as_str()));
                msg
            }
            Message::Dm { to, msg, session, thread } => {
                let list = self.dms.entry(conv(&who.principal, &to)).or_default();
                list.push(msg.clone());
                if thread {
                    channels::recount(list, &pj::text_of(&msg, "thread"));
                }
                if list.len() > DM_KEEP {
                    let cut = list.len() - DM_KEEP;
                    list.drain(..cut);
                }
                self.tell(&[to, who.principal.clone()], &with(&msg, obj([("type", Value::from("dm"))])), session.as_deref());
                msg
            }
        }
    }
}

/// files_open's `offset` and `length`: absent, or a whole number of bytes.
fn whole(text: &str, what: &str) -> R<Option<u64>> {
    if text.is_empty() {
        return Ok(None);
    }
    match m::py_int(text) {
        Ok(n) if n >= 0 => Ok(Some(n as u64)),
        _ => bad(format!("{what} must be a whole number of bytes")),
    }
}

fn io_error(e: std::io::Error) -> E {
    E::Internal(e.to_string())
}

impl Hub {
    /// `POST /v1/files/start`: open an upload to a conversation the caller may write to. 413 over the size cap, 507
    /// over the relay's quota.
    #[allow(clippy::too_many_arguments)]
    pub fn files_start(&self, who: &Identity, scope: &str, name: Body, size: Body, kind: Body, peer: Option<String>, session: Option<String>, with_: Option<String>, channel: Option<String>) -> R<Obj> {
        let name = file_name(name)?;
        let size = file_size(size)?;
        let kind = file_type(kind);
        let mut st = self.st.lock();
        let now = pj::now();
        st.files.expire(now);
        let place = st.files_where(who, scope, peer.as_deref(), session.as_deref(), with_.as_deref(), channel.as_deref())?;
        if size > st.files.max {
            return Err(E::Status(413, format!("files are limited to {} MB", st.files.max / MB), false));
        }
        if st.files.uploads.values().filter(|u| u.principal == who.principal).count() >= UPLOADS_MAX {
            return Err(E::Conflict(format!("finish or cancel your other uploads first (at most {UPLOADS_MAX} at once)")));
        }
        if st.files_used() + size > st.files.quota {
            log_warn(&format!("files_full principal={} size={size}", who.principal));
            return Err(E::Status(507, FULL.into(), false));
        }
        let uid = pj::token_hex(16);
        let path = st.files.path(&uid, true).map_err(io_error)?;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&path).map_err(io_error)?;
        let upload = Upload {
            principal: who.principal.clone(),
            name,
            size,
            kind,
            place,
            peer: peer.unwrap_or_default(),
            received: 0,
            sha: Some(digest::Context::new(&digest::SHA256)),
            busy: false,
            expires: now + UPLOAD_TTL,
        };
        st.files.uploads.insert(uid.clone(), upload);
        drop(st);
        log_info(&format!("files_start upload={uid} scope={scope} principal={} size={size}", who.principal));
        Ok(obj([("upload", Value::from(uid)), ("chunk", Value::from(FILES_PART)), ("expires", f(now + UPLOAD_TTL))]))
    }

    /// Before a part's bytes are read: the upload is the caller's, open, idle, and the part starts where the relay's
    /// copy ends and stays within the size given. The upload is busy until files_chunk_write or files_chunk_abort.
    pub fn files_chunk_begin(&self, who: &Identity, upload: &str, offset: &str, length: usize) -> R<FilePart> {
        let offset = m::py_int(offset).map_err(|_| E::Bad("offset must be a whole number of bytes".into()))?;
        let mut st = self.st.lock();
        st.files.expire(pj::now());
        let up = st.files.open_upload(upload, who)?;
        if offset != up.received as i64 {
            return Err(E::Conflict(format!("the relay has {} bytes of this file; send the part that starts there", up.received)));
        }
        if up.received + length as u64 > up.size {
            return bad("that part goes past the size given at the start");
        }
        up.busy = true;
        let (at, sha) = (up.received, up.sha.take().unwrap_or_else(|| digest::Context::new(&digest::SHA256)));
        match st.files.path(upload, true) {
            Ok(path) => Ok(FilePart { id: upload.to_string(), path, offset: at, sha }),
            Err(e) => {
                Self::files_part_back(&mut st, upload, sha);
                Err(io_error(e))
            }
        }
    }

    /// The upload is idle again, with its hash.
    fn files_part_back<'a>(st: &'a mut State, uid: &str, sha: digest::Context) -> Option<&'a mut Upload> {
        let up = st.files.uploads.get_mut(uid)?;
        up.busy = false;
        up.sha = Some(sha);
        Some(up)
    }

    /// The part's bytes never came (the client went away).
    pub fn files_chunk_abort(&self, part: FilePart) {
        Self::files_part_back(&mut self.st.lock(), &part.id, part.sha);
    }

    /// Write one part (outside the lock: the upload is busy, nobody else touches it): `{upload, received, expires}`.
    pub fn files_chunk_write(&self, part: FilePart, data: &[u8]) -> R<Obj> {
        let written = (|| -> std::io::Result<()> {
            let mut fh = fs::OpenOptions::new().write(true).open(&part.path)?;
            fh.seek(SeekFrom::Start(part.offset))?;
            fh.write_all(data)?;
            fh.flush()
        })();
        let mut sha = part.sha;
        if written.is_ok() {
            sha.update(data);
        }
        let mut st = self.st.lock();
        // canceled while the part arrived
        let Some(up) = Self::files_part_back(&mut st, &part.id, sha) else { return Err(E::NotFound(NO_UPLOAD.into())) };
        written.map_err(io_error)?;
        up.received += data.len() as u64;
        up.expires = pj::now() + UPLOAD_TTL;
        Ok(obj([("upload", Value::from(part.id.clone())), ("received", Value::from(up.received)), ("expires", f(up.expires))]))
    }

    /// `POST /v1/files/finish`: every byte arrived and its SHA-256 matches; the file becomes a message of its
    /// conversation (`files: [file]`, optional `text`, `reply_to`, `thread`), sent to everyone in it like any message.
    #[allow(clippy::too_many_arguments)]
    pub fn files_finish(&self, who: &Identity, upload: Body, sha256: Body, text: Body, reply_to: Body, thread: Body, peer: Option<String>, session: Option<String>) -> R<Obj> {
        let uid = pj::str_or(upload);
        let sha = pj::str_or(sha256).trim().to_lowercase();
        if !(sha.len() == 64 && sha.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))) {
            return bad("sha256 must be the file's SHA-256 in hex");
        }
        let text = pj::str_or(text).trim().to_string();
        if pj::char_len(&text) > m::TEXT_MAX {
            return bad(format!("messages are limited to {} characters", m::TEXT_MAX));
        }
        let reply_to = message_id(reply_to, "reply_to")?;
        let thread = message_id(thread, "thread")?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, u64)> {
            st.files.expire(pj::now());
            let seat = st.files_caller(who, peer.as_deref(), session.as_deref())?;
            let up = st.files.open_upload(&uid, who)?;
            if up.received != up.size {
                return bad(format!("the file is not complete ({} of {} bytes arrived)", up.received, up.size));
            }
            let got = up.sha.clone().map(|c| hex(c.finish().as_ref())).unwrap_or_default();
            if got != sha {
                st.files.drop_upload(&uid);
                log_info(&format!("files_damaged upload={uid} principal={}", who.principal));
                return bad("the file arrived damaged (its SHA-256 does not match); send it again");
            }
            let place = up.place.clone();
            let size = up.size;
            let mut file = obj([
                ("id", Value::from(uid.clone())),
                ("name", Value::from(up.name.clone())),
                ("size", Value::from(size)),
                ("type", Value::from(up.kind.clone())),
                ("sha256", Value::from(sha.clone())),
                ("from", Value::from(who.principal.clone())),
                ("from_name", Value::from(who.name.clone())),
                ("scope", place.get("scope").cloned().unwrap_or(Value::Null)),
            ]);
            let built = st.files_build(who, &place, seat, session.clone(), &mut file, &text, reply_to.clone(), thread.clone())?;
            let (part, kept) = (st.files.path(&uid, true).map_err(io_error)?, st.files.path(&uid, false).map_err(io_error)?);
            fs::rename(&part, &kept).map_err(io_error)?;
            st.files.uploads.shift_remove(&uid);
            let (ts, mid) = match &built {
                Message::Room { line: msg, .. } | Message::Channel { msg, .. } | Message::Dm { msg, .. } => (msg.get("ts").cloned(), msg.get("id").cloned()),
            };
            let mut meta = file;
            meta.insert("ts".into(), ts.unwrap_or(Value::Null));
            meta.insert("message".into(), mid.unwrap_or(Value::Null));
            for k in ["with", "pair", "channel", "room"] {
                if let Some(v) = place.get(k) {
                    meta.insert(k.into(), v.clone());
                }
            }
            st.files_store().insert(uid.clone(), Value::Object(meta));
            st.dirty = true;
            let out = st.files_deliver(who, built);
            Ok((out, pj::text_of(&place, "scope"), size))
        })();
        drop(st);
        self.wake();
        let (out, scope, size) = r?;
        log_info(&format!("files_finish id={uid} scope={scope} principal={} size={size}", who.principal));
        Ok(out)
    }

    /// `GET /v1/files/list`: `{files}` of one conversation, newest first.
    #[allow(clippy::too_many_arguments)]
    pub fn files_list(&self, who: &Identity, scope: &str, peer: Option<String>, session: Option<String>, with_: Option<String>, channel: Option<String>, room: Option<String>) -> R<Obj> {
        let mut st = self.st.lock();
        let now = pj::now();
        let seat = st.files_caller(who, peer.as_deref(), session.as_deref())?;
        let mut windows: Option<Vec<(f64, f64)>> = None;
        let wanted: Box<dyn Fn(&Obj) -> bool> = match scope {
            "dm" => {
                let other = m::principal(with_.map(Value::from).as_ref());
                if other.is_empty() {
                    return bad("say whose conversation the files are in (with)");
                }
                let mut pair = [who.principal.clone(), other];
                pair.sort();
                let pair = Value::Array(pair.into_iter().map(Value::from).collect());
                Box::new(move |m: &Obj| pj::text_of(m, "scope") == "dm" && m.get("pair") == Some(&pair))
            }
            "channel" => {
                let Some(channel) = channel else { return bad("say which channel the files are in (channel)") };
                let cid = st.member_channel(&channel, &who.principal, false)?;
                Box::new(move |m: &Obj| pj::text_of(m, "scope") == "channel" && pj::text_of(m, "channel") == cid)
            }
            "room" => {
                let room = match (room, &seat) {
                    (Some(r), _) => m::room_name(Some(&Value::from(r)))?,
                    (None, Some(s)) => st.peers[s].room.clone(),
                    (None, None) => return bad("say which call the files are in (room)"),
                };
                if !st.files_in_room(who, &room, None) {
                    if !as_obj(st.left.get(&who.principal)).map(|o| o.contains_key(&room)).unwrap_or(false) {
                        return forbidden("you are not in that room");
                    }
                    windows = Some(Self::windows(&st, &room, &who.principal));
                }
                Box::new(move |m: &Obj| pj::text_of(m, "scope") == "room" && pj::text_of(m, "room") == room)
            }
            _ => return bad(SCOPE_ERROR),
        };
        let kept: Vec<(String, Obj)> = st.files_store().iter().filter_map(|(k, v)| v.as_object().filter(|m| wanted(m)).map(|m| (k.clone(), m.clone()))).collect();
        let mut rows: Vec<Obj> = Vec::new();
        for (fid, meta) in kept {
            if !st.files_alive(&fid, &meta, now) {
                continue;
            }
            let ts = pj::num(&meta, "ts");
            if windows.as_ref().map(|w| !w.iter().any(|(a, b)| *a <= ts && ts <= *b)).unwrap_or(false) {
                continue;
            }
            rows.push(State::files_view(&meta, &who.principal));
        }
        drop(st);
        rows.sort_by(|a, b| pj::num(b, "ts").partial_cmp(&pj::num(a, "ts")).unwrap_or(std::cmp::Ordering::Equal));
        rows.truncate(LIST_MAX);
        Ok(obj([("files", Value::Array(rows.into_iter().map(Value::Object).collect()))]))
    }

    /// `GET /v1/files/get`: `(file, open file, offset, count)` for a member; the file is opened under the lock, so a
    /// delete cannot slip in between.
    pub fn files_open(&self, who: &Identity, id: &str, offset: &str, length: &str, peer: Option<String>, session: Option<String>) -> R<(Obj, fs::File, u64, u64)> {
        let start = whole(offset, "offset")?.unwrap_or(0);
        let count = whole(length, "length")?;
        let mut st = self.st.lock();
        st.files_caller(who, peer.as_deref(), session.as_deref())?;
        let meta = st.files_live(id)?;
        st.files_member(who, &meta)?;
        let size = size_of(&meta);
        if start > size {
            return bad("offset is past the end of the file");
        }
        let count = count.unwrap_or(size - start).min(size - start);
        let fid = pj::text_of(&meta, "id");
        let path = st.files.path(&fid, false).map_err(io_error)?;
        match fs::File::open(&path) {
            Ok(fh) => Ok((State::files_view(&meta, &who.principal), fh, start, count)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                log_warn(&format!("files_missing id={fid}"));
                st.files_purge(&fid, None);
                Err(E::NotFound(GONE.into()))
            }
            Err(e) => Err(io_error(e)),
        }
    }

    /// `POST /v1/files/delete`: the uploader or a relay admin removes a file (its bytes go, its message's `files` loses
    /// it, everyone in the conversation hears `chat_update`). The uploader may also cancel an unfinished upload this
    /// way.
    pub fn files_delete(&self, who: &Identity, id: Body, peer: Option<String>, session: Option<String>) -> R<Obj> {
        let fid = pj::str_or(id);
        let mut st = self.st.lock();
        let r = (|| -> R<Option<(Obj, bool)>> {
            st.files_caller(who, peer.as_deref(), session.as_deref())?;
            let mine = is_id(&fid) && st.files.uploads.get(&fid).map(|u| u.principal == who.principal).unwrap_or(false);
            if mine {
                st.files.drop_upload(&fid);
                return Ok(None);
            }
            let meta = st.files_live(&fid)?;
            let admin = st.admins.contains(&who.principal);
            if !admin {
                st.files_member(who, &meta)?;
                if pj::text_of(&meta, "from") != who.principal {
                    return forbidden(NOT_YOURS);
                }
            }
            st.files_purge(&fid, Some(who));
            Ok(Some((meta, admin)))
        })();
        drop(st);
        self.wake();
        match r? {
            None => {
                log_info(&format!("files_cancel upload={fid} principal={}", who.principal));
                Ok(obj([("ok", Value::Bool(true)), ("id", Value::from(fid)), ("upload", Value::Bool(true))]))
            }
            Some((meta, admin)) => {
                log_info(&format!("files_delete id={fid} scope={} principal={} admin={}", pj::text_of(&meta, "scope"), who.principal, if admin { "yes" } else { "no" }));
                Ok(obj([("ok", Value::Bool(true)), ("id", Value::from(fid)), ("message", meta.get("message").cloned().unwrap_or(Value::Null))]))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn who(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), ..Default::default() }
    }

    #[test]
    fn names_types_and_sizes_are_checked() {
        assert_eq!(file_name(Some(&json!("../../etc/Q4 report.pdf"))).unwrap(), "Q4 report.pdf");
        assert_eq!(file_name(Some(&json!("C:\\x\\a.txt"))).unwrap(), "a.txt");
        assert!(file_name(Some(&json!(".."))).is_err());
        assert!(file_name(Some(&json!("x".repeat(201)))).is_err());
        assert_eq!(file_type(Some(&json!("application/PDF; charset=x"))), "application/pdf");
        assert_eq!(file_type(Some(&json!("not a type"))), "application/octet-stream");
        assert!(file_size(Some(&json!(-1))).is_err() && file_size(Some(&json!(true))).is_err());
        assert!(is_id(&"f".repeat(32)) && !is_id("../x") && !is_id(&"F".repeat(32)));
    }

    #[test]
    fn a_dm_file_goes_up_in_parts_comes_back_and_goes_with_a_delete() {
        let dir = std::env::temp_dir().join(format!("meet-files-{}", pj::token_hex(4)));
        let h = Hub::new(Some(dir.clone()), &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        let (ann, ben) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", "bbbbbbbbbbbbbbbb"));
        let a = h.hello(&ann, "", &Obj::new()).unwrap()["session"].as_str().unwrap().to_string();
        let b = h.hello(&ben, "", &Obj::new()).unwrap()["session"].as_str().unwrap().to_string();
        let data = b"hello, file";
        let up = h.files_start(&ann, "dm", Some(&json!("n.txt")), Some(&json!(data.len())), None, None, Some(a.clone()), Some("ben@x".into()), None).unwrap();
        let uid = up["upload"].as_str().unwrap().to_string();
        let part = h.files_chunk_begin(&ann, &uid, "0", 5).unwrap();
        assert!(matches!(h.files_chunk_begin(&ann, &uid, "0", 5), Err(E::Conflict(_))));
        assert_eq!(h.files_chunk_write(part, &data[..5]).unwrap()["received"], json!(5));
        let part = h.files_chunk_begin(&ann, &uid, "5", data.len() - 5).unwrap();
        h.files_chunk_write(part, &data[5..]).unwrap();
        let sha = hex(&crate::codec::sha256(data));
        let msg = h.files_finish(&ann, Some(&json!(uid)), Some(&json!(sha)), None, None, None, None, Some(a.clone())).unwrap();
        assert_eq!(msg["files"][0]["with"], json!("ben@x"));
        let (view, mut fh, start, count) = h.files_open(&ben, &uid, "6", "", None, Some(b.clone())).unwrap();
        assert_eq!((view["with"].clone(), start, count), (json!("ann@x"), 6, 5));
        let mut got = Vec::new();
        fh.seek(SeekFrom::Start(start)).unwrap();
        std::io::Read::read_to_end(&mut fh, &mut got).unwrap();
        assert_eq!(got, b" file");
        drop(fh);
        let cy = who("cy@x", "cccccccccccccccc");
        let c = h.hello(&cy, "", &Obj::new()).unwrap()["session"].as_str().unwrap().to_string();
        assert!(matches!(h.files_open(&cy, &uid, "", "", None, Some(c)), Err(E::NotFound(m)) if m == GONE));
        assert!(matches!(h.files_delete(&ben, Some(&json!(uid)), None, Some(b.clone())), Err(E::Forbidden(m)) if m == NOT_YOURS));
        h.files_delete(&ann, Some(&json!(uid)), None, Some(a)).unwrap();
        assert!(!dir.join("files").join(&uid).exists());
        let _ = fs::remove_dir_all(dir);
    }
}
