// Hub presence keys as a verifier reads them, rule for rule from the add-on's src/presence.ts: the certificate
// `presence` key of each kind (ID-1 4.2), the version 2 request presence (`piv` and `fido2` with their provenance
// material), and the provenance checks the root runs before certifying a card or a security key. `piv` and `fido2`
// exist only while their release gates are verified (G-PRES-PIV or G-PRES-FIDO2, each with G-ENGINE); the relay holds
// none (contract 2.12).

use crate::codec::{b64u, exact_keys, sha256, str_of, unb64u};
use crate::console_webauthn::{cbor_decode, cbor_item, Cbor};
use crate::der::{ecdsa_verify, p256_from_spki, parse_spki, PublicKey};
use crate::idp::{is_hex64, is_uuid, LeafRefusal, RS_PASSWORD_BASELINE};
use crate::meet_org_policy::lp;
use crate::x509::{cert_signed_by, has_digital_signature, is_ocsp_response, parse_cert, piv_key_problem, uuid_of, valid_at, verify_crl, verify_ocsp, X509Info};
use serde_json::{Map, Value};

pub const PRESENCE_KINDS: [&str; 5] = ["password", "windows-hello", "macos-secure-enclave", "piv", "fido2"];
/// The fixed RP ID of every presence credential (ID-1 4.2): never a real web origin.
pub const FIDO2_RP_ID: &str = "presence.lucid-spoke.invalid";
/// ES256, the only COSE algorithm a presence credential and its attestation may use.
const FIDO2_ALG: i128 = -7;
const PIV_CERT_MAX: usize = 4096;
const FIDO2_ATTESTATION_MAX: usize = 8192;
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_AT: u8 = 0x40;
const FLAG_ED: u8 = 0x80;

/// The certificate fields of each kind.
fn cert_presence_keys(kind: &str) -> &'static [&'static str] {
    match kind {
        "piv" => &["kind", "spki", "cert_sha256"],
        "fido2" => &["kind", "spki", "credential_id", "rp_id", "aaguid"],
        _ => &["kind", "spki"],
    }
}

fn gate(gates: &[String], name: &str) -> bool {
    gates.iter().any(|g| g == name)
}

/// `piv` needs G-PRES-PIV and G-ENGINE, `fido2` G-PRES-FIDO2 and G-ENGINE; the other kinds are always on.
pub fn presence_kind_enabled(kind: &str, gates: &[String]) -> bool {
    match kind {
        "piv" => gate(gates, "G-PRES-PIV") && gate(gates, "G-ENGINE"),
        "fido2" => gate(gates, "G-PRES-FIDO2") && gate(gates, "G-ENGINE"),
        _ => true,
    }
}

/// The exact words of each presence refusal; `org` is the organization's display name (absent: "this organization",
/// or "Your organization" where it opens the sentence). `n`: the minimum password length.
pub fn presence_words(event: &str, org: Option<&str>, n: Option<i64>) -> String {
    let (name, lead) = (org.unwrap_or("this organization"), org.unwrap_or("Your organization"));
    match event {
        "rs_piv_provenance" => format!("this PIV certificate does not chain to a card issuer {name} trusts (or its key does not match); nothing signed"),
        "rs_piv_status" => "the PIV card's revocation status is revoked, unknown or older than 24 hours; nothing signed".into(),
        "rs_piv_certid" => "the PIV status answer is for a different card; it is not accepted".into(),
        "rs_piv_cert_expired" => "the PIV card's certificate (or its issuer's) is expired or not yet valid; it is not accepted".into(),
        "rs_piv_key_size" => "this PIV card's key is larger than Lucid accepts (RSA 4096 at most); nothing signed".into(),
        "rs_fido2_provenance" => format!("this security key's attestation is missing or not from a model {name} allows; nothing signed"),
        "rs_kind_disabled" => format!("PIV and security key presence are not enabled for {name} yet; nothing signed"),
        "rs_password_short" => format!("{lead} requires a presence password of at least {} characters; nothing changed.", n.unwrap_or(RS_PASSWORD_BASELINE)),
        "rs_presence_kind_refused" => format!(
            "{lead} requires a passwordless presence key (Windows Hello, Touch ID, a PIV card or a security key); this request has a password key. Nothing signed."
        ),
        _ => "This spoke's engine does not know PIV or security key presence yet.".into(),
    }
}

