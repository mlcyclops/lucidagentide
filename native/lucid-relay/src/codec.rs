// Encoding helpers with the exact semantics of the add-on's src/codec.ts and of the JavaScript built-ins it leans on
// (Buffer base64url decoding, JSON.parse and JSON.stringify of plain values, Number to string), so the relay reads and
// writes the same bytes as the Bun relay.

use serde_json::{Map, Value};

/// Number.MAX_SAFE_INTEGER.
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn b64_value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Node's lenient base64 decoder (either alphabet): stops at the first `=`, skips anything outside the alphabet, and a
/// trailing lone character adds nothing.
pub fn b64_decode_lenient(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = b64_value(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// Strict base64url decode (codec.ts unb64u): anything outside the alphabet is None, never a partial decode.
pub fn unb64u(s: &str) -> Option<Vec<u8>> {
    if !s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return None;
    }
    Some(b64_decode_lenient(s))
}

const B64U: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding (Buffer.toString("base64url")).
pub fn b64u(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = chunk.len();
        let b = [chunk[0], if n > 1 { chunk[1] } else { 0 }, if n > 2 { chunk[2] } else { 0 }];
        let v = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64U[(v >> 18) as usize & 63] as char);
        out.push(B64U[(v >> 12) as usize & 63] as char);
        if n > 1 {
            out.push(B64U[(v >> 6) as usize & 63] as char);
        }
        if n > 2 {
            out.push(B64U[v as usize & 63] as char);
        }
    }
    out
}

/// SHA-256 on AWS-LC (its FIPS module with the `fips` feature).
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let d = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(d.as_ref());
    out
}

pub fn hex(data: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&sha256(data))
}

/// Text as Node's Buffer.toString("utf8") gives it: invalid sequences become U+FFFD.
pub fn utf8_lossy(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

/// JSON.parse, or None. Numbers that JavaScript holds as safe integers are kept as integers, so a value written back
/// (JSON.stringify) is the same text the Bun relay writes (`1.0` and `1e3` read back as `1` and `1000`).
pub fn parse_json(raw: &str) -> Option<Value> {
    let mut v: Value = serde_json::from_str(raw).ok()?;
    normalize_numbers(&mut v);
    Some(v)
}

fn normalize_numbers(v: &mut Value) {
    match v {
        Value::Number(n) if n.is_f64() => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64 {
                *v = Value::from(f as i64);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(normalize_numbers),
        Value::Object(o) => o.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

/// A plain JSON object (not null, not an array), or None.
pub fn as_object(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

/// True when `o` has only keys from `allowed` and every key in `required`.
pub fn exact_keys(o: &Map<String, Value>, allowed: &[&str], required: &[&str]) -> bool {
    o.keys().all(|k| allowed.contains(&k.as_str())) && required.iter().all(|k| o.contains_key(*k))
}

/// Number.isSafeInteger: a number with no fraction and at most 2^53 - 1 either way.
pub fn safe_int(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_number()?;
    if let Some(i) = n.as_i64() {
        return (i.unsigned_abs() <= MAX_SAFE as u64).then_some(i);
    }
    if n.is_u64() {
        return None;
    }
    let f = n.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64).then_some(f as i64)
}

/// identity.ts isInt: a safe integer, zero or more.
pub fn is_int(v: Option<&Value>) -> Option<i64> {
    safe_int(v).filter(|i| *i >= 0)
}

/// `v === n` for a JSON number.
pub fn num_is(v: Option<&Value>, n: f64) -> bool {
    v.and_then(Value::as_f64) == Some(n)
}

pub fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// String length as JavaScript counts it (UTF-16 code units).
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` in UTF-16 code units, never splitting a character.
pub fn utf16_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// The characters JavaScript's `\s` and String.prototype.trim treat as white space.
pub fn is_js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// Number(text) for the strings a flag or an environment variable carries.
pub fn js_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, r: u32| -> f64 {
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut v = 0f64;
        for c in digits.chars() {
            match c.to_digit(r) {
                Some(d) => v = v * r as f64 + d as f64,
                None => return f64::NAN,
            }
        }
        v
    };
    let lower = t.to_ascii_lowercase();
    if let Some(d) = lower.strip_prefix("0x") {
        return radix(d, 16);
    }
    if let Some(d) = lower.strip_prefix("0o") {
        return radix(d, 8);
    }
    if let Some(d) = lower.strip_prefix("0b") {
        return radix(d, 2);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if !t.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Number.isInteger.
pub fn js_is_integer(f: f64) -> bool {
    f.is_finite() && f.fract() == 0.0
}

/// A number as JavaScript prints it (Number.prototype.toString, the form `${n}` gives).
pub fn js_number_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x < 0.0 {
        return format!("-{}", js_number_string(-x));
    }
    // Shortest round-trip digits and the decimal exponent, then ECMAScript's layout rules.
    let e = format!("{x:e}");
    let (mantissa, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n - 1 < 0 { "-" } else { "+" };
        let rest = if k == 1 { String::new() } else { format!(".{}", &digits[1..]) };
        format!("{}{rest}e{sign}{}", &digits[..1], (n - 1).abs())
    }
}

/// JSON.stringify of a plain value (serde_json writes the same text for the values the relay handles).
pub fn stringify(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

/// Milliseconds since the epoch as Date.prototype.toISOString prints them.
pub fn iso_time(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_is_strict_on_the_alphabet_and_lenient_on_length() {
        assert_eq!(unb64u("aGVsbG8"), Some(b"hello".to_vec()));
        assert_eq!(unb64u("aGVsbG8="), None);
        assert_eq!(unb64u("a+b"), None);
        assert_eq!(unb64u(""), Some(vec![]));
        assert_eq!(unb64u("a"), Some(vec![])); // a lone trailing character adds nothing, as in Node
        assert_eq!(b64u(b"hello"), "aGVsbG8");
        assert_eq!(b64_decode_lenient("MCowBQ=="), vec![0x30, 0x2a, 0x30, 0x05]);
    }

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        for (x, s) in [
            (1731000000000.0, "1731000000000"),
            (1.5, "1.5"),
            (1e21, "1e+21"),
            (1.25e-7, "1.25e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (-42.0, "-42"),
        ] {
            assert_eq!(js_number_string(x), s);
        }
        assert_eq!(js_number(" 8443 "), 8443.0);
        assert_eq!(js_number("0x50"), 80.0);
        assert!(js_number("lots").is_nan());
        assert!(js_number("inf").is_nan());
    }

    #[test]
    fn json_numbers_read_back_as_integers() {
        let v = parse_json(r#"{"v":1.0,"ts":1.7e12,"x":1.5}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"v":1,"ts":1700000000000,"x":1.5}"#);
        assert_eq!(safe_int(v.get("ts")), Some(1_700_000_000_000));
        assert_eq!(safe_int(v.get("x")), None);
        // i64::MIN has no absolute value in i64: it is refused, never an overflow.
        assert_eq!(safe_int(Some(&Value::from(i64::MIN))), None);
        assert_eq!(safe_int(parse_json("-9223372036854775808").as_ref()), None);
        assert_eq!(safe_int(Some(&Value::from(-MAX_SAFE))), Some(-MAX_SAFE));
        assert_eq!(safe_int(Some(&Value::from(-MAX_SAFE - 1))), None);
    }

    #[test]
    fn sha256_is_the_standard_digest() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn iso_time_matches_to_iso_string() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_793_000_123_456), "2026-10-26T07:35:23.456Z");
    }
}
