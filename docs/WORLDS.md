# Lucid Agent Worlds: author guide

A Lucid Agent World is a purchasable add-on pack for the Visualize view (ADR-0648). It brings its own cast (the hub
is the boss, agents are the fleet lanes, subagents are the helpers), stages, sky, ambient particles, three
throwables, a storm, a commit set piece and user options. It ships as a signed `.lplugin.zip` of kind `world`,
is sold like a premium plugin ($9.99 one-time), and installs through the same gates as every plugin.

## 1. The contract

`desktop/renderer/viz_world_api.ts` is the frozen contract (`WORLD_API_VERSION = 2`). A world is ONE ES module whose
default export is:

```ts
import type { DefineWorld } from "<path to>/viz_world_api.ts";

const defineWorld: DefineWorld = (host) => {
  const { THREE, kit } = host;
  return {
    apiVersion: 2,
    id: "christmas",              // the package id without "world-"
    label: "Christmas",
    tagline: "Santa runs the workshop, elves build, reindeer fly the helpers",
    throws: [/* exactly three WorldThrow */],
    storm: { label: "Blizzard", tip: "...", icon: "<svg path data, 24x24>" },
    options: [/* WorldOption: color, select or toggle */],
    environment: { light, paintSky, fog, edges: { style, colorA, colorB }, chargeColor, createAmbient },
    castRoles: { subagent: "creature" },  // optional (v2): roles that are not people; the rest are "human"
    createFigure(o) { /* WorldFigure: feet at origin, facing +Z, about kit.FIGURE_HEIGHT tall; o.appearance (v2) */ },
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
- Draw people from `o.appearance` (below), never from seed bits, and never lock a role (the hub, the helpers) to one
  presentation, skin or hair.
- Honor `motion: false` (reduced motion), `flat` (the 2D map) and `detail` (full, reduced, minimal).
- Dispose every geometry, material and texture you create in `dispose()`.
- A world has no network or file access: its manifest declares no permissions and no csp, and the engine refuses one
  that does. Static files it needs (textures) go in `assets/` and load same-origin from
  `/worlds/<id>/<version>/assets/...` (types: .js, .json, .png, .webp, .svg, .jpg, .ktx2).

### Casting (contract v2, ADR-0649)

The host casts the fleet (`desktop/renderer/viz_cast.ts`) and passes every human figure `o.appearance`:

| field | values |
| --- | --- |
| `presentation` | `"feminine"`, `"masculine"` or `"neutral"` |
| `body` | `0` to `3`, slight to broad, independent of presentation |
| `skin`, `skinIndex`, `skinBand` | a `#rrggbb` tone from a 10-step ramp light to deep (`SKIN_RAMP`), its index 0 to 9, and `"light"`, `"medium"` or `"dark"` |
| `hair` | a style id that suits the presentation: `short buzz curls coils afro puffs locs braids long wavy bob pixie bun ponytail headscarf hijab` (`HAIR_STYLES`); draw your nearest style for an id you do not model |
| `hairColor` | a `#rrggbb` natural color, black to platinum (`HAIR_COLORS`) |
| `face` | `0` to `7`, a face variant the world interprets |

- Balance: hub, agents and subagents take slots of one sequence in the order they appear, so any 6 figures in a row
  hold at least 2 feminine and 2 masculine and span light, medium and dark skin. Different fleets start at different
  points of it.
- Stability: a node keeps its appearance for the session, as other nodes come and go and when options change; picking
  another world recasts.
- `castRoles` (optional, per role `"human"` or `"creature"`, default human): a creature role (reindeer, doves, a
  walking pin, farm animals) gets no `appearance` and takes no slot, so it does not skew the balance.
