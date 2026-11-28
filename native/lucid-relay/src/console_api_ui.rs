// Contract API-1 (docs/api/contract.md) 2.3, 2.5, 4, 6.2, 6.6, 7.3, 11 and 12.3, slice 1a6: the rules of the console's
// Settings > API access and Settings > Exports screens, without any I/O. Per org one staged draft of the next api map
// (memory only, 2 hours after its last change, as the AI screen's stages), every staging route's change to it, the
// tightenings a route journals at once, the two-person rule of 6.6 with its reasons, the change sentences, the
// destinations a save still needs a passing test for, `lcs_` client secrets and `lme_` scrape tokens (32 random
// bytes, only the SHA-256 and the hint kept), the final map a save asks a device to sign (with the journal ids it
// folds or clears), the explain tool in the order of 6.2 (on the same check code the API uses), the screens' views
// (credentials as hints, never a secret) and the signing record of a save (`meet.api.sign` on a relay, polled).
//
// console_fleet.rs runs the routes: it reads the console's pinned maps and journal (`ConsoleApi`), journals through
// `ConsoleApi::append` before answering, and asks the relay for the signature over the fleet channel.

use crate::api_cjournal::ConsoleEntry;
use crate::api_map::{self, TightenEntry, CEILINGS, GRACE_KINDS, GRACE_MAX_HOURS, IDENTITIES};
use crate::codec::{b64u, sha256_hex};
use crate::console::ApiError;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

// ── words (console words of slice 1a6) ──────────────────────────────────────────────────────────────────────────

pub const STAGE_MOVED: &str = "Nothing was changed: the API map changed since these settings were staged.";
pub const STAGE_GONE: &str = "These API settings are no longer staged. Review them again.";
pub const STAGE_CHANGED: &str = "Nothing was changed: these API settings changed after the save was asked for. Save them again.";
pub const SIGNING_BUSY: &str = "A save of this organization's API settings is still waiting for its signature. Cancel it first.";
pub const SIGN_CANCELED: &str = "Canceled";
pub const SIGN_PUBLISHING: &str = "Nothing was changed: the signed map is being published now.";
pub const SIGN_LOST: &str = "The relay's answer to the signing request was lost. Save again.";
pub const SIGNING_UNSAVED: &str = "Nothing was changed: the console could not record the save. See its log.";
pub const NO_SIGNING: &str = "Nothing was changed: no save of this organization is waiting for its signature.";
pub const NO_CLIENT: &str = "There is no such API client.";
pub const NO_DESTINATION: &str = "There is no such export destination.";
pub const NO_SCRAPE_TOKEN: &str = "There is no such scrape token.";
pub const NO_TIGHTENING: &str = "There is no such tightening in force.";
pub const DENY_FOREVER: &str = "A revoked token or scrape token stays revoked. Make a new one instead.";
pub const SECRET_ROUTE: &str = "Client secrets are made with Make secret, which shows the secret once.";
pub const TESTS_NEEDED: &str = "Send a test record through each new or changed destination before saving.";
pub const NO_RELAY: &str = "No connected relay serves this organization, so no device can be asked to sign.";
pub const RELAY_TOO_OLD: &str = "This relay is too old to ask a device to sign API settings. Update it, or choose another relay.";
pub const SIGN_TIMEOUT: &str = "The signing request was not answered within 24 hours.";
pub const SIGN_GONE: &str = "The signing request was cancelled or expired on the relay.";
pub const SIGN_OTHER_MAP: &str = "The signed API map is not the one this save asked for.";
pub const NO_CA: &str = "This console holds no usable Meeting Hub organization CA to check the signed API map against. Import it first.";
pub const NO_SIGNER_POLICY: &str = "The relay sent no signer policy with the signed API map.";
pub const SIEM_NO_CERT: &str = "The SIEM export has no client certificate and key to copy.";
pub const NOT_RESOURCE_ROUTE: &str = "Explain covers the API resource routes, and that method and path is not one of them.";
pub const API_OFF_ALREADY: &str = "Nothing was changed: the API is already off for this organization.";
pub const API_ON_ALREADY: &str = "Nothing was changed: the API is not off for this organization.";
pub const NOTHING_STAGED: &str = "Nothing was changed: nothing is staged for this organization.";
// API-1 revision 4 13.1: the export recipient key
pub const RECIPIENT_ONE: &str = "Give the recipient key either as a JWK or as a PEM public key.";
pub const RECIPIENT_KEY: &str = "The recipient key must be an EC P-256 public key.";
pub const RECIPIENT_PRIVATE: &str = "That is a private key. Give the recipient's public key only.";
pub const RECIPIENT_WAS_DROPPED: &str = "That recipient key was dropped. Give the client a new key.";
pub const NO_RECIPIENT: &str = "This API client has no export recipient key in the signed API map.";
pub const RECIPIENT_DROPPED: &str = "Nothing was changed: that recipient key is already dropped.";

// ── 6.6: why a save needs a second admin ────────────────────────────────────────────────────────────────────────

pub const TWO_AUDIT: &str = "Gives a client audit.read with a confidential or cui ceiling";
pub const TWO_DEST_AUDIT: &str = "Sends audit records to a destination";
pub const TWO_DEST_AS_IS: &str = "Sends identities as they are to a destination";
pub const TWO_FAILOVER: &str = "Turns on failover for a destination";
pub const TWO_PRIVATE: &str = "Lets a fetch or a destination reach a private address";
pub const TWO_GRACE: &str = "Raises a grace value";
pub const TWO_SECRET: &str = "Adds a client secret";
pub const TWO_SCRAPE: &str = "Adds a scrape token for relays";
pub const TWO_CLEARED: &str = "Undoes a tightening";
// API-1 revision 4 13.3
pub const TWO_COMPLIANCE: &str = "Adds or widens a client with a compliance scope";
pub const TWO_RECIPIENT: &str = "Sets or changes the key compliance exports are sealed to";
pub const TWO_DIRECTORY: &str = "Adds or widens a client that writes the directory";
/// API-1 revision 8 3: presence.write lets an outside system change what everyone sees about a person.
pub const TWO_PRESENCE: &str = "Adds or widens a client that sets people's presence";
pub const TWO_EVENTS_SENSITIVE: &str = "Sends events to a destination for a compliance or directory client";
pub const TWO_WEBHOOK_WEAK: &str = "Turns off webhook verification or signs webhooks with v1";
// API-1 revision 5 13.2 (slice 1c3)
pub const TWO_UNDENY: &str = "Lets a person a client denied delegate to it again";
pub const TWO_LOOPBACK: &str = "Lets a delegated client use loopback redirects without a key";
pub const TWO_IDP_PRIVATE: &str = "Lets an identity provider's discovery reach a private address";
// API-1 revision 5 13.2 (slice 1c7)
pub const TWO_CONTENT: &str = "Adds or widens a client that reads or posts conversations, or acts for people";
pub const TWO_CONNECTOR: &str = "Adds a connector, an app to a connector, wider connector networks or a longer stale time";
pub const TWO_IDP: &str = "Adds or widens an identity provider for enterprise-managed sign-in";
// API-1d 13
pub const TWO_SPOKES_BIND: &str = "Binds a spokes relay to the organization or sets its Remote Spokes root";
pub const TWO_A2A_CLIENT: &str = "Adds a service hub client, gives a client spokes.tasks.submit, or widens such a client";
pub const TWO_A2A_PRIVATE: &str = "Lets pushes or partner card fetches reach private addresses";
pub const TWO_A2A_AGENT: &str = "Adds an agent, a skill or a target, or allows a longer approval wait";
pub const TWO_WELL_KNOWN: &str = "Publishes an agent at this console's root well-known address";

/// The tightenings whose undoing (`cleared`) is a two-person save (6.6). Every console journal (`k_`) id is too
/// (revision 5 13.2, API-1d 13: the A2A actions of API-1d 2.3 live there); `client_drop_target` is a relay journal
/// action (API-1d 2.3, 13).
const UNDO_TWO: [&str; 10] = [
    "client_drop_target",
    "api_off",
    "client_suspend",
    "client_lower_ceiling",
    "destination_suspend",
    "destination_delete",
    "destination_disable_failover",
    "destination_drop_signal",
    "destination_lower_ceiling",
    "destination_identities",
];

// ── limits ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// A draft lives 2 hours after its last change.
pub const DRAFT_MS: i64 = 2 * 3_600_000;
/// 2.2.
pub const CLIENTS_MAX: usize = 500;
pub const CLIENTS_STANDARD: usize = 5;
pub const DESTINATIONS_MAX: usize = 32;
pub const SCRAPE_TOKENS_MAX: usize = 10;
const CREDENTIALS_MAX: usize = 4;
/// 2.2 `expires - issued`, and how long a signed map lasts unless the draft says less.
pub const MAP_DAYS: i64 = 90;
/// A signing request is given up after 24 hours.
pub const SIGN_WAIT_MS: i64 = 24 * 3_600_000;
/// The journal entries the API access screen lists.
pub const JOURNAL_SHOWN: usize = 50;
const DAY: i64 = 86_400;
/// The console's issuer key is listed for a year from the save that adds it (2.2: at most 400 days).
const ISSUER_KEY_DAYS: i64 = 365;
/// 11.6 queue defaults.
const QUEUE_DEFAULT: (i64, i64) = (1 << 30, 259_200);
pub const SECRET_PREFIX: &str = "lcs_";
pub const SCRAPE_PREFIX: &str = "lme_";

pub(crate) fn invalid(words: impl Into<String>) -> ApiError {
    ApiError::with("invalid", words)
}

pub(crate) fn not_found(words: &str) -> ApiError {
    ApiError::with("not-found", words)
}

pub(crate) fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

pub(crate) fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

pub(crate) fn list_mut<'a>(map: &'a mut Value, k: &str) -> &'a mut Vec<Value> {
    if !map.get(k).is_some_and(Value::is_array) {
        map[k] = json!([]);
    }
    map[k].as_array_mut().expect("an array")
}

pub(crate) fn find<'a>(map: &'a Value, list: &str, id: &str) -> Option<&'a Value> {
    map.get(list).and_then(Value::as_array).into_iter().flatten().find(|x| s(x, "id") == id)
}

fn rank(set: &[&str], v: &str) -> Option<usize> {
    set.iter().position(|x| *x == v)
}

/// `<prefix>` and 16 lowercase hex from 8 random bytes.
pub fn new_id(prefix: &str, random: &[u8; 8]) -> String {
    format!("{prefix}{}", crate::codec::hex(random))
}

// ── secrets (4.2, 4.4) ──────────────────────────────────────────────────────────────────────────────────────────

/// A secret shown once: the text, its SHA-256 (hex, of the whole text) and its hint (the first 8 hex of that).
pub struct Minted {
    pub secret: String,
    pub sha256: String,
    pub hint: String,
}

/// `lcs_` or `lme_` and the base64url of 32 random bytes.
pub fn mint(prefix: &str, random: &[u8; 32]) -> Minted {
    let secret = format!("{prefix}{}", b64u(random));
    let sha256 = sha256_hex(secret.as_bytes());
    let hint = sha256[..8].to_string();
    Minted { secret, sha256, hint }
}

// ── the draft ───────────────────────────────────────────────────────────────────────────────────────────────────

/// What a new draft is built on: the org, the admin, the console's pinned map (`map` object) and its seq.
pub struct Ctx<'a> {
    pub org: &'a str,
    pub by: &'a str,
    pub pinned: Option<&'a Value>,
    pub pinned_seq: i64,
}

/// A tightening a staging route journals at once (2.5), before it answers.
#[derive(Clone, Debug, PartialEq)]
pub struct Tighten {
    pub action: &'static str,
    pub target: Value,
    pub until: Option<i64>,
}

pub(crate) fn tighten(action: &'static str, target: Value) -> Tighten {
    Tighten { action, target, until: None }
}

/// The staged next map of one org.
#[derive(Clone, Debug)]
pub struct Draft {
    pub id: String,
    pub org: String,
    /// The admin who staged first.
    pub by: String,
    /// First staged and last changed (ms).
    pub at: i64,
    pub changed: i64,
    /// The pinned map's seq this was built on (0: none).
    pub base_seq: i64,
    /// The pinned map it was built on (a fresh skeleton for an org without one).
    pub base: Value,
    /// The draft map (seq, issued, expires, issuer and folded are the save's).
    pub map: Value,
    pub changes: Vec<String>,
    /// Destinations added or changed (endpoint, kind, preset, credential) and not tested since.
    pub untested: BTreeSet<String>,
    /// The hash of the final map a save asked to sign (6.6: what a second admin approves); any later change of the
    /// draft clears it, so the save is refused.
    pub asked: Option<String>,
}

/// A map with nothing in it (an org's first draft).
pub fn skeleton(org: &str) -> Value {
    json!({"v": 1, "org": org, "seq": 0, "issued": 0, "expires": 0, "issuer": {"url": "", "jwks": []},
           "grace": {"person": 0, "app": 0, "connector": 0, "relay": 0}, "failover_after_s": 300,
           "folded": [], "cleared": [], "relay_origins": {}, "clients": [], "scrape_tokens": [], "destinations": []})
}

impl Draft {
    pub fn new(cx: &Ctx, id: String, t: i64) -> Draft {
        let base = cx.pinned.cloned().unwrap_or_else(|| skeleton(cx.org));
        Draft { id, org: cx.org.into(), by: cx.by.into(), at: t, changed: t, base_seq: cx.pinned_seq, map: base.clone(), base, changes: Vec::new(), untested: BTreeSet::new(), asked: None }
    }

    pub(crate) fn note(&mut self, change: String) {
        if !self.changes.contains(&change) {
            self.changes.push(change);
        }
    }

    /// The destinations the save still needs a passing test for, sorted.
    pub fn tests_needed(&self) -> Vec<String> {
        self.untested.iter().filter(|id| find(&self.map, "destinations", id).is_some()).cloned().collect()
    }

    /// The `staged` answer shape (7.3 as fixed for 1a6).
    pub fn view(&self, active: &[TightenEntry]) -> Value {
        let reasons = two_person(&self.base, &self.map, active);
        json!({"id": self.id, "org": self.org, "by": self.by, "at": self.at, "expires_at": self.changed + DRAFT_MS,
               "base_seq": self.base_seq, "changes": self.changes, "two_person": !reasons.is_empty(),
               "two_person_reasons": reasons, "tests_needed": self.tests_needed()})
    }
}

/// The staged drafts of this console, one per org (memory only: a restart drops them).
#[derive(Default)]
pub struct Drafts {
    by_org: BTreeMap<String, Draft>,
}

impl Drafts {
    fn sweep(&mut self, t: i64) {
        self.by_org.retain(|_, d| t - d.changed < DRAFT_MS);
    }

    pub fn get(&mut self, org: &str, t: i64) -> Option<&Draft> {
        self.sweep(t);
        self.by_org.get(org)
    }

    pub fn orgs(&mut self, t: i64) -> Vec<String> {
        self.sweep(t);
        self.by_org.keys().cloned().collect()
    }

    /// Keep `d` as the org's draft, changed at `t`: a save asked before the change no longer applies.
    pub fn put(&mut self, mut d: Draft, t: i64) {
        d.changed = t;
        d.asked = None;
        self.by_org.insert(d.org.clone(), d);
    }

    pub fn discard(&mut self, org: &str) -> bool {
        self.by_org.remove(org).is_some()
    }

    /// A save of the draft `id` asks for the final map with this hash (`take` signs only that one).
    pub fn ask(&mut self, org: &str, id: &str, sha: &str) -> Result<(), ApiError> {
        let d = self.by_org.get_mut(org).filter(|d| d.id == id).ok_or_else(|| ApiError::with("gone", STAGE_GONE))?;
        d.asked = Some(sha.to_string());
        Ok(())
    }

    /// Take the draft `id` of `org` for the save of the final map `sha`: gone when expired or replaced; stale (and
    /// dropped) when the pinned map moved on since it was staged; changed when the draft changed after the save
    /// was asked (what a second admin approved is no longer what it holds).
    pub fn take(&mut self, org: &str, id: &str, sha: &str, pinned_seq: i64, t: i64) -> Result<Draft, ApiError> {
        self.sweep(t);
        if self.by_org.get(org).is_none_or(|d| d.id != id) {
            return Err(ApiError::with("gone", STAGE_GONE));
        }
        if self.by_org.get(org).is_some_and(|d| d.asked.as_deref() != Some(sha)) {
            return Err(ApiError::with("stale", STAGE_CHANGED));
        }
        let d = self.by_org.remove(org).expect("the draft");
        if d.base_seq != pinned_seq {
            return Err(ApiError::with("stale", STAGE_MOVED));
        }
        Ok(d)
    }

    /// A destination tested with a pass: the draft no longer needs a test for it.
    pub fn tested(&mut self, org: &str, id: &str) {
        if let Some(d) = self.by_org.get_mut(org) {
            d.untested.remove(id);
        }
    }
}

// ── clients (4.1, 4.2) ──────────────────────────────────────────────────────────────────────────────────────────

/// Revision 4 13.1 adds `reach` and the `compliance` and `directory` blocks (and `entra_wif` credentials).
/// API-1d 2.2 adds `spokes` (`{targets}` of a `spokes_hub` client). Revision 5 3.2 adds the content and delegation
/// fields (`connectors`, `apps`, `channels`, `confirm`, `delegation`, `redirect_uris`, `loopback_ok`). API-1d 2.2
/// adds `a2a` and `card` of an `agent` client.
const CLIENT_BODY: [&str; 26] = [
    "a2a",
    "card",
    "name",
    "kind",
    "owner",
    "principal",
    "reach",
    "scopes",
    "ceiling",
    "relays",
    "networks",
    "hours",
    "mtls_required",
    "rate",
    "credentials",
    "days",
    "compliance",
    "directory",
    "spokes",
    "connectors",
    "apps",
    "channels",
    "confirm",
    "delegation",
    "redirect_uris",
    "loopback_ok",
];
/// The blocks `null` removes from a client (a map holds no null); revision 5 3.2's fields are absent for the kinds
/// and reaches that take none.
const CLIENT_NULLABLE: [&str; 12] = ["a2a", "card", "hours", "compliance", "directory", "connectors", "apps", "channels", "confirm", "delegation", "redirect_uris", "loopback_ok"];

