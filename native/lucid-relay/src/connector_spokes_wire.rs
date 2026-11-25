// Contract API-1 revision 6 (phase 1d), 7.2.3 and 16 (slice 1d3): the Remote Spokes protocol as the connector's service
// hub speaks it, rule for rule from the add-on (`lucidagentIDEaddon` `remote-spoke/src/`):
//
//   canonical            codec.ts `canonical` (object keys sorted by UTF-16 code units at every depth)
//   NodeKey              identity.ts `generateNodeKey`, `nodeIdOf`, `signCompact`, `makeRequest`, `keyCheckCode`
//   seal, open           envelope.ts `seal`, `open`, `parseEnvelope`, `ReplayGuard`: ECDH P-256 with an ephemeral key,
//                        HKDF-SHA256 (salt = SHA-256(epk SPKI || recipient SPKI), info `lucid-remote-spoke/v1
//                        <from>><to> <id>`), AES-256-GCM with the canonical routing header as associated data, ECDSA
//                        P-256 / SHA-256 (DER) by the sender's node key over the canonical envelope without `sig`,
//                        a 10 minute clock window and a replay guard. Every refusal reason is the add-on's.
//   authorization        relay.ts `RelayClient#send`: `Authorization: LucidNode <b64u JSON>`, signed string
//                        `lucid-relay-auth/v2` (legacy header carrying the certificate) or `lucid-relay-auth/v3` (the
//                        hash form naming a registered certificate), audience `relay:<URL host>`.
//   journal              journal.ts `parseEntry`, `verifyEntry`, `verifyRun`.
//   ask_digest           hub.ts `askDigest`.
//   request_plaintext    hub.ts `requestVia`: `{"t": "req", "rid", "op", "args", "crl"?}` as JSON.stringify writes it.
//
// Every primitive runs on AWS-LC (its FIPS module with the `fips` feature). `connector_spokes_tests` replays the
// add-on's own vectors (`scripts/spokes-hub-vectors.ts`) through every function here. Slice 1d4's A2A server
// (`connector_a2a`) calls `held_text`, `task_name` and `ask_digest` (it checks each held ask's digest against the input it
// sent).

use crate::codec::{b64u, exact_keys, hex, js_number_string, parse_json, safe_int, sha256, sha256_hex, str_of, stringify, unb64u, utf16_len, utf8_lossy, MAX_SAFE};
use crate::der::{ecdsa_verify, p256_from_spki, p256_spki_der, P256Key};
use crate::identity::{is_label, node_id_of, NodeCert, TrustStore};
use aws_lc_rs::{aead, agreement, hkdf, signature};
use serde_json::{json, Map, Number, Value};
use std::collections::HashMap;
use std::path::PathBuf;

/// envelope.ts MAX_PLAINTEXT.
pub const MAX_PLAINTEXT: usize = 192 * 1024;
/// envelope.ts CLOCK_WINDOW_MS.
pub const CLOCK_WINDOW_MS: i64 = 10 * 60_000;
/// spoke.ts MAX_TEXT: a task's text and each follow-up, in UTF-16 code units.
pub const MAX_TEXT: usize = 32_000;
/// relay.ts REPLY_CAP_BYTES: the most a client reads of one relay answer.
pub const REPLY_CAP_BYTES: usize = 393_216 + 4_096;
/// hub.ts CONNECTOR_HEADER_RE: the header's text after `[Lucid A2A] ` is 1 to 400 UTF-16 code units, one line.
pub const HEADER_PREFIX: &str = "[Lucid A2A] ";
pub const HEADER_MAX: usize = 400;
/// The label of the connector's node request (identity.ts LABEL_RE: 1 to 64 printable ASCII).
const LABEL_MAX: usize = 64;

// ── canonical JSON (codec.ts) ───────────────────────────────────────────────────────────────────────────────

