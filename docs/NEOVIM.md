# Using LUCID from Neovim

> A Neovim-centric way to drive the **gated** LUCID agent without leaving your editor. This is the
> Neovim counterpart to the VS Code + JetBrains extensions (ADR-0038) and the terminal counterpart to
> the desktop shell: the same fail-closed security gate, reached three different ways. Design + invariant
> mapping live in **ADR-0150** (`DECISIONS.md`); increment **P-NVIM.1**.

If you live in Neovim, you have three ways to reach LUCID, from zero-dependency to fully in-editor. All
three route through the **`lucid` launcher**, which loads the in-process security gate and **fail-closes**
(refuses to start if the scanner sidecar is down or the gate is missing) — so nothing here can ever give
you an *ungated* agent.[1][2]

| # | Path | What you get | Needs |
|---|------|--------------|-------|
| 1 | **bare `lucid` in `:terminal`** | omp's full native terminal UI (streaming, thinking, tool render, Plan/Ask/Agent, approvals) inside a Neovim buffer | nothing but the `lucid` binary |
| 2 | **`lucid.nvim` plugin** | Path 1 + `:Lucid`, `:LucidSend` (send selection/file), `:checkhealth lucid`, keymaps | the bundled plugin in `extensions/neovim/` |
| 3 | **An ACP client → `lucid acp`** | inline, buffer-native chat driven by an existing Neovim ACP plugin (e.g. CodeCompanion.nvim) | a third-party ACP plugin |

## The one rule (same as every LUCID editor integration)

**The editor is untrusted; the `lucid` launcher is the trust anchor.** Whichever path you pick, Neovim
only ever spawns `lucid` — never a bare `omp`. The *gate-or-no-gate* decision lives inside `lucid`, which
reproduces the exact gated command the desktop shell uses and self-verifies at startup. A Neovim config,
plugin, or third-party ACP client **cannot** express "run the agent without the gate."[3]

```
Neovim ──spawn──► lucid [tui] / lucid acp ──► omp -e security_extension.ts … ──► gate pre-hook (in-process)
 (untrusted)       (Lucid-owned, fail-closed)   (same OS process tree)          fail-closed scanner sidecar
```

## Prerequisites

1. **Install the `lucid` launcher.** It ships with the LucidAgentIDE desktop app and installer; put it on
   your `PATH` (the installer does this), or point the plugin at an absolute path (`cmd = "/path/to/lucid"`).
   In a dev checkout you can run it from source: `bun harness/launcher/lucid_acp.ts <subcommand>`.
2. **Confirm the gate is live** before wiring anything up:

   ```console
   $ lucid check
   [lucid check] OK — gate + scanner ready
   ```

   A non-zero exit here is the fail-closed gate telling you the scanner sidecar or gate extension isn't
   ready — fix that first (it is *not* a Neovim problem).[1]
3. **Sign in to a model** once via the desktop app or `omp` — the launcher inherits omp's credential vault
   under `~/.omp`; no keys live in Neovim.

---

## Path 1 — bare `lucid`: zero-dependency, works in any Neovim

Bare `lucid` starts the gated agent (ADR-0161 — `lucid tui` remains an explicit alias) in **omp's native terminal UI** — the same gated command as `lucid acp`,
minus the ACP stdio passthrough, so omp owns the tty. Everything omp's TUI does (token streaming, thinking
blocks, tool-call rendering, Plan/Ask/Agent modes, tool-approval prompts) works, all behind the gate. It
takes the same fail-closed preflight as every other LUCID surface.

Just open it in a terminal buffer:

```vim
" scratch split
:terminal lucid

" seed an initial prompt (extra args pass straight through to omp)
:terminal lucid "explain src/server/auth.ts"
:terminal lucid --model claude-haiku-4-5 --continue
```

Any omp flag works after `lucid` — `--model`, `--continue`, `--resume`, `-p` (non-interactive), etc.
Because the cwd is your Neovim working directory, LUCID operates on your project (its `read`/`edit`/`grep`/
`lsp` tools + your files) with the workspace as the path-containment boundary.

