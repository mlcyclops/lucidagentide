// Prometheus `/metrics` on the console's browser port (contract AC-2a 10.1): scrape tokens (32 random bytes shown once,
// stored as SHA-256 only, a label, the relays they read, 30 to 365 days, at most 10), the request checks (the metrics
// source list, the High profile's FIPS build, the bearer token, one scrape per 10 s per token) and the exposition of
// the latest accepted snapshot per relay. No cookie or session is ever read here; label values are the console's own
// registry values, escaped.

use crate::codec::{b64u, sha256, sha256_hex, unb64u};
use crate::console::ApiError;
use crate::console_source::{allowed, Cidr};
use crate::fleet_metrics::{fmt_num, Kind, Metrics, PromType, KEYS};
use crate::license::Product;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::net::IpAddr;

pub const TOKEN_PREFIX: &str = "lme_";
pub const TOKEN_BYTES: usize = 32;
pub const TOKENS_MAX: usize = 10;
pub const DAYS_MIN: i64 = 30;
pub const DAYS_MAX: i64 = 365;
pub const DAYS_DEFAULT: i64 = 365;
pub const LABEL_MAX: usize = 64;
/// At most one scrape per 10 s per token.
pub const SCRAPE_GAP_MS: i64 = 10_000;
/// `lucid_relay_up`: connected, with a snapshot in the last 3 minutes.
pub const UP_WINDOW_MS: i64 = 180_000;
pub const CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";
/// The only words a 401 here carries.
pub const UNAUTHORIZED: &str = "Unauthorized.";
const DAY_MS: i64 = 86_400_000;

/// `lucid_relay_health{state}` states (8.2), in order.
pub const HEALTH_STATES: [&str; 4] = ["ok", "warn", "bad", "silent"];
/// `lucid_relay_license_state{state}` states by the 9.1 code (0 to 4).
pub const LICENSE_STATES: [&str; 5] = ["none", "valid", "grace", "expired", "wrong"];
/// `lucid_relay_license_service{state}` states by the 9.1 code (0 to 3, R42-6).
pub const LICENSE_SERVICES: [&str; 4] = ["stopped", "on", "grace", "upgrade-period"];

/// The `# HELP` words of every family (the fleet words vector's `metrics_help`).
pub const HELP: [(&str, &str); 35] = [
    ("lucid_console_info", "Version, security profile and FIPS mode of this Lucid Admin Console."),
    ("lucid_relay_up", "1 when the relay is connected and sent health in the last 3 minutes."),
    ("lucid_relay_last_contact_seconds", "Seconds since the relay was last in touch."),
    ("lucid_relay_health", "The relay's health as the console judges it; 1 for the current state."),
    ("lucid_relay_people_online", "People online on the relay."),
    ("lucid_relay_devices_online", "Meeting Hub devices online on the relay."),
    ("lucid_relay_calls_active", "Meeting Hub calls with two or more people."),
    ("lucid_relay_participants", "People in Meeting Hub calls."),
    ("lucid_relay_call_minutes_total", "Meeting Hub call minutes since the console started."),
    ("lucid_relay_messages_total", "Messages relayed since the console started."),
    ("lucid_relay_hubs_online", "Hubs that checked in during the last 5 minutes."),
    ("lucid_relay_spokes_online", "Spokes that checked in during the last 5 minutes."),
    ("lucid_relay_spokes_total", "Spokes seen in the last 30 days."),
    ("lucid_relay_spokes_busy_total", "Spokes that sent or received mail, summed per minute since the console started."),
    ("lucid_relay_lanes_busy", "Busy lanes on the relay's spokes."),
    ("lucid_relay_lanes_total", "Live lanes on the relay's spokes."),
    ("lucid_relay_seats_used", "License seats in use."),
    ("lucid_relay_seats_total", "License seats allowed."),
    ("lucid_relay_cpu_process_percent", "CPU used by the relay process, percent of the host."),
    ("lucid_relay_cpu_host_percent", "CPU busy on the relay's host, percent."),
    ("lucid_relay_mem_process_bytes", "Memory held by the relay process."),
    ("lucid_relay_mem_host_used_percent", "Memory in use on the relay's host, percent."),
    ("lucid_relay_network_receive_bytes_total", "Bytes received by the relay's host since the console started."),
    ("lucid_relay_network_transmit_bytes_total", "Bytes sent by the relay's host since the console started."),
    ("lucid_relay_conn_open", "Open connections on the relay's listeners."),
    ("lucid_relay_latency_console_seconds", "Round trip from the relay to the console."),
    ("lucid_relay_cert_tls_days", "Days left on the relay's TLS certificate."),
    ("lucid_relay_cert_console_days", "Days left on the relay's own console certificate."),
    ("lucid_relay_cert_mgmt_days", "Days left on the relay's management certificate."),
    ("lucid_relay_cert_signer_days", "Days left on the Meeting Hub signer certificate."),
    ("lucid_relay_crl_days", "Days until the relay's revocation list needs its next update."),
    ("lucid_relay_license_days", "Days left on the relay's license; negative in grace."),
    ("lucid_relay_quota_hits_total", "Requests refused for quota since the console started."),
    ("lucid_relay_license_state", "The relay's license state; 1 for the current state."),
    ("lucid_relay_license_service", "Whether the relay serves people under its license (on, grace, upgrade-period or stopped); 1 for the current state."),
];

