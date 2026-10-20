-- pi_agent.lua — helper module loaded into the Neovim instance driven by pi.
-- Exposes _G.PiAgent with sync points, compact state snapshots, change tracking
-- and LSP helpers. Everything returns small, JSON-friendly tables.

local M = _G.PiAgent or {}
_G.PiAgent = M

M.chan = M.chan or nil -- RPC channel of the pi client (for done notifications)
M.changes = M.changes or {} -- bufnr -> list of {first, last} (1-based, inclusive)
M.attached = M.attached or {}
M.diag_tick = M.diag_tick or 0
M.last_ex = nil
M.busy = false -- true while a pi tool is running
M.user_changes = M.user_changes or {} -- edits made by the human between tool calls
M.last_state = M.last_state or nil -- {buf, cursor, mode} when the last tool finished

local api, fn = vim.api, vim.fn

-- Avoid prompts that would block the agent.
vim.opt.shortmess:append("A") -- no swap-file ATTENTION prompt
vim.o.more = false
vim.o.confirm = false
pcall(function()
  if vim.fn.executable("rg") == 1 then
    vim.o.grepprg = "rg --vimgrep --smart-case --hidden --glob '!.git'"
    vim.o.grepformat = "%f:%l:%c:%m"
  end
end)

local function rel(path)
  if path == "" then return "" end
  return fn.fnamemodify(path, ":~:.")
end

