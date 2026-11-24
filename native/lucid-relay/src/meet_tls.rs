// Phase C (ADR-0540): the Meet relay's TLS (meet_relay.py tls_context, crl_path, crl_parts, bundle_checks_chain,
// RefusalLog) and its outbound mutual-TLS client (SignerClient, and the Proxmox calls of meet_console.FilesPower).
// Server TLS REQUIRES a client certificate chaining to the Meet CA; with a CRL file the leaf is checked, and once the
// bundle also holds a CRL from another CA (the signer's) every certificate of the chain is. An expired CRL refuses
// the handshake, as OpenSSL does.

use crate::meet::{log_info, Settings, E};
use crate::meet_json::{self as pj, Obj};
use crate::meet_x509::{pem_blocks, Cert, Crl};
use parking_lot::{Mutex, RwLock};
use rustls::client::danger::HandshakeSignatureValid;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::WebPkiClientVerifier;
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, RootCertStore, ServerConfig, SignatureScheme};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const ROOT_CRL: &str = "crl-root.pem";
pub const SIGNER_CRL: &str = "crl-signer.pem";
/// AC-2b-D 2.4, 8.5 (R3-M1): a valid newer root CRL whose `thisUpdate` has not passed on this relay's clock yet.
pub const ROOT_CRL_PENDING: &str = "crl-root.pending.pem";
/// AC-2b-D 8.5: a root CRL dated at most this far ahead (seconds) waits as pending; further ahead it is future.
pub const CRL_PENDING_AHEAD: i64 = 300;
const OID_CRL_NUMBER: &[u8] = &[0x55, 0x1d, 0x14];
pub const SIGNER_TIMEOUT: f64 = 10.0;
pub const SIGNER_TTL: f64 = 60.0;
pub const SIGNER_RETRY: f64 = 60.0;
const REFUSAL_EVERY: f64 = 600.0;
const REFUSAL_ADDRESSES: usize = 256;
const REFUSAL_LISTED: usize = 20;

pub fn read_bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_default()
}

pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut fh = std::fs::File::create(&tmp)?;
        fh.write_all(data)?;
        fh.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// crl_path: `crl` if set, else `state_dir/crl.pem` (None when neither).
pub fn crl_path(s: &Settings) -> Option<PathBuf> {
    if !s.crl.is_empty() {
        return Some(PathBuf::from(&s.crl));
    }
    (!s.state_dir.is_empty()).then(|| Path::new(&s.state_dir).join("crl.pem"))
}

/// crl_parts: (root part, signer part) of the bundle in state_dir; None with a fixed `crl` file or no state folder.
pub fn crl_parts(s: &Settings) -> Option<(PathBuf, PathBuf)> {
    if !s.crl.is_empty() || s.state_dir.is_empty() {
        return None;
    }
    let d = Path::new(&s.state_dir);
    Some((d.join(ROOT_CRL), d.join(SIGNER_CRL)))
}

/// The CRLs in a file (each readable one).
pub fn crls_in(data: &[u8]) -> Vec<Crl> {
    pem_blocks(data, "X509 CRL").iter().filter_map(|(_, der)| Crl::from_der(der)).collect()
}

/// bundle_checks_chain: the CRL file holds the root's CRL AND at least one other CA's.
pub fn bundle_checks_chain(crl_file: &Path, ca_file: &Path) -> bool {
    let Some(root) = Cert::from_pem(&String::from_utf8_lossy(&read_bytes(ca_file))) else { return false };
    let Ok(data) = std::fs::read(crl_file) else { return false };
    let blocks = pem_blocks(&data, "X509 CRL");
    let mut issuers = Vec::new();
    for (_, der) in &blocks {
        match Crl::from_der(der) {
            Some(c) => issuers.push(c.issuer),
            None => return false,
        }
    }
    issuers.contains(&root.subject) && issuers.iter().any(|i| *i != root.subject)
}

/// The CRL file new connections check ("" when none): `crl`, else the pushed bundle when it exists.
pub fn active_crl(s: &Settings) -> Option<PathBuf> {
    if !s.crl.is_empty() {
        return Some(PathBuf::from(&s.crl));
    }
    crl_path(s).filter(|p| p.exists())
}

// ── AC-2b-D 8.5: root CRLs from the Admin Console (order; current, pending and future lists) ─────────────────

/// The CRL number of a list (RFC 5280 5.2.3; big-endian, no leading zero bytes), None when it carries none.
pub fn crl_number(crl: &Crl) -> Option<Vec<u8>> {
    use crate::der::tlv;
    let tbs = tlv(&crl.signed.tbs)?;
    let mut d = tbs.value;
    while !d.is_empty() {
        let field = tlv(d)?;
        d = field.rest;
        if field.tag != 0xa0 {
            continue;
        }
        let exts = tlv(field.value)?;
        let mut e = exts.value;
        while !e.is_empty() {
            let ext = tlv(e)?;
            e = ext.rest;
            let oid = tlv(ext.value)?;
            if oid.tag != 0x06 || oid.value != OID_CRL_NUMBER {
                continue;
            }
            let mut value = tlv(oid.rest)?;
            if value.tag == 0x01 {
                value = tlv(value.rest)?;
            }
            if value.tag != 0x04 {
                return None;
            }
            let int = tlv(value.value)?;
            if int.tag != 0x02 || int.value.is_empty() || int.value.len() > 21 {
                return None;
            }
            let mut n = int.value;
            while n.len() > 1 && n[0] == 0 {
                n = &n[1..];
            }
            return Some(n.to_vec());
        }
    }
    None
}

