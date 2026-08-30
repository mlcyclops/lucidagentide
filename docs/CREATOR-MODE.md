# LUCID Creator Mode

Creator is a **second flavor of LUCID built from the same branch**: same engine, same fail-closed security
gate, same omp. It installs beside the standard app, runs on its own port, keeps its own data, and adds a
Creator workspace for generative audio, video, 3D, and game work.

Status: **CREATOR-0 (the foundation) is built.** The advanced editors and provider workflows are mapped in
ADR-0285 through ADR-0290 and are explicitly NOT built yet. This document says which is which, everywhere.

Decisions: DECISIONS.md ADR-0279 (product line) through ADR-0284 (instructions and memory), plus the
roadmap ADRs ADR-0285 to ADR-0290. Runnable proof: `make demo-CREATOR-0`.

-----

## Why a flavor and not a fork

The branch is `feature/creator-mode` and it never diverges structurally from master:

- **No omp fork** (invariant 1). Creator is env seams, new endpoints, and desktop UI.
- **No second engine.** `desktop/dev.ts` serves both flavors; the flavor decides ports and data roots.
- **No duplicated build config.** `desktop/build/electron-builder.creator.cjs` deep-clones the standard
  config from `desktop/package.json` and overrides only identity fields, so a change to packaging payload
  on master reaches Creator for free.
- **Every Creator surface is additive and gated** on `GET /api/build-info`'s `creatorBuild`, so master can
  merge in either direction without a conditional maze.

Keeping up with master: `git fetch origin && git rebase origin/master` (or merge if the branch is shared).
Conflicts are confined to the seams listed in ADR-0279's "Files touched" section.

## The two flavors, side by side

| | Standard | Creator |
| --- | --- | --- |
| App id | `com.lucidagentide.desktop` | `com.lucidcreator.desktop` |
| Product name | `LucidAgentIDE` | `LucidCreator` |
| Native port | 5319 | **5320** |
| Deep-link scheme | `lucid://` | `lucid-creator://` |
| Embedded relay port | 8790 | 8791 |
| Managed whisper port | 9111 | 9112 |
| Installer | `LucidAgent-Setup.exe` | `LucidCreator-Setup.exe` |
| Output directory | `desktop/release` | `desktop/release-creator` |
| Electron userData | `...\LucidAgentIDE` | `...\LucidCreator` |
| GUI settings | `~/.omp/lucid-gui.json` | `<Creator userData>/lucid-gui.json` |
| Personal knowledge | `~/.omp` | `<Creator userData>/personal` |
| Credential vault | `~/.omp/lucid-cred-vault` | `<Creator userData>/lucid-cred-vault` |
| Creator library | not present | `<Creator userData>/creator/library` |

Both can run at once: different app ids mean different single-instance locks, different ports mean no
collision, and different userData means the Windows `safeStorage` key is not shared (which is exactly why
the vault is separate - see ADR-0278).

**Shared, deliberately:** omp's own session store and provider OAuth under `~/.omp/agent`. No supported omp
relocation seam exists, so Creator does not pretend to isolate it. Your chat history and model logins are
common to both flavors; your GUI settings, personal knowledge, vault, and library are not.

**No data is migrated.** Creator starts empty on purpose. Re-enter provider keys in Creator; a vault blob
encrypted under the standard app's key cannot be decrypted under Creator's identity anyway.

## Running it

```
cd desktop
bun install                 # once
bun run start:creator       # native Creator app on 5320
bun run web:creator         # browser-only Creator engine on 5320
bun run dist:win:creator    # LucidCreator-Setup.exe into desktop/release-creator
```

`bun run start` / `dist:win` still build the standard Agent app, unchanged. Note that `dist/` is shared:
`build:creator` wipes it first and rebuilds with the flavor baked in, and a later standard `bun run build`
puts the Agent bundle back. Never interleave the two in one packaging run.

