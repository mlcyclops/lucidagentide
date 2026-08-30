// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/remote-pwa/app.ts - P-REMOTE.3 (ADR-0226/0227): the phone guest PWA entry (Firebase Hosting).
//
// See a running desktop LUCID from an iPhone (Chrome/Safari, WebKit) and - with a full link - drive it. This
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
import { escapeHtml, foldEvent, renderControls, renderTranscript, renderHeader, renderLaneCard, renderProcessRow, presentedStatus, RECONNECT_GRACE_MS, buildTurnReport, renderReportHtml, reportMarkdown, type ViewItem, type TurnReport } from "../../desktop/collab/pwa_view.ts";
import { laneRollup } from "../../desktop/collab/fleet_status.ts"; // P-PWA-FLEET.2: the SAME order/wording/counting the desktop dock pill uses
import { planSync, type SyncPlan, type TargetProgress } from "../../desktop/collab/sync_state.ts"; // P-PWA-FOCUS.2: the pure unseen-per-target decision
import { createRemoteCheckout, entitlementActive, isEntitlementDenied } from "../../desktop/collab/remote_entitlement.ts";
import { acceptAttachment, thumbStripHtml, MAX_ATTACHMENT_BYTES, type Attachment } from "../../desktop/renderer/composer_attachments.ts"; // P-REMOTE.8 (ADR-0229): pasted/attached images
import { downmixMono, encodeWavPcm16, mergeTranscript, resampleLinear, WHISPER_SAMPLE_RATE } from "../../desktop/renderer/dictation.ts"; // P-REMOTE.12: pure PCM->WAV transcode (same math as the desktop mic); P-REMOTE.14 reuses mergeTranscript
import { penWidthFor, toNormPoint, type NormPoint } from "../../desktop/collab/preview_snapshot.ts"; // P-PREVIEW-PWA.2 (ADR-0239): normalized markup strokes
import { decideSttMode, type SttCapability, type SttDecision } from "../../desktop/collab/device_stt_policy.ts"; // P-REMOTE.14: the pure, fail-closed "may this phone transcribe?" decision
import { installSttLanguage, probeSttCapability, startDictation } from "./device_stt.ts"; // P-REMOTE.14: the typed Web Speech wrapper
import type { CollabTranscriptTurn, SttSource } from "../../desktop/collab/frames.ts";

