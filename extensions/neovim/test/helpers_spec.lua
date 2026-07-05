-- extensions/neovim/test/helpers_spec.lua
--
-- Headless assertions for the Lucid plugin's PURE helpers. Run with:
--   nvim --headless --clean --cmd 'set rtp^=extensions/neovim' -l extensions/neovim/test/helpers_spec.lua
-- Prints LUCID_NVIM_OK and exits 0 on success; exits 1 on the first failure. Driven from the Bun suite
-- (harness/launcher/neovim_plugin.test.ts) so `bun test harness` covers it wherever nvim is installed.

local lucid = require("lucid")

local failures = 0
local function eq(got, want, msg)
  if vim.deep_equal(got, want) then
    return
  end
  failures = failures + 1
  io.stderr:write(("FAIL %s\n  want: %s\n  got:  %s\n"):format(msg, vim.inspect(want), vim.inspect(got)))
end

-- _build_tui_args: bare `lucid` IS the gated TUI (ADR-0161) — no subcommand; config args then per-call extras.
eq(lucid._build_tui_args({ tui_args = {} }, {}), {}, "build_tui_args: bare")
eq(lucid._build_tui_args({}, nil), {}, "build_tui_args: nil-safe")
eq(
  lucid._build_tui_args({ tui_args = { "--model", "haiku" } }, { "-p", "hi" }),
  { "--model", "haiku", "-p", "hi" },
  "build_tui_args: config args + extras, in order"
)

-- _selection_text: 1-indexed rows/cols, inclusive; over-long ecol clamps to line length.
local lines = { "local x = 1", "print(x)" }
eq(lucid._selection_text(lines, 1, 7, 1, 11), "x = 1", "selection: single line charwise")
eq(lucid._selection_text(lines, 1, 1, 2, 8), "local x = 1\nprint(x)", "selection: multi line")
eq(lucid._selection_text(lines, 1, 1, 1, 2147483647), "local x = 1", "selection: linewise ecol clamps")
eq(lucid._selection_text(lines, 2, 1, 1, 5), "l x = 1\np", "selection: reversed multi-line range normalizes (point-swap)")
eq(lucid._selection_text(lines, 1, 11, 1, 7), "x = 1", "selection: reversed same-line cols normalize")

-- _resolve_cmd: fail-closed — returns the lucid command only when executable, never a fallback.
eq(lucid._resolve_cmd({ cmd = "lucid" }, function()
  return false
end), nil, "resolve_cmd: missing launcher -> nil (fail-closed)")
eq(lucid._resolve_cmd({ cmd = "/opt/lucid" }, function(c)
  return c == "/opt/lucid"
end), "/opt/lucid", "resolve_cmd: present launcher -> the command")

-- _pct / _bar: metric formatting.
eq(lucid._pct(0.876), "88%", "pct: rounds")
eq(lucid._pct(0.05), "5%", "pct: small")
eq(lucid._pct(nil), "0%", "pct: nil-safe")
eq(lucid._bar(0.5, 4), "[##--]", "bar: half")
eq(lucid._bar(0, 4), "[----]", "bar: empty")
eq(lucid._bar(1, 4), "[####]", "bar: full")

-- _fmt_statusline: compact spend/cache/ctx line (nil-safe).
eq(lucid._fmt_statusline(nil), "", "statusline: nil session -> empty")
eq(
  lucid._fmt_statusline({ cost = 0.42, cache = { hit = 0.87 }, contextFill = 0.34 }, "Lucid"),
  "Lucid $0.42 · cache 87% · ctx 34%",
  "statusline: spend + cache% + ctx%"
)

