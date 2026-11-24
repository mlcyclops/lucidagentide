// Settings > AI > Tools (MCP): the Admin Console half of contract r6 section 8 (slice API-1d6). The AI map's
// `mcp_servers` are staged through the AI save (8.1, 8.11), each server carrying the attestation of the two admins who
// request and approve that save (R6-8, 13); nothing with `mcp_servers` or `mcp_cleared` is staged before every reader
// reads them (8.1, 14); the gateway journal of 8.2 is kept per organization in console-ai.json with an acknowledgment
// per gateway, sent to every gateway at once and again every minute until acknowledged; a widening that undoes an
// entry in force stages its id in `mcp_cleared`; credentials (8.4) and tests (8.9) are proxied to the gateways.
//
// A child module of console_meet.rs (declared there with #[path]) so it shares the Settings > AI state and helpers.
// The pure rules come first, with their unit tests at the end; the routes are the `impl MeetSection` block.

use super::*;
use crate::ai_mcp as mcp;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};

/// The gateway admin routes of 8.9.
const STATE_PATH: &str = "/v1/ai/admin/mcp/state";
const TIGHTEN_PATH: &str = "/v1/ai/admin/mcp/tighten";
/// A journal id carries 6 digits (`g_<org>_000001`).
const TSEQ_MAX: u64 = 999_999;
const STATEMENT_MAX: usize = 512;
const WARN_DAYS: i64 = 30;
const BAD_DAYS: i64 = 7;
const DAY: i64 = 86_400;
/// Entries only an admin's explicit `clear` undoes: a server or all of MCP turned off, a dropped credential.
const CLEAR_EXPLICIT: [&str; 3] = ["mcp_off", "mcp_server_off", "mcp_credential_drop"];

// ── words (the page shows the same text from the AC-2a words: mcp.statement, mcp.scope-mtls, mcp.risk) ──────────

pub const STATEMENT: &str = "Every member of <groups> may read everything the <scope> credential of <server> can read.";
pub const SCOPE_MTLS: &str = "client certificate";
pub const RISK: &str = "The gateway calls <server> with its own credential, not the person's: any member of <groups> may reach, through the model, everything that credential can read, even records the source system would not show them.";

// ── console words (not given by the contract) ─────────────────────────────────────────────────────────────────

pub const EDITION: &str = "Tools (MCP) need the Enterprise edition of the Meeting Hub license.";
pub const TOO_SOON: &str = "Tools (MCP) need every Meeting Hub and iPhone app at 0.99.0 or later. Raise the relay's minimum app versions first.";
pub const GATEWAY_OLD: &str = "The AI gateway <gateway> does not read MCP servers yet. Update it first.";
pub const GATEWAY_SILENT: &str = "The AI gateway <gateway> did not answer, so the console cannot tell whether it reads MCP servers: <why>";
pub const SECOND: &str = "Name the second admin who attests this server: an admin's email other than yours.";
pub const ATTEST_NEEDED: &str = "<server> adds a group or tool, changes a tool, raises its ceiling, changes its address, scope or credential, or allows a private address, so it needs a new attestation: name the second admin.";
pub const APPROVER: &str = "This save carries the attestation of <by>, so those two admins must request and approve it.";
pub const SERVER_OBJECT: &str = "server must be an MCP server object.";
pub const SERVER_ID: &str = "server must be an MCP server id (m_ and 16 lower-case hex digits).";
pub const SERVER_TAKEN: &str = "An MCP server with this id is already listed.";
pub const NOT_SIGNED: &str = "this MCP server is not in the signed AI map; change the staged settings instead";
pub const CLEAR_UNKNOWN: &str = "<id> is not an entry in force for this organization.";
pub const CLEAR_LIST: &str = "clear must be a list of journal ids.";
pub const JOURNAL_FULL: &str = "the journal of this organization is full";
pub const NO_GATEWAY: &str = "no AI gateway is enrolled for this organization";
pub const OP: &str = "op is key, csr or cert.";
pub const CERT: &str = "cert_pem must be a PEM certificate.";
pub const GATEWAY: &str = "gateway must be one of this organization's AI gateways.";
pub const NO_ANSWER: &str = "no AI gateway answered";

fn fill(words: &str, args: &[(&str, &str)]) -> String {
    args.iter().fold(words.to_owned(), |w, (k, v)| w.replace(&format!("<{k}>"), v))
}

fn txt(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}

/// The servers of a map (none for no map).
pub(crate) fn servers(map: Option<&Value>) -> Vec<Value> {
    map.and_then(|m| m.get("mcp_servers")).and_then(Value::as_array).cloned().unwrap_or_default()
}

pub(crate) fn find<'a>(map: Option<&'a Value>, id: &str) -> Option<&'a Value> {
    map.and_then(|m| m.get("mcp_servers")).and_then(Value::as_array).and_then(|a| a.iter().find(|s| s.get("id").and_then(Value::as_str) == Some(id)))
}

fn new_server_id() -> String {
    format!("m_{}", crate::codec::hex(&pj::random_bytes(8)))
}

fn principal_of(v: Option<&Value>) -> String {
    pj::str_or(v).trim().to_lowercase()
}

/// The second admin of an attestation: an email other than the caller's, or None when not given.
pub(crate) fn second_of(body: &Value, caller: &str) -> Result<Option<String>, String> {
    let second = principal_of(body.get("second"));
    if second.is_empty() {
        return Ok(None);
    }
    if !second.contains('@') || second == caller.trim().to_lowercase() {
        return Err(SECOND.into());
    }
    Ok(Some(second))
}

// ── the attestation (8.1, R6-8, 13) ───────────────────────────────────────────────────────────────────────────

/// The statement the console pre-fills: "Every member of <groups> may read everything the <scope> credential of
/// <server> can read." (`mtls_only` has no scope: "client certificate").
pub(crate) fn statement(server: &Value) -> String {
    let groups = strs(server.get("groups")).join(", ");
    let auth = server.get("auth");
    let scope = if auth.and_then(|a| a.get("type")).and_then(Value::as_str) == Some("mtls_only") {
        SCOPE_MTLS.to_owned()
    } else {
        auth.map(|a| txt(a, "scope")).unwrap_or_default()
    };
    let words = fill(STATEMENT, &[("groups", &groups), ("scope", &scope), ("server", &txt(server, "name"))]);
    words.chars().filter(|c| *c >= ' ' && *c != '\u{7f}').take(STATEMENT_MAX).collect()
}

/// The residual risk of a server (8.6, R6-8), shown on the server page and in the two-person approval.
pub(crate) fn risk(server: &Value) -> String {
    fill(RISK, &[("server", &txt(server, "name")), ("groups", &strs(server.get("groups")).join(", "))])
}

pub(crate) fn attest(by: [&str; 2], at: i64, server: &Value) -> Value {
    json!({"by": [by[0].trim().to_lowercase(), by[1].trim().to_lowercase()], "at": at, "statement": statement(server)})
}

/// Whether `next` needs a new attestation against the signed server `old` (13): a new server, an added group or
/// tool, a changed tool hash, a raised ceiling, `private_ok` set, or a changed address, scope or credential.
pub(crate) fn needs_attest(old: Option<&Value>, next: &Value) -> bool {
    let Some(old) = old else { return true };
    let old_groups = strs(old.get("groups"));
    if strs(next.get("groups")).iter().any(|g| !old_groups.contains(g)) {
        return true;
    }
    let tools = |s: &Value| -> Vec<(String, String)> {
        s.get("tools").and_then(Value::as_array).map(|a| a.iter().map(|t| (txt(t, "name"), txt(t, "schema_sha256"))).collect()).unwrap_or_default()
    };
    let old_tools = tools(old);
    if tools(next).iter().any(|(n, h)| !old_tools.iter().any(|(on, oh)| on == n && oh == h)) {
        return true;
    }
    let rank = |s: &Value| mcp::ceiling_rank(&txt(s, "ceiling"));
    match (rank(old), rank(next)) {
        (Some(o), Some(n)) if n <= o => {}
        _ => return true,
    }
    if next.get("private_ok") == Some(&Value::Bool(true)) && old.get("private_ok") != Some(&Value::Bool(true)) {
        return true;
    }
    if txt(old, "url") != txt(next, "url") {
        return true;
    }
    let (oa, na) = (old.get("auth").cloned().unwrap_or(Value::Null), next.get("auth").cloned().unwrap_or(Value::Null));
    ["type", "issuer", "client_id", "scope"].iter().any(|k| oa.get(*k) != na.get(*k))
}

