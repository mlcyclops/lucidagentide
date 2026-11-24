// API-1 revision 4 (docs/api/contract-r4-1b.md) 7.4, 2.2, 2.4 and 13.1: webhooks. The export engine (`api_export`)
// delivers them; this module holds what is particular to them:
//
// - Standard Webhooks 1.0.0 (https://github.com/standard-webhooks/standard-webhooks, spec/standard-webhooks.md,
//   read 2026-11-23): `webhook-id`, `webhook-timestamp` (Unix seconds of the attempt) and `webhook-signature`, a
//   space-separated list. `v2a` (the default, ruling R4-D9): pure Ed25519 over the raw 32 bytes of SHA-256 of
//   `<endpoint id>.<webhook-id>.<timestamp>.<body>`, the endpoint id being the destination id (`d_...`, no `.`), with
//   the org's webhook keys (`whpk_` public parts in the signed map and at `I/v1/webhooks/keys`). `v1` (a two-person
//   exception): HMAC-SHA256 over `<webhook-id>.<timestamp>.<body>` with a per-destination secret of 32 random bytes,
//   shown once as `whsec_<base64>`. During a rotation every live key (or both secrets) signs. `webhook-id` is `e_` and
//   the first 32 hex of SHA-256 of the CloudEvents `id`, so a retry or a replay carries the same one.
// - Endpoint verification (spec/extensions/endpoint-verification.md, the same day): a dedicated signed `POST` with
//   `webhook-challenge` (32 random bytes, base64); only a 2xx whose `webhook-challenge-response` is exactly
//   `<scheme>,` and base64 of HMAC-SHA256(HMAC-SHA256(endpoint key, "wev-v1"), challenge as received) passes, the
//   endpoint key being the raw public key, `.` and the endpoint id (v2a, any live key) or the raw secret (v1, either
//   secret). The contract's "challenge" is the header value as sent (the extension's rule).
// - The org's webhook keys: Ed25519, drawn on the console and sealed as `api-webhook-<org>-<kid>` (the 32-byte seed),
//   staged into the draft's `webhook_keys` (13.1 `settings/api/webhook-keys`), dropped by the console journal action
//   `webhook_key_drop` (2.4: signing stops and the published set omits it at once). A key signs only while the pinned
//   map lists it with the same public key, inside `nbf`/`exp`, undropped. FIPS builds sign `v2a` only once release
//   gate G-WEBHOOK-ED25519-FIPS is verified (19.3).
// - `v1` secrets, sealed as `secret:<org>:<id>:whsec` (never in the map): the newest signs, the one before it also
//   signs for `SECRET_OVERLAP_S` after a rotation, and the newest has a "rotate by" date 90 days on.
// - The selection of 7.4 (`client_view`): what the destination's named client may read of the feed now (effective
//   scopes, relays, ceiling), None while it is suspended, expired, ownerless, without `events.subscribe`, or the
//   org's API is off or its map expired: such a destination pauses.

use crate::api_audit::Repr;
use crate::api_catalog::Ceiling;
use crate::api_cjournal::{key_dropped, ConsoleEntry};
use crate::api_events::{EventLog, FeedError, FeedQuery, Viewer};
use crate::api_export_wire::{HookAnswer, SinkError};
use crate::api_map::{effective_end, ApiMapStore, CEILINGS};
use crate::api_token::{client_entries, find_client, names, rank, relay_reachable, target_field};
use crate::codec::{b64u, hex, sha256};
use crate::console::ApiError;
use crate::console_api::ConsoleApi;
use crate::console_api_ui::Draft;
use crate::fleet_ca::{vault_do, VaultLock};
use crate::meet_json::{b64, b64_strict};
use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use aws_lc_rs::{constant_time, hmac};
use serde_json::{json, Value};
use std::sync::Arc;

/// Signature identifiers (Standard Webhooks).
pub const V2A: &str = "v2a";
pub const V1: &str = "v1";
/// Serialization prefixes (Standard Webhooks).
pub const WHPK: &str = "whpk_";
pub const WHSEC: &str = "whsec_";
/// 7.4: a `v1` secret is 32 random bytes (Standard Webhooks allows 24 to 64).
pub const SECRET_BYTES: usize = 32;
/// 7.4: the "rotate by" reminder of a `v1` secret.
pub const ROTATE_DAYS: i64 = 90;
/// After a rotation the previous `v1` secret signs too, this long, so the receiver can switch without a gap.
pub const SECRET_OVERLAP_S: i64 = 86_400;
/// How long a webhook key drawn by the console is listed (2.2 allows at most 400 days).
pub const KEY_DAYS: i64 = 365;
/// 2.2: `webhook_keys` holds 0 to 2 keys.
pub const KEYS_MAX: usize = 2;
/// 19.3: Ed25519 must be in the FIPS build's validated module.
pub const FIPS_GATE: &str = "G-WEBHOOK-ED25519-FIPS";
/// 7.4: CloudEvents HTTP binding, structured mode.
pub const CONTENT_TYPE: &str = "application/cloudevents+json";
/// 7.4: `Retry-After` is honored up to 300 s.
pub const RETRY_AFTER_MAX: i64 = 300;
/// The extension's key domain label.
const WEV_LABEL: &[u8] = b"wev-v1";
const DROP: &str = "webhook_key_drop";
const DAY: i64 = 86_400;

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn random(n: usize) -> Result<Vec<u8>, String> {
    crate::console_auth::random(n).ok_or_else(|| "no random bytes".to_owned())
}

// ── Standard Webhooks ─────────────────────────────────────────────────────────────────────────────────────────────

/// 7.4: `e_` and the first 32 hex of SHA-256 of the CloudEvents `id` (no `.`; the same on every retry and replay).
pub fn webhook_id(event_id: &str) -> String {
    format!("e_{}", &hex(&sha256(event_id.as_bytes()))[..32])
}

/// `[endpoint id.]msg id.timestamp.body`.
fn content(endpoint_id: Option<&str>, msg_id: &str, ts: i64, body: &[u8]) -> Vec<u8> {
    let mut c = Vec::with_capacity(body.len() + 96);
    if let Some(e) = endpoint_id {
        c.extend_from_slice(e.as_bytes());
        c.push(b'.');
    }
    c.extend_from_slice(msg_id.as_bytes());
    c.push(b'.');
    c.extend_from_slice(ts.to_string().as_bytes());
    c.push(b'.');
    c.extend_from_slice(body);
    c
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), msg).as_ref().to_vec()
}

/// One org webhook key: the Ed25519 pair (sealed as its 32-byte seed), its kid and public key.
pub struct SignKey {
    pub kid: String,
    pair: Ed25519KeyPair,
    pub public: [u8; 32],
}

impl std::fmt::Debug for SignKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SignKey({:?}, {}, <sealed>)", self.kid, self.whpk())
    }
}

impl SignKey {
    /// The key of a 32-byte seed (the `whsk_` secret key bytes).
    pub fn from_seed(kid: &str, seed: &[u8]) -> Option<SignKey> {
        if seed.len() != 32 {
            return None;
        }
        let pair = Ed25519KeyPair::from_seed_unchecked(seed).ok()?;
        let public: [u8; 32] = pair.public_key().as_ref().try_into().ok()?;
        Some(SignKey { kid: kid.to_owned(), pair, public })
    }

    /// `whpk_` and the standard base64 of the public key.
    pub fn whpk(&self) -> String {
        format!("{WHPK}{}", b64(&self.public))
    }
}

/// `v2a,<base64>`: Ed25519 over SHA-256 of `endpoint_id.msg_id.ts.body`.
pub fn sign_v2a(key: &SignKey, endpoint_id: &str, msg_id: &str, ts: i64, body: &[u8]) -> String {
    let digest = sha256(&content(Some(endpoint_id), msg_id, ts, body));
    format!("{V2A},{}", b64(key.pair.sign(&digest).as_ref()))
}

/// `v1,<base64>`: HMAC-SHA256 of `msg_id.ts.body` with the raw secret.
pub fn sign_v1(secret: &[u8], msg_id: &str, ts: i64, body: &[u8]) -> String {
    format!("{V1},{}", b64(&hmac_sha256(secret, &content(None, msg_id, ts, body))))
}

/// A receiver's check (tests, the fake receivers): whether any `v2a` signature of the header verifies with `public`
/// for this endpoint id.
#[cfg_attr(not(test), allow(dead_code))]
pub fn verify_v2a(public: &[u8], endpoint_id: &str, msg_id: &str, ts: i64, body: &[u8], header: &str) -> bool {
    let digest = sha256(&content(Some(endpoint_id), msg_id, ts, body));
    let key = UnparsedPublicKey::new(&ED25519, public);
    header.split(' ').filter_map(|s| s.strip_prefix("v2a,")).filter_map(b64_strict).any(|sig| key.verify(&digest, &sig).is_ok())
}

/// A receiver's check: whether any `v1` signature of the header is the HMAC with `secret` (constant time).
#[cfg_attr(not(test), allow(dead_code))]
pub fn verify_v1(secret: &[u8], msg_id: &str, ts: i64, body: &[u8], header: &str) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    let c = content(None, msg_id, ts, body);
    header.split(' ').filter_map(|s| s.strip_prefix("v1,")).filter_map(b64_strict).any(|sig| hmac::verify(&key, &c, &sig).is_ok())
}

/// The v2a endpoint key of endpoint verification: the raw public key, `.`, the endpoint id.
pub fn v2a_endpoint_key(public: &[u8], endpoint_id: &str) -> Vec<u8> {
    let mut k = public.to_vec();
    k.push(b'.');
    k.extend_from_slice(endpoint_id.as_bytes());
    k
}

