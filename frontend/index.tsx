// Plugin entry. Upstream's frontend (src/) runs on the shim server, which calls
// the Lua backend.
import { definePlugin } from 'millennium';
import { RiFolderMusicFill } from 'react-icons/ri';
import { setDesktopRouteMode } from './desktop-window/routes';
import { serverApi } from './shims/server';
import { loadSoundVolumes, patchSoundVolumes } from './sound-volumes';
import { findAudioParent } from '../src/gamepadAudioFinder';
import upstreamPlugin from '../src/index';
import { dummyFuncTest } from '../src/python';

SteamClient.UI.GetUIMode().then(setDesktopRouteMode).catch(() => setDesktopRouteMode(7));
SteamClient.UI.RegisterForUIModeChanged(setDesktopRouteMode);

// Decky loads plugins after Steam's UI has started; Millennium can be earlier
// than the module holding the audio manager.
async function waitForAudioManager() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const manager = findAudioParent()?.GamepadUIAudio?.m_AudioPlaybackManager;
    if (manager) return manager;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Steam's audio manager was not found");
}

export default definePlugin(async () => {
  const manager = await waitForAudioManager();
  await loadSoundVolumes().catch((error) => console.warn('[Audio Loader] Sound volumes could not be loaded', error));

  const upstream = upstreamPlugin(serverApi);
  const volumePatch = patchSoundVolumes(Object.getPrototypeOf(manager));
  // Upstream's panel shows an error until this answers; Decky keeps the panel
  // mounted, and Millennium mounts it when it opens.
  dummyFuncTest();

  const environment = await backend.get_environment();
  if (!environment.packs_linked) {
    console.error('[Audio Loader] Steam cannot reach the sound packs; see the plugin log.');
    serverApi.toaster.toast({ title: 'Audio Loader', body: 'Steam cannot reach your sound packs. Default sounds may be silent.' });
  }

  return {
    title: 'Audio Loader',
    icon: <RiFolderMusicFill />,
    content: upstream.content,
    onDismount() {
      volumePatch.unpatch();
      upstream.onDismount();
    },
  };
});
