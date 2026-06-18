// harness/memory/sanitize.ts
//
// Produce a sanitized derivative safe for prompts / memory / export. This is a
// deterministic TRANSFORM, not detection — detection authority is the Python
// scanner (CLAUDE.md invariant #2). The raw original is always preserved by the
// caller; this only builds the safe copy.
//
// Policy (PRD example security policy): NFKC normalize, then strip zero-width,
// Unicode Tag-block, and bidi-control characters. Private-use-area and
// homoglyph anomalies are FLAGGED by the scanner, not silently rewritten here
// (rewriting a homoglyph would require guessing intent).

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e]);
const BIDI_CONTROLS = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE RLE PDF LRO RLO
  0x2066, 0x2067, 0x2068, 0x2069, // LRI RLI FSI PDI
  0x061c, // ARABIC LETTER MARK
]);

export interface SanitizePolicy {
  normalize: "NFKC" | "none";
  stripZeroWidth: boolean;
  stripUnicodeTags: boolean;
  stripBidiControls: boolean;
}

export const DEFAULT_SANITIZE_POLICY: SanitizePolicy = {
  normalize: "NFKC",
  stripZeroWidth: true,
  stripUnicodeTags: true,
  stripBidiControls: true,
};

/** A short, stable label describing the applied policy (stored with the row). */
export function policyLabel(p: SanitizePolicy = DEFAULT_SANITIZE_POLICY): string {
  const strips: string[] = [];
  if (p.stripZeroWidth) strips.push("zero-width");
  if (p.stripUnicodeTags) strips.push("tag");
  if (p.stripBidiControls) strips.push("bidi");
  const norm = p.normalize === "NFKC" ? "NFKC" : "none";
  return strips.length ? `${norm}+strip(${strips.join(",")})` : norm;
}

export interface SanitizeResult {
  sanitized: string;
  changed: boolean;
}

function isStripped(code: number, p: SanitizePolicy): boolean {
  if (p.stripUnicodeTags && code >= 0xe0000 && code <= 0xe007f) return true;
  if (p.stripZeroWidth && ZERO_WIDTH.has(code)) return true;
  if (p.stripBidiControls && BIDI_CONTROLS.has(code)) return true;
  return false;
}

/** NFKC-normalize and strip dangerous invisibles per policy. */
export function sanitize(text: string, policy: SanitizePolicy = DEFAULT_SANITIZE_POLICY): SanitizeResult {
  const normalized = policy.normalize === "NFKC" ? text.normalize("NFKC") : text;
  let out = "";
  // for..of iterates by code point, so astral Tag-block chars (U+E00xx) work.
  for (const ch of normalized) {
    if (!isStripped(ch.codePointAt(0)!, policy)) out += ch;
  }
  return { sanitized: out, changed: out !== text };
}
