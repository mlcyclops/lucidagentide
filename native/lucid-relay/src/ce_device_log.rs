// CE-1 member and service logs, org policies, key stores and sender keys, the device side (docs/chat-e2ee/
// contract.md revision 11: section 5 sender keys and epochs, 7.1 DM device sets with archives, 7.2 the member log
// with its revision 6 service ops and the revision 11 membership intervals (docs/api/contract-r5-1c.md 5.2), 10
// retention bookkeeping). A port of the `LogState`, `extend_log`, `replay_log`, `PolicyView`, `KeyStore` and
// `SenderKeys` parts of `src/meet_chat_e2ee.py`; the encodings, signatures and messages are in `ce_device.rs`.
//
// Org policies reach this module only as verified plain objects (`PolicyView`); `meet_org_policy` verifies them.
// The log, key store and sender key states convert to and from `serde_json::Value` for the caller to seal at rest.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde_json::{json, Map, Value};

use crate::ce_device::{
    cert_kind, check_device, check_int, check_n, check_policy_hash, check_principal, cid_kind, device_value, encoding_error, fail, int_of, int_or0, lp, log_refused, principal_domain, principal_kind,
    principal_value, repeated_key, set_hash, sort_pds, u64b, unb64, unhex, CeCert, CeError, CeResult, CertSource, DckKey, DeviceKey, Head, Pd, VerifiedBundle, Verifier, API_APP_TYPE, CHANNEL_MAX,
    DOC_KINDS, DOC_ROTATE, DOC_STREAM, JOIN_EPOCH_MAX_S, MAX_INT, MEMBER, ROLE_OPS, ROTATE_MESSAGES, ROTATE_S, SKEW_MS, ZERO_HASH, ZERO_HEAD,
};
use crate::codec::{hex, sha256};
use crate::meet_json::random_bytes;

pub const LOG_OPS: [&str; 13] = ["create", "baseline", "confirm", "add", "join", "leave", "remove", "admin", "unadmin", "archive", "unarchive", "link_app", "unlink_app"];
/// The signed bytes add the policy hash.
pub const POLICY_OPS: [&str; 2] = ["archive", "unarchive"];
pub const CONVERSATION_KINDS: [&str; 3] = ["public", "private", "group"];

fn rules<T>(message: &str) -> CeResult<T> {
    fail("rules", message)
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}

// -- section 7: the member log -----------------------------------------------------------------------------------

/// One parsed member log entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub seq: i64,
    pub op: String,
    pub by: String,
    pub by_device: String,
    pub who: Vec<String>,
    pub ts: i64,
    pub prev: [u8; 32],
    pub kind: String,
    pub bridgeable: bool,
    pub admins: Vec<String>,
    pub sig: String,
    /// Revision 6: archive and unarchive only (32 raw bytes).
    pub policy: Vec<u8>,
}

fn principals(v: &Value, what: &str) -> CeResult<Vec<String>> {
    let Some(items) = v.as_array() else { return Err(encoding_error(format!("{what} is a list"))) };
    let out = items.iter().map(principal_value).collect::<CeResult<Vec<String>>>()?;
    if out.iter().collect::<BTreeSet<_>>().len() != out.len() {
        return Err(encoding_error(format!("{what} lists someone twice")));
    }
    Ok(out)
}

const ENTRY_KEYS: [&str; 8] = ["seq", "op", "by", "by_device", "who", "ts", "prev", "sig"];
const START_KEYS: [&str; 3] = ["kind", "bridgeable", "admins"];

pub fn parse_entry(entry: &Value, need_sig: bool) -> CeResult<Entry> {
    let Some(o) = entry.as_object() else { return Err(encoding_error("a log entry is an object")) };
    let Some(op) = o.get("op").and_then(Value::as_str).filter(|op| LOG_OPS.contains(op)) else { return Err(encoding_error("unknown log op")) };
    let start = op == "create" || op == "baseline";
    if !ENTRY_KEYS.iter().all(|k| o.contains_key(*k) || (*k == "sig" && !need_sig)) {
        return Err(encoding_error("a log entry lacks fields"));
    }
    let any_start = START_KEYS.iter().any(|k| o.contains_key(*k));
    if start != any_start || (start && !START_KEYS.iter().all(|k| o.contains_key(*k))) {
        return Err(encoding_error("kind, bridgeable and admins belong to create and baseline only"));
    }
    let policy_op = POLICY_OPS.contains(&op);
    if policy_op != o.contains_key("policy") {
        return Err(encoding_error("policy belongs to archive and unarchive only"));
    }
    let policy = if policy_op {
        let h = o["policy"].as_str().unwrap_or("");
        check_policy_hash(h)?;
        unhex(&o["policy"], "policy", 32)?
    } else {
        Vec::new()
    };
    let seq = check_int(&o["seq"], "seq", 1)?;
    let ts = check_int(&o["ts"], "ts", 0)?;
    let who = principals(&o["who"], "who")?;
    let (kind, bridgeable, admins) = if start {
        let Some(kind) = o["kind"].as_str().filter(|k| CONVERSATION_KINDS.contains(k)) else { return Err(encoding_error("unknown conversation kind")) };
        let Some(bridgeable) = o["bridgeable"].as_bool() else { return Err(encoding_error("bridgeable is true or false")) };
        (kind.to_string(), bridgeable, principals(&o["admins"], "admins")?)
    } else {
        (String::new(), false, Vec::new())
    };
    let sig = match o.get("sig") {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err(encoding_error("signature")),
    };
    let by = principal_value(&o["by"])?;
    let by_device = device_value(&o["by_device"])?;
    let prev: [u8; 32] = unhex(&o["prev"], "prev", 32)?.try_into().map_err(|_| encoding_error("prev"))?;
    Ok(Entry { seq, op: op.to_string(), by, by_device, who, ts, prev, kind, bridgeable, admins, sig, policy })
}

/// Revision 3 fields; `archive` and `unarchive` add the 32 raw bytes of the policy hash as one more field.
pub fn entry_bytes(cid: &str, e: &Entry) -> Vec<u8> {
    let mut who = e.who.clone();
    who.sort();
    let mut admins = e.admins.clone();
    admins.sort();
    let (seq, n_who, ts, n_admins) = (u64b(e.seq), u64b(who.len() as i64), u64b(e.ts), u64b(admins.len() as i64));
    let bridgeable: &[u8] = if e.bridgeable { b"1" } else { b"0" };
    let mut fields: Vec<&[u8]> = vec![MEMBER.as_bytes(), cid.as_bytes(), &seq[..], e.op.as_bytes(), e.by.as_bytes(), e.by_device.as_bytes(), &n_who[..]];
    fields.extend(who.iter().map(|p| p.as_bytes()));
    fields.extend([&ts[..], &e.prev[..], e.kind.as_bytes(), bridgeable, &n_admins[..]]);
    fields.extend(admins.iter().map(|p| p.as_bytes()));
    if POLICY_OPS.contains(&e.op.as_str()) {
        fields.push(&e.policy);
    }
    lp(&fields)
}

// Test-only: the CE-1 vectors pin the signed bytes with it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn member_signed_bytes(cid: &str, entry: &Value) -> CeResult<Vec<u8>> {
    cid_kind(cid)?;
    Ok(entry_bytes(cid, &parse_entry(entry, false)?))
}