/// Canonical base64url of `min` to `max` bytes: the decoded bytes, or None (a value whose re-encoding differs is
/// refused so two parsers never read one string two ways).
fn b64u_bytes(v: Option<&Value>, min: usize, max: usize) -> Option<Vec<u8>> {
    let s = str_of(v)?;
    unb64u(s).filter(|b| (min..=max).contains(&b.len()) && b64u(b) == s)
}

/// presencePublicKey as a yes or no: a well-formed certificate presence key. Exactly the fields of its kind: RSA of
/// at least 2048 bits for Windows Hello; RSA of 2048 to 4096 bits or P-256 for `piv`, with a 64 hex `cert_sha256`;
/// P-256 for `fido2` (credential id of 16 to 1023 bytes, the fixed RP ID, a lower-case AAGUID), the Secure Enclave
/// and the password kind. `piv` and `fido2` are refused while their release gates are off.
pub fn presence_public_key_ok(v: &Value, gates: &[String]) -> bool {
    let Some(o) = v.as_object() else { return false };
    let Some(kind) = str_of(o.get("kind")).filter(|k| PRESENCE_KINDS.contains(k)) else { return false };
    let keys = cert_presence_keys(kind);
    if !presence_kind_enabled(kind, gates) || !exact_keys(o, keys, keys) {
        return false;
    }
    let Some(spki) = str_of(o.get("spki")).filter(|s| (40..=1200).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')) else {
        return false;
    };
    let Some(der) = unb64u(spki) else { return false };
    match kind {
        "windows-hello" => matches!(parse_spki(&der), Some(PublicKey::Rsa { bits }) if bits >= 2048),
        "piv" => str_of(o.get("cert_sha256")).is_some_and(is_hex64) && piv_key_problem(&der).is_none(),
        "fido2" => {
            p256_from_spki(&der).is_some()
                && b64u_bytes(o.get("credential_id"), 16, 1023).is_some()
                && str_of(o.get("rp_id")) == Some(FIDO2_RP_ID)
                && str_of(o.get("aaguid")).is_some_and(is_uuid)
        }
        _ => matches!(parse_spki(&der), Some(PublicKey::P256(_))),
    }
}

fn refused(event: &'static str, org: Option<&str>) -> LeafRefusal {
    LeafRefusal { event, reason: presence_words(event, org, None) }
}

/// A version 2 request presence with exactly the keys and bounds of its kind (ID-1 4.2), or the refusal: the kind's
/// release gates off (`rs_kind_disabled`), a PIV key outside RSA 2048 to 4096 or P-256 (`rs_piv_key_size` for a
/// larger RSA key), a PIV certificate whose key is not `spki`, or anything malformed.
pub fn read_request_presence(v: &Value, org: Option<&str>, gates: &[String]) -> Result<(), LeafRefusal> {
    let o = v.as_object();
    let kind = o.and_then(|o| str_of(o.get("kind"))).filter(|k| matches!(*k, "piv" | "fido2"));
    let (Some(o), Some(kind)) = (o, kind) else {
        return Err(LeafRefusal { event: "rs_piv_provenance", reason: "malformed request: a version 2 presence is piv or fido2".into() });
    };
    if !presence_kind_enabled(kind, gates) {
        return Err(refused("rs_kind_disabled", org));
    }
    if kind == "piv" {
        let keys = ["kind", "spki", "cert"];
        let der = if exact_keys(o, &keys, &keys) { b64u_bytes(o.get("cert"), 1, PIV_CERT_MAX) } else { None };
        let Some(cert) = der.as_deref().and_then(parse_cert) else { return Err(refused("rs_piv_provenance", org)) };
        if let Some(problem) = piv_key_problem(&cert.spki_der) {
            return Err(refused(if problem == "size" { "rs_piv_key_size" } else { "rs_piv_provenance" }, org));
        }
        if b64u_bytes(o.get("spki"), 1, 2048).as_deref() != Some(cert.spki_der.as_slice()) {
            return Err(refused("rs_piv_provenance", org));
        }
        return Ok(());
    }
    let keys = ["kind", "spki", "credential_id", "rp_id", "aaguid", "alg", "enroll_nonce", "attestation_object"];
    let ok = exact_keys(o, &keys, &keys)
        && p256_spki(o.get("spki")).is_some()
        && b64u_bytes(o.get("credential_id"), 16, 1023).is_some()
        && str_of(o.get("rp_id")) == Some(FIDO2_RP_ID)
        && str_of(o.get("aaguid")).is_some_and(is_uuid)
        && o.get("alg").and_then(Value::as_i64) == Some(-7)
        && b64u_bytes(o.get("enroll_nonce"), 32, 32).is_some()
        && b64u_bytes(o.get("attestation_object"), 1, FIDO2_ATTESTATION_MAX).is_some();
    if ok {
        Ok(())
    } else {
        Err(refused("rs_fido2_provenance", org))
    }
}

