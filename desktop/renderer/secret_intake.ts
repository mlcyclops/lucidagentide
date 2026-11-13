// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/secret_intake.ts - P-SECRET-INTAKE.1 (ADR-0476): the dialog the agent's `request_secret`
// tool opens. The user's value goes from this dialog to the engine vault (UI token) and nowhere else: it is
// never put in the DOM outside the masked field, never logged, and the field is cleared the moment it is
// read. The agent only learns {stored, ref, envName} or {stored:false, reason}.
//
// Security of the markup: the static HTML below interpolates nothing from the request; the agent's name and
// purpose reach the DOM through textContent only (the agent can phrase a request, never style or script it).
// A request is shown only when THIS engine lists it as pending, so an event echoed from somewhere else
// (a collab guest's stream) never opens a dialog asking for a key.
//
// Steps: enter (masked field + show/hide + key-file pick + "Use a text file instead") -> optional wait (the
// notepad fallback) -> "Do you keep another secrets manager or vault?" -> done.

import { bridge } from "./bridge.ts";
import { $, el } from "./dom.ts";
import { icon } from "./icons.ts";
import { isMac, modCombo } from "./platform.ts";
import { showToast } from "./ui.ts";
import { SECRET_MANAGER_LABELS, type SecretCallResult, type SecretManagerAnswer, type SecretRequestView } from "../secret_intake_view.ts";

/** "Copy the key (Ctrl+C), click the box, then paste it (Ctrl+V)." with the OS modifier (⌘ on macOS). */
export function secretHelpText(): string {
  return `Copy the key (${modCombo("C")}), click the box, then paste it (${modCombo("V")}).`;
}

/** The OS editor the text-file fallback opens, by name. */
export function editorLabel(userAgent: string, mac: boolean): string {
  if (mac) return "TextEdit";
  return /windows/i.test(userAgent) ? "Notepad" : "your text editor";
}

/** Where the secret will live and who can use it (names only). Security review
 *  SECRET-INTAKE-AGENT-ENV-READBACK: with an env name, programs the agent runs DO get the value (that is the
 *  point), so the text says that, and that LUCID hides it from what the agent reads back (the
 *  vault_redact_extension tool_result hook); it never claims the agent cannot reach it. */
export function secretWhereText(v: Pick<SecretRequestView, "envName" | "workspace">): string {
  const scope = v.workspace ? ` for the ${v.workspace} workspace only` : "";
  return v.envName
    ? `Saved to LUCID's encrypted vault${scope}. Programs the agent runs can use it as $${v.envName}; LUCID hides the value from the agent.`
    : `Saved to LUCID's encrypted vault${scope}. The agent gets only its name, never the value.`;
}

/** The second confirmation a replacement needs, naming what is saved now. */
export function secretReplaceText(v: Pick<SecretRequestView, "replacesLabel" | "ref">): string {
  return `Replace my saved ${v.replacesLabel ?? v.ref}`;
}

const POLL_MS = 3_000;
const queue: SecretRequestView[] = [];
let openId = "";

/** Show the dialog for a `secret-request` event (or queue it behind the one already open). */
export function showSecretRequest(view: SecretRequestView): void {
  if (view.id === openId || queue.some((q) => q.id === view.id)) return;
  queue.push(view);
  if (!openId) void showNext();
}

/** Boot: re-open any request still waiting (the window reloaded mid-request). */
export function mountSecretIntake(): void {
  void bridge.secretPending().then((list) => { for (const v of list) showSecretRequest(v); });
}

