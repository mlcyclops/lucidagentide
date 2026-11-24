// Contract API-1 revision 4 section 8 (docs/api/contract-r4-1b.md), the console end of outbound workload federation:
// the org federation keys (RSA 3072, RS256, because Entra only accepts RS256 issuers; drawn on the console and sealed
// as `api-federation-<org>-<kid>`, never leaving it), the documents an admin publishes at the issuer (OpenID discovery
// and JWKS, 8.1; the front door serves them itself at `I/federation` when that is the issuer), the Lucid subject
// tokens (8.2: minted per exchange, five minutes, never stored or logged), the console's `SubjectSigner` behind the
// `entra_federated` and `gcp_federated` destination credentials (the exchanges themselves are `api_export_wire`), and
// the staging and console-journal steps of the Settings routes (13.1).
//
// Federation is console only in this revision (R4-D11): relays hold no federation key and never build a federated
// credential (`api_export::credential_of` never yields one), so the console stays the only egress that uses it.
//
// Signing follows the pinned map: a key signs only while the map lists it with the same modulus, inside its
// `nbf`/`exp`, with no `federation_drop_key` for its kid in the console journal (2.4), and the map has not expired.
// The latest `nbf` among those signs. A dropped key leaves the published key sets at once and raises the attention
// item `federation-jwks-republish` until an admin confirms the externally hosted key sets no longer list it.

use crate::api_cjournal::{key_dropped, ConsoleEntry};
use crate::api_export_wire::{Credential, SinkError, Subject, SubjectSigner};
use crate::codec::{b64u, stringify};
use crate::console::ApiError;
use crate::console_api::ConsoleApi;
use crate::console_api_ui::Draft;
use crate::fleet_ca::{vault_do, VaultLock};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{KeyPair, RsaKeyPair, RSA_PKCS1_SHA256};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Weak};

/// 8.2: a subject token lives five minutes.
pub const SUBJECT_SECONDS: i64 = 300;
/// 8.1: a rotated-in key is listed (and published) at least 24 hours before the console signs with it.
pub const PUBLISH_LEAD_S: i64 = 86_400;
/// How long a key drawn by the console is listed (2.2 allows at most 400 days).
pub const KEY_DAYS: i64 = 365;
/// 2.2: `federation.keys` holds 1 or 2 keys.
pub const KEYS_MAX: usize = 2;
/// 8.1: the front door's own issuer path under I.
pub const FRONT_DOOR_PATH: &str = "/federation";
/// The `federation_drop_key` confirmations of `federation-jwks-republish` (org -> kids), under the console's state.
pub const REPUBLISHED_FILE: &str = "api-federation-republished.json";
/// 19.3: outbound federation stays off until this release gate is verified (Entra and Google accept the documents of
/// 8.1); a disabled gate turns its feature off (ID-1 2.12).
pub const DISCOVERY_GATE: &str = "G-FED-DISCOVERY";
/// 19.3: `entra_federated` credentials of `cloud: usgov` also wait for the Azure Government gate.
pub const USGOV_GATE: &str = crate::api_entra::USGOV_GATE;
const DAY: i64 = 86_400;
const DROP: &str = "federation_drop_key";

/// The sealed name of an org's federation key (PKCS#8).
pub fn seal_name(org: &str, kid: &str) -> String {
    format!("api-federation-{org}-{kid}")
}

/// `n` and `e` of an RSAPublicKey DER (SEQUENCE { INTEGER, INTEGER }), without leading zero bytes.
fn rsa_public_parts(der: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let seq = crate::der::tlv(der).filter(|t| t.tag == 0x30)?;
    let n = crate::der::tlv(seq.value).filter(|t| t.tag == 0x02)?;
    let e = crate::der::tlv(n.rest).filter(|t| t.tag == 0x02)?;
    let strip = |v: &[u8]| {
        let i = v.iter().position(|b| *b != 0).unwrap_or(v.len().saturating_sub(1));
        v[i..].to_vec()
    };
    Some((strip(n.value), strip(e.value)))
}

/// One org federation key: the RSA pair (sealed as PKCS#8) and its kid.
pub struct FedKey {
    pair: RsaKeyPair,
    kid: String,
}

impl std::fmt::Debug for FedKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FedKey({:?}, <sealed>)", self.kid)
    }
}

impl FedKey {
    /// A fresh RSA 3072 key drawn by AWS-LC, and its PKCS#8 bytes for the sealed store.
    pub fn generate(kid: &str) -> Result<(FedKey, Vec<u8>), String> {
        use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
        let pair = RsaKeyPair::generate(aws_lc_rs::rsa::KeySize::Rsa3072).map_err(|_| "a federation key could not be drawn".to_owned())?;
        let pkcs8: Pkcs8V1Der = pair.as_der().map_err(|_| "a federation key could not be encoded".to_owned())?;
        let der = pkcs8.as_ref().to_vec();
        Ok((FedKey::from_pkcs8(kid, &der)?, der))
    }

    /// A key from its sealed PKCS#8 bytes: RSA of 3072 to 4096 bits only (2.2).
    pub fn from_pkcs8(kid: &str, der: &[u8]) -> Result<FedKey, String> {
        let pair = RsaKeyPair::from_pkcs8(der).map_err(|_| "a sealed federation key does not read".to_owned())?;
        if !(384..=512).contains(&pair.public_modulus_len()) {
            return Err("a federation key must be RSA of 3072 to 4096 bits".into());
        }
        Ok(FedKey { pair, kid: kid.to_owned() })
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// The public JWK as published (`kty`, `kid`, `n`, `e`, `alg` RS256, `use` sig); the map's entry adds `nbf`, `exp`.
    pub fn public_jwk(&self) -> Value {
        let (n, e) = rsa_public_parts(self.pair.public_key().as_ref()).unwrap_or_default();
        json!({"kty": "RSA", "kid": self.kid, "n": b64u(&n), "e": b64u(&e), "alg": "RS256", "use": "sig"})
    }

    fn sign(&self, msg: &[u8]) -> Result<Vec<u8>, String> {
        let mut sig = vec![0u8; self.pair.public_modulus_len()];
        self.pair.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), msg, &mut sig).map_err(|_| "the federation key could not sign".to_owned())?;
        Ok(sig)
    }
}

// ── documents (8.1) ──────────────────────────────────────────────────────────────────────────────────────────────

/// The OpenID discovery document of `issuer`, with exactly the fields of 8.1.
pub fn discovery(issuer: &str) -> Value {
    json!({"issuer": issuer, "jwks_uri": format!("{}/jwks.json", issuer.trim_end_matches('/')),
           "response_types_supported": ["id_token"], "subject_types_supported": ["public"],
           "id_token_signing_alg_values_supported": ["RS256"]})
}

