// AC-2b-D 8 (console side): the Meeting Hub organization CA a Standard console holds after an admin imports it.
// Import (8.2) with every refusal in the contract's order; the sealed key (8.3: `meet-org-ca-key`, never returned,
// logged or printed); relay server and signer client certificates from a relay's own requests (8.4); the CA's
// revocation list (8.5: content, size and pruning, dates, numbers, order, foreign lists, merge); admin revokes and
// prunes; remove (8.6). The routes, frames, audit entries and attention items that use it are console_fleet's.
//
// Files (owner-only, console role folder): `meet-ca.pem` (the CA certificate), `meet-ca.json` (2.4) and
// `meet-crl.pem` (the newest list signed). `meet-ca.json` is written before `meet-crl.pem`, so a list on disk is
// always one the record knows; a `meet-crl.pem` that does not verify, or is not the newest signed, is re-signed.
// Additions to the 2.4 record: `revoked[].notAfter` (null when unknown), `pruned[].revokedAt` (for the drop rule
// when `notAfter` is unknown) and `numberFloor` (the highest CRL number seen from an import, a merge or a
// certificate server's held list, which the next number goes above; R5-L2).

use crate::codec::{hex, parse_json, sha256, stringify};
use crate::console::ApiError;
use crate::console_seal::Provider;
use crate::fleet_ca::Vault;
use crate::fleet_wire::Redacted;
use crate::fleet_x509::{self as x509, Curve, Key, MeetProfile, MeetSpec, DAY_MS, MEET_RELAY_URI};
use crate::meet_x509::{der_to_pem, pem_blocks, Cert};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

pub const KEY_NAME: &str = "meet-org-ca-key";
pub const CA_FILE: &str = "meet-ca.pem";
pub const STATE_FILE: &str = "meet-ca.json";
pub const CRL_FILE: &str = "meet-crl.pem";

/// 8.4 and 8.5 timings.
pub const BACKDATE_MS: i64 = 5 * 60_000;
pub const SERVER_DAYS: i64 = 90;
pub const SIGNER_DAYS: i64 = 30;
pub const SIGNER_DAYS_ENFORCED: i64 = 90;
pub const RENEW_WAIT_MS: i64 = DAY_MS;
pub const CRL_DAYS: i64 = 120;
pub const CRL_RESIGN_MS: i64 = 60 * DAY_MS;
/// 8.2: a CA is imported only with at least 120 days left.
pub const CA_MIN_LEFT_MS: i64 = 120 * DAY_MS;
pub const MAX_LIFETIME_DEFAULT: i64 = 400;
pub const MAX_LIFETIME_MAX: i64 = 3650;
/// `meet-ca.json` `signed`: the last 64 lists (R3-L3).
pub const SIGNED_KEPT: usize = 64;
/// `meet-crl-size`: half the 320 KiB channel frame (R4-H1).
pub const CRL_SIZE_WARN: usize = 160 * 1024;
/// A CRL number at or above 2^150 is not outnumbered (R3-L6).
pub const NUMBER_CEILING_BITS: usize = 150;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// The 13.3 refusals this file answers with: code, status and exact words (`<...>` filled where they appear).
pub const REFUSALS: &[(&str, u16, &str)] = &[
    ("deploy-ca-needed", 409, "Import the Meeting Hub organization CA first, or bring the relay's certificate yourself."),
    ("deploy-csr", 400, "The relay's certificate request is not for <names>."),
    ("meet-cert-wait", 429, "This relay renewed its certificate less than a day ago."),
    ("meet-ca-high", 409, "Under the High profile the organization CA stays on its own signer. This console does not hold it."),
    ("meet-ca-high-relay", 409, "A High Meeting Hub relay trusts this CA, may trust it (it has not reported which CAs it trusts), or is still joining, so this console cannot hold it."),
    ("meet-ca-confirm", 400, "Confirm that no High Meeting Hub relay anywhere trusts this CA."),
    ("meet-ca-seal", 409, "Holding the organization CA needs a sealing provider bound to this host (systemd credential or Windows service account). Run lucid-relay console seal-setup --role console."),
    ("meet-ca-exists", 409, "This console already holds an organization CA. Remove it first."),
    ("meet-ca-key", 400, "That key does not belong to that CA certificate, or it is not a P-256 CA valid for 120 more days."),
    ("meet-ca-signer", 400, "Enter the certificate server as https:// and its host name."),
    ("meet-ca-in-use", 409, "<n> relays still use certificates from this CA. Confirm that you will sign its revocation lists elsewhere."),
    ("meet-ca-lost", 503, "The CA key cannot be opened. Import it again."),
    ("meet-ca-prune", 409, "That certificate was not issued by this CA, is not on the list, or has not ended yet. A revocation stays while its certificate can still be used."),
];

/// The refusal for a 13.3 code of `REFUSALS` with its placeholders filled.
pub fn refuse(code: &'static str, fills: &[(&str, &str)]) -> ApiError {
    match REFUSALS.iter().find(|(c, _, _)| *c == code) {
        Some((_, status, words)) => {
            let mut message = (*words).to_owned();
            for (k, v) in fills {
                message = message.replace(&format!("<{k}>"), v);
            }
            ApiError { status: *status, code, message, retry_after: None }
        }
        None => ApiError::of(code),
    }
}

fn write(dir: &Path, name: &str, data: &[u8]) -> Result<(), String> {
    crate::store::write_private(&dir.join(name), data).map_err(|e| format!("{name} could not be written: {e}"))
}

// ── Numbers and order (8.5) ─────────────────────────────────────────────────────────────────────────────────

/// A CRL number: big-endian without leading zeros (empty is 0). Foreign numbers may take 20 octets, so it is not
/// a machine integer. In JSON: a number up to 2^53 - 1, else its decimal digits as a string.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct CrlNumber(Vec<u8>);

impl CrlNumber {
    pub fn from_bytes(b: &[u8]) -> CrlNumber {
        CrlNumber(b[b.iter().position(|x| *x != 0).unwrap_or(b.len())..].to_vec())
    }

    pub fn from_u64(n: u64) -> CrlNumber {
        CrlNumber::from_bytes(&n.to_be_bytes())
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }

    fn bits(&self) -> usize {
        self.0.first().map_or(0, |b| (self.0.len() - 1) * 8 + (8 - b.leading_zeros() as usize))
    }

    /// At or above 2^150: a foreign list that cannot be safely outnumbered within 20 octets (R3-L6).
    pub fn at_ceiling(&self) -> bool {
        self.bits() > NUMBER_CEILING_BITS
    }

    /// One more.
    pub fn next(&self) -> CrlNumber {
        let mut v = self.0.clone();
        for b in v.iter_mut().rev() {
            if *b == 0xff {
                *b = 0;
            } else {
                *b += 1;
                return CrlNumber(v);
            }
        }
        v.insert(0, 1);
        CrlNumber(v)
    }

    fn as_u64(&self) -> Option<u64> {
        (self.0.len() <= 8).then(|| self.0.iter().fold(0u64, |a, b| (a << 8) | u64::from(*b)))
    }

    /// A JSON integer, or a string of decimal digits (a relay's `meetCrl.number`, `signerHeld.number`).
    pub fn from_json(v: &Value) -> Option<CrlNumber> {
        match v {
            Value::Number(n) => n.as_u64().map(CrlNumber::from_u64),
            Value::String(s) if !s.is_empty() && s.len() <= 60 && s.bytes().all(|b| b.is_ascii_digit()) => {
                let mut out: Vec<u8> = Vec::new();
                for d in s.bytes() {
                    let mut carry = u32::from(d - b'0');
                    for b in out.iter_mut().rev() {
                        let x = u32::from(*b) * 10 + carry;
                        *b = (x & 0xff) as u8;
                        carry = x >> 8;
                    }
                    while carry > 0 {
                        out.insert(0, (carry & 0xff) as u8);
                        carry >>= 8;
                    }
                }
                Some(CrlNumber::from_bytes(&out))
            }
            _ => None,
        }
    }

    pub fn to_json(&self) -> Value {
        match self.as_u64().filter(|n| *n <= MAX_SAFE) {
            Some(n) => Value::from(n),
            None => Value::from(self.to_string()),
        }
    }
}

impl Ord for CrlNumber {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.len().cmp(&other.0.len()).then_with(|| self.0.cmp(&other.0))
    }
}

impl PartialOrd for CrlNumber {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl std::fmt::Display for CrlNumber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut digits = Vec::new();
        let mut n = self.0.clone();
        while !n.is_empty() {
            let mut rem = 0u32;
            for b in n.iter_mut() {
                let x = (rem << 8) | u32::from(*b);
                *b = (x / 10) as u8;
                rem = x % 10;
            }
            digits.push(b'0' + rem as u8);
            n = CrlNumber::from_bytes(&n).0;
        }
        if digits.is_empty() {
            digits.push(b'0');
        }
        digits.reverse();
        f.write_str(std::str::from_utf8(&digits).unwrap_or("0"))
    }
}

/// The 8.5 order between two lists of this CA: the later `thisUpdate` wins; at equal `thisUpdate` the higher CRL
/// number wins when both carry one. `Greater` means `a` is the later list.
pub fn later(a: (i64, Option<&CrlNumber>), b: (i64, Option<&CrlNumber>)) -> Ordering {
    a.0.cmp(&b.0).then_with(|| match (a.1, b.1) {
        (Some(x), Some(y)) => x.cmp(y),
        _ => Ordering::Equal,
    })
}

/// A list on its reader's own clock (8.5, R3-M1; `check_one` has zero tolerance).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ListTime {
    /// Its `thisUpdate` has passed: it may be in force.
    Current,
    /// At most 5 minutes ahead: it waits as pending.
    Pending,
    /// More than 5 minutes ahead: refused.
    Future,
}

pub fn list_time(this_update_ms: i64, reader_now_ms: i64) -> ListTime {
    if this_update_ms <= reader_now_ms {
        ListTime::Current
    } else if this_update_ms - reader_now_ms <= BACKDATE_MS {
        ListTime::Pending
    } else {
        ListTime::Future
    }
}

// ── Records (2.4 `meet-ca.json`) ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CaState {
    Ok,
    /// The sealed key cannot be opened or is not the CA's (`meet-ca-lost`): no issuing, no list.
    Lost,
    /// The CA records do not read back (`meet-ca-unreadable`): nothing is issued or pushed.
    Unreadable,
}

impl CaState {
    pub fn as_str(self) -> &'static str {
        match self {
            CaState::Ok => "ok",
            CaState::Lost => "lost",
            CaState::Unreadable => "unreadable",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CertKind {
    Server,
    SignerClient,
    /// API-1 9.3: an org's audit checkpoint key (`issue_checkpoint`); the row's `relay_id` is its holder, `console`
    /// or a relay id.
    Checkpoint,
}

impl CertKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CertKind::Server => "server",
            CertKind::SignerClient => "signer-client",
            CertKind::Checkpoint => "checkpoint",
        }
    }

    pub fn parse(s: &str) -> Option<CertKind> {
        match s {
            "server" => Some(CertKind::Server),
            "signer-client" => Some(CertKind::SignerClient),
            "checkpoint" => Some(CertKind::Checkpoint),
            _ => None,
        }
    }
}

/// API-1 9.3: an audit checkpoint certificate lasts a year (never past the CA's end).
pub const CHECKPOINT_DAYS: i64 = 365;
/// The common name of an audit checkpoint certificate (its org is the O attribute and the SAN URI).
pub const CHECKPOINT_CN: &str = "Lucid API audit checkpoint";
const OID_BC: &[u8] = &[0x55, 0x1d, 0x13];
const OID_KU: &[u8] = &[0x55, 0x1d, 0x0f];
const OID_SAN: &[u8] = &[0x55, 0x1d, 0x11];
const OID_SKI: &[u8] = &[0x55, 0x1d, 0x0e];
const OID_AKI: &[u8] = &[0x55, 0x1d, 0x23];
const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];

/// The SAN URI of an org's audit checkpoint certificate.
pub fn checkpoint_uri(org: &str) -> String {
    format!("urn:lucid-meet:org:{org}")
}

fn seq_of(parts: &[Vec<u8>]) -> Vec<u8> {
    x509::der(0x30, &parts.concat())
}

fn ext_of(o: &[u8], critical: bool, value: Vec<u8>) -> Vec<u8> {
    let mut parts = vec![x509::der(0x06, o)];
    if critical {
        parts.push(x509::der(0x01, &[0xff]));
    }
    parts.push(x509::der(0x04, &value));
    seq_of(&parts)
}

/// The TBSCertificate of an audit checkpoint certificate: `CN=Lucid API audit checkpoint, O=<org>`, CA false and
/// digitalSignature only (both critical), SAN URI `urn:lucid-meet:org:<org>`, no extendedKeyUsage, key ids.
fn checkpoint_tbs(ca_der: &[u8], org: &str, serial: &[u8], not_before_ms: i64, not_after_ms: i64, spki: &[u8]) -> Result<Vec<u8>, String> {
    let ca = Cert::from_der(ca_der).ok_or("the CA certificate does not read")?;
    let aki = x509::authority_key_id(&ca).ok_or("the CA key is not an EC key")?;
    let ski = x509::key_id(spki).ok_or("the checkpoint key is not an EC key")?;
    let exts = [
        ext_of(OID_BC, true, seq_of(&[])),
        ext_of(OID_KU, true, x509::der(0x03, &[7, 0x80])),
        ext_of(OID_SAN, false, seq_of(&[x509::der(0x86, checkpoint_uri(org).as_bytes())])),
        ext_of(OID_SKI, false, x509::der(0x04, &ski)),
        ext_of(OID_AKI, false, seq_of(&[x509::der(0x80, &aki)])),
    ];
    Ok(seq_of(&[
        x509::der(0xa0, &x509::der(0x02, &[2])),
        x509::integer(serial),
        seq_of(&[x509::der(0x06, OID_ECDSA_SHA256)]),
        ca.subject.clone(),
        seq_of(&[x509::time(not_before_ms), x509::time(not_after_ms)]),
        x509::name(&[(x509::OID_CN, CHECKPOINT_CN), (x509::OID_O, org)]),
        spki.to_vec(),
        x509::der(0xa3, &seq_of(&exts)),
    ]))
}

/// Check an audit checkpoint certificate (9.3): it reads, the CA signed it directly, it is in date at `at_ms`, CA
/// false and digitalSignature only (both critical), no extendedKeyUsage, and its only name is the org's SAN URI.
pub fn checkpoint_check(cert_der: &[u8], org: &str, ca_der: &[u8], at_ms: i64) -> Result<Cert, String> {
    let bad = |why: &str| Err(format!("the checkpoint certificate is wrong: {why}"));
    let Some(cert) = Cert::from_der(cert_der) else { return bad("it does not read") };
    let Some(ca) = Cert::from_der(ca_der) else { return bad("the CA does not read") };
    let (Some(u), Some(san)) = (x509::usage(cert_der), x509::cert_san(cert_der)) else { return bad("its extensions do not read") };
    if !cert.issued_directly_by_root(&ca) {
        return bad("the CA did not sign it");
    }
    if !x509::in_date(&cert, at_ms) {
        return bad("it is not in date");
    }
    let ok = !u.ca && u.bc_critical && u.key_usage == Some(0x80) && u.ku_critical && u.eku.is_none() && san.names.is_empty() && san.other == 0 && san.uris == [checkpoint_uri(org)];
    if ok {
        Ok(cert)
    } else {
        bad("its usages do not match the checkpoint profile")
    }
}

