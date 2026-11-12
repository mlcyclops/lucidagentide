// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Authored code carried by tool previews. This describes requested changes, not successful mutations.
// Callers own path resolution and may use a smaller display cap than Main's 64 KiB.

const REPLACEMENT_KEYS = [["old_string", "new_string"], ["old_text", "new_text"], ["oldText", "newText"]] as const;

function replacement(input: Record<string, unknown>): { oldText: string; newText: string } | undefined {
  for (const [oldKey, newKey] of REPLACEMENT_KEYS) {
    const oldText = input[oldKey];
    const newText = input[newKey];
    if (typeof oldText === "string" || typeof newText === "string") {
      return { oldText: typeof oldText === "string" ? oldText : "", newText: typeof newText === "string" ? newText : "" };
    }
  }
  return undefined;
}

export function toolCode(
  u: { kind?: unknown; title?: unknown; rawInput?: unknown; input?: unknown },
  resolvePath: (path: string) => string,
  cap = 64 * 1024,
): { path: string; content?: string; oldText?: string; newText?: string; patch?: string } | undefined {
  const raw = u.rawInput ?? u.input;
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const rawPath = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
  const path = resolvePath(rawPath);
  const clip = (text: string) => text.slice(0, cap);
  if (typeof input.content === "string") return { path, content: clip(input.content) };

  const pair = replacement(input);
  if (pair) return { path, oldText: clip(pair.oldText), newText: clip(pair.newText) };

  if (Array.isArray(input.edits)) {
    const edits = input.edits.filter((edit): edit is Record<string, unknown> => !!edit && typeof edit === "object");
    // A create's diff is raw file content, while updates carry patch rows.
    if (edits.length === 1 && edits[0]?.op === "create" && typeof edits[0].diff === "string") {
      return { path, content: clip(edits[0].diff) };
    }
    const patches = edits.flatMap((edit) => {
      if (typeof edit.diff !== "string") return [];
      if (edit.op !== "create") return [edit.diff];
      const lines = edit.diff.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return [lines.map(line => `+${line}`).join("\n")];
    });
    if (patches.length) return { path, patch: clip(patches.join("\n")) };
    const pairs = edits.map(replacement).filter((edit) => edit !== undefined);
    if (pairs.length) {
      return { path, oldText: clip(pairs.map((edit) => edit.oldText).join("\n")), newText: clip(pairs.map((edit) => edit.newText).join("\n")) };
    }
    // Delete and rename-only edits still need a path for completion-based checkout ownership.
    if (edits.some(edit => ["create", "delete", "update"].includes(String(edit.op)) || typeof edit.rename === "string")) {
      return { path };
    }
  }

  // Hashline and apply_patch inputs use a single patch string. Other tools' inputs are not code.
  if (typeof input.input === "string" && (u.kind === "edit" || /\bedit\b/i.test(String(u.title ?? "")) ||
      (u.kind === "other" && /^\*\*\* Begin Patch\r?\n/.test(input.input) && input.input.trimEnd().endsWith("*** End Patch")))) {
    return { path, patch: clip(input.input) };
  }
  return undefined;
}
