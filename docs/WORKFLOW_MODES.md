# Three ways to run Miro to Obsidian

**English** | [Russian](WORKFLOW_MODES.ru.md)

The GUI's **Workflow** menu chooses who performs the Miro browser steps. Live
imports share the REST export, optional canonical REST/Web SDK merge, asset
download, and Canvas conversion code. Converting an existing JSON file needs
no Miro access. A successful export covers the public API surface, not hidden
Miro internals.

| Workflow | What runs automatically | What may require a person |
|---|---|---|
| **Manual** | Conversion and validation after **Run pipeline** | Miro app setup, OAuth, choosing the board, and Web SDK download |
| **Code automation** | REST items and comments, required assets, Canvas conversion, and validation; progress appears in the log | Initial Miro authorization; an optional Web SDK capture |
| **Agent** | A configured local agent attempts browser setup, REST plus Web SDK export, conversion, and validation | Account sign-in, MFA, administrator approval, or an unavailable browser tool |

## Manual

Choose a source and Canvas folder in the GUI. For the maximum supported export,
run the [Web SDK exporter](../tools/miro_websdk_exporter/README.md) on the board,
download the **whole-board** JSON, and select it in **Web SDK JSON**. The GUI
passes that file to the strict canonical REST/Web SDK merge. A capture from a
different or stale board is rejected. Leave the field empty for REST only.

## Code automation

Choose **Code automation** and connect a Miro app once. The GUI stores only its
access token in the current user's OS vault: Windows Credential Manager, macOS
Keychain, or a supported Linux keyring. It does not save the Client ID or Client
secret. Later runs reuse the token
without opening OAuth when **Expire user authorization token** was left
unchecked when the app was created. The current client does not refresh expiring
tokens. **Switch Miro team** or **Forget saved token** removes
the saved token. The current store holds one Miro connection at a time.

The GUI explains its four steps in the log.

For an agent that can use a browser but cannot control the desktop GUI, start
`miro2obsidian setup-serve --port 8767` and open
`http://127.0.0.1:8767/`. Copy the Client ID and Client secret from your Miro
app into that local form and complete Miro OAuth in the same browser. The form
listens only on loopback, keeps credentials in process memory for the OAuth
exchange, and stores only the resulting access token in the OS vault. The agent
can transfer credentials with browser Copy/Paste without reading their values.
Stop the setup server when connected; future runs use `--stored-token`.

For a scheduled run, invoke the CLI with `--stored-token`; it uses the same
protected token without a browser:

```powershell
miro2obsidian --stored-token `
  --board-id <board_id> `
  --source-json <vault>\_miro_sources\board.json `
  --target-dir <vault>\Canvas `
  --vault-root <vault> `
  --format miro-canvas
