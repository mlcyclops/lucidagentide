// Contract AC-2b-D section 16.1, slice d-scripts: the four install script bodies (deploy/*.sh, embedded by
// src/deploy_scripts.rs), read as files. Static checks: `bash -n` on each served script, `shellcheck` when present,
// the exact last line, the 13.6 words, no code option, the terminal on every enroll call, the firewall table, the
// coturn ranges and the Docker wrapper. Then a stub host (fake `curl`, `apt-get`, `systemctl`, `nft`, `ss`, `docker`
// and a fake relay program, every file under LUCID_DEPLOY_PREFIX) runs install, rerun, rerun after a failure at the
// firewall step, rerun from another console, a downgrade, uninstall online and offline, and the refusals, and checks
// the files written and the commands called. The stub runs need bash, flock and setsid (util-linux); without them
// those tests print a note and pass, as the Node.js tests of console_assets.rs do.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

const MEET_LINUX: &str = include_str!("../deploy/meet-linux.sh");
const SPOKES_LINUX: &str = include_str!("../deploy/spokes-linux.sh");
const MEET_DOCKER: &str = include_str!("../deploy/meet-docker.sh");
const SPOKES_DOCKER: &str = include_str!("../deploy/spokes-docker.sh");

const BODIES: [(&str, &str); 4] = [("meet-linux", MEET_LINUX), ("spokes-linux", SPOKES_LINUX), ("meet-docker", MEET_DOCKER), ("spokes-docker", SPOKES_DOCKER)];
const LAST_LINE: &str = "{ main \"$@\"; exit $?; }";

/// The 10 header lines of 5.1.
fn header(console: &str, pins: &str, version: &str, arch: &str, sha: &str, profile: &str, enrollment: &str) -> String {
    format!(
        "#!/usr/bin/env bash\n# Lucid relay installer served by a Lucid Admin Console. Read it before you run it.\nLUCID_CONSOLE='{console}'\nLUCID_PINS='{pins}'\nLUCID_VERSION='{version}'\nLUCID_ARCH='{arch}'\nLUCID_SHA256='{sha}'\nLUCID_PROFILE='{profile}'\nLUCID_ENROLLMENT='{enrollment}'\n# The lines below are the same for every console; their SHA-256 is in SHA256SUMS.\n"
    )
}

fn empty_header() -> String {
    header("", "", "", "", "", "", "")
}

fn which(name: &str) -> Option<String> {
    let out = Command::new("sh").arg("-c").arg(format!("command -v {name}")).output().ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !p.is_empty()).then_some(p)
}

// ---- static checks ----

#[test]
fn last_line_is_the_runner_and_main_holds_every_step() {
    for (name, body) in BODIES {
        let last = body.trim_end_matches('\n').lines().last().unwrap();
        assert_eq!(last, LAST_LINE, "{name}");
        assert!(body.ends_with("{ main \"$@\"; exit $?; }\n"), "{name}: one newline after the last line");
        // Outside main only comments and the last line: a cut download runs nothing (L1).
        let lines: Vec<&str> = body.lines().collect();
        let start = lines.iter().position(|l| *l == "main() {").unwrap_or_else(|| panic!("{name}: no main"));
        assert!(lines[..start].iter().all(|l| l.starts_with('#')), "{name}: only comments before main");
        assert_eq!(lines[lines.len() - 2], "}", "{name}: main closes right before the last line");
        assert_eq!(lines.iter().filter(|l| l.starts_with("main()")).count(), 1, "{name}: one function main");
        assert!(body.contains("\tset -euo pipefail\n\tumask 077\n"), "{name}");
        assert!(body.contains("mktemp -d") && body.contains("trap '"), "{name}: temporary folder removed on exit");
        assert!(body.contains("flock -n 9") && body.contains("/run/lucid-relay-deploy.lock"), "{name}: one run at a time");
    }
}

