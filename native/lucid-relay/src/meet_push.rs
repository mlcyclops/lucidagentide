// Parity wave B (contract PB-1 section 5): iPhone alert pushes through APNs under ADR-0174's conditions: content-free,
// only to an iPhone device with no live session, org opt-in (relay.json `push`), never on an enclave relay. A child
// module of meet_hub: it shares the hub's one lock. Persisted in state.json as the Python keeps it: `push_tokens`
// {principal: {device: {token, env, ts, serial}}}; the thread-id secret is state_dir/push.secret (32 random bytes,
// mode 0600; random per process without a state folder). The sender is HTTP/2 over rustls (hyper's http2 client)
// with an ES256 JWT signed on AWS-LC, on its own thread.

use super::*;

/// A person's pushes for one conversation (per device, messages and calls apart): at most one per RATE_S seconds
/// (monotonic).
const RATE_S: f64 = 30.0;
const TOKEN_MIN: usize = 64;
const TOKEN_MAX: usize = 200;
const ENVS: [&str; 2] = ["sandbox", "production"];
const SECRET_FILE: &str = "push.secret";
/// The per-person key: HMAC-SHA256(secret, KEY_LABEL + principal).
const KEY_LABEL: &str = "lucid-meet-push\n";
const TITLE: &str = "Lucid Meet";
const NEW_MESSAGE: &str = "New message";
const INCOMING_CALL: &str = "Incoming call";

pub const PUSH_OFF: &str = "push notifications are off on this relay";
const BAD_TOKEN: &str = "token must be 64 to 200 hex characters";
const BAD_ENV: &str = "env must be sandbox or production";
const NO_SANDBOX: &str = "sandbox push tokens are off on this relay";

/// In memory: the sender (None: push is off), whether sandbox tokens are taken, the secret, and the rate book.
pub struct Push {
    sender: Option<apns::Sender>,
    sandbox: bool,
    state_dir: Option<PathBuf>,
    secret: Vec<u8>,
    /// (principal, device, conversation key, "message" or "call") -> monotonic time of the last push.
    last: HashMap<(String, String, String, &'static str), f64>,
}

impl Push {
    pub fn new(state_dir: Option<&std::path::Path>) -> Push {
        Push { sender: None, sandbox: true, state_dir: state_dir.map(|d| d.to_path_buf()), secret: Vec::new(), last: HashMap::new() }
    }

    /// _push_secret: state_dir/push.secret (made once, mode 0600), or a random one per process without a state folder.
    fn secret(&mut self) -> &[u8] {
        if self.secret.is_empty() {
            self.secret = match &self.state_dir {
                Some(dir) => {
                    let path = dir.join(SECRET_FILE);
                    let mut key = std::fs::read(&path).unwrap_or_default();
                    if key.len() != 32 {
                        key = pj::random_bytes(32);
                        if let Err(e) = write_secret(dir, &key) {
                            log_warn(&format!("cannot write {}: {e}", path.display()));
                        }
                    }
                    key
                }
                None => pj::random_bytes(32),
            };
        }
        &self.secret
    }
}

fn write_secret(dir: &std::path::Path, key: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{SECRET_FILE}.tmp"));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut fh = opts.open(&tmp)?;
    fh.write_all(key)?;
    fh.sync_all()?;
    drop(fh);
    std::fs::rename(&tmp, dir.join(SECRET_FILE))
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let k = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, key);
    let mut out = [0u8; 32];
    out.copy_from_slice(aws_lc_rs::hmac::sign(&k, data).as_ref());
    out
}

/// _push_token: an APNs device token, 64 to 200 hex characters, kept in lower case.
fn token_of(v: Body) -> R<String> {
    match v {
        Some(Value::String(t)) if (TOKEN_MIN..=TOKEN_MAX).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_hexdigit()) => Ok(t.to_ascii_lowercase()),
        _ => bad(BAD_TOKEN),
    }
}

/// _push_stored: one device's registration from state.json has the shape the relay keeps.
fn stored_entry(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let token_ok = o.get("token").and_then(Value::as_str).map(|t| t == t.to_ascii_lowercase() && token_of(Some(&Value::from(t))).is_ok()).unwrap_or(false);
    let env_ok = o.get("env").and_then(Value::as_str).map(|e| ENVS.contains(&e)).unwrap_or(false);
    o.len() == 4 && token_ok && env_ok && pj::as_int(o.get("ts")).is_some() && o.get("serial").map(Value::is_string).unwrap_or(false)
}

/// The id a reply or thread names: a plain message's `reply_to` is its preview `{id, name, text}`, an encrypted one's
/// the id itself.
fn ref_id(v: Option<&Value>) -> Option<&str> {
    match v? {
        Value::String(s) => Some(s.as_str()),
        Value::Object(o) => o.get("id").and_then(Value::as_str),
        _ => None,
    }
}

/// _push_payload: content-free: no names, no titles, no text, ever. `id` is the thread-id and `c`.
fn payload(badge: i64, id: &str, call: bool) -> Vec<u8> {
    let alert = obj([("title", Value::from(TITLE)), ("body", Value::from(if call { INCOMING_CALL } else { NEW_MESSAGE }))]);
    let mut aps = obj([("alert", Value::Object(alert)), ("badge", Value::from(badge)), ("sound", Value::from("default")), ("thread-id", Value::from(id))]);
    if call {
        aps.insert("interruption-level".into(), Value::from("time-sensitive"));
    }
    pj::dumps_compact(&Value::Object(obj([("aps", Value::Object(aps)), ("c", Value::from(id))]))).into_bytes()
}

impl State {
    /// _push_load: the registrations from state.json (an unsound one is dropped).
    pub(super) fn pu_load(&mut self, raw: &Obj) {
        for (principal, devices) in as_obj(raw.get("push_tokens")).into_iter().flatten() {
            let mut kept = Obj::new();
            for (device, entry) in as_obj(Some(devices)).into_iter().flatten() {
                if stored_entry(entry) {
                    kept.insert(device.clone(), entry.clone());
                } else {
                    log_warn(&format!("state file: push token of {principal} device={} unreadable; ignored", kv(device)));
                }
            }
            if !kept.is_empty() {
                self.push_tokens.insert(principal.clone(), Value::Object(kept));
            }
        }
    }

    /// Push is on: enabled in relay.json, the key read and the sender running.
    pub(super) fn pu_on(&self) -> bool {
        self.pu.sender.is_some()
    }

    /// _push_person_key: what register answers (`key`, base64): the app derives thread-ids and `c` with it.
    fn pu_person_key(&mut self, principal: &str) -> [u8; 32] {
        hmac(self.pu.secret(), format!("{KEY_LABEL}{principal}").as_bytes())
    }

    /// _push_id: the thread-id, `c` and apns-collapse-id of one conversation as `principal` sees it: the first 16 bytes
    /// of HMAC-SHA256(person key, conversation key), 32 lower-case hex.
    fn pu_id(&mut self, principal: &str, conv: &str) -> String {
        let key = self.pu_person_key(principal);
        crate::codec::hex(&hmac(&key, conv.as_bytes())[..16])
    }

    /// The device has a live presence session or room seat.
    fn pu_live(&self, principal: &str, device: &str) -> bool {
        self.sessions.values().any(|s| s.who.principal == principal && s.who.device == device) || self.peers.values().any(|p| p.who.principal == principal && p.who.device == device)
    }