/// A JSON number as JSON.stringify writes it (integers beyond 2^53 as JavaScript holds them).
fn number_text(n: &Number) -> String {
    match n.as_i64() {
        Some(i) if i.unsigned_abs() <= MAX_SAFE as u64 => i.to_string(),
        _ => js_number_string(n.as_f64().unwrap_or(f64::NAN)),
    }
}

fn canonical_into(v: &Value, out: &mut String) {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k.as_str()).unwrap_or_default());
                out.push(':');
                canonical_into(&o[k.as_str()], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_into(x, out);
            }
            out.push(']');
        }
        Value::Number(n) => out.push_str(&number_text(n)),
        other => out.push_str(&stringify(other)),
    }
}

/// codec.ts `canonical`: object keys sorted (UTF-16 code unit order) at every depth, no white space.
pub fn canonical(v: &Value) -> String {
    let mut out = String::new();
    canonical_into(v, &mut out);
    out
}

/// codec.ts `randomHex(bytes)`.
pub fn random_hex(bytes: usize) -> Result<String, String> {
    let mut b = vec![0u8; bytes];
    aws_lc_rs::rand::fill(&mut b).map_err(|_| "random bytes could not be drawn".to_string())?;
    Ok(hex(&b))
}

/// hub.ts `askDigest`: SHA-256 hex of canonical `{kind, title, input}`, the digest a person's approval signs.
pub fn ask_digest(kind: &str, title: &str, input: &str) -> String {
    sha256_hex(canonical(&json!({ "kind": kind, "title": title, "input": input })).as_bytes())
}

