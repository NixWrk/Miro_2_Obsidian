# miro-canvas

[English] | [Full Russian specification](miro-canvas.ru.md)

`miro-canvas` is an offline Obsidian plugin under active development that
extends native Canvas. On an ordinary board it is intended to add richer
editing, comments, locking, themes, colors, shapes, connector anchors, and a
clickable minimap. A future implementation is intended to render an imported
Miro snapshot more faithfully when a local Canvas contains `miroSource`, without
contacting Miro.

This document defines the architecture and implementation order. Miro export,
the canonical REST/Web SDK union, and JSON-to-Canvas conversion remain separate
from the plugin.

## Current implementation status

The repository-level M0 foundation is implemented under
`plugins/miro-canvas/`. It includes the plugin shell, versioned `miroCanvas`
schema validation and in-memory migrations, read-only native/Advanced Canvas
adapters, an explicit metadata writer with a guarded atomic compare-and-swap
(CAS) bridge, and a deterministic four-profile compatibility matrix with a
project-local test vault harness.

Native Canvas rebuilds its document from its own model whenever it saves and
keeps only the root keys it owns, so `miroCanvas` and `miroSource` would be
erased by any ordinary native edit. The session installs one instance-scoped
hook on `getData` that carries across every root key still present in the live
document but missing from the rebuild — another plugin's data included, because
dropping it would be as destructive as dropping this plugin's own. `nodes` and
`edges` are always the host's to rebuild, a value the host produced itself is
never overwritten, and the hook is removed on dispose.

A document the host produced is read in its JSON form: values that JSON
serialization drops, such as an absent optional field left as `undefined`, are
normalized instead of treated as a corrupt document. Anything this plugin
installs as the new root still goes through the strict plain-JSON clone.
Because a host cannot be required to return the exact bytes it was given, an
accepted commit is verified on what the plugin owns: its own root keys must
survive byte-for-byte and the node and edge id sets must be unchanged. A commit
the host altered beyond that is refused and rolled back, and a rejected commit
now names the precondition it failed on.

M0 is not production-ready yet. The real-Obsidian gate remains open: native
Ctrl+Z/redo behavior for metadata actions and real visual/interaction
verification have not been claimed.

The current development checkpoint includes M1 navigation controls, a clickable
minimap, typography, board themes, colors, locks/review mode, and attachment
title visibility. Native zoom is safely limited to 6.25%–200%; unrestricted zoom
is not implemented. The Chromium DOM smoke covers the M1 controls against a
synthetic native host, not the real Obsidian runtime.

A contextual formatting toolbar floats above the current selection whenever the
native DOM can be measured, and disappears as soon as the selection is cleared.
Following Miro, it is one compact row of icon buttons: shape, font family, font
size with a stepper, bold, alignment, one button per color slot, a lock toggle
and an overflow menu. Long lists never sit in the row itself. The shape button
opens the common kinds with **More shapes** revealing every supported Miro kind;
the overflow menu carries the remaining text formats, line height, border style
and width, and the full connector settings (route, line style, both end caps,
width). Controls that do not apply to the selection are removed from the row
rather than shown disabled, and only one popover is open at a time.

Typography and colors continue through the appearance pipeline; shape, border
and connector settings go through the guarded authoring transaction. Review mode
and locked elements leave the toolbar visible but inert with an explicit reason,
except the lock toggle, which stays live so an accidental lock can be undone.
The side panel keeps the same typography and color groups for now; that
duplication is removed once the toolbar is verified in the real Obsidian
runtime.

Zoom, fit and the minimap toggle sit in the navigation dock at the bottom of
the Canvas, beside the map they navigate, and the dock keeps carrying zoom while
the map itself is hidden. Panning, zoom, the minimap, review mode and locking
are registered commands, so Obsidian's own hotkey editor can bind them; the
plugin ships no default bindings and takes no keys from another plugin. A
settings tab configures the zoom step and range, whether zoom follows the
pointer, the wheel modifier, keyboard pan distance and its Shift multiplier, and
which surfaces are shown. A stored settings file is normalized on load: unknown
keys are dropped and out-of-range numbers are clamped, so a bad preference can
never stop a board from opening.

