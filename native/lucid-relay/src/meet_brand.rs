// Contract TH-1 (Meeting Hub docs/theme/contract-th1.md): an organization's brand for the guest portal (`/g/`), the
// members' web client (`/w/`) and the account pages (`/meet/join`, `/meet/signin`). Without a brand every surface
// shows the standard Lucid theme. The brand is a small JSON document (`brand.json`) and an optional logo
// (`brand-logo`) in the relay's state folder, set only through the Admin Console; the guest and web ports answer it
// with no session, before the license gate and MR-1's admission, like the page files. On an MR-1 cluster both files
// are in the replica set. The fleet console keeps its own copy (`meet-brand.json`, `meet-brand-logo`) for the account
// pages it serves.
//
// Validation (3), the same rules as meet_relay.py (tests/test_meet_relay_conformance_brand.py checks both): the whole
// document is refused with the first problem in words. `v` the integer 1; no unknown key; `name` 1 to 60 code points
// once Unicode white space runs are one space and trimmed, no Cc or Cf character, no `<` or `>`; `accent` `#rrggbb`
// in lower case whose better text color (white, or near-black, white on a tie) reaches 4.5:1 and which itself reaches
// 3:1 on the dark background; `mode` auto, dark or light (absent is auto, null is refused); `welcome` at most 200 code
// points by the name's text rule; `support` printable ASCII of at most 300 characters, an https:// link with no `@`
// in its host part or mailto: and one address; the logo PNG, JPEG or WebP by its magic bytes, at most 256 KiB, 32 to
// 1024 pixels a side by its header. A stored document naming a logo the file does not match is no brand at all.

use crate::meet_json::squash;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::Path;

type Obj = Map<String, Value>;

/// Where a brand lives: the document and the logo beside it.
pub struct Files {
    pub doc: &'static str,
    pub logo: &'static str,
}

/// A relay's state folder (both files in the MR-1 replica set).
pub const RELAY_FILES: Files = Files { doc: "brand.json", logo: "brand-logo" };
/// The fleet console's state folder: its own copy for the account pages.
pub const CONSOLE_FILES: Files = Files { doc: "meet-brand.json", logo: "meet-brand-logo" };
/// The largest logo (decoded bytes), and the largest base64 text of one the console takes before decoding.
pub const LOGO_MAX: usize = 256 * 1024;
pub const LOGO_B64_MAX: usize = 350 * 1024;
/// The console's logo write body: the base64 text, its type and the step-up.
pub const LOGO_BODY_MAX: usize = LOGO_B64_MAX + 4096;
/// The largest brand document read back (a valid one is well under 2 KiB).
const DOC_MAX: usize = 16 * 1024;
const NAME_MAX: usize = 60;
const WELCOME_MAX: usize = 200;
const SUPPORT_MAX: usize = 300;
const SIDE_MIN: u32 = 32;
const SIDE_MAX: u32 = 1024;
/// The dark theme's `--bg` and the two text colors an accent may carry.
const DARK_BG: &str = "#0a0b0f";
const WHITE: &str = "#ffffff";
pub const MODES: [&str; 3] = ["auto", "dark", "light"];
pub const TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];
/// The document's keys (3), the console's field write and the console's logo write.
const DOC_KEYS: [&str; 9] = ["v", "name", "accent", "mode", "welcome", "support", "logo", "updated", "by"];
const LOGO_DOC_KEYS: [&str; 5] = ["type", "sha256", "bytes", "w", "h"];
pub const FIELD_KEYS: [&str; 6] = ["name", "accent", "mode", "welcome", "support", "reason"];
pub const LOGO_KEYS: [&str; 3] = ["type", "data", "remove"];
/// The 404 of a logo read without a logo.
pub const NO_LOGO: &str = "this organization has no logo";
const CACHE_LONG: &str = "public, max-age=86400";
const CACHE_CHECK: &str = "no-cache";

/// The stored logo's facts (`logo` of the document).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Logo {
    pub ctype: &'static str,
    pub sha256: String,
    pub bytes: usize,
    pub w: u32,
    pub h: u32,
}

/// A checked brand document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Brand {
    pub name: String,
    pub accent: String,
    /// `#ffffff` or `#0a0b0f`, derived from `accent` (never stored).
    pub on_accent: &'static str,
    pub mode: &'static str,
    pub welcome: Option<String>,
    pub support: Option<String>,
    pub logo: Option<Logo>,
    /// Milliseconds; written by the relay or console, never taken from a write.
    pub updated: i64,
    pub by: String,
}

// ── the rules (3) ────────────────────────────────────────────────────────────────────────────────────────────

fn rgb(hex: &str) -> Option<[u8; 3]> {
    let h = hex.strip_prefix('#')?;
    if h.len() != 6 || !h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return None;
    }
    let at = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([at(0)?, at(2)?, at(4)?])
}

