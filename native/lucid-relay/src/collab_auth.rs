// The collab broker's OPTIONAL Firebase identity gate, rule for rule desktop/collab/relay_auth.ts (P-REMOTE.1,
// ADR-0226/0227): the first frame `{"t":"auth","token":"<Firebase ID token>"}` carries an RS256 JWT, checked against
// Google's securetoken JWKS (fetched lazily, cached by Cache-Control max-age, an unknown kid refetching at most once a
// minute), then admitted on an `admin` or `premium` claim or an allowlisted email. Every failure refuses: 4401, or
// 4403 for a verified sign-in that is not entitled. The RSA check is AWS-LC's (its FIPS module with `fips`).

use crate::codec::{b64_decode_lenient, js_number_string, parse_json, utf8_lossy};
use crate::http_client::HttpClient;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::time::Duration;

const GOOGLE_SECURETOKEN_JWKS: &str = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MIN_REFETCH_MS: i64 = 60_000;
const JWKS_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Ok { uid: String, email: String, premium: bool, admin: bool },
    Refused { code: u16, reason: String },
}

fn refuse(reason: impl Into<String>) -> Verdict {
    Verdict::Refused { code: 4401, reason: reason.into() }
}

/// `String(v)` for the values a JWT header may hold.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

struct Jwt {
    header: Map<String, Value>,
    payload: Map<String, Value>,
    signed_input: Vec<u8>,
    signature: Vec<u8>,
}

/// decodeJwt: structure only; header and payload must each be a JSON object (or array, as `typeof` sees it).
fn decode_jwt(token: &str) -> Option<Jwt> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let object = |s: &str| match parse_json(&utf8_lossy(&b64_decode_lenient(s)))? {
        Value::Object(o) => Some(o),
        Value::Array(_) => Some(Map::new()),
        _ => None,
    };
    Some(Jwt {
        header: object(parts[0])?,
        payload: object(parts[1])?,
        signed_input: format!("{}.{}", parts[0], parts[1]).into_bytes(),
        signature: b64_decode_lenient(parts[2]),
    })
}

/// admissionDecision over a VERIFIED payload.
pub fn admission(payload: &Map<String, Value>, allowed: &[String]) -> Verdict {
    let uid = payload.get("sub").and_then(Value::as_str).filter(|s| !s.is_empty());
    let email = payload.get("email").and_then(Value::as_str).map(str::to_lowercase).unwrap_or_default();
    let Some(uid) = uid else { return refuse("token has no subject") };
    let admin = payload.get("admin") == Some(&Value::Bool(true));
    let premium = payload.get("premium") == Some(&Value::Bool(true));
    if admin || premium || (!email.is_empty() && allowed.contains(&email)) {
        return Verdict::Ok { uid: uid.to_owned(), email, premium: premium || admin, admin };
    }
    Verdict::Refused { code: 4403, reason: "signed in but not entitled (no premium/admin claim, not allowlisted)".into() }
}

struct JwksCache {
    keys: HashMap<String, Map<String, Value>>,
    expires_at: i64,
    fetched_at: i64,
}

pub struct FirebaseVerifier {
    project_id: String,
    allowed: Vec<String>,
    jwks_url: String,
    expected_iss: String,
    client: HttpClient,
    cache: Mutex<Option<JwksCache>>,
}

impl FirebaseVerifier {
    pub fn new(project_id: &str, allowed: Vec<String>, jwks_url: Option<String>, client: HttpClient) -> FirebaseVerifier {
        FirebaseVerifier {
            project_id: project_id.to_owned(),
            allowed: allowed.into_iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect(),
            jwks_url: jwks_url.unwrap_or_else(|| GOOGLE_SECURETOKEN_JWKS.into()),
            expected_iss: format!("https://securetoken.google.com/{project_id}"),
            client,
            cache: Mutex::new(None),
        }
    }

