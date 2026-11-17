// AC-2a 3.2 (F2): the management PKI's DER writer and certificate profiles. The relay crate reads X.509 elsewhere
// (der.rs, meet_x509.rs); this file writes the three certificates the management channel uses (the management CA,
// the management server leaf, a relay's management leaf), signs them with the CA's ECDSA P-384 key on AWS-LC, and
// reads every certificate it writes back through `meet_x509::Cert` before it is used. It also holds the ECDSA key
// type (P-256 for relays and the server, P-384 for the CA) and the usage checks of invariant 6: a relay leaf is
// clientAuth only and CA false, a server leaf serverAuth only and CA false, so neither can pass as the other.
//
// Profile (vector `admin_console_fleet_x509_v1.json`): version 3; serial a positive INTEGER; signature
// ecdsa-with-SHA384 (no parameters); names as UTF8String; validity UTCTime before 2050, GeneralizedTime after;
// extensions in the order basicConstraints, keyUsage, extendedKeyUsage, subjectAltName, subjectKeyIdentifier,
// authorityKeyIdentifier, each present only where 3.2 names it; basicConstraints and keyUsage critical. The subject
// key identifier is the first 20 bytes of SHA-256 of the subjectPublicKey BIT STRING contents (RFC 7093 method 1).

use crate::codec::{hex, sha256};
use crate::der::tlv;
use crate::fleet_wire::Redacted;
use crate::meet_x509::{int_hex, Cert};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{self as sig, EcdsaKeyPair, KeyPair, UnparsedPublicKey};

pub const OID_CN: &[u8] = &[0x55, 0x04, 0x03];
pub const OID_O: &[u8] = &[0x55, 0x04, 0x0a];
const OID_EC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_ECDSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
const OID_BC: &[u8] = &[0x55, 0x1d, 0x13];
const OID_KU: &[u8] = &[0x55, 0x1d, 0x0f];
const OID_EKU: &[u8] = &[0x55, 0x1d, 0x25];
const OID_SAN: &[u8] = &[0x55, 0x1d, 0x11];
const OID_SKI: &[u8] = &[0x55, 0x1d, 0x0e];
const OID_AKI: &[u8] = &[0x55, 0x1d, 0x23];
const OID_SERVER_AUTH: &[u8] = &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01];
const OID_CLIENT_AUTH: &[u8] = &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02];

/// The CA's common name (3.2).
pub const CA_CN: &str = "Lucid Admin Console management CA";
/// A relay leaf's SAN URI prefix (3.2).
pub const RELAY_URI: &str = "urn:lucid:relay:";
pub const DAY_MS: i64 = 86_400_000;
/// Lifetimes (3.2).
pub const CA_DAYS: i64 = 3653;
pub const LEAF_DAYS: i64 = 90;

// ── DER writer ──────────────────────────────────────────────────────────────────────────────────────────────

/// One TLV with a definite length (short or long form).
pub fn der(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 6);
    out.push(tag);
    let n = body.len();
    if n < 0x80 {
        out.push(n as u8);
    } else {
        let bytes: Vec<u8> = n.to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend_from_slice(&bytes);
    }
    out.extend_from_slice(body);
    out
}

fn seq(parts: &[Vec<u8>]) -> Vec<u8> {
    der(0x30, &parts.concat())
}

fn oid(o: &[u8]) -> Vec<u8> {
    der(0x06, o)
}

/// A positive INTEGER from big-endian bytes (minimal: leading zeros dropped, a zero byte added before a set top bit).
pub fn integer(raw: &[u8]) -> Vec<u8> {
    let mut v: Vec<u8> = raw.iter().copied().skip_while(|b| *b == 0).collect();
    if v.is_empty() || v[0] & 0x80 != 0 {
        v.insert(0, 0);
    }
    der(0x02, &v)
}

fn bit_string(data: &[u8], unused: u8) -> Vec<u8> {
    der(0x03, &[&[unused][..], data].concat())
}

/// Days since 1970-01-01 as a civil date (proleptic Gregorian).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A certificate time: UTCTime for 1950 to 2049, GeneralizedTime otherwise (RFC 5280 4.1.2.5); seconds, `Z`.
pub fn time(ms: i64) -> Vec<u8> {
    let secs = ms.div_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    let (h, mi, se) = (s / 3600, (s % 3600) / 60, s % 60);
    if (1950..2050).contains(&y) {
        der(0x17, format!("{:02}{:02}{:02}{:02}{:02}{:02}Z", y % 100, mo, d, h, mi, se).as_bytes())
    } else {
        der(0x18, format!("{:04}{:02}{:02}{:02}{:02}{:02}Z", y, mo, d, h, mi, se).as_bytes())
    }
}