/// The P-256 SubjectPublicKeyInfo DER in a base64url string of 26 to 200 bytes, or None.
fn p256_spki(v: Option<&Value>) -> Option<Vec<u8>> {
    b64u_bytes(v, 26, 200).filter(|der| p256_from_spki(der).is_some())
}

/// The map's certificates that parse (the map reader bounds them; one that does not parse trusts nothing).
fn map_certs(map: &Map<String, Value>, key: &str) -> Vec<X509Info> {
    let list = map.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    list.iter().filter_map(|s| b64u_bytes(Some(s), 1, 4096)).filter_map(|der| parse_cert(&der)).collect()
}

fn map_strings(map: &Map<String, Value>, key: &str) -> Vec<String> {
    map.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// ID-1 4.2 `piv` provenance, as the root checks it before certifying: the request presence is well formed, its
/// certificate is signed by an issuer in `piv_issuers`, it and that issuer are valid at `now`, it has digital-signature
/// key usage, a policy OID in `piv_policy_oids`, no critical extension this reader does not know, a UPN or RFC 822
/// name equal to `email` (case-insensitive), and `status` (a DER CRL or OCSP response, at most 24 hours old) shows it
/// unrevoked. The relay never certifies; it runs this only on the shared vectors.
#[cfg_attr(not(test), allow(dead_code))]
pub fn verify_piv_provenance(p: &Value, map: &Map<String, Value>, email: &str, now: i64, status: &[u8], org: &str, gates: &[String]) -> Result<(), LeafRefusal> {
    let org = Some(org);
    read_request_presence(p, org, gates)?;
    let der = unb64u(str_of(p.get("cert")).unwrap_or_default()).unwrap_or_default();
    let Some(card) = parse_cert(&der) else { return Err(refused("rs_piv_provenance", org)) };
    let Some(issuer) = map_certs(map, "piv_issuers").into_iter().find(|i| cert_signed_by(&card, i)).filter(|_| !card.critical_unknown) else {
        return Err(refused("rs_piv_provenance", org));
    };
    if !valid_at(&card, now) || !valid_at(&issuer, now) {
        return Err(refused("rs_piv_cert_expired", org));
    }
    let email = email.to_lowercase();
    let oids = map_strings(map, "piv_policy_oids");
    let named = card.san_email.iter().chain(card.san_upn.iter()).any(|n| n.to_lowercase() == email);
    if !has_digital_signature(&card) || !card.policy_oids.iter().any(|o| oids.contains(o)) || !named {
        return Err(refused("rs_piv_provenance", org));
    }
    let st = if is_ocsp_response(status) { verify_ocsp(status, &card, &issuer, now, 0) } else { verify_crl(status, &card, &issuer, now, 0) };
    st.map(|_| ()).map_err(|why| refused(if why == "certid" { "rs_piv_certid" } else { "rs_piv_status" }, org))
}

/// The value under a text key of a CBOR map.
fn text_key<'a>(m: &'a [(Cbor, Cbor)], k: &str) -> Option<&'a Cbor> {
    m.iter().find(|(key, _)| matches!(key, Cbor::Text(t) if t == k)).map(|(_, v)| v)
}

