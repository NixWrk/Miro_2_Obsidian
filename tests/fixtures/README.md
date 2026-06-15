# Fixtures

Каждая папка внутри `tests/fixtures/` описывает один воспроизводимый кейс конвертации Miro JSON в Obsidian Canvas.

Рекомендуемая структура:

```text
tests/fixtures/<case_name>/
  input.miro.json
  case.json
  expected.canvas.json
  expected.render.png
  expected.obsidian.png
  notes.md
```

Минимально обязательны:
- `input.miro.json` — входной пример;
- `case.json` — параметры конвертации и автоматизированные assertions;
- `notes.md` — какое правило или проблему проверяет кейс.

`expected.canvas.json` используется для строгих structural/semantic/geometry проверок.

`expected.render.png` используется для быстрого visual baseline через `tools/canvas_render/`.

`expected.obsidian.png` используется как финальный visual baseline через настоящий Obsidian oracle.

Если `expected.render.png` и `expected.obsidian.png` расходятся, источником истины считается `expected.obsidian.png`.

## Geometry Assertions

`case.json` can assert that specific nodes do not overlap:

```json
"non_overlapping_pairs": [
  ["left-node-id", "right-node-id"]
]
```

It can also ask the regression test to scan every pair of selected node types:

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

Use `types` to avoid checking Canvas `group` containers against their children.

`case.json` can also assert that a text node's rendered height estimate fits
inside the generated Canvas node:

```json
"text_fits": [
  {
    "id": "text-node-id",
    "padding": 12,
    "tolerance": 1.05
  }
]
```

Use this for rules where geometry can be numerically correct but Obsidian would
still show an internal text scrollbar because `fontSize` is clamped to the
readable minimum.

Node assertions support both lower and upper geometry bounds:

```json
{
  "id": "node-id",
  "min_width": 120,
  "max_width": 600,
  "min_height": 60,
  "max_height": 100
}
```

Use upper bounds for overview-preservation rules where a fix must not silently
expand a Miro item into a much larger Canvas footprint.
