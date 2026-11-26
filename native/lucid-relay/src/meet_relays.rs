// MR-1 phase 1 section 1 (docs/multi-relay/contract-mr1-phase1.md): the root-signed relay directory a relay holds
// and serves at `GET /v1/relays`. The relay checks the shape (1.1), the org root's signature over
// `lp("lucid-meet-relay-directory-v1", CE-1(directory))` (1.2) and the holding rules (1.3), then keeps the wire as
// `relays.json` in its state dir. The same checks and short error codes as the shared vectors
// (`tests/relay_directory_v1.json`): sig, schema, expired, not-yet, older, cluster, size.

use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

use crate::meet_org_policy::{canonical_json, lp};
use crate::meet_x509::{ecdsa_sha256_verified, Cert};

const SIG_LABEL: &str = "lucid-meet-relay-directory-v1";
const TYP: &str = "lucid-meet-relay-directory";
const FILE: &str = "relays.json";
const WIRE_MAX: usize = 64 * 1024;
const VERSION_MAX: u64 = (1 << 53) - 1;
const LIFE_MAX: i64 = 400 * 86_400; // expires - issued
const SKEW: i64 = 300; // a directory issued this far in the future is still in date
const NODES_MAX: usize = 16;
const TOP_KEYS: &[&str] = &["v", "typ", "cluster", "version", "issued", "expires", "nodes"];
const NODE_KEYS: &[&str] = &["id", "server", "port", "address", "region", "priority"];
const NODE_OPTIONAL: &[&str] = &["address"];

// One POST at a time: the held version is read, compared and replaced as one step.
static STORE: Mutex<()> = Mutex::new(());

/// A verified directory: what routing and the relay's own checks need. The wire itself is what gets stored.
#[derive(Clone, Debug)]
pub struct Directory {
    pub cluster: String,
    pub version: u64,
    /// Node ids in the signed order.
    pub nodes: Vec<String>,
}

fn path(state_dir: &Path) -> PathBuf {
    state_dir.join(FILE)
}

/// The held wire, or None when there is none or it does not read as an object.
fn held(state_dir: &Path) -> Option<Value> {
    let text = std::fs::read(path(state_dir)).ok()?;
    serde_json::from_slice::<Value>(&text).ok().filter(Value::is_object)
}

fn held_field<'a>(wire: &'a Value, key: &str) -> Option<&'a Value> {
    wire.get("directory")?.get(key)
}

/// The held directory's version (the hello answer's `directory_version`), None without one.
pub fn version(state_dir: &Path) -> Option<u64> {
    held_field(&held(state_dir)?, "version")?.as_u64()
}

/// The held directory's `expires` (RFC 3339), for the console's attention item; None without one.
pub fn expires(state_dir: &Path) -> Option<String> {
    held_field(&held(state_dir)?, "expires")?.as_str().map(str::to_string)
}

/// `GET /v1/relays`: `{"ok": true, "directory": <wire> | null}`. An expired held directory is still served: clients
/// apply the dates themselves and keep it so a lower version cannot replace it (1.3).
pub fn get(state_dir: &Path) -> Value {
    json!({ "ok": true, "directory": held(state_dir).unwrap_or(Value::Null) })
}

/// `POST /v1/relays` with a wire: verify it against the org root and the held directory (1.3), refuse one that does
/// not list this relay's node id when the relay is in a cluster (1.4), then store it atomically. Err is (HTTP status,
/// short code, words for the log and the caller).
pub fn post(
    state_dir: &Path,
    root_ca_der: &[u8],
    own_node: Option<&str>,
    body: &Value,
    now_s: i64,
) -> Result<Value, (u16, &'static str, String)> {
    let _one = STORE.lock();
    let current = held(state_dir);
    let held_pin = current.as_ref().and_then(|w| {
        Some((held_field(w, "cluster")?.as_str()?.to_string(), held_field(w, "version")?.as_u64()?))
    });
    if let (Some(cur), Some((_, v))) = (&current, &held_pin) {
        if held_field(body, "version").and_then(Value::as_u64) == Some(*v) {
            if same_bytes(body, cur) {
                return Ok(json!({ "ok": true, "version": v, "changed": false }));
            }
            return Err((409, "older", format!("a different relay directory with the held version {v} was refused")));
        }
    }
    let dir = verify(body, root_ca_der, held_pin.as_ref().map(|(c, v)| (c.as_str(), *v)), now_s)
        .map_err(|code| (status_of(code), code, words_of(code).to_string()))?;
    if let Some(node) = own_node {
        if !dir.nodes.iter().any(|n| n == node) {
            return Err((409, "node", format!("the relay directory does not list this relay's node {node}")));
        }
    }
    let mut data = serde_json::to_vec(body).map_err(|e| (500, "store", e.to_string()))?;
    data.push(b'\n');
    crate::meet_tls::write_atomic(&path(state_dir), &data).map_err(|e| (500, "store", e.to_string()))?;
    Ok(json!({ "ok": true, "cluster": dir.cluster, "version": dir.version, "changed": true }))
}

