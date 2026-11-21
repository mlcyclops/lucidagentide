// X.509 certificates, CRLs and OCSP responses read with a strict DER parser, rule for rule from the add-on's
// src/x509.ts: for PIV presence provenance (ID-1 4.2), the renewal anchor's `piv_cert` and the leaf's `piv_ocsp`
// (5.5), and the FIDO2 attestation chain. AWS-LC verifies the signatures. Only FIPS-approved algorithms are accepted:
// RSA PKCS#1 v1.5 or PSS with SHA-256, SHA-384 or SHA-512 (RSA of 2048 to 8192 bits), and ECDSA P-256 or P-384 with
// SHA-256 or SHA-384. SHA-1 signatures and SHA-1 OCSP CertIDs are refused.
//
// The parser refuses indefinite lengths, non-minimal lengths, high tag numbers and trailing bytes, so the bytes a
// verifier hashes are exactly the bytes it parsed.

use crate::codec::sha256;
use crate::meet_json::days_from_civil;

// ── DER ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// One DER element: `der` the whole encoding, `body` its contents.
#[derive(Clone, Copy)]
pub struct Der<'a> {
    pub tag: u8,
    pub der: &'a [u8],
    pub body: &'a [u8],
}

/// The element at `pos` and the offset after it, or None when it is malformed or runs past `buf`.
pub fn read_der(buf: &[u8], pos: usize) -> Option<(Der<'_>, usize)> {
    if pos + 2 > buf.len() {
        return None;
    }
    let tag = buf[pos];
    if tag & 0x1f == 0x1f {
        return None; // high tag numbers: never needed here
    }
    let mut len = usize::from(buf[pos + 1]);
    let mut p = pos + 2;
    if len == 0x80 {
        return None; // indefinite
    }
    if len > 0x80 {
        let n = len & 0x7f;
        if n > 4 || p + n > buf.len() || buf[p] == 0 {
            return None;
        }
        len = buf[p..p + n].iter().fold(0usize, |a, b| a * 256 + usize::from(*b));
        if len < 0x80 {
            return None; // DER: the short form when it fits
        }
        p += n;
    }
    let end = p.checked_add(len).filter(|e| *e <= buf.len())?;
    Some((Der { tag, der: &buf[pos..end], body: &buf[p..end] }, end))
}

/// Exactly one element filling `buf`, or None.
pub fn der_one(buf: &[u8]) -> Option<Der<'_>> {
    let (n, end) = read_der(buf, 0)?;
    (end == buf.len()).then_some(n)
}

/// The children of a constructed element, or None when any is malformed.
pub fn der_kids<'a>(n: Option<&Der<'a>>) -> Option<Vec<Der<'a>>> {
    let n = n?;
    if n.tag & 0x20 == 0 {
        return None;
    }
    let mut out = Vec::new();
    let mut p = 0;
    while p < n.body.len() {
        let (k, end) = read_der(n.body, p)?;
        out.push(k);
        p = end;
    }
    Some(out)
}

const MAX_SAFE: u64 = (1 << 53) - 1;

/// A dotted OBJECT IDENTIFIER, or None.
pub fn der_oid(n: Option<&Der>) -> Option<String> {
    let n = n?;
    if n.tag != 0x06 || n.body.is_empty() || n.body.len() > 64 {
        return None;
    }
    let mut arcs: Vec<u64> = Vec::new();
    let (mut v, mut started) = (0u64, false);
    for &b in n.body {
        if !started && b == 0x80 {
            return None; // non-minimal arc
        }
        started = true;
        v = v * 128 + u64::from(b & 0x7f);
        if v > MAX_SAFE / 128 {
            return None;
        }
        if b & 0x80 == 0 {
            arcs.push(v);
            v = 0;
            started = false;
        }
    }
    if started {
        return None;
    }
    let first = arcs.remove(0);
    let head = if first < 40 { [0, first] } else if first < 80 { [1, first - 40] } else { [2, first - 80] };
    Some(head.iter().chain(arcs.iter()).map(u64::to_string).collect::<Vec<_>>().join("."))
}

fn is_time(n: Option<&Der>) -> bool {
    n.is_some_and(|n| n.tag == 0x17 || n.tag == 0x18)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ, no fraction) as epoch seconds, or None.
