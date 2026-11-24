// Contract API-1 revision 6 section 8 (slice API-1d6): the AI gateway's MCP client as the gateway runs it.
//
// - The allow list is the pinned AI map's `mcp_servers` (8.1). During the 10-minute window after a new pin a server
//   is used only when both pairs list it with the same URL and credential, with the narrower groups, activities,
//   tools, limits and `private_ok` of the two and each pair's own ceiling.
// - The tightening journal (8.2) is `mcp-journal/<org>.json`, applied in `tseq` order and fsynced before the answer.
//   An entry leaves the active set when a newly pinned map contains its restriction (folding) or lists its id in
//   `mcp_cleared` with a later `issued` (clearing); `mcp_off` leaves only by clearing.
// - Admin routes `/v1/ai/admin/mcp/*` (8.9), each with an `ai.admin.mcp` audit line before it acts.
// - An ask's tool session (8.6 to 8.8): only for a person in one of a server's `groups`, in one of its
//   `activities`, with `tools: true`; a server is offered while the working class (the ask's class, raised to each
//   called server's ceiling after the call) is at or below its ceiling, the chosen card may carry its ceiling class,
//   and the server is not journaled off; each call is checked (class, `max_calls`, `args_max`) and audited
//   (`ai.mcp.call`, fsynced) before the request is opened, and nothing else of the ask is sent.

use crate::ai_gateway_ask::card_fit;
use crate::ai_gateway_audit::Audit;
use crate::ai_gateway_cards::Card;
use crate::ai_gateway_mcp_client::{Client, Conf, Fail, Transport};
use crate::ai_gateway_mcp_cred::CredStore;
use crate::ai_gateway_policy::Pair;
use crate::ai_gateway_tools::{model_name, ToolCall, ToolDef};
use crate::ai_mcp::{self as m, Entry};
use crate::meet::log_warn;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// 6.4: the relay's groups answer is kept at most 5 minutes, like `allowed`.
const GROUPS_TTL_MS: i64 = 5 * 60 * 1000;
const DESCRIPTION_MAX: usize = 1024;
const ENTRIES_MAX: usize = 1000;

pub const TSEQ_GAP: &str = "that journal entry does not follow the gateway's last one";
pub const OTHER_ORG: &str = "this gateway serves another organization";
pub const NO_SERVER: &str = "that MCP server is not in the pinned AI map; send its draft";
pub const AUDIT_UNAVAILABLE: &str = "the gateway's audit log cannot be written, so nothing was done";

/// The AI map of a pinned pair (unsigned body).
pub fn map_of(pair: &Pair) -> Value {
    pair.wires.get("map").and_then(|w| w.get("map")).cloned().unwrap_or(Value::Null)
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

// ── one server after the journal ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub conf: Conf,
    pub ceiling: String,
    pub groups: Vec<String>,
    pub activities: Vec<String>,
    /// (name, schema_sha256) as approved in the map.
    pub tools: Vec<(String, String)>,
    pub max_calls: u32,
    pub args_max: usize,
    pub result_max: usize,
    pub expires: i64,
    /// `mcp_credential_drop` is active.
    pub dropped: bool,
}

impl Server {
    fn read(v: &Value) -> Option<Server> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let n = |k: &str| v.get(k).and_then(Value::as_u64);
        let auth = v.get("auth").cloned().unwrap_or(Value::Null);
        Some(Server {
            id: s("id")?,
            name: s("name")?,
            conf: Conf { id: s("id")?, url: s("url")?, private_ok: v.get("private_ok").and_then(Value::as_bool)?, auth: auth.clone() },
            ceiling: s("ceiling")?,
            groups: strs(v.get("groups")),
            activities: strs(v.get("activities")),
            tools: v.get("tools").and_then(Value::as_array).into_iter().flatten().filter_map(|t| Some((t.get("name")?.as_str()?.to_string(), t.get("schema_sha256")?.as_str()?.to_string()))).collect(),
            max_calls: n("max_calls")? as u32,
            args_max: n("args_max")? as usize,
            result_max: n("result_max")? as usize,
            expires: auth.get("expires").and_then(Value::as_i64).unwrap_or(0),
            dropped: false,
        })
    }

    /// Apply one active entry (the entry's server is this one).
    fn tighten(&mut self, e: &Entry) {
        let t = &e.target;
        let field = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        match e.action.as_str() {
            "mcp_tool_off" => self.tools.retain(|(n, _)| *n != field("tool")),
            "mcp_lower_ceiling" => {
                let want = field("ceiling");
                if m::ceiling_rank(&want) < m::ceiling_rank(&self.ceiling) {
                    self.ceiling = want;
                }
            }
            "mcp_credential_drop" => self.dropped = true,
            "mcp_drop_group" => self.groups.retain(|g| *g != field("group")),
            "mcp_drop_activity" => self.activities.retain(|a| *a != field("activity")),
            "mcp_private_off" => self.conf.private_ok = false,
            "mcp_limit" => {
                if let Some(x) = t.get("max_calls").and_then(Value::as_u64) {
                    self.max_calls = self.max_calls.min(x as u32);
                }
                if let Some(x) = t.get("args_max").and_then(Value::as_u64) {
                    self.args_max = self.args_max.min(x as usize);
                }
                if let Some(x) = t.get("result_max").and_then(Value::as_u64) {
                    self.result_max = self.result_max.min(x as usize);
                }
            }
            _ => {}
        }
    }
}

/// A server as the ask uses it under every pair: the last pair's entry narrowed by the others, and each pair's own
/// ceiling (the class gate runs per pair).
#[derive(Clone, Debug)]
pub struct Merged {
    pub s: Server,
    pub ceilings: Vec<String>,
}

// ── the journal ──────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
struct Held {
    e: Entry,
    /// "active", "folded" or "cleared".
    state: String,
    /// `mcp_credential_drop`: the `auth.expires` pinned when the drop was applied.
    dropped_expires: Option<i64>,
}

#[derive(Default)]
struct Book {
    head: u64,
    entries: Vec<Held>,
}

impl Book {
    fn active(&self) -> impl Iterator<Item = &Entry> {
        self.entries.iter().filter(|h| h.state == "active").map(|h| &h.e)
    }

    fn to_json(&self, org: &str) -> Value {
        let entries: Vec<Value> = self
            .entries
            .iter()
            .map(|h| {
                let mut v = h.e.to_json();
                v["state"] = json!(h.state);
                if let Some(x) = h.dropped_expires {
                    v["dropped_expires"] = json!(x);
                }
                v
            })
            .collect();
        json!({"v": 1, "org": org, "head": self.head, "entries": entries})
    }