/// The server's attestation is new against the signed map (absent there, or a different `attest`).
pub(crate) fn attest_new(current: Option<&Value>, server: &Value) -> bool {
    let attest = server.get("attest").filter(|a| a.is_object());
    attest.is_some() && find(current, &txt(server, "id")).and_then(|o| o.get("attest")) != attest
}

/// The attestation an update carries: a new one with `second`; the signed one when nothing needs a new one; the
/// staged change's own new one (the same two admins, the caller among them) refreshed; else refused.
pub(crate) fn choose_attest(signed: Option<&Value>, staged: Option<&Value>, next: &Value, caller: &str, second: Option<&str>, now: i64) -> Result<Value, String> {
    if let Some(second) = second {
        return Ok(attest([caller, second], now, next));
    }
    let signed_attest = signed.and_then(|s| s.get("attest")).filter(|a| a.is_object());
    if !needs_attest(signed, next) {
        if let Some(a) = signed_attest {
            return Ok(a.clone());
        }
    }
    if let Some(a) = staged.filter(|a| a.is_object() && Some(*a) != signed_attest) {
        let by = strs(a.get("by"));
        if by.len() == 2 && by.iter().any(|b| b.eq_ignore_ascii_case(caller.trim())) {
            return Ok(json!({"by": by, "at": now, "statement": statement(next)}));
        }
    }
    Err(fill(ATTEST_NEEDED, &[("server", &txt(next, "name"))]))
}

/// At staging (r6 17.5): every server that needs an attestation against the signed map carries a new one.
pub(crate) fn check_attest_staging(current: Option<&Value>, next: &Value) -> Result<(), String> {
    for s in servers(Some(next)) {
        let old = find(current, &txt(&s, "id"));
        if needs_attest(old, &s) && !attest_new(current, &s) {
            return Err(fill(ATTEST_NEEDED, &[("server", &txt(&s, "name"))]));
        }
    }
    Ok(())
}

/// The two-person set of every new attestation of `next` (8.1: the approvers of the save that adds or widens it).
fn new_attest_sets(current: Option<&Value>, next: &Value) -> Vec<BTreeSet<String>> {
    servers(Some(next)).iter().filter(|s| attest_new(current, s)).map(|s| strs(s.get("attest").and_then(|a| a.get("by"))).iter().map(|b| b.to_lowercase()).collect()).collect()
}

/// When the approved save runs: {requester, approver} equals the `attest.by` of every new attestation. The sole-admin
/// path (no approver) cannot carry one.
pub(crate) fn check_attest_save(current: Option<&Value>, next: &Value, requested_by: &str, approved_by: Option<&str>) -> Result<(), String> {
    for by in new_attest_sets(current, next) {
        let pair: BTreeSet<String> = [Some(requested_by), approved_by].into_iter().flatten().map(|p| p.trim().to_lowercase()).collect();
        if approved_by.is_none() || pair != by {
            return Err(fill(APPROVER, &[("by", &by.into_iter().collect::<Vec<_>>().join(" and "))]));
        }
    }
    Ok(())
}

/// Who may approve such a save: an admin named in every new attestation.
pub(crate) fn may_approve(current: Option<&Value>, next: &Value, approver: &str) -> bool {
    let a = approver.trim().to_lowercase();
    new_attest_sets(current, next).iter().all(|by| by.contains(&a))
}

// ── readers first (8.1, 14) ───────────────────────────────────────────────────────────────────────────────────

/// A gateway's answer to `GET /v1/ai/admin/mcp/state`: the state, or (it answered with a refusal, the words).
pub(crate) type GatewayAnswer = Result<Value, (bool, String)>;

/// A map with `mcp_servers` or `mcp_cleared` is staged only with the Enterprise edition, Hub and iPhone minimums at
/// `AI_MCP_CLIENTS` or later, and every enrolled gateway reading both keys.
pub(crate) fn readers_first(edition: Option<&str>, minimums: &Obj, gateways: &[(String, GatewayAnswer)]) -> Result<(), String> {
    if edition != Some("enterprise") {
        return Err(EDITION.into());
    }
    let ready = mcp::AI_MCP_CLIENTS.iter().all(|(app, least)| minimums.get(*app).is_some_and(|v| m::version_key(&pj::py_str(v)) >= m::version_key(least)));
    if !ready {
        return Err(TOO_SOON.into());
    }
    for (url, answer) in gateways {
        match answer {
            Ok(v) => {
                let reads = strs(v.get("reads"));
                if !mcp::MCP_READS.iter().all(|k| reads.iter().any(|r| r == k)) {
                    return Err(fill(GATEWAY_OLD, &[("gateway", url)]));
                }
            }
            // an older gateway answers 404 (a refusal): it does not read the keys
            Err((true, _)) => return Err(fill(GATEWAY_OLD, &[("gateway", url)])),
            Err((false, why)) => return Err(fill(GATEWAY_SILENT, &[("gateway", url), ("why", why)])),
        }
    }
    Ok(())
}

// ── the journal (8.2) ─────────────────────────────────────────────────────────────────────────────────────────

fn entry_of(e: &Value) -> mcp::Entry {
    mcp::Entry {
        id: txt(e, "id"),
        tseq: e.get("tseq").and_then(Value::as_u64).unwrap_or(0),
        ts: e.get("ts").and_then(Value::as_i64).unwrap_or(0),
        action: txt(e, "action"),
        target: e.get("target").cloned().unwrap_or(Value::Null),
    }
}

fn target_server(e: &Value) -> String {
    match e.get("target") {
        Some(Value::String(s)) => s.clone(),
        Some(t) => txt(t, "server"),
        None => String::new(),
    }
}

fn done(e: &Value) -> bool {
    e.get("done") == Some(&Value::Bool(true))
}

/// The org's journal in console-ai.json (`mcp: {head, journal, acks}`): entries `{id, tseq, ts, action, target}` plus
/// the console's own `dropped_expires` (a credential drop) and `done` (no gateway holds it in force any more), and
/// the acknowledged `tseq` per gateway url.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Book {
    pub head: u64,
    pub entries: Vec<Value>,
    pub acks: BTreeMap<String, u64>,
}

impl Book {
    pub fn of(entry: &Obj) -> Book {
        let b = entry.get("mcp");
        let acks = b.and_then(|b| b.get("acks")).and_then(Value::as_object).map(|o| o.iter().filter_map(|(k, v)| v.as_u64().map(|n| (k.clone(), n))).collect()).unwrap_or_default();
        Book {
            head: b.and_then(|b| b.get("head")).and_then(Value::as_u64).unwrap_or(0),
            entries: b.and_then(|b| b.get("journal")).and_then(Value::as_array).cloned().unwrap_or_default(),
            acks,
        }
    }

    pub fn put(&self, entry: &mut Obj) {
        entry.insert("mcp".into(), json!({"head": self.head, "journal": self.entries, "acks": self.acks}));
    }

    /// Journal one entry; its id is `g_<org>_<tseq>`.
    pub fn add(&mut self, org: &str, ts: i64, action: &str, target: Value, dropped_expires: Option<i64>) -> Result<String, String> {
        if self.head >= TSEQ_MAX {
            return Err(JOURNAL_FULL.into());
        }
        let tseq = self.head + 1;
        let id = mcp::journal_id(org, tseq);
        let mut e = json!({"id": id, "tseq": tseq, "ts": ts, "action": action, "target": target});
        if let Some(x) = dropped_expires {
            e["dropped_expires"] = Value::from(x);
        }
        self.entries.push(e);
        self.head = tseq;
        Ok(id)
    }

    pub fn ack(&self, url: &str) -> u64 {
        self.acks.get(url).copied().unwrap_or(0)
    }

    /// A gateway's head (its tighten answer or its state): what it holds now, so a gateway that lost its journal is
    /// sent everything again.
    pub fn acked(&mut self, url: &str, head: u64) {
        self.acks.insert(url.to_owned(), head.min(self.head));
    }

    /// The entries `url` has not acknowledged, as sent (`POST /v1/ai/admin/mcp/tighten` takes them in tseq order).
    pub fn pending(&self, url: &str) -> Vec<Value> {
        let ack = self.ack(url);
        self.entries.iter().filter(|e| e.get("tseq").and_then(Value::as_u64).unwrap_or(0) > ack).map(|e| entry_of(e).to_json()).collect()
    }