/// One certificate the console issued (`issued`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub serial: String,
    pub relay_id: String,
    pub kind: CertKind,
    pub names: Vec<String>,
    pub not_before: i64,
    pub not_after: i64,
    pub revoked_at: Option<i64>,
}

/// One entry of the list (`revoked`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revoked {
    pub serial: String,
    pub at: i64,
    pub from: String,
    /// The revoked certificate's end, when the console knows it.
    pub not_after: Option<i64>,
}

/// An entry that left the list (`pruned`; R5-L1): never merged back while recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pruned {
    pub serial: String,
    pub not_after: Option<i64>,
    pub revoked_at: i64,
    pub at: i64,
    /// `expiry`, `max-lifetime` or the admin.
    pub by: String,
}

/// A list the console signed (`signed`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedList {
    pub number: CrlNumber,
    pub this_update: i64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diverged {
    pub relay_id: String,
    pub this_update: i64,
    pub at: i64,
}

#[derive(Clone, Debug, Default)]
struct State {
    id: String,
    imported_at: i64,
    imported_by: String,
    signer_url: Option<String>,
    signer_enforced: bool,
    issued: Vec<Row>,
    revoked: Vec<Revoked>,
    /// (number, thisUpdate, nextUpdate) of the newest list signed.
    crl: Option<(CrlNumber, i64, i64)>,
    signed: Vec<SignedList>,
    max_lifetime_days: i64,
    pruned: Vec<Pruned>,
    diverged: Option<Diverged>,
    floor: CrlNumber,
}

fn opt_i64(v: Option<&Value>) -> Option<Option<i64>> {
    match v {
        None | Some(Value::Null) => Some(None),
        Some(n) => n.as_i64().map(Some),
    }
}

fn str_list(v: &Value) -> Option<Vec<String>> {
    v.as_array()?.iter().map(|s| s.as_str().map(str::to_owned)).collect()
}

impl State {
    fn to_json(&self) -> Value {
        json!({
            "v": 1,
            "id": self.id,
            "source": "imported",
            "importedAt": self.imported_at,
            "importedBy": self.imported_by,
            "signerUrl": self.signer_url,
            "signerEnforced": self.signer_enforced,
            "issued": self.issued.iter().map(|r| json!({ "serial": r.serial, "relayId": r.relay_id, "kind": r.kind.as_str(), "names": r.names, "notBefore": r.not_before, "notAfter": r.not_after, "revokedAt": r.revoked_at })).collect::<Vec<_>>(),
            "revoked": self.revoked.iter().map(|r| json!({ "serial": r.serial, "at": r.at, "from": r.from, "notAfter": r.not_after })).collect::<Vec<_>>(),
            "crl": self.crl.as_ref().map(|(n, tu, nu)| json!({ "number": n.to_json(), "thisUpdate": tu, "nextUpdate": nu })),
            "signed": self.signed.iter().map(|s| json!({ "number": s.number.to_json(), "thisUpdate": s.this_update, "sha256": s.sha256 })).collect::<Vec<_>>(),
            "maxLifetimeDays": self.max_lifetime_days,
            "pruned": self.pruned.iter().map(|p| json!({ "serial": p.serial, "notAfter": p.not_after, "revokedAt": p.revoked_at, "at": p.at, "by": p.by })).collect::<Vec<_>>(),
            "diverged": self.diverged.as_ref().map(|d| json!({ "relayId": d.relay_id, "thisUpdate": d.this_update, "at": d.at })),
            "numberFloor": self.floor.to_json(),
        })
    }

    fn from_json(v: &Value) -> Option<State> {
        if v.get("v")?.as_u64()? != 1 || v.get("source")?.as_str()? != "imported" {
            return None;
        }
        let mut issued = Vec::new();
        for r in v.get("issued")?.as_array()? {
            issued.push(Row {
                serial: r.get("serial")?.as_str()?.to_owned(),
                relay_id: r.get("relayId")?.as_str()?.to_owned(),
                kind: CertKind::parse(r.get("kind")?.as_str()?)?,
                names: str_list(r.get("names")?)?,
                not_before: r.get("notBefore")?.as_i64()?,
                not_after: r.get("notAfter")?.as_i64()?,
                revoked_at: opt_i64(r.get("revokedAt"))?,
            });
        }
        let mut revoked = Vec::new();
        for r in v.get("revoked")?.as_array()? {
            revoked.push(Revoked { serial: r.get("serial")?.as_str()?.to_owned(), at: r.get("at")?.as_i64()?, from: r.get("from")?.as_str()?.to_owned(), not_after: opt_i64(r.get("notAfter"))? });
        }
        let crl = match v.get("crl")? {
            Value::Null => None,
            c => Some((CrlNumber::from_json(c.get("number")?)?, c.get("thisUpdate")?.as_i64()?, c.get("nextUpdate")?.as_i64()?)),
        };
        let mut signed = Vec::new();
        for s in v.get("signed")?.as_array()? {
            signed.push(SignedList { number: CrlNumber::from_json(s.get("number")?)?, this_update: s.get("thisUpdate")?.as_i64()?, sha256: s.get("sha256")?.as_str()?.to_owned() });
        }
        let mut pruned = Vec::new();
        for p in v.get("pruned")?.as_array()? {
            pruned.push(Pruned { serial: p.get("serial")?.as_str()?.to_owned(), not_after: opt_i64(p.get("notAfter"))?, revoked_at: p.get("revokedAt")?.as_i64()?, at: p.get("at")?.as_i64()?, by: p.get("by")?.as_str()?.to_owned() });
        }
        let diverged = match v.get("diverged")? {
            Value::Null => None,
            d => Some(Diverged { relay_id: d.get("relayId")?.as_str()?.to_owned(), this_update: d.get("thisUpdate")?.as_i64()?, at: d.get("at")?.as_i64()? }),
        };
        let signer_url = match v.get("signerUrl")? {
            Value::Null => None,
            s => Some(s.as_str()?.to_owned()),
        };
        Some(State {
            id: v.get("id")?.as_str()?.to_owned(),
            imported_at: v.get("importedAt")?.as_i64()?,
            imported_by: v.get("importedBy")?.as_str()?.to_owned(),
            signer_url,
            signer_enforced: v.get("signerEnforced")?.as_bool()?,
            issued,
            revoked,
            crl,
            signed,
            max_lifetime_days: v.get("maxLifetimeDays")?.as_i64().filter(|d| (1..=MAX_LIFETIME_MAX).contains(d))?,
            pruned,
            diverged,
            floor: CrlNumber::from_json(v.get("numberFloor")?)?,
        })
    }
}

// ── Answers ─────────────────────────────────────────────────────────────────────────────────────────────────

/// The newest list's facts (9.1 `crl`, 9.3 `meetCrl`, the `fleet.meet-ca.crl` audit detail).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrlInfo {
    pub number: CrlNumber,
    pub this_update: i64,
    pub next_update: i64,
    /// SHA-256 of the DER, lowercase hex.
    pub sha256: String,
    pub revoked: usize,
    /// The DER's length (`meet-crl-size` past `CRL_SIZE_WARN`).
    pub size: usize,
}

/// A certificate issued from a relay's request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issued {
    pub pem: String,
    pub der: Vec<u8>,
    pub serial: String,
    /// ms
    pub not_after: i64,
    pub names: Vec<String>,
}

/// What a merge of another list did (8.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Merge {
    pub added: usize,
    /// The foreign list's `thisUpdate` when it is ahead of the console's clock, or when its number is at the ceiling
    /// (`meet-crl-future`, with `meet-ca.crl-number-ceiling` when `ceiling`).
    pub future: Option<i64>,
    pub ceiling: bool,
    /// The console's new list, when it signed one.
    pub signed: Option<CrlInfo>,
}

/// Every enrolled Meeting Hub relay with `profile: high` (8.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighRelay {
    pub relay_id: String,
    pub pending: bool,
    /// None: unknown (offline since before reporting, or an older version).
    pub meet_roots: Option<Vec<String>>,
}

/// What the import refusals depend on that this file cannot see.
pub struct ImportCtx<'a> {
    pub high: bool,
    /// The console seal's provider (None when nothing unseals).
    pub provider: Option<Provider>,
    pub high_relays: &'a [HighRelay],
}

/// The 8.2 import body. The key is redacted from every `Debug` and dropped after sealing.
#[derive(Debug)]
pub struct ImportReq {
    pub ca_pem: String,
    pub key_pem: Redacted<String>,
    pub issued_json: Option<String>,
    pub crl_pem: Option<String>,
    pub signer_url: Option<String>,
    pub no_high_relay: bool,
    /// None: 400.
    pub max_lifetime_days: Option<i64>,
}

/// What an import kept and saw (audit `revokedKept`; `meet-crl-future` for an imported list dated ahead).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Imported {
    pub revoked_kept: usize,
    pub future: Option<i64>,
    pub ceiling: bool,
}

/// The final list of a removal (8.6), to push, and the date it ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Removed {
    pub crl_pem: String,
    pub ends: i64,
}

// ── Import checks (8.2) ─────────────────────────────────────────────────────────────────────────────────────

/// Self-signed, CA true with keyCertSign and cRLSign, pathLen 0, 1 or absent, P-256, valid for at least 120 more
/// days.
fn ca_usable(ca_der: &[u8], ca: &Cert, t: i64) -> bool {
    let Some(u) = x509::usage(ca_der) else { return false };
    ca.issued_by(ca)
        && u.ca
        && u.key_usage.unwrap_or(0) & 0x06 == 0x06
        && matches!(u.path_len, None | Some(0) | Some(1))
        && x509::is_p256_spki(&ca.spki)
        && ca.not_after * 1000 - t >= CA_MIN_LEFT_MS
}

/// The same EC key: equal points.
fn same_key(a: &[u8], b: &[u8]) -> bool {
    matches!((x509::key_id(a), x509::key_id(b)), (Some(x), Some(y)) if x == y)
}

/// An unencrypted PKCS#8 or SEC1 `EC PRIVATE KEY` PEM as a P-256 key.
fn import_key(pem: &str) -> Option<Key> {
    let der = pem_blocks(pem.as_bytes(), "PRIVATE KEY").into_iter().chain(pem_blocks(pem.as_bytes(), "EC PRIVATE KEY")).next()?.1;
    Key::from_private_der(Curve::P256, &der).ok()
}

