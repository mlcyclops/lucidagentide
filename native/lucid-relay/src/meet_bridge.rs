// Phase C (ADR-0540): bridges (contract BR-1, meet_relay._Wave3Bridge): a channel or group chat linked to a Slack
// channel or a Teams chat or channel through a connector its org runs with its own platform credentials.
//
// A connector is a certificate with the SAN URI `urn:lucid-meet:connector`; it uses only `/v1/bridge/c/*` (no session)
// and is never a person. Each org's policy (relay.json `bridge_policies`, admins' edits in ext["bridge"]["policies"])
// and the connector's declared policy decide what crosses a link; anything refused is answered (the sender's `bridged`
// state, a 403 with the reason, a `notice` op), never dropped. Persisted in ext["bridge"] exactly as the Python relay
// keeps it: `policies`, `links`, `codes`, `connectors` (declared policies), `seq` (the last op number), `outbox` (link
// -> ops, internal fields with a leading underscore), `map` (link -> `ext`: platform id -> message id and `msg`:
// message id -> platform id) and `offered` (link -> the file ids its ops named). Audit rows go to
// state_dir/bridge-audit.jsonl (the last AUDIT_MEMORY in memory without a state folder). A child module of meet_hub: it
// shares the one lock.

use super::*;
use crate::meet_guest_port::hide;

pub const KINDS: [&str; 6] = ["text", "edits", "deletes", "reactions", "files", "calls"];
const POLICY_KEYS: [&str; 6] = ["enabled", "send", "receive", "partners", "file_max_mb", "notice"];
const PLATFORMS: [&str; 2] = ["slack", "teams"];
const TARGET_KINDS: [&str; 3] = ["channel", "chat", "dm"];
const OPS: [&str; 7] = ["post", "edit", "delete", "react", "call", "notice", "unlinked"];
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 10;
/// A link code works this long, once.
const CODE_TTL: f64 = 15.0 * 60.0;
/// Open codes per conversation.
const CODES_MAX: usize = 5;
/// Active links per conversation.
const LINKS_MAX: usize = 4;
/// Ops waiting per link, and for at most this many days.
const OUTBOX_MAX: usize = 2000;
const OUTBOX_DAYS: i64 = 7;
/// An op handed out and not acked is handed out again.
const RESEND: f64 = 60.0;
/// Seconds one outbox long-poll may hold.
const WAIT_MAX: f64 = 25.0;
/// Requests per second per connector.
const RATE: usize = 20;
const NOTICE_MAX: usize = 200;
const FILE_MB_MAX: i64 = 100;
/// Platform ids, labels.
const FIELD_MAX: usize = 200;
/// An external person's display name.
const NAME_MAX: usize = 100;
/// A platform permalink.
const URL_MAX: usize = 1000;
const FILES_PER_POST: usize = 10;
/// A guest link a bridge call posts works this long.
const CALL_MINUTES: f64 = 240.0;
/// An off link with nothing left to deliver is kept this long.
const OFF_KEEP: f64 = 30.0 * 86400.0;
const AUDIT_FILE: &str = "bridge-audit.jsonl";
const AUDIT_LIMIT: i64 = 200;
const AUDIT_MAX: i64 = 1000;
/// Audit rows a relay without a state_dir keeps.
const AUDIT_MEMORY: usize = 10000;
const MB: u64 = 1024 * 1024;
pub const C_PREFIX: &str = "/v1/bridge/c/";
/// The org id of people with no organization.
const NONE: &str = "_none";
const NONE_LABEL: &str = "People with no organization";
pub const ROUTES_ONLY: &str = "connectors use the bridge routes only";
pub const CONNECTORS_ONLY: &str = "only a connector certificate can use the connector routes";
const NO_ORG: &str = "a connector needs an organization";
const ONLY_CHANNELS: &str = "only channels and group chats can be linked";
const BAD_CODE: &str = "that code is not valid or has expired";
const NO_LINK: &str = "there is no such link";
const NOT_YOURS: &str = "that link does not belong to this connector";
const NOT_FROM_LINK: &str = "only messages that came from this link can be changed";
const GUESTS_OFF: &str = "guests are off on this relay";
const BUSY: &str = "too many requests from this connector; slow down";
const GONE: &str = "that message is no longer kept";
const FILE_GONE: &str = "that file is no longer kept";

fn noun(kind: &str) -> &'static str {
    match kind {
        "text" => "messages",
        "edits" => "edits",
        "deletes" => "deletions",
        "reactions" => "reactions",
        "files" => "files",
        _ => "calls",
    }
}

fn platform_name(p: &str) -> &'static str {
    if p == "slack" {
        "Slack"
    } else {
        "Teams"
    }
}

/// BRIDGE_OP_KINDS: the kind of content an op carries ("" for notice and unlinked).
fn op_kind_of(op: &str) -> &'static str {
    match op {
        "post" => "text",
        "edit" => "edits",
        "delete" => "deletes",
        "react" => "reactions",
        "call" => "calls",
        _ => "",
    }
}

/// _bridge_op_kind: a post with files is `files`.
fn op_kind(op: &Obj) -> &'static str {
    let name = pj::text_of(op, "op");
    if name == "post" && op.get("files").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false) {
        return "files";
    }
    op_kind_of(&name)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn strings_value(list: &[String]) -> Value {
    Value::Array(list.iter().cloned().map(Value::from).collect())
}

// ── policies ─────────────────────────────────────────────────────────────────────────────────────────────────

/// BRIDGE_OFF_POLICY: an org without a policy, and a connector that has not said hello.
fn off_policy() -> Obj {
    obj([
        ("enabled", Value::Bool(false)),
        ("send", Value::Array(Vec::new())),
        ("receive", Value::Array(Vec::new())),
        ("partners", Value::Array(Vec::new())),
        ("file_max_mb", Value::from(25)),
        ("notice", Value::from("")),
    ])
}

/// _bridge_kinds: a list of kinds, in KINDS order (absent: none).
fn kinds(v: Option<&Value>, what: &str) -> Result<Vec<String>, String> {
    let list = match v {
        None => return Ok(Vec::new()),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => a,
        _ => return Err(format!("{what} must be a list of kinds")),
    };
    if let Some(k) = list.iter().filter_map(Value::as_str).find(|k| !KINDS.contains(k)) {
        return Err(format!("{what}: '{}' is not a kind ({})", pj::clip(k, 40), KINDS.join(", ")));
    }
    Ok(KINDS.iter().filter(|k| list.iter().any(|x| x.as_str() == Some(**k))).map(|k| k.to_string()).collect())
}

/// _bridge_policy: one organization's bridge policy (contract section 3), checked and normalized: unknown keys or
/// kinds are an error, absent keys are off (`partners` absent or [] is nobody, `["*"]` anybody).
pub(super) fn policy(v: &Value) -> Result<Obj, String> {
    let Value::Object(p) = v else { return Err("a bridge policy must be an object".into()) };
    let mut unknown: Vec<String> = p.keys().filter(|k| !POLICY_KEYS.contains(&k.as_str())).map(|k| pj::clip(k, 40)).collect();
    if !unknown.is_empty() {
        unknown.sort();
        return Err(format!("unknown bridge policy keys: {}", unknown.join(", ")));
    }
    let enabled = match p.get("enabled") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("enabled must be true or false".into()),
    };
    let partner_ok = |x: &Value| matches!(x, Value::String(s) if !s.trim().is_empty() && pj::char_len(s) <= m::ORG_FIELD_MAX);
    let named: Vec<String> = match p.get("partners") {
        None => Vec::new(),
        Some(Value::Array(a)) if a.iter().all(partner_ok) => a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).collect(),
        Some(_) => return Err("partners must be a list of organization ids".into()),
    };
    let mut partners: Vec<String> = Vec::new();
    for x in named {
        if !partners.contains(&x) {
            partners.push(x);
        }
    }
    if partners.iter().any(|x| x == "*") && partners.len() > 1 {
        return Err("\"*\" (any organization) must be the only partner".into());
    }
    let most = match p.get("file_max_mb") {
        None => 25,
        Some(v) => match pj::as_int(Some(v)) {
            Some(n) if (1..=FILE_MB_MAX).contains(&n) => n,
            _ => return Err(format!("file_max_mb must be a whole number from 1 to {FILE_MB_MAX}")),
        },
    };
    let notice = match p.get("notice") {
        None => String::new(),
        Some(Value::String(s)) => pj::squash(s),
        Some(_) => return Err("notice must be a text".into()),
    };
    if pj::char_len(&notice) > NOTICE_MAX || !pj::printable(&notice) {
        return Err(format!("notice is at most {NOTICE_MAX} printable characters"));
    }
    let send = kinds(p.get("send"), "send")?;
    let receive = kinds(p.get("receive"), "receive")?;
    Ok(obj([
        ("enabled", Value::Bool(enabled)),
        ("send", strings_value(&send)),
        ("receive", strings_value(&receive)),
        ("partners", strings_value(&partners)),
        ("file_max_mb", Value::from(most)),
        ("notice", Value::from(notice)),
    ]))
}

fn on(p: &Obj) -> bool {
    p.get("enabled") == Some(&Value::Bool(true))
}

fn has(p: &Obj, key: &str, item: &str) -> bool {
    p.get(key).and_then(Value::as_array).map(|a| a.iter().any(|x| x.as_str() == Some(item))).unwrap_or(false)
}

fn file_mb(p: &Obj) -> i64 {
    pj::as_int(p.get("file_max_mb")).unwrap_or(25)
}

/// _bridge_partner: `policy` (of org `own`) lets its content meet org `other`: its own org always, `["*"]` any org,
/// else the ones it names.
fn partner(p: &Obj, other: &str, own: &str) -> bool {
    other == own || strings(p.get("partners")) == ["*"] || has(p, "partners", other)
}

/// _bridge_cap.
fn cap(text: &str) -> String {
    let mut c = text.chars();
    match c.next() {
        Some(first) => first.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// _bridge_whose: "Org A's policy" (for people with no organization, its own words).
fn whose(oid: &str, label: &str) -> String {
    if oid == NONE {
        "the policy for people with no organization".into()
    } else {
        format!("{label}'s policy")
    }
}

/// A link's effective policy now (_bridge_effective's answer).
struct Eff {
    enabled: bool,
    reason: String,
    send: Vec<String>,
    receive: Vec<String>,
    notice: String,
    file_max_mb: i64,
}

fn off_eff(reason: String) -> Eff {
    Eff { enabled: false, reason, send: Vec::new(), receive: Vec::new(), notice: String::new(), file_max_mb: 0 }
}

// ── checks of what a connector sends ─────────────────────────────────────────────────────────────────────────

/// _bridge_field: a short printable text from a connector (an id, a label, a name), whitespace collapsed.
fn field(v: Option<&Value>, what: &str, most: usize) -> R<String> {
    let text = match v {
        Some(Value::String(s)) => pj::squash(s),
        _ => String::new(),
    };
    if text.is_empty() || pj::char_len(&text) > most || !pj::printable(&text) {
        return bad(format!("{what} must be 1 to {most} printable characters"));
    }
    Ok(text)
}

/// _bridge_optional.
fn optional(v: Option<&Value>, what: &str) -> R<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        _ => field(v, what, FIELD_MAX).map(Some),
    }
}

fn platform(v: Option<&Value>) -> R<String> {
    match v {
        Some(Value::String(s)) if PLATFORMS.contains(&s.as_str()) => Ok(s.clone()),
        _ => bad("platform must be slack or teams"),
    }
}

/// _bridge_target: `{id, label, kind}`.
fn target(v: Option<&Value>) -> R<Obj> {
    let t = v.and_then(Value::as_object);
    let Some(t) = t.filter(|t| t.get("kind").and_then(Value::as_str).map(|k| TARGET_KINDS.contains(&k)).unwrap_or(false)) else {
        return bad("target must be {id, label, kind} with kind channel, chat or dm");
    };
    Ok(obj([("id", Value::from(field(t.get("id"), "target id", FIELD_MAX)?)), ("label", Value::from(field(t.get("label"), "target label", FIELD_MAX)?)), ("kind", t["kind"].clone())]))
}

/// _bridge_user: `(platform user id, display name)` of `user: {id, name}`.
fn user(v: Option<&Value>) -> R<(String, String)> {
    let Some(u) = v.and_then(Value::as_object) else { return bad("user must be {id, name}") };
    Ok((field(u.get("id"), "user id", FIELD_MAX)?, field(u.get("name"), "user name", NAME_MAX)?))
}

/// _bridge_url: a platform permalink: an https URL, else "" (never anything a viewer could run).
fn url(v: Option<&Value>) -> String {
    let u = v.and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let scheme_ok = u.len() > 8 && u.is_char_boundary(8) && u[..8].eq_ignore_ascii_case("https://");
    if !scheme_ok || pj::char_len(&u) > URL_MAX || !pj::printable(&u) || u.chars().any(char::is_whitespace) {
        return String::new();
    }
    let netloc = u[8..].split(['/', '?', '#']).next().unwrap_or_default();
    let host = netloc.rsplit('@').next().unwrap_or_default();
    let host = if let Some(rest) = host.strip_prefix('[') { rest.split(']').next().unwrap_or_default() } else { host.split(':').next().unwrap_or_default() };
    if host.is_empty() {
        return String::new();
    }
    u
}

/// _bridge_room: a conversation's call room: `cv-` + the channel id without `c-`, at most 40.
fn room(cid: &str) -> String {
    pj::clip(&format!("cv-{}", cid.strip_prefix("c-").unwrap_or(cid)), 40)
}

fn bad_number(v: Option<&Value>) -> bool {
    pj::as_num(v).map(|x| x < 0.0).unwrap_or(true)
}