Overrides for a one-off run: `LUCID_BUILD_FLAVOR=creator`, `LUCID_PORT`, `LUCID_GUI_SETTINGS_FILE`,
`LUCID_PERSONAL_DIR`, `LUCID_CRED_VAULT_DIR`, `LUCID_CREATOR_DIR`, `LUCID_RELAY_PORT`, `LUCID_WHISPER_PORT`.

## Creator Mode, next to Agent Mode

In a Creator build the composer's mode control reads **Agent / Creator / Ask / Plan**. In the standard build
the Creator option does not exist in the DOM at all, and a hand-rolled `POST /api/uimode` with `creator` is
normalized to `agent` server-side.

Creator Mode's **security posture is byte-identical to Agent Mode**: omp mode `default`, permission mode
`auto`, every tool call still scanned in-process by the gate. What changes:

- the Creator Studio surface opens (integrations + library),
- the Resources tab is the default place your eye lands,
- one standing `<critical>` block is added to the USER TURN (never the frozen prefix): discover
  capabilities, never invent provider APIs, treat media metadata as data, honor resource admission, require
  consent for voice cloning, never weaken a gate.

Switch away from Creator and that block is gone on the next turn. The frozen prompt prefix is untouched, so
the KV cache is not busted (invariant 6, verified by the prefix-hash test).

## CPU and GPU pressure in the right rail

The Resources tab carries two odometer chips - CPU and GPU - each a 270 degree graduated dial with a needle
and a live percentage, coloured green under 70%, amber to 90%, red at or above the pressure line. Hover for
the machine detail; click either chip to expand the detailed flyout in place:

- per-core CPU bars (an unbalanced render is visible instead of averaged away),
- per-GPU load, VRAM used of total, temperature, and power draw of cap,
- system memory, the top processes by memory, and the pressure trend with the 90% line drawn,
- one row per target: this machine plus every remote host you registered.

### What is actually collected

| Metric | Windows | Linux | macOS |
| --- | --- | --- | --- |
| CPU aggregate + per core | yes | yes | yes |
| System memory | yes | yes | yes |
| Top processes by memory | yes (PowerShell `Get-Process`) | yes (`ps`) | yes (`ps`) |
| NVIDIA GPU load, VRAM, temp, power | yes (`nvidia-smi`) | yes (`nvidia-smi`) | not applicable |
| AMD or Intel GPU load | not collected | not collected | not applicable |
| Apple GPU load | not applicable | not applicable | not collected (needs elevated `powermetrics`) |
| Per-process GPU attribution | not collected | not collected | not collected |

Everything not collected renders as **unknown**, never as 0%. That distinction is the whole point: a dial
reading 0 tells a human "go ahead, start the 40 minute render", and LUCID will not say that about a number
it never measured.

### Remote targets (DGX Spark, GPU VMs)

Register a target in the Studio with an HTTPS URL and, if it needs one, the NAME of a vault credential:

- `dcgm-exporter` - a Prometheus text endpoint (NVIDIA DCGM exporter). LUCID reads GPU utilization, frame
  buffer used/free, temperature, and power.
- `lucid-agent` - any host that answers JSON in LUCID's shape:
  `{cpu:{busyPct,cores,model?},mem:{totalMB,freeMB},gpu:{devices:[{index,name,vendor,busyPct,memTotalMB,memUsedMB,tempC,powerW}]}}`.
  Every field is optional; a partial payload is still useful and missing fields stay unknown.

The token rides an `Authorization` header, never the URL, and never appears in an error message. Reach a
tunnel-only host by pointing at its internal address while your VPN client is up: LUCID routes to the
tunnel, it does not manage the tunnel (the ADR-0135 posture). A dead or slow target is a **blind** row with
the reason shown; it never becomes a fake reading.

### Job admission

Telemetry fails open; admission is evidence-based. A Creator job is refused only when:

- CPU, memory, or GPU has held **90% or more for 30 unbroken seconds** (a burst is free, and a cool OR
  blind sample breaks the streak), or
- a **known** VRAM requirement exceeds the largest measured GPU. The refusal names both numbers.