/// codec.ts `checkCode` (identity.ts `keyCheckCode` of an SPKI): the 50-bit code a person compares on two screens.
pub fn check_code(bytes: &[u8]) -> String {
    const B32: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let (mut acc, mut bits, mut out) = (0u64, 0u32, String::with_capacity(11));
    for byte in sha256(bytes) {
        acc = ((acc << 8) | u64::from(byte)) & 0xffff_ffff;
        bits += 8;
        while bits >= 5 && out.len() < 10 {
            out.push(B32[((acc >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        if out.len() >= 10 {
            break;
        }
    }
    format!("{}-{}", &out[..5], &out[5..])
}

// ── the node key ────────────────────────────────────────────────────────────────────────────────────────────

/// A node's P-256 key on AWS-LC: ECDSA for signatures, ECDH for the envelopes it opens. The 32-byte scalar is kept
/// only to be sealed (`connector_spokes`) and wiped on drop; Debug never prints it.
pub struct NodeKey {
    d: Vec<u8>,
    pair: signature::EcdsaKeyPair,
    #[cfg_attr(not(test), allow(dead_code))]
    public: P256Key,
    spki: Vec<u8>,
    node: String,
}

impl std::fmt::Debug for NodeKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NodeKey({}, <redacted>)", self.node)
    }
}

impl Drop for NodeKey {
    fn drop(&mut self) {
        crate::connector_seal::wipe(&mut self.d);
    }
}

impl NodeKey {
    /// A fresh key from AWS-LC's random bytes.
    pub fn generate() -> Result<NodeKey, String> {
        for _ in 0..16 {
            let mut d = [0u8; 32];
            aws_lc_rs::rand::fill(&mut d).map_err(|_| "random bytes could not be drawn".to_string())?;
            let k = NodeKey::from_scalar(&d);
            crate::connector_seal::wipe(&mut d);
            if let Ok(k) = k {
                return Ok(k);
            }
        }
        Err("a node key could not be drawn".to_string())
    }

    /// From the 32-byte big-endian private scalar (a JWK's `d`).
    pub fn from_scalar(d: &[u8]) -> Result<NodeKey, String> {
        let bad = || "a node key is a 32-byte P-256 private scalar".to_string();
        if d.len() != 32 {
            return Err(bad());
        }
        let k = agreement::PrivateKey::from_private_key(&agreement::ECDH_P256, d).map_err(|_| bad())?;
        let point = k.compute_public_key().map_err(|_| bad())?.as_ref().to_vec();
        let pair = signature::EcdsaKeyPair::from_private_key_and_public_key(&signature::ECDSA_P256_SHA256_ASN1_SIGNING, d, &point).map_err(|_| bad())?;
        let public = P256Key::from_sec1(&point).ok_or_else(bad)?;
        let spki = p256_spki_der(&public);
        let node = node_id_of(&spki);
        Ok(NodeKey { d: d.to_vec(), pair, public, spki, node })
    }

    /// The scalar, for the sealed store only.
    pub fn scalar(&self) -> &[u8] {
        &self.d
    }

    /// `n_` and the first 32 hex of SHA-256 of the SPKI (identity.ts `nodeIdOf`).
    pub fn node(&self) -> &str {
        &self.node
    }

    /// The SubjectPublicKeyInfo DER as Node exports it (uncompressed point).
    pub fn spki(&self) -> &[u8] {
        &self.spki
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn public(&self) -> &P256Key {
        &self.public
    }

    /// ECDSA P-256 / SHA-256 over `msg`, DER (Node's `sign("sha256", msg, key)`).
    pub fn sign(&self, msg: &[u8]) -> Result<Vec<u8>, String> {
        self.pair.sign(&aws_lc_rs::rand::SystemRandom::new(), msg).map(|s| s.as_ref().to_vec()).map_err(|_| "a signature could not be made".to_string())
    }

    /// The ECDH shared secret (the x coordinate) with a peer's uncompressed point (Node's `diffieHellman`).
    fn agree(&self, peer_point: &[u8]) -> Result<Vec<u8>, String> {
        let k = agreement::PrivateKey::from_private_key(&agreement::ECDH_P256, &self.d).map_err(|_| "the node key does not read".to_string())?;
        agreement::agree(&k, agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, peer_point), "not a P-256 point".to_string(), |z| Ok(z.to_vec()))
    }
}

/// identity.ts `signCompact`: base64url of the canonical payload, a dot, base64url of the signature over those bytes.
pub fn sign_compact(payload: &Value, key: &NodeKey) -> Result<String, String> {
    let body = canonical(payload);
    Ok(format!("{}.{}", b64u(body.as_bytes()), b64u(&key.sign(body.as_bytes())?)))
}

/// identity.ts `makeRequest(key, "hub", label, {iat})`: the `lucid-node-request` the org root approves with
/// `root approve --service` (version 1: a service hub carries no presence key, it never approves).
pub fn node_request(key: &NodeKey, label: &str, iat: i64) -> Result<String, String> {
    if !is_label(label) || label.len() > LABEL_MAX {
        return Err("label must be 1 to 64 printable ASCII characters".to_string());
    }
    let req = json!({ "v": 1, "typ": "lucid-node-request", "role": "hub", "label": label, "spki": b64u(key.spki()), "iat": iat });
    sign_compact(&req, key)
}

// ── envelopes (envelope.ts) ─────────────────────────────────────────────────────────────────────────────────

/// A sealed envelope: what a hub and a spoke send each other through a relay that learns only the header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub from: String,
    pub to: String,
    pub id: String,
    pub ts: i64,
    pub cert: String,
    pub epk: String,
    pub iv: String,
    pub ct: String,
    pub sig: String,
}

impl Envelope {
    /// envelope.ts `parseEnvelope` (the relay's `parse_envelope`): the exact key set, `v` 1, node ids, a 32 hex id,
    /// a safe integer `ts`, a compact `cert` of at most 65,536 characters, base64url `epk`, `iv`, `ct`, `sig`.
    pub fn parse(v: &Value) -> Option<Envelope> {
        let (o, from, to, id) = crate::relay::parse_envelope(Some(v))?;
        let s = |k: &str| str_of(o.get(k)).map(str::to_owned);
        Some(Envelope { from, to, id, ts: safe_int(o.get("ts"))?, cert: s("cert")?, epk: s("epk")?, iv: s("iv")?, ct: s("ct")?, sig: s("sig")? })
    }

    /// The envelope as the add-on sends it (its key order).
    pub fn to_json(&self) -> Value {
        json!({
            "v": 1, "from": self.from, "to": self.to, "id": self.id, "ts": self.ts, "epk": self.epk,
            "cert": self.cert, "iv": self.iv, "ct": self.ct, "sig": self.sig,
        })
    }

    /// The routing header bound as associated data: canonical `{v, from, to, id, ts, epk}`.
    fn header(&self) -> String {
        canonical(&json!({ "v": 1, "from": self.from, "to": self.to, "id": self.id, "ts": self.ts, "epk": self.epk }))
    }

    /// What the sender signs: the canonical envelope without `sig`.
    fn signed_bytes(&self) -> String {
        canonical(&json!({
            "v": 1, "from": self.from, "to": self.to, "id": self.id, "ts": self.ts, "epk": self.epk, "cert": self.cert, "iv": self.iv, "ct": self.ct,
        }))
    }
}

/// envelope.ts `hkdfKey`: HKDF-SHA256 over the ECDH secret, salted with SHA-256 of both public keys' SPKI.
fn hkdf_key(shared: &[u8], epk_spki: &[u8], recipient_spki: &[u8], info: &str) -> Result<[u8; 32], String> {
    let mut salt_in = Vec::with_capacity(epk_spki.len() + recipient_spki.len());
    salt_in.extend_from_slice(epk_spki);
    salt_in.extend_from_slice(recipient_spki);
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &sha256(&salt_in)).extract(shared);
    let parts = [info.as_bytes()];
    let mut k = [0u8; 32];
    prk.expand(&parts, hkdf::HKDF_SHA256).and_then(|okm| okm.fill(&mut k)).map_err(|_| "the envelope key could not be derived".to_string())?;
    Ok(k)
}

fn envelope_info(from: &str, to: &str, id: &str) -> String {
    format!("lucid-remote-spoke/v1 {from}>{to} {id}")
}

fn gcm(key: &[u8; 32]) -> Result<aead::LessSafeKey, String> {
    Ok(aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| "the envelope key could not be made".to_string())?))
}

