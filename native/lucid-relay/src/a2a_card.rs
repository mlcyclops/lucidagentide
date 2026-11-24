// Contract API-1 revision 6 section 7.1 (and 7.13 for partner cards): Lucid's A2A Agent Cards. The card of an
// agent is built deterministically from the pinned api map (7.1.1) with A2A 1.0 proto default removal (R6-11),
// canonicalized with RFC 8785 (`ai_mcp::jcs`), signed with ES256 JWS per card key (7.1.2, A2A 8.4.2), and any card
// (Lucid's or a partner's) is verified by A2A 8.4.3 against a caller-pinned key set, never the card's own `jku`.
//
// The vectors are the Meeting Hub's `tests/vectors/a2a_card_v1.json` (`make_a2a_card_v1.py`), copied to `tests/`.

use crate::ai_mcp::jcs;
use crate::api_token::{b64u_strict, jwk_thumbprint, parse_jwk, verify_signature, Alg, PublicKey, ISSUER_RSA_MIN_BITS};
use crate::codec::{b64u, sha256_hex};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair};
use serde_json::{json, Map, Value};

/// Largest card (7.1.1), unsigned payload and served bytes alike.
pub const CARD_MAX: usize = 64 * 1024;

const EXT_DESCRIPTION: &str = "Selects the skill; see the Lucid contract.";
const SCHEME_DESCRIPTION: &str =
    "Tokens from the org's issuer; each token is bound to the client's DPoP key (RFC 9449) or mTLS certificate (RFC 8705).";
const SCOPE: &str = "spokes.tasks.submit";
const SCOPE_DESCRIPTION: &str = "Submit tasks to this organization's Remote Spokes through this agent";
const INPUT_MODES: [&str; 1] = ["text/plain"];
const OUTPUT_MODES: [&str; 2] = ["text/markdown", "application/json"];

/// `<I>/a2a/agents`.
pub fn agents_url(issuer: &str) -> String {
    format!("{issuer}/a2a/agents")
}

/// `<I>/a2a/agents/<id>/agent-card.json`.
pub fn card_url(issuer: &str, agent: &str) -> String {
    format!("{issuer}/a2a/agents/{agent}/agent-card.json")
}

/// `<I>/a2a/jwks.json`, also the `jku` of every card signature.
pub fn jwks_url(issuer: &str) -> String {
    format!("{issuer}/a2a/jwks.json")
}

/// `scheme://authority` of a URL.
fn origin_of(url: &str) -> Option<&str> {
    let start = url.find("://")? + 3;
    let end = url[start..].find('/').map_or(url.len(), |i| start + i);
    (end > start).then(|| &url[..end])
}

// ── A2A 1.0 proto default removal (A2A 5.7, 8.4.1; r6 R6-11) ────────────────────────────────────────────────

/// Field presence in `a2a.proto` (v1.0.0): REQUIRED, proto `optional`, or neither (dropped when equal to its
/// default).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pres {
    Req,
    Opt,
    Plain,
}

