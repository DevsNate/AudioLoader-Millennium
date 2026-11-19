// Upstream imports decky-frontend-lib 3; Millennium's SDK carries the same
// library. Only what differs is defined here.
import { Navigation as SteamNavigation } from 'millennium';
import { desktopNavigate, desktopNavigateBack } from '../../desktop-window/routes';
import type { ServerAPI } from '../server';

export {
  ButtonItem,
  DialogButton,
  Dropdown,
  DropdownItem,
  Focusable,
  PanelSection,
  PanelSectionRow,
  SliderField,
  TextField,
  ToggleField,
  afterPatch,
  beforePatch,
  findModuleChild,
  gamepadDialogClasses,
  staticClasses,
} from 'millennium';
export type { DropdownOption, Module, SingleDropdownOption } from 'millennium';
export type { ServerAPI } from '../server';
export { Tabs } from './tabs';

// Upstream's default export is definePlugin(serverApi => plugin); the entry
// (frontend/index.tsx) calls it with the shim.
export const definePlugin = <T,>(factory: (serverApi: ServerAPI) => T) => factory;

// Desktop mode has no pack manager route to go to: it opens in our window.
export const Navigation: typeof SteamNavigation = new Proxy(SteamNavigation, {
  get(target, property, receiver) {
    if (property === 'Navigate') {
      return (path: string) => (desktopNavigate(path) ? undefined : target.Navigate(path));
    }
    if (property === 'NavigateBack') {
      return () => (desktopNavigateBack() ? undefined : target.NavigateBack());
    }
    return Reflect.get(target, property, receiver);
  },
});

// decky-frontend-lib 3's older name.
export const Router = Navigation;