- `o.seed` (and the stage's seed) is the node's id hash run through a 32-bit mixer, so every bit range varies between
  nearby ids. v1 modules (`apiVersion: 1`) still load and get this mixed seed too, which is why installed v1 packs
  stopped rolling one look for the whole demo fleet without an update. They simply ignore `appearance`.

### Build sites and mini games (contract v2, ADR-0653)

Agents build at a site beside their stage while their subagents work: a `subagent` spawn adds scaffold pieces (one
per subagent), a settled tool locks one in with a flash, a failed tool flickers it red, and the turn's `done` or a git
commit reveals the build. The host draws the scaffolding (`kit.scaffold`); a world only says where and how.

```ts
buildSites: [{ roles: ["agent"], anchor: [0.95, -0.5, 0], style: "panels", color: "#ffd166", label: "Workbench" }],
miniGames: [{ id: "scorekeeper", label: "Bowling scorekeeper", brief: "Build a bowling scorekeeper as ONE self-contained HTML file ... End with the file in one fenced html block." }],
```

- `buildSites` (optional): the first site whose `roles` include the node's role (default hub and agent) is used.
  `anchor` is in cell units from the node's center (x right, y up, z front; default `[0.95, -0.5, 0]`, beside the
  stage on its floor), `style` is `"wireframe" | "holo" | "panels"` (default `"holo"`), `color` a `#rrggbb` (default
  your edge `colorA`). A malformed field falls back to its default; no site at all gives the default holo ring.
- `miniGames` (optional, at most three): the node panel of Main or a lane lists them under Mini game. Starting one
  sends `brief` to that agent as an ordinary task through the panel's own send path. Only that run's output can become
  an artifact: its last fenced `html` block (or a whole `<!doctype html>` document), at most 256 KB. Without
  `miniGames` the host offers its own two (a target-tap and a memory-cards game).
- `sample` (optional, per template; P-WORLDS.BUILD2): a ready-made, playable example of what the brief produces, ONE
  whole HTML document (`<!doctype html><html>...</html>`, inline CSS and JS, no network, no external assets) of at
  most 64 KB. A malformed sample is dropped and the template stays. The panel row then shows Play sample next to
  Build, and the `?vizDemo=1` builds end in your samples in turn (without any, in the host's two). A sample is
  labeled Sample and passes the same gate and sandbox as an agent-built artifact; being in a signed pack does not
  make it trusted. Draw on a canvas that fills the frame at any size: the popup's game area is 16:10 and resizable.
- The artifact shows as a chip over the node. Its popup first sends it through the engine's security gate (the
  scanner, fail-closed: a block or a scan that cannot run means it is never shown, and the popup says why), labels it
  Untrusted, and runs nothing until Play. Play loads it in an iframe with `sandbox="allow-scripts"` (never
  `allow-same-origin`) from an engine-served frame whose CSP is `default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'`, which holds the artifact in a `srcdoc` child: inline script and style run, no network,
  no storage, no access to LUCID. Keep holds it on the node for the session; Discard drops it.
- `kit.scaffold({ style, color, tier, flat, seed })` returns the same scaffolding as a prop (`addPieces`, `lockIn`,
  `fail`, `reveal`, `reset`, `restore`, `update`, `dispose`); its piece, beam, panel and ring counts follow the tier.

## 2. Source layout

