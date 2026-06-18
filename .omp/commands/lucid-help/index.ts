// /lucid:help — explain the LucidAgentIDE security harness and how to use it.
// omp custom command (discovered from .omp/commands/<name>/index.ts).
export default function lucidHelp() {
  return {
    name: "lucid:help",
    description: "What the LucidAgentIDE security harness does + how to use it",
    async execute() {
      return [
        "Give me a short, practical quickstart for the LucidAgentIDE security harness active in this session. Cover, concisely:",
        "- It loads via `-e harness/omp/security_extension.ts` and scans EVERY tool call (bash, write, etc.) for prompt-injection — hidden zero-width characters, Unicode tag-block smuggling, bidi tricks, and Cyrillic/Greek homoglyphs — and BLOCKS quarantined content fail-closed (if the scanner is unavailable, it still blocks).",
        "- Slash commands: `/lucid:help`, `/lucid:scan <text>` (scan text for injection), `/lucid:dashboard` (show the security dashboard).",
        "- Instant shortcuts (type these with a leading `!`): `!bun run dashboard:tui` shows the security dashboard; `!bun run demo-P2.4` demonstrates a live injection block; `!bun test harness` runs the test suite.",
        "- The guarantee: untrusted content can't reach a tool call, durable semantic memory, or a remote dispatch without passing the scan or being human-reviewed.",
        "Keep it to a tight quickstart — what I can type and what it does. No lecture.",
      ].join("\n");
    },
  };
}
