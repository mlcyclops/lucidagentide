// Contract API-1 (docs/api/contract.md) 12 (owner ruling D12: in a catastrophe the relay still delivers its data):
// a relay's failover credentials and its failover exporter.
//
// Credentials (12.3, `api-failover`): for a certificate type the relay draws the key with AWS-LC (EC P-256 for
// `mtls` and `aws_roles_anywhere`, RSA 3072 for `entra_certificate`, as Microsoft app certificate credentials take
// RSA) and answers a PKCS#10 request; the key never leaves the relay. `install` takes the certificate the admin
// registered with the tool (refused unless it is for the waiting key) or, for the secret kinds, a vendor token
// (`token`) or a Google service account key (`gcp_service_account_key`, `key_json`) entered for this relay only, and
// answers the installed credential's public metadata `{type, public_id, not_before, expires}` (the console stores it
// as given). Secrets are sealed in the relay's vault as `api-failover-<org>-<destination>-<gen>` (the key's PKCS#8
// with its certificate and chain, the token, or the key JSON); the owner-only record
// `api-failover/<org>/<destination>.json` (flushed before Ok) holds only the kind, the public id (SHA-256 hex of the
// certificate's SubjectPublicKeyInfo, `sha256:` and 8 hex of the token's hash, or `<client_email>:<private_key_id>`),
// `not_before` (the certificate's notBefore, or the install time for a secret kind), `expires`, the credential's
// non-secret fields and the generations being retired. An installed certificate is sealed under a new generation;
// every generation it replaces (the previous credential, the waiting key) stays listed as retiring until its sealed
// copy is removed, which is tried again on later installs and once a minute; a record that cannot be saved after a
// new generation was sealed removes that generation again. A credential is used only between `not_before` and
// `expires` (3.1: an outage never extends access); `expires` is at most 90 days and never past the certificate's
// `notAfter`. No secret enters a log line, an audit entry or an error.
//
// The exporter (12.1, 12.2) is the console's engine (`api_export`) over the relay: destinations are the pinned,
// not set aside maps' entries with `failover: true` and no active `destination_disable_failover`, journal tightenings
// applied at once; each runs only while its org is in failover and only until the earlier of the map's `expires` and
// its installed credential's `expires` (a destination without one stays suspended). Sources are the relay's own org
// chains, its own metrics (`api_listener::own_exposition`), catalog log events naming an org and its listener's
// spans; queues live in `failover-exports/<org>/<destination>/` with the 11.6 limits.
//
// Modes (12.2): `normal` while the fleet channel is up. Once it has been down for an org's `failover_after_s` (default
// 300 s) the org enters failover, and only once `relay.failover.on` is durably in the org's chain (a failed append
// leaves the org in `normal` and the next pass tries again): the destinations' audit cursors move to just before that
// entry and direct delivery starts. When the channel is up and the console's reconnect sync is done
// (`fleet_agent::api_caught_up`), delivery stops first (after any send in flight) and the org is leaving: no direct
// delivery, still reported `failover`, until `relay.failover.off` is durably recorded (tried again on every pass);
// then the mode is `normal`. A channel lost again for `failover_after_s` before that resumes the failover without a
// new `relay.failover.on`. What is still queued stays for the next failover (event ids dedupe) and the console
// backfills from the chains. `destination_delete`, `destination_disable_failover` and the `api-failover` `delete`
// go through `retire` before the relay answers.

use crate::api_audit::{org_ok, ApiAudit, PseudonymKeys, Repr};
use crate::api_export::{self as export, ExportEngine, Gate, Host, MetricRow, OrgConfig};
use crate::api_export_wire::{Credential, Sink, SinkError};
use crate::api_map::{Edition, TightenEntry};
use crate::codec::{hex, now_ms, parse_json, sha256, stringify};
use crate::fleet_ca::{vault_do, VaultLock};
use crate::fleet_x509::{self as x509, Curve, Key, RsaKey};
use crate::log::{Fields, Level, Logger};
use crate::meet_json::{b64, b64_strict};
use crate::meet_x509::Cert;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

/// The records' folder under the state folder.
pub const FAILOVER_DIR: &str = "api-failover";
/// The failover queues' folder under the state folder (`<org>/<destination>/`).
pub const QUEUES_DIR: &str = "failover-exports";
/// 2.2 `failover_after_s` when the map does not say, and its range.
pub const AFTER_DEFAULT_S: i64 = 300;
pub const AFTER_MIN_S: i64 = 60;
pub const AFTER_MAX_S: i64 = 3600;
/// 12.3: a failover credential lasts at most 90 days.
pub const EXPIRES_MAX_S: i64 = 90 * 86_400;
/// Clock skew allowed on `not_before` and on the 90-day limit.
const SKEW_S: i64 = 300;
const STEP: Duration = Duration::from_secs(1);
/// The exporter reads the maps again at least this often (and at once on `changed`).
const REFRESH_S: i64 = 60;
const PEM_MAX: usize = 16 * 1024;
const CHAIN_MAX: usize = 32 * 1024;
const FIELD_MAX: usize = 256;
const TOKEN_MAX: usize = 4096;
/// A Google service account key: the whole JSON text, its `private_key` and its `token_uri`.
const KEY_JSON_MAX: usize = 16 * 1024;
const PRIVATE_KEY_MAX: usize = 8 * 1024;
const URI_MAX: usize = 512;
const SCAN: usize = 64;
const ON: &str = "relay.failover.on";
const OFF: &str = "relay.failover.off";
/// Every material key `install` takes.
const MATERIAL_KEYS: [&str; 14] = ["type", "cert_pem", "chain_pem", "token", "key_json", "expires", "tenant", "client_id", "cloud", "trust_anchor_arn", "profile_arn", "role_arn", "region", "ca_pem"];
/// The non-secret credential fields of every kind.
const PUBLIC_FIELDS: [&str; 8] = ["tenant", "client_id", "cloud", "trust_anchor_arn", "profile_arn", "role_arn", "region", "ca_pem"];

// ── kinds ───────────────────────────────────────────────────────────────────────────────────────────────────────

/// A failover credential's kind, from the destination's `credential.type` (11.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailoverKind {
    Mtls,
    EntraCertificate,
    AwsRolesAnywhere,
    Token,
    GcpServiceAccountKey,
}

impl FailoverKind {
    pub fn of(credential_type: &str) -> Option<FailoverKind> {
        match credential_type {
            "mtls" => Some(FailoverKind::Mtls),
            "entra_certificate" => Some(FailoverKind::EntraCertificate),
            "aws_roles_anywhere" => Some(FailoverKind::AwsRolesAnywhere),
            "token" => Some(FailoverKind::Token),
            "gcp_service_account_key" => Some(FailoverKind::GcpServiceAccountKey),
            _ => None,
        }
    }

    pub fn type_name(self) -> &'static str {
        match self {
            FailoverKind::Mtls => "mtls",
            FailoverKind::EntraCertificate => "entra_certificate",
            FailoverKind::AwsRolesAnywhere => "aws_roles_anywhere",
            FailoverKind::Token => "token",
            FailoverKind::GcpServiceAccountKey => "gcp_service_account_key",
        }
    }

    /// A certificate kind: the relay draws the key and answers a request (`csr`); the secret kinds (`token`,
    /// `gcp_service_account_key`) are installed as entered.
    pub fn uses_csr(self) -> bool {
        matches!(self, FailoverKind::Mtls | FailoverKind::EntraCertificate | FailoverKind::AwsRolesAnywhere)
    }

    /// Its non-secret fields, each with whether it is required.
    fn fields(self) -> &'static [(&'static str, bool)] {
        match self {
            FailoverKind::Mtls => &[("ca_pem", false)],
            FailoverKind::EntraCertificate => &[("tenant", true), ("client_id", true), ("cloud", false)],
            FailoverKind::AwsRolesAnywhere => &[("trust_anchor_arn", true), ("profile_arn", true), ("role_arn", true), ("region", true)],
            FailoverKind::Token | FailoverKind::GcpServiceAccountKey => &[],
        }
    }
}

/// A key drawn for a certificate kind.
enum AnyKey {
    Ec(Key),
    Rsa(RsaKey),
}

impl AnyKey {
    fn generate(kind: FailoverKind) -> Result<AnyKey, String> {
        Ok(match kind {
            FailoverKind::EntraCertificate => AnyKey::Rsa(RsaKey::generate_3072()?),
            _ => AnyKey::Ec(Key::generate(Curve::P256)?),
        })
    }

    fn from_pkcs8(kind: FailoverKind, pkcs8: &[u8]) -> Option<AnyKey> {
        match kind {
            FailoverKind::EntraCertificate => RsaKey::from_pkcs8(pkcs8).ok().map(AnyKey::Rsa),
            FailoverKind::Mtls | FailoverKind::AwsRolesAnywhere => Key::from_pkcs8(Curve::P256, pkcs8).ok().map(AnyKey::Ec),
            FailoverKind::Token | FailoverKind::GcpServiceAccountKey => None,
        }
    }

    fn pkcs8(&self) -> &[u8] {
        match self {
            AnyKey::Ec(k) => k.pkcs8(),
            AnyKey::Rsa(k) => k.pkcs8(),
        }
    }

    fn spki(&self) -> Vec<u8> {
        match self {
            AnyKey::Ec(k) => k.spki(),
            AnyKey::Rsa(k) => k.spki(),
        }
    }

