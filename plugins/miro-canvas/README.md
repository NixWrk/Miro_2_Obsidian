# Miro Canvas

`miro-canvas` is an offline Obsidian plugin that extends the native Canvas
view. The `.canvas` format stays valid and useful when the plugin is disabled.

The initial M0 shell is deliberately small: it registers no network clients,
does not contact Miro, and does not write a Canvas file while a board is being
opened. Advanced Canvas is an optional integration target and is not a package
or runtime dependency.

## Development

Run these commands from this directory after installing the development
dependencies in your own environment:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

`npm run dev` starts esbuild in watch mode. The production bundle is emitted as
`main.js` next to `manifest.json` and `styles.css`, which is the layout expected
by Obsidian's local plugin loader. The repository tracks `package-lock.json`, so
`npm ci` installs the reproducible development dependency set.

There is intentionally no `postinstall` hook and no runtime dependency. Keep
generated `main.js` files and local vault copies out of source control unless a
release process explicitly packages them.
