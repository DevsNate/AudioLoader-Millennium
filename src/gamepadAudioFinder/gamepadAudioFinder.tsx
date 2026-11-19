import { Module, findModuleChild } from "decky-frontend-lib";

// Millennium: a function, because the module may not have loaded yet when this
// file is evaluated.
export const findAudioParent = () =>
  findModuleChild((m: Module) => {
    if (typeof m !== "object") return undefined;
    for (let prop in m) {
      if (m[prop]?.GamepadUIAudio) {
        return m[prop];
      }
    }
  });
