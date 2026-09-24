# The miro-canvas board format, field by field

The authoritative contract is `miro2obsidian/schemas/v1/`. This page says
what each part means and which rules the plugin relies on when it reads what
you write. Unknown fields are allowed everywhere and must be kept.

## Root

| Key | What it is |
|---|---|
| `nodes`, `edges` | JSON Canvas 1.0. Native Canvas owns them. |
| `miroSource` | The imported Miro board. Read only. |
| `miroCanvas` | The plugin's metadata, `schemaVersion: 1`. |
| `metadata` | Native Canvas's own file metadata; leave it. |
| anything else | Another tool's data; keep it byte for byte. |

## `nodes` and `edges` (native)

- Node: `id`, `type` (`text` \| `file` \| `link` \| `group`), `x`, `y`,
  `width`, `height` (whole numbers - native Canvas rounds them when it saves),
  `text` / `file` / `url` by type, optional `color` (`"1"`-`"6"` or `#rrggbb`),
  group `label`.
- A `group` is a frame. Native Canvas draws every frame under every card,
  larger under smaller, whatever its place in `nodes`.
- **Layer order of cards is their order in `nodes`**, back first. The plugin's
  layer commands only reorder the card slots; frames keep theirs.
- Edge: `id`, `fromNode`, `toNode`, optional `fromSide`/`toSide`
  (`top` \| `right` \| `bottom` \| `left`), `fromEnd`/`toEnd` (`none` \|
  `arrow`; native Canvas leaves out the defaults `fromEnd: none`,
  `toEnd: arrow`), `color`, `label`. An edge joins two nodes; nothing else.

## `miroSource` (read only)

The converter copies the canonical export root here: `schema_version`,
`board`, `items` (each with `id` and `type`), `comments`, optional
`connectors` and `zOrder`, plus `provenance` and `completeness`, which say what
the export could and could not capture. A node shows the source item with its
own id, or the one `miroCanvas.bindings[<node id>].sourceId` names. Never edit,
shorten or re-serialize this part; report missing data from `completeness`
instead of inventing it.

## `miroCanvas`

| Key | Meaning |
|---|---|
| `schemaVersion` | `1`. Any other number: the plugin treats the metadata as unsupported and changes nothing. |
| `settings` | Board-level choices: `displayTheme` (`system`/`light`/`dark`), `reviewMode`, `showAttachmentNames`, `minimapVisible`, `palette`, `recentColors`. |
| `transform` | The converter's `scale`, `offsetX`, `offsetY` from Miro to board units. |
| `bindings` | Node id → `{ "sourceId", "role" }`, only where the node id differs from the source item id. |
| `zOrder` | Source order kept for imported boards. Kept in step when present; **never create it** - card order is `nodes`. No id twice. |
| `decks` | Presentations: `{ id, sourceId, startNode, syntheticLayout, slides: [{ id, sourceId, nodeId }] }`. |
| `localOverrides` | Node or edge id → the plugin's own look of it (below). |
| `localComments` | Comments written in Obsidian (below). |
| `freeAnchors` | Named points independent of any item. |
| `export` | Pages to export (below). |
| `commentPlaces` | `"<origin>:<comment id>"` → where its pin was moved (an anchor). |
| `commentAuthorNames` | Thread id → message id → display name. |
| `commentDecorations` | `"<origin>:<comment id>"` → `{ color: "#rrggbb", locked }`. |
| `hiddenImportedComments` | Imported comment ids not shown on the board. |
| `connectors` | Independent lines and arrows, by id (below). |
| `connectorMigrationArchive` | Opaque record of an old migration. Do not touch. |

### `localOverrides[<id>]`

| Key | Meaning |
|---|---|
| `typography` | `fontFamily`, `fontSize`, `format` (`bold`/`italic`/`underline`/`strike` booleans), `alignment` / `textAlign` (`left`/`center`/`right`/`justify`), `verticalAlign` (`top`/`center`/`bottom`), `lineHeight`. |
| `colors` | `text`, `fill`, `border`, `edge`, `highlight`: `#rrggbb`, or `null` for transparent; absent means Obsidian's own colour. |
| `locked` | `true`: the plugin refuses to move, resize, rotate, retype, restyle, reconnect or delete it. |
| `showAttachmentName` | Per-attachment override of the board setting. |
| `rotation` | Degrees, clockwise, around the node's centre. |
| `item` | What the creation tools made the node: `type` `text` \| `sticky_note` (with a sticky `color` token such as `light_yellow`) \| `code` (with `title`) \| `frame` \| `table` \| `drawing` (with `stroke`: `color`, `width`, `box`, `points`) \| `line` (with `line`: route, colour, width, box, points). Without the plugin it is a plain card or group. |
| `shape` | `{ kind, fallback }`: the Miro shape the card is drawn as (rectangle, ellipse, a flowchart shape, ...). |
| `borderStyle`, `borderWidth` | `solid`/`dashed`/`dotted`/`none`, and a width in board units. |
| `connector` | For a native edge: `route` (`straight`/`elbowed`/`curved`), `strokeStyle`, `startCap`, `endCap`, `width`, `headSize`, `labelT` (0-1 along the line), `color`, `waypoints`. |
| `connectorAnchors` | For a native edge: `{ from, to }` anchors where its ends really hold. |

### Anchors

- `{ "type": "free", "x", "y" }` - a point on the board.
- `{ "type": "node", "nodeId", "u", "v" }` - a point on a card's box, `u`/`v`
  from 0 to 1 (also `"image"` for a point on a picture).
- `{ "type": "edge", "edgeId", "t" }` - a point along a line, `t` 0-1.
- `{ "type": "comment", "commentId", "origin" }` - a comment pin (`local` or
  `imported`).

### `connectors[<id>]`

An independent line: `id` (same as its key), `from`, `to` (anchors), `route`,
`color` (`#rrggbb`), `width`, optional `headSize`, `label`, `labelT`,
`startCap`, `endCap` (`none`, `arrow`, `stealth`, `triangle`, ...),
`strokeStyle`, `block: true` for a block arrow, `waypoints` (`{x, y}`, at most
64). When both ends are on cards the plugin keeps the line as a native edge
instead; either form keeps the id.

### `localComments[]`

`{ id, text, author: { name, ... }, createdAt, updatedAt, anchor, resolved,
replies: [{ id, text, author, createdAt }] }`. Imported comments are in
`miroSource.comments` and are never edited; hide one with
`hiddenImportedComments`.

### `export`

`{ format: "a4" | "a3" | "letter" | "16:9" | "4:3" | "free",
orientation: "landscape" | "portrait", quality: "standard" | "high",
pages: [{ id, x, y, width, height, name }] }` - rectangles in board units, at
most 200. A page of a paper format has that paper's proportions. Pages are
never nodes.
