// CE-1 shared documents (chat-e2ee contract revision 11, PC-1 section 2; API-1c r5 2.1 to 2.8 device side): the Yjs
// client id of a device in a document (`doc_client_id`, from `meet_chat_e2ee.py`) and the checks every device runs on
// a `doc` update or a `docsnap` (`meet_docs.py`): a strict Yjs v1 update reader, the client and generation rules,
// the limits, and state vectors. Refusals carry the `meet_docs` codes (`malformed`, `too_large`, `foreign_client`,
// `lower_g`, `shape`) and the sentence the page shows as the message.

// Built for tests only (`src/main.rs`): the connector never reads documents (r5 2.3, 2.5, 2.7, 7.1), but r5 2.5
// requires every chat vector to pass.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::ce_device::{fail, CeError, CeResult};

pub const DOC_MAX: usize = 8 * 1024 * 1024;
pub const STRUCTS_MAX: usize = 10000;
pub const STRING_MAX: usize = 1024 * 1024;
pub const NEST_MAX: usize = 64;
pub const TEXT_NOT_VERIFIED: &str = "This edit could not be verified";

const DOC_CLIENT: &str = "lucid-meet-doc-client-v1";
const MAX_INT: u64 = (1 << 53) - 1;
const LIMIT_53: u64 = 1 << 53;

fn doc_err(code: &'static str) -> CeError {
    CeError { code, message: TEXT_NOT_VERIFIED.to_string() }
}

fn malformed() -> CeError {
    doc_err("malformed")
}

fn too_large(kind: &str) -> CeError {
    let word = if kind == "list" { "list" } else { "canvas" };
    CeError { code: "too_large", message: format!("This {word} is too large to change here.") }
}

// -- ids (the few CE-1 checks doc_client_id needs) ---------------------------------------------------------------

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn check_cid(cid: &str) -> CeResult<()> {
    let ok = cid.strip_prefix("dm:").is_some_and(|h| is_lower_hex(h, 64))
        || cid.strip_prefix("ai:").is_some_and(|h| is_lower_hex(h, 64))
        || (cid.starts_with("ch:") && cid.len() > 3)
        || cid.strip_prefix("room:").is_some_and(|rest| rest.find(':').is_some_and(|i| i > 0) && !cid.ends_with(':'));
    if !ok {
        return fail("encoding", "not a conversation id");
    }
    Ok(())
}

fn lp(fields: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(fields.iter().map(|f| 4 + f.len()).sum());
    for f in fields {
        out.extend_from_slice(&(f.len() as u32).to_be_bytes());
        out.extend_from_slice(f);
    }
    out
}

/// The Yjs `clientID` of `device` in a document at generation `g`: the first 32 bits (big-endian) of SHA-256 of
/// `lp("lucid-meet-doc-client-v1", cid, doc id, device, u64(g))`. Independent of the epoch.
pub fn doc_client_id(cid: &str, doc_id: &str, device: &str, g: u64) -> CeResult<u32> {
    check_cid(cid)?;
    if !is_lower_hex(doc_id, 32) {
        return fail("encoding", "not a document id");
    }
    if !is_lower_hex(device, 16) {
        return fail("encoding", "not a device id");
    }
    if !(1..=MAX_INT).contains(&g) {
        return fail("encoding", "generation out of range");
    }
    let h = crate::codec::sha256(&lp(&[DOC_CLIENT.as_bytes(), cid.as_bytes(), doc_id.as_bytes(), device.as_bytes(), &g.to_be_bytes()]));
    Ok(u32::from_be_bytes([h[0], h[1], h[2], h[3]]))
}

// -- bytes --------------------------------------------------------------------------------------------------------

