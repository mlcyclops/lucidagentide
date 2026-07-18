<!--
Copyright (c) 2026 TechLead 187 LLC
SPDX-License-Identifier: BUSL-1.1
-->

# LUCID collab relay broker (P-COLLAB.9 / ADR-0195)

A tiny, self-hostable **rendezvous** for LUCID live-session collaboration. It is the same relay the desktop app
can embed (`desktop/collab/relay_server.ts`), packaged to run **headless** so it can live somewhere both peers
can reach: your own box, an office server, or a **DGX Spark / Ubuntu 24 jumpbox**.

It is the coordination point **both** transports need:

- **Relay path** — host and guests connect to the broker; it forwards frames between them.
- **WebRTC P2P path** (ADR-0194) — the broker only relays the SDP/ICE **handshake**, then the peers go
  **direct** and the broker sees nothing more.

## Why it exists

A relay bound to `127.0.0.1` reaches only the same machine. To let a *different person* watch your session you
need a point both sides can reach. On a LAN/VPN you can bind a reachable IP directly; across the internet (or
between segmented networks) a shared broker is the clean answer. This one is **yours** — no third party.

## Security model

- **Forwards only opaque, end-to-end-sealed frames.** The broker never holds a room key, so it **cannot read
  or forge** a session (AES-256-GCM tag + wrong-key rejection live in the clients). Even a fully-compromised
  broker learns nothing but traffic timing + `IP:port`.
- **Hard limits** bound abuse: `MAX_ROOMS`, `MAX_PEERS_PER_ROOM`, max frame bytes, idle timeout.
- **`/healthz`** exposes only aggregate counts (rooms/peers) — never a roomId, key, or session bytes.
- Pair with LUCID's managed policy **`collab.allowedRelays`** (ADR-0193) so managed clients only ever connect
  to *this* approved broker, and `collab.allowedBinds` to control who may *host* one.

## Run it

