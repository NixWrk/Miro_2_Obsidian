# Roadmap

Status reconciled on 2026-10-03. Checkboxes below track acceptance work:
implemented code, published builds, and live verification are different states.
Only work present in `main` is described as available in the main checkout.

## Product boundaries

The public product name is **Miro Full Exporter**. Its primary deliverable is a
portable canonical Miro export with comments, local assets and provenance.
Obsidian conversion is an optional destination, with Miro Canvas recommended
within that destination. The CLI, package and release asset names remain
`miro2obsidian` for compatibility. The working branch adds standalone raw JSON
export without a vault, destination-aware GUI defaults and optional result
actions; these changes still need integration and packaged acceptance.

The next integration work must preserve this boundary: setup/token renewal and
Web SDK capture belong to the exporter; an optional plugin handoff selects a
vault and format without making standalone exports depend on the plugin.

This repository owns Miro export, conversion, the desktop/CLI application,
attachment storage, and the versioned board contract in `miro2obsidian/schemas`.
The [miro-canvas plugin](https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas)
owns Canvas editing, rendering, and its own backlog. Follow its documentation
for minimap, comments, drawing, connectors, layer order, and PDF/PPTX board
export; the old in-tree plugin specification is historical.

## Implemented in main

- Strict REST items/comments/assets export, whole-board Web SDK JSON capture,
  canonical union with field provenance, and atomic Canvas publication.
- CLI and GUI output formats: raw JSON, native Canvas, Advanced Canvas, and
  miro-canvas. Existing JSON conversion remains offline.
- SHA-256 attachment deduplication and a reusable vault manifest.
- Versioned board schemas, compatibility fixtures, and board validation.
- Manual, code-automation, and agent GUI modes, with a dedicated Chromium
  profile and explicit human sign-in/approval steps.
- Packaged Web SDK server and Windows/macOS/Linux build workflows. Build code
  does not by itself prove a published release or a clean-machine pass.
- Repository maintenance, board-format, and Miro import agent skills.
- The plugin was extracted on 2026-09-24; both products share the schema.

## Import automation awaiting integration

The seven commits from `ebc7b85` through `52c0ec4` on
`origin/claude/magical-franklin-8q3t48` are not in `main` as of this review.
They add token renewal/check/revoke, a nonce-protected Web SDK handoff, a shared
import service, JSON CLI, MCP server, and a GUI setup/capture wizard.

- [ ] Review and test these commits in isolation, then integrate them while
  retaining explicit `complete`, `degraded`, `needs_user`, and `failed` results.
- [ ] Verify a fresh end-to-end export with the user's own Miro app. The
  successful 2026-09-28 union used a previously downloaded Web SDK JSON;
  repeated fresh agent capture was not confirmed on 2026-09-30.
- [ ] Check app startup on board open and handoff POST from the real Miro
  iframe under browser local-network rules.
- [ ] Check real token refresh with rotation, token-info, revoke, and large
  Windows Credential Manager records.
- [ ] Check the app manifest editor, GUI wizard, interrupted-setup recovery,
  multi-board imports, and MCP with actual clients.

The branch's [environment test matrix](https://github.com/NixWrk/Miro_2_Obsidian/blob/52c0ec4/docs/ENVIRONMENT_TEST_MATRIX.ru.md)
separates implemented code from pending live checks. Do not use its new CLI
commands as instructions for `main` before integration.

## Release and beginner acceptance

- [ ] Verify published artifacts and test the complete install/connect/export/
  convert/open flow with new users on a clean Windows computer.
- [ ] Verify packaged CLI/GUI and the maximum-export assets on macOS and Linux;
  run the corresponding display, keyboard, and filesystem checks.
- [ ] Finish beginner/advanced presentation and one guided board-to-Canvas
  workflow; make reconnect, disconnect, retry, and setup recovery understandable.
- [ ] Publish the first pre-release after the clean-machine acceptance gate.
- [ ] Add code signing for distributed builds.
- [ ] Fix asynchronous browser-test teardown: the passing suite can still
  report a pending Playwright task and `TargetClosedError` during shutdown.
- [ ] Verify repository visibility and configure vulnerability reporting,
  secret scanning/push protection, and main-branch protection with the `test`
  and `dependency-audit` checks where supported by the account plan.

The historical OAuth credential was revoked. Credentials must remain in the
user's environment, interactive form, or OS credential store.

## Export and conversion evidence

- [ ] Compare Miro and native Obsidian text modes on several large boards and
  document the recommended default.
- [ ] Probe source-limited Kanban and other widget families before adding new
  converter behavior. Table cell content and exact unsupported-widget geometry
  require source evidence, not invented renderer content.
- [ ] Automate final visual validation in real Obsidian, including plugin-off
  and optional-plugin cases.
- [ ] Supply reviewed visual baselines for the seven fixture scenarios that
  currently skip image comparison, or document a sufficient structural-only
  acceptance criterion for each.

## Later work and ownership

- [ ] Plugin: optional onboarding board and illustrated English/Russian guide.
- [ ] Plugin: non-destructive imports from Excalidraw and mind-map formats,
  mind-map editing, large-board interaction profiling, and platform/input QA.
- [ ] Shared contract: evaluate first-class agent board editing through the
  plugin's transaction boundary; a format/validation skill alone is not that API.

The exporter stays a separate Python application. The plugin may guide a
download or delegate setup to an agent; it must not install or update itself
or its dependencies. Neither repository vendors the other's implementation.
