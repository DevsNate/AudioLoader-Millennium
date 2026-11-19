-- Audio Loader backend, as upstream's Python backend was (main.py, audio_utils.py,
-- audio_remoteinstall.py): sound packs in homebrew\sounds, config.json and the
-- STORE file there, and DeckThemes requests. Packs keep upstream's layout, so a
-- folder used with Decky works here unchanged.

---@class Environment
---@field packs_path string
---@field packs_linked boolean
---@field loader_version number

---@class PackResult
---@field success boolean
---@field message string

---@class WriteResult
---@field success boolean
---@field error? string

---@class StoreResponse
---@field success boolean
---@field status? number
---@field body? string
---@field error? string

---@class HeldBlob
---@field success boolean
---@field id? string
---@field chunks? number
---@field size? number
---@field error? string

local fs = require("fs")
local http = require("http")
local json = require("json")
local logger = require("logger")
local millennium = require("millennium")
local utils = require("utils")

local AUDIO_LOADER_VERSION = 3
local USER_AGENT = "SDH-AudioLoader/3 (audioloader-millennium/1.0)"
local STORE_ORIGIN = "https://api.deckthemes.com"
local STORE_METHODS = { GET = true, POST = true, DELETE = true }
-- Millennium cancels a backend call after 30 seconds.
local NETWORK_TIMEOUT_SECONDS = 25
local MAX_BLOB_BYTES = 128 * 1024 * 1024
-- A backend reply is limited to 8 MB. A chunk is a multiple of 3 bytes, so the
-- Base64 of each chunk joins without padding.
local CHUNK_BYTES = 3 * 1024 * 1024

local HOME = utils.getenv("USERPROFILE") or utils.getenv("HOME") or ""
local PACKS_PATH = fs.join(HOME, "homebrew", "sounds")
local CONFIG_PATH = fs.join(PACKS_PATH, "config.json")
local STORE_PATH = fs.join(PACKS_PATH, "STORE")
local STEAMUI_PATH = fs.join(millennium.steam_path(), "steamui")
local SOUNDS_LINK = fs.join(STEAMUI_PATH, "sounds_custom")

local DEFAULT_CONFIG = {
    selected_pack = "Default",
    selected_music = "None",
    sound_volume = 1,
    music_volume = 0.5,
    legacy_enabled = false,
}

local sound_packs = {}
local packs_linked = false

local function slashes(path)
    return (string.gsub(path, "\\", "/"))
end

local function read_json(path)
    if not fs.is_file(path) then
        return nil
    end
    local ok, value = pcall(json.decode, utils.read_file(path))
    return ok and type(value) == "table" and value or nil
end

-- Replaces the file in one step, so a reader sees the old text or the new.
local function write_atomic(path, content)
    local temp = path .. ".tmp"
    local ok, err = utils.write_file(temp, content)
    if not ok then
        return false, err
    end
    local renamed, rename_err = fs.rename(temp, path)
    if not renamed then
        os.remove(temp)
        return false, rename_err or ("Could not replace " .. path)
    end
    return true
end

