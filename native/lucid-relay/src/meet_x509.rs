// Phase C (ADR-0540): the X.509 the Meet relay reads with Python's `cryptography` (meet_relay.py) and `ssl`
// (getpeercert): certificates, certificate requests and CRLs in DER, their names, subject alternative names, key
// identifiers, validity and serials, and their signatures (AWS-LC). Only what the relay's checks depend on.

use crate::der::tlv;
use crate::meet_json::days_from_civil;

const OID_CN: &[u8] = &[0x55, 0x04, 0x03];
const OID_OU: &[u8] = &[0x55, 0x04, 0x0b];
const OID_EMAIL: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x01];
const OID_EXT_REQ: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e];
const OID_SAN: &[u8] = &[0x55, 0x1d, 0x11];
const OID_SKI: &[u8] = &[0x55, 0x1d, 0x0e];
const OID_AKI: &[u8] = &[0x55, 0x1d, 0x23];
const OID_EC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_RSA_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_ED25519: &[u8] = &[0x2b, 0x65, 0x70];
const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_ECDSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
const OID_RSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const OID_RSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c];
const OID_RSA_SHA512: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d];

/// One TLV with its full encoding.
struct Item<'a> {
    tag: u8,
    value: &'a [u8],
    raw: &'a [u8],
}

fn item(d: &[u8]) -> Option<(Item<'_>, &[u8])> {
    let t = tlv(d)?;
    let used = d.len() - t.rest.len();
    Some((Item { tag: t.tag, value: t.value, raw: &d[..used] }, t.rest))
}

/// Every TLV inside a constructed value.
fn items(mut d: &[u8]) -> Option<Vec<Item<'_>>> {
    let mut out = Vec::new();
    while !d.is_empty() {
        let (i, rest) = item(d)?;
        out.push(i);
        d = rest;
    }
    Some(out)
}

/// The names and alternative names a certificate or request carries.
#[derive(Default, Clone, Debug)]
pub struct Names {
    /// (attribute OID, text) in order, every RDN flattened.
    pub subject: Vec<(Vec<u8>, String)>,
    pub emails: Vec<String>,
    pub uris: Vec<String>,
}

impl Names {
    fn attrs(&self, oid: &[u8]) -> Vec<String> {
        self.subject.iter().filter(|(o, _)| o == oid).map(|(_, v)| v.clone()).collect()
    }
    pub fn cns(&self) -> Vec<String> {
        self.attrs(OID_CN)
    }
    pub fn ous(&self) -> Vec<String> {
        self.attrs(OID_OU)
    }
    pub fn subject_emails(&self) -> Vec<String> {
        self.attrs(OID_EMAIL)
    }
}

fn string_value(i: &Item) -> String {
    match i.tag {
        // BMPString: UTF-16BE
        0x1e => {
            let units: Vec<u16> = i.value.chunks(2).map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
            String::from_utf16_lossy(&units)
        }
        // UniversalString: UTF-32BE
        0x1c => i.value.chunks(4).filter_map(|c| (c.len() == 4).then(|| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))).filter_map(char::from_u32).collect(),
        _ => String::from_utf8_lossy(i.value).into_owned(),
    }
}

fn parse_name(value: &[u8], out: &mut Vec<(Vec<u8>, String)>) -> Option<()> {
    for rdn in items(value)? {
        for atv in items(rdn.value)? {
            let parts = items(atv.value)?;
            let (oid, val) = (parts.first()?, parts.get(1)?);
            out.push((oid.value.to_vec(), string_value(val)));
        }
    }
    Some(())
}

fn parse_san(ext_value: &[u8], names: &mut Names) -> Option<()> {
    let (seq, _) = item(ext_value)?;
    for gn in items(seq.value)? {
        let text = String::from_utf8_lossy(gn.value).into_owned();
        match gn.tag {
            0x81 => names.emails.push(text),
            0x86 => names.uris.push(text),
            _ => {}
        }
    }
    Some(())
}

/// A DER time (UTCTime or GeneralizedTime, `Z`) as unix seconds.
fn parse_time(i: &Item) -> Option<i64> {
    let t = std::str::from_utf8(i.value).ok()?;
    let t = t.strip_suffix('Z')?;
    let (year, rest) = match i.tag {
        0x17 => {
            let yy: i64 = t.get(0..2)?.parse().ok()?;
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, t.get(2..)?)
        }
        0x18 => (t.get(0..4)?.parse().ok()?, t.get(4..)?),
        _ => return None,
    };
    let n = |a: usize| -> Option<i64> { rest.get(a..a + 2)?.parse().ok() };
    let (mo, d, h, mi) = (n(0)?, n(2)?, n(4)?, n(6)?);
    let sec = if rest.len() >= 10 { n(8)? } else { 0 };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(year, mo as u32, d as u32) * 86_400 + h * 3600 + mi * 60 + sec)
}

