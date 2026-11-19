# shellcheck shell=bash disable=SC2154,SC2034,SC1090,SC1091
# Lucid relay installer body: Meeting Hub on Debian or Ubuntu (contract AC-2b-D 5.2, 5.6 to 5.9).
# The console serves this body after a 10-line header that sets the LUCID_ variables; the program's
# `deploy script meet-linux` prints the same header with empty values. Every step is inside main and
# the last line runs it, so a cut download runs nothing. The script never reads the enrollment code:
# only the program does, from the terminal or from --code-file.
main() {
	set -euo pipefail
	umask 077

	# LUCID_DEPLOY_PREFIX roots every file the script touches (the stub tests run it in a folder).
	local P="${LUCID_DEPLOY_PREFIX:-}"
	local console="${LUCID_CONSOLE:-}" pins="${LUCID_PINS:-}" version="${LUCID_VERSION:-}"
	local arch="${LUCID_ARCH:-}" sha="${LUCID_SHA256:-}" hprofile="${LUCID_PROFILE:-}" enrollment="${LUCID_ENROLLMENT:-}"
	local served=0
	[ -n "$console" ] && served=1

	local U=lucid-meet OPT=/opt/lucid-meet ETC=/etc/lucid-meet STATE=/var/lib/lucid-meet UNIT=lucid-meet-relay
	local PROG=/opt/lucid-meet/lucid-relay MARKER=/opt/lucid-meet/.lucid-deploy LOCK=/run/lucid-relay-deploy.lock
	local RUN_ENV=/run/lucid-relay-deploy.env FW_FILE=/etc/lucid-relay-firewall.nft
	local RELAY_PORTS="443 3478 5349"
	local PORT_WORDS="TCP 443, UDP and TCP 3478, TCP 5349, UDP 49160 to 49260"
	local W_USAGE="Usage: install (the default) or uninstall [--purge]. Options: --profile high or standard, --admins <emails>, --host <name>, --turn-host <name>, --clients <CIDRs>, --pki-dir <folder>, --ca <file>, --root <file>, --code-file <path>, --external-ip <public>[/<private>], --allow-peer <CIDR>, --ssh-from <CIDR>, --no-firewall, --firewall-force, --binary <path>, --console <url>, --pins <pins>."

	# Globals, so the exit trap still sees them after main returns.
	LUCID_RM_MARKER="" LUCID_TMP=""
	trap 'if [ -n "${LUCID_RM_MARKER:-}" ]; then rm -f "$LUCID_RM_MARKER"; fi; if [ -n "${LUCID_TMP:-}" ]; then rm -rf "$LUCID_TMP"; fi' EXIT

	say() { printf '%s\n' "$*"; }
	die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
	need() { [ "$1" -ge 2 ] || die "$W_USAGE"; }
	local SAFE_RE='^[][A-Za-z0-9._:,/@+=;-]*$'
	safe() { [[ $1 =~ $SAFE_RE ]]; }
	cidr_ok() { [[ $1 =~ ^[0-9A-Fa-f.:]+/[0-9]{1,3}$ ]]; }
	# put <file> <mode> <owner:group>: stdin into a new file, renamed into place.
	put() {
		local f="$P$1" t
		t="$(dirname "$f")/.$(basename "$f").new"
		rm -f "$t"
		cat >"$t"
		chmod "$2" "$t"
		chown "$3" "$t"
		mv -f "$t" "$f"
	}
	have() { command -v "$1" >/dev/null 2>&1; }
	tty_ok() { (: </dev/tty) 2>/dev/null; }

	# ---- arguments (5.1) ----
	local action=install purge=0 profile="" admins="" host="" turn_host="" pki_dir="" ca_file="" code_file=""
	local external="" ssh_from="" no_fw=0 fw_force=0 binary="" opt_console="" opt_pins=""
	local -a allow_peers=()
	while [ $# -gt 0 ]; do
		case "$1" in
		install | uninstall) action=$1; shift ;;
		--purge) purge=1; shift ;;
		--profile) need $#; profile=$2; shift 2 ;;
		--admins) need $#; admins=$2; shift 2 ;;
		--host) need $#; host=$2; shift 2 ;;
		--turn-host) need $#; turn_host=$2; shift 2 ;;
		--pki-dir) need $#; pki_dir=$2; shift 2 ;;
		--ca) need $#; ca_file=$2; shift 2 ;;
		--code-file) need $#; code_file=$2; shift 2 ;;
		--external-ip) need $#; external=$2; shift 2 ;;
		--allow-peer) need $#; cidr_ok "$2" || die "$W_USAGE"; allow_peers+=("$2"); shift 2 ;;
		--ssh-from) need $#; cidr_ok "$2" || die "$W_USAGE"; ssh_from=$2; shift 2 ;;
		--no-firewall) no_fw=1; shift ;;
		--firewall-force) fw_force=1; shift ;;
		--binary) need $#; binary=$2; shift 2 ;;
		--console) need $#; opt_console=$2; shift 2 ;;
		--pins) need $#; opt_pins=$2; shift 2 ;;
		*) die "$W_USAGE" ;;
		esac
	done
	case "$profile" in "" | high | standard) ;; *) die "$W_USAGE" ;; esac
	if [ "$purge" = 1 ] && [ "$action" != uninstall ]; then die "$W_USAGE"; fi
	local v
	for v in "$admins" "$host" "$turn_host" "$opt_console" "$opt_pins"; do safe "$v" || die "$W_USAGE"; done
	if [ -n "$external" ] && ! [[ $external =~ ^[0-9A-Fa-f.:]+(/[0-9A-Fa-f.:]+)?$ ]]; then die "$W_USAGE"; fi

	[ "$(id -u)" = 0 ] || die "Run this as root (sudo)."

	# ---- one run at a time (R3-L5) ----
	exec 9>"$P$LOCK"
	flock -n 9 || die "Another run of this installer is in progress. Wait for it to finish."

	# ---- helpers for listeners and the firewall (5.6) ----
	# listeners: "<proto> <port> <address> <process>" per listening socket.
	listeners() {
		{ ss -Hltnup 2>/dev/null || true; } | awk '{
			proto = $1; loc = $5; proc = "-"
			if (match($0, /users:\(\("[^"]+"/)) proc = substr($0, RSTART + 9, RLENGTH - 10)
			n = split(loc, a, ":"); port = a[n]; addr = substr(loc, 1, length(loc) - length(port) - 1)
			print proto, port, addr, proc
		}'
	}
	ssh_ports() {
		{
			listeners | awk '$1 == "tcp" && $4 == "sshd" { print $2 }'
			if systemctl is-active --quiet ssh.socket 2>/dev/null; then
				{ systemctl show -p Listen --value ssh.socket 2>/dev/null || true; } | tr ' ' '\n' | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p'
			fi
		} | sort -un | paste -sd, -
	}
	other_listeners() {
		local sp
		sp=" $(ssh_ports | tr ',' ' ') "
		listeners | awk -v rp=" $RELAY_PORTS " -v sp="$sp" '{
			if ($3 ~ /^(127\.|\[::1\]|::1$|\[::ffff:127\.)/) next
			if (index(rp, " " $2 " ")) next
			if ($4 == "lucid-relay" || $4 == "turnserver" || $4 == "sshd") next
			if ($4 == "systemd" && index(sp, " " $2 " ")) next
			if ($1 == "udp" && ($2 == "68" || $2 == "546")) next
			print $4 " (" $1 " " $2 ")"
		}' | sort -u | paste -sd, - | sed 's/,/, /g'
	}
	fw_kind() {
		local out t
		if have ufw; then
			out=$(ufw status 2>/dev/null || true)
			if grep -q '^Status: active' <<<"$out"; then say ufw; return; fi
		fi
		if systemctl is-active --quiet firewalld 2>/dev/null; then say firewalld; return; fi
		if have nft; then
			out=$(nft list ruleset 2>/dev/null || true)
			if awk '$1 == "table" { t = $2 " " $3 } /hook input/ && /policy drop/ && t != "inet lucid_relay" { f = 1 } END { exit !f }' <<<"$out"; then
				say nftables; return
			fi
		fi
		for t in iptables-save ip6tables-save iptables-legacy-save ip6tables-legacy-save; do
			if have "$t"; then
				out=$("$t" 2>/dev/null || true)
				if grep -Eq '^(:INPUT DROP|-A INPUT )' <<<"$out"; then say "${t%-save}"; return; fi
			fi
		done
	}
	fw_state() { printf '%s;%s;%s' "$(fw_kind)" "$(other_listeners)" "$(ssh_ports)"; }

	# ---- helpers for the coturn file (5.2 step 9) ----
	# host_addrs: every non-loopback address `ip -o addr show` lists, then the --external-ip public and
	# private parts, in that order, each once.
	host_addrs() {
		{
			{ ip -o addr show 2>/dev/null || true; } | awk '$2 != "lo" { split($4, a, "/"); if (a[1] !~ /^127\./ && a[1] != "::1") print a[1] }'
			if [ -n "$external" ]; then
				say "${external%%/*}"
				if [[ $external == */* ]]; then say "${external#*/}"; fi
			fi
		} | awk 'NF && !seen[$0]++'
	}
	# v6_range <CIDR>: "<first>-<last>", each written as Python's ipaddress writes it (RFC 5952).
	v6_range() {
		local ip=${1%/*} len=${1#*/} head tail i n bits m lo hi
		local -a h=() t=() full=() los=() his=()
		if [[ $ip == *::* ]]; then head=${ip%%::*}; tail=${ip#*::}; else head=$ip; tail=""; fi
		if [ -n "$head" ]; then IFS=: read -ra h <<<"$head"; fi
		if [ -n "$tail" ]; then IFS=: read -ra t <<<"$tail"; fi
		full=("${h[@]}")
		for ((i = ${#h[@]} + ${#t[@]}; i < 8; i++)); do full+=(0); done
		full+=("${t[@]}")
		for ((i = 0; i < 8; i++)); do
			n=$((16#${full[i]:-0}))
			bits=$((len - 16 * i))
			if [ "$bits" -le 0 ]; then m=0; elif [ "$bits" -ge 16 ]; then m=65535; else m=$(((65535 << (16 - bits)) & 65535)); fi
			lo=$((n & m)); hi=$((lo | (~m & 65535)))
			los+=("$(printf '%x' "$lo")"); his+=("$(printf '%x' "$hi")")
		done
		printf '%s-%s\n' "$(v6_text "${los[@]}")" "$(v6_text "${his[@]}")"
	}
	# v6_text <8 hextets>: the longest run of two or more zero hextets (the first on a tie) becomes "::".
	v6_text() {
		local -a x=("$@")
		local i best=-1 bestlen=0 run=0 start=0 out=""
		for ((i = 0; i < 8; i++)); do
			if [ "${x[i]}" = 0 ]; then
				if [ "$run" = 0 ]; then start=$i; fi
				run=$((run + 1))
				if [ "$run" -gt "$bestlen" ]; then best=$start; bestlen=$run; fi
			else
				run=0
			fi
		done
		if [ "$bestlen" -lt 2 ]; then
			out=$(IFS=:; printf '%s' "${x[*]}")
		else
			local left="" right=""
			if [ "$best" -gt 0 ]; then left=$(IFS=:; printf '%s' "${x[*]:0:best}"); fi
			if [ $((best + bestlen)) -lt 8 ]; then right=$(IFS=:; printf '%s' "${x[*]:best+bestlen}"); fi
			out="$left::$right"
		fi
		printf '%s' "$out"
	}
	peer_range() {
		local c=$1 ip len a b cc d n mask lo hi
		if [[ $c == *:* ]]; then v6_range "$c"; return; fi
		ip=${c%/*}; len=${c#*/}
		IFS=. read -r a b cc d <<<"$ip"
		n=$(((a << 24) | (b << 16) | (cc << 8) | d))
		if [ "$len" -eq 0 ]; then mask=0; else mask=$(((0xFFFFFFFF << (32 - len)) & 0xFFFFFFFF)); fi
		lo=$((n & mask)); hi=$((lo | (~mask & 0xFFFFFFFF)))
		printf '%d.%d.%d.%d-%d.%d.%d.%d\n' $((lo >> 24 & 255)) $((lo >> 16 & 255)) $((lo >> 8 & 255)) $((lo & 255)) \
			$((hi >> 24 & 255)) $((hi >> 16 & 255)) $((hi >> 8 & 255)) $((hi & 255))
	}
	# turn_conf <secret> <realm> <cert> <key> <allowed|denied>: the coturn file.
	turn_conf() {
		local r a p
		cat <<EOF
# coturn for Lucid Meet. Written by the Lucid relay installer; run the installer again to change it.
# Credentials are coturn REST credentials minted by the relay for certificate-authenticated
# participants only: no static users, so this is not an open relay.
listening-port=3478
tls-listening-port=5349
min-port=49160
max-port=49260
fingerprint
use-auth-secret
static-auth-secret=$1
realm=$2
cert=$3
pkey=$4
no-tlsv1
no-tlsv1_1
no-cli
no-multicast-peers
no-loopback-peers
no-rfc5780
no-stun-backward-compatibility
response-origin-only-with-rfc5780
total-quota=100
stale-nonce=600
EOF
		for r in 0.0.0.0-0.255.255.255 10.0.0.0-10.255.255.255 100.64.0.0-100.127.255.255 127.0.0.0-127.255.255.255 \
			169.254.0.0-169.254.255.255 172.16.0.0-172.31.255.255 192.0.0.0-192.0.0.255 192.168.0.0-192.168.255.255 \
			198.18.0.0-198.19.255.255 224.0.0.0-255.255.255.255 ::1 ::ffff:0.0.0.0-::ffff:255.255.255.255 \
			64:ff9b::-64:ff9b::ffff:ffff fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff; do
			say "denied-peer-ip=$r"
		done
		for p in "${allow_peers[@]}"; do say "allowed-peer-ip=$(peer_range "$p")"; done
		while IFS= read -r a; do
			say "$5-peer-ip=$a"
		done < <(host_addrs)
		if [ -n "$external" ]; then say "external-ip=$external"; fi
		cat <<'EOF'
# Logs: one copy, to syslog, which journald keeps (journalctl -u coturn). At the default level coturn
# writes one summary per TURN session when it closes. No verbose: that logs every request.
log-file=syslog
no-stdout-log
simple-log
EOF
	}

	# ---- helpers for the deploy env file (6.3 step 10) ----
	local d_host="" d_turn="" d_clients="" d_pki=""
	read_env() {
		local f="$P$1" k val
		[ -f "$f" ] || return 1
		while IFS='=' read -r k val; do
			safe "$val" || die "The relay program does not run on this host: $1 does not read"
			case "$k" in
			HOST) d_host=$val ;;
			TURN_HOST) d_turn=$val ;;
			CLIENTS) d_clients=$val ;;
			PKI) d_pki=$val ;;
			"") ;;
			*) die "The relay program does not run on this host: $1 does not read" ;;
			esac
		done <"$f"
	}
	installed_version() { { "$P$PROG" --version 2>/dev/null || true; } | awk 'NR == 1 { print $NF }'; }
	enrolled_url() { { grep -o '"fleetUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$P$STATE/fleet.json" 2>/dev/null || true; } | awk -F'"' 'NR == 1 { print $4 }'; }

	# ================= uninstall (5.8) =================
	if [ "$action" = uninstall ]; then
		if [ -x "$P$PROG" ] && [ -f "$P$STATE/fleet.json" ]; then
			local rc=0 i
			"$P$PROG" meet fleet leave --config "$ETC/relay.json" || rc=$?
			for i in $(seq 1 15); do
				[ -f "$P$STATE/fleet.json" ] || break
				sleep 1
			done
			if [ "$rc" = 0 ]; then say "The relay left the Admin Console."; else say "The console was not reached; the relay removed its link here. Remove it in the Admin Console too."; fi
		fi
		local u
		for u in "$UNIT.service" lucid-meet-turn-cert.path lucid-meet-turn-cert.service lucid-relay-firewall.service; do
			systemctl disable --now "$u" 2>/dev/null || true
			rm -f "$P/etc/systemd/system/$u"
		done
		rm -rf "$P/etc/systemd/system/$UNIT.service.d"
		rm -f "$P$PROG" "$P$PROG.new" "$P$MARKER" "$P$FW_FILE" "$P/etc/turnserver.conf"
		rm -rf "$P/etc/coturn/lucid"
		if [ -f "$P/etc/default/coturn" ]; then
			sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=0/' "$P/etc/default/coturn"
		fi
		systemctl stop coturn 2>/dev/null || true
		systemctl daemon-reload 2>/dev/null || true
		if [ "$purge" = 1 ]; then
			rm -rf "$P$ETC" "$P$STATE" "$P$OPT"
			if [ ! -f "$P/etc/lucid-relay/deployed-by" ]; then
				rm -f "$P/etc/lucid-relay/lucid-console-kek.cred" "$P/etc/lucid-relay/seal-provider.json"
			fi
			userdel "$U" 2>/dev/null || true
			say "Removed the relay program and its services."
		else
			say "Removed the relay program and its services. Kept $ETC and $STATE; add --purge to delete them."
		fi
		return 0
	fi

	# ================= install =================
	# ---- the header, the profile and the program source (5.1, 2.3) ----
	if [ "$served" = 1 ]; then
		if [ -n "$profile" ] && [ "$profile" != "$hprofile" ]; then die "This console serves Standard relays only. Install a High relay from your release media."; fi
		profile=$hprofile
		[ "$profile" = standard ] || die "This console serves Standard relays only. Install a High relay from your release media."
	else
		console=$opt_console
		pins=$opt_pins
		[ -n "$binary" ] || die "Pass --binary <path> with the verified lucid-relay from your release media."
		[ -n "$console" ] || die "$W_USAGE"
	fi

	# ---- step 1: checks, all before any change ----
	local os_id os_ver
	os_id=$(. "$P/etc/os-release" 2>/dev/null && printf '%s' "${ID:-}") || true
	os_ver=$(. "$P/etc/os-release" 2>/dev/null && printf '%s' "${VERSION_ID:-}") || true
	case "$os_id $os_ver" in
	"debian 12" | "debian 13" | "ubuntu 22.04" | "ubuntu 24.04") ;;
	*) die "This installer supports Debian 12 or 13 and Ubuntu 22.04 or 24.04. This host is ${os_id:-unknown} ${os_ver:-}." ;;
	esac
	[ -d "$P/run/systemd/system" ] || die "This installer needs systemd."
	local host_arch
	host_arch=$(uname -m)
	if [ -n "$arch" ] && [ "$arch" != "$host_arch" ]; then die "This console hands out the relay program for $arch; this host is $host_arch."; fi
	if [ -n "$code_file" ]; then
		local st
		st=$(stat -L -c '%u %a' "$code_file" 2>/dev/null || true)
		if [ ! -f "$code_file" ] || [ -L "$code_file" ] || [ "$st" != "0 600" ]; then
			die "No terminal to read the enrollment code from. Run the command in an interactive shell, or pass --code-file <path> (owned by root, mode 600) and --admins."
		fi
	elif ! tty_ok; then
		die "No terminal to read the enrollment code from. Run the command in an interactive shell, or pass --code-file <path> (owned by root, mode 600) and --admins."
	fi
	if [ -z "$profile" ]; then
		tty_ok || die "No terminal to read the enrollment code from. Run the command in an interactive shell, or pass --code-file <path> (owned by root, mode 600) and --admins."
		local ans
		while :; do
			printf '%s' "Is this a government deployment? A yes uses the High security profile, which cannot be changed later. (yes or no) [yes]: " >/dev/tty
			IFS= read -r ans </dev/tty || ans=""
			case "$ans" in "" | yes | y | Yes | YES) profile=high; break ;; no | n | No | NO) profile=standard; break ;; esac
		done
	fi
	local d avail
	for d in /opt /var/lib; do
		avail=$({ df -Pk "$P$d" 2>/dev/null || true; } | awk 'NR == 2 { print $4 }')
		if [ -z "$avail" ] || [ "$avail" -lt 2097152 ]; then die "At least 2 GB must be free under /opt and /var/lib."; fi
	done
	local had_deploy=0
	[ -f "$P$ETC/deployed-by" ] && had_deploy=1
	local proto port proc
	while read -r proto port _ proc; do
		case "$proto/$port" in tcp/443 | tcp/5349 | tcp/3478 | udp/3478) ;; *) continue ;; esac
		if [ "$had_deploy" = 1 ] && { [ "$proc" = lucid-relay ] || [ "$proc" = turnserver ]; }; then continue; fi
		die "Port $port is already in use by $proc. Free it and run the command again."
	done < <(listeners)
	if [ -f "$P$ETC/relay.json" ] && [ "$had_deploy" = 0 ]; then
		die "This host already runs a relay that was installed by hand. Use Already installed in the Admin Console to join it."
	fi
	if [ -f "$P$ETC/profile.lock" ] && [ "$profile" = standard ]; then
		die "This host was installed with the $(tr -dc 'a-z' <"$P$ETC/profile.lock") profile. Uninstall with --purge to change it."
	fi
	if [ -n "$pki_dir" ]; then
		local f
		for f in ca.crt relay.crt relay.key; do
			[ -f "$pki_dir/$f" ] || die "The folder must hold ca.crt, relay.crt and a matching relay.key, and relay.crt must come from ca.crt."
		done
	fi
	if [ -n "$ca_file" ] && [ ! -f "$ca_file" ]; then die "The CA file must be a self-signed P-256 CA certificate (ca.crt), never its key."; fi
	# Reruns (5.7).
	local mode=full
	if [ "$had_deploy" = 1 ] && [ -f "$P$STATE/fleet.json" ]; then
		local url inst
		url=$(enrolled_url)
		if [ "$url" != "$console" ]; then
			say "This relay belongs to another Admin Console (${url:-unknown}). Nothing was changed."
			return 1
		fi
		inst=$(installed_version)
		if [ -n "$version" ] && [ -n "$inst" ] && [ "$inst" != "$version" ] &&
			[ "$(printf '%s\n%s\n' "$inst" "$version" | sort -V | awk 'NR == 1')" = "$version" ]; then
			say "This host runs version $inst, newer than $version. Nothing was changed."
			return 1
		fi
		mode=update
	fi
	# Firewall detection (5.6), before any change (R2-L2).
	local fw_mode=write fw_kind_now="" fw_sig=""
	if [ "$no_fw" = 1 ]; then
		fw_mode=none
	else
		fw_kind_now=$(fw_kind)
		if [ -n "$fw_kind_now" ]; then fw_mode=exists; fi
		if [ "$fw_mode" = write ]; then
			local others
			others=$(other_listeners)
			if [ -n "$others" ] && [ "$fw_force" = 0 ]; then
				die "Other services listen on this host: $others. The firewall would close them. Run again with --firewall-force to close them, or --no-firewall and open $PORT_WORDS yourself."
			fi
		fi
		fw_sig=$(fw_state)
	fi

	LUCID_TMP=$(mktemp -d)

	# ---- step 2: packages ----
	local -a pkgs=(ca-certificates curl nftables coturn openssl)
	if [ "$(systemd-detect-virt 2>/dev/null || true)" = kvm ]; then pkgs+=(qemu-guest-agent); fi
	DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o Dpkg::Options::=--force-confold update
	DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o Dpkg::Options::=--force-confold install -y --no-install-recommends "${pkgs[@]}"

	# ---- step 3: user and folders ----
	if ! getent passwd "$U" >/dev/null 2>&1; then
		useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$U"
	fi
	mkdir -p "$P$OPT" "$P$ETC" "$P$STATE/pki"
	chmod 0755 "$P$OPT"; chown root:root "$P$OPT"
	chmod 0750 "$P$ETC"; chown "root:$U" "$P$ETC"
	chmod 0750 "$P$STATE"; chown "$U:$U" "$P$STATE"
	chmod 0700 "$P$STATE/pki"; chown "$U:$U" "$P$STATE/pki"
	if [ "$had_deploy" = 0 ] || [ "$(cat "$P$ETC/deployed-by")" != installed ]; then
		say installing | put "$ETC/deployed-by" 0640 "root:$U"
	fi
	if [ "$profile" = high ] && [ ! -f "$P$ETC/profile.lock" ]; then
		say high | put "$ETC/profile.lock" 0644 root:root
	fi

	# ---- step 4: the program ----
	local new="$OPT/lucid-relay.new" got
	if [ -n "$binary" ]; then
		cp -f "$binary" "$P$new"
	elif [ -f "$P$PROG" ] && [ "$(sha256sum "$P$PROG" | awk '{ print $1 }')" = "$sha" ]; then
		new=""
	else
		curl -fsS --proto =https -k --pinnedpubkey "$pins" -o "$P$new" "$console/fleet/v1/install/lucid-relay?e=$enrollment"
	fi
	if [ -n "$new" ]; then
		got=$(sha256sum "$P$new" | awk '{ print $1 }')
		if [ -n "$binary" ]; then say "Relay program SHA-256: $got. It must match your release notes."; fi
		if [ -n "$sha" ] && [ "$got" != "$sha" ]; then
			rm -f "$P$new"
			die "The downloaded relay program does not match SHA-256 $sha. Nothing was installed."
		fi
		chmod 0755 "$P$new"
		local why
		if ! why=$("$P$new" --version 2>&1); then
			rm -f "$P$new"
			die "The relay program does not run on this host: $why"
		fi
		mv -f "$P$new" "$P$PROG"
	fi
	# The installer marker (R2-M1): only a served header with an enrollment id, and no --binary.
	if [ "$served" = 1 ] && [ -n "$enrollment" ] && [ -z "$binary" ] && [ "$mode" = full ]; then
		rm -f "$P$MARKER"
		LUCID_RM_MARKER="$P$MARKER"
		(set -o noclobber; printf '{"enrollment": "%s", "sha256": "%s", "at": %s}\n' "$enrollment" "$sha" "$(date +%s)" >"$P$MARKER")
		chmod 0600 "$P$MARKER"
		chown root:root "$P$MARKER"
	fi

	# ---- step 5: TURN secret ----
	if [ ! -f "$P$ETC/turn.secret" ]; then
		od -An -N32 -tx1 /dev/urandom | tr -d ' \n' | put "$ETC/turn.secret" 0640 "root:$U"
	fi

	# ---- step 6: sealing (kept on rerun) ----
	if [ ! -f "$P/etc/systemd/system/$UNIT.service.d/lucid-console-seal.conf" ]; then
		"$P$PROG" console seal-setup --role relay --service "$UNIT" --state "$STATE"
	fi

	# ---- step 7: own certificate or the organization CA ----
	ca_id() { openssl x509 -in "$1" -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum | awk '{ print "m_" substr($1, 1, 32) }'; }
	if [ -n "$pki_dir" ]; then
		local cpub kpub
		cpub=$(openssl x509 -in "$pki_dir/relay.crt" -noout -pubkey 2>/dev/null || true)
		kpub=$(openssl pkey -in "$pki_dir/relay.key" -pubout 2>/dev/null || true)
		if [ -z "$cpub" ] || [ "$cpub" != "$kpub" ] || ! openssl verify -CAfile "$pki_dir/ca.crt" "$pki_dir/relay.crt" >/dev/null 2>&1; then
			die "The folder must hold ca.crt, relay.crt and a matching relay.key, and relay.crt must come from ca.crt."
		fi
		mkdir -p "$P$STATE/pki/placed"
		chmod 0700 "$P$STATE/pki/placed"
		put "$STATE/pki/ca.crt" 0644 "$U:$U" <"$pki_dir/ca.crt"
		put "$STATE/pki/placed/relay.crt" 0644 "$U:$U" <"$pki_dir/relay.crt"
		put "$STATE/pki/placed/relay.key" 0600 "$U:$U" <"$pki_dir/relay.key"
		if [ -f "$pki_dir/crl.pem" ]; then put "$STATE/pki/crl-root.pem" 0644 "$U:$U" <"$pki_dir/crl.pem"; fi
		chown "$U:$U" "$P$STATE/pki/placed"
		ln -sfn placed "$P$STATE/pki/current.new"
		mv -Tf "$P$STATE/pki/current.new" "$P$STATE/pki/current"
		say "Organization CA on this host: $(ca_id "$pki_dir/ca.crt")."
	elif [ -n "$ca_file" ]; then
		local ctext
		ctext=$(openssl x509 -in "$ca_file" -noout -text 2>/dev/null || true)
		if ! grep -q 'CA:TRUE' <<<"$ctext" || ! grep -Eq 'prime256v1|P-256' <<<"$ctext" ||
			! openssl verify -CAfile "$ca_file" "$ca_file" >/dev/null 2>&1 || grep -q 'PRIVATE KEY' "$ca_file"; then
			die "The CA file must be a self-signed P-256 CA certificate (ca.crt), never its key."
		fi
		put "$STATE/pki/ca.crt" 0644 "$U:$U" <"$ca_file"
		say "Organization CA on this host: $(ca_id "$ca_file")."
	fi

	# ---- step 8: enroll (5.9: the program reads the code from the terminal or the file) ----
	if [ "$mode" = full ]; then
		systemctl stop "$UNIT" 2>/dev/null || true
		rm -f "$P$STATE/fleet-pending.json"
		local pki=console
		[ -n "$pki_dir" ] && pki=own
		local -a eargs=(meet enroll "$console" --config "$ETC/relay.json" --deploy linux --profile "$profile" --pki "$pki")
		[ -n "$admins" ] && eargs+=(--admins "$admins")
		[ -n "$host" ] && eargs+=(--host "$host")
		[ -n "$turn_host" ] && eargs+=(--turn-host "$turn_host")
		rm -f "$P$RUN_ENV"
		if [ -n "$code_file" ]; then
			eargs+=(--code-file "$code_file")
			if tty_ok; then
				"$P$PROG" "${eargs[@]}" </dev/tty >/dev/tty 2>&1 || exit 1
			else
				"$P$PROG" "${eargs[@]}" </dev/null || exit 1
			fi
		else
			"$P$PROG" "${eargs[@]}" </dev/tty >/dev/tty 2>&1 || exit 1
		fi
		rm -f "$P$MARKER"
		LUCID_RM_MARKER=""
		read_env "$RUN_ENV" || die "The relay program does not run on this host: $RUN_ENV is missing"
		printf 'HOST=%s\nTURN_HOST=%s\nCLIENTS=%s\nPKI=%s\n' "$d_host" "$d_turn" "$d_clients" "$d_pki" | put "$ETC/deploy.env" 0640 "root:$U"
		rm -f "$P$RUN_ENV"
	else
		read_env "$ETC/deploy.env" || true
	fi
	[ -n "$d_host" ] || d_host=$host
	[ -n "$d_turn" ] || d_turn=${turn_host:-$d_host}

	# ---- step 9: coturn ----
	local peers=allowed
	if [ "$fw_mode" != write ]; then peers=denied; fi
	turn_conf "$(cat "$P$ETC/turn.secret")" "$d_host" /etc/coturn/lucid/turn.crt /etc/coturn/lucid/turn.key "$peers" |
		put /etc/turnserver.conf 0640 root:turnserver
	if [ "$peers" = denied ]; then
		say "This installer did not write a firewall here, so TURN may not relay to this host's own addresses. Calls between two people who both need TURN fail until you open UDP 49160 to 49260 toward $(host_addrs | paste -sd, - | sed 's/,/, /g') in your firewall and run again with --allow-peer for those addresses."
	fi
	if [ -f "$P/etc/default/coturn" ] && grep -q 'TURNSERVER_ENABLED' "$P/etc/default/coturn"; then
		sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' "$P/etc/default/coturn"
	else
		say TURNSERVER_ENABLED=1 >>"$P/etc/default/coturn"
	fi
	mkdir -p "$P/etc/coturn/lucid"
	chmod 0750 "$P/etc/coturn/lucid"
	chown root:turnserver "$P/etc/coturn/lucid"
	put /etc/systemd/system/lucid-meet-turn-cert.path 0644 root:root <<'EOF'
