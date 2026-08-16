# Obsidian oracle harness

This harness stages converted files for final visual verification in real
Obsidian.

The browser renderer is useful for fast diagnostics, but it cannot guarantee
that Obsidian will render the same result. Real Obsidian is therefore the final
visual oracle.

## Controlled profile

The local test vault is:

```text
_obsidian_oracle_vault
```

Its working folder is:

```text
_obsidian_oracle_vault\MIRO2OBSIDIAN
```

The controlled profile uses Advanced Canvas. Project-local checks can validate
the manifest and settings, while final screenshots require the real plugin
runtime files (`main.js` and `styles.css`).

## Setup and checks

Initialize the local vault and validate its configuration:

```powershell
python tools\obsidian_oracle\init_local_vault.py
python tools\obsidian_oracle\check_environment.py
```

Require a complete plugin runtime:

```powershell
python tools\obsidian_oracle\check_environment.py --strict-runtime
```

Copy plugin runtime files from an existing vault:

```powershell
python tools\obsidian_oracle\init_local_vault.py --plugin-source "path\to\ObsidianVault\.obsidian\plugins"
```

Or install the Advanced Canvas runtime from its GitHub release:

```powershell
python tools\obsidian_oracle\install_plugin_runtime.py advanced-canvas
python tools\obsidian_oracle\check_environment.py --strict-runtime
```

## Fixture workflow

Convert and stage one fixture:

```powershell
python tools\obsidian_oracle\stage_fixture.py basic_text
```

The staged Canvas is written below:

```text
_obsidian_oracle_vault\MIRO2OBSIDIAN\_oracle\<fixture>\
```

Open it in Obsidian and capture a screenshot for comparison with
`expected.obsidian.png`.

Accept an existing screenshot as the baseline:

```powershell
python tools\obsidian_oracle\snapshot_fixture.py app_card_fields --actual path\to\screenshot.png --update-baseline
```

Compare an existing screenshot:

```powershell
python tools\obsidian_oracle\snapshot_fixture.py app_card_fields --actual path\to\screenshot.png
```

In an interactive desktop session, capture the full screen:

```powershell
python tools\obsidian_oracle\snapshot_fixture.py app_card_fields --capture-screen --update-baseline
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
