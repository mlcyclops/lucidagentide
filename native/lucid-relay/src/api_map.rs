// Contract API-1 2 and 3.2: the org `api` map (signed envelope `{map, sig, chain}`, bytes
// `lp("lucid-meet-org-api-v1", canonical JSON of map)`), its field rules (2.2) and edition limits (13), seq pinning
// (2.4), the tightening journal and folding (2.5), and the effective end of a credential under the admin grace (3.2).
// Mirrors the AI map of meet_org_policy.rs (check_ai_map, verify_ai_map, AiMapStore). A relay keeps per org the
// pinned map and the previous one in `api-maps/<org>.json` and its applied journal in `api-journal/<org>.json`, both
// flushed to disk before it answers. Revision 6 (docs/api/contract-r6-1d.md 2.2, 2.3, 4.1, 4.2, slice 1d1) adds the
// `spokes` key, the spokes_hub kind, the spokes_node credential with its key store, and `client_drop_target`; slice
// 1d5 the `a2a` key, the agent client's `a2a` and `card` with `spokes.tasks.submit`, and the console's `card-version`
// and `well-known-taken` checks.

use crate::codec::sha256_hex;
use crate::identity::{is_node_id, is_serial};
use crate::meet_json as pj;
use crate::meet_org_policy::{self as op, canonical_json, lp, Obj};
use crate::meet_x509::{ecdsa_sha256_verified, Cert, Crl};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

pub const API_MAP_LABEL: &str = "lucid-meet-org-api-v1";
/// The canonical JSON of a map (2.2 "whole map").
pub const API_MAP_MAX: usize = 256 * 1024;
/// A signed envelope: the map plus its signature and chain.
const API_WIRE_MAX: usize = API_MAP_MAX + 64 * 1024;
/// Orgs whose maps one relay holds (2.4).
pub const API_MAP_ORGS_MAX: usize = 64;
pub const GRACE_KINDS: [&str; 4] = ["person", "app", "connector", "relay"];
/// D15: at most 7 days.
pub const GRACE_MAX_HOURS: i64 = 168;
const SKEW: i64 = 300;
const MAX_INT: i64 = (1 << 53) - 1;
const DAY: i64 = 86400;

const WIRE_KEYS: &[&str] = &["map", "sig", "chain"];
const MAP_KEYS: &[&str] = &[
    "v",
    "org",
    "seq",
    "issued",
    "expires",
    "issuer",
    "grace",
    "failover_after_s",
    "folded",
    "cleared",
    "relay_origins",
    "clients",
    "scrape_tokens",
    "destinations",
    "webhook_keys",
    "federation",
    "connectors",
    "idps",
    "spokes",
    "a2a",
];
const MAP_REQUIRED: &[&str] = &["v", "org", "seq", "issued", "expires", "issuer", "grace", "failover_after_s"];
const ISSUER_KEYS: &[&str] = &["url", "jwks"];
const JWK_KEYS: &[&str] = &["kty", "crv", "kid", "x", "y", "use", "alg", "nbf", "exp"];
const CLIENT_KEYS: &[&str] = &[
    "id",
    "name",
    "principal",
    "kind",
    "owner",
    "reach",
    "scopes",
    "ceiling",
    "relays",
    "networks",
    "hours",
    "mtls_required",
    "rate",
    "credentials",
    "created",
    "expires",
    "state",
    "compliance",
    "directory",
    "connectors",
    "apps",
    "channels",
    "confirm",
    "delegation",
    "redirect_uris",
    "loopback_ok",
    "spokes",
    "a2a",
    "card",
];
const CLIENT_REQUIRED: &[&str] = &[
    "id",
    "name",
    "principal",
    "kind",
    "owner",
    "reach",
    "scopes",
    "ceiling",
    "relays",
    "networks",
    "mtls_required",
    "rate",
    "credentials",
    "created",
    "expires",
    "state",
];
const HOURS_KEYS: &[&str] = &["tz", "from", "to", "days"];
const RATE_KEYS: &[&str] = &["per_minute_each", "per_day_each"];
const SCRAPE_KEYS: &[&str] = &["sha256", "hint", "label", "relays", "expires"];
const DEST_KEYS: &[&str] = &[
    "id",
    "name",
    "kind",
    "preset",
    "signals",
    "ceiling",
    "identities",
    "failover",
    "private_ok",
    "endpoint",
    "settings",
    "credential",
    "queue",
];
const DEST_REQUIRED: &[&str] = &["id", "name", "kind", "preset", "signals", "ceiling", "identities", "failover", "private_ok", "credential", "queue"];
const QUEUE_KEYS: &[&str] = &["max_bytes", "max_age_s"];

/// Section 6.3: the scopes with resource routes (the 1a routes; later slices add the rows of revision 4 3.1 here as
/// their routes land; revision 6 6.1 adds `spokes.read`).
pub const SCOPES: [&str; 10] = [
    "monitor.read",
    "fleet.read",
    "audit.read",
    "events.subscribe",
    "directory.read",
    "directory.write",
    "compliance.metadata.read",
    "compliance.holds.write",
    "compliance.export.request",
    "spokes.read",
];
/// Revision 4 3.1: every scope a map may grant, as `(scope, reach, the client kind it needs or "" for any)`. Revision
/// 6 9: `spokes.read` is for monitoring and integration clients (checked by `check_client`), `spokes.tasks.submit`
/// for spokes_hub clients and (with `a2a`, also checked by `check_client`) agent clients.
pub const MAP_SCOPES: [(&str, &str, &str); 13] = [
    ("monitor.read", "R0", ""),
    ("fleet.read", "R0", ""),
    ("audit.read", "R0", ""),
    ("events.subscribe", "R0", ""),
    ("compliance.metadata.read", "R0", "compliance"),
    ("compliance.holds.write", "R0", "compliance"),
    ("compliance.export.request", "R1", "compliance"),
    ("directory.read", "R0", "integration"),
    ("directory.write", "R0", "integration"),
    // revision 5 5.1: through a connector only (no relay or front door route serves them)
    ("content.read", "R1", ""),
    ("content.post", "R1", ""),
    ("spokes.read", "R0", ""),
    ("spokes.tasks.submit", "R1", "spokes_hub"),
];
const STANDARD_SCOPES: [&str; 4] = ["monitor.read", "fleet.read", "audit.read", "events.subscribe"];
const SECRET_SCOPES: [&str; 3] = ["monitor.read", "audit.read", "events.subscribe"];
/// Lowest first.
pub const CEILINGS: [&str; 4] = ["public", "internal", "confidential", "cui"];
const KINDS: [&str; 7] = ["monitoring", "compliance", "integration", "app", "agent", "agent_delegated", "spokes_hub"];
/// Revision 4 2.2, revision 5 3.2 and revision 6 4.1: the kinds a map takes now.
pub const MAP_KINDS: [&str; 7] = ["monitoring", "integration", "compliance", "app", "agent", "agent_delegated", "spokes_hub"];
/// Least strict first.
pub const IDENTITIES: [&str; 3] = ["as_is", "pseudonymized", "removed"];
const SIGNALS: [&str; 4] = ["metrics", "logs", "traces", "audit"];
/// Revision 4 2.2: `events` added (v2).
const SIGNALS_V2: [&str; 5] = ["metrics", "logs", "traces", "audit", "events"];
const CRED_TYPES: [&str; 7] = ["mtls", "private_key_jwt", "federated", "client_secret", "entra_wif", "cimd", "spokes_node"];
/// Revision 6 2.1 and 2.2: `spokes` (every key required), `clients[].spokes` and the `spokes_node` credential.
const SPOKES_KEYS: &[&str] = &["root", "root_spki", "relays"];
const SPOKES_CLIENT_KEYS: &[&str] = &["targets"];
const SPOKES_NODE_KEYS: &[&str] = &["type", "node", "serial", "spki", "expires", "key_store"];
/// Revision 6 2.2 `credentials[].key_store` (`file` is refused); the hardware stores a `cui` spokes_hub needs (R6-4).
const KEY_STORES: [&str; 4] = ["os_store", "pkcs11", "azure_key_vault", "tpm"];
const HARDWARE_KEY_STORES: [&str; 3] = ["pkcs11", "azure_key_vault", "tpm"];
/// Revision 6 2.1 and 2.2 (slice 1d5): `a2a`, its `agents[]` and their `skills[]`, and the client fields `a2a`,
/// `a2a.push` and `card`.
const A2A_KEYS: &[&str] = &["jwks", "well_known", "agents"];
const AGENT_KEYS: &[&str] = &["id", "name", "description", "version", "connector", "hub", "provider", "documentation_url", "streaming", "push", "skills"];
const AGENT_REQUIRED: &[&str] = &["id", "name", "description", "version", "connector", "hub", "streaming", "push", "skills"];
const SKILL_KEYS: &[&str] = &["id", "name", "description", "tags", "examples", "targets", "model", "turns", "approve_within_s", "idle_close_s"];
const SKILL_REQUIRED: &[&str] = &["id", "name", "description", "tags", "targets", "turns", "approve_within_s"];
const PROVIDER_KEYS: &[&str] = &["organization", "url"];
const CLIENT_A2A_KEYS: &[&str] = &["agents", "skills", "max_open_tasks", "push"];
const CLIENT_A2A_REQUIRED: &[&str] = &["agents", "skills", "max_open_tasks"];
const PUSH_KEYS: &[&str] = &["origins", "private_cidrs"];
const CARD_KEYS: &[&str] = &["url", "jwks_uri", "private_cidrs"];
/// The private spaces `a2a.push.private_cidrs` and `card.private_cidrs` may name: RFC 1918, CGNAT and IPv6 ULA.
const PRIVATE_SPACES: [&str; 5] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"];
/// The longest URL of `provider.url`, `documentation_url` and `card` (2.2).
const A2A_URL_MAX: usize = 512;
/// Revision 5 3.2: `connectors[]` (every key required), `idps[]` and `clients[].delegation`.
const CONNECTOR_KEYS: &[&str] = &["id", "name", "origin", "apps", "networks", "stale_s", "state"];
const IDP_KEYS: &[&str] = &["id", "provider", "issuer", "algs", "tenant", "max_age_s", "auth_max_s", "private_ok", "state"];
const IDP_REQUIRED: &[&str] = &["id", "provider", "issuer", "algs", "max_age_s", "private_ok", "state"];
const DELEGATION_KEYS: &[&str] = &["groups", "principals", "idps", "consent_days", "denied"];
/// O19: `idps[].auth_max_s` when the map gives none; O2: `delegation.consent_days` when the map gives none.
#[cfg_attr(not(test), allow(dead_code))]
pub const AUTH_MAX_DEFAULT: i64 = 43200;
pub const CONSENT_DAYS_DEFAULT: i64 = 7;
/// Revision 3 2.5: the relay journal's actions. A relay of revision 4 or later refuses any other action and fails the
/// org closed until its next reconnect sync (revision 4 2.3 item 6, `journal-unknown`). Revision 6 2.3 adds
/// `client_drop_target` (category 4c, feature `spokes`).
pub const RELAY_ACTIONS: [&str; 17] = [
    "client_suspend",
    "client_drop_scope",
    "client_drop_relay",
    "client_limit",
    "client_lower_ceiling",
    "client_drop_credential",
    "token_deny",
    "scrape_deny",
    "destination_suspend",
    "destination_delete",
    "destination_disable_failover",
    "destination_drop_signal",
    "destination_lower_ceiling",
    "destination_identities",
    "grace_lower",
    "api_off",
    "client_drop_target",
];
/// Revision 4 7.1: the event types of the registry a webhook may select.
pub const EVENT_TYPES: [&str; 28] = [
    "relay.connected",
    "relay.disconnected",
    "relay.health.changed",
    "relay.mode.changed",
    "cert.expiring",
    "license.expiring",
    "client.suspended",
    "client.expiring",
    "api.disabled",
    "api.enabled",
    "destination.paused",
    "destination.resumed",
    "meeting.started",
    "meeting.ended",
    "member.joined",
    "member.left",
    "hold.placed",
    "hold.released",
    "export.requested",
    "export.released",
    "export.ready",
    "export.ended",
    "person.deprovisioned",
    "person.reactivated",
    "test.ping",
    "checkpoint",
    // API-1d 6.4
    "spoke.offline",
    "spoke.online",
];
const FED_ALGS: [&str; 3] = ["ES256", "RS256", "PS256"];
const OTLP_PRESETS: [&str; 14] = [
    "azure_monitor",
    "azure_monitor_gov",
    "splunk_observability",
    "datadog",
    "elastic",
    "dynatrace",
    "new_relic",
    "grafana_cloud",
    "honeycomb",
    "sumo_logic",
    "cloudwatch",
    "cloudwatch_gov",
    "google_cloud",
    "otlp_generic",
];
const TOKEN_PRESETS: [&str; 10] =
    ["splunk_hec", "splunk_cloud_gov", "datadog", "new_relic", "dynatrace", "elastic", "grafana_cloud", "honeycomb", "sumo_logic", "splunk_observability"];
const SECRET_DAYS_MAX: i64 = 90;
const JWKS_SPAN_MAX: i64 = 400 * DAY;
const CLIENT_SPAN_MAX: i64 = 31_622_400;
const URL_MAX: usize = 2048;

// ---- errors -----------------------------------------------------------------------------------------------------

/// A refusal: `code` is the shared word of the contract (`bad-map`, `grace-limit`, `license`, `issuer-taken`,
/// `fold-mismatch`, `signature`, `seq-not-higher`, `conflict`, `map-expired`, `tseq-gap`, `not-tightening`, and
/// `io` when the relay cannot flush its store).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiMapError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for ApiMapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApiMapError {}

impl ApiMapError {
    pub fn new(code: &'static str, message: impl Into<String>) -> ApiMapError {
        ApiMapError { code, message: message.into() }
    }
}

type Res<T> = Result<T, ApiMapError>;

fn fail<T>(code: &'static str, message: impl Into<String>) -> Res<T> {
    Err(ApiMapError::new(code, message))
}

fn bad<T>(message: impl Into<String>) -> Res<T> {
    fail("bad-map", message)
}

fn bad_e(message: impl Into<String>) -> ApiMapError {
    ApiMapError::new("bad-map", message)
}

fn sig_e(message: impl Into<String>) -> ApiMapError {
    ApiMapError::new("signature", message)
}

/// Section 13: the relay license's `edition`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    Standard,
    Enterprise,
}

impl Edition {
    /// "standard" is Standard and "enterprise" Enterprise; anything else, and no license edition, is unknown (None):
    /// no api map is accepted or served under an unknown edition (13).
    pub fn of(edition: Option<&str>) -> Option<Edition> {
        match edition {
            Some("standard") => Some(Edition::Standard),
            Some("enterprise") => Some(Edition::Enterprise),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Edition::Standard => "standard",
            Edition::Enterprise => "enterprise",
        }
    }
}

// ---- small checks -----------------------------------------------------------------------------------------------

fn obj_of<'a>(v: &'a Value, allowed: &[&str], required: &[&str], what: &str) -> Res<&'a Obj> {
    let Some(o) = v.as_object() else { return bad(format!("{what} must be an object")) };
    if let Some(k) = o.keys().find(|k| !allowed.contains(&k.as_str())) {
        return bad(format!("{what} has an unknown field {k}"));
    }
    if let Some(k) = required.iter().find(|k| !o.contains_key(**k)) {
        return bad(format!("{what} needs {k}"));
    }
    Ok(o)
}

/// A JSON integer (never a boolean or a float).
fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

fn int_in(v: Option<&Value>, what: &str, low: i64, high: i64) -> Res<i64> {
    v.and_then(int_of).filter(|n| (low..=high).contains(n)).ok_or_else(|| bad_e(format!("{what} must be a whole number from {low} to {high}")))
}

fn bool_of(v: Option<&Value>, what: &str) -> Res<bool> {
    v.and_then(Value::as_bool).ok_or_else(|| bad_e(format!("{what} must be true or false")))
}

/// `low` to `high` printable ASCII characters (space to `~`).
fn ascii_text(s: &str, low: usize, high: usize) -> bool {
    (low..=high).contains(&s.len()) && s.bytes().all(|b| (b' '..=b'~').contains(&b))
}

fn text<'a>(v: Option<&'a Value>, what: &str, low: usize, high: usize) -> Res<&'a str> {
    v.and_then(Value::as_str)
        .filter(|s| ascii_text(s, low, high))
        .ok_or_else(|| bad_e(format!("{what} must be printable text of {low} to {high} characters")))
}

fn one_of<'a>(v: Option<&'a Value>, set: &[&str], what: &str) -> Res<&'a str> {
    v.and_then(Value::as_str).filter(|s| set.contains(s)).ok_or_else(|| bad_e(format!("{what} must be one of {}", set.join(", "))))
}

fn hex_n(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `[a-z0-9-]{1,max}`.
fn slug(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `[A-Za-z0-9._-]{1,max}`.
fn token(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Base64url without padding.
fn b64u(s: &str, low: usize, high: usize) -> bool {
    (low..=high).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `<prefix>` plus 16 lowercase hex.
fn prefixed_id(v: &Value, prefix: &str) -> bool {
    v.as_str().and_then(|s| s.strip_prefix(prefix)).is_some_and(|h| hex_n(h, 16))
}

/// `host:port`: a DNS name, IPv4 address or bracketed IPv6 address, and a port 1 to 65535 without a leading zero.
fn authority_ok(a: &str) -> bool {
    let Some((host, port)) = a.rsplit_once(':') else { return false };
    let port_ok = (1..=5).contains(&port.len())
        && port.bytes().all(|b| b.is_ascii_digit())
        && !port.starts_with('0')
        && port.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n));
    if !port_ok {
        return false;
    }
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.parse::<Ipv6Addr>().is_ok();
    }
    op::is_domain(host) || host.parse::<Ipv4Addr>().is_ok()
}

/// `https://<host>:<port>` and nothing after it.
fn origin_ok(s: &str) -> bool {
    s.len() <= 256 && s.strip_prefix("https://").is_some_and(|a| !a.contains('/') && authority_ok(a))
}

/// `https://` + a DNS name, IPv4 or bracketed IPv6 address, an optional `:port` and an optional path; printable
/// ASCII without spaces, at most 2048 characters, no user info, query or fragment.
fn https_url_ok(s: &str) -> bool {
    if s.len() > URL_MAX || !s.bytes().all(|b| b.is_ascii_graphic()) || s.contains(['@', '?', '#']) {
        return false;
    }
    let Some(rest) = s.strip_prefix("https://") else { return false };
    let auth = rest.split_once('/').map_or(rest, |(a, _)| a);
    if auth.rsplit(']').next().unwrap_or_default().contains(':') {
        return origin_ok(&format!("https://{auth}"));
    }
    if let Some(inner) = auth.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.parse::<Ipv6Addr>().is_ok();
    }
    op::is_domain(auth) || auth.parse::<Ipv4Addr>().is_ok()
}

/// Python `ipaddress.ip_network(s)` (strict): an address and a prefix length with no host bits set.
pub(crate) fn cidr_ok(s: &str) -> bool {
    let Some((addr, len)) = s.split_once('/') else { return false };
    if len.is_empty() || len.len() > 3 || !len.bytes().all(|b| b.is_ascii_digit()) || (len.len() > 1 && len.starts_with('0')) {
        return false;
    }
    let Ok(len) = len.parse::<u32>() else { return false };
    if let Ok(a) = addr.parse::<Ipv4Addr>() {
        let bits = u32::from(a);
        return len <= 32 && (len == 32 || bits & (u32::MAX >> len) == 0);
    }
    if let Ok(a) = addr.parse::<Ipv6Addr>() {
        let bits = u128::from(a);
        return len <= 128 && (len == 128 || bits & (u128::MAX >> len) == 0);
    }
    false
}

/// Revision 5 3.2 `redirect_uris`: an https URL (as `https_url_ok`) or a loopback IP literal `http://127.0.0.1` or
/// `http://[::1]` with an optional port and a path, at most 512 characters, no user info, query or fragment.
/// `http://localhost` is refused (RFC 8252 8.3).
pub(crate) fn redirect_ok(s: &str) -> bool {
    if s.len() > 512 {
        return false;
    }
    if s.starts_with("https://") {
        return https_url_ok(s);
    }
    let Some(rest) = s.strip_prefix("http://127.0.0.1").or_else(|| s.strip_prefix("http://[::1]")) else { return false };
    let Some(slash) = rest.find('/') else { return false };
    let (port, path) = rest.split_at(slash);
    let port_ok = port.is_empty()
        || port.strip_prefix(':').is_some_and(|p| {
            (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) && !p.starts_with('0') && p.parse::<u32>().is_ok_and(|n| n <= 65535)
        });
    port_ok && path.bytes().all(|b| b.is_ascii_graphic()) && !path.contains(['@', '?', '#'])
}

/// A CE-1 conversation id of a channel: `ch:` and `[a-z0-9-]{1,64}`.
pub(crate) fn channel_ok(s: &str) -> bool {
    s.strip_prefix("ch:").is_some_and(|r| slug(r, 64))
}

/// A person principal: a lower-case email not on an `apps.` domain.
pub(crate) fn person_ok(s: &str) -> bool {
    op::split_principal(s).is_ok_and(|(_, d)| !d.starts_with("apps."))
}

/// An app principal: a lower-case email on an `apps.` domain.
pub(crate) fn app_principal_ok(s: &str) -> bool {
    op::split_principal(s).is_ok_and(|(_, d)| d.starts_with("apps."))
}

/// An ID-1 group id as `ai.who.groups` lists it: 1 to 128 printable ASCII, not a `name:` form.
pub(crate) fn group_ok(s: &str) -> bool {
    ascii_text(s, 1, 128) && !s.starts_with("name:")
}

/// An idp id: `[a-z0-9-]{1,32}`.
pub(crate) fn idp_id_ok(s: &str) -> bool {
    slug(s, 32)
}

/// An IANA zone name: `[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}`, at most 64 characters.
fn tz_ok(s: &str) -> bool {
    let part = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'));
    let parts: Vec<&str> = s.split('/').collect();
    s.len() <= 64 && parts.len() <= 3 && parts.iter().all(|p| part(p)) && s.as_bytes()[0].is_ascii_alphabetic()
}

/// `HH:MM`, 00:00 to 23:59.
fn hhmm_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5 && b[2] == b':' && [0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit()) && s[..2] < *"24" && s[3..] < *"60"
}

/// A list of `low..=high` items, each passing `ok`, no two equal.
fn list<'a>(v: Option<&'a Value>, what: &str, low: usize, high: usize) -> Res<&'a [Value]> {
    let empty: &'a [Value] = &[];
    let Some(a) = v.map_or(Some(empty), |v| v.as_array().map(Vec::as_slice)) else {
        return bad(format!("{what} must be a list"));
    };
    if !(low..=high).contains(&a.len()) {
        return bad(format!("{what} must list {low} to {high} entries"));
    }
    Ok(a)
}

fn unique<T: Ord>(items: impl IntoIterator<Item = T>) -> bool {
    let mut seen = BTreeSet::new();
    items.into_iter().all(|i| seen.insert(i))
}

fn strings<'a>(v: Option<&'a Value>, what: &str, low: usize, high: usize, ok: impl Fn(&str) -> bool) -> Res<Vec<&'a str>> {
    let a = list(v, what, low, high)?;
    let out: Vec<&str> = a.iter().filter_map(Value::as_str).filter(|s| ok(s)).collect();
    if out.len() != a.len() || !unique(out.iter()) {
        return bad(format!("{what} lists a bad or repeated entry"));
    }
    Ok(out)
}

/// `["*"]` or 1 to 64 relay ids of the org: `console` or a `relay_origins` key.
fn relays_ok(v: Option<&Value>, what: &str, origins: &Obj) -> Res<()> {
    if v.and_then(Value::as_array).is_some_and(|a| a.len() == 1 && a[0] == "*") {
        return Ok(());
    }
    strings(v, what, 1, 64, |s| s == "console" || origins.contains_key(s)).map(|_| ())
}

/// A tightening id of `org` a map may list: `t_<org>_<6 digits>`, not 000000.
fn tighten_id_ok(s: &str, org: &str) -> bool {
    tighten_id_parts(s).is_some_and(|(o, n)| o == org && n > 0)
}

/// `(org, tseq)` of `t_<org>_<tseq as 6 digits>`.
fn tighten_id_parts(s: &str) -> Option<(&str, u64)> {
    let (org, digits) = s.strip_prefix("t_")?.rsplit_once('_')?;
    if !slug(org, 32) || digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((org, digits.parse().ok()?))
}

/// `(org, cseq)` of a console journal id `k_<org>_<cseq as 6 digits>` (revision 4 2.3 item 4).
pub fn console_id_parts(s: &str) -> Option<(&str, u64)> {
    tighten_id_parts(&format!("t_{}", s.strip_prefix("k_")?)).map(|(_, n)| (&s[2..s.len() - 7], n))
}

/// A console journal id of `org` a version 2 map may list in `folded` or `cleared`, not 000000.
fn console_id_ok(s: &str, org: &str) -> bool {
    console_id_parts(s).is_some_and(|(o, n)| o == org && n > 0)
}

/// Revision 4 2.1: the version a map's fields need: 2 when it holds any field marked v2 in 2.2 (a client's
/// `compliance` or `directory` block or `entra_wif` credential; a `webhook` destination, the `events` signal, its
/// settings, or a federated destination credential; `webhook_keys`; `federation`; a `k_` id in `folded` or
/// `cleared`), else 1. Judged on presence only, so it reads any map, checked or not.
pub fn version_needed(map: &Value) -> i64 {
    fn arr(v: Option<&Value>) -> &[Value] {
        v.and_then(Value::as_array).map_or(&[], Vec::as_slice)
    }
    fn ty(v: Option<&Value>) -> Option<&str> {
        v.and_then(|c| c.get("type")).and_then(Value::as_str)
    }
    let top = map.get("webhook_keys").is_some() || map.get("federation").is_some();
    let k_ids = ["folded", "cleared"].iter().any(|k| arr(map.get(*k)).iter().any(|x| x.as_str().is_some_and(|s| s.starts_with("k_"))));
    let clients = arr(map.get("clients"))
        .iter()
        .any(|c| c.get("compliance").is_some() || c.get("directory").is_some() || arr(c.get("credentials")).iter().any(|cr| ty(Some(cr)) == Some("entra_wif")));
    let dests = arr(map.get("destinations")).iter().any(|d| {
        d.get("kind").and_then(Value::as_str) == Some("webhook")
            || arr(d.get("signals")).iter().any(|s| s.as_str() == Some("events"))
            || matches!(ty(d.get("credential")), Some("entra_federated" | "gcp_federated"))
            || d.get("settings").is_some_and(|s| s.get("events_client").is_some() || s.get("events_stream").is_some())
    });
    if top || k_ids || clients || dests {
        2
    } else {
        1
    }
}

fn scope_row(s: &str) -> Option<(&'static str, &'static str, &'static str)> {
    MAP_SCOPES.iter().copied().find(|r| r.0 == s)
}

/// A lowercase GUID (`8-4-4-4-12` hex).
fn guid_ok(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5 && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| hex_n(p, n))
}

/// The bit length of an RSA modulus in base64url (None when it is not base64url).
fn modulus_bits(n: &str) -> Option<usize> {
    if !b64u(n, 2, 1024) || n.len() % 4 == 1 {
        return None;
    }
    let raw = crate::codec::unb64u(n)?;
    let first = raw.iter().position(|b| *b != 0)?;
    Some((raw.len() - first - 1) * 8 + (8 - raw[first].leading_zeros() as usize))
}

fn rank(set: &[&str], v: &str) -> Option<usize> {
    set.iter().position(|s| *s == v)
}

fn policy_domains(policy: &Obj) -> Vec<&str> {
    policy.get("domains").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
}

