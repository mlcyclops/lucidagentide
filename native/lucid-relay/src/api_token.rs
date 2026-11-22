// Contract API-1 sections 4.2 and 5.2 to 5.6: the API token library shared by the console's front door and every relay
// API listener. Compact JWS (ES256 signing; ES256, RS256 and PS256 verification on AWS-LC), JWK public keys and their
// RFC 7638 thumbprints, DPoP proofs (RFC 9449) with the bounded jti caches of 6.5, client assertions
// (`private_key_jwt`), federated subject tokens (RFC 8693), client secrets, access token minting with the lifetime rule
// (5.3), and offline access token validation with the current-grant intersection (5.4).
//
// The token endpoints (`api_issue.rs`) call this; offline validation waits for the resource routes (slice 1a3).

use crate::api_map::{effective_end, ApiMapStore, TightenEntry, CEILINGS};
use crate::codec::{b64u, sha256, unb64u};
use aws_lc_rs::constant_time;
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::signature::{self as sig, EcdsaKeyPair, RsaPublicKeyComponents, UnparsedPublicKey};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};

type Obj = Map<String, Value>;

/// Clock skew allowed on `nbf` and `iat` (5.2, 5.4).
pub const SKEW: i64 = 60;
/// DPoP `jti` uniqueness window (5.4 step 6).
pub const DPOP_WINDOW: i64 = 300;
/// Client assertion `jti` uniqueness window (5.2).
pub const ASSERTION_WINDOW: i64 = 600;
/// Longest client assertion (`exp - iat`, 5.2).
pub const ASSERTION_SPAN_MAX: i64 = 300;
/// Access token lifetime (5.3), and the unbound D11 token's.
pub const TOKEN_LIFE: i64 = 600;
pub const UNBOUND_LIFE: i64 = 300;
/// jti cache bounds (6.5).
pub const CACHE_LISTENER_MAX: usize = 100_000;
pub const CACHE_CLIENT_MAX: usize = 10_000;
/// RSA sizes: client keys need 3072 bits (4.2); federated issuers' keys (Entra, GitHub and others sign with 2048-bit
/// keys) need 2048.
pub const CLIENT_RSA_MIN_BITS: usize = 3072;
pub const ISSUER_RSA_MIN_BITS: usize = 2048;
const RSA_MAX_BITS: usize = 8192;
/// Longest compact JWS read (the token request body is at most 16 KiB).
const JWS_MAX: usize = 16 * 1024;
const JTI_MAX: usize = 128;
/// JWK members that only a private key has.
const PRIVATE_MEMBERS: [&str; 8] = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/// A refusal: `code` is the contract's error code, `message` a sentence for the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenError {
    pub code: &'static str,
    pub message: String,
}

impl TokenError {
    pub fn new(code: &'static str, message: impl Into<String>) -> TokenError {
        TokenError { code, message: message.into() }
    }
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for TokenError {}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, TokenError> {
    Err(TokenError::new(code, message))
}

// ---- encodings and compact JWS ------------------------------------------------------------------------------------

fn b64u_value(c: u8) -> u8 {
    match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'-' => 62,
        _ => 63,
    }
}

/// Strict base64url without padding: the alphabet only, no impossible length, and no stray trailing bits, so a value
/// has exactly one spelling.
pub fn b64u_strict(s: &str) -> Option<Vec<u8>> {
    let rem = s.len() % 4;
    if rem == 1 {
        return None;
    }
    let bytes = unb64u(s)?;
    let unused = match rem {
        2 => 0x0f,
        3 => 0x03,
        _ => 0,
    };
    if s.as_bytes().last().is_some_and(|&c| b64u_value(c) & unused != 0) {
        return None;
    }
    Some(bytes)
}

fn json_object(bytes: &[u8]) -> Option<Obj> {
    match serde_json::from_slice(bytes).ok()? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}

/// A parsed compact JWS: header and claims as JSON objects, the signing input, the raw signature.
#[derive(Clone, Debug)]
pub struct Jws<'a> {
    pub header: Obj,
    pub claims: Obj,
    pub signing_input: &'a str,
    pub signature: Vec<u8>,
}

impl Jws<'_> {
    fn header_str(&self, k: &str) -> Option<&str> {
        self.header.get(k).and_then(Value::as_str)
    }

    fn claim_str(&self, k: &str) -> Option<&str> {
        self.claims.get(k).and_then(Value::as_str)
    }

    /// An integer claim; None when absent or not an integer.
    fn claim_int(&self, k: &str) -> Option<i64> {
        self.claims.get(k).and_then(Value::as_i64)
    }

    /// An optional integer claim: Ok(None) when absent, Err when present but not an integer.
    fn opt_int(&self, k: &str) -> Result<Option<i64>, ()> {
        match self.claims.get(k) {
            None => Ok(None),
            Some(v) => v.as_i64().map(Some).ok_or(()),
        }
    }
}

/// Three base64url parts, header and claims JSON objects, no `crit` (no extension is understood). None otherwise.
pub fn parse_jws(token: &str) -> Option<Jws<'_>> {
    if token.len() > JWS_MAX {
        return None;
    }
    let mut parts = token.split('.');
    let (h, p, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header = json_object(&b64u_strict(h)?)?;
    if header.contains_key("crit") {
        return None;
    }
    let claims = json_object(&b64u_strict(p)?)?;
    let signature = b64u_strict(s)?;
    Some(Jws { header, claims, signing_input: &token[..h.len() + 1 + p.len()], signature })
}

/// `header.claims.signature` with an ES256 signature (R || S, 64 bytes). The key must be an
/// `ECDSA_P256_SHA256_FIXED_SIGNING` pair (`sign`, a signature that is not 64 bytes, otherwise).
pub fn sign_es256(key: &EcdsaKeyPair, header: &Value, claims: &Value) -> Result<String, TokenError> {
    let enc = |v: &Value| serde_json::to_vec(v).map(|b| b64u(&b)).map_err(|e| TokenError::new("sign", e.to_string()));
    let mut out = enc(header)?;
    out.push('.');
    out.push_str(&enc(claims)?);
    let s = key.sign(&SystemRandom::new(), out.as_bytes()).map_err(|_| TokenError::new("sign", "the token could not be signed"))?;
    if s.as_ref().len() != 64 {
        return fail("sign", "the token key is not an ES256 (fixed signature) key");
    }
    out.push('.');
    out.push_str(&b64u(s.as_ref()));
    Ok(out)
}

// ---- keys ---------------------------------------------------------------------------------------------------------

/// A JWK public key: EC P-256 or RSA (`n` and `e` big-endian without leading zeros).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublicKey {
    Ec { x: [u8; 32], y: [u8; 32] },
    Rsa { n: Vec<u8>, e: Vec<u8> },
}

/// The JWS algorithms the API verifies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alg {
    Es256,
    Rs256,
    Ps256,
}

impl Alg {
    /// ES256, RS256 or PS256; None for anything else (`none`, HMAC, others).
    pub fn of(name: &str) -> Option<Alg> {
        match name {
            "ES256" => Some(Alg::Es256),
            "RS256" => Some(Alg::Rs256),
            "PS256" => Some(Alg::Ps256),
            _ => None,
        }
    }
}

fn coord(v: Option<&Value>) -> Option<[u8; 32]> {
    b64u_strict(v?.as_str()?)?.try_into().ok()
}

/// A public JWK: `kty` EC with `crv` P-256 and 32-byte `x`, `y`; or `kty` RSA with `n` of `rsa_min_bits` to 8192 bits
/// and `e` of 1 to 8 bytes, neither with a leading zero. A JWK carrying any private member is refused. Other members
/// (`kid`, `use`, `alg`, `nbf`, `exp`) are left to the caller.
pub fn parse_jwk(jwk: &Value, rsa_min_bits: usize) -> Option<PublicKey> {
    let o = jwk.as_object()?;
    if PRIVATE_MEMBERS.iter().any(|k| o.contains_key(*k)) {
        return None;
    }
    match o.get("kty")?.as_str()? {
        "EC" => {
            if o.get("crv")?.as_str()? != "P-256" {
                return None;
            }
            Some(PublicKey::Ec { x: coord(o.get("x"))?, y: coord(o.get("y"))? })
        }
        "RSA" => {
            let n = b64u_strict(o.get("n")?.as_str()?)?;
            let e = b64u_strict(o.get("e")?.as_str()?)?;
            let top = *n.first().filter(|b| **b != 0)?;
            let bits = (n.len() - 1) * 8 + (8 - top.leading_zeros() as usize);
            if !(rsa_min_bits..=RSA_MAX_BITS).contains(&bits) || e.is_empty() || e.len() > 8 || e[0] == 0 {
                return None;
            }
            Some(PublicKey::Rsa { n, e })
        }
        _ => None,
    }
}

