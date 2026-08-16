# Miro to Obsidian Canvas

**English** | [Russian](README.ru.md)

A local-first, verifiable pipeline for exporting the maximum board data exposed
by Miro's public APIs and converting it to a valid Obsidian Canvas.

The supported production path combines a strict Miro REST export, REST
comments, downloaded assets, and a fresh whole-board Web SDK export. It keeps
the original source objects and field-level provenance in the canonical JSON
before producing the `.canvas` file.

> This is a maximum public-API export, not a byte-for-byte Miro backup. Known
> API limitations are recorded in the output instead of being hidden.

## What it does

- Exports all paginated board items available through Miro REST.
- Exports complete REST comment threads and metadata.
- Captures the whole open board through the Miro Web SDK `maximum_board_v1`
  profile.
- Merges REST and Web SDK data without discarding either original source.
- Downloads required image, document, and `doc_format` assets.
- Converts text, shapes, sticky notes, files, links, frames, groups, connectors,
  comments, mind maps, code blocks, and supported slide data to JSON Canvas.
- Validates completeness, IDs, file references, edges, item mapping, geometry,
  and visual regression fixtures.
- Supports both a reproducible CLI pipeline and a desktop GUI.

## Status

The conversion pipeline is working and covered by an automated regression
suite. It is currently a Windows-focused pre-release tested with Python 3.13.

Do not make the repository public until the previously committed Miro OAuth
credential has been revoked and removed from reachable Git history. The current
working tree does not contain that credential; see [`SECURITY.md`](SECURITY.md).

This project does not synchronize changes back to Miro. The planned
[`miro-canvas`](docs/miro-canvas.md) Obsidian plugin is a separate offline layer
for richer editing and display; it is not implemented yet.

## Data flow

```text
Miro board
  -> strict REST item pagination + REST comments
  +  fresh whole-board Web SDK export
  -> canonical REST/Web SDK union with provenance
  -> required local assets
  -> Json_2_Canvas/Converter.py
  -> validated Obsidian .canvas
```

REST remains authoritative for shared item IDs. Web SDK data fills empty fields
and contributes Web SDK-only items. Every original source item remains under
`source_provenance.original_items`.

## Requirements

- Windows 10 or 11 for the currently tested GUI and visual workflow.
- Python 3.13.
- Node.js only for the two optional Web SDK JavaScript smoke tests.
- Obsidian for final visual verification.
- A user-owned Miro Developer App for direct Miro exports.

Converting an existing canonical JSON file does not require Miro credentials or
network access.

## Installation

Runtime:

```powershell
python -m pip install -r requirements.txt
```

Development, tests, and visual regression:

```powershell
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
```

## Quick start

### Convert an existing JSON export

```powershell
python scripts\miro_pipeline.py `
  --existing-json `
  --source-json path\to\board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

### Use the desktop GUI

```powershell
python Miro_2_Obsidian_GUI.py
```

The GUI supports four explicit workflows:

- **Miro account**: authenticate, list visible boards, and choose one.
- **Miro URL**: export one board URL.
- **Miro URL list**: export board URLs from a Markdown or JSON file.
- **Existing JSON**: convert a local canonical JSON without contacting Miro.

### Export maximum public-API data

1. Create a Miro Developer App in the team that owns the board.
2. Register `http://localhost:8765/callback` as an OAuth redirect URI.
3. Enable `boards:read` and `team:read`. Add `boards:write` only for probe
   scripts that intentionally create test items.
4. Set local credentials:

```powershell
$env:MIRO_CLIENT_ID = "<your app client id>"
$env:MIRO_CLIENT_SECRET = "<your app client secret>"
$env:MIRO_REDIRECT_URI = "http://localhost:8765/callback"
```

5. Start the buildless Web SDK exporter on a separate port:

```powershell
python tools\miro_websdk_exporter\serve_no_cache.py --port 8766
```

6. Register `http://localhost:8766/index.html` as the Miro App URL, install the
   app into the target board's team, open it on that board, and choose
   **Export board**.