/// The extension's verification key: HMAC-SHA256(endpoint key, "wev-v1").
pub fn verification_key(endpoint_key: &[u8]) -> Vec<u8> {
    hmac_sha256(endpoint_key, WEV_LABEL)
}

/// `webhook-challenge-response`: `<scheme>,` and base64 of HMAC-SHA256(verification key, challenge as received).
pub fn challenge_response(scheme: &str, endpoint_key: &[u8], challenge: &str) -> String {
    format!("{scheme},{}", b64(&hmac_sha256(&verification_key(endpoint_key), challenge.as_bytes())))
}

/// The extension's check: a 2xx whose header is exactly one of the expected values (compared in constant time; a
/// list or an unknown identifier fails).
pub fn challenge_ok(answer: &HookAnswer, expected: &[String]) -> bool {
    (200..300).contains(&answer.status)
        && answer.challenge_response.as_deref().is_some_and(|h| expected.iter().any(|e| constant_time::verify_slices_are_equal(h.as_bytes(), e.as_bytes()).is_ok()))
}

/// The 32 bytes of a `whpk_` public key.
pub fn parse_whpk(s: &str) -> Option<[u8; 32]> {
    b64_strict(s.strip_prefix(WHPK)?)?.try_into().ok()
}

/// The raw bytes of a `whsec_` secret (24 to 64 bytes).
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_whsec(s: &str) -> Option<Vec<u8>> {
    b64_strict(s.strip_prefix(WHSEC)?).filter(|b| (24..=64).contains(&b.len()))
}

// ── what signs ────────────────────────────────────────────────────────────────────────────────────────────────────

/// What may sign and verify one destination's webhooks now: the live v2a keys held by this console (latest `nbf`
/// first), the public keys of every live listed key (endpoint verification), and the destination's v1 secrets
/// (newest first).
#[derive(Clone, Debug, Default)]
pub struct Material {
    pub keys: Vec<Arc<SignKey>>,
    pub publics: Vec<[u8; 32]>,
    pub secrets: Vec<Vec<u8>>,
}

impl Material {
    /// `webhook-signature` for one request: every v2a key, or every v1 secret. Err when none can sign.
    pub fn signature(&self, signing: &str, endpoint_id: &str, msg_id: &str, ts: i64, body: &[u8]) -> Result<String, &'static str> {
        let sigs: Vec<String> = match signing {
            V1 => self.secrets.iter().map(|s| sign_v1(s, msg_id, ts, body)).collect(),
            V2A => self.keys.iter().map(|k| sign_v2a(k, endpoint_id, msg_id, ts, body)).collect(),
            _ => return Err("The webhook names no signing scheme this console knows."),
        };
        if sigs.is_empty() {
            return Err(match signing {
                V1 => "The webhook's v1 secret is not stored yet. Make one first.",
                _ if !v2a_open() => "Ed25519 signing waits for release gate G-WEBHOOK-ED25519-FIPS in this FIPS build.",
                _ => "No webhook key listed in the organization's api map is live, undropped and held by this console.",
            });
        }
        Ok(sigs.join(" "))
    }

    /// Every `webhook-challenge-response` a correct endpoint may answer.
    pub fn responses(&self, signing: &str, endpoint_id: &str, challenge: &str) -> Vec<String> {
        match signing {
            V1 => self.secrets.iter().map(|s| challenge_response(V1, s, challenge)).collect(),
            V2A => self.publics.iter().map(|p| challenge_response(V2A, &v2a_endpoint_key(p, endpoint_id), challenge)).collect(),
            _ => Vec::new(),
        }
    }
}

/// 19.3: whether this build may sign v2a (always, outside FIPS builds).
pub fn v2a_open() -> bool {
    !cfg!(feature = "fips") || crate::meet_org_policy::RELAY_GATES.contains(&FIPS_GATE)
}

/// The sealed name of an org's webhook key (its seed).
pub fn key_seal_name(org: &str, kid: &str) -> String {
    format!("api-webhook-{org}-{kid}")
}

/// The keys of a `webhook_keys` list live at `now` and not dropped, the latest `nbf` first.
fn live_keys<'a>(list: &'a Value, active: &[ConsoleEntry], now: i64) -> Vec<&'a Value> {
    let int = |k: &Value, f: &str| k.get(f).and_then(Value::as_i64);
    let mut live: Vec<&Value> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter(|k| int(k, "nbf").is_some_and(|n| n <= now) && int(k, "exp").is_some_and(|e| now < e) && !key_dropped(active, DROP, text(k, "kid")))
        .collect();
    live.sort_by_key(|k| std::cmp::Reverse(int(k, "nbf")));
    live
}

/// The sealed key of a listed entry when its public part is the listed one.
fn sealed_key(vault: &dyn VaultLock, org: &str, listed: &Value) -> Option<SignKey> {
    let kid = text(listed, "kid");
    let seed = vault_do(vault, |v| v.get(&key_seal_name(org, kid)))?;
    let key = SignKey::from_seed(kid, &seed)?;
    (Some(key.public) == parse_whpk(text(listed, "public"))).then_some(key)
}

/// The material of one destination from a `webhook_keys` list (the pinned map's for delivery, a draft's for a
/// verification or test of a staged webhook).
pub fn material(vault: &dyn VaultLock, org: &str, id: &str, list: &Value, active: &[ConsoleEntry], now: i64) -> Material {
    let live = live_keys(list, active, now);
    let publics = live.iter().filter_map(|k| parse_whpk(text(k, "public"))).collect();
    let keys = if v2a_open() { live.iter().filter_map(|k| sealed_key(vault, org, k)).map(Arc::new).collect() } else { Vec::new() };
    Material { keys, publics, secrets: secrets(vault, org, id, now) }
}

/// The console's material for a destination: the pinned map's `webhook_keys`, or `staged` (a draft's list).
pub fn console_material(api: &ConsoleApi, org: &str, id: &str, staged: Option<&Value>, now: i64) -> Material {
    let list = staged.cloned().or_else(|| api.pinned(org).0.and_then(|m| m.get("webhook_keys").cloned())).unwrap_or_else(|| json!([]));
    material(&*api.vault(), org, id, &list, &api.console_active(org), now)
}

/// 7.3 `GET I/v1/webhooks/keys`: `{"keys": [{kid, public, nbf, exp}]}` of a `webhook_keys` list, dropped keys left
/// out (2.4, Rev4Review R4-18).
pub fn published(list: Option<&Value>, active: &[ConsoleEntry]) -> Value {
    let keys: Vec<Value> = list
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|k| !key_dropped(active, DROP, text(k, "kid")))
        .map(|k| json!({"kid": k.get("kid"), "public": k.get("public"), "nbf": k.get("nbf"), "exp": k.get("exp")}))
        .collect();
    json!({ "keys": keys })
}

// ── v1 secrets ────────────────────────────────────────────────────────────────────────────────────────────────────

/// 2.2: the sealed name of a destination's `v1` secret.
pub fn secret_seal_name(org: &str, id: &str) -> String {
    format!("secret:{org}:{id}:whsec")
}

/// The sealed secrets of a destination, newest first: (bytes, made at).
fn read_secrets(vault: &dyn VaultLock, org: &str, id: &str) -> Vec<(Vec<u8>, i64)> {
    let Some(raw) = vault_do(vault, |v| v.get(&secret_seal_name(org, id))) else { return Vec::new() };
    let v: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    v.get("secrets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| Some((b64_strict(s.get("secret")?.as_str()?)?, s.get("made")?.as_i64()?)))
        .collect()
}

/// 7.4: draw a new `v1` secret for a destination and seal it with the one it replaces (which keeps signing for
/// `SECRET_OVERLAP_S`); Ok is `whsec_<base64>`, shown once and never logged.
pub fn new_secret(vault: &dyn VaultLock, org: &str, id: &str, now: i64) -> Result<String, String> {
    let fresh = random(SECRET_BYTES)?;
    let mut list = read_secrets(vault, org, id);
    list.truncate(1);
    list.insert(0, (fresh.clone(), now));
    let sealed = json!({"secrets": list.iter().map(|(s, at)| json!({"secret": b64(s), "made": at})).collect::<Vec<_>>()});
    vault_do(vault, |v| v.put(&secret_seal_name(org, id), sealed.to_string().as_bytes()))?;
    Ok(format!("{WHSEC}{}", b64(&fresh)))
}

/// The secrets that sign at `now`: the newest, and the previous one within `SECRET_OVERLAP_S` of the rotation.
pub fn secrets(vault: &dyn VaultLock, org: &str, id: &str, now: i64) -> Vec<Vec<u8>> {
    let list = read_secrets(vault, org, id);
    let made = list.first().map_or(0, |(_, at)| *at);
    list.into_iter().enumerate().filter(|(i, _)| *i == 0 || now < made + SECRET_OVERLAP_S).map(|(_, (s, _))| s).collect()
}

/// 7.4: the "rotate by" date of a destination's newest `v1` secret.
pub fn secret_rotate_by(vault: &dyn VaultLock, org: &str, id: &str) -> Option<i64> {
    read_secrets(vault, org, id).first().map(|(_, at)| at + ROTATE_DAYS * DAY)
}

/// A deleted destination's `v1` secret goes with it.
pub fn delete_secret(vault: &dyn VaultLock, org: &str, id: &str) -> Result<(), String> {
    if vault_do(vault, |v| v.get(&secret_seal_name(org, id))).is_none() {
        return Ok(());
    }
    vault_do(vault, |v| v.remove(&secret_seal_name(org, id)))
}

// ── requests ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// `Lucid/<version>`.
pub fn user_agent() -> String {
    format!("Lucid/{}", env!("CARGO_PKG_VERSION"))
}

/// The headers of one signed request (7.4): content type, user agent, `webhook-id`, `webhook-timestamp`,
/// `webhook-signature`. The receiver credential is the endpoint's (`api_export_wire::hook_post`).
pub fn signed_headers(signing: &str, endpoint_id: &str, msg_id: &str, ts: i64, body: &[u8], m: &Material, content_type: &str) -> Result<Vec<(String, String)>, &'static str> {
    let sig = m.signature(signing, endpoint_id, msg_id, ts, body)?;
    Ok(vec![
        ("Content-Type".into(), content_type.into()),
        ("User-Agent".into(), user_agent()),
        ("webhook-id".into(), msg_id.into()),
        ("webhook-timestamp".into(), ts.to_string()),
        ("webhook-signature".into(), sig),
    ])
}

