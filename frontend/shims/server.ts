// The one object upstream's frontend talks to. Same method names and
// { success, result } replies as decky-frontend-lib 3's ServerAPI, answered by
// the Lua backend instead of a Python one.
import { routerHook as millenniumRouterHook, toaster } from 'millennium';
import type { ReactElement } from 'react';
import { expectBoolean, fromBackendJson } from '../engine/files';
import { installPack } from '../engine/store';
import type { Pack } from '../../src/classes';

type Reply<T = any> = { success: true; result: T } | { success: false; result: any };

const STORE_ORIGIN = 'https://api.deckthemes.com';

// Upstream's route components by path; the desktop window renders them too.
export const routes = new Map<string, () => ReactElement>();

// Lua's JSON writes an empty table as {}, whether it was a list or an object.
const asPacks = (reply: unknown): Pack[] => {
  const packs = fromBackendJson<Pack[]>(reply);
  if (!Array.isArray(packs)) return [];
  return packs.map((pack) => ({
    ...pack,
    ignore: Array.isArray(pack.ignore) ? pack.ignore : [],
    mappings: pack.mappings && !Array.isArray(pack.mappings) ? pack.mappings : {},
  }));
};

async function dispatch(method: string, args: Record<string, any>): Promise<unknown> {
  switch (method) {
    case 'dummy_function': return true;
    case 'get_loader_version': return (await backend.get_environment()).loader_version;
    case 'get_sound_packs': return asPacks(await backend.get_sound_packs());
    case 'parse_packs': return backend.parse_packs();
    case 'download_theme_from_url': return installPack(args.id);
    case 'delete_pack': return backend.delete_pack(args.name);
    case 'get_config': return fromBackendJson(await backend.get_config());
    case 'set_config': return expectBoolean(backend.set_config(JSON.stringify(args.configObj)), 'The config could not be saved.');
    case 'store_read': return backend.store_read(args.key);
    case 'store_write': await expectBoolean(backend.store_write(args.key, args.val), 'The value could not be saved.'); return { success: true, message: 'Success' };
    default: throw new Error(`Unknown method ${method}`);
  }
}

async function fetchNoCors(url: string, init: RequestInit = {}): Promise<Reply> {
  try {
    const target = new URL(url);
    if (target.origin !== STORE_ORIGIN || target.username || target.password) throw new Error(`Refused request to ${target.origin}`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = /^Bearer (.+)$/.exec(headers.Authorization ?? '')?.[1] ?? '';
    const reply = await backend.store_request(init.method ?? 'GET', target.pathname + target.search, token, typeof init.body === 'string' ? init.body : '');
    if (!reply.success) return { success: false, result: reply.error };
    return { success: true, result: { status: reply.status, body: reply.body, headers: {} } };
  } catch (error) {
    return { success: false, result: String((error as Error)?.message ?? error) };
  }
}

export const serverApi = {
  async callPluginMethod<_Args = {}, Result = any>(method: string, args: object): Promise<Reply<Result>> {
    try {
      return { success: true, result: await dispatch(method, args as Record<string, any>) as Result };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      console.warn(`[Audio Loader] ${method}: ${message}`);
      return { success: false, result: message };
    }
  },
  fetchNoCors: fetchNoCors as <Result = any>(url: string, init?: RequestInit) => Promise<Reply<Result>>,
  toaster: {
    toast: (data: { title: any; body: any; duration?: number }) => toaster.toast(data as any),
  },
  routerHook: {
    addRoute(path: string, component: () => ReactElement) {
      routes.set(path, component);
      millenniumRouterHook.removeRoute(path);
      millenniumRouterHook.addRoute(path, component);
    },
    removeRoute(path: string) {
      routes.delete(path);
      millenniumRouterHook.removeRoute(path);
    },
  },
};

export type ServerAPI = typeof serverApi;
