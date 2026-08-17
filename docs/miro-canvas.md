# miro-canvas

[English] | [Full Russian specification](miro-canvas.ru.md)

`miro-canvas` is a planned offline Obsidian plugin that extends any native
Canvas. On an ordinary board it adds richer editing, comments, locking, themes,
colors, shapes, connector anchors, and a clickable minimap. When a local Canvas
contains `miroSource`, it can also render an imported Miro snapshot more
faithfully without contacting Miro.

This document defines the architecture and implementation order. Miro export,
the canonical REST/Web SDK union, and JSON-to-Canvas conversion remain separate
from the plugin.

## Product boundary

- The plugin works entirely offline after installation.
- It does not contain a Miro API client, OAuth, synchronization, upload,
  telemetry, remote fonts, or background network requests.
- Native Obsidian Canvas is the only required runtime.
- Advanced Canvas is an optional neighbor, not a dependency.
- The same `.canvas` file remains valid and useful without `miro-canvas`.
- Standard Canvas and Obsidian behavior remains available: Markdown, wikilinks,
  normal links, embeds, drag and drop, hotkeys, undo/redo, and context menus.
- Missing source data is shown as a diagnostic, never invented.
- Opening a board is read-only; metadata changes only after an explicit user
  action and participates in undo/redo.

The plugin will initially live under `plugins/miro-canvas/` in this repository.
It should move to a separate repository only when its API and release boundary
are stable enough for independent publication.

## Architecture decision

Build the plugin from scratch around native Canvas instead of forking Obsidian
or Advanced Canvas and instead of writing a second Canvas engine.

```text
Obsidian Canvas view
  -> thin CanvasAdapter for private runtime details
  -> framework-free feature modules
  -> optional AdvancedCanvasAdapter
  -> versioned miroCanvas metadata
```

The core should use TypeScript and the Obsidian API with esbuild. No UI framework
or runtime dependency is justified for the first implementation. Private Canvas
internals must be isolated in one adapter so an Obsidian update has one repair
point.

Compatibility modes:

| Mode | Required result |
|---|---|
| Native Canvas only | Standard fields remain readable and editable |
| Native Canvas + `miro-canvas` | All core plugin features work |
| Native Canvas + Advanced Canvas | Existing Advanced Canvas metadata remains valid |
| Both plugins | No duplicate controls or conflicting patches; `miro-canvas` remains usable if optional integration disables itself |

## First working version

| Area | Required behavior |
|---|---|
| Typography | Choose font family and numeric size; format and align text through UI without editing HTML |
| Comments | Display, create, edit, reply, resolve, and anchor comments to a node, edge, image point, or free coordinate |
| Zoom | A large zoom range, fast fit actions, and preserved wheel, trackpad, pinch, and pan behavior |
| Minimap | Entire board in a corner, exact current viewport rectangle, click-to-jump and drag-to-pan without changing zoom |
| Theme | Instant `system` / `light` / `dark` switching from command, control, and hotkey |
| Colors | Expanded palette, recent colors, and a simple picker for text, fill, border, and edges |
| Nodes and shapes | Create and edit additional node types and all supported Miro shape subtypes |
| Documents | Clean preview, page and fit controls, predictable open-original action |
| Locking | Per-element lock and a board-wide review mode that prevents accidental edits |
| Connectors | Multiple end caps and anchors on node edges, node interiors, images, other connectors, and free coordinates |
| Attachment labels | Global default plus per-file and per-document visibility toggle |
| Offline operation | Comments, settings, overrides, anchors, and required assets stay in the vault |

Freehand drawing remains a future item because Excalidraw already covers the
workflow. It should be added only after the editing and compatibility core is
stable.

## Data contract

The immutable imported snapshot remains under `miroSource`. The plugin indexes
it once and must never shorten or rewrite it.

Local behavior that JSON Canvas cannot express lives under a versioned root
field named `miroCanvas`:

