// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
//
// P-PREVIEW-STICKY-PDF: real-browser preview lifecycle regression.
// Call verifyPreviewSession(page, root) on a dedicated, isolated QA page connected
// to an already-running isolated dev engine, never on an active user engine/page.
// This changes that page's preview lanes. It does not reset chats, delete documents,
// install globals, create fixtures, or launch/connect to an engine. root must be an
// absolute project path with forward slashes. The caller owns page and its lifetime.

export async function verifyPreviewSession(page, root) {
  if (typeof root !== "string" || !/^(?:[A-Za-z]:\/|\/)/.test(root) || root.includes("\\")) {
    throw new Error("root must be an absolute project path with forward slashes");
  }
  const base = root.replace(/\/$/, "");
  const first = `${base}/desktop/renderer/trainer.html`;
  const second = `${base}/desktop/renderer/index.html`;
  const missing = "/tmp/lucid-preview-qa-missing.pdf";
  const checks = [];
  const client = await page.createCDPSession();
  const scripts = [];
  const held = [];
  const cleanupErrors = [];
  let objectId;
  let breakpointId;
  let paused = false;
  let fetchEnabled = false;
  let debuggerEnabled = false;
  let failure;
  let clickPromise;
  let autoRelease = false;
  const pendingReleases = new Set();

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  async function poll(label, read, accept = Boolean) {
    const deadline = Date.now() + 5000;
    let value;
    do {
      value = await read();
      if (accept(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(`Timed out after 5 seconds: ${label}; last value: ${JSON.stringify(value)}`);
  }
  function checkException(result, label) {
    if (result.exceptionDetails) {
      throw new Error(`${label}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result;
  }
  async function call(functionDeclaration, args = []) {
    const result = await client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    return checkException(result, "Preview function call").value;
  }
  async function snapshot() {
    return call(`function() {
      const agent = document.querySelector('#prevFrameA');
      const yours = document.querySelector('#prevFrame');
      const panel = document.querySelector('#preview');
      return { ...this.current(), hidden: panel.hidden,
        agentSrc: agent.getAttribute('src'), agentSrcdoc: agent.getAttribute('srcdoc'),
        agentHidden: agent.hidden, yoursSrc: yours.getAttribute('src') };
    }`);
  }
  function servedPath(src) {
    if (!src) return null;
    const url = new URL(src, page.url());
    return url.pathname === "/api/preview/serve" ? url.searchParams.get("path") : null;
  }
  async function loaded(path) {
    await poll(`real preview document loads: ${path}`, async () => {
      const frame = page.frames().find((candidate) => servedPath(candidate.url()) === path);
      if (!frame) return false;
      try {
        return await frame.evaluate(() => document.readyState !== "loading");
      } catch {
        // A navigation can replace the execution context between finding and reading it.
        return false;
      }
    });
  }
  async function repeatedEventsStayClosed(paths, expected, label) {
    const startAt = held.length;
    for (let repeat = 0; repeat < 3; repeat++) {
      await call("function(paths) { for (const path of paths) { this.available(path); this.activity('QA dismissed target'); } }", [paths]);
    }
    const started = Date.now();
    await poll(label, async () => {
      const state = await snapshot();
      assert(!state.open && state.hidden && state.last === expected.last && state.agent === expected.agent && state.agentSrc === expected.agentSrc && state.agentSrcdoc === expected.agentSrcdoc, `${label}: dismissed event or activity changed the closed agent lane`);
      assert(held.length === startAt, `${label}: dismissed target started another probe`);
      return Date.now() - started >= 250;
    });
  }
  async function probe(path, startAt) {
    return poll(`held response for ${path}`, async () => held.slice(startAt).find((entry) =>
      !entry.released && new URL(entry.event.request.url).searchParams.get("path") === path));
  }
  async function release(entry, resolves) {
    // Register before continuing so even a cached/very fast response is observed.
    const responsePromise = page.waitForResponse((response) => response.url() === entry.event.request.url, { timeout: 5000 });
    responsePromise.catch(() => {});
    await client.send("Fetch.continueRequest", { requestId: entry.event.requestId });
    entry.released = true;
    const response = await responsePromise;
    assert(response.ok(), `Probe returned HTTP ${response.status()}`);
    const body = await response.json();
    assert(body.data?.resolves === resolves, `Unexpected real probe verdict: ${JSON.stringify(body)}; expected resolves=${resolves}`);
    // Drain browser tasks after the real response body is consumed, rather than
    // guessing how long the renderer's fetch/json promise chain will take.
    await page.evaluate(() => new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    }));
  }
  const onScript = (event) => {
    if (event.url && new URL(event.url, page.url()).pathname === "/app.js") scripts.push(event);
  };
  const onPaused = () => { paused = true; };
  const onResumed = () => { paused = false; };
  const onRequest = (event) => {
    const entry = { event, released: false };
    held.push(entry);
    if (autoRelease) {
      const pending = client.send("Fetch.continueRequest", { requestId: event.requestId })
        .then(() => { entry.released = true; })
        .catch((error) => { cleanupErrors.push(error); })
        .finally(() => pendingReleases.delete(pending));
      pendingReleases.add(pending);
    }
  };
  client.on("Debugger.scriptParsed", onScript);
  client.on("Debugger.paused", onPaused);
  client.on("Debugger.resumed", onResumed);
  client.on("Fetch.requestPaused", onRequest);

  try {
    const assets = await page.evaluate(async () => {
      const [app, styles] = await Promise.all([
        fetch("/app.js", { cache: "no-store" }),
        fetch("/styles.css", { cache: "no-store" }),
      ]);
      return { appStatus: app.status, stylesStatus: styles.status, source: await app.text() };
    });
    assert(assets.appStatus === 200, `/app.js returned ${assets.appStatus}`);
    const source = assets.source.replace(/^\s*\/\/[@#]\s*sourceMappingURL=.*$/gm, "");
    assert(source.includes("revision === agentPreviewRevision && owner === turnViewEpoch"), "Served app lacks revision and turn-owner guard");
    assert(!source.includes("if (resolves) state.lastPreviewablePath = path"), "Served app contains unguarded sticky-path assignment");
    checks.push("served-app-has-revision-and-owner-guard");
    assert(source.includes("dismissedAgentPreviews"), "Served app lacks session preview dismissal tracking");
    assert(!source.includes("if (panel.hidden && state.lastPreviewablePath) openPreview()"), "Served app lets activity reopen a hidden preview");
    checks.push("served-app-tracks-dismissals-without-activity-reopen");
    assert(assets.stylesStatus === 200, `/styles.css returned ${assets.stylesStatus}`);
    checks.push("served-styles-http-200");

    await page.evaluate(() => {
      const rail = document.querySelector('.rail-btn[data-rail="preview"]');
      const panel = document.querySelector("#preview");
      if (!rail || !panel) throw new Error("Preview rail/panel missing on isolated QA page");
      if (!panel.hidden) rail.click();
    });
    await client.send("Debugger.enable");
    debuggerEnabled = true;
    const script = await poll("parsed /app.js", async () => scripts.find((entry) => entry.url === new URL("/app.js", page.url()).href));
    const { scriptSource } = await client.send("Debugger.getScriptSource", { scriptId: script.scriptId });
    const lines = scriptSource.split("\n");
    const openLine = lines.findIndex((line) => /\bfunction openPreview\(opts\)/.test(line));
    assert(openLine !== -1, "Cannot locate function openPreview(opts) in served script");
    ({ breakpointId } = await client.send("Debugger.setBreakpoint", {
      location: { scriptId: script.scriptId, lineNumber: openLine + 1 },
    }));
    let pauseEvent;
    const capturePause = (event) => { pauseEvent = event; };
    client.on("Debugger.paused", capturePause);
    try {
      clickPromise = page.evaluate(() => document.querySelector('.rail-btn[data-rail="preview"]').click());
      clickPromise.catch(() => {});
      await poll("openPreview breakpoint", async () => pauseEvent);
      assert(pauseEvent.hitBreakpoints?.includes(breakpointId), "Paused outside the requested preview breakpoint");
      const captured = checkException(await client.send("Debugger.evaluateOnCallFrame", {
        callFrameId: pauseEvent.callFrames[0].callFrameId,
        expression: "({available:onPreviewAvailable,reset:resetAgentPreviewLane,close:closePreview,open:openPreview,yours:openPreviewFile,activity:flashPreviewTesting,current:()=>({last:state.lastPreviewablePath,pending:pendingAgentPreviewPath,agent:prevPathByLane.agent,yours:prevPathByLane.yours,open:previewOpen,lane:prevLane})})",
        returnByValue: false,
      }), "Capturing real preview closures");
      objectId = captured.objectId;
      assert(objectId, "Debugger did not return a preview closure object");
      await client.send("Debugger.resume");
      await client.send("Debugger.removeBreakpoint", { breakpointId });
      breakpointId = undefined;
      await clickPromise;
    } finally {
      client.off("Debugger.paused", capturePause);
    }
    await client.send("Fetch.enable", {
      patterns: [{ urlPattern: "*/api/preview/probe?*", requestStage: "Response" }],
    });
    fetchEnabled = true;

    await call("function() { this.reset(); this.close(); }");
    let state = await snapshot();
    assert(!state.open && state.hidden && !state.last && !state.agent, "Initial isolated agent lane is not empty and closed");
    let startAt = held.length;
    await call("function(path) { this.available(path); }", [first]);
    const initialProbe = await probe(first, startAt);
    state = await snapshot();
    assert(!initialProbe.released && !state.open && state.hidden && !state.last && !state.agent && state.agentSrc === null && state.agentSrcdoc === null && state.agentHidden, "Initial target must remain empty and hidden until its successful probe is released");
    checks.push("hidden-panel-first-target-waits-for-successful-probe");
    await release(initialProbe, true);
    await poll("first verified target opens", snapshot, (value) => value.open && !value.hidden && value.last === first);
    await loaded(first);
    state = await snapshot();
    assert(state.lane === "agent" && state.agent === first && servedPath(state.agentSrc) === first, "First verified target did not load in the agent lane");
    checks.push("first-target-loads-only-after-successful-probe");

    await call("function() { this.close(); }");
    const dismissedFirst = await snapshot();
    assert(!dismissedFirst.open && dismissedFirst.hidden && dismissedFirst.agent === first, "Closing the visible target did not retain its closed lane");
    await repeatedEventsStayClosed([first], dismissedFirst, "closed visible target ignores repeated events and activity");
    checks.push("close-visible-target-rejects-repeated-events-and-activity");

    await call("function() { this.open({ reveal: 'agent' }); }");
    state = await snapshot();
    assert(state.open && !state.hidden && state.last === first && state.agent === first && state.agentSrc === dismissedFirst.agentSrc, "Successful current target was lost through close/open");
    checks.push("successful-current-target-survives-close-open");

    await call("function(path) { this.yours(path); }", [first]);
    await loaded(first);
    const yoursBefore = await snapshot();
    assert(yoursBefore.lane === "yours" && yoursBefore.yours === first && servedPath(yoursBefore.yoursSrc) === first, "Explicit Yours Open did not load the chosen document");
    startAt = held.length;
    await call("function(path) { this.available(path); }", [first]);
    const optedInProbe = await probe(first, startAt);
    await release(optedInProbe, true);
    await poll("explicit Yours Open opts dismissed target back in", snapshot, (value) => value.last === first && value.agent === first);
    checks.push("explicit-yours-open-opts-dismissed-target-back-in");

    // Reset before setup closes so these later races use undismissed targets.
    await call("function() { this.reset(); this.close(); }");
    startAt = held.length;
    await call("function(path) { this.available(path); }", [first]);
    const resetProbe = await probe(first, startAt);

    await call("function() { this.reset(); this.close(); }");
    await release(resetProbe, true);
    await call("function() { this.activity('QA stale probe'); }");
    state = await snapshot();
    assert(!state.open && state.hidden && !state.last && !state.agent && state.agentSrc === null && state.agentSrcdoc === null && state.agentHidden, "Reset must invalidate held success, unload agent iframe, and prevent activity reopening");
    checks.push("reset-invalidates-held-success-and-activity-stays-closed");

    startAt = held.length;
    await call("function(path) { this.available(path); }", [missing]);
    const invalidProbe = await probe(missing, startAt);
    state = await snapshot();
    assert(!state.open && state.hidden && !state.last && !state.agent && state.agentSrc === null && state.agentSrcdoc === null && state.agentHidden, "Unverified PDF loaded or reopened the closed panel while its probe was held");
    await release(invalidProbe, false);
    await call("function() { this.activity('QA failed PDF'); }");
    state = await snapshot();
    assert(!state.open && state.hidden && !state.last && !state.agent && state.agentSrc === null && state.agentSrcdoc === null && state.agentHidden, "Invalid PDF loaded or reopened the panel after its failed probe");
    checks.push("invalid-pdf-never-loads-or-reopens-closed-panel");

    await call("function() { this.reset(); this.close(); }");
    const remoteBefore = await snapshot();
    await call("function(path) { this.available(path); }", ["http://127.0.0.1:5329/"]);
    await poll("plaintext remote egress decision completes without opening preview", async () => {
      const value = await snapshot();
      assert(!value.open && value.hidden && !value.last && !value.agent && value.agentSrc === remoteBefore.agentSrc && value.agentSrcdoc === remoteBefore.agentSrcdoc && value.yoursSrc === remoteBefore.yoursSrc, "Plaintext remote target opened Preview or changed a loaded document");
      return !value.pending;
    });
    checks.push("plaintext-remote-egress-never-opens-or-loads-preview");

    startAt = held.length;
    await call("function(path) { this.available(path); }", [first]);
    const probeA = await probe(first, startAt);
    startAt = held.length;
    await call("function(path) { this.available(path); }", [second]);
    const probeB = await probe(second, startAt);
    await release(probeB, true);
    await poll("newer B target remembered", snapshot, (value) => value.last === second);
    await release(probeA, true);
    await loaded(second);
    state = await snapshot();
    assert(state.last === second && state.agent === second && servedPath(state.agentSrc) === second, "Late A success overwrote newer B target");
    checks.push("out-of-order-probes-keep-newer-target");

    // Both paths are undismissed here: Yours Open opted first back in, and
    // setup always reset before closing. Closing must now dismiss both targets.
    startAt = held.length;
    await call("function(path) { this.available(path); }", [first]);
    const pendingProbe = await probe(first, startAt);
    state = await snapshot();
    assert(state.open && !state.hidden && state.agent === second && servedPath(state.agentSrc) === second && !state.last, "Pending target replaced the visible verified document before its probe resolved");
    await call("function() { this.close(); }");
    const dismissedBoth = await snapshot();
    assert(!dismissedBoth.open && dismissedBoth.hidden && dismissedBoth.agent === second && !dismissedBoth.last, "Closing with a pending target did not preserve the closed visible document");
    await release(pendingProbe, true);
    state = await snapshot();
    assert(!state.open && state.hidden && !state.last && state.agent === second && state.agentSrc === dismissedBoth.agentSrc, "Held success reopened or replaced the document after close");
    await repeatedEventsStayClosed([second, first], dismissedBoth, "close dismisses visible and pending targets");
    checks.push("close-pending-probe-dismisses-visible-and-pending-targets");

    await call("function() { this.reset(); }");
    state = await snapshot();
    assert(state.yours === first && state.yoursSrc === yoursBefore.yoursSrc && !state.agent && !state.last && state.agentSrc === null && state.agentSrcdoc === null && state.agentHidden, "Agent reset changed Yours or retained an agent document");
    checks.push("yours-document-survives-agent-reset");
    await repeatedEventsStayClosed([second, first], state, "reset preserves session dismissals");
    checks.push("agent-reset-preserves-both-session-dismissals");
  } catch (error) {
    failure = error;
  } finally {
    const clean = async (action) => {
      try { await action(); } catch (error) { cleanupErrors.push(error); }
    };
    if (paused) await clean(() => client.send("Debugger.resume"));
    if (breakpointId) await clean(() => client.send("Debugger.removeBreakpoint", { breakpointId }));
    if (clickPromise) await clean(() => clickPromise);
    if (objectId) await clean(() => call("function() { this.close(); }"));
    autoRelease = true;
    for (const entry of held.slice()) {
      if (!entry.released) await clean(async () => {
        await client.send("Fetch.continueRequest", { requestId: entry.event.requestId });
        entry.released = true;
      });
    }
    if (fetchEnabled) await clean(() => client.send("Fetch.disable"));
    await Promise.all(pendingReleases);
    if (objectId) await clean(() => client.send("Runtime.releaseObject", { objectId }));
    if (debuggerEnabled) await clean(() => client.send("Debugger.disable"));
    client.off("Debugger.scriptParsed", onScript);
    client.off("Debugger.paused", onPaused);
    client.off("Debugger.resumed", onResumed);
    client.off("Fetch.requestPaused", onRequest);
    await clean(() => client.detach());
  }
  if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], "Preview regression and cleanup failed");
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Preview regression cleanup failed");
  return checks;
}
