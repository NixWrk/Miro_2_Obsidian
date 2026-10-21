# Design and automation integration — 2026-10-21

Combined locally on `codex/design-automation-integration`:

- Automation base: `origin/claude/magical-franklin-8q3t48` (`52c0ec4`).
- Desktop design, standalone export and richer reads:
  `origin/codex/repository-cleanup` (`04cb588`), including its prepared
  automation onboarding patch and subsequent desktop/export improvements.
- Preserved local fixes: bounded retries for locked atomic publication,
  Windows Python launcher fallback, wheel plugin discovery and bundled assets,
  fail-fast agent adapter detection.

Validation was completed locally before publication. The pre-integration work
is preserved in a Git stash and an ignored local patch backup.

## Result

Exactly three desktop workflows share the automation service:

1. Manual: user setup and downloaded whole-board Web SDK JSON.
2. Code automation: automatic Web SDK capture, immediate REST export, comments,
   attachments, validation and publication; sequential multi-board runs.
3. Agent: configured adapter or Codex CLI handles commands and available browser
   operations. Only necessary sign-in, MFA, consent, admin approval or unavailable
   UI operations are handed to the user. Agent claims are independently checked.

The GUI defaults to portable raw JSON in any folder. Canvas conversion is an
explicit destination choice. CLI `--output-dir` and MCP `output_dir` support
the same standalone output. Automatic capture defaults to `required` across
GUI, CLI and MCP; only explicit `auto` permits a degraded fallback.

The reported revoked-connection message and next step are translated into
Russian in both result dialogs and event logs. Paths, board names and machine
protocol values retain their original content.

## Checks actually performed

| Check | Result |
|---|---|
| Full pytest after integration | 971 passed, 4 skipped, 212 subtests passed |
| Final translation, UI assets and desktop checks | Translation/assets passed; two intermittent Tk initialization failures passed when rerun separately |
| Ruff and `git diff --check` | Passed |
| Structural and visual regression | Passed; renderer smoke passed; 31 baselines matched within the existing tolerance; 7 fixtures have no visual baseline |
| Web SDK serialization, completeness and headless handoff Node tests | All three passed with synthetic API objects, no network |
| New wheel installed into a new venv | Passed; no checkout imports; `pip check` passed |
| Installed CLI conversions | 36 combinations: 3 Canvas formats × 3 scale modes × 2 themes × 2 text styles; schemas and local attachments checked |
| Installed desktop options | 40 valid workflow/source/format combinations, each switched between Russian and English |
| First-time connection UI | Three embedded stages, blank credentials rejected, progress restored, secret field masked; synthetic auth status |
| Missing agent on a clean PATH | Actionable error before any browser or export starts |
| Bundled zoom plugin | Installed from wheel resources and hash checked |
| Windows CLI and GUI packages | Built; both `--self-test` checks passed; CLI `--browser-self-test` passed |
| Desktop visual inspection | Russian workflow and setup screens inspected; snapshots in ignored `work/integration-install/` |

This PC already had Python 3.13 and a browser. A new venv, narrowed PATH, empty
Miro environment and isolated settings simulate a fresh application install;
this is not a new Windows VM. Native Python/Tcl intermittently failed to load
its startup files during repeated GUI tests. An isolated copy of the installed
Tcl/Tk runtime was used for the successful full test run. The intermittent
environment behavior is recorded rather than hidden by weakening a test.

The automated Python suite now blocks accidental real HTTP calls to Miro.
Credentials and real board contents were not required for these checks.

## Still requires a real account

- First app creation/installation, OAuth consent and administrator restrictions.
- Refresh token rotation against Miro and real credential-store chunking.
- Fresh complete export of a real board through each workflow.
- Whether Miro starts the app without a toolbar click and allows the iframe
  loopback handoff under browser local-network restrictions.
- Real AI adapter/MCP client behavior and Obsidian interactive rendering.

The full public-API export still has the limitations described in
[MIRO_CAPABILITIES.md](MIRO_CAPABILITIES.md). No live Miro result is claimed by
this integration report.