A tidy toggle without any plugin:

```lua
-- init.lua — a floating, toggle-able Lucid terminal on <leader>lc
vim.keymap.set("n", "<leader>lc", function()
  vim.cmd("botright vsplit | terminal lucid")
  vim.cmd("startinsert")
end, { desc = "Lucid terminal" })
```

Or drive it with your existing terminal manager (`toggleterm.nvim`, `snacks.nvim` terminal, etc.):

```lua
-- toggleterm.nvim
require("toggleterm.terminal").Terminal
  :new({ cmd = "lucid", direction = "float", hidden = true })
  :toggle()
```

> [!NOTE]
> Bare `lucid` (the TUI) and `lucid acp` run the **byte-identical** gated command (gate extension first, same appended
> policy). The only difference is the front end: `tui` is omp's terminal UI; `acp` is the machine protocol
> an editor drives. Neither can start without the gate.[1]

### The LUCID skin (P-THEME.1)

Gated terminal sessions wear the desktop design system: `lucid tui` loads a small theme extension that
installs `lucid` into omp's custom-themes dir (`~/.omp/agent/themes/lucid.json`) and applies it **for
that session only** — it never persists `theme.dark`, so a bare `omp` keeps your own theme. The magenta
accent doubles as the visible tell that you're in a *gated* terminal. Purely cosmetic and fail-open: if
theming ever fails, the session runs on omp's default theme (the security gate is unaffected).

- `LUCID_THEME=off lucid tui` — disable the skin.
- `LUCID_THEME=<name> lucid tui` — wear another omp theme instead.
- Because `lucid` is also a normal omp custom theme, you can select it for bare omp too
  (omp Settings → Appearance), or live-tweak `~/.omp/agent/themes/lucid.json` — omp hot-reloads it.

---

## Path 2 — the `lucid.nvim` plugin

A small first-party plugin (in `extensions/neovim/`) that wraps Path 1 with commands, a send-to-agent
helper, a health check, and keymaps. It is deliberately terminal-based — it hosts the real, already-gated
omp TUI rather than reimplementing a chat UI — so it is robust and low-maintenance.

### Install (standalone, from this repo)

The plugin is published as a **`lucid.nvim` branch of this same repo** — generated automatically from
`extensions/neovim/` by CI (`git subtree split`), so there is no separate project to track. Install it
with any plugin manager via the `branch` field.

<details open>
<summary><b>LazyVim / lazy.nvim</b> (recommended)</summary>

Drop this in `~/.config/nvim/lua/plugins/lucid.lua`:

```lua
return {
  {
    "mlcyclops/lucidagentide",
    name = "lucid.nvim",
    branch = "lucid.nvim",             -- plugin-at-root branch; source lives in extensions/neovim/
    main = "lucid",                    -- else lazy infers the module from the repo name and setup() no-ops
    cmd = { "Lucid", "LucidToggle", "LucidSend", "LucidCheck", "LucidStats", "LucidKb" },
    keys = {
      { "<leader>al", "<cmd>LucidToggle<cr>", desc = "Lucid: toggle" },
      { "<leader>as", "<cmd>LucidSend<cr>", desc = "Lucid: send file" },
      { "<leader>as", ":LucidSend<cr>", mode = "x", desc = "Lucid: send selection" },
      { "<leader>aC", "<cmd>LucidCheck<cr>", desc = "Lucid: gate check" },
    },
    opts = { keymaps = false },        -- keys are declared above; `opts` auto-runs require("lucid").setup(opts)
    -- opts = { keymaps = false, cmd = "/absolute/path/to/lucid" },  -- if `lucid` isn't on PATH
  },
}
```

Three things matter under LazyVim:
- **`main = "lucid"`** — with `opts`, lazy auto-calls `require(main).setup(opts)`; without it lazy infers the module from the repo name (`lucidagentide`) and setup never runs.
- **`cmd`/`keys` are required, not optional** — LazyVim defaults plugins to lazy-loaded, so with no trigger the plugin never loads and its commands never register.
- **Visual-mode send uses the `:` form** (`:LucidSend<cr>`, not `<cmd>…`) so Neovim applies the `'<,'>` range; the `<cmd>` form would send the whole file instead of the selection. `<leader>l…` is avoided because LazyVim owns it (`:Lazy`).
</details>