Selecting one element adds the handles native Canvas does not provide: a
rotation grip below the selection and three connection handles on each side.
A handle becomes an outward arrow on hover: clicking it adds a connected node,
while dragging it projects both endpoints onto the actual shape silhouettes at
the pointer direction instead of fixing them to side centers. Rotation previews in place
and writes once on release, so a drag produces one native history entry rather than dozens, and
Shift snaps it to 15 degrees. A connection released over another node becomes a
native edge; the quick-create arrow places a node beside the selection and
connects it. Every one of these goes through the guarded authoring transaction,
so review mode, a locked target and a stale document refuse them the same way a
menu action would.

M2 tools are available through **Local shapes, comments, anchors and documents**
in the command palette. Create the supported Miro shape set with editable native
text fallbacks. Every local comment receives a stable Canvas anchor and marker;
opening the marker focuses its thread, whose messages show author and creation
time. Edit, reply to, resolve, reopen, and delete local threads; imported
comments remain read-only. A pin can be dragged onto another item or a free
board point without rewriting imported Miro evidence. Local comments use the
name selected in settings, falling back to the signed-in Obsidian account name,
and author pin/avatar colors can be overridden per name.
Choose a target and relative coordinates for node/image anchors, T for edges,
or board X/Y for free anchors, then save an anchor or set a connector endpoint.
Node/image connections update native endpoints; free/edge connections retain
valid native endpoints as an approximate plugin-off fallback with a diagnostic.
Graph edits reject readonly/review/locked targets, preserve `miroSource` and
unknown metadata, and record one native history transaction. Precise connector
anchors are stored beside a nearest-side native fallback, so the file remains
useful when the plugin is disabled.

Select a local file before opening tools for native document controls. PDF page
navigation uses the entered page; fit depends on the detected native viewer and
unsupported fit APIs produce a diagnostic. Markdown subpaths are preserved.
Active imported HTML never executes inside the plugin. Automated unit and
Chromium integration checks cover the M2 UI and synthetic native history;
real Obsidian interaction and hotkeys remain a separate, unconfirmed gate.
M3 projects canonical `miroSource.items`/`connectors` through explicit bindings.
Source and local rotation is applied around native node centers, including
anchor geometry; z-order uses explicit metadata or source ranks. The renderer
adds reversible, inert decoration to existing native DOM for shapes, text,
sticky notes, connectors, frames, and media. It never replaces editable native
content or executes source HTML/URLs. Native node and edge layers can be
separate stacking contexts, so unsupported cross-layer interleaving and missing
source fields remain explicit diagnostics.
The first M4 slice recognizes proven Miro code payloads, projects only bounded
title/language/line-number/code fields, and adds reversible code-card styling
around the existing editable Canvas text. Raw HTML, URLs, and unknown source
fields stay inert in `miroSource`.
The next slice recognizes proven `app_card` field collections and card themes.
It adds reversible card chrome and bounded state only; the converter's native
editable text remains the visible title, description, and field content.
Preview metadata now renders as an inert overlay above the native clickable
link, and ordinary cards resolve bounded tag IDs to definition-backed chips.
Tag definitions stay non-visual source evidence.
Proven `mindmap_node` payloads retain converter-created native text and
hierarchy edges. The renderer distinguishes roots and branches, applies safe
source colors and shapes, and marks generated hierarchy edges separately from
Miro connectors. Legacy `mindmap` remains explicitly source-limited.
The Commands menu and command palette now open a read-only source/provenance
inspector. It shows bounded source-type, completeness, provenance, diagnostic,
selection, and unknown-field summaries. Raw source values remain only in the
Canvas file and no inspector content is added to the board.

To run the plugin checks from the repository root:

```powershell
cd plugins\miro-canvas
npm ci
npm run typecheck
npm test
npm run build
```

To build and deploy the local runtime into the guarded M0 test vault:

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

The setup script creates `_obsidian_oracle_vault`, stages all four committed
fixtures below its `MIRO2OBSIDIAN\_oracle\m0-compatibility` folder, and copies
only the built `manifest.json`, `main.js`, and `styles.css` into
`.obsidian\plugins\miro-canvas`. The target is guarded: arbitrary vault paths
and link/reparse-point paths are refused. Advanced Canvas receives a placeholder
manifest unless its real runtime is copied or installed separately; therefore a
successful offline matrix check is not a real-Obsidian visual pass.

