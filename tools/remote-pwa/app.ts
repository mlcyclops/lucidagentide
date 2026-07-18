// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/remote-pwa/app.ts — P-REMOTE.3 (ADR-0226/0227): the phone guest PWA entry (Firebase Hosting).
//
// See a running desktop LUCID from an iPhone (Chrome/Safari, WebKit) and — with a full link — drive it. This
// is a GUEST built from the SAME desktop/collab modules the desktop uses (CollabSocket + CollabGuest + crypto
// + link), so the E2E protocol is single-sourced, never reimplemented. The room key rides ONLY in the URL
// fragment (never sent to any server); the relay is the hosted Cloud Run rendezvous, gated on a Google
// sign-in (P-REMOTE.1). Firebase Auth is loaded from the CDN by firebase_auth.js and exposed as
// window.__lucidAuth, so it stays out of this bundle; this file is the thin wiring over the tested pure core
// (../../desktop/collab/pwa_view.ts).

import { CollabSocket } from "../../desktop/collab/relay_client.ts";
import { CollabGuest, type GuestView } from "../../desktop/collab/guest.ts";
import { importRoomKey } from "../../desktop/collab/crypto.ts";
import { parseShareLink, formatShareLink } from "../../desktop/collab/link.ts";
import { resolveReconnect, RELAY_FILE_NAME } from "../../desktop/collab/drive_relay_codes.ts"; // P-REMOTE.10c (ADR-0235): out-of-band reconnect reader
import { findRelayFile, readRelayFile } from "../../desktop/collab/drive_file.ts";
import { foldEvent, renderControls, renderTranscript, renderHeader, statusLabel, buildTurnReport, renderReportHtml, reportMarkdown, type ViewItem, type TurnReport } from "../../desktop/collab/pwa_view.ts";
import { createRemoteCheckout, entitlementActive, isEntitlementDenied } from "../../desktop/collab/remote_entitlement.ts";
import { acceptAttachment, thumbStripHtml, MAX_ATTACHMENT_BYTES, type Attachment } from "../../desktop/renderer/composer_attachments.ts"; // P-REMOTE.8 (ADR-0229): pasted/attached images
import { penWidthFor, toNormPoint, type NormPoint } from "../../desktop/collab/preview_snapshot.ts"; // P-PREVIEW-PWA.2 (ADR-0239): normalized markup strokes

/** The auth bridge firebase_auth.js publishes on window — a Firebase ID token for the gated relay. */
interface LucidAuth {
  /** A fresh Firebase ID token; pass force=true after checkout to pull the webhook-set claim now (P-REMOTE.6). */
  getIdToken(force?: boolean): Promise<string | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  onChange(cb: (email: string | null) => void): void;
  /** P-REMOTE.10c: the stashed drive.file access token while live, else null (-> needs signInForDrive consent). */
  getDriveToken(): string | null;
  /** P-REMOTE.10c: incremental drive.file consent (redirect) so the phone can read the reconnect-codes file. */
  signInForDrive(): Promise<void>;
}
/** Deployment config (public): the hosted relay's wss base + (P-REMOTE.6) the Firebase functions origin for
 *  the Remote Access checkout. Injected by config.js at deploy. */
interface RemoteConfig { relayWsBase: string; functionsBaseUrl?: string }

declare global {
  interface Window { __lucidAuth?: LucidAuth; __LUCID_REMOTE__?: RemoteConfig }
}

/** Chrome's install-prompt event (not in lib.dom): fired when the PWA is installable. */
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void> }

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

function fatal(msg: string): void {
  $("signin-view").hidden = true;
  $("session-view").hidden = true;
  $("subscribe-view").hidden = true;
  $("checkout-result-view").hidden = true;
  $("reconnect-view").hidden = true;
  const f = $("fatal-view");
  f.hidden = false;
  $("fatal-msg").textContent = msg;
}

