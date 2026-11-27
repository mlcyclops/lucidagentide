// The Admin Console's Meeting Hub section (contract AC-1, 2.4, 3.1, 3.2, 3.8, 4.9, 4.10, 7.4; I8, I9). The console
// itself (sessions, passkeys, approvals, requests, audit) is src/console.rs, the same code as on the Remote Spokes
// relay; this file is what the Meeting Hub relay adds: its start (3.1 checks, the console port), the I9 product
// section whose routes call the Hub and Relay functions in process through `check_console_admin` and an Identity of
// kind `console` (L9), the device blocks kept in `denied_until` (never the denied set), the Meeting Hub license
// (`["meet"]`, the `m_` root of a self-signed `client_ca` certificate), the hooks that latch passkey anchors and
// observe `meet.*` requests, the 4.10 routes of the main port and the offline `meet console` commands.

use crate::console::{AdminRule, ApiError, Approved, Console, ConsoleConfig, Filter, LicenseCandidate, LicenseRecord, LicenseState, LicenseView, Need, ProductSection, Role, RouteSpec, SectionAnswer, SectionCall, ServiceView};
use crate::console_ai as ai;
use crate::console_limits::Limit;
use crate::console_spokes::{clean, reason_of};
use crate::license::{license_standing, license_token_of, License, LicenseStateName, Product};
use crate::meet_license::MeetGate;
use crate::meet::{self as m, Identity, Relay, E, R};
use crate::meet_hub::{push, ConsoleHooks};
use crate::meet_json::{self as pj, obj, Obj};
use crate::store::{read_text, write_private};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

// Settings > AI > Tools (MCP) (r6 8.11): a child module, so it shares the Settings > AI state and helpers below.
#[path = "console_ai_mcp.rs"]
mod console_ai_mcp;

pub const BLOCKS_FILE: &str = "console-blocks.json";
pub const LICENSE_FILE: &str = "license.lic";
/// 4.10 words.
pub const CONSOLE_OFF: &str = "The Admin Console is turned off on this relay. Set console_port in relay.json.";
pub const CONSOLE_REQUEST_FIELD: &str = "console_request must be a request id (rq_ and 16 hex)";
pub const DECLINE_ID: &str = "id must be a request id (rq_ and 16 hex)";
pub const DECLINE_REASON: &str = "reason must be 1 to 500 characters";
pub const NO_REQUEST: &str = "There is no such request.";
/// 2.4: a Meeting Hub license that does not fit (logged as `license.refused` at start).
const NO_LICENSE: &str = "This relay has no Meeting Hub license.";
const PRODUCT_WORDS: &str = "Meeting Hub";
/// Blocks (M9, as 4.8): at most 1000; 1 to 720 hours; one admin while the target's single-admin time in 7 days stays
/// at most 24 hours (the 5 an hour per admin is the core console's `Limit::Blocks`).
pub const BLOCKS_MAX: usize = 1000;
pub const BLOCK_HOURS_MAX: i64 = 720;
const HOUR_MS: i64 = 3_600_000;
const SINGLE_ADMIN_MS: i64 = 24 * HOUR_MS;
const WINDOW_MS: i64 = 7 * 24 * HOUR_MS;
const SPENT_MAX: usize = 4 * BLOCKS_MAX;
/// Holds: up to 10 items on one admin's word; a placer may release their own single-admin hold within 24 hours.
const HOLD_SINGLE_MAX: usize = 10;
const HOLD_RELEASE_MS: i64 = 24 * HOUR_MS;
const LIST_DEFAULT: usize = 100;
const LIST_MAX: usize = 500;
const SEARCH_MAX: usize = 50;
const PEOPLE_STATES: [&str; 6] = ["online", "joined", "waiting", "approved", "invited", "expired"];