-- _fmt_stats_lines: float body (nil-safe + populated).
eq(lucid._fmt_stats_lines({})[1], "Lucid — no omp session yet", "stats lines: no session")
local sl = lucid._fmt_stats_lines({ session = { model = "m", turns = 2, cost = 0.08, cache = { hit = 0.9 }, contextFill = 0.05, current = 100, window = 1000 } })
eq(sl[1], "Lucid — session metrics", "stats lines: header")
eq(sl[5], "  spend    $0.0800", "stats lines: spend")
eq(sl[6], "  cache    90% hit", "stats lines: cache")

-- _parse_block_line: the gate's authoritative block signal (cases mirror harness/launcher/ext_parity.json).
eq(
  lucid._parse_block_line("🛡️ [BLOCKED tool_call:write] reason=hidden-unicode severity=high findings=zero-width×2"),
  { tool = "write", severity = "high", findings = "zero-width×2" },
  "block: emoji-prefixed with reason field"
)
eq(
  lucid._parse_block_line("[BLOCKED tool_call:bash] severity=critical findings=bidi-control"),
  { tool = "bash", severity = "critical", findings = "bidi-control" },
  "block: plain"
)
eq(lucid._parse_block_line("ordinary log line, not a block"), nil, "block: ordinary line -> nil")
eq(lucid._parse_block_line("[BLOCKED] malformed without fields"), nil, "block: malformed -> nil")

-- _sparkline: shape + degenerate cases.
eq(lucid._sparkline({}), "", "sparkline: empty -> empty string")
eq(lucid._sparkline({ 5, 5, 5 }), "▁▁▁", "sparkline: flat series -> floor ticks")
eq(lucid._sparkline({ 1, 8 }), "▁█", "sparkline: min -> max")
eq(vim.fn.strchars(lucid._sparkline({ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 }, 5)), 5, "sparkline: downsamples to width")

-- sparkline row appears in the float when prompts are present.
local sl2 = lucid._fmt_stats_lines({ session = { model = "m", turns = 2, cost = 0, cache = {}, contextFill = 0, current = 0, window = 1, prompts = { 10, 20, 40 } } })
local found = false
for _, l in ipairs(sl2) do
  if l:match("^  history  ") then
    found = true
  end
end
eq(found, true, "stats lines: history sparkline row present")

-- statusline: `statusline = false` disables cleanly (no crash, empty string, no timer).
local saved = lucid.config.statusline
lucid.config.statusline = false
eq(lucid.statusline(), "", "statusline: false -> empty, no crash")
lucid.config.statusline = saved

-- WIRING proof for the block banner (not just the parser): a term=true/termopen job is a PTY job whose
-- on_stdout receives the MERGED stream — including stderr, where the gate writes its [BLOCKED …] line.
-- Run a real PTY job that emits the parity line to STDERR and assert on_stdout delivered a parseable
-- line (PTY adds \r — the parser's %S+ must stop before it).
if vim.fn.has("unix") == 1 then
  local captured = {}
  local exited = false
  local blockline = "[BLOCKED tool_call:write] severity=high findings=zero-width×2"
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_current_buf(buf)
  local opts = {
    on_stdout = function(_, data)
      if type(data) == "table" then
        for _, l in ipairs(data) do
          captured[#captured + 1] = l
        end
      end
    end,
    on_exit = function()
      exited = true
    end,
  }
  local argv = { "sh", "-c", "printf '%s\\n' '" .. blockline .. "' 1>&2" }
  if vim.fn.has("nvim-0.11") == 1 then
    vim.fn.jobstart(argv, vim.tbl_extend("force", opts, { term = true }))
  else
    vim.fn.termopen(argv, opts)
  end
  vim.wait(5000, function()
    return exited
  end, 50)
  local parsed = nil
  for _, l in ipairs(captured) do
    parsed = parsed or lucid._parse_block_line(l)
  end
  eq(parsed, { tool = "write", severity = "high", findings = "zero-width×2" }, "wiring: PTY on_stdout delivers the gate's stderr block line")
end

if failures == 0 then
  io.stdout:write("LUCID_NVIM_OK\n")
  os.exit(0)
end
os.exit(1)