#[test]
fn bash_parses_every_served_script_and_shellcheck_when_present() {
    let Some(bash) = which("bash") else {
        eprintln!("bash not found: skipping bash -n");
        return;
    };
    let shellcheck = which("shellcheck");
    for (name, body) in BODIES {
        for head in [header("https://[2001:db8::1]:8444", "sha256//AAAA=;sha256//BBBB=", "0.2.0", "x86_64", &"a".repeat(64), "standard", "en_0123456789abcdef"), empty_header()] {
            let script = format!("{head}{body}");
            assert_eq!(head.lines().count(), 10);
            let mut child = Command::new(&bash).arg("-n").stdin(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), script.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{name}: bash -n: {}", String::from_utf8_lossy(&out.stderr));
            // A cut download is a syntax error, never a partial run.
            let cut = &script[..script.len() - LAST_LINE.len() - 30];
            let mut child = Command::new(&bash).arg("-n").stdin(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), cut.as_bytes()).unwrap();
            assert!(!child.wait_with_output().unwrap().status.success(), "{name}: a cut body must not parse");
            if let Some(sc) = &shellcheck {
                let mut child = Command::new(sc).args(["-s", "bash", "-S", "warning", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
                std::io::Write::write_all(child.stdin.as_mut().unwrap(), script.as_bytes()).unwrap();
                let out = child.wait_with_output().unwrap();
                assert!(out.status.success(), "{name}: shellcheck: {}", String::from_utf8_lossy(&out.stdout));
            }
        }
    }
    if shellcheck.is_none() {
        eprintln!("shellcheck not found: skipped");
    }
}

#[test]
fn no_long_dashes_and_no_code_option() {
    for (name, body) in BODIES {
        assert!(!body.chars().any(|c| c == '\u{2014}' || c == '\u{2013}'), "{name}: long dash");
        assert!(body.is_ascii(), "{name}: ASCII only");
        for (i, _) in body.match_indices("--code") {
            assert!(body[i..].starts_with("--code-file"), "{name}: a code option at byte {i}");
        }
        assert!(!body.contains("LUCID_CODE"), "{name}: the code is never in the environment");
    }
}

#[test]
fn every_enroll_call_reads_from_the_terminal() {
    for (name, body) in BODIES {
        let calls: Vec<&str> = body.lines().filter(|l| l.contains("\"${eargs[@]}\"")).collect();
        assert!(!calls.is_empty(), "{name}");
        let mut tty = 0;
        for l in &calls {
            assert!(l.contains("</dev/tty") || l.contains("</dev/null"), "{name}: {l}");
            if l.contains("</dev/tty") {
                assert!(l.contains(">/dev/tty 2>&1"), "{name}: {l}");
                tty += 1;
            }
        }
        assert!(tty >= 1, "{name}: an enroll call on /dev/tty");
        // The /dev/null form runs only with --code-file and no terminal.
        assert!(body.contains("tty_ok() { (: </dev/tty) 2>/dev/null; }"), "{name}");
    }
}

#[test]
fn script_words_of_13_6() {
    let all = BODIES.iter().map(|(_, b)| *b).collect::<Vec<_>>().join("\n");
    let words = [
        "Usage: install (the default) or uninstall [--purge]. Options: --profile high or standard, --admins <emails>, --host <name>, --turn-host <name>, --clients <CIDRs>, --pki-dir <folder>, --ca <file>, --root <file>, --code-file <path>, --external-ip <public>[/<private>], --allow-peer <CIDR>, --ssh-from <CIDR>, --no-firewall, --firewall-force, --binary <path>, --console <url>, --pins <pins>.",
        "Run this as root (sudo).",
        "This installer supports Debian 12 or 13 and Ubuntu 22.04 or 24.04. This host is ",
        "This installer needs systemd.",
        "This console hands out the relay program for $arch; this host is $host_arch.",
        "No terminal to read the enrollment code from. Run the command in an interactive shell, or pass --code-file <path> (owned by root, mode 600) and --admins.",
        "At least 2 GB must be free under /opt and /var/lib.",
        "Port $port is already in use by $proc. Free it and run the command again.",
        "This host already runs a relay that was installed by hand. Use Already installed in the Admin Console to join it.",
        "Is this a government deployment? A yes uses the High security profile, which cannot be changed later. (yes or no) [yes]: ",
        "The CA file must be a self-signed P-256 CA certificate (ca.crt), never its key.",
        "This console serves Standard relays only. Install a High relay from your release media.",
        "The downloaded relay program does not match SHA-256 $sha. Nothing was installed.",
        "Relay program SHA-256: $got. It must match your release notes.",
        "The relay program does not run on this host: $why",
        "Pass --binary <path> with the verified lucid-relay from your release media.",
        "The folder must hold ca.crt, relay.crt and a matching relay.key, and relay.crt must come from ca.crt.",
        "Organization CA on this host: ",
        "The root file must be a P-256 public key (root.pub), never the private key.",
        "Organization root on this host: ",
        "Pass --root <file> with your organization root's public key.",
        "This host already has a firewall ($fw_kind_now). Open these ports in it: $PORT_WORDS.",
        "Other services listen on this host: $others. The firewall would close them. Run again with --firewall-force to close them, or --no-firewall and open $PORT_WORDS yourself.",
        "Firewall: SSH ($sshp) from $from; relay ports $PORT_WORDS; everything else closed. Local connections to this host's own public or LAN addresses follow the same rules; use 127.0.0.1 for other local services.",
        "No SSH service found; the firewall allows no SSH.",
        "The firewall on this host changed while installing, so no firewall table was written. Resolve it and run the command again; if the enrollment code was already used, make a new one in the Admin Console.",
        "This installer did not write a firewall here, so TURN may not relay to this host's own addresses. Calls between two people who both need TURN fail until you open UDP 49160 to 49260 toward ",
        " in your firewall and run again with --allow-peer for those addresses.",
        "Another run of this installer is in progress. Wait for it to finish.",
        "Install Docker Engine and its Compose plugin first.",
        "Docker is not offered under the High profile.",
        "Starting the relay and joining the console...",
        "The relay did not join within 2 minutes. Last log lines:",
        "This relay already belongs to this Admin Console. Updated the program to ",
        " and restarted it.",
        "This relay belongs to another Admin Console (${url:-unknown}). Nothing was changed.",
        "This host runs version $inst, newer than $version. Nothing was changed.",
        "Done. Relay https://$d_host on TCP 443; TURN $d_turn on UDP and TCP 3478, TCP 5349 and UDP 49160 to 49260.",
        "Done. Relay https://$d_host:8443. Add this entry to your hubs' relay directory:",
        "The relay left the Admin Console.",
        "The console was not reached; the relay removed its link here. Remove it in the Admin Console too.",
        "Removed the relay program and its services. Kept ",
        "; add --purge to delete them.",
        "This host was installed with the ",
        " profile. Uninstall with --purge to change it.",
    ];
    for w in words {
        assert!(all.contains(w), "missing words: {w}");
    }
    // The government question defaults to yes, meaning High (2.6).
    assert!(MEET_LINUX.contains("\"\" | yes | y | Yes | YES) profile=high") && SPOKES_LINUX.contains("\"\" | yes | y | Yes | YES) profile=high"));
}

#[test]
fn firewall_table_rules() {
    for (name, body) in [("meet-linux", MEET_LINUX), ("spokes-linux", SPOKES_LINUX)] {
        let lo: Vec<&str> = body.lines().map(str::trim).filter(|l| l.starts_with("iif lo")).collect();
        assert_eq!(lo, ["iif lo ip daddr 127.0.0.0/8 accept", "iif lo ip6 daddr ::1 accept"], "{name}: loopback narrowed (R3-H1)");
        assert!(body.contains("\t\tmeta pkttype broadcast udp sport 67 udp dport 68 accept\n"), "{name}: R3-L1");
        assert!(!body.lines().any(|l| l.contains("udp dport 68") && !l.contains("meta pkttype broadcast")), "{name}");
        assert!(body.contains("ip6 saddr fe80::/10 udp sport 547 udp dport 546 accept"), "{name}");
        assert!(body.contains("nd-router-advert") && body.contains("packet-too-big") && body.contains("nd-neighbor-solicit"), "{name}");
        assert!(body.contains("type filter hook input priority 0; policy drop;"), "{name}");
        assert!(body.contains("table inet lucid_relay\ndelete table inet lucid_relay\n"), "{name}: reload replaces only our table");
        assert!(!body.contains("flush ruleset") && !body.contains("/etc/nftables.conf\n"), "{name}");
        for l in ["After=nftables.service", "PartOf=nftables.service", "WantedBy=multi-user.target nftables.service", "RemainAfterExit=yes", "ExecStart=/usr/sbin/nft -f /etc/lucid-relay-firewall.nft", "ExecStop=-/usr/sbin/nft delete table inet lucid_relay"] {
            assert!(body.contains(l), "{name}: {l}");
        }
        assert!(body.contains("nft -c -f"), "{name}");
        for t in ["iptables-save", "ip6tables-save", "iptables-legacy-save", "ip6tables-legacy-save"] {
            assert!(body.contains(t), "{name}: {t}");
        }
        assert!(body.contains("systemctl show -p Listen --value ssh.socket") && body.contains("$4 == \"sshd\""), "{name}: SSH from sshd and ssh.socket");
        assert!(body.contains("RestartPreventExitStatus=78"), "{name}");
    }
    assert!(MEET_LINUX.contains("udp dport 49160-49260 accept") && MEET_LINUX.contains("tcp dport { 443, 3478, 5349 } accept"));
    assert!(SPOKES_LINUX.contains("tcp dport 8443 accept") && !SPOKES_LINUX.contains("49160"));
}

const DENIED: [&str; 15] = [
    "0.0.0.0-0.255.255.255",
    "10.0.0.0-10.255.255.255",
    "100.64.0.0-100.127.255.255",
    "127.0.0.0-127.255.255.255",
    "169.254.0.0-169.254.255.255",
    "172.16.0.0-172.31.255.255",
    "192.0.0.0-192.0.0.255",
    "192.168.0.0-192.168.255.255",
    "198.18.0.0-198.19.255.255",
    "224.0.0.0-255.255.255.255",
    "::1",
    "::ffff:0.0.0.0-::ffff:255.255.255.255",
    "64:ff9b::-64:ff9b::ffff:ffff",
    "fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
];

#[test]
fn coturn_template_and_docker_wrapper() {
    for (name, body) in [("meet-linux", MEET_LINUX), ("meet-docker", MEET_DOCKER)] {
        for r in DENIED {
            assert!(body.split(|c: char| c.is_whitespace() || c == ';').any(|t| t == r), "{name}: denied range {r}");
        }
        assert!(body.contains("no-loopback-peers") && body.contains("no-multicast-peers") && body.contains("use-auth-secret"), "{name}");
    }
    assert!(MEET_LINUX.contains("cert=$3\npkey=$4\n") && MEET_LINUX.contains("/etc/coturn/lucid/turn.crt /etc/coturn/lucid/turn.key"));
    assert!(MEET_DOCKER.contains("cert=$STATE/pki/current/relay.crt\npkey=$STATE/pki/current/relay.key\n"));
    assert!(MEET_DOCKER.contains("say \"denied-peer-ip=$a\"") && !MEET_DOCKER.contains("allowed-peer-ip=$a"), "Docker denies the host's own addresses");
    for l in ["PathChanged=/var/lib/lucid-meet/pki/current", "PathModified=/var/lib/lucid-meet/pki", "systemctl try-restart coturn"] {
        assert!(MEET_LINUX.contains(l), "{l}");
    }
    for (name, body) in [("meet-docker", MEET_DOCKER), ("spokes-docker", SPOKES_DOCKER)] {
        assert!(body.contains("    init: true\n    restart: unless-stopped\n    read_only: true\n"), "{name}");
        assert!(body.contains("trap 'if [ -n \"$child\" ]; then kill -TERM \"$child\" 2>/dev/null; fi' TERM INT"), "{name}: TERM reaches the relay");
        assert!(body.contains("if [ \"$rc\" -eq 78 ]; then") && body.contains("\tsleep infinity &\n\tchild=$!\n\twait \"$child\"\n"), "{name}: exit 78 is a waited sleep");
        assert!(body.contains("FROM debian:13-slim@$DEBIAN_DIGEST") && body.contains("USER 10001"), "{name}");
        assert!(body.contains("COPY lucid-deploy /usr/local/lib/lucid-deploy") && body.contains("chmod 0444 /usr/local/lib/lucid-deploy"), "{name}");
        assert!(body.contains("docker image rm -f \"$run_image\""), "{name}: the enroll image is removed");
        // The runtime Dockerfile never holds a marker.
        let runtime = body.split("cat >\"$ctx/Dockerfile\" <<EOF").nth(1).unwrap().split("\nEOF\n").next().unwrap();
        assert!(!runtime.contains("lucid-deploy"), "{name}");
        assert!(body.contains("die \"Docker is not offered under the High profile.\""), "{name}");
    }
    assert!(MEET_DOCKER.contains("    network_mode: host\n") && MEET_DOCKER.contains("entrypoint: [\"/usr/local/bin/lucid-turn\"]"));
    assert!(MEET_DOCKER.contains("trap 'stop=1; for p in $child $pause; do kill -TERM \"$p\" 2>/dev/null; done' TERM INT"));
}

// ---- the stub host ----

static N: AtomicUsize = AtomicUsize::new(0);

const FAKE_RELAY: &str = r##"#!/bin/bash
P="${LUCID_DEPLOY_PREFIX:-}"
echo "prog $*" >>"$STUB_LOG"
case "$1" in
--version) echo "lucid-relay $(cat "$STUB_DIR/version" 2>/dev/null || echo 0.2.0)"; exit 0 ;;
console) exit 0 ;;
esac
if [ "$1" = meet ]; then shift; state="$P/var/lib/lucid-meet"; else state="$P/var/lib/lucid-relay"; fi
case "$1 $2" in
"fleet status") echo "Relay fingerprint: 0a1b 2c3d 4e5f"; exit 0 ;;
"fleet leave") rm -f "$state/fleet.json"; [ -f "$STUB_DIR/leave-offline" ] && exit 1; exit 0 ;;
esac
if [ "$1" = enroll ]; then
	if [ -t 0 ]; then echo "enroll-stdin=tty" >>"$STUB_LOG"; fi
	m=none
	for f in "$P/opt/lucid-meet/.lucid-deploy" "$P/opt/lucid-relay/.lucid-deploy"; do
		if [ -f "$f" ]; then m="$(stat -c %a "$f") $(cat "$f")"; rm -f "$f"; fi
	done
	echo "marker=$m" >>"$STUB_LOG"
	prev=""
	for a in "$@"; do
		if [ "$prev" = --code-file ]; then rm -f "$a"; fi
		prev=$a
	done
	[ -f "$STUB_DIR/enroll-fail" ] && exit 1
	mkdir -p "$state"
	printf '{"v": 1, "fleetUrl": "%s"}\n' "$2" >"$state/fleet.json"
	printf 'HOST=relay.example.org\nTURN_HOST=turn.example.org\nCLIENTS=198.51.100.0/24\nPKI=console\n' >"$P/run/lucid-relay-deploy.env"
	exit 0