fn same_bytes(a: &Value, b: &Value) -> bool {
    match (canonical_json(a), canonical_json(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn status_of(code: &str) -> u16 {
    match code {
        "size" => 413,
        "schema" => 400,
        "sig" => 403,
        _ => 409,
    }
}

fn words_of(code: &str) -> &'static str {
    match code {
        "size" => "the relay directory is larger than 64 KiB",
        "schema" => "the relay directory does not have the right shape",
        "sig" => "the relay directory is not signed by the organization root",
        "expired" => "the relay directory has expired",
        "not-yet" => "the relay directory is not valid yet",
        "older" => "the relay directory is not newer than the held one",
        "cluster" => "the relay directory is for another cluster",
        _ => "the relay directory was refused",
    }
}

/// Verify one wire `{"directory", "sig"}` (1.1 to 1.3). `held`: the held directory's cluster and version (first
/// accept: None). Err is the short code of the first rule that fails, in the vectors' order: size, the wire's shape and
/// CE-1, signature, the directory's shape, dates, cluster, version.
pub fn verify(wire: &Value, root_ca_der: &[u8], held: Option<(&str, u64)>, now_s: i64) -> Result<Directory, &'static str> {
    if serde_json::to_vec(wire).map_or(true, |b| b.len() > WIRE_MAX) {
        return Err("size");
    }
    let w = wire.as_object().filter(|w| w.len() == 2).ok_or("schema")?;
    let (Some(body), Some(Value::String(sig))) = (w.get("directory"), w.get("sig")) else { return Err("schema") };
    let signed = signed_bytes(body).map_err(|_| "schema")?;
    let sig = crate::meet_json::b64_strict(sig).ok_or("sig")?;
    let root = Cert::from_der(root_ca_der).ok_or("sig")?;
    if !ecdsa_sha256_verified(&root.spki, &signed, &sig) {
        return Err("sig");
    }
    let dir = shape(body).ok_or("schema")?;
    if now_s < dir.issued - SKEW {
        return Err("not-yet");
    }
    if now_s >= dir.expires {
        return Err("expired");
    }
    if let Some((cluster, version)) = held {
        if dir.d.cluster != cluster {
            return Err("cluster");
        }
        if dir.d.version <= version {
            return Err("older");
        }
    }
    Ok(dir.d)
}

/// The bytes the org root signs (1.2): `lp(label) || lp(CE-1(directory))`.
pub fn signed_bytes(directory: &Value) -> Result<Vec<u8>, String> {
    Ok(lp(&[SIG_LABEL.as_bytes(), &canonical_json(directory)?]))
}

struct Shaped {
    d: Directory,
    issued: i64,
    expires: i64,
}

/// Every rule of 1.1, None when one fails.
fn shape(body: &Value) -> Option<Shaped> {
    let o = exact(body, TOP_KEYS, &[])?;
    if o["v"].as_u64() != Some(1) || o["typ"].as_str() != Some(TYP) {
        return None;
    }
    let cluster = o["cluster"].as_str().filter(|s| slug_ok(s))?;
    let version = o["version"].as_u64().filter(|v| (1..=VERSION_MAX).contains(v))?;
    let issued = utc(&o["issued"])?;
    let expires = utc(&o["expires"])?;
    if expires <= issued || expires - issued > LIFE_MAX {
        return None;
    }
    let list = o["nodes"].as_array().filter(|a| (1..=NODES_MAX).contains(&a.len()))?;
    let mut nodes: Vec<String> = Vec::with_capacity(list.len());
    for n in list {
        let n = exact(n, NODE_KEYS, NODE_OPTIONAL)?;
        let id = n["id"].as_str().filter(|s| slug_ok(s))?;
        if nodes.iter().any(|x| x == id) {
            return None;
        }
        let server = n["server"].as_str()?;
        if !dns_ok(server) || server.parse::<std::net::Ipv4Addr>().is_ok() {
            return None;
        }
        n["port"].as_u64().filter(|p| (1..=65_535).contains(p))?;
        if let Some(a) = n.get("address") {
            a.as_str().filter(|a| dns_ok(a) || a.parse::<std::net::Ipv4Addr>().is_ok())?;
        }
        n["region"].as_str().filter(|s| slug_ok(s))?;
        n["priority"].as_u64().filter(|p| *p <= 1000)?;
        nodes.push(id.to_string());
    }
    Some(Shaped { d: Directory { cluster: cluster.to_string(), version, nodes }, issued, expires })
}

/// The object when its keys are exactly `keys` less any of `optional`.
fn exact<'a>(v: &'a Value, keys: &[&str], optional: &[&str]) -> Option<&'a Map<String, Value>> {
    let o = v.as_object()?;
    let known = o.keys().all(|k| keys.contains(&k.as_str()));
    let present = keys.iter().all(|k| optional.contains(k) || o.contains_key(*k));
    (known && present).then_some(o)
}