/// WCAG 2 relative luminance of an sRGB color.
fn luminance(c: [u8; 3]) -> f64 {
    let lin = |v: u8| {
        let s = f64::from(v) / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

/// The WCAG contrast ratio of two `#rrggbb` colors (lower case), or None for anything else.
pub fn contrast(a: &str, b: &str) -> Option<f64> {
    let (x, y) = (luminance(rgb(a)?), luminance(rgb(b)?));
    let (hi, lo) = if x >= y { (x, y) } else { (y, x) };
    Some((hi + 0.05) / (lo + 0.05))
}

/// `(accent, onAccent)`: the text color with the higher contrast (white on a tie), refused below 4.5:1, and the
/// accent refused below 3:1 against the dark background.
pub fn check_accent(v: Option<&str>) -> Result<(String, &'static str), String> {
    let accent = v.unwrap_or_default();
    if rgb(accent).is_none() {
        return Err("accent must be a color written #rrggbb in lower case".into());
    }
    let (white, dark) = (contrast(accent, WHITE).unwrap_or(0.0), contrast(accent, DARK_BG).unwrap_or(0.0));
    let (on, best) = if white >= dark { (WHITE, white) } else { (DARK_BG, dark) };
    if best < 4.5 {
        return Err(format!("accent {accent} leaves button text too faint: {best:.2}:1 at best, and 4.5:1 is needed"));
    }
    if dark < 3.0 {
        return Err(format!("accent {accent} is too dark to see on the dark background: {dark:.2}:1, and 3:1 is needed"));
    }
    Ok((accent.to_string(), on))
}

/// Unicode general category Cf (format characters, Unicode 15.1). Cc is `char::is_control`; Cs never occurs in a
/// Rust string.
fn is_format(c: char) -> bool {
    matches!(c as u32,
        0x00ad | 0x0600..=0x0605 | 0x061c | 0x06dd | 0x070f | 0x0890..=0x0891 | 0x08e2 | 0x180e | 0x200b..=0x200f | 0x202a..=0x202e
        | 0x2060..=0x2064 | 0x2066..=0x206f | 0xfeff | 0xfff9..=0xfffb | 0x110bd | 0x110cd | 0x13430..=0x1343f | 0x1bca0..=0x1bca3
        | 0x1d173..=0x1d17a | 0xe0001 | 0xe0020..=0xe007f)
}

/// Runs of Unicode White_Space collapsed to one space and trimmed; refused with any Cc or Cf character. Lengths are
/// in code points.
fn plain_text(key: &str, v: Option<&str>) -> Result<String, String> {
    let text = squash(v.unwrap_or_default());
    if text.chars().any(|c| c.is_control() || is_format(c)) {
        return Err(format!("{key} must be plain text without control or format characters"));
    }
    Ok(text)
}

pub fn check_name(v: Option<&str>) -> Result<String, String> {
    let name = plain_text("name", v)?;
    let n = name.chars().count();
    if n == 0 || n > NAME_MAX {
        return Err(format!("name must be 1 to {NAME_MAX} characters"));
    }
    if name.contains(['<', '>']) {
        return Err("name must not contain < or >".into());
    }
    Ok(name)
}

/// `mode` absent is auto; null or any other value than auto, dark or light is refused.
pub fn check_mode(v: Option<&Value>) -> Result<&'static str, String> {
    match v {
        None => Ok("auto"),
        Some(Value::String(m)) => MODES.iter().copied().find(|x| *x == m.as_str()).ok_or_else(|| "mode must be auto, dark or light".to_string()),
        Some(_) => Err("mode must be auto, dark or light".into()),
    }
}

/// At most 200 characters of plain text on one line; None when empty.
pub fn check_welcome(v: Option<&str>) -> Result<Option<String>, String> {
    let w = plain_text("welcome", v)?;
    if w.is_empty() {
        return Ok(None);
    }
    if w.chars().count() > WELCOME_MAX {
        return Err(format!("welcome must be at most {WELCOME_MAX} characters"));
    }
    Ok(Some(w))
}

/// One label of a mail domain: letters, digits and inner hyphens, 1 to 63 characters.
fn label_ok(l: &str) -> bool {
    (1..=63).contains(&l.len()) && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') && !l.starts_with('-') && !l.ends_with('-')
}

/// One address: a local part of letters, digits and .!#$%&'*+/=^_`{|}~- then @ and two or more labels.
fn mail_ok(addr: &str) -> bool {
    let Some((local, domain)) = addr.split_once('@') else { return false };
    let local_ok = !local.is_empty() && local.bytes().all(|c| c.is_ascii_alphanumeric() || b".!#$%&'*+/=^_`{|}~-".contains(&c));
    let labels: Vec<&str> = domain.split('.').collect();
    local_ok && labels.len() >= 2 && labels.iter().all(|l| label_ok(l))
}

/// Printable ASCII, at most 300 characters: an https:// link with no `@` in its host part, or mailto: and exactly
/// one address; None when empty.
pub fn check_support(v: Option<&str>) -> Result<Option<String>, String> {
    let s = v.unwrap_or_default().trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.len() > SUPPORT_MAX || !s.bytes().all(|c| (0x20..=0x7e).contains(&c)) {
        return Err(format!("support must be at most {SUPPORT_MAX} printable ASCII characters"));
    }
    if let Some(rest) = s.strip_prefix("https://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if host.contains('@') {
            return Err("support must not carry a user name or password".into());
        }
        if host.is_empty() {
            return Err("support must name a host after https://".into());
        }
        return Ok(Some(s.to_string()));
    }
    if let Some(addr) = s.strip_prefix("mailto:") {
        if !mail_ok(addr) {
            return Err("support must be mailto: and one email address".into());
        }
        return Ok(Some(s.to_string()));
    }
    Err("support must be an https:// link or a mailto: address".into())
}

fn be16(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?])))
}

fn le16(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?])))
}