    fn csr(&self, cn: &str) -> Result<Vec<u8>, String> {
        match self {
            AnyKey::Ec(k) => x509::csr(k, cn, &[], &[], &[]),
            AnyKey::Rsa(k) => x509::csr_rsa(k, cn, &[], &[], &[]),
        }
    }
}

// ── the record ──────────────────────────────────────────────────────────────────────────────────────────────────

/// A key waiting for its certificate.
#[derive(Clone, Debug, PartialEq)]
struct Pending {
    gen: u64,
    kind: FailoverKind,
    public_id: String,
}

/// An installed failover credential, as the record holds it (nothing secret).
#[derive(Clone, Debug, PartialEq)]
pub struct Armed {
    pub kind: FailoverKind,
    /// SHA-256 hex of the certificate's SubjectPublicKeyInfo, the token hint, or `<client_email>:<private_key_id>`.
    pub public_id: String,
    pub not_before: i64,
    pub expires: i64,
    /// The credential's non-secret fields (`tenant`, `client_id`, `cloud`, the ARNs, `region`, `ca_pem`).
    pub fields: Map<String, Value>,
    gen: u64,
}

impl Armed {
    /// In date at `now`: an expired credential is not used (3.1).
    fn usable(&self, now: i64) -> bool {
        self.not_before - SKEW_S <= now && now < self.expires
    }
}

#[derive(Default)]
struct Record {
    pending: Option<Pending>,
    armed: Option<Armed>,
    /// Replaced generations whose sealed copy is not removed yet.
    retiring: Vec<u64>,
}

impl Record {
    /// Every generation the record lists, retiring ones included.
    fn gens(&self) -> Vec<u64> {
        self.pending.iter().map(|p| p.gen).chain(self.armed.iter().map(|a| a.gen)).chain(self.retiring.iter().copied()).collect()
    }

    fn next_gen(&self) -> u64 {
        self.gens().into_iter().max().unwrap_or(0) + 1
    }

    fn retire_gen(&mut self, gen: u64) {
        if !self.retiring.contains(&gen) {
            self.retiring.push(gen);
        }
    }
}

/// Record reads and writes, one at a time in the process.
static RECORDS: Mutex<()> = Mutex::new(());

fn dest_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn ids_ok(org: &str, destination: &str) -> Result<(), String> {
    if !org_ok(org) {
        return Err("that is not an organization id".into());
    }
    if !dest_ok(destination) {
        return Err("that is not a destination id".into());
    }
    Ok(())
}

fn record_path(dir: &Path, org: &str, destination: &str) -> PathBuf {
    dir.join(FAILOVER_DIR).join(org).join(format!("{destination}.json"))
}

fn queue_dir(dir: &Path, org: &str, destination: &str) -> PathBuf {
    dir.join(QUEUES_DIR).join(org).join(destination)
}

/// The sealed name of one generation of a destination's failover secret.
pub fn seal_name(org: &str, destination: &str, gen: u64) -> String {
    format!("api-failover-{org}-{destination}-{gen}")
}

fn load(dir: &Path, org: &str, destination: &str) -> Record {
    let Some(v) = std::fs::read_to_string(record_path(dir, org, destination)).ok().and_then(|t| parse_json(&t)) else { return Record::default() };
    let kind = |x: &Value| x.get("kind").and_then(Value::as_str).and_then(FailoverKind::of);
    let text = |x: &Value, k: &str| x.get(k).and_then(Value::as_str).map(str::to_string);
    let pending = v.get("pending").filter(|p| p.is_object()).and_then(|p| Some(Pending { gen: p.get("gen")?.as_u64()?, kind: kind(p)?, public_id: text(p, "public_id")? }));
    let armed = v.get("armed").filter(|a| a.is_object()).and_then(|a| {
        Some(Armed {
            kind: kind(a)?,
            public_id: text(a, "public_id")?,
            not_before: a.get("not_before")?.as_i64()?,
            expires: a.get("expires")?.as_i64()?,
            fields: a.get("fields").and_then(Value::as_object).cloned().unwrap_or_default(),
            gen: a.get("gen")?.as_u64()?,
        })
    });
    let retiring = v.get("retiring").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    Record { pending, armed, retiring }
}

fn save(dir: &Path, org: &str, destination: &str, r: &Record) -> Result<(), String> {
    let pending = r.pending.as_ref().map(|p| json!({"gen": p.gen, "kind": p.kind.type_name(), "public_id": p.public_id}));
    let armed = r.armed.as_ref().map(|a| {
        json!({"gen": a.gen, "kind": a.kind.type_name(), "public_id": a.public_id, "not_before": a.not_before, "expires": a.expires, "fields": Value::Object(a.fields.clone())})
    });
    let path = record_path(dir, org, destination);
    if let Some(parent) = path.parent() {
        crate::store::make_dir(parent).map_err(|e| format!("the failover record folder could not be made: {e}"))?;
    }
    crate::fleet_local::write_durable(&path, stringify(&json!({"pending": pending, "armed": armed, "retiring": r.retiring})).as_bytes())
}

/// Save a record that lists a newly sealed generation; when the save fails, that generation's sealed copy is removed
/// again (nothing lists it) and the save's error is returned.
fn save_or_unseal(dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str, r: &Record, sealed_gen: u64) -> Result<(), String> {
    save(dir, org, destination, r).inspect_err(|_| {
        let _ = drop_seal(vault, org, destination, sealed_gen);
    })
}

/// Remove the sealed copy of every retiring generation, keeping in the list those whose removal failed; the record is
/// saved again when the list changed. Run with `RECORDS` held.
fn sweep_locked(dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str, r: &mut Record) {
    if r.retiring.is_empty() {
        return;
    }
    let before = r.retiring.len();
    r.retiring.retain(|g| drop_seal(vault, org, destination, *g).is_err());
    if r.retiring.len() != before {
        // a failed save leaves gens listed whose removal is a no-op the next time
        let _ = save(dir, org, destination, r);
    }
}

/// Retry the removal of every retiring generation of one destination's failover credential.
pub fn sweep(state_dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str) {
    if ids_ok(org, destination).is_err() {
        return;
    }
    let _g = RECORDS.lock();
    let mut rec = load(state_dir, org, destination);
    sweep_locked(state_dir, vault, org, destination, &mut rec);
}

/// `sweep` for every record of the org (the mode loop, once a minute).
fn sweep_org(state_dir: &Path, vault: &dyn VaultLock, org: &str) {
    if !org_ok(org) {
        return;
    }
    let names: Vec<String> = std::fs::read_dir(state_dir.join(FAILOVER_DIR).join(org))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
        .filter(|d| dest_ok(d))
        .collect();
    for d in names {
        sweep(state_dir, vault, org, &d);
    }
}

fn unseal(vault: &dyn VaultLock, org: &str, destination: &str, gen: u64) -> Option<Value> {
    let raw = vault_do(vault, |v| v.get(&seal_name(org, destination, gen)))?;
    serde_json::from_slice(&raw).ok()
}

fn seal(vault: &dyn VaultLock, org: &str, destination: &str, gen: u64, v: &Value) -> Result<(), String> {
    vault_do(vault, |s| s.put(&seal_name(org, destination, gen), stringify(v).as_bytes())).map_err(|e| format!("the failover credential could not be sealed: {e}"))
}

fn drop_seal(vault: &dyn VaultLock, org: &str, destination: &str, gen: u64) -> Result<(), String> {
    vault_do(vault, |s| s.remove(&seal_name(org, destination, gen))).map_err(|e| format!("the failover credential could not be removed: {e}"))
}

fn key_of(kind: FailoverKind, sealed: &Value) -> Option<AnyKey> {
    AnyKey::from_pkcs8(kind, &b64_strict(sealed.get("key")?.as_str()?)?)
}

