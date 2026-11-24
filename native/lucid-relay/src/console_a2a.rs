// API-1 revision 6 (docs/api/contract-r6-1d.md) 7.1.2 to 7.1.5 and 7.13, the console end of A2A Agent Cards:
//
// - Card keys (7.1.2): P-256 keys drawn on the console (AWS-LC), sealed as `api-a2a-card-<org>-<kid>` (PKCS#8, never
//   exported), their public JWKs staged into the draft's `a2a.jwks` (`settings/api/a2a/keys`); at most three, a year
//   each. `a2a_key_drop` (console journal, 4a) stops signing and leaves `I/a2a/jwks.json` at once (7.1.4).
// - Signing (7.1.2, 7.1.4): a card is built from the pinned map (`a2a_card::build`) and signed with every usable key,
//   lazily: when it is served or viewed and its inputs changed (the pinned seq, the usable kids, the agent's active
//   `agent_drop_skill` skills), and on the console's minute tick. Every signing appends `a2a.card.signed` to the org's
//   console chain before the card is served (9.4; failure answers 503 `audit-unavailable`) and counts
//   `lucid_a2a_cards_signed_total`.
// - Publishing (7.1.5), the front door's Public pipeline: `I/a2a/agents`, `I/a2a/agents/<id>/agent-card.json` (ETag,
//   304 on `If-None-Match`, `max-age=300`), `I/a2a/jwks.json` (`max-age=300`), and the root
//   `/.well-known/agent-card.json` when exactly one pinned map on this console names `a2a.well_known`. Cards exist
//   only while the org's map is pinned, unexpired and not under `api_off`, and the agent is listed, not under
//   `agent_off`, with a skill left.
// - Partner cards (7.13): a client's own card fetched under 1a 8.1 (private addresses only inside its
//   `card.private_cidrs` unless `card_private_off`), verified with keys from its `card.jwks_uri` only (never the
//   card's `jku`), its `provider.url` origin among `push.origins` when push is set; at registration (first view),
//   on demand and every 24 hours. A failed check raises `a2a-partner-card-invalid` and changes no grant.
//
// As built: `a2a.card.signed` carries `kid` as the signing kids joined by "," in kid order (the audit chain's plain
// fields are scalars; r6 11 lists it as a list).

use crate::a2a_card;
use crate::api_audit::ApiAudit;
use crate::api_cjournal::{agent_off, ConsoleEntry};
use crate::api_resource::{problem, Reply};
use crate::codec::{b64u, hex, sha256};
use crate::console::ApiError;
use crate::console_api::ConsoleApi;
use crate::console_api_ui::Draft;
use crate::console_source::Cidr;
use crate::fleet_ca::{vault_do, VaultLock};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;
use std::sync::Arc;

/// How long a card key drawn by the console is listed (2.2 allows at most 400 days).
pub const KEY_DAYS: i64 = 365;
/// 2.2: `a2a.jwks` holds 1 to 3 keys.
pub const KEYS_MAX: usize = 3;
/// 7.13: a partner card is fetched again after this long (seconds).
pub const CHECK_EVERY: i64 = 86_400;
/// At most this many partner card checks run at once (each on its own thread); further due clients wait for a later
/// tick.
pub const CHECK_WORKERS: usize = 4;
/// 7.1.2 `card-unsigned` (the console words).
pub const CARD_UNSIGNED: &str = "No card key is inside its window. Make a card key and save the map.";
const DAY: i64 = 86_400;
const DROP: &str = "a2a_key_drop";
const NOT_FOUND: &str = "Nothing is here.";
const NO_CARD: &str = "That client has no partner card in the organization's api map.";
/// The largest partner key set fetched.
const JWKS_MAX: usize = 64 * 1024;

/// A partner fetch: (url, private ranges allowed, byte limit) -> the JSON document or why not.
pub type FetchFn = dyn Fn(&str, &[Cidr], usize) -> Result<Value, String> + Send + Sync;

/// What a card was signed from (7.1.2: a change of any of them signs it again).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Inputs {
    seq: i64,
    kids: Vec<String>,
    dropped: Vec<String>,
}

/// A signed card as served.
#[derive(Debug)]
struct Signed {
    inputs: Inputs,
    card: Value,
    bytes: Vec<u8>,
    etag: String,
    signed_at: i64,
}

/// The verified fields of a partner card (7.13).
#[derive(Clone, Debug)]
struct Verified {
    name: Value,
    provider: Value,
    version: Value,
    interfaces: Vec<Value>,
    kids: Vec<String>,
}

#[derive(Clone, Debug)]
struct PartnerCheck {
    checked_at: i64,
    outcome: Result<Verified, String>,
}

/// The console's A2A state (memory only: cards are signed again and partner cards checked again after a restart).
#[derive(Default)]
pub struct A2aState {
    /// (org, agent) -> the card served now.
    cards: Mutex<BTreeMap<(String, String), Arc<Signed>>>,
    /// (org, client) -> its last partner card check.
    partners: Mutex<BTreeMap<(String, String), PartnerCheck>>,
    /// (org, client) whose check runs on a thread now.
    checking: Mutex<BTreeSet<(String, String)>>,
    /// The partner fetch (None: the network under 1a 8.1).
    fetch: Mutex<Option<Arc<FetchFn>>>,
}

impl A2aState {
    /// Replace the partner fetch (tests).
    #[cfg(test)]
    pub fn set_fetch(&self, f: Arc<FetchFn>) {
        *self.fetch.lock() = Some(f);
    }

    fn fetcher(&self) -> Arc<FetchFn> {
        self.fetch.lock().clone().unwrap_or_else(|| Arc::new(net_fetch) as Arc<FetchFn>)
    }
}

/// 1a 8.1 with the 7.13 private range rule.
fn net_fetch(url: &str, within: &[Cidr], max: usize) -> Result<Value, String> {
    let u = crate::api_fetch::check_url(url).map_err(|e| e.to_string())?;
    crate::api_fetch::fetch_json_within_blocking(&u, within, max, crate::api_fetch::Limits::default()).map_err(|e| e.to_string())
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn int(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn issuer_of(map: &Value) -> &str {
    map.pointer("/issuer/url").and_then(Value::as_str).unwrap_or_default()
}

fn agents_of(map: &Value) -> &[Value] {
    map.pointer("/a2a/agents").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

fn jwks_of(map: &Value) -> &[Value] {
    map.pointer("/a2a/jwks").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

fn find_agent<'a>(map: &'a Value, id: &str) -> Option<&'a Value> {
    agents_of(map).iter().find(|a| text(a, "id") == id)
}

fn find_client<'a>(map: &'a Value, id: &str) -> Option<&'a Value> {
    map.get("clients").and_then(Value::as_array)?.iter().find(|c| text(c, "id") == id)
}

/// The agent's skills under an active `agent_drop_skill`, sorted.
fn dropped_skills(active: &[ConsoleEntry], agent: &str) -> Vec<String> {
    let mut out: Vec<String> = active.iter().filter(|e| e.action == "agent_drop_skill" && e.field("agent") == agent).map(|e| e.field("skill").to_string()).collect();
    out.sort();
    out.dedup();
    out
}