/// A CRL number (big-endian bytes) as decimal text, as `meetCrl.number` reports it.
pub fn number_text(n: &[u8]) -> String {
    let mut num = n.to_vec();
    let mut digits = Vec::new();
    while num.iter().any(|b| *b != 0) {
        let mut rem = 0u32;
        for b in num.iter_mut() {
            let cur = (rem << 8) | u32::from(*b);
            *b = (cur / 10) as u8;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    if digits.is_empty() {
        return "0".into();
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

fn number_cmp(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// The 8.5 order between two lists of one CA: `a` is later than `b` when its `thisUpdate` is later, or at the same
/// `thisUpdate` when both carry a CRL number and `a`'s is higher.
pub fn crl_later(a: &Crl, b: &Crl) -> bool {
    if a.this_update != b.this_update {
        return a.this_update > b.this_update;
    }
    matches!((crl_number(a), crl_number(b)), (Some(x), Some(y)) if number_cmp(&x, &y).is_gt())
}

/// 8.5 (R3-M1), on this relay's clock with `check_one`'s zero tolerance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrlTime {
    /// Its `thisUpdate` has passed: new connections count it.
    Current,
    /// Its `thisUpdate` is at most CRL_PENDING_AHEAD seconds ahead.
    Pending,
    /// Further ahead: refused (`why: "future"`).
    Future,
}

pub fn crl_time(crl: &Crl, now: i64) -> CrlTime {
    if crl.this_update <= now {
        CrlTime::Current
    } else if crl.this_update - now <= CRL_PENDING_AHEAD {
        CrlTime::Pending
    } else {
        CrlTime::Future
    }
}

/// The self-signed certificates of a CA file (the roots a Meeting Hub relay trusts).
pub fn self_signed_roots(ca_file: &Path) -> Vec<Cert> {
    pem_blocks(&read_bytes(ca_file), "CERTIFICATE").iter().filter_map(|(_, der)| Cert::from_der(der)).filter(|c| c.subject == c.issuer && c.signed.verified_by(&c.spki)).collect()
}

/// AC-2b-D 6.5, 9.3 `meetRoots`: the `m_` ids of every self-signed certificate in a CA file (none before one exists).
pub fn meet_root_ids(ca_file: &Path) -> Vec<String> {
    let mut ids: Vec<String> = self_signed_roots(ca_file).iter().map(|c| crate::license::meet_root_id(&c.spki)).collect();
    ids.sort();
    ids.dedup();
    ids
}

/// The root among `roots` that signed `crl`, None for a list of any other issuer.
pub fn crl_root<'a>(crl: &Crl, roots: &'a [Cert]) -> Option<&'a Cert> {
    roots.iter().find(|r| r.subject == crl.issuer && crl.signature_valid(&r.spki))
}

/// The first CRL of a PEM text: its block (re-terminated), its DER and what it says.
fn first_crl(pem: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Crl)> {
    let (block, der) = pem_blocks(pem, "X509 CRL").into_iter().next()?;
    let crl = Crl::from_der(&der)?;
    Some((block, der, crl))
}

/// Whether `new` may replace `old` in crl-root.pem (8.5): later by the order; or `old` is not current (it came
/// another way before revision 3) and the current `new` carries a higher CRL number, or `old` carries none.
fn replaces(new: &Crl, old: Option<&Crl>, now: i64) -> bool {
    let Some(old) = old else { return true };
    if crl_later(new, old) {
        return true;
    }
    old.this_update > now
        && new.this_update <= now
        && match (crl_number(new), crl_number(old)) {
            (Some(a), Some(b)) => number_cmp(&a, &b).is_gt(),
            (_, None) => true,
            (None, Some(_)) => false,
        }
}

/// Where `place_root_crl` put a list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placed {
    /// In crl-root.pem, crl.pem rebuilt (or that very list was already there).
    Current,
    /// In crl-root.pending.pem, the previous list still in force until its `thisUpdate` passes.
    Pending,
}

/// crl.pem = crl-root.pem + crl-signer.pem in `state_dir`; false (nothing written) without a root part.
pub fn rebuild_bundle_files(state_dir: &Path) -> std::io::Result<bool> {
    let root = read_bytes(&state_dir.join(ROOT_CRL));
    let mut data = String::from_utf8_lossy(&root).trim_matches(|c: char| c.is_ascii_whitespace()).as_bytes().to_vec();
    if data.is_empty() {
        return Ok(false);
    }
    data.push(b'\n');
    data.extend(read_bytes(&state_dir.join(SIGNER_CRL)));
    write_atomic(&state_dir.join("crl.pem"), &data)?;
    Ok(true)
}

/// AC-2b-D 8.5 (R2-H1, R3-M1, D9): a root CRL from the Admin Console (the enrollment answer or `meet-crl`) into the
/// bundle of `state_dir`. Taken only when signed by a self-signed certificate in `client_ca`, not expired, not dated
/// more than CRL_PENDING_AHEAD ahead, and later by the 8.5 order than the list in place and any pending one. A
/// current list becomes crl-root.pem (crl.pem rebuilt); a list at most 5 minutes ahead waits as
/// crl-root.pending.pem while the previous list stays in force. Err is the `why` of `fleet.meet-crl-refused`:
/// `unreadable`, `signature`, `expired`, `future`, `older` or `write`. `now_ms` in Unix milliseconds (the enrollment
/// apply's clock).
pub fn place_root_crl(state_dir: &Path, client_ca: &Path, pem: &[u8], now_ms: i64) -> Result<Placed, String> {
    place_root_crl_changed(state_dir, client_ca, pem, now_ms.div_euclid(1000)).map(|(placed, _)| placed)
}

/// `place_root_crl` with `now` in seconds, and whether a file changed (the very list already in place or pending
/// changes nothing).
pub fn place_root_crl_changed(state_dir: &Path, client_ca: &Path, pem: &[u8], now: i64) -> Result<(Placed, bool), String> {
    let (block, _, crl) = first_crl(pem).ok_or("unreadable")?;
    let roots = self_signed_roots(client_ca);
    if crl_root(&crl, &roots).is_none() {
        return Err("signature".into());
    }
    if crl.next_update.is_some_and(|n| n <= now) {
        return Err("expired".into());
    }
    let time = crl_time(&crl, now);
    if time == CrlTime::Future {
        return Err("future".into());
    }
    let (root_part, pending_part) = (state_dir.join(ROOT_CRL), state_dir.join(ROOT_CRL_PENDING));
    let old = first_crl(&read_bytes(&root_part)).map(|(_, _, c)| c);
    if old.as_ref().is_some_and(|o| o.signed.tbs == crl.signed.tbs) {
        return Ok((Placed::Current, false));
    }
    let pending = first_crl(&read_bytes(&pending_part)).map(|(_, _, c)| c).filter(|p| crl_root(p, &roots).is_some() && p.next_update.is_none_or(|n| n > now));
    if pending.as_ref().is_some_and(|p| p.signed.tbs == crl.signed.tbs) {
        return Ok((Placed::Pending, false));
    }
    if pending.as_ref().is_some_and(|p| !crl_later(&crl, p)) {
        return Err("older".into());
    }
    match time {
        CrlTime::Current => {
            if !replaces(&crl, old.as_ref(), now) {
                return Err("older".into());
            }
            write_atomic(&root_part, &block).map_err(|_| "write".to_string())?;
            if pending_part.exists() {
                let _ = std::fs::remove_file(&pending_part);
            }
            rebuild_bundle_files(state_dir).map_err(|_| "write".to_string())?;
            Ok((Placed::Current, true))
        }
        _ => {
            if old.as_ref().is_some_and(|o| !crl_later(&crl, o) && o.this_update <= now) {
                return Err("older".into());
            }
            write_atomic(&pending_part, &block).map_err(|_| "write".to_string())?;
            Ok((Placed::Pending, true))
        }
    }
}

/// The `thisUpdate` (seconds) of the pending root CRL in `state_dir`, None without one.
pub fn pending_crl_due(state_dir: &Path) -> Option<i64> {
    first_crl(&read_bytes(&state_dir.join(ROOT_CRL_PENDING))).map(|(_, _, c)| c.this_update)
}

/// The timer's step (R3-M1): a pending list whose `thisUpdate` has passed becomes crl-root.pem when it still replaces
/// the list in place (crl.pem rebuilt); one that no longer can, or no longer verifies, is deleted. The adopted list
/// and its DER, if any. `now` in seconds.
pub fn adopt_pending_crl(state_dir: &Path, client_ca: &Path, now: i64) -> Option<(Crl, Vec<u8>)> {
    let pending_part = state_dir.join(ROOT_CRL_PENDING);
    if std::fs::symlink_metadata(&pending_part).is_err() {
        return None;
    }
    let Some((block, der, crl)) = first_crl(&read_bytes(&pending_part)) else {
        let _ = std::fs::remove_file(&pending_part);
        return None;
    };
    let roots = self_signed_roots(client_ca);
    let valid = crl_root(&crl, &roots).is_some() && crl.next_update.is_none_or(|n| n > now);
    if valid && crl_time(&crl, now) != CrlTime::Current {
        return None;
    }
    let root_part = state_dir.join(ROOT_CRL);
    let old = first_crl(&read_bytes(&root_part)).map(|(_, _, c)| c);
    if !valid || !replaces(&crl, old.as_ref(), now) {
        let _ = std::fs::remove_file(&pending_part);
        return None;
    }
    write_atomic(&root_part, &block).ok()?;
    let _ = std::fs::remove_file(&pending_part);
    rebuild_bundle_files(state_dir).ok()?;
    Some((crl, der))
}

/// AC-2b-D 9.3 `meetCrl`: where this relay's root CRL comes from (`bundle`, `fixed` for a `crl` setting, `none`
/// without a CRL file), the list in force (`thisUpdate` in ms, CRL number as decimal text, the `m_` id of the root
/// that signed it, SHA-256 of its DER) and the pending one; fields null with none.
pub fn meet_crl_report(s: &Settings) -> serde_json::Value {
    use serde_json::{json, Value};
    let roots = self_signed_roots(Path::new(&s.client_ca));
    let describe = |data: &[u8]| -> Option<Value> {
        pem_blocks(data, "X509 CRL").into_iter().find_map(|(_, der)| {
            let c = Crl::from_der(&der)?;
            let root = crl_root(&c, &roots)?;
            Some(json!({
                "thisUpdate": c.this_update * 1000,
                "number": crl_number(&c).map(|n| number_text(&n)),
                "issuer": crate::license::meet_root_id(&root.spki),
                "sha256": crate::codec::sha256_hex(&der),
            }))
        })
    };
    let (source, in_force, pending) = if !s.crl.is_empty() {
        ("fixed", describe(&read_bytes(Path::new(&s.crl))), None)
    } else if crl_path(s).is_some_and(|p| p.exists()) {
        let d = Path::new(&s.state_dir);
        ("bundle", describe(&read_bytes(&d.join(ROOT_CRL))), describe(&read_bytes(&d.join(ROOT_CRL_PENDING))))
    } else {
        ("none", None, None)
    };
    let field = |k: &str| in_force.as_ref().and_then(|v| v.get(k)).cloned().unwrap_or(Value::Null);
    json!({
        "source": source,
        "thisUpdate": field("thisUpdate"),
        "number": field("number"),
        "issuer": field("issuer"),
        "sha256": field("sha256"),
        "pending": pending.map(|p| json!({"thisUpdate": p["thisUpdate"], "number": p["number"], "sha256": p["sha256"]})).unwrap_or(Value::Null),
    })
}

fn load_certs(path: &str, what: &str) -> Result<Vec<CertificateDer<'static>>, String> {
    let data = std::fs::read(path).map_err(|e| format!("cannot read the {what} {path}: {e}"))?;
    let certs = rustls_pemfile::certs(&mut data.as_slice()).collect::<Result<Vec<_>, _>>().map_err(|e| format!("the {what} {path} does not read: {e}"))?;
    if certs.is_empty() {
        return Err(format!("the {what} {path} holds no certificate"));
    }
    Ok(certs)
}

fn load_key(path: &str) -> Result<PrivateKeyDer<'static>, String> {
    let data = std::fs::read(path).map_err(|e| format!("cannot read the key {path}: {e}"))?;
    rustls_pemfile::private_key(&mut data.as_slice()).map_err(|e| format!("the key {path} does not read: {e}"))?.ok_or_else(|| format!("the key {path} holds no private key"))
}

fn roots_of(path: &str) -> Result<RootCertStore, String> {
    let mut roots = RootCertStore::empty();
    for c in load_certs(path, "CA file")? {
        roots.add(c).map_err(|e| format!("the CA file {path} does not read: {e}"))?;
    }
    Ok(roots)
}

/// API-1 3.3: who an expired Meet leaf is, for the applicable grace: its kind and orgs (`cert_kind`), its principal
/// (the first email, lower case; an SSO service `sso:<serial>`) and its `notAfter`.
pub struct GraceSubject {
    pub kind: String,
    pub principal: String,
    pub orgs: Vec<String>,
    pub not_after: i64,
}

impl GraceSubject {
    /// None for a relay certificate or one `cert_kind` refuses (no grace).
    pub fn of(cert: &Cert) -> Option<GraceSubject> {
        if cert.names.uris.iter().any(|u| u == crate::meet::RELAY_URI) {
            return None;
        }
        let (kind, orgs) = crate::meet_hub::pc::cert_kind(&cert.names.uris).ok()?;
        let principal = if kind == "sso" { format!("sso:{}", cert.serial) } else { cert.names.emails.first()?.trim().to_lowercase() };
        Some(GraceSubject { kind, principal, orgs, not_after: cert.not_after })
    }
}

/// API-1 3.3: the effective end (seconds) of a subject at `now`, read from the relay's live api map store.
pub type GraceSource = Arc<dyn Fn(&GraceSubject, i64) -> i64 + Send + Sync>;

static GRACE: std::sync::OnceLock<GraceSource> = std::sync::OnceLock::new();

/// Set once at start, before the first `tls_config`: every Meet TLS config built after it carries the source.
pub fn set_grace_source(source: GraceSource) {
    let _ = GRACE.set(source);
}

/// The source `set_grace_source` set (None before, and in tests that never set it).
pub fn grace_source() -> Option<&'static GraceSource> {
    GRACE.get()
}

/// The effective end of `cert` at `now` from `source` (`notAfter` without one, or for a certificate with no grace).
pub fn grace_end_with(source: Option<&GraceSource>, cert: &Cert, now: i64) -> i64 {
    match (source, GraceSubject::of(cert)) {
        (Some(f), Some(s)) => f(&s, now).max(cert.not_after),
        _ => cert.not_after,
    }
}

#[derive(Clone)]
struct Grace(Option<GraceSource>);

impl std::fmt::Debug for Grace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() { "Grace(source)" } else { "Grace(none)" })
    }
}

/// The client verifier: the chain to the Meet CA by webpki, then revocation as OpenSSL checks it with
/// VERIFY_CRL_CHECK_LEAF or _CHAIN (meet_pki's CRLs carry no CRL number, which webpki's own CRL parser requires):
/// each checked certificate needs a current CRL from its issuer, signed by that issuer, that does not list it.
/// API-1 3.3: an expired leaf may pass on the grace path (`in_grace`).
#[derive(Debug)]
struct MeetVerifier {
    inner: Arc<dyn ClientCertVerifier>,
    roots: Vec<Cert>,
    crls: Vec<Crl>,
    chain: bool,
    /// A CRL file is in force (the revocation checks run).
    revoke: bool,
    grace: Grace,
}