    /// _push_badge: what the person has unread, by their levels: direct messages of a sender at level all (hello's
    /// `unread`), and per channel or group chat they are in, at level all the main conversation's messages of others
    /// after their read mark, at mentions those of others (thread replies too) that mention them, at off none.
    fn pu_badge(&self, principal: &str) -> i64 {
        let mut n: i64 = self.unread(principal).iter().filter(|(from, _)| self.pu_level(principal, &format!("dm:{from}")) == "all").filter_map(|(_, c)| c.as_i64()).sum();
        let marks = as_obj(self.channel_read.get(principal));
        for (cid, ch) in self.channels.iter() {
            if !channels::members_of(ch.as_object()).iter().any(|p| p == principal) {
                continue;
            }
            let level = self.pu_level(principal, &format!("channel:{cid}"));
            if level == "off" {
                continue;
            }
            let mark = marks.and_then(|o| pj::as_num(o.get(cid))).unwrap_or(0.0);
            let fresh = self.channel_msgs.get(cid).into_iter().flatten().filter(|m| pj::num(m, "ts") > mark && pj::text_of(m, "from") != principal && !pj::truthy(m.get("deleted")) && !pj::truthy(m.get("imported")));
            let count = if level == "all" {
                fresh.filter(|m| !pj::truthy(m.get("thread")) || pj::truthy(m.get("also_channel"))).count()
            } else {
                fresh.filter(|m| m.get("mentions").and_then(Value::as_array).map(|l| l.iter().any(|p| p.as_str() == Some(principal))).unwrap_or(false)).count()
            };
            n += count as i64;
        }
        n
    }

    /// The person's wave A level for a conversation: its own, else for a channel (not a group chat) their
    /// channel_default, else "all".
    fn pu_level(&self, principal: &str, conv: &str) -> String {
        let prefs = as_obj(self.prefs.get(principal));
        if let Some(level) = prefs.and_then(|p| as_obj(p.get("notify"))).and_then(|n| n.get(conv)).and_then(Value::as_str) {
            return level.to_string();
        }
        let channel = conv.strip_prefix("channel:").and_then(|cid| self.channel(cid));
        if channel.map(|c| pj::text_of(c, "kind") != "group").unwrap_or(false) {
            if let Some(d) = prefs.and_then(|p| p.get("channel_default")).and_then(Value::as_str) {
                return d.to_string();
            }
        }
        "all".into()
    }

    /// _push_send: one content-free push to each of the person's registered devices that is offline, unless they
    /// are on Do not disturb, at most one per conversation, device and kind (message or call) every RATE_S seconds.
    fn pu_send(&mut self, principal: &str, conv: &str, call: bool) {
        if !self.pu_on() {
            return;
        }
        let Some(devices) = as_obj(self.push_tokens.get(principal)).cloned() else { return };
        if self.status_of(principal).get("state").and_then(Value::as_str) == Some("dnd") {
            return;
        }
        let now = pj::mono();
        self.pu.last.retain(|_, at| now - *at < RATE_S);
        let mut body: Option<(String, Vec<u8>)> = None;
        for (device, entry) in devices {
            if self.pu_live(principal, &device) {
                continue;
            }
            let rate = (principal.to_string(), device.clone(), conv.to_string(), if call { "call" } else { "message" });
            if self.pu.last.contains_key(&rate) {
                continue;
            }
            if body.is_none() {
                let id = self.pu_id(principal, conv);
                let p = payload(self.pu_badge(principal), &id, call);
                body = Some((id, p));
            }
            let Some((id, bytes)) = &body else { return };
            let job = apns::Job {
                principal: principal.to_string(),
                device: device.clone(),
                token: entry.get("token").and_then(Value::as_str).unwrap_or_default().to_string(),
                sandbox: entry.get("env").and_then(Value::as_str) == Some("sandbox"),
                collapse: id.clone(),
                call,
                payload: bytes.clone(),
            };
            let Some(sender) = &self.pu.sender else { return };
            if sender.send(job) {
                self.pu.last.insert(rate, now);
            } else {
                log_warn(&format!("push dropped principal={principal} device={} why=queue", kv(&device)));
            }
        }
    }

    /// _push_message: a new message in a direct conversation (`dm`: the other person) or a channel or group chat
    /// (`cid`), already kept. Each recipient's level decides: all pushes, mentions only when they are mentioned or it
    /// replies to them (its reply_to or thread root is theirs), off never; a thread reply kept out of the main
    /// conversation pushes (unless off) only when it mentions or answers them. A call's chat never pushes.
    pub(super) fn pu_message(&mut self, cid: Option<&str>, dm: Option<&str>, msg: &Obj) {
        if !self.pu_on() {
            return;
        }
        let from = pj::text_of(msg, "from");
        let rows: &[Obj] = match (cid, dm) {
            (Some(cid), _) => self.channel_msgs.get(cid).map(Vec::as_slice).unwrap_or_default(),
            (None, Some(other)) => self.dms.get(&conv(&from, other)).map(Vec::as_slice).unwrap_or_default(),
            (None, None) => return,
        };
        let author = |id: Option<&str>| id.and_then(|id| rows.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id))).map(|r| pj::text_of(r, "from"));
        let answered: Vec<String> = [author(ref_id(msg.get("reply_to"))), author(ref_id(msg.get("thread")))].into_iter().flatten().collect();
        let mentioned: Vec<String> = msg.get("mentions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        let (recipients, conv_key) = match (cid, dm) {
            (Some(cid), _) => (channels::members_of(self.channel(cid)), format!("channel:{cid}")),
            (None, Some(other)) => (vec![other.to_string()], format!("dm:{from}")),
            (None, None) => return,
        };
        // a thread reply kept out of the main conversation only reaches the people it mentions or answers
        let side = pj::truthy(msg.get("thread")) && !pj::truthy(msg.get("also_channel"));
        for to in recipients.into_iter().filter(|p| *p != from) {
            let theirs = mentioned.contains(&to) || answered.contains(&to);
            let push = match self.pu_level(&to, &conv_key).as_str() {
                "all" => theirs || !side,
                "mentions" => theirs,
                _ => false,
            };
            if push {
                self.pu_send(&to, &conv_key, false);
            }
        }
    }

    /// _push_invite: a call ringing `to` (one invite of `from`). The conversation the call belongs to as `to` sees it:
    /// the direct call of the two of them (`dm:<from>`), a channel's call they are a member of (`channel:<id>`),
    /// else the room (`room:<room>`). Level off sends nothing.
    pub(super) fn pu_invite(&mut self, from: &str, to: &str, room: &str) {
        if !self.pu_on() || !self.push_tokens.contains_key(to) {
            return;
        }
        let mut pair = [from.to_lowercase(), to.to_lowercase()];
        pair.sort();
        let digest = crate::codec::sha256_hex(pair.join("|").as_bytes());
        let key = if room == format!("dm-{}", &digest[..16]) {
            format!("dm:{from}")
        } else {
            // _bridge_room: a bridged DM's `bdm:<link id>` rings as `cv-bdm-<link id>`
            let channel = self.channels.iter().find(|(cid, ch)| bridge::room(&cid.trim().to_lowercase()) == room && channels::members_of(ch.as_object()).iter().any(|m| m == to));
            match channel {
                Some((cid, _)) => format!("channel:{cid}"),
                None => format!("room:{room}"),
            }
        };
        if self.pu_level(to, &key) != "off" {
            self.pu_send(to, &key, true);
        }
    }

    /// drop_serials: the registrations made with a revoked certificate go.
    pub(super) fn pu_drop_serials(&mut self, serials: &HashSet<String>) {
        let mut dropped = Vec::new();
        for (principal, devices) in self.push_tokens.iter_mut() {
            let Some(devices) = devices.as_object_mut() else { continue };
            devices.retain(|device, e| {
                let gone = e.get("serial").and_then(Value::as_str).map(|s| serials.contains(s)).unwrap_or(false);
                if gone {
                    dropped.push((principal.clone(), device.clone()));
                }
                !gone
            });
        }
        if dropped.is_empty() {
            return;
        }
        self.push_tokens.retain(|_, d| d.as_object().map(|o| !o.is_empty()).unwrap_or(false));
        self.dirty = true;
        for (principal, device) in dropped {
            log_info(&format!("push_drop principal={principal} device={} why=revoked", kv(&device)));
        }
    }

    /// Forget one device's registration; true when there was one.
    fn pu_forget(&mut self, principal: &str, device: &str) -> bool {
        let Some(devices) = self.push_tokens.get_mut(principal).and_then(Value::as_object_mut) else { return false };
        let removed = devices.shift_remove(device).is_some();
        if devices.is_empty() {
            self.push_tokens.shift_remove(principal);
        }
        if removed {
            self.dirty = true;
        }
        removed
    }
}

