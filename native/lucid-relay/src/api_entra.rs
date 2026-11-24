// Contract API-1 revision 4 (docs/api/contract-r4-1b.md) 4.1: `entra_wif`, Microsoft Entra provisioning by workload
// identity federation. The tenant's key set (fetched under revision 3 8.1; refreshed every 24 hours and when an unknown
// `kid` arrives, at most once a minute; a key missing from a successful fetch dropped at once; cached keys usable for
// at most 48 hours after the last successful fetch, Rev4Review R4-15) and the checks of an Entra `client_assertion` in
// the contract's order. Stage (a) of ruling R4-D20 only: `aud` must equal the stored `audience`, which the map forces
// to be the issuer `I`; the Entra audience form stays off behind gate G-ENTRA-WIF-AUD.
//
// The token endpoint (`api_issue::entra_wif_auth`) calls `credential` and `verify`. Every failure is 401 `client-auth`
// (a full `uti` cache share is `abuse`) and names its step (`Failed::step`) for the audit. Neither the assertion nor
// any Authorization value is written to a log or an audit entry.

use crate::api_fetch::{check_url, FetchError, FetchUrl, Limits};
use crate::api_token::{self as tok, Alg, JtiCache, PublicKey};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// The key set is fetched again once its last successful fetch is this old.
pub const REFRESH_EVERY: i64 = 86_400;
/// Fetches of one key set are at least this far apart (an unknown `kid`, a failing endpoint).
pub const FETCH_EVERY: i64 = 60;
/// Cached keys are refused once the last successful fetch is older than this.
pub const STALE_AFTER: i64 = 48 * 3600;
/// The release gate that turns on `cloud: usgov` credentials (revision 4 19.3); disabled, as every gate starts.
pub const USGOV_GATE: &str = "G-ENTRA-WIF-USGOV";
/// The largest key set body (revision 3 8.1).
const KEYS_MAX: usize = 256 * 1024;
const UTI_MAX: usize = 128;

/// The Entra authority host of a credential's `cloud` (ID-1 2.2: the US Government clouds share one host).
pub fn authority(cloud: &str) -> Option<&'static str> {
    match cloud {
        "public" => Some("https://login.microsoftonline.com"),
        "usgov" => Some("https://login.microsoftonline.us"),
        _ => None,
    }
}

/// The exact `iss` of the tenant's v2.0 tokens.
pub fn issuer_of(cloud: &str, tenant: &str) -> Option<String> {
    authority(cloud).map(|a| format!("{a}/{tenant}/v2.0"))
}

/// The tenant's key set URL.
pub fn keys_url(cloud: &str, tenant: &str) -> Option<String> {
    authority(cloud).map(|a| format!("{a}/{tenant}/discovery/v2.0/keys"))
}

/// A refused assertion: the contract code, the step the audit names (`entra_wif.<step>`), a sentence for the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failed {
    pub code: &'static str,
    pub step: &'static str,
    pub message: String,
}

fn failed(step: &'static str, message: impl Into<String>) -> Failed {
    Failed { code: "client-auth", step, message: message.into() }
}

/// A client whose map entry lists an `entra_wif` credential (under a journaled drop or not).
pub fn is_entra_client(client: &Map<String, Value>) -> bool {
    client.get("credentials").and_then(Value::as_array).is_some_and(|c| c.iter().any(|cr| cr.get("type").and_then(Value::as_str) == Some("entra_wif")))
}