[Unit]
Description=Lucid Meet TURN certificate copy (watch)

[Path]
PathChanged=/var/lib/lucid-meet/pki/current
PathModified=/var/lib/lucid-meet/pki
Unit=lucid-meet-turn-cert.service

[Install]
WantedBy=multi-user.target
EOF
	put /etc/systemd/system/lucid-meet-turn-cert.service 0644 root:root <<'EOF'
[Unit]
Description=Lucid Meet TURN certificate copy
ConditionPathExists=/var/lib/lucid-meet/pki/current/relay.crt

[Service]
Type=oneshot
ExecStart=/usr/bin/install -m 0644 -o turnserver -g turnserver /var/lib/lucid-meet/pki/current/relay.crt /etc/coturn/lucid/turn.crt
ExecStart=/usr/bin/install -m 0600 -o turnserver -g turnserver /var/lib/lucid-meet/pki/current/relay.key /etc/coturn/lucid/turn.key
ExecStart=/usr/bin/systemctl try-restart coturn
EOF

	# ---- step 10: the relay unit ----
	put "/etc/systemd/system/$UNIT.service" 0644 root:root <<'EOF'
[Unit]
Description=Lucid Meeting Hub relay
After=network-online.target
Wants=network-online.target

[Service]
User=lucid-meet
ExecStart=/opt/lucid-meet/lucid-relay meet --config /etc/lucid-meet/relay.json
Restart=on-failure
RestartSec=2
RestartPreventExitStatus=78
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
StateDirectory=lucid-meet
StateDirectoryMode=0750

