// Contract AC-1 section 12.1, slice ac-ui: the Lucid Admin Console's page assets (native/lucid-relay/console/), read as
// files. Strict CSP shape (no inline script or style, no handlers, no HTML sinks), no outside URL, the Meeting Hub
// 0.96.0 palettes with their exact token values and the 7.6 contrast pairs, the type floor, reduced motion, visible
// focus, the cleaning table, the dialog ID line, the pinned icon, every word of the words vector, and no long dashes.
//
// Vectors (copied from Meeting Hub after its generators run, as meet_push.rs reads its vectors):
//   tests/admin_console_themes_v1.json   tools/export_console_themes.py
//   tests/admin_console_words_v1.json    tools/make_admin_console_vectors.py
//   tests/admin_console_totp_v1.json     tools/make_admin_console_vectors.py (its "qr" samples)
//
// Revision 4 adds qr.js and two script tests run with Node.js (LUCID_TEST_NODE names another binary): qr.js against the
// vector's QR matrices, and app.js in a small DOM double for the lock screen and the sign-in banner.

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

/// SHA-256 of Meeting Hub src/icon.svg at a49c6cb (feat/hub-brand-themes). Meeting Hub's
/// tests/test_admin_console_assets.py reads this constant and checks it against src/icon.svg.
const ICON_SHA256: &str = "0ef481bf05969cdf8436266951d2de59230e2478cda3cfd9060f13af445e6ee0";

const INDEX_HTML: &str = include_str!("../console/index.html");
const THEME_JS: &str = include_str!("../console/theme.js");
const APP_JS: &str = include_str!("../console/app.js");
const QR_JS: &str = include_str!("../console/qr.js");
const APP_CSS: &str = include_str!("../console/app.css");
const MANIFEST: &str = include_str!("../console/manifest.webmanifest");
const ICON_SVG: &[u8] = include_bytes!("../console/icon.svg");
const FAVICON_SVG: &[u8] = include_bytes!("../console/favicon.svg");

/// The one URL allowed in an asset: the SVG namespace of the icon files.
const SVG_NS: &str = "http://www.w3.org/2000/svg";
/// The 8.3 `bad-url` words name the scheme; the page shows them before asking the relay.
const BAD_URL_WORDS: &str = "Links must start with https:// and name a host.";

fn text_assets() -> Vec<(&'static str, String)> {
    vec![
        ("index.html", INDEX_HTML.to_owned()),
        ("theme.js", THEME_JS.to_owned()),
        ("app.js", APP_JS.to_owned()),
        ("qr.js", QR_JS.to_owned()),
        ("app.css", APP_CSS.to_owned()),
        ("manifest.webmanifest", MANIFEST.to_owned()),
        ("icon.svg", String::from_utf8_lossy(ICON_SVG).into_owned()),
        ("favicon.svg", String::from_utf8_lossy(FAVICON_SVG).into_owned()),
    ]
}

