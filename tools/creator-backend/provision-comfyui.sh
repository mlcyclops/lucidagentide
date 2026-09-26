#!/usr/bin/env bash
# Copyright (c) 2026 TechLead 187 LLC
# SPDX-License-Identifier: BUSL-1.1
#
# provision-comfyui.sh - install / update a HEADLESS ComfyUI on a remote GPU host, for use as a LUCID
# Creator backend. Runs ON that host (the local driver in setup-backend.ts copies and executes it).
#
# Design rules, all deliberate:
#   * LOOPBACK ONLY. ComfyUI has no authentication, so `--listen 0.0.0.0` would publish an unauthenticated
#     remote-code surface to the whole network. Access is an SSH tunnel or a VPN, never an open port.
#   * IDEMPOTENT. Re-running updates the checkout, reuses the venv, and restarts the unit.
#   * NO SUDO. Everything lands under $HOME with a systemd USER unit, so this never needs root.
#   * HONEST PREFLIGHT. It reports the GPU, driver, arch, and chosen wheel index BEFORE installing, and
#     refuses rather than guessing when the machine has no NVIDIA GPU.
#
# Usage (on the remote host):
#   bash provision-comfyui.sh [--port 8188] [--dir ~/comfyui] [--dry-run] [--no-systemd] [--dcgm]
#                             [--torch-index URL] [--skip-torch]
#
# Notes on hardware: a Grace-Blackwell GB10 is aarch64 and sm_121, which needs CUDA 13 wheels. This script
# selects the cu130 PyTorch index by default for exactly that reason; pass --torch-index to override, or
# --skip-torch when you already run an NGC container that ships torch.

set -euo pipefail

PORT=8188
DIR="$HOME/comfyui"
DRY_RUN=0
USE_SYSTEMD=1
WITH_DCGM=0
SKIP_TORCH=0
TORCH_INDEX="https://download.pytorch.org/whl/cu130"
UNIT_NAME="lucid-comfyui"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --torch-index) TORCH_INDEX="${2:?--torch-index needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-systemd) USE_SYSTEMD=0; shift ;;
    --dcgm) WITH_DCGM=1; shift ;;
    --skip-torch) SKIP_TORCH=1; shift ;;
    -h|--help) sed -n '5,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) echo "provision: --port must be a number" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "provision: --port must be between 1 and 65535" >&2
  exit 2
fi

say() { printf '[provision] %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[provision:dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# ── preflight ───────────────────────────────────────────────────────────────

ARCH="$(uname -m)"
say "host: $(uname -s) $ARCH, $(hostname)"

if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_LINE="$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null | head -n1 || true)"
  say "gpu: ${GPU_LINE:-nvidia-smi answered with no devices}"
else
  echo "provision: no nvidia-smi on this host. ComfyUI needs an NVIDIA GPU; refusing rather than installing a CPU-only stack you did not ask for." >&2
  exit 1
fi

for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "provision: $tool is required and not on PATH" >&2; exit 1; }
done
say "python: $(python3 --version 2>&1)"

if [ "$SKIP_TORCH" -eq 0 ]; then
  say "torch wheels: $TORCH_INDEX"
  if [ "$ARCH" = "aarch64" ] && [ "$TORCH_INDEX" = "https://download.pytorch.org/whl/cu130" ]; then
    say "aarch64 detected: cu130 is the index that carries ARM CUDA 13 wheels (Blackwell sm_121 needs CUDA 13)"
  fi
else
  say "torch install skipped by request (use this inside an NGC container that already ships torch)"
fi

# ── checkout ────────────────────────────────────────────────────────────────

if [ -d "$DIR/.git" ]; then
  say "updating existing checkout at $DIR"
  run git -C "$DIR" fetch --depth 1 origin
  run git -C "$DIR" reset --hard origin/HEAD
else
  say "cloning ComfyUI into $DIR"
  run git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$DIR"
fi

# ── venv + dependencies ─────────────────────────────────────────────────────

VENV="$DIR/.venv"
if [ -x "$VENV/bin/python" ]; then
  say "reusing venv at $VENV"