fn pem(label: &str, der: &[u8]) -> String {
    let b = b64(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn sync_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    std::fs::File::open(dir).and_then(|d| d.sync_all()).map_err(|e| format!("{} could not be flushed: {e}", dir.display()))?;
    let _ = dir;
    Ok(())
}

fn not_found_ok(r: std::io::Result<()>) -> std::io::Result<()> {
    r.or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
}

/// A token's public id: never any of its characters.
fn token_hint(token: &str) -> String {
    format!("sha256:{}", &hex(&sha256(token.as_bytes()))[..8])
}

// ── credentials (12.3) ──────────────────────────────────────────────────────────────────────────────────────────

/// `api-failover` `csr`: a PKCS#10 request (PEM) for a key drawn and sealed on this relay for the destination (EC
/// P-256, or RSA 3072 for `entra_certificate`). A key already waiting for a certificate of the same kind is used
/// again; another kind's waiting key is replaced. An installed credential stays in use until its successor is
/// installed.
pub fn failover_csr(state_dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str, kind: FailoverKind, subject_cn: &str) -> Result<String, String> {
    ids_ok(org, destination)?;
    if !kind.uses_csr() {
        return Err(format!("a {} credential has no certificate request", kind.type_name()));
    }
    if !(1..=64).contains(&subject_cn.len()) || subject_cn.chars().any(char::is_control) {
        return Err("the subject name must be 1 to 64 characters".into());
    }
    let _g = RECORDS.lock();
    let mut rec = load(state_dir, org, destination);
    let waiting = rec.pending.as_ref().filter(|p| p.kind == kind).and_then(|p| unseal(vault, org, destination, p.gen)).and_then(|v| key_of(kind, &v));
    let key = match waiting {
        Some(k) => k,
        None => {
            let gen = rec.next_gen();
            let key = AnyKey::generate(kind)?;
            seal(vault, org, destination, gen, &json!({"key": b64(key.pkcs8())}))?;
            // a replaced waiting key is never used again
            if let Some(o) = rec.pending.replace(Pending { gen, kind, public_id: hex(&sha256(&key.spki())) }) {
                rec.retire_gen(o.gen);
            }
            save_or_unseal(state_dir, vault, org, destination, &rec, gen)?;
            sweep_locked(state_dir, vault, org, destination, &mut rec);
            key
        }
    };
    Ok(pem("CERTIFICATE REQUEST", &key.csr(subject_cn)?))
}

/// `api-failover` `install`: `{"cert_pem", "chain_pem"?}` for the key waiting for a certificate, `{"token"}`, or
/// `{"key_json"}` (a Google service account key, as text), with `expires` (unix seconds) and the credential's
/// non-secret fields (`tenant`, `client_id`, `cloud` for `entra_certificate`; `trust_anchor_arn`, `profile_arn`,
/// `role_arn`, `region` for `aws_roles_anywhere`; `ca_pem` for `mtls`); `type`, when present, must be the kind.
/// Sealed and the record flushed before Ok, which is the installed credential's public metadata `{"type",
/// "public_id", "not_before", "expires"}` as this relay uses it (`not_before` the certificate's notBefore or now for a
/// secret kind, `expires` no later than the certificate's notAfter). The generations it replaces are removed after,
/// or listed as retiring until a later try removes them. `now` is unix seconds.
pub fn failover_install(state_dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str, material: Value, now: i64) -> Result<Value, String> {
    ids_ok(org, destination)?;
    let m = material.as_object().ok_or("the credential must be an object")?;
    install_at(state_dir, vault, org, destination, m, now)
}

/// A Google service account key's text, checked: a JSON object of `type` `service_account` with a bounded
/// `client_email`, `private_key`, `private_key_id` and `token_uri`. Its public id is `<client_email>:<private_key_id>`.
fn gcp_key(v: &Value) -> Result<(String, String), String> {
    let bad = || "key_json must be a Google service account key (JSON)".to_string();
    let text = v.as_str().filter(|t| (1..=KEY_JSON_MAX).contains(&t.len())).ok_or_else(bad)?;
    let k = parse_json(text).filter(Value::is_object).ok_or_else(bad)?;
    if k.get("type").and_then(Value::as_str) != Some("service_account") {
        return Err("key_json is not a service account key".into());
    }
    fn field<'a>(k: &'a Value, name: &str, max: usize) -> Result<&'a str, String> {
        k.get(name).and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(|c| c.is_control() && c != '\n')).ok_or_else(|| format!("key_json needs {name} of at most {max} characters"))
    }
    let email = field(&k, "client_email", FIELD_MAX)?;
    field(&k, "private_key", PRIVATE_KEY_MAX)?;
    let id = field(&k, "private_key_id", FIELD_MAX)?;
    field(&k, "token_uri", URI_MAX)?;
    if email.contains(['\n', ':']) || id.contains(['\n', ':']) {
        return Err("key_json has a client_email or private_key_id that is not one line".into());
    }
    Ok((text.to_string(), format!("{email}:{id}")))
}

fn install_at(state_dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str, m: &Map<String, Value>, now: i64) -> Result<Value, String> {
    if let Some(k) = m.keys().find(|k| !MATERIAL_KEYS.contains(&k.as_str())) {
        return Err(format!("{k} is not a failover credential field"));
    }
    let expires = m.get("expires").and_then(Value::as_i64).ok_or("expires must be a time")?;
    if expires <= now {
        return Err("the credential has already expired".into());
    }
    if expires > now + EXPIRES_MAX_S + SKEW_S {
        return Err("a failover credential lasts at most 90 days".into());
    }
    let want = m.get("type").map(|t| t.as_str().and_then(FailoverKind::of).ok_or("type is not a failover credential type")).transpose()?;
    let present: Vec<&str> = ["token", "key_json", "cert_pem"].into_iter().filter(|k| m.contains_key(*k)).collect();
    let [which] = present.as_slice() else { return Err("the credential is exactly one of cert_pem, token or key_json".into()) };
    if *which != "cert_pem" && m.contains_key("chain_pem") {
        return Err("a secret credential comes without a certificate chain".into());
    }
    let _g = RECORDS.lock();
    let mut rec = load(state_dir, org, destination);
    // every install seals a new generation, so a failed save never touches what is in use or waiting
    let gen = rec.next_gen();
    let (kind, sealed, not_before, end, public_id, waiting) = match *which {
        "token" => {
            let t = m["token"].as_str().filter(|t| (1..=TOKEN_MAX).contains(&t.len()) && !t.chars().any(|c| c.is_control() || c.is_whitespace())).ok_or("the token must be 1 to 4096 printable characters")?;
            (FailoverKind::Token, json!({"token": t}), now, expires, token_hint(t), None)
        }
        "key_json" => {
            let (text, id) = gcp_key(&m["key_json"])?;
            (FailoverKind::GcpServiceAccountKey, json!({"key_json": text}), now, expires, id, None)
        }
        _ => {
            let p = rec.pending.clone().ok_or("no failover key is waiting for a certificate")?;
            let c = m["cert_pem"].as_str().filter(|c| c.len() <= PEM_MAX).ok_or("cert_pem must be a PEM certificate")?;
            let der = crate::der::pem_blocks(c, "CERTIFICATE").into_iter().next().ok_or("cert_pem is not a certificate")?;
            let cert = Cert::from_der(&der).ok_or("cert_pem is not a certificate")?;
            let key = unseal(vault, org, destination, p.gen).and_then(|v| key_of(p.kind, &v)).ok_or("the waiting failover key does not open")?;
            if cert.spki != key.spki() {
                return Err("the certificate is not for the key this relay made".into());
            }
            if cert.not_after <= now {
                return Err("the certificate has expired".into());
            }
            let chain = match m.get("chain_pem") {
                None => String::new(),
                Some(v) => {
                    let s = v.as_str().filter(|s| s.len() <= CHAIN_MAX).ok_or("chain_pem must be PEM certificates")?;
                    let blocks = crate::der::pem_blocks(s, "CERTIFICATE");
                    if blocks.is_empty() || blocks.iter().any(|b| Cert::from_der(b).is_none()) {
                        return Err("chain_pem must be PEM certificates".into());
                    }
                    blocks.iter().map(|b| pem("CERTIFICATE", b)).collect()
                }
            };
            let sealed = json!({"key": b64(key.pkcs8()), "cert_pem": pem("CERTIFICATE", &der), "chain_pem": chain});
            (p.kind, sealed, cert.not_before, expires.min(cert.not_after), hex(&sha256(&cert.spki)), Some(p.gen))
        }
    };
    if want.is_some_and(|k| k != kind) {
        return Err(format!("type does not match the credential given (a {} credential)", kind.type_name()));
    }
    let fields = fields_of(kind, m)?;
    seal(vault, org, destination, gen, &sealed)?;
    let meta = json!({"type": kind.type_name(), "public_id": public_id, "not_before": not_before, "expires": end});
    if let Some(old) = rec.armed.replace(Armed { kind, public_id, not_before, expires: end, fields, gen }) {
        rec.retire_gen(old.gen);
    }
    // the waiting key now lives in the new generation with its certificate
    if let Some(w) = waiting {
        rec.pending = None;
        rec.retire_gen(w);
    }
    save_or_unseal(state_dir, vault, org, destination, &rec, gen)?;
    sweep_locked(state_dir, vault, org, destination, &mut rec);
    Ok(meta)
}

/// The kind's non-secret fields out of the material (required ones present, other kinds' absent).
fn fields_of(kind: FailoverKind, m: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mine = kind.fields();
    if let Some(k) = PUBLIC_FIELDS.iter().find(|k| m.contains_key(**k) && !mine.iter().any(|(n, _)| n == *k)) {
        return Err(format!("{k} does not belong to a {} credential", kind.type_name()));
    }
    let mut out = Map::new();
    for (k, required) in mine {
        match m.get(*k) {
            None if *required => return Err(format!("{k} is required for a {} credential", kind.type_name())),
            None => {}
            Some(v) => {
                let pem_field = *k == "ca_pem";
                let max = if pem_field { PEM_MAX } else { FIELD_MAX };
                let s = v.as_str().filter(|s| !s.is_empty() && s.len() <= max && (pem_field || !s.chars().any(char::is_control))).ok_or_else(|| format!("{k} must be text of at most {max} characters"))?;
                out.insert((*k).to_string(), Value::from(s));
            }
        }
    }
    if kind == FailoverKind::EntraCertificate {
        let cloud = out.get("cloud").and_then(Value::as_str).unwrap_or("public").to_string();
        if cloud != "public" && cloud != "usgov" {
            return Err("cloud must be public or usgov".into());
        }
        out.insert("cloud".into(), Value::from(cloud));
    }
    Ok(out)
}

