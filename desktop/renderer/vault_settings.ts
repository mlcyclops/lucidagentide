// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/vault_settings.ts - P-VAULT-UI.1 (ADR-0475): wiring for the Settings "Credential vault"
// section (markup in vault_settings_view.ts). app.ts paints the skeleton (setSkel("vault", ...)) and calls
// hydrateVaultSettings() from hydrateSettings(); this module fetches /api/vault/list, swaps the section in
// place keeping the user's open/closed state, and handles its own buttons through one delegated listener.
//
// Values: a rotate value is typed into a masked input and POSTed once; the backup passphrase likewise.
// Nothing here ever receives a secret value back: the list is metadata, the backup reply is ciphertext,
// the restore reply is counts. Inputs are cleared after each submit.

import { authHeaders } from "./bridge.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { popover, showToast } from "./ui.ts";
import { parseVaultList, passphraseStrength, VAULT_SEC, vaultSectionHtml } from "./vault_settings_view.ts";

/** Larger than any real backup; the engine enforces its own cap too. */
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;

type ApiResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Call a vault route with the UI token, keeping the engine's refusal words (wrong passphrase etc.). */
async function vaultApi(path: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(path, body === undefined
      ? { cache: "no-store", headers: authHeaders() }
      : { method: "POST", cache: "no-store", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
    const j: unknown = await res.json().catch(() => null);
    if (j && typeof j === "object" && "ok" in j && j.ok === true && "data" in j) return { ok: true, data: j.data };
    const error = j && typeof j === "object" && "error" in j && typeof j.error === "string" ? j.error : `the engine answered ${res.status}`;
    return { ok: false, error };
  } catch {
    return { ok: false, error: "the engine could not be reached" };
  }
}

const section = (): HTMLElement | null => document.querySelector(`#setBody [data-sec="${VAULT_SEC}"]`);

let restoreFile: File | null = null;
let mounted = false;

/** Fetch the inventory and swap the section in place. Keeps whatever open state the section has now
 *  (app.ts's [data-setcard] handler toggles it; a fresh skeleton is collapsed unless SET_OPEN has it).
 *  A background refresh (app.ts re-hydrates Settings on many events) never wipes a passphrase or a chosen
 *  file the user is in the middle of; this module's own refreshes after a change pass `force`. */
export async function hydrateVaultSettings(force = false): Promise<void> {
  mount();
  const r = await vaultApi("/api/vault/list");
  const cur = section();
  if (!cur) return;
  const busy = restoreFile !== null || Array.from(cur.querySelectorAll<HTMLInputElement>("input[type=password]")).some((i) => i.value !== "");
  if (busy && !force) return;
  const open = cur.classList.contains("open");
  const view = r.ok ? parseVaultList(r.data) : null;
  cur.outerHTML = vaultSectionHtml(view, open, r.ok ? (view ? undefined : "The engine answered with a vault list this build cannot read.") : `The vault could not be loaded: ${r.error}`);
  restoreFile = null;
}

function mount(): void {
  if (mounted) return;
  mounted = true;
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const sec = t?.closest(`[data-sec="${VAULT_SEC}"]`);
    if (!t || !sec) return;
    const rot = t.closest<HTMLElement>("[data-vault-rotate]");
    if (rot) { openRotate(rot, rot.dataset.vaultRotate ?? ""); return; }
    const rm = t.closest<HTMLElement>("[data-vault-remove]");
    if (rm) { confirmRemove(rm.dataset.vaultRemove ?? ""); return; }
    if (t.closest("[data-vault-backup]")) { void backupNow(); return; }
    if (t.closest("[data-vault-pick]")) { sec.querySelector<HTMLInputElement>("#vaultRsFile")?.click(); return; }
    if (t.closest("[data-vault-restore]")) void restoreNow();
  });
  document.addEventListener("input", (ev) => {
    const t = ev.target instanceof HTMLInputElement ? ev.target : null;
    if (!t || (t.id !== "vaultBkPass" && t.id !== "vaultBkPass2")) return;
    const pass = document.querySelector<HTMLInputElement>("#vaultBkPass")?.value ?? "";
    const again = document.querySelector<HTMLInputElement>("#vaultBkPass2")?.value ?? "";
    const meter = document.querySelector<HTMLElement>("#vaultBkStrength");
    if (!meter) return;
    const s = passphraseStrength(pass);
    meter.dataset.score = String(s.score);
    meter.textContent = again && again !== pass ? `${s.label}${s.label ? " \u00b7 " : ""}the two entries differ` : s.label;
  });
  document.addEventListener("change", (ev) => {
    const t = ev.target instanceof HTMLInputElement ? ev.target : null;
    if (!t || t.id !== "vaultRsFile") return;
    restoreFile = t.files?.[0] ?? null;
    const name = document.querySelector<HTMLElement>("#vaultRsName");
    if (name) name.textContent = restoreFile ? restoreFile.name : "No file chosen";
    t.value = ""; // choosing the same file again still fires change
  });
}

