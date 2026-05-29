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
