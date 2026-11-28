// The relay's trust in the Lucid Admin Console (contract AC-2a revision 3.1, sections 3.9 and 4): the bindings every
// fleet assertion signs (F4: step-up, request, approval, roster, policy), the canonical roster entry and its hashes
// (F16: `evidenceSha256`, `bootstrapRosterHash`, the admin-key fingerprint), the relay's own copy of the proxy and
// projection table (F19: the scope a frame needs, computed from method, path and the projection served, never from
// the frame; the `read-health` field allowlists of `admin_console_fleet_projection_v1.json`; the viewer-safe attention
// allowlist), and the link's trust state as `fleet.json` keeps it (the keys f-trust owns: scopes and the scope
// request, the policy chain, the first-roster bootstrap with its anchors, the roster chain with the relay's own
// attestation verdicts, holds counted in running time, sign counters, used approvals and refused keys). Single-use
// nonces live in memory only. Device endorsements (F20) and ceremony B anchor first keys; nothing the console sends
// decides attestation, holds or activation.
//
// Everything here is pure over the link and its inputs; fleet_exec.rs runs it against the channel, the headless
// console and the files, and fleet_local.rs against the operator's commands.

use crate::codec::{b64u, exact_keys, hex, is_int, sha256, str_of, unb64u};
use crate::console_audit::canonical_json;
use crate::console_auth::{email_of, hint_of};
use crate::console_mds::{assess, why_not, Snapshot};
use crate::console_webauthn::{credential_id, verify_attestation_evidence, verify_stepup_assertion};
use crate::license::Product;
use crate::meet_org_policy::lp;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::LazyLock;

pub const LINK_FILE: &str = "fleet.json";
const DAY: i64 = 86_400_000;
/// The scopes a relay knows (4.1); `upgrade` is reserved and refused as unknown.
pub const SCOPES: [&str; 5] = ["read-health", "read-logs", "people", "config", "license"];
/// Scopes that grant writes (4.1); a `nonce` frame needs one of them.
pub const WRITE_SCOPES: [&str; 4] = ["read-logs", "people", "config", "license"];
/// Open nonces per relay and their life (3.8, 4.6).
pub const NONCES_MAX: usize = 64;
pub const NONCE_MS: i64 = 120_000;
/// Roster entries a relay keeps (4.4).
pub const ROSTER_MAX: usize = 200;
/// The High hold, in the relay's own running time (4.4).
pub const HOLD_MS: i64 = DAY;
/// Two-admin requests (4.7): at most 14 days old, at most 5 minutes ahead; used approval ids kept 15 days.
pub const REQUEST_MAX_AGE_MS: i64 = 14 * DAY;
pub const REQUEST_AHEAD_MS: i64 = 5 * 60_000;
pub const USED_APPROVAL_MS: i64 = 15 * DAY;
/// Each evidence field, decoded (4.4).
pub const EVIDENCE_MAX: usize = 16 * 1024;
const CRED_ID_MAX: usize = 1024;
const COSE_MAX: usize = 2048;

pub const STEPUP_LABEL: &str = "lucid-fleet-stepup-v1";
pub const REQUEST_LABEL: &str = "lucid-fleet-request-v1";
pub const ROSTER_LABEL: &str = "lucid-fleet-roster-v1";
pub const ROSTER_ENDORSE_LABEL: &str = "lucid-fleet-roster-endorse-v1";
pub const POLICY_LABEL: &str = "lucid-fleet-policy-v1";
pub const POLICY_ENDORSE_LABEL: &str = "lucid-fleet-policy-endorse-v1";
pub const EVIDENCE_LABEL: &str = "lucid-fleet-evidence-v1";
pub const BOOTSTRAP_LABEL: &str = "lucid-fleet-bootstrap-v1";
pub const ADMIN_KEY_LABEL: &str = "lucid-fleet-admin-key-v1";
pub const SCOPES_LABEL: &str = "lucid-fleet-scopes-v1";
pub const ENDORSE_LABEL: &str = "lucid-fleet-endorse-key-v1";

/// The 15 attention kinds pushed and served under `read-health` alone (4.11).
pub const ATTENTION_VIEWER: [&str; 15] = [
    "license-none",
    "license-grace",
    "license-expired",
    "license-expiring",
    "license-stopped",
    "license-upgrade-period",
    "crl-stale",
    "signer-unhealthy",
    "signer-expiring",
    "tls-expiring",
    "spokes-silent",
    "seats-high",
    "seats-over",
    "audit-broken",
    "clock-uncertain",
];

// ── Refusals (13.3) ─────────────────────────────────────────────────────────────────────────────────────────

/// A fleet refusal: status, 13.3 code and its words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    pub status: u16,
    pub code: &'static str,
    pub error: String,
}

/// The 13.3 words of the codes the relay answers (placeholders filled by `Refused::with`).
pub fn words(code: &str) -> Option<(u16, &'static str)> {
    Some(match code {
        "fleet-scope" => (403, "This relay did not give the Admin Console the <scope> scope."),
        "fleet-scope-unknown" => (400, "This relay does not know the scope <scope> yet."),
        "fleet-route" => (404, "This page is not available through the Admin Console."),
        "fleet-read-only" => (403, "This relay is set to read only from the Admin Console. Its operator can change that on the relay."),
        "fleet-confirm" => (202, "This relay's operator confirms this change on the relay. It runs when they do."),
        "fleet-stepup" => (403, "The relay could not verify your confirmation. Try again."),
        "fleet-counter" => (403, "The relay saw this security key go backwards and refused it. Tell your security team."),
        "fleet-roster" => (403, "This relay does not know your key yet. An admin must confirm new keys first."),
        "fleet-webauthn" => (403, "Changes on relays need a passkey or security key. Add one in Your account."),
        "fleet-second" => (409, "This change needs a second admin. Ask another admin to approve it in the Admin Console."),
        "fleet-op" => (400, "The relay did not understand the console. Check that both run supported versions."),
        "fleet-bootstrap" => (409, "This relay does not trust any admin key yet. Admins endorse their keys from the IDE plugin or the Hub app."),
        "fleet-roster-duplicate" => (409, "Two admin entries use the same key. The relay trusts none of them."),
        "endorse-refused" => (403, "The relay did not accept this endorsement: <why>."),
        "fleet-not-bootstrapping" => (409, "This relay is not waiting for admin keys."),
        "fleet-scope-needs-people" => (409, "Logs and audit name people, so they need the People scope too."),
        "fleet-profile" => (409, "This console and this relay are not in the same security profile. A High relay works only with a High console, and a High console only with High relays in FIPS mode."),
        "stale" => (409, "That request changed. Look at it again before you accept."),
        "trust-time-refused" => (409, "The time was not reset: no fresh trust list signed by the console's CA within 10 minutes of this host's clock."),
        "fingerprint" => (409, "That fingerprint does not match this relay. Do not confirm it."),
        "not-found" => (404, "There is no such page."),
        "gone" => (410, "This is no longer waiting."),
        _ => return None,
    })
}

impl Refused {
    pub fn of(code: &'static str) -> Refused {
        let (status, w) = words(code).unwrap_or((400, "The relay did not understand the console. Check that both run supported versions."));
        Refused { status, code, error: w.to_owned() }
    }

    pub fn with(code: &'static str, error: impl Into<String>) -> Refused {
        Refused { error: error.into(), ..Refused::of(code) }
    }

    /// `fleet-scope` naming the scope.
    pub fn scope(scope: &str) -> Refused {
        Refused::with("fleet-scope", format!("This relay did not give the Admin Console the {scope} scope."))
    }

    pub fn unknown_scope(scope: &str) -> Refused {
        let shown: String = scope.chars().filter(|c| c.is_ascii_graphic()).take(40).collect();
        Refused::with("fleet-scope-unknown", format!("This relay does not know the scope {shown} yet."))
    }

    pub fn op() -> Refused {
        Refused::of("fleet-op")
    }
}

// ── F4 and F16: bindings ────────────────────────────────────────────────────────────────────────────────────

fn sha_of(fields: &[&[u8]]) -> [u8; 32] {
    sha256(&lp(fields))
}

/// The targets array `[{relay, nonce}]` sorted by relay id, as the step-up binding writes it.
pub fn targets_value(targets: &[(String, String)]) -> Value {
    let mut t = targets.to_vec();
    t.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Value::Array(t.into_iter().map(|(relay, nonce)| json!({ "relay": relay, "nonce": nonce })).collect())
}

/// 4.6: `SHA-256(lp("lucid-fleet-stepup-v1", consoleId, action, target, canonical_json(params),
/// canonical_json(targets)))`, `targets` sorted by relay id here.
pub fn stepup_challenge(console_id: &str, action: &str, target: &str, params: &Value, targets: &[(String, String)]) -> Option<[u8; 32]> {
    let p = canonical_json(params).ok()?;
    let t = canonical_json(&targets_value(targets)).ok()?;
    Some(sha_of(&[STEPUP_LABEL.as_bytes(), console_id.as_bytes(), action.as_bytes(), target.as_bytes(), &p, &t]))
}

/// 4.7 requester: `SHA-256(lp("lucid-fleet-request-v1", consoleId, approvalId, action, target, canonical_json(params),
/// canonical_json(relayIds sorted), requestedAt))`.
pub fn request_challenge(console_id: &str, approval_id: &str, action: &str, target: &str, params: &Value, relay_ids: &[String], requested_at: i64) -> Option<[u8; 32]> {
    let mut ids = relay_ids.to_vec();
    ids.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let p = canonical_json(params).ok()?;
    let r = canonical_json(&json!(ids)).ok()?;
    let at = requested_at.to_string();
    Some(sha_of(&[REQUEST_LABEL.as_bytes(), console_id.as_bytes(), approval_id.as_bytes(), action.as_bytes(), target.as_bytes(), &p, &r, at.as_bytes()]))
}

/// 4.7 approver: the step-up binding of `approvals.approve` over the request.
#[allow(clippy::too_many_arguments)]
pub fn approval_challenge(console_id: &str, approval_id: &str, action: &str, target: &str, params: &Value, requested_by: &str, requested_at: i64, targets: &[(String, String)]) -> Option<[u8; 32]> {
    let p = json!({ "action": action, "target": target, "params": params, "requestedBy": requested_by, "requestedAt": requested_at });
    stepup_challenge(console_id, "approvals.approve", approval_id, &p, targets)
}

/// 4.4: `rosterHash(seq) = SHA-256(lp("lucid-fleet-roster-v1", consoleId, seq, rosterHash(seq - 1),
/// canonical_json(change)))`.
pub fn roster_hash(console_id: &str, seq: u64, prev: &[u8; 32], change: &Value) -> Option<[u8; 32]> {
    let c = canonical_json(change).ok()?;
    Some(sha_of(&[ROSTER_LABEL.as_bytes(), console_id.as_bytes(), seq.to_string().as_bytes(), prev, &c]))
}

pub fn roster_endorse_challenge(console_id: &str, seq: u64, roster_hash: &[u8; 32]) -> [u8; 32] {
    sha_of(&[ROSTER_ENDORSE_LABEL.as_bytes(), console_id.as_bytes(), seq.to_string().as_bytes(), roster_hash])
}

/// 4.5: `policyHash(seq) = SHA-256(lp("lucid-fleet-policy-v1", consoleId, seq, policyHash(seq - 1),
/// canonical_json(policy)))`.
pub fn policy_hash(console_id: &str, seq: u64, prev: &[u8; 32], policy: &Value) -> Option<[u8; 32]> {
    let c = canonical_json(policy).ok()?;
    Some(sha_of(&[POLICY_LABEL.as_bytes(), console_id.as_bytes(), seq.to_string().as_bytes(), prev, &c]))
}

pub fn policy_endorse_challenge(console_id: &str, seq: u64, policy_hash: &[u8; 32]) -> [u8; 32] {
    sha_of(&[POLICY_ENDORSE_LABEL.as_bytes(), console_id.as_bytes(), seq.to_string().as_bytes(), policy_hash])
}

/// 3.9: `SHA-256(lp("lucid-fleet-evidence-v1", attestationObject, clientDataJSON))` as 64 hex.
pub fn evidence_sha256(attestation_object: &[u8], client_data_json: &[u8]) -> String {
    hex(&sha_of(&[EVIDENCE_LABEL.as_bytes(), attestation_object, client_data_json]))
}

/// An entry without its `evidence` key (what the hashes bind).
pub fn without_evidence(entry: &Value) -> Value {
    let mut e = entry.as_object().cloned().unwrap_or_default();
    e.remove("evidence");
    Value::Object(e)
}

/// 3.9: `SHA-256(lp("lucid-fleet-bootstrap-v1", consoleId, enrollmentId, canonical_json(policy), canonical_json([entries
/// without "evidence", in order])))` as 64 hex.
pub fn bootstrap_roster_hash(console_id: &str, enrollment_id: &str, policy: &Value, entries: &[Value]) -> Option<String> {
    let p = canonical_json(policy).ok()?;
    let list = Value::Array(entries.iter().map(without_evidence).collect());
    let e = canonical_json(&list).ok()?;
    Some(hex(&sha_of(&[BOOTSTRAP_LABEL.as_bytes(), console_id.as_bytes(), enrollment_id.as_bytes(), &p, &e])))
}

/// 3.9 ceremony B: `SHA-256(lp("lucid-fleet-admin-key-v1", credentialId, cose, email, role))` as 64 hex.
pub fn admin_key_fingerprint(credential_id: &[u8], cose: &[u8], email: &str, role: &str) -> String {
    hex(&sha_of(&[ADMIN_KEY_LABEL.as_bytes(), credential_id, cose, email.as_bytes(), role.as_bytes()]))
}

/// 4.1: `SHA-256(lp("lucid-fleet-scopes-v1", relayId, requestId, generation, canonical_json(oldScopes),
/// canonical_json(requestedScopes)))` as 64 hex.
pub fn scope_request_hash(relay_id: &str, request_id: &str, generation: u64, old: &[String], requested: &[String]) -> Option<String> {
    let o = canonical_json(&json!(old)).ok()?;
    let r = canonical_json(&json!(requested)).ok()?;
    Some(hex(&sha_of(&[SCOPES_LABEL.as_bytes(), relay_id.as_bytes(), request_id.as_bytes(), generation.to_string().as_bytes(), &o, &r])))
}

