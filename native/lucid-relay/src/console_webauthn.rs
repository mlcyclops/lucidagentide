// WebAuthn methods of the Admin Console (AC-1 revision 4, 3.3 "WebAuthn registration" and "Attestation"): WebAuthn
// level 2 registration and sign-in, credential keys ES256 or RS256 (RSA 2048 to 8192 bits, RSASSA-PKCS1-v1_5 with
// SHA-256), every check on AWS-LC. The client data (type, challenge, origin, never cross-origin), the rpIdHash, user
// presence and, when asked, user verification; at registration the attested credential, its AAGUID and its
// attestation statement: `none` and `packed` self attestation verified (a self signature that fails refuses);
// `packed` with `x5c` (full) and `tpm` verified as WebAuthn level 2 sections 8.2 and 8.3 say (certificate
// requirements, the AAGUID extension, and for `tpm` the `pubArea` and `certInfo` checks), their chain kept for the
// MDS3 verdict (console_mds.rs); a full statement that fails its checks and any other format are stored as
// unattested, never refused. At sign-in and step-up the signature over authenticatorData || SHA-256(clientDataJSON)
// with the stored key (its COSE bytes decide ES256 or RS256). A small CBOR reader for what WebAuthn sends, and the
// little X.509 the attestation checks read beyond `meet_x509::Cert`.

use crate::codec::{parse_json, sha256, str_of, unb64u};
use crate::der::{ecdsa_verify, tlv, P256Key};
use crate::meet_x509::Cert;
use aws_lc_rs::digest;
use aws_lc_rs::signature::{self as sig, RsaPublicKeyComponents, UnparsedPublicKey};
use serde_json::{json, Value};

/// COSE algorithm ES256 (ECDSA P-256 with SHA-256).
pub const ES256: i128 = -7;
/// COSE algorithm RS256 (RSASSA-PKCS1-v1_5 with SHA-256).
pub const RS256: i128 = -257;
/// COSE algorithm ES384 (ECDSA P-384 with SHA-384), taken for attestation signatures only.
const ES384: i128 = -35;
/// COSE algorithm RS384 (RSASSA-PKCS1-v1_5 with SHA-384), taken for attestation signatures only.
const RS384: i128 = -258;
const CBOR_DEPTH: usize = 16;
const FIELD_MAX: usize = 64 * 1024;
/// At most this many certificates in an attestation `x5c`.
const X5C_MAX: usize = 8;

/// `pubKeyCredParams` for `navigator.credentials.create`: ES256, then RS256.
pub fn pub_key_params() -> Value {
    json!([{ "type": "public-key", "alg": ES256 as i64 }, { "type": "public-key", "alg": RS256 as i64 }])
}

/// Why a passkey answer was refused: the HTTP status and the text the browser shows.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub message: String,
}

fn bad(message: &str) -> Refusal {
    Refusal { status: 400, message: message.to_owned() }
}

fn denied(message: &str) -> Refusal {
    Refusal { status: 403, message: message.to_owned() }
}

// ── CBOR (the subset WebAuthn uses) ──────────────────────────────────────────────────────────────────────────

/// One CBOR item: integers, byte and text strings, arrays, maps with integer or text keys (no duplicates), false,
/// true and null; definite lengths only.
#[derive(Clone, Debug, PartialEq)]
pub enum Cbor {
    Int(i128),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(Cbor, Cbor)>),
    Bool(bool),
    Null,
}

