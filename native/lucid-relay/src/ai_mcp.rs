// Contract API-1 revision 6 section 8 (slice API-1d6): the AI map's MCP allow list and the gateway's tightening
// journal, as pure functions shared by every reader. `check_mcp` is the field check of the optional AI map keys
// `mcp_servers` and `mcp_cleared` (8.1; `meet_org_policy::check_ai_map` calls it, so the relay, the gateway and the
// console agree with the Python and Swift readers through `tests/ai_mcp_v1.json`). The journal (8.2) holds only
// tightening entries; `folds` and `cleared` say when an entry leaves a gateway's active set. `jcs` is RFC 8785 for
// the tools' `schema_sha256`, and `class_offers` is the class gate of 8.6.

use crate::codec::{js_number_string, sha256_hex};
use crate::meet_org_policy::{split_principal, Obj};
use serde_json::{json, Map, Value};
use std::net::Ipv6Addr;

pub const CEILINGS: [&str; 4] = ["public", "internal", "confidential", "cui"];
pub const MCP_ACTIONS: [&str; 9] = [
    "mcp_off", "mcp_server_off", "mcp_tool_off", "mcp_lower_ceiling", "mcp_credential_drop", "mcp_drop_group", "mcp_drop_activity", "mcp_private_off", "mcp_limit",
];
pub const AUTH_TYPES: [&str; 3] = ["oauth_private_key_jwt", "oauth_mtls", "mtls_only"];
/// The first Meeting Hub and iPhone releases whose AI map readers accept `mcp_servers` and `mcp_cleared` (8.1).
pub const AI_MCP_CLIENTS: [(&str, &str); 2] = [("hub", "0.99.0"), ("ios", "0.99.0")];
/// The keys a 1d gateway reports it reads (`GET /v1/ai/admin/mcp/state`).
pub const MCP_READS: [&str; 2] = ["mcp_servers", "mcp_cleared"];
pub const MCP_SERVERS_MAX: usize = 16;
pub const MCP_CLEARED_MAX: usize = 1000;
pub const MAX_CALLS: (i64, i64) = (1, 8);
pub const ARGS_MAX: (i64, i64) = (256, 16384);
pub const RESULT_MAX: (i64, i64) = (1024, 262_144);
pub const EXPIRES_MAX_S: i64 = 366 * 86_400;
const URL_MAX: usize = 512;
const MAX_INT: i64 = (1 << 53) - 1;
const SERVER_KEYS: [&str; 13] = ["id", "name", "url", "ceiling", "private_ok", "groups", "activities", "auth", "attest", "tools", "max_calls", "args_max", "result_max"];

pub const MCP_SERVERS: &str = "mcp_servers must be 0 to 16 MCP servers {id, name, url, ceiling, private_ok, groups, activities, auth, attest, tools, max_calls, args_max, result_max}";
pub const MCP_ID: &str = "an MCP server id must be m_ and 16 lower-case hex digits, each id once";
pub const MCP_NAME: &str = "an MCP server name must be 1 to 64 characters";
pub const MCP_URL: &str = "an MCP server url must be https:// with a lower-case host, no default port, no query, fragment or trailing slash, at most 512 characters";
pub const MCP_CEILING: &str = "an MCP server ceiling must be public, internal, confidential or cui";
pub const MCP_PRIVATE: &str = "an MCP server private_ok must be true or false";
pub const MCP_GROUPS: &str = "an MCP server's groups must be 1 to 32 of the policy's ai.who.groups";
pub const MCP_ACTIVITIES: &str = "an MCP server's activities must be 1 to 6 AI activities, each once";
pub const MCP_AUTH: &str = "an MCP server's auth must be oauth_private_key_jwt, oauth_mtls or mtls_only with its fields";
pub const MCP_KIDS: &str = "auth.kids must map each gateway principal of the AI map to its own key id";
pub const MCP_MTLS_ONLY: &str = "mtls_only is only for a server with private_ok";
pub const MCP_EXPIRES: &str = "auth.expires must be at most 366 days after the map's issued";
pub const MCP_ATTEST: &str = "an MCP server needs attest {by: two distinct org admins, at, statement of 1 to 512 characters}";
pub const MCP_TOOLS: &str = "an MCP server's tools must be 1 to 32 tools {name, effect: read, schema_sha256}, each name once";
pub const MCP_LIMITS: &str = "max_calls must be 1 to 8, args_max 256 to 16384 and result_max 1024 to 262144";
pub const MCP_CLEARED: &str = "mcp_cleared must list 0 to 1000 gateway journal ids of the map's org, each once";

pub const ENTRY_SHAPE: &str = "a journal entry must be {id, tseq, ts, action, target} with id g_<org>_<tseq as 6 digits>";
pub const ENTRY_TARGET: &str = "that journal entry's target does not fit its action";
pub const NOT_TIGHTENING: &str = "only tightening entries are applied from the journal; a widening needs a signed AI map";

// ── small checks ─────────────────────────────────────────────────────────────────────────────────────────────

fn int_in(v: Option<&Value>, low: i64, high: i64) -> Option<i64> {
    v.and_then(Value::as_i64).filter(|n| (low..=high).contains(n))
}

/// 1 to `max` Unicode scalars, none below U+0020 and no U+007F.
fn plain_text(v: Option<&Value>, max: usize) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| (1..=max).contains(&s.chars().count()) && s.chars().all(|c| c >= ' ' && c != '\u{7f}'))
}

/// 1 to `max` bytes of printable ASCII (0x20..0x7e), or without the space when `space` is false.
fn ascii(v: Option<&Value>, max: usize, space: bool) -> bool {
    let low = if space { 0x20 } else { 0x21 };
    v.and_then(Value::as_str).is_some_and(|s| (1..=max).contains(&s.len()) && s.bytes().all(|b| (low..=0x7e).contains(&b)))
}