/// envelope.ts `seal`: `plaintext` from `sender` (holding `sender_cert`) to the recipient's certified key, with a fresh
/// ephemeral key, IV and envelope id; `now_ms` is the envelope's `ts`.
pub fn seal(sender: &NodeKey, sender_cert: &str, to: &str, recipient: &P256Key, plaintext: &str, now_ms: i64) -> Result<Envelope, String> {
    let mut iv = [0u8; 12];
    aws_lc_rs::rand::fill(&mut iv).map_err(|_| "random bytes could not be drawn".to_string())?;
    let eph = agreement::PrivateKey::generate(&agreement::ECDH_P256).map_err(|_| "the ephemeral key could not be made".to_string())?;
    seal_with(sender, sender_cert, to, recipient, plaintext, now_ms, &eph, iv, &random_hex(16)?)
}

/// `seal` with the ephemeral key, IV and envelope id given (tests pin them).
#[allow(clippy::too_many_arguments)]
pub fn seal_with(sender: &NodeKey, sender_cert: &str, to: &str, recipient: &P256Key, plaintext: &str, now_ms: i64, eph: &agreement::PrivateKey, iv: [u8; 12], id: &str) -> Result<Envelope, String> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(format!("message is {} bytes; the limit is {MAX_PLAINTEXT}", plaintext.len()));
    }
    let eph_point = eph.compute_public_key().map_err(|_| "the ephemeral key could not be made".to_string())?.as_ref().to_vec();
    let epk = p256_spki_der(&P256Key::from_sec1(&eph_point).ok_or("the ephemeral key could not be made")?);
    let recipient_spki = p256_spki_der(recipient);
    let mut env = Envelope { from: sender.node().to_owned(), to: to.to_owned(), id: id.to_owned(), ts: now_ms, cert: sender_cert.to_owned(), epk: b64u(&epk), iv: b64u(&iv), ct: String::new(), sig: String::new() };
    let shared = agreement::agree(eph, agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, recipient.point()), "the recipient key is not a P-256 point".to_string(), |z| Ok(z.to_vec()))?;
    let key = hkdf_key(&shared, &epk, &recipient_spki, &envelope_info(&env.from, &env.to, &env.id))?;
    let mut buf = plaintext.as_bytes().to_vec();
    let header = env.header();
    gcm(&key)?.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(iv), aead::Aad::from(header.as_bytes()), &mut buf).map_err(|_| "the message could not be sealed".to_string())?;
    env.ct = b64u(&buf);
    env.sig = b64u(&sender.sign(env.signed_bytes().as_bytes())?);
    Ok(env)
}