// Test-only: the CE-1 vectors and the connector tests build logs with it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn entry_hash(cid: &str, entry: &Value) -> CeResult<[u8; 32]> {
    Ok(sha256(&member_signed_bytes(cid, entry)?))
}

/// A signed entry. `kind`, `bridgeable` and `admins` go on `create` and `baseline` only; `policy` (the hex
/// `policy_hash`) on `archive` and `unarchive` only.
// Test-only: the CE-1 vectors and the connector tests sign log entries with it.
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn make_entry(device_key: &DeviceKey, cid: &str, seq: i64, op: &str, by: &str, by_device: &str, who: &[String], ts: i64, prev: &[u8], kind: &str, bridgeable: bool, admins: &[String], policy: &str) -> CeResult<Value> {
    let mut who = who.to_vec();
    who.sort();
    let mut entry = json!({"seq": seq, "op": op, "by": by, "by_device": by_device, "who": who, "ts": ts, "prev": hex(prev)});
    if op == "create" || op == "baseline" {
        let mut admins = admins.to_vec();
        admins.sort();
        entry["kind"] = json!(kind);
        entry["bridgeable"] = json!(bridgeable);
        entry["admins"] = json!(admins);
    }
    if POLICY_OPS.contains(&op) {
        entry["policy"] = json!(policy);
    }
    entry["sig"] = json!(device_key.sign(&member_signed_bytes(cid, &entry)?)?);
    Ok(entry)
}

/// A verified replay of a conversation's member log (contract section 7.2).
#[derive(Clone, Debug, PartialEq)]
pub struct LogState {
    pub cid: String,
    pub head: Head,
    pub members: BTreeSet<String>,
    pub admins: BTreeSet<String>,
    pub kind: String,
    // Test-only read: the CE-1 member log vectors check it.
    #[cfg_attr(not(test), allow(dead_code))]
    pub bridgeable: bool,
    pub started_with: String,
    pub created_ts: i64,
    pub confirmed_by: BTreeSet<String>,
    /// Revision 6: linked (mentions) apps.
    pub linked: BTreeSet<String>,
    /// Archive principal to the policy hash (hex) it was added under.
    pub archives: BTreeMap<String, String>,
    entries: Vec<Entry>,
    raw: Vec<Value>,
    hashes: Vec<[u8; 32]>,
}

fn is_subset(a: &BTreeSet<String>, b: &BTreeSet<String>) -> bool {
    a.is_subset(b)
}

impl LogState {
    pub fn new(cid: &str) -> CeResult<LogState> {
        if cid_kind(cid)? != "ch" {
            return Err(encoding_error("only channels and group chats have a member log"));
        }
        Ok(LogState::empty(cid))
    }

    fn empty(cid: &str) -> LogState {
        LogState {
            cid: cid.to_string(),
            head: ZERO_HEAD,
            members: BTreeSet::new(),
            admins: BTreeSet::new(),
            kind: String::new(),
            bridgeable: false,
            started_with: String::new(),
            created_ts: 0,
            confirmed_by: BTreeSet::new(),
            linked: BTreeSet::new(),
            archives: BTreeMap::new(),
            entries: Vec::new(),
            raw: Vec::new(),
            hashes: Vec::new(),
        }
    }

    /// An empty state of the same conversation (for replaying the verified entries).
    fn fresh(&self) -> LogState {
        LogState::empty(&self.cid)
    }

    pub fn last_ts(&self) -> i64 {
        self.entries.last().map_or(0, |e| e.ts)
    }

    pub fn hash_at(&self, seq: i64) -> CeResult<[u8; 32]> {
        if seq == 0 {
            return Ok(ZERO_HASH);
        }
        if seq < 1 || seq as usize > self.hashes.len() {
            return fail("head", "no such log entry here");
        }
        Ok(self.hashes[seq as usize - 1])
    }

    pub fn has_head(&self, head: &Head) -> bool {
        head.seq >= 0 && head.seq as usize <= self.hashes.len() && (head.seq == 0 || self.hashes[head.seq as usize - 1] == head.hash)
    }

    pub fn members_at(&self, seq: i64) -> BTreeSet<String> {
        let mut state = self.fresh();
        for e in self.entries.iter().take(seq.max(0) as usize) {
            if state.apply(e, None).is_err() {
                break;
            }
        }
        state.members
    }

    /// Revision 11 (API-1c 5.2): the times (entry `ts`, ms) `principal` was a member by this replay, as `(from, to)`
    /// with `to` 0 while still a member (`in_intervals`).
    pub fn member_intervals(&self, principal: &str) -> Vec<(i64, i64)> {
        let mut out: Vec<(i64, i64)> = Vec::new();
        let mut state = self.fresh();
        for e in &self.entries {
            let was = state.members.contains(principal);
            if state.apply(e, None).is_err() {
                break;
            }
            let now = state.members.contains(principal);
            if now && !was {
                out.push((e.ts, 0));
            } else if was && !now {
                if let Some(last) = out.last_mut() {
                    last.1 = e.ts;
                }
            }
        }
        out
    }

    pub fn ops_between(&self, after_seq: i64, upto_seq: i64) -> Vec<(String, Vec<String>)> {
        let (a, b) = (after_seq.max(0) as usize, (upto_seq.max(0) as usize).min(self.entries.len()));
        self.entries.get(a..b.max(a)).unwrap_or_default().iter().map(|e| (e.op.clone(), e.who.clone())).collect()
    }

    pub fn to_value(&self) -> Value {
        json!({"cid": self.cid, "entries": self.raw})
    }

    /// A log this device verified before (its local store): the rules again, no signature checks.
    pub fn from_value(cid: &str, data: &Value) -> CeResult<LogState> {
        let mut state = LogState::new(cid)?;
        for raw in data.get("entries").and_then(Value::as_array).into_iter().flatten() {
            let e = parse_entry(raw, true)?;
            let h = sha256(&entry_bytes(cid, &e));
            state.append(e, raw, h, None)?;
        }
        Ok(state)
    }

    fn append(&mut self, e: Entry, raw: &Value, h: [u8; 32], check: Option<&PolicyCheck>) -> CeResult<()> {
        if e.seq != self.head.seq + 1 || e.prev != self.head.hash {
            return Err(log_refused());
        }
        if e.ts < self.last_ts() {
            return fail("time", "log times went backwards");
        }
        self.apply(&e, check)?;
        let mut kept = raw.clone();
        if let Some(o) = kept.as_object_mut() {
            o.remove("rts");
        }
        self.head = Head { seq: e.seq, hash: h };
        self.entries.push(e);
        self.raw.push(kept);
        self.hashes.push(h);
        Ok(())
    }

