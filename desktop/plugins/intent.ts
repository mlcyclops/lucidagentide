// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/plugins/intent.ts - P-PLUGINS.8 (ADR-0546): a plugin the user wanted running comes back at launch.
//
// The runtime keeps its running set in memory, so before this a plugin was "installed" again after every engine
// restart (an upgrade by the installer, a normal quit) until the user started it by hand, and the hub plugin's
// mailbox and alerts silently stopped. The ledger records the user's intent, not the process state:
//   - a successful start (the user opening it, or this launch bringing it back) writes `running-intent/<id>`;
//   - a stop the USER asked for (the Stop route, closing its tab) and an uninstall remove it;
//   - a crash, a failed health check, the engine quitting or dying, and an update's stop-before-switch keep it.
// One 0600 file per plugin in a 0700 dir under the plugins data root (`plugin-data/.running-intent`): beside the
// plugins' own data dirs but in none of them (a dot name is never a plugin id), so a plugin cannot reset or forge
// its own intent through LUCID_PLUGIN_DATA, and an update (which clears `plugins/<id>/` of all but the version)
// never drops it. A newly installed plugin has no file, so it runs only once the user opens it (ADR-0535).

import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ID_RE, pluginDataRoot } from "./install.ts";

/** Waits before the second and third launch attempt: three tries in all, then the plugin waits for the user. */
export const AUTOSTART_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000];

/** Where the ledger lives; one file per plugin id. */
export function runIntentDir(): string { return join(pluginDataRoot(), ".running-intent"); }

/** Record that `id` should be running (idempotent). Never throws: a failed write costs only the next launch's restart. */
export function setRunIntent(id: string, dir: string): void {
  if (!PLUGIN_ID_RE.test(id)) return;
  const file = join(dir, id);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
    chmodSync(file, 0o600); // the create mode does not apply to a file that already existed
  } catch (e) { console.error(`[plugins] ${id}: could not record that it should run at the next launch: ${(e as Error).message}`); }
}

/** Forget that `id` should be running (idempotent). */
export function clearRunIntent(id: string, dir: string): void {
  if (!PLUGIN_ID_RE.test(id)) return;
  try { rmSync(join(dir, id), { force: true }); } catch (e) { console.error(`[plugins] ${id}: could not clear its run-at-launch record: ${(e as Error).message}`); }
}

/** Every plugin id with a recorded intent, sorted; anything else in the dir is ignored. */
export function readRunIntents(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => PLUGIN_ID_RE.test(n)).sort();
}

/** Which recorded plugins to start at launch, and which have no package any more (a plugin removed behind the
 *  IDE's back, such as the release cleanup of unsigned private installs, ADR-0536): those are skipped quietly. */
export function launchSelection(intents: readonly string[], installed: (id: string) => boolean): { start: string[]; missing: string[] } {
  const start: string[] = [];
  const missing: string[] = [];
  for (const id of intents) (installed(id) ? start : missing).push(id);
  return { start, missing };
}

export interface AutostartDeps {
  /** The recorded intents right now (re-read before every retry, so a user's Stop meanwhile cancels it). */
  intents(): string[];
  installed(id: string): boolean;
  start(id: string): Promise<{ ok: boolean; error?: string }>;
  /** Drop the intent of a plugin whose package is gone, so a later fresh install of that id waits for the user. */
  forget(id: string): void;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  retryDelaysMs?: readonly number[];
}

export interface AutostartOutcome { id: string; ok: boolean; attempts: number; error?: string }

/** Bring back every plugin the user left running, once per launch. Starts run one at a time (the port ledger is
 *  read-modify-write); a plugin that fails is tried again after each delay, at most `retryDelaysMs.length + 1`
 *  times in all, in rounds so one stubborn plugin never holds up the others. The intent stays after the last
 *  failure: the plugin shows its error, the user can start it by hand, and the next launch tries again. */
export async function autostartPlugins(deps: AutostartDeps): Promise<AutostartOutcome[]> {
  const delays = deps.retryDelaysMs ?? AUTOSTART_RETRY_DELAYS_MS;
  const { start, missing } = launchSelection(deps.intents(), deps.installed);
  for (const id of missing) deps.forget(id);
  const outcomes = new Map<string, AutostartOutcome>();
  let pending = start;
  for (let attempt = 1; pending.length; attempt++) {
    const failed: string[] = [];
    for (const id of pending) {
      const r = await deps.start(id);
      if (r.ok) {
        outcomes.set(id, { id, ok: true, attempts: attempt });
        deps.log(`[plugins] ${id} is running again (it was running when LUCID last closed)`);
        continue;
      }
      const error = r.error ?? "it did not start";
      outcomes.set(id, { id, ok: false, attempts: attempt, error });
      const delay = delays[attempt - 1];
      if (delay === undefined) deps.log(`[plugins] ${id} did not come back after ${attempt} attempts: ${error}. Start it from the Plugins drawer.`);
      else { deps.log(`[plugins] ${id} did not come back (attempt ${attempt} of ${delays.length + 1}): ${error}`); failed.push(id); }
    }
    if (!failed.length) break;
    await deps.sleep(delays[attempt - 1]!);
    const still = new Set(deps.intents()); // the user stopped or uninstalled it meanwhile: leave it alone
    pending = failed.filter((id) => still.has(id));
  }
  return start.map((id) => outcomes.get(id)!);
}