/// lib0 decoding: varuint (at most 53 bits), varint, strings, raw bytes.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> CeResult<u8> {
        let Some(&b) = self.buf.get(self.pos) else { return Err(malformed()) };
        self.pos += 1;
        Ok(b)
    }

    fn varuint(&mut self) -> CeResult<u64> {
        let (mut num, mut mult) = (0u64, 1u64);
        loop {
            let r = self.u8()?;
            num += (r & 0x7F) as u64 * mult;
            if r < 0x80 {
                return Ok(num);
            }
            mult *= 128;
            if mult > LIMIT_53 {
                return Err(malformed());
            }
        }
    }

    fn varint(&mut self) -> CeResult<()> {
        let r = self.u8()?;
        if r & 0x80 == 0 {
            return Ok(());
        }
        let mut mult = 64u64;
        loop {
            let r = self.u8()?;
            if r < 0x80 {
                return Ok(());
            }
            mult *= 128;
            if mult > LIMIT_53 {
                return Err(malformed());
            }
        }
    }

    fn take(&mut self, n: u64) -> CeResult<&'a [u8]> {
        let end = usize::try_from(n).ok().and_then(|n| self.pos.checked_add(n)).filter(|&e| e <= self.buf.len());
        let Some(end) = end else { return Err(malformed()) };
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn varbytes(&mut self) -> CeResult<&'a [u8]> {
        let n = self.varuint()?;
        self.take(n)
    }

    fn varstring(&mut self) -> CeResult<&'a str> {
        std::str::from_utf8(self.varbytes()?).map_err(|_| malformed())
    }
}

/// The longest string seen, in UTF-16 code units.
struct Stats {
    max_string: usize,
}

impl Stats {
    fn string(&mut self, s: &str) -> usize {
        let n = s.encode_utf16().count();
        if n > self.max_string {
            self.max_string = n;
        }
        n
    }
}

fn read_any(r: &mut Reader, stats: &mut Stats, depth: usize) -> CeResult<()> {
    if depth > NEST_MAX {
        return Err(too_large("canvas"));
    }
    match r.u8()? {
        127 | 126 | 121 | 120 => {}
        125 => r.varint()?,
        124 => {
            r.take(4)?;
        }
        123 | 122 => {
            r.take(8)?;
        }
        119 => {
            stats.string(r.varstring()?);
        }
        118 => {
            for _ in 0..r.varuint()? {
                stats.string(r.varstring()?);
                read_any(r, stats, depth + 1)?;
            }
        }
        117 => {
            for _ in 0..r.varuint()? {
                read_any(r, stats, depth + 1)?;
            }
        }
        116 => {
            r.varbytes()?;
        }
        _ => return Err(malformed()),
    }
    Ok(())
}

const REF_GC: u8 = 0;
const REF_DELETED: u8 = 1;
const REF_JSON: u8 = 2;
const REF_BINARY: u8 = 3;
const REF_STRING: u8 = 4;
const REF_EMBED: u8 = 5;
const REF_FORMAT: u8 = 6;
const REF_TYPE: u8 = 7;
const REF_ANY: u8 = 8;
const REF_DOC: u8 = 9;
const REF_SKIP: u8 = 10;
const BIT_ORIGIN: u8 = 0x80;
const BIT_RIGHT: u8 = 0x40;
const BIT_SUB: u8 = 0x20;

/// The length of an item's content (Yjs `readItemContent`).
fn read_content(r: &mut Reader, rf: u8, stats: &mut Stats) -> CeResult<u64> {
    match rf {
        REF_DELETED => r.varuint(),
        REF_JSON => {
            let n = r.varuint()?;
            let mut count = 0u64;
            for _ in 0..n {
                stats.string(r.varstring()?);
                count += 1;
            }
            Ok(count)
        }
        REF_BINARY => {
            r.varbytes()?;
            Ok(1)
        }
        REF_STRING => Ok(stats.string(r.varstring()?) as u64),
        REF_EMBED => {
            stats.string(r.varstring()?);
            Ok(1)
        }
        REF_FORMAT => {
            stats.string(r.varstring()?);
            stats.string(r.varstring()?);
            Ok(1)
        }
        REF_TYPE => {
            match r.varuint()? {
                3 | 5 => {
                    stats.string(r.varstring()?);
                }
                0 | 1 | 2 | 4 | 6 => {}
                _ => return Err(malformed()),
            }
            Ok(1)
        }
        REF_ANY => {
            let n = r.varuint()?;
            let mut count = 0u64;
            for _ in 0..n {
                read_any(r, stats, 1)?;
                count += 1;
            }
            Ok(count)
        }
        REF_DOC => {
            stats.string(r.varstring()?);
            read_any(r, stats, 1)?;
            Ok(1)
        }
        _ => Err(malformed()),
    }
}

