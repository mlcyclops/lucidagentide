// The FIDO Metadata Service v3 snapshot and the attestation verdict (AC-1 revision 4, 3.3 "Attestation" and "The MDS3
// snapshot", 11 I11, decision 32, R3-H2). The release ships an MDS3 blob (`data/mds3.jwt`) and the FIDO Alliance MDS
// root (`data/fido-mds-root.pem`, GlobalSign Root CA - R3), both pinned by SHA-256 here. A blob is used only when its
// JWS signature (RS256, RS384, ES256 or ES384, AC-1 section 0) verifies with the leaf of its `x5c` chain, that chain
// ends at the pinned root, every certificate in it is in date, and its `no` is greater than that of the blob in
// force. An admin may load a newer blob offline (`settings.mds`); it is kept owner-only as `console-mds.jwt`, and at
// start the newest blob of the two that verifies is used; a stored blob that does not verify raises `mds-old`. The
// relay never fetches a blob, and never fetches the certificate revocation lists the chains name: models are withdrawn
// through status reports.
//
// The verdict (steps 1 and 2, at registration): a full attestation (`packed` with `x5c`, or `tpm`, verified by
// console_webauthn.rs) whose chain ends at a root the snapshot lists for its AAGUID (`attestationRootCertificates`),
// every certificate in date. Steps 3 to 5, at every sign-in and step-up against the snapshot in force: the latest
// status report is none of the five compromise statuses; a FIPS 140 certification and hardware, non-exportable key
// protection; and, when the approved list is not empty, the AAGUID on it (the list only restricts under High).
//
// `[INFERENCE]` (L-25): the MDS3 field that names a FIPS 140 certificate. This reads it as the vector
// (admin_console_mds_v1.json, `fips_rule`) defines it: a status report whose `status` starts with
// "FIPS140_CERTIFIED_" (any report of the entry). Hardware key protection: the metadata statement's `keyProtection`
// (MDS3: an array of strings) holds "hardware" and one of "secure_element" or "tee", and neither "software" nor
// "remote_handle"; MDS3 has no other exportable marker, so those two are what "not exportable" excludes.

use crate::codec::{hex, js_trim, parse_json, sha256_hex, str_of, unb64u};
use crate::console_webauthn::{spki_verify, x509, NewPasskey, SigAlg, X509};
use crate::meet_json::{b64_strict, days_from_civil};
use crate::meet_x509::pem_blocks;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

/// The uploaded blob in the state folder.
pub const MDS_FILE: &str = "console-mds.jwt";
/// The largest blob `settings.mds` takes (3.5).
pub const MDS_MAX: usize = 16 * 1024 * 1024;
/// SHA-256 (hex, of the DER) of `data/fido-mds-root.pem`: GlobalSign Root CA - R3, the root FIDO MDS3 blobs chain to.
pub const MDS_ROOT_SHA256: &str = "cbb522d7b7f127ad6a0113865bdf1cd4102e7d0759af635a7cf4720dc963c53b";
/// SHA-256 (hex) of `data/mds3.jwt` exactly as shipped. Set by whoever pins the blob downloaded from
/// https://mds3.fidoalliance.org/ into `data/mds3.jwt`; until it matches, the shipped blob is never used and Overview
/// shows `mds-old` (the test `shipped_blob_is_pinned_and_verifies` fails).
pub const MDS3_SHA256: &str = "d2ad4e42a8afbd74a34b3e997ae46d43df9e046f8a5bf1feda97206d8c84e0bb";
/// The five status reports that withdraw a model (3.3 step 3).
pub const BAD_STATUSES: [&str; 5] = ["REVOKED", "USER_VERIFICATION_BYPASS", "ATTESTATION_KEY_COMPROMISE", "USER_KEY_REMOTE_COMPROMISE", "USER_KEY_PHYSICAL_COMPROMISE"];
const FIPS_PREFIX: &str = "FIPS140_CERTIFIED_";
const ROOT_PEM: &str = include_str!("../data/fido-mds-root.pem");
const SHIPPED: &[u8] = include_bytes!("../data/mds3.jwt");
const DAY_MS: i64 = 86_400_000;
/// A snapshot more than this past its `nextUpdate` is old (`mds-old`).
const OLD_MS: i64 = 90 * DAY_MS;
/// At most this many certificates in a blob's `x5c`.
const CHAIN_MAX: usize = 8;

/// One authenticator model of a snapshot.
#[derive(Clone, Debug)]
struct Entry {
    description: String,
    /// `attestationRootCertificates`, DER.
    roots: Vec<Vec<u8>>,
    /// The latest status report's `status` (greatest `effectiveDate`, ties to the later report), "" without one.
    status: String,
    /// A status report names a FIPS 140 certification.
    fips: bool,
    /// Hardware, non-exportable key protection.
    hardware: bool,
}

/// A verified MDS3 blob: its serial, `nextUpdate` (YYYY-MM-DD), the SHA-256 (hex) of the blob as given, whether it
/// was uploaded (`console-mds.jwt`) or shipped, and its models by AAGUID (lower-case hyphenated).
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub no: u64,
    pub next_update: String,
    pub sha256: String,
    pub uploaded: bool,
    entries: Arc<HashMap<String, Entry>>,
}

impl Snapshot {
    /// More than 90 days past `nextUpdate` at `now_ms` (`mds-old`).
    pub fn old(&self, now_ms: i64) -> bool {
        date_ms(&self.next_update).is_none_or(|t| now_ms > t + OLD_MS)
    }

    /// The model's description, when the snapshot lists the AAGUID.
    pub fn description(&self, aaguid: &str) -> Option<String> {
        self.entries.get(&aaguid.to_ascii_lowercase()).map(|e| e.description.clone())
    }

