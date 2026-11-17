// The seat request address release check (contract AC-1 2.4 "Issuing", 13 customer release gate, R41-2, R6-M3,
// decision 61). The relay compiles `LUCID_LICENSE_REQUEST_TO` in as the default seat request address; until the
// publisher's address is decided the default is the internal test address.
//
// A customer release build passes only when the address equals, exactly, the nonempty approved publisher mailbox in
// `release/approved-publisher-mailbox.txt` (changed only by the owner, empty today, so every customer release build
// fails until it is set), and that mailbox is one the console's strict mailbox parser accepts (3.11, R3-M8). Every
// other value fails: the test address, empty, malformed, any other mailbox. The test address is allowed only for an
// internal build whose target is on `release/internal-builds.txt`.
//
// Release CI runs this test for every customer and internal build, with the build's own environment:
// LUCID_LICENSE_REQUEST_TO (as compiled into the relay), LUCID_RELEASE_BUILD (`customer` or `internal`) and, for an
// internal build, LUCID_RELEASE_TARGET (the target's name). Without LUCID_RELEASE_BUILD (a developer's `cargo test`)
// only the rule's own cases run.

use std::path::Path;

/// The internal test address (R41-2, decision 57).
const TEST_ADDRESS: &str = "enrique.mertins@gmail.com";

/// The address the relay compiles in: LUCID_LICENSE_REQUEST_TO at build time, else the test address
/// (`console_settings::LICENSE_REQUEST_TO`).
const COMPILED: &str = match option_env!("LUCID_LICENSE_REQUEST_TO") {
    Some(v) => v,
    None => TEST_ADDRESS,
};

enum Build<'a> {
    Customer,
    Internal(&'a str),
}

fn atext(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~".contains(&b)
}

fn label_ok(l: &str) -> bool {
    let b = l.as_bytes();
    !b.is_empty() && b.len() <= 63 && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-') && b[0] != b'-' && b[b.len() - 1] != b'-'
}

/// The rules of `console_mail::parse_mailbox` (3.11, R3-M8), unchanged: an ASCII dot-atom local part of at most 64
/// bytes, "@", a domain of at least 2 LDH labels of at most 253 bytes, at most 254 bytes in all. The relay is a binary
/// crate, so its parser cannot be called from here; `console_settings`'s unit test checks the approved file with the
/// parser itself.
fn mailbox_ok(s: &str) -> bool {
    if s.is_empty() || s.len() > 254 || !s.is_ascii() {
        return false;
    }
    let Some((local, domain)) = s.split_once('@') else { return false };
    let local_ok = !local.is_empty() && local.len() <= 64 && local.split('.').all(|atom| !atom.is_empty() && atom.bytes().all(atext));
    local_ok && domain.len() <= 253 && domain.split('.').count() >= 2 && domain.split('.').all(label_ok)
}

/// A release file's text: one trailing line break dropped, nothing else.
fn file_text(raw: &str) -> &str {
    raw.strip_suffix("\r\n").or_else(|| raw.strip_suffix('\n')).unwrap_or(raw)
}

/// The targets of `internal-builds.txt`: one per line, `#` comments and blank lines skipped.
fn targets(raw: &str) -> Vec<String> {
    raw.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(str::to_owned).collect()
}

/// The release rule for `value` in `build`, given the approved publisher mailbox and the internal targets.
fn check(value: &str, approved: &str, internal: &[String], build: &Build) -> Result<(), String> {
    if let Build::Internal(target) = build {
        if value == TEST_ADDRESS {
            return if internal.iter().any(|t| t == target) { Ok(()) } else { Err(format!("the internal test address is allowed only for the targets in internal-builds.txt, not {target}")) };
        }
    }
    if approved.is_empty() {
        return Err("approved-publisher-mailbox.txt is empty: the owner has not set the publisher's address, so no customer build passes".into());
    }
    if !mailbox_ok(approved) {
        return Err(format!("approved-publisher-mailbox.txt does not hold a mailbox the console accepts: {approved:?}"));
    }
    if value != approved {
        return Err(format!("LUCID_LICENSE_REQUEST_TO is {value:?}, not the approved publisher mailbox"));
    }
    Ok(())
}

