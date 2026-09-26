// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/wmo_pack.ts - P-TRAINER.5 (ADR-0255): the wealth-management-operations coverage
// map, the first extraction pack.
//
// Shaped for the boutique virtual-family-office profile: coordinated investment, tax, estate,
// insurance, and business-adviser work over an RIA affiliation. The pack ships QUESTIONS, not
// answers (ADR-0255 rejection: pre-written procedures would make it a content SKU, and every firm's
// actual process differs). The one pre-filled unit is the due-diligence CHECKLIST - the
// which-entity/custody/fees/fiduciary question set a firm should be able to answer about itself.
// Every objective's elicitation carries at least one scenario probe and one edge probe (the
// scenario-first rule), and all seeds are role-shaped: adviser, client, custodian, CPA - never
// named people (ADR-0254 decision 5).

import type { CoverageObjective } from "./coverage.ts";
import type { AddUnitInput } from "./store.ts";

export const WMO_PACK_ID = "wealth-management-ops";

const o = (
  objectiveId: string,
  domain: string,
  title: string,
  description: string,
  weight: number,
  scenarios: string[],
  probes: string[],
  edgeProbes: string[],
): CoverageObjective => ({ objectiveId, packId: WMO_PACK_ID, domain, title, description, weight, elicitation: { scenarios, probes, edgeProbes } });

export const WMO_OBJECTIVES: readonly CoverageObjective[] = [
  // wmo-1 client lifecycle
  o("wmo-1.1", "Client lifecycle", "Prospect intake and discovery", "From first contact to a signed engagement: qualification, discovery meetings, data gathering.", 3, [
    "A business owner is referred to the firm on a Tuesday. Walk me through everything that happens between that referral and a signed agreement.",
  ], [
    "Step by step, what does discovery collect before an engagement is signed, and who collects it?",
    "Which entity signs the client agreement, and who countersigns?",
  ], [
    "Tell me about a prospect the firm turned away. What triggered that call?",
  ]),
  o("wmo-1.2", "Client lifecycle", "Onboarding and custodial account opening", "Paperwork, custodial account opening, ACAT transfers, funding, and the first-90-days cadence.", 3, [
    "The agreement is signed and the client holds accounts at two other custodians. Walk me through the next two weeks, day by day.",
  ], [
    "What is the exact order of operations for opening accounts and moving assets in?",
    "Who tracks an in-flight ACAT, and where?",
  ], [
    "What is the worst transfer stall the firm has handled, and what unblocked it?",
  ]),
  o("wmo-1.3", "Client lifecycle", "Reviews, offboarding, and death of a client", "Ongoing review cadence, disengagement, and the death-of-client protocol.", 2, [
    "The firm learns on a Monday morning that a long-standing client died over the weekend. What happens in the first 48 hours?",
  ], [
    "What does the standing review cadence look like across a year?",
  ], [
    "When a client relationship ends badly, what does the firm do differently from a normal offboarding?",
  ]),
  // wmo-2 money movement
  o("wmo-2.1", "Money movement", "Wires, ACH, and journals", "Disbursement requests end to end: authentication, verification callbacks, custodian cutoffs.", 4, [
    "A client calls Friday at 4pm needing a large wire sent before a holiday weekend, and the custodian cutoff has passed. Walk me through exactly what happens.",
  ], [
    "For a routine wire request, list every step from the client's ask to confirmed settlement.",
    "What are the custodian cutoffs the team works against, and where are they written down?",
  ], [
    "Describe a disbursement request that turned out to be fraud or nearly did. What tipped the team off?",
  ]),
  o("wmo-2.2", "Money movement", "Standing instructions and verification", "Standing letters of authorization, callback verification, and first-party vs third-party rules.", 3, [
    "An email arrives from a client's address asking to change wire instructions for a closing next week. What does the team actually do?",
  ], [
    "How does a standing instruction get established, and what may ride on it without a fresh callback?",
  ], [
    "When has the callback rule been inconvenient enough that someone wanted to skip it, and what happened?",
  ]),
  // wmo-3 investment operations
  o("wmo-3.1", "Investment operations", "Rebalancing and cash management", "Rebalance triggers and execution, raising cash for distributions, drift tolerance.", 3, [
    "A client needs cash for a large purchase in ten days and the portfolio is fully invested. Walk me through raising it.",
  ], [
    "What triggers a rebalance, and what is the execution checklist once it is triggered?",
  ], [
    "Tell me about a rebalance that went wrong or almost did. What was the deviation?",
  ]),
  o("wmo-3.2", "Investment operations", "Trade errors and corporate actions", "Error identification, correction, client make-whole, and corporate-action handling.", 2, [
    "The morning blotter shows a buy in the wrong account from yesterday. What happens, in order, from that discovery?",
  ], [
    "Who reviews the blotter, on what schedule, and against what?",
  ], [
    "What is the messiest corporate action the team has processed, and what made it messy?",
  ]),
  // wmo-4 billing
  o("wmo-4.1", "Billing and fees", "Fee schedules and the quarterly run", "Fee schedule maintenance, quarterly billing runs, prorations, refunds, and disclosure.", 3, [
    "It is the first week of a new quarter. Walk me through the billing run from data pull to fees hitting accounts.",
  ], [
    "How are prorations handled for mid-quarter inflows, outflows, and terminations?",
    "Where does the client see the fee, and in what form?",
  ], [
    "Describe a billing dispute or error the firm has handled. How was it caught and made right?",
  ]),
  // wmo-5 tax coordination
  o("wmo-5.1", "Tax coordination", "Realized gains, harvesting, and CPA handoffs", "Gain/loss tracking, tax-loss harvesting windows, CPA coordination, K-1 season, estimates.", 3, [
    "It is early December. A client's CPA calls about realized gains before year-end. Walk me through what the firm produces and what happens next.",
  ], [
    "How does tax-loss harvesting actually run: who screens, when, and against what constraints?",
    "What does the K-1 season choreography look like for clients with partnership interests?",
  ], [
    "Tell me about a harvesting or estimate coordination that went sideways. What was the wrinkle?",
  ]),
  // wmo-6 estate/trust/insurance
  o("wmo-6.1", "Estate and insurance coordination", "Attorney handoffs, trust funding, beneficiaries", "Estate document coordination, trust funding follow-through, beneficiary audits, policy reviews.", 2, [
    "A client signed a new revocable trust last month. Walk me through what the firm does so the plan actually works.",
  ], [
    "How often are beneficiary designations audited, and against what source of truth?",
  ], [
    "Where has a trust-funding follow-through fallen through the cracks, and what changed after?",
  ]),
  o("wmo-6.2", "Estate and insurance coordination", "Business-sale and exit support", "Supporting an owner through a sale: adviser quarterback role, proceeds planning, timelines.", 2, [
    "A client accepts a letter of intent to sell their business, closing in 90 days. What does the firm's calendar look like until close?",
  ], [
    "Who does the firm bring to the table for an exit, and in what order?",
  ], [
    "What has blindsided an exit late in the process, and how did the team handle it?",
  ]),
  // wmo-7 compliance
  o("wmo-7.1", "Compliance", "Entities, disclosures, and books and records", "Which entity signs what (brand LLC vs the registered adviser), ADV updates, records, marketing review.", 3, [
    "A new employee asks: when a client signs with us, which legal entity are they hiring, and who is the fiduciary for what? Walk me through the real answer.",
  ], [
    "What is the annual compliance calendar: ADV, reviews, attestations, in what order?",
    "How does a piece of marketing get from draft to published?",
  ], [
    "Describe a complaint or a near-complaint. What did the intake and resolution actually look like?",
  ]),
  // wmo-8 adviser network
  o("wmo-8.1", "Adviser network", "Custodians, RIA affiliation, and outside professionals", "Custodian relationships, the RIA/TAMP affiliation mechanics, and coordinating attorneys/CPAs/bankers.", 2, [
    "A client's attorney, CPA, and banker all need something from the firm in the same week. Walk me through how that traffic is run.",
  ], [
    "What runs through the RIA affiliation versus in-house, and how does the team keep the line straight?",
  ], [
    "When has an outside professional dropped a ball that landed on the firm? What is the guardrail now?",
  ]),
] as const;

