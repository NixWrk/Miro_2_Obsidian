---
name: miro2obsidian-import
description: Walk a person through bringing a Miro board into Obsidian with miro2obsidian - getting the program, creating their own Miro app, exporting a board, converting it to the Canvas format they use, checking the result, and fixing what goes wrong. Use when someone asks to import, export, move or convert Miro boards into Obsidian, or is stuck on the Miro app, OAuth, the board list, missing assets or a failed conversion.
---

# Import a Miro board into Obsidian

miro2obsidian exports what Miro's public APIs expose about a board and writes
it into an Obsidian vault as a Canvas file. You guide; the person clicks in
Miro and holds their own credentials. Read
[references/steps.md](references/steps.md) for exact screens, commands and the
troubleshooting table before starting.

## Never

- Never ask for, read, print, store or paste a Client secret, an access token or
  any other credential. The person sets them in their own environment; you only
  refer to the variable names.
- Never contact Miro (export, OAuth) before the person agrees to it for that
  board.
- Never edit `miroSource` in a written board, and never promise a byte-for-byte
  copy of the Miro board: report what the export says it could not capture.

## Find out first

1. Their system (Windows, macOS, Linux) and whether Python 3.13 is there; with
   no Python, use a ready-made build from the
   [releases](https://github.com/NixWrk/Miro_2_Obsidian/releases/latest).
2. The path to their Obsidian vault and the folder the board should go to.
3. What they use to view boards in Obsidian - that picks the format:
   - nothing but Obsidian → `native-canvas`;
   - the Advanced Canvas plugin → `advanced-canvas`;
   - the miro-canvas plugin → `miro-canvas` (the richest Miro look);
   - they only want the data → `raw-json`.
4. Whether they already have an exported board JSON. If so, skip to
   **Convert** - no Miro app is needed.

## Export from Miro

A Miro app of their own is required by Miro's security model; creating it
takes 10-20 minutes and no programming (steps 1-5 in the reference). The app
must be installed in the team that owns the board. Then either the desktop
window (`miro2obsidian-gui`: **Miro account** → **Authenticate / refresh** →
pick the board) or the command line with `--oauth` does the export and the
conversion in one run.

## Convert

```powershell
miro2obsidian --existing-json --source-json <board.json> `
  --vault-root <vault> --target-dir <vault>\<folder> --format <format>
```

From a source checkout, `python -m scripts.miro_pipeline` takes the same
arguments. Identical attachments are stored once in `Miro attachments/`
unless `--keep-board-attachments` is given.

## Check the result

- Exit code 0: complete. Exit code 2: written but degraded - read the log's
  completeness lines to the person in plain words (which items or assets Miro
  did not expose), never hide them.
- `miro2obsidian validate <board.canvas>` (from source:
  `python -m miro2obsidian.validate <board.canvas>`) checks the file against the
  versioned schema.
- Ask the person to open the board in Obsidian and confirm it looks right; for
  `miro-canvas`, the miro-canvas plugin must be enabled.

## Afterwards

The program can be deleted once the boards are in the vault; the boards do
not need it. The person may also uninstall or revoke the Miro app in Miro's
**Your apps** settings. Running the import again later repeats these steps.
