// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-UX-JEV.1: the app window's navigation boundary. The reported bug was severe and easy to
// reproduce by hand: clicking an external link inside a Preview guide whited out the window and
// restarted the whole front end, losing an unsent prompt. Two independent faults produced it, so
// both are pinned here by BEHAVIOR (driving the real handlers through a fake WebContents), never
// by matching source text.

import { describe, expect, test } from "bun:test";
import { externalHttpUrl, installAppNavigation, openExternalHttp } from "./navigation_policy.ts";

const APP = "http://localhost:5319/";

interface FakeEvent { defaultPrevented: boolean; preventDefault(): void; isMainFrame?: boolean; initiator?: unknown }
function fakeEvent(extra: Partial<FakeEvent> = {}): FakeEvent {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
}

type Handler = (...args: never[]) => void;
type OpenHandler = (details: { url: string }) => unknown;

/** Minimal stand-in for the app window's WebContents: records handlers, opens and loads. */
function fakeContents() {
  const handlers = new Map<string, Handler[]>();
  const opened: string[] = [];
  const loaded: string[] = [];
  const pending: (() => void)[] = [];
  const mainFrame = { id: "main" };
  let openHandler: OpenHandler = () => ({ action: "deny" });
  const contents = {
    mainFrame,
    isDestroyed: () => false,
    loadURL: async (url: string) => { loaded.push(url); },
    setWindowOpenHandler(handler: OpenHandler) { openHandler = handler; },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return contents;
    },
  };
  // The production signature is Electron's WebContents; this fake implements only the members
  // installAppNavigation actually uses, which is the whole point of the seam.
  const asContents = contents as unknown as Parameters<typeof installAppNavigation>[0];
  const emit = (event: string, ...args: unknown[]) => {
    for (const h of handlers.get(event) ?? []) (h as (...a: unknown[]) => void)(...args);
  };
  installAppNavigation(asContents, APP, async (url) => { opened.push(url); }, (cb) => { pending.push(cb); });
  return { mainFrame, emit, opened, loaded, pending, open: (url: string) => openHandler({ url }) };
}

describe("externalHttpUrl", () => {
  test("accepts ordinary http(s) destinations and canonicalizes them", () => {
    expect(externalHttpUrl("https://aistudio.google.com/apikey")).toBe("https://aistudio.google.com/apikey");
    expect(externalHttpUrl("http://example.com")).toBe("http://example.com/");
  });
  test("refuses every non-web scheme, so a link can never reach a protocol handler", () => {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "lucid://auth?t=1", "data:text/html,<b>x", "mailto:a@b.co"]) {
      expect(externalHttpUrl(bad)).toBeNull();
    }
  });
  test("refuses embedded credentials, control characters, backslashes and non-strings", () => {
    expect(externalHttpUrl("https://user:pw@example.com/")).toBeNull();
    expect(externalHttpUrl("https://example.com/\u0000")).toBeNull();
    expect(externalHttpUrl("https:\\\\example.com")).toBeNull();
    expect(externalHttpUrl("   ")).toBeNull();
    expect(externalHttpUrl(undefined)).toBeNull();
    expect(externalHttpUrl({ href: "https://example.com" })).toBeNull();
  });
});

describe("openExternalHttp", () => {
  test("hands a validated URL to the OS opener and reports success", async () => {
    const seen: string[] = [];
    expect(await openExternalHttp("https://example.com/docs", async (u) => { seen.push(u); })).toBe(true);
    expect(seen).toEqual(["https://example.com/docs"]);
  });
  test("a rejected URL never reaches the opener", async () => {
    let called = false;
    expect(await openExternalHttp("javascript:alert(1)", async () => { called = true; })).toBe(false);
    expect(called).toBe(false);
  });
  test("an OS failure is reported, never thrown at the caller", async () => {
    expect(await openExternalHttp("https://example.com", async () => { throw new Error("no browser"); })).toBe(false);
  });
});

