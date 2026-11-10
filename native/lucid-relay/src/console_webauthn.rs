// Passkeys for the control panel (ADR-A094): WebAuthn level 2 registration and sign-in checked as the Meeting Hub
// console checks them (console/meet_console_web.py), ES256 only. The client data (type, challenge, origin, never
// cross-origin), the rpIdHash, user presence and, when asked, user verification; at registration the attested
// credential and an attestation of `none` or `packed` self attestation; at sign-in the signature over
// authenticatorData || SHA-256(clientDataJSON) with the stored key. A small CBOR reader for what WebAuthn sends.

use crate::codec::{parse_json, sha256, str_of, unb64u};
use crate::der::ecdsa_verify;
use p256::ecdsa::VerifyingKey;
use serde_json::Value;

/// COSE algorithm ES256 (ECDSA P-256 with SHA-256).
pub const ES256: i128 = -7;
const CBOR_DEPTH: usize = 16;
const FIELD_MAX: usize = 64 * 1024;

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

/// Authenticator data: rpIdHash, the UP and UV flags, signCount and, with AT, the attested credential (its id, its
/// COSE key and the key's raw bytes).
pub struct AuthData {
    pub rp_hash: [u8; 32],
    pub up: bool,
    pub uv: bool,
    pub sign_count: u32,
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
    if flags & 0x40 != 0 {
        if d.len() < pos + 18 {
            return Err(bad("the authenticator data is too short"));
        }
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
    Ok(AuthData { rp_hash, up: flags & 0x01 != 0, uv: flags & 0x04 != 0, sign_count, credential })
}

/// The P-256 key of a COSE EC2 key with alg ES256; anything else is refused.
pub fn cose_es256(cose: &Cbor) -> Result<VerifyingKey, Refusal> {
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
    VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| bad("the passkey's public key is not a valid P-256 point"))
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

/// A passkey just registered: its id, its COSE key bytes and the authenticator's sign count.
#[derive(Debug)]
pub struct NewPasskey {
    pub id: Vec<u8>,
    pub cose: Vec<u8>,
    pub sign_count: u32,
}

/// `navigator.credentials.create`, checked: client data, rpIdHash, presence (and verification when required), the
/// attested credential and its ES256 key, the attestation (`none`, or `packed` self attestation).
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
    let Some((cred_id, cose, cose_bytes)) = auth.credential else { return Err(bad("the passkey sent no credential")) };
    if !same_bytes(&cred_id, &raw_id) {
        return Err(bad("the passkey id does not match its credential"));
    }
    let key = cose_es256(&cose)?;
    match fmt.as_str() {
        "none" => {
            if *stmt != Cbor::Map(Vec::new()) {
                return Err(bad("the passkey's attestation is malformed"));
            }
        }
        "packed" => {
            if stmt.text_key("x5c").is_some() {
                return Err(bad("attestation certificates are not taken: create the passkey again (the panel asks for none)"));
            }
            let (Some(Cbor::Int(alg)), Some(Cbor::Bytes(sig))) = (stmt.text_key("alg"), stmt.text_key("sig")) else {
                return Err(bad("the passkey's attestation is malformed"));
            };
            let mut signed = auth_raw.clone();
            signed.extend_from_slice(&sha256(&client_data));
            if *alg != ES256 || !ecdsa_verify(&key, &signed, sig) {
                return Err(bad("the passkey's self attestation does not verify"));
            }
        }
        other => {
            let shown: String = other.chars().take(20).collect();
            return Err(bad(&format!("this passkey's attestation ({shown}) is not supported")));
        }
    }
    Ok(NewPasskey { id: cred_id, cose: cose_bytes, sign_count: auth.sign_count })
}

/// `navigator.credentials.get` by the stored passkey (`cose`, its COSE key bytes), checked: client data, rpIdHash,
/// presence (and verification when required), the signature. Returns the authenticator's sign count.
pub fn verify_assertion(rp_id: &str, origin: &str, challenge: &[u8], cose: &[u8], credential: &Value, require_uv: bool) -> Result<u32, Refusal> {
    let response = response_of(credential)?;
    let client_data = b64_field(response.get("clientDataJSON"), "the client data")?;
    check_client_data(&client_data, "webauthn.get", challenge, origin)?;
    let auth_raw = b64_field(response.get("authenticatorData"), "the authenticator data")?;
    let auth = parse_auth_data(&auth_raw)?;
    check_rp(&auth, rp_id, require_uv)?;
    let signature = b64_field(response.get("signature"), "the signature")?;
    let stored = cbor_decode(cose).map_err(|_| bad("the stored passkey does not read"))?;
    let key = cose_es256(&stored)?;
    let mut signed = auth_raw;
    signed.extend_from_slice(&sha256(&client_data));
    if !ecdsa_verify(&key, &signed, &signature) {
        return Err(denied("the passkey's signature does not verify"));
    }
    Ok(auth.sign_count)
}

/// A software authenticator for tests: registration and sign-in answers signed with a fixed P-256 key.
#[cfg(test)]
pub mod testkit {
    use crate::codec::{b64u, sha256};
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

    pub struct Authenticator {
        pub key: SigningKey,
        pub id: Vec<u8>,
        pub count: u32,
    }

    impl Authenticator {
        pub fn new(seed: u8) -> Authenticator {
            let key = SigningKey::from_slice(&[seed; 32]).expect("a valid scalar");
            Authenticator { key, id: vec![seed; 32], count: 0 }
        }

        pub fn cose(&self) -> Vec<u8> {
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
            let sig: Signature = self.key.sign(&signed);
            sig.to_der().as_bytes().to_vec()
        }

        fn client_data(kind: &str, challenge: &[u8], origin: &str) -> Vec<u8> {
            json!({ "type": kind, "challenge": b64u(challenge), "origin": origin, "crossOrigin": false }).to_string().into_bytes()
        }

        /// `navigator.credentials.create`'s answer; `packed` adds a self attestation.
        pub fn register(&mut self, rp_id: &str, origin: &str, challenge: &[u8], packed: bool) -> Value {
            let client_data = Self::client_data("webauthn.create", challenge, origin);
            let mut auth = sha256(rp_id.as_bytes()).to_vec();
            auth.push(0x45); // UP, UV, AT
            auth.extend_from_slice(&self.count.to_be_bytes());
            auth.extend_from_slice(&[0u8; 16]);
            auth.extend_from_slice(&(self.id.len() as u16).to_be_bytes());
            auth.extend_from_slice(&self.id);
            auth.extend_from_slice(&self.cose());
            let mut att = Vec::new();
            map(3, &mut att);
            text("fmt", &mut att);
            text(if packed { "packed" } else { "none" }, &mut att);
            text("attStmt", &mut att);
            if packed {
                map(2, &mut att);
                text("alg", &mut att);
                int(-7, &mut att);
                text("sig", &mut att);
                bytes(&self.sign(&auth, &client_data), &mut att);
            } else {
                map(0, &mut att);
            }
            text("authData", &mut att);
            bytes(&auth, &mut att);
            json!({
                "id": b64u(&self.id), "rawId": b64u(&self.id), "type": "public-key",
                "response": { "clientDataJSON": b64u(&client_data), "attestationObject": b64u(&att) },
            })
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
}
