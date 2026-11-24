// Contract API-1 revision 5 (docs/api/contract-r5-1c.md) 2.8, 4.6, 5.5, 7.6 and 12.1, the console end of the
// connector's own channel: the five routes of the Connector pipeline under `/api/orgs/<org>/v1/connector/` on the front
// door, reached with one of the connector's API app certificates (`fleet_port::Peer::ApiClient`).
//
// - `GET sync?seq=&tseq=&cseq=&wait=` long-polls (polling the console's state each second on its blocking thread, at
//   most `wait` seconds, 0 to 30) while nothing is newer, then answers the pinned map's signed wire only when newer
//   than `seq` (or with the pruned `base`), the relay journal after `tseq`, the connector-relevant (4b) console journal
//   entries after `cseq` (each with `prev_cseq`), the org's pseudonym key, the id keys of the clients that list this
//   connector (5.5: 32 random bytes per org and client, drawn once and sealed in the console's vault as
//   `api-client-key-<org>-<client>`), and whether the connector is under `connector_suspend`; at most 400 KiB (the
//   journal lists are cut to fit, the connector asks again from where it got to).
// - `POST ack` keeps the connector's latest acknowledgment (`<state>/api-connectors/<org>/<k_id>.json`, flushed) and
//   puts the connector into the org's relay set (revision 4 2.3) under its id with `Report { map: [1, 2], features }`,
//   its features only when they include `journal-1c` (r5 3.3: a connector lacking a feature or `journal-1c` closes the
//   gate, `relay-outdated`).
// - `POST audit` stores a batch of the connector's chain (12.1) exactly as the fleet op `api-audit`, with the source the
//   authenticated connector id (an entry naming any other source is refused `bad-chain`).
// - `POST checkpoint-csr` has the console's Meet CA certify the connector's checkpoint key (`IssueFn`), kept for
//   checking its checkpoints and for `v1/audit/keys` (`add_keys`) before the answer.
// - `POST person-stop` (7.6) journals `person_revoke {client, principal}` in the console journal unless an active entry
//   already covers it, so a retry never journals twice.
//
// The pipeline (4.6), in order: the front door's source limiter; the app certificate (chained to the org Meet CA, not
// revoked, within its `app` grace: `fleet_port::classify_chain`) of kind `app`, naming the org, whose principal is in
// `apps` of an `active` `connectors[]` entry of the org's pinned map (else 403 `connector`); that connector under
// `connector_suspend` answers 403 `suspended` on every route but `sync`; the body limits of 2.8; and each decision in
// the console's audit chain before the answer (`api.call` or `api.refusal`, route `<METHOD> /api/orgs/<org>/v1/
// connector/<name>`, resource the connector id), 503 `audit-unavailable` when it cannot be written.

use crate::api_audit::{ApiAudit, IngestError, Repr};
use crate::api_checkpoint::IssueFn;
use crate::api_cjournal::{self, ConsoleEntry};
use crate::api_features::{Report, JOURNAL_1C};
use crate::api_issue::ClientCert;
use crate::api_resource::{self, Reply};
use crate::codec::{b64u, exact_keys, hex, sha256, unb64u};
use crate::console_api::ConsoleApi;
use crate::fleet_ca::{vault_do, VaultLock};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::net::IpAddr;
use std::path::Path;
use std::time::Duration;

/// 2.8: a sync answer is at most this many bytes.
pub const SYNC_MAX: usize = 400 * 1024;
/// 2.8: an acknowledgment is at most 1 MiB.
pub const ACK_MAX: usize = 1024 * 1024;
/// 2.8: an audit batch is at most what the fleet op `api-audit` takes.
pub const AUDIT_MAX: usize = crate::fleet_wire::API_AUDIT_MAX;
/// `checkpoint-csr` and `person-stop` bodies.
pub const SMALL_MAX: usize = 16 * 1024;
/// 2.8: the longest (and default) `wait` of `sync`, and its `wait_s`.
pub const WAIT_MAX_S: u64 = 30;
/// 2.8: the conversations an acknowledgment lists.
pub const CONVERSATIONS_MAX: usize = 5000;
/// 2.8: the folder of the latest acknowledgments, under the console's state folder.
pub const ACKS_DIR: &str = "api-connectors";
/// 2.8 `seal` (revision 6 2.2 `key_store`).
pub const SEALS: [&str; 4] = ["os_store", "tpm", "pkcs11", "azure_key_vault"];
const FEATURES_MAX: usize = 64;
const NAME_MAX: usize = 64;

/// One client id key draw at a time, so two syncs never seal two keys for one client.
static KEY_DRAW: Mutex<()> = Mutex::new(());
/// One person stop at a time, so the check and the journal append are one step.
static STOPS: Mutex<()> = Mutex::new(());

/// The five routes of the Connector pipeline (2.8, 4.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Sync,
    Ack,
    Audit,
    CheckpointCsr,
    PersonStop,
}

impl Route {
    pub const ALL: [Route; 5] = [Route::Sync, Route::Ack, Route::Audit, Route::CheckpointCsr, Route::PersonStop];

    /// The last path segment.
    pub fn name(self) -> &'static str {
        match self {
            Route::Sync => "sync",
            Route::Ack => "ack",
            Route::Audit => "audit",
            Route::CheckpointCsr => "checkpoint-csr",
            Route::PersonStop => "person-stop",
        }
    }

    /// `GET` for `sync`, `POST` for the others.
    pub fn method(self) -> &'static str {
        match self {
            Route::Sync => "GET",
            _ => "POST",
        }
    }

    /// The most body bytes the route reads (2.8); 0 for `sync`, which reads none.
    pub fn body_max(self) -> usize {
        match self {
            Route::Sync => 0,
            Route::Ack => ACK_MAX,
            Route::Audit => AUDIT_MAX,
            Route::CheckpointCsr | Route::PersonStop => SMALL_MAX,
        }
    }

    /// The route as its audit entries name it.
    pub fn audit_route(self, org: &str) -> String {
        format!("{} /api/orgs/{org}/v1/connector/{}", self.method(), self.name())
    }
}

/// The org and route of a request on the front door; None for any other path or method.
pub fn route_of<'a>(method: &str, path: &'a str) -> Option<(&'a str, Route)> {
    let (org, rest) = path.strip_prefix("/api/orgs/")?.split_once('/')?;
    let name = rest.strip_prefix("v1/connector/")?;
    let route = Route::ALL.into_iter().find(|r| r.name() == name && r.method() == method)?;
    crate::api_audit::org_ok(org).then_some((org, route))
}

/// One request of the Connector pipeline, as the front door read it.
pub struct Request<'a> {
    pub org: &'a str,
    pub route: Route,
    pub query: &'a str,
    /// The JSON object body (None for `sync`); Err is why it was not taken (`too-large`, `request`).
    pub body: Option<Result<Value, &'static str>>,
    /// The connection's API client certificate (`Peer::ApiClient`), if any.
    pub cert: Option<&'a ClientCert>,
    pub source: IpAddr,
    /// The audit `rid`, also the answer's `X-Lucid-Request-Id`.
    pub rid: &'a str,
}

/// A refusal before it is audited and answered.
struct No {
    status: u16,
    code: &'static str,
    why: String,
    retry: Option<i64>,
}

fn no(status: u16, code: &'static str, why: impl Into<String>) -> No {
    No { status, code, why: why.into(), retry: None }
}