/// The JWKS of a `federation` block: each key's public members (no `nbf`, `exp`), keys with an active
/// `federation_drop_key` left out (Rev4Review R4-18).
pub fn jwks(federation: &Value, active: &[ConsoleEntry]) -> Value {
    let keys: Vec<Value> = federation
        .get("keys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|k| !key_dropped(active, DROP, text(k, "kid")))
        .map(|k| {
            let mut o = Map::new();
            for f in ["kty", "kid", "n", "e", "alg", "use"] {
                if let Some(v) = k.get(f) {
                    o.insert(f.into(), v.clone());
                }
            }
            Value::Object(o)
        })
        .collect();
    json!({ "keys": keys })
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// The issuer the front door serves itself for a map: `I/federation`.
pub fn front_door_issuer(map: &Value) -> String {
    format!("{}{FRONT_DOOR_PATH}", map.pointer("/issuer/url").and_then(Value::as_str).unwrap_or_default().trim_end_matches('/'))
}

/// `GET I/federation/.well-known/openid-configuration` (`jwks` false) and `GET I/federation/jwks.json` (`jwks` true)
/// from the pinned map: None (404) unless its `federation.issuer` is exactly `I/federation`.
pub fn front_door_document(map: &Value, active: &[ConsoleEntry], jwks_doc: bool) -> Option<Value> {
    let f = map.get("federation")?;
    let issuer = f.get("issuer").and_then(Value::as_str)?;
    if issuer != front_door_issuer(map) {
        return None;
    }
    Some(if jwks_doc { jwks(f, active) } else { discovery(issuer) })
}

/// The documents an admin publishes for one `federation` block (13.1 `federation/documents`): issuer, where each
/// document goes, both documents, and whether the front door serves them itself.
pub fn documents(map: &Value, federation: &Value, active: &[ConsoleEntry]) -> Value {
    let issuer = text(federation, "issuer");
    let base = issuer.trim_end_matches('/');
    json!({"issuer": issuer, "front_door": issuer == front_door_issuer(map),
           "discovery_url": format!("{base}/.well-known/openid-configuration"), "jwks_url": format!("{base}/jwks.json"),
           "discovery": discovery(issuer), "jwks": jwks(federation, active)})
}

// ── subject tokens (8.2) ─────────────────────────────────────────────────────────────────────────────────────────

/// The subject token's claims, in the order of 8.2: `sub` is `lucid:<org>:console` (R4-D11).
pub fn subject_claims(issuer: &str, org: &str, destination: &str, aud: &str, now: i64, jti: &str) -> Value {
    json!({"iss": issuer, "sub": format!("lucid:{org}:console"), "aud": aud, "iat": now, "nbf": now, "exp": now + SUBJECT_SECONDS,
           "jti": jti, "lucid_org": org, "lucid_destination": destination})
}

/// JWS compact, header `{"alg": "RS256", "typ": "JWT", "kid"}`, RSASSA-PKCS1-v1_5 SHA-256.
pub fn subject_token(key: &FedKey, claims: &Value) -> Result<String, String> {
    let header = json!({"alg": "RS256", "typ": "JWT", "kid": key.kid});
    let input = format!("{}.{}", b64u(stringify(&header).as_bytes()), b64u(stringify(claims).as_bytes()));
    let sig = key.sign(input.as_bytes())?;
    Ok(format!("{input}.{}", b64u(&sig)))
}

/// The keys of a `federation` block that may sign at `now`: inside `nbf`/`exp`, not dropped; the latest `nbf` first.
pub fn signing_keys<'a>(federation: &'a Value, active: &[ConsoleEntry], now: i64) -> Vec<&'a Value> {
    let int = |k: &Value, f: &str| k.get(f).and_then(Value::as_i64);
    let mut live: Vec<&Value> = federation
        .get("keys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|k| int(k, "nbf").is_some_and(|n| n <= now) && int(k, "exp").is_some_and(|e| now < e) && !key_dropped(active, DROP, text(k, "kid")))
        .collect();
    live.sort_by_key(|k| std::cmp::Reverse(int(k, "nbf")));
    live
}

/// The sealed key of `kid` when its public part is the listed one.
fn sealed_key(vault: &dyn VaultLock, org: &str, listed: &Value) -> Option<FedKey> {
    let kid = text(listed, "kid");
    let der = vault_do(vault, |v| v.get(&seal_name(org, kid)))?;
    let key = FedKey::from_pkcs8(kid, &der).ok()?;
    let mine = key.public_jwk();
    (mine.get("n") == listed.get("n") && mine.get("e") == listed.get("e")).then_some(key)
}

/// Where a signer reads the federation block from.
enum Source {
    /// The pinned serving map (its `federation` and `expires`): delivery.
    Pinned,
    /// A staged block, for one destination test of a draft (13.1 `destinations/test`, `federation-test`).
    Staged(Value),
}

/// Records one exchange's audit entry in the org's console chain.
pub type AuditFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The console's subject signer for one destination of one org.
pub struct ConsoleSigner {
    api: Weak<ConsoleApi>,
    org: String,
    destination: String,
    source: Source,
    audit: AuditFn,
    /// The release gate the credential waits for while it is not verified (None: it may sign).
    closed_gate: Option<&'static str>,
}

/// The release gate a federated credential of `ty` (and Entra `cloud`) still waits for among the verified `gates`.
pub fn closed_gate(ty: &str, cloud: &str, gates: &[&str]) -> Option<&'static str> {
    if !gates.contains(&DISCOVERY_GATE) {
        return Some(DISCOVERY_GATE);
    }
    (ty == "entra_federated" && cloud == "usgov" && !gates.contains(&USGOV_GATE)).then_some(USGOV_GATE)
}

fn no_key(why: &str) -> SinkError {
    SinkError { retryable: false, code: "federation", message: why.to_owned() }
}

impl ConsoleSigner {
    /// The federation block and the time no token may be used past (the map's `expires`; a staged block: one subject
    /// token's life).
    fn block(&self, api: &ConsoleApi, now: i64) -> Option<(Value, i64)> {
        match &self.source {
            Source::Staged(f) => Some((f.clone(), now + SUBJECT_SECONDS)),
            Source::Pinned => {
                let map = api.pinned(&self.org).0?;
                let expires = map.get("expires").and_then(Value::as_i64)?;
                Some((map.get("federation")?.clone(), expires))
            }
        }
    }
}

