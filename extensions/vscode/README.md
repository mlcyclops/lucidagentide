# LucidAgentIDE for VS Code (P-EXT.2)

Chat with the Lucid coding agent (omp) over ACP, with the **in-process security gate always loaded**.

## How it stays secure

This extension is a **thin ACP client of the `lucid acp` launcher** (P-EXT.1). It never spawns a raw
agent command — it only ever spawns the gated `lucid acp`, which fail-closes if the security gate or
scanner sidecar is unavailable. So installing this extension can never produce an ungated session
(ADR-0038; invariants #3 fail-closed, #4 gate in-process).

- **Launcher resolution:** `lucid.launcherPath` setting → the installed LucidAgentIDE app → `lucid` on
  `PATH`. If none is found, the extension prompts you to install Lucid — it does **not** fall back to
  anything ungated.
- **Workspace = boundary:** the opened folder is passed as the agent's cwd (the path-containment
  boundary, ADR-0022/0023).
- **Fail-closed permissions:** in Ask mode, a tool-permission prompt that times out or is dismissed is
  denied (`cancelled`).
- **Block banner:** the gate's authoritative `[BLOCKED …]` signal surfaces as a banner; the tool never ran.

## Develop

```bash
bun install          # or npm install
bun run build        # bundles src/extension.ts -> dist/extension.js (vscode external)
# Press F5 in VS Code to launch an Extension Development Host.
```

Requires the `lucid` launcher from LucidAgentIDE (or set `lucid.launcherPath`).

## Status

MVP (P-EXT.2). The ACP transport reuses the proven `desktop/acp.ts`; launcher resolution + the block
signal come from the shared, tested `harness/launcher/ide_client.ts`. End-to-end (gated reply + block
banner) is verified manually in an Extension Development Host. See `docs/EXT-SECURE-BUILD.md`.