pub fn der_time(n: Option<&Der>) -> Option<i64> {
    let n = n?;
    let s = n.body;
    let digits = |b: &[u8]| b.iter().all(u8::is_ascii_digit);
    let num = |b: &[u8]| b.iter().fold(0i64, |a, c| a * 10 + i64::from(c - b'0'));
    let (y, rest) = if n.tag == 0x17 && s.len() == 13 && s[12] == b'Z' && digits(&s[..12]) {
        let yy = num(&s[..2]);
        (if yy >= 50 { 1900 + yy } else { 2000 + yy }, &s[2..12])
    } else if n.tag == 0x18 && s.len() == 15 && s[14] == b'Z' && digits(&s[..14]) {
        (num(&s[..4]), &s[4..14])
    } else {
        return None;
    };
    let f: Vec<i64> = (0..5).map(|i| num(&rest[i * 2..i * 2 + 2])).collect();
    let (mo, d, h, mi, se) = (f[0], f[1], f[2], f[3], f[4]);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    if d > i64::from(days_in_month(y, mo as u32)) {
        return None; // 31 February and the like
    }
    Some(days_from_civil(y, mo as u32, d as u32) * 86_400 + h * 3600 + mi * 60 + se)
}

/// A BIT STRING's bits (without the unused-bits byte), or None. `whole`: the unused-bits count must be 0.
fn der_bits<'a>(n: Option<&Der<'a>>, whole: bool) -> Option<&'a [u8]> {
    let n = n?;
    if n.tag != 0x03 || n.body.is_empty() {
        return None;
    }
    let unused = n.body[0];
    if unused > 7 || (whole && unused != 0) || (n.body.len() == 1 && unused != 0) {
        return None;
    }
    Some(&n.body[1..])
}

// ── Object identifiers ───────────────────────────────────────────────────────────────────────────────────────

const OID_KEY_USAGE: &str = "2.5.29.15";
const OID_BASIC_CONSTRAINTS: &str = "2.5.29.19";
const OID_CERT_POLICIES: &str = "2.5.29.32";
const OID_EXT_KEY_USAGE: &str = "2.5.29.37";
const OID_SAN: &str = "2.5.29.17";
const OID_DELTA_CRL: &str = "2.5.29.27";
const OID_ISSUING_DP: &str = "2.5.29.28";
const OID_UPN: &str = "1.3.6.1.4.1.311.20.2.3";
pub const OID_OCSP_SIGNING: &str = "1.3.6.1.5.5.7.3.9";
const OID_OCSP_BASIC: &str = "1.3.6.1.5.5.7.48.1.1";
const OID_FIDO_AAGUID: &str = "1.3.6.1.4.1.45724.1.1.4";
const OID_SHA256: &str = "2.16.840.1.101.3.4.2.1";

/// Extensions a certificate may mark critical that this reader understands (RFC 5280 4.2).
const KNOWN_CRITICAL: [&str; 12] = [
    OID_KEY_USAGE, OID_BASIC_CONSTRAINTS, OID_CERT_POLICIES, OID_EXT_KEY_USAGE, OID_SAN, "2.5.29.14", "2.5.29.35", "2.5.29.30", "2.5.29.36", "2.5.29.54", "2.5.29.31",
    "1.3.6.1.5.5.7.1.1",
];

/// The SHA-2 hash an OID names: 256, 384 or 512.
fn hash_of(oid: &str) -> Option<u16> {
    match oid {
        "2.16.840.1.101.3.4.2.1" => Some(256),
        "2.16.840.1.101.3.4.2.2" => Some(384),
        "2.16.840.1.101.3.4.2.3" => Some(512),
        _ => None,
    }
}

fn rsa_pkcs1_hash(oid: &str) -> Option<u16> {
    match oid {
        "1.2.840.113549.1.1.11" => Some(256),
        "1.2.840.113549.1.1.12" => Some(384),
        "1.2.840.113549.1.1.13" => Some(512),
        _ => None,
    }
}

fn ecdsa_hash(oid: &str) -> Option<u16> {
    match oid {
        "1.2.840.10045.4.3.2" => Some(256),
        "1.2.840.10045.4.3.3" => Some(384),
        "1.2.840.10045.4.3.4" => Some(512),
        _ => None,
    }
}

const OID_RSA_PSS: &str = "1.2.840.113549.1.1.10";
const OID_MGF1: &str = "1.2.840.113549.1.1.8";
const OID_RSA_KEY: &str = "1.2.840.113549.1.1.1";
const OID_EC_KEY: &str = "1.2.840.10045.2.1";
const OID_P256: &str = "1.2.840.10045.3.1.7";
const OID_P384: &str = "1.3.132.0.34";

// ── Certificates ─────────────────────────────────────────────────────────────────────────────────────────────