/// What a field holds: a scalar, repeated scalar, scalar map or `Struct` (`Leaf`); a message; a list of messages;
/// a map with message values.
#[derive(Clone, Copy)]
enum Kind {
    Leaf,
    Msg(&'static [Field]),
    List(&'static [Field]),
    Map(&'static [Field]),
}

struct Field {
    name: &'static str,
    pres: Pres,
    kind: Kind,
}

const fn fd(name: &'static str, pres: Pres, kind: Kind) -> Field {
    Field { name, pres, kind }
}

use Kind::{Leaf, List as Lst, Map as Mp, Msg};
use Pres::{Opt, Plain, Req};

const STRING_LIST: &[Field] = &[fd("list", Plain, Leaf)];
const SECURITY_REQUIREMENT: &[Field] = &[fd("schemes", Plain, Mp(STRING_LIST))];
const AUTH_CODE: &[Field] = &[
    fd("authorizationUrl", Req, Leaf),
    fd("tokenUrl", Req, Leaf),
    fd("refreshUrl", Plain, Leaf),
    fd("scopes", Req, Leaf),
    fd("pkceRequired", Plain, Leaf),
];
const CLIENT_CREDENTIALS: &[Field] = &[fd("tokenUrl", Req, Leaf), fd("refreshUrl", Plain, Leaf), fd("scopes", Req, Leaf)];
const IMPLICIT: &[Field] = &[fd("authorizationUrl", Plain, Leaf), fd("refreshUrl", Plain, Leaf), fd("scopes", Plain, Leaf)];
const PASSWORD: &[Field] = &[fd("tokenUrl", Plain, Leaf), fd("refreshUrl", Plain, Leaf), fd("scopes", Plain, Leaf)];
const DEVICE_CODE: &[Field] = &[
    fd("deviceAuthorizationUrl", Req, Leaf),
    fd("tokenUrl", Req, Leaf),
    fd("refreshUrl", Plain, Leaf),
    fd("scopes", Req, Leaf),
];
const OAUTH_FLOWS: &[Field] = &[
    fd("authorizationCode", Opt, Msg(AUTH_CODE)),
    fd("clientCredentials", Opt, Msg(CLIENT_CREDENTIALS)),
    fd("implicit", Opt, Msg(IMPLICIT)),
    fd("password", Opt, Msg(PASSWORD)),
    fd("deviceCode", Opt, Msg(DEVICE_CODE)),
];
const API_KEY: &[Field] = &[fd("description", Plain, Leaf), fd("location", Req, Leaf), fd("name", Req, Leaf)];
const HTTP_AUTH: &[Field] = &[fd("description", Plain, Leaf), fd("scheme", Req, Leaf), fd("bearerFormat", Plain, Leaf)];
const OAUTH2: &[Field] = &[fd("description", Plain, Leaf), fd("flows", Req, Msg(OAUTH_FLOWS)), fd("oauth2MetadataUrl", Plain, Leaf)];
const OIDC: &[Field] = &[fd("description", Plain, Leaf), fd("openIdConnectUrl", Req, Leaf)];
const MTLS: &[Field] = &[fd("description", Plain, Leaf)];
// `oneof` members have presence, so they are kept like `optional` fields.
const SECURITY_SCHEME: &[Field] = &[
    fd("apiKeySecurityScheme", Opt, Msg(API_KEY)),
    fd("httpAuthSecurityScheme", Opt, Msg(HTTP_AUTH)),
    fd("oauth2SecurityScheme", Opt, Msg(OAUTH2)),
    fd("openIdConnectSecurityScheme", Opt, Msg(OIDC)),
    fd("mtlsSecurityScheme", Opt, Msg(MTLS)),
];
const INTERFACE: &[Field] =
    &[fd("url", Req, Leaf), fd("protocolBinding", Req, Leaf), fd("tenant", Plain, Leaf), fd("protocolVersion", Req, Leaf)];
const PROVIDER: &[Field] = &[fd("url", Req, Leaf), fd("organization", Req, Leaf)];
const EXTENSION: &[Field] =
    &[fd("uri", Plain, Leaf), fd("description", Plain, Leaf), fd("required", Plain, Leaf), fd("params", Plain, Leaf)];
const CAPABILITIES: &[Field] = &[
    fd("streaming", Opt, Leaf),
    fd("pushNotifications", Opt, Leaf),
    fd("extensions", Plain, Lst(EXTENSION)),
    fd("extendedAgentCard", Opt, Leaf),
];
const SKILL: &[Field] = &[
    fd("id", Req, Leaf),
    fd("name", Req, Leaf),
    fd("description", Req, Leaf),
    fd("tags", Req, Leaf),
    fd("examples", Plain, Leaf),
    fd("inputModes", Plain, Leaf),
    fd("outputModes", Plain, Leaf),
    fd("securityRequirements", Plain, Lst(SECURITY_REQUIREMENT)),
];
const SIGNATURE: &[Field] = &[fd("protected", Req, Leaf), fd("signature", Req, Leaf), fd("header", Plain, Leaf)];
const AGENT_CARD: &[Field] = &[
    fd("name", Req, Leaf),
    fd("description", Req, Leaf),
    fd("supportedInterfaces", Req, Lst(INTERFACE)),
    fd("provider", Plain, Msg(PROVIDER)),
    fd("version", Req, Leaf),
    fd("documentationUrl", Opt, Leaf),
    fd("capabilities", Req, Msg(CAPABILITIES)),
    fd("securitySchemes", Plain, Mp(SECURITY_SCHEME)),
    fd("securityRequirements", Plain, Lst(SECURITY_REQUIREMENT)),
    fd("defaultInputModes", Req, Leaf),
    fd("defaultOutputModes", Req, Leaf),
    fd("skills", Req, Lst(SKILL)),
    fd("signatures", Plain, Lst(SIGNATURE)),
    fd("iconUrl", Opt, Leaf),
];

fn is_default(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => true,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        Value::Bool(true) => false,
    }
}

/// In place: members the proto does not name are kept as they are; known message members are cleaned first; a
/// `Plain` member equal to its default, and a null non-required member, are removed.
fn strip(o: &mut Map<String, Value>, fields: &[Field]) {
    for f in fields {
        let Some(v) = o.get_mut(f.name) else {
            continue;
        };
        match (f.kind, &mut *v) {
            (Msg(sub), Value::Object(m)) => strip(m, sub),
            (Lst(sub), Value::Array(a)) => a.iter_mut().filter_map(Value::as_object_mut).for_each(|m| strip(m, sub)),
            (Mp(sub), Value::Object(m)) => m.values_mut().filter_map(Value::as_object_mut).for_each(|m| strip(m, sub)),
            _ => {}
        }
        let drop = match f.pres {
            Req => false,
            Opt => v.is_null(),
            Plain => is_default(v),
        };
        if drop {
            o.remove(f.name);
        }
    }
}

// ── building, canonical form, signing ───────────────────────────────────────────────────────────────────────

/// 7.1.1: the unsigned card of `agent` in `map` (the api map body), skills in `dropped` left out, proto default
/// removal applied. None when the agent, its connector origin or `issuer.url` is missing, or the card would exceed
/// CARD_MAX.
pub fn build(map: &Value, org: &str, agent: &str, dropped: &[String]) -> Option<Value> {
    let issuer = map.get("issuer")?.get("url")?.as_str()?;
    let console = origin_of(issuer)?;
    let a = map.get("a2a")?.get("agents")?.as_array()?.iter().find(|a| a["id"].as_str() == Some(agent))?;
    let connector = a["connector"].as_str()?;
    let origin = map.get("connectors")?.as_array()?.iter().find(|k| k["id"].as_str() == Some(connector))?["origin"].as_str()?;
    let list = |v: Option<&Value>| v.filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([]));
    let skills: Vec<Value> = a["skills"]
        .as_array()?
        .iter()
        .filter(|s| !s["id"].as_str().is_some_and(|id| dropped.iter().any(|d| d == id)))
        .map(|s| {
            json!({"id": s["id"], "name": s["name"], "description": s["description"], "tags": list(s.get("tags")),
                   "examples": list(s.get("examples")), "inputModes": INPUT_MODES, "outputModes": OUTPUT_MODES})
        })
        .collect();
    let mut card = json!({
        "name": a["name"], "description": a["description"],
        "supportedInterfaces": [{"url": format!("{origin}/api/orgs/{org}/a2a/{agent}"),
                                 "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0"}],
        "version": a["version"],
        "capabilities": {"streaming": a["streaming"].as_bool().unwrap_or(false),
                         "pushNotifications": a["push"].as_bool().unwrap_or(false),
                         "extensions": [{"uri": crate::connector_a2a_wire::EXT, "description": EXT_DESCRIPTION}]},
        "securitySchemes": {"lucid-oauth": {"oauth2SecurityScheme": {
            "description": SCHEME_DESCRIPTION,
            "flows": {"clientCredentials": {"tokenUrl": format!("{issuer}/oauth/token"), "scopes": {SCOPE: SCOPE_DESCRIPTION}}},
            "oauth2MetadataUrl": format!("{console}/.well-known/oauth-authorization-server/api/orgs/{org}")}}},
        "securityRequirements": [{"schemes": {"lucid-oauth": {"list": [SCOPE]}}}],
        "defaultInputModes": INPUT_MODES,
        "defaultOutputModes": OUTPUT_MODES,
        "skills": skills,
    });
    let o = card.as_object_mut()?;
    if let Some(p) = a.get("provider").filter(|p| p.is_object()) {
        o.insert("provider".into(), json!({"organization": p["organization"], "url": p["url"]}));
    }
    if let Some(d) = a.get("documentation_url").filter(|d| d.is_string()) {
        o.insert("documentationUrl".into(), d.clone());
    }
    strip(o, AGENT_CARD);
    (payload(&card).len() <= CARD_MAX).then_some(card)
}

/// JCS of `build(map, org, agent, &[])`; what 7.1.3 `card-version` compares.
pub fn card_payload(map: &Value, org: &str, agent: &str) -> Option<String> {
    build(map, org, agent, &[]).map(|c| payload(&c))
}

/// The signed payload: JCS of `card` without `signatures`, after A2A default removal (8.4.1, 8.4.3 step 3).
pub fn payload(card: &Value) -> String {
    let mut c = card.clone();
    if let Some(o) = c.as_object_mut() {
        o.remove("signatures");
        strip(o, AGENT_CARD);
    }
    jcs(&c)
}

/// 7.1.3 `ETag`: `"<sha256 hex of payload(card)>"`.
pub fn etag(card: &Value) -> String {
    format!("\"{}\"", sha256_hex(payload(card).as_bytes()))
}

fn header(kid: &str, jku: &str) -> Value {
    json!({"alg": "ES256", "typ": "JOSE", "kid": kid, "jku": jku})
}

/// 7.1.2: the card with `signatures`, one per key in kid order; protected header (JCS)
/// {"alg":"ES256","typ":"JOSE","kid":kid,"jku":jku}, no unprotected header. Keys are
/// `ECDSA_P256_SHA256_FIXED_SIGNING` pairs.
pub fn sign(card: &Value, keys: &[(&str, &EcdsaKeyPair)], jku: &str) -> Result<Value, String> {
    if keys.is_empty() {
        return Err("No card key is inside its window.".into());
    }
    let mut out = card.clone();
    let o = out.as_object_mut().ok_or("The card is not a JSON object.")?;
    let body = b64u(payload(card).as_bytes());
    let mut keys = keys.to_vec();
    keys.sort_by(|a, b| a.0.cmp(b.0));
    let rng = SystemRandom::new();
    let mut sigs = Vec::with_capacity(keys.len());
    for (kid, pair) in keys {
        let protected = b64u(jcs(&header(kid, jku)).as_bytes());
        let input = format!("{protected}.{body}");
        let s = pair.sign(&rng, input.as_bytes()).map_err(|_| "The card could not be signed.".to_string())?;
        if s.as_ref().len() != 64 {
            return Err("The card key is not an ES256 (fixed signature) key.".into());
        }
        sigs.push(json!({"protected": protected, "signature": b64u(s.as_ref())}));
    }
    o.insert("signatures".into(), Value::Array(sigs));
    if served(&out).len() > CARD_MAX {
        return Err("The signed card is larger than 64 KiB.".into());
    }
    Ok(out)
}

/// The bytes served: JCS of the signed card (so they minus `signatures` re-canonicalize to the payload).
pub fn served(signed: &Value) -> Vec<u8> {
    jcs(signed).into_bytes()
}

/// The public JWK of a card key as staged in `a2a.jwks`.
pub fn public_jwk(pair: &EcdsaKeyPair, kid: &str, nbf: i64, exp: i64) -> Value {
    let point = pair.public_key().as_ref();
    let (x, y) = (&point[1..33], &point[33..65]);
    json!({"kty": "EC", "crv": "P-256", "kid": kid, "x": b64u(x), "y": b64u(y), "use": "sig", "alg": "ES256",
           "nbf": nbf, "exp": exp})
}

/// RFC 7638 thumbprint (b64u SHA-256 of {crv,kty,x,y}) of an EC P-256 JWK; None for any other key.
pub fn thumbprint(jwk: &Value) -> Option<String> {
    match parse_jwk(jwk, ISSUER_RSA_MIN_BITS)? {
        k @ PublicKey::Ec { .. } => Some(jwk_thumbprint(&k)),
        PublicKey::Rsa { .. } => None,
    }
}

/// One card signature whose shape passed `verify`'s first pass.
struct Sig<'a> {
    protected: &'a str,
    kid: String,
    sig: Vec<u8>,
}