pub fn help_of(family: &str) -> &'static str {
    HELP.iter().find(|(f, _)| *f == family).map_or("", |(_, w)| *w)
}

// ── Tokens ──────────────────────────────────────────────────────────────────────────────────────────────────

/// The relays a token reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenRelays {
    All,
    List(Vec<String>),
}

impl TokenRelays {
    pub fn to_json(&self) -> Value {
        match self {
            TokenRelays::All => Value::from("all"),
            TokenRelays::List(ids) => json!(ids),
        }
    }

    /// `"all"` or a list of 1 to 200 distinct console relay ids.
    pub fn from_json(v: &Value) -> Option<TokenRelays> {
        if v == "all" {
            return Some(TokenRelays::All);
        }
        let ids: Vec<String> = v.as_array()?.iter().map(|x| x.as_str().map(str::to_owned)).collect::<Option<_>>()?;
        let ok = (1..=200).contains(&ids.len()) && ids.iter().all(|i| crate::fleet_metrics::relay_id_ok(i)) && ids.iter().enumerate().all(|(n, i)| !ids[..n].contains(i));
        ok.then_some(TokenRelays::List(ids))
    }

    fn names(&self, relay: &str) -> bool {
        match self {
            TokenRelays::All => true,
            TokenRelays::List(ids) => ids.iter().any(|i| i == relay),
        }
    }
}

/// A scrape token as the console keeps it: only the SHA-256 of the token text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenRecord {
    pub hash_hex: String,
    /// The first 8 hex of the SHA-256: the only form audit entries and the page show.
    pub hint: String,
    pub label: String,
    pub relays: TokenRelays,
    pub created_by: String,
    pub created_at: i64,
    pub expires: i64,
    pub last_used_at: Option<i64>,
}

impl TokenRecord {
    pub fn to_json(&self) -> Value {
        json!({
            "sha256": self.hash_hex,
            "hint": self.hint,
            "label": self.label,
            "relays": self.relays.to_json(),
            "createdBy": self.created_by,
            "createdAt": self.created_at,
            "expires": self.expires,
            "lastUsedAt": self.last_used_at,
        })
    }

    pub fn from_json(v: &Value) -> Option<TokenRecord> {
        let o = v.as_object()?;
        let hash_hex = o.get("sha256")?.as_str()?.to_owned();
        if hash_hex.len() != 64 || !hash_hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return None;
        }
        Some(TokenRecord {
            hint: hash_hex[..8].to_owned(),
            label: o.get("label")?.as_str()?.to_owned(),
            relays: TokenRelays::from_json(o.get("relays")?)?,
            created_by: o.get("createdBy")?.as_str()?.to_owned(),
            created_at: o.get("createdAt")?.as_i64()?,
            expires: o.get("expires")?.as_i64()?,
            last_used_at: o.get("lastUsedAt").and_then(Value::as_i64),
            hash_hex,
        })
    }

    /// The `GET /console/api/settings/exports` row.
    pub fn view(&self) -> Value {
        json!({
            "hint": self.hint,
            "label": self.label,
            "relays": self.relays.to_json(),
            "createdBy": self.created_by,
            "createdAt": self.created_at,
            "expires": self.expires,
            "lastUsedAt": self.last_used_at,
        })
    }
}

