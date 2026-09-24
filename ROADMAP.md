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

## Plan (agreed 2026-09-23)

The work below is done in this order; each phase builds on the ones before it.

0. **Finish what is started (done 2026-09-24).** PDF/PPTX export of boards:
   pages marked on the board or a presentation's slides, photographed as native
   Canvas's image export does and packed into PDF or PowerPoint. Manual layer
   order in the main interface: bring to front, bring forward, send backward and send to back
   for cards, from the selection toolbar, native Canvas's card and selection
   menus and commands, for one card or a whole selection.
1. **Foundations (done 2026-09-24).** A formal, versioned schema of
   `miroSource` and `miroCanvas` with compatibility fixtures
   (`miro2obsidian/schemas/v1`, `python -m miro2obsidian.validate`); the
   plugin's translation system with English and Russian, its language taken
   from Obsidian's own; a light agent skill that describes the format and
   validates boards against the schema (`.agents/skills/miro-canvas-format`).
2. **The converter as a product of its own (done 2026-09-24).** Attachment
   deduplication by SHA-256; export to raw JSON, native Canvas, Advanced Canvas
   and miro-canvas from the CLI and the GUI; builds for Windows, macOS and Linux
   (the Windows build is checked; the macOS and Linux builds await the Build
   workflow's first run, and the builds do not yet carry the Web SDK server for
   the maximum export).
3. **Delivery and the import guide.** The plugin in its own repository tied to
   miro2obsidian by the schema and fixtures; the first-setup question "Import
   from Miro?" with an illustrated step-by-step guide and a settings button to
   repeat it.
4. **Getting to know the plugin.** An optional onboarding board, then a visual
   guide to features and setup order in both languages, illustrated from that
   board.
5. **Testing with people.** The full user journey on a clean Windows machine and
   fixes; then other operating systems, phones and tablets.
6. **Ecosystem.** An MCP server beside the skill; import from other plugins'
   formats; faster card dragging on very large boards; the remaining small
   limitations.

**Exporter delivery (decided 2026-09-23).** The exporter stays in Python. The
plugin does not install it by itself - the Obsidian Community directory forbids
plugins that install or update themselves or their dependencies - but either
offers the user a ready build for their operating system to download, or
hands the setup to an agent through a skill or MCP server for miro2obsidian
that walks the user through the Miro app, export and conversion. The exporter
can be removed afterwards; the settings button repeats the flow.

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
  Miro; if so it offers the Python exporter build for the user's operating
  system, or an agent set up through the miro2obsidian skill or MCP server, and
  guides every step with a clear, illustrated guide. The exporter can be
  removed afterwards; a button in the plugin settings repeats the flow.
- [ ] Python builds of the exporter for Windows, macOS and Linux.
- [ ] A skill or MCP server for miro2obsidian itself, so an agent can set up the
  Miro app, run the export and conversion, and fix problems with the user.
- [ ] Walk the full user journey on a clean machine - install, first setup,
  Miro app, export, conversion, opening and editing the board - and fix every
  problem found.
- [ ] Give agents first-class access to the miro-canvas format through a skill
  or an MCP server: read, validate and edit boards (nodes, connectors,
  comments, overrides) as safely as native Canvas files, through the same
  transactions the plugin uses.

Completed work is recorded in Git history and the regression suite rather than
duplicated here.