fn int_key(m: &[(Cbor, Cbor)], k: i128) -> Option<&Cbor> {
    m.iter().find(|(key, _)| *key == Cbor::Int(k)).map(|(_, v)| v)
}

type AuthData<'a> = (&'a [u8], String, &'a [u8], Vec<(Cbor, Cbor)>);

/// The authenticator data of a registration (WebAuthn 6.1): rpIdHash, flags with UP, UV and AT set, attested
/// credential data (AAGUID, credential id of 16 to 1023 bytes, COSE key map), then one extension map exactly when ED
/// is set, and nothing more. (rpIdHash, AAGUID, credential id, COSE key.)
fn read_auth_data(ad: &[u8]) -> Option<AuthData<'_>> {
    if ad.len() < 37 + 18 {
        return None;
    }
    let flags = ad[32];
    if flags & (FLAG_UP | FLAG_UV | FLAG_AT) != FLAG_UP | FLAG_UV | FLAG_AT {
        return None;
    }
    let id_len = usize::from(u16::from_be_bytes([ad[53], ad[54]]));
    if !(16..=1023).contains(&id_len) || 55 + id_len > ad.len() {
        return None;
    }
    let (cose, end) = cbor_item(ad, 55 + id_len, 0).ok()?;
    let Cbor::Map(cose) = cose else { return None };
    if flags & FLAG_ED != 0 {
        let (ext, ext_end) = cbor_item(ad, end, 0).ok()?;
        if !matches!(ext, Cbor::Map(_)) || ext_end != ad.len() {
            return None;
        }
    } else if end != ad.len() {
        return None;
    }
    Some((&ad[..32], uuid_of(&ad[37..53]), &ad[55..55 + id_len], cose))
}

/// SubjectPublicKeyInfo DER up to the uncompressed point: id-ecPublicKey, prime256v1, a 66-byte BIT STRING.
const P256_SPKI_PREFIX: [u8; 26] = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00];

/// A COSE EC2 key with exactly kty 2, alg -7, crv 1 (P-256) and 32-byte x and y, as SPKI DER; or None.
fn cose_p256_spki(cose: &[(Cbor, Cbor)]) -> Option<Vec<u8>> {
    let (Some(Cbor::Bytes(x)), Some(Cbor::Bytes(y))) = (int_key(cose, -2), int_key(cose, -3)) else { return None };
    if cose.len() != 5 || int_key(cose, 1) != Some(&Cbor::Int(2)) || int_key(cose, 3) != Some(&Cbor::Int(FIDO2_ALG)) || int_key(cose, -1) != Some(&Cbor::Int(1)) {
        return None;
    }
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut der = P256_SPKI_PREFIX.to_vec();
    der.push(4);
    der.extend_from_slice(x);
    der.extend_from_slice(y);
    p256_from_spki(&der).map(|_| der) // the point is on the curve
}

/// The root `path` (leaf first, each signed by the next) reaches: a root that is one of the path's certificates or
/// that signed one, every certificate valid at `at`, every one after the leaf a CA; or None.
fn chain_root<'a>(path: &[X509Info], roots: &'a [X509Info], at: i64) -> Option<&'a X509Info> {
    for (i, c) in path.iter().enumerate() {
        if !valid_at(c, at) || c.critical_unknown || (i > 0 && c.ca != Some(true)) {
            return None;
        }
        if let Some(root) = roots.iter().find(|r| r.der == c.der || (valid_at(r, at) && cert_signed_by(c, r))) {
            return Some(root);
        }
        if !path.get(i + 1).is_some_and(|next| cert_signed_by(c, next)) {
            return None;
        }
    }
    None
}