Setup additionally stages `m1-daily.canvas` with a local attachment, a locked
item, typography overrides, and a distant minimap target. Repeating setup keeps
existing daily-board edits. `python -m tools.obsidian_oracle.smoke_plugin_ui`
checks the actual plugin UI against Chromium DOM and a synthetic Canvas host;
it is a browser integration check, not a real-Obsidian compatibility pass. Add
`--browser edge` to use the installed Microsoft Edge when Playwright Chromium
is unavailable.

### M0 profile activation and checks

Each activation stages the selected Canvas fixture and atomically updates the
controlled entries in `.obsidian\community-plugins.json`. The exact four
profile pairs, run from the repository root, are:

```powershell
python tools\obsidian_oracle\activate_profile.py native-only
python tools\obsidian_oracle\check_environment.py --profile native-only

python tools\obsidian_oracle\activate_profile.py miro-canvas-only
python tools\obsidian_oracle\check_environment.py --profile miro-canvas-only

python tools\obsidian_oracle\activate_profile.py advanced-only
python tools\obsidian_oracle\check_environment.py --profile advanced-only

python tools\obsidian_oracle\activate_profile.py both
python tools\obsidian_oracle\check_environment.py --profile both
```

The four rows mean native Canvas alone, native Canvas plus `miro-canvas`, native
Canvas plus Advanced Canvas, and both optional plugins. The profile checker
validates enabled-plugin state, fixture metadata, and the committed matrix. It
reports missing plugin binaries as warnings unless `--strict-runtime` is
given. For a real Advanced Canvas run, first install a pinned, hash-verified
runtime with `python -m tools.obsidian_oracle.install_plugin_runtime
advanced-canvas` or copy one from an existing vault; then rerun the relevant
profile with `--strict-runtime`.

The scripts only prepare files. They do not register or open the project-local
vault in a user's Obsidian window. Before a real-app check, open
`_obsidian_oracle_vault` once through Obsidian's vault switcher (or otherwise
add that folder as a vault), then open the staged Canvas from the
`MIRO2OBSIDIAN\_oracle\m0-compatibility` folder. No real UI pass is implied
until that manual gate is completed.

If opening reports **vault not found**, use **Open another vault → Open folder
as vault** and select the exact absolute path printed by setup. The `open`
URI cannot register a new vault. `python -m tools.obsidian_oracle.open_local_vault`
checks the app registry without changing it and prints the correct path and
instructions. After registration, run it with `--profile both --open`.
`check_environment --require-registered` makes missing/unknown registration an
explicit failure instead of mistaking runtime files on disk for an openable vault.

### M0 explicit metadata actions

The plugin registers these command-palette commands only for the active native
Canvas when its known persistence boundary is compatible:

| Command | Effect |
|---|---|
| `Miro Canvas: Initialize board metadata` | Explicitly creates schema-v1 `miroCanvas` metadata; it is a no-op when the default is already present. |
| Native Canvas `Ctrl/Cmd+Z` | Uses Obsidian's native undo history after an explicit metadata transaction. |
| Native Canvas `Ctrl/Cmd+Y` (or the platform redo action) | Uses Obsidian's native redo history after an explicit metadata transaction. |
| `Miro Canvas: Show plugin status` | Reports adapter, metadata, persistence, and optional Advanced Canvas state. |

Opening or inspecting a board does not write a file. Every metadata mutation is
an explicit writer call (the internal `MetadataWriter.write(action, mutate)`
API): it clones a JSON-safe document, validates the proposed schema, preserves
`miroSource`, and sends one complete-document transaction to the host. The
native bridge records that transaction through `requestSave(true)`, so native
Ctrl/Cmd+Z and Ctrl/Cmd+Y are the intended undo/redo path; the plugin does not
maintain a competing user-facing history stack. The explicit public command in
M0 is `Initialize board metadata`; later feature controls will use the same
writer boundary. Native hotkey behavior is still part of the real-app gate.

### M0 atomic CAS bridge and fail-closed behavior

