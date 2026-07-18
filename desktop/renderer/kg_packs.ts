// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/kg_packs.ts — P-KGPACK.5 (ADR-0205): the "Role KG Packs" catalog (the SKU shopfront).
//
// PUBLIC-SEAM ONLY. This source-available repo ships the STOREFRONT + the gated IMPORT path (P-KGPACK.4);
// the actual Position-Description KG Packs are AUTHORED and HOSTED in the private add-on repo (same
// public-seam / private-IP split as the skills registry P-SKILLREG.1 and the managed-config seam ADR-0068).
// A catalog row is a HINT: it describes a role pack and links out to the product page where you obtain it;
// the packs are never bundled here. "Import a pack you own" routes a `.lkgpack` you already have through the
// P-KGPACK.4 gate (integrity + origin verified, every page re-scanned fail-closed, installed read-only).
//
// Pure builders (no DOM, no fetch) - app.ts owns the scrim/search wiring, mirroring the Plugin Marketplace
// (ADR-0158). The catalog reuses the marketplace's `.mkt-*` styles for one consistent look.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { PackLicensing } from "../../harness/market/entitlement.ts";

/** Where a pack comes from. `first-party` = authored by TechLead 187 LLC; `community` = a future
 *  marketplace seller (the LUCID KG Marketplace is on the roadmap). */
export type KgPackTier = "first-party" | "community";

export interface KgPack {
  id: string;          // stable id — never regenerated (invariant 9); also the product/pack id (P-KGMARKET)
  name: string;
  role: string;        // the Position Description this pack embodies
  desc: string;        // one-liner: what knowledge it carries
  author: string;
  tier: KgPackTier;
  licensing: PackLicensing; // one-time purchase vs subscription/seat (P-KGMARKET.1, ADR-0206)
  url: string;         // the product page where the pack is obtained (the SKU pointer)
  highlights: string;  // what it was seeded from (the value story)
}

/** The public product page where role packs are obtained (the private add-on repo delivers the files). */
export const KG_PACKS_URL = "https://lucid-agent.web.app/";

/** The curated storefront. First-party role packs authored by TechLead 187 LLC; the files live in the
 *  private add-on repo. Ordered as a curated shelf (registry order). */
export const KG_PACKS: KgPack[] = [
  {
    id: "senior-proposal-manager", name: "Senior Proposal Manager", role: "Proposal Manager / DoD RFP Compliance Lead",
    desc: "DoD RFP proposal management: Section L/M/K response patterns, compliance matrices, color-team reviews, and proposal production.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "subscription", url: KG_PACKS_URL,
    highlights: "The flagship pack: seeded from a working proposal shop's RFP responses, color-team reviews, and Salesforce BD workflows.",
  },
  {
    id: "govcon-contracts-officer", name: "GovCon Contracts Officer", role: "Contracting Officer / Specialist",
    desc: "FAR/DFARS-grounded contracting: source selection, negotiation, and administration.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "one-time", url: KG_PACKS_URL,
    highlights: "Seeded from curated FAR/DFARS guidance and years of contracting Q&A.",
  },
  {
    id: "cmmc-rmf-security-lead", name: "CMMC & RMF Security Lead", role: "ISSO / Security Control Assessor",
    desc: "CMMC 2.0 and NIST SP 800-171/800-53 RMF: controls, POA&Ms, and assessment objectives.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "subscription", url: KG_PACKS_URL,
    highlights: "Curated control catalogs, assessment objectives, and remediation patterns.",
  },
  {
    id: "program-manager-evm", name: "Program Manager (EVM)", role: "Program / Project Manager",
    desc: "CMMI and Earned Value Management: IMS, EAC, variance analysis, and program controls.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "subscription", url: KG_PACKS_URL,
    highlights: "Curated EVM formulas, IMS practices, and PM governance.",
  },
  {
    id: "cleared-software-engineer", name: "Cleared Software Engineer", role: "Software Engineer (cleared)",
    desc: "Secure SDLC for classified/air-gapped work: STIGs, secure coding, and ATO evidence.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "subscription", url: KG_PACKS_URL,
    highlights: "Curated STIG guidance and secure-SDLC patterns for RMF packages.",
  },
  {
    id: "dow-dod-business-development", name: "Business Development Capture Manager", role: "Business Development / Capture Manager (DoW/DoD)",
    desc: "DoW/DoD business development and capture: pipeline shaping, teaming, gate reviews, and bid decisions.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "one-time", url: KG_PACKS_URL,
    highlights: "Seeded from real capture pipelines: opportunity shaping, teaming strategy, and bid/no-bid gates.",
  },
  {
    id: "sbir-sttr-grants-pi", name: "SBIR/STTR & NSF Grants PI", role: "Principal Investigator / Grants Lead",
    desc: "SBIR/STTR and NSF grant strategy: solicitations, technical volumes, and Phase I/II execution.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "one-time", url: KG_PACKS_URL,
    highlights: "Curated solicitation analysis, technical-volume patterns, and phase-transition playbooks.",
  },
  {
    id: "senior-backend-engineer", name: "Senior Backend Engineer", role: "Backend / Platform Engineer",
    desc: "Backend systems and RAG: services, data pipelines, retrieval, and reliability.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "one-time", url: KG_PACKS_URL,
    highlights: "Curated service architecture, data-pipeline, and retrieval-engineering patterns.",
  },
  {
    id: "senior-frontend-uiux-engineer", name: "Senior Frontend Engineer (UI/UX)", role: "Frontend / UI-UX Engineer",
    desc: "Frontend and UI/UX: design systems, accessibility, and product interaction.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "one-time", url: KG_PACKS_URL,
    highlights: "Curated design-system, accessibility, and interaction-design patterns.",
  },
  {
    id: "ml-engineer", name: "Machine Learning Engineer", role: "Machine Learning Engineer",
    desc: "ML engineering: training, evaluation, deployment, and MLOps.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "one-time", url: KG_PACKS_URL,
    highlights: "Curated training, evaluation, and deployment patterns for production ML.",
  },
  {
    id: "ste-digital-engineering", name: "STE / Digital Engineering", role: "Systems / Digital Engineer",
    desc: "Digital engineering and STE: model-based systems engineering and the digital thread.",
    author: "TechLead 187 LLC", tier: "first-party", licensing: "one-time", url: KG_PACKS_URL,
    highlights: "Curated MBSE practices and digital-thread engineering patterns.",
  },
];