    /// The entries some gateway may still hold in force.
    pub fn open(&self) -> Vec<&Value> {
        self.entries.iter().filter(|e| !done(e)).collect()
    }

    /// The open entries journaled at or after `since` (the signed map's issued): no map has folded them yet.
    pub fn recent_open(&self, since: i64) -> Vec<&Value> {
        self.entries.iter().filter(|e| !done(e) && e.get("ts").and_then(Value::as_i64).unwrap_or(0) >= since).collect()
    }

    /// The gateways' state answers (`journal.head`, `journal.active`) as acknowledgments; an entry is done when every
    /// enrolled gateway answered past it without it in force, or when the signed map cleared it.
    pub fn settle(&mut self, map: Option<&Value>, answered: &[(String, Value)], gateways: usize) {
        let head_of = |v: &Value| v.get("journal").and_then(|j| j.get("head")).and_then(Value::as_u64);
        for (url, v) in answered {
            if let Some(h) = head_of(v) {
                self.acked(url, h);
            }
        }
        let all = gateways > 0 && answered.len() == gateways;
        for e in self.entries.iter_mut().filter(|e| !done(e)) {
            let x = entry_of(e);
            let gone = all
                && answered.iter().all(|(_, v)| {
                    head_of(v).unwrap_or(0) >= x.tseq && !strs(v.get("journal").and_then(|j| j.get("active"))).contains(&x.id)
                });
            if gone || map.is_some_and(|m| mcp::cleared(&x, m)) {
                e["done"] = Value::Bool(true);
            }
        }
    }

    pub fn view(&self) -> Vec<Value> {
        self.entries
            .iter()
            .map(|e| {
                let mut v = entry_of(e).to_json();
                v["state"] = Value::from(if done(e) { "done" } else { "active" });
                v
            })
            .collect()
    }
}

/// The 8.2 entries a change from the signed map to `next` journals at once (`narrowings`, section 6 order), without
/// those already open since the signed map; a credential drop records the signed `auth.expires`.
pub(crate) fn to_journal(current: &Value, next: &Value, recent: &[&Value]) -> Vec<(String, Value, Option<i64>)> {
    mcp::narrowings(current, next)
        .into_iter()
        .filter(|(a, t)| !recent.iter().any(|e| txt(e, "action") == *a && e.get("target") == Some(t)))
        .map(|(a, t)| {
            let expires = (a == "mcp_credential_drop").then(|| find(Some(current), t.as_str().unwrap_or("")).and_then(|s| s.pointer("/auth/expires")).and_then(Value::as_i64)).flatten();
            (a, t, expires)
        })
        .collect()
}

/// The open entries `next` contradicts (a widening that undoes them), which its `mcp_cleared` must list: the server is
/// in `next` and `next` does not contain the restriction. A server or MCP turned off and a dropped credential are
/// cleared only explicitly.
pub(crate) fn auto_cleared(open: &[&Value], next: &Value) -> Vec<String> {
    open.iter()
        .filter(|e| !CLEAR_EXPLICIT.contains(&txt(e, "action").as_str()))
        .filter(|e| find(Some(next), &target_server(e)).is_some())
        .filter(|e| !mcp::folds(&entry_of(e), next, e.get("dropped_expires").and_then(Value::as_i64)))
        .map(|e| txt(e, "id"))
        .collect()
}

/// The contradicted entries plus the explicit `clear` ids, each an open entry of the org.
pub(crate) fn cleared_ids(book: &Book, next: &Value, explicit: &[String]) -> Result<Vec<String>, String> {
    let open = book.open();
    let mut out = auto_cleared(&open, next);
    for id in explicit {
        if !open.iter().any(|e| txt(e, "id") == *id) {
            return Err(fill(CLEAR_UNKNOWN, &[("id", &clean(id))]));
        }
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    Ok(out)
}

/// The base map's `mcp_cleared` plus `ids` (a gateway that missed the clearing map still clears them from a later
/// one), at most the newest 1000.
pub(crate) fn merge_cleared(base: Option<&Value>, ids: &[String]) -> Vec<String> {
    let mut all = strs(base.and_then(|b| b.get("mcp_cleared")));
    for id in ids {
        if !all.contains(id) {
            all.push(id.clone());
        }
    }
    if all.len() > mcp::MCP_CLEARED_MAX {
        all.drain(..all.len() - mcp::MCP_CLEARED_MAX);
    }
    all
}

// ── the page ──────────────────────────────────────────────────────────────────────────────────────────────────

fn warn(out: &mut Vec<Value>, server: &Value, gateway: Option<&str>, ends: i64, now: i64) {
    let days = (ends - now).div_euclid(DAY);
    if ends > now && days > WARN_DAYS {
        return;
    }
    let severity = if ends <= now || days <= BAD_DAYS { "bad" } else { "warn" };
    out.push(json!({"server": txt(server, "id"), "name": txt(server, "name"), "gateway": gateway, "ends": ends, "days": days.max(0), "ended": ends <= now, "severity": severity}));
}

/// Credential warnings 30 and 7 days ahead (8.4): the map's `auth.expires`, and each gateway's certificate.
pub(crate) fn warnings(map: Option<&Value>, gateways: &[(String, GatewayAnswer)], now: i64) -> Vec<Value> {
    let mut out = Vec::new();
    for s in servers(map) {
        if let Some(ends) = s.pointer("/auth/expires").and_then(Value::as_i64) {
            warn(&mut out, &s, None, ends, now);
        }
    }
    for (url, answer) in gateways {
        let Ok(v) = answer else { continue };
        for s in v.get("servers").and_then(Value::as_array).into_iter().flatten() {
            if let Some(ends) = s.pointer("/credential/not_after").and_then(Value::as_i64).filter(|n| *n > 0) {
                warn(&mut out, s, Some(url.as_str()), ends, now);
            }
        }
    }
    out
}

/// `AiMcpToolChanged` (8.5): each tool whose listed hash differs from the map's, by gateway.
pub(crate) fn tool_changes(map: Option<&Value>, gateways: &[(String, GatewayAnswer)]) -> Vec<Value> {
    let mut out = Vec::new();
    for (url, answer) in gateways {
        let Ok(v) = answer else { continue };
        for c in v.get("changed").and_then(Value::as_array).into_iter().flatten() {
            let id = txt(c, "server");
            let name = find(map, &id).map(|s| txt(s, "name")).unwrap_or_else(|| id.clone());
            out.push(json!({"kind": "AiMcpToolChanged", "gateway": url, "server": id, "name": name, "tool": txt(c, "tool"), "schema_sha256": txt(c, "schema_sha256")}));
        }
    }
    out
}

fn server_view(s: &Value, now: i64) -> Value {
    let mut v = s.clone();
    v["risk"] = Value::from(risk(s));
    v["days_left"] = s.pointer("/auth/expires").and_then(Value::as_i64).map(|e| Value::from((e - now).div_euclid(DAY))).unwrap_or(Value::Null);
    v
}

/// GET meet/ai/mcp: the signed and staged servers, each gateway's state with its acknowledgment ("not yet applied"),
/// the journal, the credential warnings, the tool changes and whether staging is allowed (readers first).
pub(crate) fn view(org: &str, map: Option<&Value>, staged: Option<&Value>, gateways: &[(Value, GatewayAnswer)], book: &Book, readers: Result<(), String>, now: i64) -> Value {
    let by_url: Vec<(String, GatewayAnswer)> = gateways.iter().map(|(g, a)| (txt(g, "url"), a.clone())).collect();
    let rows: Vec<Value> = gateways
        .iter()
        .map(|(g, a)| {
            let url = txt(g, "url");
            let ack = book.ack(&url);
            json!({
                "url": url, "principal": txt(g, "principal"), "state": a.as_ref().ok(), "error": a.as_ref().err().map(|(_, w)| w.clone()),
                "ack": ack, "applied": ack >= book.head, "waiting": book.head.saturating_sub(ack),
            })
        })
        .collect();
    json!({
        "ok": true, "org": org, "map_seq": map.and_then(|m| m.get("seq")).cloned(),
        "servers": servers(map).iter().map(|s| server_view(s, now)).collect::<Vec<_>>(),
        "staged": staged.map(|st| json!({"servers": servers(Some(st)).iter().map(|s| server_view(s, now)).collect::<Vec<_>>(), "mcp_cleared": st.get("mcp_cleared")})),
        "gateways": rows, "head": book.head, "journal": book.view(),
        "warnings": warnings(map, &by_url, now), "changed": tool_changes(map, &by_url),
        "readers": readers.err(), "ceilings": mcp::CEILINGS,
        "minimums": mcp::AI_MCP_CLIENTS.iter().map(|(a, v)| (a.to_string(), Value::from(*v))).collect::<Obj>(),
    })
}

fn state_path(org: &str) -> String {
    let q: String = org.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { char::from(b).to_string() } else { format!("%{b:02X}") }).collect();
    format!("{STATE_PATH}?org={q}")
}