fn le24(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from(*b.get(i)?) | u32::from(*b.get(i + 1)?) << 8 | u32::from(*b.get(i + 2)?) << 16)
}

fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    loop {
        if *b.get(i)? != 0xff {
            return None;
        }
        // fill bytes before the marker
        while *b.get(i + 1)? == 0xff {
            i += 1;
        }
        let m = *b.get(i + 1)?;
        i += 2;
        if m == 0x01 || (0xd0..=0xd8).contains(&m) {
            continue;
        }
        if m == 0xd9 || m == 0xda {
            return None; // the image ends or its data starts before any frame header
        }
        let len = be16(b, i)? as usize;
        if len < 2 {
            return None;
        }
        // the first SOF0 to SOF15, not DHT (c4), JPG (c8) or DAC (cc): precision, height, width (a header-only file
        // needs nothing after them)
        if (0xc0..=0xcf).contains(&m) && !matches!(m, 0xc4 | 0xc8 | 0xcc) {
            return Some((be16(b, i + 5)?, be16(b, i + 3)?));
        }
        if i + len > b.len() {
            return None;
        }
        i += len;
    }
}

fn webp_size(b: &[u8]) -> Option<(u32, u32)> {
    match b.get(12..16)? {
        b"VP8 " => {
            if b.get(23..26)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            Some((le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff))
        }
        b"VP8L" => {
            if *b.get(20)? != 0x2f {
                return None;
            }
            let (b1, b2, b3, b4) = (u32::from(*b.get(21)?), u32::from(*b.get(22)?), u32::from(*b.get(23)?), u32::from(*b.get(24)?));
            Some((1 + (b1 | (b2 & 0x3f) << 8), 1 + (b2 >> 6 | b3 << 2 | (b4 & 0x0f) << 10)))
        }
        b"VP8X" => Some((1 + le24(b, 24)?, 1 + le24(b, 27)?)),
        _ => None,
    }
}

/// The image type by its magic bytes and its size from its header; PNG, JPEG and WebP only.
pub fn image_info(b: &[u8]) -> Result<(&'static str, u32, u32), String> {
    let unreadable = |kind: &str| format!("the logo is not a readable {kind} image");
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        if b.get(12..16) != Some(b"IHDR".as_slice()) {
            return Err(unreadable("PNG"));
        }
        let at = |i: usize| b.get(i..i + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]]));
        return match (at(16), at(20)) {
            (Some(w), Some(h)) => Ok(("image/png", w, h)),
            _ => Err(unreadable("PNG")),
        };
    }
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        return jpeg_size(b).map(|(w, h)| ("image/jpeg", w, h)).ok_or_else(|| unreadable("JPEG"));
    }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return webp_size(b).map(|(w, h)| ("image/webp", w, h)).ok_or_else(|| unreadable("WebP"));
    }
    let head = String::from_utf8_lossy(&b[..b.len().min(1024)]).to_ascii_lowercase();
    if head.trim_start_matches('\u{feff}').trim_start().starts_with('<') || head.contains("<svg") {
        return Err("SVG logos are refused: use a PNG, JPEG or WebP image".into());
    }
    Err("the logo must be a PNG, JPEG or WebP image".into())
}

/// A logo's facts, refused past 256 KiB, for another type, or outside 32 to 1024 pixels a side.
pub fn check_logo(b: &[u8]) -> Result<Logo, String> {
    if b.is_empty() {
        return Err("the logo is empty".into());
    }
    if b.len() > LOGO_MAX {
        return Err("the logo is larger than 256 KiB".into());
    }
    let (ctype, w, h) = image_info(b)?;
    if !(SIDE_MIN..=SIDE_MAX).contains(&w) || !(SIDE_MIN..=SIDE_MAX).contains(&h) {
        return Err(format!("the logo is {w} by {h} pixels; each side must be {SIDE_MIN} to {SIDE_MAX}"));
    }
    Ok(Logo { ctype, sha256: crate::codec::sha256_hex(b), bytes: b.len(), w, h })
}

/// Strict standard base64 (padding optional, nothing outside the alphabet).
pub fn decode_b64(s: &str) -> Option<Vec<u8>> {
    let body = s.strip_suffix("==").or_else(|| s.strip_suffix('=')).unwrap_or(s);
    if body.len() % 4 == 1 {
        return None;
    }
    let value = |c: u8| -> Option<u32> {
        let v: u8 = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        Some(u32::from(v))
    };
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in body.bytes() {
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

// ── the document ─────────────────────────────────────────────────────────────────────────────────────────────

fn text<'a>(o: &'a Obj, k: &str) -> Result<Option<&'a str>, String> {
    match o.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(format!("{k} must be text")),
    }
}

fn only(o: &Obj, keys: &[&str]) -> Result<(), String> {
    match o.keys().find(|k| !keys.contains(&k.as_str())) {
        Some(k) => Err(format!("unknown key {}", squash(k).chars().take(40).collect::<String>())),
        None => Ok(()),
    }
}

