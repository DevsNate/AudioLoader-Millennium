// Big Picture's controls and dialogs in a desktop window. From
// SteamGridDB-Millennium.
import { findModuleExport } from 'millennium';
import type { ComponentType, ReactNode } from 'react';

// Big Picture's root carries these, and much of sp.css (inputs, fields, scrollbars)
// is scoped under them. Desktop windows don't have that root.
export const bigPictureRootClasses = 'BasicUI GamepadMode';

let nativeProvider: ComponentType<{ children?: ReactNode }> | undefined;

export const BigPicturePresentation = ({ children }: { children?: ReactNode }) => {
  nativeProvider ??= findModuleExport((exported: unknown) => {
    if (typeof exported !== 'function') return false;
    const source = Function.prototype.toString.call(exported);
    return source.includes('.Provider') && source.includes('strButtonClassName:')
      && source.includes('SliderField:') && source.includes('ToggleField:');
  }) as typeof nativeProvider;

  if (!nativeProvider) {
    return <div role="alert">Audio Loader could not load Steam's Big Picture controls. Reopen this window after Steam finishes loading.</div>;
  }
  const Provider = nativeProvider;
  return <Provider>{children}</Provider>;
};