/// Step 1: the client's `entra_wif` credential among its usable ones (not under `client_drop_credential`), within its
/// `expires`, of a cloud this build serves (`usgov` only once `USGOV_GATE` is verified, `RELAY_GATES`).
pub fn credential<'a>(usable: &[&'a Value], now: i64) -> Result<&'a Value, Failed> {
    let Some(cr) = usable.iter().copied().find(|c| c.get("type").and_then(Value::as_str) == Some("entra_wif")) else {
        return Err(failed("entra_wif.credential", "this client has no usable entra_wif credential"));
    };
    if cr.get("expires").and_then(Value::as_i64).is_none_or(|e| now > e) {
        return Err(failed("entra_wif.credential-expired", "the entra_wif credential has expired"));
    }
    match cr.get("cloud").and_then(Value::as_str) {
        Some("public") => Ok(cr),
        Some("usgov") if crate::meet_org_policy::RELAY_GATES.contains(&USGOV_GATE) => Ok(cr),
        Some("usgov") => Err(failed("entra_wif.usgov-gate", "US Government Entra credentials wait for gate G-ENTRA-WIF-USGOV")),
        _ => Err(failed("entra_wif.credential", "the entra_wif credential names no known cloud")),
    }
}

// ---- the tenant key set (step 2) ----------------------------------------------------------------------------------

/// Fetches a key set document (tests substitute their own).
pub type Fetcher = dyn Fn(&FetchUrl) -> Result<Value, FetchError> + Send + Sync;

struct KeySet {
    keys: Vec<Value>,
    /// The last successful fetch.
    fetched: Option<i64>,
    /// The last attempt.
    tried: i64,
    /// Why the last attempt failed.
    error: Option<String>,
}

/// One listener's Entra key sets, by key set URL.
pub struct EntraKeys {
    sets: Mutex<HashMap<String, KeySet>>,
    fetcher: Box<Fetcher>,
}

impl Default for EntraKeys {
    fn default() -> EntraKeys {
        EntraKeys::with_fetcher(Box::new(|u: &FetchUrl| -> Result<Value, FetchError> { crate::api_fetch::fetch_json_blocking(u, false, KEYS_MAX, Limits::default()) }))
    }
}

fn kid_of(k: &Value) -> Option<&str> {
    k.get("kid").and_then(Value::as_str)
}

impl EntraKeys {
    pub fn with_fetcher(fetcher: Box<Fetcher>) -> EntraKeys {
        EntraKeys { sets: Mutex::default(), fetcher }
    }

    /// The JWK named `kid` in the key set at `url`. The set is fetched (public addresses only) when it never was, when
    /// its last successful fetch is 24 hours old, or when `kid` is not in it; never twice within a minute. A
    /// successful fetch replaces the set, so a key Entra removed is gone at once; a failed one keeps it, usable until
    /// 48 hours after the last success (`entra_wif.keys` after that, and before any success). No lock is held while
    /// fetching.
    pub fn key(&self, url: &str, kid: &str, now: i64) -> Result<Value, Failed> {
        let due = {
            let mut m = self.sets.lock();
            let s = m.entry(url.to_string()).or_insert(KeySet { keys: Vec::new(), fetched: None, tried: i64::MIN, error: None });
            let old = s.fetched.is_none_or(|f| now.saturating_sub(f) >= REFRESH_EVERY);
            let unknown = !s.keys.iter().any(|k| kid_of(k) == Some(kid));
            let due = (old || unknown) && now.saturating_sub(s.tried) >= FETCH_EVERY;
            if due {
                s.tried = now;
            }
            due
        };
        if due {
            let got = check_url(url).and_then(|u| (self.fetcher)(&u));
            let mut m = self.sets.lock();
            if let Some(s) = m.get_mut(url) {
                match got.as_ref().map(|d| d.get("keys").and_then(Value::as_array)) {
                    Ok(Some(keys)) => {
                        s.keys = keys.clone();
                        s.fetched = Some(now);
                        s.error = None;
                    }
                    Ok(None) => s.error = Some("the key set has no keys array".into()),
                    Err(e) => s.error = Some(e.to_string()),
                }
            }
        }
        let m = self.sets.lock();
        let Some(s) = m.get(url) else { return Err(failed("entra_wif.keys", "the Entra key set is not held")) };
        let why = || s.error.as_deref().map(|e| format!(" ({e})")).unwrap_or_default();
        match s.fetched {
            None => return Err(failed("entra_wif.keys", format!("the Entra key set could not be fetched{}", why()))),
            Some(f) if now.saturating_sub(f) > STALE_AFTER => {
                return Err(failed("entra_wif.keys", format!("the Entra key set was last fetched more than 48 hours ago{}", why())));
            }
            Some(_) => {}
        }
        s.keys.iter().find(|k| kid_of(k) == Some(kid)).cloned().ok_or_else(|| failed("entra_wif.kid", "the assertion's kid is not in the tenant's key set"))
    }
}

