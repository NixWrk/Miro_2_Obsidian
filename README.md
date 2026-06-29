# Miro -> Obsidian Canvas

Инструментальный набор для переноса досок Miro в Obsidian Advanced Canvas.

Проект сейчас развивается как проверяемый pipeline, а не как один монолитный GUI:

1. Получить данные из Miro через REST, Web SDK exporter или локальный JSON.
2. Скачать обязательные вложения рядом с JSON.
3. Сконвертировать Miro JSON в JSONCanvas `.canvas`.
4. Проверить структуру, маппинг, пересечения, вложения и визуальный рендер.
5. Исправлять дефекты через LLM-in-the-loop цикл: одна проблема, один fixture, полный regression.

Текущий снимок состояния проекта: [`tasks/current_state.md`](tasks/current_state.md).
Матрица доступности Miro items: [`tasks/miro_capabilities.md`](tasks/miro_capabilities.md).
Инвентаризация репозитория: [`tasks/repo_inventory.md`](tasks/repo_inventory.md).

## Что уже есть

- REST exporter для Miro board items и вложений.
- GUI downloader для Miro -> JSON.
- GUI converter для JSON -> Obsidian Canvas.
- Конвертер с поддержкой text/shape/sticky/image/document/card/app_card/embed/frame/connector/comment sidecar/mindmap_node/code и части slide_container.
- Два режима текста: `miro` сохраняет больше HTML/CSS, `obsidian` минимизирует HTML.
- Scale policies: `balanced`, `overview`, `readable`.
- Zoom-unlocked validation profile для больших досок через локальный Obsidian plugin.
- Regression fixtures и visual baselines.
- Web-board audit, node-overlap audit, missing/mapping audit.
- Miro Web SDK exporter app для диагностики и сравнения REST/Web SDK.

## Текущие ограничения

- В проекте пока нет единого production CLI для прямой команды `json -> canvas`; основной ручной путь конвертации идет через `Json_2_Canvas/Json_2_Canvas_V5.py`, а автоматизированный путь - через regression/local/web-board runners.
- В репозитории пока нет `requirements.txt` или `pyproject.toml`; зависимости надо формализовать отдельной cleanup-задачей.
- Часть Miro items является source-limited: Miro API/Web SDK не отдают нужное содержимое или точную геометрию. Такие элементы фиксируются в `tasks/miro_capabilities.md`.
- Miro app/Web SDK exporter пока не доказан как обязательная часть production pipeline. Его ценность нужно измерить против REST.
- `work/` и `_obsidian_oracle_vault/` являются локальными рабочими артефактами и не коммитятся.

## Карта репозитория

| Путь | Назначение | Статус |
|---|---|---|
| `Json_2_Canvas/` | Ядро конвертера, scale engine и GUI JSON -> Canvas | production code |
| `Miro_2_Json/` | GUI downloader и REST downloader helpers | production/legacy GUI |
| `scripts/` | CLI automation: REST export, OAuth, audits, probes, source merge, regression wrappers | supported tools |
| `tests/` | Unit tests и fixture corpus | required for every converter rule |
| `tools/canvas_render/` | Диагностический web-renderer `.canvas` | validation tool |
| `tools/obsidian_oracle/` | Staging/check helpers для реального Obsidian vault | validation tool |
| `tools/obsidian_plugins/canvas-zoom-unlock/` | Маленький локальный Obsidian plugin для снятия zoom limit | project tool |
| `tools/miro_websdk_exporter/` | Локальное Miro app/Web SDK приложение для export/probe | experimental/source probe |
| `tasks/` | LLM-loop правила, problem library, roadmap, capability matrix | project memory |
| `work/` | Локальный vault, реальные exports и временные canvas outputs | ignored local data |
| `_obsidian_oracle_vault/` | Локальный oracle vault | ignored local data |

## Быстрый старт для разработки

Проверить, что рабочее дерево чистое:

```powershell
git status --short
```

Запустить полный regression loop:

```powershell
python scripts\run_regression.py
```

Быстрый вариант без web-render screenshots:

```powershell
python scripts\run_regression.py --skip-render
```

Запустить только unit tests:

```powershell
python -m unittest discover -s tests -v
```

