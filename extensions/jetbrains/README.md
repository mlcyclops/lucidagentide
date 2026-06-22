# LucidAgentIDE for JetBrains (P-EXT.3)

Chat with the Lucid coding agent (omp) over ACP from IntelliJ / PyCharm / GoLand / …, with the
**in-process security gate always loaded**.

## How it stays secure

The plugin is a **thin ACP client of the `lucid acp` launcher** (P-EXT.1). It spawns only the gated
`lucid acp` — never a raw agent command — so installing it can never produce an ungated session
(ADR-0038; invariants #3 fail-closed, #4 gate in-process). The gate lives in `lucid acp`, **not** in
the JVM.

- **Launcher resolution** (`Launcher.kt`): `lucid.launcherPath` → the installed LucidAgentIDE app →
  `lucid` on `PATH`. Only a `lucid` binary can ever be a candidate; if none is found the plugin asks
  you to install Lucid — it does **not** fall back to anything ungated.
- **Project dir = boundary:** the open project is the agent's cwd (path containment, ADR-0022/0023).
- **Fail-closed permissions:** an Ask-mode permission dialog that is cancelled/closed denies the call.
- **Block banner:** the gate's `[BLOCKED …]` stderr signal surfaces in the tool window.

## Shared security contract

`Launcher.isLucidBinary` and `Launcher.parseBlockLine` are pinned by the shared, language-neutral spec
`harness/launcher/ext_parity.json`. `ParityTest` runs the Kotlin impl against the **same** file the VS
Code extension's `ext_parity.test.ts` runs, so both editors honor one verified contract.

## Build & run

```bash
./gradlew test          # runs ParityTest against the shared spec
./gradlew runIde        # launches a sandbox IDE with the plugin
./gradlew buildPlugin   # produces the installable plugin zip
```

Requires a JDK 17 + Gradle. **The Kotlin is not compiled in the Bun harness environment** — it builds
and tests in CI / on a JVM machine. The ACP transport mirrors `desktop/acp.ts`; the security logic
mirrors the tested `harness/launcher/ide_client.ts`. See `docs/EXT-SECURE-BUILD.md`.

## Status

MVP (P-EXT.3). Tool window chat with streaming reply, tool activity, fail-closed permission round-trip,
and the block banner. Marketplace publish (`publishPlugin`) is P-EXT.4.