-- A path relative to the packs folder (forward slashes). No absolute paths,
-- drive letters, empty, "." or ".." components, and none of the characters
-- Windows forbids in names.
local function safe_relative(path)
    if type(path) ~= "string" or path == "" or #path > 1024 or string.find(path, "[%c<>:\"|%?%*]") then
        return nil
    end
    path = slashes(path)
    if string.sub(path, 1, 1) == "/" then
        return nil
    end
    local parts = {}
    for part in string.gmatch(path, "[^/]+") do
        if part == "." or part == ".." or string.match(part, "^%s") or string.match(part, "[%s%.]$") then
            return nil
        end
        parts[#parts + 1] = part
    end
    return #parts > 0 and table.concat(parts, "/") or nil
end

-- Serving the packs -------------------------------------------------------
-- Steam loads UI sounds through its own https://steamloopback.host/ files, so
-- the packs must appear in steamui, as upstream's symlink makes them. This is
-- a junction, which unlike a symlink needs no special rights on Windows.
-- Millennium's file route isn't an option: it reads file types it doesn't know,
-- audio included, in text mode, which corrupts them.

local function same_folder(first, second)
    local ok_first, first_path = pcall(fs.canonical, first)
    local ok_second, second_path = pcall(fs.canonical, second)
    return ok_first and ok_second and type(first_path) == "string" and type(second_path) == "string"
        and string.lower(slashes(first_path)) == string.lower(slashes(second_path))
end

local function backslashes(path)
    return (string.gsub(path, "/", "\\"))
end

local function link_packs()
    if fs.exists(SOUNDS_LINK) then
        if same_folder(SOUNDS_LINK, PACKS_PATH) then
            return true
        end
        if not fs.is_directory(SOUNDS_LINK) then
            logger:error(SOUNDS_LINK .. " exists and isn't a folder.")
            return false
        end
        -- A real folder: packs kept there move to the packs folder.
        for _, entry in ipairs(fs.list(SOUNDS_LINK) or {}) do
            local target = fs.join(PACKS_PATH, entry.name)
            if entry.is_directory and not fs.exists(target) then
                fs.rename(entry.path, target)
            end
        end
        if not fs.is_empty(SOUNDS_LINK) then
            logger:error(SOUNDS_LINK .. " still has files in it, so it can't become the link to the packs.")
            return false
        end
        fs.remove(SOUNDS_LINK)
    end
    if not fs.is_directory(STEAMUI_PATH) then
        logger:error("Steam's steamui folder wasn't found at " .. STEAMUI_PATH)
        return false
    end
    local output = utils.exec('mklink /J "' .. backslashes(SOUNDS_LINK) .. '" "' .. backslashes(PACKS_PATH) .. '"')
    local linked = same_folder(SOUNDS_LINK, PACKS_PATH)
    if not linked then
        logger:error("Could not link " .. SOUNDS_LINK .. " to the packs: " .. tostring(output))
    end
    return linked
end

-- Sound packs -------------------------------------------------------------

local function table_or_empty(value)
    return type(value) == "table" and value or {}
end

local function string_or(value, fallback)
    return type(value) == "string" and value or fallback
end

-- nil when the pack can't be used, with the reason.
local function read_pack(folder, data)
    if type(data.name) ~= "string" then
        return nil, "it has no name"
    end
    local required = tonumber(data.manifest_version) or 1
    if AUDIO_LOADER_VERSION < required then
        return nil, string.format("it requires Audio Loader version %d but only version %d is installed", required, AUDIO_LOADER_VERSION)
    end
    local pack_path = fs.join(PACKS_PATH, folder)
    local mappings = table_or_empty(data.mappings)
    local music = data.music == true
    return {
        name = data.name,
        description = string_or(data.description, ""),
        version = string_or(data.version, "v1.0"),
        author = string_or(data.author, "Unknown"),
        ignore = table_or_empty(data.ignore),
        mappings = mappings,
        music = music,
        hasIntro = music and (mappings["intro_music.mp3"] ~= nil or fs.exists(fs.join(pack_path, "intro_music.mp3"))),
        packPath = slashes(pack_path),
        truncatedPackPath = folder,
        id = string_or(data.id, data.name),
    }
end

local function scan_packs()
    local packs, names = {}, {}
    for _, entry in ipairs(fs.list(PACKS_PATH) or {}) do
        local manifest = fs.join(entry.path, "pack.json")
        if entry.is_directory and fs.is_file(manifest) then
            local data = read_json(manifest)
            local pack, reason
            if data then
                pack, reason = read_pack(entry.name, data)
            else
                reason = "its pack.json can't be read"
            end
            if pack and not names[pack.name] then
                names[pack.name] = true
                packs[#packs + 1] = pack
            elseif not pack then
                logger:warn("Skipped sound pack " .. entry.name .. ": " .. reason)
            end
        end
    end
    sound_packs = packs
end

---@ffi
---@return boolean
function parse_packs()
    scan_packs()
    return true
end

---@ffi
---@return string
function get_sound_packs()
    return json.encode(sound_packs)
end

---@ffi
---@param name string
---@return PackResult
function delete_pack(name)
    for index, pack in ipairs(sound_packs) do
        if pack.name == name then
            local ok, err = pcall(fs.remove_all, fs.join(PACKS_PATH, pack.truncatedPackPath))
            if not ok then
                return { success = false, message = tostring(err) }
            end
            table.remove(sound_packs, index)
            return { success = true, message = "Success" }
        end
    end
    return { success = false, message = "Could not find " .. tostring(name) }
end

-- Writes part of a file of an unpacked pack zip; data is Base64. path is
-- relative to the packs folder and must be inside a pack's folder, so a zip
-- can't replace config.json or STORE. The file appears when its last part is in.
---@ffi
---@param path string
---@param data string
---@param first boolean
---@param last boolean
---@return WriteResult
function write_pack_chunk(path, data, first, last)
    local relative = safe_relative(path)
    if not relative or not string.find(relative, "/", 1, true) or type(data) ~= "string" then
        return { success = false, error = "Invalid pack file: " .. tostring(path) }
    end
    local full = fs.join(PACKS_PATH, relative)
    local temp = full .. ".part"
    local bytes = utils.base64_decode(data)
    local ok, err
    if first then
        local parent = fs.parent_path(full)
        if not fs.is_directory(parent) and not fs.create_directories(parent) and not fs.is_directory(parent) then
            return { success = false, error = "Could not create " .. tostring(parent) }
        end
        ok, err = utils.write_file(temp, bytes)
    else
        ok, err = utils.append_file(temp, bytes)
    end
    if ok and last then
        ok, err = fs.rename(temp, full)
    end
    if not ok then
        os.remove(temp)
        return { success = false, error = tostring(err or ("Could not write " .. relative)) }
    end
    return { success = true }
end

-- Config ------------------------------------------------------------------

local function read_config()
    local config = read_json(CONFIG_PATH) or {}
    for key, default in pairs(DEFAULT_CONFIG) do
        if config[key] == nil then
            config[key] = default
        end
    end
    return config
end

local function write_config(config)
    local ok, err = write_atomic(CONFIG_PATH, json.encode(config))
    if not ok then
        logger:error("Could not save the config: " .. tostring(err))
    end
    return ok == true
end

---@ffi
---@return string
function get_config()
    return json.encode(read_config())
end

-- configObj is upstream's object as JSON. Other keys in the file (sound_volumes)
-- are kept, because upstream's panel always sends the same five.
---@ffi
---@param config_json string
---@return boolean
function set_config(config_json)
    local ok, incoming = pcall(json.decode, config_json)
    if not ok or type(incoming) ~= "table" then
        return false
    end
    local config = read_config()
    for key, default in pairs(DEFAULT_CONFIG) do
        if type(incoming[key]) == type(default) then
            config[key] = incoming[key]
        end
    end
    return write_config(config)
end

-- Volume of single sounds; an addition of this port. value is 0 to 1, and 1 is
-- not stored.
---@ffi
---@return string
function get_sound_volumes()
    local volumes = table_or_empty(read_config().sound_volumes)
    return next(volumes) and json.encode(volumes) or "{}"
end

---@ffi
---@param sound string
---@param value number
---@return boolean
function set_sound_volume(sound, value)
    value = tonumber(value)
    if type(sound) ~= "string" or not string.match(sound, "^[%w_%-]+%.%w+$") or not value or value < 0 or value > 1 then
        return false
    end
    local config = read_config()
    local volumes = table_or_empty(config.sound_volumes)
    volumes[sound] = value < 1 and value or nil
    config.sound_volumes = next(volumes) and volumes or nil
    return write_config(config)
end

---@ffi
---@return boolean
function reset_sound_volumes()
    local config = read_config()
    config.sound_volumes = nil
    return write_config(config)
end

-- STORE file --------------------------------------------------------------
-- key:value lines, as upstream's audio_utils.py reads and writes them.

local function read_store()
    local items, order = {}, {}
    if not fs.is_file(STORE_PATH) then
        return items, order
    end
    for line in string.gmatch(utils.read_file(STORE_PATH) or "", "[^\r\n]+") do
        local key, value = string.match(line, "^%s*([^:]*):(.-)%s*$")
        if key then
            if items[key] == nil then
                order[#order + 1] = key
            end
            items[key] = value
        end
    end
    return items, order
end

---@ffi
---@param key string
---@return string
function store_read(key)
    return read_store()[key] or ""
end

---@ffi
---@param key string
---@param value string
---@return boolean
function store_write(key, value)
    if type(key) ~= "string" or key == "" or string.find(key, "[:\r\n]") then
        return false
    end
    local items, order = read_store()
    if items[key] == nil then
        order[#order + 1] = key
    end
    items[key] = string.gsub(tostring(value), "[\r\n]", "")
    local lines = {}
    for _, name in ipairs(order) do
        lines[#lines + 1] = name .. ":" .. items[name] .. "\n"
    end
    return (write_atomic(STORE_PATH, table.concat(lines)))
end

-- DeckThemes --------------------------------------------------------------

---@ffi
---@param method string
---@param path string
---@param token string
---@param body string
---@return StoreResponse
function store_request(method, path, token, body)
    method = string.upper(tostring(method or "GET"))
    if not STORE_METHODS[method] then
        return { success = false, error = "Unsupported method." }
    end
    if type(path) ~= "string" or string.sub(path, 1, 1) ~= "/" or string.sub(path, 1, 2) == "//"
        or #path > 4096 or string.find(path, "[%z\1-\32\127\\#]") then
        return { success = false, error = "Invalid DeckThemes path." }
    end
    local headers = { ["Accept"] = "application/json" }
    if type(token) == "string" and token ~= "" then
        if #token > 4096 or string.find(token, "[%z\1-\32\127]") then
            return { success = false, error = "Invalid token." }
        end
        headers["Authorization"] = "Bearer " .. token
    end
    local options = { method = method, headers = headers, timeout = NETWORK_TIMEOUT_SECONDS, user_agent = USER_AGENT }
    if type(body) == "string" and body ~= "" then
        headers["Content-Type"] = "application/json"
        options.data = body
    end
    local res, err = http.request(STORE_ORIGIN .. path, options)
    if not res then
        return { success = false, error = tostring(err) }
    end
    return { success = true, status = res.status, body = res.body or "" }
end

-- Pack zips are downloaded here and read by the frontend in chunks, which
-- unpacks them with the browser's DecompressionStream.
local held = {}

---@ffi
---@param blob_id string
---@return HeldBlob
function download_blob(blob_id)
    if type(blob_id) ~= "string" or not string.match(blob_id, "^[%w%-]+$") or #blob_id > 128 then
        return { success = false, error = "Invalid download id." }
    end
    local temp_dir = utils.getenv("TEMP") or utils.getenv("TMP") or PACKS_PATH
    local temp = fs.join(temp_dir, "audioloader-" .. utils.uuid() .. ".zip")
    local ok, result, err = pcall(http.download, STORE_ORIGIN .. "/blobs/" .. blob_id, temp, {
        timeout = NETWORK_TIMEOUT_SECONDS, follow_redirects = true, verify_ssl = true, user_agent = USER_AGENT,
    })
    if not ok or not result or not result.success or (result.status and result.status ~= 200) then
        os.remove(temp)
        return { success = false, error = "Download failed: " .. tostring(ok and (err or (result and result.status)) or result) }
    end
    local size = tonumber(fs.file_size(temp)) or 0
    local bytes = size > 0 and size <= MAX_BLOB_BYTES and utils.read_file(temp) or nil
    os.remove(temp)
    if not bytes or string.sub(bytes, 1, 2) ~= "PK" then
        return { success = false, error = "The download is not a zip file." }
    end
    for id in pairs(held) do
        held[id] = nil
    end
    local id = utils.uuid()
    held[id] = bytes
    return { success = true, id = id, size = #bytes, chunks = math.ceil(#bytes / CHUNK_BYTES) }
end

---@ffi
---@param id string
---@param index number
---@return string|boolean
function read_blob_chunk(id, index)
    local bytes = held[id]
    index = tonumber(index)
    if not bytes or not index or index < 0 or index ~= math.floor(index) then
        return false
    end
    local start = index * CHUNK_BYTES + 1
    if start > #bytes then
        return false
    end
    return utils.base64_encode(string.sub(bytes, start, start + CHUNK_BYTES - 1))
end

---@ffi
---@param id string
---@return boolean
function release_blob(id)
    if type(id) == "string" then
        held[id] = nil
    end
    return true
end

---@ffi
---@return Environment
function get_environment()
    return { packs_path = slashes(PACKS_PATH), packs_linked = packs_linked, loader_version = AUDIO_LOADER_VERSION }
end

-- Lifecycle ---------------------------------------------------------------

-- Nothing here may keep millennium.ready() from being called.
local function on_load()
    local ok, err = pcall(function()
        fs.create_directories(PACKS_PATH)
        if not fs.is_file(CONFIG_PATH) then
            write_config(DEFAULT_CONFIG)
        end
        packs_linked = link_packs()
        scan_packs()
    end)
    if not ok then
        logger:error("Could not load the sound packs: " .. tostring(err))
    end
    logger:info(string.format("Audio Loader found %d sound pack(s) in %s", #sound_packs, PACKS_PATH))
    millennium.ready()
end

local function on_unload() end

return {
    on_load = on_load,
    on_unload = on_unload,
}