fn hex_full(v: Option<&Value>, n: usize) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

pub fn server_id_ok(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| s.strip_prefix("m_").is_some_and(|h| hex_full(Some(&Value::from(h)), 16)))
}

fn group_ok(v: &Value) -> bool {
    ascii(Some(v), 128, true) && !v.as_str().is_some_and(|s| s.starts_with("name:"))
}

pub fn activity_ok(v: &Value) -> bool {
    v.as_str().is_some_and(|s| crate::ai_gateway_admit::ACTIVITIES.contains(&s))
}

fn tool_name_ok(v: Option<&Value>) -> bool {
    ascii(v, 128, false)
}

/// `low` to `high` distinct strings, each passing `ok`.
fn distinct(v: Option<&Value>, low: usize, high: usize, ok: impl Fn(&Value) -> bool) -> Option<Vec<String>> {
    let a = v?.as_array().filter(|a| (low..=high).contains(&a.len()))?;
    let out: Vec<String> = a.iter().filter(|x| ok(x)).filter_map(Value::as_str).map(str::to_string).collect();
    let mut seen = out.clone();
    seen.sort();
    seen.dedup();
    (out.len() == a.len() && seen.len() == out.len()).then_some(out)
}

fn ipv4_strict(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) && !(p.len() > 1 && p.starts_with('0')) && p.parse::<u16>().is_ok_and(|n| n <= 255))
}

fn dns_ok(h: &str) -> bool {
    if h.is_empty() || h.len() > 253 {
        return false;
    }
    let labels_ok = h.split('.').all(|l| {
        (1..=63).contains(&l.len()) && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    });
    labels_ok && !h.rsplit('.').next().is_some_and(|last| last.bytes().all(|b| b.is_ascii_digit()))
}

/// The MCP canonical URI form (8.1, 1a 8.1): `https://`, a lower-case DNS name, a dotted IPv4 quad or a bracketed
/// IPv6 literal, an optional port that is not 443, a path, no userinfo, query or fragment, at most 512 characters,
/// and no trailing `/` unless `slash` (an authorization server's issuer).
pub fn url_ok(s: &str, slash: bool) -> bool {
    if s.is_empty() || s.len() > URL_MAX || !s.bytes().all(|b| (0x21..=0x7e).contains(&b)) || s.contains(['\\', '#', '?', '@']) {
        return false;
    }
    let Some(rest) = s.strip_prefix("https://") else { return false };
    if !slash && s.ends_with('/') {
        return false;
    }
    let authority = &rest[..rest.find('/').unwrap_or(rest.len())];
    let (host_ok, port) = if let Some(r) = authority.strip_prefix('[') {
        let Some(close) = r.find(']') else { return false };
        let after = &r[close + 1..];
        let port = match after {
            "" => None,
            p => match p.strip_prefix(':') {
                Some(p) => Some(p),
                None => return false,
            },
        };
        (r[..close].parse::<Ipv6Addr>().is_ok(), port)
    } else {
        let (h, p) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        let ok = if !h.is_empty() && h.bytes().all(|b| b.is_ascii_digit() || b == b'.') { ipv4_strict(h) } else { dns_ok(h) };
        (ok, p)
    };
    let port_ok = port.is_none_or(|p| {
        (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) && !p.starts_with('0') && p.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n) && n != 443)
    });
    host_ok && port_ok
}

/// A person principal (not an app): a lower-case email whose domain is not `apps.<d>`.
fn person_ok(v: &Value) -> bool {
    v.as_str().and_then(|p| split_principal(p).ok()).is_some_and(|(_, d)| !d.starts_with("apps."))
}

// ── the AI map keys (8.1) ────────────────────────────────────────────────────────────────────────────────────

fn servers(map: &Obj) -> &[Value] {
    map.get("mcp_servers").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn check_auth(a: Option<&Value>, private_ok: bool, issued: i64, gateways: &[String]) -> Result<(), &'static str> {
    let a = a.and_then(Value::as_object).ok_or(MCP_AUTH)?;
    let kind = a.get("type").and_then(Value::as_str).filter(|t| AUTH_TYPES.contains(t)).ok_or(MCP_AUTH)?;
    let keys: &[&str] = match kind {
        "oauth_private_key_jwt" => &["type", "issuer", "client_id", "kids", "scope", "expires"],
        "oauth_mtls" => &["type", "issuer", "client_id", "scope", "expires"],
        _ => &["type", "expires"],
    };
    let key_set_ok = keys.iter().all(|k| a.contains_key(*k)) && a.keys().all(|k| keys.contains(&k.as_str()) || k == "ca_pem");
    if !key_set_ok {
        return Err(MCP_AUTH);
    }
    if a.contains_key("issuer") && !a.get("issuer").and_then(Value::as_str).is_some_and(|s| url_ok(s, true)) {
        return Err(MCP_AUTH);
    }
    if a.contains_key("client_id") && !ascii(a.get("client_id"), 256, true) {
        return Err(MCP_AUTH);
    }
    if a.contains_key("scope") && !ascii(a.get("scope"), 512, true) {
        return Err(MCP_AUTH);
    }
    if let Some(pem) = a.get("ca_pem") {
        if !pem.as_str().is_some_and(|p| (1..=8192).contains(&p.chars().count()) && p.contains("-----BEGIN CERTIFICATE-----")) {
            return Err(MCP_AUTH);
        }
    }
    let expires = int_in(a.get("expires"), 1, MAX_INT).ok_or(MCP_AUTH)?;
    if expires > issued + EXPIRES_MAX_S {
        return Err(MCP_EXPIRES);
    }
    if kind == "oauth_private_key_jwt" {
        let kids = a.get("kids").and_then(Value::as_object).ok_or(MCP_KIDS)?;
        let mut wanted: Vec<&String> = gateways.iter().collect();
        wanted.sort();
        wanted.dedup();
        let mut have: Vec<&String> = kids.keys().collect();
        have.sort();
        let mut values: Vec<&str> = kids.values().filter_map(Value::as_str).collect();
        let all_ok = kids.values().all(|v| ascii(Some(v), 128, false));
        values.sort();
        values.dedup();
        if wanted.is_empty() || have != wanted || !all_ok || values.len() != kids.len() {
            return Err(MCP_KIDS);
        }
    }
    if kind == "mtls_only" && !private_ok {
        return Err(MCP_MTLS_ONLY);
    }
    Ok(())
}

