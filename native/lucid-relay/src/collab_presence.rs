// P-REMOTE.7 metadata-only presence, rule for rule desktop/collab/relay_presence.ts: an in-memory lifecycle reducer
// per room and a bounded (128 rooms), coalescing, sequential writer that PATCHes one Firestore document per room
// (`remote_sessions/sha256:<hex of the room id>`) with the Cloud Run service identity's token from the metadata
// server. Hooks never block or fail the relay; failures are counted and reported as one aggregate line per drain.

use crate::codec::{iso_time, js_number, now_ms, parse_json, sha256_hex, stringify, utf8_lossy};
use crate::http_client::HttpClient;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

const METADATA_TOKEN_URL: &str = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const FIRESTORE_URL: &str = "https://firestore.googleapis.com";
const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Debug)]
pub struct Principal {
    pub uid: String,
    pub email: String,
    pub admin: bool,
    pub premium: bool,
    pub effective_premium: bool,
}

struct Participant {
    who: Principal,
    joined_at: i64,
    last_seen_at: i64,
    left_at: Option<i64>,
}

#[derive(Clone, Copy, PartialEq)]
enum Status {
    Active,
    Grace,
    Closed,
}

struct Session {
    status: Status,
    host: Principal,
    participants: IndexMap<u32, Participant>,
    created_at: i64,
    last_seen_at: i64,
    closed_at: Option<i64>,
    guest_peak: i64,
    guest_joins: i64,
    heartbeats: i64,
}

struct Pending {
    body: String,
}

struct Inner {
    sessions: HashMap<String, Session>,
    last_activity: HashMap<String, i64>,
    pending: IndexMap<String, Pending>,
    draining: bool,
    token: Option<(String, i64)>,
    failed: u64,
    dropped: u64,
}

pub struct Presence {
    project: String,
    database: String,
    retention_ms: i64,
    max_pending: usize,
    throttle_ms: i64,
    timeout: Duration,
    metadata_url: String,
    firestore_url: String,
    client: HttpClient,
    log: Arc<dyn Fn(&str, Option<Value>) + Send + Sync>,
    inner: Mutex<Inner>,
    wake: Notify,
    idle: Notify,
}

fn ts(ms: i64) -> Value {
    json!({ "timestampValue": iso_time(ms) })
}

fn identity(p: &Principal) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("uid".into(), json!({ "stringValue": p.uid }));
    m.insert("email".into(), json!({ "stringValue": p.email }));
    m.insert("admin".into(), json!({ "booleanValue": p.admin }));
    m.insert("premium".into(), json!({ "booleanValue": p.premium }));
    m.insert("effectivePremium".into(), json!({ "booleanValue": p.effective_premium }));
    m
}

/// serializeSession: the complete allowlisted document body, nothing else.
fn serialize(s: &Session, retention_ms: i64) -> Value {
    let mut participants = Vec::new();
    let mut active = 0;
    for p in s.participants.values() {
        if p.left_at.is_none() {
            active += 1;
        }
        let mut f = identity(&p.who);
        f.insert("role".into(), json!({ "stringValue": "guest" }));
        f.insert("joinedAt".into(), ts(p.joined_at));
        f.insert("lastSeenAt".into(), ts(p.last_seen_at));
        if let Some(l) = p.left_at {
            f.insert("leftAt".into(), ts(l));
        }
        participants.push(json!({ "mapValue": { "fields": f } }));
    }
    let status = match s.status {
        Status::Active => "active",
        Status::Grace => "grace",
        Status::Closed => "closed",
    };
    let mut f = Map::new();
    f.insert("status".into(), json!({ "stringValue": status }));
    f.insert("host".into(), json!({ "mapValue": { "fields": identity(&s.host) } }));
    f.insert("participants".into(), json!({ "arrayValue": { "values": participants } }));
    f.insert("createdAt".into(), ts(s.created_at));
    f.insert("lastSeenAt".into(), ts(s.last_seen_at));
    f.insert("expireAt".into(), ts(s.closed_at.unwrap_or(s.last_seen_at) + retention_ms));
    f.insert("guestActiveCount".into(), json!({ "integerValue": active.to_string() }));
    f.insert("guestPeakCount".into(), json!({ "integerValue": s.guest_peak.to_string() }));
    f.insert("guestJoinCount".into(), json!({ "integerValue": s.guest_joins.to_string() }));
    f.insert("heartbeatCount".into(), json!({ "integerValue": s.heartbeats.to_string() }));
    f.insert("geo".into(), json!({ "mapValue": { "fields": { "status": { "stringValue": "unavailable" } } } }));
    if let Some(c) = s.closed_at {
        f.insert("closedAt".into(), ts(c));
    }
    json!({ "fields": f })
}

