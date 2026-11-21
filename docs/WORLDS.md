# Lucid Agent Worlds: author guide

A Lucid Agent World is a purchasable add-on pack for the Visualize view (ADR-0648). It brings its own cast (the hub
is the boss, agents are the fleet lanes, subagents are the helpers), stages, sky, ambient particles, three
throwables, a storm, a commit set piece and user options. It ships as a signed `.lplugin.zip` of kind `world`,
is sold like a premium plugin ($9.99 one-time), and installs through the same gates as every plugin.

## 1. The contract

`desktop/renderer/viz_world_api.ts` is the frozen contract (`WORLD_API_VERSION = 1`). A world is ONE ES module whose
default export is:

```ts
import type { DefineWorld } from "<path to>/viz_world_api.ts";

const defineWorld: DefineWorld = (host) => {
  const { THREE, kit } = host;
  return {
    apiVersion: 1,
    id: "christmas",              // the package id without "world-"
    label: "Christmas",
    tagline: "Santa runs the workshop, elves build, reindeer fly the helpers",
    throws: [/* exactly three WorldThrow */],
    storm: { label: "Blizzard", tip: "...", icon: "<svg path data, 24x24>" },
    options: [/* WorldOption: color, select or toggle */],
    environment: { light, paintSky, fog, edges: { style, colorA, colorB }, chargeColor, createAmbient },
    createFigure(o) { /* WorldFigure: feet at origin, facing +Z, about kit.FIGURE_HEIGHT tall */ },
    createStage(o) { /* optional WorldStage inside kit.CELL */ },
    createProjectile(kind, flat) { /* WorldProjectile */ },
    createStorm(ctx) { /* WorldStorm; update returns false when over */ },
  };
};
export default defineWorld;
```

Rules:

- Never import `three` at runtime. Use `host.THREE` and the helpers in `host.kit` (toon, ink, outline,
  roundedBox, merge, canvasTexture, drawEmblem, random, noise1, ease). Type-only imports (`import type`) are fine.
- No other package imports either: the renderer resolves no bare specifiers. Bundle what you need.
- Pick variants from `o.seed` and `kit.random(seed)`, never `Math.random()`, so a node looks the same every time.
- Honor `motion: false` (reduced motion), `flat` (the 2D map) and `detail` (full, reduced, minimal).
- Dispose every geometry, material and texture you create in `dispose()`.
- A world has no network or file access: its manifest declares no permissions and no csp, and the engine refuses one
  that does. Static files it needs (textures) go in `assets/` and load same-origin from
  `/worlds/<id>/<version>/assets/...` (types: .js, .json, .png, .webp, .svg, .jpg, .ktx2).

## 2. Source layout

```
world-christmas/
  world.json        { "id": "world-christmas", "version": "1.0.0", "name": "Christmas",
                      "description": "Santa's workshop ...", "apiVersion": 1 }
  src/index.ts      the default export above
  assets/           optional: textures and data, copied as is
```

`id` is `world-<key>` (lowercase letters, digits, dashes). `version` is `MAJOR.MINOR.PATCH`; raise it for every
release, since the store offers Update only for a strictly newer version.

## 3. Build and sign

```sh
bun tools/build_world.ts --src path/to/world-christmas --out dist [--key ~/.omp/keys/lucid-plugin-publisher.key]
```

The tool bundles `src/index.ts` with Bun.build (ESM, browser, minified, one file) into `world.js`, keeping `three`
external so a runtime import of it is caught: the build FAILS when the bundle imports `three` or any other bare
specifier. It copies `assets/`, writes `LICENSE` (the LUCID Premium Plugin License) and `lucid-plugin.json`
(`kind: "world"`, `tier: "premium"`, `section: "civilian"`, `entry: { "module": "world.js" }`, `apiVersion`, and the
sha256 of every payload file), then signs and zips through `tools/build_plugin.ts`, which re-reads the zip through the
installer's own gate. Output: `dist/<id>-<version>.lplugin.zip`.

A world is premium, so it is never built unsigned. The publisher key is created once with
`bun tools/build_plugin.ts --init-key`; it never goes in a repo.

## 4. Try it locally

Plugins drawer, Premium tab, Lucid Agent Worlds, **Import world file**: pick the zip. The engine
(`POST /api/worlds/import`) requires kind `world` and a valid publisher signature, then runs every store gate
(manifest, hashes, signature, security scan). The world then appears in Visualize's style picker. Whether this account
may use it is checked there against the store entitlement (cached for 30 days, so offline machines keep working; with
no store configured it is allowed).

## 5. Upload and price (private repo)

In `lucidagentIDEaddon/entitlements` (see its README, "Lucid Agent Worlds"):

1. Upload: `bun run scripts/upload_packs.ts --src dist --only world-<key>` (try `--dry-run` first). It lands at
   `plugins/world-<key>.lplugin.zip` in the private bucket with its version as metadata.
2. Price: one row per world in the pricing files (999 usd, one-time) and `scripts/stripe_setup.ts --kind plugin`
   creates the product and the `PLG-WORLD-<KEY>-OTF` price.
3. Catalog: the world's row in `catalog.json`, `functions/src/catalog.ts` and the website buy catalog, plus its card in
   `desktop/renderer/plugin_catalog.ts` (group "Lucid Agent Worlds", price "$9.99", the same lookup key).

After purchase the IDE's store path (Google sign-in, getEntitlement, getPackDownload signed URL,
`/api/plugins/install-from-url`) installs it unchanged.

## 6. Offline moves

An installed world keeps its original signed package beside the install
(`plugins/<id>/<id>-<version>.lplugin.zip`). **Export** on its card downloads exactly those bytes
(`GET /api/worlds/export?id=...`), and **Import world file** installs them on another machine with no internet. The
signature, hashes and scan are checked again there.

## Engine routes

| Route | What it does |
| --- | --- |
| `GET /api/worlds` | `{ worlds: InstalledWorld[] }`, each with its same-origin module URL |
| `GET /worlds/<id>/<version>/<path>` | a file of the current version, listed in the signed manifest, no token (a dynamic `import()` cannot send one), loopback only |
| `POST /api/worlds/import` | raw package bytes (sent with a JSON content type, as the origin guard requires), header `x-lucid-filename` |
| `GET /api/worlds/export?id=` | the kept signed package as an attachment |
| `POST /api/worlds/uninstall` | `{ id }` removes the world |

A world is never started by the plugin runtime; starting one is refused.
