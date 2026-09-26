# KG Packs: load one, and what to do when it will not load

A KG Pack is a portable knowledge graph: one file, `<name>.lkgpack.zip`, holding a DuckDB graph plus a
signed or unsigned manifest. You buy one, or you author your own, and it becomes a knowledge graph the
agent can answer from.

Two things make packs feel harder than they are, and both are deliberate:

1. **A pack is never trusted just because you obtained it.** Every page is re-scanned before anything
   installs, and any finding refuses the WHOLE pack. A purchase grants access, not trust.
2. **The install is fail-closed.** If LUCID cannot scan, it refuses. It will never install a pack it
   could not check.

That second rule is correct and it used to produce a terrible message. See
[Troubleshooting](#troubleshooting).

-----

## Load a pack, step by step

1. **Get the file.** Either a purchased download, or a pack you exported yourself. You want the
   `.lkgpack.zip`. You do NOT need to unzip it.
2. **Open the KG picker.** Click the **Knowledge** button in the title bar, or the graph chip in the
   Profile card. Either opens the same picker.
3. **Click `KG Packs`.** That opens the Role KG Packs storefront.
4. **Click `Import a pack you own`** at the bottom of that panel.
5. **Pick your file.** The dialog asks for a file, and accepts:
   - `something.lkgpack.zip`, the normal case, exactly as downloaded;
   - `manifest.json` from INSIDE an already-unzipped pack, which is how you point at a folder (a single
     Windows dialog cannot offer files and folders at once);
   - any renamed file that is really a pack, because the importer checks the zip MAGIC bytes rather than
     the extension.
6. **Wait for the four gates.** A toast tracks it. In order: `manifest` (is this a pack), `integrity`
   (does the db match its checksum), `signature` (if signed, by a key this install trusts), `scan`
   (every page re-scanned). Only then does it install.
7. **It installs read-only.** The pack becomes a new KG marked read-only and untrusted, activated for
   you, and its pages are immediately available to the agent. No restart.

### Authoring one

Open the KG picker, find the KG you want to ship, and click the download icon on its row. You get both a
`<slug>.lkgpack/` folder for inspection and a `<slug>.lkgpack.zip` to send. It is signed only if a
signing key is configured on that machine; otherwise it is unsigned, which still imports.

-----

## Troubleshooting

### Every failure writes one file. Send that file.

`%USERPROFILE%\.omp\lucid-kbpack.jsonl` (macOS and Linux: `~/.omp/lucid-kbpack.jsonl`).

Append-only, one JSON object per attempt, so if you tried four times it shows all four. The failure toast
names the path and gives you **Copy log path** and **Open log folder** buttons. Nothing secret is in it:
the pack path, the manifest's own metadata, the stage that failed, the error, and the environment facts
that decide whether a scan was even possible. A signed download URL is recorded without its query string,
because that signature is a credential.

One line looks like this, and the `env` block is the part that usually answers the question outright:

```json
{
  "at": "2026-09-18T14:01:42.077Z",
  "ms": 116,
  "source": "D:/DL/intelligrc-automation.lkgpack.zip",
  "ok": false,
  "stage": "scanner",
  "error": "scanner unavailable: fail-closed: scan unavailable (scanner not running)",
  "env": {
    "appVersion": "2.2.2",
    "platform": "win32-x64",
    "scannerDir": "B:\\~BUN\\root\\scanner-sidecar",
    "scannerDirExists": false,
    "scannerServerExists": false,
    "scannerPython": "...\\runtimes\\python-win32-x64\\python.exe",
    "scannerPythonExists": true,
    "repoRoot": "...",
    "repoProven": true
  }
}
```

`scannerDirExists: false` is the whole diagnosis. Nothing was wrong with the pack.

### What each stage means, and whose problem it is

| Stage | What happened | Whose problem | What to do |
|---|---|---|---|
| `manifest` | Not a pack, or the zip is missing its `manifest.json` / `kb_graph.duckdb` | usually the wrong file | Pick the `.lkgpack.zip`, or the `manifest.json` inside an unzipped pack |
| `integrity` | The db does not match the checksum in the manifest | the download | Download it again; it is corrupt or was modified |
| `signature` | Signed, but not by a key this install trusts | the pack, or your key config | Ask the author which key signed it |
| `scan` | A page carries content LUCID blocks (hidden or spoofed characters) | **the pack's content** | The author must fix the pack. Nothing installed |
| `scanner` | **LUCID could not run its scanner at all** | **LUCID** | Restart LUCID. Your pack is probably fine. Send the log |
| `write` | Every check passed, writing to disk failed | the machine | Free disk space and retry |

`scan` and `scanner` are the pair worth understanding. `scan` means we looked and refused. `scanner`
means we could not look, so we refused anyway. They used to share one message, which is how a valid
189-page pack came to be reported as `page "doc-01-summary" flagged`, sending its author hunting for
poison that was never there. They are now separate stages with separate wording.

### If you see `scanner`

1. **Restart LUCID.** That is the fix in most cases.
2. If it persists, check the log's `env` block: `scannerDirExists` and `scannerServerExists` both
   `false` means this install cannot find its bundled scanner, which is a LUCID bug, not yours.
3. Send `lucid-kbpack.jsonl`. It contains everything needed to identify the cause without a repro.

Known instance, fixed in the build after 2026-09-18 (ADR-0368): the packaged desktop engine resolved the
scanner directory from a compiled binary's VIRTUALIZED source path (`B:\~BUN\...`), a path that exists in
no filesystem, so the scanner never started and every pack import failed at `scanner`. An install older
than that fix cannot import any pack, no matter how good the pack is. Update, or run the unpackaged dev
build, where the path resolves.

### Other real cases

- **"A pack is already importing."** One import at a time, by design. Let verification finish.
- **The pack installs but the agent does not seem to use it.** The pack is a separate KG. Check the KG
  picker shows it as active. It installs activated, but if activation failed the toast says so and tells
  you to select it rather than re-import.
- **The graph preview looks sparse.** The preview is lightweight on purpose. Every page is still
  available to the agent regardless of what the preview draws.

-----

## Reporting a bug in a pack load

Send these three things and nothing else is needed:

1. `%USERPROFILE%\.omp\lucid-kbpack.jsonl`
2. The pack file itself, if you are allowed to share it.
3. What you clicked, in one line.

For a broader problem, `tools/collect-support-logs.ps1` builds a redacted support bundle that already
includes the pack log, and excludes credential vaults by construction.
