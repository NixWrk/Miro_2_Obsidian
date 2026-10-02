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
- Supports a reproducible CLI, a desktop GUI, and an agent-ready interface
  (`--json` commands and an MCP server).

## Status

The conversion pipeline is working and covered by an automated regression
suite. It is currently a Windows-focused pre-release tested with Python 3.13.

The known historical Miro OAuth credential has been revoked and is absent from
the release tree. See [`SECURITY.md`](SECURITY.md) for the current handling policy.

This project does not synchronize changes back to Miro. The
[miro-canvas](https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas) Obsidian plugin, which draws the Miro look from boards
written in the `miro-canvas` format, lives in its own repository.

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

## Three ways to use it

| Way | You | Details |
|---|---|---|
| **Manual** | Create your Miro app and run the export yourself, in the desktop window or on the command line | [Connect your own Miro boards](docs/MIRO_APP_SETUP.md) |
| **Code automation** | Do the one-time human steps; code then renews tokens, captures, exports and converts, including on a schedule | [Workflow modes](docs/WORKFLOW_MODES.md) |
| **Agent** | Tell any AI agent "set everything up and export boards X and Y to folder Z" | [Agent setup](docs/AGENT_SETUP.md) |

Miro reserves a few steps for a person: creating your own app in the Developer
Hub, signing in (with MFA), approving access, and, where required, team
administrator approval. One click on the app icon on the board may also be
needed. No variant can skip these; [Workflow modes](docs/WORKFLOW_MODES.md)
lists exactly what is automatic and what is not.

For MCP clients: `miro2obsidian mcp` starts the server and
`miro2obsidian mcp --print-config --client claude-desktop` prints the config
(also `claude-code`, `codex`, `generic`). The server has not yet been tried with
real clients.

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

A third skill, `miro2obsidian-import`, lets an agent walk a person through the
whole import - getting the program, creating their own Miro app, exporting,
converting to the format they use and checking the result - by driving the
`miro2obsidian` command line (`doctor`, `setup guide`, `auth login --form`,
`boards`, `import --json`), without ever handling their credentials. An agent
without skills can run `miro2obsidian agent-guide` instead, or use the MCP
server. See [Agent setup](docs/AGENT_SETUP.md):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_agent_skill.ps1 -Name miro2obsidian-import
```

Add `-Agent claude` to install any of the skills for Claude Code instead of
Codex. Ready-made builds check boards with `miro2obsidian validate <file>`.

## Quick start

New to Miro Developer Apps? Start with [Connect your own Miro boards](docs/MIRO_APP_SETUP.md).
The one-time setup normally takes 10-20 minutes and requires no coding. Creating
the app in Miro's Developer Hub stays with you; the program does the rest.

### Import boards from the command line

```powershell
miro2obsidian setup guide                      # create your own Miro app (once)
miro2obsidian auth login --form                # connect it; a local form opens
miro2obsidian doctor --vault path\to\ObsidianVault
miro2obsidian boards
miro2obsidian import --board "Roadmap" --board https://miro.com/app/board/<id>/ `
  --vault path\to\ObsidianVault --folder Miro --format native-canvas
```

Every command accepts `--json`. `import` and `capture` print JSON Lines that end
with a summary. Exit codes: `0` complete, `2` degraded (written, with a reported
gap), `3` a person must act, `1` failed. The saved connection renews its own
token, so later and scheduled runs need no browser. Other commands: `setup
manifest`, `setup open`, `auth status [--verify]`, `auth logout`, `capture`,
`agent-guide`.

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

The GUI has four source choices and three execution modes:

- **Manual**: operate Miro yourself. A step-by-step **Set up Miro app** wizard
  (with Copy and Open buttons and a manifest copy) helps you create and connect
  your app.
- **Code automation**: code runs one or many boards through the import service,
  with a status for each board. The connection lives in the OS credential store
  and renews its own token. The Web SDK option is **Automatic**, **Off** or **From
  file**.
- **Agent**: a local agent launched by the GUI sets up and imports through the
  CLI. It accepts a degraded (REST-only) result and shows it as such. The GUI
  opens a dedicated Chromium profile for human-gated steps. **Copy instructions
  for my agent** gives you a prompt for any agent.
  Sign-in, MFA, and team approval still belong to the account owner.

See [three workflow modes](docs/WORKFLOW_MODES.md) for setup and limits.

The GUI supports four source choices:

- **Miro account**: use **Set up Miro app**, authenticate, list visible boards,
  and choose one. The connection, including your app's client secret, is saved in
  the OS credential store; see [`SECURITY.md`](SECURITY.md).
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
- `miro-canvas`: for the [`miro-canvas`](https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas) Obsidian plugin,
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

### Shared attachments

By default, once a board's Canvas is written, identical attachments (the
same image or file, byte for byte) are folded into one shared copy instead
of staying in that board's own `<board>_files` sidecar folder. Two boards
with the same picture, or a board imported twice, end up pointing at the
same file rather than each keeping their own copy.

Shared files live in `Miro attachments/` next to the vault's configured
attachment folder (or at the vault root if there is none), named
`<original name>-<content hash><extension>`. A manifest at
`.miro2obsidian/attachments.json` tracks which content hash maps to which
file; it is rebuilt as needed if a shared file is edited or removed by hand.
An exported `.html` document stays in its own sidecar, since it may
reference files beside it by name.

Pass `--keep-board-attachments` (CLI) or clear "Store identical attachments
once" (GUI) to keep today's per-board sidecar layout instead.

### Export maximum public-API data

The [beginner setup guide](docs/MIRO_APP_SETUP.md) explains every Miro screen,
the difficulty and benefit, team installation, and troubleshooting.

1. Create a Miro Developer App in the team that owns the board. `miro2obsidian
   setup manifest` prints the app name, URLs and scopes (`boards:read`,
   `team:read`) to paste or enter by hand. Add `boards:write` only for probe
   scripts that intentionally create test items.
2. Connect it: `miro2obsidian auth login --form`.
3. Import. The program starts its own Web SDK server, opens the board in your
   browser, receives the whole-board capture over loopback, and runs the REST
   export right after it:

```powershell
miro2obsidian import --board <name, URL or id> --vault path\to\ObsidianVault `
  --folder CanvasFolder --websdk auto
```