impl Hub {
    /// _push_configure: relay.json `push`, once at start (enclave and the shape were checked when relay.json was
    /// read). Anything wrong at run time turns push off with one line; the key's path and bytes are never logged.
    pub fn push_configure(self: &Arc<Self>, s: &m::Settings) {
        if !s.push.enabled {
            return;
        }
        let key = match apns::Key::load(&s.push.team_id, &s.push.key_id, &s.push.key_file) {
            Ok(k) => k,
            Err(why) => return log_warn(&format!("push off: {why}")),
        };
        let weak = Arc::downgrade(self);
        let gone: apns::OnGone = Arc::new(move |principal: &str, device: &str, token: &str, why: &str| {
            if let Some(hub) = weak.upgrade() {
                hub.push_gone(principal, device, token, why);
            }
        });
        let started = apns::Endpoint::apple().and_then(|ep| apns::Sender::start(key, s.push.topic.clone(), ep, gone));
        match started {
            Ok(sender) => {
                let mut st = self.st.lock();
                st.pu.sender = Some(sender);
                st.pu.sandbox = s.push.sandbox;
                log_info(&format!("push on: topic={} sandbox={}", s.push.topic, if s.push.sandbox { "yes" } else { "no" }));
            }
            Err(e) => log_warn(&format!("push off: {e}")),
        }
    }

    /// push_register (`POST /v1/push/register {token, env}`): this device's APNs token (one per device, replaced by
    /// a new one; a token another device registered moves here). `{ok, key}`: the person's push key (base64) the app
    /// maps thread-ids and `c` back with.
    pub fn push_register(&self, who: &Identity, token: Body, env: Body) -> R<Obj> {
        let mut st = self.st.lock();
        if !st.pu_on() {
            return Err(E::Unavailable(PUSH_OFF.into()));
        }
        if !who.own_device() {
            return forbidden(m::FINISH_SETUP);
        }
        let token = token_of(token)?;
        let env = match env {
            Some(Value::String(e)) if ENVS.contains(&e.as_str()) => e.clone(),
            _ => return bad(BAD_ENV),
        };
        if env == "sandbox" && !st.pu.sandbox {
            return bad(NO_SANDBOX);
        }
        for devices in st.push_tokens.values_mut().filter_map(Value::as_object_mut) {
            devices.retain(|_, e| e.get("token").and_then(Value::as_str) != Some(token.as_str()));
        }
        st.push_tokens.retain(|_, d| d.as_object().map(|o| !o.is_empty()).unwrap_or(false));
        let entry = obj([("token", Value::from(token)), ("env", Value::from(env.clone())), ("ts", Value::from((pj::now() * 1000.0) as i64)), ("serial", Value::from(m::serial(&who.serial)))]);
        let devices = st.push_tokens.entry(who.principal.clone()).or_insert_with(|| Value::Object(Obj::new()));
        if !devices.is_object() {
            *devices = Value::Object(Obj::new());
        }
        devices.as_object_mut().expect("a device map").insert(who.device.clone(), Value::Object(entry));
        st.dirty = true;
        let key = st.pu_person_key(&who.principal);
        drop(st);
        log_info(&format!("push_register principal={} device={} env={env}", who.principal, kv(&who.device)));
        Ok(obj([("ok", Value::Bool(true)), ("key", Value::from(pj::b64(&key)))]))
    }

    /// push_unregister (`POST /v1/push/unregister {}`): this device gets no more pushes. `{ok, removed}`.
    pub fn push_unregister(&self, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        if !st.pu_on() {
            return Err(E::Unavailable(PUSH_OFF.into()));
        }
        if !who.own_device() {
            return forbidden(m::FINISH_SETUP);
        }
        let removed = st.pu_forget(&who.principal, &who.device);
        drop(st);
        if removed {
            log_info(&format!("push_unregister principal={} device={}", who.principal, kv(&who.device)));
        }
        Ok(obj([("ok", Value::Bool(true)), ("removed", Value::Bool(removed))]))
    }

    /// APNs said the token is no longer valid (410, or 400 BadDeviceToken): it goes, unless the device registered
    /// another one meanwhile.
    fn push_gone(&self, principal: &str, device: &str, token: &str, why: &str) {
        let mut st = self.st.lock();
        let same = as_obj(st.push_tokens.get(principal)).and_then(|d| as_obj(d.get(device))).map(|e| pj::text_of(e, "token") == token).unwrap_or(false);
        if same && st.pu_forget(principal, device) {
            drop(st);
            log_info(&format!("push_drop principal={principal} device={} why={why}", kv(device)));
        }
    }
}

/// The APNs sender: HTTP/2 over rustls to api.push.apple.com or api.sandbox.push.apple.com (the token's registered
/// env picks), one connection per host kept open, authenticated by an ES256 JWT (`kid`; `iss`, `iat`) re-signed every
/// 50 minutes. Jobs queue to its own thread; the hub never waits on Apple.
pub mod apns {
    use crate::meet::log_warn;
    use crate::meet_json::{self as pj, obj};
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::client::conn::http2::SendRequest;
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use rustls::pki_types::ServerName;
    use rustls::ClientConfig;
    use serde_json::Value;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    pub const PRODUCTION: &str = "api.push.apple.com";
    pub const SANDBOX: &str = "api.sandbox.push.apple.com";
    /// Pushes waiting for the sender; past it a push is dropped (and logged).
    const QUEUE: usize = 1000;
    /// Connecting, the TLS handshake and one request each.
    const TIMEOUT: Duration = Duration::from_secs(10);
    /// Apple refuses a provider token older than an hour and one renewed more often than every 20 minutes.
    pub const JWT_EVERY: Duration = Duration::from_secs(50 * 60);
    /// A message push that cannot be delivered within an hour is dropped by Apple; a call's is tried once.
    const MESSAGE_TTL: i64 = 3600;