/// The names (principal local parts) of the policy's apps of every type (revision 5 3.2; revision 3 said `ai` apps).
fn app_names(policy: &Obj) -> Vec<&str> {
    let apps = policy.get("apps").and_then(Value::as_array).into_iter().flatten();
    apps.filter_map(|a| a.get("principal").and_then(Value::as_str)).map(|p| p.split('@').next().unwrap_or_default()).collect()
}

/// The principals of the policy's apps of type `api` (revision 5 2.3).
fn api_app_principals(policy: &Obj) -> Vec<&str> {
    let apps = policy.get("apps").and_then(Value::as_array).into_iter().flatten();
    apps.filter(|a| a.get("type").and_then(Value::as_str) == Some("api")).filter_map(|a| a.get("principal").and_then(Value::as_str)).collect()
}

/// The policy's `ai.who.groups`.
fn who_groups(policy: &Obj) -> Vec<&str> {
    policy.get("ai").and_then(|a| a.pointer("/who/groups")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
}

// ---- 2.2: the map's fields ----------------------------------------------------------------------------------------

/// Contract 2.2 and 13: every field rule of the map at `now`, with the org's pinned `policy` when the relay holds one
/// (the map's org, `domains` for principals and owners, `ai` app names), the license `edition`, and the issuer URLs of
/// the maps held for each org (`held_issuers`; this map's own org is skipped).
pub fn check_api_map(map: &Value, now: i64, policy: Option<&Obj>, edition: Edition, held_issuers: &BTreeMap<String, String>) -> Result<(), ApiMapError> {
    let m = obj_of(map, MAP_KEYS, MAP_REQUIRED, "the api map")?;
    let size = canonical_json(map).map_err(|e| bad_e(format!("the api map: {e}")))?.len();
    if size > API_MAP_MAX {
        return bad("the api map is larger than 256 KiB");
    }
    let Some(v) = m.get("v").and_then(int_of).filter(|v| matches!(v, 1 | 2)) else {
        return bad("the api map must be version 1 or 2");
    };
    match (v, version_needed(map)) {
        (1, 2) => return fail("map-version", "a field of this api map needs version 2"),
        (2, 1) => return fail("map-version", "a version 2 api map must use a field of version 2"),
        _ => {}
    }
    let Some(org) = m.get("org").and_then(Value::as_str).filter(|o| slug(o, 32)) else {
        return bad("the api map's org must be 1 to 32 of a-z, 0-9 and -");
    };
    if policy.is_some_and(|p| p.get("org").and_then(Value::as_str) != Some(org)) {
        return bad("the api map is for another organization");
    }
    int_in(m.get("seq"), "seq", 1, MAX_INT)?;
    let issued = int_in(m.get("issued"), "issued", 1, MAX_INT)?;
    if issued > now + SKEW {
        return bad("the api map is dated in the future");
    }
    let expires = int_in(m.get("expires"), "expires", 1, MAX_INT)?;
    if !(DAY..=90 * DAY).contains(&(expires - issued)) {
        return bad("the api map must last 1 to 90 days");
    }
    check_grace(m.get("grace").unwrap_or(&Value::Null))?;
    let url = check_issuer(m.get("issuer").unwrap_or(&Value::Null), org)?;
    int_in(m.get("failover_after_s"), "failover_after_s", 60, 3600)?;
    let id_ok = |s: &str| tighten_id_ok(s, org) || console_id_ok(s, org);
    let folded = strings(m.get("folded"), "folded", 0, 1000, id_ok)?;
    let cleared = strings(m.get("cleared"), "cleared", 0, 1000, id_ok)?;
    let empty_obj = Value::Object(Obj::new());
    let Some(origins) = m.get("relay_origins").unwrap_or(&empty_obj).as_object().filter(|o| o.len() <= 256) else {
        return bad("relay_origins must map up to 256 relay ids to origins");
    };
    if !origins.iter().all(|(k, v)| token(k, 64) && k != "console" && v.as_str().is_some_and(origin_ok)) || !unique(origins.values().filter_map(Value::as_str)) {
        return bad("relay_origins must map relay ids to distinct https://<host>:<port> origins");
    }
    let connectors = check_connectors(m.get("connectors"), &url, org, origins, policy)?;
    let idps = check_idp_entries(m.get("idps"))?;
    let spokes = m.get("spokes").map(|s| check_spokes(s, origins)).transpose()?;
    let clients = list(m.get("clients"), "clients", 0, 500)?;
    let issuer_kids: Vec<&str> = texts_of(m["issuer"]["jwks"].as_array().map_or(&[][..], Vec::as_slice), "kid").collect();
    let agents = match m.get("a2a") {
        Some(a) => check_a2a(a, &issuer_kids, connectors, clients, spokes.is_some())?,
        None => &[][..],
    };
    let cx = MapCtx { org, issued, issuer_url: &url, policy, origins, connectors, idps, spokes, agents };
    for c in clients {
        check_client(c, &cx)?;
    }
    if !unique(clients.iter().filter_map(|c| c.get("id").and_then(Value::as_str))) || !unique(clients.iter().filter_map(|c| c.get("name").and_then(Value::as_str))) {
        return bad("two clients have the same id or name");
    }
    check_service_hubs(clients)?;
    // revision 5 3.2 (R5-11): a cimd url names one client of the map
    let cimd_urls = clients.iter().flat_map(|c| c.get("credentials").and_then(Value::as_array).into_iter().flatten()).filter(|cr| cr.get("type").and_then(Value::as_str) == Some("cimd"));
    if !unique(cimd_urls.filter_map(|cr| cr.get("url").and_then(Value::as_str))) {
        return bad("two clients have the same cimd url");
    }
    if !unique(clients.iter().filter_map(|c| c.pointer("/directory/resource")).filter_map(Value::as_str)) {
        return fail("directory", "two clients have the same directory resource");
    }
    check_recipients(clients)?;
    let tokens = list(m.get("scrape_tokens"), "scrape_tokens", 0, 10)?;
    for t in tokens {
        let t = obj_of(t, SCRAPE_KEYS, SCRAPE_KEYS, "a scrape token")?;
        if !t.get("sha256").and_then(Value::as_str).is_some_and(|h| hex_n(h, 64)) {
            return bad("a scrape token's sha256 must be 64 lowercase hex");
        }
        if text(t.get("hint"), "a scrape token's hint", 8, 8).is_err() {
            return bad("a scrape token's hint must be 8 characters");
        }
        text(t.get("label"), "a scrape token's label", 1, 64)?;
        relays_ok(t.get("relays"), "a scrape token's relays", origins)?;
        let exp = int_in(t.get("expires"), "a scrape token's expires", 1, MAX_INT)?;
        if exp > issued + 90 * DAY {
            return bad("a scrape token lasts at most 90 days after it was first signed");
        }
    }
    if !unique(tokens.iter().filter_map(|t| t.get("sha256").and_then(Value::as_str))) {
        return bad("two scrape tokens have the same sha256");
    }
    let dests = list(m.get("destinations"), "destinations", 0, 32)?;
    for d in dests {
        check_destination(d, clients, m.contains_key("federation"))?;
    }
    if !unique(dests.iter().filter_map(|d| d.get("id").and_then(Value::as_str))) || !unique(dests.iter().filter_map(|d| d.get("name").and_then(Value::as_str))) {
        return bad("two destinations have the same id or name");
    }
    let v2a = dests.iter().any(|d| d.pointer("/settings/signing").and_then(Value::as_str) == Some("v2a"));
    check_webhook_keys(m.get("webhook_keys"), issued, v2a)?;
    if let Some(f) = m.get("federation") {
        check_federation(f)?;
    }
    if folded.iter().any(|f| cleared.contains(f)) {
        return fail("fold-mismatch", "an id is both folded and cleared");
    }
    if edition == Edition::Standard {
        // revision 5 15: connectors (and the content scopes, below) are enterprise
        if !connectors.is_empty() {
            return fail("license", "the standard edition has no connectors");
        }
        // revision 5 15: identity providers for enterprise-managed sign-in are enterprise
        if !idps.is_empty() {
            return fail("license", "the standard edition has no identity providers");
        }
        // revision 6 14: Remote Spokes in the map (and, below, spokes_hub clients and the spokes scopes) are enterprise
        if m.contains_key("spokes") {
            return fail("license", "the standard edition has no Remote Spokes in the api map");
        }
        // revision 6 14: A2A agents and their card keys are enterprise
        if m.contains_key("a2a") {
            return fail("license", "the standard edition has no A2A agents in the api map");
        }
        check_standard(clients, dests)?;
    }
    if held_issuers.iter().any(|(o, u)| o != org && *u == url) {
        return fail("issuer-taken", "another organization's api map has that issuer url");
    }
    Ok(())
}

/// `issuer`: the url for this org and 1 to 3 ES256 keys. Returns the url.
fn check_issuer(v: &Value, org: &str) -> Res<String> {
    let i = obj_of(v, ISSUER_KEYS, ISSUER_KEYS, "issuer")?;
    let url = i.get("url").and_then(Value::as_str).unwrap_or_default();
    let ok = url
        .strip_prefix("https://")
        .and_then(|r| r.strip_suffix(&format!("/api/orgs/{org}")))
        .is_some_and(|a| !a.contains('/') && authority_ok(a));
    if !ok || url.len() > 512 {
        return bad("issuer.url must be https://<host>:<port>/api/orgs/<org>");
    }
    check_jwks(i.get("jwks"), "issuer.jwks", "an issuer key")?;
    Ok(url.to_string())
}

/// 1a 2.2 `issuer.jwks`, and under the same rules revision 6 2.2 `a2a.jwks` (`what`; `one` names one key): 1 to 3
/// EC P-256 ES256 signing keys with kids of `[A-Za-z0-9._-]{1,64}`, unique, each `nbf` before its `exp`, at most 400
/// days apart. Returns the kids.
fn check_jwks<'a>(v: Option<&'a Value>, what: &str, one: &str) -> Res<Vec<&'a str>> {
    let keys = list(v, what, 1, 3)?;
    for k in keys {
        let k = obj_of(k, JWK_KEYS, JWK_KEYS, one)?;
        let fixed = [("kty", "EC"), ("crv", "P-256"), ("alg", "ES256")].iter().all(|(f, want)| k.get(*f).and_then(Value::as_str) == Some(*want));
        let use_ok = k.get("use").and_then(Value::as_str) == Some("sig");
        let xy = ["x", "y"].iter().all(|f| k.get(*f).and_then(Value::as_str).is_some_and(|s| b64u(s, 43, 43)));
        let kid = k.get("kid").and_then(Value::as_str).is_some_and(|s| token(s, 64));
        if !(fixed && use_ok && xy && kid) {
            return bad(format!("{one} must be an EC P-256 ES256 key with a kid of [A-Za-z0-9._-]{{1,64}}"));
        }
        let nbf = int_in(k.get("nbf"), &format!("{one}'s nbf"), 0, MAX_INT)?;
        let exp = int_in(k.get("exp"), &format!("{one}'s exp"), 0, MAX_INT)?;
        if nbf >= exp || exp - nbf > JWKS_SPAN_MAX {
            return bad(format!("{one}'s nbf must be before its exp, at most 400 days apart"));
        }
    }
    let kids: Vec<&str> = texts_of(keys, "kid").collect();
    if !unique(kids.iter()) {
        return bad(format!("{what} lists a kid twice"));
    }
    Ok(kids)
}

/// `grace`: exactly the four kinds, each 0 to 168 hours (D15), else `grace-limit`.
fn check_grace(v: &Value) -> Res<()> {
    let Some(g) = v.as_object() else { return bad("grace must be an object") };
    let ok = g.len() == GRACE_KINDS.len()
        && GRACE_KINDS.iter().all(|k| g.get(*k).and_then(int_of).is_some_and(|h| (0..=GRACE_MAX_HOURS).contains(&h)));
    if !ok {
        return fail("grace-limit", "grace must give person, app, connector and relay each 0 to 168 hours");
    }
    Ok(())
}

/// What a client's checks read of the rest of the map.
struct MapCtx<'a> {
    org: &'a str,
    issued: i64,
    issuer_url: &'a str,
    policy: Option<&'a Obj>,
    origins: &'a Obj,
    /// Revision 5 3.2: the map's checked `connectors` and `idps`.
    connectors: &'a [Value],
    idps: &'a [Value],
    /// Revision 6 2.2: `spokes.relays` when the map has `spokes`.
    spokes: Option<Vec<&'a str>>,
    /// Revision 6 2.2: the map's checked `a2a.agents` (empty without them).
    agents: &'a [Value],
}

/// Revision 6 2.1 and 2.2 `spokes`: every key; `root` the org root's node id (`n_` and 32 lowercase hex);
/// `root_spki` 64 hex; `relays` 0 to 64 unique relay ids, none of them a Meet relay of the map (a `relay_origins` key
/// or `console`). Returns the relays.
fn check_spokes<'a>(v: &'a Value, origins: &Obj) -> Res<Vec<&'a str>> {
    let s = obj_of(v, SPOKES_KEYS, SPOKES_KEYS, "spokes")?;
    if !s["root"].as_str().is_some_and(is_node_id) {
        return bad("spokes.root must be the org root's node id, n_ and 32 lowercase hex");
    }
    if !s["root_spki"].as_str().is_some_and(|h| hex_n(h, 64)) {
        return bad("spokes.root_spki must be 64 lowercase hex");
    }
    let relays = strings(s.get("relays"), "spokes.relays", 0, 64, |r| token(r, 64) && r != "*")?;
    if relays.iter().any(|r| *r == "console" || origins.contains_key(*r)) {
        return bad("spokes.relays must not name a Meet relay of the map");
    }
    Ok(relays)
}

/// Revision 6 1 and 4.2: a service hub node belongs to one spokes_hub client, and a `spokes_node` serial is listed
/// once in the map.
fn check_service_hubs(clients: &[Value]) -> Res<()> {
    let mut owner: BTreeMap<&str, &str> = BTreeMap::new();
    let mut serials = BTreeSet::new();
    for c in clients {
        let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
        let nodes = c.get("credentials").and_then(Value::as_array).into_iter().flatten().filter(|cr| cr.get("type").and_then(Value::as_str) == Some("spokes_node"));
        for cr in nodes {
            let node = cr.get("node").and_then(Value::as_str).unwrap_or_default();
            if *owner.entry(node).or_insert(id) != id {
                return bad("a service hub node belongs to one spokes_hub client");
            }
            if !serials.insert(cr.get("serial").and_then(Value::as_str).unwrap_or_default()) {
                return bad("two spokes_node credentials have the same serial");
            }
        }
    }
    Ok(())
}

/// Revision 6 2.2 `clients[].spokes` of a spokes_hub client: `{targets: ["*"] or 1 to 256 unique spoke node ids}`.
fn check_spokes_targets(v: &Value) -> Res<()> {
    let s = obj_of(v, SPOKES_CLIENT_KEYS, SPOKES_CLIENT_KEYS, "a client's spokes")?;
    if s["targets"].as_array().is_some_and(|a| a.len() == 1 && a[0] == "*") {
        return Ok(());
    }
    strings(s.get("targets"), "a client's spokes targets", 1, 256, is_node_id).map(|_| ())
}

/// Revision 6 2.2, the card's free text (names, descriptions, tags, examples, a provider's organization): `low` to
/// `high` characters, none of them a control character.
fn card_text_ok(s: &str, low: usize, high: usize) -> bool {
    (low..=high).contains(&s.chars().count()) && !s.chars().any(char::is_control)
}

fn card_text(v: Option<&Value>, what: &str, low: usize, high: usize) -> Res<()> {
    if !v.and_then(Value::as_str).is_some_and(|s| card_text_ok(s, low, high)) {
        return bad(format!("{what} must be {low} to {high} characters without control characters"));
    }
    Ok(())
}

/// `agents[].version`: 1 to 32 of `[0-9A-Za-z.+-]`.
fn version_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
}

/// `skills[].model`: the add-on's `TASK_MODEL_RE` (`spoke.ts`),
/// `^[a-z0-9][a-z0-9-]{0,40}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,149}$`.
fn model_ok(s: &str) -> bool {
    let Some((provider, model)) = s.split_once('/') else { return false };
    let (p, m) = (provider.as_bytes(), model.as_bytes());
    (1..=41).contains(&p.len())
        && p[0] != b'-'
        && p.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && (1..=150).contains(&m.len())
        && m[0].is_ascii_alphanumeric()
        && m.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
}

/// `provider.url`, `documentation_url`, `card.url` and `card.jwks_uri`: an https URL of at most 512 characters.
fn a2a_url_ok(s: &str) -> bool {
    s.len() <= A2A_URL_MAX && https_url_ok(s)
}

/// `a2a.push.origins[]`: `https://host[:port]` with no path, as `connector_a2a_wire::origin_of` writes it (host lower
/// case, port 443 left out), at most 512 characters.
fn push_origin_ok(s: &str) -> bool {
    a2a_url_ok(s) && !s["https://".len()..].contains('/') && s == s.to_ascii_lowercase() && !s.ends_with(":443")
}

/// `a2a.push.private_cidrs[]` and `card.private_cidrs[]`: a CIDR inside RFC 1918, 100.64.0.0/10 or IPv6 ULA space.
fn private_cidr_ok(s: &str) -> bool {
    cidr_ok(s) && PRIVATE_SPACES.iter().any(|p| cidr_within(s, p))
}

fn find_id<'a>(list: &'a [Value], id: &str) -> Option<&'a Value> {
    list.iter().find(|x| x.get("id").and_then(Value::as_str) == Some(id))
}

/// Revision 6 2.1 and 2.2 `a2a`: `jwks` 1 to 3 keys under the `issuer.jwks` rules, kids distinct from `issuer_kids`,
/// needed when `agents` is non-empty; `agents` 0 to 16 (`check_agent`), ids unique, one agent per hub; the map's
/// `spokes` (`spokes`) when any agent is listed; `well_known` an agent id of this map. `clients` are the map's clients
/// before their own checks. Returns the agents.
fn check_a2a<'a>(v: &'a Value, issuer_kids: &[&str], connectors: &[Value], clients: &[Value], spokes: bool) -> Res<&'a [Value]> {
    let a = obj_of(v, A2A_KEYS, &[], "a2a")?;
    let agents = list(a.get("agents"), "a2a.agents", 0, 16)?;
    match a.get("jwks") {
        Some(k) => {
            let kids = check_jwks(Some(k), "a2a.jwks", "a card key")?;
            if kids.iter().any(|k| issuer_kids.contains(k)) {
                return bad("a card key's kid must differ from every issuer key's kid");
            }
        }
        None if !agents.is_empty() => return bad("a2a.jwks is needed when a2a lists agents"),
        None => {}
    }
    if !agents.is_empty() && !spokes {
        return bad("a map with a2a agents needs the spokes key");
    }
    for g in agents {
        check_agent(g, connectors, clients)?;
    }
    if !unique(texts_of(agents, "id")) {
        return bad("two agents have the same id");
    }
    if !unique(texts_of(agents, "hub")) {
        return bad("a service hub serves at most one agent");
    }
    if a.get("well_known").is_some_and(|w| !w.as_str().is_some_and(|w| has_id(agents, w))) {
        return bad("a2a.well_known must be an agent id of this map");
    }
    Ok(agents)
}

/// Revision 6 2.2 `a2a.agents[]`: id `a_` and 16 hex; name 1 to 64 and description 1 to 1024 characters; version;
/// `connector` a connector of the map; `hub` a spokes_hub client of the map; optional `provider` and
/// `documentation_url`; `streaming` and `push`; 1 to 16 skills, ids `[a-z0-9-]{1,64}` unique, each with name,
/// description, 1 to 8 tags, 0 to 4 examples, 1 to 64 targets inside the hub's `spokes.targets` (any, when that is
/// `*`), an optional model, `turns` one or many, `approve_within_s` 300 to 86400 and, for `many` only, an optional
/// `idle_close_s` 300 to 86400.
fn check_agent(v: &Value, connectors: &[Value], clients: &[Value]) -> Res<()> {
    let g = obj_of(v, AGENT_KEYS, AGENT_REQUIRED, "an agent")?;
    if !prefixed_id(&g["id"], "a_") {
        return bad("an agent id must be a_ and 16 lowercase hex");
    }
    card_text(g.get("name"), "an agent's name", 1, 64)?;
    card_text(g.get("description"), "an agent's description", 1, 1024)?;
    if !g["version"].as_str().is_some_and(version_ok) {
        return bad("an agent's version must be 1 to 32 of 0-9, A-Z, a-z, ., + and -");
    }
    if !g["connector"].as_str().is_some_and(|k| has_id(connectors, k)) {
        return bad("an agent's connector must be a connector of this map");
    }
    let hub = g["hub"].as_str().and_then(|h| find_id(clients, h)).filter(|c| c.get("kind").and_then(Value::as_str) == Some("spokes_hub"));
    let Some(hub) = hub else { return bad("an agent's hub must be a spokes_hub client of this map") };
    if let Some(p) = g.get("provider") {
        let p = obj_of(p, PROVIDER_KEYS, PROVIDER_KEYS, "an agent's provider")?;
        card_text(p.get("organization"), "a provider's organization", 1, 64)?;
        if !p["url"].as_str().is_some_and(a2a_url_ok) {
            return bad("a provider's url must be an https URL of at most 512 characters");
        }
    }
    if g.get("documentation_url").is_some_and(|u| !u.as_str().is_some_and(a2a_url_ok)) {
        return bad("an agent's documentation_url must be an https URL of at most 512 characters");
    }
    bool_of(g.get("streaming"), "an agent's streaming")?;
    bool_of(g.get("push"), "an agent's push")?;
    let hub_targets = hub.pointer("/spokes/targets").and_then(Value::as_array);
    let any_target = hub_targets.is_some_and(|t| t.len() == 1 && t[0] == "*");
    let held: Vec<&str> = hub_targets.into_iter().flatten().filter_map(Value::as_str).collect();
    let skills = list(g.get("skills"), "an agent's skills", 1, 16)?;
    for s in skills {
        let s = obj_of(s, SKILL_KEYS, SKILL_REQUIRED, "a skill")?;
        if !s["id"].as_str().is_some_and(|i| slug(i, 64)) {
            return bad("a skill id must be 1 to 64 of a-z, 0-9 and -");
        }
        card_text(s.get("name"), "a skill's name", 1, 64)?;
        card_text(s.get("description"), "a skill's description", 1, 1024)?;
        strings(s.get("tags"), "a skill's tags", 1, 8, |t| card_text_ok(t, 1, 32))?;
        strings(s.get("examples"), "a skill's examples", 0, 4, |t| card_text_ok(t, 1, 256))?;
        let targets = strings(s.get("targets"), "a skill's targets", 1, 64, is_node_id)?;
        if !any_target && !targets.iter().all(|t| held.contains(t)) {
            return bad("every target of a skill must be a target of the agent's hub");
        }
        if s.get("model").is_some_and(|m| !m.as_str().is_some_and(model_ok)) {
            return bad("a skill's model must be <provider>/<model> as a spoke takes it");
        }
        let turns = one_of(s.get("turns"), &["one", "many"], "a skill's turns")?;
        int_in(s.get("approve_within_s"), "approve_within_s", 300, 86400)?;
        match (s.get("idle_close_s"), turns) {
            (None, _) => {}
            (Some(v), "many") => {
                int_in(Some(v), "idle_close_s", 300, 86400)?;
            }
            (Some(_), _) => return bad("idle_close_s goes with turns many only"),
        }
    }
    if !unique(texts_of(skills, "id")) {
        return bad("two skills of an agent have the same id");
    }
    Ok(())
}

/// Revision 6 2.2 and 4.1 `clients[].a2a` and `card`: `a2a` exactly for a client holding `spokes.tasks.submit` other
/// than spokes_hub (an agent; an agent without that scope follows revision 5 only, R5-17): `agents` 1 to 16 of the
/// map's, `skills` `["*"]` or 1 to 64 `<agent id>/<skill id>` of those agents, `max_open_tasks` 1 to 256 and an
/// optional `push` (1 to 8 https origins, 0 to 8 private CIDRs); the client's `connectors` then hold each listed
/// agent's connector. `card` only with `a2a`: https `url` and `jwks_uri` and 0 to 8 private CIDRs.
fn check_client_a2a(c: &Obj, kind: &str, scopes: &[&str], agents: &[Value]) -> Res<()> {
    let submit = kind != "spokes_hub" && scopes.contains(&"spokes.tasks.submit");
    let a = match (c.get("a2a"), submit) {
        (None, false) if c.contains_key("card") => return bad("card goes with a2a only"),
        (None, false) => return Ok(()),
        (Some(a), true) => a,
        (None, true) => return bad("a client with spokes.tasks.submit needs a2a"),
        (Some(_), false) => return bad("a2a goes with spokes.tasks.submit on an agent client only"),
    };
    let a = obj_of(a, CLIENT_A2A_KEYS, CLIENT_A2A_REQUIRED, "a client's a2a")?;
    let mine = strings(a.get("agents"), "a client's a2a agents", 1, 16, |g| has_id(agents, g))?;
    let star = a.get("skills").and_then(Value::as_array).is_some_and(|x| x.len() == 1 && x[0] == "*");
    if !star {
        let skill_ok = |s: &str| {
            s.split_once('/').is_some_and(|(g, k)| {
                mine.contains(&g) && find_id(agents, g).and_then(|x| x.get("skills")).and_then(Value::as_array).is_some_and(|sk| has_id(sk, k))
            })
        };
        strings(a.get("skills"), "a client's a2a skills", 1, 64, skill_ok)?;
    }
    int_in(a.get("max_open_tasks"), "max_open_tasks", 1, 256)?;
    if let Some(p) = a.get("push") {
        let p = obj_of(p, PUSH_KEYS, &["origins"], "a client's push")?;
        strings(p.get("origins"), "a client's push origins", 1, 8, push_origin_ok)?;
        strings(p.get("private_cidrs"), "a client's push private_cidrs", 0, 8, private_cidr_ok)?;
    }
    let listed: Vec<&str> = c.get("connectors").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let held = |g: &&str| find_id(agents, g).and_then(|x| x.get("connector")).and_then(Value::as_str).is_some_and(|k| listed.contains(&k));
    if !mine.iter().all(held) {
        return bad("a client's connectors must hold the connector of each of its agents");
    }
    if let Some(k) = c.get("card") {
        let k = obj_of(k, CARD_KEYS, &["url", "jwks_uri"], "a client's card")?;
        if !["url", "jwks_uri"].iter().all(|f| k[*f].as_str().is_some_and(a2a_url_ok)) {
            return bad("a card's url and jwks_uri must be https URLs of at most 512 characters");
        }
        strings(k.get("private_cidrs"), "a card's private_cidrs", 0, 8, private_cidr_ok)?;
    }
    Ok(())
}

/// Revision 6 7.1.3 `card-version`: the first agent id of `new` whose generated card (`a2a_card::card_payload`)
/// differs from the one in `old` while its `version` is unchanged (an agent `old` does not list has no old card).
/// Both are map bodies.
pub fn card_version_problem(old: &Value, new: &Value, org: &str) -> Option<String> {
    fn agents_of(m: &Value) -> &[Value] {
        m.pointer("/a2a/agents").and_then(Value::as_array).map_or(&[], Vec::as_slice)
    }
    let before = agents_of(old);
    agents_of(new).iter().find_map(|g| {
        let id = g.get("id")?.as_str()?;
        let was = find_id(before, id)?;
        let changed = was.get("version") == g.get("version") && crate::a2a_card::card_payload(old, org, id) != crate::a2a_card::card_payload(new, org, id);
        changed.then(|| id.to_string())
    })
}

/// Revision 6 2.2 `well-known-taken`: `map` names `a2a.well_known` and so does one of `others` (the map bodies of the
/// other orgs' pinned maps on this console).
pub fn well_known_taken(map: &Value, others: &[Value]) -> bool {
    let names = |m: &Value| m.pointer("/a2a/well_known").and_then(Value::as_str).is_some();
    names(map) && others.iter().any(names)
}