/// `POST /console/api/settings/exports/token` (after the step-up): a new token, shown once, and its record. The caller
/// checks that every listed relay is in its registry.
pub fn mint_token(label: &str, relays: &TokenRelays, days: Option<i64>, created_by: &str, now: i64, existing: &[TokenRecord]) -> Result<(String, TokenRecord), ApiError> {
    let label = crate::console_auth::clean(label);
    let n = label.chars().count();
    if n == 0 || n > LABEL_MAX {
        return Err(ApiError::with("invalid", "A token label is 1 to 64 characters."));
    }
    let days = days.unwrap_or(DAYS_DEFAULT);
    if !(DAYS_MIN..=DAYS_MAX).contains(&days) {
        return Err(ApiError::with("invalid", "A token lasts 30 to 365 days."));
    }
    if existing.len() >= TOKENS_MAX {
        return Err(ApiError::of("token-limit"));
    }
    let bytes = crate::console_auth::random_bytes(TOKEN_BYTES)?;
    let token = format!("{TOKEN_PREFIX}{}", b64u(&bytes));
    let hash_hex = sha256_hex(token.as_bytes());
    let rec = TokenRecord { hint: hash_hex[..8].to_owned(), hash_hex, label, relays: relays.clone(), created_by: created_by.to_owned(), created_at: now, expires: now + days * DAY_MS, last_used_at: None };
    Ok((token, rec))
}

/// The token of an `Authorization` header: exactly `Bearer lme_<43 base64url characters>` (32 bytes).
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let token = header?.strip_prefix("Bearer ")?;
    let body = token.strip_prefix(TOKEN_PREFIX)?;
    (body.len() == 43 && unb64u(body).is_some_and(|b| b.len() == TOKEN_BYTES)).then_some(token)
}

// ── The scrape ──────────────────────────────────────────────────────────────────────────────────────────────

pub struct ScrapeRequest<'a> {
    pub authorization: Option<&'a str>,
    /// The request's source address (AC-1 `console_source::source_of`).
    pub source: IpAddr,
}

pub struct ExportContext<'a> {
    pub version: &'a str,
    pub profile_high: bool,
    /// A `fips` build in FIPS mode.
    pub fips: bool,
    /// `--metrics-sources`.
    pub sources: &'a [Cidr],
}

/// One registry row, in registry order (the console's own values only).
#[derive(Clone, Debug)]
pub struct RelayRow {
    pub id: String,
    pub name: String,
    pub site: String,
    pub product: Product,
    pub connected: bool,
    pub last_contact_ms: Option<i64>,
    /// `ok`, `warn`, `bad` or `silent` (8.2).
    pub health: String,
    /// The 9.1 code, 0 to 4.
    pub license_state: Option<i64>,
    /// The 9.1 `license_service` code, 0 to 3.
    pub license_service: Option<i64>,
}

/// What `/metrics` answers. `code` names a refusal for the AC-1 global refusal summary; `used_hint` is the token to
/// stamp `lastUsedAt` on.
#[derive(Debug, PartialEq, Eq)]
pub struct ScrapeAnswer {
    pub status: u16,
    pub content_type: &'static str,
    pub retry_after: Option<i64>,
    pub body: Vec<u8>,
    pub used_hint: Option<String>,
    pub code: Option<&'static str>,
}

fn refusal(status: u16, code: &'static str, words: &str, retry_after: Option<i64>) -> ScrapeAnswer {
    ScrapeAnswer { status, content_type: "text/plain; charset=utf-8", retry_after, body: words.as_bytes().to_vec(), used_hint: None, code: Some(code) }
}

/// The per-token scrape times.
#[derive(Default)]
pub struct Exporter {
    last: Mutex<HashMap<String, i64>>,
}

impl Exporter {
    pub fn new() -> Exporter {
        Exporter::default()
    }

