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
- Воспроизводимый CLI, desktop GUI и интерфейс для агентов (команды с `--json`
  и MCP-сервер).

## Статус

Pipeline работает и покрыт автоматическими тестами. Сейчас это pre-release,
ориентированный на Windows и проверенный на Python 3.13.

Исторический ключ Miro отозван и отсутствует в release tree.

Обратной синхронизации с Miro нет. Плагин Obsidian
[miro-canvas](https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas), который рисует вид Miro по доскам в формате
`miro-canvas`, живёт в своём репозитории.

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

## Три способа пользоваться

| Способ | Что делаете вы | Подробнее |
|---|---|---|
| **Вручную** | Сами создаёте своё приложение Miro и запускаете экспорт в окне программы или в командной строке | [Подключение собственных досок Miro](docs/MIRO_APP_SETUP.ru.md) |
| **Автоматизация кодом** | Выполняете единовременные шаги для человека; дальше код сам обновляет токены, делает захват, экспорт и конвертацию, в том числе по расписанию | [Режимы работы](docs/WORKFLOW_MODES.ru.md) |
| **Агент** | Говорите любому ИИ-агенту: «настрой всё и выгрузи доски X и Y в папку Z» | [Настройка агента](docs/AGENT_SETUP.ru.md) |

Несколько шагов Miro оставляет человеку: создать своё приложение в Developer
Hub, войти (с MFA), одобрить доступ и, где это требуется, получить одобрение
администратора team. Может понадобиться и один клик по значку приложения на
доске. Ни один способ эти шаги не обходит; [Режимы работы](docs/WORKFLOW_MODES.ru.md)
точно перечисляют, что автоматизировано, а что нет.

Для MCP-клиентов: `miro2obsidian mcp` запускает сервер, а
`miro2obsidian mcp --print-config --client claude-desktop` печатает конфигурацию
(есть ещё `claude-code`, `codex`, `generic`). Сервер пока не пробовали с
настоящими клиентами.

## Установка

### Готовые сборки