/// Revision 6 4.2 (R6-4), the console's staging check of a service hub certificate against its client's ceiling:
/// whether every user clearance fits `ceiling` (`private` needs at least `confidential`, `cui` needs `cui`,
/// `shareable` needs nothing). An unknown ceiling or clearance never fits.
#[cfg_attr(not(test), allow(dead_code))]
pub fn clearances_within(ceiling: &str, clearances: &[&str]) -> bool {
    let Some(have) = rank(&CEILINGS, ceiling) else { return false };
    let at_least = |need: &str| rank(&CEILINGS, need).is_some_and(|n| have >= n);
    clearances.iter().all(|c| match *c {
        "shareable" => true,
        "private" => at_least("confidential"),
        "cui" => at_least("cui"),
        _ => false,
    })
}

/// Revision 6 2.2 and 5.1: a map's `spokes.root` and `spokes.root_spki`, which a spokes relay matches against its own
/// root before it pins the map (None without `spokes`).
#[cfg_attr(not(test), allow(dead_code))]
pub fn spokes_root(map: &Obj) -> Option<(&str, &str)> {
    let s = map.get("spokes")?;
    Some((s.get("root")?.as_str()?, s.get("root_spki")?.as_str()?))
}

/// Revision 6 2.2 and 5.1: a map's `spokes.relays`, the spokes relays bound to its org (empty without `spokes`).
pub fn spokes_relays(map: &Obj) -> Vec<&str> {
    map.get("spokes").and_then(|s| s.get("relays")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
}

/// Revision 5 3.2 `connectors`: 0 to 16 entries of every key; ids `k_` and 16 hex and names unique; each origin
/// canonical `https://<host>:<port>` (lower case), unique across `connectors` and `relay_origins`, and not the
/// front door's (R5-23); 1 to 16 app principals, with the org's policy each an `api` app, and one app in at most one
/// connector; 0 to 32 networks; `stale_s` 30 to 300; `state` active or suspended. Returns the entries.
fn check_connectors<'a>(v: Option<&'a Value>, issuer_url: &str, org: &str, origins: &Obj, policy: Option<&Obj>) -> Res<&'a [Value]> {
    let all = list(v, "connectors", 0, 16)?;
    let front = issuer_url.strip_suffix(&format!("/api/orgs/{org}")).unwrap_or(issuer_url);
    let api_apps = policy.map(api_app_principals);
    for k in all {
        let k = obj_of(k, CONNECTOR_KEYS, CONNECTOR_KEYS, "a connector")?;
        if !prefixed_id(&k["id"], "k_") {
            return bad("a connector id must be k_ and 16 lowercase hex");
        }
        if !k["name"].as_str().is_some_and(|n| slug(n, 32)) {
            return bad("a connector name must be 1 to 32 of a-z, 0-9 and -");
        }
        let Some(origin) = k["origin"].as_str().filter(|o| origin_ok(o) && *o == o.to_ascii_lowercase()) else {
            return bad("a connector origin must be a lowercase https://<host>:<port>");
        };
        if origin == front {
            return bad("a connector origin must differ from the front door's origin");
        }
        if origins.values().any(|o| o.as_str() == Some(origin)) {
            return bad("a connector origin must differ from every relay origin");
        }
        strings(k.get("apps"), "a connector's apps", 1, 16, |a| app_principal_ok(a) && api_apps.as_ref().is_none_or(|x| x.contains(&a)))?;
        strings(k.get("networks"), "a connector's networks", 0, 32, cidr_ok)?;
        int_in(k.get("stale_s"), "stale_s", 30, 300)?;
        one_of(k.get("state"), &["active", "suspended"], "a connector state")?;
    }
    if !unique(texts_of(all, "id")) || !unique(texts_of(all, "name")) || !unique(texts_of(all, "origin")) {
        return bad("two connectors have the same id, name or origin");
    }
    if !unique(all.iter().flat_map(|k| k["apps"].as_array().into_iter().flatten()).filter_map(Value::as_str)) {
        return bad("an app is in at most one connector");
    }
    Ok(all)
}

/// Revision 5 3.2 `idps`: 0 to 8 entries; ids `[a-z0-9-]{1,32}` and issuers unique; `provider` 1 to 64 characters
/// (judged against the registry by `check_idps`); `issuer` an https URL of at most 1024 characters; `algs` 1 to 3 of
/// ES256, RS256 and PS256; `tenant` 1 to 128 characters; `max_age_s` 60 to 600; `auth_max_s` 300 to 86400 (default
/// 43200, O19); `private_ok`; `state`. Returns the entries.
fn check_idp_entries(v: Option<&Value>) -> Res<&[Value]> {
    let all = list(v, "idps", 0, 8)?;
    for i in all {
        let i = obj_of(i, IDP_KEYS, IDP_REQUIRED, "an idp")?;
        if !i["id"].as_str().is_some_and(idp_id_ok) {
            return bad("an idp id must be 1 to 32 of a-z, 0-9 and -");
        }
        text(i.get("provider"), "an idp's provider", 1, 64)?;
        if !i["issuer"].as_str().is_some_and(|s| s.len() <= 1024 && https_url_ok(s)) {
            return bad("an idp issuer must be an https URL of at most 1024 characters");
        }
        strings(i.get("algs"), "an idp's algs", 1, 3, |a| FED_ALGS.contains(&a))?;
        if i.contains_key("tenant") {
            text(i.get("tenant"), "an idp's tenant", 1, 128)?;
        }
        int_in(i.get("max_age_s"), "max_age_s", 60, 600)?;
        if i.contains_key("auth_max_s") {
            int_in(i.get("auth_max_s"), "auth_max_s", 300, 86400)?;
        }
        bool_of(i.get("private_ok"), "private_ok")?;
        one_of(i.get("state"), &["active", "suspended"], "an idp state")?;
    }
    if !unique(texts_of(all, "id")) || !unique(texts_of(all, "issuer")) {
        return bad("two idps have the same id or issuer");
    }
    Ok(all)
}

/// The string field `f` of each entry of a list.
fn texts_of<'a>(list: &'a [Value], f: &'a str) -> impl Iterator<Item = &'a str> {
    list.iter().filter_map(move |x| x.get(f).and_then(Value::as_str))
}

fn has_id(list: &[Value], id: &str) -> bool {
    list.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(id))
}