impl Cbor {
    fn get(&self, key: &Cbor) -> Option<&Cbor> {
        match self {
            Cbor::Map(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn int_key(&self, k: i128) -> Option<&Cbor> {
        self.get(&Cbor::Int(k))
    }

    fn text_key(&self, k: &str) -> Option<&Cbor> {
        self.get(&Cbor::Text(k.to_owned()))
    }
}

fn cbor_item(d: &[u8], pos: usize, depth: usize) -> Result<(Cbor, usize), String> {
    if depth > CBOR_DEPTH {
        return Err("nested too deeply".into());
    }
    let first = *d.get(pos).ok_or("truncated")?;
    let (major, info) = (first >> 5, first & 0x1f);
    let mut p = pos + 1;
    let arg: u64 = match info {
        0..=23 => u64::from(info),
        24..=27 => {
            let n = 1usize << (info - 24);
            let bytes = d.get(p..p + n).ok_or("truncated")?;
            p += n;
            bytes.iter().fold(0u64, |a, b| (a << 8) | u64::from(*b))
        }
        _ => return Err("indefinite lengths are not read".into()),
    };
    match major {
        0 => Ok((Cbor::Int(i128::from(arg)), p)),
        1 => Ok((Cbor::Int(-1 - i128::from(arg)), p)),
        2 | 3 => {
            let n = usize::try_from(arg).map_err(|_| "too long")?;
            let end = p.checked_add(n).filter(|e| *e <= d.len()).ok_or("truncated")?;
            let raw = d[p..end].to_vec();
            if major == 2 {
                Ok((Cbor::Bytes(raw), end))
            } else {
                String::from_utf8(raw).map(|s| (Cbor::Text(s), end)).map_err(|_| "text is not UTF-8".to_string())
            }
        }
        4 => {
            // Every item takes at least one byte: a count past the data is truncated, never a huge allocation.
            if arg > (d.len() - p) as u64 {
                return Err("truncated".into());
            }
            let mut items = Vec::with_capacity(arg as usize);
            for _ in 0..arg {
                let (v, end) = cbor_item(d, p, depth + 1)?;
                items.push(v);
                p = end;
            }
            Ok((Cbor::Array(items), p))
        }
        5 => {
            if arg > (d.len() - p) as u64 {
                return Err("truncated".into());
            }
            let mut m: Vec<(Cbor, Cbor)> = Vec::with_capacity(arg as usize);
            for _ in 0..arg {
                let (k, end) = cbor_item(d, p, depth + 1)?;
                if !matches!(k, Cbor::Int(_) | Cbor::Text(_)) {
                    return Err("a map key is not an integer or text".into());
                }
                if m.iter().any(|(x, _)| *x == k) {
                    return Err("a map key is repeated".into());
                }
                let (v, end) = cbor_item(d, end, depth + 1)?;
                m.push((k, v));
                p = end;
            }
            Ok((Cbor::Map(m), p))
        }
        7 => match info {
            20 => Ok((Cbor::Bool(false), p)),
            21 => Ok((Cbor::Bool(true), p)),
            22 => Ok((Cbor::Null, p)),
            _ => Err("floats and other simple values are not read".into()),
        },
        _ => Err("tags are not read".into()),
    }
}

/// One whole CBOR item, nothing after it.
pub fn cbor_decode(d: &[u8]) -> Result<Cbor, String> {
    let (v, end) = cbor_item(d, 0, 0)?;
    if end != d.len() {
        return Err("trailing bytes".into());
    }
    Ok(v)
}

// ── Authenticator data, keys, client data ────────────────────────────────────────────────────────────────────

/// Authenticator data: rpIdHash, the UP and UV flags, signCount and, with AT, the AAGUID (zeros without AT) and the
/// attested credential (its id, its COSE key and the key's raw bytes).
pub struct AuthData {
    pub rp_hash: [u8; 32],
    pub up: bool,
    pub uv: bool,
    pub sign_count: u32,
    pub aaguid: [u8; 16],
    pub credential: Option<(Vec<u8>, Cbor, Vec<u8>)>,
}

pub fn parse_auth_data(d: &[u8]) -> Result<AuthData, Refusal> {
    if d.len() < 37 {
        return Err(bad("the authenticator data is too short"));
    }
    let mut rp_hash = [0u8; 32];
    rp_hash.copy_from_slice(&d[..32]);
    let flags = d[32];
    let sign_count = u32::from_be_bytes([d[33], d[34], d[35], d[36]]);
    let mut pos = 37;
    let mut credential = None;
    let mut aaguid = [0u8; 16];
    if flags & 0x40 != 0 {
        if d.len() < pos + 18 {
            return Err(bad("the authenticator data is too short"));
        }
        aaguid.copy_from_slice(&d[pos..pos + 16]);
        let size = usize::from(u16::from_be_bytes([d[pos + 16], d[pos + 17]]));
        pos += 18;
        if !(1..=1023).contains(&size) || pos + size > d.len() {
            return Err(bad("the credential id is malformed"));
        }
        let id = d[pos..pos + size].to_vec();
        pos += size;
        let (cose, end) = cbor_item(d, pos, 0).map_err(|e| bad(&format!("the passkey's data could not be read ({e})")))?;
        if !matches!(cose, Cbor::Map(_)) {
            return Err(bad("the credential's public key is malformed"));
        }
        credential = Some((id, cose, d[pos..end].to_vec()));
        pos = end;
    }
    if flags & 0x80 != 0 {
        // Extensions: read past, not used.
        let (_, end) = cbor_item(d, pos, 0).map_err(|e| bad(&format!("the passkey's data could not be read ({e})")))?;
        pos = end;
    }
    if pos != d.len() {
        return Err(bad("the authenticator data has trailing bytes"));
    }
    Ok(AuthData { rp_hash, up: flags & 0x01 != 0, uv: flags & 0x04 != 0, sign_count, aaguid, credential })
}

/// The P-256 key of a COSE EC2 key with alg ES256; anything else is refused.
pub fn cose_es256(cose: &Cbor) -> Result<P256Key, Refusal> {
    if cose.int_key(3) != Some(&Cbor::Int(ES256)) {
        return Err(bad("this passkey uses an algorithm the control panel does not accept (ES256 only)"));
    }
    if cose.int_key(1) != Some(&Cbor::Int(2)) || cose.int_key(-1) != Some(&Cbor::Int(1)) {
        return Err(bad("the passkey's EC key is malformed"));
    }
    let (Some(Cbor::Bytes(x)), Some(Cbor::Bytes(y))) = (cose.int_key(-2), cose.int_key(-3)) else {
        return Err(bad("the passkey's EC key is malformed"));
    };
    if x.len() != 32 || y.len() != 32 {
        return Err(bad("the passkey's EC key is malformed"));
    }
    let mut sec1 = Vec::with_capacity(65);
    sec1.push(4u8);
    sec1.extend_from_slice(x);
    sec1.extend_from_slice(y);
    P256Key::from_sec1(&sec1).ok_or_else(|| bad("the passkey's public key is not a valid P-256 point"))
}

/// A credential's public key: ES256 (P-256) or RS256 (RSA 2048 to 8192 bits, `n` and `e` big-endian without leading
/// zeros).
#[derive(Clone, Debug)]
pub enum CredKey {
    Es256(P256Key),
    Rs256 { n: Vec<u8>, e: Vec<u8> },
}

impl CredKey {
    /// Its COSE algorithm.
    pub fn alg(&self) -> i128 {
        match self {
            CredKey::Es256(_) => ES256,
            CredKey::Rs256 { .. } => RS256,
        }
    }

    /// The signature over `msg`: DER ECDSA with SHA-256, or RSASSA-PKCS1-v1_5 with SHA-256, on AWS-LC.
    pub fn verify(&self, msg: &[u8], signature: &[u8]) -> bool {
        match self {
            CredKey::Es256(k) => ecdsa_verify(k, msg, signature),
            CredKey::Rs256 { n, e } => RsaPublicKeyComponents { n: n.as_slice(), e: e.as_slice() }.verify(&sig::RSA_PKCS1_2048_8192_SHA256, msg, signature).is_ok(),
        }
    }
}

fn strip_zeros(b: &[u8]) -> &[u8] {
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    &b[i..]
}

/// The key of a COSE key with alg ES256 (EC2, P-256) or RS256 (RSA, 2048 to 8192 bits); anything else is refused.
pub fn cose_key(cose: &Cbor) -> Result<CredKey, Refusal> {
    match cose.int_key(3) {
        Some(Cbor::Int(ES256)) => cose_es256(cose).map(CredKey::Es256),
        Some(Cbor::Int(RS256)) => {
            if cose.int_key(1) != Some(&Cbor::Int(3)) {
                return Err(bad("the passkey's RSA key is malformed"));
            }
            let (Some(Cbor::Bytes(n)), Some(Cbor::Bytes(e))) = (cose.int_key(-1), cose.int_key(-2)) else {
                return Err(bad("the passkey's RSA key is malformed"));
            };
            let (n, e) = (strip_zeros(n), strip_zeros(e));
            let bits = match n.first() {
                Some(top) => (n.len() - 1) * 8 + (8 - top.leading_zeros() as usize),
                None => 0,
            };
            if !(2048..=8192).contains(&bits) {
                return Err(bad("the passkey's RSA key must have 2048 to 8192 bits"));
            }
            if e.is_empty() || e.len() > 8 {
                return Err(bad("the passkey's RSA key is malformed"));
            }
            let components = RsaPublicKeyComponents { n, e };
            if components.to_parsed_public_key(&sig::RSA_PKCS1_2048_8192_SHA256).is_err() {
                return Err(bad("the passkey's RSA key is malformed"));
            }
            Ok(CredKey::Rs256 { n: n.to_vec(), e: e.to_vec() })
        }
        _ => Err(bad("this passkey uses an algorithm the control panel does not accept (ES256 or RS256 only)")),
    }
}

/// Byte strings compared in time that does not depend on where they differ.
pub fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn check_client_data(raw: &[u8], kind: &str, challenge: &[u8], origin: &str) -> Result<(), Refusal> {
    let parsed = std::str::from_utf8(raw).ok().and_then(parse_json);
    let Some(o) = parsed.as_ref().and_then(Value::as_object) else { return Err(bad("the browser's client data could not be read")) };
    if str_of(o.get("type")) != Some(kind) {
        return Err(bad("the browser answered a different request"));
    }
    let answered = str_of(o.get("challenge")).and_then(unb64u).unwrap_or_default();
    if !same_bytes(&answered, challenge) {
        return Err(bad("the passkey answered another challenge; try again"));
    }
    if str_of(o.get("origin")) != Some(origin) || o.get("crossOrigin") == Some(&Value::Bool(true)) {
        return Err(denied("the passkey answered for another website"));
    }
    Ok(())
}

fn check_rp(auth: &AuthData, rp_id: &str, require_uv: bool) -> Result<(), Refusal> {
    if !same_bytes(&auth.rp_hash, &sha256(rp_id.as_bytes())) {
        return Err(denied("the passkey belongs to another website"));
    }
    if !auth.up {
        return Err(bad("the passkey did not confirm that you are present"));
    }
    if require_uv && !auth.uv {
        return Err(denied("the passkey did not verify you (its PIN or biometric)"));
    }
    Ok(())
}

/// A base64url field of the browser's answer, at most 64 KiB.
fn b64_field(v: Option<&Value>, what: &str) -> Result<Vec<u8>, Refusal> {
    str_of(v).filter(|s| !s.is_empty() && s.len() <= FIELD_MAX).and_then(unb64u).ok_or_else(|| bad(&format!("{what} is missing or not base64url")))
}

fn response_of(credential: &Value) -> Result<&serde_json::Map<String, Value>, Refusal> {
    credential.get("response").and_then(Value::as_object).ok_or_else(|| bad("the browser sent no passkey answer"))
}

/// The credential id the browser names (`rawId`, else `id`).
pub fn credential_id(credential: &Value) -> Result<Vec<u8>, Refusal> {
    let v = credential.get("rawId").or_else(|| credential.get("id"));
    b64_field(v, "the passkey id")
}

/// The `credProps` extension's `rk` the browser reported at registration (AC-1 3.3): Some(false) for a passkey the
/// device does not keep (refused), None when the browser said nothing.
pub fn cred_props_rk(credential: &Value) -> Option<bool> {
    credential.get("clientExtensionResults").and_then(|e| e.get("credProps")).and_then(|c| c.get("rk")).and_then(Value::as_bool)
}

// ── X.509 for attestation statements ─────────────────────────────────────────────────────────────────────────

const OID_EC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_RSA_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_ECDSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
const OID_RSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const OID_RSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c];
const OID_C: &[u8] = &[0x55, 0x04, 0x06];
const OID_O: &[u8] = &[0x55, 0x04, 0x0a];
const OID_OU: &[u8] = &[0x55, 0x04, 0x0b];
const OID_CN: &[u8] = &[0x55, 0x04, 0x03];
const OID_SAN: &[u8] = &[0x55, 0x1d, 0x11];
const OID_EKU: &[u8] = &[0x55, 0x1d, 0x25];
/// id-fido-gen-ce-aaguid, 1.3.6.1.4.1.45724.1.1.4.
const OID_FIDO_AAGUID: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0xe5, 0x1c, 0x01, 0x01, 0x04];
/// tcg-kp-AIKCertificate, 2.23.133.8.3.
const OID_TCG_AIK: &[u8] = &[0x67, 0x81, 0x05, 0x08, 0x03];

/// A signature algorithm the console takes for attestation statements, attestation chains and the MDS3 blob (AC-1
/// section 0): ECDSA P-256 or P-384 and RSA 2048 or more, with SHA-256 or SHA-384.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SigAlg {
    Es256,
    Es384,
    Rs256,
    Rs384,
}

impl SigAlg {
    /// From a COSE algorithm (an attestation statement's `alg`).
    pub fn from_cose(alg: i128) -> Option<SigAlg> {
        match alg {
            ES256 => Some(SigAlg::Es256),
            ES384 => Some(SigAlg::Es384),
            RS256 => Some(SigAlg::Rs256),
            RS384 => Some(SigAlg::Rs384),
            _ => None,
        }
    }

    /// From a JWS `alg` (the MDS3 blob header).
    pub fn from_jws(alg: &str) -> Option<SigAlg> {
        match alg {
            "ES256" => Some(SigAlg::Es256),
            "ES384" => Some(SigAlg::Es384),
            "RS256" => Some(SigAlg::Rs256),
            "RS384" => Some(SigAlg::Rs384),
            _ => None,
        }
    }

    /// The hash the algorithm signs with.
    pub fn digest(self, data: &[u8]) -> Vec<u8> {
        let alg = match self {
            SigAlg::Es256 | SigAlg::Rs256 => &digest::SHA256,
            SigAlg::Es384 | SigAlg::Rs384 => &digest::SHA384,
        };
        digest::digest(alg, data).as_ref().to_vec()
    }
}

/// True when the key in `spki` (SubjectPublicKeyInfo DER) made `signature` over `msg` with `alg`. ECDSA signatures
/// are DER (`fixed` false: WebAuthn, X.509) or r || s (`fixed` true: JWS). The key must be of the algorithm's kind:
/// P-256 for ES256, P-384 for ES384, RSA 2048 to 8192 bits for RS256 and RS384.
pub fn spki_verify(spki: &[u8], alg: SigAlg, fixed: bool, msg: &[u8], signature: &[u8]) -> bool {
    let Some(outer) = tlv(spki).filter(|t| t.tag == 0x30) else { return false };
    let Some(alg_id) = tlv(outer.value).filter(|t| t.tag == 0x30) else { return false };
    let Some(bits) = tlv(alg_id.rest).filter(|t| t.tag == 0x03 && t.value.first() == Some(&0)) else { return false };
    let Some(oid) = tlv(alg_id.value).filter(|t| t.tag == 0x06) else { return false };
    let param = tlv(oid.rest).filter(|t| t.tag == 0x06).map(|t| t.value);
    let key = &bits.value[1..];
    let verifier: &'static dyn sig::VerificationAlgorithm = match (oid.value, param, alg, fixed) {
        (OID_EC_KEY, Some(OID_P256), SigAlg::Es256, false) => &sig::ECDSA_P256_SHA256_ASN1,
        (OID_EC_KEY, Some(OID_P256), SigAlg::Es256, true) => &sig::ECDSA_P256_SHA256_FIXED,
        (OID_EC_KEY, Some(OID_P384), SigAlg::Es384, false) => &sig::ECDSA_P384_SHA384_ASN1,
        (OID_EC_KEY, Some(OID_P384), SigAlg::Es384, true) => &sig::ECDSA_P384_SHA384_FIXED,
        (OID_RSA_KEY, _, SigAlg::Rs256, _) => &sig::RSA_PKCS1_2048_8192_SHA256,
        (OID_RSA_KEY, _, SigAlg::Rs384, _) => &sig::RSA_PKCS1_2048_8192_SHA384,
        _ => return false,
    };
    UnparsedPublicKey::new(verifier, key).verify(msg, signature).is_ok()
}