/// A positive INTEGER as Python's format(n, "x").
pub fn int_hex(value: &[u8]) -> String {
    let h = crate::codec::hex(value);
    let t = h.trim_start_matches('0');
    if t.is_empty() { "0".into() } else { t.into() }
}

/// What a signature check needs: the signed bytes, the algorithm and the signature.
#[derive(Clone, Debug)]
pub struct Signed {
    pub tbs: Vec<u8>,
    alg: Vec<u8>,
    sig: Vec<u8>,
}

fn signed(der: &[u8]) -> Option<(Signed, Item<'_>)> {
    let (outer, _) = item(der)?;
    if outer.tag != 0x30 {
        return None;
    }
    let parts = items(outer.value)?;
    let (tbs, alg, sig) = (parts.first()?, parts.get(1)?, parts.get(2)?);
    let alg_oid = items(alg.value)?.first()?.value.to_vec();
    let sig_bytes = sig.value.get(1..)?.to_vec();
    let tbs_item = Item { tag: tbs.tag, value: tbs.value, raw: tbs.raw };
    Some((Signed { tbs: tbs.raw.to_vec(), alg: alg_oid, sig: sig_bytes }, tbs_item))
}

/// A SubjectPublicKeyInfo's algorithm (and curve) and key bytes.
fn spki_parts(spki: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let (seq, _) = item(spki)?;
    let parts = items(seq.value)?;
    let alg = items(parts.first()?.value)?;
    let oid = alg.first()?.value.to_vec();
    let param = alg.get(1).map(|p| p.value.to_vec()).unwrap_or_default();
    let key = parts.get(1)?.value.get(1..)?.to_vec();
    Some((oid, param, key))
}

impl Signed {
    /// True when the key in `spki` (DER) signed these bytes.
    pub fn verified_by(&self, spki: &[u8]) -> bool {
        use aws_lc_rs::signature::{self as sig, UnparsedPublicKey};
        let Some((kind, param, key)) = spki_parts(spki) else { return false };
        let alg: &'static dyn sig::VerificationAlgorithm = if kind == OID_EC_KEY {
            match (param.as_slice(), self.alg.as_slice()) {
                (OID_P256, OID_ECDSA_SHA256) => &sig::ECDSA_P256_SHA256_ASN1,
                (OID_P256, OID_ECDSA_SHA384) => &sig::ECDSA_P256_SHA384_ASN1,
                (OID_P384, OID_ECDSA_SHA256) => &sig::ECDSA_P384_SHA256_ASN1,
                (OID_P384, OID_ECDSA_SHA384) => &sig::ECDSA_P384_SHA384_ASN1,
                _ => return false,
            }
        } else if kind == OID_RSA_KEY {
            match self.alg.as_slice() {
                OID_RSA_SHA256 => &sig::RSA_PKCS1_2048_8192_SHA256,
                OID_RSA_SHA384 => &sig::RSA_PKCS1_2048_8192_SHA384,
                OID_RSA_SHA512 => &sig::RSA_PKCS1_2048_8192_SHA512,
                _ => return false,
            }
        } else if kind == OID_ED25519 && self.alg == OID_ED25519 {
            &sig::ED25519
        } else {
            return false;
        };
        UnparsedPublicKey::new(alg, &key).verify(&self.tbs, &self.sig).is_ok()
    }
}

/// A certificate.
#[derive(Clone, Debug)]
pub struct Cert {
    pub serial: String,
    pub issuer: Vec<u8>,
    pub subject: Vec<u8>,
    pub names: Names,
    pub not_before: i64,
    pub not_after: i64,
    pub spki: Vec<u8>,
    pub ski: Option<Vec<u8>>,
    pub aki: Option<Vec<u8>>,
    pub signed: Signed,
}