/// One endpoint verification request and the answers that pass it.
pub struct Challenge {
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub expected: Vec<String>,
}

/// 7.4 `verification: wev`: a dedicated signed `POST` (never an event delivery) with a fresh `webhook-challenge`.
pub fn challenge(signing: &str, endpoint_id: &str, m: &Material, now: i64) -> Result<Challenge, String> {
    let challenge = b64(&random(32)?);
    let msg_id = format!("v_{}", hex(&random(16)?));
    let body = json!({"type": "webhook.verification", "destination": endpoint_id}).to_string().into_bytes();
    let mut headers = signed_headers(signing, endpoint_id, &msg_id, now, &body, m, "application/json").map_err(str::to_owned)?;
    headers.push(("webhook-challenge".into(), challenge.clone()));
    let expected = m.responses(signing, endpoint_id, &challenge);
    if expected.is_empty() {
        return Err("No key or secret can check this endpoint's answer.".into());
    }
    Ok(Challenge { headers, body, expected })
}

/// What one delivery attempt came to (7.4 outcomes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 2xx.
    Delivered,
    /// 410: the destination is suspended (journaled `destination_suspend`) and `webhook.gone` audited.
    Gone,
    /// Anything else: tried again after `after_s` (429, 502, 503, 504 with `Retry-After`, at most 300 s) or the
    /// backoff of revision 3 11.6. 3xx is a failure (never followed).
    Retry { after_s: Option<i64>, code: &'static str, why: String },
}

/// The outcome of one attempt.
pub fn outcome(r: &Result<HookAnswer, SinkError>) -> Outcome {
    match r {
        Ok(a) if (200..300).contains(&a.status) => Outcome::Delivered,
        Ok(a) if a.status == 410 => Outcome::Gone,
        Ok(a) => {
            let after_s = matches!(a.status, 429 | 502 | 503 | 504).then_some(a.retry_after).flatten().map(|s| s.min(RETRY_AFTER_MAX));
            let why = match a.status {
                300..=399 => format!("The webhook endpoint answered {} (redirects are not followed).", a.status),
                s => format!("The webhook endpoint answered {s}."),
            };
            Outcome::Retry { after_s, code: if (300..400).contains(&a.status) { "redirect" } else { "status" }, why }
        }
        Err(e) => Outcome::Retry { after_s: None, code: e.code, why: format!("The webhook request failed: {}.", e.message.trim_end_matches('.')) },
    }
}

// ── the selection of 7.4 ──────────────────────────────────────────────────────────────────────────────────────────

/// What an events destination's named client may read of the feed now.
#[derive(Clone)]
pub struct EventView {
    /// Its effective scopes.
    pub scopes: Vec<String>,
    /// Its effective ceiling (the engine lowers it to the destination's).
    pub ceiling: Ceiling,
    /// Whether it reaches a source (`console`, or a relay id).
    pub reaches: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl std::fmt::Debug for EventView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "EventView({:?}, {:?})", self.scopes, self.ceiling)
    }
}

/// 7.4 selection: the client `client` of the org's pinned map as a token's grant would be now (revision 3 5.4: the
/// map unexpired, the API not off, the client active, unsuspended, inside its registration with the `app` grace, its
/// owner active; scopes less journaled drops, ceiling lowered by the journal, relays as `client_drop_relay` and
/// `client_limit` leave them). None when it may read no events now.
pub fn client_view(store: &ApiMapStore, org: &str, client: &str, now: i64, owner_active: &dyn Fn(&str) -> bool) -> Option<EventView> {
    store.get(org, "").filter(|m| m.expires > now)?;
    if store.is_off(org) {
        return None;
    }
    let active = store.active(org);
    let c = find_client(store, org, client)?;
    if c.get("state").and_then(Value::as_str) != Some("active") || active.iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(client)) {
        return None;
    }
    let end = c.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN);
    if now > effective_end(end, &[store.grace_hours(org, "app", now)]) || !owner_active(c.get("owner").and_then(Value::as_str).unwrap_or_default()) {
        return None;
    }
    let dropped: Vec<&str> = client_entries(active, "client_drop_scope", client).map(|e| target_field(e, "scope")).collect();
    let scopes: Vec<String> = names(c, "scopes").filter(|s| !dropped.contains(s)).map(str::to_owned).collect();
    if !scopes.iter().any(|s| s == "events.subscribe") {
        return None;
    }
    let own = c.get("ceiling").and_then(Value::as_str).and_then(rank).unwrap_or(0);
    let r = client_entries(active, "client_lower_ceiling", client).filter_map(|e| rank(target_field(e, "ceiling"))).fold(own, usize::min);
    let ceiling = Ceiling::of(CEILINGS[r])?;
    let (obj, act, id) = (c.clone(), active.to_vec(), client.to_owned());
    Some(EventView { scopes, ceiling, reaches: Arc::new(move |relay: &str| relay_reachable(&obj, &act, &id, relay)) })
}

/// One page of the console's feed for a destination: at most `limit` events the view may see in `repr`, of `types`
/// (all when None), after `after` (from the oldest kept when None); no stubs, no waiting. Ok is the feed answer
/// (`events`, `next`).
pub fn page(events: &EventLog, org: &str, after: Option<&str>, limit: usize, view: &EventView, repr: Repr, types: Option<Vec<String>>) -> Result<Value, FeedError> {
    let reaches = |r: &str| (view.reaches)(r);
    let viewer = Viewer { scopes: &view.scopes, reaches: &reaches, ceiling: view.ceiling, repr, types };
    events.page(org, &FeedQuery { after: after.map(str::to_owned), limit, wait: 0, types: None, stubs: false }, &viewer)
}

/// The feed cursor after the org's newest event (where a new events destination starts): paged through with stubs.
pub fn tail(events: &EventLog, org: &str) -> Option<String> {
    let nothing = |_: &str| false;
    let viewer = Viewer { scopes: &[], reaches: &nothing, ceiling: Ceiling::Public, repr: Repr::Removed, types: None };
    let mut after: Option<String> = None;
    // 35 days of a busy org at 1000 rows a page
    for _ in 0..100_000 {
        let q = FeedQuery { after: after.clone(), limit: crate::api_events::LIMIT_MAX, wait: 0, types: None, stubs: true };
        let p = events.page(org, &q, &viewer).ok()?;
        after = p.get("next").and_then(Value::as_str).map(str::to_owned);
        if p.get("events").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            break;
        }
    }
    after
}

/// 13.2 "Send a test": the CloudEvent of the console event `seq` (a `test.ping` just emitted) in `repr`.
pub fn ping_event(events: &EventLog, org: &str, seq: u64, repr: Repr) -> Option<Value> {
    let e = events.chains().range(org, "console", repr, seq.checked_sub(1)?, 1).into_iter().next()?;
    (e.get("seq").and_then(Value::as_u64) == Some(seq)).then_some(())?;
    crate::api_events::cloud_event(org, "console", repr, e.as_object()?)
}

// ── staging and the console journal (13.1, 2.4) ──────────────────────────────────────────────────────────────────

fn invalid(words: impl Into<String>) -> ApiError {
    ApiError::with("invalid", words)
}

fn find_dest<'a>(map: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    map.get_mut("destinations")?.as_array_mut()?.iter_mut().find(|d| text(d, "id") == id)
}

/// `POST settings/api/webhook-keys {org}`: a new Ed25519 key drawn and sealed now, its public part staged in the
/// draft's `webhook_keys` (`nbf` now, `exp` a year on; expired keys leave the draft first, a third is refused). Both
/// keys sign while both are live, so receivers trusting either verify. Ok is the staged entry.
pub fn stage_new_key(d: &mut Draft, vault: &dyn VaultLock, org: &str, now: i64) -> Result<Value, ApiError> {
    let int = |k: &Value, f: &str| k.get(f).and_then(Value::as_i64).unwrap_or(0);
    if !d.map.get("webhook_keys").is_some_and(Value::is_array) {
        d.map["webhook_keys"] = json!([]);
    }
    let keys = d.map["webhook_keys"].as_array_mut().ok_or_else(|| ApiError::of("invalid"))?;
    keys.retain(|k| int(k, "exp") > now);
    if keys.len() >= KEYS_MAX {
        return Err(invalid("An organization has at most two webhook keys. Drop one first."));
    }
    let failed = |e: String| ApiError::with("write-failed", e);
    let kid = format!("wk-{}", b64u(&random(6).map_err(failed)?));
    let seed = random(32).map_err(failed)?;
    let key = SignKey::from_seed(&kid, &seed).ok_or_else(|| ApiError::with("write-failed", "A webhook key could not be drawn."))?;
    vault_do(vault, |v| v.put(&key_seal_name(org, &kid), &seed)).map_err(|e| ApiError::with("seal-provider-needed", e))?;
    let entry = json!({"kid": kid, "public": key.whpk(), "nbf": now, "exp": now + KEY_DAYS * DAY});
    keys.push(entry.clone());
    d.changes.push(format!("Add webhook key {kid}"));
    Ok(entry)
}

