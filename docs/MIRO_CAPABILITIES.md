# Miro source capability matrix

Last verified: 2026-07-27.

This file is the project reference for deciding whether a missing Canvas node is a converter bug, a known intentional drop, or source data that Miro does not expose through the current export path.

Use it before creating a converter issue:

- If Miro exposes content and geometry, a missing/incorrect Canvas result is a converter problem.
- If Miro exposes only geometry or position for a known source-limited family, drop the item from Canvas and classify it in the missing-item audit. Preserve a placeholder only for unknown future families while they are still actionable.
- If Miro exposes neither content nor geometry, do not create a conversion bug. Record it as a source/API limitation unless a new export path can recover it.
- If Web SDK or an installed Miro app can recover more than REST, create an infrastructure/export task first, then a converter problem only after a new fixture exists.

## Source layers

The project should distinguish these layers:

| Layer | What it means | Current use |
|---|---|---|
| REST board-items API | `GET /v2/boards/{board_id}/items` output used by `Miro_2_Json` | Main source for local JSON exports |
| REST comments sidecar | checked comments endpoints including `v2-experimental/boards/{board_id}/comments` | Production REST pipeline writes root `comments[]` alongside `items[]` |
| REST attachment download | image/document/doc_format resources saved into `_files` and validated by default; embed previews are best-effort only | Required for file nodes that represent native attachments |
| Web SDK maximum board export | complete `maximum_board_v1` capture from `miro.board.get()` on the open board | Complementary production source through strict canonical union; also used for probes |
| Enterprise APIs | Admin/organization APIs requiring Enterprise access and scopes | Future investigation only |
| Observed Miro JSON | Item types already seen in local samples even when docs are ambiguous | Drives fixtures and audits |
| Converter output | Current `Json_2_Canvas/Converter.py` behavior | Ground truth for regressions |

## Current converter matrix

