# shellcheck shell=bash disable=SC2154,SC2034,SC1090,SC1091
# Lucid relay installer body: Remote Spokes in Docker (contract AC-2b-D 5.5, 5.7 to 5.9). Standard only.
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
	local D=/opt/lucid-relay-docker/spokes LOCK=/run/lucid-relay-deploy.lock
	local ETC=/etc/lucid-relay STATE=/var/lib/lucid-relay
	local VOL_ETC=lucid-spokes-etc VOL_STATE=lucid-spokes-state PROJECT=lucid-spokes
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
	local action=install purge=0 profile="" host="" clients="" root_file="" code_file="" binary=""
	while [ $# -gt 0 ]; do
		case "$1" in
		install | uninstall) action=$1; shift ;;
		--purge) purge=1; shift ;;
		--profile) need $#; profile=$2; shift 2 ;;
		--host) need $#; host=$2; shift 2 ;;
		--clients) need $#; clients=$2; shift 2 ;;
		--root) need $#; root_file=$2; shift 2 ;;
		--code-file) need $#; code_file=$2; shift 2 ;;
		--binary) need $#; binary=$2; shift 2 ;;
		*) die "$W_USAGE" ;;
		esac
	done
	case "$profile" in "" | high | standard) ;; *) die "$W_USAGE" ;; esac
	if [ "$purge" = 1 ] && [ "$action" != uninstall ]; then die "$W_USAGE"; fi
	local v c
	for v in "$host" "$clients"; do safe "$v" || die "$W_USAGE"; done
	if [ -n "$clients" ]; then
		for c in ${clients//,/ }; do cidr_ok "$c" || die "$W_USAGE"; done
	fi

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
				compose exec -T relay lucid-relay fleet leave --state "$STATE" || rc=$?
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
	if [ -n "$root_file" ]; then
		local rtext
		rtext=$(openssl pkey -pubin -in "$root_file" -noout -text 2>/dev/null || true)
		if ! grep -q 'BEGIN PUBLIC KEY' "$root_file" 2>/dev/null || grep -q 'PRIVATE KEY' "$root_file" ||
			! grep -Eq 'prime256v1|P-256' <<<"$rtext"; then
			die "The root file must be a P-256 public key (root.pub), never the private key."
		fi
	fi

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

	# ---- the wrapper (R3-L2, R4-L1) ----
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
	chmod 0755 "$ctx/lucid-relay-run"
	cat >"$ctx/Dockerfile" <<EOF
FROM debian:13-slim@$DEBIAN_DIGEST
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin lucid && mkdir -p $ETC $STATE && chown 10001:10001 $ETC $STATE
COPY lucid-relay /usr/local/bin/lucid-relay
COPY lucid-relay-run /usr/local/bin/lucid-relay-run
USER 10001
EOF
	cat >"$ctx/.dockerignore" <<'EOF'
*
!lucid-relay
!lucid-relay-run
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

	# ---- the organization root ----
	if [ -n "$root_file" ]; then
		docker run --rm --user 10001 "${vols[@]}" "$image" mkdir -p "$STATE/deploy"
		vput "$image" "$STATE/deploy/root.pub" <"$root_file"
		say "Organization root on this host: $(openssl pkey -pubin -in "$root_file" -outform DER | sha256sum | awk '{ print "n_" substr($1, 1, 32) }')."
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
		local -a eargs=(lucid-relay enroll "$console" --state "$STATE" --deploy docker --profile standard)
		[ -n "$host" ] && eargs+=(--host "$host")
		[ -n "$clients" ] && eargs+=(--clients "$clients")
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

	# ---- TLS (kept on rerun): the key is made in a temporary folder and goes only into the volume ----
	if ! vhas "$image" "$ETC/tls/relay.key"; then
		local san="DNS:$d_host"
		if [[ $d_host =~ ^[0-9.]+$ || $d_host == *:* ]]; then san="IP:${d_host#[}"; san=${san%]}; fi
		openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 397 \
			-keyout "$LUCID_TMP/relay.key" -out "$LUCID_TMP/relay.crt" -subj "/CN=$d_host" \
			-addext "basicConstraints=critical,CA:FALSE" -addext "extendedKeyUsage=serverAuth" -addext "subjectAltName=$san" 2>/dev/null
		docker run --rm --user 10001 "${vols[@]}" "$image" mkdir -p "$ETC/tls"
		vput "$image" "$ETC/tls/relay.crt" <"$LUCID_TMP/relay.crt"
		vput "$image" "$ETC/tls/relay.key" <"$LUCID_TMP/relay.key"
		rm -f "$LUCID_TMP/relay.key"
	fi

	# ---- compose.yaml ----
	cat >"$P$D/compose.yaml" <<EOF
name: $PROJECT
services:
  relay:
    image: $image
    entrypoint: ["/usr/local/bin/lucid-relay-run"]
    command: ["lucid-relay", "relay", "serve", "--root", "$STATE/deploy/root.pub", "--license", "$STATE/license.lic", "--host", "0.0.0.0", "--port", "8443", "--tls-cert", "$ETC/tls/relay.crt", "--tls-key", "$ETC/tls/relay.key", "--state", "$STATE", "--console-profile", "standard"]
    init: true
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    ports:
      - "8443:8443"
    volumes:
      - $VOL_ETC:$ETC
      - $VOL_STATE:$STATE
volumes:
  $VOL_ETC:
    external: true
  $VOL_STATE:
    external: true
EOF

	# ---- start and wait ----
	compose up -d
	say "Starting the relay and joining the console..."
	local _n out pin
	for _n in $(seq 1 60); do
		if out=$(compose exec -T relay lucid-relay fleet status --state "$STATE" --fingerprint 2>/dev/null) && [ -n "$out" ]; then
			say "Relay fingerprint: $out"
			say "In the Admin Console, check that it shows the same fingerprint, then press Confirm relay."
			say installed >"$P$D/deployed-by"
			if [ "$mode" = update ]; then
				say "This relay already belongs to this Admin Console. Updated the program to $version and restarted it."
			else
				pin=$({ vcat "$image" "$ETC/tls/relay.crt" || true; } | openssl x509 -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum | awk '{ print $1 }')
				say "Done. Relay https://$d_host:8443. Add this entry to your hubs' relay directory:"
				printf '{"url": "https://%s:8443", "spkiSha256": "%s"}\n' "$d_host" "$pin"
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
