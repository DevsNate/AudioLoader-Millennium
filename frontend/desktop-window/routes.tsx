// The desktop client has no pack manager routes to navigate to, so upstream's
// pages open in a window of their own, with a small history of their own.
// Adapted from SteamGridDB-Millennium's popout.
import { showModal } from 'millennium';
import { useEffect, useState } from 'react';
import { routes } from '../shims/server';
import { PageWindowBoundary } from './window-boundary';

export const WINDOW_TITLE = 'Audio Loader';
const DESKTOP_MODE = 7;
const PAGE_CLASS = 'audioLoaderDesktopPage';

let uiMode: number | null = null;
export const setDesktopRouteMode = (mode: number) => {
  uiMode = mode;
};

let history: string[] = [];
let modal: { Close(): void } | null = null;
let pageWindow: Window | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

const desktopWindow = () => (globalThis as any).g_PopupManager?.GetExistingPopup?.('SP Desktop_uid0')?.m_popup ?? window;

const DesktopPages = () => {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const path = history[history.length - 1] ?? null;
  const Page = path ? routes.get(path) : undefined;
  return (
    <PageWindowBoundary pageClass={PAGE_CLASS} onWindow={(owner) => { pageWindow = owner; }} onCancel={desktopNavigateBack}>
      {Page ? <Page /> : null}
    </PageWindowBoundary>
  );
};

const openWindow = () => {
  modal = showModal(<DesktopPages />, desktopWindow(), {
    strTitle: WINDOW_TITLE,
    bHideMainWindowForPopouts: false,
    bForcePopOut: true,
    popupHeight: 800,
    popupWidth: 1280,
    fnOnClose: () => {
      modal = null;
      pageWindow = null;
      history = [];
    },
  } as any);
};

// True when the path was handled here.
export function desktopNavigate(path: string): boolean {
  if (uiMode !== DESKTOP_MODE || !routes.has(path)) return false;
  const open = Boolean(pageWindow && !pageWindow.closed && modal);
  if (!open) {
    history = [path];
    openWindow();
    return true;
  }
  if (history[history.length - 1] !== path) history.push(path);
  changed();
  bringToFront();
  return true;
}

// The cog and download buttons are in Steam's window, which a click brings to
// the front; window.focus() from there doesn't raise ours. Steam raises its
// windows through their popup's Focus() (SteamClient.Window.BringToFront).
function bringToFront() {
  if (!pageWindow) return;
  try {
    const popups: any[] = [...((globalThis as any).g_PopupManager?.GetPopups?.() ?? [])];
    const popup = popups.find((entry) => entry?.m_popup === pageWindow);
    if (typeof popup?.Focus === 'function') {
      popup.Focus();
      return;
    }
    (pageWindow as any).SteamClient?.Window?.BringToFront?.();
  } catch {}
  pageWindow.focus();
}

export function desktopNavigateBack(): boolean {
  if (uiMode !== DESKTOP_MODE || !pageWindow || pageWindow.closed) return false;
  if (history.length > 1) {
    history.pop();
    changed();
  } else {
    pageWindow.close();
  }
  return true;
}

