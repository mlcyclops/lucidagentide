# Asset pipeline: from a generator to a budgeted, compressed file

Use this only after PLAN.md's Assets section names the asset and why code cannot draw it.

## CAD part: DGX CAD to STL to GLB

1. **Model on the DGX.** In the Creator CAD pane, run a CadQuery or build123d script that assigns `result`
   and exports STL (and STEP for the record). The script is the USER's code: show it, get exec approval for
   that exact script, every run. STEP and STL land in the Creator library as `model-3d`.
2. **Convert locally with headless Blender.** The conversion script is the user's own file in their project
   (LUCID writes no Blender Python of its own); it runs through exec approval:

```bash
blender -b --factory-startup --python-exit-code 1 --python convert_stl_to_glb.py -- part.stl part.glb
```

   A minimal script body for the user to review (Blender 4.x operator names; Blender 4.1 and later import
   STL with `wm.stl_import`, older releases use `import_mesh.stl`):

```python
import bpy, sys
src, dst = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.stl_import(filepath=src)
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_apply=True)
```

   Check the installed version with `blender --version` instead of guessing operator names.
   `--python-exit-code 1` (placed before `--python`) makes a Python error exit non-zero; without it Blender
   exits 0 even when the script failed. Quote the exit code and the failing stdout line.
3. **Compress** (next section). CAD units are usually millimetres: scale once at export or in the scene and
   record which.

`assimp export part.stl part.glb -f glb2` is an alternative converter where the Assimp CLI is installed.

## Mesh compression with glTF Transform

`@gltf-transform/cli` is a Node CLI. Install it pinned and with egress approval, or use a copy the user
already has.

```bash
gltf-transform inspect part.glb                      # sizes, vertex counts, textures
gltf-transform optimize part.glb part.opt.glb --compress meshopt --texture-compress false
gltf-transform inspect part.opt.glb                  # confirm the saving
```

- `--compress meshopt` (preferred; its decoder is small) or `--compress draco`.
- `optimize` also dedupes, prunes, welds, and simplifies; check `inspect` for visible damage and lower the
  simplification (see `gltf-transform optimize --help`) if a profile edge moved.
- Merge parts of one mechanism into one GLB; animate by node names, not by separate files.

## Textures: KTX2

KTX2 encoding needs KTX-Software's `toktx` (or the newer `ktx` CLI) on PATH.

```bash
# standalone texture (sky, decal atlas): ETC1S for colour
toktx --t2 --encode etc1s --genmipmap sky.ktx2 sky.png
# normal or detail maps: UASTC keeps quality
toktx --t2 --encode uastc --genmipmap ground_normal.ktx2 ground_normal.png
# textures inside a GLB
gltf-transform etc1s part.opt.glb part.ktx2.glb --slots "{baseColorTexture,emissiveTexture}"
gltf-transform uastc part.ktx2.glb part.final.glb --slots "normalTexture"
```

Resize before encoding (`ffmpeg -i in.png -vf "scale=1024:-1:flags=lanczos" out.png`); power-of-two sizes,
no larger than displayed.

## Generated images: ComfyUI and DGX Vision

- Generation runs the USER's ComfyUI workflow from the Creator Images pane, with models the live
  `/object_info` probe listed; never name a checkpoint the probe did not return.
- Cleanup on the DGX: open the image in the Design editor, then `design_request` with `matte` (cut out a
  subject), `upscale` (only to the displayed size), or `vectorize` (decals and icons to SVG). The user clicks
  Allow; confirm with `design_read`.
- A vectorized decal usually beats a raster: load the SVG with three.js `SVGLoader` and build `ShapeGeometry`,
  or rasterize it once to a small texture.

## Narration audio

- Local: omp `tts` with `providers.tts` set to `local` writes WAV through Kokoro-82M.
- DGX: dots.tts through the voice endpoint in Settings.
- Compress and measure:

```bash
ffmpeg -y -i narration.wav -ac 1 -c:a libopus -b:a 32k narration.webm
ffprobe -v error -show_entries format=size,duration -of default=nw=1 narration.webm
```

- Captions: a WebVTT file beside the audio, timed from real alignment (local whisper.cpp or DGX STT), never
  estimated offsets presented as real.
- Consent: a cloned voice needs the speaker's explicit, current, scope-matched consent; never a child's
  voice; reference audio never leaves the boundary the consent covers.

## Presenter video

- Rendered by DGX Avatar from the Creator Video pane (templates from the box, never an invented path), voiced
  by dots.tts. The composed video lands in the Creator library.
- Shrink it for the page: `ffmpeg -y -i presenter.mp4 -vf "scale=480:-2" -c:v libvpx-vp9 -b:v 0 -crf 38 -row-mt 1 -c:a libopus -b:a 32k presenter.webm`
- A real person's likeness needs their consent; never a real child's likeness.

## Baked simulation data

- Write the bake as a Bun script that runs on the local CPU and emits typed arrays:

```ts
// bake.ts: bun bake.ts > field.bin  (Float32 -> Int16 quantized, little-endian)
const N = 64 * 64 * 32;
const out = new Int16Array(N);
for (let i = 0; i < N; i++) out[i] = Math.round(simulate(i) * 32767); // simulate() returns [-1, 1]
await Bun.write(Bun.stdout, new Uint8Array(out.buffer));
```

- Load with `fetch('./field.bin').then((r) => r.arrayBuffer())` and `new Int16Array(buf)`, and dequantize
  by dividing by 32767. Record the quantization step in the write-up ("calculated offline at 1/32767
  resolution").
- Only when a local run would exceed about 10 minutes, or needs CUDA, queue it on the DGX (`dgxq`) over ONE
  SSH connection, following the fail2ban rule.

## Loaders (all decoders vendored locally)

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const ktx2 = new KTX2Loader().setTranscoderPath('./vendor/three/addons/libs/basis/').detectSupport(renderer);
const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
const part = await gltf.loadAsync('./assets/part.final.glb');
```

For Draco instead of meshopt: `DRACOLoader` with `setDecoderPath('./vendor/three/addons/libs/draco/')` and
`gltf.setDRACOLoader(draco)`. Copy the decoder folders from the installed three package.

## Checking the budget

- Sum every file the page loads: the headless capture in explainer-studio's `references/verification.md`
  reports `transferKB`. With assets the ceiling is about 5 MB; without, under 1 MB.
- List each asset in PLAN.md with its bytes, generator, prompt or script, model, licence, and sha256
  (`certutil -hashfile part.final.glb SHA256` on Windows, `sha256sum part.final.glb` elsewhere).