fi
exit 0
"##;

struct Host {
    root: PathBuf,
    stubs: PathBuf,
    dir: PathBuf,
    log: PathBuf,
    bash: String,
    setsid: String,
    path: String,
    prog_sha: String,
}

impl Host {
    /// A stub host, or None (with a note) when bash, flock or setsid is missing.
    fn new(nft: bool) -> Option<Host> {
        if !cfg!(unix) {
            return None;
        }
        let (Some(bash), Some(setsid), Some(_), Some(real_stat), Some(sha256sum)) = (which("bash"), which("setsid"), which("flock"), which("stat"), which("sha256sum")) else {
            eprintln!("bash, setsid, flock, stat or sha256sum not found: skipping the stub host");
            return None;
        };
        let base = std::env::temp_dir().join(format!("lucid-deploy-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let stubs = base.join("bin");
        let dir = base.join("stub");
        for d in ["etc/default", "etc/systemd/system", "run/systemd/system", "opt", "var/lib", "usr/sbin"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::create_dir_all(&stubs).unwrap();
        std::fs::create_dir_all(dir.join("vol")).unwrap();
        std::fs::write(root.join("etc/os-release"), "ID=debian\nVERSION_ID=\"13\"\n").unwrap();
        std::fs::write(root.join("etc/default/coturn"), "#TURNSERVER_ENABLED=1\n").unwrap();
        let log = dir.join("log");
        std::fs::write(&log, "").unwrap();
        let s = |name: &str, body: &str| {
            let p = stubs.join(name);
            std::fs::write(&p, format!("#!/bin/bash\necho \"{name} $*\" >>\"$STUB_LOG\"\n{body}\n")).unwrap();
            chmod_x(&p);
        };
        s("id", "echo 0");
        s("uname", "echo x86_64");
        for n in ["chown", "useradd", "userdel", "apt-get", "journalctl"] {
            s(n, "exit 0");
        }
        s("getent", "exit 2");
        s("systemd-detect-virt", "echo none");
        s("df", "echo 'Filesystem 1024-blocks Used Available Capacity Mounted'; echo 'x 999999999 1 99999999 1% /'");
        s("ss", "cat \"$STUB_DIR/ss.txt\" 2>/dev/null; exit 0");
        s("ip", "echo '2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0'; echo '2: eth0    inet6 2001:db8::5/64 scope global'");
        s(
            "systemctl",
            "case \"$1\" in\nis-active) [[ \"$*\" == *ssh.socket* && -f \"$STUB_DIR/ssh-socket\" ]] && exit 0; exit 3 ;;\nshow) [ -f \"$STUB_DIR/ssh-socket\" ] && echo '[::]:2222 (Stream)'; exit 0 ;;\nis-failed) exit 1 ;;\nesac\nexit 0",
        );
        // Without the stub (R3-L4) the host looks as before `nftables` is installed: see the PATH below.
        if nft {
            s("nft", "if [ \"$1\" = -c ] && [ -f \"$STUB_DIR/nft-fail\" ]; then exit 1; fi\nif [ \"$1\" = list ]; then cat \"$STUB_DIR/nft.txt\" 2>/dev/null; fi\nexit 0");
        }
        s("stat", &format!("out=$({real_stat} \"$@\") || exit $?\necho \"$out\" | sed 's/^[0-9][0-9]* /0 /'"));
        s("curl", "while [ $# -gt 0 ]; do if [ \"$1\" = -o ]; then out=$2; fi; shift; done\ncp \"$STUB_DIR/fake-relay\" \"$out\"");
        s(
            "docker",
            "case \"$1\" in\nversion|build|image) exit 0 ;;\nvolume) [ \"$2\" = inspect ] && exit 1; exit 0 ;;\ncompose) [[ \"$*\" == *fleet\\ status* ]] && { echo 'Relay fingerprint: 0a1b'; exit 0; }; [[ \"$*\" == *exec* ]] && exit 1; exit 0 ;;\nrun)\n  if [[ \"$*\" == *\" test -e \"* ]]; then exit 1; fi\n  if [[ \"$*\" == *\"cat > \"* ]]; then cat >\"$STUB_DIR/vol/$(basename \"${@: -1}\")\"; exit 0; fi\n  if [[ \"$*\" == *deploy.env ]]; then printf 'HOST=relay.example.org\\nTURN_HOST=turn.example.org\\nCLIENTS=\\nPKI=console\\n'; exit 0; fi\n  if [[ \"$*\" == *turn.secret ]]; then echo 00ff; exit 0; fi\n  exit 0 ;;\nesac\nexit 0",
        );
        let fake = dir.join("fake-relay");
        std::fs::write(&fake, FAKE_RELAY).unwrap();
        chmod_x(&fake);
        let out = Command::new(sha256sum).arg(&fake).output().unwrap();
        let prog_sha = String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap().to_owned();
        let mut path = stubs.display().to_string();
        for p in std::env::var("PATH").unwrap_or_default().split(':') {
            // Without the nft stub, hide a real nft so the host looks as before `nftables` is installed.
            if !nft && Path::new(p).join("nft").exists() {
                continue;
            }
            path.push(':');
            path.push_str(p);
        }
        Some(Host { root, stubs, dir, log, bash, setsid, path, prog_sha })
    }

    fn served(&self, console: &str, version: &str) -> String {
        header(console, "sha256//AAAA=", version, "x86_64", &self.prog_sha, "standard", "en_0123456789abcdef")
    }

    /// A root-owned (as `stat` reports it) 0600 code file.
    fn code_file(&self) -> String {
        let p = self.dir.join("code.txt");
        std::fs::write(&p, "LCE1-NOT-A-REAL-CODE\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        p.display().to_string()
    }

    /// Run `header + body` as `curl ... | sudo bash -s -- <args>`, with no terminal. Returns (exit code, output, log of
    /// this run only).
    fn run(&self, head: &str, body: &str, args: &[&str]) -> (i32, String, String) {
        std::fs::write(&self.log, "").unwrap();
        let mut child = Command::new(&self.setsid)
            .arg("-w")
            .arg(&self.bash)
            .args(["-s", "--"])
            .args(args)
            .env("PATH", &self.path)
            .env("LUCID_DEPLOY_PREFIX", &self.root)
            .env("STUB_LOG", &self.log)
            .env("STUB_DIR", &self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), format!("{head}{body}").as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        (out.status.code().unwrap_or(-1), text, std::fs::read_to_string(&self.log).unwrap())
    }

    fn file(&self, p: &str) -> String {
        std::fs::read_to_string(self.root.join(p.trim_start_matches('/'))).unwrap_or_default()
    }
    fn has(&self, p: &str) -> bool {
        self.root.join(p.trim_start_matches('/')).exists()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.stubs.parent().unwrap());
    }
}

fn chmod_x(p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = p;
}

const CONSOLE: &str = "https://console.example.org:8444";

#[test]
fn meet_linux_install_rerun_and_uninstall() {
    let Some(h) = Host::new(true) else { return };
    std::fs::write(h.dir.join("ss.txt"), "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\nudp UNCONN 0 0 0.0.0.0%eth0:68 0.0.0.0:* users:((\"dhclient\",pid=2,fd=6))\n").unwrap();
    std::fs::write(h.dir.join("ssh-socket"), "").unwrap();

    // Install.
    let code = h.code_file();
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &code, "--admins", "a@example.org"]);
    assert_eq!(rc, 0, "{out}\n{log}");
    assert!(out.contains("Done. Relay https://relay.example.org on TCP 443; TURN turn.example.org on UDP and TCP 3478"), "{out}");
    assert!(out.contains("Relay fingerprint: 0a1b 2c3d 4e5f"));
    assert!(out.contains("Firewall: SSH (22,2222) from any address; relay ports TCP 443, UDP and TCP 3478, TCP 5349, UDP 49160 to 49260; everything else closed."), "{out}");
    assert!(log.contains("apt-get -o Dpkg::Options::=--force-confold install -y --no-install-recommends ca-certificates curl nftables coturn openssl"));
    assert!(log.contains(&format!("curl -fsS --proto =https -k --pinnedpubkey sha256//AAAA= -o {}", h.root.join("opt/lucid-meet/lucid-relay.new").display())));
    assert!(log.contains(&format!("{CONSOLE}/fleet/v1/install/lucid-relay?e=en_0123456789abcdef")));
    assert!(log.contains("prog console seal-setup --role relay --service lucid-meet-relay --state /var/lib/lucid-meet"));
    let enroll = log.lines().find(|l| l.contains("prog meet enroll")).unwrap();
    assert!(enroll.contains(&format!("meet enroll {CONSOLE} --config /etc/lucid-meet/relay.json --deploy linux --profile standard --pki console --admins a@example.org --code-file {code}")), "{enroll}");
    assert!(!enroll.contains("--code "), "{enroll}");
    assert!(log.contains(&format!("marker=600 {{\"enrollment\": \"en_0123456789abcdef\", \"sha256\": \"{}\", \"at\": ", h.prog_sha)), "{log}");
    assert!(!h.has("/opt/lucid-meet/.lucid-deploy"), "the marker is gone after the run");
    assert!(!Path::new(&code).exists(), "the program deleted the code file");
    assert_eq!(h.file("/etc/lucid-meet/deployed-by"), "installed\n");
    assert!(!h.has("/etc/lucid-meet/profile.lock"));
    let turn = h.file("/etc/turnserver.conf");
    for r in DENIED {
        assert!(turn.contains(&format!("denied-peer-ip={r}\n")), "{r}");
    }
    assert!(turn.contains("allowed-peer-ip=203.0.113.5\n") && turn.contains("allowed-peer-ip=2001:db8::5\n"), "{turn}");
    assert!(turn.contains("realm=relay.example.org\n") && turn.contains("cert=/etc/coturn/lucid/turn.crt\n"));
    assert_eq!(h.file("/etc/lucid-meet/turn.secret").len(), 64);
    let fw = h.file("/etc/lucid-relay-firewall.nft");
    assert!(fw.contains("\t\ttcp dport { 22,2222 } accept\n") && fw.contains("iif lo ip daddr 127.0.0.0/8 accept"), "{fw}");
    assert!(h.file("/etc/systemd/system/lucid-relay-firewall.service").contains("PartOf=nftables.service"));
    assert!(h.file("/etc/systemd/system/lucid-meet-relay.service").contains("RestartPreventExitStatus=78"));
    assert!(h.file("/etc/default/coturn").contains("TURNSERVER_ENABLED=1"));

    // Rerun from the same console: no new enrollment, secrets kept.
    let secret = h.file("/etc/lucid-meet/turn.secret");
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &h.code_file()]);
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("This relay already belongs to this Admin Console. Updated the program to 0.2.0 and restarted it."), "{out}");
    assert!(!log.contains("prog meet enroll") && !log.contains("curl "), "{log}");
    assert_eq!(h.file("/etc/lucid-meet/turn.secret"), secret);

    // Rerun from another console: nothing changes.
    let (rc, out, log) = h.run(&h.served("https://other.example.org:8444", "0.2.0"), MEET_LINUX, &["--code-file", &h.code_file()]);
    assert_eq!(rc, 1);
    assert!(out.contains(&format!("This relay belongs to another Admin Console ({CONSOLE}). Nothing was changed.")), "{out}");
    assert!(!log.contains("apt-get") && !log.contains("curl "), "{log}");

    // A downgrade: nothing changes.
    std::fs::write(h.dir.join("version"), "0.3.0").unwrap();
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &h.code_file()]);
    assert_eq!(rc, 1);
    assert!(out.contains("This host runs version 0.3.0, newer than 0.2.0. Nothing was changed."), "{out}");
    assert!(!log.contains("apt-get"));
    std::fs::remove_file(h.dir.join("version")).unwrap();

    // Uninstall online, then the files kept and removed.
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["uninstall"]);
    assert_eq!(rc, 0, "{out}");
    assert!(log.contains("prog meet fleet leave --config /etc/lucid-meet/relay.json"));
    assert!(out.contains("The relay left the Admin Console.") && out.contains("Kept /etc/lucid-meet and /var/lib/lucid-meet; add --purge to delete them."), "{out}");
    assert!(!h.has("/opt/lucid-meet/lucid-relay") && !h.has("/etc/lucid-relay-firewall.nft") && !h.has("/etc/turnserver.conf"));
    assert!(h.has("/etc/lucid-meet/turn.secret"));
    assert!(h.file("/etc/default/coturn").contains("TURNSERVER_ENABLED=0"));
}

