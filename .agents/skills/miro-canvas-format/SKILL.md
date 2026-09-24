---
name: miro-canvas-format
description: Read, check and safely edit Obsidian Canvas boards made by miro2obsidian or the miro-canvas plugin - .canvas files with miroSource (the imported Miro snapshot) and miroCanvas (the plugin's metadata). Use when a person asks what is on such a board, wants cards, lines, comments, layers, locks or export pages changed without Obsidian open, wants a board validated, or asks how the format works.
---

# Miro Canvas boards

A board is an ordinary JSON Canvas 1.0 file (`nodes`, `edges`) that native
Obsidian Canvas opens on its own. Two optional root keys carry what Canvas
cannot express:

- `miroSource` - the Miro board as it was exported. **Immutable evidence: never
  change, shorten, reformat or "fix" it.**
- `miroCanvas` - the plugin's versioned metadata (`schemaVersion: 1`): local
  look, locks, comments, independent lines, export pages, bindings to source
  items.

Everything the plugin draws falls back to plain Canvas without it, so edit the
native `nodes`/`edges` whenever they can express the change, and `miroCanvas`
only for what they cannot. Read [references/format.md](references/format.md)
before editing; it lists every field with the rules the plugin relies on.

## Check a board

The contract is JSON Schema (draft 2020-12) in `miro2obsidian/schemas/v1/`
(`board.schema.json`, `miro-source.schema.json`, `miro-canvas.schema.json`),
with valid and invalid example boards in `fixtures/`.

```powershell
python -m miro2obsidian.validate path\to\board.canvas
```

It prints `valid` or one issue per line as `<json-pointer>: <message>` and
exits non-zero on an invalid board. Without the repository, validate with any
draft 2020-12 validator against those three files. Validate before editing
(to know what was already wrong) and after (to prove the edit kept the board
valid).

## Edit safely

1. Work on a copy or make sure the person has one; Obsidian must not have the
   board open, or its next save overwrites the edit.
2. Parse and write the whole file as JSON; keep every field you do not
   understand exactly as it is, at every level. Newer plugin versions add
   fields, and other plugins (Advanced Canvas) add their own.
3. New ids look like native Canvas's: 16 lowercase hex digits, unique among
   nodes, edges and `miroCanvas.connectors`.
4. Never write into `miroSource`; never create `miroCanvas.zOrder` (layer order
   is the order of `nodes`); never add a `miroCanvas` key to a board that has
   none unless the change needs one - then start it as
   `{"schemaVersion": 1}` plus what you add.
5. Validate again and report what changed.

## Common changes

- **Text, colour, size, position:** the node's own `text`, `color`, `x`, `y`,
  `width`, `height`. Geometry is whole numbers.
- **Look beyond Canvas** (font, fill, border, shape, rotation):
  `miroCanvas.localOverrides[<node id>]`.
- **Lock:** `localOverrides[<id>].locked = true`; locked items refuse edits in
  the plugin, so do not edit a locked item unless the person asks to unlock it.
- **Layer order:** reorder the card nodes in `nodes` (back first, front last);
  frames (`group` nodes) always stay under cards whatever their position.
  Lines and arrows have no layers.
- **A line between two cards:** a native edge. A line with an end on the empty
  board or on another line: `miroCanvas.connectors[<id>]`.
- **A comment:** `miroCanvas.localComments`; imported comments live in
  `miroSource.comments` and are only hidden (`hiddenImportedComments`), never
  edited.
- **Pages to export:** `miroCanvas.export.pages` (rectangles in board units).
