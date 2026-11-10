// Phase C (ADR-0540): what the Meet relay (relay/meet_relay.py) gets from Python itself. json.dumps text (`, ` and
// `: ` separators, ensure_ascii, float repr), the truthiness and str() of a JSON value as the handlers read request
// fields, base64, random tokens (secrets.token_hex, token_urlsafe) and the two clocks.

use serde_json::{Map, Number, Value};
use std::sync::LazyLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub type Obj = Map<String, Value>;

// ── json.dumps ───────────────────────────────────────────────────────────────────────────────────────────────

/// repr() of a float, as json.dumps writes it: the shortest digits that read back, fixed notation from 1e-4 up to
/// 1e16, exponent notation (`1e-05`, `1.5e+16`) outside that, `.0` on a whole number.
pub fn float_repr(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let decpt = exp + 1;
    let sign = if x < 0.0 { "-" } else { "" };
    if decpt > -4 && decpt <= 16 {
        let n = digits.len() as i32;
        let body = if decpt <= 0 {
            format!("0.{}{}", "0".repeat((-decpt) as usize), digits)
        } else if decpt >= n {
            format!("{}{}.0", digits, "0".repeat((decpt - n) as usize))
        } else {
            format!("{}.{}", &digits[..decpt as usize], &digits[decpt as usize..])
        };
        format!("{sign}{body}")
    } else {
        let (first, rest) = digits.split_at(1);
        let m = if rest.is_empty() { first.to_string() } else { format!("{first}.{rest}") };
        let e = exp.abs();
        format!("{sign}{m}e{}{}{e}", if exp < 0 { '-' } else { '+' }, if e < 10 { "0" } else { "" })
    }
}

fn number_text(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        i.to_string()
    } else if let Some(u) = n.as_u64() {
        u.to_string()
    } else {
        float_repr(n.as_f64().unwrap_or(0.0))
    }
}

/// A JSON string as json.dumps writes it (`ensure_ascii` true: everything past `~` as \uXXXX, lower-case hex).
pub fn string_text(s: &str, ensure_ascii: bool, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (ensure_ascii && (c as u32) > 0x7e) => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_value(v: &Value, item_sep: &str, key_sep: &str, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_text(n)),
        Value::String(s) => string_text(s, true, out),
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_value(item, item_sep, key_sep, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, item)) in o.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                string_text(k, true, out);
                out.push_str(key_sep);
                write_value(item, item_sep, key_sep, out);
            }
            out.push('}');
        }
    }
}

/// json.dumps(v) with its defaults.
pub fn dumps(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, ", ", ": ", &mut out);
    out
}

/// json.dumps(v, separators=(",", ":")).
pub fn dumps_compact(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, ",", ":", &mut out);
    out
}

fn write_indented(v: &Value, indent: usize, level: usize, out: &mut String) {
    let pad = |n: usize, out: &mut String| out.push_str(&" ".repeat(indent * n));
    match v {
        Value::Array(a) if !a.is_empty() => {
            out.push_str("[\n");
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                pad(level + 1, out);
                write_indented(item, indent, level + 1, out);
            }
            out.push('\n');
            pad(level, out);
            out.push(']');
        }
        Value::Object(o) if !o.is_empty() => {
            out.push_str("{\n");
            for (i, (k, item)) in o.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                pad(level + 1, out);
                string_text(k, true, out);
                out.push_str(": ");
                write_indented(item, indent, level + 1, out);
            }
            out.push('\n');
            pad(level, out);
            out.push('}');
        }
        other => write_value(other, ", ", ": ", out),
    }
}

/// json.dumps(v, indent=n).
pub fn dumps_indent(v: &Value, indent: usize) -> String {
    let mut out = String::new();
    write_indented(v, indent, 0, &mut out);
    out
}

/// json.dumps(text, ensure_ascii=False) of one string.
pub fn quote_text(s: &str) -> String {
    let mut out = String::new();
    string_text(s, false, &mut out);
    out
}

// ── Python's view of a JSON value ────────────────────────────────────────────────────────────────────────────

