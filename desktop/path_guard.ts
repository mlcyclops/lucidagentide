// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/path_guard.ts — M1 (ADR-0022): filesystem path containment.
//
// The in-app folder browser (/api/fs/list) takes a directory path straight from
// the request and hands it to readdirSync/statSync. Unconstrained, that is an
// arbitrary directory-listing primitive (CodeQL js/path-injection). The browser
// only ever needs to navigate the user's home subtree, so we canonicalize the
// requested path and confirm it stays inside an allowed root before touching it.

import { resolve, sep } from "node:path";

/**
 * Canonicalize `candidate` and return it only if it is `root` or a descendant of
 * `root`; otherwise null. `resolve` collapses `..` and relative segments, so
 * `root/../../etc` cannot escape. Comparison is prefix-on-separator to avoid the
 * classic `/home/user` vs `/home/user-evil` sibling-prefix bypass.
 */
export function pathWithin(root: string, candidate: string): string | null {
  const r = resolve(root);
  const c = resolve(r, candidate);
  return c === r || c.startsWith(r + sep) ? c : null;
}