async function showNext(): Promise<void> {
  const view = queue.shift();
  if (!view) return;
  const pending = await bridge.secretPending();
  if (!pending.some((p) => p.id === view.id)) { void showNext(); return; } // not ours, or already over
  openId = view.id;
  try {
    openDialog(view);
  } catch {
    // The dialog itself failed: fall back to the text file so the agent's request can still be answered.
    // No dialog means no replace confirmation: a request that would replace a saved entry is refused here.
    const r = await bridge.secretFallback(view.id, false);
    showToast(r.ok
      ? { tone: "warn", title: "Secret request", desc: `The secret dialog failed to open, so ${editorLabel(navigator.userAgent, isMac())} opened a private text file instead. Paste the key, save, then close the tab without keeping it.`, timeout: 12_000 }
      : { tone: "danger", title: "Secret request", desc: `The secret dialog failed to open and the text-file fallback was refused: ${r.error}`, timeout: 12_000 });
    if (r.ok) void bridge.secretFallbackWait(view.id).then((s) => showToast(s.ok
      ? { title: "Secret stored", desc: `${s.label} is in the vault. LUCID read the text file, overwrote it with zeros and deleted it.`, timeout: 6000 }
      : { tone: "warn", title: "Secret not stored", desc: s.error, timeout: 8000 }));
    closed();
  }
}

function closed(): void {
  openId = "";
  void showNext();
}

