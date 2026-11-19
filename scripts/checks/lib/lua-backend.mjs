// Runs backend/ in fengari with stub Millennium modules over an in-memory file
// system, so the checks can drive the Lua backend without Steam. fengari is Lua
// 5.3 and Millennium's host is LuaJIT; the backend sticks to what both have.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const STUBS = String.raw`
files = {}
dirs = {}
mtimes = {}
config = {}
requests = {}
http_reply = { status = 200, body = '{}' }
registered = {}
removed_hooks = {}
logged = {}
ready_calls = 0
env = { USERPROFILE = 'C:/Users/T' }

local next_hook = 0
local function parent(path) return (path:gsub('/[^/]*$', '')) end

package.preload.http = function() return {
  request = function(url, options) requests[#requests+1] = {url=url, options=options}; return http_reply end,
  get = function(url, options) requests[#requests+1] = {url=url, options=options}; return http_reply end,
  download = function(url, path, options) requests[#requests+1] = {url=url, options=options}; files[path] = download_body; return { success = download_body ~= nil, status = 200 } end,
} end
package.preload.logger = function()
  local function log(_, text) logged[#logged+1] = text end
  return { info = log, warn = log, error = log }
end
package.preload.millennium = function() return {
  steam_path = function() return 'C:/Steam' end,
  ready = function() ready_calls = ready_calls + 1 end,
  config = { get = function(key) return config[key] end, set = function(key, value) config[key] = value end },
  add_browser_css = function(path, pattern)
    next_hook = next_hook + 1
    registered[next_hook] = { path = path, pattern = pattern }
    return next_hook
  end,
  remove_browser_module = function(id) registered[id] = nil end,
  get_install_path = function() return 'C:/Steam' end,
} end
package.preload.fs = function()
  local fs = {}
  function fs.join(...) return table.concat({...}, '/') end
  fs.parent_path = parent
  function fs.is_file(path) return files[path] ~= nil end
  function fs.is_directory(path)
    if dirs[path] then return true end
    local prefix = path .. '/'
    for name in pairs(files) do
      if name:sub(1, #prefix) == prefix then return true end
    end
    return false
  end
  function fs.exists(path) return fs.is_file(path) or fs.is_directory(path) end
  function fs.create_directories(path) dirs[path] = true; return true end
  function fs.file_size(path) return files[path] and #files[path] or 0 end
  function fs.last_write_time(path) return mtimes[path] or 1000 end
  function fs.is_symlink() return false end
  function fs.canonical(path) return links[path] or path end
  function fs.is_empty(path) return #fs.list(path) == 0 end
  function fs.remove(path) dirs[path] = nil; files[path] = nil; return true end
  function fs.rename(a, b)
    if files[a] == nil then
      local prefix = a .. '/'
      local moving = {}
      for name in pairs(files) do
        if name:sub(1, #prefix) == prefix then moving[#moving+1] = name end
      end
      if #moving == 0 then return false, 'no such file' end
      for _, name in ipairs(moving) do
        files[b .. '/' .. name:sub(#prefix + 1)] = files[name]
        files[name] = nil
      end
      return true
    end
    files[b] = files[a]; files[a] = nil
    return true
  end
  function fs.remove_all(path)
    local prefix = path .. '/'
    for name in pairs(files) do
      if name:sub(1, #prefix) == prefix then files[name] = nil end
    end
    dirs[path] = nil
    return true
  end
  local function list(root, recursive)
    local prefix = root .. '/'
    local seen, out = {}, {}
    for _, source in ipairs({ files, dirs }) do
      for name in pairs(source) do
        if name:sub(1, #prefix) == prefix then
          local rest = name:sub(#prefix + 1)
          if recursive then
            if files[name] and not seen[name] then
              seen[name] = true
              out[#out+1] = { name = rest:match('[^/]+$'), path = name, is_file = true, is_directory = false }
            end
          else
            local first = rest:match('^[^/]+')
            local path = prefix .. first
            if first and not seen[first] then
              seen[first] = true
              out[#out+1] = { name = first, path = path, is_file = files[path] ~= nil, is_directory = files[path] == nil }
            end
          end
        end
      end
    end
    table.sort(out, function(a, b) return a.path < b.path end)
    return out
  end
  function fs.list(root) return list(root, false) end
  function fs.list_recursive(root) return list(root, true) end
  return fs
end
package.preload.utils = function() return {
  read_file = function(path) return files[path] end,
  write_file = function(path, value) files[path] = value; writes[#writes+1] = path; return true end,
  append_file = function(path, value) files[path] = (files[path] or '') .. value; return true end,
  exec = function(command)
    commands[#commands+1] = command
    if link_works then links['C:/Steam/steamui/sounds_custom'] = 'C:/Users/T/homebrew/sounds'; dirs['C:/Steam/steamui/sounds_custom'] = true end
    return 'output', 0
  end,
  uuid = function() return 'id' end,
  base64_encode = function(v) return v end,
  base64_decode = function(v) return v end,
  getenv = function(name) return env[name] end,
  trim = function(s) return (s:gsub('^%s+', ''):gsub('%s+$', '')) end,
} end
-- The real module is cjson; this one writes empty tables as [] and cjson as {}.
writes = {}
commands = {}
links = {}
link_works = true
os.remove = function(path) files[path] = nil; return true end
os.clock = os.clock or function() return 0 end

-- For reading results from JavaScript.
function to_text(v)
  if type(v) == 'string' then return v end
  return require('json').encode(v)
end
`;

export function createBackend({ source } = {}) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);

  const run = (code) => {
    if (lauxlib.luaL_dostring(state, to_luastring(code)) !== lua.LUA_OK) throw Error(to_jsstring(lua.lua_tostring(state, -1)));
    lua.lua_settop(state, 0);
  };
  const quote = (text) => `[==[${text}]==]`;
  const setGlobalBytes = (name, bytes) => {
    lua.lua_pushlstring(state, bytes, bytes.length);
    lua.lua_setglobal(state, to_luastring(name));
  };
  const evaluate = (expression) => {
    if (lauxlib.luaL_dostring(state, to_luastring(`return to_text(${expression})`)) !== lua.LUA_OK) throw Error(to_jsstring(lua.lua_tostring(state, -1)));
    const value = lua.lua_tolstring(state, -1);
    lua.lua_settop(state, 0);
    return Buffer.from(value).toString('utf8');
  };

  run(STUBS);
  setGlobalBytes('__source', new Uint8Array(readFileSync(new URL('./json.lua', import.meta.url))));
  run("package.preload.json = assert(load(__source, '=json.lua'))");

  const backend = {
    run,
    evaluate,
    json: (expression) => JSON.parse(evaluate(expression)),
    // Starts the plugin, as Millennium does: runs main.lua, then on_load.
    start(mainSource = source ?? readFileSync(new URL('../../../backend/main.lua', import.meta.url), 'utf8')) {
      setGlobalBytes('__source', Buffer.from(mainSource));
      run(`plugin = assert(load(__source, '=main.lua'))()`);
      return backend;
    },
    load() {
      run('plugin.on_load()');
      return backend;
    },
    setFile(path, content) {
      setGlobalBytes('__file', typeof content === 'string' ? Buffer.from(content) : content);
      run(`files[ ${quote(path)} ] = __file`);
    },
    getFile(path) {
      const text = evaluate(`files[ ${quote(path)} ] or ''`);
      return text;
    },
    call(name, ...args) {
      run(`__args = {}`);
      args.forEach((arg, index) => {
        if (typeof arg === 'string') {
          setGlobalBytes('__arg', Buffer.from(arg));
          run(`__args[${index + 1}] = __arg`);
        } else {
          run(`__args[${index + 1}] = ${JSON.stringify(arg)}`);
        }
      });
      return evaluate(`${name}((table.unpack or unpack)(__args, 1, ${args.length}))`);
    },
    close: () => lua.lua_close(state),
  };
  return backend;
}

export const PACKS = 'C:/Users/T/homebrew/sounds';