fn answer_of(r: Result<Value, ApiError>) -> GatewayAnswer {
    // ai_https answers `stale` for a gateway's refusal and `relay-offline` when it did not answer
    r.map_err(|e| (e.code == "stale", e.message))
}

static SENDING: AtomicBool = AtomicBool::new(false);
static AGAIN: AtomicBool = AtomicBool::new(false);

// ── the routes (r6 8.11) ──────────────────────────────────────────────────────────────────────────────────────

impl MeetSection {
    /// The org of a Tools (MCP) read: the query's, else (an admin) the first organization.
    fn mcp_org(relay: &Relay, call: &SectionCall) -> Result<String, ApiError> {
        let f = filters(call.query, &["org"])?;
        if let Some(o) = f.get("org") {
            return Ok(o.clone());
        }
        if call.caller.admin {
            return Self::ai_org_query(relay, call);
        }
        Err(invalid("org is required"))
    }

    fn mcp_states(relay: &Relay, org: &str) -> Vec<(Value, GatewayAnswer)> {
        let gateways = ai_gateways(&ai_state(relay).lock().org(relay, org));
        let path = state_path(org);
        gateways.into_iter().map(|g| { let a = answer_of(ai_gateway_call(relay, &g, "GET", &path, None)); (g, a) }).collect()
    }

    /// What a Tools (MCP) change builds on: (the staged map, else the signed map; the signed map; the policy the
    /// staged change carries, else the signed one).
    fn mcp_bases(relay: &Relay, org: &str, t: i64) -> (Option<Value>, Option<Value>, Value) {
        let policy = ai_policy(relay, org);
        let current = ai_map(relay, org, &ai_policy_hash(&policy));
        let staged = ai_state(relay).lock().stages.get(org, t).map(|x| (x.map.clone(), x.policy.clone()));
        match staged {
            Some((map, p)) => (Some(map), current, p),
            None => (current.clone(), current, policy),
        }
    }

    /// GET meet/ai/mcp?org=
    pub(super) fn ai_mcp_view(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        let org = Self::mcp_org(relay, call)?;
        let policy = ai_policy(relay, &org);
        let map = ai_map(relay, &org, &ai_policy_hash(&policy));
        let states = Self::mcp_states(relay, &org);
        let st = ai_state(relay);
        let (book, staged) = {
            let mut s = st.lock();
            let mut entry = s.org(relay, &org);
            let mut book = Book::of(&entry);
            let before = book.clone();
            let answered: Vec<(String, Value)> = states.iter().filter_map(|(g, a)| a.as_ref().ok().map(|v| (txt(g, "url"), v.clone()))).collect();
            book.settle(map.as_ref(), &answered, states.len());
            if book != before {
                book.put(&mut entry);
                s.set_org(relay, &org, entry)?;
            }
            (book, s.stages.get(&org, call.t).map(|x| x.map.clone()))
        };
        if states.iter().any(|(g, _)| !book.pending(&txt(g, "url")).is_empty()) {
            self.ai_mcp_kick();
        }
        let urls: Vec<(String, GatewayAnswer)> = states.iter().map(|(g, a)| (txt(g, "url"), a.clone())).collect();
        let readers = readers_first(ai_edition(relay).as_deref(), &relay.minimums(&relay.release()), &urls);
        Ok(view(&org, map.as_ref(), staged.as_ref(), &states, &book, readers, call.t.div_euclid(1000)))
    }

    /// Run by `meet/ai/stage` before anything is built: a map with `mcp_servers` or `mcp_cleared` (the draft's, or the
    /// signed map's carried over) needs readers first, and each server needing one carries a new attestation.
    pub(super) fn ai_mcp_gate(relay: &Relay, org: &str, current: Option<&Value>, body: &Value) -> Result<(), ApiError> {
        let draft = body.get("map");
        let pick = |k: &str| draft.and_then(|d| d.get(k)).or_else(|| current.and_then(|c| c.get(k))).cloned();
        let (servers_next, cleared_next) = (pick("mcp_servers"), pick("mcp_cleared"));
        if servers_next.is_none() && cleared_next.is_none() {
            return Ok(());
        }
        let urls: Vec<(String, GatewayAnswer)> = Self::mcp_states(relay, org).into_iter().map(|(g, a)| (txt(&g, "url"), a)).collect();
        readers_first(ai_edition(relay).as_deref(), &relay.minimums(&relay.release()), &urls).map_err(invalid)?;
        check_attest_staging(current, &json!({"mcp_servers": servers_next.unwrap_or(json!([]))})).map_err(invalid)
    }

    /// Run by `meet/ai/stage` once the change is staged (under the AI state lock): each narrowing against the signed
    /// map journals its 8.2 entry at once, and the gateways are sent it in the background.
    pub(super) fn ai_mcp_journal(&self, relay: &Relay, org: &str, current: Option<&Value>, next: &Value, s: &mut AiState, t: i64) -> Result<(), ApiError> {
        let Some(cur) = current.filter(|c| !servers(Some(*c)).is_empty()) else { return Ok(()) };
        let mut entry = s.org(relay, org);
        let mut book = Book::of(&entry);
        let since = cur.get("issued").and_then(Value::as_i64).unwrap_or(0);
        let adds = to_journal(cur, next, &book.recent_open(since));
        if adds.is_empty() {
            return Ok(());
        }
        for (action, target, expires) in adds {
            book.add(org, t.div_euclid(1000), &action, target, expires).map_err(|w| stale(&w))?;
        }
        book.put(&mut entry);
        s.set_org(relay, org, entry)?;
        self.ai_mcp_kick();
        Ok(())
    }

    /// Journal entries now (turning off), skipping one already open with the same action and target, then send them
    /// to every gateway and answer each gateway's result.
    fn mcp_journal_now(relay: &Relay, org: &str, adds: Vec<(&str, Value)>, t: i64) -> Result<(Vec<String>, Vec<Value>), ApiError> {
        let mut ids = Vec::new();
        {
            let st = ai_state(relay);
            let mut s = st.lock();
            let mut entry = s.org(relay, org);
            let mut book = Book::of(&entry);
            let mut changed = false;
            for (action, target) in adds {
                if let Some(e) = book.open().into_iter().find(|e| txt(e, "action") == action && e.get("target") == Some(&target)) {
                    ids.push(txt(e, "id"));
                    continue;
                }
                ids.push(book.add(org, t.div_euclid(1000), action, target, None).map_err(|w| stale(&w))?);
                changed = true;
            }
            if changed {
                book.put(&mut entry);
                s.set_org(relay, org, entry)?;
            }
        }
        Ok((ids, Self::mcp_send(relay, org)))
    }

