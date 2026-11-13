// Just enough DER to read what the relay reads: a SubjectPublicKeyInfo (a P-256 node key, the Ed25519 license keys,
// a presence key that may be RSA) and the names on the relay's own TLS certificate. Node reads these with OpenSSL;
// the rules kept here are the ones its answers depend on (src/identity.ts importPublicSpki, src/presence.ts
// presencePublicKey, X509Certificate.checkHost and checkIP).

use aws_lc_rs::encoding::AsDer;
use aws_lc_rs::signature::{ParsedPublicKey, ECDSA_P256_SHA256_ASN1, ED25519};
use std::net::IpAddr;

/// A P-256 public key, read and checked on the curve by AWS-LC (its FIPS module with the `fips` feature), with its
/// uncompressed SEC1 point for the SPKI and node id.
#[derive(Clone, Debug)]
pub struct P256Key {
    key: ParsedPublicKey,
    point: [u8; 65],
}

impl P256Key {
    /// From a SEC1 point (uncompressed or compressed), or None when it is not a point on P-256.
    pub fn from_sec1(sec1: &[u8]) -> Option<P256Key> {
        let key = ParsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, sec1).ok()?;
        let point: [u8; 65] = if sec1.len() == 65 && sec1[0] == 4 {
            sec1.try_into().ok()?
        } else {
            // AWS-LC writes the SPKI with the uncompressed point: its last 65 bytes.
            let der = key.as_der().ok()?;
            let d: &[u8] = der.as_ref();
            d.get(d.len().checked_sub(65)?..)?.try_into().ok()?
        };
        (point[0] == 4).then_some(P256Key { key, point })
    }

    /// The uncompressed SEC1 point (0x04, x, y).
    pub fn point(&self) -> &[u8; 65] {
        &self.point
    }
}

#[cfg(test)]
impl From<&p256::ecdsa::VerifyingKey> for P256Key {
    fn from(k: &p256::ecdsa::VerifyingKey) -> P256Key {
        use p256::elliptic_curve::sec1::ToEncodedPoint;
        P256Key::from_sec1(k.as_affine().to_encoded_point(false).as_bytes()).expect("a P-256 point")
    }
}

/// An Ed25519 public key, read by AWS-LC.
#[derive(Clone, Debug)]
pub struct Ed25519Key(ParsedPublicKey);

impl Ed25519Key {
    /// From its 32 raw bytes, or None.
    pub fn from_raw(raw: &[u8; 32]) -> Option<Ed25519Key> {
        ParsedPublicKey::new(&ED25519, raw).ok().map(Ed25519Key)
    }
}

pub struct Tlv<'a> {
    pub tag: u8,
    pub value: &'a [u8],
    pub rest: &'a [u8],
}

/// One tag, length and value (single-byte tags, definite lengths).
pub fn tlv(d: &[u8]) -> Option<Tlv<'_>> {
    let (&tag, d) = d.split_first()?;
    let (&l0, mut d) = d.split_first()?;
    let len = if l0 < 0x80 {
        l0 as usize
    } else {
        let n = (l0 & 0x7f) as usize;
        if n == 0 || n > 4 || d.len() < n {
            return None;
        }
        let mut l = 0usize;
        for &b in &d[..n] {
            l = (l << 8) | b as usize;
        }
        d = &d[n..];
        l
    };
    if d.len() < len {
        return None;
    }
    Some(Tlv { tag, value: &d[..len], rest: &d[len..] })
}

const OID_EC: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_ED25519: &[u8] = &[0x2b, 0x65, 0x70];
const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

pub enum PublicKey {
    P256(P256Key),
    Ed25519(Ed25519Key),
    /// RSA (rsaEncryption): only its modulus length matters here (a Windows Hello presence key).
    Rsa { bits: usize },
}