/// The map fields a client body gives (4.1), checked for shape only: `check_api_map` judges the values. A
/// `client_secret` credential is refused here (`clients/secret` makes one).
fn client_fields(body: &Value, now: i64) -> Result<Map<String, Value>, ApiError> {
    let o = body.as_object().ok_or_else(|| invalid("client is an object."))?;
    let mut out = Map::new();
    for (k, v) in o {
        if !CLIENT_BODY.contains(&k.as_str()) {
            return Err(invalid(format!("Unknown client field: {k}.")));
        }
        match k.as_str() {
            "days" => {
                let days = v.as_i64().filter(|d| (1..=366).contains(d)).ok_or_else(|| invalid("days is 1 to 366."))?;
                out.insert("created".into(), json!(now));
                out.insert("expires".into(), json!(now + days * DAY));
            }
            "credentials" => {
                let creds = v.as_array().ok_or_else(|| invalid("credentials is a list."))?;
                if creds.iter().any(|c| s(c, "type") == "client_secret") {
                    return Err(invalid(SECRET_ROUTE));
                }
                out.insert(k.clone(), v.clone());
            }
            "owner" | "principal" => {
                out.insert(k.clone(), json!(v.as_str().unwrap_or_default().trim().to_lowercase()));
            }
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(out)
}

/// `<name>@apps.<the owner's domain>` (2.2), when the body names no principal.
fn principal_of(c: &Value) -> String {
    let domain = s(c, "owner").rsplit_once('@').map(|(_, d)| d.to_string()).unwrap_or_default();
    format!("{}@apps.{domain}", s(c, "name"))
}

fn client_name(d: &Draft, id: &str) -> String {
    find(&d.map, "clients", id).map(|c| s(c, "name").to_string()).unwrap_or_else(|| id.to_string())
}

/// `POST settings/api/clients`: a new client (a widening, staged). `id` is the new `c_` id.
pub fn add_client(d: &mut Draft, body: &Value, id: String, now: i64) -> Result<(), ApiError> {
    let f = client_fields(body, now)?;
    for k in ["name", "kind", "owner", "scopes", "ceiling", "relays", "mtls_required", "rate", "credentials"] {
        if !f.contains_key(k) {
            return Err(invalid(format!("A new client needs {k}.")));
        }
    }
    if !f.contains_key("expires") {
        return Err(invalid("A new client needs days."));
    }
    let clients = d.map.get("clients").and_then(Value::as_array).cloned().unwrap_or_default();
    if clients.len() >= CLIENTS_MAX {
        return Err(invalid("An organization has at most 500 API clients."));
    }
    let name = f.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    if clients.iter().any(|c| s(c, "name") == name) {
        return Err(invalid(format!("A client is already named {name}.")));
    }
    let mut f = f;
    for k in CLIENT_NULLABLE {
        if f.get(k).is_some_and(Value::is_null) {
            f.remove(k);
        }
    }
    let mut c = Value::Object(f);
    c["id"] = json!(id);
    if c.get("reach").is_none() {
        c["reach"] = json!("R0");
    }
    c["state"] = json!("active");
    if c.get("networks").is_none() {
        c["networks"] = json!([]);
    }
    if c.get("principal").is_none_or(|p| p.as_str().is_none_or(str::is_empty)) {
        c["principal"] = json!(principal_of(&c));
    }
    list_mut(&mut d.map, "clients").push(c);
    d.note(format!("Add client {name}"));
    Ok(())
}

/// `POST settings/api/clients/update`: any of the client fields; what it removes from the pinned client (a scope, a
/// relay, a credential, a lower ceiling) is journaled at once, and the whole change is staged. A client secret the
/// client holds stays (it is not in the body).
pub fn update_client(d: &mut Draft, id: &str, body: &Value, pinned: Option<&Value>, now: i64) -> Result<Vec<Tighten>, ApiError> {
    let f = client_fields(body, now)?;
    let cur = find(&d.map, "clients", id).cloned().ok_or_else(|| not_found(NO_CLIENT))?;
    let mut c = cur.clone();
    for (k, v) in f {
        match (k.as_str(), v) {
            // `hours: null` lifts the time window, `compliance: null` and `directory: null` remove the block (a map
            // holds no null)
            (k, Value::Null) if CLIENT_NULLABLE.contains(&k) => {
                if let Some(o) = c.as_object_mut() {
                    o.remove(k);
                }
            }
            (k, v) => c[k] = v,
        }
    }
    if body.get("credentials").is_some() {
        let kept: Vec<Value> = cur.get("credentials").and_then(Value::as_array).into_iter().flatten().filter(|cr| s(cr, "type") == "client_secret").cloned().collect();
        list_mut(&mut c, "credentials").extend(kept);
    }
    // revision 5 4.1: a `cimd` credential is only for `agent_delegated`; another kind leaves it (the credential diff
    // below journals its `client_drop_credential` when pinned), and keeps every other credential as it was
    if s(&c, "kind") != "agent_delegated" {
        if let Some(creds) = c.get_mut("credentials").and_then(Value::as_array_mut) {
            creds.retain(|cr| s(cr, "type") != "cimd");
        }
    }
    if body.get("name").is_some() && body.get("principal").is_none() {
        c["principal"] = json!(principal_of(&c));
    }
    let name = s(&c, "name").to_string();
    if s(&cur, "name") != name && d.map.get("clients").and_then(Value::as_array).into_iter().flatten().any(|x| s(x, "name") == name) {
        return Err(invalid(format!("A client is already named {name}.")));
    }
    let mut out = Vec::new();
    if let Some(p) = pinned.and_then(|m| find(m, "clients", id)) {
        let (now_scopes, now_relays) = (strs(c.get("scopes")), strs(c.get("relays")));
        for scope in strs(p.get("scopes")).into_iter().filter(|x| !now_scopes.contains(x)) {
            out.push(tighten("client_drop_scope", json!({"client": id, "scope": scope})));
        }
        let was_relays = strs(p.get("relays"));
        if !now_relays.iter().any(|r| r == "*") {
            for relay in was_relays.iter().filter(|r| *r != "*" && !now_relays.contains(r)) {
                out.push(tighten("client_drop_relay", json!({"client": id, "relay": relay})));
            }
        }
        // 2.5 `client_limit`: `*` narrowed to a list, networks narrowed (also from any source to some), rates lowered
        let mut limit = Map::new();
        if was_relays.iter().any(|r| r == "*") && !now_relays.is_empty() && !now_relays.iter().any(|r| r == "*") {
            limit.insert("relays".into(), json!(now_relays));
        }
        let (was_nets, now_nets) = (strs(p.get("networks")), strs(c.get("networks")));
        // narrowed: from any source to some, or a pinned network no new one covers
        let uncovered = was_nets.iter().any(|w| !now_nets.iter().any(|n| api_map::cidr_within(w, n)));
        if !now_nets.is_empty() && (was_nets.is_empty() || uncovered) {
            limit.insert("networks".into(), json!(now_nets));
        }
        let mut rate = Map::new();
        for k in ["per_minute_each", "per_day_each"] {
            let v = |x: &Value| x.get("rate").and_then(|r| r.get(k)).and_then(Value::as_i64);
            if let (Some(was), Some(is)) = (v(p), v(&c)) {
                if is < was {
                    rate.insert(k.into(), json!(is));
                }
            }
        }
        if !rate.is_empty() {
            limit.insert("rate".into(), Value::Object(rate));
        }
        if !limit.is_empty() {
            limit.insert("client".into(), json!(id));
            out.push(tighten("client_limit", Value::Object(limit)));
        }
        if let (Some(was), Some(is)) = (rank(&CEILINGS, s(p, "ceiling")), rank(&CEILINGS, s(&c, "ceiling"))) {
            if is < was {
                out.push(tighten("client_lower_ceiling", json!({"client": id, "ceiling": s(&c, "ceiling")})));
            }
        }
        let creds = |v: &Value| v.get("credentials").and_then(Value::as_array).cloned().unwrap_or_default();
        let now_creds = creds(&c);
        for cr in creds(p) {
            if now_creds.contains(&cr) {
                continue;
            }
            // API-1d 4.2: a `spokes_node` credential is dropped by its certificate serial as `kid`
            let kid = if s(&cr, "type") == "spokes_node" { cr.get("serial") } else { cr.get("kid") };
            match kid.and_then(Value::as_str) {
                Some(kid) => out.push(tighten("client_drop_credential", json!({"client": id, "kid": kid}))),
                // by type only when no credential of that type stays
                None if !now_creds.iter().any(|x| s(x, "type") == s(&cr, "type")) => out.push(tighten("client_drop_credential", json!({"client": id, "type": s(&cr, "type")}))),
                None => {}
            }
        }
        out.extend(target_drops(id, p, &c));
        // revision 5 4.2 (R5-6, R5-7): the content and delegation narrowings
        out.extend(crate::console_api_1c::client_narrowings(id, p, &c));
        // API-1d 2.3: the A2A narrowings (agents, skills, open tasks, push, private CIDRs)
        out.extend(crate::console_api_1d::client_narrowings(id, p, &c, pinned.unwrap_or(&Value::Null)));
    }
    *find_mut(&mut d.map, "clients", id).expect("the client") = c;
    d.note(format!("Change client {name}"));
    Ok(out)
}

/// API-1d 4.2: how a new `spokes_node` credential is given.
pub const SPOKES_PASTE: &str = "A spokes_node credential is the service hub's pasted certificate, {type, cert, key_store}: its node, serial, spki and expires are read from the certificate.";

/// The credentials of a client in the draft (none when there is no such client), as they are before a change.
pub fn client_credentials(d: &Draft, id: &str) -> Vec<Value> {
    find(&d.map, "clients", id).and_then(|c| c.get("credentials")).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// API-1d 4.2: whether the draft's client `id` holds a pasted service hub certificate still to be checked.
pub fn pastes_spokes_cert(d: &Draft, id: &str) -> bool {
    client_credentials(d, id).iter().any(|cr| s(cr, "type") == "spokes_node" && cr.get("cert").is_some())
}

/// API-1d 4.2, after `add_client` or `update_client`: the client's `spokes_node` credentials as staged. One it held
/// before the change (`held`) stays as it is; any other must be `{type, cert, key_store}`, the service hub's pasted
/// node certificate token, checked by `api_spokes_cred::credential_of` against `trust` (the console's Remote Spokes
/// root, which must be the draft's `spokes.root`, with the CRL its spokes relays hold) and the client's ceiling, and
/// replaced by the credential filled from it. A credential given with its fields (`node`, `serial`, `spki`,
/// `expires`) is refused.
pub fn spokes_credentials(d: &mut Draft, id: &str, held: &[Value], trust: Option<&crate::identity::TrustStore>, now: i64) -> Result<(), ApiError> {
    let root = d.map.pointer("/spokes/root").and_then(Value::as_str).map(str::to_owned);
    let Some(c) = find_mut(&mut d.map, "clients", id) else { return Ok(()) };
    let ceiling = s(c, "ceiling").to_string();
    let Some(list) = c.get_mut("credentials").and_then(Value::as_array_mut) else { return Ok(()) };
    for cr in list.iter_mut().filter(|cr| s(cr, "type") == "spokes_node") {
        if held.contains(cr) {
            continue;
        }
        let pasted = cr.as_object().is_some_and(|o| o.contains_key("cert") && o.keys().all(|k| matches!(k.as_str(), "type" | "cert" | "key_store")));
        if !pasted {
            return Err(invalid(SPOKES_PASTE));
        }
        let trust = trust.ok_or_else(|| invalid("The service hub certificate cannot be checked: this console holds no Remote Spokes root and CRL."))?;
        if root.as_deref() != Some(trust.root_id.as_str()) {
            return Err(invalid("The service hub certificate cannot be checked: bind a spokes relay first, so this organization's spokes.root is this console's Remote Spokes root."));
        }
        *cr = crate::api_spokes_cred::credential_of(s(cr, "cert"), trust, &ceiling, s(cr, "key_store"), now).map_err(|(code, why)| invalid(spokes_refusal(code, &why)))?;
    }
    Ok(())
}

/// The words of a refused service hub certificate: plain sentences, never the refusal code.
pub const SPOKES_CERT_UNTRUSTED: &str = "The service hub certificate was refused: it is not signed by this console's Remote Spokes root, or it expired or was revoked.";

fn spokes_refusal(code: &str, why: &str) -> String {
    if code == "client-auth" && why.contains("does not verify") {
        return SPOKES_CERT_UNTRUSTED.to_string();
    }
    format!("The service hub certificate was refused: {why}.")
}

pub(crate) fn find_mut<'a>(map: &'a mut Value, list: &str, id: &str) -> Option<&'a mut Value> {
    map.get_mut(list)?.as_array_mut()?.iter_mut().find(|x| s(x, "id") == id)
}

/// `POST settings/api/clients/suspend`: journaled at once (when the client is pinned) and staged.
pub fn suspend_client(d: &mut Draft, id: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let name = client_name(d, id);
    let c = find_mut(&mut d.map, "clients", id).ok_or_else(|| not_found(NO_CLIENT))?;
    c["state"] = json!("suspended");
    d.note(format!("Suspend client {name}"));
    Ok(pinned.and_then(|m| find(m, "clients", id)).map(|_| tighten("client_suspend", json!(id))).into_iter().collect())
}

/// `POST settings/api/clients/resume`: a widening: the client active again and every journaled suspension of it
/// cleared.
pub fn resume_client(d: &mut Draft, id: &str, active: &[TightenEntry]) -> Result<(), ApiError> {
    let name = client_name(d, id);
    let c = find_mut(&mut d.map, "clients", id).ok_or_else(|| not_found(NO_CLIENT))?;
    c["state"] = json!("active");
    for e in active.iter().filter(|e| e.action == "client_suspend" && e.target.as_str() == Some(id)) {
        add_cleared(d, &e.id);
    }
    d.note(format!("Resume client {name}"));
    Ok(())
}

/// `POST settings/api/clients/delete`: the client suspended at once (2.5 has no other client removal) and removed
/// from the draft; the next map folds the suspension.
pub fn delete_client(d: &mut Draft, id: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let name = client_name(d, id);
    let clients = list_mut(&mut d.map, "clients");
    let before = clients.len();
    clients.retain(|c| s(c, "id") != id);
    if clients.len() == before {
        return Err(not_found(NO_CLIENT));
    }
    d.note(format!("Delete client {name}"));
    Ok(pinned.and_then(|m| find(m, "clients", id)).map(|_| tighten("client_suspend", json!(id))).into_iter().collect())
}

/// `POST settings/api/clients/secret {days}`: a new `client_secret` credential (1 to 90 days) replacing the client's
/// current one; the secret is in the answer only.
pub fn client_secret(d: &mut Draft, id: &str, days: i64, minted: &Minted, now: i64) -> Result<(), ApiError> {
    if !(1..=90).contains(&days) {
        return Err(invalid("A client secret lasts 1 to 90 days."));
    }
    let name = client_name(d, id);
    let c = find_mut(&mut d.map, "clients", id).ok_or_else(|| not_found(NO_CLIENT))?;
    let creds = list_mut(c, "credentials");
    creds.retain(|cr| s(cr, "type") != "client_secret");
    if creds.len() >= CREDENTIALS_MAX {
        return Err(invalid("A client holds at most 4 credentials."));
    }
    creds.push(json!({"type": "client_secret", "sha256": minted.sha256, "hint": minted.hint, "expires": now + days * DAY}));
    d.note(format!("Add a client secret to {name}"));
    Ok(())
}

// ── compliance clients (revision 4 2.2, 2.4, 13.1) ──────────────────────────────────────────────────────────────

/// The caps of a client's `compliance` block (2.2), each lowered at once by `client_lower_caps` (2.4).
pub const CAPS: [&str; 4] = ["holds_per_day", "job_max_bytes", "day_max_bytes", "jobs_per_day"];

/// 2.2 `compliance.recipient.kid`: `[A-Za-z0-9._-]{1,64}`.
fn recipient_kid_ok(k: &str) -> bool {
    (1..=64).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Revision 4 2.2 `compliance.recipient`: the key exports are sealed to, from a public EC P-256 JWK (`d` refused) or
/// a P-256 SubjectPublicKeyInfo PEM (exactly one `PUBLIC KEY` block, its DER canonical). Ok is its `kid` (the JWK's
/// own when it fits `[A-Za-z0-9._-]{1,64}`, else `rcpt-` and the first 16 characters of the thumbprint), the map's
/// JWK `{kty, crv, x, y}` and its RFC 7638 thumbprint.
pub fn recipient_of(jwk: Option<&Value>, pem: Option<&str>) -> Result<(String, Value, String), ApiError> {
    let (point, given) = match (jwk.filter(|j| !j.is_null()), pem.map(str::trim).filter(|p| !p.is_empty())) {
        (Some(j), None) => {
            let o = j.as_object().ok_or_else(|| invalid(RECIPIENT_KEY))?;
            if o.contains_key("d") {
                return Err(invalid(RECIPIENT_PRIVATE));
            }
            let Some(crate::api_token::PublicKey::Ec { x, y }) = crate::api_token::parse_jwk(j, 2048) else { return Err(invalid(RECIPIENT_KEY)) };
            let mut point = [4u8; 65];
            point[1..33].copy_from_slice(&x);
            point[33..].copy_from_slice(&y);
            (point, o.get("kid").and_then(Value::as_str).filter(|k| recipient_kid_ok(k)).map(str::to_string))
        }
        (None, Some(p)) => {
            if p.contains("PRIVATE KEY") {
                return Err(invalid(RECIPIENT_PRIVATE));
            }
            let blocks = crate::der::pem_blocks(p, "PUBLIC KEY");
            let [der] = blocks.as_slice() else { return Err(invalid(RECIPIENT_KEY)) };
            let k = crate::der::p256_from_spki(der).filter(|k| crate::der::p256_spki_der(k) == *der).ok_or_else(|| invalid(RECIPIENT_KEY))?;
            (*k.point(), None)
        }
        _ => return Err(invalid(RECIPIENT_ONE)),
    };
    // a point on P-256 (a JWK is read without that check)
    if crate::der::P256Key::from_sec1(&point).is_none() {
        return Err(invalid(RECIPIENT_KEY));
    }
    let (mut x, mut y) = ([0u8; 32], [0u8; 32]);
    x.copy_from_slice(&point[1..33]);
    y.copy_from_slice(&point[33..]);
    let jwk = json!({"kty": "EC", "crv": "P-256", "x": b64u(&x), "y": b64u(&y)});
    let jkt = crate::api_token::jwk_thumbprint(&crate::api_token::PublicKey::Ec { x, y });
    let kid = given.unwrap_or_else(|| format!("rcpt-{}", &jkt[..16]));
    Ok((kid, jwk, jkt))
}

/// `POST settings/api/clients/recipient`: the client's `compliance.recipient` staged (a two-person save, 13.3).
pub fn set_recipient(d: &mut Draft, id: &str, kid: &str, jwk: Value) -> Result<(), ApiError> {
    let name = client_name(d, id);
    let c = find_mut(&mut d.map, "clients", id).ok_or_else(|| not_found(NO_CLIENT))?;
    if !c.get("compliance").is_some_and(Value::is_object) {
        c["compliance"] = json!({});
    }
    c["compliance"]["recipient"] = json!({"kid": kid, "jwk": jwk});
    d.note(format!("Set the export recipient key of client {name} to {kid}"));
    Ok(())
}

/// `POST settings/api/clients/caps {caps}`: any of the four caps staged on the client's `compliance` block
/// (`check_api_map` judges the values). Ok is the `client_lower_caps` target of the caps below the pinned client's
/// (journaled at once, 2.4), None when none is lowered.
pub fn set_caps(d: &mut Draft, id: &str, caps: &Value, pinned: Option<&Value>) -> Result<Option<Value>, ApiError> {
    let o = caps.as_object().filter(|o| !o.is_empty()).ok_or_else(|| invalid("caps is an object of holds_per_day, job_max_bytes, day_max_bytes or jobs_per_day."))?;
    let mut given = Vec::new();
    for (k, v) in o {
        if !CAPS.contains(&k.as_str()) {
            return Err(invalid(format!("Unknown cap: {k}.")));
        }
        let n = v.as_i64().filter(|n| *n >= 0).ok_or_else(|| invalid(format!("{k} is a whole number.")))?;
        given.push((k.clone(), n));
    }
    let name = client_name(d, id);
    let c = find_mut(&mut d.map, "clients", id).ok_or_else(|| not_found(NO_CLIENT))?;
    if !c.get("compliance").is_some_and(Value::is_object) {
        c["compliance"] = json!({});
    }
    for (k, n) in &given {
        c["compliance"][k.as_str()] = json!(n);
    }
    let was = pinned.and_then(|m| find(m, "clients", id)).and_then(|p| p.get("compliance"));
    let mut lowered = Map::new();
    for (k, n) in given {
        if was.and_then(|w| w.get(&k)).and_then(Value::as_i64).is_some_and(|w| n < w) {
            lowered.insert(k, json!(n));
        }
    }
    d.note(format!("Change the compliance caps of client {name}"));
    if lowered.is_empty() {
        return Ok(None);
    }
    lowered.insert("client".into(), json!(id));
    Ok(Some(Value::Object(lowered)))
}

/// The pinned client's recipient `kid` (what `client_drop_recipient` names).
pub fn recipient_kid(pinned: Option<&Value>, id: &str) -> Option<String> {
    pinned.and_then(|m| find(m, "clients", id)).and_then(|c| c.pointer("/compliance/recipient/kid")).and_then(Value::as_str).map(str::to_string)
}

/// `POST settings/api/clients/recipient/drop`: the dropped recipient `kid` leaves the client in the draft when it is
/// staged there; true when the draft changed.
pub fn drop_recipient(d: &mut Draft, id: &str, kid: &str) -> bool {
    let name = client_name(d, id);
    let Some(block) = find_mut(&mut d.map, "clients", id).and_then(|c| c.get_mut("compliance")).and_then(Value::as_object_mut) else { return false };
    if block.get("recipient").and_then(|r| r.get("kid")).and_then(Value::as_str) != Some(kid) {
        return false;
    }
    block.remove("recipient");
    d.note(format!("Drop the export recipient key {kid} of client {name}"));
    true
}

// ── scrape tokens (4.4) ─────────────────────────────────────────────────────────────────────────────────────────

/// `POST settings/api/scrape-tokens {action: "create"}`: a relay scrape token (30 to 90 days), staged.
pub fn add_scrape_token(d: &mut Draft, label: &str, relays: &Value, days: i64, minted: &Minted, now: i64) -> Result<(), ApiError> {
    if !(30..=90).contains(&days) {
        return Err(invalid("A scrape token lasts 30 to 90 days."));
    }
    let label = crate::console_auth::clean(label);
    if label.is_empty() || label.chars().count() > 64 {
        return Err(invalid("Give the token a label of 1 to 64 characters."));
    }
    let tokens = list_mut(&mut d.map, "scrape_tokens");
    if tokens.len() >= SCRAPE_TOKENS_MAX {
        return Err(invalid("An organization has at most 10 scrape tokens for relays."));
    }
    tokens.push(json!({"sha256": minted.sha256, "hint": minted.hint, "label": label, "relays": relays, "expires": now + days * DAY}));
    d.note(format!("Add scrape token {label}"));
    Ok(())
}

/// `POST settings/api/scrape-tokens {action: "delete", hint}`: removed from the draft; a pinned one is journaled
/// `scrape_deny` at once.
pub fn delete_scrape_token(d: &mut Draft, hint: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let held = |m: &Value| m.get("scrape_tokens").and_then(Value::as_array).into_iter().flatten().find(|x| s(x, "hint") == hint).cloned();
    let token = held(&d.map).or_else(|| pinned.and_then(held)).ok_or_else(|| not_found(NO_SCRAPE_TOKEN))?;
    list_mut(&mut d.map, "scrape_tokens").retain(|x| s(x, "hint") != hint);
    d.note(format!("Remove scrape token {}", s(&token, "label")));
    let sha = s(&token, "sha256").to_string();
    Ok(pinned.and_then(held).map(|_| tighten("scrape_deny", json!(sha))).into_iter().collect())
}

// ── grace, on and off, undoing, origins (2.5, 3) ────────────────────────────────────────────────────────────────

/// `POST settings/api/grace {grace}`: each given kind 0 to 168 hours; a raise is staged (two-person), a lowering
/// below the pinned value is journaled `grace_lower` at once and staged.
pub fn set_grace(d: &mut Draft, grace: &Value, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let g = grace.as_object().filter(|g| !g.is_empty()).ok_or_else(|| invalid("grace gives hours for person, app, connector or relay."))?;
    let mut out = Vec::new();
    for (k, v) in g {
        let kind = GRACE_KINDS.iter().copied().find(|x| *x == k.as_str()).ok_or_else(|| invalid(format!("Unknown grace kind: {k}.")))?;
        let hours = v.as_i64().filter(|h| (0..=GRACE_MAX_HOURS).contains(h)).ok_or_else(|| invalid("A grace is 0 to 168 hours."))?;
        let was = d.map.pointer(&format!("/grace/{kind}")).and_then(Value::as_i64).unwrap_or(0);
        if hours == was {
            continue;
        }
        let pinned_h = pinned.and_then(|m| m.pointer(&format!("/grace/{kind}"))).and_then(Value::as_i64);
        if pinned_h.is_some_and(|p| hours < p) {
            out.push(tighten("grace_lower", json!({"kind": kind, "hours": hours})));
        }
        d.map["grace"][kind] = json!(hours);
        let verb = if hours > was { "Raise" } else { "Lower" };
        d.note(format!("{verb} {kind} grace to {hours} hours"));
    }
    Ok(out)
}

pub(crate) fn add_cleared(d: &mut Draft, id: &str) {
    let cleared = list_mut(&mut d.map, "cleared");
    if !cleared.iter().any(|x| x.as_str() == Some(id)) {
        cleared.push(json!(id));
    }
}

/// `POST settings/api/on`: the active `api_off` cleared (a two-person widening).
pub fn turn_on(d: &mut Draft, active: &[TightenEntry]) -> Result<(), ApiError> {
    let off: Vec<String> = active.iter().filter(|e| e.action == "api_off").map(|e| e.id.clone()).collect();
    if off.is_empty() {
        return Err(ApiError::with("stale", API_ON_ALREADY));
    }
    for id in off {
        add_cleared(d, &id);
    }
    d.note("Turn the API back on".to_string());
    Ok(())
}

/// `POST settings/api/resume {tightening}`: an active journal entry cleared (never a `token_deny` or `scrape_deny`).
pub fn undo(d: &mut Draft, id: &str, active: &[TightenEntry]) -> Result<(), ApiError> {
    let e = active.iter().find(|e| e.id == id).ok_or_else(|| not_found(NO_TIGHTENING))?;
    if matches!(e.action.as_str(), "token_deny" | "scrape_deny") {
        return Err(invalid(DENY_FOREVER));
    }
    add_cleared(d, id);
    d.note(format!("Undo {} ({id})", e.action.replace('_', " ")));
    Ok(())
}

/// `POST settings/api/relay-origins {relay, origin}`: a relay's canonical API origin, or "" to remove it.
pub fn set_relay_origin(d: &mut Draft, relay: &str, origin: &str) -> Result<(), ApiError> {
    if relay.is_empty() || relay == "console" || relay.len() > 64 {
        return Err(invalid("relay is a relay id."));
    }
    if !d.map.get("relay_origins").is_some_and(Value::is_object) {
        d.map["relay_origins"] = json!({});
    }
    let origins = d.map["relay_origins"].as_object_mut().expect("an object");
    if origin.is_empty() {
        if origins.remove(relay).is_none() {
            return Err(ApiError::with("stale", "Nothing was changed: that relay has no API origin."));
        }
        d.note(format!("Remove the API origin of relay {relay}"));
    } else {
        origins.insert(relay.to_string(), json!(origin.trim_end_matches('/')));
        d.note(format!("Set the API origin of relay {relay} to {origin}"));
    }
    Ok(())
}

// ── Remote Spokes (API-1d 2.3, 5.1) ─────────────────────────────────────────────────────────────────────────────

/// API-1d 2.2 `spokes.relays`: 0 to 64 relay ids.
const SPOKES_RELAYS_MAX: usize = 64;

/// API-1d 2.3: what narrowing a pinned `spokes_hub` client's `spokes.targets` journals at once: `client_drop_target
/// {client, spoke}` per spoke the new list drops (`ConsoleApi::append` journals the revision 3 fallback,
/// `client_suspend` of the client, while the `spokes` feature is closed for the org). `*` narrowed to a list drops
/// every spoke outside it, which no entry can name, so the client is suspended (2.3's fallback, as strict); resuming
/// it is the two-person undo of revision 3. Nothing for any other kind or a widening.
fn target_drops(id: &str, pinned: &Value, now: &Value) -> Vec<Tighten> {
    if s(pinned, "kind") != "spokes_hub" {
        return Vec::new();
    }
    let targets = |c: &Value| strs(c.get("spokes").and_then(|x| x.get("targets")));
    let (was, is) = (targets(pinned), targets(now));
    if is.iter().any(|t| t == "*") {
        return Vec::new();
    }
    if was.iter().any(|t| t == "*") {
        return vec![tighten("client_suspend", json!(id))];
    }
    was.iter().filter(|t| !is.contains(t)).map(|spoke| tighten("client_drop_target", json!({"client": id, "spoke": spoke}))).collect()
}

/// API-1d 5.1 `POST settings/api/spokes/bind` and `unbind {org, relay}`: the spokes relay's id staged into (a widening,
/// signed by the save) or out of the draft's `spokes.relays` (unbinding journals nothing; the console's bound record
/// and `api-orgs` carry it at once, `ConsoleApi::spokes_bind`). A draft without `spokes` takes `root`: the console's
/// Remote Spokes root (its node id and the SHA-256 hex of its public key), which a first bind needs.
pub fn stage_spokes_relay(d: &mut Draft, relay: &str, bound: bool, root: Option<(&str, &str)>) -> Result<(), ApiError> {
    if !crate::fleet_metrics::relay_id_ok(relay) {
        return Err(invalid("relay is a relay id."));
    }
    if !d.map.get("spokes").is_some_and(Value::is_object) {
        if !bound {
            return Err(ApiError::with("stale", "Nothing was changed: that relay is not bound to this organization."));
        }
        let (id, spki) = root.ok_or_else(|| invalid("Set the Remote Spokes root of this console first."))?;
        d.map["spokes"] = json!({"root": id, "root_spki": spki, "relays": []});
    }
    let relays = list_mut(&mut d.map["spokes"], "relays");
    let listed = relays.iter().any(|r| r.as_str() == Some(relay));
    match (bound, listed) {
        (true, true) | (false, false) => return Ok(()),
        (true, false) => {
            if relays.len() >= SPOKES_RELAYS_MAX {
                return Err(invalid("An organization binds at most 64 spokes relays."));
            }
            relays.push(json!(relay));
            d.note(format!("Bind spokes relay {relay}"));
        }
        (false, true) => {
            relays.retain(|r| r.as_str() != Some(relay));
            d.note(format!("Unbind spokes relay {relay}"));
        }
    }
    Ok(())
}

// ── destinations (11) ───────────────────────────────────────────────────────────────────────────────────────────

const DEST_BODY: [&str; 12] = ["name", "kind", "preset", "signals", "ceiling", "identities", "failover", "private_ok", "endpoint", "settings", "credential", "queue"];
/// 11.3: the public fields of a credential type the map names.
fn credential_fields(ty: &str) -> &'static [&'static str] {
    match ty {
        "entra_certificate" => &["tenant", "client_id", "cloud"],
        "aws_roles_anywhere" => &["trust_anchor_arn", "profile_arn", "role_arn", "region"],
        _ => &[],
    }
}

/// The map's `credential` of a destination: `{type, ref: secret:<id>, ...public fields}`; a federated credential
/// (revision 4 2.2, 8) has no sealed part, so it is its public fields alone (`service_account` only when given), and
/// a webhook's `none` (revision 4 2.2) is its type alone.
fn credential_entry(id: &str, body: &Value) -> Result<Value, ApiError> {
    let ty = body.get("type").and_then(Value::as_str).ok_or_else(|| invalid("credential needs a type."))?;
    if ty == "none" {
        return Ok(json!({"type": "none"}));
    }
    let federated: &[&str] = match ty {
        "entra_federated" => &["tenant", "client_id", "cloud", "audience"],
        "gcp_federated" => &["audience", "token_audience"],
        _ => &[],
    };
    if !federated.is_empty() {
        let mut c = json!({"type": ty});
        for f in federated {
            c[*f] = json!(s(body, f));
        }
        if let Some(sa) = body.get("service_account").and_then(Value::as_str).filter(|_| ty == "gcp_federated") {
            c["service_account"] = json!(sa);
        }
        return Ok(c);
    }
    let mut c = json!({"type": ty, "ref": format!("secret:{id}")});
    for f in credential_fields(ty) {
        c[*f] = json!(s(body, f));
    }
    Ok(c)
}

fn dest_fields(id: &str, body: &Value) -> Result<Map<String, Value>, ApiError> {
    let o = body.as_object().ok_or_else(|| invalid("destination is an object."))?;
    let mut out = Map::new();
    for (k, v) in o {
        if !DEST_BODY.contains(&k.as_str()) {
            return Err(invalid(format!("Unknown destination field: {k}.")));
        }
        let v = if k == "credential" { credential_entry(id, v)? } else { v.clone() };
        out.insert(k.clone(), v);
    }
    Ok(out)
}

fn dest_name(d: &Draft, id: &str) -> String {
    find(&d.map, "destinations", id).map(|x| s(x, "name").to_string()).unwrap_or_else(|| id.to_string())
}

/// `POST settings/exports/destinations`: a new destination (staged, tested before the save). `id` is the new `d_` id.
pub fn add_destination(d: &mut Draft, body: &Value, id: String) -> Result<(), ApiError> {
    let f = dest_fields(&id, body)?;
    for k in ["name", "kind", "preset", "signals", "ceiling", "identities", "credential"] {
        if !f.contains_key(k) {
            return Err(invalid(format!("A new destination needs {k}.")));
        }
    }
    let list = d.map.get("destinations").and_then(Value::as_array).cloned().unwrap_or_default();
    if list.len() >= DESTINATIONS_MAX {
        return Err(invalid("An organization has at most 32 destinations."));
    }
    let mut x = Value::Object(f);
    x["id"] = json!(id);
    for (k, v) in [("failover", json!(false)), ("private_ok", json!(false)), ("queue", json!({"max_bytes": QUEUE_DEFAULT.0, "max_age_s": QUEUE_DEFAULT.1}))] {
        if x.get(k).is_none() {
            x[k] = v;
        }
    }
    let name = s(&x, "name").to_string();
    if list.iter().any(|y| s(y, "name") == name) {
        return Err(invalid(format!("A destination is already named {name}.")));
    }
    list_mut(&mut d.map, "destinations").push(x);
    d.untested.insert(id);
    d.note(format!("Add destination {name}"));
    Ok(())
}

/// `{org, from_siem: true}`: a `syslog_cef` destination from the console's SIEM settings (11.1), its mTLS key and
/// certificate to be sealed as its credential by the caller.
pub fn siem_destination(d: &mut Draft, siem: &Value, id: String) -> Result<(), ApiError> {
    let mut settings = Map::new();
    for k in ["host", "port", "caPem", "clientCertPem", "events", "includeReasons"] {
        if let Some(v) = siem.get(k).filter(|v| !v.is_null()) {
            settings.insert(k.into(), v.clone());
        }
    }
    // today's SIEM export reaches private hosts, so the destination may too (a two-person save, 6.6)
    let body = json!({"name": "SIEM (syslog)", "kind": "syslog_cef", "preset": "syslog_cef", "signals": ["audit", "logs"], "ceiling": "confidential",
                      "identities": "as_is", "private_ok": true, "settings": settings, "credential": {"type": "mtls"}});
    add_destination(d, &body, id)
}

/// `POST settings/exports/destinations/update`: the given fields; what it removes from the pinned destination (a
/// signal, failover, a lower ceiling, stricter identities) is journaled at once. A new endpoint, kind, preset or
/// credential type needs a passing test again.
pub fn update_destination(d: &mut Draft, id: &str, body: &Value, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let f = dest_fields(id, body)?;
    let cur = find(&d.map, "destinations", id).cloned().ok_or_else(|| not_found(NO_DESTINATION))?;
    let mut x = cur.clone();
    for (k, v) in f {
        x[k.as_str()] = v;
    }
    let name = s(&x, "name").to_string();
    // any change of the credential's map entry (its type, or a federated credential's public fields) needs a test
    if ["endpoint", "kind", "preset", "credential"].iter().any(|k| x.get(*k) != cur.get(*k)) {
        d.untested.insert(id.to_string());
    }
    let mut out = Vec::new();
    if let Some(p) = pinned.and_then(|m| find(m, "destinations", id)) {
        let now_signals = strs(x.get("signals"));
        for signal in strs(p.get("signals")).into_iter().filter(|x| !now_signals.contains(x)) {
            out.push(tighten("destination_drop_signal", json!({"destination": id, "signal": signal})));
        }
        if let (Some(was), Some(is)) = (rank(&CEILINGS, s(p, "ceiling")), rank(&CEILINGS, s(&x, "ceiling"))) {
            if is < was {
                out.push(tighten("destination_lower_ceiling", json!({"destination": id, "ceiling": s(&x, "ceiling")})));
            }
        }
        if let (Some(was), Some(is)) = (rank(&IDENTITIES, s(p, "identities")), rank(&IDENTITIES, s(&x, "identities"))) {
            if is > was {
                out.push(tighten("destination_identities", json!({"destination": id, "identities": s(&x, "identities")})));
            }
        }
        if p.get("failover") == Some(&json!(true)) && x.get("failover") != Some(&json!(true)) {
            out.push(tighten("destination_disable_failover", json!(id)));
        }
    }
    *find_mut(&mut d.map, "destinations", id).expect("the destination") = x;
    d.note(format!("Change destination {name}"));
    Ok(out)
}

/// `POST settings/exports/destinations/delete`: removed from the draft; a pinned one is journaled
/// `destination_delete` at once (its queues and failover credentials go with it on every relay, 12.3).
pub fn delete_destination(d: &mut Draft, id: &str, pinned: Option<&Value>) -> Result<Vec<Tighten>, ApiError> {
    let name = dest_name(d, id);
    let list = list_mut(&mut d.map, "destinations");
    let before = list.len();
    list.retain(|x| s(x, "id") != id);
    if list.len() == before {
        return Err(not_found(NO_DESTINATION));
    }
    d.untested.remove(id);
    d.note(format!("Delete destination {name}"));
    Ok(pinned.and_then(|m| find(m, "destinations", id)).map(|_| tighten("destination_delete", json!(id))).into_iter().collect())
}

/// A credential entered for a staged destination: the map entry takes its public fields (11.3: tenant, client id
/// and cloud; the AWS ARNs and region) and the next save needs a passing test again. False when the destination is
/// not in the draft.
pub fn credential_entered(d: &mut Draft, id: &str, material: &Value) -> bool {
    let Some(x) = find_mut(&mut d.map, "destinations", id) else { return false };
    let ty = x.pointer("/credential/type").and_then(Value::as_str).unwrap_or_default().to_string();
    for f in credential_fields(&ty) {
        if let Some(v) = material.get(*f).and_then(Value::as_str) {
            x["credential"][*f] = json!(v);
        }
    }
    d.untested.insert(id.to_string());
    true
}

/// The destination entry a test or a credential concerns: the draft's when staged, else the pinned map's.
pub fn destination_of(draft: Option<&Draft>, pinned: Option<&Value>, id: &str) -> Option<(Value, bool)> {
    draft.and_then(|d| find(&d.map, "destinations", id)).map(|x| (x.clone(), true)).or_else(|| pinned.and_then(|m| find(m, "destinations", id)).map(|x| (x.clone(), false)))
}

/// The one `exports.test` record (11.2 shapes) sent through a destination, as the signal it carries first.
pub fn test_batch(destination: &Value, org: &str, rid: &str, t_ms: i64) -> crate::api_export_wire::Batch {
    use crate::api_export_wire::Signal;
    let signals = strs(destination.get("signals"));
    let event_id = format!("exports.test:{rid}");
    let log = json!({"t_ms": t_ms, "severity": 9, "event": "exports.test", "body": {"org": org, "destination": s(destination, "id")},
                     "attributes": {"lucid.action": "exports.test", "lucid.org": org, "lucid.event_id": event_id}});
    let (signal, record) = if signals.iter().any(|x| x == "logs") {
        (Signal::Logs, log)
    } else if signals.iter().any(|x| x == "audit") {
        (Signal::Audit, log)
    } else if signals.iter().any(|x| x == "traces") {
        let trace = sha256_hex(rid.as_bytes());
        (Signal::Traces, json!({"trace_id": &trace[..32], "span_id": &trace[32..48], "name": "exports.test", "start_ms": t_ms, "end_ms": t_ms, "status": "ok", "attributes": {"lucid.event_id": event_id}}))
    } else {
        (Signal::Metrics, json!({"name": "lucid.exports.test", "prom": "lucid_exports_test", "kind": "gauge", "unit": "1", "temporality": "cumulative", "points": [{"t_ms": t_ms, "v": 1, "labels": {"org": org}}]}))
    };
    crate::api_export_wire::Batch { signal, resource: vec![("lucid.org".into(), org.into()), ("service.name".into(), "lucid-console".into())], records: vec![record] }
}

// ── 6.6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

pub(crate) fn by_id(map: &Value, list: &str) -> BTreeMap<String, Value> {
    map.get(list).and_then(Value::as_array).into_iter().flatten().map(|x| (s(x, "id").to_string(), x.clone())).collect()
}

pub(crate) fn is_true(v: Option<&Value>) -> bool {
    v == Some(&Value::Bool(true))
}

/// Contract 6.6: the reasons a save of `draft` over `base` (the pinned map) needs a second admin before
/// `meet.api.sign` is sent; none means step-up only. `active` names the journal entries `cleared` undoes.
pub fn two_person(base: &Value, draft: &Value, active: &[TightenEntry]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    let mut add = |r: &'static str| {
        if !out.contains(&r) {
            out.push(r);
        }
    };
    let (old_clients, old_dests) = (by_id(base, "clients"), by_id(base, "destinations"));
    // an active client with audit.read at confidential or cui: a suspended one (its suspension folded into the map,
    // and perhaps pruned from the journal) made active again widens to it as much as a new one
    let audit_wide = |c: &Value| s(c, "state") == "active" && strs(c.get("scopes")).iter().any(|x| x == "audit.read") && rank(&CEILINGS, s(c, "ceiling")).is_some_and(|r| r >= 2);
    for (id, c) in by_id(draft, "clients") {
        let old = old_clients.get(&id);
        if audit_wide(&c) && !old.is_some_and(audit_wide) {
            add(TWO_AUDIT);
        }
        let old_creds: Vec<Value> = old.and_then(|o| o.get("credentials")).and_then(Value::as_array).cloned().unwrap_or_default();
        for cr in c.get("credentials").and_then(Value::as_array).into_iter().flatten() {
            if old_creds.contains(cr) {
                continue;
            }
            if s(cr, "type") == "client_secret" {
                add(TWO_SECRET);
            }
            if is_true(cr.get("private_ok")) {
                add(TWO_PRIVATE);
            }
        }
    }
    for (id, x) in by_id(draft, "destinations") {
        let old = old_dests.get(&id);
        let audit = |v: &Value| strs(v.get("signals")).iter().any(|x| x == "audit");
        if audit(&x) && !old.is_some_and(audit) {
            add(TWO_DEST_AUDIT);
        }
        if s(&x, "identities") == "as_is" && old.is_none_or(|o| s(o, "identities") != "as_is") {
            add(TWO_DEST_AS_IS);
        }
        if is_true(x.get("failover")) && !old.is_some_and(|o| is_true(o.get("failover"))) {
            add(TWO_FAILOVER);
        }
        if is_true(x.get("private_ok")) && !old.is_some_and(|o| is_true(o.get("private_ok"))) {
            add(TWO_PRIVATE);
        }
    }
    for k in GRACE_KINDS {
        let h = |m: &Value| m.pointer(&format!("/grace/{k}")).and_then(Value::as_i64).unwrap_or(0);
        if h(draft) > h(base) {
            add(TWO_GRACE);
        }
    }
    let old_tokens: Vec<&str> = base.get("scrape_tokens").and_then(Value::as_array).into_iter().flatten().map(|t| s(t, "sha256")).collect();
    if draft.get("scrape_tokens").and_then(Value::as_array).into_iter().flatten().any(|t| !old_tokens.contains(&s(t, "sha256"))) {
        add(TWO_SCRAPE);
    }
    let old_cleared = strs(base.get("cleared"));
    for id in strs(draft.get("cleared")).into_iter().filter(|i| !old_cleared.contains(i)) {
        // revision 4 13.3 and revision 5 13.2: clearing any console journal (`k_`) id is two-person
        if active.iter().any(|e| e.id == id && UNDO_TWO.contains(&e.action.as_str())) || id.starts_with("k_") {
            add(TWO_CLEARED);
        }
    }
    // revision 4 13.3
    let has_scope = |c: &Value, prefix: &str| strs(c.get("scopes")).iter().any(|x| x.starts_with(prefix));
    let new_clients = by_id(draft, "clients");
    for (id, c) in &new_clients {
        let old = old_clients.get(id);
        if has_scope(c, "compliance.") && client_widens(old, c) {
            add(TWO_COMPLIANCE);
        }
        if strs(c.get("scopes")).iter().any(|x| x == "directory.write") && client_widens(old, c) {
            add(TWO_DIRECTORY);
        }
        // API-1 revision 8 3: presence.write added or widened (presence.read is step-up only)
        if strs(c.get("scopes")).iter().any(|x| x == "presence.write") && client_widens(old, c) {
            add(TWO_PRESENCE);
        }
        if c.pointer("/compliance/recipient").is_some_and(|r| old.and_then(|o| o.pointer("/compliance/recipient")) != Some(r)) {
            add(TWO_RECIPIENT);
        }
    }
    for (id, x) in by_id(draft, "destinations") {
        let old = old_dests.get(&id);
        let events_client = |d: &Value| d.get("settings").and_then(|s| s.get("client").or_else(|| s.get("events_client"))).and_then(Value::as_str).map(str::to_string);
        let carries = |d: &Value| strs(d.get("signals")).iter().any(|s| s == "events");
        let sensitive = events_client(&x).and_then(|cid| new_clients.get(&cid).cloned()).is_some_and(|c| has_scope(&c, "compliance.") || has_scope(&c, "directory."));
        let repointed = old.is_some_and(|o| carries(o) && events_client(o) != events_client(&x));
        if carries(&x) && sensitive && (dest_widens(old, &x) || repointed) {
            add(TWO_EVENTS_SENSITIVE);
        }
        if s(&x, "kind") == "webhook" {
            let setting = |d: Option<&Value>, k: &str| d.and_then(|d| d.pointer(&format!("/settings/{k}"))).and_then(Value::as_str).map(str::to_string);
            let weak_now = |k: &str, v: &str| setting(Some(&x), k).as_deref() == Some(v) && setting(old, k).as_deref() != Some(v);
            if weak_now("verification", "none") || weak_now("signing", "v1") {
                add(TWO_WEBHOOK_WEAK);
            }
        }
    }
    // API-1 revision 5 13.2 (slice 1c3): a principal dropped from a client's `delegation.denied`, a new
    // `loopback_ok: true`, a new or changed `idps[].private_ok: true`
    for (id, c) in &new_clients {
        let old = old_clients.get(id);
        let denied = |v: &Value| strs(v.pointer("/delegation/denied"));
        let now_denied = denied(c);
        if old.is_some_and(|o| denied(o).iter().any(|p| !now_denied.contains(p))) {
            add(TWO_UNDENY);
        }
        if is_true(c.get("loopback_ok")) && !old.is_some_and(|o| is_true(o.get("loopback_ok"))) {
            add(TWO_LOOPBACK);
        }
    }
    let old_idps = by_id(base, "idps");
    for (id, i) in by_id(draft, "idps") {
        if is_true(i.get("private_ok")) && !old_idps.get(&id).is_some_and(|o| is_true(o.get("private_ok"))) {
            add(TWO_IDP_PRIVATE);
        }
    }
    // API-1 revision 5 13.2 (slice 1c7): content and delegated clients, connectors and idps, field by field
    for r in crate::console_api_1c::two_person_1c(base, draft) {
        add(r);
    }
    // API-1d 13: service hub and A2A clients, private CIDRs, agents, the root well-known card
    for r in crate::console_api_1d::two_person_1d(base, draft) {
        add(r);
    }
    // API-1d 13: a spokes relay bound, or `spokes.root` set or changed
    let spokes = |m: &Value, k: &str| m.get("spokes").and_then(|x| x.get(k)).cloned();
    let old_bound = strs(base.pointer("/spokes/relays"));
    if strs(draft.pointer("/spokes/relays")).iter().any(|r| !old_bound.contains(r)) || spokes(draft, "root").is_some_and(|r| spokes(base, "root") != Some(r)) {
        add(TWO_SPOKES_BIND);
    }
    out
}

