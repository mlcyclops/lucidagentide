// PH-1 revision 2 (docs/phone/contract.md section 10): texts from a person's Lucid phone number. Texts never travel
// over SIP; they go through the provider's HTTP API (voip.ms first). A text thread is the pair (person, outside
// number), conversation `sms:<number>`, plain text at the carrier (never end-to-end encrypted), kept in relay state
// under the person (ext["sms"]["people"][<principal>] = {threads: {<number>: [message]}, read: {<number>: ts}}) and
// pruned like direct messages. A person sends through `POST /v1/sms` (sendSMS up to 160 characters, sendMMS longer);
// voip.ms delivers inbound texts to a TLS listener of their own (`callback_listen`, no client certificate) as
// `GET /v1/sms/voipms/<token>?to=&from=&message=&id=&date=&media=`. Provider ids seen in the last 7 days are kept in
// ext["sms"]["seen"] so a retried callback is stored once. A child module of meet_hub: it shares the one lock.

use super::*;
use crate::console_source::{parse_cidr, Cidr};
use crate::meet::{address_of, http_date, quiet_end, read_head, reason_phrase, Head, Settings, Tls, SERVER_VERSION};
use crate::meet_tls::RefusalLog;
use std::io::{BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicUsize;

const VOIPMS: &str = "voipms";
const DEFAULT_URL: &str = "https://voip.ms/api/v1/rest.php";
const CALLBACK_PREFIX: &str = "/v1/sms/voipms/";
/// The callback token's least length, and the characters it may hold (it is a path segment).
const TOKEN_MIN: usize = 32;
/// A text a person sends: at most TEXT_MAX characters, sendSMS up to SMS_MAX (voip.ms allows 2048 in sendMMS).
const TEXT_MAX: usize = 1600;
const SMS_MAX: usize = 160;
/// Characters of an inbound text kept, media URLs per text and characters of each, of a provider id.
const TEXT_KEEP: usize = 4096;
const MEDIA_MAX: usize = 10;
const URL_MAX: usize = 2048;
const ID_MAX: usize = 128;
/// GET /v1/sms/history: at most this many messages.
const HISTORY_MAX: i64 = 200;
/// Outbound texts per person: RATE_MAX in RATE_WINDOW seconds.
const RATE_MAX: usize = 30;
const RATE_WINDOW: f64 = 60.0;
/// A provider id is answered `ok` without storing again for this long.
const SEEN_KEEP: f64 = 7.0 * 86400.0;
/// One API call (connect, send, answer), and the most answer bytes read.
const API_TIMEOUT: f64 = 20.0;
const REPLY_MAX: usize = 64 * 1024;
/// A callback connection's handshake, request and answer each get this long; at most CONNECTIONS_MAX at once.
const CALLBACK_TIMEOUT: f64 = 10.0;
const CONNECTIONS_MAX: usize = 64;

pub(super) const NOT_SET_UP: &str = "texting is not set up on this relay";
pub(super) const BAD_TO: &str = "to must be a phone number in E.164 form (+ and 7 to 15 digits) or a short code (3 to 8 digits)";
pub(super) const BAD_NUMBER: &str = "number must be a phone number in E.164 form or a short code";
pub(super) const BAD_TEXT: &str = "text must be 1 to 1600 characters";
pub(super) const SLOW: &str = "slow down";
pub(super) const NOT_SENT: &str = "the text could not be sent";
const UNKNOWN: &str = "unknown path";
const NOT_STORED: &str = "the text could not be stored; try again";
// relay.json `phone.sms` (section 10.1)
const SHAPE: &str = "relay settings: phone.sms must be {provider, api_user, api_password_file, api_url, callback_listen, callback_from, callback_token_file}";
const FIELDS: [&str; 7] = ["provider", "api_user", "api_password_file", "api_url", "callback_listen", "callback_from", "callback_token_file"];
const PROVIDER: &str = "relay settings: phone.sms.provider must be voipms";
const USER: &str = "relay settings: phone.sms.api_user must name the voip.ms API user (the account's email)";
const PASSWORD: &str = "relay settings: phone.sms.api_password_file must be a readable file holding the voip.ms API password";
const URL: &str = "relay settings: phone.sms.api_url must be an https URL (http only to this machine)";
const LISTEN: &str = "relay settings: phone.sms.callback_listen must be host:port (where voip.ms delivers texts)";
const FROM: &str = "relay settings: phone.sms.callback_from must list address ranges (CIDR), or be empty for any";
const TOKEN: &str = "relay settings: phone.sms.callback_token_file must hold a random token of at least 32 letters, digits, '-', '_', '.' or '~'";

/// The provider's API: where it answers, and its TLS (None: plain http, a loopback host only).
struct Api {
    tls: Option<Arc<rustls::ClientConfig>>,
    host: String,
    port: u16,
    path: String,
}

/// relay.json `phone.sms`, read and checked once at start.
pub struct Cfg {
    user: String,
    password: String,
    api: Api,
    /// The callback listener and the address ranges it accepts (empty: any).
    host: String,
    port: u16,
    from: Vec<Cidr>,
    token: String,
}

impl Cfg {
    /// One voip.ms API call: an HTTPS POST form (`api_username`, `api_password`, `method`, `content_type=json`, then
    /// the method's fields), so the password never sits in a URL or a log. Ok: the answer's JSON object (its `status`
    /// says whether the provider did it); Err: the API could not be reached or did not answer JSON.
    fn call(&self, method: &str, fields: &[(&str, String)]) -> Result<Obj, String> {
        let esc = crate::mcp::form_escape;
        let mut form = format!("api_username={}&api_password={}&method={}&content_type=json", esc(&self.user), esc(&self.password), esc(method));
        for (k, v) in fields {
            form.push_str(&format!("&{k}={}", esc(v)));
        }
        let headers = [("Content-Type", "application/x-www-form-urlencoded".to_string()), ("Accept", "application/json".to_string())];
        let api = &self.api;
        let sent = match &api.tls {
            Some(tls) => crate::meet_tls::https_request_capped(tls, &api.host, api.port, API_TIMEOUT, "POST", &api.path, &headers, Some(form.as_bytes()), &|_: &[u8]| Ok(()), REPLY_MAX),
            None => crate::meet_tls::http_request_capped(&api.host, api.port, API_TIMEOUT, "POST", &api.path, &headers, Some(form.as_bytes()), REPLY_MAX),
        };
        let r = sent.map_err(|e| e.unwrap_or_else(|m| m))?;
        if !(200..300).contains(&r.status) {
            return Err(format!("status {}", r.status));
        }
        match serde_json::from_slice::<Value>(&r.body) {
            Ok(Value::Object(o)) => Ok(o),
            _ => Err("the answer is not a JSON object".into()),
        }
    }
}

/// In memory: the settings and each person's recent outbound texts (monotonic times, for the rate).
#[derive(Default)]
pub(super) struct Sms {
    cfg: Option<Arc<Cfg>>,
    sent: HashMap<String, VecDeque<f64>>,
}

/// A short code: 3 to 8 digits.
fn short_code(text: &str) -> bool {
    (3..=8).contains(&text.len()) && text.bytes().all(|c| c.is_ascii_digit())
}

/// A thread's outside number: E.164 or a short code.
pub(super) fn thread_number(text: &str) -> bool {
    phone::e164(text) || short_code(text)
}

/// A number as voip.ms writes it (section 10.2), as the relay keeps it: 10 digits get `+1`, 11 digits starting `1`
/// get `+`, 3 to 8 digits are a short code kept as digits, an E.164 number stays; None otherwise.
pub(super) fn inbound_number(text: &str) -> Option<String> {
    let t = text.trim();
    if phone::e164(t) {
        return Some(t.to_string());
    }
    if t.is_empty() || !t.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let out = match t.len() {
        10 => format!("+1{t}"),
        11 if t.starts_with('1') => format!("+{t}"),
        _ if short_code(t) => t.to_string(),
        _ => return None,
    };
    thread_number(&out).then_some(out)
}

/// A number as voip.ms takes it: North America (`+1` and 10 digits) as the 10 digits, any other E.164 number without
/// its `+`, a short code as it is.
pub(super) fn provider_number(number: &str) -> String {
    match number.strip_prefix("+1") {
        Some(rest) if rest.len() == 10 => rest.to_string(),
        _ => number.trim_start_matches('+').to_string(),
    }
}

/// A thread number from a query or a body. In a query a `+` the client did not escape arrives as a space: a value
/// of a space and digits is that E.164 number. 400 when it is neither E.164 nor a short code.
pub(super) fn query_number(raw: &str) -> R<String> {
    let number = match raw.strip_prefix(' ') {
        Some(rest) if !rest.is_empty() && rest.bytes().all(|c| c.is_ascii_digit()) => format!("+{rest}"),
        _ => raw.trim().to_string(),
    };
    if thread_number(&number) {
        Ok(number)
    } else {
        bad(BAD_NUMBER)
    }
}

/// A message's relay-made id: `s-` and 16 hex.
fn new_id() -> String {
    format!("s-{}", pj::token_hex(8))
}

/// The `media` of a callback: its comma or space separated http(s) URLs (MMS pictures).
fn media_of(text: &str) -> Vec<String> {
    text.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|u| (u.starts_with("https://") || u.starts_with("http://")) && u.len() <= URL_MAX)
        .take(MEDIA_MAX)
        .map(str::to_string)
        .collect()
}