/// A SubjectPublicKeyInfo. Bytes after it are ignored, as OpenSSL's d2i_PUBKEY ignores them.
pub fn parse_spki(der: &[u8]) -> Option<PublicKey> {
    let outer = tlv(der)?;
    if outer.tag != 0x30 {
        return None;
    }
    let alg = tlv(outer.value)?;
    if alg.tag != 0x30 {
        return None;
    }
    let bits = tlv(alg.rest)?;
    if bits.tag != 0x03 || bits.value.first() != Some(&0) {
        return None;
    }
    let key = &bits.value[1..];
    let oid = tlv(alg.value)?;
    if oid.tag != 0x06 {
        return None;
    }
    match oid.value {
        v if v == OID_EC => {
            let params = tlv(oid.rest)?;
            if params.tag != 0x06 || params.value != OID_P256 {
                return None;
            }
            P256Key::from_sec1(key).map(PublicKey::P256)
        }
        v if v == OID_ED25519 => {
            if !oid.rest.is_empty() {
                return None;
            }
            let k: [u8; 32] = key.try_into().ok()?;
            Ed25519Key::from_raw(&k).map(PublicKey::Ed25519)
        }
        v if v == OID_RSA => {
            if !oid.rest.is_empty() && oid.rest != &[0x05u8, 0x00][..] {
                return None;
            }
            let seq = tlv(key)?;
            if seq.tag != 0x30 {
                return None;
            }
            let n = tlv(seq.value)?;
            let e = tlv(n.rest)?;
            if n.tag != 0x02 || e.tag != 0x02 {
                return None;
            }
            let m: &[u8] = {
                let mut m = n.value;
                while let [0, rest @ ..] = m {
                    m = rest;
                }
                m
            };
            let bits = match m.first() {
                Some(&b) => (m.len() - 1) * 8 + (8 - b.leading_zeros() as usize),
                None => 0,
            };
            Some(PublicKey::Rsa { bits })
        }
        _ => None,
    }
}

/// A P-256 key from its SubjectPublicKeyInfo DER, or None (identity.ts importPublicSpki after the decode).
pub fn p256_from_spki(der: &[u8]) -> Option<P256Key> {
    if der.is_empty() {
        return None;
    }
    match parse_spki(der)? {
        PublicKey::P256(k) => Some(k),
        _ => None,
    }
}

/// The SubjectPublicKeyInfo DER Node exports for a P-256 key (uncompressed point).
pub fn p256_spki_der(k: &P256Key) -> Vec<u8> {
    let mut out = Vec::with_capacity(91);
    out.extend_from_slice(&[0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]);
    out.extend_from_slice(k.point());
    out
}

/// ECDSA P-256 / SHA-256 over `msg` with a DER signature (Node's verify("sha256", ...) for an EC key), on AWS-LC.
pub fn ecdsa_verify(key: &P256Key, msg: &[u8], sig_der: &[u8]) -> bool {
    key.key.verify_sig(msg, sig_der).is_ok()
}

/// Ed25519 over `msg` (Node's verify(null, ...) for an Ed25519 key), on AWS-LC; the signature must be 64 bytes.
pub fn ed25519_verify(key: &Ed25519Key, msg: &[u8], sig: &[u8]) -> bool {
    sig.len() == 64 && key.0.verify_sig(msg, sig).is_ok()
}

/// The blocks of one PEM type in a text, decoded.
pub fn pem_blocks(text: &str, label: &str) -> Vec<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(&begin) {
        let after = &rest[i + begin.len()..];
        let Some(j) = after.find(&end) else { break };
        let body: String = after[..j].chars().filter(|c| !c.is_whitespace()).collect();
        out.push(crate::codec::b64_decode_lenient(&body));
        rest = &after[j + end.len()..];
    }
    out
}

/// The names a TLS certificate answers for: its DNS and IP subject alternative names and its subject common names.
pub struct CertNames {
    dns: Vec<String>,
    ips: Vec<Vec<u8>>,
    cns: Vec<String>,
}

impl CertNames {
    /// The first certificate of a PEM chain, as Node's X509Certificate reads it.
    pub fn from_pem(pem: &str) -> Option<CertNames> {
        let der = pem_blocks(pem, "CERTIFICATE").into_iter().next()?;
        Self::from_der(&der)
    }