/// A parsed certificate. Times in epoch seconds. `serial`: the INTEGER content bytes as encoded. `issuer_der`,
/// `subject_der`, `spki_der`: the full DER of those fields. `subject_public_key_bits`: the subjectPublicKey BIT STRING
/// value without its unused-bits byte (what an OCSP issuerKeyHash covers). `key_usage`: the first two bytes of the
/// KeyUsage bits, None without the extension. `ca`: basicConstraints cA, None without the extension. `aaguid`: the
/// FIDO AAGUID extension as a lower-case UUID. `critical_unknown`: a critical extension this reader does not know.
#[derive(Clone, Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct X509Info {
    pub der: Vec<u8>,
    pub tbs: Vec<u8>,
    pub serial: Vec<u8>,
    pub issuer_der: Vec<u8>,
    pub subject_der: Vec<u8>,
    pub spki_der: Vec<u8>,
    pub subject_public_key_bits: Vec<u8>,
    pub not_before: i64,
    pub not_after: i64,
    pub key_usage: Option<u16>,
    pub policy_oids: Vec<String>,
    pub eku: Vec<String>,
    pub san_email: Vec<String>,
    pub san_upn: Vec<String>,
    pub sig_alg_der: Vec<u8>,
    pub sig: Vec<u8>,
    pub ca: Option<bool>,
    pub aaguid: Option<String>,
    pub critical_unknown: bool,
}

pub const CERT_MAX_BYTES: usize = 65_536;

/// The certificate in `der` (exactly one, no trailing bytes), or None when anything is malformed.
pub fn parse_cert(der: &[u8]) -> Option<X509Info> {
    if der.len() > CERT_MAX_BYTES {
        return None;
    }
    let top = der_kids(der_one(der).as_ref())?;
    if top.len() != 3 || top[0].tag != 0x30 || top[1].tag != 0x30 {
        return None;
    }
    let sig = der_bits(top.get(2), true)?;
    let t = der_kids(top.first())?;
    let (mut i, mut version) = (0, 0u8);
    if t.first().is_some_and(|x| x.tag == 0xa0) {
        let v = der_kids(t.first())?;
        if v.len() != 1 || v[0].tag != 0x02 || v[0].body.len() != 1 {
            return None;
        }
        version = v[0].body[0];
        if version > 2 {
            return None;
        }
        i = 1;
    }
    let (serial_n, alg_n, issuer_n, validity_n, subject_n, spki_n) = (t.get(i)?, t.get(i + 1)?, t.get(i + 2)?, t.get(i + 3)?, t.get(i + 4)?, t.get(i + 5)?);
    if serial_n.tag != 0x02 || serial_n.body.is_empty() || serial_n.body.len() > 21 {
        return None;
    }
    if alg_n.tag != 0x30 || alg_n.der != top[1].der {
        return None; // RFC 5280: inner and outer algorithm agree
    }
    if issuer_n.tag != 0x30 || subject_n.tag != 0x30 || spki_n.tag != 0x30 {
        return None;
    }
    let validity = der_kids(Some(validity_n))?;
    if validity_n.tag != 0x30 || validity.len() != 2 || !is_time(validity.first()) || !is_time(validity.get(1)) {
        return None;
    }
    let (not_before, not_after) = (der_time(validity.first())?, der_time(validity.get(1))?);
    let spki = der_kids(Some(spki_n))?;
    if spki.len() != 2 || spki[0].tag != 0x30 {
        return None;
    }
    let key_bits = der_bits(spki.get(1), true)?;
    der_oid(der_kids(top.get(1))?.first())?;
    let mut info = X509Info {
        der: der.to_vec(),
        tbs: top[0].der.to_vec(),
        serial: serial_n.body.to_vec(),
        issuer_der: issuer_n.der.to_vec(),
        subject_der: subject_n.der.to_vec(),
        spki_der: spki_n.der.to_vec(),
        subject_public_key_bits: key_bits.to_vec(),
        not_before,
        not_after,
        key_usage: None,
        policy_oids: Vec::new(),
        eku: Vec::new(),
        san_email: Vec::new(),
        san_upn: Vec::new(),
        sig_alg_der: top[1].der.to_vec(),
        sig: sig.to_vec(),
        ca: None,
        aaguid: None,
        critical_unknown: false,
    };
    let mut j = i + 6;
    if t.get(j).is_some_and(|x| x.tag == 0x81) {
        j += 1; // issuerUniqueID
    }
    if t.get(j).is_some_and(|x| x.tag == 0x82) {
        j += 1; // subjectUniqueID
    }
    if let Some(ext) = t.get(j).filter(|x| x.tag == 0xa3) {
        if version != 2 || !read_extensions(ext, &mut info) {
            return None;
        }
        j += 1;
    }
    (j == t.len()).then_some(info)
}

