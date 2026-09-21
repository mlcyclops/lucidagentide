// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/browser_extension.ts - P-BROWSER.1 (wave 2): agent-callable tools for the VISIBLE,
// agent-controlled browser window (a real Chromium BrowserWindow owned by the Electron main).
//
// HOW IT REACHES THE WINDOW: these tools run in omp's SUBPROCESS, which has no channel to Electron -
// so each call POSTs the dev server's /api/browser routes via the token'd LUCID_BROWSER_URL base this
// child inherits (same ?t= convention as LUCID_INTERJECT_URL). The dev server queues the command
// (desktop/browser_control.ts) and the Electron main's 500ms poll loop executes it on the window,
// posting the result back; the route holds the HTTP response until then. Compositor-level capturePage
// means DOM-locking/anti-agent pages can't blind the agent - and the window is VISIBLE on purpose:
// the user watches every step, can log in, and closing the window is a hard kill switch.
//
// GATING: `browser_open` declares the "exec" approval tier - of omp's three tiers (read/write/exec,
// ToolTier in pi-agent-core), exec is the gated one ("Always ask" and "Write" modes both prompt for
// it; read/write auto-approve in "Write" mode). Because omp's DEFAULT approvalMode is "yolo" (which
// auto-approves every tier), the guaranteed ask comes from acp_config.yml `tools.approval.browser_open:
// prompt` - the same P-EGRESS.1 mechanism that forces browser/web/fetch to prompt in every mode. The
// desktop then routes the request to the per-website egress dialog (the toolCall carries the https URL,
// and the tool name contains "browser", both of which acp_backend's isEgress matches). The iterate
// tools (screenshot/scroll/close) are "read": they only observe or wind down the already-approved
// window, so they must never re-trip a gate mid-iteration.
//
// Follows preview_extension.ts: resilient schema authoring (TypeBox shim when healthy, structurally
// identical plain JSON-Schema literals otherwise), ImageContent built from the data URL, registration
// wholly wrapped so a failure never breaks omp launch, and skip-when-env-absent (a bun-only or
// plain-browser dev run has no Electron main, hence no window executor and no LUCID_BROWSER_URL).
//
// P-JEV.4 (ADR-0379): `browser_run` drives the SAME already-open window toward a natural-language goal
// with the Jev browser action policy (harness/browser_policy.ts, a port of browser-use/jev-ultrafast).
// Per step: POST /snapshot (an indexed element table read in an isolated world), ONE typed judgment for
// the operation plus a speculative target per operation, then POST /act for exactly the matching head
// with the snapshot's freshness reference, so a page that changed since the decision executes nothing.
// Jev only ever picks an offered index or a caller-supplied value NAME; it never writes text, selectors
// or code, and page content reaches it only as delimited untrusted data. Fail-closed throughout: a
// missing or malformed judgment, a stale page, an unreachable judge or a browser error ends the run with
// no further action. The loop itself (runBrowserGoal) takes an io pair and a judge so it is testable
// without fetch or a model; the tool wires those to the /api/browser routes and omp's resolveJudge.

import { actionSpace, decide, DEFAULT_STEPS, type HistoryEntry, MAX_STEPS, PolicyError, policyQuestions, policyState, stalled } from "../browser_policy.ts";
import { type BrowserAction, type BrowserFreshness, type BrowserPage, freshnessOf, isBrowserPageShape } from "../../desktop/browser_snapshot.ts";

interface ToolContentBlock { type: string; text?: string; data?: string; mimeType?: string }
interface ToolResult { content: ToolContentBlock[]; isError?: boolean }