/// RFC 7638 thumbprint (SHA-256, base64url) of the key's required members.
pub fn jwk_thumbprint(key: &PublicKey) -> String {
    let json = match key {
        PublicKey::Ec { x, y } => format!(r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#, b64u(x), b64u(y)),
        PublicKey::Rsa { n, e } => format!(r#"{{"e":"{}","kty":"RSA","n":"{}"}}"#, b64u(e), b64u(n)),
    };
    b64u(&sha256(json.as_bytes()))
}

/// The signature over `message` with `key` under `alg` (an algorithm of the other key type is false): ES256 as R || S,
/// RS256 as RSASSA-PKCS1-v1_5 with SHA-256, PS256 as RSASSA-PSS with SHA-256, MGF1 SHA-256 and a 32-byte salt.
pub fn verify_signature(key: &PublicKey, alg: Alg, message: &[u8], signature: &[u8]) -> bool {
    match (key, alg) {
        (PublicKey::Ec { x, y }, Alg::Es256) => {
            if signature.len() != 64 {
                return false;
            }
            let mut point = [0u8; 65];
            point[0] = 4;
            point[1..33].copy_from_slice(x);
            point[33..].copy_from_slice(y);
            UnparsedPublicKey::new(&sig::ECDSA_P256_SHA256_FIXED, &point[..]).verify(message, signature).is_ok()
        }
        (PublicKey::Rsa { n, e }, Alg::Rs256) => {
            RsaPublicKeyComponents { n: n.as_slice(), e: e.as_slice() }.verify(&sig::RSA_PKCS1_2048_8192_SHA256, message, signature).is_ok()
        }
        (PublicKey::Rsa { n, e }, Alg::Ps256) => {
            RsaPublicKeyComponents { n: n.as_slice(), e: e.as_slice() }.verify(&sig::RSA_PSS_2048_8192_SHA256, message, signature).is_ok()
        }
        _ => false,
    }
}

fn same(a: &str, b: &str) -> bool {
    constant_time::verify_slices_are_equal(a.as_bytes(), b.as_bytes()).is_ok()
}

// ---- jti caches (6.5) ---------------------------------------------------------------------------------------------

/// A bounded `jti` replay cache for one listener (6.5): each `jti` is held for `window` seconds, at most 100000
/// entries in all and 10000 per client. An entry leaves only once its window has passed, so a full share refuses
/// (`abuse`) rather than forgetting a `jti`. `JtiCache::dpop()` for DPoP proofs, `JtiCache::assertion()` for client
/// assertions.
#[derive(Debug)]
pub struct JtiCache {
    window: i64,
    listener_max: usize,
    client_max: usize,
    seen: HashMap<String, i64>,
    /// (seen at, jti, client) in arrival order.
    order: VecDeque<(i64, String, String)>,
    per_client: HashMap<String, usize>,
}

/// Why a `jti` was not admitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Refused {
    Replay,
    Full,
}

impl JtiCache {
    pub fn new(window: i64) -> JtiCache {
        JtiCache::with_limits(window, CACHE_LISTENER_MAX, CACHE_CLIENT_MAX)
    }

    pub fn dpop() -> JtiCache {
        JtiCache::new(DPOP_WINDOW)
    }

    pub fn assertion() -> JtiCache {
        JtiCache::new(ASSERTION_WINDOW)
    }

    fn with_limits(window: i64, listener_max: usize, client_max: usize) -> JtiCache {
        JtiCache { window, listener_max, client_max, seen: HashMap::new(), order: VecDeque::new(), per_client: HashMap::new() }
    }

    /// Entries held now.
    #[cfg(test)]
    fn len(&self) -> usize {
        self.order.len()
    }

    fn prune(&mut self, now: i64) {
        while self.order.front().is_some_and(|(at, _, _)| at.saturating_add(self.window) <= now) {
            let Some((_, jti, client)) = self.order.pop_front() else { break };
            self.seen.remove(&jti);
            if let Some(n) = self.per_client.get_mut(&client) {
                *n -= 1;
                if *n == 0 {
                    self.per_client.remove(&client);
                }
            }
        }
    }

    /// Record `jti` for `client` at `now`, or refuse a `jti` already held (`Replay`) or a full cache or client share
    /// (`Full`).
    fn admit(&mut self, client: &str, jti: &str, now: i64) -> Result<(), Refused> {
        self.prune(now);
        if self.seen.contains_key(jti) {
            return Err(Refused::Replay);
        }
        if self.order.len() >= self.listener_max || self.per_client.get(client).is_some_and(|n| *n >= self.client_max) {
            return Err(Refused::Full);
        }
        self.seen.insert(jti.to_string(), now);
        self.order.push_back((now, jti.to_string(), client.to_string()));
        *self.per_client.entry(client.to_string()).or_insert(0) += 1;
        Ok(())
    }
}

// ---- DPoP (RFC 9449) ----------------------------------------------------------------------------------------------

/// A proof that verified, before its `jti` is recorded.
struct Proof {
    jkt: String,
    jti: String,
}

fn check_dpop(proof: &str, htm: &str, htu: &str, access_token: Option<&str>, now: i64) -> Result<Proof, TokenError> {
    let bad = |m: &str| TokenError::new("dpop", m);
    let jws = parse_jws(proof).ok_or_else(|| bad("the DPoP proof is not a compact JWS"))?;
    if jws.header_str("typ") != Some("dpop+jwt") {
        return Err(bad("the DPoP proof's typ is not dpop+jwt"));
    }
    if jws.header_str("alg") != Some("ES256") {
        return Err(bad("the DPoP proof's alg is not ES256"));
    }
    let key = jws.header.get("jwk").and_then(|j| parse_jwk(j, CLIENT_RSA_MIN_BITS)).filter(|k| matches!(k, PublicKey::Ec { .. }));
    let Some(key) = key else { return Err(bad("the DPoP proof's jwk is not a public P-256 key")) };
    if !verify_signature(&key, Alg::Es256, jws.signing_input.as_bytes(), &jws.signature) {
        return Err(bad("the DPoP proof's signature does not verify"));
    }
    let Some(jti) = jws.claim_str("jti").filter(|j| !j.is_empty() && j.len() <= JTI_MAX) else {
        return Err(bad("the DPoP proof needs a jti"));
    };
    if jws.claim_str("htm") != Some(htm) {
        return Err(bad("the DPoP proof is for another method"));
    }
    if jws.claim_str("htu") != Some(htu) {
        return Err(bad("the DPoP proof is for another URL"));
    }
    let Some(iat) = jws.claim_int("iat") else { return Err(bad("the DPoP proof needs iat")) };
    if now.abs_diff(iat) > SKEW as u64 {
        return Err(bad("the DPoP proof's iat is more than 60 s away"));
    }
    if let Some(token) = access_token {
        let ath = b64u(&sha256(token.as_bytes()));
        if !jws.claim_str("ath").is_some_and(|a| same(a, &ath)) {
            return Err(bad("the DPoP proof's ath is not the token's hash"));
        }
    }
    Ok(Proof { jkt: jwk_thumbprint(&key), jti: jti.to_string() })
}

fn admit_dpop(cache: &mut JtiCache, client: &str, jti: &str, now: i64) -> Result<(), TokenError> {
    match cache.admit(client, jti, now) {
        Ok(()) => Ok(()),
        Err(Refused::Replay) => fail("dpop-replay", "that DPoP proof was already used"),
        Err(Refused::Full) => fail("abuse", "too many DPoP proofs in the last 5 minutes"),
    }
}

/// A DPoP proof (RFC 9449) for `htm` and `htu` (the canonical origin plus the request path): `typ` `dpop+jwt`, ES256
/// by the public P-256 `jwk` of its header, `iat` within 60 s, `ath` the hash of `access_token` when one is presented
/// (`dpop` otherwise); then its `jti` unseen for 5 minutes (`dpop-replay`; a full cache share is `abuse`). Returns the
/// key's RFC 7638 thumbprint (`cnf.jkt`).
pub fn verify_dpop(proof: &str, htm: &str, htu: &str, access_token: Option<&str>, now: i64, cache: &mut JtiCache, client: &str) -> Result<String, TokenError> {
    let p = check_dpop(proof, htm, htu, access_token, now)?;
    admit_dpop(cache, client, &p.jti, now)?;
    Ok(p.jkt)
}

// ---- client authentication (5.2) ----------------------------------------------------------------------------------

/// The client's credentials less those a journaled `client_drop_credential` refuses (by `kid` or by `type`).
pub fn usable_credentials<'a>(client: &'a Obj, active: &[TightenEntry]) -> Vec<&'a Value> {
    let id = client.get("id").and_then(Value::as_str).unwrap_or_default();
    let drops: Vec<&TightenEntry> = active.iter().filter(|e| e.action == "client_drop_credential" && e.target.get("client").and_then(Value::as_str) == Some(id)).collect();
    let dropped = |cr: &Value| {
        drops.iter().any(|e| {
            ["kid", "type"].iter().any(|k| e.target.get(*k).and_then(Value::as_str).is_some_and(|want| cr.get(*k).and_then(Value::as_str) == Some(want)))
        })
    };
    client.get("credentials").and_then(Value::as_array).into_iter().flatten().filter(|cr| !dropped(*cr)).collect()
}