fn read_extensions(wrapper: &Der, info: &mut X509Info) -> bool {
    let Some(outer) = der_kids(Some(wrapper)) else { return false };
    let list = if outer.len() == 1 && outer[0].tag == 0x30 { der_kids(outer.first()) } else { None };
    let Some(list) = list.filter(|l| !l.is_empty()) else { return false };
    let mut seen: Vec<String> = Vec::new();
    for e in &list {
        let Some(k) = der_kids(Some(e)).filter(|k| e.tag == 0x30 && (2..=3).contains(&k.len())) else { return false };
        let oid = der_oid(k.first());
        let mut critical = false;
        if k.len() == 3 {
            if k[1].tag != 0x01 || k[1].body != [0xff] {
                return false; // DER: FALSE is omitted
            }
            critical = true;
        }
        let value = &k[k.len() - 1];
        let Some(oid) = oid.filter(|o| value.tag == 0x04 && !seen.contains(o)) else { return false };
        seen.push(oid.clone());
        let Some(inner) = der_one(value.body) else { return false };
        match oid.as_str() {
            OID_KEY_USAGE => {
                let Some(bits) = der_bits(Some(&inner), false).filter(|b| (1..=2).contains(&b.len())) else { return false };
                info.key_usage = Some((u16::from(bits[0]) << 8) | u16::from(*bits.get(1).unwrap_or(&0)));
            }
            OID_BASIC_CONSTRAINTS => {
                let Some(b) = der_kids(Some(&inner)).filter(|_| inner.tag == 0x30) else { return false };
                info.ca = Some(b.first().is_some_and(|x| x.tag == 0x01 && x.body.first() == Some(&0xff)));
            }
            OID_CERT_POLICIES => {
                let Some(pols) = der_kids(Some(&inner)).filter(|_| inner.tag == 0x30) else { return false };
                for p in &pols {
                    let Some(pid) = der_oid(der_kids(Some(p)).as_ref().and_then(|x| x.first())).filter(|_| p.tag == 0x30) else { return false };
                    info.policy_oids.push(pid);
                }
            }
            OID_EXT_KEY_USAGE => {
                let Some(ks) = der_kids(Some(&inner)).filter(|_| inner.tag == 0x30) else { return false };
                for x in &ks {
                    let Some(o) = der_oid(Some(x)) else { return false };
                    info.eku.push(o);
                }
            }
            OID_SAN => {
                let Some(names) = der_kids(Some(&inner)).filter(|_| inner.tag == 0x30) else { return false };
                for n in &names {
                    if n.tag == 0x81 {
                        if n.body.is_empty() || !n.body.iter().all(|c| (0x21..=0x7e).contains(c)) {
                            return false;
                        }
                        info.san_email.push(n.body.iter().map(|c| char::from(*c)).collect());
                    } else if n.tag == 0xa0 {
                        let Some(on) = der_kids(Some(n)).filter(|on| on.len() == 2 && on[1].tag == 0xa0) else { return false };
                        if der_oid(on.first()).as_deref() == Some(OID_UPN) {
                            let Some(v) = der_kids(on.get(1)).filter(|v| v.len() == 1 && v[0].tag == 0x0c) else { return false };
                            let Ok(s) = std::str::from_utf8(v[0].body) else { return false };
                            info.san_upn.push(s.to_owned());
                        }
                    }
                }
            }
            OID_FIDO_AAGUID => {
                if inner.tag != 0x04 || inner.body.len() != 16 {
                    return false;
                }
                info.aaguid = Some(uuid_of(inner.body));
            }
            o if critical && !KNOWN_CRITICAL.contains(&o) => info.critical_unknown = true,
            _ => {}
        }
    }
    true
}

