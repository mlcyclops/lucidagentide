// harness/memory/state.ts
//
// Durable, human-inspectable state artifacts (PRD "Required memory artifacts"):
// NOW.md (current state, overwritten) + PROGRESS.md / DECISIONS.md / FAILURES.md
// (append-only logs). These are the file-backed face of working/episodic memory
// — local-first and replayable.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_FILES = ["NOW.md", "PROGRESS.md", "DECISIONS.md", "FAILURES.md"] as const;
export type StateFile = (typeof STATE_FILES)[number];

const HEADERS: Record<StateFile, string> = {
  "NOW.md": "# NOW\n\nCurrent state and next step.\n",
  "PROGRESS.md": "# PROGRESS\n\nAppend-only progress log.\n",
  "DECISIONS.md": "# DECISIONS\n\nAppend-only decision log.\n",
  "FAILURES.md": "# FAILURES\n\nAppend-only failure log.\n",
};

export interface StateOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

export class StateArtifacts {
  readonly #dir: string;
  readonly #now: () => string;

  constructor(dir: string, opts: StateOptions = {}) {
    this.#dir = dir;
    this.#now = opts.now ?? (() => new Date().toISOString());
    mkdirSync(dir, { recursive: true });
    for (const f of STATE_FILES) {
      // js/file-system-race: seed the header only if the file doesn't exist, atomically.
      // `wx` creates-or-fails (no existsSync-then-write TOCTOU); an existing file is preserved.
      try { writeFileSync(join(dir, f), HEADERS[f], { encoding: "utf8", flag: "wx" }); }
      catch (e) { if ((e as { code?: string })?.code !== "EEXIST") throw e; }
    }
  }

  path(file: StateFile): string {
    return join(this.#dir, file);
  }

  read(file: StateFile): string {
    return readFileSync(this.path(file), "utf8");
  }

  /** NOW.md is the current snapshot — overwritten each time. */
  writeNow(body: string): void {
    writeFileSync(this.path("NOW.md"), `# NOW\n\n_updated ${this.#now()}_\n\n${body.trim()}\n`, "utf8");
  }

  /** Append one progress line. */
  appendProgress(line: string): void {
    appendFileSync(this.path("PROGRESS.md"), `\n- ${line}`, "utf8");
  }

  /** Append a dated decision block. */
  appendDecision(title: string, body: string): void {
    appendFileSync(this.path("DECISIONS.md"), `\n\n## ${title} (${this.#now()})\n\n${body.trim()}\n`, "utf8");
  }

  /** Append a dated failure entry. */
  appendFailure(description: string): void {
    appendFileSync(this.path("FAILURES.md"), `\n- [${this.#now()}] ${description}`, "utf8");
  }
}