describe("the app window can never be navigated away from", () => {
  test("an external link hands off to the OS browser instead of replacing the app", () => {
    const f = fakeContents();
    const event = fakeEvent({ initiator: f.mainFrame });
    f.emit("will-navigate", event, "https://aistudio.google.com/apikey");
    // Preventing the navigation is what keeps the renderer, and the user's unsent prompt, alive.
    expect(event.defaultPrevented).toBe(true);
    expect(f.opened).toEqual(["https://aistudio.google.com/apikey"]);
    expect(f.loaded).toEqual([]);
  });
  test("a same-origin document navigation is refused and NOT opened externally", () => {
    const f = fakeContents();
    const event = fakeEvent({ initiator: f.mainFrame });
    f.emit("will-navigate", event, `${APP}api/preview/serve?path=x`);
    expect(event.defaultPrevented).toBe(true);
    expect(f.opened).toEqual([]); // the app's own endpoints are not "external websites"
  });
  test("a top-frame redirect is stopped without an automatic OS handoff", () => {
    const f = fakeContents();
    const event = fakeEvent({ isMainFrame: true, initiator: f.mainFrame });
    f.emit("will-redirect", event, "https://evil.example/landing");
    expect(event.defaultPrevented).toBe(true);
    expect(f.opened).toEqual([]);
  });
  test("window.open is denied, and only a real web URL reaches the OS", () => {
    const f = fakeContents();
    expect(f.open("https://docs.typesafe.ai/models.md")).toEqual({ action: "deny" });
    f.open("file:///c:/secrets.txt");
    expect(f.opened).toEqual(["https://docs.typesafe.ai/models.md"]);
  });
  test("a sandboxed preview frame cannot navigate itself; the host's own src assignment still works", () => {
    const f = fakeContents();
    const fromFrame = fakeEvent({ isMainFrame: false, initiator: { id: "preview" } });
    f.emit("will-frame-navigate", fromFrame);
    expect(fromFrame.defaultPrevented).toBe(true);
    const fromHost = fakeEvent({ isMainFrame: false, initiator: f.mainFrame });
    f.emit("will-frame-navigate", fromHost);
    expect(fromHost.defaultPrevented).toBe(false);
  });
});

describe("startup retry never restarts a running app", () => {
  test("a failed preview subframe does NOT reload the window (the reported whiteout)", () => {
    const f = fakeContents();
    f.emit("did-finish-load");
    f.emit("did-fail-load", {}, -22, "ERR_BLOCKED_BY_RESPONSE", "https://aistudio.google.com/apikey", false);
    for (const cb of f.pending) cb();
    expect(f.loaded).toEqual([]);
  });
  test("a subframe failure during cold start is not mistaken for the app failing to boot", () => {
    const f = fakeContents(); // nothing has finished loading yet: only isMainFrame separates these
    f.emit("did-fail-load", {}, -22, "ERR_BLOCKED_BY_RESPONSE", APP, false);
    for (const cb of f.pending) cb();
    expect(f.loaded).toEqual([]);
  });
  test("a main-frame failure AFTER the app has loaded does not reload it either", () => {
    const f = fakeContents();
    f.emit("dom-ready");
    f.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", APP, true);
    for (const cb of f.pending) cb();
    expect(f.loaded).toEqual([]);
  });
  test("a genuine cold-start failure still retries the app URL", () => {
    const f = fakeContents();
    f.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", APP, true);
    expect(f.loaded).toEqual([]); // scheduled, not immediate
    for (const cb of f.pending) cb();
    expect(f.loaded).toEqual([APP]);
  });
  test("an aborted navigation is not a startup failure", () => {
    const f = fakeContents();
    f.emit("did-fail-load", {}, -3, "ERR_ABORTED", APP, true);
    for (const cb of f.pending) cb();
    expect(f.loaded).toEqual([]);
  });
  test("the retry is abandoned once the app comes up between the failure and the retry", () => {
    const f = fakeContents();
    f.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", APP, true);
    f.emit("did-finish-load");
    for (const cb of f.pending) cb();
    expect(f.loaded).toEqual([]);
  });
});