/// Listed, not under `agent_off`, and with a skill not dropped (7.1.4: a card without skills accepts no task).
fn agent_served(agent: &Value, active: &[ConsoleEntry]) -> bool {
    let id = text(agent, "id");
    let dropped = dropped_skills(active, id);
    !agent_off(active, id) && agent.get("skills").and_then(Value::as_array).is_some_and(|s| s.iter().any(|k| !dropped.iter().any(|d| d == text(k, "id"))))
}

fn key_dropped(active: &[ConsoleEntry], kid: &str) -> bool {
    active.iter().any(|e| e.action == DROP && e.target.as_str() == Some(kid))
}

/// The sealed name of a card key (PKCS#8, P-256).
pub fn seal_name(org: &str, kid: &str) -> String {
    format!("api-a2a-card-{org}-{kid}")
}

/// The sealed card key `kid` of `org`.
pub(crate) fn sealed_key(vault: &dyn VaultLock, org: &str, kid: &str) -> Option<EcdsaKeyPair> {
    let pkcs8 = vault_do(vault, |v| v.get(&seal_name(org, kid)))?;
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8).ok()
}

/// 7.1.2, 7.1.4: the entries of an `a2a.jwks` list inside `nbf <= now < exp` and not under `a2a_key_drop`.
pub(crate) fn usable<'a>(listed: &'a [Value], active: &[ConsoleEntry], now: i64) -> Vec<&'a Value> {
    listed.iter().filter(|k| int(k, "nbf") <= now && now < int(k, "exp") && !key_dropped(active, text(k, "kid"))).collect()
}

// ── card keys (7.1.2, 7.14) ──────────────────────────────────────────────────────────────────────────────────

/// `POST settings/api/a2a/keys {org}`: a P-256 key drawn (AWS-LC) and sealed now, its public JWK staged in the draft's
/// `a2a.jwks` (`a2a` made `{"jwks": [], "agents": []}` when absent), kid `a2a-<b64u of 6 random bytes>`, `nbf` now,
/// `exp` a year on; expired keys leave the draft first and a fourth is refused (`invalid`). Ok is the staged JWK.
pub fn stage_new_key(d: &mut Draft, vault: &dyn VaultLock, org: &str, now: i64) -> Result<Value, ApiError> {
    if !d.map.get("a2a").is_some_and(Value::is_object) {
        d.map["a2a"] = json!({"jwks": [], "agents": []});
    }
    if !d.map["a2a"].get("jwks").is_some_and(Value::is_array) {
        d.map["a2a"]["jwks"] = json!([]);
    }
    let failed = |why: &str| ApiError::with("write-failed", why.to_string());
    let keys = d.map["a2a"]["jwks"].as_array_mut().ok_or_else(|| ApiError::of("invalid"))?;
    keys.retain(|k| int(k, "exp") > now);
    if keys.len() >= KEYS_MAX {
        return Err(ApiError::with("invalid", "An organization has at most three card keys. Drop one first."));
    }
    let kid = format!("a2a-{}", b64u(&crate::console_auth::random(6).ok_or_else(|| failed("No random bytes are available."))?));
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).map_err(|_| failed("A card key could not be drawn."))?;
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref()).map_err(|_| failed("A card key could not be drawn."))?;
    vault_do(vault, |v| v.put(&seal_name(org, &kid), pkcs8.as_ref())).map_err(|e| ApiError::with("seal-provider-needed", e))?;
    let jwk = a2a_card::public_jwk(&pair, &kid, now, now + KEY_DAYS * DAY);
    keys.push(jwk.clone());
    d.note(format!("Add card key {kid}"));
    Ok(jwk)
}

/// `POST settings/api/a2a/keys/drop {org, kid}` (2.3, 7.1.4): `a2a_key_drop` in the console journal at once when the
/// pinned map lists the key (flushed before Ok: the console stops signing with it and `I/a2a/jwks.json` omits it), and
/// the key out of the org's draft when one is staged (the last one removes `a2a.jwks`). Ok is the journal entry (null
/// for a key only staged) and whether the draft changed.
pub fn drop_key(api: &ConsoleApi, draft: Option<&mut Draft>, org: &str, kid: &str, now: i64) -> Result<(Value, bool), ApiError> {
    let listed = |m: &Value| jwks_of(m).iter().any(|k| text(k, "kid") == kid);
    let pinned_has = api.pinned(org).0.as_ref().is_some_and(listed);
    let in_draft = draft.as_ref().is_some_and(|d| listed(&d.map));
    if !pinned_has && !in_draft {
        return Err(ApiError::with("not-found", "That card key is not in the organization's api map."));
    }
    if key_dropped(&api.console_active(org), kid) {
        return Err(ApiError::with("stale", "Nothing was changed: that card key is already dropped."));
    }
    let entry = if pinned_has { api.append_console(org, DROP, json!(kid), now).map_err(|e| ApiError::with("write-failed", e.message))? } else { Value::Null };
    let mut changed = false;
    if let Some(d) = draft.filter(|_| in_draft) {
        if let Some(keys) = d.map.pointer_mut("/a2a/jwks").and_then(Value::as_array_mut) {
            keys.retain(|k| text(k, "kid") != kid);
            // 2.2: `a2a.jwks` holds 1 to 3 keys when present, so the last one takes the field with it
            if keys.is_empty() {
                if let Some(a2a) = d.map.get_mut("a2a").and_then(Value::as_object_mut) {
                    a2a.remove("jwks");
                }
            }
            d.note(format!("Drop card key {kid}"));
            changed = true;
        }
    }
    Ok((entry, changed))
}

/// KeyView of each `a2a.jwks` entry of `map` (the pinned map or a draft's): `{kid, nbf, exp, state, sealed,
/// thumbprint}`, `state` `dropped` (active `a2a_key_drop`), `expired`, `pending` (before `nbf`) or `active`, `sealed`
/// when this console holds the private key with the same public point.
pub fn key_views(api: &ConsoleApi, org: &str, map: &Value, now: i64) -> Vec<Value> {
    let active = api.console_active(org);
    let vault = api.vault();
    jwks_of(map)
        .iter()
        .map(|k| {
            let kid = text(k, "kid");
            let state = if key_dropped(&active, kid) {
                "dropped"
            } else if now >= int(k, "exp") {
                "expired"
            } else if now < int(k, "nbf") {
                "pending"
            } else {
                "active"
            };
            let sealed = sealed_key(&*vault, org, kid).is_some_and(|p| {
                let mine = crate::api_issue::ec_public_jwk(&p, kid);
                mine.get("x") == k.get("x") && mine.get("y") == k.get("y")
            });
            json!({"kid": kid, "nbf": k.get("nbf"), "exp": k.get("exp"), "state": state, "sealed": sealed, "thumbprint": a2a_card::thumbprint(k)})
        })
        .collect()
}

// ── signing (7.1.2, 7.1.4) ───────────────────────────────────────────────────────────────────────────────────

/// Why a card is not served.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Refused {
    /// No serving map (pinned, unexpired, not `api_off`), or the agent is not in it: 404.
    NotPinned,
    /// `agent_off`, or every skill dropped: 404.
    Off,
    /// No usable key: 503 `card-unsigned`.
    Unsigned,
    /// The signing could not be audited: 503 `audit-unavailable`.
    Audit,
}

impl Refused {
    fn state(self) -> &'static str {
        match self {
            Refused::NotPinned => "not-pinned",
            Refused::Off => "off",
            Refused::Unsigned | Refused::Audit => "unsigned",
        }
    }

    fn reply(self) -> Reply {
        match self {
            Refused::NotPinned | Refused::Off => problem(404, "not-found", NOT_FOUND),
            Refused::Unsigned => problem(503, "card-unsigned", CARD_UNSIGNED),
            Refused::Audit => crate::api_resource::audit_unavailable(),
        }
    }
}