fn check_server(s: &Value, issued: i64, gateways: &[String]) -> Result<(), &'static str> {
    let o = s.as_object().filter(|o| o.len() == SERVER_KEYS.len() && SERVER_KEYS.iter().all(|k| o.contains_key(*k))).ok_or(MCP_SERVERS)?;
    if !server_id_ok(o.get("id")) {
        return Err(MCP_ID);
    }
    if !plain_text(o.get("name"), 64) {
        return Err(MCP_NAME);
    }
    if !o.get("url").and_then(Value::as_str).is_some_and(|u| url_ok(u, false)) {
        return Err(MCP_URL);
    }
    if !o.get("ceiling").and_then(Value::as_str).is_some_and(|c| CEILINGS.contains(&c)) {
        return Err(MCP_CEILING);
    }
    let private_ok = o.get("private_ok").and_then(Value::as_bool).ok_or(MCP_PRIVATE)?;
    distinct(o.get("groups"), 1, 32, group_ok).ok_or(MCP_GROUPS)?;
    distinct(o.get("activities"), 1, 6, activity_ok).ok_or(MCP_ACTIVITIES)?;
    check_auth(o.get("auth"), private_ok, issued, gateways)?;
    let attest_ok = o.get("attest").and_then(Value::as_object).is_some_and(|a| {
        a.len() == 3
            && distinct(a.get("by"), 2, 2, person_ok).is_some()
            && int_in(a.get("at"), 1, issued).is_some()
            && plain_text(a.get("statement"), 512)
    });
    if !attest_ok {
        return Err(MCP_ATTEST);
    }
    let tools = o.get("tools").and_then(Value::as_array).filter(|t| (1..=32).contains(&t.len())).ok_or(MCP_TOOLS)?;
    let mut names: Vec<&str> = Vec::new();
    for t in tools {
        let ok = t.as_object().is_some_and(|t| {
            t.len() == 3 && tool_name_ok(t.get("name")) && t.get("effect").and_then(Value::as_str) == Some("read") && hex_full(t.get("schema_sha256"), 64)
        });
        if !ok {
            return Err(MCP_TOOLS);
        }
        let n = t["name"].as_str().unwrap_or_default();
        if names.contains(&n) {
            return Err(MCP_TOOLS);
        }
        names.push(n);
    }
    let limits_ok = int_in(o.get("max_calls"), MAX_CALLS.0, MAX_CALLS.1).is_some()
        && int_in(o.get("args_max"), ARGS_MAX.0, ARGS_MAX.1).is_some()
        && int_in(o.get("result_max"), RESULT_MAX.0, RESULT_MAX.1).is_some();
    if !limits_ok {
        return Err(MCP_LIMITS);
    }
    Ok(())
}

/// A server draft for `POST /v1/ai/admin/mcp/test` (a server not yet in the pinned map): `id`, `url`, `private_ok`
/// and `auth` by the 8.1 rules, `auth.expires` against `now_s`, `kids` naming at least one gateway.
pub fn check_draft(d: &Value, server: &str, now_s: i64) -> Result<(), &'static str> {
    if d.get("id").and_then(Value::as_str) != Some(server) {
        return Err(MCP_ID);
    }
    if !d.get("url").and_then(Value::as_str).is_some_and(|u| url_ok(u, false)) {
        return Err(MCP_URL);
    }
    let private_ok = d.get("private_ok").and_then(Value::as_bool).ok_or(MCP_PRIVATE)?;
    let gateways: Vec<String> = d.pointer("/auth/kids").and_then(Value::as_object).map(|k| k.keys().cloned().collect()).unwrap_or_default();
    check_auth(d.get("auth"), private_ok, now_s, &gateways)
}

/// `g_<org>_<6 digits>`.
fn journal_id_ok(id: &str, org: &str) -> bool {
    id.strip_prefix("g_").and_then(|r| r.strip_prefix(org)).and_then(|r| r.strip_prefix('_')).is_some_and(|d| d.len() == 6 && d.bytes().all(|b| b.is_ascii_digit()))
}

/// 8.1 field rules that need no policy (the map's own `org`, `issued` and `gateways`).
pub fn check_mcp_shape(map: &Obj) -> Result<(), String> {
    let issued = map.get("issued").and_then(Value::as_i64).unwrap_or(0);
    let org = map.get("org").and_then(Value::as_str).unwrap_or_default();
    let gateways: Vec<String> = map.get("gateways").and_then(Value::as_array).into_iter().flatten().filter_map(|g| g.get("principal").and_then(Value::as_str)).map(str::to_string).collect();
    if let Some(v) = map.get("mcp_servers") {
        let list = v.as_array().filter(|l| l.len() <= MCP_SERVERS_MAX).ok_or(MCP_SERVERS)?;
        for s in list {
            check_server(s, issued, &gateways)?;
        }
        let mut ids: Vec<&str> = list.iter().filter_map(|s| s.get("id").and_then(Value::as_str)).collect();
        ids.sort();
        ids.dedup();
        if ids.len() != list.len() {
            return Err(MCP_ID.into());
        }
    }
    if let Some(v) = map.get("mcp_cleared") {
        distinct(Some(v), 0, MCP_CLEARED_MAX, |x| x.as_str().is_some_and(|id| journal_id_ok(id, org))).ok_or(MCP_CLEARED)?;
    }
    Ok(())
}