/** The auth bridge firebase_auth.js publishes on window - a Firebase ID token for the gated relay. */
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
        case "bad-pin": pinInput.hidden = false; setStatus("Wrong PIN - check it and try again."); return;
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
  // the link - the phone only ever connects to its own configured, allowlisted rendezvous).
  const frag = location.hash.replace(/^#/, "").trim();
  if (!frag) { reconnectFlow(auth); return; } // P-REMOTE.10c: no room in the URL -> offer an out-of-band reconnect
  let parsed: ReturnType<typeof parseShareLink>;
  try { parsed = parseShareLink(frag); } catch { return fatal("That invite link is malformed. Copy it again from the desktop Share panel."); }

  let guest: CollabGuest | null = null;
  let socket: CollabSocket | null = null;
  let items: ViewItem[] = []; // the MASTER session's folded items - a lane's stream NEVER enters this list
  // P-PWA-FOCUS.1: which conversation the transcript + composer are pointed at: "master", or a lane id.
  let focus = "master";
  // Per-target folded items + the host's `lane-sync` replay, keyed by lane id. Separate lists, never one
  // shared one: a lane's words in the master transcript would be another agent's answer wearing this
  // session's clothing. Dynamic keys (lanes come and go), so a Map.
  const targetItems = new Map<string, ViewItem[]>();
  const targetPrior = new Map<string, CollabTranscriptTurn[]>();
  // The user's explicit open/closed choice per Thinking block, keyed `<target>:<data-think item index>`.
  // Repaints re-apply it; an untouched block keeps the default (the live trailing one renders open). The
  // target is part of the key because the index alone is not unique across two conversations.
  const thinkIntent = new Map<string, boolean>();
  let currentEmail: string | null = null;
  // P-PWA-FOCUS.2: cross-screen-lock sync. `seen` is the rendered stream length the user has actually LOOKED
  // at, PER TARGET (master and each watched lane). Only the FOCUSED target is ever marked seen, which is what
  // makes an unfocused lane accumulate a real backlog instead of being silently forgiven. `hiddenAt` is when
  // the screen locked (0 = visible), `pendingSync` the plan waiting on a tap, and `markFrom` the unseen
  // boundary the transcript draws + scrolls to for the focused target (-1 = none).
  const seen = new Map<string, number>();
  let hiddenAt = 0;
  let pendingSync: SyncPlan | null = null;
  let markFrom = -1;
  let flapAt = 0; // P-REMOTE.13: when the current transient reconnect began (0 = healthy)
  let shotSrc = ""; // P-PREVIEW-PWA.1: the image currently open in the fullscreen snapshot viewer (for Save)
  let guestReadOnly = true; // P-PREVIEW-PWA.2: gates the markup send-back (view guests cannot prompt the host)
  // P-REMOTE.9: end-of-run report over the LAST turn (items since the previous `done`).
  let lastReport: TurnReport | null = null;
  let turnStart = 0;
  // P-COLLAB.15: texts this guest sent + echoed optimistically, to dedup the host's live re-broadcast of them.
  const selfEchoes: string[] = [];
  // P-PWA-FLEET.1: a lane target staged by a lane card's Prompt button - the NEXT send goes to that lane
  // P-PWA-FLEET.2: per-lane composer drafts, keyed by lane id, so a fleet-status repaint (every snapshot)
  // cannot swallow half-typed text out of a lane card's input. Dynamic keys inserted/deleted at runtime, so
  // a Map. Cleared per lane on a successful send.
  const laneDrafts = new Map<string, string>();
  // P-REMOTE.14: OPTIONAL device dictation. `pendingSttSource` labels the NEXT send with where its text was
  // transcribed. P-REMOTE.15: the LONG explanation is no longer a wall of small grey text under the composer -
  // it lives in the "?" sheet (`voiceInfo`, `voiceRisk`), and only a SHORT transient line ever shows inline.
  let pendingSttSource: SttSource | null = null;
  let voiceInfo = ""; // the mode-specific explanation the "?" sheet leads with ("" = nothing decided yet)
  let voiceRisk = false; // this voice path would send audio off the phone -> the "?" button goes amber
  let voiceStatus = ""; // the one-line inline status (listening / it failed); "" hides the line entirely

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
  /** Image + ink at NATURAL size; falls back to the raw shot when compositing is unavailable.
   *
   *  Re-draws the strokes onto a DETACHED canvas on purpose. Do NOT "simplify" this to
   *  `drawImage(svCanvas)`: an attached, visible canvas does not rasterize the same drawing to the same
   *  pixels twice on this platform (two readbacks alternate between two bitmaps, about 0.17% of pixels,
   *  channel deltas up to 71), and `drawImage` inherits that jitter from its source. A detached canvas is
   *  byte-stable and `svImg` is an already-decoded bitmap, so this path composites reproducibly and the
   *  annotated shot the guest sends is the one they drew. Measured in ADR-0297 (CREATOR-3b), step 4. */
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
    // A Thinking summary tap records the user's INTENT (the click's default action flips `open` after this
    // handler). The per-event innerHTML repaint resets every <details>, so render() re-applies the intent -
    // without this, an open Thinking block snaps shut on the next streamed token and is unreadable live.
    const sum = (ev.target as HTMLElement | null)?.closest("details[data-think] > summary") as HTMLElement | null;
    if (sum) { const d = sum.parentElement as HTMLDetailsElement; thinkIntent.set(`${focus}:${d.dataset.think ?? "-1"}`, !d.open); return; }
    const btn = (ev.target as HTMLElement | null)?.closest(".cu-shot-btn") as HTMLElement | null;
    if (!btn) return;
    // P-PWA-FOCUS.1: the tap belongs to whatever the transcript is currently showing.
    const shown = focus === "master" ? items : targetItems.get(focus) ?? [];
    const item = shown.find((i) => i.kind === "preview" && i.id === btn.dataset.shot);
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
  // P-REMOTE.15: the popup menu currently open ("" = none). An open menu counts as composing: iOS blurs the
  // input BEFORE a tap lands, so otherwise the row would collapse from under the menu the user is reading.
  let openMenuId = "";
  const syncComposerActions = (): void => {
    const composing = document.activeElement === promptInput || promptInput.value.trim().length > 0 || attachments.length > 0;
    const open = composing || composerStreaming || openMenuId !== "";
    $("composer-actions").hidden = !open;
    // P-REMOTE.15: the transient voice line rides with the actions row - it belongs to the mic beside it.
    $("voice-status").hidden = !(open && voiceStatus.length > 0);
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
    // P-PWA-FOCUS.1: the composer belongs to the FOCUSED conversation. A focused lane rides `fleetPrompt`,
    // which is text-only on the wire - so staged images are refused OUT LOUD instead of being dropped on the
    // floor. Silently sending the words without the picture the user attached to them is the worse failure.
    if (focus !== "master") {
      if (!guest) return;
      const lane = targetItems.get(focus) ?? [];
      if (imgs.length) {
        targetItems.set(focus, [...lane, { kind: "note", text: "Images can only go to the main session. Remove them, or tap Back to main session to send them there." }]);
        render(guest.view());
        return;
      }
      if (!text || !guest.fleetPrompt(focus, text)) return;
      targetItems.set(focus, [...lane, { kind: "user", text }]);
      promptInput.value = ""; autosize();
      // The lane wire carries no sttSource field, so the provenance claim cannot ride along: drop it rather
      // than let it outlive its text and mislabel the NEXT master send.
      pendingSttSource = null; dictatedText = "";
      syncComposerActions();
      render(guest.view());
      return;
    }
    // P-PWA-FLEET.2: a lane is also drivable from its OWN card's composer; this branch is the master session.
    // P-REMOTE.14: `pendingSttSource` is set only by a device-dictated transcript, so the host learns whether
    // the words were transcribed on the phone (locally or by the browser vendor's cloud) or not at all.
    if ((text || imgs.length) && guest?.sendPrompt(text, imgs.length ? imgs : undefined, undefined, pendingSttSource ?? undefined)) {
      // P-REMOTE.9: echo the guest's OWN message into the transcript immediately (the host doesn't broadcast
      // user turns live; on a reconnect the welcome replay re-supplies it, so no duplication).
      const echo = text || `[${imgs.length} image${imgs.length === 1 ? "" : "s"}]`;
      selfEchoes.push(echo); // P-COLLAB.15: dedup the host's live broadcast of my own turn against this echo
      items = [...items, { kind: "user", text: echo }];
      render(guest.view());
      promptInput.value = ""; autosize();
      attachments = []; renderThumbs();
      pendingSttSource = null; dictatedText = "";
      syncComposerActions();
      $("catchup").hidden = true; // P-REMOTE.11: back in flow - clear the reconnect catch-up
    }
  });
  // P-PWA-FOCUS.1: Stop stops whatever the composer is driving - the master turn, or the focused lane.
  $("abort-btn").addEventListener("click", () => {
    if (focus === "master") { guest?.abort(); return; }
    if (!guest || !guest.fleetStop(focus)) return;
    targetItems.set(focus, [...(targetItems.get(focus) ?? []), { kind: "note", text: "asked this lane to stop" }]);
    render(guest.view());
  });

  // ---- P-REMOTE.15: the two composer popup menus (MORE, and the Send split) ----
  // Controls in the same family collapse into a menu instead of each taking a slot in the row. Both menus are
  // plain hidden divs anchored above the composer; exactly one is open at a time.
  const MENUS: ReadonlyArray<{ menu: string; trigger: string }> = [
    { menu: "more-menu", trigger: "more-btn" },
    { menu: "send-menu", trigger: "send-more" },
  ];
  const closeMenu = (): void => {
    if (!openMenuId) return;
    const m = MENUS.find((x) => x.menu === openMenuId);
    openMenuId = "";
    if (m) { $(m.menu).hidden = true; $(m.trigger).setAttribute("aria-expanded", "false"); }
    syncComposerActions();
  };
  const toggleMenu = (id: string): void => {
    const reopen = openMenuId !== id;
    closeMenu(); // never two menus at once
    const m = MENUS.find((x) => x.menu === id);
    if (!reopen || !m) return;
    openMenuId = id;
    $(m.menu).hidden = false;
    $(m.trigger).setAttribute("aria-expanded", "true");
    syncComposerActions();
  };
  for (const m of MENUS) {
    $(m.trigger).addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleMenu(m.menu); });
  }
  // A tap anywhere outside a menu dismisses it (capture, so a tap on the transcript counts), as does Escape.
  document.addEventListener("pointerdown", (ev) => {
    if (!openMenuId) return;
    if ((ev.target as HTMLElement | null)?.closest(".cx-wrap")) return;
    closeMenu();
  }, true);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMenu(); });
  // The MORE control earns its slot only when it holds something: no dead "..." in the row, ever.
  const syncMoreBtn = (): void => {
    const empty = ($("mi-dictate") as HTMLButtonElement).hidden && ($("mi-checkin") as HTMLButtonElement).hidden;
    ($("more-btn") as HTMLButtonElement).hidden = empty;
    if (empty && openMenuId === "more-menu") closeMenu();
  };

  // ---- P-PWA-FLEET.1/.2: fleet strip + processes strip + mid-turn steering ----
  const fleetFilter = $("fleet-filter") as HTMLInputElement;
  /** A lane's display name from the latest snapshot, for the notes a lane action writes into the transcript.
   *  Falls back to the id, which is what the host would have named it anyway. */
  const laneName = (laneId: string): string => {
    const snap = items.find((i) => i.kind === "fleet-lanes");
    return (snap?.kind === "fleet-lanes" ? snap.lanes.find((l) => l.id === laneId)?.name : undefined) ?? laneId;
  };
  // P-PWA-FOCUS.1: point the transcript AND the composer at one conversation. Watching is read-only, so a
  // view guest may switch too; what it may SEND is gated exactly as before (guest core, then host).
  // Fail-closed on the subscription: if the host cannot be told what we are watching (the session ended),
  // the focus does NOT move - a composer aimed at a target we are not subscribed to would be lying.
  const setFocus = (target: string): void => {
    const next = target && target !== "master" ? target : "master";
    if (next === focus || !guest || !guest.watch(next)) return;
    focus = next;
    markFrom = -1; // P-PWA-FOCUS.2: a boundary belongs to ONE conversation; never carry it across a switch
    closeMenu(); // a menu opened against the old target must not act on the new one
    render(guest.view());
  };
  $("focus-back").addEventListener("click", () => setFocus("master"));
  // P-PWA-FLEET.2: the strip is a double-decker whose bar carries the same count pips as the DESKTOP's
  // minimized dock pill (shared order/wording/counting via fleet_status.ts, shared colours via the
  // `lane-<status>` class), and which stays COLLAPSED until the user opens it - a fleet must not cost the
  // transcript its screen. Re-typing the panel's markup while it is closed would be wasted work, so the
  // cards render only when open; the bar is always current.
  //
  // A lane card's input is a live DOM node the user may be typing into, so a repaint MUST NOT blow it away:
  // the drafts are read out before the repaint and written back after (keyed by lane id).
  const renderFleetStrip = (): void => {
    const el = $("fleet");
    const snap = items.find((i) => i.kind === "fleet-lanes");
    if (!snap || snap.kind !== "fleet-lanes" || snap.lanes.length === 0) { el.hidden = true; return; }
    el.toggleAttribute("data-readonly", guestReadOnly);
    const roll = laneRollup(snap.lanes);
    // A lane needing a human tints the BAR and nothing more. Do NOT add an auto-expand here: the user
    // rejected it outright (2026-08-30, ADR-0302) as annoying and disruptive, and they are right - a panel
    // that opens itself steals the screen mid-read and moves whatever the thumb was about to tap. The red
    // bar plus the red pip is the whole signal; opening it stays the user's decision, always.
    el.toggleAttribute("data-attn", roll.attention);
    // The pips: one per state present, attention-first, coloured by class. Counts are host-derived numbers
    // and the state strings are escaped by the shared renderer's own contract, so this markup is safe.
    $("fleet-pips").innerHTML = roll.counts
      .map((c) => `<span class="fleet-pip lane-${escapeHtml(c.status)}"><i aria-hidden="true"></i><b>${c.count}</b></span>`)
      .join("");
    $("fleet-sum").textContent = roll.summary; // host wording stays textContent
    $("fleet-bar").setAttribute("title", roll.lines.join(" \u00b7 "));
    el.hidden = false;
    if (!el.hasAttribute("data-open")) return; // collapsed: the bar is enough
    const q = fleetFilter.value.trim().toLowerCase();
    const lanes = q ? snap.lanes.filter((l) => l.name.toLowerCase().includes(q)) : snap.lanes;
    const body = $("fleet-body");
    for (const ta of Array.from(body.querySelectorAll<HTMLTextAreaElement>("[data-lane-input]"))) {
      const id = ta.dataset.laneInput ?? "";
      if (ta.value) laneDrafts.set(id, ta.value); else laneDrafts.delete(id);
    }
    const focusedLane = (document.activeElement as HTMLElement | null)?.closest?.("[data-lane-input]") as HTMLTextAreaElement | null;
    body.innerHTML = lanes.length ? lanes.map(renderLaneCard).join("") : `<div class="fleet-empty">No lanes match</div>`;
    for (const ta of Array.from(body.querySelectorAll<HTMLTextAreaElement>("[data-lane-input]"))) {
      const draft = laneDrafts.get(ta.dataset.laneInput ?? "");
      if (draft) ta.value = draft; // set as a PROPERTY - a draft is user text, never interpolated
      if (focusedLane && ta.dataset.laneInput === focusedLane.dataset.laneInput) ta.focus();
    }
    // P-PWA-FOCUS.1: the card's header row becomes the switch into that lane's conversation, and the card
    // the composer is currently driving is marked so the panel agrees with the focus bar. Applied to the DOM
    // after render: the shared card renderer knows nothing about this phone's focus.
    for (const card of Array.from(body.querySelectorAll<HTMLElement>(".lane-card"))) {
      // role/tabindex now ship in renderLaneCard's markup, so the header is keyboard-reachable on the first
      // paint; only the focused marker is per-render state.
      card.toggleAttribute("data-focused", card.dataset.lane === focus);
    }
  };
  const renderProcsStrip = (): void => {
    const el = $("procs");
    const snap = items.find((i) => i.kind === "processes");
    if (!snap || snap.kind !== "processes" || snap.processes.length === 0) { el.hidden = true; return; }
    $("procs-label").textContent = `Processes (${snap.processes.length})`;
    const body = $("procs-body");
    body.innerHTML = snap.processes.map(renderProcessRow).join("");
    // P-PWA-FOCUS.1: a process that IS a conversation becomes tappable. The row renderer emits its own
    // `data-proc-id`/`data-proc-kind`, so the target is read off each row instead of index-matching the DOM
    // back against the snapshot. An import or a browser session maps to NO target and stays inert: a row
    // that cannot be focused must not look tappable.
    for (const row of Array.from(body.querySelectorAll<HTMLElement>(".proc-row"))) {
      const kind = row.dataset.procKind ?? "";
      const target = kind === "lane" ? (row.dataset.procId ?? "") : kind === "master-turn" ? "master" : "";
      if (!target || target === focus) continue; // where you already are is not an action either
      row.dataset.focus = target;
      row.setAttribute("role", "button");
      row.tabIndex = 0;
    }
    el.hidden = false;
  };
  fleetFilter.addEventListener("input", () => renderFleetStrip());
  const fleet = $("fleet");
  $("fleet-bar").addEventListener("click", () => {
    const open = !fleet.hasAttribute("data-open");
    fleet.toggleAttribute("data-open", open);
    $("fleet-panel").hidden = !open;
    $("fleet-bar").setAttribute("aria-expanded", open ? "true" : "false");
    if (open && guest) renderFleetStrip(); // the panel renders lazily: fill it on the way open
  });
  const procs = $("procs");
  $("procs-bar").addEventListener("click", () => {
    const open = !procs.hasAttribute("data-open");
    procs.toggleAttribute("data-open", open);
    $("procs-body").hidden = !open;
    $("procs-bar").setAttribute("aria-expanded", open ? "true" : "false");
  });
  // P-PWA-FOCUS.1: tap a Process that is a conversation -> it becomes the transcript + composer. Only the
  // rows renderProcsStrip mapped to a target carry `data-focus`, so an inert row cannot reach setFocus.
  $("procs-body").addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement | null)?.closest(".proc-row[data-focus]") as HTMLElement | null;
    if (row) setFocus(row.dataset.focus ?? "master");
  });
  // The rows are role=button + tabbable, so the keyboard has to activate them like a button does.
  $("procs-body").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const row = (ev.target as HTMLElement | null)?.closest(".proc-row[data-focus]") as HTMLElement | null;
    if (!row) return;
    ev.preventDefault();
    setFocus(row.dataset.focus ?? "master");
  });
  // Check in: a one-tap mid-turn status ask; the agent answers briefly and continues. Shared by the master
  // composer's menu row and every lane card's Check in button.
  const CHECKIN_PROMPT = "Please give a brief status update: what is finished, what you are doing now, what remains. Then continue.";
  // P-PWA-FLEET.2: a lane is driven IN ITS OWN LANE. Every button in a card carries `data-lane` +
  // `data-fleet-act`/`data-fleet-answer`, and the text (when one is needed) comes from THAT card's input -
  // never from the master composer. The guest core refuses all of it for a view guest, and the host refuses
  // again, so a hidden control is a courtesy rather than the enforcement.
  $("fleet-body").addEventListener("click", (ev) => {
    // P-PWA-FOCUS.1: the card's HEADER (dot + name + status) switches the transcript and composer to that
    // lane; the card's own buttons keep their own meanings. The header holds no controls today, so the
    // button check is only insurance against a future control landing in that row.
    const head = (ev.target as HTMLElement | null)?.closest(".lane-row") as HTMLElement | null;
    if (head && !(ev.target as HTMLElement | null)?.closest("button")) {
      const card = head.closest(".lane-card") as HTMLElement | null;
      if (card?.dataset.lane) { setFocus(card.dataset.lane); return; }
    }
    const btn = (ev.target as HTMLElement | null)?.closest("button[data-lane]") as HTMLElement | null;
    if (!btn || !guest) return;
    const laneId = btn.dataset.lane ?? "";
    const answer = btn.dataset.fleetAnswer;
    // P-PWA-FOCUS.1: a card action's confirmation belongs in the transcript the user is actually watching. If
    // that lane IS the focused conversation the note goes to its list; otherwise the master keeps the phone's
    // action log, naming the lane it was for.
    const logAction = (text: string): void => {
      if (focus === laneId) targetItems.set(laneId, [...(targetItems.get(laneId) ?? []), { kind: "note", text }]);
      else items = [...items, { kind: "note", text }];
    };
    if (answer) {
      guest.fleetAnswer(laneId, answer !== "deny", answer === "once" || answer === "session" ? answer : undefined);
      logAction(answer === "deny" ? "Denied the lane's approval ask" : `Allowed the lane's approval ask (${answer})`);
      render(guest.view());
      return;
    }
    const act = btn.dataset.fleetAct;
    const name = laneName(laneId);
    if (act === "stop") {
      guest.fleetStop(laneId);
      logAction(focus === laneId ? "asked this lane to stop" : `asked lane ${name} to stop`);
      render(guest.view());
      return;
    }
    if (act === "checkin") {
      if (guest.interject(laneId, CHECKIN_PROMPT)) {
        logAction(focus === laneId ? "check-in requested" : `check-in requested from lane ${name}`);
        render(guest.view());
      }
      return;
    }
    if (act !== "send" && act !== "push") return;
    const input = $("fleet-body").querySelector<HTMLTextAreaElement>(`[data-lane-input="${CSS.escape(laneId)}"]`);
    const text = input?.value.trim() ?? "";
    if (!text) { input?.focus(); return; }
    // Send/Queue rides fleetPrompt (the host stages it when the lane is mid-turn); Push interjects the
    // RUNNING turn through the same operator-origin seam the master composer uses (AGENTS.md #5).
    const sent = act === "push" ? guest.interject(laneId, text) : guest.fleetPrompt(laneId, text);
    if (!sent) return;
    // P-PWA-FOCUS.1: the turn belongs to THAT lane's conversation, so it lands in that lane's list. The
    // master keeps its labelled echo only while the lane is not the focused transcript - otherwise the send
    // would be invisible in the very view the user is watching.
    targetItems.set(laneId, [...(targetItems.get(laneId) ?? []), { kind: "user", text }, ...(act === "push" ? [{ kind: "note" as const, text: "pushed mid-turn" }] : [])]);
    if (focus !== laneId) items = [...items, { kind: "user", text: `[lane: ${name}] ${text}` }, ...(act === "push" ? [{ kind: "note" as const, text: `pushed mid-turn to lane ${name}` }] : [])];
    if (input) input.value = "";
    laneDrafts.delete(laneId);
    render(guest.view());
  });
  // P-PWA-FOCUS.1: the card header is role=button + tabbable, so the keyboard activates it like a button.
  // A lane input's Enter cannot reach this: a textarea sits in `.lane-drive`, never inside `.lane-row`.
  $("fleet-body").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const head = (ev.target as HTMLElement | null)?.closest(".lane-row") as HTMLElement | null;
    const card = head?.closest(".lane-card") as HTMLElement | null;
    if (!card?.dataset.lane) return;
    ev.preventDefault();
    setFocus(card.dataset.lane);
  });
  // Push now (the master Send caret's menu row): interject the RUNNING turn of whatever the composer is
  // driving. `interject` already takes a target, so the focus is simply passed straight through, and the
  // echo lands in the transcript the user is looking at - never in the master's.
  $("mi-push").addEventListener("click", () => {
    closeMenu();
    const text = promptInput.value.trim();
    if (!text || !guest || !guest.interject(focus, text)) return;
    const echo: ViewItem[] = [{ kind: "user", text }, { kind: "note", text: "Pushed mid-turn" }];
    if (focus === "master") items = [...items, ...echo];
    else targetItems.set(focus, [...(targetItems.get(focus) ?? []), ...echo]);
    render(guest.view());
    promptInput.value = ""; autosize();
    syncComposerActions();
  });
  $("mi-checkin").addEventListener("click", () => {
    closeMenu();
    if (!guest || !guest.interject(focus, CHECKIN_PROMPT)) return;
    const note: ViewItem = { kind: "note", text: "check-in requested" };
    if (focus === "master") items = [...items, note];
    else targetItems.set(focus, [...(targetItems.get(focus) ?? []), note]);
    render(guest.view());
  });

  // ---- P-REMOTE.12 (ADR-0251): push-to-talk - HOLD to record, release to send ----
  // The clip is transcoded ON the phone to 16k mono WAV (whisper.cpp cannot decode WebM server-side;
  // there is no Web Audio in Bun) and sent as PromptFrame.audio; the HOST transcribes it with the same
  // engine as its local mic and the transcript enters the session as an ordinary, scanned guest prompt.
  // Push-to-talk (not VAD) is the user-confirmed mobile call: reliable on iOS, no hot mic ever.
  const pttBtn = $("ptt-btn") as HTMLButtonElement;
  let pttRec: MediaRecorder | null = null;
  let pttStream: MediaStream | null = null;
  let pttChunks: Blob[] = [];
  let pttStartedAt = 0;
  const pttStop = (): void => { try { pttRec?.stop(); } catch { /* already stopped */ } };
  const pttCleanup = (): void => {
    pttBtn.classList.remove("rec");
    pttStream?.getTracks().forEach((t) => t.stop());
    pttStream = null; pttRec = null;
  };
  /** Decode the recorded clip and re-encode as 16k mono WAV; null when the phone cannot decode it. */
  const clipToWav = async (blob: Blob): Promise<Blob | null> => {
    try {
      // Safari < 14.1 exposes only the webkit-prefixed constructor; lib.dom cannot express it.
      const w = window as Window & { webkitAudioContext?: typeof AudioContext };
      const Ctor = typeof AudioContext !== "undefined" ? AudioContext : w.webkitAudioContext;
      if (!Ctor) return null;
      const ctx = new Ctor();
      try {
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        const chans: Float32Array[] = [];
        for (let c = 0; c < decoded.numberOfChannels; c++) chans.push(decoded.getChannelData(c));
        const mono = downmixMono(chans);
        const wav = encodeWavPcm16(resampleLinear(mono, decoded.sampleRate, WHISPER_SAMPLE_RATE), WHISPER_SAMPLE_RATE);
        return new Blob([wav], { type: "audio/wav" });
      } finally { void ctx.close(); }
    } catch { return null; }
  };
  const blobB64 = (blob: Blob): Promise<string> => {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result).split(",")[1] ?? "");
    rd.onerror = () => reject(rd.error);
    rd.readAsDataURL(blob);
    return promise;
  };
  const pttStart = async (): Promise<void> => {
    // P-PWA-FOCUS.1: audio rides the MASTER prompt frame and the lane wire has no audio field, so a focused
    // lane offers no mic at all (render() hides the button). Re-checked here: a hold that began before the
    // switch must not end up talking to the master behind the user's back.
    if (pttRec || guestReadOnly || focus !== "master") return;
    try {
      pttStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch { $("bs-summary").textContent = "microphone blocked"; return; }
    pttChunks = [];
    pttStartedAt = Date.now();
    pttRec = new MediaRecorder(pttStream);
    pttRec.ondataavailable = (e) => { if (e.data.size) pttChunks.push(e.data); };
    pttRec.onstop = async () => {
      const held = Date.now() - pttStartedAt;
      const raw = new Blob(pttChunks, { type: pttRec?.mimeType || "audio/webm" });
      pttCleanup();
      if (held < 350 || raw.size < 1200) return; // a tap / silence - nothing to send
      const wav = await clipToWav(raw);
      const clip = wav ?? raw; // raw fallback keeps cloud STT working when decode fails
      const b64 = await blobB64(clip).catch(() => "");
      if (!b64) return;
      if (guest?.sendPrompt("", undefined, { b64, mime: wav ? "audio/wav" : (raw.type || "audio/webm") })) {
        const echo = "[voice message]";
        selfEchoes.push(echo);
        items = [...items, { kind: "user", text: echo }];
        render(guest.view());
        $("catchup").hidden = true;
      }
    };
    pttRec.start();
    pttBtn.classList.add("rec");
  };
  pttBtn.addEventListener("pointerdown", (ev) => { ev.preventDefault(); pttBtn.setPointerCapture(ev.pointerId); void pttStart(); });
  pttBtn.addEventListener("pointerup", pttStop);
  pttBtn.addEventListener("pointercancel", pttStop);
  pttBtn.addEventListener("contextmenu", (ev) => ev.preventDefault()); // long-press must not open a menu on iOS

  // ---- P-REMOTE.14: OPTIONAL device-native dictation, BESIDE push-to-talk (never instead of it) ----
  // The phone's own recognizer types into the composer and only TEXT is sent. Whether that is allowed at all
  // is decided by the pure policy (device_stt_policy.ts) from a runtime probe PLUS the host's posture, so a
  // CUI + lockdown session can never reach a cloud recognizer. Nothing auto-sends: the transcript lands in the
  // composer for the user to read, because iOS interim results are unreliable and an unreviewed prompt is
  // worse than one extra tap.
  // P-REMOTE.15: dictation is a ROW in the MORE menu now, not a third round button in the composer. Its
  // recording pulse rides the MORE control (the row that opened it), so there is still exactly one visible
  // recording animation in the app.
  const dictateItem = $("mi-dictate") as HTMLButtonElement;
  const moreBtn = $("more-btn") as HTMLButtonElement;
  const sttSheet = $("stt-sheet");
  const sttLang = navigator.language || "en-US";
  let sttCap: SttCapability | null = null; // the browser probe, cached for the tab's lifetime
  let sttDecision: SttDecision | null = null;
  let sttPosture = ""; // the host posture the cached decision was made for ("" = not decided yet)
  let sttSeq = 0; // guards against a slow probe applying a decision for an already-stale posture
  let sttCloudOk = false; // THIS session's explicit cloud consent - never persisted, reset on every connect
  let dictation: { stop: () => void } | null = null;
  let dictationBase = ""; // composer text before dictation began, so interim results replace instead of repeat
  let dictationYielded = false; // a push-to-talk hold ended dictation: land the text, but keep the keyboard shut
  let dictatedText = ""; // the last transcript this phone produced, so the sttSource label cannot outlive it
  let sheetKind: "install" | "cloud" | "voice" = "install";

  /** P-REMOTE.15: the SHORT inline line - what is happening right now, one line, ellipsized. Never the policy
   *  explanation: that is long-form prose and belongs to the "?" sheet. */
  const setVoiceStatus = (msg: string, tone: "info" | "warn" = "info"): void => {
    voiceStatus = msg;
    const el = $("voice-status");
    el.textContent = msg; // host/browser text stays textContent, never innerHTML
    el.dataset.tone = tone;
    syncComposerActions();
  };
  /** The dictate row's own copy, derived from the live state: stop-while-listening, or what tapping it does
   *  and what that costs. The caution wording is here, at the point of use, and in full in the "?" sheet. */
  const syncDictateItem = (): void => {
    const listening = dictation !== null;
    const mode = sttDecision?.mode;
    const label = listening ? "Stop dictating" : mode === "install-first" ? "Set up dictation on this phone" : "Dictate on this phone";
    const detail = listening ? "the words heard so far stay in the box"
      : mode === "install-first" ? "needs a one-time on-device language pack"
      : mode === "device-cloud" ? "caution: transcribed in the vendor's cloud"
      : "on-device: the audio never leaves this phone";
    $("mi-dictate-l").textContent = label;
    $("mi-dictate-d").textContent = detail;
    dictateItem.setAttribute("aria-label", label);
    dictateItem.setAttribute("aria-pressed", listening ? "true" : "false");
  };
  const endDictation = (): void => {
    const live = dictation;
    dictation = null; // null FIRST: stopping delivers the final transcript synchronously, which re-enters here
    live?.stop();
    moreBtn.classList.remove("rec");
    moreBtn.removeAttribute("data-stt");
    syncDictateItem();
  };
  const applySttDecision = (): void => {
    const d = sttDecision;
    // The long-form explanation moves to the "?" sheet; the amber "?" keeps the caution visible in the row.
    voiceRisk = d?.mode === "device-cloud";
    voiceInfo = !d ? "" : d.mode === "device-cloud" ? d.warn : d.mode === "host" ? d.reason : d.note;
    $("help-btn").dataset.tone = voiceRisk ? "warn" : "info";
    if (!d || d.mode === "host") {
      endDictation();
      dictateItem.hidden = true; // a dead control is worse than none: the "?" sheet says why
      dictateItem.removeAttribute("data-stt");
      sttSheet.hidden = true; // a posture flip must also kill an open consent sheet (fail-closed)
      setVoiceStatus("");
      syncMoreBtn();
      return;
    }
    dictateItem.hidden = false;
    dictateItem.dataset.stt = d.mode === "device-local" ? "local" : d.mode === "install-first" ? "offer" : "cloud";
    syncDictateItem();
    syncMoreBtn();
  };
  // Re-decided on join AND on every posture change: the host can flip CUI mode or lockdown mid-session, and
  // the cloud path must die the moment it does. `reprobe` re-runs the browser probe (after a pack install).
  const refreshStt = async (reprobe: boolean): Promise<void> => {
    if (!guest) return;
    const posture = guest.posture(); // fail-closed { cui: true, lockdown: true } until a welcome/state frame lands
    sttPosture = `${posture.cui}/${posture.lockdown}`; // set synchronously, so the render hook cannot re-enter
    const seq = ++sttSeq;
    if (reprobe || !sttCap) sttCap = await probeSttCapability(sttLang);
    if (seq !== sttSeq) return; // a newer posture landed while probing: its decision wins
    sttDecision = decideSttMode(sttCap, posture);
    applySttDecision();
  };
  const beginDictation = (mode: "device-local" | "device-cloud"): void => {
    if (dictation || guestReadOnly) return;
    dictationBase = promptInput.value;
    pendingSttSource = mode;
    moreBtn.classList.add("rec");
    if (mode === "device-cloud") moreBtn.dataset.stt = "cloud";
    syncDictateItem();
    setVoiceStatus(
      mode === "device-local" ? "Listening on this phone - open the menu to stop." : "Listening - your browser vendor is transcribing this.",
      mode === "device-local" ? "info" : "warn",
    );
    dictation = startDictation({
      lang: sttLang,
      processLocally: mode === "device-local",
      onInterim: (text) => { promptInput.value = mergeTranscript(dictationBase, text); autosize(); },
      onFinal: (text) => {
        dictatedText = text;
        promptInput.value = mergeTranscript(dictationBase, text);
        endDictation();
        autosize();
        if (!dictationYielded) promptInput.focus(); // review, edit, then Send - a transcript is NEVER auto-sent
        syncComposerActions();
        setVoiceStatus("Read it over, then tap Send.");
      },
      // A mid-session failure falls back to the path that always works: hold-to-talk, transcribed on the desktop.
      // The failure DETAIL is long, so it goes to the "?" sheet (which the amber "?" now points at) and the
      // inline line stays one short sentence naming the way out.
      onError: (message) => {
        endDictation();
        pendingSttSource = null; dictatedText = "";
        voiceInfo = `${message} Hold the mic button instead and your desktop will transcribe the recording offline.`;
        voiceRisk = true;
        $("help-btn").dataset.tone = "warn";
        setVoiceStatus("Dictation failed - hold the mic instead.", "warn");
      },
    });
  };

  // The sheets. Every explanation is a WHOLE block paragraph (AGENTS.md #11) - prose never becomes flex
  // items - and the cloud consent is spelled out in full because it is the only path where audio leaves.
  const SHEET_COPY: Record<"install" | "cloud", { title: string; go: string; body: string[] }> = {
    install: {
      title: "Dictate on this phone",
      go: "Install",
      body: ["Your phone can turn speech into text without sending the audio anywhere, but it needs a one-time language pack first. It downloads once over your current connection, and after that dictation runs entirely on this phone, even with no network at all."],
    },
    cloud: {
      title: "This browser transcribes in the cloud",
      go: "Dictate anyway",
      body: [
        "If you dictate here, this browser sends your recorded speech to its vendor's servers to be turned into text. The audio leaves your phone.",
        "Hold-to-talk sends the recording to your own desktop instead, which transcribes it offline with its own engine, so your voice stays between your two machines.",
        "Choosing to dictate applies to this session only. It is never remembered: reload or reopen the app and you will be asked again.",
      ],
    },
  };
  // P-REMOTE.15: the "?" sheet - the voice explanation that used to be crammed under the composer in small
  // grey type, with room to actually read it. Built at open time: the first paragraph is whatever the CURRENT
  // decision (or the last failure) has to say, so the sheet is never stale.
  const voiceSheetBody = (): string[] => {
    const paras: string[] = [];
    if (voiceInfo) paras.push(voiceInfo);
    paras.push("Hold the mic button to talk. This phone records the clip, your own desktop turns it into text offline with its own engine, and the audio never goes anywhere else.");
    if (!dictateItem.hidden) paras.push("The composer's menu can also let this phone type for you: its own recognizer puts the words straight into the message box, so you read them over first. A transcript is never sent on its own - you always tap Send.");
    paras.push("Either way the words reach your desktop labelled with where they were transcribed, so the shared transcript and its audit trail show whether the phone or the desktop did the work.");
    return paras;
  };
  const openSttSheet = (kind: "install" | "cloud" | "voice"): void => {
    sheetKind = kind;
    const copy = kind === "voice"
      ? { title: "Your voice on this phone", go: "Got it", alt: "", body: voiceSheetBody() }
      : { ...SHEET_COPY[kind], alt: "Use hold-to-talk instead" };
    $("stt-sheet-title").textContent = copy.title;
    const body = $("stt-sheet-body");
    body.textContent = "";
    for (const para of copy.body) {
      const p = document.createElement("p");
      p.className = "stt-p";
      p.textContent = para;
      body.append(p);
    }
    const go = $("stt-sheet-go") as HTMLButtonElement;
    go.textContent = copy.go;
    go.disabled = false;
    // The alternative action only exists where there IS one: the info sheet just closes.
    const alt = $("stt-sheet-alt") as HTMLButtonElement;
    alt.hidden = copy.alt.length === 0;
    if (copy.alt) alt.textContent = copy.alt;
    $("stt-sheet-note").textContent = "";
    $("stt-sheet-note").hidden = true;
    sttSheet.hidden = false;
  };
  $("stt-sheet-x").addEventListener("click", () => { sttSheet.hidden = true; });
  $("stt-sheet-alt").addEventListener("click", () => {
    sttSheet.hidden = true;
    setVoiceStatus("Hold the mic - your desktop transcribes it offline.");
  });
  // P-REMOTE.15: the composer's "?" - one tap to the whole explanation, instead of a paragraph in the row.
  $("help-btn").addEventListener("click", () => { closeMenu(); openSttSheet("voice"); });
  $("stt-sheet-go").addEventListener("click", () => {
    if (sheetKind === "voice") { sttSheet.hidden = true; return; } // "Got it" - nothing to grant
    if (sheetKind === "cloud") {
      sttCloudOk = true; // session-only: `connect` clears it, and nothing writes it to storage
      sttSheet.hidden = true;
      beginDictation("device-cloud");
      return;
    }
    const go = $("stt-sheet-go") as HTMLButtonElement;
    const note = $("stt-sheet-note");
    go.disabled = true;
    note.hidden = false;
    note.textContent = "Downloading the on-device language pack\u2026";
    void (async () => {
      if (!await installSttLanguage(sttLang)) {
        go.disabled = false;
        note.textContent = "That download did not finish. Try again on a better connection, or use hold-to-talk.";
        return;
      }
      await refreshStt(true); // the pack is in: re-probe, so "available" is PROVEN rather than assumed
      if (sttDecision?.mode === "device-local") {
        sttSheet.hidden = true;
        beginDictation("device-local");
        return;
      }
      go.disabled = false;
      note.textContent = "The language pack is not ready yet. Wait a moment and tap Install again, or use hold-to-talk.";
    })();
  });
  dictateItem.addEventListener("click", () => {
    closeMenu();
    if (dictation) { endDictation(); return; } // tap again = stop; whatever was heard stays in the composer
    const d = sttDecision;
    if (!d || d.mode === "host") return;
    if (d.mode === "device-local") { beginDictation("device-local"); return; }
    if (d.mode === "install-first") { openSttSheet("install"); return; }
    if (sttCloudOk) beginDictation("device-cloud"); else openSttSheet("cloud"); // first tap ALWAYS asks
  });
  // Holding push-to-talk while dictating would fight over the microphone: the hold wins, dictation lands its
  // text and stops. Additive listener - the push-to-talk path above is untouched.
  pttBtn.addEventListener("pointerdown", () => {
    if (!dictation) return;
    dictationYielded = true;
    endDictation();
    dictationYielded = false;
  });
  // Provenance stays honest: once the user has typed the dictated words back out of the composer, the send is
  // no longer a transcript, so it must not carry an sttSource claim into the host's audit trail.
  promptInput.addEventListener("input", () => {
    if (pendingSttSource && dictatedText && !promptInput.value.includes(dictatedText)) { pendingSttSource = null; dictatedText = ""; }
  });

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
  /** Rendered stream length for a target: the replayed prior turns plus the folded live items. This is the
   *  unit `seen`/`firstUnseen` are measured in, so it MUST match what render() hands renderTranscript. */
  const streamLen = (target: string): number => {
    const its = target === "master" ? items : targetItems.get(target) ?? [];
    const pri = target === "master" ? (guest?.view().transcript ?? []) : targetPrior.get(target) ?? [];
    return pri.length + its.filter((i) => i.kind !== "fleet-lanes" && i.kind !== "processes").length;
  };

  /** Every conversation the phone is tracking, for planSync. Master is always present; a lane appears once
   *  it has been watched at least once (before that the phone has nothing of its stream to have missed). */
  const progress = (): TargetProgress[] => {
    const snap = items.find((i) => i.kind === "fleet-lanes");
    const lanes = snap?.kind === "fleet-lanes" ? snap.lanes : [];
    const out: TargetProgress[] = [{ target: "master", label: "main session", total: streamLen("master"), seen: seen.get("master") ?? 0 }];
    for (const id of new Set([...targetPrior.keys(), ...targetItems.keys()])) {
      out.push({ target: id, label: lanes.find((l) => l.id === id)?.name || id, total: streamLen(id), seen: seen.get(id) ?? 0 });
    }
    return out;
  };

  const showSyncCard = (plan: SyncPlan, actionable: boolean): void => {
    $("catchup-label").textContent = plan.summary;
    ($("sync-go") as HTMLButtonElement).hidden = !actionable;
    const body = $("catchup-body");
    body.textContent = "";
    // One row per conversation with a backlog, tappable to jump there. This is the "including between Fleet
    // Agents" half: the summary alone would tell you something moved without telling you WHERE.
    for (const u of plan.unseen) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cu-jump";
      row.dataset.jump = u.target;
      const name = document.createElement("span");
      name.className = "cu-jump-n";
      name.textContent = u.target === focus ? `${u.label} (here)` : u.label; // host-authored name stays textContent
      const n = document.createElement("span");
      n.className = "cu-jump-c";
      n.textContent = `${u.count}`;
      row.append(name, n);
      body.append(row);
    }
    catchup.removeAttribute("data-open");
    body.hidden = true;
    $("catchup-bar").setAttribute("aria-expanded", "false");
    catchup.hidden = false;
  };

  /** Apply a plan: draw + scroll to the unseen boundary in the FOCUSED target when it has one, and leave the
   *  card up for the others. It deliberately does NOT repoint the composer on its own: silently moving which
   *  agent the input is aimed at, because a different lane happened to be busier, is how a prompt lands on
   *  the wrong agent. The card's rows are one tap away instead. */
  const applySync = (plan: SyncPlan): void => {
    const here = plan.unseen.find((u) => u.target === focus);
    markFrom = here ? here.firstUnseen : -1;
    pendingSync = null;
    const others = plan.unseen.filter((u) => u.target !== focus);
    if (others.length) showSyncCard(plan, false); else catchup.hidden = true;
    if (guest) render(guest.view());
    // Scroll AFTER the repaint so the marker exists; centred, because landing it at the very top hides the
    // last thing the user HAD seen, which is the context that makes the new run readable.
    const mark = $("transcript").querySelector("[data-sync-mark]");
    if (mark) mark.scrollIntoView({ block: "center" });
  };

  const render = (view: GuestView): void => {
    $("hdr").innerHTML = renderHeader(view.header);
    // P-REMOTE.11: the live status shows in the condensed bottom strip's always-visible bar (dot + label).
    // P-REMOTE.13: the HOURLY Cloud-Run flap stays INVISIBLE while younger than the grace window - the
    // socket buffers sends and re-auths on its own; only a drop that outlives the grace shows amber.
    if (view.phase === "reconnecting") {
      if (!flapAt) {
        flapAt = Date.now();
        // Repaint once at grace expiry, so a REAL outage surfaces without waiting for the next frame.
        window.setTimeout(() => { if (flapAt && guest) render(guest.view()); }, RECONNECT_GRACE_MS + 100);
      }
    } else flapAt = 0;
    const st = presentedStatus(view, flapAt, Date.now());
    $("bs-summary").textContent = st.text;
    $("bs-dot").dataset.tone = st.tone;
    const tr = $("transcript");
    // P-PWA-FOCUS.1: the transcript shows the FOCUSED conversation - the master's prior turns + master items,
    // or the focused lane's `lane-sync` replay + that lane's items. Everything below this line that reads
    // `items`/`view.transcript` is master-scoped on purpose (status, catch-up, report, fleet, processes).
    const shown = focus === "master" ? items : targetItems.get(focus) ?? [];
    const prior = focus === "master" ? view.transcript : targetPrior.get(focus) ?? [];
    // P-PWA-FLEET.1: fleet/process snapshots render in their strips above the transcript, never inline.
    // P-PWA-FOCUS.2: `markFrom` draws the "new since you looked away" boundary for THIS target. It is passed
    // only while it is genuinely this target's boundary, so switching focus cannot carry another
    // conversation's marker across.
    tr.innerHTML = renderTranscript(prior, shown.filter((i) => i.kind !== "fleet-lanes" && i.kind !== "processes"), markFrom >= 0 ? markFrom : undefined);
    // Re-apply the user's Thinking open/closed choices - the innerHTML repaint above resets every <details>.
    for (const d of Array.from(tr.querySelectorAll<HTMLDetailsElement>("details[data-think]"))) {
      const want = thinkIntent.get(`${focus}:${d.dataset.think ?? "-1"}`);
      if (want !== undefined) d.open = want;
    }
    // P-PREVIEW-PWA.1: hydrate preview-snapshot thumbnails - the data URL is set as an <img> PROPERTY here,
    // never inlined into the transcript HTML (keeps the re-rendered markup small + text-safe).
    for (const it of shown) if (it.kind === "preview") { const im = tr.querySelector(`.cu-shot-btn[data-shot="${it.id}"] .cu-shot-img`) as HTMLImageElement | null; if (im) im.src = it.image; }
    // P-PWA-FOCUS.1: the bar naming the focused lane, and the one way back. The master composer and a lane's
    // conversation are otherwise identical on screen, and a prompt sent to the wrong agent cannot be recalled.
    const focusbar = $("focusbar");
    if (focus === "master") {
      focusbar.hidden = true;
      promptInput.placeholder = "Message your agent\u2026";
      promptInput.setAttribute("aria-label", "Message your agent");
    } else {
      const name = laneName(focus);
      $("focus-name").textContent = name;
      focusbar.hidden = false;
      promptInput.placeholder = `Message ${name}\u2026`;
      promptInput.setAttribute("aria-label", `Message lane ${name}`);
    }
    // Hold-to-talk sends AUDIO, which only the master prompt frame carries: no mic while a lane is focused.
    ($("ptt-btn") as HTMLButtonElement).hidden = focus !== "master";
    // drive controls appear only for an EDIT (full-link) guest the host accepts as writable
    $("composer").hidden = view.readOnly || view.phase === "ended";
    guestReadOnly = view.readOnly || view.phase === "ended"; // P-PREVIEW-PWA.2: gates the markup send-back
    // The composer's own controls (Queue label, Stop, Push now, Check in) describe the turn they would act
    // on, so they follow the FOCUS: master-scoping them would leave a working lane unstoppable from here.
    composerStreaming = shown.some((i) => i.kind === "answer" && i.streaming);
    syncComposerActions();
    // P-REMOTE.14: the host's posture rides on welcome/state frames, so re-decide device dictation whenever it
    // changes (a flip to CUI + lockdown must revoke a cloud recognizer immediately). Also the first decision
    // of a session, since `connect` resets the cached key to "".
    if (guestReadOnly) endDictation(); // the composer just vanished (session ended / view-only): no hot mic
    if (guest) {
      const p = guest.posture();
      if (`${p.cui}/${p.lockdown}` !== sttPosture) void refreshStt(false);
    }
    // P-PWA-FLEET.1: the strips render the LATEST folded snapshots.
    renderFleetStrip();
    renderProcsStrip();
    // P-REMOTE.15: mid-turn, the ONE send button relabels to Queue (same PromptFrame path - the host stages
    // it until the turn ends) and grows a caret holding Push now; Stop and Check in appear only mid-turn, so
    // an idle composer carries no dead controls at all.
    $("send-label").textContent = composerStreaming ? "Queue" : "Send";
    $("send-btn").setAttribute("aria-label", composerStreaming ? "Queue this message for after the turn" : "Send message");
    // `.hidden` is an HTMLElement property: on an SVG element it sets a dead JS field and the [hidden] rule
    // never matches, so the icons MUST be toggled through the real attribute.
    $("send-icon-send").toggleAttribute("hidden", composerStreaming);
    $("send-icon-queue").toggleAttribute("hidden", !composerStreaming);
    $("send-group").toggleAttribute("data-split", composerStreaming);
    ($("send-more") as HTMLButtonElement).hidden = !composerStreaming;
    ($("abort-btn") as HTMLButtonElement).hidden = !composerStreaming;
    ($("mi-checkin") as HTMLButtonElement).hidden = !composerStreaming;
    if (!composerStreaming && openMenuId === "send-menu") closeMenu(); // the turn ended under an open menu
    syncMoreBtn();
    // P-COLLAB.14: the model + already-used-folder pickers (edit guest only). renderControls returns "" for a
    // view guest, so hide the row whenever it's empty.
    const controlsHtml = renderControls(view);
    const controls = $("controls");
    controls.innerHTML = controlsHtml;
    controls.hidden = !controlsHtml;
    // P-REMOTE.9: the Run report button appears once a turn has completed.
    ($("report-btn") as HTMLButtonElement).hidden = !lastReport;
    // P-PWA-FOCUS.2: only the FOCUSED target is marked seen, and only while the page is actually visible.
    // That is the whole mechanism: a lane nobody is looking at keeps its backlog instead of being forgiven
    // by a repaint the user never saw.
    if (document.visibilityState === "visible") seen.set(focus, streamLen(focus));
    const scroller = $("transcript");
    // Auto-scroll to the newest ONLY when not showing an unseen boundary: jumping to the bottom is exactly
    // what loses the place the user asked to be returned to.
    if (markFrom < 0) scroller.scrollTop = scroller.scrollHeight;
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
  // ADR-0227 follow-up: an admin comp grant sets the `premium` claim server-side with NO checkout moment,
  // so this screen would otherwise sit on a stale (pre-grant) cached token for up to an hour. One-shot per
  // sign-in: on first mount, force a token refresh; if the claim already landed, connect instead of
  // paywalling. One-shot so a relay that still refuses a fresh entitled token can never loop connect->4403.
  let autoRechecked = false;
  const showSubscribe = (): void => {
    $("sub-email").textContent = currentEmail ?? "";
    subHint.textContent = "";
    subscribeBtn.disabled = false;
    checkoutStarted = false;
    continueBtn.hidden = true;
    show("subscribe");
    if (autoRechecked) return;
    autoRechecked = true;
    void (async () => {
      subHint.textContent = "Checking your access…";
      let active = false;
      try { active = entitlementActive(await auth.getIdToken(true)); } catch { /* offline refresh: stay on the paywall */ }
      if ($("subscribe-view").hidden) return; // the user already navigated away
      subHint.textContent = "";
      if (active) connect();
    })();
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
        items = []; thinkIntent.clear(); lastReport = null; turnStart = 0; selfEchoes.length = 0;
        // P-PWA-FOCUS.1: a fresh guest watches the master, so the phone must agree with it. Anything else
        // would point the composer at a lane this socket never subscribed to.
        focus = "master"; targetItems.clear(); targetPrior.clear();
        // P-REMOTE.14: a fresh session re-decides dictation from scratch, and cloud consent NEVER carries over.
        endDictation();
        sttDecision = null; sttPosture = ""; sttCloudOk = false; pendingSttSource = null; dictatedText = "";
        applySttDecision();
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
          // P-PWA-FOCUS.1: a watched lane's events fold into THAT lane's own list. `foldEvent` is pure and
          // per-list, so the lane's stream can never touch the master transcript. A repaint happens only when
          // the lane is the one on screen - a stale watch's tail must not steal the view back.
          onLaneEvent: (laneId, e) => {
            // `lane-error` now has its own fold case + red `lane-fail` chip in pwa_view, so a crashed lane
            // shows in its conversation in order, and never as the security gate's `block`.
            targetItems.set(laneId, foldEvent(targetItems.get(laneId) ?? [], e));
            if (focus === laneId) render(guest!.view());
          },
          // The host's replay for a lane we just started watching. It is AUTHORITATIVE, so it replaces that
          // lane's live items: re-watching a lane would otherwise show every turn twice (once from the
          // previous watch window, once from this replay).
          onLaneSync: (laneId, transcript) => {
            targetPrior.set(laneId, transcript);
            targetItems.set(laneId, []);
            if (focus === laneId) render(guest!.view());
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
      subHint.textContent = "Not active yet - it can take a few seconds after payment. Tap Continue again.";
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
  // P-PWA-FOCUS.2: the screen locked. Only the TIME is snapshotted; the per-target `seen` map is already the
  // record of what had been looked at, so there is nothing else to freeze.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    const plan = planSync(progress(), focus, hiddenAt ? Date.now() - hiddenAt : 0);
    hiddenAt = 0;
    if (!plan.totalUnseen) { catchup.hidden = true; return; } // nothing moved: no card, no scroll, no noise
    // A glance (60s or less) syncs itself; a real absence offers the choice, because silently yanking the
    // scroll position after ten minutes away is as disorienting as losing the place was.
    if (plan.auto) applySync(plan); else { pendingSync = plan; showSyncCard(plan, true); }
  });
  $("sync-go").addEventListener("click", (ev) => {
    ev.stopPropagation(); // the button lives inside the card's own toggle bar
    if (pendingSync) applySync(pendingSync);
  });
  // A card row jumps to that conversation and lands on ITS boundary, which is the cross-lane half of the ask.
  $("catchup-body").addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement | null)?.closest("[data-jump]") as HTMLElement | null;
    if (!row?.dataset.jump) return;
    const target = row.dataset.jump;
    const at = seen.get(target) ?? 0;
    if (target !== focus) setFocus(target);
    markFrom = at;
    if (guest) render(guest.view());
    const mark = $("transcript").querySelector("[data-sync-mark]");
    if (mark) mark.scrollIntoView({ block: "center" });
  });
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
    autoRechecked = false; // each sign-in gets one fresh auto-recheck on the Subscribe screen
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
