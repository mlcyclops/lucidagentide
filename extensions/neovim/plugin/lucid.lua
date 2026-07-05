-- extensions/neovim/plugin/lucid.lua
--
-- Command registration for the Lucid Neovim client. Commands work without an explicit setup() call
-- (defaults apply); call require("lucid").setup{} only to override config or install keymaps.

if vim.g.loaded_lucid then
  return
end
vim.g.loaded_lucid = true

vim.api.nvim_create_user_command("Lucid", function(o)
  require("lucid").open(o.fargs)
end, { nargs = "*", desc = "Open/focus the gated Lucid terminal (optional initial prompt)" })

vim.api.nvim_create_user_command("LucidToggle", function()
  require("lucid").toggle()
end, { desc = "Toggle the Lucid terminal window" })

vim.api.nvim_create_user_command("LucidSend", function(o)
  require("lucid").send_range(o)
end, { range = true, desc = "Send the visual selection (or current file) to Lucid" })

vim.api.nvim_create_user_command("LucidCheck", function()
  require("lucid").check()
end, { desc = "Run the fail-closed gate preflight (lucid check)" })