/// encodeURIComponent.
fn uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The stable document id; the raw room id never leaves the process.
pub fn hash_room_id(room_id: &str) -> String {
    format!("sha256:{}", sha256_hex(room_id.as_bytes()))
}

impl Presence {
    /// relayPresenceFromEnv: off unless RELAY_TELEMETRY=firestore; Err for a bad setting (telemetry then stays off).
    pub fn from_env(env: &HashMap<String, String>, client: &HttpClient, log: Arc<dyn Fn(&str, Option<Value>) + Send + Sync>) -> Result<Option<Arc<Presence>>, String> {
        let mode = env.get("RELAY_TELEMETRY").map(|m| m.trim().to_lowercase()).unwrap_or_default();
        if mode.is_empty() || mode == "off" {
            return Ok(None);
        }
        if mode != "firestore" {
            return Err("unsupported RELAY_TELEMETRY mode".into());
        }
        let retention = env.get("RELAY_FIRESTORE_RETENTION_DAYS").filter(|v| !v.is_empty()).map_or(30.0, |v| js_number(v));
        let project = env.get("RELAY_FIRESTORE_PROJECT").or_else(|| env.get("RELAY_FIREBASE_PROJECT")).map(|p| p.trim().to_owned()).unwrap_or_default();
        if project.is_empty() {
            return Err("Firestore relay presence requires a project id".into());
        }
        if !retention.is_finite() || retention <= 0.0 {
            return Err("retentionDays must be positive".into());
        }
        let database = env.get("RELAY_FIRESTORE_DATABASE").map(|d| d.trim().to_owned()).filter(|d| !d.is_empty()).unwrap_or_else(|| "(default)".into());
        let trimmed = |k: &str| env.get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let presence = Arc::new(Presence {
            project,
            database,
            retention_ms: (retention * DAY_MS as f64) as i64,
            max_pending: 128,
            throttle_ms: 30_000,
            timeout: Duration::from_millis(5_000),
            metadata_url: trimmed("RELAY_METADATA_TOKEN_URL").unwrap_or_else(|| METADATA_TOKEN_URL.into()),
            firestore_url: trimmed("RELAY_FIRESTORE_URL").unwrap_or_else(|| FIRESTORE_URL.into()).trim_end_matches('/').to_owned(),
            client: client.clone(),
            log,
            inner: Mutex::new(Inner { sessions: HashMap::new(), last_activity: HashMap::new(), pending: IndexMap::new(), draining: false, token: None, failed: 0, dropped: 0 }),
            wake: Notify::new(),
            idle: Notify::new(),
        });
        let worker = presence.clone();
        tokio::spawn(async move { worker.drain_forever().await });
        Ok(Some(presence))
    }

    fn enqueue(&self, inner: &mut Inner, room_id: &str) {
        let Some(s) = inner.sessions.get(room_id) else { return };
        let body = stringify(&serialize(s, self.retention_ms));
        if inner.pending.shift_remove(room_id).is_none() && inner.pending.len() >= self.max_pending {
            inner.pending.shift_remove_index(0);
            inner.dropped += 1;
        }
        inner.pending.insert(room_id.to_owned(), Pending { body });
        self.wake.notify_one();
    }