#[test]
fn meet_linux_offline_uninstall_and_rerun_after_a_firewall_failure() {
    let Some(h) = Host::new(true) else { return };
    // The install stops at the firewall step, after the enrollment.
    std::fs::write(h.dir.join("nft-fail"), "").unwrap();
    let (rc, out, _) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &h.code_file(), "--admins", "a@example.org"]);
    assert_ne!(rc, 0, "{out}");
    assert_eq!(h.file("/etc/lucid-meet/deployed-by"), "installing\n");
    assert!(!h.has("/opt/lucid-meet/.lucid-deploy"));
    // The rerun finishes without a new code.
    std::fs::remove_file(h.dir.join("nft-fail")).unwrap();
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &h.code_file()]);
    assert_eq!(rc, 0, "{out}");
    assert!(!log.contains("prog meet enroll"));
    assert!(out.contains("Updated the program to 0.2.0"), "{out}");
    assert_eq!(h.file("/etc/lucid-meet/deployed-by"), "installed\n");
    // Offline uninstall: the program's own script (empty header), console not reached.
    std::fs::write(h.dir.join("leave-offline"), "").unwrap();
    let (rc, out, _) = h.run(&empty_header(), MEET_LINUX, &["uninstall", "--purge"]);
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("The console was not reached; the relay removed its link here. Remove it in the Admin Console too."), "{out}");
    assert!(!h.has("/etc/lucid-meet") && !h.has("/var/lib/lucid-meet") && !h.has("/opt/lucid-meet"));
}

