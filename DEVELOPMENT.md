# Development

## Building
```bash
pnpm install
pnpm run build
```
The package is written to `dist/audioloader.star`; building does not install it
or restart Steam. A plain `starlight pack -o dist` (with `dist/` already created)
also builds it with no install, which is how Millennium's plugin database builds
plugins: the small libraries are committed in `frontend/vendor/`.

| Command | What it does |
|---|---|
| `pnpm dev` | Rebuilds on change |
| `pnpm check` | Runs every check in `scripts/checks/`; build first |
| `pnpm vendor` | Regenerates `frontend/vendor/` after a dependency or icon change |

Don't run `starlight lsp` here: it overwrites the `paths` in `tsconfig.json` that
map `decky-frontend-lib` and the small libraries to this repository's copies.

## Project layout
```
backend/main.lua          Lua backend: packs, config, the steamui link and
                          DeckThemes requests
frontend/                 The Millennium side
  index.tsx               Entry point
  sound-volumes.tsx       Sound Volumes: the patch and the Pack Manager tab
  engine/                 Pack install and zip unpacking
  shims/                  decky-frontend-lib and upstream's ServerAPI on top of Millennium
  desktop-window/         The Pack Manager in its own desktop window
  vendor/                 Committed libraries (generated)
src/                      Upstream's code, same layout; edits marked // Millennium:
scripts/                  vendor, sync-upstream, and checks/
```

## Updating from upstream
This port is based on [SDH-AudioLoader](https://github.com/DeckThemes/SDH-AudioLoader);
`package.json` records the upstream version and commit under `"upstream"`.
`src/` keeps upstream's layout, and every change to it is marked `// Millennium:`.
```bash
pnpm sync-upstream          # upstream's main, or: pnpm sync-upstream <branch|tag|commit>
```
This three-way applies upstream's `src/` changes, leaves conflict markers where
they meet a `// Millennium:` edit, lists what has to be ported by hand (the
Python backend goes to `backend/main.lua`) and the dependency changes, then
records the new base. Nothing is committed. Finish with `pnpm build && pnpm check`.