/// _bridge_stored_link: a link from state.json has the shape the routes rely on.
fn stored_link(lid: &str, link: &Value) -> bool {
    let Some(l) = link.as_object() else { return false };
    let text = |o: &Obj, k: &str| o.get(k).map(Value::is_string).unwrap_or(false);
    let org_ok = as_obj(l.get("org")).map(|o| text(o, "id") && text(o, "label")).unwrap_or(false);
    let target_ok = as_obj(l.get("target")).map(|t| ["id", "label", "kind"].iter().all(|k| text(t, k))).unwrap_or(false);
    l.get("id").and_then(Value::as_str) == Some(lid)
        && text(l, "channel")
        && text(l, "connector")
        && l.get("platform").and_then(Value::as_str).map(|p| PLATFORMS.contains(&p)).unwrap_or(false)
        && matches!(l.get("state").and_then(Value::as_str), Some("active" | "off"))
        && org_ok
        && target_ok
        && ["send", "receive"].iter().all(|k| l.get(*k).map(Value::is_array).unwrap_or(false))
        && ["reason", "notice", "by", "claimed_by"].iter().all(|k| text(l, k))
}

/// _bridge_store's check: ext["bridge"] made sound (a hand-edited or older state.json loses only the entries that are
/// not what the routes rely on).
fn sound(raw: &Obj) -> Obj {
    let section = |key: &str| as_obj(raw.get(key)).cloned().unwrap_or_default();
    let mut policies = Obj::new();
    for (org, p) in section("policies") {
        match policy(&p) {
            Ok(p) => {
                policies.insert(org, Value::Object(p));
            }
            Err(_) => log_warn(&format!("state file: bridge policy of {} unreadable; ignored", kv(&org))),
        }
    }
    let links: Obj = section("links").into_iter().filter(|(k, v)| stored_link(k, v)).collect();
    let codes: Obj = section("codes")
        .into_iter()
        .filter(|(_, v)| {
            v.as_object()
                .map(|r| r.get("channel").map(Value::is_string).unwrap_or(false) && r.get("by").map(Value::is_string).unwrap_or(false) && r.get("platform").and_then(Value::as_str).map(|p| PLATFORMS.contains(&p)).unwrap_or(false) && !bad_number(r.get("expires")))
                .unwrap_or(false)
        })
        .collect();
    let mut connectors = Obj::new();
    for (principal, row) in section("connectors") {
        let read = (|| -> Option<Obj> {
            let r = row.as_object()?;
            let p = r.get("platform").and_then(Value::as_str).filter(|p| PLATFORMS.contains(p))?;
            let declared = policy(r.get("policy").unwrap_or(&Value::Null)).ok()?;
            let version = if pj::truthy(r.get("version")) { pj::clip(&pj::py_str(&r["version"]), 40) } else { String::new() };
            let ts = match r.get("ts") {
                None | Some(Value::Null) | Some(Value::Bool(false)) => 0.0,
                v => pj::as_num(v)?,
            };
            Some(obj([("platform", Value::from(p)), ("policy", Value::Object(declared)), ("version", Value::from(version)), ("ts", f(ts))]))
        })();
        match read {
            Some(r) => {
                connectors.insert(principal, Value::Object(r));
            }
            None => log_warn(&format!("state file: bridge connector {} unreadable; ignored", kv(&principal))),
        }
    }
    let mut outbox = Obj::new();
    let mut seq = pj::as_int(raw.get("seq")).filter(|s| *s > 0).unwrap_or(0);
    for (lid, ops) in section("outbox") {
        let Value::Array(ops) = ops else { continue };
        if !links.contains_key(&lid) {
            continue;
        }
        let kept: Vec<Value> = ops
            .into_iter()
            .filter(|o| {
                o.as_object()
                    .map(|o| o.get("op").and_then(Value::as_str).map(|x| OPS.contains(&x)).unwrap_or(false) && pj::as_int(o.get("seq")).is_some() && !bad_number(o.get("_ts")) && !bad_number(o.get("_sent")))
                    .unwrap_or(false)
            })
            .collect();
        for o in &kept {
            seq = seq.max(pj::as_int(o.get("seq")).unwrap_or(0));
        }
        if !kept.is_empty() {
            outbox.insert(lid, Value::Array(kept));
        }
    }
    let as_text = |o: &Obj| -> Value { Value::Object(o.iter().map(|(k, v)| (k.clone(), Value::from(pj::py_str(v)))).collect()) };
    let mut maps = Obj::new();
    for (lid, mp) in section("map") {
        let Some(mp) = mp.as_object() else { continue };
        if let (true, Some(ext), Some(msg)) = (links.contains_key(&lid), as_obj(mp.get("ext")), as_obj(mp.get("msg"))) {
            maps.insert(lid, Value::Object(obj([("ext", as_text(ext)), ("msg", as_text(msg))])));
        }
    }
    let mut offered = Obj::new();
    for (lid, v) in section("offered") {
        if let (true, Some(v)) = (links.contains_key(&lid), v.as_object()) {
            let kept: Obj = v.iter().filter(|(_, t)| !bad_number(Some(t))).map(|(k, t)| (k.clone(), f(pj::as_num(Some(t)).unwrap_or(0.0)))).collect();
            offered.insert(lid, Value::Object(kept));
        }
    }
    obj([
        ("v", Value::from(1)),
        ("policies", Value::Object(policies)),
        ("links", Value::Object(links)),
        ("codes", Value::Object(codes)),
        ("connectors", Value::Object(connectors)),
        ("seq", Value::from(seq)),
        ("outbox", Value::Object(outbox)),
        ("map", Value::Object(maps)),
        ("offered", Value::Object(offered)),
    ])
}

/// _bridge_member_view: a link as members see it (the channel view's `links`, `bridge_link` events, GET
/// /v1/bridge/links, the unlink answer).
fn member_view(link: &Obj) -> Obj {
    let t = as_obj(link.get("target")).cloned().unwrap_or_default();
    obj([
        ("id", link.get("id").cloned().unwrap_or(Value::Null)),
        ("platform", link.get("platform").cloned().unwrap_or(Value::Null)),
        ("org", link.get("org").cloned().unwrap_or(Value::Null)),
        ("target", Value::Object(obj([("label", t.get("label").cloned().unwrap_or(Value::Null)), ("kind", t.get("kind").cloned().unwrap_or(Value::Null))]))),
        ("state", link.get("state").cloned().unwrap_or(Value::Null)),
        ("reason", link.get("reason").cloned().unwrap_or(Value::Null)),
        ("notice", link.get("notice").cloned().unwrap_or(Value::Null)),
    ])
}

/// _bridge_c_view: a link as its connector sees it: never a member's principal or the channel id.
fn c_view(link: &Obj) -> Obj {
    let get = |k: &str| link.get(k).cloned().unwrap_or(Value::Null);
    obj([
        ("id", get("id")),
        ("platform", get("platform")),
        ("org", get("org")),
        ("target", get("target")),
        ("state", get("state")),
        ("reason", get("reason")),
        ("claimed_by", get("claimed_by")),
        ("ts", get("ts")),
        ("send", get("send")),
        ("receive", get("receive")),
        ("notice", get("notice")),
    ])
}

fn delivery(state: &str, reason: &str, ext: &str) -> Value {
    Value::Object(obj([("state", Value::from(state)), ("reason", Value::from(reason)), ("ext", Value::from(ext))]))
}

/// A single-use link code of CODE_LEN characters of CODE_ALPHABET (uniform: bytes past the last whole run of the
/// alphabet are skipped).
fn new_code() -> String {
    let n = CODE_ALPHABET.len();
    let mut out = String::new();
    while out.len() < CODE_LEN {
        for b in pj::random_bytes(16) {
            if (b as usize) < n * (256 / n) && out.len() < CODE_LEN {
                out.push(CODE_ALPHABET[b as usize % n] as char);
            }
        }
    }
    out
}

// ── in memory ────────────────────────────────────────────────────────────────────────────────────────────────

/// In memory: relay.json `bridge_policies` (checked at start), connector request times for the rate limit, and the
/// audit rows of a relay without a state folder.
pub struct Bridge {
    base: IndexMap<String, Obj>,
    checked: bool,
    hits: HashMap<String, VecDeque<f64>>,
    rows: VecDeque<Obj>,
    rows_gone: usize,
    state_dir: Option<PathBuf>,
}

impl Bridge {
    pub(super) fn new(state_dir: Option<PathBuf>) -> Bridge {
        Bridge { base: IndexMap::new(), checked: false, hits: HashMap::new(), rows: VecDeque::new(), rows_gone: 0, state_dir }
    }
}

// ── the slice's state (callers hold the lock) ────────────────────────────────────────────────────────────────

impl State {
    /// _bridge_store: ext["bridge"], made sound the first time.
    fn br(&mut self) -> &mut Obj {
        let present = matches!(self.ext.get("bridge"), Some(Value::Object(_)));
        if !self.bridge.checked || !present {
            self.bridge.checked = true;
            let raw = as_obj(self.ext.get("bridge")).cloned().unwrap_or_default();
            self.ext.insert("bridge".into(), Value::Object(sound(&raw)));
        }
        self.ext.get_mut("bridge").and_then(Value::as_object_mut).expect("the bridge store")
    }

    fn br_part(&mut self, key: &str) -> &mut Obj {
        obj_mut(self.br(), key)
    }

    /// A part of ext["bridge"] for reading (made sound at load and at start).
    fn br_view(&self, key: &str) -> Option<&Obj> {
        as_obj(self.ext.get("bridge")).and_then(|b| as_obj(b.get(key)))
    }

    fn br_link(&mut self, lid: &str) -> Option<Obj> {
        self.br_part("links").get(lid).and_then(Value::as_object).cloned()
    }

    fn br_link_set(&mut self, lid: &str, changes: Obj) {
        if let Some(Value::Object(l)) = self.br_part("links").get_mut(lid) {
            for (k, v) in changes {
                l.insert(k, v);
            }
        }
        self.dirty = true;
    }

    fn br_ops(&mut self, lid: &str) -> &mut Vec<Value> {
        let slot = self.br_part("outbox").entry(lid.to_string()).or_insert_with(|| Value::Array(Vec::new()));
        if !slot.is_array() {
            *slot = Value::Array(Vec::new());
        }
        slot.as_array_mut().expect("the link's ops")
    }

    /// _bridge_configure: relay.json `bridge_policies`, each checked (Err: the relay does not start); then every link
    /// is re-evaluated.
    pub(super) fn bridge_configure(&mut self, s: &m::Settings) -> Result<(), String> {
        let mut base = IndexMap::new();
        for (org, p) in &s.bridge_policies {
            if org.trim().is_empty() || pj::char_len(org) > m::ORG_FIELD_MAX {
                return Err("relay settings: bridge_policies keys are organization ids".into());
            }
            let checked = policy(p).map_err(|e| format!("relay settings: bridge_policies {org}: {e}"))?;
            base.insert(org.trim().to_string(), checked);
        }
        self.bridge.base = base;
        self.bridge_recheck("relay", None, None);
        Ok(())
    }

    /// _bridge_may_join: a connector never joins a call.
    pub(super) fn bridge_may_join(&self, who: &Identity) -> R<()> {
        if who.connector {
            return forbidden(ROUTES_ONLY);
        }
        Ok(())
    }

    // ── policies ─────────────────────────────────────────────────────────────────────────────────────────────

    /// _bridge_policy_of: the policy in force for an org: an admin's edit, else relay.json, else off.
    fn bridge_policy_of(&mut self, oid: &str) -> Obj {
        if let Some(Value::Object(p)) = self.br_part("policies").get(oid) {
            return p.clone();
        }
        self.bridge.base.get(oid).cloned().unwrap_or_else(off_policy)
    }

    /// _bridge_declared: a connector's own policy as it declared it in hello (none yet: off).
    fn bridge_declared(&mut self, principal: &str) -> Obj {
        self.br_part("connectors").get(principal).and_then(|r| as_obj(r.get("policy"))).cloned().unwrap_or_else(off_policy)
    }

    /// _org as (id, label).
    fn bridge_org(&self, principal: &str) -> Option<(String, String)> {
        match self.org(principal) {
            Value::Object(o) => Some((pj::text_of(&o, "id"), pj::text_of(&o, "label"))),
            _ => None,
        }
    }

    /// _bridge_org_of: `_none` for people with no organization.
    fn bridge_org_of(&self, principal: &str) -> (String, String) {
        self.bridge_org(principal).unwrap_or_else(|| (NONE.into(), NONE_LABEL.into()))
    }

    /// _bridge_member_orgs: the orgs of the conversation's members, by id.
    fn bridge_member_orgs(&self, cid: &str) -> Vec<(String, String)> {
        let mut found: Vec<(String, String)> = Vec::new();
        for p in channels::members_of(self.channel(cid)) {
            let (id, label) = self.bridge_org_of(&p);
            if !found.iter().any(|(i, _)| *i == id) {
                found.push((id, label));
            }
        }
        found.sort();
        found
    }

    /// _bridge_orgs: the relay's organizations and `_none`.
    fn bridge_orgs(&self) -> Vec<Value> {
        let mut out = Hub::org_list(self).get("organizations").and_then(Value::as_array).cloned().unwrap_or_default();
        out.push(Value::Object(obj([("id", Value::from(NONE)), ("label", Value::from(NONE_LABEL))])));
        out
    }

    /// _bridge_effective: every member org's policy enabled and naming the connector's org, and the connector's
    /// declared policy enabled and naming every member org; `send` (Lucid to the platform) = the member orgs' `send`
    /// and the connector's `receive`, `receive` = the member orgs' `receive` and the connector's `send`. Off: `reason`
    /// says whose policy stopped it.
    fn bridge_effective(&mut self, link: &Obj) -> Eff {
        let cid = pj::text_of(link, "channel");
        if self.channel(&cid).is_none() {
            return off_eff("the conversation is no longer kept".into());
        }
        let connector = pj::text_of(link, "connector");
        let Some((coid, clabel)) = self.bridge_org(&connector) else { return off_eff(NO_ORG.into()) };
        let mut send: Vec<&str> = KINDS.to_vec();
        let mut receive: Vec<&str> = KINDS.to_vec();
        let mut most = FILE_MB_MAX;
        let mut notices: Vec<String> = Vec::new();
        let orgs = self.bridge_member_orgs(&cid);
        for (oid, label) in &orgs {
            let p = self.bridge_policy_of(oid);
            if !on(&p) || !partner(&p, &coid, oid) {
                return off_eff(cap(&format!("{} does not allow bridging with {clabel}", whose(oid, label))));
            }
            send.retain(|k| has(&p, "send", k));
            receive.retain(|k| has(&p, "receive", k));
            most = most.min(file_mb(&p));
            let n = pj::s(&p, "notice");
            if !n.is_empty() && !notices.contains(&n) {
                notices.push(n);
            }
        }
        if !self.br_part("connectors").contains_key(&connector) {
            return off_eff(format!("{clabel}'s connector has not said what its policy allows"));
        }
        let mine = self.bridge_declared(&connector);
        if !on(&mine) {
            return off_eff(format!("{clabel}'s policy does not allow bridging"));
        }
        for (oid, label) in &orgs {
            if !partner(&mine, oid, &coid) {
                return off_eff(format!("{clabel}'s policy does not allow bridging with {label}"));
            }
        }
        send.retain(|k| has(&mine, "receive", k));
        receive.retain(|k| has(&mine, "send", k));
        most = most.min(file_mb(&mine));
        let n = pj::s(&mine, "notice");
        if !n.is_empty() && !notices.contains(&n) {
            notices.push(n);
        }
        Eff { enabled: true, reason: String::new(), send: send.into_iter().map(str::to_string).collect(), receive: receive.into_iter().map(str::to_string).collect(), notice: notices.join("\n"), file_max_mb: most }
    }

