-- Headless RPC shim: send one request to a listening Neovim and print JSON.
local socket = vim.env.PI_TOUR_SOCKET
local request = vim.json.decode(vim.env.PI_TOUR_REQUEST or "{}")
local bridge = vim.env.PI_TOUR_BRIDGE
local channel

local ok, result = pcall(function()
  if not socket or socket == "" then error("Set PI_TOUR_SOCKET or DUET_NVIM_SOCKET to the socket used by nvim --listen") end
  channel = vim.fn.sockconnect("pipe", socket, { rpc = true })
  if channel == 0 then error("Cannot connect to Neovim socket: " .. socket) end
  return vim.rpcrequest(channel, "nvim_exec_lua", [[
    local path, request, version = ...
    if not _G.pi_tour_bridge or _G.pi_tour_bridge_path ~= path or _G.pi_tour_bridge_version ~= version then
      _G.pi_tour_bridge = dofile(path)
      _G.pi_tour_bridge_path = path
      _G.pi_tour_bridge_version = version
    end
    return _G.pi_tour_bridge.request(request)
  ]], { bridge, request, vim.env.PI_TOUR_BRIDGE_VERSION })
end)

if channel and channel ~= 0 then vim.fn.chanclose(channel) end
io.stdout:write(vim.json.encode({ ok = ok, result = ok and result or nil, error = not ok and tostring(result) or nil }) .. "\n")
io.stdout:flush()
vim.cmd(ok and "qa!" or "cq")