fn release_file(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("release").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn a_customer_build_passes_only_with_the_approved_publisher_mailbox() {
    let approved = "seats@publisher.example";
    let none: Vec<String> = Vec::new();
    for bad in [TEST_ADDRESS, "", "seats@publisher.example\nBcc: x@evil.example", "seats\n@publisher.example", "seats.publisher.example", "Publisher <seats@publisher.example>", "other@publisher.example", "seats@publisher.example ", "SEATS@publisher.example"] {
        assert!(check(bad, approved, &none, &Build::Customer).is_err(), "{bad:?}");
    }
    assert_eq!(check(approved, approved, &none, &Build::Customer), Ok(()));
    // An empty approved file fails every customer build, whatever the address.
    for value in [TEST_ADDRESS, approved, ""] {
        assert!(check(value, "", &none, &Build::Customer).is_err(), "{value:?}");
    }
    // A malformed approved file never passes, even when the build carries the same text.
    for bad in ["Publisher <seats@publisher.example>", "seats@localhost", "seats@publisher.example\n"] {
        assert!(check(bad, bad, &none, &Build::Customer).is_err(), "{bad:?}");
    }
}

#[test]
fn the_test_address_passes_only_for_an_internal_target_on_the_list() {
    let internal = targets("# comment\nvm206\n\nvm217\n");
    assert_eq!(internal, vec!["vm206".to_owned(), "vm217".to_owned()]);
    assert_eq!(check(TEST_ADDRESS, "", &internal, &Build::Internal("vm206")), Ok(()));
    assert_eq!(check(TEST_ADDRESS, "", &internal, &Build::Internal("vm217")), Ok(()));
    assert!(check(TEST_ADDRESS, "", &internal, &Build::Internal("vm999")).is_err());
    assert!(check(TEST_ADDRESS, "", &internal, &Build::Internal("")).is_err());
    assert!(check(TEST_ADDRESS, "", &internal, &Build::Customer).is_err());
    // An internal build may also carry the approved publisher mailbox, and nothing else.
    assert_eq!(check("seats@publisher.example", "seats@publisher.example", &internal, &Build::Internal("vm999")), Ok(()));
    assert!(check("other@publisher.example", "seats@publisher.example", &internal, &Build::Internal("vm206")).is_err());
}

#[test]
fn the_release_files_read() {
    let approved = release_file("approved-publisher-mailbox.txt");
    let approved = file_text(&approved);
    assert!(approved.is_empty() || mailbox_ok(approved), "approved-publisher-mailbox.txt: {approved:?}");
    let internal = targets(&release_file("internal-builds.txt"));
    assert!(internal.contains(&"vm206".to_owned()) && internal.contains(&"vm217".to_owned()), "{internal:?}");
}

/// The gate itself: release CI sets LUCID_RELEASE_BUILD for every customer and internal build.
#[test]
fn this_build_carries_an_allowed_seat_request_address() {
    let Ok(kind) = std::env::var("LUCID_RELEASE_BUILD") else {
        eprintln!("release_request_to: LUCID_RELEASE_BUILD is not set; the release gate runs in release CI only");
        return;
    };
    let target = std::env::var("LUCID_RELEASE_TARGET").unwrap_or_default();
    let build = match kind.as_str() {
        "customer" => Build::Customer,
        "internal" => Build::Internal(&target),
        other => panic!("LUCID_RELEASE_BUILD is customer or internal, not {other:?}"),
    };
    let approved = release_file("approved-publisher-mailbox.txt");
    let internal = targets(&release_file("internal-builds.txt"));
    if let Err(why) = check(COMPILED, file_text(&approved), &internal, &build) {
        panic!("the seat request address of this {kind} build is not allowed: {why}");
    }
}
