# LUCID user guides

Role-shaped user guides for **LucidAgentIDE** (LUCID). Each guide walks one role
through the capabilities that role actually uses, step by step, with screenshots
and a cited **Notes and References** section. The structure is defined in
[`ADR-0092`](../../DECISIONS.md) (increment P-DOC.1).

> [!NOTE]
> Roles change **defaults and chrome, never enforcement** (see
> [`ADR-0088`](../../DECISIONS.md)). Whatever guide you read, the fail-closed
> security gate is identical, nothing is ever hidden for good (every panel is one
> `⌘K` / `Ctrl+K` away, or **Settings → Show all panels**), and a real security
> block surfaces the Security panel for *every* role.

## Which guide is me?

| If you are… | You land on… | Read |
|:--|:--|:--|
| **Developer** (the default role) | Chat + Memory (context / cache / cost) | [Developer guide](developer-guide.md) |
| **Security engineer** | The Security inspector + always-on gate badge | [Security guide](security-guide.md) |
| **Manager** | The cost / delivery ledger | [Manager guide](manager-guide.md) |
| **Executive** | A posture + spend summary + the Engineering Update brief | [Executive guide](executive-guide.md) |

You can switch roles any time in **Settings → Profile**, and replay the guided
tour from **About → Take the tour**. A managed GPO/MDM policy may pin the role
org-wide.

## Screenshots

Screenshot references in these guides point at `images/<role>-<slug>.png`. In this
first pass the captions are the specification for each capture (what panel, what
state, what is highlighted); the PNGs are filled in a later pass (P-DOC.2).

## See also

- [`README.md`](../../README.md) — the full capability tour.
- [`CLAUDE.md`](../../CLAUDE.md) / [`AGENTS.md`](../../AGENTS.md) — the load-bearing
  invariants (fail-closed, extend-don't-fork, byte-stable prefix, closed trust-label set).
- [`CHEATSHEET.md`](../../CHEATSHEET.md) — day-to-day commands.
- [`DECISIONS.md`](../../DECISIONS.md) — architecture decision records.