/// What the attestation and MDS3 checks read from a certificate beyond `meet_x509::Cert`: whether it is version 3,
/// its signature algorithm OID and every extension (OID, critical, value inside the OCTET STRING).
#[derive(Clone, Debug)]
pub struct X509 {
    pub cert: Cert,
    pub v3: bool,
    pub sig_alg: Vec<u8>,
    pub exts: Vec<(Vec<u8>, bool, Vec<u8>)>,
}

impl X509 {
    /// The value of the one extension with `oid`: None when absent, Some(Err) when repeated.
    pub fn ext(&self, oid: &[u8]) -> Option<Result<(bool, &[u8]), ()>> {
        let mut found = self.exts.iter().filter(|(o, _, _)| o == oid);
        let first = found.next()?;
        if found.next().is_some() {
            return Some(Err(()));
        }
        Some(Ok((first.1, first.2.as_slice())))
    }

    /// The certificate's signature algorithm is one AC-1 section 0 takes for chains: ECDSA with SHA-256 or SHA-384,
    /// or RSASSA-PKCS1-v1_5 with SHA-256 or SHA-384.
    pub fn fips_signature(&self) -> bool {
        matches!(self.sig_alg.as_slice(), OID_ECDSA_SHA256 | OID_ECDSA_SHA384 | OID_RSA_SHA256 | OID_RSA_SHA384)
    }

    /// In date at `now_s` (unix seconds).
    pub fn in_date(&self, now_s: i64) -> bool {
        self.cert.not_before <= now_s && now_s <= self.cert.not_after
    }

    /// The attributes of its subject with `oid`.
    fn subject_attr(&self, oid: &[u8]) -> Vec<&str> {
        self.cert.names.subject.iter().filter(|(o, _)| o == oid).map(|(_, v)| v.as_str()).collect()
    }
}

/// A DER certificate read for attestation checks, or None.
pub fn x509(der: &[u8]) -> Option<X509> {
    let outer = tlv(der).filter(|t| t.tag == 0x30 && t.rest.is_empty())?;
    let tbs = tlv(outer.value).filter(|t| t.tag == 0x30)?;
    let alg = tlv(tbs.rest).filter(|t| t.tag == 0x30)?;
    let alg_oid = tlv(alg.value).filter(|t| t.tag == 0x06)?;
    let cert = Cert::from_der(der)?;
    let mut d = tbs.value;
    let mut v3 = false;
    let first = tlv(d)?;
    if first.tag == 0xa0 {
        let version = tlv(first.value)?;
        v3 = version.tag == 0x02 && version.value == [2];
        d = first.rest;
    }
    // serial, signature, issuer, validity, subject, subjectPublicKeyInfo
    for _ in 0..6 {
        d = tlv(d)?.rest;
    }
    let mut exts = Vec::new();
    while !d.is_empty() {
        let t = tlv(d)?;
        if t.tag == 0xa3 {
            let seq = tlv(t.value).filter(|s| s.tag == 0x30)?;
            let mut e = seq.value;
            while !e.is_empty() {
                let ext = tlv(e).filter(|x| x.tag == 0x30)?;
                let oid = tlv(ext.value).filter(|x| x.tag == 0x06)?;
                let mut rest = oid.rest;
                let mut critical = false;
                let next = tlv(rest)?;
                if next.tag == 0x01 {
                    critical = next.value.iter().any(|b| *b != 0);
                    rest = next.rest;
                }
                let value = tlv(rest).filter(|x| x.tag == 0x04)?;
                exts.push((oid.value.to_vec(), critical, value.value.to_vec()));
                e = ext.rest;
            }
        }
        d = t.rest;
    }
    Some(X509 { cert, v3, sig_alg: alg_oid.value.to_vec(), exts })
}

/// The id-fido-gen-ce-aaguid extension, when present, is not critical and names `aaguid` (WebAuthn level 2 8.2.1 and
/// 8.3.1).
fn aaguid_ext_ok(c: &X509, aaguid: &[u8; 16]) -> bool {
    match c.ext(OID_FIDO_AAGUID) {
        None => true,
        Some(Ok((critical, value))) => !critical && tlv(value).is_some_and(|t| t.tag == 0x04 && t.rest.is_empty() && t.value == aaguid),
        Some(Err(())) => false,
    }
}

// ── Attestation statements ───────────────────────────────────────────────────────────────────────────────────

/// A registration's attestation: its format and, only when a full statement (`packed` with `x5c`, or `tpm`) verified,
/// its `x5c` chain (DER, leaf first). An empty chain is unattested.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Attestation {
    pub fmt: String,
    pub chain: Vec<Vec<u8>>,
}

/// A passkey just registered: its id, its COSE key bytes, the authenticator's sign count, its AAGUID and its
/// attestation.
#[derive(Debug)]
pub struct NewPasskey {
    pub id: Vec<u8>,
    pub cose: Vec<u8>,
    pub sign_count: u32,
    pub aaguid: [u8; 16],
    pub attestation: Attestation,
}

/// The certificates of an `x5c` array (1 to 8 byte strings), or None.
fn x5c_ders(v: Option<&Cbor>) -> Option<Vec<Vec<u8>>> {
    let Some(Cbor::Array(items)) = v else { return None };
    if items.is_empty() || items.len() > X5C_MAX {
        return None;
    }
    items.iter().map(|c| if let Cbor::Bytes(b) = c { Some(b.clone()) } else { None }).collect()
}

/// A `packed` statement with `x5c` (WebAuthn level 2 8.2): `sig` over authenticatorData || clientDataHash by the
/// leaf's key with `alg`, and the leaf's requirements (8.2.1: version 3; subject C, O, OU "Authenticator
/// Attestation" and CN; not a CA; the AAGUID extension, when present, not critical and equal to the AAGUID). The
/// chain when every check passes.
pub fn packed_full_verified(stmt: &Cbor, signed: &[u8], aaguid: &[u8; 16]) -> Option<Vec<Vec<u8>>> {
    let (Some(Cbor::Int(alg)), Some(Cbor::Bytes(signature))) = (stmt.text_key("alg"), stmt.text_key("sig")) else { return None };
    let chain = x5c_ders(stmt.text_key("x5c"))?;
    let alg = SigAlg::from_cose(*alg)?;
    let leaf = x509(&chain[0])?;
    if !spki_verify(&leaf.cert.spki, alg, false, signed, signature) {
        return None;
    }
    let one = |oid: &[u8]| -> Option<String> {
        let v = leaf.subject_attr(oid);
        (v.len() == 1 && !v[0].is_empty()).then(|| v[0].to_owned())
    };
    let country = one(OID_C)?;
    one(OID_O)?;
    one(OID_CN)?;
    let unit = one(OID_OU)?;
    let ok = leaf.v3 && country.len() == 2 && country.bytes().all(|b| b.is_ascii_alphabetic()) && unit == "Authenticator Attestation" && !leaf.cert.ca && aaguid_ext_ok(&leaf, aaguid);
    ok.then_some(chain)
}

const TPM_ALG_RSA: u16 = 0x0001;
const TPM_ALG_ECC: u16 = 0x0023;
const TPM_ALG_NULL: u16 = 0x0010;
const TPM_ALG_SHA256: u16 = 0x000b;
const TPM_ALG_SHA384: u16 = 0x000c;
const TPM_ECC_NIST_P256: u16 = 0x0003;
const TPM_GENERATED_VALUE: u32 = 0xff54_4347;
const TPM_ST_ATTEST_CERTIFY: u16 = 0x8017;

/// A reader over TPM structures (big-endian).
struct Tpm<'a> {
    d: &'a [u8],
}

impl<'a> Tpm<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.d.len() < n {
            return None;
        }
        let (a, b) = self.d.split_at(n);
        self.d = b;
        Some(a)
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    /// A TPM2B: a 2-byte size, then the bytes.
    fn sized(&mut self) -> Option<&'a [u8]> {
        let n = self.u16()?;
        self.take(usize::from(n))
    }
    /// A scheme or symmetric definition: an algorithm and, unless TPM_ALG_NULL, its `extra` u16 details.
    fn scheme(&mut self, extra: usize) -> Option<()> {
        if self.u16()? != TPM_ALG_NULL {
            self.take(2 * extra)?;
        }
        Some(())
    }
}

/// The key a TPMT_PUBLIC names.
enum TpmKey<'a> {
    Rsa { n: &'a [u8], e: u32 },
    Ecc { curve: u16, x: &'a [u8], y: &'a [u8] },
}

/// TPMT_PUBLIC (TPM 2.0 part 2, 12.2.4): its nameAlg and key; every byte read.
fn pub_area(d: &[u8]) -> Option<(u16, TpmKey<'_>)> {
    let mut r = Tpm { d };
    let kind = r.u16()?;
    let name_alg = r.u16()?;
    r.u32()?; // objectAttributes
    r.sized()?; // authPolicy
    let key = match kind {
        TPM_ALG_RSA => {
            r.scheme(2)?; // symmetric: keyBits, mode
            r.scheme(1)?; // scheme: hashAlg
            r.u16()?; // keyBits
            let exponent = r.u32()?;
            let n = r.sized()?;
            TpmKey::Rsa { n, e: if exponent == 0 { 65_537 } else { exponent } }
        }
        TPM_ALG_ECC => {
            r.scheme(2)?;
            r.scheme(1)?;
            let curve = r.u16()?;
            r.scheme(1)?; // kdf: hashAlg
            let x = r.sized()?;
            let y = r.sized()?;
            TpmKey::Ecc { curve, x, y }
        }
        _ => return None,
    };
    r.d.is_empty().then_some((name_alg, key))
}

