-- extensions/neovim/lua/lucid/health.lua
--
-- `:checkhealth lucid` — verify the launcher is present and the fail-closed gate + scanner are ready by
-- running `lucid check` (the same preflight `lucid acp`/`lucid tui` run before spawning). A red health
-- check here is the fail-closed gate refusing an ungated agent, not a plugin bug.

local M = {}

local function start(name)
  -- vim.health.start (0.10+) with a fallback to the older report_* API.
  if vim.health and vim.health.start then
    vim.health.start(name)
  else
    vim.health.report_start(name)
  end
end

local function ok(msg)
  (vim.health.ok or vim.health.report_ok)(msg)
end

local function err(msg)
  (vim.health.error or vim.health.report_error)(msg)
end

function M.check()
  start("lucid")
  local cfg = require("lucid").config
  local cmd = cfg.cmd or "lucid"
  if vim.fn.executable(cmd) ~= 1 then
    err("launcher `" .. cmd .. "` not found on PATH — install LucidAgentIDE or set cmd to an absolute path")
    return
  end
  ok("launcher: " .. cmd)

  local res = vim.system({ cmd, "check" }, { text = true }):wait()
  local out = vim.trim((res.stdout or "") .. (res.stderr or ""))
  if res.code == 0 then
    ok(out ~= "" and out or "gate + scanner ready")
  else
    err("fail-closed — " .. (out ~= "" and out or ("`lucid check` exited " .. tostring(res.code))))
  end
end

return M