    /// `GET /metrics` after the AC-1 host check: the source list, then the High profile's FIPS build, then the token,
    /// then the rate.
    pub fn scrape(&self, req: &ScrapeRequest, tokens: &[TokenRecord], ctx: &ExportContext, rows: &[RelayRow], metrics: &Metrics, now: i64) -> ScrapeAnswer {
        if !allowed(ctx.sources, crate::console_source::canonical(req.source)) {
            return refusal(403, "source", crate::console::SOURCE_REFUSED, None);
        }
        if ctx.profile_high && !ctx.fips {
            return refusal(409, "fips-needed", "The High profile needs the FIPS build for this.", None);
        }
        let Some(token) = bearer(req.authorization) else { return refusal(401, "unauthorized", UNAUTHORIZED, None) };
        let hash = crate::codec::hex(&sha256(token.as_bytes()));
        let rec = tokens.iter().find(|t| aws_lc_rs::constant_time::verify_slices_are_equal(t.hash_hex.as_bytes(), hash.as_bytes()).is_ok());
        let Some(rec) = rec.filter(|r| now < r.expires) else { return refusal(401, "unauthorized", UNAUTHORIZED, None) };
        {
            let mut last = self.last.lock();
            if let Some(at) = last.get(&rec.hash_hex).filter(|at| now - **at < SCRAPE_GAP_MS) {
                let wait = (SCRAPE_GAP_MS - (now - at) + 999) / 1000;
                return refusal(429, "rate", "Too many requests.", Some(wait));
            }
            last.retain(|h, _| tokens.iter().any(|t| &t.hash_hex == h));
            last.insert(rec.hash_hex.clone(), now);
        }
        let named: Vec<&RelayRow> = rows.iter().filter(|r| rec.relays.names(&r.id)).collect();
        let snaps: Vec<Snap> = named.iter().map(|r| Snap::of(r, metrics)).collect();
        let console = ConsoleInfo { version: ctx.version, profile: if ctx.profile_high { "high" } else { "standard" }, fips: ctx.fips };
        let mut text = exposition(&console, &named, &snaps, now);
        text.push_str(&api_families(None, now.div_euclid(1000), false));
        ScrapeAnswer { status: 200, content_type: CONTENT_TYPE, retry_after: None, body: text.into_bytes(), used_hint: Some(rec.hint.clone()), code: None }
    }
}

/// What the exposition needs of one relay's metrics: the latest snapshot's time and values, and the interval totals.
#[derive(Clone, Debug, Default)]
pub struct Snap {
    pub t: Option<i64>,
    pub latest: Map<String, Value>,
    pub totals: Map<String, Value>,
}

impl Snap {
    fn of(row: &RelayRow, metrics: &Metrics) -> Snap {
        let latest = metrics.latest(&row.id);
        let totals = metrics.totals(&row.id).into_iter().map(|(i, x)| (KEYS[i].key.to_owned(), crate::fleet_probe::number(x))).collect();
        Snap { t: latest.as_ref().map(|l| l.t), latest: latest.map(|l| l.m).unwrap_or_default(), totals }
    }
}

pub struct ConsoleInfo<'a> {
    pub version: &'a str,
    pub profile: &'a str,
    pub fips: bool,
}

/// A label value escaped: `\` as `\\`, `"` as `\"`, line feed as `\n`.
pub fn escape_label(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out
}

/// `# HELP` text escaped: `\` as `\\`, line feed as `\n`.
fn escape_help(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\n', "\\n")
}

fn labels(r: &RelayRow) -> String {
    format!("relay=\"{}\",name=\"{}\",site=\"{}\",product=\"{}\"", escape_label(&r.id), escape_label(&r.name), escape_label(&r.site), r.product.as_str())
}

fn family(out: &mut String, name: &str, kind: &str) {
    out.push_str(&format!("# HELP {name} {}\n# TYPE {name} {kind}\n", escape_help(help_of(name))));
}