/// The installed credential's record while it is in date at `now` (nothing secret); None when absent or expired.
pub fn armed(state_dir: &Path, org: &str, destination: &str, now: i64) -> Option<Armed> {
    if ids_ok(org, destination).is_err() {
        return None;
    }
    load(state_dir, org, destination).armed.filter(|a| a.usable(now))
}

/// The destination's failover credential for a sink; None when absent or expired (3.1: never used past its end).
pub fn failover_credential(state_dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str, now: i64) -> Option<Credential> {
    let a = armed(state_dir, org, destination, now)?;
    let v = unseal(vault, org, destination, a.gen)?;
    let field = |k: &str| a.fields.get(k).and_then(Value::as_str).map(str::to_string);
    match a.kind {
        FailoverKind::Token => return Some(Credential::Token(v.get("token")?.as_str()?.to_string())),
        FailoverKind::GcpServiceAccountKey => return Some(Credential::GcpServiceAccountKey(v.get("key_json")?.as_str()?.to_string())),
        _ => {}
    }
    let key_pem = pem("PRIVATE KEY", &b64_strict(v.get("key")?.as_str()?)?);
    let cert_pem = v.get("cert_pem")?.as_str()?.to_string();
    Some(match a.kind {
        FailoverKind::Mtls => {
            let chain = v.get("chain_pem").and_then(Value::as_str).unwrap_or_default();
            Credential::Mtls { cert_pem: format!("{cert_pem}{chain}"), key_pem, ca_pem: field("ca_pem") }
        }
        FailoverKind::EntraCertificate => Credential::EntraCertificate { tenant: field("tenant")?, client_id: field("client_id")?, cloud: field("cloud").unwrap_or_else(|| "public".into()), cert_pem, key_pem },
        FailoverKind::AwsRolesAnywhere => Credential::AwsRolesAnywhere {
            trust_anchor_arn: field("trust_anchor_arn")?,
            profile_arn: field("profile_arn")?,
            role_arn: field("role_arn")?,
            region: field("region")?,
            cert_pem,
            key_pem,
        },
        FailoverKind::Token | FailoverKind::GcpServiceAccountKey => return None,
    })
}

/// The credential's public shape (no secret), for `api_export::credential_fits`.
fn public_credential(a: &Armed) -> Credential {
    let field = |k: &str| a.fields.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    match a.kind {
        FailoverKind::Token => Credential::Token(String::new()),
        FailoverKind::GcpServiceAccountKey => Credential::GcpServiceAccountKey(String::new()),
        FailoverKind::Mtls => Credential::Mtls { cert_pem: String::new(), key_pem: String::new(), ca_pem: None },
        FailoverKind::EntraCertificate => Credential::EntraCertificate { tenant: field("tenant"), client_id: field("client_id"), cloud: field("cloud"), cert_pem: String::new(), key_pem: String::new() },
        FailoverKind::AwsRolesAnywhere => Credential::AwsRolesAnywhere {
            trust_anchor_arn: field("trust_anchor_arn"),
            profile_arn: field("profile_arn"),
            role_arn: field("role_arn"),
            region: field("region"),
            cert_pem: String::new(),
            key_pem: String::new(),
        },
    }
}

/// Delete the destination's failover credential (every sealed generation, then the record) and its failover queue
/// folder, flushed before Ok. Nothing there is Ok.
pub fn failover_delete(state_dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str) -> Result<(), String> {
    ids_ok(org, destination)?;
    let _g = RECORDS.lock();
    let rec = load(state_dir, org, destination);
    for gen in rec.gens() {
        drop_seal(vault, org, destination, gen)?;
    }
    let path = record_path(state_dir, org, destination);
    not_found_ok(std::fs::remove_file(&path)).map_err(|e| format!("the failover record could not be removed: {e}"))?;
    if let Some(parent) = path.parent().filter(|p| p.exists()) {
        sync_dir(parent)?;
    }
    let q = queue_dir(state_dir, org, destination);
    not_found_ok(std::fs::remove_dir_all(&q)).map_err(|e| format!("the failover queue could not be removed: {e}"))?;
    if let Some(parent) = q.parent().filter(|p| p.exists()) {
        sync_dir(parent)?;
    }
    Ok(())
}

/// What the journal handler and the `api-failover` `delete` call before they answer (2.5, 12.3): the relay's failover
/// exporter first stops enqueue and delivery for the destination (after any send in flight) and drops its queues,
/// then the sealed credential, its record and the queue folder are deleted and flushed. Ok only when all is gone.
pub fn retire(state_dir: &Path, vault: &dyn VaultLock, org: &str, destination: &str) -> Result<(), String> {
    ids_ok(org, destination)?;
    if let Some(f) = running(state_dir) {
        f.engine.remove(org, destination);
    }
    failover_delete(state_dir, vault, org, destination)
}

// ── the relay behind the exporter ───────────────────────────────────────────────────────────────────────────────

/// What the failover exporter reads of the relay (`meet.rs`; tests stand in fakes).
pub trait RelaySide: Send + Sync {
    /// The org ids this relay serves (relay.json `organizations`).
    fn orgs(&self) -> Vec<String>;
    /// The org's pinned map (`map` object) when it serves (not set aside, expired or not), and its active journal
    /// entries; None without one.
    fn api_map(&self, org: &str) -> Option<(Value, Vec<TightenEntry>)>;
    /// The license edition (13).
    fn edition(&self) -> Option<Edition>;
    /// This relay's fleet id, None while not enrolled.
    fn relay_id(&self) -> Option<String>;
    /// Its own audit chains.
    fn audit(&self) -> Option<Arc<ApiAudit>>;
    /// Where it seals secrets.
    fn vault(&self) -> Option<Arc<dyn VaultLock>>;
    /// The fleet channel to the console is welcomed and open.
    fn channel_up(&self) -> bool;
    /// The channel is up and the console's reconnect sync (2.5) is done.
    fn caught_up(&self) -> bool;
    /// Its own metric rows for the org (`api_listener::own_exposition`).
    fn metric_rows(&self, org: &str, now: i64) -> Vec<MetricRow>;
    /// The sink for a destination entry.
    fn make_sink(&self, destination: &Value, credential: Credential) -> Result<Box<dyn Sink>, SinkError>;
    /// Unix seconds.
    fn now(&self) -> i64 {
        now_ms().div_euclid(1000)
    }
    /// Revision 4 7.1: `relay.mode.changed` for the org (`mode` `normal` or `failover`) in the relay's event chains.
    fn mode_changed(&self, _org: &str, _mode: &str) {}
}

/// One org in failover.
#[derive(Clone, Copy)]
struct OrgMode {
    /// The first seq of its `relay.failover.on` entry per representation.
    firsts: [u64; 3],
    /// Leaving: delivery is off, `relay.failover.off` is not recorded yet.
    leaving: bool,
}

/// The engine's host on a relay.
struct Core {
    dir: PathBuf,
    side: Arc<dyn RelaySide>,
    logger: Arc<Logger>,
    /// Orgs in failover (leaving ones included).
    on: Mutex<BTreeMap<String, OrgMode>>,
}

impl Core {
    /// The org's `failover_after_s` while its map serves and has not expired.
    fn after_s(&self, org: &str, now: i64) -> Option<i64> {
        let (map, _) = self.side.api_map(org)?;
        if map.get("expires").and_then(Value::as_i64).is_none_or(|e| e <= now) {
            return None;
        }
        Some(map.get("failover_after_s").and_then(Value::as_i64).unwrap_or(AFTER_DEFAULT_S).clamp(AFTER_MIN_S, AFTER_MAX_S))
    }
}

impl Host for Core {
    fn config(&self, _now: i64) -> (Option<Edition>, Vec<OrgConfig>) {
        let orgs = self
            .side
            .orgs()
            .into_iter()
            .map(|org| match self.side.api_map(&org) {
                Some((map, active)) => {
                    let disabled = |id: &str| active.iter().any(|e| e.action == "destination_disable_failover" && e.target.as_str() == Some(id));
                    let destinations = map
                        .get("destinations")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter(|d| d.get("failover").and_then(Value::as_bool) == Some(true) && !disabled(d.get("id").and_then(Value::as_str).unwrap_or_default())).cloned().collect())
                        .unwrap_or_default();
                    OrgConfig { org, serving: true, expires: map.get("expires").and_then(Value::as_i64).unwrap_or(0), destinations, active }
                }
                None => OrgConfig { org, serving: false, expires: 0, destinations: Vec::new(), active: Vec::new() },
            })
            .collect();
        (self.side.edition(), orgs)
    }

    fn credential(&self, org: &str, id: &str) -> Option<Credential> {
        let vault = self.side.vault()?;
        failover_credential(&self.dir, &*vault, org, id, self.side.now())
    }

    fn delete_credential(&self, org: &str, id: &str) {
        let Some(vault) = self.side.vault() else { return };
        if let Err(why) = failover_delete(&self.dir, &*vault, org, id) {
            self.logger.security("api.failover.delete-failed", &Fields::new().with("org", org).with("destination", id).with("why", why), Level::Error);
        }
    }

    fn pseudonym_key(&self, org: &str) -> Option<(u32, Vec<u8>)> {
        crate::api_checkpoint::RelayPseudonymKeys::new(&self.dir, self.side.vault()?).current(org)
    }

    fn audit_sources(&self, _org: &str) -> Vec<String> {
        self.side.relay_id().filter(|_| self.side.audit().is_some()).into_iter().collect()
    }

    fn audit_read(&self, org: &str, source: &str, repr: Repr, after: u64, limit: usize) -> Vec<Value> {
        if self.side.relay_id().as_deref() != Some(source) {
            return Vec::new();
        }
        self.side.audit().map(|a| a.since(org, repr, after, limit)).unwrap_or_default()
    }

    fn audit_record(&self, org: &str, entry: Value, now: i64) {
        crate::fleet_agent::api_record(self.side.audit().as_deref(), vec![(org.to_string(), entry)], &self.logger, now);
    }

    fn metric_rows(&self, org: &str, now: i64) -> Vec<MetricRow> {
        self.side.metric_rows(org, now)
    }

    fn resource(&self, org: &str) -> Vec<(String, String)> {
        let id = self.side.relay_id().unwrap_or_default();
        [("service.name", "lucid-relay"), ("service.version", env!("CARGO_PKG_VERSION")), ("service.instance.id", id.as_str()), ("lucid.org", org), ("lucid.relay.id", id.as_str())]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn make_sink(&self, destination: &Value, credential: Credential) -> Result<Box<dyn Sink>, SinkError> {
        self.side.make_sink(destination, credential)
    }

    /// On while the org is in failover and not leaving; until the installed credential's end when it fits the entry
    /// (type and the public fields the map names), 0 otherwise; audit from the org's `relay.failover.on` entry.
    fn failover_gate(&self, org: &str, entry: &Value, now: i64) -> Option<Gate> {
        let firsts = self.on.lock().get(org).filter(|m| !m.leaving).map(|m| m.firsts);
        let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
        let until = armed(&self.dir, org, id, now).filter(|a| export::credential_fits(entry, &public_credential(a))).map_or(0, |a| a.expires);
        let from = match (firsts, self.side.relay_id()) {
            (Some(f), Some(r)) => vec![(r, f)],
            _ => Vec::new(),
        };
        Some(Gate { on: firsts.is_some(), until, from })
    }
}