/// 8.1 rules against the org's policy: groups among `ai.who.groups`, attesters among `admins`.
pub fn check_mcp_policy(map: &Obj, policy: &Obj) -> Result<(), String> {
    let strs = |v: Option<&Value>| -> Vec<String> { v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect() };
    let who = strs(policy.get("ai").and_then(|a| a.get("who")).and_then(|w| w.get("groups")));
    let admins = strs(policy.get("admins"));
    // every server's groups first, then every server's attesters (the Python order)
    if servers(map).iter().any(|s| strs(s.get("groups")).iter().any(|g| !who.contains(g))) {
        return Err(MCP_GROUPS.into());
    }
    if servers(map).iter().any(|s| strs(s.get("attest").and_then(|a| a.get("by"))).iter().any(|p| !admins.contains(p))) {
        return Err(MCP_ATTEST.into());
    }
    Ok(())
}

/// Both parts of 8.1 (the policy part only with a policy).
pub fn check_mcp(map: &Obj, policy: Option<&Obj>) -> Result<(), String> {
    check_mcp_shape(map)?;
    match policy {
        Some(p) => check_mcp_policy(map, p),
        None => Ok(()),
    }
}

// ── classes (8.6) ────────────────────────────────────────────────────────────────────────────────────────────

pub fn ceiling_rank(c: &str) -> Option<usize> {
    CEILINGS.iter().position(|x| *x == c)
}

/// The class gate of 8.6 in the policy's own class order: a server is offered while the working class (rank
/// `working` in `classes`) is at or below its ceiling, the ceiling is one of `classes` (otherwise never), and a CUI
/// working class reaches only a CUI ceiling.
pub fn class_offers(classes: &[String], cui_classes: &[String], working: usize, ceiling: &str) -> bool {
    let Some(rank) = classes.iter().position(|c| c == ceiling) else { return false };
    let working_cui = classes.get(working).is_some_and(|w| cui_classes.contains(w));
    rank >= working && (!working_cui || cui_classes.iter().any(|c| c == ceiling))
}

// ── the journal (8.2) ────────────────────────────────────────────────────────────────────────────────────────

/// `g_<org>_<tseq as 6 digits>`.
pub fn journal_id(org: &str, tseq: u64) -> String {
    format!("g_{org}_{tseq:06}")
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub tseq: u64,
    pub ts: i64,
    pub action: String,
    pub target: Value,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "tseq": self.tseq, "ts": self.ts, "action": self.action, "target": self.target})
    }

    /// The server an entry restricts ("" for `mcp_off`).
    pub fn server(&self) -> &str {
        match &self.target {
            Value::String(s) if self.action != "mcp_off" => s.as_str(),
            Value::Object(o) => o.get("server").and_then(Value::as_str).unwrap_or_default(),
            _ => "",
        }
    }
}

fn target_ok(org: &str, action: &str, t: &Value) -> bool {
    let obj = |keys: &[&str]| t.as_object().filter(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)) && server_id_ok(o.get("server")));
    match action {
        "mcp_off" => t.as_str() == Some(org),
        "mcp_server_off" | "mcp_credential_drop" | "mcp_private_off" => server_id_ok(Some(t)),
        "mcp_tool_off" => obj(&["server", "tool"]).is_some_and(|o| tool_name_ok(o.get("tool"))),
        "mcp_lower_ceiling" => obj(&["server", "ceiling"]).is_some_and(|o| o.get("ceiling").and_then(Value::as_str).is_some_and(|c| CEILINGS.contains(&c))),
        "mcp_drop_group" => obj(&["server", "group"]).is_some_and(|o| group_ok(&o["group"])),
        "mcp_drop_activity" => obj(&["server", "activity"]).is_some_and(|o| activity_ok(&o["activity"])),
        "mcp_limit" => t.as_object().is_some_and(|o| {
            let limits = [("max_calls", MAX_CALLS), ("args_max", ARGS_MAX), ("result_max", RESULT_MAX)];
            server_id_ok(o.get("server"))
                && o.len() >= 2
                && o.keys().all(|k| k == "server" || limits.iter().any(|(n, _)| *n == k.as_str()))
                && limits.iter().all(|(n, (low, high))| o.get(*n).is_none_or(|v| int_in(Some(v), *low, *high).is_some()))
        }),
        _ => false,
    }
}

/// One entry of `POST /v1/ai/admin/mcp/tighten`: Err is (status, code, words): 400 `bad_request` for a malformed
/// entry, 409 `not-tightening` for any action that is not one of the nine tightening actions.
pub fn check_entry(org: &str, v: &Value) -> Result<Entry, (u16, &'static str, String)> {
    let bad = |w: &str| (400, "bad_request", w.to_string());
    let o = v.as_object().filter(|o| o.len() == 5 && ["id", "tseq", "ts", "action", "target"].iter().all(|k| o.contains_key(*k))).ok_or_else(|| bad(ENTRY_SHAPE))?;
    let tseq = int_in(o.get("tseq"), 1, 999_999).ok_or_else(|| bad(ENTRY_SHAPE))? as u64;
    let ts = int_in(o.get("ts"), 1, MAX_INT).ok_or_else(|| bad(ENTRY_SHAPE))?;
    let id = o.get("id").and_then(Value::as_str).filter(|id| *id == journal_id(org, tseq)).ok_or_else(|| bad(ENTRY_SHAPE))?;
    let action = o.get("action").and_then(Value::as_str).ok_or_else(|| bad(ENTRY_SHAPE))?;
    if !MCP_ACTIONS.contains(&action) {
        return Err((409, "not-tightening", NOT_TIGHTENING.to_string()));
    }
    if !target_ok(org, action, &o["target"]) {
        return Err(bad(ENTRY_TARGET));
    }
    Ok(Entry { id: id.to_string(), tseq, ts, action: action.to_string(), target: o["target"].clone() })
}