| Miro type | Miro availability | Programmatic create | Current Canvas output | Notes |
|---|---|---|---|---|
| `text` | REST read; Web SDK read/write | REST `POST /texts`; Web SDK `createText` | `type:text` | HTML content is preserved, with layout fixes for missing source height. |
| `shape` | REST read; Web SDK read/write | REST `POST /shapes`; Web SDK `createShape` | `type:text` with shape style | Shape subtype is mapped to closest Obsidian Canvas shape. |
| `sticky_note` | REST read; Web SDK read/write | REST `POST /sticky_notes`; Web SDK `createStickyNote` | `type:text` | Miro does not always provide useful font size, so converter estimates text fit. |
| `image` | REST read; Web SDK read/write | REST `POST /images`; Web SDK `createImage` | `type:file` | Requires downloaded local image in `_files/` for full rendering. Missing local image assets intentionally remain file nodes so Obsidian preserves the image slot and geometry. |
| `document` | REST enum includes it; Web SDK docs list document as unsupported | REST `POST /documents` | `type:file` when local asset exists; otherwise `type:link` | Converter supports observed REST JSON when a local document/PDF exists. Keep samples. |
| `doc_format` | REST enum includes it; observed in exports | Not treated as programmatic fixture target yet | `type:file` PDF/HTML when local asset exists; otherwise `type:link` or drop | REST exporter now downloads and validates doc_format assets by default. |
| `card` | REST read; Web SDK read/write | REST `POST /cards`; Web SDK `createCard` | `type:text` | Empty cards are intentional drops. |
| `app_card` | REST read; Web SDK read/write | REST `POST /app_cards`; Web SDK `createAppCard` | `type:text` | `fields[]` are rendered into text. Empty app cards are intentional drops. |
| `preview` | Web SDK-only in docs, but REST enum includes it | Web SDK `createPreview` | `type:text` if useful metadata exists; otherwise drop | Empty previews are intentional drops. |
| `embed` | REST/Web SDK read | REST `POST /embeds`; Web SDK `createEmbed` | `type:file` if preview image exists; otherwise `type:link` or diagnostic text | URL can be recovered from Embedly HTML when `data.url` is empty. Local preview thumbnails are optional enrichment, not required export assets. |
| `frame` | REST read; Web SDK read/write | REST `POST /frames`; Web SDK `createFrame` | `type:group` | Parent-relative coordinates are resolved before Canvas output. |
| `diagram` | Observed container type | Unknown | `type:group` | Treat as observed source, not official API promise. |
| `group` | Web SDK supports groups | Web SDK `createGroup` | Usually structural only | Child items carry the actual content. |
| `connector` | REST read; Web SDK read/write | REST `POST /connectors`; Web SDK `createConnector` | `type:edge` | Loose/dangling connectors cannot be created programmatically by API and are intentionally dropped when endpoints are missing. |
| `tag` | REST/Web SDK support tags, but current REST exports expose tag definitions without board geometry | REST `POST /tags`; Web SDK `createTag` | Dropped unless a future source provides position and geometry | Current board exports expose tag metadata, not placeable Canvas nodes. |
| `comment` | Separate `v2-experimental/boards/{board_id}/comments` sidecar source | Not a board item create target | `type:text` annotation | Public v2 item export rejects `comment`; production REST export writes root `comments[]`, and converter consumes that sidecar list. |
| `mindmap_node` | Web SDK experimental; observed in REST export after Web SDK generation | Web SDK `experimental.createMindmapNode` | `type:text` plus parent-child Canvas edges | Content is read from `data.nodeView.data.content`; parent-relative child coordinates are resolved before output. |
| `board` | Metadata only | REST `POST /boards` creates boards | Dropped | `board_metadata` in missing-item audit. |
| `board_member` | Metadata only | N/A | Dropped | Not Canvas content. |
| `table` | Observed legacy/unsupported item with geometry only | Not supported | Dropped | Current REST/Web SDK diagnostics do not expose cell payloads. A placeholder would imply recoverable table content and can overlap real items. |
| `table_text` | Observed legacy/unsupported table cell item with geometry but no cell text | Not supported | Dropped when empty | Empty cells are `table_source_limited` in missing-item audit to avoid placeholder clutter near `(0, 0)`. Current REST/Web SDK diagnostics do not expose cell payloads. |
| `data_table_format` | REST enum includes it; local sample shows no placeable geometry/content | Not supported | Dropped | `table_source_limited` in missing-item audit. |
| `slide_container` | Observed in local source artifact with child `frame` items linked by `parent.id` | UI/manual source; programmatic creation still needs separate probe | `type:group` deck containing slide frame groups | Fixtures `slide_container_deck_membership`, `slide_connector_across_deck_frames`, and `slide_large_screen_grid_layout` guard deck ownership, per-deck sequence links, visible connectors between slide-frame children, synthetic layout, and supported child fitting. Current REST exports do not expose exact thumbnail positions inside the Miro deck widget, so large screen decks use a Miro-like reconstructed overview. `scripts/miro_slide_probe.py` remains the read-only source probe for new boards/export surfaces. |
| `code` | Fresh REST export exposes `data.code`, `language`, `lineNumbersVisible`, and `title` | Observed UI/manual source | `type:text` with preformatted code | Fixture `code_block_preserves_content` preserves title, language, line-number visibility, and code text. |
| `dynamic_poll` | Fresh REST export exposes geometry only, no poll data | UI/manual source | Dropped | Poll content/options are source-unavailable through the current REST item export. |
| `prototyping_screen` | Fresh REST export exposes geometry and title only | UI/manual source | Dropped | Exact screen content is source-unavailable through the current REST item export. |
| Unknown type with geometry | Depends on export source | Unknown | Diagnostic placeholder | This keeps visible evidence that content could not be mapped. |
| Unknown type with position but without geometry | Observed for unsupported Miro families | Unknown | Diagnostic placeholder for unknown types; dropped for known source-limited families | `flip_card`, `people`, and `widgets_stack` are classified as known source-limited drops. |
| Unknown type without geometry or position | Source does not provide a placeable item | Unknown | Dropped | Missing audit should classify it as non-actionable unless content is recoverable elsewhere. |

## Unsupported and limited items

Miro docs say the Web SDK and REST APIs do not yet support all board items. For the official Web SDK unsupported category, Miro currently exposes geometry through the Web SDK but not full programmatic content creation/update.

Treat the official unsupported families and the project-specific limited families below as source limitations unless an app-export fixture proves otherwise:

| Item family | Source classification | Current status for this project |
|---|---|
| Document | Official Web SDK unsupported, but REST enum and local exports can expose documents | Converter supports observed REST JSON when a local document/PDF exists. |
| Emoji | Official Web SDK unsupported | Source content unavailable through current REST export. |
| Kanban | Official Web SDK unsupported | Source content unavailable through current REST export. |
| Mockup | Official Web SDK unsupported | Source content unavailable through current REST export. |
| Stroke | Official Web SDK unsupported | Source content unavailable or not represented as placeable Canvas content by current REST export. |
| Table / table text | Official Web SDK unsupported | Current REST/Web SDK exports are not enough for exact table content. Fixture `table_source_limited` drops table, empty `table_text`, and geometry-less `data_table_format` items and records them as source-limited. `scripts/miro_table_probe.py` checks list/detail/table endpoints and can seed detail probes from a full export with `--evidence-json`. Source evidence is recorded in `tests/fixtures/table_source_limited/source_evidence_2026-06-11.json`. |
| USM | Official Web SDK unsupported | Source content unavailable through current REST export. |
| Mind map (`mindmap`) | Legacy/unsupported family in observed exports | Keep as source-limited unless a fixture proves recoverable content. |
| Mind map node (`mindmap_node`) | Web SDK experimental; observed in REST export after Web SDK generation | Converter fixture `mindmap_node_tree` preserves text content and hierarchy edges. |
| Position-only unsupported widgets (`flip_card`, `people`, `widgets_stack`) | Observed REST export can expose center position but no geometry/content | Converter fixture `unsupported_position_only_placeholder` drops these known source-limited items from Canvas and classifies them in the missing-item audit. Exact visual fidelity needs a richer export source. |
| Code block | Supported REST content | Fresh REST evidence exposes `data.code`, language, line-number visibility, and title. Converter fixture `code_block_preserves_content` preserves it as preformatted Canvas text. |
| Wireframe / webscreen | Project limitation / needs source verification | Source content unavailable through current REST export. |
| SVG / grid | Project limitation / observed or legacy export family | Source content unavailable or not represented as placeable Canvas content by current REST export. |
| Comments | Separate source family; public v2 board items reject `comment`, but `v2-experimental/boards/{board_id}/comments` was observed as available | Converter fixture `comment_sidecar` preserves non-empty comment payloads as Canvas annotations. |