// ---- the assertion (steps 2 to 5) ---------------------------------------------------------------------------------

/// A verified assertion: its `exp` (the access token never outlives it, R4-16) and the credential's `expires`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verified {
    pub exp: i64,
    pub expires: i64,
}

/// Revision 4 4.1 steps 2 to 5 for the `entra_wif` `credential` of `client_id`, in order:
/// 2. a compact JWS with header `alg` RS256 (`typ` not required) and a `kid` of the tenant's key set, an RSA key of
///    2048 bits or more, the signature valid;
/// 3. `iss` exactly `<authority>/<tenant>/v2.0`, `tid` the tenant, `aud` a single string (or an array of exactly one)
///    equal to the stored `audience`, `azp` the configured `azp`;
/// 4. `exp` after `now`, `iat` present, `iat` and `nbf` not more than 60 s ahead, `exp - iat` at most 7200;
/// 5. `uti` not seen for this client before (held past `exp`).
pub fn verify(assertion: &str, client_id: &str, credential: &Value, keys: &EntraKeys, now: i64, utis: &Mutex<JtiCache>) -> Result<Verified, Failed> {
    let s = |k: &str| credential.get(k).and_then(Value::as_str).unwrap_or_default();
    let (cloud, tenant, audience, azp) = (s("cloud"), s("tenant"), s("audience"), s("azp"));
    let expires = credential.get("expires").and_then(Value::as_i64).unwrap_or(i64::MIN);
    let (Some(want_iss), Some(url)) = (issuer_of(cloud, tenant), keys_url(cloud, tenant)) else {
        return Err(failed("entra_wif.credential", "the entra_wif credential names no known cloud"));
    };
    // 2
    let jws = tok::parse_jws(assertion).ok_or_else(|| failed("entra_wif.jws", "the client assertion is not a compact JWS"))?;
    let h = |k: &str| jws.header.get(k).and_then(Value::as_str);
    if h("alg") != Some("RS256") {
        return Err(failed("entra_wif.alg", "the Entra assertion's alg is not RS256"));
    }
    let Some(kid) = h("kid") else { return Err(failed("entra_wif.kid", "the Entra assertion names no kid")) };
    let jwk = keys.key(&url, kid, now)?;
    let Some(key) = tok::parse_jwk(&jwk, tok::ISSUER_RSA_MIN_BITS).filter(|k| matches!(k, PublicKey::Rsa { .. })) else {
        return Err(failed("entra_wif.key", "the tenant's key is not an RSA key of 2048 bits or more"));
    };
    if !tok::verify_signature(&key, Alg::Rs256, jws.signing_input.as_bytes(), &jws.signature) {
        return Err(failed("entra_wif.signature", "the Entra assertion's signature does not verify"));
    }
    // 3
    let c = |k: &str| jws.claims.get(k);
    let cs = |k: &str| c(k).and_then(Value::as_str);
    if cs("iss") != Some(want_iss.as_str()) {
        return Err(failed("entra_wif.iss", "the Entra assertion is from another issuer"));
    }
    if cs("tid") != Some(tenant) {
        return Err(failed("entra_wif.tid", "the Entra assertion is from another tenant"));
    }
    let aud_ok = match c("aud") {
        Some(Value::String(a)) => a == audience,
        Some(Value::Array(a)) => a.len() == 1 && a[0].as_str() == Some(audience),
        _ => false,
    };
    if !aud_ok {
        return Err(failed("entra_wif.aud", "the Entra assertion is for another audience"));
    }
    if cs("azp") != Some(azp) {
        return Err(failed("entra_wif.azp", "the Entra assertion is from another application"));
    }
    // 4
    let int = |k: &str| match c(k) {
        None => Ok(None),
        Some(v) => v.as_i64().map(Some).ok_or(()),
    };
    let Ok(Some(exp)) = int("exp") else { return Err(failed("entra_wif.exp", "the Entra assertion needs exp")) };
    if exp <= now {
        return Err(failed("entra_wif.exp", "the Entra assertion has expired"));
    }
    let Ok(Some(iat)) = int("iat") else { return Err(failed("entra_wif.iat", "the Entra assertion needs iat")) };
    if iat > now.saturating_add(tok::SKEW) {
        return Err(failed("entra_wif.iat", "the Entra assertion is from the future"));
    }
    let Ok(nbf) = int("nbf") else { return Err(failed("entra_wif.nbf", "the Entra assertion's nbf is not a time")) };
    if nbf.is_some_and(|n| n > now.saturating_add(tok::SKEW)) {
        return Err(failed("entra_wif.nbf", "the Entra assertion is not valid yet"));
    }
    if exp.saturating_sub(iat) > tok::ENTRA_SPAN_MAX {
        return Err(failed("entra_wif.span", "the Entra assertion lasts more than 7200 s"));
    }
    // 5
    let Some(uti) = cs("uti").filter(|u| !u.is_empty() && u.len() <= UTI_MAX) else { return Err(failed("entra_wif.uti", "the Entra assertion needs a uti")) };
    tok::admit_uti(&mut utis.lock(), client_id, uti, now).map_err(|e| Failed { code: e.code, step: "entra_wif.uti", message: e.message })?;
    Ok(Verified { exp, expires })
}

