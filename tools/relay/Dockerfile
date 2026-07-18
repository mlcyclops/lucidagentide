# Copyright (c) 2026 TechLead 187 LLC
# SPDX-License-Identifier: BUSL-1.1

# tools/relay/Dockerfile — P-COLLAB.9 (ADR-0195): the standalone LUCID collab relay broker.
# A dumb, dependency-free ciphertext forwarder on Bun. Build from the REPO ROOT:
#   docker build -f tools/relay/Dockerfile -t lucid-collab-relay .
#   docker run --rm -p 8790:8790 lucid-collab-relay
# For wss:// directly, mount a cert + key and set TLS_CERT / TLS_KEY (see tools/relay/README.md).

FROM oven/bun:1-alpine

WORKDIR /app

# The relay/auth/presence modules use only Bun/WebCrypto/fetch, and serve.ts only adds node:fs. No
# `bun install`, no node_modules: a tiny, auditable image. Telemetry remains off unless explicitly enabled.
COPY desktop/collab/relay_server.ts ./desktop/collab/relay_server.ts
COPY desktop/collab/relay_auth.ts ./desktop/collab/relay_auth.ts
COPY desktop/collab/relay_presence.ts ./desktop/collab/relay_presence.ts
COPY tools/relay/serve.ts ./tools/relay/serve.ts

ENV HOST=0.0.0.0 \
    PORT=8790 \
    MAX_ROOMS=256 \
    MAX_PEERS_PER_ROOM=16 \
    IDLE_TIMEOUT_SEC=120

EXPOSE 8790

# Aggregate-count health probe (never exposes a roomId, key, or session bytes).
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

USER bun
ENTRYPOINT ["bun", "run", "tools/relay/serve.ts"]