// ── the exporter and its modes (12.2) ───────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Clock {
    /// When the channel was first seen down (None while up).
    down_since: Option<i64>,
    last_refresh: i64,
    last_minute: i64,
    hold_set: bool,
}

/// A relay's failover exporter.
pub struct Failover {
    core: Arc<Core>,
    engine: Arc<ExportEngine>,
    clock: Mutex<Clock>,
}

/// The running exporters, by state folder.
static RUNNING: LazyLock<Mutex<HashMap<PathBuf, Arc<Failover>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn running(dir: &Path) -> Option<Arc<Failover>> {
    RUNNING.lock().get(dir).cloned()
}

/// Start the relay's failover exporter for its state folder: queues, mode loop (every second), the relay's spans and
/// log events.
pub fn start(state_dir: &Path, side: Arc<dyn RelaySide>, logger: Arc<Logger>) -> Result<(), String> {
    let f = Failover::open(state_dir, side, logger, true);
    export::install_relay(&f.engine);
    crate::log::set_export_tap(export::log_tap());
    let w = Arc::downgrade(&f);
    std::thread::Builder::new()
        .name("api-failover".into())
        .spawn(move || loop {
            let Some(f) = w.upgrade() else { return };
            f.step(f.core.side.now());
            drop(f);
            std::thread::sleep(STEP);
        })
        .map(|_| ())
        .map_err(|e| format!("the failover exporter could not start: {e}"))
}

/// The maps, the journal or a failover credential changed: every running exporter reads its config again now.
pub fn changed() {
    let all: Vec<Arc<Failover>> = RUNNING.lock().values().cloned().collect();
    for f in all {
        f.engine.refresh(f.core.side.now());
    }
}

/// 7.2 `v1/health` `mode` of an org on this relay: `failover` while a running exporter has it in failover.
pub fn mode(org: &str) -> &'static str {
    let all: Vec<Arc<Failover>> = RUNNING.lock().values().cloned().collect();
    if all.iter().any(|f| f.mode_of(org) == "failover") {
        "failover"
    } else {
        "normal"
    }
}

impl Failover {
    /// The exporter over `<state>/failover-exports` (registered for `retire`, `changed` and `mode`). With `threads`,
    /// the engine's intake and delivery threads run; tests drive the engine themselves.
    pub fn open(state_dir: &Path, side: Arc<dyn RelaySide>, logger: Arc<Logger>, threads: bool) -> Arc<Failover> {
        let core = Arc::new(Core { dir: state_dir.to_path_buf(), side, logger: logger.clone(), on: Mutex::new(BTreeMap::new()) });
        let engine = ExportEngine::open(&state_dir.join(QUEUES_DIR), core.clone(), logger, threads);
        crate::api_catalog::counters::set_relay_mode("normal");
        let now = core.side.now();
        engine.refresh(now);
        let f = Arc::new(Failover { core, engine, clock: Mutex::new(Clock { last_refresh: now, last_minute: now.div_euclid(60), ..Clock::default() }) });
        RUNNING.lock().insert(state_dir.to_path_buf(), f.clone());
        f
    }