/// `POST settings/exports/destinations/secret {org, id}` for a webhook not yet signed `v1`: a new secret drawn and
/// sealed now, and the draft's destination set to `signing: v1` (a two-person save, 13.3; it needs a verification and
/// a passing test again). Ok is `whsec_...`, shown once.
pub fn stage_secret(d: &mut Draft, vault: &dyn VaultLock, org: &str, id: &str, now: i64) -> Result<String, ApiError> {
    let x = find_dest(&mut d.map, id).ok_or_else(|| ApiError::with("not-found", crate::console_api_ui::NO_DESTINATION))?;
    if text(x, "kind") != "webhook" {
        return Err(invalid("Only a webhook destination has a v1 secret."));
    }
    let name = text(x, "name").to_owned();
    let changed = x.pointer("/settings/signing").and_then(Value::as_str) != Some(V1);
    let secret = new_secret(vault, org, id, now).map_err(|e| ApiError::with("seal-provider-needed", e))?;
    if changed {
        x["settings"]["signing"] = json!(V1);
        d.changes.push(format!("Sign webhook {name} with v1"));
        d.untested.insert(id.to_owned());
    }
    Ok(secret)
}

/// `POST settings/api/webhook-keys/drop {org, kid}` (2.4): `webhook_key_drop` in the console journal at once (flushed
/// before Ok: the console stops signing with the key and `I/v1/webhooks/keys` omits it), and the key leaves the org's
/// draft when one is staged. Ok is the journal entry (null for a key only staged, never pinned) and whether the draft
/// changed.
pub fn drop_key(api: &ConsoleApi, draft: Option<&mut Draft>, org: &str, kid: &str, now: i64) -> Result<(Value, bool), ApiError> {
    let (pinned, _, _) = api.pinned(org);
    let listed = |m: &Value| m.get("webhook_keys").and_then(Value::as_array).is_some_and(|ks| ks.iter().any(|k| text(k, "kid") == kid));
    let in_draft = draft.as_ref().is_some_and(|d| listed(&d.map));
    let pinned_has = pinned.as_ref().is_some_and(listed);
    if !pinned_has && !in_draft {
        return Err(ApiError::with("not-found", "That webhook key is not in the organization's api map."));
    }
    if key_dropped(&api.console_active(org), DROP, kid) {
        return Err(ApiError::with("stale", "Nothing was changed: that webhook key is already dropped."));
    }
    let entry = if pinned_has { api.append_console(org, DROP, json!({ "kid": kid }), now).map_err(|e| ApiError::with("write-failed", e.message))? } else { Value::Null };
    let mut changed = false;
    if let Some(d) = draft.filter(|_| in_draft) {
        if let Some(keys) = d.map.get_mut("webhook_keys").and_then(Value::as_array_mut) {
            keys.retain(|k| text(k, "kid") != kid);
            d.changes.push(format!("Drop webhook key {kid}"));
            changed = true;
        }
    }
    Ok((entry, changed))
}