/// The connector on the connection: its id and the app certificate's principal.
struct Who {
    id: String,
    app: String,
}

/// `c_` and 16 lowercase hex digits.
fn client_id_ok(s: &str) -> bool {
    s.strip_prefix("c_").is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn listed(v: Option<&Value>, s: &str) -> bool {
    v.and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(s)))
}

fn objects<'a>(map: &'a Value, k: &str) -> impl Iterator<Item = &'a Map<String, Value>> {
    map.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object)
}

/// 5.5: the client's id key, 32 random bytes drawn once per (org, client) and sealed in `vault` as
/// `api-client-key-<org>-<client>`. The key never enters a log.
pub fn client_key(vault: &dyn VaultLock, org: &str, client: &str) -> Result<Vec<u8>, String> {
    if !crate::api_audit::org_ok(org) || !client_id_ok(client) {
        return Err("that is not an organization and client id".into());
    }
    let name = format!("api-client-key-{org}-{client}");
    let _one = KEY_DRAW.lock();
    if let Some(k) = vault_do(vault, |v| v.get(&name)).filter(|k| k.len() == 32) {
        return Ok(k);
    }
    let key = crate::console_auth::random(32).ok_or("no random bytes")?;
    vault_do(vault, |v| v.put(&name, &key))?;
    Ok(key)
}

/// 2.8: the latest acknowledgment a connector sent for the org (`{connector, at, ack}`), as kept under `state_dir`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn latest_ack(state_dir: &Path, org: &str, connector: &str) -> Option<Value> {
    if !crate::api_audit::org_ok(org) || !crate::connector::connector_id_ok(connector) {
        return None;
    }
    crate::codec::parse_json(&std::fs::read_to_string(state_dir.join(ACKS_DIR).join(org).join(format!("{connector}.json"))).ok()?)
}

/// The parameters of `sync` (each a whole number; `wait` 0 to 30, default 30).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SyncQuery {
    seq: i64,
    tseq: u64,
    cseq: u64,
    wait: u64,
}

fn sync_query(query: &str) -> Option<SyncQuery> {
    let mut q = SyncQuery { seq: 0, tseq: 0, cseq: 0, wait: WAIT_MAX_S };
    for part in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = part.split_once('=')?;
        if v.is_empty() || v.len() > 16 || !v.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n: u64 = v.parse().ok()?;
        match k {
            "seq" => q.seq = i64::try_from(n).ok()?,
            "tseq" => q.tseq = n,
            "cseq" => q.cseq = n,
            "wait" if n <= WAIT_MAX_S => q.wait = n,
            _ => return None,
        }
    }
    Some(q)
}

fn json_len(v: &Value) -> usize {
    serde_json::to_vec(v).map_or(usize::MAX, |b| b.len())
}

/// The longest prefix of `list` that keeps `size` (with a separator per entry) within `SYNC_MAX`.
fn take_fitting(list: Vec<Value>, size: &mut usize) -> Vec<Value> {
    let mut kept = Vec::new();
    for e in list {
        let n = json_len(&e).saturating_add(1);
        if size.saturating_add(n) > SYNC_MAX {
            break;
        }
        *size += n;
        kept.push(e);
    }
    kept
}

/// 2.8: the journal lists of a sync answer cut to keep the whole answer within 400 KiB (the relay journal first, then
/// the console journal, each a prefix in order, so the connector asks again from where it got to).
fn fit(out: &mut Value, journal: Vec<Value>, console: Vec<Value>) -> Result<(), No> {
    out["journal"] = json!([]);
    out["console_journal"] = json!([]);
    let mut size = json_len(out);
    if size > SYNC_MAX {
        return Err(no(503, "unavailable", "The sync answer does not fit 400 KiB; try again later."));
    }
    out["journal"] = Value::Array(take_fitting(journal, &mut size));
    out["console_journal"] = Value::Array(take_fitting(console, &mut size));
    Ok(())
}

/// 2.8 ack `conversations[]`: `{cid, app, kind: channel | group, name, since}` (`name` empty while the relay's name is
/// not known yet).
fn conversation_ok(c: &Value) -> bool {
    const KEYS: [&str; 5] = ["cid", "app", "kind", "name", "since"];
    let Some(o) = c.as_object().filter(|o| exact_keys(o, &KEYS, &KEYS)) else { return false };
    let text = |k: &str, min: usize| o[k].as_str().is_some_and(|s| (min..=256).contains(&s.len()));
    text("cid", 1) && text("app", 1) && matches!(o["kind"].as_str(), Some("channel" | "group")) && text("name", 0) && o["since"].as_i64().is_some()
}

/// The Connector pipeline over the console's api state.
pub struct Door<'a> {
    pub api: &'a ConsoleApi,
    /// The front door's source limiter (6.5); Err is the seconds to wait.
    pub source_ok: &'a dyn Fn(IpAddr, i64) -> Result<(), i64>,
}