/// 16 bytes as a lower-case UUID string.
pub fn uuid_of(b: &[u8]) -> String {
    let h = crate::codec::hex(b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// The certificate's KeyUsage includes digitalSignature.
pub fn has_digital_signature(c: &X509Info) -> bool {
    c.key_usage.is_some_and(|k| k & 0x8000 != 0)
}

/// `at` (epoch seconds) is within the certificate's notBefore and notAfter.
pub fn valid_at(c: &X509Info, at: i64) -> bool {
    c.not_before <= at && at <= c.not_after
}

/// True when `issuer`'s subject is `child`'s issuer name and `issuer`'s key verifies `child`'s signature.
pub fn cert_signed_by(child: &X509Info, issuer: &X509Info) -> bool {
    child.issuer_der == issuer.subject_der && verify_signed(&issuer.spki_der, &child.sig_alg_der, &child.tbs, &child.sig)
}

// ── Keys and signatures ──────────────────────────────────────────────────────────────────────────────────────

/// A public key from a SubjectPublicKeyInfo: RSA (its RSAPublicKey DER and modulus bits) or EC (its curve OID and
/// point).
enum Key {
    Rsa { der: Vec<u8>, bits: usize },
    Ec { curve: String, point: Vec<u8> },
}

/// The modulus length of an RSAPublicKey, in bits.
fn rsa_bits(rsa: &[u8]) -> Option<usize> {
    let seq = der_one(rsa).filter(|s| s.tag == 0x30)?;
    let k = der_kids(Some(&seq)).filter(|k| k.len() == 2 && k[0].tag == 0x02 && k[1].tag == 0x02)?;
    let mut m = k[0].body;
    while let [0, rest @ ..] = m {
        m = rest;
    }
    let b = *m.first()?;
    Some((m.len() - 1) * 8 + (8 - b.leading_zeros() as usize))
}

/// The key in a SubjectPublicKeyInfo (exactly one element), or None for anything but RSA and EC.
fn spki_key(spki_der: &[u8]) -> Option<Key> {
    let seq = der_one(spki_der).filter(|s| s.tag == 0x30)?;
    let parts = der_kids(Some(&seq)).filter(|p| p.len() == 2 && p[0].tag == 0x30)?;
    let alg = der_kids(parts.first())?;
    let bits = der_bits(parts.get(1), true)?;
    match der_oid(alg.first())?.as_str() {
        OID_RSA_KEY => {
            if alg.len() > 2 || (alg.len() == 2 && (alg[1].tag != 0x05 || !alg[1].body.is_empty())) {
                return None;
            }
            Some(Key::Rsa { der: bits.to_vec(), bits: rsa_bits(bits)? })
        }
        OID_EC_KEY if alg.len() == 2 => Some(Key::Ec { curve: der_oid(alg.get(1))?, point: bits.to_vec() }),
        _ => None,
    }
}

/// A public key FIPS-approved for verifying certificates and responses: RSA of 2048 to 8192 bits, or EC P-256 or
/// P-384.
fn signer_key(spki_der: &[u8]) -> Option<Key> {
    match spki_key(spki_der)? {
        Key::Rsa { bits, der } if (2048..=8192).contains(&bits) => Some(Key::Rsa { bits, der }),
        Key::Ec { curve, point } if curve == OID_P256 || curve == OID_P384 => Some(Key::Ec { curve, point }),
        _ => None,
    }
}

/// An AlgorithmIdentifier whose parameters are absent or NULL: its OID, or None.
fn plain_alg(n: Option<&Der>) -> Option<String> {
    let n = n?;
    let k = der_kids(Some(n)).filter(|k| n.tag == 0x30 && (1..=2).contains(&k.len()))?;
    if k.len() == 2 && (k[1].tag != 0x05 || !k[1].body.is_empty()) {
        return None;
    }
    der_oid(k.first())
}

/// RSASSA-PSS-params with SHA-2 for both the hash and MGF1 (the SHA-1 defaults are refused), trailer 1: the hash and
/// the salt length.
fn pss_params(n: Option<&Der>) -> Option<(u16, usize)> {
    let n = n?;
    let k = der_kids(Some(n)).filter(|_| n.tag == 0x30)?;
    let (mut hash, mut mgf_hash, mut salt) = (None, None, 20usize);
    for f in &k {
        let kids = der_kids(Some(f));
        let inner = kids.as_ref().and_then(|x| x.first());
        match f.tag {
            0xa0 => hash = plain_alg(inner).as_deref().and_then(hash_of),
            0xa1 => {
                let inner = inner?;
                let m = der_kids(Some(inner)).filter(|m| inner.tag == 0x30 && m.len() == 2)?;
                if der_oid(m.first()).as_deref() != Some(OID_MGF1) {
                    return None;
                }
                mgf_hash = plain_alg(m.get(1)).as_deref().and_then(hash_of);
            }
            0xa2 => {
                let inner = inner.filter(|i| i.tag == 0x02 && i.body.len() <= 2)?;
                salt = inner.body.iter().fold(0usize, |a, b| a * 256 + usize::from(*b));
            }
            0xa3 => {
                inner.filter(|i| i.tag == 0x02 && i.body == [1])?;
            }
            _ => return None,
        }
    }
    match (hash, mgf_hash) {
        (Some(h), Some(m)) if h == m => Some((h, salt)),
        _ => None,
    }
}

/// `sig` over `data` by the key in `spki_der` under the AlgorithmIdentifier `alg_der` (FIPS-approved only). RSA-PSS
/// is verified with the salt as long as the hash (AWS-LC's rule); a response with another salt length fails closed.
pub fn verify_signed(spki_der: &[u8], alg_der: &[u8], data: &[u8], sig: &[u8]) -> bool {
    use aws_lc_rs::signature::{self as s, UnparsedPublicKey, VerificationAlgorithm};
    let (Some(key), Some(alg)) = (signer_key(spki_der), der_one(alg_der)) else { return false };
    let Some(parts) = der_kids(Some(&alg)) else { return false };
    let Some(oid) = der_oid(parts.first()) else { return false };
    let check = |a: &'static dyn VerificationAlgorithm, k: &[u8]| UnparsedPublicKey::new(a, k).verify(data, sig).is_ok();
    if let Some(h) = rsa_pkcs1_hash(&oid) {
        let Key::Rsa { der, .. } = &key else { return false };
        if plain_alg(Some(&alg)).as_deref() != Some(oid.as_str()) {
            return false;
        }
        let a: &'static dyn VerificationAlgorithm = match h {
            256 => &s::RSA_PKCS1_2048_8192_SHA256,
            384 => &s::RSA_PKCS1_2048_8192_SHA384,
            _ => &s::RSA_PKCS1_2048_8192_SHA512,
        };
        return check(a, der.as_slice());
    }
    if let Some(h) = ecdsa_hash(&oid) {
        let Key::Ec { curve, point } = &key else { return false };
        if parts.len() != 1 {
            return false;
        }
        let a: &'static dyn VerificationAlgorithm = match (curve.as_str(), h) {
            (OID_P256, 256) => &s::ECDSA_P256_SHA256_ASN1,
            (OID_P256, 384) => &s::ECDSA_P256_SHA384_ASN1,
            (OID_P384, 256) => &s::ECDSA_P384_SHA256_ASN1,
            (OID_P384, 384) => &s::ECDSA_P384_SHA384_ASN1,
            _ => return false,
        };
        return check(a, point.as_slice());
    }
    if oid == OID_RSA_PSS {
        let Key::Rsa { der, .. } = &key else { return false };
        let Some((h, salt)) = pss_params(parts.get(1)) else { return false };
        let a: &'static dyn VerificationAlgorithm = match (h, salt) {
            (256, 32) => &s::RSA_PSS_2048_8192_SHA256,
            (384, 48) => &s::RSA_PSS_2048_8192_SHA384,
            (512, 64) => &s::RSA_PSS_2048_8192_SHA512,
            _ => return false,
        };
        return check(a, der.as_slice());
    }
    false
}