`src/obsidian-metadata-store.ts` is the only native root-data bridge. It accepts
the currently known shape (`Canvas.data` as a writable data property and a
synchronous `requestSave(true)` native history/save boundary), returns detached
snapshots,
and exposes `commitDocument(next, expected)` to `MetadataWriter`. It does not
guess `getData`, `setData`, `importData`, vault writes, or a text-view
serialization path for persistence.

The bridge compares the live root to `expected`, replaces it with a detached
clone, calls `requestSave(true)`, verifies the resulting root, and restores the
previous root when the host rejects, throws, returns an async thenable, or
produces a different document. The writer additionally rejects malformed or
unsupported existing metadata, invalid proposed metadata, cyclic/non-JSON
documents, stale CAS/history snapshots, and any change to immutable
`miroSource`. The bridge does not intentionally accept or record failed
transactions; failure behavior inside the private Obsidian runtime remains part
of the real-application gate.

This proves atomic in-memory root replacement and native undo snapshot creation;
Obsidian still schedules its normal debounced file save, so a durable disk flush
is not synchronously proven and this is not a filesystem transaction.

If the private runtime shape is missing, read-only, accessor-backed, malformed,
or otherwise incompatible, the bridge reports `unavailable`/`incompatible`
and does not expose a writable store. The plugin remains loaded and native
Canvas remains usable; only metadata persistence commands are disabled and a
diagnostic status is shown. This fail-closed behavior is covered by offline
unit tests, not yet by a real Obsidian session.

## Product boundary

- The plugin works entirely offline after installation.
- It does not contain a Miro API client, OAuth, synchronization, upload,
  telemetry, remote fonts, or background network requests.
- Native Obsidian Canvas is the only required runtime.
- Advanced Canvas is an optional neighbor, not a dependency.
- The same `.canvas` file remains valid and useful without `miro-canvas`.
- Standard Canvas and Obsidian behavior remains available: Markdown, wikilinks,
  normal links, embeds, drag and drop, hotkeys, undo/redo, and context menus.
- M0 metadata writes are explicit actions and are committed through the native
  Canvas history boundary; native Ctrl/Cmd+Z and Ctrl/Cmd+Y replay remains to be
  verified in the real application.
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
  -> explicit root-metadata CAS bridge
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
- Treat a free line and a node-bound connector as two states of one editable
  line model: attaching or detaching an endpoint must convert between them
  without changing the route, caps, color, width, or labels.
- Let one line endpoint join another line endpoint without forcing either
  segment to adopt the other's style; joining records topology, not a style
  merge.

### Selection and creation tools

- Make lasso a configurable selection gesture as well as an optional toolbar
  button. Mouse buttons and modifiers used for select, pan, lasso, line, and
  connector gestures must be configurable without taking global hotkeys.
- Let users show or hide the lasso, line, and connector buttons independently
  while keeping every action available through commands and assignable hotkeys.

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

Repository-level M0 status: the scaffold, schema boundary, read-only adapters,
explicit CAS writer, and four offline compatibility fixtures are implemented
and covered by automated tests.

- [x] Create the minimal plugin scaffold under `plugins/miro-canvas/`.
- [x] Isolate native and optional Advanced Canvas access behind adapters.
- [x] Read and validate `miroCanvas.schemaVersion` without writing on open.
- [x] Add explicit whole-document CAS metadata writes with detached snapshots,
  rollback, and the native Canvas history boundary for undo/redo.
- [x] Stage native-only, `miro-canvas`-only, Advanced-only, and both-plugin
  offline fixtures with guarded activation/check scripts.
- [ ] Open the project vault in real Obsidian and verify visual/interaction
  behavior, including native Ctrl+Z/Ctrl+Y replay and the final screenshots.

### M1: daily Canvas tools

- Integrate the zoom-unlock behavior.
- Add the clickable minimap and viewport rectangle.
- Add element locking and board review mode.
- Add typography controls, themes, expanded colors, and attachment-name toggles.
- Verify large-board performance and keyboard accessibility.

### M2: editing fundamentals

- Add local comments and anchors.
- Add local shape creation with standard Canvas fallbacks.
- Add safe local document viewing and open-original controls.

### M3: geometry fidelity

- [x] Add local/source rotation, rotated anchors, and z-order with native history.
- [x] Add reversible source-backed Miro shape, text, sticky, connector, frame,
  and media decoration over native Canvas elements.