impl Door<'_> {
    /// One request at `now_ms`, blocking (`sync` long-polls up to its `wait`; audit appends and journal writes fsync):
    /// the answer once its decision is in the org's audit chain; None for an org the console holds no map for (the
    /// caller answers 404 `not-found` as for any unrouted path).
    pub fn answer(&self, req: &Request, now_ms: i64) -> Option<Reply> {
        let now = now_ms.div_euclid(1000);
        let (map, seq, _) = self.api.pinned(req.org);
        if seq == 0 {
            return None;
        }
        let Some((audit, issue)) = self.api.audit_parts() else { return Some(api_resource::audit_unavailable()) };
        if let Err(s) = (self.source_ok)(req.source, now) {
            let n = No { retry: Some(s.max(1)), ..no(429, "abuse", "Too many requests from this address; try again later.") };
            return Some(self.refuse(&audit, req, None, n, now));
        }
        let who = match who(req, map.as_ref()) {
            Ok(w) => w,
            Err(n) => return Some(self.refuse(&audit, req, None, n, now)),
        };
        if req.route != Route::Sync && api_cjournal::connector_suspended(&self.api.console_active(req.org), &who.id) {
            return Some(self.refuse(&audit, req, Some(&who), no(403, "suspended", "This connector is suspended."), now));
        }
        let body = match (&req.body, req.route) {
            (_, Route::Sync) => None,
            (Some(Ok(Value::Object(o))), _) if o.get("org").and_then(Value::as_str) == Some(req.org) => Some(o),
            (Some(Err(code)), _) if *code == "too-large" => {
                let n = no(413, "too-large", format!("The body is larger than {} bytes.", req.route.body_max()));
                return Some(self.refuse(&audit, req, Some(&who), n, now));
            }
            _ => return Some(self.refuse(&audit, req, Some(&who), no(400, "request", "The body must be a JSON object naming this organization."), now)),
        };
        let out = match (req.route, body) {
            (Route::Sync, _) => self.sync(req, &who),
            (Route::Ack, Some(o)) => self.ack(req.org, &who, o, now),
            (Route::Audit, Some(o)) => audit_in(&audit, req.org, &who, o),
            (Route::CheckpointCsr, Some(o)) => checkpoint_csr(&audit, &issue, req.org, &who, o, now_ms),
            (Route::PersonStop, Some(o)) => self.person_stop(req.org, &who, map.as_ref(), o, now),
            (_, None) => Err(no(400, "request", "The body must be a JSON object naming this organization.")),
        };
        Some(match out {
            Ok(v) => allowed(&audit, req, &who, v, now),
            Err(n) => self.refuse(&audit, req, Some(&who), n, now),
        })
    }

    /// 9.4: the refusal into the org's refusal summaries (key: the connector once identified, else the source
    /// address), then its problem answer; 503 `audit-unavailable` when it cannot be recorded.
    fn refuse(&self, audit: &ApiAudit, req: &Request, who: Option<&Who>, n: No, now: i64) -> Reply {
        let route = req.route.audit_route(req.org);
        let mut e = entry(req, "api.refusal", who);
        e.insert("result".into(), json!("refused"));
        e.insert("check".into(), json!(n.code));
        e.insert("status".into(), json!(n.status));
        e.insert("count".into(), json!(1));
        let key = who.map_or_else(|| format!("ip:{}", crate::console_source::source_key(req.source)), |w| w.id.clone());
        if audit.refusal(req.org, &key, n.code, &route, Value::Object(e), now).is_err() {
            return api_resource::audit_unavailable();
        }
        let mut r = api_resource::problem(n.status, n.code, &n.why);
        if let Some(s) = n.retry {
            r.headers.push(("Retry-After", s.to_string()));
        }
        r
    }

    /// `GET sync`: held while nothing is newer than the connector's heads (each second the console's state is read
    /// again), up to `wait`.
    fn sync(&self, req: &Request, who: &Who) -> Result<Value, No> {
        let q = sync_query(req.query).ok_or_else(|| no(400, "request", "seq, tseq, cseq and wait are whole numbers; wait is 0 to 30."))?;
        let deadline = crate::codec::now_ms().saturating_add((q.wait * 1000) as i64);
        let (map, base, journal, console) = loop {
            let (map, base, journal) = self.api.connector_plan(req.org, q.seq, q.tseq);
            let console = self.api.connector_entries(req.org, q.cseq);
            let t = crate::codec::now_ms();
            if map.is_some() || !journal.is_empty() || !console.is_empty() || t >= deadline {
                break (map, base, journal, console);
            }
            std::thread::sleep(Duration::from_millis((deadline - t).clamp(1, 1000) as u64));
        };
        let now = crate::codec::now_ms().div_euclid(1000);
        let (pkv, key, not_before) = self.api.pseudonym_key(req.org, now).map_err(|_| no(503, "unavailable", "The organization's pseudonym key is not available; try again later."))?;
        let pinned = self.api.pinned(req.org).0;
        let client_keys = self.client_keys(req.org, &who.id, pinned.as_ref())?;
        let suspended = api_cjournal::connector_suspended(&self.api.console_active(req.org), &who.id);
        let mut out = json!({
            "org": req.org,
            "pseudonym": {"pkv": pkv, "key": b64u(&key), "not_before": not_before},
            "client_keys": client_keys,
            "connector": {"id": who.id, "suspended": suspended},
            "now": now,
            "wait_s": WAIT_MAX_S,
        });
        if let Some(m) = map {
            out["map"] = m;
            if let Some(b) = base {
                out["base"] = json!(b);
            }
        }
        fit(&mut out, journal, console.iter().map(ConsoleEntry::to_value).collect())?;
        Ok(out)
    }

    /// 5.5: the id key of every client of the pinned map that lists this connector, and of no other.
    fn client_keys(&self, org: &str, connector: &str, map: Option<&Value>) -> Result<Vec<Value>, No> {
        let vault = self.api.vault();
        let mut out = Vec::new();
        for c in map.into_iter().flat_map(|m| objects(m, "clients")).filter(|c| listed(c.get("connectors"), connector)) {
            let Some(id) = c.get("id").and_then(Value::as_str).filter(|i| client_id_ok(i)) else { continue };
            let key = client_key(&*vault, org, id).map_err(|_| no(503, "unavailable", "A client id key is not available; try again later."))?;
            out.push(json!({"client": id, "kid": &hex(&sha256(&key))[..16], "key": b64u(&key)}));
        }
        Ok(out)
    }

    /// `POST ack`: kept on disk, then the connector's report in the org's relay set.
    fn ack(&self, org: &str, who: &Who, o: &Map<String, Value>, now: i64) -> Result<Value, No> {
        const KEYS: [&str; 8] = ["org", "seq", "tseq", "cseq", "conversations", "metrics", "features", "seal"];
        let bad = |why: &str| no(400, "request", why);
        if !exact_keys(o, &KEYS, &KEYS) {
            return Err(bad("An acknowledgment is {org, seq, tseq, cseq, conversations, metrics, features, seal}."));
        }
        if o["seq"].as_i64().is_none_or(|s| s < 0) || o["tseq"].as_u64().is_none() || o["cseq"].as_u64().is_none() {
            return Err(bad("seq, tseq and cseq are whole numbers."));
        }
        if !o["conversations"].as_array().is_some_and(|a| a.len() <= CONVERSATIONS_MAX && a.iter().all(conversation_ok)) {
            return Err(bad("conversations lists 0 to 5000 {cid, app, kind, name, since}."));
        }
        // r5 13.1: only the families a connector reports, numbers only, a few series each
        if let Err(why) = crate::api_catalog::counters::check_connector_metrics(&o["metrics"]) {
            return Err(bad(why.as_str()));
        }
        let features: Vec<String> = o["features"]
            .as_array()
            .filter(|a| a.len() <= FEATURES_MAX)
            .and_then(|a| a.iter().map(|f| f.as_str().filter(|s| (1..=NAME_MAX).contains(&s.len())).map(str::to_string)).collect::<Option<Vec<String>>>())
            .ok_or_else(|| bad("features lists up to 64 feature names."))?;
        if !o["seal"].as_str().is_some_and(|s| SEALS.contains(&s)) {
            return Err(bad("seal is os_store, tpm, pkcs11 or azure_key_vault."));
        }
        if let Some(dir) = self.api.state_dir() {
            let folder = dir.join(ACKS_DIR).join(org);
            let kept = json!({"connector": who.id, "at": now, "ack": o});
            crate::store::make_dir(&folder)
                .map_err(|e| e.to_string())
                .and_then(|_| crate::fleet_local::write_durable(&folder.join(format!("{}.json", who.id)), serde_json::to_string(&kept).unwrap_or_default().as_bytes()))
                .map_err(|_| no(503, "unavailable", "The acknowledgment could not be kept; try again later."))?;
        }
        // r5 3.3: a connector without `journal-1c` reports no feature, which closes every gate a feature opens
        let features = if features.iter().any(|f| f == JOURNAL_1C) { features } else { Vec::new() };
        let report = Report { map: vec![1, 2], features, archive_orgs: Vec::new(), at: now };
        self.api.connector_reported(org, &who.id, report).map_err(|_| no(503, "unavailable", "The organization's relay set could not be kept; try again later."))?;
        // r5 13.1: the ack's metrics are this connector's series from now on, and its sync age counts from now
        crate::api_catalog::counters::connector_report(org, &who.id, &o["metrics"], now);
        Ok(json!({"ok": true}))
    }

    /// `POST person-stop` (7.6): Ok once the console journal holds an active `person_revoke` covering the pair.
    fn person_stop(&self, org: &str, who: &Who, map: Option<&Value>, o: &Map<String, Value>, now: i64) -> Result<Value, No> {
        const KEYS: [&str; 4] = ["org", "client", "principal", "mid"];
        let bad = |why: &str| no(400, "request", why);
        if !exact_keys(o, &KEYS, &KEYS) {
            return Err(bad("A stop is {org, client, principal, mid}."));
        }
        let client = o["client"].as_str().filter(|c| client_id_ok(c)).ok_or_else(|| bad("client is a client id."))?;
        let principal = o["principal"].as_str().filter(|p| crate::api_map::person_ok(p)).ok_or_else(|| bad("principal is a person's principal."))?;
        if !o["mid"].as_str().is_some_and(|m| (1..=128).contains(&m.len())) {
            return Err(bad("mid is the stop message's id."));
        }
        let serves = map.into_iter().flat_map(|m| objects(m, "clients")).any(|c| c.get("id").and_then(Value::as_str) == Some(client) && listed(c.get("connectors"), &who.id));
        if !serves {
            return Err(no(403, "client", "That client does not use this connector."));
        }
        let _one = STOPS.lock();
        let covering = self.api.console_active(org).into_iter().find(|e| e.action == "person_revoke" && e.field("principal") == principal && (e.field("client") == client || e.field("client") == "*"));
        if let Some(e) = covering {
            return Ok(json!({"ok": true, "cseq": e.cseq}));
        }
        let e = self.api.append_console(org, "person_revoke", json!({"client": client, "principal": principal}), now).map_err(|e| match e.code {
            "not-tightening" => bad("That stop cannot be journaled."),
            _ => no(503, "unavailable", "The stop could not be journaled; try again later."),
        })?;
        Ok(json!({"ok": true, "cseq": e["cseq"].clone()}))
    }
}