#[test]
fn meet_linux_refusals_before_any_change() {
    let Some(h) = Host::new(true) else { return };
    // Other listeners stop the run before any change, and the code stays unused.
    std::fs::write(h.dir.join("ss.txt"), "tcp LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:((\"nginx\",pid=9,fd=3))\ntcp LISTEN 0 128 127.0.0.1:5432 0.0.0.0:* users:((\"postgres\",pid=8,fd=3))\n").unwrap();
    let code = h.code_file();
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &code]);
    assert_eq!(rc, 1);
    assert!(out.contains("Other services listen on this host: nginx (tcp 8080). The firewall would close them."), "{out}");
    assert!(!log.contains("apt-get") && !log.contains("curl ") && !log.contains("prog "), "{log}");
    assert!(Path::new(&code).exists() && !h.has("/etc/lucid-meet") && !h.has("/opt/lucid-meet/lucid-relay"));
    // A port in use.
    std::fs::write(h.dir.join("ss.txt"), "tcp LISTEN 0 128 0.0.0.0:443 0.0.0.0:* users:((\"nginx\",pid=9,fd=3))\n").unwrap();
    let (rc, out, _) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &code]);
    assert_eq!(rc, 1);
    assert!(out.contains("Port 443 is already in use by nginx. Free it and run the command again."), "{out}");
    std::fs::remove_file(h.dir.join("ss.txt")).unwrap();
    // No terminal and no code file.
    let (rc, out, _) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &[]);
    assert_eq!(rc, 1);
    assert!(out.contains("No terminal to read the enrollment code from."), "{out}");
    // Unknown arguments, and a code option that does not exist.
    let (rc, out, _) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code", "LCE1-X"]);
    assert_eq!(rc, 1);
    assert!(out.starts_with("Usage: install (the default) or uninstall [--purge]."), "{out}");
    // A served header refuses another profile.
    let (rc, out, _) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--profile", "high", "--code-file", &code]);
    assert_eq!(rc, 1);
    assert!(out.contains("This console serves Standard relays only."), "{out}");
    // A hand-installed relay.
    std::fs::create_dir_all(h.root.join("etc/lucid-meet")).unwrap();
    std::fs::write(h.root.join("etc/lucid-meet/relay.json"), "{}").unwrap();
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &code]);
    assert_eq!(rc, 1);
    assert!(out.contains("This host already runs a relay that was installed by hand."), "{out}");
    assert!(!log.contains("apt-get"));
    // A second concurrent run.
    std::fs::remove_file(h.root.join("etc/lucid-meet/relay.json")).unwrap();
    let lock = h.root.join("run/lucid-relay-deploy.lock");
    let mut holder = Command::new("flock").arg(&lock).args(["sleep", "10"]).spawn().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(500));
    let (rc, out, _) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_LINUX, &["--code-file", &code]);
    let _ = holder.kill();
    let _ = holder.wait();
    assert_eq!(rc, 1);
    assert!(out.contains("Another run of this installer is in progress. Wait for it to finish."), "{out}");
}

