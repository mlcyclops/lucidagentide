// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/vault_env_panel.ts
//
// P-VAULT-ENV.1 (ADR-0477): wiring for the Settings "Import from .env" card (markup in vault_env_view.ts)
// and the one-time offer when a workspace with a `.env` opens. Talks to /api/vault/env/* (vault_env_routes.ts,
// UI token only), which always works on the CURRENT workspace and never sends a value back.

import { authHeaders } from "./bridge.ts";
import { esc } from "./format.ts";
import { showToast } from "./ui.ts";
import { importSummary, preselected, VAULT_ENV_SEC, vaultEnvScanHtml, type EnvImportResult, type EnvScan } from "./vault_env_view.ts";

export { VAULT_ENV_SEC, vaultEnvBodyHtml } from "./vault_env_view.ts";
const OFFERED_KEY = "lucid.vaultEnvOffered";

type Call<T> = { ok: true; data: T } | { ok: false; error: string };
async function call<T>(path: string, body: Record<string, unknown>): Promise<Call<T>> {
  try {
    const r = await fetch(path, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
    return j?.ok ? { ok: true, data: j.data as T } : { ok: false, error: j?.error ?? `the engine answered ${r.status}` };
  } catch {
    return { ok: false, error: "the engine did not answer" };
  }
}

async function scanInto(sec: Element): Promise<void> {
  const out = sec.querySelector("[data-venv-out]");
  if (!out) return;
  const r = await call<EnvScan>("/api/vault/env/scan", {});
  out.innerHTML = r.ok ? vaultEnvScanHtml(r.data) : `<div class="empty">Could not read the .env file: ${esc(r.error)}</div>`;
}

async function runAction(sec: Element, action: string): Promise<void> {
  if (action === "scan") { await scanInto(sec); return; }
  if (action === "import") {
    // A "Replace my saved ..." box confirms that one name (and selects it): the server skips a replacing
    // global row whose name is not in confirmReplace.
    const confirmReplace = [...sec.querySelectorAll<HTMLInputElement>("input[data-venv-confirm]:checked")].map((i) => i.dataset.venvConfirm ?? "").filter(Boolean);
    const ticked = [...sec.querySelectorAll<HTMLInputElement>("input[data-venv-name]:checked")].map((i) => i.dataset.venvName ?? "").filter(Boolean);
    const names = [...new Set([...ticked, ...confirmReplace])];
    if (!names.length) { showToast({ tone: "warn", title: "Nothing selected", desc: "Tick the names to move into the vault.", timeout: 3500 }); return; }
    const blank = !!sec.querySelector<HTMLInputElement>(`input[data-venv-opt="blank"]`)?.checked;
    const gitignore = !!sec.querySelector<HTMLInputElement>(`input[data-venv-opt="gitignore"]`)?.checked;
    const r = await call<EnvImportResult>("/api/vault/env/import", { names, confirmReplace, blank, gitignore });
    if (!r.ok) { showToast({ tone: "danger", title: "Import refused", desc: `${r.error}. Nothing in the file was changed.`, timeout: 8000 }); return; }
    const s = importSummary(r.data);
    showToast({ tone: r.data.imported.length ? "ok" : "warn", title: s.title, desc: s.desc, timeout: 8000 });
    if (r.data.committed && r.data.imported.length) {
      showToast({ tone: "danger", title: "Rotate these secrets", desc: "This .env file was committed to git at some point. Removing it does not clean the history, so anyone with the repository can still read the old values. Issue new keys at each provider.", timeout: 15000 });
    }
    await scanInto(sec);
    return;
  }
  if (action === "materialize") {
    const minutes = Number(sec.querySelector<HTMLSelectElement>("select[data-venv-minutes]")?.value ?? 15);
    const r = await call<{ path: string; names: string[]; until: number }>("/api/vault/env/materialize", { minutes });
    if (r.ok) showToast({ tone: "warn", title: "Secrets written to the file", desc: `${r.data.names.length} name${r.data.names.length === 1 ? "" : "s"} written into ${r.data.path} until ${new Date(r.data.until).toLocaleTimeString()}. They are blanked again after that.`, timeout: 8000 });
    else showToast({ tone: "danger", title: "Not written", desc: r.error, timeout: 8000 });
    return;
  }
  if (action === "unmaterialize") {
    const r = await call<{ blanked: boolean; names: string[] }>("/api/vault/env/unmaterialize", {});
    if (r.ok) showToast({ tone: "ok", title: r.data.blanked ? "File blanked" : "Nothing to blank", desc: r.data.blanked ? "The workspace secrets in the file are NAME= placeholders again." : "The file holds no workspace secret values.", timeout: 5000 });
    else showToast({ tone: "danger", title: "Not blanked", desc: r.error, timeout: 8000 });
  }
}

let installed = false;
/** One delegated click listener for the card's buttons (the card is re-rendered with Settings). */
export function installVaultEnvPanel(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("click", (ev) => {
    const btn = (ev.target as Element | null)?.closest?.("[data-venv]") as HTMLButtonElement | null;
    const sec = btn?.closest(`[data-sec="${VAULT_ENV_SEC}"]`);
    if (!btn || !sec || btn.disabled) return;
    btn.disabled = true;
    void runAction(sec, btn.dataset.venv ?? "").finally(() => { btn.disabled = false; });
  });
}

const asked = new Set<string>();
/** Once per workspace (remembered across launches): when it has a `.env` with something to import, offer
 *  to move it into the vault. "Review" opens Settings at the card with the scan already shown. */
export async function offerVaultEnvImport(workspace: string, openSettings: () => void): Promise<void> {
  if (!workspace || asked.has(workspace)) return;
  asked.add(workspace);
  let offered: unknown = [];
  try { offered = JSON.parse(localStorage.getItem(OFFERED_KEY) ?? "[]"); } catch { /* fresh list */ }
  const seen = Array.isArray(offered) ? offered.filter((w): w is string => typeof w === "string") : [];
  if (seen.includes(workspace)) return;
  const r = await call<EnvScan>("/api/vault/env/scan", {});
  if (!r.ok || !r.data.exists) return;
  const n = r.data.rows.filter(preselected).length;
  if (!n) return;
  try { localStorage.setItem(OFFERED_KEY, JSON.stringify([...seen, workspace].slice(-200))); } catch { /* best-effort */ }
  showToast({
    tone: "info",
    title: "This workspace has a .env file",
    desc: `${n} secret${n === 1 ? "" : "s"} in it can move into the encrypted vault, so the file no longer has to hold ${n === 1 ? "it" : "them"}.`,
    timeout: 15000,
    actions: [
      { label: "Review", kind: "ok", run: () => {
        openSettings();
        setTimeout(() => {
          const sec = document.querySelector(`[data-sec="${VAULT_ENV_SEC}"]`);
          if (!sec) return;
          sec.classList.add("open");
          sec.scrollIntoView({ behavior: "smooth", block: "start" });
          void scanInto(sec);
        }, 140);
      } },
      { label: "Not now" },
    ],
  });
}
