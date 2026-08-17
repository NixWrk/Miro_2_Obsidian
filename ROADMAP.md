# Roadmap

The current priority is a beginner-friendly, local-first Windows release. The
converter and maximum public-API export pipeline already work; the remaining
items focus on packaging, onboarding, and richer offline Canvas editing.

## Public release

- [ ] Revoke and rotate the historical Miro OAuth credential before changing
  the repository visibility.
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
reference only.

Completed work is recorded in Git history and the regression suite rather than
duplicated here.
