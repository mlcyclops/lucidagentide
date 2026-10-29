---
name: explainer-assets-gpu
description: "Route explainer authoring work between this machine and the user's DGX Spark fleet: code generation (session model vs DGX vLLM glm-5.3-flash), parametric mechanism parts (DGX CAD to STL, then GLB with headless Blender), textures, skies and decals (ComfyUI, DGX Vision upscale and vectorize), narration (local Kokoro tts vs dots.tts), presenter video (DGX Avatar), preview clips and posters (Chromium plus ffmpeg), and offline simulation baking. Use this skill whenever an explainer, lesson scene, or three.js project needs an asset, a GPU, the DGX, a voice, an avatar, a CAD part, a texture, or a baked dataset, or when the user asks whether to run something locally or on the Spark boxes. Read it before opening an SSH forward or starting any GPU job."
---

# Explainer assets: local compute or the DGX fleet

An explainer runs on the VIEWER's GPU through WebGL and needs no server at runtime. GPU compute matters only
while AUTHORING. This skill decides where each authoring task runs, how to reach the DGX safely, and how big
the result may be. Pair it with `explainer-studio`, whose default is procedural with no assets at all.

## Rule zero: procedural first

Before generating any asset, ask whether code can draw it: gradient-shader skies, `ExtrudeGeometry` and
`LatheGeometry` parts, `CanvasTexture` decals, noise in a shader. The measured reference explainers are all
procedural three.js at 0.3 to 0.9 MB with no models, HDRs, KTX2, WASM physics, or splats. An asset earns its
place only when PLAN.md's Assets section names it, its source, its size, and the rule below it meets.

## Decision table

