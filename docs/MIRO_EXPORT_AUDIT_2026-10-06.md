# Independent Miro export coverage audit — 2026-10-06

## Verdict and scope

**The inspected implementation does not substantiate “maximum all public API
data.”** It provides a useful, strict REST collection export, a complementary
Web SDK capture, downloaded assets, and a provenance-preserving canonical union.
However, documented read surfaces are not all queried, and capture validation is
not proof of field or endpoint exhaustiveness. Keep the existing
`board_complete: false` distinction.

This is an independent, read-only implementation/documentation audit dated
**2026-10-06**. It compares the supplied working tree at
`J:/NIX/WRK/Code/Miro_2_Obsidian` with official `developers.miro.com` documentation
retrieved that day. HEAD when sampled was
`6278ae4638a99932bae92e8a34dd5a010c34a819`; the checkout already contained active
UI/documentation changes and continued to change during the audit. Line numbers
below identify the sampled code, not a frozen release. Only this new report was
edited by the auditor. No live Miro API calls, user credential inspection,
implementation changes, commits, or pushes were performed.

This is a bounded initial audit, not an exhaustive census of every Miro
endpoint or widget. Uncertain content families remain `needs_probe`; a
production promise should not depend on treating unknown support as absent.

A separate independent subagent, **Leibniz**, verified experimental mindmap,
comment/table evidence boundaries, unsupported SDK families and Enterprise
export documentation without editing files. Its source-linked findings were
checked and integrated below. This report is intended for the parent editor to
refine user-facing coverage; it does not change the existing capability matrix.

The audit distinguishes:

- **Documented read support** from create/update support and historical samples.
- **Collected JSON** from the smaller set rendered as Canvas nodes/edges.
- **Exporter omissions** from documented API restrictions and unresolved access.
- **An unqueried endpoint** from a proven additional field: two endpoints may
  return equivalent data. A missing call alone does not prove content loss.

Confidence labels: **H** = official reference plus direct code evidence;
**H/offline** = additionally reproduced with a synthetic, fully mocked response;
**M** = documented surface or local observation, with incremental payload or
runtime eligibility unverified; **U** = unresolved. None signifies live
acceptance with the user's app. Documentation fetch errors are not API errors.

## Most actionable findings

| Priority | Finding | Classification and confidence |
|---|---|---|
| P0 | Qualify “maximum public-API export” and “complete threads” claims until an explicit endpoint/field inventory supports them. | Coverage claim exceeds implemented checks; H. |
| P1 | The common REST collection helper has no offset/total continuation or total reconciliation. Tags use a documented offset interface. A 60-tag synthetic response can produce 50 captured tags with `complete=true`. | Exporter completeness defect for offset-only responses; H/offline. Actual Miro next-link behavior unverified. |
| P1 | Production SDK capture never queries `miro.board.experimental.get`; documented mindmap and richer flowchart-shape reads are absent from that capture path. | Missing read surface; H. Increment over experimental REST depends on the board. |
| P1 | SDK layer indices are not read with `getLayerIndex`. | Documented accessible field not explicitly captured; H. |
| P1 | SDK item metadata and board app data are not read through `getMetadata` / `getAppData`. | Conditional exporter gap for this app's own data; H. Other apps' private metadata is an API boundary. |
| P1 | REST connector detail is not called; compare list/detail before promising complete connector fields. | Confirmed endpoint omission, unproven extra payload; H for omission, M for actual field gain. |
| P1 | REST tag assignments are not explicitly read; definitions are already collected and SDK `tagIds` can preserve assignments. | REST coverage gap / canonical corroboration gap, not blanket loss of tags; H/M. |
| P1 | Complete REST comment-thread, reply-pagination and resolved-thread contracts are not independently established by current official references in this audit. | Claim/proof gap; H for missing explicit code requests, U for required extra REST calls. |
| P2 | Group detail and membership reads and SDK frame/group traversal are absent. Existing REST groups and SDK structural IDs may already suffice. | Missing independent membership reconciliation; H/M. |
| P2 | Stable REST item payloads are not routinely unioned with experimental payloads. The second stable pass is conditional asset recovery. | Coverage/provenance uncertainty, not demonstrated omitted item content; H/M. |
| P2 | Historical table access failures and geometry-only samples should remain scoped to the tested surfaces, app, and date. | Evidence classification needs qualification; H for local evidence, U for other access conditions. |
| P2 / conditional | Enterprise Board Export has documented richer archive contents; the repository does not implement it. Official MCP also documents table rows and filtered comment reads outside the current REST/SDK pipeline. | Separate eligible source options, not default coverage; H documentation, M for integration/eligibility. |

