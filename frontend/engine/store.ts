// Installing a pack from DeckThemes. Ported from upstream's
// audio_remoteinstall.py; Lua downloads the zip, this unpacks it, and each file
// goes back through a validated backend call.
import { expectWrite } from './files';
import { fromBase64, readZip, toBase64 } from './zip';

export type Result = { success: boolean; message?: string };

const AUDIO_LOADER_VERSION = 3;
// Multiple of 3 bytes, as in the backend's chunks: Base64 without padding per
// part, and each backend call well under its size limit.
const CHUNK_BYTES = 3 * 1024 * 1024;

type PackRecord = { manifestVersion: number; download: { id: string } };

async function downloadZip(blobId: string): Promise<Uint8Array> {
  const held = await backend.download_blob(blobId);
  if (!held.success || !held.id) throw new Error(held.error || 'The pack could not be downloaded.');
  try {
    const parts: Uint8Array[] = [];
    for (let index = 0; index < (held.chunks ?? 0); index++) {
      const chunk = await backend.read_blob_chunk(held.id, index);
      if (typeof chunk !== 'string') throw new Error('The downloaded pack could not be read.');
      parts.push(fromBase64(chunk));
    }
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  } finally {
    void backend.release_blob(held.id);
  }
}

async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  do {
    const end = Math.min(offset + CHUNK_BYTES, bytes.length);
    await expectWrite(backend.write_pack_chunk(path, toBase64(bytes.subarray(offset, end)), offset === 0, end === bytes.length));
    offset = end;
  } while (offset < bytes.length);
}

export async function installPack(id: string): Promise<Result> {
  let record: PackRecord;
  try {
    const reply = await backend.store_request('GET', `/themes/${encodeURIComponent(id)}`, '', '');
    if (!reply.success || reply.status !== 200) throw new Error(reply.error || `Invalid status code ${reply.status}`);
    record = JSON.parse(reply.body ?? '');
  } catch (error) {
    return { success: false, message: String((error as Error)?.message ?? error) };
  }
  if (record.manifestVersion > AUDIO_LOADER_VERSION) {
    throw new Error('Manifest version of themedb entry is unsupported by this version of AudioLoader');
  }
  try {
    const entries = readZip(await downloadZip(record.download.id));
    // pack.json last: a download cut short doesn't leave a pack that looks whole.
    entries.sort((a, b) => Number(a.name.endsWith('/pack.json')) - Number(b.name.endsWith('/pack.json')));
    for (const entry of entries) await writeFile(entry.name, await entry.bytes());
  } catch (error) {
    return { success: false, message: String((error as Error)?.message ?? error) };
  }
  return { success: true };
}