impl SubjectSigner for ConsoleSigner {
    fn subject(&self, aud: &str, now: i64) -> Result<Subject, SinkError> {
        if let Some(g) = self.closed_gate {
            return Err(no_key(&format!("outbound federation waits for release gate {g}")));
        }
        let api = self.api.upgrade().ok_or_else(|| no_key("the console is closing"))?;
        let (fed, expires) = self.block(&api, now).ok_or_else(|| no_key("the organization's api map has no federation block"))?;
        if expires <= now {
            return Err(no_key("the organization's api map has expired"));
        }
        let issuer = text(&fed, "issuer").to_owned();
        let active = api.console_active(&self.org);
        let vault = api.vault();
        for listed in signing_keys(&fed, &active, now) {
            let Some(key) = sealed_key(&*vault, &self.org, listed) else { continue };
            let jti = b64u(&crate::console_auth::random(16).ok_or_else(|| no_key("no random bytes"))?);
            let claims = subject_claims(&issuer, &self.org, &self.destination, aud, now, &jti);
            let token = subject_token(&key, &claims).map_err(|e| no_key(&e))?;
            let exp = listed.get("exp").and_then(Value::as_i64).unwrap_or(now);
            return Ok(Subject { token, kid: key.kid, until: expires.min(exp) });
        }
        Err(no_key("no federation key listed in the organization's api map is live, undropped and held by this console"))
    }

    fn usable(&self, kid: &str, now: i64) -> bool {
        let Some(api) = self.api.upgrade() else { return false };
        let Some((fed, expires)) = self.block(&api, now) else { return false };
        let active = api.console_active(&self.org);
        now < expires && signing_keys(&fed, &active, now).iter().any(|k| text(k, "kid") == kid)
    }

    fn exchanged(&self, provider: &str, kid: &str, exp: i64) {
        crate::api_catalog::counters::federation_exchange(&self.org, provider, "ok");
        (self.audit)(&self.org, json!({"action": "federation.token", "result": "ok", "destination": self.destination, "provider": provider, "kid": kid, "exp": exp}));
    }

    fn failed(&self, provider: &str, status: u16, error: &str) {
        crate::api_catalog::counters::federation_exchange(&self.org, provider, "failed");
        (self.audit)(&self.org, json!({"action": "federation.failed", "result": "failed", "destination": self.destination, "provider": provider, "status": status, "error": error}));
    }
}

/// The federated credential of a destination entry (`entra_federated` or `gcp_federated`, revision 4 2.2) with the
/// console's signer; None for every other credential type. `staged` is the draft's `federation` block for a test of
/// a staged destination (None: the pinned map's, as delivery uses). While its release gate is not verified
/// (`RELAY_GATES`) the credential exists but its signer refuses (`federation`), so nothing is exchanged.
pub fn credential_for(api: &Arc<ConsoleApi>, org: &str, destination: &Value, staged: Option<&Value>, audit: AuditFn) -> Option<Credential> {
    credential_gated(api, org, destination, staged, audit, crate::meet_org_policy::RELAY_GATES)
}

fn credential_gated(api: &Arc<ConsoleApi>, org: &str, destination: &Value, staged: Option<&Value>, audit: AuditFn, gates: &[&str]) -> Option<Credential> {
    let cr = destination.get("credential")?;
    let id = text(destination, "id").to_owned();
    let source = staged.map_or(Source::Pinned, |f| Source::Staged(f.clone()));
    let closed_gate = closed_gate(text(cr, "type"), text(cr, "cloud"), gates);
    let signer: Arc<dyn SubjectSigner> = Arc::new(ConsoleSigner { api: Arc::downgrade(api), org: org.to_owned(), destination: id, source, audit, closed_gate });
    let s = |k: &str| cr.get(k).and_then(Value::as_str).map(str::to_owned);
    match cr.get("type").and_then(Value::as_str)? {
        "entra_federated" => Some(Credential::EntraFederated { tenant: s("tenant")?, client_id: s("client_id")?, cloud: s("cloud")?, audience: s("audience")?, signer }),
        "gcp_federated" => Some(Credential::GcpFederated { audience: s("audience")?, token_audience: s("token_audience")?, service_account: s("service_account"), signer }),
        _ => None,
    }
}

/// Whether a destination entry names a federated credential.
pub fn is_federated(destination: &Value) -> bool {
    matches!(destination.pointer("/credential/type").and_then(Value::as_str), Some("entra_federated" | "gcp_federated"))
}

// ── staging and the console journal (13.1) ────────────────────────────────────────────────────────────────────

fn invalid(words: impl Into<String>) -> ApiError {
    ApiError::with("invalid", words)
}