/// An `https://` URL with a host (and digits for a port).
fn signer_url_ok(u: &str) -> bool {
    let Some(rest) = u.strip_prefix("https://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, port) = match authority.strip_prefix('[') {
        Some(h) => match h.split_once(']') {
            Some((host, after)) => (host, after.strip_prefix(':')),
            None => return false,
        },
        None => match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    !host.is_empty()
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        && port.is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
        && !u.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// A serial as `meet_x509` prints it (lowercase hex without leading zeros, at most 20 octets), or None.
fn norm_serial(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    if s.is_empty() || s.len() > 40 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let t = s.trim_start_matches('0');
    (!t.is_empty()).then(|| t.to_owned())
}

fn iso_ms(s: &str) -> Option<i64> {
    crate::meet_json::from_iso(s).filter(|f| f.is_finite()).map(|f| (f * 1000.0).floor() as i64)
}

/// (serial, revoked at, notAfter) of the revoked rows, and (serial, notAfter) of every row that has one.
type IssuedRows = (Vec<(String, i64, Option<i64>)>, Vec<(String, i64)>);

/// `issued.json` rows (meet_pki `index_row`): every row marked revoked (one with no `revoked_at` counts as revoked
/// at `t`) and the known `notAfter` of every row. None when it does not read.
fn issued_rows(text: &str, t: i64) -> Option<IssuedRows> {
    let (mut revoked, mut ends) = (Vec::new(), Vec::new());
    for r in parse_json(text)?.as_array()? {
        let serial = norm_serial(r.get("serial")?.as_str()?)?;
        let not_after = match r.get("not_after") {
            None | Some(Value::Null) => None,
            Some(v) => Some(iso_ms(v.as_str()?)?),
        };
        if let Some(na) = not_after {
            ends.push((serial.clone(), na));
        }
        if r.get("revoked").and_then(Value::as_bool) == Some(true) {
            let at = match r.get("revoked_at") {
                None | Some(Value::Null) => t,
                Some(v) => iso_ms(v.as_str()?)?,
            };
            revoked.push((serial, at, not_after));
        }
    }
    Some((revoked, ends))
}

/// A list of this CA from elsewhere, read and verified: issued by the CA's name, signed by its key.
fn foreign(ca_der: &[u8], der: &[u8]) -> Option<x509::CrlRead> {
    let ca = Cert::from_der(ca_der)?;
    let crl = crate::meet_x509::Crl::from_der(der)?;
    if crl.issuer != ca.subject || !crl.signature_valid(&ca.spki) {
        return None;
    }
    x509::read_crl(der)
}

/// The CA's sealed key, when it opens and is the CA's.
fn ca_key_of(vault: &dyn Vault, ca_der: &[u8]) -> Option<Key> {
    if !vault.usable() {
        return None;
    }
    let key = Key::from_pkcs8(Curve::P256, &vault.get(KEY_NAME)?).ok()?;
    let ca = Cert::from_der(ca_der)?;
    same_key(&key.spki(), &ca.spki).then_some(key)
}

/// A CA name as `Name.rfc4514_string()` prints the attributes a CA carries.
fn subject_text(c: &Cert) -> String {
    let short = |o: &[u8]| match o {
        [0x55, 0x04, 0x03] => Some("CN"),
        [0x55, 0x04, 0x0a] => Some("O"),
        [0x55, 0x04, 0x0b] => Some("OU"),
        [0x55, 0x04, 0x06] => Some("C"),
        [0x55, 0x04, 0x07] => Some("L"),
        [0x55, 0x04, 0x08] => Some("ST"),
        _ => None,
    };
    c.names.subject.iter().rev().filter_map(|(o, v)| short(o.as_slice()).map(|k| format!("{k}={v}"))).collect::<Vec<_>>().join(",")
}

// ── The CA ──────────────────────────────────────────────────────────────────────────────────────────────────

pub struct MeetCa {
    dir: PathBuf,
    state: CaState,
    ca_der: Vec<u8>,
    s: State,
    crl_der: Vec<u8>,
    /// A re-sign is owed: the list on disk is missing or not the newest signed, or a write of it failed.
    owed: bool,
}

impl std::fmt::Debug for MeetCa {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MeetCa({}, {:?}, {} issued, {} revoked)", self.id(), self.state, self.s.issued.len(), self.s.revoked.len())
    }
}

impl MeetCa {
    /// Open the held CA at start, or None when no CA is held. The records failing to read back give `Unreadable`;
    /// a sealed key that does not open (or is not the CA's) gives `Lost`. Every file is kept as it is.
    pub fn open(dir: &Path, vault: &dyn Vault) -> Option<MeetCa> {
        if !dir.join(STATE_FILE).exists() && !dir.join(CA_FILE).exists() {
            return None;
        }
        let mut ca = MeetCa { dir: dir.to_owned(), state: CaState::Unreadable, ca_der: Vec::new(), s: State::default(), crl_der: Vec::new(), owed: true };
        let ca_der = std::fs::read(dir.join(CA_FILE)).ok().and_then(|p| pem_blocks(&p, "CERTIFICATE").into_iter().next()).map(|(_, d)| d);
        let Some((ca_der, cert)) = ca_der.and_then(|d| Cert::from_der(&d).map(|c| (d, c))) else { return Some(ca) };
        ca.ca_der = ca_der;
        let state = std::fs::read_to_string(dir.join(STATE_FILE)).ok().and_then(|t| parse_json(&t)).and_then(|v| State::from_json(&v));
        let Some(s) = state.filter(|s| s.id == crate::license::meet_root_id(&cert.spki)) else { return Some(ca) };
        ca.s = s;
        let on_disk = std::fs::read(dir.join(CRL_FILE)).ok().and_then(|p| pem_blocks(&p, "X509 CRL").into_iter().next()).map(|(_, d)| d);
        if let Some(der) = on_disk {
            let digest = hex(&sha256(&der));
            if foreign(&ca.ca_der, &der).is_some() && ca.s.signed.last().is_some_and(|x| x.sha256 == digest) {
                ca.crl_der = der;
                ca.owed = false;
            }
        }
        ca.state = if ca_key_of(vault, &ca.ca_der).is_some() { CaState::Ok } else { CaState::Lost };
        Some(ca)
    }

    /// `POST fleet/meet-ca/import` (8.2): every refusal in the contract's order, then the key sealed as
    /// `meet-org-ca-key`, the kept revocations (revoked `issued.json` rows; the entries and number of `crlPem`), the
    /// first list signed, and the files written. Nothing is kept when any step fails.
    pub fn import(dir: &Path, vault: &mut dyn Vault, ctx: &ImportCtx, req: ImportReq, by: &str, t: i64) -> Result<(MeetCa, Imported), ApiError> {
        if ctx.high {
            return Err(refuse("meet-ca-high", &[]));
        }
        if !matches!(ctx.provider, Some(Provider::SystemdCredential | Provider::DpapiService)) || !vault.usable() {
            return Err(refuse("meet-ca-seal", &[]));
        }
        if dir.join(STATE_FILE).exists() || dir.join(CA_FILE).exists() {
            return Err(refuse("meet-ca-exists", &[]));
        }
        let ca_der = pem_blocks(req.ca_pem.as_bytes(), "CERTIFICATE").into_iter().next().map(|(_, d)| d).unwrap_or_default();
        let cert = Cert::from_der(&ca_der);
        let id = cert.as_ref().map(|c| crate::license::meet_root_id(&c.spki));
        let trusts = |r: &HighRelay| {
            r.pending
                || match &r.meet_roots {
                    None => true,
                    Some(roots) => id.as_ref().is_some_and(|id| roots.iter().any(|x| x == id)),
                }
        };
        if ctx.high_relays.iter().any(trusts) {
            return Err(refuse("meet-ca-high-relay", &[]));
        }
        if !req.no_high_relay {
            return Err(refuse("meet-ca-confirm", &[]));
        }
        let key_refused = || refuse("meet-ca-key", &[]);
        let (Some(cert), Some(id)) = (cert, id) else { return Err(key_refused()) };
        if !ca_usable(&ca_der, &cert, t) {
            return Err(key_refused());
        }
        let key = import_key(req.key_pem.expose()).filter(|k| same_key(&k.spki(), &cert.spki)).ok_or_else(key_refused)?;
        let signer_url = match req.signer_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None => None,
            Some(u) if signer_url_ok(u) => Some(u.to_owned()),
            Some(_) => return Err(refuse("meet-ca-signer", &[])),
        };
        let max_lifetime_days = req.max_lifetime_days.unwrap_or(MAX_LIFETIME_DEFAULT);
        if !(1..=MAX_LIFETIME_MAX).contains(&max_lifetime_days) {
            return Err(ApiError::of("invalid"));
        }
        let s = State { id, imported_at: t, imported_by: by.to_owned(), signer_url, max_lifetime_days, ..State::default() };
        let mut ca = MeetCa { dir: dir.to_owned(), state: CaState::Ok, ca_der, s, crl_der: Vec::new(), owed: false };
        let mut note = Imported { revoked_kept: 0, future: None, ceiling: false };
        let (rows, ends) = match req.issued_json.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(text) => issued_rows(text, t).ok_or_else(|| ApiError::of("invalid"))?,
            None => (Vec::new(), Vec::new()),
        };
        ca.take(&rows, "import", t);
        if let Some(text) = req.crl_pem.as_deref().filter(|s| !s.trim().is_empty()) {
            let der = pem_blocks(text.as_bytes(), "X509 CRL").into_iter().next().map(|(_, d)| d).unwrap_or_default();
            let read = foreign(&ca.ca_der, &der).ok_or_else(|| ApiError::of("invalid"))?;
            let number = read.number.as_deref().map(CrlNumber::from_bytes);
            if number.as_ref().is_some_and(CrlNumber::at_ceiling) {
                note.ceiling = true;
                note.future = Some(read.this_update_ms);
            } else {
                let known = |s: &str| ends.iter().find(|(e, _)| e == s).map(|(_, na)| *na);
                let entries: Vec<_> = read.entries.iter().map(|(s, at)| (s.clone(), *at, known(s.as_str()))).collect();
                ca.take(&entries, "import", t);
                ca.s.floor = number.unwrap_or_default();
                note.future = (read.this_update_ms > t).then_some(read.this_update_ms);
            }
        }
        note.revoked_kept = ca.s.revoked.len();
        ca.sign_list(&key, t, None).map_err(|_| ApiError::of("write-failed"))?;
        vault.put(KEY_NAME, key.pkcs8()).map_err(|_| refuse("meet-ca-seal", &[]))?;
        drop(key);
        // The record and the list first, the CA certificate last; any failure removes all of them and the key.
        let written = write(dir, STATE_FILE, stringify(&ca.s.to_json()).as_bytes())
            .and_then(|()| write(dir, CRL_FILE, x509::crl_pem(&ca.crl_der).as_bytes()))
            .and_then(|()| write(dir, CA_FILE, der_to_pem(&ca.ca_der).as_bytes()));
        if written.is_err() {
            for f in [STATE_FILE, CRL_FILE, CA_FILE] {
                crate::store::remove(&dir.join(f));
            }
            let _ = vault.remove(KEY_NAME);
            return Err(ApiError::of("write-failed"));
        }
        Ok((ca, note))
    }

    pub fn state(&self) -> CaState {
        self.state
    }

    /// The CA id (`m_` and 32 hex of SHA-256 of its SubjectPublicKeyInfo).
    pub fn id(&self) -> &str {
        &self.s.id
    }

    pub fn ca_der(&self) -> &[u8] {
        &self.ca_der
    }

    pub fn ca_pem(&self) -> String {
        der_to_pem(&self.ca_der)
    }

    pub fn signer_url(&self) -> Option<&str> {
        self.s.signer_url.as_deref()
    }

    pub fn signer_enforced(&self) -> bool {
        self.s.signer_enforced
    }

    pub fn max_lifetime_days(&self) -> i64 {
        self.s.max_lifetime_days
    }

    pub fn rows(&self) -> &[Row] {
        &self.s.issued
    }

    /// Whole days until the CA certificate ends (`meet-ca-expiring` at 365).
    pub fn ca_days_left(&self, t: i64) -> i64 {
        Cert::from_der(&self.ca_der).map(|c| (c.not_after * 1000 - t).div_euclid(DAY_MS)).unwrap_or(0)
    }

    /// The signed list is past `CRL_SIZE_WARN` (`meet-crl-size`).
    pub fn size_warning(&self) -> bool {
        self.crl_der.len() > CRL_SIZE_WARN
    }

    fn key(&self, vault: &dyn Vault) -> Result<Key, ApiError> {
        if self.state == CaState::Unreadable {
            return Err(ApiError::of("state-unreadable"));
        }
        ca_key_of(vault, &self.ca_der).ok_or_else(|| refuse("meet-ca-lost", &[]))
    }

    fn row(&self, serial: &str) -> Option<&Row> {
        self.s.issued.iter().find(|r| r.serial == serial)
    }

    fn info(&self) -> Option<CrlInfo> {
        let (number, this_update, next_update) = self.s.crl.clone()?;
        (!self.crl_der.is_empty()).then(|| CrlInfo { number, this_update, next_update, sha256: hex(&sha256(&self.crl_der)), revoked: self.s.revoked.len(), size: self.crl_der.len() })
    }

    /// Run `f` on the record and keep its changes only once `meet-ca.json` is written (nothing changes on a failed
    /// write). A failed `meet-crl.pem` write leaves the list owed: the record already knows it. Records that did not
    /// read back are never overwritten.
    fn change<R>(&mut self, f: impl FnOnce(&mut MeetCa) -> Result<R, ApiError>) -> Result<R, ApiError> {
        if self.state == CaState::Unreadable {
            return Err(ApiError::of("state-unreadable"));
        }
        let before = (self.s.clone(), self.crl_der.clone(), self.owed);
        let out = f(&mut *self).and_then(|r| write(&self.dir, STATE_FILE, stringify(&self.s.to_json()).as_bytes()).map(|()| r).map_err(|_| ApiError::of("write-failed")));
        match out {
            Ok(r) => {
                if !self.crl_der.is_empty() && self.crl_der != before.1 && write(&self.dir, CRL_FILE, x509::crl_pem(&self.crl_der).as_bytes()).is_err() {
                    self.owed = true;
                }
                Ok(r)
            }
            Err(e) => {
                (self.s, self.crl_der, self.owed) = before;
                Err(e)
            }
        }
    }

    // ── The list (8.5) ──────────────────────────────────────────────────────────────────────────────────────

    /// Put a serial on the list (signed by the next `sign_list`). False when it is already there.
    fn add_revoked(&mut self, serial: &str, at: i64, from: &str, not_after: Option<i64>) -> bool {
        if self.s.revoked.iter().any(|r| r.serial == serial) {
            return false;
        }
        let not_after = not_after.or_else(|| self.row(serial).map(|r| r.not_after));
        self.s.pruned.retain(|p| p.serial != serial);
        self.s.revoked.push(Revoked { serial: serial.to_owned(), at, from: from.to_owned(), not_after });
        for r in self.s.issued.iter_mut().filter(|r| r.serial == serial && r.revoked_at.is_none()) {
            r.revoked_at = Some(at);
        }
        true
    }

    /// The entries of another list or of `issued.json` this record takes (R5-L1): not already listed, never a
    /// serial in `pruned`, nor one whose known `notAfter` has passed, nor one revoked more than `maxLifetimeDays`
    /// ago. A revocation date ahead of the console's clock is taken as now. The count taken.
    fn take(&mut self, entries: &[(String, i64, Option<i64>)], from: &str, t: i64) -> usize {
        let horizon = t - self.s.max_lifetime_days * DAY_MS;
        let mut added = 0;
        for (serial, at, not_after) in entries {
            let Some(serial) = norm_serial(serial) else { continue };
            let at = (*at).min(t);
            let known = not_after.or_else(|| self.row(&serial).map(|r| r.not_after));
            if self.s.pruned.iter().any(|p| p.serial == serial) || known.is_some_and(|na| na < t) || at < horizon {
                continue;
            }
            if self.add_revoked(&serial, at, from, known) {
                added += 1;
            }
        }
        added
    }

    /// Entries leave at a re-sign (R4-H1, R5-M2): once their known `notAfter` has passed (`expiry`), or, with no
    /// known `notAfter`, once revoked more than `maxLifetimeDays` ago (`max-lifetime`). A `pruned` record goes once
    /// its `notAfter` (or revocation date) is older than `maxLifetimeDays`, judged before this re-sign's removals are
    /// recorded, so every removal is recorded at least until the next re-sign.
    fn prune_due(&mut self, t: i64) {
        let horizon = t - self.s.max_lifetime_days * DAY_MS;
        self.s.pruned.retain(|p| p.not_after.unwrap_or(p.revoked_at) >= horizon);
        let issued = &self.s.issued;
        let mut kept = Vec::new();
        for r in std::mem::take(&mut self.s.revoked) {
            let not_after = r.not_after.or_else(|| issued.iter().find(|i| i.serial == r.serial).map(|i| i.not_after));
            let by = match not_after {
                Some(na) if na < t => Some("expiry"),
                None if r.at < horizon => Some("max-lifetime"),
                _ => None,
            };
            match by {
                Some(by) => self.s.pruned.push(Pruned { serial: r.serial, not_after, revoked_at: r.at, at: t, by: by.to_owned() }),
                None => kept.push(r),
            }
        }
        self.s.revoked = kept;
    }

    /// Sign the next list into memory (8.5): due entries leave first; `thisUpdate = max(now - 5 minutes, the last
    /// thisUpdate signed + 1 second)` and never after now; the number one above the last signed and the floor;
    /// `nextUpdate` 120 days after `thisUpdate`, or `ends` when later (8.6).
    fn sign_list(&mut self, key: &Key, t: i64, ends: Option<i64>) -> Result<CrlInfo, String> {
        self.prune_due(t);
        // Entries in revocation-date order, then by serial (the vector's order).
        self.s.revoked.sort_by(|a, b| (a.at, a.serial.len(), &a.serial).cmp(&(b.at, b.serial.len(), &b.serial)));
        let now = t.div_euclid(1000) * 1000;
        let mut this_update = (t - BACKDATE_MS).div_euclid(1000) * 1000;
        if let Some((_, last, _)) = &self.s.crl {
            this_update = this_update.max(last + 1000);
        }
        let this_update = this_update.min(now);
        let next_update = (this_update + CRL_DAYS * DAY_MS).max(ends.map_or(0, |e| e.div_euclid(1000) * 1000));
        let last = self.s.crl.as_ref().map(|c| c.0.clone()).unwrap_or_default();
        let number = last.max(self.s.floor.clone()).next();
        let entries = self.s.revoked.iter().map(|r| x509::serial_bytes(&r.serial).map(|b| (b, r.at))).collect::<Option<Vec<_>>>().ok_or("a revoked serial does not read")?;
        let der = x509::sign_crl(&self.ca_der, key, this_update, next_update, number.bytes(), &entries)?;
        self.s.signed.push(SignedList { number: number.clone(), this_update, sha256: hex(&sha256(&der)) });
        let extra = self.s.signed.len().saturating_sub(SIGNED_KEPT);
        self.s.signed.drain(..extra);
        self.s.crl = Some((number, this_update, next_update));
        self.crl_der = der;
        self.owed = false;
        self.info().ok_or_else(|| "the list was not kept".to_owned())
    }

    /// The newest list (PEM) and its facts, or None before one is signed.
    pub fn crl(&self) -> Option<(String, CrlInfo)> {
        Some((x509::crl_pem(&self.crl_der), self.info()?))
    }

    /// Re-sign when fewer than 60 days are left, when `meet-crl.pem` is missing or not the newest signed (start), or
    /// after a failed write. Some when it signed (audit `fleet.meet-ca.crl`); Err raises `meet-crl-failing`.
    pub fn resign(&mut self, vault: &dyn Vault, t: i64) -> Result<Option<CrlInfo>, String> {
        let due = self.owed || self.crl_der.is_empty() || !matches!(&self.s.crl, Some(c) if c.2 - t >= CRL_RESIGN_MS);
        if !due {
            return Ok(None);
        }
        let key = self.key(vault).map_err(|e| e.message)?;
        match self.change(|ca| ca.sign_list(&key, t, None).map_err(|_| ApiError::of("write-failed"))) {
            Ok(info) => Ok(Some(info)),
            Err(e) => {
                self.owed = true;
                Err(e.message)
            }
        }
    }

    /// Merge another list of this CA (divergence, H5; `from` is `relay <relayId>`): it must be signed by the CA;
    /// every entry the record lacks is taken under the R5-L1 rules; its number raises the floor; the console then
    /// signs its own list at its own dates when anything was added or the foreign list is dated ahead (its date is
    /// never copied). A number at or above 2^150 merges nothing and signs nothing (R3-L6).
    pub fn merge(&mut self, vault: &dyn Vault, crl_der: &[u8], from: &str, t: i64) -> Result<Merge, ApiError> {
        let key = self.key(vault)?;
        let read = foreign(&self.ca_der, crl_der).ok_or_else(|| ApiError::of("invalid"))?;
        let number = read.number.as_deref().map(CrlNumber::from_bytes);
        if number.as_ref().is_some_and(CrlNumber::at_ceiling) {
            return Ok(Merge { added: 0, future: Some(read.this_update_ms), ceiling: true, signed: None });
        }
        let future = (read.this_update_ms > t).then_some(read.this_update_ms);
        let entries: Vec<_> = read.entries.iter().map(|(s, at)| (s.clone(), *at, None)).collect();
        self.change(|ca| {
            let added = ca.take(&entries, from, t);
            if let Some(n) = number.filter(|n| *n > ca.s.floor) {
                ca.s.floor = n;
            }
            let signed = if added > 0 || future.is_some() { Some(ca.sign_list(&key, t, None).map_err(|_| ApiError::of("write-failed"))?) } else { None };
            Ok(Merge { added, future, ceiling: false, signed })
        })
    }

    /// `POST fleet/meet-ca/revoke` (8.5): the serial goes on the list and a new list is signed. A serial already
    /// listed signs nothing new.
    pub fn revoke(&mut self, vault: &dyn Vault, serial: &str, from: &str, t: i64) -> Result<CrlInfo, ApiError> {
        let key = self.key(vault)?;
        let serial = norm_serial(serial).ok_or_else(|| ApiError::of("invalid"))?;
        if self.s.revoked.iter().any(|r| r.serial == serial) && !self.owed {
            if let Some(info) = self.info() {
                return Ok(info);
            }
        }
        self.change(|ca| {
            ca.add_revoked(&serial, t, from, None);
            ca.sign_list(&key, t, None).map_err(|_| ApiError::of("write-failed"))
        })
    }

    /// The unexpired, unrevoked serials issued to a relay (of one kind, or both), except `keep`.
    fn live_serials(&self, relay_id: &str, kind: Option<CertKind>, keep: &[&str], t: i64) -> Vec<String> {
        self.s
            .issued
            .iter()
            .filter(|r| r.relay_id == relay_id && kind.is_none_or(|k| r.kind == k) && r.revoked_at.is_none() && r.not_after > t && !keep.contains(&r.serial.as_str()))
            .map(|r| r.serial.clone())
            .collect()
    }

    /// Revoke every unexpired serial issued to a relay, except `keep`, with one new list: a removal, replacement or
    /// leaving (`kind` None, R5-M1), or older server serials at a renewal (`Some(Server)`, keeping the one in use
    /// and the new one). Ok is the serials revoked (empty: nothing signed).
    pub fn revoke_relay(&mut self, vault: &dyn Vault, relay_id: &str, kind: Option<CertKind>, keep: &[&str], t: i64) -> Result<Vec<String>, ApiError> {
        let due = self.live_serials(relay_id, kind, keep, t);
        if due.is_empty() {
            return Ok(due);
        }
        let key = self.key(vault)?;
        let from = format!("relay {relay_id}");
        self.change(|ca| {
            for s in &due {
                ca.add_revoked(s, t, &from, None);
            }
            ca.sign_list(&key, t, None).map_err(|_| ApiError::of("write-failed"))?;
            Ok(due)
        })
    }

    /// `POST fleet/meet-ca/prune` (8.5, R5-M2): an entry leaves early only with its certificate, signed by this CA,
    /// with that serial, and already ended. Recorded in `pruned` by the admin.
    pub fn prune(&mut self, vault: &dyn Vault, cert_pem: &str, by: &str, t: i64) -> Result<CrlInfo, ApiError> {
        let key = self.key(vault)?;
        let refused = || refuse("meet-ca-prune", &[]);
        let ca = Cert::from_der(&self.ca_der).ok_or_else(refused)?;
        let cert = pem_blocks(cert_pem.as_bytes(), "CERTIFICATE").into_iter().next().and_then(|(_, d)| Cert::from_der(&d)).ok_or_else(refused)?;
        let listed = self.s.revoked.iter().position(|r| r.serial == cert.serial);
        let (true, true, Some(i)) = (cert.issued_by(&ca), cert.not_after * 1000 < t, listed) else { return Err(refused()) };
        self.change(|me| {
            let r = me.s.revoked.remove(i);
            me.s.pruned.push(Pruned { serial: r.serial, not_after: Some(cert.not_after * 1000), revoked_at: r.at, at: t, by: by.to_owned() });
            me.sign_list(&key, t, None).map_err(|_| ApiError::of("write-failed"))
        })
    }

    /// Whether a reported list is one the console signed (R3-L3): its SHA-256 is in `signed`, or its number is
    /// below the oldest kept one (an old console list, not divergence).
    pub fn signed_by_me(&self, sha256_hex: &str, number: Option<&CrlNumber>) -> bool {
        self.s.signed.iter().any(|x| x.sha256.eq_ignore_ascii_case(sha256_hex)) || number.is_some_and(|n| self.s.signed.first().is_some_and(|o| *n < o.number))
    }

    /// Whether the console's newest list is later, by the 8.5 order, than a reported one (a push is due).
    pub fn later_than(&self, this_update: i64, number: Option<&CrlNumber>) -> bool {
        self.s.crl.as_ref().is_some_and(|(n, tu, _)| later((*tu, Some(n)), (this_update, number)) == Ordering::Greater)
    }

    /// A certificate server's held list number, as relays report it (R5-L2): the next number goes above it. True when
    /// the floor moved; a number at or above 2^150 is ignored.
    pub fn note_signer_held(&mut self, number: &CrlNumber) -> Result<bool, String> {
        let last = self.s.crl.as_ref().map(|c| c.0.clone()).unwrap_or_default();
        if number.at_ceiling() || *number <= self.s.floor || *number < last {
            return Ok(false);
        }
        let n = number.clone();
        self.change(|ca| {
            ca.s.floor = n;
            Ok(true)
        })
        .map_err(|e| e.message)
    }

    // ── Certificates (8.4) ──────────────────────────────────────────────────────────────────────────────────

    /// The live server certificate of another relay that holds one of `names` (`deploy-host-taken`): (relay, name).
    pub fn name_holder(&self, names: &[String], t: i64) -> Option<(String, String)> {
        self.s
            .issued
            .iter()
            .filter(|r| r.kind == CertKind::Server && r.revoked_at.is_none() && r.not_after > t)
            .find_map(|r| r.names.iter().find(|n| names.iter().any(|m| x509::same_name(n, m))).map(|n| (r.relay_id.clone(), n.clone())))
    }

    /// The certificate and its row, without recording it.
    #[allow(clippy::too_many_arguments)]
    fn issue_row(&self, key: &Key, relay_id: &str, kind: CertKind, csr_der: &[u8], names: &[String], signer_confirmed: bool, renewal: bool, t: i64) -> Result<(Issued, Row), ApiError> {
        let csr_refused = || refuse("deploy-csr", &[("names", names.join(", ").as_str())]);
        let req = x509::read_request(csr_der).ok_or_else(csr_refused)?;
        let profile = match kind {
            CertKind::Server => {
                let covered = |a: &[String], b: &[String]| a.iter().all(|n| b.iter().any(|m| x509::same_name(n, m)));
                let asked = req.san.names.as_slice();
                if names.is_empty() || names.len() != asked.len() || !covered(names, asked) || !covered(asked, names) || !req.san.uris.is_empty() || req.san.other != 0 {
                    return Err(csr_refused());
                }
                MeetProfile::Server { names: names.to_vec() }
            }
            CertKind::SignerClient if self.s.signer_url.is_none() => return Err(ApiError::of("invalid")),
            CertKind::SignerClient => MeetProfile::SignerClient,
            // checkpoint certificates have their own path (`issue_checkpoint`)
            CertKind::Checkpoint => return Err(ApiError::of("invalid")),
        };
        let last = self.s.issued.iter().filter(|r| renewal && r.relay_id == relay_id && r.kind == kind).map(|r| r.not_before + BACKDATE_MS).max();
        if let Some(last) = last {
            if t < last + RENEW_WAIT_MS {
                let mut e = refuse("meet-cert-wait", &[]);
                e.retry_after = Some(((last + RENEW_WAIT_MS - t) / 1000).max(1));
                return Err(e);
            }
        }
        let days = match kind {
            CertKind::Server => SERVER_DAYS,
            CertKind::SignerClient if self.s.signer_enforced && signer_confirmed => SIGNER_DAYS_ENFORCED,
            CertKind::SignerClient => SIGNER_DAYS,
            CertKind::Checkpoint => CHECKPOINT_DAYS,
        };
        let ca = Cert::from_der(&self.ca_der).ok_or_else(|| ApiError::of("state-unreadable"))?;
        let not_before = (t - BACKDATE_MS).div_euclid(1000) * 1000;
        let not_after = (t + days * DAY_MS).min(ca.not_after * 1000).div_euclid(1000) * 1000;
        let serial = x509::new_serial().map_err(|_| ApiError::of("write-failed"))?;
        let spec = MeetSpec { profile: &profile, serial: &serial, not_before_ms: not_before, not_after_ms: not_after, spki: &req.spki, ca_der: &self.ca_der };
        let der = x509::meet_issue(&spec, key).map_err(|_| ApiError::of("invalid"))?;
        let serial = x509::serial_of_bytes(&serial);
        let names = match profile {
            MeetProfile::Server { names } => names,
            MeetProfile::SignerClient => vec![MEET_RELAY_URI.to_owned()],
        };
        let row = Row { serial: serial.clone(), relay_id: relay_id.to_owned(), kind, names: names.clone(), not_before, not_after, revoked_at: None };
        Ok((Issued { pem: der_to_pem(&der), der, serial, not_after, names }, row))
    }

    /// A relay certificate from the relay's own request (6.5, 8.4). The request must verify (ECDSA P-256 SHA-256)
    /// and, for a server certificate, name exactly `names` (`deploy-csr`); nothing of it but its key is used (L9).
    /// Server certificates last 90 days; signer client certificates 90 only while the CA page setting is on and
    /// `signer_confirmed` (every relay using that server reports enforcement; R4-M1), else 30; both from 5 minutes
    /// ago and never past the CA's end. A `renewal` (the `meet-cert` frame, D10) is refused within 24 hours of the
    /// relay's last certificate of that kind (`meet-cert-wait`); an enrollment, including a Replace that keeps the
    /// replaced relay's id, never is. The row is in `meet-ca.json` before this returns.
    #[allow(clippy::too_many_arguments)]
    pub fn issue(&mut self, vault: &dyn Vault, relay_id: &str, kind: CertKind, csr_der: &[u8], names: &[String], signer_confirmed: bool, renewal: bool, t: i64) -> Result<Issued, ApiError> {
        if self.state == CaState::Unreadable {
            return Err(refuse("deploy-ca-needed", &[]));
        }
        let key = self.key(vault)?;
        let (issued, row) = self.issue_row(&key, relay_id, kind, csr_der, names, signer_confirmed, renewal, t)?;
        self.change(|ca| {
            ca.s.issued.push(row);
            Ok(())
        })?;
        Ok(issued)
    }

    /// API-1 9.3: an org's audit checkpoint certificate for `holder` (`console` or a relay id) from the holder's own
    /// request (ECDSA P-256 SHA-256; only its key is used, L9): SAN URI `urn:lucid-meet:org:<org>`, digitalSignature,
    /// no extendedKeyUsage, from 5 minutes ago for a year (never past the CA's end). Read back and checked before
    /// use; the row (kind `checkpoint`) is in `meet-ca.json` before this returns.
    pub fn issue_checkpoint(&mut self, vault: &dyn Vault, holder: &str, org: &str, csr_der: &[u8], t: i64) -> Result<Issued, ApiError> {
        if self.state == CaState::Unreadable {
            return Err(refuse("deploy-ca-needed", &[]));
        }
        let org_ok = (1..=32).contains(&org.len()) && org.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !org_ok || holder.is_empty() {
            return Err(ApiError::of("invalid"));
        }
        let key = self.key(vault)?;
        let req = x509::read_request(csr_der).ok_or_else(|| ApiError::of("invalid"))?;
        if !x509::is_p256_spki(&req.spki) {
            return Err(ApiError::of("invalid"));
        }
        let ca = Cert::from_der(&self.ca_der).ok_or_else(|| ApiError::of("state-unreadable"))?;
        let not_before = (t - BACKDATE_MS).div_euclid(1000) * 1000;
        let not_after = (t + CHECKPOINT_DAYS * DAY_MS).min(ca.not_after * 1000).div_euclid(1000) * 1000;
        let serial = x509::new_serial().map_err(|_| ApiError::of("write-failed"))?;
        let tbs = checkpoint_tbs(&self.ca_der, org, &serial, not_before, not_after, &req.spki).map_err(|_| ApiError::of("invalid"))?;
        let signature = key.sign(&tbs).map_err(|_| ApiError::of("write-failed"))?;
        let der = x509::signed_p256(&tbs, &signature);
        checkpoint_check(&der, org, &self.ca_der, not_before).map_err(|_| ApiError::of("invalid"))?;
        let serial = x509::serial_of_bytes(&serial);
        let names = vec![checkpoint_uri(org)];
        let row = Row { serial: serial.clone(), relay_id: holder.to_owned(), kind: CertKind::Checkpoint, names: names.clone(), not_before, not_after, revoked_at: None };
        self.change(|ca| {
            ca.s.issued.push(row);
            Ok(())
        })?;
        Ok(Issued { pem: der_to_pem(&der), der, serial, not_after, names })
    }

    /// Relays that hold a live certificate from this CA (`meet-ca-in-use`). The console's own checkpoint
    /// certificates are not a relay's.
    pub fn in_use(&self, t: i64) -> usize {
        let mut relays: Vec<&str> = self.s.issued.iter().filter(|r| r.revoked_at.is_none() && r.not_after > t && !(r.kind == CertKind::Checkpoint && r.relay_id == "console")).map(|r| r.relay_id.as_str()).collect();
        relays.sort_unstable();
        relays.dedup();
        relays.len()
    }

    // ── Settings ────────────────────────────────────────────────────────────────────────────────────────────

    /// The CA page's longest lifetime (8.2: 1 to 3650 days).
    pub fn set_max_lifetime(&mut self, days: i64) -> Result<(), ApiError> {
        if !(1..=MAX_LIFETIME_MAX).contains(&days) {
            return Err(ApiError::of("invalid"));
        }
        self.change(|ca| {
            ca.s.max_lifetime_days = days;
            Ok(())
        })
    }

    /// "This certificate server checks revocation of relay certificates" (8.4, R4-M1).
    pub fn set_signer_enforced(&mut self, on: bool) -> Result<(), ApiError> {
        self.change(|ca| {
            ca.s.signer_enforced = on;
            Ok(())
        })
    }

    /// A relay holds a list of this CA the console did not sign (`meet-crl-diverged`, until dismissed).
    pub fn note_diverged(&mut self, relay_id: &str, this_update: i64, t: i64) -> Result<(), String> {
        let d = Diverged { relay_id: relay_id.to_owned(), this_update, at: t };
        self.change(|ca| {
            ca.s.diverged = Some(d);
            Ok(())
        })
        .map_err(|e| e.message)
    }

    pub fn dismiss_diverged(&mut self) -> Result<(), String> {
        self.change(|ca| {
            ca.s.diverged = None;
            Ok(())
        })
        .map_err(|e| e.message)
    }

    // ── Remove (8.6) ────────────────────────────────────────────────────────────────────────────────────────

    /// `POST fleet/meet-ca/remove`: refused while a relay holds a live certificate unless `elsewhere`; then a final
    /// list dated by the 8.5 rule whose `nextUpdate` is the later of 120 days on and the latest `notAfter` issued
    /// (none when the key is lost: the current list stays the last), the sealed key wiped, and the files kept
    /// renamed with the time. The caller pushes `crl_pem` and drops this value.
    pub fn remove(&mut self, vault: &mut dyn Vault, elsewhere: bool, t: i64) -> Result<Removed, ApiError> {
        let n = self.in_use(t);
        if n > 0 && !elsewhere {
            return Err(refuse("meet-ca-in-use", &[("n", n.to_string().as_str())]));
        }
        if let Ok(key) = self.key(vault) {
            let ends = self.s.issued.iter().map(|r| r.not_after).max();
            self.change(|ca| ca.sign_list(&key, t, ends).map_err(|_| ApiError::of("write-failed")))?;
        }
        let (crl_pem, ends) = match self.crl() {
            Some((pem, info)) => (pem, info.next_update),
            None => (String::new(), 0),
        };
        if vault.usable() {
            vault.remove(KEY_NAME).map_err(|_| ApiError::of("write-failed"))?;
        }
        for f in [CA_FILE, STATE_FILE, CRL_FILE] {
            let from = self.dir.join(f);
            let Some((stem, ext)) = f.rsplit_once('.') else { continue };
            if from.exists() {
                std::fs::rename(&from, self.dir.join(format!("{stem}.removed-{t}.{ext}"))).map_err(|_| ApiError::of("write-failed"))?;
            }
        }
        self.state = CaState::Lost;
        Ok(Removed { crl_pem, ends })
    }

    /// The 9.1 `GET fleet/meet-ca` `ca` object (plus `signerEnforced` and `maxLifetimeDays` for the CA page). Never
    /// the key.
    pub fn view(&self, t: i64) -> Value {
        let cert = Cert::from_der(&self.ca_der);
        let id = if self.s.id.is_empty() { cert.as_ref().map(|c| crate::license::meet_root_id(&c.spki)) } else { Some(self.s.id.clone()) };
        let row_state = |r: &Row| match (r.revoked_at, r.not_after <= t) {
            (Some(_), _) => "revoked",
            (None, true) => "ended",
            (None, false) => "live",
        };
        json!({
            "id": id,
            "state": self.state.as_str(),
            "subject": cert.as_ref().map(subject_text),
            "notAfter": cert.as_ref().map(|c| c.not_after * 1000),
            "signerUrl": self.s.signer_url,
            "signerEnforced": self.s.signer_enforced,
            "maxLifetimeDays": self.s.max_lifetime_days,
            "crl": self.s.crl.as_ref().map(|(n, tu, nu)| json!({ "number": n.to_json(), "thisUpdate": tu, "nextUpdate": nu, "revoked": self.s.revoked.len() })),
            "diverged": self.s.diverged.as_ref().map(|d| json!({ "relayId": d.relay_id, "thisUpdate": d.this_update, "at": d.at })),
            "issued": self.s.issued.iter().map(|r| json!({
                "serial": r.serial,
                "relay": r.relay_id,
                "kind": r.kind.as_str(),
                "names": r.names,
                "notAfter": r.not_after,
                "state": row_state(r),
            })).collect::<Vec<_>>(),
        })
    }
}

