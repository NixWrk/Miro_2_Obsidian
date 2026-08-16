# Miro в Obsidian Canvas

[English](README.md) | **Русский**

Локальный и проверяемый pipeline для экспорта максимума данных, доступных через
публичные API Miro, и преобразования доски в валидный Obsidian Canvas.

Поддерживаемый production-путь объединяет строгий REST-экспорт, REST-комментарии,
обязательные ассеты и свежий экспорт всей открытой доски через Web SDK. В
canonical JSON сохраняются исходные объекты обоих источников и provenance на
уровне полей.

> Это максимально полный экспорт через публичные API, а не побайтовая копия
> Miro. Известные ограничения источника явно записываются в результат.

## Возможности

- Полная пагинация доступных REST items.
- REST-комментарии и их метаданные.
- Захват всей открытой доски через профиль Web SDK `maximum_board_v1`.
- Объединение REST и Web SDK без удаления исходных объектов.
- Скачивание обязательных изображений, документов и `doc_format`.
- Преобразование текста, фигур, sticky notes, файлов, ссылок, frames, groups,
  connectors, комментариев, mind maps, code blocks и поддерживаемых slides.
- Проверка полноты, ID, файловых ссылок, рёбер, маппинга, геометрии и визуальных
  regression fixtures.
- Воспроизводимый CLI и единый desktop GUI.

## Статус

Pipeline работает и покрыт автоматическими тестами. Сейчас это pre-release,
ориентированный на Windows и проверенный на Python 3.13.

Обратной синхронизации с Miro нет. Запланированный Obsidian-плагин
[`miro-canvas`](docs/miro-canvas.ru.md) является отдельным офлайн-слоем для
более точного отображения и удобного редактирования; он пока не реализован.

## Схема данных

```text
Miro board
  -> строгая REST-пагинация + REST comments
  +  свежий экспорт всей доски через Web SDK
  -> canonical union REST/Web SDK с provenance
  -> обязательные локальные assets
  -> Json_2_Canvas/Converter.py
  -> проверенный Obsidian .canvas
```

REST остаётся главным источником для совпадающих item ID. Web SDK заполняет
пустые поля и добавляет доступные только ему элементы. Все исходные записи
сохраняются в `source_provenance.original_items`.

## Установка

Рабочая среда:

```powershell
python -m pip install -r requirements.txt
```

Разработка, тесты и визуальная регрессия:

```powershell
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
```

## Быстрый старт

### Конвертация готового JSON

Этот режим не требует Miro credentials или доступа к сети:

```powershell
python scripts\miro_pipeline.py `
  --existing-json `
  --source-json path\to\board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

### GUI

```powershell
python Miro_2_Obsidian_GUI.py
```

GUI разделяет четыре сценария:

- **Miro account**: OAuth, список видимых досок и выбор одной доски.
- **Miro URL**: экспорт одной ссылки.
- **Miro URL list**: экспорт ссылок из Markdown или JSON.
- **Existing JSON**: локальная конвертация без обращения к Miro.

### Максимально полный экспорт

1. Создайте собственное Miro Developer App в team целевой доски.
2. Добавьте OAuth redirect URI `http://localhost:8765/callback`.
3. Включите `boards:read` и `team:read`. `boards:write` нужен только probe-
   скриптам, которые намеренно создают тестовые элементы.
4. Задайте credentials локально:

```powershell
$env:MIRO_CLIENT_ID = "<your app client id>"
$env:MIRO_CLIENT_SECRET = "<your app client secret>"
$env:MIRO_REDIRECT_URI = "http://localhost:8765/callback"
```

5. Запустите Web SDK exporter на отдельном порту:

```powershell
python tools\miro_websdk_exporter\serve_no_cache.py --port 8766
```

6. Укажите `http://localhost:8766/index.html` как App URL, установите
   приложение в team доски, откройте его на доске и нажмите **Export board**.
7. Передайте скачанный JSON в production pipeline:

```powershell
python scripts\miro_pipeline.py `
  --oauth `
  --board-id <board_id> `
  --websdk-json path\to\websdk-board.json `
  --source-json path\to\canonical-board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

По умолчанию REST и Web SDK должны описывать одну доску, быть не старше 24
часов и отличаться по времени не более чем на 60 минут. Pipeline не публикует
результат при неполной пагинации, комментариях, обязательных ассетах,
несовпадении досок или повреждённом Canvas.

Для локального OAuth можно скопировать `.miro_oauth.local.example.json` в
игнорируемый `.miro_oauth.local.json`. Для автоматизации предпочтительнее
переменные окружения.

## Критерий полноты

Успешный maximum export требует:

- полную REST-пагинацию;
- полные REST-комментарии;
- свежий Web SDK capture `maximum_board_v1`;
- совпадающую идентичность доски;
- отсутствие пропавших обязательных assets;
- `completeness.complete: true` и `capture_complete: true`;
- уникальные Canvas node ID и валидные ссылки на файлы и edges.

`board_complete` намеренно остаётся `false`: публичные API Miro не обещают
доступ к скрытым внутренним данным неподдерживаемых widgets. Web SDK не заменяет
REST comments; часть данных таблиц, документов, slides и unsupported items может
не отдаваться ни одним публичным источником.

Смотрите [фактические отличия Miro и Canvas](docs/MIRO_VS_CANVAS_DISPLAY_GAPS.ru.md)
и [матрицу возможностей Miro](tasks/miro_capabilities.md).

## Проверка

Полный regression loop:

```powershell
python scripts\run_regression.py
```

Быстрый структурный прогон без browser screenshots:

```powershell
python scripts\run_regression.py --skip-render
```

Отдельные проверки:

```powershell
python -m compileall -q Json_2_Canvas Miro_2_Json scripts tools tests Miro_2_Obsidian_GUI.py
python -m ruff check Json_2_Canvas Miro_2_Json scripts tools tests Miro_2_Obsidian_GUI.py
python -m pytest -q
node tests\websdk_serialization_smoke.js tools\miro_websdk_exporter\exporter.js
node tests\websdk_capture_completeness_smoke.js tools\miro_websdk_exporter\exporter.js
```

Web-renderer служит быстрой диагностикой. Источником истины для визуального
результата остаётся настоящий Obsidian; см. [`tools/obsidian_oracle`](tools/obsidian_oracle/README.md).

## Документация

- [English documentation index](docs/README.md)
- [Web SDK exporter](tools/miro_websdk_exporter/README.md)
- [Отличия Miro и Canvas](docs/MIRO_VS_CANVAS_DISPLAY_GAPS.ru.md)
- [Полный план `miro-canvas`](docs/miro-canvas.ru.md)
- [Формат fixtures](tests/fixtures/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Безопасность

Нельзя коммитить OAuth client secrets, access tokens, callback URL с
`code=...`, приватные board exports и локальные `.env`. Перед публикацией fork
прочитайте [`SECURITY.md`](SECURITY.md).

## Лицензия

Open-source лицензия пока не выбрана. До публичного open-source release нужно
добавить `LICENSE`; до этого нельзя считать, что копирование, изменение и
распространение кода разрешены.
