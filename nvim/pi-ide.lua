-- Pi IDE endpoint: start a Neovim server (if needed), publish a discovery
-- lock file with a token, and clean it up on exit. Load from init.lua:
--   dofile("/home/danil/w/pi-core/nvim/pi-ide.lua")
local dir = vim.env.PI_IDE_DIR
if not dir or dir == "" then
  dir = (vim.env.XDG_RUNTIME_DIR or vim.fn.stdpath("run")) .. "/pi-ide"
end
vim.fn.mkdir(dir, "p")

local socket = vim.v.servername
if socket == "" then
  socket = dir .. "/" .. vim.fn.getpid() .. ".sock"
  local ok, started = pcall(vim.fn.serverstart, socket)
  if not ok or started == 0 then
    vim.notify("Pi IDE: could not start a Neovim server", vim.log.levels.ERROR)
    return
  end
end

local token = vim.env.PI_IDE_TOKEN
if not token or token == "" then
  token = vim.fn.sha256(table.concat({ tostring(os.time()), tostring(vim.fn.getpid()), tostring(math.random()) }, ":")):sub(1, 32)
end
_G.pi_ide_token = token

local lock = dir .. "/" .. vim.fn.getpid() .. ".lock"
local function write()
  local data = {
    pid = vim.fn.getpid(),
    socket = socket,
    workspaceFolders = { vim.fn.getcwd() },
    ideName = "pi-nvim",
    transport = "unix",
    authToken = token,
    updatedAt = os.time(),
  }
  local ok = pcall(vim.fn.writefile, { vim.json.encode(data) }, lock)
  if ok then pcall(vim.fn.setfperm, lock, "rw-------") end
end
write()

local group = vim.api.nvim_create_augroup("PiIdeLock", { clear = true })
vim.api.nvim_create_autocmd("DirChanged", { group = group, callback = write })
vim.api.nvim_create_autocmd("VimLeavePre", {
  group = group,
  callback = function() pcall(os.remove, lock) end,
})

vim.api.nvim_create_user_command("PiIdeStatus", function()
  vim.notify(("Pi IDE: %s · workspace %s"):format(socket, vim.fn.getcwd()))
end, { desc = "Show the Pi IDE endpoint" })
