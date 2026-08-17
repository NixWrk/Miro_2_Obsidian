# Canvas render harness

This diagnostic harness renders a `.canvas` file in a regular web page for fast
automated and visual checks.

Obsidian Canvas uses web technologies, so the harness can detect conversion
regressions without manually launching Obsidian. It is not the final source of
truth for pixel-level compatibility.

It can:

- load `.canvas` files;
- draw text, file, link, and group nodes;
- draw edges with SVG;
- show bounding boxes and a debug overlay;
- capture screenshots through Playwright or a system browser;
- compare fixture screenshots with committed baselines.

## Interactive use

Open `index.html` in a browser and choose a file with **Open .canvas**.

A served file can also be passed in the query string:

```text
index.html?canvas=/path/to/file.canvas
```

## Automated checks

Headless smoke test with Playwright Chromium:

```powershell
python tools\canvas_render\smoke_test.py
```

Use the system Microsoft Edge installation:

```powershell
python tools\canvas_render\smoke_test.py --browser edge
```

Capture every fixture and update diagnostic baselines:

```powershell
python tools\canvas_render\capture_fixture.py --all --update-baseline
```

Compare current output with existing baselines:

```powershell
python tools\canvas_render\capture_fixture.py --all
```

Actual screenshots are written to `tools/canvas_render/.out/` and ignored by
Git.

Fixture baselines use stable fixed-viewport screenshots fitted to the complete stage. Local samples under the ignored `work/` directory
use `Scale_engine` scale modes and fitted viewport captures through
`scripts/run_local_samples.py`, so large boards can be inspected without
changing committed fixture baselines.

The renderer is intentionally limited to regression diagnostics such as an
empty Canvas, bad coordinates, collapsed nodes, missing text, incorrect sizes,
or broken connections. Final visual decisions belong to the
[real-Obsidian oracle](../obsidian_oracle/README.md).