    fn read(org: &str, v: &Value) -> Book {
        let entries = v
            .get("entries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|x| {
                let mut plain = x.clone();
                let o = plain.as_object_mut()?;
                let state = o.remove("state")?.as_str()?.to_string();
                let dropped_expires = o.remove("dropped_expires").and_then(|d| d.as_i64());
                Some(Held { e: m::check_entry(org, &plain).ok()?, state, dropped_expires })
            })
            .collect();
        Book { head: v.get("head").and_then(Value::as_u64).unwrap_or(0), entries }
    }
}

/// One use of a tool in an ask (8.7 `tools_used`, 8.8 `mcp`).
#[derive(Clone, Debug, PartialEq)]
pub struct Use {
    pub server: String,
    pub server_name: String,
    pub tool: String,
    /// `ok`, `error`, `refused` or `cut`.
    pub outcome: &'static str,
    pub args_bytes: usize,
    pub result_bytes: usize,
    pub took_ms: u64,
}

impl Use {
    /// The ask's audit line entry: sizes and outcome, never arguments or results.
    pub fn record(&self) -> Value {
        json!({"server": self.server, "tool": self.tool, "outcome": self.outcome, "args_bytes": self.args_bytes, "result_bytes": self.result_bytes, "took_ms": self.took_ms})
    }

    /// The answer's `tools_used` entry.
    pub fn answer(&self) -> Value {
        json!({"server": self.server_name, "tool": self.tool, "outcome": self.outcome})
    }
}

/// What a tool call gives the model.
#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub text: String,
    pub error: bool,
    /// The result is of a class the chosen frontier card gets only redacted (AI-1 5.4).
    pub redact: bool,
    pub server_name: String,
    pub tool: String,
}

pub struct Mcp {
    org: String,
    /// This gateway's principal and device.
    me: (String, String),
    journal_path: PathBuf,
    book: Mutex<Book>,
    pub creds: CredStore,
    pub client: Client,
    groups: Mutex<HashMap<String, (Vec<String>, i64)>>,
    /// Tools whose listed schema no longer matches the map (`AiMcpToolChanged`): (server, tool) -> current hash.
    changed: Mutex<HashMap<(String, String), String>>,
    /// A fold or clear of the pinned map could not be written; every policy refresh tries it again.
    fold_unsaved: AtomicBool,
}

impl Mcp {
    pub fn open(state_dir: &std::path::Path, org: &str, me: (String, String), net: Arc<dyn Transport>) -> Mcp {
        let journal_path = state_dir.join("mcp-journal").join(format!("{org}.json"));
        let book = std::fs::read(&journal_path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).map(|v| Book::read(org, &v)).unwrap_or_default();
        Mcp {
            org: org.to_string(),
            client: Client::new(net, &me.0),
            me,
            journal_path,
            book: Mutex::new(book),
            creds: CredStore::new(state_dir),
            groups: Mutex::new(HashMap::new()),
            changed: Mutex::new(HashMap::new()),
            fold_unsaved: AtomicBool::new(false),
        }
    }

    /// True while a fold or clear of the pinned map is not yet written (refresh_policy retries `on_pin`).
    pub fn fold_due(&self) -> bool {
        self.fold_unsaved.load(Ordering::Relaxed)
    }

    fn save(&self, book: &Book) -> Result<(), String> {
        crate::meet_tls::write_atomic(&self.journal_path, book.to_json(&self.org).to_string().as_bytes()).map_err(|e| format!("the MCP journal cannot be written: {e}"))
    }

    /// The servers of `map` after the active journal entries (none while `mcp_off` is active).
    pub fn effective(&self, map: &Value) -> Vec<Server> {
        let book = self.book.lock();
        let active: Vec<&Entry> = book.active().collect();
        if active.iter().any(|e| e.action == "mcp_off") {
            return Vec::new();
        }
        let mut out = Vec::new();
        for v in map.get("mcp_servers").and_then(Value::as_array).into_iter().flatten() {
            let Some(mut s) = Server::read(v) else { continue };
            let mine: Vec<&&Entry> = active.iter().filter(|e| e.server() == s.id).collect();
            if mine.iter().any(|e| e.action == "mcp_server_off") {
                continue;
            }
            for e in mine {
                s.tighten(e);
            }
            out.push(s);
        }
        out
    }

    /// The servers usable under every pair of a request (8.1 and the AI-1 6.2 window).
    pub fn merged(&self, pairs: &[Pair]) -> Vec<Merged> {
        let per: Vec<Vec<Server>> = pairs.iter().map(|p| self.effective(&map_of(p))).collect();
        let Some(last) = per.last() else { return Vec::new() };
        let mut out = Vec::new();
        'servers: for base in last {
            let mut s = base.clone();
            let mut ceilings = Vec::new();
            for list in &per {
                let Some(o) = list.iter().find(|x| x.id == base.id) else { continue 'servers };
                if o.conf.url != s.conf.url || o.conf.auth != s.conf.auth {
                    continue 'servers;
                }
                s.groups.retain(|g| o.groups.contains(g));
                s.activities.retain(|a| o.activities.contains(a));
                s.tools.retain(|t| o.tools.contains(t));
                s.max_calls = s.max_calls.min(o.max_calls);
                s.args_max = s.args_max.min(o.args_max);
                s.result_max = s.result_max.min(o.result_max);
                s.conf.private_ok &= o.conf.private_ok;
                s.dropped |= o.dropped;
                ceilings.push(o.ceiling.clone());
            }
            out.push(Merged { s, ceilings });
        }
        out
    }