```
world-christmas/
  world.json        { "id": "world-christmas", "version": "1.0.0", "name": "Christmas",
                      "description": "Santa's workshop ...", "apiVersion": 2 }
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

Before a release, run the package through the real-UI QA harness against an isolated QA engine (P-WORLDS.2):

```sh
bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7821        # isolated engine, temp home and data root
# Chrome or Edge with --remote-debugging-port=9333 and a fresh --user-data-dir, opened on the URL below
LUCID_DEMO_BROWSER_URL=http://127.0.0.1:9333 LUCID_DEMO_URL="http://127.0.0.1:7821/?vizDemo=1" \
LUCID_DEMO_WORLDS="dist/world-<key>-1.0.0.lplugin.zip;..." LUCID_DEMO_OUT=<dir> node desktop/scripts/demo_p_worlds_2.mjs
```

Per package it imports, draws, throws all three throwables, fires the storm, waits for a commit set piece, sets every
option value and plays the sample mini game, failing on any page error, and saves stills to `<dir>/<key>/`. It
uninstalls every world on the engine first, so never point it at your own instance. Without the two attach variables
it boots its own engine and browser. `LUCID_DEMO_FILM=1` also records the 106 s short the card media is cut from
(section 5, step 4).

## 5. Upload and price (private repo)

In `lucidagentIDEaddon/entitlements` (see its README, "Lucid Agent Worlds"):

1. Upload: `bun run scripts/upload_packs.ts --src dist --only world-<key>` (try `--dry-run` first). It lands at
   `plugins/world-<key>.lplugin.zip` in the private bucket with its version as metadata.
2. Price: one row per world in the pricing files (999 usd, one-time) and `scripts/stripe_setup.ts --kind plugin`
   creates the product and the `PLG-WORLD-<KEY>-OTF` price.
3. Catalog: the world's row in `catalog.json`, `functions/src/catalog.ts` and the website buy catalog, plus its card in
   `desktop/renderer/plugin_catalog.ts` (group "Lucid Agent Worlds", price "$9.99", the same lookup key).
4. Card media: the card plays `desktop/renderer/assets/plugins/world-<key>-loop.mp4` over `world-<key>-poster.webp`
   (720x406 H.264, no audio, under 900 KB; poster 720x405 webp). Build both from the world's filmed short with
   `plugin-media/_build/build_worlds.py build <key>` (outside the repo; tuning in `worlds.json`), then rebuild the two
   pack collages (`build bundle-patron bundle-sponsor`), since they cut from every world.

The two World Packs (Patron Class `bundle-patron`, Sponsor `bundle-sponsor`, ADR-0661) sit above the worlds on the
Premium tab. A pack installs nothing: it unlocks worlds, which then install from their own cards. Sponsor's Buy asks
for 6 worlds first, and its credits show as **Use a credit** on the worlds the account does not own.

After purchase the IDE's store path (Google sign-in, getEntitlement, getPackDownload signed URL,
`/api/plugins/install-from-url`) installs it unchanged.

## 6. Keeping purchases (ADR-0662)

Every store install and world import is recorded in `<dataRoot>/plugin-ledger.json` with a signed backup in
`<dataRoot>/plugin-backups/`. At engine start a recorded item whose folder is missing or damaged moves to
`plugins-quarantine/` and reinstalls from its backup through every install gate; anything the backup cannot fix
reinstalls from the store when the account owns it (Plugins, Installed, **Restore purchases** runs the same pass).
`GET /api/plugins/health` shows the state; `POST /api/plugins/restore {id?}` heals one item or all.

## 7. Offline moves

An installed world keeps its original signed package beside the install
(`plugins/<id>/<id>-<version>.lplugin.zip`). **Export** on its card downloads exactly those bytes
(`GET /api/worlds/export?id=...`), and **Import world file** installs them on another machine with no internet. The
signature, hashes and scan are checked again there.

## 8. Updates (ADR-0685)

Publish a new version of a world as a new signed package with a higher `version`; the store reports it as the
entitlement's `latestVersion`. A signed-in user who owns the world then sees one "World updates available" notice
(once per world and version), a dot on the Worlds button, and **Update** on the world's row in the Worlds menu. Update
installs the new package through the same verified store path as a purchase, and Visualize switches to it at once.

## Engine routes

| Route | What it does |
| --- | --- |
| `GET /api/worlds` | `{ worlds: InstalledWorld[] }`, each with its same-origin module URL |
| `GET /worlds/<id>/<version>/<path>` | a file of the current version, listed in the signed manifest, no token (a dynamic `import()` cannot send one), loopback only |
| `POST /api/worlds/import` | raw package bytes (sent with a JSON content type, as the origin guard requires), header `x-lucid-filename` |
| `GET /api/worlds/export?id=` | the kept signed package as an attachment |
| `POST /api/worlds/uninstall` | `{ id }` removes the world |
| `GET/POST /api/worlds/update-notices` | `{ announced: ["<id>@<version>"] }`: the world updates already announced (ADR-0685), kept in the engine settings; POST replaces the list (sanitized, newest 200) |
| `POST /api/viz/artifact` | `{ html }` runs a build artifact through the security gate (fail-closed); `{ ok: true, id, trust: "untrusted" }` or `{ ok: false, reason, trust: "quarantined" }` (a block is audited) |
| `GET /api/viz/artifact/frame?id=&t=` | the passed artifact's sandboxed frame (its own CSP, the artifact in a `srcdoc` child); UI token only, as a query param |
| `POST /api/viz/artifact/discard` | `{ id }` drops a passed artifact (they also expire after 30 minutes) |

A world is never started by the plugin runtime; starting one is refused.
