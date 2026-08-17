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
- The current pre-release still requires Python, a local server, and a manual Web
  SDK JSON download. The planned first-run wizard will remove those technical
  steps.

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
- this repository and Python 3.13 for the current pre-release;
- an Obsidian vault for the final Canvas.

A Miro Developer team is a safe sandbox for testing, but an app installed only
there will not appear on a board owned by another team. Install the same app in
the team that owns the real board.

## 1. Create the Miro app

1. Sign in to Miro.
2. Open your avatar, then **Settings** and **Your apps**. The direct dashboard is
   [Miro Your apps](https://miro.com/app/settings/user-profile/apps/).
3. If Miro asks for a Developer team, create it and accept the developer terms.
4. Select **+ Create new app**.
5. Use a recognizable name, for example `Miro to Obsidian - local export`.
6. Select the available Developer team and create the app.

Creating the app does not move or copy any board. It creates credentials and a
permission boundary for local export.

## 2. Configure URLs

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

## 5. Store credentials locally

Copy the **Client ID** and **Client secret** from the app settings. Do not paste
them into an issue, chat, screenshot, or tracked file.

For the current PowerShell session:

```powershell
$env:MIRO_CLIENT_ID = "<your client id>"
$env:MIRO_CLIENT_SECRET = "<your client secret>"
$env:MIRO_REDIRECT_URI = "http://localhost:8765/callback"
```

Alternatively, copy the provided template:

```powershell
Copy-Item .miro_oauth.local.example.json .miro_oauth.local.json
```

Then replace the placeholders in `.miro_oauth.local.json`. That file is ignored
by Git. Environment variables are preferable for automation.

## 6. Check the REST connection

Install runtime dependencies and start the desktop application:

```powershell
python -m pip install .
miro2obsidian-gui
```

Choose **Miro account** and select **Authenticate / refresh**. The browser opens
Miro OAuth and returns to `http://localhost:8765/callback`. After consent, the
GUI should list the boards visible to both the user and the app.

At this point the GUI can run the strict REST path. That path includes board
items, REST comments, and required downloadable assets.

## 7. Add the Web SDK capture for maximum export

Start the local Web SDK server in a second terminal:

```powershell
python tools\miro_websdk_exporter\serve_no_cache.py --port 8766
```

Then:

1. Open the target board in Miro.
2. Open **+ More apps** or **+ More tools** in the board's left toolbar.
3. Select `Miro to Obsidian - local export`.
4. Select **Export board**, not **Export selection**.
5. Keep the downloaded JSON. It must be from the same board and close in time to
   the REST export.
6. Pass it to `miro2obsidian` with `--websdk-json` as shown in the
   project [README](../README.md#export-maximum-public-api-data).

The current Web SDK download is a manual bridge. The planned local companion
will receive it directly over loopback, verify a one-time session nonce, and
merge it with REST without asking the user to manage JSON files.

## Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` in Miro | Local server is not running on the configured port | Start `serve_no_cache.py` on port `8766` |
| `404 File not found` | App URL points to an old path or another static server | Use `http://localhost:8766/index.html` |
| App is absent from the board | It is installed in another team | Install it in the team that owns the board |
| OAuth callback fails | Redirect URI differs by host, port, or path | Use exactly `http://localhost:8765/callback` in Miro and locally |
| Board list is empty or incomplete | User access, team installation, or `team:read` is missing | Check all three; ask the team administrator when needed |
| Port `8765` is busy | Web SDK compatibility server and OAuth callback are competing | Keep Web SDK on `8766` and OAuth on `8765` |
| Probe action reports missing permission | The app is read-only | Add `boards:write` only for that intentional probe |

## Planned beginner experience

The product target is: download, run, follow one wizard, choose a board and an
Obsidian vault, then select **Export**. A beginner should not need a terminal,
Python, Node.js, environment variables, JSON paths, or knowledge of local ports.

The first-run wizard must:

1. Ship as a signed Windows installer or portable package with its runtime.
2. Offer **Connect Miro** and **Convert existing JSON** as plain-language paths.
3. Open the correct Miro dashboard and show one instruction at a time.
4. Provide copy buttons for the app name, URLs, and minimal scopes.
5. Explain which Miro clicks are mandatory and why they cannot be automated.
6. Accept and validate Client ID and Client secret, then store them in the OS
   credential store rather than a plain-text project file.
7. Start and stop OAuth and Web SDK loopback services automatically.
8. Detect port conflicts, app/team mismatch, missing scopes, failed OAuth, and
   stale Web SDK captures with actionable messages.
9. Resume from the last completed step after Miro or the browser is closed.
10. Detect Obsidian vaults and attachment settings and choose safe defaults.
11. Transfer the Web SDK capture directly to the local companion with a
    short-lived nonce.
12. Show one progress flow from board selection through REST, comments, assets,
    Web SDK merge, conversion, validation, and final Canvas location.

Miro still requires the user or administrator to create the app, choose the
team, review scopes, install it, and approve OAuth. The wizard can guide,
pre-fill, validate, and resume those steps, but must not bypass consent.

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