#[test]
fn meet_linux_other_firewall_without_nft_denies_self_peers() {
    let Some(h) = Host::new(false) else { return };
    let legacy = h.stubs.join("iptables-legacy-save");
    std::fs::write(&legacy, "#!/bin/bash\necho '*filter'\necho ':INPUT ACCEPT [0:0]'\necho '-A INPUT -p tcp --dport 22 -j ACCEPT'\necho COMMIT\n").unwrap();
    chmod_x(&legacy);
    let (rc, out, log) = h.run(
        &h.served(CONSOLE, "0.2.0"),
        MEET_LINUX,
        &["--code-file", &h.code_file(), "--external-ip", "198.51.100.7/10.0.0.7", "--allow-peer", "10.1.0.0/16", "--allow-peer", "2001:db8:1::/48"],
    );
    assert_eq!(rc, 0, "{out}\n{log}");
    assert!(out.contains("This host already has a firewall (iptables-legacy). Open these ports in it: TCP 443, UDP and TCP 3478, TCP 5349, UDP 49160 to 49260."), "{out}");
    assert!(out.contains("fail until you open UDP 49160 to 49260 toward 203.0.113.5, 2001:db8::5, 198.51.100.7, 10.0.0.7 in your firewall"), "{out}");
    assert!(!h.has("/etc/lucid-relay-firewall.nft"));
    let turn = h.file("/etc/turnserver.conf");
    // The deploy vector's order: no-loopback-peers, the denied ranges, one range per --allow-peer, then the host's
    // own addresses (ip order, then the public and private parts of --external-ip).
    let peers: Vec<&str> = turn.lines().filter(|l| l.contains("-peer") || l.starts_with("no-loopback")).collect();
    let mut want = vec!["no-loopback-peers".to_owned()];
    want.extend(DENIED.iter().map(|r| format!("denied-peer-ip={r}")));
    want.push("allowed-peer-ip=10.1.0.0-10.1.255.255".into());
    want.push("allowed-peer-ip=2001:db8:1::-2001:db8:1:ffff:ffff:ffff:ffff:ffff".into());
    for a in ["203.0.113.5", "2001:db8::5", "198.51.100.7", "10.0.0.7"] {
        want.push(format!("denied-peer-ip={a}"));
    }
    assert_eq!(peers.iter().filter(|l| !l.starts_with("no-multicast")).copied().collect::<Vec<_>>(), want, "{turn}");
    assert!(turn.contains("external-ip=198.51.100.7/10.0.0.7\n"), "{turn}");
}