/// A throwaway RSA 2048 signing key for tests (the token endpoint's tests use it too).
#[cfg(test)]
pub(crate) mod testkey {
    use crate::codec::b64u;
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::rsa::KeySize;
    use aws_lc_rs::signature::{KeyPair, RsaKeyPair, RSA_PKCS1_SHA256};
    use serde_json::{json, Value};

    pub struct Key {
        pair: RsaKeyPair,
        pub kid: String,
    }

    fn unsigned(b: &[u8]) -> Vec<u8> {
        let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
        b[i..].to_vec()
    }

    impl Key {
        pub fn new(kid: &str) -> Key {
            Key { pair: RsaKeyPair::generate(KeySize::Rsa2048).expect("an RSA key"), kid: kid.into() }
        }

        /// The public JWK (`n` and `e` from the RSAPublicKey DER).
        pub fn jwk(&self) -> Value {
            let seq = crate::der::tlv(self.pair.public_key().as_ref()).expect("an RSAPublicKey");
            let n = crate::der::tlv(seq.value).expect("n");
            let e = crate::der::tlv(n.rest).expect("e");
            json!({"kty": "RSA", "use": "sig", "kid": self.kid, "n": b64u(&unsigned(n.value)), "e": b64u(&unsigned(e.value))})
        }

        /// `header.claims.signature`, RS256.
        pub fn sign(&self, header: &Value, claims: &Value) -> String {
            let input = format!("{}.{}", b64u(&serde_json::to_vec(header).unwrap()), b64u(&serde_json::to_vec(claims).unwrap()));
            let mut sig = vec![0u8; self.pair.public_modulus_len()];
            self.pair.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), input.as_bytes(), &mut sig).expect("an RS256 signature");
            format!("{input}.{}", b64u(&sig))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkey::Key;
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const NOW: i64 = 1_795_000_000;
    const TENANT: &str = "ce5f061f-abe6-4e40-9615-301f87bcb7f0";
    const AZP: &str = "cb1d50fe-8ed0-4944-9e7d-5981aad3bc4b";
    const ISSUER: &str = "https://console.acme.example:7443/api/orgs/acme";
    const CLIENT: &str = "c_2c3d4e5f60718293";