[Install]
WantedBy=multi-user.target
EOF

	# ---- step 11: firewall (5.6) ----
	if [ "$fw_mode" = exists ]; then
		say "This host already has a firewall ($fw_kind_now). Open these ports in it: $PORT_WORDS."
	elif [ "$fw_mode" = write ]; then
		if [ "$(fw_state)" != "$fw_sig" ]; then
			die "The firewall on this host changed while installing, so no firewall table was written. Resolve it and run the command again; if the enrollment code was already used, make a new one in the Admin Console."
		fi
		local sshp ssh_rule="" from="any address"
		sshp=$(ssh_ports)
		if [ -n "$sshp" ]; then
			if [ -n "$ssh_from" ]; then
				from=$ssh_from
				if [[ $ssh_from == *:* ]]; then ssh_rule="ip6 saddr $ssh_from tcp dport { $sshp } accept"; else ssh_rule="ip saddr $ssh_from tcp dport { $sshp } accept"; fi
			else
				ssh_rule="tcp dport { $sshp } accept"
			fi
		fi
		put "$FW_FILE" 0644 root:root <<EOF
# Written by the Lucid relay installer. Loaded by lucid-relay-firewall.service; never edit nftables.conf for it.
table inet lucid_relay
delete table inet lucid_relay
table inet lucid_relay {
	chain input {
		type filter hook input priority 0; policy drop;
		ct state established,related accept
		ct state invalid drop
		iif lo ip daddr 127.0.0.0/8 accept
		iif lo ip6 daddr ::1 accept
		icmp type { echo-request, destination-unreachable } accept
		icmpv6 type { echo-request, destination-unreachable, packet-too-big, nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } accept
		meta pkttype broadcast udp sport 67 udp dport 68 accept
		ip6 saddr fe80::/10 udp sport 547 udp dport 546 accept
		$ssh_rule
		tcp dport { 443, 3478, 5349 } accept
		udp dport 3478 accept
		udp dport 49160-49260 accept
	}
}
EOF
		nft -c -f "$P$FW_FILE"
		put /etc/systemd/system/lucid-relay-firewall.service 0644 root:root <<'EOF'