/// The key a `private_key_jwt` assertion names by `kid`: an inline `jwk` credential with that `kid`, or a key with that
/// `kid` in the already fetched JWKS of a `jwks_uri` credential (`fetched` pairs the URI with its keys). Returns the
/// key's JWK and the credential's `expires`.
fn assertion_key<'a>(credentials: &[&'a Value], fetched: &[(&str, &'a [Value])], kid: &str) -> Option<(&'a Value, i64)> {
    for &cr in credentials.iter().filter(|c| c.get("type").and_then(Value::as_str) == Some("private_key_jwt")) {
        let Some(expires) = cr.get("expires").and_then(Value::as_i64) else { continue };
        if let Some(jwk) = cr.get("jwk") {
            if cr.get("kid").and_then(Value::as_str) == Some(kid) {
                return Some((jwk, expires));
            }
        } else if let Some(uri) = cr.get("jwks_uri").and_then(Value::as_str) {
            let mut keys = fetched.iter().filter(|(u, _)| *u == uri).flat_map(|&(_, keys)| keys.iter());
            if let Some(k) = keys.find(|k| k.get("kid").and_then(Value::as_str) == Some(kid)) {
                return Some((k, expires));
            }
        }
    }
    None
}

/// 5.2 `private_key_jwt`: the assertion's header `kid` names a usable credential key (EC P-256 or RSA of 3072 bits or
/// more) whose credential has not expired; ES256, RS256 or PS256 by that key; `iss` = `sub` = `client_id`; `aud`
/// exactly `token_endpoint`; `iat` and `exp` with `exp - iat` at most 300; `iat` and `nbf` not more than 60 s ahead;
/// `exp` after `now`; a `jti` unseen for 10 minutes. Every refusal is `client-auth` (a full cache share is `abuse`).
/// Returns the credential's `expires` (the key end of 5.3).
#[allow(clippy::too_many_arguments)]
pub fn verify_client_assertion(
    assertion: &str,
    client_id: &str,
    token_endpoint: &str,
    credentials: &[&Value],
    fetched: &[(&str, &[Value])],
    now: i64,
    cache: &mut JtiCache,
) -> Result<i64, TokenError> {
    let bad = |m: &str| TokenError::new("client-auth", m);
    let jws = parse_jws(assertion).ok_or_else(|| bad("the client assertion is not a compact JWS"))?;
    let Some(alg) = jws.header_str("alg").and_then(Alg::of) else { return Err(bad("the client assertion's alg is not ES256, RS256 or PS256")) };
    let Some(kid) = jws.header_str("kid") else { return Err(bad("the client assertion names no kid")) };
    let Some((jwk, expires)) = assertion_key(credentials, fetched, kid) else { return Err(bad("the client assertion's kid is not a credential of this client")) };
    let Some(key) = parse_jwk(jwk, CLIENT_RSA_MIN_BITS) else { return Err(bad("the credential's key is not EC P-256 or RSA of 3072 bits or more")) };
    if now > expires {
        return Err(bad("the credential has expired"));
    }
    if !verify_signature(&key, alg, jws.signing_input.as_bytes(), &jws.signature) {
        return Err(bad("the client assertion's signature does not verify"));
    }
    if jws.claim_str("iss") != Some(client_id) || jws.claim_str("sub") != Some(client_id) {
        return Err(bad("the client assertion's iss and sub must be the client id"));
    }
    if jws.claim_str("aud") != Some(token_endpoint) {
        return Err(bad("the client assertion's aud is not the token endpoint"));
    }
    let (Some(iat), Some(exp)) = (jws.claim_int("iat"), jws.claim_int("exp")) else { return Err(bad("the client assertion needs iat and exp")) };
    if exp.saturating_sub(iat) > ASSERTION_SPAN_MAX {
        return Err(bad("the client assertion lasts more than 300 s"));
    }
    let Ok(nbf) = jws.opt_int("nbf") else { return Err(bad("the client assertion's nbf is not a time")) };
    if iat > now + SKEW || nbf.is_some_and(|n| n > now + SKEW) {
        return Err(bad("the client assertion is from the future"));
    }
    if exp <= now {
        return Err(bad("the client assertion has expired"));
    }
    let Some(jti) = jws.claim_str("jti").filter(|j| !j.is_empty() && j.len() <= JTI_MAX) else { return Err(bad("the client assertion needs a jti")) };
    match cache.admit(client_id, jti, now) {
        Ok(()) => Ok(expires),
        Err(Refused::Replay) => Err(bad("the client assertion was already used")),
        Err(Refused::Full) => fail("abuse", "too many client assertions in the last 10 minutes"),
    }
}

/// The claims of a verified subject token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubjectClaims {
    pub iss: String,
    pub sub: String,
    pub exp: i64,
}

/// 5.2 token exchange against a `federated` credential: its issuer discovery `issuer` and the token's `iss` both
/// exactly the configured `issuer`; `aud` exactly the configured `audience` (a string, or an array of exactly that one
/// element); `sub` exactly the configured `subject`; `alg` in the credential's `algs` (ES256, RS256, PS256 only);
/// signature by the key of `jwks` the header `kid` names (with no `kid`, the only key); `exp` after `now`; `nbf` and
/// `iat` not more than 60 s ahead; the credential not expired. Every refusal is `subject`.
pub fn verify_subject_token(token: &str, credential: &Value, jwks: &[Value], discovery_issuer: &str, now: i64) -> Result<SubjectClaims, TokenError> {
    let bad = |m: &str| TokenError::new("subject", m);
    let cs = |k: &str| credential.get(k).and_then(Value::as_str);
    let (Some("federated"), Some(issuer), Some(audience), Some(subject)) = (cs("type"), cs("issuer"), cs("audience"), cs("subject")) else {
        return Err(bad("the credential is not a federated credential"));
    };
    if credential.get("expires").and_then(Value::as_i64).is_none_or(|e| now > e) {
        return Err(bad("the federated credential has expired"));
    }
    if discovery_issuer != issuer {
        return Err(bad("the issuer's discovery document names another issuer"));
    }
    let jws = parse_jws(token).ok_or_else(|| bad("the subject token is not a compact JWS"))?;
    let name = jws.header_str("alg").unwrap_or_default();
    let allowed = credential.get("algs").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name)));
    let Some(alg) = Alg::of(name).filter(|_| allowed) else { return Err(bad("the subject token's alg is not allowed for this credential")) };
    let jwk = match jws.header_str("kid") {
        Some(kid) => jwks.iter().find(|k| k.get("kid").and_then(Value::as_str) == Some(kid)),
        None if jwks.len() == 1 => jwks.first(),
        None => None,
    };
    let Some(key) = jwk.and_then(|k| parse_jwk(k, ISSUER_RSA_MIN_BITS)) else { return Err(bad("the subject token's key is not in the issuer's JWKS")) };
    if !verify_signature(&key, alg, jws.signing_input.as_bytes(), &jws.signature) {
        return Err(bad("the subject token's signature does not verify"));
    }
    let Some(iss) = jws.claim_str("iss").filter(|i| *i == issuer) else { return Err(bad("the subject token is from another issuer")) };
    let aud_ok = match jws.claims.get("aud") {
        Some(Value::String(a)) => a == audience,
        Some(Value::Array(a)) => a.len() == 1 && a[0].as_str() == Some(audience),
        _ => false,
    };
    if !aud_ok {
        return Err(bad("the subject token is for another audience"));
    }
    let Some(sub) = jws.claim_str("sub").filter(|s| *s == subject) else { return Err(bad("the subject token is for another subject")) };
    let Some(exp) = jws.claim_int("exp") else { return Err(bad("the subject token needs exp")) };
    if exp <= now {
        return Err(bad("the subject token has expired"));
    }
    let (Ok(nbf), Ok(iat)) = (jws.opt_int("nbf"), jws.opt_int("iat")) else { return Err(bad("the subject token's nbf or iat is not a time")) };
    if nbf.is_some_and(|n| n > now + SKEW) || iat.is_some_and(|i| i > now + SKEW) {
        return Err(bad("the subject token is from the future"));
    }
    Ok(SubjectClaims { iss: iss.to_string(), sub: sub.to_string(), exp })
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let nib = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = [0u8; 32];
    for (i, pair) in b.chunks(2).enumerate() {
        out[i] = (nib(pair[0])? << 4) | nib(pair[1])?;
    }
    Some(out)
}

/// D11 `client_secret`: the SHA-256 of the presented secret equals the stored hex digest, compared in constant time.
pub fn verify_client_secret(presented: &str, stored_sha256_hex: &str) -> bool {
    let Some(stored) = hex32(stored_sha256_hex) else { return false };
    constant_time::verify_slices_are_equal(&sha256(presented.as_bytes()), &stored).is_ok()
}

// ---- minting (5.3) ------------------------------------------------------------------------------------------------

/// The sender constraint of a token: the client certificate's `x5t#S256`, the DPoP key's `jkt`, or none (D11 only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cnf {
    X5t(String),
    Jkt(String),
    None,
}

/// A minted access token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Minted {
    pub token: String,
    pub exp: i64,
    pub jti: String,
}

/// The ends that bound an access token (5.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lifetime {
    pub iat: i64,
    /// An unbound D11 `Bearer` token.
    pub unbound: bool,
    /// `clients[].expires`, raw.
    pub registration_end: i64,
    /// The applicable `app` grace (3.3), applied to the registration and the certificate.
    pub grace_hours: u32,
    /// The mTLS certificate's `notAfter`, raw.
    pub cert_end: Option<i64>,
    /// The `private_key_jwt` key's or `client_secret`'s `expires`.
    pub key_end: Option<i64>,
    /// The subject token's `exp` (token exchange).
    pub subject_exp: Option<i64>,
    pub map_expires: i64,
}