fn vector(name: &str) -> Value {
    let path = format!("{}/tests/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}; copy it from Meeting Hub tests/vectors/{name} after running its generator"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    bytes.iter().flat_map(|b| [char::from(DIGITS[usize::from(b >> 4)]), char::from(DIGITS[usize::from(b & 15)])]).collect()
}

/// Every position of `needle` in `hay`.
fn positions(hay: &str, needle: &str) -> Vec<usize> {
    hay.match_indices(needle).map(|(i, _)| i).collect()
}

/// `on` followed by at least one lower-case letter, optional spaces and `=`, starting right after `at`.
fn handler_attribute_at(bytes: &[u8], at: usize) -> bool {
    if at >= bytes.len() || !bytes[at..].starts_with(b"on") {
        return false;
    }
    let mut j = at + 2;
    let start = j;
    while j < bytes.len() && bytes[j].is_ascii_lowercase() {
        j += 1;
    }
    if j == start {
        return false;
    }
    while j < bytes.len() && bytes[j] == b' ' {
        j += 1;
    }
    j < bytes.len() && bytes[j] == b'='
}

#[test]
fn no_inline_script_style_handler_or_html_sink() {
    for (name, text) in text_assets() {
        for at in positions(&text.to_ascii_lowercase(), "<script") {
            let tag_end = text[at..].find('>').map(|e| at + e).expect("a closed script tag");
            assert!(text[at..tag_end].contains(" src=\""), "{name}: a <script> without src");
        }
        for banned in ["style=", "javascript:", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "srcdoc", "<style", "@import"] {
            assert!(!text.contains(banned), "{name} contains {banned}");
        }
        let bytes = text.as_bytes();
        let markup = name.ends_with(".html") || name.ends_with(".svg");
        for (i, &b) in bytes.iter().enumerate() {
            // Markup: no on* attribute (an attribute starts after white space).
            if markup && b.is_ascii_whitespace() && handler_attribute_at(bytes, i + 1) {
                panic!("{name}:{}: an on* attribute", text[..i].lines().count());
            }
            // Script: no on* property assignment, so handlers are wired with addEventListener.
            if name.ends_with(".js") && b == b'.' && handler_attribute_at(bytes, i + 1) {
                panic!("{name}:{}: an on* property assignment", text[..i].lines().count());
            }
        }
        if name.ends_with(".js") {
            assert!(!text.contains("setAttribute(\"on") && !text.contains("setAttribute('on"), "{name} sets an on* attribute");
            assert!(!text.contains("new Function"), "{name} builds code from text");
        }
    }
}

#[test]
fn no_outside_url() {
    for (name, text) in text_assets() {
        for scheme in ["http://", "https://"] {
            for at in positions(&text, scheme) {
                let rest = &text[at..];
                // The inline SVG namespace: the icon files, and qr.js, which draws the QR code with createElementNS.
                let namespace = (name.ends_with(".svg") || name == "qr.js") && rest.starts_with(SVG_NS);
                let words = name == "app.js" && text[..at + scheme.len()].ends_with("start with https://");
                assert!(namespace || words, "{name}: an outside URL at byte {at}: {}", rest.chars().take(60).collect::<String>());
            }
        }
        assert!(!text.contains("@font-face") && !text.contains("//cdn"), "{name}: no web font, no CDN");
    }
    assert!(!APP_CSS.contains("url("), "app.css loads no resource");
    assert!(APP_JS.contains(BAD_URL_WORDS));
}

#[test]
fn no_long_dashes() {
    let em = '\u{2014}';
    let en = '\u{2013}';
    let entities = [format!("&{}dash;", "m"), format!("&{}dash;", "n"), format!("\\u{}", "2014"), format!("\\u{}", "2013"), format!("\\{}", "2014"), format!("\\{}", "2013")];
    for (name, text) in text_assets() {
        assert!(!text.contains(em) && !text.contains(en), "{name} has a long dash");
        for e in &entities {
            assert!(!text.contains(e.as_str()), "{name} spells a long dash as {e}");
        }
    }
}

#[test]
fn page_shell_scripts_and_wordmark() {
    let h = INDEX_HTML;
    assert!(h.contains("<html lang=\"en\""));
    // theme.js blocks in <head> so data-theme is set before first paint; app.js loads with defer.
    let theme = h.find("<script src=\"/console/theme.js\"></script>").expect("theme.js, blocking");
    let app = h.find("<script src=\"/console/app.js\" defer></script>").expect("app.js with defer");
    let qr = h.find("<script src=\"/console/qr.js\" defer></script>").expect("qr.js with defer, before app.js");
    let head_end = h.find("</head>").unwrap();
    assert!(theme < head_end && app < head_end && theme < qr && qr < app);
    assert!(h.contains("<link rel=\"stylesheet\" href=\"/console/app.css\">"));
    assert!(h.contains("<link rel=\"icon\" type=\"image/svg+xml\" href=\"/console/favicon.svg\">"));
    assert!(h.contains("<link rel=\"manifest\" href=\"/console/manifest.webmanifest\">"));
    // 7.1 wordmark: LUCID in --accent, the cyan pi (dashboard.html:4086), then "Admin Console"; h1 named for AT.
    assert!(h.contains("<h1 class=\"brand\" aria-label=\"LUCID Admin Console\">"));
    assert!(h.contains("<span class=\"lucid-word\">LUCID</span><span class=\"frame-pi\" aria-hidden=\"true\"><svg viewBox=\"0 0 24 24\""));
    for d in ["<path d=\"M5 8h14\"/>", "<path d=\"M9 8v9\"/>", "<path d=\"M16 8v7a2 2 0 0 0 2 2\"/>"] {
        assert!(h.contains(d), "pi path {d}");
    }
    assert!(h.contains("<span class=\"frame-sub\">Admin Console</span>"));
    assert!(APP_CSS.contains(".lucid-word { color: var(--accent);") && APP_CSS.contains(".frame-pi { display: inline-flex; color: var(--accent-blue); }"));
    // Skip link first, the navigation landmark, the two live regions (7.2, 7.6).
    assert!(h.find("class=\"skip\"").unwrap() < h.find("<header").unwrap());
    assert!(h.contains("Skip to content"));
    assert!(h.contains("aria-label=\"Sections\""));
    assert!(h.contains("role=\"status\"") && h.contains("role=\"alert\""));
}

#[test]
fn manifest_names_the_console() {
    let m: Value = serde_json::from_str(MANIFEST).expect("manifest is JSON");
    assert_eq!(m["name"], "Lucid Admin Console");
    assert_eq!(m["display"], "standalone");
    for key in ["start_url", "scope", "id"] {
        assert!(m[key].as_str().unwrap_or("/console/").starts_with("/console/"), "{key} stays under /console/");
    }
    let icons = m["icons"].as_array().expect("icons");
    assert!(icons.iter().any(|i| i["src"] == "/console/icon.svg"));
}

#[test]
fn icon_is_the_pinned_meeting_hub_icon() {
    let got = hex(aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, ICON_SVG).as_ref());
    assert_eq!(got, ICON_SHA256, "console/icon.svg must be a byte copy of Meeting Hub src/icon.svg at a49c6cb");
    assert_eq!(FAVICON_SVG, ICON_SVG, "favicon.svg is the same file");
}

/// The declarations of a `:root[data-theme="<id>"]` block (the lucid-dark block also carries the bare `:root`).
fn palette_block(id: &str) -> HashMap<String, String> {
    let selector = format!(":root[data-theme=\"{id}\"]");
    let at = APP_CSS.find(&selector).unwrap_or_else(|| panic!("app.css has no block for {id}"));
    let open = at + APP_CSS[at..].find('{').unwrap();
    let close = open + APP_CSS[open..].find('}').unwrap();
    APP_CSS[open + 1..close]
        .split(';')
        .filter_map(|d| d.trim().split_once(':'))
        .filter(|(k, _)| k.trim().starts_with("--"))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect()
}