[Unit]
Description=Lucid relay firewall table (inet lucid_relay)
After=nftables.service
PartOf=nftables.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/lucid-relay-firewall.nft
ExecStop=-/usr/sbin/nft delete table inet lucid_relay

[Install]
WantedBy=multi-user.target nftables.service
EOF
		systemctl daemon-reload
		systemctl enable lucid-relay-firewall.service
		systemctl restart lucid-relay-firewall.service
		if [ -n "$sshp" ]; then
			say "Firewall: SSH ($sshp) from $from; relay ports $PORT_WORDS; everything else closed. Local connections to this host's own public or LAN addresses follow the same rules; use 127.0.0.1 for other local services."
		else
			say "No SSH service found; the firewall allows no SSH."
		fi
	else
		say "This host already has a firewall (--no-firewall). Open these ports in it: $PORT_WORDS."
	fi

	# ---- step 12: start and wait ----
	systemctl daemon-reload
	systemctl enable coturn lucid-meet-turn-cert.path "$UNIT"
	systemctl restart coturn lucid-meet-turn-cert.path "$UNIT"
	say "Starting the relay and joining the console..."
	local n out
	for n in $(seq 1 60); do
		if out=$("$P$PROG" meet fleet status --config "$ETC/relay.json" --fingerprint 2>/dev/null) && [ -n "$out" ]; then
			say "Relay fingerprint: $out"
			say "In the Admin Console, check that it shows the same fingerprint, then press Confirm relay."
			say installed | put "$ETC/deployed-by" 0640 "root:$U"
			if [ "$mode" = update ]; then
				say "This relay already belongs to this Admin Console. Updated the program to ${version:-$(installed_version)} and restarted it."
			else
				say "Done. Relay https://$d_host on TCP 443; TURN $d_turn on UDP and TCP 3478, TCP 5349 and UDP 49160 to 49260."
			fi
			return 0
		fi
		if systemctl is-failed --quiet "$UNIT" 2>/dev/null && [ "$n" -gt 5 ]; then break; fi
		sleep 2
	done
	say "The relay did not join within 2 minutes. Last log lines:"
	journalctl -u "$UNIT" -n 30 --no-pager 2>/dev/null || true
	return 1
}
{ main "$@"; exit $?; }