impl MeetVerifier {
    /// API-1 3.3: the grace path for a leaf webpki refused as expired. Admitted only when the applicable grace covers
    /// `now`, the whole webpki verification passes at the leaf's `notAfter`, every issuer of the chain is valid at
    /// `now`, and the CRL checks pass at `now`.
    fn in_grace(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], now: i64) -> Option<ClientCertVerified> {
        let source = self.grace.0.as_ref()?;
        let leaf = Cert::from_der(end_entity)?;
        if now <= leaf.not_after || now > grace_end_with(Some(source), &leaf, now) {
            return None;
        }
        let at = UnixTime::since_unix_epoch(Duration::from_secs(u64::try_from(leaf.not_after).ok()?));
        let verified = self.inner.verify_client_cert(end_entity, intermediates, at).ok()?;
        let inters: Vec<Cert> = intermediates.iter().filter_map(|c| Cert::from_der(c)).collect();
        let mut cert = leaf;
        let mut rooted = false;
        for _ in 0..8 {
            let (issuer, is_root) = self.issuer_of(&cert, &inters)?;
            if issuer.not_before > now || issuer.not_after < now {
                return None;
            }
            if is_root {
                rooted = true;
                break;
            }
            cert = issuer.clone();
        }
        if !rooted || (self.revoke && self.revocation(end_entity, intermediates, now).is_err()) {
            return None;
        }
        Some(verified)
    }

    fn issuer_of<'a>(&'a self, cert: &Cert, intermediates: &'a [Cert]) -> Option<(&'a Cert, bool)> {
        if let Some(c) = intermediates.iter().find(|c| c.subject == cert.issuer && cert.signed.verified_by(&c.spki)) {
            return Some((c, false));
        }
        self.roots.iter().find(|c| c.subject == cert.issuer && cert.signed.verified_by(&c.spki)).map(|c| (c, true))
    }

    fn check_one(&self, cert: &Cert, issuer: &Cert, now: i64) -> Result<(), CertificateError> {
        let current: Vec<&Crl> = self
            .crls
            .iter()
            .filter(|c| c.issuer == cert.issuer && c.signature_valid(&issuer.spki) && c.this_update <= now && c.next_update.map(|n| n > now).unwrap_or(true))
            .collect();
        if current.is_empty() {
            return Err(CertificateError::UnknownRevocationStatus);
        }
        if current.iter().any(|c| c.serials.contains(&cert.serial)) {
            return Err(CertificateError::Revoked);
        }
        Ok(())
    }

    fn revocation(&self, end_entity: &[u8], intermediates: &[CertificateDer<'_>], now: i64) -> Result<(), CertificateError> {
        let leaf = Cert::from_der(end_entity).ok_or(CertificateError::BadEncoding)?;
        let inters: Vec<Cert> = intermediates.iter().filter_map(|c| Cert::from_der(c)).collect();
        let mut cert = leaf;
        for _ in 0..8 {
            let (issuer, is_root) = self.issuer_of(&cert, &inters).ok_or(CertificateError::UnknownIssuer)?;
            self.check_one(&cert, issuer, now)?;
            if !self.chain || is_root {
                return Ok(());
            }
            cert = issuer.clone();
        }
        Ok(())
    }
}