/// F20: what a hub or Meeting Hub device signs for a device endorsement, `lp("lucid-fleet-endorse-key-v1",
/// canonical_json(endorsement))`; None for an endorsement that is not of the exact 3.9 shape.
pub fn endorse_signing_input(endorsement: &Value) -> Option<Vec<u8>> {
    endorsement_fields(endorsement)?;
    Some(lp(&[ENDORSE_LABEL.as_bytes(), &canonical_json(endorsement).ok()?]))
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

// ── The canonical roster entry (3.9) ────────────────────────────────────────────────────────────────────────

pub const ENTRY_KEYS: [&str; 6] = ["credentialId", "cose", "email", "role", "evidence", "evidenceSha256"];
const EVIDENCE_KEYS: [&str; 3] = ["fmt", "attestationObject", "clientDataJSON"];

/// One canonical entry as the console sends it: nothing more, nothing less (4.4).
#[derive(Clone, Debug, PartialEq)]
pub struct Canon {
    pub credential_id: String,
    pub cose: String,
    pub email: String,
    pub role: String,
    pub evidence: Value,
    pub evidence_sha256: Value,
}

impl Canon {
    pub fn to_value(&self) -> Value {
        json!({ "credentialId": self.credential_id, "cose": self.cose, "email": self.email, "role": self.role, "evidence": self.evidence, "evidenceSha256": self.evidence_sha256 })
    }

    pub fn id_bytes(&self) -> Vec<u8> {
        unb64u(&self.credential_id).unwrap_or_default()
    }

    pub fn cose_bytes(&self) -> Vec<u8> {
        unb64u(&self.cose).unwrap_or_default()
    }

    pub fn hint(&self) -> String {
        hint_of(&self.credential_id)
    }

    pub fn fingerprint(&self) -> String {
        admin_key_fingerprint(&self.id_bytes(), &self.cose_bytes(), &self.email, &self.role)
    }

    /// The same key: credential id and COSE key.
    pub fn same_key(&self, other: &Canon) -> bool {
        self.id_bytes() == other.id_bytes() && self.cose_bytes() == other.cose_bytes()
    }

    /// Shares a credential id or a COSE key.
    pub fn overlaps(&self, other: &Canon) -> bool {
        self.id_bytes() == other.id_bytes() || self.cose_bytes() == other.cose_bytes()
    }
}

fn b64_field(v: Option<&Value>, max: usize) -> Option<Vec<u8>> {
    let s = str_of(v)?;
    let raw = unb64u(s)?;
    (!raw.is_empty() && raw.len() <= max && b64u(&raw) == s).then_some(raw)
}

/// A canonical entry read strictly: exact keys, base64url ids and keys, a book email, a known role, and an evidence
/// digest that matches its evidence. Anything else is `fleet-op` (a console statement such as `attested`, `state` or
/// `heldUntil` included).
pub fn canonical_entry(v: &Value) -> Result<Canon, Refused> {
    let o = v.as_object().ok_or_else(Refused::op)?;
    if !exact_keys(o, &ENTRY_KEYS, &ENTRY_KEYS) {
        return Err(Refused::op());
    }
    b64_field(o.get("credentialId"), CRED_ID_MAX).ok_or_else(Refused::op)?;
    b64_field(o.get("cose"), COSE_MAX).ok_or_else(Refused::op)?;
    let email = str_of(o.get("email")).ok_or_else(Refused::op)?;
    if email_of(Some(email)).as_deref() != Some(email) {
        return Err(Refused::op());
    }
    let role = str_of(o.get("role")).filter(|r| matches!(*r, "admin" | "user-manager")).ok_or_else(Refused::op)?;
    let evidence = o.get("evidence").cloned().unwrap_or(Value::Null);
    let digest = o.get("evidenceSha256").cloned().unwrap_or(Value::Null);
    match (&evidence, &digest) {
        (Value::Null, Value::Null) => {}
        (Value::Object(e), Value::String(d)) => {
            if !exact_keys(e, &EVIDENCE_KEYS, &EVIDENCE_KEYS) || !str_of(e.get("fmt")).is_some_and(|f| (1..=32).contains(&f.len())) {
                return Err(Refused::op());
            }
            let att = b64_field(e.get("attestationObject"), EVIDENCE_MAX).ok_or_else(Refused::op)?;
            let cdj = b64_field(e.get("clientDataJSON"), EVIDENCE_MAX).ok_or_else(Refused::op)?;
            if evidence_sha256(&att, &cdj) != *d {
                return Err(Refused::op());
            }
        }
        _ => return Err(Refused::op()),
    }
    Ok(Canon { credential_id: str_of(o.get("credentialId")).unwrap_or("").to_owned(), cose: str_of(o.get("cose")).unwrap_or("").to_owned(), email: email.to_owned(), role: role.to_owned(), evidence, evidence_sha256: digest })
}

/// 3.9 "Duplicates": two entries share a credential id or a COSE key (entries that do not read count as clashing).
pub fn roster_duplicate(entries: &[Value]) -> bool {
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    for e in entries {
        let (Some(id), Some(cose)) = (b64_field(e.get("credentialId"), CRED_ID_MAX), b64_field(e.get("cose"), COSE_MAX)) else { return true };
        if !ids.insert(id) || !keys.insert(cose) {
            return true;
        }
    }
    false
}

/// The relay's own verdict on an entry's evidence (3.9): `verify_attestation_evidence` for the console's rpId and
/// origin, the attested credential id and COSE key equal to the entry's, then `assess` and `why_not` against the
/// relay's own snapshot.
pub fn attested_here(c: &Canon, rp_id: &str, origin: &str, mds: Option<&Snapshot>, t: i64) -> bool {
    let Some(e) = c.evidence.as_object() else { return false };
    let (Some(att), Some(cdj)) = (b64_field(e.get("attestationObject"), EVIDENCE_MAX), b64_field(e.get("clientDataJSON"), EVIDENCE_MAX)) else { return false };
    if Some(evidence_sha256(&att, &cdj).as_str()) != c.evidence_sha256.as_str() {
        return false;
    }
    let Ok(new) = verify_attestation_evidence(rp_id, origin, &att, &cdj) else { return false };
    if new.id != c.id_bytes() || new.cose != c.cose_bytes() {
        return false;
    }
    match assess(&new, mds, &[], t) {
        Ok(v) => why_not(&v, mds, &[]).is_none(),
        Err(_) => false,
    }
}

// ── F19: the proxy table and the projections (4.11, 5.4) ────────────────────────────────────────────────────

/// What a row serves with `read-health` alone.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Health {
    /// The viewer projection, built from the field allowlist.
    Viewer,
    /// Served whole (the numeric aggregate routes), still through the allowlist.
    Whole,
    /// Refused without the full scope.
    Refused,
    /// A write.
    Write,
}

pub struct ScopeRow {
    pub method: &'static str,
    pub path: &'static str,
    pub health: Health,
    /// Every scope the full projection or the write needs.
    pub scopes: &'static [&'static str],
}

const fn row(method: &'static str, path: &'static str, health: Health, scopes: &'static [&'static str]) -> ScopeRow {
    ScopeRow { method, path, health, scopes }
}

const RH: &[&str] = &["read-health"];
const PEOPLE: &[&str] = &["people"];
const LOGS: &[&str] = &["read-logs", "people"];
const CONFIG: &[&str] = &["config"];
const LICENSE: &[&str] = &["license"];
const CONFIG_PEOPLE: &[&str] = &["config", "people"];

/// `fleet_scopes` (5.4): the relay's own copy of the proxy table. A route not in it is never proxied (`fleet-route`).
pub const FLEET_SCOPES: &[ScopeRow] = &[
    row("GET", "overview", Health::Viewer, PEOPLE),
    row("GET", "search", Health::Refused, PEOPLE),
    row("GET", "spokes/counts", Health::Whole, RH),
    row("GET", "meet/counts", Health::Whole, RH),
    row("GET", "license", Health::Viewer, RH),
    row("POST", "license/install", Health::Write, LICENSE),
    row("GET", "logs", Health::Refused, LOGS),
    row("POST", "logs/export", Health::Refused, LOGS),
    row("GET", "audit", Health::Refused, LOGS),
    row("POST", "audit/export", Health::Refused, LOGS),
    row("GET", "audit/verify", Health::Refused, LOGS),
    row("POST", "audit/restart", Health::Write, LOGS),
    row("GET", "requests", Health::Refused, PEOPLE),
    row("POST", "requests/new", Health::Write, PEOPLE),
    row("POST", "requests/cancel", Health::Write, PEOPLE),
    row("GET", "spokes/nodes", Health::Refused, PEOPLE),
    row("GET", "spokes/seats", Health::Refused, PEOPLE),
    row("GET", "spokes/relays", Health::Viewer, RH),
    row("POST", "spokes/crl", Health::Write, CONFIG),
    row("POST", "spokes/directory", Health::Write, CONFIG),
    row("POST", "spokes/block", Health::Write, PEOPLE),
    row("POST", "spokes/unblock", Health::Write, PEOPLE),
    row("GET", "meet/people", Health::Refused, PEOPLE),
    row("GET", "meet/seats", Health::Refused, PEOPLE),
    row("GET", "meet/enrollments", Health::Refused, PEOPLE),
    row("GET", "meet/organizations", Health::Refused, PEOPLE),
    row("POST", "meet/seats/pick", Health::Write, PEOPLE),
    row("POST", "meet/seats/request", Health::Write, LICENSE),
    row("GET", "meet/clock", Health::Viewer, RH),
    row("GET", "meet/release", Health::Viewer, RH),
    row("GET", "meet/servers", Health::Viewer, RH),
    row("GET", "meet/calls", Health::Refused, PEOPLE),
    row("GET", "meet/signer", Health::Viewer, PEOPLE),
    row("GET", "meet/push", Health::Viewer, PEOPLE),
    row("GET", "meet/identity", Health::Viewer, PEOPLE),
    row("POST", "meet/clock/confirm", Health::Write, CONFIG),
    row("POST", "meet/crl", Health::Write, CONFIG),
    row("POST", "meet/bridge", Health::Write, CONFIG),
    row("POST", "meet/holds", Health::Write, CONFIG),
    row("POST", "meet/holds/release", Health::Write, CONFIG),
    row("POST", "meet/release", Health::Write, CONFIG),
    row("POST", "meet/files/start", Health::Write, CONFIG),
    row("POST", "meet/organizations", Health::Write, CONFIG_PEOPLE),
    row("GET", "meet/bridge", Health::Refused, CONFIG_PEOPLE),
    row("GET", "meet/holds", Health::Refused, CONFIG_PEOPLE),
    row("GET", "meet/bridge/audit", Health::Refused, LOGS),
    row("POST", "meet/block", Health::Write, PEOPLE),
    row("POST", "meet/unblock", Health::Write, PEOPLE),
    // SE-1 (meet_support.rs): Meeting Hub support tickets
    row("GET", "meet/support", Health::Refused, PEOPLE),
    row("POST", "meet/support/answer", Health::Write, PEOPLE),
    row("POST", "meet/support/close", Health::Write, PEOPLE),
    // MR-1 2.5, 4: the cluster node (viewers read it from the relay report's `cluster`)
    row("GET", "meet/cluster/status", Health::Refused, RH),
    row("GET", "meet/cluster/directory", Health::Refused, RH),
    row("POST", "meet/cluster/promote", Health::Write, CONFIG),
    row("POST", "meet/cluster/demote", Health::Write, CONFIG),
    row("POST", "meet/cluster/handover", Health::Write, CONFIG),
];

pub fn scope_row(method: &str, path: &str) -> Option<&'static ScopeRow> {
    FLEET_SCOPES.iter().find(|r| r.method == method && r.path == path)
}

/// The projection a read is served in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Projection {
    Viewer,
    Full,
}

fn granted(scopes: &[String], s: &str) -> bool {
    scopes.iter().any(|x| x == s)
}

/// The first scope of `need` not granted (`people` for a full projection that lacks it).
fn missing<'a>(need: &[&'a str], scopes: &[String]) -> Option<&'a str> {
    need.iter().copied().find(|s| !granted(scopes, s))
}

/// 4.11: the projection a read gets from the granted scopes alone. `full` needs every scope of the row and `people`
/// (and `read-logs` never stands without `people`); otherwise a `Viewer` or `Whole` row gets the viewer projection
/// and any other row is refused with the scope it lacks.
pub fn read_projection(r: &ScopeRow, scopes: &[String]) -> Result<Projection, Refused> {
    if r.health == Health::Write {
        return Err(Refused::of("fleet-route"));
    }
    let full_need: Vec<&str> = r.scopes.iter().copied().chain(["people"]).collect();
    if missing(&full_need, scopes).is_none() {
        return Ok(Projection::Full);
    }
    match r.health {
        Health::Viewer | Health::Whole if granted(scopes, "read-health") => Ok(Projection::Viewer),
        _ => Err(Refused::scope(missing(&full_need, scopes).unwrap_or("people"))),
    }
}

/// A write row's scopes, every one granted (`read-logs` only with `people`).
pub fn write_scopes_ok(r: &ScopeRow, scopes: &[String]) -> Result<(), Refused> {
    if r.health != Health::Write {
        return Err(Refused::of("fleet-route"));
    }
    match missing(r.scopes, scopes) {
        Some(s) => Err(Refused::scope(s)),
        None => Ok(()),
    }
}

/// Every route served under `read-health` alone with its field list (`admin_console_fleet_projection_v1.json`,
/// revision 3), compiled in: the relay builds those answers field by field from this list and nothing else.
const PROJECTION_VECTOR: &str = include_str!("../tests/admin_console_fleet_projection_v1.json");

#[derive(Clone, Debug)]
struct FieldRule {
    path: Vec<String>,
    ty: String,
    values: Vec<String>,
    /// For `date`: "s", "ms" or "iso".
    form: String,
    nullable: bool,
}

fn rule_of(f: &Value) -> Option<FieldRule> {
    Some(FieldRule {
        path: str_of(f.get("path"))?.split('.').map(str::to_owned).collect(),
        ty: str_of(f.get("type"))?.to_owned(),
        values: f.get("values").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default(),
        form: str_of(f.get("form")).unwrap_or("").to_owned(),
        nullable: f.get("nullable").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// The projection list: field rules per route, the attention allowlist (kind and its args) and severities.
struct Projections {
    routes: HashMap<String, Vec<FieldRule>>,
    attention: HashMap<String, Vec<FieldRule>>,
    severities: Vec<String>,
}

static PROJECTIONS: LazyLock<Projections> = LazyLock::new(read_projections);

fn read_projections() -> Projections {
    let mut p = Projections { routes: HashMap::new(), attention: HashMap::new(), severities: Vec::new() };
    let Some(v) = crate::codec::parse_json(PROJECTION_VECTOR) else { return p };
    for r in v.get("routes").and_then(Value::as_array).into_iter().flatten() {
        let Some(route) = str_of(r.get("route")) else { continue };
        let rules: Option<Vec<FieldRule>> = r.get("fields").and_then(Value::as_array).map(|a| a.iter().map(rule_of).collect()).unwrap_or(Some(Vec::new()));
        // A list that does not read serves nothing (the read is refused).
        p.routes.insert(route.to_owned(), rules.unwrap_or_default());
    }
    let att = v.get("attention");
    p.severities = att.and_then(|a| a.get("severity")).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    for k in att.and_then(|a| a.get("allowlist")).and_then(Value::as_array).into_iter().flatten() {
        let Some(kind) = str_of(k.get("kind")).filter(|k| ATTENTION_VIEWER.contains(k)) else { continue };
        let args: Option<Vec<FieldRule>> = k.get("args").and_then(Value::as_array).map(|a| a.iter().map(rule_of).collect()).unwrap_or(Some(Vec::new()));
        if let Some(args) = args {
            p.attention.insert(kind.to_owned(), args);
        }
    }
    p
}

/// The routes the projection list names ("GET spokes/counts", ...).
#[cfg(test)]
pub fn projected_routes() -> Vec<String> {
    let mut v: Vec<String> = PROJECTIONS.routes.keys().cloned().collect();
    v.sort();
    v
}

fn version_ok(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    (2..=4).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|c| c.is_ascii_digit()))
}

fn iso_date_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn leaf_ok(rule: &FieldRule, v: &Value) -> bool {
    match rule.ty.as_str() {
        "count" => is_int(Some(v)).is_some(),
        "days" => crate::codec::safe_int(Some(v)).is_some(),
        "date" if rule.form == "iso" => v.as_str().is_some_and(iso_date_ok),
        "date" => is_int(Some(v)).is_some(),
        "bool" => v.is_boolean(),
        "enum" => v.as_str().is_some_and(|s| rule.values.iter().any(|x| x == s)),
        "version" => v.as_str().is_some_and(version_ok),
        _ => false,
    }
}

/// One attention item of the viewer-safe allowlist: `{kind, severity, args}` with exactly that kind's args, each of
/// its type; None for anything else.
fn attention_item(a: &Value) -> Option<Value> {
    let kind = str_of(a.get("kind"))?;
    let rules = PROJECTIONS.attention.get(kind)?;
    let severity = str_of(a.get("severity")).filter(|s| PROJECTIONS.severities.iter().any(|x| x == s))?;
    let src = a.get("args").cloned().unwrap_or_else(|| json!({}));
    let mut args = Map::new();
    for r in rules {
        let name = r.path.first()?;
        let v = src.get(name.as_str()).unwrap_or(&Value::Null);
        if leaf_ok(r, v) {
            args.insert(name.clone(), v.clone());
        } else if r.nullable && v.is_null() {
            args.insert(name.clone(), Value::Null);
        } else {
            return None;
        }
    }
    Some(json!({ "kind": kind, "severity": severity, "args": args }))
}

/// One level of the allowlist: `rules` with their paths relative to `src`. None when a field that may not be null is
/// missing or of the wrong type.
fn build(src: &Value, rules: &[(Vec<String>, &FieldRule)]) -> Option<Value> {
    let mut out = Map::new();
    let mut heads: Vec<&str> = Vec::new();
    for (p, _) in rules {
        if let Some(h) = p.first() {
            if !heads.contains(&h.as_str()) {
                heads.push(h);
            }
        }
    }
    for head in heads {
        let group: Vec<(Vec<String>, &FieldRule)> = rules.iter().filter(|(p, _)| p.first().map(String::as_str) == Some(head)).map(|(p, r)| (p[1..].to_vec(), *r)).collect();
        let all_nullable = group.iter().all(|(_, r)| r.nullable);
        if let Some(name) = head.strip_suffix("[]") {
            let items = src.get(name).and_then(Value::as_array);
            let Some(items) = items else {
                if all_nullable {
                    out.insert(name.to_owned(), Value::Null);
                    continue;
                }
                return None;
            };
            let leaf: Vec<&FieldRule> = group.iter().filter(|(p, _)| p.is_empty()).map(|(_, r)| *r).collect();
            let kept: Vec<Value> = match leaf.first() {
                Some(rule) if rule.ty == "attention" => items.iter().filter_map(attention_item).collect(),
                Some(rule) => items.iter().filter(|x| leaf_ok(rule, x)).cloned().collect(),
                None => items.iter().filter_map(|x| build(x, &group)).collect(),
            };
            out.insert(name.to_owned(), Value::Array(kept));
            continue;
        }
        let here = src.get(head).unwrap_or(&Value::Null);
        if let Some((_, rule)) = group.iter().find(|(p, r)| p.is_empty() && r.ty == "object") {
            // An "object" field: null when allowed, else exactly its listed sub-fields.
            let subs: Vec<(Vec<String>, &FieldRule)> = group.iter().filter(|(p, _)| !p.is_empty()).cloned().collect();
            match here {
                Value::Null if rule.nullable => {
                    out.insert(head.to_owned(), Value::Null);
                }
                Value::Object(_) => match build(here, &subs) {
                    Some(v) => {
                        out.insert(head.to_owned(), v);
                    }
                    None if rule.nullable => {
                        out.insert(head.to_owned(), Value::Null);
                    }
                    None => return None,
                },
                _ => return None,
            }
            continue;
        }
        if let Some((_, rule)) = group.iter().find(|(p, _)| p.is_empty()) {
            if leaf_ok(rule, here) {
                out.insert(head.to_owned(), here.clone());
            } else if rule.nullable {
                out.insert(head.to_owned(), Value::Null);
            } else {
                return None;
            }
            continue;
        }
        match here {
            Value::Object(_) => match build(here, &group) {
                Some(v) => {
                    out.insert(head.to_owned(), v);
                }
                None if all_nullable => {
                    out.insert(head.to_owned(), Value::Null);
                }
                None => return None,
            },
            _ if all_nullable => {
                out.insert(head.to_owned(), Value::Null);
            }
            _ => return None,
        }
    }
    Some(Value::Object(out))
}

/// The answer of a route served under `read-health` alone, built from its allowlist: every listed field with a value
/// of its type (null where the list allows it), nothing else. List items that do not fit are dropped. None when the
/// route has no list or a required field does not fit (the read is then refused).
pub fn project(method: &str, path: &str, answer: &Value) -> Option<Value> {
    let rules = PROJECTIONS.routes.get(&format!("{method} {path}"))?;
    if rules.is_empty() {
        return None;
    }
    let rel: Vec<(Vec<String>, &FieldRule)> = rules.iter().map(|r| (r.path.clone(), r)).collect();
    build(answer, &rel)
}

/// The attention items pushed for a projection (4.11): under `read-health` alone only the viewer-safe allowlist, each
/// item `{kind, severity, args}` with exactly its kind's args; with `people` the full list.
pub fn attention_for(items: &[Value], projection: Projection) -> Vec<Value> {
    if projection == Projection::Full {
        return items.to_vec();
    }
    items.iter().filter_map(attention_item).collect()
}

// ── The link's trust state (fleet.json, the keys f-trust owns) ──────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyState {
    Inactive,
    Held,
    Active,
    Unattested,
}

