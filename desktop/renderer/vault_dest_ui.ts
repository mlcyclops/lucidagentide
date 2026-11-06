// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/vault_dest_ui.ts
//
// P-VAULT-DEST.1 (ADR-0478): hydrates and wires the Settings section built by vault_dest_card.ts. app.ts
// renders the collapsed skeleton (setSkel with VAULT_DEST_SEC / _TITLE / _SUB) and calls
// hydrateVaultDestinations() from hydrateSettings(); everything else lives here. The section's open state
// is the app's own (the `.open` class its `[data-setcard]` handler toggles), kept across repaints.
//
// Every call goes to the engine's UI-token vault routes (vault_dest_routes.ts). Their replies carry
// names, refs, counts and value-free details only, which is all this module ever shows.

import { bridge } from "./bridge.ts";
import { showToast } from "./ui.ts";
import {
  VAULT_DEST_SEC, vaultDestCardHtml, type DestinationsData, type DestRow, type VaultRefOption,
} from "./vault_dest_card.ts";

interface CheckData { ok: boolean; detail: string }
interface PushData { ok: boolean; pushed: Array<{ ref: string; name: string }>; skipped: Array<{ ref: string; reason: string }>; detail: string }
interface ListData { ok: boolean; items: Array<{ ref: string; local: "missing" | "older" | "current" }>; unmapped: number; detail: string }
interface PullData { ok: boolean; added: number; updated: number; unchanged: number; skipped: number; detail: string }

let generation = 0;
let current: DestinationsData | null = null;
let entryCount = 0;

const section = (): HTMLElement | null => document.querySelector<HTMLElement>(`#setBody [data-sec="${VAULT_DEST_SEC}"]`);

/** Fetch the add-on status, the destinations and the vault refs, and repaint the section in place. */
export async function hydrateVaultDestinations(): Promise<void> {
  const gen = ++generation;
  const [view, list] = await Promise.all([
    bridge.vaultDest<DestinationsData>("/api/vault/destinations"),
    bridge.vaultDest<{ entries: VaultRefOption[] }>("/api/vault/list"),
  ]);
  if (gen !== generation) return;
  const el = section();
  if (!el) return;
  current = view.ok && view.data ? view.data : null;
  const refs = list.ok ? list.data?.entries ?? [] : [];
  entryCount = refs.length;
  el.outerHTML = vaultDestCardHtml(current, refs, el.classList.contains("open"), view.error ?? "");
  const fresh = section();
  if (fresh) wire(fresh);
}

function rowOf(t: Element): { wrap: HTMLElement; dest: DestRow } | null {
  const wrap = t.closest<HTMLElement>("[data-vd-id]");
  const dest = wrap ? current?.destinations.find((d) => d.id === wrap.dataset.vdId) : undefined;
  return wrap && dest ? { wrap, dest } : null;
}

/** Show an outcome under a destination row (tone ok / warn). */
function showResult(wrap: HTMLElement, ok: boolean, text: string): void {
  const note = wrap.querySelector<HTMLElement>("[data-vd-result]");
  if (!note) return;
  note.hidden = false;
  note.classList.toggle("ok", ok);
  note.classList.toggle("warn", !ok);
  const span = note.querySelector("span");
  if (span) span.textContent = text;
}

/** Run `fn` with `btn` disabled and relabelled; restores it afterwards. */
async function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>): Promise<void> {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); } finally { btn.disabled = false; btn.innerHTML = orig; }
}

function pushText(r: PushData): string {
  const skipped = r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.ref} (${s.reason})`).join("; ")}.` : "";
  return `${r.ok ? "Pushed" : "Push stopped after"} ${r.pushed.length} entr${r.pushed.length === 1 ? "y" : "ies"}.${skipped} ${r.detail}`;
}

function listText(r: ListData): string {
  if (!r.ok) return r.detail;
  const missing = r.items.filter((i) => i.local === "missing").length;
  const older = r.items.filter((i) => i.local === "older").length;
  const other = r.unmapped ? ` ${r.unmapped} other secret${r.unmapped === 1 ? "" : "s"} there ${r.unmapped === 1 ? "was" : "were"} not written by LUCID and ${r.unmapped === 1 ? "is" : "are"} left alone.` : "";
  return `${r.items.length} LUCID entr${r.items.length === 1 ? "y" : "ies"} there: ${missing} not on this machine, ${older} newer there than here.${other}`;
}

function formValue(root: HTMLElement, id: string): string {
  return (root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value ?? "").trim();
}

function syncAuthFields(root: HTMLElement): void {
  const client = root.querySelector<HTMLElement>(".vd-client");
  if (client) client.hidden = formValue(root, "vdAuth") !== "client-secret";
}