/// DER as a PEM block of `label` (tests).
#[cfg(test)]
fn pem(label: &str, der: &[u8]) -> String {
    let b = crate::meet_json::b64(der);
    let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
    format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
}

#[cfg(test)]
fn key_pem(pkcs8: &[u8]) -> String {
    pem("PRIVATE KEY", pkcs8)
}

/// A held CA for other files' tests (a fresh P-256 CA, its key sealed in `vault`, the first list signed, the files
/// written), without the import refusals that depend on the console.
#[cfg(test)]
pub fn test_ca(dir: &Path, vault: &mut dyn Vault, signer_url: Option<&str>, t: i64) -> MeetCa {
    let key = Key::generate(Curve::P256).expect("a key");
    let ca_der = x509::meet_test_ca(&key, "Acme Meeting Hub CA", Some(0), t - DAY_MS, t + 1825 * DAY_MS);
    let ctx = ImportCtx { high: false, provider: Some(Provider::SystemdCredential), high_relays: &[] };
    let req = ImportReq { ca_pem: der_to_pem(&ca_der), key_pem: Redacted::new(key_pem(key.pkcs8())), issued_json: None, crl_pem: None, signer_url: signer_url.map(str::to_owned), no_high_relay: true, max_lifetime_days: None };
    MeetCa::import(dir, vault, &ctx, req, "test", t).expect("the test CA imports").0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_ca::{tests_dir, MemVault};
    use crate::fleet_x509::tests::unhex;
    use crate::meet_x509::Crl;

    /// A fixed "now" on a whole second.
    const T: i64 = 1_800_000_000_000;
    const RELAY: &str = "r_00000000000000aa";

    fn std_ctx() -> ImportCtx<'static> {
        ImportCtx { high: false, provider: Some(Provider::SystemdCredential), high_relays: &[] }
    }

    fn new_ca(path_len: Option<u8>, not_after: i64) -> (Key, Vec<u8>) {
        let key = Key::generate(Curve::P256).unwrap();
        let ca = x509::meet_test_ca(&key, "Acme Meeting Hub CA", path_len, T - DAY_MS, not_after);
        (key, ca)
    }

    fn req(ca_der: &[u8], key_pem_text: String) -> ImportReq {
        ImportReq { ca_pem: der_to_pem(ca_der), key_pem: Redacted::new(key_pem_text), issued_json: None, crl_pem: None, signer_url: Some("https://meet-ca.acme.example".into()), no_high_relay: true, max_lifetime_days: None }
    }

    struct World {
        dir: PathBuf,
        vault: MemVault,
        key: Key,
        ca_der: Vec<u8>,
        ca: MeetCa,
    }

    fn world(name: &str, t: i64) -> World {
        let dir = tests_dir(name);
        let (key, ca_der) = new_ca(Some(0), T + 1825 * DAY_MS);
        let mut vault = MemVault::default();
        let (ca, _) = MeetCa::import(&dir, &mut vault, &std_ctx(), req(&ca_der, key_pem(key.pkcs8())), "admin@acme.example", t).unwrap();
        World { dir, vault, key, ca_der, ca }
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    /// A server request for `dns` from a fresh key.
    fn server_csr(dns: &[String]) -> Vec<u8> {
        let k = Key::generate(Curve::P256).unwrap();
        x509::csr(&k, &dns[0], dns, &[], &[]).unwrap()
    }

    fn signer_csr() -> Vec<u8> {
        let k = Key::generate(Curve::P256).unwrap();
        x509::csr(&k, x509::MEET_RELAY_CN, &[], &[], &[MEET_RELAY_URI.to_owned()]).unwrap()
    }

    #[test]
    fn checkpoint_certificate_profile() {
        let mut w = world("meet-ca-checkpoint", T);
        let k = Key::generate(Curve::P256).unwrap();
        let csr = x509::csr(&k, CHECKPOINT_CN, &[], &[], &[checkpoint_uri("acme")]).unwrap();
        let issued = w.ca.issue_checkpoint(&w.vault, "console", "acme", &csr, T).unwrap();
        let cert = checkpoint_check(&issued.der, "acme", &w.ca_der, T).unwrap();
        assert_eq!(cert.spki, k.spki());
        let u = x509::usage(&issued.der).unwrap();
        assert!(u.eku.is_none() && u.key_usage == Some(0x80) && !u.ca);
        assert_eq!(x509::cert_san(&issued.der).unwrap().uris, vec!["urn:lucid-meet:org:acme".to_owned()]);
        assert_eq!(issued.not_after, T + CHECKPOINT_DAYS * DAY_MS);
        // another org's name never verifies it, and the row is recorded with its kind
        assert!(checkpoint_check(&issued.der, "beta", &w.ca_der, T).is_err());
        let row = w.ca.rows().iter().find(|r| r.serial == issued.serial).unwrap();
        assert_eq!((row.kind, row.relay_id.as_str()), (CertKind::Checkpoint, "console"));
        // the console's own checkpoint certificate is not a relay using the CA
        assert_eq!(w.ca.in_use(T), 0);
        let again = MeetCa::open(&w.dir, &w.vault).unwrap();
        assert!(again.rows().iter().any(|r| r.kind == CertKind::Checkpoint));
        // a request that does not verify is refused
        let mut bad = csr.clone();
        let n = bad.len();
        bad[n - 1] ^= 1;
        assert!(w.ca.issue_checkpoint(&w.vault, RELAY, "acme", &bad, T).is_err());
    }

    /// A list of `w`'s CA signed with its key, as another signer would.
    fn other_list(w: &World, this_update: i64, number: &[u8], entries: &[(&str, i64)]) -> Vec<u8> {
        let e: Vec<(Vec<u8>, i64)> = entries.iter().map(|(s, at)| (x509::serial_bytes(s).unwrap(), *at)).collect();
        x509::sign_crl(&w.ca_der, &w.key, this_update, this_update + 120 * DAY_MS, number, &e).unwrap()
    }

    fn listed(ca: &MeetCa) -> Vec<String> {
        x509::read_crl(&ca.crl_der).unwrap().entries.into_iter().map(|(s, _)| s).collect()
    }

    /// The SEC1 `ECPrivateKey` inside a PKCS#8 key.
    fn sec1_of(pkcs8: &[u8]) -> Vec<u8> {
        let outer = crate::der::tlv(pkcs8).unwrap();
        let version = crate::der::tlv(outer.value).unwrap();
        let alg = crate::der::tlv(version.rest).unwrap();
        crate::der::tlv(alg.rest).unwrap().value.to_vec()
    }

    /// The private scalar inside a SEC1 key.
    fn scalar_of(sec1: &[u8]) -> Vec<u8> {
        let s = crate::der::tlv(sec1).unwrap();
        let version = crate::der::tlv(s.value).unwrap();
        crate::der::tlv(version.rest).unwrap().value.to_vec()
    }

    fn ext(oid: &[u8], critical: bool, value: Vec<u8>) -> Vec<u8> {
        let mut p = x509::der(0x06, oid);
        if critical {
            p.extend(x509::der(0x01, &[0xff]));
        }
        p.extend(x509::der(0x04, &value));
        x509::der(0x30, &p)
    }

    /// A request that asks for more than its names: another subject, CA true, keyCertSign and cRLSign.
    fn greedy_csr(k: &Key, names: &[String]) -> Vec<u8> {
        let san = x509::der(0x30, &names.iter().flat_map(|n| x509::san_name(n)).collect::<Vec<u8>>());
        let bc = x509::der(0x30, &x509::der(0x01, &[0xff]));
        let ku = x509::der(0x03, &[0x01, 0x06]);
        let exts = x509::der(0x30, &[ext(&[0x55, 0x1d, 0x11], false, san), ext(&[0x55, 0x1d, 0x13], true, bc), ext(&[0x55, 0x1d, 0x0f], true, ku)].concat());
        let attr = x509::der(0x30, &[x509::der(0x06, &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e]), x509::der(0x31, &exts)].concat());
        let subject = x509::name(&[(x509::OID_CN, "attacker.example"), (x509::OID_O, "Evil")]);
        let info = x509::der(0x30, &[x509::der(0x02, &[0]), subject, k.spki(), x509::der(0xa0, &attr)].concat());
        x509::signed_p256(&info, &k.sign(&info).unwrap())
    }

    fn vector() -> Value {
        let path = format!("{}/tests/admin_console_meet_ca_v1.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    fn s(v: &Value) -> &str {
        v.as_str().unwrap()
    }

    fn ms(v: &Value) -> i64 {
        v.as_i64().unwrap()
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array().map(|a| a.iter().map(|x| s(x).to_owned()).collect()).unwrap_or_default()
    }

    /// 16.1 d-pki: the exact DER of the vector (the signed parts byte for byte; the vector's signatures verify), each
    /// certificate and list read back through `meet_x509::Cert` and `Crl`, the order and reader cases, the foreign
    /// list dated a day ahead, and the import cases.
    #[test]
    fn objects_for_fixed_inputs_equal_the_vector() {
        let v = vector();
        let now = ms(&v["now_ms"]);
        let ca_der = unhex(s(&v["ca"]["path0"]["der_hex"]));
        let ca = Cert::from_der(&ca_der).unwrap();
        assert_eq!(crate::license::meet_root_id(&ca.spki), s(&v["ca"]["id"]));
        let ca_key = Key::from_pkcs8(Curve::P256, &unhex(s(&v["keys"]["ca"]["pkcs8_hex"]))).unwrap();
        assert_eq!(hex(&ca_key.spki()), s(&v["keys"]["ca"]["spki_hex"]));
        assert!(ca_usable(&ca_der, &ca, now));
        let ca1 = unhex(s(&v["ca"]["path1"]["der_hex"]));
        assert!(ca_usable(&ca1, &Cert::from_der(&ca1).unwrap(), now));

        // The requests.
        let server_key = Key::from_pkcs8(Curve::P256, &unhex(s(&v["keys"]["server"]["pkcs8_hex"]))).unwrap();
        let signer_key = Key::from_pkcs8(Curve::P256, &unhex(s(&v["keys"]["signer"]["pkcs8_hex"]))).unwrap();
        assert_eq!(hex(&server_key.spki()), s(&v["keys"]["server"]["spki_hex"]));
        assert_eq!(hex(&signer_key.spki()), s(&v["keys"]["signer"]["spki_hex"]));
        let c = &v["csr"]["server"];
        let dns = strings(&c["dns"]);
        let ips: Vec<std::net::IpAddr> = strings(&c["ips"]).iter().map(|i| i.parse().unwrap()).collect();
        assert_eq!(hex(&x509::csr_info(&server_key.spki(), s(&c["cn"]), &dns, &ips, &[])), s(&c["info_hex"]));
        let r = x509::read_request(&unhex(s(&c["der_hex"]))).unwrap();
        assert_eq!(r.spki, server_key.spki());
        assert_eq!(r.san.names, [dns.clone(), strings(&c["ips"])].concat());
        assert!(x509::read_request(&x509::csr(&server_key, s(&c["cn"]), &dns, &ips, &[]).unwrap()).is_some());
        let c = &v["csr"]["signer"];
        let uris = strings(&c["uris"]);
        assert_eq!(hex(&x509::csr_info(&signer_key.spki(), s(&c["cn"]), &[], &[], &uris)), s(&c["info_hex"]));
        assert_eq!(x509::read_request(&unhex(s(&c["der_hex"]))).unwrap().san.uris, uris);

        // The certificates.
        let cs = &v["certs"]["server"];
        let profile = MeetProfile::Server { names: strings(&cs["names"]) };
        let spec = MeetSpec { profile: &profile, serial: &unhex(s(&cs["serial_hex"])), not_before_ms: ms(&cs["not_before_ms"]), not_after_ms: ms(&cs["not_after_ms"]), spki: &server_key.spki(), ca_der: &ca_der };
        assert_eq!(hex(&x509::meet_tbs(&spec).unwrap()), s(&cs["tbs_hex"]));
        let cert = x509::meet_check(&unhex(s(&cs["der_hex"])), &profile, &ca_der, spec.not_before_ms).unwrap();
        assert_eq!(cert.names.cns(), vec![s(&cs["cn"]).to_owned()]);
        assert!(!cert.ca);
        x509::meet_issue(&spec, &ca_key).unwrap();
        let cs = &v["certs"]["signer"];
        let spec = MeetSpec { profile: &MeetProfile::SignerClient, serial: &unhex(s(&cs["serial_hex"])), not_before_ms: ms(&cs["not_before_ms"]), not_after_ms: ms(&cs["not_after_ms"]), spki: &signer_key.spki(), ca_der: &ca_der };
        assert_eq!(hex(&x509::meet_tbs(&spec).unwrap()), s(&cs["tbs_hex"]));
        let cert = x509::meet_check(&unhex(s(&cs["der_hex"])), &MeetProfile::SignerClient, &ca_der, spec.not_before_ms).unwrap();
        assert_eq!(cert.names.uris, vec![MEET_RELAY_URI.to_owned()]);

        // The lists: each dated 5 minutes before "now".
        for l in v["crls"].as_array().unwrap() {
            let entries: Vec<(Vec<u8>, i64)> = l["entries"].as_array().unwrap().iter().map(|e| (x509::serial_bytes(s(&e["serial_hex"])).unwrap(), ms(&e["at_ms"]))).collect();
            let number = CrlNumber::from_json(&l["number"]).unwrap();
            let (tu, nu) = (ms(&l["this_update_ms"]), ms(&l["next_update_ms"]));
            assert_eq!(tu, now - BACKDATE_MS, "{}", l["name"]);
            assert_eq!(hex(&x509::crl_tbs(&ca_der, tu, nu, number.bytes(), &entries).unwrap()), s(&l["tbs_hex"]), "{}", l["name"]);
            let der = unhex(s(&l["der_hex"]));
            let back = Crl::from_der(&der).unwrap();
            assert!(back.signature_valid(&ca.spki) && back.this_update * 1000 == tu && back.serials.len() == entries.len(), "{}", l["name"]);
            let read = x509::read_crl(&der).unwrap();
            assert_eq!(read.number.as_deref(), Some(number.bytes()));
            assert_eq!(read.aki, x509::authority_key_id(&ca));
            x509::sign_crl(&ca_der, &ca_key, tu, nu, number.bytes(), &entries).unwrap();
        }

        // Order and the reader's clock.
        for c in v["order"].as_array().unwrap() {
            let (na, nb) = (CrlNumber::from_json(&c["a"]["number"]), CrlNumber::from_json(&c["b"]["number"]));
            let got = match later((ms(&c["a"]["this_update_ms"]), na.as_ref()), (ms(&c["b"]["this_update_ms"]), nb.as_ref())) {
                Ordering::Greater => "a",
                Ordering::Less => "b",
                Ordering::Equal => "none",
            };
            assert_eq!(got, s(&c["later"]), "{c}");
        }
        for c in v["reader"].as_array().unwrap() {
            let got = match list_time(ms(&c["this_update_ms"]), ms(&c["reader_now_ms"])) {
                ListTime::Current => "current",
                ListTime::Pending => "pending",
                ListTime::Future => "future",
            };
            assert_eq!(got, s(&c["state"]), "{c}");
        }

        // A foreign list dated a day ahead, merged into a console list dated now - 5 minutes with a higher number. The
        // console holds the "two" list's entries (imported with it, number 2) before the merge.
        let dir = tests_dir("meet-ca-vector");
        let mut vault = MemVault::default();
        let two = v["crls"].as_array().unwrap().iter().find(|l| l["name"] == "two").unwrap();
        let r = ImportReq { ca_pem: s(&v["ca"]["path0"]["pem"]).to_owned(), key_pem: Redacted::new(s(&v["keys"]["ca"]["pkcs8_pem"]).to_owned()), issued_json: None, crl_pem: Some(x509::crl_pem(&unhex(s(&two["der_hex"])))), signer_url: None, no_high_relay: true, max_lifetime_days: None };
        let (mut held, _) = MeetCa::import(&dir, &mut vault, &std_ctx(), r, "admin@acme.example", now - 3_600_000).unwrap();
        let m = held.merge(&vault, &unhex(s(&v["foreign"]["der_hex"])), "relay r_0123456789abcdef", now).unwrap();
        let merged = &v["foreign"]["merged"];
        let info = m.signed.unwrap();
        assert!(m.future.is_some() && !m.ceiling);
        assert_eq!(info.number, CrlNumber::from_json(&merged["number"]).unwrap());
        assert_eq!(info.this_update, ms(&merged["this_update_ms"]));
        let want: Vec<String> = merged["entries"].as_array().unwrap().iter().map(|e| crate::meet_x509::int_hex(&unhex(s(&e["serial_hex"])))).collect();
        assert_eq!(listed(&held), want);
        let outer = crate::der::tlv(&held.crl_der).unwrap().value;
        let tbs = &outer[..outer.len() - crate::der::tlv(outer).unwrap().rest.len()];
        assert_eq!(hex(tbs), s(&merged["tbs_hex"]));

        // Import cases.
        for c in v["import"].as_array().unwrap() {
            let dir = tests_dir("meet-ca-vector-import");
            let mut vault = MemVault::default();
            let r = ImportReq { ca_pem: s(&c["ca_pem"]).to_owned(), key_pem: Redacted::new(s(&c["key_pem"]).to_owned()), issued_json: None, crl_pem: None, signer_url: None, no_high_relay: c["no_high_relay"].as_bool().unwrap(), max_lifetime_days: None };
            let got = MeetCa::import(&dir, &mut vault, &std_ctx(), r, "admin@acme.example", now).err().map(|e| e.code);
            assert_eq!(got, c["code"].as_str(), "{}", c["name"]);
        }
    }

    /// 8.4, L9: nothing of the request but its key reaches a certificate; each reads back through `meet_x509::Cert`
    /// with its profile; the names must be exactly the minted ones; one per relay and kind per 24 hours; signer client
    /// certificates are 90 days only with the setting on and every relay confirming (R4-M1).
    #[test]
    fn certificates_take_only_the_key_from_the_request() {
        let mut w = world("meet-ca-issue", T);
        let minted = names(&["meet.acme.example", "198.51.100.7"]);
        let k = Key::generate(Curve::P256).unwrap();
        let iss = w.ca.issue(&w.vault, RELAY, CertKind::Server, &greedy_csr(&k, &minted), &minted, false, false, T).unwrap();
        let cert = x509::meet_check(&iss.der, &MeetProfile::Server { names: minted.clone() }, &w.ca_der, T).unwrap();
        assert_eq!(cert.names.cns(), vec!["meet.acme.example".to_owned()]);
        assert!(!cert.names.subject.iter().any(|(_, v)| v == "Evil" || v == "attacker.example"));
        assert!(!cert.ca && cert.spki == k.spki());
        let u = x509::usage(&iss.der).unwrap();
        assert!(u.key_usage == Some(0x80) && u.ku_critical && u.bc_critical && u.server_auth_only());
        assert_eq!(x509::cert_san(&iss.der).unwrap().names, minted);
        assert_eq!((cert.not_before * 1000, cert.not_after * 1000), (T - BACKDATE_MS, T + SERVER_DAYS * DAY_MS));
        assert_eq!(cert.aki, Cert::from_der(&w.ca_der).unwrap().ski);
        assert!(cert.issued_directly_by_root(&Cert::from_der(&w.ca_der).unwrap()));
        assert_eq!(Cert::from_pem(&iss.pem).unwrap().serial, iss.serial);
        assert_eq!(w.ca.rows().last().unwrap().serial, iss.serial);
        assert_eq!(w.ca.name_holder(&names(&["MEET.acme.example."]), T), Some((RELAY.to_owned(), "meet.acme.example".to_owned())));
        assert_eq!(w.ca.name_holder(&names(&["other.acme.example"]), T), None);

        // The signer client certificate ignores the request's names and subject; 30 days while the setting is off,
        // whatever the relays say.
        let k = Key::generate(Curve::P256).unwrap();
        let greedy = x509::csr(&k, "attacker.example", &names(&["evil.example"]), &[], &[]).unwrap();
        let sc = w.ca.issue(&w.vault, RELAY, CertKind::SignerClient, &greedy, &[], true, false, T).unwrap();
        let cert = x509::meet_check(&sc.der, &MeetProfile::SignerClient, &w.ca_der, T).unwrap();
        assert_eq!(cert.names.cns(), vec![x509::MEET_RELAY_CN.to_owned()]);
        assert!(cert.names.dns.is_empty() && x509::usage(&sc.der).unwrap().client_auth_only());
        assert_eq!(cert.not_after * 1000, T + SIGNER_DAYS * DAY_MS);
        w.ca.set_signer_enforced(true).unwrap();
        let sc = w.ca.issue(&w.vault, RELAY, CertKind::SignerClient, &signer_csr(), &[], false, true, T + DAY_MS).unwrap();
        assert_eq!(sc.not_after, T + DAY_MS + SIGNER_DAYS * DAY_MS);
        let sc = w.ca.issue(&w.vault, RELAY, CertKind::SignerClient, &signer_csr(), &[], true, true, T + 2 * DAY_MS).unwrap();
        assert_eq!(sc.not_after, T + 2 * DAY_MS + SIGNER_DAYS_ENFORCED * DAY_MS);

        // Refusals: other names, a broken signature, a second issue within 24 hours.
        let e = w.ca.issue(&w.vault, "r_00000000000000bb", CertKind::Server, &server_csr(&names(&["meet.acme.example"])), &minted, false, false, T).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("deploy-csr", "The relay's certificate request is not for meet.acme.example, 198.51.100.7."));
        let mut broken = server_csr(&minted[..1]);
        let n = broken.len();
        broken[n - 1] ^= 1;
        assert_eq!(w.ca.issue(&w.vault, "r_00000000000000bb", CertKind::Server, &broken, &minted[..1], false, false, T).unwrap_err().code, "deploy-csr");
        let with_uri = x509::csr(&Key::generate(Curve::P256).unwrap(), "meet.acme.example", &minted[..1], &[], &[MEET_RELAY_URI.to_owned()]).unwrap();
        assert_eq!(w.ca.issue(&w.vault, "r_00000000000000bb", CertKind::Server, &with_uri, &minted[..1], false, false, T).unwrap_err().code, "deploy-csr");
        let again = server_csr(&minted);
        let e = w.ca.issue(&w.vault, RELAY, CertKind::Server, &again, &minted, false, true, T + 3_600_000).unwrap_err();
        assert_eq!((e.code, e.status), ("meet-cert-wait", 429));
        assert!(e.retry_after.is_some());
        // An enrollment is never held back, including a Replace that keeps the relay's id (D10: "after enrollment").
        assert!(w.ca.issue(&w.vault, RELAY, CertKind::Server, &again, &minted, false, false, T + 3_600_000).is_ok());
        // The window runs from the relay's last certificate of that kind, whichever way it was issued.
        assert_eq!(w.ca.issue(&w.vault, RELAY, CertKind::Server, &again, &minted, false, true, T + DAY_MS).unwrap_err().code, "meet-cert-wait");
        assert!(w.ca.issue(&w.vault, RELAY, CertKind::Server, &again, &minted, false, true, T + DAY_MS + 3_600_000).is_ok());
        // Another kind keeps its own window.
        assert!(w.ca.issue(&w.vault, RELAY, CertKind::SignerClient, &signer_csr(), &[], false, true, T + 3 * DAY_MS).is_ok());
    }

    /// 8.2: every refusal, in the contract's order, and what import accepts (pathLen 0 and 1, SEC1 keys).
    #[test]
    fn import_refuses_in_the_contract_order() {
        let (key, ca_der) = new_ca(Some(0), T + 1825 * DAY_MS);
        let id = crate::license::meet_root_id(&Cert::from_der(&ca_der).unwrap().spki);
        let good = || req(&ca_der, key_pem(key.pkcs8()));
        fn code(ctx: &ImportCtx, r: ImportReq) -> Option<&'static str> {
            let dir = tests_dir("meet-ca-refuse");
            let mut vault = MemVault::default();
            MeetCa::import(&dir, &mut vault, ctx, r, "admin@acme.example", T).err().map(|e| e.code)
        }
        let high = |pending: bool, roots: Option<Vec<String>>| vec![HighRelay { relay_id: "r_00000000000000cc".into(), pending, meet_roots: roots }];
        assert_eq!(code(&ImportCtx { high: true, provider: Some(Provider::KeyFile), high_relays: &[] }, good()), Some("meet-ca-high"));
        for p in [Some(Provider::KeyFile), Some(Provider::DpapiMachine), None] {
            assert_eq!(code(&ImportCtx { provider: p, ..std_ctx() }, good()), Some("meet-ca-seal"), "{p:?}");
        }
        assert_eq!(code(&ImportCtx { provider: Some(Provider::DpapiService), ..std_ctx() }, good()), None);
        for relays in [high(false, Some(vec![id.clone()])), high(true, Some(Vec::new())), high(false, None)] {
            assert_eq!(code(&ImportCtx { high_relays: &relays, ..std_ctx() }, good()), Some("meet-ca-high-relay"), "{relays:?}");
        }
        let elsewhere = high(false, Some(vec!["m_00000000000000000000000000000000".into()]));
        assert_eq!(code(&ImportCtx { high_relays: &elsewhere, ..std_ctx() }, good()), None);
        assert_eq!(code(&std_ctx(), ImportReq { no_high_relay: false, ..good() }), Some("meet-ca-confirm"));
        // The CA and its key.
        for (path_len, days, want) in [(Some(0), 1825, None), (Some(1), 1825, None), (None, 1825, None), (Some(2), 1825, Some("meet-ca-key")), (Some(0), 120, None), (Some(0), 119, Some("meet-ca-key"))] {
            let (k, ca) = new_ca(path_len, T + days * DAY_MS);
            assert_eq!(code(&std_ctx(), req(&ca, key_pem(k.pkcs8()))), want, "{path_len:?} {days}");
        }
        let sec1 = pem("EC PRIVATE KEY", &sec1_of(key.pkcs8()));
        assert_eq!(code(&std_ctx(), req(&ca_der, sec1)), None);
        assert_eq!(code(&std_ctx(), req(&ca_der, key_pem(Key::generate(Curve::P256).unwrap().pkcs8()))), Some("meet-ca-key"));
        assert_eq!(code(&std_ctx(), req(&ca_der, String::new())), Some("meet-ca-key"));
        let p384 = Key::generate(Curve::P384).unwrap();
        let mgmt = x509::issue(&x509::Spec { profile: x509::Profile::Ca { host: "console.acme.example".into() }, serial: &[1], not_before_ms: T - DAY_MS, not_after_ms: T + 1825 * DAY_MS, spki: &p384.spki(), issuer: None }, &p384).unwrap();
        assert_eq!(code(&std_ctx(), req(&mgmt, key_pem(p384.pkcs8()))), Some("meet-ca-key"));
        // The certificate server address.
        for (url, want) in [("http://meet-ca.acme.example", Some("meet-ca-signer")), ("https://", Some("meet-ca-signer")), ("https://a b", Some("meet-ca-signer")), ("https://meet-ca.acme.example:x", Some("meet-ca-signer")), ("https://meet-ca.acme.example:8443/v1", None), ("https://[2001:db8::13]", None), ("", None)] {
            assert_eq!(code(&std_ctx(), ImportReq { signer_url: Some(url.into()), ..good() }), want, "{url}");
        }
        // A CA already held.
        let dir = tests_dir("meet-ca-exists");
        let mut vault = MemVault::default();
        MeetCa::import(&dir, &mut vault, &std_ctx(), good(), "admin@acme.example", T).unwrap();
        assert_eq!(MeetCa::import(&dir, &mut vault, &std_ctx(), good(), "admin@acme.example", T).unwrap_err().code, "meet-ca-exists");
        assert!(vault.map.contains_key(KEY_NAME));
    }

    /// 8.2, R5-L2: revoked `issued.json` rows and the entries of an earlier list are kept (except ended ones and
    /// ones past `maxLifetimeDays`), and numbering continues above the imported list and a server's held list.
    #[test]
    fn import_keeps_revocations_and_continues_numbering() {
        let (key, ca_der) = new_ca(Some(0), T + 1825 * DAY_MS);
        let old = x509::sign_crl(&ca_der, &key, T - DAY_MS, T + 100 * DAY_MS, &[7], &[(vec![0x4a, 0x01], T - 2 * DAY_MS), (vec![0x4a, 0x02], T - 500 * DAY_MS), (vec![0x4a, 0x06], T - 3 * DAY_MS)]).unwrap();
        let iso = crate::codec::iso_time;
        let issued = json!([
            { "kind": "client", "serial": "4a03", "not_after": iso(T + 10 * DAY_MS), "revoked": true, "revoked_at": iso(T - 3 * DAY_MS) },
            { "kind": "client", "serial": "4a04", "not_after": iso(T - DAY_MS), "revoked": true, "revoked_at": iso(T - 5 * DAY_MS) },
            { "kind": "client", "serial": "4a05", "not_after": iso(T + 10 * DAY_MS), "revoked": false },
            { "kind": "client", "serial": "4a06", "not_after": iso(T - DAY_MS), "revoked": false },
        ]);
        let dir = tests_dir("meet-ca-import-kept");
        let mut vault = MemVault::default();
        let r = ImportReq { issued_json: Some(stringify(&issued)), crl_pem: Some(x509::crl_pem(&old)), ..req(&ca_der, key_pem(key.pkcs8())) };
        let (mut ca, note) = MeetCa::import(&dir, &mut vault, &std_ctx(), r, "admin@acme.example", T).unwrap();
        assert_eq!(note, Imported { revoked_kept: 2, future: None, ceiling: false });
        assert_eq!(listed(&ca), vec!["4a03".to_owned(), "4a01".to_owned()]);
        let info = ca.crl().unwrap().1;
        assert_eq!((info.number, info.this_update), (CrlNumber::from_u64(8), T - BACKDATE_MS));
        assert_eq!(ca.s.revoked[0].not_after, Some(T + 10 * DAY_MS));
        assert!(ca.note_signer_held(&CrlNumber::from_u64(20)).unwrap());
        assert!(!ca.note_signer_held(&CrlNumber::from_u64(5)).unwrap());
        assert_eq!(ca.revoke(&vault, "4b01", "admin@acme.example", T + 1000).unwrap().number, CrlNumber::from_u64(21));
        // A list of this CA dated ahead is kept, never copied, and raises meet-crl-future; one not from this CA is refused.
        let ahead = x509::sign_crl(&ca_der, &key, T + DAY_MS, T + 121 * DAY_MS, &[2], &[]).unwrap();
        let (_, note) = MeetCa::import(&tests_dir("meet-ca-import-ahead"), &mut MemVault::default(), &std_ctx(), ImportReq { crl_pem: Some(x509::crl_pem(&ahead)), ..req(&ca_der, key_pem(key.pkcs8())) }, "admin@acme.example", T).unwrap();
        assert_eq!(note.future, Some(T + DAY_MS));
        let (other_key, other_ca) = new_ca(Some(0), T + 1825 * DAY_MS);
        let foreign = x509::sign_crl(&other_ca, &other_key, T, T + DAY_MS, &[1], &[]).unwrap();
        let e = MeetCa::import(&tests_dir("meet-ca-import-foreign"), &mut MemVault::default(), &std_ctx(), ImportReq { crl_pem: Some(x509::crl_pem(&foreign)), ..req(&ca_der, key_pem(key.pkcs8())) }, "admin@acme.example", T).unwrap_err();
        assert_eq!(e.code, "invalid");
    }

    /// 8.5, R5-L1: a merge keeps every entry; nothing new signs nothing; a pruned serial, an entry whose known
    /// `notAfter` has passed and one older than `maxLifetimeDays` are never taken.
    #[test]
    fn merge_keeps_every_entry_and_takes_back_nothing_pruned() {
        let mut w = world("meet-ca-merge", T);
        let other = other_list(&w, T - 600_000, &[3], &[("5a01", T - DAY_MS), ("5a02", T - DAY_MS)]);
        let m = w.ca.merge(&w.vault, &other, "relay r_0123456789abcdef", T).unwrap();
        assert_eq!((m.added, m.future, m.ceiling), (2, None, false));
        assert_eq!(m.signed.as_ref().unwrap().number, CrlNumber::from_u64(4));
        assert_eq!(listed(&w.ca), vec!["5a01".to_owned(), "5a02".to_owned()]);
        assert_eq!(w.ca.s.revoked[0].from, "relay r_0123456789abcdef");
        let m = w.ca.merge(&w.vault, &other, "relay r_0123456789abcdef", T + 1000).unwrap();
        assert_eq!((m.added, m.signed), (0, None));
        // An admin supplies 5a01's ended certificate; the same foreign list never brings it back.
        let k = Key::generate(Curve::P256).unwrap();
        let profile = MeetProfile::Server { names: names(&["old.acme.example"]) };
        let ended = x509::meet_issue(&MeetSpec { profile: &profile, serial: &[0x5a, 0x01], not_before_ms: T - 100 * DAY_MS, not_after_ms: T - DAY_MS, spki: &k.spki(), ca_der: &w.ca_der }, &w.key).unwrap();
        w.ca.prune(&w.vault, &der_to_pem(&ended), "admin@acme.example", T + 2000).unwrap();
        assert_eq!(listed(&w.ca), vec!["5a02".to_owned()]);
        assert_eq!(w.ca.merge(&w.vault, &other, "relay r_0123456789abcdef", T + 3000).unwrap().added, 0);
        assert_eq!(listed(&w.ca), vec!["5a02".to_owned()]);
        // A certificate the console issued that has ended, and an entry older than maxLifetimeDays, are not taken.
        let minted = names(&["meet.acme.example"]);
        let iss = w.ca.issue(&w.vault, RELAY, CertKind::Server, &server_csr(&minted), &minted, false, false, T).unwrap();
        let t = T + 100 * DAY_MS;
        let late = other_list(&w, t - 600_000, &[9], &[(iss.serial.as_str(), t - DAY_MS), ("5a03", t - 401 * DAY_MS), ("5a04", t - DAY_MS)]);
        let m = w.ca.merge(&w.vault, &late, "relay r_0123456789abcdef", t).unwrap();
        assert_eq!(m.added, 1);
        assert_eq!(listed(&w.ca), vec!["5a02".to_owned(), "5a04".to_owned()]);
        assert_eq!(m.signed.unwrap().number, CrlNumber::from_u64(10));
    }

    /// 8.5, R2-H1: every list is dated now - 5 minutes or 1 second after the previous one, never after now; at the
    /// cap two lists share a `thisUpdate` and the higher number orders them.
    #[test]
    fn lists_are_dated_five_minutes_back_one_second_apart_and_never_after_now() {
        let mut w = world("meet-ca-dates", T);
        let mut prev = w.ca.crl().unwrap().1;
        assert_eq!((prev.this_update, prev.next_update, prev.number.clone()), (T - BACKDATE_MS, T - BACKDATE_MS + CRL_DAYS * DAY_MS, CrlNumber::from_u64(1)));
        let key = w.ca.key(&w.vault).unwrap();
        for _ in 0..310 {
            let i = w.ca.sign_list(&key, T, None).unwrap();
            assert_eq!(i.this_update, (prev.this_update + 1000).min(T));
            assert_eq!(i.number, prev.number.next());
            assert_eq!(later((i.this_update, Some(&i.number)), (prev.this_update, Some(&prev.number))), Ordering::Greater);
            prev = i;
        }
        assert_eq!(prev.this_update, T);
        assert_eq!(w.ca.s.signed.len(), SIGNED_KEPT);
        let i = w.ca.sign_list(&key, T + DAY_MS, None).unwrap();
        assert_eq!(i.this_update, T + DAY_MS - BACKDATE_MS);
        let i = w.ca.revoke(&w.vault, "4b01", "admin@acme.example", T + DAY_MS).unwrap();
        assert_eq!(i.this_update, T + DAY_MS - BACKDATE_MS + 1000);
        // a clock that went back: never after now, even before the last list
        let i = w.ca.sign_list(&key, T, None).unwrap();
        assert_eq!(i.this_update, T);
    }

    /// R2-H1, R3-L6: a foreign list dated tomorrow is merged without moving the console's dates and outnumbered; a
    /// number at the ceiling merges and signs nothing.
    #[test]
    fn a_foreign_list_dated_tomorrow_is_merged_and_outnumbered() {
        let mut w = world("meet-ca-future", T);
        let tomorrow = other_list(&w, T + DAY_MS, &[41], &[("6a01", T)]);
        let now = T + 60_000;
        let m = w.ca.merge(&w.vault, &tomorrow, "relay r_0123456789abcdef", now).unwrap();
        assert_eq!((m.added, m.future, m.ceiling), (1, Some(T + DAY_MS), false));
        let i = m.signed.unwrap();
        assert_eq!((i.number, i.this_update), (CrlNumber::from_u64(42), now - BACKDATE_MS));
        assert_eq!(list_time(T + DAY_MS, now), ListTime::Future);
        let ceiling = [&[0x40u8][..], &[0u8; 18]].concat();
        assert!(CrlNumber::from_bytes(&ceiling).at_ceiling());
        let m = w.ca.merge(&w.vault, &other_list(&w, T, &ceiling, &[("6a02", T)]), "relay r_0123456789abcdef", now + 1000).unwrap();
        assert_eq!((m.added, m.ceiling, m.signed), (0, true, None));
        assert!(!listed(&w.ca).contains(&"6a02".to_owned()));
        let below = [&[0x3fu8][..], &[0xffu8; 18]].concat();
        assert!(!CrlNumber::from_bytes(&below).at_ceiling());
        let m = w.ca.merge(&w.vault, &other_list(&w, T, &below, &[("6a03", T)]), "relay r_0123456789abcdef", now + 2000).unwrap();
        assert_eq!(m.signed.unwrap().number, CrlNumber::from_bytes(&ceiling));
        assert!(!w.ca.note_signer_held(&CrlNumber::from_bytes(&[&[0x01u8][..], &[0u8; 19]].concat())).unwrap());
    }

    /// 16.1, R4-H1: a simulated year for 200 relays (server certificates every 60 days, signer client certificates
    /// every 20 days, older server serials revoked 7 days after a renewal, 20 removals) keeps the list under 64 KiB.
    #[test]
    fn a_year_of_renewals_for_200_relays_stays_under_64_kib() {
        let mut w = world("meet-ca-year", T);
        let key = w.ca.key(&w.vault).unwrap();
        let relays: Vec<(String, Vec<String>, Vec<u8>, Vec<u8>)> = (0..200)
            .map(|i| {
                let minted = vec![format!("meet{i}.acme.example")];
                let csr = server_csr(&minted);
                (format!("r_{i:016x}"), minted, csr, signer_csr())
            })
            .collect();
        let mut pending: Vec<(i64, usize, String)> = Vec::new();
        let mut removed = [false; 200];
        let mut max = 0;
        for day in 0..=365i64 {
            let t = T + day * DAY_MS;
            let mut changed = false;
            for (i, (id, minted, csr, scsr)) in relays.iter().enumerate() {
                if removed[i] {
                    continue;
                }
                if day % 60 == 0 {
                    let (iss, row) = w.ca.issue_row(&key, id, CertKind::Server, csr, minted, false, day > 0, t).unwrap();
                    w.ca.s.issued.push(row);
                    pending.push((day + 7, i, iss.serial));
                }
                if day % 20 == 0 {
                    let (_, row) = w.ca.issue_row(&key, id, CertKind::SignerClient, scsr, &[], false, day > 0, t).unwrap();
                    w.ca.s.issued.push(row);
                }
            }
            for (_, i, new) in pending.iter().filter(|(d, i, _)| *d == day && !removed[*i]) {
                for s in w.ca.live_serials(&relays[*i].0, Some(CertKind::Server), &[new.as_str()], t) {
                    changed |= w.ca.add_revoked(&s, t, "console", None);
                }
            }
            if day % 18 == 9 {
                let i = (day / 18) as usize * 10;
                for s in w.ca.live_serials(&relays[i].0, None, &[], t) {
                    changed |= w.ca.add_revoked(&s, t, "console", None);
                }
                removed[i] = true;
            }
            if changed || day % 30 == 0 {
                w.ca.sign_list(&key, t, None).unwrap();
                max = max.max(w.ca.crl_der.len());
            }
        }
        assert_eq!(removed.iter().filter(|r| **r).count(), 20);
        assert!(max < 64 * 1024, "the list reached {max} bytes");
        assert!(w.ca.s.pruned.iter().any(|p| p.by == "expiry"));
        // A superseded signer client certificate is never revoked: only removed relays have revoked ones.
        for r in w.ca.rows().iter().filter(|r| r.kind == CertKind::SignerClient && r.revoked_at.is_some()) {
            assert!(removed[usize::from_str_radix(&r.relay_id[2..], 16).unwrap()], "{}", r.relay_id);
        }
    }

    /// R4-H1, R5-M2: an entry with a known end leaves at the first re-sign after it; one with no known end stays
    /// until an admin supplies its ended certificate or `maxLifetimeDays` has passed since its revocation.
    #[test]
    fn entries_leave_at_their_end_or_by_an_ended_certificate() {
        let mut w = world("meet-ca-prune", T);
        let minted = names(&["meet.acme.example"]);
        let iss = w.ca.issue(&w.vault, RELAY, CertKind::Server, &server_csr(&minted), &minted, false, false, T).unwrap();
        w.ca.revoke(&w.vault, &iss.serial, "admin@acme.example", T + DAY_MS).unwrap();
        w.ca.revoke(&w.vault, "7a01", "admin@acme.example", T + DAY_MS + 1000).unwrap();
        assert_eq!(w.ca.revoke(&w.vault, "7a02", "admin@acme.example", T + 80 * DAY_MS).unwrap().revoked, 3);
        w.ca.revoke(&w.vault, "7a03", "admin@acme.example", T + 91 * DAY_MS).unwrap();
        assert_eq!(listed(&w.ca), vec!["7a01".to_owned(), "7a02".to_owned(), "7a03".to_owned()]);
        assert!(w.ca.s.pruned.iter().any(|p| p.serial == iss.serial && p.by == "expiry"));
        // Prune: only this CA's certificate, with a listed serial, once ended.
        let k = Key::generate(Curve::P256).unwrap();
        let profile = MeetProfile::Server { names: names(&["old.acme.example"]) };
        let cert = |serial: &[u8], ca_der: &[u8], ca_key: &Key| x509::meet_issue(&MeetSpec { profile: &profile, serial, not_before_ms: T - 50 * DAY_MS, not_after_ms: T + 100 * DAY_MS, spki: &k.spki(), ca_der }, ca_key).unwrap();
        let (other_key, other_ca) = new_ca(Some(0), T + 1825 * DAY_MS);
        let theirs = cert(&[0x7a, 0x01], &other_ca, &other_key);
        let ours = cert(&[0x7a, 0x01], &w.ca_der, &w.key);
        let unlisted = cert(&[0x7a, 0x09], &w.ca_der, &w.key);
        let t = T + 101 * DAY_MS;
        for (pem_text, at) in [(der_to_pem(&theirs), t), (der_to_pem(&ours), T + 99 * DAY_MS), (der_to_pem(&unlisted), t), ("no certificate".to_owned(), t)] {
            assert_eq!(w.ca.prune(&w.vault, &pem_text, "admin@acme.example", at).unwrap_err().code, "meet-ca-prune");
        }
        w.ca.prune(&w.vault, &der_to_pem(&ours), "admin@acme.example", t).unwrap();
        assert_eq!(listed(&w.ca), vec!["7a02".to_owned(), "7a03".to_owned()]);
        assert!(w.ca.s.pruned.iter().any(|p| p.serial == "7a01" && p.by == "admin@acme.example"));
        // 7a02 (revoked at day 80) leaves once 400 days have passed since; 7a03 (day 91) stays.
        w.ca.revoke(&w.vault, "7a04", "admin@acme.example", T + 481 * DAY_MS).unwrap();
        assert_eq!(listed(&w.ca), vec!["7a03".to_owned(), "7a04".to_owned()]);
        assert!(w.ca.s.pruned.iter().any(|p| p.serial == "7a02" && p.by == "max-lifetime"));
        assert!(w.ca.set_max_lifetime(0).is_err() && w.ca.set_max_lifetime(3651).is_err());
        w.ca.set_max_lifetime(30).unwrap();
        assert_eq!(w.ca.max_lifetime_days(), 30);
    }

    /// R4-H1: `meet-crl-size` once the signed list passes 160 KiB.
    #[test]
    fn the_size_warning_starts_past_160_kib() {
        let mut w = world("meet-ca-size", T);
        let key = w.ca.key(&w.vault).unwrap();
        assert!(!w.ca.size_warning());
        let mut n = 0u128;
        while w.ca.crl_der.len() <= CRL_SIZE_WARN {
            for _ in 0..500 {
                n += 1;
                w.ca.add_revoked(&format!("{:032x}", (0x40u128 << 120) + n), T, "admin@acme.example", None);
            }
            w.ca.sign_list(&key, T, None).unwrap();
        }
        assert!(w.ca.size_warning() && w.ca.crl().unwrap().1.size > CRL_SIZE_WARN);
    }

    /// 8.6: remove needs `elsewhere` while a relay holds a live certificate, signs a final list ending after every
    /// certificate issued, wipes the sealed key and keeps the files renamed.
    #[test]
    fn remove_ends_the_last_list_after_every_certificate() {
        let mut w = world("meet-ca-remove", T);
        let minted = names(&["meet.acme.example"]);
        w.ca.issue(&w.vault, RELAY, CertKind::Server, &server_csr(&minted), &minted, false, false, T).unwrap();
        let key = w.ca.key(&w.vault).unwrap();
        assert_eq!(w.ca.sign_list(&key, T, Some(T + 200 * DAY_MS)).unwrap().next_update, T + 200 * DAY_MS);
        let e = w.ca.remove(&mut w.vault, false, T + DAY_MS).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("meet-ca-in-use", "1 relays still use certificates from this CA. Confirm that you will sign its revocation lists elsewhere."));
        let t = T + DAY_MS;
        let r = w.ca.remove(&mut w.vault, true, t).unwrap();
        assert_eq!(r.ends, t - BACKDATE_MS + CRL_DAYS * DAY_MS);
        assert_eq!(Crl::from_pem(r.crl_pem.as_bytes()).unwrap().next_update, Some(r.ends / 1000));
        assert!(!w.vault.map.contains_key(KEY_NAME));
        assert!(MeetCa::open(&w.dir, &w.vault).is_none());
        for f in ["meet-ca", "meet-crl"] {
            assert!(w.dir.join(format!("{f}.removed-{t}.pem")).exists());
        }
        assert!(w.dir.join(format!("meet-ca.removed-{t}.json")).exists());
    }

    /// 2.4, 8.3: the record reads back; a missing or foreign key is `lost`; records that do not read back are
    /// `unreadable`; a missing list is owed and re-signed once.
    #[test]
    fn open_reads_back_and_reports_lost_or_unreadable() {
        let mut w = world("meet-ca-open", T);
        let minted = names(&["meet.acme.example"]);
        w.ca.issue(&w.vault, RELAY, CertKind::Server, &server_csr(&minted), &minted, false, false, T).unwrap();
        let info = w.ca.crl().unwrap().1;
        let back = MeetCa::open(&w.dir, &w.vault).unwrap();
        assert_eq!((back.state(), back.id(), back.rows().len(), back.signer_url()), (CaState::Ok, w.ca.id(), 1, Some("https://meet-ca.acme.example")));
        assert_eq!(back.crl().unwrap().1, info);
        assert!(!back.owed);
        let mut empty = MemVault::default();
        let mut lost = MeetCa::open(&w.dir, &empty).unwrap();
        assert_eq!(lost.state(), CaState::Lost);
        assert_eq!(lost.issue(&empty, "r_00000000000000bb", CertKind::Server, &server_csr(&minted), &minted, false, false, T).unwrap_err().code, "meet-ca-lost");
        empty.map.insert(KEY_NAME.into(), Key::generate(Curve::P256).unwrap().pkcs8().to_vec());
        assert_eq!(MeetCa::open(&w.dir, &empty).unwrap().state(), CaState::Lost);
        // A missing list: owed, re-signed once.
        std::fs::remove_file(w.dir.join(CRL_FILE)).unwrap();
        let mut again = MeetCa::open(&w.dir, &w.vault).unwrap();
        let i = again.resign(&w.vault, T + 1000).unwrap().unwrap();
        assert_eq!(i.number, info.number.next());
        assert_eq!(again.resign(&w.vault, T + 2000).unwrap(), None);
        assert!(again.resign(&w.vault, T + 61 * DAY_MS).unwrap().is_some());
        // Records that do not read back.
        std::fs::write(w.dir.join(STATE_FILE), b"{").unwrap();
        let mut bad = MeetCa::open(&w.dir, &w.vault).unwrap();
        assert_eq!(bad.state(), CaState::Unreadable);
        assert_eq!(bad.issue(&w.vault, RELAY, CertKind::Server, &server_csr(&minted), &minted, false, false, T).unwrap_err().code, "deploy-ca-needed");
        assert_eq!(bad.view(T)["state"], "unreadable");
        assert!(MeetCa::open(&tests_dir("meet-ca-none"), &w.vault).is_none());
    }

    /// R3-L3: a reported list is the console's when its SHA-256 was signed here, or its number is below the oldest
    /// kept; the console's newest list is later than an older one.
    #[test]
    fn signed_lists_are_recognized_and_ordered() {
        let mut w = world("meet-ca-signed", T);
        let first = w.ca.crl().unwrap().1;
        let key = w.ca.key(&w.vault).unwrap();
        assert!(w.ca.signed_by_me(&first.sha256, None));
        assert!(!w.ca.signed_by_me(&hex(&[0u8; 32]), None));
        for _ in 0..70 {
            w.ca.sign_list(&key, T, None).unwrap();
        }
        assert!(w.ca.signed_by_me(&hex(&[0u8; 32]), Some(&CrlNumber::from_u64(1))));
        assert!(!w.ca.signed_by_me(&hex(&[0u8; 32]), Some(&CrlNumber::from_u64(200))));
        assert!(w.ca.later_than(first.this_update, Some(&first.number)));
        let newest = w.ca.crl().unwrap().1;
        assert!(!w.ca.later_than(newest.this_update, Some(&newest.number)));
        assert!(!w.ca.later_than(newest.this_update, None));
        assert_eq!(later((T, None), (T, Some(&CrlNumber::from_u64(3)))), Ordering::Equal);
        w.ca.note_diverged("r_0123456789abcdef", T - 1000, T).unwrap();
        assert_eq!(w.ca.view(T)["diverged"]["relayId"], "r_0123456789abcdef");
        w.ca.dismiss_diverged().unwrap();
        assert!(w.ca.view(T)["diverged"].is_null());
    }

    #[test]
    fn crl_numbers_beyond_machine_integers() {
        let big = CrlNumber::from_bytes(&[&[0x40u8][..], &[0u8; 18]].concat());
        assert_eq!(big.to_string(), "1427247692705959881058285969449495136382746624");
        assert_eq!(CrlNumber::from_json(&big.to_json()), Some(big.clone()));
        assert!(big.to_json().is_string());
        assert_eq!(CrlNumber::from_u64(255).next(), CrlNumber::from_u64(256));
        assert_eq!(CrlNumber::from_json(&json!(42)).unwrap().to_json(), json!(42));
        assert_eq!(CrlNumber::default().to_string(), "0");
        assert!(CrlNumber::from_u64(9) < CrlNumber::from_u64(10) && CrlNumber::from_u64(256) > CrlNumber::from_u64(255));
        assert_eq!(CrlNumber::from_json(&json!("-1")), None);
    }

    /// 8.3, D5: the key is in no `Debug` output, answer, refusal or file.
    #[test]
    fn the_key_never_appears_in_debug_answers_or_files() {
        let (key, ca_der) = new_ca(Some(0), T + 1825 * DAY_MS);
        let sec1 = sec1_of(key.pkcs8());
        let scalar = scalar_of(&sec1);
        let pem_body: String = key_pem(key.pkcs8()).lines().filter(|l| !l.starts_with("-----")).collect();
        let needles = [hex(key.pkcs8()), crate::meet_json::b64(key.pkcs8()), crate::codec::b64u(key.pkcs8()), pem_body, hex(&scalar), crate::meet_json::b64(&scalar), crate::codec::b64u(&scalar)];
        let dir = tests_dir("meet-ca-scan");
        let mut vault = MemVault::default();
        let r = req(&ca_der, key_pem(key.pkcs8()));
        let mut texts = vec![format!("{r:?}")];
        let (mut ca, note) = MeetCa::import(&dir, &mut vault, &std_ctx(), r, "admin@acme.example", T).unwrap();
        let refused = MeetCa::import(&dir, &mut vault, &std_ctx(), req(&ca_der, key_pem(key.pkcs8())), "admin@acme.example", T).unwrap_err();
        let minted = names(&["meet.acme.example"]);
        let iss = ca.issue(&vault, RELAY, CertKind::Server, &server_csr(&minted), &minted, false, false, T).unwrap();
        let info = ca.revoke(&vault, &iss.serial, "admin@acme.example", T + 1000).unwrap();
        texts.extend([format!("{ca:?}"), format!("{note:?}"), format!("{refused:?}"), format!("{iss:?}"), format!("{info:?}"), format!("{:?}", ca.crl()), stringify(&ca.view(T))]);
        for f in [STATE_FILE, CRL_FILE, CA_FILE] {
            texts.push(std::fs::read_to_string(dir.join(f)).unwrap());
        }
        for t in &texts {
            for n in &needles {
                assert!(!t.contains(n.as_str()), "the key appears in {t}");
            }
        }
    }

    /// 13.3: the refusal words are the words vector's.
    #[test]
    fn refusals_match_the_words_vector() {
        let path = format!("{}/tests/admin_console_fleet_words_v1.json", env!("CARGO_MANIFEST_DIR"));
        let v = parse_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for (code, status, words) in REFUSALS {
            let r = &v["refusals"][*code];
            assert_eq!((r["status"].as_u64(), r["words"].as_str()), (Some(u64::from(*status)), Some(*words)), "{code}");
        }
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("meet_ca.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
