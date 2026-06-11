# Miro Web SDK exporter

Minimal static Miro app used to export the board through the Web SDK surface.

The exporter is intentionally buildless:

- host this folder with any static HTTP server;
- create a Miro Web SDK app that points to `index.html`;
- upload `icon-outline.svg` as the outline icon and `icon-color.svg` as the color icon;
- install the app into the same team as the target board;
- open the app from the board toolbar icon;
- press `Export board` or `Export selection`;
- download the JSON and compare it with the REST export using `scripts/miro_capability_probe.py`.

`index.html` is only the Miro toolbar bootstrap. It registers the `icon:click`
handler and opens `panel.html`, where the exporter controls live. If the app is
installed but not visible in the board tools menu, verify the App URL, team, and
uploaded outline icon first.

The Team Admin `Apps` page confirms installation in the current team, but it may
not show the developer App URL. If several `export to Json` apps exist, verify
the App URL in `Profile settings` -> `Your apps`, then rename the Web SDK app or
use its uploaded icon to distinguish it on the team Apps page. An app installed
in another Miro team does not appear on this board.

To open the installed app on a board, use the `+ More apps` button at the bottom
of the left-hand app toolbar. In some Miro UI versions this entry is labeled
`+ More tools`; it is the same board toolbar entry point. Miro shows installed
apps there under their app name. The monochrome outline icon is the one that
appears on the board app toolbar; clicking it triggers the app's `icon:click`
handler and opens `panel.html`.

If the target team does not show apps in the board `+ More tools` panel, do not
continue the Web SDK comparison in that team. Create or duplicate the probe
board in an app-visible team where the board app launcher shows installed apps,
then run both REST and Web SDK exports against that same board.

Some Miro plans reject REST board creation with `Creating more boards is not
allowed in this plan`. In that case, create or choose an empty board in the
app-visible team and pass that board id to the REST probe generator with
`--board-id`.

The exported payload has:

- `schema_version: 1`;
- `source_surface: "web_sdk"`;
- `items[]` from `miro.board.get()`;
- `selection[]` from `miro.board.getSelection()`;
- `diagnostics.table_like_items[]` for deep inspection of unsupported table/table_text items;
- a compact `summary.by_type` count.

Table diagnostics intentionally use `item_id` and `item_type` instead of `id`
and `type`, so generic source scanners do not count diagnostics as extra Miro
items. For table text recovery checks, inspect `textish_values`,
`known_field_reads`, and `prototype_chain` in each diagnostic entry.

This tool does not call the REST API and does not need a token. REST enrichment should be added later as a separate adapter after raw Web SDK samples are saved.

## Local hosting

```powershell
python -m http.server 8766 --directory tools\miro_websdk_exporter
```

Use `http://localhost:8766/index.html` as the app URL while developing. Keep the
URL as `localhost` in Miro settings because Miro explicitly allows local HTTP
for localhost development.

The local manifest sketch is stored in `manifest.example.yml`. If the Miro UI
offers manifest editing, keep the same values:

- App URL / `sdkUri`: `http://localhost:8766/index.html`;
- OAuth Redirect URI: `http://localhost:8000/callback`;
- in the Redirect URI `Options` menu, select `Use this URI for SDK authorization`;
- optional loopback Redirect URI: `http://127.0.0.1:8000/callback`;
- scopes: `boards:read`, `boards:write`, `team:read`.

## Follow-up flow

```powershell
python scripts\miro_capability_probe.py --rest-json path\to\rest.json --websdk-json path\to\websdk-export.json
```

Rows marked `websdk_export_candidate` are the next source-expansion candidates.