## What the implementation actually collects

### REST, comments, assets

[`get_items_on_board`](../Miro_2_Json/miro_downloader.py), lines 594–892, requests
experimental `/items` by default, then stable `/connectors`, `/tags`, `/frames`,
`/documents`, `/embeds`, `/groups`, `/members`, and the board resource itself.
The collections are **already implemented**, including tags and groups. This
audit does not mistake those for wholly missing endpoints. Fields returned in
their object mappings are retained, with exporter-added `source`, `subtype`,
and occasionally `plain_text` fields.

The helper follows `cursor` or `links.next`, rejects repeated requests and
off-origin links, and records pages/counts. It does not implement offset
continuation or validate a declared total. Its `complete` flag tests skipped
and partial sources, rather than reconciled endpoint totals.

[`export_board_items`](../scripts/miro_rest_export_board.py), lines 61–123,
uses this helper in strict mode: it refuses permission skips, partial results,
and silent experimental-to-stable substitution. `_dedupe_miro_items` in the
downloader, lines 255–319, fills missing fields and retains duplicate endpoint
variants in provenance. Strictness is useful; it does not expand the endpoint
set.

[`export_board_comments`](../scripts/miro_rest_export_board.py), lines 126–175,
uses [`miro_comment_probe.py`](../scripts/miro_comment_probe.py).
`build_comment_probe_requests`, lines 34–71, checks stable `/items?type=comment`,
stable `/comments`, and experimental `/comments`. The code retains entire
returned comment mappings, handles collection pagination using links and
offset/total metadata, and stores the probe evidence under comment provenance.
There is no explicit per-thread detail/reply enumeration or resolved-state
query in that request inventory. Whether those are necessary is a separate
documentation/payload question; do not assert replies are lost if already
embedded in the collection response.

Asset requirements in [`_required_asset_resources`](../scripts/miro_rest_export_board.py),
lines 403–430, cover images, documents, and `doc_format` with HTML. Embed
previews are optional enrichment. Images prefer `format=original`, with a
preview fallback in [`download_all`](../Miro_2_Json/miro_downloader.py), lines
1286–1324. A validated image file can therefore be a preview; success does not
prove original-resolution recovery. `doc_format` becomes a generated PDF or
HTML fallback, rather than an original Miro document binary. The audit did not
find an asset-mode field recording every original/preview choice.

The stable second pass in [`_build_complete_board_source`](../scripts/miro_rest_export_board.py),
lines 861–879, happens only when experimental-source assets are missing. It
preserves stable enrichment evidence and copies local asset names; it is not a
routine stable/experimental field union.

### Web SDK and canonical merge

[`exportBoard`](../tools/miro_websdk_exporter/exporter.js), lines 456–581, calls
`miro.board.get()`, `getSelection()`, and `getInfo()`. `toPlain`, lines 138–225,
recursively serializes own enumerable properties using `Object.keys`, including
diagnostic markers for values JSON cannot directly represent. Serialization
errors make capture incomplete. Table diagnostics inspect additional properties
and prototypes; they do not generalize into a documented-field collector.