/// The exposition (text format 0.0.4): `lucid_console_info`, `lucid_relay_up`, `lucid_relay_last_contact_seconds`,
/// `lucid_relay_health{state}`, a gauge or counter for each 9.1 key but the state sets in 9.1 order, then
/// `lucid_relay_license_state{state}` and `lucid_relay_license_service{state}`. Relays in registry order within each
/// family; a null or absent value has no sample; a counter is the sum of every accepted interval value since the
/// console started (no sample before the relay's first value); latency in seconds (the ms value divided by 1000).
pub fn exposition(console: &ConsoleInfo, rows: &[&RelayRow], snaps: &[Snap], now: i64) -> String {
    let mut out = String::new();
    family(&mut out, "lucid_console_info", "gauge");
    out.push_str(&format!("lucid_console_info{{version=\"{}\",profile=\"{}\",fips=\"{}\"}} 1\n", escape_label(console.version), console.profile, console.fips));
    family(&mut out, "lucid_relay_up", "gauge");
    for (r, s) in rows.iter().zip(snaps) {
        let up = r.connected && s.t.is_some_and(|t| now - t <= UP_WINDOW_MS);
        out.push_str(&format!("lucid_relay_up{{{}}} {}\n", labels(r), u8::from(up)));
    }
    family(&mut out, "lucid_relay_last_contact_seconds", "gauge");
    for r in rows {
        if let Some(at) = r.last_contact_ms {
            out.push_str(&format!("lucid_relay_last_contact_seconds{{{}}} {}\n", labels(r), fmt_num((now - at).max(0) as f64 / 1000.0)));
        }
    }
    family(&mut out, "lucid_relay_health", "gauge");
    for r in rows {
        for st in HEALTH_STATES {
            out.push_str(&format!("lucid_relay_health{{{},state=\"{st}\"}} {}\n", labels(r), u8::from(r.health == st)));
        }
    }
    for k in KEYS.iter().filter(|k| k.prom != PromType::Stateset) {
        let counter = k.kind == Kind::Interval;
        family(&mut out, k.family, if counter { "counter" } else { "gauge" });
        for (r, s) in rows.iter().zip(snaps) {
            if !k.of(r.product) {
                continue;
            }
            let v = if counter { s.totals.get(k.key) } else { s.latest.get(k.key) };
            if let Some(x) = v.and_then(Value::as_f64) {
                let x = if counter { x } else { x / k.divide };
                out.push_str(&format!("{}{{{}}} {}\n", k.family, labels(r), fmt_num(x)));
            }
        }
    }
    family(&mut out, "lucid_relay_license_state", "gauge");
    for r in rows {
        let Some(code) = r.license_state.filter(|c| (0..=4).contains(c)) else { continue };
        for (n, st) in LICENSE_STATES.iter().enumerate() {
            out.push_str(&format!("lucid_relay_license_state{{{},state=\"{st}\"}} {}\n", labels(r), u8::from(n as i64 == code)));
        }
    }
    family(&mut out, "lucid_relay_license_service", "gauge");
    for r in rows {
        let Some(code) = r.license_service.filter(|c| (0..=3).contains(c)) else { continue };
        for (n, st) in LICENSE_SERVICES.iter().enumerate() {
            out.push_str(&format!("lucid_relay_license_service{{{},state=\"{st}\"}} {}\n", labels(r), u8::from(n as i64 == code)));
        }
    }
    out
}