impl ClientCertVerifier for MeetVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }

    fn client_auth_mandatory(&self) -> bool {
        self.inner.client_auth_mandatory()
    }

    fn verify_client_cert(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], now: UnixTime) -> Result<ClientCertVerified, rustls::Error> {
        let verified = match self.inner.verify_client_cert(end_entity, intermediates, now) {
            Ok(v) => v,
            Err(e @ rustls::Error::InvalidCertificate(CertificateError::Expired | CertificateError::ExpiredContext { .. })) => {
                return self.in_grace(end_entity, intermediates, now.as_secs() as i64).ok_or(e);
            }
            Err(e) => return Err(e),
        };
        if self.revoke {
            self.revocation(end_entity, intermediates, now.as_secs() as i64).map_err(rustls::Error::InvalidCertificate)?;
        }
        Ok(verified)
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// tls_context: the server TLS for new connections.
pub fn tls_config(s: &Settings) -> Result<Arc<ServerConfig>, String> {
    let provider = Arc::new(crate::server::provider());
    let roots = Arc::new(roots_of(&s.client_ca)?);
    let inner = WebPkiClientVerifier::builder_with_provider(roots, provider.clone()).build().map_err(|e| format!("the client CA does not load: {e}"))?;
    meet_server_config(s, provider, inner, true)
}

/// API-1 7.2: the API listener's server TLS: the relay's own certificate, TLS 1.3 and 1.2, a client certificate
/// asked for but OPTIONAL. A presented one is checked in the handshake against the client CA (and the 3.3 grace
/// path) only; its revocation is checked after the handshake by `api_cert_revocation_checked`, which counts it only
/// under a current CRL, so a relay without a CRL still serves anonymous clients but authenticates no certificate.
pub fn api_tls_config(s: &Settings) -> Result<Arc<ServerConfig>, String> {
    let provider = Arc::new(crate::server::provider());
    let roots = Arc::new(roots_of(&s.client_ca)?);
    let inner = WebPkiClientVerifier::builder_with_provider(roots, provider.clone()).allow_unauthenticated().build().map_err(|e| format!("the client CA does not load: {e}"))?;
    meet_server_config(s, provider, inner, false)
}

/// API-1 4.2: whether a client chain that passed `api_tls_config`'s handshake also passed revocation at `now`: the
/// CRL file in force (read now, so a refreshed list applies at once) holds a current list, signed by its issuer,
/// for every certificate checked (the leaf, or the whole chain for a chain bundle), and none lists it. No CRL file,
/// an unreadable one, or no current list: false (the certificate then counts as not presented).
pub fn api_cert_revocation_checked(s: &Settings, leaf: &[u8], intermediates: &[CertificateDer<'_>], now: i64) -> bool {
    let Some(crl) = active_crl(s) else { return false };
    let crls = std::fs::read(&crl).map(|d| crls_in(&d)).unwrap_or_default();
    if crls.is_empty() {
        return false;
    }
    let Ok(store) = roots_of(&s.client_ca) else { return false };
    let Ok(inner) = WebPkiClientVerifier::builder_with_provider(Arc::new(store), Arc::new(crate::server::provider())).build() else { return false };
    let roots: Vec<Cert> = pem_blocks(&read_bytes(Path::new(&s.client_ca)), "CERTIFICATE").iter().filter_map(|(_, der)| Cert::from_der(der)).collect();
    let chain = bundle_checks_chain(&crl, Path::new(&s.client_ca));
    let v = MeetVerifier { inner, roots, crls, chain, revoke: true, grace: Grace(None) };
    v.revocation(leaf, intermediates, now).is_ok()
}

/// A server config with the relay's certificate and the Meet client verifier around `inner` (whose
/// `client_auth_mandatory` the wrapper keeps). `handshake_revocation` false leaves the CRL to the caller.
fn meet_server_config(s: &Settings, provider: Arc<rustls::crypto::CryptoProvider>, inner: Arc<dyn ClientCertVerifier>, handshake_revocation: bool) -> Result<Arc<ServerConfig>, String> {
    let certs = load_certs(&s.cert, "certificate")?;
    let key = load_key(&s.key)?;
    let (crls, chain, revoke) = match active_crl(s).filter(|_| handshake_revocation) {
        None => (Vec::new(), false, false),
        Some(crl) => {
            let data = std::fs::read(&crl).map_err(|e| format!("cannot read the CRL {}: {e}", crl.display()))?;
            let crls = crls_in(&data);
            if crls.is_empty() {
                return Err(format!("the CRL file {} holds no CRL", crl.display()));
            }
            (crls, bundle_checks_chain(&crl, Path::new(&s.client_ca)), true)
        }
    };
    let ca_data = std::fs::read(&s.client_ca).map_err(|e| format!("cannot read the CA file {}: {e}", s.client_ca))?;
    let roots: Vec<Cert> = pem_blocks(&ca_data, "CERTIFICATE").iter().filter_map(|(_, der)| Cert::from_der(der)).collect();
    // API-1 3.3: without a CRL file and a grace source this is the plain webpki verifier, as before
    let verifier: Arc<dyn ClientCertVerifier> = Arc::new(MeetVerifier { inner, roots, crls, chain, revoke, grace: Grace(GRACE.get().cloned()) });
    let cfg = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs, key)
        .map_err(|e| format!("the relay certificate and key do not fit: {e}"))?;
    Ok(Arc::new(cfg))
}

/// guest_tls_context: the guest port's server TLS: the guest certificate (else the relay's own), TLS 1.2 or later,
/// and NO client certificate asked for.
pub fn guest_tls_config(s: &Settings) -> Result<Arc<ServerConfig>, String> {
    let provider = Arc::new(crate::server::provider());
    let cert = if s.guest_cert.is_empty() { &s.cert } else { &s.guest_cert };
    let key = if s.guest_key.is_empty() { &s.key } else { &s.guest_key };
    let cfg = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(load_certs(cert, "certificate")?, load_key(key)?)
        .map_err(|e| format!("the guest certificate and key do not fit: {e}"))?;
    Ok(Arc::new(cfg))
}

/// The SAN DNS names of the first certificate in a PEM file, lower case (none when it does not read).
pub fn cert_dns_names(path: &str) -> Vec<String> {
    Cert::from_pem(&String::from_utf8_lossy(&read_bytes(Path::new(path)))).map(|c| c.names.dns.iter().map(|d| d.trim().to_lowercase()).collect()).unwrap_or_default()
}

/// Whether a certificate's SAN DNS names cover `host` (one leftmost wildcard label, as browsers match).
fn dns_covers(names: &[String], host: &str) -> bool {
    let host = host.to_lowercase();
    names.iter().any(|n| {
        let n = n.to_lowercase();
        match n.strip_prefix("*.") {
            Some(rest) => host.split_once('.').map(|(first, tail)| !first.is_empty() && tail == rest && rest.contains('.')).unwrap_or(false),
            None => n == host,
        }
    })
}

/// AC-1 contract 3.1: `console_cert` must name `host` (SAN DNS) and must not come from the Meet CA: no certificate
/// in its file is a `client_ca` certificate or issued by one, and the leaf carries no Meet SAN URI or email (a device,
/// seed or service certificate the signer issued). Err holds the start error's words.
pub fn check_console_cert(console_cert: &str, client_ca: &str, host: &str) -> Result<(), String> {
    let refused = || format!("console_cert must be a certificate browsers trust for {host}, not one from the Meet CA");
    let data = std::fs::read(console_cert).map_err(|e| format!("cannot read the certificate {console_cert}: {e}"))?;
    let chain: Vec<Cert> = pem_blocks(&data, "CERTIFICATE").iter().filter_map(|(_, der)| Cert::from_der(der)).collect();
    let Some(leaf) = chain.first() else { return Err(refused()) };
    if !dns_covers(&leaf.names.dns, host) {
        return Err(refused());
    }
    if leaf.names.uris.iter().any(|u| u.starts_with("urn:lucid-meet:")) || !leaf.names.emails.is_empty() {
        return Err(refused());
    }
    let ca: Vec<Cert> = pem_blocks(&read_bytes(Path::new(client_ca)), "CERTIFICATE").iter().filter_map(|(_, der)| Cert::from_der(der)).collect();
    let from_meet = chain.iter().any(|c| ca.iter().any(|root| c.spki == root.spki || c.issuer == root.subject || c.issued_by(root)));
    if from_meet {
        return Err(refused());
    }
    Ok(())
}

/// AC-1 contract 3.1: the Admin Console port's server TLS: `console_cert` and `console_key`, TLS 1.2 or later,
/// HTTP/1.1 only, and NO client certificate asked for.
pub fn console_tls_config(s: &Settings) -> Result<Arc<ServerConfig>, String> {
    let provider = Arc::new(crate::server::provider());
    let mut cfg = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(load_certs(&s.console_cert, "certificate")?, load_key(&s.console_key)?)
        .map_err(|e| format!("the console certificate and key do not fit: {e}"))?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

// ── RefusalLog ───────────────────────────────────────────────────────────────────────────────────────────────

struct Refusals {
    counts: BTreeMap<String, u64>,
    others: u64,
    started: f64,
}

/// Refused or dropped connections: the first from each address in a period is one INFO line; the rest are counted
/// and summed up in one line when the period ends.
pub struct RefusalLog {
    mu: Mutex<Refusals>,
}

impl RefusalLog {
    pub fn new() -> RefusalLog {
        RefusalLog { mu: Mutex::new(Refusals { counts: BTreeMap::new(), others: 0, started: pj::mono() }) }
    }

    pub fn note(&self, address: &str) {
        {
            let mut r = self.mu.lock();
            Self::flush_locked(&mut r, pj::mono());
            if let Some(c) = r.counts.get_mut(address) {
                *c += 1;
                return;
            }
            if r.counts.len() >= REFUSAL_ADDRESSES {
                r.others += 1;
                return;
            }
            r.counts.insert(address.to_string(), 1);
        }
        log_info(&format!("connection from {address} refused or dropped"));
    }

    pub fn flush(&self) {
        let mut r = self.mu.lock();
        Self::flush_locked(&mut r, pj::mono());
    }

    fn flush_locked(r: &mut Refusals, now: f64) {
        if now - r.started < REFUSAL_EVERY {
            return;
        }
        let quiet: u64 = r.counts.values().map(|c| c - 1).sum::<u64>() + r.others;
        if quiet > 0 {
            let mut top: Vec<(&String, &u64)> = r.counts.iter().collect();
            top.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            let listed = top.iter().take(REFUSAL_LISTED).map(|(a, c)| format!("{a}={c}")).collect::<Vec<_>>().join(" ");
            let more = top.len() as i64 - REFUSAL_LISTED as i64;
            let total = r.counts.values().sum::<u64>() + r.others;
            log_info(&format!(
                "refused or dropped connections in the last {} min: total={total} {listed}{}{}",
                (REFUSAL_EVERY / 60.0).round() as i64,
                if more > 0 { format!(" (+{more} more addresses)") } else { String::new() },
                if r.others > 0 { format!(" other={}", r.others) } else { String::new() }
            ));
        }
        r.counts.clear();
        r.others = 0;
        r.started = now;
    }
}

// ── outbound HTTPS (blocking) ────────────────────────────────────────────────────────────────────────────────

/// The Python exception class name an outbound failure would carry (for "cannot reach ... (ClassName)").
fn error_class(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    if let Some(inner) = e.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
        return match inner {
            rustls::Error::InvalidCertificate(_) => "SSLCertVerificationError",
            _ => "SSLError",
        };
    }
    match e.kind() {
        ConnectionRefused => "ConnectionRefusedError",
        TimedOut | WouldBlock => "TimeoutError",
        ConnectionReset => "ConnectionResetError",
        ConnectionAborted => "ConnectionAbortedError",
        UnexpectedEof => "RemoteDisconnected",
        InvalidData => "SSLError",
        NotFound => "gaierror",
        _ => "OSError",
    }
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One HTTPS request on a fresh connection; `check` sees the server's certificate before the request goes out.
/// Err is the Python exception class name of the failure, or the message `check` gave.
#[allow(clippy::too_many_arguments)]
pub fn https_request(cfg: &Arc<ClientConfig>, host: &str, port: u16, timeout: f64, method: &str, path: &str, headers: &[(&str, String)], body: Option<&[u8]>, check: &dyn Fn(&[u8]) -> Result<(), String>) -> Result<Response, Result<String, String>> {
    https_request_capped(cfg, host, port, timeout, method, path, headers, body, check, usize::MAX)
}

/// `https_request` reading at most `cap` answer bytes: past that, Err(Ok("reply too large")) (contract r6 7.2.3, the
/// service hub's relays).
#[allow(clippy::too_many_arguments)]
pub fn https_request_capped(
    cfg: &Arc<ClientConfig>, host: &str, port: u16, timeout: f64, method: &str, path: &str, headers: &[(&str, String)], body: Option<&[u8]>, check: &dyn Fn(&[u8]) -> Result<(), String>, cap: usize,
) -> Result<Response, Result<String, String>> {
    let io = |e: std::io::Error| -> Result<String, String> { Err(error_class(&e).to_string()) };
    let mut tcp = connect(host, port, timeout)?;
    let name = ServerName::try_from(host.to_string()).map_err(|_| Err("SSLError".to_string()))?;
    let mut conn = rustls::ClientConnection::new(cfg.clone(), name).map_err(|_| Err("SSLError".to_string()))?;
    while conn.is_handshaking() {
        conn.complete_io(&mut tcp).map_err(io)?;
    }
    let peer = conn.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec()).unwrap_or_default();
    check(&peer).map_err(Ok)?;
    exchange(rustls::StreamOwned::new(conn, tcp), host, port, method, path, headers, body, cap)
}

/// One plain HTTP request on a fresh connection (a service on this machine); Err as https_request's.
pub fn http_request(host: &str, port: u16, timeout: f64, method: &str, path: &str, headers: &[(&str, String)], body: Option<&[u8]>) -> Result<Response, Result<String, String>> {
    http_request_capped(host, port, timeout, method, path, headers, body, usize::MAX)
}

/// `http_request` reading at most `cap` answer bytes, as `https_request_capped`.
#[allow(clippy::too_many_arguments)]
pub fn http_request_capped(host: &str, port: u16, timeout: f64, method: &str, path: &str, headers: &[(&str, String)], body: Option<&[u8]>, cap: usize) -> Result<Response, Result<String, String>> {
    let tcp = connect(host, port, timeout)?;
    exchange(tcp, host, port, method, path, headers, body, cap)
}

/// The answer cap's refusal.
const TOO_LARGE: &str = "reply too large";

/// A TCP connection to the first address of `host` that answers, read and write bounded by `timeout`.
fn connect(host: &str, port: u16, timeout: f64) -> Result<TcpStream, Result<String, String>> {
    let t = Duration::from_secs_f64(timeout);
    let addrs: Vec<_> = (host, port).to_socket_addrs().map_err(|_| Err("gaierror".to_string()))?.collect();
    let mut last = None;
    for a in addrs {
        match TcpStream::connect_timeout(&a, t) {
            Ok(tcp) => {
                let _ = tcp.set_read_timeout(Some(t));
                let _ = tcp.set_write_timeout(Some(t));
                return Ok(tcp);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(Err(last.map(|e| error_class(&e)).unwrap_or("gaierror").to_string()))
}

/// One request on an open stream and its whole answer (Content-Length, chunked, or up to the close), at most `cap`
/// bytes of it: reading stops at `cap + 1` and answers Err(Ok(TOO_LARGE)).
#[allow(clippy::too_many_arguments)]
fn exchange<S: Read + Write>(mut stream: S, host: &str, port: u16, method: &str, path: &str, headers: &[(&str, String)], body: Option<&[u8]>, cap: usize) -> Result<Response, Result<String, String>> {
    let io = |e: std::io::Error| -> Result<String, String> { Err(error_class(&e).to_string()) };
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept-Encoding: identity\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(b) = body {
        head.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    head.push_str("Connection: close\r\n\r\n");
    let mut out = head.into_bytes();
    if let Some(b) = body {
        out.extend_from_slice(b);
    }
    stream.write_all(&out).map_err(io)?;
    stream.flush().map_err(io)?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).map_err(io)? == 0 {
        return Err(Err("RemoteDisconnected".into()));
    }
    let status: u16 = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| Err("BadStatusLine".to_string()))?;
    let (mut length, mut chunked) = (None, false);
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).map_err(io)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
            if k == "content-length" {
                length = v.parse::<usize>().ok();
            } else if k == "transfer-encoding" && v.eq_ignore_ascii_case("chunked") {
                chunked = true;
            }
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).map_err(io)?;
            let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).map_err(|_| Err("IncompleteRead".to_string()))?;
            if n == 0 {
                break;
            }
            // Read through `take` so memory grows with the bytes that arrive, never with the size the server claims.
            let want = n.min((cap - body.len()).saturating_add(1));
            let got = (&mut reader).take(want as u64).read_to_end(&mut body).map_err(io)?;
            if body.len() > cap {
                return Err(Ok(TOO_LARGE.into()));
            }
            if got != n {
                return Err(Err("IncompleteRead".into()));
            }
            let mut crlf = String::new();
            reader.read_line(&mut crlf).map_err(io)?;
        }
    } else if let Some(n) = length {
        if n > cap {
            return Err(Ok(TOO_LARGE.into()));
        }
        let got = (&mut reader).take(n as u64).read_to_end(&mut body).map_err(|_| Err("IncompleteRead".to_string()))?;
        if got != n {
            return Err(Err("IncompleteRead".into()));
        }
    } else {
        let _ = (&mut reader).take(cap.saturating_add(1) as u64).read_to_end(&mut body);
        if body.len() > cap {
            return Err(Ok(TOO_LARGE.into()));
        }
    }
    Ok(Response { status, body })
}