    /// The org's mode on this exporter.
    pub fn mode_of(&self, org: &str) -> &'static str {
        if self.core.on.lock().contains_key(org) {
            "failover"
        } else {
            "normal"
        }
    }

    /// One pass of the mode loop at `now` (unix seconds).
    pub fn step(&self, now: i64) {
        let up = self.core.side.channel_up();
        let synced = up && self.core.side.caught_up();
        let (down_since, refresh, minute) = {
            let mut c = self.clock.lock();
            if up {
                c.down_since = None;
            } else if c.down_since.is_none() {
                c.down_since = Some(now);
            }
            if !c.hold_set {
                if let Some(a) = self.core.side.audit() {
                    // 9.4: the relay's chains keep what a failover destination has not acknowledged
                    a.set_retention_hold(self.engine.retention_hold());
                    c.hold_set = true;
                }
            }
            let refresh = now - c.last_refresh >= REFRESH_S;
            if refresh {
                c.last_refresh = now;
            }
            let minute = now.div_euclid(60) != c.last_minute;
            if minute {
                c.last_minute = now.div_euclid(60);
            }
            (c.down_since, refresh, minute)
        };
        let held: BTreeMap<String, OrgMode> = self.core.on.lock().clone();
        if synced {
            for org in held.keys() {
                self.leave(org, now);
            }
        } else if let Some(since) = down_since {
            for org in self.core.side.orgs() {
                if !self.core.after_s(&org, now).is_some_and(|after| now - since >= after) {
                    continue;
                }
                match held.get(&org) {
                    None => self.enter(&org, now),
                    // lost again before `relay.failover.off` was recorded: the failover goes on
                    Some(m) if m.leaving => self.resume(&org, now),
                    Some(_) => {}
                }
            }
        }
        if refresh {
            self.engine.refresh(now);
        }
        if minute {
            self.engine.tick(now.saturating_mul(1000));
            // replaced credential generations whose sealed copy could not be removed before
            if let Some(vault) = self.core.side.vault() {
                for org in self.core.side.orgs() {
                    sweep_org(&self.core.dir, &*vault, &org);
                }
            }
        }
    }

    /// Enter failover for an org, only once `relay.failover.on` is durably in its chain: then direct delivery from that
    /// entry on. A failed append leaves the org in `normal` (the next pass tries again): delivery never starts without
    /// the marker.
    fn enter(&self, org: &str, now: i64) {
        let (Some(audit), Some(relay)) = (self.core.side.audit(), self.core.side.relay_id()) else { return };
        let before = Repr::ALL.map(|r| audit.head(org, &relay, r).0);
        if let Err(e) = audit.record(org, json!({"action": ON, "result": "ok"}), now) {
            self.core.logger.security("api.audit-failed", &Fields::new().with("org", org).with("action", ON).with("why", e.to_string()), Level::Error);
            return;
        }
        let mut firsts = [0u64; 3];
        for (i, r) in Repr::ALL.iter().enumerate() {
            let found = audit.since(org, *r, before[i], SCAN).iter().find(|e| e.get("action").and_then(Value::as_str) == Some(ON)).and_then(|e| e.get("seq")?.as_u64());
            firsts[i] = found.unwrap_or(before[i] + 1);
        }
        self.core.on.lock().insert(org.to_string(), OrgMode { firsts, leaving: false });
        crate::api_catalog::counters::set_relay_mode("failover");
        self.core.side.mode_changed(org, "failover");
        self.core.logger.security(ON, &Fields::new().with("org", org), Level::Warn);
        self.engine.refresh(now);
    }

    /// A leaving org whose channel was lost again for `failover_after_s`: delivery resumes from where it was (its
    /// `relay.failover.on` is in the chain and no `relay.failover.off` followed).
    fn resume(&self, org: &str, now: i64) {
        if let Some(m) = self.core.on.lock().get_mut(org) {
            m.leaving = false;
        }
        self.core.logger.security(ON, &Fields::new().with("org", org).with("resumed", true), Level::Warn);
        self.engine.refresh(now);
    }

    /// Leave failover for an org: direct delivery stops first (after any send in flight) and the org is leaving; it is
    /// `normal` only once `relay.failover.off` is durably recorded (a failed append is tried again on the next pass,
    /// with delivery still off).
    fn leave(&self, org: &str, now: i64) {
        let started = {
            let mut on = self.core.on.lock();
            let Some(m) = on.get_mut(org) else { return };
            !std::mem::replace(&mut m.leaving, true)
        };
        if started {
            self.engine.refresh(now);
        }
        let Some(audit) = self.core.side.audit() else { return };
        if let Err(e) = audit.record(org, json!({"action": OFF, "result": "ok"}), now) {
            self.core.logger.security("api.audit-failed", &Fields::new().with("org", org).with("action", OFF).with("why", e.to_string()), Level::Error);
            return;
        }
        let none_left = {
            let mut on = self.core.on.lock();
            on.remove(org);
            on.is_empty()
        };
        if none_left {
            crate::api_catalog::counters::set_relay_mode("normal");
        }
        self.core.side.mode_changed(org, "normal");
        self.core.logger.security(OFF, &Fields::new().with("org", org), Level::Info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_audit::CheckpointSigner;
    use crate::api_export_wire::{Batch, Signal};
    use crate::fleet_ca::MemVault;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

    const NOW: i64 = 1_795_000_000;
    const RELAY: &str = "r_01";
    const D1: &str = "d_00000000000000a1";
    const D2: &str = "d_00000000000000b2";

    fn tmp(name: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("lucid-api-failover-{name}-{}-{}-{}", std::process::id(), now_ms(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    struct NoSigner;
    impl CheckpointSigner for NoSigner {
        fn kid(&self, _org: &str) -> Option<String> {
            None
        }
        fn sign(&self, _org: &str, _payload: &[u8]) -> Option<Vec<u8>> {
            None
        }
        fn certs(&self, _org: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct Keys;
    impl PseudonymKeys for Keys {
        fn current(&self, _org: &str) -> Option<(u32, Vec<u8>)> {
            Some((1, vec![7u8; 32]))
        }
    }

    struct FakeSink {
        id: String,
        sent: Arc<Mutex<Vec<(String, Batch)>>>,
        fail: bool,
    }

    impl Sink for FakeSink {
        fn deliver(&self, batch: &Batch) -> Result<(), SinkError> {
            if self.fail {
                return Err(SinkError { retryable: true, code: "test", message: "The collector did not answer.".into() });
            }
            self.sent.lock().push((self.id.clone(), batch.clone()));
            Ok(())
        }
    }

    struct Side {
        org: String,
        map: Mutex<Value>,
        active: Mutex<Vec<TightenEntry>>,
        audit: Arc<ApiAudit>,
        vault: Arc<Mutex<MemVault>>,
        up: AtomicBool,
        synced: AtomicBool,
        now: AtomicI64,
        sent: Arc<Mutex<Vec<(String, Batch)>>>,
        made: AtomicUsize,
        fail: AtomicBool,
    }

    impl RelaySide for Side {
        fn orgs(&self) -> Vec<String> {
            vec![self.org.clone()]
        }
        fn api_map(&self, org: &str) -> Option<(Value, Vec<TightenEntry>)> {
            (org == self.org).then(|| (self.map.lock().clone(), self.active.lock().clone()))
        }
        fn edition(&self) -> Option<Edition> {
            Some(Edition::Enterprise)
        }
        fn relay_id(&self) -> Option<String> {
            Some(RELAY.into())
        }
        fn audit(&self) -> Option<Arc<ApiAudit>> {
            Some(self.audit.clone())
        }
        fn vault(&self) -> Option<Arc<dyn VaultLock>> {
            Some(self.vault.clone() as Arc<dyn VaultLock>)
        }
        fn channel_up(&self) -> bool {
            self.up.load(Ordering::SeqCst)
        }
        fn caught_up(&self) -> bool {
            self.up.load(Ordering::SeqCst) && self.synced.load(Ordering::SeqCst)
        }
        fn metric_rows(&self, _org: &str, _now: i64) -> Vec<MetricRow> {
            Vec::new()
        }
        fn make_sink(&self, destination: &Value, _credential: Credential) -> Result<Box<dyn Sink>, SinkError> {
            self.made.fetch_add(1, Ordering::SeqCst);
            let id = destination.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            Ok(Box::new(FakeSink { id, sent: self.sent.clone(), fail: self.fail.load(Ordering::SeqCst) }))
        }
        fn now(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
    }

    fn dest(id: &str, failover: bool) -> Value {
        json!({"id": id, "name": format!("dest {id}"), "kind": "splunk_hec", "preset": "splunk_hec", "signals": ["audit"], "ceiling": "confidential",
               "identities": "as_is", "failover": failover, "private_ok": false, "endpoint": "https://hec.acme.example:8088/services/collector/event",
               "settings": {"index": "lucid", "ack": true}, "credential": {"type": "token", "ref": format!("secret:{id}")},
               "queue": {"max_bytes": 64u64 << 20, "max_age_s": 259_200}})
    }

    fn map(org: &str, dests: Vec<Value>, after: i64) -> Value {
        json!({"v": 1, "org": org, "seq": 1, "issued": NOW - 100, "expires": NOW + 30 * 86_400, "failover_after_s": after, "destinations": dests})
    }

    fn side(dir: &Path, org: &str, dests: Vec<Value>, after: i64) -> Arc<Side> {
        let audit = Arc::new(ApiAudit::open(Some(dir), RELAY, Arc::new(NoSigner), Arc::new(Keys), NOW));
        Arc::new(Side {
            org: org.into(),
            map: Mutex::new(map(org, dests, after)),
            active: Mutex::new(Vec::new()),
            audit,
            vault: Arc::new(Mutex::new(MemVault::default())),
            up: AtomicBool::new(false),
            synced: AtomicBool::new(false),
            now: AtomicI64::new(NOW),
            sent: Arc::new(Mutex::new(Vec::new())),
            made: AtomicUsize::new(0),
            fail: AtomicBool::new(false),
        })
    }

    fn open(dir: &Path, s: &Arc<Side>) -> Arc<Failover> {
        Failover::open(dir, s.clone(), Arc::new(Logger::capture("test", Box::new(|_, _| {}))), false)
    }

    fn install_token(dir: &Path, s: &Side, org: &str, id: &str, expires: i64) {
        let m = json!({"token": "hec-token-0123456789", "expires": expires});
        install_at(dir, &*s.vault, org, id, m.as_object().unwrap(), NOW).unwrap();
    }

    fn actions(s: &Side, org: &str) -> Vec<String> {
        s.audit.since(org, Repr::AsIs, 0, 100).iter().map(|e| e["action"].as_str().unwrap_or_default().to_string()).collect()
    }

    /// Records delivered to a destination, audit first in order.
    fn delivered(s: &Side, id: &str) -> Vec<Value> {
        s.sent.lock().iter().filter(|(d, b)| d == id && b.signal == Signal::Audit).flat_map(|(_, b)| b.records.clone()).collect()
    }

    /// A certificate around a SubjectPublicKeyInfo (structure only: nothing here checks its signature).
    fn cert_for(spki: &[u8], not_after: i64) -> String {
        let seq = |parts: &[Vec<u8>]| x509::der(0x30, &parts.concat());
        let alg = seq(&[x509::der(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])]);
        let name = x509::name(&[(x509::OID_CN, "acme-tool")]);
        let tbs = seq(&[x509::der(0xa0, &x509::der(0x02, &[2])), x509::integer(&[0x41, 1, 2, 3]), alg.clone(), name.clone(), seq(&[x509::time((NOW - 60) * 1000), x509::time(not_after * 1000)]), name, spki.to_vec()]);
        pem("CERTIFICATE", &seq(&[tbs, alg, x509::der(0x03, &[0, 1, 2, 3])]))
    }

    fn csr_spki(csr_pem: &str) -> Vec<u8> {
        let der = crate::der::pem_blocks(csr_pem, "CERTIFICATE REQUEST").remove(0);
        crate::meet_x509::Csr::from_der(&der).unwrap().spki
    }

    #[test]
    fn mode_switches_only_after_failover_after_s_and_back_on_reconnect() {
        let dir = tmp("mode");
        let org = "fo-mode";
        let s = side(&dir, org, vec![dest(D1, true)], 120);
        let f = open(&dir, &s);
        s.up.store(true, Ordering::SeqCst);
        s.synced.store(true, Ordering::SeqCst);
        f.step(NOW);
        s.up.store(false, Ordering::SeqCst);
        f.step(NOW + 10);
        f.step(NOW + 10 + 119);
        assert_eq!(f.mode_of(org), "normal", "not before failover_after_s");
        assert!(!actions(&s, org).contains(&ON.to_string()));
        f.step(NOW + 10 + 120);
        assert_eq!(f.mode_of(org), "failover");
        assert_eq!(mode(org), "failover");
        // up again, the console's reconnect sync not done yet: still failover
        s.up.store(true, Ordering::SeqCst);
        s.synced.store(false, Ordering::SeqCst);
        f.step(NOW + 200);
        assert_eq!(f.mode_of(org), "failover");
        s.synced.store(true, Ordering::SeqCst);
        f.step(NOW + 201);
        assert_eq!(f.mode_of(org), "normal");
        assert_eq!(mode(org), "normal");
        assert_eq!(actions(&s, org), vec![ON.to_string(), OFF.to_string()]);
        // a short outage after that does not switch
        s.up.store(false, Ordering::SeqCst);
        f.step(NOW + 300);
        s.up.store(true, Ordering::SeqCst);
        f.step(NOW + 330);
        f.step(NOW + 500);
        assert_eq!(f.mode_of(org), "normal");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failover_on_is_the_first_record_delivered() {
        let dir = tmp("first");
        let org = "fo-first";
        let s = side(&dir, org, vec![dest(D1, true)], 60);
        for _ in 0..3 {
            s.audit.record(org, json!({"action": "api.call", "result": "ok"}), NOW).unwrap();
        }
        install_token(&dir, &s, org, D1, NOW + 10 * 86_400);
        let f = open(&dir, &s);
        f.step(NOW);
        f.engine.pull_audit(NOW * 1000);
        f.engine.pump(NOW * 1000);
        assert!(s.sent.lock().is_empty(), "nothing leaves in normal mode");
        f.step(NOW + 60);
        assert_eq!(f.mode_of(org), "failover");
        s.audit.record(org, json!({"action": "api.call", "result": "ok"}), NOW + 61).unwrap();
        let t = (NOW + 61) * 1000;
        f.engine.pull_audit(t);
        f.engine.pump(t);
        let got = delivered(&s, D1);
        assert!(!got.is_empty());
        assert_eq!(got[0]["event"], ON, "relay.failover.on is the first record delivered");
        assert_eq!(got[0]["attributes"]["lucid.seq"], 4, "nothing from before the failover");
        assert_eq!(got.len(), 2);
        assert!(got[0]["attributes"]["lucid.chain"].as_str().unwrap().ends_with(&format!("/{RELAY}")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_destination_without_an_installed_credential_receives_nothing() {
        let dir = tmp("nocred");
        let org = "fo-nocred";
        let s = side(&dir, org, vec![dest(D1, true), dest(D2, true)], 60);
        install_token(&dir, &s, org, D1, NOW + 10 * 86_400);
        let f = open(&dir, &s);
        f.step(NOW);
        f.step(NOW + 60);
        let t = (NOW + 61) * 1000;
        f.engine.pull_audit(t);
        f.engine.pump(t);
        assert!(!delivered(&s, D1).is_empty());
        assert!(s.sent.lock().iter().all(|(d, _)| d == D1), "D2 has no failover credential");
        let st = f.engine.status(Some(org), t);
        assert_eq!(st.iter().find(|x| x["id"] == D2).unwrap()["state"], "suspended");
        // a destination without failover: true is not even held
        *s.map.lock() = map(org, vec![dest(D1, true), dest(D2, false)], 60);
        f.engine.refresh(NOW + 62);
        assert!(f.engine.status(Some(org), t).iter().all(|x| x["id"] != D2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_failover_credential_is_never_used() {
        let dir = tmp("expired");
        let org = "fo-expired";
        let s = side(&dir, org, vec![dest(D1, true)], 60);
        install_token(&dir, &s, org, D1, NOW + 100);
        let vault: &dyn VaultLock = &*s.vault;
        assert!(failover_credential(&dir, vault, org, D1, NOW + 99).is_some());
        assert!(failover_credential(&dir, vault, org, D1, NOW + 100).is_none(), "an outage never extends it");
        let f = open(&dir, &s);
        s.now.store(NOW + 100, Ordering::SeqCst);
        f.step(NOW + 100);
        f.step(NOW + 160);
        assert_eq!(f.mode_of(org), "failover");
        let t = (NOW + 161) * 1000;
        f.engine.pull_audit(t);
        f.engine.pump(t);
        assert!(s.sent.lock().is_empty());
        assert_eq!(s.made.load(Ordering::SeqCst), 0, "no sink is made with an expired credential");
        // a credential that ends during the failover stops delivery at that instant
        install_token(&dir, &s, org, D1, NOW + 300);
        f.engine.refresh(NOW + 170);
        f.engine.pull_audit((NOW + 170) * 1000);
        assert_eq!(f.engine.pump((NOW + 300) * 1000), 0, "nothing leaves at the credential's end");
        assert!(s.sent.lock().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disable_failover_deletes_the_credential_and_queue_before_the_ack() {
        let dir = tmp("retire");
        let org = "fo-retire";
        let s = side(&dir, org, vec![dest(D1, true)], 60);
        install_token(&dir, &s, org, D1, NOW + 10 * 86_400);
        s.fail.store(true, Ordering::SeqCst);
        let f = open(&dir, &s);
        f.step(NOW);
        f.step(NOW + 60);
        let t = (NOW + 61) * 1000;
        f.engine.pull_audit(t);
        f.engine.pump(t);
        let q = dir.join(QUEUES_DIR).join(org).join(D1);
        assert!(q.join("audit").exists(), "queued while the tool does not answer");
        assert!(record_path(&dir, org, D1).exists());
        // the journal handler calls retire before it applies and acknowledges the entry
        retire(&dir, &*s.vault, org, D1).unwrap();
        assert!(!q.exists(), "the failover queue is gone");
        assert!(!record_path(&dir, org, D1).exists(), "the record is gone");
        assert!(s.vault.lock().map.keys().all(|k| !k.starts_with("api-failover-")), "nothing sealed is left");
        assert!(failover_credential(&dir, &*s.vault, org, D1, NOW + 62).is_none());
        // then the entry is applied: the destination is not held again
        *s.active.lock() = vec![TightenEntry::parse(&json!({"id": "t_fo-retire_000001", "tseq": 1, "ts": NOW + 62, "action": "destination_disable_failover", "target": D1})).unwrap()];
        f.engine.refresh(NOW + 62);
        assert!(f.engine.status(Some(org), t).is_empty());
        assert!(!q.exists());
        assert_eq!(f.engine.pump(t + 2000), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_refuses_a_certificate_that_does_not_match_the_request_key() {
        let dir = tmp("mismatch");
        let org = "fo-mismatch";
        let vault = Mutex::new(MemVault::default());
        let csr = failover_csr(&dir, &vault, org, D1, FailoverKind::Mtls, "relay r_01").unwrap();
        let other = Key::generate(Curve::P256).unwrap();
        let wrong = json!({"cert_pem": cert_for(&other.spki(), NOW + 86_400), "expires": NOW + 86_400});
        let err = install_at(&dir, &vault, org, D1, wrong.as_object().unwrap(), NOW).unwrap_err();
        assert!(err.contains("not for the key"), "{err}");
        assert!(armed(&dir, org, D1, NOW).is_none());
        let right = json!({"cert_pem": cert_for(&csr_spki(&csr), NOW + 86_400), "expires": NOW + 200 * 86_400});
        assert!(install_at(&dir, &vault, org, D1, right.as_object().unwrap(), NOW).unwrap_err().contains("90 days"));
        let right = json!({"cert_pem": cert_for(&csr_spki(&csr), NOW + 86_400), "expires": NOW + 30 * 86_400, "type": "mtls"});
        let meta = install_at(&dir, &vault, org, D1, right.as_object().unwrap(), NOW).unwrap();
        assert_eq!(meta, json!({"type": "mtls", "public_id": hex(&sha256(&csr_spki(&csr))), "not_before": NOW - 60, "expires": NOW + 86_400}), "the relay's own dates");
        assert!(vault.lock().map.keys().all(|k| k != &seal_name(org, D1, 1)), "the waiting key's generation is retired");
        let a = armed(&dir, org, D1, NOW).unwrap();
        assert_eq!(a.expires, NOW + 86_400, "never past the certificate's notAfter");
        assert_eq!(a.public_id, hex(&sha256(&csr_spki(&csr))));
        match failover_credential(&dir, &vault, org, D1, NOW).unwrap() {
            Credential::Mtls { key_pem, .. } => assert!(key_pem.contains("BEGIN PRIVATE KEY")),
            _ => panic!("an mtls credential"),
        }
        // the record holds nothing secret
        let text = std::fs::read_to_string(record_path(&dir, org, D1)).unwrap();
        assert!(!text.contains("PRIVATE KEY") && !text.contains("\"key\""), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rsa_3072_for_entra_and_ec_p256_for_the_others_parse_and_verify() {
        let dir = tmp("csr");
        let org = "fo-csr";
        let vault = Mutex::new(MemVault::default());
        let entra = failover_csr(&dir, &vault, org, D1, FailoverKind::EntraCertificate, "lucid relay r_01").unwrap();
        let der = crate::der::pem_blocks(&entra, "CERTIFICATE REQUEST").remove(0);
        let csr = crate::meet_x509::Csr::from_der(&der).unwrap();
        assert!(csr.signature_valid(), "signed by its own RSA key");
        assert!(x509::read_request(&der).is_none(), "not an EC request");
        let rsa = aws_lc_rs::signature::RsaKeyPair::from_pkcs8(&b64_strict(unseal(&vault, org, D1, 1).unwrap()["key"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(rsa.public_modulus_len(), 384, "3072 bits");
        assert_eq!(csr_spki(&entra), RsaKey::from_pkcs8(&b64_strict(unseal(&vault, org, D1, 1).unwrap()["key"].as_str().unwrap()).unwrap()).unwrap().spki());
        // the same waiting key is asked again
        assert_eq!(csr_spki(&failover_csr(&dir, &vault, org, D1, FailoverKind::EntraCertificate, "lucid relay r_01").unwrap()), csr_spki(&entra));
        for (id, kind) in [(D2, FailoverKind::Mtls), ("d_00000000000000c3", FailoverKind::AwsRolesAnywhere)] {
            let p = failover_csr(&dir, &vault, org, id, kind, "lucid relay r_01").unwrap();
            let der = crate::der::pem_blocks(&p, "CERTIFICATE REQUEST").remove(0);
            let req = x509::read_request(&der).expect("an EC P-256 request signed by its key");
            assert!(x509::is_p256_spki(&req.spki));
            assert_eq!(req.cns, vec!["lucid relay r_01".to_string()]);
        }
        assert!(failover_csr(&dir, &vault, org, D1, FailoverKind::Token, "x").is_err());
        assert!(failover_csr(&dir, &vault, org, D1, FailoverKind::GcpServiceAccountKey, "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_on_append_does_not_enter_failover() {
        let dir = tmp("on-fails");
        let org = "fo-on-fails";
        let s = side(&dir, org, vec![dest(D1, true)], 60);
        install_token(&dir, &s, org, D1, NOW + 10 * 86_400);
        let f = open(&dir, &s);
        f.step(NOW);
        // the audit volume below its reserve: only refusals are taken
        s.audit.set_free_space(Arc::new(|_: &Path| Some(0u64)));
        f.step(NOW + 60);
        assert_eq!(f.mode_of(org), "normal", "no failover without a durable relay.failover.on");
        assert!(!actions(&s, org).contains(&ON.to_string()));
        let t = (NOW + 61) * 1000;
        f.engine.pull_audit(t);
        f.engine.pump(t);
        assert!(s.sent.lock().is_empty(), "nothing is delivered");
        s.audit.set_free_space(Arc::new(|_: &Path| None::<u64>));
        f.step(NOW + 62);
        assert_eq!(f.mode_of(org), "failover", "the next pass tries again");
        f.engine.pull_audit(t + 2000);
        f.engine.pump(t + 2000);
        assert_eq!(delivered(&s, D1)[0]["event"], ON);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leaving_waits_for_a_durable_off_and_delivers_nothing_meanwhile() {
        let dir = tmp("off-fails");
        let org = "fo-off-fails";
        let s = side(&dir, org, vec![dest(D1, true)], 60);
        install_token(&dir, &s, org, D1, NOW + 10 * 86_400);
        let f = open(&dir, &s);
        f.step(NOW);
        f.step(NOW + 60);
        let t = (NOW + 61) * 1000;
        f.engine.pull_audit(t);
        f.engine.pump(t);
        let before = s.sent.lock().len();
        assert!(before > 0);
        s.audit.set_free_space(Arc::new(|_: &Path| Some(0u64)));
        s.up.store(true, Ordering::SeqCst);
        s.synced.store(true, Ordering::SeqCst);
        f.step(NOW + 70);
        assert_eq!(f.mode_of(org), "failover", "still failover until relay.failover.off is recorded");
        assert_eq!(mode(org), "failover");
        let st = f.engine.status(Some(org), (NOW + 70) * 1000);
        assert_eq!(st[0]["state"], "suspended", "no direct delivery while leaving");
        f.engine.pull_audit((NOW + 71) * 1000);
        assert_eq!(f.engine.pump((NOW + 71) * 1000), 0);
        assert_eq!(s.sent.lock().len(), before);
        f.step(NOW + 72);
        assert_eq!(f.mode_of(org), "failover", "tried again, still failing");
        s.audit.set_free_space(Arc::new(|_: &Path| None::<u64>));
        f.step(NOW + 73);
        assert_eq!(f.mode_of(org), "normal");
        assert_eq!(actions(&s, org).iter().filter(|a| *a == OFF).count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sa_key(email: &str, id: &str) -> String {
        json!({"type": "service_account", "project_id": "acme-prod", "private_key_id": id, "private_key": "-----BEGIN PRIVATE KEY-----\nMIIsecretsecret\n-----END PRIVATE KEY-----\n",
               "client_email": email, "token_uri": "https://oauth2.googleapis.com/token"})
        .to_string()
    }

    #[test]
    fn a_gcp_service_account_key_installs_and_reads_back() {
        let dir = tmp("gcp");
        let org = "fo-gcp";
        let vault = Mutex::new(MemVault::default());
        let key = sa_key("lucid@acme-prod.iam.gserviceaccount.com", "kid1");
        let m = json!({"type": "gcp_service_account_key", "key_json": key, "expires": NOW + 86_400});
        let meta = install_at(&dir, &vault, org, D1, m.as_object().unwrap(), NOW).unwrap();
        assert_eq!(meta, json!({"type": "gcp_service_account_key", "public_id": "lucid@acme-prod.iam.gserviceaccount.com:kid1", "not_before": NOW, "expires": NOW + 86_400}));
        match failover_credential(&dir, &vault, org, D1, NOW).unwrap() {
            Credential::GcpServiceAccountKey(k) => assert_eq!(k, key),
            _ => panic!("a service account key"),
        }
        assert!(!std::fs::read_to_string(record_path(&dir, org, D1)).unwrap().contains("secretsecret"), "the record holds nothing secret");
        let bad = |key_json: Value| {
            let m = json!({"key_json": key_json, "expires": NOW + 86_400});
            install_at(&dir, &vault, org, D2, m.as_object().unwrap(), NOW).unwrap_err()
        };
        for e in [
            bad(json!("not json at all secretsecret")),
            bad(json!(json!({"type": "authorized_user", "private_key": "secretsecret"}).to_string())),
            bad(json!(json!({"type": "service_account", "client_email": "a@b", "private_key": "secretsecret", "token_uri": "https://x"}).to_string())),
            bad(json!({"type": "service_account"})),
        ] {
            assert!(!e.contains("secretsecret"), "{e}");
        }
        assert!(armed(&dir, org, D2, NOW).is_none());
        let token_for_gcp = json!({"type": "gcp_service_account_key", "token": "abc", "expires": NOW + 86_400});
        assert!(install_at(&dir, &vault, org, D2, token_for_gcp.as_object().unwrap(), NOW).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A vault whose removals can be made to fail.
    struct Flaky {
        map: Mutex<HashMap<String, Vec<u8>>>,
        fail_remove: AtomicBool,
    }

    struct FlakyView<'a> {
        map: &'a mut HashMap<String, Vec<u8>>,
        fail_remove: bool,
    }

    impl crate::fleet_ca::Vault for FlakyView<'_> {
        fn get(&self, name: &str) -> Option<Vec<u8>> {
            self.map.get(name).cloned()
        }
        fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String> {
            self.map.insert(name.to_string(), value.to_vec());
            Ok(())
        }
        fn remove(&mut self, name: &str) -> Result<(), String> {
            if self.fail_remove {
                return Err("sealed store refused".into());
            }
            self.map.remove(name);
            Ok(())
        }
        fn usable(&self) -> bool {
            true
        }
    }

    impl VaultLock for Flaky {
        fn with_vault(&self, f: &mut dyn FnMut(&mut dyn crate::fleet_ca::Vault)) {
            let mut g = self.map.lock();
            let mut v = FlakyView { map: &mut *g, fail_remove: self.fail_remove.load(Ordering::SeqCst) };
            f(&mut v)
        }
    }

    #[test]
    fn replaced_generations_stay_listed_until_their_removal_succeeds() {
        let dir = tmp("retiring");
        let org = "fo-retiring";
        let vault = Flaky { map: Mutex::new(HashMap::new()), fail_remove: AtomicBool::new(true) };
        let token = |t: &str| json!({"token": t, "expires": NOW + 86_400});
        install_at(&dir, &vault, org, D1, token("first-token").as_object().unwrap(), NOW).unwrap();
        install_at(&dir, &vault, org, D1, token("second-token").as_object().unwrap(), NOW).unwrap();
        assert_eq!(load(&dir, org, D1).retiring, vec![1], "the replaced generation is listed");
        assert!(vault.map.lock().contains_key(&seal_name(org, D1, 1)));
        match failover_credential(&dir, &vault, org, D1, NOW).unwrap() {
            Credential::Token(t) => assert_eq!(t, "second-token"),
            _ => panic!("a token"),
        }
        vault.fail_remove.store(false, Ordering::SeqCst);
        sweep(&dir, &vault, org, D1);
        assert!(load(&dir, org, D1).retiring.is_empty());
        assert!(!vault.map.lock().contains_key(&seal_name(org, D1, 1)), "removed on the later try");
        // delete removes every listed generation, retiring ones included
        vault.fail_remove.store(true, Ordering::SeqCst);
        install_at(&dir, &vault, org, D1, token("third-token").as_object().unwrap(), NOW).unwrap();
        assert_eq!(load(&dir, org, D1).retiring, vec![2]);
        assert!(failover_delete(&dir, &vault, org, D1).is_err(), "not acknowledged while a removal fails");
        vault.fail_remove.store(false, Ordering::SeqCst);
        failover_delete(&dir, &vault, org, D1).unwrap();
        assert!(vault.map.lock().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_that_cannot_be_saved_unseals_the_new_generation() {
        let dir = tmp("unsaved");
        let org = "fo-unsaved";
        let vault = Mutex::new(MemVault::default());
        // a folder where the record goes: the write cannot replace it
        let path = record_path(&dir, org, D1);
        std::fs::create_dir_all(path.join("x")).unwrap();
        let m = json!({"token": "a-token", "expires": NOW + 86_400});
        assert!(install_at(&dir, &vault, org, D1, m.as_object().unwrap(), NOW).is_err());
        assert!(vault.lock().map.is_empty(), "nothing sealed is left that no record lists");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
