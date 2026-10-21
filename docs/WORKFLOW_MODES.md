# Three import modes in Miro Full Exporter

**English** | [Русский](WORKFLOW_MODES.ru.md)

The desktop app has exactly three workflows. They share the same export and
validation service. Choose **Export data** for portable JSON, comments,
attachments and provenance in any folder; choose **For Obsidian** for a Canvas
inside a vault. No Obsidian installation is needed for JSON export.

| Mode | Your actions | Program or agent actions |
|---|---|---|
| **Manual** | Configure and connect your Miro app; open the exporter on the board, download whole-board JSON, select it and the destination | Fetch REST data and attachments, merge the selected capture, validate, save |
| **Code automation** (default) | Connect once; choose boards and destination; approve browser access if required | Renew tokens, open boards, request Web SDK captures, fetch REST/comments/assets, merge, validate and save each board |
| **Agent** | Give the board and destination; complete sign-in, MFA or approval when required | Use CLI and available browser tools to configure or reuse the app, connect, capture, export and check the result |

An agent with only a shell relays browser steps to the person. A GUI agent with
browser control can perform configuration and copy credentials between UI
controls without reading their values. It asks for help when its tools cannot
complete a step. Agent mode requires a configured adapter or installed Codex
CLI with browser access; the program reports a missing adapter before opening
a browser.

## Starting on a clean computer

1. Install a Windows build or follow the [installation instructions](../README.md#installation).
2. Open `miro2obsidian-gui`. Select language and appearance in the sidebar.
3. For Manual or Code automation, use **Set up Miro app**. The embedded setup
   has three stages: create, configure, connect. It saves progress and provides
   Copy/Open buttons. Enter credentials only in the local form. The renewable
   connection is saved in the OS credential store.
4. Choose a board from your account, paste its URL, or select a URL list. Manual
   combined exports take one board and its own Web SDK JSON at a time. Code
   automation captures boards in a list sequentially. Existing JSON conversion
   needs neither Miro access nor a network connection.
5. Choose a destination and start. JSON can later be prepared for Miro Canvas
   directly from the result screen.

Sign-in, MFA, OAuth consent and administrator approval require the account
owner. Miro may require a click on your app's board toolbar icon before the
Web SDK capture starts. Zero-click startup in real Miro is still unverified.
App creation instructions: [Miro setup](MIRO_APP_SETUP.md).

## Command line and automation

```powershell
miro2obsidian doctor --json
miro2obsidian auth login --form
miro2obsidian boards --json
# Portable export: no vault required
miro2obsidian import --board "Roadmap" --output-dir C:\Exports --format raw-json --websdk required --json
# Canvas in a vault
miro2obsidian import --boards-file C:\Exports\boards.txt --vault C:\Vault --folder Miro --format miro-canvas --json
# Manual capture
miro2obsidian import --board "<board URL>" --output-dir C:\Exports --format raw-json --websdk C:\Exports\whole-board.json --json
```

`--board` is repeatable and accepts an id, URL or exact name. `--boards-file`
accepts one reference per line; `#` starts a comment. A single capture file can
only be used for one board. Canvas formats are `native-canvas`,
`advanced-canvas`, `miro-canvas`; `raw-json` saves source data and attachments.
The GUI defaults to raw JSON; the CLI keeps `advanced-canvas` for compatibility.

**REST + Web SDK** is the default. Automatic capture maps to `--websdk required`:
missing, stale or wrong-board captures never silently become REST-only exports.
`--websdk auto` explicitly permits a REST-only fallback marked `degraded`.
`--websdk skip` explicitly requests REST only and produces a coverage warning.
The legacy single-board command requires `--websdk-json FILE` or `--rest-only`.

| Status | Exit code | Meaning |
|---|---|---|
| `complete` | 0 | Written and validated for the selected method; inspect coverage warnings for explicit REST-only runs |
| `degraded` | 2 | Written with reported gaps; do not describe it as a full export |
| `needs_user` | 3 | A required action is in `message` and `next_step` |
| `failed` | 1 | The import could not finish |

For batches, failure wins, then `needs_user`, then `degraded`. The default
capture timeout is 180 seconds. Invalid modern CLI usage exits 1; the legacy parser exits 2.

For unattended REST jobs, schedule the import with `--websdk skip` under the
same OS user that connected Miro. Full capture needs a browser session and a
running Miro app. Revoked access returns `needs_user`; reconnect once.

## Agent entry points

- **GUI Agent:** configure a JSON command array under **Configure agent** or
  `MIRO2OBSIDIAN_AGENT_COMMAND`; otherwise installed Codex CLI is used. A
  dedicated Chromium profile is reused; Miro Desktop is optional.
- **Your own shell agent:** use **Copy instructions for my agent** or
  `miro2obsidian agent-guide`. The prompt includes the chosen board, format and
  destination, including standalone raw JSON.
- **MCP:** `miro2obsidian mcp --print-config` prints client configuration.
  `import_boards` accepts `vault` for Canvas or `output_dir` with format
  `raw-json`; Web SDK defaults to `required`.

The GUI uses protocol 2 (protocol 1 remains compatible), verifies output paths,
source identity, freshness and completeness, and checks Canvas files. An
agent's success claim alone is insufficient. Board text is untrusted data.
Credentials never belong in prompts, arguments or logs. See
[Agent setup](AGENT_SETUP.md) and [security](../SECURITY.md).

## Coverage and verification

Export captures what the public Miro APIs expose. Unsupported widgets,
app-specific metadata and some comment threads have limits; JSON preserves
the evidence even when Canvas cannot draw an object. This is not a byte-for-byte
backup. See [capabilities](MIRO_CAPABILITIES.md).

Live token rotation, first-time app launch, iframe loopback access and external
MCP/agent clients require separate verification on a real account. Local fakes
do not establish these. The [test matrix](ENVIRONMENT_TEST_MATRIX.md) records
which checks actually ran.