If Miro starts the exporter app by itself when the board opens, no click is
needed; otherwise click the app icon in the board's left toolbar once. Whether
Miro starts it by itself is not yet verified live. If no capture arrives,
`--websdk auto` writes a REST-only result, marks it `degraded` and warns;
`--websdk required` asks for the click instead.

By default, the REST and Web SDK captures must describe the same board, be no
more than 24 hours old, and be no more than 60 minutes apart. The run fails
before publication if pagination, comments, required assets, source identity,
or Canvas integrity is incomplete.

The older single-board flags still work for scripts and offline merges:

```powershell
miro2obsidian `
  --stored-token `
  --board-id <board_id> `
  --websdk-json path\to\websdk-board.json `
  --source-json path\to\canonical-board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

`--stored-token` uses the saved connection and renews it when needed, so
unattended runs need no browser. Use `--oauth` with `MIRO_CLIENT_ID` and
`MIRO_CLIENT_SECRET` in the environment for a one-off authorization instead.
`miro2obsidian auth logout` removes the saved connection. A downloaded capture
from the exporter app is only the fallback: pass it with `--websdk-json` or
`import --websdk <file>`.

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
visual source of truth: open the converted board in a vault.

## Repository layout

| Path | Purpose |
|---|---|
| `Json_2_Canvas/` | Converter core, scale engine, and focused JSON-to-Canvas GUI |
| `Miro_2_Json/` | REST downloader helpers and legacy focused downloader GUI |
| `miro2obsidian/` | Import service, CLI and agent commands, Miro connection and credential store, Web SDK hand-off, app setup |
| `scripts/` | OAuth, export, merge, pipeline, probes, audits, and regression commands |
| `tests/` | Unit tests and minimized regression fixtures |
| `tools/miro_websdk_exporter/` | Buildless whole-board Web SDK exporter |
| `tools/canvas_render/` | Fast diagnostic Canvas renderer |
| `tools/obsidian_plugins/` | Small local plugins used by the validation workflow |
| `docs/` | Setup, capability evidence, runbooks, product plans, and display limitations |
| `ROADMAP.md` | Remaining public-release, onboarding and conversion work |

Local boards, exports, vaults, credentials, browser output, and caches are
excluded by `.gitignore`.

## Documentation

- [Documentation index](docs/README.md)
- [Beginner Miro app setup](docs/MIRO_APP_SETUP.md)
- [Three workflow modes](docs/WORKFLOW_MODES.md)
- [Set up an AI agent](docs/AGENT_SETUP.md)
- [Web SDK exporter](tools/miro_websdk_exporter/README.md)
- [Miro versus Canvas display gaps](docs/MIRO_VS_CANVAS_DISPLAY_GAPS.md)
- [Miro API and item capability matrix](docs/MIRO_CAPABILITIES.md)
- [Source-expansion runbook](docs/SOURCE_EXPANSION.md)
- [`miro-canvas` Obsidian plugin](https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas)
- [Roadmap](ROADMAP.md)
- [Fixture format](tests/fixtures/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Security

Never commit OAuth client secrets, access tokens, authorization callback URLs
containing `code=...`, real private board exports, or local `.env` files. The
saved Miro connection, which includes your app's client secret, lives in your OS
credential store; `miro2obsidian auth logout` removes it. See
[`SECURITY.md`](SECURITY.md) before reporting a vulnerability or publishing a
fork.

## License

Released under the [MIT License](LICENSE). Miro, Obsidian, JSON Canvas, optional
plugins, and Python dependencies retain their own terms and licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

This is an independent interoperability project. It is not affiliated with,
endorsed by, or sponsored by Miro or Obsidian.
