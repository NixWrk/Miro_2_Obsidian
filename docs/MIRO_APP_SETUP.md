# Connect your own Miro boards

**English** | [Russian](MIRO_APP_SETUP.ru.md)

This guide explains why Miro to Obsidian needs a user-owned Miro Developer App,
how to create one, and which parts of setup are manual today.

## Short answer

- No programming is required.
- Allow about 10-20 minutes when you can install apps in the target Miro team.
- Allow longer when a team administrator must approve the app.
- The app is configured once and can then export every board that the authorized
  Miro user and installed app are allowed to read.
- The program starts its own local servers and receives the Web SDK capture
  itself. You do not manage JSON files unless the automatic hand-off fails.
- A few steps stay with you because Miro's security model reserves them for a
  person: creating the app, signing in, approving access, and possibly one click
  on the app icon. See [Workflow modes](WORKFLOW_MODES.md).

Creating the app is required by Miro's security model. This repository must not
ship one shared client secret that silently gives unrelated users access to each
other's boards.

## What you gain

| Without your own Miro app | With your own Miro app |
|---|---|
| Convert an existing local JSON only | Authenticate directly with your Miro account |
| No automatic board list | List boards visible to the authorized user and app |
| No fresh REST export | Export paginated REST items, comments, and required assets |
| No Web SDK capture | Capture the maximum board payload exposed inside the open board |
| No repeatable source verification | Validate board identity, freshness, completeness, and provenance |

The combined REST and Web SDK path produces the maximum data exposed by Miro's
public APIs. It still cannot recover hidden internals that Miro does not expose.

## Before you start

You need:

- a Miro account that can open the target board;
- permission to install an app in the team that owns that board, or help from
  that team's administrator;
- the program: a ready-made build, or this repository and Python 3.13;
- an Obsidian vault for the final Canvas.

A Miro Developer team is a safe sandbox for testing, but an app installed only
there will not appear on a board owned by another team. Install the same app in
the team that owns the real board.

## 1. Create the Miro app

