# Task recipes

Locate the repository root with `git rev-parse --show-toplevel` before running
these commands. Use the repository `.venv` explicitly so results do not depend
on the agent's global Python environment.

## First setup or environment repair

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap_windows.ps1
```

Use `-RuntimeOnly` for an end-user environment. Use `-SkipBrowser` when the task
does not need visual regression. Do not create `.env` files or persist Miro
secrets as part of setup.

## Existing JSON conversion smoke test

Use a temporary vault and a synthetic or user-provided canonical JSON. Never use
a private board export as a committed fixture.

```powershell
.\.venv\Scripts\miro2obsidian.exe --existing-json `
  --source-json path\to\board.json `
  --vault-root path\to\temporary-vault `
  --target-dir path\to\temporary-vault\Canvas
```

## Python change

1. Run the focused test module for the changed behavior.
2. Run Ruff and the full pytest suite.
3. Run full regression when conversion output, geometry, file publication, or
   rendering can change.

```powershell
.\.venv\Scripts\python.exe -m ruff check Json_2_Canvas Miro_2_Json miro2obsidian scripts tools tests Miro_2_Obsidian_GUI.py
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m scripts.run_regression
```

## Export, merge, or provenance change

Read `docs/MIRO_CAPABILITIES.md` and `docs/SOURCE_EXPANSION.md`. Preserve source
objects under `source_provenance.original_items`. Test both field availability
and selected-source behavior. Accept old canonical exports that predate optional
metadata only when doing so does not weaken current output validation.

## GUI change

Keep network/export/conversion behavior in `miro2obsidian.application`. Test
helpers without opening a window. Manually launch `miro2obsidian-gui` only when
visual or interaction behavior changed.

## Documentation or command change

Update `README.md` and `README.ru.md` together. Prefer installed entry points for
user commands and `python -m package.module` for development commands.

## Publish requested changes

Only publish on explicit user request. Confirm `git status -sb`, review the
staged diff, commit with a terse description, push the configured branch, and
verify that the worktree and upstream are synchronized. GitHub CLI is not
required for a normal `git push`; it is only needed for GitHub-specific actions
such as creating a pull request.