impl Cert {
    pub fn from_der(der: &[u8]) -> Option<Cert> {
        let (signed, tbs) = signed(der)?;
        let mut parts = items(tbs.value)?.into_iter().peekable();
        if parts.peek()?.tag == 0xa0 {
            parts.next();
        }
        let serial = parts.next()?;
        let _alg = parts.next()?;
        let issuer = parts.next()?;
        let validity = items(parts.next()?.value)?;
        let subject = parts.next()?;
        let spki = parts.next()?;
        if serial.tag != 0x02 || issuer.tag != 0x30 || subject.tag != 0x30 || spki.tag != 0x30 {
            return None;
        }
        let mut names = Names::default();
        parse_name(subject.value, &mut names.subject)?;
        let (mut ski, mut aki) = (None, None);
        for rest in parts {
            if rest.tag != 0xa3 {
                continue;
            }
            let (exts, _) = item(rest.value)?;
            for ext in items(exts.value)? {
                let fields = items(ext.value)?;
                let oid = fields.first()?.value;
                let value = fields.last()?.value;
                if oid == OID_SAN {
                    parse_san(value, &mut names)?;
                } else if oid == OID_SKI {
                    ski = Some(item(value)?.0.value.to_vec());
                } else if oid == OID_AKI {
                    let (seq, _) = item(value)?;
                    aki = items(seq.value)?.into_iter().find(|i| i.tag == 0x80).map(|i| i.value.to_vec());
                }
            }
        }
        Some(Cert {
            serial: int_hex(serial.value),
            issuer: issuer.raw.to_vec(),
            subject: subject.raw.to_vec(),
            names,
            not_before: parse_time(validity.first()?)?,
            not_after: parse_time(validity.get(1)?)?,
            spki: spki.raw.to_vec(),
            ski,
            aki,
            signed,
        })
    }

    /// The first CERTIFICATE in a PEM text.
    pub fn from_pem(pem: &str) -> Option<Cert> {
        Cert::from_der(&pem_blocks(pem.as_bytes(), "CERTIFICATE").into_iter().next()?.1)
    }

    /// verify_directly_issued_by: the issuer's name and its key's signature.
    pub fn issued_by(&self, issuer: &Cert) -> bool {
        self.issuer == issuer.subject && self.signed.verified_by(&issuer.spki)
    }

    /// meet_pki.issued_directly_by_root: the AuthorityKeyIdentifier is the root's SubjectKeyIdentifier (or,
    /// lacking those, the root's key verifies the signature).
    pub fn issued_directly_by_root(&self, root: &Cert) -> bool {
        if let (Some(aki), Some(ski)) = (&self.aki, &root.ski) {
            return aki == ski && self.issued_by(root);
        }
        self.issued_by(root)
    }
}

/// A certificate request.
#[derive(Clone, Debug)]
pub struct Csr {
    pub names: Names,
    pub spki: Vec<u8>,
    pub signed: Signed,
}

impl Csr {
    pub fn from_der(der: &[u8]) -> Option<Csr> {
        let (signed, info) = signed(der)?;
        let parts = items(info.value)?;
        let subject = parts.get(1)?;
        let spki = parts.get(2)?;
        let mut names = Names::default();
        parse_name(subject.value, &mut names.subject)?;
        if let Some(attrs) = parts.get(3).filter(|a| a.tag == 0xa0) {
            for attr in items(attrs.value)? {
                let fields = items(attr.value)?;
                if fields.first()?.value != OID_EXT_REQ {
                    continue;
                }
                for set in items(fields.get(1)?.value)? {
                    for ext in items(set.value)? {
                        let f = items(ext.value)?;
                        if f.first()?.value == OID_SAN {
                            parse_san(f.last()?.value, &mut names)?;
                        }
                    }
                }
            }
        }
        Some(Csr { names, spki: spki.raw.to_vec(), signed })
    }

    /// The certificate request's own signature verifies.
    pub fn signature_valid(&self) -> bool {
        self.signed.verified_by(&self.spki)
    }
}

/// A certificate revocation list.
#[derive(Clone, Debug)]
pub struct Crl {
    pub issuer: Vec<u8>,
    pub issuer_cn: Option<String>,
    pub issuer_text: String,
    pub this_update: i64,
    pub next_update: Option<i64>,
    pub serials: Vec<String>,
    pub signed: Signed,
}