fn resolve(name: &str, block: &HashMap<String, String>, base: &HashMap<String, String>) -> String {
    let mut value = block.get(name).or_else(|| base.get(name)).unwrap_or_else(|| panic!("{name} is not declared")).clone();
    for _ in 0..8 {
        let Some(inner) = value.strip_prefix("var(").and_then(|v| v.strip_suffix(')')) else { break };
        value = block.get(inner.trim()).or_else(|| base.get(inner.trim())).unwrap_or_else(|| panic!("{inner} is not declared")).clone();
    }
    value
}

fn luminance(hex_color: &str) -> f64 {
    let h = hex_color.strip_prefix('#').unwrap_or_else(|| panic!("{hex_color} is not a hex color"));
    assert_eq!(h.len(), 6, "{hex_color}");
    let ch = |i: usize| {
        let c = f64::from(u8::from_str_radix(&h[i..i + 2], 16).unwrap()) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4)
}

fn contrast(a: &str, b: &str) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

#[test]
fn every_palette_and_token_of_the_vector_with_its_value() {
    let themes = vector("admin_console_themes_v1.json");
    let themes = themes.as_array().expect("an array of palettes");
    assert_eq!(themes.len(), 23, "7 base and 16 Special palettes");
    assert_eq!(themes.iter().filter(|t| t["special"] == true).count(), 16);
    let mut missing = Vec::new();
    for t in themes {
        let id = t["id"].as_str().unwrap();
        let block = palette_block(id);
        for (name, value) in t["tokens"].as_object().expect("tokens") {
            let want = value.as_str().unwrap();
            if block.get(name).map(String::as_str) != Some(want) {
                missing.push(format!("{id} {name}: want {want}, app.css has {:?}", block.get(name)));
            }
        }
        for console_token in ["--ac-link", "--ac-focus", "--ac-danger", "--ac-ok", "--ac-warn", "--ac-border"] {
            if !block.contains_key(console_token) {
                missing.push(format!("{id} {console_token}: not declared"));
            }
        }
        // The Theme menu shows the same ids, labels and blurbs, grouped as the vector's `special` says.
        let label = t["label"].as_str().unwrap();
        let blurb = t["blurb"].as_str().unwrap();
        let entry = format!("{{ id: \"{id}\", label: \"{label}\", blurb: \"{blurb}\"");
        let at = APP_JS.find(&entry).unwrap_or_else(|| panic!("app.js THEMES lacks {entry}"));
        let line_end = at + APP_JS[at..].find('\n').unwrap();
        assert_eq!(APP_JS[at..line_end].contains("special: true"), t["special"] == true, "{id} special");
        assert!(THEME_JS.contains(&format!("\"{id}\"")), "theme.js knows {id}");
    }
    assert!(APP_CSS.contains(":root, :root[data-theme=\"lucid-dark\"] {"), "the bare :root is lucid-dark");
    assert!(missing.is_empty(), "palette differences:\n{}", missing.join("\n"));
}

#[test]
fn contrast_pairs_of_7_6_for_every_palette() {
    // 7.6: control boundaries use the console-only --ac-border (default --text-secondary), never the dashboard's quiet
    // --border-strong, whose value stays the vector's. --text-dim and --text-faint are never used for text.
    for unused in ["var(--border-strong)", "var(--text-dim)", "var(--text-faint)"] {
        assert!(!APP_CSS.contains(unused), "app.css uses {unused}");
    }
    let base = palette_block("lucid-dark");
    let themes = vector("admin_console_themes_v1.json");
    let mut fails = Vec::new();
    for t in themes.as_array().unwrap() {
        let id = t["id"].as_str().unwrap();
        let block = palette_block(id);
        let c = |a: &str, b: &str| contrast(&resolve(a, &block, &base), &resolve(b, &block, &base));
        let mut need = |fg: &str, bg: &str, min: f64| {
            let got = c(fg, bg);
            if got < min {
                fails.push(format!("{id}: {fg} on {bg} is {got:.2}:1, needs {min}:1"));
            }
        };
        for fg in ["--text-primary", "--text-secondary"] {
            for bg in ["--bg-primary", "--bg-secondary", "--bg-tertiary"] {
                need(fg, bg, 4.5);
            }
        }
        for fg in ["--ac-link", "--ac-danger", "--ac-ok", "--ac-warn"] {
            need(fg, "--bg-secondary", 4.5);
        }
        for fg in ["--ac-focus", "--ac-border"] {
            for bg in ["--bg-primary", "--bg-secondary"] {
                need(fg, bg, 3.0);
            }
        }
    }
    assert!(fails.is_empty(), "contrast below WCAG 2.2 AA:\n{}", fails.join("\n"));
}