    /// One entry's rules. `check` judges the org policies of `archive` and `unarchive` entries when first verified;
    /// None replays entries this device verified before.
    fn apply(&mut self, e: &Entry, check: Option<&PolicyCheck>) -> CeResult<()> {
        let mut members = self.members.clone();
        let mut admins = self.admins.clone();
        let mut linked = self.linked.clone();
        let mut archives = self.archives.clone();
        let who: BTreeSet<String> = e.who.iter().cloned().collect();
        fn kind_of(p: &str) -> &'static str {
            principal_kind(p).unwrap_or("person")
        }
        let services: BTreeSet<String> = who.iter().filter(|p| kind_of(p) != "person").cloned().collect();
        let op = e.op.as_str();
        let start = op == "create" || op == "baseline";
        let only_by = e.who.len() == 1 && e.who[0] == e.by;
        if (e.seq == 1) != start {
            return rules("only the first entry creates the log");
        }
        if kind_of(&e.by) != "person" && op != "leave" {
            return rules("a service signs only its own leave");
        }
        if matches!(op, "create" | "baseline" | "join" | "admin" | "unadmin") && !services.is_empty() {
            return rules("a service is only added, linked or archived");
        }
        if matches!(op, "add" | "link_app") && who.iter().any(|p| kind_of(p) == "archive") {
            return rules("an archive is added by an archive entry only");
        }
        if matches!(op, "link_app" | "unlink_app") && (who.is_empty() || services != who) {
            return rules("link_app and unlink_app name apps");
        }
        if POLICY_OPS.contains(&op) && (e.who.len() != 1 || kind_of(&e.who[0]) != "archive") {
            return rules("archive and unarchive name one archive");
        }
        let creator_admin = |admins: &BTreeSet<String>| admins.contains(&e.by);
        if start {
            if !who.contains(&e.by) {
                return rules("the signer must be a member");
            }
            if op == "baseline" && !e.admins.is_empty() {
                return rules("a baseline has no admins");
            }
            if !e.admins.iter().all(|a| who.contains(a)) {
                return rules("admins must be members");
            }
            self.kind = e.kind.clone();
            self.bridgeable = e.bridgeable;
            self.started_with = op.to_string();
            self.created_ts = e.ts;
            members = who.clone();
            admins = e.admins.iter().cloned().collect();
        } else if op == "join" {
            if self.kind != "public" || !only_by || members.contains(&e.by) {
                return rules("only a newcomer joins a public channel, by itself");
            }
            members.extend(who.iter().cloned());
        } else {
            if !members.contains(&e.by) {
                return rules("the signer is not a member");
            }
            let created = self.started_with == "create";
            match op {
                "confirm" => {
                    if !e.who.is_empty() {
                        return rules("a confirm names nobody");
                    }
                    self.confirmed_by.insert(e.by.clone());
                }
                "add" => {
                    if who.is_empty() || !who.is_disjoint(&members) {
                        return rules("add names newcomers");
                    }
                    if self.kind == "private" && created && !creator_admin(&admins) {
                        return rules("only an admin adds to a private channel");
                    }
                    members.extend(who.iter().cloned());
                    linked.retain(|p| !who.contains(p));
                }
                "leave" => {
                    if !only_by {
                        return rules("only the leaver leaves");
                    }
                    members.retain(|p| !who.contains(p));
                    admins.retain(|p| !who.contains(p));
                    archives.remove(&e.by);
                }
                "remove" => {
                    if who.is_empty() || !is_subset(&who, &members) {
                        return rules("remove names members");
                    }
                    if who.iter().any(|p| kind_of(p) == "archive") {
                        return rules("nobody removes an archive");
                    }
                    if !only_by && !(creator_admin(&admins) && created) && !who.iter().all(|p| kind_of(p) == "app") {
                        return rules("only an admin, or the person removed, removes");
                    }
                    members.retain(|p| !who.contains(p));
                    admins.retain(|p| !who.contains(p));
                }
                "link_app" => {
                    if !who.is_disjoint(&members) || !who.is_disjoint(&linked) {
                        return rules("link_app names apps that are not here yet");
                    }
                    if self.kind == "private" && created && !creator_admin(&admins) {
                        return rules("only an admin links an app in a private channel");
                    }
                    linked.extend(who.iter().cloned());
                }
                "unlink_app" => {
                    if !is_subset(&who, &linked) {
                        return rules("unlink_app names linked apps");
                    }
                    linked.retain(|p| !who.contains(p));
                }
                "archive" => {
                    let archive = &e.who[0];
                    if members.contains(archive) {
                        return rules("that archive is already here");
                    }
                    if let Some(check) = check {
                        check.archive(e, &members, self.head.seq + 1)?;
                    }
                    members.insert(archive.clone());
                    archives.insert(archive.clone(), hex(&e.policy));
                }
                "unarchive" => {
                    let archive = &e.who[0];
                    let Some(added_under) = archives.get(archive).cloned().filter(|_| members.contains(archive)) else { return rules("unarchive names an archive that is here") };
                    if let Some(check) = check {
                        check.unarchive(e, &members, &added_under)?;
                    }
                    members.remove(archive);
                    archives.remove(archive);
                }
                "admin" => {
                    if !created || !creator_admin(&admins) || who.is_empty() || !is_subset(&who, &members) || !who.is_disjoint(&admins) {
                        return rules("only an admin names a member admin");
                    }
                    admins.extend(who.iter().cloned());
                }
                _ => {
                    if !created || !creator_admin(&admins) || who.is_empty() || !is_subset(&who, &admins) {
                        return rules("only an admin removes an admin");
                    }
                    admins.retain(|p| !who.contains(p));
                }
            }
        }
        if (self.kind == "public" || self.kind == "private") && members.len() > CHANNEL_MAX {
            return fail("limit", "an encrypted channel holds at most 1000 members");
        }
        self.confirmed_by.retain(|p| members.contains(p));
        self.members = members;
        self.admins = admins;
        self.linked = linked;
        self.archives = archives;
        Ok(())
    }
}

/// `s` (ms) falls in one `LogState::member_intervals` interval.
pub fn in_intervals(intervals: &[(i64, i64)], s: i64) -> bool {
    intervals.iter().any(|&(a, b)| a <= s && (b == 0 || s < b))
}

/// The org-policy rules of `archive` and `unarchive` entries (PC-1 section 3, N13) while a log is verified: entries
/// at or below `lenient_upto` are replayed from an existing log (a new member), where an `archive` entry may name an
/// older policy whose archive principal and device equal the newest pinned one's.
struct PolicyCheck<'a> {
    view: Option<&'a PolicyView>,
    lenient_upto: i64,
}