/// envelope.ts `ReplayGuard`: envelope ids already opened, kept for twice the clock window; persisted (ids and times
/// only) when a file is given, so a restart cannot reopen the window for a captured message.
pub struct ReplayGuard {
    seen: HashMap<String, i64>,
    file: Option<PathBuf>,
}

impl ReplayGuard {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn memory() -> ReplayGuard {
        ReplayGuard { seen: HashMap::new(), file: None }
    }

    /// The guard kept in `file` (a missing or unreadable file starts empty).
    pub fn persisted(file: PathBuf) -> ReplayGuard {
        let seen = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_object().map(|o| o.iter().filter_map(|(k, at)| at.as_i64().map(|at| (k.clone(), at))).collect()))
            .unwrap_or_default();
        ReplayGuard { seen, file: Some(file) }
    }

    /// The ids kept, as the file holds them.
    fn write(&self, seen: &HashMap<String, i64>) -> Result<(), String> {
        let Some(f) = &self.file else { return Ok(()) };
        let o: Map<String, Value> = seen.iter().map(|(k, at)| (k.clone(), Value::from(*at))).collect();
        crate::connector_seal::write_private(f, stringify(&Value::Object(o)).as_bytes()).map_err(|e| format!("the replay guard {} could not be saved: {e}", f.display()))
    }

    /// Ok(true) the first time an id is offered, Ok(false) for a repeat. With a file the id is admitted only once the
    /// file holds it (written and fsynced): Err when it cannot be written, and nothing is admitted.
    pub fn admit(&mut self, id: &str, now_ms: i64) -> Result<bool, String> {
        self.seen.retain(|_, at| now_ms - *at <= 2 * CLOCK_WINDOW_MS);
        if self.seen.contains_key(id) {
            return Ok(false);
        }
        let mut next = self.seen.clone();
        next.insert(id.to_owned(), now_ms);
        self.write(&next)?;
        self.seen = next;
        Ok(true)
    }

    /// Ids admitted from a batch that was not acknowledged: offered again, they open again. The memory forgets them at
    /// once; Err when the file could not be rewritten (a restart then refuses them as replays).
    pub fn forget(&mut self, ids: &[String]) -> Result<(), String> {
        if ids.iter().all(|id| !self.seen.contains_key(id)) {
            return Ok(());
        }
        for id in ids {
            self.seen.remove(id);
        }
        self.write(&self.seen)
    }
}

/// What `open` gives: the sender's verified certificate and key, the plaintext and the envelope id.
pub struct Opened {
    pub from: NodeCert,
    #[cfg_attr(not(test), allow(dead_code))]
    pub from_key: P256Key,
    pub plaintext: String,
    #[cfg_attr(not(test), allow(dead_code))]
    pub id: String,
}

/// Why `open` gave nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// The envelope is refused: the add-on's reason, word for word.
    Refused(String),
    /// The replay guard could not keep the id durably: nothing was admitted, and the envelope must stay unacknowledged.
    Unavailable(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Refused(m) | OpenError::Unavailable(m) => f.write_str(m),
        }
    }
}