- [x] Use explicit diagnostics whenever source payload or native stacking
  contexts cannot support exact rendering.

### M4: structured content

- [x] Add a source-backed code renderer without replacing editable Canvas text
  or executing source payloads.
- [x] Add bounded source-backed `app_card` state and reversible card styling
  without copying field payloads into plugin DOM.
- [x] Add bounded preview metadata over native links without executing source
  URLs or HTML.
- [x] Add ordinary card state and resolve source tag definitions to inert chips.
- [x] Add source-backed `mindmap_node` root/branch styling and distinguish its
  generated hierarchy edges from Miro connectors; report legacy `mindmap` as
  source-limited.
- Add slide, document, and image renderers where source data is available.
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
- [x] Add bounded provenance and source-limitation inspection without default
  board clutter or raw source values in DOM.

### Future: product tasks (set 2026-09-23)

The agreed order of this work - finish PDF/PPTX export; foundations (schema,
translations, agent skill); the converter as a product of its own; delivery and
the Miro import guide; onboarding board and visual guide; testing with people;
ecosystem - is recorded in the [ROADMAP](../ROADMAP.md) plan. The exporter stays
in Python and is offered as a per-OS build or set up by an agent through a
miro2obsidian skill or MCP server; the plugin never installs it by itself.

- Choose the settings and interface language automatically from Obsidian's own
  language, falling back to English; ship English and Russian first.
- Offer an optional onboarding board on first setup (and from settings) that
  shows every tool on real items.
- Write a visual guide to the plugin's features and the order of its settings,
  with screenshots, for users and for the release page.
- Finish PDF/PPTX export (draft on branch `wip/board-export`): slides as a
  deck and marked board areas as pages.
- Move the plugin into its own repository tied to miro2obsidian by a shared
  schema and fixtures; offer a guided, illustrated Miro import from first setup
  and from settings, offering the exporter for download or an agent to set it
  up, and letting the user remove it afterwards; walk the full user journey on a
  clean machine (see [ROADMAP](../ROADMAP.md)).
- Provide a skill or an MCP server so agents can work with miro-canvas boards as
  natively as with Canvas files.
- Tune settings and layouts for other operating systems, phones and tablets
  (see M5 below).

### Future: ecosystem migration

- Add explicit, non-destructive import adapters for common local plugin formats,
  beginning with Excalidraw drawings and mind-map plugins. Convert recoverable
  structure into native Canvas plus versioned `miroCanvas` metadata while
  preserving the original file and recording provenance and unsupported fields.
- Keep adapters format-specific and optional; never make another plugin a
  runtime dependency or silently rewrite its files.

### M5: release hardening

- Test network-denied operation.
- Test large boards and migrations.
- Test native Canvas, Advanced Canvas, and both plugins together.
- Add real-Obsidian visual baselines and accessibility checks.
- Run a documented platform/display matrix on Windows, macOS, and Linux (or
  representative virtual machines), multiple viewport sizes and device-pixel
  ratios, and Obsidian desktop and mobile/touch where available.
- Exercise mouse, trackpad, pen tablet/stylus, touch-screen, and phone/tablet
  drawing and selection gestures, including palm rejection and window-focus
  changes for rotated text rendering.
- Extract the plugin to its own repository only if the stable release boundary
  justifies it.

## Definition of done

### Connector development checkpoint

New lines and arrows use independent `miroCanvas.connectors` records, not hidden
Canvas nodes. A connector has two anchors (free point, node/image, or a position
along another connector), a route and independent style; arrowheads do not change
its identity. Native/imported edges remain supported through the shared anchor
geometry. Attaching connectors does not merge their styles.

The Lines and arrows tool now stays active until another tool is selected. Its
bottom row keeps route, color and thickness controls open. Select a connector to
drag it or its endpoint handles, change its line/arrow style, copy, cut or delete.
Copy, cut and paste use the clipboard events Obsidian raises itself (see the
2026-09-23 clipboard notes below). File nodes continue to share the original file.
Escape on the board resets tools and selection. `Miro Canvas: Reset tools and
selection` has no default hotkey, so Escape in a card, a label or a field stays
theirs; the command can be bound in Obsidian Settings → Hotkeys.