impl PolicyCheck<'_> {
    fn view(&self) -> CeResult<&PolicyView> {
        self.view.ok_or_else(|| CeError::new("policy_unknown", "this log names org policies"))
    }

    fn archive(&self, e: &Entry, members: &BTreeSet<String>, seq: i64) -> CeResult<()> {
        let view = self.view()?;
        let h = hex(&e.policy);
        let policy = view.require(&h)?;
        if archive_of(Some(policy)).map_or(true, |(p, _)| p != e.who[0]) {
            return rules("the policy does not name that archive");
        }
        if !covers(policy, &e.by) {
            return rules("the signer is not covered by that policy");
        }
        if !members.iter().any(|p| covers(policy, p)) {
            return rules("no member is covered by that policy");
        }
        let (issued, expires) = (int_or0(policy.get("issued")), int_or0(policy.get("expires")));
        if !(issued * 1000 - SKEW_MS <= e.ts && e.ts < expires * 1000) {
            return rules("the policy was not valid when the entry was signed");
        }
        let org = text(policy.get("org"));
        let pin_hash = view.newest.get(&org).cloned().unwrap_or_default();
        let pin = if pin_hash.is_empty() { None } else { view.by_hash.get(&pin_hash) };
        let Some(pin) = pin else { return Ok(()) };
        let (seq_policy, seq_pin) = (int_or0(policy.get("seq")), int_or0(pin.get("seq")));
        if h == pin_hash || seq_policy > seq_pin {
            return Ok(());
        }
        if seq <= self.lenient_upto && seq_policy < seq_pin && archive_of(Some(policy)) == archive_of(Some(pin)) {
            return Ok(());
        }
        rules("the archive entry does not name the newest policy")
    }

    fn unarchive(&self, e: &Entry, members: &BTreeSet<String>, added_under: &str) -> CeResult<()> {
        let view = self.view()?;
        let h = hex(&e.policy);
        let added = view.require(added_under)?;
        if h == added_under {
            if members.iter().any(|p| covers(added, p)) {
                return rules("a covered member is still here");
            }
            return Ok(());
        }
        let policy = view.require(&h)?;
        if policy.get("org") != added.get("org") || int_or0(policy.get("seq")) <= int_or0(added.get("seq")) || archive_of(Some(policy)) == archive_of(Some(added)) {
            return rules("unarchive names neither the policy it was added under nor a newer one without that archive");
        }
        Ok(())
    }
}

/// `state` plus `entries` (entries at or below its head must be the same entries); `log_refused` when they fork
/// from it. `policies` judges `archive` and `unarchive` entries (`policy_unknown` without it or without a named
/// policy); entries up to `lenient_upto` are a replay (see `PolicyCheck`). An entry's `rts` (the relay's receive
/// time) is its observed time, else `now_ms`.
#[allow(clippy::too_many_arguments)]
pub fn extend_log(state: &LogState, entries: &[Value], certs_for: CertSource, verifier: &Verifier, now_ms: i64, policies: Option<&PolicyView>, lenient_upto: i64) -> CeResult<LogState> {
    let check = PolicyCheck { view: policies, lenient_upto };
    let mut out = state.clone();
    for raw in entries {
        let e = parse_entry(raw, true)?;
        let signed = entry_bytes(&out.cid, &e);
        let h = sha256(&signed);
        if e.seq <= out.head.seq {
            if out.hash_at(e.seq)? != h {
                return Err(log_refused());
            }
            continue;
        }
        if e.seq != out.head.seq + 1 {
            return rules("the log has a gap");
        }
        if e.prev != out.head.hash {
            return Err(log_refused());
        }
        let observed = raw.get("rts").and_then(int_of).unwrap_or(now_ms);
        if e.ts < out.last_ts() {
            return fail("time", "log times went backwards");
        }
        verifier.signer(&certs_for(&e.by, &e.by_device), &e.by, &e.by_device, None, e.ts, observed, &signed, &Value::String(e.sig.clone()))?;
        out.append(e, raw, h, Some(&check))?;
    }
    Ok(out)
}

/// The whole log from seq 1; `log_refused` when shorter than, or not extending, the `pinned` head. Without a pin (a
/// log this device meets for the first time) every entry is a replay for the archive rule; with one, entries up to
/// it are.
#[allow(clippy::too_many_arguments)]
pub fn replay_log(cid: &str, entries: &[Value], certs_for: CertSource, verifier: &Verifier, now_ms: i64, pinned: Option<Head>, policies: Option<&PolicyView>) -> CeResult<LogState> {
    if let Some(pin) = pinned.filter(|p| p.seq >= 1) {
        if (entries.len() as i64) < pin.seq {
            return Err(log_refused());
        }
        let same = parse_entry(&entries[pin.seq as usize - 1], true).is_ok_and(|at| at.seq == pin.seq && sha256(&entry_bytes(cid, &at)) == pin.hash);
        if !same {
            return Err(log_refused());
        }
    }
    let lenient = pinned.map_or(MAX_INT, |p| p.seq);
    let state = extend_log(&LogState::new(cid)?, entries, certs_for, verifier, now_ms, policies, lenient)?;
    if pinned.is_some_and(|p| !state.has_head(&p)) {
        return Err(log_refused());
    }
    Ok(state)
}

// -- revision 6: org policies as this device holds them ----------------------------------------------------------

/// Hex SHA-256 of an org policy's signed bytes (`meet_org_policy.policy_hash`).
// Test-only: the CE-1 vectors and the session test pin use it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn org_policy_hash(policy: &Map<String, Value>) -> String {
    crate::codec::sha256_hex(&crate::meet_org_policy::signed_bytes(policy))
}

/// Org policies this device verified (`meet_org_policy`) as plain objects: `by_hash` every verified policy by
/// `policy_hash` (hex), `newest` the pinned hash per org, `own_org` the org covering this device's person (""
/// for an app). Nothing here checks a signature. A policy past `expires` counts as missing for other orgs; the own
/// org keeps its last pinned one.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PolicyView {
    pub by_hash: BTreeMap<String, Value>,
    pub newest: BTreeMap<String, String>,
    pub now_s: i64,
    pub own_org: String,
}

impl PolicyView {
    pub fn get(&self, h: &str) -> Option<&Value> {
        self.by_hash.get(h)
    }

    /// The verified policy `h` names; `policy_unknown` when not held (the caller fetches it, verifies it and tries
    /// again).
    pub fn require(&self, h: &str) -> CeResult<&Value> {
        check_policy_hash(h)?;
        self.by_hash.get(h).ok_or_else(|| CeError::new("policy_unknown", "a named org policy is not held here"))
    }

    pub fn pinned(&self, org: &str) -> Option<&Value> {
        self.newest.get(org).filter(|h| !h.is_empty()).and_then(|h| self.by_hash.get(h))
    }

    pub fn expired(&self, policy: &Value) -> bool {
        int_or0(policy.get("expires")) <= self.now_s
    }

    pub fn in_force(&self, org: &str) -> Option<&Value> {
        self.pinned(org).filter(|p| !(self.expired(p) && org != self.own_org))
    }

    pub fn in_force_hash(&self, org: &str) -> String {
        if self.in_force(org).is_some() { self.newest.get(org).cloned().unwrap_or_default() } else { String::new() }
    }

    pub fn label(&self, org: &str) -> String {
        match self.pinned(org) {
            Some(p) => {
                let label = text(p.get("label"));
                if label.is_empty() { org.to_string() } else { label }
            }
            None => org.to_string(),
        }
    }

    fn lists_domain(policy: &Value, domain: &str) -> bool {
        policy.get("domains").and_then(Value::as_array).is_some_and(|d| d.iter().any(|x| x.as_str() == Some(domain)))
    }

    /// The org whose in-force policy covers a person ("" when none; never a service).
    pub fn covering(&self, principal: &str) -> String {
        if principal_kind(principal).ok() != Some("person") {
            return String::new();
        }
        let domain = principal_domain(principal).unwrap_or_default();
        self.newest.keys().find(|org| self.in_force(org).is_some_and(|p| PolicyView::lists_domain(p, &domain))).cloned().unwrap_or_default()
    }

    /// The org a service principal `<name>@apps.<d>` belongs to by its pinned policy's domains ("" when none).
    pub fn service_org(&self, principal: &str) -> String {
        let domain = principal_domain(principal).unwrap_or_default();
        self.newest.keys().find(|org| self.pinned(org).is_some_and(|p| PolicyView::lists_domain(p, &domain))).cloned().unwrap_or_default()
    }
}