/// The card of `agent` served now, signed again first when its inputs changed; each signing is in the org's console
/// chain (`a2a.card.signed`) before it is kept or served.
fn signed(api: &ConsoleApi, audit: Option<&ApiAudit>, org: &str, agent: &str, now: i64) -> Result<Arc<Signed>, Refused> {
    let (map, seq) = api.a2a_serving(org, now).ok_or(Refused::NotPinned)?;
    let a = find_agent(&map, agent).ok_or(Refused::NotPinned)?;
    let active = api.console_active(org);
    if !agent_served(a, &active) {
        return Err(Refused::Off);
    }
    let keys = api.a2a_keys(org, now);
    if keys.is_empty() {
        return Err(Refused::Unsigned);
    }
    let inputs = Inputs { seq, kids: keys.iter().map(|(k, _)| k.clone()).collect(), dropped: dropped_skills(&active, agent) };
    let at = (org.to_string(), agent.to_string());
    // one signing at a time, so a card is signed (and audited) once per change of its inputs
    let mut cards = api.a2a.cards.lock();
    if let Some(s) = cards.get(&at).filter(|s| s.inputs == inputs) {
        return Ok(s.clone());
    }
    let card = a2a_card::build(&map, org, agent, &inputs.dropped).ok_or(Refused::NotPinned)?;
    if card.get("skills").and_then(Value::as_array).is_none_or(Vec::is_empty) {
        return Err(Refused::Off);
    }
    let refs: Vec<(&str, &EcdsaKeyPair)> = keys.iter().map(|(k, p)| (k.as_str(), p)).collect();
    let card = a2a_card::sign(&card, &refs, &a2a_card::jwks_url(issuer_of(&map))).map_err(|_| Refused::Unsigned)?;
    let bytes = a2a_card::served(&card);
    let entry = json!({"action": "a2a.card.signed", "result": "ok", "agent": agent, "kid": inputs.kids.join(","),
                       "card_sha256": hex(&sha256(&bytes)), "map_seq": seq});
    audit.ok_or(Refused::Audit)?.record(org, entry, now).map_err(|_| Refused::Audit)?;
    crate::api_catalog::counters::a2a_card_signed(org, agent);
    let s = Arc::new(Signed { etag: a2a_card::etag(&card), card, bytes, signed_at: now, inputs });
    cards.insert(at, s.clone());
    Ok(s)
}

/// CardView of one agent of the pinned map (signing it first when needed): `{state, card, etag, kids, signed_at,
/// map_seq}`, `state` `served`, `unsigned` (no usable key, or the signing could not be audited), `off` or
/// `not-pinned`.
pub fn card_view(api: &ConsoleApi, audit: Option<&ApiAudit>, org: &str, agent: &str, now: i64) -> Value {
    match signed(api, audit, org, agent, now) {
        Ok(s) => json!({"state": "served", "card": s.card, "etag": s.etag, "kids": s.inputs.kids, "signed_at": s.signed_at, "map_seq": s.inputs.seq}),
        Err(r) => json!({"state": r.state(), "card": null, "etag": null, "kids": [], "signed_at": null, "map_seq": null}),
    }
}

// ── publishing (7.1.5) ───────────────────────────────────────────────────────────────────────────────────────