/// Revision 5 3.2: the client fields of API-1c. `connectors` exactly for reach R1 (not compliance): 1 to 4 of the
/// map's; `apps` (1 to 16 of the listed connectors' apps) and `channels` (`["*"]` or 1 to 500 `ch:` cids) exactly with
/// a `content.*` scope; `confirm` 0 to 2 of the client's content scopes, holding `content.post` for an
/// `agent_delegated` client with it and for an `agent` with both content scopes (R5-14); `delegation` exactly for
/// `agent_delegated`; `redirect_uris` (0 to 8) only for it; `loopback_ok` only for it at reach R1.
fn check_client_1c(c: &Obj, kind: &str, reach: &str, scopes: &[&str], cx: &MapCtx) -> Res<()> {
    let content: Vec<&str> = scopes.iter().copied().filter(|s| s.starts_with("content.")).collect();
    // revision 6 2.2: a spokes_hub client needs no connector
    let listed = match (c.get("connectors"), reach == "R1" && !matches!(kind, "compliance" | "spokes_hub")) {
        (None, false) => Vec::new(),
        (Some(v), true) => strings(Some(v), "a client's connectors", 1, 4, |k| has_id(cx.connectors, k))?,
        (None, true) => return bad("a reach R1 client needs 1 to 4 connectors of the map"),
        (Some(_), false) => return bad("connectors go with a reach R1 app, agent or agent_delegated client only"),
    };
    if ["apps", "channels"].iter().any(|k| c.contains_key(*k) == content.is_empty()) {
        return bad("apps and channels go with a content scope, and are needed with it");
    }
    if !content.is_empty() {
        let held: Vec<&str> = cx
            .connectors
            .iter()
            .filter(|k| k.get("id").and_then(Value::as_str).is_some_and(|id| listed.contains(&id)))
            .flat_map(|k| k["apps"].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .collect();
        strings(c.get("apps"), "a client's apps", 1, 16, |a| held.contains(&a))?;
        let all = c["channels"].as_array().is_some_and(|a| a.len() == 1 && a[0] == "*");
        if !all {
            strings(c.get("channels"), "a client's channels", 1, 500, channel_ok)?;
        }
    }
    let confirm = match c.get("confirm") {
        None => Vec::new(),
        Some(v) if !content.is_empty() => strings(Some(v), "a client's confirm", 0, 2, |s| content.contains(&s))?,
        Some(_) => return bad("confirm goes with a content scope"),
    };
    let post = content.contains(&"content.post");
    let must = match kind {
        "agent_delegated" => post,
        "agent" => post && content.contains(&"content.read"),
        _ => false,
    };
    if must && !confirm.contains(&"content.post") {
        return bad("this client must confirm content.post: a person approves every post");
    }
    let delegated = kind == "agent_delegated";
    match (c.get("delegation"), delegated) {
        (None, false) => {}
        (Some(d), true) => check_delegation(d, cx)?,
        _ => return bad("an agent_delegated client needs its delegation, and only it takes one"),
    }
    if let Some(v) = c.get("redirect_uris") {
        if !delegated {
            return bad("redirect_uris are only for an agent_delegated client");
        }
        strings(Some(v), "a client's redirect_uris", 0, 8, redirect_ok)?;
    }
    if let Some(v) = c.get("loopback_ok") {
        if !(delegated && reach == "R1") {
            return bad("loopback_ok is only for an agent_delegated client of reach R1");
        }
        bool_of(Some(v), "loopback_ok")?;
    }
    Ok(())
}

/// Revision 5 3.2 `clients[].delegation`: `groups` 0 to 50 of the policy's `ai.who.groups`, `principals` 0 to 5000
/// persons of the policy's domains, at least one of the two non-empty; `idps` 0 to 8 of the map's; `consent_days` 1 to
/// 30; `denied` 0 to 5000 persons.
fn check_delegation(v: &Value, cx: &MapCtx) -> Res<()> {
    let o = obj_of(v, DELEGATION_KEYS, &[], "a client's delegation")?;
    let groups = cx.policy.map(who_groups);
    let domains = cx.policy.map(policy_domains);
    let g = strings(o.get("groups"), "delegation groups", 0, 50, |x| group_ok(x) && groups.as_ref().is_none_or(|w| w.contains(&x)))?;
    let in_org = |p: &str| domains.as_ref().is_none_or(|d| op::split_principal(p).is_ok_and(|(_, dom)| d.contains(&dom)));
    let p = strings(o.get("principals"), "delegation principals", 0, 5000, |x| person_ok(x) && in_org(x))?;
    if g.is_empty() && p.is_empty() {
        return bad("a delegation needs a group or a principal");
    }
    strings(o.get("idps"), "delegation idps", 0, 8, |i| has_id(cx.idps, i))?;
    if o.contains_key("consent_days") {
        int_in(o.get("consent_days"), "consent_days", 1, 30)?;
    }
    strings(o.get("denied"), "delegation denied", 0, 5000, person_ok)?;
    Ok(())
}

fn check_client(v: &Value, cx: &MapCtx) -> Res<()> {
    let (policy, origins, issued) = (cx.policy, cx.origins, cx.issued);
    let c = obj_of(v, CLIENT_KEYS, CLIENT_REQUIRED, "a client")?;
    if !prefixed_id(&c["id"], "c_") {
        return bad("a client id must be c_ and 16 lowercase hex");
    }
    let Some(name) = c["name"].as_str().filter(|n| slug(n, 32) && *n != "archive") else {
        return bad("a client name must be 1 to 32 of a-z, 0-9 and -, not archive");
    };
    let domain = c["principal"].as_str().and_then(|p| p.strip_prefix(name)).and_then(|r| r.strip_prefix("@apps.")).filter(|d| op::is_domain(d));
    let Some(domain) = domain else { return bad("a client principal must be <name>@apps.<domain>") };
    let kind = one_of(c.get("kind"), &KINDS, "a client kind")?;
    if !MAP_KINDS.contains(&kind) {
        return bad("API-1d accepts only monitoring, integration, compliance, app, agent, agent_delegated and spokes_hub clients");
    }
    let owner = c["owner"].as_str().and_then(|o| op::split_principal(o).ok()).filter(|(_, d)| !d.starts_with("apps."));
    let Some((_, owner_domain)) = owner else { return bad("a client owner must be a person principal") };
    let reach = one_of(c.get("reach"), &["R0", "R1"], "a client reach")?;
    let scopes = strings(c.get("scopes"), "a client's scopes", 1, 32, |s| scope_row(s).is_some())?;
    let hub = kind == "spokes_hub";
    let r1_kind = matches!(kind, "app" | "agent" | "agent_delegated" | "spokes_hub");
    if reach == "R1" && !r1_kind && !(kind == "compliance" && scopes == ["compliance.export.request"]) {
        return fail("reach", "reach R1 is only for app, agent, agent_delegated and spokes_hub clients and a compliance client whose one scope is compliance.export.request");
    }
    if kind == "app" && reach != "R1" {
        return fail("reach", "an app client is always reach R1");
    }
    if hub && reach != "R1" {
        return fail("reach", "a spokes_hub client is always reach R1");
    }
    // revision 6 4.1: a service hub holds exactly spokes.tasks.submit
    if hub && scopes != ["spokes.tasks.submit"] {
        return fail("scope-kind", "a spokes_hub client holds exactly the scope spokes.tasks.submit");
    }
    for s in &scopes {
        let (_, r, k) = scope_row(s).expect("a listed scope");
        // revision 6 9: spokes.read for monitoring and integration clients; spokes.tasks.submit for spokes_hub and, with
        // a2a (`check_client_a2a`), agent clients
        if *s == "spokes.read" && !matches!(kind, "monitoring" | "integration") {
            return fail("scope-kind", "spokes.read is only for monitoring and integration clients");
        }
        let partner = *s == "spokes.tasks.submit" && kind == "agent";
        if !k.is_empty() && k != kind && !partner {
            return fail("scope-kind", format!("{s} is only for {k} clients"));
        }
        if r != reach {
            return fail("reach", format!("{s} needs reach {r}"));
        }
    }
    let sensitive = scopes.iter().any(|s| s.starts_with("compliance.") || s.starts_with("directory."));
    let ceiling = one_of(c.get("ceiling"), &CEILINGS, "a client ceiling")?;
    if kind == "agent_delegated" && ceiling == "cui" {
        return fail("ceiling", "a delegated client takes no cui ceiling in API-1c");
    }
    if sensitive && !matches!(ceiling, "confidential" | "cui") {
        return fail("ceiling", "a client with a compliance or directory scope needs the ceiling confidential or cui");
    }
    // revision 6 2.2 and 4.1: a spokes_hub client needs the map's `spokes` and reaches only its spokes relays (`*`: all
    // of them), never a Meet relay or the console
    match (hub, &cx.spokes) {
        (false, _) => relays_ok(c.get("relays"), "a client's relays", origins)?,
        (true, None) => return bad("a map with a spokes_hub client needs the spokes key"),
        (true, Some(_)) if c["relays"].as_array().is_some_and(|a| a.len() == 1 && a[0] == "*") => {}
        (true, Some(bound)) => {
            strings(c.get("relays"), "a spokes_hub client's relays", 1, 64, |r| bound.contains(&r))?;
        }
    }
    let networks = strings(c.get("networks"), "a client's networks", 0, 32, cidr_ok)?;
    if let Some(h) = c.get("hours") {
        let h = obj_of(h, HOURS_KEYS, HOURS_KEYS, "a client's hours")?;
        let tz = h["tz"].as_str().is_some_and(tz_ok);
        let times = ["from", "to"].iter().all(|f| h[*f].as_str().is_some_and(hhmm_ok));
        let days = h["days"].as_array().is_some_and(|d| {
            (1..=7).contains(&d.len()) && d.iter().all(|x| int_of(x).is_some_and(|n| (1..=7).contains(&n))) && unique(d.iter().filter_map(int_of))
        });
        if !(tz && times && days) {
            return bad("a client's hours must be {tz, from: HH:MM, to: HH:MM, days: [1..7]}");
        }
    }
    let mtls_required = bool_of(c.get("mtls_required"), "mtls_required")?;
    // revision 6 2.2 and 15: a service hub signs every request with its node key, so it never takes mtls_required, and
    // its cui needs a hardware key_store (below) instead
    if hub && mtls_required {
        return bad("a spokes_hub client must set mtls_required false: its node key signs every request");
    }
    if ceiling == "cui" && !mtls_required && !hub {
        return bad("a cui client must set mtls_required");
    }
    let rate = obj_of(&c["rate"], RATE_KEYS, RATE_KEYS, "a client's rate")?;
    int_in(rate.get("per_minute_each"), "per_minute_each", 1, 6000)?;
    int_in(rate.get("per_day_each"), "per_day_each", 1, 10_000_000)?;
    let creds = list(c.get("credentials"), "a client's credentials", 1, 4)?;
    let mut wif = 0;
    let mut cimd = 0;
    for cr in creds {
        let ty = check_credential(cr)?;
        // revision 6 4.1 and 4.2: spokes_node credentials only, and only on a spokes_hub client
        if (ty == "spokes_node") != hub {
            return fail("credential", "a spokes_hub client takes spokes_node credentials only, and only it takes them");
        }
        if ty == "cimd" {
            cimd += 1;
            if kind != "agent_delegated" {
                return bad("a cimd credential is only for an agent_delegated client");
            }
        }
        if ty == "entra_wif" {
            wif += 1;
            let directory_only = scopes.iter().all(|s| s.starts_with("directory."));
            if kind != "integration" || !directory_only || networks.is_empty() || mtls_required {
                return fail("credential", "an entra_wif credential needs an integration client with directory scopes only, networks, and mtls_required false");
            }
            // RFC 10070 and ruling R4-D20 stage (a): the audience is the issuer identifier I until gate G-ENTRA-WIF-AUD
            // records that Entra cannot emit it
            if cr.get("audience").and_then(Value::as_str) != Some(cx.issuer_url) {
                return fail("credential", "an entra_wif credential's audience must be the map's issuer url");
            }
        }
        if mtls_required && ty != "mtls" {
            return bad("a client with mtls_required takes mtls credentials only");
        }
        if ty == "client_secret" {
            if kind != "monitoring" || networks.is_empty() || !scopes.iter().all(|s| SECRET_SCOPES.contains(s)) {
                return bad("a client_secret needs a monitoring client with networks and read scopes only (D11)");
            }
            int_in(cr.get("expires"), "a client_secret's expires", 1, issued + SECRET_DAYS_MAX * DAY)?;
        }
    }
    if wif > 1 {
        return fail("credential", "a client has at most one entra_wif credential");
    }
    if hub && creds.len() > 2 {
        return fail("credential", "a spokes_hub client has 1 or 2 spokes_node credentials");
    }
    // revision 6 2.2 (R6-4): cui only when every node key is in a hardware store
    let hardware = |cr: &Value| cr.get("key_store").and_then(Value::as_str).is_some_and(|k| HARDWARE_KEY_STORES.contains(&k));
    if hub && ceiling == "cui" && !creds.iter().all(hardware) {
        return fail("ceiling", "a spokes_hub client at cui needs every spokes_node key in pkcs11, azure_key_vault or tpm");
    }
    match (c.get("spokes"), hub) {
        (None, false) => {}
        (Some(s), true) => check_spokes_targets(s)?,
        _ => return bad("a spokes_hub client needs its spokes targets, and only it takes them"),
    }
    let writes = scopes.iter().any(|s| matches!(*s, "compliance.holds.write" | "compliance.export.request"));
    if writes && !(mtls_required && creds.iter().any(|cr| cr.get("type").and_then(Value::as_str) == Some("mtls"))) {
        return fail("mtls-needed", "a client with compliance.holds.write or compliance.export.request needs mtls_required and an mtls credential");
    }
    if !unique(creds.iter().filter_map(|cr| cr.get("kid").and_then(Value::as_str))) {
        return bad("a client lists a credential kid twice");
    }
    let created = int_in(c.get("created"), "a client's created", 1, MAX_INT)?;
    let expires = int_in(c.get("expires"), "a client's expires", 1, MAX_INT)?;
    if expires <= created || expires - created > CLIENT_SPAN_MAX {
        return bad("a client lasts at most 366 days");
    }
    one_of(c.get("state"), &["active", "suspended"], "a client state")?;
    // revision 5 4.1: one cimd credential at most, ending no later than the client
    if cimd > 1 {
        return bad("a client has at most one cimd credential");
    }
    if creds.iter().any(|cr| cr.get("type").and_then(Value::as_str) == Some("cimd") && cr.get("expires").and_then(int_of).is_some_and(|e| e > expires)) {
        return bad("a cimd credential ends no later than its client");
    }
    check_compliance(c.get("compliance"), &scopes)?;
    check_directory(c.get("directory"), &scopes, cx)?;
    check_client_1c(c, kind, reach, &scopes, cx)?;
    check_client_a2a(c, kind, &scopes, cx.agents)?;
    if let Some(p) = policy {
        let domains = policy_domains(p);
        if !domains.contains(&domain) {
            return bad("a client principal must be on one of the policy's domains");
        }
        if !domains.contains(&owner_domain) {
            return bad("a client owner must be a person of the org");
        }
        if app_names(p).contains(&name) {
            return bad("a client name must not be the name of an app of the policy");
        }
    }
    Ok(())
}

/// Section 4.2; returns the credential's type.
fn check_credential(v: &Value) -> Res<&str> {
    let ty = one_of(v.get("type"), &CRED_TYPES, "a credential type")?;
    let c: &Obj = match ty {
        "mtls" => {
            let c = obj_of(v, &["type", "serial", "spki"], &["type", "serial", "spki"], "an mtls credential")?;
            let serial = c["serial"].as_str().is_some_and(|s| (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            if !serial || !c["spki"].as_str().is_some_and(|s| hex_n(s, 64)) {
                return bad("an mtls credential needs a hex serial and a 64 hex spki");
            }
            return Ok(ty);
        }
        "private_key_jwt" if v.get("jwks_uri").is_some() => {
            let c = obj_of(v, &["type", "jwks_uri", "private_ok", "expires"], &["type", "jwks_uri", "private_ok", "expires"], "a private_key_jwt credential")?;
            if !c["jwks_uri"].as_str().is_some_and(https_url_ok) {
                return bad("jwks_uri must be an https URL");
            }
            bool_of(c.get("private_ok"), "private_ok")?;
            c
        }
        "private_key_jwt" => {
            let c = obj_of(v, &["type", "kid", "jwk", "expires"], &["type", "kid", "jwk", "expires"], "a private_key_jwt credential")?;
            if !c["kid"].as_str().is_some_and(|k| token(k, 64)) || !jwk_ok(&c["jwk"]) {
                return bad("a private_key_jwt credential needs a kid and an EC P-256 or RSA 3072+ public key");
            }
            c
        }
        "federated" => {
            let k = &["type", "issuer", "audience", "subject", "algs", "private_ok", "expires"];
            let c = obj_of(v, k, k, "a federated credential")?;
            if !c["issuer"].as_str().is_some_and(https_url_ok) {
                return bad("a federated issuer must be an https URL");
            }
            text(c.get("audience"), "audience", 1, 256)?;
            text(c.get("subject"), "subject", 1, 256)?;
            strings(c.get("algs"), "algs", 1, 3, |a| FED_ALGS.contains(&a))?;
            bool_of(c.get("private_ok"), "private_ok")?;
            c
        }
        // revision 4 4.1 (v2); the audience and the client's rules are checked with the client
        "entra_wif" => {
            let k = &["type", "cloud", "tenant", "audience", "azp", "expires"];
            let c = obj_of(v, k, k, "an entra_wif credential").map_err(|e| ApiMapError::new("credential", e.message))?;
            let ok = matches!(c["cloud"].as_str(), Some("public" | "usgov"))
                && c["tenant"].as_str().is_some_and(guid_ok)
                && c["azp"].as_str().is_some_and(guid_ok)
                && c["audience"].as_str().is_some_and(|a| ascii_text(a, 1, 512));
            if !ok {
                return fail("credential", "an entra_wif credential needs cloud public or usgov, a lowercase GUID tenant and azp, and an audience");
            }
            c
        }
        // revision 5 4.1; the client's rules are checked with the client
        "cimd" => {
            let k = &["type", "url", "private_ok", "expires"];
            let c = obj_of(v, k, k, "a cimd credential")?;
            if !c["url"].as_str().is_some_and(https_url_ok) {
                return bad("a cimd url must be an https URL");
            }
            bool_of(c.get("private_ok"), "private_ok")?;
            c
        }
        // revision 6 4.2: the service hub's node certificate (serial as identity.rs reads it) and its key store; the
        // client's rules are checked with the client
        "spokes_node" => {
            let c = obj_of(v, SPOKES_NODE_KEYS, SPOKES_NODE_KEYS, "a spokes_node credential")?;
            let ok = c["node"].as_str().is_some_and(is_node_id) && c["serial"].as_str().is_some_and(is_serial) && c["spki"].as_str().is_some_and(|s| hex_n(s, 64));
            if !ok {
                return bad("a spokes_node credential needs a node id (n_ and 32 lowercase hex), a 32 hex serial and a 64 hex spki");
            }
            one_of(c.get("key_store"), &KEY_STORES, "a spokes_node key_store (never a plain file)")?;
            c
        }
        _ => {
            let k = &["type", "sha256", "hint", "expires"];
            let c = obj_of(v, k, k, "a client_secret credential")?;
            if !c["sha256"].as_str().is_some_and(|h| hex_n(h, 64)) || text(c.get("hint"), "hint", 8, 8).is_err() {
                return bad("a client_secret needs a 64 hex sha256 and an 8 character hint");
            }
            c
        }
    };
    int_in(c.get("expires"), "a credential's expires", 1, MAX_INT)?;
    Ok(ty)
}

fn jwk_ok(v: &Value) -> bool {
    let Some(k) = v.as_object() else { return false };
    let s = |f: &str| k.get(f).and_then(Value::as_str);
    match s("kty") {
        Some("EC") => k.len() == 4 && s("crv") == Some("P-256") && s("x").is_some_and(|x| b64u(x, 43, 43)) && s("y").is_some_and(|y| b64u(y, 43, 43)),
        Some("RSA") => k.len() == 3 && s("n").is_some_and(|n| b64u(n, 512, usize::MAX) && n.len() % 4 != 1) && s("e").is_some_and(|e| b64u(e, 2, 11) && e.len() % 4 != 1),
        _ => false,
    }
}

fn coded(code: &'static str) -> impl Fn(ApiMapError) -> ApiMapError {
    move |e| ApiMapError::new(code, e.message)
}

/// Revision 4 2.2 `clients[].compliance` (v2): present exactly with a `compliance.*` scope; `holds_per_day` exactly
/// with `compliance.holds.write`; `recipient` and the three byte and job caps together exactly with
/// `compliance.export.request`.
fn check_compliance(v: Option<&Value>, scopes: &[&str]) -> Res<()> {
    let any = scopes.iter().any(|s| s.starts_with("compliance."));
    let v = match (v, any) {
        (None, false) => return Ok(()),
        (Some(v), true) => v,
        _ => return bad("a client has a compliance block exactly when it has a compliance scope"),
    };
    let o = obj_of(v, &["holds_per_day", "recipient", "job_max_bytes", "day_max_bytes", "jobs_per_day"], &[], "a client's compliance")?;
    let holds = scopes.contains(&"compliance.holds.write");
    if o.contains_key("holds_per_day") != holds {
        return bad("holds_per_day goes with compliance.holds.write, and only with it");
    }
    if holds {
        int_in(o.get("holds_per_day"), "holds_per_day", 1, 100)?;
    }
    let export = scopes.contains(&"compliance.export.request");
    if ["recipient", "job_max_bytes", "day_max_bytes", "jobs_per_day"].iter().any(|k| o.contains_key(*k) != export) {
        return bad("recipient, job_max_bytes, day_max_bytes and jobs_per_day go together with compliance.export.request, and only with it");
    }
    if export {
        let r = obj_of(&o["recipient"], &["kid", "jwk"], &["kid", "jwk"], "a recipient").map_err(coded("recipient"))?;
        let jwk = obj_of(&r["jwk"], &["kty", "crv", "x", "y"], &["kty", "crv", "x", "y"], "a recipient key").map_err(coded("recipient"))?;
        let ok = r["kid"].as_str().is_some_and(|k| token(k, 64))
            && jwk["kty"] == "EC"
            && jwk["crv"] == "P-256"
            && ["x", "y"].iter().all(|f| jwk[*f].as_str().is_some_and(|s| b64u(s, 43, 43)));
        if !ok {
            return fail("recipient", "a recipient must be {kid, jwk} with an EC P-256 public key");
        }
        let job = int_in(o.get("job_max_bytes"), "job_max_bytes", 1 << 20, 50 << 30)?;
        int_in(o.get("day_max_bytes"), "day_max_bytes", job, 200 << 30)?;
        int_in(o.get("jobs_per_day"), "jobs_per_day", 1, 20)?;
    }
    Ok(())
}

/// Revision 4 2.2 `clients[].directory` (v2), `directory` for every rule: present exactly with a `directory.*`
/// scope; `provider` 1 to 64 characters (checked against the signer policy's registry by `check_providers`);
/// `resource` exactly `https://<host>:<port>/api/orgs/<org>/scim/v2`; `domains` 1 to 16, of the org policy.
fn check_directory(v: Option<&Value>, scopes: &[&str], cx: &MapCtx) -> Res<()> {
    let any = scopes.iter().any(|s| s.starts_with("directory."));
    let v = match (v, any) {
        (None, false) => return Ok(()),
        (Some(v), true) => v,
        _ => return fail("directory", "a client has a directory block exactly when it has a directory scope"),
    };
    let k = &["provider", "resource", "domains"];
    let o = obj_of(v, k, k, "a client's directory").map_err(coded("directory"))?;
    if !o["provider"].as_str().is_some_and(|p| ascii_text(p, 1, 64)) {
        return fail("directory", "a directory provider must be 1 to 64 characters");
    }
    let resource = o["resource"].as_str().unwrap_or_default();
    let suffix = format!("/api/orgs/{}/scim/v2", cx.org);
    let ok = resource.len() <= 512 && resource.strip_prefix("https://").and_then(|r| r.strip_suffix(&suffix)).is_some_and(|a| !a.contains('/') && authority_ok(a));
    if !ok {
        return fail("directory", "a directory resource must be https://<host>:<port>/api/orgs/<org>/scim/v2");
    }
    let domains = strings(o.get("domains"), "directory domains", 1, 16, op::is_domain).map_err(coded("directory"))?;
    if let Some(p) = cx.policy {
        let held = policy_domains(p);
        if !domains.iter().all(|d| held.contains(d)) {
            return fail("directory", "directory domains must be the org policy's domains");
        }
    }
    Ok(())
}

/// Revision 4 2.2 `compliance.recipient`: distinct from every credential key of the map (`recipient`).
fn check_recipients(clients: &[Value]) -> Res<()> {
    let xy = |k: &Value| Some((k.get("x")?.as_str()?.to_string(), k.get("y")?.as_str()?.to_string()));
    let creds: BTreeSet<(String, String)> = clients
        .iter()
        .flat_map(|c| c.get("credentials").and_then(Value::as_array).into_iter().flatten())
        .filter_map(|cr| cr.get("jwk").and_then(xy))
        .collect();
    let mut seen = BTreeSet::new();
    for r in clients.iter().filter_map(|c| c.pointer("/compliance/recipient/jwk")).filter_map(xy) {
        if creds.contains(&r) || !seen.insert(r) {
            return fail("recipient", "a recipient key must differ from every credential key of the map");
        }
    }
    Ok(())
}

/// Revision 4 2.2 `directory.provider`: on a relay, each client's provider must be an `identity_providers` entry of
/// the org in the root-signed signer policy it holds (`directory`).
pub fn check_providers(map: &Value, terms: &op::SignerTerms) -> Result<(), ApiMapError> {
    let org = map.get("org").and_then(Value::as_str).unwrap_or_default();
    let providers = map.get("clients").and_then(Value::as_array).into_iter().flatten().filter_map(|c| c.pointer("/directory/provider")).filter_map(Value::as_str);
    for p in providers {
        if terms.provider(org, p).is_none() {
            return fail("directory", format!("the signer policy lists no identity provider {p} for {org}"));
        }
    }
    Ok(())
}

/// Revision 5 3.2 `idps[].provider` and `issuer` (R5-9) and ruling O16, `idp` for every rule: each idp's provider is
/// an `identity_providers` entry of the org in the root-signed signer policy, its issuer is that entry's tenant
/// (Okta: exactly `https://<the entry's host>`, the org authorization server, never `/oauth2/<id>`; every other kind:
/// the entry's `iss`), and a map with an `agent_delegated` client needs a registry provider for the org (ID-1 SSO).
pub fn check_idps(map: &Value, terms: &op::SignerTerms) -> Result<(), ApiMapError> {
    let org = map.get("org").and_then(Value::as_str).unwrap_or_default();
    for i in map.get("idps").and_then(Value::as_array).into_iter().flatten() {
        let field = |k: &str| i.get(k).and_then(Value::as_str).unwrap_or_default();
        let Some(entry) = terms.provider(org, field("provider")) else {
            return fail("idp", format!("the signer policy lists no identity provider {} for {org}", field("provider")));
        };
        if !same_tenant(&entry.kind, &entry.iss, field("issuer")) {
            return fail("idp", format!("the issuer of idp {} is not the tenant of identity provider {}", field("id"), entry.id));
        }
    }
    let delegated = map.get("clients").and_then(Value::as_array).into_iter().flatten().any(|c| c.get("kind").and_then(Value::as_str) == Some("agent_delegated"));
    if delegated && terms.providers_of(org).is_empty() {
        return fail("idp", format!("an agent_delegated client needs an ID-1 identity provider of {org} in the signer policy"));
    }
    Ok(())
}

/// R5-9: whether an ID-JAG issuer is the tenant of a registry entry (`kind`, `iss`).
fn same_tenant(kind: &str, iss: &str, issuer: &str) -> bool {
    if kind == "okta" {
        let host = iss.strip_prefix("https://").map(|r| r.split('/').next().unwrap_or_default()).unwrap_or_default();
        !host.is_empty() && issuer.strip_prefix("https://") == Some(host)
    } else {
        issuer == iss
    }
}

/// Revision 4 2.2 `webhook_keys` (v2), `webhook` for every rule: 0 to 2 `{kid, public, nbf, exp}` with `public`
/// `whpk_` and the base64 of a 32-byte Ed25519 key, at most 400 days each; one valid at `issued` when any webhook
/// signs `v2a`.
fn check_webhook_keys(v: Option<&Value>, issued: i64, v2a: bool) -> Res<()> {
    let keys = list(v, "webhook_keys", 0, 2).map_err(coded("webhook"))?;
    for k in keys {
        let f = &["kid", "public", "nbf", "exp"];
        let k = obj_of(k, f, f, "a webhook key").map_err(coded("webhook"))?;
        let public = k["public"].as_str().and_then(|p| p.strip_prefix("whpk_")).and_then(pj::b64_strict).is_some_and(|b| b.len() == 32);
        let (nbf, exp) = (int_of(&k["nbf"]).unwrap_or(-1), int_of(&k["exp"]).unwrap_or(-1));
        if !k["kid"].as_str().is_some_and(|s| token(s, 64)) || !public || nbf < 0 || nbf >= exp || exp - nbf > JWKS_SPAN_MAX {
            return fail("webhook", "a webhook key must be {kid, public: whpk_<32 bytes>, nbf, exp} lasting at most 400 days");
        }
    }
    if !unique(keys.iter().filter_map(|k| k.get("kid").and_then(Value::as_str))) {
        return fail("webhook", "two webhook keys have the same kid");
    }
    let valid = |k: &Value| int_of(&k["nbf"]).is_some_and(|n| n <= issued) && int_of(&k["exp"]).is_some_and(|e| e > issued);
    if v2a && !keys.iter().any(valid) {
        return fail("webhook", "a webhook that signs v2a needs a webhook key valid when the map is issued");
    }
    Ok(())
}

/// Revision 4 2.2 `federation` (v2), `federation` for every rule: an https issuer and 1 to 2 RS256 keys of 3072 to
/// 4096 bits.
fn check_federation(v: &Value) -> Res<()> {
    let o = obj_of(v, &["issuer", "keys"], &["issuer", "keys"], "federation").map_err(coded("federation"))?;
    if !o["issuer"].as_str().is_some_and(|i| i.len() <= 512 && https_url_ok(i)) {
        return fail("federation", "federation.issuer must be an https URL of at most 512 characters");
    }
    let keys = list(o.get("keys"), "federation.keys", 1, 2).map_err(coded("federation"))?;
    for k in keys {
        let f = &["kty", "kid", "n", "e", "alg", "use", "nbf", "exp"];
        let k = obj_of(k, f, f, "a federation key").map_err(coded("federation"))?;
        let fixed = [("kty", "RSA"), ("e", "AQAB"), ("alg", "RS256"), ("use", "sig")].iter().all(|(f, want)| k[*f].as_str() == Some(*want));
        let bits = k["n"].as_str().and_then(modulus_bits).is_some_and(|b| (3072..=4096).contains(&b));
        let (nbf, exp) = (int_of(&k["nbf"]).unwrap_or(-1), int_of(&k["exp"]).unwrap_or(-1));
        if !fixed || !bits || !k["kid"].as_str().is_some_and(|s| token(s, 64)) || nbf < 0 || nbf >= exp || exp - nbf > JWKS_SPAN_MAX {
            return fail("federation", "a federation key must be an RS256 signing key of 3072 to 4096 bits with e AQAB, lasting at most 400 days");
        }
    }
    if !unique(keys.iter().filter_map(|k| k.get("kid").and_then(Value::as_str))) {
        return fail("federation", "two federation keys have the same kid");
    }
    Ok(())
}

/// The id of the client whose grant selects a destination's events, when it names one and it holds
/// `events.subscribe` in this map.
fn events_client_ok(id: Option<&Value>, clients: &[Value]) -> bool {
    let Some(id) = id.and_then(Value::as_str) else { return false };
    clients.iter().any(|c| c.get("id").and_then(Value::as_str) == Some(id) && c.get("scopes").and_then(Value::as_array).is_some_and(|s| s.iter().any(|x| x.as_str() == Some("events.subscribe"))))
}

/// Revision 4 2.2 webhook `settings`, `webhook` for every rule.
fn check_webhook_settings(v: Option<&Value>) -> Res<()> {
    let f = &["client", "types", "signing", "verification"];
    let s = obj_of(v.unwrap_or(&Value::Null), f, f, "a webhook's settings").map_err(coded("webhook"))?;
    strings(s.get("types"), "a webhook's types", 0, 64, |t| EVENT_TYPES.contains(&t)).map_err(coded("webhook"))?;
    if !matches!(s["signing"].as_str(), Some("v2a" | "v1")) || !matches!(s["verification"].as_str(), Some("wev" | "none")) {
        return fail("webhook", "a webhook signs v2a or v1 and verifies wev or none");
    }
    Ok(())
}

/// Revision 4 2.2 `entra_federated` for the Azure presets and `gcp_federated` for `google_cloud` (v2).
fn check_federated_credential(cr: &Value, preset: &str) -> Res<()> {
    if cr.get("type").and_then(Value::as_str) == Some("entra_federated") {
        let f = &["type", "tenant", "client_id", "cloud", "audience"];
        let c = obj_of(cr, f, f, "an entra_federated credential")?;
        let ok = (preset.starts_with("azure_monitor") || preset.starts_with("sentinel"))
            && ["tenant", "client_id"].iter().all(|k| c[*k].as_str().is_some_and(|s| ascii_text(s, 1, 256)))
            && matches!(c["cloud"].as_str(), Some("public" | "usgov"))
            && c["audience"].as_str().is_some_and(|a| ascii_text(a, 1, 600));
        return if ok { Ok(()) } else { bad("an entra_federated credential needs an Azure preset, tenant, client_id, cloud public or usgov, and an audience") };
    }
    let c = obj_of(cr, &["type", "audience", "token_audience", "service_account"], &["type", "audience", "token_audience"], "a gcp_federated credential")?;
    let provider = c["audience"].as_str().and_then(|a| a.strip_prefix("//iam.googleapis.com/projects/")).and_then(|r| {
        let (number, rest) = r.split_once("/locations/global/workloadIdentityPools/")?;
        let (pool, provider) = rest.split_once("/providers/")?;
        Some((1..=20).contains(&number.len()) && number.bytes().all(|b| b.is_ascii_digit()) && slug(pool, 63) && slug(provider, 63))
    });
    let account = c.get("service_account").is_none_or(|s| s.as_str().is_some_and(|s| ascii_text(s, 3, 254) && op::split_principal(s).is_ok()));
    let ok = preset == "google_cloud" && provider == Some(true) && c["token_audience"].as_str().is_some_and(|a| ascii_text(a, 1, 600)) && account;
    if ok {
        Ok(())
    } else {
        bad("a gcp_federated credential needs the google_cloud preset, a workload identity provider audience, a token_audience and an optional service account")
    }
}

fn check_destination(v: &Value, clients: &[Value], federation: bool) -> Res<()> {
    let d = obj_of(v, DEST_KEYS, DEST_REQUIRED, "a destination")?;
    if !prefixed_id(&d["id"], "d_") {
        return bad("a destination id must be d_ and 16 lowercase hex");
    }
    text(d.get("name"), "a destination name", 1, 64)?;
    let kind = one_of(d.get("kind"), &["otlp", "splunk_hec", "azure_logs", "syslog_cef", "webhook"], "a destination kind")?;
    let presets: &[&str] = match kind {
        "otlp" => &OTLP_PRESETS,
        "splunk_hec" => &["splunk_hec", "splunk_cloud_gov"],
        "azure_logs" => &["sentinel", "sentinel_gov"],
        "webhook" => &["webhook"],
        _ => &["syslog_cef"],
    };
    let preset = one_of(d.get("preset"), presets, "a destination preset")?;
    let signals = strings(d.get("signals"), "a destination's signals", 1, 5, |s| SIGNALS_V2.contains(&s))?;
    let events = signals.contains(&"events");
    if kind == "webhook" && signals != ["events"] {
        return fail("webhook", "a webhook carries exactly the events signal");
    }
    if kind == "syslog_cef" && events {
        return fail("webhook", "a syslog_cef destination does not carry events");
    }
    let carried: &[&str] = match kind {
        "otlp" => &SIGNALS,
        "webhook" => &[],
        _ => &["logs", "audit"],
    };
    if signals.iter().any(|s| *s != "events" && !carried.contains(s)) {
        return bad("a destination's signals must be ones its kind carries");
    }
    one_of(d.get("ceiling"), &CEILINGS, "a destination ceiling")?;
    one_of(d.get("identities"), &IDENTITIES, "a destination's identities")?;
    bool_of(d.get("failover"), "failover")?;
    bool_of(d.get("private_ok"), "private_ok")?;
    if d.get("endpoint").is_some_and(|e| !e.as_str().is_some_and(https_url_ok)) {
        return bad("a destination endpoint must be an https URL");
    }
    if kind == "webhook" {
        if d.get("endpoint").is_none() {
            return fail("webhook", "a webhook needs its endpoint");
        }
        check_webhook_settings(d.get("settings"))?;
    } else if let Some(s) = d.get("settings") {
        check_settings(kind, s)?;
    }
    // Rev4Review R4-10: every events destination names the client whose grant selects its events
    let named = d.get("settings").and_then(|s| s.get(if kind == "webhook" { "client" } else { "events_client" }));
    if events && !events_client_ok(named, clients) {
        return fail("webhook", "a destination of events must name a client of this map that holds events.subscribe");
    }
    if !events && named.is_some() {
        return fail("webhook", "events_client goes with the events signal only");
    }
    if kind == "azure_logs" && events != d.get("settings").is_some_and(|s| s.get("events_stream").is_some()) {
        return bad("events_stream goes with the events signal, and is needed with it");
    }
    if kind == "webhook" {
        let cr = d.get("credential").unwrap_or(&Value::Null);
        let want_ref = format!("secret:{}", d["id"].as_str().unwrap_or_default());
        let ok = match cr.get("type").and_then(Value::as_str) {
            Some("none") => cr.as_object().is_some_and(|o| o.len() == 1),
            Some("token" | "mtls") => cr.as_object().is_some_and(|o| o.len() == 2) && cr.get("ref").and_then(Value::as_str) == Some(want_ref.as_str()),
            _ => false,
        };
        if !ok {
            return fail("webhook", "a webhook credential is {type: none}, or token or mtls referenced as secret:<id>");
        }
    } else if let Some(cr) = d.get("credential").filter(|cr| matches!(cr.get("type").and_then(Value::as_str), Some("entra_federated" | "gcp_federated"))) {
        check_federated_credential(cr, preset)?;
        if !federation {
            return fail("federation", "a federated destination credential needs the map's federation");
        }
    } else if let Some(cr) = d.get("credential") {
        let ty = one_of(cr.get("type"), &["entra_certificate", "aws_roles_anywhere", "gcp_service_account_key", "mtls", "token"], "a destination credential type")?;
        let (allowed, fields): (bool, &[&str]) = match ty {
            "entra_certificate" => (preset.starts_with("azure_monitor") || preset.starts_with("sentinel"), &["tenant", "client_id", "cloud"]),
            "aws_roles_anywhere" => (preset.starts_with("cloudwatch"), &["trust_anchor_arn", "profile_arn", "role_arn", "region"]),
            "gcp_service_account_key" => (preset == "google_cloud", &[]),
            "mtls" => (matches!(preset, "syslog_cef" | "otlp_generic"), &[]),
            _ => (TOKEN_PRESETS.contains(&preset), &[]),
        };
        let keys: Vec<&str> = ["type", "ref"].into_iter().chain(fields.iter().copied()).collect();
        let c = obj_of(cr, &keys, &keys, "a destination credential")?;
        let want_ref = format!("secret:{}", d["id"].as_str().unwrap_or_default());
        if !allowed || c["ref"].as_str() != Some(want_ref.as_str()) {
            return bad("a destination credential must fit its preset and be referenced as secret:<id>");
        }
        for f in fields {
            text(c.get(*f), f, 1, 256)?;
        }
        if ty == "entra_certificate" {
            one_of(c.get("cloud"), &["public", "usgov"], "cloud")?;
        }
    }
    let q = obj_of(&d["queue"], QUEUE_KEYS, QUEUE_KEYS, "a destination queue")?;
    int_in(q.get("max_bytes"), "queue.max_bytes", 64 << 20, 64 << 30)?;
    int_in(q.get("max_age_s"), "queue.max_age_s", 3600, 2_592_000)?;
    Ok(())
}

/// Section 11.1 `settings` per kind (values are checked by type).
fn check_settings(kind: &str, v: &Value) -> Res<()> {
    let keys: &[&str] = match kind {
        "otlp" => &["endpoints", "temporality", "headers", "sampling", "events_client"],
        "splunk_hec" => &["index", "sourcetypes", "ack", "events_client"],
        "azure_logs" => &["dce", "dcr_immutable_id", "stream", "events_client", "events_stream"],
        _ => &["host", "port", "caPem", "clientCertPem", "events", "includeReasons"],
    };
    let s = obj_of(v, keys, &[], "a destination's settings")?;
    for (k, val) in s {
        let ok = match k.as_str() {
            // revision 4 2.2 (v2): judged with the destination's signals
            "events_client" => prefixed_id(val, "c_"),
            "events_stream" => val.as_str().and_then(|s| s.strip_prefix("Custom-")).is_some_and(|r| {
                (1..=40).contains(&r.len()) && r.ends_with("_CL") && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            }),
            "endpoints" => {
                obj_of(val, &["traces", "metrics", "logs"], &[], "endpoints")?;
                val.as_object().is_some_and(|e| e.values().all(|u| u.as_str().is_some_and(https_url_ok)))
            }
            "temporality" => matches!(val.as_str(), Some("delta" | "cumulative")),
            "headers" | "sourcetypes" | "events" => val.as_array().is_some_and(|a| {
                a.len() <= 32 && a.iter().all(|x| x.as_str().is_some_and(|x| ascii_text(x, 1, 128))) && unique(a.iter().filter_map(Value::as_str))
            }),
            // parts per million (no floats)
            "sampling" => int_of(val).is_some_and(|n| (0..=1_000_000).contains(&n)),
            "ack" => val.as_bool() == Some(true),
            "includeReasons" => val.is_boolean(),
            "port" => int_of(val).is_some_and(|n| (1..=65535).contains(&n)),
            "dce" => val.as_str().is_some_and(https_url_ok),
            "caPem" | "clientCertPem" => val.as_str().is_some_and(|p| ascii_text(&p.replace('\n', " "), 1, 16384)),
            _ => val.as_str().is_some_and(|x| ascii_text(x, 1, 256)),
        };
        if !ok {
            return bad(format!("a destination setting {k} is not valid"));
        }
    }
    Ok(())
}

/// Section 13: the `standard` edition's limits (`license`).
fn check_standard(clients: &[Value], dests: &[Value]) -> Res<()> {
    if clients.len() > 5 {
        return fail("license", "the standard edition allows at most 5 API clients");
    }
    // revision 5 15: the app, agent and agent_delegated clients are enterprise
    if clients.iter().any(|c| matches!(c["kind"].as_str(), Some("app" | "agent" | "agent_delegated"))) {
        return fail("license", "the standard edition has no app, agent or agent_delegated clients");
    }
    let wide = clients.iter().flat_map(|c| c["scopes"].as_array().into_iter().flatten()).any(|s| !s.as_str().is_some_and(|s| STANDARD_SCOPES.contains(&s)));
    if wide {
        return fail("license", "the standard edition allows the scopes monitor.read, fleet.read, audit.read and events.subscribe only");
    }
    let count = |k: &str| dests.iter().filter(|d| d["kind"].as_str() == Some(k)).count();
    if count("otlp") > 1 || count("splunk_hec") > 0 || count("azure_logs") > 0 {
        return fail("license", "the standard edition allows one otlp destination plus syslog_cef");
    }
    if dests.iter().any(|d| d["identities"].as_str() == Some("pseudonymized") || d["failover"].as_bool() == Some(true)) {
        return fail("license", "the standard edition has no pseudonymized identities and no failover");
    }
    // revision 4 16
    let events = |d: &Value| d["signals"].as_array().is_some_and(|s| s.iter().any(|x| x.as_str() == Some("events")));
    if count("webhook") > 0 || dests.iter().any(events) {
        return fail("license", "the standard edition has no webhooks and no events signal on destinations");
    }
    Ok(())
}

// ---- 2.3 and 2.4: signing and pinning ---------------------------------------------------------------------------

/// `lp("lucid-meet-org-api-v1", canonical JSON of the map)` (empty JSON for a map canonical JSON refuses: every
/// caller checks the map first).
pub fn api_map_bytes(map: &Value) -> Vec<u8> {
    let json = canonical_json(map).unwrap_or_default();
    lp(&[API_MAP_LABEL.as_bytes(), &json])
}

/// Hex SHA-256 of the map's signed bytes.
pub fn api_map_hash(map: &Value) -> String {
    sha256_hex(&api_map_bytes(map))
}

/// A verified signed api map.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedApiMap {
    /// `{map, sig, chain}` as signed.
    pub wire: Obj,
    pub org: String,
    pub seq: i64,
    pub expires: i64,
    pub hash: String,
    /// "root" or the intermediate's serial (hex).
    pub signer: String,
}

impl VerifiedApiMap {
    /// The map a relay already verified (from its store).
    fn of_wire(wire: Obj, signer: String) -> Option<VerifiedApiMap> {
        let m = wire.get("map")?.as_object()?;
        let org = m.get("org")?.as_str()?.to_string();
        let (seq, expires) = (int_of(m.get("seq")?)?, int_of(m.get("expires")?)?);
        let hash = api_map_hash(&wire["map"]);
        Some(VerifiedApiMap { wire, org, seq, expires, hash, signer })
    }

    pub fn map(&self) -> &Obj {
        self.wire.get("map").and_then(Value::as_object).expect("a verified map")
    }

    fn issuer_url(&self) -> &str {
        self.map().get("issuer").and_then(|i| i.get("url")).and_then(Value::as_str).unwrap_or_default()
    }
}

/// What a relay checks a signed map against (meet_org_policy::verify's inputs).
pub struct ApiTrust<'a> {
    pub root: &'a Cert,
    pub signer_policy: &'a Obj,
    pub root_crl: Option<&'a Crl>,
    pub previous_serial: &'a str,
}

/// A relay's check of a signed api map, as `verify_ai_map`: the root-signed signer policy, the signature by the root
/// or the signer's current (or previous) intermediate valid at `issued` and not in the root's CRL (`signature`), every
/// field rule (`check_api_map`), an org the root assigned domains to (`signature`), then `expires > now`
/// (`map-expired`). The caller pins with `pin_verdict`.
#[allow(clippy::too_many_arguments)]
pub fn verify_api_map(
    wire: &Value,
    root: &Cert,
    signer_policy: &Obj,
    root_crl: Option<&Crl>,
    previous_serial: &str,
    now: i64,
    policy: Option<&Obj>,
    edition: Edition,
    held_issuers: &BTreeMap<String, String>,
) -> Result<VerifiedApiMap, ApiMapError> {
    let w = obj_of(wire, WIRE_KEYS, WIRE_KEYS, "the signed api map")?;
    if canonical_json(wire).map_err(|e| bad_e(format!("the signed api map: {e}")))?.len() > API_WIRE_MAX {
        return bad("the signed api map is larger than 256 KiB");
    }
    let Some(issued) = w["map"].get("issued").and_then(int_of).filter(|n| (1..=MAX_INT).contains(n)) else {
        return bad("the api map needs issued");
    };
    if !op::verify_signer_policy(root, signer_policy) {
        return Err(sig_e("the signer policy is not signed by the root"));
    }
    let terms = op::signer_terms(signer_policy).map_err(sig_e)?;
    let sig = w["sig"].as_str().and_then(pj::b64_strict).ok_or_else(|| sig_e("sig must be base64"))?;
    let chain = match &w["chain"] {
        Value::Array(c) if c.len() <= 1 && c.iter().all(Value::is_string) => c,
        _ => return Err(sig_e("chain must be [] or [one intermediate PEM]")),
    };
    let inter = match chain.first().and_then(Value::as_str) {
        Some(pem) => Some(Some(pem).filter(|p| p.is_ascii()).and_then(Cert::from_pem).ok_or_else(|| sig_e("the chain is not a certificate"))?),
        None => None,
    };
    let signer = match &inter {
        Some(c) => op::check_intermediate(c, root, &terms, previous_serial, issued, root_crl).map_err(|e| sig_e(e.to_string()))?,
        None => "root".to_string(),
    };
    canonical_json(&w["map"]).map_err(|e| bad_e(format!("the api map: {e}")))?;
    let data = api_map_bytes(&w["map"]);
    let spki = inter.as_ref().map_or(&root.spki, |c| &c.spki);
    if !ecdsa_sha256_verified(spki, &data, &sig) {
        return Err(sig_e("the api map's signature does not verify"));
    }
    if !w["map"].get("org").and_then(Value::as_str).is_some_and(|o| terms.org_domains.contains_key(o)) {
        return Err(sig_e(op::DOMAIN_REFUSED));
    }
    check_api_map(&w["map"], now, policy, edition, held_issuers)?;
    check_providers(&w["map"], &terms)?;
    check_idps(&w["map"], &terms)?;
    let vm = VerifiedApiMap::of_wire(w.clone(), signer).ok_or_else(|| bad_e("the api map is not readable"))?;
    if vm.expires <= now {
        return fail("map-expired", "the api map has expired");
    }
    Ok(vm)
}

/// 2.4 rollback: `ok` with no pin or a higher seq; `seq-not-higher` for a lower or equal seq with the same hash;
/// `conflict` for the pinned seq with another hash (alarm `api.map.conflict`).
pub fn pin_verdict(seq: i64, hash: &str, pinned_seq: i64, pinned_hash: &str) -> &'static str {
    if pinned_seq == 0 || seq > pinned_seq {
        "ok"
    } else if seq == pinned_seq && !hash.eq_ignore_ascii_case(pinned_hash) {
        "conflict"
    } else {
        "seq-not-higher"
    }
}