/// Revision 4 13.3: whether a client entry is new or wider than before: active again, a scope, a higher ceiling,
/// relays, networks, a credential, its hours, a cap or its expiry, or `mtls_required` turned off.
pub(crate) fn client_widens(old: Option<&Value>, new: &Value) -> bool {
    let Some(old) = old else { return true };
    let list = |v: &Value, k: &str| strs(v.get(k));
    let more = |k: &str| list(new, k).iter().any(|x| !list(old, k).contains(x));
    let int = |v: &Value, p: &str| v.pointer(p).and_then(Value::as_i64);
    let state = s(new, "state") == "active" && s(old, "state") != "active";
    let ceiling = rank(&CEILINGS, s(new, "ceiling")) > rank(&CEILINGS, s(old, "ceiling"));
    let relays = !list(old, "relays").iter().any(|r| r == "*") && more("relays");
    let (old_nets, new_nets) = (list(old, "networks"), list(new, "networks"));
    let networks = !old_nets.is_empty() && (new_nets.is_empty() || new_nets.iter().any(|n| !old_nets.iter().any(|o| api_map::cidr_within(n, o))));
    let old_creds = old.get("credentials").and_then(Value::as_array).cloned().unwrap_or_default();
    let credentials = new.get("credentials").and_then(Value::as_array).into_iter().flatten().any(|c| !old_creds.contains(c));
    let hours = old.get("hours").is_some() && new.get("hours") != old.get("hours");
    let caps = ["holds_per_day", "job_max_bytes", "day_max_bytes", "jobs_per_day"].iter().any(|k| {
        let p = format!("/compliance/{k}");
        int(new, &p).is_some_and(|n| int(old, &p).is_none_or(|o| n > o))
    });
    let expiry = int(new, "/expires") > int(old, "/expires");
    let mtls = is_true(old.get("mtls_required")) && !is_true(new.get("mtls_required"));
    state || more("scopes") || ceiling || relays || networks || credentials || hours || caps || expiry || mtls
}