/// The first non-blank line of a file, trimmed (None when it cannot be read or is empty).
fn read_secret(path: &str) -> Option<String> {
    let text = std::fs::read_to_string(path.trim()).ok()?;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.to_string())
}

/// A callback token: TOKEN_MIN or more URL-safe characters (it is a path segment).
fn good_token(token: &str) -> bool {
    token.len() >= TOKEN_MIN && token.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~'))
}

/// A host on this machine (plain http to the API is allowed only to one).
fn loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// `http(s)://host[:port][/path][?query]`: (tls, host, port, path and query). No user part, no fragment.
fn api_url(text: &str) -> Option<(bool, String, u16, String)> {
    let (tls, rest) = match (text.strip_prefix("https://"), text.strip_prefix("http://")) {
        (Some(r), _) => (true, r),
        (None, Some(r)) => (false, r),
        _ => return None,
    };
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains('@') || path.contains(char::is_whitespace) || path.contains('#') {
        return None;
    }
    let port_of = |p: &str| p.parse::<u16>().ok().filter(|p| *p > 0);
    let (host, port) = match authority.strip_prefix('[') {
        Some(v6) => {
            let (h, after) = v6.split_once(']')?;
            let port = match after {
                "" => None,
                p => Some(port_of(p.strip_prefix(':')?)?),
            };
            (h.to_string(), port)
        }
        None => match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(port_of(p)?)),
            None => (authority.to_string(), None),
        },
    };
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    let path = if path.starts_with('?') { format!("/{path}") } else { path.to_string() };
    Some((tls, host, port.unwrap_or(if tls { 443 } else { 80 }), path))
}

/// relay.json `phone.sms` (section 10.1): its seven fields only, each checked, the two files read; Err names the
/// field.
fn parse(v: &Value) -> Result<Cfg, String> {
    let Value::Object(o) = v else { return Err(SHAPE.into()) };
    if o.keys().any(|k| !FIELDS.contains(&k.as_str())) {
        return Err(SHAPE.into());
    }
    if o.get("provider").and_then(Value::as_str).map(str::trim) != Some(VOIPMS) {
        return Err(PROVIDER.into());
    }
    let user = match o.get("api_user") {
        Some(Value::String(u)) if !u.trim().is_empty() && pj::printable(u.trim()) => u.trim().to_string(),
        _ => return Err(USER.into()),
    };
    let password = o.get("api_password_file").and_then(Value::as_str).and_then(read_secret).filter(|p| pj::printable(p)).ok_or_else(|| PASSWORD.to_string())?;
    let url = match o.get("api_url") {
        None | Some(Value::Null) => DEFAULT_URL,
        Some(Value::String(u)) => u.trim(),
        Some(_) => return Err(URL.into()),
    };
    let (secure, api_host, api_port, path) = api_url(url).filter(|(secure, host, _, _)| *secure || loopback(host)).ok_or_else(|| URL.to_string())?;
    let tls = if secure { Some(crate::meet_tls::client_config(None, None)?) } else { None };
    let (host, port) = o.get("callback_listen").and_then(Value::as_str).and_then(|t| phone::listen_parts(t.trim())).ok_or_else(|| LISTEN.to_string())?;
    let mut from = Vec::new();
    match o.get("callback_from") {
        None | Some(Value::Null) => {}
        Some(Value::Array(a)) => {
            for c in a {
                from.push(c.as_str().and_then(|c| parse_cidr(c).ok()).ok_or_else(|| FROM.to_string())?);
            }
        }
        Some(_) => return Err(FROM.into()),
    }
    let token = o.get("callback_token_file").and_then(Value::as_str).and_then(read_secret).filter(|t| good_token(t)).ok_or_else(|| TOKEN.to_string())?;
    Ok(Cfg { user, password, api: Api { tls, host: api_host, port: api_port, path }, host, port, from, token })
}