/// What a reader needs of one update: the clients of its inserted structs (GC included, skips not), how many
/// structs, the longest string (UTF-16 code units), the state vector it reaches (client to end clock), and its size
/// in bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateInfo {
    pub clients: BTreeSet<u64>,
    pub structs: usize,
    pub max_string: usize,
    pub sv: BTreeMap<u64, u64>,
    pub size: usize,
}

/// A Yjs v1 update read whole; `malformed` (or `too_large` for values nested too deep) otherwise.
pub fn read_update(update: &[u8]) -> CeResult<UpdateInfo> {
    let mut r = Reader { buf: update, pos: 0 };
    let mut stats = Stats { max_string: 0 };
    let mut info = UpdateInfo {
        clients: BTreeSet::new(),
        structs: 0,
        max_string: 0,
        sv: BTreeMap::new(),
        size: update.len(),
    };
    for _ in 0..r.varuint()? {
        let count = r.varuint()?;
        let client = r.varuint()?;
        let mut clock = r.varuint()?;
        if client > 0xFFFF_FFFF {
            return Err(malformed());
        }
        for _ in 0..count {
            let flags = r.u8()?;
            let rf = flags & 0x1F;
            let length = if rf == REF_GC || rf == REF_SKIP {
                let length = r.varuint()?;
                if length < 1 {
                    return Err(malformed());
                }
                length
            } else {
                if flags & BIT_ORIGIN != 0 {
                    r.varuint()?;
                    r.varuint()?;
                }
                if flags & BIT_RIGHT != 0 {
                    r.varuint()?;
                    r.varuint()?;
                }
                if flags & (BIT_ORIGIN | BIT_RIGHT) == 0 {
                    if r.varuint()? == 1 {
                        // the parent is a root type, by name
                        stats.string(r.varstring()?);
                    } else {
                        // the parent is an item, by id
                        r.varuint()?;
                        r.varuint()?;
                    }
                    if flags & BIT_SUB != 0 {
                        stats.string(r.varstring()?);
                    }
                }
                let length = read_content(&mut r, rf, &mut stats)?;
                if length < 1 {
                    return Err(malformed());
                }
                length
            };
            if rf != REF_SKIP {
                info.structs += 1;
                info.clients.insert(client);
                let end = clock + length;
                let held = info.sv.entry(client).or_insert(0);
                if end > *held {
                    *held = end;
                }
            }
            clock += length;
            if clock > LIMIT_53 {
                return Err(malformed());
            }
        }
    }
    for _ in 0..r.varuint()? {
        // the delete set may name any client
        r.varuint()?;
        for _ in 0..r.varuint()? {
            r.varuint()?;
            r.varuint()?;
        }
    }
    if r.pos != update.len() {
        return Err(malformed());
    }
    info.max_string = stats.max_string;
    Ok(info)
}

/// `too_large` over a limit (10000 structs, a 1 MiB string, an 8 MiB update).
pub fn check_limits(info: UpdateInfo, kind: &str) -> CeResult<UpdateInfo> {
    if info.structs > STRUCTS_MAX || info.max_string > STRING_MAX || info.size > DOC_MAX {
        return Err(too_large(kind));
    }
    Ok(info)
}

/// A generation: `1 ..= 2^53 - 1`, else `shape`.
pub fn check_g(g: u64) -> CeResult<u64> {
    if !(1..=MAX_INT).contains(&g) {
        return Err(doc_err("shape"));
    }
    Ok(g)
}

