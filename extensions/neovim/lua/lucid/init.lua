-- extensions/neovim/lua/lucid/init.lua
--
-- P-NVIM.1 (ADR-0150) — the Neovim client for the fail-closed `lucid` launcher.
--
-- Like the VS Code + JetBrains extensions, this plugin is a THIN, untrusted client: it only ever
-- spawns the `lucid` launcher (never a bare agent), so the in-process security gate can't be bypassed
-- from the editor (invariant #4). The reliable path is `lucid tui` — omp's native terminal UI, run
-- through the SAME fail-closed preflight + gated command as `lucid acp`, hosted inside a Neovim
-- terminal buffer. `lucid tui` refuses to start if the scanner sidecar is down or the gate is missing
-- (invariant #3), so a broken/absent gate surfaces as an error, never an ungated agent.
--
-- Pure helpers (`_build_tui_args`, `_selection_text`, `_resolve_cmd`) carry the testable logic and are
-- exercised headlessly (see test/helpers_spec.lua); the terminal/window code is thin Neovim glue.

local M = {}

local defaults = {
  -- The fail-closed launcher. Installed with LucidAgentIDE / on PATH; override to an absolute path.
  -- SECURITY: only ever a `lucid` binary — this plugin can never fall back to a bare `omp`.
  cmd = "lucid",
  -- Extra args ALWAYS appended to `lucid tui` (e.g. { "--model", "haiku" }).
  tui_args = {},
  -- Workspace dir = the path-containment boundary. nil = Neovim's cwd.
  cwd = nil,
  -- "float" | "vsplit" | "split" | "tab"
  window = "float",
  float = { width = 0.85, height = 0.85, border = "rounded" },
  -- Enter terminal insert-mode when the window opens.
  start_insert = true,
  -- Default keymaps; set the whole table (or an entry) to false to disable.
  keymaps = {
    toggle = "<leader>lc", -- toggle the Lucid terminal
    send = "<leader>ls", -- send visual selection / current file to Lucid
    check = "<leader>lC", -- run the fail-closed gate preflight (`lucid check`)
  },
}

M.config = vim.deepcopy(defaults)

-- One shared terminal session (buffer + window + job channel).
local state = { bufnr = nil, winid = nil, chan = nil }

-- ── pure helpers (unit-tested headlessly) ───────────────────────────────────

--- Build the `lucid tui` argv: the `tui` subcommand, then configured `tui_args`, then any extra args.
--- @param cfg table plugin config (uses cfg.tui_args)
--- @param extra string[]|nil per-invocation args (initial prompt, --model, …)
--- @return string[]
function M._build_tui_args(cfg, extra)
  local args = { "tui" }
  for _, a in ipairs(cfg.tui_args or {}) do
    args[#args + 1] = a
  end
  for _, a in ipairs(extra or {}) do
    args[#args + 1] = a
  end
  return args
end

--- Extract the text of a selection from `lines` (the buffer's 1-indexed line array), clamping
--- (srow,scol)..(erow,ecol). Rows + cols are 1-indexed, cols inclusive; an over-long ecol (e.g. a
--- linewise `$`) is clamped to the line length by string.sub.
--- @return string
function M._selection_text(lines, srow, scol, erow, ecol)
  if srow > erow or (srow == erow and scol > ecol) then
    srow, scol, erow, ecol = erow, ecol, srow, scol
  end
  local out = {}
  for r = srow, erow do
    local line = lines[r] or ""
    local a = (r == srow) and scol or 1
    local b = (r == erow) and ecol or #line
    out[#out + 1] = string.sub(line, a, b)
  end
  return table.concat(out, "\n")
end

--- Resolve the launcher command, FAIL-CLOSED: return the configured `lucid` command iff it is
--- executable, else nil. Never returns any non-lucid fallback (the gate-in-process guarantee).
--- @param cfg table
--- @param is_exec fun(cmd:string):boolean|nil injectable for tests; defaults to vim.fn.executable
--- @return string|nil
function M._resolve_cmd(cfg, is_exec)
  is_exec = is_exec or function(c)
    return vim.fn.executable(c) == 1
  end
  local cmd = cfg.cmd or "lucid"
  if is_exec(cmd) then
    return cmd
  end
  return nil
end

-- ── terminal + window glue ──────────────────────────────────────────────────

local function buf_valid()
  return state.bufnr ~= nil and vim.api.nvim_buf_is_valid(state.bufnr)
end

local function win_open()
  return state.winid ~= nil and vim.api.nvim_win_is_valid(state.winid)
end

--- Open a window hosting state.bufnr per cfg.window.
function M._open_window(cfg)
  if cfg.window == "float" then
    local cols, rows = vim.o.columns, vim.o.lines
    local w = math.floor(cols * (cfg.float.width or 0.85))
    local h = math.floor(rows * (cfg.float.height or 0.85))
    state.winid = vim.api.nvim_open_win(state.bufnr, true, {
      relative = "editor",
      width = w,
      height = h,
      row = math.floor((rows - h) / 2),
      col = math.floor((cols - w) / 2),
      style = "minimal",
      border = cfg.float.border or "rounded",
      title = " Lucid ",
      title_pos = "center",
    })
  else
    local cmd = ({ vsplit = "vsplit", split = "split", tab = "tabnew" })[cfg.window] or "vsplit"
    vim.cmd(cmd)
    state.winid = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(state.winid, state.bufnr)
  end
end

local function notify_missing(cfg)
  vim.notify(
    ("lucid: launcher `%s` not found on PATH — install LucidAgentIDE (this plugin never falls back to an ungated agent)."):format(
      cfg.cmd or "lucid"
    ),
    vim.log.levels.ERROR
  )
end

--- Spawn a fresh gated `lucid tui` in a terminal buffer. Returns true on spawn, false if fail-closed.
local function spawn(cfg, extra)
  local cmd = M._resolve_cmd(cfg)
  if not cmd then
    notify_missing(cfg)
    return false
  end
  local argv = { cmd }
  vim.list_extend(argv, M._build_tui_args(cfg, extra))
  state.bufnr = vim.api.nvim_create_buf(false, true)
  M._open_window(cfg)
  vim.api.nvim_set_current_buf(state.bufnr)
  state.chan = vim.fn.jobstart(argv, {
    term = true,
    cwd = cfg.cwd,
    on_exit = function()
      state.chan = nil
    end,
  })
  vim.b[state.bufnr].lucid_terminal = true
  return true
end

--- Open / focus the Lucid terminal. Spawns one if needed; `extra` seeds a new session's prompt or is
--- sent to a running one.
function M.open(extra)
  local cfg = M.config
  if buf_valid() then
    if not win_open() then
      M._open_window(cfg)
      vim.api.nvim_win_set_buf(state.winid, state.bufnr)
    else
      vim.api.nvim_set_current_win(state.winid)
    end
    if extra and #extra > 0 and state.chan then
      vim.api.nvim_chan_send(state.chan, table.concat(extra, " "))
    end
  elseif not spawn(cfg, extra) then
    return
  end
  if cfg.start_insert then
    vim.cmd.startinsert()
  end
end

--- Show/hide the Lucid terminal window (the buffer + job keep running while hidden).
function M.toggle()
  if win_open() then
    vim.api.nvim_win_close(state.winid, false)
    state.winid = nil
  else
    M.open()
  end
end

--- Send text into the running Lucid terminal (opening one first if needed). No trailing newline, so it
--- lands in omp's composer for the user to complete + submit.
function M.send(text)
  if not (buf_valid() and state.chan) then
    M.open()
  end
  if state.chan then
    vim.api.nvim_chan_send(state.chan, text)
    M.open()
  end
end

--- `:LucidSend` — a visual range sends the selection; otherwise send the current file as an `@path`
--- reference (omp reads it through the gate).
function M.send_range(opts)
  if opts and opts.range and opts.range > 0 then
    local sr, sc = unpack(vim.api.nvim_buf_get_mark(0, "<"))
    local er, ec = unpack(vim.api.nvim_buf_get_mark(0, ">"))
    local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
    M.send(M._selection_text(lines, sr, sc + 1, er, ec + 1))
  else
    local rel = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ":.")
    if rel == "" then
      vim.notify("lucid: no file to send", vim.log.levels.WARN)
      return
    end
    M.send("@" .. rel .. " ")
  end
end

--- `:LucidCheck` — run the fail-closed gate preflight (`lucid check`) and report the verdict.
function M.check()
  local cmd = M._resolve_cmd(M.config)
  if not cmd then
    notify_missing(M.config)
    return
  end
  vim.system({ cmd, "check" }, { text = true }, function(res)
    vim.schedule(function()
      local out = vim.trim((res.stdout or "") .. (res.stderr or ""))
      local lvl = res.code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR
      vim.notify("lucid check: " .. (out ~= "" and out or ("exit " .. tostring(res.code))), lvl)
    end)
  end)
end

--- Merge user opts over defaults and install the default keymaps.
function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
  local km = M.config.keymaps
  if not km then
    return
  end
  if km.toggle then
    vim.keymap.set("n", km.toggle, "<Cmd>LucidToggle<CR>", { silent = true, desc = "Lucid: toggle terminal" })
  end
  if km.send then
    vim.keymap.set("n", km.send, "<Cmd>LucidSend<CR>", { silent = true, desc = "Lucid: send current file" })
    vim.keymap.set("x", km.send, ":LucidSend<CR>", { silent = true, desc = "Lucid: send selection" })
  end
  if km.check then
    vim.keymap.set("n", km.check, "<Cmd>LucidCheck<CR>", { silent = true, desc = "Lucid: gate check" })
  end
end

return M