    /// Step 4: the model's signed metadata shows a FIPS 140 certification and hardware, non-exportable key
    /// protection.
    pub fn fips_hardware(&self, aaguid: &str) -> bool {
        self.entries.get(&aaguid.to_ascii_lowercase()).is_some_and(|e| e.fips && e.hardware)
    }

    fn entry(&self, aaguid: &str) -> Option<&Entry> {
        self.entries.get(aaguid)
    }
}

/// "YYYY-MM-DD" as milliseconds since the epoch, or None.
fn date_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r).filter(|t| t.bytes().all(|c| c.is_ascii_digit())).and_then(|t| t.parse().ok()) };
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m as u32, d as u32) * DAY_MS)
}

/// An AAGUID as MDS3 and the approved list write it: lower-case hex, hyphenated 8-4-4-4-12.
pub fn aaguid_text(a: &[u8; 16]) -> String {
    format!("{}-{}-{}-{}-{}", hex(&a[0..4]), hex(&a[4..6]), hex(&a[6..8]), hex(&a[8..10]), hex(&a[10..16]))
}

/// A lower-case hyphenated AAGUID text.
fn is_aaguid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) })
}

fn on_list(list: &[String], aaguid: &str) -> bool {
    list.iter().any(|a| a.eq_ignore_ascii_case(aaguid))
}

/// One model of the payload's `entries`, or None (no AAGUID, a FIDO U2F or UAF entry, or no metadata statement).
fn read_entry(e: &Value) -> Option<(String, Entry)> {
    let aaguid = str_of(e.get("aaguid"))?.to_ascii_lowercase();
    if !is_aaguid(&aaguid) {
        return None;
    }
    let ms = e.get("metadataStatement")?.as_object()?;
    let description = str_of(ms.get("description")).unwrap_or_default().to_owned();
    let roots: Vec<Vec<u8>> = ms
        .get("attestationRootCertificates")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|r| str_of(Some(r)).and_then(|t| b64_strict(&t.split_whitespace().collect::<String>()))).collect())
        .unwrap_or_default();
    let protection: Vec<&str> = ms.get("keyProtection").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let has = |k: &str| protection.contains(&k);
    let hardware = has("hardware") && (has("secure_element") || has("tee")) && !has("software") && !has("remote_handle");
    let mut latest: Option<(&str, &str)> = None;
    let mut fips = false;
    for r in e.get("statusReports").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let status = str_of(r.get("status")).unwrap_or_default();
        let date = str_of(r.get("effectiveDate")).unwrap_or_default();
        fips |= status.starts_with(FIPS_PREFIX);
        if latest.is_none_or(|(d, _)| date >= d) {
            latest = Some((date, status));
        }
    }
    let status = latest.map(|(_, s)| s.to_owned()).unwrap_or_default();
    Some((aaguid, Entry { description, roots, status, fips, hardware }))
}

/// `chain` (leaf first, `ders` its DER) ends at one of `roots`: each certificate issued by the next one (a CA), the
/// last issued by a root or a root itself, every signature algorithm one AC-1 section 0 takes. The index of that root.
fn chain_ends_at(chain: &[X509], ders: &[Vec<u8>], roots: &[(Vec<u8>, X509)]) -> Option<usize> {
    for (i, c) in chain.iter().enumerate() {
        if let Some(r) = roots.iter().position(|(d, _)| *d == ders[i]) {
            return Some(r);
        }
        if !c.fips_signature() {
            return None;
        }
        match chain.get(i + 1) {
            Some(next) => {
                if !(next.cert.ca && c.cert.issued_by(&next.cert)) {
                    return None;
                }
            }
            None => return roots.iter().position(|(_, r)| c.cert.issued_by(&r.cert)),
        }
    }
    None
}

const NOT_A_BLOB: &str = "it is not a metadata file";

/// A blob checked against `root_der` at `now_ms`: the JWS signature (RS256, RS384, ES256 or ES384) by the leaf of
/// its `x5c`, the chain to the root (each certificate issued by the next, the last by the root or the root itself),
/// every certificate and the root in date, and a readable payload. The `<reason>` of `mds-refused` when not.
pub fn verify_blob(jwt: &[u8], root_der: &[u8], now_ms: i64) -> Result<Snapshot, String> {
    if jwt.len() > MDS_MAX {
        return Err("it is larger than 16 MiB".into());
    }
    let text = js_trim(std::str::from_utf8(jwt).map_err(|_| NOT_A_BLOB.to_string())?);
    let parts: Vec<&str> = text.split('.').collect();
    let [head, body, signature] = parts.as_slice() else { return Err(NOT_A_BLOB.into()) };
    let json_of = |part: &str| -> Option<Value> {
        let bytes = unb64u(part)?;
        parse_json(std::str::from_utf8(&bytes).ok()?).filter(Value::is_object)
    };
    let header_value = json_of(head).ok_or_else(|| NOT_A_BLOB.to_string())?;
    let header: &Map<String, Value> = header_value.as_object().ok_or_else(|| NOT_A_BLOB.to_string())?;
    let alg = str_of(header.get("alg")).and_then(SigAlg::from_jws).ok_or_else(|| "its signature algorithm is not one the console takes".to_string())?;
    let ders: Vec<Vec<u8>> = header
        .get("x5c")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty() && a.len() <= CHAIN_MAX)
        .and_then(|a| a.iter().map(|c| str_of(Some(c)).and_then(b64_strict)).collect::<Option<Vec<_>>>())
        .ok_or_else(|| "its certificate chain is missing or does not read".to_string())?;
    let chain: Vec<X509> = ders.iter().map(|d| x509(d)).collect::<Option<_>>().ok_or_else(|| "its certificate chain is missing or does not read".to_string())?;
    let sig = unb64u(signature).ok_or_else(|| NOT_A_BLOB.to_string())?;
    let signed = &text.as_bytes()[..head.len() + 1 + body.len()];
    if !spki_verify(&chain[0].cert.spki, alg, true, signed, &sig) {
        return Err("its signature does not verify".into());
    }
    let root = x509(root_der).ok_or_else(|| "the FIDO Alliance root this relay was built with does not read".to_string())?;
    if chain_ends_at(&chain, &ders, &[(root_der.to_vec(), root.clone())]).is_none() {
        return Err("it is not signed through the FIDO Alliance root".into());
    }
    let now_s = now_ms.div_euclid(1000);
    if !chain.iter().all(|c| c.in_date(now_s)) || !root.in_date(now_s) {
        return Err("a certificate in its chain is out of date".into());
    }
    let payload_value = json_of(body).ok_or_else(|| NOT_A_BLOB.to_string())?;
    let payload: &Map<String, Value> = payload_value.as_object().ok_or_else(|| NOT_A_BLOB.to_string())?;
    let no = payload.get("no").and_then(Value::as_u64).ok_or_else(|| NOT_A_BLOB.to_string())?;
    let next_update = str_of(payload.get("nextUpdate")).filter(|d| date_ms(d).is_some()).ok_or_else(|| NOT_A_BLOB.to_string())?.to_owned();
    let list = payload.get("entries").and_then(Value::as_array).ok_or_else(|| NOT_A_BLOB.to_string())?;
    let mut entries = HashMap::new();
    for e in list {
        if let Some((aaguid, entry)) = read_entry(e) {
            entries.entry(aaguid).or_insert(entry);
        }
    }
    Ok(Snapshot { no, next_update, sha256: sha256_hex(jwt), uploaded: false, entries: Arc::new(entries) })
}