    async fn jwk(&self, kid: &str) -> Result<Option<Map<String, Value>>, String> {
        let t = crate::codec::now_ms();
        {
            let cache = self.cache.lock();
            if let Some(c) = cache.as_ref() {
                if (c.keys.contains_key(kid) || t < c.fetched_at + MIN_REFETCH_MS) && t < c.expires_at {
                    return Ok(c.keys.get(kid).cloned());
                }
            }
        }
        let res = self.client.send("GET", &self.jwks_url, &[], Vec::new(), JWKS_TIMEOUT).await?;
        if !res.ok() {
            return Err(format!("jwks fetch failed: {}", res.status));
        }
        let body = parse_json(&utf8_lossy(&res.body)).ok_or("JSON Parse error: Unable to parse JSON string")?;
        let mut keys = HashMap::new();
        match body.get("keys") {
            None | Some(Value::Null) => {}
            Some(Value::Array(list)) => {
                for k in list {
                    if let Some(o) = k.as_object() {
                        if let Some(id) = o.get("kid").and_then(Value::as_str) {
                            keys.insert(id.to_owned(), o.clone());
                        }
                    }
                }
            }
            Some(_) => return Err("body.keys is not iterable".into()),
        }
        let max_age = res.header("cache-control").and_then(|cc| {
            let i = cc.find("max-age=")?;
            let digits: String = cc[i + 8..].chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<i64>().ok()
        });
        let ttl = max_age.map_or(3_600_000, |s| s * 1000);
        let found = keys.get(kid).cloned();
        *self.cache.lock() = Some(JwksCache { keys, expires_at: t + ttl, fetched_at: t });
        Ok(found)
    }

    /// RSASSA-PKCS1-v1_5 / SHA-256 with a JWK, as WebCrypto importKey("jwk") then verify judge it.
    fn rsa_verify(jwk: &Map<String, Value>, message: &[u8], signature: &[u8]) -> Result<bool, String> {
        let field = |k: &str| jwk.get(k).and_then(Value::as_str);
        if field("kty") != Some("RSA") {
            return Err("The JWK \"kty\" member was not \"RSA\"".into());
        }
        if jwk.get("alg").is_some_and(|a| a.as_str() != Some("RS256")) {
            return Err("The JWK \"alg\" member was inconsistent with that specified by the Web Crypto call".into());
        }
        if jwk.get("use").is_some_and(|u| u.as_str() != Some("sig")) {
            return Err("The JWK \"use\" member was not \"sig\"".into());
        }
        let (Some(n), Some(e)) = (field("n"), field("e")) else { return Err("The JWK member \"n\" or \"e\" was missing".into()) };
        let (n, e) = (b64_decode_lenient(n), b64_decode_lenient(e));
        let key = aws_lc_rs::signature::RsaPublicKeyComponents { n: n.as_slice(), e: e.as_slice() };
        Ok(key.verify(&aws_lc_rs::signature::RSA_PKCS1_2048_8192_SHA256, message, signature).is_ok())
    }

    /// Every failure to reach a valid verdict is a refusal, never a pass.
    pub async fn verify(&self, token: &str) -> Verdict {
        match self.check(token).await {
            Ok(v) => v,
            Err(e) => refuse(format!("verification unavailable: {e}")),
        }
    }

    async fn check(&self, token: &str) -> Result<Verdict, String> {
        let Some(jwt) = decode_jwt(token) else { return Ok(refuse("malformed token")) };
        if jwt.header.get("alg").and_then(Value::as_str) != Some("RS256") {
            return Ok(refuse(format!("alg must be RS256, got {}", js_string(jwt.header.get("alg")))));
        }
        let Some(kid) = jwt.header.get("kid").and_then(Value::as_str).filter(|k| !k.is_empty()) else { return Ok(refuse("token has no kid")) };
        let p = &jwt.payload;
        let t = crate::codec::now_ms() as f64;
        let skew = 60_000.0;
        let exp_ms = p.get("exp").and_then(Value::as_f64).map_or(0.0, |e| e * 1000.0);
        let iat_ms = p.get("iat").and_then(Value::as_f64).map_or(f64::INFINITY, |i| i * 1000.0);
        if exp_ms + skew <= t {
            return Ok(refuse("token expired"));
        }
        if iat_ms - skew > t {
            return Ok(refuse("token issued in the future"));
        }
        if p.get("aud").and_then(Value::as_str) != Some(self.project_id.as_str()) {
            return Ok(refuse("aud mismatch"));
        }
        if p.get("iss").and_then(Value::as_str) != Some(self.expected_iss.as_str()) {
            return Ok(refuse("iss mismatch"));
        }
        if p.get("email_verified") != Some(&Value::Bool(true)) {
            return Ok(refuse("email not verified"));
        }
        let provider = p.get("firebase").and_then(|f| f.get("sign_in_provider")).and_then(Value::as_str);
        if provider != Some("google.com") {
            return Ok(refuse("only Google sign-in is accepted"));
        }
        let Some(jwk) = self.jwk(kid).await? else { return Ok(refuse("unknown signing key")) };
        if !Self::rsa_verify(&jwk, &jwt.signed_input, &jwt.signature)? {
            return Ok(refuse("bad signature"));
        }
        Ok(admission(p, &self.allowed))
    }
}