/// Why a key cannot be a PIV presence key (ID-1 4.2): `size` for RSA outside 2048 to 4096 bits, `type` for any other
/// key than RSA or EC P-256; None when it can.
pub fn piv_key_problem(spki_der: &[u8]) -> Option<&'static str> {
    match spki_key(spki_der) {
        Some(Key::Rsa { bits, .. }) => (!(2048..=4096).contains(&bits)).then_some("size"),
        Some(Key::Ec { curve, point }) if curve == OID_P256 && crate::der::P256Key::from_sec1(&point).is_some() => None,
        _ => Some("type"),
    }
}

// ── Revocation status: OCSP (RFC 6960) and CRLs (RFC 5280) ────────────────────────────────────────────────────

/// A good status: the response's times (`thisUpdate` is checked before a status is good, then not needed).
#[derive(Clone, Copy, Debug)]
pub struct StatusOk {
    pub produced_at: i64,
    pub next_update: Option<i64>,
}

/// Why a status is not good: `certid` (a response for another certificate, issuer or a non-SHA-256 CertID), `status`
/// (revoked or unknown), `stale`, `responder` (a signer the issuer did not authorize), `signature`, `malformed`.
pub type StatusResult = Result<StatusOk, &'static str>;

pub const OCSP_MAX_BYTES: usize = 6_144;
pub const CRL_MAX_BYTES: usize = 64 * 1024 * 1024;
const DAY: i64 = 86_400;