/// envelope.ts `open`: an envelope addressed to `me` from a sender whose certificate (verified by `trust` at `now_ms`)
/// carries one of `accept_roles`; `Refused` with the add-on's reason, word for word, or `Unavailable` when the replay
/// guard cannot keep the id.
pub fn open(me: &NodeKey, trust: &TrustStore, env: &Envelope, accept_roles: &[&str], replay: &mut ReplayGuard, now_ms: i64) -> Result<Opened, OpenError> {
    let no = |m: &str| Err(OpenError::Refused(m.to_owned()));
    if env.to != me.node() {
        return no("not addressed to this node");
    }
    let c = trust.verify_cert(Some(&Value::String(env.cert.clone())), now_ms.div_euclid(1000)).map_err(|reason| OpenError::Refused(format!("sender: {reason}")))?;
    if c.cert.node != env.from {
        return no("sender certificate names another node");
    }
    if !accept_roles.contains(&c.cert.role.as_str()) {
        return no(&format!("a {} may not send to this node", c.cert.role));
    }
    let good = unb64u(&env.sig).is_some_and(|s| ecdsa_verify(&c.key, env.signed_bytes().as_bytes(), &s));
    if !good {
        return no("envelope signature does not match the sender");
    }
    if (now_ms - env.ts).abs() > CLOCK_WINDOW_MS {
        return no("envelope is outside the clock window");
    }
    if !replay.admit(&env.id, now_ms).map_err(OpenError::Unavailable)? {
        return no("envelope already opened (replay)");
    }
    let (Some(epk), Some(iv), Some(mut ct)) = (unb64u(&env.epk), unb64u(&env.iv), unb64u(&env.ct)) else { return no("ciphertext does not authenticate") };
    if iv.len() != 12 || ct.len() < 16 {
        return no("malformed ciphertext");
    }
    let opened = (|| -> Option<String> {
        let eph = p256_from_spki(&epk)?;
        let shared = me.agree(eph.point()).ok()?;
        let key = hkdf_key(&shared, &epk, me.spki(), &envelope_info(&env.from, &env.to, &env.id)).ok()?;
        let nonce = aead::Nonce::assume_unique_for_key(<[u8; 12]>::try_from(iv.as_slice()).ok()?);
        let pt = gcm(&key).ok()?.open_in_place(nonce, aead::Aad::from(env.header().as_bytes()), &mut ct).ok()?;
        Some(utf8_lossy(pt))
    })();
    let Some(plaintext) = opened else { return no("ciphertext does not authenticate") };
    Ok(Opened { from: c.cert, from_key: c.key, plaintext, id: env.id.clone() })
}

// ── requests and replies (hub.ts, spoke.ts) ─────────────────────────────────────────────────────────────────

/// hub.ts `requestVia`: the sealed request text, `JSON.stringify({t: "req", rid, op, args, crl?})`.
pub fn request_plaintext(rid: &str, op: &str, args: &Value, crl: Option<&str>) -> String {
    let mut m = json!({ "t": "req", "rid": rid, "op": op, "args": args });
    if let Some(c) = crl {
        m["crl"] = Value::from(c);
    }
    stringify(&m)
}

/// A spoke's reply (hub.ts `#take`): `ok` only when it is `true`, `data` as sent, `error` when it is a string.
#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    pub ok: bool,
    pub data: Value,
    pub error: Option<String>,
}

impl Reply {
    pub fn of(m: &Map<String, Value>) -> Reply {
        Reply { ok: m.get("ok") == Some(&Value::Bool(true)), data: m.get("data").cloned().unwrap_or(Value::Null), error: str_of(m.get("error")).map(str::to_owned) }
    }
}

// ── the connector's header (contract r6 7.5, R6-6) ──────────────────────────────────────────────────────────

/// One header field on one line: control characters become spaces.
fn one_line(s: &str) -> String {
    s.chars().map(|c| if c.is_control() || c == '\u{2028}' || c == '\u{2029}' { ' ' } else { c }).collect()
}