    pub fn from_der(der: &[u8]) -> Option<CertNames> {
        let cert = tlv(der)?;
        let tbs = tlv(cert.value)?;
        if cert.tag != 0x30 || tbs.tag != 0x30 {
            return None;
        }
        let mut items = Vec::new();
        let mut d = tbs.value;
        while !d.is_empty() {
            let t = tlv(d)?;
            d = t.rest;
            items.push(t);
        }
        // [0] version (optional), serial, signature, issuer, validity, subject, spki, then [1] [2] [3].
        let base = usize::from(items.first()?.tag == 0xa0);
        let subject = items.get(base + 4)?;
        let mut names = CertNames { dns: Vec::new(), ips: Vec::new(), cns: Vec::new() };
        let mut rdns = subject.value;
        while !rdns.is_empty() {
            let set = tlv(rdns)?;
            rdns = set.rest;
            let mut atvs = set.value;
            while !atvs.is_empty() {
                let atv = tlv(atvs)?;
                atvs = atv.rest;
                let oid = tlv(atv.value)?;
                if oid.value == &[0x55u8, 0x04, 0x03][..] {
                    let v = tlv(oid.rest)?;
                    names.cns.push(String::from_utf8_lossy(v.value).into_owned());
                }
            }
        }
        for ext_wrap in items.iter().skip(base + 6).filter(|t| t.tag == 0xa3) {
            let exts = tlv(ext_wrap.value)?;
            let mut e = exts.value;
            while !e.is_empty() {
                let ext = tlv(e)?;
                e = ext.rest;
                let oid = tlv(ext.value)?;
                if oid.value != &[0x55u8, 0x1d, 0x11][..] {
                    continue;
                }
                let mut v = tlv(oid.rest)?;
                if v.tag == 0x01 {
                    v = tlv(v.rest)?; // critical
                }
                let gns = tlv(v.value)?;
                let mut g = gns.value;
                while !g.is_empty() {
                    let gn = tlv(g)?;
                    g = gn.rest;
                    match gn.tag {
                        0x82 => names.dns.push(String::from_utf8_lossy(gn.value).into_owned()),
                        0x87 => names.ips.push(gn.value.to_vec()),
                        _ => {}
                    }
                }
            }
        }
        Some(names)
    }

    /// X509Certificate.checkIP: an IP subject alternative name with these bytes.
    pub fn check_ip(&self, ip: &IpAddr) -> bool {
        let bytes = match ip {
            IpAddr::V4(a) => a.octets().to_vec(),
            IpAddr::V6(a) => a.octets().to_vec(),
        };
        self.ips.iter().any(|b| *b == bytes)
    }

    /// X509Certificate.checkHost with Node's defaults: DNS names, the subject common name only when there is none,
    /// and OpenSSL's wildcard rules (left-most label only, partial wildcards allowed, one label).
    pub fn check_host(&self, name: &str) -> bool {
        let pool = if self.dns.is_empty() { &self.cns } else { &self.dns };
        pool.iter().any(|p| wildcard_equal(p.as_bytes(), name.as_bytes()))
    }
}

fn equal_nocase(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_ascii_lowercase() == y.to_ascii_lowercase()) && !a.contains(&0)
}

/// OpenSSL's valid_star: where the one usable `*` in a pattern is, or None.
fn valid_star(p: &[u8]) -> Option<usize> {
    let (mut star, mut dots) = (None, 0);
    let (mut start, mut hyphen, mut idna) = (true, false, false);
    for i in 0..p.len() {
        let at_end = i == p.len() - 1 || p[i + 1] == b'.';
        match p[i] {
            b'*' => {
                if star.is_some() || idna || dots > 0 || (!start && !at_end) {
                    return None;
                }
                star = Some(i);
                start = false;
            }
            c if c.is_ascii_alphanumeric() => {
                if start && p.len() - i >= 4 && p[i..i + 4].eq_ignore_ascii_case(b"xn--") {
                    idna = true;
                }
                hyphen = false;
                start = false;
            }
            b'.' => {
                if hyphen || start {
                    return None;
                }
                start = true;
                hyphen = false;
                idna = false;
                dots += 1;
            }
            b'-' => {
                if start {
                    return None;
                }
                hyphen = true;
            }
            _ => return None,
        }
    }
    if start || hyphen || dots < 2 {
        return None;
    }
    star
}

