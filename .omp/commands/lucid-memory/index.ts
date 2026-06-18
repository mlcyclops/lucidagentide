// /lucid:memory — render the in-terminal MEMORY & CONTEXT dashboard inside omp.
// omp custom command. Asks the agent to run the dashboard via its bash tool so
// the gauges + tables render in the TUI. (For an instant view with no agent turn,
// just type: !bun run memory:tui)
export default function lucidMemory() {
  return {
    name: "lucid:memory",
    description: "Show the LucidAgentIDE memory & context dashboard (context window, KV-cache, compaction, semantic memory)",
    async execute() {
      return [
        "Run `bun run memory:tui` using your bash tool and show me its full output verbatim.",
        "It renders how omp is managing memory + context for THIS session: the context-window gauge (current/peak vs the model's window), KV-cache efficiency (cache hits from the frozen prompt prefix), per-turn token growth, cumulative cost, omp's compaction policy, the provider rate-limit budget, and the Lucid harness memory layers (working / archive / semantic) plus the semantic-promotion gate.",
        "After showing it, give me a one-line read: how full is the context window, and is the KV cache working well (high cache-hit fraction = the frozen prefix is paying off)?",
      ].join("\n");
    },
  };
}
