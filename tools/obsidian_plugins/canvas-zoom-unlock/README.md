# Canvas Zoom Unlock

Small local Obsidian plugin for testing large Miro-to-Canvas exports.

The plugin patches Obsidian Canvas instances at runtime and relaxes the zoom
range used by wheel zoom, `setViewport`, and `zoomToBbox`/`zoomToFit` style
operations. It does not modify `.canvas` files.

Default range:

- `minTZoom = -12` means scale `2^-12`, or about `1/4096`.
- `maxTZoom = 8` means scale `2^8`, or `256x`.

This relies on private Obsidian Canvas internals. It is intentionally small,
local, and easy to remove if an Obsidian update changes those internals.
