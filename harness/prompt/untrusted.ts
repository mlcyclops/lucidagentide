// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
//
// The one place untrusted text is fenced (AGENTS.md invariant 5, ADR-0147). A literal delimiter inside the
// body would close the envelope early (ASCII tokens slip past the Unicode scanner), so every wrapper
// neutralizes it here before placing the text between the markers.

import { UNTRUSTED_END, UNTRUSTED_START } from "./assembler.ts";

const NEUTRALIZED = "[lucid-neutralized-delimiter]";

/** Replace every literal envelope token in `s` with a token-free marker. */
export function neutralizeDelimiters(s: string): string {
  return s.split(UNTRUSTED_END).join(NEUTRALIZED).split(UNTRUSTED_START).join(NEUTRALIZED);
}

/** Fence `body` as untrusted data; an embedded delimiter can no longer close the envelope. */
export function fenceUntrusted(body: string): string {
  return `${UNTRUSTED_START}\n${neutralizeDelimiters(body)}\n${UNTRUSTED_END}`;
}
