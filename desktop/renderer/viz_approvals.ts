// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_approvals.ts - P-VIZ.APPROVE1 (ADR-0655): tool-call approvals inside Visualize.
//
// Three surfaces over the stage, all fed by viz_model's per-node approvals (pendingApprovals, triage):
//   - a badge over every node with an open ask (2D and 3D alike: it rides the node's screen box every frame, like the
//     artifact chips), amber, or red for a command, a website, a local file in the browser or a flagged danger. It
//     pulses; a fresh ask pulses harder for a moment.
//   - the pop-out a badge opens, beside its node and following it (viz_panel_place, the node panel's rule): the tool,
//     the summary and Approve, Auto, Deny. Enter (or A) approves, D denies, Esc closes (the view's key handler).
//   - the triage strip at the top of the stage: a pill with the open asks by type and the fleet's working, waiting
//     and failed counts; expanded, one row per ask with Jump, Approve and Deny. It folds back after 4 s idle.
//
// Answers reuse the existing controls' paths and their fail-closed rules: a lane's Approve and Deny are the grid
// card's fleetAnswer (a remote lane refuses a bare allow, so the ask stays open and the pop-out says why); a lane's
// Auto goes through the grid's own risk modal (autoRiskModal: only its Accept sends acceptRisk) and then approves;
// Main's choices go through its chat card (`respondMain`, the card's own option reading), and Auto there is the
// ask's standing "always allow" option when it offers one (never the all-commands or all-sites danger option),
// else hidden. In the ?vizDemo=1 feed every answer resolves locally (VizDemo.answer) and every surface says DEMO.

import { el } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { tipValue } from "./tip_text.ts";
import type { LucidBridge } from "./bridge.ts";
import type { VizDemo } from "./viz_demo.ts";
import { askChoice, askOwner, HUB_ID, pendingApprovals, resolveApproval, triage, type AskType, type VizApproval, type VizState, type VizTriage } from "./viz_model.ts";
import { placePanel, type PanelSide } from "./viz_panel_place.ts";

export interface ApprovalsDeps {
  stage: HTMLElement;
  model: () => VizState | null;
  demo: () => VizDemo | null;
  boxOf: (id: string) => { x: number; y: number; r: number } | null;
  fleetAnswer: LucidBridge["fleetAnswer"];
  fleetAuto: LucidBridge["fleetAuto"];
  /** fleet_grid's full auto-mode risk modal: `onAccept` runs only on its Accept. */
  autoRiskModal: (onAccept: (allLanes: boolean) => void) => void;
  /** Answer Main's ask through its chat card; null is a deny. */
  respondMain: (id: string, optionId: string | null) => void;
  /** Point the camera at the node (Jump). */
  jump: (nodeId: string) => void;
  /** The pop-out is opening: the node panel makes way. */
  onOpen: () => void;
  /** An answer went out: re-read the fleet now. */
  refresh: () => void;
}

export interface ApprovalsView {
  /** Repaint the badges, the strip and an open pop-out (signature-checked; call every tick). */
  sync(now: number): void;
  /** These asks just arrived: their badges pulse harder for a moment. */
  arrived(ids: readonly string[]): void;
  /** Open the pop-out on the node's oldest open ask (a badge tap, Jump). */
  open(nodeId: string): void;
  close(): void;
  /** Esc: closes the pop-out (true), or folds the strip while focus is in it (true); else false. */
  escape(): boolean;
  /** Read-only state for the demo probe. */
  probe(): ApprovalsProbe;
  destroy(): void;
}

export interface ApprovalsProbe {
  pending: { id: string; node: string; from: string; tool: string; type: AskType; danger: boolean; badge: { x: number; y: number; w: number; h: number } | null }[];
  triage: VizTriage;
  pill: { text: string; count: number; box: { x: number; y: number; w: number; h: number } | null };
  expanded: boolean;
  pop: { open: boolean; id: string | null; node: string | null; box: { x: number; y: number; w: number; h: number } | null };
}

/** The strip folds back after this long without a pointer move, key or focus change in it. */
export const STRIP_IDLE_MS = 4000;
/** A fresh ask's badge pulses harder this long. */
const FRESH_MS = 2400;
const TYPE_LABEL: Record<AskType, string> = { tool: "tool", exec: "command", egress: "network", file: "file" };