function openRotate(anchor: HTMLElement, ref: string): void {
  if (!ref) return;
  const inner = `<div class="cfg-sec wl-quick">
    <div class="cfg-lbl">${icon("refresh", 13)} Rotate secret</div>
    <div class="vault-line" title="${esc(ref)}">${esc(ref)}</div>
    <div class="prov-row"><input class="prov-key" data-q="secret" type="password" autocomplete="off" placeholder="Paste the new value" /></div>
    <div class="prov-row"><button class="btn-mini ok" data-q="rotate">${icon("check", 12)} Rotate</button></div>
    <div class="set-note">${icon("shield", 12)} Replaced in place under the same reference. If the vault cannot store it, the old value stays (fail-closed).</div>
  </div>`;
  const { node, close } = popover(anchor, inner);
  const input = node.querySelector<HTMLInputElement>('[data-q="secret"]');
  input?.focus();
  const submit = async (): Promise<void> => {
    const value = input?.value ?? "";
    if (!value) { showToast({ title: "Paste a value", desc: "Enter the new secret to rotate.", actions: [{ label: "OK" }], timeout: 3000 }); return; }
    if (input) input.value = "";
    const r = await vaultApi("/api/vault/rotate", { ref, value });
    if (!r.ok) {
      showToast({ tone: "danger", title: "Rotation failed", desc: r.error === "not-found" ? "That secret is no longer in the vault." : r.error, actions: [{ label: "OK" }], timeout: 5200 });
      return;
    }
    close();
    const last4 = r.data && typeof r.data === "object" && "last4" in r.data && typeof r.data.last4 === "string" ? r.data.last4 : "";
    showToast({ tone: "ok", title: "Secret rotated", desc: `New value stored${last4 ? ` (\u2022\u2022\u2022\u2022${last4})` : ""}; the reference is unchanged.`, timeout: 3600 });
    void hydrateVaultSettings(true);
  };
  node.addEventListener("click", (ev) => { if (ev.target instanceof Element && ev.target.closest('[data-q="rotate"]')) void submit(); });
  node.addEventListener("keydown", (ev) => { if (ev.key === "Enter") void submit(); });
}

function confirmRemove(ref: string): void {
  if (!ref) return;
  showToast({
    tone: "warn",
    title: "Remove this secret?",
    desc: `${ref} is deleted from the vault. Anything that uses it stops working until it is entered again.`,
    timeout: 0,
    actions: [
      { label: "Cancel" },
      {
        label: "Remove", kind: "danger", run: () => {
          void vaultApi("/api/vault/delete", { ref }).then((r) => {
            if (!r.ok) { showToast({ tone: "danger", title: "Not removed", desc: r.error, actions: [{ label: "OK" }], timeout: 5200 }); return; }
            const deleted = !!r.data && typeof r.data === "object" && "deleted" in r.data && r.data.deleted === true;
            showToast({ tone: deleted ? "ok" : "info", title: deleted ? "Secret removed" : "Already gone", desc: ref, timeout: 3200 });
            void hydrateVaultSettings(true);
          });
        },
      },
    ],
  });
}

