# Contributing

Contributions are welcome after the repository owner selects a license. Until
then, use issues or private discussion to propose changes rather than assuming
redistribution rights.

## Development setup

Use Python 3.13 on Windows, which matches the current CI and visual workflow.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
```

## Before submitting a change

```powershell
python -m compileall -q Json_2_Canvas Miro_2_Json scripts tools tests Miro_2_Obsidian_GUI.py
python -m ruff check Json_2_Canvas Miro_2_Json scripts tools tests Miro_2_Obsidian_GUI.py
python -m pytest -q
node tests\websdk_serialization_smoke.js tools\miro_websdk_exporter\exporter.js
node tests\websdk_capture_completeness_smoke.js tools\miro_websdk_exporter\exporter.js
```

Run `python scripts\run_regression.py` when a change affects conversion or
rendering.

## Converter changes

Each new conversion rule or fixed regression should include one minimized
fixture in `tests/fixtures/<case_name>/`:

- `input.miro.json` with only the source data needed to reproduce the case;
- `case.json` with structural, semantic, or geometry assertions;
- `notes.md` explaining the rule and expected result;
- a visual baseline only when the behavior cannot be asserted reliably in JSON.

Do not add complete private board exports as fixtures. Remove unrelated content,
personal data, tokens, private URLs, and unnecessary assets first.

## Scope

- Keep REST/Web SDK source objects and provenance intact.
- Fix display loss in the converter or plugin layer, not by deleting source data.
- Preserve valid JSON Canvas output when optional Obsidian plugins are absent.
- Prefer a focused fix and an executable regression over a broad refactor.

## Security reports

Do not open a public issue for exposed credentials or vulnerabilities. Follow
[`SECURITY.md`](SECURITY.md).