1. Sign in to Miro.
2. Open your avatar, then **Developer Hub** → **Your apps**, or open the
   [Miro Developer Hub](https://developers.miro.com/page/developer-hub#your-apps).
3. Select the organization and an existing Developer team. If none is available,
   create one and accept the developer terms.
4. Create an app in that team.
5. Use a recognizable name, for example `Miro to Obsidian - local export`.

Creating the app does not move or copy any board. It creates credentials and a
permission boundary for local export.

## 2. Configure URLs

The fastest way is the manifest. Run `miro2obsidian setup manifest` (the GUI
wizard has a **Copy manifest** action) and, if your app's settings page offers
editing the app manifest, paste it there and save. It sets the app name, the two
URLs below, and the two scopes. If no manifest editor is offered, enter the same
values by hand. Whether Miro's page offers one has not been checked live.

`miro2obsidian setup guide` prints this whole checklist in the terminal, and
`miro2obsidian setup open` opens the Developer Hub.

Enter these exact values in the app settings:

| Miro setting | Value |
|---|---|
| App URL / SDK URI | `http://localhost:8766/index.html` |
| OAuth redirect URI | `http://localhost:8765/callback` |

When Miro shows options for the callback URI, select **Use this URI for SDK
authorization**. Save the app settings.

`localhost` means the application is served only by your computer. Miro permits
HTTP for local `localhost` development; a remotely hosted app would require
HTTPS.

The host name is part of the redirect URI. Do not replace `localhost` with
`127.0.0.1` unless that second URI is also registered in Miro and configured
locally.

## 3. Choose permissions

Use the smallest permission set that supports ordinary export:

| Scope | Needed for |
|---|---|
| `boards:read` | Read board items and board metadata |
| `team:read` | List visible teams and boards for account selection |
| `boards:write` | Optional developer probes that create temporary test items |

Normal users should start with `boards:read` and `team:read`. Add
`boards:write` only when intentionally running a documented probe that creates
items. It does not make a read-only export more complete.

## 4. Install the app in the correct team

1. Select **Install app and get OAuth token** in the app settings.
2. Choose the team that owns the target board.
3. Review the requested scopes and select **Install & authorize**.
4. Ask a team administrator for approval if the team is missing or app
   installation is restricted.

This team selection is essential. An app installed in a Developer team does not
automatically appear on boards in a personal, company, or client team.

## 5. Connect the program to your app

Copy the **Client ID** and **Client secret** from the app settings. Do not paste
them into an issue, chat, screenshot, or tracked file. Then connect in one of
two ways:

- **Desktop window.** Run `miro2obsidian-gui` and open the **Set up Miro app**
  wizard. It shows one step at a time with Copy and Open buttons. Enter both
  values, then approve access in the browser.
- **Command line.** Run `miro2obsidian auth login --form`. A form opens in your
  browser on your own computer. Paste the Client ID and Client secret there and
  approve access in Miro. The command never takes the secret as an argument.
  Without `--form` it reads `MIRO_CLIENT_ID` and `MIRO_CLIENT_SECRET` from the
  environment or asks for them with a hidden prompt.

The program saves one connection in your operating system's credential store
(Windows Credential Manager, macOS Keychain, or a Linux Secret Service keyring).
The connection holds your Client ID, **Client secret**, the access and refresh
tokens, their expiry and the team. The secret is kept so the program can renew
the token without you. See [SECURITY.md](../SECURITY.md) for the trade-off and
for how to remove it.

Tokens renew themselves, so you may switch on **Expire user authorization
token** when you create the app. Earlier versions needed it left off. If you
ticked it already, nothing needs to change.

If the target board is absent later, install the app in the team that owns it
and connect again, choosing that team in the OAuth window. To forget the
connection, run `miro2obsidian auth logout` (the GUI has a matching button). It
asks Miro to revoke the token on a best-effort basis and always removes the
saved connection from your computer.

Without an OS credential store, set `MIRO_ACCESS_TOKEN` in the environment for
the run. That token does not renew itself.

## 6. Check the connection

```powershell
miro2obsidian auth status --verify
miro2obsidian boards
miro2obsidian doctor
```

`auth status --verify` asks Miro whether the token works. `boards` lists the
boards visible to both you and the app (`--query` filters by name). `doctor`
checks the credential store, ports `8765` and `8766`, and the browser. If a
board you expect is missing, see the table below.

At this point you can run the strict REST path. It includes board items, REST
comments, and required downloadable assets:

```powershell
miro2obsidian import --board "<board name, URL or id>" --vault <vault> --websdk skip
```

## 7. Export the maximum automatically

Leave the Web SDK option on automatic (`--websdk auto`, the default). For each
board the program:

1. starts its local server on port `8766` (the one in your App URL);
2. asks the Miro app for a capture of that board;
3. opens the board in your default browser;
4. receives the whole-board capture over loopback, validates it, and runs the
   REST export right after.

If Miro starts the app by itself when the board opens, no click is needed. If
nothing happens in about 20 seconds, click the app icon in the board's left
toolbar (**+ More apps**, then `Miro to Obsidian - local export`). The program
waits up to 3 minutes per board (`--capture-timeout`).

If no capture arrives, `--websdk auto` still writes a REST-only Canvas, marks
the board `degraded`, and says what may be missing. Use `--websdk required` when
you want a click request instead.

Whether Miro starts the app on board open without a click has not been verified
live. Plan for one click.

### Fallback: download the capture by hand

If the automatic hand-off does not work, run the exporter yourself:

1. Start `miro2obsidian websdk-serve --port 8766`.
2. Open the board, open the app, and choose **Export board**, not **Export
   selection**. With the server running the capture is sent to the program
   automatically. **Download JSON** and **Copy JSON** remain.
3. Pass a downloaded file with `--websdk <file>` (CLI) or **From file** (GUI).
   It must come from the same board and be recent. A wrong or stale capture is
   rejected.

The hand-off is described in the [exporter README](../tools/miro_websdk_exporter/README.md#handoff-to-the-local-program).

## Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` in Miro | Local server is not running on the configured port | Run an import or `miro2obsidian websdk-serve --port 8766` and keep it running |
| `404 File not found` | App URL points to an old path or another static server | Use `http://localhost:8766/index.html` |
| App is absent from the board | It is installed in another team | Install it in the team that owns the board |
| OAuth callback fails | Redirect URI differs by host, port, or path | Use exactly `http://localhost:8765/callback` in Miro and locally |
| Board list is empty or incomplete | User access, team installation, or `team:read` is missing | Check all three; ask the team administrator when needed |
| Port `8765` is busy | Web SDK compatibility server and OAuth callback are competing | Keep Web SDK on `8766` and OAuth on `8765` |
| The app is not on the board's toolbar | It is installed in another team | Install it in the team that owns the board (step 4), then reopen the board |
| Capture timeout (`websdk_capture_timeout`, or a `degraded` board with `websdk_unavailable`) | Miro did not start the app by itself | Click the app icon on the open board, then run the same command again. Use `--websdk required` to be asked instead of degrading |
| Port `8766` is busy | Another program, or an old server of a different kind, holds it | Stop that program and run again. A running `miro2obsidian websdk-serve` is reused automatically. `doctor` shows who holds the port |
| The capture was rejected | It belongs to another board, or is stale (older than the allowed age) | Open the right board and capture again. Do not reuse an old file |
| Miro says the token is revoked or expired | The grant was revoked, or the app was removed | Run `miro2obsidian auth login --form` again |
| `WinError 5` while writing Canvas | Obsidian has locked the new file | Close Obsidian, retry the export, and open the Canvas after successful completion |
| Probe action reports missing permission | The app is read-only | Add `boards:write` only for that intentional probe |

## Beginner experience: done and planned

The product target is: download, run, follow one wizard, choose a board and an
Obsidian vault, then select **Export**. A beginner should not need a terminal,
Python, Node.js, environment variables, JSON paths, or knowledge of local ports.

Already in place:

- A step-by-step **Set up Miro app** wizard in the desktop window with Copy and
  Open buttons, and the same checklist on the command line (`setup guide`).
- A manifest to paste (`setup manifest`).
- Credentials in the OS credential store, with automatic token renewal and
  explicit disconnect (`auth logout`).
- The OAuth and Web SDK local services start and stop on their own during an
  import. Port conflicts are reported by `doctor`.
- A direct, nonce-protected hand-off of the Web SDK capture to the program.

Still planned or unverified:

1. Ship as a signed Windows installer or portable package with its runtime.
2. Resume from the last completed step after Miro or the browser is closed.
3. Detect Obsidian vaults and attachment settings and choose safe defaults.
4. Show one progress flow from board selection through REST, comments, assets,
   Web SDK merge, conversion, validation, and final Canvas location.
5. Confirm live that the app starts on board open without a click.
6. Test the whole flow with new users on a clean Windows computer.

Creating the app still requires an account with permission to create and install
an app, and explicit approval of the requested scopes. Team administrator
approval remains an external requirement where installation is restricted.

## Interface design requirements

### Miro panel

- Use one clear primary action for a normal whole-board export.
- Show current board, connection state, exporter version, and completeness.
- Put generated probes and diagnostics behind an explicit advanced mode.
- Show progress, success, and recoverable errors inside the panel.
- Support Miro light and dark appearance, keyboard navigation, readable focus,
  and the official toolbar icon behavior.
- Prefer direct secure handoff to the local companion; retain JSON download as
  an advanced fallback.

### Local desktop application

- Replace the dense form with a step-by-step first-run and export workflow.
- Separate beginner defaults from advanced source and converter controls.
- Use board and vault pickers instead of asking users to type IDs and paths.
- Keep one visible status area with progress, next action, retry, and logs on
  demand.
- Explain errors in user terms and offer the exact repair action.
- Support keyboard use, scaling, light/dark themes, and readable layouts on
  common Windows display sizes.

## Beginner definition of done

A release is beginner-ready when a person on a clean Windows computer can:

1. download and start the application without installing developer tools;
2. create and connect a Miro app by following only the on-screen wizard;
3. understand every manual permission step before accepting it;
4. select a visible Miro board and Obsidian vault without copying IDs or paths;
5. complete a maximum export without handling JSON files or local servers;
6. recover from a closed browser, wrong team, missing scope, or occupied port;
7. find the resulting Canvas and a plain-language completeness report.

## Official Miro references

- [Create a Developer team](https://developers.miro.com/docs/create-a-developer-team)
- [REST API quickstart](https://developers.miro.com/docs/rest-api-build-your-first-hello-world-app)
- [Build a Web SDK app](https://developers.miro.com/docs/build-your-first-hello-world-app)
- [App manifest and scopes](https://developers.miro.com/docs/app-manifest)
- [Miro guided onboarding](https://developers.miro.com/docs/guided-onboarding)