/// API-1 10.1: the families of `api_catalog::counters` after `exposition`, for one org (an org's `v1/metrics`) or
/// every org summed (None: the console's own `/metrics`) at `now_s`, HELP and TYPE from the catalog, label values
/// escaped. `lucid_relay_mode` only on a relay (`normal` until a mode is set).
pub fn api_families(org: Option<&str>, now_s: i64, relay: bool) -> String {
    use crate::api_catalog::counters::{rows, Row, FAMILIES};
    let catalog = crate::api_catalog::catalog();
    let mut series = rows(org, now_s);
    if relay && !series.iter().any(|r| r.prom == "lucid_relay_mode") {
        for (mode, v) in [("normal", 1.0), ("failover", 0.0)] {
            series.push(Row { prom: "lucid_relay_mode", labels: vec![("mode".into(), mode.into())], value: v });
        }
    }
    let mut out = String::new();
    for prom in FAMILIES.iter().filter(|p| relay || **p != "lucid_relay_mode") {
        let Some(f) = catalog.family(prom) else { continue };
        out.push_str(&format!("# HELP {prom} {}\n# TYPE {prom} {}\n", escape_help(&f.help), f.kind.prom_type()));
        for r in series.iter().filter(|r| r.prom == *prom) {
            let labels: Vec<String> = r.labels.iter().map(|(k, v)| format!("{k}=\"{}\"", escape_label(v))).collect();
            out.push_str(&format!("{prom}{{{}}} {}\n", labels.join(","), fmt_num(r.value)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::parse_json;
    use crate::console_source::parse_cidr_list;
    use crate::fleet_metrics::{Store, BUDGET};
    use std::sync::Arc;

    const R1: &str = "r_00000000000000a1";
    const R2: &str = "r_00000000000000b2";

    fn vector(name: &str) -> Value {
        let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    fn metrics(name: &str, now: i64) -> Arc<Metrics> {
        let d = std::env::temp_dir().join(format!("lucid-fleet-export-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        Metrics::start(d.join("metrics"), Store::open(d.join("metrics"), BUDGET, Box::new(crate::fleet_metrics::RealFs), None, now))
    }

    fn row(id: &str, name: &str, product: Product) -> RelayRow {
        RelayRow { id: id.into(), name: name.into(), site: "HQ".into(), product, connected: true, last_contact_ms: None, health: "ok".into(), license_state: Some(1), license_service: Some(1) }
    }

    #[test]
    fn help_words_equal_the_words_vector() {
        let w = vector("admin_console_fleet_words_v1.json");
        let help = w["metrics_help"].as_object().expect("metrics_help in the words vector");
        assert_eq!(help.len(), HELP.len());
        for (family, words) in HELP {
            assert_eq!(help.get(family).and_then(Value::as_str), Some(words), "{family}");
            assert!(!words.chars().any(|c| c == '\u{2014}' || c == '\u{2013}'));
        }
        for k in KEYS.iter() {
            assert!(!help_of(k.family).is_empty(), "{}", k.family);
        }
    }

    #[test]
    fn tokens_mint_store_only_the_hash_and_keep_their_limits() {
        let now = 1_000_000;
        let (token, rec) = mint_token("  Grafana \u{202e}prod ", &TokenRelays::All, None, "admin@acme.example", now, &[]).unwrap();
        assert!(token.starts_with("lme_") && token.len() == 47);
        assert_eq!(bearer(Some(&format!("Bearer {token}"))), Some(token.as_str()));
        assert_eq!(rec.hash_hex, sha256_hex(token.as_bytes()));
        assert_eq!(rec.hint, rec.hash_hex[..8]);
        assert_eq!(rec.label, "Grafana prod");
        assert_eq!(rec.expires, now + 365 * DAY_MS);
        // the record never holds the token
        let saved = crate::codec::stringify(&rec.to_json());
        assert!(!saved.contains(&token[4..]));
        assert_eq!(TokenRecord::from_json(&rec.to_json()), Some(rec.clone()));
        assert!(!crate::codec::stringify(&rec.view()).contains(&rec.hash_hex));
        for days in [29, 366] {
            assert_eq!(mint_token("x", &TokenRelays::All, Some(days), "a@b.c", now, &[]).unwrap_err().code, "invalid");
        }
        assert!(mint_token("x", &TokenRelays::All, Some(30), "a@b.c", now, &[]).is_ok());
        assert_eq!(mint_token("", &TokenRelays::All, None, "a@b.c", now, &[]).unwrap_err().code, "invalid");
        assert_eq!(mint_token(&"y".repeat(65), &TokenRelays::All, None, "a@b.c", now, &[]).unwrap_err().code, "invalid");
        let ten = vec![rec; 10];
        assert_eq!(mint_token("x", &TokenRelays::All, None, "a@b.c", now, &ten).unwrap_err().code, "token-limit");
        assert_eq!(TokenRelays::from_json(&json!([R1, R1])), None);
        assert_eq!(TokenRelays::from_json(&json!(["../x"])), None);
        for bad in ["bearer lme_x", "Basic abc", "Bearer lme_short", "Bearer xyz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Bearer lme_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", ""] {
            assert_eq!(bearer(Some(bad)), None, "{bad}");
        }
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn scrape_refusals_and_a_good_token() {
        let now = 50_000_000;
        let m = metrics("scrape", now);
        let snap = json!({"v": 1, "seq": 1, "ts": now, "interval": 60, "m": {"people_online": 4, "messages": 3, "latency_console": 250}});
        m.receive(R1, Product::Spokes, &snap, now - 1_000).unwrap();
        let (token, rec) = mint_token("prom", &TokenRelays::List(vec![R1.into()]), Some(30), "a@b.c", now - DAY_MS, &[]).unwrap();
        let (expired_token, mut expired) = mint_token("old", &TokenRelays::All, Some(30), "a@b.c", now - 40 * DAY_MS, &[]).unwrap();
        expired.expires = now - 1;
        let tokens = vec![rec.clone(), expired];
        let sources = parse_cidr_list("10.0.0.0/8", 4).unwrap();
        let ctx = ExportContext { version: "0.2.0", profile_high: false, fips: false, sources: &sources };
        let rows = vec![row(R1, "Edge \"A\"\\\nB", Product::Spokes), row(R2, "Other", Product::Meet)];
        let ex = Exporter::new();
        let inside: IpAddr = "10.1.2.3".parse().unwrap();
        let auth = format!("Bearer {token}");
        let call = |a: Option<&str>, src: IpAddr, ctx: &ExportContext, tokens: &[TokenRecord], at: i64| ex.scrape(&ScrapeRequest { authorization: a, source: src }, tokens, ctx, &rows, &m, at);
        // from outside the source list: refused before the token is looked at
        let r = call(Some(&auth), "192.168.1.1".parse().unwrap(), &ctx, &tokens, now);
        assert_eq!((r.status, r.code), (403, Some("source")));
        // no token, a wrong one, an expired one, a revoked one (its record gone): 401 with only "Unauthorized."
        let wrong = format!("Bearer lme_{}", "A".repeat(43));
        let expired_auth = format!("Bearer {expired_token}");
        for (a, list) in [(None, &tokens[..]), (Some(wrong.as_str()), &tokens[..]), (Some(expired_auth.as_str()), &tokens[..]), (Some(auth.as_str()), &tokens[1..])] {
            let r = call(a, inside, &ctx, list, now);
            assert_eq!((r.status, r.body.as_slice(), r.code), (401, UNAUTHORIZED.as_bytes(), Some("unauthorized")), "{a:?}");
        }
        // High without the FIPS build
        let high = ExportContext { version: ctx.version, profile_high: true, fips: false, sources: ctx.sources };
        assert_eq!(call(Some(&auth), inside, &high, &tokens, now).code, Some("fips-needed"));
        // a good token: the relays it names only, values scaled, labels escaped
        let ctx = ExportContext { version: "0.2.0", profile_high: false, fips: false, sources: &sources };
        let r = call(Some(&auth), inside, &ctx, &tokens, now);
        assert_eq!((r.status, r.content_type, r.used_hint.as_deref()), (200, CONTENT_TYPE, Some(rec.hint.as_str())));
        let text = String::from_utf8(r.body).unwrap();
        assert!(text.contains("lucid_relay_up{relay=\"r_00000000000000a1\",name=\"Edge \\\"A\\\"\\\\\\nB\",site=\"HQ\",product=\"spokes\"} 1\n"), "{text}");
        assert!(text.contains("lucid_relay_latency_console_seconds{relay=\"r_00000000000000a1\",") && text.contains("} 0.25\n"));
        assert!(text.contains("lucid_relay_messages_total{relay=\"r_00000000000000a1\","));
        assert!(!text.contains(R2), "a relay the token does not name");
        assert!(text.lines().filter(|l| l.starts_with("# TYPE ")).count() >= KEYS.len());
        // too often: 429 with Retry-After, then fine after 10 s
        let r = call(Some(&auth), inside, &ctx, &tokens, now + 4_000);
        assert_eq!((r.status, r.retry_after), (429, Some(6)));
        assert_eq!(call(Some(&auth), inside, &ctx, &tokens, now + 10_000).status, 200);
    }

    #[test]
    fn label_escaping() {
        assert_eq!(escape_label("a\\b\"c\nd"), "a\\\\b\\\"c\\nd");
        assert_eq!(escape_label("plain é"), "plain é");
        let v = vector("admin_console_fleet_metrics_v1.json");
        for c in v["label_escape"].as_array().unwrap() {
            assert_eq!(escape_label(c["in"].as_str().unwrap()), c["out"].as_str().unwrap());
        }
    }

    /// The vector's exact exposition from its registry and snapshots.
    #[test]
    fn vector_exposition_exactly() {
        let v = vector("admin_console_fleet_metrics_v1.json");
        let e = &v["exposition"];
        let now = e["now_ms"].as_i64().unwrap();
        let products: HashMap<String, Product> = v["relays"].as_array().unwrap().iter().map(|r| (r["id"].as_str().unwrap().to_owned(), if r["product"] == "meet" { Product::Meet } else { Product::Spokes })).collect();
        let d = std::env::temp_dir().join(format!("lucid-fleet-export-vector-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let first = v["snapshots"][0]["received_ms"].as_i64().unwrap();
        let m = Metrics::start(d.join("metrics"), Store::open(d.join("metrics"), BUDGET, Box::new(crate::fleet_metrics::RealFs), None, first));
        for c in v["snapshots"].as_array().unwrap() {
            let relay = c["relay"].as_str().unwrap();
            if let Ok(body) = crate::fleet_metrics::parse_snapshot(c["text"].as_str().unwrap()) {
                let _ = m.receive(relay, products[relay], &body, c["received_ms"].as_i64().unwrap());
            }
        }
        let rows: Vec<RelayRow> = e["registry"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| RelayRow {
                id: r["id"].as_str().unwrap().into(),
                name: r["name"].as_str().unwrap().into(),
                site: r["site"].as_str().unwrap().into(),
                product: if r["product"] == "meet" { Product::Meet } else { Product::Spokes },
                connected: r["connected"].as_bool().unwrap(),
                last_contact_ms: r["last_contact_ms"].as_i64(),
                health: r["health"].as_str().unwrap().into(),
                license_state: r["license_state"].as_i64().or_else(|| r["license_state"].as_str().and_then(|s| LICENSE_STATES.iter().position(|x| *x == s)).map(|n| n as i64)),
                license_service: r["license_service"].as_i64().or_else(|| r["license_service"].as_str().and_then(|s| LICENSE_SERVICES.iter().position(|x| *x == s)).map(|n| n as i64)),
            })
            .collect();
        let refs: Vec<&RelayRow> = rows.iter().collect();
        let snaps: Vec<Snap> = rows.iter().map(|r| Snap::of(r, &m)).collect();
        let c = &e["console"];
        let console = ConsoleInfo { version: c["version"].as_str().unwrap(), profile: c["profile"].as_str().unwrap(), fips: c["fips"].as_bool().unwrap() };
        assert_eq!(exposition(&console, &refs, &snaps, now), e["text"].as_str().unwrap());
    }

    #[test]
    fn the_api_families_follow_the_catalog_per_org() {
        use crate::api_catalog::counters;
        let (org, other) = ("export-test-a", "export-test-b");
        counters::api_request(org, "c_\"x\"", "ok");
        counters::api_refusal(other, "export-test-check");
        let text = api_families(Some(org), 1_800_000_000, false);
        for prom in counters::FAMILIES.iter().filter(|p| **p != "lucid_relay_mode") {
            let f = crate::api_catalog::catalog().family(prom).unwrap();
            assert!(text.contains(&format!("# HELP {prom} {}\n# TYPE {prom} {}\n", f.help, f.kind.prom_type())), "{prom}");
        }
        assert!(text.contains("lucid_api_requests_total{client=\"c_\\\"x\\\"\",result=\"ok\"} 1\n"), "{text}");
        assert!(!text.contains("export-test-check"), "another org's series");
        assert!(!text.contains("lucid_relay_mode"), "the console has no relay mode");
        let relay = api_families(Some(org), 1_800_000_000, true);
        assert!(relay.contains("lucid_relay_mode{mode=\"normal\"} 1\nlucid_relay_mode{mode=\"failover\"} 0\n"), "{relay}");
        assert!(api_families(None, 1_800_000_000, false).contains("lucid_api_refusals_total{check=\"export-test-check\"} 1\n"));
    }
}