/// bool(v).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// repr() of a value inside a list or dict (str() of a list uses it).
fn repr(v: &Value) -> String {
    match v {
        Value::String(s) => {
            let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
            let mut out = String::new();
            out.push(q);
            for c in s.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if c == q => {
                        out.push('\\');
                        out.push(c);
                    }
                    c => out.push(c),
                }
            }
            out.push(q);
            out
        }
        other => py_str(other),
    }
}

/// str(v).
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Number(n) => number_text(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => format!("[{}]", a.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", repr(&Value::String(k.clone())), repr(v))).collect::<Vec<_>>().join(", ")),
    }
}

/// str(v or "").
pub fn str_or(v: Option<&Value>) -> String {
    if truthy(v) {
        py_str(v.unwrap_or(&Value::Null))
    } else {
        String::new()
    }
}

/// An int that is not a bool (isinstance(v, int) and not isinstance(v, bool)).
pub fn as_int(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) if !n.is_f64() => n.as_i64(),
        _ => None,
    }
}

/// A finite int or float that is not a bool.
pub fn as_num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        _ => None,
    }
}

/// `x.get(key, 0)` of a number (anything else is 0, as the comparisons the relay makes treat it).
pub fn num(o: &Obj, key: &str) -> f64 {
    as_num(o.get(key)).unwrap_or(0.0)
}

/// `str(x.get(key) or "")`.
pub fn s(o: &Obj, key: &str) -> String {
    str_or(o.get(key))
}