/// A DER OCSP response for `cert` issued by `issuer`, judged at `at` (epoch seconds): successful, a basic response
/// with exactly one SingleResponse whose SHA-256 CertID names `cert` exactly, signed by `issuer` or by a responder
/// certificate `issuer` signed with id-kp-OCSPSigning and valid at producedAt, producedAt and thisUpdate at most 24
/// hours before `at` and not after `at + skew_sec`, nextUpdate (when present) after `at`, status good, at most
/// OCSP_MAX_BYTES and no trailing bytes.
pub fn verify_ocsp(der: &[u8], cert: &X509Info, issuer: &X509Info, at: i64, skew_sec: i64) -> StatusResult {
    const BAD: StatusResult = Err("malformed");
    if der.len() > OCSP_MAX_BYTES {
        return BAD;
    }
    let Some(top) = der_kids(der_one(der).as_ref()) else { return BAD };
    if top.len() != 2 || top[0].tag != 0x0a || top[0].body != [0] || top[1].tag != 0xa0 {
        return BAD;
    }
    let Some(rb) = der_kids(der_kids(top.get(1)).as_ref().and_then(|x| x.first())) else { return BAD };
    if rb.len() != 2 || der_oid(rb.first()).as_deref() != Some(OID_OCSP_BASIC) || rb[1].tag != 0x04 {
        return BAD;
    }
    let Some(basic) = der_kids(der_one(rb[1].body).as_ref()) else { return BAD };
    if !(3..=4).contains(&basic.len()) || basic[0].tag != 0x30 || basic[1].tag != 0x30 {
        return BAD;
    }
    let Some(sig) = der_bits(basic.get(2), true) else { return BAD };
    let mut extra: Vec<X509Info> = Vec::new();
    if basic.len() == 4 {
        let list = if basic[3].tag == 0xa0 { der_kids(der_kids(basic.get(3)).as_ref().and_then(|x| x.first())) } else { None };
        let Some(list) = list.filter(|l| l.len() <= 4) else { return BAD };
        for c in &list {
            let Some(p) = parse_cert(c.der) else { return BAD };
            extra.push(p);
        }
    }
    let Some(rd) = der_kids(basic.first()) else { return BAD };
    let mut i = usize::from(rd.first().is_some_and(|x| x.tag == 0xa0));
    let (responder_id, produced_n, responses_n) = (rd.get(i), rd.get(i + 1), rd.get(i + 2));
    i += 3;
    if !responder_id.is_some_and(|r| r.tag == 0xa1 || r.tag == 0xa2) || !produced_n.is_some_and(|p| p.tag == 0x18) {
        return BAD;
    }
    if rd.get(i).is_some_and(|x| x.tag == 0xa1) {
        i += 1;
    }
    if i != rd.len() {
        return BAD;
    }
    let produced_at = der_time(produced_n);
    let responses = der_kids(responses_n);
    let (Some(produced_at), Some(responses)) = (produced_at, responses) else { return BAD };
    if responses_n.is_none_or(|r| r.tag != 0x30) || responses.len() != 1 {
        return BAD;
    }
    let Some(sr) = der_kids(responses.first()).filter(|s| s.len() >= 3) else { return BAD };
    let (cert_id_n, status_n, this_n) = (&sr[0], &sr[1], &sr[2]);
    let (mut k, mut next_update) = (3, None);
    if sr.get(k).is_some_and(|x| x.tag == 0xa0) {
        let nu = der_kids(sr.get(k));
        let t = nu.as_ref().filter(|nu| nu.len() == 1 && nu[0].tag == 0x18).and_then(|nu| der_time(nu.first()));
        let Some(t) = t else { return BAD };
        next_update = Some(t);
        k += 1;
    }
    if sr.get(k).is_some_and(|x| x.tag == 0xa1) {
        k += 1;
    }
    let this_update = if this_n.tag == 0x18 { der_time(Some(this_n)) } else { None };
    let Some(this_update) = this_update.filter(|_| k == sr.len()) else { return BAD };
    // CertID: SHA-256 only, bound to this certificate's issuer name, issuer key and serial exactly.
    let Some(cid) = der_kids(Some(cert_id_n)) else { return BAD };
    if cert_id_n.tag != 0x30 || cid.len() != 4 || cid[1].tag != 0x04 || cid[2].tag != 0x04 || cid[3].tag != 0x02 {
        return BAD;
    }
    if plain_alg(cid.first()).as_deref() != Some(OID_SHA256) {
        return Err("certid");
    }
    if cid[1].body != sha256(&cert.issuer_der) || cid[2].body != sha256(&issuer.subject_public_key_bits) || cid[3].body != cert.serial.as_slice() {
        return Err("certid");
    }
    if cert.issuer_der != issuer.subject_der {
        return Err("certid");
    }
    // The signer: the issuer itself, or a responder certificate it issued for OCSP signing, current at producedAt.
    let (tbs, alg) = (basic[0].der, basic[1].der);
    let mut signed_by: Option<&str> = verify_signed(&issuer.spki_der, alg, tbs, sig).then_some("issuer");
    for r in &extra {
        if matches!(signed_by, Some("issuer" | "responder")) {
            break;
        }
        if !verify_signed(&r.spki_der, alg, tbs, sig) {
            continue;
        }
        let authorized = cert_signed_by(r, issuer) && r.eku.iter().any(|e| e == OID_OCSP_SIGNING) && valid_at(r, produced_at) && !r.critical_unknown;
        signed_by = Some(if authorized { "responder" } else { "unauthorized" });
    }
    match signed_by {
        None => return Err("signature"),
        Some("unauthorized") => return Err("responder"),
        _ => {}
    }
    if produced_at < at - DAY || produced_at > at + skew_sec || this_update < at - DAY || this_update > at + skew_sec {
        return Err("stale");
    }
    if next_update.is_some_and(|n| n <= at) {
        return Err("stale");
    }
    if status_n.tag != 0x80 || !status_n.body.is_empty() {
        return Err("status"); // [1] revoked, [2] unknown
    }
    Ok(StatusOk { produced_at, next_update })
}