## Programmatic fixture generation

For future generated Miro boards, prefer REST when the board can be created offline from a script:

- Create a board with `POST /v2/boards`.
- Create text, shapes, sticky notes, cards, app cards, frames, connectors, embeds, images, documents, and tags with their dedicated REST endpoints.
- For external resources, use absolute publicly available URLs. Miro board items do not accept local relative asset URLs.
- For connector fixtures, always attach both ends to item IDs. Miro APIs do not create loose or dangling connectors.
- Let the generator continue after item-level API failures and record them in `failures`; partial success is useful source evidence.

Use Web SDK when the fixture needs features that REST cannot create or inspect cleanly:

- All board item create families exposed by `miro.board`: `createAppCard`, `createCard`, `createConnector`, `createEmbed`, `createFrame`, `createImage`, `createPreview`, `createShape`, `createStickyNote`, `createTag`, and `createText`.
- `miro.board.group` for structural group coverage.
- Experimental `miro.board.experimental.createMindmapNode`.
- Experimental/unsupported geometry inspection.
- Exporting exactly what the board UI sees while the board is open.

`scripts/miro_rest_generate_probe_board.py` is the maximum generated REST fixture. It creates every REST board item family the project treats as creatable, plus important variants such as shape subtypes, sticky note colors/shapes, tag colors, connector shapes/caps, URL images, embeds, documents, frame children, and card variants. API rejections are preserved in the output JSON instead of stopping the run by default. Use `--strict-failures` only when automation should fail on any item-level rejection.

`tools/miro_websdk_exporter` exposes `Create probe items` as the maximum generated Web SDK fixture. It creates every supported board item family above, plus important variants such as shape subtypes, sticky note colors/shapes, connector shapes/caps, card/app-card fields, URL and data-URL images, inline/modal embeds, previews, frame children, groups, and experimental mind map nodes.

Generated boards are still not the same as full Miro UI coverage. They intentionally cannot create every UI feature. Keep these as separate/manual source tasks:

- `slide_container` / decks: use `scripts/miro_slide_probe.py` on a dedicated test board. The minimized slide fixtures cover deck membership, per-deck sequence links, visible source connectors, child grouping, and reconstructed large-screen layouts.
- `comment`: comments are not normal board items; production REST export fetches the comments sidecar and writes root `comments[]` next to `items[]`.
- Official unsupported families such as `kanban`, `mockup`, `stroke`, `emoji`, and `usm`: place them manually on a fixture board and inspect/export through Web SDK before creating converter rules.

Observed table probes with visible cell text exposed table and cell geometry but no text-like cell payloads. Experimental table endpoints returned insufficient permissions, so table text remains a source-limited input rather than a converter bug.

Deep Web SDK table diagnostics on 2026-06-11 confirmed the same limitation. Exporter profile `20260611-deep-table` returned prototype chain `Unsupported -> Unsupported -> BaseItem -> Object`; safe reads of known text and table fields had no values, and `textish_values` was empty. The minimized evidence is stored in `tests/fixtures/table_source_limited/source_evidence_2026-06-11.json`.

## Capability probe command

Before adding a new converter rule for a Miro item family, compare available export surfaces:

```powershell
python scripts\miro_capability_probe.py --rest-json path\to\rest.json
python scripts\miro_capability_probe.py --rest-json path\to\rest.json --websdk-json path\to\websdk.json
python scripts\miro_capability_probe.py --rest-json path\to\rest.json --websdk-json path\to\websdk.json --format json --output capability_report.json
```

The report marks:

- `websdk_export_candidate` when a type appears in Web SDK export but not REST.
- `converter_candidate` when REST exposes placeable/contentful items that the converter still drops.
- `source_limited`, `needs_probe`, or `separate_source` when the missing content should not become a converter bug yet.