    /// Send every gateway of the org what it has not acknowledged (no lock held during the calls); a gateway that
    /// refuses is asked for its head, so the next resend starts there.
    fn mcp_send(relay: &Relay, org: &str) -> Vec<Value> {
        let st = ai_state(relay);
        let (gateways, book) = {
            let mut s = st.lock();
            let entry = s.org(relay, org);
            (ai_gateways(&entry), Book::of(&entry))
        };
        let mut heads: Vec<(String, u64)> = Vec::new();
        let mut out = Vec::new();
        for g in &gateways {
            let url = txt(g, "url");
            let entries = book.pending(&url);
            if entries.is_empty() {
                out.push(json!({"gateway": url, "applied": true, "ack": book.ack(&url)}));
                continue;
            }
            match ai_gateway_call(relay, g, "POST", TIGHTEN_PATH, Some(&json!({"org": org, "entries": entries}))) {
                Ok(v) => {
                    let head = v.get("tseq").and_then(Value::as_u64).unwrap_or(0);
                    heads.push((url.clone(), head));
                    out.push(json!({"gateway": url, "applied": head >= book.head, "ack": head.min(book.head)}));
                }
                Err(e) => {
                    let head = ai_gateway_call(relay, g, "GET", &state_path(org), None).ok().and_then(|v| v.pointer("/journal/head").and_then(Value::as_u64));
                    if let Some(h) = head {
                        heads.push((url.clone(), h));
                    }
                    crate::meet::log_warn(&format!("console.ai-mcp-tighten org={} gateway={} why={}", m::kv(org), m::kv(&url), m::kv(&e.message)));
                    out.push(json!({"gateway": url, "applied": false, "ack": book.ack(&url), "error": e.message}));
                }
            }
        }
        if !heads.is_empty() {
            let mut s = st.lock();
            let mut entry = s.org(relay, org);
            let mut now = Book::of(&entry);
            let before = now.clone();
            for (url, head) in heads {
                now.acked(&url, head);
            }
            if now != before {
                now.put(&mut entry);
                if let Err(e) = s.set_org(relay, org, entry) {
                    crate::meet::log_warn(&format!("console.ai-mcp-ack org={} why={}", m::kv(org), m::kv(&e.message)));
                }
            }
        }
        out
    }

    /// The orgs with an entry some enrolled gateway has not acknowledged.
    fn mcp_pending_orgs(relay: &Relay) -> Vec<String> {
        let st = ai_state(relay);
        let mut s = st.lock();
        s.org(relay, "");
        let orgs = s.book.get("orgs").and_then(Value::as_object).cloned().unwrap_or_default();
        orgs.iter()
            .filter_map(|(org, e)| {
                let e = e.as_object()?;
                let book = Book::of(e);
                (book.head > 0 && ai_gateways(e).iter().any(|g| !book.pending(&txt(g, "url")).is_empty())).then(|| org.clone())
            })
            .collect()
    }

    /// Resend in the background, one run at a time; a kick during a run makes it go round again.
    pub(super) fn ai_mcp_kick(&self) {
        AGAIN.store(true, Ordering::Release);
        if SENDING.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = self.relay.clone();
        let spawned = std::thread::Builder::new().name("console-ai-mcp".into()).spawn(move || loop {
            while AGAIN.swap(false, Ordering::AcqRel) {
                let Some(relay) = weak.upgrade() else { break };
                for org in Self::mcp_pending_orgs(&relay) {
                    Self::mcp_send(&relay, &org);
                }
            }
            SENDING.store(false, Ordering::Release);
            if !AGAIN.load(Ordering::Acquire) || SENDING.swap(true, Ordering::AcqRel) {
                return;
            }
        });
        if spawned.is_err() {
            SENDING.store(false, Ordering::Release);
        }
    }

    /// The console's minute (8.2: resent every minute until acknowledged).
    pub(super) fn ai_mcp_tick(&self) {
        let Ok(relay) = self.relay() else { return };
        if !Self::mcp_pending_orgs(&relay).is_empty() {
            self.ai_mcp_kick();
        }
    }

    /// The whole draft map checked as the relay will check it (`ai_mcp::check_mcp`, shape then policy).
    fn mcp_check_draft(relay: &Relay, org: &str, list: &[Value], cleared: Option<&[String]>, policy: &Value, t: i64) -> Result<(), ApiError> {
        let gateways = ai_gateways(&ai_state(relay).lock().org(relay, org));
        let mut map = json!({"v": 1, "org": org, "seq": 1, "issued": t.div_euclid(1000), "gateways": gateways, "mcp_servers": list});
        if let Some(c) = cleared {
            map["mcp_cleared"] = json!(c);
        }
        let o = map.as_object().ok_or_else(|| ApiError::of("state-unreadable"))?;
        mcp::check_mcp(o, policy.as_object()).map_err(invalid)
    }

    /// Stage `list` as the map's `mcp_servers` through `meet/ai/stage` (the same staged change: the staged one's `ai`
    /// and map when one is staged, else the signed settings).
    #[allow(clippy::too_many_arguments)]
    fn mcp_stage(&self, relay: &Relay, call: &SectionCall, org: &str, base: Option<&Value>, policy: &Value, list: Vec<Value>, cleared: Option<Vec<String>>) -> Result<Value, ApiError> {
        let mut map = Obj::new();
        for k in ai::MAP_DRAFT_KEYS.iter().filter(|k| **k != "gateways") {
            if let Some(v) = base.and_then(|b| b.get(*k)) {
                map.insert((*k).into(), v.clone());
            }
        }
        map.insert("mcp_servers".into(), Value::Array(list));
        if let Some(c) = cleared.map(|c| json!(c)).or_else(|| base.and_then(|b| b.get("mcp_cleared")).cloned()) {
            map.insert("mcp_cleared".into(), c);
        }
        let mut body = json!({"org": org, "preset": ai::ADVANCED_ID, "map": map});
        if let Some(mut a) = policy.get("ai").filter(|a| a.is_object()).cloned() {
            if let Some(o) = a.as_object_mut() {
                o.remove("map_sha256");
            }
            body["ai"] = a;
        }
        let inner = SectionCall { spec: call.spec, query: "", body: &body, caller: call.caller, license: call.license, t: call.t };
        match self.ai_stage(relay, &inner)? {
            SectionAnswer::Done { answer, .. } => Ok(answer.get("staged").cloned().unwrap_or(Value::Null)),
            _ => Err(ApiError::of("state-unreadable")),
        }
    }

    fn mcp_server_of(body: &Value) -> Result<Obj, ApiError> {
        body.get("server").and_then(Value::as_object).cloned().ok_or_else(|| invalid(SERVER_OBJECT))
    }

    fn mcp_id_of(body: &Value) -> Result<String, ApiError> {
        if mcp::server_id_ok(body.get("server")) {
            Ok(pj::str_or(body.get("server")))
        } else {
            Err(invalid(SERVER_ID))
        }
    }

