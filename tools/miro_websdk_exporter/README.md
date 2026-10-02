# Miro Web SDK exporter

Buildless Miro app for capturing the maximum board JSON exposed by the Web SDK.
It is a complementary source for the canonical REST+Web SDK production union
and a probe tool for source-limited item families.

If this is your first Miro Developer App, follow the
[beginner setup guide](../../docs/MIRO_APP_SETUP.md) before using the steps
below. Normal export needs only `boards:read` and `team:read`; add
`boards:write` only for an intentional generated-item probe.

## Install and open

1. Start the no-cache server:

```powershell
miro2obsidian websdk-serve --port 8766
```

2. Register this App URL in Miro:

```text
http://localhost:8766/index.html
```

3. Upload `icon-outline.svg` and `icon-color.svg`, install the app into the
   target board's team, and open it from `+ More apps` / `+ More tools`.
4. Press `Export board`. With the server running the capture is sent to
   miro2obsidian automatically (see [Handoff](#handoff-to-the-local-program));
   `Download JSON` / `Copy JSON` remain as fallbacks.

The recommended split keeps the Web SDK app on `8766` and the REST OAuth
callback on `8765`, so both roles cannot intercept each other.

For an existing app already configured with this App URL:

```text
http://localhost:8765/callback
```

start the exporter with:

```powershell
miro2obsidian websdk-serve --port 8765
```

The packaged server (and its source compatibility launcher `serve_no_cache.py`)
routes a callback without OAuth `code` to the current
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

## Handoff to the local program

The server started by `miro2obsidian websdk-serve` also exposes a small JSON API
under `/api/`, so a finished capture reaches the local program without a
download. Captures are validated with the same checks as the production merge
(`validate_websdk_export`, including board identity and freshness) and then
written atomically to
`<capture dir>/<board id, filesystem-safe>/websdk-<UTC timestamp>.json`.

The capture directory defaults to `miro2obsidian/websdk-captures` inside the
per-user application data directory (`%LOCALAPPDATA%` on Windows,
`~/Library/Application Support` on macOS, `$XDG_DATA_HOME` or `~/.local/share`
elsewhere). Override it with `MIRO2OBSIDIAN_CAPTURE_DIR` or
`websdk-serve --capture-dir <dir>`; `--max-capture-mib` (default 512) bounds one
upload.

Files in this directory:

| File | Role |
| --- | --- |
| `exporter-core.js` | Capture logic without UI: `window.Miro2ObsidianExporter.exportBoard()` returns the `maximum_board_v1` payload. |
| `handoff.js` | Same-origin client for the API: session, token, upload, pending-request check, per-board lock. |
| `exporter.js` | Panel UI: buttons, auto-send, auto-run when a request is pending. |
| `index.html` | Headless entry: icon registration plus the pending-request check. |

### HTTP API

| Request | Purpose |
| --- | --- |
| `GET /api/session` | `{"app": "miro2obsidian-websdk", "protocol": 1, "token": ..., "pending": [board ids], "accepting": true}` |
| `POST /api/captures` | Upload a Web SDK export (token and same-origin `Origin` required). Replies `{"status": "accepted", "board_id", "path", "items"}` or a 4xx `{"status": "rejected", "error"}` that never contains payload data. |
| `POST /api/requests` | Register a pending request `{"board_id": "...", "ttl_seconds"?: n}` (token required; used by other local processes). Requests expire after 30 minutes by default. |
| `GET` / `DELETE /api/requests/<board id>` | Inspect or cancel a pending request (token required). |

### Security model

- Loopback only: use the default `--host localhost`. Every `/api/` call must have
  a loopback `Host` header with the server's own port, which defeats DNS
  rebinding.
- Same-origin only: the server never sends CORS headers (no
  `Access-Control-Allow-Origin`, `OPTIONS` is refused), so web pages from other
  origins cannot read the token. An `Origin` header, when present, must be
  `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>`;
  `POST /api/captures` requires it (the panel iframe is same-origin and browsers
  send `Origin` on POST); cross-site `Sec-Fetch-Site` values are refused.
- A random per-process token (`X-Miro2Obsidian-Token`, compared in constant
  time) is required for every write. It is handed out by `GET /api/session` to
  same-origin pages and to local processes, so it protects against web pages and
  not against other programs running as the same user.
- Uploads must be `application/json`, are size-limited, streamed to a temporary
  file in the capture directory, validated, then renamed into place. Nothing is
  stored on failure, and payload contents are never logged or echoed.

### Pending capture requests

Code that wants a specific board registers a request (Python:
`miro2obsidian.websdk_capture.capture_board(board_id)` does everything, or
`CaptureServer().request_capture(board_id)`). The Miro app then exports that
board and uploads it:

1. If Miro keeps `index.html` loaded while the board is open, it polls
   `/api/session` every few seconds; when its board id is pending it exports the
   whole board headlessly and uploads it (a Miro notification shows
   `miro2obsidian: exporting board...`).
2. Clicking the app icon opens the panel, which checks the same request on load
   and exports and sends without another click.
3. Outside any request, `Export board` still sends the capture automatically
   when the server answers, and `Send to miro2obsidian` repeats it.

Only whole-board exports are sent; selection and probe exports stay
download-only. An export lock keeps the hidden frame and the panel from running
the same board twice at once.

**Honest limitation:** whether Miro loads `index.html` on its own when a board
opens (so that step 1 needs no click) depends on Miro's app runtime and could
not be verified offline. Plan for one click on the app icon (left toolbar, or
`+ More apps` -> the app) as the dependable path; if Miro does load the app by
itself, no click is needed. When the local server is not reachable the app
behaves exactly as before.

If a second `websdk-serve` or program wants the same port, `CaptureServer`
attaches to an already running miro2obsidian server through this API instead of
failing, and reports a clear error if the port belongs to something else.

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

The usual path needs no file at all: `miro2obsidian import --board <ref>
--vault <vault> --websdk auto` (or `required`) starts this server, asks for a
capture of the board, receives it through the handoff and runs the REST export
right after it. `miro2obsidian capture --board <ref>` only fetches the capture.

With a capture saved as a file (the Download fallback), run the strict REST
export and merge it in one transactional pipeline:

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