/// A2A 8.4.3 for any card, strict (ReviewW6c). First every signature is checked for shape: `protected` and
/// `signature` strings (an unprotected `header` object allowed, nothing else), a protected header that reads as a JSON
/// object with `alg` ES256, `typ` JOSE, a `kid` and no `crit`, a 64 byte signature, no kid twice; and `jwks` (the
/// caller's pinned key source, never the card's own `jku`) names no kid twice. Any failure refuses the card. Then
/// each signature whose kid `jwks` names must verify over the default-removed JCS payload with that key (an EC P-256
/// ES256 signing key), else the card is refused even when another verifies; a signature whose kid `jwks` does not name
/// (a dropped or expired key the caller left out) is not counted. Ok is the kids that verified (at least one, in
/// signature order); Err a plain sentence.
pub fn verify(card: &Value, jwks: &[Value]) -> Result<Vec<String>, String> {
    let sigs = match card.get("signatures").and_then(Value::as_array) {
        Some(s) if !s.is_empty() => s,
        _ => return Err("The card carries no signature.".into()),
    };
    let jwks_kids: Vec<&str> = jwks.iter().filter_map(|j| j.get("kid").and_then(Value::as_str)).collect();
    if jwks_kids.iter().enumerate().any(|(i, k)| jwks_kids[..i].contains(k)) {
        return Err("The pinned key set names a kid twice.".into());
    }
    let mut checked: Vec<Sig> = Vec::with_capacity(sigs.len());
    for s in sigs {
        let Some(o) = s.as_object().filter(|o| o.keys().all(|k| matches!(k.as_str(), "protected" | "signature" | "header"))) else {
            return Err("A card signature is not a protected header and a signature.".into());
        };
        if o.get("header").is_some_and(|h| !h.is_object()) {
            return Err("A card signature has an unprotected header that is not an object.".into());
        }
        let (Some(protected), Some(sig)) = (o.get("protected").and_then(Value::as_str), o.get("signature").and_then(Value::as_str).and_then(b64u_strict)) else {
            return Err("A card signature is not a protected header and a signature.".into());
        };
        let Some(h) = b64u_strict(protected).and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok()) else {
            return Err("A card signature has a protected header that does not read.".into());
        };
        if h.get("alg").and_then(Value::as_str) != Some("ES256") || h.get("typ").and_then(Value::as_str) != Some("JOSE") {
            return Err("A card signature is not ES256 with typ JOSE.".into());
        }
        let Some(kid) = h.get("kid").and_then(Value::as_str).filter(|k| !k.is_empty() && !h.contains_key("crit")) else {
            return Err("A card signature has a protected header without a kid, or with crit.".into());
        };
        if sig.len() != 64 {
            return Err("A card signature is not an ES256 signature.".into());
        }
        if checked.iter().any(|c| c.kid == kid) {
            return Err("Two card signatures name the same kid.".into());
        }
        checked.push(Sig { protected, kid: kid.to_string(), sig });
    }
    let body = b64u(payload(card).as_bytes());
    let mut kids: Vec<String> = Vec::new();
    for s in &checked {
        let Some(j) = jwks.iter().find(|j| j.get("kid").and_then(Value::as_str) == Some(s.kid.as_str())) else { continue };
        let input = format!("{}.{body}", s.protected);
        let ok = j.get("alg").is_none_or(|a| a == "ES256")
            && j.get("use").is_none_or(|u| u == "sig")
            && parse_jwk(j, ISSUER_RSA_MIN_BITS).is_some_and(|k| matches!(k, PublicKey::Ec { .. }) && verify_signature(&k, Alg::Es256, input.as_bytes(), &s.sig));
        if !ok {
            return Err(format!("The card signature of key {} does not verify.", s.kid));
        }
        kids.push(s.kid.clone());
    }
    if kids.is_empty() {
        return Err("No signature of the card verifies with the pinned keys.".into());
    }
    Ok(kids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::sha256;
    use aws_lc_rs::signature::ECDSA_P256_SHA256_FIXED_SIGNING;

    const ISSUER: &str = "https://console.acme.example:7443/api/orgs/acme";
    const AGENT: &str = "a_7c1d2e3f4a5b6c7d";

    fn map() -> Value {
        json!({"v": 1, "org": "acme", "seq": 12, "issuer": {"url": ISSUER},
               "connectors": [{"id": "k_1a2b3c4d5e6f7081", "name": "conn-1", "origin": "https://conn.acme.example:8445",
                               "apps": ["*"], "networks": ["10.40.0.0/16"], "stale_s": 60, "state": "active"}],
               "a2a": {"jwks": [], "well_known": AGENT,
                       "agents": [{"id": AGENT, "name": "Acme Build Agent",
                                   "description": "Runs build and test tasks on Acme's Remote Spokes after a person at Acme approves each task.",
                                   "version": "1.0.0", "connector": "k_1a2b3c4d5e6f7081", "hub": "c_9a8b7c6d5e4f3a2b",
                                   "provider": {"organization": "Acme Robotics", "url": "https://acme.example"},
                                   "documentation_url": "https://acme.example/agents/build",
                                   "streaming": true, "push": true,
                                   "skills": [{"id": "build-and-test", "name": "Build and test",
                                               "description": "Builds the named branch and runs its tests; returns the log summary and a review branch.",
                                               "tags": ["build", "test"], "examples": ["Build branch release/2.3 and run the unit tests"],
                                               "targets": ["n_a1b2c3d4e5f60718293a4b5c6d7e8f90"], "model": "anthropic/claude-sonnet-4-6",
                                               "turns": "one", "approve_within_s": 3600}]}]}})
    }

    fn pair() -> EcdsaKeyPair {
        EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap()
    }

    #[test]
    fn urls() {
        assert_eq!(agents_url(ISSUER), format!("{ISSUER}/a2a/agents"));
        assert_eq!(card_url(ISSUER, AGENT), format!("{ISSUER}/a2a/agents/{AGENT}/agent-card.json"));
        assert_eq!(jwks_url(ISSUER), format!("{ISSUER}/a2a/jwks.json"));
    }

    #[test]
    fn builds_the_card_of_the_r6_2_1_map() {
        let c = build(&map(), "acme", AGENT, &[]).unwrap();
        assert_eq!(c["supportedInterfaces"], json!([{"url": format!("https://conn.acme.example:8445/api/orgs/acme/a2a/{AGENT}"),
                                                      "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0"}]));
        assert_eq!(c["provider"], json!({"organization": "Acme Robotics", "url": "https://acme.example"}));
        assert_eq!(c["documentationUrl"], "https://acme.example/agents/build");
        assert_eq!(c["capabilities"]["extensions"], json!([{"uri": crate::connector_a2a_wire::EXT, "description": EXT_DESCRIPTION}]));
        let o = &c["securitySchemes"]["lucid-oauth"]["oauth2SecurityScheme"];
        assert_eq!(o["flows"]["clientCredentials"]["tokenUrl"], format!("{ISSUER}/oauth/token"));
        assert_eq!(o["oauth2MetadataUrl"], "https://console.acme.example:7443/.well-known/oauth-authorization-server/api/orgs/acme");
        assert_eq!(c["securityRequirements"], json!([{"schemes": {"lucid-oauth": {"list": ["spokes.tasks.submit"]}}}]));
        assert_eq!(c["skills"][0]["outputModes"], json!(["text/markdown", "application/json"]));
        let p = payload(&c);
        // internal map fields never appear as card keys (r6 7.1.1); matched in their JCS key form, because the
        // skill description's "returns" holds "turns"
        for internal in ["targets", "model", "turns", "approve_within_s", "idle_close_s", "hub", "connector"] {
            assert!(!p.contains(&format!("\"{internal}\":")), "{internal} leaked");
        }
        for id in ["k_1a2b3c4d5e6f7081", "c_9a8b7c6d5e4f3a2b"] {
            assert!(!p.contains(id), "{id} leaked");
        }
        assert_eq!(card_payload(&map(), "acme", AGENT), Some(p.clone()));
        assert_eq!(etag(&c), format!("\"{}\"", sha256_hex(p.as_bytes())));
        assert!(build(&map(), "acme", "a_0000000000000000", &[]).is_none());
        let mut m = map();
        m["connectors"] = json!([]);
        assert!(build(&m, "acme", AGENT, &[]).is_none());
    }

    #[test]
    fn default_removal_keeps_optional_false_and_drops_plain_defaults() {
        let mut m = map();
        let a = &mut m["a2a"]["agents"][0];
        a["push"] = json!(false);
        a["streaming"] = json!(false);
        a["skills"][0]["examples"] = json!([]);
        a.as_object_mut().unwrap().remove("provider");
        let c = build(&m, "acme", AGENT, &[]).unwrap();
        let p = payload(&c);
        assert!(p.contains("\"pushNotifications\":false") && p.contains("\"streaming\":false"));
        assert!(!p.contains("\"required\"") && !p.contains("\"examples\"") && !p.contains("\"provider\""));
        // A partner card with explicit defaults canonicalizes to the same payload.
        let mut loud = c.clone();
        loud["capabilities"]["extensions"][0]["required"] = json!(false);
        loud["supportedInterfaces"][0]["tenant"] = json!("");
        loud["skills"][0]["securityRequirements"] = json!([]);
        loud["provider"] = json!({});
        loud["unknownMember"] = json!(false);
        let mut expected = c.clone();
        expected["unknownMember"] = json!(false);
        assert_eq!(payload(&loud), jcs(&expected));
    }

    #[test]
    fn the_a2a_8_4_1_example() {
        let card = json!({"name": "Example Agent", "description": "",
                          "capabilities": {"streaming": false, "pushNotifications": false, "extensions": []}, "skills": []});
        assert_eq!(payload(&card), r#"{"capabilities":{"pushNotifications":false,"streaming":false},"description":"","name":"Example Agent","skills":[]}"#);
    }

    #[test]
    fn two_keys_sign_in_kid_order_and_both_verify() {
        let (a, b) = (pair(), pair());
        let card = build(&map(), "acme", AGENT, &[]).unwrap();
        let jku = jwks_url(ISSUER);
        let signed = sign(&card, &[("k-b", &b), ("k-a", &a)], &jku).unwrap();
        let sigs = signed["signatures"].as_array().unwrap();
        assert_eq!(sigs.len(), 2);
        let h0: Value = serde_json::from_slice(&b64u_strict(sigs[0]["protected"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(h0, json!({"alg": "ES256", "typ": "JOSE", "kid": "k-a", "jku": jku}));
        assert!(sigs[0].get("header").is_none());
        let jwks = [public_jwk(&a, "k-a", 0, 1), public_jwk(&b, "k-b", 0, 1)];
        assert_eq!(verify(&signed, &jwks), Ok(vec!["k-a".to_string(), "k-b".to_string()]));
        assert_eq!(verify(&signed, &jwks[1..]), Ok(vec!["k-b".to_string()]), "a dropped key still leaves the other");
        assert_eq!(payload(&signed), payload(&card));
        let back: Value = serde_json::from_slice(&served(&signed)).unwrap();
        assert_eq!(back, signed);
        assert!(sign(&card, &[], &jku).is_err());
    }

    #[test]
    fn a_tampered_or_unsigned_card_fails() {
        let a = pair();
        let card = build(&map(), "acme", AGENT, &[]).unwrap();
        let mut signed = sign(&card, &[("k-a", &a)], "https://x/jwks.json").unwrap();
        let jwks = [public_jwk(&a, "k-a", 0, 1)];
        signed["skills"][0]["description"] = json!("Builds any branch without approval.");
        assert!(verify(&signed, &jwks).is_err());
        assert!(verify(&card, &jwks).is_err());
    }

    #[test]
    fn a_dropped_skill_leaves_the_card() {
        let mut m = map();
        let mut lint = m["a2a"]["agents"][0]["skills"][0].clone();
        lint["id"] = json!("lint");
        m["a2a"]["agents"][0]["skills"].as_array_mut().unwrap().push(lint);
        assert_eq!(build(&m, "acme", AGENT, &[]).unwrap()["skills"].as_array().unwrap().len(), 2);
        let c = build(&m, "acme", AGENT, &["lint".to_string()]).unwrap();
        assert_eq!(c, build(&map(), "acme", AGENT, &[]).unwrap());
    }

    #[test]
    fn the_size_cap_refuses_a_large_card() {
        let mut m = map();
        m["a2a"]["agents"][0]["description"] = json!("x".repeat(CARD_MAX));
        assert!(build(&m, "acme", AGENT, &[]).is_none());
        assert!(card_payload(&m, "acme", AGENT).is_none());
    }

    #[test]
    fn thumbprint_is_rfc_7638_over_the_required_members() {
        let a = pair();
        let jwk = public_jwk(&a, "k-a", 5, 6);
        let canonical = format!(r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#, jwk["x"].as_str().unwrap(), jwk["y"].as_str().unwrap());
        let want = b64u(&sha256(canonical.as_bytes()));
        assert_eq!(thumbprint(&jwk), Some(want.clone()));
        let bare = json!({"kty": "EC", "crv": "P-256", "x": jwk["x"], "y": jwk["y"]});
        assert_eq!(thumbprint(&bare), Some(want));
        assert_eq!(thumbprint(&json!({"kty": "EC", "crv": "P-384", "x": jwk["x"], "y": jwk["y"]})), None);
    }

    #[test]
    fn verify_ignores_the_cards_own_jku() {
        let (pinned, stranger) = (pair(), pair());
        let card = build(&map(), "acme", AGENT, &[]).unwrap();
        let forged = sign(&card, &[("k-a", &stranger)], "https://evil.example/jwks.json").unwrap();
        assert!(verify(&forged, &[public_jwk(&pinned, "k-a", 0, 1)]).is_err());
        let other = sign(&card, &[("k-z", &stranger)], "https://evil.example/jwks.json").unwrap();
        assert!(verify(&other, &[public_jwk(&pinned, "k-a", 0, 1)]).is_err());
    }

    /// ReviewW6c: every signature header is checked before any signature, and one bad signature refuses the card even
    /// when another verifies.
    #[test]
    fn one_bad_signature_refuses_the_card() {
        let (a, b) = (pair(), pair());
        let card = build(&map(), "acme", AGENT, &[]).unwrap();
        let jku = jwks_url(ISSUER);
        let jwks = [public_jwk(&a, "k-a", 0, 1), public_jwk(&b, "k-b", 0, 1)];
        let good = sign(&card, &[("k-a", &a), ("k-b", &b)], &jku).unwrap();
        assert!(verify(&good, &jwks).is_ok());
        let body = b64u(payload(&card).as_bytes());
        // the second signature re-made under another protected header, signed by its own key
        let with_header = |h: Value| {
            let mut c = good.clone();
            let protected = b64u(jcs(&h).as_bytes());
            let s = b.sign(&SystemRandom::new(), format!("{protected}.{body}").as_bytes()).unwrap();
            c["signatures"][1] = json!({"protected": protected, "signature": b64u(s.as_ref())});
            c
        };
        assert!(verify(&with_header(json!({"alg": "ES256", "typ": "JOSE", "kid": "k-b", "jku": jku})), &jwks).is_ok(), "the same header re-signed");
        assert!(verify(&with_header(json!({"alg": "ES256", "typ": "JWT", "kid": "k-b"})), &jwks).is_err(), "typ JWT");
        assert!(verify(&with_header(json!({"alg": "ES256", "kid": "k-b"})), &jwks).is_err(), "no typ");
        assert!(verify(&with_header(json!({"alg": "ES384", "typ": "JOSE", "kid": "k-b"})), &jwks).is_err(), "alg ES384");
        assert!(verify(&with_header(json!({"alg": "ES256", "typ": "JOSE", "kid": "k-a"})), &jwks).is_err(), "a kid twice");
        assert!(verify(&with_header(json!({"alg": "ES256", "typ": "JOSE", "kid": "k-b", "crit": ["x"]})), &jwks).is_err(), "crit");
        let mut unreadable = good.clone();
        unreadable["signatures"][1]["protected"] = json!(b64u(b"not json"));
        assert!(verify(&unreadable, &jwks).is_err(), "a protected header that does not read");
        let mut extra = good.clone();
        extra["signatures"][1]["more"] = json!(1);
        assert!(verify(&extra, &jwks).is_err(), "a member beside protected, signature and header");
        // a signature of a pinned key that does not verify refuses the card, even with the other one good
        let mut wrong = good.clone();
        wrong["signatures"][1]["signature"] = good["signatures"][0]["signature"].clone();
        assert!(verify(&wrong, &jwks).is_err());
        // a kid the pinned set lists twice
        assert!(verify(&good, &[jwks[0].clone(), jwks[1].clone(), jwks[0].clone()]).is_err());
        // a signature of a key the pinned set does not list is not counted
        assert_eq!(verify(&good, &jwks[..1]), Ok(vec!["k-a".to_string()]));
    }

    /// `tests/a2a_card_v1.json`, copied from the Meeting Hub's `tests/vectors` (written by `make_a2a_card_v1.py`).
    #[test]
    fn shared_vectors_agree() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("a2a_card_v1.json");
        let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("{} is needed (copy tests/vectors/a2a_card_v1.json): {e}", path.display()));
        let doc: Value = serde_json::from_slice(&raw).unwrap();
        let jku = doc["jku"].as_str().unwrap();
        let keys: Vec<Value> = doc["keys"].as_array().unwrap().iter().map(|k| k["jwk"].clone()).collect();
        for c in doc["cards"].as_array().unwrap() {
            let n = c["name"].as_str().unwrap();
            let dropped: Vec<String> = c["dropped"].as_array().unwrap().iter().map(|d| d.as_str().unwrap().to_string()).collect();
            let card = build(&c["map"], c["org"].as_str().unwrap(), c["agent"].as_str().unwrap(), &dropped).unwrap();
            assert_eq!(card, c["card"], "card {n}");
            assert_eq!(payload(&card), c["payload"].as_str().unwrap(), "payload {n}");
            assert_eq!(etag(&card), c["etag"].as_str().unwrap(), "etag {n}");
            let sigs = c["signed"]["signatures"].as_array().unwrap();
            let headers = c["headers"].as_array().unwrap();
            assert_eq!(sigs.len(), headers.len(), "signatures {n}");
            for (s, h) in sigs.iter().zip(headers) {
                assert_eq!(*h, header(h["kid"].as_str().unwrap(), jku), "header {n}");
                assert_eq!(s["protected"].as_str().unwrap(), b64u(jcs(h).as_bytes()), "protected {n}");
            }
            assert_eq!(served(&c["signed"]), c["served"].as_str().unwrap().as_bytes(), "served {n}");
            let kids: Vec<String> = headers.iter().map(|h| h["kid"].as_str().unwrap().to_string()).collect();
            assert_eq!(verify(&c["signed"], &keys), Ok(kids), "signatures {n}");
        }
        for c in doc["verify"].as_array().unwrap() {
            let n = c["name"].as_str().unwrap();
            let got = verify(&c["card"], c["jwks"].as_array().unwrap()).ok();
            let want = c["kids"].as_array().map(|k| k.iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>());
            assert_eq!(got, want, "verify {n}");
        }
        let e = &doc["spec_example"];
        assert_eq!(payload(&e["card"]), e["payload"].as_str().unwrap());
    }
}