<details>
<summary><b>packer.nvim</b></summary>

```lua
use({ "mlcyclops/lucidagentide", branch = "lucid.nvim", as = "lucid.nvim",
  config = function() require("lucid").setup({}) end })
```
</details>

<details>
<summary><b>vim-plug</b></summary>

```vim
Plug 'mlcyclops/lucidagentide', { 'branch': 'lucid.nvim' }
```
```lua
require("lucid").setup({})
```
</details>

### Install (local dev checkout)

Working inside the monorepo, point the manager at the on-disk plugin instead of the published branch:

```lua
-- lazy.nvim
{ dir = vim.fn.expand("~/projects/personal/lucidagentide/extensions/neovim"),
  name = "lucid.nvim", main = "lucid",
  cmd = { "Lucid", "LucidToggle", "LucidSend", "LucidCheck", "LucidStats", "LucidKb" }, opts = {} }
```

Calling `setup()` is optional outside LazyVim — the commands work with defaults as soon as the plugin is
on your `runtimepath`. `setup()` only overrides config and installs the default keymaps.

### Commands

| Command | Action |
|---------|--------|
| `:Lucid [prompt]` | Open/focus the gated Lucid terminal; optional text seeds the prompt |
| `:LucidToggle` | Show/hide the Lucid window (the session keeps running while hidden) |
| `:LucidSend` | Visual range → send the selection; `:10,20LucidSend` → send those lines; otherwise send the current file as `@path` |
| `:LucidCheck` | Run the fail-closed preflight (`lucid check`) and report the verdict |
| `:LucidStats` | Session spend + KV-cache % + context-fill (float; the GUI Memory inspector) |
| `:LucidKb` | Browse the knowledge graph: pick a KG → a page → read it (uses `vim.ui.select`; the terminal-native GUI KG browser) |
| `:checkhealth lucid` | Full health: launcher found + `lucid check` passes |

### Default keymaps (set by `setup()`)

| Key | Command |
|-----|---------|
| `<leader>lc` | `:LucidToggle` |
| `<leader>ls` | `:LucidSend` (normal: current file · visual: selection) |
| `<leader>lC` | `:LucidCheck` |
| `<leader>lm` | `:LucidStats` |
| `<leader>lk` | `:LucidKb` |

Disable them with `keymaps = false` (or per-entry, e.g. `keymaps = { send = false }`) and map the
commands yourself.

### Configuration

```lua
require("lucid").setup({
  cmd = "lucid",                                   -- launcher; absolute path if not on PATH
  tui_args = {},                                   -- args always passed to the gated TUI
  cwd = nil,                                       -- workspace dir (path boundary); nil = Neovim cwd
  window = "float",                                -- "float" | "vsplit" | "split" | "tab"
  float = { width = 0.85, height = 0.85, border = "rounded" },
  start_insert = true,                             -- enter terminal insert-mode on open
  keymaps = { toggle = "<leader>lc", send = "<leader>ls", check = "<leader>lC", stats = "<leader>lm", kb = "<leader>lk" },
  statusline = { interval = 5000, prefix = "Lucid" }, -- for require("lucid").statusline()
})
```

> [!WARNING]
> There is intentionally **no setting to run a different agent command**. `cmd` must resolve to a `lucid`
> launcher; if it can't be found the plugin reports an error and does nothing — it never falls back to a
> bare `omp`. That's the fail-closed guarantee, in Neovim form.[3]

### Metrics: spend, KV-cache, context — the Memory inspector, in Neovim

The same numbers the GUI's Memory inspector shows are available in Neovim, read from the omp session
transcript (session-only fast path — no DuckDB, no omp subprocess):

