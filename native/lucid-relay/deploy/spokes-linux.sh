# shellcheck shell=bash disable=SC2154,SC2034,SC1090,SC1091
# Lucid relay installer body: Remote Spokes on Debian or Ubuntu (contract AC-2b-D 5.3, 5.6 to 5.9).
# The console serves this body after a 10-line header that sets the LUCID_ variables; the program's
# `deploy script spokes-linux` prints the same header with empty values. Every step is inside main and
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

	local U=lucid-relay OPT=/opt/lucid-relay ETC=/etc/lucid-relay STATE=/var/lib/lucid-relay UNIT=lucid-relay
	local PROG=/opt/lucid-relay/bin/lucid-relay MARKER=/opt/lucid-relay/.lucid-deploy LOCK=/run/lucid-relay-deploy.lock
	local RUN_ENV=/run/lucid-relay-deploy.env FW_FILE=/etc/lucid-relay-firewall.nft
	local RELAY_PORTS="8443"
	local PORT_WORDS="TCP 8443"
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

	# ---- arguments (5.1; Remote Spokes takes no Meeting Hub option) ----
	local action=install purge=0 profile="" host="" clients="" root_file="" code_file=""
	local ssh_from="" no_fw=0 fw_force=0 binary="" opt_console="" opt_pins=""
	while [ $# -gt 0 ]; do
		case "$1" in
		install | uninstall) action=$1; shift ;;
		--purge) purge=1; shift ;;
		--profile) need $#; profile=$2; shift 2 ;;
		--host) need $#; host=$2; shift 2 ;;
		--clients) need $#; clients=$2; shift 2 ;;
		--root) need $#; root_file=$2; shift 2 ;;
		--code-file) need $#; code_file=$2; shift 2 ;;
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
	local v c
	for v in "$host" "$clients" "$opt_console" "$opt_pins"; do safe "$v" || die "$W_USAGE"; done
	if [ -n "$clients" ]; then
		for c in ${clients//,/ }; do cidr_ok "$c" || die "$W_USAGE"; done
	fi

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
			if ($4 == "lucid-relay" || $4 == "sshd") next
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
	kept_profile() { { grep -o -- '--console-profile [a-z]*' "$P/etc/systemd/system/$UNIT.service" 2>/dev/null || true; } | awk 'NR == 1 { print $2 }'; }
	root_id() { openssl pkey -pubin -in "$1" -outform DER | sha256sum | awk '{ print "n_" substr($1, 1, 32) }'; }

	# ================= uninstall (5.8) =================
	if [ "$action" = uninstall ]; then
		if [ -x "$P$PROG" ] && [ -f "$P$STATE/fleet.json" ]; then
			local rc=0 _i
			"$P$PROG" fleet leave --state "$STATE" || rc=$?
			for _i in $(seq 1 15); do
				[ -f "$P$STATE/fleet.json" ] || break
				sleep 1
			done
			if [ "$rc" = 0 ]; then say "The relay left the Admin Console."; else say "The console was not reached; the relay removed its link here. Remove it in the Admin Console too."; fi
		fi
		local u
		for u in "$UNIT.service" lucid-relay-firewall.service; do
			systemctl disable --now "$u" 2>/dev/null || true
			rm -f "$P/etc/systemd/system/$u"
		done
		rm -rf "$P/etc/systemd/system/$UNIT.service.d"
		rm -f "$P$PROG" "$P$PROG.new" "$P$MARKER" "$P$FW_FILE"
		systemctl daemon-reload 2>/dev/null || true
		if [ "$purge" = 1 ]; then
			rm -rf "$P$ETC" "$P$STATE" "$P$OPT"
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
		[ -n "$root_file" ] || die "Pass --root <file> with your organization root's public key."
		[ -n "$console" ] || die "$W_USAGE"
	fi

	# ---- checks, all before any change ----
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
		case "$proto/$port" in tcp/8443) ;; *) continue ;; esac
		if [ "$had_deploy" = 1 ] && [ "$proc" = lucid-relay ]; then continue; fi
		die "Port $port is already in use by $proc. Free it and run the command again."
	done < <(listeners)
	if [ "$had_deploy" = 0 ] && [ -f "$P/etc/systemd/system/$UNIT.service" ]; then
		die "This host already runs a relay that was installed by hand. Use Already installed in the Admin Console to join it."
	fi
	if [ -f "$P$ETC/profile.lock" ] && [ "$profile" = standard ]; then
		die "This host was installed with the $(tr -dc 'a-z' <"$P$ETC/profile.lock") profile. Uninstall with --purge to change it."
	fi
	local kept
	kept=$(kept_profile)
	if [ -n "$kept" ] && [ "$kept" != "$profile" ]; then
		die "This host was installed with the $kept profile. Uninstall with --purge to change it."
	fi
	if [ -n "$root_file" ]; then
		local rtext
		rtext=$(openssl pkey -pubin -in "$root_file" -noout -text 2>/dev/null || true)
		if ! grep -q 'BEGIN PUBLIC KEY' "$root_file" 2>/dev/null || grep -q 'PRIVATE KEY' "$root_file" ||
			! grep -Eq 'prime256v1|P-256' <<<"$rtext"; then
			die "The root file must be a P-256 public key (root.pub), never the private key."
		fi
	fi
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

	# ---- packages ----
	local -a pkgs=(ca-certificates curl nftables openssl)
	if [ "$(systemd-detect-virt 2>/dev/null || true)" = kvm ]; then pkgs+=(qemu-guest-agent); fi
	DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o Dpkg::Options::=--force-confold update
	DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o Dpkg::Options::=--force-confold install -y --no-install-recommends "${pkgs[@]}"

	# ---- user and folders ----
	if ! getent passwd "$U" >/dev/null 2>&1; then
		useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$U"
	fi
	mkdir -p "$P$OPT/bin" "$P$ETC/tls" "$P$STATE/deploy"
	chmod 0755 "$P$OPT" "$P$OPT/bin"; chown root:root "$P$OPT" "$P$OPT/bin"
	chmod 0750 "$P$ETC" "$P$ETC/tls"; chown "root:$U" "$P$ETC" "$P$ETC/tls"
	chmod 0750 "$P$STATE" "$P$STATE/deploy"; chown "$U:$U" "$P$STATE"; chown "root:$U" "$P$STATE/deploy"
	if [ "$had_deploy" = 0 ] || [ "$(cat "$P$ETC/deployed-by")" != installed ]; then
		say installing | put "$ETC/deployed-by" 0640 "root:$U"
	fi
	if [ "$profile" = high ] && [ ! -f "$P$ETC/profile.lock" ]; then
		say high | put "$ETC/profile.lock" 0644 root:root
	fi

	# ---- the program ----
	local new="$OPT/bin/lucid-relay.new" got
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

	# ---- sealing (kept on rerun) ----
	if [ ! -f "$P/etc/systemd/system/$UNIT.service.d/lucid-console-seal.conf" ]; then
		"$P$PROG" console seal-setup --role relay --service "$UNIT" --state "$STATE"
	fi

	# ---- the organization root ----
	if [ -n "$root_file" ]; then
		put "$STATE/deploy/root.pub" 0640 "root:$U" <"$root_file"
		say "Organization root on this host: $(root_id "$root_file")."
	fi

	# ---- enroll (5.9: the program reads the code from the terminal or the file) ----
	if [ "$mode" = full ]; then
		systemctl stop "$UNIT" 2>/dev/null || true
		rm -f "$P$STATE/fleet-pending.json"
		local -a eargs=(enroll "$console" --state "$STATE" --deploy linux --profile "$profile")
		[ -n "$host" ] && eargs+=(--host "$host")
		[ -n "$clients" ] && eargs+=(--clients "$clients")
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
	[ -n "$d_clients" ] || d_clients=$clients

	# ---- TLS (kept on rerun) ----
	if [ ! -f "$P$ETC/tls/relay.key" ]; then
		local san="DNS:$d_host"
		if [[ $d_host =~ ^[0-9.]+$ || $d_host == *:* ]]; then san="IP:${d_host#[}"; san=${san%]}; fi
		openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 397 \
			-keyout "$P$ETC/tls/relay.key.new" -out "$P$ETC/tls/relay.crt.new" -subj "/CN=$d_host" \
			-addext "basicConstraints=critical,CA:FALSE" -addext "extendedKeyUsage=serverAuth" -addext "subjectAltName=$san" 2>/dev/null
		chmod 0640 "$P$ETC/tls/relay.key.new"; chown "root:$U" "$P$ETC/tls/relay.key.new"
		chmod 0644 "$P$ETC/tls/relay.crt.new"; chown root:root "$P$ETC/tls/relay.crt.new"
		mv -f "$P$ETC/tls/relay.crt.new" "$P$ETC/tls/relay.crt"
		mv -f "$P$ETC/tls/relay.key.new" "$P$ETC/tls/relay.key"
	fi

	# ---- the relay unit (H1: the profile is set on the host) ----
	put "/etc/systemd/system/$UNIT.service" 0644 root:root <<EOF