/// A `doc` update from `device` with generation `g`: `lower_g` when `g` is lower than `seen_g` (the highest seen
/// from that device in this document), `foreign_client` when an inserted struct names another client than the
/// derived id, `too_large` over a limit, `malformed` when unreadable. The delete set may name any client.
pub fn check_doc(cid: &str, doc_id: &str, device: &str, g: u64, update: &[u8], seen_g: u64, kind: &str) -> CeResult<UpdateInfo> {
    check_g(g)?;
    if g < seen_g {
        return Err(doc_err("lower_g"));
    }
    let info = check_limits(read_update(update)?, kind)?;
    let want = doc_client_id(cid, doc_id, device, g)? as u64;
    if info.clients.iter().any(|&c| c != want) {
        return Err(doc_err("foreign_client"));
    }
    Ok(info)
}

/// The highest generation seen per device in one document; a lower one is refused.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GTracker {
    seen: HashMap<String, u64>,
}

impl GTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn seen(&self, device: &str) -> u64 {
        self.seen.get(device).copied().unwrap_or(0)
    }

    pub fn note(&mut self, device: &str, g: u64) -> CeResult<()> {
        check_g(g)?;
        if g < self.seen(device) {
            return Err(doc_err("lower_g"));
        }
        self.seen.insert(device.to_string(), g);
        Ok(())
    }
}

// -- state vectors and snapshots ----------------------------------------------------------------------------------

/// Strict base64 of at most `limit` bytes: `shape` when unreadable, `too_large` when longer.
pub fn b64decode(value: &str, limit: usize, kind: &str) -> CeResult<Vec<u8>> {
    if value.is_empty() {
        return Err(doc_err("shape"));
    }
    if value.len() > (limit + 2) / 3 * 4 {
        return Err(too_large(kind));
    }
    crate::meet_json::b64_strict(value).ok_or_else(|| doc_err("shape"))
}

/// A Yjs state vector (varuint count, then client and clock pairs); zero clocks dropped.
pub fn decode_sv(data: &[u8]) -> CeResult<BTreeMap<u64, u64>> {
    let mut r = Reader { buf: data, pos: 0 };
    let mut out: BTreeMap<u64, u64> = BTreeMap::new();
    for _ in 0..r.varuint()? {
        let client = r.varuint()?;
        let clock = r.varuint()?;
        // as meet_docs.decode_sv: only a client already holding a nonzero clock counts as repeated
        if out.contains_key(&client) {
            return Err(malformed());
        }
        if clock != 0 {
            out.insert(client, clock);
        }
    }
    if r.pos != data.len() {
        return Err(malformed());
    }
    Ok(out)
}

/// The state vector a set of updates reaches together.
pub fn merged_sv<B: AsRef<[u8]>>(updates: &[B]) -> CeResult<BTreeMap<u64, u64>> {
    let mut out: BTreeMap<u64, u64> = BTreeMap::new();
    for u in updates {
        for (client, clock) in read_update(u.as_ref())?.sv {
            let held = out.entry(client).or_insert(0);
            if clock > *held {
                *held = clock;
            }
        }
    }
    Ok(out)
}

