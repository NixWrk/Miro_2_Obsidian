# Roadmap

The current priority is a beginner-friendly, local-first Windows release. The
converter and maximum public-API export pipeline already work; the remaining
items focus on packaging, onboarding, and richer offline Canvas editing.

## Public release

- [x] Revoke and rotate the historical Miro OAuth credential before changing
  the repository visibility.
- [ ] After switching to public, enable GitHub private vulnerability reporting,
  secret scanning with push protection, and `main` branch protection requiring
  the `test` and `dependency-audit` checks. GitHub does not offer these settings
  for this private repository without a paid plan.
- [ ] Publish a first pre-release after a clean-machine installation test.

## Beginner workflow

- [ ] Ship a portable or installed Windows build with its Python runtime and
  required application assets.
- [ ] Add a resumable first-run wizard for creating and validating a personal
  Miro Developer App.
- [ ] Start and verify the local OAuth and Web SDK services automatically.
- [ ] Store credentials in the operating-system credential store with explicit
  disconnect and forget actions.
- [ ] Add a direct, nonce-protected Web SDK handoff to the local application.
- [ ] Provide one guided export flow from board selection to the final Canvas.
- [ ] Redesign the Miro panel and local GUI around beginner and advanced modes.
- [ ] Test the complete flow with new users on a clean Windows computer.

## Export and conversion

- [ ] Compare Miro and native Obsidian text modes on several large boards and
  document the recommended default.
- [ ] Add probes for source-limited Kanban and visual item families before
  introducing converter behavior for them.
- [ ] Automate final visual validation in a controlled Obsidian window.

## miro-canvas

The offline editing and display plan lives in
[`docs/miro-canvas.md`](docs/miro-canvas.md). Its first milestone is a separate
Obsidian plugin that preserves native Canvas files and remains compatible with
Advanced Canvas. Planned capabilities include a clickable minimap, richer
text, comments, themes, shapes, colors, connectors, attachment labels, and
editing protection. Mind-map editing will evaluate the MIT-licensed
[`obsidian-enhancing-mindmap`](https://github.com/MarkMindCkm/obsidian-enhancing-mindmap)
as an implementation reference; the closed-source `obsidian-markmind` is a UX
reference only. Future migration work will add explicit, non-destructive
adapters from Excalidraw, mind-map plugins, and other common local formats into
native Canvas plus `miroCanvas` metadata while preserving source files and
provenance. Release hardening must cover Windows, macOS, and Linux or
representative VMs; multiple viewport sizes and pixel ratios; and mouse,
trackpad, pen tablet/stylus, touch-screen, and phone/tablet interaction.

## Future (set 2026-09-23)

### Converter and plugin as two products

- [ ] Move `miro-canvas` into its own repository while keeping it tied to
  miro2obsidian through a shared, versioned data contract: miro2obsidian owns
  the `miroSource`/`miroCanvas` JSON Schema and publishes compatibility
  fixtures with each release; the plugin pins a schema version and runs those
  fixtures in its CI. Neither repository vendors the other's code.
- [ ] The converter keeps working without the plugin: its own simple,
  beginner-friendly GUI exports raw JSON, native Canvas, Advanced Canvas and
  miro-canvas boards, and never requires any of them.
- [ ] Deduplicate attachments by content hash (SHA-256): identical images and
  files across or within boards are stored once and referenced from every
  node, with a manifest mapping hashes to vault paths so later imports reuse
  what the vault already has.
- [ ] Plugin onboarding for Miro imports: a plugin-only user needs none of the
  Miro export code, so on first setup the plugin asks whether to import from
  Miro; if so the exporter is fetched on demand, set up automatically, guides
  the user through every step with a clear, illustrated guide, and is removed
  afterwards if the user wishes. A button in the plugin settings repeats the
  flow whenever needed. Open decision: the Obsidian Community directory forbids
  plugins that "install or update themselves or their dependencies", so the
  delivery must be chosen to stay listed (a separate importer plugin installed
  through Obsidian itself, a companion app the user confirms, or distribution
  outside the directory).
- [ ] Walk the full user journey on a clean machine - install, first setup,
  Miro app, export, conversion, opening and editing the board - and fix every
  problem found.
- [ ] Give agents first-class access to the miro-canvas format through a skill
  or an MCP server: read, validate and edit boards (nodes, connectors,
  comments, overrides) as safely as native Canvas files, through the same
  transactions the plugin uses.

Completed work is recorded in Git history and the regression suite rather than
duplicated here.