/// A person whose domain the policy lists (an `apps.` principal never is covered).
pub fn covers(policy: &Value, principal: &str) -> bool {
    principal_kind(principal).ok() == Some("person") && principal_domain(principal).is_ok_and(|d| PolicyView::lists_domain(policy, &d))
}

/// `(principal, device)` of a policy's archive, None when it has none.
pub fn archive_of(policy: Option<&Value>) -> Option<Pd> {
    let got = policy?.get("archive")?;
    got.is_object().then(|| (text(got.get("principal")), text(got.get("device"))))
}

fn app_entry<'a>(policy: Option<&'a Value>, principal: &str) -> Option<&'a Value> {
    policy?.get("apps")?.as_array()?.iter().find(|a| a.get("principal").and_then(Value::as_str) == Some(principal))
}

/// What people see of a service in a conversation (names only from the signed policy): `kind`, `principal`,
/// `device`, `org`, `org_label`, `name`, `host`, `scope`, `listed` (its org's in-force policy names it with a scope
/// that fits), `linked`, `since`, and for an app `commands` and `type`.
pub fn service_reader(principal: &str, view: &PolicyView, linked: bool) -> CeResult<Value> {
    let kind = principal_kind(principal)?;
    let org = view.service_org(principal);
    let policy = if org.is_empty() { None } else { view.in_force(&org) };
    let org_label = if org.is_empty() { principal_domain(principal)? } else { view.label(&org) };
    let name = if kind == "archive" { "Archive".to_string() } else { principal.split('@').next().unwrap_or("").to_string() };
    let mut out = json!({"kind": kind, "principal": principal, "device": "", "org": org, "org_label": org_label, "name": name,
                         "host": "", "scope": "", "listed": false, "linked": linked, "since": 0});
    if kind == "archive" {
        if let Some((p, d)) = archive_of(policy) {
            if p == principal {
                let arch = policy.and_then(|p| p.get("archive"));
                out["device"] = json!(d);
                out["host"] = json!(text(arch.and_then(|a| a.get("host"))));
                out["scope"] = json!("all");
                out["since"] = json!(int_or0(arch.and_then(|a| a.get("since"))));
                out["listed"] = json!(!linked);
            }
        }
        return Ok(out);
    }
    if let Some(app) = app_entry(policy, principal) {
        let typ = text(app.get("type"));
        let scope = if matches!(typ.as_str(), "webhook" | "workflows" | API_APP_TYPE) { "all".to_string() } else { text(app.get("scope")) };
        let app_name = text(app.get("name"));
        if !app_name.is_empty() {
            out["name"] = json!(app_name);
        }
        out["device"] = json!(text(app.get("device")));
        out["host"] = json!(text(app.get("host")));
        out["listed"] = json!((scope == "mentions") == linked);
        out["scope"] = json!(scope);
        out["commands"] = app.get("commands").filter(|c| c.is_array()).cloned().unwrap_or_else(|| json!([]));
        out["type"] = json!(typ);
    }
    Ok(out)
}

/// A service member's device gets keys only when its policy names that device and its certificate's kind and org
/// match the policy's entry (PC-1 section 1).
pub fn service_device_ok(reader: &Value, device: &str, cert: &CeCert) -> bool {
    if reader.get("listed") != Some(&Value::Bool(true)) || reader.get("linked") == Some(&Value::Bool(true)) || reader.get("device").and_then(Value::as_str) != Some(device) {
        return false;
    }
    match cert_kind(cert) {
        Ok((kind, org)) => reader.get("kind").and_then(Value::as_str) == Some(kind) && reader.get("org").and_then(Value::as_str) == Some(org.as_str()),
        Err(_) => false,
    }
}

/// `pols` of a DM wrap: the in-force policies covering either principal, sorted.
pub fn dm_policy_hashes(principals: &[String], view: &PolicyView) -> Vec<String> {
    let mut out = BTreeSet::new();
    for p in principals {
        let org = view.covering(p);
        let h = if org.is_empty() { String::new() } else { view.in_force_hash(&org) };
        if !h.is_empty() {
            out.insert(h);
        }
    }
    out.into_iter().collect()
}

/// The archive devices the named policies add to a DM's device set (section 7.1). A named policy that covers
/// neither principal, or that is older than this device's pin for its org and has another archive, fails
/// `members`; an unknown one `policy_unknown`.
pub fn dm_archives(principals: &[String], pols: &[String], view: &PolicyView) -> CeResult<Vec<Pd>> {
    let mut out = Vec::new();
    for h in pols {
        let policy = view.require(h)?;
        if !principals.iter().any(|p| covers(policy, p)) {
            return fail("members", "a named policy covers neither person");
        }
        if let Some(pin) = view.pinned(&text(policy.get("org"))) {
            if int_or0(policy.get("seq")) < int_or0(pin.get("seq")) && archive_of(Some(policy)) != archive_of(Some(pin)) {
                return fail("members", "a named policy is older and has another archive");
            }
        }
        if let Some(a) = archive_of(Some(policy)) {
            out.push(a);
        }
    }
    Ok(out)
}

// -- section 5 and 10: the key store -----------------------------------------------------------------------------

/// (cid, sender principal, sender device, epoch).
type Slot = (String, String, String, i64);
/// (cid, sender principal, sender device, plus `:doc` for the document counters).
type Sender = (String, String, String);

#[derive(Clone)]
struct DckItem {
    key: DckKey,
    bundle: VerifiedBundle,
    replaced: Option<i64>,
}

/// Received and own epoch keys, message bookkeeping for retention, and this device's chat keys (with the bundles
/// they belong to). In memory; `to_value`/`from_value` for the sealed store.
#[derive(Clone, Default)]
pub struct KeyStore {
    keys: BTreeMap<Slot, (Vec<u8>, i64)>,
    msgs: BTreeMap<Sender, BTreeMap<(i64, i64), (String, i64)>>,
    dcks: Vec<DckItem>,
}

impl fmt::Debug for KeyStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "KeyStore({} keys, {} senders, {} chat keys, <redacted>)", self.keys.len(), self.msgs.len(), self.dcks.len())
    }
}

fn sender_of(cid: &str, from_p: &str, from_d: &str, docs: bool) -> Sender {
    (cid.to_string(), from_p.to_string(), if docs { format!("{from_d}{DOC_STREAM}") } else { from_d.to_string() })
}

impl KeyStore {
    pub fn new() -> KeyStore {
        KeyStore::default()
    }

    /// True when new; `repeated_key` when the slot holds another key.
    pub fn put_key(&mut self, cid: &str, from_p: &str, from_d: &str, epoch: i64, key: &[u8], at_ms: i64) -> CeResult<bool> {
        cid_kind(cid)?;
        check_principal(from_p)?;
        check_device(from_d)?;
        check_n(epoch, "epoch", 1)?;
        if key.len() != 32 {
            return Err(encoding_error("a key is 32 bytes"));
        }
        let slot = (cid.to_string(), from_p.to_string(), from_d.to_string(), epoch);
        if let Some(held) = self.keys.get(&slot) {
            if held.0 == key {
                return Ok(false);
            }
            return Err(repeated_key());
        }
        self.keys.insert(slot, (key.to_vec(), at_ms));
        Ok(true)
    }