/// 5.3 `exp`: the earliest of `iat + 600` (`iat + 300` unbound), the registration's and the certificate's effective
/// ends, the key end, the subject token's `exp` and the map's `expires`.
pub fn token_exp(l: &Lifetime) -> i64 {
    let grace = [Some(l.grace_hours)];
    let life = if l.unbound { UNBOUND_LIFE } else { TOKEN_LIFE };
    [
        Some(l.iat.saturating_add(life)),
        Some(effective_end(l.registration_end, &grace)),
        l.cert_end.map(|c| effective_end(c, &grace)),
        l.key_end,
        l.subject_exp,
        Some(l.map_expires),
    ]
    .into_iter()
    .flatten()
    .min()
    .unwrap_or(l.iat)
}

/// 5.3: an `at+jwt` ES256 access token signed by `signing_key` (an `ECDSA_P256_SHA256_FIXED_SIGNING` pair) under `kid`,
/// with a fresh 22-character `jti` and `nbf` = `iat`.
#[allow(clippy::too_many_arguments)]
pub fn mint_access_token(
    signing_key: &EcdsaKeyPair,
    kid: &str,
    issuer: &str,
    aud: &str,
    client_id: &str,
    org: &str,
    scopes: &[String],
    reach: &str,
    ceiling: &str,
    map_seq: i64,
    cnf: &Cnf,
    iat: i64,
    exp: i64,
) -> Result<Minted, TokenError> {
    let mut raw = [0u8; 16];
    SystemRandom::new().fill(&mut raw).map_err(|_| TokenError::new("sign", "no random bytes for the jti"))?;
    let jti = b64u(&raw);
    let mut claims = json!({"iss": issuer, "sub": client_id, "aud": aud, "client_id": client_id, "org": org,
                            "scope": scopes.join(" "), "reach": reach, "ceiling": ceiling, "map_seq": map_seq,
                            "iat": iat, "nbf": iat, "exp": exp, "jti": jti});
    match cnf {
        Cnf::X5t(h) => claims["cnf"] = json!({"x5t#S256": h}),
        Cnf::Jkt(j) => claims["cnf"] = json!({"jkt": j}),
        Cnf::None => {}
    }
    let token = sign_es256(signing_key, &json!({"alg": "ES256", "typ": "at+jwt", "kid": kid}), &claims)?;
    Ok(Minted { token, exp, jti })
}

// ---- validation (5.4, 5.6) ----------------------------------------------------------------------------------------

/// Which issuer a resource accepts a token from (5.6): the console profile (the map's `issuer.url` and `issuer.jwks`)
/// or a relay's local profile (`RR/local` and the relay's own local JWKS for the org). A key of one is never accepted
/// under the other. Offline validation is called by the resource routes (slice 1a3); until then only tests do.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug)]
pub enum Profile<'a> {
    Console { issuer: &'a str, jwks: &'a [Value] },
    Local { issuer: &'a str, jwks: &'a [Value] },
}

#[cfg_attr(not(test), allow(dead_code))]
impl<'a> Profile<'a> {
    /// The console profile of the org's pinned map.
    pub fn console(store: &'a ApiMapStore, org: &str) -> Option<Profile<'a>> {
        let issuer = store.get(org, "")?.map().get("issuer")?;
        Some(Profile::Console { issuer: issuer.get("url")?.as_str()?, jwks: issuer.get("jwks")?.as_array()? })
    }

    fn parts(&self) -> (&'a str, &'a [Value]) {
        match *self {
            Profile::Console { issuer, jwks } | Profile::Local { issuer, jwks } => (issuer, jwks),
        }
    }
}

/// What a valid token grants now: the intersection of the token and the current map and journal (5.4).
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub client: String,
    /// Sorted.
    pub scopes: Vec<String>,
    pub reach: String,
    pub ceiling: String,
    /// Relay ids (`console` for the console), or `*`; sorted.
    pub relays: Vec<String>,
    pub jti: String,
    pub exp: i64,
}

/// The place of a ceiling in `CEILINGS` (lowest first).
pub(crate) fn rank(ceiling: &str) -> Option<usize> {
    CEILINGS.iter().position(|c| *c == ceiling)
}

/// The strings of a list member of a map object.
pub(crate) fn names<'a>(o: &'a Obj, k: &'static str) -> impl Iterator<Item = &'a str> {
    o.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
}

/// The client with `id` in the org's pinned map.
pub fn find_client<'a>(store: &'a ApiMapStore, org: &str, id: &str) -> Option<&'a Obj> {
    store.clients(org).iter().filter_map(Value::as_object).find(|c| c.get("id").and_then(Value::as_str) == Some(id))
}

/// The journal entries of `action` aimed at `client` (target `{client, ...}`).
pub(crate) fn client_entries<'a>(active: &'a [TightenEntry], action: &'a str, client: &'a str) -> impl Iterator<Item = &'a TightenEntry> {
    active.iter().filter(move |e| e.action == action && e.target.get("client").and_then(Value::as_str) == Some(client))
}

/// A string member of a journal entry's target (empty when absent).
pub(crate) fn target_field<'a>(e: &'a TightenEntry, k: &str) -> &'a str {
    e.target.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// 5.4: validate a console-issued (or, under the local profile, relay-issued) access token offline for a request to