[Unit]
Description=Lucid Remote Spokes relay
After=network-online.target
Wants=network-online.target

[Service]
User=lucid-relay
ExecStart=/opt/lucid-relay/bin/lucid-relay relay serve --root /var/lib/lucid-relay/deploy/root.pub --license /var/lib/lucid-relay/license.lic --host 0.0.0.0 --port 8443 --tls-cert /etc/lucid-relay/tls/relay.crt --tls-key /etc/lucid-relay/tls/relay.key --state /var/lib/lucid-relay --console-profile $profile
Restart=on-failure
RestartSec=2
RestartPreventExitStatus=78
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
StateDirectory=lucid-relay
StateDirectoryMode=0750

[Install]
WantedBy=multi-user.target
EOF

	# ---- firewall (5.6) ----
	if [ "$fw_mode" = exists ]; then
		say "This host already has a firewall ($fw_kind_now). Open these ports in it: $PORT_WORDS."
	elif [ "$fw_mode" = write ]; then
		if [ "$(fw_state)" != "$fw_sig" ]; then
			die "The firewall on this host changed while installing, so no firewall table was written. Resolve it and run the command again; if the enrollment code was already used, make a new one in the Admin Console."
		fi
		local sshp ssh_rule="" from="any address" v4="" v6="" relay_rules=""
		sshp=$(ssh_ports)
		if [ -n "$sshp" ]; then
			if [ -n "$ssh_from" ]; then
				from=$ssh_from
				if [[ $ssh_from == *:* ]]; then ssh_rule="ip6 saddr $ssh_from tcp dport { $sshp } accept"; else ssh_rule="ip saddr $ssh_from tcp dport { $sshp } accept"; fi
			else
				ssh_rule="tcp dport { $sshp } accept"
			fi
		fi
		for c in ${d_clients//,/ }; do
			cidr_ok "$c" || die "The relay program does not run on this host: $RUN_ENV does not read"
			if [[ $c == *:* ]]; then v6="${v6:+$v6, }$c"; else v4="${v4:+$v4, }$c"; fi
		done
		if [ -z "$v4$v6" ]; then relay_rules="tcp dport 8443 accept"; fi
		if [ -n "$v4" ]; then relay_rules="ip saddr { $v4 } tcp dport 8443 accept"; fi
		if [ -n "$v6" ]; then relay_rules="${relay_rules:+$relay_rules
		}ip6 saddr { $v6 } tcp dport 8443 accept"; fi
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
		$relay_rules
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

	# ---- start and wait ----
	systemctl daemon-reload
	systemctl enable "$UNIT"
	systemctl restart "$UNIT"
	say "Starting the relay and joining the console..."
	local n out pin
	for n in $(seq 1 60); do
		if out=$("$P$PROG" fleet status --state "$STATE" --fingerprint 2>/dev/null) && [ -n "$out" ]; then
			say "Relay fingerprint: $out"
			say "In the Admin Console, check that it shows the same fingerprint, then press Confirm relay."
			say installed | put "$ETC/deployed-by" 0640 "root:$U"
			if [ "$mode" = update ]; then
				say "This relay already belongs to this Admin Console. Updated the program to ${version:-$(installed_version)} and restarted it."
			else
				pin=$(openssl x509 -in "$P$ETC/tls/relay.crt" -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum | awk '{ print $1 }')
				say "Done. Relay https://$d_host:8443. Add this entry to your hubs' relay directory:"
				printf '{"url": "https://%s:8443", "spkiSha256": "%s"}\n' "$d_host" "$pin"
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