    pub fn get_key(&self, cid: &str, from_p: &str, from_d: &str, epoch: i64) -> Option<Vec<u8>> {
        self.keys.get(&(cid.to_string(), from_p.to_string(), from_d.to_string(), epoch)).map(|k| k.0.clone())
    }

    /// Notes a received or sent message for gaps and retention. Revision 6: `doc` and `docsnap` are noted in their own
    /// counter series; `docaware` is never stored or noted.
    #[allow(clippy::too_many_arguments)]
    pub fn note_message(&mut self, cid: &str, from_p: &str, from_d: &str, epoch: i64, counter: i64, mid: &str, s: i64, kind: &str) -> CeResult<()> {
        if kind == "docaware" {
            return Ok(());
        }
        let sender = sender_of(cid, from_p, from_d, DOC_KINDS.contains(&kind));
        let slot = (check_n(epoch, "epoch", 1)?, check_n(counter, "counter", 1)?);
        let msgs = self.msgs.entry(sender).or_default();
        if let Some(held) = msgs.get(&slot) {
            if held.0 != mid {
                return rules("a counter was used twice");
            }
            return Ok(());
        }
        if msgs.range(..slot).next_back().is_some_and(|(_, held)| held.1 > s) || msgs.range(slot..).next().is_some_and(|(_, held)| held.1 < s) {
            return fail("time", "message time went backwards");
        }
        msgs.insert(slot, (mid.to_string(), s));
        Ok(())
    }

    /// Every received and own epoch key of `cid` and its message bookkeeping (r5 2.7: the app was removed).
    pub fn forget(&mut self, cid: &str) {
        self.keys.retain(|k, _| k.0 != cid);
        self.msgs.retain(|k, _| k.0 != cid);
    }

    /// Adds this device's new chat key with its verified bundle; the previous current one counts as replaced from the
    /// new bundle's `created`.
    pub fn add_dck(&mut self, key: DckKey, bundle: VerifiedBundle) -> CeResult<()> {
        if key.raw() != bundle.dck_raw.as_slice() {
            return Err(encoding_error("the key does not match the bundle"));
        }
        for item in &mut self.dcks {
            if item.replaced.is_none() {
                item.replaced = Some(bundle.created);
            }
        }
        self.dcks.push(DckItem { key, bundle, replaced: None });
        Ok(())
    }

    /// Every chat key of this device with its bundle (what `open_wrap` and `open_share` take).
    pub fn my_bundles(&self) -> Vec<(VerifiedBundle, DckKey)> {
        self.dcks.iter().map(|i| (i.bundle.clone(), i.key.clone())).collect()
    }

    pub fn to_value(&self) -> Value {
        let keys: Vec<Value> = self.keys.iter().map(|((c, p, d, e), (k, at))| json!([c, p, d, e, crate::ce_device::b64(k), at])).collect();
        let messages: Vec<Value> = self.msgs.iter().flat_map(|((c, p, d), m)| m.iter().map(move |((e, n), (mid, s))| json!([c, p, d, e, n, mid, s]))).collect();
        let dcks: Vec<Value> = self.dcks.iter().map(|i| json!({"key": i.key.private_b64(), "bundle": i.bundle.to_value(), "replaced": i.replaced})).collect();
        json!({"keys": keys, "messages": messages, "dcks": dcks})
    }

    pub fn from_value(data: &Value) -> CeResult<KeyStore> {
        let bad = || encoding_error("unreadable key store");
        let mut out = KeyStore::new();
        for item in data.get("keys").and_then(Value::as_array).into_iter().flatten() {
            let Some([c, p, d, e, k, at]) = item.as_array().map(Vec::as_slice) else { return Err(bad()) };
            let slot = (text(Some(c)), text(Some(p)), text(Some(d)), int_of(e).ok_or_else(bad)?);
            out.keys.insert(slot, (unb64(k, "key", Some(32), 0)?, int_of(at).ok_or_else(bad)?));
        }
        for item in data.get("messages").and_then(Value::as_array).into_iter().flatten() {
            let Some([c, p, d, e, n, mid, s]) = item.as_array().map(Vec::as_slice) else { return Err(bad()) };
            let sender = (text(Some(c)), text(Some(p)), text(Some(d)));
            let slot = (int_of(e).ok_or_else(bad)?, int_of(n).ok_or_else(bad)?);
            out.msgs.entry(sender).or_default().insert(slot, (text(Some(mid)), int_of(s).ok_or_else(bad)?));
        }
        for item in data.get("dcks").and_then(Value::as_array).into_iter().flatten() {
            let key = DckKey::from_b64(item.get("key").and_then(Value::as_str).ok_or_else(bad)?)?;
            let bundle = VerifiedBundle::from_value(item.get("bundle").unwrap_or(&Value::Null))?;
            out.dcks.push(DckItem { key, bundle, replaced: item.get("replaced").and_then(int_of) });
        }
        Ok(out)
    }
}

// -- section 5: my sender keys -----------------------------------------------------------------------------------

/// What to send next in a conversation: the current epoch, whether it is new, and the devices still to wrap it to.
#[derive(Clone, PartialEq, Eq)]
pub struct SendPlan {
    pub cid: String,
    pub epoch: i64,
    pub key: Vec<u8>,
    pub rotated: bool,
    pub head: Head,
    pub members: [u8; 32],
    pub wrap_to: Vec<Pd>,
}

impl fmt::Debug for SendPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SendPlan").field("cid", &self.cid).field("epoch", &self.epoch).field("rotated", &self.rotated).field("head", &self.head).field("wrap_to", &self.wrap_to).finish_non_exhaustive()
    }
}

/// The header numbers and key of the next envelope.
#[derive(Clone, PartialEq, Eq)]
pub struct NextMessage {
    pub epoch: i64,
    pub counter: i64,
    pub pe: i64,
    pub pc: i64,
    pub key: Vec<u8>,
    pub s: i64,
}

impl fmt::Debug for NextMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NextMessage").field("epoch", &self.epoch).field("counter", &self.counter).field("pe", &self.pe).field("pc", &self.pc).field("s", &self.s).finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct Epoch {
    epoch: i64,
    key: Vec<u8>,
    counter: i64,
    started: i64,
    devices: BTreeSet<Pd>,
    head: Head,
    wrapped: BTreeSet<Pd>,
    /// Revision 6: doc and docsnap count here, not in `counter`.
    doc_counter: i64,
}

/// This device's current epoch per conversation (contract section 5).
#[derive(Clone)]
pub struct SenderKeys {
    me: Pd,
    cur: BTreeMap<String, Epoch>,
    /// Highest epoch ever used (kept on forget).
    high: BTreeMap<String, i64>,
    /// Last epoch that sent, its last counter.
    prev: BTreeMap<String, (i64, i64)>,
    last_s: BTreeMap<String, i64>,
}

impl fmt::Debug for SenderKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SenderKeys({:?}, {} conversations, <redacted>)", self.me, self.cur.len())
    }
}

fn pds_json(set: &BTreeSet<Pd>) -> Value {
    let mut list: Vec<Pd> = set.iter().cloned().collect();
    list.sort();
    json!(list.into_iter().map(|(p, d)| json!([p, d])).collect::<Vec<_>>())
}