/// The 4.9 routes, each with its role (L1). GETs check the license themselves: the section reads in every state but
/// none; CRL uploads, blocks, unblocks and hold placement are security actions that work in every state (2.4); bridge
/// changes check the product themselves (turning a bridge off works in every state).
pub static ROUTES: [RouteSpec; 59] = [
    // TH-1 6: the organization's brand for the guest portal and the web sign-in (meet_brand.rs); setting it needs the
    // product license, going back to the standard theme works in every state. The logo comes as JSON {type, data
    // (base64), remove}: console POSTs are JSON.
    RouteSpec { method: "GET", path: "meet/brand", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/brand", role: Role::Admin, action: "meet.brand.set", target: "-", stepup: true, need: Need::Product, security: false, keys: &crate::meet_brand::FIELD_KEYS, body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/brand/logo", role: Role::Admin, action: "meet.brand.logo", target: "-", stepup: true, need: Need::Product, security: false, keys: &crate::meet_brand::LOGO_KEYS, body_max: crate::meet_brand::LOGO_BODY_MAX },
    RouteSpec { method: "POST", path: "meet/brand/reset", role: Role::Admin, action: "meet.brand.reset", target: "-", stepup: true, need: Need::Any, security: false, keys: &["reason"], body_max: 1024 },
    // MR-1 2.5, 4: this relay's cluster node (role, epoch, generation, lag), the directory it holds, and the operator's
    // role changes (each restarts the relay in its new role once answered)
    RouteSpec { method: "GET", path: "meet/cluster/status", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/cluster/directory", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/cluster/promote", role: Role::Admin, action: "meet.cluster.promote", target: "-", stepup: true, need: Need::Any, security: false, keys: &["force", "reason"], body_max: 1024 },
    RouteSpec { method: "POST", path: "meet/cluster/demote", role: Role::Admin, action: "meet.cluster.demote", target: "-", stepup: true, need: Need::Any, security: false, keys: &["reason"], body_max: 1024 },
    RouteSpec { method: "POST", path: "meet/cluster/handover", role: Role::Admin, action: "meet.cluster.handover", target: "-", stepup: true, need: Need::Any, security: false, keys: &["reason"], body_max: 1024 },
    RouteSpec { method: "GET", path: "meet/people", role: Role::Manager, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    // SE-1 (meet_support.rs): the support tickets people's Meeting Hubs filed; reads and answers in every license
    // state, since a support question is most needed when something is wrong
    RouteSpec { method: "GET", path: "meet/support", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/support/answer", role: Role::Admin, action: "meet.support.answer", target: "id", stepup: true, need: Need::Any, security: false, keys: &["id", "text"], body_max: 64 * 1024 },
    RouteSpec { method: "POST", path: "meet/support/close", role: Role::Admin, action: "meet.support.close", target: "id", stepup: true, need: Need::Any, security: false, keys: &["id"], body_max: 1024 },
    // 2.4 seats and trusted time (R4-2, R3-M3): allowed in every license state
    RouteSpec { method: "GET", path: "meet/seats", role: Role::Manager, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/seats/pick", role: Role::Manager, action: "meet.seats.pick", target: "principal", stepup: true, need: Need::Any, security: false, keys: &["principal", "pick"], body_max: 1024 },
    RouteSpec { method: "POST", path: "meet/seats/request", role: Role::Admin, action: "meet.seats.request", target: "-", stepup: false, need: Need::Any, security: false, keys: &["wanted"], body_max: 1024 },
    RouteSpec { method: "GET", path: "meet/clock", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/clock/confirm", role: Role::Admin, action: "meet.clock.confirm", target: "-", stepup: true, need: Need::Any, security: false, keys: &["browserTime", "reason"], body_max: 2048 },
    RouteSpec { method: "GET", path: "meet/enrollments", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/organizations", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/organizations", role: Role::Admin, action: "meet.org.set", target: "principal", stepup: true, need: Need::Product, security: false, keys: &["principal", "id", "label", "remove", "reason"], body_max: 8192 },
    RouteSpec { method: "GET", path: "meet/signer", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/crl", role: Role::Admin, action: "meet.crl", target: "-", stepup: true, need: Need::Any, security: true, keys: &["crl_pem"], body_max: m::BODY_MAX },
    RouteSpec { method: "POST", path: "meet/block", role: Role::Admin, action: "meet.block", target: "principal+device", stepup: true, need: Need::Any, security: true, keys: &["principal", "device", "hours", "reason"], body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/unblock", role: Role::Admin, action: "meet.unblock", target: "principal+device", stepup: true, need: Need::Any, security: true, keys: &["principal", "device", "reason"], body_max: 4096 },
    RouteSpec { method: "GET", path: "meet/bridge", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/bridge", role: Role::Admin, action: "meet.bridge.set", target: "org", stepup: true, need: Need::Any, security: false, keys: &["org", "policy", "reason"], body_max: m::BODY_MAX },
    RouteSpec { method: "GET", path: "meet/bridge/audit", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/holds", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/holds", role: Role::Admin, action: "meet.holds.place", target: "-", stepup: true, need: Need::Any, security: true, keys: &["on", "principals", "cids", "reason"], body_max: m::BODY_MAX },
    RouteSpec { method: "POST", path: "meet/holds/release", role: Role::Admin, action: "meet.holds.release", target: "id", stepup: true, need: Need::Product, security: false, keys: &["id", "reason"], body_max: 4096 },
    RouteSpec { method: "GET", path: "meet/release", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/release", role: Role::Admin, action: "meet.release.set", target: "version", stepup: true, need: Need::Product, security: false, keys: &["version", "files", "ios", "android", "notes", "minimum", "reason"], body_max: 32 * 1024 },
    RouteSpec { method: "GET", path: "meet/push", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/identity", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/calls", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "GET", path: "meet/servers", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/files/start", role: Role::Admin, action: "meet.files.start", target: "-", stepup: true, need: Need::Product, security: false, keys: &[], body_max: 1024 },
    // Settings > AI (AI-1 section 9): reads, the staged save, gateways and cards, usage, the hold on a person, the archive
    RouteSpec { method: "GET", path: "meet/ai", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/ai/stage", role: Role::Admin, action: "meet.ai.stage", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "preset", "ai", "map"], body_max: AI_STAGE_BODY_MAX },
    RouteSpec { method: "POST", path: "meet/ai/save", role: Role::Admin, action: "meet.ai.save", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "stage", "reason"], body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/ai/gateways", role: Role::Admin, action: "meet.ai.gateway", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "url", "principal", "device", "spki", "region", "remove", "reason"], body_max: 4096 },
    RouteSpec { method: "GET", path: "meet/ai/cards", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/ai/cards/bench", role: Role::Admin, action: "meet.ai.bench", target: "card_id", stepup: true, need: Need::Product, security: false, keys: &["org", "gateway", "card_id", "files"], body_max: 16 * 1024 },
    RouteSpec { method: "POST", path: "meet/ai/cards/approve", role: Role::Admin, action: "meet.ai.approve", target: "card_id", stepup: true, need: Need::Product, security: false, keys: &["org", "gateway", "card_id", "for_classes", "retention_override", "reason"], body_max: 4096 },
    RouteSpec { method: "GET", path: "meet/ai/usage", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/ai/hold", role: Role::Admin, action: "meet.ai.hold", target: "principal", stepup: true, need: Need::Any, security: true, keys: &["org", "principal", "reviewer", "reason"], body_max: 4096 },
    RouteSpec { method: "GET", path: "meet/ai/archive", role: Role::Admin, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/ai/archive", role: Role::Admin, action: "meet.ai.archive", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "url", "spki", "remove", "reason"], body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/ai/archive/copy", role: Role::Admin, action: "meet.ai.archive.copy", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "reviewer", "offline_copy", "reason"], body_max: 8192 },
    RouteSpec { method: "POST", path: "meet/ai/archive/code", role: Role::Admin, action: "meet.ai.archive.code", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "reviewer", "reason"], body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/ai/archive/code/confirm", role: Role::Admin, action: "meet.ai.archive.code.confirm", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "first", "second"], body_max: 1024 },
    // Settings > AI > Tools (MCP) (r6 8.11, console_ai_mcp.rs): turning off journals at once and works in every license state
    RouteSpec { method: "GET", path: "meet/ai/mcp", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 },
    RouteSpec { method: "POST", path: "meet/ai/mcp/servers", role: Role::Admin, action: "meet.ai.mcp.server", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "server", "second", "reason"], body_max: 64 * 1024 },
    RouteSpec { method: "POST", path: "meet/ai/mcp/servers/update", role: Role::Admin, action: "meet.ai.mcp.update", target: "org", stepup: true, need: Need::Product, security: false, keys: &["org", "server", "second", "clear", "reason"], body_max: 64 * 1024 },
    RouteSpec { method: "POST", path: "meet/ai/mcp/servers/off", role: Role::Admin, action: "meet.ai.mcp.server.off", target: "server", stepup: false, need: Need::Any, security: true, keys: &["org", "server", "reason"], body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/ai/mcp/off", role: Role::Admin, action: "meet.ai.mcp.off", target: "org", stepup: false, need: Need::Any, security: true, keys: &["org", "reason"], body_max: 4096 },
    RouteSpec { method: "POST", path: "meet/ai/mcp/credential", role: Role::Admin, action: "meet.ai.mcp.credential", target: "server", stepup: true, need: Need::Product, security: false, keys: &["org", "server", "op", "cert_pem", "chain_pem", "gateway", "reason"], body_max: 64 * 1024 },
    RouteSpec { method: "POST", path: "meet/ai/mcp/test", role: Role::Admin, action: "meet.ai.mcp.test", target: "server", stepup: false, need: Need::Product, security: false, keys: &["org", "server", "draft"], body_max: 32 * 1024 },
];
/// A staged AI change carries the whole map draft (the signed map is at most 256 KiB, 2).
const AI_STAGE_BODY_MAX: usize = 300 * 1024;

/// AC-2a 4.11: the aggregate route served only through the fleet proxy (`read-health`). Not in ROUTES, so the relay's
/// own console answers 404; fleet_exec takes this spec and calls `route` with it.
pub static FLEET_ROUTES: [RouteSpec; 1] = [RouteSpec { method: "GET", path: "meet/counts", role: Role::Viewer, action: "", target: "-", stepup: false, need: Need::Any, security: false, keys: &[], body_max: 0 }];

/// AC-2a 8.2 `services` of a Meeting Hub relay row, from its latest `read-health` answers of `meet/servers`
/// (`{signer: null or {healthy, days_left}, files: null or {state, since}}`; null signer: none configured) and `meet/push` (`{enabled, failed24h, ...}`):
/// flags, days, the files state word and counts only. A part whose answer is missing is null.
pub fn services_summary(servers: Option<&Value>, push: Option<&Value>) -> Value {
    let signer = servers.and_then(|s| s.get("signer")).map(|h| json!({ "healthy": h.get("healthy").and_then(Value::as_bool), "daysLeft": h.get("days_left").and_then(Value::as_i64) }));
    let files = servers.and_then(|s| s.get("files")).and_then(|f| f.get("state")).and_then(Value::as_str).map(|s| Value::from(clean(s)));
    let push = push.map(|p| json!({ "enabled": p.get("enabled").and_then(Value::as_bool), "failed24h": p.get("failed24h").and_then(Value::as_u64) }));
    json!({ "signer": signer, "files": files, "push": push })
}

const SECURITY_ACTIONS: [&str; 8] = ["meet.block", "meet.unblock", "meet.crl", "meet.revoke", "meet.holds.place", "meet.ai.hold", "meet.ai.mcp.server.off", "meet.ai.mcp.off"];
const PAGES: [&str; 18] = ["people", "seats", "enrollments", "organizations", "signer", "bridges", "holds", "releases", "push", "identity", "calls", "servers", "license", "logs", "requests", "ai", "support", "branding"];
const LOCKED_PAGES: [&str; 6] = ["security", "seats", "license", "logs", "requests", "support"];

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────

fn invalid(words: impl Into<String>) -> ApiError {
    ApiError::with("invalid", words)
}

fn not_found(thing: &str) -> ApiError {
    ApiError::with("not-found", format!("There is no such {thing}."))
}

fn stale(why: &str) -> ApiError {
    ApiError::with("stale", format!("Nothing was changed: {}.", why.trim_end_matches('.')))
}

fn rate(minutes: i64) -> ApiError {
    ApiError::rate(minutes.max(1) * 60)
}

fn license_needed() -> ApiError {
    ApiError::with("license-needed", format!("This needs a license that includes {PRODUCT_WORDS}."))
}

/// A refused clock confirmation: a disagreeing browser is `clock-disagree`; a confirmation the relay could not save
/// (and so did not make) is `write-failed`.
fn clock_refusal(words: &'static str) -> ApiError {
    let code = if words == crate::meet_time::CLOCK_UNSAVED { "write-failed" } else { "clock-disagree" };
    ApiError::with(code, words)
}

/// A Hub or Relay function's refusal as the console answers it (8.3): its own words under `invalid`, `role`,
/// `not-found` or `stale`.
fn from_hub(e: E) -> ApiError {
    match e {
        E::Bad(w) => invalid(w),
        E::Forbidden(w) | E::Held(w, _) => ApiError::with("role", w),
        E::NotFound(w) => ApiError::with("not-found", w),
        E::Conflict(w) | E::ConflictInfo(w, _) | E::Gone(w) => stale(&w),
        E::Status(429, _, _) | E::Busy(..) => rate(1),
        other => {
            crate::meet::log_warn(&format!("console.meet-failed why={}", m::kv(&other.message())));
            ApiError::of("write-failed")
        }
    }
}

/// MR-1 2.4: on a standby or fenced node the console (local, or through the fleet link, or an approved action) changes
/// nothing but the cluster role and the node's own CRL and clock; everything else would be state the active never
/// sees. `what` is a route path or an action.
fn cluster_write_guard(relay: &Relay, what: &str) -> Result<(), ApiError> {
    const PER_NODE: [&str; 4] = ["meet/crl", "meet.crl", "meet/clock/confirm", "meet.clock.confirm"];
    if what.starts_with("meet/cluster/") || PER_NODE.contains(&what) {
        return Ok(());
    }
    relay.hub.cluster_writes().map_err(|(_, words)| stale(words))
}

fn license_state_of(s: Option<LicenseStateName>) -> LicenseState {
    match s {
        Some(LicenseStateName::Valid) => LicenseState::Valid,
        Some(LicenseStateName::Grace) => LicenseState::Grace,
        Some(LicenseStateName::Expired) => LicenseState::Expired,
        None => LicenseState::None,
    }
}

fn writes_allowed(state: LicenseState) -> bool {
    matches!(state, LicenseState::Valid | LicenseState::Grace)
}

/// decodeURIComponent of a query part with `+` as a space, or None for a bad escape or bad UTF-8.
fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// The query's filters among `allowed`; an unknown name answers 400 "Unknown filter: <name>." (4.1).
fn filters(query: &str, allowed: &[&str]) -> Result<HashMap<String, String>, ApiError> {
    let mut out = HashMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let k = decode(k).ok_or_else(|| invalid("A filter could not be read."))?;
        if !allowed.contains(&k.as_str()) {
            return Err(invalid(format!("Unknown filter: {}.", clean(&k))));
        }
        let v = decode(v).ok_or_else(|| invalid("A filter could not be read."))?;
        if !v.is_empty() {
            out.insert(k, v);
        }
    }
    Ok(out)
}

fn limit_of(f: &HashMap<String, String>) -> Result<usize, ApiError> {
    match f.get("limit") {
        None => Ok(LIST_DEFAULT),
        Some(v) => v.parse::<usize>().ok().filter(|n| (1..=LIST_MAX).contains(n)).ok_or_else(|| invalid("limit is 1 to 500.")),
    }
}

fn search_text(f: &HashMap<String, String>) -> Result<Option<String>, ApiError> {
    match f.get("q") {
        None => Ok(None),
        Some(v) => {
            let q = clean(v).to_lowercase();
            if !(2..=100).contains(&q.chars().count()) {
                return Err(invalid("The search text is 2 to 100 characters."));
            }
            Ok(Some(q))
        }
    }
}

/// `rq_` and 16 lower-case hex (4.10).
pub fn request_id_ok(id: &str) -> bool {
    id.strip_prefix("rq_").map(|h| h.len() == 16 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).unwrap_or(false)
}

// ── device blocks (`denied_until`) ───────────────────────────────────────────────────────────────────────────

/// One Meet device block (M9): `principal|device` until a time; never a revocation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeetBlock {
    pub principal: String,
    pub device: String,
    pub placed_by: String,
    pub placed_at: i64,
    pub until: i64,
    pub reason: String,
    pub single: bool,
}

impl MeetBlock {
    fn key(&self) -> String {
        m::key(&self.principal, &self.device)
    }

    pub fn view(&self) -> Value {
        json!({"until": self.until, "by": self.placed_by, "reason": self.reason, "placedAt": self.placed_at, "path": if self.single { "single" } else { "approved" }})
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Spent {
    key: String,
    from: i64,
    to: i64,
}

/// `console-blocks.json` (owner-only, fail closed: a file that does not read back stops the relay), with each held
/// hold's path for the release rule.
pub struct MeetBlocks {
    file: Option<PathBuf>,
    list: Vec<MeetBlock>,
    spent: Vec<Spent>,
    /// hold id -> "single" or "approved" (4.9 holds `path`).
    holds: Obj,
}

impl MeetBlocks {
    pub fn memory() -> MeetBlocks {
        MeetBlocks { file: None, list: Vec::new(), spent: Vec::new(), holds: Obj::new() }
    }

    pub fn open(file: &Path) -> Result<MeetBlocks, String> {
        let mut b = MeetBlocks { file: Some(file.to_owned()), ..MeetBlocks::memory() };
        let Some(text) = read_text(file) else { return Ok(b) };
        let bad = || format!("{} does not read back: the relay does not start without its block list (move it aside only after checking it)", file.display());
        let parsed: Value = serde_json::from_str(&text).map_err(|_| bad())?;
        let o = parsed.as_object().filter(|o| o.get("v") == Some(&json!(1))).ok_or_else(bad)?;
        let block = |v: &Value| -> Option<MeetBlock> {
            let o = v.as_object()?;
            Some(MeetBlock {
                principal: o.get("principal")?.as_str()?.to_owned(),
                device: o.get("device")?.as_str()?.to_owned(),
                placed_by: o.get("placedBy")?.as_str()?.to_owned(),
                placed_at: o.get("placedAt")?.as_i64()?,
                until: o.get("until")?.as_i64()?,
                reason: o.get("reason")?.as_str()?.to_owned(),
                single: o.get("path")?.as_str()? == "single",
            })
        };
        let spent = |v: &Value| -> Option<Spent> {
            let o = v.as_object()?;
            Some(Spent { key: o.get("key")?.as_str()?.to_owned(), from: o.get("from")?.as_i64()?, to: o.get("to")?.as_i64()? })
        };
        b.list = o.get("meet").and_then(Value::as_array).ok_or_else(bad)?.iter().map(block).collect::<Option<Vec<_>>>().ok_or_else(bad)?;
        b.spent = o.get("spent").and_then(Value::as_array).ok_or_else(bad)?.iter().map(spent).collect::<Option<Vec<_>>>().ok_or_else(bad)?;
        b.holds = o.get("holds").and_then(Value::as_object).cloned().unwrap_or_default();
        if b.list.len() > BLOCKS_MAX || b.spent.len() > SPENT_MAX {
            return Err(bad());
        }
        Ok(b)
    }

    fn save(&self) -> Result<(), String> {
        let Some(file) = &self.file else { return Ok(()) };
        let list: Vec<Value> = self
            .list
            .iter()
            .map(|b| json!({"principal": b.principal, "device": b.device, "placedBy": b.placed_by, "placedAt": b.placed_at, "until": b.until, "reason": b.reason, "path": if b.single { "single" } else { "approved" }}))
            .collect();
        let spent: Vec<Value> = self.spent.iter().map(|s| json!({"key": s.key, "from": s.from, "to": s.to})).collect();
        let text = format!("{}\n", json!({"v": 1, "meet": list, "spent": spent, "holds": self.holds}));
        write_private(file, text.as_bytes()).map_err(|e| e.to_string())
    }

    /// The hub's mirror: `principal|device` -> until (seconds).
    pub fn mirror(&self, t: i64) -> HashMap<String, f64> {
        self.list.iter().filter(|b| b.until > t).map(|b| (b.key(), b.until as f64 / 1000.0)).collect()
    }

    pub fn get(&self, principal: &str, device: &str, t: i64) -> Option<&MeetBlock> {
        self.list.iter().find(|b| b.principal == principal && b.device == device && b.until > t)
    }

    pub fn active(&self, t: i64) -> usize {
        self.list.iter().filter(|b| b.until > t).count()
    }

    pub fn single_admin_ms(&self, key: &str, t: i64) -> i64 {
        let start = t - WINDOW_MS;
        self.spent.iter().filter(|s| s.key == key && s.to > start).map(|s| s.to - s.from.max(start)).sum()
    }

    /// M9: one admin while the target's single-admin time in 7 days, this block included, is at most 24 hours; never
    /// alone for a device of a relay admin.
    pub fn single_ok(&self, principal: &str, device: &str, hours: i64, relay_admin: bool, t: i64) -> bool {
        !relay_admin && self.spent.len() < SPENT_MAX && self.single_admin_ms(&m::key(principal, device), t) + hours * HOUR_MS <= SINGLE_ADMIN_MS
    }

    fn end_spent(&mut self, key: &str, t: i64) {
        for s in self.spent.iter_mut().filter(|s| s.key == key && s.to > t) {
            s.to = t.max(s.from);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn place(&mut self, principal: &str, device: &str, hours: i64, reason: &str, by: &str, single: bool, t: i64) -> Result<MeetBlock, ApiError> {
        let block = MeetBlock { principal: principal.into(), device: device.into(), placed_by: by.into(), placed_at: t, until: t + hours * HOUR_MS, reason: reason.into(), single };
        let (list, spent) = (self.list.clone(), self.spent.clone());
        self.list.retain(|b| b.until > t);
        if let Some(i) = self.list.iter().position(|b| b.key() == block.key()) {
            self.end_spent(&block.key(), t);
            self.list.remove(i);
        }
        if self.list.len() >= BLOCKS_MAX {
            let first = self.list.iter().map(|b| b.until).min().unwrap_or(t);
            self.list = list;
            self.spent = spent;
            return Err(rate(((first - t).max(0) + 59_999) / 60_000));
        }
        self.list.push(block.clone());
        if single {
            self.spent.push(Spent { key: block.key(), from: t, to: block.until });
        }
        self.spent.retain(|s| s.to > t - WINDOW_MS);
        if let Err(e) = self.save() {
            self.list = list;
            self.spent = spent;
            crate::meet::log_error(&format!("{BLOCKS_FILE} cannot be written: {e}"));
            return Err(ApiError::of("write-failed"));
        }
        Ok(block)
    }

    pub fn lift(&mut self, principal: &str, device: &str, t: i64) -> Result<MeetBlock, ApiError> {
        let Some(i) = self.list.iter().position(|b| b.principal == principal && b.device == device && b.until > t) else { return Err(stale("that device is not blocked")) };
        let (list, spent) = (self.list.clone(), self.spent.clone());
        let gone = self.list.remove(i);
        self.end_spent(&gone.key(), t);
        if let Err(e) = self.save() {
            self.list = list;
            self.spent = spent;
            crate::meet::log_error(&format!("{BLOCKS_FILE} cannot be written: {e}"));
            return Err(ApiError::of("write-failed"));
        }
        Ok(gone)
    }

    fn hold_path(&self, id: &str) -> &str {
        self.holds.get(id).and_then(Value::as_str).unwrap_or("approved")
    }

    fn set_hold_path(&mut self, id: &str, single: bool) {
        self.holds.insert(id.into(), Value::from(if single { "single" } else { "approved" }));
        if let Err(e) = self.save() {
            crate::meet::log_error(&format!("{BLOCKS_FILE} cannot be written: {e}"));
        }
    }
}

/// `{principal, device, hours, reason}` of a block, `hours` 1 to 720.
pub fn parse_block(body: &Value) -> Result<(String, String, i64, String), String> {
    let principal = m::principal(body.get("principal"));
    let device = pj::str_or(body.get("device")).trim().to_string();
    if !principal.contains('@') || device.is_empty() || device.chars().count() > 64 {
        return Err("name the person (their email) and the device".into());
    }
    let hours = body.get("hours").and_then(Value::as_i64).filter(|h| (1..=BLOCK_HOURS_MAX).contains(h)).ok_or("hours is 1 to 720")?;
    let reason = reason_of(body.get("reason"))?;
    Ok((principal, device, hours, reason))
}

pub fn parse_unblock(body: &Value) -> Result<(String, String, String), String> {
    let principal = m::principal(body.get("principal"));
    let device = pj::str_or(body.get("device")).trim().to_string();
    if !principal.contains('@') || device.is_empty() {
        return Err("name the person (their email) and the device".into());
    }
    Ok((principal, device, reason_of(body.get("reason"))?))
}

// ── the license (2.4) ────────────────────────────────────────────────────────────────────────────────────────
// The license, the upgrade period and seats live in the relay's service gate (meet_license.rs); the console reads
// and installs through it, so the gate works the same with the console off.

// ── the section ──────────────────────────────────────────────────────────────────────────────────────────────

/// The Meeting Hub product section (I9). It holds the relay weakly: the relay holds the console.
pub struct MeetSection {
    relay: Weak<Relay>,
    blocks: Mutex<MeetBlocks>,
    started: i64,
}

impl MeetSection {
    pub fn new(relay: Weak<Relay>, blocks: MeetBlocks, t: i64) -> MeetSection {
        MeetSection { relay, blocks: Mutex::new(blocks), started: t }
    }

    /// The relay's service gate (license, upgrade period, trusted time, seats).
    fn gate(relay: &Relay) -> Result<Arc<MeetGate>, ApiError> {
        relay.hub.gate().ok_or_else(|| ApiError::of("state-unreadable"))
    }

    /// The Identity a read runs as: a relay admin through check_console_admin, a user manager through
    /// check_console_reader (4.9, reads only).
    fn reader(relay: &Relay, caller: &crate::console::Caller) -> Result<Identity, ApiError> {
        if caller.admin {
            return Self::who(relay, &caller.email);
        }
        relay.hub.check_console_reader(&caller.email).map_err(|_| ApiError::of("role"))
    }

    fn relay(&self) -> Result<Arc<Relay>, ApiError> {
        self.relay.upgrade().ok_or_else(|| ApiError::of("state-unreadable"))
    }

    /// The Identity the Hub functions run as (I8): the principal must be in relay.json `admins` now.
    fn who(relay: &Relay, principal: &str) -> Result<Identity, ApiError> {
        relay.hub.check_console_admin(principal).map_err(|_| stale(&format!("{principal} is not a relay admin")))
    }

    /// Where the license is read and installed: relay.json `license`, else state_dir/license.lic.
    fn license_file(relay: &Relay) -> Option<PathBuf> {
        if !relay.settings.license.trim().is_empty() {
            return Some(PathBuf::from(relay.settings.license.trim()));
        }
        m::state_file(&relay.settings, LICENSE_FILE)
    }

    /// 4.7: an install target inside state_dir; Err names where the relay reads its license from.
    fn license_target(relay: &Relay) -> Result<PathBuf, ApiError> {
        let refuse = |p: &str| ApiError::with("license-path", format!("This relay reads its license from {p}. Replace that file and restart the relay."));
        let file = Self::license_file(relay).ok_or_else(|| refuse("relay.json"))?;
        let dir = Path::new(&relay.settings.state_dir);
        let inside = !relay.settings.state_dir.is_empty() && file.parent().map(|p| std::path::absolute(p).ok() == std::path::absolute(dir).ok()).unwrap_or(false);
        if inside {
            Ok(file)
        } else {
            Err(refuse(&file.display().to_string()))
        }
    }

    fn verify(relay: &Relay, text: &str) -> Result<(License, bool), ApiError> {
        Self::gate(relay)?.verify_candidate(text).map_err(|r| ApiError::with("license-refused", format!("This license cannot be used here: {r}.")))
    }

    /// The 4.7 reference license (R6-M1): the current fitting license while one is in force (valid or grace), else
    /// `lastLicense`; None only while `lastLicense` is null (a first license).
    fn reference(gate: &MeetGate) -> Option<LicenseRecord> {
        if gate.standing().active {
            if let Some((l, _)) = gate.license() {
                return Some(LicenseRecord::of(&l));
            }
        }
        gate.last_license().map(|l| LicenseRecord { product: Product::Meet, root: l.root, id: l.id, edition: l.edition, users: l.users, relays: l.relays, exp: l.exp })
    }

    /// The license state the console uses, from the gate's standing in trusted time (`none` covers no license, the
    /// wrong product and the wrong root).
    fn license_now(relay: &Relay) -> LicenseState {
        let Ok(gate) = Self::gate(relay) else { return LicenseState::None };
        license_state_of(gate.standing().license.state)
    }

    /// AC-2a 4.11 `GET /console/api/meet/counts` (fleet proxy, `read-health`): integers only, built field by field
    /// from the projection allowlist; no id, label, name, serial, time, reason or actor.
    fn counts(&self, relay: &Relay, t: i64) -> Value {
        let c = relay.hub.fleet_counts();
        let gate = Self::gate(relay).ok();
        let seated = gate.as_ref().map_or(0, |g| c.principals.iter().filter(|p| g.is_seated(p)).count());
        let blocked = {
            let blocks = self.blocks.lock();
            c.devices.iter().filter(|(p, d)| blocks.get(p, d, t).is_some()).count()
        };
        json!({
            "ok": true,
            "people": { "online": c.online.len(), "seated": seated, "total": c.principals.len(), "unseated": c.principals.len() - seated },
            "devices": { "online": c.devices_online, "total": c.devices.len(), "blocked": blocked, "revoked": c.revoked },
            "calls": { "active": c.calls_active, "participants": c.participants },
            "enrollments": { "waiting": c.enrollments_waiting },
        })
    }

    /// 2.4 Meet users: the seated principals (meet_license.rs, meet_seats.rs).
    fn used(relay: &Relay) -> i64 {
        Self::gate(relay).map(|g| g.seat_counts().0).unwrap_or(0)
    }

    fn license_object(&self, relay: &Relay, l: &License, dev: bool) -> Value {
        let gate = Self::gate(relay).ok();
        let t = gate.as_ref().map(|g| g.time.now()).unwrap_or_else(|| (pj::now() * 1000.0) as i64);
        let standing = license_standing(Some(l), t.div_euclid(1000));
        let days_left = crate::license::license_state(l, t.div_euclid(1000)).1;
        // 8.2 `license` (R3-M4): whether the upgrade period stays as a fallback after this license
        let upgrade = gate.as_ref().map(|g| g.upgrade()).and_then(|u| u.ends);
        let keeps = gate.as_ref().is_some_and(|g| g.keeps_period(l.grace_end()));
        json!({
            "id": l.id, "org": l.org, "product": l.product().as_str(), "edition": l.edition, "users": l.users, "used": Self::used(relay),
            "relays": l.relays, "exp": l.exp, "state": standing.state_str(), "daysLeft": days_left, "dev": dev, "graceDays": l.effective_grace_days(),
            "graceEnd": standing.grace_end.map(|g| g * 1000), "upgradePeriodEnds": upgrade.map(|e| e * 1000), "keepsUpgradePeriod": keeps,
        })
    }

    // ── the GET views ──

    fn people(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        let f = filters(call.query, &["q", "org", "state", "limit"])?;
        let q = search_text(&f)?;
        let limit = limit_of(&f)?;
        if let Some(s) = f.get("state").filter(|s| !PEOPLE_STATES.contains(&s.as_str())) {
            return Err(invalid(format!("state is {}, not {}.", PEOPLE_STATES.join(", "), clean(s))));
        }
        let who = Self::reader(relay, call.caller)?;
        let gate = Self::gate(relay)?;
        let devices = relay.hub.admin_devices("", &who).map_err(from_hub)?;
        let orgs = relay.hub.admin_organizations("", &who).map_err(from_hub)?;
        let pending = relay.hub.admin_pending("", &who).map_err(from_hub)?;
        let directory = relay.hub.st.lock().directory.clone();
        let blocks = self.blocks.lock();
        let mut people: indexmap::IndexMap<String, Obj> = indexmap::IndexMap::new();
        fn person(people: &mut indexmap::IndexMap<String, Obj>, principal: &str, name: &str) {
            let entry = people.entry(principal.to_string()).or_insert_with(|| obj([("principal", Value::from(principal)), ("name", Value::from(name)), ("org", Value::Null), ("state", Value::from("joined")), ("devices", Value::Array(Vec::new()))]));
            if pj::s(entry, "name").is_empty() {
                entry.insert("name".into(), Value::from(name));
            }
        }
        for (p, e) in &directory {
            let name = e.get("name").and_then(Value::as_str).unwrap_or_default();
            person(&mut people, p, name);
        }
        for d in devices.get("devices").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
            let principal = pj::s(d, "principal");
            person(&mut people, &principal, "");
            let device = pj::s(d, "device");
            let info = directory.get(&principal).and_then(|e| e.get("devices")).and_then(|ds| ds.get(&device)).and_then(Value::as_object).cloned().unwrap_or_default();
            let serial = m::serial_of(info.get("serial"));
            let online = pj::truthy(d.get("online"));
            let row = json!({
                "device": device,
                "label": d.get("label").cloned().unwrap_or(Value::Null),
                "serial": serial,
                "notAfter": info.get("not_after").cloned().unwrap_or(Value::Null),
                "lastSeenAt": pj::as_num(d.get("last_seen")).map(|s| (s * 1000.0) as i64),
                "online": online,
                "revoked": !serial.is_empty() && relay.hub.is_denied(&serial),
                "blocked": blocks.get(&principal, &device, call.t).map(MeetBlock::view),
            });
            if let Some(p) = people.get_mut(&principal) {
                if online {
                    p.insert("state".into(), Value::from("online"));
                }
                if let Some(Value::Array(list)) = p.get_mut("devices") {
                    list.push(row);
                }
            }
        }
        for w in pending.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
            let principal = pj::s(w, "principal");
            if principal.is_empty() {
                continue;
            }
            let name = pj::s(w, "name");
            person(&mut people, &principal, &name);
            if let Some(p) = people.get_mut(&principal) {
                if pj::text_of(p, "state") != "online" && p.get("devices").and_then(Value::as_array).map(|d| d.is_empty()).unwrap_or(true) {
                    p.insert("state".into(), Value::from("waiting"));
                }
            }
        }
        for mbr in orgs.get("members").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
            let principal = pj::s(mbr, "principal");
            if let Some(p) = people.get_mut(&principal) {
                p.insert("org".into(), json!({"id": pj::s(mbr, "id"), "label": pj::s(mbr, "label")}));
            }
        }
        drop(blocks);
        let rows: Vec<Value> = people
            .into_values()
            .filter(|p| q.as_ref().map(|q| pj::s(p, "principal").contains(q.as_str()) || pj::s(p, "name").to_lowercase().contains(q.as_str())).unwrap_or(true))
            .filter(|p| f.get("org").map(|o| p.get("org").and_then(|x| x.get("id")).and_then(Value::as_str) == Some(o.as_str())).unwrap_or(true))
            .filter(|p| f.get("state").map(|s| pj::text_of(p, "state") == *s).unwrap_or(true))
            .map(|mut p| {
                let seated = gate.is_seated(&pj::s(&p, "principal"));
                p.insert("seated".into(), Value::Bool(seated));
                Value::Object(p)
            })
            .collect();
        let total = rows.len();
        let users = gate.license().map(|(l, _)| Value::from(l.users)).unwrap_or(Value::Null);
        Ok(json!({"ok": true, "people": rows.into_iter().take(limit).collect::<Vec<_>>(), "total": total, "seats": {"users": users, "used": Self::used(relay)}}))
    }

    fn enrollments(&self, relay: &Relay, call: &SectionCall, core: Option<&Console>) -> Result<Value, ApiError> {
        filters(call.query, &[])?;
        let who = Self::who(relay, &call.caller.email)?;
        let pending = relay.hub.admin_pending("", &who).map_err(from_hub)?;
        let waiting_requests = core.map(|c| c.requests_waiting("meet.approve", call.t)).unwrap_or_default();
        let rows: Vec<Value> = pending
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|w| {
                let (kind, id, csr) = (pj::s(w, "kind"), pj::s(w, "id"), pj::s(w, "csr_sha256"));
                let request = waiting_requests
                    .iter()
                    .find(|r| r.get("target").map(|t| t.get("kind").and_then(Value::as_str) == Some(kind.as_str()) && t.get("id").and_then(Value::as_str) == Some(id.as_str())).unwrap_or(false))
                    .and_then(|r| r.get("id").cloned())
                    .unwrap_or(Value::Null);
                json!({
                    "kind": kind, "id": id, "principal": pj::s(w, "principal"), "name": pj::s(w, "name"),
                    "device": w.get("device_label").or_else(|| w.get("device")).cloned().unwrap_or(Value::Null),
                    "check": pj::s(w, "check_code"), "csr_sha256": csr,
                    "at": pj::as_num(w.get("ts")).map(|s| (s * 1000.0) as i64), "request": request,
                })
            })
            .collect();
        Ok(json!({"ok": true, "waiting": rows}))
    }

    fn org_facts(relay: &Relay, who: &Identity, org: &str) -> Result<(bool, usize), ApiError> {
        let bridges = relay.hub.bridge_admin("", who).map_err(from_hub)?;
        let on = bridges.get("policies").and_then(|p| p.get(org)).and_then(|p| p.get("enabled")) == Some(&Value::Bool(true));
        Ok((on, relay.hub.pc_org_admin_count(org)))
    }

    fn organizations(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        filters(call.query, &[])?;
        let who = Self::who(relay, &call.caller.email)?;
        let orgs = relay.hub.admin_organizations("", &who).map_err(from_hub)?;
        let members = orgs.get("members").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut rows = Vec::new();
        for o in orgs.get("organizations").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
            let id = pj::s(o, "id");
            let (on, admins) = Self::org_facts(relay, &who, &id)?;
            let policy = relay.hub.pc_policy_get(&id, "").ok().filter(|p| !p.is_empty()).map(|p| {
                let inner = p.get("policy").and_then(Value::as_object).cloned().unwrap_or_else(|| p.clone());
                json!({
                    "seq": inner.get("seq").or_else(|| p.get("seq")).cloned().unwrap_or(Value::Null),
                    "issued": inner.get("issued").or_else(|| p.get("issued")).cloned().unwrap_or(Value::Null),
                    "sha256": p.get("hash").or_else(|| p.get("sha256")).cloned().unwrap_or(Value::Null),
                    "pending_lowering": p.get("pending_lowering").cloned().unwrap_or(Value::Null),
                    "watch": crate::meet_org_policy::watch(Some(&inner)),
                })
            });
            let count = members.iter().filter(|m| m.get("id").and_then(Value::as_str) == Some(id.as_str())).count();
            rows.push(json!({"id": id, "label": pj::s(o, "label"), "members": count, "bridgesOn": on, "orgAdmins": admins, "policy": policy}));
        }
        Ok(json!({"ok": true, "organizations": rows}))
    }

    fn signer(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        filters(call.query, &[])?;
        Self::who(relay, &call.caller.email)?;
        let detail = crate::meet_console::Console::signer_detail(relay);
        let fields = ["healthy", "error", "root_mode", "not_after", "days_left", "intermediate_serial", "previous_serial", "previous_not_after", "root_not_after", "root_crl_days_left", "pending_key", "ledger_seq", "ledger_head", "policy"];
        let signer: Obj = fields.iter().filter_map(|k| detail.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
        let next_update = detail.get("crls").and_then(Value::as_array).and_then(|a| a.iter().filter_map(|c| c.get("next_update").cloned()).filter(|v| !v.is_null()).min_by(|a, b| pj::py_str(a).cmp(&pj::py_str(b))));
        Ok(json!({
            "ok": true, "signer": signer,
            "crl": {"root_days_left": detail.get("root_crl_days_left").cloned().unwrap_or(Value::Null), "next_update": next_update},
            "ledger": detail.get("ledger").cloned().unwrap_or(json!([])),
        }))
    }

    fn holds(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        filters(call.query, &[])?;
        let who = Self::who(relay, &call.caller.email)?;
        let list = relay.hub.pc_holds_list("", &who).map_err(from_hub)?;
        let blocks = self.blocks.lock();
        let rows: Vec<Value> = list
            .get("holds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|h| {
                let mut h = h.clone();
                let id = pj::s(&h, "id");
                h.insert("placedBy".into(), h.get("by").cloned().unwrap_or(Value::Null));
                h.insert("placedAt".into(), pj::as_num(h.get("placed")).map(|s| Value::from((s * 1000.0) as i64)).unwrap_or(Value::Null));
                h.insert("path".into(), Value::from(blocks.hold_path(&id)));
                Value::Object(h)
            })
            .collect();
        Ok(json!({"ok": true, "holds": rows, "on": list.get("on").cloned().unwrap_or(Value::Bool(false))}))
    }

    fn release_view(relay: &Relay) -> Value {
        let release = relay.release();
        json!({
            "ok": true,
            "release": if release.is_empty() { Value::Null } else { Value::Object(release.clone()) },
            "minimums": relay.minimums(&release),
            "min_client": relay.settings.min_client,
            "history": relay.release_history_view(),
        })
    }

    fn push_view(relay: &Relay) -> Value {
        let p = &relay.settings.push;
        let (alert, voip) = relay.hub.push_device_counts();
        let (sent, failed) = push::apns::counts();
        json!({
            "ok": true, "enabled": p.enabled, "voip": p.voip, "environment": if p.sandbox { "sandbox" } else { "production" },
            "notify_previews": relay.settings.notify_previews, "devices": {"alert": alert, "voip": voip}, "sent24h": sent, "failed24h": failed,
        })
    }

    /// Calls and links: viewers get no principals or names (rooms and a per-person number only).
    fn calls(relay: &Relay, admin: bool) -> Value {
        let summary = relay.console.summary(relay);
        let links = relay.console.links_view(relay, "");
        if admin {
            return json!({"ok": true, "summary": summary, "links": links});
        }
        let mut numbers: HashMap<String, usize> = HashMap::new();
        let mut number = |p: &str| -> usize {
            let n = numbers.len() + 1;
            *numbers.entry(p.to_string()).or_insert(n)
        };
        let rooms: Vec<Value> = summary
            .get("rooms")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|r| {
                let people: Vec<Value> = r.get("participants").and_then(Value::as_array).into_iter().flatten().map(|p| json!({"person": number(&pj::py_str(p.get("principal").unwrap_or(&Value::Null))), "since": p.get("since"), "recording": p.get("recording")})).collect();
                json!({"room": r.get("room"), "participants": people})
            })
            .collect();
        let rows: Vec<Value> = links
            .get("rows")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|row| {
                let mut row = row.clone();
                let principal = pj::s(&row, "principal");
                row.remove("principal");
                row.remove("name");
                row.insert("person".into(), Value::from(number(&principal)));
                Value::Object(row)
            })
            .collect();
        let viewer_summary = json!({
            "relay": summary.get("relay"), "people_online": summary.get("people_online"), "devices_online": summary.get("devices_online"),
            "participants": summary.get("participants"), "rooms": rooms, "release": summary.get("release"),
        });
        json!({"ok": true, "summary": viewer_summary, "links": {"window_s": links.get("window_s"), "rows": rows}})
    }

    fn servers(relay: &Relay) -> Value {
        let headline = crate::meet_console::Console::signer_headline(relay);
        let files = if relay.console.has_power() {
            let f = relay.console.files();
            let uptime = pj::as_int(f.get("uptime_s")).unwrap_or(0);
            let since = if uptime > 0 { Value::from(((pj::now() as i64) - uptime) * 1000) } else { Value::Null };
            json!({"state": f.get("state").cloned().unwrap_or(Value::Null), "since": since})
        } else {
            Value::Null
        };
        // A relay with no certificate server (`signer_url` empty: the issuer's PC signs) has no signer to be unhealthy,
        // as its own Overview card says; null keeps the fleet console from calling it a problem.
        let signer = if pj::truthy(headline.get("configured")) { json!({"healthy": headline.get("healthy"), "days_left": headline.get("days_left")}) } else { Value::Null };
        json!({"ok": true, "signer": signer, "files": files})
    }

    // ── the writes ──

    fn org_set(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let b = call.body;
        let principal = m::principal(b.get("principal"));
        reason_of(b.get("reason")).map_err(invalid)?;
        let remove = b.get("remove") == Some(&Value::Bool(true));
        if !principal.contains('@') {
            return Err(invalid("name the person (their email)"));
        }
        let who = Self::who(relay, &call.caller.email)?;
        let orgs = relay.hub.admin_organizations("", &who).map_err(from_hub)?;
        let has_org = orgs.get("members").and_then(Value::as_array).map(|a| a.iter().any(|m| m.get("principal").and_then(Value::as_str) == Some(principal.as_str()))).unwrap_or(false);
        let single = if remove || has_org {
            false
        } else {
            let id = pj::str_or(b.get("id")).trim().to_string();
            let (on, admins) = Self::org_facts(relay, &who, &id)?;
            !on && admins == 0
        };
        let params = b.clone();
        if !single {
            return Ok(SectionAnswer::Second { target: principal, params, detail: json!({"remove": remove}) });
        }
        let answer = self.run("meet.org.set", &params, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target: principal, detail: json!({"remove": false, "path": "single"}) })
    }

    fn block(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let (principal, device, hours, reason) = parse_block(call.body).map_err(invalid)?;
        // 3.9: 5 blocks an hour per admin, counted by the core console
        if let Some(core) = self.core() {
            core.limit(Limit::Blocks, &call.caller.email, call.t)?;
        }
        let target = format!("{principal}/{device}");
        let params = json!({"principal": principal, "device": device, "hours": hours, "reason": reason});
        let single = self.blocks.lock().single_ok(&principal, &device, hours, relay.hub.is_admin(&principal), call.t);
        if !single {
            return Ok(SectionAnswer::Second { target, params, detail: json!({"hours": hours}) });
        }
        let answer = self.run("meet.block", &params, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target, detail: json!({"hours": hours, "path": "single"}) })
    }

    fn unblock(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let (principal, device, reason) = parse_unblock(call.body).map_err(invalid)?;
        let target = format!("{principal}/{device}");
        let placer = self.blocks.lock().get(&principal, &device, call.t).map(|b| b.placed_by.clone()).ok_or_else(|| not_found("block"))?;
        let params = json!({"principal": principal, "device": device, "reason": reason});
        if placer != call.caller.email {
            return Ok(SectionAnswer::Second { target, params, detail: json!({"placedBy": placer}) });
        }
        let answer = self.run("meet.unblock", &params, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target, detail: json!({"placedBy": placer}) })
    }

    fn bridge_set(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let b = call.body;
        let org = pj::str_or(b.get("org")).trim().to_string();
        if org.is_empty() {
            return Err(invalid("org is required"));
        }
        reason_of(b.get("reason")).map_err(invalid)?;
        let off = b.get("policy").and_then(|p| p.get("enabled")) == Some(&Value::Bool(false));
        if off {
            let answer = self.run("meet.bridge.set", b, &call.caller.email, true, call.t)?;
            return Ok(SectionAnswer::Done { answer, target: org, detail: json!({"enabled": false, "path": "single"}) });
        }
        if !writes_allowed(call.license) {
            return Err(license_needed());
        }
        Ok(SectionAnswer::Second { target: org, params: b.clone(), detail: json!({}) })
    }

    fn hold_items(body: &Value) -> Result<(String, Vec<String>), ApiError> {
        let on = pj::str_or(body.get("on"));
        let field = match on.as_str() {
            "people" => "principals",
            "conversations" => "cids",
            _ => return Err(invalid("on must be people or conversations")),
        };
        let items: Vec<String> = body.get(field).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_lowercase()).collect()).unwrap_or_default();
        Ok((on, items))
    }

    fn holds_place(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let (on, items) = Self::hold_items(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        // the per-principal rule applies to the requester before anything waits (3.7)
        if on == "people" && !relay.hub.pc_may_hold_people(&call.caller.email, &items) {
            return Err(ApiError::with("role", "Only an admin of these people's organization (org_admins) can hold them."));
        }
        let detail = json!({"on": on, "items": items.len()});
        if items.len() > HOLD_SINGLE_MAX {
            return Ok(SectionAnswer::Second { target: "-".into(), params: call.body.clone(), detail });
        }
        let answer = self.run("meet.holds.place", call.body, &call.caller.email, true, call.t)?;
        let target = pj::py_str(answer.get("id").unwrap_or(&Value::Null));
        Ok(SectionAnswer::Done { answer, target, detail })
    }

    fn holds_release(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let id = pj::str_or(call.body.get("id"));
        reason_of(call.body.get("reason")).map_err(invalid)?;
        let who = Self::who(relay, &call.caller.email)?;
        let list = relay.hub.pc_holds_list("", &who).map_err(from_hub)?;
        let hold = list.get("holds").and_then(Value::as_array).and_then(|a| a.iter().find(|h| h.get("id").and_then(Value::as_str) == Some(id.as_str()))).cloned().ok_or_else(|| not_found("hold"))?;
        let placed_ms = pj::as_num(hold.get("placed")).map(|s| (s * 1000.0) as i64).unwrap_or(0);
        let mine = hold.get("by").and_then(Value::as_str) == Some(call.caller.email.as_str());
        let single = mine && self.blocks.lock().hold_path(&id) == "single" && call.t - placed_ms <= HOLD_RELEASE_MS;
        if !single {
            return Ok(SectionAnswer::Second { target: id, params: call.body.clone(), detail: json!({}) });
        }
        let answer = self.run("meet.holds.release", call.body, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target: id, detail: json!({"path": "single"}) })
    }

    fn release_set(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        reason_of(call.body.get("reason")).map_err(invalid)?;
        let body = call.body.as_object().cloned().unwrap_or_default();
        let manifest = relay.release_preview(&body).map_err(from_hub)?;
        let version = pj::s(&manifest, "version");
        let detail = json!({"minimum": manifest.get("minimum").cloned().unwrap_or(Value::Null), "in_force": relay.minimums(&relay.release())});
        if !relay.release_single_admin(&manifest) {
            return Ok(SectionAnswer::Second { target: version, params: call.body.clone(), detail });
        }
        let answer = self.run("meet.release.set", call.body, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target: version, detail })
    }

    /// TH-1 6: the relay's state folder, where its guest and web ports read the brand.
    fn brand_dir(relay: &Relay) -> Result<PathBuf, ApiError> {
        let dir = relay.settings.state_dir.trim();
        if dir.is_empty() {
            return Err(invalid("This relay has no state folder (state_dir in relay.json), so it keeps no brand."));
        }
        Ok(PathBuf::from(dir))
    }

    /// `GET meet/brand`: the stored document (with `by` and `updated`) or null, and the public read the pages get.
    fn brand_view(relay: &Relay) -> Result<Value, ApiError> {
        let brand = crate::meet_brand::load(&Self::brand_dir(relay)?, &crate::meet_brand::RELAY_FILES);
        let public = crate::meet_brand::public(brand.as_ref(), "/g/");
        Ok(json!({"ok": true, "brand": brand.as_ref().map(crate::meet_brand::to_value), "public": public["brand"]}))
    }

    /// `POST meet/brand`, `meet/brand/logo`, `meet/brand/reset`: on one admin's word, audited with what changed.
    fn brand_write(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let action = call.spec.action;
        if action != "meet.brand.logo" {
            reason_of(call.body.get("reason")).map_err(invalid)?;
        }
        let answer = self.run(action, call.body, &call.caller.email, true, call.t)?;
        let detail = match answer.get("brand").filter(|b| !b.is_null()) {
            Some(b) => json!({"name": b.get("name"), "accent": b.get("accent"), "mode": b.get("mode"), "logo": b.get("logo").and_then(|l| l.get("sha256")).cloned().unwrap_or(Value::Null)}),
            None => json!({"reset": true}),
        };
        Ok(SectionAnswer::Done { answer, target: "-".into(), detail })
    }

    /// The relay actions `meet.brand.set` (and its logo) and `meet.brand.reset`: the files the guest and web ports
    /// serve, then a new MR-1 generation so the standby takes them.
    fn brand_run(relay: &Relay, action: &str, p: &Obj, by: &str, t: i64) -> Result<Value, ApiError> {
        use crate::meet_brand::{self as mb, RELAY_FILES};
        let dir = Self::brand_dir(relay)?;
        let current = mb::load(&dir, &RELAY_FILES);
        let failed = |e: String| {
            crate::meet::log_error(&format!("console.meet-brand why={}", m::kv(&e)));
            ApiError::of("write-failed")
        };
        let saved = match action {
            "meet.brand.reset" => {
                mb::remove(&dir, &RELAY_FILES).map_err(failed)?;
                None
            }
            "meet.brand.set" => {
                let b = mb::with_fields(current.as_ref(), p, by, t).map_err(invalid)?;
                mb::save(&dir, &RELAY_FILES, &b, None).map_err(failed)?;
                Some(b)
            }
            _ => {
                let (b, bytes) = mb::with_logo(current.as_ref(), p, by, t).map_err(invalid)?;
                mb::save(&dir, &RELAY_FILES, &b, bytes.as_deref()).map_err(failed)?;
                Some(b)
            }
        };
        if let Some(c) = relay.hub.cluster() {
            c.note_saved();
        }
        Ok(json!({"ok": true, "brand": saved.as_ref().map(mb::to_value)}))
    }

    fn files_start(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        // 3.9: 6 an hour for the console, counted by the core console
        if let Some(core) = self.core() {
            core.limit(Limit::FilesStart, "console", call.t)?;
        }
        let answer = self.run("meet.files.start", call.body, &call.caller.email, true, call.t)?;
        Ok(SectionAnswer::Done { answer, target: "-".into(), detail: json!({}) })
    }

    /// `meet.seats.request` (2.4 "Request more seats"): mails the publisher `mail.seats-request` at Settings,
    /// License, "Seat requests go to", and answers the same text to copy.
    fn seats_request(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let gate = Self::gate(relay)?;
        let Some((license, _)) = gate.license() else { return Err(license_needed()) };
        let wanted = call.body.get("wanted").and_then(Value::as_i64).filter(|w| *w > license.users && *w <= 10_000).ok_or_else(|| invalid(format!("wanted is more than {} and at most 10,000.", license.users)))?;
        let core = self.core();
        if let Some(c) = &core {
            c.limit(Limit::SeatRequests, &call.caller.email, call.t)?;
        }
        let (seated, _) = gate.seat_counts();
        let host = crate::meet_console_port::host_of(&relay.settings.console_public);
        let time = pj::iso_utc(call.t.div_euclid(1000));
        let email = call.caller.email.clone();
        let text = format!(
            "Organization: {}\nLicense ID: {}\nProduct: Meeting Hub\nSeats in the license: {}\nSeats in use: {seated}\nSeats wanted: {wanted}\nAdmin: {email} {email}\nRelay: {host}\nSent from the Lucid Admin Console on {time}.",
            license.org, license.id, license.users
        );
        let to = core.as_ref().and_then(|c| c.license_request_to());
        let mailed = match &to {
            Some(addr) => {
                let args = [("org", license.org.clone()), ("license id", license.id.clone()), ("users", license.users.to_string()), ("seated", seated.to_string()), ("wanted", wanted.to_string()), ("name", email.clone()), ("email", email.clone()), ("time", time.clone())];
                crate::console_mail::send("mail.seats-request", addr, &args);
                true
            }
            None => false,
        };
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "mailed": mailed, "to": to, "text": text}), target: "-".into(), detail: json!({"wanted": wanted, "mailed": mailed}) })
    }

    /// Run one action as `principal` (the requester, for an approval: 3.7 M10). `single`: on one admin's word.
    fn run(&self, action: &str, params: &Value, principal: &str, single: bool, t: i64) -> Result<Value, ApiError> {
        let relay = self.relay()?;
        let who = Self::who(&relay, principal)?;
        let p = params.as_object().cloned().unwrap_or_default();
        match action {
            "meet.org.set" => {
                let remove = p.get("remove").filter(|v| v.as_bool() == Some(true));
                relay.hub.admin_set_organization("", &who, p.get("principal"), p.get("id"), p.get("label"), remove).map_err(from_hub)?;
                Ok(json!({"ok": true}))
            }
            "meet.crl" => match relay.push_crl("", &who, p.get("crl_pem")) {
                Ok(_) => Ok(json!({"ok": true})),
                Err(E::Bad(why)) => Err(ApiError::with("crl-refused", format!("This revocation list cannot be used: {}.", why.trim_end_matches('.')))),
                Err(e) => Err(from_hub(e)),
            },
            "meet.block" => {
                let (principal, device, hours, reason) = parse_block(params).map_err(|w| stale(&w))?;
                let placed = self.blocks.lock().place(&principal, &device, hours, &reason, &who.principal, single, t)?;
                relay.hub.set_blocks(self.blocks.lock().mirror(t));
                // a block closes the device's sessions; it never revokes, never completes meet.revoke, never latches
                let dropped = relay.hub.drop_device(&principal, &device);
                crate::meet::log_warn(&format!("device.block category=security principal={principal} device={} until={} by={} dropped={dropped}", m::kv(&device), placed.until, who.principal));
                Ok(json!({"ok": true, "blocked": placed.view()}))
            }
            "meet.unblock" => {
                let (principal, device, _) = parse_unblock(params).map_err(|w| stale(&w))?;
                let gone = self.blocks.lock().lift(&principal, &device, t)?;
                relay.hub.set_blocks(self.blocks.lock().mirror(t));
                crate::meet::log_info(&format!("device.unblock category=security principal={principal} device={} by={} placed_by={}", m::kv(&device), who.principal, gone.placed_by));
                Ok(json!({"ok": true}))
            }
            "meet.bridge.set" => {
                relay.hub.bridge_admin_set("", &who, p.get("org"), p.get("policy")).map_err(from_hub)?;
                Ok(json!({"ok": true}))
            }
            "meet.holds.place" => {
                let out = relay.hub.pc_holds_place("", &who, p.get("on"), p.get("principals"), p.get("cids"), p.get("reason")).map_err(from_hub)?;
                let id = pj::s(&out, "id");
                self.blocks.lock().set_hold_path(&id, single);
                Ok(json!({"ok": true, "id": id}))
            }
            "meet.holds.release" => {
                relay.hub.pc_holds_release("", &who, p.get("id"), p.get("reason")).map_err(from_hub)?;
                Ok(json!({"ok": true}))
            }
            "meet.release.set" => {
                let mut body = p.clone();
                body.remove("reason");
                relay.set_release("", &who, &body).map_err(from_hub)?;
                Ok(json!({"ok": true}))
            }
            "meet.brand.set" | "meet.brand.logo" | "meet.brand.reset" => Self::brand_run(&relay, action, &p, &who.principal, t),
            "meet.clock.confirm" => {
                // approved (or sole-admin path): the browser time of the request, checked again now
                let browser = p.get("browserTime").and_then(Value::as_i64).ok_or_else(|| invalid("browserTime is a time in milliseconds."))?;
                let done = Self::gate(&relay)?.confirm_clock(browser).map_err(clock_refusal)?;
                Ok(json!({"ok": true, "old": done.old, "new": done.new, "credited": done.credited}))
            }
            "meet.ai.save" => Self::ai_save_run(&relay, &p, &who.principal, t),
            "meet.ai.approve" => Self::ai_approve_run(&relay, &p, &who.principal),
            "meet.files.start" => {
                relay.console.start_files_now().map_err(|why| stale(&why))?;
                let f = relay.console.files();
                Ok(json!({"ok": true, "files": {"state": f.get("state").cloned().unwrap_or(Value::Null)}}))
            }
            _ => Err(not_found("action")),
        }
    }

    fn core(&self) -> Option<Arc<Console>> {
        self.relay.upgrade().and_then(|r| r.admin_console.get().cloned())
    }

    /// The `meet.*` request target checks (3.8): `meet.approve {kind, id, csr_sha256, decision}`, `meet.revoke
    /// {principal, device}`, `meet.invite {name, email, days}`.
    pub fn check_target(kind: &str, target: &Value) -> Result<Value, ApiError> {
        let o = target.as_object().ok_or_else(|| invalid("The target is an object."))?;
        let only = |keys: &[&str]| -> Result<(), ApiError> {
            match o.keys().find(|k| !keys.contains(&k.as_str())) {
                Some(k) => Err(ApiError::with("unknown-field", format!("Unknown field: {}.", clean(k)))),
                None => Ok(()),
            }
        };
        match kind {
            "meet.approve" => {
                only(&["kind", "id", "csr_sha256", "decision"])?;
                let k = pj::str_or(o.get("kind"));
                if !["enroll", "seed", "renew"].contains(&k.as_str()) {
                    return Err(invalid("kind is enroll, seed or renew."));
                }
                let id = clean(&pj::str_or(o.get("id")));
                if id.is_empty() || id.chars().count() > 128 {
                    return Err(invalid("id is required."));
                }
                let csr = pj::str_or(o.get("csr_sha256")).to_lowercase();
                if csr.len() != 64 || !csr.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return Err(invalid("csr_sha256 must be 64 hex digits."));
                }
                let decision = pj::str_or(o.get("decision"));
                if decision != "approve" && decision != "refuse" {
                    return Err(invalid("decision is approve or refuse."));
                }
                Ok(json!({"kind": k, "id": id, "csr_sha256": csr, "decision": decision}))
            }
            "meet.revoke" => {
                only(&["principal", "device"])?;
                let principal = m::principal(o.get("principal"));
                let device = clean(&pj::str_or(o.get("device")));
                if !principal.contains('@') || device.is_empty() {
                    return Err(invalid("name the person (their email) and the device"));
                }
                Ok(json!({"principal": principal, "device": device}))
            }
            "meet.invite" => {
                only(&["name", "email", "days"])?;
                let name = clean(&pj::str_or(o.get("name")));
                let email = m::principal(o.get("email"));
                let days = o.get("days").and_then(Value::as_i64).filter(|d| (1..=30).contains(d)).ok_or_else(|| invalid("days is 1 to 30."))?;
                if name.is_empty() || name.chars().count() > 80 || !email.contains('@') {
                    return Err(invalid("name and email are required."));
                }
                Ok(json!({"name": name, "email": email, "days": days}))
            }
            _ => Err(invalid(format!("Unknown request kind: {}.", clean(kind)))),
        }
    }
}