Run `Miro Canvas: Convert legacy line nodes to connectors` explicitly to migrate
old line cards. The transaction is undoable, idempotent, preserves source data,
and archives the exact former node/override in `connectorMigrationArchive`.
Straight legacy lines now bake their rotation into board coordinates. Rotated
curves/elbows and line cards targeted by native or independent connectors are
retained and reported rather than destructively approximated. Opening a board
does not migrate it.

Limitations: independent connectors need this plugin to display; native Obsidian
does not support free endpoints without node containers. The Canvas file stays
valid and its other nodes/native edges remain usable without the plugin.
Shift-click and lasso support mixed node/connector selections. Copy, paste, cut,
selection deletion and group dragging use one native history step; external
connector anchors are detached on copy while internal anchors are remapped.
Rectangle selection includes independent connectors by the endpoints inside
the box. A line merely crossing the box with both ends outside is not selected.
On a group drag, only caught ends move; the far ends remain fixed.
Every multi-item selection, whether made by rectangle or lasso, keeps one
draggable frame after a move; its entire interior can start another group drag.
Selection deletion checks locks across the dependent-connector closure before
removing anything. A refused save or stale group-drag preview leaves the graph
unchanged. Real-Obsidian mouse
QA is still open because Windows screenshot capture fails with
`SetIsBorderRequired / 0x80004002`; accessibility clicks also lack geometry.
The connector tool uses one persistent bottom panel, without a second floating
route picker. Attached routes and selection frames follow live drag geometry on
animation frames; group-drag previews now project native and source-backed
edges from the same pending positions as independent connectors. Choosing a
comment color saves once on selection instead of on every picker movement.
The focused test disables periodic refresh to verify live geometry.
The focused browser gate covers keyboard clipboard, connector persistence,
undo/redo, copying, displayed-camera following and reset. Both focused and full
browser UI smoke tests pass against the synthetic host; neither replaces real
Obsidian interaction QA.

### Follow-up audit (2026-09-22)

The installed test-vault build reports `ready/valid/ready/ready`. Automated gates
pass: 646 plugin tests, all three browser smoke suites, TypeScript, Ruff, 501 Python
tests with 157 subtests, and structural/visual regression (seven fixtures have
no visual baseline). Real mouse QA remains blocked by the capture/input errors
above; no real-app smoothness claim is made.

Connector selections now use the same icon toolbar as native edges (caps, route,
width, color, lock and delete), not a separate text menu. The bottom connector
row matches drawing controls with swatches, width preview, slider and numeric
entry; arrows are grouped before plain lines. Comment pins capture the first
press and retain their drag through refresh/focus changes.
Run `python -m tools.obsidian_oracle.smoke_plugin_ui --controls` for the focused
menu/marquee/first-press drag gate; `--screenshots <directory>` saves its preview.

Connector attachment settings now default to **nodes only**. Enable unattached
ends and attachment to other lines/arrows separately under Connectors. Disabling
a target type does not rewrite existing connections; it restricts newly placed
or moved endpoints. Invalid new connections are not saved.
The creation panel shows all seven types in one row (arrows left, lines right),
with palette and width controls. Drawing and connectors share a 600px control-row
width, constrained on narrow screens. Changing tools closes the previous popover;
opening shapes leaves the connector tool. Independent endpoints use only their own SVG handles;
dragging one with the connector tool armed must not create a new connector.
The focused browser gate also checks right-button lasso against a competing native
mousedown pan handler, node-only defaults, compact panel width and deletion
button visibility when the native menu is empty. Real Obsidian mouse QA remains
unverified: renewed capture attempts still fail with `0x80004002`.

#### Critical review follow-up

Block arrows now honor the width control and reverse their head correctly.
Block creation starts at width 16, independently of ordinary lines (width 2);
each width is remembered while switching types within the session. The preview
uses the same width as the saved connector. Group drag snapshots use the same
JSON normalization as native transactions, so optional `undefined` Canvas fields
do not cause a false stale-document rejection. A real pointer browser scenario
checks two selected connectors, refresh during dragging, one save, undo and redo.
Removing the head or choosing a non-block-compatible route/cap converts the
appearance to a regular connector while preserving anchors. Legacy implicit
block heads are interpreted without an automatic document migration.
Single-connector drags reject a newer edit to the same connector; dropping on a
disabled attachment target cancels the move instead of retaining the last hover
target. Text-field clipboard events are not consumed by the connector layer.
The settings descriptions explicitly explain Escape and the all-targets-off case.

