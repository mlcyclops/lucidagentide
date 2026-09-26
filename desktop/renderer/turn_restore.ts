// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

export interface RecoveryMessage { role: string; text: string; turn?: number }

/** Keep prior context, but replace the current user/partial-answer pair from canonical state. */
export function priorTurnContext(messages: RecoveryMessage[], prompt: string): RecoveryMessage[] {
  for (let i = messages.length - 1; i >= 0; --i) {
    if (messages[i].role !== "user") continue;
    return messages[i].text === prompt ? messages.slice(0, i) : messages;
  }
  return messages;
}

/** Fresh boot ignores completed history; an identified in-flight turn may finish during attachment. */
export function canAdoptTurn(status: { turnId: string; running: boolean } | null, expectedTurnId?: string): boolean {
  return !!status && (expectedTurnId ? status.turnId === expectedTurnId : status.running);
}

export function canonicalTurnAnswer(current: string, supplied: string | undefined): string {
  return supplied === undefined ? current : supplied;
}