To prepare a generated REST probe board without touching Miro:

```powershell
python scripts\miro_rest_generate_probe_board.py --output rest_probe_manifest.json
```

To execute the manifest later, use your own Miro Developer App. Either set a
`MIRO_ACCESS_TOKEN` generated by that app or run with `--oauth` and local
`MIRO_CLIENT_ID` / `MIRO_CLIENT_SECRET`. The script creates a board unless
`--board-id` points at an existing board:

```powershell
python scripts\miro_rest_generate_probe_board.py --execute --output rest_probe_result.json
python scripts\miro_rest_generate_probe_board.py --execute --board-id <board_id> --output rest_probe_result.json
```

With `--oauth`, the local callback defaults to `http://localhost:8765/callback` and the helper opens the system browser. Use `--oauth-browser yandex` or an executable path for an explicit browser. Register the exact redirect URI in the Miro app; `localhost` and `127.0.0.1` are different values for Miro OAuth.

## Maximum Web SDK and canonical union

Host the buildless app on the port reserved for its static content:

```powershell
python tools\miro_websdk_exporter\serve_no_cache.py --port 8766
```

Register `http://localhost:8766/index.html` as the Miro
App URL. Use `Export board`; selection and generated-probe payloads do not claim
complete board capture and are rejected by the production merge.

The normal maximum pipeline is:

```powershell
python scripts\miro_pipeline.py `
  --board-id <board_id> `
  --websdk-json path\to\websdk-board.json `
  --source-json path\to\canonical-board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

The merge requires the same board id, complete source contracts, supported
schema/exporter/profile, and fresh timestamps. REST is authoritative for
non-empty shared fields; Web SDK fills empty values and contributes Web SDK-only
ids. Original objects from both surfaces are retained in item provenance. The
pipeline downloads required assets introduced by the merged items before an
atomic bundle publication.

The standalone merge CLI remains useful when a strict REST JSON and all needed
asset files already exist:

```powershell
python scripts\merge_miro_sources.py `
  --board-id <board_id> `
  --rest-json path\to\rest.json `
  --websdk-json path\to\websdk-board.json `
  --output path\to\merged.miro.json
```

`complete` means complete for the declared public API surface. Web SDK still
cannot expose full unsupported-item details, hidden children of unsupported
parents, or comment content. REST comments and required assets therefore remain
mandatory in the canonical union; geometry-only evidence is not presented as
recovered widget content.

The source-expansion workflow remains available for reports and fixture work:

```powershell
python scripts\miro_source_expansion_workflow.py plan --output-dir work\source_expansion
python scripts\miro_source_expansion_workflow.py analyze --rest-json path\to\rest.json --websdk-json path\to\websdk-board.json --output-dir work\source_expansion
```
## Missing-item audit policy

When `scripts/audit_missing_miro_items.py` reports a missing Miro id:

- `board_metadata`, `empty_card_like_item`, `connector_without_endpoints`, and `unsupported_without_geometry` are non-actionable unless this matrix says the source should contain recoverable content.
- `unsupported_position_only` is actionable: the source exposes a board position, so the converter should preserve a diagnostic placeholder unless a type-specific rule says to drop it.
- `embed_without_resolvable_url` is actionable when HTML or preview metadata exists.
- `unclassified_missing_item` is always actionable and should become a minimized fixture and tracked issue.
- New item types must be added here before being marked intentional in the audit.

## Official sources

- Miro board items overview: https://developers.miro.com/docs/board-items
- REST get items endpoint: https://developers.miro.com/reference/get-items
- REST create board endpoint: https://developers.miro.com/reference/create-board
- REST create text item: https://developers.miro.com/reference/create-text-item
- REST create shape item: https://developers.miro.com/reference/create-shape-item
- REST create sticky note item: https://developers.miro.com/reference/create-sticky-note-item
- REST create card item: https://developers.miro.com/reference/create-card-item
- REST create app card item: https://developers.miro.com/reference/create-app-card-item
- REST create frame endpoint: https://developers.miro.com/reference/create-frame-item
- REST create connector endpoint: https://developers.miro.com/reference/create-connector
- Web SDK board reference: https://developers.miro.com/docs/websdk-reference-board
- Web SDK mindmap node reference: https://developers.miro.com/docs/websdk-reference-mindmap-node
- Web SDK unsupported items: https://developers.miro.com/docs/websdk-reference-unsupported
- Web SDK vs REST API: https://developers.miro.com/docs/miro-web-sdk-vs-rest-apis
- SDK authorization with REST OAuth: https://developers.miro.com/docs/enable_api_authentication_from_sdk_authorization
- Enterprise API access: https://developers.miro.com/docs/getting-started-with-enterprise-api