Remaining review findings, not release claims:

The next development patch restores bend handles on independent straight,
curved and elbowed connectors. Dragging an attached connector's body adjusts its
route without detaching its ends; free connectors still move as a whole.
Clipboard copies now include their selection center, so paste centers the group
at the last canvas pointer location (or the viewport center if none is known).
Clicking with a drag-based line/arrow tool no longer creates a default-length
connector. Explicit multipoint line tools retain their point-placement gesture.
Drawing now has a custom color picker as well as the preset palette, matching
connectors. Hidden comment-card controls stay hidden, preventing the local-delete
and imported-hide buttons from appearing together.

The comment card now edits an author's displayed name before posting and after
posting, deletes individual local replies, and sets a thread's color and lock.
Locking visibly marks the pin and card and prevents replies, author edits,
color changes, resolving, and deletion for that thread in both the card and
comments panel. Unlocking restores those controls; it does not prevent adding
separate comments elsewhere on the board.
The default name still comes from the plugin setting; imported author changes
are local display aliases, not edits to Miro metadata. Connectors can anchor to
comment markers and resolve their endpoints as comments move. A connector's
arrowhead size is adjustable independently of stroke width. The mixed lasso
frame encloses selected native items, independent connectors, and comment pins;
dragging its interior moves the whole selection in one transaction. These behaviors have
focused unit and synthetic-browser coverage, not live Obsidian acceptance.
The left-button rectangular gesture draws one lightweight plugin marquee.
On release it selects native nodes and edges, independent connectors and comment
pins together; pointer movement only updates that one box, without rebuilding
the board or asking native Canvas to draw a competing marquee.
Selection uses the painted screen centers of nodes and comment pins, and the
visible endpoint positions of native and independent connectors. A group/frame
must be fully enclosed so a small rectangle inside a large frame does not take
it. A single caught connector end has a small draggable selection frame; its
other end does not move. When both ends and the full route are inside, route
bends move too.
Native-only selections keep Obsidian's visible frame; the plugin's full-area
drag target is transparent. Mixed selections with independent connectors use
the plugin's visible frame because the native one cannot enclose them; comments
use the same rule. An unrotated single node keeps native border plus plugin
grips, without a second outline. The neighboring-node arrow buttons stay in
the transparent handles overlay anchored to that native border. While dragging
a marquee, shared-frame geometry is not recomputed.
Sticky fill offers Miro's 17 named colors in an eight-column grid, followed
by up to 12 recently used colors and a separate custom-color input. Recent
colors may repeat a preset; these are distinct sources, not additional Miro
sticky colors.
Only attached endpoints follow a node's rotation; free ends and bends retain
their board positions. The lasso-to-shared-frame drag is covered by the
synthetic browser gate.
Comment colors preview during picker input and persist once on selection, even
if the card refreshes before the picker closes. During a pin drag, attached connector paths follow the pin
without saving intermediate positions; cancelling restores the original route.
The drawing and connector creation bars share a 600 px, single-row layout;
on narrower screens they scroll horizontally rather than wrapping.
Independent connectors can receive a label through the **Add or edit line label**
button in the selection toolbar, Enter, or a double-click on the line. Drag the
label along the route; its initial
position defaults to the midpoint and is configurable in plugin settings.
When a native edge has a plugin-defined route, the plugin positions its label
on that visible route instead of leaving Obsidian's original label at the old
midpoint. The label follows the body during its first route drag and during
group movement. Double-click to edit or drag that label along the route. A pure pan
translates the existing independent-connector SVG instead of rebuilding it.

- Native-edge-only clipboard payloads without their endpoint nodes are not yet
  supported by the unified paste path. Independent connectors are supported.
- Formatting a mixed native/independent selection still uses separate style
  transactions; it is not yet guaranteed to be one undo step like group movement.
- Large boards are measured below; no guarantee is made beyond them.
- Live Obsidian mouse/clipboard, other OSes, touch/stylus and high-DPI rotated
  text remain separate acceptance gates, not covered by the synthetic browser.

#### Standard edges, one label editor, large boards (2026-09-23)

