// /lucid:dashboard — render the in-terminal security dashboard inside omp.
// omp custom command. Asks the agent to run the dashboard via its bash tool so
// the table renders in the TUI. (For an instant view with no agent turn, just
// type: !bun run dashboard:tui)
export default function lucidDashboard() {
  return {
    name: "lucid:dashboard",
    description: "Show the LucidAgentIDE security dashboard in the terminal",
    async execute() {
      return [
        "Run `bun run dashboard:tui` using your bash tool and show me its full output verbatim.",
        "It renders the six LucidAgentIDE security views — findings overview, Unicode analysis, approval queue, quarantine review, memory-promotion risk, export audit — plus active runs.",
        "After showing it, give me a one-line read on the security posture (anything quarantined and awaiting review?).",
      ].join("\n");
    },
  };
}