/// The pinned root: the first certificate of `data/fido-mds-root.pem` when its SHA-256 is `MDS_ROOT_SHA256`.
pub fn pinned_root() -> Option<Vec<u8>> {
    let der = pem_blocks(ROOT_PEM.as_bytes(), "CERTIFICATE").into_iter().next()?.1;
    (sha256_hex(&der) == MDS_ROOT_SHA256).then_some(der)
}

/// The MDS3 snapshot in force, and whether the stored `console-mds.jwt` did not verify at start.
pub struct Mds {
    pub current: Option<Snapshot>,
    pub stored_refused: bool,
    root: Vec<u8>,
}

impl Mds {
    /// At start: the newest (greatest `no`) of the shipped blob (`data/mds3.jwt`, used only when its SHA-256 is
    /// `MDS3_SHA256`) and the stored `console-mds.jwt` that verify against the pinned root at `now_ms`. A stored blob
    /// that does not read or verify sets `stored_refused` (`mds-old`) and the shipped one is used.
    pub fn open(state_dir: &Path, now_ms: i64) -> Mds {
        let root = pinned_root().unwrap_or_default();
        let shipped = (sha256_hex(SHIPPED) == MDS3_SHA256).then_some(SHIPPED);
        Mds::load(root, shipped, state_dir, now_ms)
    }

    fn load(root: Vec<u8>, shipped: Option<&[u8]>, state_dir: &Path, now_ms: i64) -> Mds {
        let shipped = shipped.and_then(|b| verify_blob(b, &root, now_ms).ok());
        let mut stored_refused = false;
        let stored = match std::fs::read(state_dir.join(MDS_FILE)) {
            Ok(bytes) => match verify_blob(&bytes, &root, now_ms) {
                Ok(mut s) => {
                    s.uploaded = true;
                    Some(s)
                }
                Err(_) => {
                    stored_refused = true;
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => {
                stored_refused = true;
                None
            }
        };
        let current = match (shipped, stored) {
            (Some(a), Some(b)) => Some(if b.no > a.no { b } else { a }),
            (a, b) => a.or(b),
        };
        Mds { current, stored_refused, root }
    }

    /// A blob an admin loads, checked: at most 16 MiB, `verify_blob` against the pinned root, and `no` greater than
    /// the snapshot in force. The `<reason>` of `mds-refused` when not.
    fn admit(&self, blob: &[u8], now_ms: i64) -> Result<Snapshot, String> {
        let s = verify_blob(blob, &self.root, now_ms)?;
        if let Some(c) = &self.current {
            if s.no <= c.no {
                return Err(format!("its number {} is not newer than the metadata in force (number {})", s.no, c.no));
            }
        }
        Ok(s)
    }

    /// `settings.mds`: `admit`, then the blob written owner-only as `console-mds.jwt` and put in force.
    pub fn install(&mut self, state_dir: &Path, blob: &[u8], now_ms: i64) -> Result<Snapshot, String> {
        let mut s = self.admit(blob, now_ms)?;
        crate::store::write_private(&state_dir.join(MDS_FILE), blob).map_err(|e| format!("it could not be saved ({e})"))?;
        s.uploaded = true;
        self.current = Some(s.clone());
        self.stored_refused = false;
        Ok(s)
    }

    /// `mds-old`: the stored blob did not verify at start, no snapshot is in force, or the one in force is more than
    /// 90 days past its `nextUpdate`.
    pub fn old(&self, now_ms: i64) -> bool {
        self.stored_refused || self.current.as_ref().is_none_or(|s| s.old(now_ms))
    }

    /// `open` with `root_der` in place of the pinned root and `shipped` in place of `data/mds3.jwt` (tests).
    #[cfg(test)]
    pub fn with_root(root_der: Vec<u8>, shipped: Option<&[u8]>, state_dir: &Path, now_ms: i64) -> Mds {
        Mds::load(root_der, shipped, state_dir, now_ms)
    }

    /// Puts `s` in force (tests).
    #[cfg(test)]
    pub fn set(&mut self, s: Snapshot) {
        self.current = Some(s);
        self.stored_refused = false;
    }
}

/// The attestation verdict stored with a WebAuthn method (3.3): `{aaguid, description, fips, hardwareKey, listed,
/// mdsNo}` and the SHA-256 (hex) of each `x5c` certificate, never the certificates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub aaguid: String,
    pub description: String,
    pub fips: bool,
    pub hardware_key: bool,
    pub listed: bool,
    pub mds_no: u64,
    pub chain_sha256: Vec<String>,
}

impl Verdict {
    pub fn to_value(&self) -> Value {
        json!({
            "aaguid": self.aaguid, "description": self.description, "fips": self.fips, "hardwareKey": self.hardware_key,
            "listed": self.listed, "mdsNo": self.mds_no, "chainSha256": self.chain_sha256,
        })
    }

