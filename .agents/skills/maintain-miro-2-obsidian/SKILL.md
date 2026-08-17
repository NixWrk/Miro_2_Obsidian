---
name: maintain-miro-2-obsidian
description: Install, configure, inspect, modify, test, and publish the Miro_2_Obsidian repository. Use for environment setup, converter or exporter changes, canonical JSON and provenance work, GUI or CLI maintenance, regression testing, documentation updates, packaging, releases, and repeating prior repository tasks safely.
---

# Maintain Miro to Obsidian

## Orient

1. Locate the checkout with `git rev-parse --show-toplevel`.
2. Read the root `AGENTS.md` completely before changing files.
3. Inspect `git status -sb` and preserve unrelated changes.
4. Read only the task-specific documents named by `AGENTS.md` or the recipes.

Do not build an MCP server for local repository operations. Use normal Git,
PowerShell, Python modules, and the installed CLI. Add an MCP integration only
when a future task requires a persistent external service or account API that
cannot be handled by the existing application.

## Choose the workflow

- For installation or a broken environment, run
  `scripts/bootstrap_windows.ps1` with the smallest suitable flags.
- For code changes, make the smallest coherent patch and begin with focused
  tests.
- For export, merge, completeness, or provenance work, read
  `docs/MIRO_CAPABILITIES.md` before editing.
- For conversion or rendering work, run the full visual regression before
  finishing.
- For packaging or release work, verify installation from the package entry
  points rather than relying on repository-relative imports.
- For commit, push, or release actions, require explicit user authorization.

Read [references/task-recipes.md](references/task-recipes.md) for exact commands
and task-specific checks.

## Preserve invariants

- Keep CLI and GUI thin; put shared behavior in `miro2obsidian.application`.
- Use package-qualified imports; never add `sys.path.insert`.
- Keep raw canonical mappings as the source of truth; do not create a duplicate
  intermediate representation.
- Preserve original REST and Web SDK objects and distinguish available field
  sources from the selected source.
- Preserve atomic publication, path guards, completeness checks, and explicit
  degraded status.
- Never read, print, store, or commit user credentials.

## Finish

Run the checks required by root `AGENTS.md`, inspect `git diff --check`, and
report the exact validation performed. Do not claim a live Miro integration was
tested unless it actually ran with explicit user authorization.