impl KeyState {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyState::Inactive => "inactive",
            KeyState::Held => "held",
            KeyState::Active => "active",
            KeyState::Unattested => "unattested",
        }
    }

    fn parse(s: &str) -> Option<KeyState> {
        Some(match s {
            "inactive" => KeyState::Inactive,
            "held" => KeyState::Held,
            "active" => KeyState::Active,
            "unattested" => KeyState::Unattested,
            _ => return None,
        })
    }
}

/// A first key's anchor (3.9): `device` with the hub serial or device id, or `admin-key` with the fingerprint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub via: String,
    pub by: String,
}

/// A roster entry as the relay keeps it (4.4).
#[derive(Clone, Debug)]
pub struct Entry {
    pub hint: String,
    pub canon: Canon,
    pub attested: bool,
    pub state: KeyState,
    /// `{acceptedAtMs, needMs}` in running time.
    pub hold: Option<(i64, i64)>,
    pub hold_completed: bool,
    pub added_seq: u64,
    pub sign_count: u32,
    pub anchor: Option<Anchor>,
}

impl Entry {
    pub fn new(canon: Canon, added_seq: u64) -> Entry {
        Entry { hint: canon.hint(), canon, attested: false, state: KeyState::Inactive, hold: None, hold_completed: false, added_seq, sign_count: 0, anchor: None }
    }

    pub fn is_admin(&self) -> bool {
        self.canon.role == "admin"
    }

    fn to_value(&self) -> Value {
        let mut v = self.canon.to_value();
        let m = v.as_object_mut().expect("an object");
        m.insert("hint".into(), Value::from(self.hint.as_str()));
        m.insert("attested".into(), Value::Bool(self.attested));
        m.insert("state".into(), Value::from(self.state.as_str()));
        m.insert("hold".into(), self.hold.map_or(Value::Null, |(a, n)| json!({ "acceptedAtMs": a, "needMs": n })));
        m.insert("holdCompleted".into(), Value::Bool(self.hold_completed));
        m.insert("addedSeq".into(), Value::from(self.added_seq));
        m.insert("signCount".into(), Value::from(self.sign_count));
        m.insert("anchor".into(), self.anchor.as_ref().map_or(Value::Null, |a| json!({ "via": a.via, "by": a.by })));
        v
    }