7. Run the transactional production pipeline with the downloaded Web SDK JSON:

```powershell
python scripts\miro_pipeline.py `
  --oauth `
  --board-id <board_id> `
  --websdk-json path\to\websdk-board.json `
  --source-json path\to\canonical-board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

By default, the REST and Web SDK captures must describe the same board, be no
more than 24 hours old, and be no more than 60 minutes apart. The run fails
before publication if pagination, comments, required assets, source identity,
or Canvas integrity is incomplete.

For local OAuth testing, `.miro_oauth.local.example.json` can be copied to the
ignored `.miro_oauth.local.json`. Environment variables are preferred for
automation.

## Source completeness

A successful maximum export requires:

- complete REST item pagination;
- complete REST comments;
- a fresh `maximum_board_v1` Web SDK board capture;
- matching board identity across both sources;
- zero missing required assets;
- `completeness.complete: true` and `capture_complete: true`;
- a parseable Canvas with unique node IDs and valid file and edge references.

`board_complete` remains `false` by design because Miro's public APIs do not
promise access to hidden internals of unsupported widgets. In particular, the
Web SDK cannot replace REST comments, and some table, document, slide, and
unsupported-widget details may not be available from either public surface.

See the measured [Miro versus Canvas display gaps](docs/MIRO_VS_CANVAS_DISPLAY_GAPS.md)
and the [Miro capability matrix](tasks/miro_capabilities.md).

## Validation

Run the full regression loop:

```powershell
python scripts\run_regression.py
```

Run the faster structural suite without browser screenshots:

```powershell
python scripts\run_regression.py --skip-render
```

Individual checks:

```powershell
python -m compileall -q Json_2_Canvas Miro_2_Json scripts tools tests Miro_2_Obsidian_GUI.py
python -m ruff check Json_2_Canvas Miro_2_Json scripts tools tests Miro_2_Obsidian_GUI.py
python -m pytest -q
node tests\websdk_serialization_smoke.js tools\miro_websdk_exporter\exporter.js
node tests\websdk_capture_completeness_smoke.js tools\miro_websdk_exporter\exporter.js
```

The browser renderer is a fast diagnostic harness. Real Obsidian remains the
visual source of truth; see [`tools/obsidian_oracle`](tools/obsidian_oracle/README.md).

## Repository layout

| Path | Purpose |
|---|---|
| `Json_2_Canvas/` | Converter core, scale engine, and focused JSON-to-Canvas GUI |
| `Miro_2_Json/` | REST downloader helpers and legacy focused downloader GUI |
| `scripts/` | OAuth, export, merge, pipeline, probes, audits, and regression commands |
| `tests/` | Unit tests and minimized regression fixtures |
| `tools/miro_websdk_exporter/` | Buildless whole-board Web SDK exporter |
| `tools/canvas_render/` | Fast diagnostic Canvas renderer |
| `tools/obsidian_oracle/` | Real-Obsidian staging and screenshot checks |
| `tools/obsidian_plugins/` | Small local plugins used by the validation workflow |
| `docs/` | Product plans and measured display limitations |
| `tasks/` | Maintainer research, capability evidence, and problem records |

Local boards, exports, vaults, credentials, browser output, and caches are
excluded by `.gitignore`.

## Documentation

- [Documentation index](docs/README.md)
- [Web SDK exporter](tools/miro_websdk_exporter/README.md)
- [Miro versus Canvas display gaps](docs/MIRO_VS_CANVAS_DISPLAY_GAPS.md)
- [`miro-canvas` offline plugin plan](docs/miro-canvas.md)
- [Fixture format](tests/fixtures/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Security

Never commit OAuth client secrets, access tokens, authorization callback URLs
containing `code=...`, real private board exports, or local `.env` files. See
[`SECURITY.md`](SECURITY.md) before reporting a vulnerability or publishing a
fork.

## License

No open-source license has been selected yet. A `LICENSE` file must be added
before an open-source release; until then, do not assume permission to copy,
modify, or redistribute the code.