/** Save the backup text: the native save dialog under Electron (preload), else a browser download. */
async function saveBackup(text: string, filename: string): Promise<{ saved: boolean; where: string } | { error: string }> {
  const save = window.lucid?.saveTextFile;
  if (save) {
    const r = await save({ title: "Save the encrypted vault backup", defaultName: filename, filters: [{ name: "LUCID vault backup", extensions: ["lucidvault"] }], text }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    if (r === null) return { saved: false, where: "" };
    if (typeof r === "string") return { saved: true, where: r };
    return r;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: true, where: `your downloads (${filename})` };
}

async function backupNow(): Promise<void> {
  const p1 = document.querySelector<HTMLInputElement>("#vaultBkPass");
  const p2 = document.querySelector<HTMLInputElement>("#vaultBkPass2");
  const pass = p1?.value ?? "";
  if (pass !== (p2?.value ?? "")) { showToast({ tone: "warn", title: "Passphrases differ", desc: "Type the same passphrase in both boxes.", actions: [{ label: "OK" }], timeout: 3600 }); return; }
  if (passphraseStrength(pass).score === 0) { showToast({ tone: "warn", title: "Passphrase too short", desc: "Use at least 10 characters; a few unrelated words work well.", actions: [{ label: "OK" }], timeout: 4200 }); return; }
  const btn = document.querySelector<HTMLButtonElement>("[data-vault-backup]");
  if (btn) btn.disabled = true;
  try {
    const r = await vaultApi("/api/vault/backup", { passphrase: pass });
    if (!r.ok) { showToast({ tone: "danger", title: "Backup not made", desc: r.error, actions: [{ label: "OK" }], timeout: 5200 }); return; }
    const d = r.data;
    const file = d && typeof d === "object" && "file" in d && typeof d.file === "string" ? d.file : "";
    const filename = d && typeof d === "object" && "filename" in d && typeof d.filename === "string" ? d.filename : "lucid-vault.lucidvault";
    const count = d && typeof d === "object" && "count" in d && typeof d.count === "number" ? d.count : 0;
    if (!file) { showToast({ tone: "danger", title: "Backup not made", desc: "The engine answered without a backup file.", actions: [{ label: "OK" }], timeout: 5200 }); return; }
    const s = await saveBackup(file, filename);
    if ("error" in s) { showToast({ tone: "danger", title: "Backup not saved", desc: s.error, actions: [{ label: "OK" }], timeout: 5200 }); return; }
    if (!s.saved) { showToast({ tone: "info", title: "Backup not saved", desc: "The save dialog was cancelled.", timeout: 3200 }); return; }
    if (p1) p1.value = "";
    if (p2) p2.value = "";
    const meter = document.querySelector<HTMLElement>("#vaultBkStrength");
    if (meter) { meter.textContent = ""; meter.dataset.score = "0"; }
    showToast({ tone: "ok", title: "Vault backed up", desc: `${count} ${count === 1 ? "secret" : "secrets"} encrypted to ${s.where}.`, timeout: 5200 });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function restoreNow(): Promise<void> {
  const passEl = document.querySelector<HTMLInputElement>("#vaultRsPass");
  const out = document.querySelector<HTMLElement>("#vaultRsResult");
  const pass = passEl?.value ?? "";
  if (!restoreFile) { showToast({ tone: "warn", title: "Choose a backup file", desc: "Pick the .lucidvault file to restore.", actions: [{ label: "OK" }], timeout: 3200 }); return; }
  if (!pass) { showToast({ tone: "warn", title: "Enter the passphrase", desc: "Type the passphrase the backup was made with.", actions: [{ label: "OK" }], timeout: 3200 }); return; }
  if (restoreFile.size > MAX_BACKUP_BYTES) { showToast({ tone: "danger", title: "Not a vault backup", desc: "That file is far larger than any LUCID vault backup.", actions: [{ label: "OK" }], timeout: 4200 }); return; }
  const btn = document.querySelector<HTMLButtonElement>("[data-vault-restore]");
  if (btn) btn.disabled = true;
  try {
    const text = await restoreFile.text();
    const r = await vaultApi("/api/vault/restore", { passphrase: pass, file: text });
    if (passEl) passEl.value = "";
    if (!r.ok) {
      if (out) out.textContent = "Nothing was restored.";
      showToast({ tone: "danger", title: "Nothing restored", desc: r.error, actions: [{ label: "OK" }], timeout: 6000 });
      return;
    }
    const d = r.data;
    const n = (k: "added" | "updated" | "skipped"): number => (d && typeof d === "object" && k in d && typeof Reflect.get(d, k) === "number" ? Number(Reflect.get(d, k)) : 0);
    const summary = `${n("added")} added \u00b7 ${n("updated")} updated \u00b7 ${n("skipped")} kept (not newer)`;
    showToast({ tone: "ok", title: "Vault restored", desc: summary, timeout: 6000 });
    await hydrateVaultSettings(true);
    const fresh = document.querySelector<HTMLElement>("#vaultRsResult");
    if (fresh) fresh.textContent = summary;
  } finally {
    const b = document.querySelector<HTMLButtonElement>("[data-vault-restore]");
    if (b) b.disabled = false;
  }
}
