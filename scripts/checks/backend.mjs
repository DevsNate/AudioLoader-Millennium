// Runs backend/ in fengari with stub Millennium modules and checks pack scanning,
// the link into steamui, config and STORE handling, and the limits on what the
// frontend can write or request.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createBackend, PACKS } from './lib/lua-backend.mjs';

const packed = process.argv.includes('--packed');
const source = packed
  ? execFileSync(process.execPath, ['node_modules/@steambrew/starlight/bin/starlight.js', '-i', 'dist/audioloader.star', '-q', 'backend:backend/main.lua'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  : undefined;

const LINK = 'C:/Steam/steamui/sounds_custom';
const fresh = () => {
  const backend = createBackend({ source }).start();
  backend.run(`dirs['C:/Steam/steamui'] = true`);
  return backend;
};
const pack = (backend, folder, json, extra = {}) => {
  backend.setFile(`${PACKS}/${folder}/pack.json`, typeof json === 'string' ? json : JSON.stringify(json));
  for (const [name, text] of Object.entries(extra)) backend.setFile(`${PACKS}/${folder}/${name}`, text);
};
const packs = (backend) => JSON.parse(backend.call('get_sound_packs'));
const result = (text) => JSON.parse(text);

// --- Startup and the link ---------------------------------------------------
{
  const backend = fresh().load();
  assert.equal(backend.evaluate('ready_calls'), '1', 'millennium.ready must be called');
  assert.match(backend.evaluate('commands[1]'), /^mklink \/J "C:\\Steam\\steamui\\sounds_custom" "C:\\Users\\T\\homebrew\\sounds"$/);
  assert.equal(result(backend.call('get_environment')).packs_linked, true);
  assert.deepEqual(JSON.parse(backend.getFile(`${PACKS}/config.json`)), {
    selected_pack: 'Default', selected_music: 'None', sound_volume: 1, music_volume: 0.5, legacy_enabled: false,
  });
}
{
  // An existing link is left alone.
  const backend = fresh();
  backend.run(`links['${LINK}'] = '${PACKS}'; dirs['${LINK}'] = true; dirs['${PACKS}'] = true`);
  backend.load();
  assert.equal(backend.evaluate('#commands'), '0');
  assert.equal(result(backend.call('get_environment')).packs_linked, true);
}
{
  // Packs in a real sounds_custom folder move over; the folder becomes the link.
  const backend = fresh();
  backend.setFile(`${LINK}/Old/pack.json`, JSON.stringify({ name: 'Old' }));
  backend.load();
  assert.equal(backend.evaluate('#commands'), '1');
  assert.deepEqual(packs(backend).map((item) => item.name), ['Old']);
}
{
  // Files left in the folder: don't touch it, and say so.
  const backend = fresh();
  backend.setFile(`${LINK}/loose.wav`, 'x');
  backend.load();
  assert.equal(backend.evaluate('#commands'), '0');
  assert.equal(backend.getFile(`${LINK}/loose.wav`), 'x');
  assert.equal(result(backend.call('get_environment')).packs_linked, false);
  assert.equal(backend.evaluate('ready_calls'), '1');
}
{
  // mklink failing is reported, and startup still finishes.
  const backend = fresh();
  backend.run('link_works = false');
  backend.load();
  assert.equal(result(backend.call('get_environment')).packs_linked, false);
  assert.equal(backend.evaluate('ready_calls'), '1');
}

// --- Packs ------------------------------------------------------------------
{
  const backend = fresh();
  pack(backend, 'PS5', {
    name: 'PS5_Sounds', author: 'a', version: 'v2', manifest_version: 1, music: false,
    ignore: ['x.wav'], mappings: { 'a.wav': ['b.wav', 'c.wav'] }, id: 'uuid',
  });
  pack(backend, 'Bare', { name: 'Bare' });
  pack(backend, 'Dup', { name: 'Bare' });
  pack(backend, 'Tune', { name: 'Tune', music: true }, { 'intro_music.mp3': 'x' });
  pack(backend, 'Mapped', { name: 'Mapped', music: true, mappings: { 'intro_music.mp3': ['i.mp3'] } });
  pack(backend, 'Future', { name: 'Future', manifest_version: 4 });
  pack(backend, 'Nameless', { author: 'x' });
  pack(backend, 'Broken', '{');
  backend.setFile(`${PACKS}/NoManifest/a.wav`, 'x');
  backend.load();
  const list = packs(backend);
  assert.deepEqual(list.map((item) => item.name).sort(), ['Bare', 'Mapped', 'PS5_Sounds', 'Tune']);
  const by = Object.fromEntries(list.map((item) => [item.name, item]));
  assert.equal(by.PS5_Sounds.truncatedPackPath, 'PS5');
  assert.equal(by.PS5_Sounds.packPath, `${PACKS}/PS5`);
  assert.equal(by.PS5_Sounds.id, 'uuid');
  assert.deepEqual(by.PS5_Sounds.mappings, { 'a.wav': ['b.wav', 'c.wav'] });
  assert.deepEqual(by.PS5_Sounds.ignore, ['x.wav']);
  assert.equal(by.Bare.author, 'Unknown');
  assert.equal(by.Bare.version, 'v1.0');
  assert.equal(by.Bare.id, 'Bare');
  assert.equal(by.Bare.truncatedPackPath, 'Bare', 'the first folder with a name wins');
  assert.equal(by.Bare.hasIntro, false);
  assert.equal(by.Tune.hasIntro, true, 'an intro file');
  assert.equal(by.Mapped.hasIntro, true, 'a mapped intro');

  assert.equal(result(backend.call('delete_pack', 'Nope')).success, false);
  assert.equal(result(backend.call('delete_pack', 'Tune')).success, true);
  assert.equal(backend.getFile(`${PACKS}/Tune/pack.json`), '');
  assert.ok(!packs(backend).some((item) => item.name === 'Tune'));
}

// --- Writing pack files -----------------------------------------------------
{
  const backend = fresh().load();
  for (const path of ['../x.wav', 'P/../../x.wav', 'C:/x.wav', '/x.wav', 'P/a|b.wav', 'config.json', 'STORE', 'P/.. /x', '']) {
    assert.equal(result(backend.call('write_pack_chunk', path, 'x', true, true)).success, false, `must refuse ${path}`);
  }
  assert.equal(result(backend.call('write_pack_chunk', 'P/a.wav', 'one', true, false)).success, true);
  assert.equal(backend.getFile(`${PACKS}/P/a.wav`), '', 'not visible until the last part');
  assert.equal(result(backend.call('write_pack_chunk', 'P/a.wav', 'two', false, true)).success, true);
  assert.equal(backend.getFile(`${PACKS}/P/a.wav`), 'onetwo');
  assert.equal(backend.getFile(`${PACKS}/P/a.wav.part`), '');
}

// --- Config -----------------------------------------------------------------
{
  const backend = fresh();
  backend.setFile(`${PACKS}/config.json`, JSON.stringify({ selected_pack: 'PS5_Sounds', sound_volume: 0.31 }));
  backend.load();
  const config = JSON.parse(backend.call('get_config'));
  assert.equal(config.selected_pack, 'PS5_Sounds', 'an existing config is kept');
  assert.equal(config.sound_volume, 0.31);
  assert.equal(config.music_volume, 0.5, 'missing keys get defaults');

  assert.equal(backend.call('set_sound_volume', 'deck_ui_navigation.wav', 0.5), 'true');
  assert.equal(backend.call('set_config', JSON.stringify({ selected_pack: 'B', selected_music: 'None', sound_volume: 'loud', music_volume: 0.2, legacy_enabled: true, other: 1 })), 'true');
  const saved = JSON.parse(backend.getFile(`${PACKS}/config.json`));
  assert.equal(saved.selected_pack, 'B');
  assert.equal(saved.sound_volume, 0.31, 'a wrong type is ignored');
  assert.equal(saved.legacy_enabled, true);
  assert.equal(saved.other, undefined);
  assert.deepEqual(saved.sound_volumes, { 'deck_ui_navigation.wav': 0.5 }, "upstream's panel doesn't drop the sound volumes");
  assert.equal(backend.call('set_config', '{'), 'false');

  for (const [sound, value] of [['../x.wav', 0.5], ['a.wav', 2], ['a.wav', -1]]) {
    assert.equal(backend.call('set_sound_volume', sound, value), 'false', `${sound} ${value}`);
  }
  assert.deepEqual(JSON.parse(backend.call('get_sound_volumes')), { 'deck_ui_navigation.wav': 0.5 });
  assert.equal(backend.call('set_sound_volume', 'deck_ui_navigation.wav', 1), 'true');
  assert.equal(backend.call('get_sound_volumes'), '{}', '100% is not stored');
  backend.call('set_sound_volume', 'a.wav', 0);
  assert.deepEqual(JSON.parse(backend.call('get_sound_volumes')), { 'a.wav': 0 }, 'silent is a value');
  assert.equal(backend.call('reset_sound_volumes'), 'true');
  assert.equal(backend.call('get_sound_volumes'), '{}');
}

// --- STORE ------------------------------------------------------------------
{
  const backend = fresh();
  backend.setFile(`${PACKS}/STORE`, 'shortToken:abc:def\nbroken\n\nother:1\n');
  backend.load();
  assert.equal(backend.call('store_read', 'shortToken'), 'abc:def', 'only the first colon splits');
  assert.equal(backend.call('store_read', 'missing'), '');
  assert.equal(backend.call('store_write', 'shortToken', 'new\nvalue'), 'true');
  assert.equal(backend.call('store_write', 'bad:key', 'x'), 'false');
  assert.equal(backend.getFile(`${PACKS}/STORE`), 'shortToken:newvalue\nother:1\n');
}

// --- DeckThemes -------------------------------------------------------------
{
  const backend = fresh().load();
  for (const [path, ok] of [['/themes/abc', true], ['//evil.example/x', false], ['evil', false], ['/a b', false], ['/a\\b', false], ['/a#b', false]]) {
    assert.equal(result(backend.call('store_request', 'GET', path, '', '')).success, ok, `store_request ${path}`);
  }
  assert.equal(result(backend.call('store_request', 'PUT', '/x', '', '')).success, false, 'other methods are refused');
  assert.equal(result(backend.call('store_request', 'GET', '/x', 'bad token', '')).success, false);
  backend.call('store_request', 'GET', '/x', 'tok', '');
  assert.equal(backend.evaluate('requests[#requests].options.headers.Authorization'), 'Bearer tok');
  assert.ok(backend.evaluate('requests[#requests].url').startsWith('https://api.deckthemes.com/'));

  assert.equal(result(backend.call('download_blob', '../x')).success, false);
  backend.run(`download_body = 'not a zip'`);
  assert.equal(result(backend.call('download_blob', 'abc')).success, false, 'only zips are held');
  backend.run(`download_body = 'PK' .. string.rep('a', 3 * 1024 * 1024 + 1)`);
  const held = result(backend.call('download_blob', 'abc'));
  assert.equal(held.success, true);
  assert.equal(held.chunks, 2);
  assert.equal(backend.call('read_blob_chunk', held.id, 2), 'false');
  assert.equal(backend.call('read_blob_chunk', held.id, 1).length, 3);
  backend.call('release_blob', held.id);
  assert.equal(backend.call('read_blob_chunk', held.id, 0), 'false');
}

console.log(`Backend checks passed${packed ? ' (packed backend)' : ''}.`);
