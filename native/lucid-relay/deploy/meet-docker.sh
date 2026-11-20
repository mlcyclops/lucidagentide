# shellcheck shell=bash disable=SC2154,SC2034,SC1090,SC1091
# Lucid relay installer body: Meeting Hub in Docker (contract AC-2b-D 5.5, 5.7 to 5.9). Standard only.
# The console serves this body after a 10-line header that sets the LUCID_ variables. Every step is
# inside main and the last line runs it, so a cut download runs nothing. The script never installs
# Docker, never writes a host firewall, and never reads the enrollment code: only the program does.
main() {
	set -euo pipefail
	umask 077

	# LUCID_DEPLOY_PREFIX roots every host file the script touches (the stub tests run it in a folder).
	local P="${LUCID_DEPLOY_PREFIX:-}"
	local console="${LUCID_CONSOLE:-}" pins="${LUCID_PINS:-}" version="${LUCID_VERSION:-}"
	local arch="${LUCID_ARCH:-}" sha="${LUCID_SHA256:-}" hprofile="${LUCID_PROFILE:-}" enrollment="${LUCID_ENROLLMENT:-}"

	# The base image digest is set by the release build, so it is part of this body's SHA-256 (M7).
	local DEBIAN_DIGEST='@DEBIAN_DIGEST@'
	local PRODUCT=meet D=/opt/lucid-relay-docker/meet LOCK=/run/lucid-relay-deploy.lock
	local ETC=/etc/lucid-meet STATE=/var/lib/lucid-meet
	local VOL_ETC=lucid-meet-etc VOL_STATE=lucid-meet-state PROJECT=lucid-meet
	local W_USAGE="Usage: install (the default) or uninstall [--purge]. Options: --profile high or standard, --admins <emails>, --host <name>, --turn-host <name>, --clients <CIDRs>, --pki-dir <folder>, --ca <file>, --root <file>, --code-file <path>, --external-ip <public>[/<private>], --allow-peer <CIDR>, --ssh-from <CIDR>, --no-firewall, --firewall-force, --binary <path>, --console <url>, --pins <pins>."

	# Globals, so the exit trap still sees them after main returns.
	LUCID_TMP="" LUCID_RM_IMAGE=""
	trap 'if [ -n "${LUCID_RM_IMAGE:-}" ]; then docker image rm -f "$LUCID_RM_IMAGE" >/dev/null 2>&1 || true; fi; if [ -n "${LUCID_TMP:-}" ]; then rm -rf "$LUCID_TMP"; fi' EXIT

	say() { printf '%s\n' "$*"; }
	die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
	need() { [ "$1" -ge 2 ] || die "$W_USAGE"; }
	local SAFE_RE='^[][A-Za-z0-9._:,/@+=;-]*$'
	safe() { [[ $1 =~ $SAFE_RE ]]; }
	cidr_ok() { [[ $1 =~ ^[0-9A-Fa-f.:]+/[0-9]{1,3}$ ]]; }
	tty_ok() { (: </dev/tty) 2>/dev/null; }

	# ---- arguments (5.1) ----
	local action=install purge=0 profile="" admins="" host="" turn_host="" pki_dir="" ca_file="" code_file=""
	local external="" binary=""
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
		--binary) need $#; binary=$2; shift 2 ;;
		*) die "$W_USAGE" ;;
		esac
	done
	case "$profile" in "" | high | standard) ;; *) die "$W_USAGE" ;; esac
	if [ "$purge" = 1 ] && [ "$action" != uninstall ]; then die "$W_USAGE"; fi
	local v
	for v in "$admins" "$host" "$turn_host"; do safe "$v" || die "$W_USAGE"; done
	if [ -n "$external" ] && ! [[ $external =~ ^[0-9A-Fa-f.:]+(/[0-9A-Fa-f.:]+)?$ ]]; then die "$W_USAGE"; fi

	[ "$(id -u)" = 0 ] || die "Run this as root (sudo)."
	exec 9>"$P$LOCK"
	flock -n 9 || die "Another run of this installer is in progress. Wait for it to finish."
	if ! docker version >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
		die "Install Docker Engine and its Compose plugin first."
	fi

	local image="lucid-relay-local:${version:-none}"
	local -a vols=(-v "$VOL_ETC:$ETC" -v "$VOL_STATE:$STATE")
	# One-shot containers for every file inside a volume (M7).
	vput() { docker run --rm -i --user 10001 "${vols[@]}" "$1" sh -c 'umask 077; cat > "$1"' sh "$2"; }
	vcat() { docker run --rm --user 10001 "${vols[@]}" "$1" cat "$2"; }
	vhas() { docker run --rm --user 10001 "${vols[@]}" "$1" test -e "$2" >/dev/null 2>&1; }
	compose() { docker compose -p "$PROJECT" -f "$P$D/compose.yaml" "$@"; }
	local d_host="" d_turn="" d_clients="" d_pki=""
	read_env() {
		local k val
		[ -f "$1" ] || return 1
		while IFS='=' read -r k val; do
			safe "$val" || die "The relay program does not run on this host: deploy.env does not read"
			case "$k" in
			HOST) d_host=$val ;;
			TURN_HOST) d_turn=$val ;;
			CLIENTS) d_clients=$val ;;
			PKI) d_pki=$val ;;
			"") ;;
			*) die "The relay program does not run on this host: deploy.env does not read" ;;
			esac
		done <"$1"
	}

	# ================= uninstall (5.8) =================
	if [ "$action" = uninstall ]; then
		if [ -f "$P$D/compose.yaml" ]; then
			local rc=0
			if compose exec -T relay test -e "$STATE/fleet.json" >/dev/null 2>&1; then
				compose exec -T relay lucid-relay meet fleet leave --config "$ETC/relay.json" || rc=$?
				if [ "$rc" = 0 ]; then say "The relay left the Admin Console."; else say "The console was not reached; the relay removed its link here. Remove it in the Admin Console too."; fi
			fi
			compose down
		fi
		if [ "$purge" = 1 ]; then
			docker volume rm -f "$VOL_ETC" "$VOL_STATE" >/dev/null 2>&1 || true
			if [ -f "$P$D/image" ]; then docker image rm -f "$(cat "$P$D/image")" >/dev/null 2>&1 || true; fi
			rm -rf "$P$D"
			say "Removed the relay program and its services."
		else
			say "Removed the relay program and its services. Kept the volumes $VOL_ETC and $VOL_STATE; add --purge to delete them."
		fi
		return 0
	fi

	# ================= install =================
	if [ -z "$console" ] || [ "$hprofile" != standard ]; then die "Docker is not offered under the High profile."; fi
	if [ -n "$profile" ] && [ "$profile" != "$hprofile" ]; then die "This console serves Standard relays only. Install a High relay from your release media."; fi
	profile=standard
	[[ $DEBIAN_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "The relay program does not run on this host: this installer has no pinned base image"
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
	if [ -n "$pki_dir" ]; then
		local f
		for f in ca.crt relay.crt relay.key; do
			[ -f "$pki_dir/$f" ] || die "The folder must hold ca.crt, relay.crt and a matching relay.key, and relay.crt must come from ca.crt."
		done
		local cpub kpub
		cpub=$(openssl x509 -in "$pki_dir/relay.crt" -noout -pubkey 2>/dev/null || true)
		kpub=$(openssl pkey -in "$pki_dir/relay.key" -pubout 2>/dev/null || true)
		if [ -z "$cpub" ] || [ "$cpub" != "$kpub" ] || ! openssl verify -CAfile "$pki_dir/ca.crt" "$pki_dir/relay.crt" >/dev/null 2>&1; then
			die "The folder must hold ca.crt, relay.crt and a matching relay.key, and relay.crt must come from ca.crt."
		fi
	fi
	if [ -n "$ca_file" ]; then
		local ctext
		ctext=$(openssl x509 -in "$ca_file" -noout -text 2>/dev/null || true)
		if ! grep -q 'CA:TRUE' <<<"$ctext" || ! grep -Eq 'prime256v1|P-256' <<<"$ctext" ||
			! openssl verify -CAfile "$ca_file" "$ca_file" >/dev/null 2>&1 || grep -q 'PRIVATE KEY' "$ca_file"; then
			die "The CA file must be a self-signed P-256 CA certificate (ca.crt), never its key."
		fi
	fi
	ca_id() { openssl x509 -in "$1" -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum | awk '{ print "m_" substr($1, 1, 32) }'; }

	# Reruns (5.7), with the image of the earlier run.
	local mode=full old_image=""
	[ -f "$P$D/image" ] && old_image=$(cat "$P$D/image")
	if [ -f "$P$D/deployed-by" ] && [ -n "$old_image" ] && vhas "$old_image" "$STATE/fleet.json"; then
		local url inst
		url=$({ vcat "$old_image" "$STATE/fleet.json" 2>/dev/null || true; } | { grep -o '"fleetUrl"[[:space:]]*:[[:space:]]*"[^"]*"' || true; } | awk -F'"' 'NR == 1 { print $4 }')
		if [ "$url" != "$console" ]; then
			say "This relay belongs to another Admin Console (${url:-unknown}). Nothing was changed."
			return 1
		fi
		inst=$({ docker run --rm "$old_image" lucid-relay --version 2>/dev/null || true; } | awk 'NR == 1 { print $NF }')
		if [ -n "$version" ] && [ -n "$inst" ] && [ "$inst" != "$version" ] &&
			[ "$(printf '%s\n%s\n' "$inst" "$version" | sort -V | awk 'NR == 1')" = "$version" ]; then
			say "This host runs version $inst, newer than $version. Nothing was changed."
			return 1
		fi
		mode=update
	fi

	LUCID_TMP=$(mktemp -d)
	mkdir -p "$P$D"
	chmod 0750 "$P$D"
	chown root:root "$P$D"
	if [ ! -f "$P$D/deployed-by" ] || [ "$(cat "$P$D/deployed-by")" != installed ]; then
		say installing >"$P$D/deployed-by"
	fi

	# ---- the program (5.2 step 4) ----
	local ctx="$P$D" got why
	if [ -n "$binary" ]; then
		cp -f "$binary" "$ctx/lucid-relay.new"
	else
		curl -fsS --proto =https -k --pinnedpubkey "$pins" -o "$ctx/lucid-relay.new" "$console/fleet/v1/install/lucid-relay?e=$enrollment"
	fi
	got=$(sha256sum "$ctx/lucid-relay.new" | awk '{ print $1 }')
	if [ -n "$binary" ]; then say "Relay program SHA-256: $got. It must match your release notes."; fi
	if [ "$got" != "$sha" ]; then
		rm -f "$ctx/lucid-relay.new"
		die "The downloaded relay program does not match SHA-256 $sha. Nothing was installed."
	fi
	chmod 0755 "$ctx/lucid-relay.new"
	if ! why=$("$ctx/lucid-relay.new" --version 2>&1); then
		rm -f "$ctx/lucid-relay.new"
		die "The relay program does not run on this host: $why"
	fi
	mv -f "$ctx/lucid-relay.new" "$ctx/lucid-relay"

	# ---- the wrappers (R3-L2, R4-L1) ----
	cat >"$ctx/lucid-relay-run" <<'EOF'
#!/bin/sh
# Runs the relay as a child and forwards TERM and INT to it. When the relay exits 78 (a configuration
# it refuses), it logs once and sleeps instead of exiting, so the container stays up without a restart
# loop; any other exit is passed through.
child=""
trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi' TERM INT
"$@" &
child=$!
wait "$child"
rc=$?
while kill -0 "$child" 2>/dev/null; do
	wait "$child"
	rc=$?
done
if [ "$rc" -eq 78 ]; then
	echo "lucid-relay-run: the relay exited 78; see its words above. Waiting without a restart." >&2
	sleep infinity &
	child=$!
	wait "$child"
	exit 0
fi
exit "$rc"
EOF
	cat >"$ctx/lucid-turn" <<'EOF'
#!/bin/sh
# Runs coturn as a child, forwards TERM and INT to it, and restarts it when the relay certificate
# changes (checked every 60 s).
conf=/etc/lucid-meet/turnserver.conf
crt=/var/lib/lucid-meet/pki/current/relay.crt
child=""
pause=""
stop=0
trap 'stop=1; for p in $child $pause; do kill -TERM "$p" 2>/dev/null; done' TERM INT
sum() { sha256sum "$crt" 2>/dev/null | cut -d " " -f 1; }
while [ "$stop" = 0 ]; do
	last=$(sum)
	turnserver -c "$conf" &
	child=$!
	while [ "$stop" = 0 ] && kill -0 "$child" 2>/dev/null; do
		sleep 60 &
		pause=$!
		wait "$pause"
		pause=""
		if [ "$stop" = 0 ] && [ "$(sum)" != "$last" ]; then
			kill -TERM "$child" 2>/dev/null
			break
		fi
	done
	wait "$child"
	rc=$?
	child=""
	[ "$stop" = 0 ] || exit "$rc"
	sleep 1
done
EOF
	chmod 0755 "$ctx/lucid-relay-run" "$ctx/lucid-turn"
	cat >"$ctx/Dockerfile" <<EOF
FROM debian:13-slim@$DEBIAN_DIGEST
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates coturn && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin lucid && mkdir -p $ETC $STATE && chown 10001:10001 $ETC $STATE
COPY lucid-relay /usr/local/bin/lucid-relay
COPY lucid-relay-run /usr/local/bin/lucid-relay-run
COPY lucid-turn /usr/local/bin/lucid-turn
USER 10001
EOF
	cat >"$ctx/.dockerignore" <<'EOF'
*
!lucid-relay
!lucid-relay-run
!lucid-turn
EOF
	docker build -t "$image" "$ctx"
	say "$image" >"$P$D/image"

	# ---- volumes, given to uid 10001 once ----
	local vol
	for vol in "$VOL_ETC" "$VOL_STATE"; do
		if ! docker volume inspect "$vol" >/dev/null 2>&1; then
			docker volume create "$vol" >/dev/null
			docker run --rm --user 0 -v "$vol:/v" "$image" chown -R 10001:10001 /v
		fi
	done

	# ---- TURN secret (kept on every rerun) ----
	if ! vhas "$image" "$ETC/turn.secret"; then
		od -An -N32 -tx1 /dev/urandom | tr -d ' \n' | vput "$image" "$ETC/turn.secret"
	fi

	# ---- own certificate or the organization CA ----
	if [ -n "$pki_dir" ]; then
		docker run --rm --user 10001 "${vols[@]}" "$image" mkdir -p "$STATE/pki/placed"
		vput "$image" "$STATE/pki/ca.crt" <"$pki_dir/ca.crt"
		vput "$image" "$STATE/pki/placed/relay.crt" <"$pki_dir/relay.crt"
		vput "$image" "$STATE/pki/placed/relay.key" <"$pki_dir/relay.key"
		if [ -f "$pki_dir/crl.pem" ]; then vput "$image" "$STATE/pki/crl-root.pem" <"$pki_dir/crl.pem"; fi
		docker run --rm --user 10001 "${vols[@]}" "$image" sh -c 'ln -sfn placed "$1/pki/current.new" && mv -Tf "$1/pki/current.new" "$1/pki/current"' sh "$STATE"
		say "Organization CA on this host: $(ca_id "$pki_dir/ca.crt")."
	elif [ -n "$ca_file" ]; then
		docker run --rm --user 10001 "${vols[@]}" "$image" mkdir -p "$STATE/pki"
		vput "$image" "$STATE/pki/ca.crt" <"$ca_file"
		say "Organization CA on this host: $(ca_id "$ca_file")."
	fi

	# ---- enroll ----
	if [ "$mode" = full ]; then
		compose down >/dev/null 2>&1 || true
		docker run --rm --user 10001 "${vols[@]}" "$image" rm -f "$STATE/fleet-pending.json" "$ETC/deploy.env"
		local run_image="$image"
		# The installer marker (R2-M1): only in a one-shot enroll image, only with no --binary.
		if [ -n "$enrollment" ] && [ -z "$binary" ]; then
			local ectx="$LUCID_TMP/enroll"
			mkdir -p "$ectx"
			printf '{"enrollment": "%s", "sha256": "%s", "at": %s}\n' "$enrollment" "$sha" "$(date +%s)" >"$ectx/lucid-deploy"
			cat >"$ectx/Dockerfile" <<EOF
FROM $image
USER 0
COPY lucid-deploy /usr/local/lib/lucid-deploy
RUN chown 0:0 /usr/local/lib/lucid-deploy && chmod 0444 /usr/local/lib/lucid-deploy
USER 10001
EOF
			run_image="$image-enroll"
			LUCID_RM_IMAGE="$run_image"
			docker build -t "$run_image" "$ectx"
		fi
		local -a eargs=(lucid-relay meet enroll "$console" --config "$ETC/relay.json" --deploy docker --profile standard)
		if [ -n "$pki_dir" ]; then eargs+=(--pki own); else eargs+=(--pki console); fi
		[ -n "$admins" ] && eargs+=(--admins "$admins")
		[ -n "$host" ] && eargs+=(--host "$host")
		[ -n "$turn_host" ] && eargs+=(--turn-host "$turn_host")
		eargs+=(--deploy-env-out "$ETC/deploy.env")
		local -a cmount=()
		if [ -n "$code_file" ]; then
			local cdir="$LUCID_TMP/code"
			mkdir -p "$cdir"
			cp "$code_file" "$cdir/code"
			chmod 0700 "$cdir"; chmod 0600 "$cdir/code"
			chown 10001:10001 "$cdir" "$cdir/code"
			cmount=(-v "$cdir:/run/code")
			eargs+=(--code-file /run/code/code)
		fi
		local erc=0
		if tty_ok; then
			docker run --rm -it --user 10001 "${vols[@]}" "${cmount[@]}" "$run_image" "${eargs[@]}" </dev/tty >/dev/tty 2>&1 || erc=$?
		else
			docker run --rm -i --user 10001 "${vols[@]}" "${cmount[@]}" "$run_image" "${eargs[@]}" </dev/null || erc=$?
		fi
		if [ -n "$code_file" ]; then rm -f "$code_file"; fi
		if [ "$run_image" != "$image" ]; then
			docker image rm -f "$run_image" >/dev/null 2>&1 || true
			LUCID_RM_IMAGE=""
		fi
		[ "$erc" = 0 ] || exit 1
	fi
	{ vcat "$image" "$ETC/deploy.env" 2>/dev/null || true; } >"$LUCID_TMP/deploy.env"
	read_env "$LUCID_TMP/deploy.env" || true
	[ -n "$d_host" ] || d_host=$host
	[ -n "$d_turn" ] || d_turn=${turn_host:-$d_host}

	# ---- coturn: no host firewall of ours here, so the host's own addresses are denied peers ----
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
cert=$STATE/pki/current/relay.crt
pkey=$STATE/pki/current/relay.key
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
			say "denied-peer-ip=$a"
		done < <(host_addrs)
		if [ -n "$external" ]; then say "external-ip=$external"; fi
		cat <<'EOF'
# Logs go to the container's output (docker compose logs turn). No verbose: that logs every request.
log-file=stdout
simple-log
pidfile=/tmp/turnserver.pid
EOF
	}
	local secret
	secret=$(vcat "$image" "$ETC/turn.secret")
	turn_conf "$secret" "$d_host" | vput "$image" "$ETC/turnserver.conf"
	say "This installer did not write a firewall here, so TURN may not relay to this host's own addresses. Calls between two people who both need TURN fail until you open UDP 49160 to 49260 toward $(host_addrs | paste -sd, - | sed 's/,/, /g') in your firewall and run again with --allow-peer for those addresses."

	# ---- compose.yaml ----
	cat >"$P$D/compose.yaml" <<EOF
name: $PROJECT
services:
  relay:
    image: $image
    entrypoint: ["/usr/local/bin/lucid-relay-run"]
    command: ["lucid-relay", "meet", "--config", "$ETC/relay.json"]
    init: true
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    ports:
      - "443:443"
    sysctls:
      net.ipv4.ip_unprivileged_port_start: 0
    volumes:
      - $VOL_ETC:$ETC
      - $VOL_STATE:$STATE
  turn:
    image: $image
    entrypoint: ["/usr/local/bin/lucid-turn"]
    init: true
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    network_mode: host
    volumes:
      - $VOL_ETC:$ETC:ro
      - $VOL_STATE:$STATE:ro
volumes:
  $VOL_ETC:
    external: true
  $VOL_STATE:
    external: true
EOF

	# ---- start and wait ----
	compose up -d
	say "Starting the relay and joining the console..."
	local _n out
	for _n in $(seq 1 60); do
		if out=$(compose exec -T relay lucid-relay meet fleet status --config "$ETC/relay.json" --fingerprint 2>/dev/null) && [ -n "$out" ]; then
			say "Relay fingerprint: $out"
			say "In the Admin Console, check that it shows the same fingerprint, then press Confirm relay."
			say installed >"$P$D/deployed-by"
			if [ "$mode" = update ]; then
				say "This relay already belongs to this Admin Console. Updated the program to $version and restarted it."
			else
				say "Done. Relay https://$d_host on TCP 443; TURN $d_turn on UDP and TCP 3478, TCP 5349 and UDP 49160 to 49260."
			fi
			return 0
		fi
		sleep 2
	done
	say "The relay did not join within 2 minutes. Last log lines:"
	compose logs --tail 30 relay 2>/dev/null || true
	return 1
}
{ main "$@"; exit $?; }