function fillForm(root: HTMLElement, d: DestRow | null): void {
  const set = (id: string, v: string): void => { const f = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`); if (f) f.value = v; };
  set("vdId", d?.id ?? "");
  set("vdName", d?.name ?? "");
  set("vdVault", d?.config.vaultName ?? "");
  set("vdCloud", d?.config.cloud ?? "public");
  set("vdAuth", d?.config.auth ?? "azure-cli");
  set("vdTenant", d?.config.tenantId ?? "");
  set("vdClient", d?.config.clientId ?? "");
  set("vdSecretRef", d?.config.clientSecretRef ?? "");
  const auto = root.querySelector<HTMLInputElement>("#vdAutoNew");
  if (auto) auto.checked = !!d?.autoBackup;
  const title = root.querySelector<HTMLElement>("[data-vd-form-title]");
  if (title) title.textContent = d ? `Edit "${d.name}"` : "Add an Azure Key Vault destination";
  const cancel = root.querySelector<HTMLElement>("[data-vd-cancel]");
  if (cancel) cancel.hidden = !d;
  syncAuthFields(root);
  if (d) {
    root.querySelector(".vd-add")?.classList.add("open");
    root.querySelector<HTMLInputElement>("#vdName")?.focus();
  }
}

async function save(root: HTMLElement): Promise<void> {
  const auth = formValue(root, "vdAuth");
  const config: Record<string, string> = { vaultName: formValue(root, "vdVault"), cloud: formValue(root, "vdCloud"), auth };
  const tenant = formValue(root, "vdTenant");
  if (tenant) config.tenantId = tenant;
  if (auth === "client-secret") {
    const client = formValue(root, "vdClient");
    const secretRef = formValue(root, "vdSecretRef");
    if (client) config.clientId = client;
    if (secretRef) config.clientSecretRef = secretRef;
  }
  const id = formValue(root, "vdId");
  const autoBackup = !!root.querySelector<HTMLInputElement>("#vdAutoNew")?.checked;
  const r = await bridge.vaultDest<DestRow>("/api/vault/destinations/save", { ...(id ? { id } : {}), name: formValue(root, "vdName"), kind: "azure-kv", config, autoBackup });
  if (!r.ok || !r.data) { showToast({ tone: "danger", title: "Destination not saved", desc: r.error ?? "The engine refused the destination.", timeout: 7000 }); return; }
  showToast({ tone: "ok", title: id ? "Destination updated" : "Destination added", desc: `Use Test to check sign-in and reach "${r.data.name}" before the first push.`, timeout: 5000 });
  await hydrateVaultDestinations();
}

function confirmThen(title: string, desc: string, label: string, kind: "ok" | "danger", run: () => void): void {
  showToast({ tone: kind === "danger" ? "warn" : "info", title, desc, actions: [{ label, kind, run }, { label: "Cancel" }] });
}

async function onClick(root: HTMLElement, e: MouseEvent): Promise<void> {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const btn = t.closest<HTMLButtonElement>("button");
  if (!btn || !root.contains(btn)) return;
  if (btn.hasAttribute("data-vd-save")) { await busy(btn, "Saving\u2026", () => save(root)); return; }
  if (btn.hasAttribute("data-vd-cancel")) { fillForm(root, null); return; }
  const row = rowOf(btn);
  if (!row) return;
  const { wrap, dest } = row;
  const id = dest.id;
  if (btn.hasAttribute("data-vd-check")) {
    await busy(btn, "Testing\u2026", async () => {
      const r = await bridge.vaultDest<CheckData>("/api/vault/destinations/check", { id });
      showResult(wrap, !!r.data?.ok, r.data ? r.data.detail : r.error ?? "No answer.");
    });
  } else if (btn.hasAttribute("data-vd-list")) {
    await busy(btn, "Reading\u2026", async () => {
      const r = await bridge.vaultDest<ListData>("/api/vault/destinations/list", { id });
      showResult(wrap, !!r.data?.ok, r.data ? listText(r.data) : r.error ?? "No answer.");
    });
  } else if (btn.hasAttribute("data-vd-push")) {
    confirmThen("Push every vault entry?", `Sends all ${entryCount} entr${entryCount === 1 ? "y" : "ies"} in this machine's vault to "${dest.name}". Entries LUCID pushed before get a new version there.`, "Push", "ok", () => {
      void busy(btn, "Pushing\u2026", async () => {
        const r = await bridge.vaultDest<PushData>("/api/vault/push", { id });
        showResult(wrap, !!r.data?.ok, r.data ? pushText(r.data) : r.error ?? "No answer.");
      });
    });
  } else if (btn.hasAttribute("data-vd-pull")) {
    await busy(btn, "Pulling\u2026", async () => {
      const r = await bridge.vaultDest<PullData>("/api/vault/pull", { id });
      const d = r.data;
      showResult(wrap, !!d?.ok, d ? (d.ok ? `Added ${d.added}, updated ${d.updated}, unchanged ${d.unchanged}, kept ${d.skipped} newer here. ${d.detail}` : d.detail) : r.error ?? "No answer.");
      if (d?.ok && d.added + d.updated > 0) showToast({ tone: "ok", title: "Vault updated", desc: `${d.added} added and ${d.updated} updated from "${dest.name}".`, timeout: 5000 });
    });
  } else if (btn.hasAttribute("data-vd-edit")) {
    fillForm(root, dest);
  } else if (btn.hasAttribute("data-vd-remove")) {
    confirmThen(`Remove "${dest.name}"?`, "LUCID forgets this destination. Nothing is deleted at the destination itself.", "Remove", "danger", () => {
      void bridge.vaultDest<{ removed: boolean }>("/api/vault/destinations/remove", { id }).then((r) => {
        if (!r.ok) showToast({ tone: "danger", title: "Not removed", desc: r.error ?? "No answer.", timeout: 5000 });
        void hydrateVaultDestinations();
      });
    });
  }
}

async function onChange(root: HTMLElement, e: Event): Promise<void> {
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (!t) return;
  if (t.id === "vdAuth") { syncAuthFields(root); return; }
  if (!(t instanceof HTMLInputElement) || !t.hasAttribute("data-vd-auto")) return;
  const row = rowOf(t);
  if (!row) return;
  t.disabled = true;
  const r = await bridge.vaultDest<DestRow>("/api/vault/destinations/auto-backup", { id: row.dest.id, on: t.checked });
  if (!r.ok) showToast({ tone: "danger", title: "Auto-backup not changed", desc: r.error ?? "No answer.", timeout: 5000 });
  await hydrateVaultDestinations();
}

function wire(root: HTMLElement): void {
  root.addEventListener("click", (e) => { void onClick(root, e); });
  root.addEventListener("change", (e) => { void onChange(root, e); });
  syncAuthFields(root);
}
