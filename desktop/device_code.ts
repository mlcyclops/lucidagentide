// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/device_code.ts - P-PROV.3: the OpenAI device-code sign-in, read SAFELY from omp's broker.
//
// omp's `auth-broker login openai-codex-device` is the Codex device-authorization flow: it prints
//
//   Open this URL in your browser:
//   https://auth.openai.com/codex/device
//   Enter code: LT9B-4W72V
//
// then polls until the user enters that code on OpenAI's page. Nothing is pasted back into LUCID, so the
// engine must READ the code out of the broker's stream and show it. Issue #490 (Emertins, from the GEM
// Codex CLI integration) is the cautionary tale: a parser that grabbed the first code-shaped token in the
// whole transcript surfaced a temp-dir fragment (`CODEX-LOGIN` from `Codex home: /tmp/gem-codex-login-...`)
// as the one-time code and the owner could never finish the sign-in. Its acceptance list is this module:
//   - strip ANSI escapes first (a colored prompt is still the prompt);
//   - accept a code ONLY after the official instruction, never from text before it;
//   - the code must stand alone (its own line, or the rest of the instruction line), shaped `XXXX-XXXX`;
//   - survive chunk boundaries: the scanner keeps a BOUNDED tail across writes, so an instruction split
//     from its code, or a code split mid-token, still resolves once the rest arrives;
//   - expose only the code and an ALLOWLISTED device URL; never the raw transcript.
//
// Pure and DOM-free so it is unit-tested headless; dev.ts owns the broker process.

/** Login aliases: broker ids whose credential lands under ANOTHER provider id (omp's `storeCredentialsAs`,
 *  pi-ai `registry/oauth/types.ts`). The vault snapshot, the stale-disabled clear and the failure note
 *  must all look at the stored id, or a successful device login reads as "no credential landed". The
 *  host allowlist is what the UI may open: a broker that prints any other URL gets no "Open" button. */
export const DEVICE_LOGIN_ALIASES: Record<string, { storesAs: string; hosts: readonly string[] }> = {
  "openai-codex-device": { storesAs: "openai-codex", hosts: ["auth.openai.com"] },
};

/** The provider id the vault files `oauthId`'s credential under (the id itself for non-aliases). */
export function vaultProviderFor(oauthId: string): string {
  return DEVICE_LOGIN_ALIASES[oauthId]?.storesAs ?? oauthId;
}

/** A broker id whose flow SHOWS a code the user types on the provider's page (as opposed to the paste-back
 *  flows). The renderer picks the show-the-code card for these. */
export function isShowCodeLogin(oauthId: string): boolean {
  return oauthId in DEVICE_LOGIN_ALIASES;
}

/** Is `url` one the alias is allowed to open? Exact host match on the allowlist, https only. */
export function deviceUrlAllowed(oauthId: string, url: string): boolean {
  const alias = DEVICE_LOGIN_ALIASES[oauthId];
  if (!alias) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && alias.hosts.includes(u.hostname);
  } catch { return false; }
}

// ESC [ ... final-byte (CSI), ESC ] ... BEL/ST (OSC), and the lone two-byte escapes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** The broker's instruction (omp: `Enter code:`), and the Codex CLI's own phrasing from #490, so a future
 *  omp that relays the CLI text verbatim still parses. Case-insensitive, must be followed by the code. */
const INSTRUCTION = /\b(?:Enter code|Enter this one-time code)\b[^\S\r\n]*:?/i;
/** A standalone code: the rest of the instruction line or its own line, nothing else on it, and a line
 *  break AFTER it. The trailing newline is the chunk guard: "LT9B-4W7" at the end of a buffer may be a
 *  code cut mid-token, so a code is accepted only once the line is complete (`final` lifts that for a
 *  stream that has ended). */
const CODE_LINE = /^[^\S\r\n]*(?:\r?\n[^\S\r\n]*)?([A-Z0-9]{4,8}-[A-Z0-9]{4,8})[^\S\r\n]*\r?\n/i;
const CODE_FINAL = /^[^\S\r\n]*(?:\r?\n[^\S\r\n]*)?([A-Z0-9]{4,8}-[A-Z0-9]{4,8})[^\S\r\n]*(?:\r?\n|$)/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** The device code in `text`, or null. Only a standalone, code-shaped token immediately AFTER the official
 *  instruction counts; code-shaped text anywhere else (paths, ids, the instruction's own words) never does.
 *  `null` is also the answer while the code has not fully arrived (no line break after it yet) unless
 *  `final` says the stream is over. */
export function extractDeviceCode(text: string, final = false): string | null {
  const visible = stripAnsi(text);
  const at = INSTRUCTION.exec(visible);
  if (!at) return null;
  const m = (final ? CODE_FINAL : CODE_LINE).exec(visible.slice(at.index + at[0].length));
  return m ? m[1]!.toUpperCase() : null;
}

/** Bounded, chunk-safe reader over a broker's stdout. Feed every chunk; `code` is set once a complete
 *  instruction + code has been seen. Keeps only the last `keep` characters, so a long transcript never
 *  accumulates (and is never exposed): the broker's output stays in dev.ts's drain, not here. */
export class DeviceCodeScanner {
  #tail = "";
  #code: string | null = null;
  constructor(private readonly keep = 2048) {}
  push(chunk: string, final = false): string | null {
    if (this.#code) return this.#code;
    this.#tail = (this.#tail + chunk).slice(-this.keep);
    this.#code = extractDeviceCode(this.#tail, final);
    return this.#code;
  }
  get code(): string | null { return this.#code; }
}