impl ProductSection for MeetSection {
    fn routes(&self) -> &'static [RouteSpec] {
        &ROUTES
    }

    fn sections(&self, license: LicenseState) -> Vec<&'static str> {
        if license == LicenseState::None {
            LOCKED_PAGES.to_vec()
        } else {
            PAGES.to_vec()
        }
    }

    fn relay_info(&self, t: i64) -> Value {
        let Ok(relay) = self.relay() else { return Value::Null };
        let tls = crate::meet_x509::Cert::from_pem(&String::from_utf8_lossy(&std::fs::read(&relay.settings.console_cert).unwrap_or_default())).map(|c| c.not_after);
        json!({
            "host": crate::meet_console_port::host_of(&relay.settings.console_public), "version": m::SERVER_VERSION,
            "uptimeSeconds": (t - self.started).max(0) / 1000, "fips": cfg!(feature = "fips"), "tlsNotAfter": tls,
        })
    }

    /// The license view with the service state (R42-1, R42-3), judged in trusted time.
    fn license(&self, t: i64) -> LicenseView {
        let none = |problem: String, service: ServiceView| LicenseView { license: Value::Null, problem: Some(problem), state: LicenseState::None, service };
        let Ok(relay) = self.relay() else { return none(NO_LICENSE.into(), ServiceView::none(t)) };
        let Ok(gate) = Self::gate(&relay) else { return none(NO_LICENSE.into(), ServiceView::none(t)) };
        let service = gate.service_view();
        match gate.license() {
            Some((l, dev)) => LicenseView { license: self.license_object(&relay, &l, dev), problem: None, state: Self::license_now(&relay), service },
            None => none(Some(gate.problem()).filter(|p| !p.is_empty()).unwrap_or_else(|| NO_LICENSE.into()), service),
        }
    }

    fn overview_cards(&self, admin: bool, _t: i64) -> Vec<Value> {
        let Ok(relay) = self.relay() else { return Vec::new() };
        let summary = relay.console.summary(&relay);
        let headline = crate::meet_console::Console::signer_headline(&relay);
        let (used, users) = Self::gate(&relay).map(|g| g.seat_counts()).unwrap_or((0, 0));
        let warn = |bad: bool| if bad { "warn" } else { "ok" };
        let mut cards = vec![json!({"id": "health", "state": "ok", "n": summary.get("people_online"), "m": summary.get("participants")})];
        if admin {
            cards.push(json!({"id": "people", "state": warn(users > 0 && used * 10 >= users * 9), "n": used, "m": users}));
            let configured = pj::truthy(headline.get("configured"));
            cards.push(json!({"id": "signer", "state": if !configured || pj::truthy(headline.get("healthy")) { "ok" } else { "bad" }, "n": headline.get("days_left"), "m": Value::Null}));
            let (sent, failed) = push::apns::counts();
            cards.push(json!({"id": "push", "state": warn(failed.values().sum::<u64>() > 0), "n": sent, "m": failed.values().sum::<u64>()}));
        }
        let release = relay.release();
        cards.push(json!({"id": "release", "state": "ok", "n": pj::s(&release, "version"), "m": relay.minimums(&release).get("hub").cloned().unwrap_or(Value::Null)}));
        cards
    }

    fn attention(&self, admin: bool, t: i64) -> Vec<Value> {
        let Ok(relay) = self.relay() else { return Vec::new() };
        let item = |kind: &str, severity: &str, args: Value, go: &str| json!({"kind": kind, "severity": severity, "args": args, "go": go});
        let mut out = relay.deploy_attention();
        let headline = crate::meet_console::Console::signer_headline(&relay);
        if pj::truthy(headline.get("configured")) && !pj::truthy(headline.get("healthy")) {
            out.push(item("signer-unhealthy", "bad", json!({}), "#/meet/signer"));
        }
        if let Some(cert) = crate::meet_x509::Cert::from_pem(&String::from_utf8_lossy(&std::fs::read(&relay.settings.console_cert).unwrap_or_default())) {
            let days = (cert.not_after - t.div_euclid(1000)).div_euclid(86_400);
            if days <= 21 {
                out.push(item("tls-expiring", if days <= 7 { "bad" } else { "warn" }, json!({"n": days.max(0)}), "#/overview"));
            }
        }
        if !admin {
            return out;
        }
        if let Some(n) = pj::as_int(headline.get("days_left")).filter(|d| *d <= 30) {
            out.push(item("signer-expiring", "warn", json!({"n": n.max(0)}), "#/meet/signer"));
        }
        // 2.4: the license gate, the upgrade period, trusted time and seats (with their banners)
        if let Ok(gate) = Self::gate(&relay) {
            out.extend(gate.attention());
        }
        if let Some(who) = relay.settings.admins.first().and_then(|p| relay.hub.check_console_admin(p).ok()) {
            let waiting = relay.hub.admin_pending("", &who).ok().and_then(|p| p.get("items").and_then(Value::as_array).map(Vec::len)).unwrap_or(0);
            if waiting > 0 {
                out.push(item("enrollments-waiting", "info", json!({"n": waiting}), "#/meet/enrollments"));
            }
        }
        let blocks = self.blocks.lock().active(t);
        if blocks > 0 {
            out.push(item("blocks-active", "info", json!({"n": blocks}), "#/meet/people"));
        }
        // SE-1: support tickets from people's Meeting Hubs waiting for an answer
        let tickets = crate::meet_support::waiting(&relay);
        if tickets > 0 {
            out.push(item("support-waiting", "warn", json!({"n": tickets}), "#/meet/support"));
        }
        out
    }

    fn search(&self, q: &str, admin: bool, _t: i64) -> Vec<Value> {
        if !admin {
            return Vec::new();
        }
        let Ok(relay) = self.relay() else { return Vec::new() };
        let q = q.to_lowercase();
        let directory = relay.hub.st.lock().directory.clone();
        directory
            .iter()
            .filter_map(|(p, e)| {
                let name = e.get("name").and_then(Value::as_str).unwrap_or_default();
                (p.contains(&q) || name.to_lowercase().contains(&q)).then(|| json!({"kind": "person", "id": p, "title": name, "detail": p, "go": format!("#/meet/people?q={p}")}))
            })
            .take(SEARCH_MAX)
            .collect()
    }

    fn security_actions(&self) -> &'static [&'static str] {
        &SECURITY_ACTIONS
    }

    fn route(&self, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let relay = self.relay()?;
        let read = |v: Result<Value, ApiError>| v.map(SectionAnswer::Read);
        if call.spec.method == "POST" {
            cluster_write_guard(&relay, call.spec.path)?;
        }
        // Seats and the relay's time are always allowed (2.4)
        // ...and so is the brand (TH-1: back to the standard theme works in every state)
        let always = matches!(call.spec.path, "meet/identity" | "meet/seats" | "meet/clock" | "meet/counts" | "meet/support" | "meet/cluster/status" | "meet/cluster/directory" | "meet/brand");
        if call.spec.method == "GET" && call.license == LicenseState::None && !always {
            return Err(license_needed());
        }
        match (call.spec.method, call.spec.path) {
            ("GET", "meet/counts") => {
                filters(call.query, &[])?;
                read(Ok(self.counts(&relay, call.t)))
            }
            ("GET", "meet/seats") => {
                filters(call.query, &[])?;
                let gate = Self::gate(&relay)?;
                let directory = relay.hub.st.lock().directory.clone();
                let names = |p: &str| directory.get(p).and_then(|e| e.get("name")).and_then(Value::as_str).unwrap_or_default().to_string();
                let to = self.core().and_then(|c| c.license_request_to());
                read(Ok(gate.seats_view(&names, to)))
            }
            ("GET", "meet/clock") => {
                filters(call.query, &[])?;
                read(Ok(Self::gate(&relay)?.clock_view()))
            }
            ("POST", "meet/seats/pick") => {
                let principal = call.body.get("principal").and_then(Value::as_str).map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).ok_or_else(|| invalid("principal is required."))?;
                let pick = call.body.get("pick").and_then(Value::as_bool).ok_or_else(|| invalid("pick is true or false."))?;
                if let Some(c) = self.core() {
                    c.limit(Limit::SeatPicks, &call.caller.email, call.t)?;
                }
                Self::gate(&relay)?.pick(&principal, &call.caller.email, pick).map_err(|(code, words)| if words.is_empty() { ApiError::of(code) } else { ApiError::with(code, words) })?;
                Ok(SectionAnswer::Done { answer: json!({"ok": true}), target: principal, detail: json!({"pick": pick}) })
            }
            ("POST", "meet/seats/request") => self.seats_request(&relay, call),
            ("GET", "meet/cluster/status") => {
                filters(call.query, &[])?;
                read(Ok(relay.hub.cluster().map_or_else(|| json!({"ok": true, "cluster": null}), |c| c.status())))
            }
            ("GET", "meet/cluster/directory") => {
                filters(call.query, &[])?;
                let dir = &relay.settings.state_dir;
                read(Ok(if dir.is_empty() { json!({"ok": true, "directory": null}) } else { crate::meet_relays::get(Path::new(dir)) }))
            }
            ("POST", "meet/cluster/promote" | "meet/cluster/demote" | "meet/cluster/handover") => {
                let c = relay.hub.cluster().cloned().ok_or_else(|| invalid("This relay is not in a cluster."))?;
                let force = match call.body.get("force") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(b)) => *b,
                    Some(_) => return Err(invalid("force is true or false.")),
                };
                let cmd = call.spec.path.trim_start_matches("meet/cluster/");
                let answer = c.command_and_restart(cmd, force).map_err(|w| stale(&w))?;
                let detail = json!({"force": force, "role": answer.get("role"), "epoch": answer.get("epoch")});
                Ok(SectionAnswer::Done { answer: Value::Object(answer), target: "-".into(), detail })
            }
            ("POST", "meet/clock/confirm") => {
                let browser = call.body.get("browserTime").and_then(Value::as_i64).ok_or_else(|| invalid("browserTime is a time in milliseconds."))?;
                let gate = Self::gate(&relay)?;
                // a second admin (with two-person on) when the confirmed time is behind the high-water mark
                if gate.time.confirm_goes_back() {
                    return Ok(SectionAnswer::Second { target: "-".into(), params: call.body.clone(), detail: json!({"back": true}) });
                }
                let done = gate.confirm_clock(browser).map_err(clock_refusal)?;
                Ok(SectionAnswer::Done { answer: json!({"ok": true}), target: "-".into(), detail: json!({"old": done.old, "new": done.new, "credited": done.credited}) })
            }
            ("GET", "meet/support") => {
                let f = filters(call.query, &["state"])?;
                read(crate::meet_support::console_list(&relay, f.get("state").map(String::as_str).unwrap_or_default()))
            }
            ("POST", "meet/support/answer") => crate::meet_support::console_answer(&relay, call),
            ("POST", "meet/support/close") => crate::meet_support::console_close(&relay, call),
            ("GET", "meet/people") => read(self.people(&relay, call)),
            ("GET", "meet/enrollments") => read(self.enrollments(&relay, call, self.core().as_deref())),
            ("GET", "meet/organizations") => read(self.organizations(&relay, call)),
            ("GET", "meet/signer") => read(self.signer(&relay, call)),
            ("GET", "meet/bridge") => {
                filters(call.query, &[])?;
                let who = Self::who(&relay, &call.caller.email)?;
                let b = relay.hub.bridge_admin("", &who).map_err(from_hub)?;
                read(Ok(json!({"ok": true, "policies": b.get("policies").cloned().unwrap_or(json!({}))})))
            }
            ("GET", "meet/bridge/audit") => {
                let f = filters(call.query, &["after", "limit"])?;
                let who = Self::who(&relay, &call.caller.email)?;
                let mut rows = relay.hub.bridge_audit("", &who, f.get("after").map(String::as_str).unwrap_or(""), f.get("limit").map(String::as_str).unwrap_or("")).map_err(from_hub)?;
                rows.insert("ok".into(), Value::Bool(true));
                read(Ok(Value::Object(rows)))
            }
            ("GET", "meet/holds") => read(self.holds(&relay, call)),
            ("GET", "meet/release") => {
                filters(call.query, &[])?;
                read(Ok(Self::release_view(&relay)))
            }
            ("GET", "meet/push") => {
                filters(call.query, &[])?;
                read(Ok(Self::push_view(&relay)))
            }
            ("GET", "meet/identity") => {
                filters(call.query, &[])?;
                read(Ok(crate::meet_console_identity::view()))
            }
            ("GET", "meet/calls") => {
                filters(call.query, &[])?;
                read(Ok(Self::calls(&relay, call.caller.admin)))
            }
            ("GET", "meet/servers") => {
                filters(call.query, &[])?;
                read(Ok(Self::servers(&relay)))
            }
            ("POST", "meet/organizations") => self.org_set(&relay, call),
            ("POST", "meet/crl") => {
                let answer = self.run("meet.crl", call.body, &call.caller.email, true, call.t)?;
                let sha = crate::codec::sha256_hex(pj::str_or(call.body.get("crl_pem")).as_bytes());
                Ok(SectionAnswer::Done { answer, target: "-".into(), detail: json!({"sha256": sha}) })
            }
            ("POST", "meet/block") => self.block(&relay, call),
            ("POST", "meet/unblock") => self.unblock(call),
            ("POST", "meet/bridge") => self.bridge_set(call),
            ("POST", "meet/holds") => self.holds_place(&relay, call),
            ("POST", "meet/holds/release") => self.holds_release(&relay, call),
            ("POST", "meet/release") => self.release_set(&relay, call),
            ("GET", "meet/brand") => {
                filters(call.query, &[])?;
                read(Self::brand_view(&relay))
            }
            ("POST", "meet/brand" | "meet/brand/logo" | "meet/brand/reset") => self.brand_write(call),
            ("POST", "meet/files/start") => self.files_start(call),
            ("GET", "meet/ai") => read(self.ai_view(&relay, call)),
            ("GET", "meet/ai/cards") => read(self.ai_cards(&relay, call)),
            ("GET", "meet/ai/usage") => read(self.ai_usage(&relay, call)),
            ("GET", "meet/ai/archive") => read(self.ai_archive(&relay, call)),
            ("POST", "meet/ai/stage") => self.ai_stage(&relay, call),
            ("POST", "meet/ai/save") => self.ai_save(&relay, call),
            ("POST", "meet/ai/gateways") => self.ai_gateway_set(&relay, call),
            ("POST", "meet/ai/cards/bench") => self.ai_bench(&relay, call),
            ("POST", "meet/ai/cards/approve") => self.ai_approve(&relay, call),
            ("POST", "meet/ai/hold") => self.ai_hold(&relay, call),
            ("POST", "meet/ai/archive") => self.ai_archive_set(&relay, call),
            ("POST", "meet/ai/archive/copy") => self.ai_archive_copy(&relay, call),
            ("POST", "meet/ai/archive/code") => self.ai_archive_code(&relay, call),
            ("POST", "meet/ai/archive/code/confirm") => self.ai_archive_code_confirm(&relay, call),
            ("GET", "meet/ai/mcp") => read(self.ai_mcp_view(&relay, call)),
            ("POST", "meet/ai/mcp/servers") => self.ai_mcp_add(&relay, call),
            ("POST", "meet/ai/mcp/servers/update") => self.ai_mcp_update(&relay, call),
            ("POST", "meet/ai/mcp/servers/off") => self.ai_mcp_server_off(&relay, call),
            ("POST", "meet/ai/mcp/off") => self.ai_mcp_off(&relay, call),
            ("POST", "meet/ai/mcp/credential") => self.ai_mcp_credential(&relay, call),
            ("POST", "meet/ai/mcp/test") => self.ai_mcp_test(&relay, call),
            _ => Err(not_found("page")),
        }
    }

    fn execute(&self, run: &Approved) -> Result<Value, ApiError> {
        cluster_write_guard(&*self.relay()?, run.action)?;
        // the sole-admin path is still one admin's word (it counts toward the 24 hours of blocks and the holds rule)
        let single = run.approved_by.is_none();
        // r6 8.1, 13: a save carrying a new MCP attestation runs only as the two admins it names
        if run.action == "meet.ai.save" {
            self.ai_mcp_save_check(run)?;
        }
        self.run(run.action, run.params, run.requested_by, single, run.t)
    }

    fn may_approve(&self, action: &str, params: &Value, approver: &str) -> bool {
        let Some(relay) = self.relay.upgrade() else { return false };
        if !relay.hub.is_admin(approver) {
            return false;
        }
        if action == "meet.ai.save" && !Self::ai_mcp_may_approve(&relay, params, approver) {
            return false;
        }
        if action == "meet.holds.place" {
            if let Ok((on, items)) = Self::hold_items(params) {
                if on == "people" {
                    return relay.hub.pc_may_hold_people(approver, &items);
                }
            }
        }
        true
    }

    fn license_candidate(&self, token: &str, _t: i64) -> Result<LicenseCandidate, ApiError> {
        let relay = self.relay()?;
        let gate = Self::gate(&relay)?;
        let (offered, dev) = Self::verify(&relay, token)?;
        Self::license_target(&relay)?;
        let state = license_standing(Some(&offered), gate.time.now().div_euclid(1000)).state;
        let reference = Self::reference(&gate);
        let view = self.license_object(&relay, &offered, dev);
        Ok(LicenseCandidate { offered: LicenseRecord::of(&offered), valid: state == Some(LicenseStateName::Valid), ended: state == Some(LicenseStateName::Expired), reference, view })
    }

    fn license_install(&self, token: &str, _t: i64) -> Result<Value, ApiError> {
        let relay = self.relay()?;
        let gate = Self::gate(&relay)?;
        let (offered, dev) = Self::verify(&relay, token)?;
        if license_standing(Some(&offered), gate.time.now().div_euclid(1000)).state == Some(LicenseStateName::Expired) {
            return Err(ApiError::of("license-ended"));
        }
        let file = Self::license_target(&relay)?;
        write_private(&file, format!("{}\n", license_token_of(token)).as_bytes()).map_err(|e| {
            crate::meet::log_error(&format!("license cannot be written: {e}"));
            ApiError::of("write-failed")
        })?;
        // the view before the install says whether the upgrade period stays as a fallback (8.2, R3-M4)
        let view = self.license_object(&relay, &offered, dev);
        // effective at once: service, seats (reseat with more `users`, the clock with fewer) and the period's end
        gate.installed();
        Ok(view)
    }

    fn request_target(&self, kind: &str, target: &Value) -> Result<Value, ApiError> {
        Self::check_target(kind, target)
    }

    fn admin_rule(&self, email: &str, anchor: &str) -> AdminRule {
        let Some(relay) = self.relay.upgrade() else { return AdminRule::NotRelayAdmin };
        if !relay.hub.is_admin(email) {
            return AdminRule::NotRelayAdmin;
        }
        // the break-glass account (anchor "operator"): admin rights without a device anchor (3.3)
        if anchor.is_empty() || anchor == "operator" {
            return AdminRule::Admin;
        }
        // decision 14: the admin role only through a passkey anchored to one of that principal's own devices
        if relay.hub.device_serials(email).contains(&m::serial(anchor)) {
            AdminRule::Admin
        } else {
            AdminRule::ViewerOnly
        }
    }

    fn relay_lines(&self, f: &Filter) -> Option<Vec<String>> {
        let relay = self.relay.upgrade()?;
        if f.cat.as_deref().is_some_and(|c| c != "relay") {
            return Some(Vec::new());
        }
        Some(relay.console.ring.json_lines(f.min as i64))
    }

    /// A promotion to admin, an unsuspension, a removal or a role change: protected people reseat at once (R3-M6).
    fn people_changed(&self, _t: i64) {
        if let Some(gate) = self.relay.upgrade().and_then(|r| r.hub.gate()) {
            gate.check(true);
        }
    }

    /// The console's minute: the MCP journal resent to every gateway that has not acknowledged it (r6 8.2).
    fn tick(&self, _t: i64) {
        self.ai_mcp_tick();
    }
}