```json
{
  "miroCanvas": {
    "schemaVersion": 1,
    "transform": {
      "scale": 1.0,
      "offsetX": 0.0,
      "offsetY": 0.0
    },
    "bindings": {
      "generated-canvas-id": {
        "sourceId": "miro-item-id",
        "role": "item"
      }
    },
    "zOrder": ["miro-item-id"],
    "decks": [],
    "localOverrides": {
      "node-id": {
        "typography": {
          "fontFamily": "Inter",
          "fontSize": 18
        },
        "locked": false,
        "showAttachmentName": true
      }
    },
    "localComments": [],
    "freeAnchors": {}
  }
}
```

Rules:

- Use standard JSON Canvas fields whenever they already express the content.
- Use namespaced metadata only for fonts, locks, comments, free anchors,
  attachment-label preferences, source bindings, z-order, and renderer details.
- Bind by stable Canvas/source ID. Store explicit bindings only for synthetic or
  non-matching IDs.
- Store imported Miro comments separately from local editable comments.
- Preserve local overrides, comments, and anchors across repeat imports by
  source ID.
- Migrate metadata versions in memory and write only after explicit user action.
- Typography controls must not inject inline HTML styles into text content.

## Rendering requirements

### Geometry and layers

- Preserve converter `x`, `y`, `width`, and `height` without hidden auto-layout.
- Apply source rotation around the item center to content, hitboxes, handles,
  and connector boundaries.
- Preserve source order or `zIndex`, including overlap between frames, text,
  shapes, images, and connectors.
- Support negative coordinates, nested transforms, and very large boards.
- Avoid layout shifts after fonts, images, or previews load.

### Camera and minimap

- Match or exceed the current `canvas-zoom-unlock` minimum of `2^-12`.
- Keep native wheel, trackpad, pinch, pan, and fit-to-content behavior.
- Restore saved local camera state; use a Miro viewport only when the source
  actually contains one.
- Build the minimap from board bounds and viewport transforms already available
  in the adapter; do not create a second layout model.
- Update the viewport rectangle while panning, zooming, resizing, and switching
  panes without causing file writes.
- Minimap click moves the viewport center; minimap drag pans continuously while
  preserving zoom.
- Provide show/hide and corner settings and a keyboard-accessible navigation
  alternative.

### Typography, themes, and colors

- Keep Markdown and wikilinks editable as text.
- Expose font family, numeric size, weight, style, decoration, alignment, line
  height, and vertical alignment without raw HTML editing.
- Use local/system fonts and explicit fallback maps; never fetch remote fonts.
- Keep board appearance independent from the Obsidian application theme when
  the user selects an explicit board theme.
- Include theme-aware defaults, recent colors, hex input, and an accessible
  palette for text, fill, borders, edges, and comments.

### Shapes, notes, and groups

- Render known Miro subtypes rather than collapsing all shapes into a few
  silhouettes.
- Keep a generic safe fallback for unknown future subtypes while retaining the
  original subtype in metadata.
- Support shape creation, resizing, rotation, text editing, fill, border,
  opacity, duplication, and connector anchors.
- Add a dedicated sticky-note experience without replacing Markdown storage.
- Distinguish groups, frames, diagrams, and slides where source semantics exist.

### Connectors

- Preserve start/end caps, width, dash, color, labels, orientation, and known
  control points.
- Support border, interior, perimeter, image-point, connector, and free-coordinate
  anchors.
- Keep free anchors stable when unrelated items move.
- Move node-bound anchors with their node and image-bound anchors with image
  crop/resize transforms.
- Prevent self-links and dangling references, and include connector edits in
  undo/redo.

### Files and documents

- Preserve native open, reveal, rename, drag/drop, and link behavior.
- Let users hide attachment names globally or per node without renaming files.
- Display PDFs and local HTML documents with practical fit/page controls.
- Keep image crop, rotation, and title visibility in namespaced metadata.
- Never execute active content from an imported local HTML document inside the
  privileged plugin context.