const age = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
const rectOf = (n: Element | null): { x: number; y: number; w: number; h: number } | null => {
  if (!n || (n as HTMLElement).hidden) return null;
  const r = n.getBoundingClientRect();
  return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null;
};

export function mountApprovals(d: ApprovalsDeps): ApprovalsView {
  const { stage } = d;
  const badges = new Map<string, HTMLButtonElement>();
  const fresh = new Map<string, number>(); // node id -> pulse until
  const busy = new Set<string>(); // ask ids with an answer in flight
  let raf = 0;
  let stripSig = "";
  let expanded = false;
  let idleTimer = 0;
  let pop: { node: string; id: string | null; side: PanelSide | null; sig: string; note: string } | null = null;

  const strip = el(`<div class="viz-tri" data-viz-tri hidden>
    <button type="button" class="viz-tri-pill" data-viz-tri-pill aria-expanded="false"></button>
    <div class="viz-tri-list" data-viz-tri-list role="list" hidden></div>
  </div>`);
  const pill = strip.querySelector("[data-viz-tri-pill]") as HTMLButtonElement;
  const list = strip.querySelector("[data-viz-tri-list]") as HTMLElement;
  const popEl = el(`<div class="viz-ask" data-viz-ask hidden role="dialog" aria-modal="false">
    <div class="viz-ask-card">
      <div class="viz-ask-h">
        <i class="viz-ask-dot" aria-hidden="true">${icon("shield", 13)}</i>
        <div class="viz-ask-id"><b data-viz-ask-tool></b><span data-viz-ask-sub></span></div>
        <b class="viz-demo-tag" data-viz-ask-demo hidden>DEMO</b>
        <button type="button" class="viz-panel-btn" data-viz-ask-close aria-label="Close (the ask stays open)">${icon("close", 12)}</button>
      </div>
      <p class="viz-ask-sum" data-viz-ask-sum></p>
      <div class="viz-ask-acts">
        <button type="button" class="viz-ask-btn ok" data-viz-ask-act="once">${icon("check", 12)}<span>Approve</span></button>
        <button type="button" class="viz-ask-btn" data-viz-ask-act="auto">${icon("bolt", 12)}<span>Auto</span></button>
        <button type="button" class="viz-ask-btn no" data-viz-ask-act="deny">${icon("close", 12)}<span>Deny</span></button>
      </div>
      <p class="viz-ask-note" data-viz-ask-note role="status" hidden></p>
    </div>
  </div>`);
  const q = <T extends HTMLElement>(sel: string): T => popEl.querySelector(sel) as T;
  stage.append(strip, popEl);

  const nameOf = (m: VizState, id: string): string => (id === HUB_ID ? "Main" : m.nodes.get(id)?.name ?? id);
  /** The open ask the pop-out shows: the one it was opened on while it is open, else the node's oldest. */
  const popAsk = (m: VizState): VizApproval | null => {
    if (!pop) return null;
    const own = m.nodes.get(pop.node)?.approvals ?? [];
    return own.find((a) => a.id === pop?.id) ?? own[0] ?? null;
  };

  // ----------------------------------------------------------------------------------------- answers

  async function settle(a: VizApproval, choice: "once" | "auto" | "deny"): Promise<void> {
    const m = d.model();
    if (!m || busy.has(a.id)) return;
    const demo = d.demo();
    let note = "";
    busy.add(a.id);
    paintPop(true);
    try {
      if (demo) {
        demo.answer(a.node, Date.now()); // DEMO: local only, never the real answer routes
        resolveApproval(m, a.id);
      } else if (a.options) {
        const opt = askChoice(a.options, choice === "auto" ? "always" : choice);
        if (choice !== "deny" && !opt) note = "This ask has no such choice. Answer it in the chat.";
        else { d.respondMain(a.id, opt?.optionId ?? null); resolveApproval(m, a.id); }
      } else {
        const r = await d.fleetAnswer(a.node, choice !== "deny").catch(() => null);
        if (!r) note = "The engine did not answer. Nothing changed; try again.";
        else if (r.ok || choice === "deny") resolveApproval(m, a.id); // a refused deny: no ask was open any more
        else note = "Not approved. A remote agent's ask needs a verified decision from its controller, or it was already answered.";
        d.refresh();
      }
    } finally {
      busy.delete(a.id);
    }
    done(a, note);
  }

  /** An answer for `a` came back: its note (empty on success) shows if the pop-out still shows `a`. */
  function done(a: VizApproval, note: string): void {
    if (pop?.id === a.id) pop.note = note;
    paintPop(true);
    sync(Date.now());
  }

  /** Auto on a lane: the grid's risk modal, then per-lane auto-mode ON (the engine releases the open ask as an allow,
   *  unless managed policy holds it), then an explicit approve, as the grid's Allow would; that answer finding no open
   *  ask means auto-mode already released it. A refusal (a supervised or remote lane) changes nothing. */
  function autoLane(a: VizApproval): void {
    d.autoRiskModal((allLanes) => void (async () => {
      const m = d.model();
      if (!m || busy.has(a.id)) return;
      if (d.demo()) { void settle(a, "once"); return; } // DEMO: the same modal, answered locally
      busy.add(a.id); paintPop(true);
      let note = "";
      try {
        const r = await d.fleetAuto({ ...(allLanes ? {} : { laneId: a.node }), on: true, acceptRisk: true }).catch(() => null);
        if (!r?.ok) note = `Auto-mode was not turned on: ${r && "reason" in r && typeof r.reason === "string" ? r.reason : "the engine did not answer"}. Nothing changed.`;
        else if (await d.fleetAnswer(a.node, true).catch(() => null)) resolveApproval(m, a.id);
        else note = "Auto-mode is on, but the engine did not confirm this ask. It clears once the agent reports.";
        d.refresh();
      } finally {
        busy.delete(a.id);
      }
      done(a, note);
    })());
  }

  function answer(a: VizApproval, choice: "once" | "auto" | "deny"): void {
    if (choice === "auto" && a.options === null) autoLane(a);
    else void settle(a, choice);
  }

  // ----------------------------------------------------------------------------------------- pop-out

  function open(nodeId: string): void {
    const m = d.model();
    const a = m?.nodes.get(nodeId)?.approvals[0];
    if (!m || !a) return;
    d.onOpen();
    collapse();
    pop = { node: nodeId, id: a.id, side: null, sig: "", note: "" };
    popEl.hidden = false;
    paintPop(true);
    place();
    (q<HTMLButtonElement>("[data-viz-ask-act=once]")).focus({ preventScroll: true });
    kick();
  }

  function close(): void {
    if (!pop) return;
    const had = popEl.contains(document.activeElement);
    const node = pop.node;
    pop = null;
    popEl.hidden = true;
    // Back to the node's badge while it still has an ask open, else to the scene (the badge is about to go).
    const back = d.model()?.nodes.get(node)?.approvals.length ? badges.get(node) : stage.querySelector<HTMLElement>("canvas");
    if (had) back?.focus({ preventScroll: true });
  }

  function paintPop(force = false): void {
    const m = d.model();
    if (!pop || !m) return;
    const a = popAsk(m);
    if (!a) { close(); return; }
    pop.id = a.id;
    const own = m.nodes.get(pop.node)?.approvals.length ?? 0;
    const demo = !!d.demo();
    const autoOpt = a.options ? askChoice(a.options, "always") : null;
    const inFlight = busy.has(a.id);
    const sig = [a.id, own, inFlight, pop.note, demo, Math.floor((Date.now() - a.createdAt) / 1000)].join("|");
    if (!force && sig === pop.sig) return;
    pop.sig = sig;
    const via = a.from !== a.node ? ` via ${nameOf(m, a.from)}` : "";
    popEl.dataset.risk = a.danger ? "danger" : "normal";
    popEl.setAttribute("aria-label", `Approval for ${a.tool} on ${nameOf(m, a.node)}`);
    q("[data-viz-ask-tool]").textContent = a.tool;
    q("[data-viz-ask-sub]").textContent = `${nameOf(m, a.node)}${via} \u00b7 ${TYPE_LABEL[a.type]}${a.danger ? ", high risk" : ""} \u00b7 ${age(Date.now() - a.createdAt)}${own > 1 ? ` \u00b7 1 of ${own}` : ""}`;
    q("[data-viz-ask-demo]").hidden = !demo;
    q("[data-viz-ask-sum]").textContent = a.summary;
    const auto = q<HTMLButtonElement>("[data-viz-ask-act=auto]");
    // Main: Auto is the ask's standing "always allow" when it offers one, else hidden. A lane: per-lane auto-mode.
    auto.hidden = !!a.options && !autoOpt;
    const autoWhy = a.options ? (autoOpt ? `Choose "${autoOpt.name}" for this ask.` : "")
      : "Turn on full auto-mode for this agent (asks you to accept the risk first), then approve this ask.";
    auto.setAttribute("data-tip", tipValue("Auto", autoWhy));
    auto.setAttribute("aria-label", a.options ? `Auto: ${autoOpt?.name ?? ""}` : "Auto: turn on auto-mode for this agent and approve");
    q("[data-viz-ask-act=once]").setAttribute("data-tip", tipValue("Approve (Enter or A)", "Approve this ask once."));
    q("[data-viz-ask-act=deny]").setAttribute("data-tip", tipValue("Deny (D)", "Refuse this ask. The agent is told it was refused."));
    for (const b of popEl.querySelectorAll<HTMLButtonElement>("[data-viz-ask-act]")) b.disabled = inFlight;
    const note = q("[data-viz-ask-note]");
    note.textContent = pop.note;
    note.hidden = !pop.note;
  }

  function place(): void {
    if (!pop) return;
    const s = stage.getBoundingClientRect();
    const b = d.boxOf(pop.node);
    const node = b ? { x: b.x - s.left, y: b.y - s.top, r: b.r } : { x: s.width / 2, y: s.height / 2, r: 0 };
    const at = placePanel({ w: s.width, h: s.height }, { w: popEl.offsetWidth, h: popEl.offsetHeight }, node, pop.side);
    pop.side = at.side;
    popEl.style.left = `${at.left}px`; popEl.style.top = `${at.top}px`;
    popEl.dataset.side = at.side;
    popEl.style.setProperty("--viz-tail", `${at.tailY}px`);
    popEl.classList.toggle("lost", !b || at.docked);
  }

  popEl.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("[data-viz-ask-close]")) { close(); return; }
    const b = t.closest<HTMLButtonElement>("[data-viz-ask-act]");
    const m = d.model();
    const a = m ? popAsk(m) : null;
    if (b && !b.disabled && a) answer(a, b.dataset.vizAskAct as "once" | "auto" | "deny");
  });
  popEl.addEventListener("keydown", (ev) => {
    if (ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement;
    const m = d.model();
    const a = m ? popAsk(m) : null;
    if (!a || busy.has(a.id)) return;
    const k = ev.key.toLowerCase();
    // Enter approves, unless another button has focus (then Enter is that button's own click).
    const approve = (ev.key === "Enter" && !(t.matches("button") && !t.matches("[data-viz-ask-act=once]"))) || k === "a";
    if (approve) { ev.preventDefault(); answer(a, "once"); }
    else if (k === "d") { ev.preventDefault(); answer(a, "deny"); }
  });

  // ----------------------------------------------------------------------------------------- strip

  function collapse(): void {
    window.clearTimeout(idleTimer); idleTimer = 0;
    if (!expanded) return;
    const had = strip.contains(document.activeElement) && document.activeElement !== pill;
    expanded = false;
    stripSig = "";
    paintStrip();
    if (had) pill.focus({ preventScroll: true });
  }
  function armIdle(): void {
    window.clearTimeout(idleTimer);
    idleTimer = expanded ? window.setTimeout(collapse, STRIP_IDLE_MS) : 0;
  }
  for (const t of ["pointermove", "pointerdown", "keydown", "focusin", "wheel"]) strip.addEventListener(t, armIdle, { passive: true });

  function paintStrip(): void {
    const m = d.model();
    if (!m) return;
    const t = triage(m);
    const asks = pendingApprovals(m);
    const demo = !!d.demo();
    const now = Date.now();
    const show = t.total > 0 || t.working + t.waiting + t.failed > 0;
    const rows = expanded ? asks.map((a) => [a.id, a.node, a.from, a.tool, a.type, a.danger, busy.has(a.id), Math.floor((now - a.createdAt) / 1000)].join(",")).join(";") : "";
    const sig = [show, expanded, demo, t.total, t.byType.tool, t.byType.exec, t.byType.egress, t.byType.file, t.danger, t.working, t.waiting, t.failed, rows].join("|");
    if (sig === stripSig) return;
    stripSig = sig;
    strip.hidden = !show;
    strip.classList.toggle("open", expanded);
    strip.dataset.hot = t.danger ? "danger" : t.total ? "normal" : "none";
    const word = t.total === 1 ? "approval" : "approvals";
    const types = (["tool", "exec", "egress", "file"] as const).filter((k) => t.byType[k] > 0)
      .map((k) => `<span class="viz-tri-c" data-type="${k}"><i aria-hidden="true"></i>${t.byType[k]} ${TYPE_LABEL[k]}</span>`).join("");
    const states = ([["working", t.working], ["waiting", t.waiting], ["failed", t.failed]] as const)
      .map(([k, n]) => `<span class="viz-tri-c" data-st="${k}"><i aria-hidden="true"></i>${n} ${k}</span>`).join("");
    pill.innerHTML = `${icon("shield", 13)}<span class="viz-tri-n" data-viz-tri-n>${t.total} ${word}</span>${types}<span class="viz-tri-sep" aria-hidden="true"></span>${states}${demo ? `<b class="viz-demo-tag">DEMO</b>` : ""}${icon("chevronDown", 12, "viz-tri-chev")}`;
    pill.dataset.count = String(t.total);
    pill.setAttribute("aria-expanded", String(expanded));
    const typeWords = (["tool", "exec", "egress", "file"] as const).filter((k) => t.byType[k] > 0).map((k) => `${t.byType[k]} ${TYPE_LABEL[k]}`).join(", ");
    pill.setAttribute("aria-label", `${demo ? "DEMO. " : ""}${t.total} ${word} waiting${typeWords ? `: ${typeWords}` : ""}. Agents: ${t.working} working, ${t.waiting} waiting, ${t.failed} failed. ${expanded ? "Collapse" : "Show the list"}.`);
    list.hidden = !expanded;
    if (!expanded) { list.innerHTML = ""; return; }
    // The rows repaint as ages tick: a row button holding keyboard focus gets it back.
    const f = document.activeElement;
    const keep = f && list.contains(f) ? [...f.attributes].filter((x) => x.name.startsWith("data-viz-tri-")).map((x) => `[${x.name}="${CSS.escape(x.value)}"]`).join("") : "";
    list.innerHTML = asks.length ? asks.map((a) => {
      const via = a.from !== a.node ? ` via ${nameOf(m, a.from)}` : "";
      const off = busy.has(a.id) ? " disabled" : "";
      return `<div class="viz-tri-row" role="listitem" data-viz-tri-row="${esc(a.id)}" data-risk="${a.danger ? "danger" : "normal"}">
        <i class="viz-tri-dot" data-type="${a.type}" aria-hidden="true"></i>
        <span class="viz-tri-what"><b>${esc(nameOf(m, a.node))}</b>${esc(`${via} \u00b7 ${a.tool} \u00b7 ${age(now - a.createdAt)}`)}</span>
        <button type="button" class="viz-tri-btn" data-viz-tri-jump="${esc(a.node)}" aria-label="Jump to ${esc(nameOf(m, a.node))}">${icon("center", 12)}<span>Jump</span></button>
        <button type="button" class="viz-tri-btn ok" data-viz-tri-ok="${esc(a.id)}"${off}>${icon("check", 12)}<span>Approve</span></button>
        <button type="button" class="viz-tri-btn no" data-viz-tri-no="${esc(a.id)}"${off}>${icon("close", 12)}<span>Deny</span></button>
      </div>`;
    }).join("") : `<p class="viz-tri-empty">No approvals waiting.</p>`;
    if (keep) list.querySelector<HTMLElement>(keep)?.focus({ preventScroll: true });
  }

  strip.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("[data-viz-tri-pill]")) {
      expanded = !expanded;
      stripSig = "";
      paintStrip();
      armIdle();
      return;
    }
    const m = d.model();
    if (!m) return;
    const jump = t.closest<HTMLElement>("[data-viz-tri-jump]");
    if (jump?.dataset.vizTriJump) { const id = jump.dataset.vizTriJump; d.jump(id); open(id); return; }
    const ok = t.closest<HTMLButtonElement>("[data-viz-tri-ok]");
    const no = t.closest<HTMLButtonElement>("[data-viz-tri-no]");
    const id = ok?.dataset.vizTriOk ?? no?.dataset.vizTriNo;
    const a = id ? pendingApprovals(m).find((x) => x.id === id) : undefined;
    if (a && !(ok ?? no)?.disabled) answer(a, ok ? "once" : "deny");
  });

  // ----------------------------------------------------------------------------------------- badges

  function paintBadges(now: number): void {
    const m = d.model();
    if (!m) return;
    const want = new Map<string, VizApproval[]>();
    for (const n of m.nodes.values()) if (n.approvals.length && askOwner(m, n.id) === n) want.set(n.id, n.approvals);
    for (const [id, b] of [...badges]) if (!want.has(id)) { b.remove(); badges.delete(id); }
    for (const [id, asks] of want) {
      let b = badges.get(id);
      if (!b) {
        b = document.createElement("button");
        b.type = "button";
        b.className = "viz-ask-badge";
        b.dataset.vizAskBadge = id;
        stage.appendChild(b);
        badges.set(id, b);
      }
      const danger = asks.some((a) => a.danger);
      const sig = `${asks.length}|${danger}`;
      if (b.dataset.sig !== sig) {
        b.dataset.sig = sig;
        b.dataset.risk = danger ? "danger" : "normal";
        b.innerHTML = `${icon("shield", 13)}${asks.length > 1 ? `<b>${asks.length}</b>` : ""}`;
        const what = asks.length === 1 ? `${asks[0]!.tool}${danger ? ", high risk" : ""}` : `${asks.length} asks${danger ? ", one is high risk" : ""}`;
        b.setAttribute("aria-label", `${nameOf(m, id)} needs your approval: ${what}. Open it.`);
      }
      b.classList.toggle("fresh", (fresh.get(id) ?? 0) > now);
    }
    if (badges.size || pop) kick();
  }

  function frame(): void {
    raf = 0;
    const s = stage.getBoundingClientRect();
    for (const [id, b] of badges) {
      const box = d.boxOf(id);
      b.hidden = !box;
      if (!box) continue;
      // The node's upper right, clear of the artifact chip that sits centered above it.
      b.style.transform = `translate(${Math.round(box.x - s.left + box.r * 0.8 - b.offsetWidth / 2)}px, ${Math.round(box.y - s.top - box.r * 0.8 - b.offsetHeight / 2)}px)`;
    }
    place();
    if (badges.size || pop) raf = requestAnimationFrame(frame);
  }
  function kick(): void { if (!raf) raf = requestAnimationFrame(frame); }

  stage.addEventListener("click", onStageClick);
  function onStageClick(ev: Event): void {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-viz-ask-badge]");
    if (b?.dataset.vizAskBadge) open(b.dataset.vizAskBadge);
  }

  function sync(now: number): void {
    paintBadges(now);
    paintStrip();
    if (pop) paintPop();
  }

  return {
    sync,
    arrived(ids) {
      const m = d.model();
      if (!m) return;
      const until = Date.now() + FRESH_MS;
      for (const a of pendingApprovals(m)) if (ids.includes(a.id)) fresh.set(a.node, until);
      sync(Date.now());
    },
    open,
    close,
    escape() {
      if (pop) { close(); return true; }
      if (expanded && strip.contains(document.activeElement)) { collapse(); return true; }
      return false;
    },
    probe() {
      const m = d.model();
      const asks = m ? pendingApprovals(m) : [];
      return {
        pending: asks.map((a) => ({ id: a.id, node: a.node, from: a.from, tool: a.tool, type: a.type, danger: a.danger, badge: rectOf(badges.get(a.node) ?? null) })),
        triage: m ? triage(m) : { total: 0, byType: { tool: 0, exec: 0, egress: 0, file: 0 }, danger: 0, working: 0, waiting: 0, failed: 0 },
        pill: { text: pill.textContent ?? "", count: Number(pill.dataset.count ?? "0"), box: strip.hidden ? null : rectOf(pill) },
        expanded,
        pop: { open: !!pop, id: pop?.id ?? null, node: pop?.node ?? null, box: pop ? rectOf(popEl) : null },
      };
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.clearTimeout(idleTimer);
      stage.removeEventListener("click", onStageClick);
      for (const b of badges.values()) b.remove();
      badges.clear();
      strip.remove(); popEl.remove();
      pop = null;
    },
  };
}