/** The one pre-filled seed unit: the due-diligence checklist a firm should answer about itself.
 *  Ships UNCONFIRMED and untrusted like any capture - the expert still teaches it back. */
export function wmoDueDiligenceSeed(): AddUnitInput {
  const steps = [
    "Identify which legal entity signs the client agreement.",
    "Identify which registered investment adviser is responsible for investment advice.",
    "Confirm where client assets are held and who the qualified custodian is.",
    "Enumerate total advisory, planning, investment, insurance, and third-party fees.",
    "Disclose any commissions, referral fees, or revenue-sharing arrangements.",
    "State whether the firm acts as a fiduciary for every service provided.",
    "Separate services performed in-house from services that are outsourced.",
    "List the professional licenses and credentials of the assigned advisers.",
    "Clarify whether tax and legal services are provided directly or coordinated externally.",
    "Review regulatory filings for disciplinary disclosures, complaints, and conflicts of interest.",
  ];
  return {
    objectiveId: "wmo-7.1",
    kind: "checklist",
    title: "Client due-diligence answers the firm must own",
    bodyMd: [
      "The questions a prospective client (or their attorney) will ask before engaging a virtual",
      "family office. The firm's onboarding and compliance materials must answer every one without",
      "research. Sourced from the standard boutique-VFO due-diligence set.",
    ].join("\n"),
    structure: { steps, trigger: "", resolution: "" },
    trustLabel: "untrusted",
    completeness: 90,
  };
}
