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
//
// Contract AC-2a section 16.1, slice f-ui: charts.js (9.6) and the fleet pages. charts.js and app.js have no HTML sink
// and never touch a style; every chart has a title, a desc and a table toggle; the tone classes exist for every
// palette; the fleet nav equals the vector's, with Upgrades and Support absent; every 13.1 and 13.2 string the page
// shows is the vector's; the key record navigation is the one loopback URL; and, in the DOM double, the setup screens
// render each step and resume, and Relays, People and the charts work at phone width.
//   tests/admin_console_fleet_words_v1.json   tools/make_admin_console_fleet_vectors.py
//
// Contract AC-2b-D section 16.1, slice d-ui: Deploy a relay. In the DOM double no product is preselected and Continue
// stays disabled until one is picked; disabled cards name their reasons; the details have no admins field; the code
// and the command are separate and the command never carries the code; step 4 renders the fingerprint; the CA page
// never shows a key and shows Create disabled. The 13.1 to 13.3 words the page shows are the vector's.

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
const CHARTS_JS: &str = include_str!("../console/charts.js");
const APP_CSS: &str = include_str!("../console/app.css");
const MANIFEST: &str = include_str!("../console/manifest.webmanifest");
const ICON_SVG: &[u8] = include_bytes!("../console/icon.svg");
const FAVICON_SVG: &[u8] = include_bytes!("../console/favicon.svg");

/// The one URL allowed in an asset: the SVG namespace of the icon files.
const SVG_NS: &str = "http://www.w3.org/2000/svg";
/// AC-2a 3.9: the one loopback URL app.js may name, the start of the key record navigation.
const KEY_RECORD_URL: &str = "http://127.0.0.1:\" + port + \"/admin-console/key-record?r=\" + rec)";
/// The 8.3 `bad-url` words name the scheme; the page shows them before asking the relay.
const BAD_URL_WORDS: &str = "Links must start with https:// and name a host.";