The board reference says unfiltered `get()` includes items, groups, and tags.
The documented SDK reads also include `getLayerIndex`, `getAppData`, and
`getMetadata`; these method results are not obtained merely by serializing an
item object. The first two structural sources are already captured; the latter
method results are absent. [Official board reference](https://developers.miro.com/docs/websdk-reference-board).

The normal exporter does **not** call experimental reads, per-item metadata,
layer indices, group `getItems`, or frame `getChildren`. Mindmap *creation* in
the separate generated-probe function, lines 912–948, is not evidence that the
normal whole-board capture reads experimental mindmap payloads.

`Object.keys` coverage also does not prove every documented getter is an own
enumerable property in the deployed SDK. That is a verification gap, not a
claim that every ordinary SDK field is currently missing.

[`merge_sources`](../scripts/merge_miro_sources.py), lines 993–1115, validates
board identity, schema/exporter/profile, counts, serialization, source age,
and timestamp skew. For a shared item ID, REST non-empty values win and SDK
values fill empty fields; SDK-only IDs are added. `field_sources` records
availability and `selected_field_sources` records the selected source. Original
captured objects remain under `source_provenance.original_items`, and root
metadata under `source_metadata`. This is strong evidence retention **for
captured data**, not a proof all public read methods were used.

The SDK's coverage basis is `miro.board.get_api_surface`; the canonical basis is
`rest_plus_web_sdk_union`. Both explicitly keep `board_complete=false`.
`finalize_merged_export`, lines 1118–1198, checks/publishes the bundle before
setting `capture_complete` and `complete`. These checks do not require the
missing read surfaces listed above.

### JSON preservation is broader than Canvas rendering

[`_source_canvas_metadata`](../Json_2_Canvas/Converter.py), lines 1515–1520,
deep-copies the input source. The converter writes it as `miroSource`, lines
6277–6279, alongside generated Canvas nodes/edges. Thus a tag definition or
unsupported widget can survive in source JSON even if no visible Canvas card
is created. A dropped Canvas node is not automatically a failed JSON export.

The current converter matrix is in
[`MIRO_CAPABILITIES.md`](MIRO_CAPABILITIES.md). Text/shapes/stickies and
card/app-card content become text nodes; images/documents become file nodes;
frames become groups; connectors become edges; supported mindmap nodes become
text plus hierarchy edges. Slide-deck layouts are reconstructed. Empty or
known geometry-only families can be intentional visible drops. Comment
formatting, [`_format_comment_html`](../Json_2_Canvas/Converter.py), lines
4260–4340, can render root text, resolved state, mentions/reactions and embedded
messages/replies when present. It cannot recover data the source never fetched.

## Read capability and field-source inventory

“Captured” below means returned mapping fields survive collection/serialization,
not that every field is guaranteed present or every target format renders it.

| Family / fields | Official read source | Implemented capture and Canvas consequence | Confidence |
|---|---|---|---|
| Text, basic shapes, sticky notes: content, style, geometry, parent, timestamps | REST item APIs; SDK typed objects. [Text](https://developers.miro.com/docs/websdk-reference-text), [Shape](https://developers.miro.com/docs/websdk-reference-shape), [Sticky note](https://developers.miro.com/docs/websdk-reference-sticky-note). | REST collection objects and SDK enumerable fields captured; text/style converted. Dedicated detail reads not routinely used. | H for general support; M for exhaustive fields. |
| Flowchart shapes: richer content/style/geometry | Experimental REST items/detail; experimental SDK shapes. [REST experimental list](https://developers.miro.com/reference/get-items-experimental), [SDK experimental shape](https://developers.miro.com/docs/websdk-reference-shape-experimental). | REST experimental list used; SDK experimental namespace unused. Official SDK examples show richer experimental objects versus stable `stencil` objects. REST may compensate but is not evidence of complete SDK source capture. | H. |
| Cards / app cards: title, description, fields, status/dates, attachments represented by URLs | REST typed item APIs and SDK. [Card](https://developers.miro.com/docs/websdk-reference-card), [App card](https://developers.miro.com/docs/websdk-reference-app-card). | Captured mappings retained; normalization handles title/description/URL/HTML/fields. Source JSON can retain more than rendered card text. No general download of every linked external service/resource. | H/M. |
| Image and document resource URL / bytes | REST image/document resources; SDK image object. [Image](https://developers.miro.com/docs/websdk-reference-image), [REST reference guide](https://developers.miro.com/docs/rest-api-reference-guide). | Image/document collection evidence and local assets supported. SDK document content is limited. Original/preview fallback and generated `doc_format` assets need explicit fidelity wording. | H code; M for all original bytes. |
| Embed / preview: URL, HTML, preview metadata | REST embed resources; SDK embed and preview. [Embed](https://developers.miro.com/docs/websdk-reference-embed), [Preview](https://developers.miro.com/docs/websdk-reference-preview). | Raw fields retained; embed thumbnail best effort; target can be link/file/diagnostic. A provider URL does not mean its full video, audio or interactive app is archived. | H. |
| Frame: title, style, children, parent-relative layout | REST frames/items and SDK frame fields / `getChildren`. [Frame](https://developers.miro.com/docs/websdk-reference-frame). | Collections and enumerable child IDs captured; no explicit traversal/reconciliation. Canvas group/layout supported. | H/M. |
| Group: membership | Stable REST groups and group/membership detail; SDK `itemsIds`, item `groupId`, `getItems`. [REST groups](https://developers.miro.com/reference/get-all-groups), [SDK group](https://developers.miro.com/docs/websdk-reference-group). | Both list surfaces captured; detail calls unused. Group creation is `miro.board.group`, not `createGroup`. | H. |
| Connector: endpoint references, captions, line shape/style, timestamps | Stable REST connector list/detail and SDK connector. [List](https://developers.miro.com/reference/get-connectors-1), [Detail](https://developers.miro.com/reference/get-connector-1), [SDK connector](https://developers.miro.com/docs/websdk-reference-connector). | Collection and SDK properties retained; dedicated REST detail not read. Canvas needs resolvable endpoints. Create restrictions on loose/dangling lines do not by themselves establish read restrictions. | H/M. |
| Tags: definition title/color and item assignment | REST definitions and item/tag relation APIs; SDK tags and card/sticky `tagIds`. [Board tags](https://developers.miro.com/reference/get-tags-from-board), [Item tags](https://developers.miro.com/reference/get-tags-from-item), [SDK tag](https://developers.miro.com/docs/websdk-reference-tag). | Definitions implemented; SDK assignments preserved when enumerable. Explicit REST relations absent. Definitions are metadata, not standalone geometric Canvas nodes. | H/M. |
| Mindmap nodes: `nodeView`, children/parent, layout/direction | Experimental REST mindmap nodes; SDK experimental nodes. [REST list](https://developers.miro.com/reference/get-mindmap-nodes-experimental), [SDK mindmap node](https://developers.miro.com/docs/websdk-reference-mindmap-node). | Incidental REST/SDK appearances retained; dedicated experimental reads absent. Converter supports observed node content/hierarchy. Do not label REST mindmap read universally unsupported. | H for documented surface; M for incidental capture. |
| Comments: text, author, position, replies/messages, reactions, resolved state | Observed experimental REST collection retained by the project; exact additional REST contracts unresolved here. Official MCP separately documents these reads (see below). | REST probe collections implemented; embedded fields retained and comment Canvas annotations supported. No explicit REST detail/reply/resolved queries. | H code; M local observation; U exhaustive REST contract. |
| Layer order | SDK board/item `getLayerIndex`; frames excluded by its explicit caveat. [Shape layer method](https://developers.miro.com/docs/websdk-reference-shape#getlayerindex). | No method calls in exporter. Returned array order is not independently validated as layer order. | H. |
| Item metadata / board app data | SDK app-scoped metadata methods. [Item metadata](https://developers.miro.com/docs/websdk-reference-app-card#getmetadata), [Board app data](https://developers.miro.com/docs/websdk-reference-board#getappdata). | Neither queried. Readable data is limited to the exporting app's namespace, not metadata from arbitrary installed apps. | H. |
| Code, `doc_format`, slide containers/decks | Local observed REST samples, not general documented SDK CRUD support. | Existing fixture/converter support is useful observed coverage, not a universal platform guarantee. | M. |
| Emoji, stroke, table, kanban, USM, mockup and other unsupported families | Typed CRUD matrix and generic unsupported SDK object differ in granularity. [CRUD matrix](https://developers.miro.com/docs/miro-web-sdk-board-items-crud), [Unsupported](https://developers.miro.com/docs/websdk-reference-unsupported). | Geometry/identity evidence may be retained. Full stroke path, table cells or widget internals are not established by current captures. See limitations below. | M/U for full content. |

Stable generic item and type-specific read endpoints are described in the
[official REST reference guide](https://developers.miro.com/docs/rest-api-reference-guide).
The audit could not retrieve the old stable `reference/get-items` page: the
documentation fetch returned 404, while other official pages still reference
the API. This is a documentation-access limitation, not evidence that the
live endpoint is gone. Connector pages are currently reachable at the `-1`
slugs linked above. These URL issues should not become unsupported-type claims.

## Prioritized endpoint and collection gaps

### P1 — Offset pagination can falsely report completeness

`GET /v2/boards/{board_id}/tags` documents `limit` and `offset`. The shared
helper, downloader lines 670–749, recognizes only a response cursor or next
link. [Official tag pagination](https://developers.miro.com/reference/get-tags-from-board).

An ephemeral offline check patched `requests.Session` with the existing
`FakeSession` from `tests/test_miro_downloader_pagination.py`. The tags response
contained 50 objects, `offset=0`, `limit=50`, `total=60`, and no cursor/next link.
All other collections and board metadata were harmless synthetic responses.
Observed result:

```text
synthetic_declared_tags=60; captured_tags=50; tag_requests=1; complete=True
```

This proves a code failure for that response shape. It does **not** prove
current Miro omits next links. A SDK union might restore some missing tag IDs,
but it cannot make an incorrect REST completeness assertion valid. Follow-up:
endpoint-specific pagination, total/count reconciliation, and fixtures for
offset-only, links-based, empty-progress and changing-total responses.

### P1 — Explicit experimental SDK reads

Missing production calls: `miro.board.experimental.get({type: 'shape'})` and
`miro.board.experimental.get({type: 'mindmap_node'})`. The
[experimental shape reference](https://developers.miro.com/docs/websdk-reference-shape-experimental)
provides concrete stable-versus-experimental payload examples; the
[mindmap reference](https://developers.miro.com/docs/websdk-reference-mindmap-node)
documents the experimental node query. Normal `exportBoard` only calls stable
`get`. Follow-up: keep both source variants by ID, record experimental method
outcomes and eligible types, and preserve partial/unsupported status rather
than silently folding missing methods into “complete.”

### P1 — Layer and app metadata reads

Read layer indices for supported items using the documented method; exclude
frames according to its explicit caveat. Capture per-item metadata and board
app data only within the current app's readable namespace. No general REST
metadata endpoint was verified in this audit. Follow-up: explicit method
provenance, unsupported/error status per item, and empty-versus-unread
distinctions. Do not promise access to third-party integration metadata.

### P1 — Dedicated experimental REST mindmap reads

Unqueried: `GET /v2-experimental/boards/{board_id}/mindmap_nodes` with
`limit`/`cursor`, and
`GET /v2-experimental/boards/{board_id}/mindmap_nodes/{item_id}`. Both are
documented reads requiring `boards:read`.
[List reference](https://developers.miro.com/reference/get-mindmap-nodes-experimental),
[detail reference](https://developers.miro.com/reference/get-mindmap-node-experimental).
This is an exporter read-surface gap even though generic local exports have
occasionally included nodes. Additional node payload over those incidental
captures is unmeasured. The general
[board-items guide](https://developers.miro.com/docs/board-items) still states
REST mindmaps are unsupported; prefer the specific current experimental read
references and label the contradiction rather than copying a blanket `NO`.

### P1 — Connector detail; field gain must be measured

Unqueried: `GET /v2/boards/{board_id}/connectors/{connector_id}`
(`boards:read`). The [official detail reference](https://developers.miro.com/reference/get-connector-1)
documents the read. The list call already exists. Compare endpoint objects
for captions, attachment position/snap information, shape/style and identity
metadata before concluding detail necessarily adds any particular field.
Retain differing variants rather than replacing the list evidence. **No
measured caption loss is asserted by this audit.**

### P1 — Tag relations; definitions are already present

Unqueried documented reads:

- `GET /v2/boards/{board_id}/items/{item_id}/tags` —
  [item-tag relations](https://developers.miro.com/reference/get-tags-from-item).
- `GET /v2/boards/{board_id}/items?tag_id=...` with offset pagination —
  [items by tag](https://developers.miro.com/reference/get-items-by-tag).
- `GET /v2/boards/{board_id}/tags/{tag_id}` —
  [tag detail](https://developers.miro.com/reference/get-tag).

The first two provide ways to verify assignments without relying on SDK
property enumeration. Tag detail may be redundant with the existing definition
list. Its reference unexpectedly labels the required scope `boards:write`,
despite being a GET; do not silently assume `boards:read` for that particular
endpoint or expand requested privileges without further verification. SDK
`tagIds` is documented for cards/stickies, so the canonical union must not be
described as omitting every tag association.

### P2 — Group membership and child reconciliation

Unqueried: `GET /v2/boards/{board_id}/groups/{group_id}` and
`GET /v2/boards/{board_id}/groups/items?group_item_id=...`, plus SDK group
`getItems` and frame `getChildren`. [Group detail](https://developers.miro.com/reference/getgroupbyid),
[membership query](https://developers.miro.com/reference/getitemsbygroupid),
[SDK group](https://developers.miro.com/docs/websdk-reference-group),
[SDK frame](https://developers.miro.com/docs/websdk-reference-frame#getchildren).
Existing lists and structural IDs may already preserve the membership.
Follow-up: reconcile referenced IDs against captured IDs, and only fetch
additional representations when needed. Frame traversal does not prove an
unsupported table/kanban parent exposes its hidden descendants.

### P2 — Stable/experimental REST evidence and generic detail

The documented stable `GET /v2/boards/{board_id}/items/{item_id}` and
experimental counterpart exist, but only targeted table/slide probes use
generic detail calls. [Stable guide](https://developers.miro.com/docs/rest-api-reference-guide),
[experimental detail](https://developers.miro.com/reference/get-specific-item-experimental).
Routine export does not verify list/detail parity. Nor does it always query
both stable and experimental item lists. Because the experimental list
reference only lists `shape` as its type filter while its prose discusses all
items, do not infer an exhaustive supported type enum from that page. Follow-up:
compare authorized saved responses for the same unchanged board and preserve
source-specific differences. This audit establishes an uncertainty, not a
proven missing stable item family.

### P1 — Comments, replies and resolved-state proof

The current REST code fetches available collection pages and retains embedded
messages/replies and state. It does not independently enumerate per-comment
detail/replies, specify a resolved-state filter, or reconcile nested reply
counts. Neither auditor obtained a current official REST reference verifying
the exact experimental comment list/detail/reply contracts, filter names,
defaults or reply pagination. **Do not invent `/replies` endpoints or state
that resolved threads are excluded by default.** Project-observed experimental
collection support is real local evidence, but is different from an official
exhaustive thread contract.

To substantiate complete threads, first obtain the documented or authorized
saved response contract: whether the unfiltered collection includes resolved
threads, whether nested replies are complete or paginated, and how thread and
reply counts are reconciled. Current collection-page success proves only the
pages requested under that contract. The converter's ability to render replies
does not establish collection completeness.

## Conditional sources and documented API limits

### Enterprise Board Export — verified, not implemented

The public Enterprise export workflow is documented:

- `POST /v2/orgs/{org_id}/boards/export/jobs` —
  [create job](https://developers.miro.com/reference/enterprise-create-board-export).
- `GET /v2/orgs/{org_id}/boards/export/jobs/{job_id}` —
  [job status](https://developers.miro.com/reference/enterprise-board-export-job-status).
- `GET /v2/orgs/{org_id}/boards/export/jobs/{job_id}/results` —
  [results](https://developers.miro.com/reference/enterprise-board-export-job-results).

Eligibility requires **Enterprise, Company Admin, eDiscovery enabled and
`boards:export`**. The creation request has a `request_id` UUID and board IDs;
it creates an asynchronous export job rather than a Miro board item. A
repository search found no implementation of these paths. This is a
conditional source expansion, not something the ordinary user-owned app
already captures. [Eligibility and request parameters](https://developers.miro.com/reference/enterprise-create-board-export).

The archive contains SVG/HTML resources or PDF board representations, comments
JSON, collaborators and board metadata, plus applicable TalkTrack footage and
metadata. Results are retained for 14 days; generated download links expire
after 15 minutes. [Export contents and lifecycle](https://developers.miro.com/reference/board-export).
No native `.rtb` restore contract or byte-for-byte backup was verified.

### Official MCP capabilities — companion evidence, not REST verification

The official MCP changelog documents `comment_list_comments`, with board/item
selection, date/resolved filters and author/reply/reaction/position data. That
announcement describes self-serve/non-Enterprise availability. It also
documents code-widget read/list tools. These are separate tool contracts and
do **not** establish equivalent REST paths, parameters, or access for this
exporter. [Official MCP comments/code announcement](https://developers.miro.com/changelog/new-miro-mcp-server-tools-create-items-boards-code-widgets-read-comments-and-more).

The table announcement documents `table_list_rows` with column metadata,
filtering and cursor pagination. That is evidence against an unqualified claim
that Miro never exposes table content through any public surface. It does not
verify the probe's guessed experimental REST routes, legacy table compatibility,
current account eligibility, or how all table IDs would be discovered. The
same announcement describes document *creation*, which must not be treated as
document *read/export* support.
[Official MCP table/document announcement](https://developers.miro.com/changelog/new-tools-tables-docs-for-mcp-server).

These tools are not integrated in the repository. No connector was installed
and no account was contacted. They are optional future sources outside this
audit's primary REST/Web SDK scope; an “all public API data” claim would need
to explicitly include or exclude them and their eligibility.

### Stroke, emoji and unsupported families — partial reads are distinct

The [SDK CRUD matrix](https://developers.miro.com/docs/miro-web-sdk-board-items-crud)
marks Emoji readable but Stroke without typed CRUD support. The
[Unsupported reference](https://developers.miro.com/docs/websdk-reference-unsupported)
includes both families and permits generic geometry/identity access and some
operations while excluding full content creation/update. The statements differ
in granularity: lack of typed content CRUD does not mean no generic object can
be read. Geometry is not a stroke point/path payload or recovered emoji code.
No full stroke-path read endpoint was verified by this audit; that remains
unknown beyond the current documented generic limitations.

Likewise, unsupported-parent child visibility is a known SDK boundary, not a
reason to skip documented traversal of supported frames/groups. Unsupported
pages sometimes list inherited methods alongside explicit exclusions (for
example metadata); use explicit caveats and runtime capability checks rather
than assuming every listed method works on every family. `getAiContext` also
appears in several property tables, but this audit did not establish its data
contract or eligibility; it is a follow-up candidate, not verified widget
content recovery.

## Source probes and evidence boundaries

[`miro_table_probe.py`](../scripts/miro_table_probe.py), lines 23–127, checks
generic/type-filtered items, candidate table/data-table collections and generic
or candidate detail paths. [`miro_slide_probe.py`](../scripts/miro_slide_probe.py),
lines 24–133, does the analogous work for slides/containers/presentations.
These request inventories contain exploratory paths; their presence in a probe
does not make them documented public APIs. Their `_run_requests` helpers,
respectively lines 258–287 and 329–358, fetch each planned request once, not an
exhaustive paginated collection. They establish observed payload/access
evidence, not complete board coverage. No probes were run live in this audit.

The [2026-06-11 table evidence](../tests/fixtures/table_source_limited/source_evidence_2026-06-11.json)
records geometry without text and access-blocked experimental table paths. It
does not show all app/plan configurations or all future endpoints lack cells.
An authorization failure is evidence of access restriction for that request,
not proof of absent API support. Unknown/candidate table routes must remain
unverified unless a current official read reference or authorized payload
establishes the contract.

[`miro_capability_probe.py`](../scripts/miro_capability_probe.py), lines 49–249,
uses a hard-coded capability matrix. Its `mindmap_node` REST read `NO`
entry and group `createGroup` label are stale relative to current official
references and the actual SDK generator. It is a local diagnostic policy,
not an authoritative platform capability database. Its intentional/source-limited
classification therefore cannot by itself settle an exporter-gap question.

[`miro_source_expansion_workflow.py`](../scripts/miro_source_expansion_workflow.py),
lines 47–162, plans generated probes, same-board captures, comparison and merge.
[`miro_rest_probe_board.py`](../scripts/miro_rest_probe_board.py) and
[`miro_rest_generate_probe_board.py`](../scripts/miro_rest_generate_probe_board.py)
generate selected *create* families. Generatable fixtures cannot establish
read completeness for UI-created widgets, unsupported families, resolved
comments, or third-party data.

## Documentation wording to refine

For the parent's new REST+Web SDK default and explicit REST-only choice, the
workflow distinction is reasonable. Refine the current comparison as follows:

| Proposed comparison | Accurate bounded replacement |
|---|---|
| “SDK adds groups” | “SDK supplies complementary group/item evidence.” REST `/groups` is already captured; groups are not uniquely SDK data. |
| “SDK adds geometry/styles” | “SDK may enrich geometry and styling when its payload contains fields absent from REST.” Both sources expose these fields for supported families; gains depend on type and returned values. |
| “SDK adds experimental mindmaps” | “Experimental SDK APIs can read mindmap nodes, but the current production SDK exporter does not explicitly call them.” Incidental capture and existing converter support do not justify a guaranteed gain. |
| “REST supplies comments/files” | “This pipeline obtains available comment payloads and required assets through its REST/download path.” Do not imply whole-thread completeness or original-resolution fidelity beyond verified contracts. |

The combined default improves access to complementary sources. It does not
close the explicit read gaps or turn `capture_complete` into whole-board
completeness. See the priority table and source inventory above.

Recommended user-facing statement:

> Exports the configured Miro REST collections, available comment payloads,
> a fresh Web SDK board capture, and required local assets. The JSON preserves
> captured source objects and provenance. Coverage depends on API surface,
> permissions and item type; some documented reads are not yet collected.
> Canvas is an optional rendering of supported content.

Until the gaps are closed, avoid “all public API data,” “full backup,” “exact
copy,” “all original attachments,” or unqualified “complete comment threads.”
Use “complete capture of the declared sources” only with a stated source
inventory and the pagination caveat resolved.

Specific corrections for a separate documentation/UI task:

1. Separate **exported as raw JSON**, **rendered in Canvas**, **geometry-only**,
   **not yet queried**, **access blocked**, and **unknown** statuses.
2. Retain REST tag/group collection support; add missing relation/detail
   verification without claiming these families are wholly absent.
3. Treat experimental mindmap reads as conditional documented support, rather
   than a universal REST prohibition. Use `miro.board.group` for SDK creation.
4. Qualify the capability matrix's blanket API-limit wording with surface/date
   and access evidence. Do not equate “cannot create” with “cannot read.”
5. Remove the downloader docstring's assertion that public REST comments are
   unavailable without acknowledging the implemented experimental comment
   source. Keep talktrack coverage a separate unresolved/conditional claim.
6. Explain preview fallback and generated PDF/HTML fidelity. Preserve successful
   exports while reporting reduced asset fidelity when applicable.

## Validation performed

- Read root `AGENTS.md`, repository maintenance skill, README and capability
  matrix; inspected exporter/downloader, strict REST orchestration, comment,
  table/slide/capability probes, source-expansion workflow, SDK exporter,
  canonical merge and relevant converter paths.
- Official documentation browsing only; no call to a live Miro API endpoint.
- Focused offline tests: **90 passed** across REST pagination/export, comment
  probe, canonical merge and the two SDK runtime test wrappers.
- Synthetic offset-pagination reproduction: **50/60 tags, `complete=true`**
  for an offset/total response without continuation links. No persisted test or
  implementation file was added.
- Ruff: **passed** for the repository's prescribed targets.
- `git diff --check`: **passed** on tracked working-tree changes; the new
  report was also checked separately for trailing whitespace and local links.
- Full pytest in the concurrently edited checkout: **594 passed, 4 failed,
  1 skipped, 190 subtests passed**. Failures were the synthetic Windows
  Credential Manager round-trip and three GUI tests:
  `test_context_for_all_workflows_and_sources`,
  `test_websdk_instructions_are_inline_copyable_and_translated`, and
  `test_gui_exports_outside_vault_and_offers_offline_conversion`.
  The report does not establish their baseline cause; no unrelated fix was
  attempted. Test credentials were synthetic, not user secrets.
- No conversion/rendering implementation changed, so the visual regression
  workflow was not required for this report-only task.

## Краткие выводы по-русски

Экспорт уже собирает REST-коллекции connectors, tags и groups и сохраняет
исходные объекты с provenance. Но обещание «максимум всех данных публичных API»
пока не доказано: не вызываются experimental SDK reads, чтение порядка слоёв,
метаданных приложения и ряд detail/relation endpoints.

Офлайн воспроизведён конкретный риск: ответ с 60 тегами и offset/total без
next-link приводит к сохранению 50 тегов при `complete=true`. Это проверка
кода на синтетическом ответе, не результат live-запроса Miro.

Отсутствие вызова detail endpoint ещё не доказывает потерю конкретного поля.
Нужно сравнить payloads. Доступные JSON-данные и видимые Canvas-узлы — разные
уровни: `miroSource` сохраняет источник даже при отсутствии отдельного узла.
Неизвестный endpoint, отказ в доступе и невозможность создания элемента не
означают автоматически, что чтение его данных невозможно.

Enterprise Board Export — отдельный документированный источник с требованиями
Enterprise, Company Admin, eDiscovery и `boards:export`; он не реализован.
Официальные MCP-анонсы описывают чтение строк таблиц и комментариев с replies и
resolved-фильтром. Это полезные дополнительные источники, но не доказательство
контрактов REST. Для REST-комментариев полнота вложенных replies и включение
resolved threads в текущий запрос пока независимо не подтверждены.

## Parent integration validation

After integrating the new default policy and explicit REST-only choice, the
parent ran the full suite: **606 passed, 1 skipped, 190 subtests passed**.
Focused native GUI/CLI checks and CustomTkinter 5.2.2 smoke checks passed.
The audit-run failures above describe its concurrent snapshot, not the final
integrated result. No exporter-gap fixes or live Miro calls were added.

## Implementation follow-up to the four requested fixes

The audit above describes the pre-fix snapshot. The subsequent implementation:

1. Fixes tag offset pagination and total conservation. The 60-tag synthetic case
   captures 60/60, including the full-page/no-total variant. Duplicate page IDs,
   changed totals, offsets, collection paths or membership filters fail capture.
2. Reads explicit REST experimental mindmap lists/details and SDK experimental
   shapes/mindmaps, layer indices and exporting-app metadata. SDK evidence has
   revision `20261006-read-enrichment`; method outcomes and original experimental
   variants are preserved through canonical merge. Other apps' metadata remains
   outside the exporting app's access.
3. Reads REST connector details, group details/members and items assigned to each
   tag. Synthetic tests verify extra connector captions/styles, group membership
   and multiple tag assignments survive deduplication with original variants.
   The actual per-board increment over existing lists still requires live comparison.
4. Reconciles returned nested replies/messages with their own declared counts,
   follows only server-provided continuation links on the same board/origin, and
   rejects known truncation. Original nested collections and continuation bodies
   remain in the probe evidence. Unknown counts remain unverified; reply counts
   are not equated with messages that may include the root message. Returned
   resolved flags are preserved, but all-resolved-thread coverage remains
   explicitly unverified in `thread_coverage` and the UI/docs.

A read-only live comment check was attempted for the already-authorized
TEST_BOARD, but the OS credential store had no saved Miro connection. No Miro
request was made. Thus this follow-up supplies implementation and synthetic
validation, not confirmation of live reply or resolved-thread completeness.

The full regression run passed its unit suite and diagnostic renderer smoke.
All existing visual baselines passed; seven fixtures have no visual baseline
and were explicitly skipped. The sandbox's synthetic Credential Manager write
failed initially; the isolated test and full suite passed with OS access.
Final validation after the pagination-filter checks: **622 passed, 1 skipped,
204 subtests passed**; Ruff and `git diff --check` passed.