/// True when the updates a snapshot covers reach exactly the state vector it names.
pub fn snapshot_sv_matches<B: AsRef<[u8]>>(sv_b64: &str, covered_updates: &[B]) -> bool {
    let Ok(want) = b64decode(sv_b64, DOC_MAX, "canvas").and_then(|raw| decode_sv(&raw)) else { return false };
    matches!(merged_sv(covered_updates), Ok(got) if got == want)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/chat_e2ee_v1.json")).expect("vectors parse")
    }

    fn unb64(s: &Value) -> Vec<u8> {
        crate::meet_json::b64_strict(s.as_str().unwrap()).unwrap()
    }

    fn unhex(s: &str) -> Vec<u8> {
        let v = |c: u8| if c.is_ascii_digit() { c - b'0' } else { c - b'a' + 10 };
        s.as_bytes().chunks(2).map(|p| (v(p[0]) << 4) | v(p[1])).collect()
    }

    fn outcome<T>(r: &CeResult<T>) -> (bool, &'static str) {
        match r {
            Ok(_) => (true, ""),
            Err(e) => (false, e.code),
        }
    }

    // make_chat_e2ee_v1.py check_doc_updates
    #[test]
    fn doc_update_vectors() {
        let data = vectors();
        let cases = data["doc_update"].as_array().unwrap();
        assert!(!cases.is_empty());
        let envelopes = data["envelope"].as_array().unwrap();
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let (cid, doc_id, device) = (c["cid"].as_str().unwrap(), c["doc_id"].as_str().unwrap(), c["device"].as_str().unwrap());
            let g = c["g"].as_u64().unwrap();
            let update = unb64(&c["update_b64"]);
            assert_eq!(doc_client_id(cid, doc_id, device, g).unwrap() as u64, c["client_id"].as_u64().unwrap(), "{name}");
            let got = check_doc(cid, doc_id, device, g, &update, c["seen_g"].as_u64().unwrap(), "canvas");
            assert_eq!(outcome(&got), (c["ok"].as_bool().unwrap(), c["error"].as_str().unwrap_or("")), "{name}");
            if let Ok(info) = &got {
                if !info.clients.is_empty() {
                    assert_eq!(info.clients, BTreeSet::from([c["client_id"].as_u64().unwrap()]), "{name}");
                }
            }
            if let Some(env_name) = c.get("envelope").and_then(Value::as_str) {
                let env = envelopes.iter().find(|e| e["name"] == env_name).expect("the named envelope case");
                let payload: Value = serde_json::from_slice(&unhex(env["payload_hex"].as_str().unwrap())).unwrap();
                assert_eq!((&payload["u"], &payload["g"]), (&c["update_b64"], &c["g"]), "{name}");
                assert_eq!((&env["envelope"]["e"], env["envelope"]["k"].as_str()), (&c["epoch"], Some("doc")), "{name}");
            }
        }
    }

    // make_chat_e2ee_v1.py check_doc_snapshots
    #[test]
    fn doc_snapshot_vectors() {
        let data = vectors();
        let cases = data["doc_snapshot"].as_array().unwrap();
        assert!(!cases.is_empty());
        for c in cases {
            let updates: Vec<Vec<u8>> = c["updates_b64"].as_array().unwrap().iter().map(unb64).collect();
            assert_eq!(
                snapshot_sv_matches(c["sv_b64"].as_str().unwrap(), &updates),
                c["matches"].as_bool().unwrap(),
                "{}",
                c["name"]
            );
        }
    }

    // make_chat_e2ee_v1.py check_doc_generations
    #[test]
    fn doc_generation_vectors() {
        let data = vectors();
        let cases = data["doc_generation"].as_array().unwrap();
        assert!(!cases.is_empty());
        for c in cases {
            let mut tracker = GTracker::new();
            for s in c["steps"].as_array().unwrap() {
                let got = tracker.note(s["device"].as_str().unwrap(), s["g"].as_u64().unwrap());
                assert_eq!(outcome(&got), (s["ok"].as_bool().unwrap(), s["error"].as_str().unwrap_or("")), "{} {s}", c["name"]);
            }
        }
    }

    #[test]
    fn state_vectors_decode() {
        // client 2^31 at clock 2, client 5 at clock 300, client 7 at clock 0 (dropped)
        let raw = [3, 0x80, 0x80, 0x80, 0x80, 0x08, 2, 5, 0xAC, 0x02, 7, 0];
        assert_eq!(decode_sv(&raw).unwrap(), BTreeMap::from([(5u64, 300u64), (1u64 << 31, 2u64)]));
        assert_eq!(decode_sv(&[2, 1, 1, 1, 2]).unwrap_err().code, "malformed");
    }
}
