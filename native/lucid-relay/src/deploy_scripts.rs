// Contract AC-2b-D section 5, slice d-scripts: the four install script bodies, embedded in the program as assets
// (identical bytes for every console of one version; their SHA-256 is in SHA256SUMS), and the 10-line header the
// console serves before a body (5.1). The management port (4.1) serves `header(..) + body`; `deploy script <name>`
// prints `empty_header()` and then the body, which is also the offline uninstall path (5.8).

const MEET_LINUX: &str = include_str!("../deploy/meet-linux.sh");
const SPOKES_LINUX: &str = include_str!("../deploy/spokes-linux.sh");
const MEET_DOCKER: &str = include_str!("../deploy/meet-docker.sh");
const SPOKES_DOCKER: &str = include_str!("../deploy/spokes-docker.sh");

/// The script names, without `.sh`, in the order of 5.1.
pub const NAMES: [&str; 4] = ["meet-linux", "spokes-linux", "meet-docker", "spokes-docker"];

/// Lines in a served header (5.1).
pub const HEADER_LINES: usize = 10;

/// The body for a product (`meet` or `spokes`) and an environment (`linux` or `docker`).
pub fn body(product: &str, env: &str) -> Option<&'static str> {
    match (product, env) {
        ("meet", "linux") => Some(MEET_LINUX),
        ("spokes", "linux") => Some(SPOKES_LINUX),
        ("meet", "docker") => Some(MEET_DOCKER),
        ("spokes", "docker") => Some(SPOKES_DOCKER),
        _ => None,
    }
}

/// The body by script name, with or without `.sh` (`meet-linux`, `spokes-docker.sh`, ...).
pub fn by_name(name: &str) -> Option<&'static str> {
    let name = name.strip_suffix(".sh").unwrap_or(name);
    let (product, env) = name.split_once('-')?;
    body(product, env)
}

/// The values a served header carries. `console` is the whole `https://<console>:<port>` (an IPv6 literal in
/// brackets); `sha256` the program's 64 hex; `enrollment` the enrollment id or empty.
#[derive(Clone, Copy, Debug, Default)]
pub struct Header<'a> {
    pub console: &'a str,
    pub pins: &'a str,
    pub version: &'a str,
    pub arch: &'a str,
    pub sha256: &'a str,
    pub profile: &'a str,
    pub enrollment: &'a str,
}

/// 5.1: every interpolated value matches `^[A-Za-z0-9._:/+=;\[\]-]*$`.
pub fn safe_value(v: &str) -> bool {
    v.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:/+=;[]-".contains(&b))
}

/// The 10 header lines (each ending in a newline), or None when a value is not safe to put between single quotes
/// (the console then refuses to serve, `deploy-unavailable`).
pub fn header(h: &Header) -> Option<String> {
    let values = [h.console, h.pins, h.version, h.arch, h.sha256, h.profile, h.enrollment];
    if !values.iter().all(|v| safe_value(v)) {
        return None;
    }
    Some(format!(
        "#!/usr/bin/env bash\n\
         # Lucid relay installer served by a Lucid Admin Console. Read it before you run it.\n\
         LUCID_CONSOLE='{}'\n\
         LUCID_PINS='{}'\n\
         LUCID_VERSION='{}'\n\
         LUCID_ARCH='{}'\n\
         LUCID_SHA256='{}'\n\
         LUCID_PROFILE='{}'\n\
         LUCID_ENROLLMENT='{}'\n\
         # The lines below are the same for every console; their SHA-256 is in SHA256SUMS.\n",
        h.console, h.pins, h.version, h.arch, h.sha256, h.profile, h.enrollment
    ))
}

/// The header with every value empty, as `deploy script <name>` prints it (release media and offline uninstall).
pub fn empty_header() -> String {
    header(&Header::default()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_shape_and_refusals() {
        let h = Header {
            console: "https://[2001:db8::1]:8444",
            pins: "sha256//abc+/=;sha256//def=",
            version: "0.1.0",
            arch: "x86_64",
            sha256: &"a".repeat(64),
            profile: "standard",
            enrollment: "en_0123456789abcdef",
        };
        let text = header(&h).unwrap();
        assert_eq!(text.lines().count(), HEADER_LINES);
        assert!(text.ends_with("SHA256SUMS.\n"));
        assert_eq!(empty_header().lines().count(), HEADER_LINES);
        for bad in ["a'b", "a b", "$(x)", "a\nb", "`x`", "a\"b", "a\\b"] {
            assert!(header(&Header { pins: bad, ..h }).is_none(), "{bad}");
        }
        for name in NAMES {
            assert!(by_name(name).is_some() && by_name(&format!("{name}.sh")).is_some());
        }
        assert!(by_name("meet-windows").is_none() && body("spokes", "proxmox").is_none());
    }
}