/// 2.2 `federation.issuer`: an https URL of at most 512 characters, no query, fragment, userinfo or whitespace.
fn issuer_ok(i: &str) -> bool {
    let Some(rest) = i.strip_prefix("https://") else { return false };
    let host = rest.split('/').next().unwrap_or_default();
    i.len() <= 512 && !host.is_empty() && !host.contains('@') && !i.contains(['?', '#']) && !i.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Draw a new key for `org`, seal it, and Ok its public JWK.
fn draw_key(vault: &dyn VaultLock, org: &str) -> Result<FedKey, ApiError> {
    let kid = format!("fk-{}", b64u(&crate::console_auth::random(6).ok_or_else(|| ApiError::of("write-failed"))?));
    let (key, der) = FedKey::generate(&kid).map_err(|e| ApiError::with("write-failed", e))?;
    vault_do(vault, |v| v.put(&seal_name(org, &kid), &der)).map_err(|e| ApiError::with("seal-provider-needed", e))?;
    Ok(key)
}

/// Stage a drawn key in the draft's `federation.keys`: `nbf` now when no staged key is live now, else 24 hours on
/// (8.1 rotation), `exp` a year after `nbf`. Expired keys leave the draft first; a draft that still holds two keys
/// refuses (one must be dropped first).
fn stage_key(d: &mut Draft, key: &FedKey, now: i64) -> Result<Value, ApiError> {
    let int = |k: &Value, f: &str| k.get(f).and_then(Value::as_i64).unwrap_or(0);
    let keys = d.map.pointer_mut("/federation/keys").and_then(Value::as_array_mut).ok_or_else(|| invalid("Set the outbound identity issuer first."))?;
    keys.retain(|k| int(k, "exp") > now);
    if keys.len() >= KEYS_MAX {
        return Err(invalid("An organization has at most two federation keys. Drop one first."));
    }
    let live = keys.iter().any(|k| int(k, "nbf") <= now && now < int(k, "exp"));
    let nbf = if live { now + PUBLISH_LEAD_S } else { now };
    let mut jwk = key.public_jwk();
    jwk["nbf"] = json!(nbf);
    jwk["exp"] = json!(nbf + KEY_DAYS * DAY);
    keys.push(jwk.clone());
    d.changes.push(format!("Add federation key {}", key.kid()));
    Ok(jwk)
}

/// `POST settings/api/federation {org, issuer?}`: stage `federation.issuer` (default `I/federation`, which the front
/// door serves). An org without a federation block also gets its first key, drawn and sealed now, since a block needs
/// one (2.2). Ok is the new key's JWK when one was drawn.
pub fn stage_issuer(d: &mut Draft, vault: &dyn VaultLock, org: &str, issuer: Option<&str>, default_issuer: &str, now: i64) -> Result<Option<Value>, ApiError> {
    let issuer = issuer.map(str::trim).filter(|i| !i.is_empty()).unwrap_or(default_issuer).to_owned();
    if !issuer_ok(&issuer) {
        return Err(invalid("issuer is an https URL of at most 512 characters, without a query or fragment."));
    }
    if d.map.get("federation").is_some_and(Value::is_object) {
        if text(&d.map["federation"], "issuer") == issuer {
            return Err(ApiError::with("stale", "Nothing was changed: that is already the issuer."));
        }
        d.map["federation"]["issuer"] = json!(issuer);
        d.changes.push(format!("Set the outbound identity issuer to {issuer}"));
        return Ok(None);
    }
    d.map["federation"] = json!({"issuer": issuer, "keys": []});
    d.changes.push(format!("Set the outbound identity issuer to {issuer}"));
    let key = draw_key(vault, org)?;
    stage_key(d, &key, now).map(Some)
}

/// `POST settings/api/federation/key {org}`: a new RSA 3072 key drawn and sealed, its public part staged.
pub fn stage_new_key(d: &mut Draft, vault: &dyn VaultLock, org: &str, now: i64) -> Result<Value, ApiError> {
    if !d.map.get("federation").is_some_and(Value::is_object) {
        return Err(invalid("Set the outbound identity issuer first."));
    }
    let key = draw_key(vault, org)?;
    stage_key(d, &key, now)
}

/// The kids of every `federation_drop_key` the org's console journal ever held.
fn dropped_kids(entries: &[ConsoleEntry]) -> BTreeSet<String> {
    entries.iter().filter(|e| e.action == DROP).map(|e| e.field("kid").to_owned()).collect()
}

fn read_republished(state_dir: &Path) -> BTreeMap<String, BTreeSet<String>> {
    let text = std::fs::read_to_string(state_dir.join(REPUBLISHED_FILE)).unwrap_or_default();
    serde_json::from_str(&text).unwrap_or_default()
}

/// `POST settings/api/federation/key/drop {org, kid}` (2.4): `federation_drop_key` in the console journal at once
/// (flushed before Ok: the console stops signing with the key and the published key sets omit it), and the key
/// leaves the org's draft when one is staged. Ok is the journal entry (null for a key only staged, never pinned) and
/// whether the draft changed.
pub fn drop_key(api: &ConsoleApi, draft: Option<&mut Draft>, org: &str, kid: &str, now: i64) -> Result<(Value, bool), ApiError> {
    let (pinned, _, _) = api.pinned(org);
    let listed = |m: &Value| m.pointer("/federation/keys").and_then(Value::as_array).is_some_and(|ks| ks.iter().any(|k| text(k, "kid") == kid));
    let in_draft = draft.as_ref().is_some_and(|d| listed(&d.map));
    if !pinned.as_ref().is_some_and(listed) && !in_draft {
        return Err(ApiError::with("not-found", "That federation key is not in the organization's api map."));
    }
    if key_dropped(&api.console_active(org), DROP, kid) {
        return Err(ApiError::with("stale", "Nothing was changed: that federation key is already dropped."));
    }
    let entry = if pinned.as_ref().is_some_and(listed) { api.append_console(org, DROP, json!({ "kid": kid }), now).map_err(|e| ApiError::with("write-failed", e.message))? } else { Value::Null };
    let mut changed = false;
    if let Some(d) = draft.filter(|_| in_draft) {
        if let Some(keys) = d.map.pointer_mut("/federation/keys").and_then(Value::as_array_mut) {
            keys.retain(|k| text(k, "kid") != kid);
            d.changes.push(format!("Drop federation key {kid}"));
            changed = true;
        }
    }
    Ok((entry, changed))
}

/// The attention item `federation-jwks-republish` (2.4): (org, kid) of every dropped federation key an admin has not
/// confirmed as gone from the externally hosted key sets.
pub fn republish_attention(api: &ConsoleApi, state_dir: &Path) -> Vec<(String, String)> {
    let done = read_republished(state_dir);
    let mut out = Vec::new();
    for org in api.known_orgs() {
        for kid in dropped_kids(&api.console_entries(&org)) {
            if !done.get(&org).is_some_and(|k| k.contains(&kid)) {
                out.push((org.clone(), kid));
            }
        }
    }
    out
}

/// `POST settings/api/federation/republished {org, kid}`: the admin confirms the externally hosted JWKS (and any
/// Google uploaded key set) no longer lists a dropped key; its attention item ends. Flushed before Ok.
pub fn confirm_republished(api: &ConsoleApi, state_dir: &Path, org: &str, kid: &str) -> Result<(), ApiError> {
    if !dropped_kids(&api.console_entries(org)).contains(kid) {
        return Err(ApiError::with("not-found", "That federation key was not dropped."));
    }
    let mut all = read_republished(state_dir);
    if !all.entry(org.to_owned()).or_default().insert(kid.to_owned()) {
        return Err(ApiError::with("stale", "Nothing was changed: that key was already confirmed."));
    }
    let body = serde_json::to_vec(&all).map_err(|_| ApiError::of("write-failed"))?;
    crate::store::make_dir(state_dir).map_err(|_| ApiError::of("write-failed"))?;
    crate::fleet_local::write_durable(&state_dir.join(REPUBLISHED_FILE), &body).map_err(|e| ApiError::with("write-failed", e))
}

/// `GET settings/api/federation/documents?org=`: the documents of the pinned map's `federation` and of the draft's
/// when it differs (to publish before a rotation is saved), each null when absent.
pub fn documents_view(api: &ConsoleApi, draft: Option<&Draft>, org: &str) -> Value {
    let active = api.console_active(org);
    let (pinned, _, _) = api.pinned(org);
    let of = |m: &Value| m.get("federation").filter(|f| f.is_object()).map(|f| documents(m, f, &active));
    let p = pinned.as_ref().and_then(of);
    let s = draft.filter(|d| d.map.get("federation") != pinned.as_ref().and_then(|m| m.get("federation"))).and_then(|d| of(&d.map));
    json!({ "ok": true, "org": org, "pinned": p, "staged": s })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_cjournal::Reach;
    use aws_lc_rs::signature::{UnparsedPublicKey, RSA_PKCS1_2048_8192_SHA256};
    use std::path::PathBuf;

    const NOW: i64 = 1_795_700_000;
    const I: &str = "https://console.acme.example:7443/api/orgs/acme";

    fn entry(kid: &str) -> ConsoleEntry {
        ConsoleEntry { id: "k_acme_000001".into(), cseq: 1, org: "acme".into(), action: DROP.into(), target: json!({ "kid": kid }), ts: NOW, reach: Reach::Console, prev_cseq: None }
    }

    fn jwt_parts(t: &str) -> (Value, Value, Vec<u8>, String) {
        let p: Vec<&str> = t.split('.').collect();
        assert_eq!(p.len(), 3);
        let h = serde_json::from_slice(&crate::codec::unb64u(p[0]).unwrap()).unwrap();
        let c = serde_json::from_slice(&crate::codec::unb64u(p[1]).unwrap()).unwrap();
        (h, c, crate::codec::unb64u(p[2]).unwrap(), format!("{}.{}", p[0], p[1]))
    }

    fn rsa_public_der(jwk: &Value) -> Vec<u8> {
        // RSAPublicKey DER from n and e (both short-form lengths or two-byte lengths as needed)
        fn int(v: &[u8]) -> Vec<u8> {
            let mut body = if v[0] & 0x80 != 0 { vec![0] } else { Vec::new() };
            body.extend_from_slice(v);
            tlv(0x02, &body)
        }
        fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
            let mut out = vec![tag];
            match body.len() {
                n if n < 0x80 => out.push(n as u8),
                n if n < 0x100 => out.extend([0x81, n as u8]),
                n => out.extend([0x82, (n >> 8) as u8, n as u8]),
            }
            out.extend_from_slice(body);
            out
        }
        let n = crate::codec::unb64u(jwk["n"].as_str().unwrap()).unwrap();
        let e = crate::codec::unb64u(jwk["e"].as_str().unwrap()).unwrap();
        tlv(0x30, &[int(&n), int(&e)].concat())
    }

    fn verify(token: &str, jwk: &Value) -> bool {
        let (_, _, sig, input) = jwt_parts(token);
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, rsa_public_der(jwk)).verify(input.as_bytes(), &sig).is_ok()
    }

    #[test]
    fn a_drawn_key_is_rsa_3072_and_its_tokens_verify_against_its_published_jwk() {
        let (key, der) = FedKey::generate("fk-1").unwrap();
        let jwk = key.public_jwk();
        assert_eq!((jwk["kty"].as_str(), jwk["alg"].as_str(), jwk["use"].as_str(), jwk["e"].as_str()), (Some("RSA"), Some("RS256"), Some("sig"), Some("AQAB")));
        assert_eq!(crate::codec::unb64u(jwk["n"].as_str().unwrap()).unwrap().len(), 384);
        assert_eq!(FedKey::from_pkcs8("fk-1", &der).unwrap().public_jwk(), jwk, "the sealed bytes give the same key");
        assert!(!format!("{key:?}").contains(&b64u(&der)));
        let claims = subject_claims("https://id.acme.example/lucid/acme", "acme", "d_4e5f607182930415", "api://AzureADTokenExchange", NOW, "AAAAAAAAAAAAAAAAAAAAAA");
        let t = subject_token(&key, &claims).unwrap();
        let (h, c, _, _) = jwt_parts(&t);
        assert_eq!(h, json!({"alg": "RS256", "typ": "JWT", "kid": "fk-1"}));
        assert_eq!(c["sub"], "lucid:acme:console");
        assert_eq!(c["exp"].as_i64().unwrap() - c["iat"].as_i64().unwrap(), SUBJECT_SECONDS);
        assert_eq!(c.as_object().unwrap().keys().collect::<Vec<_>>(), ["iss", "sub", "aud", "iat", "nbf", "exp", "jti", "lucid_org", "lucid_destination"]);
        // 19.2 Federation: a subject token verifies against the published JWKS
        let mut listed = jwk.clone();
        listed["nbf"] = json!(NOW);
        listed["exp"] = json!(NOW + DAY);
        let published = jwks(&json!({"issuer": "https://id.acme.example/lucid/acme", "keys": [listed]}), &[]);
        assert_eq!(published["keys"][0], jwk, "published without nbf and exp");
        assert!(verify(&t, &published["keys"][0]));
        let (other, _) = FedKey::generate("fk-2").unwrap();
        assert!(!verify(&t, &other.public_jwk()));
        // a 2048-bit key is not a federation key
        use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
        let small = RsaKeyPair::generate(aws_lc_rs::rsa::KeySize::Rsa2048).unwrap();
        let small: Pkcs8V1Der = small.as_der().unwrap();
        assert!(FedKey::from_pkcs8("x", small.as_ref()).is_err());
    }

    #[test]
    fn documents_follow_8_1_and_omit_dropped_keys() {
        let fed = json!({"issuer": "https://id.acme.example/lucid/acme/", "keys": [
            {"kty": "RSA", "kid": "fk-1", "n": "n1", "e": "AQAB", "alg": "RS256", "use": "sig", "nbf": 1, "exp": 2},
            {"kty": "RSA", "kid": "fk-2", "n": "n2", "e": "AQAB", "alg": "RS256", "use": "sig", "nbf": 1, "exp": 2}]});
        assert_eq!(
            discovery("https://id.acme.example/lucid/acme"),
            json!({"issuer": "https://id.acme.example/lucid/acme", "jwks_uri": "https://id.acme.example/lucid/acme/jwks.json", "response_types_supported": ["id_token"],
                   "subject_types_supported": ["public"], "id_token_signing_alg_values_supported": ["RS256"]})
        );
        assert_eq!(discovery("https://x.example/")["jwks_uri"], "https://x.example/jwks.json");
        let all = jwks(&fed, &[]);
        assert_eq!(all["keys"][0], json!({"kty": "RSA", "kid": "fk-1", "n": "n1", "e": "AQAB", "alg": "RS256", "use": "sig"}));
        // R4-18: a dropped key leaves the published set at once
        let left = jwks(&fed, &[entry("fk-1")]);
        assert_eq!(left["keys"].as_array().unwrap().len(), 1);
        assert_eq!(left["keys"][0]["kid"], "fk-2");
        // the front door serves only its own issuer
        let mut map = json!({"issuer": {"url": I}, "federation": fed});
        assert_eq!(front_door_document(&map, &[], false), None);
        map["federation"]["issuer"] = json!(format!("{I}/federation"));
        assert_eq!(front_door_document(&map, &[], false).unwrap()["jwks_uri"], format!("{I}/federation/jwks.json"));
        assert_eq!(front_door_document(&map, &[entry("fk-2")], true).unwrap()["keys"].as_array().unwrap().len(), 1);
        let d = documents(&map, &map["federation"], &[]);
        assert_eq!((d["front_door"].as_bool(), d["discovery_url"].as_str()), (Some(true), Some(format!("{I}/federation/.well-known/openid-configuration").as_str())));
        assert_eq!(front_door_document(&json!({"issuer": {"url": I}}), &[], true), None);
    }

    #[test]
    fn signing_keys_are_live_undropped_latest_first() {
        let fed = json!({"keys": [{"kid": "old", "nbf": NOW - 100, "exp": NOW + 100}, {"kid": "new", "nbf": NOW - 10, "exp": NOW + 100},
                                   {"kid": "soon", "nbf": NOW + 10, "exp": NOW + 100}, {"kid": "gone", "nbf": NOW - 100, "exp": NOW}]});
        let kids = |active: &[ConsoleEntry]| signing_keys(&fed, active, NOW).iter().map(|k| text(k, "kid").to_owned()).collect::<Vec<_>>();
        assert_eq!(kids(&[]), ["new", "old"]);
        assert_eq!(kids(&[entry("new")]), ["old"], "federation_drop_key stops signing at once");
    }

    #[test]
    fn rsa_public_parts_strip_the_sign_byte() {
        let der = [0x30, 0x0a, 0x02, 0x03, 0x00, 0x80, 0x01, 0x02, 0x03, 0x01, 0x00, 0x01];
        assert_eq!(rsa_public_parts(&der), Some((vec![0x80, 0x01], vec![0x01, 0x00, 0x01])));
        assert_eq!(rsa_public_parts(&[0x31, 0x00]), None);
    }

    fn draft() -> Draft {
        let cx = crate::console_api_ui::Ctx { org: "acme", by: "ann@acme.example", pinned: None, pinned_seq: 0 };
        Draft::new(&cx, "st_1".into(), NOW * 1000)
    }

    #[test]
    fn staging_an_issuer_draws_the_first_key_and_rotation_waits_24_hours() {
        let vault = parking_lot::Mutex::new(crate::fleet_ca::MemVault::default());
        let mut d = draft();
        assert!(stage_new_key(&mut d, &vault, "acme", NOW).is_err(), "an issuer first");
        for bad in ["http://id.acme.example", "https://id.acme.example/?a=1", "https://u@id.acme.example", "https://id.acme.example/a b", "https://"] {
            assert!(stage_issuer(&mut d, &vault, "acme", Some(bad), "", NOW).is_err(), "{bad}");
        }
        let first = stage_issuer(&mut d, &vault, "acme", None, &format!("{I}/federation"), NOW).unwrap().unwrap();
        assert_eq!(d.map["federation"]["issuer"], format!("{I}/federation"));
        assert_eq!((first["nbf"].as_i64(), first["exp"].as_i64()), (Some(NOW), Some(NOW + KEY_DAYS * DAY)));
        let kid = first["kid"].as_str().unwrap().to_owned();
        assert!(vault.lock().map.contains_key(&seal_name("acme", &kid)), "sealed");
        // the second key is listed 24 hours before it signs
        let second = stage_new_key(&mut d, &vault, "acme", NOW).unwrap();
        assert_eq!(second["nbf"].as_i64(), Some(NOW + PUBLISH_LEAD_S));
        assert!(stage_new_key(&mut d, &vault, "acme", NOW).is_err(), "at most two");
        // an expired key leaves the draft to make room
        assert!(stage_new_key(&mut d, &vault, "acme", NOW + KEY_DAYS * DAY).is_ok());
        assert!(stage_issuer(&mut d, &vault, "acme", Some("https://id.acme.example/lucid/acme"), "", NOW).unwrap().is_none(), "no new key for a new issuer");
        assert_eq!(d.map["federation"]["keys"].as_array().unwrap().len(), 2);
    }

    /// A console holding acme's pinned version 2 map with an `I/federation` issuer, one sealed key and a federated
    /// Sentinel destination; Ok also the key's JWK.
    fn console_with_federation(now: i64) -> (Arc<ConsoleApi>, Value, Value) {
        let logger = Arc::new(crate::log::Logger::capture("console", Box::new(|_, _| {})));
        let vault: Arc<dyn VaultLock> = Arc::new(parking_lot::Mutex::new(crate::fleet_ca::MemVault::default()));
        let api = Arc::new(ConsoleApi::open(None, logger, vault.clone()));
        let (key, der) = FedKey::generate("fk-1").unwrap();
        vault_do(&*vault, |v| v.put(&seal_name("acme", "fk-1"), &der)).unwrap();
        let mut jwk = key.public_jwk();
        jwk["nbf"] = json!(now - 10);
        jwk["exp"] = json!(now + 86_400);
        let dest = json!({"id": "d_4e5f607182930415", "name": "Sentinel", "kind": "azure_logs", "preset": "sentinel",
            "credential": {"type": "entra_federated", "tenant": "ce5f061f-abe6-4e40-9615-301f87bcb7f0", "client_id": "cb1d50fe-8ed0-4944-9e7d-5981aad3bc4b",
                           "cloud": "public", "audience": "api://AzureADTokenExchange"}});
        let m = json!({"v": 2, "org": "acme", "seq": 1, "issued": now - 10, "expires": now + 30 * DAY, "issuer": {"url": I, "jwks": []},
                       "grace": {"person": 0, "app": 0, "connector": 0, "relay": 0}, "failover_after_s": 300, "folded": [], "cleared": [],
                       "relay_origins": {}, "clients": [], "destinations": [dest.clone()],
                       "federation": {"issuer": format!("{I}/federation"), "keys": [jwk.clone()]}});
        let wire = json!({"map": m, "sig": "", "chain": []});
        let vm = crate::api_map::VerifiedApiMap { org: "acme".into(), seq: 1, expires: now + 30 * DAY, hash: crate::api_map::api_map_hash(&wire["map"]), signer: "root".into(), wire: wire.as_object().unwrap().clone() };
        api.publish_verified(None, vm, now).unwrap();
        (api, dest, jwk)
    }

    #[test]
    fn the_console_signer_follows_the_pinned_map_the_gate_and_the_console_journal() {
        let now = crate::codec::now_ms() / 1000;
        let (api, dest, jwk) = console_with_federation(now);
        let seen: Arc<parking_lot::Mutex<Vec<Value>>> = Arc::default();
        let s2 = seen.clone();
        let audit: AuditFn = Arc::new(move |org: &str, e: Value| {
            assert_eq!(org, "acme");
            s2.lock().push(e);
        });
        let signer_of = |gates: &[&str]| match credential_gated(&api, "acme", &dest, None, audit.clone(), gates).unwrap() {
            Credential::EntraFederated { signer, audience, .. } => {
                assert_eq!(audience, "api://AzureADTokenExchange");
                signer
            }
            other => panic!("{other:?}"),
        };
        // 19.3: while G-FED-DISCOVERY is not verified nothing is signed
        assert_eq!(signer_of(&[]).subject("api://AzureADTokenExchange", now).err().map(|e| e.code), Some("federation"));
        assert_eq!(closed_gate("entra_federated", "usgov", &[DISCOVERY_GATE]), Some(USGOV_GATE));
        assert_eq!(closed_gate("gcp_federated", "", &[DISCOVERY_GATE]), None);
        let signer = signer_of(&[DISCOVERY_GATE]);
        let s = signer.subject("api://AzureADTokenExchange", now).unwrap();
        assert_eq!((s.kid.as_str(), s.until), ("fk-1", now + 86_400), "until: the key's exp before the map's expires");
        let (h, c, _, _) = jwt_parts(&s.token);
        assert_eq!(h["kid"], "fk-1");
        assert_eq!((c["iss"].as_str(), c["sub"].as_str(), c["lucid_destination"].as_str()), (Some(format!("{I}/federation").as_str()), Some("lucid:acme:console"), Some("d_4e5f607182930415")));
        assert_eq!(c["jti"].as_str().unwrap().len(), 22);
        assert!(verify(&s.token, &jwk));
        assert!(signer.usable("fk-1", now) && !signer.usable("fk-9", now));
        // the exchange reports: audit entries with no token value, and the counter
        signer.exchanged("entra", "fk-1", now + 3600);
        signer.failed("entra", 400, "invalid_client");
        let entries = seen.lock().clone();
        assert_eq!(entries[0], json!({"action": "federation.token", "result": "ok", "destination": "d_4e5f607182930415", "provider": "entra", "kid": "fk-1", "exp": now + 3600}));
        assert_eq!(entries[1], json!({"action": "federation.failed", "result": "failed", "destination": "d_4e5f607182930415", "provider": "entra", "status": 400, "error": "invalid_client"}));
        assert!(!entries.iter().any(|e| e.to_string().contains(&s.token)));
        // the front door serves its own issuer's documents from the pinned map
        let ip: std::net::IpAddr = "203.0.113.9".parse().unwrap();
        let doc = |d| serde_json::to_value(&api.api_document("acme", d, ip, now).unwrap().body).unwrap();
        let disco = doc(crate::console_api::ApiDoc::FederationDiscovery);
        assert_eq!(disco.to_string(), discovery(&format!("{I}/federation")).to_string());
        let keys = doc(crate::console_api::ApiDoc::FederationJwks);
        assert!(keys.to_string().contains("fk-1"));
        // federation_drop_key: signing stops at once, cached tokens stop, and the published set omits the key
        let (entry, changed) = drop_key(&api, None, "acme", "fk-1", now).unwrap();
        assert!(entry["id"].as_str().unwrap().starts_with("k_acme_") && !changed);
        assert!(!signer.usable("fk-1", now));
        assert_eq!(signer.subject("api://AzureADTokenExchange", now).err().map(|e| e.code), Some("federation"));
        assert!(!doc(crate::console_api::ApiDoc::FederationJwks).to_string().contains("fk-1"));
        assert_eq!(drop_key(&api, None, "acme", "fk-1", now).err().map(|e| e.code), Some("stale"));
        assert_eq!(drop_key(&api, None, "acme", "fk-9", now).err().map(|e| e.code), Some("not-found"));
        // the attention item stays until an admin confirms the hosted key sets
        let dir = Dir(std::env::temp_dir().join(format!("lucid-fed-att-{}", std::process::id())));
        assert_eq!(republish_attention(&api, &dir.0), [("acme".to_owned(), "fk-1".to_owned())]);
        confirm_republished(&api, &dir.0, "acme", "fk-1").unwrap();
        assert!(republish_attention(&api, &dir.0).is_empty());
        assert_eq!(confirm_republished(&api, &dir.0, "acme", "fk-1").err().map(|e| e.code), Some("stale"));
        let view = documents_view(&api, None, "acme");
        assert_eq!(view["pinned"]["front_door"], true);
        assert_eq!(view["pinned"]["jwks"]["keys"], json!([]));
        assert!(view["staged"].is_null());
    }

    struct Dir(PathBuf);

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn republish_confirmations_persist() {
        let dir = Dir(std::env::temp_dir().join(format!("lucid-fed-{}", std::process::id())));
        assert!(read_republished(&dir.0).is_empty());
        let mut all: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        all.entry("acme".into()).or_default().insert("fk-1".into());
        crate::store::make_dir(&dir.0).unwrap();
        crate::fleet_local::write_durable(&dir.0.join(REPUBLISHED_FILE), &serde_json::to_vec(&all).unwrap()).unwrap();
        assert_eq!(read_republished(&dir.0), all);
        assert_eq!(dropped_kids(&[entry("fk-1"), entry("fk-1")]).len(), 1);
    }

    /// The shared vectors (`tests/vectors/make_api_federation_v1.py` in the Meeting Hub, copied to
    /// `tests/api_federation_v1.json`): the fixed key's JWK, the discovery document, the JWKS, and the subject tokens
    /// for the Entra and Google audiences byte for byte (RS256 is deterministic).
    #[test]
    fn shared_federation_vectors() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("api_federation_v1.json");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing: run make_api_federation_v1.py and copy it", path.display()));
        let v: Value = serde_json::from_str(&text).unwrap();
        let der = crate::codec::unb64u(v["key"]["pkcs8"].as_str().unwrap()).unwrap();
        let key = FedKey::from_pkcs8(v["key"]["kid"].as_str().unwrap(), &der).unwrap();
        assert_eq!(key.public_jwk(), v["key"]["jwk"]);
        let issuer = v["issuer"].as_str().unwrap();
        assert_eq!(discovery(issuer), v["discovery"]);
        assert_eq!(jwks(&v["federation"], &[]), v["jwks"]);
        let dropped = jwks(&v["federation"], &[entry(v["key"]["kid"].as_str().unwrap())]);
        assert_eq!(dropped["keys"].as_array().unwrap().len(), v["federation"]["keys"].as_array().unwrap().len() - 1);
        let cases = v["subject_tokens"].as_array().unwrap();
        assert!(cases.len() >= 2);
        for c in cases {
            let claims = subject_claims(issuer, v["org"].as_str().unwrap(), v["destination"].as_str().unwrap(), c["aud"].as_str().unwrap(), v["now"].as_i64().unwrap(), c["jti"].as_str().unwrap());
            assert_eq!(claims, c["claims"], "{}", c["name"]);
            assert_eq!(subject_token(&key, &claims).unwrap(), c["token"].as_str().unwrap(), "{}", c["name"]);
            assert!(verify(c["token"].as_str().unwrap(), &v["jwks"]["keys"][0]));
        }
        let map = &v["front_door"]["map"];
        assert_eq!(front_door_document(map, &[], false).as_ref(), Some(&v["front_door"]["discovery"]));
        assert_eq!(front_door_document(map, &[], true).as_ref(), Some(&v["front_door"]["jwks"]));
    }

    // ── live gates (19.3): run with `--ignored` and the variables named, against test tenants ──
    //
    // Common: `LUCID_FED_ISSUER` (the issuer the tester published `discovery` and `jwks` at, or uploaded the JWKS for),
    // `LUCID_FED_KEY` (a file holding the federation key's PKCS#8 DER in base64url), `LUCID_FED_KID`, and
    // `LUCID_FED_ORG` (default `acme`; the federated credential's subject is `lucid:<org>:console`).

    /// A signer over a key from the environment (the console's own needs a pinned map).
    struct EnvSigner {
        key: FedKey,
        issuer: String,
        org: String,
    }

    impl SubjectSigner for EnvSigner {
        fn subject(&self, aud: &str, now: i64) -> Result<Subject, SinkError> {
            let jti = b64u(&crate::console_auth::random(16).unwrap());
            let claims = subject_claims(&self.issuer, &self.org, "d_0000000000000001", aud, now, &jti);
            Ok(Subject { token: subject_token(&self.key, &claims).map_err(|e| no_key(&e))?, kid: self.key.kid.clone(), until: now + SUBJECT_SECONDS })
        }
        fn usable(&self, _kid: &str, _now: i64) -> bool {
            true
        }
        fn exchanged(&self, _provider: &str, _kid: &str, _exp: i64) {}
        fn failed(&self, provider: &str, status: u16, error: &str) {
            eprintln!("{provider} refused the exchange: {status} {error}");
        }
    }

    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("set {name}"))
    }

    fn env_signer(gate: &str) -> Arc<dyn SubjectSigner> {
        env(&format!("LUCID_GATE_{gate}"));
        let der = crate::codec::unb64u(std::fs::read_to_string(env("LUCID_FED_KEY")).unwrap().trim()).expect("LUCID_FED_KEY holds base64url PKCS#8");
        let key = FedKey::from_pkcs8(&env("LUCID_FED_KID"), &der).unwrap();
        Arc::new(EnvSigner { key, issuer: env("LUCID_FED_ISSUER"), org: std::env::var("LUCID_FED_ORG").unwrap_or_else(|_| "acme".into()) })
    }

    fn entra_live(gate: &str, cloud: &str) {
        let signer = env_signer(gate);
        let audience = std::env::var("LUCID_ENTRA_AUDIENCE").unwrap_or_else(|_| "api://AzureADTokenExchange".into());
        let c = Credential::EntraFederated { tenant: env("LUCID_ENTRA_TENANT"), client_id: env("LUCID_ENTRA_CLIENT_ID"), cloud: cloud.into(), audience, signer };
        let (provider, exp) = crate::api_export_wire::federation_test(&c).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(provider, "entra");
        assert!(exp > crate::codec::now_ms() / 1000);
    }

    fn google_live(gate: &str) {
        let signer = env_signer(gate);
        let c = Credential::GcpFederated { audience: env("LUCID_GCP_AUDIENCE"), token_audience: env("LUCID_GCP_TOKEN_AUDIENCE"), service_account: std::env::var("LUCID_GCP_SERVICE_ACCOUNT").ok(), signer };
        let (provider, exp) = crate::api_export_wire::federation_test(&c).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(provider, "google");
        assert!(exp > crate::codec::now_ms() / 1000);
    }

    /// G-FED-DISCOVERY, Entra public cloud: an app whose federated identity credential names `LUCID_FED_ISSUER` and
    /// `lucid:<org>:console` gives a Logs Ingestion token for the subject token; Entra found the keys through the
    /// discovery document of 8.1 (`LUCID_ENTRA_TENANT`, `LUCID_ENTRA_CLIENT_ID`, optional `LUCID_ENTRA_AUDIENCE`).
    #[test]
    #[ignore = "live gate G-FED-DISCOVERY"]
    fn live_entra_public_accepts_the_subject_token() {
        entra_live("FED_DISCOVERY", "public");
    }

    /// G-FED-DISCOVERY, Google: a workload identity pool provider for `LUCID_FED_ISSUER` (discovery fetched by Google)
    /// exchanges the subject token at STS (`LUCID_GCP_AUDIENCE`, `LUCID_GCP_TOKEN_AUDIENCE`, optional
    /// `LUCID_GCP_SERVICE_ACCOUNT` to impersonate).
    #[test]
    #[ignore = "live gate G-FED-DISCOVERY"]
    fn live_google_accepts_the_subject_token() {
        google_live("FED_DISCOVERY");
    }

    /// G-ENTRA-WIF-USGOV: the same exchange in Azure Government (`login.microsoftonline.us`, `monitor.azure.us`).
    #[test]
    #[ignore = "live gate G-ENTRA-WIF-USGOV"]
    fn live_entra_usgov_accepts_the_subject_token() {
        entra_live("ENTRA_WIF_USGOV", "usgov");
    }

    /// G-GCP-JWKS-UPLOAD: a pool provider given the console's JWKS as an uploaded key set, for an issuer that serves no
    /// discovery document, still exchanges the subject token (8.1: the IAM guide says yes, the STS reference says the
    /// issuer must serve discovery).
    #[test]
    #[ignore = "live gate G-GCP-JWKS-UPLOAD"]
    fn live_google_uploaded_jwks_accepts_the_subject_token() {
        google_live("GCP_JWKS_UPLOAD");
    }
}