    pub fn host_started(&self, room_id: &str, host: &Principal) {
        let now = now_ms();
        let mut inner = self.inner.lock();
        let session = Session { status: Status::Active, host: host.clone(), participants: IndexMap::new(), created_at: now, last_seen_at: now, closed_at: None, guest_peak: 0, guest_joins: 0, heartbeats: 0 };
        inner.sessions.insert(room_id.to_owned(), session);
        self.enqueue(&mut inner, room_id);
    }

    pub fn host_reclaimed(&self, room_id: &str, host: &Principal) {
        let now = now_ms();
        let mut inner = self.inner.lock();
        let Some(s) = inner.sessions.get_mut(room_id).filter(|s| s.status != Status::Closed) else { return };
        s.host = host.clone();
        s.status = Status::Active;
        s.last_seen_at = now;
        self.enqueue(&mut inner, room_id);
    }

    pub fn host_grace(&self, room_id: &str) {
        let now = now_ms();
        let mut inner = self.inner.lock();
        let Some(s) = inner.sessions.get_mut(room_id).filter(|s| s.status != Status::Closed) else { return };
        s.status = Status::Grace;
        s.last_seen_at = now;
        self.enqueue(&mut inner, room_id);
    }

    pub fn host_closed(&self, room_id: &str) {
        let now = now_ms();
        let mut inner = self.inner.lock();
        let Some(s) = inner.sessions.get_mut(room_id).filter(|s| s.status != Status::Closed) else { return };
        s.status = Status::Closed;
        s.closed_at = Some(now);
        s.last_seen_at = now;
        for p in s.participants.values_mut().filter(|p| p.left_at.is_none()) {
            p.left_at = Some(now);
            p.last_seen_at = now;
        }
        self.enqueue(&mut inner, room_id);
        inner.sessions.remove(room_id);
        let prefix = format!("{room_id}\u{0}");
        inner.last_activity.retain(|k, _| !k.starts_with(&prefix));
    }

    pub fn guest_joined(&self, room_id: &str, peer: u32, guest: &Principal) {
        let now = now_ms();
        let mut inner = self.inner.lock();
        let Some(s) = inner.sessions.get_mut(room_id).filter(|s| s.status != Status::Closed) else { return };
        s.participants.insert(peer, Participant { who: guest.clone(), joined_at: now, last_seen_at: now, left_at: None });
        s.last_seen_at = now;
        s.guest_joins += 1;
        let active = s.participants.values().filter(|p| p.left_at.is_none()).count() as i64;
        s.guest_peak = s.guest_peak.max(active);
        self.enqueue(&mut inner, room_id);
    }

    pub fn guest_left(&self, room_id: &str, peer: u32) {
        let now = now_ms();
        let mut inner = self.inner.lock();
        let Some(s) = inner.sessions.get_mut(room_id).filter(|s| s.status != Status::Closed) else { return };
        let Some(p) = s.participants.get_mut(&peer).filter(|p| p.left_at.is_none()) else { return };
        p.left_at = Some(now);
        p.last_seen_at = now;
        s.last_seen_at = now;
        self.enqueue(&mut inner, room_id);
    }

    /// `kind`: "heartbeat" or "binary"; at most one write per room, role, peer and kind per throttle window.
    pub fn activity(&self, room_id: &str, role: &str, peer: u32, kind: &str) {
        let now = now_ms();
        let mut inner = self.inner.lock();
        if inner.sessions.get(room_id).is_none_or(|s| s.status == Status::Closed) {
            return;
        }
        let key = format!("{room_id}\u{0}{role}\u{0}{peer}\u{0}{kind}");
        if inner.last_activity.get(&key).is_some_and(|prev| now - prev < self.throttle_ms) {
            return;
        }
        inner.last_activity.insert(key, now);
        let Some(s) = inner.sessions.get_mut(room_id) else { return };
        s.last_seen_at = now;
        if role == "guest" {
            if let Some(p) = s.participants.get_mut(&peer).filter(|p| p.left_at.is_none()) {
                p.last_seen_at = now;
            }
        }
        if kind == "heartbeat" {
            s.heartbeats += 1;
        }
        self.enqueue(&mut inner, room_id);
    }

