# Miro versus Obsidian Canvas display gaps

[English] | [Russian](MIRO_VS_CANVAS_DISPLAY_GAPS.ru.md)

This report records measured results from the `TEST_BOARD` production run on
2026-08-16, not general assumptions. The source was built as a strict REST and
Web SDK union:

- canonical JSON: 479 items and 1 comment;
- Web SDK: 477 items;
- required assets: 78 images, 1 document, and 2 `doc_format` files;
- Canvas: 445 nodes and 30 edges;
- missing files, duplicate IDs, and broken edges: 0.

Both `completeness.complete` and `capture_complete` are `true`.
`board_complete` deliberately remains `false`: Miro's public APIs do not promise
access to hidden internal data for unsupported widgets. This is a source
limitation, not a pipeline failure.

## Measured TEST_BOARD conversion

| Miro | Count | Canvas | Result |
|---|---:|---|---|
| `shape` | 233 | 233 text nodes | Text, color, and the supported base shape are retained through Advanced Canvas attributes |
| `sticky_note` | 29 | 29 text nodes | Content and primary colors are retained |
| `text` | 75 | 75 text nodes | Rich text is stored as HTML inside Canvas text nodes |
| `image` | 78 | 73 file nodes | Five internal document slots are hidden because their parent `doc_format` renders them |
| `document` + `doc_format` | 3 | 3 file nodes | Local files are retained and validated |
| `frame` + `group` + `diagram` + `slide_container` | 10 | 10 group nodes | Geometry, labels, and membership are retained within the Canvas model |
| `connector` | 29 | 29 edges | Endpoints and two labels are retained; one invisible slide-order edge is added |
| `preview` | 1 | 1 link node | The target URL becomes a native Canvas link card |
| `table` + `table_text` | 19 | 19 text nodes | The APIs did not expose cell content, so diagnostics and links are retained |
| REST comment | 1 | 1 text node | Text and metadata are visible, but this is not an interactive Miro thread |
| `board` + `board_member` | 2 | 0 visible nodes | Service records remain in `miroSource` but are not drawn |
| completeness diagnostic | 0 source items | 1 text node | Known public-API limitations are made explicit |

## Remaining differences

The priorities below consider both visibility and whether the gap can be fixed
with the data currently available.

| Priority | Area | Miro | Current Canvas | Root cause | Correct layer |
|---|---|---|---|---|---|
| P0 | Tables | Full grid and cell content | Technical placeholders for 3 tables and 16 cells | REST and Web SDK did not return the content | A new data source is required before a renderer can help |
| P0 | Shapes | 45 observed subtypes | 8 Advanced Canvas shapes | The target shape model is smaller | Custom shape renderer or Advanced Canvas extension |
| P0 | Rotation | 3 rotated items | No output rotation field | JSON Canvas has no portable rotation model | Plugin renderer plus namespaced metadata |
| P0 | Connectors | Exact paths, bends, caps, width, dash, and orientation | Nodes are connected and two labels survive, but the exact route is not guaranteed | Canvas edges retain less geometry | Edge renderer plus preserved Miro control points |
| P1 | Text | Exact fonts, metrics, wrapping, and vertical alignment | HTML content survives, but Obsidian recalculates lines and sizes | Different renderer and font set | Typography layer and font fallback map |
| P1 | Color and borders | Independent fill/border opacity, width, and style | Only the supported subset is visible | Advanced Canvas attribute limits | Extended style metadata and renderer |
| P1 | Frames | Frame chrome, background, title placement, and order | Five frames become group nodes | Canvas groups are semantically simpler | Extended group renderer |
| P1 | Slides | Deck order and presentation UI | `startNode` and an invisible sequence edge | Canvas has no Miro presentation mode | Slide navigator and presentation layer |
| P1 | Sticky notes | Native layout, autosize, padding, and effects | Colored text nodes | No dedicated sticky node type | Specialized note renderer |
| P1 | Documents | Editable Miro doc with inline slots | Local PDF/HTML file preview | Canvas displays a file, not the Miro document model | Document viewer; editing needs a local model |
| P1 | Comments | Threads, anchors, replies, reactions, and state | Separate text node | Canvas has no comment thread API | Comment panel and anchor metadata |
| P2 | Images | Crop, mask, exact rotation, and image chrome | Local file nodes | Obsidian owns file preview rendering | Image renderer with crop metadata and optional title chrome |
| P2 | Link previews | Miro preview card | Native Obsidian link card | Rendering depends on network and Obsidian metadata cache | Cached title/thumbnail or custom card |
| P2 | Z-order | Explicit Miro layer order | No explicit output `zIndex` | Canvas uses node order and internal rules | Preserve Miro order in metadata and apply it in a plugin |
| P2 | Viewport | Miro start viewport and zoom | Board is centered and fitted to `1.133212` | The products use different camera models | Preserve and restore viewport metadata |

## Shape collapse on TEST_BOARD

The board contained 45 Miro shape subtypes, while the target renderer currently
uses only:

- `round-rectangle`;
- `pill`;
- `circle`;
- `diamond`;
- `parallelogram`;
- `predefined-process`;
- `database`;
- `document`.

As a result, stars, clouds, crosses, pentagons, hexagons, octagons, callouts,
braces, and several flowchart symbols are approximate. Their text and position
survive, but their silhouette does not match Miro.

## Fixes confirmed by this run

1. Correctly serialized `undefined` and non-finite markers no longer make a
   complete Web SDK payload appear incomplete.
2. A string-valued `data.shape` no longer breaks conversion.
3. Repeated production runs safely replace changed attachments and restore the
   previous directory if conversion fails.
4. Internal `doc_format` image slots no longer reappear as technical text nodes.
5. A `preview` with a target URL becomes a native link card instead of a large
   URL string.

## Recommended plugin backlog

1. Add namespaced `miroSubtype`, `miroRotation`, `miroZIndex`, and connector-path
   metadata without changing standard Canvas fields.
2. Render all observed Miro shapes and rotation.
3. Render connector caps, dash, width, and control points.
4. Add frame and slide presentation layers.
5. Add typography controls for font family, vertical alignment, and wrapping.
6. Add a comments panel and a hideable provenance/diagnostic inspector.
7. Investigate a separate table-data source. A table renderer cannot recover
   content that no source exposes.

## Future plugin verification

Each category needs one minimized fixture and one screenshot from real Obsidian.
Acceptance criteria:

1. the same number of user-visible elements;
2. matching bounding boxes within a documented tolerance;
3. matching subtype, rotation, fill, border, and text metrics;
4. matching connector endpoints and paths;
5. no technical placeholder where recoverable data can be rendered;
6. an explicit diagnostic where Miro did not expose the data.

The architectural rule is unchanged: canonical JSON stays as complete as
possible and is never reduced to fit Canvas. Display loss belongs in the
converter or plugin layer, while original REST/Web SDK objects and provenance
remain intact.