/// `b` left-padded with zeros to `n` bytes, or None when longer.
fn padded(b: &[u8], n: usize) -> Option<Vec<u8>> {
    let b = strip_zeros(b);
    (b.len() <= n).then(|| {
        let mut out = vec![0u8; n - b.len()];
        out.extend_from_slice(b);
        out
    })
}

/// The `pubArea` key is the credential's key.
fn same_key(tpm: &TpmKey, key: &CredKey) -> bool {
    match (tpm, key) {
        (TpmKey::Rsa { n, e }, CredKey::Rs256 { n: kn, e: ke }) => strip_zeros(n) == kn.as_slice() && strip_zeros(&e.to_be_bytes()) == ke.as_slice(),
        (TpmKey::Ecc { curve, x, y }, CredKey::Es256(k)) => {
            let point = k.point();
            *curve == TPM_ECC_NIST_P256 && padded(x, 32).as_deref() == Some(&point[1..33]) && padded(y, 32).as_deref() == Some(&point[33..65])
        }
        _ => false,
    }
}

/// A `tpm` statement (WebAuthn level 2 8.3): `ver` "2.0"; the `pubArea` key equal to the credential key; `certInfo`
/// with TPM_GENERATED_VALUE, TPM_ST_ATTEST_CERTIFY, extraData the hash (of `alg`) of authenticatorData ||
/// clientDataHash and the attested name nameAlg || hash(pubArea) (nameAlg SHA-256 or SHA-384); `sig` over `certInfo`
/// by the AIK leaf with `alg`; the AIK's requirements (8.3.1: version 3; empty subject; a subject alternative name;
/// extended key usage tcg-kp-AIKCertificate; not a CA; the AAGUID extension, when present, not critical and equal to
/// the AAGUID). The chain when every check passes.
pub fn tpm_verified(stmt: &Cbor, auth_raw: &[u8], client_hash: &[u8; 32], key: &CredKey, aaguid: &[u8; 16]) -> Option<Vec<Vec<u8>>> {
    if stmt.text_key("ver") != Some(&Cbor::Text("2.0".into())) || stmt.text_key("ecdaaKeyId").is_some() {
        return None;
    }
    let (Some(Cbor::Int(alg)), Some(Cbor::Bytes(signature)), Some(Cbor::Bytes(cert_info)), Some(Cbor::Bytes(public))) =
        (stmt.text_key("alg"), stmt.text_key("sig"), stmt.text_key("certInfo"), stmt.text_key("pubArea"))
    else {
        return None;
    };
    let chain = x5c_ders(stmt.text_key("x5c"))?;
    let alg = SigAlg::from_cose(*alg)?;
    let (name_alg, tpm_key) = pub_area(public)?;
    if !same_key(&tpm_key, key) {
        return None;
    }
    let name_hash = match name_alg {
        TPM_ALG_SHA256 => digest::digest(&digest::SHA256, public),
        TPM_ALG_SHA384 => digest::digest(&digest::SHA384, public),
        _ => return None,
    };
    let mut r = Tpm { d: cert_info };
    if r.u32()? != TPM_GENERATED_VALUE || r.u16()? != TPM_ST_ATTEST_CERTIFY {
        return None;
    }
    r.sized()?; // qualifiedSigner
    let extra = r.sized()?;
    r.take(17)?; // clockInfo: clock, resetCount, restartCount, safe
    r.take(8)?; // firmwareVersion
    let name = r.sized()?;
    r.sized()?; // qualifiedName
    if !r.d.is_empty() {
        return None;
    }
    let mut to_sign = auth_raw.to_vec();
    to_sign.extend_from_slice(client_hash);
    if !same_bytes(extra, &alg.digest(&to_sign)) {
        return None;
    }
    let mut expected_name = name_alg.to_be_bytes().to_vec();
    expected_name.extend_from_slice(name_hash.as_ref());
    if !same_bytes(name, &expected_name) {
        return None;
    }
    let aik = x509(&chain[0])?;
    if !spki_verify(&aik.cert.spki, alg, false, cert_info, signature) {
        return None;
    }
    let eku_ok = match aik.ext(OID_EKU) {
        Some(Ok((_, value))) => eku_has(value, OID_TCG_AIK),
        _ => false,
    };
    let san_ok = matches!(aik.ext(OID_SAN), Some(Ok(_)));
    let ok = aik.v3 && aik.cert.subject == [0x30, 0x00] && san_ok && eku_ok && !aik.cert.ca && aaguid_ext_ok(&aik, aaguid);
    ok.then_some(chain)
}

/// An ExtKeyUsageSyntax value names `oid`.
fn eku_has(value: &[u8], oid: &[u8]) -> bool {
    let Some(seq) = tlv(value).filter(|t| t.tag == 0x30) else { return false };
    let mut d = seq.value;
    while let Some(t) = tlv(d) {
        if t.tag == 0x06 && t.value == oid {
            return true;
        }
        d = t.rest;
    }
    false
}

/// `navigator.credentials.create`, checked: client data, rpIdHash, presence (and verification when required), the
/// attested credential and its ES256 or RS256 key, and the attestation (AC-1 3.3): `none` (an empty statement) and
/// `packed` self attestation (`alg` the credential's, the signature by the credential key) verified, else refused;
/// `packed` with `x5c` and `tpm` verified as `packed_full_verified` and `tpm_verified` say and kept with their chain,
/// or kept unattested when a check fails; any other format kept unattested.
pub fn verify_registration(rp_id: &str, origin: &str, challenge: &[u8], credential: &Value, require_uv: bool) -> Result<NewPasskey, Refusal> {
    let response = response_of(credential)?;
    let raw_id = credential_id(credential)?;
    let client_data = b64_field(response.get("clientDataJSON"), "the client data")?;
    check_client_data(&client_data, "webauthn.create", challenge, origin)?;
    let att_raw = b64_field(response.get("attestationObject"), "the attestation")?;
    let att = cbor_decode(&att_raw).map_err(|e| bad(&format!("the passkey's data could not be read ({e})")))?;
    let (Some(Cbor::Text(fmt)), Some(stmt @ Cbor::Map(_)), Some(Cbor::Bytes(auth_raw))) = (att.text_key("fmt"), att.text_key("attStmt"), att.text_key("authData")) else {
        return Err(bad("the passkey's attestation is malformed"));
    };
    let auth = parse_auth_data(auth_raw)?;
    check_rp(&auth, rp_id, require_uv)?;
    let aaguid = auth.aaguid;
    let Some((cred_id, cose, cose_bytes)) = auth.credential else { return Err(bad("the passkey sent no credential")) };
    if !same_bytes(&cred_id, &raw_id) {
        return Err(bad("the passkey id does not match its credential"));
    }
    let key = cose_key(&cose)?;
    let client_hash = sha256(&client_data);
    let mut signed = auth_raw.clone();
    signed.extend_from_slice(&client_hash);
    let shown: String = fmt.chars().filter(|c| c.is_ascii_graphic()).take(32).collect();
    let chain = match fmt.as_str() {
        "none" => {
            if *stmt != Cbor::Map(Vec::new()) {
                return Err(bad("the passkey's attestation is malformed"));
            }
            Vec::new()
        }
        "packed" if stmt.text_key("x5c").is_none() => {
            let (Some(Cbor::Int(alg)), Some(Cbor::Bytes(signature))) = (stmt.text_key("alg"), stmt.text_key("sig")) else {
                return Err(bad("the passkey's attestation is malformed"));
            };
            if *alg != key.alg() || !key.verify(&signed, signature) {
                return Err(bad("the passkey's self attestation does not verify"));
            }
            Vec::new()
        }
        "packed" => packed_full_verified(stmt, &signed, &aaguid).unwrap_or_default(),
        "tpm" => tpm_verified(stmt, auth_raw, &client_hash, &key, &aaguid).unwrap_or_default(),
        _ => Vec::new(),
    };
    Ok(NewPasskey { id: cred_id, cose: cose_bytes, sign_count: auth.sign_count, aaguid, attestation: Attestation { fmt: shown, chain } })
}