    /// A key set endpoint whose document the test sets (None: the fetch fails) and whose fetches it counts.
    #[derive(Clone, Default)]
    struct Endpoint {
        doc: Arc<parking_lot::Mutex<Option<Value>>>,
        fetches: Arc<AtomicUsize>,
    }

    impl Endpoint {
        fn serving(keys: &[Value]) -> Endpoint {
            let e = Endpoint::default();
            e.set(Some(keys));
            e
        }

        fn set(&self, keys: Option<&[Value]>) {
            *self.doc.lock() = keys.map(|k| json!({ "keys": k }));
        }

        fn count(&self) -> usize {
            self.fetches.load(Ordering::SeqCst)
        }

        fn keys(&self) -> EntraKeys {
            let me = self.clone();
            EntraKeys::with_fetcher(Box::new(move |u: &FetchUrl| -> Result<Value, FetchError> {
                assert_eq!(u.url, keys_url("public", TENANT).unwrap());
                me.fetches.fetch_add(1, Ordering::SeqCst);
                me.doc.lock().clone().ok_or(FetchError { code: "connect", message: "the endpoint is down".into() })
            }))
        }
    }

    fn cred() -> Value {
        json!({"type": "entra_wif", "cloud": "public", "tenant": TENANT, "audience": ISSUER, "azp": AZP, "expires": NOW + 30 * 86_400})
    }

    fn claims(uti: &str) -> Value {
        json!({"aud": ISSUER, "iss": format!("https://login.microsoftonline.com/{TENANT}/v2.0"), "iat": NOW - 60, "nbf": NOW - 60,
               "exp": NOW + 3540, "azp": AZP, "azpacr": "2", "oid": "5a1b7c2d-0000-4000-8000-000000000001",
               "sub": "5a1b7c2d-0000-4000-8000-000000000001", "tid": TENANT, "uti": uti, "ver": "2.0"})
    }

    fn signed(key: &Key, claims: &Value) -> String {
        key.sign(&json!({"alg": "RS256", "kid": key.kid, "typ": "JWT"}), claims)
    }