    /// One push for the sender thread.
    pub struct Job {
        pub principal: String,
        pub device: String,
        pub token: String,
        pub sandbox: bool,
        pub collapse: String,
        pub call: bool,
        pub payload: Vec<u8>,
    }

    /// Called with (principal, device, token, why) when APNs says the token is no longer valid.
    pub type OnGone = Arc<dyn Fn(&str, &str, &str, &str) + Send + Sync>;

    /// The provider key (.p8, PKCS#8 P-256) and the JWT made with it.
    pub struct Key {
        team_id: String,
        key_id: String,
        pair: EcdsaKeyPair,
        jwt: parking_lot::Mutex<Option<(String, Instant)>>,
    }

    impl Key {
        /// Read the key file: refused when it cannot be read, when group or others may read it (POSIX), or when it is
        /// not a P-256 private key. The reasons never name the file or show its bytes.
        pub fn load(team_id: &str, key_id: &str, path: &str) -> Result<Key, String> {
            let data = std::fs::read(path).map_err(|_| "key_file cannot be read".to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(path).map_err(|_| "key_file cannot be read".to_string())?.permissions().mode();
                if mode & 0o077 != 0 {
                    return Err("key_file must be readable by the relay only (mode 600)".into());
                }
            }
            Key::from_pem(team_id, key_id, &data)
        }

        pub fn from_pem(team_id: &str, key_id: &str, pem: &[u8]) -> Result<Key, String> {
            let not_p256 = || "key_file is not a P-256 private key".to_string();
            let der = match rustls_pemfile::private_key(&mut &pem[..]) {
                Ok(Some(rustls::pki_types::PrivateKeyDer::Pkcs8(k))) => k,
                _ => return Err(not_p256()),
            };
            let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der.secret_pkcs8_der()).map_err(|_| not_p256())?;
            Ok(Key { team_id: team_id.to_string(), key_id: key_id.to_string(), pair, jwt: parking_lot::Mutex::new(None) })
        }

        /// The provider token: the one made less than JWT_EVERY ago, else a new one.
        pub fn token(&self) -> Result<String, String> {
            let mut held = self.jwt.lock();
            if let Some((t, at)) = held.as_ref() {
                if at.elapsed() < JWT_EVERY {
                    return Ok(t.clone());
                }
            }
            let t = self.sign(pj::now() as i64)?;
            *held = Some((t.clone(), Instant::now()));
            Ok(t)
        }

        /// Apple refused the token (expired or invalid): the next push makes a new one.
        pub fn forget(&self) {
            *self.jwt.lock() = None;
        }

