local M = {}
local ns = vim.api.nvim_create_namespace("pi_tour")
local ns_comments = vim.api.nvim_create_namespace("pi_comments")
local limit = 32768
local show
local diffs = {}
local state = _G.pi_ide_bridge_state or { tour = nil, socket = nil, comments = {}, selection = nil }
_G.pi_ide_bridge_state = state

local function guard(request)
  if _G.pi_ide_token and request.token and request.token ~= _G.pi_ide_token then
    error("Invalid Pi IDE token")
  end
end

local function capture_selection()
  local mode = vim.fn.mode()
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then return end
  local buf = vim.api.nvim_get_current_buf()
  local first, last = vim.fn.getpos("v"), vim.fn.getpos(".")
  local lines = vim.fn.getregion(first, last, { type = mode, exclusive = vim.o.selection == "exclusive" })
  local text = table.concat(lines, "\n")
  state.selection = {
    file = vim.api.nvim_buf_get_name(buf),
    text = text:sub(1, 32768),
    truncated = #text > 32768,
    start = { line = first[2], byte_column = first[3] },
    finish = { line = last[2], byte_column = last[3] },
    mode = mode,
    changedtick = vim.api.nvim_buf_get_changedtick(buf),
  }
end
do
  local group = vim.api.nvim_create_augroup("PiIdeSelection", { clear = true })
  vim.api.nvim_create_autocmd({ "CursorMoved", "ModeChanged" }, {
    group = group,
    callback = function() pcall(capture_selection) end,
  })
end

