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

if failures == 0 then
  io.stdout:write("LUCID_NVIM_OK\n")
  os.exit(0)
end
os.exit(1)