// ── Settings > AI (contract AI-1 section 9; the rules are console_ai.rs) ────────────────────────────────────────

/// The console's AI record per org (owner-only): `{v, orgs: {<org>: {gateways: [map entries], archive: {url, spki}
/// or null, code_gen}}}`. Staged changes, saves in flight, reviewer asks and a new recovery code live in memory only.
pub const AI_FILE: &str = "console-ai.json";
const AI_TIMEOUT: f64 = 20.0;
const AI_RESULTS_MAX: usize = 50;
/// Pages of 1000 device audit records the usage panel reads at most (30 days).
const AI_AUDIT_PAGES: usize = 20;
const AI_SIGN_KIND: &str = "meet.ai.sign";
pub(crate) const AI_REVIEWER_KIND: &str = "meet.ai.reviewer-sign";

struct AiSave {
    staged: ai::Staged,
    principal: String,
    step: ai::SignStep,
    request: String,
}

struct ReviewerAsk {
    request: String,
    org: String,
    op: &'static str,
    body: Value,
    /// The admin who asked (the relay hold runs as them).
    by: String,
}

#[derive(Default)]
pub struct AiState {
    loaded: bool,
    book: Obj,
    stages: ai::Stages,
    saves: Vec<AiSave>,
    asks: Vec<ReviewerAsk>,
    codes: Vec<ai::PendingCode>,
    results: Vec<Value>,
}

static AI_STATES: std::sync::LazyLock<Mutex<HashMap<String, Arc<Mutex<AiState>>>>> = std::sync::LazyLock::new(Default::default);

/// The AI state of the relay's state folder (shared by its console section and the main port's sign route).
fn ai_state(relay: &Relay) -> Arc<Mutex<AiState>> {
    AI_STATES.lock().entry(relay.settings.state_dir.clone()).or_default().clone()
}

impl AiState {
    fn org(&mut self, relay: &Relay, org: &str) -> Obj {
        if !self.loaded {
            self.loaded = true;
            if let Some(text) = m::state_file(&relay.settings, AI_FILE).and_then(|p| read_text(&p)) {
                if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text) {
                    self.book = o;
                }
            }
        }
        self.book.get("orgs").and_then(|o| o.get(org)).and_then(Value::as_object).cloned().unwrap_or_default()
    }

    fn set_org(&mut self, relay: &Relay, org: &str, entry: Obj) -> Result<(), ApiError> {
        self.org(relay, org);
        let mut orgs = self.book.get("orgs").and_then(Value::as_object).cloned().unwrap_or_default();
        orgs.insert(org.into(), Value::Object(entry));
        let next = obj([("v", Value::from(1)), ("orgs", Value::Object(orgs))]);
        let path = m::state_file(&relay.settings, AI_FILE).ok_or_else(|| ApiError::of("write-failed"))?;
        write_private(&path, format!("{}\n", Value::Object(next.clone())).as_bytes()).map_err(|e| {
            crate::meet::log_error(&format!("console-ai.json cannot be written: {e}"));
            ApiError::of("write-failed")
        })?;
        self.book = next;
        Ok(())
    }

    fn result(&mut self, v: Value) {
        self.results.push(v);
        if self.results.len() > AI_RESULTS_MAX {
            self.results.remove(0);
        }
    }
}

/// The org's current signed policy (unsigned body), or null.
pub(crate) fn ai_policy(relay: &Relay, org: &str) -> Value {
    relay.hub.pc_policy_get(org, "").ok().and_then(|p| p.get("signed").map(|s| s.get("policy").cloned().unwrap_or_else(|| s.clone()))).unwrap_or(Value::Null)
}

/// The AI map with this hash the relay holds (unsigned body).
fn ai_map(relay: &Relay, org: &str, sha256: &str) -> Option<Value> {
    if sha256.is_empty() {
        return None;
    }
    relay.hub.pc_ai_get(org, sha256).ok().and_then(|p| p.get("signed").and_then(|s| s.get("map")).cloned())
}

fn ai_policy_hash(policy: &Value) -> String {
    policy.get("ai").and_then(|a| a.get("map_sha256")).and_then(Value::as_str).unwrap_or("").to_owned()
}

/// What the save was built on now: (policy seq, map seq).
fn ai_base(relay: &Relay, org: &str) -> (i64, i64) {
    let policy = ai_policy(relay, org);
    let map_seq = ai_map(relay, org, &ai_policy_hash(&policy)).and_then(|m| m.get("seq").and_then(Value::as_i64)).unwrap_or(0);
    (policy.get("seq").and_then(Value::as_i64).unwrap_or(0), map_seq)
}

fn ai_edition(relay: &Relay) -> Option<String> {
    relay.hub.gate().and_then(|g| g.license().map(|(l, _)| l.edition.clone()))
}

/// SHA-256 of the console certificate's public key: the gateway's `admin_spki` entry for this console.
fn console_spki(relay: &Relay) -> Option<String> {
    let pem = String::from_utf8_lossy(&std::fs::read(&relay.settings.console_cert).ok()?).into_owned();
    crate::meet_x509::Cert::from_pem(&pem).map(|c| crate::codec::sha256_hex(&c.spki))
}

/// One HTTPS call from the console to a gateway or an archive: the console's certificate as the client, the server
/// pinned by the SHA-256 of its public key; `ca` the roots (the Meet CA for a gateway, the public roots otherwise).
fn ai_https(relay: &Relay, url: &str, spki: &str, ca: Option<&str>, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
    let r = ai_https_raw(relay, url, spki, ca, method, path, body)?;
    let v: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
    if r.status >= 400 {
        let why = v.get("error").and_then(Value::as_str).map(clean).unwrap_or_else(|| format!("{url} answered {}", r.status));
        return Err(stale(&why));
    }
    Ok(v)
}

/// `ai_https` with the answer as it came: the status and the raw body.
fn ai_https_raw(relay: &Relay, url: &str, spki: &str, ca: Option<&str>, method: &str, path: &str, body: Option<&Value>) -> Result<crate::meet_tls::Response, ApiError> {
    let (host, port) = ai::endpoint(url).ok_or_else(|| invalid("url is https:// with a host and a port"))?;
    let cfg = crate::meet_tls::client_config(ca, Some((relay.settings.console_cert.as_str(), relay.settings.console_key.as_str()))).map_err(|e| ApiError::with("state-unreadable", format!("The console's certificate cannot be used: {e}.")))?;
    let pin = spki.to_owned();
    let check = move |der: &[u8]| -> Result<(), String> {
        let c = crate::meet_x509::Cert::from_der(der).ok_or("the server's certificate does not read")?;
        if crate::codec::sha256_hex(&c.spki) == pin {
            Ok(())
        } else {
            Err("the server's key is not the enrolled key".into())
        }
    };
    let bytes = body.map(|b| b.to_string().into_bytes());
    let headers = [("Content-Type", "application/json".to_string())];
    crate::meet_tls::https_request(&cfg, &host, port, AI_TIMEOUT, method, path, &headers, bytes.as_deref(), &check)
        .map_err(|e| ApiError::with("relay-offline", format!("{url} did not answer ({}).", e.unwrap_or_else(|x| x))))
}

