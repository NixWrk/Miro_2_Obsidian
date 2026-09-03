# Obsidian oracle harness

This harness stages converted files and deterministic M0 compatibility fixtures
for final verification in real Obsidian.

The browser renderer is useful for fast diagnostics, but it cannot guarantee
that Obsidian will render the same result. Real Obsidian is therefore the final
visual oracle. The scripts below prepare files only; they do not claim a real
Obsidian visual or interaction pass.

## Controlled M0 vault

The configured project-local test vault is:

```text
_obsidian_oracle_vault
```

Its working folder is:

```text
_obsidian_oracle_vault\MIRO2OBSIDIAN
```

The oracle configuration and compatibility matrix are committed under
`tools/obsidian_oracle/`. Every mutating helper accepts only the exact vault
path from `oracle_config.json` and refuses arbitrary vaults plus symlink/reparse
paths. The generated vault is ignored by Git.

The four controlled rows are `native-only`, `miro-canvas-only`,
`advanced-only`, and `both`. The first two require only native Canvas and the
local miro-canvas fixture/runtime; Advanced Canvas is optional for offline
checks. Real screenshots require the actual runtime files and a manually opened
project vault.

## Build, setup, and deploy

From the repository root, build the local plugin and prepare the complete M0
vault:

```powershell
cd plugins\miro-canvas
npm ci
npm run typecheck
npm test
npm run build
cd ..\..
python tools\obsidian_oracle\setup_m0_vault.py
python tools\obsidian_oracle\check_environment.py
```

`setup_m0_vault.py` initializes `_obsidian_oracle_vault`, stages all four
fixtures below `MIRO2OBSIDIAN\_oracle\m0-compatibility`, copies only the
built `manifest.json`, `main.js`, and `styles.css` into the local
`miro-canvas` plugin directory, and enables it. The runtime install and fixture
activation are guarded/atomic at their respective boundaries; no source tree is
linked into the vault.

The setup creates a placeholder Advanced Canvas manifest when no real runtime
is present. Install or copy a pinned, hash-verified Advanced Canvas runtime
before a real Advanced profile check:

```powershell
python -m tools.obsidian_oracle.install_plugin_runtime advanced-canvas
python tools\obsidian_oracle\check_environment.py --strict-runtime
```

## M0 compatibility matrix

Activate and validate each real enabled-plugin combination independently:

```powershell
python tools\obsidian_oracle\activate_profile.py native-only
python tools\obsidian_oracle\check_environment.py --profile native-only --strict-runtime

python tools\obsidian_oracle\activate_profile.py miro-canvas-only
python tools\obsidian_oracle\check_environment.py --profile miro-canvas-only --strict-runtime

python tools\obsidian_oracle\activate_profile.py advanced-only
python tools\obsidian_oracle\check_environment.py --profile advanced-only --strict-runtime

python tools\obsidian_oracle\activate_profile.py both
python tools\obsidian_oracle\check_environment.py --profile both --strict-runtime
```

Profile activation atomically stages the matching `.canvas` file and replaces
only the controlled `miro-canvas`/`advanced-canvas` entries in
`community-plugins.json`. A failed activation restores both the Canvas and the
enabled-plugin list. To retain an unrelated test plugin, name its exact ID with
the repeatable `--preserve-plugin` option.

After activation, add `_obsidian_oracle_vault` through Obsidian's vault
switcher and open the staged file. The scripts cannot register a new vault or
claim the native undo/redo and interaction gate on their own.

### Fix “vault not found” before opening

An existing folder is not necessarily registered in Obsidian. The `open` URI
only locates registered vaults; it does not register a new directory. Use
**Open another vault → Open folder as vault** and select the absolute vault
root printed by setup, not the inner `MIRO2OBSIDIAN` folder. In a Windows
folder picker, paste that absolute path into the address bar if browsing does
not show it. The J: drive must be accessible to the Obsidian process too.

```powershell
# Read-only check; unregistered/unknown returns exit code 2 with instructions.
python -m tools.obsidian_oracle.open_local_vault
# Optional: open only the vault manager to select the folder yourself.
python -m tools.obsidian_oracle.open_local_vault --choose-vault
# After registration, validate and open the staged board using its vault ID.
python -m tools.obsidian_oracle.check_environment --profile both --strict-runtime --require-registered
python -m tools.obsidian_oracle.open_local_vault --profile both --open
```

The helper never edits the app's global `obsidian.json`. It refuses to send
an `open` URI when registration is missing, unknown, or ambiguous, and never
prints unrelated vault paths. Profile activation on disk does not reload
plugins in an already open Obsidian window: reload the test vault between
profile checks. See the official [Obsidian URI documentation](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI).

## Fixture workflow

Convert and stage one fixture:

```powershell
python -m tools.obsidian_oracle.stage_fixture basic_text
```

The staged Canvas is written below:

```text
_obsidian_oracle_vault\MIRO2OBSIDIAN\_oracle\<fixture>\
```

Open it in Obsidian and capture a screenshot for comparison with
`expected.obsidian.png`.

Accept an existing screenshot as the baseline:

```powershell
python -m tools.obsidian_oracle.snapshot_fixture app_card_fields --actual path\to\screenshot.png --update-baseline
```

Compare an existing screenshot:

```powershell
python -m tools.obsidian_oracle.snapshot_fixture app_card_fields --actual path\to\screenshot.png
```

In an interactive desktop session, capture the full screen:

```powershell
python -m tools.obsidian_oracle.snapshot_fixture app_card_fields --capture-screen --update-baseline
```

Actual screenshots are written to `tools/obsidian_oracle/.out/` and ignored by
Git.

## Source-of-truth rule

When the browser harness and Obsidian disagree, Obsidian wins. Then either fix
the browser harness, document its limitation, or add a structural assertion
that detects the issue without relying on the custom renderer.

Stable baselines require one viewport, Canvas zoom, theme, font set, and window
size; no manual node movement; and no unrelated community plugins. Advanced
Canvas is the controlled exception for this repository.