        /// An ES256 JWT: header `{alg, kid}`, claims `{iss, iat}`, signature R || S (64 bytes), all base64url.
        pub fn sign(&self, iat: i64) -> Result<String, String> {
            let header = obj([("alg", Value::from("ES256")), ("kid", Value::from(self.key_id.clone()))]);
            let claims = obj([("iss", Value::from(self.team_id.clone())), ("iat", Value::from(iat))]);
            let input = format!("{}.{}", crate::codec::b64u(pj::dumps_compact(&Value::Object(header)).as_bytes()), crate::codec::b64u(pj::dumps_compact(&Value::Object(claims)).as_bytes()));
            let sig = self.pair.sign(&SystemRandom::new(), input.as_bytes()).map_err(|_| "cannot sign the provider token".to_string())?;
            Ok(format!("{input}.{}", crate::codec::b64u(sig.as_ref())))
        }
    }

    /// Where pushes go: the TLS client (webpki roots, ALPN h2) and the production and sandbox hosts.
    pub struct Endpoint {
        tls: Arc<ClientConfig>,
        production: (String, u16),
        sandbox: (String, u16),
    }

    impl Endpoint {
        pub fn apple() -> Result<Endpoint, String> {
            Endpoint::new(None, (PRODUCTION.into(), 443), (SANDBOX.into(), 443))
        }

        /// `ca`: a PEM file of the roots to trust instead of the webpki set.
        pub fn new(ca: Option<&str>, production: (String, u16), sandbox: (String, u16)) -> Result<Endpoint, String> {
            let mut cfg = (*crate::meet_tls::client_config(ca, None)?).clone();
            cfg.alpn_protocols = vec![b"h2".to_vec()];
            Ok(Endpoint { tls: Arc::new(cfg), production, sandbox })
        }

        fn host(&self, sandbox: bool) -> &(String, u16) {
            if sandbox {
                &self.sandbox
            } else {
                &self.production
            }
        }

        fn authority(&self, sandbox: bool) -> String {
            match self.host(sandbox) {
                (h, 443) => h.clone(),
                (h, p) => format!("{h}:{p}"),
            }
        }
    }

    /// The handle the hub keeps: jobs go to the sender thread without waiting.
    pub struct Sender {
        tx: tokio::sync::mpsc::Sender<Job>,
    }

    impl Sender {
        pub fn start(key: Key, topic: String, ep: Endpoint, gone: OnGone) -> Result<Sender, String> {
            let (tx, rx) = tokio::sync::mpsc::channel(QUEUE);
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
            let ctx = Arc::new(Ctx { key, topic, ep, gone });
            std::thread::Builder::new().name("relay-push".into()).spawn(move || runtime.block_on(run(ctx, rx))).map_err(|e| e.to_string())?;
            Ok(Sender { tx })
        }

        /// A sender whose jobs land in the receiver (tests of the send rules).
        #[cfg(test)]
        pub fn capture() -> (Sender, tokio::sync::mpsc::Receiver<Job>) {
            let (tx, rx) = tokio::sync::mpsc::channel(QUEUE);
            (Sender { tx }, rx)
        }

        /// Queue one push; false when the queue is full.
        pub fn send(&self, job: Job) -> bool {
            self.tx.try_send(job).is_ok()
        }
    }

    struct Ctx {
        key: Key,
        topic: String,
        ep: Endpoint,
        gone: OnGone,
    }

    type Conn = SendRequest<Full<Bytes>>;

    async fn run(ctx: Arc<Ctx>, mut rx: tokio::sync::mpsc::Receiver<Job>) {
        let mut conns: [Option<Conn>; 2] = [None, None];
        while let Some(job) = rx.recv().await {
            let i = usize::from(job.sandbox);
            if conns[i].as_ref().map(|c| c.is_closed()).unwrap_or(true) {
                conns[i] = match connect(&ctx.ep, job.sandbox).await {
                    Ok(c) => Some(c),
                    Err(e) => {
                        log_warn(&format!("push failed principal={} device={} why={}", job.principal, crate::meet::kv(&job.device), crate::meet::kv(&e)));
                        continue;
                    }
                };
            }
            let Some(conn) = conns[i].clone() else { continue };
            tokio::spawn(deliver(ctx.clone(), conn, job));
        }
    }

    async fn connect(ep: &Endpoint, sandbox: bool) -> Result<Conn, String> {
        let (host, port) = ep.host(sandbox).clone();
        let tcp = tokio::time::timeout(TIMEOUT, tokio::net::TcpStream::connect((host.as_str(), port))).await.map_err(|_| "connect timed out".to_string())?.map_err(|e| e.to_string())?;
        let name = ServerName::try_from(host).map_err(|e| e.to_string())?;
        let tls = tokio::time::timeout(TIMEOUT, tokio_rustls::TlsConnector::from(ep.tls.clone()).connect(name, tcp)).await.map_err(|_| "TLS handshake timed out".to_string())?.map_err(|e| e.to_string())?;
        let (send, conn) = hyper::client::conn::http2::Builder::new(TokioExecutor::new()).handshake(TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(send)
    }

    /// What APNs answered: delivered, the token is gone (410, 400 BadDeviceToken), or another failure.
    #[derive(Debug, PartialEq)]
    pub enum Outcome {
        Sent,
        Gone(String),
        Failed(String),
    }

    /// Read APNs' answer (status and its `{reason}`).
    pub fn outcome(status: u16, body: &[u8]) -> Outcome {
        let reason = serde_json::from_slice::<Value>(body).ok().and_then(|v| v.get("reason").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        match (status, reason.as_str()) {
            (200, _) => Outcome::Sent,
            (410, _) => Outcome::Gone("410".into()),
            (400, "BadDeviceToken") => Outcome::Gone("BadDeviceToken".into()),
            _ => Outcome::Failed(format!("{status} {reason}").trim().to_string()),
        }
    }

    async fn deliver(ctx: Arc<Ctx>, mut conn: Conn, job: Job) {
        let jwt = match ctx.key.token() {
            Ok(t) => t,
            Err(e) => return log_warn(&format!("push failed principal={} device={} why={}", job.principal, crate::meet::kv(&job.device), crate::meet::kv(&e))),
        };
        let expiration = if job.call { 0 } else { pj::now() as i64 + MESSAGE_TTL };
        let req = hyper::Request::builder()
            .method("POST")
            .uri(format!("https://{}/3/device/{}", ctx.ep.authority(job.sandbox), job.token))
            .header("authorization", format!("bearer {jwt}"))
            .header("apns-topic", ctx.topic.as_str())
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("apns-expiration", expiration.to_string())
            .header("apns-collapse-id", job.collapse.as_str())
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(job.payload)));
        let req = match req {
            Ok(r) => r,
            Err(e) => return log_warn(&format!("push failed principal={} why={}", job.principal, crate::meet::kv(&e.to_string()))),
        };
        let work = async {
            conn.ready().await.map_err(|e| e.to_string())?;
            let res = conn.send_request(req).await.map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            let body = res.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
            Ok::<_, String>((status, body))
        };
        let answer = tokio::time::timeout(TIMEOUT, work).await.unwrap_or_else(|_| Err("timed out".to_string()));
        match answer.map(|(status, body)| outcome(status, &body)) {
            Ok(Outcome::Sent) => {}
            Ok(Outcome::Gone(why)) => (ctx.gone)(&job.principal, &job.device, &job.token, &why),
            Ok(Outcome::Failed(why)) => {
                if why.contains("ExpiredProviderToken") || why.contains("InvalidProviderToken") {
                    ctx.key.forget();
                }
                log_warn(&format!("push failed principal={} device={} why={}", job.principal, crate::meet::kv(&job.device), crate::meet::kv(&why)));
            }
            Err(e) => log_warn(&format!("push failed principal={} device={} why={}", job.principal, crate::meet::kv(&job.device), crate::meet::kv(&e))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::apns::{Endpoint, Job, Key, Outcome, Sender};
    use super::*;
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_ASN1_SIGNING, ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING, ECDSA_P384_SHA384_FIXED_SIGNING};
    use serde_json::json;
    use tokio::sync::mpsc::Receiver;

    const TOKEN: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const IPHONE: &str = "bbbbbbbbbbbbbbbb";

    fn who(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), serial: "1A".into(), ..Default::default() }
    }

    fn hub() -> Hub {
        Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()))
    }

    /// A hub with push on, its pushes caught.
    fn hub_on() -> (Hub, Receiver<Job>) {
        let h = hub();
        let (sender, rx) = Sender::capture();
        h.st.lock().pu.sender = Some(sender);
        (h, rx)
    }

    fn session(h: &Hub, w: &Identity) -> String {
        h.hello(w, "", &Obj::new()).unwrap()["session"].as_str().unwrap().to_string()
    }

    fn error<T: std::fmt::Debug>(r: R<T>) -> String {
        let e = r.unwrap_err();
        let code = match &e {
            E::Bad(_) => 400,
            E::Forbidden(_) => 403,
            E::Unavailable(_) => 501,
            _ => 0,
        };
        format!("{code} {}", e.message())
    }

    fn row(v: Value) -> Obj {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn register_and_unregister_follow_the_rules() {
        let h = hub();
        let ben = who("ben@x", IPHONE);
        assert_eq!(error(h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("sandbox")))), "501 push notifications are off on this relay");
        assert_eq!(error(h.push_unregister(&ben)), "501 push notifications are off on this relay");
        let (h, _rx) = hub_on();
        assert_eq!(error(h.push_register(&who("ben@x", ""), Some(&json!(TOKEN)), Some(&json!("sandbox")))), "403 finish setting up this device first");
        assert_eq!(error(h.push_unregister(&who("ben@x", ""))), "403 finish setting up this device first");
        for bad_token in [json!("ab"), json!("g".repeat(64)), json!("a".repeat(201)), json!(1), Value::Null] {
            assert_eq!(error(h.push_register(&ben, Some(&bad_token), Some(&json!("sandbox")))), "400 token must be 64 to 200 hex characters");
        }
        for bad_env in [json!("dev"), json!(""), Value::Null] {
            assert_eq!(error(h.push_register(&ben, Some(&json!(TOKEN)), Some(&bad_env))), "400 env must be sandbox or production");
        }
        let got = h.push_register(&ben, Some(&json!(TOKEN.to_uppercase())), Some(&json!("sandbox"))).unwrap();
        assert_eq!(got.keys().collect::<Vec<_>>(), ["ok", "key"]);
        assert_eq!(pj::b64_strict(got["key"].as_str().unwrap()).unwrap().len(), 32);
        let entry = h.st.lock().push_tokens["ben@x"][IPHONE].clone();
        assert_eq!(entry.as_object().unwrap().keys().collect::<Vec<_>>(), ["token", "env", "ts", "serial"]);
        assert_eq!((&entry["token"], &entry["env"], &entry["serial"]), (&json!(TOKEN), &json!("sandbox"), &json!("1a")));
        // the same person's key every time; the same token on another device moves there
        let other = who("cy@x", "cccccccccccccccc");
        assert_eq!(h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("production"))).unwrap()["key"], got["key"]);
        h.push_register(&other, Some(&json!(TOKEN)), Some(&json!("production"))).unwrap();
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
        assert_eq!(h.push_unregister(&other).unwrap(), row(json!({"ok": true, "removed": true})));
        assert_eq!(h.push_unregister(&other).unwrap(), row(json!({"ok": true, "removed": false})));
        // sandbox tokens off
        h.st.lock().pu.sandbox = false;
        assert_eq!(error(h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("sandbox")))), "400 sandbox push tokens are off on this relay");
        assert!(h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("production"))).is_ok());
    }

    #[test]
    fn hello_says_whether_push_is_on() {
        let h = hub();
        let ann = who("ann@x", "aaaaaaaaaaaaaaaa");
        assert_eq!(h.hello(&ann, "", &Obj::new()).unwrap()["push"], json!(false));
        let (h, _rx) = hub_on();
        assert_eq!(h.hello(&ann, "", &Obj::new()).unwrap()["push"], json!(true));
    }

    /// Ann's direct message to Ben, kept as the relay keeps one, then the push rules.
    fn dm(h: &Hub, id: &str, extra: Value) {
        let mut msg = row(json!({"id": id, "from": "ann@x", "to": "ben@x", "ts": pj::now(), "enc": {}}));
        msg.extend(row(extra));
        let mut st = h.st.lock();
        st.dms.entry(conv("ann@x", "ben@x")).or_default().push(msg.clone());
        st.pu_message(None, Some("ben@x"), &msg);
    }

    fn post(h: &Hub, cid: &str, from: &str, id: &str, extra: Value) {
        let mut msg = row(json!({"id": id, "channel": cid, "from": from, "ts": pj::now(), "text": "x"}));
        msg.extend(row(extra));
        let mut st = h.st.lock();
        st.channel_msgs.entry(cid.to_string()).or_default().push(msg.clone());
        st.pu_message(Some(cid), None, &msg);
    }

    fn sent(rx: &mut Receiver<Job>) -> Vec<Job> {
        let mut out = Vec::new();
        while let Ok(j) = rx.try_recv() {
            out.push(j);
        }
        out
    }

    fn fresh(h: &Hub) {
        h.st.lock().pu.last.clear();
    }

    fn level(h: &Hub, conv_key: &str, level: Value, default: &str) {
        let mut st = h.st.lock();
        st.prefs.insert("ben@x".into(), json!({"rev": 1, "notify": {conv_key: level}, "sections": [], "channel_default": default}));
    }

    #[test]
    fn a_direct_message_pushes_content_free_to_an_offline_iphone_once_per_30_s() {
        let (h, mut rx) = hub_on();
        let (ann, ben, desk) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE), who("ben@x", "dddddddddddddddd"));
        let sa = session(&h, &ann);
        // Ben is online on his desktop: his iPhone still gets the push
        let sd = session(&h, &desk);
        h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("sandbox"))).unwrap();
        dm(&h, "m1", json!({}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        let id = h.st.lock().pu_id("ben@x", "dm:ann@x");
        assert_eq!(id.len(), 32);
        let j = &jobs[0];
        assert_eq!((j.principal.as_str(), j.device.as_str(), j.token.as_str(), j.sandbox, j.call, j.collapse.as_str()), ("ben@x", IPHONE, TOKEN, true, false, id.as_str()));
        let text = String::from_utf8(j.payload.clone()).unwrap();
        assert_eq!(text, format!("{{\"aps\":{{\"alert\":{{\"title\":\"Lucid Meet\",\"body\":\"New message\"}},\"badge\":1,\"sound\":\"default\",\"thread-id\":\"{id}\"}},\"c\":\"{id}\"}}"));
        assert!(!text.contains("ann") && !text.contains("ANN"));
        // the thread-id is the HMAC of the conversation under Ben's key, which register answers
        let key = pj::b64_strict(h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("sandbox"))).unwrap()["key"].as_str().unwrap()).unwrap();
        assert_eq!(crate::codec::hex(&hmac(&key, b"dm:ann@x")[..16]), id);
        // at most one per 30 s for the conversation
        dm(&h, "m2", json!({}));
        assert!(sent(&mut rx).is_empty());
        // a call rings even right after a message push, time-sensitive
        let pair = crate::codec::sha256_hex(b"ann@x|ben@x");
        let room = format!("dm-{}", &pair[..16]);
        h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!(room)), None).unwrap();
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        assert!(jobs[0].call && jobs[0].collapse == id);
        let call: Value = serde_json::from_slice(&jobs[0].payload).unwrap();
        assert_eq!(call["aps"]["alert"]["body"], json!("Incoming call"));
        assert_eq!(call["aps"]["interruption-level"], json!("time-sensitive"));
        assert_eq!(call["aps"]["badge"], json!(2));
        // another room: its own conversation
        h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!("ops")), None).unwrap();
        let jobs = sent(&mut rx);
        assert_eq!(jobs[0].collapse, h.st.lock().pu_id("ben@x", "room:ops"));
        // the iPhone online: nothing
        fresh(&h);
        let si = session(&h, &ben);
        dm(&h, "m3", json!({}));
        assert!(sent(&mut rx).is_empty());
        h.bye(&si, &ben).unwrap();
        // Do not disturb: nothing, calls too
        h.set_status(&sd, &desk, Some(&json!("dnd")), None, None).unwrap();
        dm(&h, "m4", json!({}));
        h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!("ops2")), None).unwrap();
        assert!(sent(&mut rx).is_empty());
        h.set_status(&sd, &desk, Some(&json!("auto")), None, None).unwrap();
        // level off: nothing, calls too; mentions: only a reply to Ben
        level(&h, "dm:ann@x", json!("off"), "all");
        dm(&h, "m5", json!({}));
        h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!(room)), None).unwrap();
        assert!(sent(&mut rx).is_empty());
        level(&h, "dm:ann@x", json!("mentions"), "all");
        dm(&h, "m6", json!({}));
        assert!(sent(&mut rx).is_empty());
        h.st.lock().dms.entry(conv("ann@x", "ben@x")).or_default().push(row(json!({"id": "b1", "from": "ben@x", "to": "ann@x", "ts": pj::now()})));
        dm(&h, "m7", json!({"reply_to": "b1"}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        // the badge counts only senders at level all: Ann is at mentions now
        let p: Value = serde_json::from_slice(&jobs[0].payload).unwrap();
        assert_eq!(p["aps"]["badge"], json!(0));
    }

    #[test]
    fn channel_pushes_follow_the_levels_mentions_and_threads() {
        let (h, mut rx) = hub_on();
        let (ann, ben, cy) = (who("ann@x", "aaaaaaaaaaaaaaaa"), who("ben@x", IPHONE), who("cy@x", "cccccccccccccccc"));
        session(&h, &ann);
        // Ben has used the relay from his desktop (still online there)
        session(&h, &who("ben@x", "dddddddddddddddd"));
        h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("production"))).unwrap();
        h.push_register(&cy, Some(&json!("ab".repeat(32))), Some(&json!("production"))).unwrap();
        {
            let mut st = h.st.lock();
            st.channels.insert("c-01".into(), json!({"id": "c-01", "kind": "public", "name": "general", "members": ["ann@x", "ben@x"]}));
            st.channels.insert("g-01".into(), json!({"id": "g-01", "kind": "group", "name": "", "members": ["ann@x", "ben@x"]}));
        }
        // level all (the default): every main-conversation message; Cy is not a member
        post(&h, "c-01", "ann@x", "r1", json!({}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        assert_eq!((jobs[0].principal.as_str(), jobs[0].sandbox), ("ben@x", false));
        assert_eq!(jobs[0].collapse, h.st.lock().pu_id("ben@x", "channel:c-01"));
        let p: Value = serde_json::from_slice(&jobs[0].payload).unwrap();
        assert_eq!(p["aps"]["badge"], json!(1));
        // a thread reply kept out of the main conversation: only when it answers or mentions Ben
        fresh(&h);
        post(&h, "c-01", "ann@x", "t1", json!({"thread": "r1"}));
        assert!(sent(&mut rx).is_empty());
        post(&h, "c-01", "ben@x", "b1", json!({}));
        sent(&mut rx);
        post(&h, "c-01", "ann@x", "t2", json!({"thread": "b1"}));
        assert_eq!(sent(&mut rx).len(), 1);
        fresh(&h);
        post(&h, "c-01", "ann@x", "t3", json!({"thread": "r1", "also_channel": true}));
        assert_eq!(sent(&mut rx).len(), 1);
        // the channel default at mentions: only a mention or a reply
        fresh(&h);
        level(&h, "dm:nobody@x", json!("all"), "mentions");
        post(&h, "c-01", "ann@x", "m1", json!({}));
        assert!(sent(&mut rx).is_empty());
        post(&h, "c-01", "ann@x", "m2", json!({"mentions": ["ben@x"]}));
        assert_eq!(sent(&mut rx).len(), 1);
        fresh(&h);
        post(&h, "c-01", "ann@x", "m3", json!({"reply_to": {"id": "b1", "name": "BEN", "text": "x"}}));
        let jobs = sent(&mut rx);
        assert_eq!(jobs.len(), 1);
        // at mentions the badge counts the mentions only
        let p: Value = serde_json::from_slice(&jobs[0].payload).unwrap();
        assert_eq!(p["aps"]["badge"], json!(1));
        // a group chat is not a channel: the channel default does not apply
        post(&h, "g-01", "ann@x", "g1", json!({}));
        assert_eq!(sent(&mut rx).len(), 1);
        // a channel's own level off: nothing
        fresh(&h);
        level(&h, "channel:c-01", json!("off"), "all");
        post(&h, "c-01", "ann@x", "o1", json!({"mentions": ["ben@x"]}));
        assert!(sent(&mut rx).is_empty());
        // a call of the channel belongs to it
        level(&h, "dm:nobody@x", json!("all"), "all");
        let sa = session(&h, &ann);
        h.invite(&sa, &ann, Some(&json!("ben@x")), Some(&json!("cv-01")), None).unwrap();
        assert_eq!(sent(&mut rx)[0].collapse, h.st.lock().pu_id("ben@x", "channel:c-01"));
    }

    #[test]
    fn revocation_and_apns_drop_tokens() {
        let (h, _rx) = hub_on();
        let ben = who("ben@x", IPHONE);
        h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("sandbox"))).unwrap();
        // APNs on an older token changes nothing
        h.push_gone("ben@x", IPHONE, &"ab".repeat(32), "410");
        assert!(h.st.lock().push_tokens.contains_key("ben@x"));
        h.push_gone("ben@x", IPHONE, TOKEN, "410");
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
        h.push_register(&ben, Some(&json!(TOKEN)), Some(&json!("sandbox"))).unwrap();
        assert_eq!(h.drop_serials(&["0x2b".to_string()]), 0);
        assert!(h.st.lock().push_tokens.contains_key("ben@x"));
        assert_eq!(h.drop_serials(&["1A".to_string()]), 0);
        assert!(!h.st.lock().push_tokens.contains_key("ben@x"));
    }

    #[test]
    fn stored_tokens_load_when_sound() {
        let h = hub();
        let mut st = h.st.lock();
        let good = json!({"token": TOKEN, "env": "production", "ts": 1, "serial": "1a"});
        let raw = row(json!({"push_tokens": {
            "ben@x": {IPHONE: good, "cccccccccccccccc": {"token": "XY", "env": "production", "ts": 1, "serial": ""}},
            "cy@x": {"cccccccccccccccc": {"token": TOKEN, "env": "dev", "ts": 1, "serial": ""}},
            "dee@x": {"cccccccccccccccc": {"token": TOKEN.to_uppercase(), "env": "sandbox", "ts": 1, "serial": ""}},
        }}));
        st.pu_load(&raw);
        assert_eq!(Value::Object(st.push_tokens.clone()), json!({"ben@x": {IPHONE: good}}));
    }

    #[test]
    fn apns_answers_are_read() {
        assert_eq!(apns::outcome(200, b""), Outcome::Sent);
        assert_eq!(apns::outcome(410, b"{\"reason\":\"Unregistered\"}"), Outcome::Gone("410".into()));
        assert_eq!(apns::outcome(400, b"{\"reason\":\"BadDeviceToken\"}"), Outcome::Gone("BadDeviceToken".into()));
        assert_eq!(apns::outcome(400, b"{\"reason\":\"BadCollapseId\"}"), Outcome::Failed("400 BadCollapseId".into()));
        assert_eq!(apns::outcome(503, b"nope"), Outcome::Failed("503".into()));
    }

    fn p8() -> (String, Vec<u8>) {
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).unwrap();
        let public = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref()).unwrap().public_key().as_ref().to_vec();
        (pem("PRIVATE KEY", pkcs8.as_ref()), public)
    }

    /// Check an ES256 JWT with the public key; its header and claims.
    fn jwt_parts(token: &str, public: &[u8]) -> (Value, Value) {
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let sig = crate::codec::unb64u(parts[2]).unwrap();
        assert_eq!(sig.len(), 64);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, public).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).expect("an ES256 signature");
        let part = |s: &str| serde_json::from_slice::<Value>(&crate::codec::unb64u(s).unwrap()).unwrap();
        (part(parts[0]), part(parts[1]))
    }

    #[test]
    fn the_provider_token_is_es256_and_kept_50_minutes() {
        let (pem_text, public) = p8();
        let key = Key::from_pem("TEAM123456", "KEY1234567", pem_text.as_bytes()).unwrap();
        let t = key.token().unwrap();
        let (header, claims) = jwt_parts(&t, &public);
        assert_eq!(header, json!({"alg": "ES256", "kid": "KEY1234567"}));
        assert_eq!(claims["iss"], json!("TEAM123456"));
        assert!((claims["iat"].as_i64().unwrap() - pj::now() as i64).abs() <= 2);
        assert_eq!(key.token().unwrap(), t);
        assert_eq!(apns::JWT_EVERY, std::time::Duration::from_secs(3000));
        key.forget();
        let again = key.token().unwrap();
        assert_ne!(again, t);
        jwt_parts(&again, &public);
        // what is not a P-256 PKCS#8 key is refused, with words that never show the file
        let p384 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P384_SHA384_FIXED_SIGNING, &SystemRandom::new()).unwrap();
        for wrong in [b"not a key".to_vec(), pem("PRIVATE KEY", p384.as_ref()).into_bytes(), pem("PRIVATE KEY", b"junk").into_bytes()] {
            assert_eq!(Key::from_pem("T", "K", &wrong).err().unwrap(), "key_file is not a P-256 private key");
        }
        assert_eq!(Key::load("T", "K", "/no/such/key.p8").err().unwrap(), "key_file cannot be read");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = std::env::temp_dir().join(format!("push-{}.p8", pj::token_hex(4)));
            std::fs::write(&path, &pem_text).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(Key::load("T", "K", path.to_str().unwrap()).err().unwrap(), "key_file must be readable by the relay only (mode 600)");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(Key::load("T", "K", path.to_str().unwrap()).is_ok());
            let _ = std::fs::remove_file(path);
        }
    }

    fn der(tag: u8, body: &[u8]) -> Vec<u8> {
        let n = body.len();
        let mut out = vec![tag];
        match n {
            0..=0x7f => out.push(n as u8),
            0x80..=0xff => out.extend([0x81, n as u8]),
            _ => out.extend([0x82, (n >> 8) as u8, n as u8]),
        }
        out.extend_from_slice(body);
        out
    }

    fn pem(label: &str, data: &[u8]) -> String {
        let b = pj::b64(data);
        let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
        format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
    }

    /// The fake APNs server's certificate: self-signed P-256 for 127.0.0.1 (an IP SAN), and its key, as PEM.
    fn fake_cert() -> (String, String) {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref()).unwrap();
        let spki = crate::der::p256_spki_der(&crate::der::P256Key::from_sec1(pair.public_key().as_ref()).unwrap());
        let alg = der(0x30, &der(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
        let name = der(0x30, &der(0x31, &der(0x30, &[der(0x06, &[0x55, 0x04, 0x03]), der(0x0c, b"apns.test")].concat())));
        let validity = der(0x30, &[der(0x17, b"250101000000Z"), der(0x17, b"491231235959Z")].concat());
        let san = der(0x30, &[der(0x06, &[0x55, 0x1d, 0x11]), der(0x04, &der(0x30, &der(0x87, &[127, 0, 0, 1])))].concat());
        let extensions = der(0xa3, &der(0x30, &san));
        let tbs = der(0x30, &[der(0xa0, &der(0x02, &[2])), der(0x02, &[1]), alg.clone(), name.clone(), validity, name, spki, extensions].concat());
        let sig = pair.sign(&rng, &tbs).unwrap();
        let cert = der(0x30, &[tbs, alg, der(0x03, &[&[0u8][..], sig.as_ref()].concat())].concat());
        (pem("CERTIFICATE", &cert), pem("PRIVATE KEY", pkcs8.as_ref()))
    }

    type Seen = (String, hyper::HeaderMap, bytes::Bytes);

    /// A fake APNs: HTTP/2 over TLS (ALPN h2), recording every request. A token starting `dead` answers 410, one
    /// starting `bad0` 400 BadDeviceToken, anything else 200.
    async fn fake_apns(cert: &str, key: &str) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Seen>) {
        use http_body_util::{BodyExt, Full};
        use hyper_util::rt::{TokioExecutor, TokioIo};
        let certs = rustls_pemfile::certs(&mut cert.as_bytes()).collect::<Result<Vec<_>, _>>().unwrap();
        let key = rustls_pemfile::private_key(&mut key.as_bytes()).unwrap().unwrap();
        let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(crate::server::provider())).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(certs, key).unwrap();
        cfg.alpn_protocols = vec![b"h2".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Seen>();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (acceptor, tx) = (acceptor.clone(), tx.clone());
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else { return };
                    let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                        let tx = tx.clone();
                        async move {
                            let path = req.uri().path().to_string();
                            let headers = req.headers().clone();
                            let body = req.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                            let token = path.rsplit('/').next().unwrap_or_default().to_string();
                            let _ = tx.send((path, headers, body));
                            let (status, reason) = if token.starts_with("dead") {
                                (410, "Unregistered")
                            } else if token.starts_with("bad0") {
                                (400, "BadDeviceToken")
                            } else {
                                (200, "")
                            };
                            let body = if status == 200 { bytes::Bytes::new() } else { bytes::Bytes::from(format!("{{\"reason\":\"{reason}\"}}")) };
                            Ok::<_, std::convert::Infallible>(hyper::Response::builder().status(status).body(Full::new(body)).unwrap())
                        }
                    });
                    let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(tls), service).await;
                });
            }
        });
        (port, rx)
    }

    #[tokio::test]
    async fn the_sender_speaks_http2_to_apns_and_drops_gone_tokens() {
        let (cert, cert_key) = fake_cert();
        let (port, mut seen) = fake_apns(&cert, &cert_key).await;
        let ca = std::env::temp_dir().join(format!("apns-ca-{}.pem", pj::token_hex(4)));
        std::fs::write(&ca, &cert).unwrap();
        let ep = Endpoint::new(Some(ca.to_str().unwrap()), ("127.0.0.1".into(), port), ("127.0.0.1".into(), port)).unwrap();
        let (pem_text, public) = p8();
        let key = Key::from_pem("TEAM123456", "KEY1234567", pem_text.as_bytes()).unwrap();
        let gone: Arc<parking_lot::Mutex<Vec<(String, String, String, String)>>> = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let heard = gone.clone();
        let on_gone: apns::OnGone = Arc::new(move |p: &str, d: &str, t: &str, why: &str| heard.lock().push((p.into(), d.into(), t.into(), why.into())));
        let sender = Sender::start(key, "com.lucid.meet".into(), ep, on_gone).unwrap();
        let job = |token: &str, call: bool| Job { principal: "ben@x".into(), device: IPHONE.into(), token: token.into(), sandbox: !call, collapse: "c0ffee".into(), call, payload: payload(3, "c0ffee", call) };
        assert!(sender.send(job(TOKEN, false)));
        let (path, headers, body) = tokio::time::timeout(std::time::Duration::from_secs(10), seen.recv()).await.unwrap().unwrap();
        assert_eq!(path, format!("/3/device/{TOKEN}"));
        let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        assert_eq!((h("apns-topic"), h("apns-push-type"), h("apns-priority"), h("apns-collapse-id")), ("com.lucid.meet".into(), "alert".into(), "10".into(), "c0ffee".into()));
        let expires: i64 = h("apns-expiration").parse().unwrap();
        assert!((expires - pj::now() as i64 - 3600).abs() <= 5);
        let bearer = h("authorization");
        let (header, claims) = jwt_parts(bearer.strip_prefix("bearer ").unwrap(), &public);
        assert_eq!((header["kid"].clone(), claims["iss"].clone()), (json!("KEY1234567"), json!("TEAM123456")));
        assert_eq!(body.as_ref(), payload(3, "c0ffee", false).as_slice());
        // a call (to the other host's connection): expiration 0, the same provider token
        assert!(sender.send(job(TOKEN, true)));
        let (_, headers, _) = tokio::time::timeout(std::time::Duration::from_secs(10), seen.recv()).await.unwrap().unwrap();
        assert_eq!(headers.get("apns-expiration").unwrap(), "0");
        assert_eq!(headers.get("authorization").unwrap().to_str().unwrap(), bearer);
        // 410 and 400 BadDeviceToken drop the token; nothing else does
        let dead = format!("dead{}", &TOKEN[4..]);
        let bad = format!("bad0{}", &TOKEN[4..]);
        assert!(sender.send(job(&dead, false)) && sender.send(job(&bad, false)));
        for _ in 0..2 {
            tokio::time::timeout(std::time::Duration::from_secs(10), seen.recv()).await.unwrap().unwrap();
        }
        for _ in 0..100 {
            if gone.lock().len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let mut got = gone.lock().clone();
        got.sort();
        assert_eq!(got, vec![("ben@x".to_string(), IPHONE.to_string(), bad, "BadDeviceToken".to_string()), ("ben@x".to_string(), IPHONE.to_string(), dead, "410".to_string())]);
        assert!(seen.try_recv().is_err());
        let _ = std::fs::remove_file(ca);
    }
}