    /// _bridge_recheck: re-evaluate active links (all, one conversation's or one connector's) after a policy,
    /// membership, organization or hello change: one no longer allowed goes off with the reason; a changed one is
    /// told to the members.
    pub(super) fn bridge_recheck(&mut self, by: &str, cid: Option<&str>, connector: Option<&str>) {
        let ids: Vec<String> = self.br_part("links").keys().cloned().collect();
        for lid in ids {
            let Some(link) = self.br_link(&lid) else { continue };
            if pj::text_of(&link, "state") != "active" || cid.is_some_and(|c| pj::text_of(&link, "channel") != c) || connector.is_some_and(|c| pj::text_of(&link, "connector") != c) {
                continue;
            }
            let eff = self.bridge_effective(&link);
            if !eff.enabled {
                self.bridge_off(&lid, &eff.reason, by, "", "blocked");
                continue;
            }
            let fresh = obj([("send", strings_value(&eff.send)), ("receive", strings_value(&eff.receive)), ("notice", Value::from(eff.notice))]);
            if fresh.iter().any(|(k, v)| link.get(k) != Some(v)) {
                self.br_link_set(&lid, fresh);
                self.bridge_tell_link(&lid);
            }
        }
    }

    // ── links ────────────────────────────────────────────────────────────────────────────────────────────────

    /// _bridge_links_in: a conversation's links, oldest first.
    fn bridge_links_in(&self, cid: &str) -> Vec<Obj> {
        let mut out: Vec<Obj> = self.br_view("links").into_iter().flat_map(|l| l.values()).filter_map(Value::as_object).filter(|l| pj::text_of(l, "channel") == cid).cloned().collect();
        out.sort_by(|a, b| pj::num(a, "ts").partial_cmp(&pj::num(b, "ts")).unwrap_or(std::cmp::Ordering::Equal));
        out
    }

    fn bridge_active(&self, cid: &str) -> Vec<Obj> {
        self.bridge_links_in(cid).into_iter().filter(|l| pj::text_of(l, "state") == "active").collect()
    }

    /// _bridge_tell_link: every member hears `bridge_link`.
    fn bridge_tell_link(&mut self, lid: &str) {
        let Some(link) = self.br_link(lid) else { return };
        let cid = pj::text_of(&link, "channel");
        if self.channel(&cid).is_none() {
            return;
        }
        let members = channels::members_of(self.channel(&cid));
        self.tell(&members, &obj([("type", Value::from("bridge_link")), ("channel", Value::from(cid)), ("link", Value::Object(member_view(&link)))]), None);
    }

    /// _bridge_system: a system line in the conversation (`system: "bridge"`, from nobody).
    fn bridge_system(&mut self, cid: &str, text: &str, extra: Obj) {
        let now = pj::now().max(self.last_ts(cid) + 1e-6);
        let mut msg = obj([
            ("id", Value::from(pj::token_hex(8))),
            ("channel", Value::from(cid)),
            ("from", Value::from("")),
            ("from_name", Value::from("")),
            ("from_org", Value::Null),
            ("text", Value::from(text)),
            ("ts", f(now)),
            ("reactions", Value::Object(Obj::new())),
            ("system", Value::from("bridge")),
        ]);
        for (k, v) in extra {
            msg.insert(k, v);
        }
        let msgs = self.channel_msgs.entry(cid.to_string()).or_default();
        msgs.push(msg.clone());
        if msgs.len() > channels::CHANNEL_KEEP {
            let cut = msgs.len() - channels::CHANNEL_KEEP;
            msgs.drain(..cut);
        }
        self.channel_mut(cid).insert("last".into(), f(now));
        self.dirty = true;
        let members = channels::members_of(self.channel(cid));
        self.tell(&members, &obj([("type", Value::from("channel_message")), ("message", Value::Object(msg))]), None);
    }

    /// _bridge_off: the link goes off: what waits in its outbox is dropped (its messages marked failed), the connector
    /// is sent `unlinked`, every member hears `bridge_link`.
    fn bridge_off(&mut self, lid: &str, reason: &str, by: &str, org: &str, result: &str) {
        let Some(link) = self.br_link(lid) else { return };
        if pj::text_of(&link, "state") == "off" {
            return;
        }
        let cid = pj::text_of(&link, "channel");
        self.br_link_set(lid, obj([("state", Value::from("off")), ("reason", Value::from(reason)), ("off_ts", f(pj::now()))]));
        if let Some(Value::Array(ops)) = self.br_part("outbox").shift_remove(lid) {
            for op in ops.iter().filter_map(Value::as_object) {
                if pj::text_of(op, "op") == "post" {
                    self.bridge_mark(&cid, &pj::text_of(op, "msg"), lid, "failed", reason, "");
                }
            }
        }
        self.br_part("offered").shift_remove(lid);
        self.bridge_queue(lid, "unlinked", obj([("reason", Value::from(reason))]), None, "", "");
        self.dirty = true;
        self.bridge_tell_link(lid);
        let link = self.br_link(lid).unwrap_or(link);
        self.bridge_audit(Some(&link), "out", "unlink", "", by, org, result, reason);
        log_info(&format!("bridge_off link={lid} channel={cid} reason={}", kv(reason)));
    }

    // ── delivery state ───────────────────────────────────────────────────────────────────────────────────────

    /// _bridge_mark: one link's delivery state of a message (a new `bridged` object every time), told as a
    /// delivery-only `chat_update` {type, scope, channel, id, bridged}: no text or other content, so no client takes
    /// it for an edit.
    fn bridge_mark(&mut self, cid: &str, mid: &str, lid: &str, state: &str, reason: &str, ext: &str) {
        if self.channel(cid).is_none() {
            return;
        }
        let Some(msg) = self.channel_msgs.get_mut(cid).and_then(|l| l.iter_mut().find(|m| pj::text_of(m, "id") == mid)) else { return };
        let mut bridged = as_obj(msg.get("bridged")).cloned().unwrap_or_default();
        bridged.insert(lid.to_string(), delivery(state, reason, ext));
        msg.insert("bridged".into(), Value::Object(bridged.clone()));
        self.dirty = true;
        let members = channels::members_of(self.channel(cid));
        let event = obj([("type", Value::from("chat_update")), ("scope", Value::from("channel")), ("channel", Value::from(cid)), ("id", Value::from(mid)), ("bridged", Value::Object(bridged))]);
        self.tell(&members, &event, None);
    }

    /// _bridge_remember: platform id <-> message id on one link (acks and bridged posts).
    fn bridge_remember(&mut self, lid: &str, mid: &str, ext: &str) {
        let mp = obj_mut(self.br_part("map"), lid);
        obj_mut(mp, "ext").insert(ext.to_string(), Value::from(mid));
        obj_mut(mp, "msg").insert(mid.to_string(), Value::from(ext));
    }

    /// _bridge_ext: the platform id of a message on a link ("" when it never crossed).
    fn bridge_ext(&self, lid: &str, mid: &str) -> String {
        self.br_view("map").and_then(|mp| as_obj(mp.get(lid))).and_then(|mp| as_obj(mp.get("msg"))).and_then(|mp| mp.get(mid)).and_then(Value::as_str).unwrap_or_default().to_string()
    }

    /// _bridge_mid: where the kept message a platform id names on this link is (None when unknown).
    fn bridge_mid(&self, lid: &str, cid: &str, pid: Option<&str>) -> Option<usize> {
        let pid = pid.filter(|p| !p.is_empty())?;
        let mid = self.br_view("map").and_then(|mp| as_obj(mp.get(lid))).and_then(|mp| as_obj(mp.get("ext"))).and_then(|mp| mp.get(pid)).and_then(Value::as_str)?;
        self.channel_msgs.get(cid)?.iter().position(|m| pj::text_of(m, "id") == mid)
    }

    // ── the outbox ───────────────────────────────────────────────────────────────────────────────────────────

    /// _bridge_queue: one op at the end of the link's outbox with the next seq. `_mid`: the message whose platform id
    /// the op needs (`ext` of edit, delete and react, `thread` of a post), looked up when it is handed out;
    /// `_by`/`_org`: who it came from, for the audit. Callers wake the hub.
    #[allow(clippy::too_many_arguments)]
    fn bridge_queue(&mut self, lid: &str, op: &str, fields: Obj, mid: Option<&str>, by: &str, org: &str) {
        let now = pj::now();
        let store = self.br();
        let seq = pj::as_int(store.get("seq")).unwrap_or(0) + 1;
        store.insert("seq".into(), Value::from(seq));
        let mut row = fields;
        row.insert("seq".into(), Value::from(seq));
        row.insert("op".into(), Value::from(op));
        row.insert("link".into(), Value::from(lid));
        row.insert("_ts".into(), f(now));
        row.insert("_sent".into(), f(0.0));
        row.insert("_by".into(), Value::from(by));
        row.insert("_org".into(), Value::from(org));
        if let Some(mid) = mid.filter(|m| !m.is_empty()) {
            row.insert("_mid".into(), Value::from(mid));
        }
        self.br_ops(lid).push(Value::Object(row));
        self.bridge_trim(lid, now);
        self.dirty = true;
    }

    /// _bridge_trim: at most OUTBOX_MAX ops and OUTBOX_DAYS days: the oldest go, their messages marked failed.
    fn bridge_trim(&mut self, lid: &str, now: f64) {
        let Some(link) = self.br_link(lid) else { return };
        let cut = now - OUTBOX_DAYS as f64 * 86400.0;
        let name = platform_name(&pj::text_of(&link, "platform"));
        let cid = pj::text_of(&link, "channel");
        loop {
            let Some(Value::Array(ops)) = self.br_part("outbox").get_mut(lid) else { return };
            let Some(first) = ops.first().and_then(Value::as_object) else { return };
            let old_ts = pj::num(first, "_ts");
            if !(ops.len() > OUTBOX_MAX || old_ts < cut) {
                return;
            }
            let old = ops.remove(0).as_object().cloned().unwrap_or_default();
            let why = if old_ts < cut { format!("{name} was unreachable for {OUTBOX_DAYS} days") } else { format!("{name} was unreachable for too long") };
            if pj::text_of(&old, "op") == "post" {
                self.bridge_mark(&cid, &pj::text_of(&old, "msg"), lid, "failed", &why, "");
            }
            let by = Some(pj::s(&old, "_by")).filter(|b| !b.is_empty()).unwrap_or_else(|| "relay".into());
            self.bridge_audit(Some(&link), "out", &pj::text_of(&old, "op"), op_kind(&old), &by, &pj::s(&old, "_org"), "failed", &why);
            self.dirty = true;
        }
    }

    /// _bridge_unqueue: take a message's post out of the outbox before it went (it was deleted).
    fn bridge_unqueue(&mut self, lid: &str, mid: &str) -> bool {
        let Some(Value::Array(ops)) = self.br_part("outbox").get_mut(lid) else { return false };
        let Some(at) = ops.iter().position(|o| o.as_object().map(|o| pj::text_of(o, "op") == "post" && pj::text_of(o, "msg") == mid).unwrap_or(false)) else { return false };
        ops.remove(at);
        self.dirty = true;
        true
    }