/// The parties a held instruction names: the partner client, its owner, the agent and the skill (contract r6 7.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Partner {
    pub client_name: String,
    pub client_id: String,
    pub owner: String,
    pub agent_name: String,
    pub agent_id: String,
    pub skill: String,
}

/// `<prefix>` and 16 lowercase hex digits.
fn id_ok(s: &str, prefix: &str) -> bool {
    s.strip_prefix(prefix).is_some_and(|h| h.len() == 16 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}

/// `[Lucid A2A] Partner: <client name> (<client id>), owner <owner>. Agent: <agent name> (<agent id>). Skill: <skill
/// id>.`, one line, every field whole: hub.ts CONNECTOR_HEADER_RE shows at most 400 UTF-16 code units after the
/// prefix, so a header longer than that (a very long owner email or name) is refused, never cut. Err also when an id
/// or the skill id is not of its form (`c_`, `a_` and 16 hex; `[a-z0-9-]{1,64}`).
pub fn connector_header(p: &Partner) -> Result<String, String> {
    if !id_ok(&p.client_id, "c_") || !id_ok(&p.agent_id, "a_") {
        return Err("the partner client or agent id is not of its form".into());
    }
    if !(1..=64).contains(&p.skill.len()) || !p.skill.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
        return Err("the skill id is not of its form".into());
    }
    let body = one_line(&format!("Partner: {} ({}), owner {}. Agent: {} ({}). Skill: {}.", p.client_name, p.client_id, p.owner, p.agent_name, p.agent_id, p.skill));
    if utf16_len(&body) > HEADER_MAX {
        return Err(format!("Lucid's header naming the partner would be over {HEADER_MAX} characters (a name or the owner's email is too long)"));
    }
    Ok(format!("{HEADER_PREFIX}{body}"))
}

/// The `input` of a held instruction: the connector's header, a blank line, then the partner's text. Err when the
/// header is refused, the whole is over the spoke's 32,000 characters or the text is blank.
pub fn held_text(p: &Partner, text: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("the message has no text".into());
    }
    let full = format!("{}\n\n{text}", connector_header(p)?);
    if utf16_len(&full) > MAX_TEXT {
        return Err(format!("the message with Lucid's header is over the spoke's {MAX_TEXT} characters"));
    }
    Ok(full)
}

/// The spoke task name for a skill (contract r6 7.5: the connector sets it to the skill id): the id itself when it fits
/// spoke.ts NAME_RE (`[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}`), its first 48 characters when longer; None when it cannot.
pub fn task_name(skill: &str) -> Option<String> {
    let name: String = skill.chars().take(48).collect();
    let b = name.as_bytes();
    (!b.is_empty() && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b' ' | b'.' | b'_' | b'-'))).then_some(name)
}

// ── relay authorization (relay.ts RelayClient) ──────────────────────────────────────────────────────────────

/// RS-RELAY-03: `relay:<host>` of a relay URL as `new URL(url).host` reads it (lower case, the default port left out).
pub fn audience_of(url: &str) -> Option<String> {
    let (tls, rest) = match url.split_once("://")? {
        ("https", r) => (true, r),
        ("http", r) => (false, r),
        _ => return None,
    };
    let authority = rest.split(&['/', '?', '#'][..]).next().filter(|a| !a.is_empty() && !a.contains('@'))?;
    Some(format!("relay:{}", crate::server::dialed_of(authority, tls).host))
}

/// The signed request string: `lucid-relay-auth/v2` lines, or under `v3` with the `cert_sha256` the header names.
pub fn auth_string(audience: &str, method: &str, path: &str, ts: i64, nonce: &str, body: &[u8], cert_sha256: Option<&str>) -> String {
    let body_hash = sha256_hex(body);
    match cert_sha256 {
        None => format!("lucid-relay-auth/v2\n{audience}\n{method}\n{path}\n{ts}\n{nonce}\n{body_hash}"),
        Some(sha) => format!("lucid-relay-auth/v3\n{audience}\n{method}\n{path}\n{ts}\n{nonce}\n{body_hash}\n{sha}"),
    }
}