/// A Name of one attribute per RDN, each a UTF8String, in the order given.
pub fn name(attrs: &[(&[u8], &str)]) -> Vec<u8> {
    let rdns: Vec<Vec<u8>> = attrs.iter().map(|(o, v)| der(0x31, &seq(&[oid(o), der(0x0c, v.as_bytes())]))).collect();
    seq(&rdns)
}

fn extension(o: &[u8], critical: bool, value: Vec<u8>) -> Vec<u8> {
    let mut parts = vec![oid(o)];
    if critical {
        parts.push(der(0x01, &[0xff]));
    }
    parts.push(der(0x04, &value));
    seq(&parts)
}

fn alg_ecdsa_sha384() -> Vec<u8> {
    seq(&[oid(OID_ECDSA_SHA384)])
}

/// The subjectPublicKey BIT STRING contents (the point) of an EC SubjectPublicKeyInfo.
fn spki_point(spki: &[u8]) -> Option<(&[u8], &[u8])> {
    let outer = tlv(spki)?;
    let alg = tlv(outer.value)?;
    let key = tlv(alg.rest)?;
    if outer.tag != 0x30 || alg.tag != 0x30 || key.tag != 0x03 || !key.rest.is_empty() {
        return None;
    }
    let kind = tlv(alg.value)?;
    let curve = tlv(kind.rest)?;
    if kind.value != OID_EC_KEY || curve.tag != 0x06 {
        return None;
    }
    let (&unused, point) = key.value.split_first()?;
    (unused == 0).then_some((curve.value, point))
}

/// RFC 7093 method 1: the first 20 bytes of SHA-256 of the subjectPublicKey's contents.
pub fn key_id(spki: &[u8]) -> Option<Vec<u8>> {
    let (_, point) = spki_point(spki)?;
    Some(sha256(point)[..20].to_vec())
}

/// The SubjectPublicKeyInfo of an uncompressed EC point on `curve`.
fn ec_spki(curve: &[u8], point: &[u8]) -> Vec<u8> {
    seq(&[seq(&[oid(OID_EC_KEY), oid(curve)]), bit_string(point, 0)])
}

// ── Keys ────────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Curve {
    /// Relay management keys and the management server key: ECDSA P-256 with SHA-256.
    P256,
    /// The management CA: ECDSA P-384 with SHA-384.
    P384,
}

impl Curve {
    fn signing(self) -> &'static sig::EcdsaSigningAlgorithm {
        match self {
            Curve::P256 => &sig::ECDSA_P256_SHA256_ASN1_SIGNING,
            Curve::P384 => &sig::ECDSA_P384_SHA384_ASN1_SIGNING,
        }
    }

    fn oid(self) -> &'static [u8] {
        match self {
            Curve::P256 => OID_P256,
            Curve::P384 => OID_P384,
        }
    }
}

/// An ECDSA private key on AWS-LC. `Debug` never prints it; its PKCS#8 bytes are only for sealing.
pub struct Key {
    pair: EcdsaKeyPair,
    pkcs8: Redacted<Vec<u8>>,
    curve: Curve,
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Key({:?}, <redacted>)", self.curve)
    }
}

impl Key {
    /// A fresh key drawn by AWS-LC.
    pub fn generate(curve: Curve) -> Result<Key, String> {
        let doc = EcdsaKeyPair::generate_pkcs8(curve.signing(), &SystemRandom::new()).map_err(|_| "a key could not be drawn".to_owned())?;
        Key::from_pkcs8(curve, doc.as_ref())
    }

    /// A key from its PKCS#8 bytes (as sealed).
    pub fn from_pkcs8(curve: Curve, pkcs8: &[u8]) -> Result<Key, String> {
        let pair = EcdsaKeyPair::from_pkcs8(curve.signing(), pkcs8).map_err(|_| "a sealed key does not read".to_owned())?;
        Ok(Key { pair, pkcs8: Redacted::new(pkcs8.to_vec()), curve })
    }

    /// The PKCS#8 bytes, for the sealed store only.
    pub fn pkcs8(&self) -> &[u8] {
        self.pkcs8.expose()
    }