// P-REMOTE.10c (ADR-0235): out-of-band reconnect. With no room in the URL (the invite link expired or was
// lost), pull the freshest reconnect code from the host's shared `lucid_relay_codes` Google Drive file,
// decrypt it (optional PIN), and rejoin by loading the normalized link fragment - the whole boot path then
// runs unchanged. drive.file scope: LUCID only ever touches that ONE file. Fail-closed: an encrypted file
// without the right PIN never yields a link.
function reconnectFlow(auth: LucidAuth): void {
  $("signin-view").hidden = true;
  $("session-view").hidden = true;
  $("subscribe-view").hidden = true;
  $("checkout-result-view").hidden = true;
  $("fatal-view").hidden = true;
  $("reconnect-view").hidden = false;

  const statusEl = $("reconnect-status");
  const pinInput = $("reconnect-pin") as HTMLInputElement;
  const btn = $("reconnect-btn") as HTMLButtonElement;
  const setStatus = (msg: string): void => { statusEl.textContent = msg; };

  const attempt = async (): Promise<void> => {
    const token = auth.getDriveToken();
    if (!token) {
      setStatus("Opening Google sign-in for Drive access\u2026");
      await auth.signInForDrive().catch((e) => setStatus(`Sign-in failed: ${String((e as Error)?.message ?? e)}`));
      return; // a full-page redirect follows; the return trip resumes this flow with a token
    }
    btn.disabled = true;
    setStatus("Reading your reconnect codes\u2026");
    try {
      const id = await findRelayFile(token, RELAY_FILE_NAME, fetch);
      if (!id) { setStatus("No reconnect codes found in your Google Drive yet. Get a fresh invite from the desktop."); return; }
      const body = await readRelayFile(token, id, fetch);
      const res = await resolveReconnect(body, pinInput.value.trim() || null, Date.now());
      switch (res.status) {
        case "locked": pinInput.hidden = false; setStatus("These codes are PIN-protected. Enter the PIN, then tap again."); pinInput.focus(); return;
        case "bad-pin": pinInput.hidden = false; setStatus("Wrong PIN \u2014 check it and try again."); return;
        case "expired": setStatus("Your saved reconnect codes have expired. Get a fresh invite from the desktop."); return;
        case "empty": setStatus("That file has no usable reconnect code yet."); return;
        case "ok": {
          setStatus("Reconnecting\u2026");
          const p = parseShareLink(res.link); // parseShareLink accepts the stored relay-path link form
          location.hash = "#" + formatShareLink(p.roomId, p.key, p.writeToken); // normalize to a bare room fragment
          location.reload(); // the normal boot path now runs WITH a room -> sign-in + connect, unchanged
          return;
        }
      }
    } catch (e) {
      setStatus(`Couldn't read Drive: ${String((e as Error)?.message ?? e)}`);
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener("click", () => { void attempt(); });
  // Returning from the drive-consent redirect: the token is now stashed -> resume the read automatically.
  if (auth.getDriveToken()) void attempt();
}

function main(): void {
  const checkout = new URLSearchParams(location.search).get("checkout");
  if (checkout === "success" || checkout === "cancel") {
    $("signin-view").hidden = true;
    $("session-view").hidden = true;
    $("subscribe-view").hidden = true;
    $("fatal-view").hidden = true;
    $("checkout-result-view").hidden = false;
    $("checkout-title").textContent = checkout === "success" ? "Payment complete" : "Checkout canceled";
    $("checkout-message").textContent = checkout === "success"
      ? "Return to your original Remote tab and tap Continue to activate access."
      : "No payment was completed. Return to your original Remote tab whenever you're ready.";
    $("checkout-kicker").textContent = checkout === "success" ? "Remote Access ready" : "Remote Access";
    $("checkout-close").addEventListener("click", () => {
      window.close();
      setTimeout(() => { $("checkout-note").textContent = "You can close this tab and return to your Remote invite."; }, 150);
    });
    return;
  }

  const auth = window.__lucidAuth;
  const cfg = window.__LUCID_REMOTE__;
  if (!auth) return fatal("Sign-in is unavailable (firebase_auth.js failed to load).");
  if (!cfg?.relayWsBase) return fatal("This build has no relay configured (config.js is missing __LUCID_REMOTE__.relayWsBase).");

  // The invite fragment carries roomId + the E2E secret; the relay endpoint comes from deploy config (never
  // the link — the phone only ever connects to its own configured, allowlisted rendezvous).
  const frag = location.hash.replace(/^#/, "").trim();
  if (!frag) { reconnectFlow(auth); return; } // P-REMOTE.10c: no room in the URL -> offer an out-of-band reconnect
  let parsed: ReturnType<typeof parseShareLink>;
  try { parsed = parseShareLink(frag); } catch { return fatal("That invite link is malformed. Copy it again from the desktop Share panel."); }

  let guest: CollabGuest | null = null;
  let socket: CollabSocket | null = null;
  let items: ViewItem[] = [];
  let currentEmail: string | null = null;
  // P-REMOTE.11: reconnect catch-up. `seenTurns` = host turns the user has seen; `awayAt` snapshots it when the
  // screen locks so, on the reconnect welcome-replay, we can summarize the turns that completed while away.
  let seenTurns = 0;
  let awayAt = -1;
  let shotSrc = ""; // P-PREVIEW-PWA.1: the image currently open in the fullscreen snapshot viewer (for Save)
  let guestReadOnly = true; // P-PREVIEW-PWA.2: gates the markup send-back (view guests cannot prompt the host)
  // P-REMOTE.9: end-of-run report over the LAST turn (items since the previous `done`).
  let lastReport: TurnReport | null = null;
  let turnStart = 0;
  // P-COLLAB.15: texts this guest sent + echoed optimistically, to dedup the host's live re-broadcast of them.
  const selfEchoes: string[] = [];

  // Exactly one of the three primary views is visible at a time (fatal() takes over on a hard error).
  const show = (view: "signin" | "session" | "subscribe"): void => {
    $("signin-view").hidden = view !== "signin";
    $("session-view").hidden = view !== "session";
    $("subscribe-view").hidden = view !== "subscribe";
    $("checkout-result-view").hidden = true;
    $("reconnect-view").hidden = true;
  };

  const signInBtn = $("signin-btn") as HTMLButtonElement;
  signInBtn.addEventListener("click", () => { void auth.signIn().catch((e) => fatal(`Sign-in failed: ${String((e as Error)?.message ?? e)}`)); });
  // P-PREVIEW-PWA.2: full screen without the browser header = the INSTALLED app (manifest standalone).
  // Android Chrome fires beforeinstallprompt (a real one-tap Install); iOS Safari has no install API, so
  // show the Add-to-Home-Screen path. Already running standalone -> no hint at all.
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true; // Safari's non-standard flag
  if (!isStandalone) {
    const installBtn = $("install-btn") as HTMLButtonElement;
    let deferredInstall: BeforeInstallPromptEvent | null = null;
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstall = e as BeforeInstallPromptEvent; // Chrome-only event, absent from lib.dom
      installBtn.hidden = false;
      $("install-tip").textContent = "Installs to your home screen: full screen, no browser bar.";
      $("install-hint").hidden = false;
    });
    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
      $("install-tip").textContent = "Full screen: tap Share, then \"Add to Home Screen\".";
      $("install-hint").hidden = false;
    }
    installBtn.addEventListener("click", () => { void deferredInstall?.prompt(); installBtn.hidden = true; });
  }
  $("signout-btn").addEventListener("click", () => { void auth.signOut(); });
  $("subscribe-signout").addEventListener("click", () => { void auth.signOut(); });
  // P-REMOTE.11: the double-decker strip - tap the thin bar to reveal the account/model/folder panel above it.
  const botstrip = $("botstrip");
  $("botstrip-bar").addEventListener("click", () => {
    const open = !botstrip.hasAttribute("data-open");
    botstrip.toggleAttribute("data-open", open);
    $("botstrip-panel").hidden = !open;
    $("botstrip-bar").setAttribute("aria-expanded", open ? "true" : "false");
  });
  // P-REMOTE.11: the reconnect catch-up card - auto-collapsed; tap to expand the missed-turns summary.
  const catchup = $("catchup");
  $("catchup-bar").addEventListener("click", () => {
    const open = !catchup.hasAttribute("data-open");
    catchup.toggleAttribute("data-open", open);
    $("catchup-body").hidden = !open;
    $("catchup-bar").setAttribute("aria-expanded", open ? "true" : "false");
  });
  // P-PREVIEW-PWA.1/.2: tap a preview snapshot -> fullscreen viewer with finger MARKUP. Strokes live in
  // NORMALIZED image space (they survive a rotation/resize and scale losslessly onto the natural-size
  // composite); Save and Send-to-agent both composite image + ink. The send-back stages the PNG through the
  // SAME fail-closed attachment path as a pasted image (P-REMOTE.8) - the user adds words, then taps Send.
  const svImg = $("sv-img") as HTMLImageElement;
  const svCanvas = $("sv-canvas") as HTMLCanvasElement;
  let svStrokes: NormPoint[][] = [];
  let svActive: NormPoint[] | null = null;
  let svArmed = false;
  const drawStrokes = (ctx: CanvasRenderingContext2D, w: number, h: number, strokes: NormPoint[][]): void => {
    ctx.strokeStyle = "#ef4444"; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = penWidthFor(w);
    for (const s of strokes) {
      if (s.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(s[0]!.x * w, s[0]!.y * h);
      for (const p of s.slice(1)) ctx.lineTo(p.x * w, p.y * h);
      ctx.stroke();
    }
  };
  const svRedraw = (): void => {
    const ctx = svCanvas.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, svCanvas.width, svCanvas.height);
    drawStrokes(ctx, svCanvas.width, svCanvas.height, svActive ? [...svStrokes, svActive] : svStrokes);
    ($("sv-undo") as HTMLButtonElement).disabled = svStrokes.length === 0;
  };
  const fitSvCanvas = (): void => {
    if (!svImg.naturalWidth || $("shot-viewer").hidden) return;
    const ir = svImg.getBoundingClientRect(); const sr = $("sv-stage").getBoundingClientRect();
    svCanvas.style.left = `${Math.round(ir.left - sr.left)}px`; svCanvas.style.top = `${Math.round(ir.top - sr.top)}px`;
    svCanvas.style.width = `${Math.round(ir.width)}px`; svCanvas.style.height = `${Math.round(ir.height)}px`;
    const dpr = window.devicePixelRatio || 1;
    svCanvas.width = Math.max(1, Math.round(ir.width * dpr)); svCanvas.height = Math.max(1, Math.round(ir.height * dpr));
    svRedraw();
  };
  const setSvArmed = (on: boolean): void => {
    svArmed = on;
    svCanvas.classList.toggle("armed", on);
    $("sv-draw").setAttribute("aria-pressed", on ? "true" : "false");
    $("sv-hint").hidden = !on;
  };
  /** Image + ink at NATURAL size; falls back to the raw shot when compositing is unavailable. */
  const compositeShot = (): string => {
    if (!svImg.naturalWidth) return shotSrc;
    const out = document.createElement("canvas");
    out.width = svImg.naturalWidth; out.height = svImg.naturalHeight;
    const ctx = out.getContext("2d"); if (!ctx) return shotSrc;
    ctx.drawImage(svImg, 0, 0);
    drawStrokes(ctx, out.width, out.height, svStrokes);
    try { return out.toDataURL("image/png"); } catch { return shotSrc; }
  };
  const openShotViewer = (image: string): void => {
    shotSrc = image; svStrokes = []; svActive = null; setSvArmed(false);
    ($("sv-send") as HTMLButtonElement).hidden = guestReadOnly;
    svImg.onload = fitSvCanvas;
    svImg.src = image;
    $("shot-viewer").hidden = false;
    requestAnimationFrame(fitSvCanvas); // a cached image can skip onload; fit after layout either way
  };
  $("transcript").addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest(".cu-shot-btn") as HTMLElement | null;
    if (!btn) return;
    const item = items.find((i) => i.kind === "preview" && i.id === btn.dataset.shot);
    if (item && item.kind === "preview") openShotViewer(item.image);
  });
  svCanvas.addEventListener("pointerdown", (e) => {
    if (!svArmed) return;
    e.preventDefault();
    try { svCanvas.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
    svActive = [toNormPoint(e.clientX, e.clientY, svCanvas.getBoundingClientRect())];
  });
  svCanvas.addEventListener("pointermove", (e) => {
    if (!svActive) return;
    e.preventDefault();
    svActive.push(toNormPoint(e.clientX, e.clientY, svCanvas.getBoundingClientRect()));
    svRedraw();
  });
  const svEndStroke = (): void => {
    if (!svActive) return;
    if (svActive.length > 1) svStrokes.push(svActive);
    svActive = null; svRedraw();
  };
  svCanvas.addEventListener("pointerup", svEndStroke);
  svCanvas.addEventListener("pointercancel", svEndStroke);
  window.addEventListener("resize", fitSvCanvas);
  $("sv-draw").addEventListener("click", () => setSvArmed(!svArmed));
  $("sv-undo").addEventListener("click", () => { svStrokes.pop(); svRedraw(); });
  $("sv-close").addEventListener("click", () => { $("shot-viewer").hidden = true; setSvArmed(false); });
  $("sv-save").addEventListener("click", () => {
    if (!shotSrc) return;
    const a = document.createElement("a"); a.href = compositeShot(); a.download = `lucid-preview-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  });
  $("sv-send").addEventListener("click", () => {
    if (!shotSrc) return;
    stageDataUrl(compositeShot(), "preview-markup.png"); // validated exactly like a pasted image
    $("shot-viewer").hidden = true; setSvArmed(false);
    promptInput.focus(); // the actions row auto-expands; describe the change, then Send
  });

  const promptForm = $("composer") as HTMLFormElement;
  const promptInput = $("prompt-input") as HTMLTextAreaElement;

  // P-REMOTE.8: staged image attachments (validated data URLs) sent WITH the next prompt as vision input.
  let attachments: Attachment[] = [];
  let attSeq = 0;

  // Auto-collapsed actions row (row 2 of the composer): hidden by default, shown whenever the user is
  // composing (input focused, non-whitespace text, or staged attachments) OR the agent is streaming
  // (Stop must stay reachable). render() keeps composerStreaming current.
  let composerStreaming = false;
  const syncComposerActions = (): void => {
    const composing = document.activeElement === promptInput || promptInput.value.trim().length > 0 || attachments.length > 0;
    $("composer-actions").hidden = !(composing || composerStreaming);
  };
  const renderThumbs = (): void => {
    const strip = $("cx-thumbs");
    strip.innerHTML = thumbStripHtml(attachments);
    strip.hidden = attachments.length === 0;
    for (const a of attachments) {
      const img = strip.querySelector(`.cx-thumb[data-att="${a.id}"] .cx-thumb-img`) as HTMLImageElement | null;
      if (img) img.src = a.dataUrl; // set as a PROPERTY, never interpolated into HTML
    }
  };
  const stageDataUrl = (dataUrl: string, name?: string): void => {
    const r = acceptAttachment(attachments, dataUrl, `att_${++attSeq}`, name);
    if (!r.ok || !r.attachment) { $("bs-summary").textContent = r.reason ?? "couldn't attach"; $("bs-dot").dataset.tone = "ended"; return; }
    attachments.push(r.attachment);
    renderThumbs();
    syncComposerActions();
  };
  const stageFiles = (files: FileList | File[] | null | undefined): void => {
    for (const f of Array.from(files ?? [])) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > MAX_ATTACHMENT_BYTES) { $("bs-summary").textContent = "image too large"; $("bs-dot").dataset.tone = "ended"; continue; }
      const reader = new FileReader();
      reader.onload = () => stageDataUrl(String(reader.result), f.name);
      reader.readAsDataURL(f);
    }
  };
  // Autosize the composer: grow with the text up to ~6 lines, then scroll (max-height caps it in CSS).
  const autosize = (): void => { promptInput.style.height = "auto"; promptInput.style.height = `${Math.min(promptInput.scrollHeight, 160)}px`; };
  promptInput.addEventListener("input", autosize);
  // Actions-row visibility wiring. CRITICAL: on iOS the input blurs BEFORE the Send button click lands;
  // hiding synchronously on blur would swallow the tap, so the blur sync is delayed 200ms to let it fire.
  promptInput.addEventListener("focus", syncComposerActions);
  promptInput.addEventListener("input", syncComposerActions);
  promptInput.addEventListener("blur", () => { setTimeout(syncComposerActions, 200); });

  promptForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = promptInput.value.trim();
    const imgs = attachments.map((a) => a.dataUrl);
    if ((text || imgs.length) && guest?.sendPrompt(text, imgs.length ? imgs : undefined)) {
      // P-REMOTE.9: echo the guest's OWN message into the transcript immediately (the host doesn't broadcast
      // user turns live; on a reconnect the welcome replay re-supplies it, so no duplication).
      const echo = text || `[${imgs.length} image${imgs.length === 1 ? "" : "s"}]`;
      selfEchoes.push(echo); // P-COLLAB.15: dedup the host's live broadcast of my own turn against this echo
      items = [...items, { kind: "user", text: echo }];
      render(guest.view());
      promptInput.value = ""; autosize();
      attachments = []; renderThumbs();
      syncComposerActions();
      $("catchup").hidden = true; // P-REMOTE.11: back in flow - clear the reconnect catch-up
    }
  });
  $("abort-btn").addEventListener("click", () => { guest?.abort(); });

  // Attach via the + label (a native <label for=file-input> - opens the iOS picker on tap, no JS .click(),
  // which iOS blocks for a display:none input), paste, or drag-drop. Every image is re-validated fail-closed.
  const fileInput = $("file-input") as HTMLInputElement;
  fileInput.addEventListener("change", () => { stageFiles(fileInput.files); fileInput.value = ""; });
  promptInput.addEventListener("paste", (ev) => {
    const files = Array.from(ev.clipboardData?.items ?? []).filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (files.length) { ev.preventDefault(); stageFiles(files); }
  });
  const sessionView = $("session-view");
  sessionView.addEventListener("dragover", (ev) => ev.preventDefault());
  sessionView.addEventListener("drop", (ev) => { ev.preventDefault(); stageFiles(ev.dataTransfer?.files); });
  $("cx-thumbs").addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement)?.closest("[data-att-remove]") as HTMLElement | null;
    if (!btn) return;
    attachments = attachments.filter((a) => a.id !== btn.dataset.attRemove);
    renderThumbs();
    syncComposerActions();
  });

  // Keep the composer above the on-screen keyboard. iOS Safari treats the keyboard as an overlay and does NOT
  // shrink 100dvh, so the fixed-bottom composer ends up hidden. Size the app to the VISUAL viewport instead
  // (it shrinks when the keyboard opens), pin the page to the top, and keep the transcript at the bottom.
  const vv = window.visualViewport;
  if (vv) {
    const applyViewport = (): void => {
      document.body.style.height = `${vv.height}px`;
      window.scrollTo(0, 0);
      const sc = $("transcript"); sc.scrollTop = sc.scrollHeight;
    };
    vv.addEventListener("resize", applyViewport);
    vv.addEventListener("scroll", applyViewport);
    promptInput.addEventListener("focus", () => { autosize(); setTimeout(applyViewport, 100); });
  }

  // P-REMOTE.11: populate the auto-collapsed catch-up card from the turns that completed while the phone was
  // locked. Bandwidth-minimal: it summarizes the welcome-replay the guest already receives on reconnect - no
  // extra data crosses the wire. Text is set via textContent (host content is untrusted), never innerHTML.
  const showCatchup = (missed: ReadonlyArray<{ role: string; text: string }>): void => {
    const n = missed.length;
    $("catchup-label").textContent = `${n} update${n === 1 ? "" : "s"} while you were away`;
    const body = $("catchup-body");
    body.textContent = "";
    for (const t of missed) {
      const row = document.createElement("div"); row.className = "cu-turn";
      const role = document.createElement("span"); role.className = "cu-role";
      role.textContent = t.role === "assistant" ? "agent" : (t.role === "host" || t.role === "user" ? "host" : t.role);
      row.append(role, document.createTextNode(t.text.slice(0, 400)));
      body.append(row);
    }
    catchup.removeAttribute("data-open"); body.hidden = true; $("catchup-bar").setAttribute("aria-expanded", "false"); // auto-collapsed
    catchup.hidden = false;
  };

  const render = (view: GuestView): void => {
    $("hdr").innerHTML = renderHeader(view.header);
    // P-REMOTE.11: the live status shows in the condensed bottom strip's always-visible bar (dot + label).
    const st = statusLabel(view);
    $("bs-summary").textContent = st.text;
    $("bs-dot").dataset.tone = st.tone;
    // P-REMOTE.11: back from a lock/disconnect -> summarize the turns that landed while away (once).
    if (awayAt >= 0 && document.visibilityState === "visible") {
      const missed = view.transcript.slice(awayAt);
      if (missed.length) showCatchup(missed);
      awayAt = -1;
    }
    const tr = $("transcript");
    tr.innerHTML = renderTranscript(view.transcript, items);
    // P-PREVIEW-PWA.1: hydrate preview-snapshot thumbnails - the data URL is set as an <img> PROPERTY here,
    // never inlined into the transcript HTML (keeps the re-rendered markup small + text-safe).
    for (const it of items) if (it.kind === "preview") { const im = tr.querySelector(`.cu-shot-btn[data-shot="${it.id}"] .cu-shot-img`) as HTMLImageElement | null; if (im) im.src = it.image; }
    // drive controls appear only for an EDIT (full-link) guest the host accepts as writable
    $("composer").hidden = view.readOnly || view.phase === "ended";
    guestReadOnly = view.readOnly || view.phase === "ended"; // P-PREVIEW-PWA.2: gates the markup send-back
    composerStreaming = items.some((i) => i.kind === "answer" && i.streaming);
    syncComposerActions();
    // P-COLLAB.14: the model + already-used-folder pickers (edit guest only). renderControls returns "" for a
    // view guest, so hide the row whenever it's empty.
    const controlsHtml = renderControls(view);
    const controls = $("controls");
    controls.innerHTML = controlsHtml;
    controls.hidden = !controlsHtml;
    // P-REMOTE.9: the Run report button appears once a turn has completed.
    ($("report-btn") as HTMLButtonElement).hidden = !lastReport;
    if (document.visibilityState === "visible") seenTurns = view.transcript.length; // track what the user has seen
    const scroller = $("transcript");
    scroller.scrollTop = scroller.scrollHeight;
  };

  // P-REMOTE.9: the end-of-run mobile engineering report (files changed + diffstats, tools, model, context).
  const openReport = (): void => {
    if (!lastReport) return;
    $("report-body").innerHTML = renderReportHtml(lastReport);
    $("report-modal").hidden = false;
  };
  $("report-btn").addEventListener("click", openReport);
  $("report-close").addEventListener("click", () => { $("report-modal").hidden = true; });
  $("report-copy").addEventListener("click", () => {
    if (!lastReport) return;
    const btn = $("report-copy");
    void navigator.clipboard.writeText(reportMarkdown(lastReport))
      .then(() => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); })
      .catch(() => { btn.textContent = "Copy failed"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); });
  });

  // P-COLLAB.14: a picker change asks the host to switch the model / already-used folder (EDIT access only).
  // The host re-validates the pick against its allowlist + applies it through its own switch path; the phone
  // reflects the result when the host rebroadcasts fresh `options`/`state`.
  $("controls").addEventListener("change", (ev) => {
    const sel = (ev.target as HTMLElement)?.closest("select[data-role]") as HTMLSelectElement | null;
    if (!sel || !guest) return;
    if (sel.dataset.role === "model") guest.setModel(sel.value);
    else if (sel.dataset.role === "workspace") guest.setWorkspace(sel.value);
  });

  // ── Subscribe flow (P-REMOTE.6): a signed-in phone the RELAY refused for no Remote Access entitlement.
  const subHint = $("sub-hint");
  const subscribeBtn = $("subscribe-btn") as HTMLButtonElement;
  const continueBtn = $("subscribe-continue") as HTMLButtonElement;
  let checkoutStarted = false;
  const showSubscribe = (): void => {
    $("sub-email").textContent = currentEmail ?? "";
    subHint.textContent = "";
    subscribeBtn.disabled = false;
    checkoutStarted = false;
    continueBtn.hidden = true;
    show("subscribe");
  };

  // Connect the guest for the current sign-in. The relay is the authoritative gate: an unentitled token is
  // refused with 4403, which the guest surfaces as an ENDED view -> onGuestEnd routes to Subscribe.
  const connect = (): void => {
    if (guest) return;
    void (async () => {
      try {
        const key = await importRoomKey(parsed.key);
        const wsUrl = `${cfg.relayWsBase.replace(/\/+$/, "")}/r/${parsed.roomId}`;
        socket = new CollabSocket({ wsUrl, role: "guest", key, authToken: () => auth.getIdToken() });
        items = []; lastReport = null; turnStart = 0; selfEchoes.length = 0;
        guest = new CollabGuest(socket, { name: currentEmail ?? "phone", writeToken: parsed.writeToken }, {
          onEvent: (e) => {
            items = foldEvent(items, e);
            // P-REMOTE.9: on turn end, build the report from this turn's items, then start the next segment.
            if (e.type === "done") { lastReport = buildTurnReport(items.slice(turnStart), guest!.view()); turnStart = items.length; }
            render(guest!.view());
          },
          // P-COLLAB.15: a live user turn from the host or ANOTHER guest. The sender already echoed its own
          // optimistically, so dedup a matching pending self-echo; otherwise render it labelled with `from`.
          onUserTurn: (text, from) => {
            const i = selfEchoes.indexOf(text);
            if (i !== -1) { selfEchoes.splice(i, 1); return; } // my own turn, already shown
            items = [...items, { kind: "user", text, from }];
            render(guest!.view());
          },
          onView: (view) => render(view),
          onEnd: () => {
            const view = guest!.view();
            if (isEntitlementDenied(view)) { guest = null; showSubscribe(); return; }
            render(view);
          },
          onError: (m) => render({ ...guest!.view(), note: m }),
        });
        guest.start();
        show("session");
        render(guest.view());
      } catch (e) {
        fatal(`Could not open the session: ${String((e as Error)?.message ?? e)}`);
      }
    })();
  };

  subscribeBtn.addEventListener("click", () => {
    if (checkoutStarted) return;
    const base = cfg.functionsBaseUrl;
    if (!base) { subHint.textContent = "Remote Access can't be purchased in this build. Update the app or contact support."; return; }

    // Reserve the tab synchronously while this click still carries a user gesture. Opening it after either the
    // token refresh or callable fetch is blocked by iPhone Safari/Chrome. Setting opener ourselves preserves a
    // Window reference for the later navigation (the `noopener` window feature may make window.open return null).
    const checkoutWindow = window.open("about:blank", "_blank");
    if (!checkoutWindow) {
      subHint.textContent = "Checkout was blocked. Allow pop-ups for this site, then tap Subscribe again.";
      return;
    }
    try {
      checkoutWindow.opener = null;
    } catch {
      try { checkoutWindow.close(); } catch { /* The browser may already have discarded the placeholder. */ }
      subHint.textContent = "Couldn't open a secure checkout tab. Close other tabs, then try again.";
      return;
    }

    checkoutStarted = true;
    subscribeBtn.disabled = true;
    subHint.textContent = "Opening secure checkout…";
    void (async () => {
      let navigated = false;
      try {
        const token = await auth.getIdToken();
        if (!token) {
          subHint.textContent = "Your sign-in expired. Sign in again, then tap Subscribe.";
          return;
        }
        const url = await createRemoteCheckout({ functionsBaseUrl: base, token });
        if (!url) {
          subHint.textContent = "Couldn't start checkout. Check your connection and sign-in, then try again.";
          return;
        }
        if (checkoutWindow.closed) {
          subHint.textContent = "The checkout tab was closed. Tap Subscribe to try again.";
          return;
        }
        checkoutWindow.location.href = url;
        navigated = true;
        continueBtn.hidden = false;
        subHint.textContent = "Complete payment in the new tab, then return here and tap Continue.";
      } catch {
        subHint.textContent = "Couldn't open checkout. Check your connection, then tap Subscribe to try again.";
      } finally {
        if (!navigated) {
          try { checkoutWindow.close(); } catch { /* The browser may already have discarded the placeholder. */ }
          checkoutStarted = false;
          subscribeBtn.disabled = false;
        }
      }
    })();
  });
  continueBtn.addEventListener("click", () => {
    void (async () => {
      subHint.textContent = "Checking your subscription…";
      // Force a token refresh so the webhook-set `premium` claim is pulled now, not up to an hour later.
      if (entitlementActive(await auth.getIdToken(true))) { connect(); return; }
      subHint.textContent = "Not active yet — it can take a few seconds after payment. Tap Continue again.";
    })();
  });

  // P-REMOTE.3: keep the live session across an iOS screen-lock / tab-suspend. When the tab becomes visible
  // again (or the network returns), nudge the socket to reconnect IMMEDIATELY instead of waiting out the
  // exponential backoff; if it died fatally while away (e.g. the token lapsed), rebuild a fresh socket that
  // re-presents a fresh token. Idempotent + guarded so it never double-connects.
  const resumeConnection = (): void => {
    if (document.visibilityState === "hidden" || !currentEmail) return;
    if (socket && !socket.isClosed) { socket.reconnectNow(); return; }
    guest = null; socket = null; connect();
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") awayAt = seenTurns; }); // P-REMOTE.11: snapshot before the lock
  document.addEventListener("visibilitychange", resumeConnection);
  window.addEventListener("online", resumeConnection);
  window.addEventListener("pageshow", resumeConnection);

  auth.onChange((email) => {
    currentEmail = email;
    if (!email) {
      guest?.leave("signed out");
      guest = null;
      show("signin");
      return;
    }
    $("account-email").textContent = email;
    connect();
  });
}

async function boot(): Promise<void> {
  if (!window.__lucidAuth) {
    await Promise.race([
      new Promise<void>((resolve) => window.addEventListener("lucid-auth-ready", () => resolve(), { once: true })),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }
  main();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { void boot(); });
else void boot();