| Task | Local option | DGX option | When to use which |
| --- | --- | --- | --- |
| Code generation | The session's model (usually a cloud provider) writing the explainer in the workspace | vLLM on the head node, `:8000`, model `glm-5.3-flash`, 524288-token context, tensor-parallel over both boxes | Default to the session model. Switch the session to `glm-5.3-flash` when the content is private (children's names, unpublished curriculum), when CUI lockdown is on, or when the context is very long (a whole kit plus many explainers). It serves at most 4 sequences at once, so a fan-out past 4 subagents queues: read latency as queueing, not a hang. |
| Parametric mechanism parts (gears, linkages, cams, housings) | Procedural three.js geometry; this is the default | DGX CAD `:8089` (CadQuery or build123d) exporting STEP / STL / DXF from the Creator CAD pane, then STL to GLB locally with headless Blender | Use CAD only when exact tolerances or profiles matter (involute teeth, a real linkage) and code geometry would be wrong or slow to write. Every CAD model run executes Python on the box and needs exec approval EVERY time. Convert and compress locally (see asset rules). |
| Textures, skies, decals | Procedural shaders and `CanvasTexture` first; ComfyUI on this machine when one is configured | ComfyUI provisioned on a DGX (`tools/creator-backend/provision-comfyui.sh`); DGX Vision `:8090` for tiled upscale, matting, inpainting, and VTracer vectorize | Generate only for a painted look code cannot reach. Prefer vectorizing a decal to SVG (then `ShapeGeometry` or a small texture) over a large raster. Upscale on the DGX only when a source is too small; never upscale past the size the page displays. |
| Narration | omp `tts` tool, on-device Kokoro-82M (WAV), no network | dots.tts `:8084` (`/v1/audio/speech`, `/v1/voices`): 48 kHz, zero-shot voice cloning | Kokoro first: free, private, and good enough for most narration. dots.tts when the user wants a specific designed voice or a consented clone. Cloning a real voice needs that speaker's explicit, current, scope-matched consent; never clone a child's voice. No consent: a synthetic voice. Compress to Opus before shipping. |
| Presenter or avatar video | None worth the cost; use a fictional mascot drawn in the scene | DGX Avatar `:8088` (MuseTalk or EchoMimic) from the Creator Video pane, voiced by dots.tts | Only when the user asks for a presenter. A real person's likeness needs their consent; never a real child's likeness. One GPU render at a time: a 409 means wait, not retry in a loop. |
| Preview clips and posters | Headless Chromium over the DevTools protocol plus ffmpeg on this machine | Not needed | Always local. Deterministic capture mode, VP9 webm or H.264 mp4 of about 25 to 260 KB, webp posters (the explainer-studio skill's verification reference has the scripts). |
| Offline simulation baking (trajectories, fluid fields, lookup tables) | A Bun script on the local CPU, written to compact typed arrays | The DGX job queue (`dgxq`, fair-share, trust-gated admission) for long GPU jobs | Local CPU first. Move to the DGX only when a local run would take more than about 10 minutes or truly needs CUDA. Baked data counts against the budget and is labelled "calculated offline" in the write-up. |
| Captions from narration | LUCID's managed local whisper.cpp | DGX STT `:8081` | Local first; the DGX only for long batches. Real timestamps come from alignment, never guessed. |

## How to reach the DGX (in this order)

1. **LUCID's own seams first.** The DGX Loader's "Send to LUCID" writes portable endpoint files that LUCID
   imports and gates: `~/.omp/voice_endpoints/<id>.json` (`lucid-voice-endpoint` v1, for TTS and dots.tts,
   shown in Settings, Voice, Endpoints) and `<personal dir>/creator_endpoints/<id>.json`
   (`lucid-creator-endpoint` v1, for `dgx-avatar`, `dgx-cad`, `dgx-vision`, imported with the Import button in
   the Creator Video and CAD panes). These files carry no secrets; one with a credential-like key is refused.
2. **The agent tools that exist** (verified in the harness, not guessed):
   - `design_read`, `design_apply`, `design_request` (`harness/omp/design_extension.ts`): DGX Vision work
     (`decompose`, `segment-hint`, `matte`, `upscale`, `vectorize`, `label`) on the open Design document.
     Nothing runs until the user clicks Allow; confirm with `design_read` before claiming a result.
   - `preview_open`, `preview_screenshot`, `preview_inspect`, `preview_click`, `preview_type`
     (`harness/omp/preview_extension.ts`): look at the explainer and every generated image.
   - `openfilm_look`, `openfilm_render`, `openfilm_job` (`harness/omp/openfilm_extension.ts`) and
     `drift_status`, `drift_read`, `drift_apply`, `drift_export` (`harness/omp/drift_extension.ts`): edit or
     assemble longer trailer videos when a clip is not enough.
   - `tts` (omp built-in, `providers.tts` setting): set it to `local` for on-device Kokoro when privacy
     matters, because `auto` may route an `.mp3` request to a cloud voice.
   - There is NO agent tool for CAD runs, avatar renders, ComfyUI generation, Blender renders, provider
     probes, resource readings, or the job ledger. Those routes (`/api/creator/cad/*`,
     `/api/creator/avatar/*`, `/api/creator/image`, `/api/creator/blender`, `/api/creator/probe`,
     `/api/creator/resources`, `/api/creator/jobs`) accept only the UI's token. Ask the user to run the step
     in the Creator Studio CAD, Video, Images, or Render pane, and pick up the result from the Creator library
     or the file they save. Never try to reach those routes another way.
3. **Otherwise a VPN or an SSH forward**, for a service LUCID has no seam for (for example the LLM as a Local
   Provider). Details and the backoff rule are in `references/dgx-access.md`. In short:
   - Box addresses, users, and model ids are DATA from the user's endpoint files or Local Provider, never
     guessed or hard-coded into a project. In the reference fleet (`DGX-FLEET-INTEGRATION.md`) the head node is
     `10.0.0.21` over the VPN. Point at the HEAD only: the second box is a tensor-parallel member that serves
     no HTTP, and a probe against it looks exactly like a dead pool.
   - Without the VPN: one held forward per service, `ssh -N -L 18000:127.0.0.1:8000 <user>@<head>`.
   - **fail2ban:** never rapid-retry SSH and never poll on a fixed interval. TCP 22 open plus an ssh exit 255
     with no output means rate-limited, not down: wait at least 60 seconds before the next single attempt,
     double the wait after each failure, and stop after three and tell the user.
   - Never ask the fleet to bind a service beyond loopback.
4. **Credentials come only from the vault.** The vLLM endpoint is credentialed (a request without the key
   answers 401). Save it as a Local Provider and put the key in LUCID's vault once; reference credentials by
   NAME. Never paste a key into a URL, a command line, a script, PLAN.md, a commit, an endpoint file, or chat,
   and never echo one back.

Before any local GPU-heavy job, check the Resources tab in the Creator inspector: unknown load is never spare
capacity, and one heavy local job runs at a time. Under CUI lockdown only on-device providers and endpoints
attested as a DGX enclave are allowed; quote a `CUI lockdown:` refusal and offer the local option.

## Asset budget rules

- **Prefer procedural.** No asset is the right default.
- **Total under about 5 MB** for an explainer that genuinely needs assets, everything included (three.js,
  decoders, models, textures, audio). Without assets, the explainer-studio target of under 1 MB applies.
- **Models:** GLB only, compressed with meshopt (preferred, small decoder) or Draco, quantized, with unused
  nodes, materials, and UVs pruned. One GLB per mechanism, not per part.
- **Textures:** KTX2 (Basis Universal: ETC1S for colour, UASTC for normals), power-of-two sizes, no larger
  than displayed; 1024 px is a ceiling, not a target.
- **Audio:** Opus in webm at 24 to 48 kbps mono for narration; captions alongside.
- **Decoders count:** the meshopt decoder, the Draco decoder, and the Basis transcoder are vendored locally
  and count against the budget. Never load them from a CDN.
- **Provenance:** every asset records its generator, prompt or script, model, licence, and sha256 in
  PLAN.md's Assets section; generated media lands in the Creator library first.

The conversion and compression commands (headless Blender, `gltf-transform`, `toktx`, ffmpeg) and the
loader setup are in `references/asset-pipeline.md`.

## References

- `references/dgx-access.md`: services and ports, the mailbox files, VPN and SSH forwards, the fail2ban rule,
  vault credentials, smoke checks.
- `references/asset-pipeline.md`: CAD to STL to GLB, mesh and texture compression, audio, loaders, size
  checks.
