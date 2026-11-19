// Volume of single sounds, an addition of this port: a page in the pack manager
// and a gain node per sound, on top of upstream's overall sound effect volume.
import { afterPatch, ButtonItem, PanelSectionRow, SliderField } from 'decky-frontend-lib';
import { useState } from 'react';
import { fromBackendJson } from './engine/files';

// Every UI sound Steam ships (the /sounds/ files in steamui/sp.js).
const STEAM_SOUNDS = [
  'bumper_end.wav', 'camera1.wav', 'confirmation_negative.wav', 'confirmation_positive.wav',
  'deck_ui_achievement_toast.wav', 'deck_ui_bumper_end_02.wav', 'deck_ui_default_activation.wav',
  'deck_ui_hide_modal.wav', 'deck_ui_into_game_detail.wav', 'deck_ui_launch_game.wav',
  'deck_ui_message_toast.wav', 'deck_ui_misc_01.wav', 'deck_ui_misc_08.wav', 'deck_ui_misc_10.wav',
  'deck_ui_navigation.wav', 'deck_ui_out_of_game_detail.wav', 'deck_ui_show_modal.wav',
  'deck_ui_side_menu_fly_in.wav', 'deck_ui_side_menu_fly_out.wav', 'deck_ui_slider_down.wav',
  'deck_ui_slider_up.wav', 'deck_ui_switch_toggle_off.wav', 'deck_ui_switch_toggle_on.wav',
  'deck_ui_tab_transition_01.wav', 'deck_ui_tile_scroll.wav', 'deck_ui_toast.wav', 'deck_ui_typing.wav',
  'deck_ui_volume.wav', 'desktop_toast_default.wav', 'desktop_toast_short.wav', 'pop_sound.wav',
  'recording_highlight.wav', 'recording_start.wav', 'recording_stop.wav', 'steam_os_startup.wav',
  'timer_expired_alarm.wav',
];

let volumes: Record<string, number> = {};

export async function loadSoundVolumes() {
  const stored = fromBackendJson<Record<string, number>>(await backend.get_sound_volumes());
  volumes = stored && !Array.isArray(stored) ? stored : {};
}

const soundName = (url: unknown) => (typeof url === 'string' && url.startsWith('/sounds/') ? url.slice(8) : null);

// Install after upstream's patch of PlayAudioURL, so args[0] here is still
// Steam's own URL. Steam calls PlayBuffer once the sound has loaded, which is
// after this returns.
export function patchSoundVolumes(manager: any) {
  return afterPatch(manager, 'PlayAudioURL', (args: any[], playback: any) => {
    const name = soundName(args[0]);
    const volume = name ? volumes[name] ?? 1 : 1;
    if (volume >= 1 || typeof playback?.PlayBuffer !== 'function') return playback;
    const playBuffer = playback.PlayBuffer;
    playback.PlayBuffer = function (this: any, buffer: AudioBuffer, destination: AudioNode) {
      const gain = this.m_Manager.context.createGain();
      gain.gain.value = volume;
      gain.connect(destination);
      return playBuffer.call(this, buffer, gain);
    };
    return playback;
  });
}

const labelOf = (sound: string) => sound.replace(/\.\w+$/, '').replace(/^deck_ui_/, '').replace(/_/g, ' ')
  .replace(/^./, (letter) => letter.toUpperCase());

export const SoundVolumesPage = () => {
  const [shown, setShown] = useState(volumes);
  const change = (sound: string, percent: number) => {
    const value = percent / 100;
    const next = { ...volumes };
    if (value < 1) next[sound] = value;
    else delete next[sound];
    volumes = next;
    setShown(next);
    void backend.set_sound_volume(sound, value);
  };
  const reset = () => {
    volumes = {};
    setShown({});
    void backend.reset_sound_volumes();
  };
  return (
    <div>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={reset} disabled={Object.keys(shown).length === 0}>
          Reset All to 100%
        </ButtonItem>
      </PanelSectionRow>
      {STEAM_SOUNDS.map((sound) => (
        <SliderField
          key={sound}
          label={labelOf(sound)}
          description={sound}
          value={Math.round((shown[sound] ?? 1) * 100)}
          min={0}
          max={100}
          step={5}
          showValue
          valueSuffix="%"
          onChange={(percent: number) => change(sound, percent)}
        />
      ))}
    </div>
  );
};