fn find_server<'a>(map: &'a Value, id: &str) -> Option<&'a Obj> {
    map.get("mcp_servers").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).find(|s| s.get("id").and_then(Value::as_str) == Some(id))
}

fn str_list(v: Option<&Value>) -> Vec<&str> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
}

/// Folding (8.2): whether a newly pinned `map` contains the entry's restriction, so the entry leaves the active
/// set. `dropped_expires`: for `mcp_credential_drop`, the `auth.expires` the gateway held when it applied the drop
/// (None when the server was not pinned then: any credential in a later map is a new one).
pub fn folds(e: &Entry, map: &Value, dropped_expires: Option<i64>) -> bool {
    if e.action == "mcp_off" {
        return false;
    }
    let Some(s) = find_server(map, e.server()) else { return true };
    let t = &e.target;
    match e.action.as_str() {
        "mcp_server_off" => false,
        "mcp_tool_off" => !s.get("tools").and_then(Value::as_array).into_iter().flatten().any(|x| x.get("name") == t.get("tool")),
        "mcp_lower_ceiling" => match (s.get("ceiling").and_then(Value::as_str).and_then(ceiling_rank), t.get("ceiling").and_then(Value::as_str).and_then(ceiling_rank)) {
            (Some(have), Some(want)) => have <= want,
            _ => false,
        },
        "mcp_credential_drop" => {
            let now = s.get("auth").and_then(|a| a.get("expires")).and_then(Value::as_i64);
            dropped_expires.is_none_or(|x| now != Some(x))
        }
        "mcp_drop_group" => !str_list(s.get("groups")).contains(&t.get("group").and_then(Value::as_str).unwrap_or_default()),
        "mcp_drop_activity" => !str_list(s.get("activities")).contains(&t.get("activity").and_then(Value::as_str).unwrap_or_default()),
        "mcp_private_off" => s.get("private_ok") == Some(&Value::Bool(false)),
        "mcp_limit" => ["max_calls", "args_max", "result_max"].iter().all(|k| match t.get(*k).and_then(Value::as_i64) {
            Some(want) => s.get(*k).and_then(Value::as_i64).is_some_and(|have| have <= want),
            None => true,
        }),
        _ => false,
    }
}

/// Clearing (8.2, R6-9): the map is newer than the entry and lists its id in `mcp_cleared`.
pub fn cleared(e: &Entry, map: &Value) -> bool {
    map.get("issued").and_then(Value::as_i64).is_some_and(|issued| issued > e.ts) && str_list(map.get("mcp_cleared")).contains(&e.id.as_str())
}

/// The tightening entries a console save from `old_map` to `new_map` journals at once (8.2, 8.11), in a fixed
/// order: per old server, `mcp_server_off` when it is gone; else removed tools, a lower ceiling, removed groups,
/// removed activities, `private_ok` turned off, lowered limits (one `mcp_limit`), then a changed credential.
pub fn narrowings(old_map: &Value, new_map: &Value) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = Vec::new();
    for old in old_map.get("mcp_servers").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
        let id = old.get("id").and_then(Value::as_str).unwrap_or_default();
        let Some(new) = find_server(new_map, id) else {
            out.push(("mcp_server_off".into(), json!(id)));
            continue;
        };
        let names = |s: &Obj| -> Vec<String> { s.get("tools").and_then(Value::as_array).into_iter().flatten().filter_map(|t| t.get("name").and_then(Value::as_str)).map(str::to_string).collect() };
        let new_names = names(new);
        for t in names(old).into_iter().filter(|t| !new_names.contains(t)) {
            out.push(("mcp_tool_off".into(), json!({"server": id, "tool": t})));
        }
        let rank = |s: &Obj| s.get("ceiling").and_then(Value::as_str).and_then(ceiling_rank);
        if let (Some(a), Some(b)) = (rank(old), rank(new)) {
            if b < a {
                out.push(("mcp_lower_ceiling".into(), json!({"server": id, "ceiling": CEILINGS[b]})));
            }
        }
        let new_groups = str_list(new.get("groups"));
        for g in str_list(old.get("groups")).into_iter().filter(|g| !new_groups.contains(g)) {
            out.push(("mcp_drop_group".into(), json!({"server": id, "group": g})));
        }
        let new_acts = str_list(new.get("activities"));
        for a in str_list(old.get("activities")).into_iter().filter(|a| !new_acts.contains(a)) {
            out.push(("mcp_drop_activity".into(), json!({"server": id, "activity": a})));
        }
        if old.get("private_ok") == Some(&Value::Bool(true)) && new.get("private_ok") == Some(&Value::Bool(false)) {
            out.push(("mcp_private_off".into(), json!(id)));
        }
        let mut limit = Map::new();
        for k in ["max_calls", "args_max", "result_max"] {
            if let (Some(a), Some(b)) = (old.get(k).and_then(Value::as_i64), new.get(k).and_then(Value::as_i64)) {
                if b < a {
                    limit.insert(k.into(), json!(b));
                }
            }
        }
        if !limit.is_empty() {
            limit.insert("server".into(), json!(id));
            out.push(("mcp_limit".into(), Value::Object(limit)));
        }
        let (oa, na) = (old.get("auth").cloned().unwrap_or(Value::Null), new.get("auth").cloned().unwrap_or(Value::Null));
        // a changed scope (narrower or not) revokes the old credential and its cached token at once
        let changed = ["type", "issuer", "client_id", "kids", "scope"].iter().any(|k| oa.get(*k) != na.get(*k));
        let lowered = matches!((oa.get("expires").and_then(Value::as_i64), na.get("expires").and_then(Value::as_i64)), (Some(a), Some(b)) if b < a);
        if changed || lowered {
            out.push(("mcp_credential_drop".into(), json!(id)));
        }
    }
    out
}