- **`:LucidStats`** (or `<leader>lm`) opens a float with session **spend**, **KV-cache hit %**, and
  **context-fill** (+ rate-limit budgets):

  ```
  Lucid — session metrics
    model    claude-opus-4-8
    turns    117
    spend    $15.5611
    cache    99% hit
    context  28% [####------------]  280899 / 1000000
    history  ▁▁▁▂▂▂▂▃▃▃▃▄▄▄▅▅▅▆▆▆▇▇██
    budgets  Claude 5 Hour 17% · Claude 7 Day 11%
  ```

- **Statusline component** — add `require("lucid").statusline()` to lualine / heirline / your native
  `statusline`. It returns a cached `Lucid $15.56 · cache 99% · ctx 28%` and refreshes on a light poll
  (`config.statusline.interval`, default 5s):

  ```lua
  -- lualine
  require("lualine").setup({ sections = { lualine_x = { function() return require("lucid").statusline() end } } })
  -- native statusline
  vim.o.statusline = "%{v:lua.require'lucid'.statusline()}"
  ```

  Set `statusline = false` in `setup()` to disable the component and its poll entirely.

The raw JSON the plugin consumes is `lucid stats --json` (add `--budgets` for rate limits) — handy for
building your own components.

### Knowledge graph — browse your compiled KGs in Neovim

- **`:LucidKb`** (or `<leader>lk`) is the terminal-native mirror of the GUI's knowledge-graph browser.
  It reads the SAME graphs the desktop app shows (the shared `~/.omp` registry), so nothing is
  editor-specific. It uses `vim.ui.select`, so if you have telescope / fzf-lua / snacks wired as your
  `vim.ui.select` backend it drives the picker with **zero extra dependency** — type to filter.

  Flow: **pick a knowledge graph** (the active one first; skipped when you only have one) → **pick a
  page** → the page opens in a read-only markdown float (`q` / `<Esc>` to close).

  The data comes from the read-only `lucid kb` CLI, usable bare in any terminal:

  ```
  lucid kb list                 # your KGs (the active one marked *)
  lucid kb pages [--kg <id>]    # a KG's pages
  lucid kb show <id|slug>       # one page's body
  lucid kb search <query>       # lexical search over titles + bodies
  ```

  Add `--json` to any of them for machine output (what the plugin consumes). It is a pure read — no
  agent, no gate spawn — so it never blocks and never mutates your graphs.

### Security block banner — the gate's block, as a Neovim notification

When the in-process gate quarantines a tool call it prints an authoritative
`[BLOCKED tool_call:<name>] … severity=<s> findings=<f>` line — the **same** signal the GUI's block
banner and the VS Code/JetBrains clients parse (contract pinned by `harness/launcher/ext_parity.json`).
The plugin watches the Lucid terminal's output stream and raises a `vim.notify` **ERROR** banner, so a
security block interrupts you even if the TUI scroll has moved past it. The delivery path is proven in
the headless spec: a real PTY job emits the line on stderr and `_parse_block_line` receives it via
`on_stdout` (PTY streams merge stderr; the CR artifact is handled).

---

## Path 3 — an ACP client → `lucid acp` (inline buffer chat)

If you want chat *inside* a Neovim buffer (not a terminal), use an existing Neovim client that speaks the
**Agent Client Protocol** and point it at `lucid acp`. omp is a conformant ACP agent — `lucid acp`
completes the ACP `initialize` handshake advertising **protocol v1**, `loadSession`, and the `agent` auth
method — so any ACP-capable Neovim plugin can drive it while the gate stays anchored in `lucid`.[4]

Example with **CodeCompanion.nvim**, whose `acp` adapter spawns a command and speaks ACP over stdio:

```lua
require("codecompanion").setup({
  adapters = {
    acp = {
      lucid = function()
        return require("codecompanion.adapters").extend("gemini_cli", {
          -- CodeCompanion's ACP adapters spawn `command` and speak ACP over stdio.
          -- Point it at the fail-closed Lucid launcher instead of a bare agent:
          commands = { default = { "lucid", "acp" } },
          defaults = { mcp = {} },  -- omp accepts an empty mcpServers set in session/new
        })
      end,
    },
  },
  strategies = { chat = { adapter = "lucid" } },
})
```

