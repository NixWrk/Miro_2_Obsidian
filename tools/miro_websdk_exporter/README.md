# Miro Web SDK exporter

Buildless Miro app for capturing the maximum board JSON exposed by the Web SDK.
It is a complementary source for the canonical REST+Web SDK production union
and a probe tool for source-limited item families.

## Install and open

1. Start the no-cache server:

```powershell
python tools\miro_websdk_exporter\serve_no_cache.py --port 8766
```

2. Register this App URL in Miro:

```text
http://localhost:8766/index.html
```

3. Upload `icon-outline.svg` and `icon-color.svg`, install the app into the
   target board's team, and open it from `+ More apps` / `+ More tools`.
4. Press `Export board` and download the JSON.

The recommended split keeps the Web SDK app on `8766` and the REST OAuth
callback on `8765`, so both roles cannot intercept each other.

For an existing app already configured with this App URL:

```text
http://localhost:8765/callback
```

start the exporter with:

```powershell
python tools\miro_websdk_exporter\serve_no_cache.py --port 8765
```

`serve_no_cache.py` routes a callback without OAuth `code` to the current
`index.html` entrypoint and listens on IPv4 plus IPv6 loopback. Stop this
server before a REST OAuth run that also needs port `8765`.

Troubleshooting:

- `ERR_CONNECTION_REFUSED`: the local server is not running on the App URL port;
- `404 File not found`: another static server does not know the configured path;
- app missing from the board: install it in the team that owns that board.

`index.html` is the only maintained entrypoint. `serve_no_cache.py` still maps
the former dated index and panel URLs to the current files, so existing Miro app
configurations keep working without duplicate HTML copies.

Install the app into the same team as the target board. If several similarly
named exporter apps exist, verify the App URL in `Profile settings` ->
`Your apps`, then distinguish this one by its uploaded icon or app name.

Open the installed app through `+ More apps` at the bottom of the left-hand app toolbar; some Miro versions label the same entry `+ More tools`. The monochrome outline icon appears in that toolbar and opens the exporter panel.

If installed apps are unavailable in the target team, use an app-visible team
and run both REST and Web SDK exports against the same board. Some plans reject
REST board creation with `Creating more boards is not allowed in this plan`;
choose an existing board and pass its id to the probe with `--board-id`.
If the app is installed but absent from the board toolbar, verify the App URL,
uploaded outline icon and team installation. An app installed in another team
does not appear on the target board.

## Board payload contract

Only `Export board` produces the profile accepted by the canonical merge:

- `schema_version: 1`;
- `exporter_version: "20260727-complete-json"`;
- `source_surface: "web_sdk"` and `export_scope: "board"`;
- `capture_profile: "maximum_board_v1"`;
- `exported_at` and board identity from `miro.board.getInfo()` when available;
- `items[]` from one complete `miro.board.get()` call;
- `provenance` with raw/serialized counts and serialization issues;
- `completeness` with capture status, coverage basis and known API limitations;
- `selection[]` and `selected_item_ids` as context only;
- deep `diagnostics` for unsupported/table-like items;
- `summary.by_type`.

`Export selection` and `Create probe items` remain diagnostics and are rejected
as production board sources. Every fresh board export must show the current
exporter version and `completeness.complete: true`.

Diagnostics intentionally use `item_id` and `item_type` instead of `id` and
`type`, so generic item scanners do not count them as extra board items. For
table recovery checks inspect `textish_values`, `known_field_reads` and
`prototype_chain`.

The app does not call REST and does not need a REST token. It cannot expose full
details of unsupported widgets, hidden children of unsupported parents, or
comment content. Those limitations are written into the payload instead of
being presented as a complete Miro backup.

## Production union

Run the strict REST export and merge the downloaded Web SDK board JSON in one
transactional pipeline:

```powershell
python scripts\miro_pipeline.py `
  --board-id <board_id> `
  --websdk-json path\to\websdk-board.json `
  --source-json path\to\canonical-board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

The pipeline verifies board identity, profile, source completeness and
freshness. REST values remain authoritative for shared ids; Web SDK fills empty
fields and adds Web SDK-only items. Original source objects and field-level
provenance remain in the canonical JSON, and missing required union assets are
downloaded before publication.

For source comparison without conversion:

```powershell
python scripts\miro_capability_probe.py `
  --rest-json path\to\rest.json `
  --websdk-json path\to\websdk-board.json
```

The local manifest sketch is `manifest.example.yml`. Prefer OAuth callback
port `8765` and static App URL port `8766`; callback-mode App URLs on `8765`
are compatibility-only and must not run concurrently with REST OAuth.