    pub fn curve(&self) -> Curve {
        self.curve
    }

    /// The SubjectPublicKeyInfo DER (uncompressed point).
    pub fn spki(&self) -> Vec<u8> {
        ec_spki(self.curve.oid(), self.pair.public_key().as_ref())
    }

    /// An ASN.1 DER ECDSA signature: SHA-256 for P-256, SHA-384 for P-384.
    pub fn sign(&self, msg: &[u8]) -> Result<Vec<u8>, String> {
        self.pair.sign(&SystemRandom::new(), msg).map(|s| s.as_ref().to_vec()).map_err(|_| "a signature could not be made".to_owned())
    }
}

/// True when the P-256 key in `spki` made the DER signature `sig` over `msg` with SHA-256 (relay proofs, 3.3, 3.4).
pub fn verify_p256(spki: &[u8], msg: &[u8], signature: &[u8]) -> bool {
    match spki_point(spki) {
        Some((curve, point)) if curve == OID_P256 => UnparsedPublicKey::new(&sig::ECDSA_P256_SHA256_ASN1, point).verify(msg, signature).is_ok(),
        _ => false,
    }
}

/// True when the P-384 key in `spki` made the DER signature `sig` over `msg` with SHA-384 (CA signatures, 3.10).
pub fn verify_p384(spki: &[u8], msg: &[u8], signature: &[u8]) -> bool {
    match spki_point(spki) {
        Some((curve, point)) if curve == OID_P384 => UnparsedPublicKey::new(&sig::ECDSA_P384_SHA384_ASN1, point).verify(msg, signature).is_ok(),
        _ => false,
    }
}

/// Whether `spki` is a P-256 key (what enrollment, renewal and recovery accept from a relay).
pub fn is_p256_spki(spki: &[u8]) -> bool {
    matches!(spki_point(spki), Some((c, p)) if c == OID_P256 && p.len() == 65 && p[0] == 4 && sig::ParsedPublicKey::new(&sig::ECDSA_P256_SHA256_ASN1, p).is_ok())
}

/// A positive 16-byte serial (3.2): random, its first byte `(b & 0x7f) | 0x40` as the vector draws it, so the
/// INTEGER is always exactly these 16 bytes and its hex always 32 characters.
pub fn new_serial() -> Result<[u8; 16], String> {
    let mut s: [u8; 16] = crate::console_auth::random(16).ok_or("no random bytes")?.try_into().map_err(|_| "no random bytes".to_owned())?;
    s[0] = (s[0] & 0x7f) | 0x40;
    Ok(s)
}

/// The pin (3.2): SHA-256 of the CA certificate's SubjectPublicKeyInfo DER, as lowercase hex.
pub fn pin_hex(ca_der: &[u8]) -> Option<String> {
    Cert::from_der(ca_der).map(|c| hex(&sha256(&c.spki)))
}

/// A fingerprint as an operator compares it: case and white space ignored.
pub fn same_fingerprint(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.chars().filter(|c| !c.is_whitespace() && *c != ':').collect::<String>().to_ascii_lowercase();
    let (a, b) = (norm(a), norm(b));
    !a.is_empty() && a == b
}

/// The relay key fingerprint the operator and the admin compare (3.3): the first 20 hex of SHA-256(spki), in groups of
/// 4 separated by spaces.
pub fn relay_fingerprint(spki: &[u8]) -> String {
    let h = hex(&sha256(spki));
    h.as_bytes()[..20].chunks(4).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect::<Vec<_>>().join(" ")
}

// ── Profiles ────────────────────────────────────────────────────────────────────────────────────────────────

/// Which certificate (3.2).
#[derive(Clone, Debug)]
pub enum Profile {
    /// The management CA: `CN=Lucid Admin Console management CA, O=<host>`, CA true, pathLen 0.
    Ca { host: String },
    /// The management server leaf: `CN=<host>`, SAN DNS `host` then `names`, serverAuth only.
    Server { host: String, names: Vec<String> },
    /// A relay leaf: `CN=<relayId>`, SAN URI `urn:lucid:relay:<relayId>`, clientAuth only.
    Relay { relay_id: String },
}

