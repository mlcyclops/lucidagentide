// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// pdfjs-dist ships no declaration for its worker entry. The Markup pane imports it only to hand pdf.js its
// main-thread message handler (globalThis.pdfjsWorker), so the one export it reads is all that is typed.
declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