fn ai_gateways(entry: &Obj) -> Vec<Value> {
    entry.get("gateways").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn ai_gateway_call(relay: &Relay, g: &Value, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
    let s = |k: &str| g.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    ai_https(relay, &s("url"), &s("spki"), Some(relay.settings.client_ca.as_str()), method, path, body)
}

fn ai_archive_call(relay: &Relay, entry: &Obj, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
    let a = entry.get("archive").and_then(Value::as_object).ok_or_else(|| stale("no archive is added for this organization"))?;
    ai_https(relay, &pj::s(a, "url"), &pj::s(a, "spki"), None, method, path, body)
}

/// API-1 revision 4 2.3 item 1 `archive_orgs` and 5.2.3: whether this relay holds the org's archive address.
pub(crate) fn archive_known(relay: &Relay, org: &str) -> bool {
    ai_state(relay).lock().org(relay, org).get("archive").is_some_and(Value::is_object)
}

/// API-1 revision 4 5.2.3 step 4: one call to the org's archive (`ai_archive_call`) from the API hold flow.
pub(crate) fn archive_call(relay: &Relay, org: &str, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
    let entry = ai_state(relay).lock().org(relay, org);
    ai_archive_call(relay, &entry, method, path, body)
}

/// API-1 revision 4 5.3.3: one call to the org's archive from the export flow (`api_exports_relay`), as
/// `archive_call` but with the status and the raw body as they came (a refusal's `{error, code}`, an octet-stream
/// part). Err only when the archive is not added or did not answer.
pub(crate) fn archive_raw(relay: &Relay, org: &str, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Vec<u8>), ApiError> {
    let entry = ai_state(relay).lock().org(relay, org);
    let a = entry.get("archive").and_then(Value::as_object).ok_or_else(|| stale("no archive is added for this organization"))?;
    let r = ai_https_raw(relay, &pj::s(a, "url"), &pj::s(a, "spki"), None, method, path, body)?;
    Ok((r.status, r.body))
}

fn ai_org_of(b: &Value) -> Result<String, ApiError> {
    let org = pj::str_or(b.get("org")).trim().to_string();
    if org.is_empty() {
        return Err(invalid("org is required"));
    }
    Ok(org)
}

impl MeetSection {
    fn ai_org_query(relay: &Relay, call: &SectionCall) -> Result<String, ApiError> {
        let f = filters(call.query, &["org"])?;
        let who = Self::who(relay, &call.caller.email)?;
        if let Some(o) = f.get("org").filter(|o| !o.is_empty()) {
            return Ok(o.clone());
        }
        let orgs = relay.hub.admin_organizations("", &who).map_err(from_hub)?;
        orgs.get("organizations").and_then(Value::as_array).and_then(|a| a.first()).and_then(|o| o.get("id")).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| not_found("organization"))
    }

    /// GET meet/ai?org=: the org's AI settings, the presets, what is staged and in flight, the enrolled gateways.
    fn ai_view(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        let org = Self::ai_org_query(relay, call)?;
        let who = Self::who(relay, &call.caller.email)?;
        let orgs = relay.hub.admin_organizations("", &who).map_err(from_hub)?;
        let list: Vec<Value> = orgs.get("organizations").and_then(Value::as_array).into_iter().flatten().map(|o| json!({"id": o.get("id"), "label": o.get("label")})).collect();
        let policy = ai_policy(relay, &org);
        let map = ai_map(relay, &org, &ai_policy_hash(&policy));
        let edition = ai_edition(relay);
        let st = ai_state(relay);
        let mut s = st.lock();
        let entry = s.org(relay, &org);
        let saving: Vec<Value> = s.saves.iter().filter(|x| x.staged.org == org).map(|x| json!({"step": x.step.as_str(), "request": x.request, "principal": x.principal, "map_sha256": x.staged.map_sha256})).collect();
        let waiting: Vec<Value> = s.asks.iter().filter(|x| x.org == org).map(|x| json!({"op": x.op, "request": x.request, "reviewer": x.body.get("reviewer")})).collect();
        let presets: Vec<Value> = ai::PRESETS.iter().map(|p| json!({"id": p.id, "label": p.label, "order": p.order, "access": p.access})).collect();
        Ok(json!({
            "ok": true, "org": org, "orgs": list, "presets": presets, "default": ai::DEFAULT_PRESET, "advanced": ai::ADVANCED,
            "ai": policy.get("ai").cloned().unwrap_or(Value::Null), "preset": policy.get("ai").map(ai::preset_of),
            "map": map, "staged": s.stages.get(&org, call.t).map(ai::Staged::view), "saving": saving, "waiting": waiting,
            "gateways": ai_gateways(&entry), "edition": edition, "lacks": ai::edition_lacks(edition.as_deref(), &policy),
            "reviewers": policy.get("archive_reviewers").cloned().unwrap_or(json!([])), "consoleSpki": console_spki(relay),
            "results": s.results.iter().filter(|r| r.get("org").and_then(Value::as_str) == Some(org.as_str())).cloned().collect::<Vec<_>>(),
        }))
    }

    /// POST meet/ai/stage {org, preset, ai, map}: build and check the change (the relay's own check_policy,
    /// check_ai_map, ai_gate and ai_edition_gate) and keep it staged; nothing is signed.
    fn ai_stage(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        Self::who(relay, &call.caller.email)?;
        let policy = ai_policy(relay, &org);
        let map = ai_map(relay, &org, &ai_policy_hash(&policy));
        // r6 8.1: MCP keys only once every reader reads them, each widened server with a new attestation
        Self::ai_mcp_gate(relay, &org, map.as_ref(), call.body)?;
        let st = ai_state(relay);
        let mut s = st.lock();
        let entry = s.org(relay, &org);
        // the gateways come from enrollment only
        let mut draft = call.body.clone();
        let mut map_draft = draft.get("map").and_then(Value::as_object).cloned().unwrap_or_default();
        map_draft.insert("gateways".into(), Value::Array(ai_gateways(&entry)));
        draft["map"] = Value::Object(map_draft);
        let minimums = relay.minimums(&relay.release());
        let edition = ai_edition(relay);
        let check = |p: &Value, mp: &Value| -> Result<(), String> {
            crate::meet_org_policy::check_policy(p, &crate::meet_org_policy::SignerTerms::default()).map_err(|e| e.to_string())?;
            crate::meet_org_policy::check_ai_map(mp, p.as_object()).map_err(|e| e.to_string())?;
            crate::meet_org_policy::ai_gate(Some(p), &minimums)?;
            crate::meet_org_policy::local_mcp_gate(Some(p), &minimums)?; // API-1c 10.6
            crate::meet_org_policy::ai_edition_gate(p.as_object().ok_or("the policy is not an object")?, edition.as_deref())
        };
        let staged = ai::stage(&org, &call.caller.email, &policy, map.as_ref(), &draft, call.t, &check)?;
        // r6 8.2: each MCP narrowing against the signed map journals at once
        self.ai_mcp_journal(relay, &org, map.as_ref(), &staged.map, &mut s, call.t)?;
        let id = staged.id.clone();
        let view = s.stages.put(staged, call.t);
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "staged": view, "before": policy.get("ai").cloned().unwrap_or(Value::Null)}), target: org, detail: json!({"stage": id}) })
    }

    /// POST meet/ai/save {org, stage, reason}: the AC-1 staged save; a second admin under the two-person rule.
    fn ai_save(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        let stage = pj::str_or(call.body.get("stage"));
        let reason = reason_of(call.body.get("reason")).map_err(invalid)?;
        let st = ai_state(relay);
        if st.lock().stages.get(&org, call.t).map(|s| s.id != stage).unwrap_or(true) {
            return Err(ApiError::with("gone", ai::STAGE_GONE));
        }
        let mut params = json!({"org": org, "stage": stage, "reason": reason});
        // r6 8.6: the approval shows each new MCP attestation with its residual risk
        if let Some(mcp) = Self::ai_mcp_approval(relay, &org, &stage, call.t) {
            params["mcp"] = mcp;
        }
        Ok(SectionAnswer::Second { target: org.clone(), params, detail: json!({"stage": stage}) })
    }

    /// The approved save: take the stage (stale when the policy or map moved), then ask the requester's device to
    /// sign the AI map; the policy is asked for only once the relay holds that map (`ai_request_signed`).
    fn ai_save_run(relay: &Relay, p: &Obj, principal: &str, t: i64) -> Result<Value, ApiError> {
        let org = pj::s(p, "org");
        let book = request_book(relay).ok_or_else(|| ApiError::of("state-unreadable"))?;
        let st = ai_state(relay);
        let mut s = st.lock();
        let staged = s.stages.take(&pj::s(p, "stage"), &org, ai_base(relay, &org), t)?;
        let target = ai::sign_target(&staged, principal, ai::SignStep::Map).ok_or_else(|| ApiError::of("state-unreadable"))?;
        let r = book.new_request(principal, AI_SIGN_KIND, target, &pj::s(p, "reason"), t)?;
        let id = pj::py_str(r.get("id").unwrap_or(&Value::Null));
        s.saves.retain(|x| x.staged.org != org);
        s.saves.push(AiSave { staged, principal: principal.into(), step: ai::SignStep::Map, request: id.clone() });
        Ok(json!({"ok": true, "request": id, "step": "map"}))
    }

    /// POST meet/ai/gateways {org, url, principal, device, spki, region | remove}: enroll a gateway for the next map.
    fn ai_gateway_set(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        Self::who(relay, &call.caller.email)?;
        let remove = call.body.get("remove") == Some(&Value::Bool(true));
        let st = ai_state(relay);
        let mut s = st.lock();
        let mut entry = s.org(relay, &org);
        let mut list = ai_gateways(&entry);
        let url = pj::str_or(call.body.get("url")).trim().to_string();
        if remove {
            let before = list.len();
            list.retain(|g| g.get("url").and_then(Value::as_str) != Some(url.as_str()));
            if list.len() == before {
                return Err(not_found("gateway"));
            }
        } else {
            let g = ai::gateway_of(call.body)?;
            list.retain(|x| x.get("url") != g.get("url"));
            if list.len() >= 8 {
                return Err(invalid("an AI map lists at most 8 gateways"));
            }
            list.push(g);
        }
        entry.insert("gateways".into(), Value::Array(list.clone()));
        s.set_org(relay, &org, entry)?;
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "gateways": list}), target: org, detail: json!({"url": url, "remove": remove}) })
    }

    /// The card rows of every enrolled gateway (a gateway that does not answer is listed with its error).
    fn ai_card_rows(relay: &Relay, org: &str) -> (Vec<(Value, Value)>, Vec<Value>) {
        let st = ai_state(relay);
        let entry = st.lock().org(relay, org);
        let (mut rows, mut errors) = (Vec::new(), Vec::new());
        for g in ai_gateways(&entry) {
            match ai_gateway_call(relay, &g, "GET", "/v1/ai/admin/cards", None) {
                Ok(v) => rows.extend(v.get("cards").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|r| (g.clone(), r))),
                Err(e) => errors.push(json!({"gateway": g.get("url"), "error": e.message})),
            }
        }
        (rows, errors)
    }

    fn ai_cards(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        let org = Self::ai_org_query(relay, call)?;
        let (rows, errors) = Self::ai_card_rows(relay, &org);
        let cards: Vec<Value> = rows.iter().map(|(g, r)| ai::card_view(g.get("url").and_then(Value::as_str).unwrap_or(""), r)).collect();
        Ok(json!({"ok": true, "org": org, "cards": cards, "errors": errors}))
    }

    fn ai_find_card(relay: &Relay, org: &str, gateway: &str, card_id: &str) -> Result<(Value, Value), ApiError> {
        let (rows, errors) = Self::ai_card_rows(relay, org);
        if let Some(found) = rows.into_iter().find(|(g, r)| g.get("url").and_then(Value::as_str) == Some(gateway) && r.get("card").and_then(|c| c.get("card_id")).and_then(Value::as_str) == Some(card_id)) {
            return Ok(found);
        }
        match errors.into_iter().find(|e| e.get("gateway").and_then(Value::as_str) == Some(gateway)) {
            Some(e) => Err(ApiError::with("relay-offline", pj::py_str(e.get("error").unwrap_or(&Value::Null)))),
            None => Err(not_found("model card")),
        }
    }

    /// POST meet/ai/cards/bench {org, gateway, card_id, files?}: Run benchmark (3.2).
    fn ai_bench(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        let (gateway, card_id) = (pj::str_or(call.body.get("gateway")), pj::str_or(call.body.get("card_id")));
        let (g, _) = Self::ai_find_card(relay, &org, &gateway, &card_id)?;
        let mut body = json!({"card_id": card_id});
        if let Some(files) = call.body.get("files").filter(|f| f.is_array()) {
            body["files"] = files.clone();
        }
        let answer = ai_gateway_call(relay, &g, "POST", "/v1/ai/admin/bench", Some(&body))?;
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "bench": answer}), target: card_id, detail: json!({"gateway": gateway}) })
    }

    /// POST meet/ai/cards/approve {org, gateway, card_id, for_classes, retention_override?, reason}: refused before a
    /// passing benchmark; then step-up and the two-person rule; checked again when it runs.
    fn ai_approve(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        let (gateway, card_id) = (pj::str_or(call.body.get("gateway")), pj::str_or(call.body.get("card_id")));
        let (_, row) = Self::ai_find_card(relay, &org, &gateway, &card_id)?;
        ai::approve_allowed(&row)?;
        Ok(SectionAnswer::Second { target: card_id, params: call.body.clone(), detail: json!({"gateway": gateway}) })
    }

    fn ai_approve_run(relay: &Relay, p: &Obj, principal: &str) -> Result<Value, ApiError> {
        let (org, gateway, card_id) = (pj::s(p, "org"), pj::s(p, "gateway"), pj::s(p, "card_id"));
        let (g, row) = Self::ai_find_card(relay, &org, &gateway, &card_id)?;
        ai::approve_allowed(&row)?;
        let mut body = json!({"card_id": card_id, "by": principal, "for_classes": p.get("for_classes").cloned().unwrap_or(json!([]))});
        if let Some(r) = p.get("retention_override").filter(|r| r.as_str().is_some_and(|s| !s.trim().is_empty())) {
            body["retention_override"] = r.clone();
        }
        let answer = ai_gateway_call(relay, &g, "POST", "/v1/ai/admin/approve", Some(&body))?;
        Ok(json!({"ok": true, "card": answer.get("card").cloned().unwrap_or(Value::Null)}))
    }

    /// GET meet/ai/usage?org=: the last 30 days from every gateway, against the archive's `ai` rids.
    fn ai_usage(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        let org = Self::ai_org_query(relay, call)?;
        let since = call.t.div_euclid(1000) - 30 * 86_400;
        let st = ai_state(relay);
        let entry = st.lock().org(relay, &org);
        let mut usages = Vec::new();
        let mut errors = Vec::new();
        for g in ai_gateways(&entry) {
            match ai_gateway_call(relay, &g, "GET", &format!("/v1/ai/admin/usage?since={since}"), None) {
                Ok(v) => usages.push(v),
                Err(e) => errors.push(json!({"gateway": g.get("url"), "error": e.message})),
            }
        }
        let held: Option<HashSet<String>> = if entry.get("archive").is_some_and(Value::is_object) {
            match ai_archive_call(relay, &entry, "GET", &format!("/v1/ai/rids?since={since}"), None) {
                Ok(v) => Some(v.get("rids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()),
                Err(e) => {
                    errors.push(json!({"archive": true, "error": e.message}));
                    None
                }
            }
        } else {
            None
        };
        // the devices' own audit lines (6.6): personal access and dropped history, read page by page from the relay
        let mut records: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut more = false;
        for page in 0..AI_AUDIT_PAGES {
            let answer = relay.hub.ai_audit_list(&org, since * 1000, cursor.as_deref()).map_err(from_hub)?;
            records.extend(answer.get("records").and_then(Value::as_array).cloned().unwrap_or_default());
            cursor = answer.get("next").and_then(Value::as_str).map(str::to_owned);
            if cursor.is_none() {
                break;
            }
            more = page + 1 == AI_AUDIT_PAGES;
        }
        let policy = ai_policy(relay, &org);
        let mut v = ai::usage_view(&usages, held.as_ref());
        v["audit"] = ai::audit_view(&records);
        v["audit"]["partial"] = Value::Bool(more);
        v["ok"] = Value::Bool(true);
        v["org"] = Value::from(org);
        v["budgets"] = policy.get("ai").and_then(|a| a.get("budgets")).cloned().unwrap_or(Value::Null);
        v["errors"] = Value::Array(errors);
        Ok(v)
    }

    /// Ask a reviewer's device to sign an archive request (7.5, 7.8): an AC-1 request to that reviewer.
    fn ai_ask_reviewer(relay: &Relay, org: &str, reviewer: &str, by: &str, op: &'static str, body: Value, reason: &str, t: i64) -> Result<Value, ApiError> {
        let policy = ai_policy(relay, org);
        let reviewers: Vec<&str> = policy.get("archive_reviewers").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        if !reviewers.contains(&reviewer) {
            return Err(invalid(format!("{} is not an archive reviewer of this organization", clean(reviewer))));
        }
        let label = match op {
            "hold" => ai::HOLD_LABEL,
            "recovery_code" => ai::RECOVERY_CODE_LABEL,
            _ => ai::CONFIG_LABEL,
        };
        let book = request_book(relay).ok_or_else(|| ApiError::of("state-unreadable"))?;
        let target = json!({"principal": reviewer, "org": org, "op": op, "label": label, "body": body});
        let r = book.new_request(by, AI_REVIEWER_KIND, target, reason, t)?;
        let id = pj::py_str(r.get("id").unwrap_or(&Value::Null));
        ai_state(relay).lock().asks.push(ReviewerAsk { request: id.clone(), org: org.into(), op, body, by: by.into() });
        Ok(json!({"ok": true, "request": id, "reviewer": reviewer, "op": op}))
    }

    /// POST meet/ai/hold {org, principal, reviewer, reason}: "Place a legal hold" on a person. With an archive, a
    /// reviewer signs first and both holds are placed when the signature arrives; with none (a small organization)
    /// only the relay hold exists, and the answer says so.
    fn ai_hold(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        let principal = m::principal(call.body.get("principal"));
        let reason = reason_of(call.body.get("reason")).map_err(invalid)?;
        if !principal.contains('@') {
            return Err(invalid("name the person (their email)"));
        }
        if !relay.hub.pc_may_hold_people(&call.caller.email, std::slice::from_ref(&principal)) {
            return Err(ApiError::with("role", "Only an admin of these people's organization (org_admins) can hold them."));
        }
        let entry = ai_state(relay).lock().org(relay, &org);
        let policy = ai_policy(relay, &org);
        let has_archive = policy.get("archive").is_some_and(|a| a.as_object().is_some_and(|o| !o.is_empty()));
        if !has_archive || !entry.get("archive").is_some_and(Value::is_object) {
            if has_archive {
                return Err(stale("add the archive's address first, so the archive hold can be placed with the relay hold"));
            }
            let who = Self::who(relay, &call.caller.email)?;
            let out = relay.hub.pc_holds_place("", &who, Some(&json!("people")), Some(&json!([principal])), None, Some(&Value::from(reason.as_str()))).map_err(from_hub)?;
            let answer = json!({"ok": true, "placed": true, "relay": {"ok": true, "id": out.get("id")}, "archive": Value::Null, "notice": ai::NO_ARCHIVE});
            return Ok(SectionAnswer::Done { answer, target: principal, detail: json!({"org": org, "archive": false}) });
        }
        let reviewer = m::principal(call.body.get("reviewer"));
        let body = ai::hold_body(std::slice::from_ref(&principal), &reason, &reviewer);
        let answer = Self::ai_ask_reviewer(relay, &org, &reviewer, &call.caller.email, "hold", body, &reason, call.t)?;
        Ok(SectionAnswer::Done { answer, target: principal, detail: json!({"org": org, "reviewer": reviewer}) })
    }

    /// GET meet/ai/archive?org=: the archive section by organization size; a new recovery code is shown once.
    fn ai_archive(&self, relay: &Relay, call: &SectionCall) -> Result<Value, ApiError> {
        let org = Self::ai_org_query(relay, call)?;
        let policy = ai_policy(relay, &org);
        let st = ai_state(relay);
        let entry = st.lock().org(relay, &org);
        let url = entry.get("archive").and_then(|a| a.get("url")).and_then(Value::as_str).map(str::to_owned);
        let (status, error) = match &url {
            Some(_) => match ai_archive_call(relay, &entry, "GET", "/v1/recovery", None) {
                Ok(v) => (Some(v), Value::Null),
                Err(e) => (None, Value::from(e.message)),
            },
            None => (None, Value::Null),
        };
        let edition = ai_edition(relay);
        let mut v = ai::archive_view(edition.as_deref(), &policy, url.as_deref(), status.as_ref(), entry.get("code_gen").and_then(Value::as_i64));
        let mut s = st.lock();
        if let Some(code) = s.codes.iter_mut().find(|c| c.org == org) {
            if code.shown {
                v["confirm"] = json!({"first": code.ask.0 + 1, "second": code.ask.1 + 1});
            } else {
                code.shown = true;
                v["code"] = Value::from(code.groups.join("-"));
                v["confirm"] = json!({"first": code.ask.0 + 1, "second": code.ask.1 + 1});
            }
        }
        v["ok"] = Value::Bool(true);
        v["org"] = Value::from(org);
        v["error"] = error;
        v["reviewersList"] = policy.get("archive_reviewers").cloned().unwrap_or(json!([]));
        Ok(v)
    }

    /// POST meet/ai/archive {org, url, spki | remove}: "Add an archive" (its admin address and pinned key).
    fn ai_archive_set(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        reason_of(call.body.get("reason")).map_err(invalid)?;
        Self::who(relay, &call.caller.email)?;
        let st = ai_state(relay);
        let mut s = st.lock();
        let mut entry = s.org(relay, &org);
        let remove = call.body.get("remove") == Some(&Value::Bool(true));
        if remove {
            entry.insert("archive".into(), Value::Null);
        } else {
            let url = pj::str_or(call.body.get("url")).trim().to_string();
            let spki = pj::str_or(call.body.get("spki")).trim().to_lowercase();
            if url.len() > 256 || ai::endpoint(&url).is_none() {
                return Err(invalid("url is https:// with a host and a port"));
            }
            if !ai::hex64(&spki) {
                return Err(invalid("spki is the SHA-256 of the archive server's public key, 64 hex digits"));
            }
            entry.insert("archive".into(), json!({"url": url, "spki": spki}));
        }
        s.set_org(relay, &org, entry)?;
        Ok(SectionAnswer::Done { answer: json!({"ok": true}), target: org, detail: json!({"remove": remove}) })
    }

    /// POST meet/ai/archive/copy {org, reviewer, offline_copy, reason}: big organizations' offline copy settings,
    /// signed by a reviewer.
    fn ai_archive_copy(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        let reason = reason_of(call.body.get("reason")).map_err(invalid)?;
        let copy = ai::offline_copy_of(call.body.get("offline_copy").unwrap_or(&Value::Null))?;
        let reviewer = m::principal(call.body.get("reviewer"));
        let body = json!({"op": "offline_copy", "offline_copy": copy, "reviewer": reviewer});
        let answer = Self::ai_ask_reviewer(relay, &org, &reviewer, &call.caller.email, "offline_copy", body, &reason, call.t)?;
        Ok(SectionAnswer::Done { answer, target: org, detail: json!({"reviewer": reviewer}) })
    }

    /// POST meet/ai/archive/code {org, reviewer, reason}: make (or replace) the small organization's recovery code.
    fn ai_archive_code(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        let reason = reason_of(call.body.get("reason")).map_err(invalid)?;
        if ai_edition(relay).as_deref() != Some("standard") {
            return Err(stale("a big organization recovers with its reviewers' shares, not a recovery code"));
        }
        let reviewer = m::principal(call.body.get("reviewer"));
        let body = json!({"op": "recovery_code", "reviewer": reviewer});
        let answer = Self::ai_ask_reviewer(relay, &org, &reviewer, &call.caller.email, "recovery_code", body, &reason, call.t)?;
        Ok(SectionAnswer::Done { answer, target: org, detail: json!({"reviewer": reviewer}) })
    }

    /// POST meet/ai/archive/code/confirm {org, first, second}: the owner typed back the two asked groups.
    fn ai_archive_code_confirm(&self, relay: &Relay, call: &SectionCall) -> Result<SectionAnswer, ApiError> {
        let org = ai_org_of(call.body)?;
        let st = ai_state(relay);
        let mut s = st.lock();
        let i = s.codes.iter().position(|c| c.org == org).ok_or_else(|| ApiError::of("gone"))?;
        s.codes[i].confirm(&pj::str_or(call.body.get("first")), &pj::str_or(call.body.get("second")))?;
        let code = s.codes.remove(i);
        let mut entry = s.org(relay, &org);
        entry.insert("code_gen".into(), Value::from(code.gen));
        s.set_org(relay, &org, entry)?;
        Ok(SectionAnswer::Done { answer: json!({"ok": true, "gen": code.gen}), target: org, detail: json!({"gen": code.gen}) })
    }
}

/// The relay's view of a save's map and policy, for `console_ai::after_signed`.
fn ai_observed(relay: &Relay, s: &ai::Staged) -> ai::Observed {
    let policy = ai_policy(relay, &s.org);
    let named = policy.get("seq").and_then(Value::as_i64).map(|seq| (ai_policy_hash(&policy), seq));
    ai::Observed { map_stored: ai_map(relay, &s.org, &s.map_sha256).is_some(), policy: named }
}

fn api_e(e: ApiError) -> E {
    E::Status(e.status, e.message, false)
}

/// `POST /v1/admin/console/requests/sign {session, id, sig?}`: the device of the request's principal reports a
/// `meet.ai.*` request done. `meet.ai.sign`: the relay must now hold what the step signed (the map, then the policy
/// naming it); the next step is asked for, or the save is done. `meet.ai.reviewer-sign`: `sig` is `{ts, sig}` over
/// the request's label and body with `ts`; the console then delivers the archive request (and, for a hold, places
/// the relay hold with it).
pub fn ai_request_signed(relay: &Relay, who: &Identity, id: Option<&Value>, sig: Option<&Value>) -> R<Obj> {
    let id = id.and_then(Value::as_str).filter(|i| request_id_ok(i)).ok_or_else(|| E::Bad(DECLINE_ID.into()))?.to_string();
    let book = request_book(relay).ok_or_else(|| E::NotFound(NO_REQUEST.into()))?;
    let t = (pj::now() * 1000.0) as i64;
    let request = book.requests_waiting("meet.ai.", t).into_iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str())).ok_or_else(|| E::NotFound(NO_REQUEST.into()))?;
    let target = request.get("target").cloned().unwrap_or(Value::Null);
    if target.get("principal").and_then(Value::as_str) != Some(who.principal.as_str()) {
        return Err(E::NotFound(NO_REQUEST.into()));
    }
    let kind = pj::py_str(request.get("kind").unwrap_or(&Value::Null));
    let st = ai_state(relay);
    let mut s = st.lock();
    let close = || book.observe_requests(&kind, &who.principal, t, &|x: &Value| *x == target);
    if kind == AI_SIGN_KIND {
        let i = s.saves.iter().position(|x| x.request == id).ok_or_else(|| E::NotFound(NO_REQUEST.into()))?;
        let next = ai::after_signed(&s.saves[i].staged, s.saves[i].step, &ai_observed(relay, &s.saves[i].staged)).map_err(api_e)?;
        close();
        if next == ai::SignStep::Done {
            let save = s.saves.remove(i);
            s.result(json!({"org": save.staged.org, "at": t, "op": "save", "ok": true, "map_sha256": save.staged.map_sha256}));
            return Ok(obj([("ok", Value::Bool(true)), ("step", Value::from("done"))]));
        }
        let principal = s.saves[i].principal.clone();
        let next_target = ai::sign_target(&s.saves[i].staged, &principal, next).ok_or_else(|| E::NotFound(NO_REQUEST.into()))?;
        let r = book.new_request(&principal, AI_SIGN_KIND, next_target, "Sign the AI settings that name the signed AI map", t).map_err(api_e)?;
        let next_id = pj::py_str(r.get("id").unwrap_or(&Value::Null));
        s.saves[i].step = next;
        s.saves[i].request = next_id.clone();
        return Ok(obj([("ok", Value::Bool(true)), ("step", Value::from(next.as_str())), ("request", Value::from(next_id))]));
    }
    if !s.asks.iter().any(|x| x.request == id) {
        // API-1 revision 4 5.2.3: an API hold's durable ask (`api-compliance/<org>/asks.json`)
        drop(s);
        if target.get("op").and_then(Value::as_str) == Some(crate::api_exports_relay::OP) {
            // API-1 revision 4 5.3.3 step 4: an API export's release ask (`api-compliance/<org>/exports.json`)
            return crate::api_exports_relay::ask_signed(relay, &book, who, &request, sig, t);
        }
        return crate::api_holds_relay::ask_signed(relay, &book, who, &request, sig, t);
    }
    let i = s.asks.iter().position(|x| x.request == id).ok_or_else(|| E::NotFound(NO_REQUEST.into()))?;
    let sig = sig.ok_or_else(|| E::Bad("sig is {ts, sig}".into()))?;
    let ts = sig.get("ts").and_then(Value::as_i64).ok_or_else(|| E::Bad("sig is {ts, sig}".into()))?;
    let body = ai::signed_body(&s.asks[i].body, ts, sig.get("sig").and_then(Value::as_str).unwrap_or(""), t.div_euclid(1000)).map_err(api_e)?;
    let ask = s.asks.remove(i);
    close();
    let entry = s.org(relay, &ask.org);
    let outcome = match ask.op {
        "hold" => {
            let by = MeetSection::who(relay, &ask.by).map_err(api_e)?;
            let r = || {
                relay.hub.pc_holds_place("", &by, body.get("on"), body.get("principals"), None, body.get("reason")).map(|o| pj::s(&o, "id")).map_err(from_hub)
            };
            ai::place_both(r, || ai_archive_call(relay, &entry, "POST", "/v1/holds", Some(&body)))
        }
        "recovery_code" => match ai_archive_call(relay, &entry, "POST", "/v1/recovery/code", Some(&body)) {
            Ok(v) => match ai::code_groups(v.get("code").and_then(Value::as_str).unwrap_or("")) {
                Some(groups) => {
                    let r = crate::console_auth::random_bytes(2).map_err(api_e)?;
                    let ask_two = ai::pick_two([r[0], r[1]], groups.len());
                    let gen = v.get("gen").and_then(Value::as_i64).unwrap_or(0);
                    s.codes.retain(|c| c.org != ask.org);
                    s.codes.push(ai::PendingCode { org: ask.org.clone(), gen, groups, ask: ask_two, shown: false });
                    json!({"ok": true, "gen": gen})
                }
                None => json!({"ok": false, "error": "The archive's recovery code does not read."}),
            },
            Err(e) => json!({"ok": false, "error": e.message}),
        },
        _ => match ai_archive_call(relay, &entry, "POST", "/v1/recovery/offline_copy", Some(&body)) {
            Ok(v) => json!({"ok": true, "offline_copy": v.get("offline_copy")}),
            Err(e) => json!({"ok": false, "error": e.message}),
        },
    };
    let mut row = json!({"org": ask.org, "at": t, "op": ask.op, "by": ask.by, "reviewer": who.principal});
    if let (Some(r), Some(o)) = (row.as_object_mut(), outcome.as_object()) {
        r.extend(o.clone());
    }
    s.result(row);
    let mut out = outcome.as_object().cloned().unwrap_or_default();
    out.insert("ok".into(), Value::Bool(true));
    Ok(out)
}