// ---- 2.5: the tightening journal --------------------------------------------------------------------------------

const ENTRY_KEYS: &[&str] = &["id", "tseq", "ts", "action", "target", "until"];
const ENTRY_REQUIRED: &[&str] = &["id", "tseq", "ts", "action", "target"];
const DENY_ACTIONS: [&str; 2] = ["token_deny", "scrape_deny"];

/// One journal entry.
#[derive(Clone, Debug, PartialEq)]
pub struct TightenEntry {
    pub id: String,
    pub org: String,
    pub tseq: u64,
    pub ts: i64,
    pub action: String,
    pub target: Value,
    /// `token_deny` only.
    pub until: Option<i64>,
}

fn not_tightening<T>(message: impl Into<String>) -> Res<T> {
    fail("not-tightening", message)
}

impl TightenEntry {
    /// Shape, action and target (`not-tightening` for anything else, including an entry that would widen).
    pub fn parse(v: &Value) -> Result<TightenEntry, ApiMapError> {
        let Ok(e) = obj_of(v, ENTRY_KEYS, ENTRY_REQUIRED, "a journal entry") else { return not_tightening("a journal entry must be {id, tseq, ts, action, target}") };
        let Some(tseq) = e["tseq"].as_u64().filter(|n| (1..=MAX_INT as u64).contains(n)) else { return not_tightening("tseq must be a whole number from 1") };
        let Some(ts) = int_of(&e["ts"]).filter(|n| (1..=MAX_INT).contains(n)) else { return not_tightening("ts must be a time") };
        let Some((org, n)) = e["id"].as_str().and_then(tighten_id_parts) else { return not_tightening("id must be t_<org>_<tseq as 6 digits>") };
        if n != tseq {
            return not_tightening("id must end with the entry's tseq");
        }
        let action = e["action"].as_str().unwrap_or_default();
        let t = &e["target"];
        let pair = |a: &str, b: &str| t.as_object().filter(|o| o.len() == 2 && o.contains_key(a) && o.contains_key(b));
        let client = |o: &Obj| prefixed_id(&o["client"], "c_");
        let dest = |o: &Obj| prefixed_id(&o["destination"], "d_");
        let s = |o: &Obj, k: &str, set: &[&str]| o[k].as_str().is_some_and(|x| set.contains(&x));
        let ok = match action {
            "client_suspend" => prefixed_id(t, "c_"),
            "client_drop_scope" => pair("client", "scope").is_some_and(|o| client(o) && o["scope"].as_str().is_some_and(|x| scope_row(x).is_some())),
            "client_drop_relay" => pair("client", "relay").is_some_and(|o| client(o) && o["relay"].as_str().is_some_and(|r| token(r, 64) && r != "*")),
            "client_limit" => t.as_object().is_some_and(|o| o.get("client").is_some_and(|c| prefixed_id(c, "c_")) && limit_ok(o)),
            // cui is the top: never a lowering target
            "client_lower_ceiling" => pair("client", "ceiling").is_some_and(|o| client(o) && s(o, "ceiling", &CEILINGS[..3])),
            "client_drop_credential" => {
                pair("client", "kid").is_some_and(|o| client(o) && o["kid"].as_str().is_some_and(|k| token(k, 64)))
                    || pair("client", "type").is_some_and(|o| client(o) && s(o, "type", &CRED_TYPES))
            }
            "token_deny" => pair("client", "jti").is_some_and(|o| client(o) && o["jti"].as_str().is_some_and(|j| ascii_text(j, 1, 128))),
            "scrape_deny" => t.as_str().is_some_and(|h| hex_n(h, 64)),
            "destination_suspend" | "destination_delete" | "destination_disable_failover" => prefixed_id(t, "d_"),
            "destination_drop_signal" => pair("destination", "signal").is_some_and(|o| dest(o) && s(o, "signal", &SIGNALS_V2)),
            "destination_lower_ceiling" => pair("destination", "ceiling").is_some_and(|o| dest(o) && s(o, "ceiling", &CEILINGS[..3])),
            // only to a stricter form: never as_is
            "destination_identities" => pair("destination", "identities").is_some_and(|o| dest(o) && s(o, "identities", &IDENTITIES[1..])),
            // 168 lowers nothing
            "grace_lower" => pair("kind", "hours").is_some_and(|o| s(o, "kind", &GRACE_KINDS) && int_of(&o["hours"]).is_some_and(|h| (0..GRACE_MAX_HOURS).contains(&h))),
            "api_off" => t.as_str() == Some(org),
            // revision 6 2.3: a spokes_hub client may no longer send to that spoke
            "client_drop_target" => pair("client", "spoke").is_some_and(|o| client(o) && o["spoke"].as_str().is_some_and(is_node_id)),
            _ => return not_tightening(format!("{action:?} is not a tightening")),
        };
        if !ok {
            return not_tightening(format!("the target of {action} is not valid"));
        }
        let until = match (action, e.get("until")) {
            ("token_deny", Some(u)) => Some(int_of(u).filter(|n| (ts + 1..=MAX_INT).contains(n)).ok_or_else(|| ApiMapError::new("not-tightening", "until must be a time"))?),
            ("token_deny", None) => return not_tightening("token_deny needs until"),
            (_, Some(_)) => return not_tightening("only token_deny has until"),
            (_, None) => None,
        };
        Ok(TightenEntry { id: e["id"].as_str().unwrap_or_default().to_string(), org: org.to_string(), tseq, ts, action: action.to_string(), target: t.clone(), until })
    }

    pub fn to_value(&self) -> Value {
        let mut o = pj::obj([
            ("id", Value::from(self.id.clone())),
            ("tseq", Value::from(self.tseq)),
            ("ts", Value::from(self.ts)),
            ("action", Value::from(self.action.clone())),
            ("target", self.target.clone()),
        ]);
        if let Some(u) = self.until {
            o.insert("until".into(), Value::from(u));
        }
        Value::Object(o)
    }

    fn field(&self, k: &str) -> &str {
        self.target.get(k).and_then(Value::as_str).unwrap_or_default()
    }
}

/// 2.5 delivery: the entry, applied only when its `tseq` is exactly `applied_tseq + 1` (`tseq-gap`).
/// The tseq is checked first (`not-tightening` when it is not a whole number), then the rest.
pub fn check_tighten(entry: &Value, applied_tseq: u64) -> Result<TightenEntry, ApiMapError> {
    let Some(tseq) = entry.get("tseq").and_then(Value::as_u64).filter(|n| (1..=MAX_INT as u64).contains(n)) else {
        return not_tightening("tseq must be a whole number from 1");
    };
    if tseq != applied_tseq + 1 {
        return fail("tseq-gap", format!("expected tseq {}, got {tseq}", applied_tseq + 1));
    }
    TightenEntry::parse(entry)
}

/// 2.5 `client_limit` (slice 1a6): `{client, relays?, networks?, rate?}` with at least one of the three: `relays` 1
/// to 64 distinct relay ids (never `*`; `console` for the console), `networks` 1 to 32 distinct CIDRs, `rate` 1 or 2
/// of `per_minute_each` (1 to 6000) and `per_day_each` (1 to 10000000). Every part only narrows the client's grant
/// (the intersection with the map and every other limit), so an entry is never widening.
fn limit_ok(o: &Obj) -> bool {
    const KEYS: [&str; 4] = ["client", "relays", "networks", "rate"];
    if o.len() < 2 || o.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return false;
    }
    let relays = o.get("relays").is_none_or(|v| strings(Some(v), "relays", 1, 64, |r| token(r, 64) && r != "*").is_ok());
    let networks = o.get("networks").is_none_or(|v| strings(Some(v), "networks", 1, 32, cidr_ok).is_ok());
    let rate = o.get("rate").is_none_or(|v| {
        v.as_object().is_some_and(|r| {
            !r.is_empty()
                && r.iter().all(|(k, n)| match k.as_str() {
                    "per_minute_each" => int_of(n).is_some_and(|x| (1..=6000).contains(&x)),
                    "per_day_each" => int_of(n).is_some_and(|x| (1..=10_000_000).contains(&x)),
                    _ => false,
                })
        })
    });
    relays && networks && rate
}

/// `inner` (a CIDR of a map) lies inside `outer`: the same family, a prefix at least as long, and its network
/// address inside `outer`.
pub(crate) fn cidr_within(inner: &str, outer: &str) -> bool {
    use crate::console_source::{parse_cidr, Cidr};
    let (Ok(i), Ok(o)) = (parse_cidr(inner), parse_cidr(outer)) else { return false };
    // `net/prefix` as the range prints itself
    let parts = |c: &Cidr| {
        let text = c.to_string();
        let (a, p) = text.split_once('/')?;
        Some((a.parse::<std::net::IpAddr>().ok()?, p.parse::<u8>().ok()?))
    };
    match (parts(&i), parts(&o)) {
        (Some((net, ip)), Some((_, op))) => ip >= op && o.contains(net),
        _ => false,
    }
}

/// Whether a client entry of a map is within a `client_limit` (2.5 folding): its relays all listed (never `*`), its
/// networks non-empty and each inside one of the limit's, and each limited rate at or below the limit.
fn within_limit(c: &Obj, limit: &Value) -> bool {
    fn list(v: Option<&Value>) -> Vec<&str> {
        v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect()
    }
    let relays = limit.get("relays").is_none_or(|l| {
        let allowed = list(Some(l));
        let mine = list(c.get("relays"));
        !mine.contains(&"*") && mine.iter().all(|r| allowed.contains(r))
    });
    let networks = limit.get("networks").is_none_or(|l| {
        let allowed = list(Some(l));
        let mine = list(c.get("networks"));
        !mine.is_empty() && mine.iter().all(|n| allowed.iter().any(|a| cidr_within(n, a)))
    });
    let rate = limit.get("rate").and_then(Value::as_object).is_none_or(|r| {
        r.iter().all(|(k, cap)| c.get("rate").and_then(|x| x.get(k)).and_then(int_of).zip(int_of(cap)).is_some_and(|(have, cap)| have <= cap))
    });
    relays && networks && rate
}

fn find_by_id<'a>(map: &'a Obj, list: &str, id: &str) -> Option<&'a Obj> {
    map.get(list).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).find(|o| o.get("id").and_then(Value::as_str) == Some(id))
}

fn lists(o: &Obj, k: &str, v: &str) -> bool {
    o.get(k).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(v)))
}

/// Whether the map still contains the entry's restriction (2.5 folding).
fn contains(map: &Obj, e: &TightenEntry) -> bool {
    let client = |id: &str| find_by_id(map, "clients", id);
    let dest = |id: &str| find_by_id(map, "destinations", id);
    let at_or_below = |set: &[&str], have: Option<&str>, limit: &str| rank(set, have.unwrap_or_default()).zip(rank(set, limit)).is_some_and(|(h, l)| h <= l);
    match e.action.as_str() {
        "client_suspend" => client(e.target.as_str().unwrap_or_default()).is_none_or(|c| c.get("state").and_then(Value::as_str) == Some("suspended")),
        "client_drop_scope" => client(e.field("client")).is_none_or(|c| !lists(c, "scopes", e.field("scope"))),
        "client_drop_relay" => client(e.field("client")).is_none_or(|c| !lists(c, "relays", e.field("relay")) && !lists(c, "relays", "*")),
        // a suspended client reaches nothing, so it is within any limit
        "client_limit" => client(e.field("client")).is_none_or(|c| c.get("state").and_then(Value::as_str) == Some("suspended") || within_limit(c, &e.target)),
        "client_lower_ceiling" => client(e.field("client")).is_none_or(|c| at_or_below(&CEILINGS, c.get("ceiling").and_then(Value::as_str), e.field("ceiling"))),
        // revision 6 4.2: a spokes_node credential is dropped by its serial as the kid
        "client_drop_credential" => client(e.field("client")).is_none_or(|c| {
            let (k, want) = if e.target.get("kid").is_some() { ("kid", e.field("kid")) } else { ("type", e.field("type")) };
            let node_serial = |cr: &Value| k == "kid" && cr.get("type").and_then(Value::as_str) == Some("spokes_node") && cr.get("serial").and_then(Value::as_str) == Some(want);
            !c.get("credentials").and_then(Value::as_array).into_iter().flatten().any(|cr| cr.get(k).and_then(Value::as_str) == Some(want) || node_serial(cr))
        }),
        // revision 6 2.3: the client absent or suspended, or its targets without `*` and without that spoke
        "client_drop_target" => client(e.field("client")).is_none_or(|c| {
            let targets = c.get("spokes").and_then(Value::as_object);
            c.get("state").and_then(Value::as_str) == Some("suspended") || targets.is_none_or(|t| !lists(t, "targets", "*") && !lists(t, "targets", e.field("spoke")))
        }),
        "destination_suspend" | "destination_delete" => dest(e.target.as_str().unwrap_or_default()).is_none(),
        "destination_disable_failover" => dest(e.target.as_str().unwrap_or_default()).is_none_or(|d| d.get("failover").and_then(Value::as_bool) != Some(true)),
        "destination_drop_signal" => dest(e.field("destination")).is_none_or(|d| !lists(d, "signals", e.field("signal"))),
        "destination_lower_ceiling" => dest(e.field("destination")).is_none_or(|d| at_or_below(&CEILINGS, d.get("ceiling").and_then(Value::as_str), e.field("ceiling"))),
        "destination_identities" => dest(e.field("destination")).is_none_or(|d| {
            rank(&IDENTITIES, d.get("identities").and_then(Value::as_str).unwrap_or_default()).zip(rank(&IDENTITIES, e.field("identities"))).is_some_and(|(h, w)| h >= w)
        }),
        "grace_lower" => {
            let have = map.get("grace").and_then(|g| g.get(e.field("kind"))).and_then(int_of);
            have.zip(e.target.get("hours").and_then(int_of)).is_some_and(|(h, w)| h <= w)
        }
        // no client and no scrape token left
        "api_off" => ["clients", "scrape_tokens"].iter().all(|k| map.get(*k).and_then(Value::as_array).is_none_or(Vec::is_empty)),
        // token_deny and scrape_deny are never folded: they last until they expire
        _ => false,
    }
}

/// 2.5: whether a pinned map already settles an entry: it clears it (and was issued after the entry), or folds it and
/// contains its restriction. `token_deny` and `scrape_deny` are never settled by a map.
fn settled_by(map: &Obj, e: &TightenEntry) -> bool {
    if DENY_ACTIONS.contains(&e.action.as_str()) {
        return false;
    }
    let issued = map.get("issued").and_then(int_of).unwrap_or(0);
    (lists(map, "cleared", &e.id) && e.ts < issued) || (lists(map, "folded", &e.id) && contains(map, e))
}

/// 2.5 folding and clearing for a newly pinned map: `fold-mismatch` when it folds an active id whose restriction it
/// does not contain, folds or clears a `token_deny` or `scrape_deny`, clears an entry not older than its `issued`, or
/// lists an id both ways. Returns the active ids that remain, sorted.
pub fn fold(active: &[TightenEntry], new_map: &Value) -> Result<Vec<String>, ApiMapError> {
    let Some(m) = new_map.as_object() else { return bad("the api map must be an object") };
    let ids = |k: &str| m.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect::<Vec<&str>>();
    let (folded, cleared) = (ids("folded"), ids("cleared"));
    if folded.iter().any(|f| cleared.contains(f)) {
        return fail("fold-mismatch", "an id is both folded and cleared");
    }
    let issued = m.get("issued").and_then(int_of).unwrap_or(0);
    let mut remaining: Vec<String> = Vec::new();
    for e in active {
        let deny = DENY_ACTIONS.contains(&e.action.as_str());
        if folded.contains(&e.id.as_str()) {
            if deny || !contains(m, e) {
                return fail("fold-mismatch", format!("the map folds {} but does not contain it", e.id));
            }
        } else if cleared.contains(&e.id.as_str()) {
            if deny || e.ts >= issued {
                return fail("fold-mismatch", format!("the map cannot clear {}", e.id));
            }
        } else {
            remaining.push(e.id.clone());
        }
    }
    remaining.sort();
    Ok(remaining)
}

// ---- 3.2: the effective end ---------------------------------------------------------------------------------------

/// `raw_end + hours * 3600` with the applicable grace: the minimum over the orgs that bind the credential, an org with
/// no pinned or an expired map (None) counting 0; no org at all is 0.
pub fn effective_end(raw_end: i64, hours: &[Option<u32>]) -> i64 {
    let h = hours.iter().map(|h| h.unwrap_or(0)).min().unwrap_or(0);
    raw_end.saturating_add(i64::from(h) * 3600)
}

// ---- the relay's store --------------------------------------------------------------------------------------------

/// One org's api state on a relay.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OrgApi {
    pub pinned: Option<VerifiedApiMap>,
    pub previous: Option<VerifiedApiMap>,
    /// The last applied journal `tseq` (0: none).
    pub applied: u64,
    /// Journal entries not yet folded or cleared, in `tseq` order.
    pub active: Vec<TightenEntry>,
    /// 13: the pinned map fails the license edition now held (`revalidate`). It is kept (memory and disk) but the org
    /// serves nothing (`map-edition`) until a conforming map is pinned or the edition allows it again. Not persisted:
    /// every start revalidates under the edition it reads.
    pub aside: bool,
    /// Revision 4 2.3 item 6: a journal action this relay does not know arrived; the org's tokens are refused
    /// (`journal-unknown`) until a later reconnect sync completes (`clear_unknown`). Kept in the journal file.
    pub unknown: bool,
}

impl OrgApi {
    /// Drop the active entries the pinned map settles (2.5); true when any went.
    fn settle(&mut self) -> bool {
        let Some(map) = self.pinned.as_ref().map(|p| p.map().clone()) else { return false };
        let before = self.active.len();
        self.active.retain(|e| !settled_by(&map, e));
        self.active.len() != before
    }
}

/// What `accept` did.
#[derive(Clone, Debug, PartialEq)]
pub enum AcceptOutcome {
    /// Newly pinned (flushed to disk).
    Pinned(VerifiedApiMap),
    /// The pinned map again.
    Unchanged(VerifiedApiMap),
    /// The pinned seq with another hash: nothing changed; raise `api.map.conflict` (audit plus alert).
    Conflict { org: String, seq: i64, pinned_hash: String, offered_hash: String },
}

/// The relay's api maps and journals (2.4, 2.5): `<dir>/api-maps/<org>.json` = `{"pinned": {signed, signer},
/// "previous": {signed, signer}}` and `<dir>/api-journal/<org>.json` = `{"applied": tseq, "active": [entries]}`,
/// each written owner-only and flushed before the relay answers. Without a folder (tests, no state folder) it lives
/// in memory.
#[derive(Debug, Default)]
pub struct ApiMapStore {
    dir: Option<PathBuf>,
    orgs: BTreeMap<String, OrgApi>,
}

const MAPS_DIR: &str = "api-maps";
const JOURNAL_DIR: &str = "api-journal";

fn held_of(v: Option<&Value>) -> Option<VerifiedApiMap> {
    let v = v?.as_object()?;
    let signer = v.get("signer").and_then(Value::as_str).unwrap_or("root").to_string();
    VerifiedApiMap::of_wire(v.get("signed")?.as_object()?.clone(), signer)
}

fn held_value(vm: &VerifiedApiMap) -> Value {
    json!({"signed": Value::Object(vm.wire.clone()), "signer": vm.signer})
}

fn read_json(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(v) => Some(v),
        Err(e) => {
            crate::meet::log_warn(&format!("api store file unreadable path={} why={e}", path.display()));
            None
        }
    }
}

fn write_flushed(path: &Path, v: &Value) -> Res<()> {
    if let Some(parent) = path.parent() {
        crate::store::make_dir(parent).map_err(|e| ApiMapError::new("io", format!("{}: {e}", parent.display())))?;
    }
    let data = serde_json::to_vec(v).map_err(|e| ApiMapError::new("io", e.to_string()))?;
    crate::fleet_local::write_durable(path, &data).map_err(|e| ApiMapError::new("io", e))
}

impl ApiMapStore {
    /// A read-only copy of one org's state (in memory, no folder, so nothing it does reaches the disk), for work that
    /// must not hold the live store's lock, such as a token request that fetches a JWKS.
    pub fn org_snapshot(&self, org: &str) -> ApiMapStore {
        let orgs = self.orgs.get(org).map(|o| BTreeMap::from([(org.to_string(), o.clone())])).unwrap_or_default();
        ApiMapStore { dir: None, orgs }
    }

    /// The store kept under `dir` (every org file found), or an empty one in memory without a folder.
    pub fn load(dir: Option<&Path>) -> ApiMapStore {
        let mut store = ApiMapStore { dir: dir.map(Path::to_path_buf), orgs: BTreeMap::new() };
        let Some(dir) = dir else { return store };
        for (sub, is_map) in [(MAPS_DIR, true), (JOURNAL_DIR, false)] {
            let Ok(entries) = std::fs::read_dir(dir.join(sub)) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(org) = name.strip_suffix(".json").filter(|o| slug(o, 32)) else { continue };
                let Some(v) = read_json(&entry.path()) else { continue };
                let o = store.orgs.entry(org.to_string()).or_default();
                if is_map {
                    o.pinned = held_of(v.get("pinned")).filter(|m| m.org == org);
                    o.previous = held_of(v.get("previous")).filter(|m| m.org == org);
                } else {
                    o.applied = v.get("applied").and_then(Value::as_u64).unwrap_or(0);
                    o.unknown = v.get("unknown").and_then(Value::as_bool).unwrap_or(false);
                    o.active = v.get("active").and_then(Value::as_array).into_iter().flatten().filter_map(|e| TightenEntry::parse(e).ok()).collect();
                }
            }
        }
        // a crash after the map's write and before the journal's (`pin`) leaves entries the pinned map settles: drop
        // them and write the journal again (until then they only kept the relay stricter)
        let orgs: Vec<String> = store.orgs.keys().cloned().collect();
        for org in orgs {
            let mut o = store.orgs[&org].clone();
            if o.settle() {
                if let Err(e) = store.save_journal(&org, &o) {
                    crate::meet::log_warn(&format!("api journal not rewritten org={org} why={e}"));
                }
                store.orgs.insert(org, o);
            }
        }
        store
    }

    fn path(&self, sub: &str, org: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(sub).join(format!("{org}.json")))
    }

    fn save_map(&self, org: &str, o: &OrgApi) -> Res<()> {
        let Some(path) = self.path(MAPS_DIR, org) else { return Ok(()) };
        let mut v = Obj::new();
        if let Some(p) = &o.pinned {
            v.insert("pinned".into(), held_value(p));
        }
        if let Some(p) = &o.previous {
            v.insert("previous".into(), held_value(p));
        }
        write_flushed(&path, &Value::Object(v))
    }

    fn save_journal(&self, org: &str, o: &OrgApi) -> Res<()> {
        let Some(path) = self.path(JOURNAL_DIR, org) else { return Ok(()) };
        let active: Vec<Value> = o.active.iter().map(TightenEntry::to_value).collect();
        let mut v = json!({"applied": o.applied, "active": active});
        if o.unknown {
            v["unknown"] = json!(true);
        }
        write_flushed(&path, &v)
    }

    fn room_for(&self, org: &str) -> Res<()> {
        if !self.orgs.contains_key(org) && self.orgs.len() >= API_MAP_ORGS_MAX {
            return bad("this relay already holds the api maps of 64 organizations");
        }
        Ok(())
    }

    /// 2.4: verify a signed map (with the issuers held for other orgs) under the license `edition` (13; an unknown
    /// edition accepts nothing: `map-edition`), check its seq against the pin, fold the journal into it (2.5), and pin
    /// it durably before Ok. A map accepted under the edition serves again if its org was set aside.
    pub fn accept(&mut self, signed: &Value, trust: &ApiTrust, now: i64, policy: Option<&Obj>, edition: Option<Edition>) -> Result<AcceptOutcome, ApiMapError> {
        let Some(edition) = edition else { return fail("map-edition", "the license edition is not known, so no api map is accepted") };
        let held = self.issuers();
        let vm = verify_api_map(signed, trust.root, trust.signer_policy, trust.root_crl, trust.previous_serial, now, policy, edition, &held)?;
        let org = vm.org.clone();
        // revision 4 2.2: a directory resource is unique across the clients of every map held
        let taken = self.directory_resources(&org);
        if resources_of(vm.map()).iter().any(|r| taken.contains(r)) {
            return fail("directory", "another organization's api map has that directory resource");
        }
        let r = self.pin(vm)?;
        if matches!(r, AcceptOutcome::Pinned(_) | AcceptOutcome::Unchanged(_)) {
            if let Some(o) = self.orgs.get_mut(&org) {
                o.aside = false;
            }
        }
        Ok(r)
    }

    /// 13: hold every pinned map to the license `edition` now in force: a map that `check_api_map` refuses under it
    /// (judged as at its `issued`, so only the edition's limits can newly refuse it), and every map while the edition
    /// is unknown (None), is set aside (kept, serving nothing); a set-aside map that conforms again serves again.
    /// Returns every org whose state changed (`is_set_aside` tells which way), for the caller's security lines.
    pub fn revalidate(&mut self, edition: Option<Edition>) -> Vec<String> {
        let none = BTreeMap::new();
        let mut changed = Vec::new();
        for (org, o) in self.orgs.iter_mut() {
            let Some(p) = o.pinned.as_ref() else { continue };
            let map = &p.wire["map"];
            let issued = map.get("issued").and_then(int_of).unwrap_or(0);
            let aside = !edition.is_some_and(|e| check_api_map(map, issued, None, e, &none).is_ok());
            if aside != o.aside {
                o.aside = aside;
                changed.push(org.clone());
            }
        }
        changed
    }

    /// Pin a map already verified.
    pub fn pin(&mut self, vm: VerifiedApiMap) -> Result<AcceptOutcome, ApiMapError> {
        self.room_for(&vm.org)?;
        let cur = self.orgs.get(&vm.org).cloned().unwrap_or_default();
        let (pseq, phash) = cur.pinned.as_ref().map_or((0, ""), |p| (p.seq, p.hash.as_str()));
        // the pinned map sent again (a reconnect or a retried upload) pins nothing; it still settles the journal, so a
        // crash between the map's write and the journal's converges on the next delivery
        if let Some(p) = cur.pinned.as_ref().filter(|p| p.hash == vm.hash) {
            let p = p.clone();
            let mut next = cur.clone();
            if next.settle() {
                self.save_journal(&vm.org, &next)?;
                self.orgs.insert(vm.org.clone(), next);
            }
            return Ok(AcceptOutcome::Unchanged(p));
        }
        match pin_verdict(vm.seq, &vm.hash, pseq, phash) {
            "seq-not-higher" => return fail("seq-not-higher", format!("that api map's seq is not higher than {pseq}")),
            "conflict" => return Ok(AcceptOutcome::Conflict { org: vm.org.clone(), seq: vm.seq, pinned_hash: phash.to_string(), offered_hash: vm.hash }),
            _ => {}
        }
        let remaining = fold(&cur.active, &vm.wire["map"])?;
        let mut next = cur.clone();
        next.previous = cur.pinned.clone();
        next.pinned = Some(vm.clone());
        next.active.retain(|e| remaining.contains(&e.id));
        // the map first: a crash before the journal's write leaves the new map with the old (stricter) journal, which
        // `load` and a retried delivery settle; never the old map without its tightening
        self.save_map(&vm.org, &next)?;
        if next.active != cur.active {
            if let Err(e) = self.save_journal(&vm.org, &next) {
                // the map is on disk: keep the journal as written (stricter) in memory too, settled at the next load
                let mut kept = next.clone();
                kept.active = cur.active.clone();
                self.orgs.insert(vm.org.clone(), kept);
                return Err(e);
            }
        }
        self.orgs.insert(vm.org.clone(), next);
        Ok(AcceptOutcome::Pinned(vm))
    }

    /// 2.5 rebase: after pinning a map that came with the console's pruned `base`, an applied tseq below it moves up
    /// to it (the pinned map holds the pruned entries' effect), flushed before Ok(Some(previous)). A base at or below
    /// the applied tseq changes nothing (Ok(None)).
    pub fn rebase(&mut self, org: &str, base: u64) -> Result<Option<u64>, ApiMapError> {
        let cur = self.orgs.get(org).cloned().unwrap_or_default();
        if base <= cur.applied || cur.pinned.is_none() {
            return Ok(None);
        }
        let from = cur.applied;
        let mut next = cur;
        next.applied = base;
        self.save_journal(org, &next)?;
        self.orgs.insert(org.to_string(), next);
        Ok(Some(from))
    }

    /// 2.5: apply one journal entry for `org` (its tseq exactly the next) and flush the journal before Ok(tseq). An
    /// entry the pinned map already settles (a map that arrived before its entry, as in a reconnect catch-up) is
    /// recorded as applied but not kept active: cleared when the map clears it, folded only when the map also contains
    /// its restriction.
    pub fn apply_tighten(&mut self, org: &str, entry: &Value) -> Result<u64, ApiMapError> {
        self.room_for(org)?;
        let cur = self.orgs.get(org).cloned().unwrap_or_default();
        // revision 4 2.3 item 6: an action this relay does not know is refused, and the org's tokens with it until a
        // later reconnect sync completes (an entry for another org is that org's, refused below as before)
        let action = entry.get("action").and_then(Value::as_str);
        let other_org = entry.get("id").and_then(Value::as_str).and_then(tighten_id_parts).is_some_and(|(o, _)| o != org);
        if let Some(a) = action.filter(|a| !RELAY_ACTIONS.contains(a) && !other_org) {
            let mut next = cur;
            if !next.unknown {
                next.unknown = true;
                self.save_journal(org, &next)?;
                self.orgs.insert(org.to_string(), next);
            }
            return fail("not-tightening", format!("{a:?} is not a journal action this relay knows"));
        }
        let e = check_tighten(entry, cur.applied)?;
        if e.org != org {
            return not_tightening("that entry is for another organization");
        }
        let mut next = cur;
        next.applied = e.tseq;
        if !next.pinned.as_ref().is_some_and(|p| settled_by(p.map(), &e)) {
            next.active.push(e);
        }
        self.save_journal(org, &next)?;
        let tseq = next.applied;
        self.orgs.insert(org.to_string(), next);
        Ok(tseq)
    }
}