    fn step(r: Result<Verified, Failed>) -> &'static str {
        match r {
            Ok(_) => "ok",
            Err(f) => f.step,
        }
    }

    fn url() -> String {
        keys_url("public", TENANT).unwrap()
    }

    #[test]
    fn urls_follow_the_cloud() {
        assert_eq!(issuer_of("public", TENANT).unwrap(), format!("https://login.microsoftonline.com/{TENANT}/v2.0"));
        assert_eq!(keys_url("usgov", TENANT).unwrap(), format!("https://login.microsoftonline.us/{TENANT}/discovery/v2.0/keys"));
        assert!(authority("china").is_none());
    }

    #[test]
    fn step_one_needs_a_live_credential_of_a_served_cloud() {
        let good = cred();
        assert!(credential(&[&good], NOW).is_ok());
        assert_eq!(credential(&[], NOW).unwrap_err().step, "entra_wif.credential", "none, or dropped by the journal");
        let mut old = cred();
        old["expires"] = json!(NOW - 1);
        assert_eq!(credential(&[&old], NOW).unwrap_err().step, "entra_wif.credential-expired");
        let mut gov = cred();
        gov["cloud"] = json!("usgov");
        assert!(!crate::meet_org_policy::RELAY_GATES.contains(&USGOV_GATE));
        assert_eq!(credential(&[&gov], NOW).unwrap_err().step, "entra_wif.usgov-gate");
        assert!(credential(&[&gov], NOW).unwrap_err().code == "client-auth");
    }

    #[test]
    fn a_good_assertion_then_each_failing_claim() {
        let key = Key::new("k-entra-1");
        let ep = Endpoint::serving(&[key.jwk()]);
        let keys = ep.keys();
        let utis = Mutex::new(JtiCache::uti());
        let cr = cred();
        let run = |c: &Value| step(verify(&signed(&key, c), CLIENT, &cr, &keys, NOW, &utis));
        let good = verify(&signed(&key, &claims("u-1")), CLIENT, &cr, &keys, NOW, &utis).unwrap();
        assert_eq!(good, Verified { exp: NOW + 3540, expires: NOW + 30 * 86_400 });
        let with = |k: &str, v: Value, uti: &str| {
            let mut c = claims(uti);
            c[k] = v;
            c
        };
        assert_eq!(run(&with("iss", json!(format!("https://login.microsoftonline.com/{AZP}/v2.0")), "u-2")), "entra_wif.iss");
        assert_eq!(run(&with("iss", json!(format!("https://sts.windows.net/{TENANT}/")), "u-3")), "entra_wif.iss");
        assert_eq!(run(&with("tid", json!(AZP), "u-4")), "entra_wif.tid");
        assert_eq!(run(&with("aud", json!(format!("{ISSUER}/oauth/token")), "u-5")), "entra_wif.aud");
        assert_eq!(run(&with("aud", json!([ISSUER, "api://other"]), "u-6")), "entra_wif.aud");
        assert_eq!(run(&with("aud", json!([ISSUER]), "u-7")), "ok", "a one-element array");
        assert_eq!(run(&with("azp", json!(TENANT), "u-8")), "entra_wif.azp");
        assert_eq!(run(&with("exp", json!(NOW), "u-9")), "entra_wif.exp");
        assert_eq!(run(&with("iat", json!(NOW + 61), "u-10")), "entra_wif.iat");
        assert_eq!(run(&with("nbf", json!(NOW + 61), "u-11")), "entra_wif.nbf");
        assert_eq!(run(&with("iat", json!(NOW + 3540 - 7201), "u-12")), "entra_wif.span");
        assert_eq!(run(&with("uti", json!(""), "")), "entra_wif.uti");
        assert_eq!(run(&claims("u-1")), "entra_wif.uti", "a replayed uti");
        // the same uti for another client is that client's first
        assert_eq!(step(verify(&signed(&key, &claims("u-1")), "c_other", &cr, &keys, NOW, &utis)), "ok");
        // header checks
        let a = key.sign(&json!({"alg": "PS256", "kid": key.kid}), &claims("u-13"));
        assert_eq!(step(verify(&a, CLIENT, &cr, &keys, NOW, &utis)), "entra_wif.alg");
        let hs = {
            let input = format!("{}.{}", crate::codec::b64u(br#"{"alg":"HS256","kid":"k-entra-1"}"#), crate::codec::b64u(claims("u-14").to_string().as_bytes()));
            format!("{input}.{}", crate::codec::b64u(&[7u8; 32]))
        };
        assert_eq!(step(verify(&hs, CLIENT, &cr, &keys, NOW, &utis)), "entra_wif.alg");
        let a = key.sign(&json!({"alg": "RS256"}), &claims("u-15"));
        assert_eq!(step(verify(&a, CLIENT, &cr, &keys, NOW, &utis)), "entra_wif.kid");
        let other = Key::new("k-entra-1");
        assert_eq!(step(verify(&signed(&other, &claims("u-16")), CLIENT, &cr, &keys, NOW, &utis)), "entra_wif.signature");
        assert_eq!(step(verify("not a jwt", CLIENT, &cr, &keys, NOW, &utis)), "entra_wif.jws");
    }

    #[test]
    fn a_key_entra_removed_is_refused_after_the_next_daily_refresh() {
        let (a, b) = (Key::new("k-a"), Key::new("k-b"));
        let ep = Endpoint::serving(&[a.jwk(), b.jwk()]);
        let keys = ep.keys();
        assert!(keys.key(&url(), "k-a", NOW).is_ok());
        assert_eq!(ep.count(), 1);
        ep.set(Some(&[b.jwk()]));
        assert!(keys.key(&url(), "k-a", NOW + 3600).is_ok(), "still cached until the daily refresh");
        assert_eq!(ep.count(), 1);
        assert_eq!(keys.key(&url(), "k-a", NOW + REFRESH_EVERY).unwrap_err().step, "entra_wif.kid");
        assert_eq!(ep.count(), 2);
        assert!(keys.key(&url(), "k-b", NOW + REFRESH_EVERY + 1).is_ok());
        assert_eq!(ep.count(), 2);
    }

    #[test]
    fn an_unknown_kid_fetches_at_most_once_a_minute() {
        let (a, c) = (Key::new("k-a"), Key::new("k-c"));
        let ep = Endpoint::serving(&[a.jwk()]);
        let keys = ep.keys();
        assert!(keys.key(&url(), "k-a", NOW).is_ok());
        assert_eq!(keys.key(&url(), "k-c", NOW + 10).unwrap_err().step, "entra_wif.kid");
        assert_eq!(ep.count(), 1, "within a minute of the last fetch");
        ep.set(Some(&[a.jwk(), c.jwk()]));
        assert_eq!(keys.key(&url(), "k-c", NOW + 59).unwrap_err().step, "entra_wif.kid");
        assert!(keys.key(&url(), "k-c", NOW + 60).is_ok());
        assert_eq!(ep.count(), 2);
        assert_eq!(keys.key(&url(), "k-z", NOW + 70).unwrap_err().step, "entra_wif.kid");
        assert_eq!(keys.key(&url(), "k-z", NOW + 119).unwrap_err().step, "entra_wif.kid");
        assert_eq!(ep.count(), 2);
    }

    #[test]
    fn cached_keys_last_48_hours_after_the_last_good_fetch() {
        let a = Key::new("k-a");
        let ep = Endpoint::serving(&[a.jwk()]);
        let keys = ep.keys();
        assert!(keys.key(&url(), "k-a", NOW).is_ok());
        ep.set(None);
        assert!(keys.key(&url(), "k-a", NOW + REFRESH_EVERY).is_ok(), "a failed refresh keeps the keys");
        assert!(keys.key(&url(), "k-a", NOW + STALE_AFTER).is_ok());
        let stale = keys.key(&url(), "k-a", NOW + STALE_AFTER + 1).unwrap_err();
        assert_eq!((stale.code, stale.step), ("client-auth", "entra_wif.keys"));
        assert!(ep.count() >= 3, "a failing endpoint is tried again once a minute");
        ep.set(Some(&[a.jwk()]));
        assert!(keys.key(&url(), "k-a", NOW + STALE_AFTER + 61).is_ok(), "the endpoint is back");
        // a key set never fetched refuses
        let down = Endpoint::default();
        assert_eq!(down.keys().key(&url(), "k-a", NOW).unwrap_err().step, "entra_wif.keys");
    }

    #[test]
    fn a_small_or_non_rsa_key_is_refused() {
        let key = Key::new("k-a");
        let mut ec = json!({"kty": "EC", "crv": "P-256", "kid": "k-a", "x": crate::codec::b64u(&[1u8; 32]), "y": crate::codec::b64u(&[2u8; 32])});
        let ep = Endpoint::serving(std::slice::from_ref(&ec));
        let utis = Mutex::new(JtiCache::uti());
        assert_eq!(step(verify(&signed(&key, &claims("u-1")), CLIENT, &cred(), &ep.keys(), NOW, &utis)), "entra_wif.key");
        ec = key.jwk();
        let n = tok::b64u_strict(ec["n"].as_str().unwrap()).unwrap();
        ec["n"] = json!(crate::codec::b64u(&n[..128]));
        let ep = Endpoint::serving(&[ec]);
        assert_eq!(step(verify(&signed(&key, &claims("u-2")), CLIENT, &cred(), &ep.keys(), NOW, &utis)), "entra_wif.key", "1024 bits");
    }

    /// Gate G-ENTRA-WIF-AUD (stage (a) of ruling R4-D20): an assertion Microsoft Entra issued for a workload identity
    /// whose audience is the Lucid issuer `I` verifies against the live tenant key set. Set `LUCID_GATE_ENTRA_WIF_AUD=1`,
    /// `LUCID_ENTRA_WIF_ASSERTION` (a fresh `client_assertion` captured from Entra's provisioning token request),
    /// `LUCID_ENTRA_WIF_ISSUER` (`I`), `LUCID_ENTRA_WIF_TENANT` and `LUCID_ENTRA_WIF_AZP`, then run with `--ignored`.
    #[test]
    #[ignore = "live gate G-ENTRA-WIF-AUD"]
    fn live_an_entra_assertion_with_aud_i_is_accepted() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        assert!(!var("LUCID_GATE_ENTRA_WIF_AUD").is_empty());
        let assertion = var("LUCID_ENTRA_WIF_ASSERTION");
        let cr = json!({"type": "entra_wif", "cloud": "public", "tenant": var("LUCID_ENTRA_WIF_TENANT"), "audience": var("LUCID_ENTRA_WIF_ISSUER"),
                        "azp": var("LUCID_ENTRA_WIF_AZP"), "expires": i64::MAX});
        let now = crate::meet_json::now() as i64;
        let got = verify(&assertion, CLIENT, &cr, &EntraKeys::default(), now, &Mutex::new(JtiCache::uti()));
        let v = got.unwrap_or_else(|f| panic!("{}: {}", f.step, f.message));
        assert!(v.exp > now);
    }

    /// The shared vectors (`tests/vectors/make_api_map_v2.py` in the Meeting Hub, copied to `tests/api_map_v2.json`):
    /// its `entra_wif` section, assertions signed by a fixed RSA 2048 test key, each gives the expected step.
    #[test]
    fn the_entra_wif_vectors_give_the_expected_steps() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("api_map_v2.json");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing: run make_api_map_v2.py and copy it", path.display()));
        let doc: Value = serde_json::from_str(&text).unwrap();
        let v = doc.get("entra_wif").unwrap_or_else(|| panic!("{} has no entra_wif section: run make_api_map_v2.py and copy it", path.display()));
        let now = v["now"].as_i64().unwrap();
        let client = v["client"].as_str().unwrap();
        let cr = &v["credential"];
        let s = |k: &str| cr[k].as_str().unwrap();
        let url = v["keys_url"].as_str().unwrap().to_string();
        assert_eq!(keys_url(s("cloud"), s("tenant")).as_deref(), Some(url.as_str()));
        assert_eq!(issuer_of(s("cloud"), s("tenant")).as_deref(), v["issuer"].as_str());
        assert!(credential(&[cr], now).is_ok());
        let mut wrong = Vec::new();
        let mut steps = BTreeSet::new();
        for c in v["cases"].as_array().unwrap() {
            let (jwks, want) = (v["jwks"].clone(), url.clone());
            let keys = EntraKeys::with_fetcher(Box::new(move |u: &FetchUrl| -> Result<Value, FetchError> {
                assert_eq!(u.url, want);
                Ok(jwks.clone())
            }));
            let utis = Mutex::new(JtiCache::uti());
            for seen in c["seen"].as_array().into_iter().flatten() {
                tok::admit_uti(&mut utis.lock(), client, seen.as_str().unwrap(), now).unwrap();
            }
            let got = match verify(c["assertion"].as_str().unwrap(), client, cr, &keys, now, &utis) {
                Ok(v) => {
                    assert_eq!(Some(v.exp), c["exp"].as_i64(), "{}", c["name"]);
                    "ok".to_string()
                }
                Err(f) => f.step.trim_start_matches("entra_wif.").to_string(),
            };
            if Some(got.as_str()) != c["expect"].as_str() {
                wrong.push(format!("{}: got {got}, want {}", c["name"], c["expect"]));
            }
            steps.insert(got);
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
        for s in ["ok", "alg", "kid", "key", "signature", "iss", "tid", "aud", "azp", "exp", "iat", "nbf", "span", "uti"] {
            assert!(steps.contains(s), "the vectors have no {s} case");
        }
    }
}