function openDialog(view: SecretRequestView): void {
  const multiline = view.kind === "pem" || view.kind === "json";
  const editor = editorLabel(navigator.userAgent, isMac());
  const ov = el(`<div id="secretIntake" class="modal-ov">
    <div class="modal secret-modal" role="dialog" aria-modal="true" aria-labelledby="secretIntakeTitle">
      <div class="modal-icon">${icon("shield", 24)}</div>
      <h2 class="modal-title" id="secretIntakeTitle">A secret is needed</h2>
      <p class="modal-desc"><b class="secret-req"></b> asks for <b class="secret-name"></b>. In its words:</p>
      <div class="secret-purpose"></div>
      <p class="set-note secret-where"></p>
      <label class="set-toggle secret-replace" hidden><input type="checkbox" class="secret-replace-ok" /><span class="secret-replace-text"></span></label>
      <div class="secret-step" data-step="enter">
        <div class="secret-field">
          ${multiline
            ? `<textarea class="prov-key secret-input secret-masked" rows="4" autocomplete="off" spellcheck="false" aria-label="Secret value"></textarea>`
            : `<input class="prov-key secret-input" type="password" autocomplete="off" spellcheck="false" aria-label="Secret value" />`}
          <button class="btn-mini secret-eye" type="button" aria-pressed="false" title="Show or hide what you pasted">${icon("eye", 14)}</button>
        </div>
        <p class="set-note secret-help"></p>
        <div class="modal-err secret-err" hidden></div>
        <div class="modal-actions">
          <button class="btn-mini" type="button" data-act="cancel">Cancel</button>
          <button class="btn-mini" type="button" data-act="file">Choose a key file</button>
          <button class="btn-mini" type="button" data-act="text">Use a text file instead</button>
          <button class="btn-mini ok" type="button" data-act="save">${icon("check", 12)} Save to vault</button>
        </div>
      </div>
      <div class="secret-step" data-step="wait" hidden>
        <p class="modal-desc secret-wait"></p>
        <p class="set-note secret-path"></p>
        <div class="modal-actions"><button class="btn-mini" type="button" data-act="cancel">Cancel</button></div>
      </div>
      <div class="secret-step" data-step="dest" hidden>
        <p class="modal-desc secret-stored"></p>
        <p class="modal-desc">Do you keep another secrets manager or vault?</p>
        <label class="secret-dest-row"><span>Secrets manager</span><select class="prov-key secret-dest-kind"></select></label>
        <label class="secret-dest-row secret-dest-extra" hidden><span>Name</span><input class="prov-key secret-dest-name" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. Production vault" /></label>
        <label class="secret-dest-row secret-dest-azure" hidden><span>Key Vault name</span><input class="prov-key secret-dest-vault" type="text" autocomplete="off" spellcheck="false" /></label>
        <label class="secret-dest-row secret-dest-azure" hidden><span>Cloud</span><select class="prov-key secret-dest-cloud"><option value="public">Azure public</option><option value="usgov">Azure Government</option></select></label>
        <label class="secret-dest-row secret-dest-azure" hidden><span>Sign-in</span><select class="prov-key secret-dest-auth"><option value="azure-cli">Azure CLI</option><option value="managed-identity">Managed identity</option></select></label>
        <p class="set-note secret-dest-note" hidden></p>
        <div class="modal-actions">
          <button class="btn-mini" type="button" data-act="close">Skip</button>
          <button class="btn-mini ok" type="button" data-act="dest">${icon("check", 12)} Save answer</button>
        </div>
      </div>
      <div class="secret-step" data-step="done" hidden>
        <p class="set-note ok secret-done"></p>
        <div class="modal-actions"><button class="btn-mini ok" type="button" data-act="close">Close</button></div>
      </div>
    </div></div>`);
  const q = <T extends HTMLElement = HTMLElement>(sel: string): T => $<T>(sel, ov)!; // static markup above: always present
  q(".secret-req").textContent = view.requester;
  q(".secret-name").textContent = view.name;
  q(".secret-purpose").textContent = view.purpose;
  q(".secret-where").textContent = secretWhereText(view);
  // Security review SECRET-INTAKE-ENVNAME-UNRESTRICTED: replacing a saved entry is a second, explicit choice
  // that names it; the engine refuses the write without it (code "confirm-replace").
  const replaceOk = q<HTMLInputElement>(".secret-replace-ok");
  q(".secret-replace").hidden = !view.replaces;
  q(".secret-replace-text").textContent = secretReplaceText(view);
  q(".secret-help").textContent = `${secretHelpText()} ${multiline ? "A key file (.pem, .json) can be picked instead." : ""}`.trim();
  const input = q<HTMLInputElement | HTMLTextAreaElement>(".secret-input");
  const err = q(".secret-err");
  const kindSel = q<HTMLSelectElement>(".secret-dest-kind");
  for (const [k, label] of Object.entries(SECRET_MANAGER_LABELS)) kindSel.appendChild(new Option(label, k));

  let finished = false; // the request is over (stored, canceled, or gone): polling stops
  const step = (name: string) => { for (const s of ov.querySelectorAll<HTMLElement>(".secret-step")) s.hidden = s.dataset.step !== name; };
  const showErr = (text: string) => { err.textContent = text; err.hidden = false; };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); void cancel(); } };
  const close = () => {
    finished = true;
    clearInterval(poll);
    document.removeEventListener("keydown", onKey);
    input.value = "";
    ov.remove();
    closed();
  };
  const cancel = async () => {
    if (finished) { close(); return; }
    finished = true;
    await bridge.secretCancel(view.id);
    close();
  };
  // The agent's call can end without the user (deadline, Stop): close instead of collecting a value for nothing.
  const poll = setInterval(async () => {
    if (finished) return;
    const still = (await bridge.secretPending()).some((p) => p.id === view.id);
    if (still || finished) return;
    close();
    showToast({ tone: "info", title: "Secret request ended", desc: "The agent's request timed out or was stopped, so nothing was stored.", timeout: 6000 });
  }, POLL_MS);
  const stored = (s: Extract<SecretCallResult, { ok: true }>, how: string) => {
    finished = true;
    clearInterval(poll);
    input.value = "";
    q(".secret-stored").textContent = `${s.label} is in the vault${s.envName ? ` as ${s.envName}` : ""}${s.last4 ? ` (ends in ${s.last4})` : ""}. ${how}`.trim();
    step("dest");
    kindSel.focus();
  };
  const handle = (s: SecretCallResult, how: string) => {
    if (s.ok) { stored(s, how); return; }
    if (s.code === "not-found") { close(); showToast({ tone: "info", title: "Secret request ended", desc: s.error, timeout: 6000 }); return; }
    step("enter");
    showErr(s.code === "empty"
      ? "Nothing was captured. Paste it again, or use a text file instead."
      : `${s.error}. You can try again, or use a text file instead.`);
    q<HTMLButtonElement>("[data-act='text']").focus();
  };

  /** A replacement not yet confirmed: say so before anything is read (the engine refuses it anyway). */
  const unconfirmed = (): boolean => {
    if (!view.replaces || replaceOk.checked) return false;
    showErr(`This replaces your saved ${view.replacesLabel ?? view.ref}. Tick "${secretReplaceText(view)}" first, or cancel.`);
    replaceOk.focus();
    return true;
  };
  const save = async () => {
    if (unconfirmed()) return;
    const value = input.value;
    input.value = ""; // the field never holds the value longer than the request takes
    handle(await bridge.secretSubmit(view.id, value, replaceOk.checked), "");
  };
  const pickFile = async () => {
    err.hidden = true;
    if (unconfirmed()) return;
    if (bridge.isElectron) {
      const path = await bridge.pickFile({ title: `Choose the file for ${view.name}`, filters: [{ name: "Key files", extensions: ["pem", "key", "json", "crt", "p8", "txt"] }] });
      if (path) handle(await bridge.secretSubmitFile(view.id, path, replaceOk.checked), "LUCID read the file directly; it was not changed.");
      return;
    }
    const picker = el(`<input type="file" accept=".pem,.key,.json,.crt,.p8,.txt" hidden />`) as HTMLInputElement;
    picker.addEventListener("change", async () => {
      const file = picker.files?.[0];
      picker.remove();
      if (file) handle(await bridge.secretSubmit(view.id, await file.text(), replaceOk.checked), "The file itself was not changed.");
    });
    ov.appendChild(picker);
    picker.click();
  };
  const textFile = async () => {
    err.hidden = true;
    if (unconfirmed()) return;
    const r = await bridge.secretFallback(view.id, replaceOk.checked);
    if (!r.ok) { showErr(`The text file was refused: ${r.error}.`); return; }
    // Security review SECRET-FALLBACK-ORPHAN: some editors keep their own copy of an open tab to restore it
    // later, so the user is told to close the tab without keeping it.
    q(".secret-wait").textContent = `${editor} opened an empty private file. Paste the key into it, save it (${modCombo("S")}), then close the tab without keeping it (choose "Don't save" if asked). LUCID reads the file, overwrites it with zeros and deletes it.`;
    q(".secret-path").textContent = r.path;
    step("wait");
    handle(await bridge.secretFallbackWait(view.id), `LUCID read the text file, overwrote it with zeros and deleted it. Close the ${editor} tab without keeping it.`);
  };
  const destKind = (): SecretManagerAnswer => (Object.keys(SECRET_MANAGER_LABELS).find((k): k is SecretManagerAnswer => k === kindSel.value) ?? "none");
  const paintDest = () => {
    const k = destKind();
    q(".secret-dest-extra").hidden = k === "none";
    for (const row of ov.querySelectorAll<HTMLElement>(".secret-dest-azure")) row.hidden = k !== "azure-kv";
  };
  const saveDest = async () => {
    const k = destKind();
    const config: Record<string, string> = k === "azure-kv"
      ? { vaultName: q<HTMLInputElement>(".secret-dest-vault").value.trim(), cloud: q<HTMLSelectElement>(".secret-dest-cloud").value, auth: q<HTMLSelectElement>(".secret-dest-auth").value }
      : {};
    const r = await bridge.secretManagerRecord({ answer: k, name: q<HTMLInputElement>(".secret-dest-name").value.trim() || undefined, config });
    const note = q(".secret-done");
    note.textContent = r?.detail ?? "Your answer could not be saved; the secret itself is stored.";
    step("done");
  };

  ov.addEventListener("click", (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "cancel") void cancel();
    else if (act === "close") close();
    else if (act === "save") void save();
    else if (act === "file") void pickFile();
    else if (act === "text") void textFile();
    else if (act === "dest") void saveDest();
  });
  q(".secret-eye").addEventListener("click", (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const show = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(show));
    if (input instanceof HTMLInputElement) input.type = show ? "text" : "password";
    else input.classList.toggle("secret-masked", !show);
  });
  input.addEventListener("input", () => { err.hidden = true; });
  replaceOk.addEventListener("change", () => { err.hidden = true; });
  input.addEventListener("keydown", (e) => { if (e instanceof KeyboardEvent && e.key === "Enter" && !multiline) { e.preventDefault(); void save(); } });
  kindSel.addEventListener("change", paintDest);
  void bridge.secretManagerInfo().then((info) => {
    if (info && !info.enterprise) {
      const n = q(".secret-dest-note");
      n.textContent = "Copying secrets to another manager is an Enterprise feature. Your answer is still remembered.";
      n.hidden = false;
    }
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(ov);
  setTimeout(() => input.focus(), 30);
}