fn logo_of(v: &Value) -> Result<Logo, String> {
    let bad = || "logo must be {type, sha256, bytes, w, h} of a stored PNG, JPEG or WebP image".to_string();
    let o = v.as_object().ok_or_else(bad)?;
    only(o, &LOGO_DOC_KEYS)?;
    let ctype = TYPES.iter().copied().find(|t| o.get("type").and_then(Value::as_str) == Some(*t)).ok_or_else(bad)?;
    let sha256 = o.get("sha256").and_then(Value::as_str).filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).ok_or_else(bad)?;
    let bytes = o.get("bytes").and_then(Value::as_u64).filter(|n| (1..=LOGO_MAX as u64).contains(n)).ok_or_else(bad)? as usize;
    let side = |k: &str| o.get(k).and_then(Value::as_u64).filter(|n| (u64::from(SIDE_MIN)..=u64::from(SIDE_MAX)).contains(n)).map(|n| n as u32).ok_or_else(bad);
    Ok(Logo { ctype, sha256: sha256.to_string(), bytes, w: side("w")?, h: side("h")? })
}

/// A stored document checked whole (3): `v` 1, no unknown key, every field by its rule.
pub fn from_value(v: &Value) -> Result<Brand, String> {
    let o = v.as_object().ok_or("the brand must be a JSON object")?;
    only(o, &DOC_KEYS)?;
    if o.get("v") != Some(&json!(1)) {
        return Err("v must be 1".into());
    }
    let (accent, on_accent) = check_accent(text(o, "accent")?)?;
    let logo = match o.get("logo") {
        None | Some(Value::Null) => None,
        Some(l) => Some(logo_of(l)?),
    };
    Ok(Brand {
        name: check_name(text(o, "name")?)?,
        accent,
        on_accent,
        mode: check_mode(o.get("mode"))?,
        welcome: check_welcome(text(o, "welcome")?)?,
        support: check_support(text(o, "support")?)?,
        logo,
        updated: o.get("updated").and_then(Value::as_i64).filter(|t| *t >= 0).ok_or("updated must be a time in milliseconds")?,
        by: text(o, "by")?.unwrap_or_default().to_string(),
    })
}

/// The stored document (with `updated` and `by`); absent optional fields are left out.
pub fn to_value(b: &Brand) -> Value {
    let mut o = Obj::new();
    o.insert("v".into(), json!(1));
    o.insert("name".into(), json!(b.name));
    o.insert("accent".into(), json!(b.accent));
    o.insert("mode".into(), json!(b.mode));
    if let Some(w) = &b.welcome {
        o.insert("welcome".into(), json!(w));
    }
    if let Some(s) = &b.support {
        o.insert("support".into(), json!(s));
    }
    if let Some(l) = &b.logo {
        o.insert("logo".into(), json!({"type": l.ctype, "sha256": l.sha256, "bytes": l.bytes, "w": l.w, "h": l.h}));
    }
    o.insert("updated".into(), json!(b.updated));
    o.insert("by".into(), json!(b.by));
    Value::Object(o)
}

/// The public read (4) for a surface whose logo path starts with `prefix` (`/g/`, `/w/`, `/meet/`): never `by` or
/// `updated`; `welcome`, `support` and `logo` null when absent.
pub fn public(brand: Option<&Brand>, prefix: &str) -> Value {
    let Some(b) = brand else { return json!({"brand": null}) };
    let logo = b.logo.as_ref().map(|l| format!("{prefix}brand/logo?v={}", &l.sha256[..12]));
    json!({"brand": {"name": b.name, "accent": b.accent, "onAccent": b.on_accent, "mode": b.mode, "welcome": b.welcome, "support": b.support, "logo": logo}})
}

/// The console's field write (6): `{name, accent, mode, welcome, support, reason}`; the logo stays.
pub fn with_fields(current: Option<&Brand>, input: &Obj, by: &str, t_ms: i64) -> Result<Brand, String> {
    only(input, &FIELD_KEYS)?;
    let (accent, on_accent) = check_accent(text(input, "accent")?)?;
    Ok(Brand {
        name: check_name(text(input, "name")?)?,
        accent,
        on_accent,
        mode: check_mode(input.get("mode"))?,
        welcome: check_welcome(text(input, "welcome")?)?,
        support: check_support(text(input, "support")?)?,
        logo: current.and_then(|c| c.logo.clone()),
        updated: t_ms,
        by: by.to_string(),
    })
}

/// The console's logo write (6): `{type, data}` (the image in base64) or `{remove: true}`, on a saved brand. The new
/// brand and the bytes to store (None when the logo is removed).
pub fn with_logo(current: Option<&Brand>, input: &Obj, by: &str, t_ms: i64) -> Result<(Brand, Option<Vec<u8>>), String> {
    only(input, &LOGO_KEYS)?;
    let mut b = current.cloned().ok_or("save the brand's name and color before its logo")?;
    b.updated = t_ms;
    b.by = by.to_string();
    let remove = match input.get("remove") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(x)) => *x,
        Some(_) => return Err("remove is true or false".into()),
    };
    if remove {
        if input.contains_key("data") || input.contains_key("type") {
            return Err("send a logo or remove it, not both".into());
        }
        b.logo = None;
        return Ok((b, None));
    }
    let ctype = text(input, "type")?.unwrap_or_default();
    if !TYPES.contains(&ctype) {
        return Err("type must be image/png, image/jpeg or image/webp".into());
    }
    let data = text(input, "data")?.unwrap_or_default();
    if data.len() > LOGO_B64_MAX {
        return Err("the logo is larger than 256 KiB".into());
    }
    let bytes = decode_b64(data).ok_or("data must be the image in base64")?;
    let logo = check_logo(&bytes)?;
    if logo.ctype != ctype {
        return Err(format!("the file is {}, not {ctype}", logo.ctype));
    }
    b.logo = Some(logo);
    Ok((b, Some(bytes)))
}