> [!NOTE]
> Third-party ACP plugins evolve their adapter API; treat the snippet above as a starting point and check
> your plugin's current ACP docs for the exact `command`/adapter shape. The security guarantee does **not**
> depend on the plugin: `lucid acp` self-verifies the gate and fail-closes regardless of which client
> spawned it — a misconfigured or malicious client still cannot get an ungated agent.[3][4]

When to prefer each: **terminal (Paths 1–2)** gives you omp's complete, already-built gated UI with zero
protocol risk; **ACP (Path 3)** gives you tighter buffer integration at the cost of depending on a
third-party plugin's ACP implementation.

---

## Security model at a glance

| Concern | How it holds in Neovim |
|---|---|
| Gate can't be omitted (inv. #4) | Neovim only spawns `lucid`; the gate decision lives in `lucid`, not your config/plugin |
| Fail-closed (inv. #3) | the TUI/`acp`/`check` refuse to start on a dead scanner or missing gate — surfaced as an error, never a silent ungated run |
| Path containment | cwd = your Neovim working directory = the boundary omp operates within |
| No escape hatch | No "custom agent command" setting; `cmd` must be a `lucid` binary or the plugin no-ops |
| Secrets | None in Neovim; credentials stay in omp's vault under `~/.omp`, inherited by the launcher |
| Untrusted content | External/retrieved text is scanned + delimited by the gate exactly as in the desktop app |

## Testing & verification

Everything above was exercised on a real host (Neovim 0.12, omp 16.3.6):

- **Gate preflight:** `lucid check` → `[lucid check] OK — gate + scanner ready` (exit 0).
- **Gated real turn through the TUI:** `lucid --model claude-haiku-4-5 -p "…"` returned the model's
  reply (`LUCID-TUI-OK`) with the gate loaded (exit 0).
- **ACP handshake through `lucid acp`:** `initialize` returned `oh-my-pi 16.3.6`, `protocolVersion 1`,
  `loadSession true`, auth method `agent` — a conformant ACP agent for Path 3 clients.
- **Plugin logic:** the pure helpers (`_build_tui_args`, `_selection_text`, `_resolve_cmd`) are asserted in
  a headless `nvim -l` run (`extensions/neovim/test/helpers_spec.lua`), driven from the Bun suite
  (`harness/launcher/neovim_plugin.test.ts`) so `bun test harness` covers them wherever nvim is installed.
- **Launcher fail-closed:** `runTui` returns non-zero and **never spawns omp** when the scanner is down —
  proven in `harness/launcher/lucid_acp.test.ts` and re-proven live in `make demo-P-NVIM.1`.

Run it yourself:

```console
$ make demo-P-NVIM.1        # args + fail-closed proof + (if nvim present) the headless helper spec
$ bun test harness/launcher # the launcher + plugin-helper tests
$ nvim --headless --clean --cmd 'set rtp^=extensions/neovim' -l extensions/neovim/test/helpers_spec.lua
```

## Notes and References

1. "ADR-0038 / P-EXT.1 — `lucid acp`, the fail-closed ACP trust anchor." *LucidAgentIDE DECISIONS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/DECISIONS.md. Accessed 4 July 2026. — The gated command reproduced by the launcher and its fail-closed startup preflight.
2. "Invariants." *LucidAgentIDE AGENTS.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/AGENTS.md. Accessed 4 July 2026. — Invariant #3 (fail-closed is law) and #4 (the gate runs in-process).
3. "Building & securely configuring the IDE extensions." *LucidAgentIDE docs/EXT-SECURE-BUILD.md*, 2026, github.com/mlcyclops/lucidagentide/blob/master/docs/EXT-SECURE-BUILD.md. Accessed 4 July 2026. — The untrusted-editor / trust-anchor model and the "no ungated escape hatch" rule reused here.
4. "Agent Client Protocol." *Zed Industries*, 2026, agentclientprotocol.com. Accessed 4 July 2026. — The stdio JSON-RPC protocol omp implements (`initialize` → `session/new` → `session/prompt`) and that Neovim ACP clients speak.