/// A front door card route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Publish<'a> {
    /// `GET I/a2a/agents` of an org.
    Agents(&'a str),
    /// `GET I/a2a/agents/<agent>/agent-card.json` of (org, agent).
    Card(&'a str, &'a str),
    /// `GET I/a2a/jwks.json` of an org.
    Jwks(&'a str),
    /// `GET /.well-known/agent-card.json` (outside every org namespace).
    WellKnown,
}

/// (org, agent) of the root well-known card: the `a2a.well_known` of the one pinned map naming one; None when none or
/// several do.
fn well_known(api: &ConsoleApi) -> Option<(String, String)> {
    let named: Vec<(String, String)> =
        api.orgs().into_iter().filter_map(|org| api.pinned(&org).0.and_then(|m| m.pointer("/a2a/well_known").and_then(Value::as_str).map(str::to_string)).map(|a| (org, a))).collect();
    match named.as_slice() {
        [one] => Some(one.clone()),
        _ => None,
    }
}

/// Whether an `If-None-Match` value names `etag` (or `*`); weak tags compare by their opaque part.
fn etag_matches(header: &str, etag: &str) -> bool {
    header.split(',').map(str::trim).any(|t| t == "*" || t.strip_prefix("W/").unwrap_or(t) == etag)
}

fn public(body: Value) -> Reply {
    let mut r = Reply::json(200, body);
    r.headers = vec![("Cache-Control", "max-age=300".into())];
    r
}

/// 7.1.5 on the front door's Public pipeline. None (404 outside every chain) for an org without a pinned map and for
/// the root well-known without exactly one map naming a card; else the org the answer concerns and the answer: the
/// source limiter (429 `abuse`), 404 while no card may be served, 503 `card-unsigned` or `audit-unavailable`, the
/// document, or 304 for a card whose `ETag` `if_none_match` names. The caller records refusals in the org's chain.
pub fn publish(api: &ConsoleApi, audit: Option<&ApiAudit>, what: Publish<'_>, if_none_match: Option<&str>, source: IpAddr, now: i64) -> Option<(String, Reply)> {
    let (org, agent) = match what {
        Publish::Agents(o) | Publish::Jwks(o) => (o.to_string(), None),
        Publish::Card(o, a) => (o.to_string(), Some(a.to_string())),
        Publish::WellKnown => {
            let (o, a) = well_known(api)?;
            (o, Some(a))
        }
    };
    api.pinned(&org).0?;
    if let Err(s) = api.public_source_ok(source, now) {
        let mut r = problem(429, "abuse", "Too many requests from this address; try again later.");
        r.headers.push(("Retry-After", s.max(1).to_string()));
        return Some((org, r));
    }
    let Some((map, _)) = api.a2a_serving(&org, now) else { return Some((org, Refused::NotPinned.reply())) };
    let active = api.console_active(&org);
    let r = match (what, agent) {
        (Publish::Agents(_), _) => {
            let issuer = issuer_of(&map);
            let agents: Vec<Value> = agents_of(&map)
                .iter()
                .filter(|a| agent_served(a, &active))
                .map(|a| json!({"id": a.get("id"), "name": a.get("name"), "card": a2a_card::card_url(issuer, text(a, "id"))}))
                .collect();
            public(json!({ "agents": agents }))
        }
        (Publish::Jwks(_), _) => {
            let keys: Vec<Value> = usable(jwks_of(&map), &active, now)
                .into_iter()
                .map(|k| json!({"kty": k.get("kty"), "crv": k.get("crv"), "kid": k.get("kid"), "x": k.get("x"), "y": k.get("y"), "use": "sig", "alg": "ES256"}))
                .collect();
            public(json!({ "keys": keys }))
        }
        (_, Some(agent)) => match signed(api, audit, &org, &agent, now) {
            Ok(s) => {
                let headers = vec![("Cache-Control", "max-age=300".to_string()), ("ETag", s.etag.clone())];
                if if_none_match.is_some_and(|h| etag_matches(h, &s.etag)) {
                    Reply { status: 304, ctype: "application/json", headers, body: Value::Null, text: None, raw: Some(Vec::new()) }
                } else {
                    Reply { status: 200, ctype: "application/json", headers, body: s.card.clone(), text: None, raw: Some(s.bytes.clone()) }
                }
            }
            Err(r) => r.reply(),
        },
        _ => Refused::NotPinned.reply(),
    };
    Some((org, r))
}

// ── partner cards (7.13) ─────────────────────────────────────────────────────────────────────────────────────

fn check_partner(api: &ConsoleApi, org: &str, client: &Value) -> Result<Verified, String> {
    let id = text(client, "id");
    let cfg = client.get("card").cloned().unwrap_or(Value::Null);
    let active = api.console_active(org);
    // `card_private_off` empties the ranges, or keeps only those inside its `keep`
    let pinned: Vec<String> = strings(cfg.get("private_cidrs")).iter().map(|c| c.to_string()).collect();
    let within: Vec<Cidr> = crate::api_cjournal::card_private_within(&active, id, &pinned).iter().filter_map(|c| crate::console_source::parse_cidr(c).ok()).collect();
    let fetch = api.a2a.fetcher();
    let jwks = fetch(text(&cfg, "jwks_uri"), &within, JWKS_MAX).map_err(|e| format!("The partner's key set could not be fetched ({e})."))?;
    let card = fetch(text(&cfg, "url"), &within, a2a_card::CARD_MAX).map_err(|e| format!("The partner's card could not be fetched ({e})."))?;
    let kids = a2a_card::verify(&card, &crate::api_issue::keys_of(&jwks))?;
    if let Some(push) = client.pointer("/a2a/push").filter(|p| p.is_object() && !crate::api_cjournal::push_off(&active, id)) {
        let origins = strings(push.get("origins"));
        let origin = card.pointer("/provider/url").and_then(Value::as_str).and_then(crate::connector_a2a_wire::origin_of);
        if !origin.is_some_and(|o| origins.contains(&o)) {
            return Err("The card's provider URL is not at one of the client's push origins.".into());
        }
    }
    let interfaces = card
        .get("supportedInterfaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|i| json!({"url": i.get("url"), "protocolBinding": i.get("protocolBinding"), "protocolVersion": i.get("protocolVersion")}))
        .collect();
    let field = |k: &str| card.get(k).cloned().unwrap_or(Value::Null);
    Ok(Verified { name: field("name"), provider: field("provider"), version: field("version"), interfaces, kids })
}

fn partner_view(c: Option<&PartnerCheck>) -> Value {
    match c {
        None => json!({"state": "unchecked", "checked_at": null, "why": null, "name": null, "provider": null, "version": null, "interfaces": [], "kids": []}),
        Some(PartnerCheck { checked_at, outcome: Ok(v) }) => json!({"state": "verified", "checked_at": checked_at, "why": null, "name": v.name, "provider": v.provider,
                                                                     "version": v.version, "interfaces": v.interfaces, "kids": v.kids}),
        Some(PartnerCheck { checked_at, outcome: Err(why) }) => json!({"state": "invalid", "checked_at": checked_at, "why": why, "name": null, "provider": null,
                                                                        "version": null, "interfaces": [], "kids": []}),
    }
}

/// 7.13 `POST settings/api/clients/card-check {org, id}`: fetch and verify the partner card of client `id` of the
/// pinned map now; Ok is its PartnerCardView (`verified` or `invalid` with why). Never changes a grant. Err `not-found`
/// for a client without `card`. Blocking: two fetches.
pub fn card_check(api: &ConsoleApi, org: &str, id: &str, now: i64) -> Result<Value, ApiError> {
    let pinned = api.pinned(org).0.ok_or_else(|| ApiError::with("not-found", NO_CARD))?;
    let client = find_client(&pinned, id).filter(|c| c.get("card").is_some_and(Value::is_object)).ok_or_else(|| ApiError::with("not-found", NO_CARD))?;
    let check = PartnerCheck { checked_at: now, outcome: check_partner(api, org, client) };
    let view = partner_view(Some(&check));
    api.a2a.partners.lock().insert((org.to_string(), id.to_string()), check);
    Ok(view)
}

/// PartnerCardView of client `id`: `unchecked` before its first check.
pub fn partner_card_view(api: &ConsoleApi, org: &str, id: &str) -> Value {
    partner_view(api.a2a.partners.lock().get(&(org.to_string(), id.to_string())))
}

// ── the minute tick and attention ────────────────────────────────────────────────────────────────────────────

/// The console's minute tick: every served card signed again when its inputs changed (audited), cards of agents no
/// longer served forgotten, and each partner card unchecked or checked 24 hours ago fetched again on its own thread.
pub fn tick(api: &Arc<ConsoleApi>, audit: Option<&ApiAudit>, now: i64) {
    let orgs = api.orgs();
    let mut served = BTreeSet::new();
    for org in &orgs {
        let Some((map, _)) = api.a2a_serving(org, now) else { continue };
        for a in agents_of(&map) {
            let agent = text(a, "id");
            if audit.is_some() && signed(api, audit, org, agent, now).is_ok() {
                served.insert((org.clone(), agent.to_string()));
            }
        }
    }
    api.a2a.cards.lock().retain(|k, _| served.contains(k));
    let mut present = BTreeSet::new();
    for org in &orgs {
        let Some(map) = api.pinned(org).0 else { continue };
        for c in map.get("clients").and_then(Value::as_array).into_iter().flatten().filter(|c| c.get("card").is_some_and(Value::is_object)) {
            let key = (org.clone(), text(c, "id").to_string());
            present.insert(key.clone());
            let due = api.a2a.partners.lock().get(&key).is_none_or(|p| now - p.checked_at >= CHECK_EVERY);
            if !due {
                continue;
            }
            {
                // at most CHECK_WORKERS checks in flight; the rest stay due for a later tick
                let mut busy = api.a2a.checking.lock();
                if busy.len() >= CHECK_WORKERS || !busy.insert(key.clone()) {
                    continue;
                }
            }
            let (worker, (o, id)) = (api.clone(), key.clone());
            let spawned = std::thread::Builder::new().name("a2a-card-check".into()).spawn(move || {
                let _ = card_check(&worker, &o, &id, now);
                worker.a2a.checking.lock().remove(&(o, id));
            });
            if spawned.is_err() {
                api.a2a.checking.lock().remove(&key);
            }
        }
    }
    api.a2a.partners.lock().retain(|k, _| present.contains(k));
}

/// Attention items: `a2a-card-key-missing` {org, agent} for each served agent of an org whose pinned map names agents
/// but has no usable card key (7.1.2 `A2aCardKeyMissing`); `a2a-partner-card-invalid` {org, client, why} for each
/// client whose last partner card check failed (7.13 `A2aPartnerCardInvalid`).
pub fn attention(api: &ConsoleApi, now: i64) -> Vec<(&'static str, Value)> {
    let mut out = Vec::new();
    for org in api.orgs() {
        let Some((map, _)) = api.a2a_serving(&org, now) else { continue };
        if agents_of(&map).is_empty() || !api.a2a_keys(&org, now).is_empty() {
            continue;
        }
        let active = api.console_active(&org);
        for a in agents_of(&map).iter().filter(|a| agent_served(a, &active)) {
            out.push(("a2a-card-key-missing", json!({"org": org, "agent": text(a, "id")})));
        }
    }
    let invalid: Vec<(String, String, String)> =
        api.a2a.partners.lock().iter().filter_map(|((org, client), c)| c.outcome.as_ref().err().map(|why| (org.clone(), client.clone(), why.clone()))).collect();
    for (org, client, why) in invalid {
        let listed = api.pinned(&org).0.as_ref().and_then(|m| find_client(m, &client).map(|c| c.get("card").is_some_and(Value::is_object))).unwrap_or(false);
        if listed {
            out.push(("a2a-partner-card-invalid", json!({"org": org, "client": client, "why": why})));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_audit::{CheckpointSigner, PseudonymKeys, Repr};
    use crate::api_map::{api_map_hash, VerifiedApiMap};
    use crate::fleet_ca::MemVault;
    use crate::log::Logger;

    const NOW: i64 = 1_795_000_000;
    const AGENT: &str = "a_7c1d2e3f4a5b6c7d";
    const CONNECTOR: &str = "k_1a2b3c4d5e6f7081";
    const PARTNER: &str = "c_0b1c2d3e4f506172";
    const PARTNER_CARD: &str = "https://ci.partner.example/.well-known/agent-card.json";
    const PARTNER_JWKS: &str = "https://ci.partner.example/jwks.json";

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

    struct NoKeys;
    impl PseudonymKeys for NoKeys {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            None
        }
    }

    fn ip() -> IpAddr {
        IpAddr::from([203, 0, 113, 7])
    }

    fn chains(name: &str) -> ApiAudit {
        let dir = crate::fleet_ca::tests_dir(&format!("console-a2a-{name}"));
        ApiAudit::open(Some(dir.as_path()), "console", Arc::new(NoSigner), Arc::new(NoKeys), NOW)
    }

    fn console() -> Arc<ConsoleApi> {
        let logger = Arc::new(Logger::capture("console", Box::new(|_, _| {})));
        let vault: Arc<dyn VaultLock> = Arc::new(Mutex::new(MemVault::default()));
        Arc::new(ConsoleApi::open(None, logger, vault))
    }

    fn draft(org: &str) -> Draft {
        Draft {
            id: "d1".into(),
            org: org.into(),
            by: "ann@acme.example".into(),
            at: 0,
            changed: 0,
            base_seq: 0,
            base: json!({}),
            map: json!({}),
            changes: Vec::new(),
            untested: Default::default(),
            asked: None,
        }
    }

    /// `n` card keys drawn and sealed in the console's vault: their staged JWKs.
    fn keys(api: &ConsoleApi, org: &str, n: usize) -> Vec<Value> {
        let mut d = draft(org);
        (0..n).map(|_| stage_new_key(&mut d, &*api.vault(), org, NOW - 10).unwrap()).collect()
    }

    fn agent() -> Value {
        json!({"id": AGENT, "name": "Acme Build Agent",
               "description": "Runs build and test tasks on Acme's Remote Spokes after a person at Acme approves each task.",
               "version": "1.0.0", "connector": CONNECTOR, "hub": "c_9a8b7c6d5e4f3a2b",
               "provider": {"organization": "Acme Robotics", "url": "https://acme.example"},
               "documentation_url": "https://acme.example/agents/build", "streaming": true, "push": true,
               "skills": [{"id": "build-and-test", "name": "Build and test", "description": "Builds the named branch and runs its tests.",
                           "tags": ["build", "test"], "examples": ["Build branch release/2.3 and run the unit tests"],
                           "targets": ["n_a1b2c3d4e5f60718293a4b5c6d7e8f90"], "turns": "one", "approve_within_s": 3600},
                          {"id": "lint", "name": "Lint", "description": "Lints the named branch.", "tags": ["lint"],
                           "targets": ["n_a1b2c3d4e5f60718293a4b5c6d7e8f90"], "turns": "one", "approve_within_s": 3600}]})
    }

    fn partner(push_origin: &str) -> Value {
        json!({"id": PARTNER, "name": "partner-ci", "kind": "agent", "scopes": ["spokes.tasks.submit"],
               "a2a": {"agents": [AGENT], "skills": ["*"], "max_open_tasks": 8, "push": {"origins": [push_origin], "private_cidrs": []}},
               "card": {"url": PARTNER_CARD, "jwks_uri": PARTNER_JWKS, "private_cidrs": []}})
    }

    fn map(org: &str, seq: i64, jwks: &[Value], well_known: bool, clients: Value) -> Value {
        let mut a2a = json!({"jwks": jwks, "agents": [agent()]});
        if well_known {
            a2a["well_known"] = json!(AGENT);
        }
        json!({"v": 1, "org": org, "seq": seq, "issued": NOW - 10, "expires": NOW + 30 * DAY,
               "issuer": {"url": format!("https://console.acme.example:7443/api/orgs/{org}"), "jwks": []},
               "grace": {"person": 0, "app": 0, "connector": 0, "relay": 0}, "failover_after_s": 300, "folded": [], "cleared": [],
               "relay_origins": {}, "clients": clients,
               "connectors": [{"id": CONNECTOR, "name": "build", "origin": "https://conn.acme.example:8445"}],
               "a2a": a2a})
    }

    fn pin(api: &Arc<ConsoleApi>, m: Value) {
        let wire = json!({"map": m, "sig": "", "chain": []});
        let vm = VerifiedApiMap {
            org: m["org"].as_str().unwrap().into(),
            seq: m["seq"].as_i64().unwrap(),
            expires: m["expires"].as_i64().unwrap(),
            hash: api_map_hash(&wire["map"]),
            signer: "root".into(),
            wire: wire.as_object().unwrap().clone(),
        };
        api.publish_verified(None, vm, NOW).unwrap();
    }

    fn get(api: &ConsoleApi, audit: Option<&ApiAudit>, what: Publish<'_>, inm: Option<&str>, now: i64) -> Reply {
        publish(api, audit, what, inm, ip(), now).expect("a known org").1
    }

    fn served(r: &Reply) -> Value {
        serde_json::from_slice(&r.bytes()).unwrap()
    }

    fn header<'a>(r: &'a Reply, name: &str) -> Option<&'a str> {
        r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    fn signings(audit: &ApiAudit, org: &str) -> Vec<Value> {
        let page = audit.read(org, "console", Repr::AsIs, 0, 1000).unwrap();
        page["entries"].as_array().unwrap().iter().filter(|e| e["action"] == "a2a.card.signed").cloned().collect()
    }

    #[test]
    fn card_keys_are_drawn_sealed_and_staged_at_most_three() {
        let api = console();
        let mut d = draft("acme");
        let k = stage_new_key(&mut d, &*api.vault(), "acme", NOW).unwrap();
        let kid = k["kid"].as_str().unwrap().to_string();
        assert!(kid.starts_with("a2a-") && kid.len() == 12, "{kid}");
        assert_eq!((k["nbf"].as_i64(), k["exp"].as_i64(), k["alg"].as_str(), k["use"].as_str()), (Some(NOW), Some(NOW + KEY_DAYS * DAY), Some("ES256"), Some("sig")));
        assert!(k.get("d").is_none(), "the private key is never staged");
        assert_eq!(d.map["a2a"]["agents"], json!([]));
        assert_eq!(d.map["a2a"]["jwks"], json!([k.clone()]));
        assert!(d.changes.iter().any(|c| c.contains(&kid)));
        let pair = sealed_key(&*api.vault(), "acme", &kid).expect("sealed as api-a2a-card-<org>-<kid>");
        let mine = crate::api_issue::ec_public_jwk(&pair, &kid);
        assert_eq!((&mine["x"], &mine["y"]), (&k["x"], &k["y"]));
        assert_eq!(seal_name("acme", &kid), format!("api-a2a-card-acme-{kid}"));
        stage_new_key(&mut d, &*api.vault(), "acme", NOW).unwrap();
        stage_new_key(&mut d, &*api.vault(), "acme", NOW).unwrap();
        assert_eq!(stage_new_key(&mut d, &*api.vault(), "acme", NOW).unwrap_err().code, "invalid", "a fourth key is refused");
        // expired keys leave the draft first
        stage_new_key(&mut d, &*api.vault(), "acme", NOW + KEY_DAYS * DAY).unwrap();
        assert_eq!(d.map["a2a"]["jwks"].as_array().unwrap().len(), 1);
        // the views: sealed, active, with the RFC 7638 thumbprint
        let views = key_views(&api, "acme", &json!({"a2a": {"jwks": [k.clone()]}}), NOW);
        assert_eq!((views[0]["state"].as_str(), views[0]["sealed"].as_bool()), (Some("active"), Some(true)));
        assert_eq!(views[0]["thumbprint"], json!(a2a_card::thumbprint(&k)));
        assert_eq!(key_views(&api, "acme", &json!({"a2a": {"jwks": [k.clone()]}}), NOW - 1)[0]["state"], "pending");
        assert_eq!(key_views(&api, "beta", &json!({"a2a": {"jwks": [k]}}), NOW + KEY_DAYS * DAY)[0]["sealed"], false);
    }

    #[test]
    fn two_keys_sign_twice_and_a_drop_leaves_card_and_jwks_at_once() {
        let api = console();
        let audit = chains("two-keys");
        let ks = keys(&api, "acme", 2);
        pin(&api, map("acme", 1, &ks, false, json!([])));
        let r = get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW);
        assert_eq!((r.status, r.ctype), (200, "application/json"));
        let card = served(&r);
        let mut kids: Vec<String> = ks.iter().map(|k| k["kid"].as_str().unwrap().to_string()).collect();
        kids.sort();
        assert_eq!(card["signatures"].as_array().unwrap().len(), 2);
        let mut verified = a2a_card::verify(&card, &ks).unwrap();
        verified.sort();
        assert_eq!(verified, kids);
        let jwks = get(&api, Some(&audit), Publish::Jwks("acme"), None, NOW);
        assert_eq!((jwks.status, header(&jwks, "Cache-Control")), (200, Some("max-age=300")));
        assert_eq!(jwks.body["keys"].as_array().unwrap().len(), 2);
        assert!(jwks.body["keys"][0].get("nbf").is_none(), "public JWK fields only");
        // the drop is journaled at once: the next card and key set leave the key out
        let gone = kids[1].clone();
        let (entry, changed) = drop_key(&api, None, "acme", &gone, NOW).unwrap();
        assert_eq!((entry["action"].as_str(), entry["target"].as_str(), changed), (Some("a2a_key_drop"), Some(gone.as_str()), false));
        let card = served(&get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW));
        assert_eq!(card["signatures"].as_array().unwrap().len(), 1);
        assert_eq!(a2a_card::verify(&card, &ks).unwrap(), vec![kids[0].clone()]);
        let jwks = get(&api, Some(&audit), Publish::Jwks("acme"), None, NOW);
        let left: Vec<&str> = jwks.body["keys"].as_array().unwrap().iter().filter_map(|k| k["kid"].as_str()).collect();
        assert_eq!(left, vec![kids[0].as_str()]);
        assert_eq!(drop_key(&api, None, "acme", &gone, NOW).unwrap_err().code, "stale");
        assert_eq!(drop_key(&api, None, "acme", "a2a-nope", NOW).unwrap_err().code, "not-found");
        assert_eq!(key_views(&api, "acme", &api.pinned("acme").0.unwrap(), NOW).iter().filter(|v| v["state"] == "dropped").count(), 1);
        // a key only staged leaves the draft without a journal entry
        let mut d = draft("acme");
        let staged = stage_new_key(&mut d, &*api.vault(), "acme", NOW).unwrap();
        let (entry, changed) = drop_key(&api, Some(&mut d), "acme", staged["kid"].as_str().unwrap(), NOW).unwrap();
        assert_eq!((entry, changed), (Value::Null, true));
        assert!(d.map["a2a"].get("jwks").is_none(), "the last key takes the field with it (2.2: 1 to 3 keys)");
    }

    #[test]
    fn a_card_is_served_only_while_the_map_and_the_agent_are() {
        let api = console();
        let audit = chains("served");
        assert!(publish(&api, Some(&audit), Publish::Card("acme", AGENT), None, ip(), NOW).is_none(), "no pinned map");
        let ks = keys(&api, "acme", 1);
        pin(&api, map("acme", 1, &ks, false, json!([])));
        assert_eq!(get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW).status, 200);
        let list = get(&api, Some(&audit), Publish::Agents("acme"), None, NOW);
        assert_eq!(list.body["agents"], json!([{"id": AGENT, "name": "Acme Build Agent",
            "card": format!("https://console.acme.example:7443/api/orgs/acme/a2a/agents/{AGENT}/agent-card.json")}]));
        assert_eq!(code(&get(&api, Some(&audit), Publish::Card("acme", "a_0000000000000000"), None, NOW)), (404, "not-found".into()));
        assert!(publish(&api, Some(&audit), Publish::Card("beta", AGENT), None, ip(), NOW).is_none(), "an unpinned org");
        // expired
        assert_eq!(code(&get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW + 31 * DAY)), (404, "not-found".into()));
        assert_eq!(card_view(&api, Some(&audit), "acme", AGENT, NOW + 31 * DAY)["state"], "not-pinned");
        // agent_off
        api.append_console("acme", "agent_off", json!(AGENT), NOW).unwrap();
        assert_eq!(code(&get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW)), (404, "not-found".into()));
        assert_eq!(get(&api, Some(&audit), Publish::Agents("acme"), None, NOW).body["agents"], json!([]));
        assert_eq!(card_view(&api, Some(&audit), "acme", AGENT, NOW)["state"], "off");
        // api_off
        let api = console();
        let ks = keys(&api, "acme", 1);
        pin(&api, map("acme", 1, &ks, false, json!([])));
        api.append(None, "acme", "api_off", json!("acme"), None, NOW).unwrap();
        assert_eq!(code(&get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW)), (404, "not-found".into()));
        assert_eq!(code(&get(&api, Some(&audit), Publish::Jwks("acme"), None, NOW)), (404, "not-found".into()));
        assert_eq!(card_view(&api, Some(&audit), "acme", AGENT, NOW)["state"], "not-pinned");
    }

    fn code(r: &Reply) -> (u16, String) {
        (r.status, r.body["code"].as_str().unwrap_or_default().to_string())
    }

    #[test]
    fn without_a_usable_key_the_card_is_unsigned() {
        let api = console();
        let audit = chains("unsigned");
        // a listed key this console does not hold, and one past its window
        let other = console();
        let mut ks = keys(&other, "acme", 1);
        let mut old = keys(&api, "acme", 1).remove(0);
        old["exp"] = json!(NOW - 1);
        ks.push(old);
        pin(&api, map("acme", 1, &ks, false, json!([])));
        assert_eq!(code(&get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW)), (503, "card-unsigned".into()));
        assert_eq!(card_view(&api, Some(&audit), "acme", AGENT, NOW)["state"], "unsigned");
        assert_eq!(attention(&api, NOW), vec![("a2a-card-key-missing", json!({"org": "acme", "agent": AGENT}))]);
        assert!(signings(&audit, "acme").is_empty());
    }

    #[test]
    fn each_signing_is_audited_before_the_card_is_served() {
        let api = console();
        let ks = keys(&api, "acme", 1);
        pin(&api, map("acme", 1, &ks, false, json!([])));
        // the signing cannot be recorded: 503, and nothing is kept
        assert_eq!(code(&get(&api, None, Publish::Card("acme", AGENT), None, NOW)), (503, "audit-unavailable".into()));
        let audit = chains("audited");
        let r = get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW);
        assert_eq!(r.status, 200);
        let s = signings(&audit, "acme");
        assert_eq!(s.len(), 1);
        assert_eq!((s[0]["agent"].as_str(), s[0]["kid"].as_str(), s[0]["map_seq"].as_i64(), s[0]["result"].as_str()), (Some(AGENT), ks[0]["kid"].as_str(), Some(1), Some("ok")));
        assert_eq!(s[0]["card_sha256"].as_str(), Some(hex(&sha256(&r.bytes())).as_str()));
        // unchanged inputs: served again without a new signing
        get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW);
        assert_eq!(card_view(&api, Some(&audit), "acme", AGENT, NOW)["state"], "served");
        assert_eq!(signings(&audit, "acme").len(), 1);
        // a dropped skill signs again, without it
        api.append_console("acme", "agent_drop_skill", json!({"agent": AGENT, "skill": "lint"}), NOW).unwrap();
        let card = served(&get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW));
        assert_eq!(card["skills"].as_array().unwrap().len(), 1);
        assert_eq!(signings(&audit, "acme").len(), 2);
        // every skill dropped: no task can be accepted, so no card
        api.append_console("acme", "agent_drop_skill", json!({"agent": AGENT, "skill": "build-and-test"}), NOW).unwrap();
        assert_eq!(code(&get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW)), (404, "not-found".into()));
        assert_eq!(card_view(&api, Some(&audit), "acme", AGENT, NOW)["state"], "off");
        // a new map signs again
        let api = console();
        let ks = keys(&api, "acme", 1);
        pin(&api, map("acme", 1, &ks, false, json!([])));
        let audit = chains("audited-seq");
        get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW);
        pin(&api, map("acme", 2, &ks, false, json!([])));
        get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW);
        let seqs: Vec<i64> = signings(&audit, "acme").iter().filter_map(|e| e["map_seq"].as_i64()).collect();
        assert_eq!(seqs, vec![1, 2]);
    }

    #[test]
    fn a_card_carries_its_etag_and_answers_304() {
        let api = console();
        let audit = chains("etag");
        let ks = keys(&api, "acme", 1);
        pin(&api, map("acme", 1, &ks, false, json!([])));
        let r = get(&api, Some(&audit), Publish::Card("acme", AGENT), None, NOW);
        let etag = header(&r, "ETag").unwrap().to_string();
        assert_eq!(etag, a2a_card::etag(&served(&r)));
        assert_eq!(header(&r, "Cache-Control"), Some("max-age=300"));
        for inm in [etag.clone(), format!("W/{etag}"), format!("\"other\", {etag}"), "*".into()] {
            let r = get(&api, Some(&audit), Publish::Card("acme", AGENT), Some(&inm), NOW);
            assert_eq!((r.status, r.bytes().len(), header(&r, "ETag")), (304, 0, Some(etag.as_str())), "{inm}");
        }
        assert_eq!(get(&api, Some(&audit), Publish::Card("acme", AGENT), Some("\"other\""), NOW).status, 200);
    }

    #[test]
    fn the_root_well_known_card_needs_exactly_one_map_naming_one() {
        let api = console();
        let audit = chains("well-known");
        assert!(publish(&api, Some(&audit), Publish::WellKnown, None, ip(), NOW).is_none());
        let a = keys(&api, "acme", 1);
        let b = keys(&api, "beta", 1);
        pin(&api, map("acme", 1, &a, true, json!([])));
        pin(&api, map("beta", 1, &b, false, json!([])));
        let (org, r) = publish(&api, Some(&audit), Publish::WellKnown, None, ip(), NOW).unwrap();
        assert_eq!((org.as_str(), r.status), ("acme", 200));
        assert_eq!(served(&r)["name"], "Acme Build Agent");
        pin(&api, map("beta", 2, &b, true, json!([])));
        assert!(publish(&api, Some(&audit), Publish::WellKnown, None, ip(), NOW).is_none(), "two maps name one");
    }

    fn partner_card(pair: &EcdsaKeyPair, kid: &str, provider: &str) -> Value {
        let card = json!({"name": "Partner CI", "description": "Runs the partner's CI.",
                          "supportedInterfaces": [{"url": "https://ci.partner.example/a2a", "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0"}],
                          "provider": {"organization": "Partner", "url": provider}, "version": "2.0.0",
                          "capabilities": {"streaming": false}, "defaultInputModes": ["text/plain"], "defaultOutputModes": ["text/plain"],
                          "skills": [{"id": "ci", "name": "CI", "description": "Runs CI.", "tags": ["ci"]}]});
        // the card names its own key set; the console never follows it
        a2a_card::sign(&card, &[(kid, pair)], "https://evil.example/jwks.json").unwrap()
    }

    fn pair() -> EcdsaKeyPair {
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).unwrap();
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref()).unwrap()
    }

    fn serve_partner(api: &ConsoleApi, card: Value, jwks: Value) {
        api.a2a.set_fetch(Arc::new(move |url: &str, _: &[Cidr], _: usize| -> Result<Value, String> {
            match url {
                PARTNER_CARD => Ok(card.clone()),
                PARTNER_JWKS => Ok(jwks.clone()),
                _ => Err("not found".to_string()),
            }
        }));
    }

    #[test]
    fn partner_cards_verify_with_the_pinned_key_source_only_and_change_no_grant() {
        let api = console();
        let ks = keys(&api, "acme", 1);
        pin(&api, map("acme", 1, &ks, false, json!([partner("https://ci.partner.example")])));
        let p1 = pair();
        let jwks = json!({"keys": [a2a_card::public_jwk(&p1, "p1", NOW - 10, NOW + DAY)]});
        assert_eq!(partner_card_view(&api, "acme", PARTNER)["state"], "unchecked");
        serve_partner(&api, partner_card(&p1, "p1", "https://ci.partner.example"), jwks.clone());
        let v = card_check(&api, "acme", PARTNER, NOW).unwrap();
        assert_eq!((v["state"].as_str(), v["name"].as_str(), v["version"].as_str(), v["kids"].clone()), (Some("verified"), Some("Partner CI"), Some("2.0.0"), json!(["p1"])));
        assert_eq!(v["interfaces"], json!([{"url": "https://ci.partner.example/a2a", "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0"}]));
        assert_eq!(partner_card_view(&api, "acme", PARTNER), v);
        assert!(attention(&api, NOW).is_empty());
        // signed by a key not in card.jwks_uri: invalid, an attention item, and no grant changes
        let before = api.pinned("acme").0;
        serve_partner(&api, partner_card(&pair(), "p1", "https://ci.partner.example"), jwks.clone());
        let v = card_check(&api, "acme", PARTNER, NOW).unwrap();
        assert_eq!((v["state"].as_str(), v["name"].clone(), v["kids"].clone()), (Some("invalid"), Value::Null, json!([])));
        let why = v["why"].as_str().unwrap().to_string();
        assert_eq!(attention(&api, NOW), vec![("a2a-partner-card-invalid", json!({"org": "acme", "client": PARTNER, "why": why}))]);
        assert_eq!(api.pinned("acme").0, before);
        assert!(api.console_entries("acme").is_empty());
        // a provider URL outside the push origins
        serve_partner(&api, partner_card(&p1, "p1", "https://elsewhere.example"), jwks.clone());
        assert_eq!(card_check(&api, "acme", PARTNER, NOW).unwrap()["state"], "invalid");
        // a card that cannot be fetched
        api.a2a.set_fetch(Arc::new(|_: &str, _: &[Cidr], _: usize| -> Result<Value, String> { Err("address 10.0.0.5 is not allowed".to_string()) }));
        assert_eq!(card_check(&api, "acme", PARTNER, NOW).unwrap()["state"], "invalid");
        assert_eq!(card_check(&api, "acme", "c_ffffffffffffffff", NOW).unwrap_err().code, "not-found");
        // the tick checks again after 24 hours, on its own thread
        serve_partner(&api, partner_card(&p1, "p1", "https://ci.partner.example"), jwks);
        tick(&api, None, NOW + 60);
        assert_eq!(partner_card_view(&api, "acme", PARTNER)["state"], "invalid", "not due yet");
        tick(&api, None, NOW + CHECK_EVERY);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while partner_card_view(&api, "acme", PARTNER)["state"] != "verified" && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(partner_card_view(&api, "acme", PARTNER)["checked_at"], json!(NOW + CHECK_EVERY));
    }

    /// ReviewW6c: the tick runs at most CHECK_WORKERS partner card checks at once; the others stay due and a later
    /// tick takes them.
    #[test]
    fn the_tick_checks_at_most_four_partner_cards_at_once() {
        let api = console();
        let ks = keys(&api, "acme", 1);
        let clients: Vec<Value> = (0..6)
            .map(|i| {
                let mut c = partner("https://ci.partner.example");
                c["id"] = json!(format!("c_00000000000000a{i}"));
                c["name"] = json!(format!("partner-{i}"));
                c
            })
            .collect();
        pin(&api, map("acme", 1, &ks, false, json!(clients)));
        let gate = Arc::new((Mutex::new(false), parking_lot::Condvar::new()));
        let (running, peak) = (Arc::new(Mutex::new(0usize)), Arc::new(Mutex::new(0usize)));
        let (g, r, p) = (gate.clone(), running.clone(), peak.clone());
        api.a2a.set_fetch(Arc::new(move |_: &str, _: &[Cidr], _: usize| -> Result<Value, String> {
            {
                let mut n = r.lock();
                *n += 1;
                let mut top = p.lock();
                *top = (*top).max(*n);
            }
            let (open, cv) = &*g;
            let mut o = open.lock();
            while !*o {
                cv.wait(&mut o);
            }
            *r.lock() -= 1;
            Err("refused".to_string())
        }));
        tick(&api, None, NOW);
        assert_eq!(api.a2a.checking.lock().len(), CHECK_WORKERS, "four in flight");
        tick(&api, None, NOW + 60);
        assert_eq!(api.a2a.checking.lock().len(), CHECK_WORKERS, "no fifth while four run");
        {
            let (open, cv) = &*gate;
            *open.lock() = true;
            cv.notify_all();
        }
        let wait_idle = || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !api.a2a.checking.lock().is_empty() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        };
        wait_idle();
        let checked = |api: &Arc<ConsoleApi>| (0..6).filter(|i| partner_card_view(api, "acme", &format!("c_00000000000000a{i}"))["state"] != "unchecked").count();
        assert_eq!(checked(&api), CHECK_WORKERS);
        tick(&api, None, NOW + 120);
        wait_idle();
        assert_eq!(checked(&api), 6, "the rest on a later tick");
        assert!(*peak.lock() <= CHECK_WORKERS);
    }

    #[test]
    fn the_partner_fetch_takes_private_ranges_only_from_card_private_cidrs() {
        let api = console();
        let ks = keys(&api, "acme", 1);
        let mut c = partner("https://ci.partner.example");
        c["card"]["private_cidrs"] = json!(["10.40.0.0/23", "10.50.0.0/24"]);
        pin(&api, map("acme", 1, &ks, false, json!([c])));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        api.a2a.set_fetch(Arc::new(move |_: &str, within: &[Cidr], _: usize| -> Result<Value, String> {
            s.lock().push(within.to_vec());
            Err("refused".to_string())
        }));
        card_check(&api, "acme", PARTNER, NOW).unwrap();
        assert_eq!(seen.lock().last().unwrap().len(), 2);
        // a narrowed list (ReviewW6c): only the pinned ranges inside `keep` stay, at once
        api.append_console("acme", "card_private_off", json!({"client": PARTNER, "keep": ["10.40.0.0/16"]}), NOW).unwrap();
        card_check(&api, "acme", PARTNER, NOW).unwrap();
        assert_eq!(seen.lock().last().unwrap(), &vec![crate::console_source::parse_cidr("10.40.0.0/23").unwrap()]);
        api.append_console("acme", "card_private_off", json!(PARTNER), NOW).unwrap();
        card_check(&api, "acme", PARTNER, NOW).unwrap();
        assert!(seen.lock().last().unwrap().is_empty(), "card_private_off empties the ranges");
    }

    #[test]
    fn the_card_routes_are_front_door_rows() {
        use crate::api_resource::{route_of, RouteId, Side};
        let id = |path: &str| route_of(Side::FrontDoor, "GET", path).map(|m| (m.route.id, m.org.to_string(), m.id.map(str::to_string)));
        assert_eq!(id("/api/orgs/acme/a2a/agents"), Some((RouteId::A2aAgents, "acme".into(), None)));
        assert_eq!(id(&format!("/api/orgs/acme/a2a/agents/{AGENT}/agent-card.json")), Some((RouteId::A2aCard, "acme".into(), Some(AGENT.into()))));
        assert_eq!(id("/api/orgs/acme/a2a/jwks.json"), Some((RouteId::A2aJwks, "acme".into(), None)));
        for path in ["/api/orgs/acme/a2a/agents", "/api/orgs/acme/a2a/jwks.json"] {
            assert!(route_of(Side::FrontDoor, "POST", path).is_none());
            assert!(route_of(Side::Relay, "GET", path).is_none());
        }
        for r in crate::api_resource::ROUTES.iter().filter(|r| matches!(r.id, RouteId::A2aAgents | RouteId::A2aCard | RouteId::A2aJwks)) {
            assert_eq!((r.side, r.pipeline, r.class, r.scope), (Side::FrontDoor, crate::api_resource::Pipeline::Public, "public", ""));
        }
        assert!(id("/api/orgs/acme/a2a/agents//agent-card.json").is_none());
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("console_a2a.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
