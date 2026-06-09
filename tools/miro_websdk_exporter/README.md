# Miro Web SDK exporter

Minimal static Miro app used to export the board through the Web SDK surface.

The exporter is intentionally buildless:

- host this folder with any static HTTP server;
- create a Miro app that points to `index.html`;
- open the app on a board;
- press `Export board` or `Export selection`;
- download the JSON and compare it with the REST export using `scripts/miro_capability_probe.py`.

The exported payload has:

- `schema_version: 1`;
- `source_surface: "web_sdk"`;
- `items[]` from `miro.board.get()`;
- `selection[]` from `miro.board.getSelection()`;
- a compact `summary.by_type` count.

This tool does not call the REST API and does not need a token. REST enrichment should be added later as a separate adapter after raw Web SDK samples are saved.

## Local hosting

```powershell
python -m http.server 8765 --directory tools\miro_websdk_exporter
```

Use `http://localhost:8765/index.html` as the app URL while developing.

## Follow-up flow

```powershell
python scripts\miro_capability_probe.py --rest-json path\to\rest.json --websdk-json path\to\websdk-export.json
```

Rows marked `websdk_export_candidate` are the next source-expansion candidates.