/// Revision 4 13.3: whether a destination entry is new or wider than before: a signal, a higher ceiling, looser
/// identities, failover or private addresses turned on, another endpoint, or more event types.
fn dest_widens(old: Option<&Value>, new: &Value) -> bool {
    let Some(old) = old else { return true };
    let more = |k: &str| strs(new.get(k)).iter().any(|x| !strs(old.get(k)).contains(x));
    let ceiling = rank(&CEILINGS, s(new, "ceiling")) > rank(&CEILINGS, s(old, "ceiling"));
    let identities = rank(&IDENTITIES, s(new, "identities")) < rank(&IDENTITIES, s(old, "identities"));
    let on = |k: &str| is_true(new.get(k)) && !is_true(old.get(k));
    let types = |d: &Value| strs(d.pointer("/settings/types"));
    let (old_types, new_types) = (types(old), types(new));
    let more_types = (new_types.is_empty() && !old_types.is_empty()) || (!old_types.is_empty() && new_types.iter().any(|t| !old_types.contains(t)));
    more("signals") || ceiling || identities || on("failover") || on("private_ok") || new.get("endpoint") != old.get("endpoint") || more_types
}

// ── the save's map (2.2, 2.3, 2.5) ──────────────────────────────────────────────────────────────────────────────

/// The map a save asks a device to sign: the draft with `seq` one above the pinned map's, `issued` now (later than
/// every entry it clears), `expires` 90 days on, the issuer url (the pinned map's, else `issuer_url`) and keys (the
/// unexpired listed ones plus the console's own key, at most 3), and `folded` / `cleared`: the kept journal ids a
/// pinned map already settled stay listed, the draft's undone ids are cleared, and every other active entry whose
/// restriction the map contains is folded (judged by `api_map::fold`, as relays judge it). The console journal's
/// active entries (`console`, revision 4 2.3 item 4) fold the same way (`api_cjournal::fold`), and `v` is the version
/// the map's fields need (revision 4 2.1: a map without a version 2 field stays version 1, byte for byte).
pub fn final_map(d: &Draft, issuer_url: &str, console_jwk: &Value, active: &[TightenEntry], console: &[ConsoleEntry], kept_ids: &[String], now: i64) -> Value {
    let mut m = d.map.clone();
    let draft_cleared = strs(m.get("cleared"));
    let issued = active.iter().filter(|e| draft_cleared.contains(&e.id)).map(|e| e.ts + 1).fold(now, i64::max);
    let issued = console.iter().filter(|e| draft_cleared.contains(&e.id)).map(|e| e.ts + 1).fold(issued, i64::max);
    m["org"] = json!(d.org);
    m["seq"] = json!(d.base_seq + 1);
    m["issued"] = json!(issued);
    m["expires"] = json!(issued + MAP_DAYS * DAY);
    if s(&m["issuer"], "url").is_empty() {
        m["issuer"]["url"] = json!(issuer_url);
    }
    let kid = s(console_jwk, "kid").to_string();
    let mut jwks: Vec<Value> = m.pointer("/issuer/jwks").and_then(Value::as_array).cloned().unwrap_or_default();
    jwks.retain(|k| k.get("exp").and_then(Value::as_i64).is_some_and(|e| e > issued));
    if !kid.is_empty() && !jwks.iter().any(|k| s(k, "kid") == kid) {
        let mut k = console_jwk.clone();
        k["nbf"] = json!(issued);
        k["exp"] = json!(issued + ISSUER_KEY_DAYS * DAY);
        jwks.push(k);
    }
    while jwks.len() > 3 {
        // the oldest listed key goes first, never the console's own
        let i = jwks.iter().position(|k| s(k, "kid") != kid).unwrap_or(0);
        jwks.remove(i);
    }
    m["issuer"]["jwks"] = json!(jwks);
    let base_folded = strs(d.base.get("folded"));
    let base_cleared = strs(d.base.get("cleared"));
    let mut cleared: Vec<String> = base_cleared.into_iter().filter(|i| kept_ids.contains(i)).collect();
    for i in &draft_cleared {
        if !cleared.contains(i) {
            cleared.push(i.clone());
        }
    }
    let mut folded: Vec<String> = base_folded.into_iter().filter(|i| kept_ids.contains(i) && !cleared.contains(i)).collect();
    m["cleared"] = json!(cleared);
    for e in active {
        if cleared.contains(&e.id) || folded.contains(&e.id) {
            continue;
        }
        let mut probe = m.clone();
        probe["folded"] = json!([e.id]);
        probe["cleared"] = json!([]);
        if api_map::fold(std::slice::from_ref(e), &probe).is_ok_and(|left| left.is_empty()) {
            folded.push(e.id.clone());
        }
    }
    // revision 4 2.3 item 4: a `k_` id makes a map version 2, so console journal ids are listed only in a map that is
    // version 2 by its own fields or undoes one (an entry a version 1 map does not fold stays active on the console,
    // which only keeps it stricter; settled ones stay settled there)
    let console_id = |i: &String| i.starts_with("k_");
    let own_v2 = {
        let mut probe = m.clone();
        probe["folded"] = json!(folded.iter().filter(|i| !console_id(i)).collect::<Vec<_>>());
        probe["cleared"] = json!(cleared.iter().filter(|i| !console_id(i) || draft_cleared.contains(i)).collect::<Vec<_>>());
        api_map::version_needed(&probe) == 2
    };
    if own_v2 {
        for e in console {
            if !cleared.contains(&e.id) && !folded.contains(&e.id) && crate::api_cjournal::contains(&m, e) {
                folded.push(e.id.clone());
            }
        }
    } else {
        folded.retain(|i| !console_id(i));
        cleared.retain(|i| !console_id(i) || draft_cleared.contains(i));
        m["cleared"] = json!(cleared);
    }
    m["folded"] = json!(folded);
    m["v"] = json!(api_map::version_needed(&m));
    m
}

// ── explain (6.2) ───────────────────────────────────────────────────────────────────────────────────────────────

/// What explain judges against: the org's store (pinned map and active journal), whether the console serves under
/// a license (check 1), the owner rule (4.3) and now (seconds).
pub struct ExplainSite<'a> {
    pub store: Option<&'a crate::api_map::ApiMapStore>,
    pub licensed: bool,
    pub owner_active: &'a dyn Fn(&str) -> bool,
    pub now: i64,
}