impl ApiMapStore {
    /// Revision 4 2.3 item 6: whether the org's tokens are refused because an unknown journal action arrived.
    pub fn journal_unknown(&self, org: &str) -> bool {
        self.orgs.get(org).is_some_and(|o| o.unknown)
    }

    /// Revision 4 2.3 item 6: a reconnect sync completed (`api-synced` accepted) for these orgs: their tokens are
    /// served again, flushed before Ok. The orgs whose flag was cleared.
    pub fn clear_unknown<'a>(&mut self, orgs: impl IntoIterator<Item = &'a str>) -> Result<Vec<String>, ApiMapError> {
        let mut cleared = Vec::new();
        for org in orgs {
            let Some(mut next) = self.orgs.get(org).filter(|o| o.unknown).cloned() else { continue };
            next.unknown = false;
            self.save_journal(org, &next)?;
            self.orgs.insert(org.to_string(), next);
            cleared.push(org.to_string());
        }
        Ok(cleared)
    }

    /// The directory resources of every pinned map but `org`'s.
    fn directory_resources(&self, org: &str) -> BTreeSet<String> {
        self.orgs.iter().filter(|(o, _)| o.as_str() != org).filter_map(|(_, a)| a.pinned.as_ref()).flat_map(|p| resources_of(p.map())).collect()
    }
}

/// `clients[].directory.resource` of a map.
fn resources_of(map: &Obj) -> Vec<String> {
    map.get("clients").and_then(Value::as_array).into_iter().flatten().filter_map(|c| c.pointer("/directory/resource")).filter_map(Value::as_str).map(str::to_string).collect()
}

// Read by the fleet channel (api-tighten, hello), the TLS verifiers (grace) and the API listener, which build on this.
#[cfg_attr(not(test), allow(dead_code))]
impl ApiMapStore {
    /// The org's pinned map unless it is set aside (13): everything that serves reads the map through this.
    fn serving(&self, org: &str) -> Option<&VerifiedApiMap> {
        self.orgs.get(org).filter(|o| !o.aside)?.pinned.as_ref()
    }

    /// The org's pinned map is held but set aside: it fails the license edition in force (13, `map-edition`).
    pub fn is_set_aside(&self, org: &str) -> bool {
        self.orgs.get(org).is_some_and(|o| o.aside && o.pinned.is_some())
    }

    /// The org's serving pinned map when it has not expired at `now`.
    fn live(&self, org: &str, now: i64) -> Option<&VerifiedApiMap> {
        self.serving(org).filter(|p| p.expires > now)
    }

    /// 3.3: the org's grace for `kind` (hours, lowered by journaled `grace_lower`), None without a pinned unexpired
    /// map (which counts 0).
    pub fn grace_hours(&self, org: &str, kind: &str, now: i64) -> Option<u32> {
        let p = self.live(org, now)?;
        let base = p.map().get("grace").and_then(|g| g.get(kind)).and_then(int_of)?;
        let lowered = self.orgs[org].active.iter().filter(|e| e.action == "grace_lower" && e.field("kind") == kind).filter_map(|e| e.target.get("hours").and_then(int_of));
        let h = lowered.fold(base, i64::min);
        u32::try_from(h.clamp(0, GRACE_MAX_HOURS)).ok()
    }

    /// `issuer.url` of every pinned map, by org.
    pub fn issuers(&self) -> BTreeMap<String, String> {
        self.orgs.iter().filter_map(|(o, a)| a.pinned.as_ref().map(|p| (o.clone(), p.issuer_url().to_string()))).collect()
    }

    /// `(pinned seq, last applied tseq)`, what `hello` reports per org (0 for none).
    pub fn head(&self, org: &str) -> (i64, u64) {
        self.orgs.get(org).map_or((0, 0), |o| (o.pinned.as_ref().map_or(0, |p| p.seq), o.applied))
    }

    /// An active `api_off` (2.5).
    pub fn is_off(&self, org: &str) -> bool {
        self.orgs.get(org).is_some_and(|o| o.active.iter().any(|e| e.action == "api_off"))
    }

    /// The org's serving pinned map (`sha256` empty; None while set aside), or the pinned or previous map with that
    /// hash.
    pub fn get(&self, org: &str, sha256: &str) -> Option<&VerifiedApiMap> {
        if sha256.is_empty() {
            return self.serving(org);
        }
        let o = self.orgs.get(org)?;
        let want = sha256.to_lowercase();
        [o.pinned.as_ref(), o.previous.as_ref()].into_iter().flatten().find(|m| m.hash == want)
    }

    fn pinned_list(&self, org: &str, k: &str) -> &[Value] {
        self.serving(org).and_then(|p| p.map().get(k)).and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
    }

    /// The pinned map's `clients`.
    pub fn clients(&self, org: &str) -> &[Value] {
        self.pinned_list(org, "clients")
    }

    /// The pinned map's `scrape_tokens`.
    pub fn scrape_tokens(&self, org: &str) -> &[Value] {
        self.pinned_list(org, "scrape_tokens")
    }

    /// The pinned map's `relay_origins`.
    pub fn relay_origins(&self, org: &str) -> Option<&Obj> {
        self.serving(org)?.map().get("relay_origins").and_then(Value::as_object)
    }

