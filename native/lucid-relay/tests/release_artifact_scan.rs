// The release artifact scan (contract AC-1 2.4 "No test clock in a deployable build", R3-M10, R4-H1, decision 48;
// G-AC-MEET): a shipped binary carries no test clock and no development-license path. It fails when a release
// binary contains the live check's variable name or feature marker, either development-license variable name, or
// the `dev-license` marker.
//
// It scans every `lucid-relay` binary under target/release (or the folder in LUCID_RELEASE_ARTIFACTS, where release
// CI puts the signed binaries). The live check binary is never a release artifact: its presence there fails too.

use std::path::{Path, PathBuf};

/// The forbidden strings, split so this test's own binary does not carry them whole.
fn forbidden() -> Vec<String> {
    [["LUCID_LIVE_CHECK_", "SEAT_DAY_SECONDS"], ["lucid-live-", "check-clock"], ["LUCID_LICENSE_", "DEV"], ["LUCID_LICENSE_", "DEV_PUB"], ["lucid-dev-", "license"]].iter().map(|p| p.concat()).collect()
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

/// The words found in `data`.
fn found(data: &[u8]) -> Vec<String> {
    forbidden().into_iter().filter(|w| contains(data, w.as_bytes())).collect()
}

fn artifacts(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .filter(|p| p.file_stem().and_then(|s| s.to_str()).is_some_and(|s| s.starts_with("lucid-relay")))
        .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), None | Some("exe")))
        .collect()
}

#[test]
fn the_scan_finds_each_forbidden_string() {
    for w in forbidden() {
        let mut blob = b"\0\x7fELF padding ".to_vec();
        blob.extend_from_slice(w.as_bytes());
        blob.extend_from_slice(b" trailing");
        assert!(found(&blob).contains(&w), "{w}");
    }
    assert!(found(b"an ordinary relay binary").is_empty());
}

#[test]
fn release_binaries_carry_no_test_clock_and_no_development_license_path() {
    let dir = std::env::var_os("LUCID_RELEASE_ARTIFACTS").map(PathBuf::from).unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("release"));
    let bins = artifacts(&dir);
    if bins.is_empty() {
        eprintln!("release_artifact_scan: no release binaries under {}; build with `cargo build --release` to scan", dir.display());
        return;
    }
    for bin in bins {
        let name = bin.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        assert_ne!(name, "lucid-relay-seatclock-check", "the live check binary is never a release artifact: {}", bin.display());
        let data = std::fs::read(&bin).unwrap_or_else(|e| panic!("{}: {e}", bin.display()));
        let bad = found(&data);
        assert!(bad.is_empty(), "{} contains {bad:?}", bin.display());
    }
}

/// A `--release` build with `live-check-clock` must not compile (decision 48). Slow (a full release build): run with
/// `cargo test --test release_artifact_scan -- --ignored`.
#[test]
#[ignore]
fn a_release_build_with_the_live_check_clock_does_not_compile() {
    let target = std::env::temp_dir().join("lucid-relay-scan-target");
    let status = std::process::Command::new(env!("CARGO"))
        .args(["build", "--release", "--features", "live-check-clock", "--bin", "lucid-relay-seatclock-check", "--target-dir"])
        .arg(&target)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .expect("cargo runs");
    assert!(!status.success(), "a release build with live-check-clock compiled");
}
