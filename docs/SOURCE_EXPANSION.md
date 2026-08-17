# Miro source-expansion runbook

Use this runbook when an item appears on a Miro board but its useful data is
missing from the generated Canvas. The goal is to establish which public source
exposes the data before changing the converter.

Use a dedicated test board and synthetic content. Never commit a complete real
board, a client credential, an access token, or downloaded private assets.

## Investigation cycle

1. Capture a strict REST export and a fresh whole-board Web SDK export.
2. Compare the source surfaces and classify the item family.
3. Add one minimized fixture when recoverable content exists.
4. Make one focused converter or exporter change.
5. Run the full regression suite and record any remaining source limitation.

The classifications are:

- `converter_candidate`: useful source data exists but Canvas loses it;
- `websdk_export_candidate`: Web SDK exposes more than REST;
- `separate_source`: data comes from another endpoint, such as comments;
-
eeds_probe`: available evidence is inconclusive;
- `source_limited`: no current public source exposes useful content.

## Local workspace

Keep generated evidence in an ignored directory:

```powershell
python -m scripts.miro_source_expansion_workflow plan `
  --output-dir work\source_expansion
```

The workflow writes `workflow_plan.md`, capability reports,
ext_actions.md`,
and a merged diagnostic JSON. These are local evidence, not repository files.

## Authentication

Use a Miro Developer App that you own. Prefer a temporary environment variable
or the ignored local OAuth configuration described in
[`MIRO_APP_SETUP.md`](MIRO_APP_SETUP.md).

```powershell
$env:MIRO_ACCESS_TOKEN = "<temporary access token>"
```

Or use browser OAuth:

```powershell
$env:MIRO_CLIENT_ID = "<client id>"
$env:MIRO_CLIENT_SECRET = "<client secret>"
```

The callback defaults to `http://localhost:8765/callback`. Register that exact
URI in Miro. `localhost` and `127.0.0.1` are different OAuth redirect values.
The helper opens the system browser by default; use `--oauth-browser yandex` or
an executable path only when an explicit browser is required.

## REST probe board

Generate a manifest without contacting Miro:

```powershell
python -m scripts.miro_rest_generate_probe_board `
  --output work\source_expansion\rest_probe_manifest.json
```

Create or update the probe board only after reviewing the manifest:

```powershell
python -m scripts.miro_rest_generate_probe_board --execute --oauth `
  --output work\source_expansion\rest_probe_result.json
```

The generator records item-level API rejections and continues. Add
`--strict-failures` only when any rejected variant should fail automation.

## Compare REST and Web SDK

After exporting the same board from both sources:

```powershell
python -m scripts.miro_source_expansion_workflow analyze `
  --rest-json work\source_expansion\rest_export.json `
  --websdk-json work\source_expansion\websdk_export.json `
  --output-dir work\source_expansion
```

The exports must belong to the same board. Use **Export board** in the Web SDK
panel; selection and generated-probe exports do not claim full-board capture.

## Separate probes

Comments are not normal board items:

```powershell
python -m scripts.miro_comment_probe --board-id <board_id> `
  --output work\source_expansion\comment_probe_result.json
```

Tables require evidence JSON because current public exports may expose geometry
without cell text:

```powershell
python -m scripts.miro_table_probe --board-id <board_id> `
  --evidence-json work\source_expansion\rest_export.json `
  --output work\source_expansion\table_probe_result.json
```

Slides require parent-chain and frame checks:

```powershell
python -m scripts.miro_slide_probe --board-id <board_id> `
  --evidence-json work\source_expansion\rest_export.json `
  --evidence-json work\source_expansion\websdk_export.json `
  --output work\source_expansion\slide_probe_result.json
```

These commands are read-only unless the REST generator is run with `--execute`.

## Recorded table limitation

Evidence captured on 2026-06-11 with exporter profile
`20260611-deep-table` is minimized in
[`tests/fixtures/table_source_limited/source_evidence_2026-06-11.json`](../tests/fixtures/table_source_limited/source_evidence_2026-06-11.json).
The Web SDK object used the prototype chain
`Unsupported -> Unsupported -> BaseItem -> Object`; safe reads of known table
and text fields produced no values, and `textish_values` was empty.

Decision: table cell text is not exposed by the tested public sources. Treat it
as source-unavailable until a new public Miro source proves otherwise.
Geometry-only table objects must not be presented as recovered table content.

## Completion rules

- Required image, document, and `doc_format` assets must exist in the `_files`
  sidecar before a source is considered complete.
- Embed preview images are optional when the embed still has a recoverable URL.
- Missing native image assets remain deterministic Canvas file nodes with a
  warning; source data must not be silently replaced by a smaller link card.
- Real-source evidence must be reduced to synthetic IDs, URLs, text, and the
  minimum fields needed for the regression.
- Run `python -m scripts.run_regression` before committing a source-expansion
  change.
