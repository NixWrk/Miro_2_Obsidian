# Application design

The Miro Full Exporter identity and existing visual language are implemented in the desktop window,
connection and agent dialogs, result/error dialogs, local browser setup and
both Web SDK pages. Compatibility launchers open the same desktop window.
The experimental setup wizard uses the same adapters in the local test snapshot;
its broader feature branch still awaits integration.

Use Obsidian-inspired purple controls and a quiet dark navigation rail with
Miro-inspired yellow highlights and a lightly dotted canvas. Do not reproduce
either product's logo or imply that this is their official application.

`miro2obsidian/ui_theme.py` owns the named palette and the local HTML shell.
Reuse these tokens rather than defining another palette in each screen.

| Role | Value | Use |
| --- | --- | --- |
| Canvas | `#f6f5fa` | Application background |
| Surface | `#ffffff` | Cards, dialogs and forms |
| Ink | `#242137` | Primary text |
| Muted | `#625d75` | Supporting text |
| Purple | `#6842c2` | Primary action and links |
| Yellow | `#ffdd57` | Miro entry point and selected accents |
| Rail | `#262237` | Navigation background |

Use system fonts (Segoe UI on Windows), 15px body text, 1.65 line height,
8px spacing increments, 9px control corners and 18px card corners. Keep
one primary action per step, explicit text labels, visible keyboard focus,
and password masking. Navigation previews must not look like clickable links.

Below 800px, stack the navigation above the content. Forms must fit a 360px
viewport and remain usable at 200% text zoom. Avoid external fonts, imagery,
scripts and telemetry on credential pages; keep the existing CSP and local
credential handling.

Native widgets use the same palette through `miro2obsidian/desktop_ui.py`.
`desktop_strings.py` holds display translations, and `ui_preferences.py`
atomically stores only language and interface theme. Canonical menu values,
board names, input paths, copied commands and exported JSON remain source data.
Native file pickers follow OS appearance; their application title and file-type
labels use the selected language.

Web SDK CSS and JavaScript are generated from the same palette and dictionary:
`python -m scripts.build_ui_assets`. Run it after changing shared UI tokens or
copy, and include both generated files in packaged distributions.

## Themes

Light is the default. The Obsidian dark theme button toggles charcoal surfaces
and lilac text accents, keeping Miro yellow. A one-year `miro2obsidian_theme`
cookie stores only `light` or `dark`, across local server ports on the same host
and browser. No credential is stored in this preference. The fixed theme script
is allowed by its exact SHA-256 CSP hash; external scripts remain blocked.

## Language

The RU / EN buttons switch setup instructions, labels and connection status
without reloading or replacing credential fields. English is the default;
`miro2obsidian_language` remembers `en` or `ru` for a year on the same browser
and host, across ports. Miro setting names and API scopes stay in their original
form. Shared Russian strings live in `miro2obsidian/ui_strings.py`.

## Guided desktop workflow

Use four sequential pages: workflow, source, destination, progress. Validate required choices before advancing. Show agent configuration only in Agent mode; restrict it to a single Miro board. Hide Miro connection and SDK controls for existing JSON. Keep optional SDK data on the source page and conversion tuning under Advanced settings on the destination page. Back navigation preserves inputs and is disabled while an export runs. Language and appearance controls stay available throughout.

Default to Export data: any local folder, canonical JSON and attachment sidecar,
no vault or plugin dependency. Keep source-export controls available separately
from Canvas tuning. For Obsidian selects Miro Canvas first, with native and
Advanced Canvas alternatives. Existing JSON selects conversion automatically.
Keep canonical format values behind human labels in both languages. Result
actions open the folder, prepare the saved JSON for Miro Canvas without running
conversion, or open a written Canvas through Obsidian URI. Promotion of Miro
Canvas is optional. Retain command, package and preference names for compatibility.

Within the Miro account source, place setup first, board refresh second, and board selection third, all aligned from the left. Disable selection until a board list has loaded; in the connection-aware GUI disable refresh while disconnected. Optional board data follows these prerequisites. Disconnecting or resetting the list disables selection again.

Apply prerequisite order to every surface: open Miro settings before revealing credential inputs; in setup steps open the browser before copying values; choose SDK input before showing its file picker; capture data before offering download/copy/send. Setup status shows only actions relevant to its current state. Prevent duplicate exports and disable workflow/source changes during a run. Keep validation feedback above navigation.