#[test]
fn high_from_release_media_writes_the_lock_and_only_purge_removes_it() {
    let Some(h) = Host::new(true) else { return };
    let bin = h.dir.join("fake-relay").display().to_string();
    let args = ["--profile", "high", "--binary", &bin, "--console", CONSOLE, "--pins", "sha256//AAAA="];
    let code = h.code_file();
    let mut all: Vec<&str> = args.to_vec();
    all.extend(["--code-file", &code, "--host", "relay.example.org", "--turn-host", "turn.example.org", "--admins", "a@example.org"]);
    let (rc, out, log) = h.run(&empty_header(), MEET_LINUX, &all);
    assert_eq!(rc, 0, "{out}\n{log}");
    assert!(out.contains(&format!("Relay program SHA-256: {}. It must match your release notes.", h.prog_sha)));
    assert!(log.contains("marker=none"), "no marker with an empty header or --binary: {log}");
    assert!(!log.contains("curl "));
    assert_eq!(h.file("/etc/lucid-meet/profile.lock"), "high\n");
    assert!(log.contains("--profile high"));
    // A Standard run on the locked host stops before any change.
    let (rc, out, log) = h.run(&empty_header(), MEET_LINUX, &["--profile", "standard", "--binary", &bin, "--console", CONSOLE, "--code-file", &h.code_file()]);
    assert_eq!(rc, 1);
    assert!(out.contains("This host was installed with the high profile. Uninstall with --purge to change it."), "{out}");
    assert!(!log.contains("apt-get"));
    // Uninstall keeps the lock; --purge removes it.
    let (rc, _, _) = h.run(&empty_header(), MEET_LINUX, &["uninstall"]);
    assert_eq!(rc, 0);
    assert!(h.has("/etc/lucid-meet/profile.lock"));
    let (rc, _, _) = h.run(&empty_header(), MEET_LINUX, &["uninstall", "--purge"]);
    assert_eq!(rc, 0);
    assert!(!h.has("/etc/lucid-meet/profile.lock"));
    // An empty header without --binary.
    let (rc, out, _) = h.run(&empty_header(), MEET_LINUX, &["--profile", "high", "--code-file", &h.code_file()]);
    assert_eq!(rc, 1);
    assert!(out.contains("Pass --binary <path> with the verified lucid-relay from your release media."), "{out}");
}