/// The connector a request's certificate belongs to: an app certificate verified by the TLS layer, naming the org,
/// whose principal is in `apps` of an `active` `connectors[]` entry of the pinned map.
fn who(req: &Request, map: Option<&Value>) -> Result<Who, No> {
    let refused = || no(403, "connector", "This certificate is not an API app certificate of an active connector of this organization.");
    let cert = req.cert.filter(|c| c.chain_ok && c.kind == "app" && !c.principal.is_empty() && c.orgs.iter().any(|o| o == req.org)).ok_or_else(refused)?;
    let app = cert.principal.to_lowercase();
    let entry = map
        .into_iter()
        .flat_map(|m| objects(m, "connectors"))
        .find(|k| k.get("state").and_then(Value::as_str) == Some("active") && k.get("apps").and_then(Value::as_array).is_some_and(|a| a.iter().any(|p| p.as_str().is_some_and(|p| p.eq_ignore_ascii_case(&app)))))
        .ok_or_else(refused)?;
    let id = entry.get("id").and_then(Value::as_str).filter(|i| crate::connector::connector_id_ok(i)).ok_or_else(refused)?;
    Ok(Who { id: id.to_string(), app })
}

/// The fields every entry of a request carries.
fn entry(req: &Request, action: &str, who: Option<&Who>) -> Map<String, Value> {
    let mut e = Map::new();
    e.insert("rid".into(), json!(req.rid));
    e.insert("action".into(), json!(action));
    e.insert("route".into(), json!(req.route.audit_route(req.org)));
    e.insert("ip".into(), json!(crate::console_source::canonical(req.source).to_string()));
    if let Some(w) = who {
        e.insert("resource".into(), json!(w.id));
        e.insert("connector".into(), json!(w.id));
        e.insert("app".into(), json!(w.app));
    }
    e
}

/// 9.4: the allowed call (with the bytes it releases) is appended before the answer leaves; 503 otherwise.
fn allowed(audit: &ApiAudit, req: &Request, who: &Who, body: Value, now: i64) -> Reply {
    if !audit.allowed_ok() {
        return api_resource::audit_unavailable();
    }
    let text = serde_json::to_string(&body).unwrap_or_default();
    let mut e = entry(req, "api.call", Some(who));
    e.insert("result".into(), json!("ok"));
    e.insert("check".into(), json!("none"));
    e.insert("status".into(), json!(200));
    e.insert("bytes_out".into(), json!(text.len()));
    e.insert("count".into(), json!(1));
    if let Some(code) = body.get("code").and_then(Value::as_str) {
        e.insert("code".into(), json!(code));
    }
    if audit.record(req.org, Value::Object(e), now).is_err() {
        return api_resource::audit_unavailable();
    }
    let mut r = Reply::json(200, body);
    r.text = Some(text);
    r
}

/// `POST audit` (12.1): the fleet op `api-audit`'s body and answers, the source being the authenticated connector.
fn audit_in(audit: &ApiAudit, org: &str, who: &Who, o: &Map<String, Value>) -> Result<Value, No> {
    const KEYS: [&str; 5] = ["org", "repr", "first", "last", "entries"];
    let bad = |why: &str| no(400, "bad-chain", why);
    if !exact_keys(o, &KEYS, &KEYS) {
        return Err(bad("An audit batch is {org, repr, first, last, entries}."));
    }
    let repr = o["repr"].as_str().and_then(Repr::of).ok_or_else(|| bad("repr must be as_is, pseudonymized or removed"))?;
    let first = o["first"].as_u64().filter(|f| *f >= 1).ok_or_else(|| bad("first must be a seq from 1"))?;
    let last = o["last"].as_u64().filter(|l| *l >= first).ok_or_else(|| bad("last must be a seq from first"))?;
    let entries = o["entries"].as_array().ok_or_else(|| bad("entries must be a list"))?;
    if entries.len() as u64 != last - first + 1 {
        return Err(bad("entries must hold first to last"));
    }
    match audit.ingest(org, &who.id, repr, first, last, entries) {
        Ok(()) => Ok(json!({"ok": true, "last": audit.head(org, &who.id, repr).0})),
        Err(IngestError::Gap(expected)) => Ok(json!({"ok": false, "code": "gap", "expected": expected})),
        Err(IngestError::Invalid(why)) => Err(bad(why.as_str())),
        Err(IngestError::Unavailable(why)) => Err(no(503, "audit-unavailable", why)),
    }
}