```

Use the same OS user and vault session for scheduled runs (Task Scheduler,
launchd, or cron). If no OS keyring is available, set `MIRO_ACCESS_TOKEN` in the
process environment and omit `--stored-token`. If Miro revokes the token or the app
is uninstalled, reconnect interactively. Code automation currently produces a
REST-only export unless **Web SDK JSON** points to a fresh whole-board capture.
It does not operate a browser by itself. Start the packaged Web SDK server with
`miro2obsidian websdk-serve --port 8766` when capturing a board in Miro.

## Agent

Choose **Agent** and one Miro board or URL. To use any local agent, set
`MIRO2OBSIDIAN_AGENT_COMMAND` to a JSON array of executable and arguments, or
enter that array under **Configure agent** in the GUI.
The executable receives one JSON request on stdin and writes one JSON response
on stdout. No shell is used. The request includes `protocol_version: 1`, board
URL, vault and output paths, format, `pipeline_command`,
`websdk_server_command`, a temporary `browser_cdp_url`, a plain-language prompt,
and the result schema. The
response contains `status` (`complete`, `needs_user`, or `failed`),
`artifact_path`, `source_json`, and optionally `reason` (`login`, `mfa`,
`admin_approval`, `browser_unavailable`, `agent_network_unavailable`, or `other`). Use absolute paths
for a complete result and null paths otherwise. This protocol allows any agent
or wrapper that can connect to Chromium over CDP; it does not require a particular model or CLI.

Agent mode opens a dedicated Chromium profile in the current OS user's app-data
directory. It reuses that profile on later runs and exposes a random loopback
CDP port only while the agent runs. The first Miro sign-in or MFA in this new
profile still belongs to the account owner. The app checks the Miro dashboard
first, opens Miro's sign-in page when needed, and waits up to five minutes
before starting the agent. A sign-in in another browser does not carry over.
If sign-in is unfinished, Agent mode reports `needs_user: login`; rerun it after
signing in. The app installs Playwright's
Chromium on demand if neither a managed nor a supported system browser is
available. To use an agent adapter that already owns a browser, set
`MIRO2OBSIDIAN_AGENT_BROWSER=external`; its request then has a null
`browser_cdp_url`. `MIRO2OBSIDIAN_BROWSER_PROFILE` can override the profile
location. Never point it at a normal Chrome profile.

Miro Desktop is optional. Agent mode uses its dedicated Chromium whether or not
Miro Desktop is installed, so the browser export path works on machines with
only a browser and on machines with both. Manual exports can use Miro Desktop
when the account and exporter app work there; signing in to Desktop is a
separate session and does not sign in the dedicated Chromium profile.
The [Windows environment test matrix](ENVIRONMENT_TEST_MATRIX.md) records which
paths were actually exercised on this PC.

If the variable is unset, a locally installed Codex CLI is the default adapter,
including with a packaged GUI when its CLI executable is alongside it. The agent receives no Miro secrets in its request, command
arguments, environment, or GUI log. The GUI accepts a complete result only
when the artifact is inside the chosen folder, passes Canvas and file checks,
and has a fresh, complete canonical REST/Web SDK source.

The built-in Codex adapter receives the same CDP endpoint. It does not need to
share this chat's in-app browser. Its Python/Playwright environment still needs
to be able to connect to loopback. With `MIRO2OBSIDIAN_AGENT_BROWSER=external`,
the old read-only browser-tool probe applies; a blocked tool returns
`browser_unavailable` before export.
If the agent cannot reach its service, it reports `agent_network_unavailable`.
An in-app browser attached to this chat is not automatically available to a
separate CLI agent session. Start the packaged GUI directly from the desktop
for live work; a subprocess launched inside a network-restricted Codex sandbox
inherits that network restriction.

Miro may ask for sign-in, MFA, consent, or team administrator approval. The
agent reports `needs_user` in that case; it cannot bypass those requirements.
Miro's published app setup flow creates the developer app in the
[Developer Dashboard](https://developers.miro.com/docs/build-your-first-hello-world-rest-api-app),
so automatic app creation depends on browser UI access. The agent may operate
that UI when available; Code automation starts after the app is connected.
The selected vault must be writable to the agent. An external agent starts a
separate session; it may lack this chat's browser tools or signed-in browser.
Agent mode currently handles one board at a time. The packaged GUI can use a
configured generic adapter or a local Codex CLI.

## Known limitation

The [Windows test matrix](ENVIRONMENT_TEST_MATRIX.md) records a case where the
managed Chromium reached the board URL but remained on Miro's loading screen.
The current URL-based sign-in check does not verify that board controls are
ready. The agent must check the rendered board before claiming a fresh Web SDK
capture; use Code automation with a separately validated whole-board JSON when
the app is absent from that browser's Tools catalog.

Miro's REST and Web SDK APIs do not expose every detail of unsupported board
items. A valid Canvas remains a verified public-API export, not a full Miro
backup. On this Windows test machine, Obsidian held a newly created Canvas
open and caused `WinError 5` during a later rewrite. Close that Canvas in
Obsidian and retry; trust only a run that completes successfully.