## Получение данных из Miro через REST

REST-команды используют access token из переменной окружения `MIRO_ACCESS_TOKEN`, если не выбран OAuth flow.

Список доступных досок:

```powershell
python scripts\miro_list_boards.py --output work\MIRO2OBSIDIAN\boards.json
```

Экспорт конкретной доски с вложениями:

```powershell
python scripts\miro_rest_export_board.py `
  --board-id uXj... `
  --output work\MIRO2OBSIDIAN\Miro_2_JSON\board.json
```

Экспорт без скачивания вложений нужен только для диагностики источника:

```powershell
python scripts\miro_rest_export_board.py `
  --board-id uXj... `
  --output work\MIRO2OBSIDIAN\Miro_2_JSON\board.json `
  --no-download-assets
```

Если обязательные вложения не скачались, такой экспорт считается неполным. `--allow-missing-assets` используйте только когда это намеренный диагностический прогон.

## Canonical REST-first pipeline

The supported reproducible path is:

```text
Miro board
  -> REST v2-experimental export
  -> asset sidecar download
  -> one canonical .miro JSON
  -> Json_2_Canvas/Converter.py
  -> Obsidian .canvas
```

Run it from CLI:

```powershell
python scripts\miro_pipeline.py `
  --board-id uXj... `
  --source-json work\MIRO2OBSIDIAN\Miro_2_JSON\board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\MIRO2OBSIDIAN\board
```

Or launch the GUI wrapper:

```powershell
python Miro_2_Obsidian_GUI.py
```

The GUI is the main user-facing entry point. It keeps the user paths separate:

- `Miro account`: authenticate, load boards, choose one board.
- `Miro URL`: paste one Miro board link.
- `Miro URL list`: choose a Markdown/JSON file with Miro board links.
- `Existing JSON`: choose an already exported canonical JSON; no Miro token or
  board controls are shown.

For Miro export paths the GUI automatically uses `MIRO_ACCESS_TOKEN` when
present. If `MIRO_CLIENT_ID` and `MIRO_CLIENT_SECRET` are set, it runs OAuth
through that Miro Developer App. Without those values it can only try the
legacy bundled app credentials kept for backward compatibility.
Locally the user chooses the Canvas folder inside an
Obsidian vault; the GUI detects the vault root, derives temporary source JSON
paths for Miro exports, and reads Obsidian `Files & Links` attachment settings
from `.obsidian/app.json`.

Miro OAuth is not stored in the repo. A `client_id` belongs to a Miro Developer
App registered in Miro, with exact redirect URI values. For local OAuth, register
`http://localhost:8000/callback` in that app; `http://127.0.0.1:8000/callback`
is a different value and must be registered separately if you use it. Set
`MIRO_REDIRECT_URI` when your app is registered with a different local callback.

The shared conversion controls include a checkbox to install/enable Advanced
Canvas plus the local `canvas-zoom-unlock` plugin in the selected vault. With
that checkbox enabled, the default scale profile is zoom-unlocked: `readable`
with `min_zoom=0.000244140625`.

Web SDK export remains a diagnostic/enrichment source. It should feed a merged
canonical JSON first; it should not grow a separate JSON -> Canvas converter path.

## GUI workflows

Primary GUI:

```powershell
python Miro_2_Obsidian_GUI.py
```

Legacy/manual tools, kept for focused debugging:

Miro downloader only:

```powershell
python Miro_2_Json\GUI.py
```

JSON -> Canvas converter only:

```powershell
python Json_2_Canvas\Json_2_Canvas_V5.py
```

For normal use, prefer `Miro_2_Obsidian_GUI.py`; it uses the same canonical
pipeline as the CLI and keeps Miro -> JSON and JSON -> Canvas in one flow.

## Проверка локальных примеров

Прогон локальных JSON из `work`:

```powershell
python scripts\run_local_samples.py --include-miro-json
```

Zoom-unlocked readable profile для больших досок:

```powershell
python scripts\run_local_samples.py `
  --include-miro-json `
  --scale-mode readable `
  --min-zoom 0.000244140625 `
  --text-style-mode miro
```

Стадирование результата в локальный oracle vault:

```powershell
python scripts\run_local_samples.py --include-miro-json --stage-vault
```

