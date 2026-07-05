# lucid.nvim

A thin Neovim client for the **gated** LUCID agent — the Neovim sibling of the VS Code + JetBrains
extensions (ADR-0038) and terminal-native counterpart to the desktop shell. Increment **P-NVIM.1**
(ADR-0150).

Like every LUCID editor integration, this plugin is an **untrusted thin client**: it only ever spawns the
`lucid` launcher (never a bare `omp`), so the in-process security gate cannot be bypassed from the editor.
It hosts omp's real, already-gated terminal UI (bare `lucid`) inside a Neovim terminal buffer rather than
reimplementing a chat UI — robust, and the gate stays anchored in `lucid`, which **fail-closes** if the
scanner sidecar is down or the gate is missing.

For the full walkthrough (including the zero-plugin `:terminal lucid` path and the ACP-client path for
inline buffer chat), see [`docs/NEOVIM.md`](../../docs/NEOVIM.md).

## Requirements

- Neovim ≥ 0.10 (uses `vim.system`; developed against 0.12).
- The **`lucid` launcher** on `PATH` (ships with LucidAgentIDE), or set `cmd` to an absolute path.
- A model configured for omp (credentials live in omp's vault under `~/.omp`; none in Neovim).

Verify the gate is live first: `lucid check` → `[lucid check] OK — gate + scanner ready`.

## Install

Published as a **`lucid.nvim` branch of the main repo** (generated from `extensions/neovim/` by CI), so
you install it standalone via the `branch` field — no separate repo, no local checkout required.

**LazyVim / lazy.nvim** — `~/.config/nvim/lua/plugins/lucid.lua`:

```lua
return {
  {
    "mlcyclops/lucidagentide",
    name = "lucid.nvim",
    branch = "lucid.nvim",
    main = "lucid",                    -- required so `opts` runs require("lucid").setup()
    cmd = { "Lucid", "LucidToggle", "LucidSend", "LucidCheck" },
    keys = {
      { "<leader>al", "<cmd>LucidToggle<cr>", desc = "Lucid: toggle" },
      { "<leader>as", "<cmd>LucidSend<cr>", desc = "Lucid: send file" },
      { "<leader>as", ":LucidSend<cr>", mode = "x", desc = "Lucid: send selection" },
      { "<leader>aC", "<cmd>LucidCheck<cr>", desc = "Lucid: gate check" },
    },
    opts = { keymaps = false },
  },
}
```

LazyVim notes: `main = "lucid"` (else lazy infers the module from the repo name); `cmd`/`keys` are
required (LazyVim lazy-loads by default); visual send uses `:LucidSend<cr>` (not `<cmd>`) so the `'<,'>`
range is applied; avoid `<leader>l…` (LazyVim's `:Lazy`).

**packer.nvim**

```lua
use({ "mlcyclops/lucidagentide", branch = "lucid.nvim", as = "lucid.nvim",
  config = function() require("lucid").setup({}) end })
```

**Local dev checkout** (working inside the monorepo):

```lua
{ dir = vim.fn.expand("~/projects/personal/lucidagentide/extensions/neovim"),
  name = "lucid.nvim", main = "lucid",
  cmd = { "Lucid", "LucidToggle", "LucidSend", "LucidCheck" }, opts = {} }
```

Outside LazyVim, `setup()` is optional — the commands work the moment the plugin is on your
`runtimepath`; `setup()` only overrides config and installs the default keymaps.

## Commands

| Command | Action |
|---------|--------|
| `:Lucid [prompt]` | Open/focus the gated Lucid terminal; optional text seeds the prompt |
| `:LucidToggle` | Show/hide the Lucid window (session keeps running while hidden) |
| `:LucidSend` | Visual range → send selection; else send the current file as `@path` |
| `:LucidCheck` | Run the fail-closed preflight (`lucid check`) |
| `:LucidStats` | Session spend + KV-cache % + context-fill (float; the GUI Memory inspector) |
| `:checkhealth lucid` | Launcher present + gate/scanner ready |

## Default keymaps

| Key | Command |
|-----|---------|
| `<leader>lc` | `:LucidToggle` |
| `<leader>ls` | `:LucidSend` |
| `<leader>lC` | `:LucidCheck` |
| `<leader>lm` | `:LucidStats` |

Set `keymaps = false` (or a per-entry `false`) to opt out and map the commands yourself.

Statusline component (spend · cache% · ctx%), for lualine / native `statusline`:

```lua
require("lualine").setup({ sections = { lualine_x = { function() return require("lucid").statusline() end } } })
-- or: vim.o.statusline = "%{v:lua.require'lucid'.statusline()}"
```

Also built in:

- **Security block banner** — when the gate quarantines a tool call, its `[BLOCKED tool_call:…]` line
  (the same signal the GUI banner parses; `ext_parity.json` contract) raises a red `vim.notify` even if
  the TUI scroll moved past it.
- **Context sparkline** — `:LucidStats` shows per-turn context growth (`history ▁▂▃▅▇`).
- `:10,20LucidSend` sends a cmdline line range (visual selections stay charwise-precise).
- `statusline = false` disables the statusline component and its poll.
- Neovim 0.10 works via a `termopen` fallback (0.11+ uses `jobstart{term=true}`).

## Configuration

```lua
require("lucid").setup({
  cmd = "lucid",          -- launcher; absolute path if not on PATH. Must be a `lucid` binary.
  tui_args = {},          -- args always passed to the gated TUI, e.g. { "--model", "claude-haiku-4-5" }
  cwd = nil,              -- workspace dir (path-containment boundary); nil = Neovim cwd
  window = "float",       -- "float" | "vsplit" | "split" | "tab"
  float = { width = 0.85, height = 0.85, border = "rounded" },
  start_insert = true,
  keymaps = { toggle = "<leader>lc", send = "<leader>ls", check = "<leader>lC" },
})
```

> There is intentionally **no setting to run a non-`lucid` command.** If `cmd` can't be resolved to a
> `lucid` launcher, the plugin errors and does nothing — it never falls back to an ungated agent.

## Tests

Pure helpers are asserted headlessly:

```console
nvim --headless --clean --cmd 'set rtp^=extensions/neovim' -l extensions/neovim/test/helpers_spec.lua
```

CI runs the same spec via the Bun suite (`harness/launcher/neovim_plugin.test.ts`, part of
`bun test harness`) wherever `nvim` is installed, and `make demo-P-NVIM.1` runs it alongside the
launcher's fail-closed proof.