#[test]
fn spokes_linux_install_and_firewall() {
    let Some(h) = Host::new(true) else { return };
    if which("openssl").is_none() {
        eprintln!("openssl not found: skipping the Remote Spokes stub run");
        return;
    }
    std::fs::write(h.dir.join("ss.txt"), "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\n").unwrap();
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), SPOKES_LINUX, &["--code-file", &h.code_file(), "--ssh-from", "192.0.2.0/24"]);
    assert_eq!(rc, 0, "{out}\n{log}");
    let enroll = log.lines().find(|l| l.starts_with("prog enroll")).unwrap();
    assert!(enroll.contains(&format!("prog enroll {CONSOLE} --state /var/lib/lucid-relay --deploy linux --profile standard --code-file")), "{enroll}");
    assert!(log.contains("marker=600 "), "{log}");
    assert!(!h.has("/opt/lucid-relay/.lucid-deploy"));
    assert!(out.contains("Done. Relay https://relay.example.org:8443. Add this entry to your hubs' relay directory:"), "{out}");
    let fw = h.file("/etc/lucid-relay-firewall.nft");
    assert!(fw.contains("ip saddr 192.0.2.0/24 tcp dport { 22 } accept") && fw.contains("ip saddr { 198.51.100.0/24 } tcp dport 8443 accept"), "{fw}");
    let unit = h.file("/etc/systemd/system/lucid-relay.service");
    assert!(unit.contains("--console-profile standard") && unit.contains("RestartPreventExitStatus=78"));
    assert!(h.has("/etc/lucid-relay/tls/relay.key"));
    assert!(!log.contains("coturn"));
}

#[test]
fn docker_install_marker_only_in_the_enroll_image() {
    let Some(h) = Host::new(true) else { return };
    let body = MEET_DOCKER.replace("@DEBIAN_DIGEST@", &format!("sha256:{}", "0".repeat(64)));
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), &body, &["--code-file", &h.code_file()]);
    assert_eq!(rc, 0, "{out}\n{log}");
    assert!(log.contains("docker build -t lucid-relay-local:0.2.0 "), "{log}");
    assert!(log.contains("docker build -t lucid-relay-local:0.2.0-enroll "), "{log}");
    assert!(log.contains("docker image rm -f lucid-relay-local:0.2.0-enroll"), "{log}");
    let enroll = log.lines().find(|l| l.starts_with("docker run") && l.contains("meet enroll")).unwrap();
    assert!(enroll.contains("lucid-relay-local:0.2.0-enroll lucid-relay meet enroll") && enroll.contains("--deploy docker --profile standard --pki console") && enroll.contains("--code-file /run/code/code"), "{enroll}");
    let d = "/opt/lucid-relay-docker/meet";
    let compose = h.file(&format!("{d}/compose.yaml"));
    assert!(compose.contains("    init: true\n") && compose.contains("\"443:443\"") && compose.contains("network_mode: host"), "{compose}");
    assert!(!h.file(&format!("{d}/Dockerfile")).contains("lucid-deploy"));
    assert!(h.file(&format!("{d}/lucid-relay-run")).contains("kill -TERM"));
    let turn = std::fs::read_to_string(h.dir.join("vol/turnserver.conf")).unwrap();
    assert!(turn.contains("denied-peer-ip=203.0.113.5\n") && !turn.contains("allowed-peer-ip=203.0.113.5"), "{turn}");
    assert!(out.contains("This installer did not write a firewall here"), "{out}");
    // --binary: no marker image.
    let bin = h.dir.join("fake-relay").display().to_string();
    std::fs::remove_file(h.root.join("opt/lucid-relay-docker/meet/deployed-by")).unwrap();
    let (rc, out, log) = h.run(&h.served(CONSOLE, "0.2.0"), &body, &["--binary", &bin, "--code-file", &h.code_file()]);
    assert_eq!(rc, 0, "{out}");
    assert!(!log.contains("-enroll"), "{log}");
    // Empty header: refused.
    let (rc, out, _) = h.run(&empty_header(), &body, &["--code-file", &h.code_file()]);
    assert_eq!(rc, 1);
    assert!(out.contains("Docker is not offered under the High profile."), "{out}");
    // The placeholder digest refuses to run.
    let (rc, _, log) = h.run(&h.served(CONSOLE, "0.2.0"), MEET_DOCKER, &["--code-file", &h.code_file()]);
    assert_eq!(rc, 1);
    assert!(!log.contains("docker build"));
}
