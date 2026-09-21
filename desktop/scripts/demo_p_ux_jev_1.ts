// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-UX-JEV.1 - the link that restarted the front end, one LUCID sprite, one arcade control
// row, and the Jev guide. Proves, against the REAL modules and the BUILT renderer bundle, that:
//   (1) a link can no longer navigate the app window, and a failed PREVIEW load no longer reloads it
//       (the reported whiteout: an unsent prompt was destroyed by the startup retry);
//   (2) the injected preview shim asks the host to open an external link instead of navigating,
//       while in-document fragments still work and non-web schemes are refused;
//   (3) the Jev guide is registered, self-contained, and answers the questions its card links it for;
//   (4) the mascot is ONE sprite with ONE arcade control row, and the retired second sprite and the
//       duplicated mini-game toolbar are gone from the bytes the app actually serves.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { externalHttpUrl, installAppNavigation } from "../navigation_policy.ts";
import { PREVIEW_SHIM_JS } from "../preview_bridge.ts";
import { GUIDE_FILES } from "../guides_manifest.ts";
import { probePreviewFile } from "../preview_file.ts";

const DESKTOP = join(import.meta.dir, "..");
const APP = "http://localhost:5319/";
let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-UX-JEV.1 - safe links, one ninja, one control row, the Jev guide ==");

// (1) the navigation boundary, driven through the real handlers.
type Handler = (...args: never[]) => void;
const handlers = new Map<string, Handler[]>();
const opened: string[] = [];
const loaded: string[] = [];
const pending: (() => void)[] = [];
const mainFrame = { id: "main" };
const fake = {
  mainFrame,
  isDestroyed: () => false,
  loadURL: async (url: string) => { loaded.push(url); },
  setWindowOpenHandler() { /* not exercised here */ },
  on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return fake; },
};
const emit = (event: string, ...args: unknown[]) => {
  for (const h of handlers.get(event) ?? []) (h as (...a: unknown[]) => void)(...args);
};
installAppNavigation(
  fake as unknown as Parameters<typeof installAppNavigation>[0],
  APP,
  async (url) => { opened.push(url); },
  (cb) => { pending.push(cb); },
);

const nav = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, initiator: mainFrame };
emit("will-navigate", nav, "https://aistudio.google.com/apikey");
check("an external link cannot replace the app window", nav.defaultPrevented);
check("it is handed to the OS browser instead", opened.includes("https://aistudio.google.com/apikey"));

emit("did-finish-load");
emit("did-fail-load", {}, -22, "ERR_BLOCKED_BY_RESPONSE", "https://aistudio.google.com/apikey", false);
for (const cb of pending.splice(0)) cb();
check("a failed PREVIEW load no longer reloads the app (the composer survives)", loaded.length === 0);

check("non-web schemes are refused by the shared opener policy",
  ["file:///etc/passwd", "javascript:alert(1)", "lucid://auth"].every((u) => externalHttpUrl(u) === null));

// (2) the shim the engine injects into every previewed document.
check("the preview shim asks the HOST to open a link (a request, never its own egress)",
  PREVIEW_SHIM_JS.includes("preview-external-link") && PREVIEW_SHIM_JS.includes("window.parent.postMessage"));
check("the shim keeps same-document fragment links working", PREVIEW_SHIM_JS.includes("raw.indexOf('#')"));
check("the shim refuses anything that is not http(s) with a host",
  PREVIEW_SHIM_JS.includes("url.protocol!=='http:'") && PREVIEW_SHIM_JS.includes("!url.hostname"));
check("the sandbox is NOT widened to compensate (no popups / top-navigation grant)",
  !PREVIEW_SHIM_JS.includes("allow-popups") && !PREVIEW_SHIM_JS.includes("allow-top-navigation"));

// (3) the Jev guide.
const guideFile = GUIDE_FILES["typesafe"];
check("the Judgment card has a guide registered", guideFile === "typesafe_plans.html");
const guidePath = join(DESKTOP, "renderer", "guides", guideFile ?? "");
const guide = readFileSync(guidePath, "utf8");
const probe = probePreviewFile(guidePath);
check("the guide opens in the Preview panel", probe.ok && probe.kind === "html");
check("it is self-contained (the preview frame has no network)",
  !/<script[^>]*\bsrc=/i.test(guide) && !/<link[^>]*rel=["']?stylesheet/i.test(guide) && !/<img[^>]*\bsrc=["']?https?:/i.test(guide));
check("no em dash (house writing rule)", !guide.includes("\u2014"));
for (const [topic, needle] of [
  ["what Jev is for", "not another chatbot"],
  ["what LUCID actually sends", "judge(state, questions)"],
  ["the auto / typesafe / llm settings", "TYPESAFE_API_KEY"],
  ["that a failure can fall back to online chat models", "online chat judgment chain"],
  ["training", "without the customer's prior consent"],
  ["retention", "no backup deletion deadline"],
  ["enterprise zero data retention", "zero data retention (ZDR)"],
  ["hosting is not a US-only promise", "US hosting is not a US-only guarantee"],
  ["the published subprocessors", "CoreWeave"],
  ["that judgments are never the sole security decision", "Never the sole security decision"],
] as const) {
  check(`the guide answers: ${topic}`, guide.includes(needle));
}

// (4) the bytes the app serves, not the source it was built from (ADR-0303).
const bundle = readFileSync(join(DESKTOP, "renderer", "app.bundle.js"), "utf8");
const css = readFileSync(join(DESKTOP, "renderer", "styles.css"), "utf8");
for (const marker of ["preview-external-link", "composerMascotInputs", "setSuspended", "Jev explained"]) {
  check(`served renderer carries ${marker}`, bundle.includes(marker));
}
check("the second, static background ninja is GONE from the served bundle", !bundle.includes("mountMascotStage"));
check("its dimming rule is gone from the stylesheet too", !css.includes("stage-dim"));
check("mini games no longer build a second toolbar (the stacked Exit over Start)",
  !bundle.includes("mini-game-toolbar") && !css.includes("mini-game-toolbar"));
check("Start and Exit are one inseparable pair in the single control row",
  bundle.includes("agent-arcade-actions") && css.includes("agent-arcade-actions"));
check("the arcade row wraps by its own width, not the window's",
  /\.agent-arcade-toolbar\s*\{[^}]*flex-wrap:wrap/.test(css));
check("the ninja is reachable by pointer and keyboard above the prompt",
  bundle.includes("composer-mascot-hit") && bundle.includes("Greet LUCID ninja"));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
