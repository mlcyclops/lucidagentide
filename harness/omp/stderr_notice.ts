// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/stderr_notice.ts - P-RECOVER.1 (ADR-0384): an advisory stderr line that can never crash omp.
//
// The field crash: omp died with an uncaught `EPIPE: broken pipe, write` thrown from the security gate's
// block notice (`process.stderr.write`) after the desktop side of the pipe had gone away. omp fails CLOSED
// on a handler error, so the block still held, but the whole agent process went down with it and the chat
// sat on "reconnecting". A closed stderr surfaces two ways, and both are handled here:
//   - a synchronous throw from write(), caught;
//   - an asynchronous 'error' event on the stream, which with no listener becomes an uncaught exception.
//     One no-op listener is installed, once, the first time a notice is written.
// The notice is diagnostics only. Callers make their security decision independently of whether it landed.

let guarded = false;

export function writeStderrNotice(text: string): void {
  try {
    if (!guarded) {
      guarded = true;
      process.stderr.on("error", () => { /* the reader is gone; a lost notice is not a failure */ });
    }
    process.stderr.write(text);
  } catch {
    /* EPIPE or a destroyed stream: drop the notice, never the caller */
  }
}