/// `x.get(key)` as a string when it is one, else "".
pub fn text_of(o: &Obj, key: &str) -> String {
    o.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub fn f(x: f64) -> Value {
    Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

/// An object from (key, value) pairs, in order.
pub fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Obj {
    let mut o = Obj::new();
    for (k, v) in pairs {
        o.insert(k.to_string(), v);
    }
    o
}

/// dict(base, **extra): a copy with these keys set (an existing key keeps its place).
pub fn with(base: &Obj, extra: Obj) -> Obj {
    let mut o = base.clone();
    for (k, v) in extra {
        o.insert(k, v);
    }
    o
}

/// " ".join(str(x).split()).
pub fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// text[:n] in characters.
pub fn clip(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

pub fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// str.isprintable(): no control, separator (other than the space) or unassigned-looking characters.
pub fn printable(text: &str) -> bool {
    text.chars().all(|c| c == ' ' || !(c.is_control() || c.is_whitespace() || matches!(c as u32, 0xad | 0x200b..=0x200f | 0x2028..=0x202e | 0x2060..=0x206f | 0xfeff | 0xfff9..=0xfffb | 0xe000..=0xf8ff)))
}

// ── base64, random, clocks ───────────────────────────────────────────────────────────────────────────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn b64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Strict standard base64 (base64.b64decode(..., validate=True)): None on anything outside the alphabet or a
/// wrong padding.
pub fn b64_strict(text: &str) -> Option<Vec<u8>> {
    let t = text.as_bytes();
    if t.len() % 4 != 0 {
        return None;
    }
    let pads = t.iter().rev().take_while(|&&c| c == b'=').count();
    if pads > 2 || t[..t.len() - pads].iter().any(|&c| !(c.is_ascii_alphanumeric() || c == b'+' || c == b'/')) {
        return None;
    }
    Some(crate::codec::b64_decode_lenient(&text[..t.len() - pads]))
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    let _ = aws_lc_rs::rand::fill(&mut buf);
    buf
}

/// secrets.token_hex(n).
pub fn token_hex(n: usize) -> String {
    crate::codec::hex(&random_bytes(n))
}

/// secrets.token_urlsafe(n).
pub fn token_urlsafe(n: usize) -> String {
    crate::codec::b64u(&random_bytes(n))
}

/// time.time().
pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// time.monotonic(): seconds since the process started (only differences are used). Starts at 1e6 so "never" can
/// be -1e9 as in the relay.
pub fn mono() -> f64 {
    START.elapsed().as_secs_f64() + 1e6
}

/// Days since 1970-01-01 to (year, month, day).
pub fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (year, month, day) to days since 1970-01-01.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// datetime.isoformat() of a UTC time in whole seconds: `2026-11-09T12:00:00+00:00`.
pub fn iso_utc(secs: i64) -> String {
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}+00:00", t / 3600, t / 60 % 60, t % 60)
}

/// datetime.date() of a UTC time: `2026-11-09`.
pub fn iso_date(secs: i64) -> String {
    let (y, m, d) = civil(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// datetime.fromisoformat(text).timestamp() for the forms the signer writes (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS[.f]]`
/// with an optional `Z` or `+HH:MM` offset); a time without an offset is read as UTC.
pub fn from_iso(text: &str) -> Option<f64> {
    let t = text.trim();
    let b = t.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = t.get(0..4)?.parse().ok()?;
    let mo: u32 = t.get(5..7)?.parse().ok()?;
    let d: u32 = t.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut secs = days_from_civil(y, mo, d) as f64 * 86_400.0;
    let rest = &t[10..];
    if rest.is_empty() {
        return Some(secs);
    }
    let rest = rest.strip_prefix(['T', ' '])?;
    let (clock, offset) = match rest.find(['Z', '+', '-']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let mut parts = clock.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let mi: f64 = parts.next().unwrap_or("0").parse().ok()?;
    let sec: f64 = parts.next().unwrap_or("0").parse().ok()?;
    secs += h * 3600.0 + mi * 60.0 + sec;
    if offset == "Z" || offset.is_empty() {
        return Some(secs);
    }
    let sign = if offset.starts_with('-') { -1.0 } else { 1.0 };
    let mut o = offset[1..].split(':');
    let oh: f64 = o.next()?.parse().ok()?;
    let om: f64 = o.next().unwrap_or("0").parse().ok()?;
    Some(secs - sign * (oh * 3600.0 + om * 60.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_print_as_python_repr() {
        assert_eq!(float_repr(1.0), "1.0");
        assert_eq!(float_repr(0.0001), "0.0001");
        assert_eq!(float_repr(0.00001), "1e-05");
        assert_eq!(float_repr(1e16), "1e+16");
        assert_eq!(float_repr(1.5e16), "1.5e+16");
        assert_eq!(float_repr(9999999999999998.0), "9999999999999998.0");
        assert_eq!(float_repr(1731170000.123456), "1731170000.123456");
        assert_eq!(float_repr(-2.5), "-2.5");
        assert_eq!(float_repr(123456.0), "123456.0");
    }

    #[test]
    fn dumps_matches_python_defaults() {
        let v = json!({"a": 1, "b": [1.5, "é\n", null, true], "c": {}});
        assert_eq!(dumps(&v), "{\"a\": 1, \"b\": [1.5, \"\\u00e9\\n\", null, true], \"c\": {}}");
        assert_eq!(dumps_compact(&json!({"f": "x", "e": 2})), "{\"f\":\"x\",\"e\":2}");
        assert_eq!(dumps(&json!("\u{1F44D}")), "\"\\ud83d\\udc4d\"");
        assert_eq!(dumps_indent(&json!({"a": [1], "b": {}}), 1), "{\n \"a\": [\n  1\n ],\n \"b\": {}\n}");
    }

    #[test]
    fn python_str_and_truthiness() {
        assert_eq!(str_or(Some(&json!(0))), "");
        assert_eq!(str_or(Some(&json!(5))), "5");
        assert_eq!(str_or(Some(&json!(true))), "True");
        assert_eq!(py_str(&json!(["a", 1])), "['a', 1]");
        assert!(!truthy(Some(&json!({}))));
    }

    #[test]
    fn base64_and_dates() {
        assert_eq!(b64(b"ab"), "YWI=");
        assert_eq!(b64_strict("YWI="), Some(b"ab".to_vec()));
        assert_eq!(b64_strict("YW I="), None);
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00+00:00");
        assert_eq!(days_from_civil(2026, 11, 9), 20_766);
        assert_eq!(civil(20_766), (2026, 11, 9));
        assert_eq!(from_iso("1970-01-02T00:00:00+00:00"), Some(86_400.0));
    }
}