Self-contained: `desktop/collab/relay_server.ts` has **no npm dependencies**, and `serve.ts` uses only Bun +
`node:fs`. You need only those two files + [Bun](https://bun.sh).

### Directly (local addon / quick office server)

```bash
# plain ws:// on all interfaces, port 8790
bun run tools/relay/serve.ts

# custom bind + limits
HOST=0.0.0.0 PORT=8790 MAX_ROOMS=256 bun run tools/relay/serve.ts
#   or: bun run tools/relay/serve.ts --host=10.0.0.5 --port=8790
```

### wss:// directly (TLS)

```bash
PORT=443 TLS_CERT=/etc/lucid/relay.crt TLS_KEY=/etc/lucid/relay.key bun run tools/relay/serve.ts
```

### Docker (office server / DGX Spark)

```bash
docker build -f tools/relay/Dockerfile -t lucid-collab-relay .
docker run --rm -p 8790:8790 lucid-collab-relay
# TLS: mount a cert dir and point the env at it
docker run --rm -p 443:443 -e PORT=443 -e TLS_CERT=/certs/relay.crt -e TLS_KEY=/certs/relay.key \
  -v /etc/lucid/certs:/certs:ro lucid-collab-relay
```

### systemd (Ubuntu 24 jumpbox)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin lucid-relay
sudo git clone <repo> /opt/lucidagentide          # or copy just the two files above
sudo cp tools/relay/lucid-relay.service /etc/systemd/system/
sudoedit /etc/systemd/system/lucid-relay.service  # set HOST/PORT, uncomment TLS_* if serving wss:// directly
sudo systemctl enable --now lucid-relay
systemctl status lucid-relay
curl -s http://127.0.0.1:8790/healthz
```

## TLS: direct vs reverse proxy

A **browser** guest (and any prudent deployment) needs `wss://`. Two options:

1. **Direct** — set `TLS_CERT` / `TLS_KEY` (Bun terminates TLS). Simplest on a jumpbox with a public cert.
2. **Reverse proxy** — keep the relay on `ws://127.0.0.1` and terminate TLS at nginx/caddy (Let's Encrypt),
   proxying the WebSocket upgrade. Caddy example:

   ```
   relay.example.com {
       reverse_proxy 127.0.0.1:8790
   }
   ```

## Firewall

Open only the relay port to the peers who need it. On a jumpbox, prefer scoping to your VPN/office CIDR:

```bash
sudo ufw allow from 10.0.0.0/8 to any port 8790 proto tcp
```

## Point LUCID at it

In LUCID → **Share this session** → **Self-hosted relay URL**, enter `wss://relay.example.com` (or
`ws://10.0.0.5:8790` on a trusted LAN). Under managed policy, add it to `collab.allowedRelays` so clients accept
it. Hosts start a share; guests paste the invite link and connect through this broker.

## Config (env / `--flag`)

| Env | Flag | Default (standalone) | Meaning |
|---|---|---|---|
| `HOST` | `--host` | `0.0.0.0` | bind address |
| `PORT` | `--port` | `8790` | listen port |
| `TLS_CERT` | `--tls-cert` | — | PEM cert → serve `wss://` |
| `TLS_KEY` | `--tls-key` | — | PEM private key |
| `MAX_ROOMS` | — | `256` | room ceiling (DoS bound) |
| `MAX_PEERS_PER_ROOM` | — | `16` | guests per room |
| `MAX_FRAME_BYTES` | — | `524288` | max frame size (Bun drops larger) |
| `IDLE_TIMEOUT_SEC` | — | `120` | idle socket timeout |
| `RELAY_AUTH` | — | `off` | `firebase` = require a Google sign-in to rendezvous (P-REMOTE.1, ADR-0226/0227) |
| `RELAY_FIREBASE_PROJECT` | — | — | Firebase project id (required in `firebase` mode; checked as `aud`/`iss`) |
| `RELAY_ALLOWED_EMAILS` | — | — | comma list admitted WITHOUT a `premium`/`admin` claim (self-host allowlist) |
| `RELAY_JWKS_URL` | — | Google securetoken JWKS | override for tests / air-gapped mirrors |
| `RELAY_AUTH_DEADLINE_MS` | — | `5000` | ms before an unauthenticated socket is reaped (4401) |

## Identity gate (`RELAY_AUTH=firebase`)

Anonymous mode (the default) is unchanged: anyone with the room link can rendezvous — content is still
E2E-sealed, so the broker forwards only ciphertext. For a **hosted** rendezvous (ADR-0226: Cloud Run in the
`lucid-agent` project), turn the gate on: the client's **first frame** after the WS upgrade must be
`{"t":"auth","token":"<Firebase ID token>"}` — never a query param, so no bearer token ever lands in request
logs. The relay verifies RS256 against Google's securetoken JWKS with builtin WebCrypto (still zero npm
deps), requires `email_verified` + `sign_in_provider === "google.com"` (Google OAuth only), and admits on a
`premium`/`admin` custom claim (the paid tier / the host account, ADR-0227) or an `RELAY_ALLOWED_EMAILS`
entry. Refusals are fatal close codes: `4401` invalid/missing auth, `4403` signed-in-but-not-entitled,
`4429` per-user quota (rooms per uid, connects/min). Every verification failure — including an unreachable
JWKS — refuses; there is no fail-open path. Authentication gates the RENDEZVOUS only: the room key still
gates reading, the write token still gates driving, and the host's own security gate still gates execution.

## Why TypeScript here (and where FastAPI fits)

This repo's language boundary is fixed (CLAUDE.md invariant #2: the only Python is the scanner sidecar), and
the relay logic is **already written + tested** in TypeScript — so packaging it is one language and zero new
attack surface. A relay is a dumb byte forwarder, not a REST/validation API, so it gains little from FastAPI.

For a **Python-first ops shop** (e.g. an ML team standing this up next to their DGX tooling), a FastAPI +
`uvicorn`/`websockets` relay implementing the *same wire protocol* (`…/r/<roomId>?role=`, `[4B BE peerId]` +
opaque payload, JSON control frames, fatal codes `4004`/`4009`/`4029`) is a straightforward drop-in and belongs
in the **private add-on repo** as enterprise deployment IP — outside this repo's language boundary. Both speak
the identical protocol, so LUCID clients connect to either without changes.