### Locking and review mode

- Locked items cannot move, resize, rotate, edit text, reconnect, delete, or
  accept drag/drop changes.
- Review mode blocks board edits while keeping navigation, selection, links,
  search, comments, and copy available.
- Lock state is visible but visually quiet and can be changed from command,
  context menu, and inspector.

### Comments

- Keep imported Miro comments immutable and marked with provenance.
- Store local threads, replies, resolution state, timestamps, and anchors in the
  vault.
- Anchor to nodes, edges, image points, or free coordinates.
- Offer board-wide and selection-filtered comment views.
- Do not claim that local comments synchronize with Miro.

## Source-limited data

Some Miro families remain incomplete because neither REST nor Web SDK exposes
their internals. The plugin can improve rendering only when data exists.

- Table cell text remains blocked until another source exposes it.
- Unsupported widget internals and hidden children remain diagnostic.
- Comment content comes from REST, not Web SDK.
- Exact slide and document internals may be partial.

The [display-gap report](MIRO_VS_CANVAS_DISPLAY_GAPS.md) records the measured
baseline and the [capability matrix](MIRO_CAPABILITIES.md) records source
evidence.

## Implementation order

### M0: adapter and persistence

- Create the minimal plugin scaffold under `plugins/miro-canvas/`.
- Isolate private Canvas access in `CanvasAdapter`.
- Read and validate `miroCanvas.schemaVersion` without writing on open.
- Add atomic metadata writes integrated with undo/redo.
- Prove native-only and Advanced-Canvas coexistence with one fixture each.

### M1: navigation and safety

- Integrate the zoom-unlock behavior.
- Add the clickable minimap and viewport rectangle.
- Add element locking and board review mode.
- Verify large-board performance and keyboard accessibility.

### M2: editing fundamentals

- Add typography controls without inline HTML.
- Add theme switching and the expanded color picker.
- Add attachment-name visibility settings.
- Add local comments and anchors.

### M3: geometry fidelity

- Add rotation and z-order.
- Add the shape registry and shape editing.
- Add rich connector rendering, caps, control points, and free anchors.

### M4: structured content

- Add frame, slide, document, image, preview, card, tag, code, and mind-map
  renderers where source data is available.
- For mind-map editing, evaluate the MIT-licensed
  [`obsidian-enhancing-mindmap`](https://github.com/MarkMindCkm/obsidian-enhancing-mindmap)
  tree model and interactions before writing new layout code. Candidate behavior
  includes child/sibling insertion, drag reparenting, collapse/expand, keyboard
  navigation, and Markdown view switching.
- Treat the current
  [`obsidian-markmind`](https://github.com/MarkMindCkm/obsidian-markmind) only as
  a UX reference: its README says it is not open source, so its implementation
  must not be copied. Keep native Canvas data as the source of truth and record
  any reused MIT code and copyright in third-party notices.
- Add provenance and source-limitation inspection without default board clutter.

### M5: release hardening

- Test network-denied operation.
- Test large boards and migrations.
- Test native Canvas, Advanced Canvas, and both plugins together.
- Add real-Obsidian visual baselines and accessibility checks.
- Extract the plugin to its own repository only if the stable release boundary
  justifies it.

## Definition of done

The first production release is ready when:

1. ordinary Canvas boards gain the promised editing features without
   `miroSource`;
2. imported boards keep all canonical source and provenance data;
3. files remain valid and useful without the plugin;
4. the plugin works offline with network access denied;
5. native Canvas and optional Advanced Canvas modes pass the same compatibility
   fixtures;
6. minimap, comments, typography, locking, colors, themes, attachment labels,
   and connector anchors are keyboard-accessible and covered by tests;
7. opening a board never changes it silently;
8. source-limited data is identified honestly rather than fabricated.