    /// Fold and clear the active entries against a newly pinned map (8.2); cached server state is dropped. The
    /// transitions are written first and take effect only once saved: a failed write keeps every entry active (the
    /// restriction stays), so the next pin tries again.
    pub fn on_pin(&self, map: &Value) {
        let mut book = self.book.lock();
        let mut entries = book.entries.clone();
        let mut moved = false;
        for h in entries.iter_mut().filter(|h| h.state == "active") {
            if m::folds(&h.e, map, h.dropped_expires) {
                h.state = "folded".into();
                moved = true;
            } else if m::cleared(&h.e, map) {
                h.state = "cleared".into();
                moved = true;
            }
        }
        if moved {
            let next = Book { head: book.head, entries };
            match self.save(&next) {
                Ok(()) => {
                    *book = next;
                    self.fold_unsaved.store(false, Ordering::Relaxed);
                }
                Err(e) => {
                    self.fold_unsaved.store(true, Ordering::Relaxed);
                    log_warn(&format!("ai_mcp_journal_unsaved org={} error={e}", self.org));
                }
            }
        } else {
            self.fold_unsaved.store(false, Ordering::Relaxed);
        }
        drop(book);
        for v in map.get("mcp_servers").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = v.get("id").and_then(Value::as_str) {
                self.client.forget(id);
            }
        }
        self.changed.lock().clear();
    }

    /// `POST /v1/ai/admin/mcp/tighten {org, entries}` (8.2): every entry checked first, then applied in `tseq`
    /// order and fsynced before the answer. `current`: the pinned map (a credential drop records its `expires`).
    pub fn tighten(&self, input: &Value, current: Option<&Value>) -> (u16, Value) {
        let fail = |status: u16, code: &str, words: &str| (status, json!({"error": words, "code": code}));
        if input.get("org").and_then(Value::as_str) != Some(self.org.as_str()) {
            return fail(404, "bad_request", OTHER_ORG);
        }
        let Some(list) = input.get("entries").and_then(Value::as_array).filter(|l| l.len() <= ENTRIES_MAX) else {
            return fail(400, "bad_request", "entries must be a list of at most 1000 journal entries");
        };
        let mut entries = Vec::new();
        for v in list {
            match m::check_entry(&self.org, v) {
                Ok(e) => entries.push(e),
                Err((status, code, words)) => return fail(status, code, &words),
            }
        }
        entries.sort_by_key(|e| e.tseq);
        let mut book = self.book.lock();
        let mut head = book.head;
        let mut fresh: Vec<Held> = Vec::new();
        for e in entries {
            if e.tseq <= head {
                let known = book.entries.iter().map(|h| &h.e).chain(fresh.iter().map(|h| &h.e)).any(|x| x.tseq == e.tseq && x.id == e.id);
                if known {
                    continue;
                }
                return fail(409, "tseq-gap", TSEQ_GAP);
            }
            if e.tseq != head + 1 {
                return fail(409, "tseq-gap", TSEQ_GAP);
            }
            head = e.tseq;
            let dropped_expires = (e.action == "mcp_credential_drop")
                .then(|| current.and_then(|map| map.get("mcp_servers")).and_then(Value::as_array).into_iter().flatten().find(|s| s.get("id").and_then(Value::as_str) == Some(e.server())).and_then(|s| s.pointer("/auth/expires")).and_then(Value::as_i64))
                .flatten();
            fresh.push(Held { e, state: "active".into(), dropped_expires });
        }
        if fresh.is_empty() {
            return (200, json!({"ok": true, "tseq": book.head}));
        }
        let before = (book.head, book.entries.len());
        book.entries.extend(fresh.iter().cloned());
        book.head = head;
        if let Err(e) = self.save(&book) {
            book.head = before.0;
            book.entries.truncate(before.1);
            log_warn(&format!("ai_mcp_journal_unsaved org={} error={e}", self.org));
            return (500, json!({"error": "the AI gateway failed this request"}));
        }
        drop(book);
        for h in &fresh {
            if h.e.action == "mcp_credential_drop" {
                self.creds.drop_server(h.e.server());
                self.client.forget(h.e.server());
            }
        }
        crate::meet::log_info(&format!("ai_mcp_tightened org={} tseq={head} entries={}", self.org, fresh.len()));
        (200, json!({"ok": true, "tseq": head}))
    }

    /// The person's groups among the policy's (relay `groups=1`), cached 5 minutes.
    pub fn cached_groups(&self, principal: &str, now_ms: i64) -> Option<Vec<String>> {
        self.groups.lock().get(principal).filter(|(_, at)| now_ms - at < GROUPS_TTL_MS).map(|(g, _)| g.clone())
    }

    pub fn put_groups(&self, principal: &str, groups: Vec<String>, now_ms: i64) {
        let mut g = self.groups.lock();
        g.retain(|_, (_, at)| now_ms - *at < GROUPS_TTL_MS);
        g.insert(principal.to_string(), (groups, now_ms));
    }

    /// A pin can remove people from groups: every cached answer is asked again.
    pub fn clear_groups(&self) {
        self.groups.lock().clear();
    }

    /// Whether this gateway holds a usable credential for a server now (8.4): not dropped, `auth.expires` ahead,
    /// and its own key listed under its principal, or an installed certificate inside its validity.
    pub fn credential_ok(&self, s: &Server, now_s: i64) -> bool {
        if s.dropped || s.expires <= now_s {
            return false;
        }
        let st = self.creds.state(&s.id);
        match s.conf.auth_type() {
            "oauth_private_key_jwt" => st.state == "key" && s.conf.auth.get("kids").and_then(|k| k.get(&self.me.0)).and_then(Value::as_str) == Some(st.kid.as_str()),
            "oauth_mtls" | "mtls_only" => st.state == "cert" && st.not_after > now_s,
            _ => false,
        }
    }

    fn credential_view(&self, s: &Server, now_s: i64) -> Value {
        let st = self.creds.state(&s.id);
        let state = if s.dropped {
            "dropped"
        } else if s.expires <= now_s || (st.state == "cert" && st.not_after <= now_s) {
            "expired"
        } else if self.credential_ok(s, now_s) {
            "ready"
        } else if st.state == "csr" {
            "csr"
        } else {
            "none"
        };
        json!({"type": s.conf.auth_type(), "state": state, "expires": s.expires, "kid": st.kid, "not_after": st.not_after})
    }

    /// `GET /v1/ai/admin/mcp/state` (8.9).
    pub fn state(&self, current: Option<&Value>, now_ms: i64) -> Value {
        let now_s = now_ms / 1000;
        let servers = current.map(|map| self.effective(map)).unwrap_or_default();
        let raw: Vec<Server> = current.and_then(|map| map.get("mcp_servers")).and_then(Value::as_array).into_iter().flatten().filter_map(Server::read).collect();
        let changed = self.changed.lock().clone();
        let rows: Vec<Value> = raw
            .iter()
            .map(|r| {
                let eff = servers.iter().find(|s| s.id == r.id);
                let shown = eff.unwrap_or(r);
                let listed = self.client.listed(&r.id);
                let (at, versions) = self.client.discovered(&r.id);
                let tools: Vec<Value> = r
                    .tools
                    .iter()
                    .map(|(name, hash)| {
                        let now_hash = listed.iter().find(|t| t.get("name").and_then(Value::as_str) == Some(name.as_str())).map(m::schema_sha256).unwrap_or_default();
                        let on = eff.is_some_and(|s| s.tools.iter().any(|(n, _)| n == name));
                        let why = if !on {
                            "journaled"
                        } else if changed.contains_key(&(r.id.clone(), name.clone())) || (!now_hash.is_empty() && now_hash != *hash) {
                            "mcp-tool-changed"
                        } else if listed.is_empty() || now_hash.is_empty() {
                            "not-listed"
                        } else {
                            ""
                        };
                        json!({"name": name, "schema_sha256": now_hash, "offered": why.is_empty(), "why": why})
                    })
                    .collect();
                let ready = eff.is_some_and(|s| self.credential_ok(s, now_s));
                let error = if eff.is_none() { "journaled" } else if !ready { "mcp-credential" } else { "" };
                json!({
                    "id": r.id, "name": r.name, "offered": ready && tools.iter().any(|t| t["offered"] == true), "error": error,
                    "discovered_at": at / 1000, "versions": versions, "credential": self.credential_view(shown, now_s), "tools": tools,
                })
            })
            .collect();
        let book = self.book.lock();
        let changed_list: Vec<Value> = changed.iter().map(|((s, t), h)| json!({"server": s, "tool": t, "schema_sha256": h})).collect();
        json!({
            "org": self.org, "reads": m::MCP_READS,
            "journal": {"head": book.head, "active": book.active().map(|e| e.id.clone()).collect::<Vec<_>>()},
            "servers": rows, "changed": changed_list,
        })
    }

    /// The admin MCP routes (8.9). `current`: the pinned AI map.
    pub async fn admin(&self, audit: &Audit, method: &str, path: &str, query_org: Option<String>, input: &Value, current: Option<&Value>, now_ms: i64) -> (u16, Value) {
        let fail = |status: u16, code: &str, words: &str| (status, json!({"error": words, "code": code}));
        let op = path.trim_start_matches("/v1/ai/admin/mcp/");
        let org = if method == "GET" { query_org.unwrap_or_default() } else { input.get("org").and_then(Value::as_str).unwrap_or_default().to_string() };
        if org != self.org {
            return fail(404, "bad_request", OTHER_ORG);
        }
        if (method, op) == ("GET", "state") {
            return (200, self.state(current, now_ms));
        }
        if method != "POST" || !["key", "csr", "cert", "test", "tighten"].contains(&op) {
            return (404, json!({"error": "not found"}));
        }
        let server = input.get("server").and_then(Value::as_str).unwrap_or_default().to_string();
        if op != "tighten" && !m::server_id_ok(Some(&Value::from(server.as_str()))) {
            return fail(400, "bad_request", m::MCP_ID);
        }
        let mut fields = json!({"op": op, "server": server, "org": self.org});
        if op == "tighten" {
            fields["entries"] = json!(input.get("entries").and_then(Value::as_array).map_or(0, Vec::len));
        }
        if audit.event("ai.admin.mcp", fields, now_ms).is_err() {
            return fail(503, "audit-unavailable", AUDIT_UNAVAILABLE);
        }
        match op {
            "tighten" => self.tighten(input, current),
            "key" => match self.creds.make_key(&server) {
                Ok((kid, jwk)) => {
                    self.client.forget(&server);
                    (200, json!({"ok": true, "server": server, "kid": kid, "jwk": jwk}))
                }
                Err(e) => fail(400, "bad_request", &e),
            },
            "csr" => match self.creds.make_csr(&server, &self.me.0) {
                Ok(pem) => (200, json!({"ok": true, "server": server, "csr_pem": pem})),
                Err(e) => fail(400, "bad_request", &e),
            },
            "cert" => {
                let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or_default();
                match self.creds.install_cert(&server, s("cert_pem"), s("chain_pem"), now_ms / 1000) {
                    Ok(not_after) => {
                        self.client.forget(&server);
                        (200, json!({"ok": true, "server": server, "not_after": not_after}))
                    }
                    Err(e) => fail(400, "bad_request", &e),
                }
            }
            _ => self.test(&server, input.get("draft"), current, now_ms).await,
        }
    }

    /// `POST /v1/ai/admin/mcp/test`: issuer pinning, the token, `server/discover` and `tools/list`, fresh; the
    /// tools with their `schema_sha256` for the admin to copy into the staged map.
    async fn test(&self, server: &str, draft: Option<&Value>, current: Option<&Value>, now_ms: i64) -> (u16, Value) {
        let fail = |status: u16, code: &str, words: &str| (status, json!({"error": words, "code": code}));
        let pinned = current.and_then(|map| map.get("mcp_servers")).and_then(Value::as_array).into_iter().flatten().find(|s| s.get("id").and_then(Value::as_str) == Some(server)).cloned();
        let conf = match (pinned, draft) {
            (Some(v), _) => Server::read(&v).map(|s| s.conf),
            (None, Some(d)) => {
                if let Err(w) = m::check_draft(d, server, now_ms / 1000) {
                    return fail(400, "bad_request", w);
                }
                Some(Conf { id: server.to_string(), url: d["url"].as_str().unwrap_or_default().into(), private_ok: d["private_ok"].as_bool().unwrap_or(false), auth: d["auth"].clone() })
            }
            (None, None) => return fail(404, "bad_request", NO_SERVER),
        };
        let Some(conf) = conf else { return fail(404, "bad_request", NO_SERVER) };
        self.client.forget(server);
        let run = async {
            let versions = self.client.discover(&conf, &self.creds, now_ms).await?;
            let tools = self.client.list(&conf, &self.creds, now_ms).await?;
            Ok::<_, Fail>((versions, tools))
        };
        match run.await {
            Ok((versions, tools)) => {
                let list: Vec<Value> = tools.iter().map(|t| json!({"name": t.get("name").cloned().unwrap_or(Value::Null), "description": t.get("description").cloned().unwrap_or(json!("")), "schema_sha256": m::schema_sha256(t)})).collect();
                (200, json!({"ok": true, "server": server, "versions": versions, "tools": list}))
            }
            Err(f) => fail(502, f.code, &f.message),
        }
    }
}

