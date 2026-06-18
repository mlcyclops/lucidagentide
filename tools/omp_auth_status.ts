// tools/omp_auth_status.ts
//
// Reports which providers omp is actually authenticated to — including OAuth /
// subscription logins (Claude Pro/Max, ChatGPT, etc.) that a plain environment-
// variable check (ANTHROPIC_API_KEY …) completely misses. The launcher uses this
// so it stops claiming "Anthropic not set" when you're logged in via OAuth.
//
//   bun run tools/omp_auth_status.ts                    # human-readable list
//   bun run tools/omp_auth_status.ts --json             # JSON array
//   bun run tools/omp_auth_status.ts --check anthropic  # exit 0 if active, 1 none, 2 unknown
//   bun run tools/omp_auth_status.ts /path/to/agent.db  # override vault path
//
// omp keeps credentials in a private SQLite vault (~/.omp/agent/agent.db, table
// `auth_credentials`). We read it READ-ONLY and best-effort: any failure (missing
// db, locked, schema drift in a future omp) prints a skip notice and exits 0 for
// display, or exit 2 ("unknown") for --check. This is a convenience display, NOT
// the security gate — the fail-closed law applies to the scanner, not to this.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

type Cred = {
  provider: string;
  credential_type: string;
  identity_key: string | null;
  disabled_cause: string | null;
};

const args = process.argv.slice(2);

/** Default profile vault, or an explicit `*.db` path passed as a bare arg. */
function vaultPath(): string {
  const explicit = args.find((a) => !a.startsWith("--") && a.toLowerCase().endsWith(".db"));
  if (explicit) return explicit;
  return join(homedir(), ".omp", "agent", "agent.db");
}

/** Read credentials read-only; null on any failure (missing/locked/schema drift). */
function readCreds(): Cred[] | null {
  const p = vaultPath();
  if (!existsSync(p)) return null;
  try {
    const db = new Database(p, { readonly: true });
    try {
      return db
        .query("select provider, credential_type, identity_key, disabled_cause from auth_credentials")
        .all() as Cred[];
    } finally {
      db.close();
    }
  } catch {
    return null; // table missing in a future omp, or vault momentarily locked
  }
}

const creds = readCreds();

// --check <provider>: exit 0 if an active (non-disabled) credential exists.
const ci = args.indexOf("--check");
if (ci !== -1) {
  const want = args[ci + 1];
  if (creds === null) process.exit(2); // unknown — let the caller fall back to env/keys
  process.exit(creds.some((c) => c.provider === want && !c.disabled_cause) ? 0 : 1);
}

if (args.includes("--json")) {
  console.log(JSON.stringify(creds ?? []));
  process.exit(0);
}

// Human display — indentation matches the launcher's [ OK ] / [ -- ] doctor style.
if (creds === null) {
  console.log("    ( -- )  could not read omp credential vault — skipping");
  process.exit(0);
}
const active = creds.filter((c) => !c.disabled_cause);
if (active.length === 0) {
  console.log("    ( -- )  no logins stored in omp — run `omp` and use /login, or set an API key");
} else {
  for (const c of active) {
    const kind = c.credential_type === "oauth" ? "OAuth login" : c.credential_type;
    const who = c.identity_key ? `  ${c.identity_key}` : "";
    console.log(`    [ OK ]  ${c.provider}  (${kind})${who}`);
  }
}
for (const c of creds.filter((c) => c.disabled_cause)) {
  console.log(`    [ x  ]  ${c.provider}  (${c.credential_type}) — disabled: ${c.disabled_cause}`);
}
process.exit(0);