fn wildcard_equal(pattern: &[u8], subject: &[u8]) -> bool {
    let star = if subject.first() == Some(&b'.') { None } else { valid_star(pattern) };
    let Some(s) = star else { return equal_nocase(pattern, subject) };
    let (prefix, suffix) = (&pattern[..s], &pattern[s + 1..]);
    if subject.len() < prefix.len() + suffix.len() {
        return false;
    }
    if !equal_nocase(prefix, &subject[..prefix.len()]) || !equal_nocase(&subject[subject.len() - suffix.len()..], suffix) {
        return false;
    }
    let wild = &subject[prefix.len()..subject.len() - suffix.len()];
    let whole_label = prefix.is_empty() && suffix.first() == Some(&b'.');
    if whole_label && wild.is_empty() {
        return false;
    }
    if !whole_label && subject.len() >= 4 && subject[..4].eq_ignore_ascii_case(b"xn--") {
        return false;
    }
    if wild == b"*" {
        return true;
    }
    wild.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcards_follow_openssl() {
        let n = CertNames { dns: vec!["*.example.com".into(), "f*.test.org".into()], ips: vec![vec![127, 0, 0, 1]], cns: vec!["ignored".into()] };
        assert!(n.check_host("relay.example.com"));
        assert!(n.check_host("RELAY.example.com"));
        assert!(!n.check_host("a.b.example.com"));
        assert!(!n.check_host("example.com"));
        assert!(n.check_host("foo.test.org"));
        assert!(!n.check_host("ignored"));
        assert!(n.check_ip(&"127.0.0.1".parse().unwrap()));
        assert!(!n.check_ip(&"127.0.0.2".parse().unwrap()));
        let cn_only = CertNames { dns: vec![], ips: vec![], cns: vec!["relay.lan".into()] };
        assert!(cn_only.check_host("relay.lan"));
        let too_wide = CertNames { dns: vec!["*.com".into()], ips: vec![], cns: vec![] };
        assert!(!too_wide.check_host("example.com"));
    }

    #[test]
    fn aws_lc_verifies_what_rustcrypto_signs() {
        use p256::ecdsa::signature::Signer;
        use p256::ecdsa::{Signature, SigningKey};
        use p256::elliptic_curve::sec1::ToEncodedPoint;
        let sk = SigningKey::from_slice(&[3u8; 32]).unwrap();
        let key: P256Key = sk.verifying_key().into();
        let sig: Signature = sk.sign(b"lucid");
        assert!(ecdsa_verify(&key, b"lucid", sig.to_der().as_bytes()));
        assert!(!ecdsa_verify(&key, b"lucie", sig.to_der().as_bytes()));
        assert!(!ecdsa_verify(&key, b"lucid", &sig.to_bytes()));
        // A compressed point reads to the same key and the same SPKI.
        let compressed = sk.verifying_key().as_affine().to_encoded_point(true);
        let same = P256Key::from_sec1(compressed.as_bytes()).unwrap();
        assert_eq!(p256_spki_der(&same), p256_spki_der(&key));
        assert!(ecdsa_verify(&same, b"lucid", sig.to_der().as_bytes()));
        // A point off the curve is no key.
        let mut off = *key.point();
        off[64] ^= 1;
        assert!(P256Key::from_sec1(&off).is_none());
        assert!(p256_from_spki(&p256_spki_der(&key)).is_some());
    }

    #[test]
    fn ed25519_follows_rfc_8032() {
        let hex = |s: &str| (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect::<Vec<u8>>();
        let public: [u8; 32] = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a").try_into().unwrap();
        let sig = hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        let key = Ed25519Key::from_raw(&public).unwrap();
        assert!(ed25519_verify(&key, b"", &sig));
        assert!(!ed25519_verify(&key, b"x", &sig));
        assert!(!ed25519_verify(&key, b"", &sig[..63]));
    }
}
