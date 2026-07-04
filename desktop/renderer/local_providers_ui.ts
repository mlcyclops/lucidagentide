// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/local_providers_ui.ts — P-LOCAL.3 (ADR-0135): the Settings → "Local Providers" card.
//
// Pure builders (no DOM, no fetch) so the card + the add-form parsing are unit-testable. The card lists the
// user's declared self-hosted / custom endpoints and offers an add form; the API key is typed here but goes
// straight to the OS-encrypted vault (app.ts stores it, then saves the provider with only the opaque vaultRef).

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import {
  LOCAL_AUTH_KINDS,
  newLocalProviderId,
  slugify,
  validateLocalProvider,
  type LocalAuthKind,
  type LocalModelDef,
  type LocalProviderDef,
} from "../local_providers.ts";

export function authLabel(k: LocalAuthKind): string {
  return k === "none" ? "No auth (open, e.g. local Ollama)"
    : k === "bearer" ? "Bearer token"
    : k === "apikey" ? "API key header"
    : "Basic auth";
}

/** Vault/enablement status for a provider row. */
export function providerStatus(p: LocalProviderDef, vaultRefs: Set<string>): { label: string; tone: "ok" | "warn" } {
  if (p.authKind === "none") return { label: "open · no key", tone: "ok" };
  if (p.vaultRef && vaultRefs.has(p.vaultRef)) return { label: "key in vault", tone: "ok" };
  return { label: "needs a key", tone: "warn" };
}

function modelSummary(models: LocalModelDef[]): string {
  const n = models.length;
  const head = models.slice(0, 3).map((m) => m.id).join(", ");
  return `${n} model${n === 1 ? "" : "s"}${head ? ` · ${esc(head)}${n > 3 ? " …" : ""}` : ""}`;
}

function providerRow(p: LocalProviderDef, vaultRefs: Set<string>): string {
  const st = providerStatus(p, vaultRefs);
  return `<div class="lp-row" data-lp-id="${esc(p.id)}">
    <label class="set-toggle lp-en" title="Enable / disable"><input type="checkbox" data-lp-toggle ${p.enabled ? "checked" : ""}/><span class="lp-en-box"></span></label>
    <div class="lp-meta">
      <div class="lp-name">${esc(p.name)} <span class="lp-pill ${st.tone}">${esc(st.label)}</span></div>
      <div class="lp-sub">${esc(p.baseUrl)} · ${modelSummary(p.models)}</div>
    </div>
    <button class="btn-mini danger" data-lp-del title="Remove this provider">${icon("close", 12)}</button>
  </div>`;
}

/** The card body: intro + the list of providers + the add form. `vaultRefs` = the refs currently in the
 *  vault (so a provider shows "key in vault" vs "needs a key"); `isElectron` gates the key/vault affordances. */
export function localProvidersCardBody(providers: LocalProviderDef[], vaultRefs: Set<string>, isElectron: boolean): string {
  const list = providers.length
    ? `<div class="lp-list">${providers.map((p) => providerRow(p, vaultRefs)).join("")}</div>`
    : `<div class="set-note">${icon("info", 12)} No local providers yet. Add a self-hosted or custom OpenAI-compatible endpoint below.</div>`;
  const authOpts = LOCAL_AUTH_KINDS.map((k) => `<option value="${k}">${esc(authLabel(k))}</option>`).join("");
  const vaultWarn = isElectron ? "" : `<div class="set-note">${icon("info", 12)} Storing a key needs the LUCID desktop app (the OS-encrypted vault). You can still add an open (no-auth) endpoint here.</div>`;
  return `
    <div class="set-note">${icon("info", 12)} Point LUCID at a self-hosted or custom OpenAI-compatible LLM - Ollama, llama.cpp, vLLM, LM Studio, or a box reached over a VPN tunnel (bring the tunnel up in your VPN client first). The endpoint + models live here; the API key goes only into the OS-encrypted vault. Changes apply on the next app restart.</div>
    ${list}
    ${vaultWarn}
    <div class="lp-add">
      <button class="lp-add-h" data-lp-addtoggle type="button">${icon("plus", 12)} <span>Add a local provider</span><span class="lp-add-chev">${icon("chevron", 14)}</span></button>
      <div class="lp-add-body">
        <input class="prov-key" id="lpName" placeholder="Name (e.g. Hybrid/Private Cloud LLM)" />
        <input class="prov-key" id="lpBaseUrl" placeholder="Base URL (e.g. http://localhost:11434/v1)" />
        <input class="prov-key" id="lpModels" placeholder="Model ids, comma-separated (e.g. llama3.1:8b, gemma3:12b)" />
        <div class="lp-add-row">
          <select class="prov-key lp-auth-sel" id="lpAuth">${authOpts}</select>
          <input class="prov-key" id="lpKey" type="password" placeholder="API key / token (stored in the vault)" autocomplete="off" />
        </div>
        <button class="btn-mini ok" data-lp-add>${icon("check", 12)} Add provider</button>
      </div>
    </div>`;
}

export interface LpFormInput { name: string; baseUrl: string; auth: string; models: string; headerName?: string }

/** PURE: build a validated LocalProviderDef draft from the add-form values (no vaultRef yet — app.ts stores
 *  the key in the vault and sets it). Returns `errors` (fail-closed) when the draft is malformed. */
export function draftFromForm(inp: LpFormInput, now: number): { def?: LocalProviderDef; errors: string[]; needsKey: boolean } {
  const name = (inp.name || "").trim();
  const authKind: LocalAuthKind = (LOCAL_AUTH_KINDS as string[]).includes(inp.auth) ? (inp.auth as LocalAuthKind) : "none";
  const models: LocalModelDef[] = (inp.models || "")
    .split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((id) => ({ id, name: id }));
  const def: LocalProviderDef = {
    id: newLocalProviderId(name || "provider", now),
    name,
    ompProvider: slugify(name),
    baseUrl: (inp.baseUrl || "").trim(),
    api: "openai-completions",
    authKind,
    zone: "internal",
    headerName: authKind === "apikey" ? (inp.headerName?.trim() || undefined) : undefined,
    models,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  const errors = validateLocalProvider(def);
  return { def: errors.length ? undefined : def, errors, needsKey: authKind !== "none" };
}