/// `POST checkpoint-csr` (12.1, 9.3): the console's Meet CA certifies the connector's checkpoint key; the certificate
/// is stored for the connector's chains (`add_keys`) before it is answered.
fn checkpoint_csr(audit: &ApiAudit, issue: &IssueFn, org: &str, who: &Who, o: &Map<String, Value>, now_ms: i64) -> Result<Value, No> {
    const KEYS: [&str; 2] = ["org", "csr"];
    let bad = || no(400, "request", "csr must be a P-256 certificate request (base64url DER).");
    if !exact_keys(o, &KEYS, &KEYS) {
        return Err(bad());
    }
    let csr = o["csr"].as_str().and_then(unb64u).filter(|d| crate::fleet_x509::read_request(d).is_some()).ok_or_else(bad)?;
    let (cert, chain) = issue(&who.id, org, &csr, now_ms).map_err(|_| no(503, "unavailable", "The console could not issue the checkpoint certificate; try again later."))?;
    audit.add_keys(org, &who.id, &cert, &chain).map_err(|e| no(503, "audit-unavailable", e.message))?;
    Ok(json!({"cert": b64u(&cert), "chain": chain.iter().map(|c| b64u(c)).collect::<Vec<_>>()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_audit::{CheckpointSigner, PseudonymKeys};
    use crate::api_map::{api_map_hash, VerifiedApiMap};
    use crate::fleet_ca::{tests_dir, MemVault};
    use crate::log::Logger;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// An org no other test uses: `person_revoke` entries are published process-wide (`api_delegated::publish_revokes`).
    const ORG: &str = "kacme";
    const K: &str = "k_7a1b2c3d4e5f6a7b";
    const K2: &str = "k_00000000000000c2";
    const K3: &str = "k_00000000000000c3";
    const APP: &str = "helpdesk-api@apps.acme.example";
    const APP2: &str = "other-api@apps.acme.example";
    const APP3: &str = "parked-api@apps.acme.example";
    const C1: &str = "c_0b1c2d3e4f5a6b7c";
    const C2: &str = "c_00000000000000c2";
    const ANN: &str = "ann@acme.example";
    const BOB: &str = "bob@acme.example";
    const IP: [u8; 4] = [10, 40, 0, 7];

    struct NoSigner;

    impl CheckpointSigner for NoSigner {
        fn kid(&self, _: &str) -> Option<String> {
            None
        }
        fn sign(&self, _: &str, _: &[u8]) -> Option<Vec<u8>> {
            None
        }
        fn certs(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct NoKey;

    impl PseudonymKeys for NoKey {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            None
        }
    }

    type TestVault = Arc<Mutex<MemVault>>;

    fn now_s() -> i64 {
        crate::codec::now_ms().div_euclid(1000)
    }

    /// The org's map: K serves APP (active), K2 serves APP2 (active), K3 serves APP3 (suspended); C1 lists K, C2 lists
    /// K2.
    fn map(seq: i64) -> VerifiedApiMap {
        let now = now_s();
        let connector = |id: &str, name: &str, app: &str, state: &str| {
            json!({"id": id, "name": name, "origin": format!("https://{name}.acme.example:9445"), "apps": [app], "networks": [], "stale_s": 60, "state": state})
        };
        let client = |id: &str, k: &str, app: &str| json!({"id": id, "kind": "app", "reach": "R1", "scopes": ["content.read"], "connectors": [k], "apps": [app], "channels": ["*"], "state": "active"});
        let m = json!({"v": 1, "org": ORG, "seq": seq, "issued": now - 10, "expires": now + 30 * 86_400,
                       "issuer": {"url": "https://console.acme.example:7443/api/orgs/kacme", "jwks": []},
                       "grace": {"person": 0, "app": 24, "connector": 0, "relay": 0}, "failover_after_s": 300, "folded": [], "cleared": [],
                       "connectors": [connector(K, "helpdesk", APP, "active"), connector(K2, "other", APP2, "active"), connector(K3, "parked", APP3, "suspended")],
                       "clients": [client(C1, K, APP), client(C2, K2, APP2)], "destinations": []});
        let wire = json!({"map": m, "sig": "", "chain": []});
        VerifiedApiMap { org: ORG.into(), seq, expires: now + 30 * 86_400, hash: api_map_hash(&wire["map"]), signer: "root".into(), wire: wire.as_object().unwrap().clone() }
    }

    struct World {
        dir: PathBuf,
        api: Arc<ConsoleApi>,
        audit: Arc<ApiAudit>,
    }

    /// A console holding `map(1)`, its audit chains (no checkpoint key of its own) and a Meet CA that issues checkpoint
    /// certificates.
    fn world(name: &str) -> World {
        let dir = tests_dir(name);
        let vault: TestVault = Arc::new(Mutex::new(MemVault::default()));
        let logger = Arc::new(Logger::capture("console", Box::new(|_: &str, _: crate::log::Level| {})));
        let api = Arc::new(ConsoleApi::open(Some(&dir), logger, vault.clone() as Arc<dyn VaultLock>));
        let ca = Arc::new(Mutex::new(crate::meet_ca::test_ca(&dir.join("meet"), &mut *vault.lock(), None, crate::codec::now_ms())));
        let (c, v) = (ca, vault);
        let issue: IssueFn = Arc::new(move |holder: &str, org: &str, csr: &[u8], t: i64| {
            let v = v.lock();
            let mut ca = c.lock();
            let issued = ca.issue_checkpoint(&*v, holder, org, csr, t).map_err(|e| e.message)?;
            Ok((issued.der, vec![ca.ca_der().to_vec()]))
        });
        let audit = Arc::new(ApiAudit::open(Some(&dir), "console", Arc::new(NoSigner), Arc::new(NoKey), now_s()));
        api.set_audit(audit.clone(), issue);
        api.publish_verified(None, map(1), now_s()).unwrap();
        World { dir, api, audit }
    }

    fn cert(principal: &str, org: &str) -> ClientCert {
        ClientCert {
            sha256_b64u: b64u(&sha256(principal.as_bytes())),
            serial: "1a2b".into(),
            spki_sha256: "00".repeat(32),
            not_after: now_s() + 86_400,
            chain_ok: true,
            kind: "app".into(),
            principal: principal.into(),
            orgs: vec![org.into()],
        }
    }

    fn call(w: &World, route: Route, query: &str, body: Option<Value>, cert: Option<&ClientCert>) -> Reply {
        let open = |_: IpAddr, _: i64| -> Result<(), i64> { Ok(()) };
        let door = Door { api: &w.api, source_ok: &open };
        let rid = api_resource::rid();
        let req = Request { org: ORG, route, query, body: body.map(Ok), cert, source: IpAddr::from(IP), rid: &rid };
        door.answer(&req, crate::codec::now_ms()).expect("a known org")
    }

    fn sync(w: &World, query: &str, principal: &str) -> Reply {
        call(w, Route::Sync, query, None, Some(&cert(principal, ORG)))
    }

    fn post(w: &World, route: Route, body: Value) -> Reply {
        call(w, route, "", Some(body), Some(&cert(APP, ORG)))
    }

    fn code(r: &Reply) -> (u16, String) {
        (r.status, r.body["code"].as_str().unwrap_or("ok").to_string())
    }

    fn chain(w: &World, action: &str) -> Vec<Value> {
        w.audit.read(ORG, "console", Repr::AsIs, 0, 1000).unwrap()["entries"].as_array().unwrap().iter().filter(|e| e["action"] == action).cloned().collect()
    }

    fn ack(features: &[&str]) -> Value {
        json!({"org": ORG, "seq": 1, "tseq": 0, "cseq": 0, "conversations": [{"cid": "ch:0123456789abcdef", "app": APP, "kind": "channel", "name": "Support", "since": 1_795_000_000}],
               "metrics": {}, "features": features, "seal": "tpm"})
    }

    #[test]
    fn the_five_routes_are_matched_by_method_and_path() {
        assert_eq!(route_of("GET", "/api/orgs/acme/v1/connector/sync"), Some(("acme", Route::Sync)));
        assert_eq!(route_of("POST", "/api/orgs/acme/v1/connector/checkpoint-csr"), Some(("acme", Route::CheckpointCsr)));
        assert_eq!(route_of("POST", "/api/orgs/acme/v1/connector/person-stop"), Some(("acme", Route::PersonStop)));
        assert_eq!(route_of("POST", "/api/orgs/acme/v1/connector/sync"), None);
        assert_eq!(route_of("GET", "/api/orgs/acme/v1/connector/ack"), None);
        assert_eq!(route_of("POST", "/api/orgs/acme/v1/connector/nope"), None);
        assert_eq!(route_of("POST", "/api/orgs/ACME/v1/connector/ack"), None);
        assert_eq!(Route::Ack.audit_route("acme"), "POST /api/orgs/acme/v1/connector/ack");
        assert_eq!((Route::Sync.body_max(), Route::Ack.body_max(), Route::Audit.body_max()), (0, ACK_MAX, AUDIT_MAX));
        assert_eq!(sync_query(""), Some(SyncQuery { seq: 0, tseq: 0, cseq: 0, wait: 30 }));
        assert_eq!(sync_query("seq=3&tseq=4&cseq=5&wait=0"), Some(SyncQuery { seq: 3, tseq: 4, cseq: 5, wait: 0 }));
        for bad in ["wait=31", "seq=-1", "tseq=x", "other=1", "seq"] {
            assert_eq!(sync_query(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_org_without_a_map_is_not_answered() {
        let w = world("console-connector-unknown");
        let open = |_: IpAddr, _: i64| -> Result<(), i64> { Ok(()) };
        let door = Door { api: &w.api, source_ok: &open };
        let c = cert(APP, "beta");
        let req = Request { org: "beta", route: Route::Sync, query: "wait=0", body: None, cert: Some(&c), source: IpAddr::from(IP), rid: "AAAAAAAAAAAAAAAAAAAAAA" };
        assert!(door.answer(&req, crate::codec::now_ms()).is_none());
    }

    #[test]
    fn sync_holds_the_map_only_when_newer_the_journals_after_their_heads_and_its_clients_keys() {
        let w = world("console-connector-sync");
        let now = now_s();
        w.api.append(None, ORG, "client_suspend", json!(C1), None, now).unwrap();
        w.api.append(None, ORG, "client_suspend", json!(C2), None, now).unwrap();
        w.api.append_console(ORG, "connector_limit", json!({"connector": K, "networks": ["10.40.0.0/16"]}), now).unwrap();
        w.api.append_console(ORG, "idp_suspend", json!("okta"), now).unwrap();
        w.api.append_console(ORG, "client_confirm", json!({"client": C1, "scope": "content.post"}), now).unwrap();
        let r = sync(&w, "seq=0&tseq=0&cseq=0&wait=0", APP);
        assert_eq!(r.status, 200, "{}", r.body);
        assert!(r.bytes().len() <= SYNC_MAX);
        let b = &r.body;
        assert_eq!(b["org"], ORG);
        assert_eq!(b["map"]["map"]["seq"], 1);
        assert!(b.get("base").is_none());
        let tseqs: Vec<u64> = b["journal"].as_array().unwrap().iter().map(|e| e["tseq"].as_u64().unwrap()).collect();
        assert_eq!(tseqs, [1, 2]);
        // only the 4b entries, each naming the previous 4b cseq
        let cj: Vec<(u64, u64)> = b["console_journal"].as_array().unwrap().iter().map(|e| (e["cseq"].as_u64().unwrap(), e["prev_cseq"].as_u64().unwrap())).collect();
        assert_eq!(cj, [(1, 0), (3, 1)]);
        assert_eq!(b["connector"], json!({"id": K, "suspended": false}));
        assert_eq!(b["wait_s"], 30);
        assert_eq!(unb64u(b["pseudonym"]["key"].as_str().unwrap()).map(|k| k.len()), Some(32));
        // the key of C1 only (C2 lists another connector), the same at every sync
        let keys = b["client_keys"].as_array().unwrap().clone();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0]["client"], C1);
        let key = unb64u(keys[0]["key"].as_str().unwrap()).unwrap();
        assert_eq!((key.len(), keys[0]["kid"].as_str()), (32, Some(&hex(&sha256(&key))[..16])));
        // at its heads: no map, and only what came after them
        let r = sync(&w, "seq=1&tseq=1&cseq=1&wait=0", APP);
        assert_eq!(r.status, 200, "{}", r.body);
        assert!(r.body.get("map").is_none());
        assert_eq!(r.body["journal"].as_array().unwrap().len(), 1);
        assert_eq!(r.body["journal"][0]["tseq"], 2);
        assert_eq!((r.body["console_journal"][0]["cseq"].as_u64(), r.body["console_journal"][0]["prev_cseq"].as_u64()), (Some(3), Some(1)));
        assert_eq!(r.body["client_keys"], json!(keys));
        let r = sync(&w, "seq=1&tseq=2&cseq=3&wait=0", APP);
        assert_eq!((r.body["journal"].clone(), r.body["console_journal"].clone()), (json!([]), json!([])));
        // the other connector gets the other client's key
        let other = sync(&w, "seq=1&tseq=2&cseq=3&wait=0", APP2);
        assert_eq!(other.status, 200, "{}", other.body);
        assert_eq!(other.body["client_keys"].as_array().unwrap().iter().map(|k| k["client"].clone()).collect::<Vec<_>>(), [json!(C2)]);
        assert_ne!(other.body["client_keys"][0]["key"], keys[0]["key"]);
        // each answer is in the console's chain, about the connector
        let calls = chain(&w, "api.call");
        assert_eq!(calls.len(), 4);
        assert!(calls.iter().all(|e| e["route"] == "GET /api/orgs/kacme/v1/connector/sync" && e["resource"] == e["connector"]));
        assert_eq!((calls[0]["connector"].as_str(), calls[0]["app"].as_str()), (Some(K), Some(APP)));
    }

    #[test]
    fn a_sync_answer_cuts_its_journals_to_400_kib() {
        let mut out = json!({"org": ORG, "map": {"map": {"pad": "x".repeat(200 * 1024)}}, "client_keys": [], "now": 1, "wait_s": 30});
        let entry = |n: u64| json!({"tseq": n, "pad": "y".repeat(1000)});
        let journal: Vec<Value> = (1..=150).map(entry).collect();
        let console: Vec<Value> = (1..=150).map(|n| json!({"cseq": n, "prev_cseq": n - 1, "pad": "z".repeat(1000)})).collect();
        fit(&mut out, journal, console).unwrap_or_else(|_| panic!("fits"));
        let size = serde_json::to_vec(&out).unwrap().len();
        assert!(size <= SYNC_MAX, "{size}");
        let j = out["journal"].as_array().unwrap();
        let c = out["console_journal"].as_array().unwrap();
        assert!(!j.is_empty() && j.len() + c.len() < 300, "cut to fit");
        // each list is a prefix in order
        assert!(j.iter().enumerate().all(|(i, e)| e["tseq"] == i as u64 + 1));
        assert!(c.iter().enumerate().all(|(i, e)| e["cseq"] == i as u64 + 1));
        let mut huge = json!({"map": {"pad": "x".repeat(SYNC_MAX)}});
        assert!(fit(&mut huge, Vec::new(), Vec::new()).is_err());
    }

    #[test]
    fn a_certificate_outside_an_active_connector_of_the_org_is_refused() {
        let w = world("console-connector-refused");
        let mut not_app = cert(APP, ORG);
        not_app.kind = "person".into();
        let mut unverified = cert(APP, ORG);
        unverified.chain_ok = false;
        let cases = [None, Some(cert("nobody-api@apps.acme.example", ORG)), Some(cert(APP, "beta")), Some(cert(APP3, ORG)), Some(not_app), Some(unverified)];
        for (i, c) in cases.iter().enumerate() {
            let r = call(&w, Route::Sync, "wait=0", None, c.as_ref());
            assert_eq!(code(&r), (403, "connector".into()), "case {i}");
            assert!(r.body.get("client_keys").is_none());
        }
        // refusals of an unidentified caller fold from the first into a summary per minute, keyed on its address
        w.audit.tick(now_s() + 120);
        let counted: u64 = chain(&w, "api.refusal.summary")
            .iter()
            .filter(|e| e["check"] == "connector" && e["route"] == "GET /api/orgs/kacme/v1/connector/sync")
            .map(|e| e["count"].as_u64().unwrap_or(0))
            .sum();
        assert_eq!(counted, cases.len() as u64);
        assert!(chain(&w, "api.call").is_empty());
        // the source limiter comes first
        let limited = |_: IpAddr, _: i64| -> Result<(), i64> { Err(7) };
        let door = Door { api: &w.api, source_ok: &limited };
        let c = cert(APP, ORG);
        let req = Request { org: ORG, route: Route::Sync, query: "wait=0", body: None, cert: Some(&c), source: IpAddr::from(IP), rid: "AAAAAAAAAAAAAAAAAAAAAA" };
        let r = door.answer(&req, crate::codec::now_ms()).unwrap();
        assert_eq!(code(&r), (429, "abuse".into()));
        assert!(r.headers.iter().any(|(k, v)| *k == "Retry-After" && v == "7"));
    }

    #[test]
    fn a_suspended_connector_syncs_but_is_refused_elsewhere() {
        let w = world("console-connector-suspended");
        w.api.append_console(ORG, "connector_suspend", json!(K), now_s()).unwrap();
        let r = sync(&w, "wait=0", APP);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["connector"], json!({"id": K, "suspended": true}));
        assert_eq!(r.body["console_journal"][0]["action"], "connector_suspend");
        assert_eq!(code(&post(&w, Route::Ack, ack(&crate::connector::FEATURES))), (403, "suspended".into()));
        assert_eq!(code(&post(&w, Route::PersonStop, json!({"org": ORG, "client": C1, "principal": ANN, "mid": "m1"}))), (403, "suspended".into()));
        assert!(w.api.relay_set(ORG).is_empty());
        // another connector of the org is not affected
        assert_eq!(sync(&w, "wait=0", APP2).body["connector"]["suspended"], false);
    }

    #[test]
    fn an_ack_joins_the_relay_set_and_a_connector_without_journal_1c_closes_the_gate() {
        let w = world("console-connector-ack");
        let r = post(&w, Route::Ack, ack(&crate::connector::FEATURES));
        assert_eq!((r.status, r.body.clone()), (200, json!({"ok": true})));
        let set = w.api.relay_set(ORG);
        let report = set.get(K).cloned().flatten().expect("the connector is in the set");
        assert_eq!(report.map, [1, 2]);
        assert!(report.has(JOURNAL_1C) && report.has(crate::api_features::CONNECTORS));
        let needs = crate::api_features::map_needs(&w.api.pinned(ORG).0.unwrap());
        assert!(needs.contains(&crate::api_features::CONNECTORS));
        w.api.gate(ORG, &needs).unwrap();
        let kept = latest_ack(&w.dir, ORG, K).unwrap();
        assert_eq!((kept["connector"].as_str(), kept["ack"]["seal"].as_str()), (Some(K), Some("tpm")));
        // every feature but journal-1c: reported as none, so the map's features close
        let r = post(&w, Route::Ack, ack(&["connectors", "idps", "content-clients", "delegated"]));
        assert_eq!(r.status, 200, "{}", r.body);
        assert!(w.api.relay_set(ORG)[K].as_ref().unwrap().features.is_empty());
        assert_eq!(w.api.gate(ORG, &needs).unwrap_err().code, crate::api_features::OUTDATED);
        // shapes outside 2.8 are refused and change nothing
        let mut bad = ack(&crate::connector::FEATURES);
        bad["seal"] = json!("floppy");
        assert_eq!(code(&post(&w, Route::Ack, bad)), (400, "request".into()));
        let mut other_org = ack(&crate::connector::FEATURES);
        other_org["org"] = json!("beta");
        assert_eq!(code(&post(&w, Route::Ack, other_org)), (400, "request".into()));
        assert!(w.api.relay_set(ORG)[K].as_ref().unwrap().features.is_empty());
        let missing = call(&w, Route::Ack, "", None, Some(&cert(APP, ORG)));
        assert_eq!(code(&missing), (400, "request".into()));
        let open = |_: IpAddr, _: i64| -> Result<(), i64> { Ok(()) };
        let door = Door { api: &w.api, source_ok: &open };
        let c = cert(APP, ORG);
        let req = Request { org: ORG, route: Route::Ack, query: "", body: Some(Err("too-large")), cert: Some(&c), source: IpAddr::from(IP), rid: "AAAAAAAAAAAAAAAAAAAAAA" };
        assert_eq!(code(&door.answer(&req, crate::codec::now_ms()).unwrap()), (413, "too-large".into()));
    }

    /// r5 13.1: an ack's metrics become the connector's series (labeled with its id) and set its sync age; metrics
    /// outside the reported families or shapes refuse the ack.
    #[test]
    fn ack_metrics_become_the_connectors_series() {
        use crate::api_catalog::counters;
        // the second connector (K2, app APP2): the other tests ack as K, in parallel
        let w = world("console-connector-metrics");
        let post2 = |body: Value| call(&w, Route::Ack, "", Some(body), Some(&cert(APP2, ORG)));
        let mut a = ack(&crate::connector::FEATURES);
        a["conversations"] = json!([]);
        a["metrics"] = json!({"lucid_connector_store_bytes": 4096, "lucid_connector_conversations": 1,
                              "lucid_connector_requests_total": [{"labels": {"result": "ok"}, "value": 7}],
                              "lucid_content_approvals_total": [{"labels": {"result": "approved"}, "value": 2}]});
        let r = post2(a.clone());
        assert_eq!(r.status, 200, "{}", r.body);
        let at = latest_ack(&w.dir, ORG, K2).unwrap()["at"].as_i64().unwrap();
        let value = |prom: &str, labels: &[(&str, &str)], at: i64| {
            counters::rows(Some(ORG), at).into_iter().find(|r| r.prom == prom && r.labels.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>() == labels).map(|r| r.value)
        };
        assert_eq!(value("lucid_connector_store_bytes", &[("connector", K2)], at), Some(4096.0));
        assert_eq!(value("lucid_connector_conversations", &[("connector", K2)], at), Some(1.0));
        assert_eq!(value("lucid_connector_requests_total", &[("connector", K2), ("result", "ok")], at), Some(7.0));
        assert!(value("lucid_content_approvals_total", &[("result", "approved")], at).is_some_and(|v| v >= 2.0), "summed over the org's connectors");
        assert_eq!(value("lucid_connector_sync_age_seconds", &[("connector", K2)], at + 3), Some(3.0));
        for bad in [json!([]), json!({"lucid_api_requests_total": 1}), json!({"lucid_connector_store_bytes": "x"}),
                    json!({"lucid_connector_requests_total": [{"labels": {"client": "c_1"}, "value": 1}]})] {
            let mut b = a.clone();
            b["metrics"] = bad.clone();
            assert_eq!(code(&post2(b)), (400, "request".into()), "{bad}");
        }
        assert_eq!(value("lucid_connector_store_bytes", &[("connector", K2)], at), Some(4096.0), "a refused ack changes nothing");
    }

    fn batch(entries: &[Value], repr: Repr, first: u64) -> Value {
        json!({"org": ORG, "repr": repr.as_str(), "first": first, "last": first + entries.len() as u64 - 1, "entries": entries})
    }

    #[test]
    fn audit_batches_store_under_the_connector_id_and_refuse_other_sources() {
        let w = world("console-connector-audit");
        let now = now_s();
        let k = ApiAudit::open(Some(&tests_dir("console-connector-audit-k")), K, Arc::new(NoSigner), Arc::new(NoKey), now);
        for i in 0..4 {
            k.record(ORG, json!({"action": "api.call", "client": C1, "conv": "ch:0123456789abcdef", "items": i, "result": "ok"}), now).unwrap();
        }
        let es = k.since(ORG, Repr::AsIs, 0, 10);
        // a relay's first entry, or another connector's, chains well but is not this connector's chain
        let relay = ApiAudit::open(None, "r_00000000000000aa", Arc::new(NoSigner), Arc::new(NoKey), now);
        relay.record(ORG, json!({"action": "api.call", "client": C1, "result": "ok"}), now).unwrap();
        let other = ApiAudit::open(None, K2, Arc::new(NoSigner), Arc::new(NoKey), now);
        other.record(ORG, json!({"action": "api.call", "client": C1, "result": "ok"}), now).unwrap();
        for foreign in [relay.since(ORG, Repr::AsIs, 0, 1), other.since(ORG, Repr::AsIs, 0, 1)] {
            let r = post(&w, Route::Audit, batch(&foreign, Repr::AsIs, 1));
            assert_eq!(code(&r), (400, "bad-chain".into()));
        }
        assert_eq!((w.audit.head(ORG, K, Repr::AsIs).0, w.audit.head(ORG, K2, Repr::AsIs).0), (0, 0));
        let r = post(&w, Route::Audit, batch(&es[0..2], Repr::AsIs, 1));
        assert_eq!((r.status, r.body.clone()), (200, json!({"ok": true, "last": 2})));
        assert_eq!(w.audit.head(ORG, K, Repr::AsIs).0, 2);
        // a gap answers where to resend from
        let r = post(&w, Route::Audit, batch(&es[3..4], Repr::AsIs, 4));
        assert_eq!((r.status, r.body.clone()), (200, json!({"ok": false, "code": "gap", "expected": 3})));
        assert_eq!(chain(&w, "api.call").last().unwrap()["code"], "gap");
        // the rest goes in, in every representation; another org's batch is refused
        let r = post(&w, Route::Audit, batch(&es[2..4], Repr::AsIs, 3));
        assert_eq!(r.body, json!({"ok": true, "last": 4}));
        for repr in [Repr::Pseudonymized, Repr::Removed] {
            let page = k.since(ORG, repr, 0, 10);
            assert_eq!(post(&w, Route::Audit, batch(&page, repr, 1)).body["last"], 4);
        }
        assert_eq!(w.audit.head(ORG, K, Repr::Removed), k.head(ORG, K, Repr::Removed));
        let mut beta = batch(&es[0..1], Repr::AsIs, 1);
        beta["org"] = json!("beta");
        assert_eq!(code(&post(&w, Route::Audit, beta)), (400, "request".into()));
        assert!(w.dir.join("api-audit").join(ORG).join(K).join("as_is-000001.jsonl").is_file());
    }

    #[test]
    fn a_checkpoint_csr_round_trip_verifies_a_connector_checkpoint() {
        let w = world("console-connector-checkpoint");
        let kdir = tests_dir("console-connector-checkpoint-k");
        let kvault: TestVault = Arc::new(Mutex::new(MemVault::default()));
        let csr = crate::api_checkpoint::relay_checkpoint_csr(&kdir, &*kvault, ORG).unwrap();
        assert_eq!(code(&post(&w, Route::CheckpointCsr, json!({"org": ORG, "csr": "AAAA"}))), (400, "request".into()));
        let r = post(&w, Route::CheckpointCsr, json!({"org": ORG, "csr": b64u(&csr)}));
        assert_eq!(r.status, 200, "{}", r.body);
        let cert_der = unb64u(r.body["cert"].as_str().unwrap()).unwrap();
        let chain_der: Vec<Vec<u8>> = r.body["chain"].as_array().unwrap().iter().map(|c| unb64u(c.as_str().unwrap()).unwrap()).collect();
        crate::api_checkpoint::install(&kdir, &*kvault, ORG, &cert_der, &chain_der).unwrap();
        assert!(w.audit.keys(ORG).iter().any(|c| c["source"] == K));
        let now = now_s();
        let signer = Arc::new(crate::api_checkpoint::RelayCheckpoints::new(&kdir, kvault.clone() as Arc<dyn VaultLock>));
        let k = ApiAudit::open(Some(&kdir), K, signer, Arc::new(NoKey), now);
        k.record(ORG, json!({"action": "connector.stale.off", "result": "ok", "age_s": 3}), now).unwrap();
        k.tick(now + 400);
        let es = k.since(ORG, Repr::AsIs, 0, 10);
        assert_eq!((es.len(), es[1]["action"].as_str(), es[1]["connector"].as_str()), (2, Some("checkpoint"), Some(K)));
        for repr in Repr::ALL {
            let page = k.since(ORG, repr, 0, 10);
            let r = post(&w, Route::Audit, batch(&page, repr, 1));
            assert_eq!(r.body, json!({"ok": true, "last": 2}), "{}", repr.as_str());
        }
        assert_eq!(w.audit.head(ORG, K, Repr::AsIs), k.head(ORG, K, Repr::AsIs));
    }

    #[test]
    fn person_stop_journals_one_person_revoke_however_often_it_is_retried() {
        let w = world("console-connector-stop");
        let stop = json!({"org": ORG, "client": C1, "principal": ANN, "mid": "m_0001"});
        let first = post(&w, Route::PersonStop, stop.clone());
        assert_eq!(first.status, 200, "{}", first.body);
        assert_eq!(first.body["ok"], true);
        for _ in 0..3 {
            assert_eq!(post(&w, Route::PersonStop, stop.clone()).body, first.body);
        }
        let revokes = |p: &str| w.api.console_entries(ORG).into_iter().filter(|e| e.action == "person_revoke" && e.field("principal") == p).count();
        assert_eq!(revokes(ANN), 1);
        assert!(api_cjournal::person_revoked(&w.api.console_active(ORG), C1, ANN));
        // a standing deny for every client already covers the pair
        let all = w.api.append_console(ORG, "person_revoke", json!({"client": "*", "principal": BOB}), now_s()).unwrap();
        let r = post(&w, Route::PersonStop, json!({"org": ORG, "client": C1, "principal": BOB, "mid": "m_0002"}));
        assert_eq!(r.body, json!({"ok": true, "cseq": all["cseq"].clone()}));
        assert_eq!(revokes(BOB), 1);
        // a client that does not use this connector, or a malformed stop, is refused
        assert_eq!(code(&post(&w, Route::PersonStop, json!({"org": ORG, "client": C2, "principal": ANN, "mid": "m_0003"}))), (403, "client".into()));
        assert_eq!(code(&post(&w, Route::PersonStop, json!({"org": ORG, "client": C1, "principal": "not a person", "mid": "m_0004"}))), (400, "request".into()));
        assert_eq!(revokes(ANN), 1);
    }
}