fn check(n: usize, name: &str, verdict: Result<String, (&'static str, String)>) -> Value {
    match verdict {
        Ok(words) => json!({"n": n, "name": name, "ok": true, "words": words}),
        Err((code, words)) => json!({"n": n, "name": name, "ok": false, "code": code, "words": words}),
    }
}

/// `POST settings/api/explain {client, method, path, ip?}`: each check of 6.2 in order (0 to 11) for that client
/// (id or name) calling that route of the front door (or a relay listener) from `ip`, against the pinned map and
/// the journal now, and the first that would fail. Checks 0, 3, 5 and 11 depend on the request itself (its limiter
/// counts, its token, its rate) and are judged only as far as the map decides them.
pub fn explain(site: &ExplainSite, org: &str, client: &str, method: &str, path: &str, ip: Option<&str>) -> Result<Value, ApiError> {
    use crate::api_resource::{route_of, Pipeline, RouteId, Side};
    let full = if path.starts_with("/api/orgs/") { path.to_string() } else { format!("/api/orgs/{org}/{}", path.trim_start_matches('/')) };
    let m = route_of(Side::FrontDoor, method, &full).or_else(|| route_of(Side::Relay, method, &full)).filter(|m| m.route.pipeline == Pipeline::Resource && m.org == org);
    let m = m.ok_or_else(|| invalid(NOT_RESOURCE_ROUTE))?;
    let route = m.route;
    let ip: Option<std::net::IpAddr> = match ip.map(str::trim).filter(|x| !x.is_empty()) {
        Some(x) => Some(x.parse().map_err(|_| invalid("ip is an IPv4 or IPv6 address."))?),
        None => None,
    };
    let now = site.now;
    let empty = crate::api_map::ApiMapStore::default();
    let store = site.store.unwrap_or(&empty);
    let active = store.active(org);
    let c = crate::api_token::find_client(store, org, client)
        .or_else(|| store.clients(org).iter().filter_map(Value::as_object).find(|c| c.get("name").and_then(Value::as_str) == Some(client)));
    let cid = c.and_then(|c| c.get("id")).and_then(Value::as_str).unwrap_or(client).to_string();
    let entries = |action: &'static str| {
        let field = if action == "client_drop_scope" { "scope" } else { "ceiling" };
        crate::api_token::client_entries(active, action, &cid).map(|e| crate::api_token::target_field(e, field).to_string()).collect::<Vec<String>>()
    };
    let mut checks = Vec::new();
    checks.push(check(0, "Source limiter", Ok("Counted per address on each request; explain does not use it up.".into())));
    checks.push(check(1, "License", if site.licensed { Ok("The console serves under a license.".into()) } else { Err(("license", "This server is not serving under a license right now.".into())) }));
    let closed = crate::api_issue::closed(store, org, now);
    checks.push(check(2, "API map", match closed {
        None => Ok("The organization's api map is pinned, unexpired, and the API is on.".into()),
        Some(code) => Err((if code == "map-edition" { "license" } else { code }, crate::api_issue::closed_why(code).into())),
    }));
    let usable = c.map(|c| crate::api_token::usable_credentials(c, active).len()).unwrap_or(0);
    checks.push(check(3, "Token", match c {
        None => Err(("token", "There is no such client in the pinned api map.".into())),
        Some(_) if usable == 0 => Err(("token", "The client holds no credential it can use now, so it gets no token.".into())),
        Some(_) => Ok(format!("The client can get a token with {usable} credential(s); each token is checked on use.")),
    }));
    checks.push(check(4, "Client", match c {
        None => Err(("suspended", "That client is not registered.".into())),
        Some(c) => {
            let suspended = c.get("state").and_then(Value::as_str) != Some("active") || active.iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(cid.as_str()));
            let end = crate::api_map::effective_end(c.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN), &[store.grace_hours(org, "app", now)]);
            if suspended {
                Err(("suspended", "That client is suspended.".into()))
            } else if now > end {
                Err(("expired", "That client's registration has expired.".into()))
            } else if !(site.owner_active)(c.get("owner").and_then(Value::as_str).unwrap_or_default()) {
                Err(("owner", "That client's owner is not an active person of the organization.".into()))
            } else {
                Ok("The client is active, within its registration, and its owner is active.".into())
            }
        }
    }));
    checks.push(check(5, "Client limiter", Ok("Counted per client on each request; explain does not use it up.".into())));
    let dropped = entries("client_drop_scope");
    let scopes: Vec<String> = c.map(|c| crate::api_token::names(c, "scopes").filter(|x| !dropped.iter().any(|d| d == x)).map(str::to_string).collect()).unwrap_or_default();
    checks.push(check(6, "Scope", if scopes.iter().any(|x| x == route.scope) { Ok(format!("The client holds {}.", route.scope)) } else { Err(("scope", format!("This route needs the {} scope.", route.scope))) }));
    let reach = c.and_then(|c| c.get("reach")).and_then(Value::as_str).unwrap_or_default();
    checks.push(check(7, "Reach", if reach == route.reach { Ok(format!("The route's reach {} is the client's.", route.reach)) } else { Err(("reach", "This route is outside the client's reach.".into())) }));
    let target = if route.id == RouteId::FleetRelay { m.id.map(str::to_string) } else { None };
    checks.push(check(8, "Relays", match target {
        Some(t) if !c.is_some_and(|c| crate::api_token::relay_reachable(c, active, &cid, &t)) => Err(("not-found", "That relay is not among the client's relays, so the route answers as if nothing were there.".into())),
        Some(t) => Ok(format!("Relay {t} is among the client's relays.")),
        None => Ok("The route lists only the client's relays.".into()),
    }));
    let lowered = entries("client_lower_ceiling").iter().filter_map(|x| crate::api_token::rank(x)).min();
    let ceiling = c.and_then(|c| c.get("ceiling")).and_then(Value::as_str).and_then(crate::api_token::rank).unwrap_or(0);
    let effective = lowered.map_or(ceiling, |l| l.min(ceiling));
    let class = crate::api_token::rank(route.class).unwrap_or(0);
    checks.push(check(9, "Ceiling", if effective >= class && effective > 0 { Ok(format!("The client's ceiling {} covers this route's {} data.", CEILINGS[effective], route.class)) } else { Err(("ceiling", "The data of this route is above the client's ceiling.".into())) }));
    checks.push(check(10, "Network, hours, mTLS", match c {
        None => Err(("network", "That client is not registered.".into())),
        Some(c) => {
            // the map's networks and every `client_limit`'s (2.5)
            let fenced = crate::api_token::names(c, "networks").next().is_some() || crate::api_token::client_entries(active, "client_limit", &cid).any(|e| e.target.get("networks").is_some());
            if fenced && ip.is_none() {
                Err(("network", "This client may call only from its networks; give an address to judge it.".into()))
            } else if ip.is_some_and(|a| !crate::api_token::source_allowed(c, active, &cid, a)) {
                Err(("network", "This client may not call from that address.".into()))
            } else if c.get("hours").is_some_and(|h| !crate::api_issue::inside_hours(h, now)) {
                Err(("hours", "This client may not call at this time.".into()))
            } else if c.get("mtls_required").and_then(Value::as_bool) == Some(true) {
                Ok("The source and time fit; the client must also present its certificate on each request.".into())
            } else {
                Ok("The source and time fit.".into())
            }
        }
    }));
    let per = |k: &str| c.map_or(0, |c| crate::api_token::rate_of(c, active, &cid, k));
    checks.push(check(11, "Rate", Ok(format!("At most {} a minute and {} a day on each listener; explain does not use it up.", per("per_minute_each"), per("per_day_each")))));
    let first_fail = checks.iter().find(|c| c["ok"] == json!(false)).map(|c| c["n"].clone()).unwrap_or(Value::Null);
    Ok(json!({"checks": checks, "first_fail": first_fail}))
}

// ── views (7.3) ─────────────────────────────────────────────────────────────────────────────────────────────────

/// A credential as the screens show it: its type, a hint and its end; never a secret or a key.
pub fn credential_hint(cr: &Value) -> Value {
    let hint = match s(cr, "type") {
        "mtls" => format!("serial {}", s(cr, "serial").chars().take(8).collect::<String>()),
        "private_key_jwt" if cr.get("kid").is_some() => s(cr, "kid").to_string(),
        "private_key_jwt" => s(cr, "jwks_uri").to_string(),
        "federated" => format!("{} {}", s(cr, "issuer"), s(cr, "subject")),
        "entra_wif" => s(cr, "tenant").to_string(),
        // revision 5 4.1: the CIMD document's URL (public)
        "cimd" => s(cr, "url").to_string(),
        _ => s(cr, "hint").to_string(),
    };
    let mut v = json!({"type": s(cr, "type"), "hint": hint});
    if let Some(e) = cr.get("expires") {
        v["expires"] = e.clone();
    }
    // revision 4 4.1: the public values the Directory section shows (none is a secret)
    if s(cr, "type") == "entra_wif" {
        for k in ["cloud", "tenant", "audience", "azp"] {
            if let Some(x) = cr.get(k) {
                v[k] = x.clone();
            }
        }
    }
    v
}

/// Revision 4 2.2: a client's `compliance` block as the screens show it: its caps and its recipient as `{kid, jkt}`
/// (the RFC 7638 thumbprint, null when the key does not read), never the key itself.
pub fn compliance_view(block: &Value) -> Value {
    let mut v = json!({});
    for k in CAPS {
        if let Some(x) = block.get(k) {
            v[k] = x.clone();
        }
    }
    if let Some(r) = block.get("recipient") {
        let jkt = r.get("jwk").and_then(|j| crate::api_token::parse_jwk(j, 2048)).map(|k| crate::api_token::jwk_thumbprint(&k));
        v["recipient"] = json!({"kid": r.get("kid"), "jkt": jkt});
    }
    v
}

/// Revision 4 2.2, 2.4: the map's `webhook_keys` as the screens show them, each `dropped` while the org's console
/// journal holds a `webhook_key_drop` of its kid.
pub fn webhook_keys_view(m: &Value, console: &[ConsoleEntry]) -> Value {
    let keys = m.get("webhook_keys").and_then(Value::as_array).into_iter().flatten();
    Value::Array(
        keys.map(|k| json!({"kid": k.get("kid"), "public": k.get("public"), "nbf": k.get("nbf"), "exp": k.get("exp"), "dropped": crate::api_cjournal::key_dropped(console, "webhook_key_drop", s(k, "kid"))}))
            .collect(),
    )
}

/// Revision 4 2.2, 2.4: the map's `federation` as the screens show it (null without one): its issuer and each key's
/// kid and dates, `dropped` while the org's console journal holds a `federation_drop_key` of its kid; never `n`.
pub fn federation_view(m: &Value, console: &[ConsoleEntry]) -> Value {
    let Some(f) = m.get("federation").filter(|f| f.is_object()) else { return Value::Null };
    let keys: Vec<Value> = f
        .get("keys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|k| json!({"kid": k.get("kid"), "nbf": k.get("nbf"), "exp": k.get("exp"), "dropped": crate::api_cjournal::key_dropped(console, "federation_drop_key", s(k, "kid"))}))
        .collect();
    json!({"issuer": f.get("issuer"), "keys": keys})
}

/// Revision 4 2.2 (Rev4Review R4-10): the clients of a map holding `events.subscribe`, `[{id, name}]`, the ones a
/// webhook's `settings.client` and another kind's `settings.events_client` may name.
pub fn events_clients(m: &Value) -> Value {
    let clients = m.get("clients").and_then(Value::as_array).into_iter().flatten();
    Value::Array(clients.filter(|c| strs(c.get("scopes")).iter().any(|x| x == "events.subscribe")).map(|c| json!({"id": c.get("id"), "name": c.get("name")})).collect())
}

/// One client as the screen lists it, with `shown_state` (suspended by its state or the journal, expired, or its
/// owner gone).
pub fn client_view(c: &Value, active: &[TightenEntry], owner_active: &dyn Fn(&str) -> bool, now: i64) -> Value {
    let id = s(c, "id");
    let suspended = s(c, "state") == "suspended" || active.iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(id));
    let shown = if suspended {
        "suspended"
    } else if c.get("expires").and_then(Value::as_i64).is_some_and(|e| e <= now) {
        "expired"
    } else if !owner_active(s(c, "owner")) {
        "owner-gone"
    } else {
        "active"
    };
    let mut v = json!({});
    for k in ["id", "name", "principal", "kind", "owner", "reach", "scopes", "ceiling", "relays", "networks", "hours", "mtls_required", "rate", "created", "expires", "state", "directory"] {
        if let Some(x) = c.get(k) {
            v[k] = x.clone();
        }
    }
    // revision 5 3.2 (slice 1c7): the content and delegation fields (none is a secret)
    // API-1d 2.2: `a2a`, `card` and `spokes` (none is a secret)
    for k in ["connectors", "apps", "channels", "confirm", "redirect_uris", "loopback_ok", "a2a", "card", "spokes"] {
        if let Some(x) = c.get(k) {
            v[k] = x.clone();
        }
    }
    if let Some(dl) = c.get("delegation").filter(|x| x.is_object()) {
        let mut shown = json!({});
        for k in ["groups", "principals", "idps", "consent_days", "denied"] {
            if let Some(x) = dl.get(k) {
                shown[k] = x.clone();
            }
        }
        v["delegation"] = shown;
    }
    if let Some(block) = c.get("compliance").filter(|b| b.is_object()) {
        v["compliance"] = compliance_view(block);
    }
    v["shown_state"] = json!(shown);
    v["credentials"] = json!(c.get("credentials").and_then(Value::as_array).into_iter().flatten().map(credential_hint).collect::<Vec<_>>());
    v
}

/// A map (pinned or draft) as the API access screen shows it: no secret, no hash. `console` is the org's active
/// console journal (the dropped webhook and federation keys).
pub fn map_view(m: &Value, seq: i64, active: &[TightenEntry], console: &[ConsoleEntry], owner_active: &dyn Fn(&str) -> bool, now: i64) -> Value {
    let clients: Vec<Value> = m.get("clients").and_then(Value::as_array).into_iter().flatten().map(|c| client_view(c, active, owner_active, now)).collect();
    let tokens: Vec<Value> = m.get("scrape_tokens").and_then(Value::as_array).into_iter().flatten().map(|t| json!({"hint": t.get("hint"), "label": t.get("label"), "relays": t.get("relays"), "expires": t.get("expires")})).collect();
    json!({"seq": seq, "issued": m.get("issued"), "expires": m.get("expires"), "issuer_url": m.pointer("/issuer/url"), "failover_after_s": m.get("failover_after_s"),
           "grace": m.get("grace"), "relay_origins": m.get("relay_origins").cloned().unwrap_or_else(|| json!({})), "clients": clients, "scrape_tokens": tokens,
           "webhook_keys": webhook_keys_view(m, console), "federation": federation_view(m, console),
           "a2a": a2a_brief(m), "spokes": m.get("spokes")})
}

/// API-1d 7.14: the map's agents as the client editor offers them, `{agents: [{id, name, connector, hub, skills:
/// [{id, name}]}], well_known}`, null without `a2a`.
fn a2a_brief(m: &Value) -> Value {
    let Some(a) = m.get("a2a").filter(|a| a.is_object()) else { return Value::Null };
    let agents: Vec<Value> = a
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|g| {
            let skills: Vec<Value> = g.get("skills").and_then(Value::as_array).into_iter().flatten().map(|k| json!({"id": k.get("id"), "name": k.get("name")})).collect();
            json!({"id": g.get("id"), "name": g.get("name"), "connector": g.get("connector"), "hub": g.get("hub"), "skills": skills})
        })
        .collect();
    json!({"agents": agents, "well_known": a.get("well_known")})
}

/// `none`, `set-aside`, `expired`, `off` or `on`.
pub fn org_state(pinned: Option<&Value>, set_aside: bool, active: &[TightenEntry], now: i64) -> &'static str {
    match pinned {
        _ if set_aside => "set-aside",
        None => "none",
        Some(m) if m.get("expires").and_then(Value::as_i64).is_none_or(|e| e <= now) => "expired",
        Some(_) if active.iter().any(|e| e.action == "api_off") => "off",
        Some(_) => "on",
    }
}

/// 2.2 and 13: what the org's map may hold under the license edition.
pub fn limits(edition: Option<api_map::Edition>) -> Value {
    let clients = if edition == Some(api_map::Edition::Standard) { CLIENTS_STANDARD } else { CLIENTS_MAX };
    json!({"clients": clients, "destinations": DESTINATIONS_MAX, "scrape_tokens": SCRAPE_TOKENS_MAX})
}

/// 11.1, 11.3: every export preset with its kind, credential types and the signals its kind carries (revision 4 2.2:
/// `events` on every kind but `syslog_cef`), and the `webhook` preset of kind `webhook`.
pub fn presets_view() -> Value {
    let mut list: Vec<Value> = crate::api_export_wire::PRESETS
        .iter()
        .map(|p| {
            let signals: &[&str] = match p.kind {
                "otlp" => &["metrics", "logs", "traces", "audit", "events"],
                "syslog_cef" => &["logs", "audit"],
                _ => &["logs", "audit", "events"],
            };
            json!({"id": p.name, "kind": p.kind, "credential_types": p.credentials, "signals": signals})
        })
        .collect();
    list.push(json!({"id": "webhook", "kind": "webhook", "credential_types": ["none", "token", "mtls"], "signals": ["events"]}));
    Value::Array(list)
}

/// One destination of the Exports screen: its map fields, where it comes from, its credential (type, held, rotate
/// by), its live status (11.7), whether it passed a test since its last change, and its failover records (12.3).
pub fn destination_view(x: &Value, source: &str, held: bool, rotate_by: Option<i64>, status: Option<&Value>, tested: bool, failover: Vec<Value>) -> Value {
    let mut v = json!({});
    for k in ["id", "name", "kind", "preset", "signals", "ceiling", "identities", "failover", "private_ok", "endpoint", "settings", "queue"] {
        v[k] = x.get(k).cloned().unwrap_or(Value::Null);
    }
    v["source"] = json!(source);
    let ty = x.pointer("/credential/type").and_then(Value::as_str).unwrap_or_default();
    let mut cred = json!({"type": ty, "held": held});
    for f in credential_fields(ty) {
        if let Some(v) = x.get("credential").and_then(|c| c.get(*f)) {
            cred[*f] = v.clone();
        }
    }
    if let Some(r) = rotate_by {
        cred["rotate_by"] = json!(r);
    }
    v["credential"] = cred;
    v["status"] = status.map(|st| json!({"state": st.get("state"), "backlog_bytes": st.get("backlog_bytes"), "oldest_s": st.get("oldest_s"), "last_success": st.get("last_success"), "last_error": st.get("last_error")})).unwrap_or(Value::Null);
    // revision 4 7.4: the events signal's delivery (`ExportEngine::status`)
    if let Some(ev) = status.and_then(|st| st.get("events")).filter(|e| e.is_object()) {
        v["status"]["events"] = ev.clone();
    }
    v["tested"] = json!(tested);
    v["failover_records"] = Value::Array(failover);
    v
}

// ── the signing of a save (`meet.api.sign`) ─────────────────────────────────────────────────────────────────────

/// One org's save in flight or ended: the relay asked, its request id (empty while `sending`), who saved and when
/// (ms), `sending`, `waiting`, `done` or `failed`, the error sentence, the map's hash and seq. Written to disk before
/// the relay is asked, so a restarted console keeps polling.
#[derive(Clone, Debug, PartialEq)]
pub struct Signing {
    pub org: String,
    pub relay: String,
    pub request: String,
    pub by: String,
    pub at: i64,
    pub state: &'static str,
    pub error: Option<String>,
    pub map_sha256: String,
    pub seq: i64,
}

impl Signing {
    pub fn to_json(&self) -> Value {
        json!({"org": self.org, "relay": self.relay, "request": self.request, "by": self.by, "at": self.at, "state": self.state,
               "error": self.error, "map_sha256": self.map_sha256, "seq": self.seq})
    }

    /// `sending` (recorded before `api-sign-request` is sent; its request id unknown until the relay answers),
    /// `waiting`, or `publishing` (the signed map is claimed for publication, so it can no longer be canceled): a save
    /// of the org is in flight and another is refused.
    pub fn in_flight(&self) -> bool {
        matches!(self.state, "sending" | "waiting" | "publishing")
    }

    pub fn from_json(v: &Value) -> Option<Signing> {
        let state = match v.get("state")?.as_str()? {
            "sending" => "sending",
            "waiting" => "waiting",
            "publishing" => "publishing",
            "done" => "done",
            "failed" => "failed",
            _ => return None,
        };
        let t = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Signing { org: t("org")?, relay: t("relay")?, request: t("request")?, by: t("by")?, at: v.get("at")?.as_i64()?, state, error: t("error"), map_sha256: t("map_sha256")?, seq: v.get("seq")?.as_i64()? })
    }

    /// The `signing` key of the API access screen.
    pub fn view(&self) -> Value {
        let mut v = json!({"request": self.request, "relay": self.relay, "by": self.by, "at": self.at, "state": self.state});
        if let Some(e) = &self.error {
            v["error"] = json!(e);
        }
        if self.state == "done" {
            v["seq"] = json!(self.seq);
        }
        v
    }

    /// What an `api-sign-status` answer moves a waiting signing to: None while it keeps waiting (and not past 24
    /// hours); Some(Ok((signed, signer_policy))) to publish; Some(Err(sentence)) when it failed.
    pub fn judge(&self, answer: &Value, t: i64) -> Option<Result<(Value, Map<String, Value>), String>> {
        match s(answer, "state") {
            "done" => {
                let signed = answer.get("signed").filter(|x| x.get("map").is_some_and(Value::is_object)).cloned();
                let Some(signed) = signed else { return Some(Err(SIGN_OTHER_MAP.into())) };
                if api_map::api_map_hash(&signed["map"]) != self.map_sha256 {
                    return Some(Err(SIGN_OTHER_MAP.into()));
                }
                match answer.get("signer_policy").and_then(Value::as_object) {
                    Some(sp) => Some(Ok((signed, sp.clone()))),
                    None => Some(Err(NO_SIGNER_POLICY.into())),
                }
            }
            "failed" => Some(Err(answer.get("error").and_then(Value::as_str).map(|e| crate::console_auth::clean(e).chars().take(300).collect()).unwrap_or_else(|| SIGN_OTHER_MAP.into()))),
            "waiting" if t - self.at < SIGN_WAIT_MS => None,
            "waiting" => Some(Err(SIGN_TIMEOUT.into())),
            _ => Some(Err(SIGN_GONE.into())),
        }
    }
}