    /// An entry as stored: the canonical keys plus what the relay decided (apply writes only `state` besides them).
    fn from_value(v: &Value) -> Option<Entry> {
        let o = v.as_object()?;
        let canon_part: Map<String, Value> = ENTRY_KEYS.iter().filter_map(|k| o.get(*k).map(|x| ((*k).to_owned(), x.clone()))).collect();
        let canon = canonical_entry(&Value::Object(canon_part)).ok()?;
        let hold = match o.get("hold") {
            Some(Value::Object(h)) => Some((is_int(h.get("acceptedAtMs"))?, is_int(h.get("needMs"))?)),
            _ => None,
        };
        let anchor = match o.get("anchor") {
            Some(Value::Object(a)) => Some(Anchor { via: str_of(a.get("via"))?.to_owned(), by: str_of(a.get("by"))?.to_owned() }),
            _ => None,
        };
        Some(Entry {
            hint: canon.hint(),
            attested: o.get("attested").and_then(Value::as_bool).unwrap_or(false),
            state: str_of(o.get("state")).and_then(KeyState::parse).unwrap_or(KeyState::Inactive),
            hold,
            hold_completed: o.get("holdCompleted").and_then(Value::as_bool).unwrap_or(false),
            added_seq: is_int(o.get("addedSeq")).unwrap_or(0) as u64,
            sign_count: is_int(o.get("signCount")).unwrap_or(0).min(u32::MAX as i64) as u32,
            anchor,
            canon,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub high: bool,
    pub two_person: bool,
}

impl Policy {
    pub fn to_value(self) -> Value {
        json!({ "profile": if self.high { "high" } else { "standard" }, "twoPerson": if self.two_person { "on" } else { "off" } })
    }

    pub fn parse(v: &Value) -> Option<Policy> {
        let o = v.as_object()?;
        if !exact_keys(o, &["profile", "twoPerson"], &["profile", "twoPerson"]) {
            return None;
        }
        let high = match str_of(o.get("profile"))? {
            "high" => true,
            "standard" => false,
            _ => return None,
        };
        let two_person = match str_of(o.get("twoPerson"))? {
            "on" => true,
            "off" => false,
            _ => return None,
        };
        Some(Policy { high, two_person })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeRequest {
    pub request_id: String,
    pub generation: u64,
    pub old: Vec<String>,
    pub requested: Vec<String>,
    pub hash: String,
}

impl ScopeRequest {
    fn to_value(&self) -> Value {
        json!({ "requestId": self.request_id, "generation": self.generation, "oldScopes": self.old, "requestedScopes": self.requested, "hash": self.hash })
    }

    /// What `scopes` answers and `state` reports.
    pub fn view(&self) -> Value {
        json!({ "requestId": self.request_id, "requestedScopes": self.requested, "hash": self.hash })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bootstrap {
    /// "pending" or "done".
    pub done: bool,
    pub hash: String,
    /// "code" or "same-process".
    pub via: String,
    /// Ceremony B fingerprints the operator gave, until applied.
    pub admin_keys: Vec<String>,
}

/// The link as f-trust reads and writes it. The channel's keys are read here and never written.
#[derive(Clone, Debug)]
pub struct Link {
    pub console_id: String,
    pub relay_id: String,
    pub origin: String,
    pub rp_id: String,
    pub scopes: Vec<String>,
    pub scope_generation: u64,
    pub scope_request: Option<ScopeRequest>,
    pub policy: Policy,
    pub policy_seq: u64,
    pub policy_hash: [u8; 32],
    pub bootstrap: Bootstrap,
    pub roster: Vec<Entry>,
    pub roster_seq: u64,
    pub roster_hash: [u8; 32],
    pub running_ms: i64,
    /// (approval id, used at ms).
    pub used_approvals: Vec<(String, i64)>,
    /// Hints the operator refused (`refuse-key`, A3-H1): never active again on this link.
    pub refused_keys: Vec<String>,
}

fn strings(v: Option<&Value>) -> Option<Vec<String>> {
    v?.as_array()?.iter().map(|x| x.as_str().map(str::to_owned)).collect()
}

fn hash_of(v: Option<&Value>) -> Option<[u8; 32]> {
    unhex32(str_of(v)?)
}

impl Link {
    /// The link from `fleet.json`'s object. Err when a key f-trust needs does not read (the relay then runs
    /// unmanaged, as an unreadable `fleet.json`).
    pub fn from_map(m: &Map<String, Value>) -> Result<Link, String> {
        let s = |k: &str| str_of(m.get(k)).map(str::to_owned).ok_or_else(|| format!("{LINK_FILE}: {k} is missing"));
        let scopes = strings(m.get("scopes")).ok_or("fleet.json: scopes do not read")?;
        let scope_request = match m.get("scopeRequest") {
            None | Some(Value::Null) => None,
            Some(r) => Some(ScopeRequest {
                request_id: str_of(r.get("requestId")).ok_or("fleet.json: scopeRequest does not read")?.to_owned(),
                generation: is_int(r.get("generation")).ok_or("fleet.json: scopeRequest does not read")? as u64,
                old: strings(r.get("oldScopes")).ok_or("fleet.json: scopeRequest does not read")?,
                requested: strings(r.get("requestedScopes")).ok_or("fleet.json: scopeRequest does not read")?,
                hash: str_of(r.get("hash")).ok_or("fleet.json: scopeRequest does not read")?.to_owned(),
            }),
        };
        let policy = m.get("policy").and_then(Policy::parse).ok_or("fleet.json: policy does not read")?;
        let b = m.get("bootstrap").and_then(Value::as_object).ok_or("fleet.json: bootstrap does not read")?;
        let bootstrap = Bootstrap {
            done: match str_of(b.get("state")) {
                Some("done") => true,
                Some("pending") => false,
                _ => return Err("fleet.json: bootstrap state does not read".into()),
            },
            hash: str_of(b.get("bootstrapRosterHash")).unwrap_or("").to_owned(),
            via: str_of(b.get("via")).unwrap_or("code").to_owned(),
            admin_keys: strings(b.get("adminKeys")).unwrap_or_default(),
        };
        let roster: Vec<Entry> = m.get("roster").and_then(Value::as_array).ok_or("fleet.json: roster does not read")?.iter().map(Entry::from_value).collect::<Option<_>>().ok_or("fleet.json: a roster entry does not read")?;
        let used = m
            .get("usedApprovals")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|u| Some((str_of(u.get("id"))?.to_owned(), is_int(u.get("at"))?))).collect())
            .unwrap_or_default();
        Ok(Link {
            console_id: s("consoleId")?,
            relay_id: s("relayId")?,
            origin: s("origin")?,
            rp_id: s("rpId")?,
            scopes,
            scope_generation: is_int(m.get("scopeGeneration")).unwrap_or(0) as u64,
            scope_request,
            policy,
            policy_seq: is_int(m.get("policySeq")).ok_or("fleet.json: policySeq does not read")? as u64,
            policy_hash: hash_of(m.get("policyHash")).ok_or("fleet.json: policyHash does not read")?,
            bootstrap,
            roster,
            roster_seq: is_int(m.get("rosterSeq")).ok_or("fleet.json: rosterSeq does not read")? as u64,
            roster_hash: hash_of(m.get("rosterHash")).ok_or("fleet.json: rosterHash does not read")?,
            running_ms: is_int(m.get("runningMs")).unwrap_or(0),
            used_approvals: used,
            refused_keys: strings(m.get("refusedKeys")).unwrap_or_default(),
        })
    }

    /// Write the keys f-trust owns into `fleet.json`'s object; every other key is left as it is.
    pub fn write_into(&self, m: &mut Map<String, Value>) {
        m.insert("scopes".into(), json!(self.scopes));
        m.insert("scopeGeneration".into(), Value::from(self.scope_generation));
        m.insert("scopeRequest".into(), self.scope_request.as_ref().map_or(Value::Null, ScopeRequest::to_value));
        m.insert("policy".into(), self.policy.to_value());
        m.insert("policySeq".into(), Value::from(self.policy_seq));
        m.insert("policyHash".into(), Value::from(hex(&self.policy_hash)));
        let mut b = json!({ "state": if self.bootstrap.done { "done" } else { "pending" }, "bootstrapRosterHash": self.bootstrap.hash, "via": self.bootstrap.via });
        if !self.bootstrap.admin_keys.is_empty() {
            b["adminKeys"] = json!(self.bootstrap.admin_keys);
        }
        m.insert("bootstrap".into(), b);
        m.insert("roster".into(), Value::Array(self.roster.iter().map(Entry::to_value).collect()));
        m.insert("rosterSeq".into(), Value::from(self.roster_seq));
        m.insert("rosterHash".into(), Value::from(hex(&self.roster_hash)));
        m.insert("runningMs".into(), Value::from(self.running_ms));
        m.insert("usedApprovals".into(), Value::Array(self.used_approvals.iter().map(|(id, at)| json!({ "id": id, "at": at })).collect()));
        m.insert("refusedKeys".into(), json!(self.refused_keys));
    }

    pub fn has(&self, scope: &str) -> bool {
        granted(&self.scopes, scope)
    }

    pub fn has_write_scope(&self) -> bool {
        WRITE_SCOPES.iter().any(|s| self.has(s))
    }

    pub fn entry(&self, hint: &str) -> Option<&Entry> {
        self.roster.iter().find(|e| e.hint == hint)
    }

    /// The index of the entry with this credential id (base64url or raw bytes compared).
    pub fn find_credential(&self, raw: &[u8]) -> Option<usize> {
        self.roster.iter().position(|e| e.canon.id_bytes() == raw)
    }

    /// Distinct emails of active admin entries.
    pub fn active_admin_emails(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for e in self.roster.iter().filter(|e| e.is_admin() && e.state == KeyState::Active) {
            if !out.contains(&e.canon.email) {
                out.push(e.canon.email.clone());
            }
        }
        out
    }

    pub fn hints_in(&self, state: KeyState) -> Vec<String> {
        self.roster.iter().filter(|e| e.state == state).map(|e| e.hint.clone()).collect()
    }

    /// Verify one assertion over `challenge` by an active entry (4.8 step 5): the entry by credential id, the
    /// signature with user verification for the console's rpId and origin, the sign count moving forward when both
    /// are nonzero. The entry's index; the stored count is raised.
    pub fn verify(&mut self, credential: &Value, challenge: &[u8; 32]) -> Result<usize, Refused> {
        let raw = credential_id(credential).map_err(|_| Refused::of("fleet-stepup"))?;
        let i = self.find_credential(&raw).ok_or_else(|| Refused::of("fleet-roster"))?;
        if self.roster[i].state != KeyState::Active || self.refused_keys.contains(&self.roster[i].hint) {
            return Err(Refused::of("fleet-roster"));
        }
        let cose = self.roster[i].canon.cose_bytes();
        let count = verify_stepup_assertion(&self.rp_id, &self.origin, challenge, &cose, credential).map_err(|_| Refused::of("fleet-stepup"))?;
        let stored = self.roster[i].sign_count;
        if count != 0 && stored != 0 && count <= stored {
            return Err(Refused::of("fleet-counter"));
        }
        self.roster[i].sign_count = stored.max(count);
        Ok(i)
    }

    /// The running time of a fresh hold.
    fn hold_now(&mut self, i: usize, running: i64) {
        self.roster[i].state = KeyState::Held;
        self.roster[i].hold = Some((running, HOLD_MS));
        self.roster[i].hold_completed = false;
    }

    /// Accept a key the relay just trusted (an anchor after the bootstrap, or an endorsed add): under a local High
    /// profile only an attested key, and held; under Standard active at once.
    fn accept(&mut self, i: usize, high: bool, running: i64, notes: &mut Vec<Note>, why: &'static str) {
        if self.refused_keys.contains(&self.roster[i].hint) {
            return;
        }
        if high && !self.roster[i].attested {
            self.roster[i].state = KeyState::Unattested;
            return;
        }
        if high {
            self.hold_now(i, running);
            notes.push(Note::Held { hint: self.roster[i].hint.clone(), why });
        } else {
            self.roster[i].state = KeyState::Active;
        }
    }

    /// Recompute the relay's own attestation verdicts (at start, after apply, and when its snapshot changes).
    pub fn attest_all(&mut self, mds: Option<&Snapshot>, t: i64) {
        let (rp, origin) = (self.rp_id.clone(), self.origin.clone());
        for e in &mut self.roster {
            e.attested = attested_here(&e.canon, &rp, &origin, mds, t);
        }
    }

    /// Holds, re-holds and the attestation rule, at `running` ms of the relay's own running time under a local
    /// profile that is High or not (4.4). Notes for the audit and the log.
    pub fn settle(&mut self, high: bool, running: i64) -> Vec<Note> {
        let mut notes = Vec::new();
        let refused: HashSet<String> = self.refused_keys.iter().cloned().collect();
        self.roster.retain(|e| !refused.contains(&e.hint));
        for i in 0..self.roster.len() {
            let e = self.roster[i].clone();
            match e.state {
                KeyState::Held => {
                    let (at, need) = e.hold.unwrap_or((running, HOLD_MS));
                    if high && !e.attested {
                        self.roster[i].state = KeyState::Unattested;
                        self.roster[i].hold = None;
                    } else if running - at >= need {
                        self.roster[i].state = KeyState::Active;
                        self.roster[i].hold = None;
                        self.roster[i].hold_completed = true;
                        notes.push(Note::Active { hint: self.roster[i].hint.clone() });
                    }
                }
                KeyState::Active if high && !e.hold_completed => {
                    if e.attested {
                        self.hold_now(i, running);
                        notes.push(Note::Held { hint: self.roster[i].hint.clone(), why: "profile-high" });
                    } else {
                        self.roster[i].state = KeyState::Unattested;
                    }
                }
                KeyState::Unattested if self.bootstrap.done => {
                    // Back to the acceptance rule once trusted: attested now, or the profile is no longer High.
                    let trusted = e.anchor.is_some() || e.added_seq > 0;
                    if trusted && (e.attested || !high) {
                        self.accept(i, high, running, &mut notes, "add");
                    }
                }
                _ => {}
            }
        }
        notes
    }

    /// Ceremony B (3.9): mark `admin-key` the entries whose fingerprint the operator listed, then forget the list.
    pub fn apply_admin_keys(&mut self) -> Vec<Note> {
        let keys = std::mem::take(&mut self.bootstrap.admin_keys);
        let mut notes = Vec::new();
        if self.bootstrap.done {
            return notes;
        }
        let wanted: HashSet<String> = keys.iter().map(|k| k.trim().to_ascii_lowercase()).collect();
        for e in &mut self.roster {
            let fp = e.canon.fingerprint();
            if e.anchor.is_none() && wanted.contains(&fp) {
                e.anchor = Some(Anchor { via: "admin-key".into(), by: format!("admin-key:{fp}") });
                notes.push(Note::Anchor { hint: e.hint.clone(), via: "admin-key", by: fp, email: "operator".into() });
            }
        }
        notes
    }

    /// 3.9 "When the bootstrap completes": one anchored admin entry, or with a High policy and two-person on two
    /// anchored admin entries of different emails by independent anchors. Then the anchored entries are accepted.
    pub fn try_complete_bootstrap(&mut self, high: bool, running: i64) -> Option<(Vec<String>, Vec<String>, Vec<Note>)> {
        if self.bootstrap.done {
            return None;
        }
        let anchored: Vec<(&str, &str)> = self.roster.iter().filter(|e| e.is_admin() && !self.refused_keys.contains(&e.hint)).filter_map(|e| e.anchor.as_ref().map(|a| (e.canon.email.as_str(), a.by.as_str()))).collect();
        let enough = if self.policy.high && self.policy.two_person {
            anchored.iter().enumerate().any(|(i, a)| anchored.iter().skip(i + 1).any(|b| a.0 != b.0 && a.1 != b.1))
        } else {
            !anchored.is_empty()
        };
        if !enough {
            return None;
        }
        self.bootstrap.done = true;
        let mut notes = Vec::new();
        for i in 0..self.roster.len() {
            if self.roster[i].anchor.is_some() && self.roster[i].state == KeyState::Inactive {
                self.accept(i, high, running, &mut notes, "add");
            }
        }
        let activated = self.roster.iter().filter(|e| e.anchor.is_some() && matches!(e.state, KeyState::Active | KeyState::Held)).map(|e| e.hint.clone()).collect();
        let unattested = self.hints_in(KeyState::Unattested);
        Some((activated, unattested, notes))
    }

    /// Same-process enrollment (2.2, Standard only): no anchors, every entry accepted.
    pub fn complete_same_process(&mut self, running: i64) -> Option<(Vec<String>, Vec<String>, Vec<Note>)> {
        if self.bootstrap.done || self.bootstrap.via != "same-process" {
            return None;
        }
        self.bootstrap.done = true;
        let mut notes = Vec::new();
        for i in 0..self.roster.len() {
            if self.roster[i].state == KeyState::Inactive {
                self.accept(i, false, running, &mut notes, "add");
            }
        }
        Some((self.hints_in(KeyState::Active), self.hints_in(KeyState::Unattested), notes))
    }

    /// The operator's `refuse-key` (4.2, A3-H1): the hint recorded in `refusedKeys` and the entry removed, in the one
    /// write the caller makes next. False when it was already in place.
    pub fn refuse_key(&mut self, hint: &str) -> bool {
        let had = self.roster.iter().any(|e| e.hint == hint);
        let new = !self.refused_keys.iter().any(|h| h == hint);
        if new {
            self.refused_keys.push(hint.to_owned());
        }
        self.roster.retain(|e| e.hint != hint);
        had || new
    }

    /// A roster admin's `roster-cancel` (4.4): only a held key is cancelled.
    pub fn cancel_held(&mut self, hint: &str) -> bool {
        let before = self.roster.len();
        self.roster.retain(|e| !(e.hint == hint && e.state == KeyState::Held));
        before != self.roster.len()
    }

    /// Drop used approval ids older than 15 days.
    pub fn sweep(&mut self, t: i64) {
        self.used_approvals.retain(|(_, at)| t - at < USED_APPROVAL_MS);
    }

    /// The `hello` fields f-trust owns (F5).
    pub fn hello_fields(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("scopes".into(), json!(self.scopes));
        m.insert("scopeGeneration".into(), Value::from(self.scope_generation));
        m.insert("bootstrap".into(), Value::from(if self.bootstrap.done { "done" } else { "pending" }));
        m.insert("policySeq".into(), Value::from(self.policy_seq));
        m.insert("rosterSeq".into(), Value::from(self.roster_seq));
        m
    }
}

/// Something that happened to a key, for the audit and the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Note {
    Held { hint: String, why: &'static str },
    Active { hint: String },
    Anchor { hint: String, via: &'static str, by: String, email: String },
    Refused { hint: String },
}

// ── Nonces (4.6) ────────────────────────────────────────────────────────────────────────────────────────────

/// The relay's open single-use nonces (memory only, 120 s, at most 64).
#[derive(Default)]
pub struct Nonces {
    open: VecDeque<(String, i64)>,
}

impl Nonces {
    /// `n` new nonces (1 to 16), the oldest dropped past 64.
    pub fn draw(&mut self, n: usize, t: i64) -> Option<Vec<String>> {
        if !(1..=16).contains(&n) {
            return None;
        }
        self.open.retain(|(_, exp)| *exp > t);
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let b = crate::console_auth::random(32)?;
            let s = b64u(&b);
            self.open.push_back((s.clone(), t + NONCE_MS));
            out.push(s);
        }
        while self.open.len() > NONCES_MAX {
            self.open.pop_front();
        }
        Some(out)
    }

    /// Consume a nonce: true when it was open and in date. Gone either way.
    pub fn take(&mut self, nonce: &str, t: i64) -> bool {
        let Some(i) = self.open.iter().position(|(n, _)| n == nonce) else { return false };
        let (_, exp) = self.open.remove(i).expect("an index in range");
        exp > t
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.open.len()
    }
}

// ── Write authorization (4.6 to 4.8 step 5) ─────────────────────────────────────────────────────────────────

/// Who an authorized write runs as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteAuth {
    pub hint: String,
    pub email: String,
    pub role: String,
    pub mode: &'static str,
    /// Mode two: the approver's hint and email and the approval id.
    pub approver: Option<(String, String)>,
    pub approval_id: Option<String>,
}

fn targets_of(v: Option<&Value>) -> Option<Vec<(String, String)>> {
    let a = v?.as_array()?;
    if a.is_empty() || a.len() > 200 {
        return None;
    }
    a.iter()
        .map(|t| {
            let o = t.as_object()?;
            exact_keys(o, &["relay", "nonce"], &["relay", "nonce"]).then_some(())?;
            Some((str_of(o.get("relay"))?.to_owned(), str_of(o.get("nonce"))?.to_owned()))
        })
        .collect()
}

/// This relay's own nonce in `targets`, consumed now whatever follows (4.8 step 5).
fn own_nonce(link: &Link, nonces: &mut Nonces, nonce: Option<&str>, targets: &[(String, String)], t: i64) -> Result<(), Refused> {
    let Some(n) = nonce else { return Err(Refused::op()) };
    let fresh = nonces.take(n, t);
    let mine = targets.iter().filter(|(r, _)| *r == link.relay_id).collect::<Vec<_>>();
    if !fresh || mine.len() != 1 || mine[0].1 != n {
        return Err(Refused::of("fleet-stepup"));
    }
    Ok(())
}

/// Check a write's `auth` (4.6, 4.7) for `action`, `target` and `params`: mode one by one active entry over this
/// relay's nonce; mode two by a requester and an approver, active admins of different emails, the request at most
/// 14 days old and 5 minutes ahead, its id never used here (recorded now). The caller checks the role the action needs
/// and the second-admin rule.
pub fn authorize(link: &mut Link, nonces: &mut Nonces, auth: &Value, action: &str, target: &str, params: &Value, t: i64) -> Result<WriteAuth, Refused> {
    let o = auth.as_object().ok_or_else(|| Refused::of("fleet-stepup"))?;
    match str_of(o.get("mode")) {
        Some("one") => {
            if !exact_keys(o, &["mode", "credential", "nonce", "targets"], &["mode", "credential", "nonce", "targets"]) {
                return Err(Refused::op());
            }
            let targets = targets_of(o.get("targets")).ok_or_else(Refused::op)?;
            own_nonce(link, nonces, str_of(o.get("nonce")), &targets, t)?;
            let challenge = stepup_challenge(&link.console_id, action, target, params, &targets).ok_or_else(|| Refused::of("fleet-stepup"))?;
            let i = link.verify(o.get("credential").unwrap_or(&Value::Null), &challenge)?;
            let e = &link.roster[i];
            Ok(WriteAuth { hint: e.hint.clone(), email: e.canon.email.clone(), role: e.canon.role.clone(), mode: "one", approver: None, approval_id: None })
        }
        Some("two") => {
            if !exact_keys(o, &["mode", "request", "approve"], &["mode", "request", "approve"]) {
                return Err(Refused::op());
            }
            let rq = o.get("request").and_then(Value::as_object).ok_or_else(Refused::op)?;
            let ap = o.get("approve").and_then(Value::as_object).ok_or_else(Refused::op)?;
            let rk = ["credential", "approvalId", "requestedAt", "requestedBy"];
            let ak = ["credential", "nonce", "targets"];
            if !exact_keys(rq, &rk, &rk) || !exact_keys(ap, &ak, &ak) {
                return Err(Refused::op());
            }
            let approval_id = str_of(rq.get("approvalId")).filter(|s| (1..=64).contains(&s.len())).ok_or_else(Refused::op)?.to_owned();
            let requested_at = crate::codec::safe_int(rq.get("requestedAt")).ok_or_else(Refused::op)?;
            let requested_by = str_of(rq.get("requestedBy")).ok_or_else(Refused::op)?.to_owned();
            let targets = targets_of(ap.get("targets")).ok_or_else(Refused::op)?;
            own_nonce(link, nonces, str_of(ap.get("nonce")), &targets, t)?;
            if requested_at < t - REQUEST_MAX_AGE_MS || requested_at > t + REQUEST_AHEAD_MS {
                return Err(Refused::of("fleet-stepup"));
            }
            link.sweep(t);
            if link.used_approvals.iter().any(|(id, _)| *id == approval_id) {
                return Err(Refused::of("fleet-stepup"));
            }
            let relay_ids: Vec<String> = targets.iter().map(|(r, _)| r.clone()).collect();
            let req_challenge = request_challenge(&link.console_id, &approval_id, action, target, params, &relay_ids, requested_at).ok_or_else(|| Refused::of("fleet-stepup"))?;
            let ap_challenge = approval_challenge(&link.console_id, &approval_id, action, target, params, &requested_by, requested_at, &targets).ok_or_else(|| Refused::of("fleet-stepup"))?;
            let ri = link.verify(rq.get("credential").unwrap_or(&Value::Null), &req_challenge)?;
            let ai = link.verify(ap.get("credential").unwrap_or(&Value::Null), &ap_challenge)?;
            let (r, a) = (&link.roster[ri], &link.roster[ai]);
            if !r.is_admin() || !a.is_admin() || r.canon.email == a.canon.email || r.canon.email != requested_by {
                return Err(Refused::of("fleet-stepup"));
            }
            let out = WriteAuth {
                hint: r.hint.clone(),
                email: r.canon.email.clone(),
                role: r.canon.role.clone(),
                mode: "two",
                approver: Some((a.hint.clone(), a.canon.email.clone())),
                approval_id: Some(approval_id.clone()),
            };
            link.used_approvals.push((approval_id, t));
            Ok(out)
        }
        _ => Err(Refused::of("fleet-stepup")),
    }
}

/// Endorsements of a roster or policy update: assertions over `challenge` by active admin entries; the distinct
/// emails that verified.
fn endorsing_emails(link: &mut Link, endorsements: Option<&Value>, challenge: &[u8; 32]) -> Result<Vec<String>, Refused> {
    let list = endorsements.and_then(Value::as_array).ok_or_else(Refused::op)?;
    if list.len() > 8 {
        return Err(Refused::op());
    }
    let mut emails: Vec<String> = Vec::new();
    for c in list {
        let i = link.verify(c, challenge)?;
        if !link.roster[i].is_admin() {
            return Err(Refused::of("fleet-stepup"));
        }
        let email = link.roster[i].canon.email.clone();
        if !emails.contains(&email) {
            emails.push(email);
        }
    }
    Ok(emails)
}

/// What a roster update did.
#[derive(Debug, Default)]
pub struct RosterDone {
    pub seq: u64,
    pub adds: Vec<Value>,
    pub removes: Vec<String>,
    pub ignored: Vec<String>,
    pub notes: Vec<Note>,
}

/// A `roster` frame (4.4): after the bootstrap only, in order (`seq` one more, `prev` the current hash), canonical
/// entries only, no duplicates within the adds or against a different stored entry, adds endorsed by one active admin
/// (two of different emails with two-person on); removes on the console's word. A refused hint is never added back.
pub fn roster_update(link: &mut Link, body: &Value, high: bool, mds: Option<&Snapshot>, running: i64, t: i64) -> Result<RosterDone, Refused> {
    let o = body.as_object().ok_or_else(Refused::op)?;
    let keys = ["seq", "prev", "change", "endorsements"];
    if !exact_keys(o, &keys, &keys) {
        return Err(Refused::op());
    }
    if !link.bootstrap.done {
        return Err(Refused::of("fleet-bootstrap"));
    }
    let seq = is_int(o.get("seq")).ok_or_else(Refused::op)? as u64;
    let prev = hash_of(o.get("prev")).ok_or_else(Refused::op)?;
    if seq != link.roster_seq + 1 || prev != link.roster_hash {
        return Err(Refused::with("stale", "Nothing was changed: this roster update is out of order."));
    }
    let change = o.get("change").and_then(Value::as_object).ok_or_else(Refused::op)?;
    if !exact_keys(change, &["adds", "removes"], &["adds", "removes"]) {
        return Err(Refused::op());
    }
    let adds_raw = change.get("adds").and_then(Value::as_array).ok_or_else(Refused::op)?;
    let removes = strings(change.get("removes")).ok_or_else(Refused::op)?;
    let adds: Vec<Canon> = adds_raw.iter().map(canonical_entry).collect::<Result<_, _>>()?;
    if roster_duplicate(adds_raw) {
        return Err(Refused::of("fleet-roster-duplicate"));
    }
    for a in &adds {
        if link.roster.iter().any(|e| e.canon.overlaps(a) && !(e.canon == *a || (e.canon.same_key(a) && e.canon.email == a.email && e.canon.role == a.role))) {
            return Err(Refused::of("fleet-roster-duplicate"));
        }
    }
    let hashed = json!({ "adds": adds_raw.iter().map(without_evidence).collect::<Vec<_>>(), "removes": removes });
    let hash = roster_hash(&link.console_id, seq, &prev, &hashed).ok_or_else(Refused::op)?;
    if !adds.is_empty() {
        let challenge = roster_endorse_challenge(&link.console_id, seq, &hash);
        let emails = endorsing_emails(link, o.get("endorsements"), &challenge)?;
        let need = if link.policy.two_person { 2 } else { 1 };
        if emails.len() < need {
            return Err(Refused::of("fleet-second"));
        }
    }
    let surviving = link.roster.iter().filter(|e| !removes.contains(&e.hint)).count();
    let new_count = adds.iter().filter(|a| !link.roster.iter().any(|e| e.canon.same_key(a))).count();
    if surviving + new_count > ROSTER_MAX {
        return Err(Refused::with("fleet-op", "The relay keeps at most 200 roster entries."));
    }
    let mut done = RosterDone { seq, removes: removes.clone(), ..RosterDone::default() };
    link.roster.retain(|e| !removes.contains(&e.hint));
    for a in adds {
        let hint = a.hint();
        if link.refused_keys.contains(&hint) {
            done.ignored.push(hint.clone());
            done.notes.push(Note::Refused { hint });
            continue;
        }
        let i = match link.roster.iter().position(|e| e.canon.same_key(&a)) {
            Some(i) => i,
            None => {
                link.roster.push(Entry::new(a.clone(), seq));
                link.roster.len() - 1
            }
        };
        link.roster[i].added_seq = seq;
        let attested = attested_here(&link.roster[i].canon, &link.rp_id, &link.origin, mds, t);
        link.roster[i].attested = attested;
        if link.roster[i].state == KeyState::Inactive || link.roster[i].state == KeyState::Unattested {
            let mut notes = Vec::new();
            link.accept(i, high, running, &mut notes, "add");
            done.notes.extend(notes);
        }
        done.adds.push(json!({ "hint": hint, "email": a.email, "role": a.role }));
    }
    link.roster_seq = seq;
    link.roster_hash = hash;
    Ok(done)
}

/// A `policy` frame (4.5): after the bootstrap, in order, tightening with one admin assertion, loosening (and any
/// update that loosens anything) with two of different emails.
pub fn policy_update(link: &mut Link, body: &Value) -> Result<u64, Refused> {
    let o = body.as_object().ok_or_else(Refused::op)?;
    let keys = ["seq", "prev", "policy", "endorsements"];
    if !exact_keys(o, &keys, &keys) {
        return Err(Refused::op());
    }
    if !link.bootstrap.done {
        return Err(Refused::of("fleet-bootstrap"));
    }
    let seq = is_int(o.get("seq")).ok_or_else(Refused::op)? as u64;
    let prev = hash_of(o.get("prev")).ok_or_else(Refused::op)?;
    if seq != link.policy_seq + 1 || prev != link.policy_hash {
        return Err(Refused::with("stale", "Nothing was changed: this policy update is out of order."));
    }
    let pv = o.get("policy").ok_or_else(Refused::op)?;
    let policy = Policy::parse(pv).ok_or_else(Refused::op)?;
    let hash = policy_hash(&link.console_id, seq, &prev, &policy.to_value()).ok_or_else(Refused::op)?;
    let loosens = (link.policy.high && !policy.high) || (link.policy.two_person && !policy.two_person);
    let challenge = policy_endorse_challenge(&link.console_id, seq, &hash);
    let emails = endorsing_emails(link, o.get("endorsements"), &challenge)?;
    if emails.len() < if loosens { 2 } else { 1 } {
        return Err(Refused::of("fleet-second"));
    }
    link.policy = policy;
    link.policy_seq = seq;
    link.policy_hash = hash;
    Ok(seq)
}

/// Scopes a frame or a request names: known, `read-health` kept, `read-logs` only with `people`; sorted as SCOPES.
pub fn scope_set(v: Option<&Value>) -> Result<Vec<String>, Refused> {
    let list = strings(v).ok_or_else(Refused::op)?;
    for s in &list {
        if !SCOPES.contains(&s.as_str()) {
            return Err(Refused::unknown_scope(s));
        }
    }
    let mut out: Vec<String> = SCOPES.iter().filter(|s| list.iter().any(|x| x == **s)).map(|s| (*s).to_owned()).collect();
    if !out.iter().any(|s| s == "read-health") {
        out.insert(0, "read-health".into());
    }
    if out.iter().any(|s| s == "read-logs") && !out.iter().any(|s| s == "people") {
        return Err(Refused::of("fleet-scope-needs-people"));
    }
    Ok(out)
}

/// What a `scopes` frame did.
#[derive(Debug, PartialEq, Eq)]
pub struct ScopesDone {
    pub narrowed: bool,
    pub ignored_widening: bool,
    pub requested: bool,
}

/// A `scopes` frame (4.1): the console may only narrow (dropping `people` drops `read-logs`; `read-health` stays);
/// a frame that would widen changes nothing. `request` becomes one pending request the relay generates itself; any
/// narrowing or newer request replaces the old one.
pub fn scopes_frame(link: &mut Link, body: &Value) -> Result<ScopesDone, Refused> {
    let o = body.as_object().ok_or_else(Refused::op)?;
    if !exact_keys(o, &["scopes", "request"], &["scopes"]) {
        return Err(Refused::op());
    }
    let raw = strings(o.get("scopes")).ok_or_else(Refused::op)?;
    if let Some(s) = raw.iter().find(|s| !SCOPES.contains(&s.as_str())) {
        return Err(Refused::unknown_scope(s));
    }
    // `read-health` always stays; narrowing `people` also drops `read-logs`.
    let has = |s: &str| s == "read-health" || raw.iter().any(|x| x == s);
    let want: Vec<String> = SCOPES.iter().filter(|s| has(s) && !(**s == "read-logs" && !has("people"))).map(|s| (*s).to_owned()).collect();
    let mut done = ScopesDone { narrowed: false, ignored_widening: false, requested: false };
    if want.iter().any(|s| !link.has(s)) {
        done.ignored_widening = true;
    } else if want != link.scopes {
        link.scopes = want;
        link.scope_generation += 1;
        link.scope_request = None;
        done.narrowed = true;
    }
    if let Some(r) = o.get("request").filter(|r| !r.is_null()) {
        let ro = r.as_object().ok_or_else(Refused::op)?;
        if !exact_keys(ro, &["scopes"], &["scopes"]) {
            return Err(Refused::op());
        }
        let requested = scope_set(ro.get("scopes"))?;
        if requested.iter().any(|s| !link.has(s)) {
            let id = format!("sr_{}", hex(&crate::console_auth::random(8).ok_or_else(Refused::op)?));
            let hash = scope_request_hash(&link.relay_id, &id, link.scope_generation, &link.scopes, &requested).ok_or_else(Refused::op)?;
            link.scope_request = Some(ScopeRequest { request_id: id, generation: link.scope_generation, old: link.scopes.clone(), requested, hash });
            done.requested = true;
        }
    }
    Ok(done)
}

/// The operator's `accept-scopes {requestId, hash}` (4.1, 4.2): applies only the relay's own current request with that
/// id and hash; Ok(false) when it is already in place; `stale` otherwise.
pub fn accept_scopes(link: &mut Link, request_id: &str, hash: &str) -> Result<bool, Refused> {
    match &link.scope_request {
        Some(r) if r.request_id == request_id && r.hash == hash && r.generation == link.scope_generation && r.old == link.scopes => {
            link.scopes = r.requested.clone();
            link.scope_generation += 1;
            link.scope_request = None;
            Ok(true)
        }
        _ => Err(Refused::of("stale")),
    }
}

// ── F20: device endorsements (3.9) ──────────────────────────────────────────────────────────────────────────

const ENDORSEMENT_KEYS: [&str; 8] = ["v", "credentialId", "cose", "email", "role", "relayId", "consoleCaFingerprint", "at"];

struct Endorsement {
    credential_id: String,
    cose: String,
    email: String,
    role: String,
    relay_id: String,
    ca: String,
}

fn endorsement_fields(v: &Value) -> Option<Endorsement> {
    let o = v.as_object()?;
    if !exact_keys(o, &ENDORSEMENT_KEYS, &ENDORSEMENT_KEYS) || o.get("v").and_then(Value::as_i64) != Some(1) || is_int(o.get("at")).is_none() {
        return None;
    }
    Some(Endorsement {
        credential_id: str_of(o.get("credentialId"))?.to_owned(),
        cose: str_of(o.get("cose"))?.to_owned(),
        email: str_of(o.get("email"))?.to_owned(),
        role: str_of(o.get("role"))?.to_owned(),
        relay_id: str_of(o.get("relayId"))?.to_owned(),
        ca: str_of(o.get("consoleCaFingerprint"))?.to_owned(),
    })
}

/// The facts the main-port route gathered about the endorser (F20). Remote Spokes: the hub certificate's user email
/// and serial, the hub-op signature already checked (`proof` None); Meeting Hub: the device principal and id, the
/// decoded `proof` checked here with `verify` over `endorse_signing_input`.
pub struct EndorseCtx<'a> {
    pub state_dir: &'a Path,
    pub product: Product,
    pub email: &'a str,
    pub anchor: &'a str,
    pub chain_ok: bool,
    pub in_date: bool,
    pub revoked: bool,
    pub blocked: bool,
    pub relay_admin: bool,
    pub verify: &'a dyn Fn(&[u8], &[u8]) -> bool,
    pub proof: Option<&'a [u8]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EndorseRefusal {
    pub status: u16,
    pub code: &'static str,
    pub why: Option<&'static str>,
    pub error: String,
}

impl EndorseRefusal {
    pub fn not_bootstrapping() -> EndorseRefusal {
        let r = Refused::of("fleet-not-bootstrapping");
        EndorseRefusal { status: r.status, code: r.code, why: None, error: r.error }
    }

    pub fn why(why: &'static str) -> EndorseRefusal {
        EndorseRefusal { status: 403, code: "endorse-refused", why: Some(why), error: format!("The relay did not accept this endorsement: {why}.") }
    }
}

/// The 3.9 checks of a device endorsement against the link (the console CA pin the relay trusts given): chain and
/// date, revocation and blocks, the signature, this relay, this console CA, a first-roster entry with that exact key
/// and role, the email, and (Meeting Hub, admin entries) the principal in `admins`. The index of the entry anchored.
pub fn check_endorsement(link: &mut Link, ctx: &EndorseCtx, endorsement: &Value, console_ca: &str) -> Result<usize, EndorseRefusal> {
    if link.bootstrap.done {
        return Err(EndorseRefusal::not_bootstrapping());
    }
    let e = endorsement_fields(endorsement).ok_or(EndorseRefusal::why("unknown-key"))?;
    if !ctx.chain_ok || !ctx.in_date {
        return Err(EndorseRefusal::why("chain"));
    }
    if ctx.revoked || ctx.blocked {
        return Err(EndorseRefusal::why("revoked"));
    }
    if ctx.email.trim().to_lowercase() != e.email {
        return Err(EndorseRefusal::why("email"));
    }
    if ctx.product == Product::Meet && e.role == "admin" && !ctx.relay_admin {
        return Err(EndorseRefusal::why("not-relay-admin"));
    }
    match (ctx.product, ctx.proof) {
        (Product::Meet, None) => return Err(EndorseRefusal::why("signature")),
        (_, Some(proof)) => {
            let input = endorse_signing_input(endorsement).ok_or(EndorseRefusal::why("signature"))?;
            if !(ctx.verify)(&input, proof) {
                return Err(EndorseRefusal::why("signature"));
            }
        }
        (Product::Spokes, None) => {}
    }
    if e.relay_id != link.relay_id {
        return Err(EndorseRefusal::why("relay"));
    }
    if console_ca.is_empty() || e.ca != console_ca {
        return Err(EndorseRefusal::why("console-ca"));
    }
    let (id, cose) = (unb64u(&e.credential_id).unwrap_or_default(), unb64u(&e.cose).unwrap_or_default());
    let i = link
        .roster
        .iter()
        .position(|x| !id.is_empty() && x.canon.id_bytes() == id && x.canon.cose_bytes() == cose && x.canon.role == e.role && x.canon.email == e.email)
        .ok_or(EndorseRefusal::why("unknown-key"))?;
    if link.refused_keys.contains(&link.roster[i].hint) {
        return Err(EndorseRefusal::why("unknown-key"));
    }
    if link.roster[i].anchor.is_none() {
        link.roster[i].anchor = Some(Anchor { via: "device".into(), by: ctx.anchor.to_owned() });
    }
    Ok(i)
}

/// The `fleet-bootstrap` answer for one email (F20).
pub fn bootstrap_answer(link: &Link, email: &str, console_ca: &str) -> Value {
    let email = email.trim().to_lowercase();
    let entries: Vec<Value> = link
        .roster
        .iter()
        .filter(|e| e.canon.email == email)
        .map(|e| json!({ "credentialId": e.canon.credential_id, "cose": e.canon.cose, "email": e.canon.email, "role": e.canon.role, "hint": e.hint, "anchored": e.anchor.is_some() }))
        .collect();
    json!({ "ok": true, "relayId": link.relay_id, "consoleCaFingerprint": console_ca, "consoleOrigin": link.origin, "bootstrap": if link.bootstrap.done { "done" } else { "pending" }, "entries": entries })
}

/// The console CA pin the relay trusts now: the `pin` of the newest `active` generation in `fleet.json` `pins`.
pub fn console_ca_pin(m: &Map<String, Value>) -> String {
    m.get("pins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| str_of(p.get("state")) == Some("active"))
        .max_by_key(|p| p.get("generation").and_then(Value::as_u64).unwrap_or(0))
        .and_then(|p| str_of(p.get("pin")))
        .unwrap_or("")
        .to_owned()
}

/// F20: what a hub or the Hub app reads before endorsing (409 `fleet-not-bootstrapping` without a pending bootstrap).
pub fn bootstrap_view(state_dir: &Path, email: &str, _t: i64) -> Result<Value, EndorseRefusal> {
    crate::fleet_exec::live(state_dir).ok_or_else(EndorseRefusal::not_bootstrapping)?.bootstrap_view(email)
}

/// F20: a device endorsement, checked, the entry anchored, audited `fleet.bootstrap-anchor`, and the bootstrap
/// completed when the 3.9 rule is met.
pub fn endorse(ctx: &EndorseCtx, endorsement: &Value, t: i64) -> Result<Value, EndorseRefusal> {
    crate::fleet_exec::live(ctx.state_dir).ok_or_else(EndorseRefusal::not_bootstrapping)?.endorse(ctx, endorsement, t)
}

/// 5.7: the active admin emails of the roster ("console admins" for `/v1/console/requests` on a relay whose local
/// console is off).
pub fn active_admin_emails(state_dir: &Path) -> Vec<String> {
    crate::fleet_exec::live(state_dir).map(|f| f.active_admin_emails()).unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod tests {
    //! 16.1 f-trust: the bindings of the stepup vector, the bootstrap and projection vectors, assertions, nonces and
    //! counters, the roster and policy chains, holds in running time, the first-roster anchors and endorsements,
    //! scope frames and requests.

    use super::*;
    use crate::codec::{b64u, unb64u};
    use crate::console_mds::{aaguid_text, test_snapshot};
    use crate::console_webauthn::testkit::Authenticator;

    pub const CID: &str = "c_0123456789abcdef";
    pub const RID: &str = "r_00112233445566aa";
    pub const OTHER: &str = "r_ffeeddccbbaa9988";
    pub const RP: &str = "console.example.com";
    pub const ORIGIN: &str = "https://console.example.com";
    pub const T0: i64 = 1_800_000_000_000;
    pub const AAGUID: [u8; 16] = [0x11; 16];
    pub const ALICE: &str = "alice@acme.example";
    pub const BOB: &str = "bob@acme.example";
    pub const CAROL: &str = "carol@acme.example";

    pub fn vector(name: &str) -> Value {
        let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        crate::codec::parse_json(&text).unwrap()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    pub fn snapshot() -> Snapshot {
        test_snapshot(&[(&aaguid_text(&AAGUID), true, false)])
    }

    /// The canonical entry of an authenticator's key, with registration evidence (a `packed` full attestation from
    /// the test root) when `evidence`.
    pub fn entry_of(a: &mut Authenticator, email: &str, role: &str, evidence: bool) -> Value {
        let (ev, digest) = if evidence {
            let reg = a.register_full(RP, ORIGIN, &[9u8; 32], AAGUID, Some(true));
            let att = reg["response"]["attestationObject"].as_str().unwrap().to_owned();
            let cdj = reg["response"]["clientDataJSON"].as_str().unwrap().to_owned();
            let d = evidence_sha256(&unb64u(&att).unwrap(), &unb64u(&cdj).unwrap());
            (json!({ "fmt": "packed", "attestationObject": att, "clientDataJSON": cdj }), Value::from(d))
        } else {
            (Value::Null, Value::Null)
        };
        json!({ "credentialId": b64u(&a.id), "cose": b64u(&a.cose()), "email": email, "role": role, "evidence": ev, "evidenceSha256": digest })
    }

    /// `fleet.json` as apply writes it: the link keys and every first-roster entry inactive.
    pub fn link_map(entries: &[Value], policy: Policy, scopes: &[&str]) -> Map<String, Value> {
        let roster: Vec<Value> = entries
            .iter()
            .map(|e| {
                let mut e = e.clone();
                e["state"] = Value::from("inactive");
                e
            })
            .collect();
        let hash = bootstrap_roster_hash(CID, "en_0011223344556677", &policy.to_value(), entries).unwrap();
        json!({
            "v": 1, "consoleId": CID, "relayId": RID, "origin": ORIGIN, "rpId": RP, "fleetUrl": "https://console.example.com:7443",
            "pins": [{ "generation": 1, "pin": "pin-one", "state": "active" }],
            "scopes": scopes, "policy": policy.to_value(), "policySeq": 1, "policyHash": hex(&[0u8; 32]),
            "bootstrap": { "state": "pending", "bootstrapRosterHash": hash, "via": "code" },
            "roster": roster, "rosterSeq": 0, "rosterHash": hex(&[0u8; 32]),
        })
        .as_object()
        .unwrap()
        .clone()
    }

    pub fn standard() -> Policy {
        Policy { high: false, two_person: false }
    }

    pub const ALL: [&str; 5] = ["read-health", "read-logs", "people", "config", "license"];

    /// A link whose bootstrap completed through device anchors on every admin entry, keys accepted under `high`.
    pub fn bootstrapped(entries: &[Value], policy: Policy, high: bool) -> Link {
        let mut l = Link::from_map(&link_map(entries, policy, &ALL)).unwrap();
        l.attest_all(Some(&snapshot()), T0);
        for (i, e) in l.roster.iter_mut().enumerate() {
            e.anchor = Some(Anchor { via: "device".into(), by: format!("hub {i}") });
        }
        l.try_complete_bootstrap(high, 0).expect("the bootstrap completes");
        l
    }

    /// A mode-one `auth` over this relay's nonce for `action`, `target` and `params`.
    pub fn one(a: &mut Authenticator, nonces: &mut Nonces, action: &str, target: &str, params: &Value, t: i64) -> Value {
        let n = nonces.draw(1, t).unwrap().remove(0);
        let targets = vec![(RID.to_owned(), n.clone()), (OTHER.to_owned(), b64u(&[5u8; 32]))];
        let ch = stepup_challenge(CID, action, target, params, &targets).unwrap();
        json!({ "mode": "one", "credential": a.assert(RP, ORIGIN, &ch, None), "nonce": n, "targets": targets_value(&targets) })
    }

    fn keys3() -> (Authenticator, Authenticator, Authenticator) {
        (Authenticator::new(41), Authenticator::new(42), Authenticator::new(43))
    }

    // ── Vectors ─────────────────────────────────────────────────────────────────────────────────────────────

    fn targets_from(v: &Value) -> Vec<(String, String)> {
        v.as_array().unwrap().iter().map(|t| (t["relay"].as_str().unwrap().to_owned(), t["nonce"].as_str().unwrap().to_owned())).collect()
    }

    #[test]
    fn every_binding_of_the_stepup_vector() {
        let v = vector("admin_console_fleet_stepup_v1.json");
        let cid = v["console_id"].as_str().unwrap();
        let s = &v["stepup"];
        assert_eq!(s["label"], STEPUP_LABEL);
        let b = &s["base"];
        let (action, target, params, targets) = (b["action"].as_str().unwrap(), b["target"].as_str().unwrap(), &b["params"], targets_from(&b["targets"]));
        let base = stepup_challenge(cid, action, target, params, &targets).unwrap();
        assert_eq!(hex(&base), b["challenge_hex"].as_str().unwrap());
        assert_eq!(String::from_utf8(canonical_json(&targets_value(&targets)).unwrap()).unwrap(), b["targets_canonical"].as_str().unwrap());
        // One changed byte per field gives another challenge, exactly the vector's.
        for c in s["changed"].as_array().unwrap() {
            let want = c["challenge_hex"].as_str().unwrap();
            assert_ne!(want, b["challenge_hex"].as_str().unwrap());
            let got = match c["field"].as_str().unwrap() {
                "label" => continue,
                "consoleId" => stepup_challenge(c["value"].as_str().unwrap(), action, target, params, &targets),
                "action" => stepup_challenge(cid, c["value"].as_str().unwrap(), target, params, &targets),
                "target" => stepup_challenge(cid, action, c["value"].as_str().unwrap(), params, &targets),
                "params" => stepup_challenge(cid, action, target, &c["value"], &targets),
                _ => stepup_challenge(cid, action, target, params, &targets_from(&c["value"])),
            };
            assert_eq!(hex(&got.unwrap()), want, "{}", c["field"]);
        }
        // Targets in another order: sorted before hashing.
        assert_eq!(stepup_challenge(cid, action, target, params, &targets_from(&s["reordered"]["targets"])).unwrap(), base);
        let r = &v["request"]["base"];
        let ids: Vec<String> = r["relayIds"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_owned()).collect();
        let (aid, ra, rt, rp, at) = (r["approvalId"].as_str().unwrap(), r["action"].as_str().unwrap(), r["target"].as_str().unwrap(), &r["params"], r["requestedAt"].as_i64().unwrap());
        assert_eq!(hex(&request_challenge(cid, aid, ra, rt, rp, &ids, at).unwrap()), r["challenge_hex"].as_str().unwrap());
        for c in v["request"]["changed"].as_array().unwrap() {
            let val = &c["value"];
            let got = match c["field"].as_str().unwrap() {
                "label" => continue,
                "consoleId" => request_challenge(val.as_str().unwrap(), aid, ra, rt, rp, &ids, at),
                "approvalId" => request_challenge(cid, val.as_str().unwrap(), ra, rt, rp, &ids, at),
                "action" => request_challenge(cid, aid, val.as_str().unwrap(), rt, rp, &ids, at),
                "target" => request_challenge(cid, aid, ra, val.as_str().unwrap(), rp, &ids, at),
                "params" => request_challenge(cid, aid, ra, rt, val, &ids, at),
                "relayIds" => request_challenge(cid, aid, ra, rt, rp, &val.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_owned()).collect::<Vec<_>>(), at),
                _ => request_challenge(cid, aid, ra, rt, rp, &ids, val.as_i64().unwrap()),
            };
            assert_eq!(hex(&got.unwrap()), c["challenge_hex"].as_str().unwrap(), "{}", c["field"]);
        }
        let ap = &v["approval"]["base"];
        let p = &ap["params"];
        let got = approval_challenge(cid, ap["target"].as_str().unwrap(), p["action"].as_str().unwrap(), p["target"].as_str().unwrap(), &p["params"], p["requestedBy"].as_str().unwrap(), p["requestedAt"].as_i64().unwrap(), &targets_from(&ap["targets"]));
        assert_eq!(hex(&got.unwrap()), ap["challenge_hex"].as_str().unwrap());
        for c in v["roster"]["chain"].as_array().unwrap() {
            let prev: [u8; 32] = unhex(c["prev_hex"].as_str().unwrap()).try_into().unwrap();
            let h = roster_hash(cid, c["seq"].as_u64().unwrap(), &prev, &c["change"]).unwrap();
            assert_eq!(hex(&h), c["hash_hex"].as_str().unwrap());
            assert_eq!(hex(&roster_endorse_challenge(cid, c["seq"].as_u64().unwrap(), &h)), c["endorse_challenge_hex"].as_str().unwrap());
        }
        for c in v["policy"]["chain"].as_array().unwrap() {
            let prev: [u8; 32] = unhex(c["prev_hex"].as_str().unwrap()).try_into().unwrap();
            let h = policy_hash(cid, c["seq"].as_u64().unwrap(), &prev, &c["policy"]).unwrap();
            assert_eq!(hex(&h), c["hash_hex"].as_str().unwrap());
            assert_eq!(hex(&policy_endorse_challenge(cid, c["seq"].as_u64().unwrap(), &h)), c["endorse_challenge_hex"].as_str().unwrap());
        }
        for c in v["scopes"]["cases"].as_array().unwrap() {
            let list = |k: &str| c[k].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_owned()).collect::<Vec<_>>();
            let h = scope_request_hash(c["relayId"].as_str().unwrap(), c["requestId"].as_str().unwrap(), c["generation"].as_u64().unwrap(), &list("oldScopes"), &list("requestedScopes")).unwrap();
            assert_eq!(h, c["hash_hex"].as_str().unwrap());
        }
        // The 5.4 table: the relay's own copy equals the vector's, row for row.
        let rows = v["routes"].as_array().unwrap();
        assert_eq!(rows.len(), FLEET_SCOPES.len());
        for r in rows {
            let row = scope_row(r["method"].as_str().unwrap(), r["path"].as_str().unwrap()).unwrap_or_else(|| panic!("{} missing", r["route"]));
            let health = match row.health {
                Health::Viewer => "viewer",
                Health::Whole => "whole",
                Health::Refused => "refused",
                Health::Write => "write",
            };
            assert_eq!(health, r["read_health"].as_str().unwrap(), "{}", r["route"]);
            let scopes: Vec<&str> = r["scopes"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
            assert_eq!(row.scopes.to_vec(), scopes, "{}", r["route"]);
        }
    }

    #[test]
    fn the_bootstrap_vector_hashes_fingerprints_duplicates_and_completion() {
        let v = vector("admin_console_fleet_bootstrap_v1.json");
        let cid = v["console_id"].as_str().unwrap();
        let eid = v["enrollment_id"].as_str().unwrap();
        let entries = v["base"]["entries"].as_array().unwrap().clone();
        for e in &entries {
            canonical_entry(e).expect("a canonical entry");
        }
        assert_eq!(bootstrap_roster_hash(cid, eid, &v["policy"], &entries).unwrap(), v["base"]["bootstrapRosterHash"].as_str().unwrap());
        for c in v["evidence"].as_array().unwrap() {
            let e = entries.iter().find(|e| e["credentialId"] == c["credentialId"]).unwrap();
            let ev = &e["evidence"];
            let d = evidence_sha256(&unb64u(ev["attestationObject"].as_str().unwrap()).unwrap(), &unb64u(ev["clientDataJSON"].as_str().unwrap()).unwrap());
            assert_eq!(d, c["evidenceSha256"].as_str().unwrap());
        }
        for c in v["changed"].as_array().unwrap() {
            let list = c["entries"].as_array().unwrap().clone();
            let got = bootstrap_roster_hash(cid, c["enrollmentId"].as_str().unwrap(), &c["policy"], &list).unwrap();
            assert_eq!(got, c["bootstrapRosterHash"].as_str().unwrap(), "{}", c["name"]);
            assert_ne!(got, v["base"]["bootstrapRosterHash"].as_str().unwrap());
        }
        for c in v["fingerprints"]["cases"].as_array().unwrap() {
            let fp = admin_key_fingerprint(&unb64u(c["credentialId"].as_str().unwrap()).unwrap(), &unb64u(c["cose"].as_str().unwrap()).unwrap(), c["email"].as_str().unwrap(), c["role"].as_str().unwrap());
            assert_eq!(fp, c["fingerprint"].as_str().unwrap(), "{}", c["name"]);
        }
        let e = &v["endorsement"];
        assert_eq!(hex(&endorse_signing_input(&e["base"]["endorsement"]).unwrap()), e["base"]["signing_input_hex"].as_str().unwrap());
        // Every endorsement case through the relay's checks, with the vector's facts.
        let ca = v["console_ca_fingerprint"].as_str().unwrap();
        for c in e["cases"].as_array().unwrap() {
            let mut m = link_map(&entries, standard(), &ALL);
            m.insert("relayId".into(), v["relay_id"].clone());
            let mut link = Link::from_map(&m).unwrap();
            let f = &c["facts"];
            let product = if c["product"] == "meet" { Product::Meet } else { Product::Spokes };
            let sig_ok = f["signature"].as_bool().unwrap();
            let verify = move |_: &[u8], _: &[u8]| sig_ok;
            let proof = [1u8];
            let ctx = EndorseCtx {
                state_dir: Path::new("."),
                product,
                email: f["certEmail"].as_str().unwrap(),
                anchor: "hub 01",
                chain_ok: f["chain"].as_bool().unwrap(),
                in_date: f["inDate"].as_bool().unwrap(),
                revoked: f["revoked"].as_bool().unwrap(),
                blocked: f["blocked"].as_bool().unwrap(),
                relay_admin: f["inAdmins"].as_bool().unwrap(),
                verify: &verify,
                proof: if product == Product::Meet || !sig_ok { Some(&proof[..]) } else { None },
            };
            let r = check_endorsement(&mut link, &ctx, &c["endorsement"], ca);
            assert_eq!(r.as_ref().err().and_then(|x| x.why), c["why"].as_str(), "{}", c["name"]);
            if let Err(x) = r {
                assert_eq!(x.code, "endorse-refused");
                assert_eq!(x.error, format!("The relay did not accept this endorsement: {}.", x.why.unwrap()));
            }
        }
        for c in v["duplicates"]["cases"].as_array().unwrap() {
            assert_eq!(roster_duplicate(c["entries"].as_array().unwrap()), !c["ok"].as_bool().unwrap(), "{}", c["name"]);
        }
        for c in v["completion"]["cases"].as_array().unwrap() {
            let policy = Policy::parse(&c["policy"]).unwrap();
            let mut link = Link::from_map(&link_map(&entries, policy, &ALL)).unwrap();
            for (i, a) in c["anchors"].as_array().unwrap().iter().enumerate() {
                // One entry per anchor: the vector's email and role on a key of its own.
                let mut k = Authenticator::new(200 + i as u8);
                let canon = canonical_entry(&entry_of(&mut k, a["email"].as_str().unwrap(), a["role"].as_str().unwrap(), false)).unwrap();
                let mut e = Entry::new(canon, 0);
                e.anchor = Some(Anchor { via: a["via"].as_str().unwrap().into(), by: a["by"].as_str().unwrap().into() });
                link.roster.push(e);
            }
            assert_eq!(link.try_complete_bootstrap(false, 0).is_some(), c["done"].as_bool().unwrap(), "{}", c["name"]);
        }
    }

    #[test]
    fn the_projection_vector_lists_exactly_the_read_health_rows_and_builds_answers_from_them() {
        let v = vector("admin_console_fleet_projection_v1.json");
        let mut want: Vec<String> = v["routes"].as_array().unwrap().iter().map(|r| r["route"].as_str().unwrap().to_owned()).collect();
        want.sort();
        assert_eq!(projected_routes(), want);
        let mut ours: Vec<String> = FLEET_SCOPES.iter().filter(|r| matches!(r.health, Health::Viewer | Health::Whole)).map(|r| format!("{} {}", r.method, r.path)).collect();
        ours.sort();
        assert_eq!(ours, want, "every viewer or whole row of 5.4 has a field list");
        // An answer with person data around the counts: only the listed fields survive, each of its type.
        let busy = json!({ "ok": true, "hubs": { "total": 3, "online": 2, "silent": 1, "expiring": 0, "expired": 0, "revoked": 0, "blocked": 0, "emails": ["alice@acme.example"] },
            "spokes": { "total": 4, "online": 4, "silent": 0, "busy": 1, "expiring": 0, "expired": 0, "revoked": 0, "blocked": 0 }, "lanes": null, "nodes": [{ "node": "n_1", "label": "alice laptop" }] });
        let got = project("GET", "spokes/counts", &busy).unwrap();
        let text = got.to_string();
        assert!(!text.contains("alice") && !text.contains("nodes") && !text.contains("emails"), "{text}");
        assert_eq!(got["hubs"]["total"], 3);
        assert_eq!(got["lanes"], Value::Null);
        // A string where a count belongs: refused, never passed through.
        let mut bad = busy.clone();
        bad["hubs"]["total"] = Value::from("alice@acme.example");
        assert!(project("GET", "spokes/counts", &bad).is_none());
        // Attention under read-health: the allowlist only, args exactly the kind's.
        let items = vec![
            json!({ "kind": "spokes-silent", "severity": "warn", "args": { "n": 2, "who": "alice@acme.example" }, "go": "#/spokes" }),
            json!({ "kind": "admin-suspended", "severity": "bad", "args": { "email": "bob@acme.example" } }),
            json!({ "kind": "joiner-waiting", "severity": "warn", "args": { "email": "carol@acme.example", "from": "hub" } }),
        ];
        let pushed = attention_for(&items, Projection::Viewer);
        assert_eq!(pushed, vec![json!({ "kind": "spokes-silent", "severity": "warn", "args": { "n": 2 } })]);
        assert_eq!(attention_for(&items, Projection::Full).len(), 3);
        // Routes outside the list have no viewer projection.
        assert!(project("GET", "spokes/nodes", &busy).is_none());
    }

    // ── Scopes and projections ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_scope_comes_from_the_relays_table_never_from_the_frame() {
        let health = vec!["read-health".to_owned()];
        let full: Vec<String> = ALL.iter().map(|s| (*s).to_owned()).collect();
        let r = |m: &str, p: &str| scope_row(m, p).unwrap();
        assert_eq!(read_projection(r("GET", "overview"), &health), Ok(Projection::Viewer));
        assert_eq!(read_projection(r("GET", "overview"), &full), Ok(Projection::Full));
        assert_eq!(read_projection(r("GET", "spokes/counts"), &health), Ok(Projection::Viewer));
        for p in ["spokes/nodes", "spokes/seats", "meet/calls", "search", "requests", "meet/people"] {
            assert_eq!(read_projection(r("GET", p), &health).unwrap_err().code, "fleet-scope", "{p}");
        }
        assert_eq!(read_projection(r("GET", "logs"), &health).unwrap_err(), Refused::scope("read-logs"));
        assert_eq!(read_projection(r("GET", "meet/bridge"), &["read-health".into(), "people".into()]).unwrap_err(), Refused::scope("config"));
        assert!(write_scopes_ok(r("POST", "spokes/block"), &health).is_err());
        assert!(write_scopes_ok(r("POST", "spokes/block"), &full).is_ok());
        assert_eq!(write_scopes_ok(r("POST", "audit/restart"), &["read-health".into(), "read-logs".into()]).unwrap_err(), Refused::scope("people"));
        assert!(scope_row("GET", "admins").is_none(), "routes outside 5.4 are never proxied");
        // read-logs without people is refused in any request.
        assert_eq!(scope_set(Some(&json!(["read-health", "read-logs"]))).unwrap_err().code, "fleet-scope-needs-people");
        assert_eq!(scope_set(Some(&json!(["upgrade"]))).unwrap_err().code, "fleet-scope-unknown");
    }

    #[test]
    fn scopes_only_narrow_from_the_console_and_widening_takes_the_operators_request() {
        let mut a = Authenticator::new(41);
        let mut l = bootstrapped(&[entry_of(&mut a, ALICE, "admin", false)], standard(), false);
        l.scopes = vec!["read-health".into(), "people".into()];
        let g = l.scope_generation;
        // A frame that would widen changes nothing.
        let d = scopes_frame(&mut l, &json!({ "scopes": ["read-health", "people", "config"] })).unwrap();
        assert!(d.ignored_widening && !d.narrowed);
        assert_eq!(l.scopes, vec!["read-health", "people"]);
        // The console asks; the relay makes its own request.
        let d = scopes_frame(&mut l, &json!({ "scopes": ["read-health", "people"], "request": { "scopes": ["read-health", "people", "config"] } })).unwrap();
        assert!(d.requested);
        let req = l.scope_request.clone().unwrap();
        assert!(req.request_id.starts_with("sr_"));
        assert_eq!(req.hash, scope_request_hash(RID, &req.request_id, g, &req.old, &req.requested).unwrap());
        // A wrong hash or an old id is stale and widens nothing.
        assert_eq!(accept_scopes(&mut l, &req.request_id, &"0".repeat(64)).unwrap_err().code, "stale");
        assert_eq!(l.scopes, vec!["read-health", "people"]);
        // The console narrows and asks again: the old acceptance is stale.
        scopes_frame(&mut l, &json!({ "scopes": ["read-health"], "request": { "scopes": ["read-health", "people", "config"] } })).unwrap();
        assert!(l.scope_generation > g);
        assert_eq!(accept_scopes(&mut l, &req.request_id, &req.hash).unwrap_err().code, "stale");
        assert_eq!(l.scopes, vec!["read-health"]);
        let now = l.scope_request.clone().unwrap();
        assert_eq!(accept_scopes(&mut l, &now.request_id, &now.hash), Ok(true));
        assert_eq!(l.scopes, vec!["read-health", "people", "config"]);
        // Replayed after use: stale.
        assert_eq!(accept_scopes(&mut l, &now.request_id, &now.hash).unwrap_err().code, "stale");
        // Narrowing people drops read-logs too.
        l.scopes = ALL.iter().map(|s| (*s).to_owned()).collect();
        scopes_frame(&mut l, &json!({ "scopes": ["read-health", "read-logs", "config", "license"] })).unwrap();
        assert_eq!(l.scopes, vec!["read-health", "config", "license"]);
    }

    // ── Assertions (4.6 to 4.8) ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn an_assertion_binds_action_target_params_relays_console_and_nonce() {
        let mut a = Authenticator::new(41);
        let mut l = bootstrapped(&[entry_of(&mut a, ALICE, "admin", false)], standard(), false);
        let mut n = Nonces::default();
        let p = json!({ "node": "n_1", "hours": 2, "reason": "x" });
        let ok = one(&mut a, &mut n, "spokes.block", "n_1", &p, T0);
        let w = authorize(&mut l, &mut n, &ok, "spokes.block", "n_1", &p, T0).unwrap();
        assert_eq!((w.email.as_str(), w.mode), (ALICE, "one"));
        // Another action, target, params: the challenge differs.
        for (action, target, params) in [("spokes.unblock", "n_1", p.clone()), ("spokes.block", "n_2", p.clone()), ("spokes.block", "n_1", json!({ "node": "n_1", "hours": 3, "reason": "x" }))] {
            let auth = one(&mut a, &mut n, "spokes.block", "n_1", &p, T0);
            assert_eq!(authorize(&mut l, &mut n, &auth, action, target, &params, T0).unwrap_err().code, "fleet-stepup");
        }
        // Another relay set: the targets the relay hashes are the ones in the frame, so a swapped set fails.
        let mut auth = one(&mut a, &mut n, "spokes.block", "n_1", &p, T0);
        auth["targets"].as_array_mut().unwrap()[0]["relay"] = Value::from("r_9999999999999999");
        assert!(authorize(&mut l, &mut n, &auth, "spokes.block", "n_1", &p, T0).is_err());
        // Another console id.
        let nn = n.draw(1, T0).unwrap().remove(0);
        let targets = vec![(RID.to_owned(), nn.clone())];
        let ch = stepup_challenge("c_ffffffffffffffff", "spokes.block", "n_1", &p, &targets).unwrap();
        let auth = json!({ "mode": "one", "credential": a.assert(RP, ORIGIN, &ch, None), "nonce": nn, "targets": targets_value(&targets) });
        assert_eq!(authorize(&mut l, &mut n, &auth, "spokes.block", "n_1", &p, T0).unwrap_err().code, "fleet-stepup");
        // A nonce the relay never drew, a reused one, one after 120 s.
        let mut other = Nonces::default();
        let auth = one(&mut a, &mut other, "spokes.block", "n_1", &p, T0);
        assert_eq!(authorize(&mut l, &mut n, &auth, "spokes.block", "n_1", &p, T0).unwrap_err().code, "fleet-stepup");
        let auth = one(&mut a, &mut n, "spokes.block", "n_1", &p, T0);
        assert!(authorize(&mut l, &mut n, &auth, "spokes.block", "n_1", &p, T0).is_ok());
        assert_eq!(authorize(&mut l, &mut n, &auth, "spokes.block", "n_1", &p, T0).unwrap_err().code, "fleet-stepup");
        let auth = one(&mut a, &mut n, "spokes.block", "n_1", &p, T0);
        assert_eq!(authorize(&mut l, &mut n, &auth, "spokes.block", "n_1", &p, T0 + NONCE_MS + 1).unwrap_err().code, "fleet-stepup");
        // A sign count that went backwards.
        a.count = 1;
        let auth = one(&mut a, &mut n, "spokes.block", "n_1", &p, T0);
        assert_eq!(authorize(&mut l, &mut n, &auth, "spokes.block", "n_1", &p, T0).unwrap_err().code, "fleet-counter");
        // A key the roster does not hold (a TOTP-only person has none at all).
        let mut stranger = Authenticator::new(99);
        let auth = one(&mut stranger, &mut n, "spokes.block", "n_1", &p, T0);
        assert_eq!(authorize(&mut l, &mut n, &auth, "spokes.block", "n_1", &p, T0).unwrap_err().code, "fleet-roster");
    }

    #[test]
    fn nonces_are_single_use_at_most_64_and_120_seconds() {
        let mut n = Nonces::default();
        assert!(n.draw(0, T0).is_none() && n.draw(17, T0).is_none());
        let first = n.draw(16, T0).unwrap();
        for _ in 0..4 {
            n.draw(16, T0).unwrap();
        }
        assert_eq!(n.len(), NONCES_MAX);
        assert!(!n.take(&first[0], T0), "the oldest went when the 65th came");
        let last = n.draw(1, T0).unwrap().remove(0);
        assert!(n.take(&last, T0 + NONCE_MS - 1));
        assert!(!n.take(&last, T0));
    }

    #[allow(clippy::too_many_arguments)]
    fn two_auth(req: &mut Authenticator, app: &mut Authenticator, n: &mut Nonces, approval: &str, requested_by: &str, at: i64, t: i64, p: &Value) -> Value {
        let nn = n.draw(1, t).unwrap().remove(0);
        let targets = vec![(RID.to_owned(), nn.clone())];
        let rc = request_challenge(CID, approval, "spokes.block", "n_1", p, &[RID.to_owned()], at).unwrap();
        let ac = approval_challenge(CID, approval, "spokes.block", "n_1", p, requested_by, at, &targets).unwrap();
        json!({ "mode": "two",
            "request": { "credential": req.assert(RP, ORIGIN, &rc, None), "approvalId": approval, "requestedAt": at, "requestedBy": requested_by },
            "approve": { "credential": app.assert(RP, ORIGIN, &ac, None), "nonce": nn, "targets": targets_value(&targets) } })
    }

    #[test]
    fn two_admin_actions_need_two_emails_a_fresh_request_and_an_unused_approval() {
        let (mut a, mut b, mut a2) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", false), entry_of(&mut b, BOB, "admin", false), entry_of(&mut a2, ALICE, "admin", false)];
        let mut l = bootstrapped(&entries, Policy { high: false, two_person: true }, false);
        let mut n = Nonces::default();
        let p = json!({ "node": "n_1" });
        let ok = two_auth(&mut a, &mut b, &mut n, "ap_1", ALICE, T0 - 1000, T0, &p);
        let w = authorize(&mut l, &mut n, &ok, "spokes.block", "n_1", &p, T0).unwrap();
        assert_eq!(w.approver.as_ref().map(|x| x.1.as_str()), Some(BOB));
        // The same approval id again.
        let again = two_auth(&mut a, &mut b, &mut n, "ap_1", ALICE, T0 - 1000, T0, &p);
        assert_eq!(authorize(&mut l, &mut n, &again, "spokes.block", "n_1", &p, T0).unwrap_err().code, "fleet-stepup");
        // The same email twice (two keys of alice).
        let same = two_auth(&mut a, &mut a2, &mut n, "ap_2", ALICE, T0 - 1000, T0, &p);
        assert_eq!(authorize(&mut l, &mut n, &same, "spokes.block", "n_1", &p, T0).unwrap_err().code, "fleet-stepup");
        // A request older than 14 days, or more than 5 minutes ahead.
        let old = two_auth(&mut a, &mut b, &mut n, "ap_3", ALICE, T0 - REQUEST_MAX_AGE_MS - 1, T0, &p);
        assert!(authorize(&mut l, &mut n, &old, "spokes.block", "n_1", &p, T0).is_err());
        let ahead = two_auth(&mut a, &mut b, &mut n, "ap_4", ALICE, T0 + REQUEST_AHEAD_MS + 1, T0, &p);
        assert!(authorize(&mut l, &mut n, &ahead, "spokes.block", "n_1", &p, T0).is_err());
        // Used approvals are kept 15 days.
        l.sweep(T0 + USED_APPROVAL_MS + 1);
        assert!(l.used_approvals.is_empty());
    }

    // ── The roster (4.4) and the policy (4.5) ───────────────────────────────────────────────────────────────

    fn roster_frame(l: &Link, adds: &[Value], removes: &[&str], signers: &mut [&mut Authenticator], seq: u64, prev: [u8; 32]) -> Value {
        let change = json!({ "adds": adds.iter().map(without_evidence).collect::<Vec<_>>(), "removes": removes });
        let h = roster_hash(&l.console_id, seq, &prev, &change).unwrap();
        let ch = roster_endorse_challenge(&l.console_id, seq, &h);
        let endorsements: Vec<Value> = signers.iter_mut().map(|s| s.assert(RP, ORIGIN, &ch, None)).collect();
        json!({ "seq": seq, "prev": hex(&prev), "change": { "adds": adds, "removes": removes }, "endorsements": endorsements })
    }

    #[test]
    fn roster_adds_need_endorsements_in_order_and_chained() {
        let (mut a, mut b, mut d) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", false), entry_of(&mut b, BOB, "admin", false)];
        let mut l = bootstrapped(&entries, standard(), false);
        let snap = snapshot();
        let dave = entry_of(&mut d, "dave@acme.example", "admin", false);
        // No endorsement.
        let f = roster_frame(&l, std::slice::from_ref(&dave), &[], &mut [], 1, [0; 32]);
        assert_eq!(roster_update(&mut l, &f, false, Some(&snap), 0, T0).unwrap_err().code, "fleet-second");
        // Out of sequence, and a wrong previous hash.
        let f = roster_frame(&l, std::slice::from_ref(&dave), &[], &mut [&mut a], 2, [0; 32]);
        assert_eq!(roster_update(&mut l, &f, false, Some(&snap), 0, T0).unwrap_err().code, "stale");
        let f = roster_frame(&l, std::slice::from_ref(&dave), &[], &mut [&mut a], 1, [7; 32]);
        assert_eq!(roster_update(&mut l, &f, false, Some(&snap), 0, T0).unwrap_err().code, "stale");
        // A console statement about the key is refused whole.
        for k in ["attested", "state", "heldUntil"] {
            let mut bad = dave.clone();
            bad[k] = json!(true);
            let f = roster_frame(&l, &[bad], &[], &mut [&mut a], 1, [0; 32]);
            assert_eq!(roster_update(&mut l, &f, false, Some(&snap), 0, T0).unwrap_err().code, "fleet-op", "{k}");
        }
        // One endorsement under Standard with two-person off: the key is active at once.
        let f = roster_frame(&l, std::slice::from_ref(&dave), &[], &mut [&mut a], 1, [0; 32]);
        let done = roster_update(&mut l, &f, false, Some(&snap), 0, T0).unwrap();
        assert_eq!(done.seq, 1);
        let dh = canonical_entry(&dave).unwrap().hint();
        assert_eq!(l.entry(&dh).unwrap().state, KeyState::Active);
        // An endorsement by a removed key.
        let prev = l.roster_hash;
        let ah = canonical_entry(&entries[0]).unwrap().hint();
        let f = roster_frame(&l, &[], &[&ah], &mut [], 2, prev);
        roster_update(&mut l, &f, false, Some(&snap), 0, T0).unwrap();
        let mut e = Authenticator::new(77);
        let eve = entry_of(&mut e, "eve@acme.example", "admin", false);
        let f = roster_frame(&l, &[eve], &[], &mut [&mut a], 3, l.roster_hash);
        assert_eq!(roster_update(&mut l, &f, false, Some(&snap), 0, T0).unwrap_err().code, "fleet-roster");
    }

    #[test]
    fn two_person_on_needs_two_endorsing_emails_and_duplicates_are_refused_whole() {
        let (mut a, mut b, mut d) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", false), entry_of(&mut b, BOB, "admin", false)];
        let mut l = bootstrapped(&entries, Policy { high: false, two_person: true }, false);
        let dave = entry_of(&mut d, "dave@acme.example", "admin", false);
        let f = roster_frame(&l, std::slice::from_ref(&dave), &[], &mut [&mut a], 1, [0; 32]);
        assert_eq!(roster_update(&mut l, &f, false, None, 0, T0).unwrap_err().code, "fleet-second");
        // A later add repeating a key already in the roster under another email.
        let mut dup = dave.clone();
        dup["cose"] = entries[0]["cose"].clone();
        let f = roster_frame(&l, &[dup], &[], &mut [&mut a, &mut b], 1, [0; 32]);
        assert_eq!(roster_update(&mut l, &f, false, None, 0, T0).unwrap_err().code, "fleet-roster-duplicate");
        let f = roster_frame(&l, &[dave], &[], &mut [&mut a, &mut b], 1, [0; 32]);
        assert!(roster_update(&mut l, &f, false, None, 0, T0).is_ok());
        // A first roster with two entries on one key.
        let mut twice = entries[1].clone();
        twice["email"] = Value::from(CAROL);
        assert!(roster_duplicate(&[entries[0].clone(), entries[1].clone(), twice]));
    }

    #[test]
    fn policy_loosening_takes_two_admins_of_different_emails() {
        let (mut a, mut b, mut a2) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", false), entry_of(&mut b, BOB, "admin", false), entry_of(&mut a2, ALICE, "admin", false)];
        let mut l = bootstrapped(&entries, Policy { high: true, two_person: true }, false);
        let frame = |l: &Link, policy: Value, signers: &mut [&mut Authenticator]| {
            let seq = l.policy_seq + 1;
            let h = policy_hash(CID, seq, &l.policy_hash, &policy).unwrap();
            let ch = policy_endorse_challenge(CID, seq, &h);
            json!({ "seq": seq, "prev": hex(&l.policy_hash), "policy": policy, "endorsements": signers.iter_mut().map(|s| s.assert(RP, ORIGIN, &ch, None)).collect::<Vec<_>>() })
        };
        let loose = json!({ "profile": "standard", "twoPerson": "on" });
        let f = frame(&l, loose.clone(), &mut [&mut a]);
        assert_eq!(policy_update(&mut l, &f).unwrap_err().code, "fleet-second");
        let f = frame(&l, loose.clone(), &mut [&mut a, &mut a2]);
        assert_eq!(policy_update(&mut l, &f).unwrap_err().code, "fleet-second");
        let f = frame(&l, loose, &mut [&mut a, &mut b]);
        assert_eq!(policy_update(&mut l, &f), Ok(2));
        // Tightening takes one.
        let f = frame(&l, json!({ "profile": "high", "twoPerson": "on" }), &mut [&mut b]);
        assert_eq!(policy_update(&mut l, &f), Ok(3));
        assert!(l.policy.high);
    }

    // ── Holds in running time (A1-H3) ───────────────────────────────────────────────────────────────────────

    #[test]
    fn a_high_relay_holds_every_key_24_hours_of_its_own_running_time() {
        let (mut a, mut b, mut d) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", true), entry_of(&mut b, BOB, "admin", true)];
        // The console's policy says Standard; the relay's own profile is High.
        let mut l = bootstrapped(&entries, standard(), true);
        assert!(l.roster.iter().all(|e| e.attested && e.state == KeyState::Held), "{:?}", l.roster.iter().map(|e| e.state).collect::<Vec<_>>());
        let mut n = Nonces::default();
        let p = json!({});
        let auth = one(&mut a, &mut n, "x", "-", &p, T0);
        assert_eq!(authorize(&mut l, &mut n, &auth, "x", "-", &p, T0).unwrap_err().code, "fleet-roster");
        // A restart mid-hold resumes from the persisted count; the wall clock plays no part.
        l.running_ms = HOLD_MS / 2;
        let mut m = link_map(&entries, standard(), &ALL);
        l.write_into(&mut m);
        let mut back = Link::from_map(&m).unwrap();
        assert_eq!(back.running_ms, HOLD_MS / 2);
        assert!(back.settle(true, HOLD_MS - 1).is_empty(), "a clock moved forward does not end it");
        assert!(back.roster.iter().all(|e| e.state == KeyState::Held));
        let notes = back.settle(true, HOLD_MS);
        assert_eq!(notes.len(), 2);
        assert!(back.roster.iter().all(|e| e.state == KeyState::Active && e.hold_completed));
        // An endorsed add on a High relay is held too, and a removal cancels its hold.
        let dave = entry_of(&mut d, "dave@acme.example", "admin", true);
        let f = roster_frame(&back, std::slice::from_ref(&dave), &[], &mut [&mut a], 1, [0; 32]);
        let done = roster_update(&mut back, &f, true, Some(&snapshot()), HOLD_MS, T0).unwrap();
        assert!(done.notes.iter().any(|x| matches!(x, Note::Held { why: "add", .. })));
        let dh = canonical_entry(&dave).unwrap().hint();
        assert_eq!(back.entry(&dh).unwrap().state, KeyState::Held);
        let f = roster_frame(&back, &[], &[&dh], &mut [], 2, back.roster_hash);
        roster_update(&mut back, &f, true, None, HOLD_MS, T0).unwrap();
        assert!(back.entry(&dh).is_none());
    }

    #[test]
    fn refuse_key_and_roster_cancel_end_a_hold_and_the_console_cannot_bring_it_back() {
        let (mut a, mut b, mut d) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", true), entry_of(&mut b, BOB, "admin", true)];
        let mut l = bootstrapped(&entries, standard(), true);
        l.settle(true, HOLD_MS);
        let dave = entry_of(&mut d, "dave@acme.example", "admin", true);
        let f = roster_frame(&l, std::slice::from_ref(&dave), &[], &mut [&mut a], 1, [0; 32]);
        roster_update(&mut l, &f, true, Some(&snapshot()), HOLD_MS, T0).unwrap();
        let dh = canonical_entry(&dave).unwrap().hint();
        assert!(l.refuse_key(&dh));
        assert!(!l.refuse_key(&dh), "a second run changes nothing");
        assert!(l.entry(&dh).is_none() && l.refused_keys.contains(&dh));
        // The console adds the same key again: ignored.
        let f = roster_frame(&l, std::slice::from_ref(&dave), &[], &mut [&mut a], 2, l.roster_hash);
        let done = roster_update(&mut l, &f, true, Some(&snapshot()), HOLD_MS * 3, T0).unwrap();
        assert_eq!(done.ignored, vec![dh.clone()]);
        assert!(l.entry(&dh).is_none());
        l.settle(true, HOLD_MS * 5);
        assert!(l.entry(&dh).is_none());
        // A roster admin's cancel ends only a held key.
        let mut e = Authenticator::new(88);
        let eve = entry_of(&mut e, "eve@acme.example", "admin", true);
        let f = roster_frame(&l, std::slice::from_ref(&eve), &[], &mut [&mut a], 3, l.roster_hash);
        roster_update(&mut l, &f, true, Some(&snapshot()), HOLD_MS * 5, T0).unwrap();
        let eh = canonical_entry(&eve).unwrap().hint();
        assert!(l.cancel_held(&eh));
        assert!(!l.cancel_held(&canonical_entry(&entries[0]).unwrap().hint()), "an active key is not cancelled this way");
    }

    #[test]
    fn a_move_to_high_re_holds_keys_that_never_completed_a_hold() {
        let (mut a, mut b, _) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", true), entry_of(&mut b, BOB, "admin", false)];
        let mut l = bootstrapped(&entries, standard(), false);
        assert!(l.roster.iter().all(|e| e.state == KeyState::Active && !e.hold_completed));
        let notes = l.settle(true, 1000);
        assert!(notes.contains(&Note::Held { hint: l.roster[0].hint.clone(), why: "profile-high" }));
        assert_eq!(l.roster[0].state, KeyState::Held);
        assert_eq!(l.roster[1].state, KeyState::Unattested, "under High an unattested key never becomes active");
        l.settle(true, 1000 + HOLD_MS);
        assert_eq!(l.roster[0].state, KeyState::Active);
        assert_eq!(l.roster[1].state, KeyState::Unattested);
    }

    // ── Evidence (3.9, 4.4) ─────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_relay_judges_attestation_itself() {
        let snap = snapshot();
        let mut a = Authenticator::new(41);
        let good = canonical_entry(&entry_of(&mut a, ALICE, "admin", true)).unwrap();
        assert!(attested_here(&good, RP, ORIGIN, Some(&snap), T0));
        assert!(!attested_here(&good, RP, ORIGIN, None, T0), "no snapshot of its own, no verdict");
        assert!(!attested_here(&good, "other.example.com", "https://other.example.com", Some(&snap), T0), "another rpId");
        // Evidence naming another credential.
        let mut b = Authenticator::new(42);
        let other = entry_of(&mut b, ALICE, "admin", true);
        let mut swapped = good.clone();
        swapped.evidence = other["evidence"].clone();
        swapped.evidence_sha256 = other["evidenceSha256"].clone();
        assert!(!attested_here(&swapped, RP, ORIGIN, Some(&snap), T0));
        // A broken statement.
        let mut broken = good.clone();
        let mut att = unb64u(good.evidence["attestationObject"].as_str().unwrap()).unwrap();
        let last = att.len() - 1;
        att[last] ^= 1;
        let cdj = unb64u(good.evidence["clientDataJSON"].as_str().unwrap()).unwrap();
        broken.evidence["attestationObject"] = Value::from(b64u(&att));
        broken.evidence_sha256 = Value::from(evidence_sha256(&att, &cdj));
        assert!(!attested_here(&broken, RP, ORIGIN, Some(&snap), T0));
        // A model without FIPS hardware in the relay's snapshot.
        let weak = test_snapshot(&[(&aaguid_text(&AAGUID), false, false)]);
        assert!(!attested_here(&good, RP, ORIGIN, Some(&weak), T0));
        // A digest that does not match its evidence is not a canonical entry at all.
        let mut v = good.to_value();
        v["evidenceSha256"] = Value::from("0".repeat(64));
        assert_eq!(canonical_entry(&v).unwrap_err().code, "fleet-op");
    }

    // ── The first roster (3.9) ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_first_roster_without_anchors_never_activates() {
        let mut a = Authenticator::new(41);
        let mut l = Link::from_map(&link_map(&[entry_of(&mut a, ALICE, "admin", false)], standard(), &ALL)).unwrap();
        assert!(l.try_complete_bootstrap(false, HOLD_MS * 10).is_none());
        l.settle(false, HOLD_MS * 10);
        assert!(!l.bootstrap.done && l.roster[0].state == KeyState::Inactive);
        // No roster or policy update while pending.
        assert_eq!(roster_update(&mut l, &json!({ "seq": 1, "prev": hex(&[0; 32]), "change": { "adds": [], "removes": [] }, "endorsements": [] }), false, None, 0, T0).unwrap_err().code, "fleet-bootstrap");
    }

    #[test]
    fn ceremony_b_activates_only_listed_fingerprints() {
        let (mut a, mut b, _) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", false), entry_of(&mut b, BOB, "admin", false)];
        let mut m = link_map(&entries, standard(), &ALL);
        let alice = canonical_entry(&entries[0]).unwrap();
        // A fingerprint of alice's key as user manager matches nothing.
        let wrong_role = admin_key_fingerprint(&alice.id_bytes(), &alice.cose_bytes(), ALICE, "user-manager");
        m["bootstrap"]["adminKeys"] = json!([wrong_role]);
        let mut l = Link::from_map(&m).unwrap();
        assert!(l.apply_admin_keys().is_empty());
        assert!(l.try_complete_bootstrap(false, 0).is_none());
        m["bootstrap"]["adminKeys"] = json!([alice.fingerprint()]);
        let mut l = Link::from_map(&m).unwrap();
        assert_eq!(l.apply_admin_keys().len(), 1);
        assert!(l.bootstrap.admin_keys.is_empty());
        let (activated, _, _) = l.try_complete_bootstrap(false, 0).unwrap();
        assert_eq!(activated, vec![alice.hint()]);
        assert_eq!(l.roster[1].state, KeyState::Inactive, "bob was not listed");
        // Each field changes the fingerprint.
        let fp = alice.fingerprint();
        assert_ne!(fp, admin_key_fingerprint(&alice.id_bytes(), &alice.cose_bytes(), "x@acme.example", "admin"));
        assert_ne!(fp, admin_key_fingerprint(&[1], &alice.cose_bytes(), ALICE, "admin"));
        assert_ne!(fp, admin_key_fingerprint(&alice.id_bytes(), &[1], ALICE, "admin"));
    }

    fn ctx<'a>(product: Product, email: &'a str, anchor: &'a str, verify: &'a dyn Fn(&[u8], &[u8]) -> bool, proof: Option<&'a [u8]>) -> EndorseCtx<'a> {
        EndorseCtx { state_dir: Path::new("."), product, email, anchor, chain_ok: true, in_date: true, revoked: false, blocked: false, relay_admin: true, verify, proof }
    }

    fn endorsement(e: &Value, relay: &str, ca: &str) -> Value {
        json!({ "v": 1, "credentialId": e["credentialId"], "cose": e["cose"], "email": e["email"], "role": e["role"], "relayId": relay, "consoleCaFingerprint": ca, "at": T0 })
    }

    #[test]
    fn device_endorsements_check_every_fact_and_bind_this_relay_and_console_ca() {
        let (mut a, mut b, _) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", false), entry_of(&mut b, BOB, "admin", false)];
        let fresh = || Link::from_map(&link_map(&entries, standard(), &ALL)).unwrap();
        let yes = |_: &[u8], _: &[u8]| true;
        let no = |_: &[u8], _: &[u8]| false;
        let proof = [1u8, 2];
        let good = endorsement(&entries[0], RID, "pin-one");
        let refused = |l: &mut Link, c: &EndorseCtx, e: &Value| check_endorsement(l, c, e, "pin-one").unwrap_err().why.unwrap();
        // Each condition failing alone.
        let mut c = ctx(Product::Spokes, ALICE, "hub 1", &yes, None);
        c.chain_ok = false;
        assert_eq!(refused(&mut fresh(), &c, &good), "chain");
        let mut c = ctx(Product::Meet, ALICE, "dev 1", &yes, Some(&proof[..]));
        c.in_date = false;
        assert_eq!(refused(&mut fresh(), &c, &good), "chain");
        let mut c = ctx(Product::Spokes, ALICE, "hub 1", &yes, None);
        c.revoked = true;
        assert_eq!(refused(&mut fresh(), &c, &good), "revoked");
        let mut c = ctx(Product::Spokes, ALICE, "hub 1", &yes, None);
        c.blocked = true;
        assert_eq!(refused(&mut fresh(), &c, &good), "revoked");
        assert_eq!(refused(&mut fresh(), &ctx(Product::Spokes, BOB, "hub 1", &yes, None), &good), "email");
        let mut c = ctx(Product::Meet, ALICE, "dev 1", &yes, Some(&proof[..]));
        c.relay_admin = false;
        assert_eq!(refused(&mut fresh(), &c, &good), "not-relay-admin");
        assert_eq!(refused(&mut fresh(), &ctx(Product::Meet, ALICE, "dev 1", &no, Some(&proof[..])), &good), "signature");
        assert_eq!(refused(&mut fresh(), &ctx(Product::Meet, ALICE, "dev 1", &yes, None), &good), "signature");
        let c = ctx(Product::Spokes, ALICE, "hub 1", &yes, None);
        assert_eq!(refused(&mut fresh(), &c, &endorsement(&entries[0], OTHER, "pin-one")), "relay");
        assert_eq!(refused(&mut fresh(), &c, &endorsement(&entries[0], RID, "pin-two")), "console-ca");
        let mut other_role = good.clone();
        other_role["role"] = Value::from("user-manager");
        assert_eq!(refused(&mut fresh(), &c, &other_role), "unknown-key");
        let mut other_key = good.clone();
        other_key["cose"] = entries[1]["cose"].clone();
        assert_eq!(refused(&mut fresh(), &c, &other_key), "unknown-key");
        let mut other_id = good.clone();
        other_id["credentialId"] = entries[1]["credentialId"].clone();
        assert_eq!(refused(&mut fresh(), &c, &other_id), "unknown-key");
        // All good: anchored with the hub serial, the bootstrap completes.
        let mut l = fresh();
        let i = check_endorsement(&mut l, &c, &good, "pin-one").unwrap();
        assert_eq!(l.roster[i].anchor, Some(Anchor { via: "device".into(), by: "hub 1".into() }));
        assert!(l.try_complete_bootstrap(false, 0).is_some());
        assert_eq!(l.roster[i].state, KeyState::Active);
        // A hub revoked after endorsing: the active key stays, nothing more is endorsed.
        let mut c2 = ctx(Product::Spokes, BOB, "hub 1", &yes, None);
        c2.revoked = true;
        assert_eq!(check_endorsement(&mut l, &c2, &endorsement(&entries[1], RID, "pin-one"), "pin-one").unwrap_err().code, "fleet-not-bootstrapping");
        assert_eq!(l.roster[i].state, KeyState::Active);
    }

    #[test]
    fn high_with_two_person_on_needs_two_independent_admin_anchors() {
        let (mut a, mut b, mut a2) = keys3();
        let entries = [entry_of(&mut a, ALICE, "admin", true), entry_of(&mut b, BOB, "admin", true), entry_of(&mut a2, ALICE, "admin", true)];
        let policy = Policy { high: true, two_person: true };
        let yes = |_: &[u8], _: &[u8]| true;
        let mut l = Link::from_map(&link_map(&entries, policy, &ALL)).unwrap();
        l.attest_all(Some(&snapshot()), T0);
        check_endorsement(&mut l, &ctx(Product::Spokes, ALICE, "hub 1", &yes, None), &endorsement(&entries[0], RID, "pin-one"), "pin-one").unwrap();
        assert!(l.try_complete_bootstrap(true, 0).is_none(), "one anchored admin");
        check_endorsement(&mut l, &ctx(Product::Spokes, ALICE, "hub 2", &yes, None), &endorsement(&entries[2], RID, "pin-one"), "pin-one").unwrap();
        assert!(l.try_complete_bootstrap(true, 0).is_none(), "two keys of one admin");
        check_endorsement(&mut l, &ctx(Product::Spokes, BOB, "hub 1", &yes, None), &endorsement(&entries[1], RID, "pin-one"), "pin-one").unwrap();
        assert!(l.try_complete_bootstrap(true, 0).is_some(), "alice by hub 2 and bob by hub 1 are independent");
        // Under the local High profile the keys are held, not active.
        assert!(l.roster.iter().all(|e| e.state == KeyState::Held));
    }

    #[test]
    fn nothing_the_console_displays_reaches_the_bootstrap_decision() {
        // The only console input to the bootstrap is the canonical entries; extra keys are refused, and the
        // decision reads only anchors the relay recorded.
        let mut a = Authenticator::new(41);
        let mut e = entry_of(&mut a, ALICE, "admin", false);
        e["displayed"] = Value::from("verified");
        let mut m = link_map(&[entry_of(&mut a, ALICE, "admin", false)], standard(), &ALL);
        m["roster"][0]["displayed"] = Value::from("verified");
        assert!(canonical_entry(&e).is_err());
        let mut l = Link::from_map(&m).unwrap();
        assert!(l.try_complete_bootstrap(false, 0).is_none());
    }
}
