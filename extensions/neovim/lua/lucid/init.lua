-- extensions/neovim/lua/lucid/init.lua
--
-- P-NVIM.1 (ADR-0150) — the Neovim client for the fail-closed `lucid` launcher.
--
-- Like the VS Code + JetBrains extensions, this plugin is a THIN, untrusted client: it only ever
-- spawns the `lucid` launcher (never a bare agent), so the in-process security gate can't be bypassed
-- from the editor (invariant #4). The reliable path is the gated TUI — bare `lucid` (ADR-0161) — omp's
-- native terminal UI, run through the SAME fail-closed preflight + gated command as `lucid acp`, hosted
-- inside a Neovim terminal buffer. The TUI refuses to start if the scanner sidecar is down or the gate is missing
-- (invariant #3), so a broken/absent gate surfaces as an error, never an ungated agent.
--
-- Pure helpers (`_build_tui_args`, `_selection_text`, `_resolve_cmd`) carry the testable logic and are
-- exercised headlessly (see test/helpers_spec.lua); the terminal/window code is thin Neovim glue.

local M = {}

local defaults = {
  -- The fail-closed launcher. Installed with LucidAgentIDE / on PATH; override to an absolute path.
  -- SECURITY: only ever a `lucid` binary — this plugin can never fall back to a bare `omp`.
  cmd = "lucid",
  -- Extra args ALWAYS appended to the gated TUI launch (e.g. { "--model", "haiku" }).
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
    stats = "<leader>lm", -- open the session metrics panel (:LucidStats)
    kb = "<leader>lk", -- open the knowledge-graph viewer (:LucidKb)
    blocks = "<leader>lb", -- open the blocked-tool-call viewer (:LucidBlocks)
  },
  -- Statusline component (require("lucid").statusline()), polled from `lucid stats --json`.
  statusline = { interval = 5000, prefix = "Lucid" },
}

M.config = vim.deepcopy(defaults)

-- One shared terminal session (buffer + window + job channel).
local state = { bufnr = nil, winid = nil, chan = nil }

-- ── pure helpers (unit-tested headlessly) ───────────────────────────────────

--- Build the gated-TUI argv: bare `lucid` IS the TUI (ADR-0161) — configured `tui_args`, then any
--- extra args; no subcommand needed.
--- @param cfg table plugin config (uses cfg.tui_args)
--- @param extra string[]|nil per-invocation args (initial prompt, --model, …)
--- @return string[]
function M._build_tui_args(cfg, extra)
  local args = {}
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

-- Terminal output scanning: the security gate prints an authoritative
--   [BLOCKED tool_call:<name>] … severity=<s> … findings=<f>
-- line when it quarantines a tool call — the SAME signal the GUI block banner and ide_client.ts
-- BLOCK_RE parse. The PTY merges stderr into the terminal stream, so we watch on_stdout and raise an
-- error-notify: the GUI's security block banner, in editor form.
local outbuf = ""
local function scan_block_output(_, data)
  if type(data) ~= "table" then
    return
  end
  outbuf = outbuf .. table.concat(data, "\n")
  local pieces = vim.split(outbuf, "\n", { plain = true })
  outbuf = table.remove(pieces) or ""
  for _, l in ipairs(pieces) do
    local b = M._parse_block_line(l)
    if b then
      vim.schedule(function()
        vim.notify(
          ("Lucid gate BLOCKED tool `%s` — severity %s (%s)"):format(b.tool, b.severity, b.findings),
          vim.log.levels.ERROR
        )
      end)
    end
  end
end

--- Start the terminal job: `jobstart{term=true}` on Neovim 0.11+, `termopen` on 0.10 (same semantics —
--- both run in the CURRENT buffer, which spawn() sets first).
local function start_term(argv, opts)
  if vim.fn.has("nvim-0.11") == 1 then
    return vim.fn.jobstart(argv, vim.tbl_extend("force", opts, { term = true }))
  end
  return vim.fn.termopen(argv, opts)
end

--- Spawn a fresh gated TUI (`lucid`) in a terminal buffer. Returns true on spawn, false if fail-closed.
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
  state.chan = start_term(argv, {
    cwd = cfg.cwd,
    on_stdout = scan_block_output,
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
    local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
    local sr, sc = unpack(vim.api.nvim_buf_get_mark(0, "<"))
    local er, ec = unpack(vim.api.nvim_buf_get_mark(0, ">"))
    -- A genuine visual :'<,'>LucidSend passes exactly the mark lines as its range — the marks are fresh,
    -- send the precise (charwise) selection. Any OTHER range (`:10,20LucidSend`, `:%LucidSend`) arrives
    -- with STALE visual marks: send the requested LINES instead.
    if sr == opts.line1 and er == opts.line2 then
      M.send(M._selection_text(lines, sr, sc + 1, er, ec + 1))
    else
      M.send(table.concat(vim.list_slice(lines, opts.line1, opts.line2), "\n"))
    end
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

-- ── session metrics (spend · KV-cache · context) — mirrors the GUI Memory inspector ─────────

--- Format a 0..1 fraction as a rounded percent, e.g. "87%".
function M._pct(x)
  return string.format("%d%%", math.floor((x or 0) * 100 + 0.5))
end

--- A text progress bar for a 0..1 fraction.
function M._bar(frac, width)
  width = width or 16
  local filled = math.max(0, math.min(width, math.floor((frac or 0) * width + 0.5)))
  return "[" .. string.rep("#", filled) .. string.rep("-", width - filled) .. "]"
end

--- Parse the security gate's authoritative block line — the SAME contract the GUI banner and
--- ide_client.ts BLOCK_RE parse (cases pinned by harness/launcher/ext_parity.json).
--- @return table|nil {tool,severity,findings}
function M._parse_block_line(line)
  local tool, severity, findings = string.match(line or "", "%[BLOCKED tool_call:([%w_]+)%].-severity=(%w+).-findings=(%S+)")
  if not tool then
    return nil
  end
  return { tool = tool, severity = severity, findings = findings }
end

--- Unicode sparkline for a numeric series (downsampled to `width` points); "" for an empty series.
function M._sparkline(values, width)
  width = width or 24
  if not values or #values == 0 then
    return ""
  end
  local n = #values
  local pts = {}
  if n <= width then
    for i = 1, n do
      pts[i] = values[i]
    end
  else
    for i = 1, width do
      pts[i] = values[math.max(1, math.floor(i * n / width))]
    end
  end
  local lo, hi = math.huge, -math.huge
  for _, v in ipairs(pts) do
    lo = math.min(lo, v)
    hi = math.max(hi, v)
  end
  local ticks = { "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█" }
  local span = hi - lo
  local out = {}
  for i, v in ipairs(pts) do
    local idx = span > 0 and (1 + math.floor((v - lo) / span * 7 + 0.5)) or 1
    out[i] = ticks[math.max(1, math.min(8, idx))]
  end
  return table.concat(out)
end

--- Compact statusline string from a `lucid stats --json` session block (nil-safe).
function M._fmt_statusline(session, prefix)
  if not session then
    return ""
  end
  return string.format(
    "%s $%.2f · cache %s · ctx %s",
    prefix or "Lucid",
    session.cost or 0,
    M._pct((session.cache or {}).hit or 0),
    M._pct(session.contextFill or 0)
  )
end

--- Lines for the :LucidStats float from a `lucid stats --json --budgets` payload (nil-safe).
function M._fmt_stats_lines(data)
  local s = data and data.session or nil
  if not s then
    return { "Lucid — no omp session yet", "", "Start one with :Lucid (or `lucid`)." }
  end
  local c = s.cache or {}
  local lines = {
    "Lucid — session metrics",
    "",
    string.format("  model    %s", s.model or "?"),
    string.format("  turns    %d", s.turns or 0),
    string.format("  spend    $%.4f", s.cost or 0),
    string.format("  cache    %s hit", M._pct(c.hit or 0)),
    string.format("  context  %s %s  %d / %d", M._pct(s.contextFill or 0), M._bar(s.contextFill or 0), s.current or 0, s.window or 0),
  }
  local spark = M._sparkline(s.prompts, 24)
  if spark ~= "" then
    lines[#lines + 1] = "  history  " .. spark
  end
  if data.budgets and #data.budgets > 0 then
    local parts = {}
    for _, b in ipairs(data.budgets) do
      parts[#parts + 1] = string.format("%s %s", b.label, M._pct(b.used or 0))
    end
    lines[#lines + 1] = "  budgets  " .. table.concat(parts, " · ")
  end
  return lines
end

-- Cached statusline value, refreshed off a timer the first time statusline() is called.
M._status = ""
local status_timer = nil

local function refresh_status()
  local cmd = M._resolve_cmd(M.config)
  if not cmd then
    M._status = ""
    return
  end
  vim.system({ cmd, "stats", "--json" }, { text = true }, function(res)
    local ok, data = pcall(vim.json.decode, res.stdout or "")
    vim.schedule(function()
      local sl = M.config.statusline
      local prefix = type(sl) == "table" and sl.prefix or "Lucid"
      M._status = (ok and data) and M._fmt_statusline(data.session, prefix) or ""
    end)
  end)
end

--- Statusline component: `require("lucid").statusline()`. Returns a cached
--- "Lucid $x · cache y% · ctx z%" string; the first call starts a lightweight poll
--- (config.statusline.interval ms) reading `lucid stats --json` (session-only fast path).
function M.statusline()
  local sl = M.config.statusline
  if sl == false then
    return ""
  end
  sl = type(sl) == "table" and sl or {}
  if not status_timer then
    refresh_status()
    local interval = sl.interval or 5000
    status_timer = (vim.uv or vim.loop).new_timer()
    status_timer:start(interval, interval, vim.schedule_wrap(refresh_status))
  end
  return M._status
end

--- `:LucidStats` — open a float with the current session's spend / KV-cache / context metrics.
function M.stats()
  local cmd = M._resolve_cmd(M.config)
  if not cmd then
    notify_missing(M.config)
    return
  end
  vim.system({ cmd, "stats", "--json", "--budgets" }, { text = true }, function(res)
    local ok, data = pcall(vim.json.decode, res.stdout or "")
    vim.schedule(function()
      local lines = M._fmt_stats_lines(ok and data or {})
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
      vim.bo[buf].modifiable = false
      local width = 40
      for _, l in ipairs(lines) do
        width = math.max(width, #l + 4)
      end
      width = math.min(width, vim.o.columns - 4)
      local win = vim.api.nvim_open_win(buf, true, {
        relative = "editor",
        width = width,
        height = #lines + 1,
        row = math.floor((vim.o.lines - #lines) / 2),
        col = math.floor((vim.o.columns - width) / 2),
        style = "minimal",
        border = "rounded",
        title = " Lucid ",
        title_pos = "center",
      })
      vim.keymap.set("n", "q", "<Cmd>close<CR>", { buffer = buf, silent = true })
      vim.keymap.set("n", "<Esc>", "<Cmd>close<CR>", { buffer = buf, silent = true })
      vim.api.nvim_set_current_win(win)
    end)
  end)
end

-- ── knowledge graph viewer (:LucidKb) — the terminal-native mirror of the GUI KG browser ────────────
-- Browse the SAME ~/.omp knowledge graphs the desktop app shows: pick a KG -> pick a page -> read it.
-- The pure label/body helpers are headless-tested; the vim.ui.select + float glue is thin. Data comes
-- from the read-only `lucid kb … --json` CLI (no agent, no gate spawn — a pure read).

--- KG picker label: an active dot + name + page count (+ read-only tag). Test seam.
function M._kb_kg_label(kg)
  kg = kg or {}
  local dot = kg.active and "● " or "  "
  local ro = kg.read_only and ", read-only" or ""
  local n = kg.pages or 0
  return string.format("%s%s (%d page%s%s)", dot, kg.name or "?", n, (n == 1) and "" or "s", ro)
end

--- Page picker label: [kind] Title · slug. Test seam.
function M._kb_page_label(page)
  page = page or {}
  return string.format("[%s] %s  ·  %s", page.kind or "?", page.title or "(untitled)", page.slug or "")
end

--- Body lines for the page float: a title header + provenance line, then the markdown body. Test seam.
function M._kb_body_lines(page)
  page = page or {}
  local lines = {
    "# " .. (page.title or "(untitled)"),
    string.format("(%s · %s · %s)", page.kind or "?", page.slug or "", page.trust_label or "untrusted"),
    "",
  }
  for _, l in ipairs(vim.split(page.body_md or "", "\n", { plain = true })) do
    lines[#lines + 1] = l
  end
  return lines
end

-- Run `lucid kb <args…> --json`, decode, and hand the result (or nil) to cb on the main loop.
local function kb_run(cmd, args, cb)
  local argv = { cmd, "kb" }
  for _, a in ipairs(args) do
    argv[#argv + 1] = a
  end
  argv[#argv + 1] = "--json"
  vim.system(argv, { text = true }, function(res)
    local ok, data = pcall(vim.json.decode, (res and res.stdout) or "")
    vim.schedule(function()
      cb(ok and data or nil)
    end)
  end)
end

-- Open a page body in a read-only, markdown, floating scratch buffer (q / <Esc> to close).
local function open_kb_page(cfg, page)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, M._kb_body_lines(page))
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = "markdown"
  local fl = (type(cfg.float) == "table") and cfg.float or {}
  local width = math.floor(vim.o.columns * (fl.width or 0.85))
  local height = math.floor(vim.o.lines * (fl.height or 0.85))
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
    style = "minimal",
    border = fl.border or "rounded",
    title = " " .. (page.title or "KG page") .. " ",
    title_pos = "center",
  })
  vim.keymap.set("n", "q", "<Cmd>close<CR>", { buffer = buf, silent = true })
  vim.keymap.set("n", "<Esc>", "<Cmd>close<CR>", { buffer = buf, silent = true })
  vim.api.nvim_set_current_win(win)
end

--- `:LucidKb` — browse the knowledge graph: pick a KG -> pick a page -> read it. Uses vim.ui.select, so
--- your configured picker (telescope/fzf-lua/snacks) drives it with ZERO extra dependency; type to filter.
function M.kb()
  local cmd = M._resolve_cmd(M.config)
  if not cmd then
    notify_missing(M.config)
    return
  end
  local cfg = M.config
  local function browse(kg)
    kb_run(cmd, { "pages", "--kg", kg.kg_id }, function(pages)
      if type(pages) ~= "table" or #pages == 0 then
        vim.notify('Lucid: "' .. (kg.name or "KG") .. '" has no pages yet.', vim.log.levels.INFO)
        return
      end
      vim.ui.select(pages, { prompt = "Page in " .. (kg.name or "KG"), format_item = M._kb_page_label }, function(page)
        if not page then
          return
        end
        kb_run(cmd, { "show", page.page_id, "--kg", kg.kg_id }, function(full)
          if type(full) ~= "table" or not full.title then
            vim.notify("Lucid: could not load that page.", vim.log.levels.WARN)
            return
          end
          open_kb_page(cfg, full)
        end)
      end)
    end)
  end
  kb_run(cmd, { "list" }, function(kgs)
    if type(kgs) ~= "table" or #kgs == 0 then
      vim.notify("Lucid: no knowledge graphs yet (seed one in the app or import a pack).", vim.log.levels.INFO)
      return
    end
    -- active KG first, so the default matches what the app is on.
    table.sort(kgs, function(a, b)
      local av, bv = a.active and 1 or 0, b.active and 1 or 0
      return av > bv
    end)
    if #kgs == 1 then
      browse(kgs[1])
    else
      vim.ui.select(kgs, { prompt = "Knowledge graph", format_item = M._kb_kg_label }, function(kg)
        if kg then
          browse(kg)
        end
      end)
    end
  end)
end

-- ── blocked-tool-call viewer (:LucidBlocks) — the GUI Security panel, in Neovim ──────────────────────
-- Lists what the in-process security gate quarantined (the SAME data the GUI panel shows), via the
-- read-only `lucid blocks` CLI (the lock-free block log + the DuckDB quarantines). The line builder is
-- headless-tested; the float glue is thin.

--- Format block rows (from `lucid blocks --json`) into display lines. Test seam.
function M._blocks_lines(blocks)
  if type(blocks) ~= "table" or #blocks == 0 then
    return { "No blocked tool calls — the security gate has quarantined nothing." }
  end
  local lines = {}
  for _, b in ipairs(blocks) do
    b = b or {}
    local sev = (b.severity and b.severity ~= "") and (" · " .. b.severity) or ""
    local f = (b.findings and b.findings ~= "") and (" · " .. b.findings) or ""
    local st = (b.status and b.status ~= "quarantined") and (" [" .. b.status .. "]") or ""
    local when = (b.at and b.at ~= "") and ("  (" .. b.at .. ")") or ""
    lines[#lines + 1] = string.format("🛡️  %s%s%s%s  —  %s%s", b.tool or "tool", sev, f, st, b.reason or "", when)
  end
  return lines
end

--- `:LucidBlocks` — a read-only float listing the tool calls the security gate blocked (quarantined),
--- the terminal-native mirror of the GUI Security panel. Data comes from the read-only `lucid blocks` CLI.
function M.blocks()
  local cmd = M._resolve_cmd(M.config)
  if not cmd then
    notify_missing(M.config)
    return
  end
  vim.system({ cmd, "blocks", "--json" }, { text = true }, function(res)
    local ok, data = pcall(vim.json.decode, (res and res.stdout) or "")
    vim.schedule(function()
      local lines = M._blocks_lines(ok and data or {})
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
      vim.bo[buf].modifiable = false
      local width = 60
      for _, l in ipairs(lines) do
        width = math.max(width, vim.fn.strdisplaywidth(l) + 4)
      end
      width = math.min(width, vim.o.columns - 4)
      local height = math.min(#lines + 1, math.max(3, vim.o.lines - 4))
      local win = vim.api.nvim_open_win(buf, true, {
        relative = "editor",
        width = width,
        height = height,
        row = math.floor((vim.o.lines - height) / 2),
        col = math.floor((vim.o.columns - width) / 2),
        style = "minimal",
        border = "rounded",
        title = " Lucid — blocked tool calls ",
        title_pos = "center",
      })
      vim.keymap.set("n", "q", "<Cmd>close<CR>", { buffer = buf, silent = true })
      vim.keymap.set("n", "<Esc>", "<Cmd>close<CR>", { buffer = buf, silent = true })
      vim.api.nvim_set_current_win(win)
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
  if km.stats then
    vim.keymap.set("n", km.stats, "<Cmd>LucidStats<CR>", { silent = true, desc = "Lucid: session metrics" })
  end
  if km.kb then
    vim.keymap.set("n", km.kb, "<Cmd>LucidKb<CR>", { silent = true, desc = "Lucid: knowledge graph" })
  end
  if km.blocks then
    vim.keymap.set("n", km.blocks, "<Cmd>LucidBlocks<CR>", { silent = true, desc = "Lucid: blocked tool calls" })
  end
end

return M