/// A registration's kept evidence re-checked by a relay (AC-2a 3.9 and 4.4): the checks of `verify_registration`
/// except the challenge (the relay never saw the ceremony): client data of type `webauthn.create` for `origin`, never
/// cross-origin; the rpIdHash of `rp_id`; user presence and verification; the attested credential and its ES256 or
/// RS256 key; and the statement, `none` and `packed` self verified (else refused), `packed` full and `tpm` kept with
/// their chain only when they verify. The caller compares the credential id and COSE key with the roster entry's and
/// asks `console_mds::assess` and `why_not` against its own snapshot.
pub fn verify_attestation_evidence(rp_id: &str, origin: &str, attestation_object: &[u8], client_data_json: &[u8]) -> Result<NewPasskey, Refusal> {
    if attestation_object.is_empty() || attestation_object.len() > FIELD_MAX || client_data_json.is_empty() || client_data_json.len() > FIELD_MAX {
        return Err(bad("the evidence is missing or too large"));
    }
    let parsed = std::str::from_utf8(client_data_json).ok().and_then(parse_json);
    let Some(o) = parsed.as_ref().and_then(Value::as_object) else { return Err(bad("the evidence's client data could not be read")) };
    if str_of(o.get("type")) != Some("webauthn.create") {
        return Err(bad("the evidence is not a registration"));
    }
    if str_of(o.get("origin")) != Some(origin) || o.get("crossOrigin") == Some(&Value::Bool(true)) {
        return Err(denied("the evidence was made for another website"));
    }
    let att = cbor_decode(attestation_object).map_err(|e| bad(&format!("the evidence could not be read ({e})")))?;
    let (Some(Cbor::Text(fmt)), Some(stmt @ Cbor::Map(_)), Some(Cbor::Bytes(auth_raw))) = (att.text_key("fmt"), att.text_key("attStmt"), att.text_key("authData")) else {
        return Err(bad("the evidence's attestation is malformed"));
    };
    let auth = parse_auth_data(auth_raw)?;
    check_rp(&auth, rp_id, true)?;
    let aaguid = auth.aaguid;
    let Some((cred_id, cose, cose_bytes)) = auth.credential else { return Err(bad("the evidence names no credential")) };
    let key = cose_key(&cose)?;
    let client_hash = sha256(client_data_json);
    let mut signed = auth_raw.clone();
    signed.extend_from_slice(&client_hash);
    let shown: String = fmt.chars().filter(|c| c.is_ascii_graphic()).take(32).collect();
    let chain = match fmt.as_str() {
        "none" => {
            if *stmt != Cbor::Map(Vec::new()) {
                return Err(bad("the evidence's attestation is malformed"));
            }
            Vec::new()
        }
        "packed" if stmt.text_key("x5c").is_none() => {
            let (Some(Cbor::Int(alg)), Some(Cbor::Bytes(signature))) = (stmt.text_key("alg"), stmt.text_key("sig")) else {
                return Err(bad("the evidence's attestation is malformed"));
            };
            if *alg != key.alg() || !key.verify(&signed, signature) {
                return Err(bad("the evidence's self attestation does not verify"));
            }
            Vec::new()
        }
        "packed" => packed_full_verified(stmt, &signed, &aaguid).unwrap_or_default(),
        "tpm" => tpm_verified(stmt, auth_raw, &client_hash, &key, &aaguid).unwrap_or_default(),
        _ => Vec::new(),
    };
    Ok(NewPasskey { id: cred_id, cose: cose_bytes, sign_count: auth.sign_count, aaguid, attestation: Attestation { fmt: shown, chain } })
}

/// `navigator.credentials.get` by the stored passkey (`cose`, its COSE key bytes, ES256 or RS256), checked: client
/// data, rpIdHash, presence (and verification when required), the signature. Returns the authenticator's sign count.
pub fn verify_assertion(rp_id: &str, origin: &str, challenge: &[u8], cose: &[u8], credential: &Value, require_uv: bool) -> Result<u32, Refusal> {
    let response = response_of(credential)?;
    let client_data = b64_field(response.get("clientDataJSON"), "the client data")?;
    check_client_data(&client_data, "webauthn.get", challenge, origin)?;
    let auth_raw = b64_field(response.get("authenticatorData"), "the authenticator data")?;
    let auth = parse_auth_data(&auth_raw)?;
    check_rp(&auth, rp_id, require_uv)?;
    let signature = b64_field(response.get("signature"), "the signature")?;
    let stored = cbor_decode(cose).map_err(|_| bad("the stored passkey does not read"))?;
    let key = cose_key(&stored)?;
    let mut signed = auth_raw;
    signed.extend_from_slice(&sha256(&client_data));
    if !key.verify(&signed, &signature) {
        return Err(denied("the passkey's signature does not verify"));
    }
    Ok(auth.sign_count)
}

/// A step-up (AC-1 3.6): an assertion with user verification over the challenge bound to one action, target and
/// parameters, by the stored passkey. Returns the authenticator's sign count (the caller checks it went forward).
pub fn verify_stepup_assertion(rp_id: &str, origin: &str, bound_challenge: &[u8; 32], cose: &[u8], credential: &Value) -> Result<u32, Refusal> {
    verify_assertion(rp_id, origin, bound_challenge, cose, credential, true)
}

/// A software authenticator for tests: registration and sign-in answers signed with a fixed P-256 key (or a fresh
/// RSA 2048 key), with `none`, `packed` self or `packed` full attestation (a fixed test root), and the DER helpers
/// the attestation tests build certificates with.
#[cfg(test)]
pub mod testkit {
    use crate::codec::{b64u, sha256};
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::rsa::KeySize;
    use aws_lc_rs::signature::{KeyPair, RsaKeyPair, RSA_PKCS1_SHA256};
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use serde_json::{json, Value};

    fn head(major: u8, n: usize, out: &mut Vec<u8>) {
        let m = major << 5;
        if n < 24 {
            out.push(m | n as u8);
        } else if n < 256 {
            out.extend_from_slice(&[m | 24, n as u8]);
        } else {
            out.push(m | 25);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
    }

    pub fn bytes(b: &[u8], out: &mut Vec<u8>) {
        head(2, b.len(), out);
        out.extend_from_slice(b);
    }

    pub fn text(s: &str, out: &mut Vec<u8>) {
        head(3, s.len(), out);
        out.extend_from_slice(s.as_bytes());
    }

    pub fn int(i: i64, out: &mut Vec<u8>) {
        if i >= 0 {
            head(0, i as usize, out);
        } else {
            head(1, (-1 - i) as usize, out);
        }
    }

    pub fn map(n: usize, out: &mut Vec<u8>) {
        head(5, n, out);
    }

    pub fn array(n: usize, out: &mut Vec<u8>) {
        head(4, n, out);
    }

    /// One DER TLV.
    pub fn der(tag: u8, v: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let n = v.len();
        if n < 0x80 {
            out.push(n as u8);
        } else if n < 0x100 {
            out.extend_from_slice(&[0x81, n as u8]);
        } else {
            out.extend_from_slice(&[0x82, (n >> 8) as u8, n as u8]);
        }
        out.extend_from_slice(v);
        out
    }

    /// An X.509 Name, one attribute per RDN: (OID, string tag, text).
    pub fn x509_name(attrs: &[(&[u8], u8, &str)]) -> Vec<u8> {
        let rdns: Vec<Vec<u8>> = attrs.iter().map(|(oid, tag, v)| der(0x31, &der(0x30, &[der(0x06, oid), der(*tag, v.as_bytes())].concat()))).collect();
        der(0x30, &rdns.concat())
    }

    /// An X.509 extension.
    pub fn x509_ext(oid: &[u8], critical: bool, value: &[u8]) -> Vec<u8> {
        let mut parts = vec![der(0x06, oid)];
        if critical {
            parts.push(der(0x01, &[0xff]));
        }
        parts.push(der(0x04, value));
        der(0x30, &parts.concat())
    }

    /// The SubjectPublicKeyInfo of a P-256 key.
    pub fn p256_spki(k: &SigningKey) -> Vec<u8> {
        crate::der::p256_spki_der(&crate::der::P256Key::from(k.verifying_key()))
    }

    /// A version 3 certificate signed by `signer` (ECDSA P-256 with SHA-256, deterministic), valid from 2020-01-01 to
    /// 2049-12-31 (`validity` overrides: UTCTime texts).
    pub fn x509_cert(serial: u8, subject: &[u8], issuer: &[u8], spki: &[u8], exts: &[Vec<u8>], signer: &SigningKey, validity: Option<(&str, &str)>) -> Vec<u8> {
        let alg = der(0x30, &der(0x06, super::OID_ECDSA_SHA256));
        let (from, to) = validity.unwrap_or(("200101000000Z", "491231235959Z"));
        let validity = der(0x30, &[der(0x17, from.as_bytes()), der(0x17, to.as_bytes())].concat());
        let mut parts = vec![der(0xa0, &der(0x02, &[2])), der(0x02, &[serial]), alg.clone(), issuer.to_vec(), validity, subject.to_vec(), spki.to_vec()];
        if !exts.is_empty() {
            parts.push(der(0xa3, &der(0x30, &exts.concat())));
        }
        let tbs = der(0x30, &parts.concat());
        let sig: Signature = signer.sign(&tbs);
        der(0x30, &[tbs, alg, der(0x03, &[&[0u8][..], sig.to_der().as_bytes()].concat())].concat())
    }

    const ROOT_SEED: u8 = 0x52;
    const LEAF_SEED: u8 = 0x4c;

    /// The test root's subject name.
    pub fn root_name() -> Vec<u8> {
        x509_name(&[(super::OID_CN, 0x0c, "Lucid Test Attestation Root")])
    }

    /// The test root's key (fixed).
    pub fn test_root_key() -> SigningKey {
        SigningKey::from_slice(&[ROOT_SEED; 32]).expect("a valid scalar")
    }

    /// The fixed test attestation root (P-256, self-signed, a CA) that `register_full` chains to.
    pub fn test_root_der() -> Vec<u8> {
        let k = test_root_key();
        let bc = x509_ext(&[0x55, 0x1d, 0x13], true, &der(0x30, &der(0x01, &[0xff])));
        x509_cert(1, &root_name(), &root_name(), &p256_spki(&k), &[bc], &k, None)
    }

    /// The attestation leaf `register_full` uses: the WebAuthn 8.2.1 subject, not a CA, the AAGUID extension naming
    /// `aaguid`, issued by `test_root_der`.
    pub fn test_leaf_der(aaguid: &[u8; 16]) -> Vec<u8> {
        let root = test_root_key();
        let leaf = SigningKey::from_slice(&[LEAF_SEED; 32]).expect("a valid scalar");
        let subject = x509_name(&[
            (super::OID_C, 0x13, "US"),
            (super::OID_O, 0x0c, "Lucid Test"),
            (super::OID_OU, 0x0c, "Authenticator Attestation"),
            (super::OID_CN, 0x0c, "Lucid Test Security Key"),
        ]);
        let bc = x509_ext(&[0x55, 0x1d, 0x13], true, &der(0x30, &[]));
        let id = x509_ext(super::OID_FIDO_AAGUID, false, &der(0x04, aaguid));
        x509_cert(2, &subject, &root_name(), &p256_spki(&leaf), &[bc, id], &root, None)
    }

    /// The modulus and exponent (no leading zeros) of an RSAPublicKey DER.
    pub fn rsa_parts(der_key: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let seq = crate::der::tlv(der_key).expect("an RSAPublicKey");
        let n = crate::der::tlv(seq.value).expect("n");
        let e = crate::der::tlv(n.rest).expect("e");
        (super::strip_zeros(n.value).to_vec(), super::strip_zeros(e.value).to_vec())
    }

    /// The attestation statement a registration answer carries.
    enum Stmt {
        None,
        SelfPacked,
        /// `packed` with `x5c`: the leaf names `cert_aaguid` in its AAGUID extension.
        Full { cert_aaguid: [u8; 16] },
    }

    pub struct Authenticator {
        pub key: SigningKey,
        pub id: Vec<u8>,
        pub count: u32,
        /// An RS256 credential key used instead of `key` (`new_rs256`).
        pub rsa: Option<RsaKeyPair>,
    }

    impl Authenticator {
        pub fn new(seed: u8) -> Authenticator {
            let key = SigningKey::from_slice(&[seed; 32]).expect("a valid scalar");
            Authenticator { key, id: vec![seed; 32], count: 0, rsa: None }
        }

        /// An authenticator whose credential key is RS256: a fresh RSA 2048 key made by AWS-LC.
        pub fn new_rs256(seed: u8) -> Authenticator {
            let mut a = Authenticator::new(seed);
            a.rsa = Some(RsaKeyPair::generate(KeySize::Rsa2048).expect("an RSA key"));
            a
        }

        fn alg(&self) -> i64 {
            if self.rsa.is_some() {
                -257
            } else {
                -7
            }
        }

        pub fn cose(&self) -> Vec<u8> {
            if let Some(rsa) = &self.rsa {
                let (n, e) = rsa_parts(rsa.public_key().as_ref());
                let mut c = Vec::new();
                map(4, &mut c);
                int(1, &mut c);
                int(3, &mut c);
                int(3, &mut c);
                int(-257, &mut c);
                int(-1, &mut c);
                bytes(&n, &mut c);
                int(-2, &mut c);
                bytes(&e, &mut c);
                return c;
            }
            let point = self.key.verifying_key().as_affine().to_encoded_point(false);
            let mut c = Vec::new();
            map(5, &mut c);
            int(1, &mut c);
            int(2, &mut c);
            int(3, &mut c);
            int(-7, &mut c);
            int(-1, &mut c);
            int(1, &mut c);
            int(-2, &mut c);
            bytes(point.x().expect("x"), &mut c);
            int(-3, &mut c);
            bytes(point.y().expect("y"), &mut c);
            c
        }

        fn sign(&self, auth: &[u8], client_data: &[u8]) -> Vec<u8> {
            let mut signed = auth.to_vec();
            signed.extend_from_slice(&sha256(client_data));
            if let Some(rsa) = &self.rsa {
                let mut out = vec![0u8; rsa.public_modulus_len()];
                rsa.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), &signed, &mut out).expect("an RSA signature");
                return out;
            }
            let sig: Signature = self.key.sign(&signed);
            sig.to_der().as_bytes().to_vec()
        }