/// What a certificate is written from.
pub struct Spec<'a> {
    pub profile: Profile,
    pub serial: &'a [u8],
    pub not_before_ms: i64,
    pub not_after_ms: i64,
    /// The subject's SubjectPublicKeyInfo DER.
    pub spki: &'a [u8],
    /// The issuing CA's certificate DER (None for the self-signed CA).
    pub issuer: Option<&'a [u8]>,
}

pub fn ca_name(host: &str) -> Vec<u8> {
    name(&[(OID_CN, CA_CN), (OID_O, host)])
}

/// The TBSCertificate of `spec` (the bytes the CA signs).
pub fn tbs(spec: &Spec) -> Result<Vec<u8>, String> {
    let ski = key_id(spec.spki).ok_or("the subject key is not an EC key")?;
    let (issuer_name, issuer_ski) = match spec.issuer {
        Some(ca) => {
            let c = Cert::from_der(ca).ok_or("the CA certificate does not read")?;
            (c.subject.clone(), key_id(&c.spki).ok_or("the CA key is not an EC key")?)
        }
        None => match &spec.profile {
            Profile::Ca { host } => (ca_name(host), ski.clone()),
            _ => return Err("only the CA is self-signed".into()),
        },
    };
    let bc_ca = der(0x01, &[0xff]);
    let (subject, exts) = match &spec.profile {
        Profile::Ca { host } => (
            ca_name(host),
            vec![
                extension(OID_BC, true, seq(&[bc_ca, der(0x02, &[0])])),
                // keyCertSign (5) and cRLSign (6): 0000 0110, one unused bit
                extension(OID_KU, true, bit_string(&[0x06], 1)),
                extension(OID_SKI, false, der(0x04, &ski)),
            ],
        ),
        Profile::Server { host, names } => {
            let mut dns = vec![host.clone()];
            for n in names {
                if !dns.iter().any(|d| d.eq_ignore_ascii_case(n)) {
                    dns.push(n.clone());
                }
            }
            let san: Vec<Vec<u8>> = dns.iter().map(|d| der(0x82, d.as_bytes())).collect();
            (
                name(&[(OID_CN, host)]),
                vec![
                    extension(OID_BC, true, seq(&[])),
                    extension(OID_KU, true, bit_string(&[0x80], 7)),
                    extension(OID_EKU, false, seq(&[oid(OID_SERVER_AUTH)])),
                    extension(OID_SAN, false, seq(&san)),
                ],
            )
        }
        Profile::Relay { relay_id } => (
            name(&[(OID_CN, relay_id)]),
            vec![
                extension(OID_BC, true, seq(&[])),
                extension(OID_KU, true, bit_string(&[0x80], 7)),
                extension(OID_EKU, false, seq(&[oid(OID_CLIENT_AUTH)])),
                extension(OID_SAN, false, seq(&[der(0x86, format!("{RELAY_URI}{relay_id}").as_bytes())])),
                extension(OID_SKI, false, der(0x04, &ski)),
                extension(OID_AKI, false, seq(&[der(0x80, &issuer_ski)])),
            ],
        ),
    };
    Ok(seq(&[
        der(0xa0, &der(0x02, &[2])),
        integer(spec.serial),
        alg_ecdsa_sha384(),
        issuer_name,
        seq(&[time(spec.not_before_ms), time(spec.not_after_ms)]),
        subject,
        spec.spki.to_vec(),
        der(0xa3, &seq(&exts)),
    ]))
}

/// The Certificate around a TBSCertificate and its ecdsa-with-SHA384 signature.
pub fn certificate(tbs: &[u8], signature: &[u8]) -> Vec<u8> {
    seq(&[tbs.to_vec(), alg_ecdsa_sha384(), bit_string(signature, 0)])
}

/// Write, sign with the CA key and read back: the certificate is used only when `check` accepts what was written.
pub fn issue(spec: &Spec, ca_key: &Key) -> Result<Vec<u8>, String> {
    if ca_key.curve() != Curve::P384 {
        return Err("the management CA key is P-384".into());
    }
    let t = tbs(spec)?;
    let cert = certificate(&t, &ca_key.sign(&t)?);
    let issuer = spec.issuer.map(<[u8]>::to_vec).unwrap_or_else(|| cert.clone());
    check(&cert, &spec.profile, &issuer, spec.not_before_ms)?;
    Ok(cert)
}

// ── Reading usages (invariant 6) ────────────────────────────────────────────────────────────────────────────