    /// A stored verdict, read strictly: exactly the keys `to_value` writes, of their types.
    pub fn from_value(v: &Value) -> Option<Verdict> {
        let o = v.as_object()?;
        let keys = ["aaguid", "description", "fips", "hardwareKey", "listed", "mdsNo", "chainSha256"];
        if !crate::codec::exact_keys(o, &keys, &keys) {
            return None;
        }
        let aaguid = str_of(o.get("aaguid")).filter(|a| is_aaguid(a))?.to_owned();
        let chain = o.get("chainSha256")?.as_array().filter(|a| !a.is_empty() && a.len() <= CHAIN_MAX)?;
        let chain_sha256 = chain
            .iter()
            .map(|h| str_of(Some(h)).filter(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        Some(Verdict {
            aaguid,
            description: str_of(o.get("description"))?.to_owned(),
            fips: o.get("fips")?.as_bool()?,
            hardware_key: o.get("hardwareKey")?.as_bool()?,
            listed: o.get("listed")?.as_bool()?,
            mds_no: o.get("mdsNo")?.as_u64()?,
            chain_sha256,
        })
    }

    /// What the page shows: `{description, fips, hardwareKey, listed}`, `listed` against the approved list now.
    pub fn view(&self, list: &[String]) -> Value {
        json!({ "description": self.description, "fips": self.fips, "hardwareKey": self.hardware_key, "listed": on_list(list, &self.aaguid) })
    }
}

/// Steps 1 and 2 at registration, with the reason when there is no verdict: "none" or "self" (no verified full
/// attestation: "self" for `packed`, "none" for any other format), "unknown" (no snapshot, or the snapshot does not
/// list the AAGUID), "root" (the chain does not end at a root listed for the AAGUID), "date" (a certificate out of
/// date at `now_ms`).
pub fn assess(new: &NewPasskey, mds: Option<&Snapshot>, list: &[String], now_ms: i64) -> Result<Verdict, &'static str> {
    let chain = &new.attestation.chain;
    if chain.is_empty() {
        return Err(if new.attestation.fmt == "packed" { "self" } else { "none" });
    }
    let snap = mds.ok_or("unknown")?;
    let aaguid = aaguid_text(&new.aaguid);
    let entry = snap.entry(&aaguid).ok_or("unknown")?;
    let certs: Vec<X509> = chain.iter().map(|d| x509(d)).collect::<Option<_>>().ok_or("root")?;
    let roots: Vec<(Vec<u8>, X509)> = entry.roots.iter().filter_map(|d| x509(d).map(|x| (d.clone(), x))).collect();
    let at = chain_ends_at(&certs, chain, &roots).ok_or("root")?;
    let now_s = now_ms.div_euclid(1000);
    if !certs.iter().all(|c| c.in_date(now_s)) || !roots[at].1.in_date(now_s) {
        return Err("date");
    }
    Ok(Verdict {
        listed: on_list(list, &aaguid),
        aaguid,
        description: entry.description.clone(),
        fips: entry.fips,
        hardware_key: entry.hardware,
        mds_no: snap.no,
        chain_sha256: chain.iter().map(|d| sha256_hex(d)).collect(),
    })
}

/// At registration (steps 1 and 2): Some only for a full attestation whose chain ends at a root the snapshot lists for
/// the AAGUID, every certificate in date. `list`: the approved AAGUIDs (lower-case hyphenated).
pub fn verdict(new: &NewPasskey, mds: Option<&Snapshot>, list: &[String], now_ms: i64) -> Option<Verdict> {
    assess(new, mds, list, now_ms).ok()
}

/// Why a stored verdict is not attested now (steps 3 to 5 against the snapshot in force), or None when it is:
/// "unknown" (no snapshot in force, or it no longer lists the AAGUID), "status" (the latest status report is one of
/// the five), "fips" (no FIPS 140 certification), "key-protection" (no hardware, non-exportable key protection),
/// "not-listed" (a non-empty approved list without the AAGUID).
pub fn why_not(v: &Verdict, mds: Option<&Snapshot>, list: &[String]) -> Option<&'static str> {
    let Some(e) = mds.and_then(|s| s.entry(&v.aaguid)) else { return Some("unknown") };
    if BAD_STATUSES.contains(&e.status.as_str()) {
        return Some("status");
    }
    if !e.fips {
        return Some("fips");
    }
    if !e.hardware {
        return Some("key-protection");
    }
    if !list.is_empty() && !on_list(list, &v.aaguid) {
        return Some("not-listed");
    }
    None
}

/// Steps 3 to 5 at every sign-in and step-up against the snapshot in force (R3-H2): the latest status not one of the
/// five compromise statuses, a FIPS 140 certification and hardware, non-exportable key protection, and on `list` when
/// it is not empty. The list only restricts.
pub fn attested(v: &Verdict, mds: Option<&Snapshot>, list: &[String]) -> bool {
    why_not(v, mds, list).is_none()
}

/// Standard only: an approved security key though step 4 fails: the AAGUID on `list`, the snapshot in force listing
/// it with no compromise status, and no FIPS certification or no hardware key protection. Feeds `aaguids-relaxed`.
/// Never under High: there the list only restricts (R3-H2).
pub fn relaxed(v: &Verdict, mds: Option<&Snapshot>, list: &[String], high: bool) -> bool {
    if high {
        return false;
    }
    let Some(e) = mds.and_then(|s| s.entry(&v.aaguid)) else { return false };
    on_list(list, &v.aaguid) && !BAD_STATUSES.contains(&e.status.as_str()) && !(e.fips && e.hardware)
}

/// A snapshot for tests: each (AAGUID, FIPS and hardware key protection, compromised) lists the testkit's attestation
/// root (`console_webauthn::testkit::test_root_der`); `no` 1, `nextUpdate` 2099-12-31.
#[cfg(test)]
pub fn test_snapshot(entries: &[(&str, bool, bool)]) -> Snapshot {
    let root = crate::console_webauthn::testkit::test_root_der();
    let map = entries
        .iter()
        .map(|(aaguid, fips_hardware, compromised)| {
            let entry = Entry {
                description: format!("Test security key {aaguid}"),
                roots: vec![root.clone()],
                status: if *compromised { "ATTESTATION_KEY_COMPROMISE" } else { "FIDO_CERTIFIED_L1" }.to_owned(),
                fips: *fips_hardware,
                hardware: *fips_hardware,
            };
            (aaguid.to_ascii_lowercase(), entry)
        })
        .collect();
    Snapshot { no: 1, next_update: "2099-12-31".into(), sha256: String::new(), uploaded: false, entries: Arc::new(map) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::b64u;
    use crate::console_webauthn::testkit::{self, Authenticator};
    use crate::console_webauthn::verify_registration;

    const RP: &str = "relay.example";
    const SITE: &str = "https://relay.example";
    const AAGUID: [u8; 16] = [0x11; 16];

    fn now() -> i64 {
        days_from_civil(2026, 11, 17) * DAY_MS
    }

    fn full(aaguid: [u8; 16]) -> NewPasskey {
        let mut a = Authenticator::new(31);
        let ch = [7u8; 32];
        verify_registration(RP, SITE, &ch, &a.register_full(RP, SITE, &ch, aaguid, Some(true)), true).expect("registers")
    }

    fn snap_of(entries: Vec<(String, Entry)>) -> Snapshot {
        Snapshot { no: 7, next_update: "2099-12-31".into(), sha256: String::new(), uploaded: false, entries: Arc::new(entries.into_iter().collect()) }
    }

    #[test]
    fn full_attestation_with_a_listed_root_and_fips_is_attested() {
        let new = full(AAGUID);
        let id = aaguid_text(&AAGUID);
        assert_eq!(id, "11111111-1111-1111-1111-111111111111");
        let s = test_snapshot(&[(&id, true, false)]);
        let v = verdict(&new, Some(&s), &[], now()).expect("a verdict");
        assert_eq!(v.aaguid, id);
        assert_eq!(v.chain_sha256, vec![sha256_hex(&new.attestation.chain[0])]);
        assert!(v.fips && v.hardware_key && !v.listed && v.mds_no == 1);
        assert!(attested(&v, Some(&s), &[]));
        assert!(attested(&v, Some(&s), &[id.to_uppercase()]));
        assert!(!relaxed(&v, Some(&s), std::slice::from_ref(&id), false));
        // Round trip of the stored form, and the view.
        assert_eq!(Verdict::from_value(&v.to_value()), Some(v.clone()));
        assert_eq!(v.view(std::slice::from_ref(&id)), json!({ "description": format!("Test security key {id}"), "fips": true, "hardwareKey": true, "listed": true }));
        let mut extra = v.to_value();
        extra["certificates"] = json!([]);
        assert_eq!(Verdict::from_value(&extra), None);
        // No snapshot in force: no verdict, and a stored verdict is not attested.
        assert_eq!(assess(&new, None, &[], now()), Err("unknown"));
        assert!(!attested(&v, None, &[]));
    }

    #[test]
    fn self_and_none_are_never_attested() {
        let id = aaguid_text(&[0u8; 16]);
        let s = test_snapshot(&[(&id, true, false)]);
        let mut a = Authenticator::new(32);
        let ch = [8u8; 32];
        for (packed, why) in [(false, "none"), (true, "self")] {
            let new = verify_registration(RP, SITE, &ch, &a.register(RP, SITE, &ch, packed), true).unwrap();
            assert_eq!(assess(&new, Some(&s), &[], now()), Err(why));
        }
    }

    #[test]
    fn roots_aaguids_and_dates_decide_the_verdict() {
        let new = full(AAGUID);
        let id = aaguid_text(&AAGUID);
        // The snapshot does not list the AAGUID.
        assert_eq!(assess(&new, Some(&test_snapshot(&[("22222222-2222-2222-2222-222222222222", true, false)])), &[], now()), Err("unknown"));
        // A root not listed for the AAGUID.
        let other = p256::ecdsa::SigningKey::from_slice(&[0x77u8; 32]).unwrap();
        let bc = testkit::x509_ext(&[0x55, 0x1d, 0x13], true, &testkit::der(0x30, &testkit::der(0x01, &[0xff])));
        let other_root = testkit::x509_cert(9, &testkit::root_name(), &testkit::root_name(), &testkit::p256_spki(&other), &[bc], &other, None);
        let entry = Entry { description: "Other".into(), roots: vec![other_root], status: String::new(), fips: true, hardware: true };
        assert_eq!(assess(&new, Some(&snap_of(vec![(id.clone(), entry)])), &[], now()), Err("root"));
        // Every certificate in date at registration.
        let s = test_snapshot(&[(&id, true, false)]);
        assert_eq!(assess(&new, Some(&s), &[], days_from_civil(2050, 1, 2) * DAY_MS), Err("date"));
        assert_eq!(assess(&new, Some(&s), &[], days_from_civil(2019, 12, 31) * DAY_MS), Err("date"));
    }

    #[test]
    fn steps_three_to_five_are_checked_again_at_every_sign_in() {
        let new = full(AAGUID);
        let id = aaguid_text(&AAGUID);
        let v = verdict(&new, Some(&test_snapshot(&[(&id, true, false)])), &[], now()).unwrap();
        // A later compromise status: unattested, and not relaxed either.
        let compromised = test_snapshot(&[(&id, true, true)]);
        assert_eq!(why_not(&v, Some(&compromised), &[]), Some("status"));
        assert!(!relaxed(&v, Some(&compromised), std::slice::from_ref(&id), false));
        for status in BAD_STATUSES {
            let entry = Entry { description: String::new(), roots: Vec::new(), status: status.into(), fips: true, hardware: true };
            assert!(!attested(&v, Some(&snap_of(vec![(id.clone(), entry)])), &[]));
        }
        // A listed AAGUID without FIPS, and a FIPS model with software key protection: never attested (R3-H2).
        let no_fips = Entry { description: String::new(), roots: Vec::new(), status: String::new(), fips: false, hardware: true };
        assert_eq!(why_not(&v, Some(&snap_of(vec![(id.clone(), no_fips)])), std::slice::from_ref(&id)), Some("fips"));
        let software = Entry { description: String::new(), roots: Vec::new(), status: String::new(), fips: true, hardware: false };
        assert_eq!(why_not(&v, Some(&snap_of(vec![(id.clone(), software)])), std::slice::from_ref(&id)), Some("key-protection"));
        // A non-empty list refuses an unlisted FIPS hardware model; the list only restricts.
        let good = test_snapshot(&[(&id, true, false)]);
        assert_eq!(why_not(&v, Some(&good), &["22222222-2222-2222-2222-222222222222".into()]), Some("not-listed"));
        // Under Standard a listed model without FIPS is relaxed; unlisted it is not.
        let plain = test_snapshot(&[(&id, false, false)]);
        assert!(!attested(&v, Some(&plain), std::slice::from_ref(&id)));
        assert!(relaxed(&v, Some(&plain), std::slice::from_ref(&id), false));
        assert!(!relaxed(&v, Some(&plain), std::slice::from_ref(&id), true));
        assert!(!relaxed(&v, Some(&plain), &[], false));
        // A newer snapshot without the AAGUID: unattested.
        assert_eq!(why_not(&v, Some(&test_snapshot(&[])), &[]), Some("unknown"));
    }

    #[test]
    fn entries_read_status_fips_and_key_protection() {
        let e = json!({
            "aaguid": "AAAAAAAA-0000-0000-0000-000000000001",
            "metadataStatement": { "description": "Key", "attestationRootCertificates": [], "keyProtection": ["hardware", "secure_element"] },
            "statusReports": [
                { "status": "FIPS140_CERTIFIED_L2", "effectiveDate": "2024-01-01", "certificateNumber": "4000", "certificationPolicyVersion": "FIPS 140-3" },
                { "status": "FIDO_CERTIFIED_L1", "effectiveDate": "2025-01-01" },
                { "status": "UPDATE_AVAILABLE", "effectiveDate": "2025-01-01" },
            ],
        });
        let (id, entry) = read_entry(&e).unwrap();
        assert_eq!(id, "aaaaaaaa-0000-0000-0000-000000000001");
        assert!(entry.fips && entry.hardware);
        assert_eq!(entry.status, "UPDATE_AVAILABLE");
        for kp in [json!(["hardware", "secure_element", "software"]), json!(["hardware", "remote_handle", "tee"]), json!(["hardware"]), json!(["tee"]), json!(5)] {
            let mut e2 = e.clone();
            e2["metadataStatement"]["keyProtection"] = kp;
            assert!(!read_entry(&e2).unwrap().1.hardware);
        }
        let mut no_fips = e.clone();
        no_fips["statusReports"][0]["status"] = json!("FIDO_CERTIFIED_L2");
        assert!(!read_entry(&no_fips).unwrap().1.fips);
        assert!(read_entry(&json!({ "aaid": "0001#0001", "metadataStatement": {} })).is_none());
    }

    #[test]
    fn old_is_more_than_90_days_past_next_update() {
        let mut s = test_snapshot(&[]);
        s.next_update = "2026-01-01".into();
        let edge = days_from_civil(2026, 4, 1) * DAY_MS;
        assert!(!s.old(edge));
        assert!(s.old(edge + 1));
        let mut m = Mds { current: None, stored_refused: false, root: Vec::new() };
        assert!(m.old(edge));
        m.set(s);
        assert!(!m.old(edge));
        m.stored_refused = true;
        assert!(m.old(edge));
    }

    #[test]
    fn the_pinned_root_is_globalsign_root_r3() {
        let der = pinned_root().expect("data/fido-mds-root.pem is the pinned root");
        // GlobalSign publishes this SHA-1 thumbprint for Root R3 (support.globalsign.com, "GlobalSign Root Certificates").
        assert_eq!(hex(aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA1_FOR_LEGACY_USE_ONLY, &der).as_ref()), "d69b561148f01c77c54578c10926df5b856976ad");
        let root = x509(&der).unwrap();
        assert!(root.v3 && root.cert.ca && root.cert.issued_by(&root.cert));
        assert!(root.in_date(now() / 1000));
    }

    #[test]
    fn shipped_blob_is_pinned_and_verifies() {
        assert_eq!(sha256_hex(SHIPPED), MDS3_SHA256, "set MDS3_SHA256 to the SHA-256 of data/mds3.jwt");
        let s = verify_blob(SHIPPED, &pinned_root().unwrap(), crate::codec::now_ms()).expect("the shipped blob verifies against the pinned root");
        assert!(!s.entries.is_empty());
    }

    #[test]
    fn no_dashes_in_words() {
        let words = [
            "it is larger than 16 MiB",
            NOT_A_BLOB,
            "its signature algorithm is not one the console takes",
            "its certificate chain is missing or does not read",
            "its signature does not verify",
            "the FIDO Alliance root this relay was built with does not read",
            "it is not signed through the FIDO Alliance root",
            "a certificate in its chain is out of date",
            "its number 1 is not newer than the metadata in force (number 2)",
        ];
        for w in words {
            assert!(!w.contains('\u{2014}') && !w.contains('\u{2013}'));
        }
    }

    // ── admin_console_mds_v1.json (I11) ──────────────────────────────────────────────────────────────────────

    fn vector() -> Value {
        let path = format!("{}/tests/admin_console_mds_v1.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    fn pem_der(v: &Value) -> Vec<u8> {
        pem_blocks(v.as_str().expect("a PEM").as_bytes(), "CERTIFICATE").into_iter().next().expect("a certificate").1
    }

    fn blob(v: &Value, name: &str) -> Vec<u8> {
        v["blobs"][name]["jwt"].as_str().unwrap_or_else(|| panic!("blob {name}")).as_bytes().to_vec()
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lucid-mds-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn statements(v: &Value) -> HashMap<String, NewPasskey> {
        let (rp, origin) = (v["rp_id"].as_str().unwrap(), v["origin"].as_str().unwrap());
        let mut out = HashMap::new();
        for s in v["statements"].as_array().unwrap() {
            let name = s["name"].as_str().unwrap();
            let client_data = unb64u(s["clientDataJSON_b64url"].as_str().unwrap()).unwrap();
            let cd = parse_json(std::str::from_utf8(&client_data).unwrap()).unwrap();
            let challenge = unb64u(cd["challenge"].as_str().unwrap()).unwrap();
            assert_eq!(sha256_hex(&client_data), s["clientDataHash_hex"].as_str().unwrap(), "{name}");
            let id = s["credentialId_b64url"].as_str().unwrap();
            let credential = json!({
                "id": id, "rawId": id, "type": "public-key",
                "response": { "clientDataJSON": b64u(&client_data), "attestationObject": s["attestationObject_b64url"] },
            });
            // `verified`: the registration verifies (never refused); `why` "self" or "none": no full attestation.
            let got = verify_registration(rp, origin, &challenge, &credential, false);
            assert_eq!(got.is_ok(), s["expect"]["verified"].as_bool().unwrap(), "{name}: {:?}", got.as_ref().err());
            let Ok(p) = got else { continue };
            assert_eq!(p.attestation.fmt, s["fmt"].as_str().unwrap(), "{name}");
            assert_eq!(aaguid_text(&p.aaguid), s["aaguid"].as_str().unwrap(), "{name}");
            let hashes: Vec<String> = p.attestation.chain.iter().map(|d| sha256_hex(d)).collect();
            assert_eq!(json!(hashes), s["chain_sha256_hex"], "{name}");
            match s["expect"]["why"].as_str() {
                Some(why) => assert_eq!(assess(&p, None, &[], 0), Err(why), "{name}"),
                None => assert!(!p.attestation.chain.is_empty(), "{name}"),
            }
            out.insert(name.to_owned(), p);
        }
        out
    }

    #[test]
    fn vector_statements_verify_as_expected() {
        let v = vector();
        let got = statements(&v);
        for name in ["packed-full", "tpm", "packed-self", "none"] {
            assert!(got.contains_key(name), "the vector has {name}");
        }
        assert_eq!(got["tpm"].attestation.fmt, "tpm");
        assert!(!got["tpm"].attestation.chain.is_empty() && !got["packed-full"].attestation.chain.is_empty());
        assert!(got["packed-self"].attestation.chain.is_empty() && got["none"].attestation.chain.is_empty());
    }

    #[test]
    fn vector_verdicts() {
        let v = vector();
        let now_ms = v["now"].as_i64().unwrap() * 1000;
        let root = pem_der(&v["root_pem"]);
        assert_eq!(sha256_hex(&root), v["root_sha256_hex"].as_str().unwrap());
        let passkeys = statements(&v);
        for c in v["verdicts"].as_array().unwrap() {
            let (statement, blob_name, profile) = (c["statement"].as_str().unwrap(), c["blob"].as_str().unwrap(), c["profile"].as_str().unwrap());
            let label = format!("{statement} with {blob_name} under {profile}, list {}", c["aaguids"]);
            let snap = verify_blob(&blob(&v, blob_name), &root, now_ms).unwrap_or_else(|e| panic!("{label}: {e}"));
            let list: Vec<String> = c["aaguids"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect();
            let high = profile == "high";
            let e = &c["expect"];
            let assessed = assess(&passkeys[statement], Some(&snap), &list, now_ms);
            let (ok, why) = match &assessed {
                Ok(vd) => {
                    let w = why_not(vd, Some(&snap), &list);
                    let ok = w.is_none() || relaxed(vd, Some(&snap), &list, high);
                    (ok, if ok { None } else { w })
                }
                Err(w) => (false, Some(*w)),
            };
            assert_eq!(ok, e["attested"].as_bool().unwrap(), "{label}: attested ({why:?})");
            if let Some(r) = e["relaxed"].as_bool() {
                assert_eq!(assessed.as_ref().is_ok_and(|vd| relaxed(vd, Some(&snap), &list, high)), r, "{label}: relaxed");
            }
            if high && e.get("why").is_some() {
                assert_eq!(why, e["why"].as_str(), "{label}: why");
            }
            // The vector's fips and hardwareKey are false when steps 1 to 3 fail; the stored verdict (steps 1 and 2)
            // is compared only where they passed.
            let steps_passed = matches!(e["why"].as_str(), None | Some("fips" | "key-protection" | "not-listed"));
            if let (Ok(vd), true) = (&assessed, steps_passed) {
                let fields = [
                    ("aaguid", json!(vd.aaguid)),
                    ("description", json!(vd.description)),
                    ("fips", json!(vd.fips)),
                    ("hardwareKey", json!(vd.hardware_key)),
                    ("listed", json!(vd.listed)),
                    ("mdsNo", json!(vd.mds_no)),
                ];
                for (k, got) in fields {
                    if !e[k].is_null() {
                        assert_eq!(got, e[k], "{label}: {k}");
                    }
                }
            }
        }
        // A verdict stored under the shipped blob turns unattested at the next sign-in once the newer blob, with a
        // compromise status for its model, is in force; the stored form round-trips.
        let shipped = verify_blob(&blob(&v, "shipped"), &root, now_ms).unwrap();
        let newer = verify_blob(&blob(&v, "newer"), &root, now_ms).unwrap();
        let stored = verdict(&passkeys["packed-full"], Some(&shipped), &[], now_ms).expect("a verdict");
        let stored = Verdict::from_value(&stored.to_value()).unwrap();
        assert!(attested(&stored, Some(&shipped), &[]));
        assert_eq!(why_not(&stored, Some(&newer), &[]), Some("status"));
    }

    #[test]
    fn vector_blob_cases() {
        let v = vector();
        let now_ms = v["now"].as_i64().unwrap() * 1000;
        let root = pem_der(&v["root_pem"]);
        let dir = temp("cases");
        for c in v["blob_cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let mut m = Mds::with_root(root.clone(), None, &dir, now_ms);
            assert!(m.current.is_none());
            if let Some(no) = c["in_force_no"].as_u64() {
                let mut s = verify_blob(&blob(&v, "shipped"), &root, now_ms).unwrap();
                s.no = no;
                m.set(s);
            }
            let got = m.admit(&blob(&v, c["blob"].as_str().unwrap()), now_ms);
            assert_eq!(got.is_ok(), c["ok"].as_bool().unwrap(), "{name}: {:?}", got.err());
        }
        // Each refused blob of the vector, against the vector's root.
        for (name, refused) in [("shipped", false), ("newer", false), ("older", false), ("bad-signature", true), ("other-root", true)] {
            assert_eq!(verify_blob(&blob(&v, name), &root, now_ms).is_err(), refused, "{name}");
        }
        assert_eq!(verify_blob(&blob(&v, "bad-signature"), &root, now_ms).unwrap_err(), "its signature does not verify");
        assert_eq!(verify_blob(&blob(&v, "other-root"), &root, now_ms).unwrap_err(), "it is not signed through the FIDO Alliance root");
        // Against another root, even the good blob is refused.
        assert!(verify_blob(&blob(&v, "shipped"), &pem_der(&v["other_root_pem"]), now_ms).is_err());
    }

    #[test]
    fn vector_newest_valid_blob_at_start_and_install() {
        let v = vector();
        let now_ms = v["now"].as_i64().unwrap() * 1000;
        let root = pem_der(&v["root_pem"]);
        let shipped = blob(&v, "shipped");
        let no = |name: &str| v["blobs"][name]["no"].as_u64().unwrap();
        // Nothing stored: the shipped blob.
        let dir = temp("open");
        let m = Mds::with_root(root.clone(), Some(&shipped), &dir, now_ms);
        let c = m.current.as_ref().unwrap();
        assert_eq!((c.no, c.uploaded, m.stored_refused), (no("shipped"), false, false));
        assert_eq!(c.next_update, v["blobs"]["shipped"]["nextUpdate"].as_str().unwrap());
        assert_eq!(c.sha256, sha256_hex(&shipped));
        // A newer stored blob is used; an older one leaves the shipped one in force.
        for (name, expect, uploaded) in [("newer", no("newer"), true), ("older", no("shipped"), false)] {
            std::fs::write(dir.join(MDS_FILE), blob(&v, name)).unwrap();
            let m = Mds::with_root(root.clone(), Some(&shipped), &dir, now_ms);
            let c = m.current.as_ref().unwrap();
            assert_eq!((c.no, c.uploaded, m.stored_refused), (expect, uploaded, false), "{name}");
        }
        // A stored blob that does not verify falls back to the shipped one and raises mds-old.
        for name in ["bad-signature", "other-root"] {
            std::fs::write(dir.join(MDS_FILE), blob(&v, name)).unwrap();
            let m = Mds::with_root(root.clone(), Some(&shipped), &dir, now_ms);
            assert_eq!(m.current.as_ref().map(|c| c.no), Some(no("shipped")), "{name}");
            assert!(m.stored_refused && m.old(now_ms), "{name}");
        }
        // No shipped blob that verifies and none stored: nothing in force, mds-old.
        let empty = temp("empty");
        let m = Mds::with_root(root.clone(), Some(&blob(&v, "bad-signature")), &empty, now_ms);
        assert!(m.current.is_none() && m.old(now_ms));
        // Install: a newer blob is kept owner-only and put in force; older, equal and bad ones are refused.
        let dir = temp("install");
        let mut m = Mds::with_root(root.clone(), Some(&shipped), &dir, now_ms);
        for name in ["older", "shipped", "bad-signature", "other-root"] {
            assert!(m.install(&dir, &blob(&v, name), now_ms).is_err(), "{name}");
            assert!(!dir.join(MDS_FILE).exists(), "{name}");
        }
        let s = m.install(&dir, &blob(&v, "newer"), now_ms).expect("the newer blob installs");
        assert_eq!((s.no, s.uploaded), (no("newer"), true));
        assert_eq!(m.current.as_ref().map(|c| c.no), Some(no("newer")));
        assert_eq!(std::fs::read(dir.join(MDS_FILE)).unwrap(), blob(&v, "newer"));
        let e = m.install(&dir, &blob(&v, "newer"), now_ms).unwrap_err();
        assert_eq!(e, format!("its number {0} is not newer than the metadata in force (number {0})", no("newer")));
        // At the next start the stored blob is the newest.
        let m = Mds::with_root(root, Some(&shipped), &dir, now_ms);
        assert_eq!(m.current.as_ref().map(|c| (c.no, c.uploaded)), Some((no("newer"), true)));
    }
}