else
  say "creating venv at $VENV"
  run python3 -m venv "$VENV"
fi
PY="$VENV/bin/python"

run "$PY" -m pip install --upgrade pip
if [ "$SKIP_TORCH" -eq 0 ]; then
  run "$PY" -m pip install torch torchvision torchaudio --index-url "$TORCH_INDEX"
fi
run "$PY" -m pip install -r "$DIR/requirements.txt"

if [ "$DRY_RUN" -eq 0 ] && [ "$SKIP_TORCH" -eq 0 ]; then
  say "torch check:"
  "$PY" - <<'PYCHECK' || say "torch could not report a device (see the error above); ComfyUI will fall back to CPU or fail to start"
import torch
print(f"[provision]   torch {torch.__version__}, cuda available={torch.cuda.is_available()}", flush=True)
if torch.cuda.is_available():
    print(f"[provision]   device 0: {torch.cuda.get_device_name(0)} (capability {'.'.join(map(str, torch.cuda.get_device_capability(0)))})", flush=True)
PYCHECK
fi

# ── launch flags ────────────────────────────────────────────────────────────
# Grace-Blackwell shares one coherent memory fabric, so forcing everything GPU-side hurts. These flags are
# the community-recommended baseline for that shape; they are harmless on a discrete GPU.
COMFY_FLAGS=(--listen 127.0.0.1 --port "$PORT" --disable-pinned-memory --force-fp16 --fp16-unet --fp16-vae --fp16-text-enc)
say "launch flags: ${COMFY_FLAGS[*]}"

# ── systemd user unit ───────────────────────────────────────────────────────

if [ "$USE_SYSTEMD" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_FILE="$UNIT_DIR/$UNIT_NAME.service"
  say "writing $UNIT_FILE"
  if [ "$DRY_RUN" -eq 0 ]; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=ComfyUI (LUCID Creator backend, loopback only)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$PY $DIR/main.py ${COMFY_FLAGS[*]}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  else
    printf '[provision:dry-run] would write the unit with ExecStart=%s %s/main.py %s\n' "$PY" "$DIR" "${COMFY_FLAGS[*]}"
  fi
  run systemctl --user daemon-reload
  run systemctl --user enable "$UNIT_NAME"
  run systemctl --user restart "$UNIT_NAME"
  # Without linger the unit dies when the SSH session ends.
  run loginctl enable-linger "$USER"
  say "unit: systemctl --user status $UNIT_NAME"
  say "logs: journalctl --user -u $UNIT_NAME -f"
else
  say "systemd not used. Start it yourself with:"
  say "  cd $DIR && $PY main.py ${COMFY_FLAGS[*]}"
fi

# ── optional: DCGM exporter for LUCID's remote GPU odometer ─────────────────

if [ "$WITH_DCGM" -eq 1 ]; then
  if command -v docker >/dev/null 2>&1; then
    say "starting the DCGM exporter on 127.0.0.1:9400 (LUCID reads it as a remote monitoring target)"
    run docker rm -f lucid-dcgm-exporter
    run docker run -d --restart unless-stopped --gpus all --name lucid-dcgm-exporter \
      -p 127.0.0.1:9400:9400 nvcr.io/nvidia/k8s/dcgm-exporter:latest
  else
    say "docker is not on PATH, so the DCGM exporter was NOT started. Install it, or run the exporter"
    say "natively, then register http://127.0.0.1:9400/metrics as a LUCID remote target."
  fi
fi

# ── summary ─────────────────────────────────────────────────────────────────

say ""
say "ComfyUI is provisioned on loopback: http://127.0.0.1:$PORT"
say "It is NOT reachable from the network by design (no auth in ComfyUI)."
say "From your workstation, tunnel it:"
say "  ssh -N -L $PORT:127.0.0.1:$PORT <this-host>"
say "Then in LUCID: Creator Studio -> ComfyUI -> Connect, base URL http://127.0.0.1:$PORT, zone internal."
say "Models go in $DIR/models/checkpoints (LUCID's dropdown reads whatever is there)."