/// The extensions this profile depends on, as written in a certificate.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub ca: bool,
    pub path_len: Option<u8>,
    pub bc_critical: bool,
    /// The keyUsage bits' first byte (digitalSignature 0x80, keyCertSign 0x04, cRLSign 0x02).
    pub key_usage: Option<u8>,
    pub ku_critical: bool,
    /// The extendedKeyUsage purposes (OIDs), None without the extension.
    pub eku: Option<Vec<Vec<u8>>>,
}

impl Usage {
    pub fn server_auth_only(&self) -> bool {
        self.eku.as_deref().is_some_and(|e| e.len() == 1 && e[0] == OID_SERVER_AUTH)
    }
    pub fn client_auth_only(&self) -> bool {
        self.eku.as_deref().is_some_and(|e| e.len() == 1 && e[0] == OID_CLIENT_AUTH)
    }
    fn leaf_ok(&self) -> bool {
        !self.ca && self.bc_critical && self.key_usage == Some(0x80) && self.ku_critical
    }
}

fn children(mut d: &[u8]) -> Option<Vec<(u8, &[u8])>> {
    let mut out = Vec::new();
    while !d.is_empty() {
        let t = tlv(d)?;
        out.push((t.tag, t.value));
        d = t.rest;
    }
    Some(out)
}

/// The usage extensions of a certificate DER, or None when it does not read.
pub fn usage(cert_der: &[u8]) -> Option<Usage> {
    let outer = tlv(cert_der)?;
    let tbs = tlv(outer.value)?;
    let mut u = Usage::default();
    for (tag, value) in children(tbs.value)? {
        if tag != 0xa3 {
            continue;
        }
        let exts = tlv(value)?;
        for (_, ext) in children(exts.value)? {
            let fields = children(ext)?;
            let o = fields.first()?.1;
            let critical = fields.len() == 3 && fields[1].0 == 0x01 && fields[1].1.first() == Some(&0xff);
            let v = fields.last()?.1;
            if o == OID_BC {
                let s = tlv(v)?;
                let inner = children(s.value)?;
                u.ca = inner.first().is_some_and(|(t, b)| *t == 0x01 && b.iter().any(|x| *x != 0));
                u.path_len = inner.iter().find(|(t, _)| *t == 0x02).and_then(|(_, b)| b.last().copied());
                u.bc_critical = critical;
            } else if o == OID_KU {
                let b = tlv(v)?;
                u.key_usage = b.value.get(1).copied();
                u.ku_critical = critical;
            } else if o == OID_EKU {
                let s = tlv(v)?;
                u.eku = Some(children(s.value)?.into_iter().map(|(_, x)| x.to_vec()).collect());
            }
        }
    }
    Some(u)
}

/// The relay id a relay leaf names (`CN` and SAN URI agree and the id is `r_` and 16 hex), or None.
pub fn relay_id_of(cert: &Cert) -> Option<String> {
    let cns = cert.names.cns();
    let id = cns.first()?;
    let ok = cns.len() == 1 && is_relay_id(id) && cert.names.uris.len() == 1 && cert.names.uris[0] == format!("{RELAY_URI}{id}");
    ok.then(|| id.clone())
}