// ── the files ────────────────────────────────────────────────────────────────────────────────────────────────

/// A brand on disk that does not read back is served as no brand, with one warning per distinct problem.
fn warn_unreadable(path: &Path, why: &str) {
    static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
    let line = format!("brand.unreadable file={} why={}", path.display(), crate::meet::kv(why));
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if *last != line {
        crate::meet::log_warn(&format!("{line}; the standard theme is served"));
        *last = line;
    }
}

/// The stored logo's bytes checked against the document: at most 256 KiB (before any parsing), the same type by
/// magic bytes, the same size from the header, the same byte count and SHA-256.
fn stored_logo(dir: &Path, f: &Files, l: &Logo) -> Result<Vec<u8>, String> {
    let path = dir.join(f.logo);
    let size = std::fs::metadata(&path).map_err(|e| format!("{} cannot be read: {e}", f.logo))?.len();
    if size > LOGO_MAX as u64 {
        return Err(format!("{} is larger than 256 KiB", f.logo));
    }
    let raw = std::fs::read(&path).map_err(|e| format!("{} cannot be read: {e}", f.logo))?;
    let found = check_logo(&raw)?;
    if found != *l {
        return Err(format!("{} is not the logo brand.json names", f.logo));
    }
    Ok(raw)
}

/// The brand in `dir` with its logo's bytes, or None: no brand, or one that does not read back whole (a document
/// refused by section 3, over 16 KiB, or naming a logo whose file is missing or different), which serves the
/// standard theme.
pub fn load_full(dir: &Path, f: &Files) -> Option<(Brand, Option<Vec<u8>>)> {
    let path = dir.join(f.doc);
    let raw = match std::fs::read(&path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            warn_unreadable(&path, &e.to_string());
            return None;
        }
    };
    let checked = (|| -> Result<(Brand, Option<Vec<u8>>), String> {
        if raw.len() > DOC_MAX {
            return Err("larger than 16 KiB".to_string());
        }
        let brand = from_value(&serde_json::from_slice::<Value>(&raw).map_err(|e| e.to_string())?)?;
        let bytes = match &brand.logo {
            Some(l) => Some(stored_logo(dir, f, l)?),
            None => None,
        };
        Ok((brand, bytes))
    })();
    checked.map_err(|why| warn_unreadable(&path, &why)).ok()
}

/// The brand in `dir` (see `load_full`).
pub fn load(dir: &Path, f: &Files) -> Option<Brand> {
    load_full(dir, f).map(|(b, _)| b)
}

/// Write a file whole: a temporary file in the same folder, synced, then renamed over the old one.
fn write_whole(dir: &Path, name: &str, data: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    {
        let mut fh = std::fs::File::create(&tmp)?;
        fh.write_all(data)?;
        fh.sync_all()?;
    }
    std::fs::rename(&tmp, dir.join(name))
}

fn remove_file(path: &Path) -> std::io::Result<bool> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Store a brand (and, with `logo`, its new logo first, so a reader never sees a document naming bytes not yet
/// there); a brand without a logo removes the old one after its document.
pub fn save(dir: &Path, f: &Files, brand: &Brand, logo: Option<&[u8]>) -> Result<(), String> {
    let failed = |what: &str, e: std::io::Error| format!("cannot write {what} in {}: {e}", dir.display());
    if let (Some(bytes), Some(_)) = (logo, &brand.logo) {
        write_whole(dir, f.logo, bytes).map_err(|e| failed(f.logo, e))?;
    }
    let text = format!("{}\n", serde_json::to_string(&to_value(brand)).unwrap_or_default());
    write_whole(dir, f.doc, text.as_bytes()).map_err(|e| failed(f.doc, e))?;
    if brand.logo.is_none() {
        remove_file(&dir.join(f.logo)).map_err(|e| failed(f.logo, e))?;
    }
    Ok(())
}

/// Remove the brand (back to the standard theme); true when there was one.
pub fn remove(dir: &Path, f: &Files) -> Result<bool, String> {
    let had = remove_file(&dir.join(f.doc)).map_err(|e| format!("cannot remove {} in {}: {e}", f.doc, dir.display()))?;
    remove_file(&dir.join(f.logo)).map_err(|e| format!("cannot remove {} in {}: {e}", f.logo, dir.display()))?;
    Ok(had)
}

// ── the public reads (4) ─────────────────────────────────────────────────────────────────────────────────────

/// One public brand answer: the JSON read, the logo bytes, or 404 without a logo.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    Json(Value),
    Logo { ctype: &'static str, cache: &'static str, bytes: Vec<u8> },
    NoLogo,
}

/// `GET <prefix>brand/logo?v=<12 hex>`: long-cached only while `v` names the current bytes.
pub fn logo_answer(dir: Option<&Path>, f: &Files, query: &str) -> Answer {
    let Some((b, Some(bytes))) = dir.and_then(|d| load_full(d, f)) else { return Answer::NoLogo };
    let Some(l) = b.logo else { return Answer::NoLogo };
    let asked = query.split('&').find_map(|p| p.strip_prefix("v="));
    let cache = if asked == Some(&l.sha256[..12]) { CACHE_LONG } else { CACHE_CHECK };
    Answer::Logo { ctype: l.ctype, cache, bytes }
}