/** Case-insensitive substring filter over name/role/desc/author/highlights. Empty query → everything. Pure. */
export function filterKgPacks(list: KgPack[], query: string): KgPack[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) =>
    p.name.toLowerCase().includes(q) || p.role.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)
    || p.author.toLowerCase().includes(q) || p.highlights.toLowerCase().includes(q));
}

function tierChip(t: KgPackTier): string {
  return t === "first-party"
    ? `<span class="mkt-chip mkt-featured">First-party</span>`
    : `<span class="mkt-chip mkt-planned">Community</span>`;
}

function licensingChip(l: PackLicensing): string {
  return `<span class="mkt-chip mkt-builtin">${l === "subscription" ? "Subscription" : "One-time"}</span>`;
}

function packRow(p: KgPack): string {
  return `<div class="mkt-row" data-kgpack-id="${esc(p.id)}">
    <div class="mkt-main">
      <div class="mkt-name">${esc(p.name)}${tierChip(p.tier)}${licensingChip(p.licensing)}<span class="mkt-cat">${esc(p.role)}</span></div>
      <div class="mkt-desc">${esc(p.desc)}</div>
      <div class="mkt-plan">${icon("bulb", 12)}${esc(p.highlights)} · ${esc(p.author)}</div>
    </div>
    <button class="mkt-repo" data-kgpack-get="${esc(p.id)}" title="Get this pack">Get pack</button>
  </div>`;
}

/** Just the rows (filtered) — app.ts re-renders #kgpackList with this on every search keystroke. Pure. */
export function kgPackRowsHtml(list: KgPack[], query: string): string {
  const shown = filterKgPacks(list, query);
  if (!shown.length) return `<div class="mkt-empty">No KG pack matches "${esc(query.trim())}"</div>`;
  return shown.map(packRow).join("");
}

/** The whole catalog modal (header + note + search + list + "Import a pack you own"). Pure. */
export function kgPacksHtml(list: KgPack[], query: string): string {
  return `<div class="mkt-modal" role="dialog" aria-label="Role KG Packs">
    <div class="mkt-h">${icon("package", 18)}<span>Role KG Packs</span>
      <button class="mkt-close" data-kgpack-close title="Close">${icon("close", 14)}</button></div>
    <div class="mkt-sub">Curated, role-specific knowledge graphs - instantly seed a new hire from a Position Description. Packs are delivered by the LUCID add-on; "Get pack" opens the product page. Already have a <code>.lkgpack</code>? Import it below - it's verified for origin and re-scanned before anything installs.</div>
    <input id="kgpackSearch" class="mkt-search" type="text" placeholder="Search role packs…" autocomplete="off" spellcheck="false">
    <div id="kgpackList" class="mkt-list">${kgPackRowsHtml(list, query)}</div>
    <button class="kgp-new kgpack-import" data-kgpack-import title="Import a .lkgpack pack you already have - gated, read-only">${icon("package", 12)} Import a pack you own</button>
  </div>`;
}