/// `Authorization: LucidNode <b64u JSON>`: `{cert, ts, nonce, sig}` (legacy) or `{cert_sha256, ts, nonce, sig}`.
#[allow(clippy::too_many_arguments)]
pub fn authorization(key: &NodeKey, cert: &str, hashed: bool, audience: &str, method: &str, path: &str, body: &[u8], ts: i64, nonce: &str) -> Result<String, String> {
    let sha = hashed.then(|| sha256_hex(cert.as_bytes()));
    let signed = auth_string(audience, method, path, ts, nonce, body, sha.as_deref());
    let sig = b64u(&key.sign(signed.as_bytes())?);
    let a = match sha {
        None => json!({ "cert": cert, "ts": ts, "nonce": nonce, "sig": sig }),
        Some(sha) => json!({ "cert_sha256": sha, "ts": ts, "nonce": nonce, "sig": sig }),
    };
    Ok(format!("LucidNode {}", b64u(stringify(&a).as_bytes())))
}

// ── the spoke journal (journal.ts) ──────────────────────────────────────────────────────────────────────────

/// One signed, hash-chained spoke journal entry.
#[derive(Clone, Debug, PartialEq)]
pub struct JournalEntry {
    pub seq: i64,
    pub ts: i64,
    pub task: String,
    pub kind: String,
    pub data: Map<String, Value>,
    pub prev: String,
    pub hash: String,
    pub sig: String,
}

impl JournalEntry {
    /// journal.ts `parseEntry`.
    pub fn parse(v: &Value) -> Option<JournalEntry> {
        const KEYS: [&str; 8] = ["seq", "ts", "task", "kind", "data", "prev", "hash", "sig"];
        let o = v.as_object().filter(|o| exact_keys(o, &KEYS, &KEYS))?;
        let s = |k: &str| str_of(o.get(k)).map(str::to_owned);
        Some(JournalEntry { seq: safe_int(o.get("seq"))?, ts: safe_int(o.get("ts"))?, task: s("task")?, kind: s("kind")?, data: o.get("data")?.as_object()?.clone(), prev: s("prev")?, hash: s("hash")?, sig: s("sig")? })
    }

    fn hash_of(&self) -> String {
        sha256_hex(canonical(&json!({ "seq": self.seq, "ts": self.ts, "task": self.task, "kind": self.kind, "data": self.data, "prev": self.prev })).as_bytes())
    }

    /// journal.ts `verifyEntry`: the hash recomputes and the spoke's key signed it.
    pub fn verify(&self, spoke: &P256Key) -> bool {
        if self.hash_of() != self.hash {
            return false;
        }
        let Some(digest) = (0..self.hash.len()).step_by(2).map(|i| u8::from_str_radix(&self.hash[i..i + 2], 16).ok()).collect::<Option<Vec<u8>>>() else { return false };
        unb64u(&self.sig).is_some_and(|s| ecdsa_verify(spoke, &digest, &s))
    }
}

/// journal.ts `verifyRun`: every entry signed, in order, and linked wherever seqs are adjacent.
pub fn verify_run(entries: &[JournalEntry], spoke: &P256Key) -> Result<(), String> {
    for (i, e) in entries.iter().enumerate() {
        if !e.verify(spoke) {
            return Err(format!("entry {} fails its hash or signature", e.seq));
        }
        if let Some(p) = i.checked_sub(1).map(|j| &entries[j]) {
            if e.seq <= p.seq {
                return Err(format!("entry {} is out of order", e.seq));
            }
            if e.seq == p.seq + 1 && e.prev != p.hash {
                return Err(format!("entry {} does not link to {}", e.seq, p.seq));
            }
        }
    }
    Ok(())
}

/// A JSON text's object, or None.
pub fn object_of(text: &str) -> Option<Map<String, Value>> {
    match parse_json(text)? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}