impl SenderKeys {
    pub fn new(principal: &str, device: &str) -> CeResult<SenderKeys> {
        check_principal(principal)?;
        check_device(device)?;
        Ok(SenderKeys { me: (principal.to_string(), device.to_string()), cur: BTreeMap::new(), high: BTreeMap::new(), prev: BTreeMap::new(), last_s: BTreeMap::new() })
    }

    fn devices(&self, devices: &[Pd]) -> CeResult<BTreeSet<Pd>> {
        for (p, d) in devices {
            check_principal(p)?;
            check_device(d)?;
        }
        let mut out: BTreeSet<Pd> = devices.iter().cloned().collect();
        out.insert(self.me.clone());
        Ok(out)
    }

    fn plan_of(&self, cid: &str, cur: &Epoch, rotated: bool) -> CeResult<SendPlan> {
        let mut wrap_to: Vec<Pd> = cur.devices.iter().filter(|pd| **pd != self.me && !cur.wrapped.contains(*pd)).cloned().collect();
        sort_pds(&mut wrap_to);
        let devices: Vec<Pd> = cur.devices.iter().cloned().collect();
        Ok(SendPlan { cid: cid.to_string(), epoch: cur.epoch, key: cur.key.clone(), rotated, head: cur.head, members: set_hash(&devices)?, wrap_to })
    }

    /// The epoch to send with in `cid` to the verified `devices` (this device added), rotating when the contract
    /// asks (time, count, a role change or a device set that is not only public-channel joiners); a channel needs its
    /// verified member `log`. A new epoch key goes into `store`.
    pub fn plan(&mut self, store: &mut KeyStore, cid: &str, devices: &[Pd], now_s: i64, log: Option<&LogState>) -> CeResult<SendPlan> {
        let kind = cid_kind(cid)?;
        let devs = self.devices(devices)?;
        let head = if kind == "ch" {
            match log.filter(|l| l.head.seq >= 1) {
                Some(l) => l.head,
                None => return fail("head", "a channel needs its verified member log"),
            }
        } else {
            ZERO_HEAD
        };
        let rotate = match self.cur.get(cid) {
            None => true,
            Some(cur) => must_rotate(cur, &devs, &head, now_s, log),
        };
        if rotate {
            if let Some(cur) = self.cur.get(cid).filter(|c| c.counter > 0) {
                self.prev.insert(cid.to_string(), (cur.epoch, cur.counter));
            }
            let epoch = check_n(self.high.get(cid).copied().unwrap_or(0) + 1, "epoch", 1)?;
            let key = random_bytes(32);
            store.put_key(cid, &self.me.0, &self.me.1, epoch, &key, now_s * 1000)?;
            let cur = Epoch { epoch, key, counter: 0, started: now_s, devices: devs, head, wrapped: BTreeSet::new(), doc_counter: 0 };
            let plan = self.plan_of(cid, &cur, true)?;
            self.cur.insert(cid.to_string(), cur);
            self.high.insert(cid.to_string(), epoch);
            return Ok(plan);
        }
        let mut cur = self.cur.remove(cid).ok_or_else(|| CeError::new("rules", "no current epoch"))?;
        cur.devices = devs;
        cur.head = head;
        let plan = self.plan_of(cid, &cur, false);
        self.cur.insert(cid.to_string(), cur);
        plan
    }

    /// The current epoch of `cid` was wrapped to `devices`.
    pub fn mark_wrapped(&mut self, cid: &str, epoch: i64, devices: &[Pd]) -> CeResult<()> {
        for (p, d) in devices {
            check_principal(p)?;
            check_device(d)?;
        }
        if let Some(cur) = self.cur.get_mut(cid).filter(|c| c.epoch == epoch) {
            cur.wrapped.extend(devices.iter().cloned());
        }
        Ok(())
    }

    /// The counter of the next envelope of `kind`. Revision 6: `doc` and `docsnap` count in their own series per
    /// epoch; `docaware` is never stored, so it takes the current document counter (at least 1) without counting.
    pub fn next_counter(&mut self, cid: &str, now_ms: i64, kind: &str) -> CeResult<NextMessage> {
        let last = self.last_s.get(cid).copied().unwrap_or(0);
        let Some(cur) = self.cur.get_mut(cid) else { return rules("plan the epoch before sending") };
        let s = now_ms.max(last);
        if DOC_KINDS.contains(&kind) {
            if kind == "docaware" {
                return Ok(NextMessage { epoch: cur.epoch, counter: cur.doc_counter.max(1), pe: 0, pc: 0, key: cur.key.clone(), s });
            }
            if cur.doc_counter >= DOC_ROTATE {
                return rules("this epoch is used up");
            }
            cur.doc_counter += 1;
            let out = NextMessage { epoch: cur.epoch, counter: cur.doc_counter, pe: 0, pc: 0, key: cur.key.clone(), s };
            self.last_s.insert(cid.to_string(), s);
            return Ok(out);
        }
        if cur.counter >= ROTATE_MESSAGES {
            return rules("this epoch is used up");
        }
        cur.counter += 1;
        let (pe, pc) = if cur.counter == 1 { self.prev.get(cid).copied().unwrap_or((0, 0)) } else { (0, 0) };
        let out = NextMessage { epoch: cur.epoch, counter: cur.counter, pe, pc, key: cur.key.clone(), s };
        self.last_s.insert(cid.to_string(), s);
        Ok(out)
    }

    pub fn forget(&mut self, cid: &str) {
        self.cur.remove(cid);
        self.prev.remove(cid);
    }

    pub fn to_value(&self) -> Value {
        let mut cur = Map::new();
        for (cid, c) in &self.cur {
            cur.insert(
                cid.clone(),
                json!({"epoch": c.epoch, "key": crate::ce_device::b64(&c.key), "counter": c.counter, "started": c.started,
                       "devices": pds_json(&c.devices), "head": [c.head.seq, c.head.hash_hex()], "wrapped": pds_json(&c.wrapped),
                       "doc_counter": c.doc_counter}),
            );
        }
        let prev: Map<String, Value> = self.prev.iter().map(|(k, (e, c))| (k.clone(), json!([e, c]))).collect();
        json!({"current": cur, "high": self.high, "prev": prev, "last_s": self.last_s})
    }