/// ID-1 4.2 `fido2` provenance: `attestation_object` is exactly one CBOR map `{fmt, attStmt, authData}`, `fmt`
/// "packed" with `alg` -7 and an `x5c` chain (valid at `now`) to a root in `fido2_roots`; the leaf's AAGUID extension,
/// when present, is the request's; authData has the RP ID hash, UP, UV and AT, an extension map only with ED and
/// nothing after it; the attested AAGUID is the request's and in `fido2_aaguids`, the credential id is the request's,
/// the COSE key is the request's `spki`; and `attStmt.sig` verifies with the leaf over authData ||
/// SHA-256(lp("lucid-spoke-fido2-enroll-v1", node_spki, role, label, enroll_nonce)) for the request's own node key,
/// role and label. The relay never certifies; it runs this only on the shared vectors.
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn verify_fido2_provenance(p: &Value, node_spki: &str, role: &str, label: &str, map: &Map<String, Value>, now: i64, org: &str, gates: &[String]) -> Result<(), LeafRefusal> {
    let org = Some(org);
    read_request_presence(p, org, gates)?;
    let no = || refused("rs_fido2_provenance", org);
    let field = |k: &str| str_of(p.get(k)).unwrap_or_default();
    let Ok(Cbor::Map(top)) = cbor_decode(&unb64u(field("attestation_object")).unwrap_or_default()) else { return Err(no()) };
    let (Some(Cbor::Text(fmt)), Some(Cbor::Map(stmt)), Some(Cbor::Bytes(auth_data))) = (text_key(&top, "fmt"), text_key(&top, "attStmt"), text_key(&top, "authData")) else {
        return Err(no());
    };
    if top.len() != 3 || fmt != "packed" || !stmt.iter().all(|(k, _)| matches!(k, Cbor::Text(_))) {
        return Err(no());
    }
    let (Some(Cbor::Bytes(sig)), Some(Cbor::Array(x5c))) = (text_key(stmt, "sig"), text_key(stmt, "x5c")) else { return Err(no()) };
    if stmt.len() != 3 || text_key(stmt, "alg") != Some(&Cbor::Int(FIDO2_ALG)) || !(1..=4).contains(&x5c.len()) {
        return Err(no());
    }
    let Some((rp_hash, aaguid, credential_id, cose)) = read_auth_data(auth_data) else { return Err(no()) };
    let allowed = map_strings(map, "fido2_aaguids");
    if rp_hash != sha256(field("rp_id").as_bytes()) || aaguid != field("aaguid") || !allowed.iter().any(|a| a == field("aaguid")) {
        return Err(no());
    }
    if Some(credential_id) != unb64u(field("credential_id")).as_deref() || cose_p256_spki(&cose) != unb64u(field("spki")) {
        return Err(no());
    }
    let mut chain = Vec::with_capacity(x5c.len());
    for c in x5c {
        let Cbor::Bytes(der) = c else { return Err(no()) };
        let Some(cert) = parse_cert(der) else { return Err(no()) };
        chain.push(cert);
    }
    let leaf = &chain[0];
    if leaf.aaguid.as_deref().is_some_and(|a| a != field("aaguid")) {
        return Err(no());
    }
    let roots = map_certs(map, "fido2_roots");
    let leaf_key = p256_from_spki(&leaf.spki_der).filter(|_| leaf.spki_der.len() >= 26 && leaf.spki_der.len() <= 200);
    let (Some(_), Some(leaf_key)) = (chain_root(&chain, &roots, now), leaf_key) else { return Err(no()) };
    let client_data = lp(&[b"lucid-spoke-fido2-enroll-v1", node_spki.as_bytes(), role.as_bytes(), label.as_bytes(), field("enroll_nonce").as_bytes()]);
    let mut signed = auth_data.clone();
    signed.extend_from_slice(&sha256(&client_data));
    if ecdsa_verify(&leaf_key, &signed, sig) {
        Ok(())
    } else {
        Err(no())
    }
}
