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

-- _build_tui_args: always starts with the `tui` subcommand; config args then per-call extras.
eq(lucid._build_tui_args({ tui_args = {} }, {}), { "tui" }, "build_tui_args: bare")
eq(lucid._build_tui_args({}, nil), { "tui" }, "build_tui_args: nil-safe")
eq(
  lucid._build_tui_args({ tui_args = { "--model", "haiku" } }, { "-p", "hi" }),
  { "tui", "--model", "haiku", "-p", "hi" },
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

if failures == 0 then
  io.stdout:write("LUCID_NVIM_OK\n")
  os.exit(0)
end
os.exit(1)