#[test]
fn type_floor_motion_and_focus() {
    // Nothing under 12px; every size in px so the floor is checkable.
    for at in positions(APP_CSS, "font-size:") {
        let rest = &APP_CSS[at + "font-size:".len()..];
        let end = rest.find([';', '}']).unwrap();
        let value = rest[..end].trim().trim_end_matches("!important").trim();
        let px: f64 = value.strip_suffix("px").and_then(|n| n.trim().parse().ok()).unwrap_or_else(|| panic!("font-size {value} is not in px"));
        assert!(px >= 12.0, "font-size {value} is under 12px");
    }
    assert!(APP_CSS.contains("--fs-min: 12px;"));
    assert!(APP_CSS.contains("font-size: 14px; line-height: 1.5;"), "base 14px, line height 1.5");
    // Reduced motion: no animation and no smooth scrolling.
    let at = APP_CSS.find("@media (prefers-reduced-motion: reduce)").expect("a reduce block");
    let block = &APP_CSS[at..at + APP_CSS[at..].find("\n}").unwrap()];
    assert!(block.contains("animation: none") && block.contains("scroll-behavior: auto"), "{block}");
    assert!(!APP_CSS.contains("scroll-behavior: smooth"));
    // The glow animations run only under no-preference.
    let at = APP_CSS.find("@media (prefers-reduced-motion: no-preference)").expect("a no-preference block");
    let quiet = &APP_CSS[at..at + APP_CSS[at..].find("\n}").unwrap()];
    for anim in ["animation: lucidGlow", "animation: piGlow"] {
        assert!(quiet.contains(anim) && positions(APP_CSS, anim).len() == 1, "{anim} only under no-preference");
    }
    // Focus: a 2 px --ac-focus outline with 2 px offset on every focusable element; the header never covers focus.
    assert!(APP_CSS.contains(":focus-visible { outline: 2px solid var(--ac-focus); outline-offset: 2px; }"));
    assert!(APP_CSS.contains("scroll-padding-top:"));
    // Targets at least 24 by 24; 44 px tall under 600 px.
    assert!(APP_CSS.contains("min-height: 32px; min-width: 32px;"));
    assert!(APP_CSS.contains("@media (max-width: 600px)") && APP_CSS.contains("min-height: 44px;"));
    assert!(APP_CSS.contains("@media (max-width: 900px)"));
}

/// The inclusive ranges of app.js CLEAN_RANGES.
fn clean_ranges() -> Vec<(u32, u32)> {
    let at = APP_JS.find("const CLEAN_RANGES = [").expect("CLEAN_RANGES in app.js");
    let end = at + APP_JS[at..].find("];").unwrap();
    let nums: Vec<u32> = APP_JS[at..end]
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter_map(|w| w.strip_prefix("0x"))
        .map(|h| u32::from_str_radix(h, 16).unwrap())
        .collect();
    assert_eq!(nums.len() % 2, 0);
    nums.chunks(2).map(|p| (p[0], p[1])).collect()
}

#[test]
fn cleaning_removes_every_bidi_control_default_ignorable_and_control() {
    let ranges = clean_ranges();
    let removed = |cp: u32| ranges.iter().any(|&(lo, hi)| lo <= cp && cp <= hi);
    let words = vector("admin_console_words_v1.json");
    let clean = &words["clean"];
    let mut count = 0;
    for table in ["bidi_control", "default_ignorable", "controls"] {
        for pair in clean[table].as_array().unwrap_or_else(|| panic!("clean.{table}")) {
            let (lo, hi) = (pair[0].as_u64().unwrap() as u32, pair[1].as_u64().unwrap() as u32);
            for cp in lo..=hi {
                assert!(removed(cp), "U+{cp:04X} ({table}) is not removed");
                count += 1;
            }
        }
    }
    assert!(count > 4000);
    // Ordinary text stays.
    for cp in [0x20, 0x41, 0x7e, 0xa0, 0xe9, 0x4e2d, 0x1f600] {
        assert!(!removed(cp), "U+{cp:04X} must stay");
    }
    // The page cleans before writing, and writes untrusted text in bdi.
    assert!(APP_JS.contains("function clean(value)") && APP_JS.contains("const u = (v) => el(\"bdi\", null, clean("));
}

#[test]
fn every_dialog_has_an_id_line_and_bdi() {
    let dialogs: Vec<usize> = positions(INDEX_HTML, "<dialog class=\"confirm\"");
    assert!(!dialogs.is_empty(), "a confirmation dialog");
    for at in dialogs {
        let end = at + INDEX_HTML[at..].find("</dialog>").unwrap();
        let d = &INDEX_HTML[at..end];
        assert!(d.contains("class=\"id-line\"") && d.contains("<code") && d.contains(">ID<"), "the ID line (7.5)");
        assert!(d.contains("<bdi"), "the untrusted name in bdi");
        assert!(d.contains("tabindex=\"-1\""), "focus starts on the heading");
        assert!(d.contains(">Cancel<"));
    }
    assert!(APP_JS.contains(".showModal()"));
}

/// The literal pieces of a word string around its <placeholders>.
fn fragments(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' && i + 1 < chars.len() && chars[i + 1].is_ascii_lowercase() {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_lowercase() || chars[j] == ' ') {
                j += 1;
            }
            if j < chars.len() && chars[j] == '>' {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                i = j + 1;
                continue;
            }
        }
        cur.push(chars[i]);
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn strings_of(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| strings_of(x, out)),
        Value::Object(o) => o.iter().filter(|(k, _)| k.as_str() != "note").for_each(|(_, x)| strings_of(x, out)),
        _ => {}
    }
}

