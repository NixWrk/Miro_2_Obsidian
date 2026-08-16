# Regression fixtures

Each directory under `tests/fixtures/` describes one reproducible Miro JSON to
Obsidian Canvas conversion case.

Recommended layout:

```text
tests/fixtures/<case_name>/
  input.miro.json
  case.json
  expected.canvas.json
  expected.render.png
  expected.obsidian.png
  notes.md
```

Required files:

- `input.miro.json`: minimized input that reproduces the rule;
- `case.json`: converter options and executable assertions;
- `notes.md`: the behavior or regression covered by the case.

`expected.canvas.json` is available for strict structural, semantic, or geometry
checks. `expected.render.png` is a fast browser-renderer baseline.
`expected.obsidian.png` is the final baseline from real Obsidian. Fixtures without
an image baseline remain structural tests and are skipped by the visual runner. When
the two images disagree, real Obsidian is authoritative.

## Geometry assertions

Assert that named nodes do not overlap:

```json
"non_overlapping_pairs": [
  ["left-node-id", "right-node-id"]
]
```

Scan every pair of selected node types:

```json
"no_overlapping_nodes": [
  {
    "types": ["text", "file", "link"],
    "exclude_node_ids": ["intentional-overlay-id"],
    "min_overlap_width": 0,
    "min_overlap_height": 0
  }
]
```

Use `types` to avoid treating a Canvas group and its children as an overlap.

Assert that estimated rendered text fits inside its generated node:

```json
"text_fits": [
  {
    "id": "text-node-id",
    "padding": 12,
    "tolerance": 1.05
  }
]
```

This catches cases where geometry is numerically valid but Obsidian would show
an internal scrollbar after applying its font-size floor.

Node assertions support lower and upper geometry bounds:

```json
{
  "id": "node-id",
  "min_width": 120,
  "max_width": 600,
  "min_height": 60,
  "max_height": 100
}
```

Upper bounds are useful for overview-preservation rules where a fix must not
silently expand a small Miro item into a much larger Canvas footprint.

Do not commit complete private boards. Remove unrelated content, personal data,
tokens, private URLs, and unnecessary assets before turning a real failure into
a fixture.