pub fn client_config(ca_file: Option<&str>, client: Option<(&str, &str)>) -> Result<Arc<ClientConfig>, String> {
    let provider = Arc::new(crate::server::provider());
    let roots = match ca_file {
        Some(path) => roots_of(path)?,
        None => {
            let mut r = RootCertStore::empty();
            r.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            r
        }
    };
    let b = ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().map_err(|e| e.to_string())?.with_root_certificates(roots);
    let cfg = match client {
        Some((cert, key)) => b.with_client_auth_cert(load_certs(cert, "certificate")?, load_key(key)?).map_err(|e| format!("the client certificate and key do not fit: {e}"))?,
        None => b.with_no_client_auth(),
    };
    Ok(Arc::new(cfg))
}

// ── SignerClient ─────────────────────────────────────────────────────────────────────────────────────────────

/// How a signer call failed: unreachable or unable to sign (the caller falls back to the PC path), or a refusal
/// mapped to the relay's errors (403, 404, 409, 400).
pub enum SignerErr {
    Down(String),
    Refused(E),
}

struct SignerState {
    status: Option<Obj>,
    error: String,
    checked: f64,
}

pub type OnStatus = Arc<dyn Fn(&Obj) + Send + Sync>;

/// The relay's side of the signer: `POST /v1/<op>` over mutual TLS with the relay's root-issued client
/// certificate. The signer's certificate must be issued DIRECTLY by the root.
pub struct SignerClient {
    host: String,
    port: u16,
    ca: String,
    cert: String,
    key: String,
    /// The client TLS and the serial of the client certificate it presents; swapped whole by `reload` (AC-2b-D 8.4,
    /// R2-M4), so a call in flight keeps the pair it started with and the next one uses the new pair.
    cfg: RwLock<(Arc<ClientConfig>, String)>,
    /// AC-2b-D 9.3 `meetPki.signerSerial`: the client certificate serial last used in a successful call, and when
    /// it first succeeded (seconds).
    ok_serial: Mutex<Option<(String, i64)>>,
    state: Mutex<SignerState>,
    pub on_status: Mutex<Option<OnStatus>>,
}

/// The serial (lower-case hex) of the first certificate in a PEM file, "" when it does not read.
pub fn cert_serial(path: &str) -> String {
    Cert::from_pem(&String::from_utf8_lossy(&read_bytes(Path::new(path)))).map(|c| c.serial).unwrap_or_default()
}

impl SignerClient {
    pub fn new(url: &str, cert: &str, key: &str, ca: &str) -> Result<SignerClient, String> {
        let rest = url.strip_prefix("https://").ok_or("signer_url must be https://host:port")?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let authority = authority.rsplit('@').next().unwrap_or_default();
        let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
            let (h, after) = v6.split_once(']').ok_or("signer_url must be https://host:port")?;
            (h.to_string(), after.strip_prefix(':').map(|p| p.parse::<u16>()).transpose().map_err(|_| "signer_url must be https://host:port")?.unwrap_or(443))
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), if p.is_empty() { 443 } else { p.parse::<u16>().map_err(|_| "signer_url must be https://host:port")? }),
                None => (authority.to_string(), 443),
            }
        };
        if host.is_empty() {
            return Err("signer_url must be https://host:port".into());
        }
        let cfg = client_config(Some(ca), Some((cert, key)))?;
        Ok(SignerClient {
            host: host.to_ascii_lowercase(),
            port,
            ca: ca.to_string(),
            cert: cert.to_string(),
            key: key.to_string(),
            cfg: RwLock::new((cfg, cert_serial(cert))),
            ok_serial: Mutex::new(None),
            state: Mutex::new(SignerState { status: None, error: String::new(), checked: -1e9 }),
            on_status: Mutex::new(None),
        })
    }

    /// AC-2b-D 8.4 (R2-M4): build the client TLS again from `signer_cert` and `signer_key` (which point into
    /// `pki/current`, just switched), without a restart; the next call presents the new pair. Err keeps the old one.
    pub fn reload(&self) -> Result<(), String> {
        let cfg = client_config(Some(&self.ca), Some((&self.cert, &self.key)))?;
        *self.cfg.write() = (cfg, cert_serial(&self.cert));
        Ok(())
    }

    /// The serial of the client certificate the next call presents.
    pub fn serial(&self) -> String {
        self.cfg.read().1.clone()
    }

    /// 9.3 `meetPki.signerSerial`: the client certificate serial last used in a successful call and when it first
    /// succeeded (seconds); None before any.
    pub fn last_ok(&self) -> Option<(String, i64)> {
        self.ok_serial.lock().clone()
    }

    /// 9.3 `meetPki.signerCrlEnforced` and `signerHeld` from the last status: whether the server says it refuses
    /// revoked relay certificates (`crl_enforced`, false when absent), and the list it holds `{number, thisUpdate}`
    /// (`thisUpdate` in ms; null without one).
    pub fn held(&self) -> (bool, serde_json::Value) {
        use serde_json::{json, Value};
        let Some(status) = self.snapshot() else { return (false, Value::Null) };
        let enforced = status.get("crl_enforced").and_then(Value::as_bool).unwrap_or(false);
        let held = match status.get("held_crl").and_then(Value::as_object) {
            Some(h) => {
                let number = match h.get("number") {
                    Some(Value::String(n)) if !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) => Value::from(n.clone()),
                    Some(Value::Number(n)) if n.is_u64() => Value::from(n.to_string()),
                    _ => Value::Null,
                };
                let this_update = h.get("this_update").and_then(Value::as_str).and_then(pj::from_iso).map(|t| Value::from((t * 1000.0) as i64)).unwrap_or(Value::Null);
                json!({"number": number, "thisUpdate": this_update})
            }
            None => Value::Null,
        };
        (enforced, held)
    }

    /// AC-2b-D 6.5, 8.4 (R3-M3): forward a root CRL this relay adopted to the certificate server (`root_crl`);
    /// "stored" and "unchanged" both count as taken.
    pub fn forward_root_crl(&self, der: &[u8]) -> Result<(), String> {
        match self.call("root_crl", &crate::meet_json::obj([("crl_der_b64", serde_json::Value::from(pj::b64(der)))])) {
            Ok(_) => Ok(()),
            Err(SignerErr::Down(m)) => Err(m),
            Err(SignerErr::Refused(e)) => Err(e.message()),
        }
    }

    fn down(&self, error: &str) {
        let mut s = self.state.lock();
        s.status = None;
        s.error = error.to_string();
        s.checked = pj::mono();
    }

    pub fn error(&self) -> String {
        self.state.lock().error.clone()
    }

    pub fn call(&self, op: &str, body: &Obj) -> Result<Obj, SignerErr> {
        let ca = self.ca.clone();
        let check = move |der: &[u8]| -> Result<(), String> {
            let root = Cert::from_pem(&String::from_utf8_lossy(&read_bytes(Path::new(&ca))));
            let leaf = Cert::from_der(der);
            match (leaf, root) {
                (Some(l), Some(r)) if l.issued_directly_by_root(&r) => Ok(()),
                _ => Err("the signer's certificate was not issued directly by the root".into()),
            }
        };
        let payload = pj::dumps(&serde_json::Value::Object(body.clone()));
        let (cfg, serial) = self.cfg.read().clone();
        let res = https_request(&cfg, &self.host, self.port, SIGNER_TIMEOUT, "POST", &format!("/v1/{op}"), &[("Content-Type", "application/json".to_string())], Some(payload.as_bytes()), &check);
        let resp = match res {
            Ok(r) => r,
            Err(Err(class)) => {
                let msg = format!("cannot reach the signer ({class})");
                self.down(&msg);
                return Err(SignerErr::Down(msg));
            }
            Err(Ok(msg)) => {
                self.down(&msg);
                return Err(SignerErr::Down(msg));
            }
        };
        let raw = if resp.body.is_empty() { b"{}".to_vec() } else { resp.body };
        let data = serde_json::from_slice::<serde_json::Value>(&raw).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if resp.status == 200 {
            let mut ok = self.ok_serial.lock();
            if !serial.is_empty() && ok.as_ref().is_none_or(|(s, _)| *s != serial) {
                *ok = Some((serial, pj::now() as i64));
            }
            return Ok(data);
        }
        let error = {
            let e = pj::s(&data, "error");
            if e.is_empty() { format!("the signer answered {}", resp.status) } else { e }
        };
        match resp.status {
            403 => Err(SignerErr::Refused(E::Forbidden(error))),
            404 => Err(SignerErr::Refused(E::NotFound(error))),
            409 => Err(SignerErr::Refused(E::Conflict(error))),
            s if s >= 500 => {
                self.down(&error);
                Err(SignerErr::Down(error))
            }
            _ => Err(SignerErr::Refused(E::Bad(error))),
        }
    }

    /// The signer's status now; Err (the SignerDown message) when it cannot answer.
    pub fn refresh(&self) -> Result<Obj, String> {
        let status = match self.call("status", &Obj::new()) {
            Ok(s) => s,
            Err(SignerErr::Down(m)) => return Err(m),
            Err(SignerErr::Refused(e)) => {
                let m = e.message();
                self.down(&m);
                return Err(m);
            }
        };
        {
            let mut s = self.state.lock();
            s.status = Some(status.clone());
            s.error = pj::s(&status, "error");
            s.checked = pj::mono();
        }
        let hook = self.on_status.lock().clone();
        if let Some(h) = hook {
            h(&status);
        }
        Ok(status)
    }

    pub fn snapshot(&self) -> Option<Obj> {
        let s = self.state.lock();
        s.status.as_ref().filter(|o| !o.is_empty()).cloned()
    }

    /// True when the signer said it can sign within the last SIGNER_TTL seconds (a failed check is not retried for
    /// SIGNER_RETRY seconds).
    pub fn ready(&self) -> bool {
        {
            let s = self.state.lock();
            let healthy = s.status.as_ref().map(|o| pj::truthy(o.get("healthy"))).unwrap_or(false);
            let age = pj::mono() - s.checked;
            if age < if healthy { SIGNER_TTL } else { SIGNER_RETRY } {
                return healthy;
            }
        }
        self.refresh().map(|s| pj::truthy(s.get("healthy"))).unwrap_or(false)
    }
}