    /// Journal entries still active for the org.
    pub fn active(&self, org: &str) -> &[TightenEntry] {
        self.orgs.get(org).map_or(&[][..], |o| o.active.as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../tests/api_map_v1.json");
    const NOW: i64 = 1_795_000_000;
    /// A 43 character base64url coordinate (32 bytes).
    fn x() -> String {
        "A".repeat(43)
    }

    fn policy() -> Obj {
        json!({"org": "acme", "domains": ["acme.example"], "apps": [{"type": "ai", "principal": "lucid-ai@apps.acme.example", "name": "lucid-ai"}]})
            .as_object()
            .unwrap()
            .clone()
    }

    fn client(id: &str, name: &str) -> Value {
        json!({"id": id, "name": name, "principal": format!("{name}@apps.acme.example"), "kind": "monitoring",
               "owner": "ann@acme.example", "reach": "R0", "scopes": ["monitor.read", "audit.read"], "ceiling": "internal",
               "relays": ["*"], "networks": ["10.40.0.0/23"], "mtls_required": false,
               "rate": {"per_minute_each": 120, "per_day_each": 100000},
               "credentials": [{"type": "private_key_jwt", "kid": "k1", "jwk": {"kty": "EC", "crv": "P-256", "x": x(), "y": x()}, "expires": NOW + 90 * DAY}],
               "created": NOW, "expires": NOW + 300 * DAY, "state": "active"})
    }

    fn good_map(seq: i64) -> Value {
        json!({"v": 1, "org": "acme", "seq": seq, "issued": NOW, "expires": NOW + 30 * DAY,
               "issuer": {"url": "https://console.acme.example:7443/api/orgs/acme",
                          "jwks": [{"kty": "EC", "crv": "P-256", "kid": "k-2026-11", "x": x(), "y": x(), "use": "sig", "alg": "ES256", "nbf": NOW, "exp": NOW + 90 * DAY}]},
               "grace": {"person": 0, "app": 24, "connector": 0, "relay": 12},
               "failover_after_s": 300, "folded": [], "cleared": [],
               "relay_origins": {"r_01": "https://relay1.acme.example:9443"},
               "clients": [client("c_5f1a2b3c4d5e6f70", "splunk-scrape")],
               "scrape_tokens": [{"sha256": "a".repeat(64), "hint": "lme_ab12", "label": "prometheus-dc1", "relays": ["*"], "expires": NOW + 60 * DAY}],
               "destinations": [{"id": "d_9a8b7c6d5e4f3a2b", "name": "Splunk HEC", "kind": "splunk_hec", "preset": "splunk_hec",
                                 "signals": ["audit", "logs"], "ceiling": "internal", "identities": "pseudonymized", "failover": false,
                                 "private_ok": false, "endpoint": "https://hec.acme.example:8088/services/collector/event",
                                 "settings": {"index": "lucid", "ack": true},
                                 "credential": {"type": "token", "ref": "secret:d_9a8b7c6d5e4f3a2b"},
                                 "queue": {"max_bytes": 1073741824, "max_age_s": 259200}}]})
    }

    fn verified(map: Value) -> VerifiedApiMap {
        let wire = json!({"map": map, "sig": "", "chain": []});
        VerifiedApiMap::of_wire(wire.as_object().unwrap().clone(), "root".into()).unwrap()
    }

    fn entry(tseq: u64, action: &str, target: Value) -> Value {
        json!({"id": format!("t_acme_{tseq:06}"), "tseq": tseq, "ts": NOW - 100, "action": action, "target": target})
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-api-map-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn code<T>(r: Result<T, ApiMapError>) -> &'static str {
        r.err().map_or("ok", |e| e.code)
    }

    #[test]
    fn api_map_field_rules_and_edition_limits() {
        let p = policy();
        let none = BTreeMap::new();
        let check = |m: &Value, ed: Edition| code(check_api_map(m, NOW, Some(&p), ed, &none));
        assert_eq!(check(&good_map(1), Edition::Enterprise), "ok");
        let mut m = good_map(1);
        m["grace"]["app"] = json!(169);
        assert_eq!(check(&m, Edition::Enterprise), "grace-limit");
        let mut m = good_map(1);
        m["grace"]["guest"] = json!(1);
        assert_eq!(check(&m, Edition::Enterprise), "grace-limit");
        let mut m = good_map(1);
        m["clients"][0]["nickname"] = json!("x");
        assert_eq!(check(&m, Edition::Enterprise), "bad-map");
        let mut m = good_map(1);
        m["clients"][0]["ceiling"] = json!("cui");
        assert_eq!(check(&m, Edition::Enterprise), "bad-map");
        let mut m = good_map(1);
        m["failover_after_s"] = Value::Null;
        assert_eq!(check(&m, Edition::Enterprise), "bad-map");
        let mut m = good_map(1);
        m["clients"][0]["name"] = json!("lucid-ai");
        m["clients"][0]["principal"] = json!("lucid-ai@apps.acme.example");
        assert_eq!(check(&m, Edition::Enterprise), "bad-map");
        // standard: no splunk_hec
        assert_eq!(check(&good_map(1), Edition::Standard), "license");
        let held = BTreeMap::from([("other".to_string(), "https://console.acme.example:7443/api/orgs/acme".to_string())]);
        assert_eq!(code(check_api_map(&good_map(1), NOW, Some(&p), Edition::Enterprise, &held)), "issuer-taken");
    }

    #[test]
    fn api_map_store_persists_across_reload_and_alarms_on_conflict() {
        let dir = temp("persist");
        let mut s = ApiMapStore::load(Some(&dir));
        let first = verified(good_map(1));
        assert!(matches!(s.pin(first.clone()), Ok(AcceptOutcome::Pinned(_))));
        let mut m2 = good_map(2);
        m2["grace"]["app"] = json!(48);
        let second = verified(m2.clone());
        assert!(matches!(s.pin(second.clone()), Ok(AcceptOutcome::Pinned(_))));
        assert!(matches!(s.pin(second.clone()), Ok(AcceptOutcome::Unchanged(_))));
        assert_eq!(code(s.pin(first.clone())), "seq-not-higher");
        m2["grace"]["app"] = json!(1);
        let other = verified(m2);
        match s.pin(other.clone()) {
            Ok(AcceptOutcome::Conflict { seq, pinned_hash, offered_hash, .. }) => {
                assert_eq!((seq, pinned_hash, offered_hash), (2, second.hash.clone(), other.hash.clone()));
            }
            r => panic!("expected a conflict, got {r:?}"),
        }
        assert_eq!(s.apply_tighten("acme", &entry(1, "grace_lower", json!({"kind": "app", "hours": 6}))), Ok(1));
        let back = ApiMapStore::load(Some(&dir));
        assert_eq!(back.head("acme"), (2, 1));
        assert_eq!(back.get("acme", "").map(|m| m.hash.clone()), Some(second.hash.clone()));
        assert_eq!(back.get("acme", &first.hash.to_uppercase()).map(|m| m.seq), Some(1));
        assert_eq!(back.grace_hours("acme", "app", NOW), Some(6));
        assert_eq!(back.grace_hours("acme", "relay", NOW), Some(12));
        assert_eq!(back.grace_hours("acme", "app", NOW + 31 * DAY), None);
        assert_eq!(back.issuers().get("acme").map(String::as_str), Some("https://console.acme.example:7443/api/orgs/acme"));
        assert_eq!(back.clients("acme").len(), 1);
        assert_eq!(back.scrape_tokens("acme").len(), 1);
        assert!(back.relay_origins("acme").is_some_and(|o| o.contains_key("r_01")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn api_journal_refuses_gaps_and_widening() {
        let mut s = ApiMapStore::load(None);
        assert_eq!(code(s.apply_tighten("acme", &entry(2, "client_suspend", json!("c_5f1a2b3c4d5e6f70")))), "tseq-gap");
        assert_eq!(s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70"))), Ok(1));
        assert_eq!(code(s.apply_tighten("acme", &entry(2, "client_resume", json!("c_5f1a2b3c4d5e6f70")))), "not-tightening");
        assert_eq!(code(s.apply_tighten("acme", &entry(2, "destination_identities", json!({"destination": "d_9a8b7c6d5e4f3a2b", "identities": "as_is"})))), "not-tightening");
        assert_eq!(code(s.apply_tighten("acme", &entry(2, "grace_lower", json!({"kind": "app", "hours": 169})))), "not-tightening");
        assert_eq!(code(s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70")))), "tseq-gap");
        assert_eq!(s.apply_tighten("acme", &entry(2, "api_off", json!("acme"))), Ok(2));
        assert!(s.is_off("acme"));
        assert_eq!(s.head("acme"), (0, 2));
    }

    #[test]
    fn api_maps_fold_and_clear_journal_entries() {
        let active: Vec<TightenEntry> = [
            entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70")),
            entry(2, "destination_disable_failover", json!("d_9a8b7c6d5e4f3a2b")),
            entry(3, "scrape_deny", json!("a".repeat(64))),
        ]
        .iter()
        .map(|e| TightenEntry::parse(e).unwrap())
        .collect();
        // folds a suspension the map does not contain
        let mut m = good_map(2);
        m["folded"] = json!(["t_acme_000001"]);
        assert_eq!(code(fold(&active, &m)), "fold-mismatch");
        // contains it
        m["clients"][0]["state"] = json!("suspended");
        m["folded"] = json!(["t_acme_000001", "t_acme_000002"]);
        assert_eq!(fold(&active, &m), Ok(vec!["t_acme_000003".to_string()]));
        // clears the suspension (signed widening after the entry), folds failover off
        let mut m = good_map(2);
        m["folded"] = json!(["t_acme_000002"]);
        m["cleared"] = json!(["t_acme_000001"]);
        assert_eq!(fold(&active, &m), Ok(vec!["t_acme_000003".to_string()]));
        // a deny is never cleared; a clear needs a later map
        m["cleared"] = json!(["t_acme_000003"]);
        assert_eq!(code(fold(&active, &m)), "fold-mismatch");
        let mut m = good_map(2);
        m["issued"] = json!(NOW - 200);
        m["cleared"] = json!(["t_acme_000001"]);
        assert_eq!(code(fold(&active, &m)), "fold-mismatch");
        // both ways
        let mut m = good_map(2);
        m["folded"] = json!(["t_acme_000002"]);
        m["cleared"] = json!(["t_acme_000002"]);
        assert_eq!(code(fold(&active, &m)), "fold-mismatch");
        // pinning folds the store's journal
        let mut s = ApiMapStore::load(None);
        s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70"))).unwrap();
        let mut m = good_map(1);
        m["cleared"] = json!(["t_acme_000001"]);
        assert!(matches!(s.pin(verified(m)), Ok(AcceptOutcome::Pinned(_))));
        assert!(s.active("acme").is_empty());
    }

    #[test]
    fn a_crash_between_the_map_and_journal_writes_never_widens_and_converges() {
        let dir = temp("crash");
        let suspend = entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70"));
        let mut s = ApiMapStore::load(Some(&dir));
        s.pin(verified(good_map(1))).unwrap();
        s.apply_tighten("acme", &suspend).unwrap();
        let journal = dir.join(JOURNAL_DIR).join("acme.json");
        let before = std::fs::read(&journal).unwrap();
        let mut m2 = good_map(2);
        m2["cleared"] = json!(["t_acme_000001"]);
        assert!(matches!(s.pin(verified(m2.clone())), Ok(AcceptOutcome::Pinned(_))));
        // the crash: the map reached the disk, the journal did not (the map is written first, so the reverse, the old
        // map without its tightening, cannot happen)
        std::fs::write(&journal, &before).unwrap();
        let back = ApiMapStore::load(Some(&dir));
        assert_eq!(back.head("acme"), (2, 1));
        assert!(back.active("acme").is_empty(), "the next load settles the journal against the pinned map");
        let on_disk: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
        assert_eq!(on_disk["active"], json!([]), "and writes it");
        // the same state in memory (a relay that kept running): the retried delivery of the same map converges
        std::fs::write(&journal, &before).unwrap();
        let mut live = ApiMapStore::load(Some(&dir));
        live.orgs.get_mut("acme").unwrap().active.push(TightenEntry::parse(&suspend).unwrap());
        std::fs::write(&journal, &before).unwrap();
        assert!(matches!(live.pin(verified(m2)), Ok(AcceptOutcome::Unchanged(_))));
        assert!(live.active("acme").is_empty());
        let on_disk: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
        assert_eq!(on_disk["active"], json!([]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entries_arriving_after_the_map_that_folds_or_clears_them_are_settled() {
        // the catch-up order: the newer map first, then the journal entries it folds or clears
        let mut s = ApiMapStore::load(None);
        s.pin(verified(good_map(1))).unwrap();
        let mut m2 = good_map(2);
        m2["cleared"] = json!(["t_acme_000001"]);
        // fleet.read is not among the client's scopes (contained); audit.read still is (not contained)
        m2["folded"] = json!(["t_acme_000002", "t_acme_000003"]);
        assert!(matches!(s.pin(verified(m2)), Ok(AcceptOutcome::Pinned(_))));
        assert_eq!(s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70"))), Ok(1));
        assert_eq!(s.apply_tighten("acme", &entry(2, "client_drop_scope", json!({"client": "c_5f1a2b3c4d5e6f70", "scope": "fleet.read"}))), Ok(2));
        assert_eq!(s.apply_tighten("acme", &entry(3, "client_drop_scope", json!({"client": "c_5f1a2b3c4d5e6f70", "scope": "audit.read"}))), Ok(3));
        let active: Vec<&str> = s.active("acme").iter().map(|e| e.id.as_str()).collect();
        assert_eq!(active, ["t_acme_000003"], "the cleared suspension is not active; a fold without the restriction stays");
        assert_eq!(s.head("acme"), (2, 3));
    }

    #[test]
    fn api_grace_effective_end_takes_the_minimum() {
        assert_eq!(effective_end(1000, &[]), 1000);
        assert_eq!(effective_end(1000, &[Some(2), Some(5)]), 1000 + 2 * 3600);
        assert_eq!(effective_end(1000, &[Some(2), None]), 1000);
        assert_eq!(effective_end(1000, &[Some(168)]), 1000 + 168 * 3600);
    }

    #[test]
    fn the_api_map_vectors_give_the_expected_verdicts() {
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(doc["v"], 1);
        let root = Cert::from_pem(doc["root_pem"].as_str().unwrap()).unwrap();
        let sp = doc["signer_policy"].as_object().unwrap();
        assert!(op::verify_signer_policy(&root, sp));
        let now = doc["now"].as_i64().unwrap();
        let policy = doc["policy"].as_object();
        let none = BTreeMap::new();
        let mut seen = 0;
        let mut codes: BTreeSet<&str> = BTreeSet::new();
        for c in doc["maps"].as_array().unwrap() {
            // a vector without an edition tests no edition limit
            let edition = Edition::of(c["edition"].as_str()).unwrap_or(Edition::Enterprise);
            let held: BTreeMap<String, String> = c["held_issuers"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
            let got = code(check_api_map(&c["map"], now, policy, edition, &held));
            assert_eq!(got, c["expect"].as_str().unwrap(), "maps/{}", c["name"]);
            codes.insert(got);
            seen += 1;
        }
        for c in doc["signed"].as_array().unwrap() {
            let got = (|| -> Result<String, ApiMapError> {
                let vm = verify_api_map(&c["signed"], &root, sp, None, "", now, policy, Edition::Enterprise, &none)?;
                match pin_verdict(vm.seq, &vm.hash, c["pinned_seq"].as_i64().unwrap(), c["pinned_hash"].as_str().unwrap()) {
                    "ok" => Ok(vm.hash),
                    v => Err(ApiMapError::new(v, v)),
                }
            })();
            match got {
                Ok(hash) => {
                    assert_eq!(c["expect"], "ok", "signed/{}", c["name"]);
                    assert_eq!(c["hash"].as_str().unwrap(), hash, "signed/{}", c["name"]);
                }
                Err(e) => {
                    assert_eq!(e.code, c["expect"].as_str().unwrap(), "signed/{}: {}", c["name"], e.message);
                    codes.insert(e.code);
                }
            }
            seen += 1;
        }
        for c in doc["journal"].as_array().unwrap() {
            let got = code(check_tighten(&c["entry"], c["applied_tseq"].as_u64().unwrap()));
            assert_eq!(got, c["expect"].as_str().unwrap(), "journal/{}", c["name"]);
            codes.insert(got);
            seen += 1;
        }
        for c in doc["fold"].as_array().unwrap() {
            let active: Vec<TightenEntry> = c["active"].as_array().unwrap().iter().map(|e| TightenEntry::parse(e).unwrap()).collect();
            match (fold(&active, &c["map"]), &c["expect"]) {
                (Ok(remaining), Value::Object(want)) => assert_eq!(json!(remaining), want["remaining"], "fold/{}", c["name"]),
                (Err(e), Value::String(want)) => assert_eq!(e.code, want.as_str(), "fold/{}", c["name"]),
                (got, want) => panic!("fold/{}: got {got:?}, want {want}", c["name"]),
            }
            seen += 1;
        }
        for c in doc["grace"].as_array().unwrap() {
            let hours: Vec<Option<u32>> = c["org_graces"].as_array().unwrap().iter().map(|h| h.as_u64().map(|h| h as u32)).collect();
            let end = effective_end(c["raw_end"].as_i64().unwrap(), &hours);
            let admit = c["now"].as_i64().unwrap() <= end;
            assert_eq!(json!({"effective_end": end, "admit": admit}), c["expect"], "grace/{}", c["name"]);
            seen += 1;
        }
        // revision 5 3.2: `check_idps` against registry entries `[org, id, kind, iss]`
        for c in doc["idps"].as_array().unwrap() {
            let providers: Vec<op::IdentityProvider> = c["registry"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| op::IdentityProvider { org: p[0].as_str().unwrap().into(), id: p[1].as_str().unwrap().into(), kind: p[2].as_str().unwrap().into(), iss: p[3].as_str().unwrap().into(), ..Default::default() })
                .collect();
            let terms = op::SignerTerms { identity_providers: providers, ..Default::default() };
            let got = code(check_idps(&c["map"], &terms));
            assert_eq!(got, c["expect"].as_str().unwrap(), "idps/{}", c["name"]);
            codes.insert(got);
            seen += 1;
        }
        // revision 6 4.2 (R6-4): `clearances_within(ceiling, clearances)`
        for c in doc["clearances"].as_array().unwrap() {
            let clearances: Vec<&str> = c["clearances"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
            assert_eq!(clearances_within(c["ceiling"].as_str().unwrap(), &clearances), c["expect"].as_bool().unwrap(), "clearances/{}", c["name"]);
            seen += 1;
        }
        assert!(seen >= 60, "only {seen} cases");
        for want in ["bad-map", "grace-limit", "license", "issuer-taken", "fold-mismatch", "signature", "seq-not-higher", "conflict", "map-expired", "tseq-gap", "not-tightening", "ceiling", "idp"] {
            assert!(codes.contains(want), "no vector refuses with {want}");
        }
        assert!(doc["api_max_bytes"].as_u64().unwrap() as usize <= API_MAP_MAX);
    }

    /// Revision 4 2.3 item 6: a relay of revision 4 handed an action it does not know (here a console journal action,
    /// which no relay should ever get) refuses it and every token of the org (`journal-unknown`), across a restart,
    /// until a later reconnect sync completes; a known action with a bad target only refuses that entry.
    #[test]
    fn an_unknown_journal_action_fails_the_org_closed_until_a_sync_completes() {
        let dir = temp("unknown");
        let mut s = ApiMapStore::load(Some(&dir));
        s.pin(verified(good_map(1))).unwrap();
        assert_eq!(code(s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_123")))), "not-tightening");
        assert!(!s.journal_unknown("acme"), "a known action with a bad target is only refused");
        let k = json!({"id": "k_acme_000001", "cseq": 1, "ts": NOW, "action": "webhook_key_drop", "target": {"kid": "wk-1"}, "reach": "console"});
        assert_eq!(code(s.apply_tighten("acme", &k)), "not-tightening");
        assert_eq!(code(s.apply_tighten("acme", &entry(1, "client_resume", json!("c_5f1a2b3c4d5e6f70")))), "not-tightening");
        assert!(s.journal_unknown("acme"));
        assert_eq!(crate::api_issue::closed(&s, "acme", NOW), Some("journal-unknown"));
        // known entries still apply, in order (stricter only)
        assert_eq!(s.apply_tighten("acme", &entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70"))), Ok(1));
        let mut back = ApiMapStore::load(Some(&dir));
        assert_eq!(crate::api_issue::closed(&back, "acme", NOW), Some("journal-unknown"), "kept across a restart");
        assert_eq!(back.clear_unknown(["acme", "beta"]).unwrap(), ["acme"]);
        assert_eq!(crate::api_issue::closed(&back, "acme", NOW), None);
        assert!(!ApiMapStore::load(Some(&dir)).journal_unknown("acme"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_2_fields_need_version_2_and_k_ids_are_its_own() {
        let p = policy();
        let none = BTreeMap::new();
        let check = |m: &Value| code(check_api_map(m, NOW, Some(&p), Edition::Enterprise, &none));
        let mut m = good_map(1);
        m["v"] = json!(2);
        assert_eq!(check(&m), "map-version", "a version 2 map uses a version 2 field");
        m["webhook_keys"] = json!([]);
        assert_eq!(check(&m), "ok");
        m["v"] = json!(1);
        assert_eq!(check(&m), "map-version");
        let mut m = good_map(1);
        m["folded"] = json!(["k_acme_000001"]);
        assert_eq!(check(&m), "map-version");
        m["v"] = json!(2);
        assert_eq!(check(&m), "ok");
        m["folded"] = json!(["k_beta_000001"]);
        assert_eq!(check(&m), "bad-map");
        assert_eq!(version_needed(&good_map(1)), 1);
        assert_eq!(console_id_parts("k_acme_000042"), Some(("acme", 42)));
        assert_eq!(console_id_parts("t_acme_000042"), None);
        // a relay skips k_ ids when it folds its own journal
        let active = vec![TightenEntry::parse(&entry(1, "client_suspend", json!("c_5f1a2b3c4d5e6f70"))).unwrap()];
        let mut m = good_map(2);
        m["folded"] = json!(["k_acme_000001"]);
        assert_eq!(fold(&active, &m), Ok(vec!["t_acme_000001".to_string()]));
        // revision 4 scopes, credential types and signals are tightening targets
        for (action, target) in [
            ("client_drop_scope", json!({"client": "c_5f1a2b3c4d5e6f70", "scope": "compliance.export.request"})),
            ("client_drop_credential", json!({"client": "c_5f1a2b3c4d5e6f70", "type": "entra_wif"})),
            ("destination_drop_signal", json!({"destination": "d_9a8b7c6d5e4f3a2b", "signal": "events"})),
        ] {
            assert!(check_tighten(&entry(1, action, target), 0).is_ok(), "{action}");
        }
    }

    /// The shared vectors of revision 4 (`tests/vectors/make_api_map_v2.py` in the Meeting Hub, copied to
    /// `tests/api_map_v2.json`): every map case, every provider case and every version case gives the expected code.
    #[test]
    fn the_api_map_v2_vectors_give_the_expected_verdicts() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("api_map_v2.json");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing: run make_api_map_v2.py and copy it", path.display()));
        let doc: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["v"], 2);
        let now = doc["now"].as_i64().unwrap();
        let policy = doc["policy"].as_object();
        let mut codes: BTreeSet<String> = BTreeSet::new();
        let mut seen = 0;
        for c in doc["maps"].as_array().unwrap() {
            let edition = Edition::of(c["edition"].as_str()).unwrap_or(Edition::Enterprise);
            let held: BTreeMap<String, String> = c["held_issuers"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
            let got = code(check_api_map(&c["map"], now, policy, edition, &held));
            assert_eq!(got, c["expect"].as_str().unwrap(), "maps/{}", c["name"]);
            assert_eq!(version_needed(&c["map"]), c["needs_version"].as_i64().unwrap(), "maps/{} version", c["name"]);
            codes.insert(got.to_string());
            seen += 1;
        }
        for c in doc["providers"].as_array().unwrap() {
            let providers: Vec<op::IdentityProvider> = c["registry"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| op::IdentityProvider { org: p[0].as_str().unwrap().into(), id: p[1].as_str().unwrap().into(), ..Default::default() })
                .collect();
            let terms = op::SignerTerms { org_domains: Default::default(), org_admins: Default::default(), intermediate_serial: String::new(), enclave: false, sso_services: Vec::new(), version: 3, identity_providers: providers };
            let got = code(check_providers(&c["map"], &terms));
            assert_eq!(got, c["expect"].as_str().unwrap(), "providers/{}", c["name"]);
            codes.insert(got.to_string());
            seen += 1;
        }
        for c in doc["journal"].as_array().unwrap() {
            let got = code(check_tighten(&c["entry"], c["applied_tseq"].as_u64().unwrap()));
            assert_eq!(got, c["expect"].as_str().unwrap(), "journal/{}", c["name"]);
            seen += 1;
        }
        assert!(seen >= 60, "only {seen} cases");
        for want in ["map-version", "scope-kind", "reach", "ceiling", "mtls-needed", "recipient", "directory", "credential", "webhook", "federation", "license"] {
            assert!(codes.contains(want), "no vector refuses with {want}");
        }
    }

    #[test]
    fn a_map_over_the_edition_is_set_aside_and_restored() {
        assert_eq!((Edition::of(Some("standard")), Edition::of(Some("enterprise")), Edition::of(None), Edition::of(Some("pro"))), (Some(Edition::Standard), Some(Edition::Enterprise), None, None));
        let mut s = ApiMapStore::load(None);
        // an Enterprise-only map (a splunk_hec destination)
        s.pin(verified(good_map(1))).unwrap();
        assert_eq!(s.revalidate(Some(Edition::Enterprise)), Vec::<String>::new());
        assert!(s.get("acme", "").is_some());
        assert_eq!(s.revalidate(Some(Edition::Standard)), ["acme"]);
        assert!(s.is_set_aside("acme"));
        assert!(s.get("acme", "").is_none() && s.clients("acme").is_empty() && s.relay_origins("acme").is_none() && s.grace_hours("acme", "app", NOW).is_none(), "the org serves nothing");
        assert_eq!(s.head("acme").0, 1, "the map is kept");
        assert_eq!(crate::api_issue::closed(&s, "acme", NOW), Some("map-edition"));
        assert_eq!(s.revalidate(Some(Edition::Enterprise)), ["acme"]);
        assert!(!s.is_set_aside("acme"));
        assert_eq!(crate::api_issue::closed(&s, "acme", NOW), None, "restored");
        assert_eq!(s.revalidate(None), ["acme"], "an unknown edition serves no map");
        assert!(s.is_set_aside("acme"));
        // an unknown edition accepts no map either
        let trust_root = crate::meet_x509::Cert::from_pem(serde_json::from_str::<Value>(VECTORS).unwrap()["root_pem"].as_str().unwrap()).unwrap();
        let sp = Obj::new();
        let trust = ApiTrust { root: &trust_root, signer_policy: &sp, root_crl: None, previous_serial: "" };
        assert_eq!(code(s.accept(&json!({"map": good_map(2), "sig": "", "chain": []}), &trust, NOW, None, None)), "map-edition");
    }

    // ---- revision 5 (slice 1c3): connectors, idps and the content and delegated clients ----

    const K1: &str = "k_7a1b2c3d4e5f6a7b";
    const HELPDESK: &str = "helpdesk-api@apps.acme.example";

    fn policy_1c() -> Obj {
        json!({"org": "acme", "domains": ["acme.example"],
               "apps": [{"type": "ai", "principal": "lucid-ai@apps.acme.example"}, {"type": "api", "principal": HELPDESK},
                        {"type": "api", "principal": "sales-api@apps.acme.example"}],
               "ai": {"who": {"groups": ["00g1a2b3c4", "00g5d6e7f8"]}}})
        .as_object()
        .unwrap()
        .clone()
    }

    fn connector(id: &str, name: &str, origin: &str, apps: Value) -> Value {
        json!({"id": id, "name": name, "origin": origin, "apps": apps, "networks": ["10.40.0.0/16"], "stale_s": 60, "state": "active"})
    }

    fn delegated() -> Value {
        let mut c = client("c_0b1c2d3e4f5a6b7c", "claude-ops");
        let o = c.as_object_mut().unwrap();
        for (k, v) in [
            ("kind", json!("agent_delegated")),
            ("reach", json!("R1")),
            ("scopes", json!(["content.read", "content.post"])),
            ("networks", json!([])),
            ("connectors", json!([K1])),
            ("apps", json!([HELPDESK])),
            ("channels", json!(["*"])),
            ("confirm", json!(["content.post"])),
            ("delegation", json!({"groups": ["00g1a2b3c4"], "principals": [], "idps": ["okta"], "consent_days": 7, "denied": ["eve@acme.example"]})),
            ("redirect_uris", json!(["http://127.0.0.1/callback", "https://app.acme.example/cb"])),
            ("loopback_ok", json!(true)),
            ("credentials", json!([{"type": "cimd", "url": "https://claude.ai/oauth/mcp-client.json", "private_ok": false, "expires": NOW + 90 * DAY}])),
        ] {
            o.insert(k.into(), v);
        }
        c
    }

    fn content_client(id: &str, name: &str, kind: &str) -> Value {
        let mut c = client(id, name);
        let o = c.as_object_mut().unwrap();
        for (k, v) in [
            ("kind", json!(kind)),
            ("reach", json!("R1")),
            ("scopes", json!(["content.read", "content.post"])),
            ("connectors", json!([K1])),
            ("apps", json!([HELPDESK])),
            ("channels", json!(["ch:support", "ch:sales"])),
            ("confirm", json!(["content.post"])),
        ] {
            o.insert(k.into(), v);
        }
        c
    }

    fn map_1c() -> Value {
        let mut m = good_map(1);
        m["connectors"] = json!([connector(K1, "helpdesk", "https://connector.acme.example:9445", json!([HELPDESK]))]);
        m["idps"] = json!([{"id": "okta", "provider": "okta", "issuer": "https://acme.okta.com", "algs": ["RS256"], "max_age_s": 300, "private_ok": false, "state": "active"}]);
        let clients = m["clients"].as_array_mut().unwrap();
        clients.push(delegated());
        clients.push(content_client("c_00000000000000b1", "ops-agent", "agent"));
        clients.push(content_client("c_00000000000000b2", "ops-app", "app"));
        m
    }

    /// Revision 5 3.2 and 19: a map with every new key is accepted (in version 1 and 2), and each refused row gets its
    /// code.
    #[test]
    fn revision_5_map_keys_and_their_refusals() {
        let p = policy_1c();
        let none = BTreeMap::new();
        let check = |m: &Value| code(check_api_map(m, NOW, Some(&p), Edition::Enterprise, &none));
        let good = map_1c();
        assert_eq!(check(&good), "ok");
        assert_eq!(version_needed(&good), 1, "the revision 5 keys do not change the version");
        assert_eq!(code(check_api_map(&good, NOW, None, Edition::Enterprise, &none)), "ok", "without a policy");
        let with = |f: &dyn Fn(&mut Value)| {
            let mut m = map_1c();
            f(&mut m);
            check(&m)
        };
        // the refused rows of r5 19
        let second = |origin: &str, apps: Value| connector("k_0000000000000002", "sales", origin, apps);
        assert_eq!(with(&|m| m["connectors"].as_array_mut().unwrap().push(second("https://connector.acme.example:9445", json!(["sales-api@apps.acme.example"])))), "bad-map", "duplicate origin");
        assert_eq!(with(&|m| m["connectors"][0]["origin"] = json!("https://relay1.acme.example:9443")), "bad-map", "a relay's origin");
        assert_eq!(with(&|m| m["connectors"].as_array_mut().unwrap().push(second("https://sales.acme.example:9445", json!([HELPDESK])))), "bad-map", "an app in two connectors");
        assert_eq!(with(&|m| m["clients"][1].as_object_mut().unwrap().remove("connectors").map(|_| ()).unwrap()), "bad-map", "R1 without connectors");
        assert_eq!(with(&|m| m["clients"][1]["delegation"]["groups"] = json!(["00g9z9z9z9"])), "bad-map", "a group outside ai.who.groups");
        assert_eq!(
            with(&|m| {
                m["clients"][1]["ceiling"] = json!("cui");
                m["clients"][1]["mtls_required"] = json!(true);
            }),
            "ceiling",
            "a cui delegated client"
        );
        assert_eq!(with(&|m| m["clients"][1]["ceiling"] = json!("cui")), "ceiling", "ceiling before the cui mtls rule");
        assert_eq!(
            with(&|m| {
                m["clients"][2]["name"] = json!("helpdesk-api");
                m["clients"][2]["principal"] = json!("helpdesk-api@apps.acme.example");
            }),
            "bad-map",
            "a client named like an api app"
        );
        assert_eq!(
            with(&|m| {
                let mut other = delegated();
                other["id"] = json!("c_00000000000000b3");
                other["name"] = json!("claude-two");
                other["principal"] = json!("claude-two@apps.acme.example");
                m["clients"].as_array_mut().unwrap().push(other);
            }),
            "bad-map",
            "two clients with one cimd url"
        );
        assert_eq!(with(&|m| m["clients"][1]["redirect_uris"] = json!(["http://localhost/callback"])), "bad-map", "a localhost redirect");
        assert_eq!(with(&|m| m["connectors"][0]["origin"] = json!("https://console.acme.example:7443")), "bad-map", "the front door's origin (R5-23)");
        // more rows of 3.2
        assert_eq!(with(&|m| m["clients"][2]["confirm"] = json!([])), "bad-map", "an agent with both content scopes confirms posts (R5-14)");
        assert_eq!(with(&|m| m["clients"][1]["confirm"] = json!(["content.read"])), "bad-map", "a delegated client confirms posts");
        assert_eq!(with(&|m| m["clients"][3]["confirm"] = json!([])), "ok", "an app may post unconfirmed");
        assert_eq!(with(&|m| m["clients"][3]["reach"] = json!("R0")), "reach", "an app is R1");
        assert_eq!(with(&|m| m["clients"][3]["apps"] = json!(["sales-api@apps.acme.example"])), "bad-map", "an app not in its connectors");
        assert_eq!(with(&|m| m["clients"][3]["channels"] = json!(["*", "ch:support"])), "bad-map");
        assert_eq!(with(&|m| m["connectors"][0]["apps"] = json!(["bot@apps.acme.example"])), "bad-map", "not an api app of the policy");
        assert_eq!(with(&|m| m["connectors"][0]["origin"] = json!("https://Connector.acme.example:9445")), "bad-map", "not canonical");
        assert_eq!(with(&|m| m["connectors"][0]["stale_s"] = json!(301)), "bad-map");
        assert_eq!(with(&|m| m["idps"][0]["auth_max_s"] = json!(299)), "bad-map");
        assert_eq!(with(&|m| m["idps"][0]["auth_max_s"] = json!(86400)), "ok");
        assert_eq!(with(&|m| m["idps"][0]["algs"] = json!(["HS256"])), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["delegation"]["idps"] = json!(["entra"])), "bad-map", "an idp the map lacks");
        assert_eq!(with(&|m| m["clients"][1]["delegation"]["consent_days"] = json!(31)), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["delegation"]["groups"] = json!([])), "bad-map", "a group or a principal");
        assert_eq!(with(&|m| m["clients"][1]["delegation"]["principals"] = json!(["bob@other.example"])), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["credentials"][0]["expires"] = json!(NOW + 301 * DAY)), "bad-map", "a cimd past its client");
        assert_eq!(with(&|m| m["clients"][2]["credentials"] = m["clients"][1]["credentials"].clone()), "bad-map", "cimd only for agent_delegated");
        assert_eq!(with(&|m| m["clients"][0]["loopback_ok"] = json!(true)), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["delegation"]["extra"] = json!(1)), "bad-map", "unknown fields still refuse");
        assert_eq!(with(&|m| m["connectors"][0]["color"] = json!("blue")), "bad-map");
        assert_eq!(with(&|m| m["clients"][0]["scopes"] = json!(["content.read"])), "reach", "a monitoring client never reads content");
        // standard: no connectors, no content scopes
        assert_eq!(code(check_api_map(&map_1c(), NOW, Some(&p), Edition::Standard, &none)), "license");
        // standard (r5 15): no idps and no app, agent or agent_delegated client, each refused alone
        let standard = |m: &Value| code(check_api_map(m, NOW, Some(&p), Edition::Standard, &none));
        let mut base = good_map(1);
        base["destinations"] = json!([]);
        assert_eq!(standard(&base), "ok");
        let mut no_idps = base.clone();
        no_idps["idps"] = json!([]);
        assert_eq!(standard(&no_idps), "ok", "an empty idps list");
        let mut idp = base.clone();
        idp["idps"] = map_1c()["idps"].clone();
        assert_eq!((check(&idp), standard(&idp)), ("ok", "license"), "an idp");
        let mut agent = base.clone();
        agent["clients"][0]["kind"] = json!("agent");
        assert_eq!((check(&agent), standard(&agent)), ("ok", "license"), "an agent client");
        let mut deleg = base.clone();
        deleg["clients"][0]["kind"] = json!("agent_delegated");
        deleg["clients"][0]["delegation"] = json!({"groups": ["00g1a2b3c4"]});
        assert_eq!((check(&deleg), standard(&deleg)), ("ok", "license"), "an agent_delegated client");
        // an app is always R1 with connectors (refused first), so its own rule is checked directly
        let mut app = client("c_00000000000000b2", "ops-app");
        app["kind"] = json!("app");
        assert_eq!(code(check_standard(&[app], &[])), "license", "an app client");
        assert_eq!(code(check_standard(&[client("c_00000000000000b2", "ops-app")], &[])), "ok");
        // version 2 takes them too
        let mut v2 = map_1c();
        v2["v"] = json!(2);
        v2["webhook_keys"] = json!([]);
        assert_eq!(check(&v2), "ok");
        for (ok, uri) in [
            (true, "http://127.0.0.1/cb"),
            (true, "http://127.0.0.1:8080/cb"),
            (true, "http://[::1]/cb"),
            (false, "http://127.0.0.1"),
            (false, "http://127.0.0.1.evil.example/cb"),
            (false, "http://localhost:8080/cb"),
            (false, "https://app.acme.example/cb#frag"),
            (false, "http://127.0.0.1:0/cb"),
        ] {
            assert_eq!(redirect_ok(uri), ok, "{uri}");
        }
    }

    /// Revision 5 3.2 R5-9 and O16: `check_idps` against the root-signed registry.
    #[test]
    fn idps_are_the_tenant_of_their_registry_provider() {
        let terms = |rows: &[(&str, &str, &str, &str)]| op::SignerTerms {
            identity_providers: rows.iter().map(|(o, id, kind, iss)| op::IdentityProvider { org: (*o).into(), id: (*id).into(), kind: (*kind).into(), iss: (*iss).into(), ..Default::default() }).collect(),
            ..Default::default()
        };
        let okta = terms(&[("acme", "okta", "okta", "https://acme.okta.com")]);
        let m = map_1c();
        assert_eq!(code(check_idps(&m, &okta)), "ok");
        assert_eq!(code(check_idps(&m, &terms(&[("acme", "okta", "okta", "https://acme.okta.com/oauth2/default")]))), "ok", "the org server of the entry's domain");
        let mut custom = m.clone();
        custom["idps"][0]["issuer"] = json!("https://acme.okta.com/oauth2/default");
        assert_eq!(code(check_idps(&custom, &okta)), "idp", "never a custom authorization server");
        let mut other = m.clone();
        other["idps"][0]["issuer"] = json!("https://evil.okta.com");
        assert_eq!(code(check_idps(&other, &okta)), "idp", "another host");
        assert_eq!(code(check_idps(&m, &terms(&[("beta", "okta", "okta", "https://acme.okta.com")]))), "idp", "another org's provider");
        let entra = terms(&[("acme", "okta", "entra", "https://login.microsoftonline.com/t/v2.0")]);
        let mut e = m.clone();
        e["idps"][0]["issuer"] = json!("https://login.microsoftonline.com/t/v2.0");
        assert_eq!(code(check_idps(&e, &entra)), "ok");
        e["idps"][0]["issuer"] = json!("https://login.microsoftonline.com/u/v2.0");
        assert_eq!(code(check_idps(&e, &entra)), "idp");
        // O16: a delegated client needs a registry provider of the org
        let mut no_idps = m.clone();
        no_idps["idps"] = json!([]);
        assert_eq!(code(check_idps(&no_idps, &terms(&[]))), "idp");
        assert_eq!(code(check_idps(&no_idps, &terms(&[("acme", "lg", "logingov", "https://secure.login.gov/")]))), "ok");
        assert_eq!(code(check_idps(&good_map(1), &terms(&[]))), "ok", "no delegated client, no idps");
    }

    // ---- revision 6 (slice 1d1): Remote Spokes ----

    const ROOT_N: &str = "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const HUB_NODE: &str = "n_5e6f708192a3b4c5d6e7f8091a2b3c4d";
    const SPOKE: &str = "n_a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const HUB: &str = "c_9a8b7c6d5e4f3a2b";

    fn node_cred(serial: char, key_store: &str) -> Value {
        json!({"type": "spokes_node", "node": HUB_NODE, "serial": serial.to_string().repeat(32), "spki": "e".repeat(64), "expires": NOW + 60 * DAY, "key_store": key_store})
    }

    fn spokes_hub() -> Value {
        let mut c = client(HUB, "build-hub");
        let o = c.as_object_mut().unwrap();
        for (k, v) in [
            ("kind", json!("spokes_hub")),
            ("reach", json!("R1")),
            ("scopes", json!(["spokes.tasks.submit"])),
            ("ceiling", json!("confidential")),
            ("relays", json!(["r_21"])),
            ("credentials", json!([node_cred('1', "pkcs11")])),
            ("spokes", json!({"targets": [SPOKE]})),
        ] {
            o.insert(k.into(), v);
        }
        c
    }

    fn map_1d() -> Value {
        let mut m = good_map(1);
        m["spokes"] = json!({"root": ROOT_N, "root_spki": "a".repeat(64), "relays": ["r_21", "r_22"]});
        m["clients"].as_array_mut().unwrap().push(spokes_hub());
        m
    }

    /// Revision 6 2.1, 2.2, 4.1, 4.2 and 14: the `spokes` key, the spokes_hub kind, the spokes_node credential, its
    /// key store and the ceiling, and `spokes.read`.
    #[test]
    fn revision_6_spokes_map_rules() {
        let p = policy();
        let none = BTreeMap::new();
        let check = |m: &Value| code(check_api_map(m, NOW, Some(&p), Edition::Enterprise, &none));
        let good = map_1d();
        assert_eq!(check(&good), "ok");
        assert_eq!(version_needed(&good), 1, "spokes does not change the version");
        assert_eq!(code(check_api_map(&good, NOW, None, Edition::Enterprise, &none)), "ok", "without a policy");
        let with = |f: &dyn Fn(&mut Value)| {
            let mut m = map_1d();
            f(&mut m);
            check(&m)
        };
        // the spokes key
        assert_eq!(with(&|m| m.as_object_mut().unwrap().remove("spokes").map(|_| ()).unwrap()), "bad-map", "a spokes_hub without spokes");
        assert_eq!(with(&|m| m["spokes"]["root"] = json!("n_0F1E2D3C4B5A69788796A5B4C3D2E1F0")), "bad-map", "root not lowercase");
        assert_eq!(with(&|m| m["spokes"]["root"] = json!("r_0f1e2d3c4b5a69788796a5b4c3d2e1f0")), "bad-map");
        assert_eq!(with(&|m| m["spokes"]["root_spki"] = json!("a".repeat(63))), "bad-map");
        assert_eq!(with(&|m| m["spokes"]["relays"] = json!(["r_21", "r_01"])), "bad-map", "a Meet relay");
        assert_eq!(with(&|m| m["spokes"]["relays"] = json!(["r_21", "console"])), "bad-map", "the console");
        assert_eq!(with(&|m| m["spokes"]["relays"] = json!(["r_21", "r_21"])), "bad-map", "twice");
        assert_eq!(with(&|m| m["spokes"]["relays"] = json!((0..65).map(|i| format!("s_{i}")).collect::<Vec<_>>())), "bad-map");
        assert_eq!(with(&|m| m["spokes"]["extra"] = json!(1)), "bad-map");
        assert_eq!(with(&|m| m.as_object_mut().unwrap().remove("relay_origins").map(|_| ()).unwrap()), "ok");
        assert_eq!(
            with(&|m| {
                m["spokes"]["relays"] = json!([]);
                m["clients"][1]["relays"] = json!(["*"]);
            }),
            "ok",
            "no spokes relay bound yet"
        );
        assert_eq!(with(&|m| m["spokes"]["relays"] = json!([])), "bad-map", "a client relay outside spokes.relays");
        assert_eq!(with(&|m| m["a2a"] = json!({})), "ok", "an a2a without agents or keys");
        // the spokes_hub client
        assert_eq!(with(&|m| m["clients"][1]["relays"] = json!(["r_01"])), "bad-map", "a Meet relay");
        assert_eq!(with(&|m| m["clients"][1]["relays"] = json!(["console"])), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["relays"] = json!(["*"])), "ok");
        assert_eq!(with(&|m| m["clients"][1]["mtls_required"] = json!(true)), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["ceiling"] = json!("cui")), "ok", "cui with a hardware key and no mtls (R6-4)");
        assert_eq!(
            with(&|m| {
                m["clients"][1]["ceiling"] = json!("cui");
                m["clients"][1]["credentials"] = json!([node_cred('1', "pkcs11"), node_cred('2', "os_store")]);
            }),
            "ceiling"
        );
        assert_eq!(with(&|m| m["clients"][1]["credentials"] = json!([node_cred('1', "os_store")])), "ok", "confidential with an os_store key");
        for ks in ["azure_key_vault", "tpm"] {
            assert_eq!(
                with(&|m| {
                    m["clients"][1]["ceiling"] = json!("cui");
                    m["clients"][1]["credentials"] = json!([node_cred('1', ks)]);
                }),
                "ok",
                "{ks}"
            );
        }
        assert_eq!(with(&|m| m["clients"][1]["credentials"] = json!([node_cred('1', "file")])), "bad-map", "a plain file key");
        assert_eq!(with(&|m| m["clients"][1]["credentials"][0]["serial"] = json!("1a2b3c")), "bad-map", "a short serial");
        assert_eq!(with(&|m| m["clients"][1]["credentials"][0]["node"] = json!("n_123")), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["credentials"][0]["kid"] = json!("k1")), "bad-map", "exact keys");
        assert_eq!(with(&|m| m["clients"][1]["credentials"] = json!([node_cred('1', "pkcs11"), node_cred('2', "tpm")])), "ok", "a renewal overlap");
        assert_eq!(with(&|m| m["clients"][1]["credentials"] = json!([node_cred('1', "pkcs11"), node_cred('2', "tpm"), node_cred('3', "tpm")])), "credential");
        assert_eq!(with(&|m| m["clients"][1]["credentials"] = json!([node_cred('1', "pkcs11"), node_cred('1', "tpm")])), "bad-map", "one serial twice");
        assert_eq!(with(&|m| m["clients"][1]["credentials"] = m["clients"][0]["credentials"].clone()), "credential", "a private_key_jwt on a spokes_hub");
        assert_eq!(with(&|m| m["clients"][0]["credentials"] = json!([node_cred('2', "pkcs11")])), "credential", "a spokes_node on a monitoring client");
        assert_eq!(with(&|m| m["clients"][1]["scopes"] = json!(["spokes.tasks.submit", "monitor.read"])), "scope-kind", "a second scope");
        assert_eq!(with(&|m| m["clients"][1]["reach"] = json!("R0")), "reach");
        assert_eq!(with(&|m| m["clients"][1].as_object_mut().unwrap().remove("spokes").map(|_| ()).unwrap()), "bad-map", "no targets");
        assert_eq!(with(&|m| m["clients"][1]["spokes"]["targets"] = json!(["*"])), "ok");
        assert_eq!(with(&|m| m["clients"][1]["spokes"]["targets"] = json!([])), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["spokes"]["targets"] = json!(["*", SPOKE])), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["spokes"]["targets"] = json!([SPOKE, SPOKE])), "bad-map");
        assert_eq!(with(&|m| m["clients"][1]["spokes"]["more"] = json!(1)), "bad-map");
        assert_eq!(with(&|m| m["clients"][0]["spokes"] = json!({"targets": ["*"]})), "bad-map", "only a spokes_hub has targets");
        assert_eq!(with(&|m| m["clients"][1]["connectors"] = json!(["k_7a1b2c3d4e5f6a7b"])), "bad-map", "no connectors");
        assert_eq!(with(&|m| m["clients"][1]["principal"] = json!("build-hub@acme.example")), "bad-map", "an app principal");
        assert_eq!(
            with(&|m| {
                let mut other = spokes_hub();
                other["id"] = json!("c_9a8b7c6d5e4f3a2c");
                other["name"] = json!("build-hub-2");
                other["principal"] = json!("build-hub-2@apps.acme.example");
                other["credentials"] = json!([node_cred('2', "pkcs11")]);
                m["clients"].as_array_mut().unwrap().push(other);
            }),
            "bad-map",
            "one service hub node in two clients"
        );
        // the scopes elsewhere
        assert_eq!(with(&|m| m["clients"][0]["scopes"] = json!(["monitor.read", "spokes.read"])), "ok");
        assert_eq!(with(&|m| m["clients"][0]["kind"] = json!("integration")), "ok");
        assert_eq!(
            with(&|m| {
                m["clients"][0]["kind"] = json!("compliance");
                m["clients"][0]["scopes"] = json!(["spokes.read"]);
            }),
            "scope-kind"
        );
        assert_eq!(
            with(&|m| {
                m["clients"][0]["kind"] = json!("agent");
                m["clients"][0]["reach"] = json!("R1");
                m["clients"][0]["scopes"] = json!(["spokes.tasks.submit"]);
            }),
            "bad-map",
            "an agent with spokes.tasks.submit needs connectors and a2a"
        );
        assert_eq!(with(&|m| m["clients"][0]["scopes"] = json!(["spokes.tasks.submit"])), "scope-kind", "a monitoring client");
        // the standard edition has none of it
        assert_eq!(code(check_api_map(&good, NOW, Some(&p), Edition::Standard, &none)), "license");
        let mut read = good_map(1);
        read["destinations"] = json!([]);
        assert_eq!(code(check_api_map(&read, NOW, Some(&p), Edition::Standard, &none)), "ok");
        read["clients"][0]["scopes"] = json!(["monitor.read", "spokes.read"]);
        assert_eq!(code(check_api_map(&read, NOW, Some(&p), Edition::Standard, &none)), "license");
        read["clients"][0]["scopes"] = json!(["monitor.read"]);
        read["spokes"] = json!({"root": ROOT_N, "root_spki": "a".repeat(64), "relays": []});
        assert_eq!(code(check_api_map(&read, NOW, Some(&p), Edition::Standard, &none)), "license");
        // the getters
        let o = good.as_object().unwrap();
        assert_eq!(spokes_root(o), Some((ROOT_N, "a".repeat(64).as_str())));
        assert_eq!(spokes_relays(o), ["r_21", "r_22"]);
        let plain = good_map(1);
        assert_eq!((spokes_root(plain.as_object().unwrap()), spokes_relays(plain.as_object().unwrap())), (None, Vec::<&str>::new()));
    }

    const AGENT: &str = "a_7c1d2e3f4a5b6c7d";
    const PARTNER: &str = "c_0b1c2d3e4f506172";
    const OTHER_SPOKE: &str = "n_00000000000000000000000000000001";

    fn card_key(kid: &str) -> Value {
        json!({"kty": "EC", "crv": "P-256", "kid": kid, "x": x(), "y": x(), "use": "sig", "alg": "ES256", "nbf": NOW, "exp": NOW + 393 * DAY})
    }

    /// The agent of revision 6 2.1 (its skill without `idle_close_s`, which goes with `turns: many` only).
    fn agent() -> Value {
        json!({"id": AGENT, "name": "Acme Build Agent",
               "description": "Runs build and test tasks on Acme's Remote Spokes after a person at Acme approves each task.",
               "version": "1.0.0", "connector": K1, "hub": HUB,
               "provider": {"organization": "Acme Robotics", "url": "https://acme.example"},
               "documentation_url": "https://acme.example/agents/build", "streaming": true, "push": true,
               "skills": [{"id": "build-and-test", "name": "Build and test",
                           "description": "Builds the named branch and runs its tests; returns the log summary and a review branch.",
                           "tags": ["build", "test"], "examples": ["Build branch release/2.3 and run the unit tests"],
                           "targets": [SPOKE], "model": "anthropic/claude-sonnet-4-6", "turns": "one", "approve_within_s": 3600}]})
    }

    /// The partner agent client of revision 6 2.1.
    fn partner() -> Value {
        let mut c = client(PARTNER, "partner-ci");
        let o = c.as_object_mut().unwrap();
        for (k, v) in [
            ("kind", json!("agent")),
            ("reach", json!("R1")),
            ("scopes", json!(["spokes.tasks.submit"])),
            ("ceiling", json!("confidential")),
            ("relays", json!(["console"])),
            ("networks", json!([])),
            ("connectors", json!([K1])),
            ("a2a", json!({"agents": [AGENT], "skills": ["*"], "max_open_tasks": 8, "push": {"origins": ["https://ci.partner.example"], "private_cidrs": []}})),
            ("card", json!({"url": "https://ci.partner.example/.well-known/agent-card.json", "jwks_uri": "https://ci.partner.example/jwks.json", "private_cidrs": []})),
        ] {
            o.insert(k.into(), v);
        }
        c
    }

    /// The map of revision 6 2.1: `spokes`, a connector, `a2a` with one card key and one agent, the service hub
    /// (`clients[1]`) and the partner (`clients[2]`).
    fn map_1d5() -> Value {
        let mut m = map_1d();
        m["connectors"] = json!([connector(K1, "helpdesk", "https://connector.acme.example:9445", json!([HELPDESK]))]);
        m["a2a"] = json!({"jwks": [card_key("a2a-2026-11")], "well_known": AGENT, "agents": [agent()]});
        m["clients"].as_array_mut().unwrap().push(partner());
        m
    }

    /// Revision 6 2.1, 2.2, 4.1 and 14 (slice 1d5): the `a2a` key, its agents and skills, the partner agent client's
    /// `a2a` and `card`, and every refused row.
    #[test]
    fn revision_6_a2a_map_rules() {
        let p = policy_1c();
        let none = BTreeMap::new();
        let check = |m: &Value| code(check_api_map(m, NOW, Some(&p), Edition::Enterprise, &none));
        let good = map_1d5();
        assert_eq!(check(&good), "ok");
        assert_eq!(version_needed(&good), 1, "a2a does not change the version");
        assert_eq!(code(check_api_map(&good, NOW, None, Edition::Enterprise, &none)), "ok", "without a policy");
        let with = |f: &dyn Fn(&mut Value)| {
            let mut m = map_1d5();
            f(&mut m);
            check(&m)
        };
        let skill = |f: &dyn Fn(&mut Value)| with(&|m| f(&mut m["a2a"]["agents"][0]["skills"][0]));
        let a2a = |f: &dyn Fn(&mut Value)| with(&|m| f(&mut m["clients"][2]["a2a"]));
        // a2a itself
        // without agents the partner (clients[2], which names the agent) goes too
        let no_partner = |m: &mut Value| {
            m["clients"].as_array_mut().unwrap().truncate(2);
        };
        assert_eq!(
            with(&|m| {
                no_partner(m);
                m["a2a"] = json!({});
            }),
            "ok"
        );
        assert_eq!(
            with(&|m| {
                no_partner(m);
                m["a2a"] = json!({"jwks": [card_key("a2a-1")]});
            }),
            "ok",
            "a key staged before any agent"
        );
        assert_eq!(with(&|m| m["a2a"] = json!({})), "bad-map", "the partner names an agent the map no longer lists");
        assert_eq!(with(&|m| m["a2a"].as_object_mut().unwrap().remove("well_known").map(|_| ()).unwrap()), "ok");
        assert_eq!(with(&|m| m["a2a"]["more"] = json!(1)), "bad-map");
        assert_eq!(with(&|m| m["a2a"].as_object_mut().unwrap().remove("jwks").map(|_| ()).unwrap()), "bad-map", "agents need a card key");
        assert_eq!(with(&|m| m["a2a"]["jwks"] = json!([])), "bad-map");
        assert_eq!(with(&|m| m["a2a"]["jwks"] = json!((1..=4).map(|i| card_key(&format!("a2a-{i}"))).collect::<Vec<_>>())), "bad-map", "four keys");
        assert_eq!(with(&|m| m["a2a"]["jwks"] = json!([card_key("a2a-1"), card_key("a2a-2"), card_key("a2a-3")])), "ok", "three keys");
        assert_eq!(with(&|m| m["a2a"]["jwks"] = json!([card_key("a2a-1"), card_key("a2a-1")])), "bad-map", "a kid twice");
        assert_eq!(with(&|m| m["a2a"]["jwks"] = json!([card_key("k-2026-11")])), "bad-map", "an issuer kid");
        assert_eq!(with(&|m| m["a2a"]["jwks"][0]["exp"] = json!(NOW + 401 * DAY)), "bad-map", "longer than 400 days");
        assert_eq!(with(&|m| m["a2a"]["jwks"][0]["alg"] = json!("RS256")), "bad-map");
        assert_eq!(with(&|m| m["a2a"]["well_known"] = json!("a_0000000000000000")), "bad-map", "not an agent of this map");
        assert_eq!(with(&|m| m.as_object_mut().unwrap().remove("spokes").map(|_| ()).unwrap()), "bad-map", "agents need spokes");
        // the agents
        assert_eq!(with(&|m| m["a2a"]["agents"] = json!([])), "bad-map", "well_known names no agent");
        assert_eq!(
            with(&|m| {
                m["a2a"]["agents"] = json!([]);
                m["a2a"].as_object_mut().unwrap().remove("well_known");
                m["clients"].as_array_mut().unwrap().truncate(2);
            }),
            "ok",
            "no agents"
        );
        assert_eq!(with(&|m| m["a2a"]["agents"] = json!(vec![agent(); 17])), "bad-map", "17 agents");
        assert_eq!(with(&|m| m["a2a"]["agents"] = json!([agent(), agent()])), "bad-map", "an id twice");
        assert_eq!(
            with(&|m| {
                let mut two = agent();
                two["id"] = json!("a_7c1d2e3f4a5b6c7e");
                m["a2a"]["agents"].as_array_mut().unwrap().push(two);
            }),
            "bad-map",
            "one hub for two agents"
        );
        let field = |k: &'static str, v: Value| with(&move |m| m["a2a"]["agents"][0][k] = v.clone());
        assert_eq!(field("id", json!("a_7C1D2E3F4A5B6C7D")), "bad-map");
        assert_eq!(field("id", json!("c_7c1d2e3f4a5b6c7d")), "bad-map");
        assert_eq!(field("name", json!("")), "bad-map");
        assert_eq!(field("name", json!("n".repeat(65))), "bad-map");
        assert_eq!(field("name", json!("Acme\nAgent")), "bad-map", "a control character");
        assert_eq!(field("name", json!("Acme Bau-Agent für Tests")), "ok", "non-ASCII text");
        assert_eq!(field("description", json!("d".repeat(1025))), "bad-map");
        assert_eq!(field("version", json!("2.0.0+build.1-rc")), "ok");
        assert_eq!(field("version", json!("1.0 beta")), "bad-map");
        assert_eq!(field("version", json!("1".repeat(33))), "bad-map");
        assert_eq!(field("connector", json!("k_0000000000000000")), "bad-map");
        assert_eq!(field("hub", json!("c_0000000000000000")), "bad-map", "not a client");
        assert_eq!(field("hub", json!("c_5f1a2b3c4d5e6f70")), "bad-map", "a monitoring client");
        assert_eq!(field("provider", json!({"organization": "Acme Robotics"})), "bad-map");
        assert_eq!(field("provider", json!({"organization": "Acme Robotics", "url": "http://acme.example"})), "bad-map");
        assert_eq!(field("documentation_url", json!(format!("https://acme.example/{}", "d".repeat(500)))), "bad-map", "over 512");
        assert_eq!(with(&|m| m["a2a"]["agents"][0].as_object_mut().unwrap().remove("provider").map(|_| ()).unwrap()), "ok");
        assert_eq!(field("streaming", json!("yes")), "bad-map");
        assert_eq!(field("push", json!(false)), "ok");
        assert_eq!(field("extra", json!(1)), "bad-map");
        assert_eq!(field("skills", json!([])), "bad-map");
        // the skills
        assert_eq!(skill(&|s| s["id"] = json!("Build")), "bad-map");
        assert_eq!(field("skills", json!(vec![agent()["skills"][0].clone(); 2])), "bad-map", "a skill id twice");
        assert_eq!(skill(&|s| s["tags"] = json!([])), "bad-map");
        assert_eq!(skill(&|s| s["tags"] = json!((0..9).map(|i| format!("t{i}")).collect::<Vec<_>>())), "bad-map");
        assert_eq!(skill(&|s| s["tags"] = json!(["t".repeat(33)])), "bad-map");
        assert_eq!(skill(&|s| s["examples"] = json!(["a", "b", "c", "d", "e"])), "bad-map");
        assert_eq!(skill(&|s| s.as_object_mut().unwrap().remove("examples").map(|_| ()).unwrap()), "ok");
        assert_eq!(skill(&|s| s["targets"] = json!([OTHER_SPOKE])), "bad-map", "a target outside the hub's targets");
        assert_eq!(
            with(&|m| {
                m["clients"][1]["spokes"]["targets"] = json!(["*"]);
                m["a2a"]["agents"][0]["skills"][0]["targets"] = json!([OTHER_SPOKE, SPOKE]);
            }),
            "ok",
            "a hub with every target"
        );
        assert_eq!(skill(&|s| s["targets"] = json!(["*"])), "bad-map");
        assert_eq!(skill(&|s| s["model"] = json!("Claude")), "bad-map");
        assert_eq!(skill(&|s| s["model"] = json!("-x/claude")), "bad-map");
        assert_eq!(skill(&|s| s["model"] = json!("openai/gpt-5.1:latest")), "ok");
        assert_eq!(skill(&|s| s.as_object_mut().unwrap().remove("model").map(|_| ()).unwrap()), "ok");
        assert_eq!(skill(&|s| s["turns"] = json!("two")), "bad-map");
        assert_eq!(skill(&|s| s["approve_within_s"] = json!(299)), "bad-map");
        assert_eq!(skill(&|s| s["approve_within_s"] = json!(86401)), "bad-map");
        assert_eq!(skill(&|s| s["idle_close_s"] = json!(3600)), "bad-map", "idle_close_s with turns one");
        assert_eq!(
            skill(&|s| {
                s["turns"] = json!("many");
                s["idle_close_s"] = json!(3600);
            }),
            "ok"
        );
        assert_eq!(
            skill(&|s| {
                s["turns"] = json!("many");
                s["idle_close_s"] = json!(200);
            }),
            "bad-map"
        );
        assert_eq!(skill(&|s| s["turns"] = json!("many")), "ok", "idle_close_s is optional");
        assert_eq!(skill(&|s| s["extra"] = json!(1)), "bad-map");
        // the partner agent client
        assert_eq!(with(&|m| m["clients"][2].as_object_mut().unwrap().remove("a2a").map(|_| ()).unwrap()), "bad-map", "spokes.tasks.submit needs a2a");
        assert_eq!(with(&|m| m["clients"][2].as_object_mut().unwrap().remove("card").map(|_| ()).unwrap()), "ok", "card is optional");
        assert_eq!(with(&|m| m["clients"][0]["a2a"] = m["clients"][2]["a2a"].clone()), "bad-map", "a2a on a monitoring client");
        assert_eq!(with(&|m| m["clients"][1]["a2a"] = m["clients"][2]["a2a"].clone()), "bad-map", "a2a on the service hub");
        assert_eq!(with(&|m| m["clients"][2]["reach"] = json!("R0")), "reach");
        assert_eq!(
            with(&|m| {
                let c = &mut m["clients"][2];
                c["scopes"] = json!(["content.read", "content.post", "spokes.tasks.submit"]);
                c["apps"] = json!([HELPDESK]);
                c["channels"] = json!(["*"]);
                c["confirm"] = json!(["content.post"]);
            }),
            "ok",
            "r5 content scopes beside spokes.tasks.submit"
        );
        let content = |f: &dyn Fn(&mut Value)| {
            with(&|m| {
                let mut c = content_client("c_00000000000000b1", "ops-agent", "agent");
                f(&mut c);
                m["clients"].as_array_mut().unwrap().push(c);
            })
        };
        assert_eq!(content(&|_| {}), "ok", "an agent without spokes.tasks.submit follows revision 5 (R5-17)");
        assert_eq!(content(&|c| c["a2a"] = partner()["a2a"].clone()), "bad-map", "a2a without spokes.tasks.submit");
        assert_eq!(content(&|c| c["card"] = partner()["card"].clone()), "bad-map", "card without a2a");
        assert_eq!(a2a(&|a| a["agents"] = json!([])), "bad-map");
        assert_eq!(a2a(&|a| a["agents"] = json!(["a_0000000000000000"])), "bad-map");
        assert_eq!(a2a(&|a| a["agents"] = json!([AGENT, AGENT])), "bad-map");
        assert_eq!(a2a(&|a| a["skills"] = json!([format!("{AGENT}/build-and-test")])), "ok");
        assert_eq!(a2a(&|a| a["skills"] = json!([format!("{AGENT}/deploy")])), "bad-map", "no such skill");
        assert_eq!(a2a(&|a| a["skills"] = json!(["a_0000000000000000/build-and-test"])), "bad-map", "an agent the client does not hold");
        assert_eq!(a2a(&|a| a["skills"] = json!(["build-and-test"])), "bad-map");
        assert_eq!(a2a(&|a| a["skills"] = json!(["*", format!("{AGENT}/build-and-test")])), "bad-map");
        assert_eq!(a2a(&|a| a["skills"] = json!([])), "bad-map");
        assert_eq!(a2a(&|a| a["max_open_tasks"] = json!(0)), "bad-map");
        assert_eq!(a2a(&|a| a["max_open_tasks"] = json!(257)), "bad-map");
        assert_eq!(a2a(&|a| a["max_open_tasks"] = json!(256)), "ok");
        assert_eq!(a2a(&|a| a["more"] = json!(1)), "bad-map");
        assert_eq!(a2a(&|a| a.as_object_mut().unwrap().remove("push").map(|_| ()).unwrap()), "ok");
        assert_eq!(a2a(&|a| a["push"] = json!({"origins": ["https://ci.partner.example:8443"]})), "ok", "private_cidrs is optional");
        for origin in ["https://ci.partner.example/hooks", "http://ci.partner.example", "https://ci.partner.example:443", "https://CI.partner.example", "https://ci.partner.example/"] {
            assert_eq!(a2a(&|a| a["push"]["origins"] = json!([origin])), "bad-map", "{origin}");
        }
        assert_eq!(a2a(&|a| a["push"]["origins"] = json!([])), "bad-map");
        assert_eq!(a2a(&|a| a["push"]["origins"] = json!((0..9).map(|i| format!("https://h{i}.partner.example")).collect::<Vec<_>>())), "bad-map");
        assert_eq!(a2a(&|a| a["push"]["private_cidrs"] = json!(["10.1.0.0/16", "172.16.4.0/24", "192.168.0.0/16", "100.64.0.0/10", "fd12:3456::/32"])), "ok");
        for cidr in ["8.8.8.0/24", "10.0.0.0/7", "172.32.0.0/16", "100.128.0.0/16", "2001:db8::/32", "10.1.0.1/16"] {
            assert_eq!(a2a(&|a| a["push"]["private_cidrs"] = json!([cidr])), "bad-map", "{cidr}");
        }
        assert_eq!(
            with(&|m| {
                m["connectors"].as_array_mut().unwrap().push(connector("k_7a1b2c3d4e5f6a7c", "sales", "https://sales.acme.example:9445", json!(["sales-api@apps.acme.example"])));
                m["clients"][2]["connectors"] = json!(["k_7a1b2c3d4e5f6a7c"]);
            }),
            "bad-map",
            "the client's connectors lack the agent's"
        );
        let card = |f: &dyn Fn(&mut Value)| with(&|m| f(&mut m["clients"][2]["card"]));
        assert_eq!(card(&|k| k["url"] = json!("http://ci.partner.example/.well-known/agent-card.json")), "bad-map");
        assert_eq!(card(&|k| k["jwks_uri"] = json!(format!("https://ci.partner.example/{}", "j".repeat(500)))), "bad-map");
        assert_eq!(card(&|k| k.as_object_mut().unwrap().remove("jwks_uri").map(|_| ()).unwrap()), "bad-map");
        assert_eq!(card(&|k| k.as_object_mut().unwrap().remove("private_cidrs").map(|_| ()).unwrap()), "ok");
        assert_eq!(card(&|k| k["private_cidrs"] = json!(["10.9.0.0/16"])), "ok");
        assert_eq!(card(&|k| k["private_cidrs"] = json!(["203.0.113.0/24"])), "bad-map");
        assert_eq!(card(&|k| k["more"] = json!(1)), "bad-map");
        // revision 6 14: the standard edition has no a2a
        let mut plain = good_map(1);
        plain["destinations"] = json!([]);
        assert_eq!(code(check_api_map(&plain, NOW, Some(&p), Edition::Standard, &none)), "ok");
        plain["a2a"] = json!({});
        assert_eq!(code(check_api_map(&plain, NOW, Some(&p), Edition::Standard, &none)), "license");
        assert_eq!(code(check_api_map(&good, NOW, Some(&p), Edition::Standard, &none)), "license");
    }

    /// Revision 6 2.2 `well-known-taken` and 7.1.3 `card-version`.
    #[test]
    fn well_known_and_card_version_checks() {
        let named = map_1d5();
        let mut unnamed = map_1d5();
        unnamed["a2a"].as_object_mut().unwrap().remove("well_known");
        assert!(well_known_taken(&named, &[good_map(1), named.clone()]));
        assert!(!well_known_taken(&named, &[good_map(1), unnamed.clone()]));
        assert!(!well_known_taken(&unnamed, &[named.clone()]));
        assert!(!well_known_taken(&named, &[]));
        // the card changes only with a new version
        assert_eq!(card_version_problem(&named, &named, "acme"), None);
        let mut said = named.clone();
        said["a2a"]["agents"][0]["description"] = json!("Runs build tasks.");
        assert_eq!(card_version_problem(&named, &said, "acme"), Some(AGENT.to_string()));
        said["a2a"]["agents"][0]["version"] = json!("1.1.0");
        assert_eq!(card_version_problem(&named, &said, "acme"), None);
        let mut moved = named.clone();
        moved["connectors"][0]["origin"] = json!("https://connector2.acme.example:9445");
        assert_eq!(card_version_problem(&named, &moved, "acme"), Some(AGENT.to_string()), "the card's interface url changes");
        let mut internal = named.clone();
        internal["a2a"]["agents"][0]["skills"][0]["approve_within_s"] = json!(7200);
        assert_eq!(card_version_problem(&named, &internal, "acme"), None, "internal details are not in the card");
        assert_eq!(card_version_problem(&good_map(1), &named, "acme"), None, "a new agent has no old card");
    }

    /// Revision 6 2.3 and 4.2: `client_drop_target` parses and folds; the new scopes and the spokes_node credential
    /// are tightening targets (by type, and by serial as the kid).
    #[test]
    fn revision_6_spokes_journal_parses_and_folds() {
        let target = |t: Value| code(check_tighten(&entry(1, "client_drop_target", t), 0));
        assert_eq!(target(json!({"client": HUB, "spoke": SPOKE})), "ok");
        assert_eq!(target(json!({"client": HUB, "spoke": "n_123"})), "not-tightening");
        assert_eq!(target(json!({"client": HUB, "spoke": "*"})), "not-tightening");
        assert_eq!(target(json!({"client": HUB})), "not-tightening");
        assert_eq!(target(json!({"client": HUB, "spoke": SPOKE, "relay": "r_21"})), "not-tightening");
        assert_eq!(target(json!({"client": "c_1", "spoke": SPOKE})), "not-tightening");
        assert_eq!(target(json!(HUB)), "not-tightening");
        for (action, t) in [
            ("client_drop_scope", json!({"client": HUB, "scope": "spokes.tasks.submit"})),
            ("client_drop_scope", json!({"client": "c_5f1a2b3c4d5e6f70", "scope": "spokes.read"})),
            ("client_drop_credential", json!({"client": HUB, "type": "spokes_node"})),
            ("client_drop_credential", json!({"client": HUB, "kid": "1".repeat(32)})),
        ] {
            assert_eq!(code(check_tighten(&entry(1, action, t.clone()), 0)), "ok", "{action} {t}");
        }
        assert!(RELAY_ACTIONS.contains(&"client_drop_target"));
        let drop = TightenEntry::parse(&entry(1, "client_drop_target", json!({"client": HUB, "spoke": SPOKE}))).unwrap();
        let cred = TightenEntry::parse(&entry(2, "client_drop_credential", json!({"client": HUB, "kid": "1".repeat(32)}))).unwrap();
        let folds = |e: &TightenEntry, f: &dyn Fn(&mut Value)| {
            let mut m = map_1d();
            m["folded"] = json!([e.id]);
            f(&mut m);
            code(fold(std::slice::from_ref(e), &m))
        };
        assert_eq!(folds(&drop, &|_| {}), "fold-mismatch", "the target is still listed");
        assert_eq!(folds(&drop, &|m| m["clients"][1]["spokes"]["targets"] = json!(["*"])), "fold-mismatch", "a star keeps it");
        assert_eq!(folds(&drop, &|m| m["clients"][1]["spokes"]["targets"] = json!(["n_00000000000000000000000000000001"])), "ok");
        assert_eq!(folds(&drop, &|m| m["clients"][1]["state"] = json!("suspended")), "ok");
        assert_eq!(folds(&drop, &|m| m["clients"].as_array_mut().unwrap().truncate(1)), "ok", "the client is gone");
        assert_eq!(folds(&cred, &|_| {}), "fold-mismatch", "the serial is still a credential");
        assert_eq!(folds(&cred, &|m| m["clients"][1]["credentials"] = json!([node_cred('2', "pkcs11")])), "ok", "replaced");
        // cleared like any relay entry
        let mut m = map_1d();
        m["cleared"] = json!([drop.id]);
        assert_eq!(fold(std::slice::from_ref(&drop), &m), Ok(vec![]));
    }

    /// Revision 6 4.2 (R6-4): the console's staging check of certificate clearances against the ceiling.
    #[test]
    fn clearances_within_the_ceiling() {
        for (ceiling, clearances, want) in [
            ("internal", vec![], true),
            ("public", vec!["shareable"], true),
            ("internal", vec!["private"], false),
            ("confidential", vec!["private", "shareable"], true),
            ("confidential", vec!["cui"], false),
            ("cui", vec!["private", "cui"], true),
            ("cui", vec!["secret"], false),
            ("top", vec![], false),
        ] {
            assert_eq!(clearances_within(ceiling, &clearances), want, "{ceiling} {clearances:?}");
        }
    }
}