    /// _bridge_ready: `(link, seq, view)` of every op the connector should get now, by seq: every op after `after` and
    /// every op handed out RESEND ago and not acked. Per link in order: an op that needs the platform id of a post
    /// still waiting for its ack holds the rest of that link's ops (`_held`; released, one never handed out gets a new
    /// seq, so a connector that moved `after` past it still gets it); an edit, delete or react of a message that never
    /// crossed goes.
    fn bridge_ready(&mut self, principal: &str, after: i64, now: f64) -> Vec<(String, i64, Obj)> {
        let lids: Vec<String> = self.br_part("links").values().filter_map(Value::as_object).filter(|l| pj::text_of(l, "connector") == principal).map(|l| pj::text_of(l, "id")).collect();
        let mut out: Vec<(String, i64, Obj)> = Vec::new();
        for lid in lids {
            let mut ops: Vec<Obj> = match self.br_part("outbox").get(&lid) {
                Some(Value::Array(a)) if !a.is_empty() => a.iter().filter_map(Value::as_object).cloned().collect(),
                _ => continue,
            };
            let mut pending: HashSet<String> = HashSet::new();
            let mut gone: Vec<usize> = Vec::new();
            let mut i = 0;
            while i < ops.len() {
                let mut view: Obj = ops[i].iter().filter(|(k, _)| !k.starts_with('_')).map(|(k, v)| (k.clone(), v.clone())).collect();
                let kind = pj::text_of(&ops[i], "op");
                if let Some(mid) = ops[i].get("_mid").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string) {
                    let ext = self.bridge_ext(&lid, &mid);
                    if ext.is_empty() && pending.contains(&mid) {
                        for rest in &mut ops[i..] {
                            rest.insert("_held".into(), Value::Bool(true));
                        }
                        break;
                    }
                    if matches!(kind.as_str(), "edit" | "delete" | "react") {
                        if ext.is_empty() {
                            gone.push(i);
                            i += 1;
                            continue;
                        }
                        view.insert("ext".into(), Value::from(ext));
                    } else {
                        view.insert("thread".into(), Value::from(ext));
                    }
                }
                if kind == "post" {
                    pending.insert(pj::text_of(&ops[i], "msg"));
                }
                let held = pj::truthy(ops[i].shift_remove("_held").as_ref());
                let sent = pj::num(&ops[i], "_sent");
                if held && sent == 0.0 && pj::as_int(ops[i].get("seq")).unwrap_or(0) <= after {
                    let store = self.br();
                    let seq = pj::as_int(store.get("seq")).unwrap_or(0) + 1;
                    store.insert("seq".into(), Value::from(seq));
                    ops[i].insert("seq".into(), Value::from(seq));
                    view.insert("seq".into(), Value::from(seq));
                    self.dirty = true;
                }
                let seq = pj::as_int(ops[i].get("seq")).unwrap_or(0);
                if seq > after || (sent != 0.0 && now - sent >= RESEND) {
                    out.push((lid.clone(), seq, view));
                }
                i += 1;
            }
            if !gone.is_empty() {
                self.dirty = true;
            }
            for at in gone.into_iter().rev() {
                ops.remove(at);
            }
            *self.br_ops(&lid) = ops.into_iter().map(Value::Object).collect();
        }
        out.sort_by_key(|(_, seq, _)| *seq);
        out
    }

    /// The ops handed out now are marked sent (handed out again after RESEND unless acked).
    fn bridge_sent(&mut self, picked: &[(String, i64, Obj)], now: f64) {
        for (lid, seq, _) in picked {
            if let Some(Value::Array(ops)) = self.br_part("outbox").get_mut(lid) {
                for op in ops.iter_mut().filter_map(Value::as_object_mut) {
                    if pj::as_int(op.get("seq")) == Some(*seq) {
                        op.insert("_sent".into(), f(now));
                    }
                }
            }
        }
        if !picked.is_empty() {
            self.dirty = true;
        }
    }

    // ── outgoing: what a conversation sends to its links ─────────────────────────────────────────────────────

    /// _bridge_out_reason: why content of these kinds may not go out through `link` ("" when it may). `sender`: the
    /// member it came from (their org's own `send` is checked too); `origin`: the link it came from (Teams to Slack:
    /// both connectors' partners).
    fn bridge_out_reason(&mut self, cid: &str, link: &Obj, kinds: &[&str], sender: Option<&str>, origin: Option<&Obj>, size: u64) -> String {
        let eff = self.bridge_effective(link);
        if !eff.enabled {
            return eff.reason;
        }
        let corg = as_obj(link.get("org")).cloned().unwrap_or_default();
        let (cid_org, clabel) = (pj::text_of(&corg, "id"), pj::text_of(&corg, "label"));
        let mine = self.bridge_declared(&pj::text_of(link, "connector"));
        if let Some(origin) = origin {
            let theirs = self.bridge_declared(&pj::text_of(origin, "connector"));
            let o = as_obj(origin.get("org")).cloned().unwrap_or_default();
            let (oid, olabel) = (pj::text_of(&o, "id"), pj::text_of(&o, "label"));
            if !partner(&theirs, &cid_org, &oid) {
                return format!("{olabel}'s policy does not allow bridging with {clabel}");
            }
            if !partner(&mine, &oid, &cid_org) {
                return format!("{clabel}'s policy does not allow bridging with {olabel}");
            }
        }
        for kind in kinds {
            if let Some(sender) = sender {
                let own = self.bridge_org_of(sender).0;
                if !has(&self.bridge_policy_of(&own), "send", kind) {
                    return "your organization's policy".into();
                }
            }
            if !has(&mine, "receive", kind) {
                return format!("{clabel} does not accept {}", noun(kind));
            }
            if !eff.send.iter().any(|k| k == kind) {
                for (oid, label) in self.bridge_member_orgs(cid) {
                    if !has(&self.bridge_policy_of(&oid), "send", kind) {
                        return cap(&whose(&oid, &label));
                    }
                }
                return format!("this link does not carry {}", noun(kind));
            }
        }
        if size > eff.file_max_mb.max(0) as u64 * MB {
            return format!("{clabel} does not accept files over {} MB", eff.file_max_mb);
        }
        String::new()
    }

    /// _bridge_name: a mentioned member's display name for an op ("" when unknown: never the address).
    fn bridge_name(&self, principal: &str) -> String {
        self.directory.get(principal).and_then(Value::as_object).map(|e| hide(&pj::s(e, "name"))).unwrap_or_default()
    }

    /// _bridge_post_fields: a post op: names, labels and text only, never an address or a principal.
    fn bridge_post_fields(&self, msg: &Obj) -> Obj {
        let src = as_obj(msg.get("src"));
        let org = match src {
            Some(s) => s.get("org"),
            None => msg.get("from_org"),
        };
        let label = org.and_then(Value::as_object).map(|o| pj::py_str(o.get("label").unwrap_or(&Value::Null))).unwrap_or_default();
        let from_name = match src {
            Some(s) => pj::text_of(s, "name"),
            None => pj::s(msg, "from_name"),
        };
        let reply = match msg.get("reply_to") {
            Some(Value::Object(r)) => pj::s(r, "text"),
            _ => String::new(),
        };
        let mentions: Vec<Value> = msg.get("mentions").and_then(Value::as_array).into_iter().flatten().map(|p| self.bridge_name(&pj::py_str(p))).filter(|n| !n.is_empty()).map(Value::from).collect();
        let files: Vec<Value> = msg
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .map(|file| {
                let get = |k: &str| file.get(k).cloned().unwrap_or(Value::Null);
                Value::Object(obj([("id", get("id")), ("name", get("name")), ("size", get("size")), ("mime", get("type"))]))
            })
            .collect();
        obj([
            ("msg", msg.get("id").cloned().unwrap_or(Value::Null)),
            ("from_name", Value::from(hide(&from_name))),
            ("from_org", Value::Object(obj([("label", Value::from(label))]))),
            ("from_platform", Value::from(src.map(|s| pj::text_of(s, "platform")).unwrap_or_else(|| "lucid".into()))),
            ("text", Value::from(pj::s(msg, "text"))),
            ("thread", Value::from("")),
            ("reply_to", Value::from(reply)),
            ("mentions", Value::Array(mentions)),
            ("files", Value::Array(files)),
        ])
    }

    /// _bridge_send_post: a new message out to the conversation's active links (never back to `origin`, the link it
    /// came from), each subject to the policies: `bridged` queued or blocked. A blocked copy of a bridged message is
    /// also told to its own platform (`notice`).
    fn bridge_send_post(&mut self, cid: &str, msg: &mut Obj, by: &str, org: &str, origin: Option<&Obj>) {
        let origin_id = origin.map(|o| pj::text_of(o, "id"));
        let links: Vec<Obj> = self.bridge_active(cid).into_iter().filter(|l| origin_id.as_deref() != Some(pj::text_of(l, "id").as_str())).collect();
        if links.is_empty() {
            return;
        }
        let files: Vec<Obj> = msg.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).cloned().collect();
        let mut kinds: Vec<&str> = Vec::new();
        if !files.is_empty() {
            kinds.push("files");
        }
        if pj::truthy(msg.get("text")) || files.is_empty() {
            kinds.push("text");
        }
        let size = files.iter().map(|file| pj::num(file, "size").max(0.0) as u64).max().unwrap_or(0);
        let sender = if origin.is_some() { None } else { Some(pj::s(msg, "from")) };
        let mut bridged = as_obj(msg.get("bridged")).cloned().unwrap_or_default();
        let now = pj::now();
        let fields = self.bridge_post_fields(msg);
        let thread = Some(pj::s(msg, "thread")).filter(|t| !t.is_empty());
        for link in &links {
            let lid = pj::text_of(link, "id");
            let reason = self.bridge_out_reason(cid, link, &kinds, sender.as_deref(), origin, size);
            if !reason.is_empty() {
                bridged.insert(lid.clone(), delivery("blocked", &reason, ""));
                self.bridge_audit(Some(link), "out", "post", kinds[0], by, org, "blocked", &reason);
                if let Some(oid) = &origin_id {
                    if self.br_link(oid).map(|o| pj::text_of(&o, "state") == "active").unwrap_or(false) {
                        let src_msg = as_obj(msg.get("src")).map(|s| pj::s(s, "msg")).unwrap_or_default();
                        let text = format!("Not sent to {}: {reason}", platform_name(&pj::text_of(link, "platform")));
                        self.bridge_queue(oid, "notice", obj([("text", Value::from(text)), ("thread", Value::from(src_msg))]), None, "", "");
                    }
                }
                continue;
            }
            bridged.insert(lid.clone(), delivery("queued", "", ""));
            self.bridge_queue(&lid, "post", fields.clone(), thread.as_deref(), by, org);
            let offered = obj_mut(self.br_part("offered"), &lid);
            for file in &files {
                offered.insert(pj::text_of(file, "id"), f(now));
            }
        }
        msg.insert("bridged".into(), Value::Object(bridged));
        self.dirty = true;
    }

    /// _bridge_change_out: an edit or deletion out to the links the message went to (a post still waiting is simply
    /// taken back on a deletion).
    fn bridge_change_out(&mut self, cid: &str, mid: &str, delete: bool) {
        let Some(msg) = self.channel_msgs.get(cid).and_then(|l| l.iter().find(|m| pj::text_of(m, "id") == mid)).cloned() else { return };
        if pj::truthy(msg.get("system")) {
            return;
        }
        let (op, kind) = if delete { ("delete", "deletes") } else { ("edit", "edits") };
        let src = as_obj(msg.get("src")).cloned();
        let origin = src.as_ref().and_then(|s| self.br_link(&pj::text_of(s, "link")));
        let sender = if src.is_some() { None } else { Some(pj::s(&msg, "from")) };
        let (by, org) = match &src {
            Some(s) => (format!("ext:{}:{}", pj::text_of(s, "platform"), pj::text_of(s, "user")), as_obj(s.get("org")).map(|o| pj::text_of(o, "id")).unwrap_or_default()),
            None => {
                let sender = sender.clone().unwrap_or_default();
                let org = self.bridge_org_of(&sender).0;
                (sender, org)
            }
        };
        let bridged = as_obj(msg.get("bridged")).cloned().unwrap_or_default();
        for (lid, entry) in bridged {
            let Some(link) = self.br_link(&lid) else { continue };
            let live = entry.as_object().map(|e| matches!(e.get("state").and_then(Value::as_str), Some("queued" | "sent"))).unwrap_or(false);
            if pj::text_of(&link, "state") != "active" || !live {
                continue;
            }
            if delete && self.bridge_unqueue(&lid, mid) {
                continue;
            }
            let reason = self.bridge_out_reason(cid, &link, &[kind], sender.as_deref(), origin.as_ref(), 0);
            if !reason.is_empty() {
                self.bridge_audit(Some(&link), "out", op, kind, &by, &org, "blocked", &reason);
                continue;
            }
            let mut fields = obj([("msg", Value::from(mid))]);
            if !delete {
                fields.insert("text".into(), Value::from(pj::s(&msg, "text")));
            }
            self.bridge_queue(&lid, op, fields, Some(mid), &by, &org);
        }
    }

    /// _bridge_react_out: a reaction out to every other active link the message crossed (or came from).
    #[allow(clippy::too_many_arguments)]
    fn bridge_react_out(&mut self, cid: &str, mid: &str, emoji: &str, on: bool, by_name: &str, by: &str, org: &str, sender: Option<&str>, origin: Option<&Obj>) {
        let Some(msg) = self.channel_msgs.get(cid).and_then(|l| l.iter().find(|m| pj::text_of(m, "id") == mid)).cloned() else { return };
        if pj::truthy(msg.get("system")) {
            return;
        }
        let src_link = as_obj(msg.get("src")).map(|s| pj::text_of(s, "link"));
        let bridged = as_obj(msg.get("bridged")).cloned().unwrap_or_default();
        let origin_id = origin.map(|o| pj::text_of(o, "id"));
        for link in self.bridge_active(cid) {
            let lid = pj::text_of(&link, "id");
            if origin_id.as_deref() == Some(lid.as_str()) {
                continue;
            }
            let queued = bridged.get(&lid).and_then(Value::as_object).map(|e| matches!(e.get("state").and_then(Value::as_str), Some("queued" | "sent"))).unwrap_or(false);
            if src_link.as_deref() != Some(lid.as_str()) && !queued {
                continue;
            }
            let reason = self.bridge_out_reason(cid, &link, &["reactions"], sender, origin, 0);
            if !reason.is_empty() {
                self.bridge_audit(Some(&link), "out", "react", "reactions", by, org, "blocked", &reason);
                continue;
            }
            let fields = obj([("msg", Value::from(mid)), ("emoji", Value::from(emoji)), ("on", Value::Bool(on)), ("by_name", Value::from(hide(by_name)))]);
            self.bridge_queue(&lid, "react", fields, Some(mid), by, org);
        }
    }

    /// _bridge_calls: a `call` op (a fresh guest link each) to every active link calls may cross; 409 when one may and
    /// the relay takes no guests. Answers how many.
    #[allow(clippy::too_many_arguments)]
    fn bridge_calls(&mut self, cid: &str, by_name: &str, by: &str, org: &str, sender: Option<&str>, origin: Option<&Obj>) -> R<usize> {
        let origin_id = origin.map(|o| pj::text_of(o, "id"));
        let mut allowed: Vec<String> = Vec::new();
        for link in self.bridge_active(cid) {
            let lid = pj::text_of(&link, "id");
            if origin_id.as_deref() == Some(lid.as_str()) {
                continue;
            }
            let reason = self.bridge_out_reason(cid, &link, &["calls"], sender, origin, 0);
            if reason.is_empty() {
                allowed.push(lid);
            } else {
                self.bridge_audit(Some(&link), "out", "call", "calls", by, org, "blocked", &reason);
            }
        }
        if !allowed.is_empty() && !self.guests_on() {
            return Err(E::Conflict(GUESTS_OFF.into()));
        }
        let title = match self.channel(cid) {
            Some(ch) if !pj::s(ch, "name").is_empty() => format!("#{}", pj::s(ch, "name")),
            Some(ch) if !pj::s(ch, "topic").is_empty() => pj::s(ch, "topic"),
            _ => "Group chat".to_string(),
        };
        for lid in &allowed {
            let expires = (pj::now() + CALL_MINUTES * 60.0) as i64;
            let link_url = self.guests_url(&room(cid), expires);
            let fields = obj([("url", Value::from(link_url)), ("by_name", Value::from(hide(by_name))), ("title", Value::from(title.clone()))]);
            self.bridge_queue(lid, "call", fields, None, by, org);
        }
        Ok(allowed.len())
    }

    // ── hooks the hub calls ──────────────────────────────────────────────────────────────────────────────────

    /// chan_posted: a member's new message (channel_post, a file), before anyone hears it: out to the active links,
    /// `bridged` set on it.
    pub(super) fn bridge_chan_posted(&mut self, cid: &str, msg: &mut Obj) {
        if pj::truthy(msg.get("src")) || pj::truthy(msg.get("system")) || self.bridge_active(cid).is_empty() {
            return;
        }
        let sender = pj::s(msg, "from");
        let org = self.bridge_org_of(&sender).0;
        self.bridge_send_post(cid, msg, &sender, &org, None);
    }

    /// chan_changed: a member edited or deleted a channel message.
    pub(super) fn bridge_chan_changed(&mut self, cid: &str, mid: &str, delete: bool) {
        self.bridge_change_out(cid, mid, delete);
    }

    /// chan_reacted: a member reacted in a channel.
    pub(super) fn bridge_chan_reacted(&mut self, cid: &str, mid: &str, emoji: &str, who: &Identity, on: bool) {
        let org = self.bridge_org_of(&who.principal).0;
        self.bridge_react_out(cid, mid, emoji, on, &who.name, &who.principal, &org, Some(who.principal.as_str()), None);
    }

    /// chan_view: the channel view's `links`.
    pub(super) fn bridge_chan_view(&self, cid: &str, view: &mut Obj) {
        let links = self.bridge_links_in(cid);
        if !links.is_empty() {
            view.insert("links".into(), Value::Array(links.iter().map(|l| Value::Object(member_view(l))).collect()));
        }
    }

    fn bridge_expire_codes(&mut self, now: f64) {
        let codes = self.br_part("codes").clone();
        let gone: Vec<String> = codes
            .iter()
            .filter(|(_, r)| r.as_object().map(|r| pj::num(r, "expires") <= now || !self.channels.contains_key(&pj::text_of(r, "channel"))).unwrap_or(true))
            .map(|(k, _)| k.clone())
            .collect();
        if !gone.is_empty() {
            let codes = self.br_part("codes");
            for c in gone {
                codes.shift_remove(&c);
            }
            self.dirty = true;
        }
    }

    /// _bridge_prune: expired codes, outbox limits, off links with nothing left to deliver (after OFF_KEEP), and ids of
    /// messages or files no longer kept.
    pub(super) fn bridge_prune(&mut self, now: f64) {
        self.bridge_expire_codes(now);
        let ids: Vec<String> = self.br_part("links").keys().cloned().collect();
        for lid in ids {
            if self.br_part("outbox").contains_key(&lid) {
                self.bridge_trim(&lid, now);
                if self.br_part("outbox").get(&lid).and_then(Value::as_array).map(Vec::is_empty).unwrap_or(true) {
                    self.br_part("outbox").shift_remove(&lid);
                }
            }
            let Some(link) = self.br_link(&lid) else { continue };
            let since = if pj::truthy(link.get("off_ts")) { pj::num(&link, "off_ts") } else { pj::num(&link, "ts") };
            if pj::text_of(&link, "state") == "off" && !self.br_part("outbox").contains_key(&lid) && now - since > OFF_KEEP {
                self.br_part("links").shift_remove(&lid);
                self.br_part("map").shift_remove(&lid);
                self.br_part("offered").shift_remove(&lid);
                self.dirty = true;
            }
        }
        let map_ids: Vec<String> = self.br_part("map").keys().cloned().collect();
        for lid in map_ids {
            let Some(link) = self.br_link(&lid) else {
                self.br_part("map").shift_remove(&lid);
                continue;
            };
            let kept: HashSet<String> = self.channel_msgs.get(&pj::text_of(&link, "channel")).into_iter().flatten().map(|m| pj::py_str(m.get("id").unwrap_or(&Value::Null))).collect();
            let mp = obj_mut(self.br_part("map"), &lid);
            obj_mut(mp, "ext").retain(|_, mid| mid.as_str().map(|x| kept.contains(x)).unwrap_or(false));
            obj_mut(mp, "msg").retain(|mid, _| kept.contains(mid));
        }
        let files: HashSet<String> = self.files_kept_ids().into_iter().collect();
        let links: HashSet<String> = self.br_part("links").keys().cloned().collect();
        let offered = self.br_part("offered");
        for v in offered.values_mut() {
            if let Some(o) = v.as_object_mut() {
                o.retain(|fid, _| files.contains(fid));
            }
        }
        offered.retain(|lid, v| links.contains(lid) && v.as_object().map(|o| !o.is_empty()).unwrap_or(false));
    }

    // ── audit ────────────────────────────────────────────────────────────────────────────────────────────────

    /// _bridge_audit: one audit row (never any text): `{ts, link, channel, dir, op, kind, by, org, result, reason}`,
    /// appended to state_dir/bridge-audit.jsonl.
    #[allow(clippy::too_many_arguments)]
    fn bridge_audit(&mut self, link: Option<&Obj>, dir: &str, op: &str, kind: &str, by: &str, org: &str, result: &str, reason: &str) {
        let row = obj([
            ("ts", f((pj::now() * 1000.0).round() / 1000.0)),
            ("link", Value::from(link.map(|l| pj::text_of(l, "id")).unwrap_or_default())),
            ("channel", Value::from(link.map(|l| pj::text_of(l, "channel")).unwrap_or_default())),
            ("dir", Value::from(dir)),
            ("op", Value::from(op)),
            ("kind", Value::from(kind)),
            ("by", Value::from(by)),
            ("org", Value::from(org)),
            ("result", Value::from(result)),
            ("reason", Value::from(reason)),
        ]);
        let Some(folder) = self.bridge.state_dir.clone() else {
            self.bridge.rows.push_back(row);
            if self.bridge.rows.len() > AUDIT_MEMORY {
                self.bridge.rows.pop_front();
                self.bridge.rows_gone += 1;
            }
            return;
        };
        let written = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(&folder)?;
            let mut opts = std::fs::OpenOptions::new();
            opts.append(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut fh = opts.open(folder.join(AUDIT_FILE))?;
            fh.write_all(format!("{}\n", pj::dumps(&Value::Object(row))).as_bytes())
        })();
        if let Err(e) = written {
            log_warn(&format!("bridge audit not written: {e}"));
        }
    }

    // ── connector checks ─────────────────────────────────────────────────────────────────────────────────────

    /// _bridge_c_enter: every connector route: a connector certificate with an organization, at most RATE requests a
    /// second (429). Answers its org.
    fn bridge_c_enter(&mut self, who: &Identity) -> R<Obj> {
        if !who.connector {
            return forbidden(CONNECTORS_ONLY);
        }
        let Value::Object(org) = self.org(&who.principal) else { return forbidden(NO_ORG) };
        let mono = pj::mono();
        let hits = self.bridge.hits.entry(who.principal.clone()).or_default();
        while hits.front().is_some_and(|t| mono - t >= 1.0) {
            hits.pop_front();
        }
        if hits.len() >= RATE {
            return Err(E::Busy(BUSY.into(), 1));
        }
        hits.push_back(mono);
        self.br();
        Ok(org)
    }

    /// _bridge_c_link: the calling connector's link: 403 for anyone else's (or no) link; `active`: 409 when it is off
    /// (or its conversation is archived).
    fn bridge_c_link(&mut self, who: &Identity, lid: Body, active: bool) -> R<Obj> {
        let lid = pj::str_or(lid);
        let Some(link) = self.br_link(&lid).filter(|l| pj::text_of(l, "connector") == who.principal) else { return forbidden(NOT_YOURS) };
        if !active {
            return Ok(link);
        }
        let cid = pj::text_of(&link, "channel");
        if self.channel(&cid).is_none() {
            let org = as_obj(link.get("org")).map(|o| pj::text_of(o, "id")).unwrap_or_default();
            self.bridge_off(&lid, "the conversation is no longer kept", &who.principal, &org, "failed");
        }
        let link = self.br_link(&lid).unwrap_or(link);
        if pj::text_of(&link, "state") != "active" {
            return Err(E::Conflict(format!("this link is off: {}", pj::text_of(&link, "reason"))));
        }
        if self.channel(&cid).map(|c| pj::truthy(c.get("archived"))).unwrap_or(false) {
            return Err(E::Conflict("this conversation is archived".into()));
        }
        Ok(link)
    }

    /// _bridge_allow: content of `kind` from the link: in the effective `receive`, else 403 with whose policy refused
    /// it (and a link no longer allowed at all goes off: 409).
    fn bridge_allow(&mut self, link: &Obj, cid: &str, kind: &str, by: &str) -> R<()> {
        let eff = self.bridge_effective(link);
        let lid = pj::text_of(link, "id");
        let org = as_obj(link.get("org")).map(|o| pj::text_of(o, "id")).unwrap_or_default();
        if !eff.enabled {
            self.bridge_off(&lid, &eff.reason, by, &org, "blocked");
            return Err(E::Conflict(format!("this link is off: {}", eff.reason)));
        }
        if eff.receive.iter().any(|k| k == kind) {
            return Ok(());
        }
        let mut reason = format!("this link does not carry {}", noun(kind));
        let mut member = false;
        for (oid, label) in self.bridge_member_orgs(cid) {
            if !has(&self.bridge_policy_of(&oid), "receive", kind) {
                reason = cap(&whose(&oid, &label));
                member = true;
                break;
            }
        }
        if !member && !has(&self.bridge_declared(&pj::text_of(link, "connector")), "send", kind) {
            reason = format!("{}'s policy", as_obj(link.get("org")).map(|o| pj::text_of(o, "label")).unwrap_or_default());
        }
        let op = match kind {
            "text" => "post",
            "edits" => "edit",
            "deletes" => "delete",
            "reactions" => "react",
            "files" => "file",
            _ => "call",
        };
        self.bridge_audit(Some(link), "in", op, kind, by, &org, "blocked", &reason);
        forbidden(reason)
    }

    /// _bridge_from_link: a message this link posted, by its platform id (404 unknown, 403 another's).
    fn bridge_from_link(&self, lid: &str, cid: &str, pid: &str) -> R<usize> {
        let Some(i) = self.bridge_mid(lid, cid, Some(pid)) else { return Err(E::NotFound(GONE.into())) };
        let from_here = as_obj(self.channel_msgs[cid][i].get("src")).map(|s| pj::text_of(s, "link") == lid).unwrap_or(false);
        if !from_here {
            return forbidden(NOT_FROM_LINK);
        }
        Ok(i)
    }

    /// _bridge_member_channel: a channel or group chat the member is in (anything else: 400).
    fn bridge_member_channel(&self, who: &Identity, cid: Body, writing: bool) -> R<String> {
        let cid = pj::str_or(cid);
        if !self.channels.contains_key(&cid) {
            return bad(ONLY_CHANNELS);
        }
        self.member_channel(&cid, &who.principal, writing)
    }

    fn bridge_codes_in(&mut self, cid: &str) -> usize {
        self.br_part("codes").values().filter(|r| r.as_object().map(|r| pj::text_of(r, "channel") == cid).unwrap_or(false)).count()
    }
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────────────