// ── API-1 2.3 (slice 1a6): the `meet.api.sign` request in this relay's book ───────────────────────────────────

/// The request kind the Lucid Admin Console asks an admin's device to sign an org api map with.
pub const API_SIGN_KIND: &str = "meet.api.sign";
/// Why a `meet.api.sign` request failed or is refused (relay words).
pub const API_SIGN_OTHER_MAP: &str = "The signed API map is not the one this request asked for.";
pub const API_SIGN_DECLINED: &str = "The signing request was declined on the device.";
pub const API_SIGN_NOT_ADMIN: &str = "That person is not an admin of this relay.";
pub const API_SIGN_HASH: &str = "map_sha256 is not the hash of that map.";
const API_SIGN_SHAPE: &str = "signed is the signed api map {map, sig, chain}";

/// `POST /v1/admin/console/requests/sign {session, id, sig?, signed?}`: a `meet.api.sign` request (`signed`), else
/// a `meet.ai.*` one (`ai_request_signed`).
pub fn request_signed(relay: &Relay, who: &Identity, id: Option<&Value>, sig: Option<&Value>, signed: Option<&Value>) -> R<Obj> {
    let wanted = id.and_then(Value::as_str).filter(|i| request_id_ok(i)).ok_or_else(|| E::Bad(DECLINE_ID.into()))?;
    let t = (pj::now() * 1000.0) as i64;
    let book = request_book(relay).ok_or_else(|| E::NotFound(NO_REQUEST.into()))?;
    match book.requests_waiting("meet.api.", t).into_iter().find(|r| r.get("id").and_then(Value::as_str) == Some(wanted)) {
        Some(request) => api_request_signed(relay, &book, who, &request, signed, t),
        None => ai_request_signed(relay, who, id, sig),
    }
}

/// A `meet.api.sign` request answered by its principal's device: `signed` must be the map the request names (its
/// hash `map_sha256`) and verify against this relay's org CA as `POST /v1/org/api` checks it (nothing is pinned
/// here). Done keeps `signed` and the signer policy it verified under for the console (`api-sign-status`); a
/// failure closes the request with its sentence and refuses the device.
fn api_request_signed(relay: &Relay, book: &Console, who: &Identity, request: &Value, signed: Option<&Value>, t: i64) -> R<Obj> {
    let id = request.get("id").and_then(Value::as_str).unwrap_or_default();
    let target = request.get("target").cloned().unwrap_or(Value::Null);
    if target.get("principal").and_then(Value::as_str) != Some(who.principal.as_str()) {
        return Err(E::NotFound(NO_REQUEST.into()));
    }
    let signed = signed.filter(|s| s.get("map").is_some_and(Value::is_object)).ok_or_else(|| E::Bad(API_SIGN_SHAPE.into()))?;
    let want = target.get("map_sha256").and_then(Value::as_str).unwrap_or_default();
    let verdict = if crate::api_map::api_map_hash(&signed["map"]) != want {
        Err(API_SIGN_OTHER_MAP.to_string())
    } else {
        relay.hub.api_verify_signed(signed).and_then(|(vm, sp)| if vm.org == target.get("org").and_then(Value::as_str).unwrap_or_default() { Ok(sp) } else { Err(API_SIGN_OTHER_MAP.to_string()) })
    };
    match verdict {
        Ok(signer_policy) => {
            let extra = obj([("signed", signed.clone()), ("signer_policy", Value::Object(signer_policy))]);
            book.request_close(id, API_SIGN_KIND, "done", &who.principal, extra, t).map_err(api_e)?;
            Ok(obj([("ok", Value::Bool(true))]))
        }
        Err(why) => {
            book.request_close(id, API_SIGN_KIND, "failed", &who.principal, obj([("error", Value::from(why.clone()))]), t).map_err(api_e)?;
            Err(E::Conflict(why))
        }
    }
}

/// The fleet request `api-sign-request {org, principal, map, map_sha256, reason, requested_by}` on this relay (the
/// agent checked the org is served): the hash must be the map's and the principal an admin of this relay; a waiting
/// `meet.api.sign` request for the same org is cancelled, then the new one is made in this relay's book (target
/// `{principal, org, op: "sign_org_api", map, map_sha256}`). Ok is `{request}`.
pub fn api_sign_request(book: &Console, body: &Value, t: i64) -> Result<Value, ApiError> {
    let s = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let (org, principal, sha, by) = (s("org"), s("principal").to_lowercase(), s("map_sha256"), s("requested_by"));
    let map = body.get("map").filter(|m| m.is_object()).ok_or_else(|| invalid(API_SIGN_HASH))?;
    if crate::api_map::api_map_hash(map) != sha || map.get("org").and_then(Value::as_str) != Some(org.as_str()) {
        return Err(invalid(API_SIGN_HASH));
    }
    if book.admin_rule(&principal, "") == AdminRule::NotRelayAdmin {
        return Err(ApiError::with("not-relay-admin", API_SIGN_NOT_ADMIN));
    }
    let reason = reason_of(body.get("reason")).map_err(invalid)?;
    for r in book.requests_waiting("meet.api.", t) {
        if r.get("target").and_then(|x| x.get("org")).and_then(Value::as_str) == Some(org.as_str()) {
            let _ = book.requests_cancel(&json!({ "id": r.get("id") }), t);
        }
    }
    let target = json!({ "principal": principal, "org": org, "op": "sign_org_api", "map": map, "map_sha256": sha });
    let r = book.new_request(&by, API_SIGN_KIND, target, &reason, t)?;
    Ok(json!({ "request": r.get("id") }))
}

/// The fleet request `api-sign-status {org, request}`: `{state: waiting | done | failed | gone}` with `signed` and
/// `signer_policy` when done and `error` when failed. A declined request is failed; a cancelled, expired or unknown
/// one (or another org's) is gone.
pub fn api_sign_status(book: &Console, body: &Value, t: i64) -> Value {
    let id = body.get("request").and_then(Value::as_str).unwrap_or_default();
    let org = body.get("org").and_then(Value::as_str).unwrap_or_default();
    let found = book.request_by_id(id, t).filter(|r| r.get("kind").and_then(Value::as_str) == Some(API_SIGN_KIND) && r.get("target").and_then(|x| x.get("org")).and_then(Value::as_str) == Some(org));
    let Some(r) = found else { return json!({ "state": "gone" }) };
    match r.get("state").and_then(Value::as_str).unwrap_or_default() {
        "waiting" => json!({ "state": "waiting" }),
        "done" => json!({ "state": "done", "signed": r.get("signed"), "signer_policy": r.get("signer_policy") }),
        "failed" => json!({ "state": "failed", "error": r.get("error").and_then(Value::as_str).unwrap_or(API_SIGN_OTHER_MAP) }),
        "declined" => json!({ "state": "failed", "error": API_SIGN_DECLINED }),
        _ => json!({ "state": "gone" }),
    }
}

// ── the hub's hooks ──────────────────────────────────────────────────────────────────────────────────────────

/// Anchor latching and request observation, from the hub to the core console.
struct Hooks {
    relay: Weak<Relay>,
    console: Arc<Console>,
}

/// The serial of one device the relay knows (directory), or "".
fn device_serial(relay: &Relay, principal: &str, device: &str) -> String {
    let st = relay.hub.st.lock();
    st.directory.get(principal).and_then(|e| e.get("devices")).and_then(|d| d.get(device)).map(|d| m::serial_of(d.get("serial"))).unwrap_or_default()
}

impl ConsoleHooks for Hooks {
    fn revoked(&self, serials: &[String]) {
        let set: HashSet<String> = serials.iter().map(|s| m::serial(s)).filter(|s| !s.is_empty()).collect();
        if set.is_empty() {
            return;
        }
        self.console.set_revoked(&set);
        // 3.8: a CRL the relay holds that lists the device's serial completes meet.revoke
        let Some(relay) = self.relay.upgrade() else { return };
        let t = (pj::now() * 1000.0) as i64;
        self.console.observe_requests("meet.revoke", "crl", t, &|target: &Value| {
            let principal = target.get("principal").and_then(Value::as_str).unwrap_or_default();
            let device = target.get("device").and_then(Value::as_str).unwrap_or_default();
            let serial = device_serial(&relay, principal, device);
            !serial.is_empty() && set.contains(&serial)
        });
    }

    fn observed(&self, kind: &str, target: &Obj, by: &str, link: Option<&str>) {
        let t = (pj::now() * 1000.0) as i64;
        let want = |k: &str| target.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let n = match kind {
            "meet.approve" => {
                let (k, id, csr) = (want("kind"), want("id"), want("csr_sha256"));
                self.console.observe_requests(kind, by, t, &|r: &Value| r.get("kind").and_then(Value::as_str) == Some(k.as_str()) && r.get("id").and_then(Value::as_str) == Some(id.as_str()) && r.get("csr_sha256").and_then(Value::as_str) == Some(csr.as_str()))
            }
            "meet.revoke" => {
                let (principal, device) = (want("principal"), want("device"));
                self.console.observe_requests(kind, by, t, &|r: &Value| {
                    let rd = r.get("device").and_then(Value::as_str).unwrap_or_default();
                    r.get("principal").and_then(Value::as_str) == Some(principal.as_str()) && (device.is_empty() || rd == device)
                })
            }
            "meet.invite" => {
                let email = want("email");
                self.console.observe_requests(kind, by, t, &|r: &Value| r.get("email").and_then(Value::as_str) == Some(email.as_str()))
            }
            _ => 0,
        };
        if let Some(id) = link {
            self.console.audit_relay("requests.linked", id, json!({"kind": kind, "by": by, "observed": n}));
        }
    }

    fn reader(&self, email: &str) -> bool {
        self.console.check_console_reader(email)
    }

    fn console_admin(&self, principal: &str) -> bool {
        self.console.is_active_admin(principal)
    }

    fn admin_emails(&self) -> Vec<String> {
        self.console.active_admin_emails()
    }

    fn audit(&self, action: &str, target: &str, detail: Value) {
        self.console.audit_relay(action, target, detail);
    }

    fn audit_operator(&self, action: &str, target: &str, detail: Value) {
        let mut r = crate::console_audit::Record::new("operator", action, "ok");
        r.target = Some(target.to_owned());
        r.detail = detail;
        self.console.record(r, (pj::now() * 1000.0) as i64);
    }

    fn mail(&self, kind: &str, to: &str, args: &[(&str, String)]) {
        crate::console_mail::send(kind, to, args);
    }
}

// ── start (3.1) ──────────────────────────────────────────────────────────────────────────────────────────────

/// The Admin Console on the Meeting Hub relay: nothing when `console_port` is 0; Err is why the relay does not start.
pub fn start(relay: &Arc<Relay>) -> Result<(), String> {
    let s = &relay.settings;
    let main_dns = crate::meet_tls::cert_dns_names(&s.cert);
    let Some(conf) = crate::meet_console_port::check_settings(s, &main_dns)? else { return Ok(()) };
    if s.state_dir.is_empty() {
        return Err("the Admin Console needs state_dir".into());
    }
    crate::meet_tls::check_console_cert(&s.console_cert, &s.client_ca, &conf.host)?;
    let tls = crate::meet_tls::console_tls_config(s)?;
    let state_dir = PathBuf::from(&s.state_dir);
    let blocks = MeetBlocks::open(&state_dir.join(BLOCKS_FILE))?;
    let t = (pj::now() * 1000.0) as i64;
    relay.hub.set_blocks(blocks.mirror(t));
    let sources = crate::console_source::parse_cidrs(&s.console_sources, 32)?;
    let first_admin = Some(s.console_first_admin.trim().to_lowercase()).filter(|p| !p.is_empty());
    let cfg = ConsoleConfig { product: Product::Meet, state_dir, origin: Some(conf.origin()), sources, trusted_fronts: Vec::new(), behind_front: false, first_admin, profile: crate::console_settings::Profile::parse(s.console_profile.trim()), host: conf.host.clone() };
    let ring = Arc::new(crate::console::LineRing::default());
    let logger = Arc::new(crate::log::Logger::new("meet-console").with_tap(ring.tap()));
    let console = Console::open(cfg, logger, ring)?;
    let section = Arc::new(MeetSection::new(Arc::downgrade(relay), blocks, t));
    console.attach(section);
    // 3.2: latch at start from the denied set and every CRL the relay holds, then on every change
    let mut serials: Vec<String> = relay.hub.denied_serials().into_iter().collect();
    serials.extend(relay.revoked_serials());
    let hooks = Arc::new(Hooks { relay: Arc::downgrade(relay), console: console.clone() });
    hooks.revoked(&serials);
    relay.hub.set_console_hooks(hooks);
    // 2.4: the gate's first-start entries (upgrade period, `firstSeen` migration) reach the audit now; then a check
    // with the console's admins protected (R3-M6)
    if let Some(gate) = relay.hub.gate() {
        gate.flush_pending();
        gate.check(true);
    }
    let _ = relay.admin_console.set(console.clone());
    let handler_console = console.clone();
    let handler: crate::meet_console_port::Handler = Arc::new(move |r: &crate::console::ConsoleRequest<'_>, t: i64| handler_console.http(r, t));
    let source_console = console;
    let source_ok: crate::meet_console_port::SourceCheck = Arc::new(move |ip: std::net::IpAddr| source_console.source_allowed(ip));
    crate::meet_console_port::start(s, conf, tls, handler, source_ok)
}

/// AC-2a 2.1: the logger of an enrolled Meeting Hub relay's headless console and agent.
pub fn logger() -> Arc<crate::log::Logger> {
    Arc::new(crate::log::Logger::new("meet-fleet"))
}

/// AC-2a 2.1: the headless console of an enrolled relay whose own console is off gets the Meeting Hub section, the
/// block list and the hooks, exactly as `start` gives the local console (no port is opened). A block list that does
/// not read back is logged and the section is not attached (fail closed: proxied block routes then answer 503).
pub fn attach_headless(relay: &Arc<Relay>, console: &Arc<Console>) {
    let Some(dir) = (!relay.settings.state_dir.is_empty()).then(|| PathBuf::from(&relay.settings.state_dir)) else { return };
    let blocks = match MeetBlocks::open(&dir.join(BLOCKS_FILE)) {
        Ok(b) => b,
        Err(e) => {
            crate::meet::log_warn(&format!("fleet.blocks-unreadable category=security reason={}", m::kv(&e)));
            return;
        }
    };
    let t = (pj::now() * 1000.0) as i64;
    relay.hub.set_blocks(blocks.mirror(t));
    console.attach(Arc::new(MeetSection::new(Arc::downgrade(relay), blocks, t)));
    let mut serials: Vec<String> = relay.hub.denied_serials().into_iter().collect();
    serials.extend(relay.revoked_serials());
    let hooks = Arc::new(Hooks { relay: Arc::downgrade(relay), console: console.clone() });
    hooks.revoked(&serials);
    relay.hub.set_console_hooks(hooks);
}

/// AC-2a 5.7: the console whose book holds this relay's requests: its own, else the headless one while enrolled.
pub(crate) fn request_book(relay: &Relay) -> Option<Arc<Console>> {
    relay.admin_console.get().cloned().or_else(|| relay.fleet.get().map(|f| f.book.clone()))
}

/// AC-2a 5.7 (F13) `GET /v1/admin/console/where`: `{ok, local, managedBy}`.
pub fn console_where(relay: &Relay) -> Obj {
    let managed_by = relay.fleet.get().and_then(|f| (f.managed_by)()).map(Value::from).unwrap_or(Value::Null);
    obj([("ok", Value::Bool(true)), ("local", Value::Bool(relay.admin_console.get().is_some())), ("managedBy", managed_by)])
}

/// AC-2a 5.7: the 409 words of `POST /v1/admin/console/invite` on an enrolled relay with no local console.
pub fn managed_words(origin: &str) -> String {
    format!("This relay is managed by the Lucid Admin Console at {origin}. Sign in there.")
}

/// AC-2a 5.7 (F20): endorsement attempts per device certificate serial within the hour (at most 10).
static ENDORSE_TRIES: std::sync::LazyLock<parking_lot::Mutex<HashMap<String, Vec<i64>>>> = std::sync::LazyLock::new(Default::default);

/// One endorsement attempt by `serial` at `t` (ms): false past 10 within the hour.
pub fn endorse_try(serial: &str, t: i64) -> bool {
    let mut tries = ENDORSE_TRIES.lock();
    tries.retain(|_, v| {
        v.retain(|at| t - at < 3_600_000);
        !v.is_empty()
    });
    let mine = tries.entry(serial.to_owned()).or_default();
    if mine.len() >= 10 {
        return false;
    }
    mine.push(t);
    true
}

/// A 3.9 refusal as the main port answers it: 409 or 403 with `code` (and `why`) beside `error`.
fn endorse_error(e: crate::fleet_trust::EndorseRefusal) -> E {
    let mut info = obj([("code", Value::from(e.code))]);
    if let Some(why) = e.why {
        info.insert("why".into(), Value::from(why));
    }
    match e.status {
        409 => E::ConflictInfo(e.error, info),
        403 => E::Held(e.error, info),
        s => E::Status(s, e.error, false),
    }
}

fn not_bootstrapping() -> E {
    endorse_error(crate::fleet_trust::EndorseRefusal { status: 409, code: crate::relay::NOT_BOOTSTRAPPING, why: None, error: crate::relay::NOT_BOOTSTRAPPING_WORDS.into() })
}

/// AC-2a 3.9 `GET /v1/admin/console/fleet-bootstrap?session=`: the first-roster entries of the caller's principal.
/// The device certificate was verified by the TLS layer (client_ca, CRL) and the denied set (`who`); the session is
/// checked by the route.
pub fn fleet_bootstrap(relay: &Relay, who: &Identity) -> R<Obj> {
    let Some(f) = relay.fleet.get() else { return Err(not_bootstrapping()) };
    let t = (pj::now() * 1000.0) as i64;
    match crate::fleet_trust::bootstrap_view(&f.state_dir, &who.principal, t) {
        Ok(Value::Object(o)) => Ok(o),
        Ok(_) => Err(E::Internal("fleet-bootstrap answered no object".into())),
        Err(e) => Err(endorse_error(e)),
    }
}

/// AC-2a 3.9 `POST /v1/admin/console/fleet-endorse {session, endorsement, proof}`: `proof` (base64) is the device
/// key's signature over `fleet_trust::endorse_signing_input(endorsement)`; the 3.9 checks are fleet_trust's.
pub fn fleet_endorse(relay: &Relay, who: &Identity, b: &Obj) -> R<Obj> {
    let Some(f) = relay.fleet.get() else { return Err(not_bootstrapping()) };
    let t = (pj::now() * 1000.0) as i64;
    if !endorse_try(&m::serial(&who.serial), t) {
        return Err(E::Status(429, "too many endorsement attempts from this device; try again within the hour".into(), false));
    }
    let endorsement = b.get("endorsement").cloned().unwrap_or(Value::Null);
    let proof = pj::b64_strict(&pj::s(b, "proof")).unwrap_or_default();
    let cert = crate::meet_x509::Cert::from_pem(&who.cert_pem);
    let key = cert.as_ref().and_then(|c| crate::der::p256_from_spki(&c.spki));
    let verify = |input: &[u8], sig: &[u8]| key.as_ref().is_some_and(|k| crate::der::ecdsa_verify(k, input, sig));
    let now_s = t.div_euclid(1000);
    let relay_admin = relay.settings.admins.iter().any(|a| a.trim().eq_ignore_ascii_case(&who.principal));
    let ctx = crate::fleet_trust::EndorseCtx {
        state_dir: &f.state_dir,
        product: Product::Meet,
        email: &who.principal,
        anchor: &who.device,
        chain_ok: cert.is_some(),
        in_date: cert.as_ref().is_some_and(|c| c.not_before <= now_s && now_s < c.not_after),
        revoked: relay.hub.is_denied(&who.serial),
        blocked: relay.hub.is_blocked(who),
        relay_admin,
        verify: &verify,
        proof: Some(&proof),
    };
    match crate::fleet_trust::endorse(&ctx, &endorsement, t) {
        Ok(Value::Object(o)) => Ok(o),
        Ok(_) => Err(E::Internal("fleet-endorse answered no object".into())),
        Err(e) => Err(endorse_error(e)),
    }
}

// ── the main port's 4.10 routes ──────────────────────────────────────────────────────────────────────────────

/// `GET /v1/admin/console/requests`: the waiting `meet.*` requests; `meet.console-invite` only to its principal.
/// AC-2a 5.7: from the headless book on an enrolled relay whose own console is off.
pub fn requests_for(relay: &Relay, principal: &str) -> Obj {
    let t = (pj::now() * 1000.0) as i64;
    let list: Vec<Value> = match request_book(relay) {
        None => Vec::new(),
        Some(c) => c
            .requests_waiting("meet.", t)
            .into_iter()
            .filter(|r| {
                // a console invite and the AI and API signing asks (AI-1 9, API-1 2.3) go only to the device of
                // their principal
                let kind = r.get("kind").and_then(Value::as_str).unwrap_or_default();
                let own = kind == "meet.console-invite" || kind.starts_with("meet.ai.") || kind.starts_with("meet.api.");
                !own || r.get("target").and_then(|x| x.get("principal")).and_then(Value::as_str) == Some(principal)
            })
            .collect(),
    };
    obj([("ok", Value::Bool(true)), ("requests", Value::Array(list))])
}

/// `POST /v1/admin/console/invite {session}`: a sign-in link for the caller's own principal (3.2), anchored to the
/// calling device certificate's serial.
pub fn device_invite(relay: &Relay, who: &Identity) -> R<Obj> {
    let Some(console) = relay.admin_console.get() else {
        // AC-2a 5.7: an enrolled relay with no local console sends people to the Lucid Admin Console.
        if let Some(origin) = relay.fleet.get().and_then(|f| (f.managed_by)()) {
            return Err(E::Conflict(managed_words(&origin)));
        }
        return Err(E::Conflict(CONSOLE_OFF.into()));
    };
    let t = (pj::now() * 1000.0) as i64;
    match console.invite_device(&who.principal, &m::serial(&who.serial), t) {
        Ok(i) => Ok(obj([("ok", Value::Bool(true)), ("link", Value::from(i.link)), ("email", Value::from(who.principal.clone())), ("expires", Value::from(i.expires))])),
        Err(r) if r.status == 429 => Err(E::Status(429, r.error, false)),
        Err(r) if r.status == 409 => Err(E::Conflict(r.error)),
        Err(r) if r.status == 403 => Err(E::Forbidden(r.error)),
        Err(r) => Err(E::Bad(r.error)),
    }
}

/// `POST /v1/admin/console/requests/decline {session, id, reason}`: closes the to-do; changes no certificate.
pub fn decline(relay: &Relay, by: &str, id: Option<&Value>, reason: Option<&Value>) -> R<Obj> {
    let id = id.and_then(Value::as_str).filter(|i| request_id_ok(i)).ok_or_else(|| E::Bad(DECLINE_ID.into()))?;
    let reason = reason.and_then(Value::as_str).map(clean).filter(|r| (1..=m::REASON_MAX).contains(&r.chars().count())).ok_or_else(|| E::Bad(DECLINE_REASON.into()))?;
    let Some(console) = relay.admin_console.get() else { return Err(E::NotFound(NO_REQUEST.into())) };
    let t = (pj::now() * 1000.0) as i64;
    match console.decline_request(id, by, &reason, t) {
        Ok(_) => Ok(obj([("ok", Value::Bool(true))])),
        Err(e) if e.status == 404 || e.code == "not-found" => Err(E::NotFound(NO_REQUEST.into())),
        Err(e) if e.status == 410 => Err(E::Gone(e.message)),
        Err(e) => Err(E::Status(e.status, e.message, false)),
    }
}

// ── the offline commands (3.2) ───────────────────────────────────────────────────────────────────────────────

const CLI_USAGE: &str = "usage: lucid-relay meet console (remove-admin <email> | unsuspend <email> | approve-join <email> [--role admin] | reset --first-admin <principal> | break-glass <email> [--replace] | two-person off) --config <relay.json>";

/// `lucid-relay meet console ...` with the relay stopped: the same commands as the Remote Spokes relay's, over
/// state_dir/console.json; `approve-join --role admin` also needs the email in relay.json `admins` and the passkey made
/// active anchored to a device of that principal (state.json directory). Audited with actor `operator` at the next
/// start (by the core console).
pub fn cli(argv: &[String]) -> ! {
    match cli_run(argv, &mut |prompt: &str| {
        use std::io::Write;
        print!("{prompt}");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        line.trim().to_string()
    }) {
        Ok(done) => {
            println!("{done}");
            std::process::exit(0)
        }
        Err(e) => {
            eprintln!("lucid-relay meet console: {e}");
            std::process::exit(if e == CLI_USAGE { 2 } else { 1 })
        }
    }
}

/// The parsed command, or the usage words.
pub fn cli_parse(argv: &[String]) -> Result<(crate::console_auth::Offline, String), String> {
    use crate::console_auth::Offline;
    let usage = || CLI_USAGE.to_string();
    let (mut config, mut role, mut first) = (None, None, None);
    let mut replace = false;
    let mut rest: Vec<&String> = Vec::new();
    let mut args = argv.iter();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--replace" => replace = true,
            "--config" => config = Some(args.next().cloned().ok_or_else(usage)?),
            "--role" => role = Some(args.next().cloned().ok_or_else(usage)?),
            "--first-admin" => first = Some(args.next().cloned().ok_or_else(usage)?),
            s if s.starts_with("--") => return Err(usage()),
            _ => rest.push(a),
        }
    }
    let config = config.ok_or_else(usage)?;
    let cmd = match (rest.first().map(|s| s.as_str()), rest.get(1)) {
        (Some("remove-admin"), Some(e)) if rest.len() == 2 && role.is_none() && first.is_none() => Offline::RemoveAdmin(e.trim().to_lowercase()),
        (Some("unsuspend"), Some(e)) if rest.len() == 2 && role.is_none() && first.is_none() => Offline::Unsuspend(e.trim().to_lowercase()),
        (Some("approve-join"), Some(e)) if rest.len() == 2 && first.is_none() => match role.as_deref() {
            None => Offline::ApproveJoin { email: e.trim().to_lowercase(), admin: false },
            Some("admin") => Offline::ApproveJoin { email: e.trim().to_lowercase(), admin: true },
            Some(_) => return Err(usage()),
        },
        (Some("reset"), None) if role.is_none() => match first {
            Some(f) if !f.trim().is_empty() => Offline::Reset { first_admin: f.trim().to_lowercase(), typed_host: String::new() },
            _ => return Err(usage()),
        },
        // revision 4: the break-glass account (3.3) and turning two-person control off (3.7)
        (Some("break-glass"), Some(e)) if rest.len() == 2 && role.is_none() && first.is_none() => Offline::BreakGlass { email: e.trim().to_lowercase(), replace, origin: None },
        (Some("two-person"), Some(off)) if off.as_str() == "off" && rest.len() == 2 && role.is_none() && first.is_none() && !replace => Offline::TwoPersonOff,
        _ => return Err(usage()),
    };
    if replace && !matches!(cmd, Offline::BreakGlass { .. }) {
        return Err(usage());
    }
    Ok((cmd, config))
}

