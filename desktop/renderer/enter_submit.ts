// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/enter_submit.ts - P-KGMARKET.5 (ADR-0333): Enter in a passphrase field runs that
// field's action.
//
// A password input with a button beside it and no Enter binding does not read as "click the button". It
// reads as broken, because every other password field the user has ever typed into submits on Enter. In
// the Personalization card that cost is paid on the unlock path specifically, which is the path a user
// walks EVERY session.
//
// The decision this module holds is an ALLOWLIST, and that is the whole point. `#setBody` is one delegated
// listener over the entire Settings panel, which also contains provider API-key rows and other `.prov-row`
// inputs. A generic "Enter presses the button next to you" rule would let Enter in an unrelated field fire
// an action the user never aimed at, and some of those rows carry more than one button. So Enter is wired
// per field, by id, or not at all.

/** Which action buttons an Enter press may activate, per input id, in PREFERENCE order.
 *
 *  Each field lists BOTH of its buttons because the markup renders exactly one of them depending on state:
 *  an unconfigured store shows Create, a locked store shows Unlock. Listing both means the table does not
 *  have to know which state the panel is in, and `enterSubmitTarget` resolves it against what is actually
 *  on screen. */
export const ENTER_SUBMIT: Record<string, readonly string[]> = {
  personalPass: ["personalSetup", "personalUnlock"],
  cuiPass: ["cuiSetup", "cuiUnlock"],
};

/** The id of the button Enter should press for this input, or `null` when Enter must do nothing.
 *
 *  `null` covers three distinct cases on purpose, all of which must be inert rather than guessed: the input
 *  is not an Enter-submit field at all, the field is listed but neither of its buttons is rendered, and the
 *  input has no id. `present` is injected so the resolution rule is unit-tested without a DOM. */
export function enterSubmitTarget(inputId: string, present: (id: string) => boolean): string | null {
  if (!inputId) return null;
  const candidates = ENTER_SUBMIT[inputId];
  if (!candidates) return null;
  for (const id of candidates) {
    let there = false;
    try { there = present(id) === true; } catch { there = false; } // a throwing probe is not a match
    if (there) return id;
  }
  return null;
}