local function finish_diff(id, status, lines)
  local diff = diffs[id]
  if not diff then return false end
  diffs[id] = nil
  local payload = { status = status }
  if lines then payload.content = table.concat(lines, "\n") .. (#lines > 0 and "\n" or "") end
  pcall(vim.fn.writefile, { vim.json.encode(payload) }, diff.result_path)
  pcall(function() vim.bo[diff.new_buf].modified = false end)
  pcall(function() if vim.api.nvim_win_is_valid(diff.new_win) then vim.api.nvim_win_close(diff.new_win, true) end end)
  pcall(function() if vim.api.nvim_buf_is_valid(diff.new_buf) then vim.api.nvim_buf_delete(diff.new_buf, { force = true }) end end)
  pcall(function()
    if vim.api.nvim_win_is_valid(diff.orig_win) then vim.api.nvim_set_current_win(diff.orig_win); vim.cmd("diffoff!") end
  end)
  return true
end

local function real(path)
  return vim.uv.fs_realpath(path)
end
local function allowed(file, root)
  local actual, base = real(file), real(root)
  if not actual or not base or (actual ~= base and actual:sub(1, #base + 1) ~= base .. "/") then
    error("File must exist inside the Pi project directory")
  end
  return actual
end

local function open_window(buf)
  local win = vim.fn.bufwinid(buf)
  if win ~= -1 then
    vim.api.nvim_set_current_win(win)
    return
  end
  local current = vim.api.nvim_get_current_buf()
  if current ~= buf and vim.bo[current].modified then vim.cmd("vsplit") end
  vim.api.nvim_win_set_buf(0, buf)
end

M.tour = state.tour
M.socket = state.socket
M.comments = state.comments

local function notify(message, level)
  pcall(vim.notify, message, level or vim.log.levels.INFO)
end

local function send(message)
  if not M.socket or M.socket == "" then return false end
  local ok, channel = pcall(vim.fn.sockconnect, "pipe", M.socket, { rpc = false })
  if not ok or channel == 0 then return false end
  local blob = vim.json.encode(message) .. "\n"
  vim.fn.chansend(channel, blob)
  vim.fn.chanclose(channel)
  return true
end

local function find_comment(id)
  for _, entry in ipairs(state.comments) do
    if tostring(entry.id) == tostring(id) then return entry end
  end
  return nil
end

local function clear_comments(buf)
  vim.api.nvim_buf_clear_namespace(buf, ns_comments, 0, -1)
end

function M.render_comments()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then clear_comments(buf) end
  end
  for _, entry in ipairs(state.comments) do
    local buf = vim.fn.bufnr(entry.file)
    if buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) then
      local count = vim.api.nvim_buf_line_count(buf)
      local row = math.max(0, math.min(entry.from - 1, count - 1))
      local status = entry.status or "open"
      local chip = ("💬 #%s %s"):format(entry.id, status)
      pcall(vim.api.nvim_buf_set_extmark, buf, ns_comments, row, 0, {
        end_row = math.min(entry.to or entry.from, count),
        line_hl_group = "Visual",
        hl_eol = true,
      })
      pcall(vim.api.nvim_buf_set_extmark, buf, ns_comments, row, 0, {
        virt_text = { { " " .. chip .. "  " .. entry.text:gsub("\n", " "):sub(1, 120), status == "resolved" and "Comment" or "Special" } },
        virt_text_pos = "eol",
      })
      local replies = entry.replies or {}
      local virt = {}
      for index, reply in ipairs(replies) do
        if index > 5 then break end
        virt[#virt + 1] = { { ("  ↳ %s: %s"):format(reply.author or "pi", tostring(reply.text):gsub("\n", " "):sub(1, 160)), "Comment" } }
      end
      if #replies > 5 then virt[#virt + 1] = { { ("  ↳ … %d more"):format(#replies - 5), "Comment" } } end
      if #virt > 0 then
        pcall(vim.api.nvim_buf_set_extmark, buf, ns_comments, row, 0, { virt_lines = virt })
      end
    end
  end
end

local function comment(text, first, last, target)
  local file = target or vim.api.nvim_buf_get_name(0)
  if file == "" or text == "" then return nil end
  state.comment_seq = (state.comment_seq or 0) + 1
  local id = tostring(state.comment_seq)
  local entry = { id = id, file = file, from = first, to = last, text = text:sub(1, 4000), status = "open", replies = {} }
  table.insert(state.comments, entry)
  local message = { type = "comment", id = id, file = file, from = first, to = last, text = entry.text }
  if not send(message) then
    notify("Pi comment: session is not connected", vim.log.levels.WARN)
    return id
  end
  M.render_comments()
  notify(("Pi comment #%s sent: %s:%d-%d"):format(id, vim.fn.fnamemodify(file, ":t"), first, last))
  return id
end

function M.comment_list()
  local list = {}
  for _, entry in ipairs(state.comments) do
    list[#list + 1] = { id = entry.id, file = entry.file, from = entry.from, to = entry.to, status = entry.status or "open", text = entry.text, replies = #(entry.replies or {}) }
  end
  return list
end

function M.comment_jump(id)
  local entry = find_comment(id)
  if not entry then error("Unknown comment id") end
  vim.cmd("edit " .. vim.fn.fnameescape(entry.file))
  vim.api.nvim_win_set_cursor(0, { math.max(1, entry.from), 0 })
  vim.cmd("normal! zz")
  return { id = entry.id, file = entry.file, from = entry.from }
end

function M.comment_pick()
  if #state.comments == 0 then notify("Pi: no comments", vim.log.levels.INFO) return end
  if vim.ui and vim.ui.select then
    vim.ui.select(state.comments, {
      prompt = "Pi comments",
      format_item = function(entry)
        return ("#%s %s:%d %s — %s"):format(entry.id, vim.fn.fnamemodify(entry.file, ":t"), entry.from, entry.status or "open", entry.text:sub(1, 60))
      end,
    }, function(choice)
      if choice then pcall(M.comment_jump, choice.id) end
    end)
  else
    for _, entry in ipairs(state.comments) do
      notify(("#%s %s:%d [%s] %s"):format(entry.id, entry.file, entry.from, entry.status or "open", entry.text))
    end
  end
end

function M.comment_resolve(id)
  local entry = find_comment(id)
  if not entry then error("Unknown comment id") end
  entry.status = "resolved"
  M.render_comments()
  return { id = entry.id, status = entry.status }
end

function M.comment_current()
  comment(vim.fn.input("Pi comment: "), vim.fn.line("."), vim.fn.line("."))
end
function M.comment_visual()
  local first, last = vim.fn.line("'<"), vim.fn.line("'>")
  if first > last then first, last = last, first end
  comment(vim.fn.input("Pi comment (range): "), first, last)
end

function M.show_stop(stop)
  return show({
    method = "show", file = stop.file, from_line = stop.expandedFrom, to_line = stop.expandedTo,
    root = M.tour and M.tour.root or nil, mode = "diff", added = stop.added, deleted = stop.deleted,
  })
end

function M.tour_step(delta)
  M.tour = state.tour
  if not M.tour or #M.tour.stops == 0 then error("No Pi tour is installed") end
  local index = math.max(1, math.min(#M.tour.stops, M.tour.index + delta))
  M.tour.index = index
  state.tour = M.tour
  local shown = M.show_stop(M.tour.stops[index])
  notify(("Pi tour %d/%d · %s:%d-%d"):format(index, #M.tour.stops,
    vim.fn.fnamemodify(shown.file, ":t"), shown.from_line, shown.to_line))
  return shown
end

local function install_map(mode, lhs, rhs, desc, force)
  local current = vim.fn.maparg(lhs, mode, false, true)
  if not force and type(current) == "table" and current.desc and current.desc ~= "" and current.desc ~= desc then
    notify(("Pi: %s is already mapped by another plugin"):format(lhs), vim.log.levels.WARN)
    return
  end
  vim.keymap.set(mode, lhs, rhs, { silent = true, desc = desc })
end

function M.tour_key(delta)
  local bridge = _G.pi_tour_bridge
  if not bridge or not bridge.tour_step then return end
  local ok, err = pcall(bridge.tour_step, delta)
  if not ok then notify(tostring(err):gsub("^.-: ", ""), vim.log.levels.WARN) end
end
function M.comment_key(visual)
  local bridge = _G.pi_tour_bridge
  if not bridge then return end
  if visual then pcall(bridge.comment_visual) else pcall(bridge.comment_current) end
end

local function keymaps()
  install_map("n", "]t", function() M.tour_key(1) end, "Pi tour: next stop", true)
  install_map("n", "[t", function() M.tour_key(-1) end, "Pi tour: previous stop", true)
  install_map("n", "<leader>pc", function() M.comment_key(false) end, "Pi: comment at cursor")
  install_map("x", "<leader>pc", ":<C-u>lua _G.pi_tour_bridge.comment_visual()<CR>", "Pi: comment on selection")
  install_map("n", "<leader>pl", function() M.comment_pick() end, "Pi: list comments")
  install_map("n", "<leader>pr", function() M.comment_resolve_at_cursor() end, "Pi: resolve comment here")
end

function M.comment_resolve_at_cursor()
  local file = vim.api.nvim_buf_get_name(0)
  local line = vim.fn.line(".")
  for _, entry in ipairs(state.comments) do
    if entry.file == file and entry.from <= line and line <= entry.to and entry.status ~= "resolved" then
      M.comment_resolve(entry.id)
      notify(("Pi: resolved comment #%s"):format(entry.id))
      return
    end
  end
  notify("Pi: no open comment at cursor", vim.log.levels.INFO)
end

function M.request(request)
  guard(request)
  M.tour, M.socket = state.tour, state.socket
  if request.method == "install" then
    state.socket = request.socket
    state.tour = request.stops and { stops = request.stops, index = 0, root = request.root }
      or (state.tour and state.tour.root == request.root and state.tour or nil)
    M.socket, M.tour = state.socket, state.tour
    keymaps()
    return { installed = true, stops = M.tour and #M.tour.stops or 0 }
  end
  if request.method == "tour.status" then
    M.tour = state.tour
    if not M.tour then return { index = 0, total = 0 } end
    local stop = M.tour.stops[M.tour.index]
    return { index = M.tour.index, total = #M.tour.stops, file = stop and stop.file or nil }
  end
  if request.method == "tour.next" then local comment_group = vim.api.nvim_create_augroup("PiIdeComments", { clear = true })
vim.api.nvim_create_autocmd({ "BufReadPost", "BufWinEnter" }, {
  group = comment_group,
  callback = function() pcall(M.render_comments) end,
})
pcall(M.render_comments)

return M.tour_step(1) end
  if request.method == "tour.prev" then return M.tour_step(-1) end
  if request.method == "tour.clear" then M.tour = nil; state.tour = nil; return { cleared = true } end
  if request.method == "comment.add" then
    local id = comment(request.text, request.from, request.to, request.file)
    return { sent = id ~= nil, id = id }
  end
  if request.method == "comment.reply" then
    local entry = find_comment(request.id)
    if not entry then error("Unknown comment id") end
    entry.replies = entry.replies or {}
    entry.replies[#entry.replies + 1] = { author = request.author or "pi", text = tostring(request.text or ""):sub(1, 4000), at = os.time() }
    entry.status = request.resolve and "resolved" or "answered"
    M.render_comments()
    return { id = entry.id, status = entry.status, replies = #entry.replies }
  end
  if request.method == "comment.resolve" then return M.comment_resolve(request.id) end
  if request.method == "comment.delete" then
    for index, entry in ipairs(state.comments) do
      if tostring(entry.id) == tostring(request.id) then
        table.remove(state.comments, index)
        M.render_comments()
        return { deleted = true, id = entry.id }
      end
    end
    error("Unknown comment id")
  end
  if request.method == "comment.list" then return { comments = M.comment_list() } end
  if request.method == "comment.jump" then return M.comment_jump(request.id) end

  if request.method == "status" then
    return {
      connected = true,
      server = vim.v.servername,
      file = vim.api.nvim_buf_get_name(vim.api.nvim_get_current_buf()),
      marks = #vim.api.nvim_buf_get_extmarks(vim.api.nvim_get_current_buf(), ns, 0, -1, {}),
      comment_marks = #vim.api.nvim_buf_get_extmarks(vim.api.nvim_get_current_buf(), ns_comments, 0, -1, {}),
      maps = {
        next = vim.fn.maparg("]t", "n"),
        prev = vim.fn.maparg("[t", "n"),
        comment = vim.fn.maparg("<leader>pc", "n"),
      },
      tour = state.tour and { index = state.tour.index, total = #state.tour.stops } or nil,
    }
  end
  if request.method == "snapshot" then
    local lines = request.lines
    if type(lines) ~= "table" or #lines == 0 then error("Snapshot needs lines") end
    for _, line in ipairs(lines) do
      if type(line) ~= "string" then error("Snapshot lines must be strings") end
    end
    local text = table.concat(lines, "\n")
    if #text > 65536 then error("Snapshot exceeds 64 KiB") end
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].filetype = request.filetype or "markdown"
    vim.bo[buf].modifiable = false
    vim.bo[buf].bufhidden = "wipe"
    pcall(vim.api.nvim_buf_set_name, buf, "pi://review-" .. tostring(os.time()) .. "-" .. tostring(math.random(1000, 9999)))
    open_window(buf)
    vim.api.nvim_win_set_cursor(0, { 1, 0 })
    return { file = "pi://review", text = text, lines = #lines }
  end

  if request.method == "document.dirty" then
    local file = allowed(request.file, request.root)
    local buf = vim.fn.bufnr(file)
    local dirty = buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].modified or false
    return { file = file, dirty = dirty, loaded = buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) }
  end
  if request.method == "document.save" then
    local file = allowed(request.file, request.root)
    local buf = vim.fn.bufnr(file)
    if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return { file = file, saved = false, dirty = false, reason = "not-open" } end
    local dirty = vim.bo[buf].modified
    if dirty then vim.api.nvim_buf_call(buf, function() vim.cmd("silent write") end) end
    return { file = file, saved = dirty, dirty = vim.bo[buf].modified }
  end
  if request.method == "selection.latest" then
    if not state.selection then return { available = false } end
    local buf = vim.fn.bufnr(state.selection.file)
    local stale = buf == -1 or not vim.api.nvim_buf_is_loaded(buf)
      or vim.api.nvim_buf_get_changedtick(buf) ~= state.selection.changedtick
    return vim.tbl_extend("force", vim.deepcopy(state.selection), { available = true, stale = stale })
  end
  if request.method == "context" then
    local current = vim.api.nvim_get_current_buf()
    local editors = {}
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      local name = vim.api.nvim_buf_get_name(buf)
      if name ~= "" and vim.api.nvim_buf_is_loaded(buf) then
        editors[#editors + 1] = {
          file = name,
          current = buf == current,
          modified = vim.bo[buf].modified,
          line = vim.api.nvim_win_get_cursor(0)[1],
        }
        if #editors >= 100 then break end
      end
    end
    return { workspace = vim.fn.getcwd(), editors = editors, selection = saved_selection }
  end
  if request.method == "diff.open" then
    local file = allowed(request.file, request.root)
    if type(request.content) ~= "string" or #request.content > 1024 * 1024 then error("Diff content must be a string up to 1 MiB") end
    if type(request.result_path) ~= "string" or request.result_path == "" then error("Diff needs result_path") end
    local id = tostring(request.diff_id or "")
    if id == "" then error("Diff needs diff_id") end
    if diffs[id] then finish_diff(id, "cancelled") end
    local lines = vim.split(request.content, "\n", { plain = true })
    if lines[#lines] == "" then table.remove(lines) end
    if #lines > 20000 then error("Diff has too many lines") end
    vim.cmd("vsplit " .. vim.fn.fnameescape(file))
    local orig_win = vim.api.nvim_get_current_win()
    local orig_buf = vim.api.nvim_get_current_buf()
    vim.cmd("diffthis")
    local new_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(new_buf, 0, -1, false, lines)
    vim.bo[new_buf].buftype = "acwrite"
    vim.bo[new_buf].bufhidden = "wipe"
    vim.bo[new_buf].filetype = vim.bo[orig_buf].filetype
    pcall(vim.api.nvim_buf_set_name, new_buf, file .. " (proposed)")
    vim.cmd("vsplit")
    local new_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(new_win, new_buf)
    vim.cmd("diffthis")
    vim.b[new_buf].pi_diff_id = id
    diffs[id] = { new_buf = new_buf, new_win = new_win, orig_win = orig_win, orig_buf = orig_buf, result_path = request.result_path }
    local group = vim.api.nvim_create_augroup("PiIdeDiff" .. id, { clear = true })
    vim.api.nvim_create_autocmd("BufWriteCmd", {
      group = group, buffer = new_buf,
      callback = function()
        local content = vim.api.nvim_buf_get_lines(new_buf, 0, -1, false)
        finish_diff(id, "accepted", content)
      end,
    })
    vim.api.nvim_create_autocmd({ "BufWipeout", "BufUnload" }, {
      group = group, buffer = new_buf,
      callback = function() if diffs[id] then finish_diff(id, "rejected") end end,
    })
    return { pending = true, diff_id = id, file = file }
  end
  if request.method == "diff.accept" or request.method == "diff.reject" then
    local id = tostring(request.diff_id or "")
    local diff = diffs[id]
    if not diff then return { status = "missing" } end
    if request.method == "diff.reject" then finish_diff(id, "rejected") return { status = "rejected" } end
    local content = vim.api.nvim_buf_get_lines(diff.new_buf, 0, -1, false)
    finish_diff(id, "accepted", content)
    return { status = "accepted" }
  end
  if request.method == "diff.cancel" then
    pcall(finish_diff, tostring(request.diff_id or ""), "cancelled")
    return { status = "cancelled" }
  end
  if request.method == "show" then return show(request) end
  error("Unknown tour operation")
end

show = function(request)
  local file = allowed(request.file, request.root)
  local first, last = request.from_line, request.to_line
  if type(first) ~= "number" or type(last) ~= "number" or first < 1
    or last < first or first % 1 ~= 0 or last % 1 ~= 0 or last - first >= 200 then
    error("Expected a 1-based inclusive range of at most 200 lines")
  end

  local buf = vim.fn.bufadd(file)
  vim.fn.bufload(buf)
  local count = vim.api.nvim_buf_line_count(buf)
  last = math.min(last, count)
  if first > count then error("Requested range starts past the end of the file") end

  open_window(buf)

  for _, loaded in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(loaded) then
      vim.api.nvim_buf_clear_namespace(loaded, ns, 0, -1)
    end
  end
  if request.mode == "diff" then
    for _, value in ipairs(request.added or {}) do
      local row = tonumber(value)
      if row and row >= 1 and row <= count then
        vim.api.nvim_buf_set_extmark(buf, ns, row - 1, 0, {
          end_row = row,
          line_hl_group = "DiffAdd",
          hl_eol = true,
        })
      end
    end
    local deleted = request.deleted or {}
    if #deleted > 0 then
      local lines = {}
      for index, text in ipairs(deleted) do
        if index > 20 then break end
        lines[#lines + 1] = { { "- " .. tostring(text), "DiffDelete" } }
      end
      if #deleted > 20 then
        lines[#lines + 1] = { { ("… %d more removed"):format(#deleted - 20), "Comment" } }
      end
      vim.api.nvim_buf_set_extmark(buf, ns, first - 1, 0, {
        virt_lines = lines,
        virt_lines_above = true,
      })
    end
  else
    vim.api.nvim_buf_set_extmark(buf, ns, first - 1, 0, {
      end_row = last,
      hl_group = request.highlight or "Visual",
      hl_eol = true,
    })
  end
  vim.api.nvim_win_set_cursor(0, { first, 0 })
  vim.cmd("normal! zz")

  local text = table.concat(vim.api.nvim_buf_get_lines(buf, first - 1, last, false), "\n")
  if #text > limit then error("Requested range exceeds 32 KiB") end
  return {
    file = file,
    from_line = first,
    to_line = last,
    text = text,
    changedtick = vim.api.nvim_buf_get_changedtick(buf),
  }
end

return M