    pub fn from_value(data: &Value, principal: &str, device: &str) -> CeResult<SenderKeys> {
        let bad = || encoding_error("unreadable sender keys");
        let mut out = SenderKeys::new(principal, device)?;
        for (cid, c) in data.get("current").and_then(Value::as_object).into_iter().flatten() {
            let num = |k: &str| c.get(k).and_then(int_of).ok_or_else(bad);
            let head = c.get("head").and_then(Value::as_array).ok_or_else(bad)?;
            let (seq, hash) = (head.first().and_then(int_of).ok_or_else(bad)?, unhex(head.get(1).unwrap_or(&Value::Null), "head", 32)?);
            let pds = |k: &str| -> CeResult<BTreeSet<Pd>> { Ok(crate::ce_device::pds_value(c.get(k).unwrap_or(&Value::Null))?.into_iter().collect()) };
            out.cur.insert(
                cid.clone(),
                Epoch {
                    epoch: num("epoch")?,
                    key: unb64(c.get("key").unwrap_or(&Value::Null), "key", Some(32), 0)?,
                    counter: num("counter")?,
                    started: num("started")?,
                    devices: pds("devices")?,
                    head: Head { seq, hash: hash.try_into().map_err(|_| bad())? },
                    wrapped: pds("wrapped")?,
                    doc_counter: c.get("doc_counter").and_then(int_of).unwrap_or(0),
                },
            );
        }
        for (k, v) in data.get("high").and_then(Value::as_object).into_iter().flatten() {
            out.high.insert(k.clone(), int_of(v).ok_or_else(bad)?);
        }
        for (k, v) in data.get("prev").and_then(Value::as_object).into_iter().flatten() {
            let Some([e, c]) = v.as_array().map(Vec::as_slice) else { return Err(bad()) };
            out.prev.insert(k.clone(), (int_of(e).ok_or_else(bad)?, int_of(c).ok_or_else(bad)?));
        }
        for (k, v) in data.get("last_s").and_then(Value::as_object).into_iter().flatten() {
            out.last_s.insert(k.clone(), int_of(v).ok_or_else(bad)?);
        }
        Ok(out)
    }
}

fn must_rotate(cur: &Epoch, devs: &BTreeSet<Pd>, head: &Head, now_s: i64, log: Option<&LogState>) -> bool {
    if now_s - cur.started >= ROTATE_S || cur.counter >= ROTATE_MESSAGES || cur.doc_counter >= DOC_ROTATE {
        return true;
    }
    let mut ops: Vec<(String, Vec<String>)> = Vec::new();
    if *head != cur.head {
        let Some(l) = log.filter(|l| l.has_head(&cur.head) && head.seq >= cur.head.seq) else { return true };
        ops = l.ops_between(cur.head.seq, head.seq);
        if ops.iter().any(|(op, _)| ROLE_OPS.contains(&op.as_str())) {
            return true;
        }
    }
    if *devs == cur.devices {
        return false;
    }
    let superset = devs.is_superset(&cur.devices) && devs.len() > cur.devices.len();
    if !superset || !log.is_some_and(|l| l.kind == "public") {
        return true;
    }
    let joined: BTreeSet<&String> = ops.iter().filter(|(op, _)| op == "join").flat_map(|(_, who)| who.iter()).collect();
    if joined.is_empty() || ops.iter().any(|(op, _)| op != "join" && op != "confirm") {
        return true;
    }
    if devs.difference(&cur.devices).any(|(p, _)| !joined.contains(p)) {
        return true;
    }
    now_s - cur.started >= JOIN_EPOCH_MAX_S
}

#[cfg(test)]
mod tests {
    use super::*;

    const CID: &str = "ch:general";
    const A: &str = "a1a1a1a1a1a1a1a1";

    /// Counters held of one sender's epoch: messages, or (`docs`) document updates.
    fn counters(store: &KeyStore, from_p: &str, epoch: i64, docs: bool) -> Vec<i64> {
        store.msgs.get(&sender_of(CID, from_p, A, docs)).into_iter().flat_map(|m| m.keys()).filter(|(e, _)| *e == epoch).map(|(_, c)| *c).collect()
    }

    #[test]
    fn note_message_orders_by_counter_and_time() {
        let mut store = KeyStore::new();
        store.note_message(CID, "ann@x", A, 1, 1, "m1", 100, "post").unwrap();
        store.note_message(CID, "ann@x", A, 1, 3, "m3", 300, "post").unwrap();
        store.note_message(CID, "ann@x", A, 1, 3, "m3", 300, "post").unwrap();
        assert_eq!(store.note_message(CID, "ann@x", A, 1, 3, "mx", 300, "post").unwrap_err().code, "rules");
        assert_eq!(store.note_message(CID, "ann@x", A, 1, 2, "m2", 400, "post").unwrap_err().code, "time");
        store.note_message(CID, "ann@x", A, 1, 1, "d1", 50, "doc").unwrap();
        store.note_message(CID, "ann@x", A, 1, 9, "aw", 0, "docaware").unwrap();
        assert_eq!(counters(&store, "ann@x", 1, false), vec![1, 3]);
        assert_eq!(counters(&store, "ann@x", 1, true), vec![1]);
    }

    #[test]
    fn put_key_refuses_another_key_and_round_trips() {
        let mut store = KeyStore::new();
        store.put_key(CID, "ann@x", A, 1, &[1; 32], 10).unwrap();
        store.put_key(CID, "ann@x", A, 2, &[2; 32], 10).unwrap();
        assert!(!store.put_key(CID, "ann@x", A, 1, &[1; 32], 10).unwrap());
        assert_eq!(store.put_key(CID, "ann@x", A, 1, &[9; 32], 10).unwrap_err().code, "repeated_key");
        store.note_message(CID, "ann@x", A, 1, 1, "old", 100, "post").unwrap();
        store.note_message(CID, "ann@x", A, 2, 1, "doc", 50, "doc").unwrap();
        assert_eq!(store.get_key(CID, "ann@x", A, 1), Some(vec![1; 32]));
        assert_eq!(store.get_key(CID, "ann@x", A, 3), None);
        assert_eq!(KeyStore::from_value(&store.to_value()).unwrap().to_value(), store.to_value());
    }

    #[test]
    fn intervals() {
        let iv = [(10, 20), (30, 0)];
        assert!(in_intervals(&iv, 10) && !in_intervals(&iv, 20) && !in_intervals(&iv, 25) && in_intervals(&iv, 99));
        assert!(!in_intervals(&[], 1));
    }

    #[test]
    fn policies_cover_people_not_services() {
        let policy = json!({"org": "acme", "seq": 1, "domains": ["acme.test"], "expires": 100,
                            "archive": {"principal": "archive@apps.acme.test", "device": "7a7a7a7a7a7a7a7a"},
                            "apps": [{"principal": "api@apps.acme.test", "type": "api", "device": "6a6a6a6a6a6a6a6a"}]});
        assert!(covers(&policy, "ann@acme.test") && !covers(&policy, "api@apps.acme.test") && !covers(&policy, "gus@beta.test"));
        assert_eq!(archive_of(Some(&policy)), Some(("archive@apps.acme.test".to_string(), "7a7a7a7a7a7a7a7a".to_string())));
        let mut view = PolicyView { now_s: 50, ..PolicyView::default() };
        view.by_hash.insert("ab".repeat(32), policy);
        view.newest.insert("acme".to_string(), "ab".repeat(32));
        assert_eq!(view.covering("ann@acme.test"), "acme");
        assert_eq!(view.service_org("api@apps.acme.test"), "acme");
        assert_eq!(crate::ce_device::api_app_principals(&view), vec!["api@apps.acme.test".to_string()]);
        assert_eq!(dm_policy_hashes(&["ann@acme.test".to_string(), "gus@beta.test".to_string()], &view), vec!["ab".repeat(32)]);
        let reader = service_reader("api@apps.acme.test", &view, false).unwrap();
        assert_eq!((reader["org_label"].as_str(), reader["type"].as_str(), reader["listed"].as_bool()), (Some("acme"), Some("api"), Some(true)));
        view.now_s = 100;
        assert_eq!(view.covering("ann@acme.test"), "");
    }
}
