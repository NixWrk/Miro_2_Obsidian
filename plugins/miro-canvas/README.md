# Miro Canvas

`miro-canvas` is an offline Obsidian plugin that extends the native Canvas
view. The `.canvas` format stays valid and useful when the plugin is disabled.

The M0 foundation is deliberately small: it registers no network clients, does
not contact Miro, and does not write a Canvas file while a board is being
opened. It adds one explicit `Initialize board metadata` command for the
active native Canvas. Metadata features call the internal
`MetadataWriter.write(action, mutate)` boundary; native Canvas Ctrl/Cmd+Z and
Ctrl/Cmd+Y history actions are the intended undo/redo path, not a competing
plugin history UI. Advanced Canvas is an optional integration target and is
not a package or runtime dependency.

The current development checkpoint also includes M1 controls for navigation,
minimap, typography, themes, colors, locks/review mode, and attachment titles.
Native zoom remains limited to 6.25%–200%. The command **Local comments,
anchors and documents** opens the initial M2 tools; select a file node first
to expose its native document-opening controls. The shape-creation transaction
model is tested but not connected to the UI. M3 rotation, z-order, and Miro
renderers remain pending. Automated browser checks use a synthetic host;
real-Obsidian verification is still required.

## Development

Run these commands from this directory after installing the development
dependencies in your own environment:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

The build emits the three runtime assets required by Obsidian:
`manifest.json`, `main.js`, and `styles.css`. To deploy that local build into
the guarded project-local M0 test vault, run from the repository root:

```powershell
cd plugins\miro-canvas
npm ci
npm run typecheck
npm test
npm run build
cd ..\..
python tools\obsidian_oracle\setup_m0_vault.py
python tools\obsidian_oracle\check_environment.py
```

The setup script copies only those release assets into
`_obsidian_oracle_vault\.obsidian\plugins\miro-canvas`, stages the four
offline compatibility fixtures, and enables the local plugin. It refuses
arbitrary vault paths and link/reparse points. It creates only an Advanced
Canvas placeholder manifest; install its real runtime separately when a real
Obsidian check is authorized. The setup scripts do not register or open the
vault in an Obsidian window.

For the exact profile activation/check pairs, the CAS boundary, fail-closed
rules, and the real-app gate, see [`docs/miro-canvas.md`](../../docs/miro-canvas.md).

`npm run dev` starts esbuild in watch mode. The production bundle is emitted as
`main.js` next to `manifest.json` and `styles.css`, which is the layout expected
by Obsidian's local plugin loader. The repository tracks `package-lock.json`, so
`npm ci` installs the reproducible development dependency set.

Native root persistence is enabled only when the known writable `Canvas.data`
property and synchronous `requestSave(true)` history boundary are present.
The bridge performs an in-memory compare-and-swap root replacement and asks
Obsidian for its native undo snapshot; Obsidian's normal debounced disk save is
not a synchronously proven filesystem transaction. Incompatible, read-only,
malformed, or async boundaries fail closed and leave native Canvas usable.

There is intentionally no `postinstall` hook and no runtime dependency. Keep
generated `main.js` files and local vault copies out of source control unless a
release process explicitly packages them.