/// `^[a-z0-9][a-z0-9-]{0,31}$`.
fn slug_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len())
        && b[0] != b'-'
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// A lower-case DNS name: labels of 1 to 63 letters, digits and inner hyphens, at most 253 bytes, no trailing dot.
fn dns_ok(s: &str) -> bool {
    (1..=253).contains(&s.len())
        && s.split('.').all(|l| {
            (1..=63).contains(&l.len())
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

/// RFC 3339 UTC with `Z` and whole seconds (`2026-11-26T04:00:00Z`) to unix seconds.
fn utc(v: &Value) -> Option<i64> {
    let b = v.as_str()?.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let d = &b[from..to];
        d.iter().all(u8::is_ascii_digit).then(|| d.iter().fold(0i64, |n, c| n * 10 + i64::from(c - b'0')))
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days = match mo {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if y < 1 || !(1..=month_days).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let days = crate::meet_json::days_from_civil(y, mo as u32, d as u32);
    Some(days * 86_400 + h * 3600 + mi * 60 + s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::console_webauthn::testkit::{test_root_der, test_root_key};
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};

    const NOW: i64 = 1_795_665_600; // 2026-11-26T04:00:00Z

    fn sign(directory: Value, key: &SigningKey) -> Value {
        let sig: Signature = key.sign(&signed_bytes(&directory).unwrap());
        json!({ "directory": directory, "sig": crate::meet_json::b64(sig.to_der().as_bytes()) })
    }

    fn directory(version: u64) -> Value {
        json!({
            "v": 1, "typ": TYP, "cluster": "emertins-meet", "version": version,
            "issued": "2026-11-26T04:00:00Z", "expires": "2027-11-26T04:00:00Z",
            "nodes": [
                {"id": "lab", "server": "meet.emertins.com", "port": 443, "address": "lucidhubmeeting.emertins.com",
                 "region": "home", "priority": 10},
                {"id": "azure", "server": "meet-azure.emertins.com", "port": 443, "region": "azure-eastus2", "priority": 20}]
        })
    }

    fn wire(version: u64) -> Value {
        sign(directory(version), &test_root_key())
    }

    fn with(mut d: Value, edit: impl FnOnce(&mut Value)) -> Value {
        edit(&mut d);
        sign(d, &test_root_key())
    }

    fn state() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("meet-relays-{}", crate::meet_json::token_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn verifies_the_contract_example() {
        let d = verify(&wire(3), &test_root_der(), None, NOW).unwrap();
        assert_eq!((d.cluster.as_str(), d.version, d.nodes.clone()), ("emertins-meet", 3, vec!["lab".to_string(), "azure".to_string()]));
        assert_eq!(utc(&json!("2027-11-26T04:00:00Z")), Some(NOW + 365 * 86_400));
    }

    #[test]
    fn refuses_each_rule_with_its_code() {
        let root = test_root_der();
        let cases: Vec<(Value, &str)> = vec![
            (with(directory(3), |d| d["extra"] = json!(1)), "schema"),
            (with(directory(3), |d| d["nodes"][0]["id"] = json!("-lab")), "schema"),
            (with(directory(3), |d| d["nodes"][0]["server"] = json!("10.0.0.1")), "schema"),
            (with(directory(3), |d| d["nodes"][0]["server"] = json!("Meet.emertins.com")), "schema"),
            (with(directory(3), |d| d["nodes"][1]["id"] = json!("lab")), "schema"),
            (with(directory(3), |d| d["nodes"][0]["port"] = json!(0)), "schema"),
            (with(directory(3), |d| d["nodes"][0]["priority"] = json!(1001)), "schema"),
            (with(directory(3), |d| d["nodes"][0]["address"] = json!("10.0.0.7")), "ok"),
            (with(directory(3), |d| d["issued"] = json!("2026-11-26T04:00:00.5Z")), "schema"),
            (with(directory(3), |d| d["issued"] = json!("2026-02-30T04:00:00Z")), "schema"),
            (with(directory(3), |d| d["expires"] = json!("2028-01-01T04:00:00Z")), "schema"),
            (with(directory(3), |d| d["version"] = json!(0)), "schema"),
            (with(directory(3), |d| d["v"] = json!(2)), "schema"),
            (sign(directory(3), &SigningKey::from_slice(&[7u8; 32]).unwrap()), "sig"),
            (with(directory(3), |d| d["issued"] = json!("2026-11-26T04:05:01Z")), "not-yet"),
            (with(directory(3), |d| d["issued"] = json!("2026-11-26T04:05:00Z")), "ok"),
            (
                with(directory(3), |d| {
                    d["issued"] = json!("2025-11-26T04:00:00Z");
                    d["expires"] = json!("2026-11-26T04:00:00Z");
                }),
                "expired",
            ),
        ];
        for (i, (w, want)) in cases.iter().enumerate() {
            let got = verify(w, &root, None, NOW).map(|_| "ok").unwrap_or_else(|e| e);
            assert_eq!(got, *want, "case {i}");
        }
        let mut tampered = wire(3);
        tampered["directory"]["version"] = json!(4);
        assert_eq!(verify(&tampered, &root, None, NOW).unwrap_err(), "sig");
        let mut big = wire(3);
        big["pad"] = json!("x".repeat(WIRE_MAX));
        assert_eq!(verify(&big, &root, None, NOW).unwrap_err(), "size");
        assert_eq!(verify(&wire(3), &root, Some(("emertins-meet", 3)), NOW).unwrap_err(), "older");
        assert_eq!(verify(&wire(3), &root, Some(("other", 1)), NOW).unwrap_err(), "cluster");
        assert_eq!(verify(&wire(3), &root, Some(("emertins-meet", 2)), NOW).unwrap().version, 3);
    }

    #[test]
    fn post_stores_newer_ignores_same_and_refuses_other_bytes() {
        let dir = state();
        let root = test_root_der();
        assert_eq!(get(&dir), json!({ "ok": true, "directory": null }));
        assert_eq!(version(&dir), None);
        let w3 = wire(3);
        assert_eq!(post(&dir, &root, Some("lab"), &w3, NOW).unwrap()["changed"], true);
        assert_eq!((version(&dir), expires(&dir).as_deref()), (Some(3), Some("2027-11-26T04:00:00Z")));
        assert_eq!(get(&dir)["directory"], w3);
        assert_eq!(post(&dir, &root, Some("lab"), &w3, NOW).unwrap()["changed"], false);
        // the held version with other bytes is refused, not taken
        assert_eq!(post(&dir, &root, Some("lab"), &with(directory(3), |d| d["nodes"][0]["priority"] = json!(5)), NOW).unwrap_err().1, "older");
        assert_eq!(post(&dir, &root, Some("lab"), &wire(2), NOW).unwrap_err().1, "older");
        let mut other = directory(4);
        other["cluster"] = json!("other");
        assert_eq!(post(&dir, &root, None, &sign(other, &test_root_key()), NOW).unwrap_err().1, "cluster");
        let (status, code, _) = post(&dir, &root, Some("spare"), &wire(4), NOW).unwrap_err();
        assert_eq!((status, code), (409, "node"));
        assert_eq!(post(&dir, &root, None, &wire(4), NOW).unwrap()["version"], 4);
        assert_eq!(version(&dir), Some(4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The shared vectors (MeetingHubaddon `tests/vectors/relay_directory_v1.json`, made by
    /// `tools/make_relay_directory_vectors.py`) that every implementation runs.
    #[test]
    fn shared_vectors() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/relay_directory_v1.json");
        let v: Value = serde_json::from_slice(&std::fs::read(&file).expect("the shared vectors")).unwrap();
        let pem = v["root_cert_pem"].as_str().unwrap().as_bytes();
        let root_der = crate::meet_x509::pem_blocks(pem, "CERTIFICATE").into_iter().next().expect("the vectors' root").1;
        assert!(Cert::from_der(&root_der).is_some());
        let now = utc(&v["now"]).expect("the vectors' now");
        let cases = v["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            // a held version without a held cluster pins the version only
            let held = c["held_version"].as_u64().map(|ver| {
                (c["held_cluster"].as_str().or(c["wire"]["directory"]["cluster"].as_str()).unwrap_or(""), ver)
            });
            let got = match &c["wire"] {
                Value::String(raw) if raw.len() > WIRE_MAX => Err("size"),
                Value::String(raw) => match serde_json::from_str::<Value>(raw) {
                    Ok(w) => verify(&w, &root_der, held, now).map(|_| ()),
                    Err(_) => Err("schema"),
                },
                w => verify(w, &root_der, held, now).map(|_| ()),
            };
            if c["ok"].as_bool() == Some(true) {
                assert_eq!(got, Ok(()), "{name}");
            } else {
                assert_eq!(got, Err(c["error"].as_str().unwrap()), "{name}");
            }
        }
    }
}