/// The attention item `webhook-key-dropped` (2.4): (org, kid) of every active `webhook_key_drop`, until a saved map
/// no longer lists the key (the entry then folds).
pub fn dropped_attention(api: &ConsoleApi) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for org in api.known_orgs() {
        for e in api.console_active(&org).iter().filter(|e| e.action == DROP) {
            out.push((org.clone(), e.field("kid").to_owned()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_ca::MemVault;

    // Standard Webhooks 1.0.0, spec/standard-webhooks.md (asymmetric example) and the reference library's tests
    // (libraries/python/tests/test_webhooks.py: the symmetric known-answer vector), read 2026-11-23.
    const SPEC_SK: &str = "4uKPjji/dhB8w6GW3YYDnIMYvXcdHrvH6lidTr4Z+EY=";
    const SPEC_PK: &str = "whpk_uWKK13PfwqyOgrqT0OrWKcS2uVD7e89+oUKnkoPjx7w=";
    const SPEC_ENDPOINT: &str = "ep_2fVZdC8Kx9TR4ZoCqHWt3NnLgRb";
    const SPEC_MSG: &str = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
    const SPEC_TS: i64 = 1674087231;
    const SPEC_PAYLOAD: &str = r#"{"type":"contact.created","timestamp":"2022-11-03T20:26:10.344522Z","data":{"id":"1f81eb52-5198-4599-803e-771906343485"}}"#;
    const SPEC_DIGEST: &str = "YXCi5iN+rjB+iEb6bvg1XbWbVBL+r2S+as3k3n1Ih/A=";
    const SPEC_V2A: &str = "v2a,kG9XaxZjAEpKB8KeQQb5G1Xp73YH5Rf5gxoWe7cg1kYMiyspdtZXe9w+dAwKeOurAwxfqmlOG/QR4m9s37DzAg==";
    const LIB_SECRET: &str = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const LIB_MSG: &str = "msg_p5jXN8AQM9LWM0D4loKWxJek";
    const LIB_TS: i64 = 1614265330;
    const LIB_PAYLOAD: &str = r#"{"test": 2432232314}"#;
    const LIB_V1: &str = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
    // spec/extensions/endpoint-verification.md, Examples
    const WEV_CHALLENGE: &str = "0njH7N3kV5eXPB+/eh+eoA2Ahvz2JgNp0iC/BLOl6yM=";
    const WEV_V1_KEY: &str = "w0AwXgXeZ+n5Kvmq/fCsdKc0JgeFSZVI7D05gJOAyTY=";
    const WEV_V1: &str = "v1,2WoO4Z1kjgoudcvk4PX/8LDD6FNJDEUHMtYqZpNx/FA=";
    const WEV_V2A_KEY: &str = "YYCPt0lD/zon3FFk7MHznJHji3Td5EEGcithf+hw924=";
    const WEV_V2A: &str = "v2a,t0RDFhzk7OtVzgvMsjuXnodSWuby2BVX+zPqw2/ksUk=";

    fn spec_key() -> SignKey {
        SignKey::from_seed("spec", &b64_strict(SPEC_SK).unwrap()).unwrap()
    }

    #[test]
    fn v2a_matches_the_specification_example() {
        let key = spec_key();
        assert_eq!(key.whpk(), SPEC_PK, "the example's key pair");
        let body = SPEC_PAYLOAD.as_bytes();
        assert_eq!(b64(&sha256(&content(Some(SPEC_ENDPOINT), SPEC_MSG, SPEC_TS, body))), SPEC_DIGEST);
        // Ed25519 is deterministic: the signature is the published one byte for byte
        assert_eq!(sign_v2a(&key, SPEC_ENDPOINT, SPEC_MSG, SPEC_TS, body), SPEC_V2A);
        let public = parse_whpk(SPEC_PK).unwrap();
        assert!(verify_v2a(&public, SPEC_ENDPOINT, SPEC_MSG, SPEC_TS, body, SPEC_V2A));
        // a webhook signed for another endpoint fails there, and so does any change
        assert!(!verify_v2a(&public, "ep_other", SPEC_MSG, SPEC_TS, body, SPEC_V2A));
        assert!(!verify_v2a(&public, SPEC_ENDPOINT, SPEC_MSG, SPEC_TS + 1, body, SPEC_V2A));
        assert!(!verify_v2a(&public, SPEC_ENDPOINT, SPEC_MSG, SPEC_TS, b"{}", SPEC_V2A));
        // a list with junk and a v1 entry still verifies through its v2a signature
        assert!(verify_v2a(&public, SPEC_ENDPOINT, SPEC_MSG, SPEC_TS, body, &format!("v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4= v1a,abc v2a,!!invalid {SPEC_V2A}")));
    }

    /// 19.3 G-WEBHOOK-ED25519-FIPS: run in the FIPS build (`--features fips`) once Ed25519 is confirmed in its validated
    /// module; the gate is recorded in docs/api/release-gates.json and listed in `RELAY_GATES` only after this passes.
    #[test]
    #[ignore = "live gate G-WEBHOOK-ED25519-FIPS"]
    fn ed25519_in_the_fips_build_signs_the_specification_example() {
        assert!(cfg!(feature = "fips"), "run in the FIPS build");
        let key = spec_key();
        assert_eq!(sign_v2a(&key, SPEC_ENDPOINT, SPEC_MSG, SPEC_TS, SPEC_PAYLOAD.as_bytes()), SPEC_V2A);
        assert!(verify_v2a(&key.public, SPEC_ENDPOINT, SPEC_MSG, SPEC_TS, SPEC_PAYLOAD.as_bytes(), SPEC_V2A));
    }

    #[test]
    fn v1_matches_the_reference_vector() {
        let secret = parse_whsec(LIB_SECRET).unwrap();
        assert_eq!(secret.len(), 24);
        assert_eq!(sign_v1(&secret, LIB_MSG, LIB_TS, LIB_PAYLOAD.as_bytes()), LIB_V1);
        assert!(verify_v1(&secret, LIB_MSG, LIB_TS, LIB_PAYLOAD.as_bytes(), LIB_V1));
        assert!(verify_v1(&secret, LIB_MSG, LIB_TS, LIB_PAYLOAD.as_bytes(), &format!("v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc= v2,abc {LIB_V1}")));
        assert!(!verify_v1(&secret, LIB_MSG, LIB_TS, LIB_PAYLOAD.as_bytes(), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OA="));
        assert!(!verify_v1(&secret, LIB_MSG, LIB_TS, LIB_PAYLOAD.as_bytes(), &LIB_V1.replace("v1,", "v2,")), "an unknown identifier");
        assert!(parse_whsec("whsec_AAAA").is_none(), "under 24 bytes");
        assert!(parse_whsec(&format!("{WHSEC}{}", b64(&[0u8; 65]))).is_none(), "over 64 bytes");
        assert_eq!(parse_whsec(&format!("{WHSEC}{}", b64(&[1u8; 32]))).map(|s| s.len()), Some(32));
    }

    #[test]
    fn endpoint_verification_matches_the_extension_examples() {
        let secret = parse_whsec(LIB_SECRET).unwrap();
        assert_eq!(b64(&verification_key(&secret)), WEV_V1_KEY);
        assert_eq!(challenge_response(V1, &secret, WEV_CHALLENGE), WEV_V1);
        let ek = v2a_endpoint_key(&parse_whpk(SPEC_PK).unwrap(), SPEC_ENDPOINT);
        assert_eq!(b64(&verification_key(&ek)), WEV_V2A_KEY);
        assert_eq!(challenge_response(V2A, &ek, WEV_CHALLENGE), WEV_V2A);
        let ok = |status: u16, h: &str| challenge_ok(&HookAnswer { status, retry_after: None, challenge_response: Some(h.to_owned()) }, &[WEV_V2A.to_owned()]);
        assert!(ok(204, WEV_V2A));
        assert!(!ok(500, WEV_V2A), "a 2xx only");
        assert!(!ok(200, &format!("v2,abc {WEV_V2A}")), "a list is a failure");
        assert!(!ok(200, &WEV_V2A.replace("v2a,", "v1,")));
        assert!(!challenge_ok(&HookAnswer { status: 200, retry_after: None, challenge_response: None }, &[WEV_V2A.to_owned()]));
        // the material answers for every live key, so a receiver on either key of a rotation passes
        let m = Material { keys: vec![], publics: vec![[7u8; 32], parse_whpk(SPEC_PK).unwrap()], secrets: vec![] };
        assert!(m.responses(V2A, SPEC_ENDPOINT, WEV_CHALLENGE).contains(&WEV_V2A.to_owned()));
    }

    #[test]
    fn webhook_ids_are_stable_and_dot_free() {
        let a = webhook_id("lucid-api-events-as-is-v1:acme/console:5521");
        assert_eq!(a, webhook_id("lucid-api-events-as-is-v1:acme/console:5521"));
        assert_eq!(a.len(), 34);
        assert!(a.starts_with("e_") && !a.contains('.'));
        assert_ne!(a, webhook_id("lucid-api-events-pseudo-v1:acme/console:5521"), "each representation has its own id");
    }

    #[test]
    fn rotation_signs_with_every_live_key_and_both_secrets() {
        let k1 = Arc::new(spec_key());
        let k2 = Arc::new(SignKey::from_seed("wk-2", &[7u8; 32]).unwrap());
        let m = Material { keys: vec![k2.clone(), k1.clone()], publics: vec![k2.public, k1.public], secrets: vec![vec![1u8; 32], vec![2u8; 32]] };
        let body = br#"{"specversion":"1.0"}"#;
        let h = m.signature(V2A, "d_1", "e_1", 5, body).unwrap();
        assert_eq!(h.split(' ').count(), 2);
        assert!(verify_v2a(&k1.public, "d_1", "e_1", 5, body, &h) && verify_v2a(&k2.public, "d_1", "e_1", 5, body, &h));
        let h = m.signature(V1, "d_1", "e_1", 5, body).unwrap();
        assert!(verify_v1(&[1u8; 32], "e_1", 5, body, &h) && verify_v1(&[2u8; 32], "e_1", 5, body, &h));
        assert!(Material::default().signature(V1, "d_1", "e_1", 5, body).is_err());
        assert!(Material::default().signature(V2A, "d_1", "e_1", 5, body).is_err());
    }

    #[test]
    fn secrets_rotate_with_overlap_and_a_reminder() {
        let vault = parking_lot::Mutex::new(MemVault::default());
        let t = 1_795_000_000;
        assert!(secrets(&vault, "acme", "d_1", t).is_empty());
        let s1 = parse_whsec(&new_secret(&vault, "acme", "d_1", t).unwrap()).unwrap();
        assert_eq!(s1.len(), SECRET_BYTES);
        assert_eq!(secrets(&vault, "acme", "d_1", t), vec![s1.clone()]);
        assert_eq!(secret_rotate_by(&vault, "acme", "d_1"), Some(t + 90 * DAY));
        let s2 = parse_whsec(&new_secret(&vault, "acme", "d_1", t + 100).unwrap()).unwrap();
        assert_eq!(secrets(&vault, "acme", "d_1", t + 200), vec![s2.clone(), s1], "both sign during the overlap");
        assert_eq!(secrets(&vault, "acme", "d_1", t + 100 + SECRET_OVERLAP_S), vec![s2.clone()], "then only the new one");
        let s3 = parse_whsec(&new_secret(&vault, "acme", "d_1", t + 300).unwrap()).unwrap();
        assert_eq!(secrets(&vault, "acme", "d_1", t + 400), vec![s3, s2], "never more than two");
        assert!(secrets(&vault, "acme", "d_2", t).is_empty(), "per destination");
        delete_secret(&vault, "acme", "d_1").unwrap();
        assert!(secrets(&vault, "acme", "d_1", t).is_empty());
    }

    #[test]
    fn keys_sign_only_listed_live_undropped_and_held() {
        let vault = parking_lot::Mutex::new(MemVault::default());
        let t = 1_795_000_000;
        let key = spec_key();
        vault_do(&vault, |v| v.put(&key_seal_name("acme", "wk-1"), &b64_strict(SPEC_SK).unwrap())).unwrap();
        let list = json!([{"kid": "wk-1", "public": SPEC_PK, "nbf": t - 10, "exp": t + 10},
                          {"kid": "wk-2", "public": format!("{WHPK}{}", b64(&[9u8; 32])), "nbf": t - 5, "exp": t + 10}]);
        let m = material(&vault, "acme", "d_1", &list, &[], t);
        assert_eq!(m.keys.iter().map(|k| k.kid.as_str()).collect::<Vec<_>>(), vec!["wk-1"], "wk-2 is not held here");
        assert_eq!(m.keys[0].public, key.public);
        assert_eq!(m.publics.len(), 2, "both verify an endpoint");
        assert!(material(&vault, "acme", "d_1", &list, &[], t + 10).keys.is_empty(), "past exp");
        // a sealed seed whose public part is not the listed one never signs
        let swapped = json!([{"kid": "wk-1", "public": format!("{WHPK}{}", b64(&[9u8; 32])), "nbf": t - 10, "exp": t + 10}]);
        assert!(material(&vault, "acme", "d_1", &swapped, &[], t).keys.is_empty());
        let drop = ConsoleEntry::parse(&json!({"id": "k_acme_000001", "cseq": 1, "ts": t, "action": "webhook_key_drop", "target": {"kid": "wk-1"}, "reach": "console"})).unwrap();
        let m = material(&vault, "acme", "d_1", &list, std::slice::from_ref(&drop), t);
        assert!(m.keys.is_empty() && m.publics.len() == 1, "a dropped key neither signs nor verifies");
        let p = published(Some(&list), &[drop]);
        assert_eq!(p["keys"].as_array().unwrap().len(), 1, "and leaves the published set at once (R4-18)");
        assert_eq!(p["keys"][0], json!({"kid": "wk-2", "public": list[1]["public"], "nbf": t - 5, "exp": t + 10}));
    }

    #[test]
    fn outcomes_follow_section_7_4() {
        let a = |status: u16, ra: Option<i64>| outcome(&Ok(HookAnswer { status, retry_after: ra, challenge_response: None }));
        assert_eq!(a(200, None), Outcome::Delivered);
        assert_eq!(a(204, None), Outcome::Delivered);
        assert_eq!(a(410, None), Outcome::Gone);
        for s in [429, 502, 503, 504] {
            assert!(matches!(a(s, Some(12)), Outcome::Retry { after_s: Some(12), .. }), "{s}");
            assert!(matches!(a(s, Some(9000)), Outcome::Retry { after_s: Some(300), .. }), "{s}: at most 300 s");
        }
        assert!(matches!(a(500, Some(12)), Outcome::Retry { after_s: None, code: "status", .. }), "other statuses back off");
        assert!(matches!(a(301, None), Outcome::Retry { after_s: None, code: "redirect", .. }));
        assert!(matches!(a(404, None), Outcome::Retry { after_s: None, .. }));
        let e = outcome(&Err(SinkError { retryable: true, code: "timeout", message: "no answer within 30 seconds".into() }));
        assert!(matches!(e, Outcome::Retry { after_s: None, code: "timeout", .. }));
    }

    #[test]
    fn staged_keys_and_secrets() {
        let vault = parking_lot::Mutex::new(MemVault::default());
        let t = 1_795_000_000;
        let ctx = crate::console_api_ui::Ctx { org: "acme", by: "ann@acme.example", pinned: None, pinned_seq: 0 };
        let mut d = Draft::new(&ctx, "st_1".into(), t * 1000);
        let k1 = stage_new_key(&mut d, &vault, "acme", t).unwrap();
        let k2 = stage_new_key(&mut d, &vault, "acme", t).unwrap();
        assert!(stage_new_key(&mut d, &vault, "acme", t).is_err(), "at most two");
        assert_eq!(d.map["webhook_keys"].as_array().unwrap().len(), 2);
        assert_eq!((k1["nbf"].as_i64(), k1["exp"].as_i64()), (Some(t), Some(t + KEY_DAYS * DAY)));
        let m = material(&vault, "acme", "d_1", &d.map["webhook_keys"], &[], t);
        assert_eq!(m.keys.len(), 2, "both drawn keys are sealed and sign");
        assert_ne!(k1["public"], k2["public"]);
        // a v1 secret moves the staged webhook to v1 (two-person) and needs a test again
        d.map["destinations"] = json!([{"id": "d_1", "name": "Hook", "kind": "webhook", "settings": {"client": "c_1", "types": [], "signing": "v2a", "verification": "wev"}},
                                       {"id": "d_2", "name": "HEC", "kind": "splunk_hec"}]);
        let s = stage_secret(&mut d, &vault, "acme", "d_1", t).unwrap();
        assert!(s.starts_with(WHSEC));
        assert_eq!(d.map["destinations"][0]["settings"]["signing"], "v1");
        assert!(d.untested.contains("d_1"));
        assert_eq!(secrets(&vault, "acme", "d_1", t), vec![parse_whsec(&s).unwrap()]);
        assert!(stage_secret(&mut d, &vault, "acme", "d_2", t).is_err(), "webhooks only");
        assert!(stage_secret(&mut d, &vault, "acme", "d_9", t).is_err());
    }
}

/// The export engine's events path (`api_export`) against a fake feed and fake receivers that check every signature
/// as a Standard Webhooks receiver would (their own endpoint id, the trusted public key).
#[cfg(test)]
mod engine_tests {
    use super::*;
    use crate::api_audit::Dropped;
    use crate::api_export::{ExportEngine, Host, MetricRow, OrgConfig};
    use crate::api_export_wire::{Batch, Credential, HookPost, Signal, Sink};
    use crate::api_map::{Edition, TightenEntry};
    use crate::log::Logger;
    use parking_lot::Mutex;
    use std::collections::{HashMap, VecDeque};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const ORG: &str = "acme";
    const D1: &str = "d_00000000000000a1";
    const D2: &str = "d_00000000000000b2";
    const CLIENT: &str = "c_0a1b2c3d4e5f6071";
    const NOW: i64 = 1_795_000_000;
    const T: i64 = NOW * 1000;

    fn tmp(name: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("lucid-api-webhook-{name}-{}-{}-{}", std::process::id(), crate::codec::now_ms(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn endpoint(id: &str) -> String {
        format!("https://hooks.acme.example/{id}")
    }

    fn hook(id: &str, extra: Value) -> Value {
        let mut d = json!({"id": id, "name": format!("hook {id}"), "kind": "webhook", "preset": "webhook", "signals": ["events"],
            "ceiling": "internal", "identities": "pseudonymized", "failover": false, "private_ok": false, "endpoint": endpoint(id),
            "settings": {"client": CLIENT, "types": [], "signing": "v2a", "verification": "wev"}, "credential": {"type": "none"},
            "queue": {"max_bytes": 1u64 << 30, "max_age_s": 3600}});
        for (k, v) in extra.as_object().into_iter().flatten() {
            d[k] = v.clone();
        }
        d
    }

    fn ce(n: u64, name: &str, data: Value) -> Value {
        json!({"specversion": "1.0", "id": format!("lucid-api-events-pseudo-v1:acme/console:{n}"), "source": "/api/orgs/acme/console",
               "type": format!("com.emertins.lucid.{name}"), "time": "2026-11-18T11:08:43Z", "datacontenttype": "application/json",
               "lucidorg": "acme", "lucidseq": n, "lucidchain": "lucid-api-events-pseudo-v1:acme/console", "lucidprev": "00", "lucidhash": "11",
               "data": data})
    }

    fn health(n: u64) -> Value {
        ce(n, "relay.health.changed", json!({"relay": "r_01", "from": "ok", "to": "bad"}))
    }

    fn answer(status: u16, retry_after: Option<i64>) -> HookAnswer {
        HookAnswer { status, retry_after, challenge_response: None }
    }

    /// A Standard Webhooks receiver: checks the signature with its own endpoint id and the trusted key, answers a
    /// challenge (correctly while `challenge` holds), and answers deliveries from a script (200 when it runs out).
    struct Receiver {
        public: [u8; 32],
        endpoint_id: String,
        got: Mutex<Vec<(Vec<(String, String)>, Vec<u8>)>>,
        answers: Mutex<VecDeque<HookAnswer>>,
        challenge: Mutex<bool>,
    }

    impl Receiver {
        /// The deliveries (not the challenges): lowercase headers and the CloudEvent.
        fn deliveries(&self) -> Vec<(HashMap<String, String>, Value)> {
            self.got
                .lock()
                .iter()
                .map(|(h, b)| (h.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect::<HashMap<_, _>>(), b))
                .filter(|(h, _)| !h.contains_key("webhook-challenge"))
                .map(|(h, b)| (h, serde_json::from_slice::<Value>(b).unwrap()))
                .collect()
        }

        fn seqs(&self) -> Vec<u64> {
            self.deliveries().iter().map(|(_, b)| b["lucidseq"].as_u64().unwrap()).collect()
        }
    }

    impl HookPost for Receiver {
        fn post(&self, headers: &[(String, String)], body: &[u8]) -> Result<HookAnswer, SinkError> {
            self.got.lock().push((headers.to_vec(), body.to_vec()));
            let h = |n: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.clone()).unwrap_or_default();
            let ts: i64 = h("webhook-timestamp").parse().unwrap();
            assert!(verify_v2a(&self.public, &self.endpoint_id, &h("webhook-id"), ts, body, &h("webhook-signature")), "every request verifies");
            if !h("webhook-challenge").is_empty() {
                let right = challenge_response(V2A, &v2a_endpoint_key(&self.public, &self.endpoint_id), &h("webhook-challenge"));
                let given = if *self.challenge.lock() { right } else { format!("{V2A},{}", b64(&[0u8; 32])) };
                return Ok(HookAnswer { status: 204, retry_after: None, challenge_response: Some(given) });
            }
            Ok(self.answers.lock().pop_front().unwrap_or_else(|| answer(200, None)))
        }
    }

    struct Rec(Arc<Mutex<Vec<Batch>>>);

    impl Sink for Rec {
        fn deliver(&self, batch: &Batch) -> Result<(), SinkError> {
            self.0.lock().push(batch.clone());
            Ok(())
        }
    }

    /// The console behind the engine: the map's destinations, a feed of (scope, CloudEvent) whose cursor `p<n>` is
    /// the position after `n` events, the client's effective scopes, and what the engine journals, audits and emits.
    struct Hub {
        dests: Mutex<Vec<Value>>,
        feed: Mutex<Vec<(String, Value)>>,
        base: Mutex<usize>,
        scopes: Mutex<Vec<String>>,
        audit: Mutex<Vec<Value>>,
        emitted: Mutex<Vec<(String, Value)>>,
        suspended: Mutex<Vec<String>>,
        /// The journal refuses `destination_suspend` (a full disk).
        refuse_journal: Mutex<bool>,
        dropped: Mutex<Vec<Dropped>>,
        receivers: Mutex<HashMap<String, Arc<Receiver>>>,
        key: Arc<SignKey>,
        sent: Arc<Mutex<Vec<Batch>>>,
    }

    impl Hub {
        fn new(dests: Vec<Value>) -> Arc<Hub> {
            Arc::new(Hub {
                dests: Mutex::new(dests),
                feed: Mutex::new(Vec::new()),
                base: Mutex::new(0),
                scopes: Mutex::new(vec!["events.subscribe".into(), "monitor.read".into()]),
                audit: Mutex::new(Vec::new()),
                emitted: Mutex::new(Vec::new()),
                suspended: Mutex::new(Vec::new()),
                refuse_journal: Mutex::new(false),
                dropped: Mutex::new(Vec::new()),
                receivers: Mutex::new(HashMap::new()),
                key: Arc::new(SignKey::from_seed("wk-1", &[5u8; 32]).unwrap()),
                sent: Arc::new(Mutex::new(Vec::new())),
            })
        }

        fn receiver(&self, id: &str) -> Arc<Receiver> {
            let r = Arc::new(Receiver { public: self.key.public, endpoint_id: id.into(), got: Mutex::new(Vec::new()), answers: Mutex::new(VecDeque::new()), challenge: Mutex::new(true) });
            self.receivers.lock().insert(endpoint(id), r.clone());
            r
        }

        fn push(&self, scope: &str, ce: Value) {
            self.feed.lock().push((scope.into(), ce));
        }

        fn audited(&self, action: &str) -> Vec<Value> {
            self.audit.lock().iter().filter(|e| e["action"] == action).cloned().collect()
        }

        fn emitted(&self, kind: &str) -> Vec<Value> {
            self.emitted.lock().iter().filter(|(k, _)| k == kind).map(|(_, d)| d.clone()).collect()
        }
    }

    impl Host for Hub {
        fn config(&self, _now: i64) -> (Option<Edition>, Vec<OrgConfig>) {
            let o = OrgConfig { org: ORG.into(), serving: true, expires: NOW + 30 * 86_400, destinations: self.dests.lock().clone(), active: Vec::<TightenEntry>::new() };
            (Some(Edition::Enterprise), vec![o])
        }
        fn credential(&self, _org: &str, _id: &str) -> Option<Credential> {
            Some(Credential::Token("hec-token".into()))
        }
        fn delete_credential(&self, _org: &str, _id: &str) {}
        fn pseudonym_key(&self, _org: &str) -> Option<(u32, Vec<u8>)> {
            None
        }
        fn audit_sources(&self, _org: &str) -> Vec<String> {
            Vec::new()
        }
        fn audit_read(&self, _org: &str, _source: &str, _repr: Repr, _after: u64, _limit: usize) -> Vec<Value> {
            Vec::new()
        }
        fn audit_record(&self, _org: &str, entry: Value, _now: i64) {
            self.audit.lock().push(entry);
        }
        fn metric_rows(&self, _org: &str, _now: i64) -> Vec<MetricRow> {
            Vec::new()
        }
        fn resource(&self, org: &str) -> Vec<(String, String)> {
            vec![("lucid.org".into(), org.into())]
        }
        fn make_sink(&self, _d: &Value, _c: Credential) -> Result<Box<dyn Sink>, SinkError> {
            Ok(Box::new(Rec(self.sent.clone())))
        }
        fn event_view(&self, _org: &str, client: &str, _now: i64) -> Option<EventView> {
            let scopes = self.scopes.lock().clone();
            (client == CLIENT && !scopes.is_empty()).then(|| EventView { scopes, ceiling: Ceiling::Confidential, reaches: Arc::new(|_: &str| true) })
        }
        fn events_page(&self, _org: &str, after: Option<&str>, limit: usize, view: &EventView, _repr: Repr, types: Option<Vec<String>>) -> Result<Value, FeedError> {
            let feed = self.feed.lock();
            let base = *self.base.lock();
            let n = match after {
                None => base,
                Some(c) => c.strip_prefix('p').and_then(|x| x.parse::<usize>().ok()).ok_or(FeedError::Cursor)?,
            };
            if n > feed.len() {
                return Err(FeedError::Cursor);
            }
            if n < base {
                return Err(FeedError::Gone);
            }
            let (mut out, mut next) = (Vec::new(), n);
            for (i, (scope, ce)) in feed.iter().enumerate().skip(n) {
                let name = ce["type"].as_str().unwrap().strip_prefix("com.emertins.lucid.").unwrap();
                if view.scopes.contains(scope) && types.as_ref().is_none_or(|t| t.iter().any(|x| x == name)) {
                    out.push(ce.clone());
                }
                next = i + 1;
                if out.len() >= limit {
                    break;
                }
            }
            Ok(json!({"events": out, "next": format!("p{next}")}))
        }
        fn events_tail(&self, _org: &str) -> Option<String> {
            Some(format!("p{}", self.feed.lock().len()))
        }
        fn events_dropped(&self) -> Vec<Dropped> {
            std::mem::take(&mut *self.dropped.lock())
        }
        fn emit_event(&self, _org: &str, kind: &str, data: Value, _now: i64) {
            self.emitted.lock().push((kind.into(), data));
        }
        fn suspend_destination(&self, _org: &str, id: &str, _now: i64) -> Result<(), String> {
            if *self.refuse_journal.lock() {
                return Err("the journal could not be written".into());
            }
            self.suspended.lock().push(id.into());
            Ok(())
        }
        fn webhook_material(&self, _org: &str, _id: &str, _staged: Option<&Value>, _now: i64) -> Material {
            Material { keys: vec![self.key.clone()], publics: vec![self.key.public], secrets: Vec::new() }
        }
        fn make_hook(&self, d: &Value, _c: Credential) -> Result<Arc<dyn HookPost>, SinkError> {
            let r = self.receivers.lock().get(text(d, "endpoint")).cloned().ok_or_else(|| SinkError { retryable: true, code: "connect", message: "nothing listens there".into() })?;
            Ok(r)
        }
    }

    fn engine(dir: &Path, hub: &Arc<Hub>) -> Arc<ExportEngine> {
        let e = ExportEngine::open(dir, hub.clone(), Arc::new(Logger::capture("test", Box::new(|_, _| {}))), false);
        e.refresh(NOW);
        e
    }

    fn status(e: &ExportEngine, id: &str, now: i64) -> Value {
        e.status(Some(ORG), now).into_iter().find(|s| s["id"] == id).unwrap_or(Value::Null)
    }

    /// An engine with a verified webhook for each id, every cursor at the feed's end.
    fn verified(name: &str, ids: &[&str]) -> (PathBuf, Arc<Hub>, Vec<Arc<Receiver>>, Arc<ExportEngine>) {
        let dir = tmp(name);
        let hub = Hub::new(ids.iter().map(|id| hook(id, json!({}))).collect());
        let rx: Vec<Arc<Receiver>> = ids.iter().map(|id| hub.receiver(id)).collect();
        let e = engine(&dir, &hub);
        e.pump(T);
        for id in ids {
            e.verify_webhook(ORG, &hook(id, json!({})), None, T).unwrap();
        }
        (dir, hub, rx, e)
    }

    #[test]
    fn a_webhook_waits_for_verification_then_delivers_signed_events_in_order() {
        let dir = tmp("verify");
        let hub = Hub::new(vec![hook(D1, json!({}))]);
        hub.push("events.subscribe", ce(1, "test.ping", json!({"destination": D1})));
        let rx = hub.receiver(D1);
        let e = engine(&dir, &hub);
        e.pump(T);
        hub.push("monitor.read", health(2));
        hub.push("monitor.read", health(3));
        e.pump(T);
        assert!(rx.deliveries().is_empty(), "nothing is delivered while unverified (R4-D10)");
        let st = status(&e, D1, T);
        assert_eq!((st["state"].as_str(), st["events"]["verification"].as_str()), (Some("paused"), Some("unverified")));
        // a receiver that answers the challenge wrongly stays unverified
        *rx.challenge.lock() = false;
        assert!(e.verify_webhook(ORG, &hook(D1, json!({})), None, T).is_err());
        e.pump(T);
        assert!(rx.deliveries().is_empty());
        *rx.challenge.lock() = true;
        e.verify_webhook(ORG, &hook(D1, json!({})), None, T).unwrap();
        let v: Vec<Value> = hub.audited("webhook.verified").iter().map(|a| a["result"].clone()).collect();
        assert_eq!(v, vec![json!("failed"), json!("ok")]);
        e.pump(T);
        // what followed the destination's creation, in feed order, one request each; nothing older
        assert_eq!(rx.seqs(), vec![2, 3]);
        for (h, body) in rx.deliveries() {
            assert_eq!(h["content-type"], CONTENT_TYPE);
            assert_eq!(h["user-agent"], user_agent());
            assert_eq!(h["webhook-id"], webhook_id(body["id"].as_str().unwrap()));
            assert_eq!(h["webhook-timestamp"], NOW.to_string());
            assert!(h["webhook-signature"].starts_with("v2a,"));
        }
        assert_eq!(status(&e, D1, T)["events"]["verification"], "verified");
        // a changed URL starts unverified again
        hub.dests.lock()[0]["endpoint"] = json!("https://hooks.acme.example/elsewhere");
        e.refresh(NOW);
        hub.push("monitor.read", health(4));
        e.pump(T + 1000);
        assert_eq!(rx.seqs(), vec![2, 3]);
        assert_eq!(status(&e, D1, T)["events"]["verification"], "unverified");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verification_none_delivers_at_once() {
        let dir = tmp("none");
        let mut d = hook(D1, json!({}));
        d["settings"]["verification"] = json!("none");
        let hub = Hub::new(vec![d]);
        let rx = hub.receiver(D1);
        let e = engine(&dir, &hub);
        e.pump(T);
        hub.push("monitor.read", health(1));
        e.pump(T);
        assert_eq!(rx.seqs(), vec![1]);
        assert_eq!(status(&e, D1, T)["events"]["verification"], "none");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_410_suspends_the_destination_through_the_journal() {
        let (dir, hub, rx, e) = verified("gone", &[D1]);
        hub.push("monitor.read", health(1));
        hub.push("monitor.read", health(2));
        rx[0].answers.lock().push_back(answer(410, None));
        e.pump(T);
        assert_eq!(*hub.suspended.lock(), vec![D1.to_string()], "destination_suspend journaled at once");
        let gone = hub.audited("webhook.gone");
        assert_eq!((gone.len(), &gone[0]["destination"], &gone[0]["status"]), (1, &json!(D1), &json!(410)));
        assert_eq!(hub.emitted("destination.paused"), vec![json!({"destination": D1, "reason": "gone"})]);
        e.pump(T + 600_000);
        assert_eq!(rx[0].seqs(), vec![1], "nothing more after the 410");
        assert_eq!(status(&e, D1, T + 600_000)["state"], "suspended");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_410_the_journal_refuses_stops_delivery_durably_until_it_is_journaled() {
        let (dir, hub, rx, e) = verified("gone-unjournaled", &[D1]);
        *hub.refuse_journal.lock() = true;
        hub.push("monitor.read", health(1));
        hub.push("monitor.read", health(2));
        rx[0].answers.lock().push_back(answer(410, None));
        e.pump(T);
        assert!(hub.suspended.lock().is_empty(), "the journal refused");
        assert_eq!(hub.audited("webhook.gone").len(), 1);
        assert_eq!(status(&e, D1, T)["state"], "suspended");
        // the map and journal still say active: a refresh makes it live again, and still nothing is sent
        e.refresh(NOW);
        hub.push("monitor.read", health(3));
        e.pump(T + 300_000);
        assert_eq!(rx[0].seqs(), vec![1], "nothing after the 410");
        assert_eq!(status(&e, D1, T + 300_000)["state"], "suspended");
        // nor after a restart
        drop(e);
        let e = engine(&dir, &hub);
        e.pump(T + 400_000);
        assert_eq!(rx[0].seqs(), vec![1], "the local stop is durable");
        assert!(hub.suspended.lock().is_empty());
        // once the journal takes it, the suspension is the journal's; the 410 was audited once
        *hub.refuse_journal.lock() = false;
        e.pump(T + 800_000);
        assert_eq!(*hub.suspended.lock(), vec![D1.to_string()]);
        assert_eq!(hub.audited("webhook.gone").len(), 1);
        assert_eq!(hub.emitted("destination.paused").len(), 1);
        assert_eq!(rx[0].seqs(), vec![1]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retries_honor_retry_after_then_back_off_and_pause_without_dropping() {
        let (dir, hub, rx, e) = verified("retry", &[D1]);
        hub.push("monitor.read", health(1));
        {
            let mut a = rx[0].answers.lock();
            a.push_back(answer(503, Some(7)));
            a.push_back(answer(500, Some(7)));
        }
        e.pump(T);
        e.pump(T + 6_999);
        assert_eq!(rx[0].seqs(), vec![1], "Retry-After 7 s is honored");
        e.pump(T + 7_000);
        assert_eq!(rx[0].seqs(), vec![1, 1], "a 500's Retry-After is not (backoff instead)");
        assert_eq!(status(&e, D1, T + 7_000)["state"], "retrying");
        e.pump(T + 9_000);
        let got = rx[0].deliveries();
        assert_eq!(got.len(), 3);
        assert!(got.iter().all(|(h, _)| h["webhook-id"] == got[0].0["webhook-id"]), "the same webhook-id on every retry");
        assert_eq!(got.iter().map(|(h, _)| h["webhook-timestamp"].clone()).collect::<Vec<_>>(), vec![NOW.to_string(), (NOW + 7).to_string(), (NOW + 9).to_string()]);
        assert_eq!(status(&e, D1, T + 9_000)["state"], "ok");
        // failing past queue.max_age_s (3600 s here) pauses; nothing is dropped
        hub.push("monitor.read", health(2));
        rx[0].answers.lock().extend((0..40).map(|_| answer(500, None)));
        let mut t = T + 10_000;
        for _ in 0..30 {
            e.pump(t);
            t += 300_000;
        }
        assert_eq!(hub.emitted("destination.paused"), vec![json!({"destination": D1, "reason": "retry-limit"})]);
        assert_eq!(e.events_paused(), vec![(ORG.to_string(), D1.to_string(), format!("hook {D1}"))]);
        assert_eq!(status(&e, D1, t)["state"], "paused");
        let tries = rx[0].deliveries().len();
        e.pump(t + 600_000);
        assert_eq!(rx[0].deliveries().len(), tries, "paused: no attempts");
        rx[0].answers.lock().clear();
        assert!(e.resume_events(ORG, D1, t).unwrap());
        assert!(!e.resume_events(ORG, D1, t).unwrap());
        assert_eq!(hub.emitted("destination.resumed"), vec![json!({"destination": D1, "reason": "admin"})]);
        e.pump(t);
        assert_eq!(rx[0].seqs().last(), Some(&2), "resumed from the same cursor");
        assert!(e.events_paused().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_redelivers_with_identical_webhook_ids() {
        let (dir, hub, rx, e) = verified("replay", &[D1]);
        for n in 1..=3 {
            hub.push("monitor.read", health(n));
        }
        e.pump(T);
        assert_eq!(rx[0].seqs(), vec![1, 2, 3]);
        let first: Vec<String> = rx[0].deliveries().iter().map(|(h, _)| h["webhook-id"].clone()).collect();
        e.replay_events(ORG, D1, Some("p1"), T).unwrap();
        e.pump(T + 1000);
        assert_eq!(rx[0].seqs(), vec![1, 2, 3, 2, 3]);
        let again: Vec<String> = rx[0].deliveries().iter().skip(3).map(|(h, _)| h["webhook-id"].clone()).collect();
        assert_eq!(again, first[1..].to_vec(), "receivers drop the duplicates by webhook-id");
        e.replay_events(ORG, D1, None, T).unwrap();
        e.pump(T + 2000);
        assert_eq!(rx[0].seqs().len(), 8, "from the oldest event kept");
        assert!(e.replay_events(ORG, D1, Some("p99"), T).is_err(), "not a position of the feed");
        *hub.base.lock() = 2;
        assert!(e.replay_events(ORG, D1, Some("p1"), T).is_err(), "older than retention");
        assert!(e.replay_events(ORG, D2, None, T).is_err(), "no such destination");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn selection_follows_the_client_and_a_test_ping_its_destination() {
        let (dir, hub, rx, e) = verified("select", &[D1, D2]);
        hub.push("events.subscribe", ce(1, "test.ping", json!({"destination": D2})));
        hub.push("monitor.read", health(2));
        hub.push("compliance.metadata.read", ce(3, "hold.placed", json!({"hold": "h_1", "on": "people", "count": 1})));
        e.pump(T);
        assert_eq!(rx[0].seqs(), vec![2], "no ping for another destination, no event of a scope the client lacks");
        assert_eq!(rx[1].seqs(), vec![1, 2]);
        // a scope dropped from the client stops those types at once
        *hub.scopes.lock() = vec!["events.subscribe".into()];
        hub.push("monitor.read", health(4));
        e.pump(T + 1000);
        assert_eq!(rx[0].seqs(), vec![2]);
        // a client that may read nothing (suspended, expired, api_off) pauses the destination
        hub.scopes.lock().clear();
        e.pump(T + 2000);
        let st = status(&e, D1, T + 2000);
        assert_eq!(st["state"], "paused");
        assert!(st["events"]["blocked"].is_string());
        // types narrow what a webhook takes
        *hub.scopes.lock() = vec!["events.subscribe".into(), "monitor.read".into()];
        hub.dests.lock()[0]["settings"]["types"] = json!(["test.ping"]);
        e.refresh(NOW);
        hub.push("monitor.read", health(5));
        e.pump(T + 3000);
        assert_eq!(rx[0].seqs(), vec![2], "relay.health.changed is not in its types");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn events_ride_a_hec_destination_as_records() {
        let dir = tmp("hec");
        let hec = json!({"id": D1, "name": "HEC", "kind": "splunk_hec", "preset": "splunk_hec", "signals": ["audit", "events"], "ceiling": "confidential",
                         "identities": "pseudonymized", "failover": false, "private_ok": false, "endpoint": "https://hec.acme.example:8088",
                         "settings": {"events_client": CLIENT}, "credential": {"type": "token", "ref": "secret:d_00000000000000a1"},
                         "queue": {"max_bytes": 1u64 << 30, "max_age_s": 3600}});
        let hub = Hub::new(vec![hec]);
        let e = engine(&dir, &hub);
        e.pump(T);
        hub.push("monitor.read", health(1));
        hub.push("events.subscribe", ce(2, "test.ping", json!({"destination": D2})));
        hub.push("monitor.read", health(3));
        e.pump(T);
        let sent = hub.sent.lock().clone();
        assert_eq!(sent.len(), 1, "one batch");
        assert_eq!(sent[0].signal, Signal::Events);
        let r = &sent[0].records;
        assert_eq!(r.iter().map(|x| x["body"]["lucidseq"].as_u64().unwrap()).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(r[0]["event"], "relay.health.changed");
        assert_eq!(r[0]["attributes"]["event.name"], "relay.health.changed");
        assert_eq!(r[0]["attributes"]["lucid.event_id"], "lucid-api-events-pseudo-v1:acme/console:1");
        assert_eq!(r[0]["attributes"]["lucid.chain"], "lucid-api-events-pseudo-v1:acme/console");
        assert_eq!(r[0]["attributes"]["lucid.seq"], 1);
        assert_eq!(r[0]["body"], health(1));
        assert_eq!(r[0]["t_ms"], 1_795_000_123_000i64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn events_deleted_unread_are_counted_and_audited() {
        let (dir, hub, rx, e) = verified("retention", &[D1]);
        hub.push("monitor.read", health(1));
        hub.push("monitor.read", health(2));
        // a webhook behind by 35 days: retention deleted both before it read them (R4-17)
        *hub.base.lock() = 2;
        hub.dropped.lock().push(Dropped { org: ORG.into(), source: "console".into(), repr: Repr::Pseudonymized, first: 1, last: 2, reason: "retention" });
        e.tick(T);
        hub.push("monitor.read", health(3));
        e.pump(T);
        let failed = hub.audited("exports.failed");
        assert_eq!(failed.len(), 1);
        assert_eq!((&failed[0]["destination"], &failed[0]["code"], &failed[0]["count"]), (&json!(D1), &json!("retention"), &json!(2)));
        assert_eq!(failed[0]["resource"], "events console 1-2");
        assert_eq!(rx[0].seqs(), vec![3], "delivery goes on from the first event still kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_events_cursor_survives_a_restart() {
        let (dir, hub, rx, e) = verified("restart", &[D1]);
        hub.push("monitor.read", health(1));
        e.pump(T);
        drop(e);
        hub.push("monitor.read", health(2));
        let e = engine(&dir, &hub);
        e.pump(T + 1000);
        assert_eq!(rx[0].seqs(), vec![1, 2], "verification and cursor kept: nothing twice, nothing lost");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