fn text_assets() -> Vec<(&'static str, String)> {
    vec![
        ("index.html", INDEX_HTML.to_owned()),
        ("theme.js", THEME_JS.to_owned()),
        ("app.js", APP_JS.to_owned()),
        ("qr.js", QR_JS.to_owned()),
        ("charts.js", CHARTS_JS.to_owned()),
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
                // The inline SVG namespace: the icon files, qr.js (the QR code) and charts.js (AC-2a 9.6), which draw with
                // createElementNS.
                let namespace = (name.ends_with(".svg") || name == "qr.js" || name == "charts.js") && rest.starts_with(SVG_NS);
                // The words that name the scheme: 8.3 `bad-url`, and AC-2b-D 13.1 `meet-ca.signer-help` and 13.3 `meet-ca-signer`.
                let words = name == "app.js"
                    && (text[..at + scheme.len()].ends_with("start with https://") || rest.starts_with("https://...).") || rest.starts_with("https:// and its host name."));
                // AC-2a 3.9: the key record's top-level navigation to the IDE plugin's or Hub app's loopback page.
                let loopback = name == "app.js" && rest.starts_with(KEY_RECORD_URL);
                assert!(namespace || words || loopback, "{name}: an outside URL at byte {at}: {}", rest.chars().take(60).collect::<String>());
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
    let charts = h.find("<script src=\"/console/charts.js\" defer></script>").expect("charts.js with defer, before app.js (AC-2a 9.6)");
    let head_end = h.find("</head>").unwrap();
    assert!(theme < head_end && app < head_end && theme < qr && qr < app && charts < app);
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
    // The `cli.*` sentences are the offline CLI's and the start log's, `log.*` the relay's log lines, and
    // `python.test-only` (with its seat clock check variant) is a test binary's start refusal: not page text.
    let not_page = |id: &str| id.starts_with("cli.") || id.starts_with("log.") || id.starts_with("python.test-only");
    let mut all = Vec::new();
    for (id, v) in words["page"].as_object().expect("page words") {
        if !not_page(id) {
            strings_of(v, &mut all);
        }
    }
    // AC-2a 11.4 (revision 3.4): the fleet People page shows meet.license-inactive beside the invite controls of a
    // Meeting Hub relay stopped for its license, still focusable with aria-disabled (7.4).
    strings_of(&words["people"]["meet.license-inactive"], &mut all);
    assert!(APP_JS.contains("\"aria-disabled\": \"true\""), "disabled invite controls stay focusable with aria-disabled (7.4)");
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
fn no_growth_gate_remains_and_the_service_state_shows() {
    // AC-1 R42-1 and AC-2a revision 3.4: the R41-1 growth gate is removed from the page (no adding state, last-license
    // limit or "no one new can be added" words), and the 4.2 license view's `service` is shown on both consoles.
    for gone in [
        "license-adding-off",
        "seats.last-license",
        "seats.no-license",
        "banner.license-inactive",
        "no one new can be added",
        "lastUsers",
        ".adding",
        "addingClosed",
        "isNewPrincipal",
    ] {
        assert!(!APP_JS.contains(gone), "app.js still holds the growth gate: {gone}");
    }
    assert!(!APP_CSS.contains(".menu-note"), "app.css still styles the disabled menu items of the growth gate");
    for shown in [
        "\"banner.license-stopped\"",
        "\"banner.grace\"",
        "\"banner.expiring\"",
        "\"seats.stopped\"",
        "\"attention.license-stopped\"",
        "\"relay.license-stopped\"",
        "\"relay.license-grace\"",
        "\"relay.license-reminders\"",
        "\"relay.license-install-stopped\"",
        "service.state === \"stopped\"",
        "s.state === \"stopped\"",
    ] {
        assert!(APP_JS.contains(shown), "app.js lacks {shown}");
    }
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
                // AC-2a 5.7: the relay's Join form takes the enrollment code in a password-type field that no password
                // manager should keep, marked data-code="enroll" with autocomplete off.
                let enroll_code = line.contains("autocomplete: \"off\"") && line.contains("\"data-code\": \"enroll\"");
                let named = ["autocomplete: \"current-password\"", "autocomplete: \"new-password\"", "autocomplete=\"current-password\"", "autocomplete=\"new-password\""]
                    .iter()
                    .any(|a| line.contains(a))
                    || enroll_code;
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

// ---- AC-2a (16.1 f-ui) ----

#[test]
fn charts_and_app_have_no_html_sink_and_touch_no_style() {
    for (name, text) in [("charts.js", CHARTS_JS), ("app.js", APP_JS)] {
        for banned in ["innerHTML", "insertAdjacentHTML", "outerHTML", "document.write", ".style", "setAttribute(\"style\"", "setAttribute('style'"] {
            assert!(!text.contains(banned), "{name} contains {banned}");
        }
    }
    // 9.6: colors only by class, geometry only from checked numbers, labels as text nodes, nothing animates.
    for banned in ["fill:", "stroke:", "color:", ".animate(", "requestAnimationFrame", "textContent =", "createElement(\"style\")"] {
        assert!(!CHARTS_JS.contains(banned), "charts.js contains {banned}");
    }
    assert!(CHARTS_JS.contains("function geo(v) {\n    return finite(v) ?"), "every geometry attribute passes Number.isFinite");
    assert!(CHARTS_JS.contains("const finite = (v) => typeof v === \"number\" && Number.isFinite(v);"));
    assert!(CHARTS_JS.contains("document.createTextNode("), "labels are text nodes");
    assert!(!CHARTS_JS.contains("fetch(") && !CHARTS_JS.contains("import "), "charts.js loads nothing");
}

/// The body of `function <name>(` in charts.js, up to the next top-level builder comment.
fn builder_body(name: &str) -> &'static str {
    let at = CHARTS_JS.find(&format!("  function {name}(")).unwrap_or_else(|| panic!("charts.js has no {name}"));
    let rest = &CHARTS_JS[at..];
    let end = rest[1..].find("\n  /**").or_else(|| rest[1..].find("\n  function setWords")).map_or(rest.len(), |e| e + 1);
    &rest[..end]
}

#[test]
fn every_chart_has_title_desc_and_a_table_toggle() {
    // The frame: role img named by its title and described by its desc.
    let frame = builder_body("frame");
    assert!(frame.contains("role: \"img\"") && frame.contains("\"aria-labelledby\": id + \"-t \" + id + \"-d\""));
    assert!(frame.contains("svg(\"title\", { id: id + \"-t\" }") && frame.contains("svg(\"desc\", { id: id + \"-d\" }"));
    // The table toggle: a details element whose summary is "Show as a table", a table with a caption.
    let table = builder_body("table");
    assert!(table.contains("html(\"details\", \"chart-table\", html(\"summary\", null, WORDS.table)"));
    assert!(table.contains("html(\"caption\", null, caption)") && table.contains("setAttribute(\"scope\", \"col\")"));
    for b in ["lineChart", "barChart", "heatStrip"] {
        let body = builder_body(b);
        assert!(body.contains("frame(o.title, desc,"), "{b} draws inside the accessible frame");
        assert!(body.contains("table(o.title,"), "{b} adds the table toggle");
        assert!(body.contains("tip(") || body.contains("hit("), "{b} carries hover values in SVG title");
    }
    // The page passes the vector's words to charts.js and draws every chart through these builders.
    let words = vector("admin_console_fleet_words_v1.json");
    assert_eq!(words["page"]["charts.table"], "Show as a table");
    assert!(APP_JS.contains("window.LucidCharts.setWords({ table: FW[\"charts.table\"], noData: FW[\"charts.no-data\"]"));
    assert!(!APP_JS.contains("createElementNS"), "app.js draws no SVG of its own");
}

#[test]
fn tone_classes_exist_for_every_palette() {
    let themes = vector("admin_console_themes_v1.json");
    let base = palette_block("lucid-dark");
    for (tone, token) in [("ok", "--ac-ok"), ("warn", "--ac-warn"), ("danger", "--ac-danger"), ("link", "--ac-link"), ("muted", "--text-secondary")] {
        let rule = format!(".ac-tone-{tone} {{ color: var({token}); }}");
        assert!(APP_CSS.contains(&rule), "app.css lacks {rule}");
        assert!(CHARTS_JS.contains(&format!("\"ac-tone-{tone}\"")), "charts.js does not use ac-tone-{tone}");
        for t in themes.as_array().unwrap() {
            let id = t["id"].as_str().unwrap();
            let value = resolve(token, &palette_block(id), &base);
            assert!(value.starts_with('#'), "{id}: {token} resolves to {value}");
        }
    }
    // SVG shapes take the tone through currentColor; text in charts stays at the 12 px floor.
    assert!(APP_CSS.contains(".chart-line { fill: none; stroke: currentColor;"));
    assert!(APP_CSS.contains(".chart-svg text { font-size: 12px;"));
}

/// The FNAV block of app.js.
fn fnav() -> &'static str {
    let at = APP_JS.find("const FNAV = [").expect("FNAV in app.js");
    &APP_JS[at..at + APP_JS[at..].find("\n  ];").unwrap()]
}

#[test]
fn fleet_nav_equals_the_vector_without_upgrades_and_support() {
    let words = vector("admin_console_fleet_words_v1.json");
    let nav = words["nav"].as_array().expect("the vector's nav list");
    let block = fnav();
    let mut at = 0;
    let mut shown = 0;
    for n in nav {
        let id = n["id"].as_str().unwrap();
        let label = n["label"].as_str().unwrap();
        assert_eq!(words["page"][id], label, "{id}");
        if !n["phase"].is_null() {
            assert!(!block.contains(&format!("\"{id}\"")), "{id} (phase {}) is in the fleet nav", n["phase"]);
            assert!(!APP_JS.contains(&format!("\"{id}\"")), "app.js names {id}, which is not rendered in AC-2a");
            continue;
        }
        shown += 1;
        let pos = block[at..].find(&format!("{{ id: \"{id}\"")).unwrap_or_else(|| panic!("{id} missing or out of order in FNAV")) + at;
        let line = &block[pos..pos + block[pos..].find('\n').unwrap_or(block.len() - pos)];
        let mut p = 0;
        for page in n["pages"].as_array().unwrap() {
            let w = format!("\"{}\"]", page.as_str().unwrap());
            p += line[p..].find(&w).unwrap_or_else(|| panic!("{id}: page {w} missing or out of order")) + w.len();
        }
        assert_eq!(line.matches("\"]").count(), n["pages"].as_array().unwrap().len(), "{id}: page count");
        at = pos + 1;
    }
    assert_eq!(block.matches("{ id: \"nav.").count(), shown, "FNAV has exactly the rendered groups");
    assert!(!APP_JS.contains("\"Upgrades\"") && !APP_JS.contains("\"Support\""));
}

#[test]
fn every_fleet_page_and_dialog_string_comes_from_the_vector() {
    let words = vector("admin_console_fleet_words_v1.json");
    let nav_reserved: Vec<&str> = words["nav"].as_array().unwrap().iter().filter(|n| !n["phase"].is_null()).map(|n| n["id"].as_str().unwrap()).collect();
    // The endorse.* words, the key-record.* loopback page words and the "endorse key" dialog are the IDE plugin's and
    // the Hub app's (3.9), not the page's.
    let not_page = |id: &str| id.starts_with("endorse.") || id.starts_with("key-record.") || nav_reserved.contains(&id);
    let mut missing = Vec::new();
    let mut n = 0;
    for (id, s) in words["page"].as_object().expect("page words") {
        if not_page(id) {
            assert!(!APP_JS.contains(&format!("\"{id}\"")), "app.js shows {id}, which is not a page word");
            continue;
        }
        let line = format!("\"{id}\": {}", serde_json::to_string(s).unwrap());
        if !APP_JS.contains(&line) {
            missing.push(line);
        }
        n += 1;
    }
    for (key, d) in words["dialogs"].as_object().expect("dialogs") {
        if key == "endorse-key" {
            assert!(!APP_JS.contains(&format!("\"{key}\"")), "app.js shows the apps' endorse key dialog");
            continue;
        }
        let line = format!("\"{key}\": {{ title: {}, body: {}, button: {} }}", serde_json::to_string(&d["title"]).unwrap(),
            serde_json::to_string(&d["body"]).unwrap(), serde_json::to_string(&d["button"]).unwrap());
        if !APP_JS.contains(&line) {
            missing.push(line);
        }
        n += 1;
    }
    // The refusals the page shows before asking (13.3) are the vector's words.
    // AC-2b-D 13.3: the deploy, CA import and org root refusals the page checks before posting.
    for code in ["fleet-scope-needs-people", "fleet-scope-required", "csv-limit", "deploy-product", "deploy-env", "deploy-host", "deploy-clients", "meet-ca-confirm",
        "meet-ca-key", "meet-ca-signer", "spokes-root-key"] {
        let line = format!("\"{code}\": {}", serde_json::to_string(&words["refusals"][code]["words"]).unwrap());
        if !APP_JS.contains(&line) {
            missing.push(line);
        }
    }
    assert!(n > 200, "{n} strings checked");
    assert!(missing.is_empty(), "fleet words in app.js differ from the vector:\n{}", missing.join("\n"));
    // Revision 3.2: a confirmed change the relay may not have run is shown to the admin.
    assert!(APP_JS.contains("w.result === \"unknown\" ? FW[\"fleet.confirm-unknown\"]"));
}

#[test]
fn key_record_navigation_is_the_one_loopback_url() {
    // 3.9: a top-level navigation (no fetch, so connect-src stays 'self'), only with the app's own port and nonce.
    assert_eq!(positions(APP_JS, "http://").len(), 1, "app.js names one http URL");
    assert!(APP_JS.contains(&format!("location.assign(\"{KEY_RECORD_URL};")));
    assert!(APP_JS.contains("const RECORD = /^([0-9]{1,5})\\.([A-Za-z0-9_-]{22})$/;"));
    assert!(APP_JS.contains("return port >= 1 && port <= 65535 ? port : null;"));
    assert!(APP_JS.contains("if (!port || !/^[A-Za-z0-9_-]{1,8192}$/.test(rec)) return false;"));
    // The record value comes from #join=...&record= or #record= and leaves the address bar at once.
    assert!(APP_JS.contains("const rec = /^#(?:join=[^&]*&)?record=/.test(h)"));
    assert!(APP_JS.contains("if (link || rec) history.replaceState(null, \"\", location.pathname + location.search);"));
    assert!(APP_JS.contains("FW[\"account.record-key\"]"));
}

#[test]
fn fleet_setup_resumes_and_relays_people_and_charts_fit_a_phone() {
    // 12.1 to 12.3 and AC-1 7.2: the setup screens render each step and resume; Relays, People and the charts at
    // phone width.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("admin_console_fleet_words_v1.json");
    assert!(path.exists(), "{}: copy it from Meeting Hub tests/vectors after running its generator", path.display());
    run_harness("fleet", path.to_str().unwrap());
}

#[test]
fn settings_ai_renders_the_contract_words_and_approve_only_after_a_pass() {
    // AI-1 section 9 in the DOM double: who may use AI, the presets, a save waiting for the device's signature, cards
    // with Run benchmark and Approve only on the card that passed, the 80% warning, the hold, and the archive section
    // of a small organization without and with an archive and of a big one.
    run_harness("ai", "");
}

#[test]
fn settings_api_and_exports_render_and_a_secret_is_shown_once() {
    // API-1 7.3 (API-1a6) in the DOM double, from the spec's answer shapes of GET settings/api and GET settings/exports:
    // the API access page (org chips, state, staged changes with the signing state, clients, scrape tokens, grace,
    // origins, kill switch, journal, Explain), the save with its relay choice, a new secret shown once in its own dialog
    // and gone from the page once it closes, and the Exports destinations with status, failover and Set credential,
    // whose material leaves the page with its dialog.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("admin_console_fleet_words_v1.json");
    assert!(path.exists(), "{}: copy it from Meeting Hub tests/vectors after running its generator", path.display());
    run_harness("api", path.to_str().unwrap());
}

#[test]
fn api_r4_screens_render_and_a_v1_secret_leaves_no_trace() {
    // API-1 revision 4 13.2 (slice 1b8) in the DOM double, from the answer shapes of GET settings/api, GET settings/exports,
    // GET compliance/holds, GET compliance/exports and GET directory/status: the client editor's Compliance and
    // Directory sections (recipient thumbprint, reviewers rule, Meet CA fingerprint, the three values to paste into
    // Entra), the relay set with relay-outdated and Retire, webhook destinations (verification, paused, Resume, Replay
    // from), webhook keys, the outbound identity, the prefer-federation advice, the Compliance page with its reviewer
    // state and Cancel export, the Directory card, the new attention items, and a v1 secret shown once in its own dialog
    // and gone from the page once it closes.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("admin_console_fleet_words_v1.json");
    assert!(path.exists(), "{}: copy it from Meeting Hub tests/vectors after running its generator", path.display());
    run_harness("api-r4", path.to_str().unwrap());
}

#[test]
fn api_r5_screens_render_and_post_their_bodies() {
    // API-1 revision 5 14.2 (slice 1c7) in the DOM double, from the answer shapes of the 1c7 contract (GET settings/api
    // with connectors, connector_status, api_apps, ai_groups, idps, providers, api_return and person_revokes; GET
    // settings/api/delegations; GET settings/api/approvals; GET meet/ai with ai.local_mcp): the two-person reasons, the
    // content and delegated clients with their people, approvals and revokes, connectors with a stale and a never-synced
    // one and their key stores, identity providers, the sign-in providers with api_return and Copy, and Settings > AI >
    // Local MCP on an enterprise and a standard license. It checks the bodies of Add connector, Suspend, IdP Test, Set
    // SSO URL, Revoke, Allow again, the client editor's Content and Delegation, and the Local MCP stage.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("admin_console_fleet_words_v1.json");
    assert!(path.exists(), "{}: copy it from Meeting Hub tests/vectors after running its generator", path.display());
    run_harness("api-r5", path.to_str().unwrap());
}

#[test]
fn api_r6_screens_render_and_post_their_bodies() {
    // API-1 revision 6 7.14 (slice 1d5) in the DOM double, from the answer shapes of the 1d5 contract (GET settings/api
    // with a spokes_hub client and an agent client with a2a, card, card_check and handoff; GET settings/api/a2a (A2aView);
    // GET settings/api/a2a/tasks (TaskView); GET settings/api/spokes (SpokesView)): the three tabs, the partner card check
    // and hand-off with the R6-12 sentence, the agents with their card state, Copy card URL and the signed card, card keys
    // (signed and staged), the root well-known card, the Tasks list and its filter, and Remote Spokes. It checks the
    // bodies of Check now, Push off, the client editor's agent and service hub fields, Add agent, Change (refused on the
    // page without a new version), Delete, Make a card key, Drop key, the root well-known choice, Bind, Unbind and Set
    // root, and that nothing posts to the removed settings/api/spokes/relays.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("admin_console_fleet_words_v1.json");
    assert!(path.exists(), "{}: copy it from Meeting Hub tests/vectors after running its generator", path.display());
    run_harness("api-r6", path.to_str().unwrap());
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

// Loads theme.js, qr.js, charts.js and app.js against a fake relay that answers `answers` ("GET me", "POST
// login/begin", ...). opts.hash is the starting hash (setting location.hash fires hashchange, as a browser does);
// opts.narrow makes "(max-width: 600px)" match, the phone width of AC-1 7.2. Every request is kept in `calls`.
let loc = null;
let calls = [];
function boot(answers, opts) {
  const o = opts || {};
  doc = new FDocument();
  calls = [];
  parseHTML(read("index.html"));
  const winL = {};
  loc = {
    _h: o.hash || "", pathname: "/console/", search: "", host: "relay.acme.example",
    get hash() {
      return this._h;
    },
    set hash(v) {
      const n = String(v);
      if (n === this._h) return;
      this._h = n;
      setImmediate(() => (winL.hashchange || []).forEach((f) => f()));
    },
    assign(u) {
      this.assigned = String(u);
    },
  };
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
    location: loc,
    history: { replaceState() {} },
    navigator: { credentials: {}, clipboard: { writeText: async () => {} } },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    matchMedia: (q) => ({ matches: !!o.narrow && /max-width: 600px/.test(q), addEventListener() {} }),
    PublicKeyCredential: function PublicKeyCredential() {},
    addEventListener: (t, f) => (winL[t] = winL[t] || []).push(f),
    setTimeout: (f, ms) => add(f, ms, 0),
    setInterval: (f, ms) => add(f, ms, ms),
    clearTimeout: clear,
    clearInterval: clear,
    fetch: async (url, init) => {
      const route = (init.method || "GET") + " " + String(url).replace("/console/api/", "").split("?")[0];
      calls.push({ route, url: String(url), body: init.body ? JSON.parse(init.body) : null });
      const body = answers[route] || { ok: true };
      const ok = body.ok !== false;
      return { ok, status: ok ? 200 : body.status || 400, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(body)) };
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext("Date.now = function () { return __clock.now; };", ctx);
  for (const f of ["theme.js", "qr.js", "charts.js", "app.js"]) vm.runInContext(read(f), ctx, { filename: f });
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
      banners: [{ id: "breakglass.gate", args: {} }, { id: "banner.license-stopped", args: { why: "none" } }],
    },
  });
  await settle();
  const before = snapshot();
  for (const want of ["bob@acme.example", "ann@acme.example", "relay.acme.example", "What needs your attention"]) {
    if (!before.includes(want)) fail("the signed-in page does not show " + want + " (the harness did not reach the overview)");
  }
  // AC-1 7.2 (R42-1): the blocking stopped banner with the why words and "Install a license" for admins.
  const stoppedText = doc.querySelectorAll(".banner.bad").map((b) => b.textContent).join("\n");
  if (!stoppedText.includes("This relay has stopped serving people: its Remote Spokes license is not active (no license is installed). Install a license to turn service back on.")) {
    fail("no banner.license-stopped with its why words:\n" + stoppedText);
  }
  if (!doc.querySelector('.banner.bad a[href="#/license"]')) fail("the stopped banner has no Install a license link for an admin");
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
// ---- AC-2a: the fleet console (12.1 to 12.4, 8, 9.6, 11) ----
const view = () => doc.getElementById("view").textContent;
const go = async (h) => {
  loc.hash = h;
  for (let i = 0; i < 4; i++) await settle();
};
function inOrder(text, list, what) {
  let at = -1;
  for (const w of list) {
    const i = text.indexOf(w, at + 1);
    if (i < 0) fail(what + ": " + w + " is missing or out of order in:\n" + text);
    at = i;
  }
}
function chartsComplete(where) {
  const svgs = doc.querySelectorAll("figure svg.chart-svg");
  if (!svgs.length) fail(where + ": no chart");
  for (const s of svgs) {
    if (s.getAttribute("role") !== "img") fail(where + ": a chart without role img");
    const kids = s.children.map((k) => k.tagName);
    if (!kids.includes("TITLE") || !kids.includes("DESC")) fail(where + ": a chart without title and desc");
    const fig = s.closest("figure");
    const sum = fig.querySelector("details.chart-table summary");
    if (!sum || sum.textContent !== "Show as a table") fail(where + ": a chart without its table toggle");
    if (!fig.querySelector("details.chart-table table caption")) fail(where + ": a chart table without a caption");
  }
  return svgs;
}
async function fleetMain(v) {
  const W = v.page;
  const t0 = 1763300000000;
  // 1. First run (12.1, 12.2 steps 1 and 2): before bootstrap only the setup screen shows.
  boot({
    "GET me": { ok: false, status: 409, code: "setup-needed", error: "Finish the first step of setup first." },
    "GET setup": { ok: true, bootstrapped: false, profileFixed: null, pinned: false, steps: null },
  });
  await settle();
  inOrder(view(), [W["setup.code-title"], "Step 1 of 6", W["setup.code-field"], W["setup.gov"], W["setup.gov-yes"], W["setup.gov-no"], W["setup.gov-help"], W["setup.save"]], "setup step 1");
  if (doc.querySelector('[aria-label="Sections"] a')) fail("the setup screen shows navigation");
  doc.querySelector('input[type="text"]').value = "ABCDEFGH IJKLMNOP QRSTUVWX YZ234567";
  find("button", W["setup.save"]).click();
  await settle();
  inOrder(view(), [W["setup.first-admin"], "Step 2 of 6", W["setup.email-field"], W["setup.back"], W["setup.save"]], "setup step 2");

  // 2. A signed-in admin of a fleet console.
  const r1 = "r_0000000000000001", r2 = "r_0000000000000002";
  const answers = {
    "GET me": {
      ok: true, product: "fleet", profile: "standard", origin: "https://console.acme.example", relay: { host: "console.acme.example" }, sections: [],
      idle: { minutes: 15, maxHours: 12 },
      user: { email: "ann@acme.example", role: "admin", rights: "admin", rightsWhy: null, state: "active", breakGlass: false,
        methods: { webauthn: [{ hint: "h1", label: "Key", kind: "passkey", state: "working" }], password: false, totp: false }, mustSetPassword: false, sessions: 1, mail: [] },
    },
    "GET settings": { ok: true, twoPerson: "off", profile: "standard", links: [], signIn: { requirePassword: false, idleMinutes: 15, maxHours: 12 }, email: { mode: "off" } },
    "GET banner": { ok: true, banner: null },
    "GET overview": {
      ok: true, product: "fleet", cards: [], approvals: { waiting: 0, mine: 0 },
      fleet: { relays: { total: 2, ok: 1, warn: 0, bad: 1, silent: 0, unconfirmed: 1 }, people: { online: 3 }, calls: { active: 1 },
        kpis: { relaysHealthy: { n: 1, total: 2, spark: [[t0 - 3600000, 2], [t0, 1]] }, peopleOnline: { n: 3, spark: [[t0 - 3600000, 2], [t0, 3]] },
          callsNow: { n: 1, spark: [] }, messagesToday: { n: 40, spark: [] } } },
      attention: [{ kind: "relay-silent", severity: "bad", args: { relay: r1, minutes: 5 }, go: "#/relays/" + r1 },
        { kind: "cert-expiring", severity: "warn", relay: r2, args: { n: 2 } }, { kind: "no-such-kind", severity: "bad", relay: r2, args: {} },
        { kind: "relay-license-stopped", severity: "bad", relay: r2, args: {}, go: "#/license?relay=" + r2 }],
    },
    "GET setup": { ok: true, bootstrapped: true, profileFixed: null, pinned: false, steps: { signin: "done", email: "open", license: "skipped", relay: "open" } },
    "GET fleet/relays": { ok: true, total: 2, relays: [
      { id: r1, name: "Dallas east", site: "us-east", product: "spokes", state: "active", connected: true, lastContactAt: t0, version: "2.5.0", health: "ok",
        license: { state: "valid", daysLeft: 200 }, scopes: ["read-health", "people"], readOnly: false, confirm: [] },
      { id: r2, name: "Hub west", site: "us-west", product: "meet", state: "unconfirmed", connected: true, lastContactAt: t0, version: "2.5.0", health: "bad",
        license: { state: "expired", daysLeft: -3, service: { state: "stopped", stopsAt: null, why: "expired" } }, scopes: ["read-health"], readOnly: true, confirm: ["people"] }] },
    "GET fleet/licenses": { ok: true, relays: [{ relay: r2, product: "meet", license: { state: "expired" }, service: { state: "stopped", stopsAt: null, why: "expired" },
      reminders: [{ kind: "stopped", at: t0 }], seats: { seated: 5, users: 4 } }], library: [] },
    "GET fleet/metrics": { ok: true, range: "24h", step: 300000, series: [
      { relay: "fleet", name: "people_online", unit: "people", points: [[t0 - 900000, 1], [t0 - 600000, 2], [t0 - 300000, null], [t0, 4]] },
      { relay: "fleet", name: "messages", unit: "messages", points: [[t0 - 600000, 10], [t0 - 300000, 12], [t0, 3]] },
      { relay: r1, name: "cpu_host", unit: "percent", points: [[t0 - 600000, 50], [t0, 95]] },
      { relay: r2, name: "latency_console", unit: "ms", points: [[t0 - 600000, 40], [t0, 700]] }] },
    "GET fleet/expiry": { ok: true, rows: [{ relay: r1, kind: "mgmt", notAfter: t0, daysLeft: 5 }, { relay: r2, kind: "license", notAfter: t0, daysLeft: 45 }] },
    "GET fleet/people": { ok: true, total: 2, missing: [{ relay: r1, why: "relay-offline" }], rows: [
      { kind: "console", id: "bob@acme.example", name: null, role: "viewer", state: "active", source: "invite", relay: null },
      { kind: "meet", relay: r2, id: "carol@acme.example", name: "=Carol+1", role: "member", state: "active", source: "app", devices: 2, seated: true, asOf: t0 }] },
    "GET admins": { ok: true, people: [], waiting: [], invites: [] },
    // AC-2b-D 9.1: Deploy a relay, its enrollment, the CA page and the Remote Spokes root.
    "GET fleet/deploy/options": { ok: true, profile: "standard", console: { os: "linux", arch: "x86_64" }, binary: { version: "2.6.0", arch: "x86_64", sha256: "ab".repeat(32), size: 1, fips: true },
      fleetUrl: "https://console.acme.example:8444", pins: "sha256//AAAA", meetCa: { id: "m_0123", state: "ok", signerUrl: null }, spokesRoot: null, library: [],
      envs: [{ id: "linux", products: ["meet", "spokes"], offered: true, why: null }, { id: "proxmox", products: ["meet", "spokes"], offered: true, why: null },
        { id: "docker", products: ["meet", "spokes"], offered: false, why: "no Docker build for this console" }, { id: "installed", products: ["meet", "spokes"], offered: true, why: null }] },
    "POST stepup/begin": { ok: true, ceremony: "c1", totp: true, publicKey: {} },
    "POST fleet/enroll": { ok: true, id: "en_0123456789abcdef", code: "LCE1-SECRETSECRETSECRET", expires: t0 + 3600000, commands: { spokes: "a", meet: "b", local: "c" },
      install: { env: "linux", command: "curl -fsS --proto =https -k --pinnedpubkey 'sha256//AAAA' 'https:" + "//console.acme.example:8444/fleet/v1/install/meet-linux.sh?e=en_0123456789abcdef' | sudo bash",
        steps: null, uninstall: "uninstall-command", offlineUninstall: "offline-uninstall-command", scriptUrl: null, pins: "sha256//AAAA", binary: { version: "2.6.0", arch: "x86_64", sha256: "ab".repeat(32), size: 1 } },
      offered: [] },
    "GET fleet/enrollments/en_0123456789abcdef": { ok: true, enrollment: { id: "en_0123456789abcdef", state: "used", product: "meet", env: "linux", expires: t0 + 3600000, deploy: {},
      relay: { id: "r_0000000000000003", state: "unconfirmed", fingerprint: "1a2b 3c4d 5e6f 7a8b 9c0d 1e2f 3a4b 5c6d 7e8f 9a0b", bootstrap: null, license: { service: null } } } },
    "GET fleet/meet-ca": { ok: true, ca: null, allowed: true, why: null },
    "GET fleet/spokes-root": { ok: true, root: null },
  };
  boot(answers, { hash: "#/overview" });
  for (let i = 0; i < 4; i++) await settle();
  const ov = view();
  inOrder(ov, [W["nav.overview"], W["setup.checklist"], W["setup.email"], W["setup.state-open"], W["setup.continue"], W["setup.hide"], W["kpi.relays"], "1 of 2", W["kpi.people"],
    W["kpi.calls"], W["kpi.messages"]], "overview");
  if (!ov.includes("Dallas east has not been in touch for 5 minutes.")) fail("fleet attention without the console's relay name:\n" + ov);
  if (!ov.includes("Hub west: 2 certificates end within 7 days.")) fail("a relay's attention item without its relay name");
  // AC-2a 8.1 (revision 3.4): a relay stopped for its license, named by the console, without a doubled prefix.
  if (!ov.includes("Hub west stopped: no active license. It serves no one until a license is installed.")) fail("no relay-license-stopped item:\n" + ov);
  if (ov.includes("Hub west: Hub west stopped")) fail("the relay-license-stopped item names its relay twice");
  if (doc.getElementById("hdr-product").textContent !== W["chip.fleet"] || doc.getElementById("hdr-count").textContent !== "2 relays") fail("the header chips");
  // 12.4: the nav order and names; Upgrades and Support are not rendered.
  const nav = doc.getElementById("nav").textContent;
  inOrder(nav, v.nav.filter((n) => n.phase == null).map((n) => n.label), "nav");
  for (const n of v.nav.filter((x) => x.phase != null)) if (nav.includes(n.label)) fail("the nav renders " + n.label);

  // 12.2: each step renders with "Step <n> of 6"; 12.3: Skip for now moves to the next step not done (resume).
  const steps = [["admin", 2, "setup.first-admin"], ["signin", 3, "setup.signin"], ["email", 4, "setup.email"], ["license", 5, "setup.license"], ["relay", 6, "setup.relay"]];
  for (const [id, n, word] of steps) {
    await go("#/setup/" + id);
    inOrder(view(), [W[word], "Step " + n + " of 6"], "setup step " + id);
    if (id === "admin" && find("button", W["setup.skip"])) fail("the first admin step can be skipped");
    if (id !== "admin" && !find("button", W["setup.skip"])) fail("step " + id + " has no Skip for now");
    if (!find("button", id === "relay" ? W["setup.finish"] : W["setup.save"])) fail("step " + id + " has no " + (id === "relay" ? "Finish" : "Save and continue"));
  }
  const relayStep = view();
  // AC-2b-D 12: "Another host" opens Deploy a relay at step 1 inside the wizard frame.
  for (const w of [W["setup.this-host"], W["setup.this-host-standard"], W["setup.other-host"], "Step 1 of 4", W["deploy.product-h"], W["deploy.product-meet-help"],
    W["deploy.product-spokes-help"], W["deploy.product-none"]]) {
    if (!relayStep.includes(w)) fail("the first relay step lacks " + w);
  }
  await go("#/setup/email");
  find("button", W["setup.skip"]).click();
  for (let i = 0; i < 4; i++) await settle();
  const posted = calls.find((c) => c.route === "POST setup/step");
  if (!posted || posted.body.step !== "email" || posted.body.state !== "skipped") fail("Skip for now did not record the step");
  if (loc.hash !== "#/setup/license") fail("after skipping email the wizard went to " + loc.hash + ", not the next open step");

  // 8.2 and 9.6: Relays and the charts.
  await go("#/relays");
  const rel = view();
  for (const w of ["Dallas east", "Hub west", W["health.ok"], W["health.bad"], W["fleet.read-only"], W["state.unconfirmed"], W["fleet.confirm-here"],
    "Stopped: no active license"]) {
    if (!rel.includes(w)) fail("the relay list lacks " + w);
  }
  // 11.4 (revision 3.4): the License page shows the service state with why and the reminders, with no adding column.
  await go("#/license");
  const lv = view();
  for (const w of ["Stopped: no active license", "The license ended and its grace is over.", "Reminders sent: "]) {
    if (!lv.includes(w)) fail("the license page lacks " + w + ":\n" + lv);
  }
  if (lv.includes("Adding people")) fail("the license page still shows the adding state");
  await go("#/relays/health");
  const hv = view();
  for (const k of ["charts.range-1h", "charts.range-24h", "charts.range-7d", "charts.range-30d", "charts.people", "charts.messages", "charts.cpu", "charts.memory",
    "charts.network", "charts.latency", "charts.expiry", "charts.health"]) {
    if (!hv.includes(W[k])) fail("the health page lacks " + W[k]);
  }
  chartsComplete("health");
  await go("#/people");
  const pv = view();
  for (const w of ["Some relays did not answer: Dallas east.", "=Carol+1", W["people.invite"], W["people.import"], W["people.import-check"], W["people.kind-meet"]]) {
    if (!pv.includes(w)) fail("the people page lacks " + w);
  }

  // AC-2b-D 3 (16.1 d-ui): Deploy a relay.
  await go("#/relays/add");
  const radios = () => doc.getElementById("view").querySelectorAll('input[type="radio"]');
  const pick = async (value) => {
    const r = radios().find((x) => x.getAttribute("value") === value);
    if (!r) fail("no card " + value);
    r.checked = true;
    r.dispatchEvent(new FEvent("change"));
    await settle();
    return r;
  };
  const fieldOf = (label) => {
    const l = doc.getElementById("view").querySelectorAll("label").find((x) => x.textContent === label);
    return l ? doc.getElementById(l.getAttribute("for")) : null;
  };
  const cont = () => find("button", W["deploy.continue"]);
  inOrder(view(), [W["deploy.title"], "Step 1 of 4", W["deploy.product-h"], W["deploy.product-meet-help"], W["deploy.product-spokes-help"], W["deploy.product-none"]], "deploy step 1");
  // 3.2: no product preselected; Continue disabled until one is picked.
  if (radios().length !== 2 || radios().some((r) => r.checked)) fail("a product is preselected or the two product cards are missing");
  if (!cont() || !cont().disabled) fail("Continue is enabled before a product is picked");
  cont().click();
  await settle();
  if (loc.hash !== "#/relays/add" || !view().includes("Step 1 of 4")) fail("Continue moved on without a product");
  await pick("meet");
  if (cont().disabled) fail("Continue stays disabled after a product is picked");
  cont().click();
  for (let i = 0; i < 4; i++) await settle();
  // 3.3: every card names its prerequisites; a card not offered is disabled with its reason; the clouds come next.
  const where = view();
  inOrder(where, ["Step 2 of 4", W["deploy.where-h"], W["deploy.env-linux"], W["deploy.needs"], "Debian 12 or 13, or Ubuntu 22.04 or 24.04, on x86_64", W["deploy.need-size-meet"],
    W["deploy.need-dns-meet"], W["deploy.need-ports-meet"], "console.acme.example:8444 (TCP)", W["deploy.need-tls-meet"], W["deploy.need-sudo"], W["deploy.env-proxmox"], W["deploy.need-proxmox"],
    W["deploy.env-docker"], W["deploy.need-docker"], W["deploy.docker-turn-note"], "This console cannot hand out the Linux relay program (no Docker build for this console).",
    W["deploy.env-installed"], W["deploy.env-installed-help"], W["deploy.env-azure"], W["deploy.env-next"], W["deploy.env-aws"], W["deploy.env-gcp"], W["deploy.env-windows"]], "deploy step 2");
  for (const v of ["docker", "azure", "aws", "gcp", "windows"]) {
    const r = radios().find((x) => x.getAttribute("value") === v);
    if (!r || !r.disabled) fail("the " + v + " card is not disabled");
    const why = doc.getElementById(r.getAttribute("aria-describedby") || "");
    if (!why || !why.textContent) fail("the disabled " + v + " card does not name its reason");
  }
  if (!cont().disabled) fail("Continue is enabled before a place is picked");
  await pick("linux");
  cont().click();
  for (let i = 0; i < 4; i++) await settle();
  // 3.4: the details; no admins field (the script asks on the host).
  const det = view();
  inOrder(det, ["Step 3 of 4", W["deploy.details-h"], W["enroll.name"], W["deploy.host"], W["deploy.turn-host"], W["deploy.pki"], W["deploy.pki-console"], W["deploy.pki-own"],
    W["deploy.license"], W["deploy.license-none"], W["deploy.admins-note"], W["deploy.make"]], "deploy step 3");
  if (doc.getElementById("view").querySelectorAll("label").some((l) => /admin/i.test(l.textContent) && l.getAttribute("for"))) fail("the details have an admins field");
  if (radios().some((r) => r.checked)) fail("a relay certificate source is preselected");
  fieldOf(W["enroll.name"]).value = "Hub east";
  fieldOf(W["deploy.host"]).value = "Meet.Acme.Example";
  await pick("console");
  find("button", W["deploy.make"]).click();
  await settle();
  if (!doc.getElementById("confirm").open) fail("Make code and command does not open the enroll dialog");
  doc.getElementById("confirm-go").click();
  for (let i = 0; i < 4; i++) await settle();
  doc.getElementById("code-input").value = "123456";
  doc.getElementById("code-go").click();
  for (let i = 0; i < 6; i++) await settle();
  const mint = calls.find((c) => c.route === "POST fleet/enroll");
  if (!mint) fail("no mint was posted");
  const mb = mint.body;
  if (mb.product !== "meet" || mb.env !== "linux" || !mb.deploy || mb.deploy.host !== "meet.acme.example" || mb.deploy.pki !== "console" || mb.deploy.turnHost !== null
    || "admins" in mb || "admins" in mb.deploy) fail("the mint body is not 6.1's: " + JSON.stringify(mb));
  // The code and the command are separate, and the command never carries the code (A1-M1).
  const once = doc.querySelectorAll("code.code-once");
  if (once.length !== 1 || once[0].textContent !== "LCE1-SECRETSECRETSECRET") fail("the code is not shown once in its own block");
  const cmds = doc.querySelectorAll("code.cmd");
  if (!cmds.some((c) => c.textContent.includes("meet-linux.sh?e=en_0123456789abcdef"))) fail("the install command is not shown");
  if (cmds.some((c) => c.textContent.includes("LCE1-"))) fail("a command carries the code");
  inOrder(view(), [W["enroll.code-title"], W["enroll.code-once"], W["deploy.install-h"], W["deploy.install-linux"], W["deploy.pin-note"], "Relay program 2.6.0 for x86_64, SHA-256 ",
    W["deploy.uninstall"], W["deploy.uninstall-offline"], W["deploy.anchor-note"], W["deploy.continue"]], "deploy code");
  // 3.6: step 4 reopens from the server, without the code, and renders the fingerprint to compare.
  cont().click();
  for (let i = 0; i < 6; i++) await settle();
  if (loc.hash !== "#/relays/add/en_0123456789abcdef") fail("step 4 is not at its enrollment hash: " + loc.hash);
  const wait = view();
  inOrder(wait, ["Step 4 of 4", W["deploy.wait-h"], "Hub east connected.", W["deploy.compare"], "1a2b 3c4d 5e6f 7a8b 9c0d 1e2f 3a4b 5c6d 7e8f 9a0b", W["enroll.confirm-help"], "Confirm relay",
    W["deploy.done"]], "deploy step 4");
  if (snapshot().includes("LCE1-SECRET")) fail("the code stays on the page at step 4");
  if (!doc.querySelectorAll("code.fingerprint-big").length) fail("the fingerprint is not in large type");

  // 3.7: the CA page never shows a key and shows Create disabled as coming next; 3.8 and 12: the License sections.
  await go("#/license/meet-ca");
  const cav = view();
  inOrder(cav, [W["meet-ca.title"], W["meet-ca.warn"], W["meet-ca.none"], W["meet-ca.import"], W["meet-ca.import-help"], W["meet-ca.signer"], W["meet-ca.signer-help"],
    W["meet-ca.confirm-no-high"], W["meet-ca.create-next"], W["deploy.env-next"]], "CA page");
  const create = find("button", W["meet-ca.create-next"]);
  if (!create || create.getAttribute("aria-disabled") !== "true") fail("Create a new CA is not disabled");
  if (doc.getElementById("view").querySelectorAll("textarea").length) fail("the CA page has a text area a key could be shown in");
  const files = doc.getElementById("view").querySelectorAll('input[type="file"]');
  if (files.length !== 4) fail("the import takes " + files.length + " files, not ca.crt, ca.key, issued.json and crl.pem");
  await go("#/license");
  const lic2 = view();
  for (const w of [W["meet-ca.title"], W["spokes-root.title"], W["spokes-root.help"], W["spokes-root.set"]]) {
    if (!lic2.includes(w)) fail("the license page lacks " + w);
  }

  // AC-1 7.2 phone widths: tables become stacked cards with folded filters, charts draw narrow, still with their tables.
  for (const [hash, what] of [["#/relays", "relays"], ["#/people", "people"], ["#/relays/health", "charts"]]) {
    boot(answers, { hash, narrow: true });
    for (let i = 0; i < 4; i++) await settle();
    if (what === "charts") {
      for (const s of chartsComplete("phone charts")) if (!String(s.getAttribute("viewBox")).startsWith("0 0 360 ")) fail("a chart is not drawn narrow on a phone");
    } else {
      const stack = doc.querySelectorAll(".datatable .stack section");
      if (!stack.length) fail(what + ": no stacked cards at phone width");
      const fold = doc.querySelector("details.filters-fold");
      if (!fold || fold.hasAttribute("open")) fail(what + ": filters not folded at phone width");
    }
  }
  console.log("fleet: setup, resume, relays, people and charts ok");
}