/// `resource` in `org`'s namespace, in the contract's order:
/// 1. the org's map pinned and unexpired (`map-expired`), the org not off (`api-off`);
/// 2. a compact JWS with `alg` ES256 and `typ` `at+jwt`, `kid` a key of the profile inside its `nbf`/`exp`, a valid
///    signature, `iss` the profile's issuer, every claim present (`token`);
/// 3. `aud` = `resource`, `nbf` at most 60 s ahead (`token`), `exp` after `now` (`expired`);
/// 4. `map_seq` not above the pinned `seq` (`map-behind`);
/// 5. `sub` = `client_id` (`token`), a client of the pinned map, active and not suspended by the journal
///    (`suspended`), its registration within its effective end (`expired`), its owner active (`owner`), `org` the
///    namespace (`token`);
/// 6. the sender constraint: `cnf.x5t#S256` equal to the presented certificate's hash, or `cnf.jkt` equal to the
///    thumbprint of a valid DPoP proof (`dpop`, then `cnf`, then `dpop-replay`); a bound token without its proof or
///    certificate is `cnf`;
/// 7. the `jti` not under `token_deny` (`denied`);
///
/// then the intersection: the token's `reach` must equal the client's (`token`); scopes are the token's within the
/// client's current scopes less journaled drops; the ceiling the lower of the token's, the client's and any journaled
/// lowering; relays the client's less journaled drops (`*` expands to the map's relays and `console` when one applies).
/// `dpop` is `(proof, htm, htu)` with `htu` the canonical origin plus the request path.
#[allow(clippy::too_many_arguments)]
#[cfg_attr(not(test), allow(dead_code))]
pub fn validate_access_token(
    token: &str,
    profile: &Profile,
    resource: &str,
    now: i64,
    store: &ApiMapStore,
    org: &str,
    owner_active: &dyn Fn(&str) -> bool,
    presented_cert_sha256: Option<&str>,
    dpop: Option<(&str, &str, &str)>,
    dpop_cache: &mut JtiCache,
) -> Result<Grant, TokenError> {
    let bad = |m: &str| TokenError::new("token", m);
    // 1
    let Some(pinned) = store.get(org, "").filter(|p| p.expires > now) else { return fail("map-expired", "the organization has no unexpired api map") };
    if store.is_off(org) {
        return fail("api-off", "the API is off for this organization");
    }
    // 2
    let (issuer, jwks) = profile.parts();
    let jws = parse_jws(token).ok_or_else(|| bad("the access token is not a compact JWS"))?;
    if jws.header_str("alg") != Some("ES256") || jws.header_str("typ") != Some("at+jwt") {
        return Err(bad("the access token is not an ES256 at+jwt"));
    }
    let Some(kid) = jws.header_str("kid") else { return Err(bad("the access token names no kid")) };
    let Some(jwk) = jwks.iter().find(|k| k.get("kid").and_then(Value::as_str) == Some(kid)) else { return Err(bad("the access token's kid is not an issuer key")) };
    let (key_nbf, key_exp) = (jwk.get("nbf").and_then(Value::as_i64), jwk.get("exp").and_then(Value::as_i64));
    if key_nbf.is_some_and(|n| now < n) || key_exp.is_some_and(|e| now >= e) {
        return Err(bad("the access token's key is outside its validity"));
    }
    let key = parse_jwk(jwk, CLIENT_RSA_MIN_BITS).filter(|k| matches!(k, PublicKey::Ec { .. }));
    if !key.is_some_and(|k| verify_signature(&k, Alg::Es256, jws.signing_input.as_bytes(), &jws.signature)) {
        return Err(bad("the access token's signature does not verify"));
    }
    if jws.claim_str("iss") != Some(issuer) {
        return Err(bad("the access token is from another issuer"));
    }
    let (Some(client_id), Some(scope), Some(reach), Some(ceiling), Some(jti)) =
        (jws.claim_str("client_id"), jws.claim_str("scope"), jws.claim_str("reach"), jws.claim_str("ceiling"), jws.claim_str("jti"))
    else {
        return Err(bad("the access token lacks a claim"));
    };
    let (Some(exp), Some(map_seq), Ok(nbf)) = (jws.claim_int("exp"), jws.claim_int("map_seq"), jws.opt_int("nbf")) else {
        return Err(bad("the access token lacks a claim"));
    };
    // 3
    if jws.claim_str("aud") != Some(resource) {
        return Err(bad("the access token is for another resource"));
    }
    if nbf.is_some_and(|n| n > now + SKEW) {
        return Err(bad("the access token is not valid yet"));
    }
    if exp <= now {
        return fail("expired", "the access token has expired");
    }
    // 4
    if map_seq > pinned.seq {
        return fail("map-behind", format!("the access token is from map {map_seq}; this listener holds {}", pinned.seq));
    }
    // 5
    if jws.claim_str("sub") != Some(client_id) {
        return Err(bad("the access token's sub is not its client_id"));
    }
    let active = store.active(org);
    let Some(client) = find_client(store, org, client_id) else { return fail("suspended", "that client is not registered") };
    let suspended = client.get("state").and_then(Value::as_str) != Some("active")
        || active.iter().any(|e| e.action == "client_suspend" && e.target.as_str() == Some(client_id));
    if suspended {
        return fail("suspended", "that client is suspended");
    }
    let registration_end = client.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN);
    if now > effective_end(registration_end, &[store.grace_hours(org, "app", now)]) {
        return fail("expired", "that client's registration has expired");
    }
    if !owner_active(client.get("owner").and_then(Value::as_str).unwrap_or_default()) {
        return fail("owner", "that client's owner is not an active person of the organization");
    }
    if jws.claim_str("org") != Some(org) {
        return Err(bad("the access token is for another organization"));
    }
    // 6
    match jws.claims.get("cnf") {
        None => {}
        Some(Value::Object(cnf)) if cnf.len() == 1 => {
            if let Some(x5t) = cnf.get("x5t#S256").and_then(Value::as_str) {
                if !presented_cert_sha256.is_some_and(|h| same(h, x5t)) {
                    return fail("cnf", "the access token is bound to another certificate");
                }
            } else if let Some(jkt) = cnf.get("jkt").and_then(Value::as_str) {
                let Some((proof, htm, htu)) = dpop else { return fail("cnf", "the access token needs a DPoP proof") };
                let p = check_dpop(proof, htm, htu, Some(token), now)?;
                if !same(&p.jkt, jkt) {
                    return fail("cnf", "the DPoP proof is by another key");
                }
                admit_dpop(dpop_cache, client_id, &p.jti, now)?;
            } else {
                return Err(bad("the access token's cnf is not readable"));
            }
        }
        Some(_) => return Err(bad("the access token's cnf is not readable")),
    }
    // 7
    if active.iter().any(|e| e.action == "token_deny" && e.target.get("jti").and_then(Value::as_str) == Some(jti)) {
        return fail("denied", "that access token was revoked");
    }
    // the intersection
    let current_reach = client.get("reach").and_then(Value::as_str).unwrap_or_default();
    if reach != current_reach {
        return Err(bad("the access token's reach is not the client's"));
    }
    let dropped_scopes: Vec<&str> = client_entries(active, "client_drop_scope", client_id).map(|e| target_field(e, "scope")).collect();
    let mut scopes: Vec<String> =
        scope.split(' ').filter(|s| !s.is_empty() && names(client, "scopes").any(|c| c == *s) && !dropped_scopes.contains(s)).map(str::to_string).collect();
    scopes.sort();
    scopes.dedup();
    let Some(token_rank) = rank(ceiling) else { return Err(bad("the access token's ceiling is not readable")) };
    let lowered = client_entries(active, "client_lower_ceiling", client_id).filter_map(|e| rank(target_field(e, "ceiling")));
    let current = client.get("ceiling").and_then(Value::as_str).and_then(rank).unwrap_or(0);
    let effective = lowered.fold(token_rank.min(current), usize::min);
    let dropped_relays: Vec<&str> = client_entries(active, "client_drop_relay", client_id).map(|e| target_field(e, "relay")).collect();
    let mut relays: Vec<String> = Vec::new();
    for r in names(client, "relays") {
        if r == "*" && !dropped_relays.is_empty() {
            let all = store.relay_origins(org).into_iter().flat_map(|o| o.keys().map(String::as_str)).chain(["console"]);
            relays.extend(all.filter(|id| !dropped_relays.contains(id)).map(str::to_string));
        } else if !dropped_relays.contains(&r) {
            relays.push(r.to_string());
        }
    }
    relays.sort();
    relays.dedup();
    Ok(Grant { client: client_id.to_string(), scopes, reach: reach.to_string(), ceiling: CEILINGS[effective].to_string(), relays, jti: jti.to_string(), exp })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_map::{api_map_hash, VerifiedApiMap};
    use aws_lc_rs::signature::{KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use std::collections::BTreeSet;

    const VECTORS: &str = include_str!("../tests/api_token_v1.json");
    const NOW: i64 = 1_795_000_000;
    const DAY: i64 = 86400;
    const ORG: &str = "acme";
    const ISSUER: &str = "https://console.acme.example:7443/api/orgs/acme";
    const ENDPOINT: &str = "https://console.acme.example:7443/api/orgs/acme/oauth/token";
    const CLIENT: &str = "c_5f1a2b3c4d5e6f70";

    fn code<T>(r: Result<T, TokenError>) -> &'static str {
        r.err().map_or("ok", |e| e.code)
    }

    fn key(kid: &str) -> (EcdsaKeyPair, Value) {
        let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
        let p = pair.public_key().as_ref().to_vec();
        let jwk = json!({"kty": "EC", "crv": "P-256", "kid": kid, "x": b64u(&p[1..33]), "y": b64u(&p[33..65])});
        (pair, jwk)
    }

    fn map(issuer_jwk: &Value, client_jwk: &Value) -> Value {
        let mut ik = issuer_jwk.clone();
        ik["use"] = json!("sig");
        ik["alg"] = json!("ES256");
        ik["nbf"] = json!(NOW - DAY);
        ik["exp"] = json!(NOW + 90 * DAY);
        let mut ck = client_jwk.clone();
        ck.as_object_mut().unwrap().remove("kid");
        json!({"v": 1, "org": ORG, "seq": 7, "issued": NOW - DAY, "expires": NOW + 30 * DAY,
               "issuer": {"url": ISSUER, "jwks": [ik]},
               "grace": {"person": 0, "app": 24, "connector": 0, "relay": 0},
               "failover_after_s": 300, "folded": [], "cleared": [],
               "relay_origins": {"r_01": "https://relay1.acme.example:9443", "r_02": "https://relay2.acme.example:9443"},
               "clients": [{"id": CLIENT, "name": "splunk-scrape", "principal": "splunk-scrape@apps.acme.example", "kind": "monitoring",
                            "owner": "ann@acme.example", "reach": "R0", "scopes": ["monitor.read", "audit.read"], "ceiling": "confidential",
                            "relays": ["*"], "networks": [], "mtls_required": false,
                            "rate": {"per_minute_each": 120, "per_day_each": 100000},
                            "credentials": [{"type": "private_key_jwt", "kid": "k1", "jwk": ck, "expires": NOW + 90 * DAY}],
                            "created": NOW - DAY, "expires": NOW + 10 * DAY, "state": "active"}]})
    }

    /// An in-memory store holding `map` (with `seq`) and the journal `active` (renumbered from tseq 1) plus a
    /// `token_deny` per `denied` jti.
    fn store_of(map: &Value, seq: i64, active: &[Value], denied: &[&str], now: i64) -> ApiMapStore {
        let mut m = map.clone();
        m["seq"] = json!(seq);
        let org = m["org"].as_str().unwrap().to_string();
        let wire = json!({"map": m, "sig": "", "chain": []});
        let vm = VerifiedApiMap {
            wire: wire.as_object().unwrap().clone(),
            org: org.clone(),
            seq,
            expires: m["expires"].as_i64().unwrap(),
            hash: api_map_hash(&m),
            signer: "root".into(),
        };
        let mut s = ApiMapStore::load(None);
        s.pin(vm).unwrap();
        let deny_client = m["clients"].as_array().and_then(|c| c.first()).and_then(|c| c["id"].as_str()).unwrap_or("c_0000000000000000").to_string();
        let mut tseq = 0u64;
        for e in active {
            tseq += 1;
            let mut e = e.clone();
            e["tseq"] = json!(tseq);
            e["id"] = json!(format!("t_{org}_{tseq:06}"));
            s.apply_tighten(&org, &e).unwrap();
        }
        for jti in denied {
            tseq += 1;
            let e = json!({"id": format!("t_{org}_{tseq:06}"), "tseq": tseq, "ts": now - 1, "action": "token_deny",
                           "target": {"client": deny_client, "jti": jti}, "until": now + 3600});
            s.apply_tighten(&org, &e).unwrap();
        }
        s
    }

    fn entry(action: &str, target: Value) -> Value {
        json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW - 10, "action": action, "target": target})
    }

    fn dpop_proof(pair: &EcdsaKeyPair, jwk: &Value, htm: &str, htu: &str, iat: i64, jti: &str, token: Option<&str>) -> String {
        let mut pk = jwk.clone();
        pk.as_object_mut().unwrap().remove("kid");
        let mut claims = json!({"jti": jti, "htm": htm, "htu": htu, "iat": iat});
        if let Some(t) = token {
            claims["ath"] = json!(b64u(&sha256(t.as_bytes())));
        }
        sign_es256(pair, &json!({"typ": "dpop+jwt", "alg": "ES256", "jwk": pk}), &claims).unwrap()
    }

    #[test]
    fn base64url_and_jws_parsing_are_strict() {
        assert_eq!(b64u_strict("AQ"), Some(vec![1]));
        assert_eq!(b64u_strict("AR"), None, "stray trailing bits");
        assert_eq!(b64u_strict("AQI"), Some(vec![1, 2]));
        assert_eq!(b64u_strict("AQJ"), None);
        assert_eq!(b64u_strict("A"), None);
        assert_eq!(b64u_strict("AQ=="), None);
        assert_eq!(b64u_strict("A+"), None);
        let h = b64u(br#"{"alg":"ES256"}"#);
        let c = b64u(br#"{"a":1}"#);
        assert!(parse_jws(&format!("{h}.{c}.AQ")).is_some());
        assert!(parse_jws(&format!("{h}.{c}")).is_none());
        assert!(parse_jws(&format!("{h}.{c}.AQ.AQ")).is_none());
        assert!(parse_jws(&format!("{}.{c}.AQ", b64u(br#"{"alg":"ES256","crit":["x"]}"#))).is_none());
        assert!(parse_jws(&format!("{}.{c}.AQ", b64u(b"[1]"))).is_none());
    }

    #[test]
    fn jwk_keys_and_thumbprints() {
        let (pair, jwk) = key("k1");
        let k = parse_jwk(&jwk, CLIENT_RSA_MIN_BITS).unwrap();
        let want = format!(r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#, jwk["x"].as_str().unwrap(), jwk["y"].as_str().unwrap());
        assert_eq!(jwk_thumbprint(&k), b64u(&sha256(want.as_bytes())));
        let mut private = jwk.clone();
        private["d"] = json!("AQ");
        assert_eq!(parse_jwk(&private, CLIENT_RSA_MIN_BITS), None, "a private key is never a public key");
        let mut p384 = jwk.clone();
        p384["crv"] = json!("P-384");
        assert_eq!(parse_jwk(&p384, CLIENT_RSA_MIN_BITS), None);
        // RSA sizes: 2048 bits passes the issuer minimum, not the client minimum
        let mut n = vec![0xc5u8; 256];
        n[255] |= 1;
        let rsa = json!({"kty": "RSA", "n": b64u(&n), "e": "AQAB"});
        assert!(matches!(parse_jwk(&rsa, ISSUER_RSA_MIN_BITS), Some(PublicKey::Rsa { .. })));
        assert_eq!(parse_jwk(&rsa, CLIENT_RSA_MIN_BITS), None);
        let mut zero = vec![0u8];
        zero.extend_from_slice(&n);
        assert_eq!(parse_jwk(&json!({"kty": "RSA", "n": b64u(&zero), "e": "AQAB"}), ISSUER_RSA_MIN_BITS), None, "no leading zero");
        // ES256 round trip; the other algorithms never verify an EC key
        let t = sign_es256(&pair, &json!({"alg": "ES256"}), &json!({"a": 1})).unwrap();
        let j = parse_jws(&t).unwrap();
        assert!(verify_signature(&k, Alg::Es256, j.signing_input.as_bytes(), &j.signature));
        assert!(!verify_signature(&k, Alg::Rs256, j.signing_input.as_bytes(), &j.signature));
        assert!(!verify_signature(&k, Alg::Es256, b"other", &j.signature));
        assert_eq!(Alg::of("none"), None);
        assert_eq!(Alg::of("HS256"), None);
    }

    #[test]
    fn dpop_proofs_bind_keys_and_refuse_replays() {
        let (pair, jwk) = key("d");
        let htu = "https://relay1.acme.example:9443/api/orgs/acme/v1/health";
        let jkt = jwk_thumbprint(&parse_jwk(&jwk, CLIENT_RSA_MIN_BITS).unwrap());
        let mut cache = JtiCache::dpop();
        let p = dpop_proof(&pair, &jwk, "GET", htu, NOW, "j1", Some("tok"));
        assert_eq!(verify_dpop(&p, "GET", htu, Some("tok"), NOW, &mut cache, CLIENT), Ok(jkt.clone()));
        assert_eq!(code(verify_dpop(&p, "GET", htu, Some("tok"), NOW + 10, &mut cache, CLIENT)), "dpop-replay");
        // the same jti in a fresh proof is accepted once the first one left the 5 minute window
        let later = dpop_proof(&pair, &jwk, "GET", htu, NOW + DPOP_WINDOW, "j1", Some("tok"));
        assert_eq!(verify_dpop(&later, "GET", htu, Some("tok"), NOW + DPOP_WINDOW, &mut cache, CLIENT), Ok(jkt), "evicted after 5 minutes");
        let p = dpop_proof(&pair, &jwk, "GET", htu, NOW, "j2", Some("tok"));
        assert_eq!(code(verify_dpop(&p, "POST", htu, Some("tok"), NOW, &mut cache, CLIENT)), "dpop");
        assert_eq!(code(verify_dpop(&p, "GET", "https://relay1.acme.example:9443/x", Some("tok"), NOW, &mut cache, CLIENT)), "dpop");
        assert_eq!(code(verify_dpop(&p, "GET", htu, Some("other"), NOW, &mut cache, CLIENT)), "dpop");
        assert_eq!(code(verify_dpop(&p, "GET", htu, Some("tok"), NOW + 61, &mut cache, CLIENT)), "dpop");
        let no_ath = dpop_proof(&pair, &jwk, "GET", htu, NOW, "j3", None);
        assert_eq!(code(verify_dpop(&no_ath, "GET", htu, Some("tok"), NOW, &mut cache, CLIENT)), "dpop");
        assert_eq!(code(verify_dpop(&no_ath, "GET", htu, None, NOW, &mut cache, CLIENT)), "ok");
        let mut bad_typ = jwk.clone();
        bad_typ.as_object_mut().unwrap().remove("kid");
        let jwt = sign_es256(&pair, &json!({"typ": "JWT", "alg": "ES256", "jwk": bad_typ}), &json!({"jti": "j4", "htm": "GET", "htu": htu, "iat": NOW})).unwrap();
        assert_eq!(code(verify_dpop(&jwt, "GET", htu, None, NOW, &mut cache, CLIENT)), "dpop");
        // bounded per client and per listener; full shares refuse until a window passes
        let mut small = JtiCache::with_limits(300, 3, 2);
        assert_eq!(small.admit("a", "1", NOW), Ok(()));
        assert_eq!(small.admit("a", "2", NOW), Ok(()));
        assert_eq!(small.admit("a", "3", NOW), Err(Refused::Full));
        assert_eq!(small.admit("b", "1", NOW), Err(Refused::Replay));
        assert_eq!(small.admit("b", "3", NOW), Ok(()));
        assert_eq!(small.admit("c", "4", NOW + 299), Err(Refused::Full));
        assert_eq!(small.admit("c", "4", NOW + 300), Ok(()));
        assert_eq!(small.len(), 1);
    }

    #[test]
    fn client_assertions_secrets_and_lifetimes() {
        let (pair, jwk) = key("k1");
        let (other, _) = key("k1");
        let m = map(&key("k-2026-11").1, &jwk);
        let s = store_of(&m, 7, &[], &[], NOW);
        let client = find_client(&s, ORG, CLIENT).unwrap();
        let creds = usable_credentials(client, s.active(ORG));
        let claims = |jti: &str| json!({"iss": CLIENT, "sub": CLIENT, "aud": ENDPOINT, "iat": NOW, "exp": NOW + 300, "jti": jti});
        let assert_with = |k: &EcdsaKeyPair, kid: &str, c: Value| sign_es256(k, &json!({"alg": "ES256", "kid": kid}), &c).unwrap();
        let mut cache = JtiCache::assertion();
        let a = assert_with(&pair, "k1", claims("a1"));
        assert_eq!(verify_client_assertion(&a, CLIENT, ENDPOINT, &creds, &[], NOW, &mut cache), Ok(NOW + 90 * DAY));
        assert_eq!(code(verify_client_assertion(&a, CLIENT, ENDPOINT, &creds, &[], NOW, &mut cache)), "client-auth", "replay");
        assert_eq!(code(verify_client_assertion(&assert_with(&other, "k1", claims("a2")), CLIENT, ENDPOINT, &creds, &[], NOW, &mut cache)), "client-auth");
        assert_eq!(code(verify_client_assertion(&assert_with(&pair, "k9", claims("a3")), CLIENT, ENDPOINT, &creds, &[], NOW, &mut cache)), "client-auth");
        let mut c = claims("a4");
        c["aud"] = json!([ENDPOINT]);
        assert_eq!(code(verify_client_assertion(&assert_with(&pair, "k1", c), CLIENT, ENDPOINT, &creds, &[], NOW, &mut cache)), "client-auth");
        let mut c = claims("a5");
        c["exp"] = json!(NOW + 301);
        assert_eq!(code(verify_client_assertion(&assert_with(&pair, "k1", c), CLIENT, ENDPOINT, &creds, &[], NOW, &mut cache)), "client-auth");
        // a jwks_uri credential with its fetched keys
        let fetched_cred = json!({"type": "private_key_jwt", "jwks_uri": "https://keys.acme.example/jwks", "private_ok": false, "expires": NOW + DAY});
        let keys = [jwk.clone()];
        let a = assert_with(&pair, "k1", claims("a6"));
        assert_eq!(verify_client_assertion(&a, CLIENT, ENDPOINT, &[&fetched_cred], &[("https://keys.acme.example/jwks", &keys[..])], NOW, &mut cache), Ok(NOW + DAY));
        // a dropped credential is not usable
        let s = store_of(&m, 7, &[entry("client_drop_credential", json!({"client": CLIENT, "kid": "k1"}))], &[], NOW);
        assert!(usable_credentials(find_client(&s, ORG, CLIENT).unwrap(), s.active(ORG)).is_empty());

        let secret = "lcs_secret";
        let digest = crate::codec::hex(&sha256(secret.as_bytes()));
        assert!(verify_client_secret(secret, &digest));
        assert!(verify_client_secret(secret, &digest.to_uppercase()));
        assert!(!verify_client_secret("lcs_other", &digest));
        assert!(!verify_client_secret(secret, &digest[..62]));

        let l = Lifetime { iat: NOW, unbound: false, registration_end: NOW + DAY, grace_hours: 0, cert_end: None, key_end: None, subject_exp: None, map_expires: NOW + DAY };
        assert_eq!(token_exp(&l), NOW + 600);
        assert_eq!(token_exp(&Lifetime { unbound: true, ..l }), NOW + 300);
        // a registration that ended 7000 s ago, inside a 2 hour grace, ends the token at the grace end
        assert_eq!(token_exp(&Lifetime { registration_end: NOW - 7000, grace_hours: 2, ..l }), NOW + 200);
        assert_eq!(token_exp(&Lifetime { cert_end: Some(NOW + 100), ..l }), NOW + 100);
        assert_eq!(token_exp(&Lifetime { key_end: Some(NOW + 50), subject_exp: Some(NOW + 70), ..l }), NOW + 50);
        assert_eq!(token_exp(&Lifetime { map_expires: NOW + 10, ..l }), NOW + 10);
    }

    #[test]
    fn subject_tokens_match_the_federated_credential_exactly() {
        let (pair, jwk) = key("f1");
        let cred = json!({"type": "federated", "issuer": "https://login.example/tenant/v2.0", "audience": "api://lucid", "subject": "sp-123",
                          "algs": ["ES256"], "private_ok": false, "expires": NOW + DAY});
        let jwks = [jwk.clone()];
        let tok = |header: Value, claims: Value| sign_es256(&pair, &header, &claims).unwrap();
        let claims = json!({"iss": "https://login.example/tenant/v2.0", "aud": "api://lucid", "sub": "sp-123", "exp": NOW + 600, "iat": NOW});
        let h = json!({"alg": "ES256", "kid": "f1"});
        let issuer = "https://login.example/tenant/v2.0";
        assert_eq!(verify_subject_token(&tok(h.clone(), claims.clone()), &cred, &jwks, issuer, NOW).map(|c| c.exp), Ok(NOW + 600));
        assert_eq!(code(verify_subject_token(&tok(h.clone(), claims.clone()), &cred, &jwks, "https://login.example/other", NOW)), "subject");
        let mut c = claims.clone();
        c["aud"] = json!(["api://lucid"]);
        assert_eq!(code(verify_subject_token(&tok(h.clone(), c), &cred, &jwks, issuer, NOW)), "ok");
        let mut c = claims.clone();
        c["aud"] = json!(["api://lucid", "api://other"]);
        assert_eq!(code(verify_subject_token(&tok(h.clone(), c), &cred, &jwks, issuer, NOW)), "subject");
        let mut c = claims.clone();
        c["sub"] = json!("sp-124");
        assert_eq!(code(verify_subject_token(&tok(h.clone(), c), &cred, &jwks, issuer, NOW)), "subject");
        let mut c = claims.clone();
        c["nbf"] = json!(NOW + 61);
        assert_eq!(code(verify_subject_token(&tok(h.clone(), c), &cred, &jwks, issuer, NOW)), "subject");
        assert_eq!(code(verify_subject_token(&tok(h.clone(), claims.clone()), &cred, &jwks, issuer, NOW + 600)), "subject");
        assert_eq!(code(verify_subject_token(&tok(json!({"alg": "none", "kid": "f1"}), claims.clone()), &cred, &jwks, issuer, NOW)), "subject");
        let mut rs = cred.clone();
        rs["algs"] = json!(["RS256"]);
        assert_eq!(code(verify_subject_token(&tok(h.clone(), claims.clone()), &rs, &jwks, issuer, NOW)), "subject");
        assert_eq!(code(verify_subject_token(&tok(json!({"alg": "ES256", "kid": "f2"}), claims.clone()), &cred, &jwks, issuer, NOW)), "subject");
        assert_eq!(code(verify_subject_token(&tok(json!({"alg": "ES256"}), claims), &cred, &jwks, issuer, NOW)), "ok", "the only key");
    }

    #[test]
    fn access_tokens_validate_in_order_and_intersect_the_current_grant() {
        let (console, console_jwk) = key("k-2026-11");
        let (_, client_jwk) = key("k1");
        let (dk, djwk) = key("d");
        let m = map(&console_jwk, &client_jwk);
        let rr = "https://relay1.acme.example:9443/api/orgs/acme";
        let scopes = vec!["audit.read".to_string(), "fleet.read".to_string(), "monitor.read".to_string()];
        let mint = |aud: &str, seq: i64, cnf: Cnf, exp: i64| mint_access_token(&console, "k-2026-11", ISSUER, aud, CLIENT, ORG, &scopes, "R0", "cui", seq, &cnf, NOW - 10, exp).unwrap();
        let owners = |p: &str| p == "ann@acme.example";
        let x5t = "q".repeat(43);
        let check = |s: &ApiMapStore, t: &str, cert: Option<&str>, dpop: Option<(&str, &str, &str)>| {
            let profile = Profile::console(s, ORG).unwrap();
            validate_access_token(t, &profile, rr, NOW, s, ORG, &owners, cert, dpop, &mut JtiCache::dpop())
        };
        let s = store_of(&m, 7, &[], &[], NOW);
        let t = mint(rr, 7, Cnf::X5t(x5t.clone()), NOW + 590);
        let g = check(&s, &t.token, Some(x5t.as_str()), None).unwrap();
        assert_eq!(g.scopes, ["audit.read", "monitor.read"], "fleet.read is not the client's");
        assert_eq!((g.ceiling.as_str(), g.relays.clone(), g.jti.clone(), g.exp), ("confidential", vec!["*".to_string()], t.jti.clone(), NOW + 590));
        assert_eq!(code(check(&s, &t.token, Some("r".repeat(43).as_str()), None)), "cnf");
        assert_eq!(code(check(&s, &t.token, None, None)), "cnf");
        assert_eq!(code(check(&s, &mint(ISSUER, 7, Cnf::X5t(x5t.clone()), NOW + 590).token, Some(x5t.as_str()), None)), "token", "aud");
        assert_eq!(code(check(&s, &mint(rr, 8, Cnf::X5t(x5t.clone()), NOW + 590).token, Some(x5t.as_str()), None)), "map-behind");
        assert_eq!(code(check(&s, &mint(rr, 7, Cnf::X5t(x5t.clone()), NOW).token, Some(x5t.as_str()), None)), "expired");
        let mut tampered = t.token.clone();
        tampered.pop();
        tampered.push(if t.token.ends_with('A') { 'B' } else { 'A' });
        assert_eq!(code(check(&s, &tampered, Some(x5t.as_str()), None)), "token");
        // a local profile never takes a console token
        let local = Profile::Local { issuer: "https://relay1.acme.example:9443/api/orgs/acme/local", jwks: &[] };
        assert_eq!(code(validate_access_token(&t.token, &local, rr, NOW, &s, ORG, &owners, Some(x5t.as_str()), None, &mut JtiCache::dpop())), "token");
        // the owner, the journal and the map
        let nobody = |_: &str| false;
        let profile = Profile::console(&s, ORG).unwrap();
        assert_eq!(code(validate_access_token(&t.token, &profile, rr, NOW, &s, ORG, &nobody, Some(x5t.as_str()), None, &mut JtiCache::dpop())), "owner");
        let s2 = store_of(&m, 7, &[entry("client_suspend", json!(CLIENT))], &[], NOW);
        assert_eq!(code(check(&s2, &t.token, Some(x5t.as_str()), None)), "suspended");
        let s2 = store_of(&m, 7, &[], &[t.jti.as_str()], NOW);
        assert_eq!(code(check(&s2, &t.token, Some(x5t.as_str()), None)), "denied");
        let s2 = store_of(&m, 7, &[entry("api_off", json!(ORG))], &[], NOW);
        assert_eq!(code(check(&s2, &t.token, Some(x5t.as_str()), None)), "api-off");
        let mut expired = m.clone();
        expired["clients"][0]["expires"] = json!(NOW - 25 * 3600);
        assert_eq!(code(check(&store_of(&expired, 7, &[], &[], NOW), &t.token, Some(x5t.as_str()), None)), "expired");
        expired["clients"][0]["expires"] = json!(NOW - 23 * 3600);
        assert_eq!(code(check(&store_of(&expired, 7, &[], &[], NOW), &t.token, Some(x5t.as_str()), None)), "ok", "inside the app grace");
        // journaled drops and lowering narrow the grant whatever the token says
        let mut s3 = store_of(&m, 7, &[entry("client_drop_scope", json!({"client": CLIENT, "scope": "audit.read"}))], &[], NOW);
        s3.apply_tighten(ORG, &json!({"id": "t_acme_000002", "tseq": 2, "ts": NOW - 5, "action": "client_lower_ceiling", "target": {"client": CLIENT, "ceiling": "internal"}})).unwrap();
        s3.apply_tighten(ORG, &json!({"id": "t_acme_000003", "tseq": 3, "ts": NOW - 5, "action": "client_drop_relay", "target": {"client": CLIENT, "relay": "r_01"}})).unwrap();
        let g = check(&s3, &t.token, Some(x5t.as_str()), None).unwrap();
        assert_eq!((g.scopes, g.ceiling.as_str(), g.relays), (vec!["monitor.read".to_string()], "internal", vec!["console".to_string(), "r_02".to_string()]));
        // DPoP-bound
        let jkt = jwk_thumbprint(&parse_jwk(&djwk, CLIENT_RSA_MIN_BITS).unwrap());
        let d = mint(rr, 7, Cnf::Jkt(jkt), NOW + 590);
        let htu = format!("{rr}/v1/health");
        let htu = htu.as_str();
        let proof = dpop_proof(&dk, &djwk, "GET", htu, NOW, "p1", Some(d.token.as_str()));
        assert_eq!(code(check(&s, &d.token, None, Some((proof.as_str(), "GET", htu)))), "ok");
        assert_eq!(code(check(&s, &d.token, None, None)), "cnf");
        let (ok2, ojwk) = key("o");
        let other = dpop_proof(&ok2, &ojwk, "GET", htu, NOW, "p2", Some(d.token.as_str()));
        assert_eq!(code(check(&s, &d.token, None, Some((other.as_str(), "GET", htu)))), "cnf");
        let wrong_ath = dpop_proof(&dk, &djwk, "GET", htu, NOW, "p3", Some(t.token.as_str()));
        assert_eq!(code(check(&s, &d.token, None, Some((wrong_ath.as_str(), "GET", htu)))), "dpop");
        let mut cache = JtiCache::dpop();
        let profile = Profile::console(&s, ORG).unwrap();
        assert_eq!(code(validate_access_token(&d.token, &profile, rr, NOW, &s, ORG, &owners, None, Some((proof.as_str(), "GET", htu)), &mut cache)), "ok");
        assert_eq!(code(validate_access_token(&d.token, &profile, rr, NOW, &s, ORG, &owners, None, Some((proof.as_str(), "GET", htu)), &mut cache)), "dpop-replay");
    }

    fn public(jwk: &Value) -> Value {
        let mut k = jwk.clone();
        if let Some(o) = k.as_object_mut() {
            for p in PRIVATE_MEMBERS {
                o.remove(p);
            }
        }
        k
    }

    fn text<'a>(v: &'a Value, k: &str) -> &'a str {
        v[k].as_str().unwrap_or_default()
    }

    /// Cases seen, codes given, and every disagreement (reported together).
    #[derive(Default)]
    struct Tally {
        seen: usize,
        codes: BTreeSet<String>,
        wrong: Vec<String>,
    }

    impl Tally {
        fn verdict(&mut self, section: &str, c: &Value, got: &str) {
            self.seen += 1;
            self.codes.insert(got.to_string());
            if got != text(c, "expect") {
                self.wrong.push(format!("{section}/{}: got {got}, want {}", text(c, "name"), text(c, "expect")));
            }
        }
    }

    #[test]
    fn the_api_token_vectors_give_the_expected_verdicts() {
        let doc: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(doc["v"], 1);
        let now = doc["now"].as_i64().unwrap();
        let org = text(&doc, "org");
        let map = &doc["map"];
        let active: Vec<Value> = doc["active"].as_array().cloned().unwrap_or_default();
        let owners = doc["owners"].as_object().cloned().unwrap_or_default();
        let owner_active = |p: &str| owners.get(p).and_then(Value::as_bool).unwrap_or(false);
        let local_jwks = vec![public(&doc["keys"]["local"])];
        let base = store_of(map, map["seq"].as_i64().unwrap(), &active, &[], now);
        assert_eq!(Profile::console(&base, org).map(|p| p.parts().0), Some(text(&doc, "issuer")));
        let mut t = Tally::default();

        for c in doc["access_tokens"].as_array().unwrap() {
            let denied: Vec<&str> = c["denied_jti"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let st = store_of(map, c["map_seq"].as_i64().unwrap(), &active, &denied, now);
            let profile = match text(c, "profile") {
                "local" => Profile::Local { issuer: text(&doc, "local_issuer"), jwks: &local_jwks },
                _ => Profile::console(&st, org).unwrap(),
            };
            let cert = Some(text(c, "cert_sha256")).filter(|h| !h.is_empty());
            let d = &c["dpop"];
            let dpop = d.as_object().map(|_| (text(d, "proof"), text(d, "htm"), text(d, "htu")));
            let got = validate_access_token(text(c, "token"), &profile, text(c, "resource"), now, &st, org, &owner_active, cert, dpop, &mut JtiCache::dpop());
            if let (Ok(g), Some(want)) = (&got, c["grant"].as_object()) {
                let have = json!({"client": g.client, "scopes": g.scopes, "reach": g.reach, "ceiling": g.ceiling, "relays": g.relays});
                if have != Value::Object(want.clone()) {
                    t.wrong.push(format!("access_tokens/{}: grant {have}, want {}", text(c, "name"), c["grant"]));
                }
            }
            t.verdict("access_tokens", c, code(got));
        }

        for c in doc["dpop"].as_array().unwrap() {
            let mut cache = JtiCache::dpop();
            for j in c["seen_jti"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                cache.admit("", j, now).unwrap();
            }
            let at = Some(text(c, "access_token")).filter(|a| !a.is_empty());
            let got = verify_dpop(text(c, "proof"), text(c, "htm"), text(c, "htu"), at, now, &mut cache, "");
            if let Ok(jkt) = &got {
                if jkt != text(c, "jkt") {
                    t.wrong.push(format!("dpop/{}: jkt {jkt}, want {}", text(c, "name"), text(c, "jkt")));
                }
            }
            t.verdict("dpop", c, code(got));
        }

        for c in doc["client_assertions"].as_array().unwrap() {
            let creds = find_client(&base, org, text(c, "client_id")).map(|cl| usable_credentials(cl, base.active(org))).unwrap_or_default();
            let got = verify_client_assertion(text(c, "assertion"), text(c, "client_id"), text(&doc, "token_endpoint"), &creds, &[], now, &mut JtiCache::assertion());
            t.verdict("client_assertions", c, code(got));
        }

        for c in doc["subject_tokens"].as_array().unwrap() {
            let jwks = c["jwks"]["keys"].as_array().cloned().unwrap_or_default();
            let got = verify_subject_token(text(c, "token"), &c["credential"], &jwks, text(c, "discovery_issuer"), now);
            t.verdict("subject_tokens", c, code(got));
        }

        for c in doc["lifetimes"].as_array().unwrap() {
            let l = Lifetime {
                iat: c["iat"].as_i64().unwrap(),
                unbound: c["unbound"].as_bool().unwrap(),
                registration_end: c["registration_end"].as_i64().unwrap(),
                grace_hours: c["grace_hours"].as_u64().unwrap() as u32,
                cert_end: c["cert_end"].as_i64(),
                key_end: c["key_end"].as_i64(),
                subject_exp: c["subject_exp"].as_i64(),
                map_expires: c["map_expires"].as_i64().unwrap(),
            };
            let got = token_exp(&l);
            t.seen += 1;
            if got != c["expect_exp"].as_i64().unwrap() {
                t.wrong.push(format!("lifetimes/{}: got {got}, want {}", text(c, "name"), c["expect_exp"]));
            }
        }

        for c in doc["secrets"].as_array().unwrap() {
            let got = if verify_client_secret(text(c, "secret"), text(c, "sha256")) { "ok" } else { "client-auth" };
            t.verdict("secrets", c, got);
        }

        assert!(t.wrong.is_empty(), "{} vector(s) disagree:\n{}", t.wrong.len(), t.wrong.join("\n"));
        assert!(t.seen >= 70, "only {} cases", t.seen);
        for want in ["ok", "token", "expired", "map-behind", "suspended", "owner", "cnf", "dpop", "dpop-replay", "denied", "client-auth", "subject"] {
            assert!(t.codes.contains(want), "no vector gives {want}");
        }
    }
}