## Полный web-board audit

Основная команда для массовой проверки известных web-досок:

```powershell
python scripts\audit_web_board_pipeline.py `
  --export-rest `
  --text-style-mode both `
  --scale-mode readable `
  --min-zoom 0.000244140625 `
  --render
```

Без `--export-rest` audit использует уже имеющиеся локальные JSON.

Полезные флаги:

| Флаг | Когда использовать |
|---|---|
| `--limit N` | Быстрый прогон первых N досок |
| `--text-style-mode miro` | Проверить только Miro-style HTML mode |
| `--text-style-mode obsidian` | Проверить только Obsidian-style text mode |
| `--allow-missing-assets` | Только для намеренно неполных source exports |
| `--render` | Добавить smoke screenshots |

## Аудиты

Проверить пересечения нод:

```powershell
python scripts\audit_node_overlaps.py path\to\board.canvas --miro-json path\to\board.json
```

Проверить, какие Miro items не представлены в Canvas:

```powershell
python scripts\audit_missing_miro_items.py path\to\board.json path\to\board.canvas
```

Проверить соответствие source ids и Canvas nodes/edges:

```powershell
python scripts\audit_item_node_mapping.py path\to\board.json path\to\board.canvas
```

## Miro Web SDK exporter

Локальное приложение находится в:

```text
tools/miro_websdk_exporter/
```

Локальный dev server:

```powershell
python tools\miro_websdk_exporter\serve_no_cache.py --port 8766
```

App URL в Miro:

```text
http://localhost:8766/index.html
```

Текущая роль Miro app:

- создать probe items;
- экспортировать board/selection из открытой доски;
- сравнить Web SDK surface с REST;
- найти item families, где Web SDK дает больше данных.

Перед тем как считать приложение обязательным, нужно выполнить задачу из `tasks/todo.md`: измерить выигрыш Miro app против REST на representative boards.

## Obsidian validation

Локальный zoom plugin:

```text
tools/obsidian_plugins/canvas-zoom-unlock/
```

Проверка oracle окружения:

```powershell
python tools\obsidian_oracle\check_environment.py
```

Установка runtime plugins в локальный oracle vault:

```powershell
python tools\obsidian_oracle\install_plugin_runtime.py
```

Диагностический renderer:

```powershell
python tools\canvas_render\smoke_test.py
python tools\canvas_render\capture_fixture.py --all
```

Для финального визуального решения приоритет у настоящего Obsidian/Advanced Canvas, а не у диагностического web-renderer.

## LLM-in-the-loop правило

Перед новым converter fix:

1. Найдите или создайте проблему в `tasks/problem_library.md`.
2. Добавьте минимальный fixture в `tests/fixtures/<case>/`.
3. Зафиксируйте ожидаемое поведение в `case.json` и `notes.md`.
4. Убедитесь, что тест ловит правило.
5. Исправьте код минимально.
6. Запустите `python scripts\run_regression.py`.
7. Для реальных досок запустите relevant web/local audit.
8. Обновите problem library, lessons или capability matrix, если изменилось правило.

Один цикл решает одну проблему. Инфраструктурные задачи ведутся через `tasks/todo.md`, а дефекты конвертации - через `tasks/problem_library.md`.

## Что не коммитить

Не коммитятся:

- OAuth/access tokens, client secrets, callback URLs с кодами авторизации;
- `work/`;
- `_obsidian_oracle_vault/`;
- `.pytest_cache/`, `__pycache__/`;
- `tools/canvas_render/.out/`;
- временные exports, если они не превращены в fixture.

Если реальный Miro JSON нужен для regression, минимизируйте его и положите в `tests/fixtures/<case>/`.

## Следующие cleanup-задачи

Актуальная очередь: [`tasks/todo.md`](tasks/todo.md).

Ближайшие большие темы:

1. Формализовать зависимости проекта в `requirements.txt` или `pyproject.toml`.
2. Добавить единый CLI для `json -> canvas`.
3. Измерить полезность Miro app против REST.
4. Консолидировать capability evidence в одну таблицу.
5. Продолжить web-board audit и закрывать generated-overlap/mapping-actionable проблемы по одному классу за цикл.
