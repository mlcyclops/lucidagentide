// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_fake_omp.ts - the P-TUI demos' fake omp, executable on every OS.
//
// The demos ran the real engine over the house fake ACP agent by naming a `#!/usr/bin/env bun` script in
// LUCID_OMP_BIN. Windows cannot execute a shebang script, so there the engine never got its fake model;
// and HOME alone does not move os.homedir() on Windows (USERPROFILE does), so the engine also read the
// operator's real ~/.omp. This builds the same fake the recovery test uses on Windows (bun's own omp.exe
// shim plus a dist/cli.js that imports the fake agent) and returns the env that isolates the home.

import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Build the fake omp under `root` and return the path LUCID_OMP_BIN should name. */
export function buildFakeOmp(root: string, repo: string): string {
  const agent = pathToFileURL(join(repo, "harness", "mcp", "testing", "fake_acp_agent.ts")).href;
  const body = `if (process.argv.includes("--version")) { console.log("fake-omp 0.0.0"); process.exit(0); }\nawait import(${JSON.stringify(agent)});\n`;
  if (process.platform === "win32") {
    const bin = join(root, "node_modules", ".bin");
    const dist = join(root, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist");
    mkdirSync(bin, { recursive: true });
    mkdirSync(dist, { recursive: true });
    copyFileSync(join(repo, "node_modules", ".bin", "omp.exe"), join(bin, "omp.exe"));
    copyFileSync(join(repo, "node_modules", ".bin", "omp.bunx"), join(bin, "omp.bunx"));
    writeFileSync(join(dist, "cli.js"), body);
    return join(bin, "omp.exe");
  }
  const bin = join(root, "bin", "omp");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env bun\n${body}`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

/** The home-isolating env entries: HOME for POSIX, USERPROFILE for Windows' os.homedir(). */
export const isolatedHome = (home: string): Record<string, string> => ({ HOME: home, USERPROFILE: home });

/** Whether file mode bits mean anything here: Windows reports 0666 for every writable file. */
export const POSIX_MODES = process.platform !== "win32";

/** Whether SIGTERM runs exit handlers: on Windows, kill() terminates the process without them, so a file
 *  removed on exit stays behind (readers reject it through the nonce handshake instead). */
export const POSIX_SIGNALS = process.platform !== "win32";