#[test]
fn every_page_word_is_in_the_page() {
    let words = vector("admin_console_words_v1.json");
    // The `cli.*` sentences are the offline CLI's and the start log's, and `python.test-only` (with its seat clock check
    // variant) is a test binary's start refusal: not page text.
    let not_page = |id: &str| id.starts_with("cli.") || id.starts_with("python.test-only");
    let mut all = Vec::new();
    for (id, v) in words["page"].as_object().expect("page words") {
        if !not_page(id) {
            strings_of(v, &mut all);
        }
    }
    // R41-1: the page shows meet.license-inactive beside its disabled add controls.
    strings_of(&words["people"]["meet.license-inactive"], &mut all);
    assert!(APP_JS.contains("\"aria-disabled\": \"true\""), "disabled add controls stay focusable with aria-disabled (7.4)");
    strings_of(&words["dialogs"], &mut all);
    strings_of(&words["labels"], &mut all);
    assert!(all.len() > 150);
    let page = format!("{INDEX_HTML}\n{APP_JS}");
    let missing: Vec<String> = all
        .iter()
        .flat_map(|s| fragments(s).into_iter().map(move |f| (s.clone(), f)))
        .filter(|(_, f)| !page.contains(f.as_str()))
        .map(|(s, f)| format!("{f:?} (of {s:?})"))
        .collect();
    assert!(missing.is_empty(), "words missing from app.js and index.html:\n{}", missing.join("\n"));
}

#[test]
fn fetches_are_same_origin_and_marked() {
    assert!(APP_JS.contains("credentials: \"same-origin\""));
    assert!(APP_JS.contains("headers[\"X-Lucid-Console\"] = \"1\";"));
    assert!(APP_JS.contains("fetch(\"/console/api/\" + path, init)"));
    assert_eq!(positions(APP_JS, "fetch(").len(), 1, "one fetch, the api helper");
    assert!(APP_JS.contains("\"lucid-console-theme\"") && THEME_JS.contains("\"lucid-console-theme\""));
    assert!(!APP_JS.contains("XMLHttpRequest") && !APP_JS.contains("WebSocket") && !APP_JS.contains("sendBeacon"));
}

#[test]
fn password_and_code_fields_name_their_autocomplete() {
    // 7.6 (3.3.8) and 12.1: password fields carry current-password or new-password, so paste and password managers
    // work; the code field carries one-time-code with a numeric keyboard.
    for (name, text) in [("app.js", APP_JS), ("index.html", INDEX_HTML)] {
        for (n, line) in text.lines().enumerate() {
            if line.contains("type: \"password\"") || line.contains("type=\"password\"") {
                let named = ["autocomplete: \"current-password\"", "autocomplete: \"new-password\"", "autocomplete=\"current-password\"", "autocomplete=\"new-password\""]
                    .iter()
                    .any(|a| line.contains(a));
                assert!(named, "{name}:{}: a password field without its autocomplete", n + 1);
            }
            if line.contains("one-time-code") {
                assert!(line.contains("inputmode") && line.contains("numeric"), "{name}:{}: the code field needs a numeric keyboard", n + 1);
            }
        }
    }
    assert!(APP_JS.contains("autocomplete: \"one-time-code\""), "the sign-in and enrollment code fields");
    assert!(INDEX_HTML.contains("autocomplete=\"one-time-code\""), "the step-up code field");
    assert!(APP_JS.contains("autocomplete: \"current-password\"") && APP_JS.contains("autocomplete: \"new-password\""));
}

#[test]
fn qr_js_draws_with_rects_and_no_style() {
    for banned in ["\"style\"", "style=", ".style"] {
        assert!(!QR_JS.contains(banned), "qr.js sets no style attribute or property ({banned})");
    }
    assert!(QR_JS.contains("createElementNS(SVG, \"rect\")"), "modules are SVG rect elements");
    assert!(!QR_JS.contains("fetch") && !QR_JS.contains("import"), "no outside code");
}