pub fn is_relay_id(s: &str) -> bool {
    s.len() == 18 && s.starts_with("r_") && s[2..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Whether a time (ms) is inside a certificate's validity.
pub fn in_date(cert: &Cert, t_ms: i64) -> bool {
    let s = t_ms.div_euclid(1000);
    cert.not_before <= s && s <= cert.not_after
}

/// Check a certificate as written (3.2: "every certificate it writes is read back ... and checked before use"):
/// it reads, its issuer signed it, its profile's extensions are exactly as intended, and it is in date at `at_ms`.
pub fn check(cert_der: &[u8], profile: &Profile, issuer_der: &[u8], at_ms: i64) -> Result<Cert, String> {
    let bad = |why: &str| Err(format!("the written certificate is wrong: {why}"));
    let Some(cert) = Cert::from_der(cert_der) else { return bad("it does not read") };
    let Some(issuer) = Cert::from_der(issuer_der) else { return bad("the issuer does not read") };
    let Some(u) = usage(cert_der) else { return bad("its extensions do not read") };
    if !cert.issued_by(&issuer) {
        return bad("the issuer did not sign it");
    }
    if !in_date(&cert, at_ms) {
        return bad("it is not in date");
    }
    let ok = match profile {
        Profile::Ca { .. } => u.ca && u.path_len == Some(0) && u.bc_critical && u.key_usage == Some(0x06) && u.ku_critical && u.eku.is_none(),
        Profile::Server { host, .. } => u.leaf_ok() && u.server_auth_only() && cert.names.dns.iter().any(|d| d.eq_ignore_ascii_case(host)),
        Profile::Relay { relay_id } => u.leaf_ok() && u.client_auth_only() && relay_id_of(&cert).as_deref() == Some(relay_id.as_str()),
    };
    if ok {
        Ok(cert)
    } else {
        bad("its usages do not match its profile")
    }
}

/// A relay leaf the console accepts as a relay (invariant 6): issued by `ca`, clientAuth only, CA false, in date at
/// `at_ms`. Ok is (relay id, serial hex, the leaf).
pub fn relay_leaf(cert_der: &[u8], ca_der: &[u8], at_ms: i64) -> Result<(String, String, Cert), &'static str> {
    let cert = Cert::from_der(cert_der).ok_or("bad-encoding")?;
    let ca = Cert::from_der(ca_der).ok_or("bad-encoding")?;
    let u = usage(cert_der).ok_or("bad-encoding")?;
    if !cert.issued_by(&ca) {
        return Err("unknown-issuer");
    }
    if !u.leaf_ok() || !u.client_auth_only() {
        return Err("usage");
    }
    if !in_date(&cert, at_ms) {
        return Err("expired");
    }
    let id = relay_id_of(&cert).ok_or("usage")?;
    Ok((id, cert.serial.clone(), cert))
}

/// A server leaf the relay accepts as the console's (invariant 6, before the manifest check): issued by `ca`,
/// serverAuth only, CA false, naming `host` (exact, case-insensitive). Dates are judged by the caller at trusted
/// time. Ok is the leaf.
pub fn server_leaf(cert_der: &[u8], ca_der: &[u8], host: &str) -> Result<Cert, &'static str> {
    let cert = Cert::from_der(cert_der).ok_or("bad-encoding")?;
    let ca = Cert::from_der(ca_der).ok_or("bad-encoding")?;
    let u = usage(cert_der).ok_or("bad-encoding")?;
    if !cert.issued_by(&ca) {
        return Err("unknown-issuer");
    }
    if !u.leaf_ok() || !u.server_auth_only() {
        return Err("usage");
    }
    let host = host.trim_end_matches('.');
    if !cert.names.dns.iter().any(|d| d.eq_ignore_ascii_case(host)) {
        return Err("name");
    }
    Ok(cert)
}

/// The serial of a certificate DER as lowercase hex (meet_x509 `int_hex`), or None.
pub fn serial_hex(cert_der: &[u8]) -> Option<String> {
    Cert::from_der(cert_der).map(|c| c.serial)
}

/// A serial's raw INTEGER content bytes from its hex form (what the lp inputs carry), or None.
pub fn serial_bytes(serial_hex: &str) -> Option<Vec<u8>> {
    let h = if serial_hex.len() % 2 == 1 { format!("0{serial_hex}") } else { serial_hex.to_owned() };
    let raw: Option<Vec<u8>> = (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok()).collect();
    let raw = raw?;
    // the INTEGER content: a leading zero only before a set top bit
    Some(if raw.first().is_some_and(|b| b & 0x80 != 0) { [&[0u8][..], &raw].concat() } else { raw })
}

