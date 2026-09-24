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

The known historical Miro OAuth credential has been revoked and is absent from
the release tree. See [`SECURITY.md`](SECURITY.md) for the current handling policy.

This project does not synchronize changes back to Miro. The separate offline
[`miro-canvas`](docs/miro-canvas.md) Obsidian plugin has a repository-level M0
foundation under [`plugins/miro-canvas/`](plugins/miro-canvas/): a native Canvas
adapter, an optional Advanced Canvas adapter, versioned schema validation and
in-memory migrations, an explicit metadata writer with a guarded atomic
compare-and-swap (CAS) bridge, and a deterministic four-profile compatibility
matrix with a project-local test vault. The plugin is not production-ready.
The current development build adds independent line/arrow connectors, an
explicit undoable legacy-line migration, persistent connector tool settings,
desktop clipboard hotkeys and a rebindable Escape reset command. See the
[connector checkpoint and compatibility limits](docs/miro-canvas.md#connector-development-checkpoint).
The real-Obsidian gate is still open: native Ctrl+Z/redo behavior and visual or
interaction verification in the real application have not been claimed. The
current development checkpoint adds M1 controls (navigation, minimap,
typography, themes, colors, locks, attachment titles) and M2 UI for six local
shapes, comment threads, connector endpoints and native document navigation.
Graph edits preserve source/unknown metadata and use native undo/redo.
Native zoom currently stays within 6.25%–200%. M3 adds local/source rotation,
layer ordering, rotated anchors, and reversible source-backed decoration for
Miro shapes, text, sticky notes, connectors, frames, and media. M4 has started
with bounded, inert code-block projection and code-card styling that leaves
native Canvas text editable. Proven `app_card` field collections also receive
reversible source-backed card styling while their content remains native text.
Preview metadata overlays keep native links clickable, and ordinary cards show
bounded chips resolved from non-visual source tag definitions.
Proven `mindmap_node` trees keep native Canvas text and hierarchy edges while
the plugin adds reversible root/branch styling; legacy `mindmap` stays explicit
as source-limited.
A read-only source inspector shows bounded type counts, completeness flags,
provenance counts, diagnostics, and unknown field paths without putting raw
source values into the DOM.

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

### Ready-made builds

No Python needed: each [release](https://github.com/NixWrk/Miro_2_Obsidian/releases/latest)
carries a build for Windows, macOS and Linux with two programs - the desktop
window (`miro2obsidian-gui`, on macOS `Miro 2 Obsidian.app`) and the command
line (`miro2obsidian`). Unpack the archive and run one of them.

The builds are not code-signed yet. On Windows, SmartScreen may warn on first
start: choose **More info → Run anyway**. On macOS, open the app with a
right-click → **Open** the first time. `--self-test` checks that a build found
everything it ships with.

### From source

Runtime:

```powershell
python -m pip install .
```

Development, tests, and visual regression:

```powershell
python -m pip install -e .
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
```

Build the programs yourself with `python -m PyInstaller release/miro2obsidian.spec`
(results in `dist/`); the Build workflow does the same on Windows, macOS and
Linux and publishes them when a `v<version>` tag is pushed.

### Develop the `miro-canvas` plugin

From the repository root:

```powershell
cd plugins\miro-canvas
npm ci
npm run typecheck
npm test
npm run build
```

Build and deploy the local runtime to the guarded M0 test vault from the
repository root:

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

`setup_m0_vault.py` creates the project-local `_obsidian_oracle_vault`, stages
all four offline fixtures, and atomically installs the built `manifest.json`,
`main.js`, and `styles.css` for `miro-canvas`. It does not install the optional
Advanced Canvas runtime. See the [M0 runbook](docs/miro-canvas.md) for the
profile activation/check commands and the real-Obsidian gate.

If Obsidian reports **vault not found**, first select **Open folder as vault**
and choose the exact absolute `_obsidian_oracle_vault` path printed by setup
(not its `MIRO2OBSIDIAN` subfolder). Check registration with
`python -m tools.obsidian_oracle.open_local_vault`; after registration, use
`python -m tools.obsidian_oracle.open_local_vault --profile both --open`.
Creating the folder alone does not register it in Obsidian.

### Coding agents

Repository-aware coding agents should start with [`AGENTS.md`](AGENTS.md).
Codex users can optionally install the repeatable repository skill:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_agent_skill.ps1
```

Invoke it as `$maintain-miro-2-obsidian`. The skill covers setup, architecture
rules, testing, packaging, and publishing recipes. No MCP server is required for
local repository maintenance.

Agents that read, check or edit the boards themselves - not the repository -
get a second skill that describes the board format and validates boards
against the versioned schema (`python -m miro2obsidian.validate`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_agent_skill.ps1 -Name miro-canvas-format
```

Add `-Agent claude` to install either skill for Claude Code instead of Codex.

## Quick start

New to Miro Developer Apps? Start with [Connect your own Miro boards](docs/MIRO_APP_SETUP.md).
The current one-time setup normally takes 10-20 minutes and requires no coding,
but it still includes a few manual Miro and local-server steps. The guide also
defines the planned download-and-run wizard that will remove terminal setup.

### Convert an existing JSON export

```powershell
miro2obsidian `
  --existing-json `
  --source-json path\to\board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

### Use the desktop GUI

```powershell
miro2obsidian-gui
```

The GUI supports four explicit workflows:

- **Miro account**: authenticate, list visible boards, and choose one.
- **Miro URL**: export one board URL.
- **Miro URL list**: export board URLs from a Markdown or JSON file.
- **Existing JSON**: convert a local canonical JSON without contacting Miro.

### Choose an output format

Both the CLI and the GUI write one of four formats, chosen with `--format`
(CLI) or the Format menu (GUI):

- `advanced-canvas` (default): today's Canvas for the [Advanced Canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas)
  plugin, with the richest styling.
- `native-canvas`: plain [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/),
  no plugin required. Text becomes Markdown; no HTML is left in the file.
- `miro-canvas`: for the [`miro-canvas`](docs/miro-canvas.md) Obsidian plugin,
  which draws the Miro look (fonts, colors, shapes, frames) from the
  preserved source data.
- `raw-json`: writes no Canvas at all, only the canonical Miro export JSON.
  Only meaningful when exporting from Miro; `--existing-json` already has
  that JSON as its input and rejects this format with a clear error.

```powershell
miro2obsidian `
  --existing-json `
  --source-json path\to\board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder `
  --format native-canvas
```

### Export maximum public-API data

The [beginner setup guide](docs/MIRO_APP_SETUP.md) explains every Miro screen,
the difficulty and benefit, team installation, troubleshooting, and which steps
the future first-run wizard will automate.

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
miro2obsidian `
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
and the [Miro capability matrix](docs/MIRO_CAPABILITIES.md).

## Validation

Run the full regression loop:

```powershell
python -m scripts.run_regression
```

Run the faster structural suite without browser screenshots:

```powershell
python -m scripts.run_regression --skip-render
```

Individual checks:

```powershell
python -m compileall -q Json_2_Canvas Miro_2_Json miro2obsidian scripts tools tests Miro_2_Obsidian_GUI.py
python -m ruff check Json_2_Canvas Miro_2_Json miro2obsidian scripts tools tests Miro_2_Obsidian_GUI.py
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
| `docs/` | Setup, capability evidence, runbooks, product plans, and display limitations |
| `ROADMAP.md` | Remaining public-release, onboarding, conversion, and plugin work |

Local boards, exports, vaults, credentials, browser output, and caches are
excluded by `.gitignore`.

## Documentation

- [Documentation index](docs/README.md)
- [Beginner Miro app setup](docs/MIRO_APP_SETUP.md)
- [Web SDK exporter](tools/miro_websdk_exporter/README.md)
- [Miro versus Canvas display gaps](docs/MIRO_VS_CANVAS_DISPLAY_GAPS.md)
- [Miro API and item capability matrix](docs/MIRO_CAPABILITIES.md)
- [Source-expansion runbook](docs/SOURCE_EXPANSION.md)
- [`miro-canvas` offline plugin plan](docs/miro-canvas.md)
- [Roadmap](ROADMAP.md)
- [Fixture format](tests/fixtures/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Security

Never commit OAuth client secrets, access tokens, authorization callback URLs
containing `code=...`, real private board exports, or local `.env` files. See
[`SECURITY.md`](SECURITY.md) before reporting a vulnerability or publishing a
fork.

## License

Released under the [MIT License](LICENSE). Miro, Obsidian, JSON Canvas, optional
plugins, and Python dependencies retain their own terms and licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

This is an independent interoperability project. It is not affiliated with,
endorsed by, or sponsored by Miro or Obsidian.