/// Runs the Node.js harness below in `mode` ("qr" or "dom") and fails with its output when it fails.
fn run_harness(mode: &str, extra: &str) {
    let dir = std::env::temp_dir().join(format!("lucid-console-assets-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join(format!("harness-{mode}.js"));
    std::fs::write(&script, HARNESS_JS).unwrap();
    let console_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("console");
    let node = std::env::var("LUCID_TEST_NODE").unwrap_or_else(|_| "node".to_owned());
    let out = Command::new(&node)
        .arg(&script)
        .arg(mode)
        .arg(&console_dir)
        .arg(extra)
        .output()
        .unwrap_or_else(|e| panic!("{node}: {e}; the page's script tests (12.1) need Node.js 18 or later on PATH, or LUCID_TEST_NODE"));
    let _ = std::fs::remove_file(&script);
    assert!(
        out.status.success(),
        "harness {mode} failed:\n{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn qr_js_encodes_the_vector_samples() {
    // 12.1: byte mode, level M, the vector's version, mask and module matrix for every sample URI.
    let totp = vector("admin_console_totp_v1.json");
    let qr = &totp["qr"];
    assert_eq!(qr["ecc"], "M");
    assert_eq!(qr["mode"], "byte");
    assert!(qr["samples"].as_array().map_or(0, Vec::len) > 0, "the vector has QR samples");
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("admin_console_totp_v1.json");
    run_harness("qr", path.to_str().unwrap());
}

#[test]
fn lock_screen_leaves_no_value_and_the_banner_comes_first() {
    // 12.1: the lock screen leaves no displayed value in the DOM (a DOM snapshot after the idle limit), and the sign-in
    // screen shows the banner before the email field.
    run_harness("dom", "-");
}

/// The script harness: qr.js against the vector, and app.js in a small DOM double built from index.html.
const HARNESS_JS: &str = r##""use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const [mode, dir, extra] = process.argv.slice(2);
function fail(msg) {
  console.error(msg);
  process.exit(1);
}
process.on("unhandledRejection", (e) => fail("unhandled rejection: " + (e && e.stack ? e.stack : e)));
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

if (mode === "qr") {
  const ctx = vm.createContext({ TextEncoder, console });
  ctx.window = ctx;
  vm.runInContext(read("qr.js"), ctx, { filename: "qr.js" });
  const v = JSON.parse(fs.readFileSync(extra, "utf8")).qr;
  let n = 0;
  for (const s of v.samples) {
    const m = ctx.LucidQR.matrix(s.uri);
    if (m.version !== s.version) fail(s.uri + ": version " + m.version + ", want " + s.version);
    if (m.mask !== s.mask) fail(s.uri + ": mask " + m.mask + ", want " + s.mask);
    if (m.size !== s.size) fail(s.uri + ": size " + m.size + ", want " + s.size);
    const rows = Array.from(m.rows, (r) => Array.from(r, (b) => (b ? "1" : "0")).join(""));
    if (rows.length !== s.matrix.length) fail(s.uri + ": " + rows.length + " rows");
    rows.forEach((r, i) => {
      if (r !== s.matrix[i]) fail(s.uri + ": row " + i + "\n got  " + r + "\n want " + s.matrix[i]);
    });
    n++;
  }
  console.log("qr: " + n + " samples match");
  process.exit(0);
}

// ---- A small DOM double: enough of the DOM for app.js, built from index.html ----
class FEvent {
  constructor(type, bubbles) {
    this.type = type;
    this.bubbles = bubbles !== false;
    this.target = null;
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}
let doc = null;
class FNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = {};
  }
  get parentElement() {
    return this.parentNode instanceof FElement ? this.parentNode : null;
  }
  get children() {
    return this.childNodes.filter((n) => n instanceof FElement);
  }
  adopt(k) {
    if (!(k instanceof FNode)) k = new FText(String(k));
    if (k instanceof FFragment) {
      const list = k.childNodes.slice();
      k.childNodes = [];
      return list;
    }
    if (k.parentNode) k.parentNode.drop(k);
    return [k];
  }
  drop(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
  }
  append(...ks) {
    for (const k of ks) {
      for (const n of this.adopt(k)) {
        n.parentNode = this;
        this.childNodes.push(n);
      }
    }
  }
  appendChild(k) {
    this.append(k);
    return k;
  }
  prepend(...ks) {
    const list = [];
    for (const k of ks) list.push(...this.adopt(k));
    for (const n of list) n.parentNode = this;
    this.childNodes.unshift(...list);
  }
  replaceChildren(...ks) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...ks);
  }
  remove() {
    if (this.parentNode) this.parentNode.drop(this);
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.replaceChildren();
    if (v != null && v !== "") this.append(String(v));
  }
  addEventListener(type, f) {
    (this.listeners[type] = this.listeners[type] || []).push(f);
  }
  removeEventListener() {}
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    for (let x = this; x; x = x.parentNode) {
      for (const f of (x.listeners[ev.type] || []).slice()) f(ev);
      if (ev.stopped || !ev.bubbles) break;
    }
    return !ev.defaultPrevented;
  }
}
class FText extends FNode {
  constructor(data) {
    super();
    this.data = data;
  }
  get nodeName() {
    return "#text";
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}
class FFragment extends FNode {
  get nodeName() {
    return "#document-fragment";
  }
}
function walk(node, fn) {
  for (const c of node.childNodes) {
    fn(c);
    walk(c, fn);
  }
}
function compound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  let m = /^([a-zA-Z][a-zA-Z0-9-]*|\*)?/.exec(s);
  if (m[1] && m[1] !== "*") c.tag = m[1].toUpperCase();
  let rest = s.slice(m[0].length);
  while (rest) {
    if (rest[0] === "#") m = /^#([\w-]+)/.exec(rest);
    else if (rest[0] === ".") m = /^\.([\w-]+)/.exec(rest);
    else if (rest[0] === "[") m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest);
    else m = null;
    if (!m) throw new Error("selector not supported by the harness: " + s);
    if (rest[0] === "#") c.id = m[1];
    else if (rest[0] === ".") c.classes.push(m[1]);
    else c.attrs.push([m[1], m[2]]);
    rest = rest.slice(m[0].length);
  }
  return c;
}
function matchOne(e, c) {
  if (c.tag && e.tagName !== c.tag) return false;
  if (c.id && e.getAttribute("id") !== c.id) return false;
  const cls = (e.getAttribute("class") || "").split(/\s+/);
  for (const k of c.classes) if (!cls.includes(k)) return false;
  for (const [a, v] of c.attrs) {
    const x = e.getAttribute(a);
    if (x === null || (v !== undefined && x !== v)) return false;
  }
  return true;
}
function matches(e, sel) {
  return sel.split(",").some((one) => {
    const parts = one.trim().split(/\s+/).map(compound);
    if (!matchOne(e, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    for (let x = e.parentNode; i >= 0 && x; x = x.parentNode) if (x instanceof FElement && matchOne(x, parts[i])) i--;
    return i < 0;
  });
}
class FElement extends FNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.files = null;
  }
  get nodeName() {
    return this.tagName;
  }
  setAttribute(k, v) {
    const key = String(k).toLowerCase();
    this.attrs.set(key, String(v));
    if (key === "checked") this.checked = true;
    if (key === "open") this.open = true;
  }
  getAttribute(k) {
    const v = this.attrs.get(String(k).toLowerCase());
    return v === undefined ? null : v;
  }
  hasAttribute(k) {
    return this.attrs.has(String(k).toLowerCase());
  }
  removeAttribute(k) {
    this.attrs.delete(String(k).toLowerCase());
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  get className() {
    return this.getAttribute("class") || "";
  }
  set className(v) {
    this.setAttribute("class", v);
  }
  get classList() {
    const e = this;
    const list = () => e.className.split(/\s+/).filter(Boolean);
    const api = {
      add: (...c) => { e.className = [...new Set(list().concat(c))].join(" "); },
      remove: (...c) => { e.className = list().filter((x) => !c.includes(x)).join(" "); },
      contains: (c) => list().includes(c),
      toggle: (c, force) => {
        const want = force === undefined ? !list().includes(c) : !!force;
        if (want) api.add(c);
        else api.remove(c);
        return want;
      },
    };
    return api;
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(v) {
    if (v) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  focus() {
    doc.activeElement = this;
  }
  blur() {}
  click() {
    this.dispatchEvent(new FEvent("click"));
  }
  closest(sel) {
    for (let x = this; x instanceof FElement; x = x.parentNode) if (matches(x, sel)) return x;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    walk(this, (n) => {
      if (n instanceof FElement && matches(n, sel)) out.push(n);
    });
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  showModal() {
    this.setAttribute("open", "");
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.removeAttribute("open");
    this.dispatchEvent(new FEvent("close", false));
  }
}
class FDocument extends FNode {
  constructor() {
    super();
    this.activeElement = null;
    this.hidden = false;
  }
  createElement(tag) {
    return new FElement(tag);
  }
  createElementNS(ns, tag) {
    return new FElement(tag);
  }
  createTextNode(d) {
    return new FText(String(d));
  }
  createDocumentFragment() {
    return new FFragment();
  }
  getElementById(id) {
    let found = null;
    walk(this, (n) => {
      if (!found && n instanceof FElement && n.getAttribute("id") === id) found = n;
    });
    return found;
  }
  querySelectorAll(sel) {
    return FElement.prototype.querySelectorAll.call(this, sel);
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  get documentElement() {
    return this.childNodes.find((n) => n instanceof FElement) || null;
  }
  get body() {
    return this.querySelector("body");
  }
  get title() {
    const t = this.querySelector("title");
    return t ? t.textContent : "";
  }
  set title(v) {
    const t = this.querySelector("title");
    if (t) t.textContent = v;
  }
}
const VOID = new Set(["meta", "link", "input", "br", "img", "hr"]);
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
function parseHTML(src) {
  const stack = [doc];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toUpperCase();
      while (stack.length > 1) {
        const e = stack.pop();
        if (e.tagName === tag) break;
      }
    } else if (m[2]) {
      const e = doc.createElement(m[2]);
      const ar = /([^\s=>/]+)(?:="([^"]*)")?/g;
      let a;
      while ((a = ar.exec(m[3] || ""))) e.setAttribute(a[1], a[2] === undefined ? "" : decode(a[2]));
      top.append(e);
      if (!VOID.has(m[2].toLowerCase()) && !m[4]) stack.push(e);
    } else if (m[5] !== undefined) top.append(decode(m[5]));
  }
}
function snapshot() {
  const out = [];
  walk(doc, (n) => {
    if (n instanceof FText) out.push(n.data);
    else if (n instanceof FElement) {
      for (const v of n.attrs.values()) out.push(v);
      if (n.value) out.push(String(n.value));
    }
  });
  return out.join("\n");
}
const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
};

// Loads theme.js, qr.js and app.js against a fake relay that answers `answers` ("GET me", "POST login/begin", ...).
function boot(answers) {
  doc = new FDocument();
  parseHTML(read("index.html"));
  const clock = { now: 1763300000000 };
  const timers = [];
  let tid = 0;
  const storage = new Map();
  const add = (f, ms, every) => {
    timers.push({ id: ++tid, f, at: clock.now + (ms || 0), every });
    return tid;
  };
  const clear = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const sandbox = {
    console, document: doc, Node: FNode, Event: FEvent, URLSearchParams, URL, TextEncoder, TextDecoder, atob, btoa, __clock: clock,
    location: { hash: "", pathname: "/console/", search: "", host: "relay.acme.example" },
    history: { replaceState() {} },
    navigator: { credentials: {}, clipboard: { writeText: async () => {} } },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    PublicKeyCredential: function PublicKeyCredential() {},
    addEventListener() {},
    setTimeout: (f, ms) => add(f, ms, 0),
    setInterval: (f, ms) => add(f, ms, ms),
    clearTimeout: clear,
    clearInterval: clear,
    fetch: async (url, init) => {
      const route = (init.method || "GET") + " " + String(url).replace("/console/api/", "").split("?")[0];
      const body = answers[route] || { ok: true };
      const ok = body.ok !== false;
      return { ok, status: ok ? 200 : body.status || 400, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(body)) };
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext("Date.now = function () { return __clock.now; };", ctx);
  for (const f of ["theme.js", "qr.js", "app.js"]) vm.runInContext(read(f), ctx, { filename: f });
  const advance = async (ms) => {
    clock.now += ms;
    for (const t of timers.slice().sort((a, b) => a.at - b.at)) {
      if (!timers.includes(t) || t.at > clock.now) continue;
      if (t.every) t.at = clock.now + t.every;
      else clear(t.id);
      t.f();
      await settle();
    }
    await settle();
  };
  return { advance };
}
const find = (sel, text) => doc.querySelectorAll(sel).find((e) => e.textContent === text);

async function main() {
  // 1. The lock screen (3.4, 7.8): every displayed value removed at the idle limit.
  const host = { host: "relay.acme.example", version: "2.4.0", uptimeSeconds: 100, fips: true };
  const a = boot({
    "GET me": {
      ok: true, product: "spokes", profile: "high", origin: "https://relay.acme.example", relay: host,
      sections: ["overview", "spokes", "approvals", "admins"], idle: { minutes: 15, maxHours: 12 },
      user: { email: "ann@acme.example", role: "admin", rights: "admin", rightsWhy: null, state: "active", breakGlass: false,
        methods: { webauthn: [], password: false, totp: false }, mustSetPassword: false, sessions: 1, mail: [] },
    },
    "GET settings": { ok: true, twoPerson: "off", profile: "high", links: [] },
    "GET banner": { ok: true, banner: null },
    "GET overview": {
      ok: true, product: "spokes", relay: host, license: { state: "valid", users: 20, used: 3, daysLeft: 100, exp: 1790000000 },
      cards: [{ id: "hubs", state: "ok", n: 2, m: 0 }],
      attention: [{ kind: "admin-suspended", severity: "warn", args: { email: "bob@acme.example" }, go: "#/admins/people" }],
      approvals: { waiting: 1, mine: 1 }, requests: { waiting: 0 }, links: [{ label: "Meet", url: "https://meet.acme.example/console/" }],
      banners: [{ id: "breakglass.gate", args: {} }],
    },
  });
  await settle();
  const before = snapshot();
  for (const want of ["bob@acme.example", "ann@acme.example", "relay.acme.example", "What needs your attention"]) {
    if (!before.includes(want)) fail("the signed-in page does not show " + want + " (the harness did not reach the overview)");
  }
  await a.advance(15 * 60000 + 5000);
  const after = snapshot();
  if (!after.includes("Session locked") || !after.includes("Sign in again")) fail("no lock screen after the idle limit:\n" + after);
  if (after.includes("acme.example")) fail("the lock screen left a value in the DOM:\n" + after.split("\n").filter((l) => l.includes("acme.example")).join("\n"));
  if (after.includes("What needs your attention") || after.includes("is suspended")) fail("the lock screen left page content in the DOM");

  // 2. The sign-in banner (AC-8, 7.8): shown alone before the email field.
  boot({
    "GET me": { ok: true, user: null, product: "meet", profile: "standard", relay: { host: "relay.acme.example" }, sections: ["overview"] },
    "GET banner": { ok: true, banner: "Authorized use only.\nSecond line." },
  });
  await settle();
  const first = snapshot();
  if (!first.includes("Authorized use only.") || !first.includes("Before you sign in")) fail("the banner is not shown first:\n" + first);
  if (doc.querySelector('input[type="email"]')) fail("the email field shows before the banner is accepted");
  const agree = find("button", "I agree");
  if (!agree) fail("no I agree button");
  agree.click();
  await settle();
  if (!doc.querySelector('input[type="email"]')) fail("no email field after I agree");
  if (snapshot().includes("Authorized use only.")) fail("the banner stays after I agree");
  const pw = doc.querySelectorAll('input[type="password"]');
  if (!pw.length) fail("Standard shows the password sign-in");
  for (const p of pw) {
    const ac = p.getAttribute("autocomplete");
    if (ac !== "current-password" && ac !== "new-password") fail("a password field with autocomplete " + ac);
  }
  if (!find("button", "Forgot your password?")) fail("Standard shows Forgot your password?");
  console.log("dom: lock screen and sign-in banner ok");
}
if (mode === "dom") main().then(() => process.exit(0), (e) => fail(e && e.stack ? e.stack : String(e)));
else fail("unknown mode " + mode);
"##;

#[test]
fn placeholder_fragments_split_as_the_vector_says() {
    assert_eq!(fragments("Remove <email>?"), vec!["Remove ", "?"]);
    assert_eq!(fragments("<email> joined from <hub or device> and"), vec![" joined from ", " and"]);
    assert_eq!(fragments("a < b <X>"), vec!["a < b <X>"]);
}
