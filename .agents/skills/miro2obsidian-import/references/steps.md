# Commands, statuses and fixes

The full illustrated guide for people is `docs/MIRO_APP_SETUP.md` (Russian:
`docs/MIRO_APP_SETUP.ru.md`) in the miro2obsidian repository. The three ways of
working, and what stays with a person, are in `docs/WORKFLOW_MODES.md`. Agent
setup is in `docs/AGENT_SETUP.md`. Point the person to them when they prefer to
read along.

## Get the program

- **Ready-made build** (no Python): download the archive for the system from
  <https://github.com/NixWrk/Miro_2_Obsidian/releases/latest>, unpack it, run
  `miro2obsidian-gui` (macOS: `Miro 2 Obsidian.app`) or `miro2obsidian`.
  Unsigned: on Windows choose **More info, Run anyway**; on macOS right-click,
  **Open**, the first time. `miro2obsidian --self-test` confirms the build is
  whole.
- **From source** (Python 3.13): clone the repository, then
  `python -m pip install .`. The commands are `miro2obsidian` and
  `miro2obsidian-gui`.

## Commands

All accept `--json` unless noted. Exit codes: 0 ok or complete, 2 degraded,
3 needs_user (a person must act), 1 failed or wrong usage.

| Command | Purpose |
|---|---|
| `doctor [--vault PATH] [--verify]` | Environment report with `ready` and `next_steps`. `--verify` also asks Miro whether the saved connection works. |
| `setup guide [--app-name N] [--sdk-port P] [--oauth-port P]` | The step-by-step checklist for creating the person's Miro app. |
| `setup manifest` | The app manifest (YAML) to paste into the app settings if the page offers a manifest editor; otherwise the same values by hand. |
| `setup open` | Opens the Miro Developer Hub in the browser. |
| `auth status [--verify]` | Whether Miro is connected: team, scopes, expiry. Never prints a token. |
| `auth login --form [--no-browser] [--timeout S]` | Opens a local form where the person enters the Client ID and Client secret, then approves access in Miro. Without `--form` it reads `MIRO_CLIENT_ID` and `MIRO_CLIENT_SECRET` from the environment or a hidden prompt, for the person to use in their own terminal. Never accepts a secret as an argument. |
| `auth logout [--no-revoke]` | Best-effort revoke at Miro, and always forget the connection locally. |
| `boards [--query TEXT]` | Boards the connected app can see. |
| `capture --board REF [--timeout S] [--no-open]` | Only fetch a Web SDK capture of one board (JSON Lines). |
| `import --board REF ... --vault PATH ...` | Import one or more boards (JSON Lines). |
| `agent-guide` | Prints the short agent procedure. |
| `websdk-serve`, `setup-serve` | Local servers (the exporter app with its hand-off, and the older connection form). Normally started for you. |
| `validate FILE` | Checks a `.canvas` file against the board schema. |

`import` options: `--board REF` (repeatable; id, URL or exact name),
`--boards-file FILE` (one reference per line, `#` comments), `--vault PATH`
(required), `--folder NAME` (inside the vault; default `Miro`),
`--format {advanced-canvas,native-canvas,miro-canvas,raw-json}` (default
`advanced-canvas`), `--websdk auto|required|skip|PATH`, `--capture-timeout S`
(default 180), `--no-open` (do not open boards in the browser), `--source-dir`,
`--attachment-dir`, `--keep-board-attachments`, `--install-obsidian-plugins`,
`--stable-items`, and the view options `--scale`, `--scale-mode`, `--theme` and
the like.

`--websdk` modes:

- `auto`: use the Miro app's capture when possible. If none arrives, import REST
  only, mark the board `degraded` and warn. It never fails silently.
- `required`: never fall back to REST only; ask the person for the click
  (`needs_user`, reason `websdk_capture_timeout`).
- `skip`: REST only on purpose (use for unattended runs).
- `PATH`: merge a capture file the person already has (single board only).

## Create the person's own Miro app (once)

`miro2obsidian setup guide` prints these steps with the exact values; relay them
one at a time. In short:

1. Miro, avatar, **Developer Hub**, **Your apps**
   (<https://developers.miro.com/page/developer-hub#your-apps>). Pick an
   organization and a Developer team, or create one.
2. Create an app there with a recognisable name, for example
   `Miro to Obsidian - local export`.
3. Settings, exact values (or paste the manifest from `setup manifest` if the
   page offers a manifest editor):
   - App URL / SDK URI: `http://localhost:8766/index.html`
   - OAuth redirect URI: `http://localhost:8765/callback`, and select **Use this
     URI for SDK authorization**. Keep the host name `localhost`.
4. Permissions (scopes): `boards:read` and `team:read`. Nothing else is needed.
   The **Expire user authorization token** option is fine either way: tokens
   renew themselves.
5. **Install app and get OAuth token**, choose the **team that owns the boards**
   (not only the Developer team), **Install & authorize**. A team administrator
   may have to approve it. The person does not need to copy the token shown.
6. Run `miro2obsidian auth login --form`. The person pastes the Client ID and
   Client secret from the app's settings into the local form only, never into the
   chat, and approves access.

The connection (including the client secret, so tokens can renew without a
person) is saved in the OS credential store.

## The import and the Web SDK capture

The board id is the part after `/app/board/` in a board's address. A reference
can be that id, the whole URL, or the board's exact name.

For each board the program asks the Miro app for a whole-board capture, opens the
board in the default browser, waits, and runs the REST export right after. If
Miro starts the app by itself, nothing more is needed. If nothing happens after
about 20 seconds, the person clicks the Miro to Obsidian icon in the board's left
toolbar (**More apps**, then the app). Whether Miro starts the app on its own
has not been verified live; expect one click.

Fallback: the person opens the board, runs the app's **Export board** with
`miro2obsidian websdk-serve` running (it then sends the capture automatically),
or downloads the JSON and you pass it with `--websdk <file>`.

## Result statuses and reasons

| `status` | Exit | Meaning |
|---|---|---|
| `complete` | 0 | Written from a verified REST plus Web SDK source. |
| `degraded` | 2 | Written with a reported gap (REST only, or incompleteness warnings). |
| `needs_user` | 3 | A person must act. |
| `failed` | 1 | Nothing usable was written. |

| `reason` | Status | Fix |
|---|---|---|
| `not_connected` | needs_user | `auth login --form` (the person does the form and consent). With no OS credential store the person may set `MIRO_ACCESS_TOKEN` for the run themselves. |
| `token_refresh_failed` | needs_user | Miro refused the refresh token: `auth login --form` again. A transient network failure: try later. |
| `app_setup_required` | needs_user | The app is not allowed to read this board: install it in the board's team; a team administrator may have to approve. |
| `websdk_capture_timeout` | needs_user (with `required`) | Ask the person to click the app icon on the open board, then rerun. If the icon is missing, the app is not installed in that team. |
| `websdk_unavailable` | degraded (with `auto`) or failed | The capture is missing, was refused (wrong or stale board), or its server could not start (port `8766` busy: `doctor` shows who). Offer a rerun with `--websdk required` after the click, or accept REST only. |
| `incomplete_source` | degraded or failed | The source is reported incomplete, or REST and Web SDK could not be combined. Rerun so the board is captured afresh; `--websdk skip` for REST only. |
| `missing_assets` | failed | A file could not be downloaded. Rerun; report if it repeats. |
| `file_locked` | needs_user | The Canvas is open in Obsidian or not writable. Close it and rerun. |
| `board_not_found`, `board_ambiguous` | failed | Run `boards`, show the candidates, ask which board. |
| `error` | failed | Report `message`, run `doctor` once, then stop and ask. |

## When it goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Form or OAuth callback fails | Redirect URI differs in host, port or path; port `8765` busy | Exactly `http://localhost:8765/callback` in Miro; `doctor` shows the port |
| Board list empty or partial | App not installed in the board's team, no `team:read`, or the person cannot open the board | Install the app in that team; check the scope; ask the team administrator |
| App missing on the board | Installed in another team | Install it in the team that owns the board |
| `ERR_CONNECTION_REFUSED` in Miro | The local Web SDK server is not running | Run an import (it starts it) or `miro2obsidian websdk-serve --port 8766` |
| `404 File not found` in the app panel | App URL points elsewhere | `http://localhost:8766/index.html` |
| Capture was rejected | Another board, or stale | Open the right board and capture again |
| No OS credential store (some Linux, cron, sandboxes) | No keyring reachable | Run in the person's normal session, or the person sets `MIRO_ACCESS_TOKEN` for the run |
| "Existing JSON is incomplete or unverified" | The JSON is not a verified REST or canonical export | Export again from Miro; `--allow-incomplete-source` only if the person accepts a degraded board |
| Windows blocks the program | Unsigned build | **More info, Run anyway** |
| macOS "cannot be opened" | Unsigned build | Right-click, **Open** |
| Board opens as plain cards | Format does not match what the person uses | Import again with the right `--format` |

## Scheduling (code automation, no agent)

After one connection the person can run `miro2obsidian import --boards-file
<file> --vault <vault> --websdk skip` from Task Scheduler, launchd or cron as the
same OS user. See `docs/WORKFLOW_MODES.md`. Exit code 3 means the person must
reconnect.
