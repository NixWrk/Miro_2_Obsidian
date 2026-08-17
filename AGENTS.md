# Repository guide for coding agents

## Mission

Maintain a local-first pipeline that exports the maximum board data exposed by
Miro's public APIs and converts it to a valid Obsidian Canvas. Preserve source
evidence and report API limitations explicitly; never describe the result as a
byte-for-byte Miro backup.

## Start here

1. Run `git status -sb` and preserve unrelated user changes.
2. Read `README.md` for the supported user workflows.
3. Read `docs/MIRO_CAPABILITIES.md` before changing export, merge, completeness,
   or provenance behavior.
4. Run `powershell -ExecutionPolicy Bypass -File scripts/bootstrap_windows.ps1
   -SkipBrowser` when the development environment is missing.
5. Make the smallest change that satisfies the request and validate it with the
   narrowest relevant test before running the full suite.

## Supported commands

```powershell
# Install or refresh the full development environment
powershell -ExecutionPolicy Bypass -File scripts/bootstrap_windows.ps1

# Fast feedback
.\.venv\Scripts\python.exe -m ruff check Json_2_Canvas Miro_2_Json miro2obsidian scripts tools tests Miro_2_Obsidian_GUI.py
.\.venv\Scripts\python.exe -m pytest -q

# Full structural and visual regression
.\.venv\Scripts\python.exe -m scripts.run_regression

# User entry points after installation
.\.venv\Scripts\miro2obsidian.exe --help
.\.venv\Scripts\miro2obsidian-gui.exe
```

Node.js is only required for the two Web SDK smoke tests documented in
`README.md`. Existing canonical JSON conversion does not require Miro
credentials or network access.

## Architecture boundaries

- `miro2obsidian/application.py`: shared application service used by CLI and GUI.
- `scripts/miro_pipeline.py`: argument parsing and CLI presentation only.
- `Miro_2_Obsidian_GUI.py`: desktop presentation and user interaction only.
- `scripts/merge_miro_sources.py`: canonical REST/Web SDK union and provenance.
- `Json_2_Canvas/Converter.py`: source-to-Canvas conversion orchestration.
- `Json_2_Canvas/miro_model.py`: non-owning typed views over raw source mappings.
- `Json_2_Canvas/canvas_layout.py`: target-side layout operations.
- `Json_2_Canvas/publication.py`: atomic Canvas publication.

Keep imports package-qualified. Do not restore `sys.path.insert`, duplicate
application behavior in an entry point, or introduce a second canonical object
model. REST remains authoritative for shared IDs; Web SDK fills empty fields and
adds Web-SDK-only items. Keep both `field_sources` (availability) and
`selected_field_sources` (chosen value) accurate.

## Safety rules

- Never commit, print, inspect, or request secret values. Miro credentials must
  stay in the user's environment, OS credential store, or interactive GUI.
- Never weaken completeness, asset, path, or provenance checks just to accept a
  fixture.
- Preserve atomic writes and rollback behavior for generated JSON, Canvas, and
  sidecar assets.
- Keep legacy GUI modules as thin compatibility launchers unless a migration
  explicitly removes their public names.
- Do not contact Miro during tests unless the user explicitly requests a live
  integration run with their own app.
- Do not commit or push unless the user explicitly asks.

## Definition of done

- Add or update focused tests for changed behavior.
- Run Ruff, pytest, and `git diff --check`.
- Run `python -m scripts.run_regression` for conversion, layout, publication, or
  rendering changes.
- Update English and Russian user documentation when commands or workflows
  change.
- Report degraded or source-limited behavior instead of hiding it.

For repeatable task recipes, load the repository skill at
`.agents/skills/maintain-miro-2-obsidian/SKILL.md`.