// ---- AI-1 section 9: Settings > AI on a Meeting Hub relay ----
async function aiMain() {
  const host = { host: "relay.acme.example", version: "0.98.0", uptimeSeconds: 100, fips: false };
  const me = {
    ok: true, product: "meet", profile: "standard", origin: "https://relay.acme.example", relay: host,
    sections: ["overview", "meet", "approvals", "admins"], idle: { minutes: 15, maxHours: 12 },
    user: { email: "ann@acme.example", role: "admin", rights: "admin", rightsWhy: null, state: "active", breakGlass: false,
      methods: { webauthn: [], password: false, totp: false }, mustSetPassword: false, sessions: 1, mail: [] },
  };
  const presets = [
    { id: "device", label: "This computer only", order: ["device"], access: "none" },
    { id: "org-first", label: "Org servers first", order: ["org", "device", "frontier"], access: "org" },
    { id: "device-org-frontier", label: "This computer, then org servers, then frontier", order: ["device", "org", "frontier"], access: "org" },
  ];
  const card = (id, approvable) => ({ gateway: "https://ai.acme.example:8443", card_id: id, tier: "org", model: "llama-3.3-70b", precision: { weights: "fp8-e4m3" }, hardware: { gpu: "H100" },
    throughput: {}, quality: {}, status: "pending", retire_after: "2027-06-01", bench: null, approvable });
  const base = {
    "GET me": me, "GET settings": { ok: true, twoPerson: "on", profile: "standard", links: [] }, "GET banner": { ok: true, banner: null },
    "GET overview": { ok: true, product: "meet", relay: host, cards: [], attention: [], approvals: { waiting: 0, mine: 0 }, requests: { waiting: 0 }, links: [], banners: [] },
    "GET meet/ai": {
      ok: true, org: "acme", orgs: [{ id: "acme", label: "Acme" }], presets, default: "device-org-frontier", advanced: "Advanced",
      ai: { v: 1, enabled: true, who: { groups: ["g-1"] }, order: ["device"], frontier: { access: "none" } }, preset: "device",
      map: { who_principals: ["bob@acme.example"] }, staged: null, saving: [{ step: "map", request: "rq_0000000000000001", principal: "ann@acme.example" }],
      waiting: [], gateways: [], edition: "standard", lacks: null, reviewers: ["rev@acme.example"], consoleSpki: "a".repeat(64), results: [],
    },
    "GET meet/ai/cards": { ok: true, cards: [card("passed-card", true), card("unbenched-card", false)], errors: [] },
    "GET meet/ai/usage": { ok: true, requests: 12, refusals: { budget: 2 }, spend: { month_usd_micro: 900, month_limit_usd_micro: 1000, warning: "AI spend has reached 80% of this month's budget." }, cards: [], missing_rids: ["0f".repeat(16)],
      audit: { personal: { requests: 3, by_provider: { anthropic: { key: 1, oauth: 2 } }, plans: { anthropic: { business: 2, not_business: 0, unknown: 1 } }, tokens_in: 160, tokens_out: 26 },
        dropped: { count: 1, by_reason: { encoding: 1 }, latest: [{ rid: "d".repeat(32), ts: 5, reason: "encoding" }] }, other: 0, partial: false } },
    "GET meet/ai/archive": { ok: true, size: "small", archive: null, add: "Add an archive", notice: "No archive. AI history stays on each person's devices; a legal hold cannot retrieve it." },
    // API-1d6 (r6 8.11): Tools (MCP), one gateway behind on the journal and one tool whose hash changed
    "GET meet/ai/mcp": { ok: true, org: "acme", ceilings: ["public", "internal", "confidential", "cui"], minimums: { hub: "0.99.0", ios: "0.99.0" }, readers: null, head: 1,
      servers: [{ id: "m_3f2e1d0c9b8a7f6e", name: "Jira (read)", url: "https://mcp.jira.acme.example/mcp", ceiling: "internal", private_ok: false, groups: ["eng"], activities: ["search"],
        auth: { type: "oauth_private_key_jwt", scope: "issues:read", expires: 1763650000 }, tools: [{ name: "search_issues", effect: "read", schema_sha256: "a".repeat(64) }],
        attest: { by: ["ann@acme.example", "carl@acme.example"], at: 1763200000, statement: "Every member of eng may read everything the issues:read credential of Jira (read) can read." },
        max_calls: 4, args_max: 4096, result_max: 65536, risk: "The gateway calls Jira (read) with its own credential, not the person's." }],
      gateways: [{ url: "https://ai-1.acme.example:8443", ack: 1, applied: true, waiting: 0,
        state: { servers: [{ id: "m_3f2e1d0c9b8a7f6e", offered: true, credential: { state: "ready", kid: "g1" }, tools: [{ name: "search_issues", offered: true, why: "" }] }] } },
        { url: "https://ai-2.acme.example:8443", ack: 0, applied: false, waiting: 1, state: null, error: "did not answer" }],
      journal: [{ id: "g_acme_000001", tseq: 1, ts: 1763300000, action: "mcp_tool_off", target: { server: "m_3f2e1d0c9b8a7f6e", tool: "get_issue" }, state: "active" }],
      warnings: [{ server: "m_3f2e1d0c9b8a7f6e", name: "Jira (read)", days: 4, ended: false, severity: "bad" }],
      changed: [{ kind: "AiMcpToolChanged", gateway: "https://ai-1.acme.example:8443", server: "m_3f2e1d0c9b8a7f6e", name: "Jira (read)", tool: "search_issues", schema_sha256: "b".repeat(64) }] },
  };
  boot(base, { hash: "#/meet/ai" });
  for (let i = 0; i < 4; i++) await settle();
  const text = view();
  for (const w of ["Who may use AI", "This computer only", "Waiting for ", "Run benchmark", "Place a legal hold", "Add an archive",
    "No archive. AI history stays on each person's devices; a legal hold cannot retrieve it.", "AI spend has reached 80% of this month's budget.", "bob@acme.example",
    "Personal access (people's own accounts)", "anthropic: key 1, OAuth 2", "anthropic: business 2, not business 0, unknown 1", "160 / 26",
    "AI history records that could not be saved", "encoding 1", "d".repeat(32)]) {
    if (!text.includes(w)) fail("Settings > AI does not show " + JSON.stringify(w) + ":\n" + text);
  }
  if (text.includes("\u2014") || text.includes("\u2013")) fail("a long dash on Settings > AI");
  // r6 8.11: Tools (MCP) shows each server with its attestation and risk, each gateway's state, the journal with the
  // gateway that has not applied it, the credential warning and the changed tool
  for (const w of ["Tools (MCP)", "Jira (read)", "Every member of eng may read everything the issues:read credential of Jira (read) can read.",
    "The gateway calls Jira (read) with its own credential", "Offered", "Credential: Ready g1", "Did not answer: did not answer", "mcp_tool_off",
    "Not yet applied: 1 changes wait.", "Not yet applied: https://ai-2.acme.example:8443", "The credential of Jira (read) ends in 4 days.",
    "The tool search_issues of Jira (read) changed on https://ai-1.acme.example:8443.", "Approve the new hash", "Turn off all tools", "Add an MCP server"]) {
    if (!text.includes(w)) fail("Tools (MCP) does not show " + JSON.stringify(w) + ":\n" + text);
  }
  // Approve only after a pass: one Approve, on the passed card's row
  // the row menus of the table (the stacked phone cards repeat them)
  const approves = doc.querySelectorAll("td.actions button").filter((b) => b.textContent === "Approve");
  if (approves.length !== 1) fail("Approve is offered " + approves.length + " times; only the card that passed may offer it");
  const benches = doc.querySelectorAll("td.actions button").filter((b) => b.textContent === "Run benchmark");
  if (benches.length !== 2) fail("Run benchmark is offered " + benches.length + " times, not on every card");
  // the presets in the Review dialog carry the contract's labels
  find("button", "Review changes").click();
  await settle();
  const options = doc.querySelectorAll("option").map((o) => o.textContent);
  for (const w of ["This computer only", "Org servers first", "This computer, then org servers, then frontier", "Advanced"]) {
    if (!options.includes(w)) fail("the route order choices lack " + w + ": " + options.join(" | "));
  }
  // a big organization: offline copy, shares and the Recoverable state
  const big = Object.assign({}, base, { "GET meet/ai/archive": { ok: true, size: "big", lacks: "A big organization's AI needs the organization archive with at least 3 archive reviewers.", archive: "https://archive.acme.example:9443",
    offline_copy: { enabled: true, schedule: "daily" }, shares: [{ reviewer: "rev@acme.example", device: "0123456789abcdef" }], reviewers: [], state: "Recoverable", note: "" } });
  boot(big, { hash: "#/meet/ai" });
  for (let i = 0; i < 4; i++) await settle();
  const t2 = view();
  for (const w of ["Recoverable", "Offline copy", "Reviewers' shares", "A big organization's AI needs the organization archive with at least 3 archive reviewers."]) {
    if (!t2.includes(w)) fail("the big organization's archive section lacks " + w + ":\n" + t2);
  }
  // a small organization with an archive: the recovery code shown once and its confirmation
  const small = Object.assign({}, base, { "GET meet/ai/archive": { ok: true, size: "small", archive: "https://archive.acme.example:9443", recovery_code: "unconfirmed", state: "Not tested",
    code: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST", confirm: { first: 2, second: 8 } } });
  boot(small, { hash: "#/meet/ai" });
  for (let i = 0; i < 4; i++) await settle();
  const t3 = view();
  for (const w of ["Not tested", "ABCD-EFGH-IJKL", "Confirm the recovery code", "Replace the recovery code"]) {
    if (!t3.includes(w)) fail("the small organization's archive section lacks " + w + ":\n" + t3);
  }
  console.log("ai: Settings > AI ok");
}

// ---- API-1 7.3 (API-1a6): Settings > API access and the API destinations of Exports on a fleet console ----
async function apiMain(v) {
  const W = v.page;
  const D = v.dialogs;
  const r1 = "r_0000000000000001", r2 = "r_0000000000000002";
  const t0 = 1763300000000;
  // The spec's answer shapes (api1a6 spec section 2).
  const staged = { id: "st_0123456789abcdef", org: "acme", by: "ann@acme.example", at: t0, expires_at: t0 + 7200000, base_seq: 7,
    changes: ["Add client splunk-scrape", "Raise app grace to 24 hours"], two_person: true, two_person_reasons: ["Raises a grace value"], tests_needed: ["d_9a8b7c6d5e4f3a2b"] };
  const client = { id: "c_5f1a2b3c4d5e6f70", name: "splunk-scrape", principal: "splunk-scrape@apps.acme.example", kind: "monitoring", owner: "bob@acme.example",
    scopes: ["monitor.read", "audit.read"], ceiling: "internal", relays: ["*"], networks: ["10.40.0.0/23"], mtls_required: false,
    rate: { per_minute_each: 120, per_day_each: 100000 }, created: 1763000000, expires: 1790000000, state: "active", shown_state: "owner-gone",
    credentials: [{ type: "private_key_jwt", hint: "k1", expires: 1790000000 }, { type: "client_secret", hint: "lcs_ab12", expires: 1770000000 }] };
  const map = { seq: 7, issued: 1763000000, expires: 1770000000, issuer_url: "https:" + "//console.acme.example:7443/api/orgs/acme", failover_after_s: 300,
    grace: { person: 0, app: 0, connector: 0, relay: 0 }, relay_origins: { [r1]: "https:" + "//relay1.acme.example:9443" },
    clients: [client], scrape_tokens: [{ hint: "lme_ab12", label: "prometheus-dc1", relays: ["*"], expires: 1770000000 }] };
  const apiView = { ok: true, orgs: [
    { org: "acme", edition: "enterprise", state: "on", map, draft: Object.assign({}, map, { grace: { person: 0, app: 24, connector: 0, relay: 0 } }),
      journal: { head: 13, entries: [{ id: "t_acme_000013", tseq: 13, action: "client_limit", target: { client: "c_5f1a2b3c4d5e6f70", networks: ["10.40.0.0/24"], rate: { per_minute_each: 60 } }, ts: 1763250000 },
        { id: "t_acme_000012", tseq: 12, action: "client_suspend", target: "c_0000000000000009", ts: 1763200000 },
        { id: "t_acme_000011", tseq: 11, action: "token_deny", target: { client: "c_5f1a2b3c4d5e6f70", jti: "j1" }, ts: 1763100000, until: 1763400000 }] },
      relays: [{ id: r1, acked: 12, synced: false }, { id: r2, acked: 12, synced: true }], staged,
      signing: { request: "rq_0000000000000001", by: "ann@acme.example", at: t0, state: "waiting", relay: r1 },
      limits: { clients: 500, destinations: 32, scrape_tokens: 10 } },
    { org: "globex", edition: "enterprise", state: "none", map: null, journal: { head: 0, entries: [] }, relays: [], staged: null, draft: null, signing: null,
      limits: { clients: 500, destinations: 32, scrape_tokens: 10 } }] };
  const dest = { id: "d_9a8b7c6d5e4f3a2b", name: "Splunk HEC", kind: "splunk_hec", preset: "splunk_hec", signals: ["audit", "logs"], ceiling: "internal", identities: "pseudonymized",
    failover: true, private_ok: false, endpoint: "https:" + "//hec.acme.example:8088/services/collector/event", settings: { index: "lucid", sourcetypes: ["lucid:audit"], ack: true },
    queue: { max_bytes: 1073741824, max_age_s: 259200 }, source: "staged", credential: { type: "token", held: true, rotate_by: 1770000000 },
    status: { state: "retrying", backlog_bytes: 2048, oldest_s: 3700, last_success: 1763200000, last_error: "connection refused" }, tested: false,
    failover_records: [{ relay: r1, type: "token", public_id: "sha256:0a1b2c3d", not_before: 1763000000, expires: 1770000000, state: "armed", note: "" }] };
  const exportsView = { ok: true, tokens: [], siem: { host: "siem.acme.example", port: 6514, events: ["audit"], includeReasons: false, state: "ok", caSet: true, clientCertSet: false },
    api: [{ org: "acme", staged, destinations: [dest], relays: [r1, r2] }],
    presets: [{ id: "splunk_hec", kind: "splunk_hec", credential_types: ["token"], signals: ["logs", "audit"] },
      { id: "sentinel", kind: "azure_logs", credential_types: ["entra_certificate"], signals: ["logs", "audit"] }] };
  const secret = "lcs_SECRETSECRETSECRETSECRETSECRET0123456789";
  const answers = {
    "GET me": {
      ok: true, product: "fleet", profile: "standard", origin: "https://console.acme.example", relay: { host: "console.acme.example" }, sections: [],
      idle: { minutes: 15, maxHours: 12 },
      user: { email: "ann@acme.example", role: "admin", rights: "admin", rightsWhy: null, state: "active", breakGlass: false,
        methods: { webauthn: [], password: false, totp: true }, mustSetPassword: false, sessions: 1, mail: [] },
    },
    "GET settings": { ok: true, twoPerson: "off", profile: "standard", links: [] },
    "GET banner": { ok: true, banner: null },
    "GET overview": { ok: true, product: "fleet", cards: [], approvals: { waiting: 0, mine: 0 }, attention: [],
      fleet: { relays: { total: 2, ok: 2, warn: 0, bad: 0, silent: 0, unconfirmed: 0 }, people: { online: 0 }, calls: { active: 0 }, kpis: {} } },
    "GET setup": { ok: true, bootstrapped: true, profileFixed: null, pinned: false, steps: { signin: "done", email: "done", license: "done", relay: "done" } },
    "GET fleet/relays": { ok: true, total: 2, relays: [
      { id: r1, name: "Dallas east", site: "us-east", product: "meet", state: "active", connected: true, lastContactAt: t0, version: "2.6.0", health: "ok", scopes: ["read-health"], readOnly: false, confirm: [] },
      { id: r2, name: "Hub west", site: "us-west", product: "meet", state: "active", connected: true, lastContactAt: t0, version: "2.6.0", health: "ok", scopes: ["read-health"], readOnly: false, confirm: [] }] },
    "GET settings/api": apiView,
    "GET settings/exports": exportsView,
    "POST stepup/begin": { ok: true, ceremony: "c1", totp: true, publicKey: {} },
    "POST settings/api/explain": { ok: true, first_fail: 6, checks: [{ n: 0, name: "source limiter", ok: true, words: "" }, { n: 5, name: "client limiter", ok: true, words: "" },
      { n: 6, name: "scope", ok: false, code: "scope", words: "This client may not use this route." }] },
    "POST settings/api/clients/secret": { ok: true, secret, hint: "lcs_cd34", staged },
    "POST settings/exports/destinations/credential": { ok: true, held: true, rotate_by: 1770000000 },
  };
  const field = (label) => {
    const l = doc.querySelectorAll("label").find((x) => x.textContent === label);
    return l ? doc.getElementById(l.getAttribute("for")) : null;
  };
  const confirmCode = async () => {
    for (let i = 0; i < 4; i++) await settle();
    if (!doc.getElementById("code-dlg").open) fail("no step-up code asked");
    doc.getElementById("code-input").value = "123456";
    doc.getElementById("code-go").click();
    for (let i = 0; i < 6; i++) await settle();
  };
  boot(answers, { hash: "#/security/api" });
  for (let i = 0; i < 4; i++) await settle();
  const page = view();
  inOrder(page, [W["api.title"], "globex", W["api.state-on"], W["api.org"], "Map 7, signed ", "Up to 500 clients, 32 destinations and 10 scrape tokens.", W["api.staged"],
    "Waiting for your Hub device on Dallas east to sign the map.", "Add client splunk-scrape", W["api.two-person"], "Raises a grace value", W["api.tests-needed"],
    W["api.clients"], "splunk-scrape", W["api.shown-owner-gone"], "private_key_jwt k1", W["api.scrape"], "prometheus-dc1", W["api.grace"], W["api.grace-help"],
    W["api.origins"], "Dallas east", W["api.kill"], W["api.off"], W["api.journal"], "t_acme_000012", W["api.explain"]], "API access");
  if (field(W["api.grace-app"]).value !== "24") fail("the grace shows the pinned map, not the staged draft");
  if (!find("button", W["api.client-add"]) || !find("button", W["api.scrape-new"])) fail("an admin has no Add a client or Create a relay scrape token");
  const undo = doc.querySelectorAll("button").filter((b) => b.textContent === W["api.undo"]);
  if (undo.length !== 4) fail("Undo is offered " + undo.length + " times; only the client_limit and client_suspend entries (table and card) may offer it");
  inOrder(page, [W["api.journal"], W["api.action-client-limit"], "client c_5f1a2b3c4d5e6f70, networks 10.40.0.0/24, rate {\"per_minute_each\":60}"], "client_limit entry");
  if (page.includes("\u2014") || page.includes("\u2013")) fail("a long dash on API access");

  // Explain: each check with ok or the refusing code and words.
  field(W["api.f-path"]).value = "/v1/audit";
  find("button", W["api.explain-run"]).click();
  for (let i = 0; i < 4; i++) await settle();
  const ex = calls.find((c) => c.route === "POST settings/api/explain");
  if (!ex || ex.body.client !== client.id || ex.body.method !== "GET" || ex.body.path !== "/v1/audit" || "ip" in ex.body) fail("the explain body: " + JSON.stringify(ex && ex.body));
  inOrder(view(), ["0. source limiter: " + W["api.check-passes"], "6. scope: Refused (scope): This client may not use this route.", "Check 6 refuses this request."], "explain");

  // One signing in flight: Save is not offered, Cancel signing posts {org}; after it the signing shows failed.
  const saveButton = () => doc.getElementById("view").querySelectorAll("button").find((b) => b.textContent === "Save");
  if (saveButton()) fail("Save is offered while a signing is waiting");
  find("button", W["api.signing-cancel"]).click();
  await settle();
  if (doc.getElementById("confirm-title").textContent !== D["api-signing-cancel"].title.replace("<org>", "acme")) fail("the cancel dialog title");
  apiView.orgs[0].signing = { request: "rq_0000000000000001", by: "ann@acme.example", at: t0, state: "failed", error: "Canceled", relay: r1 };
  doc.getElementById("confirm-go").click();
  for (let i = 0; i < 6; i++) await settle();
  const cancel = calls.find((c) => c.route === "POST settings/api/signing/cancel");
  if (!cancel || JSON.stringify(cancel.body) !== JSON.stringify({ org: "acme" })) fail("the cancel body: " + JSON.stringify(cancel && cancel.body));
  if (!view().includes("The map was not signed: Canceled")) fail("the canceled signing is not shown as failed");
  if (doc.getElementById("view").querySelectorAll("button").some((b) => b.textContent === W["api.signing-cancel"])) fail("Cancel signing stays after the signing failed");

  // Save: two-person, the relay choice defaults to the first synced relay, no step-up.
  saveButton().click();
  await settle();
  if (doc.getElementById("confirm-title").textContent !== D["api-save"].title.replace("<org>", "acme")) fail("the save dialog title: " + doc.getElementById("confirm-title").textContent);
  const relayPick = doc.getElementById("confirm-fields").querySelector("select");
  if (!relayPick || relayPick.value !== r2) fail("the save does not default to the first synced relay");
  doc.getElementById("confirm-fields").querySelector("textarea").value = "Weekly review";
  doc.getElementById("confirm-go").click();
  for (let i = 0; i < 6; i++) await settle();
  const save = calls.find((c) => c.route === "POST settings/api/save");
  if (!save || JSON.stringify(save.body) !== JSON.stringify({ org: "acme", stage: staged.id, reason: "Weekly review", relay: r2 })) fail("the save body: " + JSON.stringify(save && save.body));

  // New secret: shown once, in its own dialog, and gone from the page when the dialog closes.
  find("button", W["api.new-secret"]).click();
  await settle();
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const made = calls.find((c) => c.route === "POST settings/api/clients/secret");
  if (!made || made.body.org !== "acme" || made.body.id !== client.id || made.body.days !== 90 || !made.body.stepup) fail("the secret body: " + JSON.stringify(made && made.body));
  const reveal = doc.querySelectorAll("dialog.reveal");
  if (reveal.length !== 1 || !reveal[0].open) fail("the secret is not shown in its own dialog");
  inOrder(reveal[0].textContent, ["New secret for splunk-scrape", "lcs_cd34", W["api.secret-once"], secret, "Copy", W["api.close"]], "secret dialog");
  if (snapshot().split(secret).length !== 2) fail("the secret is shown more than once");
  if (doc.getElementById("view").textContent.includes(secret)) fail("the secret is on the page itself");
  if (doc.getElementById("confirm-fields").childNodes.length) fail("the closed confirmation keeps its fields");
  reveal[0].querySelectorAll("button").find((b) => b.textContent === W["api.close"]).click();
  await settle();
  if (doc.querySelectorAll("dialog.reveal").length) fail("the secret dialog stays after Close");
  if (snapshot().includes(secret)) fail("the secret stays in the page after its dialog closed");
  await go("#/security/exports");
  await go("#/security/api");
  if (snapshot().includes(secret)) fail("the secret came back with the page");

  // Exports: API destinations with status, the staged panel and failover per relay.
  await go("#/security/exports");
  const ev = view();
  inOrder(ev, [W["exports.title"], W["exports.siem"], W["exports.destinations"], "Destinations of acme", W["exports.dest-preset"], W["exports.dest-add"], W["exports.dest-from-siem"],
    "Splunk HEC", "splunk_hec (splunk_hec)", "audit, logs", W["exports.source-staged"], W["exports.state-retrying"], "2 KiB", "connection refused",
    W["exports.cred-token"] + ": " + W["exports.cred-held"], W["exports.untested"], W["exports.failover"], W["exports.failover-help"], "Dallas east", "sha256:0a1b2c3d",
    W["exports.fo-armed"], "Hub west", W["api.staged"], W["api.tests-needed"], "Splunk HEC"], "exports");
  const presetPick = doc.getElementById("view").querySelectorAll("select").find((s) => s.querySelectorAll("option").some((o) => o.textContent === "sentinel (azure_logs)"));
  if (!presetPick) fail("the kind and preset choice lacks the presets of the answer");
  // Set credential: the material is posted once and leaves the page with its dialog.
  find("button", W["exports.dest-credential"]).click();
  await settle();
  if (doc.getElementById("confirm-title").textContent !== "Set the credential of Splunk HEC?") fail("the credential dialog title");
  doc.getElementById("confirm-fields").querySelector("textarea").value = "hec-token-0123456789";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const cred = calls.find((c) => c.route === "POST settings/exports/destinations/credential");
  if (!cred || cred.body.org !== "acme" || cred.body.id !== dest.id || JSON.stringify(cred.body.credential) !== JSON.stringify({ type: "token", token: "hec-token-0123456789" })) {
    fail("the credential body: " + JSON.stringify(cred && cred.body));
  }
  if (snapshot().includes("hec-token-0123456789")) fail("the credential material stays in the page");
  if (!doc.getElementById("status").textContent.includes(W["exports.cred-sealed"])) fail("no word that the credential is sealed");
  console.log("api: API access, Explain, save, secret once and API destinations ok");
}

// ---- API-1 revision 4 13.2 (API-1b8): compliance, directory, webhooks, outbound identity, relay set, attention ----
async function apiR4Main(v) {
  const W = v.page;
  const D = v.dialogs;
  const r1 = "r_0000000000000001", r2 = "r_0000000000000002", r3 = "r_0000000000000003";
  const t0 = 1763300000000;
  const filled = (tpl, vals) => tpl.replace(/<([a-z][a-z ]*)>/g, (_, k) => String(vals[k]));
  const I = "https:" + "//console.acme.example:7443/api/orgs/acme";
  const scim = "https:" + "//sso.acme.example:8443/api/orgs/acme/scim/v2";
  const jkt = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";
  const exportClient = { id: "c_1b2c3d4e5f607182", name: "ediscovery-export", principal: "ediscovery-export@apps.acme.example", kind: "compliance", reach: "R1",
    owner: "lee@acme.example", scopes: ["compliance.export.request"], ceiling: "confidential", relays: ["*"], networks: ["10.40.0.0/23"], mtls_required: true,
    rate: { per_minute_each: 60, per_day_each: 20000 }, created: 1763000000, expires: 1790000000, state: "active", shown_state: "owner-gone",
    credentials: [{ type: "mtls", hint: "serial 0a1b2c3d" }],
    compliance: { job_max_bytes: 5368709120, day_max_bytes: 21474836480, jobs_per_day: 5, recipient: { kid: "rcpt-2026-11", jkt } } };
  const scimClient = { id: "c_2c3d4e5f60718293", name: "entra-scim", principal: "entra-scim@apps.acme.example", kind: "integration", reach: "R0", owner: "ann@acme.example",
    scopes: ["directory.read", "directory.write"], ceiling: "confidential", relays: [r1], networks: ["20.190.128.0/18"], mtls_required: false,
    rate: { per_minute_each: 600, per_day_each: 500000 }, created: 1763000000, expires: 1790000000, state: "active", shown_state: "active",
    credentials: [{ type: "entra_wif", hint: "ce5f061f-abe6-4e40-9615-301f87bcb7f0", cloud: "public", tenant: "ce5f061f-abe6-4e40-9615-301f87bcb7f0", audience: I,
      azp: "cb1d50fe-8ed0-4944-9e7d-5981aad3bc4b", expires: 1790000000 }],
    directory: { provider: "entra", resource: scim, domains: ["acme.example"] } };
  const map = { seq: 12, issued: 1763000000, expires: 1770000000, issuer_url: I, failover_after_s: 300, grace: { person: 0, app: 0, connector: 0, relay: 0 },
    relay_origins: {}, clients: [exportClient, scimClient], scrape_tokens: [], webhook_keys: [], federation: null };
  const apiView = { ok: true, meet_ca: { fingerprint: "ab".repeat(32) }, orgs: [
    { org: "acme", edition: "enterprise", state: "on", map, draft: null, journal: { head: 0, entries: [] }, staged: null, signing: null,
      relays: [{ id: r1, acked: 0, synced: true }, { id: r2, acked: 0, synced: true }], limits: { clients: 500, destinations: 32, scrape_tokens: 10 },
      relay_set: [{ id: r1, connected: true, map: [1, 2], features: ["scim-check", "events", "compliance", "archive"], reported_at: 1763290000, lacks: [] },
        { id: r3, connected: false, map: [1], features: [], reported_at: 1763000000, lacks: ["map-v2"] }] }] };
  const hook = { id: "d_3d4e5f6071829304", name: "ServiceNow events", kind: "webhook", preset: "webhook", signals: ["events"], ceiling: "internal", identities: "pseudonymized",
    failover: false, private_ok: false, endpoint: "https:" + "//acme.service-now.com/api/x_acme/lucid/events",
    settings: { client: exportClient.id, types: ["hold.placed"], signing: "v2a", verification: "wev" }, queue: { max_bytes: 1073741824, max_age_s: 259200 }, source: "pinned",
    credential: { type: "none", held: false }, tested: true, failover_records: [],
    status: { state: "paused", backlog_bytes: 0, oldest_s: 0, last_success: 1763200000, last_error: "503 from the receiver",
      events: { paused: true, retrying: false, cursor: "c_17", verification: "verified", signing: "v2a" } } };
  const gcp = { id: "d_5f60718293041526", name: "Google logs", kind: "otlp", preset: "google_cloud", signals: ["logs"], ceiling: "internal", identities: "pseudonymized",
    failover: false, private_ok: false, endpoint: "https:" + "//telemetry.googleapis.com", settings: {}, queue: { max_bytes: 1073741824, max_age_s: 259200 }, source: "pinned",
    credential: { type: "gcp_service_account_key", held: true }, tested: true, failover_records: [], status: { state: "ok", backlog_bytes: 0, oldest_s: 0, last_success: 1763200000 } };
  const exportsView = { ok: true, tokens: [], siem: null,
    api: [{ org: "acme", staged: null, destinations: [hook, gcp], relays: [r1, r2], issuer_url: I, events_clients: [{ id: exportClient.id, name: exportClient.name }],
      webhook_keys: [{ kid: "wk-2026-11", public: "whpk_" + "A".repeat(43) + "=", nbf: 1763000000, exp: 1790000000, dropped: false },
        { kid: "wk-2025-11", public: "whpk_" + "B".repeat(43) + "=", nbf: 1731000000, exp: 1765000000, dropped: true }],
      federation: { issuer: I + "/federation", keys: [{ kid: "fk-2026-11", nbf: 1763000000, exp: 1790000000, dropped: false }] }, federation_republish: ["fk-2025-11"] }],
    presets: [{ id: "webhook", kind: "webhook", credential_types: ["none", "token", "mtls"], signals: ["events"] },
      { id: "google_cloud", kind: "otlp", credential_types: ["gcp_service_account_key", "gcp_federated"], signals: ["metrics", "logs", "traces", "audit", "events"] }] };
  const secret = "whsec_SECRETSECRETSECRETSECRETSECRETSECRET0123=";
  const job = { job: "j_0123456789abcdef", client: exportClient.id, client_name: "ediscovery-export", owner: "lee@acme.example", matter: "Acme v. Widget", state: "waiting",
    requested_at: 1763290000, reviewers: ["rev1@acme.example", "rev2@acme.example"], releases: 1, released_by: ["rev1@acme.example"], expires_waiting: 1763549200 };
  const ready = { job: "j_fedcba9876543210", client: exportClient.id, client_name: "ediscovery-export", owner: "lee@acme.example", matter: "Acme v. Gadget", state: "ready",
    requested_at: 1763100000, reviewers: ["rev1@acme.example", "rev2@acme.example"], releases: 2, released_by: ["rev1@acme.example", "rev2@acme.example"], released_at: 1763150000,
    parts: 2, have: 2, zip_bytes: 6291456, ready_at: 1763160000, expires: 1763764800, expires_waiting: 1763359200 };
  const answers = {
    "GET me": {
      ok: true, product: "fleet", profile: "standard", origin: "https://console.acme.example", relay: { host: "console.acme.example" }, sections: [],
      idle: { minutes: 15, maxHours: 12 },
      user: { email: "ann@acme.example", role: "admin", rights: "admin", rightsWhy: null, state: "active", breakGlass: false,
        methods: { webauthn: [], password: false, totp: true }, mustSetPassword: false, sessions: 1, mail: [] },
    },
    "GET settings": { ok: true, twoPerson: "off", profile: "standard", links: [] },
    "GET banner": { ok: true, banner: null },
    "GET overview": { ok: true, product: "fleet", cards: [], approvals: { waiting: 0, mine: 0 },
      fleet: { relays: { total: 3, ok: 2, warn: 0, bad: 0, silent: 1, unconfirmed: 0 }, people: { online: 0 }, calls: { active: 0 }, kpis: {} },
      attention: [{ kind: "relay-outdated", severity: "bad", args: { relay: r3, org: "acme", needs: "map-v2" }, go: "#/security/api" },
        { kind: "api-owner-gone", severity: "bad", args: { principal: "lee@acme.example", org: "acme", n: 1 }, go: "#/security/api" },
        { kind: "federation-jwks-republish", severity: "warn", args: { org: "acme", kid: "fk-2025-11" }, go: "#/security/exports" },
        { kind: "webhook-paused", severity: "bad", args: { destination: "ServiceNow events", org: "acme" }, go: "#/security/exports" },
        { kind: "webhook-key-dropped", severity: "warn", args: { org: "acme", kid: "wk-2025-11" }, go: "#/security/exports" },
        { kind: "export-storage", severity: "bad", args: { org: "acme" }, go: "#/security/compliance" }] },
    "GET setup": { ok: true, bootstrapped: true, profileFixed: null, pinned: false, steps: { signin: "done", email: "done", license: "done", relay: "done" } },
    "GET fleet/relays": { ok: true, total: 3, relays: [
      { id: r1, name: "Dallas east", site: "us-east", product: "meet", state: "active", connected: true, lastContactAt: t0, version: "2.6.0", health: "ok", scopes: ["read-health"], readOnly: false, confirm: [] },
      { id: r2, name: "Hub west", site: "us-west", product: "meet", state: "active", connected: true, lastContactAt: t0, version: "2.6.0", health: "ok", scopes: ["read-health"], readOnly: false, confirm: [] },
      { id: r3, name: "Old relay", site: "us-east", product: "meet", state: "active", connected: false, lastContactAt: t0 - 86400000, version: "2.4.0", health: "silent", scopes: ["read-health"], readOnly: false, confirm: [] }] },
    "GET settings/api": apiView,
    "GET settings/exports": exportsView,
    "GET settings/api/federation/documents": { ok: true, org: "acme", staged: null,
      pinned: { issuer: I + "/federation", front_door: false, discovery_url: "https:" + "//id.acme.example/lucid/acme/.well-known/openid-configuration",
        jwks_url: "https:" + "//id.acme.example/lucid/acme/jwks.json", discovery: { issuer: I + "/federation" }, jwks: { keys: [] } } },
    "GET compliance/holds": { ok: true, org: "acme", partial: [r3], holds: [
      { hold: "h_0123456789abcdef", on: "people", count: 2, principals: ["bob@acme.example", "carl@acme.example"], reason: "r", matter: "Acme v. Widget", placed_at: 1763200000,
        by: { client: exportClient.id, owner: "lee@acme.example" }, relays: { [r1]: "placed" }, archive: "waiting", source: "api" },
      { hold: "0123456789abcdef", on: "people", principals: ["dan@acme.example"], placed_at: 1763100000, by: { admin: "ann@acme.example" }, relays: { [r2]: "released" },
        released_at: 1763250000, source: "console" }] },
    "GET compliance/exports": { ok: true, org: "acme", jobs: [job, ready], storage: { free_bytes: 1073741824, low: true }, archive_relays: [r1] },
    "POST compliance/exports/cancel": { ok: true, job: Object.assign({}, job, { state: "canceled", code: "admin" }) },
    "GET directory/status": { ok: true, org: "acme", mode: "governed", governed: true, not_reported: [],
      clients: [{ id: scimClient.id, name: "entra-scim", owner: "ann@acme.example", state: "active", scopes: scimClient.scopes, provider: "entra", resource: scim, domains: ["acme.example"],
        requests: { last_request: 1763290000, ok: 12, refused: 2, ops: {}, refusals: { network: 2 } } }],
      unattributed: { last_request: null, ok: 0, refused: 0, ops: {}, refusals: {} },
      legacy: { tokens: [{ token_id: "t_legacy01", hint: "3f2a9c1d", provider: "okta", issued: 0, expires: 1767776000, pre_r4d3: true, no_address_list: true, ending: true,
        last_request: 1763000000, ok: 3, refused: 0, ops: {}, refusals: {} }] },
      pending: [{ group: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", group_name: "Engineering", principal: "bob@acme.example", since: 1763280000, provider: "entra" }], pending_count: 1,
      sso: [{ provider: "entra", relay: "r1", at: 1763290000, pending_count: 1 }, { provider: "okta", relay: "r1", at: 1763290000, pending_count: 0 }], sso_unanswered: [],
      people: [{ principal: "lee@acme.example", state: "deprovisioned", at: 1763250000, provider: "entra", source: "scim" }] },
    "GET fleet/people": { ok: true, total: 0, rows: [] },
    "GET admins": { ok: true, people: [], waiting: [], invites: [] },
    "POST stepup/begin": { ok: true, ceremony: "c1", totp: true, publicKey: {} },
    "POST settings/exports/destinations/secret": { ok: true, secret, rotate_by: 1771000000 },
  };
  const confirmCode = async () => {
    for (let i = 0; i < 4; i++) await settle();
    if (!doc.getElementById("code-dlg").open) fail("no step-up code asked");
    doc.getElementById("code-input").value = "123456";
    doc.getElementById("code-go").click();
    for (let i = 0; i < 6; i++) await settle();
  };
  const actionButtons = (label) => doc.querySelectorAll("td.actions button").filter((b) => b.textContent === label);
  boot(answers, { hash: "#/overview" });
  for (let i = 0; i < 4; i++) await settle();

  // The attention items other lanes added, in the console's words with its own relay names.
  const ov = view();
  for (const [k, args] of [["relay-outdated", { relay: "Old relay", org: "acme", needs: "map-v2" }], ["api-owner-gone", { principal: "lee@acme.example", org: "acme", n: 1 }],
    ["federation-jwks-republish", { org: "acme", kid: "fk-2025-11" }], ["webhook-paused", { destination: "ServiceNow events", org: "acme" }],
    ["webhook-key-dropped", { org: "acme", kid: "wk-2025-11" }], ["export-storage", { org: "acme" }]]) {
    const want = filled(W["attention." + k], args);
    if (!ov.includes(want)) fail("the overview lacks the " + k + " item " + JSON.stringify(want) + ":\n" + ov);
  }
  if (!doc.querySelector('ul.attention a[href="#/security/compliance"]')) fail("the export-storage item does not link to the Compliance page");

  // Settings > API access: Compliance and Directory sections, the relay set with what a relay lacks, and Retire.
  await go("#/security/api");
  const page = view();
  inOrder(page, [W["api.title"], W["api.outdated"], W["api.clients"], "ediscovery-export", W["api.blocks"], W["api.meet-ca"], "ab".repeat(32), "ediscovery-export",
    W["api.compliance"], W["api.cap-jobs"], "5", W["api.cap-job-bytes"], W["api.recipient"], "rcpt-2026-11", W["api.thumbprint"], jkt, W["api.compliance-rule"],
    W["api.recipient-set"], W["api.recipient-drop"], W["api.caps-set"], "entra-scim", W["api.directory"], W["api.dir-provider"], "entra", W["api.dir-scim"], scim,
    W["api.dir-tenant"], "ce5f061f-abe6-4e40-9615-301f87bcb7f0", W["api.dir-audience"], W["api.dir-azp"], "cb1d50fe-8ed0-4944-9e7d-5981aad3bc4b", W["api.dir-paste"],
    W["api.dir-client-id"], scimClient.id, W["api.dir-token-url"], I + "/oauth/token", W["api.dir-scim"], scim, W["api.relay-set"], "Dallas east", W["api.lacks-none"],
    "Old relay", "map-v2"], "API access revision 4");
  if (page.includes("\u2014") || page.includes("\u2013")) fail("a long dash on API access");
  const retire = actionButtons(W["api.retire"]);
  if (retire.length !== 1) fail("Retire is offered " + retire.length + " times; only the disconnected relay that lacks map-v2 may offer it");
  retire[0].click();
  await settle();
  if (doc.getElementById("confirm-title").textContent !== filled(D["api-retire"].title, { relay: "Old relay", org: "acme" })) fail("the retire dialog title");
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const retired = calls.find((c) => c.route === "POST settings/api/relays/retire");
  if (!retired || retired.body.org !== "acme" || retired.body.relay !== r3 || !retired.body.stepup) fail("the retire body: " + JSON.stringify(retired && retired.body));

  // Settings > Exports: the webhook with its verification and paused state, Resume, Replay from, the keys, the outbound
  // identity with a dropped key to confirm, and the prefer-federation advice on a service account key.
  await go("#/security/exports");
  const ev = view();
  inOrder(ev, [W["exports.destinations"], W["exports.col-events"], "ServiceNow events", "webhook (webhook)", W["exports.ev-paused"], "503 from the receiver",
    W["exports.cred-none"], W["exports.ev-verified"], filled(W["exports.ev-at"], { cursor: "c_17" }), "Google logs", W["exports.cred-gcp"] + ": " + W["exports.cred-held"] + ". " + W["exports.prefer-federation"], W["webhooks.keys"],
    filled(W["webhooks.keys-help"], { url: I + "/v1/webhooks/keys" }), W["webhooks.key-new"], "wk-2026-11", W["webhooks.in-force"], "wk-2025-11", W["webhooks.dropped"],
    W["federation.title"], W["federation.help"], W["federation.set"], W["federation.key-new"], W["federation.download"], W["federation.issuer"], I + "/federation", "fk-2026-11",
    filled(W["attention.federation-jwks-republish"], { org: "acme", kid: "fk-2025-11" }), W["federation.republished"]], "exports revision 4");
  for (const w of [W["exports.verify"], W["exports.replay"], W["exports.resume"], W["exports.secret"], W["exports.send-test"]]) {
    if (actionButtons(w).length !== 1) fail("the webhook does not offer " + w + " once");
  }
  if (actionButtons(W["webhooks.drop"]).filter((b) => b.closest("table")).length !== 2) fail("Drop is offered on the in-force webhook key and federation key only");
  if (actionButtons(W["exports.dest-credential"]).length !== 1) fail("Set credential is offered on a webhook without a receiver credential");
  const presetPick = doc.getElementById("view").querySelectorAll("select").find((s) => s.querySelectorAll("option").some((o) => o.textContent === "webhook (webhook)"));
  if (!presetPick) fail("the kind and preset choice lacks the webhook preset");
  // Download documents: where to publish them.
  find("button", W["federation.download"]).click();
  for (let i = 0; i < 4; i++) await settle();
  if (!view().includes(filled(W["federation.publish"], { discovery: "https:" + "//id.acme.example/lucid/acme/.well-known/openid-configuration", jwks: "https:" + "//id.acme.example/lucid/acme/jwks.json" }))) {
    fail("the documents do not say where to publish them:\n" + view());
  }
  // Replay from the feed position shown, with a step-up.
  actionButtons(W["exports.replay"])[0].click();
  await settle();
  if (doc.getElementById("confirm-title").textContent !== filled(D["dest-replay"].title, { name: "ServiceNow events" })) fail("the replay dialog title");
  if (doc.getElementById("confirm-fields").querySelector("input").value !== "c_17") fail("Replay from does not start at the delivered position");
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const replay = calls.find((c) => c.route === "POST settings/exports/destinations/replay");
  if (!replay || replay.body.org !== "acme" || replay.body.id !== hook.id || replay.body.from !== "c_17" || !replay.body.stepup) fail("the replay body: " + JSON.stringify(replay && replay.body));
  // Resume: no step-up.
  actionButtons(W["exports.resume"])[0].click();
  await settle();
  doc.getElementById("confirm-go").click();
  for (let i = 0; i < 6; i++) await settle();
  const resumed = calls.find((c) => c.route === "POST settings/exports/destinations/resume");
  if (!resumed || JSON.stringify(resumed.body) !== JSON.stringify({ org: "acme", id: hook.id })) fail("the resume body: " + JSON.stringify(resumed && resumed.body));

  // A v1 secret: shown once in its own dialog, never on the page, and nowhere once the dialog closes.
  actionButtons(W["exports.secret"])[0].click();
  await settle();
  if (doc.getElementById("confirm-title").textContent !== filled(D["dest-secret"].title, { name: "ServiceNow events" })) fail("the secret dialog title");
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const made = calls.find((c) => c.route === "POST settings/exports/destinations/secret");
  if (!made || made.body.org !== "acme" || made.body.id !== hook.id || !made.body.stepup) fail("the v1 secret body: " + JSON.stringify(made && made.body));
  const reveal = doc.querySelectorAll("dialog.reveal");
  if (reveal.length !== 1 || !reveal[0].open) fail("the v1 secret is not shown in its own dialog");
  inOrder(reveal[0].textContent, [filled(W["exports.secret-title"], { name: "ServiceNow events" }), hook.id, W["exports.secret-once"], "Rotate it by ", secret, W["api.close"]], "v1 secret dialog");
  if (snapshot().split(secret).length !== 2) fail("the v1 secret is shown more than once");
  if (doc.getElementById("view").textContent.includes(secret)) fail("the v1 secret is on the page itself");
  if (doc.getElementById("confirm-fields").childNodes.length) fail("the closed confirmation keeps its fields");
  reveal[0].querySelectorAll("button").find((b) => b.textContent === W["api.close"]).click();
  await settle();
  if (doc.querySelectorAll("dialog.reveal").length) fail("the v1 secret dialog stays after Close");
  if (snapshot().includes(secret) || snapshot().includes("SECRETSECRET")) fail("the v1 secret stays in the page after its dialog closed");
  await go("#/security/api");
  await go("#/security/exports");
  if (snapshot().includes("SECRETSECRET")) fail("the v1 secret came back with the page");

  // Security and audit > Compliance: holds with relay and archive states, exports with the reviewer state, never
  // content, and Cancel export with a reason.
  await go("#/security/compliance");
  const cv = view();
  inOrder(cv, [W["compliance.title"], W["compliance.help"], W["compliance.storage-low"], W["compliance.holds"], filled(W["fleet.missing"], { names: "Old relay" }),
    "h_0123456789abcdef", exportClient.id, "2", "Acme v. Widget", "Dallas east: " + W["compliance.relay-placed"], W["compliance.archive-waiting"],
    "0123456789abcdef", "ann@acme.example", "Hub west: " + W["compliance.relay-released"], W["compliance.exports"], W["compliance.ask-reviewers"], W["api.compliance-rule"],
    "j_0123456789abcdef", "ediscovery-export", "Acme v. Widget", W["compliance.job-waiting"], "rev1@acme.example, rev2@acme.example",
    filled(W["compliance.released"], { n: 1 }), filled(W["compliance.released-by"], { reviewers: "rev1@acme.example" }), "j_fedcba9876543210", W["compliance.job-ready"],
    filled(W["compliance.released"], { n: 2 }), "6 MiB"], "compliance");
  if (cv.includes("\u2014") || cv.includes("\u2013")) fail("a long dash on Compliance");
  if (actionButtons(W["compliance.cancel"]).length !== 2) fail("Cancel export is offered on the waiting and the ready job only");
  actionButtons(W["compliance.cancel"])[0].click();
  await settle();
  if (doc.getElementById("confirm-title").textContent !== filled(D["compliance-cancel"].title, { job: "j_0123456789abcdef" })) fail("the cancel export dialog title");
  doc.getElementById("confirm-fields").querySelector("textarea").value = "Matter settled";
  doc.getElementById("confirm-go").click();
  for (let i = 0; i < 6; i++) await settle();
  const canceled = calls.find((c) => c.route === "POST compliance/exports/cancel");
  if (!canceled || JSON.stringify(canceled.body) !== JSON.stringify({ org: "acme", job: "j_0123456789abcdef", reason: "Matter settled" })) fail("the cancel body: " + JSON.stringify(canceled && canceled.body));
  const asked = calls.filter((c) => c.route === "GET compliance/exports").map((c) => c.url);
  if (!asked.length || !asked.every((u) => u.endsWith("?org=acme"))) fail("the Compliance page did not ask for the organization's jobs: " + asked.join(", "));

  // People > Directory: governed SCIM, its clients and refusals, a legacy token from before the upgrade with its end,
  // a group confirmation waiting, and the owner who left with an API client.
  await go("#/people");
  const dv = view();
  inOrder(dv, [W["directory.title"] + ": acme", W["directory.governed"], W["directory.clients"], W["directory.col-last"], "entra-scim", "entra", scim, "12",
    filled(W["directory.refusals"], { list: "network 2" }), W["directory.tokens"], W["directory.pre-r4d3-help"], "t_legacy01", "3f2a9c1d", W["directory.pre-r4d3"],
    W["directory.any-address"], W["directory.pending"], W["directory.pending-help"], "Engineering", "bob@acme.example", W["directory.owner-gone"], "lee@acme.example",
    "ediscovery-export"], "directory card");
  console.log("api-r4: attention, API access blocks and relay set, webhooks, keys, outbound identity, v1 secret once, Compliance and Directory ok");
}

// ---- API-1 revision 5 14.2 (API-1c7): connectors, identity providers (EMA), content and delegation, people, Local MCP ----
async function apiR5Main(v) {
  const W = v.page;
  const D = v.dialogs;
  const r1 = "r_0000000000000001";
  const t0 = 1763300000000;
  const filled = (tpl, vals) => tpl.replace(/<([a-z][a-z ]*)>/g, (_, k) => String(vals[k]));
  const https = (rest) => "https:" + "//" + rest;
  const I = https("console.acme.example:7443/api/orgs/acme");
  const kHelp = "k_7a1b2c3d4e5f6a7b", kOld = "k_0f1e2d3c4b5a6978", kNew = "k_1234567890abcdef";
  const helpApp = "helpdesk-api@apps.acme.example", oldApp = "archive-api@apps.acme.example", salesApp = "sales-api@apps.acme.example";
  const cimdUrl = https("claude.ai/oauth/mcp-client.json");
  const loopback = "http:" + "//127.0.0.1/callback";
  const conn = (id, name, host, apps, networks, stale_s, shown_state) => ({ id, name, origin: https(host + ":9445"), apps, networks, stale_s, state: "active", shown_state,
    suspended_by_journal: false });
  const connectors = [conn(kHelp, "helpdesk", "connector.acme.example", [helpApp], ["10.40.0.0/16"], 60, "active"),
    conn(kOld, "archive-bot", "connector2.acme.example", [oldApp], [], 120, "stale"), conn(kNew, "new-conn", "connector3.acme.example", [], [], 60, "never-synced")];
  connectors[2].apps = ["new-api@apps.acme.example"];
  const idps = [{ id: "okta", provider: "okta", issuer: https("acme.okta.com"), algs: ["RS256"], tenant: null, max_age_s: 300, auth_max_s: 43200, private_ok: false,
    state: "active", shown_state: "active", last_test: 1763200000, keys: 2 }];
  const ret = I + "/oauth/sso-return";
  const providers = [{ id: "okta", kind: "okta", iss: https("acme.okta.com/oauth2/default"), sso_url: null, api_return: ret },
    { id: "entra", kind: "entra", iss: https("login.microsoftonline.com/ce5f061f-abe6-4e40-9615-301f87bcb7f0/v2.0"), sso_url: https("sso.acme.example:8443"), api_return: ret }];
  const base = { owner: "ann@acme.example", ceiling: "internal", relays: ["*"], networks: [], mtls_required: false, rate: { per_minute_each: 120, per_day_each: 20000 },
    created: 1763000000, expires: 1790000000, state: "active", shown_state: "active" };
  const ticket = Object.assign({}, base, { id: "c_3a4b5c6d7e8f9001", name: "ticket-bot", principal: "ticket-bot@apps.acme.example", kind: "app", reach: "R1",
    scopes: ["content.read", "content.post"], connectors: [kHelp], apps: [helpApp], channels: ["ch:0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"], confirm: [], mtls_required: true,
    credentials: [{ type: "mtls", hint: "serial 0a1b2c3d" }] });
  const claude = Object.assign({}, base, { id: "c_0b1c2d3e4f5a6b7c", name: "claude-ops", principal: "claude-ops@apps.acme.example", kind: "agent_delegated", reach: "R1",
    scopes: ["content.read", "content.post"], connectors: [kHelp], apps: [helpApp], channels: ["*"], confirm: ["content.post"],
    delegation: { groups: ["00g1a2b3c4"], principals: [], idps: ["okta"], consent_days: 7, denied: ["eve@acme.example"] }, redirect_uris: [loopback], loopback_ok: true,
    credentials: [{ type: "cimd", hint: cimdUrl, expires: 1802776000 }] });
  const map = { seq: 14, issued: 1763000000, expires: 1770000000, issuer_url: I, failover_after_s: 300, grace: { person: 0, app: 0, connector: 0, relay: 0 },
    relay_origins: {}, clients: [ticket, claude], scrape_tokens: [], connectors, idps };
  const reasons = ["Adds a connector, an app to a connector, wider connector networks or a longer stale time",
    "Adds or widens a client that reads or posts conversations, or acts for people", "Adds or widens an identity provider for enterprise-managed sign-in"];
  const staged = { id: "st_0123456789abcdef", org: "acme", by: "ann@acme.example", at: t0, expires_at: t0 + 7200000, base_seq: 14, changes: ["Add connector new-conn"],
    two_person: true, two_person_reasons: reasons, tests_needed: [] };
  const apiView = { ok: true, orgs: [{ org: "acme", edition: "enterprise", state: "on", map, draft: null, journal: { head: 0, entries: [] }, staged, signing: null,
    relays: [{ id: r1, acked: 0, synced: true }], limits: { clients: 500, destinations: 32, scrape_tokens: 10 },
    connector_status: {
      [kHelp]: { sync_age_s: 12, conversations: 42, seal: "tpm2", features: ["content"], reported_at: 1763299990, stale: false },
      [kOld]: { sync_age_s: 400, conversations: 7, seal: "linux_keyring", features: ["content"], reported_at: 1763299600, stale: true },
      [kNew]: { sync_age_s: null, conversations: null, seal: null, features: [], reported_at: null, stale: true } },
    api_apps: [{ principal: helpApp, name: "Helpdesk API" }, { principal: oldApp, name: "Archive API" }, { principal: salesApp, name: "Sales API" }], policy_known: true,
    ai_groups: [{ id: "00g1a2b3c4", label: "Support" }], providers, api_return: ret,
    person_revokes: [{ id: "t_acme_000021", client: claude.id, principal: "eve@acme.example", ts: 1763250000 },
      { id: "t_acme_000022", client: "*", principal: "mallory@acme.example", ts: 1763260000 }] }] };
  const answers = {
    "GET me": {
      ok: true, product: "fleet", profile: "standard", origin: "https://console.acme.example", relay: { host: "console.acme.example" }, sections: [],
      idle: { minutes: 15, maxHours: 12 },
      user: { email: "ann@acme.example", role: "admin", rights: "admin", rightsWhy: null, state: "active", breakGlass: false,
        methods: { webauthn: [], password: false, totp: true }, mustSetPassword: false, sessions: 1, mail: [] },
    },
    "GET settings": { ok: true, twoPerson: "off", profile: "standard", links: [] },
    "GET banner": { ok: true, banner: null },
    "GET overview": { ok: true, product: "fleet", cards: [], approvals: { waiting: 0, mine: 0 }, attention: [],
      fleet: { relays: { total: 1, ok: 1, warn: 0, bad: 0, silent: 0, unconfirmed: 0 }, people: { online: 0 }, calls: { active: 0 }, kpis: {} } },
    "GET setup": { ok: true, bootstrapped: true, profileFixed: null, pinned: false, steps: { signin: "done", email: "done", license: "done", relay: "done" } },
    "GET fleet/relays": { ok: true, total: 1, relays: [
      { id: r1, name: "Dallas east", site: "us-east", product: "meet", state: "active", connected: true, lastContactAt: t0, version: "2.7.0", health: "ok", scopes: ["read-health"], readOnly: false, confirm: [] }] },
    "GET settings/api": apiView,
    "GET settings/api/delegations": { ok: true, org: "acme", client: claude.id, revokes: [], people: [
      { principal: "bob@acme.example", client: claude.id, client_name: "claude-ops", grant: "jwt_bearer", first_use: 1763200000, last_use: 1763290000, ends: null, revoked: false },
      { principal: "dan@acme.example", client: claude.id, client_name: "claude-ops", grant: "authorization_code", first_use: 1763100000, last_use: 1763150000, ends: 1763700000, revoked: true }] },
    "GET settings/api/approvals": { ok: true, org: "acme", approvals: [
      { ts: 1763280000, connector: kHelp, client: claude.id, approval: "ap_0011223344556677", action: "content.approval.answered", result: "approved", app: helpApp }] },
    "POST stepup/begin": { ok: true, ceremony: "c1", totp: true, publicKey: {} },
    "POST settings/api/idps/test": { ok: true, issuer: https("acme.okta.com"), jwks_uri: https("acme.okta.com/oauth2/v1/keys"), keys: [{ kid: "okta-k1", alg: "RS256", kty: "RSA" }] },
  };
  const confirmCode = async () => {
    for (let i = 0; i < 4; i++) await settle();
    if (!doc.getElementById("code-dlg").open) fail("no step-up code asked");
    doc.getElementById("code-input").value = "123456";
    doc.getElementById("code-go").click();
    for (let i = 0; i < 6; i++) await settle();
  };
  const field = (label) => {
    const l = doc.getElementById("confirm-fields").querySelectorAll("label").find((x) => x.textContent === label);
    if (!l) fail("the dialog has no field " + JSON.stringify(label));
    return doc.getElementById(l.getAttribute("for"));
  };
  const title = () => doc.getElementById("confirm-title").textContent;
  // A row action of the first table row that shows `has` and offers `label`.
  const rowAction = (has, label) => {
    for (const tr of doc.querySelectorAll("tr")) {
      if (!tr.textContent.includes(has)) continue;
      const b = tr.querySelectorAll("td.actions button").find((x) => x.textContent === label);
      if (b) return b;
    }
    return fail("no row with " + has + " offers " + label);
  };
  const posted = (route) => {
    const c = calls.filter((x) => x.route === route).pop();
    if (!c) fail("nothing was posted to " + route);
    if (!c.body.stepup) fail(route + " was posted without a step-up");
    const b = Object.assign({}, c.body);
    delete b.stepup;
    return b;
  };
  const same = (route, want) => {
    const got = posted(route);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail("the " + route + " body:\n" + JSON.stringify(got) + "\nwant\n" + JSON.stringify(want));
  };
  boot(answers, { hash: "#/security/api" });
  for (let i = 0; i < 4; i++) await settle();

  // The page: two-person reasons, the clients' kinds, content and delegation, people, approvals, revokes, connectors with a
  // stale and a never-synced one and their key stores, identity providers, and the sign-in providers with api_return.
  const page = view();
  inOrder(page, [W["api.title"], W["api.staged"], W["api.two-person"], ...reasons, W["api.clients"], "ticket-bot", W["api.kind-app"], "claude-ops", W["api.kind-agent-delegated"],
    W["api.content"], "ticket-bot", W["api.col-connectors"], "helpdesk", W["api.col-apps"], helpApp, W["api.f-channels"], "ch:0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d", W["api.f-confirm"],
    W["api.approvals"], W["api.approvals-help"], "ap_0011223344556677", "content.approval.answered", "approved",
    "claude-ops", W["api.channels-all"], W["api.delegation"], W["api.dlg-groups"], "00g1a2b3c4", W["api.dlg-denied"], "eve@acme.example", W["api.dlg-idps"], "okta",
    W["api.dlg-consent"], "7", W["api.redirects"], loopback, W["api.loopback"], W["api.cimd"], cimdUrl, W["api.loopback-warn"],
    W["api.people"], W["api.people-help"], "bob@acme.example", "jwt_bearer", "dan@acme.example", "authorization_code", W["api.revoked"], W["api.approvals"],
    W["api.revokes"], W["api.revokes-help"], "eve@acme.example", "claude-ops", "mallory@acme.example", W["api.all-clients"]], "content, people and revokes");
  inOrder(page, [W["api.connectors"], W["api.connectors-help"], W["api.conn-add"], "helpdesk", kHelp, https("connector.acme.example:9445"), "Helpdesk API", "42",
    filled(W["api.sync-age"], { n: 12 }), W["api.shown-active"], "tpm2", "archive-bot", "Archive API", "7", filled(W["api.sync-age"], { n: 400 }), W["api.shown-stale"], "linux_keyring",
    "new-conn", W["api.not-reported"], W["api.shown-never-synced"], W["api.shown-never-synced"], W["api.not-reported"],
    W["api.idps"], W["api.idps-help"], "okta", https("acme.okta.com"), "RS256", "300", "43200", W["api.shown-active"], "2",
    W["api.providers"], W["api.providers-help"], W["api.api-return"], ret, "okta", https("acme.okta.com/oauth2/default"), W["api.not-set"], "entra", https("sso.acme.example:8443")],
    "connectors, identity providers and providers");
  if (page.includes("\u2014") || page.includes("\u2013")) fail("a long dash on API access");
  if (doc.querySelectorAll("tr").some((tr) => tr.textContent.includes("dan@acme.example") && tr.querySelectorAll("td.actions button").some((b) => b.textContent === W["api.revoke"]))) {
    fail("Revoke is offered on a revoked delegation");
  }

  // Add connector: name, origin, apps picked from the org's api apps, networks and stale seconds, with a step-up.
  find("button", W["api.conn-add"]).click();
  await settle();
  if (title() !== filled(D["api-connector"].title, { name: "" })) fail("the add connector dialog title: " + title());
  const box = (text) => {
    const l = doc.getElementById("confirm-fields").querySelectorAll("label").find((x) => x.textContent === text);
    if (!l) fail("the dialog has no choice " + JSON.stringify(text));
    return doc.getElementById(l.getAttribute("for"));
  };
  field(W["api.f-name"]).value = "sales";
  field(W["api.f-conn-origin"]).value = https("connector4.acme.example:9445");
  box("Sales API (" + salesApp + ")").checked = true;
  field(W["api.f-networks"]).value = "10.50.0.0/16";
  field(W["api.f-conn-stale"]).value = "90";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/connectors", { org: "acme", connector: { name: "sales", origin: https("connector4.acme.example:9445"), apps: [salesApp], networks: ["10.50.0.0/16"], stale_s: 90 } });

  // Suspend the stale connector, with a reason and a step-up.
  rowAction("archive-bot", W["api.suspend"]).click();
  await settle();
  if (title() !== filled(D["api-connector-suspend"].title, { name: "archive-bot" })) fail("the suspend connector dialog title: " + title());
  doc.getElementById("confirm-fields").querySelector("textarea").value = "Host retired";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/connectors/suspend", { org: "acme", id: kOld, reason: "Host retired" });

  // Test an identity provider: the issuer, the key set address and each key are shown; nothing else.
  rowAction("RS256", W["api.idp-test"]).click();
  await settle();
  if (title() !== filled(D["api-idp-test"].title, { name: "okta" })) fail("the IdP test dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/idps/test", { org: "acme", id: "okta" });
  for (let i = 0; i < 4; i++) await settle();
  inOrder(view(), [W["api.idps"], W["api.idp-tested"] + ": okta", W["api.col-issuer"], https("acme.okta.com"), W["api.idp-jwks"], https("acme.okta.com/oauth2/v1/keys"),
    W["api.col-kid"], "okta-k1", "RS256", "RSA"], "IdP test result");

  // Add identity provider from the Okta provider: the issuer is prefilled with the org authorization server.
  rowAction("oauth2/default", W["api.idp-add"]).click();
  await settle();
  if (field(W["api.f-issuer"]).value !== https("acme.okta.com")) fail("the issuer is not prefilled from the provider: " + field(W["api.f-issuer"]).value);
  doc.getElementById("confirm").close();
  await settle();

  // Change an identity provider: the dialog says narrowing applies at once and widening needs a second admin.
  rowAction("RS256", W["api.change"]).click();
  await settle();
  if (title() !== filled(D["api-idp-update"].title, { name: "okta" })) fail("the IdP change dialog title: " + title());
  if (!doc.getElementById("confirm-body").textContent.includes(D["api-idp-update"].body)) fail("the IdP change dialog does not say what applies at once");
  if (!box("RS256").checked || field(W["api.f-auth-max"]).value !== "43200") fail("the IdP change dialog is not prefilled");
  box("PS256").checked = true;
  field(W["api.f-tenant"]).value = "acme";
  field(W["api.f-max-age"]).value = "120";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/idps/update", { org: "acme", id: "okta", idp: { algs: ["RS256", "PS256"], tenant: "acme", max_age_s: 120, auth_max_s: 43200, private_ok: false } });

  // Set the SSO URL of a provider (step-up), and the api_return value has its Copy button.
  rowAction("oauth2/default", W["api.sso-set"]).click();
  await settle();
  if (title() !== filled(D["api-sso-url"].title, { provider: "okta" })) fail("the SSO URL dialog title: " + title());
  field(W["api.f-sso-url"]).value = https("sso.acme.example:8443");
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/sso-url", { org: "acme", provider: "okta", url: https("sso.acme.example:8443") });
  const retLine = doc.querySelectorAll("dd").find((d) => d.textContent.includes(ret));
  if (!retLine || !retLine.querySelectorAll("button").some((b) => b.textContent === "Copy")) fail("api_return has no Copy button");

  // Revoke a person's delegation, and allow a revoked person again (two-person, staged).
  rowAction("bob@acme.example", W["api.revoke"]).click();
  await settle();
  if (title() !== filled(D["api-delegation-revoke"].title, { principal: "bob@acme.example", name: "claude-ops" })) fail("the revoke dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/delegations/revoke", { org: "acme", client: claude.id, principal: "bob@acme.example" });
  rowAction("mallory@acme.example", W["api.allow"]).click();
  await settle();
  if (title() !== filled(D["api-delegation-allow"].title, { principal: "mallory@acme.example", name: W["api.all-clients"] })) fail("the allow again dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/delegations/allow", { org: "acme", client: "*", principal: "mallory@acme.example" });
  // Revoke for every client, offered only on an entry for one client.
  if (doc.querySelectorAll("tr").some((tr) => tr.textContent.includes("mallory@acme.example") && tr.querySelectorAll("td.actions button").some((b) => b.textContent === W["api.revoke-all"]))) {
    fail("Revoke for every client is offered on an entry that already covers every client");
  }
  rowAction("eve@acme.example", W["api.revoke-all"]).click();
  await settle();
  if (title() !== filled(D["api-delegation-revoke-all"].title, { principal: "eve@acme.example" })) fail("the revoke for every client dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/delegations/revoke", { org: "acme", client: "*", principal: "eve@acme.example" });
  const asked = calls.filter((c) => c.route === "GET settings/api/delegations").map((c) => c.url);
  if (!asked.length || !asked.every((u) => u.endsWith("?org=acme&client=" + claude.id))) fail("the people were not read per client: " + asked.join(", "));

  // The client editor: Content and Delegation prefilled from the client, sent back with the 3.2 fields.
  rowAction("claude-ops", W["api.edit"]).click();
  await settle();
  if (field(W["api.f-kind"]).value !== "agent_delegated") fail("the editor does not show the delegated kind");
  if (!box("helpdesk").checked || !box("Support (00g1a2b3c4)").checked || !box("okta (" + https("acme.okta.com") + ")").checked) fail("the editor does not pick the client's connector, group and IdP");
  if (field(W["api.f-cimd"]).value !== cimdUrl || field(W["api.f-loopback"]).value !== "yes" || field(W["api.f-confirm"]).value !== "yes") fail("the editor does not show the CIMD, loopback and confirm values");
  if (!doc.getElementById("confirm-fields").textContent.includes(W["api.loopback-warn"])) fail("the loopback choice has no warning");
  field(W["api.f-consent-days"]).value = "14";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const upd = posted("POST settings/api/clients/update");
  const c = upd.client;
  if (upd.id !== claude.id || c.kind !== "agent_delegated" || c.reach !== "R1" || JSON.stringify(c.connectors) !== JSON.stringify([kHelp]) || JSON.stringify(c.apps) !== JSON.stringify([helpApp])
    || JSON.stringify(c.channels) !== "[\"*\"]" || JSON.stringify(c.confirm) !== "[\"content.post\"]" || c.loopback_ok !== true || "credentials" in c
    || JSON.stringify(c.delegation) !== JSON.stringify({ groups: ["00g1a2b3c4"], principals: [], idps: ["okta"], consent_days: 14, denied: ["eve@acme.example"] })
    || JSON.stringify(c.redirect_uris) !== JSON.stringify([loopback])) {
    fail("the client update body: " + JSON.stringify(upd));
  }
  // Leaving a content kind removes what the new kind does not allow: the delegated client with CIMD becomes an R0 agent
  // (nulls, and no credentials list: the console drops the cimd credential itself), and the app becomes a monitoring
  // client.
  const nulls = (body, keys) => keys.every((k) => k in body && body[k] === null);
  rowAction("claude-ops", W["api.edit"]).click();
  await settle();
  field(W["api.f-kind"]).value = "agent";
  field(W["api.f-scopes"]).value = "monitor.read";
  box("helpdesk").checked = false;
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const toAgent = posted("POST settings/api/clients/update");
  const a = toAgent.client;
  if (toAgent.id !== claude.id || a.kind !== "agent" || a.reach !== "R0" || !nulls(a, ["connectors", "apps", "channels", "confirm", "delegation", "redirect_uris", "loopback_ok"])
    || "credentials" in a) {
    fail("the delegated client turned agent does not remove its content and delegation fields, or resends credentials: " + JSON.stringify(toAgent));
  }
  rowAction("ticket-bot", W["api.edit"]).click();
  await settle();
  field(W["api.f-kind"]).value = "monitoring";
  field(W["api.f-scopes"]).value = "monitor.read";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const toMonitoring = posted("POST settings/api/clients/update");
  const m = toMonitoring.client;
  if (toMonitoring.id !== ticket.id || m.kind !== "monitoring" || m.reach !== "R0" || !nulls(m, ["connectors", "apps", "channels", "confirm"])
    || "delegation" in m || "redirect_uris" in m || "loopback_ok" in m || "credentials" in m) {
    fail("the app turned monitoring client does not remove its content fields: " + JSON.stringify(toMonitoring));
  }

  // Settings > AI > Local MCP on a Meeting Hub relay: shown as Enterprise only, staged with the AI settings.
  const host = { host: "relay.acme.example", version: "0.99.0", uptimeSeconds: 100, fips: false };
  const me = {
    ok: true, product: "meet", profile: "standard", origin: "https://relay.acme.example", relay: host,
    sections: ["overview", "meet", "approvals", "admins"], idle: { minutes: 15, maxHours: 12 },
    user: { email: "ann@acme.example", role: "admin", rights: "admin", rightsWhy: null, state: "active", breakGlass: false,
      methods: { webauthn: [], password: false, totp: true }, mustSetPassword: false, sessions: 1, mail: [] },
  };
  const aiView = (edition) => ({
    ok: true, org: "acme", orgs: [{ id: "acme", label: "Acme" }], presets: [{ id: "device", label: "This computer only", order: ["device"], access: "none" }], default: "device",
    advanced: "Advanced", preset: "device", map: { who_principals: [] }, staged: null, saving: [], waiting: [], gateways: [], edition, lacks: null, reviewers: [], consoleSpki: "a".repeat(64),
    results: [], ai: { v: 1, enabled: true, who: { groups: ["g-1"] }, order: ["device"], frontier: { access: "none" }, classes: ["public", "internal", "confidential", "cui"],
      cui_classes: ["cui"], local_mcp: { enabled: false, classes: [], tools: ["search"], send: false } },
  });
  const ai = (edition) => ({
    "GET me": me, "GET settings": { ok: true, twoPerson: "off", profile: "standard", links: [] }, "GET banner": { ok: true, banner: null },
    "GET overview": { ok: true, product: "meet", relay: host, cards: [], attention: [], approvals: { waiting: 0, mine: 0 }, requests: { waiting: 0 }, links: [], banners: [] },
    "GET meet/ai": aiView(edition), "GET meet/ai/cards": { ok: true, cards: [], errors: [] }, "GET meet/ai/usage": { ok: true, requests: 0, refusals: {} },
    "GET meet/ai/archive": { ok: true, size: "small", archive: null, add: "Add an archive", notice: "" },
    "GET meet/ai/mcp": { ok: true, org: "acme", servers: [], gateways: [], journal: [] },
    "POST stepup/begin": { ok: true, ceremony: "c1", totp: true, publicKey: {} },
  });
  boot(ai("enterprise"), { hash: "#/meet/ai" });
  for (let i = 0; i < 4; i++) await settle();
  inOrder(view(), [W["lmcp.title"], W["lmcp.enterprise"], W["lmcp.help"], W["lmcp.state"], W["lmcp.tools"], "search", W["lmcp.send"], W["lmcp.change"]], "Local MCP card");
  find("button", W["lmcp.change"]).click();
  await settle();
  if (title() !== filled(D["local-mcp"].title, { org: "acme" })) fail("the Local MCP dialog title: " + title());
  if (doc.getElementById("confirm-fields").querySelectorAll("label").some((l) => l.textContent === "cui")) fail("Local MCP offers a CUI class");
  field(W["lmcp.f-enabled"]).value = "on";
  box("internal").checked = true;
  box("read_conversation").checked = true;
  field(W["lmcp.f-send"]).value = "yes";
  doc.getElementById("confirm-go").click();
  for (let i = 0; i < 2; i++) await settle();
  if (doc.getElementById("confirm-error").textContent !== W["lmcp.check"]) fail("Allow sending without send_message is not refused: " + doc.getElementById("confirm-error").textContent);
  box("send_message").checked = true;
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST meet/ai/stage", { org: "acme", preset: "device", ai: { local_mcp: { enabled: true, classes: ["internal"], tools: ["search", "read_conversation", "send_message"], send: true } } });
  boot(ai("standard"), { hash: "#/meet/ai" });
  for (let i = 0; i < 4; i++) await settle();
  if (!view().includes(W["lmcp.standard"])) fail("a standard license does not say Local MCP needs an enterprise license");
  if (find("button", W["lmcp.change"])) fail("a standard license offers Change Local MCP");
  console.log("api-r5: connectors, identity providers, SSO URL, content and delegation, people, revokes, approvals and Local MCP ok");
}

// ---- API-1 revision 6 7.14 (API-1d5): the Agents and Remote Spokes tabs, Tasks, the partner card check and hand-off ----
async function apiR6Main(v) {
  const W = v.page;
  const D = v.dialogs;
  const r1 = "r_0000000000000001";
  const t0 = 1763300000000;
  const filled = (tpl, vals) => tpl.replace(/<([a-z][a-z ]*)>/g, (_, k) => String(vals[k]));
  const https = (rest) => "https:" + "//" + rest;
  const I = https("console.acme.example:7443/api/orgs/acme");
  const aId = "a_7c1d2e3f4a5b6c7d", idleId = "a_0123456789abcdef", kBuild = "k_1a2b3c4d5e6f7081";
  const hubId = "c_9a8b7c6d5e4f3a2b", partnerId = "c_0b1c2d3e4f506172";
  const node1 = "n_a1b2c3d4e5f60718293a4b5c6d7e8f90", node2 = "n_" + "b".repeat(32), hubNode = "n_5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const rootId = "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0", rootSpki = "cd".repeat(32);
  const jwksUrl = I + "/a2a/jwks.json";
  const base = { owner: "ann@acme.example", ceiling: "confidential", networks: [], mtls_required: false, rate: { per_minute_each: 60, per_day_each: 5000 },
    created: 1763000000, expires: 1790000000, state: "active", shown_state: "active" };
  const hub = Object.assign({}, base, { id: hubId, name: "build-hub", principal: "build-hub@apps.acme.example", kind: "spokes_hub", reach: "R1", scopes: ["spokes.tasks.submit"],
    relays: ["r_21"], credentials: [{ type: "spokes_node", hint: hubNode, expires: 1802776000, key_store: "pkcs11" }], spokes: { targets: [node1] } });
  const partnerCardUrl = https("ci.partner.example/.well-known/agent-card.json"), partnerJwks = https("ci.partner.example/jwks.json");
  const partner = Object.assign({}, base, { id: partnerId, name: "partner-ci", principal: "partner-ci@apps.acme.example", kind: "agent", reach: "R1", scopes: ["spokes.tasks.submit"],
    relays: ["console"], credentials: [{ type: "private_key_jwt", hint: "p1" }], connectors: [kBuild],
    a2a: { agents: [aId], skills: ["*"], max_open_tasks: 8, push: { origins: [https("ci.partner.example")], private_cidrs: [] } },
    card: { url: partnerCardUrl, jwks_uri: partnerJwks, private_cidrs: [] },
    card_check: { state: "verified", checked_at: 1763280000, why: null, name: "Partner CI", provider: { organization: "Partner Inc", url: https("partner.example") }, version: "2.1.0",
      interfaces: [{ url: https("ci.partner.example/a2a"), protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }], kids: ["p-k1"] },
    handoff: { jwks_url: jwksUrl, thumbprints: ["tp-active-1"] } });
  const connectors = [{ id: kBuild, name: "build-conn", origin: https("conn.acme.example:8445"), apps: ["build-api@apps.acme.example"], networks: [], stale_s: 60, state: "active",
    shown_state: "active", suspended_by_journal: false }];
  const map = { seq: 14, issued: 1763000000, expires: 1770000000, issuer_url: I, failover_after_s: 300, grace: { person: 0, app: 0, connector: 0, relay: 0 },
    relay_origins: {}, clients: [hub, partner], scrape_tokens: [], connectors, idps: [], a2a: { agents: [{ id: aId, name: "Acme Build Agent", connector: kBuild }] } };
  const apiView = { ok: true, orgs: [{ org: "acme", edition: "enterprise", state: "on", map, draft: null, journal: { head: 0, entries: [] }, staged: null, signing: null,
    relays: [{ id: r1, acked: 0, synced: true }], limits: { clients: 500, destinations: 32, scrape_tokens: 10 },
    connector_status: { [kBuild]: { sync_age_s: 10, conversations: null, seal: "tpm2", features: ["a2a"], reported_at: 1763299990, stale: false } },
    api_apps: [{ principal: "build-api@apps.acme.example", name: "Build API" }], policy_known: true, ai_groups: [], providers: [], api_return: null, person_revokes: [] }] };
  const skill = { id: "build-and-test", name: "Build and test", description: "Builds the named branch and runs its tests.", tags: ["build", "test"],
    examples: ["Build branch release/2.3"], targets: [node1], model: "anthropic/claude-sonnet-4-6", turns: "one", approve_within_s: 3600, idle_close_s: 3600, dropped: false };
  const lint = { id: "lint", name: "Lint", description: "Runs the linter.", tags: ["lint"], examples: [], targets: [node1], model: null, turns: "one", approve_within_s: 600,
    idle_close_s: null, dropped: true };
  const signed = { name: "Acme Build Agent", description: "Runs build and test tasks.", version: "1.0.0",
    supportedInterfaces: [{ url: https("conn.acme.example:8445/api/orgs/acme/a2a/" + aId), protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
    skills: [{ id: "build-and-test", name: "Build and test" }], signatures: [{ protected: "eyJhbGciOiJFUzI1NiJ9", signature: "c2lnbmF0dXJl" }] };
  const cardUrl = I + "/a2a/agents/" + aId + "/agent-card.json";
  const agent = { id: aId, name: "Acme Build Agent", description: "Runs build and test tasks.", version: "1.0.0", connector: kBuild, hub: hubId, streaming: true, push: true,
    provider: { organization: "Acme Robotics", url: https("acme.example") }, documentation_url: null, skills: [skill, lint], off: false, card_url: cardUrl,
    card: { state: "served", card: signed, etag: "\"" + "ab".repeat(32) + "\"", kids: ["a2a-k1"], signed_at: 1763290000, map_seq: 14 } };
  const idle = { id: idleId, name: "Idle Agent", description: "Waits.", version: "0.1.0", connector: kBuild, hub: hubId, streaming: false, push: false, provider: null,
    documentation_url: null, skills: [Object.assign({}, skill, { id: "check" })], off: false, card_url: I + "/a2a/agents/" + idleId + "/agent-card.json",
    card: { state: "unsigned", card: null, etag: null, kids: [], signed_at: null, map_seq: 14 } };
  const key = (kid, state, tp) => ({ kid, nbf: 1763000000, exp: 1790000000, state, sealed: true, thumbprint: tp });
  const keys = [key("a2a-k1", "active", "tp-active-1"), key("a2a-k0", "expired", "tp-old-0")];
  const wellKnownUrl = https("console.acme.example:7443/.well-known/agent-card.json");
  const a2aView = { ok: true, org: "acme", issuer: I, agents_url: I + "/a2a/agents", jwks_url: jwksUrl, well_known: null, well_known_url: wellKnownUrl,
    agents: [agent, idle], keys, connectors: { [kBuild]: { name: "build-conn", stale: false, shown_state: "active", a2a: true, enclave: false } },
    hubs: [{ id: hubId, name: "build-hub" }], draft: { agents: [], keys: [keys[0], key("a2a-k2", "pending", "tp-new-2")], well_known: null } };
  const tasks = { ok: true, org: "acme", tasks: [{ task: "t_0011223344556677", client: partnerId, client_name: "partner-ci", agent: aId, skill: "build-and-test", spoke: node1,
    state: "working", created: 1763290000, updated: 1763291000, bytes_in: 120, bytes_out: 4096 }] };
  const spokesView = { ok: true, org: "acme", console_root: { id: rootId }, map_root: { root: rootId, root_spki: rootSpki }, draft_root: null,
    relays: [{ id: "r_21", name: "spokes-east", connected: true, bound: true, listed: true, staged: true, outdated: false },
      { id: "r_22", name: "spokes-west", connected: false, bound: true, listed: false, staged: true, outdated: true }],
    candidates: [{ id: "r_23", name: "spokes-north" }],
    hubs: [{ id: hubId, name: "build-hub", principal: "build-hub@apps.acme.example", state: "active", ceiling: "confidential", targets: [node1], relays: ["r_21"],
      credentials: [{ node: hubNode, serial: "0a1b2c", expires: 1802776000, key_store: "pkcs11" }], agent: aId }] };
  const answers = {
    "GET me": {
      ok: true, product: "fleet", profile: "standard", origin: "https://console.acme.example", relay: { host: "console.acme.example" }, sections: [],
      idle: { minutes: 15, maxHours: 12 },
      user: { email: "ann@acme.example", role: "admin", rights: "admin", rightsWhy: null, state: "active", breakGlass: false,
        methods: { webauthn: [], password: false, totp: true }, mustSetPassword: false, sessions: 1, mail: [] },
    },
    "GET settings": { ok: true, twoPerson: "off", profile: "standard", links: [] },
    "GET banner": { ok: true, banner: null },
    "GET overview": { ok: true, product: "fleet", cards: [], approvals: { waiting: 0, mine: 0 }, attention: [],
      fleet: { relays: { total: 1, ok: 1, warn: 0, bad: 0, silent: 0, unconfirmed: 0 }, people: { online: 0 }, calls: { active: 0 }, kpis: {} } },
    "GET setup": { ok: true, bootstrapped: true, profileFixed: null, pinned: false, steps: { signin: "done", email: "done", license: "done", relay: "done" } },
    "GET fleet/relays": { ok: true, total: 1, relays: [
      { id: r1, name: "Dallas east", site: "us-east", product: "meet", state: "active", connected: true, lastContactAt: t0, version: "2.7.0", health: "ok", scopes: ["read-health"], readOnly: false, confirm: [] }] },
    "GET settings/api": apiView,
    "GET settings/api/a2a": a2aView,
    "GET settings/api/a2a/tasks": tasks,
    "GET settings/api/spokes": spokesView,
    "POST stepup/begin": { ok: true, ceremony: "c1", totp: true, publicKey: {} },
    "POST settings/api/clients/card-check": { ok: true, card: partner.card_check },
    "POST settings/api/a2a/keys": { ok: true, key: { kid: "a2a-k3" } },
  };
  const confirmCode = async () => {
    for (let i = 0; i < 4; i++) await settle();
    if (!doc.getElementById("code-dlg").open) fail("no step-up code asked");
    doc.getElementById("code-input").value = "123456";
    doc.getElementById("code-go").click();
    for (let i = 0; i < 6; i++) await settle();
  };
  const go4 = async () => {
    for (let i = 0; i < 4; i++) await settle();
  };
  const field = (label) => {
    const l = doc.getElementById("confirm-fields").querySelectorAll("label").find((x) => x.textContent === label);
    if (!l) fail("the dialog has no field " + JSON.stringify(label));
    return doc.getElementById(l.getAttribute("for"));
  };
  const title = () => doc.getElementById("confirm-title").textContent;
  const error = () => doc.getElementById("confirm-error").textContent;
  const rowAction = (has, label) => {
    for (const tr of doc.querySelectorAll("tr")) {
      if (!tr.textContent.includes(has)) continue;
      const b = tr.querySelectorAll("td.actions button").find((x) => x.textContent === label);
      if (b) return b;
    }
    return fail("no row with " + has + " offers " + label);
  };
  const offers = (has, label) => doc.querySelectorAll("tr").some((tr) => tr.textContent.includes(has) && tr.querySelectorAll("td.actions button").some((b) => b.textContent === label));
  const last = (route) => {
    const c = calls.filter((x) => x.route === route).pop();
    if (!c) fail("nothing was posted to " + route);
    return c.body;
  };
  const same = (route, want) => {
    const b = Object.assign({}, last(route));
    if (!b.stepup) fail(route + " was posted without a step-up");
    delete b.stepup;
    if (JSON.stringify(b) !== JSON.stringify(want)) fail("the " + route + " body:\n" + JSON.stringify(b) + "\nwant\n" + JSON.stringify(want));
  };
  const plain = (route, want) => {
    const b = last(route);
    if (b.stepup) fail(route + " asked for a step-up");
    if (JSON.stringify(b) !== JSON.stringify(want)) fail("the " + route + " body:\n" + JSON.stringify(b) + "\nwant\n" + JSON.stringify(want));
  };
  const noDash = (where) => {
    if (view().includes("\u2014") || view().includes("\u2013")) fail("a long dash on " + where);
  };
  boot(answers, { hash: "#/security/api" });
  await go4();

  // Clients and settings: the tabs, the service hub kind, and the partner agent with its card check and the hand-off.
  inOrder(view(), [W["api.title"], W["api.tab-general"], W["api.tab-agents"], W["api.tab-spokes"], W["api.clients"], "build-hub", W["api.kind-spokes-hub"], "partner-ci",
    W["api.partners"], "partner-ci", W["api.f-a2a-agents"], aId, W["api.col-max-tasks"], "8", W["api.push-origins"], https("ci.partner.example"), partnerCardUrl, partnerJwks,
    W["api.partner-card"], W["api.partner-verified"], W["api.col-checked"], "Partner CI", "Partner Inc", "2.1.0", "p-k1", W["api.partner-interfaces"], https("ci.partner.example/a2a"),
    "HTTP+JSON", W["api.card-check"], W["api.push-off"], W["api.handoff"], W["api.handoff-help"], W["api.handoff-jwks"], jwksUrl, W["api.handoff-thumbprints"], "tp-active-1"], "partner agents");
  const handoff = doc.querySelectorAll("dd").find((d) => d.textContent.includes(jwksUrl));
  if (!handoff || !handoff.querySelectorAll("button").some((b) => b.textContent === "Copy")) fail("the hand-off key set address has no Copy button");
  noDash("Clients and settings");

  // Check now and Push off: at once, no step-up.
  find("button", W["api.card-check"]).click();
  await settle();
  if (title() !== filled(D["api-card-check"].title, { name: "partner-ci" })) fail("the card check dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await go4();
  plain("POST settings/api/clients/card-check", { org: "acme", id: partnerId });
  find("button", W["api.push-off"]).click();
  await settle();
  if (title() !== filled(D["api-push-off"].title, { name: "partner-ci" })) fail("the push off dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await go4();
  plain("POST settings/api/clients/push-off", { org: "acme", id: partnerId });

  // The client editor of the agent: its a2a and card fields prefilled, narrowed, and the card's private networks added.
  rowAction("partner-ci", W["api.edit"]).click();
  await settle();
  const box = (text) => {
    const l = doc.getElementById("confirm-fields").querySelectorAll("label").find((x) => x.textContent === text);
    if (!l) fail("the dialog has no choice " + JSON.stringify(text));
    return doc.getElementById(l.getAttribute("for"));
  };
  if (!box("Acme Build Agent (" + aId + ")").checked || field(W["api.f-max-tasks"]).value !== "8" || field(W["api.f-a2a-skills"]).value !== "*"
    || field(W["api.f-push-origins"]).value !== https("ci.partner.example") || field(W["api.f-card-url"]).value !== partnerCardUrl || field(W["api.f-card-jwks"]).value !== partnerJwks) {
    fail("the agent client editor is not prefilled");
  }
  field(W["api.f-max-tasks"]).value = "4";
  field(W["api.f-push-origins"]).value = "";
  field(W["api.f-card-cidrs"]).value = "not a network";
  doc.getElementById("confirm-go").click();
  await go4();
  if (error() !== W["api.check-a2a"]) fail("a bad private network is not refused: " + error());
  field(W["api.f-card-cidrs"]).value = "10.9.0.0/24";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const upd = last("POST settings/api/clients/update");
  const c = upd.client;
  if (upd.id !== partnerId || c.kind !== "agent" || c.reach !== "R1" || JSON.stringify(c.connectors) !== JSON.stringify([kBuild])
    || JSON.stringify(c.a2a) !== JSON.stringify({ agents: [aId], skills: ["*"], max_open_tasks: 4 })
    || JSON.stringify(c.card) !== JSON.stringify({ url: partnerCardUrl, jwks_uri: partnerJwks, private_cidrs: ["10.9.0.0/24"] }) || "spokes" in c) {
    fail("the agent client update body: " + JSON.stringify(upd));
  }

  // Add a service hub: refused without a node certificate, then sent with the pasted token and its key store.
  find("button", W["api.client-add"]).click();
  await settle();
  field(W["api.f-name"]).value = "hub-two";
  field(W["api.f-kind"]).value = "spokes_hub";
  field(W["api.f-owner"]).value = "ann@acme.example";
  field(W["api.f-scopes"]).value = "spokes.tasks.submit";
  field(W["api.f-relays"]).value = "r_21";
  field(W["api.f-targets"]).value = node2;
  if (field(W["api.f-key-store"]).value !== "os_store") fail("the key store does not start at the operating system store");
  doc.getElementById("confirm-go").click();
  await go4();
  if (error() !== W["api.check-spokes-hub"]) fail("a service hub without a certificate is not refused: " + error());
  field(W["api.f-node-cert"]).value = "eyJub2RlIjoiY2VydCJ9";
  field(W["api.f-key-store"]).value = "tpm";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const add = last("POST settings/api/clients").client;
  if (add.kind !== "spokes_hub" || add.reach !== "R1" || add.mtls_required !== false || JSON.stringify(add.scopes) !== "[\"spokes.tasks.submit\"]"
    || JSON.stringify(add.spokes) !== JSON.stringify({ targets: [node2] })
    || JSON.stringify(add.credentials) !== JSON.stringify([{ type: "spokes_node", cert: "eyJub2RlIjoiY2VydCJ9", key_store: "tpm" }]) || "a2a" in add) {
    fail("the service hub body: " + JSON.stringify(add));
  }

  // The Agents tab: agents, the card state, Copy card URL, the signed card, card keys (signed and staged), the root
  // well-known card and the Tasks list.
  await go("#/security/api?tab=agents");
  inOrder(view(), [W["api.tab-agents"], W["api.agents"], W["api.agents-help"], W["api.agents-url"], I + "/a2a/agents", W["api.handoff-jwks"], jwksUrl,
    W["api.a2a-second"], W["api.two-a2a-agent"], W["api.two-a2a-client"], W["api.two-a2a-private"], W["api.two-well-known"], W["api.agent-add"],
    "Acme Build Agent", aId, "1.0.0", "build-conn", "build-hub", "build-and-test, lint", W["api.card-served"], "Idle Agent", W["api.card-unsigned"],
    "Acme Build Agent", W["api.card-url"], cardUrl, W["api.card-copy-url"], W["api.card-served"], W["api.card-etag"], "ab".repeat(32), W["api.card-preview"], "\"signatures\"",
    "Build and test", node1, "anthropic/claude-sonnet-4-6", "3600", "lint", W["api.skill-dropped"],
    "Idle Agent", W["api.card-unsigned"], W["api.refusal-card-unsigned"],
    W["api.card-keys"], W["api.card-keys-help"], W["api.card-key-new"], "a2a-k1", W["api.key-active"], "tp-active-1", "a2a-k0", W["api.key-expired"], "tp-old-0",
    W["api.draft-keys"], "a2a-k2", W["api.key-pending"], "tp-new-2",
    W["api.well-known"], wellKnownUrl, W["api.f-well-known"], W["api.well-known-none"], W["api.well-known-set"],
    W["api.tasks"], W["api.tasks-help"], "t_0011223344556677", "partner-ci", "Acme Build Agent", "build-and-test", node1, "Working", "120", "4096"], "agents tab");
  noDash("Agents");
  if (!find("button", W["api.card-copy-url"])) fail("no Copy card URL control");
  if (offers("a2a-k0", W["api.card-key-drop"])) fail("Drop key is offered on an ended key");
  const firstTasks = calls.filter((x) => x.route === "GET settings/api/a2a/tasks").pop();
  if (!firstTasks || !firstTasks.url.endsWith("?org=acme")) fail("the tasks were not read for the org: " + (firstTasks && firstTasks.url));

  // Add agent: the skills editor is checked on the page, then the body has the contract's agent fields.
  find("button", W["api.agent-add"]).click();
  await settle();
  if (title() !== filled(D["api-agent"].title, { name: "" })) fail("the add agent dialog title: " + title());
  field(W["api.f-agent-name"]).value = "Release Agent";
  field(W["api.f-description"]).value = "Ships releases.";
  field(W["api.f-streaming"]).value = "yes";
  field(W["api.f-skills"]).value = "[]";
  doc.getElementById("confirm-go").click();
  await go4();
  if (error() !== W["api.check-skills"]) fail("an empty skills list is not refused: " + error());
  const release = { id: "release", name: "Release", description: "Ships a release.", tags: ["release"], examples: [], targets: [node1], turns: "one", approve_within_s: 1800 };
  field(W["api.f-skills"]).value = JSON.stringify([release]);
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/a2a/agents", { org: "acme", agent: { name: "Release Agent", description: "Ships releases.", version: "1.0.0", connector: kBuild, hub: hubId,
    streaming: true, push: false, skills: [release] } });

  // Change: the skills editor holds the skills not dropped; a card change without a new version is refused on the page.
  rowAction(aId, W["api.change"]).click();
  await settle();
  if (title() !== filled(D["api-agent-update"].title, { name: "Acme Build Agent" })) fail("the change agent dialog title: " + title());
  const shown = JSON.parse(field(W["api.f-skills"]).value);
  if (shown.length !== 1 || shown[0].id !== "build-and-test" || "dropped" in shown[0] || field(W["api.f-version"]).value !== "1.0.0") fail("the change agent dialog is not prefilled: " + JSON.stringify(shown));
  field(W["api.f-description"]).value = "Runs build and test tasks for partners.";
  doc.getElementById("confirm-go").click();
  await go4();
  if (error() !== W["api.refusal-card-version"]) fail("a card change without a new version is not refused: " + error());
  field(W["api.f-version"]).value = "1.1.0";
  doc.getElementById("confirm-go").click();
  await confirmCode();
  const kept = { id: skill.id, name: skill.name, description: skill.description, tags: skill.tags, examples: skill.examples, targets: skill.targets, model: skill.model,
    turns: skill.turns, approve_within_s: skill.approve_within_s, idle_close_s: skill.idle_close_s };
  same("POST settings/api/a2a/agents/update", { org: "acme", id: aId, agent: { name: "Acme Build Agent", description: "Runs build and test tasks for partners.", version: "1.1.0",
    connector: kBuild, hub: hubId, provider: { organization: "Acme Robotics", url: https("acme.example") }, streaming: true, push: true, skills: [kept] } });

  // Delete: a reason, at once.
  rowAction(idleId, W["api.delete"]).click();
  await settle();
  if (title() !== filled(D["api-agent-delete"].title, { name: "Idle Agent" })) fail("the delete agent dialog title: " + title());
  doc.getElementById("confirm-fields").querySelector("textarea").value = "Not used";
  doc.getElementById("confirm-go").click();
  await go4();
  plain("POST settings/api/a2a/agents/delete", { org: "acme", id: idleId, reason: "Not used" });

  // Make a card key (step-up) and Drop key (at once).
  find("button", W["api.card-key-new"]).click();
  await settle();
  if (title() !== filled(D["api-a2a-key"].title, { org: "acme" })) fail("the card key dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/a2a/keys", { org: "acme" });
  rowAction("tp-active-1", W["api.card-key-drop"]).click();
  await settle();
  if (title() !== filled(D["api-a2a-key-drop"].title, { kid: "a2a-k1" })) fail("the drop key dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await go4();
  plain("POST settings/api/a2a/keys/drop", { org: "acme", kid: "a2a-k1" });

  // The root well-known card: an agent, then none (null).
  for (const pick of [aId, ""]) {
    find("button", W["api.well-known-set"]).click();
    await settle();
    if (title() !== filled(D["api-well-known"].title, { org: "acme" })) fail("the well-known dialog title: " + title());
    field(W["api.f-well-known"]).value = pick;
    doc.getElementById("confirm-go").click();
    await confirmCode();
    same("POST settings/api/a2a/well-known", { org: "acme", agent: pick || null });
  }

  // The Tasks filter: picking an agent reads the tasks again with it.
  const agentPick = doc.querySelectorAll("label").find((l) => l.textContent === W["api.col-agent"]);
  if (!agentPick) fail("the Tasks list has no agent filter");
  const sel = doc.getElementById(agentPick.getAttribute("for"));
  sel.value = aId;
  sel.dispatchEvent(new FEvent("change"));
  await go4();
  const filtered = calls.filter((x) => x.route === "GET settings/api/a2a/tasks").pop();
  if (!filtered || !filtered.url.endsWith("?org=acme&agent=" + aId)) fail("the agent filter did not reach the tasks read: " + (filtered && filtered.url));

  // The Remote Spokes tab: roots, the org's spokes relays, the candidates and the service hubs; Bind, Unbind, Set root.
  await go("#/security/api?tab=spokes");
  inOrder(view(), [W["api.tab-spokes"], W["api.spokes"], W["api.spokes-help"], W["api.console-root"], rootId, W["api.map-root"], rootId, rootSpki, W["api.root-set"],
    W["api.bound-relays"], "spokes-east", "r_21", "spokes-west", "r_22", W["api.needs-update"], W["api.candidates"], "spokes-north", W["api.hubs"], "build-hub",
    "build-hub@apps.acme.example", node1, hubNode, "0a1b2c", W["api.key-store-pkcs11"], aId], "Remote Spokes tab");
  noDash("Remote Spokes");
  if (offers("spokes-east", W["api.bind"])) fail("Bind is offered on a bound relay");
  rowAction("spokes-north", W["api.bind"]).click();
  await settle();
  if (title() !== filled(D["api-spokes-bind"].title, { relay: "spokes-north", org: "acme" })) fail("the bind dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/spokes/bind", { org: "acme", relay: "r_23" });
  rowAction("spokes-west", W["api.unbind"]).click();
  await settle();
  if (title() !== filled(D["api-spokes-unbind"].title, { relay: "spokes-west", org: "acme" })) fail("the unbind dialog title: " + title());
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/spokes/unbind", { org: "acme", relay: "r_22" });
  find("button", W["api.root-set"]).click();
  await settle();
  if (title() !== filled(D["api-spokes-root"].title, { org: "acme" })) fail("the set root dialog title: " + title());
  if (!doc.getElementById("confirm-body").textContent.includes(rootId)) fail("the set root dialog does not name the console's root");
  doc.getElementById("confirm-go").click();
  await confirmCode();
  same("POST settings/api/spokes/root", { org: "acme" });
  if (calls.some((x) => x.route === "POST settings/api/spokes/relays")) fail("the page posted to the removed settings/api/spokes/relays");
  console.log("api-r6: tabs, partner card check and hand-off, agent and service hub clients, agents, cards, card keys, well-known, tasks and Remote Spokes ok");
}

if (mode === "dom") main().then(() => process.exit(0), (e) => fail(e && e.stack ? e.stack : String(e)));
else if (mode === "api") apiMain(JSON.parse(fs.readFileSync(extra, "utf8"))).then(() => process.exit(0), (e) => fail(e && e.stack ? e.stack : String(e)));
else if (mode === "api-r4") apiR4Main(JSON.parse(fs.readFileSync(extra, "utf8"))).then(() => process.exit(0), (e) => fail(e && e.stack ? e.stack : String(e)));
else if (mode === "api-r5") apiR5Main(JSON.parse(fs.readFileSync(extra, "utf8"))).then(() => process.exit(0), (e) => fail(e && e.stack ? e.stack : String(e)));
else if (mode === "api-r6") apiR6Main(JSON.parse(fs.readFileSync(extra, "utf8"))).then(() => process.exit(0), (e) => fail(e && e.stack ? e.stack : String(e)));
else if (mode === "ai") aiMain().then(() => process.exit(0), (e) => fail(e && e.stack ? e.stack : String(e)));
else if (mode === "fleet") fleetMain(JSON.parse(fs.readFileSync(extra, "utf8"))).then(() => process.exit(0), (e) => fail(e && e.stack ? e.stack : String(e)));
else fail("unknown mode " + mode);
"##;

#[test]
fn placeholder_fragments_split_as_the_vector_says() {
    assert_eq!(fragments("Remove <email>?"), vec!["Remove ", "?"]);
    assert_eq!(fragments("<email> joined from <hub or device> and"), vec![" joined from ", " and"]);
    assert_eq!(fragments("a < b <X>"), vec!["a < b <X>"]);
}