// ── an ask's tool session ────────────────────────────────────────────────────────────────────────────────────

/// Who asks (the ask's audit identity).
pub struct Asker<'a> {
    pub rid: &'a str,
    pub principal: &'a str,
    pub device: &'a str,
    pub activity: &'a str,
}

struct Offered {
    model: String,
    server: usize,
    tool: String,
    def: ToolDef,
}

pub struct Session<'a> {
    mcp: &'a Mcp,
    audit: &'a Audit,
    asker: Asker<'a>,
    pairs: &'a [Pair],
    /// The working class per pair (a rank in that pair's `classes`).
    working: Vec<usize>,
    servers: Vec<Merged>,
    redact: Vec<bool>,
    tools: Vec<Offered>,
    calls: HashMap<usize, u32>,
    pub uses: Vec<Use>,
}

impl<'a> Session<'a> {
    /// The class gate (8.6) under every pair for server `i` at the current working class.
    fn class_ok(&self, i: usize) -> bool {
        self.pairs.iter().enumerate().all(|(p, pair)| m::class_offers(&pair.ai.classes, &pair.ai.cui_classes, self.working[p], &self.servers[i].ceilings[p]))
    }

    /// Open a session: the servers this person may use in this activity whose ceiling the chosen card may carry and
    /// whose class gate passes now, discovered and listed (a server that fails either is left out of this ask).
    pub async fn open(mcp: &'a Mcp, audit: &'a Audit, asker: Asker<'a>, pairs: &'a [Pair], ranks: Vec<usize>, card: &Card, groups: &[String], now_ms: i64) -> Session<'a> {
        let mut s = Session { mcp, audit, asker, pairs, working: ranks, servers: Vec::new(), redact: Vec::new(), tools: Vec::new(), calls: HashMap::new(), uses: Vec::new() };
        let candidates: Vec<Merged> = mcp
            .merged(pairs)
            .into_iter()
            .filter(|x| x.s.groups.iter().any(|g| groups.contains(g)) && x.s.activities.iter().any(|a| a.as_str() == s.asker.activity))
            .filter(|x| mcp.credential_ok(&x.s, now_ms / 1000))
            .filter(|x| pairs.iter().zip(&x.ceilings).all(|(p, c)| p.ai.rank(c).is_some_and(|r| card_fit(p, card, r).is_ok())))
            .collect();
        for c in candidates {
            s.servers.push(c);
            let i = s.servers.len() - 1;
            if !s.class_ok(i) {
                s.servers.pop();
                continue;
            }
            let conf = s.servers[i].s.conf.clone();
            let listed = match mcp.client.discover(&conf, &mcp.creds, now_ms).await {
                Ok(_) => mcp.client.list(&conf, &mcp.creds, now_ms).await,
                Err(f) => Err(f),
            };
            let listed = match listed {
                Ok(l) => l,
                Err(f) => {
                    log_warn(&format!("ai_mcp_unavailable server={} code={} rid={}", conf.id, f.code, s.asker.rid));
                    s.servers.pop();
                    continue;
                }
            };
            let srv = s.servers[i].s.clone();
            for (name, hash) in &srv.tools {
                let Some(t) = listed.iter().find(|t| t.get("name").and_then(Value::as_str) == Some(name.as_str())) else { continue };
                let now_hash = m::schema_sha256(t);
                if now_hash != *hash {
                    log_warn(&format!("ai_mcp_tool_changed server={} tool={name}", srv.id));
                    mcp.changed.lock().insert((srv.id.clone(), name.clone()), now_hash);
                    continue;
                }
                let mut description: String = t.get("description").and_then(Value::as_str).unwrap_or_default().chars().take(DESCRIPTION_MAX).collect();
                description = format!("{} (an organization tool, read only): {description}", srv.name);
                let schema = t.get("inputSchema").filter(|x| x.is_object()).cloned().unwrap_or_else(|| json!({"type": "object"}));
                let model = model_name(s.tools.len() + 1, name);
                s.tools.push(Offered { model: model.clone(), server: i, tool: name.clone(), def: ToolDef { name: model, description, schema } });
            }
            let red = !card.org() && pairs.iter().zip(&s.servers[i].ceilings).any(|(p, c)| p.ai.redact_for_frontier.contains(c));
            s.redact.push(red);
        }
        // servers without an offered tool stay in the list (their index is used) but are never offered
        s
    }

    /// The tool definitions the model may use now: class gate under every pair, calls left.
    pub fn offered(&self) -> Vec<ToolDef> {
        self.tools.iter().filter(|t| self.class_ok(t.server) && self.calls.get(&t.server).copied().unwrap_or(0) < self.servers[t.server].s.max_calls).map(|t| t.def.clone()).collect()
    }

    /// Every definition the session ever offered (the final round keeps them while tool use is off).
    pub fn all(&self) -> Vec<ToolDef> {
        self.tools.iter().map(|t| t.def.clone()).collect()
    }

    /// The working class label under the last pair.
    fn working_label(&self) -> String {
        let p = self.pairs.len() - 1;
        self.pairs[p].ai.classes.get(self.working[p]).cloned().unwrap_or_default()
    }

    fn refuse(&mut self, i: usize, tool: &str, code: &str, args_bytes: usize, started: Instant) -> Output {
        let s = &self.servers[i].s;
        self.uses.push(Use { server: s.id.clone(), server_name: s.name.clone(), tool: tool.into(), outcome: "refused", args_bytes, result_bytes: 0, took_ms: started.elapsed().as_millis() as u64 });
        Output { text: format!("The tool was not called ({code})."), error: true, redact: false, server_name: s.name.clone(), tool: tool.into() }
    }

    /// One call the model asked for (8.6 to 8.8): checked, audited before the request opens, then sent with only the
    /// tool name and the model's arguments. A failure is given to the model as a tool error; the ask goes on.
    pub async fn call(&mut self, c: &ToolCall, now_ms: i64, left: std::time::Duration) -> Output {
        let started = Instant::now();
        let Some(pos) = self.tools.iter().position(|t| t.model == c.name) else {
            return Output { text: "There is no such tool.".into(), error: true, redact: false, server_name: String::new(), tool: c.name.clone() };
        };
        let (i, tool) = (self.tools[pos].server, self.tools[pos].tool.clone());
        if left.is_zero() {
            return self.refuse(i, &tool, "deadline", 0, started);
        }
        if !self.class_ok(i) {
            return self.refuse(i, &tool, "mcp-class", 0, started);
        }
        if self.calls.get(&i).copied().unwrap_or(0) >= self.servers[i].s.max_calls {
            return self.refuse(i, &tool, "mcp-calls", 0, started);
        }
        let args = match serde_json::from_str::<Value>(&c.args) {
            Ok(v) if v.is_object() => v,
            _ => return self.refuse(i, &tool, "mcp-args", c.args.len(), started),
        };
        let text = args.to_string();
        if text.len() > self.servers[i].s.args_max {
            return self.refuse(i, &tool, "mcp-args", text.len(), started);
        }
        *self.calls.entry(i).or_insert(0) += 1;
        let conf = self.servers[i].s.conf.clone();
        if let Err(f) = self.mcp.client.token(&conf, &self.mcp.creds, now_ms).await {
            let code = if f.code == "error" { "mcp-credential" } else { f.code };
            return self.refuse(i, &tool, code, text.len(), started);
        }
        let record = json!({
            "rid": self.asker.rid, "principal": self.asker.principal, "device": self.asker.device, "server": conf.id, "tool": tool,
            "args_bytes": text.len(), "working_class": self.working_label(), "gateway": self.mcp.me.1,
        });
        if self.audit.event("ai.mcp.call", record, now_ms).is_err() {
            return self.refuse(i, &tool, "audit-unavailable", text.len(), started);
        }
        // the request opens now: from here the model has seen this server's class (R6-7)
        for (p, pair) in self.pairs.iter().enumerate() {
            if let Some(r) = pair.ai.rank(&self.servers[i].ceilings[p]) {
                self.working[p] = self.working[p].max(r);
            }
        }
        let s = self.servers[i].s.clone();
        let got = self.mcp.client.call(&conf, &self.mcp.creds, &tool, args, s.result_max, now_ms, left).await;
        let took_ms = started.elapsed().as_millis() as u64;
        let (outcome, out_text, error, bytes) = match got {
            Ok(r) => (if r.error { "error" } else if r.cut { "cut" } else { "ok" }, r.text, r.error, r.bytes),
            Err(f) => (if f.code == "mcp-url" { "refused" } else { "error" }, format!("The tool failed ({}).", if f.code == "error" { "error" } else { f.code }), true, 0),
        };
        self.uses.push(Use { server: s.id.clone(), server_name: s.name.clone(), tool: tool.clone(), outcome, args_bytes: text.len(), result_bytes: bytes, took_ms });
        Output { text: out_text, error, redact: self.redact.get(i).copied().unwrap_or(false), server_name: s.name, tool }
    }
}