    /// POST meet/ai/mcp/servers {org, server, second, reason}: stage a new server with the caller's and `second`'s
    /// attestation.
    pub(super) fn ai_mcp_add(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        Self::who(relay, &call.caller.email)?;
        let mut server = Self::mcp_server_of(call.body)?;
        if pj::s(&server, "id").is_empty() {
            server.insert("id".into(), Value::from(new_server_id()));
        }
        let id = pj::s(&server, "id");
        let second = second_of(call.body, &call.caller.email).map_err(invalid)?.ok_or_else(|| invalid(SECOND))?;
        let (base, _, policy) = Self::mcp_bases(relay, &org, call.t);
        let mut list = servers(base.as_ref());
        if list.iter().any(|s| txt(s, "id") == id) {
            return Err(invalid(SERVER_TAKEN));
        }
        server.remove("attest");
        let a = attest([&call.caller.email, &second], call.t.div_euclid(1000), &Value::Object(server.clone()));
        server.insert("attest".into(), a);
        list.push(Value::Object(server));
        let carried = strs(base.as_ref().and_then(|b| b.get("mcp_cleared")));
        Self::mcp_check_draft(relay, &org, &list, base.as_ref().and_then(|b| b.get("mcp_cleared")).map(|_| carried.as_slice()), &policy, call.t)?;
        let staged = self.mcp_stage(relay, call, &org, base.as_ref(), &policy, list, None)?;
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "server": id, "staged": staged}), target: org, detail: json!({"server": id, "second": second}) })
    }

    /// POST meet/ai/mcp/servers/update {org, server, second?, clear?, reason}: stage the changed server; narrowings
    /// journal at once (in `meet/ai/stage`), contradicted entries and `clear` go to `mcp_cleared`.
    pub(super) fn ai_mcp_update(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        Self::who(relay, &call.caller.email)?;
        let mut server = Self::mcp_server_of(call.body)?;
        let id = pj::s(&server, "id");
        let second = second_of(call.body, &call.caller.email).map_err(invalid)?;
        let explicit = match call.body.get("clear") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) if a.iter().all(Value::is_string) => strs(call.body.get("clear")),
            Some(_) => return Err(invalid(CLEAR_LIST)),
        };
        let (base, current, policy) = Self::mcp_bases(relay, &org, call.t);
        let mut list = servers(base.as_ref());
        let i = list.iter().position(|s| txt(s, "id") == id).ok_or_else(|| not_found("MCP server"))?;
        let staged_attest = list[i].get("attest").cloned();
        server.remove("attest");
        let next_server = Value::Object(server.clone());
        let a = choose_attest(find(current.as_ref(), &id), staged_attest.as_ref(), &next_server, &call.caller.email, second.as_deref(), call.t.div_euclid(1000)).map_err(invalid)?;
        let attested = attest_new(current.as_ref(), &json!({"id": id, "attest": a}));
        server.insert("attest".into(), a);
        list[i] = Value::Object(server);
        let book = Book::of(&ai_state(relay).lock().org(relay, &org));
        let ids = cleared_ids(&book, &json!({"mcp_servers": list}), &explicit).map_err(invalid)?;
        let cleared = (!ids.is_empty()).then(|| merge_cleared(base.as_ref(), &ids));
        let carried = cleared.clone().or_else(|| base.as_ref().and_then(|b| b.get("mcp_cleared")).map(|c| strs(Some(c))));
        Self::mcp_check_draft(relay, &org, &list, carried.as_deref(), &policy, call.t)?;
        let head = book.head;
        let staged = self.mcp_stage(relay, call, &org, base.as_ref(), &policy, list, cleared)?;
        let journaled: Vec<Value> = Book::of(&ai_state(relay).lock().org(relay, &org)).view().into_iter().filter(|e| e.get("tseq").and_then(Value::as_u64).unwrap_or(0) > head).collect();
        let answer = json!({"ok": true, "server": id, "staged": staged, "journaled": journaled, "cleared": ids, "attested": attested});
        Ok(SectionAnswer::Done { answer, target: org, detail: json!({"server": id, "cleared": ids, "journaled": journaled.len(), "attested": attested}) })
    }

    /// POST meet/ai/mcp/servers/off {org, server, reason}: journal `mcp_server_off`.
    pub(super) fn ai_mcp_server_off(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        Self::who(relay, &call.caller.email)?;
        let id = Self::mcp_id_of(call.body)?;
        let current = ai_map(relay, &org, &ai_policy_hash(&ai_policy(relay, &org)));
        if find(current.as_ref(), &id).is_none() {
            return Err(stale(NOT_SIGNED));
        }
        let (ids, gateways) = Self::mcp_journal_now(relay, &org, vec![("mcp_server_off", Value::from(id.as_str()))], call.t)?;
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "entry": ids.first(), "gateways": gateways}), target: id, detail: json!({"org": org, "entry": ids.first()}) })
    }

    /// POST meet/ai/mcp/off {org, reason}: journal `mcp_off`.
    pub(super) fn ai_mcp_off(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        Self::who(relay, &call.caller.email)?;
        let (ids, gateways) = Self::mcp_journal_now(relay, &org, vec![("mcp_off", Value::from(org.as_str()))], call.t)?;
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "entry": ids.first(), "gateways": gateways}), target: org, detail: json!({"entry": ids.first()}) })
    }

    /// POST meet/ai/mcp/credential {org, server, op: key | csr | cert, cert_pem?, chain_pem?, gateway?, reason}: a key
    /// or a certificate request on every gateway (each answer shown), or a certificate installed on one.
    pub(super) fn ai_mcp_credential(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        Self::who(relay, &call.caller.email)?;
        let id = Self::mcp_id_of(call.body)?;
        let op = pj::str_or(call.body.get("op"));
        let gateways = ai_gateways(&ai_state(relay).lock().org(relay, &org));
        if gateways.is_empty() {
            return Err(stale(NO_GATEWAY));
        }
        let one = |g: &Value, path: &str, body: &Value| -> Value {
            match ai_gateway_call(relay, g, "POST", path, Some(body)) {
                Ok(v) => json!({"gateway": txt(g, "url"), "principal": txt(g, "principal"), "answer": v}),
                Err(e) => json!({"gateway": txt(g, "url"), "principal": txt(g, "principal"), "error": e.message}),
            }
        };
        let answers: Vec<Value> = match op.as_str() {
            "key" | "csr" => {
                let path = format!("/v1/ai/admin/mcp/{op}");
                gateways.iter().map(|g| one(g, &path, &json!({"org": org, "server": id}))).collect()
            }
            "cert" => {
                let cert = pj::str_or(call.body.get("cert_pem"));
                if !cert.contains("-----BEGIN CERTIFICATE-----") {
                    return Err(invalid(CERT));
                }
                let url = pj::str_or(call.body.get("gateway"));
                let g = gateways.iter().find(|g| txt(g, "url") == url).ok_or_else(|| invalid(GATEWAY))?;
                let body = json!({"org": org, "server": id, "cert_pem": cert, "chain_pem": pj::str_or(call.body.get("chain_pem"))});
                vec![one(g, "/v1/ai/admin/mcp/cert", &body)]
            }
            _ => return Err(invalid(OP)),
        };
        let ok = answers.iter().filter(|a| a.get("answer").is_some()).count();
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "server": id, "op": op, "answers": answers}), target: id, detail: json!({"org": org, "op": op, "answered": ok}) })
    }

    /// POST meet/ai/mcp/test {org, server, draft?}: the first gateway that answers runs 8.9 test; its tools come back
    /// with their hashes.
    pub(super) fn ai_mcp_test(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        Self::who(relay, &call.caller.email)?;
        let id = Self::mcp_id_of(call.body)?;
        let mut body = json!({"org": org, "server": id});
        if let Some(d) = call.body.get("draft").and_then(Value::as_object) {
            let mut d = d.clone();
            d.remove("attest");
            d.remove("tools");
            d.insert("id".into(), Value::from(id.as_str()));
            body["draft"] = Value::Object(d);
        }
        let gateways = ai_gateways(&ai_state(relay).lock().org(relay, &org));
        let mut silent = Vec::new();
        for g in &gateways {
            match ai_gateway_call(relay, g, "POST", "/v1/ai/admin/mcp/test", Some(&body)) {
                Ok(v) => {
                    let answer = json!({"ok": true, "server": id, "gateway": txt(g, "url"), "test": v});
                    return Ok(SectionAnswer::Done { answer, target: id, detail: json!({"org": org, "gateway": txt(g, "url")}) });
                }
                // the gateway answered with a refusal (mcp-issuer, mcp-version, ...): that is the test's answer
                Err(e) if e.code == "stale" => return Err(e),
                Err(e) => silent.push(e.message),
            }
        }
        Err(stale(&if silent.is_empty() { NO_GATEWAY.to_owned() } else { format!("{NO_ANSWER}: {}", silent.join("; ")) }))
    }

    /// Before the approved `meet.ai.save` runs: every new attestation names the requester and the approver.
    pub(super) fn ai_mcp_save_check(&self, run: &Approved) -> Result<(), ApiError> {
        let relay = self.relay()?;
        let (org, stage) = (pj::str_or(run.params.get("org")), pj::str_or(run.params.get("stage")));
        let next = ai_state(&relay).lock().stages.get(&org, run.t).filter(|x| x.id == stage).map(|x| x.map.clone());
        // a stage that is gone is answered by ai_save_run
        let Some(next) = next else { return Ok(()) };
        let current = ai_map(&relay, &org, &ai_policy_hash(&ai_policy(&relay, &org)));
        check_attest_save(current.as_ref(), &next, run.requested_by, run.approved_by).map_err(|w| ApiError::with("role", w))
    }

    /// Only an admin named in every new attestation of the staged save may approve it.
    pub(super) fn ai_mcp_may_approve(relay: &Relay, params: &Value, approver: &str) -> bool {
        let (org, stage) = (pj::str_or(params.get("org")), pj::str_or(params.get("stage")));
        let next = ai_state(relay).lock().stages.get(&org, crate::codec::now_ms()).filter(|x| x.id == stage).map(|x| x.map.clone());
        let Some(next) = next else { return true };
        let current = ai_map(relay, &org, &ai_policy_hash(&ai_policy(relay, &org)));
        may_approve(current.as_ref(), &next, approver)
    }

    /// The approval's view of a save's new attestations (8.6: the residual risk in the two-person approval).
    pub(super) fn ai_mcp_approval(relay: &Relay, org: &str, stage: &str, t: i64) -> Option<Value> {
        let next = ai_state(relay).lock().stages.get(org, t).filter(|x| x.id == stage).map(|x| x.map.clone())?;
        let current = ai_map(relay, org, &ai_policy_hash(&ai_policy(relay, org)));
        let rows: Vec<Value> = servers(Some(&next))
            .iter()
            .filter(|s| attest_new(current.as_ref(), s))
            .map(|s| json!({"server": txt(s, "name"), "by": s.pointer("/attest/by"), "statement": s.pointer("/attest/statement"), "risk": risk(s)}))
            .collect();
        (!rows.is_empty()).then(|| Value::Array(rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "acme";
    const ISSUED: i64 = 1_795_000_000;

    fn server(id: &str, groups: &[&str], tools: &[(&str, &str)], ceiling: &str, private_ok: bool, max_calls: i64) -> Value {
        json!({
            "id": id, "name": "Jira (read)", "url": "https://mcp.jira.acme.example/mcp", "ceiling": ceiling, "private_ok": private_ok,
            "groups": groups, "activities": ["search", "assist"],
            "auth": {"type": "oauth_private_key_jwt", "issuer": "https://auth.acme.example", "client_id": "lucid-ai-gateway", "scope": "issues:read",
                     "kids": {"ai@apps.acme.example": "g1"}, "expires": ISSUED + 200 * DAY},
            "attest": {"by": ["ann@acme.example", "carl@acme.example"], "at": ISSUED - 10, "statement": "Every member of eng may read everything."},
            "tools": tools.iter().map(|(n, h)| json!({"name": n, "effect": "read", "schema_sha256": h.repeat(64)})).collect::<Vec<_>>(),
            "max_calls": max_calls, "args_max": 4096, "result_max": 65536,
        })
    }

    fn map(servers: Vec<Value>) -> Value {
        json!({"v": 1, "org": ORG, "seq": 3, "issued": ISSUED, "gateways": [], "mcp_servers": servers})
    }

    const S1: &str = "m_3f2e1d0c9b8a7f6e";

    #[test]
    fn statement_is_prefilled_from_groups_scope_and_name() {
        let s = server(S1, &["eng", "ops"], &[("search", "a")], "internal", false, 4);
        assert_eq!(statement(&s), "Every member of eng, ops may read everything the issues:read credential of Jira (read) can read.");
        let mut m = s.clone();
        m["auth"] = json!({"type": "mtls_only", "expires": ISSUED});
        assert_eq!(statement(&m), "Every member of eng, ops may read everything the client certificate credential of Jira (read) can read.");
        assert!(risk(&s).contains("Jira (read)") && risk(&s).contains("eng, ops"));
        let a = attest(["Ann@acme.example", "carl@acme.example"], ISSUED, &s);
        assert_eq!(a["by"], json!(["ann@acme.example", "carl@acme.example"]));
        assert_eq!(a["at"], json!(ISSUED));
    }

    #[test]
    fn narrowings_journal_in_order_with_ids_and_skip_open_ones() {
        let old = map(vec![server(S1, &["eng", "ops"], &[("search", "a"), ("get", "b")], "confidential", true, 4)]);
        let new = map(vec![server(S1, &["eng"], &[("search", "a")], "internal", false, 2)]);
        let adds = to_journal(&old, &new, &[]);
        let actions: Vec<&str> = adds.iter().map(|(a, _, _)| a.as_str()).collect();
        assert_eq!(actions, vec!["mcp_tool_off", "mcp_lower_ceiling", "mcp_drop_group", "mcp_private_off", "mcp_limit"]);
        assert_eq!(adds[0].1, json!({"server": S1, "tool": "get"}));
        assert_eq!(adds[1].1, json!({"server": S1, "ceiling": "internal"}));
        assert_eq!(adds[4].1, json!({"server": S1, "max_calls": 2}));
        let mut book = Book::default();
        for (a, t, x) in adds.clone() {
            book.add(ORG, ISSUED + 5, &a, t, x).unwrap();
        }
        assert_eq!(book.head, 5);
        assert_eq!(book.entries[0]["id"], json!(mcp::journal_id(ORG, 1)));
        // journaled since the signed map: the same change again journals nothing new
        assert!(to_journal(&old, &new, &book.recent_open(ISSUED)).is_empty());
        // a server removed: mcp_server_off only; a credential drop records the signed expires
        let gone = to_journal(&old, &map(vec![]), &[]);
        assert_eq!(gone, vec![("mcp_server_off".to_owned(), json!(S1), None)]);
        let mut rotated = new.clone();
        rotated["mcp_servers"][0]["auth"]["client_id"] = json!("other");
        let drop = to_journal(&old, &rotated, &[]);
        let (_, target, expires) = drop.iter().find(|(a, _, _)| a == "mcp_credential_drop").unwrap();
        assert_eq!((target, *expires), (&json!(S1), Some(ISSUED + 200 * DAY)));
    }

    #[test]
    fn acks_per_gateway_and_settling() {
        let (g1, g2) = ("https://ai-1.acme.example:8443", "https://ai-2.acme.example:8443");
        let mut book = Book::default();
        book.add(ORG, ISSUED, "mcp_server_off", json!(S1), None).unwrap();
        book.add(ORG, ISSUED, "mcp_off", json!(ORG), None).unwrap();
        assert_eq!(book.pending(g1).len(), 2);
        assert_eq!(book.pending(g1)[0], json!({"id": mcp::journal_id(ORG, 1), "tseq": 1, "ts": ISSUED, "action": "mcp_server_off", "target": S1}));
        book.acked(g1, 2);
        assert!(book.pending(g1).is_empty());
        assert_eq!(book.pending(g2).len(), 2, "not yet applied on the second gateway");
        // a gateway that lost its journal answers a lower head: everything is sent again
        book.acked(g1, 0);
        assert_eq!(book.pending(g1).len(), 2);
        // a head above the console's is capped
        book.acked(g1, 9);
        assert_eq!(book.ack(g1), 2);
        // the store keeps everything
        let mut entry = Obj::new();
        book.put(&mut entry);
        assert_eq!(Book::of(&entry), book);
        // settling: both gateways past tseq 2, the server off no longer in force anywhere, mcp_off still in force
        let state = |active: &[String]| json!({"journal": {"head": 2, "active": active}});
        let off = mcp::journal_id(ORG, 2);
        book.settle(None, &[(g1.into(), state(&[off.clone()]))], 2);
        assert!(book.open().len() == 2, "one gateway did not answer: nothing settles");
        assert_eq!(book.ack(g1), 2);
        book.settle(None, &[(g1.into(), state(&[off.clone()])), (g2.into(), state(&[off.clone()]))], 2);
        let open: Vec<String> = book.open().iter().map(|e| txt(e, "id")).collect();
        assert_eq!(open, vec![off]);
        assert_eq!(book.view()[0]["state"], json!("done"));
        // the journal is bounded by its 6 digits
        let mut full = Book { head: TSEQ_MAX, ..Book::default() };
        assert_eq!(full.add(ORG, ISSUED, "mcp_off", json!(ORG), None), Err(JOURNAL_FULL.to_owned()));
    }

    #[test]
    fn widenings_clear_contradicted_entries_and_explicit_ids_must_be_open() {
        let mut book = Book::default();
        let group = book.add(ORG, ISSUED, "mcp_drop_group", json!({"server": S1, "group": "ops"}), None).unwrap();
        let off = book.add(ORG, ISSUED, "mcp_server_off", json!(S1), None).unwrap();
        let tool = book.add(ORG, ISSUED, "mcp_tool_off", json!({"server": S1, "tool": "get"}), None).unwrap();
        // ops comes back, get stays out: only the group entry is contradicted; the server off is cleared only explicitly
        let next = map(vec![server(S1, &["eng", "ops"], &[("search", "a")], "internal", false, 4)]);
        assert_eq!(cleared_ids(&book, &next, &[]).unwrap(), vec![group.clone()]);
        assert_eq!(cleared_ids(&book, &next, &[off.clone()]).unwrap(), vec![group.clone(), off.clone()]);
        assert!(cleared_ids(&book, &next, &["g_acme_000099".into()]).unwrap_err().contains("g_acme_000099"));
        let with_tool = map(vec![server(S1, &["eng"], &[("search", "a"), ("get", "b")], "internal", false, 4)]);
        assert_eq!(cleared_ids(&book, &with_tool, &[]).unwrap(), vec![tool]);
        // merged into the base map's list, newest 1000 kept
        let base = json!({"mcp_cleared": ["g_acme_000001"]});
        assert_eq!(merge_cleared(Some(&base), &[group.clone(), off.clone()]), vec![group.clone(), off]);
        let many: Vec<String> = (1..=1001).map(|n| mcp::journal_id(ORG, n)).collect();
        let kept = merge_cleared(None, &many);
        assert_eq!((kept.len(), kept[0].as_str()), (1000, mcp::journal_id(ORG, 2).as_str()));
    }

    #[test]
    fn attestation_rules_at_staging_and_at_the_save() {
        let signed = server(S1, &["eng"], &[("search", "a")], "internal", false, 4);
        let current = map(vec![signed.clone()]);
        // narrowing only: the signed attestation stays
        let mut narrower = signed.clone();
        narrower["max_calls"] = json!(2);
        assert!(!needs_attest(Some(&signed), &narrower));
        assert!(check_attest_staging(Some(&current), &map(vec![narrower.clone()])).is_ok());
        // a group, a tool, a changed hash, a higher ceiling, private_ok or a new scope need a new one
        for (k, v) in [("groups", json!(["eng", "ops"])), ("ceiling", json!("cui")), ("private_ok", json!(true))] {
            let mut w = signed.clone();
            w[k] = v;
            assert!(needs_attest(Some(&signed), &w), "{k}");
            assert!(check_attest_staging(Some(&current), &map(vec![w])).unwrap_err().contains("Jira (read)"), "{k}");
        }
        let mut tool = signed.clone();
        tool["tools"][0]["schema_sha256"] = json!("c".repeat(64));
        assert!(needs_attest(Some(&signed), &tool));
        let mut scope = signed.clone();
        scope["auth"]["scope"] = json!("issues:read projects:read");
        assert!(needs_attest(Some(&signed), &scope));
        // with a new attestation the widening stages; a new server always needs one
        let mut wider = signed.clone();
        wider["groups"] = json!(["eng", "ops"]);
        let fresh = choose_attest(Some(&signed), None, &wider, "ann@acme.example", Some("bob@acme.example"), ISSUED + 9).unwrap();
        assert_eq!(fresh["by"], json!(["ann@acme.example", "bob@acme.example"]));
        wider["attest"] = fresh.clone();
        let next = map(vec![wider.clone()]);
        assert!(check_attest_staging(Some(&current), &next).is_ok());
        assert!(choose_attest(Some(&signed), None, &wider, "ann@acme.example", None, ISSUED).is_err());
        // a later edit of the same staged change by one of its two admins keeps them
        let kept = choose_attest(Some(&signed), Some(&fresh), &wider, "bob@acme.example", None, ISSUED + 20).unwrap();
        assert_eq!((kept["by"].clone(), kept["at"].clone()), (json!(["ann@acme.example", "bob@acme.example"]), json!(ISSUED + 20)));
        assert!(choose_attest(Some(&signed), Some(&fresh), &wider, "eve@acme.example", None, ISSUED).is_err());
        assert!(choose_attest(None, None, &signed, "ann@acme.example", None, ISSUED).is_err());
        // the approved save: requester and approver are exactly the two attesting admins
        assert!(check_attest_save(Some(&current), &next, "bob@acme.example", Some("ann@acme.example")).is_ok());
        let wrong = check_attest_save(Some(&current), &next, "ann@acme.example", Some("eve@acme.example")).unwrap_err();
        assert_eq!(wrong, fill(APPROVER, &[("by", "ann@acme.example and bob@acme.example")]));
        assert!(check_attest_save(Some(&current), &next, "ann@acme.example", None).is_err(), "the sole-admin path cannot carry it");
        assert!(may_approve(Some(&current), &next, "Bob@acme.example") && !may_approve(Some(&current), &next, "eve@acme.example"));
        // nothing new: any approver, the sole-admin path too
        assert!(check_attest_save(Some(&current), &map(vec![narrower]), "ann@acme.example", None).is_ok());
        assert!(second_of(&json!({"second": "ANN@acme.example"}), "ann@acme.example").is_err());
        assert_eq!(second_of(&json!({}), "ann@acme.example"), Ok(None));
    }

    #[test]
    fn readers_first_refusals() {
        let ready = Obj::from_iter([("hub".to_owned(), json!("0.99.0")), ("ios".to_owned(), json!("1.0.0"))]);
        let reads = json!({"reads": mcp::MCP_READS});
        let gw = |a: GatewayAnswer| vec![("https://ai.acme.example:8443".to_owned(), a)];
        assert_eq!(readers_first(Some("standard"), &ready, &gw(Ok(reads.clone()))), Err(EDITION.to_owned()));
        assert_eq!(readers_first(None, &ready, &[]), Err(EDITION.to_owned()));
        let old = Obj::from_iter([("hub".to_owned(), json!("0.99.0")), ("ios".to_owned(), json!("0.98.3"))]);
        assert_eq!(readers_first(Some("enterprise"), &old, &gw(Ok(reads.clone()))), Err(TOO_SOON.to_owned()));
        let gw_old = fill(GATEWAY_OLD, &[("gateway", "https://ai.acme.example:8443")]);
        assert_eq!(readers_first(Some("enterprise"), &ready, &gw(Ok(json!({"reads": ["mcp_servers"]})))), Err(gw_old.clone()));
        assert_eq!(readers_first(Some("enterprise"), &ready, &gw(Err((true, "not found".into())))), Err(gw_old));
        assert!(readers_first(Some("enterprise"), &ready, &gw(Err((false, "no route".into())))).unwrap_err().contains("did not answer"));
        assert_eq!(readers_first(Some("enterprise"), &ready, &gw(Ok(reads))), Ok(()));
        assert!(TOO_SOON.contains(mcp::AI_MCP_CLIENTS[0].1) && mcp::AI_MCP_CLIENTS.iter().all(|(_, v)| *v == mcp::AI_MCP_CLIENTS[0].1));
    }

    #[test]
    fn the_page_shows_each_gateway_warnings_and_tool_changes() {
        let now = ISSUED;
        let mut s = server(S1, &["eng"], &[("search", "a")], "internal", false, 4);
        s["auth"]["expires"] = json!(now + 5 * DAY);
        let signed = map(vec![s]);
        let g1 = json!({"url": "https://ai-1.acme.example:8443", "principal": "ai@apps.acme.example"});
        let g2 = json!({"url": "https://ai-2.acme.example:8443", "principal": "ai@apps.acme.example"});
        let state = json!({"reads": mcp::MCP_READS, "journal": {"head": 1, "active": []},
            "servers": [{"id": S1, "name": "Jira (read)", "credential": {"state": "ready", "not_after": now + 20 * DAY}}],
            "changed": [{"server": S1, "tool": "search", "schema_sha256": "d".repeat(64)}]});
        let mut book = Book::default();
        book.add(ORG, now, "mcp_server_off", json!(S1), None).unwrap();
        book.acked("https://ai-1.acme.example:8443", 1);
        let v = view(ORG, Some(&signed), None, &[(g1, Ok(state)), (g2, Err((false, "did not answer".into())))], &book, Ok(()), now);
        assert_eq!(v["gateways"][0]["applied"], json!(true));
        assert_eq!((v["gateways"][1]["applied"].clone(), v["gateways"][1]["waiting"].clone()), (json!(false), json!(1)));
        assert_eq!(v["gateways"][1]["error"], json!("did not answer"));
        assert_eq!(v["servers"][0]["days_left"], json!(5));
        assert!(v["servers"][0]["risk"].as_str().unwrap().contains("Jira (read)"));
        let w = v["warnings"].as_array().unwrap();
        assert_eq!((w[0]["severity"].clone(), w[1]["severity"].clone()), (json!("bad"), json!("warn")));
        assert_eq!(w[1]["gateway"], json!("https://ai-1.acme.example:8443"));
        assert_eq!(v["changed"][0]["kind"], json!("AiMcpToolChanged"));
        assert_eq!(v["changed"][0]["name"], json!("Jira (read)"));
        assert_eq!(v["readers"], Value::Null);
        assert_eq!(v["journal"][0]["state"], json!("active"));
        assert_eq!(state_path("acme corp"), "/v1/ai/admin/mcp/state?org=acme%20corp");
        assert!(mcp::server_id_ok(Some(&json!(new_server_id()))));
    }
}