Python не нужен: в каждом [выпуске](https://github.com/NixWrk/Miro_2_Obsidian/releases/latest)
есть сборка для Windows, macOS и Linux с двумя программами — окном
(`miro2obsidian-gui`, на macOS `Miro 2 Obsidian.app`) и командной строкой
(`miro2obsidian`). Распакуйте архив и запустите нужную.

Сборки пока без цифровой подписи. В Windows SmartScreen может предупредить при
первом запуске: выберите **Подробнее → Выполнить в любом случае**. В macOS в
первый раз откройте приложение правым щелчком → **Открыть**. Ключ `--self-test`
проверяет, что сборка нашла всё, что поставляется вместе с ней.

### Из исходников

Рабочая среда:

```powershell
python -m pip install .
```

Разработка, тесты и визуальная регрессия:

```powershell
python -m pip install -e .
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
```

Собрать программы самому: `python -m PyInstaller release/miro2obsidian.spec`
(результат в `dist/`); workflow Build делает то же под Windows, macOS и Linux и
публикует сборки, когда в репозиторий приходит тег `v<версия>`.

### LLM-агенты

Агенты, работающие с репозиторием, должны начинать с [`AGENTS.md`](AGENTS.md).
Пользователи Codex могут дополнительно установить повторяемый skill проекта:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_agent_skill.ps1
```

Он вызывается как `$maintain-miro-2-obsidian` и содержит рецепты установки,
изменения архитектуры, тестирования, упаковки и публикации. Для локальной работы
с репозиторием MCP-сервер не требуется.

Агентам, которые читают, проверяют или правят сами доски, а не репозиторий,
нужен второй skill: он описывает формат доски и проверяет доски по
версионированной схеме (`python -m miro2obsidian.validate`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_agent_skill.ps1 -Name miro-canvas-format
```

Третий skill, `miro2obsidian-import`, позволяет агенту провести человека через
весь импорт - получить программу, создать своё приложение Miro, выгрузить доску,
сконвертировать её в нужный формат и проверить результат - через командную
строку `miro2obsidian` (`doctor`, `setup guide`, `auth login --form`, `boards`,
`import --json`), ни разу не касаясь его ключей. Агент без skills может
выполнить `miro2obsidian agent-guide` или воспользоваться MCP-сервером. См.
[Настройка агента](docs/AGENT_SETUP.ru.md):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_agent_skill.ps1 -Name miro2obsidian-import
```

С ключом `-Agent claude` любой из skills ставится для Claude Code вместо Codex.
Готовые сборки проверяют доски командой `miro2obsidian validate <файл>`.

## Быстрый старт

Если вы никогда не создавали Miro Developer App, начните с инструкции
[Подключение собственных досок Miro](docs/MIRO_APP_SETUP.ru.md). Одноразовая
настройка обычно занимает 10-20 минут и не требует программирования. Создание
приложения в Developer Hub остаётся за вами, остальное делает программа.

### Импорт досок из командной строки

```powershell
miro2obsidian setup guide                      # создать своё приложение Miro (один раз)
miro2obsidian auth login --form                # подключить его; откроется локальная форма
miro2obsidian doctor --vault path\to\ObsidianVault
miro2obsidian boards
miro2obsidian import --board "Roadmap" --board https://miro.com/app/board/<id>/ `
  --vault path\to\ObsidianVault --folder Miro --format native-canvas
```

Все команды принимают `--json`. `import` и `capture` печатают JSON Lines с итогом
в конце. Коды выхода: `0` — complete, `2` — degraded (записано, но с названным
пробелом), `3` — нужен человек, `1` — failed. Сохранённое подключение само
обновляет токен, поэтому последующие и плановые запуски обходятся без браузера.
Другие команды: `setup manifest`, `setup open`, `auth status [--verify]`,
`auth logout`, `capture`, `agent-guide`.

### Конвертация готового JSON

Этот режим не требует Miro credentials или доступа к сети:

```powershell
miro2obsidian `
  --existing-json `
  --source-json path\to\board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

### GUI

```powershell
miro2obsidian-gui
```

GUI разделяет четыре источника и три режима выполнения:

- **Manual**: пользователь управляет Miro сам. Пошаговый мастер **Set up Miro
  app** (с кнопками Copy и Open и копированием манифеста) помогает создать и
  подключить приложение.
- **Code automation**: код прогоняет одну или несколько досок через сервис
  импорта и показывает статус каждой. Подключение хранится в системном
  хранилище и само обновляет токен. Для Web SDK есть варианты **Automatic**,
  **Off** и **From file**.
- **Agent**: локальный агент, запущенный из GUI, настраивает и выполняет импорт
  через CLI. Результат degraded (только REST) принимается и показывается как
  есть. Для шагов, требующих человека, GUI открывает отдельный профиль Chromium.
  Кнопка **Copy instructions for my agent** даёт готовую задачу для любого
  агента. Вход, MFA и одобрение администратора остаются за владельцем аккаунта.

Подробности: [три режима работы](docs/WORKFLOW_MODES.ru.md).

GUI разделяет четыре сценария:

- **Miro account**: **Set up Miro app**, затем OAuth, список видимых досок и
  выбор одной доски. Подключение, включая client secret вашего приложения,
  сохраняется в системном хранилище; см. [`SECURITY.md`](SECURITY.md).
- **Miro URL**: экспорт одной ссылки.
- **Miro URL list**: экспорт ссылок из Markdown или JSON.
- **Existing JSON**: локальная конвертация без обращения к Miro.

### Выбор формата вывода

И CLI, и GUI пишут один из четырёх форматов, который выбирается флагом
`--format` (CLI) или пунктом Format (GUI):

- `advanced-canvas` (по умолчанию): сегодняшний Canvas для плагина
  [Advanced Canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas), с самым богатым оформлением.
- `native-canvas`: обычный [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/),
  без плагинов. Текст становится Markdown; HTML в файле не остаётся.
- `miro-canvas`: для плагина [`miro-canvas`](https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas), который
  рисует внешний вид Miro (шрифты, цвета, формы, фреймы) по сохранённым
  исходным данным.
- `raw-json`: Canvas не создаётся вовсе, сохраняется только канонический
  JSON-экспорт Miro. Имеет смысл только при экспорте из Miro; у
  `--existing-json` входные данные уже являются этим JSON, поэтому такой
  формат отклоняется с понятной ошибкой.

```powershell
miro2obsidian `
  --existing-json `
  --source-json path\to\board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder `
  --format native-canvas
```

### Общие вложения

По умолчанию после записи Canvas одинаковые вложения (один и тот же файл
или картинка, побайтово) объединяются в одну общую копию вместо того,
чтобы оставаться в служебной папке `<board>_files` своей доски. Две доски
с одной и той же картинкой, или одна доска, импортированная дважды,
оказываются ссылающимися на один и тот же файл, а не хранят по своей копии.

Общие файлы лежат в `Miro attachments/` рядом с настроенной в хранилище
папкой для вложений (или в корне хранилища, если такая папка не задана),
с именем `<исходное имя>-<хеш содержимого><расширение>`. Манифест
`.miro2obsidian/attachments.json` хранит соответствие хеша содержимого
файлу; он перестраивается сам, если общий файл был вручную изменён или
удалён. Экспортированный `.html`-документ остаётся в своей служебной
папке, так как может ссылаться на файлы рядом с собой по имени.

Флаг `--keep-board-attachments` (CLI) или снятая галочка «Хранить
одинаковые вложения один раз» (GUI) сохраняют прежнюю раскладку — по одной
копии вложений на каждую доску.

### Максимально полный экспорт

[Инструкция для начинающих](docs/MIRO_APP_SETUP.ru.md) объясняет каждый экран
Miro, сложность и выигрыш, установку в team и частые ошибки.

1. Создайте собственное Miro Developer App в team целевой доски.
   `miro2obsidian setup manifest` печатает имя приложения, URL и scopes
   (`boards:read`, `team:read`), которые можно вставить или ввести вручную.
   `boards:write` нужен только probe-скриптам, которые намеренно создают
   тестовые элементы.
2. Подключите его: `miro2obsidian auth login --form`.
3. Запустите импорт. Программа сама поднимает сервер Web SDK, открывает доску в
   браузере, принимает захват всей доски через loopback и сразу после него
   запускает REST-экспорт:

```powershell
miro2obsidian import --board <название, URL или id> --vault path\to\ObsidianVault `
  --folder CanvasFolder --websdk auto
```

Если Miro сам запускает приложение-экспортёр при открытии доски, клик не нужен;
иначе один раз нажмите на значок приложения на левой панели доски. Запускает ли
Miro приложение само, вживую пока не проверено. Если захват не пришёл,
`--websdk auto` запишет результат только из REST, пометит его как `degraded` и
предупредит; `--websdk required` вместо этого попросит клик.

По умолчанию REST и Web SDK должны описывать одну доску, быть не старше 24
часов и отличаться по времени не более чем на 60 минут. Pipeline не публикует
результат при неполной пагинации, комментариях, обязательных ассетах,
несовпадении досок или повреждённом Canvas.

Прежние флаги одной доски по-прежнему работают для скриптов и автономного
объединения:

```powershell
miro2obsidian `
  --stored-token `
  --board-id <board_id> `
  --websdk-json path\to\websdk-board.json `
  --source-json path\to\canonical-board.json `
  --vault-root path\to\ObsidianVault `
  --target-dir path\to\ObsidianVault\CanvasFolder
```

`--stored-token` использует сохранённое подключение и при необходимости
обновляет его, поэтому запускам без присмотра браузер не нужен. Для разовой
авторизации используйте `--oauth` с `MIRO_CLIENT_ID` и `MIRO_CLIENT_SECRET` в
окружении. `miro2obsidian auth logout` удаляет сохранённое подключение.
Скачанный из приложения-экспортёра захват — только запасной путь: передайте его
через `--websdk-json` или `import --websdk <файл>`.

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
и [матрицу возможностей Miro](docs/MIRO_CAPABILITIES.md).

## Проверка

Полный regression loop:

```powershell
python -m scripts.run_regression
```

Быстрый структурный прогон без browser screenshots:

```powershell
python -m scripts.run_regression --skip-render
```

Отдельные проверки:

```powershell
python -m compileall -q Json_2_Canvas Miro_2_Json miro2obsidian scripts tools tests Miro_2_Obsidian_GUI.py
python -m ruff check Json_2_Canvas Miro_2_Json miro2obsidian scripts tools tests Miro_2_Obsidian_GUI.py
python -m pytest -q
node tests\websdk_serialization_smoke.js tools\miro_websdk_exporter\exporter.js
node tests\websdk_capture_completeness_smoke.js tools\miro_websdk_exporter\exporter.js
```

Web-renderer служит быстрой диагностикой. Источником истины для визуального
результата остаётся настоящий Obsidian: откройте сконвертированную доску в хранилище.

## Документация

- [English documentation index](docs/README.md)
- [Подключение собственного Miro app](docs/MIRO_APP_SETUP.ru.md)
- [Три режима работы](docs/WORKFLOW_MODES.ru.md)
- [Настройка ИИ-агента](docs/AGENT_SETUP.ru.md)
- [Web SDK exporter](tools/miro_websdk_exporter/README.md)
- [Отличия Miro и Canvas](docs/MIRO_VS_CANVAS_DISPLAY_GAPS.ru.md)
- [Матрица возможностей Miro](docs/MIRO_CAPABILITIES.md)
- [Source-expansion runbook](docs/SOURCE_EXPANSION.md)
- [Плагин Obsidian `miro-canvas`](https://github.com/NixWrk/Obsidian-Plugin---Miro-Canvas)
- [Roadmap](ROADMAP.md)
- [Формат fixtures](tests/fixtures/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Безопасность

Нельзя коммитить OAuth client secrets, access tokens, callback URL с
`code=...`, приватные board exports и локальные `.env`. Сохранённое подключение
Miro, включая client secret вашего приложения, лежит в системном хранилище
учётных данных; `miro2obsidian auth logout` его удаляет. Перед публикацией fork
прочитайте [`SECURITY.md`](SECURITY.md).

## Лицензия

Проект опубликован по [лицензии MIT](LICENSE). Miro, Obsidian, JSON Canvas,
необязательные плагины и Python-зависимости сохраняют собственные условия и
лицензии; подробности приведены в
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Это независимый проект совместимости. Он не связан с Miro или Obsidian и не
одобрен ими.