        fn client_data(kind: &str, challenge: &[u8], origin: &str) -> Vec<u8> {
            json!({ "type": kind, "challenge": b64u(challenge), "origin": origin, "crossOrigin": false }).to_string().into_bytes()
        }

        /// `navigator.credentials.create`'s answer for a passkey the device keeps (`credProps.rk` true); `packed` adds a
        /// self attestation.
        pub fn register(&mut self, rp_id: &str, origin: &str, challenge: &[u8], packed: bool) -> Value {
            self.register_rk(rp_id, origin, challenge, packed, Some(true))
        }

        /// `register` with the `credProps.rk` the browser reports (None: no extension results).
        pub fn register_rk(&mut self, rp_id: &str, origin: &str, challenge: &[u8], packed: bool, rk: Option<bool>) -> Value {
            let stmt = if packed { Stmt::SelfPacked } else { Stmt::None };
            self.make(rp_id, origin, challenge, stmt, [0u8; 16], rk)
        }

        /// A registration with a `packed` full attestation: `x5c` [`test_leaf_der(aaguid)`], issued by
        /// `test_root_der()`, ES256 by the leaf's key over authenticatorData || clientDataHash; `aaguid` in the
        /// authenticator data and in the leaf's AAGUID extension.
        pub fn register_full(&mut self, rp_id: &str, origin: &str, challenge: &[u8], aaguid: [u8; 16], rk: Option<bool>) -> Value {
            self.make(rp_id, origin, challenge, Stmt::Full { cert_aaguid: aaguid }, aaguid, rk)
        }

        /// `register_full` whose leaf names `cert_aaguid` while the authenticator data names `aaguid`.
        pub fn register_full_as(&mut self, rp_id: &str, origin: &str, challenge: &[u8], aaguid: [u8; 16], cert_aaguid: [u8; 16]) -> Value {
            self.make(rp_id, origin, challenge, Stmt::Full { cert_aaguid }, aaguid, Some(true))
        }

        fn make(&mut self, rp_id: &str, origin: &str, challenge: &[u8], stmt: Stmt, aaguid: [u8; 16], rk: Option<bool>) -> Value {
            let client_data = Self::client_data("webauthn.create", challenge, origin);
            let mut auth = sha256(rp_id.as_bytes()).to_vec();
            auth.push(0x45); // UP, UV, AT
            auth.extend_from_slice(&self.count.to_be_bytes());
            auth.extend_from_slice(&aaguid);
            auth.extend_from_slice(&(self.id.len() as u16).to_be_bytes());
            auth.extend_from_slice(&self.id);
            auth.extend_from_slice(&self.cose());
            let mut att = Vec::new();
            map(3, &mut att);
            text("fmt", &mut att);
            text(if matches!(stmt, Stmt::None) { "none" } else { "packed" }, &mut att);
            text("attStmt", &mut att);
            match stmt {
                Stmt::None => map(0, &mut att),
                Stmt::SelfPacked => {
                    map(2, &mut att);
                    text("alg", &mut att);
                    int(self.alg(), &mut att);
                    text("sig", &mut att);
                    bytes(&self.sign(&auth, &client_data), &mut att);
                }
                Stmt::Full { cert_aaguid } => {
                    let leaf = SigningKey::from_slice(&[LEAF_SEED; 32]).expect("a valid scalar");
                    let mut signed = auth.clone();
                    signed.extend_from_slice(&sha256(&client_data));
                    let sig: Signature = leaf.sign(&signed);
                    map(3, &mut att);
                    text("alg", &mut att);
                    int(-7, &mut att);
                    text("sig", &mut att);
                    bytes(sig.to_der().as_bytes(), &mut att);
                    text("x5c", &mut att);
                    array(1, &mut att);
                    bytes(&test_leaf_der(&cert_aaguid), &mut att);
                }
            }
            text("authData", &mut att);
            bytes(&auth, &mut att);
            let mut v = json!({
                "id": b64u(&self.id), "rawId": b64u(&self.id), "type": "public-key",
                "response": { "clientDataJSON": b64u(&client_data), "attestationObject": b64u(&att) },
            });
            if let Some(rk) = rk {
                v["clientExtensionResults"] = json!({ "credProps": { "rk": rk } });
            }
            v
        }