// ── RFC 8785 and the tools' hashes ───────────────────────────────────────────────────────────────────────────

fn jcs_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn jcs_into(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = match (n.as_i64(), n.as_u64()) {
                (Some(i), _) if i.unsigned_abs() <= 1 << 53 => {
                    out.push_str(&i.to_string());
                    return;
                }
                (_, Some(u)) if u <= 1 << 53 => {
                    out.push_str(&u.to_string());
                    return;
                }
                _ => n.as_f64().unwrap_or(0.0),
            };
            out.push_str(&js_number_string(f));
        }
        Value::String(s) => jcs_string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                jcs_into(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                jcs_string(k, out);
                out.push(':');
                jcs_into(&o[*k], out);
            }
            out.push('}');
        }
    }
}

/// RFC 8785 (JSON Canonicalization Scheme) text of a value.
pub fn jcs(v: &Value) -> String {
    let mut out = String::new();
    jcs_into(v, &mut out);
    out
}

/// `schema_sha256` of a `tools/list` entry: SHA-256 of the JCS form of its `name`, `description` and `inputSchema`
/// (the keys the entry carries).
pub fn schema_sha256(tool: &Value) -> String {
    let mut o = Map::new();
    for k in ["name", "description", "inputSchema"] {
        if let Some(v) = tool.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    sha256_hex(jcs(&Value::Object(o)).as_bytes())
}

/// The client assertion's JOSE header and claims (8.4): `aud` is the issuer only, `exp` 60 seconds after `iat`.
pub fn assertion_parts(issuer: &str, client_id: &str, kid: &str, iat: i64, jti: &str) -> (Value, Value) {
    (
        json!({"alg": "ES256", "kid": kid, "typ": "client-authentication+jwt"}),
        json!({"iss": client_id, "sub": client_id, "aud": issuer, "iat": iat, "exp": iat + 60, "jti": jti}),
    )
}

/// The token request form (8.4) as ordered pairs.
pub fn token_form(assertion: &str, resource: &str, scope: &str) -> Vec<(&'static str, String)> {
    vec![
        ("grant_type", "client_credentials".into()),
        ("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer".into()),
        ("client_assertion", assertion.into()),
        ("resource", resource.into()),
        ("scope", scope.into()),
    ]
}

#[cfg(test)]
pub(crate) mod testmaps {
    use super::*;

    pub const SERVER_A: &str = "m_3f2e1d0c9b8a7f6e";
    pub const SERVER_B: &str = "m_0123456789abcdef";

    /// A valid server entry for the test policy (`acme.example`, groups `eng`, admins ann and carl).
    pub fn server(id: &str, name: &str, ceiling: &str, tools: &[&str]) -> Value {
        let tools: Vec<Value> = tools.iter().map(|t| json!({"name": t, "effect": "read", "schema_sha256": schema_sha256(&tool_listing(t))})).collect();
        json!({
            "id": id, "name": name, "url": format!("https://{}.mcp.acme.example/mcp", &id[2..6]), "ceiling": ceiling, "private_ok": false,
            "groups": ["eng"], "activities": ["search", "assist"],
            "auth": {"type": "oauth_private_key_jwt", "issuer": "https://auth.acme.example", "client_id": "lucid-ai-gateway", "scope": "issues:read",
                     "kids": {"ai@apps.acme.example": "g1"}, "expires": 1_795_000_000 + 300 * 86_400},
            "attest": {"by": ["ann@acme.example", "carl@acme.example"], "at": 1_795_000_000, "statement": "Every member of eng may read every issue."},
            "tools": tools, "max_calls": 4, "args_max": 4096, "result_max": 65536,
        })
    }

    /// The `tools/list` entry the fake servers list for a tool name.
    pub fn tool_listing(name: &str) -> Value {
        json!({"name": name, "description": format!("Look up {name}."), "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}})
    }

    pub fn map(servers: Vec<Value>) -> Value {
        json!({"v": 1, "org": "acme", "seq": 2, "issued": 1_795_000_000,
               "gateways": [{"url": "https://ai.acme.example:8443", "principal": "ai@apps.acme.example", "device": "a1a1a1a1a1a1a1a1", "spki": "ab".repeat(32)}],
               "mcp_servers": servers})
    }
}

#[cfg(test)]
mod tests {
    use super::testmaps::*;
    use super::*;

    fn obj(v: &Value) -> &Obj {
        v.as_object().unwrap()
    }

    fn policy() -> Value {
        json!({"org": "acme", "domains": ["acme.example"], "admins": ["ann@acme.example", "carl@acme.example"], "ai": {"who": {"groups": ["eng"]}}})
    }

    #[test]
    fn a_valid_allow_list_passes_and_each_rule_refuses_with_its_words() {
        let good = map(vec![server(SERVER_A, "Jira (read)", "internal", &["search_issues"])]);
        assert_eq!(check_mcp(obj(&good), Some(obj(&policy()))), Ok(()));
        let edit = |f: &dyn Fn(&mut Value)| {
            let mut m = good.clone();
            f(&mut m);
            check_mcp(obj(&m), Some(obj(&policy()))).err().unwrap_or_default()
        };
        assert_eq!(edit(&|m| m["mcp_servers"][0]["url"] = json!("https://MCP.acme.example/mcp")), MCP_URL);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["url"] = json!("https://mcp.acme.example:443/mcp")), MCP_URL);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["url"] = json!("https://mcp.acme.example/mcp/")), MCP_URL);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["url"] = json!("https://mcp.acme.example/mcp?x=1")), MCP_URL);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["groups"] = json!(["sales"])), MCP_GROUPS);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["tools"][0]["effect"] = json!("write")), MCP_TOOLS);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["max_calls"] = json!(9)), MCP_LIMITS);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["auth"]["kids"] = json!({"other@apps.acme.example": "g1"})), MCP_KIDS);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["auth"]["expires"] = json!(1_795_000_000 + 367 * 86_400)), MCP_EXPIRES);
        assert_eq!(edit(&|m| m["mcp_servers"][0]["auth"] = json!({"type": "mtls_only", "expires": 1_795_000_100})), MCP_MTLS_ONLY);
        assert_eq!(edit(&|m| m["mcp_cleared"] = json!(["g_beta_000001"])), MCP_CLEARED);
        assert_eq!(edit(&|m| m["mcp_servers"] = json!([m["mcp_servers"][0].clone(), m["mcp_servers"][0].clone()])), MCP_ID);
    }

    /// R6-8: a server without `attest`, with one attester, or attested by someone who is not an org admin.
    #[test]
    fn two_admin_attestation_is_required() {
        let good = map(vec![server(SERVER_A, "Jira", "internal", &["search_issues"])]);
        let mut none = good.clone();
        none["mcp_servers"][0].as_object_mut().unwrap().remove("attest");
        assert_eq!(check_mcp(obj(&none), None), Err(MCP_SERVERS.into()));
        let mut one = good.clone();
        one["mcp_servers"][0]["attest"]["by"] = json!(["ann@acme.example", "ann@acme.example"]);
        assert_eq!(check_mcp(obj(&one), None), Err(MCP_ATTEST.into()));
        let mut app = good.clone();
        app["mcp_servers"][0]["attest"]["by"] = json!(["ann@acme.example", "bot@apps.acme.example"]);
        assert_eq!(check_mcp(obj(&app), None), Err(MCP_ATTEST.into()));
        let mut outsider = good.clone();
        outsider["mcp_servers"][0]["attest"]["by"] = json!(["ann@acme.example", "zed@acme.example"]);
        assert_eq!(check_mcp(obj(&outsider), None), Ok(()));
        assert_eq!(check_mcp(obj(&outsider), Some(obj(&policy()))), Err(MCP_ATTEST.into()));
    }

    /// R6-7 as class steps: after an internal ask calls a cui server, an internal server is no longer offered.
    #[test]
    fn the_class_gate_follows_the_policy_order_and_cui() {
        let classes: Vec<String> = CEILINGS.iter().map(|s| s.to_string()).collect();
        let cui = vec!["cui".to_string()];
        assert!(class_offers(&classes, &cui, 1, "internal"));
        assert!(class_offers(&classes, &cui, 1, "cui"));
        assert!(!class_offers(&classes, &cui, 3, "internal"));
        assert!(!class_offers(&classes, &cui, 2, "internal"));
        let custom = vec!["open".to_string(), "secret".to_string()];
        assert!(!class_offers(&custom, &[], 0, "internal"));
    }

    #[test]
    fn journal_entries_fold_and_clear_as_8_2_says() {
        let m = map(vec![server(SERVER_A, "Jira", "internal", &["search_issues", "get_issue"])]);
        let e = |action: &str, target: Value| check_entry("acme", &json!({"id": "g_acme_000001", "tseq": 1, "ts": 1_794_000_000, "action": action, "target": target})).unwrap();
        assert!(!folds(&e("mcp_off", json!("acme")), &m, None));
        assert!(!folds(&e("mcp_server_off", json!(SERVER_A)), &m, None));
        assert!(folds(&e("mcp_server_off", json!(SERVER_B)), &m, None));
        assert!(!folds(&e("mcp_tool_off", json!({"server": SERVER_A, "tool": "get_issue"})), &m, None));
        assert!(folds(&e("mcp_tool_off", json!({"server": SERVER_A, "tool": "gone"})), &m, None));
        assert!(folds(&e("mcp_lower_ceiling", json!({"server": SERVER_A, "ceiling": "confidential"})), &m, None));
        assert!(!folds(&e("mcp_lower_ceiling", json!({"server": SERVER_A, "ceiling": "public"})), &m, None));
        let expires = m["mcp_servers"][0]["auth"]["expires"].as_i64();
        assert!(!folds(&e("mcp_credential_drop", json!(SERVER_A)), &m, expires));
        assert!(folds(&e("mcp_credential_drop", json!(SERVER_A)), &m, Some(1)));
        assert!(!folds(&e("mcp_drop_group", json!({"server": SERVER_A, "group": "eng"})), &m, None));
        assert!(folds(&e("mcp_private_off", json!(SERVER_A)), &m, None));
        assert!(folds(&e("mcp_limit", json!({"server": SERVER_A, "max_calls": 4})), &m, None));
        assert!(!folds(&e("mcp_limit", json!({"server": SERVER_A, "max_calls": 2})), &m, None));
        let off = e("mcp_off", json!("acme"));
        let mut c = m.clone();
        c["mcp_cleared"] = json!(["g_acme_000001"]);
        assert!(cleared(&off, &c));
        c["issued"] = json!(1_794_000_000);
        assert!(!cleared(&off, &c));
        let widening = check_entry("acme", &json!({"id": "g_acme_000002", "tseq": 2, "ts": 1, "action": "mcp_on", "target": "acme"}));
        assert_eq!(widening.unwrap_err().1, "not-tightening");
        let wrong_id = check_entry("acme", &json!({"id": "g_acme_000009", "tseq": 2, "ts": 1, "action": "mcp_off", "target": "acme"}));
        assert_eq!(wrong_id.unwrap_err().0, 400);
    }

    #[test]
    fn narrowing_a_server_journals_each_action_in_order() {
        let old = map(vec![server(SERVER_A, "Jira", "confidential", &["a", "b"]), server(SERVER_B, "Wiki", "internal", &["c"])]);
        let mut s = server(SERVER_A, "Jira", "internal", &["a"]);
        s["groups"] = json!(["ops"]);
        s["max_calls"] = json!(2);
        let new = map(vec![s]);
        let got: Vec<String> = narrowings(&old, &new).into_iter().map(|(a, _)| a).collect();
        assert_eq!(got, ["mcp_tool_off", "mcp_lower_ceiling", "mcp_drop_group", "mcp_limit", "mcp_server_off"]);
    }

    /// A narrower OAuth scope drops the old credential at once (its cached token is broader).
    #[test]
    fn a_changed_scope_journals_a_credential_drop() {
        let old = map(vec![server(SERVER_A, "Jira", "internal", &["a"])]);
        let mut s = server(SERVER_A, "Jira", "internal", &["a"]);
        s["auth"]["scope"] = json!("issues:read:own");
        let got = narrowings(&old, &map(vec![s]));
        assert_eq!(got, [("mcp_credential_drop".to_string(), json!(SERVER_A))]);
        assert!(narrowings(&old, &old).is_empty());
    }

    #[test]
    fn jcs_sorts_keys_by_utf16_and_prints_numbers_as_ecmascript() {
        let v: Value = serde_json::from_str(r#"{"b":[1.5,1e21,1e-7,-0.0,100],"a":"\u0001\"é","\ud83d\ude00":1,"\uffff":2}"#).unwrap();
        assert_eq!(jcs(&v), "{\"a\":\"\\u0001\\\"é\",\"b\":[1.5,1e+21,1e-7,0,100],\"\u{1f600}\":1,\"\u{ffff}\":2}");
    }

    /// `tests/ai_mcp_v1.json`, copied from the Meeting Hub's `tests/vectors` (written by `make_ai_mcp_v1.py`).
    #[test]
    fn shared_vectors_agree() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("ai_mcp_v1.json");
        let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("{} is needed (copy tests/vectors/ai_mcp_v1.json): {e}", path.display()));
        let doc: Value = serde_json::from_slice(&raw).unwrap();
        let policy = doc["policy"].as_object().cloned().unwrap();
        for c in doc["maps"].as_array().unwrap() {
            let with = c["with_policy"].as_bool().unwrap_or(false).then_some(&policy);
            let got = crate::meet_org_policy::check_ai_map(&c["map"], with).err().map(|e| e.to_string()).unwrap_or_default();
            assert_eq!(got, c["error"].as_str().unwrap(), "map case {}", c["name"]);
        }
        for c in doc["schema"].as_array().unwrap() {
            let mut o = Map::new();
            for k in ["name", "description", "inputSchema"] {
                if let Some(v) = c["tool"].get(k) {
                    o.insert(k.into(), v.clone());
                }
            }
            assert_eq!(jcs(&Value::Object(o)), c["jcs"].as_str().unwrap(), "schema case {}", c["name"]);
            assert_eq!(schema_sha256(&c["tool"]), c["schema_sha256"].as_str().unwrap(), "schema case {}", c["name"]);
        }
        let a = &doc["assertion"];
        let s = |k: &str| a[k].as_str().unwrap().to_string();
        let (header, claims) = assertion_parts(&s("issuer"), &s("client_id"), &s("kid"), a["iat"].as_i64().unwrap(), &s("jti"));
        assert_eq!(header, a["header"]);
        assert_eq!(claims, a["claims"]);
        let form: Map<String, Value> = token_form("x", &s("url"), &s("scope")).into_iter().filter(|(k, _)| *k != "client_assertion").map(|(k, v)| (k.to_string(), Value::from(v))).collect();
        assert_eq!(Value::Object(form), a["form"]);
        for c in doc["journal"].as_array().unwrap() {
            let org = c["map"]["org"].as_str().unwrap();
            let e = check_entry(org, &c["entry"]).unwrap_or_else(|x| panic!("journal case {}: {x:?}", c["name"]));
            assert_eq!(folds(&e, &c["map"], c["dropped_expires"].as_i64()), c["folds"].as_bool().unwrap(), "journal case {}", c["name"]);
            assert_eq!(cleared(&e, &c["map"]), c["cleared"].as_bool().unwrap(), "journal case {}", c["name"]);
        }
        for c in doc["working_class"].as_array().unwrap() {
            let strs = |v: &Value| -> Vec<String> { v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect() };
            let (classes, cui) = (strs(&c["classes"]), strs(&c["cui_classes"]));
            let mut working = classes.iter().position(|x| Some(x.as_str()) == c["ask_class"].as_str()).unwrap();
            let servers: Vec<(String, String)> = c["servers"].as_array().unwrap().iter().map(|s| (s["id"].as_str().unwrap().into(), s["ceiling"].as_str().unwrap().into())).collect();
            for step in c["steps"].as_array().unwrap() {
                let offered: Vec<String> = servers.iter().filter(|(_, ceil)| class_offers(&classes, &cui, working, ceil)).map(|(id, _)| id.clone()).collect();
                assert_eq!(offered, strs(&step["offered"]), "working class case {}", c["name"]);
                let call = step["call"].as_str().unwrap();
                let ceiling = &servers.iter().find(|(id, _)| id == call).unwrap().1;
                let outcome = if offered.iter().any(|o| o == call) {
                    working = working.max(classes.iter().position(|x| x == ceiling).unwrap());
                    "ok"
                } else {
                    "mcp-class"
                };
                assert_eq!(outcome, step["outcome"].as_str().unwrap(), "working class case {}", c["name"]);
                assert_eq!(classes[working], step["working_class"].as_str().unwrap(), "working class case {}", c["name"]);
            }
        }
    }
}
