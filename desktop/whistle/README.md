# desktop/whistle/

Staging dir for the in-process speech-to-text and word-alignment runtime (ADR-0432, CREATOR-WHISTLE).
electron-builder copies everything here except this README and `.gitkeep` into `<resources>/whistle/`.

## What it holds

| File | What | Pinned size |
|---|---|---|
| `needle.js` | Emscripten glue for the Needle engine (Cactus Compute) | 62,823 bytes |
| `needle.wasm` | Needle engine, WebAssembly build | 903,655 bytes |
| `whistle.cact` | Whistle speech model in Cactus's `.cact` container format | 16,919,407 bytes |

The URLs, byte sizes and sha256 pins live in `desktop/whistle_assets.ts`. The engine verifies all three
before the first load; a mismatch refuses by name and never falls back.

## How to stage

From `desktop/`: `bun run whistle` (runs `build/fetch-whistle.ts`). Downloads each file, verifies size
then sha256, writes `<name>.part` and renames it into place only after it verifies. Files already present
and verified are kept. Dev runs stage the same bytes into `~/.omp/whistle/` through `whistle_stage.ts`;
`LUCID_WHISTLE_DIR` overrides both.

The downloaded files are git-ignored (see `.gitignore`); only this README and `.gitkeep` are committed.

## License

Whistle (model) and Needle (engine) are Apache-2.0, Cactus Compute. Sources:
`https://huggingface.co/Cactus-Compute/whistle` and `https://huggingface.co/Cactus-Compute/needle3`.
The license text is reproduced in `THIRD-PARTY-NOTICES.md` under "Bundled models and runtimes".