    /// Wait for the writes already queued (shutdown bounds this to one second).
    pub async fn flush(&self) {
        loop {
            let idle = self.idle.notified();
            {
                let inner = self.inner.lock();
                if !inner.draining && inner.pending.is_empty() {
                    return;
                }
            }
            self.wake.notify_one();
            idle.await;
        }
    }

    async fn access_token(&self) -> Result<String, String> {
        let now = now_ms();
        let cached = self.inner.lock().token.clone();
        if let Some((t, refresh_at)) = cached {
            if now < refresh_at {
                return Ok(t);
            }
        }
        let res = self.client.send("GET", &self.metadata_url, &[("Metadata-Flavor", "Google")], Vec::new(), self.timeout).await?;
        if !res.ok() {
            return Err("metadata token request failed".into());
        }
        let body = parse_json(&utf8_lossy(&res.body)).ok_or("metadata token response invalid")?;
        let token = body.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty()).ok_or("metadata token response invalid")?.to_owned();
        let expires = body.get("expires_in").and_then(Value::as_f64).filter(|e| e.is_finite()).unwrap_or(300.0);
        let refresh_at = now + ((expires - 60.0).max(1.0) * 1000.0) as i64;
        self.inner.lock().token = Some((token.clone(), refresh_at));
        Ok(token)
    }

    async fn write(&self, room_id: &str, body: String) -> Result<(), String> {
        let token = self.access_token().await?;
        let url = format!(
            "{}/v1/projects/{}/databases/{}/documents/remote_sessions/{}",
            self.firestore_url,
            uri_component(&self.project),
            uri_component(&self.database),
            uri_component(&hash_room_id(room_id))
        );
        let auth = format!("Bearer {token}");
        let headers = [("authorization", auth.as_str()), ("content-type", "application/json")];
        let res = self.client.send("PATCH", &url, &headers, body.into_bytes(), self.timeout).await?;
        if res.ok() { Ok(()) } else { Err("Firestore presence write failed".into()) }
    }

    async fn drain_forever(self: Arc<Self>) {
        loop {
            self.wake.notified().await;
            loop {
                let next = {
                    let mut inner = self.inner.lock();
                    match inner.pending.shift_remove_index(0) {
                        Some(n) => {
                            inner.draining = true;
                            Some(n)
                        }
                        None => None,
                    }
                };
                let Some((room_id, write)) = next else { break };
                if self.write(&room_id, write.body).await.is_err() {
                    self.inner.lock().failed += 1;
                }
            }
            let report = {
                let mut inner = self.inner.lock();
                inner.draining = false;
                let r = (inner.failed, inner.dropped);
                inner.failed = 0;
                inner.dropped = 0;
                r
            };
            if report != (0, 0) {
                (self.log)("relay telemetry: write failures", Some(json!({ "failedWrites": report.0, "droppedWrites": report.1 })));
            }
            self.idle.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_hash_and_document_shape() {
        assert_eq!(hash_room_id(""), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(uri_component("sha256:ab"), "sha256%3Aab");
        assert_eq!(uri_component("(default)"), "(default)");
        let who = Principal { uid: "u".into(), email: "e@x.io".into(), admin: true, premium: false, effective_premium: true };
        let mut s = Session { status: Status::Closed, host: who.clone(), participants: IndexMap::new(), created_at: 0, last_seen_at: 5, closed_at: Some(9), guest_peak: 1, guest_joins: 1, heartbeats: 1 };
        s.participants.insert(7, Participant { who, joined_at: 1, last_seen_at: 2, left_at: Some(3) });
        let body = serialize(&s, 30 * DAY_MS);
        let keys: Vec<&String> = body["fields"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["status", "host", "participants", "createdAt", "lastSeenAt", "expireAt", "guestActiveCount", "guestPeakCount", "guestJoinCount", "heartbeatCount", "geo", "closedAt"]);
        assert_eq!(body["fields"]["guestActiveCount"]["integerValue"], "0");
        assert_eq!(body["fields"]["expireAt"]["timestampValue"], iso_time(9 + 30 * DAY_MS));
    }
}