/// Group names the relay listed for a person (the `groups=1` answer), checked.
pub fn groups_of(v: &Value) -> Vec<String> {
    let mut g = strs(v.get("groups"));
    g.retain(|x| !x.is_empty());
    g
}

/// The `mcp` key of the ask's audit line and the answer's `tools_used`.
pub fn summaries(uses: &[Use]) -> (Vec<Value>, Vec<Value>) {
    (uses.iter().map(Use::record).collect(), uses.iter().map(Use::answer).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_gateway_audit::KEEP_DAYS;
    use crate::ai_gateway_mcp_client::{HttpReq, HttpResp, NetError, Sent};
    use crate::ai_mcp::testmaps::{map, server, tool_listing, SERVER_A, SERVER_B};
    use std::path::Path;
    use std::time::Duration;

    const ME: &str = "ai@apps.acme.example";
    /// A fixed clock inside every test credential's life.
    const NOW: i64 = 1_795_000_100_000;
    const LONG: Duration = Duration::from_secs(30);

    /// A fake MCP deployment: each server's metadata, one authorization server, and per host the tools it lists.
    /// It logs every MCP request and, at each `tools/call`, whether the gateway's audit already holds that call.
    struct Fake {
        audit_dir: PathBuf,
        listed: HashMap<String, Vec<String>>,
        log: Mutex<Vec<(String, String, Value)>>,
        audited_first: Mutex<Vec<bool>>,
    }

    fn host(url: &str) -> String {
        url.trim_start_matches("https://").split('/').next().unwrap_or_default().to_string()
    }

    fn calls_in_audit(dir: &Path) -> usize {
        std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| std::fs::read_to_string(e.path()).unwrap_or_default().matches("\"action\":\"ai.mcp.call\"").count()).sum()
    }

    impl Fake {
        fn new(audit_dir: &Path) -> Arc<Fake> {
            let listed = HashMap::from([
                ("3f2e.mcp.acme.example".to_string(), vec!["search_issues".to_string(), "delete_issue".to_string(), "get_issue".to_string()]),
                ("0123.mcp.acme.example".to_string(), vec!["read_page".to_string()]),
            ]);
            Arc::new(Fake { audit_dir: audit_dir.to_path_buf(), listed, log: Mutex::new(Vec::new()), audited_first: Mutex::new(Vec::new()) })
        }

        fn answer(&self, req: HttpReq) -> Result<HttpResp, NetError> {
            let ok = |v: Value| Ok(HttpResp { status: 200, content_type: "application/json".into(), body: v.to_string().into_bytes() });
            let h = host(&req.url);
            if req.url.contains("/.well-known/oauth-protected-resource") {
                return ok(json!({"resource": format!("https://{h}/mcp"), "authorization_servers": ["https://auth.acme.example"]}));
            }
            if req.url == "https://auth.acme.example/.well-known/oauth-authorization-server" {
                return ok(json!({"issuer": "https://auth.acme.example", "token_endpoint": "https://auth.acme.example/token"}));
            }
            if req.url == "https://auth.acme.example/token" {
                self.log.lock().push((h, "token".into(), json!(String::from_utf8_lossy(&req.body))));
                return ok(json!({"access_token": "tok", "token_type": "Bearer", "expires_in": 3600}));
            }
            let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
            let method = body["method"].as_str().unwrap_or_default().to_string();
            let id = body["id"].clone();
            self.log.lock().push((h.clone(), method.clone(), body.clone()));
            let result = match method.as_str() {
                "server/discover" => json!({"supportedVersions": ["2025-11-25", "2026-07-28"]}),
                "tools/list" => json!({"tools": self.listed.get(&h).into_iter().flatten().map(|n| tool_listing(n)).collect::<Vec<_>>(), "ttlMs": 60_000}),
                "tools/call" => {
                    let before = self.log.lock().iter().filter(|(_, m, _)| m == "tools/call").count();
                    self.audited_first.lock().push(calls_in_audit(&self.audit_dir) >= before);
                    json!({"content": [{"type": "text", "text": format!("RESULT from {h}")}]})
                }
                _ => return Ok(HttpResp { status: 404, content_type: String::new(), body: Vec::new() }),
            };
            ok(json!({"jsonrpc": "2.0", "id": id, "result": result}))
        }

        fn calls_to(&self, h: &str) -> usize {
            self.log.lock().iter().filter(|(x, m, _)| x == h && m == "tools/call").count()
        }
    }

    impl Transport for Fake {
        fn send(&self, req: HttpReq) -> Sent<'_> {
            let r = self.answer(req);
            Box::pin(async move { r })
        }
    }

    /// The test policy (classes public < internal < confidential < cui, `who.groups` eng) and a pair for `map`.
    fn pair_with(m: &Value) -> Pair {
        let mut p = crate::ai_gateway_policy::testpairs::policy(3, &["org"], "none", &[], &[]);
        p.get_mut("ai").unwrap()["who"] = json!({"groups": ["eng"]});
        Pair::from_parts(&"01".repeat(32), p.clone(), m, json!({"policy": p, "map": {"map": m}})).unwrap()
    }

    fn card() -> Card {
        crate::ai_gateway_cards::check_card(&crate::ai_gateway_cards::testcards::org_card("llama", "https://vllm.acme.example:8000/v1", &["public", "internal", "confidential", "cui"])).unwrap()
    }

    struct World {
        mcp: Mcp,
        fake: Arc<Fake>,
        audit: Audit,
        audit_dir: PathBuf,
    }

    /// A gateway's MCP state with its own key registered for each server id given.
    fn world(name: &str, servers: &[&str]) -> (World, HashMap<String, String>) {
        let dir = crate::meet_tls::testpki::dir(name);
        let audit_dir = dir.join("audit");
        let audit = Audit::open(&audit_dir, KEEP_DAYS).unwrap();
        let fake = Fake::new(&audit_dir);
        let mcp = Mcp::open(&dir, "acme", (ME.into(), "a1a1a1a1a1a1a1a1".into()), fake.clone());
        let kids = servers.iter().map(|s| (s.to_string(), mcp.creds.make_key(s).unwrap().0)).collect();
        (World { mcp, fake, audit, audit_dir }, kids)
    }

    fn keyed(mut s: Value, kids: &HashMap<String, String>) -> Value {
        let id = s["id"].as_str().unwrap().to_string();
        s["auth"]["kids"] = json!({ME: kids[&id]});
        s
    }

    fn asker() -> Asker<'static> {
        Asker { rid: "ab12ab12ab12ab12ab12ab12ab12ab12", principal: "ann@acme.example", device: "0123456789abcdef", activity: "search" }
    }

    fn call(name: &str, args: &str) -> ToolCall {
        ToolCall { id: "c".into(), name: name.into(), args: args.into() }
    }

    fn eng() -> Vec<String> {
        vec!["eng".to_string()]
    }

    /// 8.1, 8.5: only the map's tools with their approved hash are offered, only to a member of a listed group in a
    /// listed activity; a changed description is not offered and is reported.
    #[tokio::test]
    async fn the_allow_list_decides_which_tools_are_offered_and_to_whom() {
        let (w, kids) = world("mcp-allow", &[SERVER_A]);
        let mut a = keyed(server(SERVER_A, "Jira", "internal", &["search_issues", "get_issue"]), &kids);
        a["tools"][1]["schema_sha256"] = json!("00".repeat(32));
        let pairs = vec![pair_with(&map(vec![a]))];
        let s = Session::open(&w.mcp, &w.audit, asker(), &pairs, vec![1], &card(), &eng(), NOW).await;
        let names: Vec<String> = s.offered().into_iter().map(|d| d.name).collect();
        assert_eq!(names, ["t1_search_issues"], "delete_issue is not in the map and get_issue changed");
        assert!(w.mcp.changed.lock().contains_key(&(SERVER_A.to_string(), "get_issue".to_string())));
        let state = w.mcp.state(Some(&map_of(&pairs[0])), NOW);
        assert_eq!(state["servers"][0]["tools"][1]["why"], "mcp-tool-changed");
        // outside the groups, or in another activity: nothing, and nothing is asked of the server
        let before = w.fake.log.lock().len();
        let none = Session::open(&w.mcp, &w.audit, asker(), &pairs, vec![1], &card(), &["sales".to_string()], NOW).await;
        assert!(none.all().is_empty());
        let notes = Asker { activity: "notes", ..asker() };
        assert!(Session::open(&w.mcp, &w.audit, notes, &pairs, vec![1], &card(), &eng(), NOW).await.all().is_empty());
        assert_eq!(w.fake.log.lock().len(), before);
    }

    /// R6-7: the working class rises to each called server's ceiling, so after an internal ask has called a cui server
    /// it cannot call an internal one: no data flows from the higher class to the lower.
    #[tokio::test]
    async fn the_working_class_rises_after_each_call_and_no_data_flows_down() {
        let (w, kids) = world("mcp-class", &[SERVER_A, SERVER_B]);
        let a = keyed(server(SERVER_A, "Jira", "internal", &["search_issues"]), &kids);
        let b = keyed(server(SERVER_B, "Vault", "cui", &["read_page"]), &kids);
        let pairs = vec![pair_with(&map(vec![a, b]))];
        let mut s = Session::open(&w.mcp, &w.audit, asker(), &pairs, vec![1], &card(), &eng(), NOW).await;
        assert_eq!(s.offered().len(), 2);
        let first = s.call(&call("t1_search_issues", "{\"q\":\"tampa\"}"), NOW, LONG).await;
        assert!(!first.error);
        assert_eq!(s.working_label(), "internal");
        let second = s.call(&call("t2_read_page", "{\"q\":\"tampa\"}"), NOW, LONG).await;
        assert_eq!(second.text, "RESULT from 0123.mcp.acme.example");
        assert_eq!(s.working_label(), "cui");
        assert_eq!(s.offered().into_iter().map(|d| d.name).collect::<Vec<_>>(), ["t2_read_page"]);
        let refused = s.call(&call("t1_search_issues", "{\"q\":\"what the vault said\"}"), NOW, LONG).await;
        assert!(refused.error && refused.text.contains("mcp-class"));
        assert_eq!(w.fake.calls_to("3f2e.mcp.acme.example"), 1, "the internal server got nothing after the cui call");
        let outcomes: Vec<&str> = s.uses.iter().map(|u| u.outcome).collect();
        assert_eq!(outcomes, ["ok", "ok", "refused"]);
        // a cui ask never reaches the internal server at all
        let cui = Session::open(&w.mcp, &w.audit, asker(), &pairs, vec![3], &card(), &eng(), NOW).await;
        assert_eq!(cui.offered().into_iter().map(|d| d.name).collect::<Vec<_>>(), ["t1_read_page"]);
    }

    /// 8.8: an `ai.mcp.call` line is fsynced before each request opens, with sizes and no arguments; when it cannot
    /// be written the call is not made.
    #[tokio::test]
    async fn each_call_is_audited_before_it_is_sent() {
        let (w, kids) = world("mcp-audit", &[SERVER_A]);
        let mut a = keyed(server(SERVER_A, "Jira", "internal", &["search_issues"]), &kids);
        a["max_calls"] = json!(2);
        a["args_max"] = json!(256);
        let pairs = vec![pair_with(&map(vec![a]))];
        let mut s = Session::open(&w.mcp, &w.audit, asker(), &pairs, vec![1], &card(), &eng(), NOW).await;
        s.call(&call("t1_search_issues", "{\"q\":\"secret words\"}"), NOW, LONG).await;
        s.call(&call("t1_search_issues", "{\"q\":\"more\"}"), NOW, LONG).await;
        assert_eq!(*w.fake.audited_first.lock(), [true, true]);
        let lines = w.audit.since(0);
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0]["action"].as_str(), lines[0]["server"].as_str(), lines[0]["working_class"].as_str()), (Some("ai.mcp.call"), Some(SERVER_A), Some("internal")));
        assert!(!lines[0].to_string().contains("secret words"));
        // max_calls, then args_max
        let over = s.call(&call("t1_search_issues", "{}"), NOW, LONG).await;
        assert!(over.text.contains("mcp-calls"));
        let mut t = Session::open(&w.mcp, &w.audit, asker(), &pairs, vec![1], &card(), &eng(), NOW).await;
        let big = format!("{{\"q\":\"{}\"}}", "x".repeat(300));
        assert!(t.call(&call("t1_search_issues", &big), NOW, LONG).await.text.contains("mcp-args"));
        // the audit cannot be written: no request
        std::fs::remove_dir_all(&w.audit_dir).unwrap();
        let sent = w.fake.calls_to("3f2e.mcp.acme.example");
        let gone = t.call(&call("t1_search_issues", "{}"), NOW, LONG).await;
        assert!(gone.text.contains("audit-unavailable"));
        assert_eq!(w.fake.calls_to("3f2e.mcp.acme.example"), sent);
    }

    /// 8.2: tightening applies in order and survives a restart; folding by containment; `mcp_off` only by clearing.
    #[test]
    fn the_journal_tightens_folds_and_clears() {
        let (w, kids) = world("mcp-journal", &[SERVER_A]);
        let a = keyed(server(SERVER_A, "Jira", "internal", &["search_issues", "get_issue"]), &kids);
        let m1 = map(vec![a.clone()]);
        let entry = |tseq: u64, action: &str, target: Value| json!({"id": m::journal_id("acme", tseq), "tseq": tseq, "ts": 1_795_000_050, "action": action, "target": target});
        let gap = w.mcp.tighten(&json!({"org": "acme", "entries": [entry(2, "mcp_off", json!("acme"))]}), Some(&m1));
        assert_eq!((gap.0, gap.1["code"].as_str()), (409, Some("tseq-gap")));
        let (status, v) = w.mcp.tighten(&json!({"org": "acme", "entries": [entry(1, "mcp_tool_off", json!({"server": SERVER_A, "tool": "get_issue"})), entry(2, "mcp_lower_ceiling", json!({"server": SERVER_A, "ceiling": "public"}))]}), Some(&m1));
        assert_eq!((status, v["tseq"].as_u64()), (200, Some(2)));
        let eff = w.mcp.effective(&m1);
        assert_eq!((eff[0].tools.len(), eff[0].ceiling.as_str()), (1, "public"));
        // a resend is safe; a restart keeps the journal
        assert_eq!(w.mcp.tighten(&json!({"org": "acme", "entries": [entry(1, "mcp_tool_off", json!({"server": SERVER_A, "tool": "get_issue"}))]}), Some(&m1)).0, 200);
        let again = Mcp::open(w.mcp.journal_path.parent().unwrap().parent().unwrap(), "acme", (ME.into(), "a1a1a1a1a1a1a1a1".into()), w.fake.clone());
        assert_eq!(again.effective(&m1)[0].ceiling, "public");
        // a map without get_issue folds that entry; the ceiling entry stays until the map is at or below it
        let mut b = a.clone();
        b["tools"] = json!([a["tools"][0].clone()]);
        let m2 = map(vec![b]);
        again.on_pin(&m2);
        assert_eq!(again.state(Some(&m2), NOW)["journal"]["active"], json!([m::journal_id("acme", 2)]));
        // mcp_off: nothing is offered until a newer map clears it
        assert_eq!(again.tighten(&json!({"org": "acme", "entries": [entry(3, "mcp_off", json!("acme"))]}), Some(&m2)).0, 200);
        assert!(again.effective(&m2).is_empty());
        again.on_pin(&m2);
        assert!(again.effective(&m2).is_empty());
        let mut m3 = m2.clone();
        m3["issued"] = json!(1_795_000_060);
        m3["mcp_cleared"] = json!([m::journal_id("acme", 3)]);
        again.on_pin(&m3);
        assert_eq!(again.effective(&m3).len(), 1);
        let widening = again.tighten(&json!({"org": "acme", "entries": [entry(4, "mcp_on", json!("acme"))]}), Some(&m3));
        assert_eq!(widening.1["code"], "not-tightening");
    }

    /// A fold that cannot be written changes nothing (the entry stays active in memory and on disk) and is tried
    /// again until it is written.
    #[test]
    fn a_fold_is_kept_only_once_it_is_written() {
        let (w, kids) = world("mcp-fold-unsaved", &[SERVER_A]);
        let a = keyed(server(SERVER_A, "Jira", "internal", &["search_issues", "get_issue"]), &kids);
        let m1 = map(vec![a.clone()]);
        let off = json!({"id": m::journal_id("acme", 1), "tseq": 1, "ts": 1_795_000_050, "action": "mcp_tool_off", "target": {"server": SERVER_A, "tool": "get_issue"}});
        assert_eq!(w.mcp.tighten(&json!({"org": "acme", "entries": [off]}), Some(&m1)).0, 200);
        let mut b = a.clone();
        b["tools"] = json!([a["tools"][0].clone()]);
        let m2 = map(vec![b]);
        // the journal file cannot be replaced: a folder stands where it goes
        let path = w.mcp.journal_path.clone();
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir_all(path.join("blocked")).unwrap();
        w.mcp.on_pin(&m2);
        assert!(w.mcp.fold_due());
        assert_eq!(w.mcp.state(Some(&m2), NOW)["journal"]["active"], json!([m::journal_id("acme", 1)]));
        std::fs::remove_dir_all(&path).unwrap();
        w.mcp.on_pin(&m2);
        assert!(!w.mcp.fold_due());
        assert_eq!(w.mcp.state(Some(&m2), NOW)["journal"]["active"], json!([]));
        let reread = Mcp::open(path.parent().unwrap().parent().unwrap(), "acme", (ME.into(), "a1a1a1a1a1a1a1a1".into()), w.fake.clone());
        assert_eq!(reread.state(Some(&m2), NOW)["journal"]["active"], json!([]));
    }
}