A job that needs a GPU on a machine with no GPU counters is admitted, but the flyout says plainly that this
is not a measured all-clear.

## The integration registry

Creator Studio lists every provider with its transports, its state, and one chip per capability carrying an
honesty label:

- **available** - an official documented API, CLI, or runtime backs it today.
- **bring your endpoint** - no public self-serve API is published, so you supply the base URL and
  credential and LUCID probes before it calls anything.
- **vendor app only** - the vendor exposes it solely inside their own web product. LUCID will not script it.
- **planned** - mapped in the roadmap ADRs, not wired in this build.

### Probes: `configured` is not `ready`

A declaration means "you told LUCID where it is". A **probe** asks the thing itself, and a provider only
reaches `ready` once something answered:

- **ComfyUI** - reads `/object_info` and attests capability from the **installed nodes**: `image` needs an
  image save/preview node, `video` needs an animation or video-combine node, `model-3d` needs a 3D node. A
  server with nodes but no output node reports *nothing proven*, not ready.
- **ElevenLabs** - reads `/v1/models`, validates the key, and maps the documented flags to capabilities.
- **dots.tts / a Suno partner endpoint** - reachability is all the probe proves, and it says exactly that.
- **Blender / Unreal** - proven by the declared executable existing; Blender's `--version` line is captured.
- **three.js** - ready by construction.

Press **Probe** on a row (or **Probe everything**). Each row then shows the verdict, its age, the latency, and
the server's own words. A probe **expires** after 15 minutes: a stale answer stops counting rather than
keeping a provider looking healthy after your VPN dropped. Only what a probe attested becomes usable, so the
catalog never doubles as a promise about *your* install.

### Jobs: every run leaves a row

Generations, sheets, GIFs, and probes are recorded in an append-only job ledger under the Creator data root.
The **Recent jobs** strip shows kind, label, state, duration, artifact count, and what the resource governor
measured when the job started. Three behaviors worth knowing:

- A job the governor **refuses** is still written down, carrying the measured reason ("system memory has been
  at 94% for 42s"), so nothing silently fails to happen.
- **Stop** is a *request*: the row reads `(stopping)` until the runner confirms, then settles as `cancelled`.
  LUCID will not claim a stop it cannot guarantee.
- A settled job is final. A slow runner cannot overwrite a `failed` with a `done`.

Registered providers, and what is true about each as of 2026:

- **ElevenLabs** - TTS, streaming synthesis, word and character timestamps, STT (Scribe), instant and
  professional voice cloning, voice design, dubbing, sound effects, music where the plan exposes it, audio
  isolation. Studio project-timeline editing is **vendor app only**. Cloud egress applies.
- **dots.tts (local)** - 2B continuous autoregressive TTS at 48 kHz, Apache-2.0, with zero-shot cloning from
  a reference clip plus transcript, on your own GPU. LUCID ships no Python for it (invariant 2): you run the
  server and register its URL. No official timestamp output.
- **Suno** - see the next section.
- **ComfyUI** - workflow submission, live progress and previews over the websocket, artifact fetch, image
  and video and 3D nodes **as installed on that server**. Capability comes from a live `/object_info` probe,
  never from an assumption. Local or remote (a VPN endpoint is an internal-zone whitelist entry).
- **three.js** - scenes in the sandboxed Preview panel with WebGL2 or WebGPU, screenshots back into chat,
  `renderer.info` as the performance budget. No install, no key, no egress.
- **Blender** - headless stills and frame ranges through the documented command line; exit code plus
  captured output is the signal. Fixed argv, path-confined output.
- **Unreal Engine** - headless builds and cooks plus the Automation Test framework from the command line.
  The editor Remote Control API is opt-in only: it is an open local control plane.

Declarations never hold secrets. A pasted secret, a credential inside a URL, or a shell string where an
executable belongs is **refused** with the reason, and nothing is stored.

## Suno and the local music library

**Suno published no public self-serve API in 2026** (its developer API is a curated partner program). LUCID
therefore does two honest things:

1. **Generation is bring-your-own-endpoint.** If you have partner access, register your base URL and the
   NAME of your token; LUCID probes capability before it calls. No Suno endpoint is hardcoded, and LUCID
   never automates the Suno web product or routes through an unofficial reseller.
2. **Everything local ships now and needs no API at all.** The Creator library gives you:
   - **Import** any render you made anywhere (mp3, wav, flac, ogg, opus, m4a, aac) with its prompt and tags.
   - **Listen** in-app.
   - **Review**: notes plus a 1 to 5 rating, stored beside the track.
   - **Tag** and retitle; edit the prompt so the next attempt starts from the truth.
   - **Remix** (new audio, same lineage) and **re-prompt** (same idea, new render), each keeping its parent
     so a chain reads oldest first.
   - **Stats**: tracks, remixes, reviewed count, bytes, and origins.

The library is an append-only JSONL ledger plus the audio files under the Creator data root: a torn tail
costs one record, never the library, and nothing leaves the machine.

## Images: generate, mix, mark up, and build

Creator Studio has two tabs: **Integrations** (above) and **Images**. The Images pane is four things.

### 1. The generator

- **Model dropdown** - read LIVE from the ComfyUI install you connected (`/object_info`, checkpoints plus
  diffusion and VAE loaders). Nothing is hardcoded: if that server has no models, the dropdown says so.
- **Prompt and negative prompt**, size, and seed (blank seed = random).
- **The mixer** - stage up to six input images, each with a **role** (`style`, `composition`, `background`,
  `mask`, ...). Paste an image straight into the pane, or press **Use as input** on any artifact. Roles bind
  by NAME, so `{{image:style}}` in your workflow always gets the image you labeled `style`.
- **Generate** runs YOUR workflow: LUCID uploads the inputs, substitutes `{{prompt}}`, `{{negative}}`,
  `{{model}}`, `{{seed}}`, `{{width}}`, `{{height}}`, and `{{image:role}}`, submits it, waits for the render,
  and imports the outputs.

To set that up once: in ComfyUI, build the graph you like and use **Save (API Format)**. Paste that JSON into
the ComfyUI endpoint's **workflow template** field in Creator Studio, replacing the values LUCID should fill
with the placeholders above. If a placeholder is left unsatisfied, LUCID **refuses to submit and names it** -
it will not guess a graph for you.

### 2. The builders (no provider, no key, no network)

Select artifacts in the grid, then:

- **Sprite sheet** - packs the selection into one PNG grid and writes two sidecars beside it: a frame
  manifest (`frameWidth`, `columns`, per-frame rects, per-frame duration) that any engine importer can read,
  and a ready-to-paste `steps()` CSS animation so you can watch the cycle immediately.
- **GIF** - encodes a looping GIF89a in-process: one deterministic global palette, a reserved transparent
  slot, LZW compression, and per-frame delays.
- **Meme** - top and bottom text, auto-fitted, wrapped, upper-cased, and stroked in the classic style over
  the picture. Text never leaves the image, and an unbreakable word is split rather than spilling out.

All three are pure TypeScript inside LUCID (`harness/creator/imaging.ts`), so they work on an air-gapped
machine and produce byte-identical output every run. The agent can call the same encoders from a script,
which is what `make demo-CREATOR-IMG` exercises.

### 3. Markup and the Preview panel

**Preview** on any artifact hands it to the existing Preview panel: the sandboxed frame with the pen,
rectangle, and text markup tools, plus **Screenshot to chat** so a marked-up image goes straight back to the
agent. Nothing new to learn, and the preview stays egress-blocked.

### 4. The artifact grid

Every image keeps its provenance: kind, dimensions, sha256, the prompt and the model that produced it, and
its sidecars. Artifacts live under `<Creator userData>/creator/artifacts` with an append-only ledger.

Limits worth knowing: 64 frames and 2048 px per edge per sheet/GIF request, 6 mixer inputs per generation,
and PNG/JPEG/WEBP only for inputs (SVG is refused as a script risk).

## Editing audio: the follow-along editor

Studio -> **Editor**. Pick a track, paste the words that are spoken in it, and press Open. The words become
chips over the waveform: the one playing lights up, tapping one seeks to it, shift-click extends the
selection into a span, and a span can be deleted, dragged somewhere else, locked to the text, split at the
playhead, or re-rendered from another take. Undo and redo are always available, and Save appends the result
as a new track whose parent is the one you edited.

What the editor will and will not claim about timing is the important part:

- **Word timings from the engine are labeled `vendor`** and carry full confidence. That is the ElevenLabs
  character-timestamp path.
- **Everything LUCID works out itself is labeled `derived` and capped at 70% confidence.** A local Whisper
  server returns text and no timings, so there is nothing to pass through: LUCID measures the audio's own
  energy, finds the speech runs against that clip's own noise floor, and distributes the words across them
  weighted by length. The note above the strip says exactly that, including how many runs it measured
  against how many words, and the chips show the weaker claim. A document that arrives labeled `derived`
  while claiming vendor-grade confidence is treated as INVALID and refuses to render.
- **A re-render replaces one span and nothing else.** Every re-rendered clip records the clip it replaced
  and the prompt that produced it, so a span's history is data. The demo proves the bytes before and after
  the span come back identical, and that undo re-renders the original file byte for byte.
- **Nothing time-stretches, and nothing transcodes.** A trim moves the source offset with the edge, so what
  you hear is always the source's own samples. The editor works on 16-bit PCM WAV; any other container is
  refused by name (`the editor works on 16-bit PCM WAV; "<title>" is audio/mpeg`) instead of being silently
  converted by a decoder this project does not ship.
- **A missing source refuses the save, by id.** Silence is what a damaged edit sounds like, so it is never
  substituted for audio the timeline asked for and could not get.

Edits are non-destructive by construction: the track you opened keeps every one of its bytes and its row in
the ledger, and the save is an append. Proof: `make demo-CREATOR-2`.

## Verifying the image path (and your backend)

`make verify-creator-comfy` drives the **real product code** against a ComfyUI-shaped fixture
(`desktop/fake_comfy_server.ts`, a test fixture that implements only the documented routes): probe →
capability attestation → upload a mixed input → substitute the workflow → submit → poll `/history` → read the
image back → store it with provenance, plus the failure paths (token required, no output node, dead endpoint).
No ComfyUI, no GPU, and no network required.

Point the same verifier at a real server once you have one:

```bash
bun run harness/scripts/verify_creator_comfy.ts --url http://127.0.0.1:8188               # probe only
bun run harness/scripts/verify_creator_comfy.ts --url http://127.0.0.1:8188 \
  --workflow ./my-graph.json --model sdxl_base.safetensors --prompt "neon alley"        # full run
```

In `--url` mode it **always** probes and reports what that install proves, but it submits a graph only when
you pass `--workflow`: LUCID does not invent workflows, not in the product and not in its own verifier. It
also never provokes the unauthorized or rejected-workflow paths against your real server.

## Running ComfyUI on a DGX Spark as the backend

A DGX Spark makes a good Creator backend: LUCID only needs ComfyUI's HTTP and WebSocket surface, so the box
can be headless and remote. Two things about that hardware shape the install, and both are documented by
NVIDIA and the community rather than assumed here:

- **GB10 is `sm_121` on `aarch64` and needs CUDA 13.** Most pip ML wheels are built against CUDA 12.x and
  x86, so the default install path fails. PyTorch publishes aarch64 `cu130` wheels
  (`--index-url https://download.pytorch.org/whl/cu130`), and the easiest route is the NGC PyTorch container
  (≥ 25.10). ([DGX Spark setup guide](https://github.com/natolambert/dgx-spark-setup),
  [ComfyUI on DGX Spark](https://blog.comfy.org/p/comfyui-on-nvidia-dgx-spark))
- **Unified memory changes the flags.** Grace-Blackwell shares one coherent fabric, so forcing everything
  GPU-side hurts. Community kits recommend `--disable-pinned-memory --force-fp16 --fp16-unet --fp16-vae
  --fp16-text-enc`. ([SparkyUI](https://github.com/ecarmen16/SparkyUI/),
  [comfyui-dgx-spark](https://github.com/Triplany/comfyui-dgx-spark))

### The scripted path

Two scripts do this, and neither hardcodes a machine name - the host is whatever your SSH config calls it:

- `tools/creator-backend/provision-comfyui.sh` runs **on the GPU host**: preflight, clone or update, venv,
  cu130 wheels, unified-memory launch flags, a systemd **user** unit (no sudo anywhere), and an optional DCGM
  exporter. Idempotent, and `--dry-run` prints without touching anything.
- `tools/creator-backend/setup-backend.ts` runs **on your workstation** and drives five phases over SSH:
  preflight, provision, tunnel, verify, register.

Always look first:

```bash
bun run tools/creator-backend/setup-backend.ts --host gpu-box --user me --dry-run
# or: make creator-backend-plan HOST=gpu-box USER_AT=me
```

That prints every command in order and executes none of them. Then do it for real:

```bash
bun run tools/creator-backend/setup-backend.ts --host gpu-box --user me --dcgm
#  ... later, with your own exported graph, for the full end-to-end check:
bun run tools/creator-backend/setup-backend.ts --host gpu-box --skip-provision --workflow ./graph.json
```

What the driver refuses to do: build a shell string (every remote call is a fixed argv, and a host, user, or
path containing shell metacharacters is rejected rather than escaped), prompt for a password
(`BatchMode=yes`, keys only), expose the remote port to the network, or put a credential on a command line.

### Two operators, one backend

One GPU box, two workstations, no shared secret. The split is deliberate:

- **One person provisions, once.** The other passes `--skip-provision`. Re-running the provisioner is safe
  and idempotent, but it ends with `systemctl --user restart`, which kills whatever the other person had in
  flight. So provisioning is a coordinated act, and everyday use is not.
- **Both use the same remote account.** The unit is a systemd USER unit lingered for that account
  (`loginctl enable-linger`), so the service belongs to one login. Each person adds their own public key to
  that account's `~/.ssh/authorized_keys`. Keys are per-person; the account and the service are shared.
  Nobody hands anybody a password: the driver runs `BatchMode=yes` and fails rather than prompting.
- **Each workstation opens its own tunnel.** `--port` is both the remote port and the local end, so two
  people can both use 8188 locally without colliding; the ports live on different machines. The remote still
  listens only on `127.0.0.1`, which is what keeps an unauthenticated ComfyUI off the network.
- **The queue is the contention point.** ComfyUI runs a single prompt queue: submissions arriving through
  either tunnel land in the same queue and execute in arrival order, not in parallel. Expect to wait behind
  the other person's render rather than to fight them for VRAM.
- **Register the DCGM exporter on both sides** if you want that visible. With the exporter running
  (`--dcgm`) and added as a remote monitoring target on each workstation, LUCID's admission gate measures
  the shared box and can refuse a job with the real reason. Without it, admission only knows about the
  machine LUCID is running on, and the remote GPU reads unknown rather than idle.

So the second operator's whole setup, after their key is in place, is:

```bash
bun run tools/creator-backend/setup-backend.ts --host gpu-box --user shared-account \
  --skip-provision --workflow ./graph.json
```

That still preflights the host, opens the tunnel, verifies against the live install, and prints the endpoint
declaration to paste (or `--register` it). Both operators derive the same endpoint id from the host name, so
the two apps describe the backend identically.

The equivalent by hand, if you would rather type it:

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git ~/comfyui && cd ~/comfyui
python3 -m venv .venv && . .venv/bin/activate
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
pip install -r requirements.txt
python main.py --listen 127.0.0.1 --port 8188 --disable-pinned-memory --force-fp16 --fp16-unet --fp16-vae --fp16-text-enc
```

Keep it on **loopback** and reach it through your VPN or an SSH tunnel. ComfyUI has **no authentication**:
`--listen 0.0.0.0` publishes an unauthenticated remote-code surface to the whole network. From your
workstation:

```bash
ssh -N -L 8188:127.0.0.1:8188 you@gpu-box      # now http://127.0.0.1:8188 is that host's ComfyUI
```

The provisioner writes this unit for you as `lucid-comfyui`. By hand it is
`~/.config/systemd/user/comfyui.service`, then `systemctl --user enable --now comfyui`, with
`loginctl enable-linger $USER` to keep it up after logout:

```ini
[Unit]
Description=ComfyUI
After=network-online.target

[Service]
WorkingDirectory=%h/comfy
ExecStart=%h/comfy/.venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-pinned-memory --force-fp16 --fp16-unet --fp16-vae --fp16-text-enc
Restart=on-failure

[Install]
WantedBy=default.target
```

Then in LUCID: Creator Studio → ComfyUI → **Connect**, base URL `http://127.0.0.1:8188` (the tunnel) or the
Spark's internal address, zone **internal**, vault credential name only if you put an authenticating reverse
proxy in front. Paste your exported workflow template, press **Probe**, and confirm the attested capabilities
match what that install can really do. Verify from the command line with the `--url` invocation above.

While you are on that box, it can also feed the GPU odometer: run NVIDIA's DCGM exporter and register it as a
remote target (`dcgm-exporter` kind), and the Spark's GPU load, VRAM, temperature, and power appear in the
Resources flyout beside this machine's.

## Provider setup, safely

1. Store the secret in the vault (Settings, credentials) and note its NAME.
2. In Creator Studio, press Connect on the provider and give it: an id, a label, the base URL **or** the
   executable path, the vault credential NAME, and a zone (`local`, `internal` for a VPN or LAN host,
   `external`).
3. Save. The declaration is validated fail-closed; the secret itself never enters settings.

Environment variables the engine reads for provider secrets: `ELEVENLABS_API_KEY`, `LUCID_SUNO_TOKEN`,
`LUCID_COMFY_TOKEN`, and `LUCID_CREATOR_TARGET_<VAULTREF>` for a monitoring target.

## Hardware notes, without the hype

Dual DGX Spark class boxes and a 512 GB Apple silicon workstation both make sense as Creator targets, with
different shapes: NVIDIA hosts expose real GPU counters (`nvidia-smi`, DCGM) and CUDA runtimes for local
models; Apple silicon runs large models comfortably in unified memory but exposes no GPU load counter to an
unprivileged process, so its GPU chip reads unknown. LUCID reports what each platform actually exposes and
refuses to extrapolate a number it cannot measure.

## What is NOT built yet

Multi-track audio mixing and layering, mastering, cloud voice-clone flows end to end, deterministic three.js
frame capture, Blender scene authoring, Unreal editor remote control, and per-process GPU attribution are
roadmap items (ADR-0285, ADR-0287 to ADR-0290). Inside the editor specifically: there is no time-stretch, no
transcoder, and no per-word re-synthesis loop yet (a span re-render takes audio you already have).

Built so far on this branch:

- **CREATOR-0** (ADR-0279 to ADR-0284) - the flavor and its isolated identity, ports, and data roots; Creator
  Mode beside Agent Mode with Agent security semantics; the integration registry with honest capability
  labels; local and remote CPU/GPU telemetry with evidence-based job admission; the odometer rail; the track
  library; the Creator prompt block, skill, and docs. Proof: `make demo-CREATOR-0`.
- **CREATOR-IMG** (ADR-0291) - image generation through your own ComfyUI workflow with a live model dropdown
  and role-bound image mixing, artifact provenance, Preview-panel markup, and native sprite sheets, GIFs, and
  memes. Proof: `make demo-CREATOR-IMG`.
- **CREATOR-2** (ADR-0293) - the follow-along audio editor: a pure edit-decision-list timeline with word
  chips over the waveform, tap-to-seek, span drag, delete, split, lock-to-text, and span re-render with
  lineage; alignment that is labeled `vendor` or `derived` and capped when derived; a deterministic render
  that refuses a missing source instead of substituting silence; and a save that appends a remix without
  touching the original. Proof: `make demo-CREATOR-2`.
- **CREATOR-1** (ADR-0292) - capability probes that make `ready` mean something and expire when stale, plus
  the durable job ledger with per-job admission snapshots, recorded refusals, and request-then-confirm
  cancellation. Proof: `make demo-CREATOR-1`.

## Checking that the Creator engine actually works

After pulling these changes:

```
# 1. the three runnable proofs (no app window, no network, no GPU needed)
make demo-CREATOR-0
make demo-CREATOR-IMG
make demo-CREATOR-1

# 2. the unit suites for everything Creator
bun test desktop/build_flavor.test.ts desktop/creator_monitor.test.ts desktop/creator_registry.test.ts \
  desktop/creator_library.test.ts desktop/creator_image.test.ts desktop/creator_preamble.test.ts \
  desktop/creator_probe.test.ts desktop/creator_jobs.test.ts \
  desktop/renderer/creator_monitor.test.ts desktop/renderer/creator_studio.test.ts \
  desktop/renderer/creator_images.test.ts desktop/build/electron-builder.creator.test.ts harness/creator

# 3. types across all three programs
bun run typecheck
```

Then boot the engine itself and ask it what it is:

```
# browser-only engine on the Creator port (no Electron needed)
cd desktop && bun run web:creator
# or the native Creator app
cd desktop && bun run start:creator
```

It must answer on **5320** (the standard build stays on 5319, and both can run at once):

```
curl http://127.0.0.1:5320/api/health
```

The rest of `/api` is token-gated (ADR-0024), so read the per-launch token out of the served page first:

```
curl -s http://127.0.0.1:5320/ | grep -o 'lucid-token[^>]*'
curl -s -H "x-lucid-token: <that value>" http://127.0.0.1:5320/api/build-info
curl -s -H "x-lucid-token: <that value>" "http://127.0.0.1:5320/api/creator/resources?fresh=1"
curl -s -H "x-lucid-token: <that value>" http://127.0.0.1:5320/api/creator/registry
curl -s -H "x-lucid-token: <that value>" http://127.0.0.1:5320/api/creator/models
curl -s -X POST -H "x-lucid-token: <that value>" -H "content-type: application/json" \
  -d '{}' http://127.0.0.1:5320/api/creator/probe          # probes every declared provider
curl -s -H "x-lucid-token: <that value>" http://127.0.0.1:5320/api/creator/jobs
```

What a healthy Creator engine reports: `build-info` says `"flavor":"creator"`, `"creatorBuild":true`,
`"appId":"com.lucidcreator.desktop"`, `"defaultPort":5320`, `"authProtocol":"lucid-creator"`, and data roots
under its own userData; `creator/resources` returns your real per-core CPU numbers and an honest GPU block
(`"available":false` with a reason on a machine with no `nvidia-smi`, which is correct, not a failure);
`creator/registry` lists all seven providers with their states; `creator/models` lists your ComfyUI
checkpoints, or explains that no endpoint is connected yet.

In the window itself: the mode control next to the model badge shows **Agent / Creator / Ask / Plan**, the
rail has a **Creator Studio** button, and the right inspector has a **Resources** tab with the two odometer
chips (click one for the detailed flyout). If any of those are missing, the build is not the Creator flavor -
check `build-info` first.

A quick end-to-end without any provider: Creator Studio, Images tab, drag two PNGs into the library via
**Add audio**'s sibling flow or paste them into the pane, select two artifacts, press **GIF**, and the result
appears in the grid and opens in the Preview panel.