/// The guest and web ports' brand reads (`<prefix>v1/brand`, `<prefix>brand/logo`, GET only, listed in
/// meet_license::BRAND_READS); None for every other request. `state_dir` "" serves no brand.
pub fn port_read(state_dir: &str, prefix: &str, method: &str, path: &str, query: &str) -> Option<Answer> {
    if method != "GET" || !crate::meet_license::BRAND_READS.contains(&path) {
        return None;
    }
    let dir = (!state_dir.is_empty()).then(|| Path::new(state_dir));
    match path.strip_prefix(prefix)? {
        "v1/brand" => Some(Answer::Json(public(dir.and_then(|d| load(d, &RELAY_FILES)).as_ref(), prefix))),
        "brand/logo" => Some(logo_answer(dir, &RELAY_FILES, query)),
        _ => None,
    }
}

/// The JSON body and cache of a JSON read.
pub const JSON_CACHE: &str = CACHE_CHECK;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn temp_dir(tag: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("lucid-brand-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A PNG header of `w` by `h` (the signature and IHDR; the checks read no further).
    pub(crate) fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        b
    }

    fn jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        b.extend_from_slice(b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00");
        b.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
        b
    }

    fn webp_lossless(w: u32, h: u32) -> Vec<u8> {
        let bits = (w - 1) | (h - 1) << 14;
        let mut b = b"RIFF\x00\x00\x00\x00WEBPVP8L\x05\x00\x00\x00\x2f".to_vec();
        b.extend_from_slice(&bits.to_le_bytes());
        b
    }

    fn webp_extended(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x10\x00\x00\x00".to_vec();
        b.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
        b.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
        b
    }

    fn webp_lossy(w: u16, h: u16) -> Vec<u8> {
        let mut b = b"RIFF\x00\x00\x00\x00WEBPVP8 \x10\x00\x00\x00\x00\x00\x00\x9d\x01\x2a".to_vec();
        b.extend_from_slice(&w.to_le_bytes());
        b.extend_from_slice(&h.to_le_bytes());
        b
    }

    fn b64(b: &[u8]) -> String {
        crate::meet_json::b64(b)
    }

    fn obj(v: Value) -> Obj {
        v.as_object().unwrap().clone()
    }

    fn fields() -> Obj {
        obj(json!({"name": "  Contoso   Ltd ", "accent": "#0f6cbd", "mode": "auto", "welcome": "Welcome to\nContoso meetings.", "support": "https://contoso.example/help", "reason": "brand"}))
    }

    #[test]
    fn meet_brand_contrast_decides_the_text_color_and_refuses_weak_accents() {
        assert_eq!(check_accent(Some("#0f6cbd")).unwrap(), ("#0f6cbd".to_string(), "#ffffff"));
        // a light accent carries near-black text
        assert_eq!(check_accent(Some("#ffd34d")).unwrap().1, "#0a0b0f");
        // mid gray: neither text color reaches 4.5:1 (white 4.48:1, near-black 4.39:1)
        let gray = check_accent(Some("#777777")).unwrap_err();
        assert!(gray.contains("4.5:1"), "{gray}");
        // navy: white text is fine, but the accent vanishes on the dark background (1.23:1)
        let navy = check_accent(Some("#000080")).unwrap_err();
        assert!(navy.contains("3:1"), "{navy}");
        for bad in ["#0F6CBD", "0f6cbd", "#0f6cb", "#0f6cbdd", "red", ""] {
            assert!(check_accent(Some(bad)).is_err(), "{bad}");
        }
        assert!((contrast("#ffffff", "#000000").unwrap() - 21.0).abs() < 1e-9);
    }

    #[test]
    fn meet_brand_text_fields_follow_section_3() {
        assert_eq!(check_name(Some("  Contoso \t Ltd ")).unwrap(), "Contoso Ltd");
        assert!(check_name(Some("   ")).is_err());
        assert!(check_name(Some(&"x".repeat(61))).is_err());
        assert!(check_name(Some(&"x".repeat(60))).is_ok());
        assert!(check_name(Some("<b>Contoso</b>")).is_err());
        // Cf (a bidi override, a zero-width space) and Cc are refused; Unicode White_Space runs collapse
        assert!(check_name(Some("Contoso\u{202e}")).is_err());
        assert!(check_name(Some("Con\u{200b}toso")).is_err());
        assert!(check_name(Some("Con\u{7}toso")).is_err());
        assert_eq!(check_name(Some("\u{3000}Contoso\u{a0}\u{2028}Ltd\n")).unwrap(), "Contoso Ltd");
        // code points, not bytes
        assert!(check_name(Some(&"\u{e9}".repeat(60))).is_ok());
        assert_eq!(check_mode(None).unwrap(), "auto");
        for bad in [json!("sepia"), json!(null), json!(""), json!(1)] {
            assert!(check_mode(Some(&bad)).is_err(), "{bad}");
        }
        assert_eq!(check_welcome(Some("")).unwrap(), None);
        assert!(check_welcome(Some(&"w".repeat(201))).is_err());
        assert!(check_welcome(Some("hi\u{feff}")).is_err());
        assert_eq!(check_welcome(Some("<b>plain</b> text")).unwrap().as_deref(), Some("<b>plain</b> text"), "shown with textContent");
        for ok in ["https://contoso.example/help?x=1#top", "https://help.contoso.example:8443/", "mailto:help@contoso.example", "mailto:o'neil+help/desk@mail.contoso.example"] {
            assert_eq!(check_support(Some(ok)).unwrap().as_deref(), Some(ok), "{ok}");
        }
        assert_eq!(check_support(Some("  ")).unwrap(), None);
        let long = format!("https://contoso.example/{}", "a".repeat(300));
        for bad in ["http://contoso.example", "https://user:pw@contoso.example/", "https://", "javascript:alert(1)", "mailto:a@x.example,b@x.example",
            "mailto:a@x.example?subject=hi", "mailto:a@localhost", "mailto:a@b@x.example", "https://contoso.example/\u{e9}", long.as_str()] {
            assert!(check_support(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn meet_brand_logos_by_magic_bytes_and_header_dimensions() {
        assert_eq!(image_info(&png(256, 128)).unwrap(), ("image/png", 256, 128));
        assert_eq!(image_info(&jpeg(300, 200)).unwrap(), ("image/jpeg", 300, 200));
        assert_eq!(image_info(&webp_lossless(64, 48)).unwrap(), ("image/webp", 64, 48));
        assert_eq!(image_info(&webp_extended(1024, 32)).unwrap(), ("image/webp", 1024, 32));
        assert_eq!(image_info(&webp_lossy(500, 400)).unwrap(), ("image/webp", 500, 400));
        // SVG (with or without a prolog) and anything else is refused, whatever it is called
        let svg = image_info(b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap_err();
        assert!(svg.contains("SVG"), "{svg}");
        assert!(image_info(b"  <svg/>").unwrap_err().contains("SVG"));
        assert!(image_info(b"GIF89a\x20\x00\x20\x00").is_err());
        assert!(image_info(&png(64, 64)[..20]).is_err(), "a cut PNG header");
        assert!(image_info(&[0xff, 0xd8, 0xff, 0xda, 0, 2]).is_err(), "JPEG data before a frame header");
        // sides 32 to 1024
        assert!(check_logo(&png(31, 64)).unwrap_err().contains("31 by 64"));
        assert!(check_logo(&png(64, 1025)).is_err());
        assert!(check_logo(&png(32, 1024)).is_ok());
        // at most 256 KiB
        let mut big = png(64, 64);
        big.resize(LOGO_MAX + 1, 0);
        assert!(check_logo(&big).unwrap_err().contains("256 KiB"));
        big.truncate(LOGO_MAX);
        assert_eq!(check_logo(&big).unwrap().bytes, LOGO_MAX);
    }

    #[test]
    fn meet_brand_documents_refuse_unknown_keys_and_never_take_updated_or_by_from_a_write() {
        let b = with_fields(None, &fields(), "ann@x.org", 1_795_797_257_000).unwrap();
        assert_eq!((b.name.as_str(), b.welcome.as_deref(), b.on_accent, b.by.as_str(), b.updated), ("Contoso Ltd", Some("Welcome to Contoso meetings."), "#ffffff", "ann@x.org", 1_795_797_257_000));
        let mut extra = fields();
        extra.insert("by".into(), json!("mallory@x.org"));
        assert_eq!(with_fields(None, &extra, "ann@x.org", 1).unwrap_err(), "unknown key by");
        let mut css = fields();
        css.insert("css".into(), json!("body{}"));
        assert!(with_fields(None, &css, "ann@x.org", 1).is_err());
        // the stored document reads back whole, and a changed one is refused
        let doc = to_value(&b);
        assert_eq!(from_value(&doc).unwrap(), b);
        for v in [json!(2), json!(true), json!(1.0), json!("1")] {
            let mut other = doc.clone();
            other["v"] = v.clone();
            assert!(from_value(&other).is_err(), "v {v}");
        }
        let mut no_mode = doc.clone();
        no_mode.as_object_mut().unwrap().remove("mode");
        assert_eq!(from_value(&no_mode).unwrap().mode, "auto");
        let mut null_mode = doc.clone();
        null_mode["mode"] = Value::Null;
        assert!(from_value(&null_mode).is_err());
        let mut odd = doc.clone();
        odd["theme"] = json!("x");
        assert!(from_value(&odd).is_err());
        let mut weak = doc;
        weak["accent"] = json!("#777777");
        assert!(from_value(&weak).is_err(), "a hand-edited weak accent never serves");
    }

    #[test]
    fn meet_brand_logo_writes_cap_the_text_and_check_the_type() {
        let base = with_fields(None, &fields(), "ann@x.org", 1).unwrap();
        assert!(with_logo(None, &obj(json!({"type": "image/png", "data": b64(&png(64, 64))})), "ann@x.org", 2).unwrap_err().contains("before its logo"));
        let (b, bytes) = with_logo(Some(&base), &obj(json!({"type": "image/png", "data": b64(&png(64, 64))})), "bob@x.org", 2).unwrap();
        assert_eq!((b.logo.as_ref().unwrap().w, b.by.as_str(), bytes.unwrap().len()), (64, "bob@x.org", png(64, 64).len()));
        // the declared type must be the sniffed one; SVG is refused even when called a PNG
        assert!(with_logo(Some(&base), &obj(json!({"type": "image/webp", "data": b64(&png(64, 64))})), "a@x.org", 2).unwrap_err().contains("image/png"));
        assert!(with_logo(Some(&base), &obj(json!({"type": "image/png", "data": b64(b"<svg xmlns='x'/>")})), "a@x.org", 2).unwrap_err().contains("SVG"));
        assert!(with_logo(Some(&base), &obj(json!({"type": "image/svg+xml", "data": b64(&png(64, 64))})), "a@x.org", 2).is_err());
        // an oversized text is refused before decoding; a bad alphabet is refused
        assert!(with_logo(Some(&base), &obj(json!({"type": "image/png", "data": "A".repeat(LOGO_B64_MAX + 4)})), "a@x.org", 2).unwrap_err().contains("256 KiB"));
        assert!(with_logo(Some(&base), &obj(json!({"type": "image/png", "data": "!!!!"})), "a@x.org", 2).is_err());
        assert!(with_logo(Some(&base), &obj(json!({"type": "image/png", "data": "", "extra": 1})), "a@x.org", 2).unwrap_err().contains("unknown key"));
        let (gone, none) = with_logo(Some(&b), &obj(json!({"remove": true})), "a@x.org", 3).unwrap();
        assert!(gone.logo.is_none() && none.is_none());
        assert_eq!(decode_b64(&b64(b"any bytes!")).unwrap(), b"any bytes!");
    }

    #[test]
    fn meet_brand_store_public_read_and_logo_answers() {
        let dir = temp_dir("store");
        let s = dir.to_string_lossy().into_owned();
        // no brand: the standard theme
        assert_eq!(port_read(&s, "/g/", "GET", "/g/v1/brand", ""), Some(Answer::Json(json!({"brand": null}))));
        assert_eq!(port_read(&s, "/w/", "GET", "/w/brand/logo", ""), Some(Answer::NoLogo));
        assert_eq!(port_read("", "/g/", "GET", "/g/v1/brand", ""), Some(Answer::Json(json!({"brand": null}))));
        assert_eq!(port_read(&s, "/g/", "POST", "/g/v1/brand", ""), None);
        assert_eq!(port_read(&s, "/g/", "GET", "/g/v1/brandx", ""), None);
        let mut b = with_fields(None, &fields(), "ann@x.org", 7).unwrap();
        let logo = png(128, 64);
        b.logo = Some(check_logo(&logo).unwrap());
        save(&dir, &RELAY_FILES, &b, Some(&logo)).unwrap();
        let v = &b.logo.as_ref().unwrap().sha256[..12];
        let Some(Answer::Json(read)) = port_read(&s, "/w/", "GET", "/w/v1/brand", "") else { panic!() };
        assert_eq!(read, json!({"brand": {"name": "Contoso Ltd", "accent": "#0f6cbd", "onAccent": "#ffffff", "mode": "auto", "welcome": "Welcome to Contoso meetings.",
            "support": "https://contoso.example/help", "logo": format!("/w/brand/logo?v={v}")}}));
        let text = read.to_string();
        assert!(!text.contains("ann@x.org") && !text.contains("updated"), "by and updated are never public");
        assert_eq!(port_read(&s, "/g/", "GET", "/g/brand/logo", &format!("v={v}")), Some(Answer::Logo { ctype: "image/png", cache: "public, max-age=86400", bytes: logo.clone() }));
        assert_eq!(port_read(&s, "/g/", "GET", "/g/brand/logo", "v=000000000000"), Some(Answer::Logo { ctype: "image/png", cache: "no-cache", bytes: logo.clone() }));
        // bytes that are not the ones named, or none, make the whole brand unreadable: the standard theme
        std::fs::write(dir.join(RELAY_FILES.logo), png(64, 64)).unwrap();
        assert_eq!(port_read(&s, "/g/", "GET", "/g/brand/logo", ""), Some(Answer::NoLogo));
        assert_eq!(port_read(&s, "/g/", "GET", "/g/v1/brand", ""), Some(Answer::Json(json!({"brand": null}))));
        std::fs::remove_file(dir.join(RELAY_FILES.logo)).unwrap();
        assert_eq!(load(&dir, &RELAY_FILES), None);
        // a document over 16 KiB is refused whole
        std::fs::write(dir.join(RELAY_FILES.logo), &logo).unwrap();
        assert!(load(&dir, &RELAY_FILES).is_some());
        let mut padded = to_value(&b);
        padded["by"] = json!("a".repeat(DOC_MAX));
        std::fs::write(dir.join(RELAY_FILES.doc), padded.to_string()).unwrap();
        assert_eq!(load(&dir, &RELAY_FILES), None);
        // without its logo the old file goes; reset removes both
        b.logo = None;
        save(&dir, &RELAY_FILES, &b, None).unwrap();
        assert!(!dir.join(RELAY_FILES.logo).exists());
        assert_eq!(load(&dir, &RELAY_FILES).unwrap(), b);
        assert!(remove(&dir, &RELAY_FILES).unwrap());
        assert!(!remove(&dir, &RELAY_FILES).unwrap());
        assert_eq!(load(&dir, &RELAY_FILES), None);
        // a document that does not read back whole serves the standard theme
        std::fs::write(dir.join(RELAY_FILES.doc), "{\"v\": 1, \"name\": \"X\"}").unwrap();
        assert_eq!(port_read(&s, "/g/", "GET", "/g/v1/brand", ""), Some(Answer::Json(json!({"brand": null}))));
    }
}