/// The signing records file under the console's state folder.
pub const SIGNING_FILE: &str = "api-signing.json";

pub fn signings_load(dir: &std::path::Path) -> BTreeMap<String, Signing> {
    std::fs::read_to_string(dir.join(SIGNING_FILE))
        .ok()
        .and_then(|t| crate::codec::parse_json(&t))
        .and_then(|v| v.get("orgs").and_then(Value::as_array).cloned())
        .into_iter()
        .flatten()
        .filter_map(|v| Signing::from_json(&v))
        .map(|x| (x.org.clone(), x))
        .collect()
}

pub fn signings_save(dir: &std::path::Path, all: &BTreeMap<String, Signing>) -> Result<(), String> {
    let body = crate::codec::stringify(&json!({"orgs": all.values().map(Signing::to_json).collect::<Vec<_>>()}));
    crate::fleet_local::write_durable(&dir.join(SIGNING_FILE), body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_795_000_000;
    const T: i64 = NOW * 1000;
    const OWNER: &str = "ann@acme.example";

    fn entry(tseq: u64, action: &str, target: Value) -> TightenEntry {
        let mut e = json!({"id": format!("t_acme_{tseq:06}"), "tseq": tseq, "ts": NOW - 10, "action": action, "target": target});
        if action == "token_deny" {
            e["until"] = json!(NOW + 60);
        }
        TightenEntry::parse(&e).unwrap()
    }

    fn jwk() -> Value {
        json!({"kty": "EC", "crv": "P-256", "kid": "i-console", "x": "A".repeat(43), "y": "B".repeat(43), "use": "sig", "alg": "ES256"})
    }

    fn client_body(name: &str) -> Value {
        json!({"name": name, "kind": "monitoring", "owner": OWNER, "scopes": ["monitor.read"], "ceiling": "internal", "relays": ["*"],
               "networks": ["10.40.0.0/23"], "mtls_required": false, "rate": {"per_minute_each": 120, "per_day_each": 100000},
               "credentials": [{"type": "private_key_jwt", "kid": "k1", "jwk": {"kty": "EC", "crv": "P-256", "x": "C".repeat(43), "y": "D".repeat(43)}, "expires": NOW + 86_400 * 300}],
               "days": 300})
    }

    fn ctx<'a>(pinned: Option<&'a Value>, _active: &'a [TightenEntry]) -> Ctx<'a> {
        Ctx { org: "acme", by: "ann@acme.example", pinned, pinned_seq: pinned.and_then(|m| m["seq"].as_i64()).unwrap_or(0) }
    }

    fn anyone(_: &str) -> bool {
        true
    }

    fn checked(m: &Value) {
        api_map::check_api_map(m, NOW, None, api_map::Edition::Enterprise, &BTreeMap::new()).unwrap_or_else(|e| panic!("{e}: {m}"));
    }

    /// A pinned map with one client (`c_1111111111111111`) and one splunk destination (`d_2222222222222222`).
    fn pinned() -> Value {
        let mut d = Draft::new(&ctx(None, &[]), "st_0".into(), T);
        add_client(&mut d, &client_body("splunk-scrape"), "c_1111111111111111".into(), NOW).unwrap();
        add_destination(&mut d, &json!({"name": "Splunk", "kind": "splunk_hec", "preset": "splunk_hec", "signals": ["logs"], "ceiling": "internal",
                                         "identities": "pseudonymized", "endpoint": "https://hec.acme.example:8088/services/collector/event", "credential": {"type": "token"}}), "d_2222222222222222".into()).unwrap();
        let m = final_map(&d, "https://console.acme.example:7443/api/orgs/acme", &jwk(), &[], &[], &[], NOW);
        checked(&m);
        m
    }

    #[test]
    fn a_new_client_is_a_valid_map_entry_and_a_step_up_save() {
        let p = pinned();
        assert_eq!(p["seq"], 1);
        assert_eq!(p["clients"][0]["principal"], "splunk-scrape@apps.acme.example");
        assert_eq!(p["issuer"]["jwks"][0]["kid"], "i-console");
        assert_eq!(p["destinations"][0]["credential"], json!({"type": "token", "ref": "secret:d_2222222222222222"}));
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_1".into(), T);
        add_client(&mut d, &client_body("grafana"), "c_3333333333333333".into(), NOW).unwrap();
        assert!(two_person(&d.base, &d.map, &[]).is_empty(), "a plain new client needs step-up only");
        assert_eq!(d.view(&[])["changes"], json!(["Add client grafana"]));
        assert!(add_client(&mut d, &client_body("grafana"), "c_4444444444444444".into(), NOW).is_err(), "names are unique");
        let mut secret = client_body("x");
        secret["credentials"] = json!([{"type": "client_secret", "sha256": "0".repeat(64), "hint": "00000000", "expires": NOW + 10}]);
        assert_eq!(add_client(&mut d, &secret, "c_5555555555555555".into(), NOW).unwrap_err().message, SECRET_ROUTE);
        checked(&final_map(&d, "", &jwk(), &[], &[], &[], NOW));
    }

    #[test]
    fn the_two_person_rule_follows_6_6_rule_by_rule() {
        let p = pinned();
        let fresh = || Draft::new(&ctx(Some(&p), &[]), "st_x".into(), T);
        let reasons = |d: &Draft, active: &[TightenEntry]| two_person(&d.base, &d.map, active);
        // audit.read with confidential or cui
        let mut d = fresh();
        update_client(&mut d, "c_1111111111111111", &json!({"scopes": ["monitor.read", "audit.read"], "ceiling": "confidential"}), Some(&p), NOW).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_AUDIT]);
        let mut d = fresh();
        update_client(&mut d, "c_1111111111111111", &json!({"scopes": ["monitor.read", "audit.read"]}), Some(&p), NOW).unwrap();
        assert!(reasons(&d, &[]).is_empty(), "audit.read at internal is step-up only");
        // a suspended audit.read client at confidential (its suspension folded into the map and pruned) made active
        let mut held = p.clone();
        held["clients"][0]["scopes"] = json!(["monitor.read", "audit.read"]);
        held["clients"][0]["ceiling"] = json!("confidential");
        held["clients"][0]["state"] = json!("suspended");
        let mut d = Draft::new(&ctx(Some(&held), &[]), "st_s".into(), T);
        resume_client(&mut d, "c_1111111111111111", &[]).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_AUDIT]);
        let mut d = Draft::new(&ctx(Some(&held), &[]), "st_s".into(), T);
        update_client(&mut d, "c_1111111111111111", &json!({"name": "renamed"}), Some(&held), NOW).unwrap();
        assert!(reasons(&d, &[]).is_empty(), "still suspended");
        // a destination with audit, or as_is
        let mut d = fresh();
        update_destination(&mut d, "d_2222222222222222", &json!({"signals": ["logs", "audit"]}), Some(&p)).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_DEST_AUDIT]);
        let mut d = fresh();
        update_destination(&mut d, "d_2222222222222222", &json!({"identities": "as_is"}), Some(&p)).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_DEST_AS_IS]);
        // failover, private_ok on a destination and on a fetched URL
        let mut d = fresh();
        update_destination(&mut d, "d_2222222222222222", &json!({"failover": true}), Some(&p)).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_FAILOVER]);
        let mut d = fresh();
        update_destination(&mut d, "d_2222222222222222", &json!({"private_ok": true}), Some(&p)).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_PRIVATE]);
        let mut d = fresh();
        update_client(&mut d, "c_1111111111111111", &json!({"credentials": [{"type": "private_key_jwt", "jwks_uri": "https://idp.acme.example/jwks", "private_ok": true, "expires": NOW + 1000}]}), Some(&p), NOW).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_PRIVATE]);
        // a grace raise (a lowering is not)
        let mut d = fresh();
        assert!(set_grace(&mut d, &json!({"app": 24}), Some(&p)).unwrap().is_empty());
        assert_eq!(reasons(&d, &[]), vec![TWO_GRACE]);
        assert_eq!(d.changes, vec!["Raise app grace to 24 hours"]);
        // a client secret
        let mut d = fresh();
        client_secret(&mut d, "c_1111111111111111", 30, &mint(SECRET_PREFIX, &[1; 32]), NOW).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_SECRET]);
        // a scrape token for relays
        let mut d = fresh();
        add_scrape_token(&mut d, "prometheus", &json!(["*"]), 90, &mint(SCRAPE_PREFIX, &[2; 32]), NOW).unwrap();
        assert_eq!(reasons(&d, &[]), vec![TWO_SCRAPE]);
        // undoing api_off, client_suspend, client_lower_ceiling or a destination tightening; not a scope drop
        for (action, target, two) in [
            ("api_off", json!("acme"), true),
            ("client_suspend", json!("c_1111111111111111"), true),
            ("client_lower_ceiling", json!({"client": "c_1111111111111111", "ceiling": "public"}), true),
            ("destination_drop_signal", json!({"destination": "d_2222222222222222", "signal": "logs"}), true),
            ("destination_delete", json!("d_2222222222222222"), true),
            ("client_drop_scope", json!({"client": "c_1111111111111111", "scope": "monitor.read"}), false),
        ] {
            let active = [entry(1, action, target)];
            let mut d = Draft::new(&ctx(Some(&p), &active), "st_u".into(), T);
            undo(&mut d, "t_acme_000001", &active).unwrap();
            assert_eq!(reasons(&d, &active) == vec![TWO_CLEARED], two, "{action}");
        }
        let deny = [entry(1, "token_deny", json!({"client": "c_1111111111111111", "jti": "j"}))];
        assert_eq!(undo(&mut fresh(), "t_acme_000001", &deny).unwrap_err().message, DENY_FOREVER);
    }

    #[test]
    fn removals_are_journaled_and_the_restriction_is_folded_into_the_next_map() {
        let p = pinned();
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_r".into(), T);
        let j = update_client(&mut d, "c_1111111111111111", &json!({"ceiling": "public"}), Some(&p), NOW).unwrap();
        assert_eq!(j, vec![tighten("client_lower_ceiling", json!({"client": "c_1111111111111111", "ceiling": "public"}))]);
        let j = update_client(&mut d, "c_1111111111111111", &json!({"credentials": []}), Some(&p), NOW).unwrap();
        assert_eq!(j, vec![tighten("client_lower_ceiling", json!({"client": "c_1111111111111111", "ceiling": "public"})), tighten("client_drop_credential", json!({"client": "c_1111111111111111", "kid": "k1"}))]);
        update_client(&mut d, "c_1111111111111111", &json!({"credentials": p["clients"][0]["credentials"].clone()}), Some(&p), NOW).unwrap();
        let j = suspend_client(&mut d, "c_1111111111111111", Some(&p)).unwrap();
        assert_eq!(j, vec![tighten("client_suspend", json!("c_1111111111111111"))]);
        let j = delete_destination(&mut d, "d_2222222222222222", Some(&p)).unwrap();
        assert_eq!(j, vec![tighten("destination_delete", json!("d_2222222222222222"))]);
        let active = [entry(1, "client_lower_ceiling", json!({"client": "c_1111111111111111", "ceiling": "public"})), entry(2, "client_suspend", json!("c_1111111111111111")), entry(3, "destination_delete", json!("d_2222222222222222"))];
        let m = final_map(&d, "", &jwk(), &active, &[], &["t_acme_000001".into(), "t_acme_000002".into(), "t_acme_000003".into()], NOW);
        assert_eq!(m["folded"], json!(["t_acme_000001", "t_acme_000002", "t_acme_000003"]));
        assert_eq!(api_map::fold(&active, &m).unwrap(), Vec::<String>::new());
        checked(&m);
        // a resumed client clears its suspension instead
        resume_client(&mut d, "c_1111111111111111", &active).unwrap();
        let m = final_map(&d, "", &jwk(), &active, &[], &[], NOW);
        assert_eq!((m["cleared"].clone(), m["folded"].clone()), (json!(["t_acme_000002"]), json!(["t_acme_000001", "t_acme_000003"])));
        assert!(m["issued"].as_i64().unwrap() > active[1].ts);
        assert!(api_map::fold(&active, &m).is_ok());
        // a grace lowering is journaled
        let mut d = Draft::new(&ctx(Some(&m), &[]), "st_g".into(), T);
        d.base["grace"]["app"] = json!(48);
        d.map["grace"]["app"] = json!(48);
        let mut high = m.clone();
        high["grace"]["app"] = json!(48);
        assert_eq!(set_grace(&mut d, &json!({"app": 4}), Some(&high)).unwrap(), vec![tighten("grace_lower", json!({"kind": "app", "hours": 4}))]);
    }

    #[test]
    fn secrets_are_kept_as_hash_and_hint_only() {
        let p = pinned();
        let minted = mint(SECRET_PREFIX, &[7; 32]);
        assert!(minted.secret.starts_with("lcs_") && minted.secret.len() == 47);
        assert_eq!(minted.sha256, sha256_hex(minted.secret.as_bytes()));
        assert!(crate::api_token::verify_client_secret(&minted.secret, &minted.sha256));
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_s".into(), T);
        client_secret(&mut d, "c_1111111111111111", 30, &minted, NOW).unwrap();
        let token = mint(SCRAPE_PREFIX, &[8; 32]);
        add_scrape_token(&mut d, "prom", &json!(["*"]), 60, &token, NOW).unwrap();
        let everything = format!("{} {} {}", crate::codec::stringify(&d.map), crate::codec::stringify(&d.view(&[])), crate::codec::stringify(&map_view(&d.map, 2, &[], &[], &anyone, NOW)));
        assert!(!everything.contains(&minted.secret) && !everything.contains(&token.secret), "no secret in the draft or the views");
        assert!(everything.contains(&minted.hint));
        let m = final_map(&d, "", &jwk(), &[], &[], &[], NOW);
        checked(&m);
        assert_eq!(credential_hint(&m["clients"][0]["credentials"][1])["hint"], json!(minted.hint));
        assert_eq!(credential_hint(&json!({"type": "mtls", "serial": "0a1b2c3d4e5f", "spki": "0"})).get("hint"), Some(&json!("serial 0a1b2c3d")));
    }

    #[test]
    fn tests_are_needed_for_new_and_changed_destinations_only() {
        let p = pinned();
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_t".into(), T);
        assert!(d.tests_needed().is_empty());
        update_destination(&mut d, "d_2222222222222222", &json!({"name": "Splunk main"}), Some(&p)).unwrap();
        assert!(d.tests_needed().is_empty(), "a new name needs no test");
        update_destination(&mut d, "d_2222222222222222", &json!({"endpoint": "https://hec2.acme.example:8088/services/collector/event"}), Some(&p)).unwrap();
        assert_eq!(d.tests_needed(), vec!["d_2222222222222222"]);
        let mut all = Drafts::default();
        all.put(d, T);
        all.tested("acme", "d_2222222222222222");
        assert!(all.get("acme", T).unwrap().tests_needed().is_empty());
        let mut d = all.get("acme", T).unwrap().clone();
        assert!(credential_entered(&mut d, "d_2222222222222222", &json!({"type": "token", "token": "hec-token-7f3a"})));
        assert!(!credential_entered(&mut d, "d_0000000000000000", &json!({})));
        assert_eq!(d.tests_needed(), vec!["d_2222222222222222"]);
        assert!(!crate::codec::stringify(&d.map).contains("hec-token-7f3a"), "the material stays out of the map");
        all.put(d, T);
        assert!(all.get("acme", T + DRAFT_MS).is_none(), "a draft lives 2 hours after its last change");
    }

    #[test]
    fn a_stale_draft_is_refused_and_dropped() {
        let p = pinned();
        let mut all = Drafts::default();
        all.put(Draft::new(&ctx(Some(&p), &[]), "st_a".into(), T), T);
        assert_eq!(all.take("acme", "st_b", "h", 1, T).unwrap_err().code, "gone");
        all.ask("acme", "st_a", "h").unwrap();
        let e = all.take("acme", "st_a", "h", 2, T).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("stale", STAGE_MOVED));
        assert!(all.get("acme", T).is_none());
        all.put(Draft::new(&ctx(Some(&p), &[]), "st_c".into(), T), T);
        all.ask("acme", "st_c", "h").unwrap();
        assert!(all.take("acme", "st_c", "h", 1, T).is_ok());
    }

    #[test]
    fn a_save_signs_only_the_map_it_asked_for() {
        let p = pinned();
        let mut all = Drafts::default();
        all.put(Draft::new(&ctx(Some(&p), &[]), "st_a".into(), T), T);
        // never asked, or asked for another map
        assert_eq!(all.take("acme", "st_a", "h1", 1, T).unwrap_err().message, STAGE_CHANGED);
        all.ask("acme", "st_a", "h1").unwrap();
        assert_eq!(all.take("acme", "st_a", "h2", 1, T).unwrap_err().message, STAGE_CHANGED);
        // a change after the ask (as a second admin waits) voids it
        let d = all.get("acme", T).unwrap().clone();
        all.put(d, T + 1);
        assert_eq!(all.take("acme", "st_a", "h1", 1, T + 1).unwrap_err().message, STAGE_CHANGED);
        all.ask("acme", "st_a", "h1").unwrap();
        assert_eq!(all.take("acme", "st_a", "h1", 1, T + 1).unwrap().id, "st_a");
    }

    #[test]
    fn a_client_limit_is_journaled_for_each_narrowing_and_folded_once_the_map_holds_it() {
        let p = pinned();
        let id = "c_1111111111111111";
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_l".into(), T);
        // `*` to a list, networks narrowed, a rate lowered: one limit; a wider network or a higher rate is no limit
        let j = update_client(&mut d, id, &json!({"relays": ["console"], "networks": ["10.40.0.0/24"], "rate": {"per_minute_each": 60, "per_day_each": 100000}}), Some(&p), NOW).unwrap();
        let want = json!({"client": id, "relays": ["console"], "networks": ["10.40.0.0/24"], "rate": {"per_minute_each": 60}});
        assert_eq!(j, vec![tighten("client_limit", want.clone())]);
        let mut wider = Draft::new(&ctx(Some(&p), &[]), "st_w".into(), T);
        assert!(update_client(&mut wider, id, &json!({"networks": ["10.40.0.0/16"], "rate": {"per_minute_each": 600, "per_day_each": 100000}}), Some(&p), NOW).unwrap().is_empty());
        let mut any = p.clone();
        any["clients"][0]["networks"] = json!([]);
        let mut fenced = Draft::new(&ctx(Some(&any), &[]), "st_f".into(), T);
        let j = update_client(&mut fenced, id, &json!({"networks": ["192.0.2.0/24"]}), Some(&any), NOW).unwrap();
        assert_eq!(j, vec![tighten("client_limit", json!({"client": id, "networks": ["192.0.2.0/24"]}))]);
        // the entry is a tightening, never one that names `*` or nothing
        let entry = |target: Value| json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW - 10, "action": "client_limit", "target": target});
        let e = TightenEntry::parse(&entry(want.clone())).unwrap();
        for bad in [json!({"client": id}), json!({"client": id, "relays": ["*"]}), json!({"client": id, "networks": []}), json!({"client": id, "rate": {"per_minute_each": 6001}})] {
            assert!(TightenEntry::parse(&entry(bad.clone())).is_err(), "{bad}");
        }
        // the staged map holds the limit, so the save folds it
        let m = final_map(&d, "", &jwk(), std::slice::from_ref(&e), &[], &[], NOW);
        assert_eq!(m["folded"], json!(["t_acme_000001"]));
        checked(&m);
        // the pinned map does not hold it: folding it is refused
        let mut folds = p.clone();
        folds["folded"] = json!(["t_acme_000001"]);
        assert!(api_map::fold(std::slice::from_ref(&e), &folds).is_err());
    }

    #[test]
    fn explain_names_the_first_failing_check() {
        let p = pinned();
        let wire = json!({"map": p.clone(), "sig": "", "chain": []});
        let vm = crate::api_map::VerifiedApiMap { org: "acme".into(), seq: 1, expires: p["expires"].as_i64().unwrap(), hash: api_map::api_map_hash(&p), signer: "root".into(), wire: wire.as_object().unwrap().clone() };
        let mut store = crate::api_map::ApiMapStore::default();
        store.pin(vm).unwrap();
        let site = ExplainSite { store: Some(&store), licensed: true, owner_active: &anyone, now: NOW };
        let first = |client: &str, path: &str, ip: Option<&str>| explain(&site, "acme", client, "GET", path, ip).unwrap()["first_fail"].clone();
        assert_eq!(first("splunk-scrape", "v1/health", Some("10.40.0.7")), Value::Null);
        let v = explain(&site, "acme", "c_1111111111111111", "GET", "/api/orgs/acme/v1/audit", Some("10.40.0.7")).unwrap();
        assert_eq!(v["checks"].as_array().unwrap().len(), 12);
        assert_eq!((v["first_fail"].clone(), v["checks"][6]["code"].clone()), (json!(6), json!("scope")));
        assert_eq!(first("splunk-scrape", "v1/health", Some("192.0.2.1")), json!(10));
        assert_eq!(first("splunk-scrape", "v1/health", None), json!(10));
        assert_eq!(first("nobody", "v1/health", None), json!(3));
        store.apply_tighten("acme", &json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW, "action": "client_suspend", "target": "c_1111111111111111"})).unwrap();
        let site = ExplainSite { store: Some(&store), licensed: true, owner_active: &anyone, now: NOW };
        assert_eq!(explain(&site, "acme", "splunk-scrape", "GET", "v1/health", Some("10.40.0.7")).unwrap()["first_fail"], json!(4));
        let off = ExplainSite { store: Some(&store), licensed: false, owner_active: &anyone, now: NOW };
        assert_eq!(explain(&off, "acme", "splunk-scrape", "GET", "v1/health", None).unwrap()["first_fail"], json!(1));
        let none = ExplainSite { store: None, licensed: true, owner_active: &anyone, now: NOW };
        assert_eq!(explain(&none, "acme", "splunk-scrape", "GET", "v1/health", None).unwrap()["checks"][2]["code"], json!("map-expired"));
        assert_eq!(explain(&site, "acme", "x", "POST", "oauth/token", None).unwrap_err().message, NOT_RESOURCE_ROUTE);
    }

    #[test]
    fn a_signing_is_judged_by_the_hash_it_asked_for_and_given_up_after_a_day() {
        let p = pinned();
        let sg = Signing { org: "acme".into(), relay: "r_01".into(), request: "rq_1".into(), by: OWNER.into(), at: T, state: "waiting", error: None, map_sha256: api_map::api_map_hash(&p), seq: 1 };
        assert_eq!(Signing::from_json(&sg.to_json()), Some(sg.clone()));
        assert!(sg.judge(&json!({"state": "waiting"}), T + 1000).is_none());
        assert_eq!(sg.judge(&json!({"state": "waiting"}), T + SIGN_WAIT_MS), Some(Err(SIGN_TIMEOUT.into())));
        assert_eq!(sg.judge(&json!({"state": "gone"}), T), Some(Err(SIGN_GONE.into())));
        let mut other = p.clone();
        other["seq"] = json!(9);
        assert_eq!(sg.judge(&json!({"state": "done", "signed": {"map": other, "sig": "", "chain": []}, "signer_policy": {}}), T), Some(Err(SIGN_OTHER_MAP.into())));
        assert!(matches!(sg.judge(&json!({"state": "done", "signed": {"map": p.clone(), "sig": "", "chain": []}, "signer_policy": {"v": 1}}), T), Some(Ok(_))));
        assert_eq!(sg.judge(&json!({"state": "done", "signed": {"map": p, "sig": "", "chain": []}}), T), Some(Err(NO_SIGNER_POLICY.into())));
    }

    /// Revision 4 13.3: the saves of revision 4 fields that need a second admin.
    #[test]
    fn revision_4_saves_that_need_a_second_admin() {
        let meta = json!({"id": "c_00000000000000a1", "kind": "compliance", "state": "active", "scopes": ["compliance.metadata.read", "events.subscribe"],
                          "ceiling": "confidential", "relays": ["*"], "networks": ["10.0.0.0/8"], "credentials": [], "expires": 100});
        let export = json!({"id": "c_00000000000000a2", "kind": "compliance", "state": "active", "scopes": ["compliance.export.request"], "ceiling": "confidential",
                            "relays": ["*"], "networks": [], "credentials": [], "expires": 100,
                            "compliance": {"recipient": {"kid": "r1", "jwk": {"kty": "EC"}}, "job_max_bytes": 10, "day_max_bytes": 10, "jobs_per_day": 1}});
        let dir = json!({"id": "c_00000000000000a3", "kind": "integration", "state": "active", "scopes": ["directory.read", "directory.write"], "ceiling": "confidential",
                         "relays": ["r_01"], "networks": ["20.190.128.0/18"], "credentials": [], "expires": 100});
        let hook = json!({"id": "d_0000000000009e01", "kind": "webhook", "signals": ["events"], "ceiling": "internal", "identities": "pseudonymized",
                          "endpoint": "https://hooks.acme.example/lucid", "settings": {"client": "c_00000000000000a1", "types": [], "signing": "v2a", "verification": "wev"}});
        let base = json!({"clients": [meta, export, dir], "destinations": [hook], "cleared": []});
        assert!(two_person(&base, &base, &[]).is_empty(), "nothing changed");
        let reasons = |draft: &Value| two_person(&base, draft, &[]);
        // a compliance client widened: one more network
        let mut d = base.clone();
        d["clients"][0]["networks"] = json!(["10.0.0.0/8", "192.168.0.0/16"]);
        assert_eq!(reasons(&d), [TWO_COMPLIANCE]);
        // narrowed: its expiry earlier
        let mut d = base.clone();
        d["clients"][0]["expires"] = json!(50);
        assert!(reasons(&d).is_empty());
        // a new recipient key
        let mut d = base.clone();
        d["clients"][1]["compliance"]["recipient"]["kid"] = json!("r2");
        assert_eq!(reasons(&d), [TWO_RECIPIENT]);
        // a lowered cap is not a widening
        let mut d = base.clone();
        d["clients"][1]["compliance"]["jobs_per_day"] = json!(0);
        assert!(reasons(&d).is_empty());
        // directory.write widened (ruling R4-D4)
        let mut d = base.clone();
        d["clients"][2]["relays"] = json!(["r_01", "r_02"]);
        assert_eq!(reasons(&d), [TWO_DIRECTORY]);
        // the events destination of a compliance client widened (a higher ceiling)
        let mut d = base.clone();
        d["destinations"][0]["ceiling"] = json!("confidential");
        assert_eq!(reasons(&d), [TWO_EVENTS_SENSITIVE]);
        // a webhook without verification, or signed v1
        let mut d = base.clone();
        d["destinations"][0]["settings"]["verification"] = json!("none");
        assert_eq!(reasons(&d), [TWO_WEBHOOK_WEAK]);
        let mut d = base.clone();
        d["destinations"][0]["settings"]["signing"] = json!("v1");
        assert_eq!(reasons(&d), [TWO_WEBHOOK_WEAK]);
        // clearing a console journal entry (client_lower_caps or client_drop_recipient)
        let mut d = base.clone();
        d["cleared"] = json!(["k_acme_000001"]);
        assert_eq!(reasons(&d), [TWO_CLEARED]);
    }

    /// Revision 5 13.2 (slice 1c3): the saves of revision 5 fields this slice owns that need a second admin.
    #[test]
    fn revision_5_saves_that_need_a_second_admin() {
        let dlg = json!({"id": "c_0b1c2d3e4f5a6b7c", "kind": "agent_delegated", "state": "active", "scopes": ["monitor.read"], "ceiling": "internal", "relays": ["*"],
                         "networks": [], "credentials": [], "expires": 100, "delegation": {"groups": ["g1"], "denied": ["eve@acme.example", "bob@acme.example"]}});
        let idp = json!({"id": "okta", "provider": "okta", "issuer": "https://acme.okta.com", "algs": ["RS256"], "max_age_s": 300, "private_ok": false, "state": "active"});
        let base = json!({"clients": [dlg], "idps": [idp], "cleared": []});
        let reasons = |draft: &Value| two_person(&base, draft, &[]);
        assert!(reasons(&base).is_empty());
        // a principal dropped from denied
        let mut d = base.clone();
        d["clients"][0]["delegation"]["denied"] = json!(["bob@acme.example"]);
        // slice 1c7: any widening of a delegated client is also TWO_CONTENT (13.2, R5-4)
        assert_eq!(reasons(&d), [TWO_UNDENY, TWO_CONTENT]);
        // one more denied is a narrowing
        let mut d = base.clone();
        d["clients"][0]["delegation"]["denied"] = json!(["eve@acme.example", "bob@acme.example", "zed@acme.example"]);
        assert!(reasons(&d).is_empty());
        // loopback_ok turned on (and kept on is nothing new)
        let mut d = base.clone();
        d["clients"][0]["loopback_ok"] = json!(true);
        assert_eq!(reasons(&d), [TWO_LOOPBACK, TWO_CONTENT]);
        assert!(two_person(&d, &d, &[]).is_empty());
        // an idp's private_ok turned on, or a new idp with it
        let mut d = base.clone();
        d["idps"][0]["private_ok"] = json!(true);
        // slice 1c7: an added or widened idp is also TWO_IDP (13.2)
        assert_eq!(reasons(&d), [TWO_IDP_PRIVATE, TWO_IDP]);
        let mut d = base.clone();
        let mut other = d["idps"][0].clone();
        other["id"] = json!("entra");
        other["private_ok"] = json!(true);
        d["idps"].as_array_mut().unwrap().push(other);
        assert_eq!(reasons(&d), [TWO_IDP_PRIVATE, TWO_IDP]);
        // clearing any k_ id stays two-person
        let mut d = base.clone();
        d["cleared"] = json!(["k_acme_000007"]);
        assert_eq!(reasons(&d), [TWO_CLEARED]);
    }

    // ── revision 4 13.1, 13.2 (slice 1b8): compliance and directory clients, keys, events status, presets ──

    /// A P-256 public point (the RFC 7515 A.3 example key).
    const RX: &str = "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU";
    const RY: &str = "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0";
    const EXPORT: &str = "c_1b2c3d4e5f607182";
    const TENANT: &str = "ce5f061f-abe6-4e40-9615-301f87bcb7f0";

    fn recipient_jwk() -> Value {
        json!({"kty": "EC", "crv": "P-256", "x": RX, "y": RY})
    }

    /// The export client of 2.1 as a client body.
    fn export_body() -> Value {
        json!({"name": "ediscovery-export", "kind": "compliance", "owner": OWNER, "reach": "R1", "scopes": ["compliance.export.request"],
               "ceiling": "confidential", "relays": ["*"], "networks": ["10.40.0.0/23"], "mtls_required": true,
               "rate": {"per_minute_each": 60, "per_day_each": 20000}, "credentials": [{"type": "mtls", "serial": "0a1b2c3d4e5f", "spki": "ab".repeat(32)}],
               "compliance": {"recipient": {"kid": "rcpt-2026-11", "jwk": recipient_jwk()}, "job_max_bytes": 5368709120i64, "day_max_bytes": 21474836480i64, "jobs_per_day": 5},
               "days": 300})
    }

    /// A pinned map holding the export client.
    fn pinned_export() -> Value {
        let mut d = Draft::new(&ctx(None, &[]), "st_0".into(), T);
        add_client(&mut d, &export_body(), EXPORT.into(), NOW).unwrap();
        d.map["seq"] = json!(3);
        d.map
    }

    /// The SubjectPublicKeyInfo PEM of the RFC 7515 A.3 point.
    fn recipient_pem() -> String {
        let mut der = vec![0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04];
        der.extend(crate::codec::unb64u(RX).unwrap());
        der.extend(crate::codec::unb64u(RY).unwrap());
        format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", crate::meet_json::b64(&der))
    }

    #[test]
    fn client_view_shows_the_compliance_caps_and_thumbprint_and_the_directory_block() {
        let mut d = Draft::new(&ctx(None, &[]), "st_c".into(), T);
        add_client(&mut d, &export_body(), EXPORT.into(), NOW).unwrap();
        add_client(&mut d, &client_body("plain"), "c_3333333333333333".into(), NOW).unwrap();
        let directory = json!({"provider": "entra", "resource": "https://sso.acme.example:8443/api/orgs/acme/scim/v2", "domains": ["acme.example"]});
        let mut entra = client_body("entra-scim");
        entra["kind"] = json!("integration");
        entra["scopes"] = json!(["directory.read", "directory.write"]);
        entra["ceiling"] = json!("confidential");
        entra["credentials"] = json!([{"type": "entra_wif", "cloud": "public", "tenant": TENANT, "audience": "https://console.acme.example:7443/api/orgs/acme",
                                       "azp": "cb1d50fe-8ed0-4944-9e7d-5981aad3bc4b", "expires": NOW + 86_400 * 300}]);
        entra["directory"] = directory.clone();
        add_client(&mut d, &entra, "c_2c3d4e5f60718293".into(), NOW).unwrap();
        let clients = d.map["clients"].as_array().unwrap().clone();
        assert_eq!((clients[0]["reach"].as_str(), clients[1]["reach"].as_str()), (Some("R1"), Some("R0")), "the body's reach, else R0");
        let v = client_view(&clients[0], &[], &anyone, NOW);
        let jkt = crate::api_token::jwk_thumbprint(&crate::api_token::parse_jwk(&recipient_jwk(), 2048).unwrap());
        assert_eq!(v["reach"], "R1");
        assert_eq!(v["compliance"], json!({"recipient": {"kid": "rcpt-2026-11", "jkt": jkt}, "job_max_bytes": 5368709120i64, "day_max_bytes": 21474836480i64, "jobs_per_day": 5}));
        let shown = crate::codec::stringify(&v);
        assert!(!shown.contains(RX) && !shown.contains("jwk"), "never the key: {shown}");
        assert!(client_view(&clients[1], &[], &anyone, NOW).get("compliance").is_none());
        let e = client_view(&clients[2], &[], &anyone, NOW);
        assert_eq!(e["directory"], directory);
        assert_eq!(e["credentials"][0], json!({"type": "entra_wif", "hint": TENANT, "expires": NOW + 86_400 * 300, "cloud": "public", "tenant": TENANT,
                                               "audience": "https://console.acme.example:7443/api/orgs/acme", "azp": "cb1d50fe-8ed0-4944-9e7d-5981aad3bc4b"}));
        // `null` removes a block (a map holds no null)
        update_client(&mut d, "c_2c3d4e5f60718293", &json!({"directory": null}), None, NOW).unwrap();
        update_client(&mut d, EXPORT, &json!({"compliance": null}), None, NOW).unwrap();
        assert!(find(&d.map, "clients", "c_2c3d4e5f60718293").unwrap().get("directory").is_none());
        assert!(find(&d.map, "clients", EXPORT).unwrap().get("compliance").is_none());
        assert!(!crate::codec::stringify(&d.map).contains("null"));
    }

    #[test]
    fn map_view_lists_webhook_and_federation_keys_with_dropped() {
        let mut m = pinned_export();
        assert_eq!(map_view(&m, 3, &[], &[], &anyone, NOW)["webhook_keys"], json!([]));
        assert!(map_view(&m, 3, &[], &[], &anyone, NOW)["federation"].is_null());
        // API-1d 7.14: the agents the client editor offers, and `spokes` as the map holds it
        assert!(map_view(&m, 3, &[], &[], &anyone, NOW)["a2a"].is_null());
        let mut a = m.clone();
        a["a2a"] = json!({"jwks": [], "well_known": "a_7c1d2e3f4a5b6c7d", "agents": [{"id": "a_7c1d2e3f4a5b6c7d", "name": "build", "description": "d", "version": "1",
                          "connector": "k_1a2b3c4d5e6f7081", "hub": "c_9a8b7c6d5e4f3a2b", "skills": [{"id": "lint", "name": "Lint", "description": "x"}]}]});
        a["spokes"] = json!({"root": "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0", "root_spki": "ab", "relays": []});
        let av = map_view(&a, 3, &[], &[], &anyone, NOW);
        assert_eq!(av["a2a"], json!({"agents": [{"id": "a_7c1d2e3f4a5b6c7d", "name": "build", "connector": "k_1a2b3c4d5e6f7081", "hub": "c_9a8b7c6d5e4f3a2b",
                                                 "skills": [{"id": "lint", "name": "Lint"}]}], "well_known": "a_7c1d2e3f4a5b6c7d"}));
        assert_eq!(av["spokes"], a["spokes"]);
        m["webhook_keys"] = json!([{"kid": "wk-1", "public": format!("whpk_{}", "A".repeat(43)), "nbf": NOW - 10, "exp": NOW + 86_400},
                                   {"kid": "wk-2", "public": format!("whpk_{}", "B".repeat(43)), "nbf": NOW, "exp": NOW + 86_400}]);
        m["federation"] = json!({"issuer": "https://id.acme.example/lucid/acme",
                                 "keys": [{"kty": "RSA", "kid": "fk-1", "n": "N".repeat(512), "e": "AQAB", "alg": "RS256", "use": "sig", "nbf": NOW - 10, "exp": NOW + 86_400}]});
        let entry = |cseq: u64, action: &str, kid: &str| {
            ConsoleEntry::parse(&json!({"id": format!("k_acme_{cseq:06}"), "cseq": cseq, "ts": NOW, "action": action, "target": {"kid": kid}, "reach": "console"})).unwrap()
        };
        let console = [entry(1, "webhook_key_drop", "wk-1"), entry(2, "federation_drop_key", "fk-1")];
        let v = map_view(&m, 3, &[], &console, &anyone, NOW);
        assert_eq!(v["webhook_keys"], json!([{"kid": "wk-1", "public": format!("whpk_{}", "A".repeat(43)), "nbf": NOW - 10, "exp": NOW + 86_400, "dropped": true},
                                             {"kid": "wk-2", "public": format!("whpk_{}", "B".repeat(43)), "nbf": NOW, "exp": NOW + 86_400, "dropped": false}]));
        assert_eq!(v["federation"], json!({"issuer": "https://id.acme.example/lucid/acme", "keys": [{"kid": "fk-1", "nbf": NOW - 10, "exp": NOW + 86_400, "dropped": true}]}));
        let plain = map_view(&m, 3, &[], &[], &anyone, NOW);
        assert_eq!((plain["webhook_keys"][0]["dropped"].clone(), plain["federation"]["keys"][0]["dropped"].clone()), (json!(false), json!(false)));
        assert!(!crate::codec::stringify(&v).contains(&"N".repeat(512)), "never the modulus");
        // the clients an events destination may name
        assert_eq!(events_clients(&m), json!([]));
        let both = json!({"clients": [{"id": "c_00000000000000a1", "name": "meta", "scopes": ["compliance.metadata.read", "events.subscribe"]},
                                      {"id": "c_00000000000000a2", "name": "scrape", "scopes": ["monitor.read"]}]});
        assert_eq!(events_clients(&both), json!([{"id": "c_00000000000000a1", "name": "meta"}]));
    }

    #[test]
    fn destination_view_carries_the_events_status() {
        let x = json!({"id": "d_3d4e5f6071829304", "name": "ServiceNow events", "kind": "webhook", "preset": "webhook", "credential": {"type": "none"}});
        let events = json!({"paused": false, "retrying": true, "cursor": "c-17", "blocked": "unverified", "verification": "unverified", "signing": "v2a"});
        let st = json!({"state": "retrying", "backlog_bytes": 10, "oldest_s": 3, "events": events});
        let v = destination_view(&x, "pinned", false, None, Some(&st), true, Vec::new());
        assert_eq!(v["status"]["events"], events);
        assert_eq!(v["status"]["state"], "retrying");
        let mut quiet = st.clone();
        quiet.as_object_mut().unwrap().remove("events");
        assert!(destination_view(&x, "pinned", false, None, Some(&quiet), true, Vec::new())["status"].get("events").is_none());
        assert!(destination_view(&x, "pinned", false, None, None, true, Vec::new())["status"].is_null());
    }

    #[test]
    fn presets_carry_events_and_the_webhook_preset() {
        let all = presets_view();
        let of = |id: &str| all.as_array().unwrap().iter().find(|p| p["id"] == id).cloned().unwrap();
        assert_eq!(of("webhook"), json!({"id": "webhook", "kind": "webhook", "credential_types": ["none", "token", "mtls"], "signals": ["events"]}));
        assert_eq!(of("datadog")["signals"], json!(["metrics", "logs", "traces", "audit", "events"]));
        assert_eq!(of("splunk_hec")["signals"], json!(["logs", "audit", "events"]));
        assert_eq!(of("sentinel")["signals"], json!(["logs", "audit", "events"]));
        assert_eq!(of("syslog_cef")["signals"], json!(["logs", "audit"]), "syslog_cef carries no events");
        assert_eq!(all.as_array().unwrap().len(), crate::api_export_wire::PRESETS.len() + 1);
    }

    #[test]
    fn a_webhook_destination_is_staged_as_the_map_takes_it() {
        let mut d = Draft::new(&ctx(None, &[]), "st_w".into(), T);
        let body = |cred: Value| {
            json!({"name": "ServiceNow events", "kind": "webhook", "preset": "webhook", "signals": ["events"], "ceiling": "internal", "identities": "pseudonymized",
                   "failover": false, "private_ok": false, "endpoint": "https://acme.service-now.com/api/x_acme/lucid/events",
                   "settings": {"client": "c_0a1b2c3d4e5f6071", "types": ["hold.placed"], "signing": "v2a", "verification": "wev"},
                   "credential": cred, "queue": {"max_bytes": 1073741824, "max_age_s": 259200}})
        };
        add_destination(&mut d, &body(json!({"type": "none"})), "d_3d4e5f6071829304".into()).unwrap();
        let x = find(&d.map, "destinations", "d_3d4e5f6071829304").unwrap().clone();
        assert_eq!(x["credential"], json!({"type": "none"}), "a webhook's none is its type alone");
        assert_eq!(x["settings"]["client"], "c_0a1b2c3d4e5f6071");
        assert_eq!((x["kind"].as_str(), x["preset"].as_str(), x["signals"].clone()), (Some("webhook"), Some("webhook"), json!(["events"])));
        let mut token = body(json!({"type": "token"}));
        token["name"] = json!("Other events");
        add_destination(&mut d, &token, "d_4e5f607182930415".into()).unwrap();
        assert_eq!(find(&d.map, "destinations", "d_4e5f607182930415").unwrap()["credential"], json!({"type": "token", "ref": "secret:d_4e5f607182930415"}));
        assert_eq!(d.tests_needed(), vec!["d_3d4e5f6071829304", "d_4e5f607182930415"]);
    }

    #[test]
    fn a_recipient_key_comes_from_a_jwk_or_a_pem() {
        let jkt = crate::api_token::jwk_thumbprint(&crate::api_token::parse_jwk(&recipient_jwk(), 2048).unwrap());
        let mut named = recipient_jwk();
        named["kid"] = json!("rcpt-2026-11");
        named["use"] = json!("enc");
        assert_eq!(recipient_of(Some(&named), None).unwrap(), ("rcpt-2026-11".to_string(), recipient_jwk(), jkt.clone()), "the map's JWK has kty, crv, x and y only");
        let generated = format!("rcpt-{}", &jkt[..16]);
        assert_eq!(recipient_of(Some(&recipient_jwk()), None).unwrap().0, generated);
        let mut odd = recipient_jwk();
        odd["kid"] = json!("not a kid!");
        assert_eq!(recipient_of(Some(&odd), None).unwrap().0, generated);
        // the same key as a SubjectPublicKeyInfo PEM
        assert_eq!(recipient_of(None, Some(&recipient_pem())).unwrap(), (generated.clone(), recipient_jwk(), jkt));
        // refusals
        let mut private = recipient_jwk();
        private["d"] = json!("A".repeat(43));
        assert_eq!(recipient_of(Some(&private), None).unwrap_err().message, RECIPIENT_PRIVATE);
        assert_eq!(recipient_of(None, Some("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")).unwrap_err().message, RECIPIENT_PRIVATE);
        assert_eq!(recipient_of(Some(&recipient_jwk()), Some(&recipient_pem())).unwrap_err().message, RECIPIENT_ONE);
        assert_eq!(recipient_of(None, None).unwrap_err().message, RECIPIENT_ONE);
        let mut p384 = recipient_jwk();
        p384["crv"] = json!("P-384");
        assert_eq!(recipient_of(Some(&p384), None).unwrap_err().message, RECIPIENT_KEY);
        let off_curve = json!({"kty": "EC", "crv": "P-256", "x": "A".repeat(43), "y": "A".repeat(43)});
        assert_eq!(recipient_of(Some(&off_curve), None).unwrap_err().message, RECIPIENT_KEY);
        let two = format!("{}{}", recipient_pem(), recipient_pem());
        assert_eq!(recipient_of(None, Some(&two)).unwrap_err().message, RECIPIENT_KEY, "exactly one PUBLIC KEY block");
        // staged on the draft client
        let p = pinned_export();
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_r".into(), T);
        let (kid, jwk, _) = recipient_of(None, Some(&recipient_pem())).unwrap();
        set_recipient(&mut d, EXPORT, &kid, jwk.clone()).unwrap();
        assert_eq!(find(&d.map, "clients", EXPORT).unwrap()["compliance"]["recipient"], json!({"kid": generated, "jwk": jwk}));
        assert_eq!(two_person(&d.base, &d.map, &[]), [TWO_RECIPIENT]);
        assert_eq!(set_recipient(&mut d, "c_0000000000000000", &kid, json!({})).unwrap_err().code, "not-found");
    }

    #[test]
    fn caps_below_the_pinned_client_are_the_lowering_to_journal() {
        let p = pinned_export();
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_k".into(), T);
        let target = set_caps(&mut d, EXPORT, &json!({"jobs_per_day": 2, "job_max_bytes": 6442450944i64}), Some(&p)).unwrap();
        assert_eq!(target, Some(json!({"client": EXPORT, "jobs_per_day": 2})), "only the lowered cap");
        let block = &find(&d.map, "clients", EXPORT).unwrap()["compliance"];
        assert_eq!((block["jobs_per_day"].as_i64(), block["job_max_bytes"].as_i64()), (Some(2), Some(6442450944)), "both staged");
        assert_eq!(set_caps(&mut d, EXPORT, &json!({"day_max_bytes": 21474836480i64}), Some(&p)).unwrap(), None, "an equal cap lowers nothing");
        assert_eq!(set_caps(&mut d, EXPORT, &json!({"jobs_per_day": 1}), None).unwrap(), None, "no pinned client: nothing to lower");
        assert_eq!(set_caps(&mut d, EXPORT, &json!({"max": 1}), Some(&p)).unwrap_err().code, "invalid");
        assert_eq!(set_caps(&mut d, EXPORT, &json!({"jobs_per_day": "2"}), Some(&p)).unwrap_err().code, "invalid");
        assert_eq!(set_caps(&mut d, EXPORT, &json!({}), Some(&p)).unwrap_err().code, "invalid");
        assert_eq!(set_caps(&mut d, "c_0000000000000000", &json!({"jobs_per_day": 1}), Some(&p)).unwrap_err().code, "not-found");
    }

    #[test]
    fn a_dropped_recipient_leaves_the_draft_client() {
        let p = pinned_export();
        assert_eq!(recipient_kid(Some(&p), EXPORT).as_deref(), Some("rcpt-2026-11"));
        assert_eq!(recipient_kid(Some(&p), "c_0000000000000000"), None);
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_d".into(), T);
        assert!(!drop_recipient(&mut d, EXPORT, "rcpt-other"), "another staged key stays");
        assert!(drop_recipient(&mut d, EXPORT, "rcpt-2026-11"));
        assert!(find(&d.map, "clients", EXPORT).unwrap()["compliance"].get("recipient").is_none());
        assert!(d.changes.last().unwrap().contains("rcpt-2026-11"));
        assert!(!drop_recipient(&mut d, EXPORT, "rcpt-2026-11"), "already gone");
    }

    // ── API-1d 2.3, 4.2, 5.1 ──

    const HUB: &str = "c_9a8b7c6d5e4f3a2b";
    const SPOKE_A: &str = "n_a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const SPOKE_B: &str = "n_b1b2c3d4e5f60718293a4b5c6d7e8f90";
    const SPOKES_RELAY: &str = "r_00000000000000d1";

    fn hub(targets: Value) -> Value {
        json!({"id": HUB, "kind": "spokes_hub", "spokes": {"targets": targets},
               "credentials": [{"type": "spokes_node", "node": "n_5e6f708192a3b4c5d6e7f8091a2b3c4d", "serial": "0a1b", "spki": "ab".repeat(32), "expires": NOW + 86_400, "key_store": "pkcs11"}]})
    }

    #[test]
    fn narrowing_spokes_targets_journals_client_drop_target_per_dropped_spoke() {
        // a dropped spoke: one entry each (`ConsoleApi::append` journals the fallback while `spokes` is closed)
        assert_eq!(target_drops(HUB, &hub(json!([SPOKE_A, SPOKE_B])), &hub(json!([SPOKE_B]))), vec![tighten("client_drop_target", json!({"client": HUB, "spoke": SPOKE_A}))]);
        // `*` narrowed to a list names no spoke: the client is suspended (as strict)
        assert_eq!(target_drops(HUB, &hub(json!(["*"])), &hub(json!([SPOKE_A]))), vec![tighten("client_suspend", json!(HUB))]);
        // widenings and other kinds journal nothing
        assert!(target_drops(HUB, &hub(json!([SPOKE_A])), &hub(json!([SPOKE_A, SPOKE_B]))).is_empty());
        assert!(target_drops(HUB, &hub(json!([SPOKE_A])), &hub(json!(["*"]))).is_empty());
        let mut monitor = hub(json!([SPOKE_A]));
        monitor["kind"] = json!("monitoring");
        assert!(target_drops(HUB, &monitor, &hub(json!([]))).is_empty());
        // through the client editor's route: the narrowing is journaled and staged
        let mut p = pinned();
        p["clients"][0]["kind"] = json!("spokes_hub");
        p["clients"][0]["spokes"] = json!({"targets": [SPOKE_A, SPOKE_B]});
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_t".into(), T);
        let j = update_client(&mut d, "c_1111111111111111", &json!({"spokes": {"targets": [SPOKE_B]}}), Some(&p), NOW).unwrap();
        assert_eq!(j, vec![tighten("client_drop_target", json!({"client": "c_1111111111111111", "spoke": SPOKE_A}))]);
        assert_eq!(find(&d.map, "clients", "c_1111111111111111").unwrap()["spokes"], json!({"targets": [SPOKE_B]}));
    }

    #[test]
    fn removing_a_spokes_node_credential_drops_it_by_serial() {
        let mut p = pinned();
        p["clients"][0]["credentials"] = hub(json!([SPOKE_A]))["credentials"].clone();
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_s".into(), T);
        let j = update_client(&mut d, "c_1111111111111111", &json!({"credentials": []}), Some(&p), NOW).unwrap();
        assert_eq!(j, vec![tighten("client_drop_credential", json!({"client": "c_1111111111111111", "kid": "0a1b"}))]);
    }

    /// API-1d 4.2: a pasted service hub certificate is checked against the console's Remote Spokes root (which must be
    /// the draft's `spokes.root`) and the CRL, and becomes the credential filled from it; a credential the client
    /// held stays; one given with its fields is refused; a revoked certificate, another root or no trust is refused.
    #[test]
    fn a_pasted_service_hub_certificate_becomes_its_spokes_node_credential() {
        use crate::api_spokes_cred::tests as cred;
        let id = "c_1111111111111111";
        let t = cred::trust_revoking(&[]);
        let mut p = pinned();
        p["spokes"] = json!({"root": t.root_id, "root_spki": "ab".repeat(32), "relays": [SPOKES_RELAY]});
        p["clients"][0]["kind"] = json!("spokes_hub");
        p["clients"][0]["ceiling"] = json!("confidential");
        p["clients"][0]["credentials"] = hub(json!([SPOKE_A]))["credentials"].clone();
        let held = p["clients"][0]["credentials"].as_array().unwrap().clone();
        let pasted = json!({"type": "spokes_node", "cert": cred::service(None), "key_store": "os_store"});
        let staged = |creds: Value, trust: Option<&crate::identity::TrustStore>, map: &Value| {
            let mut d = Draft::new(&ctx(Some(map), &[]), "st_p".into(), T);
            update_client(&mut d, id, &json!({ "credentials": creds }), Some(map), cred::NOW).unwrap();
            spokes_credentials(&mut d, id, &held, trust, cred::NOW).map(|()| client_credentials(&d, id))
        };
        // the renewal overlap: the held credential stays, the pasted one is filled from its certificate
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_p".into(), T);
        update_client(&mut d, id, &json!({ "credentials": [held[0].clone(), pasted.clone()] }), Some(&p), cred::NOW).unwrap();
        assert!(pastes_spokes_cert(&d, id));
        spokes_credentials(&mut d, id, &held, Some(&t), cred::NOW).unwrap();
        let want = crate::api_spokes_cred::credential_of(&cred::service(None), &t, "confidential", "os_store", cred::NOW).unwrap();
        assert_eq!(want["serial"], json!(cred::hub_serial()));
        assert_eq!(client_credentials(&d, id), vec![held[0].clone(), want.clone()]);
        assert!(!pastes_spokes_cert(&d, id));
        // the fields given directly, or beside the certificate: refused
        let mut direct = want.clone();
        direct["serial"] = json!("ff");
        assert_eq!(staged(json!([direct]), Some(&t), &p).unwrap_err().message, SPOKES_PASTE);
        let mut both = pasted.clone();
        both["node"] = want["node"].clone();
        assert_eq!(staged(json!([both]), Some(&t), &p).unwrap_err().message, SPOKES_PASTE);
        // revoked by the relays' CRL, no trust, or another root than spokes.root
        let revoking = cred::trust_revoking(&[cred::hub_serial()]);
        let e = staged(json!([pasted.clone()]), Some(&revoking), &p).unwrap_err();
        assert_eq!(e.message, SPOKES_CERT_UNTRUSTED);
        assert_eq!(staged(json!([pasted.clone()]), None, &p).unwrap_err().code, "invalid");
        let mut elsewhere = p.clone();
        elsewhere["spokes"]["root"] = json!("n_0f1e2d3c4b5a69788796a5b4c3d2e1f0");
        assert!(staged(json!([pasted]), Some(&t), &elsewhere).unwrap_err().message.contains("bind a spokes relay first"));
    }

    #[test]
    fn binding_a_spokes_relay_stages_spokes_relays_and_is_a_two_person_save() {
        let p = pinned();
        let root = ("n_0f1e2d3c4b5a69788796a5b4c3d2e1f0", "ab".repeat(32));
        let mut d = Draft::new(&ctx(Some(&p), &[]), "st_b".into(), T);
        // no root yet: a first bind needs the console's Remote Spokes root; an unbind of nothing is stale
        assert_eq!(stage_spokes_relay(&mut d, SPOKES_RELAY, true, None).unwrap_err().code, "invalid");
        assert_eq!(stage_spokes_relay(&mut d, SPOKES_RELAY, false, None).unwrap_err().code, "stale");
        assert_eq!(stage_spokes_relay(&mut d, "relay-1", true, Some((root.0, &root.1))).unwrap_err().code, "invalid");
        stage_spokes_relay(&mut d, SPOKES_RELAY, true, Some((root.0, &root.1))).unwrap();
        assert_eq!(d.map["spokes"], json!({"root": root.0, "root_spki": root.1, "relays": [SPOKES_RELAY]}));
        assert_eq!(d.changes.last().unwrap(), &format!("Bind spokes relay {SPOKES_RELAY}"));
        assert!(two_person(&d.base, &d.map, &[]).contains(&TWO_SPOKES_BIND));
        // binding again changes nothing; unbinding stages the removal and is no widening
        stage_spokes_relay(&mut d, SPOKES_RELAY, true, None).unwrap();
        assert_eq!(d.map["spokes"]["relays"], json!([SPOKES_RELAY]));
        let mut bound = p.clone();
        bound["spokes"] = d.map["spokes"].clone();
        let mut u = Draft::new(&ctx(Some(&bound), &[]), "st_u".into(), T);
        stage_spokes_relay(&mut u, SPOKES_RELAY, false, None).unwrap();
        assert_eq!(u.map["spokes"]["relays"], json!([]));
        assert!(!two_person(&u.base, &u.map, &[]).contains(&TWO_SPOKES_BIND));
    }

    /// API-1 revision 8 3: presence.write added or widened is a two-person save; presence.read is step-up only.
    #[test]
    fn presence_write_added_or_widened_needs_a_second_admin() {
        let reader = json!({"id": "c_00000000000000b1", "kind": "integration", "state": "active", "scopes": ["presence.read"], "ceiling": "confidential",
                            "relays": ["r_01"], "networks": [], "credentials": [], "expires": 100});
        let base = json!({"clients": [reader], "destinations": [], "cleared": []});
        let mut more = base.clone();
        more["clients"][0]["relays"] = json!(["r_01", "r_02"]);
        assert!(two_person(&base, &more, &[]).is_empty(), "a presence.read client widened is step-up only");
        let mut write = base.clone();
        write["clients"][0]["scopes"] = json!(["presence.read", "presence.write"]);
        assert_eq!(two_person(&base, &write, &[]), [TWO_PRESENCE]);
        let mut wider = write.clone();
        wider["clients"][0]["relays"] = json!(["r_01", "r_02"]);
        assert_eq!(two_person(&write, &wider, &[]), [TWO_PRESENCE]);
        let mut narrower = write.clone();
        narrower["clients"][0]["expires"] = json!(50);
        assert!(two_person(&write, &narrower, &[]).is_empty());
    }
}