impl State {
    /// relay.json `phone.sms`, once at start (from phone_configure; None turns texting off).
    pub(super) fn sms_configure(&mut self, v: Option<&Value>) -> Result<(), String> {
        self.sms.cfg = match v {
            None | Some(Value::Null) => None,
            Some(v) => {
                let cfg = parse(v)?;
                let secure = if cfg.api.tls.is_some() { "https" } else { "http" };
                log_info(&format!("sms configured provider={VOIPMS} api={secure}://{}:{} callback={}:{}", cfg.api.host, cfg.api.port, cfg.host, cfg.port));
                Some(Arc::new(cfg))
            }
        };
        Ok(())
    }

    /// Texting is set up (hello's `you.phone_sms` for a person with a line).
    pub(super) fn sms_on(&self) -> bool {
        self.sms.cfg.is_some()
    }

    /// The person's texts: {threads, read}.
    fn sms_person(&self, principal: &str) -> Option<&Obj> {
        as_obj(self.ext.get("sms")).and_then(|s| as_obj(s.get("people"))).and_then(|p| as_obj(p.get(principal)))
    }

    /// The person's thread with `number`, oldest first.
    fn sms_thread(&self, principal: &str, number: &str) -> &[Value] {
        self.sms_person(principal).and_then(|p| as_obj(p.get("threads"))).and_then(|t| t.get(number)).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Keep a new message (in or out) in the person's thread with `number` (its newest DM_KEEP), and tell every
    /// session of the person `{type: "sms", number, message}`.
    fn sms_keep(&mut self, principal: &str, number: &str, msg: &Obj) {
        let threads = obj_mut(obj_mut(obj_mut(obj_mut(&mut self.ext, "sms"), "people"), principal), "threads");
        let slot = threads.entry(number.to_string()).or_insert_with(|| Value::Array(Vec::new()));
        if !slot.is_array() {
            *slot = Value::Array(Vec::new());
        }
        if let Value::Array(list) = slot {
            list.push(Value::Object(msg.clone()));
            if list.len() > DM_KEEP {
                let cut = list.len() - DM_KEEP;
                list.drain(..cut);
            }
        }
        self.dirty = true;
        let event = obj([("type", Value::from("sms")), ("number", Value::from(number)), ("message", Value::Object(msg.clone()))]);
        self.tell(&[principal.to_string()], &event, None);
    }

    /// The person's text read marks as `/v1/notify/reads` names them: `sms:<number>` -> ts.
    pub(super) fn sms_reads(&self, principal: &str) -> Obj {
        let marks = self.sms_person(principal).and_then(|p| as_obj(p.get("read")));
        marks.into_iter().flatten().map(|(n, ts)| (format!("sms:{n}"), ts.clone())).collect()
    }

    /// The periodic prune: the outbound rate book; texts past the DM retention (the person's signed `dm` retention,
    /// capped by mail_days, as direct messages); empty threads and their marks; provider ids older than SEEN_KEEP.
    pub(super) fn sms_prune(&mut self, now: f64) {
        let mono = pj::mono();
        self.sms.sent.retain(|_, book| {
            while book.front().is_some_and(|t| mono - t >= RATE_WINDOW) {
                book.pop_front();
            }
            !book.is_empty()
        });
        if !self.ext.contains_key("sms") {
            return;
        }
        let people: Vec<String> = as_obj(self.ext.get("sms")).and_then(|s| as_obj(s.get("people"))).map(|p| p.keys().cloned().collect()).unwrap_or_default();
        let mut keep = Vec::with_capacity(people.len());
        for p in &people {
            let cap = self.mail_s;
            keep.push(self.pc_retention_s("dm", std::slice::from_ref(p), cap));
        }
        let store = obj_mut(&mut self.ext, "sms");
        let mut changed = false;
        let all = obj_mut(store, "people");
        for (p, k) in people.iter().zip(keep) {
            let cut = now - k;
            let Some(person) = all.get_mut(p).and_then(Value::as_object_mut) else { continue };
            let threads = obj_mut(person, "threads");
            for list in threads.values_mut() {
                if let Value::Array(a) = list {
                    let before = a.len();
                    a.retain(|m| pj::as_num(m.get("ts")).unwrap_or(0.0) >= cut);
                    changed |= a.len() != before;
                }
            }
            threads.retain(|_, l| l.as_array().is_some_and(|a| !a.is_empty()));
            let live: HashSet<String> = threads.keys().cloned().collect();
            obj_mut(person, "read").retain(|n, _| live.contains(n));
        }
        let before = all.len();
        all.retain(|_, v| as_obj(Some(v)).and_then(|o| as_obj(o.get("threads"))).is_some_and(|t| !t.is_empty()));
        changed |= all.len() != before;
        let seen = obj_mut(store, "seen");
        let before = seen.len();
        seen.retain(|_, t| pj::as_num(Some(t)).is_some_and(|t| now - t < SEEN_KEEP));
        changed |= seen.len() != before;
        if changed {
            self.dirty = true;
        }
    }
}

impl Hub {
    /// `GET /v1/sms/threads?session=` (section 10.3): the caller's threads, newest first:
    /// `{threads: [{number, last: {dir, text, ts}, unread}]}` (`unread`: messages in after the read mark).
    pub fn sms_threads(&self, session: &str, who: &Identity) -> R<Obj> {
        let st = self.st.lock();
        st.session(session, who)?;
        let person = st.sms_person(&who.principal);
        let marks = person.and_then(|p| as_obj(p.get("read")));
        let mut rows: Vec<(f64, Value)> = Vec::new();
        for (number, list) in person.and_then(|p| as_obj(p.get("threads"))).into_iter().flatten() {
            let list: Vec<&Obj> = list.as_array().into_iter().flatten().filter_map(Value::as_object).collect();
            let Some(last) = list.last() else { continue };
            let mark = marks.and_then(|r| pj::as_num(r.get(number))).unwrap_or(0.0);
            let unread = list.iter().filter(|m| pj::text_of(m, "dir") == "in" && pj::num(m, "ts") > mark).count();
            let ts = pj::num(last, "ts");
            let shown = obj([("dir", Value::from(pj::text_of(last, "dir"))), ("text", Value::from(pj::text_of(last, "text"))), ("ts", f(ts))]);
            rows.push((ts, Value::Object(obj([("number", Value::from(number.clone())), ("last", Value::Object(shown)), ("unread", Value::from(unread))]))));
        }
        rows.sort_by(|a, b| b.0.total_cmp(&a.0));
        Ok(obj([("threads", Value::Array(rows.into_iter().map(|(_, r)| r).collect()))]))
    }