---------------------------------------------------------------------------
-- Change tracking
---------------------------------------------------------------------------
function M.on_lines(b, first, last_new)
  local store = M.busy and M.changes or M.user_changes
  local list = store[b] or {}
  store[b] = list
  list[#list + 1] = { first + 1, math.max(first + 1, last_new) }
end

local function track(buf)
  if M.attached[buf] or not api.nvim_buf_is_loaded(buf) then return end
  if vim.bo[buf].buftype ~= "" then return end
  M.attached[buf] = true
  api.nvim_buf_attach(buf, false, {
    -- Dispatch through _G so a reloaded module takes over existing attachments.
    on_lines = function(_, b, _, first, _, last_new)
      _G.PiAgent.on_lines(b, first, last_new)
    end,
    on_detach = function(_, b)
      M.attached[b] = nil
    end,
  })
end

local group = api.nvim_create_augroup("PiAgent", { clear = true })
api.nvim_create_autocmd({ "BufReadPost", "BufNewFile", "BufEnter" }, {
  group = group,
  callback = function(ev) track(ev.buf) end,
})
api.nvim_create_autocmd("DiagnosticChanged", {
  group = group,
  callback = function() M.diag_tick = M.diag_tick + 1 end,
})
for _, b in ipairs(api.nvim_list_bufs()) do track(b) end

local function merge(ranges, maxline)
  table.sort(ranges, function(a, b) return a[1] < b[1] end)
  local out = {}
  for _, r in ipairs(ranges) do
    local a, b = math.min(r[1], maxline), math.min(r[2], maxline)
    local last = out[#out]
    if last and a <= last[2] + 1 then
      last[2] = math.max(last[2], b)
    else
      out[#out + 1] = { a, b }
    end
  end
  return out
end

local function numbered(buf, a, b, cur)
  local lines = api.nvim_buf_get_lines(buf, a - 1, b, false)
  local out = {}
  for i, l in ipairs(lines) do
    local n = a + i - 1
    out[#out + 1] = string.format("%s%d│%s", n == cur and ">" or " ", n, l)
  end
  return table.concat(out, "\n")
end

local function take_changes(max_lines, store)
  store = store or M.changes
  local result, budget = {}, max_lines or 30
  for buf, ranges in pairs(store) do
    if api.nvim_buf_is_valid(buf) and #ranges > 0 then
      local merged = merge(ranges, math.max(1, api.nvim_buf_line_count(buf)))
      local entry = { file = rel(api.nvim_buf_get_name(buf)), ranges = merged }
      local total = 0
      for _, r in ipairs(merged) do total = total + (r[2] - r[1] + 1) end
      if total <= budget then
        local parts = {}
        for _, r in ipairs(merged) do parts[#parts + 1] = numbered(buf, r[1], r[2]) end
        entry.text = table.concat(parts, "\n…\n")
        budget = budget - total
      end
      result[#result + 1] = entry
    end
  end
  for k in pairs(store) do store[k] = nil end
  return result
end

---------------------------------------------------------------------------
-- Tool lifecycle + human activity detection
---------------------------------------------------------------------------
local function current_state()
  local c = api.nvim_win_get_cursor(0)
  return { buf = api.nvim_get_current_buf(), line = c[1], col = c[2], mode = api.nvim_get_mode().mode }
end

-- Called when a pi tool starts. Returns what the human did since the last tool finished, or nil.
function M.start_tool(label)
  local activity = nil
  local now = current_state()
  local last = M.last_state
  if last then
    local notes = {}
    if now.buf ~= last.buf then
      notes[#notes + 1] = "switched to " .. rel(api.nvim_buf_get_name(now.buf))
    elseif now.line ~= last.line or now.col ~= last.col then
      notes[#notes + 1] = ("moved cursor to %d:%d"):format(now.line, now.col + 1)
    end
    if now.mode ~= last.mode then notes[#notes + 1] = "mode is now " .. now.mode end
    local edits = take_changes(15, M.user_changes)
    if #edits > 0 then
      for _, e in ipairs(edits) do
        local r = {}
        for _, x in ipairs(e.ranges) do r[#r + 1] = x[1] == x[2] and tostring(x[1]) or (x[1] .. "-" .. x[2]) end
        notes[#notes + 1] = ("edited %s %s"):format(e.file, table.concat(r, ",")) .. (e.text and (":\n" .. e.text) or "")
      end
    end
    if #notes > 0 then activity = table.concat(notes, "\n") end
  else
    for k in pairs(M.user_changes) do M.user_changes[k] = nil end
  end
  M.busy = true
  M.status(label)
  return activity
end

function M.end_tool()
  M.status(nil)
  M.busy = false
  M.last_state = current_state()
end

---------------------------------------------------------------------------
-- Keymap cheat sheet (the user's own mappings, filtered to editing-relevant ones)
---------------------------------------------------------------------------
function M.keymaps(deny, max)
  local leader = vim.g.mapleader or "\\"
  local seen, out = {}, {}
  local deny_re = vim.regex(deny)
  for _, mode in ipairs({ "n", "o", "x" }) do
    for _, m in ipairs(api.nvim_get_keymap(mode)) do
      local desc = m.desc
      if desc and desc ~= "" and not m.lhs:find("Plug", 1, true) and not desc:find("^:")
        and not deny_re:match_str(desc) and not m.lhs:find("Mouse") then
        local lhs = m.lhs
        if lhs:sub(1, #leader) == leader then lhs = "<leader>" .. lhs:sub(#leader + 1) end
        lhs = lhs:gsub(" ", "<Space>")
        local key = lhs .. "\0" .. desc
        if not seen[key] then
          seen[key] = mode
          out[#out + 1] = { lhs = lhs, desc = desc:sub(1, 45), modes = mode }
        else
          for _, o in ipairs(out) do
            if o.lhs == lhs and o.desc == desc:sub(1, 45) and not o.modes:find(mode) then o.modes = o.modes .. mode end
          end
        end
      end
    end
  end
  local function rank(o)
    if o.modes:find("o") then return 0 end
    if o.lhs:find("^<leader>") then return 1 end
    return 2
  end
  table.sort(out, function(a, b)
    if rank(a) ~= rank(b) then return rank(a) < rank(b) end
    return a.lhs < b.lhs
  end)
  local lines = {}
  for i, o in ipairs(out) do
    if i > (max or 70) then break end
    lines[#lines + 1] = ("%-14s %-3s %s"):format(o.lhs, o.modes, o.desc)
  end
  return { leader = leader, lines = lines }
end

---------------------------------------------------------------------------
-- Sync + snapshot
---------------------------------------------------------------------------
function M.begin(chan)
  M.chan = chan or M.chan
  vim.v.errmsg = ""
  vim.v.statusmsg = ""
  M.last_ex = nil
end

function M.done(id)
  if M.chan then vim.rpcnotify(M.chan, "pi_done", id) end
end

-- Draw `:text` in the message area, so the human sees the command being typed.
-- (Typing into the real cmdline is unreliable with cmdline completion plugins.)
-- Messages must fit on one row: a wrapped message triggers a hit-enter prompt, which would
-- block inside the RPC request and deadlock the client.
local function fit(s)
  s = s:gsub("\n", " ")
  local max = math.max(10, vim.v.echospace > 0 and vim.v.echospace or (vim.o.columns - 12))
  if fn.strdisplaywidth(s) > max then s = fn.strcharpart(s, 0, max - 1) .. "…" end
  return s
end

function M.show_cmdline(text)
  api.nvim_echo({ { fit(":" .. text), "Normal" } }, false, {})
  vim.cmd("redraw")
end

-- Execute an Ex command with output capture, as if typed (added to cmd history).
function M.exec(cmd)
  if api.nvim_get_mode().mode ~= "n" then vim.cmd("stopinsert") end
  api.nvim_echo({ { "" } }, false, {})
  local ok, res = pcall(api.nvim_exec2, cmd, { output = true })
  if ok then
    M.last_ex = { ok = true, output = res.output }
  else
    local msg = tostring(res)
    M.last_ex = { ok = false, output = msg:match("(E%d+:.*)") or msg }
  end
  pcall(fn.histadd, "cmd", cmd)
  vim.cmd("redraw")
  if not ok then api.nvim_echo({ { fit(M.last_ex.output), "ErrorMsg" } }, false, {}) end
end

-- Paste lines (linewise below/above or charwise before/after the cursor).
function M.put(lines, kind, after)
  api.nvim_put(lines, kind, after, true)
end

local function diag_counts(buf)
  local c = { E = 0, W = 0 }
  for _, d in ipairs(vim.diagnostic.get(buf)) do
    if d.severity == vim.diagnostic.severity.ERROR then c.E = c.E + 1
    elseif d.severity == vim.diagnostic.severity.WARN then c.W = c.W + 1 end
  end
  return c
end

function M.snapshot(opts)
  opts = opts or {}
  local ctxn = opts.context or 2
  local mode = api.nvim_get_mode()
  local buf = api.nvim_get_current_buf()
  local cur = api.nvim_win_get_cursor(0)
  local n = api.nvim_buf_line_count(buf)
  local a, b = math.max(1, cur[1] - ctxn), math.min(n, cur[1] + ctxn)
  local snap = {
    mode = mode.mode,
    file = rel(api.nvim_buf_get_name(buf)),
    cur = { cur[1], cur[2] + 1 },
    lines = n,
    mod = vim.bo[buf].modified,
    ctx = numbered(buf, a, b, cur[1]),
    diag = diag_counts(buf),
    changed = take_changes(opts.max_changed or 30),
  }
  if mode.blocking then snap.blocking = true end
  if vim.v.errmsg ~= "" then snap.err = vim.v.errmsg end
  if vim.v.statusmsg ~= "" then snap.msg = vim.v.statusmsg end
  if M.last_ex then
    local out = M.last_ex.output or ""
    if #out > 2000 then out = out:sub(1, 2000) .. "\n…(truncated)" end
    if M.last_ex.ok then
      if out ~= "" then snap.output = out end
    else
      snap.err = out
    end
    M.last_ex = nil
  end
  local qf = fn.getqflist({ size = 0, title = 0 })
  if qf.size > 0 and opts.qf then snap.qf = M.qflist(opts.qf) end
  if #fn.getbufinfo({ buflisted = 1 }) > 1 then
    local bufs = {}
    for _, info in ipairs(fn.getbufinfo({ buflisted = 1 })) do
      if info.name ~= "" then bufs[#bufs + 1] = rel(info.name) .. (info.changed == 1 and "+" or "") end
    end
    snap.bufs = bufs
  end
  return snap
end

---------------------------------------------------------------------------
-- Buffer reading
---------------------------------------------------------------------------
function M.view(path, first, last)
  if last == vim.NIL or (type(last) == "number" and last <= 0) then last = nil end
  if first == vim.NIL then first = nil end
  local buf = api.nvim_get_current_buf()
  if path and path ~= "" then
    buf = fn.bufadd(path)
    fn.bufload(buf)
  end
  local n = api.nvim_buf_line_count(buf)
  first = math.max(1, first or 1)
  last = math.min(n, last or (first + 199))
  local cur = buf == api.nvim_get_current_buf() and api.nvim_win_get_cursor(0)[1] or nil
  return {
    file = rel(api.nvim_buf_get_name(buf)),
    lines = n,
    range = { first, last },
    text = numbered(buf, first, last, cur),
  }
end

function M.qflist(max)
  max = max or 50
  local items = fn.getqflist()
  local out = {}
  for i, it in ipairs(items) do
    if i > max then
      out[#out + 1] = string.format("…(%d more)", #items - max)
      break
    end
    local name = it.bufnr > 0 and rel(api.nvim_buf_get_name(it.bufnr)) or ""
    out[#out + 1] = string.format("%s:%d:%d: %s", name, it.lnum, it.col, vim.trim(it.text or ""))
  end
  return { total = #items, items = out }
end

---------------------------------------------------------------------------
-- LSP helpers
---------------------------------------------------------------------------
local function lsp_clients(method)
  local out = {}
  for _, c in ipairs(vim.lsp.get_clients({ bufnr = 0 })) do
    if c.name ~= "GitHub Copilot" and c.name ~= "copilot" and (not method or c:supports_method(method)) then
      out[#out + 1] = c
    end
  end
  return out
end

local function first_client(method)
  local clients = lsp_clients(method)
  if #clients == 0 then
    local names = {}
    for _, c in ipairs(vim.lsp.get_clients({ bufnr = 0 })) do names[#names + 1] = c.name end
    error(("no LSP client supports %s for this buffer (attached: %s)"):format(method, table.concat(names, ", ")))
  end
  return clients[1]
end

local function locations_to_qf(result, enc)
  if not result then return {} end
  if result.uri or result.targetUri then result = { result } end
  return vim.lsp.util.locations_to_items(result, enc)
end

local function set_qf(items, title)
  fn.setqflist({}, " ", { title = title, items = items })
end

local function jump_or_list(items, title)
  if #items == 0 then return end
  if #items == 1 then
    local it = items[1]
    vim.cmd("normal! m'")
    vim.cmd("edit " .. fn.fnameescape(it.filename))
    api.nvim_win_set_cursor(0, { it.lnum, math.max(0, it.col - 1) })
    vim.cmd("normal! zz")
  else
    set_qf(items, title)
    vim.cmd("botright copen")
  end
end

local function wait_attached(timeout)
  vim.wait(timeout or 5000, function() return #lsp_clients() > 0 end, 100)
end

local function locs(method, title, extra)
  wait_attached()
  local client = first_client(method)
  local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
  if extra then params = vim.tbl_extend("force", params, extra) end
  local resp = client:request_sync(method, params, 5000, 0)
  if not resp or resp.err then error(resp and resp.err and resp.err.message or "LSP request timed out") end
  local items = locations_to_qf(resp.result, client.offset_encoding)
  jump_or_list(items, title)
  return items
end

local function compact_items(items, max)
  local out = {}
  for i, it in ipairs(items) do
    if i > (max or 50) then out[#out + 1] = ("…(%d more)"):format(#items - (max or 50)); break end
    out[#out + 1] = ("%s:%d:%d: %s"):format(rel(it.filename), it.lnum, it.col, vim.trim(it.text or ""))
  end
  return out
end

local function flatten_symbols(symbols, out, depth)
  for _, s in ipairs(symbols or {}) do
    local range = s.selectionRange or s.range or (s.location and s.location.range)
    out[#out + 1] = ("%s%s %s :%d"):format(string.rep("  ", depth), vim.lsp.protocol.SymbolKind[s.kind] or "?", s.name,
      range and range.start.line + 1 or 0)
    if s.children then flatten_symbols(s.children, out, depth + 1) end
  end
  return out
end

function M.lsp(action, arg)
  if arg == vim.NIL or arg == "" then arg = nil end
  if action == "definition" then
    return { items = compact_items(locs("textDocument/definition", "Definition")) }
  elseif action == "references" then
    return { items = compact_items(locs("textDocument/references", "References", { context = { includeDeclaration = true } })) }
  elseif action == "implementation" then
    return { items = compact_items(locs("textDocument/implementation", "Implementation")) }
  elseif action == "type_definition" then
    return { items = compact_items(locs("textDocument/typeDefinition", "Type definition")) }
  elseif action == "hover" then
    wait_attached()
    local client = first_client("textDocument/hover")
    local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
    local resp = client:request_sync("textDocument/hover", params, 5000, 0)
    pcall(vim.lsp.buf.hover) -- visible popup for the human
    local contents = resp and resp.result and resp.result.contents
    if not contents then return { text = "(no hover info)" } end
    local lines = vim.lsp.util.convert_input_to_markdown_lines(contents)
    local text = table.concat(lines, "\n")
    if #text > 1500 then text = text:sub(1, 1500) .. "…" end
    return { text = text }
  elseif action == "rename" then
    if not arg or arg == "" then error("rename requires new_name") end
    wait_attached()
    local client = first_client("textDocument/rename")
    local params = vim.lsp.util.make_position_params(0, client.offset_encoding)
    params.newName = arg
    local resp = client:request_sync("textDocument/rename", params, 5000, 0)
    if not resp or resp.err then error(resp and resp.err and resp.err.message or "rename timed out") end
    if not resp.result then error("nothing to rename at cursor") end
    vim.lsp.util.apply_workspace_edit(resp.result, client.offset_encoding)
    local files = {}
    for uri, _ in pairs(resp.result.changes or {}) do files[#files + 1] = rel(vim.uri_to_fname(uri)) end
    for _, dc in ipairs(resp.result.documentChanges or {}) do
      if dc.textDocument then files[#files + 1] = rel(vim.uri_to_fname(dc.textDocument.uri)) end
    end
    return { renamed_in = files }
  elseif action == "symbols" then
    wait_attached()
    local client = first_client("textDocument/documentSymbol")
    local resp = client:request_sync("textDocument/documentSymbol",
      { textDocument = vim.lsp.util.make_text_document_params(0) }, 5000, 0)
    return { symbols = flatten_symbols(resp and resp.result, {}, 0) }
  elseif action == "workspace_symbol" then
    wait_attached()
    local client = first_client("workspace/symbol")
    local resp = client:request_sync("workspace/symbol", { query = arg or "" }, 5000, 0)
    local out = {}
    for i, s in ipairs(resp and resp.result or {}) do
      if i > 40 then break end
      local loc = s.location
      out[#out + 1] = ("%s %s %s:%d"):format(vim.lsp.protocol.SymbolKind[s.kind] or "?", s.name,
        rel(vim.uri_to_fname(loc.uri)), loc.range and loc.range.start.line + 1 or 0)
    end
    return { symbols = out }
  elseif action == "code_actions" or action == "apply_code_action" then
    wait_attached()
    local client = first_client("textDocument/codeAction")
    local params = vim.lsp.util.make_range_params(0, client.offset_encoding)
    local lnum = api.nvim_win_get_cursor(0)[1] - 1
    local ok, diags = pcall(vim.lsp.diagnostic.from, vim.diagnostic.get(0, { lnum = lnum }))
    params.context = { diagnostics = ok and diags or {} }
    local resp = client:request_sync("textDocument/codeAction", params, 5000, 0)
    local actions = resp and resp.result or {}
    if action == "code_actions" then
      local titles = {}
      for i, a in ipairs(actions) do titles[#titles + 1] = ("%d. %s"):format(i, a.title) end
      return { actions = titles }
    end
    local idx = tonumber(arg)
    local chosen = idx and actions[idx]
    if not chosen then
      for _, a in ipairs(actions) do
        if arg and a.title:lower():find(arg:lower(), 1, true) then chosen = a; break end
      end
    end
    if not chosen then error("no matching code action: " .. tostring(arg)) end
    if not chosen.edit and not chosen.command and client:supports_method("codeAction/resolve") then
      local r = client:request_sync("codeAction/resolve", chosen, 5000, 0)
      if r and r.result then chosen = r.result end
    end
    if chosen.edit then vim.lsp.util.apply_workspace_edit(chosen.edit, client.offset_encoding) end
    if chosen.command then
      local cmd = type(chosen.command) == "table" and chosen.command or chosen
      client:exec_cmd(cmd, { bufnr = 0 })
    end
    return { applied = chosen.title }
  elseif action == "diagnostics" then
    return M.diagnostics(arg == "workspace")
  end
  error("unknown lsp action: " .. tostring(action))
end

function M.diagnostics(workspace)
  local list = vim.diagnostic.get(workspace and nil or 0)
  table.sort(list, function(a, b)
    if a.severity ~= b.severity then return a.severity < b.severity end
    if a.bufnr ~= b.bufnr then return a.bufnr < b.bufnr end
    return a.lnum < b.lnum
  end)
  local out, counts = {}, { E = 0, W = 0, I = 0, H = 0 }
  local sev = { "E", "W", "I", "H" }
  for _, d in ipairs(list) do
    local s = sev[d.severity] or "?"
    counts[s] = (counts[s] or 0) + 1
    if #out < 40 and d.severity <= vim.diagnostic.severity.WARN then
      out[#out + 1] = ("%s %s:%d:%d %s"):format(s, rel(api.nvim_buf_get_name(d.bufnr)), d.lnum + 1, d.col + 1,
        (d.message or ""):gsub("\n.*", ""))
    end
  end
  return { counts = counts, items = out }
end

-- Save everything and wait until diagnostics settle (no change for `quiet` ms).
function M.check(quiet, timeout)
  pcall(vim.cmd, "silent! wall")
  quiet, timeout = quiet or 800, timeout or 8000
  wait_attached(3000)
  local start = vim.uv.now()
  local last_tick, last_change = M.diag_tick, vim.uv.now()
  vim.wait(timeout, function()
    if M.diag_tick ~= last_tick then
      last_tick, last_change = M.diag_tick, vim.uv.now()
    end
    return vim.uv.now() - last_change >= quiet and vim.uv.now() - start >= quiet
  end, 50)
  local res = M.diagnostics(true)
  local names = {}
  for _, c in ipairs(lsp_clients()) do names[#names + 1] = c.name end
  res.lsp = names
  return res
end

-- Small status indicator in the top-right corner so the human sees what pi is doing.
function M.status(text)
  if M.status_win and api.nvim_win_is_valid(M.status_win) then
    pcall(api.nvim_win_close, M.status_win, true)
    M.status_win = nil
  end
  if not text or text == "" then return end
  local buf = api.nvim_create_buf(false, true)
  local line = " 🤖 pi: " .. text .. " "
  api.nvim_buf_set_lines(buf, 0, -1, false, { line })
  local width = math.min(fn.strdisplaywidth(line), vim.o.columns - 2)
  M.status_win = api.nvim_open_win(buf, false, {
    relative = "editor", anchor = "NE", row = 0, col = vim.o.columns, width = width, height = 1,
    style = "minimal", focusable = false, zindex = 250, noautocmd = true,
  })
  vim.wo[M.status_win].winhl = "Normal:IncSearch"
end

return true