/// The gate as relay_server.ts takes it, with its quotas.
pub struct AuthGate {
    pub verifier: FirebaseVerifier,
    pub deadline_ms: u64,
    pub max_rooms_per_user: usize,
    pub max_connects_per_minute: usize,
    pub reclaim_grace_ms: u64,
}

fn positive(v: Option<&String>) -> Option<f64> {
    let n = crate::codec::js_number(v?);
    (n.is_finite() && n > 0.0).then_some(n)
}

/// authFromEnv: off (anonymous) or firebase; a half-configured gate is an error, never an open relay.
pub fn auth_from_env(env: &HashMap<String, String>, client: &HttpClient) -> Result<(Option<AuthGate>, String), String> {
    let mode = env.get("RELAY_AUTH").map(|m| m.trim().to_lowercase()).unwrap_or_else(|| "off".into());
    if mode == "off" || mode.is_empty() {
        return Ok((None, "auth: anonymous (set RELAY_AUTH=firebase to require Google sign-in)".into()));
    }
    if mode != "firebase" {
        return Err(format!("RELAY_AUTH must be \"firebase\" or \"off\", got \"{mode}\""));
    }
    let project = env.get("RELAY_FIREBASE_PROJECT").map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).ok_or("RELAY_AUTH=firebase requires RELAY_FIREBASE_PROJECT")?;
    let allowed: Vec<String> = env.get("RELAY_ALLOWED_EMAILS").map(String::as_str).unwrap_or("").split(',').map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect();
    let integer = |k: &str| positive(env.get(k)).filter(|n| n.fract() == 0.0);
    let grace = env.get("RELAY_RECLAIM_GRACE_MS").filter(|g| !g.trim().is_empty()).map(|g| crate::codec::js_number(g)).filter(|g| g.is_finite() && *g >= 0.0);
    let summary = format!("auth: firebase (project {project}, {} allowlisted email{})", allowed.len(), if allowed.len() == 1 { "" } else { "s" });
    let jwks = env.get("RELAY_JWKS_URL").map(|u| u.trim().to_owned()).filter(|u| !u.is_empty());
    let gate = AuthGate {
        deadline_ms: positive(env.get("RELAY_AUTH_DEADLINE_MS")).map_or(5000, |d| d.ceil() as u64),
        max_rooms_per_user: integer("RELAY_MAX_ROOMS_PER_USER").map_or(4, |n| n as usize),
        max_connects_per_minute: integer("RELAY_MAX_CONNECTS_PER_MINUTE").map_or(30, |n| n as usize),
        reclaim_grace_ms: grace.map_or(30_000, |g| g.ceil() as u64),
        verifier: FirebaseVerifier::new(&project, allowed, jwks, client.clone()),
    };
    Ok((Some(gate), summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_matches_relay_auth() {
        let m = |v: Value| v.as_object().cloned().unwrap();
        let base = serde_json::json!({ "sub": "u", "email": "A@B.com", "email_verified": true });
        let with = |k: &str, v: Value| {
            let mut o = m(base.clone());
            o.insert(k.into(), v);
            o
        };
        assert!(matches!(admission(&with("sub", Value::from("")), &[]), Verdict::Refused { code: 4401, .. }));
        assert_eq!(admission(&with("premium", Value::Bool(true)), &[]), Verdict::Ok { uid: "u".into(), email: "a@b.com".into(), premium: true, admin: false });
        assert_eq!(admission(&with("admin", Value::Bool(true)), &[]), Verdict::Ok { uid: "u".into(), email: "a@b.com".into(), premium: true, admin: true });
        assert!(matches!(admission(&m(base.clone()), &["a@b.com".into()]), Verdict::Ok { .. }));
        assert!(matches!(admission(&m(base), &[]), Verdict::Refused { code: 4403, .. }));
    }

    #[test]
    fn malformed_tokens_and_algs() {
        assert!(decode_jwt("not-a-jwt").is_none());
        assert!(decode_jwt("a.b").is_none());
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&Value::from("HS256"))), "HS256");
    }
}