/// The hex form of raw serial bytes, as `meet_x509` prints serials.
pub fn serial_of_bytes(raw: &[u8]) -> String {
    int_hex(raw)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::codec::parse_json;
    use serde_json::Value;

    fn vector() -> Value {
        let path = format!("{}/tests/admin_console_fleet_x509_v1.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (copy it from the Meeting Hub repository's tests/vectors/)"));
        parse_json(&text).unwrap()
    }

    pub(crate) fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn key(v: &Value, name: &str, curve: Curve) -> Key {
        Key::from_pkcs8(curve, &unhex(v["keys"][name]["pkcs8_hex"].as_str().unwrap())).unwrap()
    }

    fn s(v: &Value) -> &str {
        v.as_str().unwrap()
    }

    /// The vector's three certificates: our TBSCertificate is byte for byte the vector's, both signatures verify,
    /// both read back through meet_x509::Cert and pass the profile check.
    #[test]
    fn certificates_for_fixed_inputs_equal_the_vector() {
        let v = vector();
        let ca_key = key(&v, "ca", Curve::P384);
        let server_key = key(&v, "server", Curve::P256);
        let relay_key = key(&v, "relay", Curve::P256);
        assert_eq!(hex(&ca_key.spki()), s(&v["keys"]["ca"]["spki_hex"]));
        assert_eq!(hex(&server_key.spki()), s(&v["keys"]["server"]["spki_hex"]));
        let c = &v["ca"];
        let host = s(&c["host"]).to_owned();
        let ca_spec = Spec { profile: Profile::Ca { host: host.clone() }, serial: &unhex(s(&c["serial_hex"])), not_before_ms: c["not_before_ms"].as_i64().unwrap(), not_after_ms: c["not_after_ms"].as_i64().unwrap(), spki: &ca_key.spki(), issuer: None };
        assert_eq!(hex(&tbs(&ca_spec).unwrap()), s(&c["tbs_hex"]));
        let ca_der = unhex(s(&c["der_hex"]));
        check(&ca_der, &ca_spec.profile, &ca_der, ca_spec.not_before_ms).unwrap();
        let ours = issue(&ca_spec, &ca_key).unwrap();
        assert!(Cert::from_der(&ours).unwrap().issued_by(&Cert::from_der(&ca_der).unwrap()));
        assert_eq!(pin_hex(&ca_der).unwrap(), s(&c["pin_hex"]));

        let sv = &v["server"];
        let names: Vec<String> = sv["dns"].as_array().unwrap().iter().skip(1).map(|d| s(d).to_owned()).collect();
        let server_spec = Spec { profile: Profile::Server { host: host.clone(), names }, serial: &unhex(s(&sv["serial_hex"])), not_before_ms: sv["not_before_ms"].as_i64().unwrap(), not_after_ms: sv["not_after_ms"].as_i64().unwrap(), spki: &server_key.spki(), issuer: Some(&ca_der) };
        assert_eq!(hex(&tbs(&server_spec).unwrap()), s(&sv["tbs_hex"]));
        let server_der = unhex(s(&sv["der_hex"]));
        check(&server_der, &server_spec.profile, &ca_der, server_spec.not_before_ms).unwrap();
        issue(&server_spec, &ca_key).unwrap();

        let rv = &v["relay"];
        let relay_id = s(&rv["relay_id"]).to_owned();
        let relay_spec = Spec { profile: Profile::Relay { relay_id: relay_id.clone() }, serial: &unhex(s(&rv["serial_hex"])), not_before_ms: rv["not_before_ms"].as_i64().unwrap(), not_after_ms: rv["not_after_ms"].as_i64().unwrap(), spki: &relay_key.spki(), issuer: Some(&ca_der) };
        assert_eq!(hex(&tbs(&relay_spec).unwrap()), s(&rv["tbs_hex"]));
        let relay_der = unhex(s(&rv["der_hex"]));
        let cert = check(&relay_der, &relay_spec.profile, &ca_der, relay_spec.not_before_ms).unwrap();
        assert_eq!(relay_id_of(&cert).unwrap(), relay_id);
        issue(&relay_spec, &ca_key).unwrap();

        // Generation 2, when the vector has it.
        if let Some(c2) = v.get("ca2").filter(|x| x.is_object()) {
            let k2 = key(&v, "ca2", Curve::P384);
            let spec2 = Spec { profile: Profile::Ca { host: s(&c2["host"]).to_owned() }, serial: &unhex(s(&c2["serial_hex"])), not_before_ms: c2["not_before_ms"].as_i64().unwrap(), not_after_ms: c2["not_after_ms"].as_i64().unwrap(), spki: &k2.spki(), issuer: None };
            assert_eq!(hex(&tbs(&spec2).unwrap()), s(&c2["tbs_hex"]));
        }
    }

    /// Invariant 6: a relay leaf presented as a server and a server leaf presented as a client are both refused.
    #[test]
    fn relay_and_server_leaves_cannot_stand_for_each_other() {
        let ca_key = Key::generate(Curve::P384).unwrap();
        let t = 1_800_000_000_000;
        let ca = issue(&Spec { profile: Profile::Ca { host: "console.example.com".into() }, serial: &[1], not_before_ms: t, not_after_ms: t + CA_DAYS * DAY_MS, spki: &ca_key.spki(), issuer: None }, &ca_key).unwrap();
        let leaf_key = Key::generate(Curve::P256).unwrap();
        let server = issue(&Spec { profile: Profile::Server { host: "console.example.com".into(), names: vec!["localhost".into()] }, serial: &[2], not_before_ms: t, not_after_ms: t + LEAF_DAYS * DAY_MS, spki: &leaf_key.spki(), issuer: Some(&ca) }, &ca_key).unwrap();
        let relay = issue(&Spec { profile: Profile::Relay { relay_id: "r_0123456789abcdef".into() }, serial: &[3], not_before_ms: t, not_after_ms: t + LEAF_DAYS * DAY_MS, spki: &leaf_key.spki(), issuer: Some(&ca) }, &ca_key).unwrap();
        assert!(server_leaf(&server, &ca, "console.example.com").is_ok());
        assert!(server_leaf(&server, &ca, "LOCALHOST").is_ok());
        assert_eq!(server_leaf(&server, &ca, "other.example.com").err(), Some("name"));
        assert_eq!(server_leaf(&relay, &ca, "console.example.com").err(), Some("usage"));
        assert!(relay_leaf(&relay, &ca, t + 1000).is_ok());
        assert_eq!(relay_leaf(&server, &ca, t + 1000).err(), Some("usage"));
        assert_eq!(relay_leaf(&ca, &ca, t + 1000).err(), Some("usage"));
        assert_eq!(relay_leaf(&relay, &ca, t + (LEAF_DAYS + 1) * DAY_MS).err(), Some("expired"));
        // Another CA's leaf is not ours.
        let other_key = Key::generate(Curve::P384).unwrap();
        let other = issue(&Spec { profile: Profile::Ca { host: "console.example.com".into() }, serial: &[1], not_before_ms: t, not_after_ms: t + CA_DAYS * DAY_MS, spki: &other_key.spki(), issuer: None }, &other_key).unwrap();
        assert_eq!(relay_leaf(&relay, &other, t + 1000).err(), Some("unknown-issuer"));
        // The relay leaf carries nothing but its id.
        let c = Cert::from_der(&relay).unwrap();
        assert_eq!(c.names.cns(), vec!["r_0123456789abcdef".to_owned()]);
        assert!(c.names.dns.is_empty() && c.names.emails.is_empty());
    }

    #[test]
    fn times_switch_to_generalized_time_in_2050() {
        assert_eq!(time(0), der(0x17, b"700101000000Z"));
        let y2050 = crate::meet_json::days_from_civil(2050, 1, 1) * DAY_MS;
        assert_eq!(time(y2050 - 1000), der(0x17, b"491231235959Z"));
        assert_eq!(time(y2050), der(0x18, b"20500101000000Z"));
        assert_eq!(integer(&[0x80]), vec![0x02, 0x02, 0x00, 0x80]);
        assert_eq!(integer(&[0x00, 0x01]), vec![0x02, 0x01, 0x01]);
        assert_eq!(der(0x04, &[0u8; 200])[..3], [0x04, 0x81, 200]);
        let s = new_serial().unwrap();
        assert!(s[0] & 0xc0 == 0x40 && serial_of_bytes(&s).len() == 32);
        assert_eq!(serial_bytes(&serial_of_bytes(&s)).unwrap(), s.to_vec());
    }

    #[test]
    fn signatures_check_curve_and_hash() {
        let k = Key::generate(Curve::P256).unwrap();
        let ca = Key::generate(Curve::P384).unwrap();
        let sg = k.sign(b"m").unwrap();
        assert!(verify_p256(&k.spki(), b"m", &sg) && !verify_p256(&k.spki(), b"n", &sg));
        assert!(!verify_p384(&k.spki(), b"m", &sg));
        let sc = ca.sign(b"m").unwrap();
        assert!(verify_p384(&ca.spki(), b"m", &sc) && !verify_p256(&ca.spki(), b"m", &sc));
        assert!(is_p256_spki(&k.spki()) && !is_p256_spki(&ca.spki()));
        assert_eq!(format!("{k:?}"), "Key(P256, <redacted>)");
        assert!(same_fingerprint("AB cd", "abcd") && !same_fingerprint("", ""));
        assert_eq!(relay_fingerprint(&k.spki()).len(), 24);
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("fleet_x509.rs");
        assert!(!src.contains('\u{2014}') && !src.contains('\u{2013}'));
    }
}
