# Steps, commands and fixes

The full illustrated guide for people is `docs/MIRO_APP_SETUP.md` (Russian:
`docs/MIRO_APP_SETUP.ru.md`) in the miro2obsidian repository; point the person
to it when they prefer to read along.

## Get the program

- **Ready-made build** (no Python): download the archive for the system from
  <https://github.com/NixWrk/Miro_2_Obsidian/releases/latest>, unpack it, run
  `miro2obsidian-gui` (macOS: `Miro 2 Obsidian.app`) or `miro2obsidian`.
  Unsigned: on Windows choose **More info → Run anyway**; on macOS right-click
  → **Open** the first time. `miro2obsidian --self-test` confirms the build is
  whole.
- **From source** (Python 3.13): clone the repository, then
  `python -m pip install .`; the commands are `miro2obsidian` and
  `miro2obsidian-gui`, or `python -m scripts.miro_pipeline`.

## Create the person's own Miro app (once)

1. Miro → avatar → **Settings** → **Your apps**
   (<https://miro.com/app/settings/user-profile/apps/>). Create a Developer team
   if asked and accept the developer terms.
2. **+ Create new app**, a recognisable name such as
   `Miro to Obsidian - local export`, the Developer team.
3. App settings - exact values:
   - App URL / SDK URI: `http://localhost:8766/index.html`
   - OAuth redirect URI: `http://localhost:8765/callback`, and tick **Use this
     URI for SDK authorization**. `localhost` must stay `localhost`.
4. Permissions: `boards:read` and `team:read`. Nothing else is needed to export.
5. **Install app and get OAuth token** → choose the **team that owns the
   board** (not just the Developer team) → **Install & authorize**. A team
   administrator may have to approve it.
6. The person copies **Client ID** and **Client secret** into their own
   terminal - never into the chat:
   - PowerShell: `$env:MIRO_CLIENT_ID = "..."`, `$env:MIRO_CLIENT_SECRET = "..."`
   - macOS/Linux: `export MIRO_CLIENT_ID=...`, `export MIRO_CLIENT_SECRET=...`

   From a source checkout they may instead fill `.miro_oauth.local.json`
   (copied from `.miro_oauth.local.example.json`; Git ignores it).

## Export and convert

The board id is the part after `/app/board/` in the board's address
(`https://miro.com/app/board/<id>/`).

```powershell
miro2obsidian --board-id <id> --oauth `
  --source-json <work folder>\board.json `
  --vault-root <vault> --target-dir <vault>\<folder> --format <format>
```

`--oauth` opens the browser for the person to approve; the callback returns to
`http://localhost:8765/callback`. The export downloads the items, comments and
required assets, checks the board's identity and freshness, then converts.

In the window: **Miro account** → **Authenticate / refresh** → choose the board
(or **Miro URL** / **Miro URL list**), choose **Format**, run.

**Maximum export** (adds what only the open board exposes through Miro's Web
SDK) currently needs a source checkout: start
`python tools\miro_websdk_exporter\serve_no_cache.py --port 8766`, open the
board in Miro → **+ More apps** → the app → **Export board**, keep the
downloaded JSON and pass it with `--websdk-json <file>` together with a fresh
REST export of the same board.

## When it goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| OAuth callback fails | Redirect URI differs in host, port or path | Exactly `http://localhost:8765/callback` in Miro and locally |
| Board list empty or partial | App not installed in the board's team, no `team:read`, or the person cannot open the board | Install the app in that team; check the scope; ask the team administrator |
| App missing on the board (Web SDK) | Installed in another team | Install it in the team that owns the board |
| `ERR_CONNECTION_REFUSED` in Miro | Web SDK server not running | Start `serve_no_cache.py` on port `8766` |
| `404 File not found` in the app panel | App URL points elsewhere | `http://localhost:8766/index.html` |
| Port `8765` busy | Something else listens there | Close it; keep Web SDK on `8766`, OAuth on `8765` |
| "Existing JSON is incomplete or unverified" | The JSON is not a verified REST or canonical export | Export again from Miro; `--allow-incomplete-source` only if the person accepts a degraded board |
| Missing assets | An image or file could not be downloaded | Retry; `--allow-missing-assets` only if the person accepts gaps, and say which |
| Windows blocks the program | Unsigned build | **More info → Run anyway** |
| macOS "cannot be opened" | Unsigned build | Right-click → **Open** |
| Board opens as plain cards | Format does not match what the person uses | Convert again with the right `--format` |