    /// `GET /v1/sms/history?session=&number=&after=&limit=`: the newest `limit` (1 to 200) messages of the caller's
    /// thread with `number` after `after`, oldest first: `{messages}`.
    pub fn sms_history(&self, session: &str, who: &Identity, number: &str, after: &str, limit: &str) -> R<Obj> {
        let number = query_number(number)?;
        let after = m::number(Some(&Value::from(after)), "after")?;
        let limit = m::py_int(limit)?.clamp(1, HISTORY_MAX) as usize;
        let st = self.st.lock();
        st.session(session, who)?;
        let kept: Vec<&Value> = st.sms_thread(&who.principal, &number).iter().filter(|m| pj::as_num(m.get("ts")).unwrap_or(0.0) > after).collect();
        let out: Vec<Value> = kept[kept.len().saturating_sub(limit)..].iter().map(|m| (*m).clone()).collect();
        Ok(obj([("messages", Value::Array(out))]))
    }

    /// `POST /v1/sms/read {session, number, ts}`: the caller's read mark of the thread moves forward; their other
    /// sessions hear `{type: "read", conv: "sms:<number>", ts}`.
    pub fn sms_read(&self, session: &str, who: &Identity, number: Body, ts: Body) -> R<Obj> {
        let number = match number {
            Some(Value::String(n)) => query_number(n)?,
            _ => return bad(BAD_NUMBER),
        };
        let ts = m::number(ts, "ts")?;
        let mut st = self.st.lock();
        st.session(session, who)?;
        let marks = obj_mut(obj_mut(obj_mut(obj_mut(&mut st.ext, "sms"), "people"), &who.principal), "read");
        if ts > pj::as_num(marks.get(&number)).unwrap_or(0.0) {
            marks.insert(number.clone(), f(ts));
            st.dirty = true;
            let event = obj([("type", Value::from("read")), ("conv", Value::from(format!("sms:{number}"))), ("ts", f(ts))]);
            st.tell(std::slice::from_ref(&who.principal), &event, Some(session));
        }
        drop(st);
        self.wake();
        Ok(obj([("ok", Value::Bool(true))]))
    }

    /// `POST /v1/sms {session, to, text}` (section 10.3): a text from the caller's line. 403 without a line, 409 when
    /// texting is not set up, 400 a bad `to` or `text`, 429 past RATE_MAX a minute. Up to SMS_MAX characters it goes
    /// as sendSMS, longer as sendMMS. The answer is the stored message: `sent`, or `failed` with `error` (the
    /// provider's status code) when the provider refused it; 502 (nothing stored) when the API could not be reached.
    pub fn sms_send(&self, session: &str, who: &Identity, to: Body, text: Body) -> R<Obj> {
        let (cfg, line, to, text) = {
            let mut st = self.st.lock();
            st.session(session, who)?;
            let Some(line) = st.phone_line_of(&who.principal) else { return forbidden(phone::NO_LINE) };
            let Some(cfg) = st.sms.cfg.clone() else { return Err(E::Conflict(NOT_SET_UP.into())) };
            let to = match to {
                Some(Value::String(t)) if thread_number(t) => t.clone(),
                _ => return bad(BAD_TO),
            };
            let text = match text {
                Some(Value::String(t)) => t.trim().to_string(),
                _ => return bad(BAD_TEXT),
            };
            if !(1..=TEXT_MAX).contains(&pj::char_len(&text)) {
                return bad(BAD_TEXT);
            }
            let now = pj::mono();
            let book = st.sms.sent.entry(who.principal.clone()).or_default();
            while book.front().is_some_and(|t| now - t >= RATE_WINDOW) {
                book.pop_front();
            }
            if book.len() >= RATE_MAX {
                return Err(E::Status(429, SLOW.into(), false));
            }
            book.push_back(now);
            (cfg, line, to, text)
        };
        let method = if pj::char_len(&text) <= SMS_MAX { "sendSMS" } else { "sendMMS" };
        let fields = [("did", provider_number(&line)), ("dst", provider_number(&to)), ("message", text.clone())];
        let answer = match cfg.call(method, &fields) {
            Ok(a) => a,
            Err(why) => {
                log_warn(&format!("sms out failed principal={} to={to} method={method} why={}", who.principal, kv(&why)));
                return Err(E::Status(502, NOT_SENT.into(), false));
            }
        };
        let status = pj::text_of(&answer, "status");
        let mut msg = obj([("id", Value::from(new_id())), ("dir", Value::from("out")), ("text", Value::from(text)), ("ts", f(pj::now())), ("status", Value::from("sent"))]);
        if status != "success" {
            msg.insert("status".into(), Value::from("failed"));
            msg.insert("error".into(), Value::from(if status.is_empty() { "unknown".to_string() } else { pj::clip(&status, 100) }));
        }
        let mut st = self.st.lock();
        st.sms_keep(&who.principal, &to, &msg);
        drop(st);
        self.wake();
        log_info(&format!("sms out principal={} line={line} to={to} method={method} status={}", who.principal, kv(&status)));
        Ok(msg)
    }