A line or arrow whose both ends hold on to cards (node or image anchors on two
different cards) is now a native Canvas edge, as one drawn between cards in
Obsidian is: it opens and stays usable without the plugin. Its route, caps,
dashes, width, colour and exact anchors live in `localOverrides`. A line with
a free end, an end on another line or on a comment stays a
`miroCanvas.connectors` record. Moving an end converts between the two under
the same id and keeps the look and the label; each conversion is one undo step.
An imported edge stays the native edge its Miro connector is bound to: a moved
end is held by the plugin's anchor, as before. Drawing with the Lines and
arrows tool from card to card creates the native edge directly.

The board's own connectors are drawn in native Canvas's moving layer, beside its
edges and under the cards, with native Canvas's edge classes: hover, selection
halo, end grips, bend grips and the toolbar are the ones native edges use, and
pan or zoom costs them nothing. Only a connector whose route, style or selection
changed is redrawn.

Labels of native edges and of the board's own connectors are the same element:
native Canvas's label style, placed on the route the plugin draws, in board
units. Click selects the line; drag slides the label along the route; a
double-click, Enter or the toolbar button edits it in place (Enter keeps,
Shift+Enter breaks the line, Escape cancels). Native Canvas's own hidden editor
is no longer opened by its Enter or double-click.

Undo fix: writing plugin metadata during a graph transaction replaced the
document native Canvas also keeps as its latest history entry, so Undo could
bring back new metadata with the old graph (for example a native edge reappearing
beside its converted connector). The document is now replaced by a copy.

Large boards: on a synthetic board with 2,000 cards, 980 native edges (labelled
every fifth) and 520 own connectors, one plugin refresh dropped from about 130 ms
to about 4 ms and the plugin's work per panned frame from about 10 ms to about
2 ms. A card dragged there used to move at about 7 frames a second; the plugin's
work per dragged frame is now about 35 ms. The board is read
again only when native Canvas saves (or while a press is held), metadata is parsed
once per metadata object, native elements are guarded once, the minimap content
is projected once per scene, routes that hold on only to unmoved cards are kept
mid-drag, and the overlay frame loop runs only during gestures and settling
animations. These are main-thread measurements in the isolated harness, not a
frame-rate guarantee.

All three synthetic browser suites pass (default, `--interactions`,
`--controls`). The synthetic host now has native Canvas's moving layer and
live card positions; the default suite had been failing at the local tools
rotation step because a press on that panel cleared the selection.

Clipboard (2026-09-23): Ctrl+C, Ctrl+X and Ctrl+V are no longer intercepted.
They reach the board as the clipboard events Obsidian raises for them in any
keyboard layout, as do Cut, Copy and Paste in native Canvas's selection menu
and in the plugin's menu for the board's own connectors. A copy writes
`obsidian/canvas` (the graph, which native Canvas pastes by itself on any
board, with the board's own connectors beside it), `obsidian/miro-canvas` (the
plugin's record of every item) and `text/plain` (card texts, files as
`[[links]]`, pages as addresses), so a paste into a note or another program is
readable text rather than JSON. A paste of a graph lands centred under the
pointer as one undo step; files, images, text and links are native Canvas's to
paste. The plugin's replacement context menu is gone: native Canvas's menus
stay. Shortcuts are recognised by the key pressed (Ctrl+С in a Russian layout is
Ctrl+C, and the tool letters work in any layout), and a key with nothing selected
is no longer refused as a text edit, which had disabled the tool letters and
paste with an empty selection.

| Requested feature | Evidence / remaining boundary |
| --- | --- |
| Comments: drag/delete, author name and color | Marker, thread, local-comment and settings tests pass. Imported comments are hidden locally, not erased from source. |
| Rotation magnets and 90-degree buttons | Selection-handles tests cover 45-degree snapping; toolbar keeps quarter turns. |
| Configurable lasso/pan/line gestures and button visibility | Settings and pointer-binding tests pass; mixed lasso is covered by browser interactions. Bindings use the supported presets. |
| Text marker, quiet frame colors, minimap type colors | Text-highlight, selection-toolbar and minimap-model tests pass; full browser gate passes. |
| Native app validation | Load status observed after reload. Drag smoothness and real OS clipboard still need user verification. |

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