impl Hub {
    /// `POST /v1/bridge/code {channel, platform}` -> `{code, expires}`: a member whose org's policy is on gets a
    /// single-use code for 15 minutes (5 open per conversation).
    pub fn bridge_code(&self, session: &str, who: &Identity, channel: Body, platform_v: Body) -> R<Obj> {
        let platform = platform(platform_v)?;
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            st.session(session, who)?;
            let cid = st.bridge_member_channel(who, channel, true)?;
            let oid = st.bridge_org_of(&who.principal).0;
            if !on(&st.bridge_policy_of(&oid)) {
                return forbidden("your organization's policy does not allow bridging");
            }
            if st.bridge_active(&cid).len() >= LINKS_MAX {
                return Err(E::Conflict(format!("a conversation has at most {LINKS_MAX} links")));
            }
            let now = pj::now();
            st.bridge_expire_codes(now);
            if st.bridge_codes_in(&cid) >= CODES_MAX {
                return Err(E::Conflict(format!("this conversation has {CODES_MAX} open codes; wait for one to expire")));
            }
            let mut code = new_code();
            while st.br_part("codes").contains_key(&code) {
                code = new_code();
            }
            let expires = now + CODE_TTL;
            let row = obj([("channel", Value::from(cid.clone())), ("platform", Value::from(platform.clone())), ("by", Value::from(who.principal.clone())), ("expires", f(expires))]);
            st.br_part("codes").insert(code.clone(), Value::Object(row));
            st.dirty = true;
            Ok((obj([("code", Value::from(code)), ("expires", f(expires))]), cid))
        })();
        drop(st);
        let (out, cid) = r?;
        log_info(&format!("bridge_code channel={cid} platform={platform} principal={}", who.principal));
        Ok(out)
    }

    /// `GET /v1/bridge/links?channel=` (members): `{links, codes}`.
    pub fn bridge_links(&self, session: &str, who: &Identity, channel: &str) -> R<Obj> {
        let mut st = self.st.lock();
        st.session(session, who)?;
        let cid = st.bridge_member_channel(who, Some(&Value::from(channel)), false)?;
        st.bridge_expire_codes(pj::now());
        let links: Vec<Value> = st.bridge_links_in(&cid).iter().map(|l| Value::Object(member_view(l))).collect();
        let codes = st.bridge_codes_in(&cid);
        Ok(obj([("links", Value::Array(links)), ("codes", Value::from(codes))]))
    }

    /// `POST /v1/bridge/unlink {link}`: a member of the conversation or a relay admin turns the link off. Answers
    /// `{link}` as the channel view shows it.
    pub fn bridge_unlink(&self, session: &str, who: &Identity, link: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.session(session, who)?;
            let lid = pj::str_or(link);
            let Some(found) = st.br_link(&lid) else { return Err(E::NotFound(NO_LINK.into())) };
            if !st.admins.contains(&who.principal) {
                st.member_channel(&pj::text_of(&found, "channel"), &who.principal, false)?;
            }
            let org = st.bridge_org_of(&who.principal).0;
            st.bridge_off(&lid, &format!("Unlinked by {}", who.name), &who.principal, &org, "sent");
            let found = st.br_link(&lid).unwrap_or(found);
            Ok(obj([("link", Value::Object(member_view(&found)))]))
        })();
        drop(st);
        self.wake();
        r
    }

    /// `POST /v1/bridge/call {channel}` -> `{links: n}`: a join link to the conversation's call posted to every active
    /// link that allows calls.
    pub fn bridge_call(&self, session: &str, who: &Identity, channel: Body) -> R<Obj> {
        let mut st = self.st.lock();
        let r = (|| -> R<(usize, String)> {
            st.session(session, who)?;
            let cid = st.bridge_member_channel(who, channel, true)?;
            let org = st.bridge_org_of(&who.principal).0;
            let n = st.bridge_calls(&cid, &who.name, &who.principal, &org, Some(who.principal.as_str()), None)?;
            Ok((n, cid))
        })();
        drop(st);
        self.wake();
        let (n, cid) = r?;
        log_info(&format!("bridge_call channel={cid} principal={} links={n}", who.principal));
        Ok(obj([("links", Value::from(n))]))
    }

    /// `GET /v1/admin/bridge` (relay admins): `{policies: {org: policy}, orgs}`, the policies in force (relay.json,
    /// admins' edits over it) for every known org.
    pub fn bridge_admin(&self, session: &str, who: &Identity) -> R<Obj> {
        let mut st = self.st.lock();
        st.check_admin(session, who)?;
        let orgs = st.bridge_orgs();
        let mut ids: Vec<String> = orgs.iter().filter_map(Value::as_object).map(|o| pj::text_of(o, "id")).collect();
        ids.extend(st.bridge.base.keys().cloned());
        ids.extend(st.br_part("policies").keys().cloned());
        ids.sort();
        ids.dedup();
        let mut policies = Obj::new();
        for oid in ids {
            let p = st.bridge_policy_of(&oid);
            policies.insert(oid, Value::Object(p));
        }
        Ok(obj([("policies", Value::Object(policies)), ("orgs", Value::Array(orgs))]))
    }

    /// `POST /v1/admin/bridge {org, policy}` (relay admins): one org's policy, checked and kept in state.json over
    /// relay.json (`policy: null` goes back to relay.json). Every link is re-evaluated at once.
    pub fn bridge_admin_set(&self, session: &str, who: &Identity, org: Body, policy_v: Body) -> R<Obj> {
        let oid = field(org, "org", m::ORG_FIELD_MAX)?;
        let checked = match policy_v {
            None | Some(Value::Null) => None,
            Some(p) => Some(policy(p).map_err(E::Bad)?),
        };
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.check_admin(session, who)?;
            match &checked {
                None => {
                    st.br_part("policies").shift_remove(&oid);
                }
                Some(p) => {
                    st.br_part("policies").insert(oid.clone(), Value::Object(p.clone()));
                }
            }
            st.dirty = true;
            st.bridge_audit(None, "out", "policy", "", &who.principal, &oid, "sent", "");
            st.bridge_recheck(&who.principal, None, None);
            let p = st.bridge_policy_of(&oid);
            Ok(obj([("org", Value::from(oid.clone())), ("policy", Value::Object(p))]))
        })();
        drop(st);
        self.wake();
        let out = r?;
        let enabled = out.get("policy").and_then(Value::as_object).map(on).unwrap_or(false);
        log_info(&format!("bridge_policy org={} by={} enabled={}", kv(&oid), who.principal, if enabled { "True" } else { "False" }));
        Ok(out)
    }

    /// `GET /v1/admin/bridge/audit?after=&limit=` (relay admins): `{rows, next}`; `after` and `next` count rows from
    /// the start of the log.
    pub fn bridge_audit(&self, session: &str, who: &Identity, after: &str, limit: &str) -> R<Obj> {
        let after = if after.is_empty() { 0.0 } else { m::number(Some(&Value::from(after)), "after")? }.trunc().max(0.0) as usize;
        let limit = if limit.is_empty() { AUDIT_LIMIT as f64 } else { m::number(Some(&Value::from(limit)), "limit")? }.trunc() as i64;
        let limit = limit.min(AUDIT_MAX).max(1) as usize;
        let st = self.st.lock();
        st.check_admin(session, who)?;
        let Some(folder) = st.bridge.state_dir.clone() else {
            let start = after.saturating_sub(st.bridge.rows_gone);
            let rows: Vec<Value> = st.bridge.rows.iter().skip(start).take(limit).cloned().map(Value::Object).collect();
            let next = st.bridge.rows_gone + start + rows.len();
            return Ok(obj([("rows", Value::Array(rows)), ("next", Value::from(next))]));
        };
        let mut rows: Vec<Value> = Vec::new();
        let mut next = after;
        if let Ok(text) = std::fs::read_to_string(folder.join(AUDIT_FILE)) {
            for (i, line) in text.lines().enumerate() {
                if i < after {
                    continue;
                }
                if rows.len() >= limit {
                    break;
                }
                next = i + 1;
                if let Ok(row @ Value::Object(_)) = serde_json::from_str::<Value>(line) {
                    rows.push(row);
                }
            }
        }
        Ok(obj([("rows", Value::Array(rows)), ("next", Value::from(next))]))
    }

    // ── connector routes (connector certificates, no session) ────────────────────────────────────────────────

    /// `POST /v1/bridge/c/hello {platform, policy, version}` -> `{org, relay_orgs, links}`: the connector's declared
    /// policy is kept and its links re-evaluated.
    pub fn bridge_c_hello(&self, who: &Identity, platform_v: Body, policy_v: Body, version: Body) -> R<Obj> {
        let platform = platform(platform_v)?;
        let declared = policy(policy_v.unwrap_or(&Value::Null)).map_err(E::Bad)?;
        let version = match version {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) if s.is_empty() => String::new(),
            v => field(v, "version", 40)?,
        };
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let org = st.bridge_c_enter(who)?;
            let row = obj([("platform", Value::from(platform.clone())), ("policy", Value::Object(declared.clone())), ("version", Value::from(version.clone())), ("ts", f(pj::now()))]);
            st.br_part("connectors").insert(who.principal.clone(), Value::Object(row));
            st.dirty = true;
            st.bridge_recheck(&who.principal, None, Some(&who.principal));
            let links: Vec<Value> = st.br_part("links").values().filter_map(Value::as_object).filter(|l| pj::text_of(l, "connector") == who.principal && pj::text_of(l, "state") == "active").map(|l| Value::Object(c_view(l))).collect();
            Ok(obj([("org", Value::Object(org)), ("relay_orgs", Value::Array(st.bridge_orgs())), ("links", Value::Array(links))]))
        })();
        drop(st);
        self.wake();
        let out = r?;
        let n = out.get("links").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
        log_info(&format!("bridge_hello principal={} platform={platform} version={} links={n}", who.principal, kv(&version)));
        Ok(out)
    }

    /// `POST /v1/bridge/c/claim {code, platform, target, by_name}` -> the link: the code is used up, the conversation
    /// hears a system line and `bridge_link`.
    pub fn bridge_c_claim(&self, who: &Identity, code: Body, platform_v: Body, target_v: Body, by_name: Body) -> R<Obj> {
        let platform = platform(platform_v)?;
        let target = target(target_v)?;
        let by_name = field(by_name, "by_name", NAME_MAX)?;
        let code = pj::str_or(code).trim().to_uppercase();
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String)> {
            let org = st.bridge_c_enter(who)?;
            let (oid, olabel) = (pj::text_of(&org, "id"), pj::text_of(&org, "label"));
            let now = pj::now();
            st.bridge_expire_codes(now);
            let row = st.br_part("codes").get(&code).and_then(Value::as_object).cloned();
            let Some(row) = row.filter(|r| pj::text_of(r, "platform") == platform) else { return Err(E::NotFound(BAD_CODE.into())) };
            let cid = pj::text_of(&row, "channel");
            if st.channel(&cid).map(|c| pj::truthy(c.get("archived"))).unwrap_or(true) {
                return Err(E::NotFound(BAD_CODE.into()));
            }
            let declared = st.br_part("connectors").get(&who.principal).and_then(Value::as_object).map(|r| pj::text_of(r, "platform"));
            if declared.is_some_and(|p| p != platform) {
                return bad("this connector said hello for another platform");
            }
            let active = st.bridge_active(&cid);
            if active.len() >= LINKS_MAX {
                return Err(E::Conflict(format!("a conversation has at most {LINKS_MAX} links")));
            }
            let tid = pj::text_of(&target, "id");
            if active.iter().any(|l| pj::text_of(l, "connector") == who.principal && as_obj(l.get("target")).map(|t| pj::text_of(t, "id")) == Some(tid.clone())) {
                return Err(E::Conflict("this conversation is already linked there".into()));
            }
            let lid = pj::token_hex(8);
            let label = pj::text_of(&target, "label");
            let mut link = obj([
                ("id", Value::from(lid.clone())),
                ("channel", Value::from(cid.clone())),
                ("platform", Value::from(platform.clone())),
                ("connector", Value::from(who.principal.clone())),
                ("org", Value::Object(org.clone())),
                ("target", Value::Object(target.clone())),
                ("state", Value::from("active")),
                ("reason", Value::from("")),
                ("by", row.get("by").cloned().unwrap_or(Value::from(""))),
                ("claimed_by", Value::from(by_name.clone())),
                ("ts", f(now)),
                ("send", Value::Array(Vec::new())),
                ("receive", Value::Array(Vec::new())),
                ("notice", Value::from("")),
            ]);
            let eff = st.bridge_effective(&link);
            if !eff.enabled {
                st.bridge_audit(Some(&link), "in", "link", "", &who.principal, &oid, "blocked", &eff.reason);
                return forbidden(eff.reason);
            }
            link.insert("send".into(), strings_value(&eff.send));
            link.insert("receive".into(), strings_value(&eff.receive));
            link.insert("notice".into(), Value::from(eff.notice));
            st.br_part("codes").shift_remove(&code);
            st.br_part("links").insert(lid.clone(), Value::Object(link.clone()));
            st.dirty = true;
            st.bridge_system(&cid, &format!("Linked to {label} ({}, {olabel}) by {by_name}", platform_name(&platform)), Obj::new());
            st.bridge_tell_link(&lid);
            st.bridge_audit(Some(&link), "in", "link", "", &who.principal, &oid, "sent", "");
            Ok((c_view(&link), cid))
        })();
        drop(st);
        self.wake();
        let (out, cid) = r?;
        log_info(&format!("bridge_link link={} channel={cid} platform={platform} connector={}", pj::text_of(&out, "id"), who.principal));
        Ok(out)
    }

    /// `POST /v1/bridge/c/unlink {link, by_name}`: as the member route, from the platform.
    pub fn bridge_c_unlink(&self, who: &Identity, link: Body, by_name: Body) -> R<Obj> {
        let by_name = field(by_name, "by_name", NAME_MAX)?;
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            let org = st.bridge_c_enter(who)?;
            let found = st.bridge_c_link(who, link, false)?;
            let lid = pj::text_of(&found, "id");
            st.bridge_off(&lid, &format!("Unlinked by {by_name}"), &who.principal, &pj::text_of(&org, "id"), "sent");
            let found = st.br_link(&lid).unwrap_or(found);
            Ok(obj([("link", Value::Object(c_view(&found)))]))
        })();
        drop(st);
        self.wake();
        r
    }

    /// `GET /v1/bridge/c/outbox?after=&wait=` -> `{ops, seq}`: the ops of every link of this connector (an off link's
    /// `unlinked` too), waiting up to `wait` seconds.
    pub fn bridge_c_outbox(&self, who: &Identity, after: &str, wait: &str) -> R<Obj> {
        let after = m::py_int(if after.is_empty() { "0" } else { after }).map_err(|_| E::Bad("after must be an op number".into()))?;
        let wait = if wait.is_empty() { 0.0 } else { m::number(Some(&Value::from(wait)), "wait")? }.clamp(0.0, WAIT_MAX);
        let deadline = pj::mono() + wait;
        let mut st = self.st.lock();
        st.bridge_c_enter(who)?;
        let ready = loop {
            let ready = st.bridge_ready(&who.principal, after, pj::now());
            let left = deadline - pj::mono();
            if !ready.is_empty() || left <= 0.0 {
                break ready;
            }
            self.cond.wait_for(&mut st, Duration::from_secs_f64(left));
        };
        st.bridge_sent(&ready, pj::now());
        drop(st);
        let seq = ready.iter().map(|r| r.1).fold(after, i64::max);
        let ops: Vec<Value> = ready.into_iter().map(|(_, _, view)| Value::Object(view)).collect();
        Ok(obj([("ops", Value::Array(ops)), ("seq", Value::from(seq))]))
    }

    /// `POST /v1/bridge/c/ack {link, seq, ok, ext, reason, state}`: the op is done. A post's `ext` (its platform id) is
    /// kept for threads, replies, edits, deletes and reactions; `ok: false` marks the message `blocked` (`state:
    /// "blocked"`, the connector's policy) or `failed` with the reason. Acking an op again is harmless.
    #[allow(clippy::too_many_arguments)]
    pub fn bridge_c_ack(&self, who: &Identity, link: Body, seq: Body, ok: Body, ext: Body, reason: Body, state: Body) -> R<Obj> {
        let Some(seq) = pj::as_int(seq) else { return bad("seq must be the op's number") };
        let Some(Value::Bool(ok)) = ok else { return bad("ok must be true or false") };
        let ok = *ok;
        let ext = match ext {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) if s.is_empty() => String::new(),
            v => field(v, "ext", FIELD_MAX)?,
        };
        let mut reason = m::reason(reason);
        let blocked = match state {
            None | Some(Value::Null) => false,
            Some(Value::String(s)) if s.is_empty() || s == "failed" => false,
            Some(Value::String(s)) if s == "blocked" => true,
            _ => return bad("state must be \"blocked\" or \"failed\""),
        };
        let answer = obj([("ok", Value::Bool(true)), ("seq", Value::from(seq))]);
        let mut st = self.st.lock();
        let r = (|| -> R<()> {
            st.bridge_c_enter(who)?;
            let found = st.bridge_c_link(who, link, false)?;
            let lid = pj::text_of(&found, "id");
            let Some(Value::Array(ops)) = st.br_part("outbox").get_mut(&lid) else { return Ok(()) };
            let Some(at) = ops.iter().position(|o| pj::as_int(o.get("seq")) == Some(seq)) else { return Ok(()) };
            let op = ops.remove(at).as_object().cloned().unwrap_or_default();
            if ops.is_empty() {
                st.br_part("outbox").shift_remove(&lid);
            }
            st.dirty = true;
            let result = if ok {
                "sent"
            } else if blocked {
                "blocked"
            } else {
                "failed"
            };
            if !ok && reason.is_empty() {
                reason = format!("{} did not take it", platform_name(&pj::text_of(&found, "platform")));
            }
            let why = if ok { "" } else { reason.as_str() };
            let name = pj::text_of(&op, "op");
            if name == "post" {
                let mid = pj::text_of(&op, "msg");
                if ok && !ext.is_empty() {
                    st.bridge_remember(&lid, &mid, &ext);
                }
                st.bridge_mark(&pj::text_of(&found, "channel"), &mid, &lid, result, why, &ext);
            }
            if !op_kind_of(&name).is_empty() {
                let by = Some(pj::s(&op, "_by")).filter(|b| !b.is_empty()).unwrap_or_else(|| "relay".into());
                st.bridge_audit(Some(&found), "out", &name, op_kind(&op), &by, &pj::s(&op, "_org"), result, why);
            }
            Ok(())
        })();
        drop(st);
        self.wake(); // a held op may be ready now
        r?;
        Ok(answer)
    }

    /// `POST /v1/bridge/c/post`: a bridged message (kind `text`, plus `files`). `thread` and `reply_to` are platform
    /// ids (unknown ones: top level). A repeat of `(link, msg)` answers the first message. Answers `{id, ts, repeat}`.
    #[allow(clippy::too_many_arguments)]
    pub fn bridge_c_post(&self, who: &Identity, link: Body, user_v: Body, msg_v: Body, text: Body, thread: Body, reply_to: Body, url_v: Body, files_v: Body) -> R<Obj> {
        let pid = field(msg_v, "msg", FIELD_MAX)?;
        let (uid, uname) = user(user_v)?;
        let text = pj::str_or(text).trim().to_string();
        if pj::char_len(&text) > m::TEXT_MAX {
            return bad(format!("messages are limited to {} characters", m::TEXT_MAX));
        }
        let files: Vec<String> = match files_v {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) if a.len() <= FILES_PER_POST && a.iter().all(Value::is_string) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            _ => return bad(format!("files must be a list of at most {FILES_PER_POST} file ids")),
        };
        if text.is_empty() && files.is_empty() {
            return bad("nothing to send");
        }
        let thread = optional(thread, "thread")?;
        let reply_to = optional(reply_to, "reply_to")?;
        let link_url = url(url_v);
        let mut st = self.st.lock();
        let r = (|| -> R<(Obj, String, usize)> {
            st.bridge_c_enter(who)?;
            let found = st.bridge_c_link(who, link, true)?;
            let (lid, cid) = (pj::text_of(&found, "id"), pj::text_of(&found, "channel"));
            if let Some(i) = st.bridge_mid(&lid, &cid, Some(&pid)) {
                let first = &st.channel_msgs[&cid][i];
                return Ok((obj([("id", first.get("id").cloned().unwrap_or(Value::Null)), ("ts", first.get("ts").cloned().unwrap_or(Value::Null)), ("repeat", Value::Bool(true))]), lid, 0));
            }
            let platform = pj::text_of(&found, "platform");
            let org = as_obj(found.get("org")).cloned().unwrap_or_default();
            let oid = pj::text_of(&org, "id");
            let by = format!("ext:{platform}:{uid}");
            st.bridge_allow(&found, &cid, "text", &by)?;
            if !files.is_empty() {
                st.bridge_allow(&found, &cid, "files", &by)?;
            }
            let mut unique: Vec<String> = Vec::new();
            for fid in &files {
                if !unique.contains(fid) {
                    unique.push(fid.clone());
                }
            }
            for fid in &unique {
                st.files_bridge_ready(fid, &lid)?;
            }
            let now = pj::now().max(st.last_ts(&cid) + 1e-6);
            let mid = pj::token_hex(8);
            let src = obj([
                ("platform", Value::from(platform.clone())),
                ("link", Value::from(lid.clone())),
                ("user", Value::from(uid.clone())),
                ("name", Value::from(uname.clone())),
                ("org", Value::Object(org.clone())),
                ("msg", Value::from(pid.clone())),
                ("url", Value::from(link_url.clone())),
            ]);
            let mut msg = obj([
                ("id", Value::from(mid.clone())),
                ("channel", Value::from(cid.clone())),
                ("from", Value::from(who.principal.clone())),
                ("from_name", Value::from(uname.clone())),
                ("from_org", Value::Object(org.clone())),
                ("text", Value::from(text.clone())),
                ("ts", f(now)),
                ("reactions", Value::Object(Obj::new())),
                ("src", Value::Object(src)),
            ]);
            if let Some(i) = st.bridge_mid(&lid, &cid, thread.as_deref()) {
                msg.insert("thread".into(), Value::from(channels::thread_id(&st.channel_msgs[&cid][i])));
            }
            if let Some(i) = st.bridge_mid(&lid, &cid, reply_to.as_deref()) {
                let quoted = &st.channel_msgs[&cid][i];
                if !pj::truthy(quoted.get("deleted")) {
                    let p = preview(quoted, quoted.get("from_name"))?;
                    msg.insert("reply_to".into(), Value::Object(p));
                }
            }
            if !unique.is_empty() {
                let mut kept: Vec<Value> = Vec::new();
                for fid in &unique {
                    kept.push(Value::Object(st.files_bridge_keep(fid, &mid, now, &cid, &uname)?));
                }
                msg.insert("files".into(), Value::Array(kept));
            }
            st.bridge_remember(&lid, &mid, &pid);
            st.bridge_send_post(&cid, &mut msg, &by, &oid, Some(&found));
            let threaded = pj::truthy(msg.get("thread"));
            let msgs = st.channel_msgs.entry(cid.clone()).or_default();
            msgs.push(msg.clone());
            if threaded {
                channels::recount(msgs, &pj::text_of(&msg, "thread"));
            }
            if msgs.len() > channels::CHANNEL_KEEP {
                let cut = msgs.len() - channels::CHANNEL_KEEP;
                msgs.drain(..cut);
            }
            st.channel_mut(&cid).insert("last".into(), f(now));
            st.dirty = true;
            let members = channels::members_of(st.channel(&cid));
            st.tell(&members, &obj([("type", Value::from("channel_message")), ("message", Value::Object(msg))]), None);
            st.bridge_audit(Some(&found), "in", "post", if unique.is_empty() { "text" } else { "files" }, &by, &oid, "sent", "");
            Ok((obj([("id", Value::from(mid)), ("ts", f(now)), ("repeat", Value::Bool(false))]), lid, unique.len()))
        })();
        drop(st);
        self.wake();
        let (out, lid, n) = r?;
        if out.get("repeat") == Some(&Value::Bool(false)) {
            log_info(&format!("bridge_post link={lid} chars={} files={n}", pj::char_len(&text)));
        }
        Ok(out)
    }

    /// `POST /v1/bridge/c/edit {link, msg, text}` (kind `edits`): only a message that came from this link.
    pub fn bridge_c_edit(&self, who: &Identity, link: Body, msg: Body, text: Body) -> R<Obj> {
        let pid = field(msg, "msg", FIELD_MAX)?;
        let text = m::text(text, "messages")?;
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.bridge_c_enter(who)?;
            let found = st.bridge_c_link(who, link, true)?;
            let (lid, cid) = (pj::text_of(&found, "id"), pj::text_of(&found, "channel"));
            let i = st.bridge_from_link(&lid, &cid, &pid)?;
            let target = st.channel_msgs[&cid][i].clone();
            let src_user = as_obj(target.get("src")).map(|s| pj::text_of(s, "user")).unwrap_or_default();
            let by = format!("ext:{}:{src_user}", pj::text_of(&found, "platform"));
            st.bridge_allow(&found, &cid, "edits", &by)?;
            if pj::truthy(target.get("deleted")) {
                return bad("that message was deleted");
            }
            let now = pj::now();
            let mid = pj::text_of(&target, "id");
            let row = &mut st.channel_msgs.get_mut(&cid).expect("the link's channel")[i];
            row.insert("text".into(), Value::from(text.clone()));
            row.insert("edited".into(), f(now));
            st.dirty = true;
            let members = channels::members_of(st.channel(&cid));
            let event = obj([("type", Value::from("chat_update")), ("scope", Value::from("channel")), ("id", Value::from(mid.clone())), ("text", Value::from(text.clone())), ("edited", f(now)), ("by", Value::from(who.principal.clone())), ("channel", Value::from(cid.clone()))]);
            st.tell(&members, &event, None);
            st.bridge_change_out(&cid, &mid, false);
            let oid = as_obj(found.get("org")).map(|o| pj::text_of(o, "id")).unwrap_or_default();
            st.bridge_audit(Some(&found), "in", "edit", "edits", &by, &oid, "sent", "");
            Ok(obj([("id", Value::from(mid)), ("edited", f(now))]))
        })();
        drop(st);
        self.wake();
        r
    }

    /// `POST /v1/bridge/c/delete {link, msg}` (kind `deletes`): only a message that came from this link; it stays a
    /// tombstone like any deleted message.
    pub fn bridge_c_delete(&self, who: &Identity, link: Body, msg: Body) -> R<Obj> {
        let pid = field(msg, "msg", FIELD_MAX)?;
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.bridge_c_enter(who)?;
            let found = st.bridge_c_link(who, link, true)?;
            let (lid, cid) = (pj::text_of(&found, "id"), pj::text_of(&found, "channel"));
            let i = st.bridge_from_link(&lid, &cid, &pid)?;
            let target = st.channel_msgs[&cid][i].clone();
            let src_user = as_obj(target.get("src")).map(|s| pj::text_of(s, "user")).unwrap_or_default();
            let by = format!("ext:{}:{src_user}", pj::text_of(&found, "platform"));
            st.bridge_allow(&found, &cid, "deletes", &by)?;
            let mid = pj::text_of(&target, "id");
            if pj::truthy(target.get("deleted")) {
                return Ok(obj([("id", Value::from(mid)), ("deleted", target.get("deleted").cloned().unwrap_or(Value::Null))]));
            }
            let now = pj::now();
            tombstone(st.channel_msgs.get_mut(&cid).expect("the link's channel"), i, now);
            st.dirty = true;
            let members = channels::members_of(st.channel(&cid));
            let event = obj([("type", Value::from("chat_update")), ("scope", Value::from("channel")), ("id", Value::from(mid.clone())), ("text", Value::from("")), ("deleted", f(now)), ("by", Value::from(who.principal.clone())), ("channel", Value::from(cid.clone()))]);
            st.tell(&members, &event, None);
            st.bridge_change_out(&cid, &mid, true);
            let oid = as_obj(found.get("org")).map(|o| pj::text_of(o, "id")).unwrap_or_default();
            st.bridge_audit(Some(&found), "in", "delete", "deletes", &by, &oid, "sent", "");
            Ok(obj([("id", Value::from(mid)), ("deleted", f(now))]))
        })();
        drop(st);
        self.wake();
        r
    }

    /// `POST /v1/bridge/c/react {link, msg, emoji, on, user}` (kind `reactions`): on any message the link knows (its
    /// own, or a Lucid one it acked), kept as the reaction of `ext:<platform>:<user id>` and shown with the name
    /// (`ext_names`).
    #[allow(clippy::too_many_arguments)]
    pub fn bridge_c_react(&self, who: &Identity, link: Body, msg: Body, emoji: Body, on_v: Body, user_v: Body) -> R<Obj> {
        let pid = field(msg, "msg", FIELD_MAX)?;
        let (uid, uname) = user(user_v)?;
        let emoji = pj::str_or(emoji).trim().to_string();
        if emoji.is_empty() || pj::char_len(&emoji) > EMOJI_MAX {
            return bad(format!("a reaction is one emoji (at most {EMOJI_MAX} characters)"));
        }
        let Some(Value::Bool(on)) = on_v else { return bad("on must be true or false") };
        let on = *on;
        let answer = |id: &str| obj([("id", Value::from(id)), ("emoji", Value::from(emoji.clone())), ("on", Value::Bool(on))]);
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.bridge_c_enter(who)?;
            let found = st.bridge_c_link(who, link, true)?;
            let (lid, cid) = (pj::text_of(&found, "id"), pj::text_of(&found, "channel"));
            let by = format!("ext:{}:{uid}", pj::text_of(&found, "platform"));
            st.bridge_allow(&found, &cid, "reactions", &by)?;
            let Some(i) = st.bridge_mid(&lid, &cid, Some(&pid)) else { return Err(E::NotFound(GONE.into())) };
            let row = &mut st.channel_msgs.get_mut(&cid).expect("the link's channel")[i];
            let mid = pj::text_of(row, "id");
            if pj::truthy(row.get("deleted")) {
                return bad("that message was deleted");
            }
            let reactions = obj_mut(row, "reactions");
            let mut people = strings(reactions.get(&emoji));
            if on == people.contains(&by) {
                return Ok(answer(&mid));
            }
            if on {
                if !reactions.contains_key(&emoji) && reactions.len() >= REACTIONS_MAX {
                    return bad(format!("a message has at most {REACTIONS_MAX} different reactions"));
                }
                people.push(by.clone());
                reactions.insert(emoji.clone(), strings_value(&people));
            } else {
                people.retain(|p| *p != by);
                if people.is_empty() {
                    reactions.shift_remove(&emoji);
                } else {
                    reactions.insert(emoji.clone(), strings_value(&people));
                }
            }
            obj_mut(row, "ext_names").insert(by.clone(), Value::from(uname.clone()));
            st.dirty = true;
            let members = channels::members_of(st.channel(&cid));
            let event = obj([
                ("type", Value::from("react")),
                ("scope", Value::from("channel")),
                ("id", Value::from(mid.clone())),
                ("emoji", Value::from(emoji.clone())),
                ("principal", Value::from(by.clone())),
                ("name", Value::from(uname.clone())),
                ("on", Value::Bool(on)),
                ("channel", Value::from(cid.clone())),
            ]);
            st.tell(&members, &event, None);
            let oid = as_obj(found.get("org")).map(|o| pj::text_of(o, "id")).unwrap_or_default();
            st.bridge_react_out(&cid, &mid, &emoji, on, &uname, &by, &oid, None, Some(&found));
            st.bridge_audit(Some(&found), "in", "react", "reactions", &by, &oid, "sent", "");
            Ok(answer(&mid))
        })();
        drop(st);
        self.wake();
        r
    }

    /// `POST /v1/bridge/c/call {link, by_name}` -> `{links: n}`: "Bob Brown started a call" in the conversation (with
    /// its call room to join) and a `call` op to the conversation's other links.
    pub fn bridge_c_call(&self, who: &Identity, link: Body, by_name: Body) -> R<Obj> {
        let by_name = field(by_name, "by_name", NAME_MAX)?;
        let mut st = self.st.lock();
        let r = (|| -> R<Obj> {
            st.bridge_c_enter(who)?;
            let found = st.bridge_c_link(who, link, true)?;
            let cid = pj::text_of(&found, "channel");
            let by = format!("ext:{}:", pj::text_of(&found, "platform"));
            st.bridge_allow(&found, &cid, "calls", &by)?;
            let oid = as_obj(found.get("org")).map(|o| pj::text_of(o, "id")).unwrap_or_default();
            let n = st.bridge_calls(&cid, &by_name, &by, &oid, None, Some(&found))?;
            st.bridge_system(&cid, &format!("{by_name} started a call"), obj([("call", Value::Object(obj([("room", Value::from(room(&cid)))])))]));
            st.bridge_audit(Some(&found), "in", "call", "calls", &by, &oid, "sent", "");
            Ok(obj([("links", Value::from(n))]))
        })();
        drop(st);
        self.wake();
        r
    }

    /// Before the bytes of `POST /v1/bridge/c/file?link=&name=&mime=` are read (kind `files`): an upload of the files
    /// slice for the link's conversation, at most the effective file_max_mb (413) and within the relay's quota (507).
    /// Answers its id.
    pub fn bridge_c_file_begin(&self, who: &Identity, link: &str, name: &str, mime: &str, length: u64) -> R<String> {
        let (name, kind) = files::files_name_type(Some(&Value::from(name)), Some(&Value::from(mime)))?;
        let mut st = self.st.lock();
        st.bridge_c_enter(who)?;
        let found = st.bridge_c_link(who, Some(&Value::from(link)), true)?;
        let (lid, cid) = (pj::text_of(&found, "id"), pj::text_of(&found, "channel"));
        st.bridge_allow(&found, &cid, "files", &format!("ext:{}:", pj::text_of(&found, "platform")))?;
        let most = st.bridge_effective(&found).file_max_mb.max(0) as u64 * MB;
        st.files_bridge_open(who, &cid, &lid, name, kind, length, most)
    }

    /// The upload's bytes never all came.
    pub fn bridge_c_file_drop(&self, upload: &str) {
        self.st.lock().files_bridge_drop(upload);
    }

    /// `{file: {id, name, size, mime}}` once every byte arrived (for a following post).
    pub fn bridge_c_file_done(&self, upload: &str) -> R<Obj> {
        let out = self.st.lock().files_bridge_done(upload)?;
        let size = out.get("file").and_then(Value::as_object).map(|f| pj::num(f, "size") as u64).unwrap_or(0);
        log_info(&format!("bridge_file upload={upload} size={size}"));
        Ok(out)
    }

    /// `GET /v1/bridge/c/file?link=&id=`: `(file, open file, size)` of a file an op of this link named, while files may
    /// cross it.
    pub fn bridge_c_file_open(&self, who: &Identity, link: &str, id: &str) -> R<(Obj, std::fs::File, u64)> {
        let mut st = self.st.lock();
        st.bridge_c_enter(who)?;
        let found = st.bridge_c_link(who, Some(&Value::from(link)), true)?;
        let (lid, cid) = (pj::text_of(&found, "id"), pj::text_of(&found, "channel"));
        if !st.bridge_effective(&found).send.iter().any(|k| k == "files") {
            return forbidden("files do not cross this link");
        }
        let offered = st.br_part("offered").get(&lid).and_then(Value::as_object).map(|o| o.contains_key(id)).unwrap_or(false);
        if !offered {
            return Err(E::NotFound(FILE_GONE.into()));
        }
        st.files_bridge_open_kept(id, &cid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hub() -> Hub {
        Hub::new(None, &["ann@x".to_string()], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()))
    }

    fn all() -> Value {
        json!(KINDS)
    }

    #[test]
    fn policies_are_checked_and_normalized_as_python_does() {
        let p = policy(&json!({"enabled": true, "send": ["files", "text", "files"], "partners": [" orgb ", "orgb"], "notice": "  Kept  for  audit "})).unwrap();
        assert_eq!(Value::Object(p), json!({"enabled": true, "send": ["text", "files"], "receive": [], "partners": ["orgb"], "file_max_mb": 25, "notice": "Kept for audit"}));
        assert_eq!(Value::Object(policy(&json!({})).unwrap()), Value::Object(off_policy()));
        assert_eq!(policy(&json!({"enabled": true, "x": 1, "a": 2})).unwrap_err(), "unknown bridge policy keys: a, x");
        assert_eq!(policy(&json!({"enabled": 1})).unwrap_err(), "enabled must be true or false");
        assert_eq!(policy(&json!({"partners": ["*", "orga"]})).unwrap_err(), "\"*\" (any organization) must be the only partner");
        assert_eq!(policy(&json!({"partners": [" "]})).unwrap_err(), "partners must be a list of organization ids");
        assert_eq!(policy(&json!({"file_max_mb": 101})).unwrap_err(), "file_max_mb must be a whole number from 1 to 100");
        assert_eq!(policy(&json!({"file_max_mb": 2.0})).unwrap_err(), "file_max_mb must be a whole number from 1 to 100");
        assert_eq!(policy(&json!({"send": ["gifs"]})).unwrap_err(), "send: 'gifs' is not a kind (text, edits, deletes, reactions, files, calls)");
        assert_eq!(policy(&json!({"receive": "text"})).unwrap_err(), "receive must be a list of kinds");
        assert_eq!(policy(&json!([])).unwrap_err(), "a bridge policy must be an object");
        assert!(partner(&policy(&json!({"partners": ["*"]})).unwrap(), "orgz", "orga"));
        assert!(partner(&off_policy(), "orga", "orga"));
        assert!(!partner(&off_policy(), "orgb", "orga"));
    }

    #[test]
    fn the_effective_policy_needs_every_side_and_intersects_kinds() {
        let h = hub();
        let mut st = h.st.lock();
        for (p, org) in [("ann@x", "orga"), ("ben@x", "orga"), ("bridge@b", "orgb")] {
            st.organizations.insert(p.into(), json!({"id": org, "label": format!("Org {}", &org[3..].to_uppercase())}));
        }
        st.channels.insert("c-1".into(), json!({"id": "c-1", "kind": "private", "name": "ops", "members": ["ann@x", "ben@x"]}));
        let mut s = m::Settings::default();
        s.bridge_policies = json!({"orga": {"enabled": true, "send": ["text", "files"], "receive": all(), "partners": ["orgb"], "file_max_mb": 10, "notice": "A"}}).as_object().unwrap().clone();
        st.bridge_configure(&s).unwrap();
        let link = json!({"id": "l1", "channel": "c-1", "connector": "bridge@b", "org": {"id": "orgb", "label": "Org B"}}).as_object().unwrap().clone();
        assert_eq!(st.bridge_effective(&link).reason, "Org B's connector has not said what its policy allows");
        let declared = policy(&json!({"enabled": true, "send": ["text"], "receive": ["text", "reactions"], "partners": ["orga"], "file_max_mb": 50, "notice": "B"})).unwrap();
        st.br_part("connectors").insert("bridge@b".into(), json!({"platform": "slack", "policy": declared, "version": "", "ts": 0.0}));
        let eff = st.bridge_effective(&link);
        assert!(eff.enabled);
        assert_eq!(eff.send, vec!["text"]);
        assert_eq!(eff.receive, vec!["text"]);
        assert_eq!((eff.file_max_mb, eff.notice.as_str()), (10, "A\nB"));
        // a member with no organization: its (absent) policy is off
        st.channels.insert("c-1".into(), json!({"id": "c-1", "kind": "private", "name": "ops", "members": ["ann@x", "cy@x"]}));
        assert_eq!(st.bridge_effective(&link).reason, "The policy for people with no organization does not allow bridging with Org B");
        st.channels.insert("c-1".into(), json!({"id": "c-1", "kind": "private", "name": "ops", "members": ["ann@x"]}));
        assert_eq!(st.bridge_out_reason("c-1", &link, &["reactions"], Some("ann@x"), None, 0), "your organization's policy");
        assert_eq!(st.bridge_out_reason("c-1", &link, &["files"], None, None, 0), "Org B does not accept files");
        assert_eq!(st.bridge_out_reason("c-1", &link, &["text"], Some("ann@x"), None, 0), "");
        // org A turns bridging with org B off
        st.br_part("policies").insert("orga".into(), json!({"enabled": true, "send": [], "receive": [], "partners": [], "file_max_mb": 25, "notice": ""}));
        assert_eq!(st.bridge_effective(&link).reason, "Org A's policy does not allow bridging with Org B");
    }

    #[test]
    fn ops_never_hold_an_address_or_a_principal() {
        let h = hub();
        let mut st = h.st.lock();
        st.directory.insert("ben@x".into(), json!({"name": "Ben Brown"}));
        st.directory.insert("cy@x".into(), json!({"name": "cy@x"}));
        let msg = json!({
            "id": "m1", "channel": "c-1", "from": "ann@x", "from_name": "ann@x", "from_org": {"id": "orga", "label": "Org A"},
            "text": "Status at noon", "ts": 1.0, "reactions": {"x": ["ben@x"]}, "mentions": ["ben@x", "cy@x"],
            "reply_to": {"id": "m0", "from": "ben@x", "name": "Ben", "text": "earlier"},
            "files": [{"id": "f1", "name": "plan.txt", "size": 4, "type": "text/plain", "from": "ann@x", "sha256": "00"}]
        });
        let fields = st.bridge_post_fields(msg.as_object().unwrap());
        let text = pj::dumps(&Value::Object(fields.clone()));
        assert!(!text.contains('@'), "{text}");
        assert_eq!(fields["from_name"], json!(""));
        assert_eq!(fields["mentions"], json!(["Ben Brown"]));
        assert_eq!(fields["from_org"], json!({"label": "Org A"}));
        assert_eq!(fields["files"], json!([{"id": "f1", "name": "plan.txt", "size": 4, "mime": "text/plain"}]));
        // a bridged message is named by its real sender, the platform it came from
        let bridged = json!({"id": "m2", "from": "bridge@b", "from_name": "Bob", "text": "hi", "src": {"platform": "teams", "link": "l", "user": "29:x", "name": "Bob Brown", "org": {"id": "orgb", "label": "Org B"}, "msg": "T1", "url": ""}});
        let fields = st.bridge_post_fields(bridged.as_object().unwrap());
        assert_eq!((fields["from_name"].clone(), fields["from_platform"].clone(), fields["from_org"].clone()), (json!("Bob Brown"), json!("teams"), json!({"label": "Org B"})));
        assert!(!pj::dumps(&Value::Object(fields)).contains('@'));
        // what a connector sees of a link never names a member or the conversation
        let link = json!({"id": "l1", "channel": "c-1", "platform": "slack", "connector": "bridge@b", "org": {"id": "orgb", "label": "Org B"}, "target": {"id": "C1", "label": "#ops", "kind": "channel"}, "state": "active", "reason": "", "by": "ann@x", "claimed_by": "Bob", "ts": 1.0, "send": [], "receive": [], "notice": ""});
        let view = pj::dumps(&Value::Object(c_view(link.as_object().unwrap())));
        assert!(!view.contains('@') && !view.contains("c-1"));
        assert!(!pj::dumps(&Value::Object(member_view(link.as_object().unwrap()))).contains('@'));
    }

    #[test]
    fn small_checks_follow_python() {
        assert_eq!(room("c-0123456789abcdef"), "cv-0123456789abcdef");
        assert_eq!(url(Some(&json!("https://x.slack.com/archives/C1/p1"))), "https://x.slack.com/archives/C1/p1");
        assert_eq!(url(Some(&json!("javascript:alert(1)"))), "");
        assert_eq!(url(Some(&json!("https:///nohost"))), "");
        let code = new_code();
        assert!(code.len() == CODE_LEN && code.bytes().all(|c| CODE_ALPHABET.contains(&c)));
        assert!(field(Some(&json!("  ")), "msg", 10).is_err());
        assert_eq!(field(Some(&json!(" a  b ")), "msg", 10).unwrap(), "a b");
        assert!(stored_link("l1", &json!({"id": "l1", "channel": "c", "connector": "x", "platform": "slack", "state": "off", "org": {"id": "o", "label": "O"}, "target": {"id": "t", "label": "T", "kind": "dm"}, "send": [], "receive": [], "reason": "", "notice": "", "by": "", "claimed_by": ""})));
        assert!(!stored_link("l2", &json!({"id": "l1"})));
    }
}