    /// A voip.ms callback whose token checked (section 10.2): true answers `ok`, false 503 (voip.ms tries again). A
    /// text to a number that is not a line, or from a number that does not read, is dropped with a log line (`ok`); a
    /// provider id seen in the last SEEN_KEEP is not stored again (`ok`); otherwise the text is kept in the line
    /// owner's thread (event and push) and state.json is written before the answer.
    pub fn sms_inbound(&self, query: &[(String, String)]) -> bool {
        let get = |k: &str| query.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or_default();
        if !self.serving() {
            log_info("sms in refused why=not_serving");
            return false;
        }
        let (to, from) = (inbound_number(get("to")), inbound_number(get("from")));
        let id = pj::clip(get("id").trim(), ID_MAX);
        let mut st = self.st.lock();
        let owner = to.as_deref().and_then(|t| st.phone_owner_of(t));
        let (Some(to), Some(owner)) = (to, owner) else {
            drop(st);
            log_info(&format!("sms in dropped why=not_a_line to={}", kv(get("to"))));
            return true;
        };
        let Some(from) = from else {
            drop(st);
            log_info(&format!("sms in dropped why=bad_from line={to} from={}", kv(get("from"))));
            return true;
        };
        let now = pj::now();
        if !id.is_empty() {
            let seen = obj_mut(obj_mut(&mut st.ext, "sms"), "seen");
            if pj::as_num(seen.get(&id)).is_some_and(|t| now - t < SEEN_KEEP) {
                drop(st);
                log_info(&format!("sms in duplicate line={to} id={}", kv(&id)));
                return true;
            }
            seen.insert(id.clone(), f(now));
        }
        let media = media_of(get("media"));
        let count = media.len();
        let mut msg = obj([("id", Value::from(new_id())), ("dir", Value::from("in")), ("text", Value::from(pj::clip(get("message"), TEXT_KEEP))), ("ts", f(now)), ("status", Value::from("received"))]);
        if !media.is_empty() {
            msg.insert("media".into(), Value::from(media));
        }
        st.sms_keep(&owner, &from, &msg);
        st.pu_sms(&owner, &from, &msg);
        drop(st);
        self.wake();
        log_info(&format!("sms in principal={owner} line={to} from={from} media={count} id={}", kv(&id)));
        match self.save_synced() {
            Ok(()) => true,
            Err(e) => {
                log_warn(&format!("sms in not saved line={to}: {e}"));
                false
            }
        }
    }
}

// ── the callback listener (section 10.1) ─────────────────────────────────────────────────────────────────────

struct Port {
    hub: Arc<Hub>,
    tls: Arc<rustls::ServerConfig>,
    cfg: Arc<Cfg>,
    open: AtomicUsize,
    refusals: RefusalLog,
}

/// The callback listener on `callback_listen`, on its own thread (nothing without `phone.sms`): the relay's own server
/// certificate, no client certificate, connections from `callback_from` only when it lists ranges (any other is
/// closed at accept), and `GET /v1/sms/voipms/<token>` only (404 for anything else, a wrong token too).
pub fn start(settings: &Settings, hub: Arc<Hub>) -> Result<(), String> {
    let Some(cfg) = hub.st.lock().sms.cfg.clone() else { return Ok(()) };
    let tls = crate::meet_tls::webhook_tls_config(settings)?;
    let listener = TcpListener::bind((cfg.host.as_str(), cfg.port)).map_err(|e| format!("cannot listen on {}:{} (phone.sms.callback_listen): {e}", cfg.host, cfg.port))?;
    let port = Arc::new(Port { hub, tls, cfg: cfg.clone(), open: AtomicUsize::new(0), refusals: RefusalLog::new() });
    std::thread::Builder::new()
        .name("relay-sms-callbacks".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let Ok(tcp) = conn else { continue };
                let Ok(peer) = tcp.peer_addr() else { continue };
                let address = address_of(&peer);
                let allowed = port.cfg.from.is_empty() || port.cfg.from.iter().any(|c| c.contains(peer.ip()));
                if !allowed || port.open.load(Ordering::SeqCst) >= CONNECTIONS_MAX {
                    port.refusals.note(&address);
                    drop(tcp);
                    continue;
                }
                port.open.fetch_add(1, Ordering::SeqCst);
                let p = port.clone();
                let spawned = std::thread::Builder::new().name("relay-sms-callback".into()).spawn(move || {
                    serve(&p, tcp, &address);
                    p.open.fetch_sub(1, Ordering::SeqCst);
                });
                if spawned.is_err() {
                    port.open.fetch_sub(1, Ordering::SeqCst);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let from = if cfg.from.is_empty() { "any address".to_string() } else { format!("{} address ranges", cfg.from.len()) };
    log_info(&format!("sms callbacks listening on {}:{} from {from}", cfg.host, cfg.port));
    Ok(())
}

fn serve(port: &Port, mut tcp: TcpStream, address: &str) {
    let timeout = Some(Duration::from_secs_f64(CALLBACK_TIMEOUT));
    let _ = tcp.set_read_timeout(timeout);
    let _ = tcp.set_write_timeout(timeout);
    let Ok(mut conn) = rustls::ServerConnection::new(port.tls.clone()) else { return };
    while conn.is_handshaking() {
        if conn.complete_io(&mut tcp).is_err() {
            port.refusals.note(address);
            return;
        }
    }
    let mut reader = BufReader::new(Tls::new(conn, tcp));
    loop {
        match one(port, &mut reader) {
            Ok(true) => continue,
            Ok(false) => break,
            Err(e) => {
                if !quiet_end(&e) {
                    port.refusals.note(address);
                }
                break;
            }
        }
    }
    let tls = reader.get_mut();
    tls.conn.send_close_notify();
    let _ = tls.flush();
}

fn answer(w: &mut Tls, status: u16, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nServer: {SERVER_VERSION} \r\nDate: {}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n",
        reason_phrase(status),
        http_date(),
        body.len()
    );
    w.write_all(head.as_bytes())?;
    w.write_all(body)?;
    w.flush()
}

fn error(w: &mut Tls, status: u16, message: &str) -> std::io::Result<()> {
    answer(w, status, "application/json", pj::dumps(&Value::Object(obj([("error", Value::from(message))]))).as_bytes())
}

/// The path is `/v1/sms/voipms/<token>` with this relay's token (compared in constant time).
fn token_path(cfg: &Cfg, path: &str) -> bool {
    path.strip_prefix(CALLBACK_PREFIX).is_some_and(|t| aws_lc_rs::constant_time::verify_slices_are_equal(t.as_bytes(), cfg.token.as_bytes()).is_ok())
}

/// One request: Ok(false) when the connection closes after it.
fn one(port: &Port, reader: &mut BufReader<Tls>) -> std::io::Result<bool> {
    let Some(head) = read_head(reader)? else { return Ok(false) };
    let unread = crate::meet::drain_unread(reader, &head, false);
    let keep = !head.close && !unread;
    let (path, query) = Head::path_query(&head);
    if head.method != "GET" || !token_path(&port.cfg, &path) {
        error(reader.get_mut(), 404, UNKNOWN)?;
        return Ok(keep);
    }
    if port.hub.sms_inbound(&crate::meet::parse_query(&query)) {
        answer(reader.get_mut(), 200, "text/plain", b"ok")?;
    } else {
        error(reader.get_mut(), 503, NOT_STORED)?;
    }
    Ok(keep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead, Read};

    const LINE: &str = "+19415550100";
    const OTHER: &str = "+13055550147";
    const TOKEN_TEXT: &str = "0123456789abcdefghijklmnopqrstuvwxyz";

    fn person(p: &str, device: &str) -> Identity {
        Identity { principal: p.into(), name: p.to_uppercase(), device: device.into(), ..Default::default() }
    }

    /// A file in the temporary folder holding `text`; its path.
    fn file(text: &str) -> String {
        let path = std::env::temp_dir().join(format!("lucid-sms-{}", pj::token_hex(6)));
        std::fs::write(&path, text).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn sms_settings(api_url: &str) -> Value {
        json!({"provider": "voipms", "api_user": "owner@example.com", "api_password_file": file("pass word&1\n"), "api_url": api_url,
               "callback_listen": "127.0.0.1:8448", "callback_from": [], "callback_token_file": file(TOKEN_TEXT)})
    }

    /// A port nothing listens on.
    fn closed_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    /// A fake voip.ms API (plain http on this machine): it records each POST form and answers `reply` (JSON).
    struct Fake {
        url: String,
        forms: Arc<Mutex<Vec<Vec<(String, String)>>>>,
    }

    impl Fake {
        fn new(reply: &'static str) -> Fake {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://127.0.0.1:{}/api/v1/rest.php", listener.local_addr().unwrap().port());
            let forms = Arc::new(Mutex::new(Vec::new()));
            let seen = forms.clone();
            std::thread::spawn(move || {
                for conn in listener.incoming() {
                    let Ok(mut tcp) = conn else { continue };
                    let mut reader = std::io::BufReader::new(tcp.try_clone().unwrap());
                    let mut length = 0usize;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim_end().is_empty() {
                            break;
                        }
                        if let Some((k, v)) = line.trim_end().split_once(':') {
                            if k.eq_ignore_ascii_case("content-length") {
                                length = v.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    let mut body = vec![0u8; length];
                    let _ = reader.read_exact(&mut body);
                    seen.lock().push(crate::meet::parse_query(&String::from_utf8_lossy(&body)));
                    let _ = write!(tcp, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
                }
            });
            Fake { url, forms }
        }

        fn last(&self) -> Obj {
            self.forms.lock().last().unwrap().iter().map(|(k, v)| (k.clone(), Value::from(v.clone()))).collect()
        }
    }

    /// A hub with the media server, `phone` (Ann holds LINE) and, unless `api_url` is None, `phone.sms`.
    fn hub(api_url: Option<&str>) -> Hub {
        let h = Hub::new(None, &[], 168.0, 30.0, 365.0, None, Arc::new(LinkStats::new()));
        let mut phone = json!({"webhook_listen": "127.0.0.1:8447", "webhook_from": ["127.0.0.1/32"], "lines": {LINE: "ann@x"}});
        if let Some(url) = api_url {
            phone["sms"] = sms_settings(url);
        }
        {
            let mut st = h.st.lock();
            st.sfu_test_server();
            st.phone_configure(&m::Settings { phone, ..m::Settings::default() }).unwrap();
        }
        h
    }

    fn hello(h: &Hub, who: &Identity) -> (String, Obj) {
        let mut reply = h.hello(who, "", &Obj::new()).unwrap();
        h.phone_hello(who, Some(&json!(["phone"])), &mut reply);
        (reply["session"].as_str().unwrap().to_string(), reply)
    }

    fn inbox(h: &Hub, sid: &str, kind: &str) -> Vec<Obj> {
        h.st.lock().sessions[sid].events.iter().filter(|e| pj::text_of(e, "type") == kind).cloned().collect()
    }

    fn query(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn refusal<T>(r: R<T>) -> String {
        match r {
            Ok(_) => "ok".into(),
            Err(e) => e.message(),
        }
    }

    fn thread(h: &Hub, principal: &str, number: &str) -> Vec<Value> {
        h.st.lock().sms_thread(principal, number).to_vec()
    }

    #[test]
    fn sms_settings_are_checked_at_start() {
        let good = sms_settings("http://127.0.0.1:9/api");
        let cfg = parse(&good).unwrap();
        assert_eq!((cfg.user.as_str(), cfg.password.as_str(), cfg.token.as_str()), ("owner@example.com", "pass word&1", TOKEN_TEXT));
        assert_eq!((cfg.api.tls.is_none(), cfg.api.host.as_str(), cfg.api.port, cfg.api.path.as_str()), (true, "127.0.0.1", 9, "/api"));
        assert_eq!((cfg.host.as_str(), cfg.port, cfg.from.len()), ("127.0.0.1", 8448, 0));
        // api_url defaults to voip.ms over https
        let mut s = good.clone();
        s.as_object_mut().unwrap().remove("api_url");
        let cfg = parse(&s).unwrap();
        assert_eq!((cfg.api.tls.is_some(), cfg.api.host.as_str(), cfg.api.port, cfg.api.path.as_str()), (true, "voip.ms", 443, "/api/v1/rest.php"));
        let with = |key: &str, v: Value| {
            let mut s = good.clone();
            s[key] = v;
            parse(&s).err().unwrap_or_default()
        };
        assert_eq!(with("provider", json!("twilio")), PROVIDER);
        assert_eq!(with("api_user", json!(" ")), USER);
        assert_eq!(with("api_password_file", json!("/no/such/file")), PASSWORD);
        assert_eq!(with("api_url", json!("http://voip.ms/api/v1/rest.php")), URL, "plain http leaves this machine");
        assert_eq!(with("api_url", json!("ftp://127.0.0.1/x")), URL);
        assert_eq!(with("api_url", json!("https://user@voip.ms/x")), URL);
        assert!(parse(&{
            let mut s = good.clone();
            s["api_url"] = json!("http://[::1]:8080/rest.php");
            s
        })
        .is_ok());
        assert_eq!(with("callback_listen", json!("8448")), LISTEN);
        assert_eq!(with("callback_from", json!(["10.0.0.0/33"])), FROM);
        assert!(with("callback_from", json!(["10.0.0.0/8"])).is_empty());
        assert_eq!(with("callback_token_file", json!(file("short"))), TOKEN);
        assert_eq!(with("callback_token_file", json!(file(&format!("{TOKEN_TEXT}/x")))), TOKEN);
        assert_eq!(with("extra", json!(1)), SHAPE);
        assert_eq!(parse(&json!("on")).err().unwrap(), SHAPE);
        // phone.sms is checked with phone; without it texting is off
        let h = hub(None);
        assert!(!h.st.lock().sms_on());
        let mut phone = json!({"webhook_listen": "127.0.0.1:8447", "webhook_from": ["127.0.0.1/32"], "lines": {LINE: "ann@x"}});
        phone["sms"] = with_provider("telnyx");
        assert_eq!(h.st.lock().phone_configure(&m::Settings { phone, ..m::Settings::default() }).err().unwrap(), PROVIDER);
    }

    fn with_provider(provider: &str) -> Value {
        let mut s = sms_settings("http://127.0.0.1:9/api");
        s["provider"] = json!(provider);
        s
    }

    #[test]
    fn numbers_convert_both_ways() {
        assert_eq!(inbound_number("9415550100").as_deref(), Some(LINE));
        assert_eq!(inbound_number("19415550100").as_deref(), Some(LINE));
        assert_eq!(inbound_number(" +19415550100 ").as_deref(), Some(LINE));
        assert_eq!(inbound_number("72345").as_deref(), Some("72345"));
        for bad in ["", "12", "123456789", "29415550100", "941-555-0100", "+0941555010"] {
            assert_eq!(inbound_number(bad), None, "{bad}");
        }
        assert_eq!(provider_number(LINE), "9415550100");
        assert_eq!(provider_number("+447911123456"), "447911123456");
        assert_eq!(provider_number("72345"), "72345");
        assert!(thread_number(OTHER) && thread_number("72345") && !thread_number("3055550147") && !thread_number("12"));
        // a `+` a query did not escape arrives as a space
        assert_eq!(query_number(" 13055550147").unwrap(), OTHER);
        assert_eq!(query_number(OTHER).unwrap(), OTHER);
        assert_eq!(refusal(query_number("abc")), BAD_NUMBER);
        assert_eq!(media_of("https://x.test/a.jpg, http://x.test/b.png ftp://x.test/c"), vec!["https://x.test/a.jpg", "http://x.test/b.png"]);
        assert_eq!(api_url("https://voip.ms").unwrap(), (true, "voip.ms".to_string(), 443, "/".to_string()));
        assert_eq!(api_url("http://localhost:81?x=1").unwrap(), (false, "localhost".to_string(), 81, "/?x=1".to_string()));
    }

    #[test]
    fn an_inbound_text_is_kept_once_in_its_owners_thread() {
        let h = hub(Some("http://127.0.0.1:9/api"));
        let (ann, ben) = (person("ann@x", "aaaaaaaaaaaaaaaa"), person("ben@x", "bbbbbbbbbbbbbbbb"));
        let (sa, reply) = hello(&h, &ann);
        assert_eq!(reply["you"]["phone_sms"], json!(true));
        let (sb, other) = hello(&h, &ben);
        assert!(other["you"].get("phone_sms").is_none(), "no line, no texts");
        let q = query(&[("to", "9415550100"), ("from", "3055550147"), ("message", "Hi there"), ("id", "991"), ("date", "2026-11-27 10:00:00"), ("media", "")]);
        assert!(h.sms_inbound(&q));
        let kept = thread(&h, "ann@x", OTHER);
        assert_eq!(kept.len(), 1);
        let msg = kept[0].as_object().unwrap();
        assert_eq!((&msg["dir"], &msg["text"], &msg["status"]), (&json!("in"), &json!("Hi there"), &json!("received")));
        let id = pj::text_of(msg, "id");
        assert!(id.len() == 18 && id.starts_with("s-") && id[2..].bytes().all(|c| c.is_ascii_hexdigit()), "{id}");
        assert!(msg.get("media").is_none() && msg.get("error").is_none());
        let told = inbox(&h, &sa, "sms");
        assert_eq!((&told[0]["number"], &told[0]["message"]), (&json!(OTHER), &kept[0]));
        assert!(inbox(&h, &sb, "sms").is_empty(), "only the owner hears it");
        // voip.ms tries again with the same id: answered, not kept twice
        assert!(h.sms_inbound(&q));
        assert_eq!(thread(&h, "ann@x", OTHER).len(), 1);
        // a picture message; a short code
        assert!(h.sms_inbound(&query(&[("to", "9415550100"), ("from", "3055550147"), ("message", ""), ("id", "992"), ("media", "https://x.test/1.jpg,https://x.test/2.jpg")])));
        assert_eq!(thread(&h, "ann@x", OTHER)[1]["media"], json!(["https://x.test/1.jpg", "https://x.test/2.jpg"]));
        assert!(h.sms_inbound(&query(&[("to", "19415550100"), ("from", "72345"), ("message", "Code 1234")])));
        assert_eq!(thread(&h, "ann@x", "72345").len(), 1);
        // a number that is not a line, a sender that does not read: dropped, still `ok`
        assert!(h.sms_inbound(&query(&[("to", "9415550111"), ("from", "3055550147"), ("message", "x"), ("id", "993")])));
        assert!(h.sms_inbound(&query(&[("to", "9415550100"), ("from", "12"), ("message", "x"), ("id", "994")])));
        assert_eq!(h.st.lock().sms_person("ann@x").and_then(|p| as_obj(p.get("threads"))).map(Obj::len), Some(2));
        // the prune keeps what is within the DM retention and forgets old provider ids
        let mut st = h.st.lock();
        st.sms_prune(pj::now());
        assert_eq!(st.sms_thread("ann@x", OTHER).len(), 2);
        st.sms_prune(pj::now() + 31.0 * 86400.0);
        assert!(st.sms_person("ann@x").is_none() && as_obj(st.ext["sms"].get("seen")).unwrap().is_empty());
    }

    #[test]
    fn texts_go_out_short_as_sms_long_as_mms_and_failures_are_kept() {
        let fake = Fake::new(r#"{"status":"success","sms":"23434"}"#);
        let h = hub(Some(fake.url.as_str()));
        let (ann, ann2, ben) = (person("ann@x", "aaaaaaaaaaaaaaaa"), person("ann@x", "a2a2a2a2a2a2a2a2"), person("ben@x", "bbbbbbbbbbbbbbbb"));
        let (sa, _) = hello(&h, &ann);
        let (sa2, _) = hello(&h, &ann2);
        let (sb, _) = hello(&h, &ben);
        let sent = h.sms_send(&sa, &ann, Some(&json!(OTHER)), Some(&json!("  On my way  "))).unwrap();
        assert_eq!((&sent["dir"], &sent["text"], &sent["status"]), (&json!("out"), &json!("On my way"), &json!("sent")));
        let form = fake.last();
        assert_eq!(form["method"], json!("sendSMS"));
        assert_eq!((&form["api_username"], &form["api_password"], &form["content_type"]), (&json!("owner@example.com"), &json!("pass word&1"), &json!("json")));
        assert_eq!((&form["did"], &form["dst"], &form["message"]), (&json!("9415550100"), &json!("3055550147"), &json!("On my way")));
        // every session of the sender hears it
        assert_eq!(inbox(&h, &sa2, "sms")[0]["message"], json!(sent));
        // longer than 160 characters: sendMMS
        let long = "x".repeat(161);
        h.sms_send(&sa, &ann, Some(&json!(OTHER)), Some(&json!(long))).unwrap();
        assert_eq!(fake.last()["method"], json!("sendMMS"));
        assert_eq!(thread(&h, "ann@x", OTHER).len(), 2);
        // refusals
        assert_eq!(refusal(h.sms_send(&sb, &ben, Some(&json!(OTHER)), Some(&json!("hi")))), phone::NO_LINE);
        assert_eq!(refusal(h.sms_send(&sa, &ann, Some(&json!("3055550147")), Some(&json!("hi")))), BAD_TO);
        assert_eq!(refusal(h.sms_send(&sa, &ann, Some(&json!(OTHER)), Some(&json!("   ")))), BAD_TEXT);
        assert_eq!(refusal(h.sms_send(&sa, &ann, Some(&json!(OTHER)), Some(&json!("y".repeat(1601))))), BAD_TEXT);
        assert_eq!(refusal(h.sms_send(&sa, &ann, Some(&json!(OTHER)), None)), BAD_TEXT);
        // at most 30 a minute
        for _ in 2..RATE_MAX {
            h.sms_send(&sa, &ann, Some(&json!("72345")), Some(&json!("go"))).unwrap();
        }
        assert_eq!(refusal(h.sms_send(&sa, &ann, Some(&json!("72345")), Some(&json!("go")))), SLOW);
        // the provider refuses: kept failed with its code, still answered
        let refusing = Fake::new(r#"{"status":"limit_reached"}"#);
        let h = hub(Some(refusing.url.as_str()));
        let (sa, _) = hello(&h, &ann);
        let failed = h.sms_send(&sa, &ann, Some(&json!(OTHER)), Some(&json!("hi"))).unwrap();
        assert_eq!((&failed["status"], &failed["error"]), (&json!("failed"), &json!("limit_reached")));
        assert_eq!(thread(&h, "ann@x", OTHER), vec![Value::Object(failed)]);
        // the API cannot be reached: 502, nothing kept
        let unreachable = format!("http://127.0.0.1:{}/api", closed_port());
        let h = hub(Some(unreachable.as_str()));
        let (sa, _) = hello(&h, &ann);
        assert_eq!(refusal(h.sms_send(&sa, &ann, Some(&json!(OTHER)), Some(&json!("hi")))), NOT_SENT);
        assert!(thread(&h, "ann@x", OTHER).is_empty());
        // texting not set up
        let h = hub(None);
        let (sa, _) = hello(&h, &ann);
        assert_eq!(refusal(h.sms_send(&sa, &ann, Some(&json!(OTHER)), Some(&json!("hi")))), NOT_SET_UP);
    }

    #[test]
    fn threads_history_and_read_marks_are_the_owners() {
        let h = hub(Some("http://127.0.0.1:9/api"));
        let (ann, ann2, ben) = (person("ann@x", "aaaaaaaaaaaaaaaa"), person("ann@x", "a2a2a2a2a2a2a2a2"), person("ben@x", "bbbbbbbbbbbbbbbb"));
        let (sa, _) = hello(&h, &ann);
        let (sa2, _) = hello(&h, &ann2);
        let (sb, _) = hello(&h, &ben);
        for (from, text) in [("3055550147", "one"), ("3055550147", "two"), ("72345", "code"), ("3055550147", "three")] {
            assert!(h.sms_inbound(&query(&[("to", "9415550100"), ("from", from), ("message", text)])));
        }
        let threads = h.sms_threads(&sa, &ann).unwrap();
        let list = threads["threads"].as_array().unwrap();
        assert_eq!(list.iter().map(|t| t["number"].clone()).collect::<Vec<_>>(), vec![json!(OTHER), json!("72345")], "newest first");
        assert_eq!((&list[0]["last"]["text"], &list[0]["last"]["dir"], &list[0]["unread"]), (&json!("three"), &json!("in"), &json!(3)));
        assert_eq!(h.sms_threads(&sb, &ben).unwrap()["threads"], json!([]), "only the owner sees a thread");
        // history: oldest first, after a ts, the newest `limit`
        let all = h.sms_history(&sa, &ann, OTHER, "0", "50").unwrap()["messages"].as_array().unwrap().clone();
        assert_eq!(all.iter().map(|m| m["text"].clone()).collect::<Vec<_>>(), vec![json!("one"), json!("two"), json!("three")]);
        let first = all[0]["ts"].as_f64().unwrap();
        let after = h.sms_history(&sa, &ann, OTHER, &first.to_string(), "50").unwrap();
        assert_eq!(after["messages"].as_array().unwrap().len(), 2);
        let newest = h.sms_history(&sa, &ann, OTHER, "0", "1").unwrap();
        assert_eq!(newest["messages"][0]["text"], json!("three"));
        assert_eq!(h.sms_history(&sb, &ben, OTHER, "0", "50").unwrap()["messages"], json!([]));
        assert_eq!(refusal(h.sms_history(&sa, &ann, "nope", "0", "50")), BAD_NUMBER);
        // read: the mark moves forward, the other sessions hear it, unread counts what came after
        let second = all[1]["ts"].as_f64().unwrap();
        h.sms_read(&sa, &ann, Some(&json!(OTHER)), Some(&json!(second))).unwrap();
        let read = inbox(&h, &sa2, "read");
        assert_eq!((&read[0]["conv"], &read[0]["ts"]), (&json!(format!("sms:{OTHER}")), &json!(second)));
        assert!(inbox(&h, &sa, "read").is_empty(), "not the session that read");
        assert_eq!(h.sms_threads(&sa, &ann).unwrap()["threads"][0]["unread"], json!(1));
        h.sms_read(&sa, &ann, Some(&json!(OTHER)), Some(&json!(first))).unwrap();
        assert_eq!(inbox(&h, &sa2, "read").len(), 1, "a mark never moves back");
        assert_eq!(h.st.lock().sms_reads("ann@x")[&format!("sms:{OTHER}")], json!(second));
        assert_eq!(refusal(h.sms_read(&sa, &ann, Some(&json!(7)), Some(&json!(1.0)))), BAD_NUMBER);
    }
}
