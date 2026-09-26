# Self-hosted models behind one secure NGINX endpoint (P-LOCAL.4)

This is the reference for pointing LUCID at several models you host on your own
hardware (a Mac Studio M3 Ultra, an NVIDIA DGX Spark) through a **single, secured
NGINX port**. On LUCID's side the whole rig is **one Local Provider**: one base
URL, one token (kept in the OS-encrypted vault), and many models. The
OpenAI-compatible `model` field selects which backend NGINX routes the request to.

> Never use em dashes anywhere in this repo (house style). Config below is
> illustrative and first-party; adjust hostnames, ports, and model ids to match
> your boxes.

## Why one endpoint

- **One thing to trust.** LUCID talks to a single TLS origin with one bearer
  token, not N backends with N credentials. The token lives in the vault; LUCID
  hands omp only an env-var NAME, never the value (see `desktop/local_providers.ts`).
- **One thing to allow-list.** The endpoint's host is a single entry in the
  network whitelist (internal zone for a LAN/VPN box).
- **Swap backends without touching LUCID.** Add or move a model behind NGINX; in
  LUCID you just edit the comma-separated model list on the one provider.

## Topology

```
                          (LAN / VPN only, TLS + bearer)
  LUCID  ->  https://studio.local:8443/v1  (NGINX)
                              |
        route by ?model= / path to the right local backend:
                              |
        +---------------------+-----------------------+
        |                     |                       |
  llama.cpp :8081       vLLM :8000            Ollama :11434
  laguna-2.1-poolside   qwen3.8               gemma-4
  (127.0.0.1 only)      (127.0.0.1 only)      (127.0.0.1 only)
```

Every backend binds to `127.0.0.1` only. NGINX is the ONLY listener exposed to
the LAN/VPN, and it enforces TLS + auth before proxying to a loopback backend.

## Which models fit which box (editorial, quantized)

| Model | Mac Studio M3 Ultra (up to 512GB unified) | NVIDIA DGX Spark (128GB unified) |
|---|---|---|
| Laguna 2.1 (Poolside) | yes | yes |
| Gemma 4 | yes | yes |
| Qwen 3.8 | yes | yes |
| Qwen3 Coder 30B | yes | yes |
| Llama 3.3 70B | yes | yes |
| gpt-oss 120B | yes | tight; use a smaller quant |
| DeepSeek V3.2 | large; pick a quant that fits | no |

These mirror `desktop/renderer/local_presets.ts` (the one-click chips in
Settings -> Local Providers). The ids are starting points; edit them to match what
your server actually serves.

## NGINX: one TLS port, token-gated, model-routed

`/etc/nginx/conf.d/lucid-llm.conf`:

```nginx
# Map the OpenAI-compatible `model` (sent in the JSON body, mirrored into a var by
# the app or a small auth service) OR a path prefix to a local backend. Simplest is
# path-based routing; keep each backend on loopback.
upstream laguna { server 127.0.0.1:8081; }
upstream qwen   { server 127.0.0.1:8000; }
upstream gemma  { server 127.0.0.1:11434; }

server {
  listen 8443 ssl;
  server_name studio.local;

  # TLS: a real cert, or an internal CA you trust on your machines.
  ssl_certificate     /etc/nginx/certs/studio.crt;
  ssl_certificate_key /etc/nginx/certs/studio.key;
  ssl_protocols       TLSv1.3;

  # Bearer-token gate: the SAME token LUCID stores in its vault. Reject anything else
  # before it reaches a backend. (For stronger auth, terminate mTLS instead.)
  set $ok 0;
  if ($http_authorization = "Bearer REPLACE_WITH_YOUR_TOKEN") { set $ok 1; }
  if ($ok = 0) { return 401; }

  # Bind the public listener to your LAN/VPN interface only (not 0.0.0.0 on the WAN).
  # e.g. `listen 10.0.0.10:8443 ssl;` on the VPN address.

  client_max_body_size 32m;              # room for large prompts / images
  proxy_read_timeout   600s;             # long generations
  proxy_buffering      off;              # stream tokens through

  # One OpenAI-compatible surface. Route by a path segment per model family:
  location /v1/laguna/ { proxy_pass http://laguna/v1/; }
  location /v1/qwen/   { proxy_pass http://qwen/v1/; }
  location /v1/gemma/  { proxy_pass http://gemma/v1/; }

  # ...or a single /v1/ that a tiny router (or the backend's own model field) fans out.
}
```

Serving each backend (examples, first-party):

```bash
# llama.cpp - Laguna on 8081, loopback only
llama-server -m ./laguna-2.1-poolside.gguf --host 127.0.0.1 --port 8081 --api-key ""

# vLLM - Qwen on 8000, loopback only
vllm serve Qwen/Qwen3.8 --host 127.0.0.1 --port 8000

# Ollama - Gemma (Ollama listens on 127.0.0.1:11434 by default)
ollama run gemma-4
```

## Wiring it into LUCID (no code)

1. Open the **Provider Hub** (composer picker footer, command palette, or Settings ->
   Providers) -> **Local & self-hosted** -> **Add local & self-hosted models**.
2. In **Settings -> Local Providers**, click the preset chips for the models you
   serve (Laguna 2.1, Gemma 4, Qwen 3.8, ...). Each click appends its id to the
   models field, so several models sit behind ONE provider.
3. Set the **Base URL** to your NGINX endpoint, e.g. `https://studio.local:8443/v1`.
4. Leave auth on **Bearer token**, paste the token (it goes straight to the
   OS-encrypted vault; LUCID stores only an opaque `vaultRef`).
5. Leave "public internet (external)" **off** for a LAN/VPN/localhost box (it is
   whitelisted in the internal zone). Restart LUCID to apply.

The models then appear in the picker and route through NGINX to the right backend.

## Security checklist

- TLS on the NGINX port; backends bound to `127.0.0.1` only.
- A bearer token (or mTLS) enforced at NGINX before any proxy_pass.
- The public listener bound to the LAN/VPN interface, never `0.0.0.0` on the WAN.
- The token in LUCID's vault only; never in the models file or a text field
  (`scanForInlineSecret` refuses a def with a pasted key).
- The endpoint host allow-listed in LUCID's network whitelist (internal zone).