/** The judge surface browser_run needs: omp's ResolvedJudge satisfies it, and a test can script one. */
export interface JudgeLike {
  judge(request: { state: unknown; questions: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<{ answers: Record<string, unknown> }>;
}

/** Injectable dependencies. `judge` resolves the judge per call from the ExtensionContext (the 5th
 *  execute argument); the default reaches omp's resolveJudge with the online backend. */
export interface BrowserExtensionDeps {
  judge?: (ctx: unknown) => Promise<JudgeLike>;
}

/** What the loop needs from the desktop: the parsed { ok, data, error } envelopes of the two routes. */
export interface BrowserRunIo {
  snapshot(): Promise<unknown>;
  act(body: { action: BrowserAction; fresh: BrowserFreshness; text?: string }): Promise<unknown>;
}

export type BrowserRunStatus = "done" | "blocked" | "needs_values" | "stalled" | "max_steps" | "judgment_budget" | "cancelled" | "failed";

/** Parse a `data:image/…;base64,…` URL into omp ImageContent ({ type, data, mimeType } - the shape the
 *  model actually sees), or null when it isn't a valid image data URL. Same contract as
 *  preview_extension.previewShotImage; pure + exported so it's unit-testable without a live desktop. */
export function browserShotImage(dataUrl: string | null | undefined): { type: "image"; data: string; mimeType: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec((dataUrl ?? "").trim());
  const mimeType = m?.[1], data = m?.[2];
  return mimeType && data ? { type: "image", data, mimeType } : null;
}

/** The /api/browser endpoint for `path` ("/open", ...), keeping the ?t= token LUCID_BROWSER_URL carries.
 *  Null when the env is absent/malformed (then the caller degrades to helpful text). */
export function browserEndpoint(base: string | undefined, path: string): string | null {
  if (!base) return null;
  try {
    const u = new URL(base);
    u.pathname = `${u.pathname.replace(/\/+$/, "")}${path}`;
    return u.toString();
  } catch { return null; }
}

/** One field of a { ok, data, error } dev-server envelope, read with runtime narrowing (no casts). */
function envelopeField(body: unknown, field: string): unknown {
  if (!body || typeof body !== "object" || !(field in body)) return undefined;
  const record = body as Record<string, unknown>; // safe view: verified non-null object above, values stay unknown
  return record[field];
}

/** The envelope's error string, or `fallback` when the body carries none. */
function failText(body: unknown, fallback: string): string {
  const err = envelopeField(body, "error");
  return typeof err === "string" && err ? err : fallback;
}

/** Longest string the /act route accepts for a fill (the same cap browser_type enforces). */
const MAX_VALUE_LENGTH = 2000;

/** Parse the `values` tool param: absent/blank -> {}; otherwise a JSON object whose values are
 *  1..2000-character strings. Returns an error string for anything else so the run never starts. */
export function parseRunValues(raw: unknown): Record<string, string> | string {
  const shape = 'values must be a JSON object of named strings, for example {"origin":"Zurich","date":"2026-10-03"}';
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return `browser_run: ${shape}.`;
  if (!raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return `browser_run: values is not valid JSON; ${shape}.`; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `browser_run: ${shape}.`;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") return `browser_run: value "${name}" is not a string; ${shape}.`;
    if (!value || value.length > MAX_VALUE_LENGTH) return `browser_run: value "${name}" must be 1 to ${MAX_VALUE_LENGTH} characters.`;
    out[name] = value;
  }
  return out;
}

/** Clamp the `maxSteps` tool param to 1..MAX_STEPS, defaulting to DEFAULT_STEPS. */
export function clampSteps(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_STEPS;
  return Math.min(MAX_STEPS, Math.max(1, Math.round(n)));
}

/** omp's `ONLINE_MEMORY_MODEL_KEY` (tiny/models.ts): the chat-chain backend a judgment falls back to.
 *  Spelled here because `tiny/models` is not one of the module keys omp's legacy-pi shim serves from the
 *  host bundle, and a fall-through import would load a duplicate source copy with its own worker state. */
const ONLINE_JUDGE_BACKEND = "online";

/** Resolve omp's own judge for this session (TypeSafe when configured, else the online tiny/smol chain)
 *  from the ExtensionContext's model registry. Throws when the context or the imports do not line up.
 *  Dynamic imports on purpose: omp's package index is the whole coding agent, and this extension must
 *  load (and be unit-tested) without pulling it in. The three specifiers are exactly the keys omp's
 *  `omp:legacy-pi-shim` Bun plugin routes onto the HOST's bundled instances (`config/settings`,
 *  `config/model-registry`, `judgment`), which is what makes `settings` the initialized singleton and
 *  the registry pass instanceof; a subpath outside that table would resolve to a second source copy. */
async function resolveDefaultJudge(ctx: unknown): Promise<JudgeLike> {
  const registry = ctx && typeof ctx === "object" && "modelRegistry" in ctx ? ctx.modelRegistry : null;
  if (!registry || typeof registry !== "object") throw new Error("no model registry on the extension context");
  const { settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { resolveJudge } = await import("@oh-my-pi/pi-coding-agent/judgment");
  const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
  if (!(registry instanceof ModelRegistry)) throw new Error("the extension context's model registry is not omp's");
  return resolveJudge({ settings, registry, backend: ONLINE_JUDGE_BACKEND });
}

/** A run-ending condition the loop reports (never thrown past runBrowserGoal). */
class RunError extends Error {}

/** Narrow a /snapshot envelope to a BrowserPage with its fingerprint, or throw the server's reason. */
function pageOf(body: unknown): BrowserPage {
  if (envelopeField(body, "ok") !== true) throw new RunError(`snapshot failed: ${failText(body, "the browser window did not respond (is it still open?)")}`);
  const page = envelopeField(envelopeField(body, "data"), "page");
  const fingerprint = envelopeField(page, "fingerprint");
  if (!isBrowserPageShape(page) || typeof fingerprint !== "string" || !fingerprint) throw new RunError("snapshot failed: the page came back malformed");
  return { ...page, fingerprint };
}

/** Render one finished run: the status line, one line per executed action (typed text is shown by its
 *  VALUE NAME, never the value), then the hint for what to do next. */
function renderRun(status: BrowserRunStatus, page: BrowserPage | null, history: readonly HistoryEntry[], detail: string): ToolResult {
  const where = page ? ` on "${page.title}" ${page.url}` : "";
  const failed = status === "failed" || status === "cancelled";
  const lines = [`browser_run ${status}${failed && detail ? ` (${detail})` : ""} after ${history.length} action(s)${where}`];
  for (const h of history) lines.push(`${h.step}. ${h.action}${h.text ? ` typed ${h.text}` : ""} (p=${h.probability.toFixed(2)} c=${h.confidence.toFixed(2)})`);
  const hint: Record<BrowserRunStatus, string> = {
    done: "Jev chose DONE, which is not proof: call browser_screenshot to verify the page shows the goal satisfied.",
    blocked: "Jev found no supported operation that makes progress. Call browser_screenshot to see the page, then continue with browser_click/browser_type or refine the goal.",
    stalled: "The last actions changed nothing on the page. Call browser_screenshot to see what is stuck, then continue with browser_click/browser_type or refine the goal.",
    needs_values: `Supply values=${JSON.stringify({ [detail]: "..." })} and call browser_run again.`,
    max_steps: "The step budget ran out. Call browser_screenshot to check progress, then browser_run again to continue.",
    judgment_budget: "The judgment budget ran out (too many stale re-decisions). Call browser_screenshot to check the page, then browser_run again.",
    cancelled: "The run was cancelled; nothing further was executed.",
    failed: "No further action was executed. Call browser_screenshot to see the page state.",
  };
  lines.push(hint[status]);
  return { content: [{ type: "text", text: lines.join("\n") }], ...(failed ? { isError: true } : {}) };
}

/** Drive the open window toward `goal`: snapshot, one judgment, at most one action, repeat. Bounded by
 *  `maxSteps` executed actions and 2*maxSteps judgments (a stale act re-decides without spending a step).
 *  Never throws; every stop reason becomes a rendered ToolResult, and every failure is isError with
 *  nothing executed past the last successful action. */
export async function runBrowserGoal(io: BrowserRunIo, judge: JudgeLike, goal: string, values: Record<string, string>, maxSteps: number, signal?: AbortSignal): Promise<ToolResult> {
  const history: HistoryEntry[] = [];
  const judgmentBudget = 2 * maxSteps;
  let judgments = 0;
  let page: BrowserPage | null = null;
  try {
    page = pageOf(await io.snapshot());
    for (;;) {
      if (signal?.aborted) return renderRun("cancelled", page, history, "");
      if (history.length >= maxSteps) return renderRun("max_steps", page, history, "");
      if (stalled(history)) return renderRun("stalled", page, history, "");
      if (judgments >= judgmentBudget) return renderRun("judgment_budget", page, history, "");
      const space = actionSpace(page.actions);
      const questions = policyQuestions(space, goal, values);
      const state = policyState(page, space, history, values);
      judgments += 1;
      let answers: Record<string, unknown>;
      try {
        const result = await judge.judge({ state, questions }, { signal });
        const got = envelopeField(result, "answers");
        if (!got || typeof got !== "object") throw new PolicyError("Invalid judgment; no action executed.");
        answers = got as Record<string, unknown>; // safe view: verified non-null object above, values stay unknown
      } catch (e) {
        if (signal?.aborted) return renderRun("cancelled", page, history, "");
        throw new RunError(e instanceof PolicyError ? e.message : `judgment failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const decision = decide(answers, space, values);
      if (decision.kind === "done") return renderRun("done", page, history, "");
      if (decision.kind === "blocked") return renderRun("blocked", page, history, "");
      if (decision.kind === "needs_values") return renderRun("needs_values", page, history, decision.field);
      const acted = await io.act({ action: decision.action, fresh: freshnessOf(page, decision.action), ...(decision.text !== null ? { text: decision.text } : {}) });
      if (envelopeField(acted, "ok") !== true) {
        if (envelopeField(acted, "stale") === true) { page = pageOf(await io.snapshot()); continue; }
        throw new RunError(`act failed: ${failText(acted, "the browser window did not respond (is it still open?)")}`);
      }
      const next = pageOf(await io.snapshot());
      history.push({
        step: history.length + 1,
        action: `${decision.operation}${decision.target !== null ? ` [${decision.target}]` : ""} ${decision.action.label}`,
        kind: decision.action.kind,
        operation: decision.operation,
        // The value NAME only: the judge's recent_actions and the rendered result both show `typed <name>`.
        text: decision.text === null ? null : Object.keys(values).find((k) => values[k] === decision.text) ?? "value",
        page_changed: next.fingerprint !== page.fingerprint,
        probability: decision.probability,
        confidence: decision.confidence,
      });
      page = next;
    }
  } catch (e) {
    if (signal?.aborted) return renderRun("cancelled", page, history, "");
    const reason = e instanceof RunError || e instanceof PolicyError ? e.message : `unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    return renderRun("failed", page, history, reason);
  }
}

export default function browserExtension(pi: unknown, deps: BrowserExtensionDeps = {}): void {
  let schemaMode: "typebox" | "literal" = "literal";
  try {
    const register = pi && typeof pi === "object" && "registerTool" in pi ? pi.registerTool : null;
    if (typeof register !== "function") return; // older omp / no custom-tool support -> no-op
    const base = process.env.LUCID_BROWSER_URL;
    if (!base) return; // no Electron main = no window executor: skip registration entirely
    const registerTool = register.bind(pi);

    // Author the parameter schemas via omp's injected TypeBox shim when it is HEALTHY (Object/String/
    // Number/Optional all present); otherwise fall back to plain JSON-Schema object literals - the same
    // shape TypeBox emits at runtime, so registerTool sees a structurally identical schema either way.
    const typebox = pi && typeof pi === "object" && "typebox" in pi ? pi.typebox : null;
    const T = typebox && typeof typebox === "object" && "Type" in typebox ? typebox.Type : null;
    const tb = T && typeof T === "object" ? (T as Record<string, unknown>) : null; // shim surface is untyped by design
    const typeboxOk = !!tb && typeof tb.Object === "function" && typeof tb.String === "function" && typeof tb.Number === "function" && typeof tb.Boolean === "function" && typeof tb.Optional === "function";
    schemaMode = typeboxOk ? "typebox" : "literal";
    /** Declare a tool's params ONCE (name -> { desc, kind }) and build them for the active mode. */
    const schema = (props: Record<string, { desc: string; kind: "string" | "number" | "boolean" }>, optional: string[] = []): unknown => {
      if (typeboxOk && tb) {
        const make = (kind: string, opts: Record<string, unknown>): unknown => {
          const fn = kind === "number" ? tb.Number : kind === "boolean" ? tb.Boolean : tb.String;
          return typeof fn === "function" ? fn(opts) : opts;
        };
        const wrap = typeof tb.Optional === "function" ? tb.Optional : null;
        const shape: Record<string, unknown> = {};
        for (const [k, p] of Object.entries(props)) {
          const s = make(p.kind, { description: p.desc });
          shape[k] = optional.includes(k) && wrap ? wrap(s) : s;
        }
        return typeof tb.Object === "function" ? tb.Object(shape) : { type: "object", properties: shape };
      }
      const properties: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(props)) properties[k] = { type: p.kind, description: p.desc };
      const required = Object.keys(props).filter((k) => !optional.includes(k));
      return { type: "object", properties, ...(required.length ? { required } : {}) };
    };

    const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
    /** POST an /api/browser route; resolves to the parsed body or null (network/timeout/parse failure).
     *  The timeout must OUTLAST the server's own hold (open holds 20s, the rest 10s) so a slow page
     *  reports the server's real verdict instead of a spurious client-side abort. */
    const call = async (path: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
      const url = browserEndpoint(base, path);
      if (!url) return null;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return await r.json().catch(() => null);
      } catch { return null; }
    };

    registerTool({
      name: "browser_open",
      label: "Open the agent browser",
      description:
        "Open a visible, agent-controlled browser window at a URL. The user sees the window and can " +
        "close it at any time to stop you. Use it for pages you cannot read or drive any other way. " +
        "The loop is: browser_open, then browser_screenshot to see, then act with browser_scroll, " +
        "browser_click, browser_type, browser_drag or browser_keys, screenshotting again after each " +
        "action, then browser_close when done. Every action takes SCREENSHOT coordinates, so always " +
        "look before you act. If a page needs a login, ask the user to sign in inside the window " +
        "rather than typing their credentials yourself.",
      // The GATED tier: "exec" (read/write/exec are omp's tiers; read+write auto-approve in Write mode,
      // exec always prompts outside yolo). The every-mode guarantee is acp_config.yml
      // `tools.approval.browser_open: prompt` (P-EGRESS.1 pattern) - the desktop shows its per-website
      // egress dialog because the request carries an https target and a "browser" tool name.
      approval: "exec",
      parameters: schema({ url: { desc: "The http(s) URL to open in the visible agent browser window", kind: "string" } }),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResult> {
        const raw = params && typeof params === "object" && "url" in params ? params.url : "";
        const url = String(typeof raw === "string" ? raw : "").trim();
        if (!/^https?:\/\//i.test(url)) return text(`browser_open: "${url}" is not an http(s) URL - nothing to open.`, true);
        const body = await call("/open", { url }, 25_000);
        if (envelopeField(body, "ok") !== true) return text(`browser_open failed: ${failText(body, "the browser window did not respond (is the desktop app running?)")}`, true);
        const data = envelopeField(body, "data");
        const title = typeof envelopeField(data, "title") === "string" ? String(envelopeField(data, "title")) : "";
        return text(`Opened ${url}${title ? ` - "${title}"` : ""} in the visible agent browser. The user is watching this window and can close it to stop you. Call browser_screenshot to see the page; then browser_scroll, browser_click (screenshot coordinates), or browser_type to act, screenshotting after each step.`);
      },
    });

    registerTool({
      name: "browser_screenshot",
      label: "Screenshot the agent browser",
      description:
        "Capture what the agent browser window currently shows and return it as an image you can read. " +
        "Compositor-level capture: works even on pages that block DOM automation. Iterate with " +
        "browser_scroll to read a whole page. Open a page with browser_open first.",
      approval: "read",
      parameters: schema({}),
      async execute(): Promise<ToolResult> {
        const body = await call("/capture", {}, 20_000);
        if (envelopeField(body, "ok") !== true) return text(`browser_screenshot failed: ${failText(body, "no browser window is open - call browser_open first")}`, true);
        const data = envelopeField(body, "data");
        const png = envelopeField(data, "png");
        const img = browserShotImage(typeof png === "string" ? png : null);
        if (!img) return text("browser_screenshot: the capture came back empty - try again, or browser_open the page first.", true);
        const title = typeof envelopeField(data, "title") === "string" ? String(envelopeField(data, "title")) : "";
        return { content: [img, { type: "text", text: `Screenshot of the agent browser${title ? ` - "${title}"` : ""} (the user sees this same window).` }] };
      },
    });

    registerTool({
      name: "browser_scroll",
      label: "Scroll the agent browser",
      description:
        "Scroll the agent browser window vertically by `dy` pixels (default 800; negative scrolls up), " +
        "then call browser_screenshot to read the newly visible content. Iterate scroll + screenshot to " +
        "work through a long page.",
      approval: "read",
      parameters: schema({ dy: { desc: "Pixels to scroll down (negative scrolls up); default 800", kind: "number" } }, ["dy"]),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResult> {
        const raw = params && typeof params === "object" && "dy" in params ? params.dy : undefined;
        const dy = typeof raw === "number" && Number.isFinite(raw) ? raw : Number(raw);
        const step = Number.isFinite(dy) ? dy : 800;
        const body = await call("/scroll", { dy: step }, 20_000);
        if (envelopeField(body, "ok") !== true) return text(`browser_scroll failed: ${failText(body, "no browser window is open - call browser_open first")}`, true);
        return text(`Scrolled the agent browser by ${step}px. Call browser_screenshot to read what is visible now.`);
      },
    });

    registerTool({
      name: "browser_click",
      label: "Click in the agent browser",
      description:
        "Click a point in the agent browser window. Coordinates are in SCREENSHOT pixel space: the " +
        "origin is the top-left of the most recent browser_screenshot image, x grows right, y grows " +
        "down. Take a screenshot first, find the target in it, then click its centre. The window " +
        "receives it as ordinary pointer input, so hover menus and custom controls behave normally. " +
        "Set button to \"right\" to open a page's own context menu (no native OS menu appears, so a " +
        "web app's custom menu is what you get). Screenshot again afterwards to confirm what changed.",
      // "read" like the other iterate tools: the window itself was approved at browser_open, and the
      // user is watching it live with the close-X kill switch. Re-gating every click would make
      // multi-step reading unusable without adding a decision the user has not already made.
      approval: "read",
      parameters: schema({
        x: { desc: "X coordinate in the last screenshot's pixel space (0 = left edge)", kind: "number" },
        y: { desc: "Y coordinate in the last screenshot's pixel space (0 = top edge)", kind: "number" },
        button: { desc: "\"left\" (default) or \"right\" for a context-menu click", kind: "string" },
      }, ["button"]),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResult> {
        const px = params && typeof params === "object" && "x" in params ? Number(params.x) : NaN;
        const py = params && typeof params === "object" && "y" in params ? Number(params.y) : NaN;
        if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0) {
          return text("browser_click needs numeric x and y (0 or greater) in the last screenshot's pixel space.", true);
        }
        const btnRaw = params && typeof params === "object" && "button" in params ? params.button : "left";
        const button = String(typeof btnRaw === "string" ? btnRaw : "left").toLowerCase() === "right" ? "right" : "left";
        const body = await call("/click", { x: px, y: py, button }, 20_000);
        if (envelopeField(body, "ok") !== true) return text(`browser_click failed: ${failText(body, "no browser window is open - call browser_open first")}`, true);
        return text(`${button === "right" ? "Right-clicked" : "Clicked"} (${Math.round(px)}, ${Math.round(py)}) in the agent browser. Call browser_screenshot to see the result.`);
      },
    });

    registerTool({
      name: "browser_drag",
      label: "Drag in the agent browser",
      description:
        "Press at one point, move, and release at another: use it for range sliders, drag-and-drop " +
        "lists, map panning, canvas handles, and resizers. All four coordinates are in SCREENSHOT " +
        "pixel space (screenshot first). Real pointer motion is sent between the press and the " +
        "release, so drag-and-drop listeners fire. Screenshot afterwards to confirm.",
      approval: "read",
      parameters: schema({
        x: { desc: "Start X in the last screenshot's pixel space", kind: "number" },
        y: { desc: "Start Y in the last screenshot's pixel space", kind: "number" },
        toX: { desc: "End X in the last screenshot's pixel space", kind: "number" },
        toY: { desc: "End Y in the last screenshot's pixel space", kind: "number" },
      }),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResult> {
        const read = (k: string): number => (params && typeof params === "object" && k in params ? Number(Reflect.get(params, k)) : NaN);
        const x = read("x"), y = read("y"), toX = read("toX"), toY = read("toY");
        if (![x, y, toX, toY].every((n) => Number.isFinite(n) && n >= 0)) {
          return text("browser_drag needs numeric x, y, toX and toY (0 or greater) in the last screenshot's pixel space.", true);
        }
        const body = await call("/drag", { x, y, toX, toY }, 25_000);
        if (envelopeField(body, "ok") !== true) return text(`browser_drag failed: ${failText(body, "no browser window is open - call browser_open first")}`, true);
        return text(`Dragged from (${Math.round(x)}, ${Math.round(y)}) to (${Math.round(toX)}, ${Math.round(toY)}) in the agent browser. Call browser_screenshot to see the result.`);
      },
    });

    registerTool({
      name: "browser_keys",
      label: "Press keys in the agent browser",
      description:
        "Press one key or key combo in the agent browser: \"Escape\" to dismiss a dialog, \"Tab\" to " +
        "move focus, \"Control+a\" to select all, \"Shift+Tab\", \"PageDown\", \"F5\". Modifiers are " +
        "Control, Alt, Shift and Meta joined with +, and Meta covers Cmd on macOS so one spelling " +
        "works everywhere. For ordinary text use browser_type instead. Screenshot afterwards.",
      approval: "read",
      parameters: schema({
        keys: { desc: "The key or combo to press, for example \"Escape\", \"Tab\", \"Control+a\", \"Shift+PageDown\"", kind: "string" },
      }),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResult> {
        const raw = params && typeof params === "object" && "keys" in params ? params.keys : "";
        const keys = String(typeof raw === "string" ? raw : "").trim();
        if (!keys) return text("browser_keys needs a `keys` value, for example \"Escape\" or \"Control+a\".", true);
        const body = await call("/keys", { keys }, 20_000);
        if (envelopeField(body, "ok") !== true) return text(`browser_keys failed: ${failText(body, "no browser window is open - call browser_open first")}`, true);
        return text(`Pressed ${keys} in the agent browser. Call browser_screenshot to see the result.`);
      },
    });

    registerTool({
      name: "browser_type",
      label: "Type in the agent browser",
      description:
        "Type text into whatever the agent browser window currently has focused: click a field with " +
        "browser_click first. Newlines in `text` are entered as Enter. Set pressEnter true to submit " +
        "afterwards (a search box, a login form). Screenshot afterwards to confirm. Never type " +
        "credentials: ask the user to enter those in the window themselves, since they can see it.",
      approval: "read",
      parameters: schema({
        text: { desc: "The text to type into the focused element (1 to 2000 characters)", kind: "string" },
        pressEnter: { desc: "Press Enter after typing (submits most forms); default false", kind: "boolean" },
      }, ["pressEnter"]),
      async execute(_toolCallId: string, params: unknown): Promise<ToolResult> {
        const raw = params && typeof params === "object" && "text" in params ? params.text : "";
        const value = String(typeof raw === "string" ? raw : "");
        if (!value) return text("browser_type needs a non-empty `text` value.", true);
        if (value.length > 2000) return text(`browser_type: ${value.length} characters is over the 2000-character limit - send it in smaller pieces.`, true);
        const enterRaw = params && typeof params === "object" && "pressEnter" in params ? params.pressEnter : false;
        const pressEnter = enterRaw === true || enterRaw === "true";
        const body = await call("/type", { text: value, pressEnter }, 20_000);
        if (envelopeField(body, "ok") !== true) return text(`browser_type failed: ${failText(body, "no browser window is open - call browser_open first")}`, true);
        return text(`Typed ${value.length} character${value.length === 1 ? "" : "s"} into the agent browser${pressEnter ? " and pressed Enter" : ""}. Call browser_screenshot to see the result.`);
      },
    });

    registerTool({
      name: "browser_run",
      label: "Run a goal in the agent browser",
      description:
        "Drive the ALREADY OPEN agent browser window toward a natural-language goal, one bounded step at " +
        "a time, with Jev choosing every click, dropdown selection and typed value from what is visible on " +
        "the page. Call browser_open first; browser_run never navigates by itself. If the goal needs text " +
        "typed (a search box, a form field), pass `values` as a JSON object of named strings, for example " +
        "{\"origin\":\"Zurich\",\"destination\":\"London\"}: Jev only picks WHICH named value goes in a " +
        "field and never writes text of its own, so a run that reaches a field with no matching value stops " +
        "with needs_values naming the field. The run also stops at done, blocked (no useful control), " +
        "stalled (actions changed nothing) or the `maxSteps` bound, and reports every action it took. A " +
        "done status is Jev's opinion, not proof: call browser_screenshot afterwards to verify. Never " +
        "put credentials in `values`; ask the user to sign in inside the window they can see.",
      // "read" like the other iterate tools: the window itself was approved at browser_open (this tool
      // takes no url and cannot navigate), the user is watching it live, and closing it aborts the run.
      approval: "read",
      parameters: schema({
        goal: { desc: "What to accomplish on the open page, in plain language (the whole task, not one click)", kind: "string" },
        values: { desc: "JSON object of named strings the run may type, for example {\"origin\":\"Zurich\"}; required when the goal needs typing", kind: "string" },
        maxSteps: { desc: `Most actions to execute before stopping; default ${DEFAULT_STEPS}, at most ${MAX_STEPS}`, kind: "number" },
      }, ["values", "maxSteps"]),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: unknown): Promise<ToolResult> {
        const rawGoal = params && typeof params === "object" && "goal" in params ? params.goal : "";
        const goal = String(typeof rawGoal === "string" ? rawGoal : "").trim();
        if (!goal) return text("browser_run needs a non-empty `goal` describing what to accomplish on the open page.", true);
        const values = parseRunValues(params && typeof params === "object" && "values" in params ? params.values : undefined);
        if (typeof values === "string") return text(values, true);
        const maxSteps = clampSteps(params && typeof params === "object" && "maxSteps" in params ? params.maxSteps : undefined);
        let judge: JudgeLike;
        try {
          judge = await (deps.judge ?? resolveDefaultJudge)(ctx);
          if (!judge || typeof judge.judge !== "function") throw new Error("no judge");
        } catch {
          return text("browser_run: judgment backend unavailable; no action executed.", true);
        }
        // Both timeouts outlast the server holds (snapshot 10s, act 15s) so a slow page reports the
        // server's real verdict, never a spurious client-side abort.
        const io: BrowserRunIo = {
          snapshot: () => call("/snapshot", {}, 20_000),
          act: (body) => call("/act", { ...body }, 25_000),
        };
        return runBrowserGoal(io, judge, goal, values, maxSteps, signal);
      },
    });

    registerTool({
      name: "browser_close",
      label: "Close the agent browser",
      description:
        "Close the agent-controlled browser window when you are done reading. The user can also close " +
        "it themselves at any time (that cancels any in-flight browser commands).",
      approval: "read",
      parameters: schema({}),
      async execute(): Promise<ToolResult> {
        const body = await call("/close", {}, 20_000);
        if (envelopeField(body, "ok") !== true) return text(`browser_close failed: ${failText(body, "the desktop did not respond")}`, true);
        return text("Closed the agent browser window.");
      },
    });
  } catch (e) {
    // Never break omp launch: skip the tools if registration throws. Naming the schema mode makes a
    // field report actionable ("literal" means the typebox shim was absent/malformed on that build).
    try { process.stderr.write(`\n[LucidAgentIDE] browser tools not registered (schema mode: ${schemaMode}): ${e instanceof Error ? e.message : String(e)}\n`); } catch { /* ignore */ }
  }
}