/// The Meet rule of `approve-join --role admin`: the email is a relay admin and the anchor is one of that
/// principal's device serials in state.json.
pub fn admin_ok(admins: &[String], directory: &Obj, email: &str, anchor: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    if !admins.iter().any(|a| a.trim().to_lowercase() == email) {
        return Err(format!("{email} is not in relay.json admins: add them there first"));
    }
    // the break-glass account (anchor "operator", 3.3): admin rights without a device anchor; its principal must be
    // in relay.json admins
    if anchor == "operator" {
        return Ok(());
    }
    let anchor = m::serial(anchor);
    let serials: HashSet<String> = directory.get(&email).and_then(|e| e.get("devices")).and_then(Value::as_object).map(|d| d.values().map(|v| m::serial_of(v.get("serial"))).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    if anchor.is_empty() || !serials.contains(&anchor) {
        return Err(format!("{email} must first join from their own device in the Meeting Hub app"));
    }
    Ok(())
}

fn cli_run(argv: &[String], ask: &mut dyn FnMut(&str) -> String) -> Result<String, String> {
    use crate::console_auth::Offline;
    let (cmd, config) = cli_parse(argv)?;
    let s = m::Settings::load(&config)?;
    if s.state_dir.is_empty() {
        return Err("relay.json has no state_dir".into());
    }
    let host = crate::meet_console_port::host_of(&s.console_public);
    let cmd = match cmd {
        Offline::Reset { first_admin, .. } => {
            if !s.admins.iter().any(|a| a.trim().to_lowercase() == first_admin) {
                return Err(crate::meet_console_port::FIRST_ADMIN.into());
            }
            let typed = ask(&format!("This clears every person, passkey, invite and approval of the Admin Console. Type the relay's host name ({host}) to go on: "));
            Offline::Reset { first_admin, typed_host: typed }
        }
        other => other,
    };
    let directory: Obj = std::fs::read(Path::new(&s.state_dir).join("state.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .and_then(|v| v.get("directory").and_then(Value::as_object).cloned())
        .unwrap_or_default();
    let admins = s.admins.clone();
    crate::console_auth::run_offline(Path::new(&s.state_dir), cmd, &host, &|email: &str, anchor: &str| admin_ok(&admins, &directory, email, anchor))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        // A folder per call: tests running at the same instant never share one (or its console.lock).
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("lucid-console-meet-{}-{}-{n}", std::process::id(), pj::mono().to_bits()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const T0: i64 = 1_763_300_000_000;

    /// MR-1 2.4 (review 7): a standby takes no change from the console, an approved action or the fleet link's api ops,
    /// but the cluster role commands and its own CRL and clock.
    #[test]
    fn mr1_a_standby_takes_no_console_or_fleet_writes() {
        use crate::fleet_agent::ApiHooks;
        let state = temp_dir();
        let cfg = crate::meet_cluster::parse(&json!({"id": "emertins-meet", "node": "azure", "role": "standby",
            "peer": {"node": "lab", "url": "https://meet.emertins.com", "spki_sha256": crate::codec::b64u(&[4u8; 32])},
            "client_cert": "/c.crt", "client_key": "/c.key"}))
        .unwrap();
        let relay = m::test_relay(m::Settings { state_dir: state.display().to_string(), ..m::Settings::default() });
        assert!(cluster_write_guard(&relay, "meet/seats/pick").is_ok(), "a single relay takes everything");
        relay.hub.set_cluster(crate::meet_cluster::Cluster::open(&cfg, &state).unwrap());
        assert_eq!(relay.hub.cluster_writes(), Err(("standby", crate::meet_cluster::STANDBY_WORDS)));
        for refused in ["meet/seats/pick", "meet/organizations", "meet/block", "meet.release.set", "meet.holds.place"] {
            assert_eq!(cluster_write_guard(&relay, refused).unwrap_err().code, "stale", "{refused}");
        }
        for allowed in ["meet/cluster/promote", "meet/cluster/handover", "meet/crl", "meet.crl", "meet/clock/confirm"] {
            assert!(cluster_write_guard(&relay, allowed).is_ok(), "{allowed}");
        }
        let fleet = m::MeetFleet::new(&relay);
        for op in ["api-map", "api-tighten", "api-hold"] {
            let refused = fleet.api_request(op, &json!({"org": "acme"})).unwrap().unwrap_err();
            assert_eq!((refused.status, refused.code.as_str()), (503, "standby"), "{op}");
        }
    }

    #[test]
    fn routes_declare_roles_and_security_actions() {
        for r in &ROUTES {
            assert!(matches!(r.role, Role::Viewer | Role::Manager | Role::Admin), "{}", r.path);
            // every write needs a step-up except "Request more seats" (4.9: body `{wanted}`, no stepup) and the r6 8.11
            // MCP rows without one (turning off and testing)
            let no_stepup = matches!(r.path, "meet/seats/request" | "meet/ai/mcp/servers/off" | "meet/ai/mcp/off" | "meet/ai/mcp/test");
            assert_eq!(r.stepup, r.method == "POST" && !no_stepup, "{}", r.path);
            assert_eq!(r.action.is_empty(), r.method == "GET", "{}", r.path);
            assert!(r.path.starts_with("meet/"), "{}", r.path);
            if r.security {
                assert!(SECURITY_ACTIONS.contains(&r.action), "{}", r.path);
                assert!(matches!(r.need, Need::Any), "{}", r.path);
            }
        }
        // viewers read only calls, the release and the Tools (MCP) state (r6 8.11)
        let viewer: Vec<&str> = ROUTES.iter().filter(|r| r.role == Role::Viewer).map(|r| r.path).collect();
        assert_eq!(viewer, vec!["meet/release", "meet/calls", "meet/ai/mcp"]);
        // user managers read people and seats and pick seats, nothing else (4.9, R4-8)
        let manager: Vec<(&str, &str)> = ROUTES.iter().filter(|r| r.role == Role::Manager).map(|r| (r.method, r.path)).collect();
        assert_eq!(manager, vec![("GET", "meet/people"), ("GET", "meet/seats"), ("POST", "meet/seats/pick")]);
        // seats and the relay's time work in every license state (2.4)
        for r in ROUTES.iter().filter(|r| r.path.starts_with("meet/seats") || r.path.starts_with("meet/clock")) {
            assert!(matches!(r.need, Need::Any), "{}", r.path);
        }
        assert_eq!(ROUTES.iter().find(|r| r.path == "meet/release" && r.method == "POST").unwrap().body_max, 32 * 1024);
    }

    #[test]
    fn blocks_time_accounting_and_admin_devices() {
        let mut b = MeetBlocks::open(&temp_dir().join(BLOCKS_FILE)).unwrap();
        // a relay admin's device is always an approval
        assert!(!b.single_ok("ann@x.org", "aaaa", 1, true, T0));
        assert!(b.single_ok("bob@x.org", "bbbb", 20, false, T0));
        b.place("bob@x.org", "bbbb", 20, "lost", "ann@x.org", true, T0).unwrap();
        assert_eq!(b.mirror(T0 + 1).get("bob@x.org|bbbb").copied(), Some((T0 + 20 * HOUR_MS) as f64 / 1000.0));
        // 20 + 5 hours in 7 days is past 24: an approval; 4 more is fine
        assert!(!b.single_ok("bob@x.org", "bbbb", 5, false, T0 + HOUR_MS));
        assert!(b.single_ok("bob@x.org", "bbbb", 4, false, T0 + HOUR_MS));
        // lifting counts the time only up to now
        b.lift("bob@x.org", "bbbb", T0 + 2 * HOUR_MS).unwrap();
        assert_eq!(b.single_admin_ms("bob@x.org|bbbb", T0 + 2 * HOUR_MS), 2 * HOUR_MS);
        assert!(b.mirror(T0 + 2 * HOUR_MS).is_empty());
        // 8 days later the window is clear
        assert!(b.single_ok("bob@x.org", "bbbb", 24, false, T0 + 8 * 24 * HOUR_MS));
    }

    #[test]
    fn blocks_persist_and_fail_closed() {
        let dir = temp_dir();
        let file = dir.join(BLOCKS_FILE);
        let mut b = MeetBlocks::open(&file).unwrap();
        b.place("bob@x.org", "bbbb", 2, "lost", "ann@x.org", false, T0).unwrap();
        b.set_hold_path("h1", true);
        let again = MeetBlocks::open(&file).unwrap();
        assert_eq!(again.get("bob@x.org", "bbbb", T0 + 1).map(|b| b.placed_by.clone()), Some("ann@x.org".into()));
        assert_eq!(again.hold_path("h1"), "single");
        assert_eq!(again.hold_path("other"), "approved");
        // expiry at until
        assert!(again.get("bob@x.org", "bbbb", T0 + 2 * HOUR_MS).is_none());
        std::fs::write(&file, "{not json").unwrap();
        assert!(MeetBlocks::open(&file).is_err());
    }

    #[test]
    fn block_bodies() {
        assert!(parse_block(&json!({"principal": "Bob@X.org", "device": "bbbb", "hours": 720, "reason": "lost"})).is_ok());
        assert!(parse_block(&json!({"principal": "bob@x.org", "device": "bbbb", "hours": 721, "reason": "lost"})).is_err());
        assert!(parse_block(&json!({"principal": "bob@x.org", "device": "bbbb", "hours": 0, "reason": "lost"})).is_err());
        assert!(parse_block(&json!({"principal": "bob@x.org", "device": "", "hours": 1, "reason": "lost"})).is_err());
        assert!(parse_block(&json!({"principal": "bob@x.org", "device": "bbbb", "hours": 1, "reason": ""})).is_err());
    }

    #[test]
    fn request_ids_and_targets() {
        assert!(request_id_ok("rq_0123456789abcdef"));
        assert!(!request_id_ok("rq_0123456789ABCDEF"));
        assert!(!request_id_ok("rq_0123"));
        assert!(!request_id_ok("ap_0123456789abcdef"));
        let csr = "a".repeat(64);
        assert_eq!(MeetSection::check_target("meet.approve", &json!({"kind": "enroll", "id": "5f", "csr_sha256": csr, "decision": "approve"})).unwrap()["kind"], "enroll");
        assert!(MeetSection::check_target("meet.approve", &json!({"kind": "enroll", "id": "5f", "csr_sha256": "x", "decision": "approve"})).is_err());
        assert_eq!(MeetSection::check_target("meet.approve", &json!({"kind": "enroll", "id": "5f", "csr_sha256": csr, "decision": "approve", "x": 1})).unwrap_err().code, "unknown-field");
        assert_eq!(MeetSection::check_target("meet.revoke", &json!({"principal": "Bob@x.org", "device": "bbbb"})).unwrap(), json!({"principal": "bob@x.org", "device": "bbbb"}));
        assert!(MeetSection::check_target("meet.invite", &json!({"name": "Bob", "email": "bob@x.org", "days": 7})).is_ok());
        assert!(MeetSection::check_target("meet.invite", &json!({"name": "Bob", "email": "bob@x.org", "days": 0})).is_err());
        assert!(MeetSection::check_target("rs.revoke", &json!({})).is_err());
    }

    #[test]
    fn query_filters() {
        assert_eq!(filters("q=bob&limit=5", &["q", "limit"]).unwrap().get("q").map(String::as_str), Some("bob"));
        assert_eq!(filters("x=1", &["q"]).unwrap_err().message, "Unknown filter: x.");
        assert!(search_text(&filters("q=b", &["q"]).unwrap()).is_err());
    }

    #[test]
    fn offline_commands_parse() {
        use crate::console_auth::Offline;
        let args = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        assert!(matches!(cli_parse(&args("remove-admin a@x.org --config r.json")).unwrap().0, Offline::RemoveAdmin(e) if e == "a@x.org"));
        assert!(matches!(cli_parse(&args("unsuspend A@x.org --config r.json")).unwrap().0, Offline::Unsuspend(e) if e == "a@x.org"));
        assert!(matches!(cli_parse(&args("approve-join a@x.org --role admin --config r.json")).unwrap().0, Offline::ApproveJoin { admin: true, .. }));
        assert!(matches!(cli_parse(&args("approve-join a@x.org --config r.json")).unwrap().0, Offline::ApproveJoin { admin: false, .. }));
        assert!(matches!(cli_parse(&args("reset --first-admin a@x.org --config r.json")).unwrap().0, Offline::Reset { .. }));
        // reset is refused without --first-admin, and every command needs --config
        assert_eq!(cli_parse(&args("reset --config r.json")).err().as_deref(), Some(CLI_USAGE));
        assert_eq!(cli_parse(&args("remove-admin a@x.org")).err().as_deref(), Some(CLI_USAGE));
        assert_eq!(cli_parse(&args("approve-join a@x.org --role owner --config r.json")).err().as_deref(), Some(CLI_USAGE));
    }

    #[test]
    fn approve_join_admin_needs_a_relay_admin_and_a_device_anchor() {
        let directory: Obj = json!({"ann@x.org": {"devices": {"aaaa": {"serial": "5F3A"}}}}).as_object().unwrap().clone();
        let admins = vec!["ann@x.org".to_string()];
        assert_eq!(admin_ok(&admins, &directory, "ann@x.org", "5f3a"), Ok(()));
        assert!(admin_ok(&admins, &directory, "ann@x.org", "console").is_err());
        assert!(admin_ok(&admins, &directory, "ann@x.org", "77").is_err());
        assert!(admin_ok(&admins, &directory, "bob@x.org", "5f3a").unwrap_err().contains("not in relay.json admins"));
    }

    // ── a fixture relay ──

    fn fixture(admins: &[&str]) -> (Arc<Relay>, MeetSection) {
        fixture_at(admins, T0)
    }

    /// A fixture relay whose service gate runs on a fake clock at `now` (milliseconds).
    fn fixture_at(admins: &[&str], now: i64) -> (Arc<Relay>, MeetSection) {
        use crate::meet_console_port::tests::{self_signed, temp};
        let dir = temp_dir();
        let (cert, key) = self_signed("relay.example.org");
        let admins: Vec<String> = admins.iter().map(|a| a.to_string()).collect();
        let s = m::Settings { state_dir: dir.to_string_lossy().into_owned(), admins: admins.clone(), console_cert: temp("c.crt", &cert), console_key: temp("c.key", &key), ..m::Settings::default() };
        let tls = crate::meet_tls::console_tls_config(&s).unwrap();
        let links = Arc::new(crate::meet_console::LinkStats::new());
        let hub = Arc::new(crate::meet_hub::Hub::new(Some(dir.clone()), &admins, 168.0, 30.0, 365.0, None, links.clone()));
        let console = crate::meet_console::Console::new(&s, links).unwrap();
        let relay = Arc::new(Relay {
            settings: s,
            hub,
            tls: parking_lot::RwLock::new(tls),
            files: Mutex::new(()),
            refusals: crate::meet_tls::RefusalLog::new(),
            outdated_logged: Mutex::new(HashMap::new()),
            console,
            turn_secret: vec![7; 16],
            last_fetch: Mutex::new(-1e9),
            last_check: Mutex::new(-1e9),
            pc_last_crl_check: Mutex::new(-1e9),
            admin_console: std::sync::OnceLock::new(),
            fleet: std::sync::OnceLock::new(),
        });
        let cfg = crate::meet_license::GateConfig { state_dir: Some(dir.clone()), license_file: Some(dir.join(crate::meet_license::LICENSE_FILE)), client_ca: dir.join("client_ca.pem"), audit_by_deploy: false };
        let gate = MeetGate::open(cfg, &relay.hub, crate::meet_time::testclock::FakeClock::new(now)).unwrap();
        relay.hub.set_gate(gate);
        let section = MeetSection::new(Arc::downgrade(&relay), MeetBlocks::open(&dir.join(BLOCKS_FILE)).unwrap(), T0);
        (relay, section)
    }

    fn spec(method: &str, path: &str) -> &'static RouteSpec {
        ROUTES.iter().find(|r| r.method == method && r.path == path).unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn call(section: &MeetSection, method: &str, path: &str, query: &str, body: Value, email: &str, admin: bool, license: LicenseState, t: i64) -> Result<SectionAnswer, ApiError> {
        let caller = crate::console::Caller { email: email.into(), admin, manager: admin, ip: "10.0.0.1".into() };
        let c = SectionCall { spec: spec(method, path), query, body: &body, caller: &caller, license, t };
        section.route(&c)
    }

    fn device(relay: &Relay, principal: &str, device: &str, serial: &str) {
        relay.hub.st.lock().directory.insert(principal.into(), json!({"name": principal.to_uppercase(), "devices": {device: {"serial": serial, "label": "Laptop"}}}));
    }

    #[test]
    fn console_identity_is_a_principal_and_no_device() {
        let (relay, _) = fixture(&["ann@x.org"]);
        let who = relay.hub.check_console_admin("Ann@X.org").unwrap();
        assert_eq!((who.kind.as_str(), who.principal.as_str(), who.device.as_str(), who.serial.as_str()), ("console", "ann@x.org", "", ""));
        assert!(!who.guest && !who.seed && !who.is_service() && !who.own_device() && who.cert_pem.is_empty());
        // the same rule as check_admin: only a principal in relay.json admins
        assert_eq!(relay.hub.check_console_admin("bob@x.org").unwrap_err().message(), "only the person who issues certificates can do that");
        // the I8 functions take it without a presence session
        assert!(relay.hub.admin_devices("", &who).is_ok());
        assert!(relay.hub.admin_organizations("", &who).is_ok());
        assert!(relay.hub.admin_pending("", &who).is_ok());
        assert!(relay.hub.bridge_admin("", &who).is_ok());
        assert!(relay.hub.pc_holds_list("", &who).is_ok());
        // and nothing takes it for a device: no block, no own device, never presence
        assert!(!relay.hub.is_blocked(&who));
        // a certificate can never carry the console kind (the retired console server's certificate is refused)
        assert_eq!(crate::meet::CONSOLE_RETIRED, "this is the retired console's certificate; the relay no longer accepts it");
    }

    #[test]
    fn admin_role_only_through_a_device_anchored_passkey() {
        let (relay, section) = fixture(&["ann@x.org"]);
        device(&relay, "ann@x.org", "aaaaaaaaaaaaaaaa", "5F3A");
        assert!(matches!(section.admin_rule("ann@x.org", "5f3a"), AdminRule::Admin));
        assert!(matches!(section.admin_rule("ann@x.org", "console"), AdminRule::ViewerOnly));
        assert!(matches!(section.admin_rule("ann@x.org", "77"), AdminRule::ViewerOnly));
        assert!(matches!(section.admin_rule("bob@x.org", "5f3a"), AdminRule::NotRelayAdmin));
        // approvers of Meet actions must be relay admins too
        assert!(section.may_approve("meet.block", &json!({}), "ann@x.org"));
        assert!(!section.may_approve("meet.block", &json!({}), "bob@x.org"));
        // a people hold needs an approver who meets the org_admins rule (no signer policy here: nobody does)
        assert!(!section.may_approve("meet.holds.place", &json!({"on": "people", "principals": ["c@x.org"]}), "ann@x.org"));
    }

    #[test]
    fn blocks_refuse_at_who_close_sessions_and_never_revoke() {
        let (relay, section) = fixture(&["ann@x.org"]);
        device(&relay, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        device(&relay, "ann@x.org", "aaaaaaaaaaaaaaaa", "5f3a");
        // the hub judges a block at `who` against its own clock, so the blocks are placed now (a fixed T0 in the
        // past made every block already over: the baseline failure)
        let now = (pj::now() * 1000.0) as i64;
        let body = json!({"principal": "bob@x.org", "device": "bbbbbbbbbbbbbbbb", "hours": 4, "reason": "lost laptop"});
        let done = call(&section, "POST", "meet/block", "", body, "ann@x.org", true, LicenseState::None, now).unwrap();
        assert!(matches!(done, SectionAnswer::Done { .. }));
        let bob = Identity { principal: "bob@x.org".into(), device: "bbbbbbbbbbbbbbbb".into(), serial: "77".into(), kind: "person".into(), ..Default::default() };
        assert!(relay.hub.is_blocked(&bob));
        assert!(!relay.hub.is_denied("77"), "a block is never a revocation");
        // a relay admin's device is always an approval
        let admin = json!({"principal": "ann@x.org", "device": "aaaaaaaaaaaaaaaa", "hours": 1, "reason": "test"});
        assert!(matches!(call(&section, "POST", "meet/block", "", admin, "ann@x.org", true, LicenseState::None, now).unwrap(), SectionAnswer::Second { .. }));
        // past 24 hours in 7 days: an approval
        let more = json!({"principal": "bob@x.org", "device": "bbbbbbbbbbbbbbbb", "hours": 21, "reason": "again"});
        assert!(matches!(call(&section, "POST", "meet/block", "", more, "ann@x.org", true, LicenseState::None, now + 1).unwrap(), SectionAnswer::Second { .. }));
        // the placer lifts alone
        let lift = json!({"principal": "bob@x.org", "device": "bbbbbbbbbbbbbbbb", "reason": "found"});
        assert!(matches!(call(&section, "POST", "meet/unblock", "", lift, "ann@x.org", true, LicenseState::None, now + 2).unwrap(), SectionAnswer::Done { .. }));
        assert!(!relay.hub.is_blocked(&bob));
    }

    fn release(version: &str, minimum: &str) -> Value {
        json!({"version": version, "files": {"windows": {"name": "LucidMeetingHub.exe", "sha256": "a".repeat(64), "size": 1000}}, "notes": "", "minimum": {"hub": minimum}, "reason": "release"})
    }

    #[test]
    fn release_minimum_rules() {
        let (_relay, section) = fixture(&["ann@x.org", "bob@x.org"]);
        let post = |body: Value| call(&section, "POST", "meet/release", "", body, "ann@x.org", true, LicenseState::Valid, T0);
        let approved = |body: &Value| section.execute(&Approved { action: "meet.release.set", target: "-", params: body, requested_by: "ann@x.org", approved_by: Some("bob@x.org"), t: T0 }).unwrap();
        // a minimum above the release itself is refused
        assert_eq!(post(release("1.0.0", "2.0.0")).err().unwrap().message, crate::meet_ops::RELEASE_MINIMUM_TOO_NEW);
        // the first minimum is a raise: an approval
        assert!(matches!(post(release("1.0.0", "0.9.0")).unwrap(), SectionAnswer::Second { .. }));
        approved(&release("1.0.0", "0.9.0"));
        // every minimum the same: one admin
        assert!(matches!(post(release("1.0.1", "0.9.0")).unwrap(), SectionAnswer::Done { .. }));
        // lowering: an approval, then raising back to the value it replaced within 24 h: one admin
        assert!(matches!(post(release("1.0.2", "0.8.0")).unwrap(), SectionAnswer::Second { .. }));
        approved(&release("1.0.2", "0.8.0"));
        assert!(matches!(post(release("1.0.3", "0.9.0")).unwrap(), SectionAnswer::Done { .. }));
        // raising in any other way, or going back down after a raise, needs a second admin
        assert!(matches!(post(release("1.0.4", "1.0.0")).unwrap(), SectionAnswer::Second { .. }));
        assert!(matches!(post(release("1.0.4", "0.8.0")).unwrap(), SectionAnswer::Second { .. }));
        // the history the page shows
        let view = call(&section, "GET", "meet/release", "", Value::Null, "ann@x.org", false, LicenseState::Valid, T0).unwrap();
        let SectionAnswer::Read(v) = view else { panic!() };
        assert_eq!(v["history"].as_array().unwrap().len(), 4);
        assert_eq!(v["history"][0]["version"], "1.0.3");
        assert!(v["history"][0]["until"].is_null());
    }

    /// TH-1 6: the brand is validated, written where the guest and web ports read it (with `by` and `updated` from the
    /// console, never the body), its logo comes as base64 JSON, reset works in every license state, and a standby
    /// takes no brand.
    #[test]
    fn console_meet_brand_set_logo_reset_and_standby_refusal() {
        use crate::meet_brand::{port_read, Answer};
        let (relay, section) = fixture(&["ann@x.org"]);
        let dir = PathBuf::from(&relay.settings.state_dir);
        let post = |path: &str, body: Value, license: LicenseState| call(&section, "POST", path, "", body, "ann@x.org", true, license, T0);
        // refused with words, nothing written: a weak accent, a missing reason, a logo before a brand
        assert_eq!(post("meet/brand", json!({"name": "Contoso", "accent": "#777777", "reason": "brand"}), LicenseState::Valid).err().unwrap().code, "invalid");
        assert_eq!(post("meet/brand", json!({"name": "Contoso", "accent": "#0f6cbd"}), LicenseState::Valid).err().unwrap().code, "invalid");
        let logo = crate::meet_brand::tests::png(128, 96);
        let logo_body = json!({"type": "image/png", "data": crate::meet_json::b64(&logo)});
        assert_eq!(post("meet/brand/logo", logo_body.clone(), LicenseState::Valid).err().unwrap().code, "invalid");
        assert!(!dir.join("brand.json").exists() && !dir.join("brand-logo").exists());
        let set = json!({"name": "Contoso", "accent": "#0f6cbd", "mode": "dark", "welcome": "Welcome to Contoso.", "support": "mailto:help@contoso.example", "reason": "brand"});
        let SectionAnswer::Done { answer, detail, .. } = post("meet/brand", set, LicenseState::Valid).unwrap() else { panic!("not done") };
        assert_eq!((answer["brand"]["by"].as_str(), answer["brand"]["updated"].as_i64()), (Some("ann@x.org"), Some(T0)));
        assert_eq!(detail["accent"], "#0f6cbd");
        assert!(matches!(post("meet/brand/logo", logo_body, LicenseState::Valid).unwrap(), SectionAnswer::Done { .. }));
        assert_eq!(std::fs::read(dir.join("brand-logo")).unwrap(), logo);
        // an SVG called a PNG is refused and the stored logo stays
        let svg = json!({"type": "image/png", "data": crate::meet_json::b64(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>")});
        assert_eq!(post("meet/brand/logo", svg, LicenseState::Valid).err().unwrap().code, "invalid");
        assert_eq!(std::fs::read(dir.join("brand-logo")).unwrap(), logo);
        // what the guest port answers, and the console's view (readable in every license state)
        let Some(Answer::Json(public)) = port_read(&relay.settings.state_dir, "/g/", "GET", "/g/v1/brand", "") else { panic!("no read") };
        assert_eq!((public["brand"]["mode"].as_str(), public["brand"]["onAccent"].as_str()), (Some("dark"), Some("#ffffff")));
        assert!(public["brand"]["logo"].as_str().is_some_and(|l| l.starts_with("/g/brand/logo?v=")));
        let SectionAnswer::Read(view) = call(&section, "GET", "meet/brand", "", Value::Null, "ann@x.org", true, LicenseState::None, T0).unwrap() else { panic!("not a read") };
        assert_eq!((view["brand"]["by"].as_str(), view["brand"]["logo"]["w"].as_u64()), (Some("ann@x.org"), Some(128)));
        // back to the standard theme, without a license
        assert!(matches!(post("meet/brand/reset", json!({"reason": "back to Lucid"}), LicenseState::None).unwrap(), SectionAnswer::Done { .. }));
        assert!(!dir.join("brand.json").exists() && !dir.join("brand-logo").exists());
        assert_eq!(port_read(&relay.settings.state_dir, "/w/", "GET", "/w/v1/brand", ""), Some(Answer::Json(json!({"brand": null}))));
        // MR-1: a standby takes no brand
        let cfg = crate::meet_cluster::parse(&json!({"id": "emertins-meet", "node": "azure", "role": "standby",
            "peer": {"node": "lab", "url": "https://meet.emertins.com", "spki_sha256": crate::codec::b64u(&[4u8; 32])},
            "client_cert": "/c.crt", "client_key": "/c.key"}))
        .unwrap();
        relay.hub.set_cluster(crate::meet_cluster::Cluster::open(&cfg, &dir).unwrap());
        for (path, body) in [("meet/brand", json!({"name": "Contoso", "accent": "#0f6cbd", "reason": "x"})), ("meet/brand/reset", json!({"reason": "x"}))] {
            assert_eq!(post(path, body, LicenseState::Valid).err().unwrap().code, "stale", "{path}");
        }
        assert!(!dir.join("brand.json").exists());
    }

    #[test]
    fn a_replacement_license_is_compared_with_the_last_license() {
        // R6-M1, with the development-signed fixtures (test keys only)
        let v: Value = serde_json::from_str(include_str!("../tests/license-v2-products.json")).unwrap();
        let _ = crate::meet_license::TEST_DEV_PUB.set(v["devPub"].as_str().unwrap().to_owned());
        let token = |name: &str| v["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()["token"].as_str().unwrap().to_owned();
        let (a, b) = (token("Meeting Hub, root A"), token("Meeting Hub, root B"));
        let (relay, section) = fixture_at(&["ann@x.org", "bob@x.org"], v["now"].as_i64().unwrap() * 1000);
        let dir = PathBuf::from(&relay.settings.state_dir);
        std::fs::write(dir.join("client_ca.pem"), v["clientCas"][2]["pem"].as_str().unwrap()).unwrap();
        // lastLicense null: any fitting license is a first license (one admin)
        let first = section.license_candidate(&a, 0).unwrap();
        assert!(first.reference.is_none() && first.single());
        section.license_install(&a, 0).unwrap();
        // the 500-user license is removed by hand: the 20-user one is still compared with it (a second admin)
        std::fs::remove_file(dir.join(crate::meet_license::LICENSE_FILE)).unwrap();
        relay.hub.gate().unwrap().check(true);
        let smaller = section.license_candidate(&b, 0).unwrap();
        let reference = smaller.reference.clone().unwrap();
        assert_eq!((reference.users, reference.id.as_str(), reference.edition.as_str(), reference.relays), (500, "l_00000000000000b1", "enterprise", 2));
        assert!(!smaller.single(), "fewer users (and another root and edition) than the last license");
        // with the 500-user license in force, it is the reference too
        section.license_install(&a, 0).unwrap();
        assert_eq!(section.license_candidate(&b, 0).unwrap().reference.unwrap().users, 500);
    }

    #[test]
    fn bridge_holds_and_organizations_follow_the_two_admin_rules() {
        let (relay, section) = fixture(&["ann@x.org", "bob@x.org"]);
        let on = json!({"org": "acme", "policy": {"enabled": true}, "reason": "partners"});
        assert_eq!(call(&section, "POST", "meet/bridge", "", on.clone(), "ann@x.org", true, LicenseState::None, T0).err().unwrap().code, "license-needed");
        assert!(matches!(call(&section, "POST", "meet/bridge", "", on, "ann@x.org", true, LicenseState::Valid, T0).unwrap(), SectionAnswer::Second { .. }));
        // a hold on more than 10 conversations waits for a second admin; up to 10 runs at once (holds are off here)
        let cids: Vec<String> = (0..11).map(|i| format!("dm:{}", format!("{i:x}").repeat(64).chars().take(64).collect::<String>())).collect();
        let big = json!({"on": "conversations", "cids": cids, "reason": "litigation"});
        assert!(matches!(call(&section, "POST", "meet/holds", "", big, "ann@x.org", true, LicenseState::None, T0).unwrap(), SectionAnswer::Second { .. }));
        let small = json!({"on": "conversations", "cids": [format!("dm:{}", "a".repeat(64))], "reason": "litigation"});
        assert_eq!(call(&section, "POST", "meet/holds", "", small, "ann@x.org", true, LicenseState::None, T0).err().unwrap().code, "stale");
        // a people hold by someone who is not that org's admin is refused before it waits
        let people = json!({"on": "people", "principals": ["c@x.org"], "reason": "litigation"});
        assert_eq!(call(&section, "POST", "meet/holds", "", people, "ann@x.org", true, LicenseState::None, T0).err().unwrap().code, "role");
        // removing someone from an organization is always two-admin
        let remove = json!({"principal": "c@x.org", "remove": true, "reason": "left"});
        assert!(matches!(call(&section, "POST", "meet/organizations", "", remove, "ann@x.org", true, LicenseState::Valid, T0).unwrap(), SectionAnswer::Second { .. }));
        // moving someone with no organization into one with no bridge on and no org_admins is one admin
        let put = json!({"principal": "c@x.org", "id": "acme", "label": "Acme", "reason": "joined"});
        device(&relay, "c@x.org", "cccccccccccccccc", "c1");
        assert!(matches!(call(&section, "POST", "meet/organizations", "", put, "ann@x.org", true, LicenseState::Valid, T0).unwrap(), SectionAnswer::Done { .. }));
        // moving them again is two-admin
        let again = json!({"principal": "c@x.org", "id": "other", "label": "Other", "reason": "moved"});
        assert!(matches!(call(&section, "POST", "meet/organizations", "", again, "ann@x.org", true, LicenseState::Valid, T0).unwrap(), SectionAnswer::Second { .. }));
    }

    #[test]
    fn views_answer_and_viewers_get_no_people() {
        let (relay, section) = fixture(&["ann@x.org"]);
        device(&relay, "bob@x.org", "bbbbbbbbbbbbbbbb", "77");
        let read = |path: &str, query: &str, admin: bool| match call(&section, "GET", path, query, Value::Null, "ann@x.org", admin, LicenseState::Valid, T0) {
            Ok(SectionAnswer::Read(v)) => v,
            other => panic!("{path}: {:?}", other.err()),
        };
        let people = read("meet/people", "q=bob", true);
        assert_eq!(people["people"][0]["principal"], "bob@x.org");
        assert_eq!(people["seats"]["used"], 1);
        assert!(call(&section, "GET", "meet/people", "nope=1", Value::Null, "ann@x.org", true, LicenseState::Valid, T0).is_err());
        assert_eq!(read("meet/identity", "", true), json!({"ok": true, "available": false}));
        assert_eq!(read("meet/enrollments", "", true)["waiting"], json!([]));
        assert_eq!(read("meet/push", "", true)["enabled"], false);
        assert!(read("meet/servers", "", true)["files"].is_null());
        // No certificate server configured: no signer to call unhealthy (the fleet health would read it as a problem).
        assert!(read("meet/servers", "", true)["signer"].is_null());
        assert_eq!(read("meet/organizations", "", true)["organizations"], json!([]));
        let calls = read("meet/calls", "", false);
        assert!(!calls.to_string().contains('@'), "viewers see no principals");
        // reads need a license in some state (2.4): none locks the section
        assert_eq!(call(&section, "GET", "meet/people", "", Value::Null, "ann@x.org", true, LicenseState::None, T0).err().unwrap().code, "license-needed");
        assert_eq!(section.sections(LicenseState::None), LOCKED_PAGES.to_vec());
        assert_eq!(section.sections(LicenseState::Expired), PAGES.to_vec());
    }

    #[test]
    fn main_port_routes_with_the_console_off() {
        let (relay, _) = fixture(&["ann@x.org"]);
        let ann = Identity { principal: "ann@x.org".into(), device: "aaaaaaaaaaaaaaaa".into(), serial: "5f3a".into(), kind: "person".into(), ..Default::default() };
        assert_eq!(device_invite(&relay, &ann).unwrap_err().message(), CONSOLE_OFF);
        assert_eq!(requests_for(&relay, "ann@x.org"), obj([("ok", Value::Bool(true)), ("requests", json!([]))]));
        assert_eq!(decline(&relay, "ann@x.org", Some(&json!("rq_1")), Some(&json!("no"))).unwrap_err().message(), DECLINE_ID);
        assert_eq!(decline(&relay, "ann@x.org", Some(&json!("rq_0123456789abcdef")), Some(&json!(" "))).unwrap_err().message(), DECLINE_REASON);
        assert_eq!(decline(&relay, "ann@x.org", Some(&json!("rq_0123456789abcdef")), Some(&json!("x".repeat(501)))).unwrap_err().message(), DECLINE_REASON);
        assert_eq!(decline(&relay, "ann@x.org", Some(&json!("rq_0123456789abcdef")), Some(&json!("done already"))).unwrap_err().message(), NO_REQUEST);
    }

    #[test]
    fn push_counters_count_the_last_day() {
        let (before, _) = push::apns::counts();
        push::apns::note(None);
        push::apns::note(Some("410"));
        let (after, failed) = push::apns::counts();
        assert!(after > before);
        assert!(failed.get("410").copied().unwrap_or(0) >= 1);
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("console_meet.rs");
        for c in [char::from_u32(0x2014).unwrap(), char::from_u32(0x2013).unwrap()] {
            assert!(!src.contains(c));
        }
        for w in [CONSOLE_OFF, CONSOLE_REQUEST_FIELD, DECLINE_ID, DECLINE_REASON, NO_REQUEST] {
            assert!(!w.contains(char::from_u32(0x2014).unwrap()) && !w.contains(char::from_u32(0x2013).unwrap()));
        }
    }

    fn headless(dir: &Path) -> Arc<Console> {
        crate::console::open_headless(Product::Meet, dir, Arc::new(crate::log::Logger::capture("t", Box::new(|_, _| {})))).unwrap()
    }

    fn enroll(relay: &Relay, book: Arc<Console>) {
        let dir = PathBuf::from(&relay.settings.state_dir);
        // Ann is an active roster admin: on an enrolled relay only roster admins read the headless book's requests
        let _ = relay.fleet.set(crate::relay::FleetLink { managed_by: Box::new(|| Some("https://console.example.com".into())), book, admins: Box::new(|| vec!["ann@x.org".to_owned()]), state_dir: dir });
    }

    /// AC-2a 16.1 f-relay: `where` on a Meeting Hub relay with neither console, enrolled with its own console off,
    /// and the 409 invite words on that relay; requests from the headless book.
    #[test]
    fn ac2a_where_invite_words_and_requests_on_an_enrolled_relay() {
        let (relay, _) = fixture(&["ann@x.org"]);
        assert_eq!(Value::Object(console_where(&relay)), json!({"ok": true, "local": false, "managedBy": null}));
        let ann = Identity { principal: "ann@x.org".into(), serial: "5a".into(), device: "aaaaaaaaaaaaaaaa".into(), ..Default::default() };
        // neither: AC-1's console-off answer
        assert!(matches!(device_invite(&relay, &ann), Err(E::Conflict(w)) if w == CONSOLE_OFF));
        let book = headless(&temp_dir());
        // dated now: requests_for lists what is waiting at the current time, and a request from T0 has expired
        let now = (pj::now() * 1000.0) as i64;
        let request = book.new_request("cy@x.org", "meet.invite", json!({"name": "Bo", "email": "bo@x.org", "days": 7}), "New hire", now).unwrap();
        enroll(&relay, book);
        assert_eq!(Value::Object(console_where(&relay)), json!({"ok": true, "local": false, "managedBy": "https://console.example.com"}));
        match device_invite(&relay, &ann) {
            Err(E::Conflict(w)) => assert_eq!(w, "This relay is managed by the Lucid Admin Console at https://console.example.com. Sign in there."),
            other => panic!("{other:?}"),
        }
        let listed = requests_for(&relay, "ann@x.org");
        assert_eq!(listed["requests"][0]["id"], request["id"]);
    }

    /// API-1 2.3 (slice 1a6): the console's `meet.api.sign` request in the relay's book: only its principal's device
    /// sees and answers it; a signed map with another hash fails it with the sentence, which `api-sign-status`
    /// reports; a second ask for the org replaces the waiting one.
    #[test]
    fn api_sign_requests_are_refused_for_another_map_and_reported_to_the_console() {
        let (relay, _) = fixture(&["ann@x.org"]);
        let book = headless(&temp_dir());
        let _ = relay.admin_console.set(book.clone());
        let now = (pj::now() * 1000.0) as i64;
        let map = json!({"v": 1, "org": "acme", "seq": 2});
        let sha = crate::api_map::api_map_hash(&map);
        let ask = |m: &Value, sha: &str| json!({"org": "acme", "principal": "Ann@x.org", "map": m, "map_sha256": sha, "reason": "Rotate the key", "requested_by": "ann@x.org"});
        assert_eq!(api_sign_request(&book, &ask(&map, &"0".repeat(64)), now).unwrap_err().message, API_SIGN_HASH);
        let first = api_sign_request(&book, &ask(&map, &sha), now).unwrap()["request"].as_str().unwrap().to_owned();
        let second = api_sign_request(&book, &ask(&map, &sha), now).unwrap()["request"].as_str().unwrap().to_owned();
        assert_ne!(first, second);
        assert_eq!(api_sign_status(&book, &json!({"org": "acme", "request": first}), now)["state"], "gone", "replaced");
        assert_eq!(api_sign_status(&book, &json!({"org": "acme", "request": second}), now)["state"], "waiting");
        assert_eq!(api_sign_status(&book, &json!({"org": "other", "request": second}), now)["state"], "gone");
        // only the principal's device lists and answers it
        let listed = |p: &str| requests_for(&relay, p)["requests"].as_array().unwrap().iter().any(|r| r["id"] == second.as_str());
        assert!(listed("ann@x.org") && !listed("bob@x.org"));
        let bob = Identity { principal: "bob@x.org".into(), device: "bbbbbbbbbbbbbbbb".into(), ..Default::default() };
        let ann = Identity { principal: "ann@x.org".into(), device: "aaaaaaaaaaaaaaaa".into(), ..Default::default() };
        let id = json!(second);
        let mut other = map.clone();
        other["seq"] = json!(3);
        let wrong = json!({"map": other, "sig": "", "chain": []});
        assert!(matches!(request_signed(&relay, &bob, Some(&id), None, Some(&wrong)), Err(E::NotFound(_))));
        assert!(matches!(request_signed(&relay, &ann, Some(&id), None, Some(&json!({"sig": ""}))), Err(E::Bad(_))));
        match request_signed(&relay, &ann, Some(&id), None, Some(&wrong)) {
            Err(E::Conflict(w)) => assert_eq!(w, API_SIGN_OTHER_MAP),
            other => panic!("{other:?}"),
        }
        assert_eq!(api_sign_status(&book, &json!({"org": "acme", "request": second}), now), json!({"state": "failed", "error": API_SIGN_OTHER_MAP}));
        // closed: a second answer finds no request
        assert!(matches!(request_signed(&relay, &ann, Some(&id), None, Some(&wrong)), Err(E::NotFound(_))));
        // the right map that does not verify against this relay's org CA fails too, with the verifier's words
        let third = api_sign_request(&book, &ask(&map, &sha), now).unwrap()["request"].as_str().unwrap().to_owned();
        let right = json!({"map": map, "sig": "", "chain": []});
        assert!(matches!(request_signed(&relay, &ann, Some(&json!(third)), None, Some(&right)), Err(E::Conflict(_))));
        assert_eq!(api_sign_status(&book, &json!({"org": "acme", "request": third}), now)["state"], "failed");
    }

    /// AC-2a 16.1 f-relay: a relay with its own console on answers `local: true`.
    #[test]
    fn ac2a_where_with_the_local_console() {
        let (relay, _) = fixture(&["ann@x.org"]);
        let _ = relay.admin_console.set(headless(&temp_dir()));
        assert_eq!(Value::Object(console_where(&relay)), json!({"ok": true, "local": true, "managedBy": null}));
    }

    /// AC-2a 16.1 f-relay: the participant sampler hands the people in rooms to the counters.
    #[test]
    fn ac2a_the_participant_sampler_moves_the_counter() {
        let (relay, _) = fixture(&["ann@x.org"]);
        let ann = Identity { principal: "ann@x.org".into(), name: "Ann".into(), device: "aaaaaaaaaaaaaaaa".into(), ..Default::default() };
        let ben = Identity { principal: "ben@x.org".into(), name: "Ben".into(), device: "bbbbbbbbbbbbbbbb".into(), ..Default::default() };
        relay.hub.join("ops", &ann, "", false, None).unwrap();
        relay.hub.join("ops", &ben, "", false, None).unwrap();
        let before = crate::fleet_probe::counters().participants_total();
        assert_eq!(crate::meet_console::sample_participants(&relay), 2);
        assert!(crate::fleet_probe::counters().participants_total() >= before + 2);
        let m = crate::meet_console::fleet_metrics(&relay);
        assert_eq!((m["participants"].as_u64(), m["calls_active"].as_u64()), (Some(2), Some(1)));
    }

    /// AC-2a 16.1 f-relay (A2-H1): `meet/counts` holds exactly the allowlisted fields, every value a non-negative
    /// integer, for an empty relay and a busy one; it is not a route of the relay's own console.
    #[test]
    fn ac2a_meet_counts_are_integers_only() {
        assert!(!ROUTES.iter().any(|r| r.path == "meet/counts"));
        let (relay, section) = fixture(&["ann@x.org"]);
        let counts = |t: i64| {
            let caller = crate::console::Caller { email: "ann@x.org".into(), admin: true, manager: true, ip: "10.0.0.1".into() };
            let c = SectionCall { spec: &FLEET_ROUTES[0], query: "", body: &Value::Null, caller: &caller, license: LicenseState::None, t };
            match section.route(&c).unwrap() {
                SectionAnswer::Read(v) => v,
                _ => panic!("a read"),
            }
        };
        let ints = |v: &Value| v.as_object().unwrap().iter().filter(|(k, _)| *k != "ok").all(|(_, x)| x.as_object().is_some_and(|o| o.values().all(Value::is_u64)));
        let empty = counts(T0);
        assert!(ints(&empty));
        device(&relay, "bob@x.org", "bbbbbbbbbbbbbbbb", "7b");
        let ann = Identity { principal: "ann@x.org".into(), name: "Ann".into(), device: "aaaaaaaaaaaaaaaa".into(), ..Default::default() };
        relay.hub.join("ops", &ann, "", false, None).unwrap();
        let busy = counts(T0 + 1);
        assert!(ints(&busy));
        assert_eq!(busy["devices"]["total"], json!(2));
        // exactly the vector's fields and types, read from the vector, for the empty and the busy relay
        crate::relay::projection_matches("meet/counts", &empty).unwrap();
        crate::relay::projection_matches("meet/counts", &busy).unwrap();
        let text = crate::codec::stringify(&busy);
        assert!(!text.contains("x.org") && !text.contains("bbbb") && !text.contains("7b"));
    }
}
