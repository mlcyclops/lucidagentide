// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Real-browser P-PREVIEW-YOURS-PAN regression. The caller owns a real Puppeteer
// page on an already-running isolated QA engine, never an active user session.
// fixturePath is an existing absolute local HTML path with #message input,
// #check button and #result output that changes when the button counts a click.
// No model, fixtures, host writes, engine launch, CDP hooks or application globals.

export async function verifyPreviewPan(page, fixturePath) {
  if (typeof fixturePath !== "string" || !/^(?:[A-Za-z]:[\\/]|\/)/.test(fixturePath)) {
    throw new Error("fixturePath must be an existing absolute local HTML path");
  }
  const path = fixturePath.replace(/\\/g, "/");
  const checks = [];
  const cleanupErrors = [];
  let failure;
  let mouseDown = false;
  let frame;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  async function poll(label, read, accept = Boolean) {
    const deadline = Date.now() + 5000;
    let value;
    do {
      value = await read();
      if (accept(value)) return value;
      await pause();
    } while (Date.now() < deadline);
    throw new Error(`Timed out after 5 seconds: ${label}; last value: ${JSON.stringify(value)}`);
  }
  async function snapshot() {
    return page.evaluate(() => {
      const viewport = document.querySelector("#prevViewport");
      const surface = document.querySelector("#prevPanSurface");
      const button = document.querySelector("#prevPan");
      const box = surface.getBoundingClientRect();
      return {
        x: viewport.scrollLeft, y: viewport.scrollTop,
        maxX: viewport.scrollWidth - viewport.clientWidth,
        maxY: viewport.scrollHeight - viewport.clientHeight,
        scale: viewport.getBoundingClientRect().width / viewport.offsetWidth,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        hidden: surface.hidden, pressed: button.getAttribute("aria-pressed"),
        buttonHidden: button.hidden, buttonDisabled: button.disabled,
        dragging: surface.classList.contains("dragging"),
        cursor: getComputedStyle(surface).cursor,
        // Chromium assigns pointer id 1 to the real mouse, including Puppeteer input.
        captured: surface.hasPointerCapture(1),
        focused: document.activeElement === viewport,
        zoom: document.querySelector("#prevZoomReset").textContent,
      };
    });
  }
  async function settledScroll() {
    let previous;
    let stableSince = Date.now();
    return poll("viewport scroll settles", snapshot, (value) => {
      if (!previous || value.x !== previous.x || value.y !== previous.y) stableSince = Date.now();
      previous = value;
      return Date.now() - stableSince >= 150;
    });
  }
  async function setupScroll(x, y) {
    // Native scrolling is setup only. All behavioral assertions use real input.
    await page.$eval("#prevViewport", (viewport, position) => viewport.scrollTo(position.x, position.y), { x, y });
    return settledScroll();
  }
  async function ensureOpen() {
    await page.waitForSelector("#preview", { timeout: 5000 });
    if (await page.$eval("#preview", (panel) => panel.hidden)) {
      await page.click('.rail-btn[data-rail="preview"]');
    }
    await page.waitForSelector("#prevOpen", { visible: true, timeout: 5000 });
  }
  async function enablePan() {
    await page.click("#prevPan");
    return poll("pan surface enabled and viewport focused", snapshot,
      (value) => !value.hidden && value.pressed === "true" && value.focused);
  }
  async function disabledPan(label) {
    return poll(label, snapshot,
      (value) => value.hidden && value.pressed === "false" && !value.dragging && !value.captured);
  }
  function point(value) {
    assert(value.box.width > 200 && value.box.height > 160, "QA preview must have room for a 100 by 80 pixel drag");
    return { x: value.box.x + value.box.width * 0.6, y: value.box.y + value.box.height * 0.6 };
  }
  function displacement(before, after, x, y, label) {
    const dx = (after.x - before.x) * before.scale;
    const dy = (after.y - before.y) * before.scale;
    assert(Math.abs(dx - x) <= 2 && Math.abs(dy - y) <= 2,
      `${label}: expected screen displacement ${x},${y}; got ${dx},${dy} at scale ${before.scale}`);
  }
  const counter = () => frame.$eval("#result", (element) => element.textContent);
  async function normalInteraction(label, modifier) {
    const input = `preview-pan-${label}`;
    await frame.click("#message");
    await page.keyboard.down(modifier);
    try { await page.keyboard.press("A"); } finally { await page.keyboard.up(modifier); }
    await page.keyboard.type(input);
    assert(await frame.$eval("#message", (element) => element.value) === input, `${label}: fixture input did not receive typing`);
    const before = await counter();
    await frame.click("#check");
    await poll(`${label}: embedded click counter changes`, counter, (value) => value !== before);
    checks.push(`${label}-embedded-input-and-click`);
  }

  try {
    const assets = await page.evaluate(async () => {
      const [app, styles] = await Promise.all([fetch("/app.js"), fetch("/styles.css")]);
      return { appStatus: app.status, stylesStatus: styles.status, app: await app.text(), styles: await styles.text() };
    });
    assert(assets.appStatus === 200 && assets.stylesStatus === 200, "Preview application and stylesheet must return HTTP 200");
    assert(assets.app.includes("wirePreviewPan"), "Served /app.js lacks wirePreviewPan");
    assert(assets.app.includes('id="prevPanSurface"'), "Served /app.js lacks pan surface markup");
    assert(assets.styles.includes(".preview-pan-surface.dragging"), "Served stylesheet lacks the dragging cursor rule");
    checks.push("served-pan-handler-markup-and-dragging-css");

    await ensureOpen();
    await page.click('.prev-tab[data-lane="yours"]');
    await page.keyboard.press("Escape");
    const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta" : "Control");
    await page.click("#prevPath");
    await page.keyboard.down(modifier);
    try { await page.keyboard.press("A"); } finally { await page.keyboard.up(modifier); }
    await page.keyboard.type(path);
    await page.click("#prevOpen");
    await page.waitForSelector("#prevFrame", { visible: true, timeout: 5000 });
    await poll("fixture content frame navigation", async () => {
      const element = await page.$("#prevFrame");
      try { frame = await element.contentFrame(); } finally { await element.dispose(); }
      if (!frame) return false;
      const url = new URL(frame.url(), page.url());
      return url.pathname === "/api/preview/serve" && url.searchParams.get("path")?.replace(/\\/g, "/") === path;
    });
    await frame.waitForSelector("#message", { visible: true, timeout: 5000 });
    await frame.waitForSelector("#check", { visible: true, timeout: 5000 });
    await frame.waitForSelector("#result", { timeout: 5000 });
    await page.click("#prevZoomReset");
    await poll("initial 100 percent zoom", snapshot, (value) => value.zoom === "100%");
    await normalInteraction("before-pan", modifier);
    const initialCounter = await counter();

    for (let step = 0; step < 10; step++) await page.click("#prevZoomIn");
    await poll("zoomed preview overflows both axes", snapshot, (value) => value.maxX * value.scale > 100 && value.maxY * value.scale > 80);
    await setupScroll(0, 0);
    let before = await enablePan();
    assert(Number.isFinite(before.scale) && before.scale > 0, "Viewport CSS scale must be positive");
    assert(before.maxX * before.scale > 100 && before.maxY * before.scale > 80, "Zoomed preview must overflow both axes");
    let start = point(before);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    mouseDown = true;
    await poll("grabbing cursor during mouse down", snapshot, (value) => value.dragging && value.cursor === "grabbing");
    await page.mouse.move(start.x - 100, start.y - 80, { steps: 10 });
    const dragged = await snapshot();
    assert(dragged.captured, "Real mouse drag did not acquire pointer capture");
    displacement(before, dragged, 100, 80, "ten-step pan");
    await page.mouse.up();
    mouseDown = false;
    await poll("grab cursor and released capture", snapshot,
      (value) => !value.dragging && !value.captured && value.cursor === "grab");
    checks.push("zoomed-screen-space-pan-respects-app-scale", "grabbing-to-grab-and-pointer-release");
    assert(await counter() === initialCounter, "Dragging clicked the embedded fixture");
    checks.push("pan-does-not-click-embedded-content");

    before = await snapshot();
    start = point(before);
    assert(before.box.y > 12, "QA surface needs visible space above it for an outside capture check");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    mouseDown = true;
    await page.mouse.move(start.x, before.box.y - 10, { steps: 10 });
    await poll("capture persists outside surface bounds", snapshot, (value) => value.captured && value.dragging);
    await page.mouse.up();
    mouseDown = false;
    await poll("outside mouse up releases capture", snapshot, (value) => !value.captured && !value.dragging && value.cursor === "grab");
    checks.push("pointer-capture-survives-outside-drag-and-releases");

    before = await setupScroll(0, 0);
    start = point(before);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    mouseDown = true;
    await page.mouse.move(start.x + 50, start.y + 40, { steps: 5 });
    const clamped = await snapshot();
    assert(clamped.x === 0 && clamped.y === 0, "Dragging past the leading edge must clamp both scroll axes");
    await page.mouse.move(start.x + 30, start.y + 20);
    displacement(clamped, await snapshot(), 20, 20, "immediate reversal after edge clamp");
    await page.mouse.up();
    mouseDown = false;
    checks.push("edge-clamp-reverses-without-dead-zone");
    assert(await counter() === initialCounter, "Outside or edge dragging clicked embedded content");

    await page.keyboard.press("Escape");
    await disabledPan("Escape restores page interaction");
    checks.push("escape-hides-overlay-and-unpresses-button");
    await page.click("#prevZoomReset");
    await poll("reset to 100 percent", snapshot, (value) => value.zoom === "100%");
    await normalInteraction("after-escape-at-100-percent", modifier);

    for (let step = 0; step < 10; step++) await page.click("#prevZoomIn");
    await setupScroll(0, 0);
    before = await enablePan();
    await page.keyboard.press("ArrowDown");
    await poll("ArrowDown scrolls focused viewport", snapshot, (value) => value.y > before.y);
    await settledScroll();
    checks.push("keyboard-arrow-scrolls-focused-viewport");

    if (await page.$eval("#prevWheelZoom", (button) => button.getAttribute("aria-pressed") === "true")) {
      await page.click("#prevWheelZoom");
    }
    before = await setupScroll(0, 0);
    start = point(before);
    await page.mouse.move(start.x, start.y);
    await page.mouse.wheel({ deltaY: 100 });
    await poll("plain wheel scrolls in pan mode", snapshot, (value) => value.y > before.y);
    const wheeled = await settledScroll();
    assert(wheeled.zoom === before.zoom, "Plain wheel unexpectedly changed zoom");
    checks.push("plain-wheel-scrolls-without-zooming");
    await page.keyboard.down("Control");
    try { await page.mouse.wheel({ deltaY: -100 }); } finally { await page.keyboard.up("Control"); }
    await poll("Ctrl+wheel still zooms in pan mode", snapshot, (value) => parseInt(value.zoom, 10) > parseInt(wheeled.zoom, 10));
    checks.push("control-wheel-preserves-preview-zoom");

    await page.click('.prev-tab[data-lane="agent"]');
    const agent = await disabledPan("Agent lane drops pan mode");
    assert(agent.buttonHidden || agent.buttonDisabled, "Pan remains available on the Agent lane");
    await page.click('.prev-tab[data-lane="yours"]');
    await disabledPan("Returning to Yours does not restore pan mode");
    checks.push("lane-switch-drops-pan-and-hides-agent-control");
    await enablePan();
    await page.click("#prevClose");
    await poll("Preview closes", () => page.$eval("#preview", (panel) => panel.hidden));
    await ensureOpen();
    await page.click('.prev-tab[data-lane="yours"]');
    await disabledPan("Closing and reopening does not restore pan mode");
    checks.push("close-reopen-drops-pan-mode");
  } catch (error) {
    failure = error;
  } finally {
    // Release real input even if an assertion fails while the pointer is captured.
    for (const cleanup of [
      async () => { if (mouseDown) await page.mouse.up(); },
      () => page.keyboard.up("Control"),
      () => page.keyboard.up("Meta"),
      () => page.keyboard.press("Escape"),
      async () => {
        await ensureOpen();
        await page.click('.prev-tab[data-lane="yours"]');
        await page.click("#prevZoomReset");
        await poll("cleanup resets zoom and pan", snapshot,
          (value) => value.zoom === "100%" && value.hidden && value.pressed === "false" && !value.captured);
      },
    ]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
  }
  if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], "Preview pan regression and cleanup failed");
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Preview pan regression cleanup failed");
  return checks;
}