/// A DER CRL for `cert` from `issuer`, judged at `at`: a complete CRL (no delta or partitioned list) with `cert`'s
/// issuer name, signed by `issuer`, thisUpdate at most 24 hours before `at` and not after `at + skew_sec`, nextUpdate
/// present and after `at`, and `cert`'s serial not listed. `produced_at` in the result is the thisUpdate. The root
/// reads it (PIV provenance); the relay runs it only on the shared vectors.
#[cfg_attr(not(test), allow(dead_code))]
pub fn verify_crl(der: &[u8], cert: &X509Info, issuer: &X509Info, at: i64, skew_sec: i64) -> StatusResult {
    const BAD: StatusResult = Err("malformed");
    if der.len() > CRL_MAX_BYTES {
        return BAD;
    }
    let Some(top) = der_kids(der_one(der).as_ref()) else { return BAD };
    if top.len() != 3 || top[0].tag != 0x30 || top[1].tag != 0x30 {
        return BAD;
    }
    let (Some(sig), Some(t)) = (der_bits(top.get(2), true), der_kids(top.first())) else { return BAD };
    let mut i = usize::from(t.first().is_some_and(|x| x.tag == 0x02));
    let (alg_n, issuer_n, this_n) = (t.get(i), t.get(i + 1), t.get(i + 2));
    i += 3;
    let (Some(alg_n), Some(issuer_n)) = (alg_n, issuer_n) else { return BAD };
    if alg_n.tag != 0x30 || alg_n.der != top[1].der || issuer_n.tag != 0x30 || !is_time(this_n) {
        return BAD;
    }
    let this_update = der_time(this_n);
    let mut next_update = None;
    if is_time(t.get(i)) {
        let Some(n) = der_time(t.get(i)) else { return BAD };
        next_update = Some(n);
        i += 1;
    }
    let mut revoked = None;
    if t.get(i).is_some_and(|x| x.tag == 0x30) {
        revoked = t.get(i);
        i += 1;
    }
    if t.get(i).is_some_and(|x| x.tag == 0xa0) {
        let Some(exts) = der_kids(der_kids(t.get(i)).as_ref().and_then(|x| x.first())) else { return BAD };
        for e in &exts {
            let Some(oid) = der_oid(der_kids(Some(e)).as_ref().and_then(|x| x.first())) else { return BAD };
            if oid == OID_DELTA_CRL || oid == OID_ISSUING_DP {
                return BAD; // a partial list proves nothing
            }
        }
        i += 1;
    }
    let Some(this_update) = this_update.filter(|_| i == t.len()) else { return BAD };
    if issuer_n.der != cert.issuer_der.as_slice() || cert.issuer_der != issuer.subject_der {
        return Err("certid");
    }
    if !verify_signed(&issuer.spki_der, top[1].der, top[0].der, sig) {
        return Err("signature");
    }
    if this_update < at - DAY || this_update > at + skew_sec || next_update.is_none_or(|n| n <= at) {
        return Err("stale");
    }
    if let Some(revoked) = revoked {
        // Walked entry by entry, so a large CRL is never expanded into one array.
        let mut p = 0;
        while p < revoked.body.len() {
            let Some((r, end)) = read_der(revoked.body, p).filter(|(r, _)| r.tag == 0x30) else { return BAD };
            let Some((serial, _)) = read_der(r.body, 0).filter(|(s, _)| s.tag == 0x02) else { return BAD };
            if serial.body == cert.serial.as_slice() {
                return Err("status");
            }
            p = end;
        }
    }
    Ok(StatusOk { produced_at: this_update, next_update })
}

/// `der` looks like an OCSP response (a SEQUENCE starting with an ENUMERATED status) rather than a CRL.
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_ocsp_response(der: &[u8]) -> bool {
    read_der(der, 0).is_some_and(|(n, _)| n.tag == 0x30 && n.body.first() == Some(&0x0a))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn der_lengths_are_strict() {
        // Short form that fits, long form for 0x80 and more.
        assert!(der_one(&[0x04, 0x01, 0xaa]).is_some());
        assert!(der_one(&[0x04, 0x81, 0x01, 0xaa]).is_none(), "non-minimal length");
        assert!(der_one(&[0x04, 0x80, 0x00, 0x00]).is_none(), "indefinite length");
        assert!(der_one(&[0x1f, 0x01, 0x00]).is_none(), "high tag number");
        assert!(der_one(&[0x04, 0x01, 0xaa, 0x00]).is_none(), "trailing byte");
        assert!(der_one(&[0x04, 0x02, 0xaa]).is_none(), "runs past the end");
    }

    #[test]
    fn oids_and_times_read_as_typescript_reads_them() {
        let oid = |b: &[u8]| der_oid(der_one(b).as_ref());
        assert_eq!(oid(&[0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]).as_deref(), Some(OID_SHA256));
        assert_eq!(oid(&[0x06, 0x02, 0x80, 0x01]), None, "non-minimal arc");
        let time = |tag: u8, s: &str| {
            let mut b = vec![tag, s.len() as u8];
            b.extend_from_slice(s.as_bytes());
            der_time(der_one(&b).as_ref())
        };
        assert_eq!(time(0x17, "700101000000Z"), Some(0));
        assert_eq!(time(0x18, "20260229000000Z"), None, "29 February 2026 does not exist");
        assert_eq!(time(0x18, "20280229000000Z"), Some(days_from_civil(2028, 2, 29) * 86_400));
        assert_eq!(time(0x17, "700101000000+0000"), None);
    }
}