        /// `navigator.credentials.get`'s answer, the sign count one higher.
        pub fn assert(&mut self, rp_id: &str, origin: &str, challenge: &[u8], handle: Option<&str>) -> Value {
            self.count += 1;
            let client_data = Self::client_data("webauthn.get", challenge, origin);
            let mut auth = sha256(rp_id.as_bytes()).to_vec();
            auth.push(0x05); // UP, UV
            auth.extend_from_slice(&self.count.to_be_bytes());
            let sig = self.sign(&auth, &client_data);
            json!({
                "id": b64u(&self.id), "rawId": b64u(&self.id), "type": "public-key",
                "response": {
                    "clientDataJSON": b64u(&client_data), "authenticatorData": b64u(&auth),
                    "signature": b64u(&sig), "userHandle": handle,
                },
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::Authenticator;
    use super::*;
    use crate::codec::b64u;
    use serde_json::json;

    const ORIGIN: &str = "http://localhost:5000";

    fn unb(s: &str) -> Vec<u8> {
        unb64u(s).expect("base64url")
    }

    // py_webauthn tests/test_verify_registration_response.py, test_verifies_none_attestation_response.
    fn registration_vector() -> (Value, Vec<u8>) {
        let credential = json!({
            "id": "9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w",
            "rawId": "9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w",
            "response": {
                "attestationObject": "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVjESZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAFwAAAAAAAAAAAAAAAAAAAAAAQPctcQPE5oNRRJk_nO_371mf7qE7qIodzr0eOf6ACvnMB1oQG165dqutoi1U44shGezu5_gkTjmOPeJO0N8a7P-lAQIDJiABIVggSFbUJF-42Ug3pdM8rDRFu_N5oiVEysPDB6n66r_7dZAiWCDUVnB39FlGypL-qAoIO9xWHtJygo2jfDmHl-_eKFRLDA",
                "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiVHdON240V1R5R0tMYzRaWS1xR3NGcUtuSE00bmdscXN5VjBJQ0psTjJUTzlYaVJ5RnRya2FEd1V2c3FsLWdrTEpYUDZmbkYxTWxyWjUzTW00UjdDdnciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9"
            },
            "type": "public-key"
        });
        (credential, unb("TwN7n4WTyGKLc4ZY-qGsFqKnHM4nglqsyV0ICJlN2TO9XiRyFtrkaDwUvsql-gkLJXP6fnF1MlrZ53Mm4R7Cvw"))
    }

    // py_webauthn tests/test_verify_authentication_response.py, test_verify_authentication_response_with_EC2_public_key.
    fn assertion_vector() -> (Value, Vec<u8>, Vec<u8>) {
        let credential = json!({
            "id": "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
            "rawId": "EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q",
            "response": {
                "authenticatorData": "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAATg",
                "clientDataJSON": "eyJjaGFsbGVuZ2UiOiJ4aTMwR1BHQUZZUnhWRHBZMXNNMTBEYUx6VlFHNjZudi1fN1JVYXpIMHZJMll2RzhMWWdERW52TjVmWlpOVnV2RUR1TWk5dGUzVkxxYjQyTjBma0xHQSIsImNsaWVudEV4dGVuc2lvbnMiOnt9LCJoYXNoQWxnb3JpdGhtIjoiU0hBLTI1NiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTAwMCIsInR5cGUiOiJ3ZWJhdXRobi5nZXQifQ",
                "signature": "MEUCIGisVZOBapCWbnJJvjelIzwpixxIwkjCCb5aCHafQu68AiEA88v-2pJNNApPFwAKFiNuf82-2hBxYW5kGwVweeoxCwo"
            },
            "type": "public-key"
        });
        let challenge = unb("xi30GPGAFYRxVDpY1sM10DaLzVQG66nv-_7RUazH0vI2YvG8LYgDEnvN5fZZNVuvEDuMi9te3VLqb42N0fkLGA");
        let cose = unb("pQECAyYgASFYIIeDTe-gN8A-zQclHoRnGFWN8ehM1b7yAsa8I8KIvmplIlgg4nFGT5px8o6gpPZZhO01wdy9crDSA_Ngtkx0vGpvPHI");
        (credential, challenge, cose)
    }

    #[test]
    fn registration_vector_verifies() {
        let (credential, challenge) = registration_vector();
        let p = verify_registration("localhost", ORIGIN, &challenge, &credential, true).expect("the vector verifies");
        assert_eq!(b64u(&p.id), "9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w");
        assert_eq!(p.sign_count, 23);
        assert!(cose_es256(&cbor_decode(&p.cose).unwrap()).is_ok());
    }

    #[test]
    fn registration_vector_refused_for_another_site_or_challenge() {
        let (credential, challenge) = registration_vector();
        let e = verify_registration("localhost", "https://relay.example", &challenge, &credential, false).unwrap_err();
        assert_eq!(e.status, 403);
        let e = verify_registration("relay.example", ORIGIN, &challenge, &credential, false).unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (403, "the passkey belongs to another website"));
        let e = verify_registration("localhost", ORIGIN, &[0u8; 64], &credential, false).unwrap_err();
        assert_eq!(e.status, 400);
        let mut other = credential.clone();
        other["rawId"] = json!(b64u(&[1u8; 64]));
        assert!(verify_registration("localhost", ORIGIN, &challenge, &other, false).unwrap_err().message.contains("does not match"));
    }

    #[test]
    fn assertion_vector_verifies() {
        let (credential, challenge, cose) = assertion_vector();
        assert_eq!(verify_assertion("localhost", ORIGIN, &challenge, &cose, &credential, false), Ok(78));
        // This authenticator did not verify the user: refused where verification is required.
        let e = verify_assertion("localhost", ORIGIN, &challenge, &cose, &credential, true).unwrap_err();
        assert_eq!(e.status, 403);
    }

    #[test]
    fn assertion_vector_refusals() {
        let (credential, challenge, cose) = assertion_vector();
        let mut challenge2 = challenge.clone();
        challenge2[0] ^= 1;
        assert_eq!(verify_assertion("localhost", ORIGIN, &challenge2, &cose, &credential, false).unwrap_err().status, 400);
        assert_eq!(verify_assertion("localhost", "https://localhost", &challenge, &cose, &credential, false).unwrap_err().status, 403);
        let mut tampered = credential.clone();
        let mut auth = unb(tampered["response"]["authenticatorData"].as_str().unwrap());
        auth[36] ^= 1; // the sign count
        tampered["response"]["authenticatorData"] = json!(b64u(&auth));
        let e = verify_assertion("localhost", ORIGIN, &challenge, &cose, &tampered, false).unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (403, "the passkey's signature does not verify"));
        // Another key: the registration vector's.
        let (reg, reg_challenge) = registration_vector();
        let other = verify_registration("localhost", ORIGIN, &reg_challenge, &reg, false).unwrap();
        assert_eq!(verify_assertion("localhost", ORIGIN, &challenge, &other.cose, &credential, false).unwrap_err().status, 403);
    }

    #[test]
    fn software_authenticator_round_trip() {
        let mut a = Authenticator::new(7);
        let ch = [9u8; 32];
        for packed in [false, true] {
            let reg = a.register("relay.example", "https://relay.example", &ch, packed);
            let p = verify_registration("relay.example", "https://relay.example", &ch, &reg, true).expect("registers");
            assert_eq!(p.id, a.id);
            let got = a.assert("relay.example", "https://relay.example", &ch, None);
            assert_eq!(verify_assertion("relay.example", "https://relay.example", &ch, &p.cose, &got, true), Ok(a.count));
        }
    }

    #[test]
    fn rsa_and_other_algorithms_are_refused() {
        // py_webauthn's RS256 credential public key.
        let rsa = unb("pAEDAzkBACBZAQDfV20epzvQP-HtcdDpX-cGzdOxy73WQEvsU7Dnr9UWJophEfpngouvgnRLXaEUn_d8HGkp_HIx8rrpkx4BVs6X_B6ZjhLlezjIdJbLbVeb92BaEsmNn1HW2N9Xj2QM8cH-yx28_vCjf82ahQ9gyAr552Bn96G22n8jqFRQKdVpO-f-bvpvaP3IQ9F5LCX7CUaxptgbog1SFO6FI6ob5SlVVB00lVXsaYg8cIDZxCkkENkGiFPgwEaZ7995SCbiyCpUJbMqToLMgojPkAhWeyktu7TlK6UBWdJMHc3FPAIs0lH_2_2hKS-mGI1uZAFVAfW1X-mzKL0czUm2P1UlUox7IUMBAAE");
        let e = cose_es256(&cbor_decode(&rsa).unwrap()).unwrap_err();
        assert!(e.message.contains("ES256 only"));
    }

    #[test]
    fn cbor_refuses_what_it_does_not_read() {
        assert_eq!(cbor_decode(&[0xa1, 0x01, 0x02]), Ok(Cbor::Map(vec![(Cbor::Int(1), Cbor::Int(2))])));
        assert_eq!(cbor_decode(&[0x20]), Ok(Cbor::Int(-1)));
        assert!(cbor_decode(&[0xa2, 0x01, 0x02, 0x01, 0x03]).is_err()); // a repeated key
        assert!(cbor_decode(&[0x5f]).is_err()); // indefinite length
        assert!(cbor_decode(&[0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).is_err()); // a huge count
        assert!(cbor_decode(&[0x01, 0x02]).is_err()); // trailing bytes
        assert!(cbor_decode(&[0xf9, 0x00, 0x00]).is_err()); // a float
        let mut deep = vec![0x81u8; 40];
        deep.push(0x01);
        assert!(cbor_decode(&deep).is_err());
    }

    const RP: &str = "relay.example";
    const SITE: &str = "https://relay.example";

    #[test]
    fn pub_key_params_name_es256_then_rs256() {
        assert_eq!(pub_key_params(), json!([{ "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 }]));
    }

    #[test]
    fn rs256_registers_and_signs_in() {
        let mut a = Authenticator::new_rs256(21);
        let ch = [4u8; 32];
        for packed in [false, true] {
            let reg = a.register(RP, SITE, &ch, packed);
            let p = verify_registration(RP, SITE, &ch, &reg, true).expect("registers");
            assert!(matches!(cose_key(&cbor_decode(&p.cose).unwrap()).unwrap(), CredKey::Rs256 { .. }));
            assert_eq!(p.attestation, Attestation { fmt: if packed { "packed" } else { "none" }.into(), chain: Vec::new() });
            let got = a.assert(RP, SITE, &ch, None);
            assert_eq!(verify_assertion(RP, SITE, &ch, &p.cose, &got, true), Ok(a.count));
            assert_eq!(verify_stepup_assertion(RP, SITE, &ch, &p.cose, &got), Ok(a.count));
            let mut tampered = got.clone();
            let mut s = unb(tampered["response"]["signature"].as_str().unwrap());
            s[10] ^= 1;
            tampered["response"]["signature"] = json!(b64u(&s));
            let e = verify_assertion(RP, SITE, &ch, &p.cose, &tampered, true).unwrap_err();
            assert_eq!((e.status, e.message.as_str()), (403, "the passkey's signature does not verify"));
        }
        // The stored key decides: an ES256 passkey's key never takes an RS256 signature, and the other way round.
        let mut e = Authenticator::new(22);
        let es = verify_registration(RP, SITE, &ch, &e.register(RP, SITE, &ch, false), true).unwrap();
        let rs = verify_registration(RP, SITE, &ch, &a.register(RP, SITE, &ch, false), true).unwrap();
        assert_eq!(verify_assertion(RP, SITE, &ch, &es.cose, &a.assert(RP, SITE, &ch, None), true).unwrap_err().status, 403);
        assert_eq!(verify_assertion(RP, SITE, &ch, &rs.cose, &e.assert(RP, SITE, &ch, None), true).unwrap_err().status, 403);
    }

    #[test]
    fn rsa_keys_are_taken_from_2048_to_8192_bits() {
        // py_webauthn's RS256 credential public key (2048 bits).
        let rsa = unb("pAEDAzkBACBZAQDfV20epzvQP-HtcdDpX-cGzdOxy73WQEvsU7Dnr9UWJophEfpngouvgnRLXaEUn_d8HGkp_HIx8rrpkx4BVs6X_B6ZjhLlezjIdJbLbVeb92BaEsmNn1HW2N9Xj2QM8cH-yx28_vCjf82ahQ9gyAr552Bn96G22n8jqFRQKdVpO-f-bvpvaP3IQ9F5LCX7CUaxptgbog1SFO6FI6ob5SlVVB00lVXsaYg8cIDZxCkkENkGiFPgwEaZ7995SCbiyCpUJbMqToLMgojPkAhWeyktu7TlK6UBWdJMHc3FPAIs0lH_2_2hKS-mGI1uZAFVAfW1X-mzKL0czUm2P1UlUox7IUMBAAE");
        let key = cose_key(&cbor_decode(&rsa).unwrap()).expect("a 2048-bit RS256 key");
        assert_eq!(key.alg(), RS256);
        // 1024 bits: refused.
        let mut short = Vec::new();
        testkit::map(4, &mut short);
        testkit::int(1, &mut short);
        testkit::int(3, &mut short);
        testkit::int(3, &mut short);
        testkit::int(-257, &mut short);
        testkit::int(-1, &mut short);
        testkit::bytes(&[0xc5u8; 128], &mut short);
        testkit::int(-2, &mut short);
        testkit::bytes(&[1, 0, 1], &mut short);
        let e = cose_key(&cbor_decode(&short).unwrap()).unwrap_err();
        assert_eq!(e.message, "the passkey's RSA key must have 2048 to 8192 bits");
        // Another algorithm: refused with the words naming both.
        let mut ed = Vec::new();
        testkit::map(1, &mut ed);
        testkit::int(3, &mut ed);
        testkit::int(-8, &mut ed);
        assert!(cose_key(&cbor_decode(&ed).unwrap()).unwrap_err().message.contains("ES256 or RS256 only"));
    }

    #[test]
    fn packed_full_keeps_its_chain_and_a_failing_one_is_unattested_not_refused() {
        let aaguid = [0x11u8; 16];
        let mut a = Authenticator::new(23);
        let ch = [5u8; 32];
        let p = verify_registration(RP, SITE, &ch, &a.register_full(RP, SITE, &ch, aaguid, Some(true)), true).expect("registers");
        assert_eq!(p.aaguid, aaguid);
        assert_eq!(p.attestation, Attestation { fmt: "packed".into(), chain: vec![testkit::test_leaf_der(&aaguid)] });
        let leaf = x509(&p.attestation.chain[0]).unwrap();
        let root = x509(&testkit::test_root_der()).unwrap();
        assert!(leaf.v3 && leaf.fips_signature() && leaf.cert.issued_by(&root.cert) && root.cert.ca && !leaf.cert.ca);
        // The leaf names another AAGUID: registered, unattested.
        let p = verify_registration(RP, SITE, &ch, &a.register_full_as(RP, SITE, &ch, aaguid, [0x22u8; 16]), true).expect("registers");
        assert_eq!(p.attestation, Attestation { fmt: "packed".into(), chain: Vec::new() });
        // Another format: registered, unattested.
        let none = a.register(RP, SITE, &ch, false);
        let att = cbor_decode(&unb(none["response"]["attestationObject"].as_str().unwrap())).unwrap();
        let Some(Cbor::Bytes(auth)) = att.text_key("authData") else { panic!("authData") };
        let mut other = Vec::new();
        testkit::map(3, &mut other);
        testkit::text("fmt", &mut other);
        testkit::text("android-key", &mut other);
        testkit::text("attStmt", &mut other);
        testkit::map(0, &mut other);
        testkit::text("authData", &mut other);
        testkit::bytes(auth, &mut other);
        let mut reg = none.clone();
        reg["response"]["attestationObject"] = json!(b64u(&other));
        let p = verify_registration(RP, SITE, &ch, &reg, true).expect("registers");
        assert_eq!(p.attestation, Attestation { fmt: "android-key".into(), chain: Vec::new() });
    }

    /// A `tpm` registration of `a`'s ES256 key with an AIK issued by the test root; `key_of` names the key the
    /// `pubArea` carries, `break_name` changes one byte of the attested name.
    fn tpm_registration(a: &Authenticator, key_of: &Authenticator, ch: &[u8], aaguid: [u8; 16], break_name: bool) -> Value {
        use p256::ecdsa::signature::Signer;
        use super::testkit::{bytes, der, int, map, text, x509_cert, x509_ext, x509_name};
        let client_data = json!({ "type": "webauthn.create", "challenge": b64u(ch), "origin": SITE, "crossOrigin": false }).to_string().into_bytes();
        let mut auth = sha256(RP.as_bytes()).to_vec();
        auth.push(0x45);
        auth.extend_from_slice(&0u32.to_be_bytes());
        auth.extend_from_slice(&aaguid);
        auth.extend_from_slice(&(a.id.len() as u16).to_be_bytes());
        auth.extend_from_slice(&a.id);
        auth.extend_from_slice(&a.cose());
        let point = *P256Key::from(key_of.key.verifying_key()).point();
        let mut pub_area = Vec::new();
        for v in [TPM_ALG_ECC, TPM_ALG_SHA256] {
            pub_area.extend_from_slice(&v.to_be_bytes());
        }
        pub_area.extend_from_slice(&0x0006_0472u32.to_be_bytes());
        for v in [0u16, TPM_ALG_NULL, TPM_ALG_NULL, TPM_ECC_NIST_P256, TPM_ALG_NULL, 32] {
            pub_area.extend_from_slice(&v.to_be_bytes());
        }
        pub_area.extend_from_slice(&point[1..33]);
        pub_area.extend_from_slice(&32u16.to_be_bytes());
        pub_area.extend_from_slice(&point[33..65]);
        let mut to_sign = auth.clone();
        to_sign.extend_from_slice(&sha256(&client_data));
        let mut name = TPM_ALG_SHA256.to_be_bytes().to_vec();
        name.extend_from_slice(&sha256(&pub_area));
        if break_name {
            name[5] ^= 1;
        }
        let mut info = Vec::new();
        info.extend_from_slice(&TPM_GENERATED_VALUE.to_be_bytes());
        info.extend_from_slice(&TPM_ST_ATTEST_CERTIFY.to_be_bytes());
        info.extend_from_slice(&0u16.to_be_bytes());
        info.extend_from_slice(&32u16.to_be_bytes());
        info.extend_from_slice(&sha256(&to_sign));
        info.extend_from_slice(&[0u8; 25]);
        info.extend_from_slice(&(name.len() as u16).to_be_bytes());
        info.extend_from_slice(&name);
        info.extend_from_slice(&0u16.to_be_bytes());
        let aik = p256::ecdsa::SigningKey::from_slice(&[0x41u8; 32]).unwrap();
        let tpm_name = x509_name(&[(&[0x67u8, 0x81, 0x05, 0x02, 0x01][..], 0x0c, "id:FFFFF1D0")]);
        let san = x509_ext(OID_SAN, true, &der(0x30, &der(0xa4, &tpm_name)));
        let eku = x509_ext(OID_EKU, false, &der(0x30, &der(0x06, OID_TCG_AIK)));
        let bc = x509_ext(&[0x55, 0x1d, 0x13], true, &der(0x30, &[]));
        let aik_der = x509_cert(3, &der(0x30, &[]), &testkit::root_name(), &testkit::p256_spki(&aik), &[san, eku, bc], &testkit::test_root_key(), None);
        let signature: p256::ecdsa::Signature = aik.sign(&info);
        let mut att = Vec::new();
        map(3, &mut att);
        text("fmt", &mut att);
        text("tpm", &mut att);
        text("attStmt", &mut att);
        map(6, &mut att);
        text("ver", &mut att);
        text("2.0", &mut att);
        text("alg", &mut att);
        int(-7, &mut att);
        text("x5c", &mut att);
        testkit::array(1, &mut att);
        bytes(&aik_der, &mut att);
        text("sig", &mut att);
        bytes(signature.to_der().as_bytes(), &mut att);
        text("certInfo", &mut att);
        bytes(&info, &mut att);
        text("pubArea", &mut att);
        bytes(&pub_area, &mut att);
        text("authData", &mut att);
        bytes(&auth, &mut att);
        json!({
            "id": b64u(&a.id), "rawId": b64u(&a.id), "type": "public-key",
            "response": { "clientDataJSON": b64u(&client_data), "attestationObject": b64u(&att) },
        })
    }

    #[test]
    fn tpm_checks_pub_area_cert_info_and_the_aik() {
        let aaguid = [0x33u8; 16];
        let a = Authenticator::new(24);
        let ch = [6u8; 32];
        let p = verify_registration(RP, SITE, &ch, &tpm_registration(&a, &a, &ch, aaguid, false), true).expect("registers");
        assert_eq!(p.attestation.fmt, "tpm");
        assert_eq!(p.attestation.chain.len(), 1);
        let aik = x509(&p.attestation.chain[0]).unwrap();
        assert!(aik.cert.issued_by(&x509(&testkit::test_root_der()).unwrap().cert));
        // A wrong attested name, or a pubArea naming another key: registered, unattested.
        let p = verify_registration(RP, SITE, &ch, &tpm_registration(&a, &a, &ch, aaguid, true), true).expect("registers");
        assert!(p.attestation.chain.is_empty());
        let p = verify_registration(RP, SITE, &ch, &tpm_registration(&a, &Authenticator::new(25), &ch, aaguid, false), true).expect("registers");
        assert!(p.attestation.chain.is_empty());
    }

    #[test]
    fn no_dashes_in_words() {
        let words = [
            "the passkey's RSA key must have 2048 to 8192 bits",
            "this passkey uses an algorithm the control panel does not accept (ES256 or RS256 only)",
            "the passkey's self attestation does not verify",
        ];
        for w in words {
            assert!(!w.contains('\u{2014}') && !w.contains('\u{2013}'));
        }
    }
}