impl Crl {
    pub fn from_der(der: &[u8]) -> Option<Crl> {
        let (signed, tbs) = signed(der)?;
        let mut parts = items(tbs.value)?.into_iter().peekable();
        if parts.peek()?.tag == 0x02 {
            parts.next();
        }
        let _alg = parts.next()?;
        let issuer = parts.next()?;
        let this_update = parse_time(&parts.next()?)?;
        let mut next_update = None;
        let mut serials = Vec::new();
        for p in parts {
            match p.tag {
                0x17 | 0x18 => next_update = Some(parse_time(&p)?),
                0x30 => {
                    for entry in items(p.value)? {
                        let f = items(entry.value)?;
                        serials.push(int_hex(f.first()?.value));
                    }
                }
                _ => {}
            }
        }
        let mut attrs = Vec::new();
        parse_name(issuer.value, &mut attrs)?;
        let issuer_cn = attrs.iter().find(|(o, _)| o == OID_CN).map(|(_, v)| v.clone());
        let issuer_text = rfc4514(&attrs);
        Some(Crl { issuer: issuer.raw.to_vec(), issuer_cn, issuer_text, this_update, next_update, serials, signed })
    }

    pub fn from_pem(pem: &[u8]) -> Option<Crl> {
        Crl::from_der(&pem_blocks(pem, "X509 CRL").into_iter().next()?.1)
    }

    pub fn signature_valid(&self, spki: &[u8]) -> bool {
        self.signed.verified_by(spki)
    }
}

/// Name.rfc4514_string() for the attributes a CA name carries (reversed order, short names).
fn rfc4514(attrs: &[(Vec<u8>, String)]) -> String {
    attrs
        .iter()
        .rev()
        .map(|(oid, v)| {
            let key = match oid.as_slice() {
                OID_CN => "CN".to_string(),
                OID_OU => "OU".to_string(),
                [0x55, 0x04, 0x0a] => "O".to_string(),
                [0x55, 0x04, 0x06] => "C".to_string(),
                [0x55, 0x04, 0x07] => "L".to_string(),
                [0x55, 0x04, 0x08] => "ST".to_string(),
                _ => "1.2.840.113549.1.9.1".to_string(),
            };
            format!("{key}={v}")
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// `-----BEGIN (KIND)-----\s+(.*?)-----END \1-----` blocks (meet_relay._PEM_RE): (the block re-terminated with a
/// newline, the decoded DER) for every block of `kind`.
pub fn pem_blocks(data: &[u8], kind: &str) -> Vec<(Vec<u8>, Vec<u8>)> {
    let text = String::from_utf8_lossy(data);
    let mut out = Vec::new();
    let mut rest: &str = &text;
    while let Some(i) = rest.find("-----BEGIN ") {
        let after = &rest[i + 11..];
        let Some(j) = after.find("-----") else { break };
        let label = &after[..j];
        if label.is_empty() || !label.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b' ') {
            rest = &rest[i + 11..];
            continue;
        }
        let body_start = &after[j + 5..];
        if !body_start.starts_with(|c: char| c.is_whitespace()) {
            rest = &rest[i + 11..];
            continue;
        }
        let end = format!("-----END {label}-----");
        let Some(k) = body_start.find(&end) else {
            rest = &rest[i + 11..];
            continue;
        };
        let body = &body_start[..k];
        if label == kind {
            let block = format!("-----BEGIN {label}-----{}{end}", body);
            let b64: String = body.chars().filter(|c| !c.is_whitespace()).collect();
            let der = crate::meet_json::b64_strict(&b64).unwrap_or_default();
            out.push((format!("{}\n", block.trim()).into_bytes(), der));
        }
        rest = &body_start[k + end.len()..];
    }
    out
}

/// ssl.DER_cert_to_PEM_cert.
pub fn der_to_pem(der: &[u8]) -> String {
    let b = crate::meet_json::b64(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pem_blocks_find_each_kind() {
        let text = b"x\n-----BEGIN X509 CRL-----\nYWJj\n-----END X509 CRL-----\n-----BEGIN CERTIFICATE-----\nZGVm\n-----END CERTIFICATE-----\n";
        let crls = pem_blocks(text, "X509 CRL");
        assert_eq!(crls.len(), 1);
        assert_eq!(crls[0].1, b"abc");
        assert_eq!(crls[0].0, b"-----BEGIN X509 CRL-----\nYWJj\n-----END X509 CRL-----\n");
        assert_eq!(pem_blocks(text, "CERTIFICATE")[0].1, b"def");
    }

    #[test]
    fn serials_and_pem() {
        assert_eq!(int_hex(&[0x00, 0x1a, 0x2b]), "1a2b");
        assert_eq!(int_hex(&[0x00]), "0");
        assert!(der_to_pem(b"abc").starts_with("-----BEGIN CERTIFICATE-----\nYWJj\n-----END"));
    }
}