/// Test certificates and lists written by hand in DER (P-256, ecdsa-with-SHA256), as the Admin Console writes them.
#[cfg(test)]
pub(crate) mod testpki {
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};

    const ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];

    pub fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let n = body.len();
        if n < 0x80 {
            out.push(n as u8);
        } else if n < 0x100 {
            out.extend([0x81, n as u8]);
        } else {
            out.extend([0x82, (n >> 8) as u8, n as u8]);
        }
        out.extend_from_slice(body);
        out
    }

    pub fn pem(label: &str, der: &[u8]) -> String {
        let b = crate::meet_json::b64(der);
        let lines: Vec<String> = b.as_bytes().chunks(64).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
        format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", lines.join("\n"))
    }

    fn int(b: &[u8]) -> Vec<u8> {
        let mut v = b.to_vec();
        if v.first().is_some_and(|x| x & 0x80 != 0) {
            v.insert(0, 0);
        }
        tlv(0x02, &v)
    }

    /// UTCTime of a time in seconds.
    pub fn time(secs: i64) -> Vec<u8> {
        let (y, m, d) = crate::meet_json::civil(secs.div_euclid(86_400));
        let t = secs.rem_euclid(86_400);
        tlv(0x17, format!("{:02}{m:02}{d:02}{:02}{:02}{:02}Z", y % 100, t / 3600, t / 60 % 60, t % 60).as_bytes())
    }

    fn name(cn: &str) -> Vec<u8> {
        tlv(0x30, &tlv(0x31, &tlv(0x30, &[tlv(0x06, &[0x55, 0x04, 0x03]), tlv(0x0c, cn.as_bytes())].concat())))
    }

    fn ext(oid: &[u8], critical: bool, value: &[u8]) -> Vec<u8> {
        let mut body = tlv(0x06, oid);
        if critical {
            body.extend(tlv(0x01, &[0xff]));
        }
        body.extend(tlv(0x04, value));
        tlv(0x30, &body)
    }

    fn alg() -> Vec<u8> {
        tlv(0x30, &tlv(0x06, ECDSA_SHA256))
    }

    pub struct Key {
        pair: EcdsaKeyPair,
        pub pkcs8: Vec<u8>,
        pub spki: Vec<u8>,
    }

    impl Key {
        pub fn new() -> Key {
            let rng = SystemRandom::new();
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap().as_ref().to_vec();
            let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &pkcs8).unwrap();
            let spki = crate::der::p256_spki_der(&crate::der::P256Key::from_sec1(pair.public_key().as_ref()).unwrap());
            Key { pair, pkcs8, spki }
        }

        fn signed(&self, tbs: Vec<u8>) -> Vec<u8> {
            let sig = self.pair.sign(&SystemRandom::new(), &tbs).unwrap();
            tlv(0x30, &[tbs, alg(), tlv(0x03, &[&[0u8][..], sig.as_ref()].concat())].concat())
        }

        pub fn key_pem(&self) -> String {
            pem("PRIVATE KEY", &self.pkcs8)
        }

        fn id(&self) -> Vec<u8> {
            crate::codec::sha256(&self.spki)[..20].to_vec()
        }
    }

    /// A self-signed organization CA (CA true, keyCertSign and cRLSign, subject key identifier).
    pub struct Ca {
        pub key: Key,
        pub cn: String,
        pub der: Vec<u8>,
    }

    impl Ca {
        pub fn new(cn: &str) -> Ca {
            let key = Key::new();
            let now = crate::meet_json::now() as i64;
            let exts = [
                ext(&[0x55, 0x1d, 0x13], true, &tlv(0x30, &tlv(0x01, &[0xff]))),
                ext(&[0x55, 0x1d, 0x0f], true, &tlv(0x03, &[0x01, 0x06])),
                ext(&[0x55, 0x1d, 0x0e], false, &tlv(0x04, &key.id())),
            ]
            .concat();
            let tbs = tlv(0x30, &[tlv(0xa0, &int(&[2])), int(&[1]), alg(), name(cn), tlv(0x30, &[time(now - 86_400), time(now + 365 * 86_400)].concat()), name(cn), key.spki.clone(), tlv(0xa3, &tlv(0x30, &exts))].concat());
            let der = key.signed(tbs);
            Ca { key, cn: cn.to_string(), der }
        }

        pub fn pem(&self) -> String {
            pem("CERTIFICATE", &self.der)
        }

        /// A leaf for `key`: `cn`, an optional email and the SAN URIs given; clientAuth when `client`, else serverAuth
        /// with `cn` as its DNS name.
        pub fn leaf(&self, serial: &[u8], cn: &str, email: Option<&str>, uris: &[&str], key: &Key, client: bool) -> Vec<u8> {
            let now = crate::meet_json::now() as i64;
            self.leaf_valid(serial, cn, email, uris, key, client, now - 3600, now + 90 * 86_400)
        }

        /// An intermediate CA under this one, valid from `not_before` to `not_after` (seconds).
        pub fn sub(&self, cn: &str, not_before: i64, not_after: i64) -> Ca {
            let key = Key::new();
            let exts = [
                ext(&[0x55, 0x1d, 0x13], true, &tlv(0x30, &tlv(0x01, &[0xff]))),
                ext(&[0x55, 0x1d, 0x0f], true, &tlv(0x03, &[0x01, 0x06])),
                ext(&[0x55, 0x1d, 0x0e], false, &tlv(0x04, &key.id())),
                ext(&[0x55, 0x1d, 0x23], false, &tlv(0x30, &tlv(0x80, &self.key.id()))),
            ]
            .concat();
            let tbs = tlv(0x30, &[tlv(0xa0, &int(&[2])), int(&[7]), alg(), name(&self.cn), tlv(0x30, &[time(not_before), time(not_after)].concat()), name(cn), key.spki.clone(), tlv(0xa3, &tlv(0x30, &exts))].concat());
            let der = self.key.signed(tbs);
            Ca { key, cn: cn.to_string(), der }
        }

        /// `leaf` valid from `not_before` to `not_after` (seconds).
        #[allow(clippy::too_many_arguments)]
        pub fn leaf_valid(&self, serial: &[u8], cn: &str, email: Option<&str>, uris: &[&str], key: &Key, client: bool, not_before: i64, not_after: i64) -> Vec<u8> {
            let mut san: Vec<u8> = Vec::new();
            if let Some(e) = email {
                san.extend(tlv(0x81, e.as_bytes()));
            }
            for u in uris {
                san.extend(tlv(0x86, u.as_bytes()));
            }
            if !client {
                san.extend(tlv(0x82, cn.as_bytes()));
            }
            let eku: &[u8] = if client { &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02] } else { &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01] };
            let mut exts = vec![
                ext(&[0x55, 0x1d, 0x13], true, &tlv(0x30, &[])),
                ext(&[0x55, 0x1d, 0x0f], true, &tlv(0x03, &[0x07, 0x80])),
                ext(&[0x55, 0x1d, 0x25], false, &tlv(0x30, &tlv(0x06, eku))),
                ext(&[0x55, 0x1d, 0x23], false, &tlv(0x30, &tlv(0x80, &self.key.id()))),
            ];
            if !san.is_empty() {
                exts.push(ext(&[0x55, 0x1d, 0x11], false, &tlv(0x30, &san)));
            }
            let tbs = tlv(0x30, &[tlv(0xa0, &int(&[2])), int(serial), alg(), name(&self.cn), tlv(0x30, &[time(not_before), time(not_after)].concat()), name(cn), key.spki.clone(), tlv(0xa3, &tlv(0x30, &exts.concat()))].concat());
            self.key.signed(tbs)
        }

        /// A v2 CRL with the serials revoked, optionally a CRL number, and always an authority key identifier.
        pub fn crl(&self, this_update: i64, next_update: i64, serials: &[&[u8]], number: Option<&[u8]>) -> Vec<u8> {
            let revoked: Vec<u8> = serials.iter().map(|s| tlv(0x30, &[int(s), time(this_update)].concat())).collect::<Vec<_>>().concat();
            let mut exts = vec![ext(&[0x55, 0x1d, 0x23], false, &tlv(0x30, &tlv(0x80, &self.key.id())))];
            if let Some(n) = number {
                exts.push(ext(&[0x55, 0x1d, 0x14], false, &int(n)));
            }
            let mut parts = vec![int(&[1]), alg(), name(&self.cn), time(this_update), time(next_update)];
            if !revoked.is_empty() {
                parts.push(tlv(0x30, &revoked));
            }
            parts.push(tlv(0xa0, &tlv(0x30, &exts.concat())));
            self.key.signed(tlv(0x30, &parts.concat()))
        }

        pub fn crl_pem(&self, this_update: i64, next_update: i64, serials: &[&[u8]], number: Option<&[u8]>) -> String {
            pem("X509 CRL", &self.crl(this_update, next_update, serials, number))
        }
    }

    /// A fresh folder under the temporary folder.
    pub fn dir(name: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("lucid-deploy-{name}-{}-{}-{n}", std::process::id(), crate::codec::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}

#[cfg(test)]
mod tests {
    use super::testpki::{dir, pem, Ca, Key};
    use super::*;

    const DAY: i64 = 86_400;

    fn now() -> i64 {
        pj::now() as i64
    }

    /// A canned answer for `exchange`; what the client writes is dropped.
    struct Canned(std::io::Cursor<Vec<u8>>);
    impl Read for Canned {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(b)
        }
    }
    impl Write for Canned {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn answer(raw: &str) -> Result<Response, Result<String, String>> {
        answer_capped(raw, usize::MAX)
    }

    fn answer_capped(raw: &str, cap: usize) -> Result<Response, Result<String, String>> {
        exchange(Canned(std::io::Cursor::new(raw.as_bytes().to_vec())), "relay.test", 443, "GET", "/", &[], None, cap)
    }

    /// Contract r6 7.2.3 (the service hub's relays): with a cap, reading stops at cap + 1 bytes whatever the framing.
    #[test]
    fn a_capped_answer_stops_at_the_cap() {
        let too_large = Some(Ok(TOO_LARGE.to_string()));
        assert_eq!(answer_capped("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabcdef", 5).err(), too_large);
        assert_eq!(answer_capped(&format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\nab", usize::MAX / 2), 5).err(), too_large, "refused before any read");
        assert_eq!(answer_capped("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n", 5).err(), too_large);
        assert_eq!(answer_capped("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nfffffffffffff\r\nabcdef", 5).err(), too_large);
        assert_eq!(answer_capped("HTTP/1.1 200 OK\r\n\r\nabcdef", 5).err(), too_large, "up to the close");
        assert_eq!(answer_capped("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nabcde", 5).unwrap().body, b"abcde");
        assert_eq!(answer_capped("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n", 5).unwrap().body, b"abcde");
        assert_eq!(answer_capped("HTTP/1.1 200 OK\r\n\r\nabcde", 5).unwrap().body, b"abcde");
    }

    /// A server that claims a huge length (plain or chunked) and then closes gets IncompleteRead, without the client
    /// first allocating the size it claimed; honest answers still read whole.
    #[test]
    fn a_claimed_length_is_not_allocated_before_it_arrives() {
        let huge = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\nabc", usize::MAX / 2);
        assert_eq!(answer(&huge).err(), Some(Err("IncompleteRead".to_string())));
        let chunk = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nfffffffffffff\r\nabc";
        assert_eq!(answer(chunk).err(), Some(Err("IncompleteRead".to_string())));
        assert_eq!(answer("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc").unwrap().body, b"abc");
        let ok = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";
        assert_eq!(answer(ok).unwrap().body, b"abcde");
    }

    /// AC-2b-D 8.5 (H5) and 16.1 d-relay: the console's list, with a CRL number and an authority key identifier, is
    /// read by meet_tls (its number too), checked by the relay's verifier, and parsed by rustls (webpki) as well.
    #[test]
    fn ac2b_console_crl_with_number_and_aki_is_accepted() {
        let ca = Ca::new("Lucid Meet CA");
        let device = Key::new();
        let leaf = ca.leaf(&[0x51, 0x0f], "Ann", Some("ann@x.org"), &["urn:lucid-meet:device:0123456789abcdef"], &device, true);
        let t = now();
        let listed = ca.crl(t - 300, t + 120 * DAY, &[&[0x51, 0x0f]], Some(&[0x01, 0x00]));
        let clean = ca.crl(t - 300, t + 120 * DAY, &[], Some(&[0x01, 0x01]));
        let crl = Crl::from_der(&listed).unwrap();
        assert_eq!((crl_number(&crl), number_text(&crl_number(&crl).unwrap())), (Some(vec![0x01, 0x00]), "256".to_string()));
        let root = Cert::from_der(&ca.der).unwrap();
        assert!(crl.signature_valid(&root.spki));
        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from(ca.der.clone())).unwrap();
        let provider = Arc::new(crate::server::provider());
        let roots = Arc::new(roots);
        // rustls (webpki) parses both lists
        let crls = vec![rustls::pki_types::CertificateRevocationListDer::from(listed.clone()), rustls::pki_types::CertificateRevocationListDer::from(clean.clone())];
        assert!(WebPkiClientVerifier::builder_with_provider(roots.clone(), provider.clone()).with_crls(crls).build().is_ok());
        // the relay's verifier: listed is revoked, the clean list passes
        let inner = WebPkiClientVerifier::builder_with_provider(roots, provider).build().unwrap();
        let verifier = |der: &[u8]| MeetVerifier { inner: inner.clone(), roots: vec![root.clone()], crls: vec![Crl::from_der(der).unwrap()], chain: false, revoke: true, grace: Grace(None) };
        assert_eq!(verifier(&listed).revocation(&leaf, &[], t), Err(CertificateError::Revoked));
        assert_eq!(verifier(&clean).revocation(&leaf, &[], t), Ok(()));
        // a list whose thisUpdate has not passed does not count yet (check_one's zero tolerance)
        let ahead = ca.crl(t + 30, t + 120 * DAY, &[], Some(&[0x02]));
        assert_eq!(verifier(&ahead).revocation(&leaf, &[], t), Err(CertificateError::UnknownRevocationStatus));
    }

    /// API-1 3.3: a verifier over `ca` (its CRL `crl`, if any, in force) whose grace source gives `hours` to everyone.
    fn grace_verifier(ca: &Ca, crl: Option<Vec<u8>>, hours: Option<i64>) -> MeetVerifier {
        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from(ca.der.clone())).unwrap();
        let inner = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), Arc::new(crate::server::provider())).build().unwrap();
        let grace = hours.map(|h| -> GraceSource { Arc::new(move |g: &GraceSubject, _now: i64| g.not_after + h * 3600) });
        let crls: Vec<Crl> = crl.iter().filter_map(|d| Crl::from_der(d)).collect();
        MeetVerifier { inner, roots: vec![Cert::from_der(&ca.der).unwrap()], revoke: !crls.is_empty(), crls, chain: false, grace: Grace(grace) }
    }

    fn verify(v: &MeetVerifier, leaf: &[u8], inters: &[&[u8]]) -> Result<(), rustls::Error> {
        let inters: Vec<CertificateDer<'static>> = inters.iter().map(|d| CertificateDer::from(d.to_vec())).collect();
        v.verify_client_cert(&CertificateDer::from(leaf.to_vec()), &inters, UnixTime::now()).map(|_| ())
    }

    fn expired(r: &Result<(), rustls::Error>) -> bool {
        matches!(r, Err(rustls::Error::InvalidCertificate(CertificateError::Expired | CertificateError::ExpiredContext { .. })))
    }

    const HOUR: i64 = 3600;

    #[test]
    fn api1_an_expired_leaf_passes_inside_the_grace_only() {
        let ca = Ca::new("Lucid Meet CA");
        let t = now();
        let leaf = ca.leaf_valid(&[0x61], "Ann", Some("ann@x.org"), &[], &Key::new(), true, t - 10 * HOUR, t - 2 * HOUR);
        let late = ca.leaf_valid(&[0x62], "Ann", Some("ann@x.org"), &[], &Key::new(), true, t - 40 * HOUR, t - 25 * HOUR);
        let clean = ca.crl(t - 300, t + 120 * DAY, &[], None);
        // inside a 24 hour grace, the CRL checked at now
        assert_eq!(verify(&grace_verifier(&ca, Some(clean.clone()), Some(24)), &leaf, &[]), Ok(()));
        assert_eq!(verify(&grace_verifier(&ca, None, Some(24)), &leaf, &[]), Ok(()));
        // past it: the original error
        assert!(expired(&verify(&grace_verifier(&ca, Some(clean.clone()), Some(24)), &late, &[])));
        // grace 0 and no grace source refuse alike, with webpki's own error
        assert!(expired(&verify(&grace_verifier(&ca, Some(clean.clone()), Some(0)), &leaf, &[])));
        assert!(expired(&verify(&grace_verifier(&ca, Some(clean), None), &leaf, &[])));
        // a leaf that has not expired is today's path
        let fresh = ca.leaf(&[0x63], "Ann", Some("ann@x.org"), &[], &Key::new(), true);
        assert_eq!(verify(&grace_verifier(&ca, None, Some(0)), &fresh, &[]), Ok(()));
    }

    #[test]
    fn api1_the_grace_never_covers_a_revoked_leaf_an_expired_issuer_or_a_broken_chain() {
        let ca = Ca::new("Lucid Meet CA");
        let t = now();
        // revoked: the CRL at now lists it
        let leaf = ca.leaf_valid(&[0x71], "Ann", Some("ann@x.org"), &[], &Key::new(), true, t - 10 * HOUR, t - 2 * HOUR);
        let listed = ca.crl(t - 300, t + 120 * DAY, &[&[0x71]], None);
        assert!(expired(&verify(&grace_verifier(&ca, Some(listed), Some(24)), &leaf, &[])));
        // an expired CRL refuses too
        let stale = ca.crl(t - 10 * DAY, t - DAY, &[], None);
        assert!(expired(&verify(&grace_verifier(&ca, Some(stale), Some(24)), &leaf, &[])));
        // the intermediate was valid at the leaf's notAfter but is expired now
        let old = ca.sub("Lucid Meet Issuing", t - 20 * HOUR, t - HOUR);
        let under_old = old.leaf_valid(&[0x72], "Ann", Some("ann@x.org"), &[], &Key::new(), true, t - 10 * HOUR, t - 2 * HOUR);
        assert!(verify(&grace_verifier(&ca, None, Some(24)), &under_old, &[old.der.as_slice()]).is_err());
        let good = ca.sub("Lucid Meet Issuing", t - 20 * HOUR, t + DAY);
        let under_good = good.leaf_valid(&[0x73], "Ann", Some("ann@x.org"), &[], &Key::new(), true, t - 10 * HOUR, t - 2 * HOUR);
        assert_eq!(verify(&grace_verifier(&ca, None, Some(24)), &under_good, &[good.der.as_slice()]), Ok(()));
        // the chain does not build: another CA's leaf, or the intermediate missing
        let other = Ca::new("Another CA");
        let stranger = other.leaf_valid(&[0x74], "Ann", Some("ann@x.org"), &[], &Key::new(), true, t - 10 * HOUR, t - 2 * HOUR);
        assert!(verify(&grace_verifier(&ca, None, Some(24)), &stranger, &[]).is_err());
        assert!(verify(&grace_verifier(&ca, None, Some(24)), &under_good, &[]).is_err());
    }

    /// API-1 4.2: a certificate on the API listener counts only after a current CRL was checked for it.
    #[test]
    fn api1_listener_certificate_counts_only_under_a_current_crl() {
        let ca = Ca::new("Lucid Meet CA");
        let t = now();
        let leaf = ca.leaf(&[0x81], "monitor", None, &["urn:lucid-meet:app:acme"], &Key::new(), true);
        let d = dir("api-crl");
        let ca_file = d.join("ca.crt");
        std::fs::write(&ca_file, ca.pem()).unwrap();
        let crl_file = d.join("crl.pem");
        let s = Settings { client_ca: ca_file.to_string_lossy().into(), crl: String::new(), state_dir: String::new(), ..Settings::default() };
        // no CRL file: the handshake config still loads (anonymous clients are served) but the certificate never counts
        assert!(!api_cert_revocation_checked(&s, &leaf, &[], t));
        let s = Settings { crl: crl_file.to_string_lossy().into(), ..s };
        // a current list naming its serial: refused
        std::fs::write(&crl_file, ca.crl_pem(t - 300, t + DAY, &[&[0x81]], None)).unwrap();
        assert!(!api_cert_revocation_checked(&s, &leaf, &[], t));
        // a current list without it: accepted
        std::fs::write(&crl_file, ca.crl_pem(t - 300, t + DAY, &[], None)).unwrap();
        assert!(api_cert_revocation_checked(&s, &leaf, &[], t));
        // an expired list, or a file with no list: not counted
        std::fs::write(&crl_file, ca.crl_pem(t - 10 * DAY, t - DAY, &[], None)).unwrap();
        assert!(!api_cert_revocation_checked(&s, &leaf, &[], t));
        std::fs::write(&crl_file, "").unwrap();
        assert!(!api_cert_revocation_checked(&s, &leaf, &[], t));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ac2b_crl_order_and_time() {
        let ca = Ca::new("Lucid Meet CA");
        let t = now();
        let read = |der: Vec<u8>| Crl::from_der(&der).unwrap();
        let (a, b) = (read(ca.crl(t - 10, t + DAY, &[], Some(&[5]))), read(ca.crl(t - 10, t + DAY, &[], Some(&[6]))));
        assert!(crl_later(&b, &a) && !crl_later(&a, &b), "the same thisUpdate: the higher number wins");
        let later = read(ca.crl(t - 5, t + DAY, &[], Some(&[1])));
        assert!(crl_later(&later, &b), "a later thisUpdate wins over a higher number");
        let bare = read(ca.crl(t - 10, t + DAY, &[], None));
        assert!(!crl_later(&bare, &a) && !crl_later(&a, &bare), "without a number on both, the same thisUpdate orders neither");
        assert_eq!(crl_number(&bare), None);
        assert_eq!(number_text(&[0x00]), "0");
        assert_eq!(number_text(&[0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), "18446744073709551616");
        let at = |d: i64| crl_time(&read(ca.crl(t + d, t + DAY, &[], Some(&[1]))), t);
        assert_eq!((at(0), at(-1), at(1), at(300), at(301)), (CrlTime::Current, CrlTime::Current, CrlTime::Pending, CrlTime::Pending, CrlTime::Future));
    }

    /// R3-M1, R2-H1, D9: current lists go in force, lists at most 5 minutes ahead wait as pending while the previous
    /// list stays in force, lists further ahead are refused, and the timer adopts a pending list when it is current.
    #[test]
    fn ac2b_root_crl_adoption_rules() {
        let ca = Ca::new("Lucid Meet CA");
        let d = dir("adopt");
        let ca_file = d.join("ca.crt");
        std::fs::write(&ca_file, ca.pem()).unwrap();
        let console_now = now();
        let place = |pem: &str, relay_now: i64| place_root_crl(&d, &ca_file, pem.as_bytes(), relay_now * 1000);
        // the console dates its list now - 5 minutes
        let first = ca.crl_pem(console_now - 300, console_now + 120 * DAY, &[], Some(&[1]));
        assert_eq!(place(&first, console_now), Ok(Placed::Current));
        let bundle = std::fs::read(d.join("crl.pem")).unwrap();
        assert!(String::from_utf8_lossy(&bundle).contains("BEGIN X509 CRL"));
        // a relay 30 s behind: a list dated the console's now - 5 minutes is current there too
        let second = ca.crl_pem(console_now - 299, console_now + 120 * DAY, &[&[7]], Some(&[2]));
        assert_eq!(place(&second, console_now - 30), Ok(Placed::Current));
        // a relay 7 minutes behind: the next list is 2 minutes ahead on its clock and waits; the previous list stays
        let relay_now = console_now - 420;
        let third = ca.crl_pem(console_now - 298, console_now + 120 * DAY, &[&[7], &[8]], Some(&[3]));
        let before = std::fs::read(d.join("crl.pem")).unwrap();
        assert_eq!(place(&third, relay_now), Ok(Placed::Pending));
        assert_eq!(std::fs::read(d.join("crl.pem")).unwrap(), before, "the previous list stays in force");
        assert!(d.join(ROOT_CRL_PENDING).exists());
        assert_eq!(pending_crl_due(&d), Some(console_now - 298));
        assert!(adopt_pending_crl(&d, &ca_file, relay_now).is_none(), "not before its thisUpdate");
        let (adopted, _) = adopt_pending_crl(&d, &ca_file, console_now - 298).unwrap();
        assert_eq!(adopted.serials.len(), 2);
        assert!(!d.join(ROOT_CRL_PENDING).exists());
        assert_ne!(std::fs::read(d.join("crl.pem")).unwrap(), before);
        // older lists, other signers, expired lists and lists more than 5 minutes ahead are refused
        assert_eq!(place(&second, console_now).unwrap_err(), "older");
        let other = Ca::new("Lucid Meet CA");
        assert_eq!(place(&other.crl_pem(console_now, console_now + DAY, &[], Some(&[9])), console_now).unwrap_err(), "signature");
        assert_eq!(place(&ca.crl_pem(console_now - 2 * DAY, console_now - DAY, &[], Some(&[9])), console_now).unwrap_err(), "expired");
        assert_eq!(place(&ca.crl_pem(console_now + 360, console_now + DAY, &[], Some(&[9])), console_now).unwrap_err(), "future");
        assert_eq!(place("not a list", console_now).unwrap_err(), "unreadable");
        // the very list in place changes nothing
        assert!(place_root_crl_changed(&d, &ca_file, adopted_pem(&d).as_bytes(), console_now).is_ok_and(|(p, changed)| p == Placed::Current && !changed));
    }

    fn adopted_pem(d: &Path) -> String {
        String::from_utf8(std::fs::read(d.join(ROOT_CRL)).unwrap()).unwrap()
    }

    /// R2-H1: a list in place that is not current (it came another way) never blocks a current list with a higher CRL
    /// number, or any current list when it has none.
    #[test]
    fn ac2b_a_list_in_place_that_is_not_current_is_replaced() {
        let ca = Ca::new("Lucid Meet CA");
        let d = dir("ahead");
        let ca_file = d.join("ca.crt");
        std::fs::write(&ca_file, ca.pem()).unwrap();
        let t = now();
        std::fs::write(d.join(ROOT_CRL), ca.crl_pem(t + 3600, t + 120 * DAY, &[], Some(&[10]))).unwrap();
        let place = |pem: String| place_root_crl(&d, &ca_file, pem.as_bytes(), t * 1000);
        assert_eq!(place(ca.crl_pem(t - 300, t + 120 * DAY, &[], Some(&[9]))).unwrap_err(), "older");
        assert_eq!(place(ca.crl_pem(t - 300, t + 120 * DAY, &[], Some(&[11]))), Ok(Placed::Current));
        std::fs::write(d.join(ROOT_CRL), ca.crl_pem(t + 3600, t + 120 * DAY, &[], None)).unwrap();
        assert_eq!(place(ca.crl_pem(t - 300, t + 120 * DAY, &[], None)), Ok(Placed::Current));
    }

    /// 9.3 `meetCrl`: the source, the list in force and the pending one.
    #[test]
    fn ac2b_meet_crl_report() {
        let ca = Ca::new("Lucid Meet CA");
        let d = dir("report");
        let ca_file = d.join("ca.crt");
        std::fs::write(&ca_file, ca.pem()).unwrap();
        let mut s = Settings { state_dir: d.to_string_lossy().into_owned(), client_ca: ca_file.to_string_lossy().into_owned(), ..Settings::default() };
        assert_eq!(meet_crl_report(&s)["source"], "none");
        let t = now();
        let der = ca.crl(t - 300, t + 120 * DAY, &[], Some(&[0x2a]));
        place_root_crl(&d, &ca_file, pem("X509 CRL", &der).as_bytes(), t * 1000).unwrap();
        place_root_crl(&d, &ca_file, ca.crl_pem(t + 60, t + 120 * DAY, &[], Some(&[0x2b])).as_bytes(), t * 1000).unwrap();
        let r = meet_crl_report(&s);
        let id = crate::license::meet_root_id(&Cert::from_der(&ca.der).unwrap().spki);
        assert_eq!((r["source"].as_str(), r["number"].as_str(), r["issuer"].as_str()), (Some("bundle"), Some("42"), Some(id.as_str())));
        assert_eq!(r["thisUpdate"], (t - 300) * 1000);
        assert_eq!(r["sha256"], crate::codec::sha256_hex(&der));
        assert_eq!(r["pending"]["number"], "43");
        assert_eq!(meet_root_ids(&ca_file), vec![id]);
        s.crl = d.join(ROOT_CRL).to_string_lossy().into_owned();
        assert_eq!((meet_crl_report(&s)["source"].as_str(), meet_crl_report(&s)["pending"].is_null()), (Some("fixed"), true));
    }

    /// R2-M4: a renewal rebuilds the certificate server client from `pki/current` without a restart; the next call
    /// presents the new pair.
    #[test]
    fn ac2b_signer_client_reloads_the_renewed_pair() {
        let ca = Ca::new("Lucid Meet CA");
        let d = dir("signer");
        let (cert, key, ca_file) = (d.join("signer-client.crt"), d.join("signer-client.key"), d.join("ca.crt"));
        std::fs::write(&ca_file, ca.pem()).unwrap();
        let write = |serial: &[u8]| {
            let k = Key::new();
            std::fs::write(&cert, pem("CERTIFICATE", &ca.leaf(serial, "Lucid Meet Relay", None, &["urn:lucid-meet:relay"], &k, true))).unwrap();
            std::fs::write(&key, k.key_pem()).unwrap();
        };
        write(&[0x11]);
        let path = |p: &Path| p.to_string_lossy().into_owned();
        let client = SignerClient::new("https://127.0.0.1:1", &path(&cert), &path(&key), &path(&ca_file)).unwrap();
        assert_eq!(client.serial(), "11");
        assert_eq!(client.last_ok(), None);
        write(&[0x22]);
        assert_eq!(client.serial(), "11", "nothing changes until the switch");
        client.reload().unwrap();
        assert_eq!(client.serial(), "22");
        // a pair that does not load keeps the one in use
        std::fs::write(&key, "nope").unwrap();
        assert!(client.reload().is_err());
        assert_eq!(client.serial(), "22");
        assert_eq!(client.held(), (false, serde_json::Value::Null));
        // 9.3 `meetPki.signerHeld` and `signerCrlEnforced` from the server's status (R5-L2, R3-M3)
        let status = serde_json::json!({"healthy": true, "crl_enforced": true, "held_crl": {"number": "77", "this_update": "2026-11-19T10:00:00+00:00", "next_update": null, "expired": false, "revoked": 3}});
        client.state.lock().status = status.as_object().cloned();
        let at = (pj::from_iso("2026-11-19T10:00:00+00:00").unwrap() * 1000.0) as i64;
        assert_eq!(client.held(), (true, serde_json::json!({"number": "77", "thisUpdate": at})));
        client.state.lock().status = serde_json::json!({"healthy": true}).as_object().cloned();
        assert_eq!(client.held(), (false, serde_json::Value::Null));
    }
}
