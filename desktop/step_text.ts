// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/step_text.ts - one turn's assistant text across its tool steps.
//
// A turn that narrates, calls a tool, then narrates again is several model messages, and omp streams
// each as bare `agent_message_chunk` text with no boundary marker. A new message never opens with a
// newline, so the steps glued into one run-on paragraph ("...orchestration surfaces.Running the real
// server..."), and with no blank line between them the answer's tool chips had no block boundary to
// interleave at. The engine (master session and fleet lanes) feeds every chunk through here so the
// stream, the recovery text, the persisted turn and every renderer see the same paragraph break.

export class StepTextJoiner {
  #sawText = false;
  #toolSinceText = false;

  /** A tool call started. Text that follows it opens a new model message. */
  tool(): void {
    if (this.#sawText) this.#toolSinceText = true;
  }

  /** The chunk as it enters the answer: the first chunk after a tool step gains a paragraph break,
   *  unless it already opens on a new line. */
  text(chunk: string): string {
    if (!chunk) return chunk;
    const out = this.#toolSinceText && !/^[ \t]*\n/.test(chunk) ? `\n\n${chunk}` : chunk;
    this.#toolSinceText = false;
    this.#sawText = true;
    return out;
  }

  /** A new turn: nothing before it may separate from what follows. */
  reset(): void {
    this.#sawText = false;
    this.#toolSinceText = false;
  }
}
