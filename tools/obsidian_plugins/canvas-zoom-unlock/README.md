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

Conversion policy:

- Use this plugin in a controlled test vault when validating very large
  Miro boards where readability is more important than stock Obsidian zoom
  compatibility.
- For zoom-unlocked validation, run local samples with `--scale-mode readable`
  and `--min-zoom 0.000244140625`.
- FullHD fit at the stock `min_zoom=0.12` remains a compatibility check for
  vaults without this plugin.
